import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { StepFailure } from "../types.js";

const FAILURE_BLOCK_BYTES = 16384;

function headerLabel(value: string): string {
  const text = value.replace(/[\r\n]/g, " ");
  const bytes = Buffer.from(text);
  if (bytes.length <= 512) return text;
  let end = 480;
  while ((bytes[end] & 0xc0) === 0x80) end -= 1;
  return `${bytes.subarray(0, end).toString("utf8")} [truncated]`;
}

function formatFailure(failure: StepFailure): string {
  const header = [
    "[Runner failure]",
    `Step: ${headerLabel(failure.stepId)}`,
    `Kind: ${failure.kind}`,
    `Source: ${headerLabel(failure.source)}`,
    ...(failure.exitCode === null ? [] : [`Exit code: ${failure.exitCode}`]),
  ].join("\n") + "\n\n";
  const output = Buffer.from(failure.output);
  const available = FAILURE_BLOCK_BYTES - Buffer.byteLength(header);
  if (output.length <= available) return header + failure.output;
  const notice = "[Output truncated; showing tail]\n";
  let start = output.length - (available - Buffer.byteLength(notice));
  while ((output[start] & 0xc0) === 0x80) start += 1;
  return header + notice + output.subarray(start).toString("utf8");
}

export function buildPrompt(task: string, failure?: StepFailure): ContentBlock[] {
  const prompt: ContentBlock[] = [{ type: "text", text: task }];
  if (failure) {
    prompt.push({ type: "text", text: formatFailure(failure) });
  }
  return prompt;
}
