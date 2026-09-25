import assert from "node:assert/strict";
import test, { before } from "node:test";
import { execSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

before(() => {
  if (process.versions.bun) {
    execSync("bun run compile", { cwd: root, stdio: "pipe" });
  }
});

test("dist exports: dist/index.js exports public framework API", async () => {
  execSync(process.versions.bun ? "bun run build" : "npm run build", { cwd: root, stdio: "pipe" });
  const dist = await import(join(root, "dist/index.js"));
  assert.equal(typeof dist.runAgent, "function");
  assert.equal(typeof dist.createAgentActor, "function");
  assert.ok(dist.AcpSession);
  assert.equal(typeof dist.providerSpec, "function");
  assert.equal(typeof dist.knownProviderIds, "function");
  assert.ok(dist.BUILTIN_PROVIDERS.claude);
  assert.ok(dist.agentYamlSchema);
  assert.equal(typeof dist.loadAgentYaml, "function");
  assert.equal(typeof dist.validateAgentYaml, "function");
  assert.equal(typeof dist.resolveRunbookPath, "function");
  assert.equal(typeof dist.resolveProvider, "function");
  assert.equal(typeof dist.resolveModel, "function");
  assert.equal(typeof dist.resolveStepPrompt, "function");
  assert.equal(typeof dist.resolveStepCommand, "function");
  assert.equal(typeof dist.parseArgs, "function");
  assert.equal(typeof dist.loadConfig, "function");
  assert.equal(typeof dist.RUNNER_VERSION, "string");
});

test("dist exports: dist/index.js exports the MCP API", async () => {
  const dist = await import(join(root, "dist/index.js"));
  assert.ok(dist.McpProxy);
  assert.equal(typeof dist.normalizeScope, "function");
  assert.equal(typeof dist.toolAllowed, "function");
  assert.equal(typeof dist.resolveStepScope, "function");
  assert.equal(typeof dist.toAcpMcpServer, "function");
  assert.equal(dist.serveAgentAsMcp, undefined);
  assert.equal(dist.runProxyShim, undefined);
  assert.equal(dist.runnerSpawnCommand, undefined);
  assert.equal(typeof dist.lintRunbook, "function");
});

test("packaged CLI: prints its version without also executing the bundled linter", () => {
  const result = spawnSync("node", [join(root, "dist/cli.js"), "--version"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.trim(), "0.1.0");
});

test("packaged CLI: prints its version through an npm-style executable symlink", () => {
  const cwd = mkdtempSync(join(tmpdir(), "acp packed cli "));
  try {
    const executable = join(cwd, "acp-runner");
    symlinkSync(join(root, "dist/cli.js"), executable);
    const result = spawnSync("node", [executable, "--version"], { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "0.1.0");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("packaged CLI: executes a runbook outside the repository through an executable symlink", () => {
  const cwd = mkdtempSync(join(tmpdir(), "acp packed run "));
  try {
    const executable = join(cwd, "acp-runner");
    symlinkSync(join(root, "dist/cli.js"), executable);
    writeFileSync(join(cwd, "agent.yaml"), "steps:\n  - id: greet\n    run:\n      command: node\n      args: [write.mjs]\n");
    writeFileSync(join(cwd, "write.mjs"), 'import { writeFileSync } from "node:fs"; writeFileSync("hello.txt", "Hello, world!\\n");');
    const result = spawnSync("node", [executable, "./agent.yaml", "--cwd", cwd, "--confirm", "--trace", "file"], {
      cwd,
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\[runner\] finished/);
    assert.equal(readFileSync(join(cwd, "hello.txt"), "utf8"), "Hello, world!\n");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("compiled binary: prints version without linting errors", () => {
  if (!process.versions.bun) return;
  const out = execSync("./dist-bun/acp-runner --version", { cwd: root, encoding: "utf8", stdio: "pipe" });
  assert.equal(out.trim(), "0.1.0");
});

test("compiled binary: checksum file matches the shipped binary", () => {
  if (!process.versions.bun) return;
  const binary = join(root, "dist-bun/acp-runner");
  const hex = createHash("sha256").update(readFileSync(binary)).digest("hex");
  assert.equal(readFileSync(`${binary}.sha256`, "utf8"), `${hex}  acp-runner\n`);
});
