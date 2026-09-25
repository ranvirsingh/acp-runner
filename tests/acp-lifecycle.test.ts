import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentActor, runAgent, RUNNER_VERSION } from "../src/index.ts";
import type { AgentYaml, ProviderId, RunnerConfig } from "../src/types.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = join(root, "tests/fixtures/acp-child.ts");
const originalPath = process.env.PATH ?? "";
if (process.versions.bun) process.env.ACP_FIXTURE_USE_BUN = "1";

function fixtureBinDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "acp-bin-"));
  const launcher = `#!/bin/sh
if [ -n "$ACP_FIXTURE_ARGV_FILE" ]; then
  printf '%s\\n' "$0" "$@" > "$ACP_FIXTURE_ARGV_FILE"
fi
if [ -n "$ACP_FIXTURE_USE_BUN" ]; then
  exec bun ${JSON.stringify(fixture)}
fi
exec node --import tsx ${JSON.stringify(fixture)}
`;
  for (const name of ["npx", "gemini"]) {
    const path = join(dir, name);
    writeFileSync(path, launcher);
    chmodSync(path, 0o755);
  }
  return dir;
}

async function withPath<T>(dir: string, fn: () => Promise<T>, exclusive = false): Promise<T> {
  process.env.PATH = exclusive ? dir : `${dir}:${originalPath}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = originalPath;
  }
}

async function runFixture(
  bins: string,
  options: Parameters<typeof config>[0],
  extra: Partial<RunnerConfig> = {},
): Promise<{ outcome: "finished" | "failed"; turnText: string; lastError?: string }> {
  let turnText = "";
  const result = await withPath(bins, () =>
    runAgent({
      config: { ...config(options), ...extra },
      onStateChange: (_previous, _current, context) => {
        if (context.turnText) turnText = context.turnText;
      },
    }),
  );
  return { outcome: result.outcome, turnText, lastError: result.context.lastError };
}

function config(options: {
  provider: ProviderId;
  model?: string;
  cwd: string;
  mode?: string;
  fragment?: number;
  pidFile?: string;
  argvFile?: string;
  providers?: AgentYaml["providers"];
}): RunnerConfig {
  if (options.mode) process.env.ACP_FIXTURE_MODE = options.mode;
  else delete process.env.ACP_FIXTURE_MODE;
  if (options.fragment) process.env.ACP_FIXTURE_FRAGMENT = String(options.fragment);
  else delete process.env.ACP_FIXTURE_FRAGMENT;
  if (options.pidFile) process.env.ACP_FIXTURE_PID_FILE = options.pidFile;
  else delete process.env.ACP_FIXTURE_PID_FILE;
  if (options.argvFile) process.env.ACP_FIXTURE_ARGV_FILE = options.argvFile;
  else delete process.env.ACP_FIXTURE_ARGV_FILE;

  return {
    yamlPath: join(options.cwd, "agent.yaml"),
    cwd: options.cwd,
    trace: "stdout" as const,
    providerOverride: options.provider,
    runbook: {
      name: "fixture",
      provider: options.provider,
      ...(options.model ? { model: options.model } : {}),
      providers: {
        ...options.providers,
        onSpawnError: "fail",
      },
      steps: [{ id: "implement", do: "say hello" }],
    },
  };
}

function alive(pid: number): boolean {
  const result = spawnSync("kill", ["-0", String(pid)], { encoding: "utf8" });
  return result.status === 0;
}

describe("acp fixture", { concurrency: false }, () => {
test("acp fixture: a one-turn session finishes and kills the child", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "acp-life-"));
  const bins = fixtureBinDir();
  const pidFile = join(workspace, "child.pid");
  try {
    const result = await runFixture(bins, { provider: "claude", cwd: workspace, pidFile });
    assert.equal(result.outcome, "finished");
    assert.match(result.turnText, /echo:say hello/);
    const pid = Number(readFileSync(pidFile, "utf8"));
    assert.equal(alive(pid), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(bins, { recursive: true, force: true });
    delete process.env.ACP_FIXTURE_MODE;
    delete process.env.ACP_FIXTURE_PID_FILE;
  }
});

test("acp fixture: NDJSON fragmented at every byte still yields the turn text", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "acp-frag-"));
  const bins = fixtureBinDir();
  try {
    const result = await runFixture(bins, {
      provider: "claude",
      cwd: workspace,
      fragment: 1,
      mode: "unicode",
    });
    assert.equal(result.outcome, "finished");
    assert.equal(result.turnText, "café 🎉 日本語");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(bins, { recursive: true, force: true });
    delete process.env.ACP_FIXTURE_MODE;
    delete process.env.ACP_FIXTURE_FRAGMENT;
  }
});

test("acp fixture: split stderr lines and a trailing line without a newline are logged", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "acp-err-"));
  const bins = fixtureBinDir();
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.join(" "));
  };
  try {
    const result = await withPath(bins, () =>
      runAgent({
        config: {
          ...config({ provider: "claude", cwd: workspace, mode: "split-stderr" }),
          trace: "off" as const,
        },
      }),
    );
    assert.equal(result.outcome, "finished");
    assert.ok(lines.some((line) => line.includes("[claude] stderr HELLO")));
    assert.ok(lines.some((line) => line.includes("[claude] stderr WORLD")));
  } finally {
    console.log = original;
    rmSync(workspace, { recursive: true, force: true });
    rmSync(bins, { recursive: true, force: true });
    delete process.env.ACP_FIXTURE_MODE;
  }
});

test("acp fixture: thought content is never logged", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "acp-thought-"));
  const bins = fixtureBinDir();
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.join(" "));
  };
  try {
    await withPath(bins, () =>
      runAgent({
        config: {
          ...config({ provider: "claude", cwd: workspace }),
          trace: "off" as const,
        },
      }),
    );
    assert.equal(
      lines.some((line) => line.includes("secret-thought")),
      false,
    );
    assert.ok(lines.some((line) => line === "  [claude] thought"));
  } finally {
    console.log = original;
    rmSync(workspace, { recursive: true, force: true });
    rmSync(bins, { recursive: true, force: true });
  }
});

test("acp fixture: missing provider binary is a spawn failure", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "acp-miss-"));
  const empty = mkdtempSync(join(tmpdir(), "acp-empty-"));
  try {
    const result = await withPath(empty, () =>
      runAgent({ config: config({ provider: "claude", cwd: workspace }) }),
      true,
    );
    assert.equal(result.outcome, "failed");
    assert.match(result.context.lastError ?? "", /spawn|ENOENT|not found|npx|ACP connection closed/i);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(empty, { recursive: true, force: true });
  }
});

test("acp fixture: provider exit before a turn fails the run", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "acp-pre-"));
  const bins = fixtureBinDir();
  try {
    const result = await runFixture(bins, {
      provider: "claude",
      cwd: workspace,
      mode: "exit-before-turn",
    });
    assert.equal(result.outcome, "failed");
    assert.match(result.lastError ?? "", /exited|closed/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(bins, { recursive: true, force: true });
    delete process.env.ACP_FIXTURE_MODE;
  }
});

test("acp fixture: provider exit during a turn fails the run", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "acp-mid-"));
  const bins = fixtureBinDir();
  try {
    const result = await runFixture(bins, {
      provider: "claude",
      cwd: workspace,
      mode: "exit-during-prompt",
    });
    assert.equal(result.outcome, "failed");
    assert.match(result.lastError ?? "", /exited|closed/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(bins, { recursive: true, force: true });
    delete process.env.ACP_FIXTURE_MODE;
  }
});

test("acp fixture: permission requests are auto-approved and the turn completes", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "acp-perm-"));
  const bins = fixtureBinDir();
  try {
    const result = await runFixture(bins, {
      provider: "claude",
      cwd: workspace,
      mode: "permission",
    });
    assert.equal(result.outcome, "finished");
    assert.match(result.turnText, /echo:say hello/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(bins, { recursive: true, force: true });
    delete process.env.ACP_FIXTURE_MODE;
  }
});

test("acp fixture: authenticate runs when the agent offers a method", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "acp-auth-"));
  const bins = fixtureBinDir();
  try {
    const result = await runFixture(bins, { provider: "claude", cwd: workspace, mode: "auth" });
    assert.equal(result.outcome, "finished");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(bins, { recursive: true, force: true });
    delete process.env.ACP_FIXTURE_MODE;
  }
});

test("acp fixture: gemini is spawned bare, with no model on the command line", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "acp-gem-"));
  const bins = fixtureBinDir();
  const argvFile = join(workspace, "argv.txt");
  try {
    const result = await runFixture(bins, {
      provider: "gemini",
      model: "gemini-3.7-flash",
      mode: "model-select",
      cwd: workspace,
      argvFile,
    });
    assert.equal(result.outcome, "finished");
    const argv = readFileSync(argvFile, "utf8").trim().split("\n");
    assert.deepEqual(argv.slice(-1), ["--acp"]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(bins, { recursive: true, force: true });
    delete process.env.ACP_FIXTURE_ARGV_FILE;
  }
});

test("acp fixture: a declared provider pins its model in the command line", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "acp-decl-"));
  const bins = fixtureBinDir();
  const argvFile = join(workspace, "argv.txt");
  try {
    const result = await runFixture(bins, {
      provider: "gemini-pro",
      cwd: workspace,
      argvFile,
      providers: { agentHarness: { "gemini-pro": { command: "gemini", args: ["--model", "gemini-3.7-pro", "--acp"] } } },
    });
    assert.equal(result.outcome, "finished");
    const argv = readFileSync(argvFile, "utf8").trim().split("\n");
    assert.deepEqual(argv.slice(-3), ["--model", "gemini-3.7-pro", "--acp"]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(bins, { recursive: true, force: true });
    delete process.env.ACP_FIXTURE_ARGV_FILE;
  }
});

test("acp fixture: large turn text completes without retaining the child", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "acp-big-"));
  const bins = fixtureBinDir();
  const pidFile = join(workspace, "child.pid");
  const before = process.memoryUsage().rss;
  try {
    const result = await runFixture(bins, {
      provider: "claude",
      cwd: workspace,
      mode: "large",
      pidFile,
    });
    assert.equal(result.outcome, "finished");
    assert.equal(result.turnText.length, 256 * 1024);
    const pid = Number(readFileSync(pidFile, "utf8"));
    assert.equal(alive(pid), false);
    const after = process.memoryUsage().rss;
    assert.ok(after - before < 200 * 1024 * 1024);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(bins, { recursive: true, force: true });
    delete process.env.ACP_FIXTURE_MODE;
    delete process.env.ACP_FIXTURE_PID_FILE;
  }
});

test("acp fixture: stopping the actor during initialize does not leave an orphan", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "acp-stop-"));
  const bins = fixtureBinDir();
  const pidFile = join(workspace, "child.pid");
  mkdirSync(workspace, { recursive: true });
  try {
    await withPath(bins, async () => {
      const actor = createAgentActor({
        config: config({ provider: "claude", cwd: workspace, mode: "delay-init", pidFile }),
      });
      actor.start();
      actor.send({ type: "START" });
      const deadline = Date.now() + 4000;
      while (!existsSync(pidFile) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const pid = Number(readFileSync(pidFile, "utf8"));
      actor.stop();
      const stopDeadline = Date.now() + 8000;
      while (alive(pid) && Date.now() < stopDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(alive(pid), false);
    });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(bins, { recursive: true, force: true });
    delete process.env.ACP_FIXTURE_MODE;
    delete process.env.ACP_FIXTURE_PID_FILE;
  }
});
});

test("acp fixture: the runner identifies itself as acp-runner at its real version", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "acp-info-"));
  const bins = fixtureBinDir();
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.join(" "));
  };
  try {
    const result = await withPath(bins, () =>
      runAgent({
        config: {
          ...config({ provider: "claude", cwd: workspace, mode: "echo-client-info" }),
          trace: "off" as const,
        },
      }),
    );
    assert.equal(result.outcome, "finished");
    assert.ok(
      lines.some((line) =>
        line.includes(`clientInfo {"name":"acp-runner","version":"${RUNNER_VERSION}"}`),
      ),
      lines.join("\n"),
    );
  } finally {
    console.log = original;
    rmSync(workspace, { recursive: true, force: true });
    rmSync(bins, { recursive: true, force: true });
    delete process.env.ACP_FIXTURE_MODE;
  }
});
