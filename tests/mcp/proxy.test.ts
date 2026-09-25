import assert from "node:assert/strict";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { McpProxy } from "../../src/mcp/proxy.ts";
import type { ResolvedMcpServer } from "../../src/types.ts";

const greet = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/mcp-tools/tools/greet.mjs",
);

function greetServer(): ResolvedMcpServer {
  return { type: "stdio", name: "greet", command: "node", args: [greet], env: [] };
}

async function connected(proxy: McpProxy): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await proxy.connectEndpoint(serverSide);
  const client = new Client({ name: "proxy-test", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

test("McpProxy: exposes downstream tools as server__tool", async () => {
  const proxy = new McpProxy([greetServer()]);
  await proxy.setScope({ greet: {} }, "one");
  const client = await connected(proxy);

  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name),
    ["greet__greet", "greet__shout"],
  );

  const called = await client.callTool({ name: "greet__greet", arguments: { name: "Ranvir" } });
  assert.deepEqual(called.content, [{ type: "text", text: "Hello Ranvir" }]);

  await client.close();
  await proxy.close();
});

test("McpProxy: a narrowed scope hides the tool, notifies, and refuses the call", async () => {
  const proxy = new McpProxy([greetServer()]);
  await proxy.setScope({ greet: {} }, "one");
  const client = await connected(proxy);
  let changes = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    changes += 1;
  });

  await proxy.setScope({}, "two");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(changes, 1);

  const listed = await client.listTools();
  assert.deepEqual(listed.tools, []);

  const refused = await client.callTool({ name: "greet__greet", arguments: { name: "Ranvir" } });
  assert.equal(refused.isError, true);
  const text = (refused.content as Array<{ text: string }>)[0].text;
  assert.match(text, /greet__greet/);
  assert.match(text, /two/);

  await client.close();
  await proxy.close();
});

test("McpProxy: a deny pattern filters tools within a server", async () => {
  const proxy = new McpProxy([greetServer()]);
  await proxy.setScope({ greet: { deny: ["gre*"] } }, "one");
  const client = await connected(proxy);
  assert.deepEqual(
    (await client.listTools()).tools.map((tool) => tool.name),
    ["greet__shout"],
  );
  await client.close();
  await proxy.close();
});

test("McpProxy: an allow pattern keeps only the named tools", async () => {
  const proxy = new McpProxy([greetServer()]);
  await proxy.setScope({ greet: { allow: ["greet"] } }, "one");
  const client = await connected(proxy);
  assert.deepEqual(
    (await client.listTools()).tools.map((tool) => tool.name),
    ["greet__greet"],
  );
  await client.close();
  await proxy.close();
});

test("McpProxy: a call to an unknown tool is refused, not routed", async () => {
  const proxy = new McpProxy([greetServer()]);
  await proxy.setScope({ greet: {} }, "one");
  const client = await connected(proxy);
  const refused = await client.callTool({ name: "nope", arguments: {} });
  assert.equal(refused.isError, true);
  await client.close();
  await proxy.close();
});

test("McpProxy: reads a resource and flattens a prompt", async () => {
  const fixture = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/mcp-catalogue.mjs");
  const proxy = new McpProxy([
    { type: "stdio", name: "cat", command: process.execPath, args: [fixture], env: [] },
  ]);
  assert.equal(await proxy.readResource("cat", "mem://schema"), "id integer");
  assert.equal(
    await proxy.getPrompt("cat", "review", { service: "checkout" }),
    "review checkout\n\nbe brief",
  );
  await assert.rejects(() => proxy.readResource("cat", "mem://blob"), /blob/);
  await assert.rejects(() => proxy.readResource("cat", "mem://huge"), /256/);
  await proxy.close();
});
