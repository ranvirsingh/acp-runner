import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { externalReferences } from "../config/external.js";
import { normalizeVariables } from "../config/vars.js";
import type { RunnerConfig, StepFailure, TransitionWhy } from "../types.js";

export const JOURNAL_FILE = "agent.state.jsonl";
export const LOCK_FILE = "agent.state.lock";

type Visit = { step: string; visit: number };

export type JournalEvent =
  | { event: "run_started"; v: 1; runbook: string; inputs: string; runner: string; cwd: string }
  | ({ event: "step_started" } & Visit)
  | ({ event: "session_attached"; provider: string; sessionId: string; origin: "new" | "carried" } & Visit)
  | ({ event: "session_resumed"; provider: string; sessionId: string; method: "session/resume" | "session/load" } & Visit)
  | ({ event: "prompt_sent"; sessionId: string; kind: "step" | "resend"; feedback?: string } & Visit)
  | ({ event: "tool_started"; call: number; server: string; tool: string } & Visit)
  | ({ event: "tool_completed"; call: number; isError: boolean } & Visit)
  | ({ event: "prompt_completed"; stopReason: string; feedback?: string } & Visit)
  | ({
      event: "step_completed";
      outcome: "success" | "failure";
      why: TransitionWhy;
      next: string;
      swap?: true;
      feedback?: string;
    } & Visit)
  | { event: "run_finished"; outcome: "finished" | "failed" | "unknown"; reason?: string };

export class JournalCorrupt extends Error {}

export function readJournal(dir: string): JournalEvent[] {
  const path = join(dir, JOURNAL_FILE);
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n");
  lines.pop();
  const events = lines.map((line, index) => {
    try {
      return JSON.parse(line) as JournalEvent;
    } catch {
      throw new JournalCorrupt(`${path}: line ${index + 1} is not valid JSON`);
    }
  });
  const first = events[0];
  if (first && (first.event !== "run_started" || first.v !== 1)) {
    throw new JournalCorrupt(`${path}: line 1 is not run_started with v 1`);
  }
  return events;
}

function fsyncDir(dir: string): void {
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function truncateTornTail(path: string): void {
  if (!existsSync(path)) return;
  const text = readFileSync(path);
  const end = text.lastIndexOf(0x0a) + 1;
  if (end === text.length) return;
  const fd = openSync(path, "r+");
  try {
    ftruncateSync(fd, end);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function journalWriter(dir: string): (event: JournalEvent) => void {
  const path = join(dir, JOURNAL_FILE);
  let first = true;
  return (event) => {
    if (first) {
      mkdirSync(dir, { recursive: true });
      truncateTornTail(path);
    }
    const created = !existsSync(path);
    const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT);
    try {
      writeSync(fd, `${JSON.stringify(event)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (created) fsyncDir(dir);
    first = false;
  };
}

export interface Journal {
  readonly failed: boolean;
  append(event: JournalEvent): Promise<void>;
}

export function createJournal(write: (event: JournalEvent) => void | Promise<void>): Journal {
  let tail: Promise<void> = Promise.resolve();
  let failed = false;
  return {
    get failed() {
      return failed;
    },
    append(event) {
      const next = tail.then(async () => {
        if (failed) throw new Error("journal write failed earlier; the journal may be behind");
        try {
          await write(event);
        } catch (error) {
          failed = true;
          throw error;
        }
      });
      tail = next.catch(() => {});
      return next;
    },
  };
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function acquireLock(dir: string, pgid: number): "acquired" | "busy" | "other-host" {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, LOCK_FILE);
  const host = hostname();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
      try {
        writeSync(fd, JSON.stringify({ host, pgid }));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return "acquired";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const held = JSON.parse(readFileSync(path, "utf8")) as { host: string; pgid: number };
    if (held.host !== host) return "other-host";
    if (groupAlive(held.pgid)) return "busy";
    unlinkSync(path);
  }
  return "busy";
}

export function releaseLock(dir: string, pgid: number): void {
  const path = join(dir, LOCK_FILE);
  try {
    const held = JSON.parse(readFileSync(path, "utf8")) as { pgid: number };
    if (held.pgid === pgid) unlinkSync(path);
  } catch {}
}

export function writeFeedback(dir: string, step: string, visit: number, failure: StepFailure): string {
  const relative = `feedback/${step}-${visit}.json`;
  const folder = join(dir, "feedback");
  mkdirSync(folder, { recursive: true });
  const target = join(dir, relative);
  const temporary = `${target}.tmp`;
  const fd = openSync(temporary, "w");
  try {
    writeSync(fd, JSON.stringify(failure));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, target);
  fsyncDir(folder);
  return relative;
}

export function readFeedback(dir: string, relative: string): StepFailure {
  return JSON.parse(readFileSync(join(dir, relative), "utf8")) as StepFailure;
}

function digest(parts: string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(`${Buffer.byteLength(part)}:${part}`);
  return `sha256:${hash.digest("hex")}`;
}

function fileSources(config: RunnerConfig): string[] {
  const baseDir = dirname(config.yamlPath);
  const files = new Set<string>();
  const addVars = (vars?: Record<string, unknown>) => {
    for (const value of Object.values(vars ?? {})) {
      const file = value && typeof value === "object" ? (value as { file?: unknown }).file : undefined;
      if (typeof file === "string") files.add(resolve(baseDir, file));
    }
  };
  addVars(config.runbook.vars);
  for (const step of config.runbook.steps) {
    if (step.do && typeof step.do === "object") files.add(resolve(baseDir, step.do.file));
    addVars(step.vars);
  }
  return [...files].sort();
}

export function runbookHash(config: RunnerConfig): string {
  const baseDir = dirname(config.yamlPath);
  const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");
  return digest([
    read(config.yamlPath),
    ...fileSources(config).flatMap((path) => [path.slice(baseDir.length), read(path)]),
  ]);
}

export function inputsHash(config: RunnerConfig): string {
  const baseDir = dirname(config.yamlPath);
  const vars = [config.runbook.vars, ...config.runbook.steps.map((step) => step.vars)].map((layer) =>
    normalizeVariables(baseDir, layer, config.cwd, true),
  );
  const env = externalReferences(config).env.map((name) => [name, process.env[name] ?? null]);
  const servers = Object.entries(config.runbook.mcpServers ?? {}).map(([name, spec]) =>
    "url" in spec
      ? { name, url: spec.url, headers: Object.keys(spec.headers ?? {}).sort() }
      : { name, command: spec.command, args: spec.args ?? [], env: Object.keys(spec.env ?? {}).sort() },
  );
  return digest([JSON.stringify({ vars, env, servers })]);
}
