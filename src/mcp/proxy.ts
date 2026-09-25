import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ToolListChangedNotificationSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { ResolvedMcpServer } from "../types.js";
import { RUNNER_VERSION } from "../version.js";
import { qualifyToolName, splitToolName, toolAllowed, visibleTools, type StepScope } from "./scope.js";

export const RESOURCE_LIMIT_BYTES = 256 * 1024;

const RUNNER_ENTRY_NAME = "runner";

function textOf(content: unknown): string | null {
  if (!content || typeof content !== "object") return null;
  const record = content as { type?: unknown; text?: unknown };
  if (record.type !== "text" || typeof record.text !== "string") return null;
  return record.text;
}

export class McpProxy {
  private readonly declared = new Map<string, ResolvedMcpServer>();
  private readonly clients = new Map<string, Client>();
  private readonly catalogue = new Map<string, Tool[]>();
  private readonly endpoints = new Set<Server>();
  private scope: StepScope = {};
  private stepId = "";
  private httpServer: HttpServer | null = null;
  private readonly log: (message: string) => void;

  constructor(servers: ResolvedMcpServer[], log: (message: string) => void = () => {}) {
    for (const server of servers) this.declared.set(server.name, server);
    this.log = log;
  }

  get entryName(): string {
    return RUNNER_ENTRY_NAME;
  }

  get serverNames(): string[] {
    return [...this.declared.keys()];
  }

  async setScope(scope: StepScope, stepId: string): Promise<void> {
    this.scope = scope;
    this.stepId = stepId;
    for (const name of Object.keys(scope)) {
      await this.ensureClient(name).catch((error: unknown) => {
        this.log(`server ${name} unavailable: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    await this.broadcastToolsChanged();
  }

  private async ensureClient(name: string): Promise<Client> {
    const existing = this.clients.get(name);
    if (existing) return existing;
    const spec = this.declared.get(name);
    if (!spec) throw new Error(`unknown server "${name}"`);

    const client = new Client({ name: "acp-runner-proxy", version: RUNNER_VERSION });
    await client.connect(transportFor(spec));
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      void this.refreshTools(name);
    });
    client.onclose = () => {
      this.clients.delete(name);
      this.catalogue.delete(name);
      this.log(`server ${name} disconnected`);
      void this.broadcastToolsChanged();
    };
    this.clients.set(name, client);
    await this.refreshTools(name);
    return client;
  }

  private async refreshTools(name: string): Promise<void> {
    const client = this.clients.get(name);
    if (!client) return;
    try {
      const listed = await client.listTools();
      this.catalogue.set(name, listed.tools);
    } catch {
      this.catalogue.set(name, []);
    }
  }

  listTools(): Tool[] {
    return visibleTools(this.catalogue, this.scope);
  }

  private async broadcastToolsChanged(): Promise<void> {
    for (const endpoint of this.endpoints) {
      try {
        await endpoint.sendToolListChanged();
      } catch {}
    }
  }

  async callTool(
    qualified: string,
    args: Record<string, unknown> | undefined,
  ): Promise<{ content: unknown; isError?: boolean }> {
    const split = splitToolName(qualified, this.serverNames);
    if (!split || !toolAllowed(this.scope, split.server, split.tool)) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `tool "${qualified}" is not in scope for step "${this.stepId}"`,
          },
        ],
      };
    }
    const client = this.clients.get(split.server);
    if (!client) {
      return {
        isError: true,
        content: [{ type: "text", text: `server "${split.server}" is not connected` }],
      };
    }
    const result = await client.callTool({ name: split.tool, arguments: args ?? {} });
    return result as { content: unknown; isError?: boolean };
  }

  async readResource(server: string, uri: string): Promise<string> {
    const client = await this.ensureClient(server);
    const result = await client.readResource({ uri });
    const contents = result.contents ?? [];
    if (contents.length === 0) throw new Error(`resource ${uri} on ${server} is empty`);
    const parts: string[] = [];
    for (const item of contents) {
      const text = (item as { text?: unknown }).text;
      if (typeof text !== "string") {
        throw new Error(`resource ${uri} on ${server} returned a blob, not text`);
      }
      parts.push(text);
    }
    const text = parts.join("\n");
    if (Buffer.byteLength(text, "utf8") > RESOURCE_LIMIT_BYTES) {
      throw new Error(`resource ${uri} on ${server} is over 256 KiB`);
    }
    return text;
  }

  async getPrompt(
    server: string,
    name: string,
    args?: Record<string, string>,
  ): Promise<string> {
    const client = await this.ensureClient(server);
    const result = await client.getPrompt({ name, ...(args ? { arguments: args } : {}) });
    const parts: string[] = [];
    for (const message of result.messages ?? []) {
      const text = textOf(message.content);
      if (text === null) {
        throw new Error(`prompt ${name} on ${server} returned non-text content`);
      }
      parts.push(text);
    }
    return parts.join("\n\n");
  }

  private buildEndpoint(): Server {
    const endpoint = new Server(
      { name: "acp-runner", version: RUNNER_VERSION },
      { capabilities: { tools: { listChanged: true } } },
    );
    endpoint.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: this.listTools() }));
    endpoint.setRequestHandler(CallToolRequestSchema, async (request) => {
      const result = await this.callTool(
        request.params.name,
        request.params.arguments as Record<string, unknown> | undefined,
      );
      return result as never;
    });
    endpoint.onclose = () => {
      this.endpoints.delete(endpoint);
    };
    return endpoint;
  }

  async connectEndpoint(transport: Transport): Promise<Server> {
    const endpoint = this.buildEndpoint();
    this.endpoints.add(endpoint);
    await endpoint.connect(transport);
    return endpoint;
  }

  async listenHttp(): Promise<string> {
    if (this.httpServer) {
      const address = this.httpServer.address();
      if (address && typeof address === "object") return `http://127.0.0.1:${address.port}/mcp`;
    }
    const transports = new Map<string, StreamableHTTPServerTransport>();
    const server = createHttpServer((req, res) => {
      const sessionId = req.headers["mcp-session-id"];
      const existing = typeof sessionId === "string" ? transports.get(sessionId) : undefined;
      if (existing) {
        void existing.handleRequest(req, res);
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(400).end();
        return;
      }
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports.set(id, transport);
        },
        onsessionclosed: (id) => {
          transports.delete(id);
        },
      });
      void this.connectEndpoint(transport).then(() => transport.handleRequest(req, res));
    });
    this.httpServer = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address !== "object") throw new Error("proxy http server has no port");
    return `http://127.0.0.1:${address.port}/mcp`;
  }

  async close(): Promise<void> {
    for (const endpoint of [...this.endpoints]) {
      try {
        await endpoint.close();
      } catch {}
    }
    this.endpoints.clear();
    for (const client of this.clients.values()) {
      try {
        await client.close();
      } catch {}
    }
    this.clients.clear();
    this.catalogue.clear();
    if (this.httpServer) {
      await new Promise<void>((resolve) => this.httpServer?.close(() => resolve()));
      this.httpServer = null;
    }
  }
}

function transportFor(spec: ResolvedMcpServer): Transport {
  if (spec.type === "stdio") {
    return new StdioClientTransport({
      command: spec.command,
      args: spec.args,
      env: {
        ...(process.env as Record<string, string>),
        ...Object.fromEntries(spec.env.map((item) => [item.name, item.value])),
      },
    });
  }
  const headers = Object.fromEntries(spec.headers.map((item) => [item.name, item.value]));
  if (spec.type === "sse") {
    return new SSEClientTransport(new URL(spec.url), { requestInit: { headers } });
  }
  return new StreamableHTTPClientTransport(new URL(spec.url), { requestInit: { headers } });
}

export { qualifyToolName };
