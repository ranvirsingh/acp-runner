import { dirname } from "node:path";
import type { AgentStep, McpServerSpec, RunnerConfig } from "../types.js";
import { TEMPLATE_PATTERN } from "./vars.js";
import { stepBody } from "./yaml.js";

export interface ExternalReferences {
  env: string[];
  secrets: string[];
}

export interface ExternalReference {
  namespace: "env" | "secrets";
  name: string;
}

export function referencesIn(text: string): ExternalReference[] {
  const found: ExternalReference[] = [];
  for (const [, escaped, token] of text.matchAll(TEMPLATE_PATTERN)) {
    if (escaped || !token) continue;
    const dot = token.indexOf(".");
    const namespace = token.slice(0, dot);
    if (dot > 0 && (namespace === "env" || namespace === "secrets")) {
      found.push({ namespace, name: token.slice(dot + 1) });
    }
  }
  return found;
}

export function promptText(step: AgentStep, baseDir: string): string {
  try {
    return stepBody(step, baseDir) ?? "";
  } catch {
    return "";
  }
}

function commandTexts(step: AgentStep): string[] {
  if (!step.run) return [];
  return typeof step.run === "string" ? [step.run] : [step.run.command, ...(step.run.args ?? [])];
}

function serverTexts(spec: McpServerSpec): string[] {
  if ("url" in spec) return [spec.url, ...Object.values(spec.headers ?? {})];
  return [spec.command, ...(spec.args ?? []), ...Object.values(spec.env ?? {})];
}

export function runbookTexts(config: RunnerConfig): string[] {
  const baseDir = dirname(config.yamlPath);
  return [
    ...Object.values(config.runbook.mcpServers ?? {}).flatMap(serverTexts),
    ...config.runbook.steps.flatMap((step) => [promptText(step, baseDir), ...commandTexts(step)]),
  ];
}

function sorted(names: Set<string>): string[] {
  return [...names].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

export function externalReferences(config: RunnerConfig): ExternalReferences {
  const env = new Set<string>();
  const secrets = new Set<string>();
  for (const text of runbookTexts(config)) {
    for (const reference of referencesIn(text)) {
      (reference.namespace === "env" ? env : secrets).add(reference.name);
    }
  }
  return { env: sorted(env), secrets: sorted(secrets) };
}

export function missingExternalValues(
  config: RunnerConfig,
  environment: NodeJS.ProcessEnv = process.env,
): string[] {
  const { env, secrets } = externalReferences(config);
  return [
    ...env.filter((name) => environment[name] === undefined).map((name) => `env ${name} is not set`),
    ...secrets.flatMap((name) => {
      if (environment[name] === undefined) return [`secret ${name} is not set`];
      if (environment[name] === "") return [`secret ${name} is empty`];
      return [];
    }),
  ];
}
