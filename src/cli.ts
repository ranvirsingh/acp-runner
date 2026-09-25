import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import {
  isTraceMode,
  tracesToStdout,
  type ProviderId,
  type RunnerConfig,
  type TraceMode,
} from "./types.js";
import { providerSpec } from "./runtime/providers.js";
import { pickAllowOption, pickRejectOption } from "./runtime/session.js";
import { loadAgentYaml, resolveModel, resolveProvider, resolveRunbookPath } from "./config/yaml.js";
import { stateLog, stepLog } from "./output/logs.js";
import { RunRecorder } from "./output/record.js";
import { runAgent } from "./index.js";
import { lintCommand } from "./config/lint.js";
import { RUNNER_VERSION } from "./version.js";

const USAGE =
  "usage: acp-runner [agent.yaml|folder] [--cwd <dir>] [--provider claude|codex|gemini] [--trace off|file|stdout|both] [--confirm]\n" +
  "       acp-runner lint [agent.yaml|folder ...]";

export interface ParsedArgs {
  yamlPath: string;
  cwd: string;
  provider?: ProviderId;
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
    if (token === "--cwd" || token === "--provider" || token === "--trace") {
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

  const provider: ProviderId | undefined = flags.get("--provider");

  const traceFlag = flags.get("--trace") ?? "stdout";
  if (!isTraceMode(traceFlag)) {
    throw new Error(`--trace must be off, file, stdout, or both (got ${traceFlag})`);
  }

  return {
    yamlPath,
    cwd: resolve(flags.get("--cwd") ?? process.cwd()),
    provider,
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
    providerOverride: args.provider,
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
  if (argv[0] === "lint") {
    process.exitCode = lintCommand(argv.slice(1));
    return;
  }
  const args = parseArgs(argv);
  const config = loadConfig(args);
  const first = config.runbook.steps[0];
  const provider = resolveProvider(config, first);
  providerSpec(provider, config.runbook.providers?.agentHarness, { cwd: config.cwd });
  const model = resolveModel(config, first);

  if (!tracesToStdout(config.trace)) {
    console.log(
      `[runner] ${config.runbook.name ?? "agent"} provider=${provider}` +
        `${model ? ` model=${model}` : ""} cwd=${config.cwd}`,
    );
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
            stepLog(config.runbook.steps[context.stepIndex]?.id ?? "?", context.provider);
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
