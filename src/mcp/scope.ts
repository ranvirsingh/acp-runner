import type { StepServers, ToolScope } from "../types.js";

export type StepScope = Record<string, ToolScope>;

export const TOOL_SEPARATOR = "__";

export function normalizeScope(servers: StepServers | undefined, declared: string[]): StepScope {
  if (servers === undefined) {
    return Object.fromEntries(declared.map((name) => [name, {}]));
  }
  if (Array.isArray(servers)) {
    return Object.fromEntries(servers.map((name) => [name, {}]));
  }
  return { ...servers };
}

export function matchesPattern(name: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (char) =>
    char === "*" ? ".*" : `\\${char}`,
  );
  return new RegExp(`^${escaped}$`).test(name);
}

export function toolAllowed(scope: StepScope, server: string, tool: string): boolean {
  if (!Object.hasOwn(scope, server)) return false;
  const rules = scope[server] ?? {};
  if (rules.allow && !rules.allow.some((pattern) => matchesPattern(tool, pattern))) return false;
  if (rules.deny?.some((pattern) => matchesPattern(tool, pattern))) return false;
  return true;
}

export function qualifyToolName(server: string, tool: string): string {
  return `${server}${TOOL_SEPARATOR}${tool}`;
}

export function splitToolName(
  qualified: string,
  servers: string[],
): { server: string; tool: string } | null {
  const matched = servers
    .filter((name) => qualified.startsWith(`${name}${TOOL_SEPARATOR}`))
    .sort((left, right) => right.length - left.length)[0];
  if (!matched) return null;
  return { server: matched, tool: qualified.slice(matched.length + TOOL_SEPARATOR.length) };
}

export function visibleTools<T extends { name: string }>(
  catalogue: Map<string, T[]>,
  scope: StepScope,
): T[] {
  const out: T[] = [];
  for (const [server, tools] of catalogue) {
    for (const tool of tools) {
      if (!toolAllowed(scope, server, tool.name)) continue;
      out.push({ ...tool, name: qualifyToolName(server, tool.name) });
    }
  }
  return out;
}
