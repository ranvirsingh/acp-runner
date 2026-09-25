import type { AgentStep, RunnerConfig } from "../types.js";
import { renderPromptTemplate, resolveStepVariables } from "../config/vars.js";
import type { McpProxy } from "./proxy.js";

export interface StepInputs {
  vars: Record<string, string>;
  body?: string;
}

function resourceSources(
  config: RunnerConfig,
  step: AgentStep,
): Array<{ key: string; resource: string; server: string }> {
  const out: Array<{ key: string; resource: string; server: string }> = [];
  for (const layer of [config.runbook.vars, step.vars]) {
    for (const [key, source] of Object.entries(layer ?? {})) {
      if (!source || typeof source !== "object") continue;
      const spec = source as { resource?: unknown; server?: unknown };
      if (typeof spec.resource !== "string" || typeof spec.server !== "string") continue;
      out.push({ key, resource: spec.resource, server: spec.server });
    }
  }
  return out;
}

export async function collectStepInputs(
  config: RunnerConfig,
  step: AgentStep,
  proxy: McpProxy | null,
): Promise<StepInputs> {
  const sources = resourceSources(config, step);
  const vars: Record<string, string> = {};
  if (sources.length > 0) {
    if (!proxy) throw new Error(`step ${step.id}: no MCP servers are declared`);
    for (const source of sources) {
      try {
        vars[source.key] = await proxy.readResource(source.server, source.resource);
      } catch (error) {
        throw new Error(
          `step ${step.id}: var ${source.key}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  if (!step.promptRef) return { vars };
  if (!proxy) throw new Error(`step ${step.id}: no MCP servers are declared`);
  const stepVars = { ...resolveStepVariables(config, step), ...vars };
  const args = Object.fromEntries(
    Object.entries(step.promptRef.arguments ?? {}).map(([key, value]) => [
      key,
      renderPromptTemplate(value, stepVars),
    ]),
  );
  try {
    const body = await proxy.getPrompt(step.promptRef.server, step.promptRef.name, args);
    return { vars, body };
  } catch (error) {
    throw new Error(
      `step ${step.id}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
