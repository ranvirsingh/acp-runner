import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type {
  ClientConnection,
  NewSessionRequest,
  NewSessionResponse,
  SessionConfigSelectOption,
  SessionConfigSelectOptions,
} from "@agentclientprotocol/sdk";
import {
  createAcpLogger,
  formatReply,
  isStderrNoise,
  splitLines,
  textFromContent,
  toolNameFromUpdate,
} from "../output/logs.js";
import { RUNNER_VERSION } from "../version.js";
import { needsNewBody } from "../config/yaml.js";
import type { ProviderSpec } from "./providers.js";
import type { PermissionPending, ProviderId, ResolvedMcpServer } from "../types.js";

export interface PermissionOption {
  optionId: string;
  kind?: string;
  name?: string;
}

export interface McpProxyHandle {
  entryName: string;
  listenHttp(): Promise<string>;
}

export type SessionState = "connecting" | "ready" | "streaming" | "closed";

const CANCEL_GRACE_MS = 1000;

export function toAcpMcpServer(server: ResolvedMcpServer): acp.McpServer {
  if (server.type === "stdio") {
    return {
      name: server.name,
      command: server.command,
      args: server.args,
      env: server.env,
    };
  }
  return { type: server.type, name: server.name, url: server.url, headers: server.headers };
}

export interface SessionOptions {
  cwd: string;
  model?: string;
  allowModelFallback?: boolean;
  mcpServers?: ResolvedMcpServer[];
  proxy?: McpProxyHandle;
  env?: Record<string, string>;
  quiet?: boolean;
  signal?: AbortSignal;
  confirm?: boolean;
  promptPermission?: (pending: PermissionPending) => Promise<string> | string;
  onUpdate?: (chunk: string, update: Record<string, unknown>) => void;
  onToolCall?: (toolCallId: string, name: string) => void;
  onToolCallUpdate?: (toolCallId: string, status: string, name?: string) => void;
  onPermissionRequested?: (pending: PermissionPending) => void;
  onPermissionResolved?: (optionId: string) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

export function pickAllowOption(options: PermissionOption[]): string | undefined {
  const allow = options.find(
    (option) =>
      option.kind === "allow_once" ||
      option.kind === "allow_always" ||
      option.optionId.toLowerCase().includes("allow"),
  );
  return allow?.optionId ?? options[0]?.optionId;
}

export function pickRejectOption(options: PermissionOption[]): string | undefined {
  const reject = options.find(
    (option) =>
      option.kind === "reject_once" ||
      option.kind === "reject_always" ||
      option.optionId.toLowerCase().includes("reject") ||
      option.optionId.toLowerCase().includes("deny"),
  );
  return reject?.optionId ?? options[0]?.optionId;
}

export function extractText(update: Record<string, unknown>): string {
  if (update.sessionUpdate !== "agent_message_chunk") return "";
  return textFromContent(update.content);
}

const QUIET_UPDATES = new Set([
  "usage_update",
  "available_commands_update",
  "session_info_update",
]);

export function formatUpdate(
  update: Record<string, unknown>,
  toolNames: Map<string, string>,
): string | null {
  const kind = String(update.sessionUpdate ?? "update");
  if (QUIET_UPDATES.has(kind)) return null;
  if (kind === "agent_message_chunk") {
    return "message";
  }
  if (kind === "agent_thought_chunk") {
    return "thought";
  }
  if (kind === "tool_call" || kind === "tool_call_update") {
    const id = typeof update.toolCallId === "string" ? update.toolCallId : "";
    const named = toolNameFromUpdate(update);
    if (named && id) toolNames.set(id, named);
    if (kind === "tool_call_update" && typeof update.status !== "string") return null;
    const name = (id && toolNames.get(id)) || named || "tool";
    const status = typeof update.status === "string" ? ` ${update.status}` : "";
    return `tool ${name}${status}`;
  }
  return kind;
}

export function flattenSelectValues(
  options: SessionConfigSelectOptions | undefined,
): SessionConfigSelectOption[] {
  if (!options) return [];
  return options.flatMap((item) => {
    if ("options" in item && Array.isArray(item.options)) return item.options;
    if ("value" in item) return [item];
    return [];
  });
}

async function applyModel(
  agent: ClientConnection["agent"],
  session: NewSessionResponse,
  model: string,
  log: (message: string) => void,
  allowFallback = false,
): Promise<string | undefined> {
  const modelOption = session.configOptions?.find((option) => {
    const category = String(option.category ?? option.id ?? option.name).toLowerCase();
    return category.includes("model");
  });
  if (!modelOption || modelOption.type !== "select") {
    if (allowFallback) return undefined;
    throw new Error(`cannot set model "${model}": provider exposes no model configuration option`);
  }
  const match = flattenSelectValues(modelOption.options).find(
    (option) => option.value === model || option.name === model,
  );
  const value = match?.value ?? model;
  try {
    await agent.request(acp.methods.agent.session.setConfigOption, {
      sessionId: session.sessionId,
      configId: modelOption.id,
      value,
    });
    log(`set model ${value}`);
    return value;
  } catch (error) {
    if (allowFallback) {
      log(`model option skipped: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
    throw new Error(`cannot set model "${model}": ${error instanceof Error ? error.message : String(error)}`);
  }
}

function extractInitialModel(session: NewSessionResponse): string | undefined {
  const modelOption = session.configOptions?.find((option) => {
    const category = String(option.category ?? option.id ?? option.name).toLowerCase();
    return category.includes("model");
  });
  if (!modelOption || modelOption.type !== "select") return undefined;
  return (modelOption as any).currentValue ?? undefined;
}

async function applyPermissionMode(
  agent: ClientConnection["agent"],
  session: NewSessionResponse,
  log: (message: string) => void,
): Promise<void> {
  const modeOption = session.configOptions?.find((option) => {
    const category = String(option.category ?? option.id ?? option.name).toLowerCase();
    return category.includes("mode");
  });
  if (!modeOption || modeOption.type !== "select") return;
  const match = flattenSelectValues(modeOption.options).find(
    (option) => option.value === "default",
  );
  if (!match) return;
  try {
    await agent.request(acp.methods.agent.session.setConfigOption, {
      sessionId: session.sessionId,
      configId: modeOption.id,
      value: "default",
    });
    log("set mode default");
  } catch (error) {
    log(`mode option skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function stopChild(

  child: ChildProcessWithoutNullStreams | null,
  connection: { close?: () => void; closed?: Promise<unknown> } | null,
): Promise<void> {
  const spawned = Boolean(
    (child as (ChildProcessWithoutNullStreams & { didSpawn?: boolean }) | null)?.didSpawn,
  );
  if (spawned && child?.stdin && !child.stdin.destroyed) {
    try {
      child.stdin.end();
    } catch {}
  }

  if (spawned && child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    await Promise.race([exited, sleep(4000)]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await Promise.race([once(child, "exit"), sleep(2000)]);
    }
  }

  try {
    connection?.close?.();
  } catch {}
  if (connection?.closed) {
    await Promise.race([connection.closed, sleep(1000)]);
  }
}

export class AcpSession {
  private _state: SessionState = "connecting";
  private child: ChildProcessWithoutNullStreams | null = null;
  private connection: ClientConnection | null = null;
  private _sessionId: string | null = null;
  private _registeredMcpServers: acp.McpServer[] = [];
  private _effectiveModel?: string;
  private turnText = "";
  private readonly toolNames = new Map<string, string>();
  private readonly acpLog: (message: string) => void;
  private closing = false;

  constructor(
    public readonly provider: ProviderSpec,
    public readonly options: SessionOptions,
  ) {
    this.acpLog = createAcpLogger(provider.id, Boolean(options.quiet));
  }

  get state(): SessionState {
    return this._state;
  }

  get sessionId(): string | null {
    return this._sessionId;
  }

  get effectiveModel(): string | undefined {
    return this._effectiveModel;
  }

  get registeredMcpServers(): acp.McpServer[] {
    return this._registeredMcpServers;
  }

  static async spawn(provider: ProviderSpec, options: SessionOptions): Promise<AcpSession> {
    const session = new AcpSession(provider, options);
    await session.init();
    return session;
  }

  private async init(): Promise<void> {
    const { command, args } = this.provider;
    this.acpLog(`spawn ${command} ${args.join(" ")}`);

    const env = { ...process.env };
    delete env.npm_config_package;
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...env, ...this.options.env },
    });
    this.child = child;

    if (this.options.signal) {
      if (this.options.signal.aborted) {
        await this.close();
        throw new Error("Session aborted");
      }
      this.options.signal.addEventListener("abort", () => {
        void this.abort();
      });
    }

    let didSpawn = false;
    const spawned = new Promise<void>((resolve, reject) => {
      child.once("spawn", () => {
        didSpawn = true;
        resolve();
      });
      child.once("error", reject);
    });

    let stderrBuffer = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      const { lines, rest } = splitLines(stderrBuffer + chunk);
      stderrBuffer = rest;
      for (const line of lines) {
        if (!isStderrNoise(line)) this.acpLog(`stderr ${line}`);
      }
    });

    let exitReason: string | null = null;
    child.once("exit", (code, signal) => {
      exitReason = `agent exited (${code ?? signal ?? "unknown"})`;
      const trailing = stderrBuffer.trim();
      stderrBuffer = "";
      if (trailing && !isStderrNoise(trailing)) this.acpLog(`stderr ${trailing}`);
      if (!this.closing) {
        this.acpLog(exitReason);
        this._state = "closed";
      }
    });

    await Promise.race([
      spawned,
      new Promise<void>((_, reject) => {
        child.once("exit", (code, signal) => {
          reject(new Error(`agent exited before spawn (${code ?? signal ?? "unknown"})`));
        });
      }),
    ]);
    (child as ChildProcessWithoutNullStreams & { didSpawn?: boolean }).didSpawn = didSpawn;

    try {
      const stdin = child.stdin;
      const stdout = child.stdout;
      if (!stdin || !stdout) {
        throw new Error("ACP child missing stdio pipes");
      }

      const stream = acp.ndJsonStream(
        Writable.toWeb(stdin),
        Readable.toWeb(stdout) as ReadableStream<Uint8Array>,
      );

      const app = acp
        .client({ name: "acp-runner" })
        .onNotification(acp.methods.client.session.update, (ctx) => {
          this.handleUpdate(ctx.params);
        })
        .onRequest(acp.methods.client.session.requestPermission, (ctx) =>
          this.handlePermission(ctx.params),
        )
        .onRequest(acp.methods.client.fs.readTextFile, async (ctx) => {
          const content = await readFile(ctx.params.path, "utf8");
          return { content };
        })
        .onRequest(acp.methods.client.fs.writeTextFile, async (ctx) => {
          if (this.options.confirm) {
            const options = [
              { optionId: "allow", name: `Write ${ctx.params.path}`, kind: "allow_once" },
              { optionId: "reject", name: `Reject write to ${ctx.params.path}`, kind: "reject_once" },
            ];
            let optionId = pickAllowOption(options) ?? "allow";
            if (this.options.promptPermission) {
              optionId = await this.options.promptPermission({
                toolCallId: "fs_write",
                options,
              });
            } else {
              optionId = pickRejectOption(options) ?? "reject";
            }
            if (optionId !== "allow" && !optionId.includes("allow")) {
              this.acpLog(`permission rejected Write ${ctx.params.path}`);
              throw new Error(`Permission denied: write to ${ctx.params.path}`);
            }
            this.acpLog(`permission resolved Write ${ctx.params.path}`);
          }
          await writeFile(ctx.params.path, ctx.params.content, "utf8");
          return {};
        });

      const live = app.connect(stream);
      this.connection = live;

      const initialized = await live.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
        },
        clientInfo: { name: "acp-runner", version: RUNNER_VERSION },
      });

      this.acpLog(`initialized protocol=${String(initialized.protocolVersion ?? "")}`);

      const mcpServers = await this.buildMcpEntries(initialized.agentCapabilities?.mcpCapabilities);
      this._registeredMcpServers = mcpServers;

      const newSession: NewSessionRequest = { cwd: this.options.cwd, mcpServers };
      let session: NewSessionResponse;
      try {
        session = await live.agent.request(acp.methods.agent.session.new, newSession);
      } catch (error) {
        const authMethods = initialized.authMethods ?? [];
        if (!(error instanceof acp.RequestError) || error.code !== -32000 || authMethods.length === 0) throw error;
        const preferred = authMethods.find((m) => m.id === "gemini-api-key") ?? authMethods[0];
        this.acpLog(`authenticate ${preferred.id}`);
        await live.agent.request(acp.methods.agent.authenticate, { methodId: preferred.id });
        session = await live.agent.request(acp.methods.agent.session.new, newSession);
      }
      this._sessionId = session.sessionId;
      this.acpLog(`session ${session.sessionId} (${mcpServers.length} mcp)`);

      if (this.options.model) {
        this._effectiveModel = await applyModel(
          live.agent,
          session,
          this.options.model,
          this.acpLog,
          this.options.allowModelFallback,
        );
      } else {
        this._effectiveModel = extractInitialModel(session);
      }
      if (this.options.confirm) {
        await applyPermissionMode(live.agent, session, this.acpLog);
      }

      this._state = "ready";

    } catch (error) {
      if (child.exitCode === null && child.signalCode === null) {
        await Promise.race([once(child, "exit"), sleep(50)]);
      }
      const reason = exitReason;
      await this.close();
      if (reason) {
        throw new Error(reason);
      }
      throw error;
    }
  }

  private async buildMcpEntries(
    capabilities: acp.McpCapabilities | undefined,
  ): Promise<acp.McpServer[]> {
    const proxy = this.options.proxy;
    if (!proxy) return (this.options.mcpServers ?? []).map(toAcpMcpServer);
    if (!capabilities?.http) {
      throw new Error(
        `${this.provider.id}: cannot host the runner MCP proxy: the agent reports no http MCP transport`,
      );
    }
    return [{ type: "http", name: proxy.entryName, url: await proxy.listenHttp(), headers: [] }];
  }

  private handleUpdate(params: { update?: unknown }): void {
    const update = asRecord(params.update) ?? {};
    const line = formatUpdate(update, this.toolNames);
    if (line) this.acpLog(line);

    const chunk = extractText(update);
    if (chunk) this.turnText += chunk;

    const kind = update.sessionUpdate;
    const toolCallId = typeof update.toolCallId === "string" ? update.toolCallId : "";
    if (kind === "tool_call") {
      const name = toolNameFromUpdate(update) ?? "tool";
      this.options.onToolCall?.(toolCallId, name);
    } else if (kind === "tool_call_update") {
      const status = typeof update.status === "string" ? update.status : "";
      const name = (toolCallId && this.toolNames.get(toolCallId)) || toolNameFromUpdate(update);
      this.options.onToolCallUpdate?.(toolCallId, status, name);
    }

    this.options.onUpdate?.(chunk, update);
  }

  private async handlePermission(params: {
    options?: Array<{ optionId: string; kind?: string; name?: string }>;
    toolCall?: { toolCallId?: string };
  }): Promise<acp.RequestPermissionResponse> {
    const options = params.options ?? [];
    const pending: PermissionPending = {
      toolCallId: params.toolCall?.toolCallId,
      options,
    };
    this.options.onPermissionRequested?.(pending);

    let optionId = pickAllowOption(options) ?? "allow";
    if (this.options.confirm) {
      if (this.options.promptPermission) {
        optionId = await this.options.promptPermission(pending);
      } else {
        optionId = pickRejectOption(options) ?? "reject";
      }
    }

    this.acpLog(`permission ${this.options.confirm ? "resolved" : "auto-approved"} ${optionId}`);
    this.options.onPermissionResolved?.(optionId);

    return { outcome: { outcome: "selected", optionId } };
  }

  async prompt(prompt: acp.ContentBlock[]): Promise<string> {
    if (!this.connection || !this._sessionId) {
      throw new Error("Session is not ready or has closed");
    }
    this._state = "streaming";
    this.turnText = "";
    this.acpLog(`prompt (${prompt.length} blocks)`);

    const response = await this.connection.agent.request(acp.methods.agent.session.prompt, {
      sessionId: this._sessionId,
      prompt,
    });

    const summary = formatReply(this.turnText);
    if (summary) {
      this.acpLog(`reply: ${summary}`);
    }

    const result = this.turnText;
    this._state = "ready";

    if (response?.stopReason === "cancelled") {
      throw new Error("turn cancelled");
    }

    return result;
  }

  async abort(): Promise<void> {
    if (this._state === "streaming") {
      await this.cancel();
      await sleep(CANCEL_GRACE_MS);
    }
    await this.close();
  }

  async cancel(): Promise<void> {
    if (this._state !== "streaming" || !this.connection || !this._sessionId) return;
    this.acpLog("cancel");
    await this.connection.agent.notify(acp.methods.agent.session.cancel, {
      sessionId: this._sessionId,
    });
  }

  needsSwap(targetProvider: ProviderId, targetModel?: string): boolean {
    return needsNewBody(
      { provider: this.provider.id, model: this.options.model },
      { provider: targetProvider, model: targetModel },
    );
  }

  async close(): Promise<void> {
    this.closing = true;
    this._state = "closed";
    const child = this.child;
    const connection = this.connection;
    this.child = null;
    this.connection = null;
    this._sessionId = null;
    await stopChild(child, connection);
  }
}
