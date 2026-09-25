import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnCli } from "./helpers/run-cli.ts";

const fixturePath = join(fileURLToPath(import.meta.url), "../fixtures/acp-child.ts");

test("cli: SIGINT cancels the turn and exits non-zero", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-cancel-"));
  const yamlPath = join(dir, "agent.yaml");
  writeFileSync(
    yamlPath,
    [
      "name: cancel-demo",
      "provider: claude",
      "providers:",
      "  agentHarness:",
      "    claude:",
      "      command: bun",
      `      args: ["${fixturePath}"]`,
      "steps:",
      "  - id: work",
      "    do: work forever",
      "",
    ].join("\n"),
  );

  const child = spawnCli([yamlPath, "--cwd", dir], {
    env: { ACP_FIXTURE_MODE: "cancellable" },
  });

  try {
    let out = "";
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`turn never started: ${out}`)), 15000);
      child.stdout.on("data", (chunk: Buffer) => {
        out += chunk.toString();
        if (out.includes("step.start")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once("error", reject);
    });

    child.kill("SIGINT");

    const [code] = (await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
      child.once("exit", (c, s) => resolve([c, s]));
    })) as [number | null, NodeJS.Signals | null];

    assert.equal(code, 1);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});
