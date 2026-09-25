import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
  type SpawnSyncReturns,
} from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function runCli(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {},
): SpawnSyncReturns<string> {
  const bun = Boolean(process.versions.bun);
  const command = process.execPath;
  const prefix = bun ? ["src/cli.ts"] : ["--import", "tsx", "src/cli.ts"];
  return spawnSync(command, [...prefix, ...args], {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    timeout: options.timeout,
    env: { ...process.env, NODE_NO_WARNINGS: "1", ...options.env },
  });
}

export function spawnCli(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): ChildProcessWithoutNullStreams {
  const bun = Boolean(process.versions.bun);
  const prefix = bun ? ["src/cli.ts"] : ["--import", "tsx", "src/cli.ts"];
  return spawn(process.execPath, [...prefix, ...args], {
    cwd: options.cwd ?? root,
    env: { ...process.env, NODE_NO_WARNINGS: "1", ...options.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
}
