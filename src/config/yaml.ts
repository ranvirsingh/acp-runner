import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse } from "yaml";
import { defaultProvider, resolveAdapterConfig } from "../runtime/providers.js";
import { validateAgentYaml } from "./schema.js";
import {
  isScriptStep,
  type AgentStep,
  type AgentYaml,
  type ProviderId,
  type ResolvedMcpServer,
  type RunnerConfig,
  type StepCommand,
} from "../types.js";
import { normalizeVariables, renderPromptTemplate, resolveStepVariables } from "./vars.js";
import { normalizeScope, type StepScope } from "../mcp/scope.js";

export function resolveRunbookPath(input: string): string {
  if (!existsSync(input) || !statSync(input).isDirectory()) return input;
  const inside = join(input, "agent.yaml");
  if (!existsSync(inside)) {
    throw new Error(`${input}: no agent.yaml in this folder`);
  }
  return inside;
}

export function loadAgentYaml(path: string): AgentYaml {
  return validateAgentYaml(parse(readFileSync(path, "utf8")), path);
}

export function stepBody(step: AgentStep, baseDir: string): string | undefined {
  if (step.do == null) return undefined;
  if (typeof step.do === "object") {
    try {
      return readFileSync(resolve(baseDir, step.do.file), "utf8");
    } catch {
      throw new Error(`step ${step.id}: cannot read ${step.do.file}`);
    }
  }
  return step.do.trim().length === 0 ? undefined : step.do;
}

export function resolveProvider(
  config: RunnerConfig,
  step?: AgentStep,
): ProviderId {
  if (step?.provider) return step.provider;
  if (config.providerOverride) return config.providerOverride;
  return config.runbook.provider ?? defaultProvider();
}

export function resolveModel(config: RunnerConfig, step?: AgentStep): string | undefined {
  const harnesses = resolveAdapterConfig({
    cwd: config.cwd,
    runbookDeclared: config.runbook.providers?.agentHarness,
  });
  return step?.model ?? harnesses[resolveProvider(config, step)]?.model ?? config.runbook.model;
}

export function resolveStepPrompt(
  config: RunnerConfig,
  step: AgentStep,
  extraVars?: Record<string, unknown>,
  options?: { stubMissingVars?: boolean; body?: string },
): string {
  if (options?.body !== undefined) {
    return options.body;
  }
  const body = stepBody(step, dirname(config.yamlPath));
  if (!body) {
    if (isScriptStep(step) || step.promptRef) return "";
    throw new Error(`step ${step.id}: no prompt body`);
  }
  try {
    return renderPromptTemplate(
      body,
      resolveStepVariables(config, step, extraVars, options?.stubMissingVars),
      options?.stubMissingVars,
    );
  } catch (error) {
    throw new Error(`step ${step.id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function resolveStepCommand(
  config: RunnerConfig,
  step: AgentStep,
  command?: StepCommand,
  extraVars?: Record<string, unknown>,
  options?: { stubMissingVars?: boolean },
): string | undefined {
  const raw = command ?? step.run;
  if (!raw) return undefined;
  const vars = resolveStepVariables(config, step, extraVars, options?.stubMissingVars);
  const render = (value: string) => renderPromptTemplate(value, vars, options?.stubMissingVars);
  try {
    if (typeof raw === "object" && raw !== null && "command" in raw) {
      return [render(raw.command), ...(raw.args ?? []).map(render)].join(" ");
    }
    return render(raw);
  } catch (error) {
    throw new Error(`step ${step.id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}


function resolveInFolder(value: string, baseDir: string): string {
  if (isAbsolute(value) || !value.includes("/")) return value;
  const candidate = resolve(baseDir, value);
  return existsSync(candidate) ? candidate : value;
}

export function resolveMcpServers(config: RunnerConfig, stubMissing = false): ResolvedMcpServer[] {
  const declared = config.runbook.providers?.mcpServers;
  if (!declared) return [];
  const baseDir = dirname(config.yamlPath);
  const variables = normalizeVariables(baseDir, config.runbook.vars, undefined, stubMissing);
  return Object.entries(declared).map(([name, spec]) => {
    const render = (value: string) => renderPromptTemplate(value, variables, stubMissing);
    try {
      if ("url" in spec) {
        return {
          type: spec.type,
          name,
          url: render(spec.url),
          headers: Object.entries(spec.headers ?? {}).map(([key, value]) => ({
            name: key,
            value: render(value),
          })),
        };
      }
      return {
        type: "stdio" as const,
        name,
        command: resolveInFolder(render(spec.command), baseDir),
        args: (spec.args ?? []).map((arg) => resolveInFolder(render(arg), baseDir)),
        env: Object.entries(spec.env ?? {}).map(([key, value]) => ({
          name: key,
          value: render(value),
        })),
      };
    } catch (error) {
      throw new Error(
        `mcpServers ${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
}

export function resolveStepScope(config: RunnerConfig, step: AgentStep): StepScope {
  const declared = Object.keys(config.runbook.providers?.mcpServers ?? {});
  return normalizeScope(step.servers, declared);
}

export function resolveStepServers(config: RunnerConfig, step: AgentStep): ResolvedMcpServer[] {
  const catalogue = resolveMcpServers(config);
  const scope = resolveStepScope(config, step);
  return catalogue.filter((server) => Object.hasOwn(scope, server.name));
}

export function needsNewBody(
  current: { provider: ProviderId; model?: string },
  next: { provider: ProviderId; model?: string },
): boolean {
  if (current.provider !== next.provider) return true;
  if (next.model && current.model && next.model !== current.model) return true;
  if (next.model && !current.model) return true;
  return false;
}
