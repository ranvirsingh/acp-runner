import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ProviderDeclaration, ProviderId, SpawnCommand } from "../types.js";

export interface ProviderSpec {
  id: ProviderId;
  command: string;
  args: string[];
  model?: string;
}

export interface AdapterConfigOptions {
  cwd?: string;
  userConfigPath?: string | null;
  projectConfigPath?: string | null;
  runbookDeclared?: Record<string, ProviderDeclaration>;
}

export const BUILTIN_PROVIDERS: Record<string, SpawnCommand> = {
  claude: { command: "npx", args: ["-y", "@agentclientprotocol/claude-agent-acp"] },
  codex: { command: "npx", args: ["-y", "@agentclientprotocol/codex-acp"] },
  gemini: { command: "gemini", args: ["--acp"] },
};

function loadConfigFile(filePath: string): Record<string, ProviderDeclaration> | undefined {
  try {
    if (!existsSync(filePath)) return undefined;
    const content = readFileSync(filePath, "utf8");
    const parsed = parseYaml(content) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== "object") return undefined;
    const providersObj = (parsed.providers as Record<string, unknown> | undefined)?.agentHarness;
    if (!providersObj || typeof providersObj !== "object") return undefined;
    const result: Record<string, ProviderDeclaration> = {};
    for (const [key, val] of Object.entries(providersObj as Record<string, unknown>)) {
      if (val && typeof val === "object" && typeof (val as Record<string, unknown>).command === "string") {
        const item = val as { command: string; args?: unknown; model?: unknown };
        result[key] = {
          command: item.command,
          args: Array.isArray(item.args) ? item.args.map(String) : [],
          ...(typeof item.model === "string" && item.model.length > 0 ? { model: item.model } : {}),
        };
      }
    }
    return result;
  } catch {
    return undefined;
  }
}

function findUserConfigFile(override?: string | null): string | null {
  if (override !== undefined) return override;
  if (process.env.ACP_USER_CONFIG) return process.env.ACP_USER_CONFIG;
  const baseDir = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const candYaml = join(baseDir, "acp-runner", "config.yaml");
  if (existsSync(candYaml)) return candYaml;
  const candYml = join(baseDir, "acp-runner", "config.yml");
  if (existsSync(candYml)) return candYml;
  return null;
}

function findProjectConfigFile(cwd: string, override?: string | null): string | null {
  if (override !== undefined) return override;
  if (process.env.ACP_PROJECT_CONFIG) return process.env.ACP_PROJECT_CONFIG;
  const candidates = [
    join(cwd, ".acp-runner.yaml"),
    join(cwd, ".acp-runner.yml"),
    join(cwd, "acp-runner.yaml"),
    join(cwd, "acp-runner.yml"),
  ];
  for (const cand of candidates) {
    if (existsSync(cand)) return cand;
  }
  return null;
}

export function resolveAdapterConfig(
  options?: AdapterConfigOptions,
): Record<string, ProviderDeclaration> {
  const merged: Record<string, ProviderDeclaration> = {};
  for (const [name, spec] of Object.entries(BUILTIN_PROVIDERS)) {
    merged[name] = { command: spec.command, args: [...spec.args] };
  }

  const userPath = findUserConfigFile(options?.userConfigPath);
  if (userPath) {
    const userLayer = loadConfigFile(userPath);
    if (userLayer) {
      for (const [name, entry] of Object.entries(userLayer)) {
        merged[name] = { ...entry, args: [...(entry.args ?? [])] };
      }
    }
  }

  const projectPath = findProjectConfigFile(options?.cwd ?? process.cwd(), options?.projectConfigPath);
  if (projectPath) {
    const projectLayer = loadConfigFile(projectPath);
    if (projectLayer) {
      for (const [name, entry] of Object.entries(projectLayer)) {
        merged[name] = { ...entry, args: [...(entry.args ?? [])] };
      }
    }
  }

  if (options?.runbookDeclared) {
    for (const [name, entry] of Object.entries(options.runbookDeclared)) {
      merged[name] = { ...entry, args: [...(entry.args ?? [])] };
    }
  }

  return merged;
}

export function knownProviderIds(
  declared?: Record<string, ProviderDeclaration>,
  options?: AdapterConfigOptions,
): ProviderId[] {
  const all = resolveAdapterConfig({
    ...options,
    runbookDeclared: declared ?? options?.runbookDeclared,
  });
  return Object.keys(all);
}

export function providerSpec(
  provider: ProviderId,
  declared?: Record<string, ProviderDeclaration>,
  options?: AdapterConfigOptions,
): ProviderSpec {
  const all = resolveAdapterConfig({
    ...options,
    runbookDeclared: declared ?? options?.runbookDeclared,
  });
  const entry = all[provider];
  if (!entry) {
    throw new Error(
      `unknown provider "${provider}" (known: ${knownProviderIds(declared, options).sort().join(", ")})`,
    );
  }
  return { id: provider, ...entry, args: [...(entry.args ?? [])] };
}

export function defaultProvider(): ProviderId {
  return "claude";
}

export function spawnCommandFor(
  provider: ProviderId,
  declared?: Record<string, ProviderDeclaration>,
  options?: AdapterConfigOptions,
): SpawnCommand {
  const { command, args } = providerSpec(provider, declared, options);
  return { command, args };
}

export function describeSpawn(
  provider: ProviderId,
  declared?: Record<string, ProviderDeclaration>,
  options?: AdapterConfigOptions,
): string {
  const { command, args } = spawnCommandFor(provider, declared, options);
  return `${command} ${args.join(" ")}`;
}
