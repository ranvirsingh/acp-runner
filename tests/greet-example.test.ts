import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const server = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "tests/fixtures/mcp-tools/tools/greet.mjs",
);

async function ask(requests: unknown[]): Promise<Record<string, unknown>[]> {
  const child = spawn("node", [server], { stdio: ["pipe", "pipe", "pipe"] });
  const replies: Record<string, unknown>[] = [];
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) replies.push(JSON.parse(line));
    }
  });
  for (const request of requests) {
    child.stdin.write(`${JSON.stringify(request)}\n`);
  }
  child.stdin.end();
  await new Promise((resolve) => child.once("exit", resolve));
  return replies;
}

test("the mcp-tools example server answers initialize, tools/list and tools/call", async () => {
  const replies = await ask([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "greet", arguments: { name: "Ranvir" } },
    },
  ]);

  assert.equal(replies.length, 3);
  assert.deepEqual(
    replies.map((reply) => reply.id),
    [1, 2, 3],
  );

  const initialize = replies[0].result as { serverInfo: { name: string } };
  assert.equal(initialize.serverInfo.name, "mcp-tools-greet");

  const listed = replies[1].result as {
    tools: Array<{ name: string; inputSchema: { required: string[] } }>;
  };
  assert.deepEqual(
    listed.tools.map((tool) => tool.name),
    ["greet", "shout"],
  );
  assert.deepEqual(listed.tools[0].inputSchema.required, ["name"]);

  const called = replies[2].result as { content: Array<{ type: string; text: string }> };
  assert.deepEqual(called.content, [{ type: "text", text: "Hello Ranvir" }]);
});

test("the mcp-tools example server refuses a greet with no name", async () => {
  const replies = await ask([
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "greet", arguments: {} } },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "greet", arguments: { name: "  " } },
    },
  ]);

  assert.equal(replies.length, 2);
  for (const reply of replies) {
    const result = reply.result as { isError: boolean; content: Array<{ text: string }> };
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, "greet needs a name");
  }
});

test("the mcp-tools example scopes each step and stays on one body", async () => {
  const { loadAgentYaml, needsNewBody, resolveStepScope } = await import("../src/config/yaml.ts");
  const yamlPath = join(dirname(fileURLToPath(import.meta.url)), "..", "tests/fixtures/mcp-tools/agent.yaml");
  const runbook = loadAgentYaml(yamlPath);
  const config = { yamlPath, cwd: "/tmp/project", runbook };

  assert.deepEqual(resolveStepScope(config, runbook.steps[0]), { greet: { allow: ["greet"] } });
  assert.deepEqual(resolveStepScope(config, runbook.steps[1]), { greet: { deny: ["shout"] } });
  assert.deepEqual(resolveStepScope(config, runbook.steps[3]), {});
  assert.equal(needsNewBody({ provider: "claude" }, { provider: "claude" }), false);
});
