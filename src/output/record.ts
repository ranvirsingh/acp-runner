import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type {
  NextDecision,
  ProviderId,
  RecordEvent,
  RunEndEvent,
  RunnerConfig,
  RunStartEvent,
  SessionContext,
  StepEndEvent,
  StepStartEvent,
  SwapEvent,
  SwapReason,
  ToolEvent,
  TransitionEvent,
  TransitionWhy,
} from "../types.js";
import { isScriptStep, tracesToFile, tracesToStdout } from "../types.js";
import { toolNameFromUpdate } from "./logs.js";
import { resolveModel, resolveProvider, resolveStepServers } from "../config/yaml.js";

export function createRunId(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const y = date.getUTCFullYear();
  const m = pad(date.getUTCMonth() + 1);
  const d = pad(date.getUTCDate());
  const h = pad(date.getUTCHours());
  const min = pad(date.getUTCMinutes());
  const s = pad(date.getUTCSeconds());
  const hex = randomBytes(3).toString("hex");
  return `${y}${m}${d}T${h}${min}${s}Z-${hex}`;
}

export function truncateFeedback(
  feedback?: string,
  maxBytes = 2000,
): { feedback: string | null; truncated?: boolean } {
  if (!feedback) return { feedback: null };
  const buf = Buffer.from(feedback, "utf8");
  if (buf.byteLength <= maxBytes) return { feedback };
  const sliced = buf.subarray(0, maxBytes).toString("utf8");
  return { feedback: sliced, truncated: true };
}

export class RunRecorder {
  readonly runId: string;
  readonly config: RunnerConfig;
  private readonly filePath: string | null = null;
  private fileDisabled = false;
  private readonly startTime: number;
  private stepsRunCount = 0;
  private swapsCount = 0;
  private stepAttempts: Record<string, number> = {};
  private activeStep: { stepId: string; attempt: number; startTime: number } | null = null;
  private toolNames = new Map<string, string>();
  private toolStartTimes = new Map<string, number>();
  private lastProvider: ProviderId;
  private lastModel?: string;
  private started = false;
  private ended = false;

  constructor(config: RunnerConfig, runId = createRunId()) {
    this.config = config;
    this.runId = runId;
    this.startTime = Date.now();
    const first = config.runbook.steps[0];
    this.lastProvider = resolveProvider(config, first);
    this.lastModel = resolveModel(config, first);

    if (tracesToFile(config.trace)) {
      const runnerDir = join(config.cwd, ".runner");
      try {
        mkdirSync(runnerDir, { recursive: true });
        this.filePath = join(runnerDir, `run-${this.runId}.jsonl`);
      } catch (error: any) {
        console.error(`[runner] warning: could not write run record (${error?.message ?? error})`);
        this.fileDisabled = true;
      }
    }
  }

  private emit(event: RecordEvent): void {
    const line = JSON.stringify(event);
    if (tracesToStdout(this.config.trace)) {
      console.log(line);
    }
    if (this.filePath && !this.fileDisabled) {
      try {
        appendFileSync(this.filePath, line + "\n", "utf8");
      } catch (error: any) {
        console.error(`[runner] warning: could not write run record (${error?.message ?? error})`);
        this.fileDisabled = true;
      }
    }
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const first = this.config.runbook.steps[0];
    const event: RunStartEvent = {
      ts: new Date().toISOString(),
      run: this.runId,
      ev: "run.start",
      v: 1,
      agent: this.config.runbook.name ?? null,
      cwd: this.config.cwd,
      yaml: this.config.yamlPath,
      provider: resolveProvider(this.config, first),
      model: resolveModel(this.config, first) ?? null,
      steps: this.config.runbook.steps.map((s) => s.id),
    };
    this.emit(event);
  }

  handleInspect(event: any): void {
    if (event?.type === "runner.event" && event.event?.type === "UPDATE") {
      const update = event.event.update;
      if (!update || typeof update !== "object") return;
      const kind = update.sessionUpdate;
      const id = typeof update.toolCallId === "string" ? update.toolCallId : "";
      const currentStepId = this.activeStep?.stepId ?? this.config.runbook.steps[0]?.id ?? "";

      if (kind === "tool_call") {
        const name = toolNameFromUpdate(update) ?? "tool";
        if (id) {
          this.toolNames.set(id, name);
          this.toolStartTimes.set(id, Date.now());
        }
        const toolEv: ToolEvent = {
          ts: new Date().toISOString(),
          run: this.runId,
          ev: "tool",
          name,
          status: "pending",
          step: currentStepId,
          ms: null,
        };
        this.emit(toolEv);
      } else if (kind === "tool_call_update") {
        const status = update.status;
        if (typeof status === "string") {
          const name = (id && this.toolNames.get(id)) || toolNameFromUpdate(update) || "tool";
          const start = id ? this.toolStartTimes.get(id) : undefined;
          const ms = start ? Date.now() - start : null;
          const toolEv: ToolEvent = {
            ts: new Date().toISOString(),
            run: this.runId,
            ev: "tool",
            name,
            status: status === "failed" ? "failed" : "completed",
            step: currentStepId,
            ms,
          };
          this.emit(toolEv);
        }
      }
    }
  }

  onStateChange(previous: string, current: string, context: SessionContext): void {
    if (!this.started) {
      this.start();
    }

    const currentStep = this.config.runbook.steps[context.stepIndex];

    if (
      (previous === "idle" && (current === "spawning" || current === "executingScript")) ||
      (previous === "choosingNext" &&
        (current === "spawning" || current === "inSession" || current === "executingScript")) ||
      (previous === "shuttingDown" && current === "spawning")
    ) {
      if (!this.activeStep && currentStep) {
        this.stepAttempts[currentStep.id] = (this.stepAttempts[currentStep.id] ?? 0) + 1;
        const attempt = this.stepAttempts[currentStep.id];
        this.activeStep = {
          stepId: currentStep.id,
          attempt,
          startTime: Date.now(),
        };
        this.stepsRunCount += 1;
        const stepStartEv: StepStartEvent = {
          ts: new Date().toISOString(),
          run: this.runId,
          ev: "step.start",
          step: currentStep.id,
          index: context.stepIndex,
          kind: isScriptStep(currentStep) ? "script" : "model",
          attempt,
          provider: resolveProvider(this.config, currentStep),
          model: resolveModel(this.config, currentStep) ?? null,
          servers: resolveStepServers(this.config, currentStep).map((s) => s.name),
        };
        this.emit(stepStartEv);
      }
    }

    if (current === "choosingNext" && this.activeStep) {
      const ms = Date.now() - this.activeStep.startTime;
      const outcome = context.lastError ? "failure" : (context.stepOutcome ?? "success");
      const feedback = context.failure?.output ?? context.lastError;
      const truncated = truncateFeedback(feedback);
      const stepEndEv: StepEndEvent = {
        ts: new Date().toISOString(),
        run: this.runId,
        ev: "step.end",
        step: this.activeStep.stepId,
        attempt: this.activeStep.attempt,
        outcome,
        ms,
        exit: context.stepExitCode ?? null,
        feedback: truncated.feedback,
        ...(truncated.truncated ? { feedback_truncated: true } : {}),
      };
      this.emit(stepEndEv);
      this.activeStep = null;
    }

    if (previous === "shuttingDown" && current === "spawning") {
      this.swapsCount += 1;
      let reason: SwapReason = "provider";
      if (context.lastError) reason = "spawn_error";
      else if (context.provider !== this.lastProvider) reason = "provider";
      else if (context.model !== this.lastModel) reason = "model";
      else reason = "servers";

      const swapEv: SwapEvent = {
        ts: new Date().toISOString(),
        run: this.runId,
        ev: "swap",
        from_provider: this.lastProvider,
        to_provider: context.provider,
        from_model: this.lastModel ?? null,
        to_model: context.model ?? null,
        reason,
      };
      this.emit(swapEv);
      this.lastProvider = context.provider;
      this.lastModel = context.model;
    }

    let decision: NextDecision | null = null;
    let target: string | null = null;
    let why: TransitionWhy = null;

    if (previous === "choosingNext") {
      decision = context.decision ?? context.shutdownIntent ?? (context.why ? "stay" : null);
      target = context.decisionTarget ?? null;
      why = context.why ?? null;
    }

    const transEv: TransitionEvent = {
      ts: new Date().toISOString(),
      run: this.runId,
      ev: "transition",
      from: previous,
      to: current,
      decision,
      target,
      why,
    };
    this.emit(transEv);
  }

  end(outcome: "finished" | "failed", error?: string | null): void {
    if (this.ended) return;
    this.ended = true;

    if (this.activeStep) {
      const ms = Date.now() - this.activeStep.startTime;
      const stepEndEv: StepEndEvent = {
        ts: new Date().toISOString(),
        run: this.runId,
        ev: "step.end",
        step: this.activeStep.stepId,
        attempt: this.activeStep.attempt,
        outcome: "failure",
        ms,
        exit: null,
        feedback: error ?? null,
      };
      this.emit(stepEndEv);
      this.activeStep = null;
    }

    const endEv: RunEndEvent = {
      ts: new Date().toISOString(),
      run: this.runId,
      ev: "run.end",
      outcome,
      ms: Date.now() - this.startTime,
      steps_run: this.stepsRunCount,
      swaps: this.swapsCount,
      error: error ?? null,
    };
    this.emit(endEv);
  }
}
