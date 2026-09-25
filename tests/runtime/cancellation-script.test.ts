import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent, runStepCheck } from "../../src/runtime/engine.ts";
import type { AgentYaml, RunnerConfig } from "../../src/types.ts";

function createTempProject(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "cancellation-script-test-"));
  for (const [name, content] of Object.entries(files)) {
    const filePath = join(dir, name);
    writeFileSync(filePath, content, "utf8");
  }
  return dir;
}

test("cancellation: a run given an already-aborted signal does not execute script steps and fails", async () => {
  const dir = createTempProject();
  const markerPath = join(dir, "executed.marker");
  try {
    const runbook: AgentYaml = {
      steps: [
        {
          id: "script-step",
          run: `node -e 'require("fs").writeFileSync("${markerPath}", "ran")'`,
        },
      ],
    };
    const config: RunnerConfig = {
      yamlPath: join(dir, "agent.yaml"),
      cwd: dir,
      runbook,
    };
    const controller = new AbortController();
    controller.abort();
    const result = await runAgent({ config, signal: controller.signal });
    assert.equal(result.outcome, "failed");
    assert.equal(existsSync(markerPath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cancellation: runStepCheck does not execute command if signal is already aborted", () => {
  const dir = createTempProject();
  const markerPath = join(dir, "step.marker");
  try {
    const config: RunnerConfig = {
      yamlPath: join(dir, "agent.yaml"),
      cwd: dir,
      runbook: { steps: [] },
    };
    const controller = new AbortController();
    controller.abort();
    const result = runStepCheck(
      config,
      { id: "step", run: `node -e 'require("fs").writeFileSync("${markerPath}", "ran")'` },
      undefined,
      controller.signal,
    );
    assert.equal(result.outcome, "failure");
    assert.equal(existsSync(markerPath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
