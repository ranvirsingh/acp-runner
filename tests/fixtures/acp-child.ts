import { Readable } from "node:stream";
import { appendFileSync, writeFileSync } from "node:fs";
import * as acp from "@agentclientprotocol/sdk";

const mode = process.argv.find((arg) => arg.startsWith("--mode="))?.slice(7) ?? process.env.ACP_FIXTURE_MODE ?? "ok";
const capture = process.argv.find((arg) => arg.startsWith("--capture="))?.slice(10);
const fragment = Number(process.env.ACP_FIXTURE_FRAGMENT ?? "0");
const pidFile = process.env.ACP_FIXTURE_PID_FILE;

if (pidFile) {
  writeFileSync(pidFile, String(process.pid));
}

if (mode === "split-stderr") {
  process.stderr.write("HEL");
  process.stderr.write("LO\nWOR");
  process.stderr.write("LD");
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
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: mode === "no-mcp-http" ? {} : { mcpCapabilities: { http: true } },
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
    if (mode === "auth" && !authenticated) throw acp.RequestError.authRequired();
    if (mode === "exit-before-turn") {
      process.exit(13);
    }
    const metaFile = process.env.ACP_FIXTURE_META_FILE;
    if (metaFile) {
      writeFileSync(metaFile, JSON.stringify((ctx.params as { _meta?: unknown })._meta ?? null));
    }
    const requested = ctx.params.cwd;
    sessionId = requested ? `sess_${requested.replace(/[^a-z0-9]/gi, "").slice(-8)}` : sessionId;
    return {
      sessionId,
      configOptions:
        mode === "model-select"
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
                ],
              },
            ]
          : undefined,
    };
  })
  .onNotification(acp.methods.agent.session.cancel, () => {
    releaseTurn?.();
    releaseTurn = null;
  })
  .onRequest(acp.methods.agent.session.setConfigOption, async () => {
    return { configOptions: [] };
  })
  .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
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
      return { stopReason: "cancelled" };
    }

    const promptText = ctx.params.prompt.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n\n");

    const reply = mode === "unicode"
      ? "café 🎉 日本語"
      : mode === "large"
        ? "x".repeat(256 * 1024)
        : `echo:${promptText}`;

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
    return { stopReason: "end_turn" };
  });

app.connect(stream);

if (mode === "ignore-stdin") {
  process.stdin.resume();
}
