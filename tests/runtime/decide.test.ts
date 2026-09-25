import assert from "node:assert/strict";
import test from "node:test";
import { decideAfterError, decideAfterSuccess, nextFallback } from "../../src/runtime/decide.ts";
import type { AgentYaml, RunnerConfig, SessionContext } from "../../src/types.ts";

function contextFor(overrides: Partial<SessionContext> = {}): SessionContext {
  return {
    provider: "claude",
    cwd: "/tmp/project",
    prompt: "ship the feature",
    turnText: "",
    turnIndex: 0,
    stepIndex: 0,
    sessionId: null,
    triedProviders: [],
    pendingPermission: null,
    fallback: ["claude", "gemini", "codex"],
    onSpawnError: "swap",
    mcpServers: [],
    model: undefined,
    shutdownIntent: null,
    lastError: undefined,
    loopCounts: {},
    failure: undefined,
    stepOutcome: undefined,
    ...overrides,
  };
}

function configFor(runbook: AgentYaml): RunnerConfig {
  return { yamlPath: "agent.yaml", cwd: "/tmp/project", runbook };
}

test("nextFallback: first provider that has not been tried", () => {
  assert.equal(nextFallback(contextFor({ triedProviders: ["claude"] })), "gemini");
  assert.equal(nextFallback(contextFor({ triedProviders: ["claude", "gemini"] })), "codex");
});

test("nextFallback: undefined once every fallback has been tried", () => {
  assert.equal(
    nextFallback(contextFor({ triedProviders: ["codex", "claude", "gemini"] })),
    undefined,
  );
});

test("nextFallback: undefined when the fallback list is empty", () => {
  assert.equal(nextFallback(contextFor({ fallback: [] })), undefined);
});

test("decideAfterError: onSpawnError fail stops immediately and keeps the error", () => {
  const context = contextFor({ onSpawnError: "fail", lastError: "agent exited (1)" });
  assert.deepEqual(decideAfterError(context), {
    decision: "fail",
    lastError: "agent exited (1)",
    why: null,
    target: null,
  });
});

test("decideAfterError: swaps to the next untried fallback body", () => {
  const context = contextFor({ triedProviders: ["claude"], lastError: "spawn failed" });
  assert.deepEqual(decideAfterError(context), {
    decision: "swap",
    provider: "gemini",
    model: undefined,
    why: null,
    target: null,
  });
});

test("decideAfterError: does not carry the old model onto the fallback body", () => {
  const context = contextFor({
    provider: "gemini",
    model: "composer",
    triedProviders: ["gemini"],
    lastError: "spawn failed",
  });
  assert.equal(decideAfterError(context).model, undefined);
});

test("decideAfterError: fails once the fallback list is exhausted", () => {
  const context = contextFor({ triedProviders: ["claude", "gemini", "codex"] });
  assert.deepEqual(decideAfterError(context), {
    decision: "fail",
    lastError: "no fallback providers left",
    why: null,
    target: null,
  });
});

test("decideAfterError: keeps the original error when the fallback list runs out", () => {
  const context = contextFor({
    triedProviders: ["claude", "gemini", "codex"],
    lastError: "auth/session failed",
  });
  assert.equal(decideAfterError(context).lastError, "auth/session failed");
});

test("decideAfterSuccess: finishes after the last step", () => {
  const config = configFor({ steps: [{ id: "only", do: "Ship it" }] });
  const context = contextFor({ stepIndex: 0, model: "sonnet", prompt: "ship the feature" });

  assert.deepEqual(decideAfterSuccess(context, config), {
    decision: "finish",
    stepIndex: 0,
    provider: "claude",
    model: "sonnet",
    prompt: "ship the feature",
    mcpServers: [],
    why: "fallthrough",
    target: null,
  });
});

test("decideAfterSuccess: stays on the live session for the next same-body step", () => {
  const config = configFor({
    vars: { token: "DONE" }, steps: [{ id: "implement", do: "Ship it" }, { id: "verify", do: "Reply {{token}}" }],
  });

  assert.deepEqual(decideAfterSuccess(contextFor(), config), {
    decision: "stay",
    stepIndex: 1,
    provider: "claude",
    model: undefined,
    prompt: "Reply DONE",
    mcpServers: [],
    why: "fallthrough",
    target: "verify",
  });
});


test("decideAfterSuccess: swaps when the next step names a different provider", () => {
  const config = configFor({
    steps: [{ id: "implement", do: "Ship it" }, { id: "harden", provider: "gemini", do: "Review" }],
  });
  const context = contextFor();
  const result = decideAfterSuccess(context, config);

  assert.equal(result.decision, "swap");
  assert.equal(result.stepIndex, 1);
  assert.equal(result.provider, "gemini");
  assert.equal(result.prompt, "Review");
});

test("decideAfterSuccess: swaps when the next step names a different model", () => {
  const config = configFor({
    steps: [{ id: "implement", do: "Ship it" }, { id: "harden", model: "opus", do: "Review" }],
  });
  const result = decideAfterSuccess(contextFor({ model: "sonnet" }), config);

  assert.equal(result.decision, "swap");
  assert.equal(result.provider, "claude");
  assert.equal(result.model, "opus");
});

test("decideAfterSuccess: a swap carries the next step's own prompt", () => {
  const config = configFor({
    steps: [{ id: "implement", do: "Implement it" }, { id: "harden", provider: "gemini", do: "Harden it" }],
  });
  const result = decideAfterSuccess(contextFor(), config);

  assert.equal(result.prompt, "Harden it");
});

test("decideAfterSuccess: the next step inherits provider and model when it names none", () => {
  const config = configFor({
    steps: [{ id: "implement", do: "Ship it" }, { id: "verify", do: "Check" }],
  });
  const result = decideAfterSuccess(
    contextFor({ provider: "codex", model: "gpt-5" }),
    config,
  );

  assert.equal(result.decision, "stay");
  assert.equal(result.provider, "codex");
  assert.equal(result.model, "gpt-5");
});

test("decideAfterSuccess: walks the agenda one step at a time", () => {
  const config = configFor({
    steps: [{ id: "a", do: "A" }, { id: "b", do: "B" }, { id: "c", do: "C" }],
  });

  assert.equal(decideAfterSuccess(contextFor({ stepIndex: 0 }), config).prompt, "B");
  assert.equal(decideAfterSuccess(contextFor({ stepIndex: 1 }), config).prompt, "C");
  assert.equal(decideAfterSuccess(contextFor({ stepIndex: 2 }), config).decision, "finish");
});

test("decideAfterSuccess: jumps forward to on.success target when step succeeds", () => {
  const config = configFor({
    steps: [
      { id: "a", on: { success: "c" } },
      { id: "b", do: "B" },
      { id: "c", do: "C" },
    ],
  });
  const result = decideAfterSuccess(
    contextFor({ stepIndex: 0, stepOutcome: "success" }),
    config,
  );
  assert.equal(result.stepIndex, 2);
  assert.equal(result.prompt, "C");
});

test("decideAfterSuccess: loops backward to on.failure target when step fails", () => {
  const config = configFor({
    steps: [
      { id: "implement", do: "Implement" },
      {
        id: "verify",
        do: "Verify",
        on: {
          failure: {
            target: "implement",
            maxAttempts: 3,
          },
        },
      },
    ],
  });
  const result = decideAfterSuccess(
    contextFor({ stepIndex: 1, stepOutcome: "failure", loopCounts: {} }),
    config,
  );
  assert.equal(result.stepIndex, 0);
  assert.equal(result.prompt, "Implement");
  assert.equal(result.loopCounts?.["verify->implement"], 1);
});

test("decideAfterSuccess: routes to fallback when maxAttempts exceeded on failure", () => {
  const config = configFor({
    steps: [
      { id: "implement", do: "Implement" },
      {
        id: "verify",
        do: "Verify",
        on: {
          failure: {
            target: "implement",
            maxAttempts: 2,
            fallback: "abort",
          },
        },
      },
      { id: "abort", do: "Abort" },
    ],
  });
  const result = decideAfterSuccess(
    contextFor({
      stepIndex: 1,
      stepOutcome: "failure",
      loopCounts: { "verify->implement": 2 },
    }),
    config,
  );
  assert.equal(result.stepIndex, 2);
  assert.equal(result.prompt, "Abort");
});

test("decideAfterSuccess: fails when maxAttempts exceeded and no fallback specified", () => {
  const config = configFor({
    steps: [
      { id: "implement", do: "Implement" },
      {
        id: "verify",
        do: "Verify",
        on: {
          failure: {
            target: "implement",
            maxAttempts: 2,
          },
        },
      },
    ],
  });
  const result = decideAfterSuccess(
    contextFor({
      stepIndex: 1,
      stepOutcome: "failure",
      loopCounts: { "verify->implement": 2 },
    }),
    config,
  );
  assert.equal(result.decision, "fail");
});

test("decideAfterSuccess: keeps the task separate from failure delivery", () => {
  const config = configFor({
    steps: [
      { id: "fix", do: "Fix errors." },
      { id: "verify", on: { failure: "fix" } },
    ],
  });
  const result = decideAfterSuccess(
    contextFor({ stepIndex: 1, stepOutcome: "failure", failure: { stepId: "check", kind: "check", source: "test", exitCode: 1, output: "type error line 10" } }),
    config,
  );
  assert.equal(result.prompt, "Fix errors.");
});

test("decideAfterSuccess: fails when stepOutcome is failure and no on.failure is declared", () => {
  const config = configFor({
    steps: [
      { id: "step1", do: "Step 1" },
      { id: "step2", do: "Step 2" },
    ],
  });
  const result = decideAfterSuccess(
    contextFor({ stepIndex: 0, stepOutcome: "failure", failure: { stepId: "check", kind: "check", source: "test", exitCode: 1, output: "command failed" } }),
    config,
  );
  assert.equal(result.decision, "fail");
  assert.equal(result.lastError, "command failed");
  assert.equal(result.why, null);
});

test("decideAfterSuccess: on.success END finishes the run", () => {
  const config = configFor({
    steps: [
      { id: "step1", do: "Step 1", on: { success: "END" } },
      { id: "step2", do: "Step 2" },
    ],
  });
  const result = decideAfterSuccess(
    contextFor({ stepIndex: 0, stepOutcome: "success" }),
    config,
  );
  assert.equal(result.decision, "finish");
});

test("decideAfterSuccess: on.success FAIL fails the run", () => {
  const config = configFor({
    steps: [
      { id: "step1", do: "Step 1", on: { success: "FAIL" } },
      { id: "step2", do: "Step 2" },
    ],
  });
  const result = decideAfterSuccess(
    contextFor({ stepIndex: 0, stepOutcome: "success" }),
    config,
  );
  assert.equal(result.decision, "fail");
  assert.equal(result.lastError, "step step1: failed");
});

test("decideAfterSuccess: on.failure END finishes the run cleanly", () => {
  const config = configFor({
    steps: [
      { id: "step1", do: "Step 1", on: { failure: "end" } },
      { id: "step2", do: "Step 2" },
    ],
  });
  const result = decideAfterSuccess(
    contextFor({ stepIndex: 0, stepOutcome: "failure" }),
    config,
  );
  assert.equal(result.decision, "finish");
});

test("decideAfterSuccess: on.failure FAIL fails the run with feedback", () => {
  const config = configFor({
    steps: [
      { id: "step1", do: "Step 1", on: { failure: "FAIL" } },
      { id: "step2", do: "Step 2" },
    ],
  });
  const result = decideAfterSuccess(
    contextFor({ stepIndex: 0, stepOutcome: "failure", failure: { stepId: "check", kind: "check", source: "test", exitCode: 1, output: "fatal error" } }),
    config,
  );
  assert.equal(result.decision, "fail");
  assert.equal(result.lastError, "fatal error");
});

test("decideAfterSuccess: fallback END on max attempts exceeded finishes the run", () => {
  const config = configFor({
    steps: [
      { id: "implement", do: "Implement" },
      {
        id: "verify",
        do: "Verify",
        on: {
          failure: {
            target: "implement",
            maxAttempts: 2,
            fallback: "END",
          },
        },
      },
      { id: "other", do: "Other" },
    ],
  });
  const result = decideAfterSuccess(
    contextFor({
      stepIndex: 1,
      stepOutcome: "failure",
      loopCounts: { "verify->implement": 2 },
    }),
    config,
  );
  assert.equal(result.decision, "finish");
});

test("decideAfterSuccess: fallback FAIL on max attempts exceeded fails the run", () => {
  const config = configFor({
    steps: [
      { id: "implement", do: "Implement" },
      {
        id: "verify",
        do: "Verify",
        on: {
          failure: {
            target: "implement",
            maxAttempts: 2,
            fallback: "FAIL",
          },
        },
      },
    ],
  });
  const result = decideAfterSuccess(
    contextFor({
      stepIndex: 1,
      stepOutcome: "failure",
      loopCounts: { "verify->implement": 2 },
    }),
    config,
  );
  assert.equal(result.decision, "fail");
  assert.match(result.lastError ?? "", /max attempts \(2\) exceeded/);
});

test("decideAfterSuccess: reports why=fallthrough and target for sequential progression", () => {
  const config = configFor({
    steps: [{ id: "first", do: "Ship it" }, { id: "second", do: "Ship it" }],
  });
  const result = decideAfterSuccess(contextFor({ stepIndex: 0, stepOutcome: "success" }), config);
  assert.equal(result.why, "fallthrough");
  assert.equal(result.target, "second");
});

test("decideAfterSuccess: reports why=on.success for explicit success transition", () => {
  const config = configFor({
    steps: [{ id: "first", on: { success: "second" } }, { id: "second", do: "Ship it" }],
  });
  const result = decideAfterSuccess(contextFor({ stepIndex: 0, stepOutcome: "success" }), config);
  assert.equal(result.why, "on.success");
  assert.equal(result.target, "second");
});

test("decideAfterSuccess: reports why=on.failure for explicit failure transition", () => {
  const config = configFor({
    steps: [{ id: "first", do: "Ship it", on: { failure: "first" } }],
  });
  const result = decideAfterSuccess(contextFor({ stepIndex: 0, stepOutcome: "failure" }), config);
  assert.equal(result.why, "on.failure");
  assert.equal(result.target, "first");
});

test("decideAfterSuccess: reports why=fallback when max attempts redirects to a fallback step", () => {
  const config = configFor({
    steps: [
      { id: "first", on: { failure: { target: "first", maxAttempts: 1, fallback: "second" } } },
      { id: "second", do: "Ship it" },
    ],
  });
  const result = decideAfterSuccess(
    contextFor({ stepIndex: 0, stepOutcome: "failure", loopCounts: { "first->first": 1 } }),
    config,
  );
  assert.equal(result.why, "fallback");
  assert.equal(result.target, "second");
});

test("decideAfterSuccess: reports why=maxAttempts when max attempts fails the run", () => {
  const config = configFor({
    steps: [
      { id: "first", on: { failure: { target: "first", maxAttempts: 1 } } },
    ],
  });
  const result = decideAfterSuccess(
    contextFor({ stepIndex: 0, stepOutcome: "failure", loopCounts: { "first->first": 1 } }),
    config,
  );
  assert.equal(result.why, "maxAttempts");
  assert.equal(result.target, null);
});

test("decideAfterError: reports why=null when switching provider", () => {
  const context = contextFor({ triedProviders: ["claude"], lastError: "spawn failed" });
  const result = decideAfterError(context);
  assert.equal(result.why, null);
});

test("decideAfterSuccess: loops back to current step on failure when step.retry is defined", () => {
  const config = configFor({
    steps: [{ id: "route", do: "Ship it", retry: { maxAttempts: 2 } }],
  });
  const result = decideAfterSuccess(contextFor({ stepIndex: 0, stepOutcome: "failure" }), config);
  assert.equal(result.decision, "stay");
  assert.equal(result.stepIndex, 0);
  assert.equal(result.why, "on.failure");
  assert.equal(result.target, "route");
  assert.equal(result.loopCounts?.["route->route"], 1);
});

test("decideAfterSuccess: fails when step.retry max attempts is exceeded", () => {
  const config = configFor({
    steps: [{ id: "route", do: "Ship it", retry: { maxAttempts: 2 } }],
  });
  const result = decideAfterSuccess(
    contextFor({ stepIndex: 0, stepOutcome: "failure", loopCounts: { "route->route": 2 } }),
    config,
  );
  assert.equal(result.decision, "fail");
  assert.equal(result.why, "maxAttempts");
});

test("decideAfterSuccess: transitions to fallback when step.retry max attempts is exceeded", () => {
  const config = configFor({
    steps: [
      { id: "route", retry: { maxAttempts: 2, fallback: "fallback-step" } },
      { id: "fallback-step", do: "Ship it" },
    ],
  });
  const result = decideAfterSuccess(
    contextFor({ stepIndex: 0, stepOutcome: "failure", loopCounts: { "route->route": 2 } }),
    config,
  );
  assert.equal(result.decision, "stay");
  assert.equal(result.stepIndex, 1);
  assert.equal(result.why, "fallback");
  assert.equal(result.target, "fallback-step");
});
