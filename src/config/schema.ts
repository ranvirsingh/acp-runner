import { z } from "zod";
import { knownProviderIds } from "../runtime/providers.js";
import type { AgentYaml } from "../types.js";

const providerId = z.string().min(1);

const providerDeclaration = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    model: z.string().min(1).optional(),
  })
  .strict();

const resourceSource = z
  .object({ resource: z.string().min(1), server: z.string().min(1) })
  .strict();

const varSource = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.object({ env: z.string().min(1) }).strict(),
  z.object({ file: z.string().min(1) }).strict(),
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

const promptRef = z
  .object({
    server: z.string().min(1),
    name: z.string().min(1),
    arguments: z.record(z.string()).optional(),
  })
  .strict();

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
    })
    .strict(),
]);

const step = z
  .object({
    id: z.string().min(1),
    do: z.string().optional(),
    file: z.string().min(1).optional(),
    promptRef: promptRef.optional(),
    provider: providerId.optional(),
    model: z.string().min(1).optional(),
    servers: stepServers.optional(),
    vars: vars.optional(),
    run: stepCommand.optional(),
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
  .refine((value) => !(value.file && value.do != null), {
    message: "use either do or file, not both",
  })
  .refine(
    (value) =>
      !(
        value.promptRef &&
        (value.do != null || value.file != null || value.run != null)
      ),
    { message: "promptRef is exclusive with do, file and run" },
  )
  .refine(
    (value) =>
      value.do != null ||
      value.file != null ||
      value.promptRef != null ||
      value.run != null,
    { message: "step must have do, file, promptRef or run" },
  );

export const RESERVED_TERMINAL_TARGETS = new Set(["end", "fail"]);

export function isTerminalTarget(target?: string): boolean {
  return typeof target === "string" && RESERVED_TERMINAL_TARGETS.has(target.trim().toLowerCase());
}

export const agentYamlSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    provider: providerId.optional(),
    model: z.string().min(1).optional(),
    vars: vars.optional(),
    providers: z
      .object({
        agentHarness: z.record(providerDeclaration).optional(),
        mcpServers: z.record(mcpServer).optional(),
        fallback: z.array(providerId).min(1).optional(),
        onSpawnError: z.enum(["swap", "fail"]).optional(),
      })
      .strict()
      .optional(),
    steps: z.array(step).min(1),
  })
  .strict()
  .refine((value) => new Set(value.steps.map((item) => item.id)).size === value.steps.length, {
    message: "step ids must be unique",
    path: ["steps"],
  })
  .superRefine((value, ctx) => {
    const providers = new Set(knownProviderIds(value.providers?.agentHarness));
    const checkProvider = (name: string | undefined, path: Array<string | number>) => {
      if (name === undefined || providers.has(name)) return;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path,
        message: `unknown provider "${name}" (known: ${[...providers].sort().join(", ")})`,
      });
    };
    checkProvider(value.provider, ["provider"]);
    value.providers?.fallback?.forEach((name, index) =>
      checkProvider(name, ["providers", "fallback", index]),
    );
    const declared = new Set(Object.keys(value.providers?.mcpServers ?? {}));
    for (const [key, source] of Object.entries(value.vars ?? {})) {
      if (!source || typeof source !== "object") continue;
      const server = (source as { server?: unknown }).server;
      if (typeof server !== "string" || declared.has(server)) continue;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["vars", key, "server"],
        message: `unknown server "${server}"`,
      });
    }
    const stepIds = new Set(value.steps.map((s) => s.id));
    value.steps.forEach((item, index) => {
      checkProvider(item.provider, ["steps", index, "provider"]);
      if (isTerminalTarget(item.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["steps", index, "id"],
          message: `step id "${item.id}" is reserved; choose a different id`,
        });
      }
      const scoped = Array.isArray(item.servers)
        ? item.servers
        : Object.keys(item.servers ?? {});
      for (const name of scoped) {
        if (declared.has(name)) continue;
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["steps", index, "servers"],
          message: `unknown server "${name}"`,
        });
      }
      if (item.promptRef && !declared.has(item.promptRef.server)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["steps", index, "promptRef", "server"],
          message: `unknown server "${item.promptRef.server}"`,
        });
      }
      for (const [key, source] of Object.entries(item.vars ?? {})) {
        if (!source || typeof source !== "object") continue;
        const server = (source as { server?: unknown }).server;
        if (typeof server !== "string" || declared.has(server)) continue;
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["steps", index, "vars", key, "server"],
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
