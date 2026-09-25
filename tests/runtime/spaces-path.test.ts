import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStepCheck } from "../../src/runtime/engine.ts";
import type { RunnerConfig } from "../../src/types.ts";

function createDirWithSpaces(name: string): string {
  const base = mkdtempSync(join(tmpdir(), "space test-"));
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("spaces path: structured run executes relative script when runbook directory contains spaces", () => {
  const runbookDir = createDirWithSpaces("runbook dir with spaces");
  const workspaceDir = mkdtempSync(join(tmpdir(), "workspace-"));
  const scriptPath = join(runbookDir, "check.js");
  const markerPath = join(workspaceDir, "marker.txt");

  try {
    writeFileSync(
      scriptPath,
      `require("fs").writeFileSync(${JSON.stringify(markerPath)}, "ok");\n`,
      "utf8",
    );

    const config: RunnerConfig = {
      yamlPath: join(runbookDir, "agent.yaml"),
      cwd: workspaceDir,
      runbook: { steps: [] },
    };

    const result = runStepCheck(config, {
      id: "check",
      run: {
        command: "node",
        args: ["check.js"],
      },
    });

    assert.equal(result.outcome, "success");
    assert.equal(readFileSync(markerPath, "utf8"), "ok");
  } finally {
    rmSync(runbookDir, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("spaces path: shell mode preserves quotes and arguments with spaces", () => {
  const workspaceDir = mkdtempSync(join(tmpdir(), "workspace-"));
  const outputFile = join(workspaceDir, "output.txt");

  try {
    const config: RunnerConfig = {
      yamlPath: join(workspaceDir, "agent.yaml"),
      cwd: workspaceDir,
      runbook: { steps: [] },
    };

    const result = runStepCheck(config, {
      id: "echo",
      run: `node -e 'require("fs").writeFileSync("${outputFile}", "hello world")'`,
    });

    assert.equal(result.outcome, "success");
    assert.equal(readFileSync(outputFile, "utf8"), "hello world");
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("spaces path: string run executes relative script when runbook directory contains spaces", () => {
  const runbookDir = createDirWithSpaces("runbook dir with spaces");
  const workspaceDir = mkdtempSync(join(tmpdir(), "workspace-"));
  const scriptPath = join(runbookDir, "check.js");
  const markerPath = join(workspaceDir, "marker.txt");

  try {
    writeFileSync(
      scriptPath,
      `require("fs").writeFileSync(${JSON.stringify(markerPath)}, "ok");\n`,
      "utf8",
    );

    const config: RunnerConfig = {
      yamlPath: join(runbookDir, "agent.yaml"),
      cwd: workspaceDir,
      runbook: { steps: [] },
    };

    const result = runStepCheck(config, {
      id: "check",
      run: "node check.js",
    });

    assert.equal(result.outcome, "success");
    assert.equal(readFileSync(markerPath, "utf8"), "ok");
  } finally {
    rmSync(runbookDir, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});
