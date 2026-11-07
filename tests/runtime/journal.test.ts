import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireLock,
  createJournal,
  inputsHash,
  journalWriter,
  JournalCorrupt,
  readFeedback,
  readJournal,
  releaseLock,
  runbookHash,
  writeFeedback,
  JOURNAL_FILE,
  LOCK_FILE,
} from "../../src/runtime/journal.ts";
import type { RunnerConfig } from "../../src/types.ts";

function stateDir(): string {
  return mkdtempSync(join(tmpdir(), "journal-"));
}

const started = { event: "run_started", v: 1, runbook: "sha256:a", inputs: "sha256:b", runner: "test", cwd: "/w" } as const;

test("journal: a missing or empty file reads as no events", () => {
  const dir = stateDir();
  assert.deepEqual(readJournal(dir), []);
  writeFileSync(join(dir, JOURNAL_FILE), "");
  assert.deepEqual(readJournal(dir), []);
});

test("journal: appends one JSON line per event and reads them back in order", () => {
  const dir = stateDir();
  const write = journalWriter(dir);
  write(started);
  write({ event: "step_started", step: "one", visit: 1 });
  const text = readFileSync(join(dir, JOURNAL_FILE), "utf8");
  assert.equal(text.split("\n").length, 3);
  assert.ok(text.endsWith("\n"));
  assert.deepEqual(readJournal(dir).map((event) => event.event), ["run_started", "step_started"]);
});

test("journal: a torn last line is dropped on read and truncated before the first append", () => {
  const dir = stateDir();
  writeFileSync(join(dir, JOURNAL_FILE), `${JSON.stringify(started)}\n{"event":"step_sta`);
  assert.equal(readJournal(dir).length, 1);
  journalWriter(dir)({ event: "step_started", step: "one", visit: 1 });
  const lines = readFileSync(join(dir, JOURNAL_FILE), "utf8").split("\n");
  assert.deepEqual(lines.slice(0, 2).map((line) => JSON.parse(line).event), ["run_started", "step_started"]);
});

test("journal: a complete line that does not parse is corruption and names the line", () => {
  const dir = stateDir();
  const text = `${JSON.stringify(started)}\nnot json\n`;
  writeFileSync(join(dir, JOURNAL_FILE), text);
  assert.throws(() => readJournal(dir), (error: unknown) => error instanceof JournalCorrupt && /line 2/.test(error.message));
  assert.equal(readFileSync(join(dir, JOURNAL_FILE), "utf8"), text);
});

test("journal: the first line must be run_started with v 1", () => {
  const dir = stateDir();
  writeFileSync(join(dir, JOURNAL_FILE), `${JSON.stringify({ ...started, v: 2 })}\n`);
  assert.throws(() => readJournal(dir), JournalCorrupt);
  writeFileSync(join(dir, JOURNAL_FILE), `${JSON.stringify({ event: "step_started", step: "a", visit: 1 })}\n`);
  assert.throws(() => readJournal(dir), JournalCorrupt);
});

test("journal queue: appends run in order and a failed append fails every later one", async () => {
  const written: string[] = [];
  const journal = createJournal((event) => {
    if (event.event === "step_completed") throw new Error("disk full");
    written.push(event.event);
  });
  await journal.append(started);
  await assert.rejects(journal.append({ event: "step_completed", step: "a", visit: 1, outcome: "success", why: "fallthrough", next: "END" }), /disk full/);
  assert.equal(journal.failed, true);
  await assert.rejects(journal.append({ event: "run_finished", outcome: "finished" }), /journal/);
  assert.deepEqual(written, ["run_started"]);
});

test("lock: acquire records host and group, a live group keeps it busy, a dead group is stale", async () => {
  const dir = stateDir();
  assert.equal(acquireLock(dir, process.pid), "acquired");
  const lock = JSON.parse(readFileSync(join(dir, LOCK_FILE), "utf8"));
  assert.equal(lock.pgid, process.pid);
  assert.equal(typeof lock.host, "string");

  const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  await new Promise((resolve) => child.once("spawn", resolve));
  const other = stateDir();
  assert.equal(acquireLock(other, child.pid!), "acquired");
  assert.equal(acquireLock(other, process.pid), "busy");
  process.kill(-child.pid!, "SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(acquireLock(other, process.pid), "acquired");

  releaseLock(dir, process.pid);
  assert.equal(existsSync(join(dir, LOCK_FILE)), false);
});

test("lock: a lock from another host is refused", () => {
  const dir = stateDir();
  writeFileSync(join(dir, LOCK_FILE), JSON.stringify({ host: "some-other-host", pgid: 1 }));
  assert.equal(acquireLock(dir, process.pid), "other-host");
});

test("feedback: a saved failure reads back from the path the event names", () => {
  const dir = stateDir();
  const failure = { stepId: "validate", kind: "check" as const, source: "check.sh", exitCode: 1, output: "boom" };
  const path = writeFeedback(dir, "validate", 1, failure);
  assert.equal(path, "feedback/validate-1.json");
  assert.deepEqual(readFeedback(dir, path), failure);
  assert.throws(() => readFeedback(dir, "feedback/missing-1.json"));
});

function workflow(files: Record<string, string>, runbook: RunnerConfig["runbook"]): RunnerConfig {
  const dir = mkdtempSync(join(tmpdir(), "runbook-"));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return { yamlPath: join(dir, "agent.yaml"), cwd: dir, runbook };
}

test("runbook hash: covers agent.yaml and prompt and var files, not scripts", () => {
  const config = workflow(
    { "agent.yaml": "steps: []", "prompts/a.md": "Do A", "notes.txt": "n", "check.sh": "exit 0" },
    { vars: { notes: { file: "notes.txt" } }, steps: [{ id: "a", do: { file: "prompts/a.md" }, run: "./check.sh" }] },
  );
  const first = runbookHash(config);
  assert.match(first, /^sha256:[0-9a-f]{64}$/);
  writeFileSync(join(config.cwd, "check.sh"), "exit 1");
  assert.equal(runbookHash(config), first);
  writeFileSync(join(config.cwd, "prompts/a.md"), "Do B");
  assert.notEqual(runbookHash(config), first);
  const second = runbookHash(config);
  writeFileSync(join(config.cwd, "notes.txt"), "m");
  assert.notEqual(runbookHash(config), second);
  const third = runbookHash(config);
  writeFileSync(join(config.cwd, "agent.yaml"), "steps: [] ");
  assert.notEqual(runbookHash(config), third);
});

test("inputs hash: changes with env values and MCP identity, not with secret values", () => {
  const config = workflow({ "agent.yaml": "" }, {
    mcpServers: { tools: { command: "node", args: ["t.mjs"], env: { TOKEN: "${{ secrets.JOURNAL_TEST_SECRET }}" } } },
    steps: [{ id: "a", run: "echo ${{ env.JOURNAL_TEST_ENV }}" }],
  });
  process.env.JOURNAL_TEST_ENV = "one";
  process.env.JOURNAL_TEST_SECRET = "s1";
  const first = inputsHash(config);
  process.env.JOURNAL_TEST_SECRET = "s2";
  assert.equal(inputsHash(config), first);
  process.env.JOURNAL_TEST_ENV = "two";
  assert.notEqual(inputsHash(config), first);
  process.env.JOURNAL_TEST_ENV = "one";
  const moved = { ...config, runbook: { ...config.runbook, mcpServers: { tools: { command: "node", args: ["other.mjs"] } } } };
  assert.notEqual(inputsHash(moved), first);
  delete process.env.JOURNAL_TEST_ENV;
  delete process.env.JOURNAL_TEST_SECRET;
});
