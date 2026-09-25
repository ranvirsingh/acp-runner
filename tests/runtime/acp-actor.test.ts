import assert from "node:assert/strict";
import test from "node:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  SessionConfigSelectOption,
  SessionConfigSelectOptions,
} from "@agentclientprotocol/sdk";
import {
  extractText,
  flattenSelectValues,
  formatUpdate,
  pickAllowOption,
  stopChild,
} from "../../src/runtime/session.ts";

type Spawned = ChildProcessWithoutNullStreams & { didSpawn?: boolean };

function longRunningChild(script: string): Spawned {
  const child = spawn("sh", ["-c", script], { stdio: ["pipe", "pipe", "pipe"] }) as Spawned;
  child.didSpawn = true;
  return child;
}

function selectOptions(value: unknown): SessionConfigSelectOptions {
  return value as SessionConfigSelectOptions;
}

test("pickAllowOption: prefers allow_once over anything offered earlier", () => {
  assert.equal(
    pickAllowOption([
      { optionId: "reject", kind: "reject_once" },
      { optionId: "proceed", kind: "allow_once" },
    ]),
    "proceed",
  );
});

test("pickAllowOption: accepts allow_always", () => {
  assert.equal(
    pickAllowOption([{ optionId: "reject" }, { optionId: "always", kind: "allow_always" }]),
    "always",
  );
});

test("pickAllowOption: recognises an allow option by its id when kind is missing", () => {
  assert.equal(
    pickAllowOption([{ optionId: "deny" }, { optionId: "Allow-Once" }]),
    "Allow-Once",
  );
});

test("pickAllowOption: falls back to the first option when none look like allow", () => {
  assert.equal(pickAllowOption([{ optionId: "first" }, { optionId: "second" }]), "first");
});

test("pickAllowOption: undefined when the agent offered no options", () => {
  assert.equal(pickAllowOption([]), undefined);
});

test("formatUpdate: stays silent for bookkeeping updates", () => {
  const names = new Map<string, string>();
  assert.equal(formatUpdate({ sessionUpdate: "usage_update" }, names), null);
  assert.equal(formatUpdate({ sessionUpdate: "available_commands_update" }, names), null);
  assert.equal(formatUpdate({ sessionUpdate: "session_info_update" }, names), null);
});

test("formatUpdate: thought chunks never leak their content", () => {
  assert.equal(
    formatUpdate(
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "secret" } },
      new Map(),
    ),
    "thought",
  );
});

test("formatUpdate: names a tool call and remembers the name for later updates", () => {
  const names = new Map<string, string>();

  assert.equal(
    formatUpdate(
      { sessionUpdate: "tool_call", toolCallId: "toolu_01", name: "Edit", status: "pending" },
      names,
    ),
    "tool Edit pending",
  );
  assert.equal(
    formatUpdate(
      { sessionUpdate: "tool_call_update", toolCallId: "toolu_01", status: "completed" },
      names,
    ),
    "tool Edit completed",
  );
});

test("formatUpdate: falls back to tool when nothing identifies the call", () => {
  assert.equal(formatUpdate({ sessionUpdate: "tool_call" }, new Map()), "tool tool");
});

test("formatUpdate: omits the status when the update has none", () => {
  assert.equal(
    formatUpdate({ sessionUpdate: "tool_call", toolCallId: "t1", name: "Bash" }, new Map()),
    "tool Bash",
  );
});

test("formatUpdate: unknown kinds are reported by name", () => {
  assert.equal(formatUpdate({ sessionUpdate: "plan" }, new Map()), "plan");
  assert.equal(formatUpdate({}, new Map()), "update");
});

test("extractText: only message chunks contribute to the turn text", () => {
  assert.equal(
    extractText({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } }),
    "hi",
  );
  assert.equal(
    extractText({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hi" } }),
    "",
  );
  assert.equal(extractText({ sessionUpdate: "tool_call", content: { type: "text", text: "hi" } }), "");
  assert.equal(extractText({}), "");
});

test("flattenSelectValues: empty when the agent exposes no options", () => {
  assert.deepEqual(flattenSelectValues(undefined), []);
  assert.deepEqual(flattenSelectValues(selectOptions([])), []);
});

test("flattenSelectValues: keeps plain values as they are", () => {
  const options = selectOptions([
    { value: "sonnet", name: "Sonnet" },
    { value: "opus", name: "Opus" },
  ]);
  assert.deepEqual(flattenSelectValues(options).map((o: SessionConfigSelectOption) => o.value), [
    "sonnet",
    "opus",
  ]);
});

test("flattenSelectValues: unwraps grouped options into a flat list", () => {
  const options = selectOptions([
    { name: "Anthropic", options: [{ value: "sonnet" }, { value: "opus" }] },
    { value: "composer" },
    { name: "empty group", options: [] },
    { unrelated: true },
  ]);
  assert.deepEqual(flattenSelectValues(options).map((o: SessionConfigSelectOption) => o.value), [
    "sonnet",
    "opus",
    "composer",
  ]);
});

test("stopChild: nothing to stop is not an error", async () => {
  await stopChild(null, null);
});

test("stopChild: a process that never started is not waited on", async () => {
  const child = spawn("acp-runner-no-such-binary-9f3a", [], { stdio: ["pipe", "pipe", "pipe"] }) as Spawned;
  child.didSpawn = false;
  const started = Date.now();
  await Promise.race([
    new Promise((resolve) => child.once("error", resolve)),
    new Promise((resolve) => setTimeout(resolve, 200)),
  ]);
  await stopChild(child, null);
  assert.ok(Date.now() - started < 1000);
});

test("stopChild: closes stdin so a well-behaved agent exits on its own", async () => {
  const child = longRunningChild("cat > /dev/null");
  await stopChild(child, null);
  assert.notEqual(child.exitCode ?? child.signalCode, null);
});

test("stopChild: closes the connection and waits for it to settle", async () => {
  let closed = false;
  const child = longRunningChild("cat > /dev/null");
  await stopChild(child, {
    close: () => {
      closed = true;
    },
    closed: Promise.resolve(),
  });
  assert.equal(closed, true);
});

test("stopChild: a connection that throws on close does not break shutdown", async () => {
  const child = longRunningChild("cat > /dev/null");
  await stopChild(child, {
    close: () => {
      throw new Error("already closed");
    },
  });
  assert.notEqual(child.exitCode ?? child.signalCode, null);
});

test("stopChild: an already exited child is left alone", async () => {
  const child = longRunningChild("exit 0");
  await new Promise((resolve) => child.once("exit", resolve));
  await stopChild(child, null);
  assert.equal(child.exitCode, 0);
});

test("stopChild: terminates an agent that ignores a closed stdin", async () => {
  const child = longRunningChild("sleep 30");
  await stopChild(child, null);
  assert.equal(child.signalCode, "SIGTERM");
});

test("formatUpdate: a message chunk reports the kind and never its text", () => {
  assert.equal(
    formatUpdate(
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi there" } },
      new Map(),
    ),
    "message",
  );
});

test("formatUpdate: a tool_call_update with no status says nothing new", () => {
  const names = new Map<string, string>();
  assert.equal(
    formatUpdate({ sessionUpdate: "tool_call", toolCallId: "t1", name: "greet" }, names),
    "tool greet",
  );
  assert.equal(formatUpdate({ sessionUpdate: "tool_call_update", toolCallId: "t1" }, names), null);
});
