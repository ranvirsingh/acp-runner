import { runAgent, type CreateAgentActorOptions, type AgentRunResult } from "./runtime/engine.js";
import type { SessionContext } from "./types.js";

export function stateValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, inner]) => `${key}.${stateValue(inner)}`)
      .join(",");
  }
  return String(value);
}

export function createAgentActor(options: CreateAgentActorOptions) {
  let resultPromise: Promise<AgentRunResult> | null = null;
  const controller = new AbortController();
  const snapshot = {
    status: "active" as "active" | "done",
    value: "idle" as string,
    context: {} as SessionContext,
  };

  return {
    start() {},
    send(_event?: unknown) {
      if (!resultPromise) {
        resultPromise = runAgent({
          ...options,
          signal: controller.signal,
        }).then((res) => {
          snapshot.status = "done";
          snapshot.value = res.outcome;
          snapshot.context = res.context;
          return res;
        });
      }
    },
    stop() {
      controller.abort();
      snapshot.status = "done";
    },
    getSnapshot() {
      return snapshot;
    },
    subscribe(observer: { next?: (s: typeof snapshot) => void; error?: (e: unknown) => void }) {
      if (resultPromise) {
        resultPromise.then(() => observer.next?.(snapshot)).catch((err) => observer.error?.(err));
      }
    },
  };
}

export { runAgent, runStepCheck, type CreateAgentActorOptions, type AgentRunResult } from "./runtime/engine.js";
export type { CommandResult } from "./runtime/command-result.js";
export {
  AcpSession,
  toAcpMcpServer,
  type McpProxyHandle,
  type SessionState,
  type SessionOptions,
  pickAllowOption,
  pickRejectOption,
  extractText,
  formatUpdate,
  stopChild,
  flattenSelectValues,
  type PermissionOption,
} from "./runtime/session.js";
export {
  type ProviderSpec,
  type AdapterConfigOptions,
  BUILTIN_PROVIDERS,
  providerSpec,
  resolveAdapterConfig,
  knownProviderIds,
  spawnCommandFor,
  describeSpawn,
  defaultProvider,
} from "./runtime/providers.js";
export { agentYamlSchema, validateAgentYaml } from "./config/schema.js";
export {
  loadAgentYaml,
  resolveRunbookPath,
  resolveStepCommand,
  resolveStepPrompt,
  resolveMcpServers,
  resolveStepScope,
  resolveStepServers,
  resolveProvider,
  resolveModel,
} from "./config/yaml.js";
export { loadConfig, parseArgs } from "./cli.js";
export { McpProxy, RESOURCE_LIMIT_BYTES } from "./mcp/proxy.js";
export {
  matchesPattern,
  normalizeScope,
  qualifyToolName,
  splitToolName,
  toolAllowed,
  visibleTools,
  type StepScope,
} from "./mcp/scope.js";
export { collectStepInputs, type StepInputs } from "./mcp/inputs.js";
export { lintRunbook } from "./config/lint.js";
export { RUNNER_VERSION } from "./version.js";
export { stateLog } from "./output/logs.js";
export { createRunId, truncateFeedback, RunRecorder } from "./output/record.js";
export * from "./types.js";
