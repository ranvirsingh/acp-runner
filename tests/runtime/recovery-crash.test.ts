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
