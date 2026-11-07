import assert from "node:assert/strict";
import test from "node:test";
import { createTelemetry } from "../../src/output/telemetry.ts";
import type { ProviderDeclaration, RecordEvent } from "../../src/types.ts";

type Request = { url: string; headers: Record<string, string>; body: any };

function collector(response: () => Response = () => new Response(null, { status: 200 })) {
  const requests: Request[] = [];
  const send = (async (url: string, init: RequestInit) => {
    requests.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    return response();
  }) as typeof fetch;
  return { requests, send };
}

function captureWarnings<T>(run: (warnings: string[]) => Promise<T>): Promise<T> {
  const warnings: string[] = [];
  const original = console.error;
  console.error = (message: string) => warnings.push(message);
  return run(warnings).finally(() => {
    console.error = original;
  });
}

const RUN = "20261108T000000Z-abcdef";
const TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
const PARENT_SPAN = "b7ad6b7169203331";
const ENDPOINT = { OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" };
const PROVIDERS: Record<string, ProviderDeclaration> = {
  builder: { command: "npx", model: "gpt-6.1-terra" },
  proxied: { command: "npx", model: "m", otel: { providerName: "aws.bedrock" } },
};
const CODEX = { name: "@agentclientprotocol/codex-acp", title: "Codex", version: "2.5.0" };

const at = (second: number) => `2026-11-08T00:00:${String(second).padStart(2, "0")}.000Z`;
const nanos = (iso: string) => String(BigInt(Date.parse(iso)) * 1_000_000n);

const runStart: RecordEvent = { ts: at(0), run: RUN, ev: "run.start", v: 1, agent: "engineer", cwd: "/w", yaml: "/w/agent.yaml", provider: "builder", model: "gpt-6.1-terra", steps: ["build", "check"] };
const buildStart: RecordEvent = { ts: at(1), run: RUN, ev: "step.start", step: "build", index: 0, kind: "model", attempt: 2, provider: "builder", model: "gpt-6.1-terra", servers: ["github"] };
const toolPending: RecordEvent = { ts: at(2), run: RUN, ev: "tool", name: "Bash", status: "pending", step: "build", ms: null, call: "call-1" };
const toolFailed: RecordEvent = { ts: at(5), run: RUN, ev: "tool", name: "Bash", status: "failed", step: "build", ms: 3000, call: "call-1" };
const strandedTool: RecordEvent = { ts: at(6), run: RUN, ev: "tool", name: "Read", status: "pending", step: "build", ms: null, call: "call-2" };
const buildEnd: RecordEvent = {
  ts: at(9), run: RUN, ev: "step.end", step: "build", attempt: 2, outcome: "failure", ms: 8000, exit: null, feedback: "boom",
  session: "sess-1", agent: CODEX, model: "gpt-6.1-terra", usage: { input: 20, output: 10 },
};
const swap: RecordEvent = { ts: at(10), run: RUN, ev: "swap", from_provider: "builder", to_provider: "proxied", from_model: "gpt-6.1-terra", to_model: "m", reason: "provider" };
const transition: RecordEvent = { ts: at(10), run: RUN, ev: "transition", from: "choosingNext", to: "executingScript", decision: "stay", target: "check", why: null };
const checkStart: RecordEvent = { ts: at(11), run: RUN, ev: "step.start", step: "check", index: 1, kind: "script", attempt: 1, provider: null, model: null, servers: [] };
const checkEnd: RecordEvent = { ts: at(12), run: RUN, ev: "step.end", step: "check", attempt: 1, outcome: "failure", ms: 1000, exit: 3, feedback: "exit 3", session: null, agent: null, model: null, usage: null };
const runEnd: RecordEvent = { ts: at(13), run: RUN, ev: "run.end", outcome: "failed", ms: 13000, steps_run: 2, swaps: 1, error: "boom" };
const fullRun = [runStart, buildStart, toolPending, toolFailed, strandedTool, buildEnd, swap, transition, checkStart, checkEnd, runEnd];

const attribute = (holder: { attributes?: any[] }, key: string) => holder.attributes?.find((a) => a.key === key)?.value;
const spansOf = (requests: Request[]) =>
  requests.filter((r) => r.url.endsWith("/v1/traces")).flatMap((r) => r.body.resourceSpans[0].scopeSpans[0].spans);
const logsOf = (requests: Request[]) =>
  requests.filter((r) => r.url.endsWith("/v1/logs")).flatMap((r) => r.body.resourceLogs[0].scopeLogs[0].logRecords);
const spanNamed = (requests: Request[], name: string) => spansOf(requests).find((s) => s.name === name);

async function exportRun(env: NodeJS.ProcessEnv, events: RecordEvent[] = fullRun, providers = PROVIDERS) {
  const { requests, send } = collector();
  const telemetry = createTelemetry({ env: { ...ENDPOINT, ...env }, providers, send })!;
  for (const event of events) telemetry.record(event);
  await telemetry.shutdown();
  return requests;
}

test("telemetry is off unless an OTLP endpoint is set, and OTEL_SDK_DISABLED wins", () => {
  assert.equal(createTelemetry({ env: {} }), null);
  assert.equal(createTelemetry({ env: { ...ENDPOINT, OTEL_SDK_DISABLED: "true" } }), null);
  assert.notEqual(createTelemetry({ env: { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://collector:4318/v1/logs" } }), null);
});

test("a run is one GenAI trace: invoke_workflow, then invoke_agent or a plain step, then execute_tool", async () => {
  const requests = await exportRun({ TRACEPARENT: `00-${TRACE_ID}-${PARENT_SPAN}-01`, TRACESTATE: "vendor=1" });

  const run = spanNamed(requests, "invoke_workflow engineer");
  const agent = spanNamed(requests, "invoke_agent builder");
  const script = spanNamed(requests, "step check");
  const tool = spanNamed(requests, "execute_tool Bash");
  for (const span of [run, agent, script, tool]) {
    assert.ok(span);
    assert.equal(span.traceId, TRACE_ID);
    assert.match(span.spanId, /^[0-9a-f]{16}$/);
  }
  assert.equal(run.parentSpanId, PARENT_SPAN);
  assert.equal(run.traceState, "vendor=1");
  assert.equal(agent.parentSpanId, run.spanId);
  assert.equal(script.parentSpanId, run.spanId);
  assert.equal(tool.parentSpanId, agent.spanId);

  assert.deepEqual([run.kind, agent.kind, script.kind, tool.kind], [1, 3, 1, 1]);
  assert.deepEqual(attribute(run, "gen_ai.operation.name"), { stringValue: "invoke_workflow" });
  assert.deepEqual(attribute(agent, "gen_ai.operation.name"), { stringValue: "invoke_agent" });
  assert.equal(attribute(script, "gen_ai.operation.name"), undefined);
  assert.deepEqual(attribute(tool, "gen_ai.operation.name"), { stringValue: "execute_tool" });

  assert.equal(run.startTimeUnixNano, nanos(at(0)));
  assert.equal(run.endTimeUnixNano, nanos(at(13)));
  assert.equal(agent.startTimeUnixNano, nanos(at(1)));
  assert.equal(agent.endTimeUnixNano, nanos(at(9)));
  assert.equal(tool.startTimeUnixNano, nanos(at(2)));
  assert.equal(tool.endTimeUnixNano, nanos(at(5)));
});

test("span attributes follow the GenAI conventions and keep runner detail under acp.*", async () => {
  const requests = await exportRun({});
  const run = spanNamed(requests, "invoke_workflow engineer");
  const agent = spanNamed(requests, "invoke_agent builder");
  const script = spanNamed(requests, "step check");
  const tool = spanNamed(requests, "execute_tool Bash");

  assert.deepEqual(attribute(run, "gen_ai.agent.name"), { stringValue: "engineer" });
  assert.deepEqual(attribute(run, "acp.run.id"), { stringValue: RUN });
  assert.deepEqual(attribute(run, "acp.run.steps"), { arrayValue: { values: [{ stringValue: "build" }, { stringValue: "check" }] } });
  assert.deepEqual(attribute(run, "acp.run.swaps"), { intValue: "1" });

  assert.deepEqual(attribute(agent, "gen_ai.provider.name"), { stringValue: "openai" });
  assert.deepEqual(attribute(agent, "gen_ai.conversation.id"), { stringValue: "sess-1" });
  assert.deepEqual(attribute(agent, "gen_ai.request.model"), { stringValue: "gpt-6.1-terra" });
  assert.deepEqual(attribute(agent, "gen_ai.usage.input_tokens"), { intValue: "20" });
  assert.deepEqual(attribute(agent, "gen_ai.usage.output_tokens"), { intValue: "10" });
  assert.equal(attribute(agent, "gen_ai.agent.name"), undefined);
  assert.deepEqual(attribute(agent, "acp.agent.name"), { stringValue: CODEX.name });
  assert.deepEqual(attribute(agent, "acp.agent.version"), { stringValue: "2.5.0" });
  assert.deepEqual(attribute(agent, "acp.step.id"), { stringValue: "build" });
  assert.deepEqual(attribute(agent, "acp.step.attempt"), { intValue: "2" });
  assert.deepEqual(attribute(agent, "acp.step.provider"), { stringValue: "builder" });
  assert.deepEqual(attribute(agent, "acp.step.mcp_servers"), { arrayValue: { values: [{ stringValue: "github" }] } });

  assert.deepEqual(attribute(script, "process.exit.code"), { intValue: "3" });
  assert.deepEqual(attribute(tool, "gen_ai.tool.name"), { stringValue: "Bash" });
  assert.deepEqual(attribute(tool, "gen_ai.tool.call.id"), { stringValue: "call-1" });
});

test("failures set ERROR with a documented error.type; success leaves status UNSET; no feedback by default", async () => {
  const requests = await exportRun({});
  const spans = spansOf(requests);
  const byName = (name: string) => spans.find((s) => s.name === name);

  assert.deepEqual(byName("execute_tool Bash").status, { code: 2 });
  assert.deepEqual(attribute(byName("execute_tool Bash"), "error.type"), { stringValue: "_OTHER" });
  assert.deepEqual(attribute(byName("execute_tool Read"), "error.type"), { stringValue: "incomplete" });
  assert.equal(byName("execute_tool Read").endTimeUnixNano, nanos(at(9)));
  assert.deepEqual(attribute(byName("step check"), "error.type"), { stringValue: "exit_nonzero" });
  assert.deepEqual(attribute(byName("invoke_agent builder"), "error.type"), { stringValue: "_OTHER" });
  assert.deepEqual(attribute(byName("invoke_workflow engineer"), "error.type"), { stringValue: "_OTHER" });

  for (const span of spans) assert.equal(span.status.message, undefined);
  const serialized = JSON.stringify(requests.map((r) => r.body));
  assert.doesNotMatch(serialized, /boom|exit 3/);

  const happy = await exportRun({}, [
    runStart,
    buildStart,
    { ...buildEnd, outcome: "success", feedback: null },
    { ...runEnd, outcome: "finished", error: null },
  ]);
  for (const span of spansOf(happy)) {
    assert.deepEqual(span.status, {});
    assert.equal(attribute(span, "error.type"), undefined);
  }
});

test("failure text is exported only when GenAI content capture is switched on", async () => {
  const requests = await exportRun({ OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: "true" });
  const stepEnd = logsOf(requests).find((l) => l.eventName === "acp.step.end" && attribute(l, "acp.step.id")?.stringValue === "build");
  assert.deepEqual(attribute(stepEnd, "acp.step.feedback"), { stringValue: "boom" });
});

test("gen_ai.provider.name: the runbook declaration wins, then the agent's own identity, then the provider id", async () => {
  const declared = await exportRun({}, [
    runStart,
    { ...buildStart, provider: "proxied" },
    { ...buildEnd, agent: { name: "@agentclientprotocol/claude-agent-acp", version: "0.100.0" } },
    runEnd,
  ]);
  assert.deepEqual(attribute(spanNamed(declared, "invoke_agent proxied"), "gen_ai.provider.name"), { stringValue: "aws.bedrock" });

  const identities: Array<[string, string]> = [
    ["@agentclientprotocol/claude-agent-acp", "anthropic"],
    ["@agentclientprotocol/codex-acp", "openai"],
    ["gemini-cli", "gcp.gen_ai"],
  ];
  for (const [name, expected] of identities) {
    const requests = await exportRun({}, [runStart, buildStart, { ...buildEnd, agent: { name, version: "1" } }, runEnd]);
    assert.deepEqual(attribute(spanNamed(requests, "invoke_agent builder"), "gen_ai.provider.name"), { stringValue: expected });
  }

  const unknown = await exportRun({}, [runStart, buildStart, { ...buildEnd, agent: { name: "my-harness", version: "1" } }, runEnd]);
  assert.deepEqual(attribute(spanNamed(unknown, "invoke_agent builder"), "gen_ai.provider.name"), { stringValue: "builder" });
});

test("a provider swap is a span event on the workflow span", async () => {
  const requests = await exportRun({});
  const [event] = spanNamed(requests, "invoke_workflow engineer").events;
  assert.equal(event.name, "acp.provider.swap");
  assert.equal(event.timeUnixNano, nanos(at(10)));
  assert.deepEqual(attribute(event, "acp.swap.to_provider"), { stringValue: "proxied" });
});

test("without a valid TRACEPARENT the workflow span is the root of a fresh trace", async () => {
  for (const env of [{}, { TRACEPARENT: "00-not-a-trace-01" }, { TRACEPARENT: `00-${"0".repeat(32)}-${PARENT_SPAN}-01` }]) {
    const requests = await exportRun(env, [runStart, runEnd]);
    const [run] = spansOf(requests);
    assert.match(run.traceId, /^[0-9a-f]{32}$/);
    assert.notEqual(run.traceId, "0".repeat(32));
    assert.equal(run.parentSpanId, undefined);
  }
});

test("logs stream before spans close: one record per event, tied to the innermost open span", async () => {
  const { requests, send } = collector();
  const telemetry = createTelemetry({ env: ENDPOINT, providers: PROVIDERS, send })!;
  for (const event of [runStart, buildStart, toolPending]) telemetry.record(event);
  await telemetry.flush();

  assert.deepEqual(spansOf(requests), []);
  const early = logsOf(requests);
  assert.deepEqual(early.map((l) => l.eventName), ["acp.run.start", "acp.step.start", "acp.tool"]);
  assert.equal(early[2].timeUnixNano, nanos(at(2)));
  assert.equal(typeof early[2].body.stringValue, "string");
  assert.deepEqual(attribute(early[2], "gen_ai.tool.name"), { stringValue: "Bash" });

  for (const event of fullRun.slice(3)) telemetry.record(event);
  await telemetry.shutdown();

  const agent = spanNamed(requests, "invoke_agent builder");
  const run = spanNamed(requests, "invoke_workflow engineer");
  const logs = logsOf(requests);
  assert.equal(logs.length, fullRun.length);
  assert.equal(logs[2].spanId, agent.spanId);
  assert.equal(logs[2].traceId, agent.traceId);
  assert.equal(logs[0].spanId, run.spanId);

  const severity = (name: string) => logs.find((l) => l.eventName === name);
  assert.deepEqual([severity("acp.run.start").severityNumber, severity("acp.run.start").severityText], [9, "INFO"]);
  assert.deepEqual([severity("acp.step.end").severityNumber, severity("acp.step.end").severityText], [17, "ERROR"]);
  assert.deepEqual([severity("acp.transition").severityNumber, severity("acp.transition").severityText], [5, "DEBUG"]);
});

test("endpoints, headers and resource follow the OTEL_* environment rules", async () => {
  const requests = await exportRun({
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318/",
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://traces.example/otlp/v1/traces",
    OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Basic%20abc%3D, x-scope = shared",
    OTEL_EXPORTER_OTLP_LOGS_HEADERS: "x-scope=logs",
    OTEL_SERVICE_NAME: "engineer",
    OTEL_RESOURCE_ATTRIBUTES: "service.name=ignored,github.run_id=42",
  }, [runStart, runEnd]);

  const traces = requests.find((r) => r.url.includes("traces"))!;
  const logs = requests.find((r) => r.url.endsWith("/v1/logs"))!;
  assert.equal(traces.url, "https://traces.example/otlp/v1/traces");
  assert.equal(logs.url, "http://collector:4318/v1/logs");
  assert.equal(traces.headers["Content-Type"], "application/json");
  assert.equal(traces.headers.Authorization, "Basic abc=");
  assert.equal(traces.headers["x-scope"], "shared");
  assert.equal(logs.headers["x-scope"], "logs");

  const resource = traces.body.resourceSpans[0].resource;
  assert.deepEqual(attribute(resource, "service.name"), { stringValue: "engineer" });
  assert.deepEqual(attribute(resource, "github.run_id"), { stringValue: "42" });
  assert.match(attribute(resource, "service.version").stringValue, /^\d+\.\d+\.\d+/);
  assert.deepEqual(attribute(resource, "process.runtime.name"), { stringValue: process.versions.bun ? "bun" : "node" });
  assert.equal(attribute(resource, "telemetry.sdk.name"), undefined);
  assert.equal(traces.body.resourceSpans[0].scopeSpans[0].scope.name, "acp-runner");
});

test("a failing collector warns once and never throws", async () => {
  await captureWarnings(async (warnings) => {
    const refused = createTelemetry({ env: ENDPOINT, send: (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch })!;
    for (const event of fullRun) refused.record(event);
    await refused.flush();
    for (const event of fullRun) refused.record(event);
    await refused.shutdown();
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /telemetry export failed.*ECONNREFUSED/);
  });

  await captureWarnings(async (warnings) => {
    const { send } = collector(() => new Response("nope", { status: 401 }));
    const unauthorised = createTelemetry({ env: ENDPOINT, send })!;
    unauthorised.record(runStart);
    await unauthorised.shutdown();
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /telemetry export failed.*401/);
  });

  await captureWarnings(async (warnings) => {
    const { send } = collector(() => Response.json({ partialSuccess: { rejectedLogRecords: "2", errorMessage: "too big" } }));
    const partial = createTelemetry({ env: ENDPOINT, send })!;
    partial.record(runStart);
    await partial.shutdown();
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /telemetry export partly rejected.*too big/);
  });
});

test("shutdown gives up at its deadline when the collector hangs", async () => {
  const hung = createTelemetry({ env: ENDPOINT, send: ((_url: string, init: RequestInit) =>
    new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)))) as typeof fetch })!;
  await captureWarnings(async () => {
    for (const event of fullRun) hung.record(event);
    const started = Date.now();
    await hung.shutdown(100);
    assert.ok(Date.now() - started < 1000);
  });
});

test("the queue is bounded: the oldest records are dropped and the drop is reported", async () => {
  await captureWarnings(async (warnings) => {
    const { requests, send } = collector();
    const telemetry = createTelemetry({ env: ENDPOINT, send })!;
    for (let index = 0; index < 2100; index += 1) telemetry.record({ ...toolPending, call: `call-${index}` });
    await telemetry.shutdown();
    const logs = logsOf(requests);
    assert.equal(logs.length, 2048);
    assert.deepEqual(attribute(logs[0], "gen_ai.tool.call.id"), { stringValue: "call-52" });
    assert.match(warnings.join("\n"), /dropped 52 telemetry records/);
  });
});

