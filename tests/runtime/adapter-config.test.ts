import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  BUILTIN_PROVIDERS,
  knownProviderIds,
  providerSpec,
  resolveAdapterConfig,
} from "../../src/runtime/providers.ts";

test("adapter config: respects precedence built-in -> user -> project -> runbook", () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-adapter-"));
  const userConfigDir = join(dir, "user", "acp-runner");
  mkdirSync(userConfigDir, { recursive: true });
  const userConfigFile = join(userConfigDir, "config.yaml");
  writeFileSync(
    userConfigFile,
    `
providers:
  agentHarness:
    claude:
      command: user-claude
      args: ["--user"]
    gemini:
      command: user-gemini
      args: ["--user-gemini"]
      model: user-model
`,
  );

  const projectDir = join(dir, "project");
  mkdirSync(projectDir, { recursive: true });
  const projectConfigFile = join(projectDir, ".acp-runner.yaml");
  writeFileSync(
    projectConfigFile,
    `
providers:
  agentHarness:
    claude:
      command: project-claude
      args: ["--project"]
    internal-agent:
      command: /bin/internal
      args: ["acp"]
      model: project-model
`,
  );

  const runbookDeclared = {
    claude: { command: "runbook-claude", args: ["--runbook"], model: "runbook-model" },
  };

  try {
    const resolvedClaude = providerSpec("claude", runbookDeclared, {
      cwd: projectDir,
      userConfigPath: userConfigFile,
      projectConfigPath: projectConfigFile,
    });
    assert.deepEqual(resolvedClaude, {
      id: "claude",
      command: "runbook-claude",
      args: ["--runbook"],
      model: "runbook-model",
    });

    const resolvedGemini = providerSpec("gemini", undefined, {
      cwd: projectDir,
      userConfigPath: userConfigFile,
      projectConfigPath: projectConfigFile,
    });
    assert.deepEqual(resolvedGemini, {
      id: "gemini",
      command: "user-gemini",
      args: ["--user-gemini"],
      model: "user-model",
    });

    const resolvedInternal = providerSpec("internal-agent", undefined, {
      cwd: projectDir,
      userConfigPath: userConfigFile,
      projectConfigPath: projectConfigFile,
    });
    assert.deepEqual(resolvedInternal, {
      id: "internal-agent",
      command: "/bin/internal",
      args: ["acp"],
      model: "project-model",
    });

    const resolvedCodex = providerSpec("codex", undefined, {
      cwd: projectDir,
      userConfigPath: userConfigFile,
      projectConfigPath: projectConfigFile,
    });
    assert.deepEqual(resolvedCodex, {
      id: "codex",
      command: BUILTIN_PROVIDERS.codex.command,
      args: [...BUILTIN_PROVIDERS.codex.args],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("adapter config: whole-entry replacement replaces args completely without merging", () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-adapter-replace-"));
  const projectDir = join(dir, "project");
  mkdirSync(projectDir, { recursive: true });
  const projectConfigFile = join(projectDir, ".acp-runner.yaml");
  writeFileSync(
    projectConfigFile,
    `
providers:
  agentHarness:
    claude:
      command: bare-claude
`,
  );

  try {
    const spec = providerSpec("claude", undefined, {
      cwd: projectDir,
      userConfigPath: null,
      projectConfigPath: projectConfigFile,
    });
    assert.deepEqual(spec, {
      id: "claude",
      command: "bare-claude",
      args: [],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("adapter config: knownProviderIds includes providers from all layers", () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-adapter-known-"));
  const projectDir = join(dir, "project");
  mkdirSync(projectDir, { recursive: true });
  const projectConfigFile = join(projectDir, ".acp-runner.yaml");
  writeFileSync(
    projectConfigFile,
    `
providers:
  agentHarness:
    custom-proj:
      command: proj-bin
`,
  );

  try {
    const ids = knownProviderIds(undefined, {
      cwd: projectDir,
      userConfigPath: null,
      projectConfigPath: projectConfigFile,
    });
    assert.ok(ids.includes("custom-proj"));
    assert.ok(ids.includes("claude"));
    assert.ok(ids.includes("codex"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("adapter config: default is an ordinary harness name", () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-adapter-default-"));
  const projectDir = join(dir, "project");
  mkdirSync(projectDir, { recursive: true });
  const projectConfigFile = join(projectDir, ".acp-runner.yaml");
  writeFileSync(
    projectConfigFile,
    `
providers:
  agentHarness:
    default:
      command: default-bin
    my-tool:
      command: my-bin
`,
  );

  try {
    const ids = knownProviderIds(undefined, {
      cwd: projectDir,
      userConfigPath: null,
      projectConfigPath: projectConfigFile,
    });
    assert.ok(ids.includes("default"));
    assert.ok(ids.includes("my-tool"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("adapter config: a config file declares harnesses only under providers.agentHarness", () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-adapter-root-"));
  const projectConfigFile = join(dir, ".acp-runner.yaml");
  writeFileSync(projectConfigFile, "agentHarness:\n  root-tool:\n    command: root-bin\n");
  try {
    const ids = knownProviderIds(undefined, {
      cwd: dir,
      userConfigPath: null,
      projectConfigPath: projectConfigFile,
    });
    assert.ok(!ids.includes("root-tool"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("adapter config: resolveAdapterConfig falls back when files are absent", () => {
  const resolved = resolveAdapterConfig({
    cwd: "/nonexistent-path-for-testing",
    userConfigPath: "/nonexistent-user-config.yaml",
    projectConfigPath: "/nonexistent-project-config.yaml",
  });
  assert.equal(resolved.claude.command, BUILTIN_PROVIDERS.claude.command);
  assert.deepEqual(resolved.claude.args, BUILTIN_PROVIDERS.claude.args);
});
