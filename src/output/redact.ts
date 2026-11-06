import type { RunnerConfig } from "../types.js";

const SECRET_NAME = /token|secret|password|passwd|api[_-]?key|credential|authorization|cookie|private[_-]?key/i;

export function createRedactor(config?: RunnerConfig, extraSecrets: string[] = []): (text: string) => string {
  const secrets = new Set(extraSecrets);
  const collect = (values: Record<string, unknown> = {}) => {
    for (const [key, value] of Object.entries(values)) {
      if (SECRET_NAME.test(key) && typeof value === "string") secrets.add(value);
      if (value && typeof value === "object" && "env" in value && typeof value.env === "string") {
        const secret = process.env[value.env];
        if (secret) secrets.add(secret);
      }
    }
  };
  collect(process.env);
  collect(config?.runbook.vars);
  for (const step of config?.runbook.steps ?? []) collect(step.vars);
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
