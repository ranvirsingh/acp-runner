import { randomBytes } from "node:crypto";
import { RUNNER_VERSION } from "../version.js";
import type {
  ProviderDeclaration,
  RecordEvent,
  RunStartEvent,
  StepEndEvent,
  StepStartEvent,
} from "../types.js";

export const OTLP_HEADER_ENV = [
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
  "OTEL_EXPORTER_OTLP_LOGS_HEADERS",
] as const;

export interface Telemetry {
  record(event: RecordEvent): void;
  flush(): Promise<void>;
  shutdown(deadlineMs?: number): Promise<void>;
}

const PROVIDER_BY_AGENT: Record<string, string> = {
  "@agentclientprotocol/claude-agent-acp": "anthropic",
  "@agentclientprotocol/codex-acp": "openai",
  "gemini-cli": "gcp.gen_ai",
};

const QUEUE_LIMIT = 2048;
const FLUSH_INTERVAL_MS = 2000;
const SHUTDOWN_DEADLINE_MS = 3000;
const REQUEST_TIMEOUT_MS = 10_000;
const KIND_INTERNAL = 1;
const KIND_CLIENT = 3;
const STATUS_ERROR = { code: 2 };
const SEVERITY = { DEBUG: 5, INFO: 9, ERROR: 17 } as const;

type Scalar = string | number | boolean;
type Attributes = Record<string, Scalar | string[] | null | undefined>;
type AnyValue =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number }
  | { boolValue: boolean }
  | { arrayValue: { values: AnyValue[] } };
type KeyValue = { key: string; value: AnyValue };

interface Destination {
  url: string;
  headers: Record<string, string>;
}

interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  traceState?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: KeyValue[];
  events?: Array<{ timeUnixNano: string; name: string; attributes: KeyValue[] }>;
  status: { code?: number };
}

interface LogRecord {
  timeUnixNano: string;
  observedTimeUnixNano: string;
  severityNumber: number;
  severityText: string;
  eventName: string;
  body: { stringValue: string };
  attributes: KeyValue[];
  traceId: string;
  spanId: string;
}

function anyValue(value: Scalar | string[]): AnyValue {
  if (Array.isArray(value)) return { arrayValue: { values: value.map((item) => ({ stringValue: item })) } };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
}

function keyValues(attributes: Attributes): KeyValue[] {
  return Object.entries(attributes)
    .filter((entry): entry is [string, Scalar | string[]] => entry[1] !== null && entry[1] !== undefined)
    .map(([key, value]) => ({ key, value: anyValue(value) }));
}

function parsePairs(text: string | undefined): Record<string, string> {
  const pairs: Record<string, string> = {};
  for (const item of (text ?? "").split(",")) {
    const separator = item.indexOf("=");
    if (separator <= 0) continue;
    try {
      pairs[decodeURIComponent(item.slice(0, separator).trim())] = decodeURIComponent(item.slice(separator + 1).trim());
    } catch {
      continue;
    }
  }
  return pairs;
}

function destination(env: NodeJS.ProcessEnv, signal: "TRACES" | "LOGS", path: string): Destination | null {
  const shared = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  const url = env[`OTEL_EXPORTER_OTLP_${signal}_ENDPOINT`]?.trim() || (shared ? `${shared.replace(/\/+$/, "")}${path}` : "");
  if (!url) return null;
  return {
    url,
    headers: {
      ...parsePairs(env.OTEL_EXPORTER_OTLP_HEADERS),
      ...parsePairs(env[`OTEL_EXPORTER_OTLP_${signal}_HEADERS`]),
      "Content-Type": "application/json",
    },
  };
}

function parentFrom(traceparent: string | undefined): { traceId: string; spanId: string } | null {
  const match = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/.exec(traceparent?.trim() ?? "");
  if (!match || match[1] === "ff" || /^0+$/.test(match[2]) || /^0+$/.test(match[3])) return null;
  return { traceId: match[2], spanId: match[3] };
}

const randomId = (bytes: number) => randomBytes(bytes).toString("hex");
const nanos = (iso: string) => String(BigInt(Date.parse(iso)) * 1_000_000n);
const nanosBefore = (iso: string, ms: number) => String((BigInt(Date.parse(iso)) - BigInt(ms)) * 1_000_000n);

function eventAttributes(event: RecordEvent, captureContent: boolean): Attributes {
  const common = { "acp.run.id": event.run };
  switch (event.ev) {
    case "run.start":
      return { ...common, "gen_ai.agent.name": event.agent, "acp.run.steps": event.steps };
    case "run.end":
      return {
        ...common,
        "acp.run.outcome": event.outcome,
        "acp.run.steps_run": event.steps_run,
        "acp.run.swaps": event.swaps,
        ...(captureContent ? { "acp.run.error": event.error } : {}),
      };
    case "step.start":
      return {
        ...common,
        "acp.step.id": event.step,
        "acp.step.index": event.index,
        "acp.step.kind": event.kind,
        "acp.step.attempt": event.attempt,
        "acp.step.provider": event.provider,
        "acp.step.mcp_servers": event.servers,
      };
    case "step.end":
      return {
        ...common,
        "acp.step.id": event.step,
        "acp.step.attempt": event.attempt,
        "acp.step.outcome": event.outcome,
        "process.exit.code": event.exit,
        "gen_ai.conversation.id": event.session,
        "gen_ai.request.model": event.model,
        "gen_ai.usage.input_tokens": event.usage?.input,
        "gen_ai.usage.output_tokens": event.usage?.output,
        "acp.agent.name": event.agent?.name,
        "acp.agent.version": event.agent?.version,
        ...(captureContent
          ? { "acp.step.feedback": event.feedback, "acp.step.feedback_truncated": event.feedback_truncated }
          : {}),
      };
    case "tool":
      return {
        ...common,
        "gen_ai.tool.name": event.name,
        "gen_ai.tool.call.id": event.call,
        "acp.tool.status": event.status,
        "acp.step.id": event.step,
      };
    case "transition":
      return {
        ...common,
        "acp.transition.from": event.from,
        "acp.transition.to": event.to,
        "acp.transition.decision": event.decision,
        "acp.transition.target": event.target,
        "acp.transition.why": event.why,
      };
    case "swap":
      return {
        ...common,
        "acp.swap.from_provider": event.from_provider,
        "acp.swap.to_provider": event.to_provider,
        "acp.swap.from_model": event.from_model,
        "acp.swap.to_model": event.to_model,
        "acp.swap.reason": event.reason,
      };
  }
}

function logLine(event: RecordEvent): string {
  switch (event.ev) {
    case "run.start":
      return `run ${event.agent ?? "agent"} started`;
    case "run.end":
      return `run ${event.outcome}`;
    case "step.start":
      return `step ${event.step} started (attempt ${event.attempt})`;
    case "step.end":
      return `step ${event.step} ${event.outcome} (attempt ${event.attempt})`;
    case "tool":
      return `tool ${event.name} ${event.status}`;
    case "transition":
      return `${event.from} -> ${event.to}`;
    case "swap":
      return `swap ${event.from_provider ?? "?"} -> ${event.to_provider ?? "?"}`;
  }
}

function severityOf(event: RecordEvent): keyof typeof SEVERITY {
  if (event.ev === "transition") return "DEBUG";
  const failed =
    (event.ev === "step.end" && event.outcome === "failure") ||
    (event.ev === "tool" && event.status === "failed") ||
    (event.ev === "run.end" && event.outcome === "failed");
  return failed ? "ERROR" : "INFO";
}

export function createTelemetry(options: {
  env: NodeJS.ProcessEnv;
  providers?: Record<string, ProviderDeclaration>;
  send?: typeof fetch;
}): Telemetry | null {
  const { env, providers = {}, send = fetch } = options;
  if (env.OTEL_SDK_DISABLED?.trim().toLowerCase() === "true") return null;
  const traces = destination(env, "TRACES", "/v1/traces");
  const logs = destination(env, "LOGS", "/v1/logs");
  if (!traces && !logs) return null;

  const captureContent = env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT?.trim().toLowerCase() === "true";
  const resourceAttributes = parsePairs(env.OTEL_RESOURCE_ATTRIBUTES);
  const resource = {
    attributes: keyValues({
      ...resourceAttributes,
      "service.name": env.OTEL_SERVICE_NAME?.trim() || resourceAttributes["service.name"] || "acp-runner",
      "service.version": RUNNER_VERSION,
      "process.runtime.name": process.versions.bun ? "bun" : "node",
      "process.runtime.version": process.versions.bun ?? process.versions.node,
    }),
  };
  const scope = { name: "acp-runner", version: RUNNER_VERSION };

  const parent = parentFrom(env.TRACEPARENT);
  const traceId = parent?.traceId ?? randomId(16);
  const traceState = parent && env.TRACESTATE?.trim() ? env.TRACESTATE.trim() : undefined;
  const runSpanId = randomId(8);
  let runStart: RunStartEvent | undefined;
  let openStep: { spanId: string; start: StepStartEvent } | undefined;
  const openTools = new Map<string, { spanId: string; parentSpanId: string; start: string; name: string; step: string }>();
  const runEvents: NonNullable<Span["events"]> = [];

  let spans: Span[] = [];
  let logRecords: LogRecord[] = [];
  let dropped = 0;
  const warned = new Set<string>();
  const inflight = new Set<Promise<void>>();
  let closed = false;

  const warnOnce = (kind: string, message: string) => {
    if (warned.has(kind)) return;
    warned.add(kind);
    console.error(`[runner] warning: ${message}`);
  };

  const enqueue = <T>(queue: T[], item: T) => {
    if (queue.length >= QUEUE_LIMIT) {
      queue.shift();
      dropped += 1;
    }
    queue.push(item);
  };

  const span = (fields: Omit<Span, "traceId" | "traceState">) =>
    enqueue(spans, { traceId, ...(traceState ? { traceState } : {}), ...fields });

  const closeTool = (call: string, end: string, failed: boolean, errorType: string) => {
    const tool = openTools.get(call);
    if (!tool) return;
    openTools.delete(call);
    span({
      spanId: tool.spanId,
      parentSpanId: tool.parentSpanId,
      name: `execute_tool ${tool.name}`,
      kind: KIND_INTERNAL,
      startTimeUnixNano: nanos(tool.start),
      endTimeUnixNano: nanos(end),
      attributes: keyValues({
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": tool.name,
        "gen_ai.tool.call.id": call,
        "acp.step.id": tool.step,
        ...(failed ? { "error.type": errorType } : {}),
      }),
      status: failed ? STATUS_ERROR : {},
    });
  };

  const closeStep = (end: StepEndEvent) => {
    if (!openStep) return;
    const { spanId, start } = openStep;
    openStep = undefined;
    for (const [call, tool] of openTools) {
      if (tool.parentSpanId === spanId) closeTool(call, end.ts, true, "incomplete");
    }
    const failed = end.outcome === "failure";
    const model = start.kind === "model";
    const errorType = !model && end.exit !== null && end.exit !== 0 ? "exit_nonzero" : "_OTHER";
    const genAi = model
      ? {
          "gen_ai.operation.name": "invoke_agent",
          "gen_ai.provider.name":
            (start.provider ? providers[start.provider]?.otel?.providerName : undefined) ??
            (end.agent ? PROVIDER_BY_AGENT[end.agent.name] : undefined) ??
            start.provider ??
            "unknown",
        }
      : {};
    span({
      spanId,
      parentSpanId: runSpanId,
      name: model ? `invoke_agent${start.provider ? ` ${start.provider}` : ""}` : `step ${start.step}`,
      kind: model ? KIND_CLIENT : KIND_INTERNAL,
      startTimeUnixNano: nanos(start.ts),
      endTimeUnixNano: nanos(end.ts),
      attributes: keyValues({
        ...eventAttributes(start, false),
        ...eventAttributes(end, false),
        ...genAi,
        ...(failed ? { "error.type": errorType } : {}),
      }),
      status: failed ? STATUS_ERROR : {},
    });
  };

  const closeRun = (end: Extract<RecordEvent, { ev: "run.end" }>) => {
    const failed = end.outcome === "failed";
    const agent = runStart?.agent;
    span({
      spanId: runSpanId,
      ...(parent ? { parentSpanId: parent.spanId } : {}),
      name: agent ? `invoke_workflow ${agent}` : "invoke_workflow",
      kind: KIND_INTERNAL,
      startTimeUnixNano: runStart ? nanos(runStart.ts) : nanosBefore(end.ts, end.ms),
      endTimeUnixNano: nanos(end.ts),
      attributes: keyValues({
        ...(runStart ? eventAttributes(runStart, false) : {}),
        ...eventAttributes(end, false),
        "gen_ai.operation.name": "invoke_workflow",
        ...(failed ? { "error.type": "_OTHER" } : {}),
      }),
      ...(runEvents.length ? { events: [...runEvents] } : {}),
      status: failed ? STATUS_ERROR : {},
    });
  };

  const post = (target: Destination, body: unknown, signal: AbortSignal) => {
    const request = (async () => {
      try {
        const response = await send(target.url, {
          method: "POST",
          headers: target.headers,
          body: JSON.stringify(body),
          signal,
        });
        const text = await response.text();
        if (!response.ok) {
          warnOnce("failed", `telemetry export failed: HTTP ${response.status} from ${target.url}`);
          return;
        }
        const partial = text ? JSON.parse(text)?.partialSuccess : undefined;
        if (partial && (Number(partial.rejectedSpans ?? 0) > 0 || Number(partial.rejectedLogRecords ?? 0) > 0 || partial.errorMessage)) {
          warnOnce("partial", `telemetry export partly rejected by ${target.url}: ${partial.errorMessage ?? "no reason given"}`);
        }
      } catch (error) {
        warnOnce("failed", `telemetry export failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
    inflight.add(request);
    void request.finally(() => inflight.delete(request));
  };

  const flush = async (signal?: AbortSignal) => {
    if (dropped > 0) {
      console.error(`[runner] warning: dropped ${dropped} telemetry records because the export queue was full`);
      dropped = 0;
    }
    const requestSignal = signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    if (traces && spans.length) {
      post(traces, { resourceSpans: [{ resource, scopeSpans: [{ scope, spans }] }] }, requestSignal);
    }
    if (logs && logRecords.length) {
      post(logs, { resourceLogs: [{ resource, scopeLogs: [{ scope, logRecords }] }] }, requestSignal);
    }
    spans = [];
    logRecords = [];
    await Promise.allSettled([...inflight]);
  };

  const timer = setInterval(() => void flush(), FLUSH_INTERVAL_MS);
  timer.unref?.();

  return {
    record(event) {
      if (closed) return;
      if (event.ev === "run.start") runStart = event;
      if (event.ev === "step.start") openStep = { spanId: randomId(8), start: event };
      if (event.ev === "tool" && event.status === "pending" && event.call) {
        openTools.set(event.call, {
          spanId: randomId(8),
          parentSpanId: openStep?.spanId ?? runSpanId,
          start: event.ts,
          name: event.name,
          step: event.step,
        });
      }

      const severity = severityOf(event);
      enqueue(logRecords, {
        timeUnixNano: nanos(event.ts),
        observedTimeUnixNano: String(BigInt(Date.now()) * 1_000_000n),
        severityNumber: SEVERITY[severity],
        severityText: severity,
        eventName: `acp.${event.ev}`,
        body: { stringValue: logLine(event) },
        attributes: keyValues(eventAttributes(event, captureContent)),
        traceId,
        spanId: openStep?.spanId ?? runSpanId,
      });

      if (event.ev === "tool" && event.status !== "pending") {
        if (event.call && !openTools.has(event.call) && event.ms !== null) {
          openTools.set(event.call, {
            spanId: randomId(8),
            parentSpanId: openStep?.spanId ?? runSpanId,
            start: new Date(Date.parse(event.ts) - event.ms).toISOString(),
            name: event.name,
            step: event.step,
          });
        }
        if (event.call) closeTool(event.call, event.ts, event.status === "failed", "_OTHER");
      }
      if (event.ev === "swap") {
        runEvents.push({
          timeUnixNano: nanos(event.ts),
          name: "acp.provider.swap",
          attributes: keyValues(eventAttributes(event, false)),
        });
      }
      if (event.ev === "step.end") closeStep(event);
      if (event.ev === "run.end") closeRun(event);
    },
    flush: () => flush(),
    async shutdown(deadlineMs = SHUTDOWN_DEADLINE_MS) {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(new Error("shutdown deadline reached")), deadlineMs);
      const aborted = new Promise<void>((resolve) => controller.signal.addEventListener("abort", () => resolve()));
      await Promise.race([flush(controller.signal), aborted]);
      clearTimeout(deadline);
    },
  };
}
