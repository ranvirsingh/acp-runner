import assert from "node:assert/strict";
import test from "node:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { runStepCheck } from "../src/runtime/engine.ts";
import { lintRunbook } from "../src/config/lint.ts";
import { collectStepInputs } from "../src/mcp/inputs.ts";
import { McpProxy } from "../src/mcp/proxy.ts";
import { loadConfig } from "../src/cli.ts";
import { resolveMcpServers, resolveStepScope } from "../src/config/yaml.ts";

const example = join(dirname(fileURLToPath(import.meta.url)), "../examples/hello-world");

test("hello-world: release MCP supplies issues, style and a review prompt with step-scoped tools", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "release example "));
  cpSync(example, cwd, { recursive: true });
  const config = loadConfig({ yamlPath: join(cwd, "agent.yaml"), cwd, trace: "off" });
  const proxy = new McpProxy(resolveMcpServers(config));
  const client = new Client({ name: "release-example-test", version: "0.0.0" });
  try {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await proxy.connectEndpoint(serverSide);
    await client.connect(clientSide);
    const collect = config.runbook.steps.find((step) => step.id === "collect")!;
    await proxy.setScope(resolveStepScope(config, collect), collect.id);
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ["release__list_issues"]);
    const result = await client.callTool({ name: "release__list_issues", arguments: { release: "1.2.0" } });
    const content = result.content as Array<{ type: string; text: string }>;
    const issues = JSON.parse(content[0].text);
    assert.deepEqual(issues.map((issue: { id: string }) => issue.id), ["TASK-101", "TASK-102", "TASK-103", "TASK-104"]);
    assert.equal(issues.find((issue: { id: string }) => issue.id === "TASK-104").status, "open");
    assert.equal((await client.callTool({ name: "release__list_issues", arguments: { release: "9.9.9" } })).isError, true);
    const draft = config.runbook.steps.find((step) => step.id === "draft")!;
    assert.match((await collectStepInputs(config, draft, proxy)).vars.release_style, /Upgrade notes/);
    const review = config.runbook.steps.find((step) => step.id === "review")!;
    await proxy.setScope(resolveStepScope(config, review), review.id);
    assert.deepEqual((await client.listTools()).tools, []);
    assert.equal((await client.callTool({ name: "release__list_issues", arguments: { release: "1.2.0" } })).isError, true);
    const prompt = (await collectStepInputs(config, review, proxy)).body ?? "";
    assert.match(prompt, /1\.2\.0/);
    assert.match(prompt, /issues\.json/);
    assert.match(prompt, /release-notes\.md/);
  } finally {
    await client.close();
    await proxy.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("hello-world: the complete runbook lints without vendor credentials", () => {
  assert.deepEqual(lintRunbook(join(example, "agent.yaml")), []);
});

test("hello-world: release checks require the shipped issue hand-off and correctly grouped notes", () => {
  const cwd = mkdtempSync(join(tmpdir(), "hello world "));
  try {
    writeFileSync(join(cwd, "release.txt"), "1.2.0\n");
    const config = loadConfig({ yamlPath: join(example, "agent.yaml"), cwd, trace: "off" });
    const check = config.runbook.steps.find((step) => step.id === "verify");
    assert.ok(check);
    assert.equal(runStepCheck(config, check).outcome, "failure");
    const shipped = JSON.parse(readFileSync(join(example, "tools/issues.json"), "utf8"))
      .filter((issue: { status: string; release: string }) => issue.status === "shipped" && issue.release === "1.2.0");
    const notes = "# Taskboard 1.2.0\n\nFocus on your tasks and keep their order.\n\n## Features\n- TASK-101: Filter by assignee; saved per browser.\n\n## Fixes\n- TASK-102: Task order survives reconnects.\n\n## Upgrade notes\n- TASK-103: CSV uses status instead of state; update import scripts.\n";
    writeFileSync(join(cwd, "issues.json"), JSON.stringify(shipped));
    writeFileSync(join(cwd, "release-notes.md"), notes);
    assert.equal(runStepCheck(config, check).outcome, "success");
    for (const badNotes of [
      "Hello, world!\n",
      notes.replace("TASK-102", "TASK-104"),
      notes.replace("TASK-102", "TASK-099"),
      notes.replace("TASK-102", "a fix"),
      notes.replace("## Upgrade notes", "## Other"),
      notes.replace("Taskboard 1.2.0", "Taskboard 1.1.0"),
      notes.replace("## Features", "## Fixes").replace("## Fixes\n- TASK-102", "## Features\n- TASK-102"),
    ]) {
      writeFileSync(join(cwd, "release-notes.md"), badNotes);
      assert.equal(runStepCheck(config, check).outcome, "failure", badNotes);
    }
    writeFileSync(join(cwd, "release-notes.md"), notes);
    writeFileSync(join(cwd, "issues.json"), JSON.stringify(shipped.slice(1)));
    assert.equal(runStepCheck(config, check).outcome, "failure");
    writeFileSync(join(cwd, "issues.json"), JSON.stringify(shipped.map((issue: object) => ({ ...issue, details: "Invented" }))));
    assert.equal(runStepCheck(config, check).outcome, "failure");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("hello-world: the input shell gate rejects missing, empty and unknown releases", () => {
  const cwd = mkdtempSync(join(tmpdir(), "release input "));
  cpSync(example, cwd, { recursive: true });
  try {
    const config = loadConfig({ yamlPath: join(cwd, "agent.yaml"), cwd, trace: "off" });
    const check = config.runbook.steps.find((step) => step.id === "check-inputs");
    assert.ok(check);
    rmSync(join(cwd, "release.txt"));
    const missing = runStepCheck(config, check);
    assert.equal(missing.outcome, "failure");
    assert.match(missing.output, /input:.*release.txt/);
    for (const release of ["", "  \n", "9.9.9\n"]) {
      writeFileSync(join(cwd, "release.txt"), release);
      assert.equal(runStepCheck(config, check).outcome, "failure");
    }
    for (const release of ["1.1.0\n", " 1.2.0 \r\n"]) {
      writeFileSync(join(cwd, "release.txt"), release);
      assert.equal(runStepCheck(config, check).outcome, "success");
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
