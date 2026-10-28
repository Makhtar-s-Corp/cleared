# Model adapters

This page has two parts. [v2 session driving modes](#v2-session-driving-modes) records how Claude Code and Codex can be driven programmatically as live sessions, verified on this server on 2026-10-21, and recommends one mode per harness for the v2 session adapter. [v1 adapter contract](#v1-adapter-contract) documents the `adapters/*.sh` contract that the current code still implements.

## v2 session driving modes

Cleared v2 runs each harness as a live session (one Docker container per session) instead of one `run` per prompt. The adapter therefore needs: several user turns in one session, a stream of events, permission requests answered by Cleared, interrupt, resume after a restart, and an explicit model.

Every statement below comes from the installed CLI's own help or behavior, from a run on this server, or from the linked official page. "Unknown" means it was not verified.

### Method and versions

Checked on 2026-10-21 on this server (Linux 6.12). All runs happened in a temporary directory under the session scratchpad, never in a repository. No port was opened, no Docker command ran, and no container was involved. Nothing in this section was tested inside a container. Both CLIs were already logged in: Claude Code with a claude.ai subscription (`claude auth status`: `"authMethod": "claude.ai"`), Codex with ChatGPT (`codex login status`: `Logged in using ChatGPT`).

The runs used the host account's real logins and left state outside the scratchpad:

- `~/.claude/projects/<encoded scratchpad path>/`: one persisted session transcript from proof 3 (`--session-id`, then `--resume`), plus an empty `memory/` directory. The other Claude runs used `--no-session-persistence` or `persistSession: false`.
- `~/.codex/sessions/2026/10/21/rollout-...jsonl`: one rollout file per non-ephemeral `codex exec` thread (proof 8, run twice), and matching rows in `~/.codex/state_5.sqlite` and `~/.codex/thread_history_1.sqlite` (both modified at 18:15, the first proof 8 run). The other Codex runs used `--ephemeral` or `ephemeral: true` and created no rollout file, but Codex still writes its log database: `~/.codex/logs_2.sqlite-wal` was modified at 18:32, during the app server runs for this review.
- The npm cache under `~/.npm` from installing the two SDKs into the scratchpad.
- Usage on both subscriptions: each run is a real model request. The saved Claude `-p` outputs report `total_cost_usd` of at most 0.0013 per run.

| Component | Version on 2026-10-21 | Source |
| --- | --- | --- |
| Claude Code CLI | `2.1.306 (Claude Code)` | `claude --version` |
| Codex CLI | `codex-cli 0.163.0` | `codex --version` |
| Node.js | `v24.21.0` | `node --version` |
| `@anthropic-ai/claude-agent-sdk` | 0.3.306, reports `claude_code_version=2.1.306` | `npm view`, installed in the scratchpad for the test below |
| `@openai/codex-sdk` | 0.163.0, depends on `@openai/codex` 0.163.0 | `npm view`, installed in the scratchpad |
| `@agentclientprotocol/claude-agent-acp` | 0.94.0, depends on `@anthropic-ai/claude-agent-sdk` 0.3.303 | `npm view` (not installed) |
| `@agentclientprotocol/codex-acp` | 2.2.2, depends on `@openai/codex` ^0.160.1 | `npm view` (not installed) |
| `@agentclientprotocol/sdk` | 2.0.0 | `npm view` (not installed) |

The Claude Code binary at `~/.local/bin/claude` was reinstalled by an updater at 18:11 during this check; two commands run at that moment failed with `Error: claude native binary not installed.` and passed when run again. The version stayed 2.1.306. An adapter should pin the CLI version inside its image and not depend on a host updater.

### Summary

| Need | Claude Code 2.1.306 | Codex 0.163.0 |
| --- | --- | --- |
| Several turns in one process | Yes: `-p --input-format stream-json --output-format stream-json --verbose`, or Agent SDK `query()` with an async iterable (both verified) | Yes: `codex app-server` over stdio, `turn/start` repeated on one thread (verified). `codex exec` is one process per turn. |
| Event stream | `stream-json` lines: `system/init`, `assistant`, `user` (tool results), `result`, `rate_limit_event`, hook events | `exec --json`: `thread.started`, `turn.started`, `item.*`, `turn.completed`. App server: JSON-RPC notifications such as `item/completed`, `turn/completed` |
| Permission requests answered by the driver | `control_request` `can_use_tool` on stdout, `control_response` on stdin (deny round trip verified), or the SDK's `canUseTool` callback (verified) | App server request `item/commandExecution/requestApproval`, answered with `{"decision": ...}` (decline round trip verified). Not available in `codex exec`. |
| Interrupt | SDK `interrupt()` (docs, streaming input only); SIGINT ends a turn (docs). Not run here. | App server `turn/interrupt` (docs). Not run here. |
| Resume | `--session-id <uuid>` then `--resume <uuid>` (verified); SDK `resume`, `forkSession` | `codex exec resume <thread_id>` (verified); app server `thread/resume` (in schema, not run) |
| Model | `--model`, `--fallback-model`, SDK `setModel()` | `-m`, `-c model=...`, app server `model/list` then `thread/start {model}` (verified) |
| Official ACP support | None in the docs; community adapter `claude-agent-acp` over the Agent SDK | None in the docs; adapter `codex-acp` over the app server |
| Stability label | `-p` and the Agent SDK are documented; the raw stdin/stdout control envelope is not documented as a public protocol | `exec` "Stable", `app-server` "Experimental" and "aren't supported for production workloads" |

### Claude Code

Official docs: [CLI reference](https://code.claude.com/docs/en/cli-reference.md), [Run Claude Code programmatically](https://code.claude.com/docs/en/headless.md), [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview.md), [Agent SDK TypeScript](https://code.claude.com/docs/en/agent-sdk/typescript.md), [Streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode.md), [Sessions](https://code.claude.com/docs/en/agent-sdk/sessions.md), [SDK permissions](https://code.claude.com/docs/en/agent-sdk/permissions.md), [SDK approvals](https://code.claude.com/docs/en/agent-sdk/user-input.md), [Permission modes](https://code.claude.com/docs/en/permission-modes.md), [Permissions](https://code.claude.com/docs/en/permissions.md), [Hooks](https://code.claude.com/docs/en/hooks.md), [MCP](https://code.claude.com/docs/en/mcp.md), [Settings](https://code.claude.com/docs/en/settings.md), [Model configuration](https://code.claude.com/docs/en/model-config.md), [Authentication](https://code.claude.com/docs/en/authentication.md), [Agent view](https://code.claude.com/docs/en/agent-view.md).

#### Interactive TUI

`claude [prompt]` starts an interactive session ("starts an interactive session by default, use -p/--print for non-interactive output"). It needs a terminal; v1 `talk` runs it in an Orca terminal. Its screen is not a machine-readable stream. Related flags from `claude --help`: `--bg` starts a session in the background and prints an ID for `claude attach`, `logs`, `stop` and `rm`; `claude agents` lists background sessions ([agent view](https://code.claude.com/docs/en/agent-view.md)); `--remote-control [name]` and `--tmux` (with `--worktree`) also exist. None of these was run here.

#### Print mode and output formats

`claude -p` answers and exits. `--output-format text|json|stream-json` (`stream-json` also needs `--verbose`), `--json-schema` for structured output, `--max-budget-usd`, `--include-partial-messages`, `--include-hook-events`. The help warns that `-p` skips the workspace trust dialog and silently ignores settings files that fail validation. v1 `adapters/claude.sh` already uses `-p --output-format stream-json --verbose`.

#### Streaming JSON input (live session in one process)

`--input-format stream-json` (only with `-p`) keeps the process reading user messages from stdin, one JSON object per line. The CLI docs give no raw stdin schema; the line shape below is the SDK's `SDKUserMessage` ([streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode.md)) and it worked here:

```json
{"type":"user","message":{"role":"user","content":"Remember the word PLUM. Reply with OK only."}}
```

Each user message produces its own `result` line; the process stays alive until stdin closes. `--replay-user-messages` echoes user lines back.

Permission requests travel on the same pipes. With `--permission-prompt-tool stdio`, a tool call that needs approval appears on stdout as `{"type":"control_request","request_id":...,"request":{"subtype":"can_use_tool","tool_name":"Bash","input":{...}}}`, and the driver answers on stdin with `{"type":"control_response","response":{"subtype":"success","request_id":...,"response":{"behavior":"deny","message":"..."}}}`. A deny round trip was verified (proof 4); an allow was not run. The documented form of `--permission-prompt-tool` takes an MCP tool name (`mcp__<server>__<tool>`). The value `stdio` is not documented; the installed SDK passes `--permission-prompt-tool=stdio` itself when `canUseTool` is set (seen in `@anthropic-ai/claude-agent-sdk` 0.3.306 `sdk.mjs`). The TypeScript reference mentions the `control_request` envelope, `control_response`, and an `interrupt` control request, without a schema. Treat the raw envelope as an SDK internal that can change between versions.

`--permission-prompts host|none` (help text): `host` routes prompts to the SDK host or `--permission-prompt-tool`; `none` denies anything that would prompt.

#### Agent SDK (TypeScript)

`@anthropic-ai/claude-agent-sdk` "runs the Claude Code binary" ([overview](https://code.claude.com/docs/en/agent-sdk/overview.md)) and bundles a native binary per platform (`@anthropic-ai/claude-agent-sdk-linux-x64` and others as optional dependencies). `pathToClaudeCodeExecutable` points it at another binary; both the bundled binary and `~/.local/bin/claude` worked here (proof 5).

- `query({ prompt, options })`: `prompt` is a string or `AsyncIterable<SDKUserMessage>`. The async iterable form keeps one session open for several turns (verified: two turns, `canUseTool` called once, answers `DENIED` then `PLUM`).
- The returned `Query` exposes, per the [TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript.md): `interrupt()` (streaming input only), `setPermissionMode()`, `setModel()`, `supportedModels()`, `supportedCommands()`, `mcpServerStatus()`, `setMcpServers()`, `getContextUsage()`, `streamInput()`, `close()` and others. Only the message stream and `canUseTool` were exercised here.
- Options used or confirmed in the reference: `cwd`, `model`, `tools`, `allowedTools`, `disallowedTools`, `permissionMode`, `canUseTool`, `hooks` (in-process callbacks), `mcpServers`, `settingSources`, `persistSession`, `sessionId`, `resume`, `forkSession`, `continue`, `maxTurns`, `maxBudgetUsd`, `permissionPrompts`, `pathToClaudeCodeExecutable`.
- Login: the SDK run here used the CLI's claude.ai login (`apiKeySource=none`) without an API key. The [overview](https://code.claude.com/docs/en/agent-sdk/overview.md) states: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Use the API key authentication methods described in the Quickstart instead." Whether this covers a self-hosted, open-source tool where each owner signs in to their own subscription on their own host is unknown; the docs do not address that case. The same question applies to `claude-agent-acp`, which is built on the SDK. Whether it applies differently to driving `claude -p` directly is also unknown.

#### Authentication in a container

From [Authentication](https://code.claude.com/docs/en/authentication.md) and [environment variables](https://code.claude.com/docs/en/env-vars.md), not tested in a container: `claude setup-token` prints a one-year OAuth token (Pro, Max, Team or Enterprise plan), not saved anywhere, to be set as `CLAUDE_CODE_OAUTH_TOKEN`; that token "can only make model requests". `CLAUDE_CONFIG_DIR` gives a directory its own settings, session history and login. `--bare` never reads OAuth credentials, the keychain or `CLAUDE_CODE_OAUTH_TOKEN`, so it cannot be used with a subscription login.

#### Configuration isolation

A session should not inherit the host user's hooks, plugins or MCP servers. The default `-p` run here emitted `hook_started` and `hook_response` events from the user's own settings. Verified with the subscription login (proof 6): `--setting-sources project` and `--safe-mode` each ran with zero hook events and answered `OK`. `--strict-mcp-config` keeps only servers from `--mcp-config`. `--restricted` (help text, not run) removes command-running tools unless `--tools` names them, ignores user, project and local settings, and refuses `bypassPermissions`. The SDK equivalent is `settingSources: []` (verified in proof 5).

#### MCP

Client: `--mcp-config <json files or strings>`, `--strict-mcp-config`, `claude mcp add|add-json|list|get|remove|login|logout`. Server: `claude mcp serve` ("Start the Claude Code MCP server", options `--debug`, `--verbose`; help only, not started). The SDK accepts `mcpServers`, including in-process servers.

#### Hooks

Configured under a `"hooks"` key in settings JSON (`~/.claude/settings.json`, `.claude/settings.json`, `.claude/settings.local.json`, managed policy, plugin `hooks/hooks.json`). The [hooks reference](https://code.claude.com/docs/en/hooks.md) lists 33 events, including `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PermissionDenied`, `PostToolUse`, `Stop`, `StopFailure`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`, `SessionEnd`. A command hook that exits 2 blocks the action; a `PreToolUse` hook can also return `hookSpecificOutput.permissionDecision = "deny"`. The headless page says a call that needs approval in `-p` is denied unless a `PermissionRequest` hook or `--permission-prompt-tool` approves it. `--include-hook-events` puts hook lifecycle events in the stream.

#### Permission modes

`--permission-mode` accepts `acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk`, `plan` (help text); `default`, missing from that list, was also accepted in the runs below. From [permission modes](https://code.claude.com/docs/en/permission-modes.md): `default` (shown as Manual; `manual` is an alias) runs reads without asking; `acceptEdits` also allows file edits and common filesystem commands; `plan` reads and plans; `auto` runs everything with background classifier checks; `dontAsk` denies anything that would prompt; `bypassPermissions` runs everything, "only in isolated containers and VMs". A `-p` run with no mode starts in Manual mode since v2.1.302. Here, in `default` mode, `Bash` running `ls` was allowed without a prompt and `touch` produced a `can_use_tool` request. `--allowedTools` and `--disallowedTools` take rules such as `Bash(git *)`; `--tools` limits the built-in set (`""` disables all). `--dangerously-skip-permissions` is "Recommended only for sandboxes with no internet access".

#### Session resume

`--session-id <uuid>` sets the ID; `-r, --resume <id or name>` resumes; `-c, --continue` takes the latest in the directory; `--fork-session` resumes under a new ID; `--no-session-persistence` (print mode only) saves nothing. Verified: a two-turn stream-json session with a chosen UUID, then a new `-p --resume <uuid>` process remembered the word (proof 3). Transcripts live under `$CLAUDE_CONFIG_DIR/projects/` ([sessions](https://code.claude.com/docs/en/agent-sdk/sessions.md)), so a container needs that directory on a volume to resume after it is recreated.

#### Model selection

`--model <alias or full name>` (help: aliases such as `opus` or `sonnet`); `--model haiku` resolved to `claude-haiku-5-5` here. `--fallback-model` takes a comma-separated list. `--effort low|medium|high|xhigh|max`. SDK: `model` option, `setModel()`, `supportedModels()`.

#### ACP

The official Claude Code docs have no mention of ACP or the Agent Client Protocol (checked against https://code.claude.com/docs/llms.txt). The [ACP agents list](https://agentclientprotocol.com/get-started/agents) shows "Claude Agent (via Zed's SDK adapter)", which is [`@agentclientprotocol/claude-agent-acp`](https://github.com/agentclientprotocol/claude-agent-acp): "implements an ACP agent by using the official Claude Agent SDK", authored by Zed Industries. The older `@zed-industries/claude-code-acp` and `@zed-industries/claude-agent-acp` packages are deprecated in favor of it. It was not installed or run here.

### Codex

Official docs, plus the [TypeScript SDK README](https://github.com/openai/codex/tree/main/sdk/typescript). On 2026-10-21 each `developers.openai.com/codex/...` URL below answered `308` with the `learn.chatgpt.com` location shown (checked with `curl -s -o /dev/null -w '%{http_code} %{redirect_url}'`). The text was read on the `learn.chatgpt.com` pages. Use the right-hand column if the redirect changes.

| Page | developers.openai.com | Redirect target read |
| --- | --- | --- |
| CLI commands | https://developers.openai.com/codex/cli/reference | https://learn.chatgpt.com/docs/developer-commands?surface=cli |
| Non-interactive mode | https://developers.openai.com/codex/noninteractive | https://learn.chatgpt.com/docs/non-interactive-mode |
| App Server | https://developers.openai.com/codex/app-server | https://learn.chatgpt.com/docs/app-server |
| Codex SDK | https://developers.openai.com/codex/sdk | https://learn.chatgpt.com/docs/codex-sdk |
| Hooks | https://developers.openai.com/codex/hooks | https://learn.chatgpt.com/docs/hooks |
| MCP | https://developers.openai.com/codex/mcp | https://learn.chatgpt.com/docs/extend/mcp?surface=cli |
| Sandboxing | https://developers.openai.com/codex/sandboxing | https://learn.chatgpt.com/docs/sandboxing |
| Approvals and security | https://developers.openai.com/codex/agent-approvals-security | https://learn.chatgpt.com/docs/agent-approvals-security |
| Config reference | https://developers.openai.com/codex/config-reference | https://learn.chatgpt.com/docs/config-file/config-reference |
| Authentication | https://developers.openai.com/codex/auth | https://learn.chatgpt.com/docs/auth |

Which of these `developers.openai.com` paths OpenAI treats as canonical is unknown: every path tried under `/codex/`, including guessed ones such as `/codex/sandbox`, answered `308`, so a redirect does not prove that a page existed at that address.

#### Interactive TUI

`codex [PROMPT]` starts the TUI. In 0.163.0 the TUI uses a shared local app-server daemon (`--no-daemon`: "Run without the shared background server, even if it is already running"); `codex agents` browses its sessions, `codex --remote ws://...|unix://PATH` connects the TUI to a remote app server, and `codex queue --thread <id> --message <text>` queues a message for an existing session. None of these was run here.

#### Non-interactive mode (`codex exec`)

`codex exec [PROMPT]` runs one turn and exits; the prompt can come from stdin (`-`). `--json` prints JSONL events: `thread.started`, `turn.started`, `item.started`/`item.completed` (items such as `agent_message`, `command_execution`), `turn.completed` with usage, `turn.failed`, `error`. Other flags: `--ephemeral`, `--skip-git-repo-check`, `--ignore-user-config`, `--ignore-rules`, `--output-schema`, `-o/--output-last-message`, `-C/--cd`, `--add-dir`. The docs label `exec` "Stable" and say it runs in a read-only sandbox by default. There is no way to answer an approval in `exec`; v1 runs it with `approval_policy=never`.

#### App server (JSON-RPC)

`codex app-server` is labeled `[experimental]` in the help. The [App Server page](https://learn.chatgpt.com/docs/app-server) calls it "the interface Codex uses to power rich clients (for example, the Codex VS Code extension)" for "authentication, conversation history, approvals, and streamed agent events", says "If you are automating jobs or running Codex in CI, use the Codex SDK instead", and states "The app-server command and WebSocket transport are experimental and aren't supported for production workloads."

- Transport: `--listen stdio://` (default) is newline-delimited JSON-RPC 2.0 with the `"jsonrpc":"2.0"` field omitted. `unix://`, `unix://PATH` and `ws://IP:PORT` also exist; WebSocket is "experimental and unsupported". Only stdio was used here.
- Handshake: one `initialize` request (`clientInfo: {name, version}`), then an `initialized` notification.
- Session calls used here: `model/list`, `thread/start` (`cwd`, `model`, `sandbox`, `approvalPolicy`, `ephemeral`, `developerInstructions` and others), `turn/start` (`threadId`, `input: [{type: "text", text}]`). Also in the schema and docs, not run: `thread/resume`, `thread/fork`, `thread/read`, `turn/steer` (adds input to the running turn), `turn/interrupt` (turn ends with status `interrupted`), `review/start`, `thread/compact/start`, `hooks/list`, `mcpServerStatus/list`.
- Server requests to the client: `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`, `item/tool/requestUserInput`, `mcpServer/elicitation/request`, `item/tool/call` and others. Command decisions: `accept`, `acceptForSession`, `acceptWithExecpolicyAmendment`, `applyNetworkPolicyAmendment`, `decline`, `cancel` (from the generated schema).
- Typed bindings for the installed version: `codex app-server generate-ts --out DIR` and `codex app-server generate-json-schema --out DIR` (the second was run; it wrote 39 files offline).

Verified (proof 9 and 10): two turns on one thread in one process (`OK`, then `PLUM`), and an approval request answered with `decline`: the command item ended `declined` and no file was written. The approval request appeared with `approvalPolicy: "untrusted"`. With `"on-request"` and a read-only sandbox, the model ran the command without asking and the sandbox refused the write. The config reference says `untrusted` "is unsupported" as an approval policy, yet the 0.163.0 schema still accepts it. Which policy reliably routes every write to the client is therefore unresolved.

Model finding: with the user's `~/.codex/config.toml` (`model = "gpt-6-sol"`), the app server started the thread and then every turn failed with `The 'gpt-6-sol' model is not supported when using Codex with a ChatGPT account.` `codex exec --ignore-user-config` worked because it skipped that file. Passing the default from `model/list` (`gpt-6-luna` on this account; the list was `gpt-6-luna* gpt-5.6-terra gpt-5.6-luna`) fixed it. An adapter should read `model/list` and pass `model` explicitly.

#### Codex SDK

`@openai/codex-sdk` 0.163.0 "wraps the `codex` CLI from `@openai/codex`. It spawns the CLI and exchanges JSONL events over stdin/stdout" (README). In the installed `dist/index.js`, each run spawns `codex exec --experimental-json`, adds `resume <threadId>` for a resumed thread, and maps options to flags (`--model`, `--sandbox`, `--cd`, `--add-dir`, `--config approval_policy=...`). API: `new Codex()`, `startThread()`, `resumeThread(id)`, `thread.run()`, `thread.runStreamed()`, an `AbortSignal` per turn. It has no callback for approvals and starts one process per turn. The [SDK page](https://learn.chatgpt.com/docs/codex-sdk) says the Python SDK "controls the local Codex app-server over JSON-RPC"; there is no TypeScript app-server client in this package.

#### MCP

Client: `codex mcp add|list|get|remove|login|logout`, servers stored in `~/.codex/config.toml` or a trusted project's `.codex/config.toml`. Server: `codex mcp-server` no longer exists. In 0.163.0 it is not in the command list (`codex mcp-server --help` prints the top-level help). The [CLI page](https://learn.chatgpt.com/docs/developer-commands) says "The codex mcp-server command and standalone codex-mcp-server binary have been removed. Use the Codex app server instead"; the [0.154.0 release](https://github.com/openai/codex/releases/tag/rust-v0.154.0) (2026-09-09) removed it.

#### Hooks

`codex features list` shows `hooks  stable  true`. Hooks live in `hooks.json` or inline `[hooks]` tables in `config.toml`, under `~/.codex/` or `<repo>/.codex/`. Events per the [hooks page](https://learn.chatgpt.com/docs/hooks): `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `UserPromptSubmit`, `SubagentStart`, `SubagentStop`, `Stop`, `Interrupt`, `SessionStart`, `SessionEnd`. "Non-managed hooks must be reviewed and trusted before they run"; `--dangerously-bypass-hook-trust` skips that check for one invocation. The app server lists them with `hooks/list` and emits `hook/started` and `hook/completed`.

#### Sandbox and approvals

`-s, --sandbox read-only|workspace-write|danger-full-access`; `-a, --ask-for-approval on-request|never` (the help lists only these two); `--approve-for-me` routes approvals through automatic review in `workspace-write`; `--dangerously-bypass-approvals-and-sandbox` is "Intended solely for running in environments that are externally sandboxed". The config reference gives `approval_policy on-request | never | { granular = {...} }`. Profiles are separate files, `$CODEX_HOME/<name>.config.toml`, selected with `-p/--profile`. v1 notes that the Codex Linux sandbox failed a socket mount in testing on the host; its behavior inside a Docker container is unknown.

#### Session resume

`codex resume [SESSION_ID] [PROMPT]` and `codex resume --last` for the TUI; `codex exec resume <id> [PROMPT]` and `--last` for non-interactive runs; `codex fork`, `archive`, `unarchive`, `delete`. Verified (proof 8): `codex exec --json` returned `thread_id`, then `codex exec resume --json <thread_id> ...` remembered the word. `--ephemeral` sessions cannot be resumed.

#### Model selection

`-m, --model`, `-c model="..."`, `--profile`; `codex debug models` renders the raw model catalog; app server `model/list` returns the models the logged-in account can use, with a default. See the model finding above.

#### Authentication

ChatGPT login or API key. The [auth page](https://learn.chatgpt.com/docs/auth) says "API keys are still the recommended default for automation". `codex login --with-api-key` and `--with-access-token` read from stdin; `--device-auth` exists. The app server has `account/login/start` (`apiKey`, `chatgpt`, `chatgptDeviceCode`). Credentials live under `CODEX_HOME` (`--ignore-user-config` still uses it for auth). Not tested in a container.

#### ACP

None of the Codex docs pages checked mentions ACP, and the CLI has no ACP command. The [ACP agents list](https://agentclientprotocol.com/get-started/agents) shows "Codex CLI (via ACP's adapter)", which is [`@agentclientprotocol/codex-acp`](https://github.com/agentclientprotocol/codex-acp): "a stdio ACP agent server. It starts the Codex App Server, translates ACP requests into Codex operations, and maps Codex events back into the client." It bundles `@openai/codex` (`CODEX_PATH` overrides it). The earlier Rust `zed-industries/codex-acp` is archived. Not installed or run here.

### ACP status

The [Agent Client Protocol](https://agentclientprotocol.com/get-started/introduction) standardizes communication between editors and coding agents over JSON-RPC on stdio. The protocol examples use `"protocolVersion": 1` ([initialization](https://agentclientprotocol.com/protocol/v1/initialization)); a v2 is marked Draft. The `@agentclientprotocol/sdk` 2.0.0 package is a library version that exports protocol v1 by default. Neither Claude Code nor Codex implements ACP natively. Both reach ACP through adapters maintained under the `agentclientprotocol` GitHub org, not by Anthropic or OpenAI, and each adapter sits on the interface recommended below (Agent SDK, app server). It adds a layer, a third-party release cycle and a mapping between protocols, with no driving capability that the direct interface lacks. ACP could become useful when Cleared adds harnesses that only speak ACP; that is not verified for any harness here.

### Recommendation for the v2 session adapter

**Claude Code: the Agent SDK in streaming input mode.** One `query()` per live session, fed by an async iterable that Cleared pushes user turns into. Pin `@anthropic-ai/claude-agent-sdk` to the Claude Code version installed in the session image and set `pathToClaudeCodeExecutable` to that `claude`. Use `settingSources: []` (or `['project']`), explicit `tools`, `allowedTools` and `disallowedTools` from `[permissions.<role>]`, `permissionMode`, `canUseTool` mapped to Cleared's question and approval flow, an explicit `model`, and a Cleared-chosen `sessionId` with `resume` after a restart. Keep the config directory on a volume.

Why: it is the only documented, typed interface that gives multi-turn input, in-process permission answers, `interrupt()`, `setModel()` and `setPermissionMode()` in one session, and the Node core can import it directly. It worked here on the subscription login with both the bundled and the installed binary. The raw `claude -p --input-format stream-json` channel does the same (verified) but its control envelope is not documented as public, so it is the fallback, not the base.

Open question for the owner before building: the SDK overview's sentence on claude.ai login in third-party products (quoted above). If it rules out subscription login for Cleared, the same SDK runs with an API key, which changes the cost model. Raw `-p` driving is not a documented way around it; how the policy treats it is unknown.

**Codex: the app server over stdio.** One `codex app-server --listen stdio://` process per session container, driven by JSON-RPC: `initialize`, `model/list`, `thread/start` with explicit `model`, `cwd`, `sandbox` and `approvalPolicy`, then `turn/start` per user turn, `turn/steer` and `turn/interrupt` from Cleared, approval requests answered from Cleared's queue, `thread/resume` after a restart. Generate the TypeScript types with `codex app-server generate-ts` at the pinned version and commit them with the adapter.

Why: it is the only Codex mode with several turns in one process, approval requests the driver can answer, steering and interrupt. `codex exec` and the TypeScript SDK (which spawns `exec` per turn) cannot answer approvals. `codex-acp` uses the app server itself. Costs: it is labeled experimental and "not supported for production workloads", so pin the CLI version in the image, run a contract test (two turns, one declined approval, one interrupt) before each upgrade, and keep `codex exec --json` plus `exec resume` (stable) as the fallback for roles that need no approvals. The same App Server page says "If you are automating jobs or running Codex in CI, use the Codex SDK instead"; Cleared v2 sessions are interactive and need approvals, which the TypeScript SDK cannot answer, so this advice does not fit them.

**Decision gate (blocks adopting the app server for any role that needs approvals):** do not build approval handling on the app server until a test on the pinned version shows which `approvalPolicy` (with which `sandbox`) sends every command and file write to the client as a server request. Evidence so far: `untrusted` produced the request (proof 10) but the config reference calls it unsupported; `on-request` with `read-only` produced no request and the sandbox refused the write. Until the gate passes, Codex sessions run only roles that need no approvals (`approvalPolicy: "never"` with a `read-only` or `workspace-write` sandbox), and approval-dependent roles go to Claude Code. Owner: the v2 adapter author. Close it by recording the result here.

Not tested and needed before the adapter ships: either mode inside a Docker container labeled `cleared.dev=v2`, container login (`CLAUDE_CODE_OAUTH_TOKEN` or a mounted `CLAUDE_CONFIG_DIR`; Codex `CODEX_HOME`), an allow decision, interrupt, and `thread/resume` on the app server.

### Claude Code verified in a container (2026-10-21)

Run on this server on 2026-10-21 by lane `v2-j1-claude-adapter` with `node v2/scripts/doctor.ts claude-code`, through the adapter itself (`v2/src/session/adapters/claude-code.ts`) and the runner in the session image (`v2/images/session/runner/main.ts`): Claude Code 2.1.306, `@anthropic-ai/claude-agent-sdk` 0.3.306, `claude-haiku-5-5`, Docker 29.8.1, objects labelled `cleared.dev=v2` only. Nothing ran against the host's own Claude Code configuration directory: the session's config directory is the session's volume. The login was the service account's existing Claude Code login, its credentials file named by `CLEARED_CLAUDE_CREDENTIALS` and bind mounted read only at `/run/cleared/claude.token` (owner decision of 2026-10-21, [decisions log](v2/decisions-log.md)). The doctor checks that file's owner and mode and never reads it; the runner reads it inside the container and gives the CLI only its access token, as `CLAUDE_CODE_OAUTH_TOKEN`. The session's reported `total_cost_usd` was 0.0054 USD before the resume and 0.0056 USD after it.

What the run established, beyond the earlier proofs on the host:

- **Login in a container.** `CLAUDE_CODE_OAUTH_TOKEN` set from the access token of an existing subscription login works in the container: `system/init` reports `apiKeySource: "none"` and every turn answered. A `claude setup-token` token was not tried (it needs the owner's browser); the runner accepts either form.
- **Hosts.** A logged-in session asked the egress proxy for `api.anthropic.com:443` only (`allowed api.anthropic.com:443 x3` over the whole session, image variable `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`).
- **Allow round trip.** `touch allowed.txt` raised `canUseTool`; the policy's `default` rule sent it to the inbox; `allow_once` returned `{ behavior: 'allow', updatedInput }` and the file existed afterwards. `rm -r olddir` raised `canUseTool`, the policy said `delete.outside_ticket`, `reject_once` stopped it, and the folder stayed.
- **Reads never ask.** In `default` mode a `Read` of a planted `.env` ran with no `canUseTool` call (seen in a first probe, where the model then quoted the planted value). The runner therefore sends a `tool_check` from a `PreToolUse` hook before every tool call; the host evaluates the policy and only a deny stops the call. With it, the read was denied (`secret.read`) and the planted value reached neither the model's answer nor the events.
- **Briefing.** With `settingSources: []`, `CLAUDE.md` is not loaded (the SDK's `settingSources` reference: "Must include 'project' to load CLAUDE.md files"). The runner appends the workdir's `CLAUDE.md` to the `claude_code` system prompt preset; the session answered the codeword it holds (`MAPLE`).
- **A message sent mid turn** while `sleep 15` ran was taken into account before the turn ended: the turn's reply followed it (`SECOND` instead of `FIRST`) and its `result` lists both user message uuids in `user_message_uuids`. So `send` during a run only pushes the message; no interrupt is needed for step 4 of the proof. In a first run, where the doctor sent the message after the turn had already ended, it was simply the next turn.
- **Interrupt** during `sleep 60`: `interrupt()` ended the turn with a `result` of `subtype: "error_during_execution"`, `is_error: true`, `terminal_reason: "aborted_tools"`; the adapter maps it to `RUN_FINISHED` with outcome and stop reason `cancelled`.
- **Question.** `AskUserQuestion` reaches `canUseTool` like any tool, with `input.questions` in the shape of `sdk-tools.d.ts` `AskUserQuestionInput`. The answer goes back as `{ behavior: 'allow', updatedInput: { questions, answers: { <question text>: <label> } } }`; the model replied with the chosen option (`Oldest`).
- **Subagents.** A foreground `Agent` call's own tool calls arrive as `assistant` frames whose `parent_tool_use_id` is the `Agent` call's id; the app can group on it. In an earlier run the model started the subagent in the background, and its frames were not part of the turn.
- **Resume after the container is recreated.** `stop` removed the containers and networks and kept the config volume; `resume` started a new container with `resume: <session id>` and the session remembered the word of its first turn (`PLUM`). On resume the CLI first prints a `system/init` without `user_message_uuids` and a `result` with `num_turns: 0` before the first real turn; the mapper ignores both.
- **The token in the environment** (added after review round 1 of the lane's pull request). Claude Code removes `CLAUDE_CODE_OAUTH_TOKEN` from the environment of its Bash children: a probe that printed only `present` or `absent` printed `absent`. Its own process keeps the token, readable in `/proc/<pid>/environ` by the session's uid: a probe that printed process names only named `claude`. The policy denies such reads (`secret.read`), as unit and adapter tests show; in the doctor run the model declined to attempt `cat /proc/1/environ`, so the real run did not exercise that rule. The residual risk is in the [decisions log](v2/decisions-log.md).
- **Cost.** `total_cost_usd` and `modelUsage` in a `result` are totals for the session so far; `usage` is the turn's. `RUN_FINISHED` carries `total_cost_usd` as the SDK reports it.
- **Still unknown:** a `claude setup-token` token in a container; what a session does when the access token it was given expires (the runner reads the login file once, when the container starts, so a session started before the host refreshes its login keeps the older token); partial messages.

Raw lines, edited as in the proofs below: ids are `<id>` or `<session>`, the host's paths `<scratch>` and `<login file>`, and a long line is cut around `...`. The `docker create` of the session container (one line, split here at each `--mount`), then the check lines, then the runner lines the doctor prints for each turn (`<<`).

```console
$ CLEARED_CLAUDE_CREDENTIALS=<login file> node scripts/doctor.ts claude-code --no-build
$ docker create --name cleared-v2-<id>-session --label cleared.dev=v2 --label cleared.session=<id> --label cleared.role=session --network name=cleared-v2-<id> --user 1000:1000 --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges --memory 4g --memory-swap 4g --cpus 2 --pids-limit 1024
    --mount type=bind,source=<scratch>/work,target=/workspace
    --mount type=bind,source=<login file>,target=/run/cleared/claude.token,readonly
    --mount type=volume,source=cleared-v2-<id>-config,target=/var/lib/cleared/claude-config --env HTTPS_PROXY=http://egress:3128 --env HTTP_PROXY=http://egress:3128 --env https_proxy=http://egress:3128 --env http_proxy=http://egress:3128 --env NO_PROXY=localhost,127.0.0.1 --env no_proxy=localhost,127.0.0.1 --env HOME=/tmp --env CLAUDE_CONFIG_DIR=/var/lib/cleared/claude-config --workdir /workspace --interactive -- cleared-v2-session:2.1.306 node /opt/cleared/runner/main.ts
PASS the login file (the Claude Code credentials file named by CLEARED_CLAUDE_CREDENTIALS) is a file of the service's account that only it can read: mode 600
PASS the login file is mounted read only at /run/cleared/claude.token (docker inspect): [{"Type":"bind","Destination":"/workspace","RW":true},{"Type":"bind","Destination":"/run/cleared/claude.token","RW":false},{"Type":"volume","Destination":"/var/lib/cleared/claude-config","RW":true}]
PASS the touch was escalated by the policy (rule default) and allowed from the inbox
PASS after allow_once the file exists in the workdir
PASS the session runs Claude Code 2.1.306 with claude-haiku-5-5, logged in without an API key: {"version":"2.1.306","model":"claude-haiku-5-5","apiKeySource":"none"}
PASS the rm -r was escalated (rule delete.outside_ticket) and reject_once stopped it
PASS the second turn ended: RUN_FINISHED
PASS the read of .env was denied by the policy (secret.read) before it ran
PASS the planted value reached neither the model's answer nor the events
PASS the briefing (CLAUDE.md, appended to the system prompt) reached the session: What is the project codeword given in your instructions? Reply with that one word. / MAPLE
OBSERVED mid-turn message: taken into account before the running turn ended; a result listing both user message uuids: yes; runs started after the send: 1; replies: Use the Bash tool to run exactly: sleep 15 . Then reply with the single word FIRST. / Change of plan for this reply only: reply with the single word SECOND instead of FIRST. / SECOND
PASS the message sent mid turn was taken into account
PASS interrupt ended the turn as cancelled: {"type":"RUN_FINISHED","threadId":"<session>","runId":"<id>","outcome":{"type":"cancelled"},"usage":[{"model":"claude-haiku-5-5","inputTokens":2,"outputTokens":81,"cachedInputTokens":19553,"cacheWriteInputTokens":88}],"result":{"stopReason":"cancelled","total_cost_usd":0.00264977}}
PASS the question reached the inbox as cleared.question and its answer reached the model: Use the AskUserQuestion tool to ask me one question: should the guestbook show the newest or the oldest entry first, with the two options Newest and Oldest. Then reply with the option I chose, one word. / Oldest
OBSERVED subagent: its frames carry parent_tool_use_id (the parent Agent call id)
PASS after stop: no container and no network with the session label, the config volume kept: 0 containers, 0 networks, 1 volumes
PASS the resumed session in a new container remembers the word from the first turn: Which word did I ask you to remember at the very start of this session? Reply with that one word. / PLUM
PASS ticket done: nothing with the session label remains (containers, networks, volumes): 0, 0, 0
PASS no new listening socket on the host from this run: none (0 new from other processes)
doctor: all checks passed
<< system/init {"claude_code_version":"2.1.306","model":"claude-haiku-5-5","cwd":"/workspace","permissionMode":"default","apiKeySource":"none","user_message_uuids":["<id>"]}
<< {"type":"permission_request","requestId":"<id>","toolName":"Bash","toolUseId":"<id>","input":{"command":"touch allowed.txt","description":"Create empty file allowed.txt in working directory"}}
<< result {"subtype":"success","is_error":false,"stop_reason":"end_turn","terminal_reason":"completed","result":"OK","user_message_uuids":["<id>"],"num_turns":2,"total_cost_usd":0.0005493799999999999}
<< system/init {"claude_code_version":"2.1.306","model":"claude-haiku-5-5","cwd":"/workspace","permissionMode":"default","apiKeySource":"none","user_message_uuids":["<id>"]}
<< {"type":"permission_request","requestId":"<id>","toolName":"Bash","toolUseId":"<id>","input":{"command":"rm -r olddir","description":"Recursively remove olddir directory"}}
<< result {"subtype":"success","is_error":false,"stop_reason":"end_turn","terminal_reason":"completed","result":"DENIED","user_message_uuids":["<id>"],"num_turns":2,"total_cost_usd":0.00110651}
<< system/init {"claude_code_version":"2.1.306","model":"claude-haiku-5-5","cwd":"/workspace","permissionMode":"default","apiKeySource":"none","user_message_uuids":["<id>"]}
<< result {"subtype":"success","is_error":false,"stop_reason":"end_turn","terminal_reason":"completed","result":"DENIED\n\nThe read was blocked by a PreToolUse hook that says secrets and credential files are never read in a session. I didn't retry.","user_message_uuids":["<id>"],"num_turns":2,"total_cost_usd":0.00166259}
<< system/init {"claude_code_version":"2.1.306","model":"claude-haiku-5-5","cwd":"/workspace","permissionMode":"default","apiKeySource":"none","user_message_uuids":["<id>"]}
<< result {"subtype":"success","is_error":false,"stop_reason":"end_turn","terminal_reason":"completed","result":"MAPLE","user_message_uuids":["<id>"],"num_turns":1,"total_cost_usd":0.00189668}
<< system/init {"claude_code_version":"2.1.306","model":"claude-haiku-5-5","cwd":"/workspace","permissionMode":"default","apiKeySource":"none","user_message_uuids":["<id>"]}
<< result {"subtype":"success","is_error":false,"stop_reason":"end_turn","terminal_reason":"completed","result":"SECOND","user_message_uuids":["<id>","<id>"],"num_turns":2,"total_cost_usd":0.00239594}
<< system/init {"claude_code_version":"2.1.306","model":"claude-haiku-5-5","cwd":"/workspace","permissionMode":"default","apiKeySource":"none","user_message_uuids":["<id>"]}
<< result {"subtype":"error_during_execution","is_error":true,"stop_reason":"tool_use","terminal_reason":"aborted_tools","user_message_uuids":["<id>"],"num_turns":3,"total_cost_usd":0.00264977}
<< system/init {"claude_code_version":"2.1.306","model":"claude-haiku-5-5","cwd":"/workspace","permissionMode":"default","apiKeySource":"none","user_message_uuids":["<id>"]}
<< {"type":"question","requestId":"<id>","toolUseId":"<id>","questions":[{"question":"Should the guestbook show the newest or the oldest entry first?","header":"Sort order","options":[{"label":"Newest","description":"Show the...book entry first"},{"label":"Oldest","description":"Show the earliest guestbook entry first"}],"multiSelect":false}]}
<< result {"subtype":"success","is_error":false,"stop_reason":"end_turn","terminal_reason":"completed","result":"Oldest","user_message_uuids":["<id>"],"num_turns":2,"total_cost_usd":0.00324339}
<< system/init {"claude_code_version":"2.1.306","model":"claude-haiku-5-5","cwd":"/workspace","permissionMode":"default","apiKeySource":"none","user_message_uuids":["<id>"]}
<< assistant with parent_tool_use_id [{"type":"tool_use","id":"<id>","name":"Bash","input":{"command":"pwd","description":"Print current working directory"},"caller":{"type":"direct"}}]
<< result {"subtype":"success","is_error":false,"stop_reason":"end_turn","terminal_reason":"completed","result":"/workspace","user_message_uuids":["<id>"],"num_turns":2,"total_cost_usd":0.005360605000000001}
<< system/init {"claude_code_version":"2.1.306","model":"claude-haiku-5-5","cwd":"/workspace","permissionMode":"default","apiKeySource":"none","user_message_uuids":["<id>"]}
<< result {"subtype":"success","is_error":false,"stop_reason":"end_turn","terminal_reason":"completed","result":"PLUM","user_message_uuids":["<id>"],"num_turns":1,"total_cost_usd":0.0056004850000000005}
```

The whole output (274 lines, every docker command line and every stored event) is in the lane's pull request.

### Host tools, context and login in a container (2026-10-22)

Run on this server on 2026-10-22 by lane `v2-j2-runner-host-tools` with `node v2/scripts/doctor.ts host-tools lead`, which builds the session image first; the `claude-code` section of milestone 1 passed on the same image. The setup was the same as the run above: Claude Code 2.1.306, `@anthropic-ai/claude-agent-sdk` 0.3.306, zod 4.6.7 (now pinned), `claude-haiku-5-5`, objects labelled `cleared.dev=v2` only, and the service account's login named by `CLEARED_CLAUDE_CREDENTIALS`, mounted read only and never read by the lane or the doctor. The login check below used a token file the doctor wrote itself. The three sessions of the `host-tools` section reported 0.0017 USD (the lead), 0.0012 USD (the author) and 0 USD (the invalid login). The proxy saw `api.anthropic.com:443` only.

What the run established (milestone 2 plan, section 13, lane 4's unknowns):

- **An in-process MCP server works in the container with `settingSources: []`.** The runner passes `createSdkMcpServer({ name: 'cleared', tools, alwaysLoad: true, timeout })` in `mcpServers`. `system/init` lists `{"name":"cleared","status":"connected","source":"sdk"}` and the tool `mcp__cleared__ping`. The model called it with `{"word":"plum"}`, the host ran the handler, and the model replied with the code on the answer's first line.
- **`tool()` takes a zod raw shape, not a JSON Schema** (`sdk.d.ts`: `tool<Schema extends AnyZodRawShape>`). The runner builds the shape from the host's schema subset with the image's zod (`v2/images/session/runner/schema.ts`).
- **The call's tool use id.** The handler's second argument carries `_meta['claudecode/toolUseId']`, besides `signal`, `requestId` and the MCP transport's own keys. So `cleared.host_call` is journaled under the id of the `tool_use` block.
- **Permission.** In `default` mode the CLI asks `canUseTool` for a host tool call; the policy answers `allow_once` under `lead.tools`.
- **`getContextUsage()`**, ten calls of each detail between turns:
  - Speed: `summary` had a median of 9 ms. `full` had a median of 10 ms, but its first call of a session took 0.6 s and 1 s in two runs.
  - Fields: `totalTokens`, `maxTokens`, `rawMaxTokens`, `percentage` (a whole number), `autoCompactThreshold` and `isAutoCompactEnabled`.
  - Window: for `claude-haiku-5-5`, `maxTokens` and `rawMaxTokens` are 1 000 000 and `autoCompactThreshold` is 967 000. Claude Code does not compact below 50 % on its own, and no `compact_boundary` frame was seen; `settings.autoCompactWindow` was not tried.
  - Before a turn the two details differed: `summary` read 19 181 tokens and `full` 17 829. After the turn they agreed (20 999).
- **The measure after a tool call lags.** Taken in `PostToolUse`, `summary` answers from the last response's usage, which does not count the tool's own answer yet. With an 8 461-byte answer the measure read 19 181 tokens before the call, 19 181 right after it, and 20 999 at the end of the turn.
- **Rate limits.** One `rate_limit_event` in the lead's two turns. Its `rate_limit_info` has no top-level `utilization`. The two windows are in `unifiedWindows`, which `sdk.d.ts` does not declare: `{"five_hour":{"utilization":0.03,"resetsAt":1792650600},"seven_day":{"utilization":0.15,"resetsAt":1793091600}}`. Read as the CLI's own code reads them (`Math.round(utilization * 100)`, `new Date(resets_at * 1000)`), that is 3 % and 15 %, with reset times in seconds.
- **The experimental usage call** (`usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })`) answered `rate_limits_available: false`, with no subscription type, for a session logged in with `CLAUDE_CODE_OAUTH_TOKEN`. It is recorded, not adopted.
- **The Stop hook by role.** A lead's two turns ended with no `HANDOVER.md` request. An author's turn ended with `HANDOVER.md` written, all five headings present.
- **Commit identity.** In an author session, `git commit` then `git log -1 --format=identity:%an/%ae/%cn/%ce` printed `identity:Cleared//Cleared/`: the name `Cleared` and no address. Without the variables, git 2.39 in the image refuses to commit.
- **An expired or revoked login.** With an invalid token, the CLI printed `system/api_retry` with `error: "authentication_failed"` and `error_status: 401`. The runner printed `login failed` and the turn ended as cancelled. 15 seconds later the session still waited, with the status "Waiting for a new login".
  - A rewrite of the token file in place was seen through the bind mount. The runner printed `login renewed`, resumed the same session in the same container, and failed again on the new, still invalid, token.
  - A rename over the file (a new inode) was not seen: a single-file bind mount keeps the inode it was given. So re-reading the login helps only if the host CLI rewrites its credentials file in place, which was not measured.
- **Still unknown:**
  - a valid token after a failure (only the owner may put a `setup-token` token into the service's token file, plan question 1);
  - whether the host CLI rewrites its credentials file in place when it refreshes;
  - the week share against `/usage` on the host.

Raw lines of the `host-tools` section, edited as above: ids are `<id>`, the host's paths `<scratch>`, `<state>` and `<login file>`, and a long line is cut around `...`. The doctor's own check lines come first, then the runner lines it printed (`<<`).

```console
$ CLEARED_CLAUDE_CREDENTIALS=<login file> node scripts/doctor.ts host-tools lead
== host-tools (milestone 2, lane 4)
PASS the login file (the Claude Code credentials file named by CLEARED_CLAUDE_CREDENTIALS) is a file of the service's account that only it can read: mode 600
PASS the CLI lists the in-process MCP server cleared as connected, with mcp__cleared__ping
PASS the model called mcp__cleared__ping and the host ran the handler once, with the model's input: [{"word":"plum"}]
PASS the call is journaled as cleared.host_call ok, under the tool call's own id: {"calls":[{"toolCallId":"<id>","name":"ping","input":{"word":"plum"},"outcome":"ok"}],"started":["<id>"]}
PASS the model read the host's answer: CODE-5E26A50F
OBSERVED the host tool's permission: canUseTool asked for mcp__cleared__ping; policy answers in the turn: [["allow_once","lead.tools"]]
PASS the context is measured after the tool call and after the turn, as cleared.context_usage with a percentage and rawMaxTokens: 3 events
OBSERVED the summary measure around a 8461-byte tool answer: 19181 tokens after the first turn, 19181 after the tool call, 20999 after the turn
PASS getContextUsage() timed over ten calls of each detail: summary: median 8.100000000000001 ms, max 9 ms; full: median 8.8 ms, max 9.6 ms
OBSERVED the full measure across the tool call's turn: 17829 tokens before, 20999 after (the turn added the prompt, the call, a 8461-byte answer and the reply)
OBSERVED summary and full after the turn: 20999 and 20999 tokens, 2 % and 2 %; autoCompactThreshold 967000, isAutoCompactEnabled true, maxTokens 1000000, rawMaxTokens 1000000
OBSERVED the experimental usage call: {"subscriptionType":null,"rateLimitsAvailable":false,"windows":{}}
OBSERVED rate_limit_event frames: 1
OBSERVED compact_boundary frames: 0
PASS the lead's turns ended without the Stop hook asking for HANDOVER.md: 2 turn ends
PASS a commit in the session carries the runner's identity: Cleared, no address: ["identity:Cleared//Cleared/","/workspace\n/workspace\nmaster\nfdb70eb probe"]
PASS an author still writes HANDOVER.md, asked by the Stop hook: 5 of 5 headings
PASS with an invalid token, the runner reports the login error and the turn ends as cancelled, not failed: ["failed"]
PASS 15 s later the runner still waits, and the session says it waits for a new login: status "Waiting for a new login", exited false
PASS a rewrite of the file in place is read: the runner resumes the session in the same container with the new token (which fails again, being invalid): ["failed","renewed","failed"]
OBSERVED a rename over the login file (a new inode), 25 s later: not seen by the runner: the bind mount still shows the old file
NOT MEASURED the recovering half (a valid token after a failure): no setup-token token in the service's token file (plan question 1); the proof observes a natural refresh
PASS nothing with the sessions' labels remains (containers, networks, volumes): 0 objects
PASS no new listening socket on the host from this run: none (0 new from other processes)
<< system/init {"claude_code_version":"2.1.306","model":"claude-haiku-5-5","mcp_servers":[{"name":"cleared","status":"connected","source":"sdk"}],"cleared_tools":["mcp__cleared__ping"]}
<< {"type":"context","after":"turn","detail":"summary","ms":50.4,"totalTokens":19181,"maxTokens":1000000,"rawMaxTokens":1000000,"percentage":2,"autoCompactThreshold":967000,"isAutoCompactEnabled":true}
<< (before the tool call) {"type":"measure","summaryMs":[10.5,10.2,11.4,10,9.2,9,10.5,8.4,8.5,8.3],"fullMs":[730.7,9.2,9,10.5,8.7,9.5,8.7,7,7.1,7.4],"summary":{"totalTokens":19181,"maxTokens":1000000,"rawMaxTokens":1000000,"percentage":2,"autoCompactThreshold":967000,"isAutoCompactEnabled":true},"full":{"totalTokens":17829,"maxTokens":1000000,"rawMaxTokens":1000000,"percentage":2,"autoCompactThreshold":967000,"isAutoCompactEnabled":true},"usage":{"subscriptionType":null,"rateLimitsAvailable":false,"windows":{}}}
<< {"type":"host_call","callId":"<id>","toolUseId":"<id>","name":"ping","input":{"word":"plum"}}
<< stderr cleared-runner: a host call's extra has the keys signal,sessionId,_meta,sendNotification,sendRequest,authInfo,requestId,requestInfo,taskId,taskStore,taskRequestedTtl,closeSSEStream,closeStandaloneSSEStream; its _meta claudecode/toolUseId,progressToken
<< {"type":"context","after":"tool","detail":"summary","ms":17.7,"totalTokens":19181,"maxTokens":1000000,"rawMaxTokens":1000000,"percentage":2,"autoCompactThreshold":967000,"isAutoCompactEnabled":true}
<< {"type":"context","after":"turn","detail":"summary","ms":14,"totalTokens":20999,"maxTokens":1000000,"rawMaxTokens":1000000,"percentage":2,"autoCompactThreshold":967000,"isAutoCompactEnabled":true}
<< (after the tool call's turn) {"type":"measure","summaryMs":[8.3,7.4,9,8.9,7.1,7.7,8.4,6.6,7.9,8.9],"fullMs":[8.9,8.8,9.6,8.3,8.8,7.5,7.5,8.4,8.8,9.1],"summary":{"totalTokens":20999,"maxTokens":1000000,"rawMaxTokens":1000000,"percentage":2,"autoCompactThreshold":967000,"isAutoCompactEnabled":true},"full":{"totalTokens":20999,"maxTokens":1000000,"rawMaxTokens":1000000,"percentage":2,"autoCompactThreshold":967000,"isAutoCompactEnabled":true},"usage":{"subscriptionType":null,"rateLimitsAvailable":false,"windows":{}}}
<< sdk {"type":"system","subtype":"api_retry","error":"authentication_failed","error_status":401}
<< sdk {"type":"system","subtype":"api_retry","error":"authentication_failed","error_status":401}
<< sdk {"type":"assistant","error":"authentication_failed","text":"Failed to authenticate. API Error: 401 Invalid bearer token"}
<< {"type":"login","state":"failed"}
<< sdk {"type":"result","subtype":"success","is_error":true,"result":"Failed to authenticate. API Error: 401 Invalid bearer token"}
<< {"type":"login","state":"failed"}
<< {"type":"login","state":"renewed"}
<< {"type":"login","state":"failed"}
<< rate_limit_info {"status":"allowed","resetsAt":1792650600,"rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"out_of_credits","isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.05,"resetsAt":1792650600},"seven_day":{"utilization":0.16,"resetsAt":1793091600}}}
```

The whole output, with every docker command line and every stored event, is in the lane's pull request.

### Proof

Commands as run on 2026-10-21 (the resume step of proof 3, and proofs 8, 9 and 10, were run again the same day for review round 1, to save raw output). `$T` is a temporary directory under the session scratchpad. JSON lines are raw output with these edits only: UUIDs, tool IDs and message IDs are replaced with `<id>`, the scratchpad path is shown as `$T` and the home directory as `~`, and long parts are cut, shown as `...`; the text on each side of a `...` is copied unchanged. Lines starting with `>>` (sent) and `<<` (received) are printed by the probe scripts; the script for proofs 9 and 10 is inlined there, and the scripts and their output files stayed in the scratchpad.

**1. Versions and login**

```console
$ claude --version
2.1.306 (Claude Code)
$ codex --version
codex-cli 0.163.0
$ claude auth status   # two of its fields
  "loggedIn": true,
  "authMethod": "claude.ai",
$ codex login status
Logged in using ChatGPT
```

**2. Claude print mode with stream-json output**

```console
$ cd $T && claude -p --model haiku --tools "" --no-session-persistence --strict-mcp-config \
    --max-budget-usd 0.2 --output-format stream-json --verbose 'Reply with the single word OK.' < /dev/null
{"type":"system","subtype":"hook_started","hook_id":"<id>","hook_name":"SessionStart:startup","hook_event":"SessionStart","uuid":"<id>","session_id":"<id>"}
{"type":"system","subtype":"hook_response","hook_id":"<id>","hook_name":"SessionStart:startup","hook_event":"SessionStart",...,"exit_code":0,"outcome":"success"...
{"type":"system","subtype":"init","cwd":"$T","session_id":"<id>","tools":[],"mcp_servers":[],"model":"claude-haiku-5-5","permissionMode":"default",...,"apiKeySource":"none","claude_code_version":"2.1.306",...
{"type":"assistant","message":{"model":"claude-haiku-5-5",...,"content":[{"type":"text","text":"OK"}],...
{"type":"rate_limit_event","rate_limit_info":{"status":"allowed",...,"rateLimitType":"five_hour",...
{"duration_api_ms":1409,"stop_reason":"end_turn","session_id":"<id>",...,"is_error":false,"num_turns":1,"subtype":"success","api_error_status":null,"result":"OK",...,"type":"result",...
exit=0
```

The `result` line starts with `duration_api_ms`; its `"type":"result"` field comes after `result`.

**3. Claude two-turn session on stdin, then resume in a new process**

```console
$ SID=$(cat /proc/sys/kernel/random/uuid)
$ { echo '{"type":"user","message":{"role":"user","content":"Remember the word PLUM. Reply with OK only."}}'; sleep 15
    echo '{"type":"user","message":{"role":"user","content":"Which word did I ask you to remember? One word."}}'; sleep 15; } \
  | claude -p --model haiku --tools "" --strict-mcp-config --max-budget-usd 0.2 --session-id "$SID" \
    --input-format stream-json --output-format stream-json --verbose > live.jsonl
$ grep -E '"type":"(assistant|result)"' live.jsonl
{"type":"assistant","message":{"model":"claude-haiku-5-5",...,"content":[{"type":"text","text":"OK"}],...
{"duration_api_ms":1360,"stop_reason":"end_turn","session_id":"<id>",...,"is_error":false,"num_turns":1,"subtype":"success","api_error_status":null,"result":"OK",...
{"type":"assistant","message":{"model":"claude-haiku-5-5",...,"content":[{"type":"text","text":"PLUM"}],...
{"duration_api_ms":3532,"stop_reason":"end_turn","session_id":"<id>",...,"is_error":false,"num_turns":1,"subtype":"success","api_error_status":null,"result":"PLUM",...
$ claude -p --model haiku --tools "" --strict-mcp-config --max-budget-usd 0.2 --resume "$SID" \
    --output-format json 'Repeat the word you remembered. One word.' < /dev/null
{"duration_api_ms":7389,"stop_reason":"end_turn","session_id":"<id>",...,"is_error":false,"num_turns":1,"subtype":"success","api_error_status":null,"result":"PLUM",...
```

All three `session_id` values are `$SID`.

**4. Claude permission request over stdio, answered with a deny**

A Node script spawned the command below, wrote one user line asking for `touch probe-marker.txt`, and answered the request. The `control_request` line shown is from a run with the same flags and a similar prompt whose stdin carried only the prompt; the script printed its own summary lines.

```console
$ claude -p --model haiku --tools Bash --strict-mcp-config --no-session-persistence --max-budget-usd 0.2 \
    --permission-mode default --permission-prompt-tool stdio \
    --input-format stream-json --output-format stream-json --verbose
# stdout:
{"type":"control_request","request_id":"<id>","request":{"subtype":"can_use_tool","tool_name":"Bash","display_name":"Bash","input":{"command":"touch probe-marker.txt","description":"Create empty probe-marker.txt file in working directory"},...,"permission_suggestions":[...
# stdin, written by the script (request_id copied from the request):
{"type":"control_response","response":{"subtype":"success","request_id":"<id>","response":{"behavior":"deny","message":"Denied by the probe."}}}
# then, as printed by the script:
<< tool_result is_error=true "Denied by the probe."
<< result success "DENIED"
$ ls probe-marker.txt
ls: cannot access 'probe-marker.txt': No such file or directory
```

In an earlier run of the same command with `ls` instead of `touch`, `ls` ran without any `control_request`.

**5. Claude Agent SDK, streaming input, two turns, `canUseTool` deny**

`cc-sdk.mjs`, run with `@anthropic-ai/claude-agent-sdk` 0.3.306 installed in the scratchpad:

```js
import { query } from '@anthropic-ai/claude-agent-sdk';
const cwd = process.argv[2];
const turns = ['Use the Bash tool to run exactly: touch probe-marker.txt . If it is denied, reply DENIED and do not retry.', 'Remember the word PLUM and reply with that word only.'];
let release; const gate = () => new Promise((r) => (release = r));
async function* input() {
  for (const text of turns) { const wait = gate(); yield { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null }; await wait; }
}
const q = query({ prompt: input(), options: {
  cwd, model: 'haiku', tools: ['Bash'], settingSources: [], persistSession: false, maxBudgetUsd: 0.3,
  pathToClaudeCodeExecutable: process.env.CLAUDE_BIN || undefined,
  canUseTool: async (tool, input) => { console.log('<< canUseTool', tool, JSON.stringify(input.command)); return { behavior: 'deny', message: 'Denied by the probe.' }; },
} });
for await (const m of q) {
  if (m.type === 'system' && m.subtype === 'init') console.log('<< init model=' + m.model, 'claude_code_version=' + m.claude_code_version, 'apiKeySource=' + m.apiKeySource);
  if (m.type === 'result') { console.log('<< result', m.subtype, JSON.stringify(m.result)); release(); }
}
```

```console
$ node cc-sdk.mjs $T                      # bundled binary
<< init model=claude-haiku-5-5 claude_code_version=2.1.306 apiKeySource=none
<< canUseTool Bash "touch probe-marker.txt"
<< result success "DENIED"
<< init model=claude-haiku-5-5 claude_code_version=2.1.306 apiKeySource=none
<< result success "PLUM"
$ CLAUDE_BIN=$(readlink -f ~/.local/bin/claude) node cc-sdk.mjs $T   # pathToClaudeCodeExecutable
(same five lines)
```

**6. Claude without the user's hooks**

```console
$ claude -p --setting-sources project --model haiku --tools "" --no-session-persistence --strict-mcp-config \
    --max-budget-usd 0.2 --output-format stream-json --verbose 'Reply with the single word OK.'
$ claude -p --safe-mode ... (same flags)
```

For each run, the script counted `hook_started` lines and read `result` and the init `apiKeySource`. Both runs: `hooks=0 result=OK auth=none`. The default run in proof 2 had one `hook_started`.

**7. Codex exec with JSON events**

```console
$ cd $T && codex exec --json --ephemeral --skip-git-repo-check --ignore-user-config --sandbox read-only \
    'Reply with the single word OK.' < /dev/null
{"type":"thread.started","thread_id":"<id>"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"OK"}}
{"type":"turn.completed","usage":{"input_tokens":14006,"cached_input_tokens":11520,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}
exit=0
```

stderr held one line: `Reading additional input from stdin...`.

**8. Codex exec resume**

```console
$ codex exec --json --skip-git-repo-check --ignore-user-config --sandbox read-only \
    'Remember the word PLUM. Reply with OK only.' < /dev/null > r8a.jsonl
$ TID=$(jq -r 'select(.type=="thread.started")|.thread_id' r8a.jsonl)
$ codex exec resume --json --skip-git-repo-check --ignore-user-config "$TID" \
    'Which word did I ask you to remember? One word.' < /dev/null > r8b.jsonl
$ cat r8a.jsonl
{"type":"thread.started","thread_id":"<id>"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"OK"}}
{"type":"turn.completed","usage":{"input_tokens":14010,"cached_input_tokens":11520,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}
$ cat r8b.jsonl
{"type":"thread.started","thread_id":"<id>"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"PLUM"}}
{"type":"turn.completed","usage":{"input_tokens":28043,"cached_input_tokens":23040,"cache_write_input_tokens":0,"output_tokens":11,"reasoning_output_tokens":0}}
```

The `thread_id` in `r8b.jsonl` equals `$TID`.

**9. Codex app server over stdio, two turns on one thread**

`appserver-min.mjs`, the whole probe used for proofs 9 and 10. It declines every approval request and prints each line it sends and each response, server request and selected notification it receives:

```js
// node appserver-min.mjs <cwd> <approvalPolicy> <prompt>...  Declines every approval request.
import { spawn } from 'node:child_process';
import readline from 'node:readline';
const [cwd, approvalPolicy, ...prompts] = process.argv.slice(2);
const cx = spawn('codex', ['app-server', '--listen', 'stdio://'], { cwd, stdio: ['pipe', 'pipe', 'inherit'] });
const show = new Set(['thread/started', 'turn/started', 'item/completed', 'turn/completed', 'error']);
let id = 0; const waiting = new Map(); let turnDone;
const out = (msg) => { const line = JSON.stringify(msg); console.log('>> ' + line); cx.stdin.write(line + '\n'); };
const call = (method, params) => new Promise((resolve) => { waiting.set(++id, resolve); out({ id, method, params }); });
readline.createInterface({ input: cx.stdout }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id !== undefined && !msg.method) { console.log('<< ' + line); waiting.get(msg.id)(msg.result); return; }
  if (msg.id !== undefined) { console.log('<< ' + line); out({ id: msg.id, result: { decision: 'decline' } }); return; }
  if (show.has(msg.method)) console.log('<< ' + line);
  if (msg.method === 'turn/completed') turnDone();
});
await call('initialize', { clientInfo: { name: 'cleared-probe', version: '0.0.0' } });
out({ method: 'initialized' });
const { data } = await call('model/list', {});
const model = data.find((m) => m.isDefault).id;
const { thread } = await call('thread/start', { cwd, model, sandbox: 'read-only', approvalPolicy, ephemeral: true });
for (const text of prompts) {
  const done = new Promise((resolve) => (turnDone = resolve));
  await call('turn/start', { threadId: thread.id, input: [{ type: 'text', text }] });
  await done;
}
cx.kill();
```

```console
$ node appserver-min.mjs $T never 'Remember the word PLUM. Reply with OK only.' 'Which word did I ask you to remember? One word.'
>> {"id":1,"method":"initialize","params":{"clientInfo":{"name":"cleared-probe","version":"0.0.0"}}}
<< {"id":1,"result":{"userAgent":"cleared-probe/0.163.0 (Debian 13.0.0; x86_64) ...","codexHome":"~/.codex","platformFamily":"unix","platformOs":"linux"}}
>> {"method":"initialized"}
>> {"id":2,"method":"model/list","params":{}}
<< {"id":2,"result":{"data":[{"id":"gpt-6-luna","model":"gpt-6-luna",...,"displayName":"GPT-6-Luna",...
>> {"id":3,"method":"thread/start","params":{"cwd":"$T","model":"gpt-6-luna","sandbox":"read-only","approvalPolicy":"never","ephemeral":true}}
<< {"id":3,"result":{"thread":{"id":"<id>","environments":[{"environmentId":"local","cwd":"$T",...
>> {"id":4,"method":"turn/start","params":{"threadId":"<id>","input":[{"type":"text","text":"Remember the word PLUM. Reply with OK only."}]}}
<< {"method":"thread/started","params":{"thread":{"id":"<id>",...
<< {"id":4,"result":{"turn":{"id":"<id>","rootTurnId":"<id>","items":[],"itemsView":"notLoaded","status":"inProgress","error":null,"startedAt":null,"completedAt":null,"durationMs":null}}}
<< {"method":"turn/started","params":{"threadId":"<id>","turn":{"id":"<id>",...,"status":"inProgress",...
<< {"method":"item/completed","params":{"item":{"type":"userMessage","id":"<id>","clientId":null,"content":[{"type":"text","text":"Remember the word PLUM. Reply with OK only.","text_elements":[]}]},...
<< {"method":"item/completed","params":{"item":{"type":"agentMessage","id":"<id>","text":"OK","phase":"final_answer",...
<< {"method":"turn/completed","params":{"threadId":"<id>","turn":{...,"status":"completed","error":null,...
>> {"id":5,"method":"turn/start","params":{"threadId":"<id>","input":[{"type":"text","text":"Which word did I ask you to remember? One word."}]}}
<< {"id":5,"result":{"turn":{"id":"<id>",...,"status":"inProgress",...
<< {"method":"turn/started",...
<< {"method":"item/completed","params":{"item":{"type":"userMessage",...
<< {"method":"item/completed","params":{"item":{"type":"agentMessage","id":"<id>","text":"PLUM","phase":"final_answer",...
<< {"method":"turn/completed","params":{"threadId":"<id>","turn":{...,"status":"completed","error":null,...
```

An earlier probe that sent `thread/start` without `model` (so the user config's `gpt-6-sol` applied) received, for each turn, an `error` notification with `The 'gpt-6-sol' model is not supported when using Codex with a ChatGPT account.` and a `turn/completed` with status `failed`.

**10. Codex app server approval request, answered with decline**

```console
$ node appserver-min.mjs $T untrusted 'Run the shell command: touch probe-marker.txt . If it is declined, reply DECLINED and do not retry.'
(initialize, initialized and model/list as in proof 9)
>> {"id":3,"method":"thread/start","params":{"cwd":"$T","model":"gpt-6-luna","sandbox":"read-only","approvalPolicy":"untrusted","ephemeral":true}}
>> {"id":4,"method":"turn/start","params":{"threadId":"<id>","input":[{"type":"text","text":"Run the shell command: touch probe-marker.txt . If it is declined, reply DECLINED and do not retry."}]}}
(thread/started, turn/started, the user message and one commentary agentMessage)
<< {"method":"item/commandExecution/requestApproval","id":0,"params":{"kind":"command","threadId":"<id>","turnId":"<id>","itemId":"exec-<id>",...,"environmentId":"local","command":"/bin/bash -lc 'touch probe-marker.txt'","cwd":"$T","commandActions":[{"type":"unknown","command":"touch probe-marker.txt"}],"proposedExecpolicyAmendment":["touch","probe-marker.txt"],"availableDecisions":["accept",{"acceptWithExecpolicyAmendment":{"execpolicy_amendment":["touch","probe-marker.txt"]}},"cancel"]}}
>> {"id":0,"result":{"decision":"decline"}}
<< {"method":"item/completed","params":{"item":{"type":"commandExecution","id":"exec-<id>",...,"status":"declined",...
<< {"method":"item/completed","params":{"item":{"type":"agentMessage","id":"<id>","text":"DECLINED","phase":"final_answer",...
<< {"method":"turn/completed","params":{"threadId":"<id>","turn":{...,"status":"completed","error":null,...
$ ls probe-marker.txt
ls: cannot access 'probe-marker.txt': No such file or directory
```

The request's `availableDecisions` listed `accept`, `acceptWithExecpolicyAmendment` and `cancel`, not `decline`; the server still accepted `decline` (a value of the schema's `CommandExecutionApprovalDecision`) and marked the item `declined`. The request `id` was `0` while the client's own IDs started at 1: client and server number their requests separately. An earlier run of the same prompt with `approvalPolicy: "on-request"` got no server request; its final message was `The command failed because the filesystem is read-only.`

**11. Help excerpts for the flags the recommendation relies on**

Trimmed from the output of the commands shown, 2026-10-21.

```console
$ claude --help
  -p, --print                           Print response and exit (useful for
                                        pipes). ...
  --input-format <format>               Input format (only works with --print):
                                        "text" (default), or "stream-json"
                                        (realtime streaming input) (choices:
                                        "text", "stream-json")
  --output-format <format>              Output format (only works with --print):
                                        "text" (default), "json" (single
                                        result), or "stream-json" (realtime
                                        streaming) (choices: "text", "json",
                                        "stream-json")
  --permission-mode <mode>              Permission mode to use for the session
                                        (choices: "acceptEdits", "auto",
                                        "bypassPermissions", "manual",
                                        "dontAsk", "plan")
  --permission-prompts <target>         Who answers permission prompts with
                                        --print: "host" (the SDK host or
                                        --permission-prompt-tool) or "none"
                                        (nobody: anything that would prompt is
                                        denied automatically; the permission
                                        mode still decides everything else)
                                        (choices: "host", "none", default:
                                        "host")
  --session-id <uuid>                   Use a specific session ID for the
                                        conversation (must be a valid UUID)
  -r, --resume [value]                  Resume a conversation by session ID or
                                        name, or open interactive picker with
                                        optional search term
  --setting-sources <sources>           Comma-separated list of setting sources
                                        to load (user, project, local).
  --safe-mode                           Start with all customizations
                                        (CLAUDE.md, skills, installed plugins,
                                        hooks, MCP servers, custom commands and
                                        agents, output styles, workflows, custom
                                        themes, keybindings, and more) disabled
                                        ... Admin-managed (policy)
                                        settings still apply. Auth, model
                                        selection, built-in tools and plugins,
                                        and permissions work normally. ...
  --strict-mcp-config                   Only use MCP servers from --mcp-config,
                                        ignoring all other MCP configurations
  --no-session-persistence              Disable session persistence - sessions
                                        will not be saved to disk and cannot be
                                        resumed (only works with --print)
$ codex --help
  exec              Run Codex non-interactively [aliases: e]
  app-server        [experimental] Run the app server or related tooling
  queue             Queue a message for an existing session
  -s, --sandbox <SANDBOX_MODE>
          Select the sandbox policy to use when executing model-generated shell commands
          [possible values: read-only, workspace-write, danger-full-access]
      --approve-for-me
          Route approval requests through automatic review using the workspace-write sandbox
  -a, --ask-for-approval <APPROVAL_POLICY>
          Configure when the model requires human approval before executing a command
          Possible values:
          - on-request: The model decides when to ask the user for approval
          - never:      Never ask for user approval Execution failures are immediately returned to
            the model
$ codex app-server --help
      --listen <URL>
          Transport endpoint URL. Supported values: `stdio://` (default), `unix://`, `unix://PATH`,
          `ws://IP:PORT`, `off`
          [default: stdio://]
$ codex app-server generate-ts --help
[experimental] Generate TypeScript bindings for the app server protocol
Usage: codex app-server generate-ts [OPTIONS] --out <DIR>
$ codex exec --help
      --ephemeral
          Run without persisting session files to disk
      --ignore-user-config
          Do not load `$CODEX_HOME/config.toml`; auth still uses `CODEX_HOME`
      --json
          Print events to stdout as JSONL
$ codex exec resume --help
Usage: codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]
$ codex queue --help
Usage: codex queue [OPTIONS] --thread <THREAD> --message <TEXT>
```

Also run without pasting: `claude mcp --help`, `claude mcp serve --help`, `claude auth --help`, `codex resume --help`, `codex mcp --help`, `codex login --help`, `codex features list`, `codex debug --help`. `codex mcp-server --help` and `codex proto --help` print the top-level help: neither is a subcommand in 0.163.0.

### The system prompt and the prompt cache (2026-10-25, issue #335, not verified by a run)

Lane `j3-prompt-cache` (P219) gives `query()` `systemPrompt: { type: 'preset', preset: 'claude_code', append: <CLAUDE.md>, excludeDynamicSections: true, snapshot: true }`. Read in `sdk.d.ts` of `@anthropic-ai/claude-agent-sdk` 0.3.306, the version the image pins:

- `excludeDynamicSections` takes the per-user sections out of the system prompt: the working directory, auto-memory and git status. The SDK gives them to the model again as the first user message. The SDK states the tradeoff: that context steers the model "marginally less" from a user message than from the system prompt.
- `snapshot`, the default, records the system prompt on the first request and sends the record as is for the rest of the session.

Neither was run against the real CLI: a run needs the session image and the service's login, and this lane used neither. These checks are the ones to run again:

- the `claude-code` section of the doctor: the briefing's codeword (MAPLE);
- a question about the working directory or the branch, answered from that first message;
- a second session started with the same CLAUDE.md within 5 minutes, whose `cachedInputTokens` should then cover the briefing. This one settles whether the change gains anything. The same `sdk.d.ts` says blocks after the preset's static part are not eligible for cross-session caching, and the briefing comes after it (the decisions log of 2026-10-25, P219, the lower bound).

`v2/src/session/adapters/claude-code/map.ts` turns a user frame into events only for its tool results. A context message the SDK might print therefore reaches neither the ledger nor the thread (`test/session/claude-code/map.test.ts`).

### The user setting source alone (2026-10-25, B5.5b, not verified by a run)

Lane `j3-skills-user` (the owner's decision of 2026-10-25 06:06, option A) gives `query()` `settingSources: ['user']` instead of `[]`. Read in `sdk.d.ts` of `@anthropic-ai/claude-agent-sdk` 0.3.306: `'user'` is "Global user settings (`~/.claude/settings.json`)", `'project'` the checkout's `.claude/settings.json`, `'local'` its `.claude/settings.local.json`; "Must include `'project'` to load CLAUDE.md files". `skills`, left unset, keeps "the CLI's own defaults".

In the session container the user folder is `CLAUDE_CONFIG_DIR`, the session's config volume (`/var/lib/cleared/claude-config`), not a home folder of the host, so the isolation from the host's own hooks, plugins and MCP servers ([Configuration isolation](#configuration-isolation)) holds. The base branch's `.claude/skills` is mounted read only at `skills/` in that volume (lane 15). The briefing is still appended to the system prompt, as [above](#claude-code-verified-in-a-container-2026-10-21) says.

Not run against the real CLI: a run needs the session image built again (the runner is copied into it) and the service's login, and this lane used neither. The `claude-code` section of the doctor now checks it: `system/init` lists `doctor-skill`, mounted from a skills folder, and neither `checkout-skill` from the checkout's `.claude/skills` nor a marker written by a hook of the checkout's `.claude/settings.json`.

## Cursor harness (milestone 3, lane j3-cursor-harness)

Written on 2026-10-23 with **no Cursor account and no Cursor program on this server**. Everything below is split in two: what the official pages say (read that day, not run) and what the tests prove against fakes. Nothing here was observed from a real Cursor run. The owner's trial list is at the end.

### From the documentation (not verified by a run)

Sources: cursor.com/docs/cli/overview, /cli/reference/parameters, /cli/reference/output-format, /cli/reference/permissions, /agent/hooks.

- The program is `agent` in the current pages (`cursor-agent` earlier). The adapter looks for both.
- `agent -p "<prompt>" --output-format stream-json --model <m>` runs one turn and prints one JSON object per line: `system/init` (with `session_id`, the chat's id), `user`, `assistant`, `tool_call` (`started` then `completed`, correlated by `call_id`), then `result/success`. The page documents **no token counts and no cost** in these lines. A failed turn has no `result` line; the error goes to stderr.
- `agent --resume <chatId>` resumes a chat, `agent create-chat` makes an empty one, `agent status` shows the authentication state, `agent login` signs in. `CURSOR_API_KEY` (or `--api-key`) authenticates. `--force` allows commands unless explicitly denied.
- Permissions are a JSON file, `<project>/.cursor/cli.json` or `~/.cursor/cli-config.json`, with `allow` and `deny` lists of `Shell(cmd)`, `Shell(cmd:args)`, `Read(glob)`, `Write(glob)`, `WebFetch(domain)`, `Mcp(server:tool)`. Deny wins over allow. Print mode has no prompt.
- Hooks (`beforeShellExecution`, `beforeReadFile`, `preToolUse`, with allow / deny / ask answers) are documented for the desktop app. The pages do not say the CLI runs them. The adapter therefore does not depend on them.

### How the adapter drives it

| Need | Claude Code | Cursor (this adapter) |
| --- | --- | --- |
| Process | one runner per session, stdin and stdout kept | one `docker exec` per message, the prompt on its standard input, resumed on the chat id from Cursor's first line (held in memory; also written to `<state>/cursor-chats/<session>.chat`, which nothing reads back yet: a restarted service does not resume a session, as with Claude Code) |
| Login | the mounted file, read in the container into the harness's environment | the mounted Cursor API key file (`CLEARED_CURSOR_API_KEY_FILE`, else `<state>/cursor.key`), read in the container into `CURSOR_API_KEY`; never `--api-key` |
| Guard | policy asked before every call, an ask waits in the inbox | **two layers, failing closed** (below) |
| Usage | tokens, cost, context share, rate windows | the model only, `total_cost_usd: null`; nothing estimated |
| Take over | the runner releases its harness, `claude --resume <id>` in the web terminal | the running turn ends, `agent --resume <chat> --model <m>` in the web terminal, messages refused until Give back |
| Give back | the runner reloads the transcript | the next turn resumes the chat the human left |

**Guard.** Print mode gives no way to hold a call until a person answers, so an inbox "ask" cannot work mid-turn. The adapter:

1. Compiles the session's policy into `.cursor/cli.json` before each turn (`cursor/permissions.ts`): deny first (the credential file, `.env*`, `*.pem`, `/proc/*/environ`, writes to `.git`, `.claude`, `.cursor` and `CLAUDE.md`, `printenv`, `env`, `sudo`, `curl`, `ssh`, `docker`), then a narrow allow (reads in the checkout; writes there for an author whose plan is approved; the policy's safe commands and package scripts word by word). `--force` is never passed. The write is mandatory: if the file cannot be written (a reviewer's or reader's checkout is read only) the launcher exits 4 and the program never starts (`cursor_permissions`). The file is kept out of git (`.cursor/` is in the checkout's exclude list) and the policy denies the session's own writes to `.cursor`.
2. Evaluates every `tool_call` Cursor reports with the unchanged policy (`policy.ts`). Only an allow lets the turn go on. A deny, **and an ask**, end the turn: the program is killed in the container, the thread shows the refusal (`cleared.permission_answered`, rule from the policy) and an error with the code `policy_stop`, and the session waits for the next message. This layer sees a call when it starts, so it is a tripwire, not a prevention; layer 1 is what refuses.

**Failures** are classified by exit code and a stderr pattern into fixed sentences (`cursor_login`, `cursor_not_installed`, `cursor_permissions`, `cursor_exit`, `cursor_launch`). The program's own words are never journaled.

**Reachability.** The adapter is registered as `cursor` and the terminal route picks the adapter by the session's own harness, so a Take over of a Cursor session reaches it. But the flow and the lead start every session as `claude-code` (`HARNESS` in `flow/engine.ts` and `lead/engine.ts`), so no ticket can name `cursor` yet: choosing a harness per project or ticket is a later lane. Until then a trial starts a session through the adapter directly (`createCursorAdapter(...).start({ harness: 'cursor', ... })`).

**The harness pick (2026-10-25, P213, issue #329).** A ticket started with `harnesses` runs one author variant per harness named (`flow/harness-pick.ts`), so it is the first flow path that can start a `cursor` or `codex` author. It starts only the harnesses `CLEARED_V2_PICK_HARNESSES` names (`claude-code` alone by default; `codex` on `gpt-6-luna` unless `codex=<model>`; `cursor=<model>`, as this adapter has no default model). The variable stays unset until the owner's trials above are done; the tests run fake adapters under the three names.

**Agent profiles (2026-10-28, issue #452).** The settings a session starts on are two objects of the ledger, each a list of versions that are never changed (`v2/src/profiles/`). The agent profile holds the harness (`claude-code`, or `auto`), the author's and the reviewer's models, a prompt per role added after the first prompt, the commands an author runs without asking (none the policy asks about: a deletion, an undeclared host, an install, a shell, a push), the MCP servers (none beyond Cleared's own, the only value accepted for now) and the skills (the project's, mounted as they are). The environment holds the image (one Cleared builds, `cleared-v2-<name>:<tag>`; Claude Code's sessions only), the network (`project`, or `model-only`: the model API and the npm registry alone), the hosts added to the egress allow list, and the CPUs and memory. An edit (`POST /api/profiles/agent` or `/api/profiles/environment`, the fields it changes) writes the next version; a rollback (`POST .../restore`, `{ "version": n }`, or Restore on the Services screen) writes an old version again as the next one. Version 1 of each is the service as it ran before profiles: every field says "the service's", so a ledger from before them runs as it did. Each author and reviewer session records the versions it started on, shown on its ticket card and in the pull request's receipt. A profile on `auto` makes a new ticket a harness pick on the harnesses `CLEARED_V2_PICK_HARNESSES` enables, when it enables two or more, else the ticket runs on Claude Code; a Quick ticket and a setup session are never a pick; a ticket that names its variants or harnesses keeps them. Codex and Cursor cannot be a profile's own harness: the engines' `HARNESS` stays `claude-code` (P87). No secret goes in either object: a value that looks like one is refused by the guard's patterns, and the harness's login stays mounted from the service.

**Image.** The session image does not contain Cursor. No pinned, verifiable install source was found (the documented install is `curl https://cursor.com/install | bash`, unpinned), so nothing was added to `images/session/Dockerfile`. A turn in an image without it ends with `cursor_not_installed`. `CursorRuntime.image` names an image that has it.

**Probe.** `node scripts/doctor.ts cursor` runs `--version` and `status` only, never `login`, and prints `not_installed`, `not_signed_in` or `ready`. On this server (2026-10-23, no Cursor): `cursor: not_installed`, exit 0.

### Proven with fakes (`test/session/cursor/`)

- The mapper on lines written from the documented format (`fixtures.ts`, labelled as not recorded): text, read, write, shell, result, errors, no tokens and no cost, the model as usage.
- The adapter on a fake launcher, no Docker: prompt on stdin and never in a command word, chat id kept and resumed, a denied read stops the turn, an ask stops the turn and leaves nothing in the inbox, allowed calls pass, failures by code without the program's words, interrupt, stop, handover rejected, Take over ends the turn and refuses messages, Give back resumes the chat, a malformed chat id is not kept.
- The launcher programs run by this machine's `sh` with a stand-in `agent`: the key reaches the environment only, the permissions file is written, the former program name is found, exit 127 and 3.
- The permissions compiled from the policy; the probe with stand-in programs; `docker exec` built on the labelled container only.

### Needs a real Cursor trial by the owner

1. Record one real `stream-json` turn and replace `fixtures.ts` with it (tool names other than `read` and `write` are guessed: `shell`, `grep`, `glob`, `edit`, `delete`; any unknown tool is sent to the policy under its own name, which asks, so it stops the turn).
2. Confirm that `.cursor/cli.json` is honoured in print mode, that deny lists refuse without `--force`, and that the `Shell(cmd:args)` form matches `npm test` and `git commit -m x`. A syntax that does not match only makes the agent unable to run the command (it fails closed).
3. Confirm `CURSOR_CONFIG_DIR` is honoured so chats persist on the session volume, and that `--resume` finds the chat after a stopped and restarted container.
4. Confirm the sign-in the session can use: an API key file is supported; the host's existing browser login (owner note of 2026-10-22) is not, since where it lives is unverified.
5. Confirm the egress hosts (`CURSOR_HOSTS` in `cursor.ts`) and install Cursor in a session image.
6. Confirm Cursor reads the generated `CLAUDE.md` or an `AGENTS.md` for the briefing.
7. Whether the CLI runs hooks: if it does, a `beforeShellExecution` hook would give a true ask and make layer 2 a real gate.
8. `dockerLauncher.start` has no test (it needs a Docker fake for `startSession`): it runs `sleep infinity` as the container's command, which assumes the image has no runner entrypoint, and Cursor must honour the egress proxy variables the container sets.
9. Known side effects on the other harness: the policy now denies a Claude Code author's edits under any `.cursor/` folder, and the Cursor launcher overwrites a tracked `.cursor/cli.json` in the checkout.
10. A project that tracks its own `.cursor/cli.json` or `.cursor/rules`: git's exclude list does not hide a change to a tracked file, so an author's commit could carry Cleared's permissions file, and a Claude Code author cannot edit those paths. Not restored at the end of a turn.
11. `doctor cursor` runs whatever `agent` is first on the PATH (`--version`, `status`); the name is generic. Its output is never printed.
12. Layer 2 sees a call only on `tool_call/started`; check a real stream does not send a call only as `completed`.
13. Take over: the human's terminal runs under the same permissions file; check it is usable, and that Give back leaves the chat saved.

## Codex harness (milestone 3, lane j3-codex-harness)

Written on 2026-10-24 **without a Codex account, a Codex session or a single model call**: the owner decided that Codex is tested without an account (O6). The Codex program on this server was asked for `--help` only. Everything below separates what was recorded on 2026-10-21 (the proofs earlier on this page), what the documentation and the TypeScript SDK's item types say (not run), and what the tests prove against fakes. The owner's trial list is at the end.

### Which mode, and the decision gate

The recommendation above names the app server for the v2 adapter, but its decision gate is **still open**: no run on the pinned version has shown which `approvalPolicy` sends every command and file write to the client, and this lane could not run one. The adapter therefore uses the mode the gate allows, `codex exec --json` (labelled "Stable", recorded in proofs 7 and 8), with approvals `never`, which is the same position as the Cursor adapter: nobody can be asked mid-turn, so an `ask` of the policy ends the turn. The app server stays the target once the gate passes (a true ask in the inbox, `turn/interrupt`, `turn/steer`).

### From the help of `codex-cli 0.163.0` on this server (2026-10-24, `--help` only)

- `codex exec [OPTIONS] [PROMPT]`: the prompt is read from the standard input when it is `-`. Options used: `--json`, `--skip-git-repo-check`, `-m`, `-c key=value` (TOML value). Not used: `--ephemeral` (an ephemeral thread cannot be resumed), `--dangerously-bypass-approvals-and-sandbox`, `--approve-for-me`.
- `codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]` has `--json`, `-m`, `-c` but **no `--sandbox`**: the adapter passes the sandbox as `-c sandbox_mode="..."` on every turn.
- `codex resume [OPTIONS] [SESSION_ID]` (the interactive program) has `--no-daemon` ("without the shared background server") and `--include-non-interactive` (threads started by `exec`), `-m`, `-s`, `-a`, `-c`.
- A rollout file of this server (`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<thread>.jsonl`, written by a v1 run) has `token_count` lines whose `rate_limits` hold a `primary` and a `secondary` window, each with `used_percent` (a percent), `window_minutes` (10080 for the week) and `resets_at` (seconds), and whose `info.total_token_usage.total_tokens` is `input_tokens + output_tokens`. Only the shape was read; no value was kept.

### How the adapter drives it

| Need | Cursor | Codex (this adapter) |
| --- | --- | --- |
| Process | one `docker exec` per message | one `docker exec` per message: `codex exec --json ... -`, then `codex exec resume --json ... <thread> -` on the thread from Codex's `thread.started` line (held in memory; also written to `<state>/codex-threads/<session>.thread`, which nothing reads back yet) |
| Login | API key file into `CURSOR_API_KEY` | the mounted Codex API key file (`CLEARED_CODEX_API_KEY_FILE`, else `<state>/codex.key`), read in the container into `CODEX_API_KEY`; never a command word, `codex login` never run, so no credential is written to the session's volume; `OPENAI_API_KEY` unset; `shell_environment_policy.exclude` names both so Codex's commands do not inherit them |
| Home | `CURSOR_CONFIG_DIR` on the config volume | `CODEX_HOME` on the session's config volume (`<config>/codex`): the rollout survives between turns and across Take over, and the host's own Codex configuration is never read |
| Guard | permissions file, then the policy on every call | **two layers, failing closed** (below) |
| Usage | the model only | each turn's tokens from `turn.completed`, counted so that the screen's sum is Codex's own total (below); `total_cost_usd: null`; the rate windows from the rollout after each finished turn |
| Take over | `agent --resume <chat>` | the running turn ends, `codex resume --no-daemon --include-non-interactive -m <m> -c approval_policy="on-request" -c sandbox_mode=<the role's> <thread>` in the web terminal, messages refused until Give back |
| Give back | the next turn resumes the chat | the next turn resumes the thread the human left |

**Guard.** 1. Codex's own sandbox, chosen by the role (`codex/interactive.ts`, `sandboxOf`): `read-only` for a reviewer, a reader, the lead and an author whose session plan waits for its Go; `workspace-write` for an author at work, with `sandbox_workspace_write.network_access=true` because the container's egress (B5.4d) is the network's guard and the tests reach the session's services through it. Approvals are `never`. No program ever gets `danger-full-access`, a `--dangerously-*` flag, `--full-auto`, `--approve-for-me` or `--ephemeral` (a test checks every role and both programs). 2. Every item Codex reports is evaluated once per turn by the unchanged policy (each turn is a new process, whose items are numbered from `item_0` again, so what the guard has seen and the call ids of the thread are the turn's own): a `command_execution` as `Bash` (the command read inside its `bash -lc '...'` wrapper), each file of a `file_change` as `Edit`, `Write` or `Delete`, an `mcp_tool_call` as `mcp__<server>__<tool>`, a `web_search` as `WebSearch`. Only an allow lets the turn go on; a deny or an ask kills the program in the container, says so in the thread (`cleared.permission_answered`, then `policy_stop`) and waits for the next message. A command is seen when it starts, but a file change only once it is made: for edits this layer reports after the fact, and the sandbox is what refuses. Codex names the changed files, not their text, so the requests carry none: a change of `package.json` is one the policy cannot read, so it asks (`scripts.change`) and the turn ends, and so does a lock file (`install.package`); the policy has no rule for `Delete`, so every file Codex deletes ends the turn too. Both fail closed, at the cost of a turn. The policy now locks `.codex/` in the checkout as it locks `.cursor/` (a project's own Codex configuration could otherwise be changed by a session).

**Usage.** Codex counts the cached input inside `input_tokens` and the reasoning inside `output_tokens` (a rollout's `total_tokens` is `input_tokens + output_tokens`). The Consumption screen adds input, output, cache read and cache write, so a turn's usage says `inputTokens = input_tokens - cached_input_tokens - cache_write_input_tokens`, `cachedInputTokens`, `cacheWriteInputTokens` and `outputTokens` as given: their sum is Codex's total. The session's state adds its turns, since Codex reports each turn alone (proof 8: the second turn's input is the whole thread again).

**Quota.** The recorded `exec --json` stream has no rate limits. After each finished turn the launcher runs a fixed program in the container (`RATE_LIMITS`) that prints the last `token_count` line of that thread's rollout, at most 64 KiB, and nothing else; the adapter keeps only `rate_limits` from it and says `cleared.rate_limit` for the week (10080 minutes) and the five hours (300 minutes), `used_percent` already a percent, once per change. A window of another length is not guessed. A failed read says nothing.

**Failures** are fixed sentences by exit code and a stderr pattern (`codex_login`, `codex_not_installed`, `codex_exit`, `codex_launch`), and `codex_error` for `turn.failed` or `error`. Codex's own words are never journaled.

**The week.** The seven-day window that stops new lanes (B3.11: the plan runner's week stop and the scheduler's `weekShare`) is Claude Code's subscription. Both now skip a `cleared.rate_limit` journaled on a session whose harness is another (a Codex session's window is its own and shows on its own card); a row of a session the ledger does not know still counts, as before.

**Reachability.** Registered as `codex`; the terminal route picks the adapter by the session's harness. As for Cursor, the flow and the lead start every session as `claude-code` (`HARNESS` in `flow/engine.ts` and `lead/engine.ts`), so no ticket can name `codex` yet.

**Image.** The session image does not contain Codex (`npm i -g @openai/codex@<pinned>` is the documented install; adding it to the image is the owner's trial, with the pinned version). A turn in an image without it ends with `codex_not_installed`. `CodexRuntime.image` names an image that has it.

**Probe.** `node scripts/doctor.ts codex` runs `codex --version` and `codex login status` only, never `login`, never a turn. It was not run on this server, which holds the owner's live Codex login; its tests use stand-in programs.

### Proven with fakes (`test/session/codex/`)

- The mapper (`map.test.ts`) on the recorded lines (thread, turn, message, usage) and on lines written from the documentation (commands, file changes, web search, failure, labelled in `fixtures.ts`): the usage arithmetic against a rollout's real total, the session's sum of turns, the command unwrapped, one request per changed file, rate limits from a rollout-shaped line, no cost.
- The adapter on a fake launcher (`adapter.test.ts`): the prompt on stdin only, the thread kept and resumed, the sandbox for each role and no bypass flag, the reviewer's file change and writing command stop its turn, a denied read and an ask stop the turn and leave nothing in the inbox, allowed calls pass and are checked once, the quota read after a finished turn only, failures by code without the program's words, interrupt, stop, handover rejected, Take over (the author's and the reviewer's sandbox), Give back, a turn that will not end refusing the hand over, a malformed thread id not kept.
- The launcher programs (`launcher.test.ts`) run by `/bin/sh` with a stand-in `codex` on a PATH of linked tools only (this machine's own Codex can never be found): the key in the environment only, the other key unset, the words of each program, exit 127 and 3, the rollout's last `token_count` line and nothing else, `docker exec` on the labelled container.
- The probe with stand-in programs (`probe.test.ts`).

### Needs a real Codex trial by the owner

1. Record one real `exec --json` turn with a command, a file change and a refused write, and replace the unrecorded lines of `fixtures.ts`; check the `command` shape (string or list, the `bash -lc` wrapper) and whether `file_change` ever comes as `item.started`.
2. Whether `codex exec` honours `CODEX_API_KEY` from the environment with a fresh `CODEX_HOME`, and whether the interactive `codex resume` does too (if it does not, Take over shows Codex's own sign-in screen: a login stored on the volume would then be a decision for the owner).
3. Whether Codex's Linux sandbox starts inside the session container (no capability, `no-new-privileges`): v1 saw it fail on a socket mount on the host. If it cannot, every command fails, which is safe but useless; running with the container as the only sandbox is the owner's decision, never a default.
4. Whether `exec resume` reads the prompt from `-` as `exec` does, and whether `-c sandbox_mode` takes effect on a resumed thread.
5. The interactive program's trust prompt for the checkout (the adapter does not pre-trust it, so a project's `.codex/config.toml` is not loaded), and that `--no-daemon` leaves nothing running after Give back.
6. Whether `exec --json` ever carries `rate_limits` itself, and that the rollout path (`sessions/*/*/*/rollout-*-<thread>.jsonl`) holds for the pinned version.
7. That ending the turn's process (`END_TURN`: TERM to the program and its children, then KILL) stops the native binary under the npm wrapper.
8. The egress hosts (`CODEX_HOSTS` in `codex.ts`: `api.openai.com`, `chatgpt.com`, `auth.openai.com`, from the documentation) and Codex in a session image at a pinned version.
9. The briefing: the generated context file is `CLAUDE.md`; Codex reads `AGENTS.md`. Writing it under that name too is a later lane.
10. The decision gate above: run the app server's approval test on the pinned version; if it passes, the adapter can move to the app server and an ask can wait in the inbox.

### A session's container that stops (issue #453)

The flow keeps what a resume needs on the service's side: the session's id, its input and checkout, its phase and its events. When a session's container stops before its work is done and nobody asked it to, the flow removes what the dead container left (its egress, its test services, its networks; the config volume stays), recreates the container through the adapter's `resume` on the same checkout, and tells the session that its turn was cut and its uncommitted work is still there. The thread shows the loss and "Container recreated", in English or French. It waits 5 s before the first attempt, then 10 s and 20 s; after three recreations, the next loss (or a last attempt whose resume fails) fails the session with its reason, removes its containers, networks and volume, and puts its ticket back in Todo. A session the owner took over is never recreated: its loss stops it. A session waiting for a person keeps its request in the inbox, and the answer recreates its container. A restart of the service itself still stops every session (#58).

- **Claude Code** is recreated. Its runner is the container's command, so the adapter sees the container stop when the attached `docker start` ends with no exit line from the runner and no `stop()` running: `RUN_ERROR` `container_lost`. A runner that says why it exits stays `runner_exit` and is not recreated. Its transcript is on the config volume, so `resume` starts the same session in the new container (verified on 2026-10-21, above). The resumed process goes on with the session's running `total_cost_usd` (0.00536 USD before the recreation, 0.00560 after, in that run), so the session's cost is its last total, each process counted once; a total that starts again lower is read as a new process and added. The flow journals `cleared.container_recreated` where the new process starts.
- **Codex and Cursor are not recreated.** Their container's command is `sleep infinity` and each turn is a `docker exec`, so nothing watches the container between turns: a container killed mid-turn shows as that turn's failure (`codex_exit`, or Cursor's), and the ticket goes back to Todo as before. Codex's thread is on the config volume (`CODEX_HOME`), so a recreated container could resume it with `codex exec resume <thread>`; detecting the loss (a `docker wait` on the container, or the exec's exit code 137) is the missing part, left for a later lane.

## v1 adapter contract

This is the contract implemented today by `adapters/claude.sh` and `adapters/codex.sh`, which run one `run` per prompt.

Ticket trackers use a separate contract documented in [Ticket trackers](trackers.md). A model adapter never calls a provider API directly; it uses `tracker.ts` for ticket actions.

An adapter is an executable `adapters/<name>.sh`. Routing uses `[models] alias = adapter:model-id`; dispatch scripts name neither provider nor model. `lib/contract.sh` contains the shared report helpers. An adapter can be added without changing the dispatcher when it implements the commands below and declares its model IDs in the project configuration.

| Command | Required behavior |
| --- | --- |
| `list-models [id...]` | Print runnable model IDs, one per line, optionally limited to candidates. An unavailable CLI prints no IDs. |
| `probe ID` | Ask the real CLI one small question ("Reply with the single word OK.") exactly as `run` starts it (same account, prefixes and environment, no API key), from an empty folder, under a timeout (`CLEARED_PROBE_TIMEOUT` seconds, default 120). Print `ok ID` when the answer holds the word, else `FAIL ID: <reason>` (its first line, with anything that looks like a key hidden) and exit 1. |
| `version` | Print one JSON object with `cli`, `installed`, `latest`, and `days_behind` (null when unknown). |
| `run --model ID --prompt-file FILE --report FILE --usage FILE` | Work in the current worktree, save a `lane-report/1` report and usage JSON, and return an exit code below. |
| `talk --model ID --prompt-file FILE [--session-id UUID]` | Optional interactive session in the current terminal. Return 2 when unavailable here. |

`run` exits 0 after a completed run, 2 if nothing reached the model, 3 if the provider's own guard refused the task, 5 when a configured budget stopped the run, and another nonzero code for a failure. Only code 2 triggers the normal fallback chain. Code 3 follows `[policy] guard_refusal`; an ordinary failure is reported without trying another model. The report has YAML-like front matter with run ID, lane, ticket, role, selected and actual model, outcome, times, exit code, and usage fields, followed by `## Report` and `## Changed files`. Readers also accept the earlier French headings. `usage.json` can contain `model`, token counts, `cost_usd`, and provider limits; unknown values remain null.

A model used for `review` must differ from the one recorded as the pull request's author. A review runs read-only, has its own worktree, and should not run tests or edit the change. The CLI's tool permissions are mapped from `[permissions.<role>]`; the host and any containers still need their own isolation. See [Security](security.md).

### Existing adapters

`adapters/claude.sh` invokes Claude Code on the host. `adapters/codex.sh` invokes Codex on the host by default, in the same lane worktree. Both work in the same lane with its linked dependencies, host-installed browser and test database, heavy-command gate, and capture directory. Provider-specific browser tools still depend on each CLI configuration. A host Codex session holds the heavy-command slot (the door of `when-free.sh`, [`[lanes] heavy_lock`](configuration.md#lanes)) for its entire run, from the service's process, and passes its path to the CLI as `CLEARED_HEAVY_SLOT`, also through `sudo` under `agent_user`, so that its own heavy commands do not wait on it. It commits its own changes, except under `agent_user`, where Git's control files are read-only to it. In every mode, what a session of a pushed role leaves uncommitted in its lane is committed by the dispatcher after it (see [Security](security.md#permissions-and-host-access)). `task_tools` and `commits` apply only to the container runner. Set `[adapter.codex] runner = container` to use the project's executable named by `task_script`.

Codex's `list-models` only reads the model list the CLI cached from its server (`~/.codex/models_cache.json` of the account that runs it): a listed model proves neither a login nor an answer. `probe` is the proof for both adapters: Claude is asked with `-p --tools "" --no-session-persistence --strict-mcp-config`, no helper model and a small `--max-budget-usd` guard; Codex with `exec --json --ephemeral --skip-git-repo-check --ignore-user-config --sandbox read-only`. With `runner = container`, Codex's `probe` prints `skip` instead: the project's task script is not probed. `serve/check-harness.sh` runs `probe` once for each model the configuration can start, and `serve/install.ts` runs that script before it installs any unit (see [Security](security.md#installing-the-release-account-boundary)).

| Role | Claude Code CLI | Codex CLI on host |
| --- | --- | --- |
| `dev`, `mechanical` | `acceptEdits`, configured allowed and denied Bash prefixes, no approval prompt | `:workspace` profile, lane worktree writable, network enabled for the local test database, `approval_policy=never` |
| `release`, `review` | Edit/Write denied, configured Bash prefixes | `:read-only` profile, network disabled, `approval_policy=never` |
| `triage`, `cleanup`, `writing`, `digest` | Edit/Write denied; optional Bash prefixes from each role | `:read-only` profile, network disabled, `approval_policy=never` |
| `release-live` | Edit/Write denied; the release command calls the local broker. With `agent_user`, the session runs in the project's main checkout, without bubblewrap | The host runner skips the Codex sandbox because its Linux socket mount failed in testing. With `agent_user`, the distinct UID is the boundary. Without it, status reports that there is no security boundary. |
| `talk` | Edit/Write denied; configured decision scripts can update state | Interactive discussion is unavailable; the adapter returns 2 so routing can try another harness. |

These rows come from the same `[permissions.<role>]` section. `mode` selects read-only or workspace writing; `network` selects Codex sandbox network access; `write` records paths needed by trusted scripts. Host Codex refuses a read-only role with a configured state write grant; the release role clears that grant and calls the broker. The example config gives `network = yes` to development roles for TCP test databases and to the live lead and talk roles. Review and read-only support roles use `network = no`. Network-on allows external destinations too; Codex cannot limit this to a local database without a separately configured proxy or host firewall. A role with no permission section retains Claude's user settings and gets Codex's read-only default; define the section if you route that role to either harness.

The CLIs enforce different things. Claude receives an allowed command-prefix list but its CLI permissions are not OS isolation and a permitted command can reach the network. Codex has no equivalent command allowlist: its [OS sandbox profile](https://learn.chatgpt.com/codex/permissions) limits writes and network access, but a process can run any installed command within those boundaries. When `[security] agent_user` is set, both harness CLIs run under that account. The Codex profile hides common credential stores and the ledger from development roles, but any other readable file may be reached by commands. Noninteractive Codex runs ignore the user config to keep the selected permission profile effective, so user-configured MCP tools are not inherited. Interactive Codex discussion is unavailable from this adapter and returns 2 for the configured fallback. A text-only Codex run remains read-only and ephemeral, but its CLI still offers a shell tool; Claude disables tools entirely for that path. Network-enabled roles and project tests can still contact external services. With `agent_user`, bubblewrap mounts Git control data read-only and the dispatcher commits team file changes after the session. It also gives the session its own process namespace and `/proc`, so that nothing the harness started outlives a closed session (see [Security](security.md#permissions-and-host-access)); a command that looks for host processes (`ps`, `pgrep`) sees only the session's own. The `release-live` role sends release and approval requests to the service-owned Unix socket; its review and communication commands use a narrow service-account lead action wrapper. It no longer receives state or main-checkout write access. See [the release lock](security.md#release-lock-threat-model) for account and socket setup. Neither CLI's settings replace a dedicated operating-system account or a human review.

The optional container task script receives `<worktree> <prompt-file> <model> [--tools]`. It must run Codex in the environment chosen by the project, leave file changes in that worktree, print the model's answer on stdout, and print usage records such as `token usage <json>` and `rate limits <json>` on stderr when available. Exit 0 means success, 2 means no session started, and 3 means a provider guard refusal. With `task_tools = yes`, list the script in `[lanes] heavy_commands` so it waits for the host's heavy-command gate. The dispatcher commits returned changes under the model's `.commit-message` or a fallback title, whatever `commits` says; a script that commits by itself keeps its commits as it made them. The container is project-owned; Cleared does not embed its recipe or promise that it follows host permissions.

### Add an adapter

1. Copy the command structure of an existing adapter and source `lib/contract.sh` for `run` reports and usage.
2. Make `list-models` report only IDs that can start now. Make `probe` start the CLI with the same function as `run`, so that it proves what a lane would meet. Keep `version` fast and return null for unavailable metadata.
3. Translate `[permissions.<role>]` into the CLI's own controls. Document any command or file access they cannot enforce.
4. Add `[adapter.<name>]` settings and `[models]` aliases to the project config, with a fallback and prices if known.
5. Test no-output, cannot-start, guard-refusal, success, and an actual report. The dispatcher must be able to tell code 2 from a failed run.

The adapter contract is stable for this alpha only as exercised by the tests; check existing callers before changing a report field. Terminals have their own adapters, chosen by `[terminal] adapter` (see [Configuration](configuration.md#terminal)); their contract is at the top of `lib/terminal/orca.sh`.
