export type ProviderId = string;

export type NextDecision = "stay" | "swap" | "finish" | "fail";

export interface StepTransitionConfig {
  target: string;
  maxAttempts?: number;
  fallback?: string;
}

export type StepTransition = string | StepTransitionConfig;

export interface StepRetry {
  maxAttempts?: number;
  fallback?: string;
}

export interface ToolScope {
  allow?: string[];
  deny?: string[];
}

export type StepServers = string[] | Record<string, ToolScope>;

export type StepCommand = string | { command: string; args?: string[]; timeout?: number };

export interface AgentStep {
  id: string;
  do?: string | { file: string };
  provider?: ProviderId;
  mcpServers?: StepServers;
  vars?: Record<string, unknown>;
  run?: StepCommand;
  timeout?: number;
  retry?: StepRetry;
  on?: {
    success?: StepTransition;
    failure?: StepTransition;
  };
}

export interface McpStdioSpec {
  type?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpRemoteSpec {
  type: "http" | "sse";
  url: string;
  headers?: Record<string, string>;
}

export type McpServerSpec = McpStdioSpec | McpRemoteSpec;

export interface ResolvedStdioServer {
  type: "stdio";
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}

export interface ResolvedRemoteServer {
  type: "http" | "sse";
  name: string;
  url: string;
  headers: Array<{ name: string; value: string }>;
}

export type ResolvedMcpServer = ResolvedStdioServer | ResolvedRemoteServer;

export function isStdioServer(server: ResolvedMcpServer): server is ResolvedStdioServer {
  return server.type === "stdio";
}

export interface AgentYaml {
  name?: string;
  description?: string;
  providers?: Record<string, ProviderDeclaration>;
  mcpServers?: Record<string, McpServerSpec>;
  vars?: Record<string, unknown>;
  steps: AgentStep[];
}

export interface ProviderDeclaration {
  command: string;
  args?: string[];
  model: string;
}

export type TransitionWhy =
  | "fallthrough"
  | "on.success"
  | "on.failure"
  | "fallback"
  | "maxAttempts"
  | null;

export type SwapReason = "provider";

export interface RunStartEvent {
  ts: string;
  run: string;
  ev: "run.start";
  v: number;
  agent: string | null;
  cwd: string;
  yaml: string;
  provider: string | null;
  model: string | null;
  steps: string[];
}

export interface StepStartEvent {
  ts: string;
  run: string;
  ev: "step.start";
  step: string;
  index: number;
  kind: "model" | "script";
  attempt: number;
  provider: string | null;
  model: string | null;
  servers: string[];
}

export interface StepEndEvent {
  ts: string;
  run: string;
  ev: "step.end";
  step: string;
  attempt: number;
  outcome: "success" | "failure";
  ms: number;
  exit: number | null;
  feedback: string | null;
  feedback_truncated?: boolean;
}

export interface ToolEvent {
  ts: string;
  run: string;
  ev: "tool";
  name: string;
  status: "pending" | "completed" | "failed";
  step: string;
  ms: number | null;
}

export interface TransitionEvent {
  ts: string;
  run: string;
  ev: "transition";
  from: string;
  to: string;
  decision: NextDecision | null;
  target: string | null;
  why: TransitionWhy;
}

export interface SwapEvent {
  ts: string;
  run: string;
  ev: "swap";
  from_provider: string | null;
  to_provider: string | null;
  from_model: string | null;
  to_model: string | null;
  reason: SwapReason;
}

export interface RunEndEvent {
  ts: string;
  run: string;
  ev: "run.end";
  outcome: "finished" | "failed";
  ms: number;
  steps_run: number;
  swaps: number;
  error: string | null;
}

export type RecordEvent =
  | RunStartEvent
  | StepStartEvent
  | StepEndEvent
  | ToolEvent
  | TransitionEvent
  | SwapEvent
  | RunEndEvent;

export type TraceMode = "off" | "file" | "stdout" | "both";

export const TRACE_MODES: TraceMode[] = ["off", "file", "stdout", "both"];

export function isTraceMode(value: string): value is TraceMode {
  return (TRACE_MODES as string[]).includes(value);
}

export function tracesToStdout(mode: TraceMode = "stdout"): boolean {
  return mode === "stdout" || mode === "both";
}

export function tracesToFile(mode: TraceMode = "stdout"): boolean {
  return mode === "file" || mode === "both";
}

export interface RunnerConfig {
  yamlPath: string;
  cwd: string;
  runbook: AgentYaml;
  trace?: TraceMode;
  confirm?: boolean;
}

export interface PermissionPending {
  toolCallId?: string;
  options: Array<{ optionId: string; kind?: string; name?: string }>;
}

export interface StepFailure {
  stepId: string;
  kind: "check" | "input" | "agent";
  source: string;
  exitCode: number | null;
  output: string;
}

export interface SessionContext {
  provider?: ProviderId;
  cwd: string;
  prompt: string;
  turnText: string;
  turnIndex: number;
  stepIndex: number;
  sessionId: string | null;
  pendingPermission: PermissionPending | null;
  mcpServers: ResolvedMcpServer[];
  model?: string;
  effectiveModel?: string;
  shutdownIntent: "finish" | "swap" | "fail" | null;
  lastError?: string;
  loopCounts: Record<string, number>;
  failure?: StepFailure;
  pendingFailure?: StepFailure;
  stepOutcome?: "success" | "failure";
  decision?: NextDecision | null;
  why?: TransitionWhy;
  decisionTarget?: string | null;
  stepExitCode?: number | null;
}

export function isScriptStep(step?: AgentStep): boolean {
  if (!step) return false;
  return Boolean(step.run && !step.do);
}

