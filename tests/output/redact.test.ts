import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../helpers/run-cli.ts";
import { createRedactor } from "../../src/output/redact.ts";
import { createAcpLogger } from "../../src/output/logs.ts";
import { RunRecorder } from "../../src/output/record.ts";
import type { RunnerConfig } from "../../src/types.ts";

test("redaction covers literal MCP headers and secret variables without changing ordinary values", () => {
  const config: RunnerConfig = {
    cwd: "/tmp", yamlPath: "/tmp/agent.yaml",
    runbook: {
      vars: { PASSWORD: 'quoted-"secret', ordinary: "keep-this" },
      mcpServers: { remote: { type: "http", url: "https://example.com", headers: { "X-API-Key": "header-secret" } } },
      steps: [{ id: "one", run: "true" }],
    },
  };
  assert.equal(createRedactor(config)('quoted-"secret header-secret keep-this'), "[REDACTED] [REDACTED] keep-this");
});

test("ACP logs redact known secrets", () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (line) => { lines.push(String(line)); };
  try {
    createAcpLogger("test", false, createRedactor(undefined, ["provider-secret"]))("stderr provider-secret");
    assert.match(lines.join("\n"), /\[REDACTED\]/);
    assert.doesNotMatch(lines.join("\n"), /provider-secret/);
  } finally {
    console.log = original;
  }
});

test("a fresh trace file is private and cannot overwrite an existing file", () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-private-trace-"));
  const config: RunnerConfig = { cwd: dir, yamlPath: join(dir, "agent.yaml"), trace: "file",
    runbook: { steps: [{ id: "one", run: "true" }] } };
  try {
    const first = new RunRecorder(config, "test");
    first.start();
    first.end("finished");
    const file = join(dir, ".runner", "run-test.jsonl");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, ".runner")).mode & 0o777, 0o700);
    const before = readFileSync(file, "utf8");
    const second = new RunRecorder(config, "test");
    second.start();
    second.end("finished");
    assert.equal(readFileSync(file, "utf8"), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI redacts secrets from stdout, stderr, and trace files before truncation", () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-secret-trace-"));
  const yaml = join(dir, "agent.yaml");
  const secret = 'sensitive-"value-12345';
  writeFileSync(yaml, `steps:\n  - id: failing\n    run:\n      command: ${JSON.stringify(process.execPath)}\n      args: ["-e", ${JSON.stringify('console.error("x".repeat(1995) + process.env.ACP_TEST_SECRET); process.exit(1)')}]\n`);
  try {
    const result = runCli(["run", yaml, "--cwd", dir, "--trace", "both"], { env: { ACP_TEST_SECRET: secret } });
    assert.equal(result.status, 1);
    const file = join(dir, ".runner", readdirSync(join(dir, ".runner"))[0]);
    const trace = readFileSync(file, "utf8");
    const combined = result.stdout + result.stderr + trace;
    assert.doesNotMatch(combined, /sensitive/);
    for (const line of trace.trim().split("\n")) assert.doesNotThrow(() => JSON.parse(line));
    const human = runCli(["run", yaml, "--cwd", dir, "--trace", "off"], { env: { ACP_TEST_SECRET: secret } });
    assert.doesNotMatch(human.stdout + human.stderr, /sensitive/);
    assert.match(human.stderr, /\[REDACTED\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("redaction covers values referenced as secrets and leaves outside env values alone", () => {
  process.env.ACP_OPAQUE_VALUE = "opaque-value-123";
  process.env.ACP_PLAIN_VALUE = "plain-value-456";
  const config: RunnerConfig = {
    cwd: "/tmp", yamlPath: "/tmp/agent.yaml",
    runbook: {
      mcpServers: { remote: { type: "http", url: "https://example.com", headers: { Authorization: "Bearer ${{ secrets.ACP_OPAQUE_VALUE }}" } } },
      steps: [{ id: "one", run: "echo ${{ env.ACP_PLAIN_VALUE }}" }],
    },
  };
  try {
    assert.equal(createRedactor(config)("opaque-value-123 plain-value-456"), "[REDACTED] plain-value-456");
  } finally {
    delete process.env.ACP_OPAQUE_VALUE;
    delete process.env.ACP_PLAIN_VALUE;
  }
});
