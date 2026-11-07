# Plan: durable workflow recovery

Status: draft, revision 3, after two critic reviews by GPT Sol 6.1 (section 15). Date: 2026-11-07. Target release: acp-runner 0.1.0-beta.6.

## 1. Goal

A fresh runner reads a journal and finds where an earlier run of the same workflow stopped. It then does one of these:

- It continues the open step visit and reopens the same ACP session.
- It starts the next step when the journal records that the earlier step completed.
- It stops and reports an unknown outcome when it cannot prove that a repeat is safe.

The journal tracks workflow progress only. Engineer's Git checkpoint commits stay the record of implementation work. The two records are separate.

## 2. Sources

| Source | What it shows |
| --- | --- |
| [engine.ts](../src/runtime/engine.ts) | The step loop, session reuse, inputs, prompt, check and transition order |
| [session.ts](../src/runtime/session.ts) | `initialize`, `session/new`, model and permission setup, `session/prompt`, child process cleanup |
| [decide.ts](../src/runtime/decide.ts) | Transitions, `retry`, `maxAttempts`, `fallback`, loop counts, swap |
| [failure.ts](../src/runtime/failure.ts) | How check output goes into the next prompt |
| [inputs.ts](../src/mcp/inputs.ts) | MCP resource inputs, read once per visit |
| [schema.ts](../src/config/schema.ts) | The agent.yaml schema. It is strict and has no `finally` key |
| [cli.ts](../src/cli.ts) | `run` flags and the SIGINT handler |
| `node_modules/@agentclientprotocol/sdk` 1.4.0: `dist/schema/types.gen.d.ts`, `dist/acp.d.ts` | `LoadSessionRequest`, `ResumeSessionRequest`, `agentCapabilities.loadSession`, `sessionCapabilities.resume`, `RequestError.resourceNotFound` (`-32002`) |
| ACP v1 docs: [Initialization](https://agentclientprotocol.com/protocol/initialization), [Session setup, loading sessions](https://agentclientprotocol.com/protocol/session-setup#loading-sessions), [Prompt turn](https://agentclientprotocol.com/protocol/prompt-turn) | Capability negotiation, `session/load` replay, `session/prompt` and `session/cancel` |
| `@agentclientprotocol/codex-acp` 2.5.0, npx cache `c51fd8e4d04c136d`, `dist/index.js` | Line 49731 advertises `loadSession: true`. Line 49710 advertises `sessionCapabilities.resume: {}`. Lines 41580–41636: both methods call Codex `threadResume` with `threadId = sessionId`, the request `cwd` and the request `mcpServers` |
| naplanwriting `agents/engineer/agent.yaml` | Engineer's steps and providers. All three providers pin codex-acp 2.5.0 |
| naplanwriting `agents/engineer/scripts/launch-engineer.sh`, `check-change.sh`, `leaks-secret.sh` | Worktree, `CODEX_HOME`, run directory, cleanup trap, planning and implementation runs, draft PR, push and publish logic |
| naplanwriting `agents/scripts/acp-runner.sh` | Pins `acp-runner@0.1.0-beta.5` through `pnpm dlx` |
| naplanwriting `.github/workflows/acp-runner.yaml` | Engineer runs on `ubuntu-24.04`, 150-minute timeout, one Codex login at a time, `resolve` runs on `main` only |
| GitHub Actions runs 42202681713, 42187380035, 42147721067 (2026-11-06) | Recent Engineer failures. Each one ended the job. Nothing could resume |
| [GitHub workflow cancellation](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-cancellation) | The signal sequence a cancelled job gets |

## 3. Current behavior

### 3.1 Runner

1. `runAgent` keeps all run state in memory, in `SessionContext` ([engine.ts:158](../src/runtime/engine.ts:158)). Nothing is written that a second process can read back. The `.runner` trace from `RunRecorder` is a log for people. It is not a recovery record.
2. A session opens only through `session/new` ([session.ts:435](../src/runtime/session.ts:435)). The runner never calls `session/load` or `session/resume`.
3. The runner has one live session at a time. A step reuses it when the step's effective provider equals the session's provider ([engine.ts:245](../src/runtime/engine.ts:245)). A step with no `provider` inherits the current one ([decide.ts:172](../src/runtime/decide.ts:172)).
4. A change of effective provider is a swap. The runner closes the session before the next step runs ([engine.ts:426](../src/runtime/engine.ts:426)). This is also true when the next step is a script step that names another provider. A later step with the first provider gets a new session.
5. The engine reads MCP resource inputs once per visit and gives the same values to the prompt and to the check ([engine.ts:322](../src/runtime/engine.ts:322), [engine.ts:355](../src/runtime/engine.ts:355)).
6. A failed check becomes `pendingFailure` ([engine.ts:138](../src/runtime/engine.ts:138)). The next agent prompt carries it ([engine.ts:348](../src/runtime/engine.ts:348)). It is cleared only after `session/prompt` returns ([engine.ts:350](../src/runtime/engine.ts:350)). A prompt error keeps it ([engine.ts:367](../src/runtime/engine.ts:367)). A later pass of the same check also clears it ([engine.ts:153](../src/runtime/engine.ts:153)).
7. A prompt or spawn error sets `lastError`. The engine then fails the run directly and does not apply `on.failure` or `retry` ([engine.ts:374](../src/runtime/engine.ts:374)).
8. Loop counts live in memory as `"<from>-><to>"` keys. Only a non-terminal `on.success` or `on.failure` edge adds 1 ([decide.ts:153](../src/runtime/decide.ts:153)). Terminal targets and `fallback` edges add nothing ([decide.ts:124](../src/runtime/decide.ts:124)). `why` is `null` for a failure with no transition ([decide.ts:50](../src/runtime/decide.ts:50)).
9. `cli.ts` handles SIGINT only ([cli.ts:160](../src/cli.ts:160)). SIGTERM kills the process with no cleanup. Agent and script child processes are stopped only on the live close path ([session.ts:305](../src/runtime/session.ts:305)). After a SIGKILL of the runner they keep running.
10. agent.yaml has no `finally` step. The only `finally` is the `try/finally` in `runAgent` ([engine.ts:439](../src/runtime/engine.ts:439)). It closes the session and the MCP proxy.

### 3.2 Engineer

1. Each launch makes a new random worktree, `mktemp -d $RUNNER_TEMP/engineer-XXXXXX/repo` (launcher line 56).
2. `CODEX_HOME` is a new temporary directory that holds `auth.json` (line 120). Codex keeps its session threads under `CODEX_HOME`. The exit trap deletes this directory and the worktree (lines 60–74). So a fresh runner can never reopen an Engineer session today.
3. One `run_agent` function runs both `planning.yaml` and `agent.yaml` (lines 129–134).
4. Builder commits checkpoint commits during `implement`. `check-change.sh` also checks uncommitted and untracked files. The launcher commits what is left only after the whole run succeeds (line 317). It pushes the branch only when `run_agent` fails (lines 311–315). A killed job loses unpushed and uncommitted work.
5. The publish phase needs `title`, `plan-pr.md` and `plan_sha`, which the planning phase sets (lines 290–310).
6. The job runs on a GitHub-hosted `ubuntu-24.04` VM. A new attempt gets a new VM. (The Engineer README still says `mac-heavy`. That text is stale.)
7. Engineer's builder steps share one session through providerless script steps. The `review` and `security_review` steps use other providers, so `address_review` gets a new builder session.
8. Engineer's steps read no MCP resource inputs.

## 4. Decisions

### 4.1 Taken by you

| # | Decision |
| --- | --- |
| D1 | Every event carries `step` and `visit`. A passback or a retry starts a new visit, even when it reuses the session. |
| D2 | One state directory per workflow run, not per agent.yaml. |
| D3 | `run_started` stores a hash of the runbook, like a lock file. A different hash makes the state invalid, and the work starts with a new state file. Section 7.4 shows how this revision applies D3 (see 4.2). |
| D4 | The plan names where the adapter keeps its session data. If that data is missing, the session is unavailable. |
| D5 | The caller passes the run key. The runner has no default location. No key means today's behavior. |
| D6 | Reopen with `session/resume` when the agent advertises it. Otherwise use `session/load`. Otherwise the session is unavailable. |
| D7 | A `prompt_sent` event goes to the journal before each prompt. |
| D8 | An append counts as acknowledged only after `fsync` returns, for every line. |
| D9 | The real-PR test uses a locally packed acp-runner inside naplanwriting. |
| D10 | When the runbook hash differs, the runner refuses and exits 3. The caller (Engineer's launcher) starts again under a new run key. |
| D11 | After a crash during a model turn, the runner reopens the session and sends the step prompt once more, for every agent step. There is no YAML key for this. The resend does not go out when the visit is in doubt (D12). |
| D12 | The MCP proxy keeps a tool-call ledger in the journal. It records each MCP call that may change something outside, before and after the call. When a call's outcome is unknown, the run stops with `unknown` instead of moving on or resending (7.9). Revision 3 removed revision 2's automatic replay of finished calls, after review 2. |
| D13 | A provider swap always ends the session. A later step never resumes a session from before a swap. Recovery reopens a session only inside the same run of steps with one provider. |
| D14 | Exit codes are 0 finished, 1 failed or refused, 2 unknown outcome, 3 runbook or inputs changed, 75 stopped and recoverable. The caller treats any other code as a failure. There is no `status` command. |

Note on D6: in SDK 1.4.0, `session/resume` is not marked experimental (`session/fork` is). The `session/load` path must still pass every test, because other adapters may advertise only `loadSession`.

### 4.2 Changes from revision 1, from the critic review

- **D3 is applied by the caller, not by the runner (D10).** The runner refuses a journal whose hash differs. It does not move the old state aside and start again by itself. The caller then picks a new run key, which gives the new state file that D3 asks for. Reason: an automatic restart under the same key repeats work that already finished, or work whose side effect was interrupted.
- **A step check no longer proves that an interrupted prompt finished.** A check runs after the reply, and `run: true` would always pass. An interrupted turn now gets one resend of the full step prompt (D11). The check shortcut is gone.
- **Feedback is consumed at `prompt_completed`, not at `prompt_sent`.** This matches the engine, which clears `pendingFailure` only after the prompt returns.
- **The journal records swaps.** The reader does not copy the engine's provider inheritance rules.

### 4.3 Findings that change the brief

- **No YAML `finally` exists.** The schema is strict and rejects the key. This plan does not add one. "Best-effort flush on graceful shutdown" means the runner's own `finally` block and signal handlers (section 7.8).
- **A graceful stop must not write a terminal event.** Today an abort ends as `failed`. With a journal, a stopped run must stay recoverable.
- **Engineer's passback after review gets a new session** (3.2 item 7). This stays as it is. A swap always ends the session (D13).

## 5. CLI contract

```
acp-runner run [agent.yaml|folder] --cwd <dir> --state <dir> [--trace ...] [--confirm]
```

- `--state <dir>` is the run key. The caller builds the path from its own key, for example `$STATE_ROOT/engineer/issue-1970/run-42202681713/agent`.
- The directory holds:
  - `agent.state.jsonl`: the journal.
  - `agent.state.lock`: the writer lock. It is local to one host. Never copy it to another host.
  - `feedback/`: saved check output that a later prompt must carry.
- Without `--state`, the runner behaves exactly as it does today and writes no journal.
- One state directory belongs to one runbook. A caller that runs two runbooks for one job gives each its own directory.

Exit codes:

| Code | Meaning | Journal |
| --- | --- | --- |
| 0 | Finished | `run_finished` `finished` |
| 1 | Failed, or the state was refused (corrupt, other `cwd`) | `run_finished` `failed`, or unchanged |
| 2 | Unknown outcome. A person must decide | `run_finished` `unknown` |
| 3 | The runbook hash or the resolved inputs differ. The caller must choose a new run key | unchanged |
| 75 | Stopped and recoverable. Run again with the same `--state` | no terminal event |

Code 75 covers six cases: a stop signal, a journal write failure, an agent login failure, an agent process that died, a transport failure, and a previous process tree that is still alive. These are infrastructure failures. They apply to a live prompt as well as to a reopen: the runner leaves the visit open and writes no `step_completed`.

These five codes are final (D14). They are acp-runner's own codes. Only 75 matches a `sysexits.h` meaning (`EX_TEMPFAIL`). 2 means unknown outcome here, not a usage error: acp-runner reports a usage error with 1. The README must list all five.

Any other exit code, for example 1 from a runner bug or 137 from SIGKILL, has no recovery meaning. The caller must not read the journal to guess one. It treats the run as failed and keeps the saved state, so a person can run the job again.

## 6. Journal schema

One JSON object per line, UTF-8, each line ends in `\n`. The reader reads lines in order. The schema is generic. It names steps, providers and sessions from agent.yaml only. No transcript, tool call, prompt text or Engineer field goes into the journal.

### 6.1 Events

| Event | Fields | Written |
| --- | --- | --- |
| `run_started` | `v`, `runbook`, `inputs`, `runner`, `cwd` | First line, before any step |
| `step_started` | `step`, `visit` | Before the step reads inputs or does anything else |
| `session_attached` | `step`, `visit`, `provider`, `sessionId`, `origin` | After the runner knows the session id, before the first prompt of the visit |
| `session_resumed` | `step`, `visit`, `provider`, `sessionId`, `method` | After ACP accepts `session/resume` or `session/load` |
| `prompt_sent` | `step`, `visit`, `sessionId`, `kind`, `feedback`? | Before `session/prompt` |
| `tool_started` | `step`, `visit`, `call`, `server`, `tool` | Before the proxy forwards an MCP call that may change something outside (7.9) |
| `tool_completed` | `step`, `visit`, `call`, `isError` | After the tool returns a result, before the proxy gives it to the agent |
| `prompt_completed` | `step`, `visit`, `stopReason`, `feedback`? | After `session/prompt` returns, before the step's check runs |
| `step_completed` | `step`, `visit`, `outcome`, `why`, `next`, `swap`?, `feedback`? | After the outcome and feedback are durable, before the next step starts |
| `run_finished` | `outcome`, `reason`? | After the last `step_completed`, or when recovery stops |

The four seed events from the brief keep their names and fields. `visit` is added to all of them (D1).

### 6.2 Why each extra field and event exists

| Item | Recovery case it serves |
| --- | --- |
| `visit` | Visit 2 of `implement` after a passback must not be read as a recovery of visit 1. |
| `run_started.runbook` | agent.yaml or a prompt file changed between the crash and the restart. The old journal no longer matches the steps (D3). |
| `run_started.inputs` | The files are the same, but an environment value changed what the prompts say or which MCP endpoint a server name points at. A resend would then do a different task, or act on a different target. |
| `run_started.v`, `runner` | A runner with another journal version must refuse the file instead of misreading it. `v` is the schema version. `runner` is for people. |
| `run_started.cwd` | ACP `session/resume` and `session/load` need the session's absolute `cwd`. A fresh runner with another `--cwd` must refuse. |
| `session_attached.provider` | A fresh runner must spawn the right provider command to reopen the session. |
| `session_attached.origin` | `new` means `session/new`. `carried` means the visit uses the session that was already active. A lost `new` session with no prompt sent can be replaced. A lost `carried` session cannot, because the step prompt depends on the earlier conversation. |
| `session_resumed.method` | Shows which ACP method worked, for diagnosis. |
| `prompt_sent` | A crash with no reply. Without it, the reader cannot tell "prompt never sent" from "prompt sent, reply lost" (D7). |
| `prompt_sent.kind` | `step` is the step prompt. `resend` is the single recovery resend (7.6). An open `resend` stops recovery. |
| `prompt_completed` | A crash during the step's check. The turn ended, so the runner only runs the check again. It does not prompt again. |
| `tool_started` | A crash, or a lost reply, during an outside action. The runner must not move past it or resend over it (7.9). |
| `tool_completed` | Shows that the outside action returned, so the visit is not in doubt. |
| `call` | Pairs a `tool_completed` with its `tool_started`. |
| `prompt_completed.feedback` | Marks the pending feedback as consumed, at the same point where the engine clears `pendingFailure`. |
| `step_completed.why` | Loop counts are rebuilt from it (6.4 rule 10). |
| `step_completed.swap` | `true` when the engine decided `swap`. The reader then knows the active session closed, without copying the engine's provider inheritance rules. |
| `step_completed.feedback` | The pending failure after this step. It must reach the next agent prompt after a restart, as it does in one process today. |
| `run_finished` | The terminal outcome. A later runner with the same key exits at once with the same outcome. |

Not added, and why:

- A sequence number or timestamp. The single-writer rule (7.2) means lines cannot interleave or repeat. No recovery case needs a time.
- A `session_closed` event. `step_completed.swap` carries the same fact on a line the runner writes anyway.
- Loop counts or `stepIndex` fields. The reader derives both from `step_completed` events.
- Per-provider session ids. The engine has one active session, and a swap ends it (D13).

### 6.3 Field values

- `v`: `1`.
- `runbook`: `sha256:<hex>` over agent.yaml bytes, then each `do: { file }` and `vars` `file` source, in sorted path order. Scripts called by `run` are not hashed (section 11).
- `origin`: `new` or `carried`.
- `method`: `session/resume` or `session/load`.
- `kind`: `step` or `resend`.
- `inputs`: `sha256:<hex>` over the resolved non-secret values that prompts and checks use (`vars`, `env` references), and each MCP server's identity: name, `command`, `args`, `url`, and the names of its `env` and `headers` keys. Secret values are left out, so a rotated credential does not invalidate the state.
- `outcome` in `step_completed`: `success` or `failure`.
- `why`: `on.success`, `on.failure`, `fallback`, `maxAttempts`, `fallthrough` or `null`. `null` covers a failure with no transition, and a prompt error that is not an infrastructure failure (section 5).
- `next`: a step id, `END` or `FAIL`. It comes from the engine's actual decision: `finish` is `END`, `fail` is `FAIL`.
- `feedback`: a path relative to the state directory, for example `feedback/validate-1.json`. The file holds the `StepFailure` object with redacted output.
- `call`: an integer, 1 for the first recorded call in a visit. A fresh runner continues from the highest number in the journal for that visit.
- `outcome` in `run_finished`: `finished`, `failed` or `unknown`.
- `reason`: a fixed code: `session_unavailable`, `resend_interrupted`, `tool_in_doubt`, `inputs_unrecoverable` or the failure text the engine already reports.

### 6.4 Reader rules

1. Read every line. If the last line has no `\n`, drop it. That is a torn append.
2. Any line that ends in `\n` and does not parse is corruption, including the last line. Refuse the journal and name the line.
3. The first line must be `run_started` with `v: 1`. Otherwise refuse.
4. A **visit** is the events from one `step_started` up to the matching `step_completed`. Its key is (`step`, `visit`). `visit` is 1 for the first `step_started` of a step and goes up by 1 each time.
5. An **open visit** is a visit with no `step_completed`. At most one visit can be open. It is always the last one.
6. A **repeated visit** is a new `step_started` for a step that has an earlier `step_completed`. A passback and a retry to the same step both make a repeated visit.
7. The run is **terminal** when the journal has `run_finished`.
8. The **active session** is the `sessionId` and `provider` from the latest `session_attached` or `session_resumed`. A later `step_completed` with `swap: true` clears it.
9. The **pending feedback** is the `feedback` of the latest `step_completed`, unless a later `prompt_completed` carried that same path.
10. **Loop counts**: for each `step_completed` with `why` `on.success` or `on.failure` and a step id in `next`, add 1 to `"<step>-><next>"`.
11. The **turn state** of an open visit comes from its prompt events only. The turn is **open** when the visit has a `prompt_sent` with no later `prompt_completed`. Session and tool events never change the turn state.
12. A visit is **in doubt** when it has a `tool_started` with no matching `tool_completed`, for a tool that is not `idempotentHint: true`. The tool's annotation comes from the proxy's catalogue at recovery time.

## 7. Write and recovery rules

### 7.1 Durable append

1. Open the journal with `O_APPEND`.
2. Write one complete line.
3. Call `fsync` on the file. When the call creates the file, also `fsync` the directory.
4. The append is acknowledged only when `fsync` returns without error.
5. Before the first append of a process, truncate an unterminated last line (6.4 rule 1) and `fsync`.

Feedback files use the same rule: write to a temporary name, `fsync`, rename, `fsync` the directory. Then append the event that refers to the file.

### 7.2 Writer assumptions

- One writer per state directory. The runner creates `agent.state.lock` with `O_EXCL`. The lock holds the host name and one process-group id.
- **One process group for the whole run.** With `--state`, `acp-runner run` starts itself again as the leader of a new process group (`detached: true`, same stdio) and forwards signals to it. The inner runner writes the lock with its own group id before it spawns anything. Every agent, script and MCP server child then inherits that group, including children that the MCP SDK spawns. No child can start before the lock records its group, so there is no gap between spawn and registration.
- On close, the runner signals the whole group, so grandchildren such as `npx` → `codex` stop too.
- A lock from the same host is stale only when no process in the recorded group is alive. If any of them is alive, the old work may still change the workspace. The runner exits 75 and changes nothing.
- A lock from another host makes the runner refuse. Portable state never includes the lock (section 9). The deployment must give each run key to one job at a time, and the previous job must have ended. For Engineer, the concurrency group `acp-auth-codex` serializes jobs, and a new GitHub attempt starts only after the earlier job ends.
- The journal is append-only. The runner never edits or deletes a line, except the torn-tail truncation in 7.1.
- The order of lines is the order of actions. Each event is written **before** the action it allows, or **after** the result it records is durable. So every prefix of the journal is a safe state. A missing event means one of two things: the action did not happen, or its result is not trusted.

### 7.3 Failed append or lost acknowledgement

1. If an append or `fsync` fails, the runner does not retry it in that process.
2. The runner does not start the action that the event was to allow.
3. If a turn is streaming, the runner sends `session/cancel`. Then it closes the session, its process group and the MCP proxy.
4. The runner exits with code 75 and says the journal may be behind.
5. A lost acknowledgement means the line may or may not be on disk. Both are safe, by the prefix rule in 7.2. The next runner reads whatever is on disk.

### 7.4 Start-up decision

The runner reads the state directory, then acts on the first row that matches:

| Journal state | Action |
| --- | --- |
| No file, or an empty file | New run. Write `run_started`. |
| Corrupt (6.4 rule 2) or unknown `v` | Refuse. Exit 1. Change nothing. |
| `runbook` or `inputs` hash differs | Refuse. Exit 3. Change nothing. The caller starts a new run key (D3, D10). |
| `cwd` differs from `--cwd` | Refuse. Exit 1. Change nothing. |
| Lock held by live work (7.2) | Exit 75. Change nothing. |
| `run_finished` present | Print the recorded outcome. Exit with its code. Run nothing. |
| Only `run_started` | Start the first step as visit 1. Do not write `run_started` again. |
| Last event is `step_completed` with `next` `END` or `FAIL` | Write `run_finished` with the matching outcome. Exit. |
| Last event is `step_completed` with a step id | Start that step as a new visit. |
| An open visit | Continue it (7.5). |

### 7.5 Continue an open visit

Rebuild the context first: step, visits, loop counts, pending feedback and the active session (6.4). Then find the turn state (6.4 rule 11) and act on the first matching row:

| Open visit state | Action |
| --- | --- |
| The visit is in doubt (6.4 rule 12) | Stop: `run_finished` `unknown`, reason `tool_in_doubt`. Exit 2. |
| Script step | Run the script again. Scripts must be safe to run twice (section 11). |
| Agent step, the step reads MCP resource inputs, and the visit has a `prompt_sent` | Stop: `run_finished` `unknown`, reason `inputs_unrecoverable`. The inputs the prompt and check used are gone, and a new read may differ. |
| Agent step, turn open, last open prompt has `kind: resend` | Stop: `unknown`, reason `resend_interrupted`. |
| Agent step, turn open, `kind: step` | Follow 7.6. |
| Agent step, the visit has `prompt_completed` | The turn ended. Read inputs again, run the step's check if it has one, decide, and write `step_completed`. |
| Agent step, no `prompt_sent` | Nothing went to the agent. Get a session (below), then send the step prompt with the pending feedback. |

**Get a session when no prompt went out.**

1. If the visit has `session_attached`, reopen that session (7.7).
2. If it is unavailable and `origin` is `new`, open a new session and write a new `session_attached` with `origin: new`.
3. If it is unavailable and `origin` is `carried`, stop: `unknown`, reason `session_unavailable`. The step prompt depends on the earlier conversation.
4. If the visit has no `session_attached`, start the visit as normal: reopen the active session as `carried` if one exists, else open a new one.

Before any prompt, the runner sets the MCP proxy scope for the step again, as a normal visit does.

### 7.6 Interrupted turn

The runner cannot see inside an interrupted turn. ACP gives no prompt id and no receipt. With `session/resume` the client gets no history. A step check runs after a reply and cannot show that the task finished. So the runner asks the agent to finish the work, once (D11):

1. If the visit is in doubt (7.9), stop: `run_finished` `unknown`, reason `tool_in_doubt`. Exit 2.
2. Reopen the session (7.7). If it is unavailable, stop: `run_finished` `unknown`, reason `session_unavailable`. Exit 2. A new session would not know what the earlier turn did.
3. Write `prompt_sent` with `kind: resend` and the pending feedback.
4. Send the original step prompt and the pending feedback, after one fixed line. The line says that the earlier turn was interrupted. It tells the agent to check the workspace and its own earlier tool calls, and not to repeat a finished action.
5. Continue as normal: `prompt_completed`, the check, `step_completed`.

A second interruption, while the resend is open, stops the run with `resend_interrupted`.

The tool ledger (7.9) stops the resend when an MCP action has an unknown outcome. It does not stop the agent from repeating an action that finished. The runner cannot see actions that the agent takes with its own built-in tools, for example a shell command. For Engineer this is safe: models hold no GitHub token, the MCP servers are read-only, and the launcher does every push and PR action itself.

### 7.7 Reopen a session

1. Spawn the provider from the locked runbook, with the same `hiddenEnv` and environment rules as `session/new`.
2. Send `initialize` and read `agentCapabilities`.
3. Build `mcpServers` again. The runner's MCP proxy gets a new URL and a new auth header. Both ACP methods take a new `mcpServers` list.
4. If `sessionCapabilities.resume` is present, send `session/resume` with `sessionId`, `cwd` and `mcpServers`.
5. Else, if `loadSession` is true, send `session/load` with the same fields. Updates that arrive before the load response are history replay. The runner logs them as replay and keeps them out of the turn text.
6. Else the session is unavailable.
7. Read an error from step 4 or 5 like this:
   - `-32002` (resource not found, `RequestError.resourceNotFound` in SDK 1.4.0): the session is unavailable.
   - `-32000` (authentication required), a spawn error, a closed connection or a timeout: exit 75. The state stays recoverable after the login or the network is repaired.
   - Any other error: exit 75.
   The runner does not try `session/load` after a failed `session/resume`. codex-acp sends both to the same `threadResume` call, so the second try adds nothing.
8. After ACP accepts, write `session_resumed`.
9. Apply the model and the permission mode again, the same way as after `session/new` ([session.ts:446](../src/runtime/session.ts:446), [session.ts:457](../src/runtime/session.ts:457)).

What must survive besides the session id:

| Item | Where it lives | If it is missing |
| --- | --- | --- |
| The agent's session store | codex-acp 2.5.0: `CODEX_HOME/sessions/` (phase 0, 10.1) | Session unavailable. codex-acp 2.5.0 reports it as `-32603`, so the runner exits 75 (10.1) |
| Agent login | `CODEX_HOME/auth.json`, written from the launcher's secret | Exit 75 |
| The working directory, same absolute path | `--cwd` | Refuse at start-up |
| The workspace the session refers to | Git worktree, including uncommitted and untracked files | The caller must refuse to start the runner (section 9) |
| The runbook and prompt files | The repository, locked by `runbook` | Exit 3 |
| Feedback files | `<state>/feedback/` | Refuse. Exit 1 |

### 7.8 Graceful shutdown

- SIGINT and SIGTERM both abort the run. Today only SIGINT does.
- The abort path cancels a streaming turn and closes the session, the child process groups and the proxy. It exits with 75. It writes no terminal event.
- GitHub cancellation sends SIGINT, then SIGTERM, then kills the process. Every required event was durable before its action, so a kill at any point leaves a safe prefix.
- The `finally` block in `runAgent` waits for an append in progress and releases the lock. It is best effort. Correctness never depends on it.

### 7.9 Tool-call ledger

This takes one idea from Temporal: write down each outside action before and after it runs. Temporal goes further. It replays finished activities by position, because its workflow code is deterministic. An agent is not deterministic, so after a resend the runner cannot tell which new call is "the same" as an old one. Revision 2 tried to match calls by their content. The second review showed that this can return the wrong saved result, or let an uncertain action run again (section 15, review 2, finding 1). So the ledger does not match or replay calls. It only **detects** an outside action whose outcome is unknown, and stops before the workflow moves on.

Every MCP tool call goes through one function, `McpProxy.callTool` ([proxy.ts:118](../src/mcp/proxy.ts:118)). The ledger lives there.

**Which calls the ledger records.** The proxy reads the tool's MCP annotations from its catalogue:

- `readOnlyHint: true`: no outside effect. The proxy records nothing.
- `idempotentHint: true`: a repeat with the same arguments has no extra effect. The proxy records the call, but an unfinished call is never "in doubt".
- Any other tool, including a tool with no annotations: the call may change something outside. The proxy records it, and an unfinished call is in doubt. `destructiveHint` and `openWorldHint` do not change this.

**Turn gate.** The engine gives the proxy the active (`step`, `visit`) when it sends a prompt, and clears it when the prompt returns. The proxy reads this context before its first `await`.

- A call that arrives with no active turn gets an error and is never forwarded. Script steps, session reopening and shutdown have no active turn.
- After the prompt returns, the engine closes the gate and waits for every call that the proxy accepted to finish. Only then does it write `prompt_completed`.

**Live run.** For a recorded call, the proxy does these steps in order:

1. Take the next `call` number for the visit. Numbers start at 1 and continue from the highest number already in the journal for that visit.
2. Write `tool_started`.
3. Forward the call.
4. When the call returns a result, including a result with `isError: true`, write `tool_completed`. Then return the result to the agent.
5. When `client.callTool` throws, write nothing more. The downstream action may have run and its reply may be lost, so the call stays in doubt.

All journal appends, from the engine and from the proxy, go through one queue in the runner process. If an append fails, the queue marks the journal as failed. From then on the proxy rejects every call before it forwards it, and the runner stops with exit 75 (7.3).

**The in-doubt rule.** A visit is **in doubt** when it has a `tool_started` with no `tool_completed`, for a tool that is not `idempotentHint: true`. The runner checks this rule at three points:

| Point | Action when the visit is in doubt |
| --- | --- |
| Before it writes `step_completed`, in a live run | Write `run_finished` `unknown`, reason `tool_in_doubt`. Exit 2. |
| At start-up, for an open visit (7.5) | The same. Do not resend. |
| Before a resend (7.6) | The same. |

So the runner never moves past an outside action whose outcome it does not know. A person checks the outside system and decides.

**Finished actions in a resend.** The runner does not suppress them. The resumed session holds the agent's own record of the calls it made and their results. The fixed resend line (7.6 step 3) tells the agent to check that record and not repeat a finished action. For a step whose agent can still repeat an action, the author must give the tool its own idempotency check, or accept the risk. Section 11 lists this limit.

**Limits.**

- The runner cannot see actions that the agent takes with its own built-in tools: shell commands, `curl`, file edits. Rule for runbook authors: actions outside the workspace must go through MCP tools. The README must say this.
- A tool that marks itself `readOnlyHint: true` or `idempotentHint: true` without good reason is not protected. The runner trusts the annotation.
- The ledger records no arguments and no results, so it adds no sensitive data to the state.

## 8. Passback and retry examples

The runbook in 8.1 and 8.2 has `implement` (agent, provider `builder`) and `validate` (script, no provider). `validate` has `on.failure: implement`.

### 8.1 implement → validate → implement, one process

```jsonl
{"event":"run_started","v":1,"runbook":"sha256:9f1c…","runner":"0.1.0-beta.6","cwd":"/work/engineer-1970/repo"}
{"event":"step_started","step":"implement","visit":1}
{"event":"session_attached","step":"implement","visit":1,"provider":"builder","sessionId":"sess_abc","origin":"new"}
{"event":"prompt_sent","step":"implement","visit":1,"sessionId":"sess_abc","kind":"step"}
{"event":"prompt_completed","step":"implement","visit":1,"stopReason":"end_turn"}
{"event":"step_completed","step":"implement","visit":1,"outcome":"success","why":"on.success","next":"validate"}
{"event":"step_started","step":"validate","visit":1}
{"event":"step_completed","step":"validate","visit":1,"outcome":"failure","why":"on.failure","next":"implement","feedback":"feedback/validate-1.json"}
{"event":"step_started","step":"implement","visit":2}
{"event":"session_attached","step":"implement","visit":2,"provider":"builder","sessionId":"sess_abc","origin":"carried"}
{"event":"prompt_sent","step":"implement","visit":2,"sessionId":"sess_abc","kind":"step","feedback":"feedback/validate-1.json"}
{"event":"prompt_completed","step":"implement","visit":2,"stopReason":"end_turn","feedback":"feedback/validate-1.json"}
{"event":"step_completed","step":"implement","visit":2,"outcome":"success","why":"on.success","next":"validate"}
```

- Line 8 records the failed outcome, the chosen next step and the saved feedback.
- Line 10 records that visit 2 reuses `sess_abc`. The session was live, so no reopen happened.
- Line 11 shows that the feedback went to `sess_abc`. Line 12 marks it as consumed.

### 8.2 The same run, with a crash after line 8

A fresh runner reads the journal. The last event is `step_completed` with `next: implement`, so it starts a new visit. The active session is `sess_abc` (6.4 rule 8), because no `step_completed` has `swap: true`. The fresh runner appends:

```jsonl
{"event":"step_started","step":"implement","visit":2}
{"event":"session_attached","step":"implement","visit":2,"provider":"builder","sessionId":"sess_abc","origin":"carried"}
{"event":"session_resumed","step":"implement","visit":2,"provider":"builder","sessionId":"sess_abc","method":"session/resume"}
{"event":"prompt_sent","step":"implement","visit":2,"sessionId":"sess_abc","kind":"step","feedback":"feedback/validate-1.json"}
```

The prompt is the `implement` prompt plus the feedback from `feedback/validate-1.json`. It is the same prompt that one process would send.

### 8.3 Retry to the same step

Engineer's `address_findings` has `on.failure: { target: address_findings, maxAttempts: 2 }`.

```jsonl
{"event":"step_completed","step":"address_findings","visit":1,"outcome":"failure","why":"on.failure","next":"address_findings","feedback":"feedback/address_findings-1.json"}
{"event":"step_started","step":"address_findings","visit":2}
{"event":"session_attached","step":"address_findings","visit":2,"provider":"builder","sessionId":"sess_abc","origin":"carried"}
```

**Retry or recovery.** A retry always follows a `step_completed`, so its `step_started` has a new `visit` number. Recovery of an open visit writes no `step_started`. It adds events under the same (`step`, `visit`). Compare a crash during visit 1 of `address_findings`:

```jsonl
{"event":"step_started","step":"address_findings","visit":1}
{"event":"session_attached","step":"address_findings","visit":1,"provider":"builder","sessionId":"sess_abc","origin":"carried"}
{"event":"prompt_sent","step":"address_findings","visit":1,"sessionId":"sess_abc","kind":"step"}
{"event":"session_resumed","step":"address_findings","visit":1,"provider":"builder","sessionId":"sess_abc","method":"session/resume"}
{"event":"prompt_sent","step":"address_findings","visit":1,"sessionId":"sess_abc","kind":"resend"}
```

Lines 4 and 5 come from the fresh runner. The turn was open after line 3, so the runner sent the one resend. If the runner dies again after line 4, the turn is still open with `kind: step` (6.4 rule 11), so the next runner also sends one resend. If it dies after line 5, the next runner stops with `resend_interrupted`. Loop counts are rebuilt from `step_completed` lines only, so recovery never uses up a retry.

### 8.4 Terminal outcomes

```jsonl
{"event":"step_completed","step":"security_review","visit":1,"outcome":"success","why":"on.success","next":"END"}
{"event":"run_finished","outcome":"finished"}
```

```jsonl
{"event":"prompt_sent","step":"implement","visit":1,"sessionId":"sess_abc","kind":"resend"}
{"event":"run_finished","outcome":"unknown","reason":"resend_interrupted"}
```

A swap, for example `reset_review` (script) → `review` (provider `reviewer`):

```jsonl
{"event":"step_completed","step":"reset_review","visit":1,"outcome":"success","why":"on.success","next":"review","swap":true}
```

## 9. Engineer integration

These changes are in naplanwriting. They are Engineer-specific, so they stay out of the generic schema.

1. **Stable paths.** Use `worktree=$RUNNER_TEMP/engineer-$number/repo`. On a GitHub-hosted runner, `RUNNER_TEMP` is the same path on every VM.
2. **One state directory per runbook.** `planning.yaml` gets `--state "$state/planning"`. `agent.yaml` gets `--state "$state/agent"`. `$state` is `$reports/state/run-$GITHUB_RUN_ID`. A re-run attempt of the same GitHub run has the same run id.
3. **Launcher record.** The launcher writes `$state/launcher.json` with its phase (`planning`, `draft`, `agent`, `publish`), `pr`, `title`, `plan_sha`, `branch_head` and `workspace_ref`. It saves `plan-pr.md` next to it. The publish phase reads these on resume.
4. **Split the Codex home.** `CODEX_HOME` holds `auth.json`, which is a secret. Keep the Codex session store in `$state/codex-sessions` and link it into `CODEX_HOME`. Write `auth.json` new on each launch. Never save `auth.json`.
5. **Workspace checkpoint.** The launcher makes one after each successful runner phase, before it publishes anything, and when the runner exits 75 or the job gets a stop signal:
   1. Stage every tracked and untracked file that Git does not ignore, in a temporary index. Do not move the branch.
   2. Run `leaks-secret.sh` over the staged diff, the same way the publish path does (launcher line 160). On a match, push nothing and mark the state as not recoverable.
   3. Commit the temporary index. Push it to a new ref, `refs/engineer/recovery/run-$GITHUB_RUN_ID/<n>`, where `<n>` goes up by 1 for each checkpoint. A ref is never moved.
   4. Write the SHA to `workspace_ref` and the branch head to `branch_head`, in a new `launcher.json` that replaces the old one by rename. The recorded SHA is the source of truth.
   5. If the push fails, mark the state as not recoverable.
   The checkpoint commits on `engineer/issue-<n>` stay Engineer's record of implementation. The recovery ref only carries the dirty workspace across VMs.
6. **Save and restore state.**
   - Save `$state` (not any lock file) and `.engineer/` in an `if: always()` step.
   - Restore them before launch when `github.run_attempt` is more than 1.
   - The storage backend is open. Workflow artifacts from the earlier attempt are the simplest choice.
7. **Scan before save.** Run `leaks-secret.sh` over everything that the save step would upload. On any match, upload nothing. The next attempt then has no state and starts again under a new key.
8. **Resume path.** When `launcher.json` exists and its state is recoverable:
   - Skip the issue snapshot and every phase before the recorded one.
   - Fetch `workspace_ref` and check that the fetched object has the recorded SHA. Check it out, then run `git reset --mixed <branch_head>`. Tracked changes are dirty again, and untracked files are back.
   - Refuse to resume if `workspace_ref` is missing or its SHA differs.
   - Restore `.engineer/`, `plan-pr.md`, `title`, `pr` and `plan_sha`.
   - Run the runner with the same `--state`. A terminal journal makes it exit at once with the recorded code, and the launcher continues with the phase after it. This covers a launcher that died after the runner finished but before it published.
9. **Exit codes.**
   - Capture the runner's code with `if run_agent; then rc=0; else rc=$?; fi`. The current `if ! run_agent` cannot read it, because inside that branch `$?` is the result of `!`.
   - 0: continue to publish. 75: keep the state and end the job without `hand_off`. 2: `hand_off` with the reason. 3: start again under a new run key (D10). 1 or any other code: `hand_off`, and keep the state.
   - Write the outcome to the step output, for example `disposition=recoverable`. In `acp-runner.yaml`, "Mark the issue failed" runs on `failure() || cancelled()`. It must skip `recoverable`, or a clean stop flips the issue label to `:failed`. "Upload run workspace" already uploads `agent-state` with `if: always()`.
10. **Make `reset-review.sh` safe to run twice.** It appends the review to `review-history.jsonl` and then deletes the review files. A crash between the two would append the same review again. Fix: skip the append when the last history entry already holds the same review.
11. **Write Engineer's outside actions as MCP tools only.** Engineer has none today. Its MCP servers are read-only, and the launcher does every GitHub action.
12. **Local test package (D9).** Run `npm pack` in acp-runner. On a local naplanwriting branch, point `agents/scripts/acp-runner.sh` at the tarball path. The hosted workflow runs `resolve` on `main` only, so the real-PR test runs the launcher on the Mac, not in GitHub Actions. Do not merge that branch.

Limit: a lost VM does not run `if: always()` steps. Only a cancel, a timeout or a failed step saves state. Saving state during the run is a later step.

## 10. Implementation phases

Each phase starts with failing tests ([CLAUDE.md](../CLAUDE.md)). The tests use the fake ACP agent [tests/fixtures/acp-child.ts](../tests/fixtures/acp-child.ts), extended in phase 5.

Crash points in tests are deterministic. `runAgent` takes the journal writer as an option. Tests pass a writer that throws after a named event, or a fixture agent that waits on a file before it replies. The CLI gets no test hook.

| Phase | Work | Tests first |
| --- | --- | --- |
| 0 | Spike, no code merged. With codex-acp 2.5.0 from cache `c51fd8e4d04c136d`: (a) resume a session in a new process with the same `CODEX_HOME` and `cwd`. (b) Do the same after a copy of the session store into a new `CODEX_HOME`. (c) Find the session subfolder. (d) Record the error for an unknown session id and for a missing login. Done on 2026-11-07, results in 10.1 | A written result in this plan |
| 1 | `src/runtime/journal.ts`: append with `fsync`, read, torn tail, corruption, lock with process groups, runbook hash | `tests/runtime/journal.test.ts` |
| 2 | `--state` flag, the process-group re-start (7.2), start-up decisions (7.4), `inputs` fingerprint, exit codes, SIGTERM | `tests/cli.test.ts` |
| 3 | Write points in `engine.ts`, feedback files, `swap`, `why: null` paths. Prompt and spawn errors split into infrastructure failures (exit 75, visit stays open) and other failures. Script steps and checks move from `spawnSync` to an awaited `spawn`. Signal handlers can then run during a long check ([engine.ts:85](../src/runtime/engine.ts:85), [engine.ts:108](../src/runtime/engine.ts:108)) | `tests/runtime/engine.test.ts`: event order for 8.1 and 8.4 |
| 4 | `src/runtime/recovery.ts`: a pure function from journal and runbook to the next action and the rebuilt `SessionContext` | `tests/runtime/recovery.test.ts`: one case per row of 7.4 and 7.5, and each case in the list below |
| 5 | `AcpSession.reopen`: resume, then load when resume is absent, then unavailable. Error mapping. Replay handling. Model and mode re-apply. Group-wide stop on close. Fixture options: advertise resume, load, both or neither. Return `-32002` or `-32000`. Die after a prompt arrives. | `tests/acp-lifecycle.test.ts` |
| 6 | Interrupted turn: one resend, `session_unavailable`, `resend_interrupted` | `tests/runtime/recovery-crash.test.ts` |
| 6b | Tool-call ledger in `McpProxy.callTool`: annotations, turn gate, drain before `prompt_completed`, one append queue, the in-doubt rule at its three points. Phase 0 also lists the annotations of Engineer's three MCP servers. | `tests/mcp/proxy.test.ts` with the fixture MCP server in [tests/fixtures/mcp-tools](../tests/fixtures/mcp-tools) |
| 7 | README section. A note in the create-acp-agent skill that script steps must be safe to run twice, that a crash can make an agent step run its prompt a second time, and that actions outside the workspace must go through MCP tools | None (docs) |
| 8 | Release 0.1.0-beta.6. Engineer integration branch (section 9) | The manual test A3 |

### 10.1 Phase 0 results (2026-11-07)

Setup: codex-acp 2.5.0 (`node dist/index.js` from cache `c51fd8e4d04c136d`, bundled `@openai/codex` 0.165.0). A new temporary `CODEX_HOME` held only a copy of the user's `auth.json`. A small ACP client sent `initialize`, then `session/new`, `session/resume` or `session/load`, then one short prompt. Each call ran in its own process.

| Check | Result |
| --- | --- |
| Capabilities | `initialize` returns `loadSession: true` and `sessionCapabilities.resume`. `authMethods` are `api-key` and `chat-gpt`. |
| (a) Resume, new process, same `CODEX_HOME` and `cwd` | Pass. Process 1 asked for the word PINEAPPLE. Process 2 sent `session/resume` and asked which word it replied with. The reply was `PINEAPPLE`. |
| (b) Resume after a copy into a new `CODEX_HOME` | Pass. The new `CODEX_HOME` held only a fresh `auth.json` and a copy of `sessions/`. No SQLite file was copied. The reply was `PINEAPPLE`. |
| (c) Session subfolder | `CODEX_HOME/sessions/YYYY/MM/DD/rollout-<timestamp>-<sessionId>.jsonl`. One file per thread. The SQLite files at the top of `CODEX_HOME` (`state_5`, `thread_history_1`, `logs_2`, `goals_1`, `queue_1`, `memories_1`) are not needed for a resume. |
| (d) Unknown session id | Both `session/resume` and `session/load` return `-32603` (`Internal error`), with `data.details` = `no rollout found for thread id <id>`. They do **not** return `-32002`. |
| (d) Missing login | `session/new` and `session/resume` both return `-32000` (`Authentication required`). The session store was present for the resume test. |
| `session/load` of a known session | Accepted. It sent 8 `session/update` notifications of history replay before the response. |
| (e) Engineer MCP annotations | `configuration.inspect_configuration`: `readOnlyHint: true`, `idempotentHint: true`. `observability` 0.2.3: all 13 tools have no annotations. `gcloud` 0.5.3: `run_gcloud_command` has no annotations (read from the bundle source; the server did not start here without the gcloud CLI). |

Effect on the design:

- **(a) and (b) pass**, so phase 5 can go ahead.
- **Section 9 item 4** can link only `sessions/` into `CODEX_HOME`.
- **7.7 step 7 and codex-acp 2.5.0.** codex-acp reports a missing session as `-32603`, so the runner reads it as "any other error" and exits 75. It does not reach "session unavailable" (A5a, A5b, A5e) with this adapter. A missing Codex store therefore gives exit 75 on every attempt, not `unknown`. The runner keeps the mapping in 7.7 as written (exit 75 is the safe side). This is reported to the coordinator as a finding. The fixture tests use `-32002` as the plan says.
- **7.9 and Engineer.** The ledger treats a tool with no annotations as one that may change something outside. So every `observability` and `gcloud` call in Engineer gets `tool_started` and `tool_completed`, and a crash during one of them stops the run as `unknown`, reason `tool_in_doubt`. Only `inspect_configuration` is skipped. Engineer's integration (phase 8) must accept this or get annotations upstream.

### 10.2 Implementation notes (2026-11-07)

Phases 0–7 are built on branch `durable-recovery-df69a1`. These points are not in the sections above:

- **SIGTERM** stops a run only when `--state` is given. Without `--state`, the runner keeps today's behavior, as section 5 requires.
- **Process-group re-start.** The outer process sets `ACP_RUNNER_GROUP_LEADER=1` for the inner process. This is an internal marker, not a test hook. After the inner process exits, the outer process sends `SIGTERM` to the inner process group. The inner process also signals its own group before it releases the lock.
- **Stopped commands.** When the runner stops a script or a check (signal or timeout), it resolves on the child's `exit` event. It does not wait for a grandchild that holds the output pipe. The group stop ends that grandchild.
- **Feedback files** are named `feedback/<step>-<visit>.json` after the visit that produced the failure.
- **A15** is tested in `tests/mcp/proxy.test.ts` (second call refused before it is forwarded, drain waits for the first). The engine-level exit 75 after a failed proxy append is covered by the first run of A10.
- **D13 fix.** A session recovered from the journal is dropped on any swap that the new process decides, so a later step of the same provider opens a new session.
- **Prompt errors.** With `--state`, a prompt error is an infrastructure failure (exit 75) when the agent process is closed, the error is not an ACP `RequestError`, or the code is `-32000`. Other `RequestError`s fail the step with `why: null`.

Phase 4 cases taken from the engine:

- `retry` on a step, and `on.failure` taking precedence over `retry`.
- `maxAttempts` exceeded with `fallback` to a step, to `END` and to `FAIL`, and with no `fallback`.
- A terminal `on.success` target and a terminal `on.failure` target: no loop count added.
- A failure with no transition: `why: null`, `next: FAIL`.
- A prompt error that is not an infrastructure failure: `why: null`, `next: FAIL`, pending feedback kept. An agent that dies or a spawn that fails: no `step_completed`, exit 75.
- A providerless script step: no swap. A script step that names another provider: `swap: true`.
- A crash right after each recovery append: `session_attached`, `session_resumed`, `prompt_sent` `resend`.

## 11. Limits and risks

- **Scripts run again after a crash during a script step.** Engineer's checks are safe to run twice. `reset-review.sh` is not, until section 9 item 10 is done. Other runbooks must make the same promise. The README must say so.
- **Scripts are not in the runbook hash.** A changed check script does not invalidate a journal.
- **Steps with MCP resource inputs** stop with `unknown` after a crash once a prompt went out. Engineer has none.
- **`session/resume` gives no history.** The runner cannot inspect what an interrupted turn did.
- **A resend can repeat an outside action that finished.** The ledger stops on an action with an unknown outcome. It does not stop the agent from asking for a finished action again. The fixed resend line and the agent's own session record are the only guard. A tool that must never run twice needs its own idempotency check.
- **A changed runbook starts a new run under a new key (D10).** The new run has no journal, so it can repeat actions that the earlier run finished, or whose outcome is unknown. For Engineer the risk is small, because the launcher does every outside action.
- **Actions that bypass MCP are not covered.** Shell commands and other built-in agent tools are out of the runner's sight.
- **The Codex session store holds model transcripts.** It is sensitive. Section 9 items 4 and 7 cover it.
- **A different adapter version** may store sessions elsewhere or drop resume. Phase 0 must run again for each adapter upgrade.

## 12. Open decisions

None.

Resolved on 2026-11-07: the hash refusal with an automatic new run key (D10, kept after review 2 finding 10), the resend for every agent step (D11) and the tool-call ledger (D12), no session reuse across a swap (D13), and the exit codes (D14).

## 13. Acceptance criteria

| # | Scenario | Expected result | How |
| --- | --- | --- | --- |
| A1 | The journal writer stops the runner after `session_attached` for `implement` visit 1 | The fresh runner writes no new `step_started`. It writes `session_resumed` for `sess_abc`, visit 1, then `prompt_sent` `kind: step`. The fixture gets a resume request for `sess_abc` and no `session/new`. | Automated, phase 5 |
| A2 | The runner stops after `step_completed implement → validate` | The fresh runner writes `step_started validate` visit 1. The fixture gets no prompt for `implement`. | Automated, phase 4 |
| A3 | Real Engineer draft PR, launcher on the Mac. Send SIGTERM to the launcher while `check_change` runs. Start the launcher again with the same run id. | `check_change` runs again. The PR number is the same. `HEAD` in the new worktree equals `branch_head`, with the same dirty files. Planning does not run again. | Manual, D9 and section 9 |
| A4 | `validate` fails with feedback | A new `implement` visit starts. Its `prompt_sent` names the saved feedback file and goes to the active session. The fixture sees the feedback text in that prompt. | Automated, phases 3 and 5 |
| A5a | Session unavailable (`-32002`), `origin: new`, no prompt sent | A new session opens. A second `session_attached` with `origin: new` follows. The run continues. | Automated, phase 5 |
| A5b | Session unavailable, `origin: carried`, no prompt sent | `run_finished` `unknown`, reason `session_unavailable`. Exit 2. | Automated, phase 5 |
| A5c | Reopen returns `-32000`, or the agent does not spawn | Exit 75. The journal is unchanged. | Automated, phase 5 |
| A5d | Crash after `prompt_sent`, session reopens | One `prompt_sent` `kind: resend` with the original prompt and the pending feedback. A crash before its reply ends the next run with `resend_interrupted`, exit 2. | Automated, phase 6 |
| A5e | Crash after `prompt_sent`, session unavailable | `run_finished` `unknown`, reason `session_unavailable`. Exit 2. No prompt goes out. | Automated, phase 6 |
| A6 | agent.yaml changed between runs | Exit 3. The state directory is unchanged. | Automated, phase 2 |
| A7 | The journal append fails | No later action starts. Exit 75. The next runner recovers from the prefix on disk. | Automated, phases 1 and 3 |
| A8 | The runner gets SIGKILL while its fixture agent keeps writing | The fresh runner on the same host exits 75 until the old process group is gone. Then it recovers. | Automated, phase 5 |
| A9 | The last line ends in `\n` but does not parse | Refuse. Exit 1. The file is unchanged. | Automated, phase 1 |
| A10 | Crash after `tool_started` for a tool without `idempotentHint` | The fresh runner does not resend. `run_finished` `unknown`, reason `tool_in_doubt`. Exit 2. | Automated, phase 6b |
| A11 | Live run: the fixture tool runs, then its reply is lost (`client.callTool` throws) | No `step_completed`. `run_finished` `unknown`, reason `tool_in_doubt`. | Automated, phase 6b |
| A12 | Crash after `tool_started` for a tool with `idempotentHint: true` | The visit is not in doubt. The resend goes out. | Automated, phase 6b |
| A13 | A `readOnlyHint: true` tool | No `tool_started` or `tool_completed` lines. | Automated, phase 6b |
| A14 | A tool call arrives while a script step runs | The proxy returns an error and does not forward it. | Automated, phase 6b |
| A15 | A journal append fails while two tool calls are in flight | The second call is rejected before it is forwarded. Exit 75. | Automated, phase 6b |
| A16 | SIGTERM while a long check script runs | The script's process group stops. Exit 75. The visit stays open. | Automated, phase 5 |
| A17 | The agent process dies during a live prompt | No `step_completed`. Exit 75. The next runner resends. | Automated, phase 6 |

## 14. Out of scope

- Reuse of a session across a provider swap. Excluded by D13, not only deferred.
- Saving state during the run for VM loss.
- Any change to the agent.yaml schema.

## 15. Critic review record

Reviewer: GPT Sol 6.1 through `codex exec`, read-only, with access to acp-runner, naplanwriting and the codex-acp cache.

### Review 1, of revision 1

It reported 18 findings: 2 blockers, 14 major, 2 minor. All 18 are applied in revision 2.

| # | Finding | Change |
| --- | --- | --- |
| 1 | `prompt_sent → session_resumed` read as "sent nothing" could send the prompt twice | 6.4 rule 11 and 7.5: turn state comes from prompt events only |
| 2 | An automatic restart on a hash change repeats finished work | 7.4: refuse with exit 3. The caller chooses a new key (D10) |
| 3 | A passing check does not prove the task finished | 7.6: no check shortcut. One resend with the full prompt (D11) |
| 4 | The workspace was not saved with the journal | 9.5 and 9.8: recovery ref with dirty and untracked files |
| 5 | Planning and implementation shared one state directory | 9.2: one directory per runbook |
| 6 | The launcher resume could not publish | 9.3, 9.8 and 9.9 |
| 7 | Feedback was consumed too early | 6.4 rule 9: consumed at `prompt_completed` |
| 8 | The cited bundle was codex-acp 1.13.1, not 2.5.0 | Section 2 cites the 2.5.0 bundle. Phase 0 uses it |
| 9 | Login and transport errors became permanent | 7.7 step 7: only `-32002` means unavailable |
| 10 | Child processes outlive a killed runner | 7.2: process groups in the lock. A8 |
| 11 | A copied lock blocks recovery on a new VM | 5 and 9.6: the lock is never copied |
| 12 | `why: null`, error paths and terminal edges were not modeled | 6.3, 6.4 rule 10, phase 4 cases |
| 13 | Per-visit MCP inputs are lost | 7.5: stop with `inputs_unrecoverable` |
| 14 | A failed secret scan still uploaded other files | 9.7: upload nothing |
| 15 | A complete but corrupt last line was dropped | 6.4 rules 1 and 2. A9 |
| 16 | The hosted workflow cannot run a test branch | 9.11 and A3: run on the Mac. Deterministic crash points in phase tests |
| 17 | Swap detection needed the engine's provider rules | `step_completed.swap`. One active session |
| 18 | A `run_started`-only journal had no action | 7.4 row added |

### Review 2, of revision 2

It reported 13 findings: 2 blockers, 9 major, 2 minor. Revision 3 applies 12 of them. Finding 10 conflicts with D10, and you kept D10.

| # | Finding | Change |
| --- | --- | --- |
| 1 | The per-process counter `n` matches occurrences, not actions. It can return the wrong saved result, or let an uncertain action run again | 7.9: no replay and no content matching. The ledger only detects an in-doubt action and stops |
| 2 | The workspace checkpoint pushed files before the secret scan | 9.5: scan the staged diff before the push |
| 3 | Downstream idempotency keys collide across runs | 7.9: no downstream key in this release |
| 4 | Uncertainty disappears when the agent does not call the tool again, or when a reply is lost in a live run | 7.9: the in-doubt rule runs before `step_completed`, at start-up and before a resend. A11 |
| 5 | The proxy has no visit context, and calls can overlap or arrive outside a turn | 7.9: turn gate, drain before `prompt_completed`, one append queue. A14, A15 |
| 6 | A child could start before the lock recorded its process group | 7.2: one process group for the whole run, recorded before any spawn |
| 7 | `spawnSync` blocks signal handlers during a long check | Phase 3: awaited `spawn`. A16 |
| 8 | A dead agent during a live prompt became a terminal failure | Section 5 and phase 3: infrastructure failures exit 75. A17 |
| 9 | No workspace checkpoint after a successful phase | 9.5: checkpoint after each successful phase. Refs are never moved. The recorded SHA is checked on resume |
| 10 | An automatic new key on exit 3 moves the replay risk to the caller | Not applied. You kept D10 on 2026-11-07. Section 11 lists the risk |
| 11 | Unchanged files do not fix the resolved prompt values or MCP endpoints | `run_started.inputs`. Exit 3 on a change |
| 12 | `reset-review.sh` is not safe at every crash point | 9.10 |
| 13 | The SDK helper is `resourceNotFound`, not `sessionNotFound` | Sections 2 and 7.7 |

### Rubber-duck on exit codes, 2026-11-07

GPT Sol 6.1 compared 0/1/2/3/75 with 0/1/2/75/78. It kept 3, because 78 (`EX_CONFIG`) means broken configuration, and a changed runbook is often valid. It rejected a rule that "no `run_finished` means recoverable": a corrupt journal, an in-doubt action and a crash before `run_started` all have no `run_finished`, and none of them is safe to retry. It found the `if ! run_agent` exit-code trap and the "Mark the issue failed" step in `acp-runner.yaml`. Both are in section 9 item 9. It proposed an `acp-runner status` command for unexpected exits. You chose codes only (D14).

