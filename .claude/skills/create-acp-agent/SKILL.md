---
name: create-acp-agent
description: Create, change, audit or fix an acp-runner agent. An agent is a folder with an agent.yaml runbook, prompt files, check scripts, MCP tools, test fixtures and a README. Use this skill when a user wants a new agent, worker, runbook or agent.yaml, or describes a multi-step agent job in plain words. Use it also to add checks or fix loops, connect MCP servers, change providers or models, or move prompts into files. The skill covers the intake questions, tool discovery, step design, the field reference and a four-stage test loop (lint and plan, dry run, judge, delivery).
---

# Create an ACP agent

An agent is a folder. The folder holds `agent.yaml` and every file that `agent.yaml` refers to:

```
agents/<name>/
  agent.yaml        # the runbook: providers, MCP servers, vars and steps
  prompts/          # prompt files, one for each long prompt
  tools/            # custom stdio MCP servers, if the agent needs them
  verify.sh         # a check script that exits 0 on success
  test-fixtures/    # sample input files for the dry run
  .env.example      # the environment variables that the agent needs
  README.md         # purpose, command, variables, tools and step flow
```

Every path in `agent.yaml` is relative to the agent folder. The workspace is different: `--cwd` sets the folder that the agents edit, and it can change on each run.

Start from `assets/agent.yaml`. It is a valid runbook. For the CLI and the field summary, read the repository `README.md`.

## Terms

| Term | Meaning |
| --- | --- |
| Provider | An ACP agent that `providers:` declares, for example `claude` or `codex`. |
| Prompt step | A step that has `do`. The step sends the prompt to its provider. |
| Script step | A step that has `run` and no `do`. It runs a shell command and uses no model. |
| Check | The `run` command of a prompt step. It runs after the prompt. |
| Swap | A change to a different provider between two steps. |
| Workspace | The folder that `--cwd` sets. The agents read and edit files there. |
| Run record | The file `<workspace>/.runner/run-<id>.jsonl` that `--trace file` writes. |

## 1. Ask the intake questions

Ask these six questions before you write files. If the user gives only a description of the job, do not write a runbook that has no checks, no tools or no test. Tell the user what is missing. Then propose a solution.

1. **Which command proves the result?**
   - Examples: `npm test`, `sh verify.sh`, `python -m pytest`.
   - If no command exists, write `verify.sh` or `verify.mjs` as part of the agent.
   - A runbook without a check cannot prove its result.
2. **What are the steps?**
   - A step is one unit of work for one provider, for example "implement", "review" or "format".
   - Make a new step when the type of work changes, when the provider changes, or when the tools change.
   - Do not make a new step only to make the runbook look neat. Each prompt step uses tokens.
3. **Which provider does each step use?**
   - Declare each provider under `providers:` with `command`, `args` and `model`. Each provider must have a `model`.
   - Each prompt step names its provider with `provider:`.
   - To use a second model, declare a second provider.
4. **Which tools, APIs and access does the agent need?**
   - Identify each external service, for example GitHub, Jira, a database or a custom CLI.
   - Offer to connect an existing MCP server, or to write a custom stdio MCP server in `tools/`.
   - Write `.env.example` with each secret that the agent needs.
5. **What happens when a check fails?**
   - Identify the step that the run goes back to.
   - Identify the attempt limit, for example `maxAttempts: 3`.
   - Identify the step after the last attempt: an alert step, a rollback step or `FAIL`.
6. **How do you know that the agent works?**
   - Identify the sample files for `test-fixtures/`.
   - Identify the output files and properties that you must examine after the dry run.

## 2. Find the tools before you write YAML

Make a list of the external services, the MCP servers and the environment variables before you write `agent.yaml`.

```
Goal: "Review open GitHub pull requests and update the Jira issue"

  Services and tools          Environment variables
  - GitHub MCP server         - GITHUB_TOKEN
  - Jira MCP server           - JIRA_API_TOKEN, JIRA_URL
  - local git                 - GITHUB_REPOSITORY

  Files to write: tools/ + .env.example + mcpServers in agent.yaml
```

1. **Find a server.** Look for an existing stdio MCP server for the service. If no server exists, write a small custom server in `tools/`.
2. **Declare the server** under the top-level `mcpServers:` key:

   ```yaml
   mcpServers:
     jira:
       command: node
       args: [tools/jira-server.mjs]
       env:
         JIRA_API_TOKEN: "{{env.JIRA_API_TOKEN}}"
         JIRA_URL: "{{env.JIRA_URL}}"
   ```

   For a remote server, use `type: http` or `type: sse` with `url` and `headers`.
3. **Write `.env.example`.** Put each variable in it with a one-line comment.
4. **Limit the tools for each step.** Give a step only the servers and tools that it needs:
   - No `mcpServers` field: the step sees every declared server.
   - `mcpServers: []`: the step sees no server.
   - `mcpServers: [jira]`: the step sees every tool of `jira`.
   - `mcpServers: { db: { allow: [select], deny: ["drop_*"] } }`: the step sees only the tools that match. `deny` has priority over `allow`, and `*` matches any text.

   A change of tools does not cause a swap.

## 3. Design the failure policy and the steps

### Failure policy

| Decision | Recommendation | Reason |
| --- | --- | --- |
| Where to go back | Go to a dedicated `fix` step. | A `fix` step works on the error only. A return to `implement` can cause the model to start again from zero. |
| Attempt limit | Use `maxAttempts: 2` or `3`. | After three failed attempts with the full error, more attempts seldom help. They use tokens. |
| After the last attempt | Use `FAIL` for local work. Use a rollback step, then `FAIL`, for automated work. | `FAIL` keeps the workspace for inspection. A rollback step prevents bad changes in automated runs. |
| Error feedback | Write the fix prompt without a placeholder. | The runner attaches the failed command, the exit code and the output to the next prompt. The limit is 16 KiB. |

### Step design

| Decision | Rule |
| --- | --- |
| New step | Make a new step when the type of work, the provider or the tools change. Keep small sub-tasks in one step. |
| Prompt file | Write a prompt of 1 to 5 lines inline in `do`. Put a longer prompt in `prompts/<step>.md`, and use `do: { file: prompts/<step>.md }`. |
| Prompt content | Each prompt step needs its own `do`. The runner does not take a goal from the command line. |
| After a swap | The new provider has no history of the earlier steps. Write a prompt that names the files in the workspace. |

## 4. Step shapes

### A. The check loop

A prompt step does the work. A script step checks it. On failure, the run goes back to a `fix` step with the error attached.

```
                 ┌──── failure, max 3 (error attached) ────┐
                 ↓                                         │
  [implement] → [verify (script)] ──→ [fix] ───────────────┘
                     │ success
                     ↓
                  [report] ──→ END
```

### B. A check pipeline

Use one check after the other, for example lint, then tests:

```yaml
name: pipeline
providers:
  claude:
    command: npx
    args: ["-y", "@agentclientprotocol/claude-agent-acp"]
    model: claude-sonnet-5
steps:
  - id: implement
    provider: claude
    do: Implement the change that TASK.md describes.
  - id: check_lint
    run: npm run lint
    on:
      success: run_tests
      failure: { target: fix_lint, maxAttempts: 2, fallback: FAIL }
  - id: fix_lint
    provider: claude
    do: Fix the lint errors.
    on:
      success: check_lint
  - id: run_tests
    run: npm test
    on:
      success: report
      failure: { target: fix_tests, maxAttempts: 3, fallback: FAIL }
  - id: fix_tests
    provider: claude
    do: Fix the failing tests.
    on:
      success: run_tests
  - id: report
    provider: claude
    do: Summarize the changes in less than ten lines.
    on:
      success: END
```

### C. Script steps and prompt steps

- **Script step:** only `run`. It uses no model. Exit code 0 goes to `on.success`. Any other exit code goes to `on.failure`. Use it to prepare, build, test or clean the workspace.
- **Prompt step:** `do` and `provider`. It sends the prompt to the provider.
- **Prompt step with a check:** `do`, `provider` and `run`. The prompt runs first. Then the check runs, and its exit code sets the next step.
- **Variables in scripts:** each var of the step is an environment variable of the `run` command. `RUNBOOK_DIR` contains the path of the agent folder. Do not use a var name that is also a system variable, for example `PATH` or `HOME`.
- **Time limit:** a `run` command stops after 5 minutes. Set `timeout` in milliseconds to change this.

### D. END and FAIL

- `END` stops the run with success. `FAIL` stops the run with failure.
- Both upper case and lower case work.
- A step id cannot be `end` or `fail`.
- If a step fails and has no `on.failure` and no `retry`, the run fails.
- If a step succeeds and has no `on.success`, the run goes to the next step. After the last step, the run ends with success.

### E. Sessions and swaps

- Two steps after each other that use the same provider share one session and its history.
- A script step keeps the current session.
- A change of `mcpServers` keeps the current session.
- A step with a different provider causes a swap. The runner stops the current agent and starts the new agent. The history of the old session is lost.
- Files in the workspace carry the work across a swap. An error that the runner did not yet send also carries across a swap.

## 5. Files to deliver

Write every agent as a complete folder in `agents/<name>/`.

### 1. `agent.yaml`

```yaml
name: code-repair
description: Fix failing tests with the test output as feedback
providers:
  claude:
    command: npx
    args: ["-y", "@agentclientprotocol/claude-agent-acp"]
    model: claude-sonnet-5
mcpServers:
  metrics:
    command: node
    args: [tools/server.mjs]
    env:
      API_KEY: "{{env.CUSTOM_API_KEY}}"
vars:
  TEST_COMMAND: npm test
steps:
  - id: test_gate
    mcpServers: []
    run: "{{TEST_COMMAND}}"
    on:
      success: report
      failure: { target: fix, maxAttempts: 3, fallback: alert_failure }
  - id: fix
    provider: claude
    mcpServers: [metrics]
    do: { file: prompts/fix.md }
    on:
      success: test_gate
  - id: alert_failure
    run: echo "The tests still fail after the last attempt."
    on:
      success: FAIL
  - id: report
    provider: claude
    mcpServers: []
    do: Summarize the changes in less than ten lines.
    on:
      success: END
```

### 2. `prompts/<step>.md`

Put each prompt of more than 5 lines in its own file. The path is relative to the agent folder.

```markdown
The test command failed. The runner attached its output to this message.

Find the cause of each failure in the workspace and fix it.
Do not change code that is not related to the failures.
```

### 3. Custom tools (`tools/server.mjs`)

Write a small stdio MCP server when no existing server supplies the tool:

```javascript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "metrics", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "query_metrics",
      description: "Return the metrics that match a query",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "query_metrics") {
    return { content: [{ type: "text", text: JSON.stringify({ status: "ok", metrics: [] }) }] };
  }
  throw new Error(`unknown tool: ${request.params.name}`);
});

await server.connect(new StdioServerTransport());
```

### 4. Check script (`verify.sh`)

```bash
#!/bin/sh
set -eu
test -s dist/output.json || { echo "dist/output.json is missing or empty" >&2; exit 1; }
echo "check passed"
```

Write each failure message so that a model can act on it. The runner sends the output of a failed check to the next prompt.

### 5. `.env.example`

```bash
# Export these variables before you run the agent.
CUSTOM_API_KEY=your_api_key
GITHUB_TOKEN=your_github_token
```

### 6. `test-fixtures/`

Put the sample input files for the dry run here. Add the expected output files if the judge needs them.

### 7. `README.md`

Write the purpose, the run command, the environment variables, the MCP servers and a diagram of the step flow.

## 6. Field reference

### Top-level fields

| Field | Type | Meaning |
| --- | --- | --- |
| `name` | string | The name of the runbook. |
| `description` | string | What the agent does. |
| `providers.<name>` | object | An ACP agent: `command`, `args` and `model`. Each provider must have `model`. A step can use only a declared provider. |
| `mcpServers.<name>` | object | An MCP server. Stdio: `command`, `args`, `env`. Remote: `type: http` or `type: sse`, `url`, `headers`. |
| `vars` | object | Variables for all steps. |
| `steps` | list | The steps, in order. At least one. |

### Step fields

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | A unique name for the step. It cannot be `end` or `fail`. |
| `do` | string or `{ file }` | The prompt, inline or from a file in the agent folder. |
| `provider` | string | The provider that runs the prompt. Required when the step has `do`. |
| `run` | string or `{ command, args }` | A shell command that runs in the workspace. |
| `timeout` | number | The time limit of `run` in milliseconds. The default is 300000. |
| `mcpServers` | list or object | The servers and tools that the step sees. |
| `vars` | object | Variables for this step only. They replace top-level vars that have the same name. |
| `on.success` | string or object | The next step after success: a step id or `END`. |
| `on.failure` | string or object | The next step after failure: a step id or `FAIL`. The object form is `{ target, maxAttempts, fallback }`. |
| `retry` | object | `{ maxAttempts, fallback }`. A short form of `on.failure` that goes back to the same step. |

### Variables

| Source | Example | Note |
| --- | --- | --- |
| Text | `TONE: formal` | The text is the value. |
| File | `SCHEMA: { file: schemas/out.json }` | The path is relative to the agent folder. |
| Environment | `BRANCH: { env: GIT_BRANCH }` | The environment variable must exist. |
| MCP resource | `STYLE: { resource: "mem://style", mcpServer: notes }` | The runner reads the resource before the step. The limit is 256 KiB of text. |

- `{{NAME}}` reads a var. `{{env.NAME}}` reads an environment variable.
- A placeholder that has no value is an error. Lint finds it before the run.
- The runner reads top-level `{ file }`, `{ env }` and `{ resource }` vars for each step. Declare such a var on the steps that use it. Then a step that does not use it cannot fail because of it.
- Do not write `{{feedback}}`. The runner attaches failure output automatically, and lint rejects this placeholder.

## 7. The four-stage test loop

Do not deliver an agent until it passes lint, completes a dry run and gets a passing score from the judge.

```
  Stage 1: lint, plan, check  ──→  Stage 2: dry run
          ↑                               │
          │                               ↓
          └──── fix the files ←── Stage 3: judge ──→ Stage 4: delivery
```

The commands below use `acp-runner`. In a clone of this repository, `bun src/cli.ts` does the same work.

### Stage 1: lint, plan and check

1. Lint the agent:

   ```bash
   acp-runner lint agents/<name>
   ```

   Fix each problem that lint reports.
2. Print the plan:

   ```bash
   acp-runner plan agents/<name>
   ```

   The plan starts no agent. Make sure that each step has the provider, model, tools, prompt, check and next step that you intend.
3. Check the providers:

   ```bash
   acp-runner check agents/<name>
   ```

   The check starts each provider and sets its model. It sends no prompt. Fix each `fail` line, for example a missing login or a model that the provider rejects.

### Stage 2: dry run

1. Copy the test fixtures to a new temporary workspace:

   ```bash
   FIXTURE_DIR=$(mktemp -d)
   cp -R agents/<name>/test-fixtures/. "$FIXTURE_DIR"
   ```

2. Run the agent:

   ```bash
   acp-runner run agents/<name> --cwd "$FIXTURE_DIR" --trace file
   ```

3. Record these results:
   - the exit code: 0 for success, 1 for failure
   - the run record in `$FIXTURE_DIR/.runner/run-*.jsonl`
   - the files in `$FIXTURE_DIR`

### Stage 3: judge the result

You are the judge. Examine the result before you show the agent to the user.

#### A. Examine the results

1. **Files in the workspace**
   - Identify the files that the run added, changed or deleted.
   - Make sure that the changes are valid and complete.
   - Look for unwanted files, unwanted changes and placeholder text.
2. **The run record**
   - `run.end`: make sure that the outcome is `finished`.
   - `step.start` and `step.end`: make sure that the checks passed. If a loop occurred, make sure that the fix step solved the error before the attempt limit.
   - `swap`: make sure that each swap is necessary.
   - `tool`: make sure that the tool calls succeeded.

#### B. Score the agent

Give each item a score from 1 to 5. The agent passes when each item has a score of 4 or more.

| Item | Weight | Pass (4 or 5) | Fail (1 to 3) |
| --- | --- | --- | --- |
| 1. Result | 30% | The files do the task completely and without errors. The checks pass. | The output is incomplete, invalid or not true. |
| 2. Checks and fixes | 25% | The checks prove the result. A fix step solves an error in 2 attempts or less. | A check is missing, or the loop repeats without progress. |
| 3. Sessions and swaps | 20% | Each swap is necessary. Each prompt after a swap names the files that it needs. | A swap is not necessary, or a prompt uses history that the provider does not have. |
| 4. Scope | 15% | The agent does only the task and changes only the related files. | The agent uses tools that do not exist or changes unrelated files. |
| 5. Clean end | 10% | The run ends at `END` or `FAIL` and writes a run record. | The run stops responding or the runner crashes. |

#### C. Fix the agent

If an item fails, apply the fix below. Then do Stage 1 and Stage 2 again.

| Result | Cause | Fix |
| --- | --- | --- |
| The fix step repeats the same error. | The prompt does not tell the model how to use the error output, or the check output is not clear. | Tell the model to read the attached output and to change only the failing code. Improve the check messages. |
| The model uses a tool that does not exist. | An MCP server is missing. | Declare the server in `mcpServers`, or write a server in `tools/`. |
| A swap occurs that is not necessary. | Two adjacent steps use different providers. | Use the same provider on adjacent steps that share context. |
| The model does not know the earlier work after a swap. | The prompt depends on the history of an earlier session. | Name the files in the workspace that contain the earlier work. |
| The check fails because of the environment. | The check script uses a wrong path or an unstable test. | Use paths relative to the workspace. Write clear failure messages. |
| The output has unnecessary comments or changes. | The prompt has no limits. | Add limits, for example "Do not add comments" or "Change only the file X". |

Do a maximum of 3 fix cycles. If the agent still fails, stop. Show the scores, the run record and your diagnosis to the user in Stage 4.

### Stage 4: delivery

1. Show the folder structure and the step flow diagram.
2. Show the scores, the dry run results and the fix cycles.
3. Ask the user if you must run the agent on their real workspace. Give the exact command.

## 8. Errors to prevent

| Error | Result | What to do |
| --- | --- | --- |
| Prompt steps with no check | The model can report success without proof. | Add a `run` check or a check script. |
| Trust in exit code 0 alone | A passing check does not prove the quality of the files. | Do the Stage 3 judge review. |
| A loop with no limit | The loop can use tokens without end. | Set `maxAttempts` and `fallback` on each loop. |
| Unnecessary swaps | Each swap loses the session history. | Use fewer swaps. Make each prompt after a swap complete. |
| Prompt changes without data | Random changes do not find the cause. | Read the run record to find the failed step or tool. |
| Secrets in prompts | `{{env.KEY}}` in a prompt sends the key to the model. | Put secrets in `mcpServers.<name>.env`. |
| Paths relative to the workspace in the runbook | The agent fails when the workspace changes. | Make runbook paths relative to the agent folder. Use `--cwd` only for the workspace. |
| Step id `end` or `fail` | The runner reserves these names. | Use names such as `report` or `alert_failure`. |
| Very large steps | You cannot find which part failed. | Make a new step when the type of work changes or when a separate check applies. |
| Tools that are not declared | The model fails or uses tools that do not exist. | Find the tools first. Write servers in `tools/`. List the variables in `.env.example`. |
