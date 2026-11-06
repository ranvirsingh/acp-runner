import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent } from "../../src/runtime/engine.ts";
import { checkCommand } from "../../src/runtime/check.ts";
import type { AgentYaml, RunnerConfig } from "../../src/types.ts";

const fixture = fileURLToPath(new URL("../fixtures/acp-child.ts", import.meta.url));
const SECRET = "guard-secret-value-1";
const USES_SECRET = { id: "uses-secret", run: 'test -n "${{ secrets.ACP_GUARD_SECRET }}"' };

function project(runbook: AgentYaml) {
  const dir = mkdtempSync(join(tmpdir(), "acp-agent-secrets-"));
  const capture = join(dir, "prompts.jsonl");
  const config: RunnerConfig = {
    cwd: dir,
    yamlPath: join(dir, "agent.yaml"),
    runbook: {
      providers: {
        claude: {
          command: process.execPath,
          args: [...(process.versions.bun ? [] : ["--import", "tsx"]), fixture, `--capture=${capture}`],
          model: "test-model",
        },
      },
      ...runbook,
    },
  };
  process.env.ACP_GUARD_SECRET = SECRET;
  process.env.ACP_FIXTURE_ENV_FILE = join(dir, "agent-env.txt");
  return {
    dir,
    config,
    prompts: () => readFileSync(capture, "utf8"),
    close: () => {
      delete process.env.ACP_GUARD_SECRET;
      delete process.env.ACP_FIXTURE_ENV_FILE;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("the agent does not inherit a value referenced as a secret, while a script step does", async () => {
  const p = project({
    steps: [
      { id: "script", run: 'printf %s "$ACP_GUARD_SECRET" > script-saw.txt' },
      { id: "agent", provider: "claude", do: "Say hi." },
      USES_SECRET,
    ],
  });
  try {
    const result = await runAgent({ config: p.config });
    assert.equal(result.outcome, "finished", result.context.lastError);
    assert.equal(readFileSync(join(p.dir, "script-saw.txt"), "utf8"), SECRET);
    assert.equal(readFileSync(join(p.dir, "agent-env.txt"), "utf8"), "absent");
  } finally {
    p.close();
  }
});

test("run refuses a secret placeholder in a prompt before any step runs", async () => {
  const p = project({
    steps: [
      { id: "script", run: "touch ran.txt" },
      { id: "agent", provider: "claude", do: "Use ${{ secrets.ACP_GUARD_SECRET }}." },
    ],
  });
  try {
    await assert.rejects(
      runAgent({ config: p.config }),
      /step agent: \$\{\{ secrets\.ACP_GUARD_SECRET \}\} in a prompt would send the secret to the model/,
    );
    assert.equal(existsSync(join(p.dir, "ran.txt")), false);
  } finally {
    p.close();
  }
});

test("secret values are scrubbed from prompt text and from check output before the agent sees them", async () => {
  const p = project({
    vars: { notes: { file: "notes.md" } },
    steps: [
      {
        id: "repair",
        provider: "claude",
        do: "Read {{notes}}",
        run: { command: process.execPath, args: ["check.cjs"] },
        retry: { maxAttempts: 1 },
      },
      USES_SECRET,
    ],
  });
  writeFileSync(join(p.dir, "notes.md"), `the token is ${SECRET}`);
  writeFileSync(
    join(p.dir, "check.cjs"),
    "const fs = require('node:fs'); if (!fs.existsSync('tried')) { fs.writeFileSync('tried', 'yes'); console.error('leaked ' + process.env.ACP_GUARD_SECRET); process.exit(1); }",
  );
  try {
    const result = await runAgent({ config: p.config });
    assert.equal(result.outcome, "finished", result.context.lastError);
    const prompts = p.prompts();
    assert.doesNotMatch(prompts, new RegExp(SECRET));
    assert.match(prompts, /the token is \[REDACTED\]/);
    assert.match(prompts, /leaked \[REDACTED\]/);
  } finally {
    p.close();
  }
});

test("check starts the agent without the values referenced as secrets", async () => {
  const p = project({ steps: [{ id: "agent", provider: "claude", do: "Say hi." }, USES_SECRET] });
  try {
    writeFileSync(p.config.yamlPath, JSON.stringify(p.config.runbook));
    assert.equal(await checkCommand(p.config.yamlPath), 0);
    assert.equal(readFileSync(join(p.dir, "agent-env.txt"), "utf8"), "absent");
  } finally {
    p.close();
  }
});
