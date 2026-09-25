import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { AgentStep, RunnerConfig } from "../types.js";

export type WorkflowVariables = Record<string, string>;

function resolveVarValue(
  key: string,
  value: unknown,
  baseDir: string,
  fallbackDir?: string,
  stubMissing?: boolean,
): string {
  if (value == null) return "";
  if (typeof value === "object") {
    const source = value as { env?: unknown; file?: unknown };
    if (typeof source.env === "string") {
      const found = process.env[source.env];
      if (found === undefined) {
        if (stubMissing) return "";
        throw new Error(`var ${key}: environment variable ${source.env} is not set`);
      }
      return found;
    }
    if (typeof (value as { resource?: unknown }).resource === "string") {
      return "";
    }
    if (typeof source.file === "string") {
      try {
        return readFileSync(resolve(baseDir, source.file), "utf8");
      } catch {
        if (fallbackDir) {
          try {
            return readFileSync(resolve(fallbackDir, source.file), "utf8");
          } catch {}
        }
        if (stubMissing) return "";
        throw new Error(`var ${key}: cannot read ${source.file}`);
      }
    }
    throw new Error(`var ${key}: expected a scalar, { env }, { file } or { resource }`);
  }
  return String(value);
}

export function normalizeVariables(
  baseDir: string,
  raw?: Record<string, unknown>,
  fallbackDir?: string,
  stubMissing?: boolean,
): WorkflowVariables {
  if (!raw) return {};
  const out: WorkflowVariables = {};
  for (const [key, value] of Object.entries(raw)) {
    out[key] = resolveVarValue(key, value, baseDir, fallbackDir, stubMissing);
  }
  return out;
}

export function mergeVariablesWithFallback(
  baseDir: string,
  fallbackDir: string | undefined,
  stubMissing?: boolean,
  ...layers: Array<Record<string, unknown> | undefined>
): WorkflowVariables {
  const out: WorkflowVariables = {};
  for (const layer of layers) {
    Object.assign(out, normalizeVariables(baseDir, layer, fallbackDir, stubMissing));
  }
  return out;
}

export function resolveStepVariables(
  config: RunnerConfig,
  step: AgentStep,
  extraVars?: Record<string, unknown>,
  stubMissing?: boolean,
): WorkflowVariables {
  return mergeVariablesWithFallback(
    dirname(config.yamlPath),
    config.cwd,
    stubMissing,
    config.runbook.vars,
    step.vars,
    extraVars,
  );
}

const TEMPLATE_PATTERN = /(\$)?\${{\s*([\w.-]+)\s*}}|\{\{([\w.]+)\}\}/g;

function lookup(
  token: string,
  variables: WorkflowVariables,
  placeholder: string,
  stubEnv: boolean,
): string {
  const dot = token.indexOf(".");
  const namespace = dot === -1 ? "vars" : token.slice(0, dot);
  const key = dot === -1 ? token : token.slice(dot + 1);
  if (namespace === "vars") {
    if (key === "feedback") {
      throw new Error("Check failures are attached automatically; remove the feedback placeholder.");
    }
    if (!Object.hasOwn(variables, key)) {
      throw new Error(`unknown variable ${placeholder}`);
    }
    return variables[key];
  }
  if (namespace === "env") {
    const value = process.env[key];
    if (value === undefined) {
      if (stubEnv) return "";
      throw new Error(`environment variable ${key} is not set (${placeholder})`);
    }
    return value;
  }
  throw new Error(`unknown namespace "${namespace}" in ${placeholder}`);
}

export function renderPromptTemplate(
  template: string,
  variables: WorkflowVariables = {},
  stubEnv = false,
): string {
  return template.replace(
    TEMPLATE_PATTERN,
    (match, escapePrefix?: string, acpToken?: string, legacyToken?: string) => {
      if (escapePrefix) {
        return match.slice(1);
      }
      const token = (acpToken ?? legacyToken)!.trim();
      return lookup(token, variables, match, stubEnv);
    },
  );
}
