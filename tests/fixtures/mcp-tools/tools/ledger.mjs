import { appendFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";

const marker = process.env.LEDGER_MARKER;
const release = process.env.LEDGER_RELEASE;
const schema = { type: "object", properties: {} };

const TOOLS = [
  { name: "act", description: "Changes something outside.", inputSchema: schema },
  { name: "peek", description: "Reads only.", inputSchema: schema, annotations: { readOnlyHint: true } },
  { name: "label", description: "Safe to repeat.", inputSchema: schema, annotations: { idempotentHint: true } },
  { name: "vanish", description: "Acts, then its reply is lost.", inputSchema: schema },
  { name: "slow", description: "Acts once the release file exists.", inputSchema: schema },
];

function mark(name) {
  if (marker) appendFileSync(marker, `${name}\n`);
}

async function handle(method, params) {
  if (method === "initialize") {
    return {
      protocolVersion: params?.protocolVersion ?? "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "mcp-tools-ledger", version: "0.1.0" },
    };
  }
  if (method === "tools/list") return { tools: TOOLS };
  if (method === "tools/call") {
    const name = params?.name;
    if (name === "slow") {
      while (!release || !existsSync(release)) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    mark(name);
    if (name === "vanish") process.exit(0);
    return { content: [{ type: "text", text: `${name} done` }] };
  }
  throw new Error(`unknown method ${method}`);
}

function reply(payload) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...payload })}\n`);
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id === undefined) return;
  handle(message.method, message.params).then(
    (result) => reply({ id: message.id, result }),
    (error) => reply({ id: message.id, error: { code: -32601, message: error.message } }),
  );
});
