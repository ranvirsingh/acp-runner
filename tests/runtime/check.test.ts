import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "../helpers/run-cli.ts";

const fixturePath = join(fileURLToPath(import.meta.url), "../../fixtures/acp-child.ts");

function provider(name: string, model: string, mode = "ok"): string {
  return `  ${name}:\n    command: bun\n    args: ["${fixturePath}", "--mode=${mode}"]\n    model: ${model}\n`;
}

function withProviders(providers: string, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "acp-check-"));
  const path = join(dir, "agent.yaml");
  writeFileSync(
    path,
    `name: check\nproviders:\n${providers}steps:\n  - id: a\n    provider: good\n    do: hi\n`,
  );
  try {
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("cli: check passes when every provider starts, is logged in and offers its model", () => {
  withProviders(provider("good", "test-model") + provider("byname", "Test"), (path) => {
    const result = runCli(["check", path], { timeout: 20000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^ok good \(test-model\)$/m);
    assert.match(result.stdout, /^ok byname \(Test\)$/m);
  });
});

test("cli: check accepts a runbook path relative to the current directory", () => {
  withProviders(provider("good", "test-model"), (path) => {
    const result = runCli(["check", relative(process.cwd(), path)], { timeout: 20000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^ok good \(test-model\)$/m);
  });
});

test("cli: check passes a model the harness accepts but does not list, and names the listed ones", () => {
  withProviders(provider("good", "test-model") + provider("lenient", "full-model-id"), (path) => {
    const result = runCli(["check", path], { timeout: 20000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /^ok lenient \(full-model-id; not in the harness's list: fixture-model, other, test-model\)$/m,
    );
  });
});

test("cli: check names each provider that has the wrong model or needs a login", () => {
  const providers =
    provider("good", "test-model") +
    provider("wrongmodel", "gpt-nope", "strict-model") +
    provider("nologin", "test-model", "auth");
  withProviders(providers, (path) => {
    const result = runCli(["check", path], { timeout: 20000 });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /^ok good \(test-model\)$/m);
    assert.match(result.stderr, /^fail wrongmodel: cannot set model "gpt-nope": .*unknown model gpt-nope/m);
    assert.match(
      result.stderr,
      /^fail nologin: nologin needs a login \(gemini-api-key\); sign in with its own CLI first$/m,
    );
  });
});

test("cli: check reports an invalid runbook and exits non-zero", () => {
  const result = runCli(["check", "no-such-runbook.yaml"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no-such-runbook\.yaml/);
});
