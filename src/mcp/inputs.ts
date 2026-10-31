import type { AgentStep, RunnerConfig } from "../types.js";
import type { McpProxy } from "./proxy.js";

function resourceSources(
  config: RunnerConfig,
  step: AgentStep,
): Array<{ key: string; resource: string; server: string }> {
  const out: Array<{ key: string; resource: string; server: string }> = [];
  for (const [key, source] of Object.entries({ ...config.runbook.vars, ...step.vars })) {
    if (!source || typeof source !== "object") continue;
    const spec = source as { resource?: unknown; mcpServer?: unknown };
    if (typeof spec.resource !== "string" || typeof spec.mcpServer !== "string") continue;
    out.push({ key, resource: spec.resource, server: spec.mcpServer });
  }
  return out;
}

export async function collectStepInputs(
  config: RunnerConfig,
  step: AgentStep,
  proxy: McpProxy | null,
): Promise<Record<string, string>> {
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

  return vars;
}
