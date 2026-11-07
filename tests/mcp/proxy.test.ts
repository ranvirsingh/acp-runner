import assert from "node:assert/strict";
import test from "node:test";
import { dirname, join } from "node:path";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { JournalEvent } from "../../src/runtime/journal.ts";
import { fileURLToPath } from "node:url";
import { request } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { McpProxy } from "../../src/mcp/proxy.ts";
import type { ResolvedMcpServer } from "../../src/types.ts";
import { RUNNER_VERSION } from "../../src/version.ts";

const greet = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/mcp-tools/tools/greet.mjs",
);

function greetServer(): ResolvedMcpServer {
  return { type: "stdio", name: "greet", command: "node", args: [greet], env: [] };
}

test("McpProxy: HTTP requires authentication and rejects browser origins", async () => {
  const proxy = new McpProxy([greetServer()]);
  const client = new Client({ name: "http-test", version: "0.0.0" });
  try {
    await proxy.setScope({ greet: {} }, "one");
    const url = await proxy.listenHttp();
    assert.equal((await fetch(url, { method: "POST" })).status, 401);
    assert.equal((await fetch(url, {
      method: "POST", headers: { Authorization: "Bearer incorrect" },
    })).status, 401);
    const headers = Object.fromEntries(proxy.authHeaders.map(({ name, value }) => [name, value]));
    assert.equal((await fetch(url, {
      method: "POST", headers: { ...headers, Origin: "https://example.com" },
    })).status, 403);
    const invalidHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(url, { method: "POST", headers: { ...headers, Host: "attacker.example" } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(invalidHostStatus, 403);
    assert.equal((await fetch(`${url}/other`, { method: "POST", headers })).status, 404);
    assert.equal((await fetch(url, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ padding: "x".repeat(1024 * 1024) }),
    })).status, 413);
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
    assert.equal((await client.callTool({ name: "greet__greet", arguments: { name: "test" } })).isError, undefined);
    const sessionId = (client.transport as StreamableHTTPClientTransport).sessionId!;
    assert.equal((await fetch(url, {
      method: "POST", headers: { "mcp-session-id": sessionId },
    })).status, 401);
  } finally {
    await client.close();
    await proxy.close();
  }
});

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

test("McpProxy: reads a resource", async () => {
  const fixture = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/mcp-catalogue.mjs");
  const proxy = new McpProxy([
    { type: "stdio", name: "cat", command: process.execPath, args: [fixture], env: [] },
  ]);
  assert.equal(await proxy.readResource("cat", "mem://schema"), "id integer");
  await assert.rejects(() => proxy.readResource("cat", "mem://blob"), /blob/);
  await assert.rejects(() => proxy.readResource("cat", "mem://huge"), /256/);
  await proxy.close();
});

test("McpProxy: the endpoint reports the runner version", async () => {
  const proxy = new McpProxy([greetServer()]);
  const client = await connected(proxy);
  assert.equal(client.getServerVersion()?.version, RUNNER_VERSION);
  await client.close();
  await proxy.close();
});

test("McpProxy: downstream servers see the runner version", async () => {
  const fixture = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/mcp-catalogue.mjs");
  const proxy = new McpProxy([
    { type: "stdio", name: "cat", command: process.execPath, args: [fixture], env: [] },
  ]);
  assert.equal(await proxy.readResource("cat", "mem://client-version"), RUNNER_VERSION);
  await proxy.close();
});

test("McpProxy: refuses a tool call whose arguments carry a known secret, at any depth", async () => {
  const logged: string[] = [];
  const proxy = new McpProxy([greetServer()], (message) => logged.push(message), ["guard-secret-value-1"]);
  try {
    await proxy.setScope({ greet: {} }, "one");
    for (const args of [{ name: "x guard-secret-value-1" }, { name: "ok", extra: { deep: ["guard-secret-value-1"] } }]) {
      const result = await proxy.callTool("greet__greet", args);
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result.content), /tool \\"greet__greet\\" was refused: its arguments contain a secret/);
    }
    assert.ok(logged.some((line) => line.includes("greet__greet")));
    assert.ok(logged.every((line) => !line.includes("guard-secret-value-1")));
    const clean = await proxy.callTool("greet__greet", { name: "test" });
    assert.equal(clean.isError, undefined);
  } finally {
    await proxy.close();
  }
});

const ledgerTools = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/mcp-tools/tools/ledger.mjs");

function ledgerProxy() {
  const dir = mkdtempSync(join(tmpdir(), "ledger-"));
  const marker = join(dir, "marker");
  const release = join(dir, "release");
  const server: ResolvedMcpServer = {
    type: "stdio", name: "ledger", command: "node", args: [ledgerTools],
    env: [{ name: "LEDGER_MARKER", value: marker }, { name: "LEDGER_RELEASE", value: release }],
  };
  const proxy = new McpProxy([server]);
  proxy.enableLedger();
  const events: JournalEvent[] = [];
  let failNext = false;
  const append = async (event: JournalEvent) => {
    if (failNext) throw new Error("injected journal failure");
    events.push(event);
  };
  const marked = () => (existsSync(marker) ? readFileSync(marker, "utf8").trim().split("\n").filter(Boolean) : []);
  return { proxy, events, append, marked, release, fail: () => { failNext = true; } };
}

function text(result: { content: unknown; isError?: boolean }): string {
  return JSON.stringify(result.content);
}

test("ledger: a tool that may change something outside is recorded before and after the call", async () => {
  const l = ledgerProxy();
  try {
    await l.proxy.setScope({ ledger: {} }, "work");
    const turn = { step: "work", visit: 2, next: 4, append: l.append };
    l.proxy.openTurn(turn);
    const acted = await l.proxy.callTool("ledger__act", {});
    const labelled = await l.proxy.callTool("ledger__label", {});
    assert.equal(await l.proxy.closeTurn(), 6);
    assert.match(text(acted), /act done/);
    assert.match(text(labelled), /label done/);
    assert.deepEqual(l.events, [
      { event: "tool_started", step: "work", visit: 2, call: 4, server: "ledger", tool: "act" },
      { event: "tool_completed", step: "work", visit: 2, call: 4, isError: false },
      { event: "tool_started", step: "work", visit: 2, call: 5, server: "ledger", tool: "label" },
      { event: "tool_completed", step: "work", visit: 2, call: 5, isError: false },
    ]);
    assert.equal(await l.proxy.isIdempotent("ledger", "label"), true);
    assert.equal(await l.proxy.isIdempotent("ledger", "act"), false);
  } finally {
    await l.proxy.close();
  }
});

test("ledger A13: a readOnlyHint tool writes no ledger lines", async () => {
  const l = ledgerProxy();
  try {
    await l.proxy.setScope({ ledger: {} }, "work");
    l.proxy.openTurn({ step: "work", visit: 1, next: 1, append: l.append });
    assert.match(text(await l.proxy.callTool("ledger__peek", {})), /peek done/);
    await l.proxy.closeTurn();
    assert.deepEqual(l.events, []);
  } finally {
    await l.proxy.close();
  }
});

test("ledger A14: a call with no active turn is refused and never forwarded", async () => {
  const l = ledgerProxy();
  try {
    await l.proxy.setScope({ ledger: {} }, "script");
    const result = await l.proxy.callTool("ledger__act", {});
    assert.equal(result.isError, true);
    assert.match(text(result), /no agent turn/);
    assert.deepEqual(l.marked(), []);
  } finally {
    await l.proxy.close();
  }
});

test("ledger A11: a call whose reply is lost keeps tool_started without tool_completed", async () => {
  const l = ledgerProxy();
  try {
    await l.proxy.setScope({ ledger: {} }, "work");
    l.proxy.openTurn({ step: "work", visit: 1, next: 1, append: l.append });
    await assert.rejects(l.proxy.callTool("ledger__vanish", {}));
    await l.proxy.closeTurn();
    assert.deepEqual(l.marked(), ["vanish"]);
    assert.deepEqual(l.events.map((event) => event.event), ["tool_started"]);
  } finally {
    await l.proxy.close();
  }
});

test("ledger A15: after a failed append the second call in flight is rejected before it is forwarded, and closeTurn drains the first", async () => {
  const l = ledgerProxy();
  try {
    await l.proxy.setScope({ ledger: {} }, "work");
    l.proxy.openTurn({ step: "work", visit: 1, next: 1, append: l.append });
    const first = l.proxy.callTool("ledger__slow", {});
    while (l.events.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
    l.fail();
    const second = await l.proxy.callTool("ledger__act", {});
    assert.equal(second.isError, true);
    const later = await l.proxy.callTool("ledger__peek", {});
    assert.equal(later.isError, true);
    let drained = false;
    const closing = l.proxy.closeTurn().then(() => { drained = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(drained, false);
    writeFileSync(l.release, "");
    await closing;
    await first;
    assert.deepEqual(l.marked(), ["slow"]);
  } finally {
    await l.proxy.close();
  }
});
