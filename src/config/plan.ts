import type { AgentStep, RunnerConfig, StepTransition } from "../types.js";
import {
  loadAgentYaml,
  resolveModel,
  resolveRunbookPath,
  resolveStepCommand,
  resolveStepPrompt,
  resolveStepScope,
} from "./yaml.js";

const LABEL_WIDTH = 10;
const stub = { stubMissingVars: true };

function row(label: string, value: string): string[] {
  const indent = " ".repeat(3 + LABEL_WIDTH);
  return value.split("\n").map((line, index) =>
    index === 0 ? `   ${label.padEnd(LABEL_WIDTH)}${line}` : `${indent}${line}`,
  );
}

function resourcePlaceholders(config: RunnerConfig, step: AgentStep): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, source] of Object.entries({ ...config.runbook.vars, ...step.vars })) {
    const spec = source as { resource?: unknown; mcpServer?: unknown } | null;
    if (spec && typeof spec === "object" && typeof spec.resource === "string") {
      out[key] = `<resource ${spec.resource} from ${String(spec.mcpServer)}>`;
    }
  }
  return out;
}

function describeScope(config: RunnerConfig, step: AgentStep): string {
  const scope = resolveStepScope(config, step);
  const names = Object.keys(scope);
  if (names.length === 0) return "none";
  return names
    .map((name) => {
      const rules = [
        ...(scope[name].allow ? [`allow ${scope[name].allow!.join(", ")}`] : []),
        ...(scope[name].deny ? [`deny ${scope[name].deny!.join(", ")}`] : []),
      ];
      return rules.length > 0 ? `${name} (${rules.join("; ")})` : name;
    })
    .join(", ");
}

function describeTransition(transition: StepTransition): string {
  if (typeof transition === "string") return transition;
  if (transition.maxAttempts === undefined) return transition.target;
  return `${transition.target} (max ${transition.maxAttempts}, then ${transition.fallback ?? "FAIL"})`;
}

function planStep(config: RunnerConfig, step: AgentStep, index: number): string[] {
  const steps = config.runbook.steps;
  const lines = [`${index + 1}. ${step.id}`];
  const vars = resourcePlaceholders(config, step);
  if (step.do != null) {
    lines.push(...row("provider", `${step.provider} (${resolveModel(config, step)})`));
    lines.push(...row("mcp", describeScope(config, step)));
    lines.push(...row("do", resolveStepPrompt(config, step, vars, stub).trimEnd()));
  }
  const command = resolveStepCommand(config, step, step.run, vars, stub);
  if (command) lines.push(...row("run", command));
  const failure =
    step.on?.failure ??
    (step.retry ? { target: step.id, maxAttempts: step.retry.maxAttempts, fallback: step.retry.fallback } : undefined);
  lines.push(`   success → ${step.on?.success ? describeTransition(step.on.success) : (steps[index + 1]?.id ?? "END")}`);
  lines.push(`   failure → ${failure ? describeTransition(failure) : "FAIL"}`);
  return lines;
}

export function planRunbook(path: string): string {
  const yamlPath = resolveRunbookPath(path);
  const config: RunnerConfig = { yamlPath, cwd: process.cwd(), runbook: loadAgentYaml(yamlPath) };
  const { name, description, steps } = config.runbook;
  const title = [name ?? "agent", description].filter(Boolean).join(": ");
  return [title, ...steps.flatMap((step, index) => ["", ...planStep(config, step, index)])].join("\n");
}

export function planCommand(target: string): number {
  try {
    console.log(planRunbook(target));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
