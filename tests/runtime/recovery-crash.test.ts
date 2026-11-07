import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent } from "../../src/runtime/engine.ts";
import { createJournal, journalWriter, readJournal, type JournalEvent } from "../../src/runtime/journal.ts";
import type { AgentYaml, RunnerConfig } from "../../src/types.ts";

const fixturePath = join(fileURLToPath(import.meta.url), "../../fixtures/acp-child.ts");

function project(runbook: (dir: string) => AgentYaml) {
  const dir = mkdtempSync(join(tmpdir(), "recovery-"));
  const capture = join(dir, "capture.jsonl");
  const provider = (extra: string[] = []) => ({ command: "bun", args: [fixturePath, `--capture=${capture}`, ...extra], model: "test-model" });
  const config: RunnerConfig = { yamlPath: join(dir, "agent.yaml"), cwd: dir, runbook: runbook(dir) };
  writeFileSync(config.yamlPath, "steps: []");
  const prompts = () =>
    existsSync(capture) ? readFileSync(capture, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  return { dir, config, provider, prompts };
}

async function runOnce(config: RunnerConfig, dir: string, crashAfter?: (event: JournalEvent) => boolean) {
  const events = readJournal(dir);
  const write = journalWriter(dir);
  let crashed = false;
  const journal = createJournal((event) => {
    if (crashed) throw new Error("injected crash");
    write(event);
    if (crashAfter?.(event)) crashed = true;
  });
  const before = events.length;
  const result = await runAgent({ config, state: { dir, journal, events } });
  return { result, added: readJournal(dir).slice(before) };
}

function names(events: JournalEvent[]): string[] {
  return events.map((event) => ("step" in event ? `${event.event} ${event.step} ${event.visit}` : event.event));
}

test("A2: a runner stopped after implement → validate starts validate visit 1 and does not prompt implement again", async () => {
  const p = project(() => ({
    providers: {},
    steps: [
      { id: "implement", provider: "builder", do: "Implement", on: { success: "validate" } },
      { id: "validate", run: "true" },
    ],
  }));
  p.config.runbook.providers = { builder: p.provider() };
  const first = await runOnce(p.config, p.dir, (event) => event.event === "step_completed");
  assert.equal(first.result.outcome, "stopped");
  assert.equal(p.prompts().length, 1);
  const second = await runOnce(p.config, p.dir);
  assert.equal(second.result.outcome, "finished");
  assert.deepEqual(names(second.added), ["step_started validate 1", "step_completed validate 1", "run_finished"]);
  assert.equal(p.prompts().length, 1);
});

test("recovery: a terminal journal exits with the recorded outcome and runs nothing", async () => {
  const p = project(() => ({ steps: [{ id: "only", run: "false" }] }));
  const first = await runOnce(p.config, p.dir);
  assert.equal(first.result.outcome, "failed");
  const second = await runOnce(p.config, p.dir);
  assert.equal(second.result.outcome, "failed");
  assert.deepEqual(second.added, []);
});

test("recovery: a crash after a terminal step_completed writes run_finished", async () => {
  const p = project(() => ({ steps: [{ id: "only", run: "true", on: { success: "END" } }] }));
  await runOnce(p.config, p.dir, (event) => event.event === "step_completed");
  const second = await runOnce(p.config, p.dir);
  assert.equal(second.result.outcome, "finished");
  assert.deepEqual(names(second.added), ["run_finished"]);
});

test("recovery: an open script visit runs the script again under the same visit", async () => {
  const p = project((dir) => ({
    steps: [{ id: "count", run: `sh -c 'echo x >> "${join(dir, "runs")}"'` }],
  }));
  await runOnce(p.config, p.dir, (event) => event.event === "step_started");
  const second = await runOnce(p.config, p.dir);
  assert.equal(second.result.outcome, "finished");
  assert.deepEqual(names(second.added), ["step_completed count 1", "run_finished"]);
  assert.equal(readFileSync(join(p.dir, "runs"), "utf8"), "x\nx\n");
});

test("recovery: a completed turn runs only the check again and does not prompt", async () => {
  const p = project(() => ({
    providers: {},
    steps: [{ id: "work", provider: "builder", do: "Work", run: "true" }],
  }));
  p.config.runbook.providers = { builder: p.provider() };
  await runOnce(p.config, p.dir, (event) => event.event === "prompt_completed");
  assert.equal(p.prompts().length, 1);
  const second = await runOnce(p.config, p.dir);
  assert.equal(second.result.outcome, "finished");
  assert.deepEqual(names(second.added), ["step_completed work 1", "run_finished"]);
  assert.equal(p.prompts().length, 1);
});

test("recovery: an open visit with no session yet opens a new one and prompts", async () => {
  const p = project(() => ({
    providers: {},
    steps: [{ id: "work", provider: "builder", do: "Work" }],
  }));
  p.config.runbook.providers = { builder: p.provider() };
  await runOnce(p.config, p.dir, (event) => event.event === "step_started");
  const second = await runOnce(p.config, p.dir);
  assert.equal(second.result.outcome, "finished");
  assert.deepEqual(names(second.added), ["session_attached work 1", "prompt_sent work 1", "prompt_completed work 1", "step_completed work 1", "run_finished"]);
});

test("recovery: pending feedback from the journal reaches the next prompt", async () => {
  const p = project((dir) => ({
    providers: {},
    steps: [
      { id: "validate", run: `sh -c 'test -f "${join(dir, "ok")}" || { echo saved-feedback-text; exit 1; }'`, on: { failure: "implement" } },
      { id: "implement", provider: "builder", do: "Implement" },
    ],
  }));
  p.config.runbook.providers = { builder: p.provider() };
  await runOnce(p.config, p.dir, (event) => event.event === "step_completed");
  const second = await runOnce(p.config, p.dir);
  assert.equal(second.result.outcome, "finished");
  const sent = second.added.find((event) => event.event === "prompt_sent") as { feedback?: string };
  assert.equal(sent.feedback, "feedback/validate-1.json");
  assert.match(JSON.stringify(p.prompts()[0].prompt), /saved-feedback-text/);
});

function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return fn().finally(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function calls(dir: string): Array<{ method: string; sessionId?: string }> {
  const path = join(dir, "calls.jsonl");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
}

function builderProject(steps: AgentYaml["steps"]) {
  const p = project(() => ({ steps }));
  p.config.runbook.providers = { builder: p.provider() };
  return p;
}

const passback: AgentYaml["steps"] = [
  { id: "implement", provider: "builder", do: "Implement", on: { success: "validate" } },
  { id: "validate", run: "sh -c 'test -f ok || { echo validate-feedback-text; touch ok; exit 1; }'", on: { failure: "implement" } },
];

test("A1: a stop after session_attached reopens that session and sends the step prompt, with no new step_started or session/new", async () => {
  const p = builderProject([{ id: "implement", provider: "builder", do: "Implement" }]);
  await withEnv({ ACP_FIXTURE_REOPEN: "resume", ACP_FIXTURE_CALLS: join(p.dir, "calls.jsonl") }, async () => {
    await runOnce(p.config, p.dir, (event) => event.event === "session_attached");
    const sessionId = (readJournal(p.dir).find((event) => event.event === "session_attached") as { sessionId: string }).sessionId;
    const before = calls(p.dir).length;
    const second = await runOnce(p.config, p.dir);
    assert.equal(second.result.outcome, "finished");
    assert.deepEqual(names(second.added).slice(0, 2), ["session_resumed implement 1", "prompt_sent implement 1"]);
    const resumed = second.added[0] as { sessionId: string; method: string };
    assert.equal(resumed.sessionId, sessionId);
    assert.equal(resumed.method, "session/resume");
    assert.equal((second.added[1] as { kind: string }).kind, "step");
    const methods = calls(p.dir).slice(before);
    assert.deepEqual(methods.map((call) => call.method), ["initialize", "session/resume", "session/prompt"]);
    assert.equal(methods[1].sessionId, sessionId);
  });
});

test("A4: feedback saved before a stop goes to the reopened active session in the next implement visit", async () => {
  const p = builderProject(passback);
  await withEnv({ ACP_FIXTURE_REOPEN: "load", ACP_FIXTURE_CALLS: join(p.dir, "calls.jsonl") }, async () => {
    await runOnce(p.config, p.dir, (event) => event.event === "step_completed" && event.step === "validate");
    const second = await runOnce(p.config, p.dir);
    assert.equal(second.result.outcome, "finished");
    assert.deepEqual(names(second.added).slice(0, 4), [
      "step_started implement 2", "session_attached implement 2", "session_resumed implement 2", "prompt_sent implement 2",
    ]);
    assert.equal((second.added[1] as { origin: string }).origin, "carried");
    assert.equal((second.added[3] as { feedback?: string }).feedback, "feedback/validate-1.json");
    assert.match(JSON.stringify(p.prompts()[1].prompt), /validate-feedback-text/);
    assert.ok(!calls(p.dir).some((call, index) => index > 2 && call.method === "session/new"));
  });
});

test("A5a: an unavailable session with origin new and no prompt sent opens a new session and continues", async () => {
  const p = builderProject([{ id: "implement", provider: "builder", do: "Implement" }]);
  await runOnce(p.config, p.dir, (event) => event.event === "session_attached");
  await withEnv({ ACP_FIXTURE_REOPEN: "resume", ACP_FIXTURE_REOPEN_ERROR: "not-found" }, async () => {
    const second = await runOnce(p.config, p.dir);
    assert.equal(second.result.outcome, "finished");
    assert.equal(names(second.added)[0], "session_attached implement 1");
    assert.equal((second.added[0] as { origin: string }).origin, "new");
  });
});

test("A5b: an unavailable carried session with no prompt sent ends the run as unknown", async () => {
  const p = builderProject(passback);
  await runOnce(p.config, p.dir, (event) => event.event === "session_attached" && event.visit === 2);
  await withEnv({ ACP_FIXTURE_REOPEN: "resume", ACP_FIXTURE_REOPEN_ERROR: "not-found" }, async () => {
    const second = await runOnce(p.config, p.dir);
    assert.equal(second.result.outcome, "unknown");
    assert.deepEqual(second.added, [{ event: "run_finished", outcome: "unknown", reason: "session_unavailable" }]);
  });
});

test("A5c: a reopen that needs a login, or an agent that does not spawn, stops the run and leaves the journal unchanged", async () => {
  const p = builderProject([{ id: "implement", provider: "builder", do: "Implement" }]);
  await runOnce(p.config, p.dir, (event) => event.event === "session_attached");
  await withEnv({ ACP_FIXTURE_REOPEN: "resume", ACP_FIXTURE_REOPEN_ERROR: "auth" }, async () => {
    const second = await runOnce(p.config, p.dir);
    assert.equal(second.result.outcome, "stopped");
    assert.deepEqual(second.added, []);
  });
  await withEnv({ ACP_FIXTURE_MODE: "crash-on-start" }, async () => {
    const third = await runOnce(p.config, p.dir);
    assert.equal(third.result.outcome, "stopped");
    assert.deepEqual(third.added, []);
  });
});

test("A5d: a stop after prompt_sent reopens the session and resends the prompt and feedback once; a stop during the resend ends as resend_interrupted", async () => {
  const p = builderProject(passback);
  await withEnv({ ACP_FIXTURE_REOPEN: "resume" }, async () => {
    await runOnce(p.config, p.dir, (event) => event.event === "prompt_sent" && event.visit === 2);
    assert.equal(p.prompts().length, 2);
    const second = await runOnce(p.config, p.dir, (event) => event.event === "prompt_sent");
    assert.equal(second.result.outcome, "stopped");
    assert.deepEqual(names(second.added), ["session_resumed implement 2", "prompt_sent implement 2"]);
    const resend = second.added[1] as { kind: string; feedback?: string };
    assert.equal(resend.kind, "resend");
    assert.equal(resend.feedback, "feedback/validate-1.json");
    const prompt = p.prompts()[2].prompt as Array<{ text: string }>;
    assert.equal(prompt.length, 3);
    assert.match(prompt[0].text, /interrupted/);
    assert.equal(prompt[1].text, "Implement");
    assert.match(prompt[2].text, /validate-feedback-text/);
    const third = await runOnce(p.config, p.dir);
    assert.equal(third.result.outcome, "unknown");
    assert.deepEqual(third.added, [{ event: "run_finished", outcome: "unknown", reason: "resend_interrupted" }]);
    assert.equal(p.prompts().length, 3);
  });
});

test("A5e: a stop after prompt_sent with the session unavailable ends as unknown and sends nothing", async () => {
  const p = builderProject([{ id: "implement", provider: "builder", do: "Implement" }]);
  await runOnce(p.config, p.dir, (event) => event.event === "prompt_sent");
  await withEnv({ ACP_FIXTURE_REOPEN: "resume", ACP_FIXTURE_REOPEN_ERROR: "not-found" }, async () => {
    const second = await runOnce(p.config, p.dir);
    assert.equal(second.result.outcome, "unknown");
    assert.deepEqual(second.added, [{ event: "run_finished", outcome: "unknown", reason: "session_unavailable" }]);
    assert.equal(p.prompts().length, 1);
  });
});

test("A17: an agent that dies during a live prompt stops with no step_completed, and the next runner resends", async () => {
  const p = builderProject([{ id: "implement", provider: "builder", do: "Implement" }]);
  await withEnv({ ACP_FIXTURE_MODE: "exit-during-prompt" }, async () => {
    const first = await runOnce(p.config, p.dir);
    assert.equal(first.result.outcome, "stopped");
    assert.ok(!readJournal(p.dir).some((event) => event.event === "step_completed"));
  });
  await withEnv({ ACP_FIXTURE_REOPEN: "resume" }, async () => {
    const second = await runOnce(p.config, p.dir);
    assert.equal(second.result.outcome, "finished");
    assert.deepEqual(names(second.added).slice(0, 2), ["session_resumed implement 1", "prompt_sent implement 1"]);
    assert.equal((second.added[1] as { kind: string }).kind, "resend");
  });
});
