import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { decideAfterError, decideAfterSuccess } from "./decide.js";
import { collectStepInputs } from "../mcp/inputs.js";
import { McpProxy } from "../mcp/proxy.js";
import { providerSpec } from "./providers.js";
import { AcpSession } from "./session.js";
import { buildPrompt } from "./failure.js";
import { commandResult, type CommandResult } from "./command-result.js";
import {
  isScriptStep,
  tracesToStdout,
  type AgentStep,
  type PermissionPending,
  type ProviderId,
  type RunnerConfig,
  type SessionContext,
  type StepFailure,
  type StepCommand,
} from "../types.js";
import { renderPromptTemplate, resolveStepVariables } from "../config/vars.js";
import {
  resolveMcpServers,
  resolveModel,
  resolveProvider,
  resolveStepPrompt,
  resolveStepScope,
  resolveStepServers,
} from "../config/yaml.js";

export interface CreateAgentActorOptions {
  config: RunnerConfig;
  signal?: AbortSignal;
  promptPermission?: (pending: PermissionPending) => Promise<string> | string;
  onStateChange?: (previous: string, current: string, context: SessionContext) => void;
  inspect?: (event: unknown) => void;
}

export type RunAgentOptions = CreateAgentActorOptions;

export interface AgentRunResult {
  outcome: "finished" | "failed";
  context: SessionContext;
}

export function runStepCheck(
  config: RunnerConfig,
  step?: AgentStep,
  extraVars?: Record<string, unknown>,
  signal?: AbortSignal,
  timeout = 60000,
): CommandResult {
  const rawCommand = step?.run;
  if (!rawCommand || !step) return { outcome: "success", output: "", exitCode: null };
  if (signal?.aborted) {
    return { outcome: "failure", output: "aborted", exitCode: null };
  }
  const cwd = config.cwd;
  mkdirSync(cwd, { recursive: true });
  const workingDir = existsSync(cwd) ? cwd : process.cwd();
  const baseDir = dirname(config.yamlPath);
  const stepVars = resolveStepVariables(config, step, extraVars);

  try {
    let result: ReturnType<typeof spawnSync>;
    if (typeof rawCommand === "object" && rawCommand !== null && "command" in rawCommand) {
      const command = renderPromptTemplate(rawCommand.command, stepVars);
      const args = (rawCommand.args ?? []).map((a) => renderPromptTemplate(a, stepVars));
      const resolvedCommand = existsSync(resolve(baseDir, command))
        ? resolve(baseDir, command)
        : command;
      const resolvedArgs = args.map((arg) => {
        if (arg.startsWith("-")) return arg;
        const candidate = resolve(baseDir, arg);
        return existsSync(candidate) ? candidate : arg;
      });
      result = spawnSync(resolvedCommand, resolvedArgs, {
        cwd: workingDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...stepVars, RUNBOOK_DIR: baseDir },
        signal,
        timeout,
      });
    } else {
      const renderedCommand = renderPromptTemplate(rawCommand, stepVars);
      const command = baseDir
        ? renderedCommand
            .split(" ")
            .map((token) => {
              if (token.startsWith("-")) return token;
              const candidate = resolve(baseDir, token);
              if (existsSync(candidate)) {
                return candidate.includes(" ") ? `"${candidate.replaceAll('"', '\\"')}"` : candidate;
              }
              return token;
            })
            .join(" ")
        : renderedCommand;
      result = spawnSync(command, {
        cwd: workingDir,
        encoding: "utf8",
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          ...stepVars,
          RUNBOOK_DIR: baseDir,
          PATH: `${baseDir}:${process.env.PATH ?? ""}`,
        },
        signal,
        timeout,
      });
    }

    return commandResult(result);
  } catch (error: any) {
    return commandResult({ ...error, error });
  }
}

function commandSource(command: StepCommand): string {
  return typeof command === "string" ? command : [command.command, ...(command.args ?? [])].join(" ");
}

function setFailure(context: SessionContext, failure: StepFailure, preservePending = false): void {
  context.stepOutcome = "failure";
  context.stepExitCode = failure.exitCode;
  context.failure = failure;
  if (!preservePending || !context.pendingFailure) context.pendingFailure = failure;
}

function applyCheckResult(context: SessionContext, step: AgentStep, result: ReturnType<typeof runStepCheck>): void {
  const source = commandSource(step.run!);
  context.stepOutcome = result.outcome;
  context.stepExitCode = result.exitCode;
  if (result.outcome === "failure") {
    setFailure(context, {
      stepId: step.id, kind: "check", source,
      exitCode: result.exitCode, output: result.output,
    });
  } else {
    context.failure = undefined;
    if (context.pendingFailure?.kind === "check" && context.pendingFailure.stepId === step.id && context.pendingFailure.source === source) {
      context.pendingFailure = undefined;
    }
  }
}

function initialContext(config: RunnerConfig): SessionContext {
  const first = config.runbook.steps[0];
  const provider = resolveProvider(config, first);
  const model = resolveModel(config, first);
  const prompt = resolveStepPrompt(config, first);
  const mcpServers = resolveStepServers(config, first);

  return {
    provider,
    cwd: config.cwd,
    prompt,
    turnText: "",
    turnIndex: 0,
    stepIndex: 0,
    sessionId: null,
    triedProviders: [],
    pendingPermission: null,
    fallback: config.runbook.providers?.fallback ?? ["claude", "codex", "gemini"],
    onSpawnError: config.runbook.providers?.onSpawnError ?? "swap",
    mcpServers,
    model,
    shutdownIntent: null,
    lastError: undefined,
    loopCounts: {},
    failure: undefined,
    pendingFailure: undefined,
    stepOutcome: undefined,
    decision: null,
    why: null,
    decisionTarget: null,
    stepExitCode: null,
  };
}

export async function runAgent(options: RunAgentOptions): Promise<AgentRunResult> {
  const { config, onStateChange, inspect, signal } = options;

  const context = initialContext(config);
  const declaredServers = resolveMcpServers(config);
  const proxy = declaredServers.length > 0 ? new McpProxy(declaredServers) : null;

  let currentState = "idle";
  const transitionTo = (nextState: string) => {
    const prev = currentState;
    currentState = nextState;
    onStateChange?.(prev, nextState, context);
  };

  let session: AcpSession | null = null;

  const closeSession = async () => {
    const current: AcpSession | null = session;
    if (current) {
      session = null;
      await current.close();
    }
  };

  let aborted = Boolean(signal?.aborted);

  if (signal) {
    signal.addEventListener("abort", () => {
      aborted = true;
    });
  }

  if (aborted) {
    context.stepOutcome = "failure";
    context.lastError = "aborted";
    onStateChange?.("idle", "failed", context);
    return { outcome: "failed", context };
  }

  const ensureSession = async (
    targetProvider: ProviderId,
    targetModel?: string,
    targetServers = context.mcpServers,
  ): Promise<boolean> => {
    const currentSession: AcpSession | null = session;
    if (currentSession && !currentSession.needsSwap(targetProvider, targetModel)) {
      context.mcpServers = targetServers;
      return true;
    }

    if (session) {
      transitionTo("shuttingDown");
      await closeSession();
      context.sessionId = null;
    }

    transitionTo("spawning");
    if (!context.triedProviders.includes(targetProvider)) {
      context.triedProviders.push(targetProvider);
    }
    context.provider = targetProvider;
    context.model = targetModel;
    context.mcpServers = targetServers;

    try {
      const spec = providerSpec(targetProvider, config.runbook.providers?.agentHarness, { cwd: config.cwd });
      context.model = targetModel ?? spec.model;
      session = await AcpSession.spawn(spec, {
        cwd: config.cwd,
        model: context.model,
        ...(proxy ? { proxy } : { mcpServers: targetServers }),
        quiet: tracesToStdout(config.trace),
        signal,
        confirm: config.confirm,
        promptPermission: options.promptPermission,
        onUpdate: (_chunk, update) => {
          inspect?.({
            type: "runner.event",
            event: { type: "UPDATE", update },
          });
        },
        onPermissionRequested: (pending) => {
          context.pendingPermission = pending;
          transitionTo("awaitingPermission");
        },
        onPermissionResolved: () => {
          context.pendingPermission = null;
          transitionTo("working");
        },
      });
      context.sessionId = session.sessionId;
      context.effectiveModel = session.effectiveModel;
      context.lastError = undefined;
      return true;
    } catch (err: any) {
      context.lastError = err instanceof Error ? err.message : String(err);
      context.stepOutcome = "failure";
      return false;
    }
  };

  try {
    let runFinished = false;

    while (!runFinished && context.stepIndex < config.runbook.steps.length) {
      if (aborted || signal?.aborted) {
        context.stepOutcome = "failure";
        context.lastError = "aborted";
        transitionTo("shuttingDown");
        await closeSession();
        transitionTo("failed");
        return { outcome: "failed", context };
      }

      const currentStep = config.runbook.steps[context.stepIndex];
      context.failure = undefined;
      context.stepExitCode = null;

      let stepInputs: { vars: Record<string, string>; body?: string } = { vars: {} };
      let inputsFailed = false;
      try {
        if (proxy) {
          await proxy.setScope(resolveStepScope(config, currentStep), currentStep.id);
        }
        stepInputs = await collectStepInputs(config, currentStep, proxy);
      } catch (inputError: any) {
        inputsFailed = true;
        setFailure(context, {
          stepId: currentStep.id, kind: "input", source: currentStep.promptRef?.name ?? "step inputs",
          exitCode: null, output: inputError instanceof Error ? inputError.message : String(inputError),
        });
        transitionTo("choosingNext");
      }

      if (inputsFailed) {
      } else if (isScriptStep(currentStep)) {
        transitionTo("executingScript");
        const checkResult = runStepCheck(config, currentStep, stepInputs.vars, signal);
        applyCheckResult(context, currentStep, checkResult);
        transitionTo("choosingNext");
      } else {
        const ok = await ensureSession(
          context.provider,
          context.model,
          context.mcpServers,
        );
        if (!ok) {
          transitionTo("choosingNext");
        } else {
          transitionTo("inSession");
          context.turnText = "";
          try {
            const prompt = resolveStepPrompt(
              config,
              currentStep,
              stepInputs.vars,
              stepInputs.body !== undefined ? { body: stepInputs.body } : undefined,
            );
            transitionTo("working");
            const reply = await session!.prompt(buildPrompt(prompt, context.pendingFailure));
            context.pendingFailure = undefined;
            context.turnText = reply;
            context.turnIndex += 1;

            if (currentStep.run) {
              const checkResult = runStepCheck(config, currentStep, stepInputs.vars, signal);
              applyCheckResult(context, currentStep, checkResult);
            } else {
              context.stepOutcome = "success";
              context.failure = undefined;
              context.stepExitCode = 0;
            }
          } catch (promptErr: any) {
            context.lastError = promptErr instanceof Error ? promptErr.message : String(promptErr);
            setFailure(context, {
              stepId: currentStep.id, kind: "agent", source: "session/prompt",
              exitCode: null, output: context.lastError,
            }, true);
          }
          transitionTo("turnComplete");
          transitionTo("choosingNext");
        }
      }

      if (context.lastError) {
        const next = aborted
          ? { decision: "fail" as const, lastError: context.lastError, why: null, target: null }
          : decideAfterError(context);
        context.decision = next.decision;
        context.why = next.why ?? null;
        context.decisionTarget = next.target ?? null;
        if (next.provider) context.provider = next.provider;
        context.model = next.model;
        context.shutdownIntent = next.decision === "swap" ? "swap" : "fail";
        if (next.lastError) context.lastError = next.lastError;
      } else {
        const evaluatedContext = {
          ...context,
          stepOutcome: context.stepOutcome ?? "success",
          stepExitCode: context.stepExitCode ?? 0,
        };
        const next = decideAfterSuccess(evaluatedContext, config);
        context.decision = next.decision;
        context.why = next.why ?? null;
        context.decisionTarget = next.target ?? null;
        context.stepIndex = next.stepIndex;
        context.provider = next.provider;
        context.model = next.model;
        context.prompt = next.prompt;
        context.mcpServers = next.mcpServers;
        if (next.loopCounts) context.loopCounts = next.loopCounts;
        if (next.lastError) context.lastError = next.lastError;
        context.shutdownIntent =
          next.decision === "swap"
            ? "swap"
            : next.decision === "finish"
              ? "finish"
              : next.decision === "fail"
                ? "fail"
                : null;
      }

      if (!tracesToStdout(config.trace)) {
        console.log(
          `[runner] next: ${context.decision ?? "?"} → ${context.decisionTarget ?? "end"}`,
        );
      }

      if (context.decision === "finish") {
        transitionTo("shuttingDown");
        await closeSession();
        transitionTo("finished");
        return { outcome: "finished", context };
      }

      if (context.decision === "fail") {
        transitionTo("shuttingDown");
        await closeSession();
        transitionTo("failed");
        return { outcome: "failed", context };
      }

      if (context.decision === "swap") {
        transitionTo("shuttingDown");
        await closeSession();
        context.shutdownIntent = null;
        context.lastError = undefined;
        continue;
      }
    }

    transitionTo("shuttingDown");
    await closeSession();
    transitionTo("finished");
    return { outcome: "finished", context };
  } finally {
    await closeSession();
    if (proxy) await proxy.close();
  }
}
