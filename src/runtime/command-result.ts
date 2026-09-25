export interface CommandResult {
  outcome: "success" | "failure";
  output: string;
  exitCode: number | null;
}

export function commandResult(result: {
  status?: number | null;
  signal?: string | null;
  error?: { message?: string };
  stdout?: unknown;
  stderr?: unknown;
}): CommandResult {
  const exitCode = typeof result.status === "number" ? result.status : null;
  const failed = Boolean(result.error || result.signal || exitCode !== 0);
  const output = [
    ...(result.stdout ? [`stdout:\n${String(result.stdout).trimEnd()}`] : []),
    ...(result.stderr ? [`stderr:\n${String(result.stderr).trimEnd()}`] : []),
    ...(result.error ? [`Process error: ${result.error.message ?? "unknown process error"}`] : []),
    ...(result.signal ? [`Process signal: ${result.signal}`] : []),
  ].join("\n\n");
  return {
    outcome: failed ? "failure" : "success",
    output: output || (failed ? "Process failed without output." : ""),
    exitCode,
  };
}
