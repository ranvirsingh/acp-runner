# acp-runner

Compose ACP agents and shell steps into a YAML workflow, using coding CLIs you are already logged into — Claude Code, Codex, or Gemini.

The YAML declares agent harnesses, MCP tools, ordered steps, checks, and transitions. Each model step selects a harness; shell steps run deterministic commands. The runner manages ACP sessions and switches agents as the workflow requires.

```
agent folder
  → runner (CLI)
    → session spine (fixed states, one per turn)
      → ACP client (JSON-RPC over stdio)
        → vendor CLI (Claude Code / Codex / Gemini)
```

Uses the Zed **Agent Client Protocol** (`@agentclientprotocol/sdk`). Not IBM/BeeAI ACP, not A2A, not `acp-sdk`.

## Contents

- [Quick start](#quick-start)
- [Why acp-runner?](#why-acp-runner)
- [The agent folder](#the-agent-folder)
- [`agent.yaml` reference](#agentyaml-reference)
- [Prompts and variables](#prompts-and-variables)
- [Control flow](#control-flow)
- [MCP servers](#mcp-servers)
- [Providers, sessions and swaps](#providers-sessions-and-swaps)
- [CLI](#cli)
- [Logs and run records](#logs-and-run-records)
- [Programmatic API](#programmatic-api)
- [Development](#development)
- [Docker](#docker)

## Quick start

You need [Bun](https://bun.sh) 1.4.0+ and the vendor CLIs selected by your workflow **already logged in on this machine**. The example below uses both Claude Code and Codex. The runner talks to their ACP agents as child processes; it does not hold API keys of its own and does not work in a clean sandbox that has no login.

Run only workflows and MCP servers you trust: they execute commands on your machine, and agent permission requests are automatically approved by default. Pass `--confirm` to review agent permission requests interactively; shell steps still run directly. Run traces can contain workspace paths and sensitive command output, so review them before sharing.

```bash
bun install
work=$(mktemp -d)
cp -R examples/hello-world/. "$work"
bun run start -- "$work" --cwd "$work"
```

The example declares a Claude `writer` and a Codex `reviewer` under `providers.agentHarness`, with explicit selections on every model step. It checks the release input, fetches sample issues through local MCP, drafts and reviews `release-notes.md`, and checks issue coverage with up to two repair loops. It needs Node 20+ with `npx`, plus `sh` and `jq` for the deterministic gates. To use different agents, edit the harness declarations as described in the [example README](examples/hello-world/README.md#choose-different-acp-agents); CLI `--provider` does not override explicit step selections. Usage limits and charges depend on each provider, account, and plan.

Check a runbook without running it:

```bash
bun run lint
```

Node 20+ works as a parity runtime (`npm run start:node`, `npm run test:node`).

## Why acp-runner?

`acp-runner` is designed for scripted, repeatable multi-turn agent tasks against your local repositories, using an existing authenticated vendor CLI. Usage limits and charges depend on the provider, account, and plan.

### Comparison

| Dimension | GitHub Actions | Goose | `acp-runner` |
| --- | --- | --- | --- |
| **Execution target** | Remote ephemeral runner (post-push) | Local machine | **Local repository working tree** |
| **Agent engine** | Ephemeral process / shell script | Custom LLM prompt loop | **Vendor coding CLI (Claude Code, Codex, Gemini)** |
| **Credentials** | API tokens (`ANTHROPIC_API_KEY`) | API tokens or local Ollama | **Local interactive login (`claude login`, `codex login`)** |
| **Marginal cost** | Metered token billing | Metered token billing | **Depends on the vendor CLI's provider, account, and plan** |
| **Turn protocol** | Process exit code (pass/fail) | Internal loop | **Bidirectional Zed ACP (JSON-RPC over stdio)** |
| **In-flight control** | Kill process | TUI interaction | **Protocol cancellation (`session/cancel`), dynamic tool scoping** |
| **Multi-vendor swaps** | Script stitching | Single provider | **Declarative provider swaps mid-run (e.g. Claude writes, Codex audits)** |
| **Tool scoping** | Global runner environment | Global MCP servers | **Turn-by-turn MCP allow/deny proxy without session drops** |

### When to use what

- **Use an interactive CLI directly** (`claude`, `agent`) when exploring, experimenting, or solving an unfamiliar bug that needs direct human steering.
- **Use GitHub Actions** when running unattended CI checks, publishing packages, or enforcing gates across a team after pushing code.
- **Use `acp-runner`** when running ordered, repeatable multi-turn procedures on your local machine — test-repair loops, migration gates, checked schema outputs, or cross-vendor reviews where one CLI writes and another audits. Repeatable procedures do not guarantee identical agent outputs.


## The agent folder

An agent is a **folder**. `agent.yaml` is the note; everything it refers to lives beside it:

```
examples/hello-world/
  agent.yaml          # check-inputs → collect → draft → review → verify
  release.txt         # required release version input
  README.md           # walkthrough and additional configuration
  scripts/
    check.sh          # deterministic gate for issues and release notes
    check-inputs.sh   # deterministic gate for the release input
  templates/
    draft.md          # file prompt for release notes
  tools/
    release.mjs       # local MCP tool, resource and review prompt
    issues.json       # sample issue catalogue
```

Point the runner at the folder and it reads the `agent.yaml` inside. Point it at a file and that file is the runbook, under any name. Either way **every path inside the runbook resolves against the runbook's own directory** — `--cwd` is only the workspace the agent edits. Folders can live anywhere: in this repo, in another one, or on their own.

An illustrative multi-provider runbook for your own agent folder (create the referenced prompt file and authenticate the selected providers before using it):

```yaml
name: provider-swap
description: Implement, verify, then harden a change
provider: claude            # claude | codex | gemini | gemini-pro
model: claude-sonnet-5
providers:
  agentHarness:
    gemini-pro:             # add a vendor, or replace a built-in
      command: gemini
      args: ["--model", "gemini-2.5-pro", "--acp"]
  fallback: [claude, codex, gemini]
  onSpawnError: swap        # swap | fail
vars:
  done_token: DONE
steps:
  - id: implement
    do: |
      Implement the change.
  - id: verify
    do: |
      If the work is complete, reply {{done_token}} only.
      Otherwise continue.
  - id: harden
    provider: codex         # different provider → swap
    vars:
      review_focus: security and edge cases
    file: prompts/harden.md # long bodies live outside the YAML
  - id: second-opinion
    provider: gemini-pro    # a provider declared above
    vars:
      review_focus: anything the last reviewer missed
    file: prompts/harden.md
```

### Two kinds of step

| Kind | Looks like | What happens |
| --- | --- | --- |
| **Model turn** | has `do`, `file` or `promptRef` — or nothing at all | The text is sent to the vendor CLI as one `session/prompt` |
| **Script** | has `run:` and no prompt body | A shell command runs in `--cwd`. Exit 0 is success, anything else is failure |

A model step may **also** carry `run:`. Then the turn happens first and the command runs afterwards as its check — that is how "do the work, then prove it" fits in one step.

## `agent.yaml` reference

### Top level

| Field | Meaning |
| --- | --- |
| `name` | Name of the workflow |
| `description` | What the workflow does |
| `provider` | Provider for every step that does not set its own |
| `model` | Default when neither the step nor its selected harness sets a model |
| `vars` | Template variables for the whole runbook |
| `providers.agentHarness.<name>` | Extra agent CLIs, or replacements for a built-in — `{ command, args }` each |
| `providers.mcpServers` | MCP servers this runbook may use — stdio, `http` or `sse` |
| `providers.fallback` | Providers to try, in order, after a spawn or auth failure. Defaults to `[claude, codex, gemini]` |
| `providers.onSpawnError` | `swap` along `providers.fallback` (default), or `fail` immediately |
| `steps` | The agenda. At least one |

### Step

| Field | Meaning |
| --- | --- |
| `id` | Label for the turn. Must be unique, and cannot be the reserved `end` or `fail` |
| `do` | Turn text, inline |
| `file` | Turn text from a file, relative to the YAML. Cannot be combined with `do` |
| `promptRef` | Turn text from an MCP server's prompt catalogue. Exclusive with `do`, `file` and `run` |
| `run` | Shell command — a pure script step, or the check that follows a turn |
| `provider` / `model` | Override for this step only |
| `vars` | Variable overrides for this step |
| `servers` | Which declared MCP servers this step gets, and which of their tools |
| `on.success` / `on.failure` | Where to go next. A step id, or the terminal `END` / `FAIL` |
| `retry` | Shorthand for "on failure, run me again" — `{ maxAttempts, fallback }` |

Unknown keys, wrong types, bad provider names, duplicate ids, transitions to steps that do not exist and references to servers that were never declared are all **schema errors**, reported together rather than one at a time.

## Prompts and variables

### Prompt files

Anything longer than a few lines belongs in its own file:

```yaml
steps:
  - id: harden
    file: prompts/harden.md
```

The path resolves against the **YAML file's own directory**. A prompt file is a template like an inline body, so `{{...}}` inside it is rendered.

### Two namespaces

A bare `{{name}}` means `{{vars.name}}`.

| Placeholder | Reads |
| --- | --- |
| `{{done_token}}`, `{{vars.done_token}}` | Top-level `vars`, overridden by `steps[].vars` |
| `{{env.GITHUB_TOKEN}}` | The process environment. The prefix is required — there is no fallback from `vars` to `env` |

An unresolved placeholder is an **error**, not blank output and not passthrough:

```
step verify: unknown variable {{done_tokn}}
```

There is no escape for a literal `{{`, so a prompt cannot currently ask an agent to write Handlebars-style template text.

### Where a value can come from

```yaml
vars:
  done_token: DONE                    # scalar
  schema: { file: schemas/out.json }  # file contents, relative to the YAML
  branch: { env: GIT_BRANCH }         # environment variable, must be set
  ddl: { resource: "postgres://prod/schemas/public", server: database }
```

Scalars, `{ file }` and `{ env }` are read once when the runbook loads, and what they return is **not** re-scanned for placeholders. A missing file or an unset variable fails the run before anything spawns. `{ resource }` is read per step over the runner's own MCP connection — see [Resources and prompts](#resources-and-prompts).

No context variables are injected automatically. To use the working directory in a template, declare it yourself under `vars`.

### Automatic failure context

The runner attaches failure details automatically when the next model turn runs. Write only the task in `do`, `file` or `promptRef`; no feedback placeholder is needed:

```yaml
- id: implement
  do: Implement the change.
```

The ACP request contains the task as its first text block and, when a failure is pending, a second block identifying the failed step, source, kind, actual process exit code when available, and diagnostic output. This covers check commands, input preparation and agent-turn errors. Command reports include both stdout and stderr when available.

An undelivered failure survives successful helper scripts and provider swaps until an agent turn completes. A successful rerun of the original check clears its pending failure; a newer workflow failure replaces it. Subsequent agent turns receive no old failure block unless a new failure occurs. Successful command output is never sent as failure context. Retry limits and routing still come from `retry` and `on.failure`.

Failure blocks are capped at 16,384 UTF-8 bytes, including their header. Long output keeps its tail and an explicit truncation notice; long identifying labels are bounded too. This limit is separate from the 2,000-byte log-event limit. Files still carry work between providers; conversation history is not transferred automatically.

`{{feedback}}`, `{{vars.feedback}}` and their `${{ ... }}` forms are rejected by lint and template rendering with an instruction to remove them. Escaped literals and text returned by MCP prompts are not reinterpreted as runner templates.

Every model step needs a body — `do:`, `prompt:`, `file:` or `promptRef:`. A step with none of those and no `run:` is rejected when the runbook loads. There is no command-line goal to fall back on: the prompt lives in the runbook.

### Secrets

Keep them out of prompt text. Interpolating a secret pastes it into the model's context. Use `env:` on an MCP server instead — and note the vendor child process already inherits the runner's full environment.

## Control flow

By default each step falls through to the next one in list order, and the run finishes after the last one. `on:` changes that:

```yaml
steps:
  - id: verify
    run: npm test
    on:
      success: notify
      failure:
        target: fix
        maxAttempts: 3
        fallback: alert_failure

  - id: fix
    do: "Fix failing tests."
    on:
      success: verify
      failure: FAIL

  - id: notify
    run: ./scripts/notify.sh
    on:
      success: END

  - id: alert_failure
    run: ./scripts/alert.sh
    on:
      success: END
      failure: FAIL
```

- **`END`** ends the run as a success, **`FAIL`** ends it as a failure. Both are case-insensitive, and no step may use them as an id.
- `maxAttempts` counts traversals of that one edge. Once it is exceeded the run goes to `fallback` — a step id, `END`, or `FAIL` — and fails if there is none.
- A step that fails with no `on.failure` and no `retry` fails the run.

`retry` is shorthand for looping back to the same step:

```yaml
- id: draft
  do: "Write the plan."
  run: node verify-plan.mjs
  retry: { maxAttempts: 3, fallback: FAIL }
```

## MCP servers

Tools are declared once for the whole runbook, keyed by server name, under `providers`:

```yaml
providers:
  mcpServers:
    release:
      command: node
      args: ["tools/release.mjs"]
```

Each entry is the same object as `.mcp.json`, `claude_desktop_config.json` and Cursor's `mcp.json` — a map of `{command, args, env}` — so a block from any MCP server's README pastes in one level deeper. YAML is a superset of JSON, and `type: stdio` is accepted so a pasted block keeps working.

Remote servers are declared natively, with no `mcp-remote` stdio wrapper:

```yaml
providers:
  mcpServers:
    jira:
      type: sse
      url: https://mcp.example.com/jira/sse
      headers:
        Authorization: "Bearer {{env.JIRA_TOKEN}}"
    database:
      type: http
      url: https://mcp.example.com/postgres
```

A server is either stdio (`command`) or remote (`type: http|sse` with `url`); mixing the two sets of keys is a lint error. `command`, args, `env`, `url` and `headers` are all templates, and an unset `{{env.X}}` fails the run before anything spawns.

### Paths resolve against the agent folder

ACP has no `cwd` field for a stdio server, so a bare relative path would otherwise resolve against `--cwd`. The runner rewrites each `command` and arg to an absolute path if — and only if — it is relative, contains a `/`, and names something that exists in the folder:

| Written | Becomes |
| --- | --- |
| `python`, `node`, `npx` | unchanged — no `/`, so it is a PATH lookup |
| `tools/server.py` (exists) | `<folder>/tools/server.py` |
| `tools/server.py` (absent) | unchanged |
| `--profile`, `sonnet` | unchanged — no `/`, never a folder path |
| `/opt/bin/serve` | unchanged — already absolute |

A tool shared between agents lives in no one folder, so give it an absolute path or `{{env.TOOLS_DIR}}/slack/server.py`.

### Which turn gets which server, and which tools

```yaml
steps:
  - id: report
    servers: [gcp-usage]                 # every tool of that server
  - id: investigate
    servers:
      telemetry: { allow: ["query_*", "list_*"] }
      database: { allow: ["select"], deny: ["drop_*", "truncate_*"] }
  - id: notify
    servers: []                          # no runbook server at all
  - id: wrap-up                          # no servers: → every server
```

| Written | Tools visible to the step |
| --- | --- |
| `servers` omitted | every tool of every declared server |
| `servers: []` | none |
| `servers: [a, b]` | every tool of `a` and `b` |
| `servers: { a: {} }` | every tool of `a` |
| `servers: { a: { allow: [p] } }` | tools of `a` matching any allow pattern |
| `servers: { a: { deny: [p] } }` | tools of `a` not matching any deny pattern |
| both | allow filters first, then deny removes; deny always wins |

Patterns match the bare tool name as the server reports it, never a vendor prefix. `*` is the only wildcard and matches any run of characters. Matching is case-sensitive. A name that was never declared is a lint error.

**Changing the scope does not cost a swap.** Consecutive model steps with different server or tool scopes share one session and one conversation history. Only a provider or model change starts a new body.

> ⚠ `servers:` scopes what the runbook adds, not everything the turn has. What the runner registers on `session/new` is added to whatever the vendor CLI is already configured with — its own file and shell tools, and its own MCP servers from the user's config. A step with `servers: []` still had `mcp__aws-docs__*` on the machine this was tested on. It removes your server from that turn; it is not a sandbox.

### The runner proxy

The runner runs its own MCP server in-process and registers exactly one entry, named `runner`, on `session/new`. It holds the client connections to every declared server itself, so:

- Remote transports work on any vendor, whether or not the vendor speaks them.
- A step names the tools it may call, not just the server, because the proxy decides what `tools/list` returns.
- Changing scope is a `notifications/tools/list_changed`, not a new child process. Downstream server state survives a provider swap too.
- Every `tools/call` is checked against the current scope regardless of what the vendor believes is listed. A call outside scope comes back as an error naming the tool and the step.

The proxy is registered over `http` on `127.0.0.1`. A vendor whose `initialize` does not report `agentCapabilities.mcpCapabilities.http` fails at spawn with an error naming the provider; Claude, Codex and Gemini all report it.

It adds one segment to the tool name the model sees: a tool that was `mcp__release__list_issues` is now `mcp__runner__release__list_issues`. A runbook with no `providers.mcpServers` never starts a proxy.

### Resources and prompts

A variable can be bound to an MCP resource, and a turn body can come from a server's prompt catalogue:

```yaml
steps:
  - id: investigate
    file: prompts/investigate.md
    vars:
      schema_ddl: { resource: "postgres://prod/schemas/public", server: database }
  - id: review
    promptRef:
      server: jira
      name: incident_review
      arguments:
        service: "{{service}}"
    servers: [jira]
```

The runner reads the resource over its own connection, so `server` does not have to appear in the step's `servers` scope — reading a resource exposes no tool to the model. Text content is bound as-is; a blob, a missing resource, a read error, or anything over 256 KiB fails the step the way a missing `{ file }` does. Bigger data belongs on disk via a `run:` step.

`promptRef` is a fourth kind of step body, exclusive with `do`, `file` and `run`. Its `arguments` values are templates. The runner calls `prompts/get` and concatenates the text of every returned message, blank line between messages; a message with non-text content fails the step. Any pending failure is sent as a separate ACP text block, just as for `do` and `file`. The flattened prompt text is left unchanged.

## Providers, sessions and swaps

Run on the **same machine** that is already logged in. Do not put the ACP process in a clean Docker sandbox.

| Provider | Login | ACP command |
| --- | --- | --- |
| Claude Code | `claude` / `claude login` | `npx -y @agentclientprotocol/claude-agent-acp` |
| Codex | `codex login` | `npx -y @agentclientprotocol/codex-acp` |
| Gemini | `gemini` | `gemini --acp` |

If no provider is named anywhere, the runner uses Claude Code.

### Stay, swap, finish

- Same provider, no model change → **stay**: another `session/prompt` on the live connection
- A different set of MCP servers or tools → **no swap**, the proxy re-scopes in place
- Different provider, or a model that needs a new body → **swap**: stop the child, spawn the other CLI, and send that step's own text
- No more steps, or an `END` transition → **finish**
- Spawn or auth failure, or a `FAIL` transition → **swap** along `providers.fallback`, or **fail**

Vendor session history does **not** survive a swap. Only files on disk do. Nothing is prepended to the first prompt after a swap — if the next body needs prior context, say so in that step's text.

### The session spine

```
idle → spawning → inSession → working ↔ awaitingPermission → turnComplete
     → choosingNext → shuttingDown → finished | failed
```

A script step runs in `executingScript` instead of `spawning`/`working`. `choosingNext` is where the runbook is read and the stay / swap / finish decision is made. These names are the vocabulary of the logs and the run records, not just internal states.

Permission requests are auto-approved by default: the runner picks the first `allow_once` / `allow_always` option, or the first option offered. Pass `--confirm` to prompt before approving tool calls in an interactive terminal. The runner also answers the ACP `fs/read_text_file` and `fs/write_text_file` requests, and reuses the vendor's saved login. It calls `authenticate` only if `session/new` returns ACP's authentication-required error, then retries session creation once.

### Adding or changing a provider

`provider` at the top level selects the default harness; each step can select its own. Set `model` on a harness to give that agent its own model. Model precedence is step → selected harness → top-level default → adapter default (or the current model when reusing a session). `providers:` holds how those are launched: `agentHarness` for the agent CLIs the runner speaks ACP to, `mcpServers` for the tool servers it speaks MCP to, plus `fallback` and `onSpawnError`. The three built-in harnesses are a table of command and arguments, nothing more, and an `agentHarness` entry adds a vendor or replaces how a built-in is launched:

```yaml
provider: amp
providers:
  agentHarness:
    amp:
      command: amp
      args: ["--acp"]
    claude:
      command: npx
      args: ["-y", "@agentclientprotocol/claude-agent-acp"]
      model: claude-sonnet-5
```

A name declared here is valid anywhere a provider name goes — the top-level `provider:`, a step's `provider:`, `providers.fallback`, `--provider`. Any other name is a schema error listing what is known.

The model is set the standard ACP way, with `session/set_config_option` after `session/new`. For an adapter that takes its model only on the command line, put its model flag in `args` instead of setting `model`. For example:

```yaml
providers:
  agentHarness:
    gemini-pro:
      command: gemini
      args: ["--model", "gemini-2.5-pro", "--acp"]
    gemini-flash:
      command: gemini
      args: ["--model", "gemini-2.5-flash", "--acp"]
```

Switching between those is a provider change, which already starts a new body. An explicit `model:` fails if the adapter cannot select it through ACP; the runner does not silently ignore it.

`BUILTIN_PROVIDERS`, `providerSpec` and `knownProviderIds` are exported for callers embedding the runner. Everything above the spawn command — the engine, the proxy, the records — is vendor-neutral.

## CLI

```bash
bun run start -- [agent.yaml | folder] --cwd <dir> [flags]
```

| Argument | Meaning |
| --- | --- |
| first positional | An agent folder or a YAML file. Defaults to `./agent.yaml`. Optional. Any other positional argument is rejected — prompts belong in the runbook, not the command line |
| `--cwd <dir>` | The workspace the agent edits. Created if missing. Defaults to the current directory |
| `--provider <id>` | Override the runbook's top-level `provider:` (`claude`, `codex`, `gemini`). A step's own `provider:` still wins |
| `--trace <dest>` | Where the run trace goes: `stdout` (default), `file`, `both`, or `off` |
| `--confirm` | Prompt before approving tool calls (defaults to auto-approve) |
| `--version` | Print the runner version |

Exit code is 1 on a failed run, 0 on a finished one.

```bash
bun run start -- lint [agent.yaml | folder ...]
```

Checks runbooks without running them and prints `ok <path>` or `fail <path>` with every problem found. Defaults to `./agent.yaml`. Exit code is 1 if any runbook fails.

`Ctrl-C` cancels the run. If a turn is in flight the runner sends ACP `session/cancel` and
lets the vendor finish the turn as cancelled, so the reply and any tool calls already in
progress end cleanly instead of the child being killed mid-write. A vendor that ignores
the notification is closed after a one second grace period. The run then fails without
trying `providers.fallback` — a cancelled run is not a spawn failure. A second `Ctrl-C`
kills the process outright.

## Logs and run records

Every run emits a **trace** — one JSON object per event, describing what ran, how long it took, what it returned, and why the runner went where it went next. `--trace` decides where it goes.

| `--trace` | stdout carries | `<cwd>/.runner/run-<id>.jsonl` |
| --- | --- | --- |
| `stdout` *(default)* | the trace | not written |
| `file` | the human log | written |
| `both` | the trace | written |
| `off` | the human log | not written |

The file is written incrementally, so `tail -f` works during a run. The two forms carry identical bytes — `--trace both` then diffing stdout against the file gives no output.

The **human log** is one line per event, not per streamed chunk. A reply arrives as dozens of `session/update` notifications, so chunks log their kind only (`message`, `thought`) and a line identical to the one before it is dropped. The text itself is logged once, when the turn finishes. Tool calls print the **tool name**, not the raw `toolu_…` id.

```
[runner] provider-swap provider=claude model=claude-sonnet-5 cwd=/tmp/demo
[step] implement (claude)
  [state]  idle → spawning
  [claude] spawn npx -y @agentclientprotocol/claude-agent-acp
  [claude] session sess_01… (1 mcp)
  [claude] thought
  [claude] tool Bash completed
  [claude] reply "Looking at the files now.\n\nI will add the test."
  [state]  working → turnComplete
[runner] next: swap → harden
[step] harden (codex)
  [state]  shuttingDown → spawning
  [codex]  spawn npx -y @agentclientprotocol/codex-acp
  [codex]  reply "Tightened the error handling."
[runner] finished
```

`[runner]` is the run itself, `[step]` names the step and the provider it runs on, and everything inside a step is indented one level. Lines from a vendor CLI carry that provider's name, so a swap is visible where it happens.

Trace events:

| `ev` | Carries |
| --- | --- |
| `run.start` | agent, cwd, yaml path, provider, model, step ids |
| `step.start` | step id, index, `model` or `script`, attempt number, provider, model, servers in scope |
| `step.end` | outcome, duration, exit code, feedback (truncated at 2 KB, flagged when it is) |
| `tool` | tool name, `pending` / `completed` / `failed`, owning step, duration |
| `transition` | from state, to state, decision, target, and why (`on.success`, `on.failure`, `fallthrough`, `fallback`, `maxAttempts`) |
| `swap` | from/to provider and model, and the reason (`provider`, `model`, `servers`, `spawn_error`) |
| `run.end` | outcome, total duration, steps run, swaps, error |

## Programmatic API

Install from a checkout:

```bash
bun add /path/to/acp-runner   # or: npm install /path/to/acp-runner
```

Run an existing agent folder:

```typescript
import { runAgent, loadConfig } from "acp-runner";

const config = loadConfig({
  yamlPath: "./agents/code-reviewer",
  cwd: process.cwd(),
});

const { outcome, context } = await runAgent({
  config,
  onStateChange: (previous, current) => console.log(`${previous} → ${current}`),
});

console.log(outcome);           // "finished" | "failed"
console.log(context.turnText);  // the last reply
```

Or define the runbook in TypeScript, with no YAML file on disk — `yamlPath` still decides where relative prompt files and tools are looked up:

```typescript
import { runAgent, type RunnerConfig } from "acp-runner";

const config: RunnerConfig = {
  yamlPath: "./agent.yaml",
  cwd: process.cwd(),
  runbook: {
    name: "security-fixer",
    provider: "claude",
    model: "claude-sonnet-5",
    steps: [
      { id: "audit", run: "npm audit" },
      { id: "fix", do: "Fix the vulnerabilities the audit reported." },
      { id: "verify", run: "npm test", on: { failure: "fix" } },
    ],
  },
};

const { outcome } = await runAgent({ config });
```

Also exported: `parseArgs`, `lintRunbook`, `validateAgentYaml`, `AcpSession`, `McpProxy`, `RunRecorder`, the provider table, the scope helpers, and the runbook types. `createAgentActor` remains as a thin compatibility wrapper over `runAgent` for older callers.

## Development

Bun 1.4.0 is the canonical toolchain; type checking uses TypeScript 7.0.2.

```bash
bun test tests        # the test suite
bun run typecheck     # tsc --noEmit
bun run lint          # schema + resolution check over examples/
bun run build         # dist/ (tsup + declarations)
bun run compile       # standalone executable in dist-bun/
```

Node 20+ parity commands are `npm run test:node` and `npm run start:node`. CI runs both runtimes.

`bun run lint` checks `examples/hello-world/agent.yaml` against the schema — unknown keys, wrong types, bad provider names, duplicate step ids — then resolves every step, so missing prompt files and unresolved `{{placeholders}}` are caught too. All problems are reported, not just the first. The same schema runs on every start. Point it anywhere:

```bash
bun run start -- lint path/to/agent-folder path/to/other.yaml
```

Lint stubs `{{env.X}}` and `{ env: X }` values, so it runs without secrets. The run itself still fails on an unset variable before anything spawns.

### Example

The repository includes one example folder: [hello-world](examples/hello-world/README.md).
Its single `agent.yaml` chains a shell input check, issue collection through local MCP,
a release-notes draft, a review using an MCP prompt, and a shell output check with
bounded repair loops. Files pass work between steps, and MCP tool scope changes per
turn. The final result is `release-notes.md`.
The example README also covers running the gates directly, changing the writer and
reviewer harnesses, traces, permissions, and cancellation. As shipped, the run needs
authenticated Claude Code and Codex CLIs, Node with `npx`, `sh`, and `jq`; no remote MCP
service is required.

## Docker

The runner passes its whole environment to spawned providers and supports `{{env.VAR}}` in runbooks and MCP server definitions. The provider CLI inside the image still needs credentials or a login of its own.

```dockerfile
FROM oven/bun:1.4.0

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
ENTRYPOINT ["bun", "src/cli.ts"]
```

Copy the example to a temporary workspace as in Quick start before mounting it:

```bash
work=$(mktemp -d)
cp -R examples/hello-world/. "$work"
docker run --rm \
  --env-file .env \
  -v "$work:/agent" \
  acp-runner /agent --cwd /agent
```

`bun run compile` produces a standalone executable instead, so a deployment image can carry `dist-bun/acp-runner` with no runtime at all — `bun run compile:linux-arm64` cross-compiles for ARM64 Linux hosts.
