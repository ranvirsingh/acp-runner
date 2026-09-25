---
name: create-agent
description: Create a new agent for this runner — onboarding a new AI worker as a complete, testable agent package holding an agent.yaml runbook, prompts, verification scripts, custom MCP tools, test fixtures, and documentation. Covers intake interrogation, proactive tool/API requirement discovery and scaffolding, decision frameworks for failure/retry policies and turn decomposition, step shapes (gated loops, multi-stage pipelines, pure script steps, explicit END/FAIL terminal targets), the swap economy and vendor session context rules, the full field reference, and the four-stage verification and iterative refinement loop (lint -> live dry run -> LLM-as-a-judge evaluation & refinement -> interactive deployment). Use this whenever someone wants to create, add, onboard, scaffold, design, audit, or fix an agent, worker, runbook or agent.yaml; wants to add verification gates or retry loops, wire MCP servers, swap providers or models, or move prompts into external files. Use it too when they only describe the job in prose without naming agent.yaml.
---

# Creating a New Agent

An agent here is **a complete, testable folder** — not a class and not a crew of sub-agents. The folder holds `agent.yaml` (one persona, an ordered list of turns) plus everything the turns refer to:

```
agents/<name>/
  agent.yaml              # The runbook (agenda of turns, defaults, tools, transitions)
  prompts/                # External prompt templates (>5 lines of prompt)
    draft.md
    fix.md
  tools/                  # Custom stdio MCP servers (if specialized tools/APIs are needed)
    server.mjs (or .py)
  verify.mjs (or .sh)     # Programmatic verification gate that exits 0 or non-zero
  test-fixtures/          # Sample files/workspace to dry-run and prove the agent
  .env.example            # Required environment variables and API keys
  README.md               # Purpose, invocation command, env vars, tools, and transitions
```

Every path inside `agent.yaml` resolves against **that folder**, so the folder travels as one unit and can live in any repo. `--cwd` is a separate thing: the workspace the agent inspects or edits, which changes every run.

Read `assets/agent.yaml` for a working starter template. Read the repo `README.md` when you need runner engine details (ACP stdio protocol, session states, event streaming).

---

## 1. Intake & Co-Pilot Interrogation

Before generating files, interrogate the user with the 6 core questions below. If the user only provides prose requirements (e.g. *"I want an agent that fixes broken tests"* or *"I want an agent that updates database schemas"*), **do not accept un-gated prompt chains, missing tool definitions, or untested runbooks**. Proactively challenge weak assumptions, scaffold missing gates and tools, and establish dry-run evaluation benchmarks.

### The 6 Core Questions

1. **What command or script proves the work is done?**
   - *Examples:* `npm test`, `node verify.mjs`, `python -m pytest`, or a custom script checking file contents, AST structure, or schema compliance and exiting non-zero on failure.
   - *Rule:* The gate separates an autonomous agent from an unvalidated prompt pasted into a terminal. If no command exists yet, **propose and draft one** (`verify.mjs` or `verify.sh`) as part of the agent package.
2. **What are the turns and boundaries?**
   - A turn is a cohesive chunk of work handed to an agent in one go (e.g., implement, review, format).
   - *Split turns when:* The nature of the task changes, the provider/model changes, or the MCP toolset changes.
   - *Do not split turns:* Purely for cosmetic neatness. Every extra model turn costs tokens, and changing provider/model/tools destroys vendor session history.
3. **Who performs each turn (Provider & Model)?**
   - Supported providers: `claude`, `codex`, `gemini`.
   - Set sensible defaults at the top level (e.g. `claude` with `claude-sonnet-5`), with per-step overrides only when a turn requires a specialized model (e.g., fast model for drafting, deep reasoning for security review).
4. **What tools, APIs, and access does the agent need?**
   - Identify external capabilities required (e.g., GitHub, Slack, BigQuery, Database, Jira, custom CLI scripts).
   - **Proactive Tool Scaffolding:** Offer to create custom stdio MCP servers in `agents/<name>/tools/` or configure standard MCP servers, and generate `.env.example` with required secret placeholders.
5. **What is the failure & retry policy?**
   - When a verification gate fails, which step should it loop back to?
   - What is the `maxAttempts` limit (e.g., 3)?
   - What happens when attempts run out: fallback to an alerting/rollback step, or terminate with an explicit `FAIL`?
6. **What test fixtures and evaluation criteria define a passing agent (Dry Run & LLM-as-a-Judge Rubric)?**
   - What baseline files or input state should populate `test-fixtures/` for live smoke testing?
   - What exact output artifacts, code changes, or semantic properties must the caller's LLM evaluate to judge success before deployment?

---

## 2. Proactive Tool, API & Access Discovery

When designing an agent, the assistant must **audit the domain requirements and proactively declare what tools, APIs, and credentials the agent needs before writing YAML**.

```
  ┌──────────────────────────────────────────────────────────┐
  │ Agent Goal: "Review open GitHub PRs and update Jira issue"│
  └────────────────────────────┬─────────────────────────────┘
                               │ Proactive Discovery
                               ▼
  ┌────────────────────────────┬─────────────────────────────┐
  │ External APIs & Tools:     │ Required Env Vars:          │
  │ • GitHub API / MCP         │ • GITHUB_TOKEN              │
  │ • Jira API / MCP           │ • JIRA_API_TOKEN, JIRA_URL  │
  │ • Local Git / diff tools   │ • GITHUB_REPOSITORY         │
  └────────────────────────────┴─────────────────────────────┘
                               │
                               ▼
  Scaffold: agents/<name>/tools/ + .env.example + agent.yaml providers.mcpServers
```

### Proactive Tool Assistance Checklist

1. **Detect Missing Tooling:** If the user's task requires interacting with an external service (Slack, Jira, AWS, GCP, custom database, specialized linter):
   - Check if an off-the-shelf stdio MCP server exists (e.g. `@modelcontextprotocol/server-github`, `@modelcontextprotocol/server-postgres`).
   - If no standard server exists or a bespoke API is needed, **offer to scaffold a lightweight custom stdio MCP server** in `agents/<name>/tools/` (Node.js or Python).
2. **Wire MCP Servers into `agent.yaml`:**
   ```yaml
   providers:
     mcpServers:
       jira:
         command: node
         args: ["tools/jira-server.mjs"]
         env:
           JIRA_API_TOKEN: "{{env.JIRA_API_TOKEN}}"
           JIRA_BASE_URL: "{{env.JIRA_BASE_URL}}"
   ```
3. **Scaffold `.env.example`:** Always generate a template `.env.example` in the agent folder listing every required secret and variable with descriptive comments.
4. **Scope Tools per Turn (`servers:`):** Apply least-privilege scoping so turns that only read files do not receive mutation-capable servers or tools. Use the map form (`servers: { db: { allow: ["select"] } }`) when a server carries both safe and destructive tools. Scoping is free — it never costs a swap.

---

## 3. Decision Framework: Failure, Retry & Decomposition

Use this explicit decision matrix when authoring or reviewing runbooks:

### A. Failure & Retry Policy Decisions (Question 5)

| Decision | Options | Recommendation & Rationale |
| :--- | :--- | :--- |
| **1. Loop Target** | • Jump to `implement`<br>• Jump to dedicated `fix` | **Jump to a dedicated `fix` turn.**<br>• *Why:* Looping to `implement` causes the model to discard previous progress and restart from scratch. A dedicated `fix` turn with automatically attached failure details focuses solely on addressing the compiler/test error. |
| **2. Max Attempts Cap** | • 1 (No retry)<br>• 2–3 (Standard)<br>• >5 (High) | **`maxAttempts: 2` or `3`.**<br>• *Why:* If the model fails 3 consecutive times with exact error feedback, it has hit a fundamental reasoning block. Higher caps waste tokens without improving resolution rate. |
| **3. Exhaustion Strategy** | • Hard `FAIL`<br>• Rollback step (`git checkout .`)<br>• Diagnostic alert step | **Choose based on blast radius:**<br>• *Developer / Local tooling:* Hard `FAIL` so you can inspect broken workspace state.<br>• *Automated / CI pipelines:* Rollback step (`git checkout -- .`) transitioning to `FAIL` to prevent dirty commits. |
| **4. Error Feedback Routing** | Automatic ACP failure block | **Write the repair task without a placeholder.**<br>• The runner attaches the failure source, exit code and captured stdout/stderr in a separate text block, bounded to 16 KiB with an explicit truncation notice. |

### B. Turn Decomposition & Prompt Engineering Decisions

| Decision | Guidelines & Best Practices |
| :--- | :--- |
| **When to split turns** | • **Split:** When the role or task kind changes (e.g. implement $\rightarrow$ review).<br>• **Split:** When the model or provider changes (e.g. fast model $\rightarrow$ reasoning model).<br>• **Split:** When MCP toolsets change (e.g. readonly $\rightarrow$ write access).<br>• **Do NOT split:** Fine-grained sub-steps (e.g. creating 3 different files) — keep these in one turn. |
| **Prompt externalization** | • **Inline `do:`:** 1–5 line concise instructions.<br>• **External `prompts/<id>.md`:** Any prompt $>5$ lines, containing schemas, long instructions, or code snippets. |
| **Every step states its own work** | Every model step needs `do:` or `promptRef:`. There is no CLI goal to inherit — a step with no body and no `run:` is rejected when the runbook loads. |
| **Context loss across swaps** | • Changing `provider` or `model` triggers a session swap that **wipes vendor session history**. Changing `servers:` does **not** — the runner proxy re-scopes in place.<br>• Prompts following a swap must be **self-contained** and explicitly reference files on disk (`--cwd`). |

---

## 4. Architecture & Step Shapes

### A. The Gated Loop (Standard Production Shape)
Work is performed, followed by a deterministic script or verification turn. On failure, the runner loops back with error output until the gate passes or attempts are exhausted.

```
                 ┌──────── failure, max 3 (errors attached) ────────┐
                 ↓                                                    │
  [implement] → [review]  ──────→  [verify (pure script)] ────────────┘
                                         │ success
                                         ↓
                                      [report]  ──────→  END
```

### B. Multi-Stage Verification Pipeline
For complex pipelines requiring layered gates (e.g. static lint -> unit tests -> semantic validation):

```yaml
steps:
  - id: implement

  - id: check_lint
    run: npm run lint
    on:
      failure:
        target: fix_lint
        maxAttempts: 2
        fallback: FAIL

  - id: fix_lint
    do: "Fix the reported lint errors."
    on:
      success: check_lint

  - id: run_tests
    run: npm test
    on:
      failure:
        target: fix_tests
        maxAttempts: 3
        fallback: FAIL

  - id: fix_tests
    do: "Fix the failing test cases."
    on:
      success: run_tests

  - id: finish_report
    do: "Summarize changes made."
    on:
      success: END
```

### C. Pure Script Turns vs. Model Turns
- **Pure Script Turn:** Contains **only** `run:` (no `do`). Runs 0 model tokens. The shell command's exit code determines `on.success` vs `on.failure`. Ideal for setup, compilation, running tests, or teardown.
- **Model Turn:** Contains `do`. Dispatches a prompt to the active ACP provider.
- **Model + Command Turn:** If a turn has a prompt **and** `run:`, the model turn executes first, then the host command runs, and the command's exit code determines the transition.

### D. Terminal Targets (`END` and `FAIL`)
- Transitioning to `END` cleanly finishes the runbook with success.
- Transitioning to `FAIL` terminates the runbook with failure.
- Target matching is case-insensitive (`END`, `end`, `FAIL`, `fail`).
- Step IDs cannot be named `end` or `fail` (they are reserved).

### E. The Swap Economy & Session Context
- **When swaps occur:** A turn with a different `provider` or a different `model` triggers an **ACP session swap**. A different `servers:` scope does not — the runner proxy narrows the visible tool set on the live session.
- **Cost of a swap:** The runner terminates the child process and spawns a fresh ACP session. **All vendor session history and in-memory context are permanently lost.**
- **Context preservation across swaps:** Files written to disk (`--cwd`) carry the work. The runner also preserves any undelivered failure report for the next model turn.
- **Writing prompts after swaps:** If a step follows a swap, do not assume conversational continuity. Write the prompt so it explicitly references files or state on disk.
- **Failure delivery:** The runner automatically sends pending failures as a second ACP text block for `do` and `promptRef`. Successful helper scripts preserve an undelivered failure; a successful rerun of the failed check clears it. Do not include the removed feedback placeholder.

---

## 5. Package Structure & Deliverables

Every agent created must be scaffolded as a complete package inside `agents/<name>/`:

### 1. `agent.yaml`
```yaml
name: code-repair
description: "Iteratively fixes failing tests and syntax errors using test feedback"
provider: claude
model: claude-sonnet-5
providers:
  mcpServers:
    custom-tools:
      command: node
      args: ["tools/server.mjs"]
      env:
        API_KEY: "{{env.CUSTOM_API_KEY}}"
  fallback: [claude, codex, gemini]
  onSpawnError: swap

vars:
  test_cmd: npm test

steps:
  - id: implement

  - id: test_gate
    run: "{{vars.test_cmd}}"
    on:
      success: report
      failure:
        target: fix
        maxAttempts: 3
        fallback: alert_failure

  - id: fix
    do: { file: prompts/fix.md }
    on:
      success: test_gate

  - id: alert_failure
    run: echo "Max repair attempts reached without passing tests."
    on:
      success: FAIL

  - id: report
    do: "Summarize the changes and verify test output."
    on:
      success: END
```

### 2. `prompts/<step>.md`
Externalize any prompt longer than ~5 lines into `prompts/<step>.md`. Paths resolve relative to the agent folder.

```markdown
The verification command failed. Use the failure report attached by the runner.

Inspect the failures, locate the root cause in the workspace, and edit the code to fix them.
Do not introduce unrelated changes.
```

### 3. Custom Tools (`tools/server.mjs` or `tools/server.py`)
When custom APIs or operations are needed, scaffold a lightweight stdio MCP server directly in the agent folder:

```javascript
// agents/my-agent/tools/server.mjs
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "custom-tool", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "query_metrics",
      description: "Queries operational metrics from API",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "query_metrics") {
    return { content: [{ type: "text", text: JSON.stringify({ status: "ok", metrics: [] }) }] };
  }
  throw new Error(`Tool not found: ${request.params.name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
```

### 4. Verification Script (`verify.mjs` / `verify.sh`)
```javascript
// agents/my-agent/verify.mjs
import fs from "node:fs";
import process from "node:process";

if (!fs.existsSync("dist/output.json")) {
  console.error("Missing expected dist/output.json");
  process.exit(1);
}
console.log("Verification passed.");
process.exit(0);
```

### 5. Environment Template (`.env.example`)
```bash
# agents/my-agent/.env.example
# Copy to .env or export before running the agent
CUSTOM_API_KEY=your_api_key_here
GITHUB_TOKEN=your_github_token_here
```

### 6. Test Fixtures & Evaluation Workspace (`test-fixtures/`)
Sample input files, baseline project fixtures, and expected target outputs to support live dry-runs and automated evaluation.

### 7. `README.md`
Documentation detailing purpose, required env vars, MCP server configuration, execution examples, and transition diagrams.

---

## 6. Field & Templating Reference

### Top-Level Fields

| Field | Type | Description |
| --- | --- | --- |
| `name` | `string` | Human-readable name for the runbook |
| `description` | `string` | Human-readable summary of what the agent does and its purpose |
| `provider` | `string` | Provider for every step that does not set its own (`claude`, `codex`, `gemini`, or one declared in `providers.agentHarness`) |
| `model` | `string` | Model for every step that does not set its own |
| `providers.agentHarness.<name>` | `record` | Extra agent CLI, or a replacement for a built-in — `{ command, args }` |
| `providers.fallback` | `string[]` | Ordered list of fallback providers if spawning fails |
| `providers.onSpawnError` | `swap` \| `fail` | Fall back to next provider (`swap`) or abort (`fail`) |
| `vars` | `record` | Template variables available across all turns |
| `providers.mcpServers` | `record` | MCP servers keyed by name. Stdio (`command`, `args`, `env`, same format as `.mcp.json`) or remote (`type: http\|sse`, `url`, `headers`) |
| `steps` | `array` | Ordered list of steps (minimum 1) |

### Step Fields

| Field | Type | Description |
| --- | --- | --- |
| `id` | `string` | Unique step identifier (cannot be `end` or `fail`) |
| `do` | `string` \| `{ file }` | Inline prompt text, or `{ file: path }` to read it from a file relative to the agent folder |
| `run` | `string` | Shell command executed in the workspace (`--cwd`) |
| `provider` | `string` | Turn-level provider override (triggers swap if changed) |
| `model` | `string` | Turn-level model override (triggers swap if changed) |
| `servers` | `string[]` \| `record` | Scoped MCP servers. Omitted = all; `[]` = none; a map adds per-server `allow` / `deny` tool patterns (`*` wildcard, deny wins). Never triggers a swap |
| `promptRef` | `record` | Turn text from a server's prompt catalogue: `{ server, name, arguments }`. Exclusive with `do` and `run` |
| `vars` | `record` | Turn-level variable overrides |
| `on.success` | `string` \| `object` | Target step id or `END` on success (exit 0) |
| `on.failure` | `string` \| `object` | Target step id or `FAIL` on failure (non-zero exit). Supports `{ target, maxAttempts, fallback }` |

### Variable Templating

- `{{name}}` resolves to `vars.name` (or `steps[].vars.name`).
- `{{env.VAR_NAME}}` reads environment variables. Prefix is mandatory.
- Failure details arrive automatically as a separate ACP text block. `{{feedback}}` and its namespaced forms are rejected; do not generate them.
- Unresolved placeholders cause a hard load error.
- Vars can load external files or environment values:
  ```yaml
  vars:
    schema: { file: schemas/output.json }
    token: { env: API_KEY }
  ```

---

## 7. Four-Stage Delivery & Verification Loop with Iterative LLM Judge

When authoring or modifying an agent, execute this closed-loop validation pipeline. Do not deploy or deliver an agent until it passes static lint, succeeds in live dry run, and receives a passing evaluation from the caller LLM judge.

```
  ┌──────────────────────────────────────────────────────────────────────────┐
  │                                                                          │
  │   Stage 1: Static Lint      ──>  Stage 2: Live Dry Run                   │
  │   (bun src/cli.ts lint)          (bun run start -- --cwd "$FIXTURE_DIR") │
  │                                          │                               │
  │                                          ▼                               │
  │   Stage 4: Interactive Run  <──  Stage 3: LLM-as-a-Judge Eval            │
  │   (Offer deployment run)         (Audit logs & artifacts;                │
  │                                   if defects found, refine & loop back)  │
  │                                          │                               │
  │                                          └──────[Refine YAML/prompts]────┘
```

### Stage 1: Static Linting
Run the runner linter to validate YAML schema, unique IDs, server references, variable resolution, file existence, and transition targets:

```bash
bun src/cli.ts lint agents/<name>
```

Fix any syntax or structural semantic issues before proceeding to dry runs.

### Stage 2: Live Dry Run (Test Fixtures)
Seed an isolated temporary workspace with test fixtures and execute the agent against it:

```bash
FIXTURE_DIR=$(mktemp -d)
cp -r agents/<name>/test-fixtures/* "$FIXTURE_DIR"/ 2>/dev/null || true
bun run start -- agents/<name> --cwd "$FIXTURE_DIR"
```

Collect:
1. The process exit status (0 for success, non-zero for failure).
2. The generated run telemetry record (`$FIXTURE_DIR/.runner/run-*.jsonl`).
3. The modified workspace state and files in `$FIXTURE_DIR`.

### Stage 3: LLM-as-a-Judge Evaluation & Iterative Refinement

As the caller LLM executing this skill, you act as the **evaluator and judge** before presenting the agent to the user or deploying it to production.

#### A. Inspection Checklist
1. **Inspect Workspace Artifacts on Disk (`$FIXTURE_DIR`):**
   - Check files created, modified, or deleted during the run.
   - Are the changes syntactically valid, semantically sound, and complete?
   - Did the agent introduce unwanted side effects, stray files, or placeholder comments?
2. **Inspect Run Telemetry (`$FIXTURE_DIR/.runner/run-*.jsonl`):**
   - **Terminal Outcome (`run.end`):** Did the run terminate in `outcome: "finished"` at an explicit `END` state, or did it fail/hang?
   - **Gate Executions & Retries (`step.start`, `step.end`):** Did verification gates pass cleanly? If retries occurred, did the attached failure report guide the model to fix issues within `maxAttempts` without triggering fallbacks?
   - **Swap Efficiency (`swap`):** Were all ACP session swaps intentional? Flag any accidental swaps caused by mismatching `provider` or `model`.
   - **Tool Invocations (`tool`):** Did the agent invoke declared MCP tools correctly? Were there tool errors or unhandled exceptions?

#### B. The 5-Point Evaluation Rubric
Score the agent across 5 core dimensions (Threshold: $\ge 4/5$ on all dimensions):

| Dimension | Weight | Criteria for Pass (Score 4–5) | Criteria for Fail (Score 1–3) |
| :--- | :--- | :--- | :--- |
| **1. Goal Fulfillment & Accuracy** | 30% | Workspace artifacts completely and accurately satisfy the task; verification gates pass with proof. | Incomplete output, broken syntax, missing files, or hallucinated content. |
| **2. Gate Efficiency & Self-Healing** | 25% | Verification command proves correctness; retry turns use the attached failure report to recover within $\le 2$ attempts. | Bypasses gates, loops blindly without addressing errors, or exhausts retries. |
| **3. Session Context & Swap Economy** | 20% | Swaps only occur where necessary. Prompts following a swap are self-contained and reference disk state. | Accidental swaps wiping context; prompts assuming conversational memory across swaps. |
| **4. Prompt Fidelity & Scope Control** | 15% | Agent strictly follows instructions, respects file boundaries, and does not alter unrelated code. | Hallucinating undeclared tools, stray file modifications, or leaking internal prompts. |
| **5. Robustness & Clean Teardown** | 10% | Clean terminal state (`END` / `FAIL`), valid `.runner/` telemetry recorded, zero orphaned processes. | Hanging runs, zombie processes, or unhandled runner crashes. |

#### C. Iterative Refinement Decision Table (Self-Healing)
If evaluation discovers flaws, apply the corresponding fix and loop back to **Stage 1 (Lint)** and **Stage 2 (Dry Run)**:

| Evaluation Finding | Root Cause | Targeted Refinement Action |
| :--- | :--- | :--- |
| **Model loops repeatedly on test failure** | Prompt lacks repair instructions or the check gives unhelpful diagnostics | In `prompts/fix.md` or `do:`, instruct the model to use the automatically attached report, analyze stack traces and edit only failing code. Improve check diagnostics when necessary. |
| **Model hallucinates non-existent tools** | Missing or misconfigured MCP server | Add required server in `agent.yaml` `providers.mcpServers:` or scaffold a custom stdio server in `tools/server.mjs`. |
| **Unintended ACP session swap between turns** | Inconsistent `provider` or `model` fields | Align `provider` and `model` declarations across consecutive turns. |
| **Model loses context after a required swap** | Prompt relies on ACP conversational memory | Rewrite post-swap prompt to explicitly reference file paths in `--cwd` rather than previous conversation history. |
| **Gate fails spuriously due to environment** | `verify.mjs` has flaky assertions or missing paths | Fix `verify.mjs` path resolution (use `process.cwd()` or relative paths) and ensure clear stdout diagnostics. |
| **Output contains unnecessary comments or bloat** | Ambiguous prompt constraints | Add explicit negative constraints (e.g. "Do not add comments, do not modify existing functions outside X"). |

*Refinement Policy:* Iterate up to **3 automated refinement cycles**. If the agent cannot achieve a passing evaluation after 3 cycles, escalate the specific diagnosis and telemetry scorecard to the user in Stage 4.

### Stage 4: Interactive Run Offer & Delivery
Present the validated, iteratively-refined agent package to the user:
- Show the directory structure and transition diagram.
- Present the **LLM Evaluation Scorecard** (scores, dry run metrics, telemetry highlights, refinement history).
- Ask the user if they would like to run the agent against their actual target workspace with the exact CLI command.

---

## 8. Antipatterns & Guardrails

| Antipattern | Why it Fails | Correct Approach |
| --- | --- | --- |
| **Un-gated prompt loops** | Linear prompt chains hallucinate completion without proof. | Add a deterministic verification command (`run:` / `verify.mjs`). |
| **Zero-exit false confidence** | Assuming exit code 0 implies high quality without inspecting artifacts. | Always run the Stage 3 LLM Judge to evaluate artifact correctness and completeness. |
| **Uncapped retries** | Infinite loop burning tokens and API budget. | Always specify `maxAttempts` and a `fallback` target or `FAIL`. |
| **Context loss on swap** | Changing provider or model wipes ACP conversation context. | Minimize swaps; make prompts after swaps self-contained. |
| **Blind prompt thrashing** | Modifying prompts randomly during refinement without reading telemetry. | Inspect `.runner/run-*.jsonl` to pinpoint the exact failing step, swap reason, or tool error. |
| **Secrets in prompt text** | Interpolating `{{env.KEY}}` into prompts leaks keys to the model. | Put secrets inside `providers.mcpServers.<name>.env`. |
| **Path confusion with `--cwd`** | Resolving prompt files against `--cwd` breaks when running across projects. | Runbook prompts resolve relative to the agent folder; only workspace targets use `--cwd`. |
| **Reserved step IDs** | Naming a step `end` or `fail` conflicts with terminal transitions. | Use descriptive IDs like `report`, `finish`, `alert_failure`. |
| **Giant un-split turns** | Combining multiple distinct tasks into one turn makes failure isolation impossible. | Split turns when the kind of work changes or when a distinct verification gate applies. |
| **Missing tool declarations** | Agent fails silently or hallucinates when asked to interact with external APIs without MCP servers. | Proactively audit required tools, scaffold custom servers in `tools/`, and document env vars in `.env.example`. |
