import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgentYaml } from "../../src/config/yaml.ts";

function withYamlFile(body: string, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "acp-schema-"));
  const path = join(dir, "agent.yaml");
  writeFileSync(path, body, "utf8");
  try {
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const WRITER = "providers:\n  writer:\n    command: npx\n    args: [\"-y\", \"claude-acp\"]\n    model: sonnet\n";

test("loadAgentYaml: providers maps a name straight to a harness", () => {
  withYamlFile(`${WRITER}steps:\n  - id: one\n    provider: writer\n    do: Ship it\n`, (path) => {
    assert.deepEqual(loadAgentYaml(path).providers, {
      writer: { command: "npx", args: ["-y", "claude-acp"], model: "sonnet" },
    });
  });
});

test("loadAgentYaml: a harness needs a model", () => {
  withYamlFile(
    "providers:\n  writer:\n    command: npx\nsteps:\n  - id: one\n    provider: writer\n    do: Ship it\n",
    (path) => {
      assert.throws(() => loadAgentYaml(path), /providers\.writer\.model: Required/);
    },
  );
});

test("loadAgentYaml: mcpServers is a top-level key", () => {
  withYamlFile(
    `${WRITER}mcpServers:\n  greet:\n    command: node\nsteps:\n  - id: one\n    provider: writer\n    mcpServers: [greet]\n    do: Ship it\n`,
    (path) => {
      assert.deepEqual(loadAgentYaml(path).mcpServers, { greet: { command: "node" } });
    },
  );
});

test("loadAgentYaml: a top-level provider or model is rejected", () => {
  for (const line of ["provider: writer\n", "model: sonnet\n"]) {
    withYamlFile(`${WRITER}${line}steps:\n  - id: one\n    provider: writer\n    do: Ship it\n`, (path) => {
      assert.throws(() => loadAgentYaml(path), /Unrecognized key\(s\) in object/);
    });
  }
});

test("loadAgentYaml: a step model is rejected", () => {
  withYamlFile(`${WRITER}steps:\n  - id: one\n    provider: writer\n    model: opus\n    do: Ship it\n`, (path) => {
    assert.throws(() => loadAgentYaml(path), /Unrecognized key\(s\) in object: 'model'/);
  });
});

test("loadAgentYaml: only declared harnesses exist", () => {
  withYamlFile(`${WRITER}steps:\n  - id: one\n    provider: claude\n    do: Ship it\n`, (path) => {
    assert.throws(() => loadAgentYaml(path), /steps\[0\]\.provider: unknown provider "claude" \(known: writer\)/);
  });
});

test("loadAgentYaml: a model step must name its provider", () => {
  withYamlFile(`${WRITER}steps:\n  - id: one\n    do: Ship it\n`, (path) => {
    assert.throws(() => loadAgentYaml(path), /steps\[0\]\.provider: step "one" needs a provider/);
  });
});

const GREET = `${WRITER}mcpServers:\n  greet:\n    command: node\n`;

test("loadAgentYaml: do is inline text or a file, not an MCP prompt", () => {
  withYamlFile(`${GREET}steps:\n  - id: one\n    provider: writer\n    do: { mcpServer: greet, name: critique }\n`, (path) => {
    assert.throws(() => loadAgentYaml(path), /steps\[0\]\.do/);
  });
});

test("loadAgentYaml: a resource var names its server with mcpServer", () => {
  withYamlFile(`${GREET}vars:\n  style: { resource: "mem://style", mcpServer: greet }\nsteps:\n  - id: one\n    run: "true"\n`, (path) => {
    assert.deepEqual(loadAgentYaml(path).vars?.style, { resource: "mem://style", mcpServer: "greet" });
  });
});

test("loadAgentYaml: promptRef is rejected", () => {
  withYamlFile(`${GREET}steps:\n  - id: one\n    provider: writer\n    promptRef: { mcpServer: greet, name: critique }\n`, (path) => {
    assert.throws(() => loadAgentYaml(path), /Unrecognized key\(s\) in object: 'promptRef'/);
  });
});

test("loadAgentYaml: a step scopes servers with mcpServers", () => {
  withYamlFile(`${GREET}steps:\n  - id: one\n    provider: writer\n    mcpServers: { greet: { allow: [hello] } }\n    do: Ship it\n`, (path) => {
    assert.deepEqual(loadAgentYaml(path).steps[0].mcpServers, { greet: { allow: ["hello"] } });
  });
});

test("loadAgentYaml: a step servers key is rejected", () => {
  withYamlFile(`${GREET}steps:\n  - id: one\n    provider: writer\n    servers: [greet]\n    do: Ship it\n`, (path) => {
    assert.throws(() => loadAgentYaml(path), /Unrecognized key\(s\) in object: 'servers'/);
  });
});

test("loadAgentYaml: accepts name and description top-level metadata", () => {
  withYamlFile(
    'providers:\n  claude:\n    command: npx\n    model: test-model\nname: code-repair\ndescription: "Iteratively fixes failing tests"\nsteps:\n  - id: one\n    provider: claude\n    do: Ship it\n',
    (path) => {
      const parsed = loadAgentYaml(path);
      assert.equal(parsed.name, "code-repair");
      assert.equal(parsed.description, "Iteratively fixes failing tests");
    },
  );
});

test("loadAgentYaml: a model step with no provider on the step or the runbook is rejected", () => {
  withYamlFile("steps:\n  - id: check\n    run: \"true\"\n  - id: one\n    do: Ship it\n", (path) => {
    assert.throws(() => loadAgentYaml(path), /steps\[1\]\.provider: step "one" needs a provider/);
  });
});

test("loadAgentYaml: a script-only runbook needs no provider", () => {
  withYamlFile("steps:\n  - id: check\n    run: \"true\"\n", (path) => {
    assert.equal(loadAgentYaml(path).steps[0].id, "check");
  });
});

test("loadAgentYaml: rejects an unknown key in a step", () => {
  withYamlFile("providers:\n  claude:\n    command: npx\n    model: test-model\nsteps:\n  - id: one\n    dooo: hi\n", (path) => {
    assert.throws(() => loadAgentYaml(path), /steps\[0\][\s\S]*dooo/);
  });
});

test("loadAgentYaml: accepts an mcpServers map", () => {
  withYamlFile(
    'providers:\n  claude:\n    command: npx\n    model: test-model\nmcpServers:\n  echo:\n    command: node\n    args: ["tools/echo.mjs"]\n    env:\n      TOKEN: abc\nsteps:\n  - id: one\n    provider: claude\n    do: Ship it\n',
    (path) => {
      const parsed = loadAgentYaml(path);
      assert.deepEqual(parsed.mcpServers?.echo, {
        command: "node",
        args: ["tools/echo.mjs"],
        env: { TOKEN: "abc" },
      });
    },
  );
});

test("loadAgentYaml: an mcp server needs a command", () => {
  withYamlFile('providers:\n  claude:\n    command: npx\n    model: test-model\nmcpServers:\n  echo:\n    args: ["x"]\nsteps:\n  - id: one\n    provider: claude\n    do: Ship it\n', (path) => {
    assert.throws(() => loadAgentYaml(path), /mcpServers\.echo[\s\S]*command: Required/);
  });
});

test("loadAgentYaml: type stdio is accepted so a pasted json block still parses", () => {
  withYamlFile(
    'providers:\n  claude:\n    command: npx\n    model: test-model\nmcpServers: { "echo": { "command": "node", "args": ["tools/echo.mjs"], "type": "stdio" } }\nsteps:\n  - id: one\n    provider: claude\n    do: Ship it\n',
    (path) => {
      assert.deepEqual(loadAgentYaml(path).mcpServers?.echo, {
        type: "stdio",
        command: "node",
        args: ["tools/echo.mjs"],
      });
    },
  );
});

test("loadAgentYaml: a stdio command with a remote type is rejected", () => {
  withYamlFile("providers:\n  claude:\n    command: npx\n    model: test-model\nmcpServers:\n  remote:\n    command: node\n    type: http\nsteps:\n  - id: one\n    provider: claude\n    do: Ship it\n", (path) => {
    assert.throws(() => loadAgentYaml(path), /mcpServers\.remote[\s\S]*url: Required/);
  });
});

test("loadAgentYaml: an unknown key inside an mcp server is rejected", () => {
  withYamlFile("providers:\n  claude:\n    command: npx\n    model: test-model\nmcpServers:\n  remote:\n    command: node\n    url: http://x\nsteps:\n  - id: one\n    provider: claude\n    do: Ship it\n", (path) => {
    assert.throws(() => loadAgentYaml(path), /mcpServers\.remote[\s\S]*url/);
  });
});

test("loadAgentYaml: a step naming a server that was never declared is rejected", () => {
  withYamlFile(
    "providers:\n  claude:\n    command: npx\n    model: test-model\nmcpServers:\n  slack:\n    command: python\nsteps:\n  - id: one\n    provider: claude\n    do: Ship it\n  - id: two\n    mcpServers: [slak]\n",
    (path) => {
      assert.throws(() => loadAgentYaml(path), /steps\[1\]\.mcpServers: unknown server "slak"/);
    },
  );
});

test("loadAgentYaml: a step may name a declared server", () => {
  withYamlFile(
    "providers:\n  claude:\n    command: npx\n    model: test-model\nmcpServers:\n  slack:\n    command: python\nsteps:\n  - id: one\n    provider: claude\n    do: Ship it\n    mcpServers: [slack]\n",
    (path) => {
      assert.deepEqual(loadAgentYaml(path).steps[0].mcpServers, ["slack"]);
    },
  );
});

test("loadAgentYaml: accepts a step with run and on transitions", () => {
  withYamlFile(
    'providers:\n  claude:\n    command: npx\n    model: test-model\nsteps:\n  - id: one\n    provider: claude\n    do: Ship it\n  - id: two\n    run: "npm test"\n    on:\n      success: one\n      failure:\n        target: one\n        maxAttempts: 3\n        fallback: one\n',
    (path) => {
      const parsed = loadAgentYaml(path);
      assert.equal(parsed.steps[1].run, "npm test");
      assert.deepEqual(parsed.steps[1].on, {
        success: "one",
        failure: {
          target: "one",
          maxAttempts: 3,
          fallback: "one",
        },
      });
    },
  );
});

test("loadAgentYaml: rejects a transition pointing to an unknown step", () => {
  withYamlFile(
    'steps:\n  - id: one\n    on:\n      success: nonexistent\n',
    (path) => {
      assert.throws(() => loadAgentYaml(path), /steps\[0\]\.on\.success: unknown step "nonexistent"/);
    },
  );
});

test("loadAgentYaml: accepts END and FAIL terminal targets case-insensitively", () => {
  withYamlFile(
    'providers:\n  claude:\n    command: npx\n    model: test-model\nsteps:\n  - id: verify\n    run: "npm test"\n    on:\n      success: END\n      failure:\n        target: fix\n        maxAttempts: 2\n        fallback: FAIL\n  - id: fix\n    provider: claude\n    do: Fix it\n    on:\n      success: verify\n      failure: fail\n  - id: cleanup\n    provider: claude\n    do: Clean up\n    on:\n      success: end\n',
    (path) => {
      const parsed = loadAgentYaml(path);
      assert.equal(parsed.steps[0].on?.success, "END");
      assert.deepEqual(parsed.steps[0].on?.failure, {
        target: "fix",
        maxAttempts: 2,
        fallback: "FAIL",
      });
      assert.equal(parsed.steps[1].on?.failure, "fail");
      assert.equal(parsed.steps[2].on?.success, "end");
    },
  );
});

test("loadAgentYaml: rejects reserved step IDs 'end' and 'fail'", () => {
  withYamlFile("providers:\n  claude:\n    command: npx\n    model: test-model\nsteps:\n  - id: end\n    provider: claude\n    do: Ship it\n", (path) => {
    assert.throws(() => loadAgentYaml(path), /steps\[0\]\.id: step id "end" is reserved/);
  });
  withYamlFile("providers:\n  claude:\n    command: npx\n    model: test-model\nsteps:\n  - id: END\n    provider: claude\n    do: Ship it\n", (path) => {
    assert.throws(() => loadAgentYaml(path), /steps\[0\]\.id: step id "END" is reserved/);
  });
  withYamlFile("providers:\n  claude:\n    command: npx\n    model: test-model\nsteps:\n  - id: fail\n    provider: claude\n    do: Ship it\n", (path) => {
    assert.throws(() => loadAgentYaml(path), /steps\[0\]\.id: step id "fail" is reserved/);
  });
  withYamlFile("providers:\n  claude:\n    command: npx\n    model: test-model\nsteps:\n  - id: FAIL\n    provider: claude\n    do: Ship it\n", (path) => {
    assert.throws(() => loadAgentYaml(path), /steps\[0\]\.id: step id "FAIL" is reserved/);
  });
});

test("loadAgentYaml: rejects snake_case keys", () => {
  withYamlFile("providers:\n  claude:\n    command: npx\n    model: test-model\nsteps:\n  - id: route\n    provider: claude\n    do: Route it\n    retry:\n      max_attempts: 2\n", (path) => {
    assert.throws(() => loadAgentYaml(path), /max_attempts/);
  });
  withYamlFile(
    "providers:\n  claude:\n    command: npx\n    model: test-model\nsteps:\n  - id: route\n    provider: claude\n    do: Route it\n    on:\n      failure:\n        target: route\n        max_attempts: 2\n",
    (path) => {
      assert.throws(() => loadAgentYaml(path), /max_attempts/);
    },
  );
});

test("loadAgentYaml: accepts step retry configuration", () => {
  withYamlFile(
    `providers:
  claude:
    command: npx
    model: test-model

steps:
  - id: route
    provider: claude
    do: Route it
    retry:
      maxAttempts: 3
      fallback: fail
`,
    (path) => {
      const parsed = loadAgentYaml(path);
      assert.deepEqual(parsed.steps[0].retry, {
        maxAttempts: 3,
        fallback: "fail",
      });
    },
  );
});


test("loadAgentYaml: accepts an sse server", () => {
  withYamlFile(
    'providers:\n  claude:\n    command: npx\n    model: test-model\nmcpServers:\n  jira:\n    type: sse\n    url: https://mcp.example.com/jira/sse\n    headers:\n      Authorization: "Bearer x"\nsteps:\n  - id: one\n    provider: claude\n    do: Ship it\n',
    (path) => {
      assert.deepEqual(loadAgentYaml(path).mcpServers?.jira, {
        type: "sse",
        url: "https://mcp.example.com/jira/sse",
        headers: { Authorization: "Bearer x" },
      });
    },
  );
});

test("loadAgentYaml: accepts an http server", () => {
  withYamlFile(
    "providers:\n  claude:\n    command: npx\n    model: test-model\nmcpServers:\n  db:\n    type: http\n    url: https://mcp.example.com/postgres\nsteps:\n  - id: one\n    provider: claude\n    do: Ship it\n",
    (path) => {
      assert.deepEqual(loadAgentYaml(path).mcpServers?.db, {
        type: "http",
        url: "https://mcp.example.com/postgres",
      });
    },
  );
});

test("loadAgentYaml: rejects a server mixing stdio and remote keys", () => {
  withYamlFile(
    "providers:\n  claude:\n    command: npx\n    model: test-model\nmcpServers:\n  bad:\n    type: http\n    url: https://x.test/mcp\n    command: node\nsteps:\n  - id: one\n    provider: claude\n    do: Ship it\n",
    (path) => {
      assert.throws(() => loadAgentYaml(path), /mcpServers\.bad/);
    },
  );
});

test("loadAgentYaml: rejects a url on a stdio server", () => {
  withYamlFile(
    "providers:\n  claude:\n    command: npx\n    model: test-model\nmcpServers:\n  bad:\n    command: node\n    url: https://x.test/mcp\nsteps:\n  - id: one\n    provider: claude\n    do: Ship it\n",
    (path) => {
      assert.throws(() => loadAgentYaml(path), /mcpServers\.bad/);
    },
  );
});

test("loadAgentYaml: rejects a remote server with a bad url", () => {
  withYamlFile("providers:\n  claude:\n    command: npx\n    model: test-model\nmcpServers:\n  bad:\n    type: http\n    url: nope\nsteps:\n  - id: one\n    provider: claude\n    do: Ship it\n", (path) => {
    assert.throws(() => loadAgentYaml(path), /mcpServers\.bad/);
  });
});

test("loadAgentYaml: accepts a servers map with allow and deny", () => {
  withYamlFile(
    'providers:\n  claude:\n    command: npx\n    model: test-model\nmcpServers:\n  db:\n    command: node\nsteps:\n  - id: one\n    provider: claude\n    do: Ship it\n    mcpServers:\n      db: { allow: ["select"], deny: ["drop_*"] }\n',
    (path) => {
      assert.deepEqual(loadAgentYaml(path).steps[0].mcpServers, {
        db: { allow: ["select"], deny: ["drop_*"] },
      });
    },
  );
});

test("loadAgentYaml: rejects a servers map naming an undeclared server", () => {
  withYamlFile(
    "providers:\n  claude:\n    command: npx\n    model: test-model\nmcpServers:\n  db:\n    command: node\nsteps:\n  - id: one\n    mcpServers:\n      ghost: {}\n",
    (path) => {
      assert.throws(() => loadAgentYaml(path), /unknown server "ghost"/);
    },
  );
});

test("loadAgentYaml: rejects an empty allow pattern", () => {
  withYamlFile(
    'providers:\n  claude:\n    command: npx\n    model: test-model\nmcpServers:\n  db:\n    command: node\nsteps:\n  - id: one\n    mcpServers:\n      db: { allow: [""] }\n',
    (path) => {
      assert.throws(() => loadAgentYaml(path), /steps\[0\]\.mcpServers/);
    },
  );
});

test("loadAgentYaml: accepts a resource variable source", () => {
  withYamlFile(
    'providers:\n  claude:\n    command: npx\n    model: test-model\nmcpServers:\n  db:\n    command: node\nsteps:\n  - id: one\n    provider: claude\n    do: hi\n    vars:\n      ddl: { resource: "postgres://x", mcpServer: db }\n',
    (path) => {
      assert.deepEqual(loadAgentYaml(path).steps[0].vars?.ddl, {
        resource: "postgres://x",
        mcpServer: "db",
      });
    },
  );
});

test("loadAgentYaml: rejects a resource variable naming an undeclared server", () => {
  withYamlFile(
    'steps:\n  - id: one\n    do: hi\n    vars:\n      ddl: { resource: "postgres://x", mcpServer: db }\n',
    (path) => {
      assert.throws(() => loadAgentYaml(path), /unknown server "db"/);
    },
  );
});

test("loadAgentYaml: rejects a step with no do or run", () => {
  withYamlFile("providers:\n  claude:\n    command: npx\n    model: test-model\nsteps:\n  - id: implement\n", (path) => {
    assert.throws(() => loadAgentYaml(path), /step must have do or run/);
  });
});

test("loadAgentYaml: a step body is do, not prompt", () => {
  withYamlFile("providers:\n  claude:\n    command: npx\n    model: test-model\nsteps:\n  - id: implement\n    prompt: Ship it\n", (path) => {
    assert.throws(() => loadAgentYaml(path), /Unrecognized key\(s\) in object: 'prompt'/);
  });
});

test("loadAgentYaml: do accepts a file source", () => {
  withYamlFile("providers:\n  claude:\n    command: npx\n    model: test-model\nsteps:\n  - id: draft\n    provider: claude\n    do: { file: templates/draft.md }\n", (path) => {
    assert.deepEqual(loadAgentYaml(path).steps[0].do, { file: "templates/draft.md" });
  });
});

test("loadAgentYaml: a step-level file key is rejected", () => {
  withYamlFile("providers:\n  claude:\n    command: npx\n    model: test-model\nsteps:\n  - id: draft\n    file: templates/draft.md\n", (path) => {
    assert.throws(() => loadAgentYaml(path), /Unrecognized key\(s\) in object: 'file'/);
  });
});

test("loadAgentYaml: do rejects an object that is not a file source", () => {
  withYamlFile("providers:\n  claude:\n    command: npx\n    model: test-model\nsteps:\n  - id: draft\n    provider: claude\n    do: { path: templates/draft.md }\n", (path) => {
    assert.throws(() => loadAgentYaml(path));
  });
});

test("loadAgentYaml: accepts a step whose only body is run", () => {
  withYamlFile("providers:\n  claude:\n    command: npx\n    model: test-model\nsteps:\n  - id: verify\n    run: bun test\n", (path) => {
    assert.equal(loadAgentYaml(path).steps[0].id, "verify");
  });
});

test("loadAgentYaml: a step scoping an undeclared server is still an error", () => {
  withYamlFile(
    "providers:\n  claude:\n    command: npx\n    model: test-model\nmcpServers:\n  greet:\n    command: node\nsteps:\n  - id: one\n    provider: claude\n    mcpServers: [nope]\n    do: Ship it\n",
    (path) => {
      assert.throws(() => loadAgentYaml(path), /unknown server "nope"/);
    },
  );
});

test("loadAgentYaml: a harness entry must not carry default keys", () => {
  withYamlFile(
    "providers:\n  claude:\n    command: npx\n    model: test-model\n  amp:\n    provider: claude\n    model: test-model\nsteps:\n  - id: one\n    provider: claude\n    do: Ship it\n",
    (path) => {
      assert.throws(() => loadAgentYaml(path), /amp/);
    },
  );
});

test("loadAgentYaml: defaults, fallback and onSpawnError are not root keys", () => {
  for (const block of [
    "defaults:\n  provider: claude\n",
    "fallback: [claude]\n",
    "onSpawnError: fail\n",
  ]) {
    withYamlFile(`${block}steps:\n  - id: one\n    do: Ship it\n`, (path) => {
      assert.throws(() => loadAgentYaml(path), /Unrecognized key\(s\) in object/);
    });
  }
});

test("loadAgentYaml: rejects a provider name that is neither built in nor declared", () => {
  withYamlFile("providers:\n  claude:\n    command: npx\n    model: test-model\nsteps:\n  - id: one\n    provider: amp\n    do: Ship it\n", (path) => {
    assert.throws(() => loadAgentYaml(path), /unknown provider "amp"/);
  });
});

