import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planRunbook } from "../../src/config/plan.ts";
import { runCli } from "../helpers/run-cli.ts";

test("plan: shows each prompt step with its provider, model, servers, filled prompt, gate and next steps", () => {
  const out = planRunbook("examples/riddle");
  assert.match(out, /^riddle: Claude writes a riddle, Codex solves it$/m);
  assert.match(out, /^1\. ask$/m);
  assert.match(out, /^   provider  claude \(claude-sonnet-5\)$/m);
  assert.match(out, /^   mcp       none$/m);
  assert.match(out, /^   do        Write one short, original riddle about the ocean to riddle\.md$/m);
  assert.match(out, /^             in the working directory\. It must have exactly one fair answer\.$/m);
  assert.match(out, /^   run       test -s "riddle\.md"$/m);
  assert.match(out, /^   success → solve$/m);
  assert.match(out, /^   failure → FAIL$/m);
  assert.match(out, /^2\. solve$/m);
  assert.match(out, /^   provider  codex \(gpt-6-luna\)$/m);
  assert.match(out, /^   success → END$/m);
});

test("plan: shows tool scopes, script commands, resource vars and loops", () => {
  const out = planRunbook("examples/hello-world");
  const [checkInputs] = out.split("\n2. collect");
  assert.match(checkInputs, /^   run       sh scripts\/check-inputs\.sh$/m);
  assert.doesNotMatch(checkInputs, /provider|mcp/);
  assert.match(out, /^   mcp       issue_tracker \(allow list_issues\)$/m);
  assert.match(out, /^             <resource mem:\/\/release-style from issue_tracker>$/m);
  assert.match(out, /^   failure → collect \(max 2, then FAIL\)$/m);
});

test("plan: retry is shown as a loop back to the same step", () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-plan-"));
  const path = join(dir, "agent.yaml");
  writeFileSync(
    path,
    "name: retry\nsteps:\n  - id: gate\n    run: \"false\"\n    retry:\n      maxAttempts: 3\n",
  );
  try {
    assert.match(planRunbook(path), /^   failure → gate \(max 3, then FAIL\)$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli: plan prints the plan and starts no harness", () => {
  const result = runCli(["plan", "examples/riddle"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^1\. ask$/m);
  assert.doesNotMatch(result.stdout, /spawn/);
});

test("cli: plan reports an invalid runbook and exits non-zero", () => {
  const result = runCli(["plan", "no-such-runbook.yaml"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no-such-runbook\.yaml/);
});
