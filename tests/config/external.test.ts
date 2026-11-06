import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { externalReferences, missingExternalValues } from "../../src/config/external.ts";
import type { AgentYaml, RunnerConfig } from "../../src/types.ts";

function withRunbook(runbook: AgentYaml, files: Record<string, string>, fn: (config: RunnerConfig) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "acp-external-"));
  try {
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body, "utf8");
    fn({ yamlPath: join(dir, "agent.yaml"), cwd: dir, runbook });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const everywhere: AgentYaml = {
  mcpServers: {
    tracker: {
      type: "http",
      url: "https://${{ env.TRACKER_HOST }}/mcp",
      headers: { Authorization: "Bearer ${{ secrets.TRACKER_TOKEN }}" },
    },
    cloud: {
      command: "${{ env.CLOUD_BIN }}",
      args: ["--project", "${{ env.CLOUD_PROJECT }}"],
      env: { CLOUD_KEY: "${{ secrets.CLOUD_KEY }}" },
    },
  },
  steps: [
    { id: "inline", provider: "p", do: "Fix ${{ env.ISSUE_URL }} and ignore $${{ env.ESCAPED }}" },
    { id: "file", provider: "p", do: { file: "prompt.md" } },
    { id: "shell", run: "deploy --to ${{ env.TARGET }}" },
    { id: "argv", run: { command: "node", args: ["check.mjs", "${{ secrets.CHECK_TOKEN }}"] } },
    { id: "vars", provider: "p", do: "Use {{name}}", vars: { name: "plain" } },
  ],
};

test("externalReferences: collects every ${{ env }} and ${{ secrets }} name from prompts, commands and MCP servers", () => {
  withRunbook(everywhere, { "prompt.md": "Read ${{ env.ISSUE_URL }} in ${{ env.REPO_PATH }}" }, (config) => {
    assert.deepEqual(externalReferences(config), {
      env: ["CLOUD_BIN", "CLOUD_PROJECT", "ISSUE_URL", "REPO_PATH", "TARGET", "TRACKER_HOST"],
      secrets: ["CHECK_TOKEN", "CLOUD_KEY", "TRACKER_TOKEN"],
    });
  });
});

test("externalReferences: an unreadable prompt file adds nothing and does not throw", () => {
  withRunbook({ steps: [{ id: "file", provider: "p", do: { file: "missing.md" } }] }, {}, (config) => {
    assert.deepEqual(externalReferences(config), { env: [], secrets: [] });
  });
});

test("missingExternalValues: an unset env value, an unset secret and an empty secret are all reported at once", () => {
  const runbook: AgentYaml = {
    steps: [{ id: "one", run: "echo ${{ env.SET_EMPTY }} ${{ env.UNSET_ENV }} ${{ secrets.EMPTY_SECRET }} ${{ secrets.UNSET_SECRET }} ${{ secrets.GOOD }}" }],
  };
  withRunbook(runbook, {}, (config) => {
    assert.deepEqual(
      missingExternalValues(config, { SET_EMPTY: "", EMPTY_SECRET: "", GOOD: "value" }),
      ["env UNSET_ENV is not set", "secret EMPTY_SECRET is empty", "secret UNSET_SECRET is not set"],
    );
  });
});
