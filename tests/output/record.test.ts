import assert from "node:assert/strict";
import test from "node:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRunId, RunRecorder, truncateFeedback } from "../../src/output/record.ts";
import { runCli } from "../helpers/run-cli.ts";
import type {
  RecordEvent,
  RunEndEvent,
  RunnerConfig,
  RunStartEvent,
  StepEndEvent,
  StepStartEvent,
  ToolEvent,
  TransitionEvent,
} from "../../src/types.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function findRunFile(dir: string): string {
  const runnerDir = join(dir, ".runner");
  const files = readdirSync(runnerDir).filter((f) => f.startsWith("run-") && f.endsWith(".jsonl"));
  assert.equal(files.length, 1);
  return join(runnerDir, files[0]);
}

function readEvents(dir: string): RecordEvent[] {
  const file = findRunFile(dir);
  const content = readFileSync(file, "utf8");
  return content
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

test("createRunId: generates sortable timestamp id format", () => {
  const id = createRunId(new Date("2026-09-01T08:19:54.000Z"));
  assert.match(id, /^20260901T081954Z-[a-f0-9]{6}$/);
});

test("truncateFeedback: trims at 2000 bytes and flags feedback_truncated", () => {
  assert.deepEqual(truncateFeedback("short text"), { feedback: "short text" });
  assert.deepEqual(truncateFeedback(undefined), { feedback: null });

  const longText = "a".repeat(2500);
  const result = truncateFeedback(longText, 2000);
  assert.equal(result.feedback?.length, 2000);
  assert.equal(result.truncated, true);
});

test("1. completed run writes file starting with run.start and ending with run.end finished", () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-rec-"));
  const yamlPath = join(dir, "agent.yaml");
  writeFileSync(
    yamlPath,
    "name: test-agent\nsteps:\n  - id: step-one\n    run: echo hello\n",
  );
  try {
    const result = runCli([yamlPath, "--cwd", dir, "--trace", "file"]);
    assert.equal(result.status, 0);

    const events = readEvents(dir);
    assert.ok(events.length >= 2);

    const first = events[0] as RunStartEvent;
    assert.equal(first.ev, "run.start");
    assert.equal(first.v, 1);
    assert.equal(first.agent, "test-agent");
    assert.equal(first.cwd, dir);
    assert.deepEqual(first.steps, ["step-one"]);

    const last = events[events.length - 1] as RunEndEvent;
    assert.equal(last.ev, "run.end");
    assert.equal(last.outcome, "finished");
    assert.equal(typeof last.ms, "number");
    assert.equal(last.steps_run, 1);
    assert.equal(last.error, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("2. every step.start has a matching step.end with the same step and attempt", () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-rec-"));
  const yamlPath = join(dir, "agent.yaml");
  writeFileSync(
    yamlPath,
    "steps:\n  - id: s1\n    run: echo 1\n  - id: s2\n    run: echo 2\n",
  );
  try {
    const result = runCli([yamlPath, "--cwd", dir, "--trace", "file"]);
    assert.equal(result.status, 0);

    const events = readEvents(dir);
    const starts = events.filter((e): e is StepStartEvent => e.ev === "step.start");
    const ends = events.filter((e): e is StepEndEvent => e.ev === "step.end");

    assert.equal(starts.length, 2);
    assert.equal(ends.length, 2);

    assert.equal(starts[0].step, "s1");
    assert.equal(starts[0].attempt, 1);
    assert.equal(ends[0].step, "s1");
    assert.equal(ends[0].attempt, 1);
    assert.equal(ends[0].outcome, "success");

    assert.equal(starts[1].step, "s2");
    assert.equal(starts[1].attempt, 1);
    assert.equal(ends[1].step, "s2");
    assert.equal(ends[1].attempt, 1);
    assert.equal(ends[1].outcome, "success");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("3. a run that loops twice through a gate emits attempt 1, 2, 3 for the retried step", () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-rec-"));
  const yamlPath = join(dir, "agent.yaml");
  const countFile = join(dir, "count.txt");
  writeFileSync(
    yamlPath,
    `steps:
  - id: gate
    run: node -e 'const fs=require("fs"); const c=Number(fs.existsSync("${countFile}")?fs.readFileSync("${countFile}","utf8"):0)+1; fs.writeFileSync("${countFile}",String(c)); process.exit(c>=3?0:1)'
    on:
      failure:
        target: gate
        maxAttempts: 3
`,
  );
  try {
    const result = runCli([yamlPath, "--cwd", dir, "--trace", "file"]);
    assert.equal(result.status, 0);

    const events = readEvents(dir);
    const starts = events.filter((e): e is StepStartEvent => e.ev === "step.start" && e.step === "gate");
    const ends = events.filter((e): e is StepEndEvent => e.ev === "step.end" && e.step === "gate");

    assert.equal(starts.length, 3);
    assert.equal(ends.length, 3);

    assert.deepEqual(
      starts.map((s) => s.attempt),
      [1, 2, 3],
    );
    assert.deepEqual(
      ends.map((e) => e.attempt),
      [1, 2, 3],
    );
    assert.deepEqual(
      ends.map((e) => e.outcome),
      ["failure", "failure", "success"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("4. a step whose command exits non-zero emits step.end with that exit code and non-null feedback", () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-rec-"));
  const yamlPath = join(dir, "agent.yaml");
  writeFileSync(
    yamlPath,
    "steps:\n  - id: fail-step\n    run: node -e 'console.error(\"bad error\"); process.exit(42)'\n",
  );
  try {
    const result = runCli([yamlPath, "--cwd", dir, "--trace", "file"]);
    assert.equal(result.status, 1);

    const events = readEvents(dir);
    const ends = events.filter((e): e is StepEndEvent => e.ev === "step.end");
    assert.equal(ends.length, 1);
    assert.equal(ends[0].outcome, "failure");
    assert.equal(ends[0].exit, 42);
    assert.match(ends[0].feedback ?? "", /bad error/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("5. feedback longer than 2000 bytes is truncated and flagged", () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-rec-"));
  const yamlPath = join(dir, "agent.yaml");
  writeFileSync(
    yamlPath,
    "steps:\n  - id: big-output\n    run: node -e 'console.error(\"x\".repeat(3000)); process.exit(1)'\n",
  );
  try {
    const result = runCli([yamlPath, "--cwd", dir, "--trace", "file"]);
    assert.equal(result.status, 1);

    const events = readEvents(dir);
    const end = events.find((e): e is StepEndEvent => e.ev === "step.end");
    assert.ok(end);
    assert.equal(end.feedback?.length, 2000);
    assert.equal(end.feedback_truncated, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("6. a run that fails leaves a file ending in run.end with outcome failed and non-null error", () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-rec-"));
  const yamlPath = join(dir, "agent.yaml");
  writeFileSync(
    yamlPath,
    "steps:\n  - id: failing\n    run: node -e 'process.exit(1)'\n",
  );
  try {
    const result = runCli([yamlPath, "--cwd", dir, "--trace", "file"]);
    assert.equal(result.status, 1);

    const events = readEvents(dir);
    const last = events[events.length - 1] as RunEndEvent;
    assert.equal(last.ev, "run.end");
    assert.equal(last.outcome, "failed");
    assert.ok(last.error);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("7. a record file killed mid-run is still valid NDJSON up to the last complete line", () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-rec-"));
  const yamlPath = join(dir, "agent.yaml");
  writeFileSync(
    yamlPath,
    "steps:\n  - id: slow\n    run: node -e 'setTimeout(() => {}, 10000)'\n",
  );
  try {
    runCli([yamlPath, "--cwd", dir, "--trace", "file"], { cwd: root, timeout: 1000 });
    const file = findRunFile(dir);
    const content = readFileSync(file, "utf8");
    const lines = content.trim().split("\n");
    assert.ok(lines.length >= 1);
    for (const line of lines) {
      assert.doesNotThrow(() => JSON.parse(line));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("8. with --trace file, stdout is the human log and carries no NDJSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-rec-"));
  const yamlPath = join(dir, "agent.yaml");
  writeFileSync(
    yamlPath,
    "name: agent-one\nsteps:\n  - id: echo\n    run: echo ok\n",
  );
  try {
    const result = runCli([yamlPath, "--cwd", dir, "--trace", "file"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /\[runner\] agent-one provider=claude/);
    assert.match(result.stdout, /\[runner\] finished/);
    assert.doesNotMatch(result.stdout, /\{"ts":/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("9. with --trace off, no .runner/ directory is created and stdout stays human", () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-rec-"));
  const yamlPath = join(dir, "agent.yaml");
  writeFileSync(
    yamlPath,
    "steps:\n  - id: step\n    run: echo hello\n",
  );
  try {
    const result = runCli(["--trace", "off", yamlPath, "--cwd", dir]);
    assert.equal(result.status, 0);
    assert.equal(existsSync(join(dir, ".runner")), false);
    assert.match(result.stdout, /\[runner\] finished/);
    assert.doesNotMatch(result.stdout, /\{"ts":/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("9b. the default writes no .runner/ directory, because the trace goes to stdout", () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-rec-"));
  const yamlPath = join(dir, "agent.yaml");
  writeFileSync(
    yamlPath,
    "steps:\n  - id: step\n    run: echo hello\n",
  );
  try {
    const result = runCli([yamlPath, "--cwd", dir]);
    assert.equal(result.status, 0);
    assert.equal(existsSync(join(dir, ".runner")), false);
    assert.match(result.stdout, /\{"ts":/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("9c. with --trace both, the same events reach stdout and the file", () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-rec-"));
  const yamlPath = join(dir, "agent.yaml");
  writeFileSync(
    yamlPath,
    "steps:\n  - id: step\n    run: echo hello\n",
  );
  try {
    const result = runCli([yamlPath, "--cwd", dir, "--trace", "both"]);
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), readFileSync(findRunFile(dir), "utf8").trim());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("10. an unwritable workspace warns on stderr and the run still completes", () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-rec-"));
  const yamlPath = join(dir, "agent.yaml");
  writeFileSync(
    yamlPath,
    "steps:\n  - id: step\n    run: echo hello\n",
  );
  const lockedDir = join(dir, "locked");
  mkdirSync(lockedDir, { recursive: true });
  chmodSync(lockedDir, 0o555);
  try {
    const result = runCli([yamlPath, "--cwd", lockedDir, "--trace", "file"]);
    assert.equal(result.status, 0);
    assert.match(result.stderr, /warning: could not write run record/);
  } finally {
    chmodSync(lockedDir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--trace stdout streams NDJSON events to stdout and suppresses human logs", () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-rec-"));
  const yamlPath = join(dir, "agent.yaml");
  writeFileSync(
    yamlPath,
    "steps:\n  - id: step\n    run: echo hello\n",
  );
  try {
    const result = runCli(["--trace", "stdout", yamlPath, "--cwd", dir]);
    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout, /\[runner\]/);
    assert.doesNotMatch(result.stdout, /\[state\]/);

    const lines = result.stdout.trim().split("\n");
    assert.ok(lines.length >= 2);
    for (const line of lines) {
      assert.doesNotThrow(() => JSON.parse(line));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RunRecorder: records tool call pending and completed events with duration", () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-rec-"));
  const config: RunnerConfig = {
    yamlPath: join(dir, "agent.yaml"),
    cwd: dir,
    trace: "file",
    runbook: {
      steps: [{ id: "step1", do: "Fetch data" }],
    },
  };
  try {
    const recorder = new RunRecorder(config);
    recorder.start();

    recorder.handleInspect({
      type: "runner.event",
      event: {
        type: "UPDATE",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call_1",
          name: "mcp__meera__fetch_usage",
        },
      },
    });

    recorder.handleInspect({
      type: "runner.event",
      event: {
        type: "UPDATE",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call_1",
          status: "completed",
        },
      },
    });

    recorder.end("finished");

    const events = readEvents(dir);
    const tools = events.filter((e): e is ToolEvent => e.ev === "tool");
    assert.equal(tools.length, 2);
    assert.equal(tools[0].name, "mcp__meera__fetch_usage");
    assert.equal(tools[0].status, "pending");
    assert.equal(tools[0].ms, null);

    assert.equal(tools[1].name, "mcp__meera__fetch_usage");
    assert.equal(tools[1].status, "completed");
    assert.equal(typeof tools[1].ms, "number");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a run that fails to spawn records step.end with failure outcome and matches run.end", () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-rec-"));
  const yamlPath = join(dir, "agent.yaml");
  writeFileSync(
    yamlPath,
    "provider: broken\nproviders:\n  onSpawnError: fail\n  agentHarness:\n    broken:\n      command: acp-runner-no-such-binary-9f3a\nsteps:\n  - id: report\n    do: Say hello\n",
  );
  try {
    const result = runCli([yamlPath, "--cwd", dir, "--trace", "file"]);
    assert.equal(result.status, 1);

    const events = readEvents(dir);
    const starts = events.filter((e): e is StepStartEvent => e.ev === "step.start");
    const ends = events.filter((e): e is StepEndEvent => e.ev === "step.end");
    const last = events[events.length - 1] as RunEndEvent;

    assert.equal(starts.length, 1);
    assert.equal(starts[0].step, "report");
    assert.equal(starts[0].attempt, 1);

    assert.equal(ends.length, 1);
    assert.equal(ends[0].step, "report");
    assert.equal(ends[0].attempt, 1);
    assert.equal(ends[0].outcome, "failure");
    assert.ok(ends[0].feedback);

    assert.equal(last.ev, "run.end");
    assert.equal(last.outcome, "failed");
    assert.ok(last.error);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a transition why is null unless a declared on edge caused it", () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-rec-"));
  const yamlPath = join(dir, "agent.yaml");
  writeFileSync(
    yamlPath,
    "steps:\n  - id: failing\n    run: node -e 'process.exit(1)'\n",
  );
  try {
    const result = runCli([yamlPath, "--cwd", dir, "--trace", "file"]);
    assert.equal(result.status, 1);

    const events = readEvents(dir);
    const transitions = events.filter((e): e is TransitionEvent => e.ev === "transition");
    const choosingTransition = transitions.find((t) => t.from === "choosingNext");
    assert.ok(choosingTransition);
    assert.equal(choosingTransition.decision, "fail");
    assert.equal(choosingTransition.why, null);
    assert.equal(choosingTransition.target, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("why is fallback only when maxAttempts was exceeded and a fallback target exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-rec-"));
  const yamlPath = join(dir, "agent.yaml");
  writeFileSync(
    yamlPath,
    `steps:
  - id: failing
    run: node -e 'process.exit(1)'
    on:
      failure:
        target: failing
        maxAttempts: 1
        fallback: recovered
  - id: recovered
    run: echo ok
`,
  );
  try {
    const result = runCli([yamlPath, "--cwd", dir, "--trace", "file"]);
    assert.equal(result.status, 0);

    const events = readEvents(dir);
    const transitions = events.filter((e): e is TransitionEvent => e.ev === "transition");
    const fallbackTransition = transitions.find((t) => t.why === "fallback");
    assert.ok(fallbackTransition);
    assert.equal(fallbackTransition.from, "choosingNext");
    assert.equal(fallbackTransition.target, "recovered");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("human log: a step header, indented detail under it, and a named next decision", () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-rec-"));
  const yamlPath = join(dir, "agent.yaml");
  writeFileSync(
    yamlPath,
    "name: shape\nsteps:\n  - id: prepare\n    run: echo hi\n  - id: verify\n    run: echo ok\n",
  );
  try {
    const result = runCli([yamlPath, "--cwd", dir, "--trace", "off"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /^\[step\] prepare \(claude\)$/m);
    assert.match(result.stdout, /^\[step\] verify \(claude\)$/m);
    assert.match(result.stdout, /^ {2}\[state\] {2}idle → executingScript$/m);
    assert.match(result.stdout, /^\[runner\] next: stay → verify$/m);
    assert.doesNotMatch(result.stdout, /\[runner\] choosingNext →/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
