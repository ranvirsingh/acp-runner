import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PromptRequest } from "@agentclientprotocol/sdk";
import { runAgent, runStepCheck } from "../../src/runtime/engine.ts";
import { RunRecorder } from "../../src/output/record.ts";
import type { AgentYaml, RunnerConfig, StepEndEvent } from "../../src/types.ts";

const fixture = fileURLToPath(new URL("../fixtures/acp-child.ts", import.meta.url));

function project(runbook: AgentYaml, mode = "ok") {
  const dir = mkdtempSync(join(tmpdir(), "acp-failure-"));
  const capture = join(dir, "prompts.jsonl");
  const provider = {
    command: process.execPath,
    args: [...(process.versions.bun ? [] : ["--import", "tsx"]), fixture, `--mode=${mode}`, `--capture=${capture}`],
  };
  const config: RunnerConfig = {
    cwd: dir,
    yamlPath: join(dir, "agent.yaml"),
    runbook: { ...runbook, providers: { ...runbook.providers, agentHarness: { claude: provider, codex: provider, ...runbook.providers?.agentHarness } } },
  };
  return {
    dir, config,
    prompts: () => readFileSync(capture, "utf8").trim().split("\n").map((line) => JSON.parse(line) as PromptRequest),
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("runner sends a failed check in a second ACP block without a placeholder", async () => {
  const p = project({ steps: [
    { id: "repair", do: "Repair the importer.", run: { command: process.execPath, args: ["check.cjs"] }, retry: { maxAttempts: 1 } },
    { id: "finish", do: "Summarize." },
  ] });
  writeFileSync(join(p.dir, "check.cjs"), `const fs = require('node:fs'); if (!fs.existsSync('tried')) { fs.writeFileSync('tried', 'yes'); console.error('quoted commas are broken'); process.exit(7); }`);
  try {
    const result = await runAgent({ config: p.config });
    assert.equal(result.outcome, "finished");
    const turns = p.prompts();
    assert.deepEqual(turns[0].prompt, [{ type: "text", text: "Repair the importer." }]);
    assert.equal(turns[1].prompt.length, 2);
    assert.deepEqual(turns[1].prompt[0], turns[0].prompt[0]);
    assert.match(JSON.stringify(turns[1].prompt[1]), /Step: repair/);
    assert.match(JSON.stringify(turns[1].prompt[1]), /Exit code: 7/);
    assert.match(JSON.stringify(turns[1].prompt[1]), /quoted commas are broken/);
    assert.deepEqual(turns[2].prompt, [{ type: "text", text: "Summarize." }]);
  } finally { p.close(); }
});

test("checks retain both streams, real exits, and timeout diagnostics", () => {
  const p = project({ steps: [{ id: "unused", do: "unused" }] });
  const command = { command: process.execPath, args: ["failure.cjs"] };
  try {
    writeFileSync(join(p.dir, "failure.cjs"), "console.log('stdout evidence'); console.error('stderr evidence'); process.exit(9);");
    {
      const result = runStepCheck(p.config, { id: "check", run: command });
      assert.equal(result.outcome, "failure");
      assert.equal(result.exitCode, 9);
      assert.match(result.output ?? "", /stdout:\nstdout evidence[\s\S]*stderr:\nstderr evidence/);
    }
    writeFileSync(join(p.dir, "failure.cjs"), "console.log('before timeout'); setInterval(() => {}, 1000);");
    {
      const result = runStepCheck(p.config, { id: "check", run: command }, undefined, undefined, 200);
      assert.equal(result.outcome, "failure");
      assert.equal(result.exitCode, null);
      assert.match(result.output ?? "", /before timeout/);
      assert.match(result.output ?? "", /ETIMEDOUT|timed out/i);
    }
    writeFileSync(join(p.dir, "failure.cjs"), "process.exit(4);");
    assert.match(runStepCheck(p.config, { id: "check", run: command }).output ?? "", /without output/i);
  } finally { p.close(); }
});

test("ACP failure reports keep the Unicode output tail within 16 KiB including long headers", async () => {
  const p = project({ steps: [
    { id: "verify", run: { command: process.execPath, args: ["huge.cjs", "界".repeat(20000)] }, on: { failure: "fix" } },
    { id: "fix", do: "Fix it." },
  ] });
  writeFileSync(join(p.dir, "huge.cjs"), "console.log('START-' + '😀界'.repeat(8000)); console.error('TAIL: {{feedback}} ${{vars.secret}}'); process.exit(1);");
  try {
    assert.equal((await runAgent({ config: p.config })).outcome, "finished");
    const block = p.prompts()[0].prompt[1];
    assert.equal(block.type, "text");
    if (block.type !== "text") return;
    assert.ok(Buffer.byteLength(block.text, "utf8") <= 16384);
    assert.match(block.text, /^\[Runner failure\]\nStep: verify\nKind: check\nSource:/);
    assert.match(block.text, /Exit code: 1/);
    assert.match(block.text, /truncated/i);
    assert.ok(block.text.endsWith("TAIL: {{feedback}} ${{vars.secret}}"));
    assert.ok(!block.text.includes("START-"));
    assert.ok(!block.text.includes("\uFFFD"));
  } finally { p.close(); }
});

test("failure survives a helper and provider swap without leaking into successful step logs or later prompts", async () => {
  const p = project({ steps: [
    { id: "start", do: "Implement." },
    { id: "verify", run: "echo broken >&2; exit 3", on: { failure: "helper" } },
    { id: "helper", run: "echo setup complete" },
    { id: "fix", provider: "codex", do: "Repair." },
    { id: "finish", do: "Summarize." },
  ] });
  p.config.trace = "file";
  const recorder = new RunRecorder(p.config, "delivery");
  try {
    const result = await runAgent({ config: p.config, onStateChange: (prev, next, ctx) => recorder.onStateChange(prev, next, ctx) });
    assert.equal(result.outcome, "finished");
    const turns = p.prompts();
    assert.equal(turns[0].prompt.length, 1);
    assert.match(JSON.stringify(turns[1].prompt[1]), /Step: verify/);
    assert.match(JSON.stringify(turns[1].prompt[1]), /broken/);
    assert.equal(turns[2].prompt.length, 1);
    assert.equal(result.context.failure, undefined);
    assert.equal(result.context.pendingFailure, undefined);
    const events = readFileSync(join(p.dir, ".runner/run-delivery.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const ends: StepEndEvent[] = events.filter((event) => event.ev === "step.end");
    assert.ok(events.some((event) => event.ev === "swap" && event.to_provider === "codex"));
    assert.equal(ends.find((event) => event.step === "helper")?.feedback, null);
    assert.match(ends.find((event) => event.step === "verify")?.feedback ?? "", /broken/);
  } finally { p.close(); }
});

test("a successful recheck clears the pending failure before the next agent", async () => {
  const p = project({ steps: [
    { id: "verify", run: { command: process.execPath, args: ["check.cjs"] }, retry: { maxAttempts: 1 } },
    { id: "next", do: "Summarize." },
  ] });
  writeFileSync(join(p.dir, "check.cjs"), "const fs = require('node:fs'); if (!fs.existsSync('tried')) { fs.writeFileSync('tried', 'yes'); console.error('broken'); process.exit(1); } console.log('passed');");
  try {
    assert.equal((await runAgent({ config: p.config })).outcome, "finished");
    assert.deepEqual(p.prompts()[0].prompt, [{ type: "text", text: "Summarize." }]);
  } finally { p.close(); }
});

test("a newer workflow failure replaces the older undelivered failure", async () => {
  const p = project({ steps: [
    { id: "first", run: "echo first-error >&2; exit 1", on: { failure: "second" } },
    { id: "second", run: "echo second-error >&2; exit 2", on: { failure: "fix" } },
    { id: "fix", do: "Repair." },
  ] });
  try {
    assert.equal((await runAgent({ config: p.config })).outcome, "finished");
    const report = JSON.stringify(p.prompts()[0].prompt[1]);
    assert.match(report, /Step: second/);
    assert.match(report, /second-error/);
    assert.doesNotMatch(report, /first-error/);
  } finally { p.close(); }
});

for (const mode of ["crash-on-start", "exit-during-prompt", "reject-prompt"]) {
  test(`fallback preserves the original check failure after ${mode}`, async () => {
    const p = project({
      providers: { fallback: ["claude", "codex"] },
      steps: [
        { id: "verify", run: "echo original-error >&2; exit 5", on: { failure: "fix" } },
        { id: "fix", do: "Repair." },
        { id: "next", do: "Summarize." },
      ],
    });
    const harness = p.config.runbook.providers!.agentHarness!;
    harness.claude = { ...harness.claude, args: harness.claude.args!.map((arg) => arg === "--mode=ok" ? `--mode=${mode}` : arg) };
    try {
      const result = await runAgent({ config: p.config });
      assert.equal(result.outcome, "finished");
      assert.equal(result.context.provider, "codex");
      const turns = p.prompts();
      const recovery = turns.at(-2)!;
      assert.equal(recovery.prompt.length, 2);
      assert.match(JSON.stringify(recovery.prompt[1]), /Step: verify/);
      assert.match(JSON.stringify(recovery.prompt[1]), /original-error/);
      assert.equal(turns.at(-1)!.prompt.length, 1);
    } finally { p.close(); }
  });
}

const catalogue = fileURLToPath(new URL("../fixtures/mcp-catalogue.mjs", import.meta.url));

test("promptRef recovery receives shell failures and preserves literal external prompt text", async () => {
  const p = project({
    providers: { mcpServers: { cat: { command: process.execPath, args: [catalogue] } } },
    vars: { subject: "{{feedback}}" },
    steps: [
      { id: "decide", promptRef: { server: "cat", name: "review", arguments: { service: "{{subject}}" } } },
      { id: "check", run: { command: process.execPath, args: ["check.cjs"] }, on: { failure: { target: "decide", maxAttempts: 1, fallback: "FAIL" } } },
    ],
  });
  writeFileSync(join(p.dir, "check.cjs"), "const fs = require('node:fs'); if (!fs.existsSync('tried')) { fs.writeFileSync('tried', 'yes'); console.log('evidence'); console.error('check rejected'); process.exit(6); }");
  try {
    assert.equal((await runAgent({ config: p.config })).outcome, "finished");
    const turns = p.prompts();
    assert.equal(turns.length, 2);
    assert.deepEqual(turns[0].prompt, [{ type: "text", text: "review {{feedback}}\n\nbe brief" }]);
    assert.deepEqual(turns[1].prompt[0], turns[0].prompt[0]);
    assert.equal(turns[1].prompt.length, 2);
    const report = JSON.stringify(turns[1].prompt[1]);
    assert.match(report, /Kind: check/);
    assert.match(report, /Exit code: 6/);
    assert.match(report, /stdout:/);
    assert.match(report, /stderr:/);
  } finally { p.close(); }
});

test("input preparation failures are delivered to the recovery step", async () => {
  const p = project({
    providers: { mcpServers: { cat: { command: process.execPath, args: [catalogue] } } },
    steps: [
      { id: "read", do: "Read {{data}}", vars: { data: { resource: "mem://missing", server: "cat" } }, on: { failure: "fix" } },
      { id: "fix", do: "Explain the missing input." },
    ],
  });
  try {
    assert.equal((await runAgent({ config: p.config })).outcome, "finished");
    const turns = p.prompts();
    assert.equal(turns.length, 1);
    assert.match(JSON.stringify(turns[0].prompt[1]), /Kind: input/);
    assert.match(JSON.stringify(turns[0].prompt[1]), /mem:\/\/missing/);
  } finally { p.close(); }
});
