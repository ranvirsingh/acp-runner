# acp-runner

Run multi-step agent workflows from one YAML file, with the coding CLIs you already use.

`acp-runner` reads an `agent.yaml`, starts each agent over the [Agent Client Protocol](https://agentclientprotocol.com) (ACP), and moves through the steps in order. A step can send a prompt to an agent, run a shell command, or do both. Shell commands act as checks, and a failed check can loop back to an earlier step.

- **Uses your existing logins.** The runner starts Claude Code, Codex or any other ACP agent as a child process. It holds no API keys.
- **Mixes vendors in one run.** For example, Claude writes the code and Codex reviews it.
- **Declarative.** The YAML alone decides which agent, model, tools and prompt each step uses. No hidden defaults apply.
- **Scoped tools.** Each step sees only the MCP servers and tools that you allow for it.

> **Beta.** Until 1.0, any release can change the `agent.yaml` format or the CLI.

## Example

This is a shorter version of the [riddle example](examples/riddle/agent.yaml). Claude writes a riddle, and Codex solves it.

```yaml
name: riddle
description: Claude writes a riddle, Codex solves it
providers:
  claude:
    command: npx
    args: ["-y", "@agentclientprotocol/claude-agent-acp"]
    model: claude-sonnet-5
  codex:
    command: npx
    args: ["-y", "@agentclientprotocol/codex-acp@2.5.0"]
    model: gpt-6-luna
vars:
  RIDDLE_THEME: the ocean
steps:
  - id: ask
    provider: claude
    do: |
      Write one short riddle about {{RIDDLE_THEME}} to riddle.md.
      Do not write the answer.
    run: test -s riddle.md
  - id: solve
    provider: codex
    do: |
      Read riddle.md and solve the riddle.
      Write "Answer: <your answer>" to answer.md.
    run: "grep -q '^Answer: ' answer.md"
```

Each step sends its `do` prompt to its `provider`. Then the step runs its `run` command as a check. A check that exits with a code other than 0 fails the run, unless the step says where to go on failure.

## Requirements

- [Node](https://nodejs.org) 20 or later. The `acp-runner` command runs on Node.
- [Bun](https://bun.sh) 1.4 or later, to build from source.
- The agent CLIs that your workflow names, installed and logged in on this machine. For example, `claude` and `codex login`.
- `npx`, if a provider starts through `npx`, as in the example.

## Install

Install the beta from npm:

```bash
npm install -g acp-runner@beta
acp-runner --version
```

Or run it without a global install:

```bash
npx acp-runner@beta --help
```

The examples below are in this repository. To get the examples and build from source:

```bash
git clone https://github.com/ranvirsingh/acp-runner.git
cd acp-runner
bun install && bun run build && bun link
```

`bun link` puts `acp-runner` in `~/.bun/bin`. Make sure that this folder is on your `PATH`.

## Quick start

```bash
acp-runner plan examples/riddle    # show what each step will do, without starting an agent
acp-runner check examples/riddle   # start each agent, and test the login and model
```

Run the workflow in a temporary folder, so that the agents do not edit the repository:

```bash
work=$(mktemp -d) && cp -R examples/riddle/. "$work"
acp-runner run "$work" --cwd "$work"
cat "$work/riddle.md" "$work/answer.md"
```

## Commands

| Command | What it does |
| --- | --- |
| `acp-runner run [folder\|file]` | Runs the workflow. `--cwd <dir>` sets the folder that the agents edit. `--state <dir>` keeps a journal so that a later run can continue a stopped run (see [Continue a stopped run](#continue-a-stopped-run)). `--trace off\|file\|stdout\|both` sets where the run trace goes. `--confirm` asks you before each tool call. |
| `acp-runner lint [folder\|file ...]` | Finds errors in the YAML, the prompt files and the variables. It starts nothing. |
| `acp-runner plan [folder\|file]` | Prints each step with its agent, model, tools, filled-in prompt, check and next step. It starts nothing. |
| `acp-runner check [folder\|file]` | Starts each agent, logs in and sets the model. It sends no prompt. |
| `acp-runner skill install` | Copies the `create-acp-agent` skill to `~/.claude/skills/`. |

A folder argument means the `agent.yaml` in that folder. With no argument, the commands use `./agent.yaml`. Every command exits with code 1 on failure. `run --state` uses more exit codes (see below).

## `agent.yaml` at a glance

| Field | Meaning |
| --- | --- |
| `providers.<name>` | An ACP agent: `command`, `args` and a required `model`. Steps refer to it by name. |
| `mcpServers.<name>` | An MCP server (stdio, `http` or `sse`) that steps can use. |
| `vars` | Values that the workflow owns, for `{{NAME}}` placeholders. A value can be text, `{ file }` or `{ resource, mcpServer }`. Values from the environment do not go here. |
| `steps[].do` | The prompt, inline or `{ file: path }`. |
| `steps[].provider` | The agent that runs the prompt. Required when the step has `do`. |
| `steps[].run` | A shell command. On its own, the step is a script step. After `do`, it is the check. |
| `steps[].mcpServers` | The servers and tools that the step can see, for example `issue_tracker: { allow: [list_issues] }`. |
| `steps[].vars` | Variables for this step only. |
| `steps[].on` | The next step on `success` or `failure`: a step id, `END` or `FAIL`. Add `maxAttempts` to limit a loop. |

### More detail

**Tool scope.** If a step has no `mcpServers` field, the step sees every declared server. `mcpServers: []` gives the step no server. A map limits the tools:

```yaml
mcpServers:
  issue_tracker: { allow: ["list_*"], deny: [delete_issue] }
```

**Placeholders.** There are two kinds:

- `{{NAME}}` reads a value from `vars`.
- `${{ env.NAME }}` and `${{ secrets.NAME }}` read an environment variable. Write them where the value is used, for example in an MCP header. The environment that starts the run supplies the value, for example GitHub Actions `env`, `vars` or `secrets`.

The runner redacts the value of each `${{ secrets.NAME }}` in logs, plans and run traces. An empty secret is an error.

Before the first step, `run` and `check` find every `${{ env.NAME }}` and `${{ secrets.NAME }}` in the prompts, the `run` commands and the MCP servers. If one is missing, they stop and name all missing values. `plan` lists these values under `external`.

Do not put a secret in a prompt, because the prompt goes to the model. `lint` reports a secret in a prompt, and `run` stops before the first step. `lint` also reports an `${{ env.NAME }}` whose name looks like a credential.

Shell steps and local MCP servers inherit the full environment. Agents inherit it too, except the variables that the runbook reads as `${{ secrets.NAME }}`. Use a placeholder only where the runner must put the value into the text.

A placeholder that has no value is an error.

**Repair loops.** `on.failure` can go back to an earlier step. `maxAttempts` limits the loop, and `fallback` sets the next step after the last attempt:

```yaml
on:
  failure: { target: draft, maxAttempts: 2, fallback: FAIL }
```

`retry: { maxAttempts: 3 }` is a short form that runs the same step again.

**Remote MCP servers.** Use `type: http` or `type: sse` with a `url`, and add `headers` if the server needs them:

```yaml
mcpServers:
  jira:
    type: sse
    url: https://mcp.example.com/jira/sse
    headers: { Authorization: "Bearer ${{ secrets.JIRA_TOKEN }}" }
```

**Run records.** `--trace file` writes one JSON event for each line to `<cwd>/.runner/run-<id>.jsonl`.

## How a run works

- Steps that use the same provider share one session. A step with a different provider stops the current agent and starts the new one.
- Conversation history does not carry over to a different agent. Files in the workspace carry the work from step to step.
- When a check fails, the runner attaches the command output to the next prompt automatically.
- `Ctrl-C` cancels the current turn cleanly over ACP.

## Continue a stopped run

A run can stop before it finishes: the machine restarts, a CI job is cancelled, or the agent process dies. Give `run` a state directory, and a later run with the same directory continues the work:

```bash
acp-runner run agent.yaml --cwd "$work" --state "$STATE_ROOT/my-agent/run-42"
```

The state directory is the run key. Use one directory for each run of one runbook. The runner has no default location. Without `--state`, the runner keeps no journal and behaves as before.

The directory holds:

| File | Content |
| --- | --- |
| `agent.state.jsonl` | The journal: one JSON event for each line, written with `fsync` before the action that it allows. It records steps, visits, sessions, prompts, tool calls and outcomes. It holds no prompt text, transcript, tool argument or tool result. |
| `agent.state.lock` | The writer lock: the host name and the process group of the run. It is valid on one host only. Do not copy it to another host. |
| `feedback/` | Saved check output that the next prompt must carry. Secret values are redacted. |

A later run with the same `--state` reads the journal and does one of these:

- It continues the open step. For an agent step, it reopens the same ACP session with `session/resume`, or with `session/load` when the agent cannot resume.
- It starts the next step, when the journal records that the earlier step completed.
- It prints the recorded outcome and exits, when the run already finished.
- It stops with outcome `unknown`, when it cannot prove that a repeat is safe. A person must then decide.

If the runner stopped during a model turn, the next run reopens the session and sends the step prompt one more time, after a fixed notice that tells the agent to check its earlier work and not repeat a finished action. If that second turn is interrupted too, the run stops as `unknown`.

### Exit codes with `--state`

| Code | Meaning | What the caller does |
| --- | --- | --- |
| 0 | The run finished. | Continue. |
| 1 | The run failed, or the state was refused: the journal is corrupt, it belongs to another `--cwd`, another host holds the lock, or a saved feedback file is missing. | Treat the run as failed. Keep the state for inspection. |
| 2 | The outcome is unknown. For example, an MCP tool call that can change something outside started, and its result was lost. | A person checks the outside system and decides. |
| 3 | The runbook files or the resolved inputs changed since the journal started. | Start again with a new state directory. |
| 75 | The run stopped and can continue: a stop signal (`SIGINT` or `SIGTERM`), a journal write failure, an agent login failure, an agent that died or did not start, a transport failure, or a previous run of this state that is still alive. | Run again with the same `--state`. |

Any other code, for example 137 after `SIGKILL`, has no recovery meaning. Treat it as a failure, keep the state, and run again by hand.

The runbook hash covers `agent.yaml`, each `do: { file }` and each `vars` file. It does not cover the scripts that `run` calls. The inputs hash covers the resolved `vars`, the values of `${{ env.NAME }}` and the identity of each MCP server (name, command, args, URL and the names of its env and header keys). Secret values are not part of a hash, so a rotated credential does not invalidate the state.

### What must survive between runs

| Item | Where it lives | If it is missing |
| --- | --- | --- |
| The state directory | `--state` | The run starts from the beginning. |
| The agent's session store | Codex (codex-acp 2.5.0): `CODEX_HOME/sessions/` | codex-acp reports a missing session as an internal error, so the runner exits 75. Agents that answer `-32002` give "session unavailable". |
| The agent's login | For Codex, `CODEX_HOME/auth.json` | Exit 75 until the login is back. |
| The working directory, at the same absolute path | `--cwd` | Exit 1. |
| The workspace files, including uncommitted and untracked files | The caller's checkout | The runner cannot detect this. The caller must restore the workspace before it starts the runner. |
| The runbook and prompt files | The repository | Exit 3. |

### Rules for runbooks that use `--state`

- **Script steps and checks must be safe to run twice.** A stop during a script step runs the script again.
- **An agent step can receive its prompt a second time** after a stop during a model turn. The resumed session keeps the agent's own record of what it did.
- **Actions outside the workspace must go through MCP tools.** The runner records each MCP tool call that can change something outside, before and after the call. It cannot see shell commands, `curl` or other built-in agent tools.
- **Annotate MCP tools.** A tool with `readOnlyHint: true` is not recorded. A tool with `idempotentHint: true` is recorded, but a lost result does not stop the run. Any other tool, also a tool with no annotations, stops the run as `unknown` when its result is lost. The runner trusts the annotations.
- **A step that reads MCP resource inputs stops as `unknown`** after a stop once its prompt went out, because a new read can differ.
- **A provider swap always ends the session.** A later step never reopens a session from before a swap.

`SIGINT` and `SIGTERM` stop a run with `--state` cleanly and exit 75. With `--state`, the runner starts itself again as the leader of a new process group, so that it can stop every agent, script and MCP server process that the run started.

## OpenTelemetry export

The runner can send each run to any OTLP collector as traces and logs. Export is off until you set an endpoint:

```sh
OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp.example.com \
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Basic%20<token>" \
acp-runner run ./my-agent
```

The runner sends OTLP/HTTP with JSON bodies to `<endpoint>/v1/traces` and `<endpoint>/v1/logs`. It reads these variables:

| Variable | Effect |
|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Base URL for both signals. |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | Full URL for one signal. A signal without an endpoint is not sent. |
| `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_EXPORTER_OTLP_TRACES_HEADERS`, `OTEL_EXPORTER_OTLP_LOGS_HEADERS` | `key=value` pairs, separated by commas and URL-encoded. A signal header replaces a shared header with the same key. |
| `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES` | Resource attributes. The default service name is `acp-runner`. |
| `TRACEPARENT`, `TRACESTATE` | A W3C trace context. The run becomes a child of this span, so that several runs can share one trace. |
| `OTEL_SDK_DISABLED=true` | Turns export off. |
| `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true` | Adds step failure output and the run error to the logs. These are off by default. |

**Spans.** The spans follow the [OpenTelemetry GenAI semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai). These conventions have Development status and can change.

| Runner part | Span name | Kind | `gen_ai.operation.name` |
|---|---|---|---|
| Run | `invoke_workflow <runbook name>` | INTERNAL | `invoke_workflow` |
| Model step | `invoke_agent <provider>` | CLIENT | `invoke_agent` |
| Script step | `step <step id>` | INTERNAL | none |
| Tool call that the agent reports | `execute_tool <tool name>` | INTERNAL | `execute_tool` |

Each step attempt gets its own span. A provider swap is a span event on the run span. A failed span has status ERROR and an `error.type` of `exit_nonzero`, `incomplete` (a tool call that did not finish before its step ended) or `_OTHER`. A model step span carries the ACP session ID as `gen_ai.conversation.id`. It also carries the token usage when the agent reports it, and the agent name and version as `acp.agent.name` and `acp.agent.version`.

**`gen_ai.provider.name`.** The runner selects the first value that it finds:

1. `otel.providerName` on the provider in `agent.yaml`.
2. The name that the agent reports when it starts. `@agentclientprotocol/claude-agent-acp` gives `anthropic`, `@agentclientprotocol/codex-acp` gives `openai` and `gemini-cli` gives `gcp.gen_ai`.
3. The provider ID from `agent.yaml`.

```yaml
providers:
  bedrock-proxy:
    command: npx
    args: [-y, my-acp-proxy]
    model: claude-sonnet
    otel:
      providerName: aws.bedrock
```

**Logs.** Each run-record event is also one log record, with `eventName` set to `acp.<event>`. Logs arrive while a step runs. A span arrives only when it ends. Transitions use severity DEBUG, and failures use ERROR.

**Failures in export.** Export never fails a run. The runner sends a batch every two seconds. It writes one warning when a collector refuses or rejects data, and it does not retry. The queue holds 2048 records for each signal and drops the oldest records when it is full. At the end of a run, the runner waits up to three seconds for the last batch.

## Security

Run only workflows, providers and MCP servers that you trust. Shell steps run directly on your machine. Shell steps and local MCP servers inherit your environment, which can contain credentials.

By default, the runner approves recognized allow options from an agent. Use `--confirm` to review agent permission requests and runner-handled file writes. The runner cancels requests when it cannot select a valid option. Without an interactive terminal, the CLI rejects permission requests. Shell steps and runner-handled file reads do not require confirmation. File access is not restricted to `--cwd`.

A step's `mcpServers` setting limits only the servers that the runbook adds. The proxy enforces these limits for each tool call. An agent keeps its own built-in tools, and Codex also loads its own MCP servers. These controls do not provide a sandbox.

The MCP proxy listens only on `127.0.0.1`. Each proxy uses a random authentication token. Requests require this token, the expected host and the `/mcp` path. The proxy rejects requests with an `Origin` header. The runner passes the token to the agent through ACP.

Secrets that the runbook reads as `${{ secrets.NAME }}` are kept away from the agents:

- An agent process does not get these environment variables. The runner puts the values into MCP headers and MCP server `env` itself. The agent keeps its own login, for example `CLAUDE_CODE_OAUTH_TOKEN`.
- Before the runner sends a prompt, it replaces each known secret value in the prompt text and in the attached check output with `[REDACTED]`.
- The MCP proxy refuses a tool call when the arguments contain a known secret value. The runner logs the tool name, but not the value.

Agent processes also do not get the `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_EXPORTER_OTLP_TRACES_HEADERS` and `OTEL_EXPORTER_OTLP_LOGS_HEADERS` variables, because these usually hold the collector credential. OpenTelemetry export uses the same redacted events as the run trace.

These controls do not stop an agent that finds a secret another way, for example in a file or through a built-in tool that does not use the proxy. They also do not detect encoded or partial forms of a secret.

Logs, plans and run traces redact known credential values of at least four characters. These values come from `${{ secrets.NAME }}` placeholders, credential-named environment variables, MCP headers and credential-named workflow variables. Redaction cannot detect every secret or its encoded forms. Review output before you share it. New trace directories use mode `0700`, and new trace files use mode `0600`.

## Write agents with Claude Code

The package includes the `create-acp-agent` skill. The skill helps Claude Code design, write and test a new agent folder. Install it once:

```bash
acp-runner skill install
```

Then ask Claude Code for a new agent, or type `/create-acp-agent`. Run the command again after an upgrade to get the newest version. The standalone binary from `bun run compile` does not contain the skill.

## Examples

- [riddle](examples/riddle/agent.yaml): two agents and two checks, the smallest example.
- [hello-world](examples/hello-world/README.md): release notes from a local MCP issue tracker, with a writer, a reviewer, shell gates and a repair loop.

## Development

```bash
bun test tests       # tests
bun run typecheck    # type check
bun run lint         # lint the examples
bun run build        # build dist/
bun run compile      # build a standalone binary in dist-bun/
```

CI runs the tests on both Bun and Node (`npm run test:node`).

## License

[MIT](LICENSE)
