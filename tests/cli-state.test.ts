import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../src/cli.ts";
import { runCli, spawnCli } from "./helpers/run-cli.ts";

function workflow(steps: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "acp-state-"));
  const state = join(dir, "state");
  const yaml = join(dir, "agent.yaml");
  writeFileSync(yaml, ["name: state-demo", "steps:", ...steps, ""].join("\n"));
  const run = (extra: string[] = [], cwd = dir) => runCli(["run", yaml, "--cwd", cwd, "--state", state, "--trace", "off", ...extra], { timeout: 60000 });
  const journal = () => (existsSync(join(state, "agent.state.jsonl")) ? readFileSync(join(state, "agent.state.jsonl"), "utf8") : "");
  const events = () => journal().trim().split("\n").filter(Boolean).map((line) => JSON.parse(line).event as string);
  return { dir, state, yaml, run, journal, events };
}

test("parseArgs: --state takes a directory", () => {
  assert.match(parseArgs(["--state", "some/dir"]).state ?? "", /some\/dir$/);
  assert.throws(() => parseArgs(["--state"]), /--state requires a value/);
});

test("cli --state: a finished run exits 0, and a second run exits 0 without running anything", () => {
  const w = workflow(["  - id: only", "    run: echo hi"]);
  const first = w.run();
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(w.events(), ["run_started", "step_started", "step_completed", "run_finished"]);
  assert.equal(existsSync(join(w.state, "agent.state.lock")), false);
  const before = w.journal();
  const second = w.run();
  assert.equal(second.status, 0, second.stderr);
  assert.equal(w.journal(), before);
});

test("cli --state: a failed run exits 1 and repeats 1", () => {
  const w = workflow(["  - id: only", "    run: \"false\""]);
  assert.equal(w.run().status, 1);
  assert.equal(w.run().status, 1);
});

test("cli --state: A6 a changed agent.yaml exits 3 and leaves the state unchanged", () => {
  const w = workflow(["  - id: only", "    run: echo hi"]);
  w.run();
  const before = w.journal();
  const files = readdirSync(w.state).sort();
  writeFileSync(w.yaml, readFileSync(w.yaml, "utf8") + "description: changed\n");
  const result = w.run();
  assert.equal(result.status, 3, result.stderr);
  assert.equal(w.journal(), before);
  assert.deepEqual(readdirSync(w.state).sort(), files);
});

test("cli --state: changed resolved inputs exit 3", () => {
  const w = workflow(["  - id: only", "    run: echo ${{ env.STATE_TEST_VALUE }}"]);
  assert.equal(runCli(["run", w.yaml, "--cwd", w.dir, "--state", w.state, "--trace", "off"], { env: { STATE_TEST_VALUE: "a" } }).status, 0);
  assert.equal(runCli(["run", w.yaml, "--cwd", w.dir, "--state", w.state, "--trace", "off"], { env: { STATE_TEST_VALUE: "b" } }).status, 3);
});

test("cli --state: A9 a complete line that does not parse exits 1 and leaves the file unchanged", () => {
  const w = workflow(["  - id: only", "    run: echo hi"]);
  w.run();
  const corrupt = w.journal() + "{not json}\n";
  writeFileSync(join(w.state, "agent.state.jsonl"), corrupt);
  const result = w.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /line 5/);
  assert.equal(w.journal(), corrupt);
});

test("cli --state: another --cwd exits 1", () => {
  const w = workflow(["  - id: only", "    run: echo hi"]);
  w.run();
  const other = mkdtempSync(join(tmpdir(), "acp-other-"));
  assert.equal(w.run([], other).status, 1);
});

test("cli --state: a lock held by a live process group exits 75 and changes nothing", async () => {
  const w = workflow(["  - id: only", "    run: echo hi"]);
  const holder = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  await new Promise((resolve) => holder.once("spawn", resolve));
  try {
    mkdirSync(w.state, { recursive: true });
    writeFileSync(join(w.state, "agent.state.lock"), JSON.stringify({ host: hostname(), pgid: holder.pid }));
    const result = w.run();
    assert.equal(result.status, 75, result.stderr);
    assert.equal(w.journal(), "");
  } finally {
    process.kill(-holder.pid!, "SIGKILL");
  }
});

test("cli --state: a lock from another host exits 1", async () => {
  const w = workflow(["  - id: only", "    run: echo hi"]);
  mkdirSync(w.state, { recursive: true });
  writeFileSync(join(w.state, "agent.state.lock"), JSON.stringify({ host: "elsewhere", pgid: 1 }));
  assert.equal(w.run().status, 1);
});

test("cli --state: A16 SIGTERM during a long check stops the script group, exits 75 and leaves the visit open", async () => {
  const w = workflow([]);
  const pidFile = join(w.dir, "script.pid");
  writeFileSync(w.yaml, ["steps:", "  - id: long", `    run: sh -c 'echo $$ > "${pidFile}"; sleep 30'`, ""].join("\n"));
  const child = spawnCli(["run", w.yaml, "--cwd", w.dir, "--state", w.state, "--trace", "off"]);
  try {
    const started = Date.now();
    while (!existsSync(pidFile) || readFileSync(pidFile, "utf8").trim() === "") {
      if (Date.now() - started > 15000) throw new Error("script never started");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const scriptPid = Number(readFileSync(pidFile, "utf8").trim());
    child.kill("SIGTERM");
    const code = await new Promise<number | null>((resolve) => child.once("exit", (status) => resolve(status)));
    assert.equal(code, 75);
    assert.throws(() => process.kill(scriptPid, 0));
    assert.deepEqual(w.events(), ["run_started", "step_started"]);
    assert.equal(existsSync(join(w.state, "agent.state.lock")), false);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});
