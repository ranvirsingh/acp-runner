import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig, parseArgs, runCli } from "../src/cli.ts";

const USAGE = /usage: acp-runner \[agent\.yaml\|folder\]/;

function withRunbook(fn: (path: string, dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "acp-cli-"));
  const path = join(dir, "runbook.yaml");
  writeFileSync(
    path,
    "name: demo\nprovider: codex\nsteps:\n  - id: implement\n    do: Ship it\n",
  );
  try {
    fn(path, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("parseArgs: no arguments uses ./agent.yaml, the current directory and trace stdout", () => {
  assert.deepEqual(parseArgs([]), {
    yamlPath: "./agent.yaml",
    cwd: resolve(process.cwd()),
    provider: undefined,
    trace: "stdout",
  });
});

test("parseArgs: --trace accepts each destination", () => {
  assert.equal(parseArgs(["--trace", "off"]).trace, "off");
  assert.equal(parseArgs(["--trace", "file"]).trace, "file");
  assert.equal(parseArgs(["--trace", "stdout"]).trace, "stdout");
  assert.equal(parseArgs(["--trace", "both"]).trace, "both");
});

test("parseArgs: --trace rejects an unknown destination by name", () => {
  assert.throws(
    () => parseArgs(["--trace", "syslog"]),
    /--trace must be off, file, stdout, or both \(got syslog\)/,
  );
});

test("parseArgs: --trace requires a value", () => {
  assert.throws(() => parseArgs(["--trace"]), /--trace requires a value/);
});

test("parseArgs: the flags --trace replaced are gone", () => {
  assert.throws(() => parseArgs(["--json"]), /unknown flag --json/);
  assert.throws(() => parseArgs(["--no-record"]), /unknown flag --no-record/);
});

test("parseArgs: a leading .yaml positional is the runbook", () => {
  assert.equal(parseArgs(["demo.yaml"]).yamlPath, "demo.yaml");
});

test("parseArgs: a leading .yml positional is also the runbook", () => {
  assert.equal(parseArgs(["run.yml"]).yamlPath, "run.yml");
});

test("parseArgs: an existing file as first positional is the runbook", () => {
  withRunbook((path) => {
    assert.equal(parseArgs([path]).yamlPath, path);
  });
});

test("parseArgs: rejects free text, because prompts live in the runbook", () => {
  assert.throws(() => parseArgs(["Create README.md"]), /unexpected argument "Create README.md"/);
  assert.throws(() => parseArgs(["demo.yaml", "do", "it"]), /unexpected argument "do"/);
});

test("parseArgs: --cwd is resolved to an absolute path", () => {
  assert.equal(parseArgs(["--cwd", "."]).cwd, resolve("."));
  assert.equal(parseArgs(["--cwd", "/tmp/hello-world"]).cwd, "/tmp/hello-world");
});

test("parseArgs: accepts every supported --provider value", () => {
  assert.equal(parseArgs(["--provider", "claude"]).provider, "claude");
  assert.equal(parseArgs(["--provider", "codex"]).provider, "codex");
  assert.equal(parseArgs(["--provider", "gemini"]).provider, "gemini");
});

test("parseArgs: flags may follow the runbook", () => {
  const args = parseArgs(["demo.yaml", "--provider", "codex", "--cwd", "/tmp/x"]);
  assert.equal(args.yamlPath, "demo.yaml");
  assert.equal(args.provider, "codex");
  assert.equal(args.cwd, "/tmp/x");
});

test("parseArgs: rejects a flag with no value", () => {
  assert.throws(() => parseArgs(["--cwd"]), /--cwd requires a value/);
  assert.throws(() => parseArgs(["--provider"]), /--provider requires a value/);
});

test("parseArgs: rejects unknown flags", () => {
  assert.throws(() => parseArgs(["--verbose"]), /unknown flag --verbose/);
});

test("parseArgs: --help reports usage", () => {
  assert.throws(() => parseArgs(["--help"]), USAGE);
});

test("loadConfig: reads the runbook named by the parsed arguments", () => {
  withRunbook((path, dir) => {
    const config = loadConfig(parseArgs([path, "--cwd", dir]));

    assert.equal(config.yamlPath, path);
    assert.equal(config.cwd, dir);
    assert.equal(config.providerOverride, undefined);
    assert.equal(config.runbook.name, "demo");
    assert.equal(config.runbook.steps[0].id, "implement");
  });
});

test("loadConfig: carries the --provider override onto the config", () => {
  withRunbook((path) => {
    const config = loadConfig(parseArgs([path, "--provider", "codex"]));
    assert.equal(config.providerOverride, "codex");
  });
});

test("loadConfig: surfaces a missing runbook as an error", () => {
  assert.throws(() => loadConfig(parseArgs(["missing-runbook.yaml"])), /ENOENT/);
});

test("loadConfig: a folder positional resolves to its agent.yaml", () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-cli-folder-"));
  try {
    writeFileSync(
      join(dir, "agent.yaml"),
      "name: folder-agent\nsteps:\n  - id: implement\n    do: Ship it\n",
    );
    const config = loadConfig(parseArgs([dir]));
    assert.equal(config.yamlPath, join(dir, "agent.yaml"));
    assert.equal(config.runbook.name, "folder-agent");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig: creates cwd directory if it does not exist", () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-cli-test-"));
  const nonExistentCwd = join(dir, "new-workspace");
  const yamlPath = join(dir, "agent.yaml");
  writeFileSync(yamlPath, "steps:\n  - id: a\n    do: Ship it\n");
  try {
    assert.equal(existsSync(nonExistentCwd), false);
    loadConfig(parseArgs([yamlPath, "--cwd", nonExistentCwd]));
    assert.equal(existsSync(nonExistentCwd), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig: forwards the trace destination", () => {
  withRunbook((path) => {
    assert.equal(loadConfig(parseArgs(["--trace", "both", path])).trace, "both");
    assert.equal(loadConfig(parseArgs([path])).trace, "stdout");
  });
});

test("runCli: mcp and proxy are not subcommands", async () => {
  await assert.rejects(() => runCli(["mcp"]), /unexpected argument "mcp"/);
  await assert.rejects(() => runCli(["proxy"]), /unexpected argument "proxy"/);
});

test("parseArgs: accepts --confirm", () => {
  const args = parseArgs(["--confirm"]);
  assert.equal(args.confirm, true);
});

test("loadConfig: forwards confirm flag", () => {
  withRunbook((path) => {
    const config = loadConfig(parseArgs([path, "--confirm"]));
    assert.equal(config.confirm, true);
  });
});
