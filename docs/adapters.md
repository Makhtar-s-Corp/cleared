# Model adapters

This page has two parts. [v2 session driving modes](#v2-session-driving-modes) records how Claude Code and Codex can be driven programmatically as live sessions, verified on this server on 2026-10-21, and recommends one mode per harness for the v2 session adapter. [v1 adapter contract](#v1-adapter-contract) documents the `adapters/*.sh` contract that the current code still implements.

## v2 session driving modes

Cleared v2 runs each harness as a live session (one Docker container per session) instead of one `run` per prompt. The adapter therefore needs: several user turns in one session, a stream of events, permission requests answered by Cleared, interrupt, resume after a restart, and an explicit model.

Every statement below comes from the installed CLI's own help or behavior, from a run on this server, or from the linked official page. "Unknown" means it was not verified.

### Method and versions

Checked on 2026-10-21 on this server (Linux 6.12). All runs happened in a temporary directory under the session scratchpad, never in a repository. No port was opened, no Docker command ran, and no container was involved. Nothing in this section was tested inside a container. Both CLIs were already logged in: Claude Code with a claude.ai subscription (`claude auth status`: `"authMethod": "claude.ai"`), Codex with ChatGPT (`codex login status`: `Logged in using ChatGPT`).

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

Official docs (the `developers.openai.com/codex/*` URLs redirect with 308 to these): [CLI commands](https://learn.chatgpt.com/docs/developer-commands), [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode), [App Server](https://learn.chatgpt.com/docs/app-server), [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk), [TypeScript SDK README](https://github.com/openai/codex/tree/main/sdk/typescript), [Hooks](https://learn.chatgpt.com/docs/hooks), [MCP](https://learn.chatgpt.com/docs/extend/mcp), [Sandboxing](https://learn.chatgpt.com/docs/sandboxing), [Approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security), [Config reference](https://learn.chatgpt.com/docs/config-file/config-reference), [Authentication](https://learn.chatgpt.com/docs/auth).

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

Why: it is the only Codex mode with several turns in one process, approval requests the driver can answer, steering and interrupt. `codex exec` and the TypeScript SDK (which spawns `exec` per turn) cannot answer approvals. `codex-acp` uses the app server itself. Costs: it is labeled experimental and "not supported for production workloads", so pin the CLI version in the image, run a contract test (two turns, one declined approval, one interrupt) before each upgrade, and keep `codex exec --json` plus `exec resume` (stable) as the fallback for roles that need no approvals. Before relying on approvals, settle which `approvalPolicy` routes every write to the client: `untrusted` produced the request here but the docs call it unsupported, and `on-request` let the sandbox decide.

Not tested and needed before the adapter ships: either mode inside a Docker container labeled `cleared.dev=v2`, container login (`CLAUDE_CODE_OAUTH_TOKEN` or a mounted `CLAUDE_CONFIG_DIR`; Codex `CODEX_HOME`), an allow decision, interrupt, and `thread/resume` on the app server.

### Proof

Commands as run on 2026-10-21; `$T` is a temporary directory under the session scratchpad. JSON lines are copied from the saved output, cut to about 220 characters (a cut is shown as `...`); session and thread IDs are replaced with `<id>`. Where a line says "fields selected with jq", only those fields were kept. Lines starting with `>>` (sent) and `<<` (received) are printed by the Node probe scripts, which lived in the scratchpad and are not part of this repository; `# params:` lines are comments added here.

**1. Versions and login**

```console
$ claude --version
2.1.306 (Claude Code)
$ codex --version
codex-cli 0.163.0
$ claude auth status   # trimmed to two fields
  "loggedIn": true,
  "authMethod": "claude.ai",
$ codex login status
Logged in using ChatGPT
```

**2. Claude print mode with stream-json output**

```console
$ cd $T && claude -p --model haiku --tools "" --no-session-persistence --strict-mcp-config \
    --max-budget-usd 0.2 --output-format stream-json --verbose 'Reply with the single word OK.' < /dev/null
{"type":"system","subtype":"hook_started","hook_id":"<id>","hook_name":"SessionStart:startup","hook_event":"SessionStart","session_id":"<id>"}
{"type":"system","subtype":"hook_response","hook_id":"<id>","hook_name":"SessionStart:startup","hook_event":"SessionStart","exit_code":0,"outcome":"success",...}
{"type":"system","subtype":"init",...,"session_id":"<id>","model":"claude-haiku-5-5","permissionMode":"default",...,"apiKeySource":"none","claude_code_version":"2.1.306",...}
{"type":"assistant","message":{"model":"claude-haiku-5-5",...,"role":"assistant","content":[{"type":"text","text":"OK"}],...}
{"type":"rate_limit_event","rate_limit_info":{"status":"allowed",...,"rateLimitType":"five_hour",...}
{"type":"result",...,"stop_reason":"end_turn","session_id":"<id>","total_cost_usd":0.00086079,...}
exit=0
```

Fields selected with jq from the same output: init `{"tools":[],"permissionMode":"default"}`, result `{"subtype":"success","is_error":false,"num_turns":1,"result":"OK"}`.

**3. Claude two-turn session on stdin, then resume in a new process**

```console
$ SID=$(cat /proc/sys/kernel/random/uuid)
$ { echo '{"type":"user","message":{"role":"user","content":"Remember the word PLUM. Reply with OK only."}}'; sleep 15
    echo '{"type":"user","message":{"role":"user","content":"Which word did I ask you to remember? One word."}}'; sleep 15; } \
  | claude -p --model haiku --tools "" --strict-mcp-config --max-budget-usd 0.2 --session-id "$SID" \
    --input-format stream-json --output-format stream-json --verbose
# fields selected with jq:
{"type":"assistant","message":{"model":"claude-haiku-5-5","content":[{"type":"text","text":"OK"}]}}
{"type":"result","subtype":"success","result":"OK","num_turns":1,"is_error":false}
{"type":"assistant","message":{"model":"claude-haiku-5-5","content":[{"type":"text","text":"PLUM"}]}}
{"type":"result","subtype":"success","result":"PLUM","num_turns":1,"is_error":false}
$ claude -p --model haiku --tools "" --strict-mcp-config --max-budget-usd 0.2 --resume "$SID" \
    --output-format json 'Repeat the word you remembered. One word.' < /dev/null
# fields selected with jq:
{"session_id":"<id>","result":"PLUM","num_turns":1,"is_error":false}
```

**4. Claude permission request over stdio, answered with a deny**

The probe spawned the command below, wrote one user line, and answered the `can_use_tool` request with the `control_response` shown in [Streaming JSON input](#streaming-json-input-live-session-in-one-process).

```console
$ claude -p --model haiku --tools Bash --strict-mcp-config --no-session-persistence --max-budget-usd 0.2 \
    --permission-mode default --permission-prompt-tool stdio \
    --input-format stream-json --output-format stream-json --verbose
<< control_request can_use_tool Bash "touch probe-marker.txt"
>> control_response deny
<< tool_result is_error=true "Denied by the probe."
<< result success "DENIED"
$ ls probe-marker.txt
ls: cannot access 'probe-marker.txt': No such file or directory
```

In an earlier run of the same command with `ls` instead of `touch`, `ls` ran without any `control_request`.

**5. Claude Agent SDK, streaming input, two turns, `canUseTool` deny**

Options: `{ cwd, model: 'haiku', tools: ['Bash'], settingSources: [], persistSession: false, maxBudgetUsd: 0.3, canUseTool }`, prompt from an async generator that yields the next user message after each `result`.

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

The probe counted `hook_started` lines and read the `result` line and init `apiKeySource`. Both runs: `hooks=0 result=OK auth=none`. The default run in proof 2 had one `hook_started`.

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
    'Remember the word PLUM. Reply with OK only.' < /dev/null
{"type":"thread.started","thread_id":"<id>"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"OK"}}
{"type":"turn.completed","usage":{"input_tokens":13620,"cached_input_tokens":11520,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}
$ codex exec resume --json --skip-git-repo-check --ignore-user-config <id> \
    'Which word did I ask you to remember? One word.' < /dev/null
# fields selected with jq (type, thread_id, item.text), same thread ID as above:
{"type":"thread.started","thread_id":"<id>","text":null}
{"type":"item.completed","thread_id":null,"text":"PLUM"}
```

**9. Codex app server over stdio, two turns on one thread**

The probe spawned `codex app-server --listen stdio://` and wrote JSON-RPC lines such as `{"id":1,"method":"initialize","params":{"clientInfo":{"name":"cleared-probe","version":"0.0.0"}}}`.

```console
>> initialize
<< initialize ok, keys=userAgent,codexHome,platformFamily,platformOs
>> model/list
<< model/list gpt-6-luna* gpt-5.6-terra gpt-5.6-luna
# params: {cwd, model: "gpt-6-luna", sandbox: "read-only", approvalPolicy: "never", ephemeral: true}
>> thread/start
<< thread/start ok, model=gpt-6-luna
# params: input text "Remember the word PLUM. Reply with OK only."
>> turn/start
<< agentMessage: OK
<< turn/completed completed
# params: input text "Which word did I ask you to remember? One word."
>> turn/start
<< agentMessage: PLUM
<< turn/completed completed
```

The first attempt, without `model` (so the user config's `gpt-6-sol` applied), returned for each turn: `<< error ... "The 'gpt-6-sol' model is not supported when using Codex with a ChatGPT account."` and `<< turn/completed failed`.

**10. Codex app server approval request, answered with decline**

```console
# params: same as proof 9 except approvalPolicy: "untrusted"
>> thread/start
# params: input text "Run the shell command: touch probe-marker.txt . If it is declined, reply DECLINED and do not retry."
>> turn/start
<< server request item/commandExecution/requestApproval "/bin/bash -lc 'touch probe-marker.txt'"
>> response {"decision":"decline"}
<< commandExecution declined
<< agentMessage: DECLINED
<< turn/completed completed
$ ls probe-marker.txt
ls: cannot access 'probe-marker.txt': No such file or directory
```

Same prompt with `approvalPolicy: "on-request"`: no server request; `<< agentMessage: The command failed because the filesystem is read-only.`

**11. Help output checked**

`claude --help`, `claude mcp --help`, `claude mcp serve --help`, `claude auth --help`, `codex --help`, `codex exec --help`, `codex exec resume --help`, `codex resume --help`, `codex app-server --help`, `codex app-server generate-json-schema --help`, `codex mcp --help`, `codex queue --help`, `codex login --help`, `codex features list`, `codex debug --help`. `codex mcp-server --help` and `codex proto --help` print the top-level help: neither is a subcommand in 0.163.0.

## v1 adapter contract

This is the contract implemented today by `adapters/claude.sh` and `adapters/codex.sh`, which run one `run` per prompt.

Ticket trackers use a separate contract documented in [Ticket trackers](trackers.md). A model adapter never calls a provider API directly; it uses `tracker.sh` for ticket actions.

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

Codex's `list-models` only reads the model list the CLI cached from its server (`~/.codex/models_cache.json` of the account that runs it): a listed model proves neither a login nor an answer. `probe` is the proof for both adapters: Claude is asked with `-p --tools "" --no-session-persistence --strict-mcp-config`, no helper model and a small `--max-budget-usd` guard; Codex with `exec --json --ephemeral --skip-git-repo-check --ignore-user-config --sandbox read-only`. With `runner = container`, Codex's `probe` prints `skip` instead: the project's task script is not probed. `serve/check-harness.sh` runs `probe` once for each model the configuration can start, and `serve/install.sh` runs that script before it installs any unit (see [Security](security.md#installing-the-release-account-boundary)).

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
