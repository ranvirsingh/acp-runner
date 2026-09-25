import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lintRunbook } from "../../src/config/lint.ts";
import { runCli } from "../helpers/run-cli.ts";

function runLint(args: string[]) {
  return runCli(["lint", ...args]);
}

function withFiles(files: Record<string, string>, fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "acp-lint-"));
  try {
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(join(dir, name), body, "utf8");
    }
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("lint: the example agent folders committed to this repo are valid", () => {
  const result = runLint(["examples/hello-world"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /ok examples\/hello-world/);
});

test("lint: an undeclared placeholder fails and names the step", () => {
  withFiles(
    {
      "bad.yaml": "steps:\n  - id: verify\n    do: reply {{done_tokn}}\n",
    },
    (dir) => {
      const result = runLint([join(dir, "bad.yaml")]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /step verify: unknown variable \{\{done_tokn\}\}/);
    },
  );
});

test("lint rejects feedback in inline prompts, files, commands and promptRef arguments", () => {
  withFiles({
    "agent.yaml": `providers:
  mcpServers:
    cat: { command: node }
steps:
  - id: inline
    do: "Fix {{feedback}}"
  - id: file
    do: { file: prompt.md }
  - id: shell
    run: "echo \${{ feedback }}"
  - id: argv
    run: { command: node, args: ["{{vars.feedback}}"] }
  - id: external
    promptRef:
      server: cat
      name: review
      arguments: { issue: "\${{ vars.feedback }}" }
`,
    "prompt.md": "Fix {{vars.feedback}}",
  }, (dir) => {
    const problems = lintRunbook(dir);
    assert.equal(problems.length, 5);
    for (const step of ["inline", "file", "shell", "argv", "external"]) {
      assert.ok(problems.some((problem) => problem.includes(`step ${step}:`) && problem.includes("Check failures are attached automatically; remove the feedback placeholder.")));
    }
  });
});

test("lint: a missing prompt file fails without running the agent", () => {
  withFiles({ "bad.yaml": "steps:\n  - id: harden\n    do: { file: absent.md }\n" }, (dir) => {
    const result = runLint([join(dir, "bad.yaml")]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /step harden: cannot read absent\.md/);
  });
});

test("lint: every broken step is reported, not just the first", () => {
  withFiles(
    {
      "bad.yaml":
        "steps:\n  - id: one\n    do: a {{nope}}\n  - id: two\n    do: b {{alsonope}}\n",
    },
    (dir) => {
      const result = runLint([join(dir, "bad.yaml")]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /step one: unknown variable/);
      assert.match(result.stderr, /step two: unknown variable/);
    },
  );
});

test("lintRunbook: a broken prompt and a broken run in one step are both reported", () => {
  withFiles(
    { "agent.yaml": "steps:\n  - id: one\n    do: a {{nope}}\n    run: test -f {{alsonope}}\n" },
    (dir) => {
      assert.deepEqual(lintRunbook(dir), [
        "step one: unknown variable {{nope}}",
        "step one: unknown variable {{alsonope}}",
      ]);
    },
  );
});

test("lint: a schema problem is reported with its path", () => {
  withFiles({ "bad.yaml": "steps:\n  - id: one\n    provider: unsupported\n" }, (dir) => {
    const result = runLint([join(dir, "bad.yaml")]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /steps\[0\]\.provider/);
  });
});

test("lint: a folder is linted as the agent.yaml inside it", () => {
  withFiles({ "agent.yaml": "steps:\n  - id: one\n    do: hello\n" }, (dir) => {
    const result = runLint([dir]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, new RegExp(`ok ${dir}`));
  });
});

test("lint: an mcp server whose environment variable is unset still lints", () => {
  withFiles(
    {
      "agent.yaml":
        "providers:\n  mcpServers:\n    gcp-usage:\n      command: python\n      env:\n        KEY: \"{{env.ACP_LINT_ABSENT}}\"\nsteps:\n  - id: one\n    do: Ship it\n",
    },
    (dir) => {
      const result = runLint([dir]);
      assert.equal(result.status, 0, result.stdout + result.stderr);
    },
  );
});

test("lintRunbook: an env var stays stubbed when mcp servers are declared", () => {
  withFiles(
    {
      "agent.yaml":
        "vars:\n  token: { env: ACP_LINT_ABSENT }\nproviders:\n  mcpServers:\n    db:\n      command: node\nsteps:\n  - id: one\n    do: use {{token}}\n",
    },
    (dir) => {
      assert.deepEqual(lintRunbook(dir), []);
    },
  );
});

test("lintRunbook: an unset env placeholder in a prompt is stubbed", () => {
  withFiles(
    { "agent.yaml": "steps:\n  - id: one\n    do: use {{env.ACP_LINT_ABSENT}}\n" },
    (dir) => {
      assert.deepEqual(lintRunbook(dir), []);
    },
  );
});

test("lintRunbook: an unset env placeholder in a run command is stubbed", () => {
  withFiles(
    { "agent.yaml": "steps:\n  - id: one\n    run: curl -H {{env.ACP_LINT_ABSENT}} x.test\n" },
    (dir) => {
      assert.deepEqual(lintRunbook(dir), []);
    },
  );
});

test("lint: accepts runbooks with pure script steps", () => {
  withFiles(
    {
      "agent.yaml":
        "steps:\n  - id: setup\n    run: node -e ''\n  - id: implement\n    do: Implement\n  - id: verify\n    run: pytest\n",
    },
    (dir) => {
      const result = runLint([dir]);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, new RegExp(`ok ${dir}`));
    },
  );
});

test("lint: the agent.yaml template shipped with the create-agent skill is valid", () => {
  const result = runLint([".claude/skills/create-agent/assets/agent.yaml"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("lint: an undeclared placeholder in run fails and names the step", () => {
  withFiles(
    {
      "bad.yaml": "steps:\n  - id: notify\n    run: node notify.ts --projects {{projects}}\n",
    },
    (dir) => {
      const result = runLint([join(dir, "bad.yaml")]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /step notify: unknown variable \{\{projects\}\}/);
    },
  );
});

test("lint: an undeclared placeholder in a post-turn run fails and names the step", () => {
  withFiles(
    {
      "bad.yaml":
        "steps:\n  - id: verify\n    do: check\n    run: test -f {{target_file}}\n",
    },
    (dir) => {
      const result = runLint([join(dir, "bad.yaml")]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /step verify: unknown variable \{\{target_file\}\}/);
    },
  );
});

test("lintRunbook: a servers map naming an undeclared server is a problem", () => {
  withFiles(
    {
      "agent.yaml":
        "providers:\n  mcpServers:\n    db:\n      command: node\nsteps:\n  - id: one\n    servers:\n      ghost: {}\n",
    },
    (dir) => {
      const problems = lintRunbook(dir);
      assert.equal(problems.length, 1);
      assert.match(problems[0], /unknown server "ghost"/);
    },
  );
});

test("lintRunbook: a promptRef step with a declared server is clean", () => {
  withFiles(
    {
      "agent.yaml":
        "providers:\n  mcpServers:\n    jira:\n      command: node\nsteps:\n  - id: one\n    promptRef:\n      server: jira\n      name: review\n",
    },
    (dir) => {
      assert.deepEqual(lintRunbook(dir), []);
    },
  );
});

test("lintRunbook: an undeclared placeholder in promptRef arguments names the step and argument", () => {
  withFiles(
    {
      "agent.yaml":
        'providers:\n  mcpServers:\n    jira:\n      command: node\nsteps:\n  - id: one\n    promptRef:\n      server: jira\n      name: review\n      arguments:\n        q: "{{typo}}"\n',
    },
    (dir) => {
      assert.deepEqual(lintRunbook(dir), [
        "step one: promptRef.arguments.q: unknown variable {{typo}}",
      ]);
    },
  );
});

test("lintRunbook: a remote server renders its headers", () => {
  withFiles(
    {
      "agent.yaml":
        'providers:\n  mcpServers:\n    jira:\n      type: sse\n      url: https://x.test/sse\n      headers:\n        Authorization: "Bearer {{env.ACP_TEST_ABSENT_TOKEN}} {{nope}}"\nsteps:\n  - id: one\n    do: Ship it\n',
    },
    (dir) => {
      assert.deepEqual(lintRunbook(dir), ["mcpServers jira: unknown variable {{nope}}"]);
    },
  );
});
