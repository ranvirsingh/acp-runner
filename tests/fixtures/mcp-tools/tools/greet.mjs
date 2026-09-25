import { createInterface } from "node:readline";

const TOOLS = [
  {
    name: "greet",
    description: "Greet someone by name.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "shout",
    description: "Greet someone loudly. Declared so a step can deny it.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
];

const HOUSE_STYLE = "Greetings are one line and never end in an exclamation mark.";

function greet(toolName, args) {
  const name = args?.name;
  if (typeof name !== "string" || name.trim() === "") {
    return { content: [{ type: "text", text: `${toolName} needs a name` }], isError: true };
  }
  const text = toolName === "shout" ? `HELLO ${name.trim().toUpperCase()}` : `Hello ${name.trim()}`;
  return { content: [{ type: "text", text }] };
}

function handle(method, params) {
  if (method === "initialize") {
    return {
      protocolVersion: params?.protocolVersion ?? "2024-11-05",
      capabilities: { tools: {}, resources: {}, prompts: {} },
      serverInfo: { name: "mcp-tools-greet", version: "0.1.0" },
    };
  }
  if (method === "tools/list") {
    return { tools: TOOLS };
  }
  if (method === "tools/call") {
    const tool = TOOLS.find((entry) => entry.name === params?.name);
    if (!tool) {
      throw new Error(`unknown tool ${params?.name}`);
    }
    return greet(tool.name, params?.arguments);
  }
  if (method === "resources/list") {
    return { resources: [{ uri: "mem://house-style", name: "house-style" }] };
  }
  if (method === "resources/read") {
    if (params?.uri !== "mem://house-style") {
      throw new Error(`unknown resource ${params?.uri}`);
    }
    return { contents: [{ uri: params.uri, mimeType: "text/plain", text: HOUSE_STYLE }] };
  }
  if (method === "prompts/list") {
    return { prompts: [{ name: "critique", arguments: [{ name: "subject" }] }] };
  }
  if (method === "prompts/get") {
    if (params?.name !== "critique") {
      throw new Error(`unknown prompt ${params?.name}`);
    }
    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Critique the ${params?.arguments?.subject} you produced. One line only.`,
          },
        },
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
