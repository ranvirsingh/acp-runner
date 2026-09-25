import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUILTIN_PROVIDERS,
  defaultProvider,
  describeSpawn,
  spawnCommandFor,
  providerSpec,
  knownProviderIds,
} from "../../src/runtime/providers.ts";

test("spawnCommandFor: claude runs the published claude-agent-acp bridge", () => {
  assert.deepEqual(spawnCommandFor("claude"), {
    command: "npx",
    args: ["-y", "@agentclientprotocol/claude-agent-acp"],
  });
});

test("spawnCommandFor: codex runs the published codex-acp bridge", () => {
  assert.deepEqual(spawnCommandFor("codex"), {
    command: "npx",
    args: ["-y", "@agentclientprotocol/codex-acp"],
  });
});

test("spawnCommandFor: gemini runs the local gemini CLI in acp mode", () => {
  assert.deepEqual(spawnCommandFor("gemini"), { command: "gemini", args: ["--acp"] });
});

test("BUILTIN_PROVIDERS: covers every provider id", () => {
  assert.deepEqual(Object.keys(BUILTIN_PROVIDERS).sort(), ["claude", "codex", "gemini"]);
});

test("describeSpawn: renders the command line a user could paste", () => {
  assert.equal(describeSpawn("claude"), "npx -y @agentclientprotocol/claude-agent-acp");
  assert.equal(describeSpawn("codex"), "npx -y @agentclientprotocol/codex-acp");
  assert.equal(describeSpawn("gemini"), "gemini --acp");
});

test("defaultProvider: claude even when an agent binary is on PATH", () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-agent-bin-"));
  const previous = process.env.PATH;
  writeFileSync(join(dir, "agent"), "#!/bin/sh\n");
  chmodSync(join(dir, "agent"), 0o755);
  process.env.PATH = `${dir}:${previous}`;
  try {
    assert.equal(defaultProvider(), "claude");
  } finally {
    process.env.PATH = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("providerSpec: cursor and antigravity are not built in", () => {
  assert.throws(() => providerSpec("cursor"), /unknown provider "cursor" \(known: claude, codex, gemini\)/);
  assert.throws(() => providerSpec("antigravity"), /unknown provider "antigravity"/);
});

test("providerSpec: returns the built-in entry for a known id", () => {
  assert.deepEqual(providerSpec("claude"), {
    id: "claude",
    command: "npx",
    args: ["-y", "@agentclientprotocol/claude-agent-acp"],
  });
});

test("providerSpec: resolves a provider declared in the runbook", () => {
  const declared = { amp: { command: "amp", args: ["--acp"] } };
  assert.deepEqual(providerSpec("amp", declared), {
    id: "amp",
    command: "amp",
    args: ["--acp"],
  });
});

test("providerSpec: a declared entry with no args gets an empty arg list", () => {
  assert.deepEqual(providerSpec("amp", { amp: { command: "amp" } }), {
    id: "amp",
    command: "amp",
    args: [],
  });
});

test("providerSpec: a declared entry overrides a built-in of the same name", () => {
  const declared = { claude: { command: "npx", args: ["-y", "claude-agent-acp@1.2.3"] } };
  assert.deepEqual(providerSpec("claude", declared), {
    id: "claude",
    command: "npx",
    args: ["-y", "claude-agent-acp@1.2.3"],
  });
});

test("providerSpec: an unknown id throws and lists what is known", () => {
  assert.throws(() => providerSpec("nope"), /unknown provider "nope"/);
  assert.throws(() => providerSpec("nope"), /claude/);
  assert.throws(() => providerSpec("nope", { amp: { command: "amp" } }), /amp/);
});

test("knownProviderIds: built-ins alone, then built-ins plus declared", () => {
  assert.deepEqual(knownProviderIds().sort(), ["claude", "codex", "gemini"]);
  assert.ok(knownProviderIds({ amp: { command: "amp" } }).includes("amp"));
});
