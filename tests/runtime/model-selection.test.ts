import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AcpSession } from "../../src/runtime/session.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { stringify } from "yaml";
import { loadAgentYaml } from "../../src/config/yaml.ts";
import { runAgent } from "../../src/runtime/engine.ts";
import type { ProviderSpec } from "../../src/runtime/providers.ts";

const fixturePath = join(fileURLToPath(import.meta.url), "../../fixtures/acp-child.ts");

test("workflow selects each harness model over ACP and honors a step override", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "acp-harness-model-"));
  const yamlPath = join(cwd, "agent.yaml");
  const harness = {
    command: process.execPath,
    args: [...(process.versions.bun ? [] : ["--import", "tsx"]), fixturePath, "--mode=model-select"],
  };
  try {
    for (const steps of [
      [{ id: "write", provider: "writer", do: "Draft" }],
      [{ id: "write", provider: "writer", do: "Draft" }, { id: "review", provider: "reviewer", do: "Review" }],
      [{ id: "write", provider: "writer", do: "Draft", model: "fixture-model" }],
    ]) {
      writeFileSync(yamlPath, stringify({
        providers: { agentHarness: {
          writer: { ...harness, model: "other" },
          reviewer: { ...harness, model: "fixture-model" },
        }, onSpawnError: "fail" },
        steps,
      }));
      const result = await runAgent({ config: { cwd, yamlPath, runbook: loadAgentYaml(yamlPath) } });
      assert.equal(result.outcome, "finished");
      assert.equal(result.context.effectiveModel, steps.length === 1 && !("model" in steps[0]) ? "other" : "fixture-model");
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

function fixtureSpec(): ProviderSpec {
  return { id: "claude", command: "bun", args: [fixturePath] };
}

test("a fallback harness selects its own model after the first adapter fails", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "acp-fallback-model-"));
  try {
    const result = await runAgent({ config: {
      cwd, yamlPath: join(cwd, "agent.yaml"), runbook: {
        provider: "writer",
        providers: {
          agentHarness: {
            writer: { command: "bun", args: [fixturePath, "--mode=crash-on-start"], model: "unavailable" },
            reviewer: { command: "bun", args: [fixturePath, "--mode=model-select"], model: "other" },
          },
          fallback: ["reviewer"], onSpawnError: "swap",
        },
        steps: [{ id: "write", do: "Draft" }],
      },
    } });
    assert.equal(result.outcome, "finished");
    assert.equal(result.context.provider, "reviewer");
    assert.equal(result.context.effectiveModel, "other");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("model selection: fails when provider exposes no model option", async () => {
  await assert.rejects(
    AcpSession.spawn(fixtureSpec(), {
      cwd: "/tmp",
      model: "claude-sonnet-4",
      quiet: true,
    }),
    /cannot set model "claude-sonnet-4"/,
  );
});

test("model selection: succeeds and records effectiveModel when provider exposes model", async () => {
  const session = await AcpSession.spawn(fixtureSpec(), {
    cwd: "/tmp",
    model: "other",
    env: { ACP_FIXTURE_MODE: "model-select" },
    quiet: true,
  });
  try {
    assert.equal(session.effectiveModel, "other");
  } finally {
    await session.close();
  }
});

test("model selection: records provider default effectiveModel when no model requested", async () => {
  const session = await AcpSession.spawn(fixtureSpec(), {
    cwd: "/tmp",
    env: { ACP_FIXTURE_MODE: "model-select" },
    quiet: true,
  });
  try {
    assert.equal(session.effectiveModel, "fixture-model");
  } finally {
    await session.close();
  }
});

test("model selection: does not throw when allowModelFallback is true and provider has no model option", async () => {
  const session = await AcpSession.spawn(fixtureSpec(), {
    cwd: "/tmp",
    model: "claude-sonnet-4",
    allowModelFallback: true,
    quiet: true,
  });
  try {
    assert.equal(session.state, "ready");
    assert.equal(session.effectiveModel, undefined);
  } finally {
    await session.close();
  }
});
