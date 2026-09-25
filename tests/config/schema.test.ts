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

test("loadAgentYaml: accepts name and description top-level metadata", () => {
  withYamlFile(
    'name: code-repair\ndescription: "Iteratively fixes failing tests"\nsteps:\n  - id: one\n    do: Ship it\n',
    (path) => {
      const parsed = loadAgentYaml(path);
      assert.equal(parsed.name, "code-repair");
      assert.equal(parsed.description, "Iteratively fixes failing tests");
    },
  );
});

test("loadAgentYaml: rejects an unknown key in a step", () => {
  withYamlFile("steps:\n  - id: one\n    dooo: hi\n", (path) => {
    assert.throws(() => loadAgentYaml(path), /steps\[0\][\s\S]*dooo/);
  });
});

test("loadAgentYaml: accepts an mcpServers map", () => {
  withYamlFile(
    'providers:\n  mcpServers:\n    echo:\n      command: node\n      args: ["tools/echo.mjs"]\n      env:\n        TOKEN: abc\nsteps:\n  - id: one\n    do: Ship it\n',
    (path) => {
      const parsed = loadAgentYaml(path);
      assert.deepEqual(parsed.providers?.mcpServers?.echo, {
        command: "node",
        args: ["tools/echo.mjs"],
        env: { TOKEN: "abc" },
      });
    },
  );
});

test("loadAgentYaml: an mcp server needs a command", () => {
  withYamlFile('providers:\n  mcpServers:\n    echo:\n      args: ["x"]\nsteps:\n  - id: one\n    do: Ship it\n', (path) => {
    assert.throws(() => loadAgentYaml(path), /mcpServers\.echo[\s\S]*command: Required/);
  });
});

test("loadAgentYaml: type stdio is accepted so a pasted json block still parses", () => {
  withYamlFile(
    'providers:\n  mcpServers: { "echo": { "command": "node", "args": ["tools/echo.mjs"], "type": "stdio" } }\nsteps:\n  - id: one\n    do: Ship it\n',
    (path) => {
      assert.deepEqual(loadAgentYaml(path).providers?.mcpServers?.echo, {
        type: "stdio",
        command: "node",
        args: ["tools/echo.mjs"],
      });
    },
  );
});

test("loadAgentYaml: a stdio command with a remote type is rejected", () => {
  withYamlFile("providers:\n  mcpServers:\n    remote:\n      command: node\n      type: http\nsteps:\n  - id: one\n    do: Ship it\n", (path) => {
    assert.throws(() => loadAgentYaml(path), /mcpServers\.remote[\s\S]*url: Required/);
  });
});

test("loadAgentYaml: an unknown key inside an mcp server is rejected", () => {
  withYamlFile("providers:\n  mcpServers:\n    remote:\n      command: node\n      url: http://x\nsteps:\n  - id: one\n    do: Ship it\n", (path) => {
    assert.throws(() => loadAgentYaml(path), /mcpServers\.remote[\s\S]*url/);
  });
});

test("loadAgentYaml: a step naming a server that was never declared is rejected", () => {
  withYamlFile(
    "providers:\n  mcpServers:\n    slack:\n      command: python\nsteps:\n  - id: one\n    do: Ship it\n  - id: two\n    servers: [slak]\n",
    (path) => {
      assert.throws(() => loadAgentYaml(path), /steps\[1\]\.servers: unknown server "slak"/);
    },
  );
});

test("loadAgentYaml: a step may name a declared server", () => {
  withYamlFile(
    "providers:\n  mcpServers:\n    slack:\n      command: python\nsteps:\n  - id: one\n    do: Ship it\n    servers: [slack]\n",
    (path) => {
      assert.deepEqual(loadAgentYaml(path).steps[0].servers, ["slack"]);
    },
  );
});

test("loadAgentYaml: accepts a step with run and on transitions", () => {
  withYamlFile(
    'steps:\n  - id: one\n    do: Ship it\n  - id: two\n    run: "npm test"\n    on:\n      success: one\n      failure:\n        target: one\n        maxAttempts: 3\n        fallback: one\n',
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
    'steps:\n  - id: verify\n    run: "npm test"\n    on:\n      success: END\n      failure:\n        target: fix\n        maxAttempts: 2\n        fallback: FAIL\n  - id: fix\n    do: Fix it\n    on:\n      success: verify\n      failure: fail\n  - id: cleanup\n    do: Clean up\n    on:\n      success: end\n',
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
  withYamlFile("steps:\n  - id: end\n    do: Ship it\n", (path) => {
    assert.throws(() => loadAgentYaml(path), /steps\[0\]\.id: step id "end" is reserved/);
  });
  withYamlFile("steps:\n  - id: END\n    do: Ship it\n", (path) => {
    assert.throws(() => loadAgentYaml(path), /steps\[0\]\.id: step id "END" is reserved/);
  });
  withYamlFile("steps:\n  - id: fail\n    do: Ship it\n", (path) => {
    assert.throws(() => loadAgentYaml(path), /steps\[0\]\.id: step id "fail" is reserved/);
  });
  withYamlFile("steps:\n  - id: FAIL\n    do: Ship it\n", (path) => {
    assert.throws(() => loadAgentYaml(path), /steps\[0\]\.id: step id "FAIL" is reserved/);
  });
});

test("loadAgentYaml: rejects snake_case keys", () => {
  withYamlFile("steps:\n  - id: route\n    do: Route it\n    retry:\n      max_attempts: 2\n", (path) => {
    assert.throws(() => loadAgentYaml(path), /max_attempts/);
  });
  withYamlFile(
    "steps:\n  - id: route\n    do: Route it\n    on:\n      failure:\n        target: route\n        max_attempts: 2\n",
    (path) => {
      assert.throws(() => loadAgentYaml(path), /max_attempts/);
    },
  );
});

test("loadAgentYaml: accepts step retry configuration", () => {
  withYamlFile(
    `
steps:
  - id: route
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
    'providers:\n  mcpServers:\n    jira:\n      type: sse\n      url: https://mcp.example.com/jira/sse\n      headers:\n        Authorization: "Bearer x"\nsteps:\n  - id: one\n    do: Ship it\n',
    (path) => {
      assert.deepEqual(loadAgentYaml(path).providers?.mcpServers?.jira, {
        type: "sse",
        url: "https://mcp.example.com/jira/sse",
        headers: { Authorization: "Bearer x" },
      });
    },
  );
});

test("loadAgentYaml: accepts an http server", () => {
  withYamlFile(
    "providers:\n  mcpServers:\n    db:\n      type: http\n      url: https://mcp.example.com/postgres\nsteps:\n  - id: one\n    do: Ship it\n",
    (path) => {
      assert.deepEqual(loadAgentYaml(path).providers?.mcpServers?.db, {
        type: "http",
        url: "https://mcp.example.com/postgres",
      });
    },
  );
});

test("loadAgentYaml: rejects a server mixing stdio and remote keys", () => {
  withYamlFile(
    "providers:\n  mcpServers:\n    bad:\n      type: http\n      url: https://x.test/mcp\n      command: node\nsteps:\n  - id: one\n    do: Ship it\n",
    (path) => {
      assert.throws(() => loadAgentYaml(path), /mcpServers\.bad/);
    },
  );
});

test("loadAgentYaml: rejects a url on a stdio server", () => {
  withYamlFile(
    "providers:\n  mcpServers:\n    bad:\n      command: node\n      url: https://x.test/mcp\nsteps:\n  - id: one\n    do: Ship it\n",
    (path) => {
      assert.throws(() => loadAgentYaml(path), /mcpServers\.bad/);
    },
  );
});

test("loadAgentYaml: rejects a remote server with a bad url", () => {
  withYamlFile("providers:\n  mcpServers:\n    bad:\n      type: http\n      url: nope\nsteps:\n  - id: one\n    do: Ship it\n", (path) => {
    assert.throws(() => loadAgentYaml(path), /mcpServers\.bad/);
  });
});

test("loadAgentYaml: accepts a servers map with allow and deny", () => {
  withYamlFile(
    'providers:\n  mcpServers:\n    db:\n      command: node\nsteps:\n  - id: one\n    do: Ship it\n    servers:\n      db: { allow: ["select"], deny: ["drop_*"] }\n',
    (path) => {
      assert.deepEqual(loadAgentYaml(path).steps[0].servers, {
        db: { allow: ["select"], deny: ["drop_*"] },
      });
    },
  );
});

test("loadAgentYaml: rejects a servers map naming an undeclared server", () => {
  withYamlFile(
    "providers:\n  mcpServers:\n    db:\n      command: node\nsteps:\n  - id: one\n    servers:\n      ghost: {}\n",
    (path) => {
      assert.throws(() => loadAgentYaml(path), /unknown server "ghost"/);
    },
  );
});

test("loadAgentYaml: rejects an empty allow pattern", () => {
  withYamlFile(
    'providers:\n  mcpServers:\n    db:\n      command: node\nsteps:\n  - id: one\n    servers:\n      db: { allow: [""] }\n',
    (path) => {
      assert.throws(() => loadAgentYaml(path), /steps\[0\]\.servers/);
    },
  );
});

test("loadAgentYaml: accepts a resource variable source", () => {
  withYamlFile(
    'providers:\n  mcpServers:\n    db:\n      command: node\nsteps:\n  - id: one\n    do: hi\n    vars:\n      ddl: { resource: "postgres://x", server: db }\n',
    (path) => {
      assert.deepEqual(loadAgentYaml(path).steps[0].vars?.ddl, {
        resource: "postgres://x",
        server: "db",
      });
    },
  );
});

test("loadAgentYaml: rejects a resource variable naming an undeclared server", () => {
  withYamlFile(
    'steps:\n  - id: one\n    do: hi\n    vars:\n      ddl: { resource: "postgres://x", server: db }\n',
    (path) => {
      assert.throws(() => loadAgentYaml(path), /unknown server "db"/);
    },
  );
});

test("loadAgentYaml: accepts a promptRef step body", () => {
  withYamlFile(
    'providers:\n  mcpServers:\n    jira:\n      command: node\nsteps:\n  - id: one\n    promptRef:\n      server: jira\n      name: incident_review\n      arguments:\n        service: "{{svc}}"\n',
    (path) => {
      assert.deepEqual(loadAgentYaml(path).steps[0].promptRef, {
        server: "jira",
        name: "incident_review",
        arguments: { service: "{{svc}}" },
      });
    },
  );
});

test("loadAgentYaml: rejects promptRef alongside do", () => {
  withYamlFile(
    "providers:\n  mcpServers:\n    jira:\n      command: node\nsteps:\n  - id: one\n    do: hi\n    promptRef:\n      server: jira\n      name: r\n",
    (path) => {
      assert.throws(() => loadAgentYaml(path), /promptRef/);
    },
  );
});

test("loadAgentYaml: rejects a promptRef naming an undeclared server", () => {
  withYamlFile("steps:\n  - id: one\n    promptRef:\n      server: jira\n      name: r\n", (path) => {
    assert.throws(() => loadAgentYaml(path), /unknown server "jira"/);
  });
});

test("loadAgentYaml: rejects a step with no do, file, promptRef or run", () => {
  withYamlFile("steps:\n  - id: implement\n", (path) => {
    assert.throws(() => loadAgentYaml(path), /step must have do, file, promptRef or run/);
  });
});

test("loadAgentYaml: a step body is do, not prompt", () => {
  withYamlFile("steps:\n  - id: implement\n    prompt: Ship it\n", (path) => {
    assert.throws(() => loadAgentYaml(path), /Unrecognized key\(s\) in object: 'prompt'/);
  });
});

test("loadAgentYaml: promptRef is exclusive with do, file and run", () => {
  withYamlFile(
    "providers:\n  mcpServers:\n    jira:\n      command: node\nsteps:\n  - id: one\n    run: bun test\n    promptRef:\n      server: jira\n      name: r\n",
    (path) => {
      assert.throws(() => loadAgentYaml(path), /promptRef is exclusive with do, file and run/);
    },
  );
});

test("loadAgentYaml: accepts a step whose only body is run", () => {
  withYamlFile("steps:\n  - id: verify\n    run: bun test\n", (path) => {
    assert.equal(loadAgentYaml(path).steps[0].id, "verify");
  });
});

test("loadAgentYaml: accepts an agentHarness map of command and args", () => {
  withYamlFile(
    'providers:\n  agentHarness:\n    amp:\n      command: amp\n      args: ["--acp"]\nsteps:\n  - id: one\n    do: Ship it\n',
    (path) => {
      const parsed = loadAgentYaml(path);
      assert.deepEqual(parsed.providers?.agentHarness, {
        amp: { command: "amp", args: ["--acp"] },
      });
    },
  );
});

test("loadAgentYaml: an agentHarness entry requires a command", () => {
  withYamlFile(
    'providers:\n  agentHarness:\n    amp:\n      args: ["--acp"]\nsteps:\n  - id: one\n    do: Ship it\n',
    (path) => {
      assert.throws(() => loadAgentYaml(path), /providers\.agentHarness\.amp\.command/);
    },
  );
});

test("loadAgentYaml: an agentHarness entry rejects unknown keys", () => {
  withYamlFile(
    "providers:\n  agentHarness:\n    amp:\n      command: amp\n      modelArgs: nope\nsteps:\n  - id: one\n    do: Ship it\n",
    (path) => {
      assert.throws(() => loadAgentYaml(path), /modelArgs/);
    },
  );
});

test("loadAgentYaml: providers rejects a key that is not agentHarness or mcpServers", () => {
  withYamlFile(
    "providers:\n  amp:\n    command: amp\nsteps:\n  - id: one\n    do: Ship it\n",
    (path) => {
      assert.throws(() => loadAgentYaml(path), /amp/);
    },
  );
});


test("loadAgentYaml: servers are declared under providers.mcpServers", () => {
  withYamlFile(
    'providers:\n  mcpServers:\n    greet:\n      command: node\n      args: ["tools/greet.mjs"]\nsteps:\n  - id: one\n    servers: [greet]\n    do: Ship it\n',
    (path) => {
      const parsed = loadAgentYaml(path);
      assert.deepEqual(parsed.providers?.mcpServers?.greet, {
        command: "node",
        args: ["tools/greet.mjs"],
      });
    },
  );
});

test("loadAgentYaml: a step scoping an undeclared server is still an error", () => {
  withYamlFile(
    "providers:\n  mcpServers:\n    greet:\n      command: node\nsteps:\n  - id: one\n    servers: [nope]\n    do: Ship it\n",
    (path) => {
      assert.throws(() => loadAgentYaml(path), /unknown server "nope"/);
    },
  );
});

test("loadAgentYaml: a declared provider can be named at the top level, by a step and in fallback", () => {
  withYamlFile(
    "provider: amp\nmodel: amp-1\nproviders:\n  agentHarness:\n    amp:\n      command: amp\n  fallback: [amp, claude]\n  onSpawnError: fail\nsteps:\n  - id: one\n    provider: amp\n    do: Ship it\n",
    (path) => {
      const parsed = loadAgentYaml(path);
      assert.equal(parsed.provider, "amp");
      assert.equal(parsed.model, "amp-1");
      assert.deepEqual(parsed.providers?.fallback, ["amp", "claude"]);
      assert.equal(parsed.providers?.onSpawnError, "fail");
      assert.equal(parsed.steps[0].provider, "amp");
    },
  );
});

test("loadAgentYaml: default is an ordinary harness name", () => {
  withYamlFile(
    "provider: default\nproviders:\n  agentHarness:\n    default:\n      command: amp\nsteps:\n  - id: one\n    do: Ship it\n",
    (path) => {
      assert.deepEqual(loadAgentYaml(path).providers?.agentHarness?.default, { command: "amp" });
    },
  );
  withYamlFile(
    "providers:\n  agentHarness:\n    default:\n      provider: claude\nsteps:\n  - id: one\n    do: Ship it\n",
    (path) => {
      assert.throws(() => loadAgentYaml(path), /providers\.agentHarness\.default\.command: Required/);
    },
  );
});

test("loadAgentYaml: a harness entry must not carry default keys", () => {
  withYamlFile(
    "providers:\n  agentHarness:\n    amp:\n      provider: claude\nsteps:\n  - id: one\n    do: Ship it\n",
    (path) => {
      assert.throws(() => loadAgentYaml(path), /amp/);
    },
  );
});

test("loadAgentYaml: defaults, mcpServers, fallback and onSpawnError are not root keys", () => {
  for (const block of [
    "defaults:\n  provider: claude\n",
    "mcpServers:\n  greet:\n    command: node\n",
    "fallback: [claude]\n",
    "onSpawnError: fail\n",
  ]) {
    withYamlFile(`${block}steps:\n  - id: one\n    do: Ship it\n`, (path) => {
      assert.throws(() => loadAgentYaml(path), /Unrecognized key\(s\) in object/);
    });
  }
});

test("loadAgentYaml: rejects a provider name that is neither built in nor declared", () => {
  withYamlFile("steps:\n  - id: one\n    provider: amp\n    do: Ship it\n", (path) => {
    assert.throws(() => loadAgentYaml(path), /unknown provider "amp"/);
  });
});

test("loadAgentYaml: rejects an unknown provider at the top level and in fallback", () => {
  withYamlFile("provider: amp\nsteps:\n  - id: one\n    do: Ship it\n", (path) => {
    assert.throws(() => loadAgentYaml(path), /provider: unknown provider "amp"/);
  });
  withYamlFile("providers:\n  fallback: [amp]\nsteps:\n  - id: one\n    do: Ship it\n", (path) => {
    assert.throws(() => loadAgentYaml(path), /providers\.fallback\[0\][\s\S]*unknown provider "amp"/);
  });
});

test("loadAgentYaml: a declared provider may override a built-in name", () => {
  withYamlFile(
    'providers:\n  agentHarness:\n    claude:\n      command: npx\n      args: ["-y", "claude-agent-acp@1.2.3"]\nsteps:\n  - id: one\n    do: Ship it\n',
    (path) => {
      const parsed = loadAgentYaml(path);
      assert.deepEqual(
        (parsed.providers?.agentHarness?.claude as { args: string[] }).args,
        ["-y", "claude-agent-acp@1.2.3"],
      );
    },
  );
});
