import type {
  NextDecision,
  ProviderId,
  ResolvedMcpServer,
  SessionContext,
  TransitionWhy,
} from "../types.js";
import { needsNewBody, resolveModel, resolveStepPrompt, resolveStepServers } from "../config/yaml.js";
import type { RunnerConfig } from "../types.js";

export function nextFallback(context: SessionContext): ProviderId | undefined {
  return context.fallback.find((provider) => !context.triedProviders.includes(provider));
}

export function decideAfterError(context: SessionContext): {
  decision: NextDecision;
  provider?: ProviderId;
  model?: string;
  lastError?: string;
  why?: TransitionWhy;
  target?: string | null;
} {
  if (context.onSpawnError === "fail") {
    return { decision: "fail", lastError: context.lastError, why: null, target: null };
  }
  const provider = nextFallback(context);
  if (!provider) {
    return {
      decision: "fail",
      lastError: context.lastError ?? "no fallback providers left",
      why: null,
      target: null,
    };
  }
  return { decision: "swap", provider, model: undefined, why: null, target: null };
}

export function isTerminalEnd(target?: string): boolean {
  return typeof target === "string" && target.trim().toLowerCase() === "end";
}

function isTerminalFail(target?: string): boolean {
  return typeof target === "string" && target.trim().toLowerCase() === "fail";
}

export function decideAfterSuccess(
  context: SessionContext,
  config: RunnerConfig,
): {
  decision: NextDecision;
  stepIndex: number;
  provider: ProviderId;
  model?: string;
  prompt: string;
  mcpServers: ResolvedMcpServer[];
  loopCounts?: Record<string, number>;
  lastError?: string;
  why?: TransitionWhy;
  target?: string | null;
} {
  const rawSteps = config.runbook.steps;
  const currentStep = rawSteps[context.stepIndex];
  const outcome = context.stepOutcome ?? "success";
  let nextIndex = context.stepIndex + 1;
  let loopCounts = context.loopCounts;

  const failureTransition =
    currentStep?.on?.failure ??
    (currentStep?.retry
      ? {
          target: currentStep.id,
          maxAttempts: currentStep.retry.maxAttempts,
          fallback: currentStep.retry.fallback,
        }
      : undefined);

  if (outcome === "failure" && !failureTransition) {
    return {
      decision: "fail",
      stepIndex: context.stepIndex,
      provider: context.provider,
      model: context.model,
      prompt: context.prompt,
      mcpServers: context.mcpServers,
      lastError: context.failure?.output || `step ${currentStep?.id ?? context.stepIndex}: failed`,
      why: null,
      target: null,
      ...(Object.keys(loopCounts).length > 0 ? { loopCounts } : {}),
    };
  }

  let why: TransitionWhy = "fallthrough";
  let target: string | null = null;

  const transition = outcome === "failure" ? failureTransition : currentStep?.on?.success;
  if (transition) {
    const targetId = typeof transition === "string" ? transition : transition.target;
    const maxAttempts = typeof transition === "object" ? transition.maxAttempts : undefined;
    const fallbackId = typeof transition === "object" ? transition.fallback : undefined;
    const loopKey = `${currentStep.id}->${targetId}`;
    const attempts = (loopCounts[loopKey] ?? 0) + 1;

    if (maxAttempts !== undefined && attempts > maxAttempts) {
      if (isTerminalEnd(fallbackId)) {
          return {
            decision: "finish",
            stepIndex: context.stepIndex,
            provider: context.provider,
            model: context.model,
            prompt: context.prompt,
            mcpServers: context.mcpServers,
            why: "maxAttempts",
            target: null,
            ...(Object.keys(loopCounts).length > 0 ? { loopCounts } : {}),
          };
        }
        if (isTerminalFail(fallbackId)) {
          return {
            decision: "fail",
            stepIndex: context.stepIndex,
            provider: context.provider,
            model: context.model,
            prompt: context.prompt,
            mcpServers: context.mcpServers,
            lastError: context.failure?.output || `step ${currentStep.id}: max attempts (${maxAttempts}) exceeded`,
            why: "maxAttempts",
            target: null,
            ...(Object.keys(loopCounts).length > 0 ? { loopCounts } : {}),
          };
        }
        if (fallbackId) {
          nextIndex = rawSteps.findIndex((s) => s.id === fallbackId);
          why = "fallback";
          target = fallbackId;
        } else {
          return {
            decision: "fail",
            stepIndex: context.stepIndex,
            provider: context.provider,
            model: context.model,
            prompt: context.prompt,
            mcpServers: context.mcpServers,
            lastError: `step ${currentStep.id}: max attempts (${maxAttempts}) exceeded`,
            loopCounts,
            why: "maxAttempts",
            target: null,
          };
        }
      } else {
        why = outcome === "success" ? "on.success" : "on.failure";
        if (isTerminalEnd(targetId)) {
          return {
            decision: "finish",
            stepIndex: context.stepIndex,
            provider: context.provider,
            model: context.model,
            prompt: context.prompt,
            mcpServers: context.mcpServers,
            why,
            target: null,
            ...(Object.keys(loopCounts).length > 0 ? { loopCounts } : {}),
          };
        }
        if (isTerminalFail(targetId)) {
          return {
            decision: "fail",
            stepIndex: context.stepIndex,
            provider: context.provider,
            model: context.model,
            prompt: context.prompt,
            mcpServers: context.mcpServers,
            lastError: context.failure?.output || `step ${currentStep.id}: failed`,
            why,
            target: null,
            ...(Object.keys(loopCounts).length > 0 ? { loopCounts } : {}),
          };
        }
        nextIndex = rawSteps.findIndex((s) => s.id === targetId);
        target = targetId;
        loopCounts = { ...loopCounts, [loopKey]: attempts };
      }
    }

  if (nextIndex < 0 || nextIndex >= rawSteps.length) {
    return {
      decision: nextIndex >= rawSteps.length ? "finish" : "fail",
      stepIndex: context.stepIndex,
      provider: context.provider,
      model: context.model,
      prompt: context.prompt,
      mcpServers: context.mcpServers,
      why,
      target: null,
      ...(Object.keys(loopCounts).length > 0 ? { loopCounts } : {}),
    };
  }

  const nextRaw = rawSteps[nextIndex];
  const provider = nextRaw.provider ?? context.provider;
  const model = resolveModel(config, { ...nextRaw, provider })
    ?? (provider === context.provider ? context.model : undefined);
  const rendered = resolveStepPrompt(config, nextRaw);
  const mcpServers = resolveStepServers(config, nextRaw);
  const swap = needsNewBody(
    { provider: context.provider, model: context.model },
    { provider, model },
  );

  return {
    decision: swap ? "swap" : "stay",
    stepIndex: nextIndex,
    provider,
    model,
    prompt: rendered,
    mcpServers,
    why,
    target: target ?? nextRaw.id,
    ...(Object.keys(loopCounts).length > 0 ? { loopCounts } : {}),
  };
}
