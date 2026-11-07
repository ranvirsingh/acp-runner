import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createJournal, journalWriter, readFeedback, readJournal, type JournalEvent } from "../../src/runtime/journal.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent, runStepCheck } from "../../src/runtime/engine.ts";
import type { AgentYaml, RunnerConfig, SessionContext } from "../../src/types.ts";

const fixturePath = join(fileURLToPath(import.meta.url), "../../fixtures/acp-child.ts");
const fixtureProvider = { command: "bun", args: [fixturePath], model: "test-model" };

function configFor(runbook: AgentYaml): RunnerConfig {
  return {
    yamlPath: "agent.yaml",
    cwd: "/tmp/project",
    runbook: {
      ...runbook,
      providers: { claude: fixtureProvider, ...runbook.providers },
      steps: runbook.steps.map((step) =>
        step.provider || (step.do === undefined && !step.do) ? step : { ...step, provider: "claude" },
      ),
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

test("runAgent: a model step with no provider fails the run instead of picking one", async () => {
  const config: RunnerConfig = {
    yamlPath: "agent.yaml",
    cwd: "/tmp/project",
    runbook: { providers: { claude: fixtureProvider }, steps: [{ id: "one", do: "Ship it" }] },
  };
  const result = await runAgent({ config });
  assert.equal(result.outcome, "failed");
  assert.match(result.context.lastError ?? "", /no provider/);
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

test("runAgent: a harness that fails to start fails the run, even with another harness declared", async () => {
  const config = configFor({
    providers: { broken: { command: "no-such-binary-1111", model: "test-model" } },
    steps: [{ id: "step1", provider: "broken", do: "Say hello" }],
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
        claude: { command: "sh", args: ["-c", `echo x >> ${spawnLog}; exec bun ${fixturePath}`], model: "test-model" },
      },
      mcpServers: { greet: { command: "node", args: [greetTool] } },
      steps: [
        { id: "one", do: "first", mcpServers: { greet: { allow: ["greet"] } } },
        { id: "two", do: "second", mcpServers: [] },
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
    mcpServers: { cat: { command: process.execPath, args: [catalogueTool] } },
    steps: [
      {
        id: "one",
        do: "ddl is {{schema_ddl}}",
        vars: { schema_ddl: { resource: "mem://schema", mcpServer: "cat" } },
      },
    ],
  });
  const result = await runAgent({ config });
  assert.equal(result.outcome, "finished");
  assert.equal(result.context.turnText, "echo:ddl is id integer");
});

test("runAgent: a step scalar overrides a runbook resource variable of the same name", async () => {
  const config = configFor({
    vars: { schema_ddl: { resource: "mem://schema", mcpServer: "cat" } },
    mcpServers: { cat: { command: process.execPath, args: [catalogueTool] } },
    steps: [{ id: "one", do: "ddl is {{schema_ddl}}", vars: { schema_ddl: "name text" } }],
  });
  const result = await runAgent({ config });
  assert.equal(result.outcome, "finished");
  assert.equal(result.context.turnText, "echo:ddl is name text");
});

test("runAgent: a runbook resource shadowed by a step scalar is never fetched", async () => {
  const config = configFor({
    vars: { schema_ddl: { resource: "mem://absent", mcpServer: "cat" } },
    mcpServers: { cat: { command: process.execPath, args: [catalogueTool] } },
    steps: [{ id: "one", do: "ddl is {{schema_ddl}}", vars: { schema_ddl: "name text" } }],
  });
  const result = await runAgent({ config });
  assert.equal(result.outcome, "finished");
  assert.equal(result.context.turnText, "echo:ddl is name text");
});

test("runAgent: a missing resource fails the step", async () => {
  const config = configFor({
    mcpServers: { cat: { command: process.execPath, args: [catalogueTool] } },
    steps: [
      {
        id: "one",
        do: "ddl is {{schema_ddl}}",
        vars: { schema_ddl: { resource: "mem://absent", mcpServer: "cat" } },
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

test("runStepCheck: a run timeout bounds the command", async () => {
  const config = configFor({ steps: [] });
  const result = await runStepCheck(config, {
    id: "check",
    run: { command: "node -e 'setTimeout(() => {}, 500)'", timeout: 50 },
  });
  assert.equal(result.outcome, "failure");
});

test("runStepCheck: ACP_RUNNER_STEP_TIMEOUT does not change the default", async () => {
  const config = configFor({ steps: [] });
  process.env.ACP_RUNNER_STEP_TIMEOUT = "50";
  try {
    const result = await runStepCheck(config, { id: "check", run: "node -e 'setTimeout(() => {}, 500)'" });
    assert.equal(result.outcome, "success");
  } finally {
    delete process.env.ACP_RUNNER_STEP_TIMEOUT;
  }
});

test("runStepCheck: an abort during a long command stops it promptly", async () => {
  const config = configFor({ steps: [] });
  const controller = new AbortController();
  const started = Date.now();
  setTimeout(() => controller.abort(), 200);
  const result = await runStepCheck(config, { id: "check", run: "sleep 5" }, undefined, controller.signal);
  assert.equal(result.outcome, "failure");
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started}ms`);
});

function journalState(events: JournalEvent[] = [], failAfter?: string) {
  const dir = mkdtempSync(join(tmpdir(), "engine-state-"));
  const write = journalWriter(dir);
  const written: JournalEvent[] = [];
  const journal = createJournal((event) => {
    if (failAfter && written.some((item) => item.event === failAfter)) throw new Error("injected journal failure");
    write(event);
    written.push(event);
  });
  return { state: { dir, journal, events }, written };
}

function shape(events: JournalEvent[]): string[] {
  return events.map((event) => {
    const { event: name, ...rest } = event as Record<string, unknown> & { event: string };
    const keep = ["step", "visit", "origin", "kind", "outcome", "why", "next", "swap", "stopReason", "feedback", "reason"];
    return [name, ...keep.filter((key) => key in rest).map((key) => `${key}=${String(rest[key])}`)].join(" ");
  });
}

function validateTwice(dir: string): string {
  const counter = join(dir, "validate-count");
  return `node -e 'const fs=require("fs"); const c=Number(fs.existsSync("${counter}")?fs.readFileSync("${counter}","utf8"):0)+1; fs.writeFileSync("${counter}",String(c)); if (c<2) { console.log("validate says broken"); process.exit(1) }'`;
}

test("journal: implement → validate → implement writes the 8.1 event order and sends the saved feedback", async () => {
  const { state, written } = journalState();
  const capture = join(state.dir, "capture.jsonl");
  const config = configFor({
    providers: { builder: { command: "bun", args: [fixturePath, `--capture=${capture}`], model: "test-model" } },
    steps: [
      { id: "implement", provider: "builder", do: "Implement", on: { success: "validate" } },
      { id: "validate", run: validateTwice(state.dir), on: { failure: "implement" } },
    ],
  });
  const result = await runAgent({ config, state });
  assert.equal(result.outcome, "finished");
  assert.deepEqual(shape(written), [
    "run_started",
    "step_started step=implement visit=1",
    "session_attached step=implement visit=1 origin=new",
    "prompt_sent step=implement visit=1 kind=step",
    "prompt_completed step=implement visit=1 stopReason=end_turn",
    "step_completed step=implement visit=1 outcome=success why=on.success next=validate",
    "step_started step=validate visit=1",
    "step_completed step=validate visit=1 outcome=failure why=on.failure next=implement feedback=feedback/validate-1.json",
    "step_started step=implement visit=2",
    "session_attached step=implement visit=2 origin=carried",
    "prompt_sent step=implement visit=2 kind=step feedback=feedback/validate-1.json",
    "prompt_completed step=implement visit=2 stopReason=end_turn feedback=feedback/validate-1.json",
    "step_completed step=implement visit=2 outcome=success why=on.success next=validate",
    "step_started step=validate visit=2",
    "step_completed step=validate visit=2 outcome=success why=fallthrough next=END",
    "run_finished outcome=finished",
  ]);
  const started = written[0] as Extract<JournalEvent, { event: "run_started" }>;
  assert.match(started.runbook, /^sha256:/);
  assert.match(started.inputs, /^sha256:/);
  assert.equal(started.cwd, config.cwd);
  const attached = written.filter((event) => event.event === "session_attached") as Array<{ sessionId: string }>;
  assert.equal(attached[0].sessionId, attached[1].sessionId);
  assert.match(readFeedback(state.dir, "feedback/validate-1.json").output, /validate says broken/);
  const prompts = readFileSync(capture, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.match(JSON.stringify(prompts[1].prompt), /validate says broken/);
});

test("journal: terminal targets, a swap and a failure with no transition", async () => {
  {
    const { state, written } = journalState();
    const config = configFor({
      providers: { reviewer: fixtureProvider },
      steps: [
        { id: "reset_review", run: "true" },
        { id: "review", provider: "reviewer", do: "Review", on: { success: "END" } },
      ],
    });
    const result = await runAgent({ config, state });
    assert.equal(result.outcome, "finished");
    assert.deepEqual(shape(written).slice(1, 3), [
      "step_started step=reset_review visit=1",
      "step_completed step=reset_review visit=1 outcome=success why=fallthrough next=review swap=true",
    ]);
    assert.deepEqual(shape(written).slice(-2), [
      "step_completed step=review visit=1 outcome=success why=on.success next=END",
      "run_finished outcome=finished",
    ]);
  }
  {
    const { state, written } = journalState();
    const config = configFor({ steps: [{ id: "only", run: "false" }] });
    const result = await runAgent({ config, state });
    assert.equal(result.outcome, "failed");
    assert.deepEqual(shape(written).slice(-2, -1), ["step_completed step=only visit=1 outcome=failure why=null next=FAIL feedback=feedback/only-1.json"]);
    assert.match(shape(written).at(-1)!, /^run_finished outcome=failed reason=/);
  }
  {
    const { state, written } = journalState();
    const config = configFor({ steps: [{ id: "gate", run: "false", on: { failure: "FAIL" } }] });
    await runAgent({ config, state });
    assert.match(shape(written).at(-2)!, /why=on.failure next=FAIL/);
  }
});

test("journal: a prompt error from the agent fails the step with why null and keeps the pending feedback", async () => {
  const { state, written } = journalState();
  process.env.ACP_FIXTURE_MODE = "reject-prompt";
  try {
    const config = configFor({ steps: [{ id: "work", do: "Work" }] });
    const result = await runAgent({ config, state });
    assert.equal(result.outcome, "failed");
    assert.deepEqual(shape(written).slice(-2, -1), ["step_completed step=work visit=1 outcome=failure why=null next=FAIL feedback=feedback/work-1.json"]);
  } finally {
    delete process.env.ACP_FIXTURE_MODE;
  }
});

test("journal: an agent that dies during a prompt stops the run with the visit open", async () => {
  const { state, written } = journalState();
  process.env.ACP_FIXTURE_MODE = "exit-during-prompt";
  try {
    const config = configFor({ steps: [{ id: "work", do: "Work" }] });
    const result = await runAgent({ config, state });
    assert.equal(result.outcome, "stopped");
    assert.equal(shape(written).at(-1), "prompt_sent step=work visit=1 kind=step");
  } finally {
    delete process.env.ACP_FIXTURE_MODE;
  }
});

test("journal: an agent that does not spawn stops the run without step_completed", async () => {
  const { state, written } = journalState();
  const config = configFor({
    providers: { broken: { command: "no-such-binary-1111", model: "test-model" } },
    steps: [{ id: "work", provider: "broken", do: "Work" }],
  });
  const result = await runAgent({ config, state });
  assert.equal(result.outcome, "stopped");
  assert.equal(shape(written).at(-1), "step_started step=work visit=1");
});

test("journal: a failed append starts no later action and stops the run", async () => {
  const { state, written } = journalState([], "session_attached");
  const capture = join(state.dir, "capture.jsonl");
  const config = configFor({
    providers: { builder: { command: "bun", args: [fixturePath, `--capture=${capture}`], model: "test-model" } },
    steps: [{ id: "work", provider: "builder", do: "Work" }],
  });
  const result = await runAgent({ config, state });
  assert.equal(result.outcome, "stopped");
  assert.equal(shape(written).at(-1), "session_attached step=work visit=1 origin=new");
  assert.equal(existsSync(capture), false);
  assert.equal(readJournal(state.dir).length, written.length);
});

test("journal: an abort stops the run with no terminal event", async () => {
  const { state, written } = journalState();
  const controller = new AbortController();
  const config = configFor({ steps: [{ id: "long", run: "sleep 5" }] });
  setTimeout(() => controller.abort(), 200);
  const result = await runAgent({ config, state, signal: controller.signal });
  assert.equal(result.outcome, "stopped");
  assert.equal(shape(written).at(-1), "step_started step=long visit=1");
});

test("without state the engine still fails an agent that dies, as before", async () => {
  process.env.ACP_FIXTURE_MODE = "exit-during-prompt";
  try {
    const result = await runAgent({ config: configFor({ steps: [{ id: "work", do: "Work" }] }) });
    assert.equal(result.outcome, "failed");
  } finally {
    delete process.env.ACP_FIXTURE_MODE;
  }
});
