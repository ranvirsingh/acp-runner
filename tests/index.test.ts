import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentActor,
  runAgent,
  AcpSession,
  agentYamlSchema,
  loadAgentYaml,
  validateAgentYaml,
  RUNNER_VERSION,
  type RunnerConfig,
} from "../src/index.ts";
import { runCli } from "./helpers/run-cli.ts";

test("cli: no arguments looks for ./agent.yaml and reports it missing", () => {
  const result = runCli([]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /agent\.yaml/);
});

test("cli: --version prints the package version and exits zero", () => {
  const result = runCli(["--version"]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), RUNNER_VERSION);
  assert.equal(result.stderr, "");
});

test("cli: an unsupported provider is rejected before anything is spawned", () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-index-"));
  const path = join(dir, "agent.yaml");
  writeFileSync(path, "name: demo\nsteps:\n  - id: implement\n    do: Ship it\n");
  try {
    const result = runCli([path, "--provider", "unsupported"]);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /unknown provider "unsupported" \(known: claude, codex, gemini\)/,
    );
    assert.doesNotMatch(result.stdout, /\[acp\] spawn/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli: an unknown flag is rejected", () => {
  const result = runCli(["--verbose"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown flag --verbose/);
});

test("cli: a runbook with an empty step list is rejected", () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-index-"));
  const path = join(dir, "empty.yaml");
  writeFileSync(path, "name: empty\nsteps: []\n");
  try {
    const result = runCli([path, "--cwd", dir]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /steps: Array must contain at least 1 element/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli: a missing runbook is reported by path", () => {
  const result = runCli(["no-such-runbook.yaml"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no-such-runbook\.yaml/);
});

test("exports: AcpSession, runAgent and schemas are exported", () => {
  assert.ok(AcpSession);
  assert.equal(typeof runAgent, "function");
  assert.ok(agentYamlSchema);
  assert.equal(typeof loadAgentYaml, "function");
  assert.equal(typeof validateAgentYaml, "function");
});

test("createAgentActor: instantiates actor with config", () => {
  const config: RunnerConfig = {
    yamlPath: "/tmp/agent.yaml",
    cwd: "/tmp",
    runbook: {
      steps: [{ id: "test-step", run: "true" }],
    },
  };
  const actor = createAgentActor({ config });
  assert.ok(actor);
});

test("runAgent: executes script-only agent to completion", async () => {
  const config: RunnerConfig = {
    yamlPath: "/tmp/agent.yaml",
    cwd: "/tmp",
    runbook: {
      steps: [{ id: "test-step", run: "true" }],
    },
  };
  const transitions: Array<{ prev: string; next: string }> = [];
  const result = await runAgent({
    config,
    onStateChange: (prev, next) => transitions.push({ prev, next }),
  });
  assert.equal(result.outcome, "finished");
  assert.ok(transitions.length > 0);
});

test("runAgent: passes SessionContext to onStateChange callback", async () => {
  const config: RunnerConfig = {
    yamlPath: "/tmp/agent.yaml",
    cwd: "/tmp",
    runbook: {
      steps: [{ id: "test-step", run: "true" }],
    },
  };
  const contexts: unknown[] = [];
  await runAgent({
    config,
    onStateChange: (_prev, _next, context) => contexts.push(context),
  });
  assert.ok(contexts.length > 0);
  assert.ok((contexts[0] as { cwd?: string })?.cwd === "/tmp");
});
