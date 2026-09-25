import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const issues = JSON.parse(readFileSync(new URL("./issues.json", import.meta.url), "utf8"));
const style = "Use plain language and a short opening summary. Include exactly these sections: ## Features, ## Fixes, ## Upgrade notes. Cite issue IDs in their matching sections. If a section has no issues, write None. Explain breaking changes and what the reader must do.";
const tools = [{
  name: "list_issues",
  description: "List sample Taskboard issues for a release, including unfinished work. Keep only shipped issues for release notes.",
  inputSchema: {
    type: "object",
    properties: { release: { type: "string" } },
    required: ["release"],
    additionalProperties: false,
  },
}];

function handle(method, params) {
  if (method === "initialize") {
    return {
      protocolVersion: params?.protocolVersion ?? "2024-11-05",
      capabilities: { tools: {}, resources: {}, prompts: {} },
      serverInfo: { name: "taskboard-release", version: "0.1.0" },
    };
  }
  if (method === "ping") return {};
  if (method === "tools/list") return { tools };
  if (method === "tools/call" && params?.name === "list_issues") {
    const selected = issues.filter((issue) => issue.release === params.arguments?.release);
    if (!selected.length) {
      return { isError: true, content: [{ type: "text", text: "Unknown release. Try 1.2.0 or 1.1.0." }] };
    }
    return { content: [{ type: "text", text: JSON.stringify(selected, null, 2) }] };
  }
  if (method === "resources/list") {
    return { resources: [{ uri: "mem://release-style", name: "release-style", mimeType: "text/plain" }] };
  }
  if (method === "resources/read" && params?.uri === "mem://release-style") {
    return { contents: [{ uri: params.uri, mimeType: "text/plain", text: style }] };
  }
  if (method === "prompts/list") {
    return { prompts: [{ name: "review_release", arguments: [{ name: "release", required: true }] }] };
  }
  if (method === "prompts/get" && params?.name === "review_release") {
    return { messages: [{ role: "user", content: { type: "text", text:
      `Review release-notes.md for Taskboard ${params.arguments?.release?.trim()}. Read issues.json as the source of truth. Check every shipped issue is covered in the right section, unfinished work is excluded, and limitations and upgrade actions are accurate. ${style} Fix release-notes.md directly, then briefly report what you corrected. Do not edit issues.json, inputs, helper scripts, MCP data, prompts or runbooks.`,
    } }] };
  }
  throw new Error(`Unsupported request: ${method}`);
}

createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id === undefined) return;
  let response;
  try {
    response = { result: handle(message.method, message.params) };
  } catch (error) {
    response = { error: { code: -32601, message: error.message } };
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, ...response })}\n`);
});
