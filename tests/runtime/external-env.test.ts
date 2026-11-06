import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../helpers/run-cli.ts";

function withRunbook(yaml: string, fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "acp-external-run-"));
  try {
    writeFileSync(join(dir, "agent.yaml"), yaml, "utf8");
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const runbook = `providers:
  claude:
    command: node
    args: ["-e", "process.exit(3)"]
    model: test-model
mcpServers:
  tracker:
    type: http
    url: https://tracker.test/mcp
    headers:
      Authorization: "Bearer \${{ secrets.ACP_FF_TOKEN }}"
steps:
  - id: first
    run: touch ran.txt
  - id: later
    run: "echo \${{ env.ACP_FF_TARGET }}"
`;

test("run: missing outside values stop the run before any step and are all named", () => {
  withRunbook(runbook, (dir) => {
    const result = runCli(["run", dir, "--cwd", dir, "--trace", "off"], { env: { ACP_FF_TOKEN: "" } });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /env ACP_FF_TARGET is not set/);
    assert.match(result.stderr, /secret ACP_FF_TOKEN is empty/);
    assert.equal(existsSync(join(dir, "ran.txt")), false);
  });
});

test("check: missing outside values fail before any harness starts", () => {
  withRunbook(runbook, (dir) => {
    const result = runCli(["check", dir], { env: { ACP_FF_TOKEN: "" } });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /fail env ACP_FF_TARGET is not set/);
    assert.match(result.stderr, /fail secret ACP_FF_TOKEN is empty/);
    assert.doesNotMatch(result.stdout + result.stderr, /claude/);
  });
});
