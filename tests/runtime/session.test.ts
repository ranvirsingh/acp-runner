import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AcpSession } from "../../src/runtime/session.ts";
import type { ProviderSpec } from "../../src/runtime/providers.ts";

const fixturePath = join(fileURLToPath(import.meta.url), "../../fixtures/acp-child.ts");

function fixtureSpec(overrides: Partial<ProviderSpec> = {}): ProviderSpec {
  return { id: "claude", command: "bun", args: [fixturePath], ...overrides };
}

function fixtureEnv(mode = "ok"): Record<string, string> {
  return { ACP_FIXTURE_MODE: mode };
}

test("AcpSession: uses the saved login when the adapter also advertises API-key authentication", async () => {
  const session = await AcpSession.spawn(fixtureSpec({ id: "reviewer" }), {
    cwd: "/tmp",
    env: fixtureEnv("cached-auth"),
    quiet: true,
  });
  try {
    assert.equal(await session.prompt([{ type: "text", text: "Review" }]), "echo:Review");
  } finally {
    await session.close();
  }
});

test("AcpSession: authenticates and retries session creation when the adapter requires login", async () => {
  const session = await AcpSession.spawn(fixtureSpec(), {
    cwd: "/tmp",
    env: fixtureEnv("auth"),
    quiet: true,
  });
  try {
    assert.equal(await session.prompt([{ type: "text", text: "Review" }]), "echo:Review");
  } finally {
    await session.close();
  }
});

test("AcpSession: nested npx does not inherit the runner's package selection", async () => {
  const previous = process.env.npm_config_package;
  const cwd = mkdtempSync(join(tmpdir(), "acp-npx-session-"));
  let session: AcpSession | undefined;
  process.env.npm_config_package = join(cwd, "outer-runner.tgz");
  try {
    session = await AcpSession.spawn(fixtureSpec({
      command: "npx",
      args: ["--offline", "--no", "tsx", fixturePath],
    }), {
      cwd,
      env: fixtureEnv(),
      quiet: true,
    });
    assert.equal(await session.prompt([{ type: "text", text: "nested npx" }]), "echo:nested npx");
  } finally {
    await session?.close();
    if (previous === undefined) delete process.env.npm_config_package;
    else process.env.npm_config_package = previous;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("AcpSession: spawns, prompts, and closes cleanly", async () => {
  const driver = fixtureSpec();
  const session = await AcpSession.spawn(driver, {
    cwd: "/tmp",
    env: fixtureEnv(),
    quiet: true,
  });

  assert.equal(session.state, "ready");
  assert.ok(session.sessionId);

  const reply = await session.prompt([{ type: "text", text: "hello world" }]);
  assert.equal(reply, "echo:hello world");

  await session.close();
  assert.equal(session.state, "closed");
});

test("AcpSession: auto-approves permissions seamlessly", async () => {
  const driver = fixtureSpec();
  let permissionEvent: any = null;

  const session = await AcpSession.spawn(driver, {
    cwd: "/tmp",
    env: fixtureEnv("permission"),
    quiet: true,
    onPermissionRequested: (pending) => {
      permissionEvent = pending;
    },
  });

  const reply = await session.prompt([{ type: "text", text: "needs-perm" }]);
  assert.equal(reply, "echo:needs-perm");
  assert.ok(permissionEvent);
  assert.equal(permissionEvent.toolCallId, "tool_1");

  await session.close();
});

test("AcpSession: needsSwap detects provider, model, and server changes", async () => {
  const driver = fixtureSpec();
  const session = await AcpSession.spawn(driver, {
    cwd: "/tmp",
    model: "sonnet-3.5",
    mcpServers: [{ type: "stdio", name: "srv1", command: "cmd", args: [], env: [] }],
    env: fixtureEnv("model-select"),
    quiet: true,
  });

  assert.equal(session.needsSwap("claude", "sonnet-3.5"), false);
  assert.equal(session.needsSwap("codex", "sonnet-3.5"), true);
  assert.equal(session.needsSwap("claude", "opus-3"), true);

  await session.close();
});

test("AcpSession: a proxy uses http when the agent reports the capability", async () => {
  const driver = fixtureSpec();
  const session = await AcpSession.spawn(driver, {
    cwd: "/tmp",
    env: fixtureEnv(),
    quiet: true,
    proxy: {
      entryName: "runner",
      listenHttp: async () => "http://127.0.0.1:4242/mcp",
    },
  });

  assert.deepEqual(session.registeredMcpServers, [
    { type: "http", name: "runner", url: "http://127.0.0.1:4242/mcp", headers: [] },
  ]);

  await session.close();
});

test("AcpSession: a proxy fails at spawn by provider name when the agent reports no http", async () => {
  await assert.rejects(
    () =>
      AcpSession.spawn(fixtureSpec(), {
        cwd: "/tmp",
        env: fixtureEnv("no-mcp-http"),
        quiet: true,
        proxy: {
          entryName: "runner",
          listenHttp: async () => "http://127.0.0.1:1/mcp",
        },
      }),
    /claude: cannot host the runner MCP proxy: the agent reports no http MCP transport/,
  );
});

test("AcpSession: handles child crash on start", async () => {
  const driver = fixtureSpec();
  await assert.rejects(
    () =>
      AcpSession.spawn(driver, {
        cwd: "/tmp",
        env: fixtureEnv("crash-on-start"),
        quiet: true,
      }),
    /exited/i,
  );
});

test("AcpSession: session/new carries no vendor _meta payload", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-meta-"));
  const metaFile = join(dir, "meta.json");
  try {
    const session = await AcpSession.spawn(fixtureSpec(), {
      cwd: "/tmp",
      model: "claude-sonnet-5",
      env: { ...fixtureEnv("model-select"), ACP_FIXTURE_META_FILE: metaFile },
      quiet: true,
    });
    await session.close();
    assert.equal(readFileSync(metaFile, "utf8"), "null");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AcpSession: cancel ends an in-flight turn over the protocol", async () => {
  const session = await AcpSession.spawn(fixtureSpec(), {
    cwd: "/tmp",
    env: fixtureEnv("cancellable"),
    quiet: true,
  });

  const turn = session.prompt([{ type: "text", text: "work forever" }]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(session.state, "streaming");

  await session.cancel();

  await assert.rejects(turn, /cancelled/);
  assert.equal(session.state, "ready");

  await session.close();
});

test("AcpSession: cancel on an idle session is a no-op", async () => {
  const session = await AcpSession.spawn(fixtureSpec(), {
    cwd: "/tmp",
    env: fixtureEnv(),
    quiet: true,
  });

  await session.cancel();
  assert.equal(session.state, "ready");

  const reply = await session.prompt([{ type: "text", text: "still works" }]);
  assert.equal(reply, "echo:still works");

  await session.close();
});
