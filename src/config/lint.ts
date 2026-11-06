import { dirname } from "node:path";
import type { AgentStep, RunnerConfig } from "../types.js";
import { SECRET_NAME } from "../output/redact.js";
import { promptText, referencesIn, runbookTexts } from "./external.js";
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
  return [
    ...problemsOf(() => resolveStepPrompt(config, step, undefined, stub)),
    ...problemsOf(() => resolveStepCommand(config, step, step.run, undefined, stub)),
  ];
}

function outsideValueProblems(config: RunnerConfig): string[] {
  const baseDir = dirname(config.yamlPath);
  const secretsInPrompts = config.runbook.steps.flatMap((step) =>
    referencesIn(promptText(step, baseDir))
      .filter((reference) => reference.namespace === "secrets")
      .map((reference) => `step ${step.id}: \${{ secrets.${reference.name} }} in a prompt would send the secret to the model`),
  );
  const credentialEnv = new Set(
    runbookTexts(config)
      .flatMap(referencesIn)
      .filter((reference) => reference.namespace === "env" && SECRET_NAME.test(reference.name))
      .map((reference) => reference.name),
  );
  return [
    ...secretsInPrompts,
    ...[...credentialEnv].map((name) => `\${{ env.${name} }} looks like a credential; use \${{ secrets.${name} }}`),
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
    ...outsideValueProblems(config),
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
