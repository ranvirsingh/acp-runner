import type { RunnerConfig } from "../types.js";
import { externalReferences } from "../config/external.js";

export const SECRET_NAME = /token|secret|password|passwd|api[_-]?key|credential|authorization|cookie|private[_-]?key/i;

export function createRedactor(config?: RunnerConfig, extraSecrets: string[] = []): (text: string) => string {
  const secrets = new Set(extraSecrets);
  const collect = (values: Record<string, unknown> = {}) => {
    for (const [key, value] of Object.entries(values)) {
      if (SECRET_NAME.test(key) && typeof value === "string") secrets.add(value);
    }
  };
  collect(process.env);
  collect(config?.runbook.vars);
  for (const step of config?.runbook.steps ?? []) collect(step.vars);
  for (const name of config ? externalReferences(config).secrets : []) {
    const secret = process.env[name];
    if (secret) secrets.add(secret);
  }
  for (const server of Object.values(config?.runbook.mcpServers ?? {})) {
    if ("headers" in server) {
      for (const value of Object.values(server.headers ?? {})) secrets.add(value);
    }
    if ("env" in server) collect(server.env);
  }
  const values = [...secrets].filter((value) => value.length >= 4).sort((a, b) => b.length - a.length);
  return (text) => {
    for (const value of values) text = text.replaceAll(value, "[REDACTED]");
    return text;
  };
}
