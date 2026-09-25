import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent, runStepCheck } from "../../src/runtime/engine.ts";
import type { AgentYaml, RunnerConfig, SessionContext } from "../../src/types.ts";

const fixturePath = join(fileURLToPath(import.meta.url), "../../fixtures/acp-child.ts");
const fixtureProvider = { command: "bun", args: [fixturePath] };

function configFor(runbook: AgentYaml): RunnerConfig {
  return {
    yamlPath: "agent.yaml",
    cwd: "/tmp/project",
    runbook: {
      ...runbook,
      providers: {
        ...runbook.providers,
        agentHarness: { claude: fixtureProvider, ...runbook.providers?.agentHarness },
      },
    },
  };
}

test("runAgent: executes script-only agent to completion", async () => {
  const config = configFor({
    steps: [{ id: "step1", run: "echo step1" }],
  });
  const transitions: Array<{ prev: string; next: string }> = [];
  const result = await runAgent({
    config,
    onStateChange: (prev, next) => transitions.push({ prev, next }),
  });
  assert.equal(result.outcome, "finished");
  assert.ok(transitions.length > 0);
  assert.ok(transitions.some((t) => t.next === "finished"));
});

test("runAgent: the default fallback is claude, codex, gemini", async () => {
  const result = await runAgent({ config: configFor({ steps: [{ id: "one", run: "true" }] }) });
  assert.deepEqual(result.context.fallback, ["claude", "codex", "gemini"]);
});

test("runAgent: multi-step script agent executes sequentially", async () => {
  const config = configFor({
    steps: [
      { id: "step1", run: "echo step1" },
      { id: "step2", run: "echo step2" },
    ],
  });
  const result = await runAgent({ config });
  assert.equal(result.outcome, "finished");
});

test("runAgent: script step failure routes to on.failure and loops", async () => {
  const config = configFor({
    steps: [
      {
        id: "step1",
        run: "node -e 'process.exit(1)'",
        on: {
          failure: {
            target: "step1",
            maxAttempts: 2,
            fallback: "recovered",
          },
        },
      },
      {
        id: "recovered",
        run: "echo recovered",
      },
    ],
  });
  const result = await runAgent({ config });
  assert.equal(result.outcome, "finished");
});

test("runAgent: on.success: END terminates early cleanly", async () => {
  const config = configFor({
    steps: [
      { id: "step1", run: "echo ok", on: { success: "END" } },
      { id: "unreachable", run: "node -e 'process.exit(1)'" },
    ],
  });
  const result = await runAgent({ config });
  assert.equal(result.outcome, "finished");
});

test("runAgent: on.failure: FAIL fails the run immediately", async () => {
  const config = configFor({
    steps: [
      { id: "failing", run: "node -e 'process.exit(1)'", on: { failure: "FAIL" } },
      { id: "unreachable", run: "echo ok" },
    ],
  });
  const result = await runAgent({ config });
  assert.equal(result.outcome, "failed");
});

test("runAgent: passes SessionContext with cwd and step details", async () => {
  const config = configFor({ steps: [{ id: "step1", run: "echo ok" }] });
  let captured: SessionContext | null = null;
  await runAgent({
    config,
    onStateChange: (_p, _n, ctx) => {
      captured = ctx;
    },
  });
  assert.ok(captured);
  assert.equal((captured as SessionContext).cwd, "/tmp/project");
});

test("runAgent: executes model step with AcpSession and completes", async () => {
  const config = configFor({
    steps: [{ id: "model-step", do: "Say hello" }],
  });
  const result = await runAgent({ config });
  assert.equal(result.outcome, "finished");
});

test("runAgent: session is reused across consecutive steps with same provider", async () => {
  const config = configFor({
    steps: [
      { id: "step1", do: "Say step 1" },
      { id: "step2", do: "Say step 2" },
    ],
  });
  const spawns: string[] = [];
  const result = await runAgent({
    config,
    onStateChange: (_p, current) => {
      if (current === "spawning") spawns.push(current);
    },
  });
  assert.equal(result.outcome, "finished");
  assert.equal(spawns.length, 1);
  assert.equal(result.context.turnIndex, 2);
});

test("runAgent: post-turn run failure triggers retry on model step", async () => {
  const tmpFile = join(tmpdir(), `engine-retry-${Date.now()}.txt`);
  writeFileSync(tmpFile, "0");
  try {
    const config = configFor({
      steps: [
        {
          id: "retry-step",
          do: "Attempt something",
          run: `node -e 'const fs=require("fs"); const c=Number(fs.readFileSync("${tmpFile}","utf8"))+1; fs.writeFileSync("${tmpFile}",String(c)); process.exit(c >= 2 ? 0 : 1)'`,
          on: {
            failure: {
              target: "retry-step",
              maxAttempts: 2,
            },
          },
        },
      ],
    });
    const result = await runAgent({ config });
    assert.equal(result.outcome, "finished");
    assert.equal(result.context.turnIndex, 2);
  } finally {
    try {
      rmSync(tmpFile);
    } catch {}
  }
});

test("runAgent: spawn failure swaps to fallback provider", async () => {
  const config = configFor({
    providers: {
      agentHarness: { failing: { command: "no-such-binary-9999" } },
      fallback: ["failing", "claude"],
      onSpawnError: "swap",
    },
    steps: [{ id: "step1", provider: "failing", do: "Say hello" }],
  });

  const result = await runAgent({ config });
  assert.equal(result.outcome, "finished");
  assert.equal(result.context.provider, "claude");
  assert.ok(result.context.triedProviders.includes("failing"));
  assert.ok(result.context.triedProviders.includes("claude"));
});

test("runAgent: all fallbacks exhausted fails the run", async () => {
  const config = configFor({
    providers: {
      agentHarness: {
        fail1: { command: "no-such-binary-1111" },
        fail2: { command: "no-such-binary-2222" },
      },
      fallback: ["fail1", "fail2"],
      onSpawnError: "swap",
    },
    steps: [{ id: "step1", provider: "fail1", do: "Say hello" }],
  });

  const result = await runAgent({ config });
  assert.equal(result.outcome, "failed");
});

test("runAgent: script step receives variables in environment", async () => {
  const config = configFor({
    vars: { MY_CUSTOM_VAR: "magic_value_42" },
    steps: [
      {
        id: "check-env",
        run: "node -e 'if (process.env.MY_CUSTOM_VAR !== \"magic_value_42\") process.exit(1)'",
      },
    ],
  });
  const result = await runAgent({ config });
  assert.equal(result.outcome, "finished");
});


const greetTool = join(fileURLToPath(import.meta.url), "../../fixtures/mcp-tools/tools/greet.mjs");
const catalogueTool = join(fileURLToPath(import.meta.url), "../../fixtures/mcp-catalogue.mjs");

test("runAgent: two steps with different tool scopes share one session", async () => {
  const spawnLog = join(tmpdir(), `acp-spawns-${process.pid}-${Date.now()}`);
  try {
    const config = configFor({
      providers: {
        agentHarness: {
          claude: { command: "sh", args: ["-c", `echo x >> ${spawnLog}; exec bun ${fixturePath}`] },
        },
        mcpServers: { greet: { command: "node", args: [greetTool] } },
      },
      steps: [
        { id: "one", do: "first", servers: { greet: { allow: ["greet"] } } },
        { id: "two", do: "second", servers: [] },
      ],
    });
    const result = await runAgent({ config });
    assert.equal(result.outcome, "finished");
    assert.equal(readFileSync(spawnLog, "utf8").trim().split("\n").length, 1);
  } finally {
    rmSync(spawnLog, { force: true });
  }
});

test("runAgent: a step renders a resource variable fetched through the proxy", async () => {
  const config = configFor({
    providers: { mcpServers: { cat: { command: process.execPath, args: [catalogueTool] } } },
    steps: [
      {
        id: "one",
        do: "ddl is {{schema_ddl}}",
        vars: { schema_ddl: { resource: "mem://schema", server: "cat" } },
      },
    ],
  });
  const result = await runAgent({ config });
  assert.equal(result.outcome, "finished");
  assert.equal(result.context.turnText, "echo:ddl is id integer");
});

test("runAgent: a promptRef step takes its body from the server prompt catalogue", async () => {
  const config = configFor({
    vars: { service: "checkout" },
    providers: { mcpServers: { cat: { command: process.execPath, args: [catalogueTool] } } },
    steps: [
      {
        id: "one",
        promptRef: { server: "cat", name: "review", arguments: { service: "{{service}}" } },
      },
    ],
  });
  const result = await runAgent({ config });
  assert.equal(result.outcome, "finished");
  assert.equal(result.context.turnText, "echo:review checkout\n\nbe brief");
});

test("runAgent: a missing resource fails the step", async () => {
  const config = configFor({
    providers: { mcpServers: { cat: { command: process.execPath, args: [catalogueTool] } } },
    steps: [
      {
        id: "one",
        do: "ddl is {{schema_ddl}}",
        vars: { schema_ddl: { resource: "mem://absent", server: "cat" } },
      },
    ],
  });
  const result = await runAgent({ config });
  assert.equal(result.outcome, "failed");
  assert.match(result.context.lastError ?? "", /schema_ddl/);
});

test("runAgent: aborting mid-turn cancels the turn and fails the run", async () => {
  process.env.ACP_FIXTURE_MODE = "cancellable";
  try {
    const config = configFor({
      steps: [{ id: "work", provider: "claude", do: "work forever" }],
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);

    const result = await runAgent({ config, signal: controller.signal });

    assert.equal(result.outcome, "failed");
    assert.match(String(result.context.lastError), /cancel/i);
  } finally {
    delete process.env.ACP_FIXTURE_MODE;
  }
});

test("runAgent: abort still ends the run when the agent ignores cancel", async () => {
  process.env.ACP_FIXTURE_MODE = "hang";
  try {
    const config = configFor({
      steps: [{ id: "work", provider: "claude", do: "work forever" }],
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);

    const started = Date.now();
    const result = await runAgent({ config, signal: controller.signal });

    assert.equal(result.outcome, "failed");
    assert.ok(Date.now() - started < 5000);
  } finally {
    delete process.env.ACP_FIXTURE_MODE;
  }
});
