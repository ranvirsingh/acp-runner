import { readsResources } from "../mcp/inputs.js";
import { isScriptStep, type ProviderId, type RunnerConfig } from "../types.js";
import type { JournalEvent } from "./journal.js";

type Attached = { provider: ProviderId; sessionId: string; origin: "new" | "carried" };

export type RecoveryAction =
  | { action: "new" }
  | { action: "done"; outcome: "finished" | "failed" | "unknown"; reason?: string }
  | { action: "finish"; outcome: "finished" | "failed" }
  | { action: "start"; stepIndex: number }
  | { action: "unknown"; reason: "tool_in_doubt" | "inputs_unrecoverable" | "resend_interrupted" }
  | { action: "continue"; stepIndex: number; visit: number; mode: "rerun" | "check" | "resend" | "prompt"; attached?: Attached };

export interface Recovery {
  next: RecoveryAction;
  visits: Record<string, number>;
  loopCounts: Record<string, number>;
  feedback?: string;
  active?: { provider: ProviderId; sessionId: string };
  provider?: ProviderId;
  calls: number;
}

type Of<T extends JournalEvent["event"]> = Extract<JournalEvent, { event: T }>;

export function unfinishedTools(events: JournalEvent[]): Array<{ server: string; tool: string }> {
  const open = new Map<string, { server: string; tool: string }>();
  for (const event of events) {
    if (event.event === "step_started") open.clear();
    if (event.event === "tool_started") open.set(`${event.step}:${event.visit}:${event.call}`, event);
    if (event.event === "tool_completed") open.delete(`${event.step}:${event.visit}:${event.call}`);
  }
  return [...open.values()];
}

export function recover(
  events: JournalEvent[],
  config: RunnerConfig,
  idempotent: (server: string, tool: string) => boolean,
): Recovery {
  const steps = config.runbook.steps;
  const indexOf = (id: string) => steps.findIndex((step) => step.id === id);
  const visits: Record<string, number> = {};
  const loopCounts: Record<string, number> = {};
  let feedback: string | undefined;
  let active: Recovery["active"];
  let provider: ProviderId | undefined;
  let lastCompleted: Of<"step_completed"> | undefined;
  let open: Of<"step_started"> | undefined;
  let visitEvents: JournalEvent[] = [];
  let finished: Of<"run_finished"> | undefined;

  for (const event of events) {
    if (event.event === "run_finished") finished = event;
    if (event.event === "step_started") {
      visits[event.step] = event.visit;
      provider = steps[indexOf(event.step)]?.provider ?? provider;
      open = event;
      visitEvents = [];
    }
    if (open) visitEvents.push(event);
    if (event.event === "session_attached" || event.event === "session_resumed") {
      active = { provider: event.provider, sessionId: event.sessionId };
    }
    if (event.event === "prompt_completed" && event.feedback === feedback) feedback = undefined;
    if (event.event === "step_completed") {
      lastCompleted = event;
      open = undefined;
      feedback = event.feedback;
      if (event.swap) active = undefined;
      if ((event.why === "on.success" || event.why === "on.failure") && indexOf(event.next) >= 0) {
        const key = `${event.step}->${event.next}`;
        loopCounts[key] = (loopCounts[key] ?? 0) + 1;
      }
    }
  }

  const calls = Math.max(0, ...visitEvents.flatMap((event) => (event.event === "tool_started" ? [event.call] : [])));
  const result = (next: RecoveryAction, stepIndex?: number): Recovery => ({
    next,
    visits,
    loopCounts,
    ...(feedback ? { feedback } : {}),
    ...(active ? { active } : {}),
    provider: stepIndex === undefined ? provider : (steps[stepIndex]?.provider ?? provider),
    calls,
  });

  if (events.length === 0) return result({ action: "new" });
  if (finished) {
    return result({ action: "done", outcome: finished.outcome, ...(finished.reason ? { reason: finished.reason } : {}) });
  }
  if (!open) {
    if (!lastCompleted) return result({ action: "start", stepIndex: 0 }, 0);
    if (lastCompleted.next === "END") return result({ action: "finish", outcome: "finished" });
    if (lastCompleted.next === "FAIL") return result({ action: "finish", outcome: "failed" });
    const stepIndex = indexOf(lastCompleted.next);
    return result({ action: "start", stepIndex }, stepIndex);
  }

  const stepIndex = indexOf(open.step);
  const step = steps[stepIndex];
  const position = { stepIndex, visit: open.visit };
  if (unfinishedTools(visitEvents).some((call) => !idempotent(call.server, call.tool))) {
    return result({ action: "unknown", reason: "tool_in_doubt" });
  }
  if (isScriptStep(step)) return result({ action: "continue", ...position, mode: "rerun" });
  const prompts = visitEvents.filter((event) => event.event === "prompt_sent" || event.event === "prompt_completed");
  if (prompts.length > 0 && readsResources(config, step)) {
    return result({ action: "unknown", reason: "inputs_unrecoverable" });
  }
  const lastPrompt = prompts.at(-1);
  if (lastPrompt?.event === "prompt_sent") {
    if (lastPrompt.kind === "resend") return result({ action: "unknown", reason: "resend_interrupted" });
    return result({ action: "continue", ...position, mode: "resend" });
  }
  if (lastPrompt?.event === "prompt_completed") return result({ action: "continue", ...position, mode: "check" });
  const attached = visitEvents.filter((event): event is Of<"session_attached"> => event.event === "session_attached").at(-1);
  return result({
    action: "continue",
    ...position,
    mode: "prompt",
    ...(attached ? { attached: { provider: attached.provider, sessionId: attached.sessionId, origin: attached.origin } } : {}),
  });
}
