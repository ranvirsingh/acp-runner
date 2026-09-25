import assert from "node:assert/strict";
import test from "node:test";
import {
  createAcpLogger,
  formatReply,
  isStderrNoise,
  splitLines,
  textFromContent,
  toolNameFromUpdate,
  stateLog,
  stepLog,
} from "../../src/output/logs.ts";

function captureLog(fn: () => void): string[] {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.join(" "));
  };
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines;
}

test("stepLog: names the step and the provider it runs on, unindented", () => {
  assert.deepEqual(captureLog(() => stepLog("write", "claude")), ["[step] write (claude)"]);
});

test("stateLog: indents under the step and pads the tag", () => {
  assert.deepEqual(
    captureLog(() => stateLog("spawning", "authenticating")),
    ["  [state]  spawning → authenticating"],
  );
});

test("createAcpLogger: prefixes protocol chatter with the provider name", () => {
  assert.deepEqual(
    captureLog(() => createAcpLogger("claude")("session abc123")),
    ["  [claude] session abc123"],
  );
  assert.deepEqual(
    captureLog(() => createAcpLogger("gemini")("session abc123")),
    ["  [gemini] session abc123"],
  );
});

test("createAcpLogger: a line identical to the one before it is not printed again", () => {
  const log = createAcpLogger("claude");
  assert.deepEqual(
    captureLog(() => {
      log("thought");
      log("thought");
      log("thought");
    }),
    ["  [claude] thought"],
  );
});

test("createAcpLogger: a repeat prints again once something else came between", () => {
  const log = createAcpLogger("gemini");
  assert.deepEqual(
    captureLog(() => {
      log("message");
      log("tool Bash");
      log("message");
    }),
    ["  [gemini] message", "  [gemini] tool Bash", "  [gemini] message"],
  );
});

test("createAcpLogger: two loggers do not share what they last printed", () => {
  const first = createAcpLogger("codex");
  const second = createAcpLogger("codex");
  assert.deepEqual(
    captureLog(() => {
      first("spawn claude");
      second("spawn claude");
    }),
    ["  [codex]  spawn claude", "  [codex]  spawn claude"],
  );
});

test("splitLines: a partial line is held back for the next chunk", () => {
  assert.deepEqual(splitLines("one\ntwo\nthr"), { lines: ["one", "two"], rest: "thr" });
});

test("splitLines: a chunk with no newline is all remainder", () => {
  assert.deepEqual(splitLines("still going"), { lines: [], rest: "still going" });
});

test("splitLines: blank lines are dropped", () => {
  assert.deepEqual(splitLines("one\n\n  \ntwo\n"), { lines: ["one", "two"], rest: "" });
});

test("toolNameFromUpdate: prefers the explicit name field", () => {
  assert.equal(
    toolNameFromUpdate({ name: "Edit", title: "Editing file", _meta: {} }),
    "Edit",
  );
});

test("toolNameFromUpdate: falls back to the claudeCode tool name", () => {
  assert.equal(
    toolNameFromUpdate({ _meta: { claudeCode: { toolName: "Bash" } }, title: "Running" }),
    "Bash",
  );
});

test("toolNameFromUpdate: falls back to the title last", () => {
  assert.equal(toolNameFromUpdate({ title: "Reading README.md" }), "Reading README.md");
});

test("toolNameFromUpdate: skips empty strings rather than reporting them as names", () => {
  assert.equal(toolNameFromUpdate({ name: "", title: "Write" }), "Write");
  assert.equal(
    toolNameFromUpdate({ _meta: { claudeCode: { toolName: "" } }, title: "Write" }),
    "Write",
  );
  assert.equal(toolNameFromUpdate({ name: "", title: "" }), undefined);
});

test("toolNameFromUpdate: undefined when the update carries no name at all", () => {
  assert.equal(toolNameFromUpdate({ toolCallId: "toolu_01" }), undefined);
  assert.equal(toolNameFromUpdate({ _meta: null }), undefined);
  assert.equal(toolNameFromUpdate({ _meta: { claudeCode: {} } }), undefined);
});

test("toolNameFromUpdate: ignores non-string name fields", () => {
  assert.equal(toolNameFromUpdate({ name: 42, title: "Grep" }), "Grep");
});

test("textFromContent: returns the text of a text block", () => {
  assert.equal(textFromContent({ type: "text", text: "hello" }), "hello");
});

test("textFromContent: empty string for non-text content", () => {
  assert.equal(textFromContent({ type: "image", text: "hello" }), "");
  assert.equal(textFromContent({ type: "text" }), "");
  assert.equal(textFromContent(null), "");
  assert.equal(textFromContent(undefined), "");
  assert.equal(textFromContent("hello"), "");
});

test("formatReply: extracts clean summary without raw code blocks or newlines", () => {
  const reply = "I have built the incident tracker.\n\n```typescript\nimport { randomUUID } from 'crypto';\n```\nAll done.";
  assert.equal(formatReply(reply), "I have built the incident tracker.");
});

test("formatReply: collapses multiple whitespace and newlines to single line", () => {
  assert.equal(formatReply("First line.\nSecond line."), "First line. Second line.");
});

test("formatReply: truncates long summaries with ellipsis", () => {
  const long = "A".repeat(200);
  const formatted = formatReply(long);
  assert.equal(formatted.length, 160);
  assert.ok(formatted.endsWith("…"));
});

test("formatReply: empty string for blank text", () => {
  assert.equal(formatReply("   "), "");
});

test("isStderrNoise: returns true for known CLI telemetry and startup notices", () => {
  assert.equal(isStderrNoise("[STARTUP] Phase 'cli_startup' was started"), true);
  assert.equal(isStderrNoise("MaxListenersExceededWarning: Possible EventTarget memory leak"), true);
  assert.equal(isStderrNoise("Skipping project agents due to untrusted folder"), true);
  assert.equal(isStderrNoise("Project hooks disabled because the folder is not trusted."), true);
  assert.equal(isStderrNoise("Could not find promptId in context for classifier-router"), true);
});

test("isStderrNoise: returns false for actual errors", () => {
  assert.equal(isStderrNoise("Error: command not found: bun"), false);
  assert.equal(isStderrNoise("SyntaxError: Unexpected token"), false);
});
