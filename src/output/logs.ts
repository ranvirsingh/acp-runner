const TAG_WIDTH = 8;

function nested(name: string, message: string): string {
  return `  ${`[${name}]`.padEnd(TAG_WIDTH)} ${message}`;
}

export function stepLog(step: string, provider: string): void {
  console.log(`[step] ${step} (${provider})`);
}

export function stateLog(from: string, to: string): void {
  console.log(nested("state", `${from} → ${to}`));
}

export function createAcpLogger(provider: string, quiet = false): (message: string) => void {
  let previous: string | null = null;
  return (message) => {
    if (quiet || message === previous) return;
    previous = message;
    console.log(nested(provider, message));
  };
}


export function splitLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split("\n");
  const rest = parts.pop() ?? "";
  return {
    lines: parts.map((line) => line.trim()).filter((line) => line.length > 0),
    rest,
  };
}

export function toolNameFromUpdate(update: Record<string, unknown>): string | undefined {
  if (typeof update.name === "string" && update.name.length > 0) {
    return update.name;
  }
  const meta = update._meta;
  if (meta && typeof meta === "object") {
    const claudeCode = (meta as { claudeCode?: { toolName?: unknown } }).claudeCode;
    if (typeof claudeCode?.toolName === "string" && claudeCode.toolName.length > 0) {
      return claudeCode.toolName;
    }
  }
  if (typeof update.title === "string" && update.title.length > 0) {
    return update.title;
  }
  return undefined;
}

export function textFromContent(content: unknown): string {
  if (!content || typeof content !== "object") return "";
  const c = content as { type?: string; text?: string };
  if (c.type === "text" && typeof c.text === "string") return c.text;
  return "";
}

export function formatReply(text: string): string {
  const withoutCode = text.replace(/```[\s\S]*?```/g, "").trim();
  const firstParagraph = (withoutCode || text).split(/\n\s*\n/)[0]?.trim() ?? "";
  const singleLine = firstParagraph.replace(/\s+/g, " ");
  if (!singleLine) return "";
  const max = 160;
  if (singleLine.length > max) {
    return `${singleLine.slice(0, max - 1)}…`;
  }
  return singleLine;
}

const IGNORED_STDERR_PATTERNS = [
  /\[STARTUP\]/,
  /MaxListenersExceededWarning/,
  /--trace-warnings/,
  /Skipping project agents due to untrusted folder/,
  /Project hooks disabled because the folder is not trusted/,
  /Could not find promptId in context/,
];

export function isStderrNoise(line: string): boolean {
  return IGNORED_STDERR_PATTERNS.some((pattern) => pattern.test(line));
}
