import type { AgentStep, RunnerConfig } from "../types.js";
import { renderPromptTemplate, resolveStepVariables } from "./vars.js";
import {
  loadAgentYaml,
  resolveMcpServers,
  resolveRunbookPath,
  resolveStepCommand,
  resolveStepPrompt,
} from "./yaml.js";

const stub = { stubMissingVars: true };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function problemsOf(check: () => unknown): string[] {
  try {
    check();
    return [];
  } catch (error) {
    return [messageOf(error)];
  }
}

function lintStep(config: RunnerConfig, step: AgentStep): string[] {
  const promptArguments = Object.entries(step.promptRef?.arguments ?? {}).flatMap(([key, value]) =>
    problemsOf(() =>
      renderPromptTemplate(value, resolveStepVariables(config, step, undefined, true), true),
    ).map((problem) => `step ${step.id}: promptRef.arguments.${key}: ${problem}`),
  );
  return [
    ...problemsOf(() => resolveStepPrompt(config, step, undefined, stub)),
    ...problemsOf(() => resolveStepCommand(config, step, step.run, undefined, stub)),
    ...promptArguments,
  ];
}

export function lintRunbook(path: string): string[] {
  let config: RunnerConfig;
  try {
    const yamlPath = resolveRunbookPath(path);
    config = { yamlPath, cwd: process.cwd(), runbook: loadAgentYaml(yamlPath) };
  } catch (error) {
    return [messageOf(error)];
  }
  return [
    ...problemsOf(() => resolveMcpServers(config, true)),
    ...config.runbook.steps.flatMap((step) => lintStep(config, step)),
  ];
}

export function lintCommand(targets: string[]): number {
  let failed = false;
  for (const target of targets.length > 0 ? targets : ["agent.yaml"]) {
    const problems = lintRunbook(target);
    if (problems.length === 0) {
      console.log(`ok ${target}`);
      continue;
    }
    failed = true;
    console.error(`fail ${target}`);
    for (const problem of problems) {
      console.error(`  ${problem}`);
    }
  }
  return failed ? 1 : 0;
}
