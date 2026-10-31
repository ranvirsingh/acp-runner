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

- [Bun](https://bun.sh) 1.4 or later. Node 20 or later also works.
- The agent CLIs that your workflow names, installed and logged in on this machine. For example, `claude` and `codex login`.
- `npx`, if a provider starts through `npx`, as in the example.

## Install

The package is not on npm yet. Install it from source:

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
| `acp-runner run [folder\|file]` | Runs the workflow. `--cwd <dir>` sets the folder that the agents edit. `--trace off\|file\|stdout\|both` sets where the run trace goes. `--confirm` asks you before each tool call. |
| `acp-runner lint [folder\|file ...]` | Finds errors in the YAML, the prompt files and the variables. It starts nothing. |
| `acp-runner plan [folder\|file]` | Prints each step with its agent, model, tools, filled-in prompt, check and next step. It starts nothing. |
| `acp-runner check [folder\|file]` | Starts each agent, logs in and sets the model. It sends no prompt. |
| `acp-runner skill install` | Copies the `create-acp-agent` skill to `~/.claude/skills/`. |

A folder argument means the `agent.yaml` in that folder. With no argument, the commands use `./agent.yaml`. Every command exits with code 1 on failure.

## `agent.yaml` at a glance

| Field | Meaning |
| --- | --- |
| `providers.<name>` | An ACP agent: `command`, `args` and a required `model`. Steps refer to it by name. |
| `mcpServers.<name>` | An MCP server (stdio, `http` or `sse`) that steps can use. |
| `vars` | Values for `{{NAME}}` placeholders. A value can be text, `{ file }`, `{ env }` or `{ resource, mcpServer }`. |
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

**Placeholders.** `{{NAME}}` reads `vars`. `{{env.NAME}}` reads an environment variable. A placeholder that has no value is an error.

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
    headers: { Authorization: "Bearer {{env.JIRA_TOKEN}}" }
```

**Run records.** `--trace file` writes one JSON event for each line to `<cwd>/.runner/run-<id>.jsonl`.

## How a run works

- Steps that use the same provider share one session. A step with a different provider stops the current agent and starts the new one.
- Conversation history does not carry over to a different agent. Files in the workspace carry the work from step to step.
- When a check fails, the runner attaches the command output to the next prompt automatically.
- `Ctrl-C` cancels the current turn cleanly over ACP.

## Security

Run only workflows and MCP servers that you trust. Shell steps run directly on your machine. By default, the runner approves every permission request from an agent. Use `--confirm` to approve each request yourself. A step's `mcpServers` setting limits only the servers that the runbook adds. It is not a sandbox: an agent keeps its own built-in tools, and Codex also loads its own MCP servers.

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
