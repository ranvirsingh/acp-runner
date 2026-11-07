import { Readable } from "node:stream";
import { appendFileSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import * as acp from "@agentclientprotocol/sdk";

const mode = process.argv.find((arg) => arg.startsWith("--mode="))?.slice(7) ?? process.env.ACP_FIXTURE_MODE ?? "ok";
const capture = process.argv.find((arg) => arg.startsWith("--capture="))?.slice(10);
const fragment = Number(process.env.ACP_FIXTURE_FRAGMENT ?? "0");
const pidFile = process.env.ACP_FIXTURE_PID_FILE;
const reopen = process.env.ACP_FIXTURE_REOPEN ?? "none";
const reopenError = process.env.ACP_FIXTURE_REOPEN_ERROR;
const callsFile = process.env.ACP_FIXTURE_CALLS;

function logCall(method: string, sessionId?: string): void {
  if (callsFile) appendFileSync(callsFile, `${JSON.stringify({ method, sessionId })}\n`);
}

if (pidFile) {
  writeFileSync(pidFile, String(process.pid));
}

const heartbeat = process.env.ACP_FIXTURE_HEARTBEAT;
if (heartbeat) {
  setInterval(() => appendFileSync(heartbeat, "beat\n"), 50);
  process.stdin.on("error", () => {});
  process.stdout.on("error", () => {});
}

const envFile = process.env.ACP_FIXTURE_ENV_FILE;
if (envFile) {
  writeFileSync(envFile, process.env.ACP_GUARD_SECRET ?? "absent");
}

if (mode === "split-stderr") {
  process.stderr.write("HEL");
  process.stderr.write("LO\nWOR");
  process.stderr.write("LD");
}

if (mode === "stderr-on-close") {
  process.stdin.on("end", () => {
    process.stderr.write("SHUTDOWN NOISE\n");
  });
}

if (mode === "crash-on-start") {
  process.exit(7);
}

function outputStream(): WritableStream<Uint8Array> {
  return new WritableStream({
    write(chunk) {
      if (fragment <= 0) {
        process.stdout.write(Buffer.from(chunk));
        return;
      }
      for (let i = 0; i < chunk.byteLength; i += fragment) {
        process.stdout.write(Buffer.from(chunk.subarray(i, i + fragment)));
      }
    },
  });
}

const stream = acp.ndJsonStream(
  outputStream(),
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
);

let sessionId = "sess_fixture";
let mcpServers: acp.McpServer[] = [];
let authenticated = false;
let releaseTurn: (() => void) | null = null;

const app = acp
  .agent({ name: "acp-fixture" })
  .onRequest(acp.methods.agent.initialize, async (ctx) => {
    if (mode === "echo-client-info") {
      console.error(`clientInfo ${JSON.stringify(ctx.params.clientInfo)}`);
    }
    if (mode === "delay-init") {
      await new Promise(() => {});
    }
    if (mode === "exit-before-session") {
      setTimeout(() => process.exit(11), 0);
    }
    logCall("initialize");
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        ...(mode === "no-mcp-http" ? {} : { mcpCapabilities: { http: true } }),
        ...(reopen === "load" || reopen === "both" ? { loadSession: true } : {}),
        ...(reopen === "resume" || reopen === "both" ? { sessionCapabilities: { resume: {} } } : {}),
      },
      authMethods: mode === "cached-auth"
        ? [{ id: "openai-api-key", name: "API key" }, { id: "chatgpt", name: "ChatGPT" }]
        : mode === "auth" ? [{ id: "gemini-api-key", name: "API key" }] : [],
      agentInfo: { name: "acp-fixture", version: "0.0.0" },
    };
  })
  .onRequest(acp.methods.agent.authenticate, async () => {
    if (mode === "cached-auth") throw new Error("CODEX_API_KEY or OPENAI_API_KEY is not set");
    authenticated = true;
    return {};
  })
  .onRequest(acp.methods.agent.session.new, async (ctx) => {
    mcpServers = ctx.params.mcpServers;
    if (mode === "auth" && !authenticated) throw acp.RequestError.authRequired();
    if (mode === "exit-before-turn") {
      process.exit(13);
    }
    const metaFile = process.env.ACP_FIXTURE_META_FILE;
    if (metaFile) {
      writeFileSync(metaFile, JSON.stringify((ctx.params as { _meta?: unknown })._meta ?? null));
    }
    const requested = ctx.params.cwd;
    if (!isAbsolute(requested)) throw acp.RequestError.invalidParams(undefined, "cwd must be an absolute path");
    sessionId = requested ? `sess_${requested.replace(/[^a-z0-9]/gi, "").slice(-8)}` : sessionId;
    logCall("session/new", sessionId);
    return {
      sessionId,
      configOptions: configOptions(),
    };
  })
  .onRequest(acp.methods.agent.session.resume, async (ctx) => {
    logCall("session/resume", ctx.params.sessionId);
    reopened(ctx.params.sessionId, ctx.params.mcpServers ?? []);
    return { configOptions: configOptions() };
  })
  .onRequest(acp.methods.agent.session.load, async (ctx) => {
    logCall("session/load", ctx.params.sessionId);
    reopened(ctx.params.sessionId, ctx.params.mcpServers);
    await ctx.client.notify(acp.methods.client.session.update, {
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "replayed-history" } },
    });
    return { configOptions: configOptions() };
  })
  .onNotification(acp.methods.agent.session.cancel, () => {
    releaseTurn?.();
    releaseTurn = null;
  })
  .onRequest(acp.methods.agent.session.setConfigOption, async (ctx) => {
    const offered = ["fixture-model", "other", "test-model"];
    if (mode === "strict-model" && !offered.includes(String(ctx.params.value))) {
      throw acp.RequestError.invalidParams(undefined, `unknown model ${String(ctx.params.value)}`);
    }
    return { configOptions: [] };
  })
  .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
    logCall("session/prompt", ctx.params.sessionId);
    return prompt(ctx);
  });

function reopened(id: string, servers: acp.McpServer[]): void {
  if (reopenError === "not-found") throw acp.RequestError.resourceNotFound(id);
  if (reopenError === "auth") throw acp.RequestError.authRequired();
  sessionId = id;
  mcpServers = servers;
}

function configOptions() {
  return mode !== "no-model-option"
    ? [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select" as const,
          currentValue: "fixture-model",
          options: [
            { value: "fixture-model", name: "Fixture" },
            { value: "other", name: "Other" },
            { value: "test-model", name: "Test" },
          ],
        },
      ]
    : undefined;
}

async function prompt(ctx: any): Promise<acp.PromptResponse> {
    if (capture) appendFileSync(capture, `${JSON.stringify(ctx.params)}\n`);
    if (mode === "reject-prompt") throw new Error("fixture prompt rejected");
    if (mode === "exit-during-prompt") {
      process.exit(17);
    }
    if (mode === "hang") {
      await new Promise(() => {});
    }
    if (mode === "cancellable") {
      await new Promise<void>((resolve) => {
        releaseTurn = resolve;
      });
      return { stopReason: "cancelled" as const };
    }

    const promptText = ctx.params.prompt.flatMap((block: acp.ContentBlock) => block.type === "text" ? [block.text] : []).join("\n\n");

    let reply = mode === "unicode"
      ? "café 🎉 日本語"
      : mode === "large"
        ? "x".repeat(256 * 1024)
        : `echo:${promptText}`;

    if (mode === "call-tools") {
      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
      const server = mcpServers.find((server) => "type" in server && server.type === "http");
      if (!server || !("url" in server)) throw new Error("fixture needs an HTTP MCP server");
      const client = new Client({ name: "fixture", version: "0.0.0" });
      const results: unknown[] = [];
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(server.url), {
          requestInit: { headers: Object.fromEntries(server.headers.map(({ name, value }) => [name, value])) },
        }));
        for (const name of (process.env.ACP_FIXTURE_TOOLS ?? "").split(",").filter(Boolean)) {
          results.push(await client.callTool({ name, arguments: {} }).then((result) => result.content, (error) => String(error)));
        }
      } finally {
        await client.close();
      }
      reply = JSON.stringify(results);
    }

    if (mode === "mcp-http") {
      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
      const server = mcpServers.find((server) => "type" in server && server.type === "http");
      if (!server || !("url" in server)) throw new Error("fixture needs an HTTP MCP server");
      const client = new Client({ name: "fixture", version: "0.0.0" });
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(server.url), {
          requestInit: { headers: Object.fromEntries(server.headers.map(({ name, value }) => [name, value])) },
        }));
        const result = await client.callTool({ name: "greet__greet", arguments: { name: "npm" } });
        reply = JSON.stringify(result.content);
      } finally {
        await client.close();
      }
    }

    if (mode === "permission") {
      await ctx.client.request(acp.methods.client.session.requestPermission, {
        sessionId,
        toolCall: { toolCallId: "tool_1", title: "Bash" },
        options: [
          { optionId: "reject", name: "Reject", kind: "reject_once" },
          { optionId: "allow", name: "Allow", kind: "allow_once" },
        ],
      });
    }

    if (mode === "write-file") {
      await ctx.client.request(acp.methods.client.fs.writeTextFile, {
        sessionId,
        path: "/tmp/acp-fixture-test.txt",
        content: "test",
      });
    }



    await ctx.client.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "secret-thought" },
      },
    });
    await ctx.client.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: reply },
      },
    });
    return { stopReason: "end_turn" as const };
}

app.connect(stream);

if (mode === "ignore-stdin") {
  process.stdin.resume();
}
