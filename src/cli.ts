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
import { runAgent } from "./index.js";
import { lintCommand } from "./config/lint.js";
import { planCommand } from "./config/plan.js";
import { checkCommand } from "./runtime/check.js";
import { installSkill } from "./skill.js";
import { RUNNER_VERSION } from "./version.js";

const USAGE =
  "usage: acp-runner run [agent.yaml|folder] [--cwd <dir>] [--trace off|file|stdout|both] [--confirm]\n" +
  "       acp-runner lint [agent.yaml|folder ...]\n" +
  "       acp-runner plan [agent.yaml|folder]\n" +
  "       acp-runner check [agent.yaml|folder]\n" +
  "       acp-runner skill install";

export interface ParsedArgs {
  yamlPath: string;
  cwd: string;
  trace: TraceMode;
  confirm?: boolean;
}

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
    if (token === "--cwd" || token === "--trace") {
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
  const config = loadConfig(args);
  if (!tracesToStdout(config.trace)) {
    console.log(`[runner] ${config.runbook.name ?? "agent"} cwd=${config.cwd}`);
  }

  const recorder = new RunRecorder(config);
  recorder.start();

  let loggedStep = -1;
  let runOutcome: "finished" | "failed" = "failed";
  let lastError: string | undefined;

  const controller = new AbortController();
  const onSigint = () => {
    if (!tracesToStdout(config.trace)) {
      console.error("[runner] cancelling");
    }
    controller.abort();
  };
  process.once("SIGINT", onSigint);

  try {
    const { outcome, context } = await runAgent({
      config,
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
  } catch (error: any) {
    runOutcome = "failed";
    lastError = error instanceof Error ? error.message : String(error);
  } finally {
    process.off("SIGINT", onSigint);
    recorder.end(runOutcome, lastError ?? null);
  }

  if (runOutcome === "failed") {
    if (!tracesToStdout(config.trace)) {
      console.error(`[runner] failed: ${lastError ?? "unknown error"}`);
    }
    process.exitCode = 1;
    return;
  }
  if (!tracesToStdout(config.trace)) {
    console.log("[runner] finished");
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
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
