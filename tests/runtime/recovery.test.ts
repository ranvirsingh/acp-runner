import assert from "node:assert/strict";
import test from "node:test";
import { recover } from "../../src/runtime/recovery.ts";
import type { JournalEvent } from "../../src/runtime/journal.ts";
import type { AgentStep, RunnerConfig } from "../../src/types.ts";

const steps: AgentStep[] = [
  { id: "implement", provider: "builder", do: "Implement", on: { success: "validate" } },
  { id: "validate", run: "true", on: { failure: "implement" } },
  { id: "reads", provider: "builder", do: "Use {{doc}}", vars: { doc: { resource: "doc://x", mcpServer: "docs" } } },
  { id: "review", provider: "reviewer", do: "Review" },
];
const config: RunnerConfig = { yamlPath: "/w/agent.yaml", cwd: "/w", runbook: { steps } };
const always = () => false;

const started: JournalEvent = { event: "run_started", v: 1, runbook: "sha256:a", inputs: "sha256:b", runner: "t", cwd: "/w" };
const begin = (step: string, visit = 1): JournalEvent => ({ event: "step_started", step, visit });
const attach = (step: string, visit = 1, origin: "new" | "carried" = "new", sessionId = "sess_abc", provider = "builder"): JournalEvent =>
  ({ event: "session_attached", step, visit, provider, sessionId, origin });
const sent = (step: string, visit = 1, kind: "step" | "resend" = "step", feedback?: string): JournalEvent =>
  ({ event: "prompt_sent", step, visit, sessionId: "sess_abc", kind, ...(feedback ? { feedback } : {}) });
const replied = (step: string, visit = 1, feedback?: string): JournalEvent =>
  ({ event: "prompt_completed", step, visit, stopReason: "end_turn", ...(feedback ? { feedback } : {}) });
const done = (step: string, visit: number, next: string, extra: Partial<Extract<JournalEvent, { event: "step_completed" }>> = {}): JournalEvent =>
  ({ event: "step_completed", step, visit, outcome: "success", why: "on.success", next, ...extra });

test("recover: no events is a new run", () => {
  assert.deepEqual(recover([], config, always).next, { action: "new" });
});

test("recover: run_finished repeats the recorded outcome", () => {
  const result = recover([started, { event: "run_finished", outcome: "unknown", reason: "tool_in_doubt" }], config, always);
  assert.deepEqual(result.next, { action: "done", outcome: "unknown", reason: "tool_in_doubt" });
});

test("recover: only run_started starts the first step as visit 1", () => {
  assert.deepEqual(recover([started], config, always).next, { action: "start", stepIndex: 0 });
});

test("recover: a terminal step_completed finishes the run with the matching outcome", () => {
  assert.deepEqual(recover([started, begin("implement"), done("implement", 1, "END")], config, always).next, { action: "finish", outcome: "finished" });
  assert.deepEqual(
    recover([started, begin("implement"), done("implement", 1, "FAIL", { outcome: "failure", why: null })], config, always).next,
    { action: "finish", outcome: "failed" },
  );
});

test("recover: step_completed with a step id starts that step as a new visit (A2)", () => {
  const result = recover([started, begin("implement"), attach("implement"), sent("implement"), replied("implement"), done("implement", 1, "validate")], config, always);
  assert.deepEqual(result.next, { action: "start", stepIndex: 1 });
  assert.deepEqual(result.active, { provider: "builder", sessionId: "sess_abc" });
  assert.equal(result.visits.implement, 1);
});

test("recover: visits, loop counts, pending feedback and active session after a passback (8.2)", () => {
  const events = [
    started, begin("implement"), attach("implement"), sent("implement"), replied("implement"), done("implement", 1, "validate"),
    begin("validate"), done("validate", 1, "implement", { outcome: "failure", why: "on.failure", feedback: "feedback/validate-1.json" }),
  ];
  const result = recover(events, config, always);
  assert.deepEqual(result.next, { action: "start", stepIndex: 0 });
  assert.deepEqual(result.loopCounts, { "implement->validate": 1, "validate->implement": 1 });
  assert.equal(result.feedback, "feedback/validate-1.json");
  assert.deepEqual(result.active, { provider: "builder", sessionId: "sess_abc" });
  assert.equal(result.provider, "builder");
});

test("recover: feedback is consumed at prompt_completed, not at prompt_sent", () => {
  const base = [
    started, begin("validate"), done("validate", 1, "implement", { outcome: "failure", why: "on.failure", feedback: "feedback/validate-1.json" }),
    begin("implement", 1), attach("implement"), sent("implement", 1, "step", "feedback/validate-1.json"),
  ];
  assert.equal(recover(base, config, always).feedback, "feedback/validate-1.json");
  assert.equal(recover([...base, replied("implement", 1, "feedback/validate-1.json")], config, always).feedback, undefined);
});

test("recover: terminal targets and fallback edges add no loop count", () => {
  const events = [
    started,
    begin("validate"), done("validate", 1, "implement", { outcome: "failure", why: "fallback" }),
    begin("implement"), done("implement", 1, "validate", { why: "maxAttempts" }),
    begin("validate", 2), done("validate", 2, "END", { why: "on.success" }),
  ];
  assert.deepEqual(recover(events, config, always).loopCounts, {});
});

test("recover: a retry to the same step counts as a loop and the next visit is a new number", () => {
  const events = [started, begin("validate"), done("validate", 1, "validate", { outcome: "failure", why: "on.failure", feedback: "feedback/validate-1.json" })];
  const result = recover(events, config, always);
  assert.deepEqual(result.loopCounts, { "validate->validate": 1 });
  assert.deepEqual(result.next, { action: "start", stepIndex: 1 });
  assert.equal(result.visits.validate, 1);
});

test("recover: a swap clears the active session", () => {
  const events = [started, begin("implement"), attach("implement"), done("implement", 1, "review", { swap: true })];
  const result = recover(events, config, always);
  assert.equal(result.active, undefined);
  assert.equal(result.provider, "reviewer");
});

test("recover: an open script visit runs the script again", () => {
  assert.deepEqual(recover([started, begin("validate")], config, always).next, { action: "continue", stepIndex: 1, visit: 1, mode: "rerun" });
});

test("recover: an open agent visit with no prompt sent prompts with the attached session", () => {
  assert.deepEqual(recover([started, begin("implement")], config, always).next, { action: "continue", stepIndex: 0, visit: 1, mode: "prompt" });
  assert.deepEqual(recover([started, begin("implement"), attach("implement")], config, always).next, {
    action: "continue", stepIndex: 0, visit: 1, mode: "prompt", attached: { provider: "builder", sessionId: "sess_abc", origin: "new" },
  });
});

test("recover: an open turn of kind step is resent, an open resend is interrupted", () => {
  const open = [started, begin("implement"), attach("implement"), sent("implement")];
  assert.deepEqual(recover(open, config, always).next, { action: "continue", stepIndex: 0, visit: 1, mode: "resend" });
  const resumed: JournalEvent = { event: "session_resumed", step: "implement", visit: 1, provider: "builder", sessionId: "sess_abc", method: "session/resume" };
  assert.deepEqual(recover([...open, resumed], config, always).next, { action: "continue", stepIndex: 0, visit: 1, mode: "resend" });
  assert.deepEqual(recover([...open, resumed, sent("implement", 1, "resend")], config, always).next, { action: "unknown", reason: "resend_interrupted" });
});

test("recover: a completed turn runs the check again", () => {
  assert.deepEqual(
    recover([started, begin("implement"), attach("implement"), sent("implement"), replied("implement")], config, always).next,
    { action: "continue", stepIndex: 0, visit: 1, mode: "check" },
  );
});

test("recover: a step that reads MCP resources stops once a prompt went out", () => {
  const events = [started, begin("reads"), attach("reads"), sent("reads")];
  assert.deepEqual(recover(events, config, always).next, { action: "unknown", reason: "inputs_unrecoverable" });
  assert.equal(recover([started, begin("reads"), attach("reads")], config, always).next.action, "continue");
});

test("recover: an unfinished tool call is in doubt unless the tool is idempotent", () => {
  const events: JournalEvent[] = [
    started, begin("implement"), attach("implement"), sent("implement"),
    { event: "tool_started", step: "implement", visit: 1, call: 1, server: "gh", tool: "comment" },
    { event: "tool_completed", step: "implement", visit: 1, call: 1, isError: false },
    { event: "tool_started", step: "implement", visit: 1, call: 2, server: "gh", tool: "label" },
  ];
  assert.deepEqual(recover(events, config, always).next, { action: "unknown", reason: "tool_in_doubt" });
  const result = recover(events, config, (server, tool) => server === "gh" && tool === "label");
  assert.equal(result.next.action, "continue");
  assert.equal(result.calls, 2);
});
