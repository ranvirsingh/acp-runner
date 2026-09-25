import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeVariables,
  renderPromptTemplate,
  resolveStepVariables,
} from "../../src/config/vars.ts";
import { loadAgentYaml, resolveStepPrompt } from "../../src/config/yaml.ts";
import type { AgentStep, AgentYaml, RunnerConfig } from "../../src/types.ts";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function runnerFromYaml(runbook: AgentYaml): RunnerConfig {
  return {
    yamlPath: "agent.yaml",
    cwd: "/tmp/project",
    runbook,
  };
}

test("resolveStepVariables: reads agent.vars and step.vars from runbook", () => {
  const config = runnerFromYaml({
    vars: { artifact: "hello.txt" },
    steps: [{ id: "a", do: "Ship it" }, { id: "b", vars: { artifact: "README.md" } }],
  });

  assert.deepEqual(resolveStepVariables(config, config.runbook.steps[0]), {
    artifact: "hello.txt",
  });
  assert.deepEqual(resolveStepVariables(config, config.runbook.steps[1]), {
    artifact: "README.md",
  });
});

test("renderPromptTemplate: interpolates workflow variables", () => {
  assert.equal(
    renderPromptTemplate("Write {{artifact}} with {{style}} tone", {
      artifact: "hello.txt",
      style: "concise",
    }),
    "Write hello.txt with concise tone",
  );
});

test("renderPromptTemplate: removed built-ins are not silently available", () => {
  assert.throws(
    () => renderPromptTemplate("Goal={{goal}}", {}),
    /unknown variable \{\{goal\}\}/,
  );
  assert.throws(
    () => renderPromptTemplate("cwd={{cwd}}", {}),
    /unknown variable \{\{cwd\}\}/,
  );
});

test("renderPromptTemplate: goal/cwd/brief only when declared in vars", () => {
  assert.equal(
    renderPromptTemplate("Goal={{goal}} cwd={{cwd}}", {
      goal: "ship feature",
      cwd: "/tmp/project",
    }),
    "Goal=ship feature cwd=/tmp/project",
  );
});

test("resolveStepPrompt: uses workflow vars", () => {
  const config = runnerFromYaml({
    vars: { artifact: "hello.txt", workspace: "/tmp/project" },
    steps: [{ id: "verify", do: "Check {{artifact}} in {{workspace}}" }],
  });
  const step = config.runbook.steps[0];

  assert.equal(resolveStepPrompt(config, step), "Check hello.txt in /tmp/project");
});

test("resolveStepPrompt: step vars override workflow vars for that step only", () => {
  const config = runnerFromYaml({
    vars: { artifact: "hello.txt" },
    steps: [
      { id: "a", do: "Use {{artifact}}" },
      { id: "b", vars: { artifact: "README.md" }, do: "Use {{artifact}}" },
    ],
  });

  assert.equal(
    resolveStepPrompt(config, config.runbook.steps[0]),
    "Use hello.txt",
  );
  assert.equal(
    resolveStepPrompt(config, config.runbook.steps[1]),
    "Use README.md",
  );
});

test("resolveStepPrompt: a step with no body is an error", () => {
  const config = runnerFromYaml({
    vars: { artifact: "hello.txt" },
    steps: [{ id: "implement" }],
  });

  assert.throws(
    () => resolveStepPrompt(config, config.runbook.steps[0]),
    /step implement: no prompt body/,
  );
});

test("resolveStepPrompt: brief is not auto-injected into templates", () => {
  const config = runnerFromYaml({
    steps: [{ id: "verify", do: "Prior work:\n{{brief}}" }],
  });

  assert.throws(
    () => resolveStepPrompt(config, config.runbook.steps[0]),
    /step verify: unknown variable \{\{brief\}\}/,
  );
});

test("loadAgentYaml: accepts agent.vars and step.vars", () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-vars-"));
  const path = join(dir, "agent.yaml");
  writeFileSync(
    path,
    `
vars:
  artifact: hello.txt
steps:
  - id: one
    do: "Check {{artifact}}"
  - id: two
    vars:
      artifact: README.md
    do: "Check {{artifact}}"
`,
  );

  try {
    const parsed = loadAgentYaml(path);
    assert.equal(parsed.vars?.artifact, "hello.txt");
    assert.equal(parsed.steps[1].vars?.artifact, "README.md");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveStepPrompt: coerces non-string yaml scalars to strings", () => {
  const config = runnerFromYaml({
    vars: { retries: 3 as unknown as string },
    steps: [{ id: "retry", do: "Try {{retries}} times" }],
  });
  const step: AgentStep = {
    id: "retry",
    do: "Try {{retries}} times",
    vars: { retries: 5 as unknown as string },
  };

  assert.equal(resolveStepPrompt(config, step), "Try 5 times");
});

test("normalizeVariables: empty object when the runbook declares no vars", () => {
  assert.deepEqual(normalizeVariables(".", undefined), {});
  assert.deepEqual(normalizeVariables(".", {}), {});
});

test("normalizeVariables: yaml scalars become strings", () => {
  assert.deepEqual(normalizeVariables(".", { retries: 3, strict: true, ratio: 0.5 }), {
    retries: "3",
    strict: "true",
    ratio: "0.5",
  });
});

test("normalizeVariables: missing values render as empty rather than null", () => {
  assert.deepEqual(normalizeVariables(".", { a: null, b: undefined }), { a: "", b: "" });
});

test("resolveStepVariables: a step var set to null still overrides the runbook var", () => {
  const config = runnerFromYaml({
    vars: { style: "brief" },
    steps: [{ id: "a", do: "Ship it", vars: { style: null } }],
  });
  assert.deepEqual(resolveStepVariables(config, config.runbook.steps[0]), { style: "" });
});

test("renderPromptTemplate: placeholders with spaces are not substituted", () => {
  assert.equal(
    renderPromptTemplate("Write {{ artifact }}", { artifact: "hello.txt" }),
    "Write {{ artifact }}",
  );
});

test("renderPromptTemplate: the same placeholder is replaced everywhere", () => {
  assert.equal(
    renderPromptTemplate("{{token}} then {{token}}", { token: "DONE" }),
    "DONE then DONE",
  );
});

test("renderPromptTemplate: env.NAME reads the process environment", () => {
  process.env.ACP_TEST_BRANCH = "main";
  try {
    assert.equal(renderPromptTemplate("On {{env.ACP_TEST_BRANCH}}", {}), "On main");
  } finally {
    delete process.env.ACP_TEST_BRANCH;
  }
});

test("renderPromptTemplate: vars.name is the same lookup as a bare name", () => {
  assert.equal(
    renderPromptTemplate("{{vars.token}} and {{token}}", { token: "DONE" }),
    "DONE and DONE",
  );
});

test("renderPromptTemplate: an undeclared variable throws instead of passing through", () => {
  assert.throws(
    () => renderPromptTemplate("See {{missing}} here", { known: "x" }),
    /unknown variable \{\{missing\}\}/,
  );
});

test("renderPromptTemplate: an unset environment variable throws", () => {
  delete process.env.ACP_TEST_ABSENT;
  assert.throws(
    () => renderPromptTemplate("On {{env.ACP_TEST_ABSENT}}", {}),
    /ACP_TEST_ABSENT is not set/,
  );
});

test("renderPromptTemplate: an unknown namespace throws", () => {
  assert.throws(
    () => renderPromptTemplate("Token {{secrets.api_key}}", {}),
    /unknown namespace "secrets"/,
  );
});

test("resolveStepVariables: an { env } source reads the process environment", () => {
  process.env.ACP_TEST_BRANCH = "release";
  try {
    const config = runnerFromYaml({
      vars: { branch: { env: "ACP_TEST_BRANCH" } },
      steps: [{ id: "a", do: "on {{branch}}" }],
    });
    assert.deepEqual(resolveStepVariables(config, config.runbook.steps[0]), {
      branch: "release",
    });
  } finally {
    delete process.env.ACP_TEST_BRANCH;
  }
});

test("resolveStepVariables: an { env } source for an unset name throws and names the var", () => {
  delete process.env.ACP_TEST_ABSENT;
  const config = runnerFromYaml({
    vars: { token: { env: "ACP_TEST_ABSENT" } },
    steps: [{ id: "a", do: "use {{token}}" }],
  });
  assert.throws(
    () => resolveStepVariables(config, config.runbook.steps[0]),
    /var token: environment variable ACP_TEST_ABSENT is not set/,
  );
});

test("resolveStepVariables: a { file } source reads relative to the yaml, not the cwd", () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-varfile-"));
  try {
    writeFileSync(join(dir, "schema.json"), '{"ok":true}');
    const config: RunnerConfig = {
      yamlPath: join(dir, "agent.yaml"),
      cwd: "/tmp/project",
      runbook: {
        vars: { schema: { file: "schema.json" } },
        steps: [{ id: "a", do: "use {{schema}}" }],
      },
    };

    assert.deepEqual(resolveStepVariables(config, config.runbook.steps[0]), {
      schema: '{"ok":true}',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveStepVariables: a { file } source that is missing throws and names the var", () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-varfile-"));
  try {
    const config: RunnerConfig = {
      yamlPath: join(dir, "agent.yaml"),
      cwd: dir,
      runbook: {
        vars: { schema: { file: "absent.json" } },
        steps: [{ id: "a", do: "use {{schema}}" }],
      },
    };

    assert.throws(
      () => resolveStepVariables(config, config.runbook.steps[0]),
      /var schema: cannot read absent.json/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveStepVariables: a { file } source falls back to cwd if not in yaml dir", () => {
  const yamlDir = mkdtempSync(join(tmpdir(), "acp-yaml-"));
  const cwdDir = mkdtempSync(join(tmpdir(), "acp-cwd-"));
  try {
    writeFileSync(join(cwdDir, "output.json"), '{"generated":true}');
    const config: RunnerConfig = {
      yamlPath: join(yamlDir, "agent.yaml"),
      cwd: cwdDir,
      runbook: {
        vars: { output: { file: "output.json" } },
        steps: [{ id: "a", do: "use {{output}}" }],
      },
    };

    assert.deepEqual(resolveStepVariables(config, config.runbook.steps[0]), {
      output: '{"generated":true}',
    });
  } finally {
    rmSync(yamlDir, { recursive: true, force: true });
    rmSync(cwdDir, { recursive: true, force: true });
  }
});
