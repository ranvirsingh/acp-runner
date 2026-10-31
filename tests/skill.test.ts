import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "./helpers/run-cli.ts";

function withHome(fn: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "acp-skill-"));
  try {
    fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("cli: skill install copies create-acp-agent into ~/.claude/skills", () => {
  withHome((home) => {
    const result = runCli(["skill", "install"], { env: { HOME: home } });
    assert.equal(result.status, 0, result.stderr);
    const target = join(home, ".claude", "skills", "create-acp-agent");
    assert.match(readFileSync(join(target, "SKILL.md"), "utf8"), /^name: create-acp-agent$/m);
    assert.ok(existsSync(join(target, "assets", "agent.yaml")));
    assert.match(result.stdout, new RegExp(`installed create-acp-agent to ${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  });
});

test("cli: skill install replaces an older copy, so no stale file remains", () => {
  withHome((home) => {
    const target = join(home, ".claude", "skills", "create-acp-agent");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "stale.md"), "old");
    const result = runCli(["skill", "install"], { env: { HOME: home } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(target, "stale.md")), false);
    assert.ok(existsSync(join(target, "SKILL.md")));
  });
});

test("cli: skill without install prints the usage", () => {
  const result = runCli(["skill"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /acp-runner skill install/);
});
