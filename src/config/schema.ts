import { z } from "zod";
import type { AgentYaml } from "../types.js";

const providerId = z.string().min(1);

const providerDeclaration = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    model: z.string().min(1),
  })
  .strict();

const resourceSource = z
  .object({ resource: z.string().min(1), mcpServer: z.string().min(1) })
  .strict();

const fileSource = z.object({ file: z.string().min(1) }).strict();

const varSource = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.object({ env: z.string().min(1) }).strict(),
  fileSource,
  resourceSource,
]);

const vars = z.record(varSource);

const stdioServer = z
  .object({
    type: z.literal("stdio").optional(),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(),
  })
  .strict();

const remoteServer = z
  .object({
    type: z.enum(["http", "sse"]),
    url: z.string().url(),
    headers: z.record(z.string()).optional(),
  })
  .strict();

const mcpServer = z.union([stdioServer, remoteServer]);

const toolScope = z
  .object({
    allow: z.array(z.string().min(1)).optional(),
    deny: z.array(z.string().min(1)).optional(),
  })
  .strict();

const stepServers = z.union([z.array(z.string().min(1)), z.record(toolScope)]);

const stepTransition = z.union([
  z.string().min(1),
  z
    .object({
      target: z.string().min(1),
      maxAttempts: z.number().int().positive().optional(),
      fallback: z.string().min(1).optional(),
    })
    .strict(),
]);

const stepRetry = z
  .object({
    maxAttempts: z.number().int().positive().optional(),
    fallback: z.string().min(1).optional(),
  })
  .strict();

const stepCommand = z.union([
  z.string().min(1),
  z
    .object({
      command: z.string().min(1),
      args: z.array(z.string()).optional(),
      timeout: z.number().int().positive().optional(),
    })
    .strict(),
]);

const step = z
  .object({
    id: z.string().min(1),
    do: z.union([z.string(), fileSource]).optional(),
    provider: providerId.optional(),
    mcpServers: stepServers.optional(),
    vars: vars.optional(),
    run: stepCommand.optional(),
    timeout: z.number().int().positive().optional(),
    retry: stepRetry.optional(),
    on: z
      .object({
        success: stepTransition.optional(),
        failure: stepTransition.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((value) => value.do != null || value.run != null, {
    message: "step must have do or run",
  });

export const RESERVED_TERMINAL_TARGETS = new Set(["end", "fail"]);

export function isTerminalTarget(target?: string): boolean {
  return typeof target === "string" && RESERVED_TERMINAL_TARGETS.has(target.trim().toLowerCase());
}

export const agentYamlSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    providers: z.record(providerDeclaration).optional(),
    mcpServers: z.record(mcpServer).optional(),
    vars: vars.optional(),
    steps: z.array(step).min(1),
  })
  .strict()
  .refine((value) => new Set(value.steps.map((item) => item.id)).size === value.steps.length, {
    message: "step ids must be unique",
    path: ["steps"],
  })
  .superRefine((value, ctx) => {
    const providers = Object.keys(value.providers ?? {}).sort();
    const checkProvider = (name: string | undefined, path: Array<string | number>) => {
      if (name === undefined || providers.includes(name)) return;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path,
        message: `unknown provider "${name}" (known: ${providers.join(", ") || "none"})`,
      });
    };
    const declared = new Set(Object.keys(value.mcpServers ?? {}));
    for (const [key, source] of Object.entries(value.vars ?? {})) {
      if (!source || typeof source !== "object") continue;
      const server = (source as { mcpServer?: unknown }).mcpServer;
      if (typeof server !== "string" || declared.has(server)) continue;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["vars", key, "mcpServer"],
        message: `unknown server "${server}"`,
      });
    }
    const stepIds = new Set(value.steps.map((s) => s.id));
    value.steps.forEach((item, index) => {
      checkProvider(item.provider, ["steps", index, "provider"]);
      if (item.do !== undefined && !item.provider) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["steps", index, "provider"],
          message: `step "${item.id}" needs a provider`,
        });
      }
      if (isTerminalTarget(item.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["steps", index, "id"],
          message: `step id "${item.id}" is reserved; choose a different id`,
        });
      }
      const scoped = Array.isArray(item.mcpServers)
        ? item.mcpServers
        : Object.keys(item.mcpServers ?? {});
      for (const name of scoped) {
        if (declared.has(name)) continue;
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["steps", index, "mcpServers"],
          message: `unknown server "${name}"`,
        });
      }
      for (const [key, source] of Object.entries(item.vars ?? {})) {
        if (!source || typeof source !== "object") continue;
        const server = (source as { mcpServer?: unknown }).mcpServer;
        if (typeof server !== "string" || declared.has(server)) continue;
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["steps", index, "vars", key, "mcpServer"],
          message: `unknown server "${server}"`,
        });
      }
      if (item.on?.success) {
        const target = typeof item.on.success === "string" ? item.on.success : item.on.success.target;
        if (!isTerminalTarget(target) && !stepIds.has(target)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["steps", index, "on", "success"],
            message: `unknown step "${target}"`,
          });
        }
      }
      if (item.on?.failure) {
        const target = typeof item.on.failure === "string" ? item.on.failure : item.on.failure.target;
        if (!isTerminalTarget(target) && !stepIds.has(target)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["steps", index, "on", "failure"],
            message: `unknown step "${target}"`,
          });
        }
        if (typeof item.on.failure === "object" && item.on.failure.fallback) {
          const fallback = item.on.failure.fallback;
          if (!isTerminalTarget(fallback) && !stepIds.has(fallback)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["steps", index, "on", "failure", "fallback"],
              message: `unknown step "${fallback}"`,
            });
          }
        }
      }
    });
  });

function formatPath(path: Array<string | number>): string {
  return path.reduce<string>((acc, part) => {
    if (typeof part === "number") return `${acc}[${part}]`;
    return acc ? `${acc}.${part}` : part;
  }, "");
}

function describeIssue(issue: z.ZodIssue): string {
  if (issue.code !== z.ZodIssueCode.invalid_union) return issue.message;
  const branches = issue.unionErrors.map((error) =>
    error.issues
      .map((inner) => {
        const where = formatPath(inner.path);
        return where ? `${where}: ${inner.message}` : inner.message;
      })
      .join("; "),
  );
  return `no variant matched (${[...new Set(branches)].join(" | ")})`;
}

export function validateAgentYaml(value: unknown, path: string): AgentYaml {
  const result = agentYamlSchema.safeParse(value);
  if (result.success) return result.data as AgentYaml;
  const problems = result.error.issues.map(
    (issue) => `  ${formatPath(issue.path) || "(root)"}: ${describeIssue(issue)}`,
  );
  throw new Error(`${path}: ${problems.length} problem(s)\n${problems.join("\n")}`);
}
