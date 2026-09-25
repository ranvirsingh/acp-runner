import { createInterface } from "node:readline";

const RESOURCES = {
  "mem://schema": { type: "text", text: "id integer" },
  "mem://blob": { type: "blob", blob: Buffer.from("binary").toString("base64") },
  "mem://huge": { type: "text", text: "x".repeat(300 * 1024) },
};

let clientVersion = "";

function handle(method, params) {
  if (method === "initialize") {
    clientVersion = params?.clientInfo?.version ?? "";
    return {
      protocolVersion: params?.protocolVersion ?? "2024-11-05",
      capabilities: { tools: {}, resources: {}, prompts: {} },
      serverInfo: { name: "mcp-catalogue", version: "0.1.0" },
    };
  }
  if (method === "tools/list") return { tools: [] };
  if (method === "resources/list") {
    return { resources: Object.keys(RESOURCES).map((uri) => ({ uri, name: uri })) };
  }
  if (method === "resources/read" && params?.uri === "mem://client-version") {
    return { contents: [{ uri: params.uri, mimeType: "text/plain", text: clientVersion }] };
  }
  if (method === "resources/read") {
    const found = RESOURCES[params?.uri];
    if (!found) throw new Error(`unknown resource ${params?.uri}`);
    if (found.type === "blob") {
      return { contents: [{ uri: params.uri, mimeType: "application/octet-stream", blob: found.blob }] };
    }
    return { contents: [{ uri: params.uri, mimeType: "text/plain", text: found.text }] };
  }
  if (method === "prompts/list") {
    return { prompts: [{ name: "review", arguments: [{ name: "service" }] }] };
  }
  if (method === "prompts/get") {
    if (params?.name === "image") {
      return {
        messages: [
          { role: "user", content: { type: "image", data: "AAA", mimeType: "image/png" } },
        ],
      };
    }
    return {
      messages: [
        { role: "user", content: { type: "text", text: `review ${params?.arguments?.service}` } },
        { role: "user", content: { type: "text", text: "be brief" } },
      ],
    };
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
  try {
    reply({ id: message.id, result: handle(message.method, message.params) });
  } catch (error) {
    reply({ id: message.id, error: { code: -32601, message: error.message } });
  }
});
