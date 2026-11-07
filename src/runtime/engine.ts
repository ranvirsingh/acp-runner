import { spawn, type SpawnOptions } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { decideAfterSuccess } from "./decide.js";
import { collectStepInputs } from "../mcp/inputs.js";
import { McpProxy } from "../mcp/proxy.js";
import { providerSpec } from "./providers.js";
import { AcpSession } from "./session.js";
import { buildPrompt } from "./failure.js";
import { commandResult, type CommandResult } from "./command-result.js";
import { RequestError } from "@agentclientprotocol/sdk";
import { inputsHash, runbookHash, writeFeedback, type Journal, type JournalEvent } from "./journal.js";
import { RUNNER_VERSION } from "../version.js";
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
import { createRedactor, secretValues } from "../output/redact.js";
import { externalReferences, missingExternalValues, secretsInPrompts } from "../config/external.js";
import {
  resolveMcpServers,
  resolveModel,
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
  state?: RunState;
}

export interface RunState {
  dir: string;
  journal: Journal;
  events: JournalEvent[];
}

export type RunAgentOptions = CreateAgentActorOptions;

export interface AgentRunResult {
  outcome: "finished" | "failed" | "unknown" | "stopped";
  context: SessionContext;
  reason?: string;
}

class StopRun extends Error {}

function runCommand(
  command: string,
  args: string[],
  options: SpawnOptions & { timeout: number; signal?: AbortSignal },
): Promise<CommandResult> {
  const { timeout, signal, ...spawnOptions } = options;
  return new Promise((resolveResult) => {
    const child = spawn(command, args, { ...spawnOptions, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let error: Error | undefined;
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    const stop = (reason: Error) => {
      error ??= reason;
      child.kill("SIGTERM");
    };
    const timer = setTimeout(() => stop(new Error(`${command} ETIMEDOUT`)), timeout);
    const onAbort = () => stop(new Error("aborted"));
    signal?.addEventListener("abort", onAbort, { once: true });
    child.once("error", (spawnError) => { error ??= spawnError; });
    child.once("close", (status, killSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolveResult(commandResult({ status, signal: killSignal, error, stdout, stderr }));
    });
  });
}

export async function runStepCheck(
  config: RunnerConfig,
  step?: AgentStep,
  extraVars?: Record<string, unknown>,
  signal?: AbortSignal,
  timeout?: number,
): Promise<CommandResult> {
  const rawCommand = step?.run;
  if (!rawCommand || !step) return { outcome: "success", output: "", exitCode: null };
  if (signal?.aborted) {
    return { outcome: "failure", output: "aborted", exitCode: null };
  }
  const defaultTimeout = 300000;
  const commandTimeout =
    typeof rawCommand === "object" && rawCommand !== null && "timeout" in rawCommand && typeof (rawCommand as any).timeout === "number"
      ? (rawCommand as any).timeout
      : step?.timeout;
  const effectiveTimeout = timeout ?? commandTimeout ?? defaultTimeout;
  const cwd = config.cwd;
  mkdirSync(cwd, { recursive: true });
  const workingDir = existsSync(cwd) ? cwd : process.cwd();
  const baseDir = dirname(config.yamlPath);
  const stepVars = resolveStepVariables(config, step, extraVars);

  try {
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
      return await runCommand(resolvedCommand, resolvedArgs, {
        cwd: workingDir,
        env: { ...process.env, ...stepVars, RUNBOOK_DIR: baseDir },
        signal,
        timeout: effectiveTimeout,
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
      return await runCommand(command, [], {
        cwd: workingDir,
        shell: true,
        env: {
          ...process.env,
          ...stepVars,
          RUNBOOK_DIR: baseDir,
          PATH: `${baseDir}:${process.env.PATH ?? ""}`,
        },
        signal,
        timeout: effectiveTimeout,
      });
    }
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

function applyCheckResult(context: SessionContext, step: AgentStep, result: CommandResult): void {
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
  const provider = first.provider;
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
    pendingPermission: null,
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

function nextTarget(context: SessionContext): string {
  if (context.decision === "finish") return "END";
  if (context.decision === "fail") return "FAIL";
  return context.decisionTarget ?? "END";
}

function isInfrastructureFailure(error: unknown, session: AcpSession | null): boolean {
  if (!session || session.state === "closed") return true;
  return !(error instanceof RequestError) || error.code === -32000;
}

export async function runAgent(options: RunAgentOptions): Promise<AgentRunResult> {
  const { config, onStateChange, inspect, signal, state } = options;

  const missing = missingExternalValues(config);
  if (missing.length > 0) throw new Error(`missing outside values: ${missing.join("; ")}`);
  const promptSecrets = secretsInPrompts(config);
  if (promptSecrets.length > 0) throw new Error(promptSecrets.join("; "));

  const context = initialContext(config);
  const declaredServers = resolveMcpServers(config);
  const proxy = declaredServers.length > 0 ? new McpProxy(declaredServers, undefined, secretValues(config)) : null;
  const redact = createRedactor(config, proxy?.authHeaders.map((header) => header.value) ?? []);
  const hiddenEnv = externalReferences(config).secrets;

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
    return { outcome: state ? "stopped" : "failed", context };
  }

  const record = async (event: JournalEvent): Promise<void> => {
    if (!state) return;
    try {
      await state.journal.append(event);
    } catch (error) {
      await (session as AcpSession | null)?.cancel().catch(() => {});
      throw new StopRun(`journal write failed (${error instanceof Error ? error.message : String(error)}); the journal may be behind`);
    }
  };

  const visits: Record<string, number> = {};
  let visit = 0;
  let savedFeedback: { failure: StepFailure; path: string } | undefined;

  const feedbackPath = (stepId: string): string | undefined => {
    if (!state || !context.pendingFailure) return undefined;
    if (savedFeedback?.failure !== context.pendingFailure) {
      const failure = { ...context.pendingFailure, output: redact(context.pendingFailure.output) };
      savedFeedback = { failure: context.pendingFailure, path: writeFeedback(state.dir, stepId, visit, failure) };
    }
    return savedFeedback.path;
  };

  const ensureSession = async (
    targetProvider: ProviderId | undefined,
    targetServers = context.mcpServers,
  ): Promise<"new" | "carried" | null> => {
    if (!targetProvider) {
      context.lastError = "no provider: set provider on the step";
      context.stepOutcome = "failure";
      return null;
    }
    const currentSession: AcpSession | null = session;
    if (currentSession && !currentSession.needsSwap(targetProvider)) {
      context.mcpServers = targetServers;
      return "carried";
    }

    if (session) {
      transitionTo("shuttingDown");
      await closeSession();
      context.sessionId = null;
    }

    transitionTo("spawning");
    context.provider = targetProvider;
    context.mcpServers = targetServers;

    try {
      const spec = providerSpec(targetProvider, config.runbook.providers);
      context.model = spec.model;
      session = await AcpSession.spawn(spec, {
        cwd: config.cwd,
        model: context.model,
        ...(proxy ? { proxy } : { mcpServers: targetServers }),
        quiet: tracesToStdout(config.trace),
        signal,
        confirm: config.confirm,
        redact,
        hiddenEnv,
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
      return "new";
    } catch (err: any) {
      const message = err instanceof Error ? err.message : String(err);
      if (state) throw new StopRun(message);
      context.lastError = message;
      context.stepOutcome = "failure";
      return null;
    }
  };

  const stopIfAborted = () => {
    if (state && (aborted || signal?.aborted)) throw new StopRun("aborted");
  };

  try {
    if (state && state.events.length === 0) {
      await record({
        event: "run_started",
        v: 1,
        runbook: runbookHash(config),
        inputs: inputsHash(config),
        runner: RUNNER_VERSION,
        cwd: config.cwd,
      });
    }

    let runFinished = false;

    while (!runFinished && context.stepIndex < config.runbook.steps.length) {
      stopIfAborted();
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
      visit = (visits[currentStep.id] ?? 0) + 1;
      visits[currentStep.id] = visit;
      await record({ event: "step_started", step: currentStep.id, visit });

      let inputVars: Record<string, string> = {};
      let inputsFailed = false;
      try {
        if (proxy) {
          await proxy.setScope(resolveStepScope(config, currentStep), currentStep.id);
        }
        inputVars = await collectStepInputs(config, currentStep, proxy);
      } catch (inputError: any) {
        inputsFailed = true;
        setFailure(context, {
          stepId: currentStep.id, kind: "input", source: "step inputs",
          exitCode: null, output: inputError instanceof Error ? inputError.message : String(inputError),
        });
        transitionTo("choosingNext");
      }

      if (inputsFailed) {
      } else if (isScriptStep(currentStep)) {
        transitionTo("executingScript");
        const checkResult = await runStepCheck(config, currentStep, inputVars, signal);
        stopIfAborted();
        applyCheckResult(context, currentStep, checkResult);
        transitionTo("choosingNext");
      } else {
        const origin = await ensureSession(context.provider, context.mcpServers);
        if (!origin) {
          transitionTo("choosingNext");
        } else {
          await record({
            event: "session_attached", step: currentStep.id, visit,
            provider: context.provider!, sessionId: session!.sessionId!, origin,
          });
          transitionTo("inSession");
          context.turnText = "";
          try {
            const prompt = resolveStepPrompt(config, currentStep, inputVars);
            transitionTo("working");
            const failure = context.pendingFailure && { ...context.pendingFailure, output: redact(context.pendingFailure.output) };
            const feedback = feedbackPath(currentStep.id);
            await record({
              event: "prompt_sent", step: currentStep.id, visit, sessionId: session!.sessionId!, kind: "step",
              ...(feedback ? { feedback } : {}),
            });
            const reply = await session!.prompt(buildPrompt(redact(prompt), failure));
            await record({
              event: "prompt_completed", step: currentStep.id, visit, stopReason: session!.stopReason,
              ...(feedback ? { feedback } : {}),
            });
            context.pendingFailure = undefined;
            context.turnText = reply;
            context.turnIndex += 1;

            if (currentStep.run) {
              const checkResult = await runStepCheck(config, currentStep, inputVars, signal);
              stopIfAborted();
              applyCheckResult(context, currentStep, checkResult);
            } else {
              context.stepOutcome = "success";
              context.failure = undefined;
              context.stepExitCode = 0;
            }
          } catch (promptErr: any) {
            if (promptErr instanceof StopRun) throw promptErr;
            stopIfAborted();
            const message = promptErr instanceof Error ? promptErr.message : String(promptErr);
            if (state && isInfrastructureFailure(promptErr, session)) throw new StopRun(message);
            context.lastError = message;
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
        context.decision = "fail";
        context.why = null;
        context.decisionTarget = null;
        context.shutdownIntent = "fail";
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

      if (state) {
        const feedback = feedbackPath(currentStep.id);
        await record({
          event: "step_completed", step: currentStep.id, visit,
          outcome: context.lastError ? "failure" : (context.stepOutcome ?? "success"),
          why: context.why ?? null,
          next: nextTarget(context),
          ...(context.decision === "swap" ? { swap: true as const } : {}),
          ...(feedback ? { feedback } : {}),
        });
        if (context.decision === "finish") await record({ event: "run_finished", outcome: "finished" });
        if (context.decision === "fail") {
          await record({ event: "run_finished", outcome: "failed", reason: redact(context.lastError ?? `step ${currentStep.id}: failed`) });
        }
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
  } catch (error) {
    if (!(error instanceof StopRun)) throw error;
    context.lastError = error.message;
    transitionTo("shuttingDown");
    await closeSession();
    transitionTo("stopped");
    return { outcome: "stopped", context, reason: error.message };
  } finally {
    await closeSession();
    if (proxy) await proxy.close();
  }
}
