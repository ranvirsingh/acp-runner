import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  loadAgentYaml,
  needsNewBody,
  resolveMcpServers,
  resolveModel,
  resolveProvider,
  resolveRunbookPath,
  resolveStepCommand,
  resolveStepPrompt,
  resolveStepScope,
  resolveStepServers,
  stepBody,
} from "../../src/config/yaml.ts";
import type { AgentYaml, RunnerConfig } from "../../src/types.ts";

test("resolveStepPrompt leaves external MCP text unchanged without appending feedback", () => {
  const step = { id: "review", promptRef: { server: "cat", name: "review" } };
  const config: RunnerConfig = { yamlPath: "agent.yaml", cwd: "/tmp", runbook: { steps: [step] } };
  const body = "Review {{feedback}} and ${{vars.example}} literally.";
  assert.equal(resolveStepPrompt(config, step, { feedback: "old error" }, { body }), body);
});

function configFor(runbook: AgentYaml, extra: Partial<RunnerConfig> = {}): RunnerConfig {
  return {
    yamlPath: "agent.yaml",
    cwd: "/tmp/project",
    runbook,
    ...extra,
  };
}

function withYamlFile(body: string, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "acp-yaml-"));
  const path = join(dir, "agent.yaml");
  writeFileSync(path, body);
  try {
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("loadAgentYaml: parses a full runbook", () => {
  withYamlFile(
    `
name: provider-swap
provider: claude
model: claude-sonnet-4-6
providers:
  fallback: [claude, gemini, codex]
  onSpawnError: swap
steps:
  - id: implement
    do: Implement it
  - id: harden
    provider: gemini
    model: composer
    do: Harden it
`,
    (path) => {
      const parsed = loadAgentYaml(path);
      assert.equal(parsed.name, "provider-swap");
      assert.equal(parsed.provider, "claude");
      assert.equal(parsed.model, "claude-sonnet-4-6");
      assert.deepEqual(parsed.providers?.fallback, ["claude", "gemini", "codex"]);
      assert.equal(parsed.providers?.onSpawnError, "swap");
      assert.equal(parsed.steps.length, 2);
      assert.equal(parsed.steps[1].provider, "gemini");
    },
  );
});

test("loadAgentYaml: rejects a runbook with no steps", () => {
  withYamlFile("name: broken\n", (path) => {
    assert.throws(() => loadAgentYaml(path), /steps: Required/);
  });
});

test("loadAgentYaml: rejects steps that are not a list", () => {
  withYamlFile("steps: nope\n", (path) => {
    assert.throws(() => loadAgentYaml(path), /steps: Expected array, received string/);
  });
});

test("loadAgentYaml: rejects an empty file", () => {
  withYamlFile("", (path) => {
    assert.throws(() => loadAgentYaml(path), /Expected object, received null/);
  });
});

test("stepBody: returns the do text", () => {
  assert.equal(stepBody({ id: "a", do: "from do" }, "."), "from do");
});

test("stepBody: undefined when the step has no body", () => {
  assert.equal(stepBody({ id: "a" }, "."), undefined);
});

test("stepBody: treats a whitespace-only body as absent", () => {
  assert.equal(stepBody({ id: "a", do: "   \n\t " }, "."), undefined);
});

test("stepBody: keeps the original spacing of a real body", () => {
  assert.equal(stepBody({ id: "a", do: "  Review the diff\n" }, "."), "  Review the diff\n");
});

test("resolveProvider: a step override wins over everything else", () => {
  const config = configFor(
    { provider: "claude", steps: [] },
    { providerOverride: "codex" },
  );
  assert.equal(resolveProvider(config, { id: "a", provider: "gemini" }), "gemini");
});

test("resolveProvider: the CLI override wins over the runbook provider", () => {
  const config = configFor(
    { provider: "claude", steps: [] },
    { providerOverride: "codex" },
  );
  assert.equal(resolveProvider(config, { id: "a", do: "Ship it" }), "codex");
});

test("resolveProvider: the runbook provider is used when nothing overrides it", () => {
  const config = configFor({ provider: "codex", steps: [] });
  assert.equal(resolveProvider(config, { id: "a", do: "Ship it" }), "codex");
  assert.equal(resolveProvider(config), "codex");
});

test("resolveProvider: a runbook-declared provider can be the runbook provider", () => {
  const config = configFor({
    provider: "amp",
    providers: { agentHarness: { amp: { command: "amp", args: ["--acp"] } } },
    steps: [],
  });
  assert.equal(resolveProvider(config), "amp");
});

test("resolveProvider: falls back to a real provider when the runbook says nothing", () => {
  const config = configFor({ steps: [] });
  assert.ok(["claude", "codex", "gemini"].includes(resolveProvider(config)));
});

test("resolveModel: a step model wins over the runbook model", () => {
  const config = configFor({ model: "sonnet", steps: [] });
  assert.equal(resolveModel(config, { id: "a", model: "composer" }), "composer");
});

test("resolveModel: the runbook model applies when the step names no model", () => {
  const config = configFor({ model: "sonnet", steps: [] });
  assert.equal(resolveModel(config, { id: "a", do: "Ship it" }), "sonnet");
  assert.equal(resolveModel(config), "sonnet");
});

test("resolveModel: undefined when no model is configured anywhere", () => {
  assert.equal(resolveModel(configFor({ steps: [] }), { id: "a", do: "Ship it" }), undefined);
});

test("resolveModel: step overrides selected harness, which overrides the workflow default", () => {
  const config = configFor({
    model: "workflow-model",
    providers: { agentHarness: {
      writer: { command: "writer", model: "writer-model" },
      reviewer: { command: "reviewer", model: "reviewer-model" },
    } },
    steps: [],
  }, { providerOverride: "reviewer" });
  assert.equal(resolveModel(config), "reviewer-model");
  assert.equal(resolveModel(config, { id: "a", provider: "writer" }), "writer-model");
  assert.equal(resolveModel(config, { id: "a", provider: "writer", model: "step-model" }), "step-model");
});

test("resolveStepPrompt: renders the step body with workflow variables", () => {
  const config = configFor({
    vars: { done_token: "DONE" }, steps: [{ id: "verify", do: "Reply {{done_token}}" }],
  });
  assert.equal(resolveStepPrompt(config, config.runbook.steps[0]), "Reply DONE");
});

test("resolveStepPrompt: an empty body is an error, since there is no goal to fall back on", () => {
  const config = configFor({ steps: [{ id: "implement", do: "  " }] });
  assert.throws(
    () => resolveStepPrompt(config, config.runbook.steps[0]),
    /step implement: no prompt body/,
  );
});

test("needsNewBody: a different provider needs a new body", () => {
  assert.equal(needsNewBody({ provider: "claude" }, { provider: "gemini" }), true);
});

test("needsNewBody: the same provider and model stays on the live connection", () => {
  assert.equal(
    needsNewBody({ provider: "claude", model: "sonnet" }, { provider: "claude", model: "sonnet" }),
    false,
  );
  assert.equal(needsNewBody({ provider: "claude" }, { provider: "claude" }), false);
});

test("needsNewBody: switching model on the same provider needs a new body", () => {
  assert.equal(
    needsNewBody({ provider: "claude", model: "sonnet" }, { provider: "claude", model: "opus" }),
    true,
  );
});

test("needsNewBody: naming a model where there was none needs a new body", () => {
  assert.equal(needsNewBody({ provider: "claude" }, { provider: "claude", model: "opus" }), true);
});

test("needsNewBody: a step that names no model inherits the live one", () => {
  assert.equal(
    needsNewBody({ provider: "claude", model: "sonnet" }, { provider: "claude" }),
    false,
  );
});

test("resolveStepPrompt: do { file } loads the body relative to the yaml", () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-stepfile-"));
  try {
    writeFileSync(join(dir, "harden.md"), "Review the workspace.\nFocus on {{review_focus}}.\n");
    const config = configFor(
      {
        vars: { review_focus: "security" },
        steps: [{ id: "harden", do: { file: "harden.md" } }],
      },
      { yamlPath: join(dir, "agent.yaml"), cwd: "/tmp/project" },
    );

    assert.equal(
      resolveStepPrompt(config, config.runbook.steps[0]),
      "Review the workspace.\nFocus on security.\n",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveStepPrompt: a missing do { file } throws and names the step", () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-stepfile-"));
  try {
    const config = configFor(
      { steps: [{ id: "harden", do: { file: "absent.md" } }] },
      { yamlPath: join(dir, "agent.yaml") },
    );

    assert.throws(
      () => resolveStepPrompt(config, config.runbook.steps[0]),
      /step harden: cannot read absent.md/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadAgentYaml: rejects a runbook still wrapped in agent:", () => {
  withYamlFile("agent:\n  steps:\n    - id: one\n", (path) => {
    assert.throws(() => loadAgentYaml(path), /Unrecognized key\(s\) in object: 'agent'/);
  });
});

test("loadAgentYaml: schema paths no longer carry an agent prefix", () => {
  withYamlFile("steps:\n  - id: one\n    provider: invalid\n", (path) => {
    assert.throws(() => loadAgentYaml(path), (error: Error) => {
      assert.match(error.message, /steps\[0\]\.provider/);
      assert.equal(error.message.includes("agent.steps"), false);
      return true;
    });
  });
});

function withAgentFolder(
  files: Record<string, string>,
  fn: (dir: string) => void,
): void {
  const dir = mkdtempSync(join(tmpdir(), "acp-folder-"));
  try {
    for (const [name, body] of Object.entries(files)) {
      const target = join(dir, name);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, body, "utf8");
    }
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("resolveRunbookPath: a folder means the agent.yaml inside it", () => {
  withAgentFolder({ "agent.yaml": "name: folder-agent\nsteps:\n  - id: one\n    do: Ship it\n" }, (dir) => {
    assert.equal(resolveRunbookPath(dir), join(dir, "agent.yaml"));
    assert.equal(loadAgentYaml(resolveRunbookPath(dir)).name, "folder-agent");
  });
});

test("resolveRunbookPath: a file path is returned unchanged", () => {
  withAgentFolder({ "runbook.yaml": "steps:\n  - id: one\n    do: Ship it\n" }, (dir) => {
    const path = join(dir, "runbook.yaml");
    assert.equal(resolveRunbookPath(path), path);
  });
});

test("resolveRunbookPath: a folder with no agent.yaml names the folder", () => {
  withAgentFolder({ "notes.md": "hello" }, (dir) => {
    assert.throws(() => resolveRunbookPath(dir), new RegExp(`${dir}: no agent.yaml in this folder`));
  });
});

test("resolveStepPrompt: a folder's prompt file resolves inside the folder", () => {
  withAgentFolder(
    {
      "agent.yaml": "vars:\n  focus: security\nsteps:\n  - id: harden\n    do: { file: prompts/body.md }\n",
      "prompts/body.md": "Review for {{focus}}.\n",
    },
    (dir) => {
      const yamlPath = resolveRunbookPath(dir);
      const config = configFor(loadAgentYaml(yamlPath), { yamlPath });
      assert.equal(resolveStepPrompt(config, config.runbook.steps[0]), "Review for security.\n");
    },
  );
});

function withMcpFolder(
  yaml: string,
  files: Record<string, string>,
  fn: (dir: string, servers: Array<Record<string, any>>) => void,
): void {
  withAgentFolder({ "agent.yaml": yaml, ...files }, (dir) => {
    const yamlPath = resolveRunbookPath(dir);
    const config = configFor(loadAgentYaml(yamlPath), { yamlPath, cwd: "/tmp/elsewhere" });
    fn(dir, resolveMcpServers(config) as unknown as Array<Record<string, any>>);
  });
}

test("resolveMcpServers: a runbook with no mcpServers has no servers", () => {
  assert.deepEqual(resolveMcpServers(configFor({ steps: [] })), []);
});

test("resolveMcpServers: the map key is the name, and args and env default to empty", () => {
  const config = configFor({ providers: { mcpServers: { echo: { command: "node" } } }, steps: [] });
  assert.deepEqual(resolveMcpServers(config), [
    { type: "stdio", name: "echo", command: "node", args: [], env: [] },
  ]);
});

test("resolveMcpServers: a folder-relative arg resolves inside the agent folder, never the cwd", () => {
  withMcpFolder(
    'providers:\n  mcpServers:\n    echo:\n      command: node\n      args: ["tools/echo.mjs"]\nsteps:\n  - id: one\n    do: Ship it\n',
    { "tools/echo.mjs": "" },
    (dir, servers) => {
      assert.equal(servers[0].args[0], join(dir, "tools/echo.mjs"));
      assert.equal(servers[0].args[0].includes("/tmp/elsewhere"), false);
    },
  );
});

test("resolveMcpServers: an arg with a slash that is not in the folder is left alone", () => {
  withMcpFolder(
    'providers:\n  mcpServers:\n    echo:\n      command: node\n      args: ["tools/absent.mjs"]\nsteps:\n  - id: one\n    do: Ship it\n',
    {},
    (_dir, servers) => {
      assert.deepEqual(servers[0].args, ["tools/absent.mjs"]);
    },
  );
});

test("resolveMcpServers: an arg with no slash is never touched, even when the folder holds that file", () => {
  withMcpFolder(
    'providers:\n  mcpServers:\n    echo:\n      command: node\n      args: ["--profile", "default"]\nsteps:\n  - id: one\n    do: Ship it\n',
    { default: "" },
    (_dir, servers) => {
      assert.deepEqual(servers[0].args, ["--profile", "default"]);
    },
  );
});

test("resolveMcpServers: an absolute arg is left alone", () => {
  withMcpFolder(
    'providers:\n  mcpServers:\n    echo:\n      command: node\n      args: ["/opt/tools/echo.mjs"]\nsteps:\n  - id: one\n    do: Ship it\n',
    {},
    (_dir, servers) => {
      assert.deepEqual(servers[0].args, ["/opt/tools/echo.mjs"]);
    },
  );
});

test("resolveMcpServers: a bare command stays a PATH lookup, a folder command is made absolute", () => {
  withMcpFolder(
    "providers:\n  mcpServers:\n    bare:\n      command: node\n    local:\n      command: tools/serve.sh\nsteps:\n  - id: one\n    do: Ship it\n",
    { "tools/serve.sh": "" },
    (dir, servers) => {
      assert.equal(servers[0].command, "node");
      assert.equal(servers[1].command, join(dir, "tools/serve.sh"));
    },
  );
});

test("resolveMcpServers: env becomes a name/value list and renders {{env.X}}", () => {
  process.env.ACP_TEST_MCP_TOKEN = "sekret";
  try {
    const config = configFor({
      providers: { mcpServers: { echo: { command: "node", env: { TOKEN: "{{env.ACP_TEST_MCP_TOKEN}}" } } } },
      steps: [],
    });
    assert.deepEqual(resolveMcpServers(config)[0], {
      type: "stdio",
      name: "echo",
      command: "node",
      args: [],
      env: [{ name: "TOKEN", value: "sekret" }],
    });
  } finally {
    delete process.env.ACP_TEST_MCP_TOKEN;
  }
});

test("resolveMcpServers: an unset environment variable fails and names the server", () => {
  const config = configFor({
    providers: { mcpServers: { "gcp-usage": { command: "python", env: { KEY: "{{env.ACP_TEST_ABSENT}}" } } } },
    steps: [],
  });
  assert.throws(
    () => resolveMcpServers(config),
    /mcpServers gcp-usage: environment variable ACP_TEST_ABSENT is not set/,
  );
});

test("resolveMcpServers: a pasted json block resolves the same as the block form", () => {
  withMcpFolder(
    'providers: { mcpServers: { "echo": { "command": "node", "args": ["tools/echo.mjs"], "type": "stdio" } } }\nsteps:\n  - id: one\n    do: Ship it\n',
    { "tools/echo.mjs": "" },
    (dir, servers) => {
      assert.deepEqual(servers, [
        { type: "stdio", name: "echo", command: "node", args: [join(dir, "tools/echo.mjs")], env: [] },
      ]);
    },
  );
});

test("resolveStepServers: a step that names no servers gets the whole catalogue", () => {
  const config = configFor({
    providers: { mcpServers: { echo: { command: "node" }, other: { command: "node" } } },
    steps: [{ id: "one", do: "A" }],
  });
  assert.deepEqual(
    resolveStepServers(config, config.runbook.steps[0]).map((server) => server.name),
    ["echo", "other"],
  );
});

test("resolveStepServers: servers names a subset, and an empty list means no tools", () => {
  const config = configFor({
    providers: { mcpServers: { echo: { command: "node" }, other: { command: "node" } } },
    steps: [
      { id: "one", do: "A", servers: ["other"] },
      { id: "two", do: "B", servers: [] },
    ],
  });
  assert.deepEqual(
    resolveStepServers(config, config.runbook.steps[0]).map((server) => server.name),
    ["other"],
  );
  assert.deepEqual(resolveStepServers(config, config.runbook.steps[1]), []);
});

test("needsNewBody: a different server set stays on the live connection", () => {
  assert.equal(needsNewBody({ provider: "claude" }, { provider: "claude" }), false);
});

test("needsNewBody: only the provider and the model can force a new body", () => {
  assert.equal(needsNewBody({ provider: "claude" }, { provider: "gemini" }), true);
  assert.equal(
    needsNewBody({ provider: "claude", model: "a" }, { provider: "claude", model: "b" }),
    true,
  );
  assert.equal(
    needsNewBody({ provider: "claude", model: "a" }, { provider: "claude", model: "a" }),
    false,
  );
});

test("resolveMcpServers: a remote server renders headers and leaves the url alone", () => {
  const config = configFor({
    vars: { token: "s3cret" },
    providers: { mcpServers: {
      jira: {
        type: "sse",
        url: "https://mcp.example.com/jira/sse",
        headers: { Authorization: "Bearer {{token}}" },
      },
    } },
    steps: [],
  });
  assert.deepEqual(resolveMcpServers(config), [
    {
      type: "sse",
      name: "jira",
      url: "https://mcp.example.com/jira/sse",
      headers: [{ name: "Authorization", value: "Bearer s3cret" }],
    },
  ]);
});

test("resolveMcpServers: a remote url is never rewritten as a folder-relative path", () => {
  withMcpFolder(
    "providers:\n  mcpServers:\n    db:\n      type: http\n      url: http://127.0.0.1:9/tools/db\nsteps:\n  - id: one\n    do: Ship it\n",
    { "tools/db": "" },
    (_dir, servers) => {
      assert.equal((servers[0] as { url: string }).url, "http://127.0.0.1:9/tools/db");
    },
  );
});

test("resolveStepServers: a servers map selects the named servers", () => {
  const config = configFor({
    providers: { mcpServers: { a: { command: "node" }, b: { command: "node" } } },
    steps: [{ id: "one", servers: { a: { allow: ["x"] } } }],
  });
  assert.deepEqual(
    resolveStepServers(config, config.runbook.steps[0]).map((server) => server.name),
    ["a"],
  );
});

test("resolveStepScope: an omitted list scopes every declared server", () => {
  const config = configFor({
    providers: { mcpServers: { a: { command: "node" }, b: { command: "node" } } },
    steps: [{ id: "one", do: "Ship it" }],
  });
  assert.deepEqual(resolveStepScope(config, config.runbook.steps[0]), { a: {}, b: {} });
});

test("resolveStepCommand: renders the step run command with workflow and step variables", () => {
  const config = configFor({
    vars: { projects: "proj1,proj2", mode: "all" },
    steps: [
      { id: "notify", run: "node notify.ts --projects {{projects}} --mode {{mode}}" },
      {
        id: "custom",
        vars: { projects: "proj3" },
        run: "node notify.ts --projects {{projects}}",
      },
    ],
  });

  assert.equal(
    resolveStepCommand(config, config.runbook.steps[0]),
    "node notify.ts --projects proj1,proj2 --mode all",
  );
  assert.equal(
    resolveStepCommand(config, config.runbook.steps[1]),
    "node notify.ts --projects proj3",
  );
});

test("resolveStepCommand: renders the run command on a composite step", () => {
  const config = configFor({
    vars: { target: "output.json" },
    steps: [{ id: "verify", do: "verify output", run: "test -f {{target}}" }],
  });

  assert.equal(
    resolveStepCommand(config, config.runbook.steps[0]),
    "test -f output.json",
  );
});

test("resolveStepCommand: renders {{env.VAR}} in command string", () => {
  process.env.ACP_TEST_FLAG = "--verbose";
  try {
    const config = configFor({
      steps: [{ id: "test", run: "npm test -- {{env.ACP_TEST_FLAG}}" }],
    });
    assert.equal(
      resolveStepCommand(config, config.runbook.steps[0]),
      "npm test -- --verbose",
    );
  } finally {
    delete process.env.ACP_TEST_FLAG;
  }
});

test("resolveStepCommand: returns undefined when step has no run", () => {
  const config = configFor({
    steps: [{ id: "implement", do: "implement feature" }],
  });

  assert.equal(resolveStepCommand(config, config.runbook.steps[0]), undefined);
});

test("resolveStepCommand: an unknown placeholder throws and names the step", () => {
  const config = configFor({
    steps: [{ id: "notify", run: "node notify.ts --projects {{projects}}" }],
  });

  assert.throws(
    () => resolveStepCommand(config, config.runbook.steps[0]),
    /step notify: unknown variable \{\{projects\}\}/,
  );
});
