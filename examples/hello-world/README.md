# Hello-world: release notes with two agents

Turn sample Taskboard issues into `release-notes.md` using a Claude writer, a Codex
reviewer, local MCP, and shell gates. `agent.yaml` holds the workflow, harnesses,
models, MCP configuration, and transitions.

## Run it

You need Node 20+ with `npx`, `sh`, `jq`, and Claude Code and Codex authenticated
with access to `claude-sonnet-5` and `gpt-6-luna`. Model usage uses those accounts.
Run `codex login` for ChatGPT sign-in and `codex login status` to check it.
The runner reuses saved logins; the local MCP server needs no credentials.

From the repository root, with Bun 1.4.0+ and dependencies installed:

```sh
work=$(mktemp -d)
cp -R examples/hello-world "$work/workflow"
bun run start -- "$work/workflow" --cwd "$work/workflow" --trace file
cat "$work/workflow/release-notes.md"
```

Or use the npm archive without Bun (replace the archive path):

```sh
work=$(mktemp -d)
npm install --prefix "$work" /absolute/path/acp-runner-0.1.0.tgz
cp -R "$work/node_modules/acp-runner/examples/hello-world" "$work/workflow"
"$work/node_modules/.bin/acp-runner" "$work/workflow" --cwd "$work/workflow" --trace file
cat "$work/workflow/release-notes.md"
```

Both commands use a temporary workspace. Outputs and `.runner/` trace files stay
there. `release.txt` selects `1.2.0`; change it to `1.1.0` for a smaller release.

## What runs

```text
check-inputs → collect → draft → review → verify → END
                 ↑                         │
                 └──── failed check ───────┘
```

1. **Check inputs:** `scripts/check-inputs.sh` checks the release before any model turn.
2. **Collect:** the writer calls MCP `list_issues` and saves shipped records to `issues.json`.
3. **Draft:** the writer uses `templates/draft.md` and the MCP style resource to write the notes.
4. **Review:** the reviewer uses the MCP `review_release` prompt and edits the notes.
5. **Verify:** `scripts/check.sh` checks records, headings, and issue coverage. Failure
   returns to collection with feedback, at most twice, then stops with `FAIL`.

Collection and drafting share a session. Switching agents starts a fresh session;
files carry the work between them. The shell gates check structure and issue
references; the reviewer checks the prose.

`scripts/` contains the deterministic gates, `templates/` contains the drafting
prompt, and `tools/` contains the Node MCP server and sample data. Only collection
exposes the MCP tool to the agent; the runner fetches resources and prompts itself.
Step tool scopes control runbook MCP tools, not the harness's own tools.

## Choose different ACP agents

Edit `command`, `args`, and `model` under `providers.agentHarness` in `agent.yaml`:

- `writer`: `@agentclientprotocol/claude-agent-acp`, model `claude-sonnet-5`.
- `reviewer`: `@agentclientprotocol/codex-acp@1.13.1`, model `gpt-6-luna`.

The Codex adapter is pinned so `npx` does not reuse an older installed adapter
that lacks the requested model.

Models are selected through ACP. A step's `model` overrides its harness's model.
With only a Claude login, copy the writer's command, args, and model into the
reviewer declaration. The roles still get separate sessions. CLI `--provider`
does not override these explicit step selections; `onSpawnError: fail` stops if
an adapter cannot start.

## Permissions

Both harnesses' ACP permission requests are **auto-approved by default**. Run
without `--confirm` for unattended approvals; add it to approve requests yourself.
Auto-approval does not itself disable a harness's sandbox or deny rules.

For Codex full-access mode, prefix either runner command above with
`INITIAL_AGENT_MODE=agent-full-access`, as documented in the
[Codex ACP runtime options](https://github.com/agentclientprotocol/codex-acp#runtime-options).
Ctrl-C cancels the current turn; files already written remain.

## Check locally

Run the gates against the temporary workspace (the output gate needs generated files):

```sh
(cd "$work/workflow" && sh scripts/check-inputs.sh && sh scripts/check.sh)
```

From the repository root, check the example without live model calls:

```sh
bun run lint
bun test tests/hello-world.test.ts
```

See the [root README](../../README.md) for the full configuration reference.
