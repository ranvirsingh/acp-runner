import { spawn } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import {
  isTraceMode,
  tracesToStdout,
  type RunnerConfig,
  type TraceMode,
} from "./types.js";
import { pickAllowOption, pickRejectOption } from "./runtime/session.js";
import { loadAgentYaml, resolveRunbookPath } from "./config/yaml.js";
import { stateLog, stepLog } from "./output/logs.js";
import { RunRecorder } from "./output/record.js";
import { createTelemetry } from "./output/telemetry.js";
import { runAgent, type AgentRunResult } from "./index.js";
import { lintCommand } from "./config/lint.js";
import { planCommand } from "./config/plan.js";
import { checkCommand } from "./runtime/check.js";
import { installSkill } from "./skill.js";
import { RUNNER_VERSION } from "./version.js";
import { createRedactor } from "./output/redact.js";
import {
  acquireLock,
  createJournal,
  inputsHash,
  journalWriter,
  readJournal,
  releaseLock,
  runbookHash,
  type JournalEvent,
} from "./runtime/journal.js";
import type { RunState } from "./runtime/engine.js";

const USAGE =
  "usage: acp-runner run [agent.yaml|folder] [--cwd <dir>] [--state <dir>] [--trace off|file|stdout|both] [--confirm]\n" +
  "       acp-runner lint [agent.yaml|folder ...]\n" +
  "       acp-runner plan [agent.yaml|folder]\n" +
  "       acp-runner check [agent.yaml|folder]\n" +
  "       acp-runner skill install";

export interface ParsedArgs {
  yamlPath: string;
  cwd: string;
  trace: TraceMode;
  confirm?: boolean;
  state?: string;
}

const EXIT_CODES = { finished: 0, failed: 1, unknown: 2, changed: 3, stopped: 75 } as const;
const GROUP_ENV = "ACP_RUNNER_GROUP_LEADER";

function looksLikeYaml(value: string): boolean {
  return value.endsWith(".yaml") || value.endsWith(".yml") || existsSync(value);
}

async function askUserPermission(title: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`[permission] allow tool call (${title})? [y/N] `);
    return answer.trim().toLowerCase().startsWith("y");
  } finally {
    rl.close();
  }
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string>();
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--cwd" || token === "--trace" || token === "--state") {
      const value = argv[i + 1];
      if (!value) throw new Error(`${token} requires a value`);
      flags.set(token, value);
      i += 1;
      continue;
    }
    if (token === "--confirm") {
      flags.set(token, "true");
      continue;
    }
    if (token === "--help" || token === "-h") {
      throw new Error(USAGE);
    }
    if (token.startsWith("--")) {
      throw new Error(`unknown flag ${token}`);
    }
    positional.push(token);
  }

  let yamlPath = "./agent.yaml";
  let rest = positional;
  if (positional[0] && looksLikeYaml(positional[0])) {
    yamlPath = positional[0];
    rest = positional.slice(1);
  }
  if (rest.length > 0) {
    throw new Error(`unexpected argument "${rest[0]}"\n${USAGE}`);
  }

  const traceFlag = flags.get("--trace") ?? "stdout";
  if (!isTraceMode(traceFlag)) {
    throw new Error(`--trace must be off, file, stdout, or both (got ${traceFlag})`);
  }

  return {
    yamlPath,
    cwd: resolve(flags.get("--cwd") ?? process.cwd()),
    trace: traceFlag,
    ...(flags.has("--confirm") ? { confirm: true } : {}),
    ...(flags.has("--state") ? { state: resolve(flags.get("--state")!) } : {}),
  };
}

export function loadConfig(args: ParsedArgs): RunnerConfig {
  const yamlPath = resolveRunbookPath(args.yamlPath);
  mkdirSync(args.cwd, { recursive: true });
  return {
    yamlPath,
    cwd: args.cwd,
    runbook: loadAgentYaml(yamlPath),
    trace: args.trace,
    confirm: args.confirm,
  };
}


export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  if (argv.includes("--version")) {
    console.log(RUNNER_VERSION);
    return;
  }
  const [command, ...rest] = argv;
  if (command === "lint") {
    process.exitCode = lintCommand(rest);
    return;
  }
  if (command === "plan") {
    process.exitCode = planCommand(rest[0] ?? "agent.yaml");
    return;
  }
  if (command === "check") {
    process.exitCode = await checkCommand(rest[0] ?? "agent.yaml");
    return;
  }
  if (command === "skill") {
    if (rest[0] !== "install") throw new Error(USAGE);
    console.log(`installed create-acp-agent to ${installSkill()}`);
    return;
  }
  if (command === undefined || command === "--help" || command === "-h") throw new Error(USAGE);
  if (command !== "run") throw new Error(`unknown command "${command}"\n${USAGE}`);
  const args = parseArgs(rest);
  if (args.state && process.env[GROUP_ENV] !== "1") {
    process.exitCode = await runInProcessGroup();
    return;
  }
  const config = loadConfig(args);
  const redact = createRedactor(config);
  if (!tracesToStdout(config.trace)) {
    console.log(`[runner] ${config.runbook.name ?? "agent"} cwd=${config.cwd}`);
  }

  let state: RunState | undefined;
  if (args.state) {
    const refused = refuseState(args.state, config);
    if (refused) {
      console.error(redact(`[runner] ${refused.message}`));
      process.exitCode = refused.code;
      return;
    }
    state = { dir: args.state, journal: createJournal(journalWriter(args.state)), events: readJournal(args.state) };
  }

  const telemetry = createTelemetry({ env: process.env, providers: config.runbook.providers });
  const recorder = new RunRecorder(config, undefined, telemetry);
  recorder.start();

  let loggedStep = -1;
  let runOutcome: AgentRunResult["outcome"] = "failed";
  let lastError: string | undefined;

  const controller = new AbortController();
  const onSigint = () => {
    if (!tracesToStdout(config.trace)) {
      console.error("[runner] cancelling");
    }
    controller.abort();
  };
  process.once("SIGINT", onSigint);
  if (state) process.once("SIGTERM", onSigint);
  let runReason: string | undefined;

  try {
    const { outcome, context, reason } = await runAgent({
      config,
      state,
      signal: controller.signal,
      promptPermission: config.confirm
        ? async (pending) => {
            const title = pending.options.map((o) => o.name ?? o.optionId).join("/");
            const allowed = await askUserPermission(title);
            return allowed
              ? (pickAllowOption(pending.options) ?? "allow")
              : (pickRejectOption(pending.options) ?? "reject");
          }
        : undefined,
      inspect: (event) => recorder.handleInspect(event),
      onStateChange: (previous, current, context) => {
        if (!tracesToStdout(config.trace)) {
          if (context.stepIndex !== loggedStep) {
            loggedStep = context.stepIndex;
            const step = config.runbook.steps[context.stepIndex];
            stepLog(step?.id ?? "?", step?.provider);
          }
          stateLog(previous, current);
        }
        recorder.onStateChange(previous, current, context);
      },
    });
    runOutcome = outcome;
    lastError = context.lastError;
    runReason = reason;
  } catch (error: any) {
    runOutcome = "failed";
    lastError = error instanceof Error ? error.message : String(error);
  } finally {
    process.off("SIGINT", onSigint);
    if (state) {
      process.off("SIGTERM", onSigint);
      stopProcessGroup();
      releaseLock(state.dir, process.pid);
    }
    recorder.end(runOutcome === "finished" ? "finished" : "failed", lastError ?? null);
    await telemetry?.shutdown();
  }

  if (state) {
    if (runOutcome !== "finished" && !tracesToStdout(config.trace)) {
      console.error(redact(`[runner] ${runOutcome}: ${runReason ?? lastError ?? "unknown error"}`));
    } else if (!tracesToStdout(config.trace)) {
      console.log("[runner] finished");
    }
    process.exitCode = EXIT_CODES[runOutcome];
    return;
  }

  if (runOutcome !== "finished") {
    if (!tracesToStdout(config.trace)) {
      console.error(redact(`[runner] failed: ${lastError ?? "unknown error"}`));
    }
    process.exitCode = 1;
    return;
  }
  if (!tracesToStdout(config.trace)) {
    console.log("[runner] finished");
  }
}

function refuseState(dir: string, config: RunnerConfig): { code: number; message: string } | null {
  let events: JournalEvent[];
  try {
    events = readJournal(dir);
  } catch (error) {
    return { code: EXIT_CODES.failed, message: `refused state: ${error instanceof Error ? error.message : String(error)}` };
  }
  const first = events[0];
  if (first?.event === "run_started") {
    if (first.runbook !== runbookHash(config) || first.inputs !== inputsHash(config)) {
      return { code: EXIT_CODES.changed, message: "refused state: the runbook or its inputs changed; start a new run key" };
    }
    if (first.cwd !== config.cwd) {
      return { code: EXIT_CODES.failed, message: `refused state: it belongs to --cwd ${first.cwd}` };
    }
  }
  const lock = acquireLock(dir, process.pid);
  if (lock === "busy") return { code: EXIT_CODES.stopped, message: "the previous run of this state is still alive" };
  if (lock === "other-host") return { code: EXIT_CODES.failed, message: "refused state: it is locked by another host" };
  return null;
}

function stopProcessGroup(): void {
  const ignore = () => {};
  process.on("SIGTERM", ignore);
  try {
    process.kill(-process.pid, "SIGTERM");
  } catch {}
  setTimeout(() => process.off("SIGTERM", ignore), 100).unref();
}

function selfCommand(): { command: string; args: string[] } {
  const script = process.argv[1] ?? "";
  if (script.includes("$bunfs")) return { command: process.execPath, args: process.argv.slice(2) };
  return { command: process.execPath, args: [...process.execArgv, script, ...process.argv.slice(2)] };
}

async function runInProcessGroup(): Promise<number> {
  const { command, args } = selfCommand();
  const child = spawn(command, args, {
    detached: true,
    stdio: "inherit",
    env: { ...process.env, [GROUP_ENV]: "1" },
  });
  const forward = (signal: NodeJS.Signals) => () => {
    try {
      child.kill(signal);
    } catch {}
  };
  const onInt = forward("SIGINT");
  const onTerm = forward("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  try {
    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolveExit, reject) => {
      child.once("error", reject);
      child.once("exit", (exitCode, exitSignal) => resolveExit([exitCode, exitSignal]));
    });
    try {
      process.kill(-child.pid!, "SIGTERM");
    } catch {}
    return code ?? 128 + (signal === "SIGKILL" ? 9 : 15);
  } finally {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
  }
}

function isDirectRun(): boolean {
  if (process.versions.bun) {
    return Boolean(import.meta.main);
  }
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  runCli().catch((error: unknown) => {
    console.error(createRedactor()(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  });
}
