# Cleared v2: milestone 1 plan

Milestone 1 takes one ticket from Todo to live, entirely in sessions. This page splits it into ten lanes, orders them in waves of at most three, fixes the session contract, the event subset, the policy rules and the way Claude Code is driven, and lists what the owner still has to decide. It contains no code: every lane writes its own, tests first.

Written on 2026-10-21 by a Fable 5.1 planning session (logged in [decisions-log.md](decisions-log.md)). Inputs: the brief (sections 3 to 6), the owner's decisions of 2026-10-21, the harness design note, [keep-and-drop.md](keep-and-drop.md), [decisions-log.md](decisions-log.md), [adapters.md](../adapters.md) and the `v2/` skeleton at commit `88226e1`. Every version, port, line number and command below was read or run on this server on 2026-10-21; "unknown" marks what was not verified.

## 1. The proof, as measured steps

The milestone is proven when the owner does the following in the app, with no command on the server, and each step's duration is shown:

| Step | What the owner does or sees | Measured as |
| --- | --- | --- |
| 1 | Creates a ticket in the app, signed in with a password | ticket created at |
| 2 | Moves it to Todo | Todo at |
| 3 | Sees a Claude Code session start in its own Docker container and work live | container start to first event, then working time |
| 4 | Writes a message to the session mid run; the session takes it into account | sent at, acknowledged at |
| 5 | Answers a risky permission request from the inbox | waiting for the human (counted apart from working time) |
| 6 | Sees a review session by another model and its verdict | review duration, rounds |
| 7 | Sees the release in the inbox and approves it (password session) | waiting for approval |
| 8 | The change goes live through the existing lock, health watch and rollback | merge to first healthy probe |

The demo runs on a small example web app with tests and a test database under `examples/`, then, with the owner's agreement, on one real low-risk GetSeetu ticket (brief, section 6). This plan covers the example only; the GetSeetu run is a milestone proof step for the orchestrator, after the owner's go.

The durations come from `STEP_STARTED` and `STEP_FINISHED` events (section 4) with these step names: `workspace`, `author`, `waiting_human`, `review`, `approval`, `release`, `watch`. The session screen shows them in its Checks card, the inbox release card shows "Opus wrote it in N min, Sonnet reviewed it, one round", and the tower shows them under Landed today.

## 2. Decisions this plan takes

Each decision below is taken here so that lanes do not re-decide it. The orchestrator copies each one into [decisions-log.md](decisions-log.md), with its consequences, when the lane that implements it lands.

1. **Claude Code is driven through the Agent SDK in streaming input mode, not ACP.** Section 6 gives the reasons, from [adapters.md](../adapters.md).
2. **The SDK runs inside the session container**, in a small runner process. The host side of the adapter talks to the runner over the container's stdin and stdout, one JSON object per line. Section 6.
3. **The service talks to Docker through the `docker` CLI** (`docker` 29.8.1 is installed on the host), spawned as a child process with `--format '{{json .}}'`, never through a client library. Every call that lists, stops or removes carries `--filter label=cleared.dev=v2`, and every object the service creates carries `--label cleared.dev=v2` and `--label cleared.session=<id>`. Reason: no dependency, and the label rule is easy to prove in a test that inspects every command line the service builds.
4. **Network isolation is a per-session internal Docker network plus an egress proxy container.** The session container and its test services sit on a `--internal` network (no route to the host or the Internet). A sibling egress container, on that network and on a bridge, is an HTTP CONNECT proxy with an allow list: the model API, the declared package registries, the project's declared hosts. The session gets `HTTPS_PROXY` and `HTTP_PROXY` pointing at it. Reason: it needs no root and no host firewall rule, and it gives exactly the reach the brief lists (5.4). What it costs: a small proxy to write (section 8, lane 2) and a check that Claude Code and npm honour the proxy variables (unknown here, verified by lane 2).
5. **The v2 app is a new process under `v2/app/`, in TypeScript**, on port 8792. It carries over from `app/` what the owner decided to keep: `app/DESIGN.md`, the style tokens and fonts of `app/public/style.css`, the en and fr catalog mechanism, the session cookie model and, in milestone 2, the web notifications. The v1 app stays untouched until milestone 4. Reason: the v1 app renders a snapshot file written by the wake; v2 renders live sessions, users and an inbox, and the rule "JavaScript is converted when touched" would otherwise force a rewrite of every v1 app file in milestone 1. This refines the `app/` rows of keep-and-drop.md: the design, the catalog and the notifications are what is kept; the v1 server and screens are replaced.
6. **An approval is the signed-in app session; the service signs it; the lock stays as it is.** The v1 app signs the human's writes to the local tracker with an Ed25519 key (`docs/trackers.md`, "Local SQLite" under the app's human writes). In v2 that key is generated at setup and held by the service process only (service owned, mode 0600, outside the project, never read by the app). The app authenticates the signed-in user with the password session, then forwards the approval to the service over the loopback channel that carries the shared secret (section 7). The service signs the human's move to the go state only for a request that arrived over that channel with a user id, bound to the request time and the shown heads through `approval_context`. `merge-pr.sh`, `ask-validation.sh`, the release broker and `lib/tracker/adapters/local.mjs` keep their checks: the human's own move to the go state, after the request, for the exact versions shown. The brief's rule holds by construction: an agent session runs in a container that mounts neither the key, nor the ledger, nor the broker socket, nor the shared secret, so nothing coming from a session can produce that signature or reach the route that produces it. Lane 8 owns the service's approval route, the signer and the key setup, and no file of the app; lane 6 owns the app's login and forwarding. Lane 8 settles the three places where v1 ties identity to Unix accounts (section 8).
7. **Milestone 1 accepts `[security] allow_shared_uid = true`** for the example project. The release broker refuses a request from the service UID without an agent account or that setting (`serve/release-broker.mjs` line 116). The risk that setting names, an agent under the same UID calling the socket, does not exist in v2: agents run in containers. The broker gets a v2 setting that says so when it moves to Node (milestone 4).
8. **Events are AG-UI 1.0, a fixed subset**, with Cleared's own items as `CUSTOM` events (section 4). The service stores the cleaned events in the ledger file with `node:sqlite` and pushes them to the app over server-sent events.
9. **The example project is a guestbook**: one page that lists and adds entries, a Postgres database, tests with `node --test`, a `/health` route, a devcontainer file, a GitHub Actions workflow, and a deploy watcher that mimics a deployment system (section 8, lane 3). Postgres is chosen because it is the common case the brief names, a test service that must be a sibling container, and because SQLite would prove nothing about sibling containers.
10. **Ports**: service `127.0.0.1:8791` (the skeleton's default), app `127.0.0.1:8792`, example app `127.0.0.1:8793`. `ss -ltn` on 2026-10-21 showed these ports free and these in use: 22, 80, 443, 6001, 6002, 6768, 8000, 8080, 8788, 9119, 15432, 20241, 35189, 38979, 39595, 43129, 45125. Every lane that listens runs `ss -ltn` first and binds `127.0.0.1` only. The egress proxy and Postgres publish no host port.
11. **Tickets stay in the local tracker's tables** (`tracker_tickets`, `tracker_history`, `tracker_comments` in `ledger.db`, schema in `lib/tracker/adapters/local.mjs` lines 10 to 31). The v2 service writes them from TypeScript. Reason: `merge-pr.sh` reads the human's move through `tracker.sh moved-by-owner` (`lib/tracker/cli.mjs` lines 35 to 46) and `ask-validation.sh` posts the request on the ticket; keeping the tables keeps the lock unchanged.
12. **The session's workdir is a host directory bind mounted into the container.** The service clones the project once per project (its own checkout, the one `merge-pr.sh` and the release watch read as `ORCH_REPO`) and once per ticket (the session's workdir, on the ticket branch). The service pushes the branch and opens the pull request from the host with the forge credential; the container never holds one.
13. **Memory reaches the session as a generated `CLAUDE.md`** at the root of the workdir, excluded from git through `.git/info/exclude`, built from `lib/memory`'s briefing. The three Cleared rules (no push to the base branch, the guard before anything leaves, `HANDOVER.md` at the end) are SDK hooks in the runner (`PreToolUse`, `Stop`), not shell hooks in settings files. Reason: the SDK accepts in-process hook callbacks ([adapters.md](../adapters.md), "Agent SDK"), which are typed, tested with the runner and need no guard binary path inside the image beyond what the image already carries.

## 3. The session contract

The contract is the only thing the core sees of a harness. It is aligned on ACP so that a harness that speaks ACP can be wired with a thin adapter later (milestone 3 or after): every method, decision kind, tool kind and stop reason below is either an ACP name or has a one-line mapping to one. ACP names were read from the protocol's `schema.json` of the latest GitHub release, downloaded on 2026-10-21; `@agentclientprotocol/sdk` is at 2.0.0 on npm the same day.

```ts
// v2/src/session/contract.ts (lane 1). Erasable syntax only: no enum.
// SessionEvent (the envelope of section 4) is defined in v2/src/session/events.ts
// and imported here; NotImplemented is an Error subclass defined in this file.
// Role, Harness and the other names of this file are owned here. Policy and
// Verdict are owned by v2/src/session/policy.ts, which imports Role from this
// file; this file imports Policy from policy.ts. Both imports are type-only
// (import type), so the cycle has no runtime effect under type stripping.

export type Harness = 'claude-code' | 'codex';            // codex: milestone 3
export type Role = 'author' | 'reviewer' | 'lead';         // lead: milestone 2
export type SessionId = string;                            // UUID chosen by Cleared; given to the harness when it accepts one
export type UserId = string;                               // a row of the users table (lane 6)

export type Briefing = {
  readonly projectPage: string;
  readonly decisions: readonly string[];                   // approved decisions linked to the ticket
  readonly glossary: readonly string[];
  readonly lessons: readonly string[];                     // for this role
  readonly lastHandover: string | null;
};

export type StartInput = {
  readonly project: string;
  readonly ticket: string;
  readonly role: Role;
  readonly harness: Harness;
  readonly model: string;                                  // explicit, for example 'claude-opus-5-5'
  readonly workdir: string;                                // host path of the ticket checkout, mounted in the container
  readonly briefing: Briefing;
  readonly policy: Policy;                                 // section 5
  readonly prompt: string;                                 // the first user turn: the ticket and its criteria
};

export type UserMessage = {
  readonly text: string;
  readonly by: UserId;                                     // every message is attached to a user (brief 5.9)
};

// What answers a permission request or a question. The first four are ACP's
// PermissionOptionKind values; 'answer' serves a question; 'cancelled' is the
// outcome ACP requires when the turn was interrupted while a request waited.
export type Decision =
  | { readonly kind: 'allow_once' }
  | { readonly kind: 'allow_always'; readonly scope: 'project' }
  | { readonly kind: 'reject_once'; readonly message: string }
  | { readonly kind: 'reject_always'; readonly message: string }
  | { readonly kind: 'answer'; readonly answers: Readonly<Record<string, string>> }
  | { readonly kind: 'cancelled' };

export type Answer = {
  readonly decision: Decision;
  readonly by: UserId | 'policy';                           // who decided: a user, or a policy rule
  readonly rule?: string;                                   // the rule id when the policy decided
};

// ACP StopReason values, plus 'error' for a harness process that died.
export type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled' | 'error';

export interface SessionAdapter {
  readonly harness: Harness;
  start(input: StartInput): Promise<SessionHandle>;          // ACP: initialize, then session/new
  resume(id: SessionId): Promise<SessionHandle>;             // ACP: session/resume (sessionCapabilities.resume) or session/load
}

export interface SessionHandle {
  readonly id: SessionId;
  send(message: UserMessage): Promise<void>;                 // ACP: session/prompt
  events(afterSeq?: number): AsyncIterable<SessionEvent>;    // ACP: session/update notifications; section 4
  answer(requestId: string, answer: Answer): Promise<void>;  // ACP: the response to session/request_permission
  interrupt(): Promise<void>;                                // ACP: session/cancel
  stop(): Promise<void>;                                     // ACP: session/close; here: stop and remove the container
  handover(to: { readonly harness: Harness; readonly model: string }): Promise<never>; // milestone 3: rejects with NotImplemented
}

// ACP ToolKind and ToolCallStatus values, used to classify every tool call
// whatever the harness calls the tool.
export type ToolKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other';
export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';
```

| Contract | ACP | Claude Code through the Agent SDK (adapters.md) |
| --- | --- | --- |
| `start` | `initialize`, `session/new` | `query({ prompt: <async iterable>, options })` with `sessionId`, `model`, `cwd`, `settingSources: []`, `canUseTool`, `hooks` |
| `send` | `session/prompt` | push an `SDKUserMessage` into the iterable |
| `events` | `session/update` kinds `agent_message_chunk`, `tool_call`, `tool_call_update`, `plan`, `usage_update` | the `SDKMessage` stream: `system/init`, `assistant`, `user` (tool results), `result` |
| `answer` | response to `session/request_permission` with a `PermissionOptionKind` | the value returned by `canUseTool` (`allow` with `updatedInput`, or `deny` with `message`) |
| `interrupt` | `session/cancel` | `interrupt()` on the `Query` (streaming input only) |
| `resume` | `session/resume` or `session/load` | `resume: <sessionId>` with the config directory on a volume |
| `stop` | `session/close` | `close()` on the `Query`, then the container is removed |
| `handover` | none | none in milestone 1 |
| `ToolKind` | `ToolKind` | `Read` to `read`, `Edit`/`Write`/`MultiEdit`/`NotebookEdit` to `edit`, `Bash` to `execute`, `Glob`/`Grep` to `search`, `WebFetch`/`WebSearch` to `fetch`, `Task` to `other` |

Whether the SDK's `stream_event` partial messages are needed for the session screen is unknown; milestone 1 renders whole content blocks, which the capture `session.png` shows is enough (one line per read, edit and run).

## 4. The AG-UI event subset

Events use AG-UI's wire names as `@ag-ui/core` 1.0.3 declares them in its `EventType` enum (read from the package on 2026-10-21, `PROTOCOL_VERSION` "1.0"). The subset:

| AG-UI event | When Cleared emits it | Payload after cleaning |
| --- | --- | --- |
| `RUN_STARTED` | each user turn begins | `threadId` = session id, `runId` = turn id |
| `RUN_FINISHED` | the turn's `result` arrives | `outcome`, `stopReason` (section 3), usage: input, output and cache tokens, `total_cost_usd` as the SDK reports it |
| `RUN_ERROR` | `result.is_error`, or the runner or container died | `message` (cleaned), `code` |
| `STEP_STARTED`, `STEP_FINISHED` | a measured step of section 1 begins or ends | `stepName` |
| `TEXT_MESSAGE_START`, `TEXT_MESSAGE_CONTENT`, `TEXT_MESSAGE_END` | an assistant text block, or a user message sent from the app | `messageId`, `role` (`assistant` or `user`), `delta` = the whole block (no partial messages in milestone 1) |
| `TOOL_CALL_START`, `TOOL_CALL_ARGS`, `TOOL_CALL_END` | an assistant `tool_use` block | `toolCallId`, `toolCallName`, and in `ARGS` the cleaned input: for a read, the path only; for an edit, the path and the counts of lines added and removed; for a command, the command and its description; plus Cleared's `kind` (section 3) |
| `TOOL_CALL_RESULT` | the matching `tool_result` | for a read: `{ path, bytes }` and never the content; for a command: the output truncated to the limit lane 1 sets and names in its test; for an edit: ok or the error |
| `REASONING_START`, `REASONING_END` | a thinking block begins or ends | the ids only; reasoning content is never emitted or stored |
| `STATE_SNAPSHOT` | session start, and on every reconnect | the session state: status phrase, phase, steps with times, files changed with counts, checks, usage |
| `STATE_DELTA` | the state changes | a JSON Patch, as AG-UI defines |
| `CUSTOM` | Cleared's own items | `name` and `value`, below |

`CUSTOM` names, all prefixed `cleared.`: `permission_request` (requestId, toolCallId, tool, cleaned input, the policy's suggestion), `permission_answered` (requestId, decision, by, rule), `question` (requestId, questions as the harness asks them), `answered` (requestId, by), `review_verdict` (session, verdict, round), `handover_captured`.

Not used: `TEXT_MESSAGE_CHUNK`, `TOOL_CALL_CHUNK`, `MESSAGES_SNAPSHOT` (the app replays from a sequence number instead), `ACTIVITY_*`, `SUBAGENT_*` (a subagent's tool calls appear as the parent's in the SDK stream; whether they carry a `parent_tool_use_id` the app should group on is unknown, lane 4 records it), `RAW` (raw harness messages are never stored).

**Cleaning**, before storage and before the push, by one function with one test suite: the same filter as the guard (`lib/guard/private-terms.mjs` and `lib/guard/codex-guard.mjs`: tokens, keys, environment variables, the service's paths, amounts), the content of a read file never kept, command output truncated. The envelope of every stored event is `{ seq, at, sessionId, ticket, project, event }`; `seq` is per session and is what the app sends back to resume a stream.

**Storage**: table `session_events` in `ledger.db`, opened with `node:sqlite` (what `lib/ledger.mjs` already uses, line 13), owned by the v2 service. **Push**: `GET /api/sessions/:id/events?after=<seq>` on the service, server-sent events; the app forwards it to the browser (section 7).

**Dependency**: none at run time. `@ag-ui/core` 1.0.3 as a dev dependency of `v2/`, used by one test that checks every `type` string of the subset is a member of its `EventType`; the pull request justifies it in one line.

## 5. The policy rules

The harness keeps its own permission mechanism. Cleared answers its requests (`canUseTool`) with a policy per role, evaluated in this order: deny, allow, ask. The container is the first boundary (only the workdir and `/tmp` are writable, nothing of the host is mounted besides the workdir and the read-only token); the policy is the second.

**Compound commands.** Before any rule, the evaluator parses a `Bash` command into one simple command with a small shell-word parser that understands quotes and escapes only. A command that contains `;`, `&&`, `||`, `|`, `$(`, a backtick, a redirection (`>`, `>>`, `<`, `2>`, `&>`), a newline, or anything the parser does not understand, goes to `ask` as rule `shell.compound`, never to `allow`. The deny rules run first on the raw text, so a compound command that names the base branch, a forbidden host or a secret path is denied, not asked. Every safe pattern matches the whole word list of the one simple command, never a prefix of the raw text, with `git`'s global options (`-C`, `-c`, `--git-dir`, `--work-tree`) folded away before matching, so `git -C . push origin main` is `push.base`.

```ts
// v2/src/session/policy.ts (lane 1)
export type Verdict =
  | { readonly decision: 'allow'; readonly rule: string }
  | { readonly decision: 'deny'; readonly rule: string; readonly message: string }
  | { readonly decision: 'ask'; readonly rule: string; readonly reason: string };   // goes to the inbox

export type Policy = {
  readonly role: Role;
  readonly base: string;                      // the project's base branch
  readonly safeCommands: readonly string[];   // glob patterns, from the project's config, with Cleared's defaults
  readonly allowedHosts: readonly string[];   // the egress allow list, same source
  readonly forbiddenHosts: readonly string[]; // production and anything the project names
  readonly ticketFiles: readonly string[];    // what the ticket branch changed so far, refreshed before each evaluation
  readonly learned: readonly { readonly tool: string; readonly pattern: string }[]; // "always in this project" answers
};
```

| Outcome | Rule | What it matches (Claude Code tool names) |
| --- | --- | --- |
| allow | `read.workdir` | `Read`, `Glob`, `Grep` on any path under the workdir |
| allow | `edit.workdir` | `Edit`, `Write`, `MultiEdit`, `NotebookEdit` under the workdir, except `CLAUDE.md` and `.claude/` (generated or locked), and except an edit of `package.json` that changes its `scripts` block, which is `ask` (rule `scripts.change`): otherwise a session could add a script that runs anything and run it under `run.safe` |
| allow | `run.safe` | `Bash` whose one simple command matches `safeCommands`: by default `npm test`, `npm run <a script declared in the package.json of the base branch, read by the service, not by the session's copy>`, `node --test*`, `git status`, `git diff *` and `git log *` only when no word starts with `--output`, `--output-indicator`, `-o` or `--format` with a `%(` or `%x` (a write or a format escape is `ask`), `git add *`, `git commit *`, `git checkout -b *`, `git branch` and `git branch --show-current` only (a `-d`, `-D`, `-m`, `-M` or `-f` word is `ask`), `ls*`, `cat *`, `head *`, `tail *`, `grep *`, `find *` only when no word is `-delete`, `-exec`, `-execdir`, `-ok`, `-okdir` or starts with `-fprint`, `pwd` |
| allow | `learned` | a request matching a `learned` entry for this tool |
| deny | `push.base` | `Bash` whose raw text contains `git push` with the base branch as a word, `git push` with `--force`, `--force-with-lease` or `-f`, `gh pr merge`, or `gh repo`, wherever in the text and whatever the global options |
| deny | `host.docker` | `Bash` with `docker *`, `sudo *` |
| deny | `net.production` | `Bash` or `WebFetch` naming a host in `forbiddenHosts` |
| deny | `secret.read` | any tool whose input names `.env*`, `*.pem`, `*.key`, `id_*`, `.ssh/`, `/run/cleared/`, or the token file |
| deny | `reviewer.edit` | for the `reviewer` role, every edit tool and `git commit`, `git push` |
| ask | `install.package` | `Bash` with `npm install*`, `npm i *`, `npm add *`, `pnpm add *`, `yarn add *`, `pip install*`, `apt-get *`, `apk add *`, `npx <name not in the project's scripts>`; and an edit of `package-lock.json` or `package.json` dependencies |
| ask | `delete.outside_ticket` | `Bash` with `rm -r*`, `git clean*`, `git checkout -- .`, `git reset --hard*`, or a deletion of a file not in `ticketFiles` |
| ask | `net.undeclared` | `Bash` with `curl`, `wget`, `ssh`, `nc`, or `WebFetch`, `WebSearch`, to a host not in `allowedHosts` |
| ask | `default` | anything else the harness asks about |

Answers from the inbox: "Allow once" (`allow_once`), "Always in this project" (`allow_always`, saved in `policy_rules` for the project, never in the project's repository), "Deny" (`reject_once` with the message the human typed or the default). A deploy approval is never a permission: no rule above can let a change go live; only the lock does.

Two facts to keep straight when writing the evaluator, both from [adapters.md](../adapters.md): in Claude Code's `default` permission mode a read never asks and `ls` ran without a request, so `read.workdir` is documentation of what the harness already does, while a `touch` produced a `can_use_tool` request; and `allowedTools` and `disallowedTools` rules such as `Bash(git *)` exist on the harness side. Milestone 1 does not translate the policy into those rules (the owner dropped permission translation); it only answers requests.

## 6. Driving Claude Code: Agent SDK, streaming input

**Choice: `@anthropic-ai/claude-agent-sdk` with `query()` fed by an async iterable**, as [adapters.md](../adapters.md) recommends. The facts that decide it, all from that page:

- The SDK is the only documented, typed interface that gives, in one session, several user turns, in-process permission answers (`canUseTool`), `interrupt()`, `setModel()` and `resume`. Two turns, one `canUseTool` deny and the subscription login were verified on this server with both the bundled binary and `~/.local/bin/claude`.
- The raw `claude -p --input-format stream-json` channel does the same (verified) but its `control_request` envelope is not documented as public; it is the fallback, not the base.
- ACP for Claude Code is `@agentclientprotocol/claude-agent-acp` 0.94.0, a Zed-maintained adapter built on the SDK (0.3.303 at that version). It adds a release cycle and a protocol mapping and gives no driving capability the SDK lacks; whether it exposes resume or an interrupt was not verified. It becomes useful only for a harness that speaks ACP natively, which neither Claude Code nor Codex does today.

**Versions pinned in the session image**: Claude Code CLI `2.1.306` and `@anthropic-ai/claude-agent-sdk` `0.3.306` (which reports `claude_code_version=2.1.306`), Node `24`. The SDK's `pathToClaudeCodeExecutable` points at the image's `claude`. The host updater reinstalled the host binary during the adapters check; the image is immune to that.

**Topology.** The host side of the adapter (`v2/src/session/adapters/claude-code.ts`) starts the container with the runner as its command and keeps the container's stdin and stdout. The runner (`v2/images/session/runner/`, TypeScript run by Node's type stripping inside the image) calls `query()` once per session and forwards: on stdout, every `SDKMessage` as one JSON line, plus a `permission_request` line when `canUseTool` fires and a `question` line for a user-input request; on stdin, `user` lines (an `SDKUserMessage`), `answer` lines (request id and the `Decision`), `interrupt` and `stop`. The runner holds no policy and no cleaning: the host side maps the lines to section 4 events and evaluates section 5. This keeps the in-container code small and rarely changed.

The alternative, the SDK on the host with `pathToClaudeCodeExecutable` set to a wrapper that runs `docker exec -i`, was rejected: it leaves the SDK version on the host and the CLI version in the image to drift apart, and the wrapper has to translate `cwd` and the environment.

**Options the runner sets**, from the SDK reference as adapters.md lists them: `cwd` (the workdir mount point), `model`, `sessionId` (Cleared's UUID) or `resume`, `settingSources: []` (verified to run zero host hooks), `permissionMode: 'default'`, `canUseTool`, `hooks` (the three rules of decision 13), `maxBudgetUsd` from the ticket's budget, partial messages left off, `persistSession: true` with `CLAUDE_CONFIG_DIR` on the session's volume so `resume` works after the container is recreated.

**Login in the container.** A long-lived token from `claude setup-token` (one year, model requests only, per the Claude Code authentication page) is written once by the owner into a service-owned file, mounted read-only at `/run/cleared/claude.token`; the runner reads it into `CLAUDE_CODE_OAUTH_TOKEN` for the child process only, and never prints it. Not tested in a container yet (adapters.md says so); lane 4 does. The open policy question on claude.ai login in third-party products stays open (section 11).

**Two behaviours lane 4 measures with the real CLI**, because they were not verified and the proof depends on them:

1. A message sent during a turn: whether the harness takes it into account before the turn ends, or only at the next turn. If only at the next turn, `send` during a run does `interrupt()` then the message, which still satisfies step 4 of the proof.
2. An allow answer round trip (only a deny was verified) and the `updatedInput` form.

## 7. Runtime layout

| Process | Port | Role |
| --- | --- | --- |
| v2 service, `node v2/src/main.ts` | `127.0.0.1:8791` | sessions, policy, events, tickets, flow, Docker; HTTP and SSE API for the app |
| v2 app, `node v2/app/main.ts` | `127.0.0.1:8792` | password login, screens, forwards `/api/service/*` to the service with the signed-in user's id; holds no key and signs nothing |
| release broker, `serve/release-broker.mjs` | Unix socket | unchanged: the lock, `merge-pr.sh`, the release watch and rollback |
| example deploy watcher, `examples/guestbook/deploy/watch.ts` | `127.0.0.1:8793` (the app it runs) | stands in for a deployment system: redeploys the example's base branch when it moves |

Docker objects per session, all labelled `cleared.dev=v2` and `cleared.session=<id>`: one internal network `cleared-v2-<id>`, one session container, one egress container, the declared test services (the example declares `postgres:16`), one named volume for the harness config directory. `stop` removes the network and the containers; the volume lives until the ticket is done, so `resume` works. A test proves that after `stop` nothing with the session label remains, and `docker ps -a --filter label=cleared.dev=v2` is the only way any Cleared code lists containers. On 2026-10-21 no object with that label existed on the host.

The app and the service talk over loopback with a shared secret file (service owned, mode 0600, read by both processes, which run under the same account), the way the broker already keeps a secret in the state directory. The service accepts a user id only on a request that carries that secret, and signs an approval (decision 6) only for such a request; the approval key is read by the service alone. Browser writes need the session cookie (`HttpOnly`, `Secure`, `SameSite=Strict`, 30 days, persisted in SQLite so a restart does not sign everyone out), an anti-forgery header and a same-origin check, as the v1 app does (`docs/app.md`). Passwords are hashed with `crypto.argon2` from `node:crypto`, present in Node v24.21.0 on this host (`typeof crypto.argon2 === 'function'`, checked on 2026-10-21), so no dependency is needed; the lane cites the Argon2id parameters it picks and their source.

## 8. The lanes

Branch names follow the decision of 2026-10-21: `v2-j1-<topic>`, from `v2`, pull request to `v2`. Author models: Opus 5.5 for the core, Haiku 5.5 for small fixes; the reviewer is always Sonnet 5.5 in a fresh session, two rounds. Fix lanes opened after a review (`review-followup` issues) are Haiku lanes named `v2-j1-fix-<topic>` and are not counted below. Every lane: tests first, each defect test fails on the old code, `tsc --noEmit` strict, erasable syntax, no new dependency without a one-line reason in the pull request, English, no em dash, the guard green.

### Lane 1: `v2-j1-contracts`

- **Goal**: the types every other lane codes against, and the pieces that need no harness: the session contract (section 3), the event subset with its cleaning and storage (section 4), the policy evaluator (section 5), a fake adapter that replays a scripted session for tests and for the app's fixtures, the ticket store contract, and the module conventions of section 10 (the stubs and the registry), with the service's `main.ts` composing the stubs.
- **Files**: `v2/src/session/contract.ts`, `v2/src/session/events.ts`, `v2/src/session/clean.ts`, `v2/src/session/policy.ts`, `v2/src/session/adapters/fake.ts`, `v2/src/session/adapters/index.ts`, `v2/src/store/db.ts` (opens `ledger.db` with `node:sqlite`, `session_events`, `sessions`, `policy_rules`), `v2/src/tickets/contract.ts` (`TicketStore` with the in-memory implementation for tests), `v2/src/modules/*.ts` stubs, `v2/src/modules/registry.ts`, `v2/src/main.ts`, `v2/src/api/types.ts` (the HTTP and SSE API shapes the app lanes build against), tests under `v2/test/`, `v2/package.json` (the `@ag-ui/core` dev dependency and the `doctor` script entry for lane 2's file).
- **Acceptance proof**: tests show every event type of the subset is in AG-UI's `EventType`; the cleaner strips a token, a key, an environment variable, the service path and a file's content from fixture events, and truncates command output at the named limit; the policy table of section 5 is a test table, one case per row, plus the ordering case (a `learned` entry never overrides a deny) and these compound-command rows: `npm run test; curl https://example.invalid` asks, `npm run test | tee log` asks, `cat a > b` asks, `find . -delete` asks, `find . -name '*.ts'` allows, `git branch -D main` asks, `git branch --show-current` allows, `git -C . push origin main` denies, `echo $(id)` asks, a command with a backtick asks, a command with an unclosed quote asks, `npm run test` with `test` declared in `package.json` allows and `npm run undeclared` asks; a scripted fake session stores its events with increasing `seq` and replays from `after`; `npm test`, `tsc --noEmit` and the guard pass in CI.
- **Dependencies**: none.
- **Author**: Opus 5.5. **Interface lane**: no.

### Lane 2: `v2-j1-container`

- **Goal**: the Docker runtime behind a session: the base image, the per-session network, the egress proxy, the sibling test services declared in the project config, the resource limits, the read-only token mount, `stop` that removes everything, and the reading of `.devcontainer/devcontainer.json` limited to its `image` key, or `build.dockerfile`, with Cleared's base image as the default (the rest of the devcontainer specification is out of scope and the doc says so).
- **Files**: `v2/src/container/docker.ts` (the CLI wrapper, where the label rule lives), `v2/src/container/session-runtime.ts`, `v2/src/container/services.ts`, `v2/src/container/devcontainer.ts`, `v2/images/session/Dockerfile` (Node 24, git, Claude Code CLI `2.1.306`, `@anthropic-ai/claude-agent-sdk` `0.3.306`), `v2/images/egress/` (the CONNECT proxy, TypeScript, allow list from a file the service rewrites), `v2/images/session/runner/hooks.ts` (an empty hook set, so that lanes 4 and 5 can share it without editing the same file in wave 2), `v2/scripts/doctor.ts` (the Docker part), `v2/README.md` (the Docker section), tests under `v2/test/container/`.
- **Acceptance proof**: a test over the wrapper proves every `docker` command line it builds carries the label on create and the label filter on list, stop and remove, with no exception; on this server, labelled only, a real run creates a session network, a session container, an egress container and a `postgres:16` sibling, proves from inside the session container that the Postgres service answers, that `api.anthropic.com:443` is reachable through the proxy, that a host not in the allow list is refused, that `127.0.0.1:8791` of the host and the host's Tailscale address are unreachable, that the token file is readable and not writable, that `docker` is absent; then `stop` leaves nothing with the session label (`docker ps -a` and `docker network ls` with the label filter, both empty), and the memory and CPU limits appear in `docker inspect`. The pull request pastes the raw lines of that run. `ss -ltn` before and after shows no new listening port on the host.
- **Dependencies**: none (it does not need lane 1).
- **Author**: Opus 5.5. **Interface lane**: no.
- **Unknowns it closes**: whether name resolution works on an `--internal` network (if not, the proxy resolves names, since CONNECT carries the host name); whether npm and Claude Code honour `HTTPS_PROXY` (expected from their documentation, verified by the run); which hosts Claude Code needs besides `api.anthropic.com` (the proxy logs refused CONNECTs; the lane extends the default list from evidence and sets the documented variable that disables non-essential traffic if it exists at that version).

### Lane 3: `v2-j1-example-app`

- **Goal**: the demo project under `examples/guestbook/`: a Node web app with no framework (`node:http`) that lists and adds guestbook entries in Postgres (the `pg` package, its only dependency, justified), `/health` that answers 200 when the database answers, tests with `node --test` against `DATABASE_URL`, a `.devcontainer/devcontainer.json` naming Cleared's base image, a `.github/workflows/checks.yml` with a Postgres service container, a `.cleared/agents.conf` (local tracker, the six states, `[release] health_url = http://127.0.0.1:8793/health`, `watch_minutes` short enough for a demo, `auto_rollback = true`, `[merge] verdict`, `tooling_paths`, `guarded_paths`, the `[session]` image, services, safe commands and hosts the v2 service reads), a README that says what the demo ticket will change, and `deploy/watch.ts`: a watcher that polls the example repository's base branch, rebuilds the example image (labelled `cleared.dev=v2`) and restarts the example container on `127.0.0.1:8793` when the head moves, so that a merge goes live and a revert rolls back.
- **Files**: everything under `examples/guestbook/` only.
- **Acceptance proof**: `npm test` passes locally against a labelled `postgres:16` container (the run of the example's own CI workflow belongs to the milestone proof, once the repository of question 1 exists); `deploy/watch.ts` has a test with a fake git head and a fake docker command, and that test asserts that every `docker` command line the watcher builds carries `--label cleared.dev=v2` on build and run and `--filter label=cleared.dev=v2` on list, stop and remove, with no exception, as lane 2's wrapper test does; the README's demo ticket ("the guestbook shows the newest entry first", or another one-file change with a test) is written as the owner will create it in the app.
- **Dependencies**: none. The real repository (section 11) is needed only for the milestone proof.
- **Author**: Opus 5.5. The lane builds a whole app with a watcher, a devcontainer and a workflow, which is more than the small fix the model rule reserves Haiku for; the brief still gives the routes, the table, the scripts and the config keys, so nothing is designed.
- **Interface lane**: no (the guestbook page has no reference capture and no design rule beyond being readable).

### Lane 4: `v2-j1-claude-adapter`

- **Goal**: the Claude Code adapter of section 6: the runner in the image and the host side that implements `SessionAdapter` for `claude-code`, including `resume` after the container is recreated, `interrupt`, the mapping of `SDKMessage` to the event subset, `canUseTool` to the policy and to a pending request the inbox answers, user-input requests to `question` events, and the doctor run.
- **Files**: `v2/src/session/adapters/claude-code.ts`, `v2/src/session/adapters/claude-code/map.ts`, `v2/images/session/runner/main.ts` (which imports lane 2's `hooks.ts` and spreads its export into the SDK `hooks` option, without editing that file), the `COPY` of the runner in `v2/images/session/Dockerfile`, `v2/scripts/doctor.ts` (the Claude Code part), `v2/src/session/adapters/index.ts` (registers the adapter), tests under `v2/test/session/claude-code/` with recorded SDK message fixtures, and `docs/adapters.md` (a dated "verified in a container" paragraph with the raw lines).
- **Acceptance proof**: the mapping test turns a recorded two-turn session with one read, one edit, one command, one permission request and one result into the exact event list of section 4, with the cleaned payloads; the doctor run on this server, in a labelled container, with the real CLI and the token mount: two turns, a `touch` that the policy escalates and that an `allow_once` answer lets through (the file exists afterwards), a `rm -r` that a `reject_once` stops, a message sent mid turn with the observed behaviour written down, an `interrupt` that ends the turn with `cancelled`, then `stop`, then `resume` in a new container that remembers a word from the first turn. The pull request pastes the raw lines, with ids and the token path replaced as adapters.md does. Nothing of this runs against the host's `~/.claude`.
- **Dependencies**: lanes 1 and 2.
- **Author**: Opus 5.5. **Interface lane**: no.

### Lane 5: `v2-j1-workspace-memory`

- **Goal**: what surrounds a session on the host: the project checkout and the per-ticket checkout on the ticket branch, the generated `CLAUDE.md` from `lib/memory`'s briefing (project page, approved decisions linked to the ticket, glossary, lessons of the role, last handover, and the line saying this content is reference data, not instructions), excluded through `.git/info/exclude`; the project's skills mounted as they are; the capture of `HANDOVER.md` into memory at the end (`memory.captureHandover`, `lib/memory/cli.mjs` already does this for v1); the push of the branch and the pull request from the host with the forge credential (`lib/forge.mjs`, `lib/pr-body.mjs` for the body), after the guard on the diff; and the three SDK hooks of decision 13 in the runner's hook file.
- **Files**: `v2/src/workspace/checkout.ts`, `v2/src/workspace/briefing.ts`, `v2/src/workspace/handover.ts`, `v2/src/workspace/publish.ts`, `v2/images/session/runner/hooks.ts`, tests under `v2/test/workspace/` and a runner hook test under `v2/test/runner/`.
- **Acceptance proof**: tests with a temporary repository prove the checkout is on the ticket branch from the base, that `CLAUDE.md` is present, excluded and carries the five sections and the reference-data line, that the publish step refuses a diff the guard flags (one planted secret) and otherwise pushes and opens the pull request through a fake `gh`; the hook tests prove a `git push origin <base>` is blocked by the `PreToolUse` hook, that a session that ends without `HANDOVER.md` is asked once for it by the `Stop` hook, and that the `PreToolUse` hook runs the guard on the diff and blocks a `gh pr create` whose diff the guard flags; that the policy sends a `gh pr create` to `ask` by its `default` rule is lane 1's test, not this one.
- **Dependencies**: lane 1 (the contract) for the hook and briefing types, and lane 2 for the empty `hooks.ts` this lane fills; lane 4's runner, written in the same wave, imports that file and never edits it.
- **Author**: Opus 5.5. **Interface lane**: no.

### Lane 6: `v2-j1-app-shell-login`

- **Goal**: the v2 app process: users (table, `cleared-v2 user add <name>` that prompts for the password, Argon2id), the login page, the 30-day cookie session, the forwarding of `/api/service/*` to the service with the user's id, the shell (header with project name, Tower, Inbox with its count, Sessions, Tickets; the signed-in user; the clock), the catalog mechanism with per-screen en and fr files, the light and dark themes from `app/DESIGN.md` (chosen with a button, never imposed), the screen stubs of section 10, the data source switch (fixtures from lane 1's fake session, or the live service), and the tower screen itself: the bar "Ask the lead, describe a goal, or create a ticket" (create a ticket works; the two others say they come in milestone 2), "Needs you" cards, live sessions with their current phrase, the lead card in its milestone 1 state, plans, landed today with durations.
- **Files**: `v2/app/` (new: `main.ts`, `src/server.ts`, `src/users.ts`, `src/session-cookie.ts`, `src/proxy.ts`, `src/catalog.ts`, `public/` with the shell, `public/style.css` carried over from `app/public/style.css` with the tokens of `app/DESIGN.md`, the Geist fonts copied into `public/fonts/`, `public/screens/tower.ts`, and the `public/screens/session.ts` and `public/screens/inbox.ts` stubs that lanes 9 and 10 fill, `messages/shell.{en,fr}.json`, `messages/tower.{en,fr}.json`, `fixtures/`), `v2/src/modules/users.ts` (the users table lives in the service's store so approvals and messages reference it), `v2/src/cli/user.ts` (the `cleared-v2 user add <name>` command), `v2/README.md` (the app section), `v2/package.json` scripts.
- **Acceptance proof**: tests prove a wrong password is throttled and refused, a right one sets the cookie with the three flags and the 30-day age, a write without the anti-forgery header is refused, a session survives a restart, a forwarded request carries the user id and nothing else of the cookie; every string on the tower comes from the catalog and the fr file has every key of the en file (a test); the visual loop on `tower.png` with the same data as the capture, at 1440 and 1280 then 768 and 390, light then dark, with the art-director pass; no gradient (a test greps the stylesheet for `gradient`).
- **Dependencies**: lane 1 (API types and fixtures).
- **Author**: Opus 5.5. **Interface lane**: yes, against `/tmp/cleared-brief/captures/tower.png`; the login page has no reference capture and follows `app/DESIGN.md` only, still with the art-director pass.

### Lane 7: `v2-j1-flow`

- **Goal**: the ticket's path, in the service: Todo starts the workspace and the author session; the author's end starts the review session (role `reviewer`, Sonnet 5.5, in its own container on the same branch, read-only policy, `prompts/review.md` adapted as its prompt); the verdict is recorded through the review record contract (lane 8 implements the ledger-compatible writer; this lane uses the contract); a requested change reopens the author session with the request; a pass publishes the branch (lane 5) and asks for the approval through the lock's `--ask` request (`release-request.mjs request_release <ticket> <pr> --ask`); the inbox items (permission, question, release) with their state; the measured steps; the service HTTP and SSE API of lane 1's types (sessions, events, send, answer, interrupt, tickets, inbox); the 15-minute idle stop; the per-ticket budget stop.
- **Files**: `v2/src/flow/`, `v2/src/inbox/`, `v2/src/api/` (the handlers; the types are lane 1's), `v2/src/modules/sessions.ts`, `v2/src/modules/flow.ts`, `v2/src/modules/inbox.ts`, tests under `v2/test/flow/` driven by the fake adapter.
- **Acceptance proof**: a test runs a whole ticket on the fake adapter: Todo, workspace, author with one permission escalated and answered, one user message, author done, review with a verdict, publish, request, approval recorded through the contract's fake, and asserts the step events and the inbox items at each stage; a test proves an idle session is stopped at 15 minutes and that a session over its budget is stopped and its ticket put back with a note; the API tests cover every route with a signed and an unsigned request.
- **Dependencies**: lanes 1, 4, 5.
- **Author**: Opus 5.5. **Interface lane**: no.

### Lane 8: `v2-j1-approval-lock`

- **Goal**: the human's approval, signed by the service, and the lock run unchanged on the example: the TypeScript ticket store on the local tracker's tables (decision 11), the service's approval route (`POST /api/tickets/:id/approve`, accepted only with the shared secret and a user id, as decision 6 and section 7 say), the signer (the human's move to the go state, signed with the service's Ed25519 key the way `app/human-write.mjs` and `app/lib/human-tracker.mjs` sign in v1, bound to the request time and the shown heads through `approval_context`), the 60-second grace with Undo held by the service before the write, the `app_gesture` ledger event with the user id, the request to the broker after the write, the review record writer that `merge-pr.sh` reads (a `runs` row with `role = 'review'`, `source = 'dispatcher'`, `outcome = 'done'`, `pr_number` and `ticket`, line 141, and a report file in the format `lib/reviews.mjs` `readReport` parses, lines 17 to 26, whose body concludes with the `[merge] verdict` phrase), the setup command that generates the key pair and prints the public key to commit in the project's config, and the three identity points settled for v2: `tracker.sh identity` must answer `app` for the service's own writes (`lib/tracker/cli.mjs` line 15, which depends on the service's actor being `agents`), `moved-by-owner` must see the app's write as the human (`lib/tracker/adapters/local.mjs` lines 97 to 105), and the broker must accept the app's request from the service UID (`serve/release-broker.mjs` lines 98 and 116, decision 7).
- **Files**: `v2/src/tickets/local-store.ts`, `v2/src/approval/` (route, signer, grace period, key loading), `v2/src/modules/tickets.ts`, `v2/src/modules/approval.ts`, `v2/src/cli/setup.ts` (key pair generation), `v2/package.json` (the setup command's script entry, the one edit of that file in wave 3), tests under `v2/test/approval/`; nothing under `v2/app/`, which the inbox screen (lane 10) calls through lane 6's forwarding; `lib/tracker/adapters/local.mjs` only if the v2 actor cannot be set through configuration (the lane says which, with the line); `serve/release-broker.mjs` and `merge-pr.sh` are not edited in this lane: if a change there is unavoidable, it is a one-line diff with its reason, reviewed as a security change.
- **Acceptance proof**: tests prove that a move the service signs for a request carrying the shared secret and a user id verifies as `human` with the public key, and that the same move without the key, or with another request time, or with other heads, verifies as `other`; that a request without the secret, or without a user id, is refused before anything is signed, which is what a session (any process without the secret and the key) can at most send; that `review-pr.sh`'s successor record makes `merge-pr.sh --dry-run` pass check 3 on a temporary repository with a fake `gh`; and on this server, with the broker running for the example project, `merge-pr.sh --dry-run` on a real pull request of the example repository reaches "would merge" after the app's approval, and refuses after a new commit on the branch (check 4's version rule). The raw outcome lines are in the pull request.
- **Dependencies**: lanes 1 and 6 (the users table and the forwarding channel with the shared secret).
- **Author**: Opus 5.5. **Interface lane**: no.

### Lane 9: `v2-j1-session-screen`

- **Goal**: the session screen of `session.png`: the ticket card with its criteria and their state, the plan of the session, the live timeline (read, edit with counts, run with its result, the human's messages, the assistant's questions, a permission request inline with its three buttons), the status line ("Paused, waiting for you", the elapsed time and the share of the week from `lib/limits.mjs` when it can be read, else the tokens), the message field with Send, Interrupt, and "Hand over to Codex" disabled with its milestone 3 note, the Changes card, the Checks card with the measured steps, the "Screen so far" card (a capture of the example app from the session's container when one exists, else the empty state), and the author and reviewer tabs that switch between the two sessions of a ticket.
- **Files**: `v2/app/public/screens/session.ts`, `v2/app/public/screens/session.css` if the shell's stylesheet is not enough, `v2/app/messages/session.{en,fr}.json`, `v2/app/fixtures/session.ts`, tests under `v2/app/test/session/`.
- **Acceptance proof**: a rendering test feeds the fixture session (the same data as the capture) and asserts the timeline rows, the counts and the three buttons; a reconnect test replays from `after` without duplicates; the visual loop on `session.png` at the four widths, light and dark, with the art-director pass; every string from the catalog, fr complete.
- **Dependencies**: lane 6 (the shell), lane 1 (API types and fixtures). It runs against fixtures during the wave and against the live service once lane 7 lands.
- **Author**: Opus 5.5. **Interface lane**: yes, against `/tmp/cleared-brief/captures/session.png`.

### Lane 10: `v2-j1-inbox-screen`

- **Goal**: the inbox of `inbox.png`: the list of what waits (release, permission, question; plans say milestone 2) with the elapsed time, "Handled today", and the detail pane: for a release, the title, the announcement, the before and after captures with the Desktop and Phone switch, the sessions line with the measured durations, the change line with the pull request link and the checks, "Send back" and "Approve the release" with the 60-second Undo; for a permission, the command, the reason, "Allow once", "Always in this project", "Deny"; for a question, the question with its options and a free answer. Every gesture goes through lane 6's forwarding to the service: the approval route of lane 8 or the answer route of lane 7, with the signed-in user.
- **Files**: `v2/app/public/screens/inbox.ts`, `v2/app/public/screens/inbox.css` if needed, `v2/app/messages/inbox.{en,fr}.json`, `v2/app/fixtures/inbox.ts`, tests under `v2/app/test/inbox/`.
- **Acceptance proof**: rendering tests on the fixture inbox (the capture's data); a test that an approval click starts the grace period, that Undo within it writes nothing, and that after it the service's approval route is called with the shown versions; the visual loop on `inbox.png` at the four widths, light and dark, with the art-director pass; every string from the catalog, fr complete.
- **Dependencies**: lanes 6, 7, 8.
- **Author**: Opus 5.5. **Interface lane**: yes, against `/tmp/cleared-brief/captures/inbox.png`.

## 9. Waves

At most three lanes run at once, and lanes in one wave never edit the same file.

| Wave | Lanes | Files each one owns in the wave | Needs before it starts |
| --- | --- | --- | --- |
| 1 | 1 contracts, 2 container, 3 example-app | `v2/src/{session,store,tickets,modules,api,main.ts}`; `v2/src/container/`, `v2/images/`, `v2/scripts/doctor.ts`; `examples/guestbook/` | nothing |
| 2 | 4 claude-adapter, 5 workspace-memory, 6 app-shell-login | `v2/src/session/adapters/claude-code*`, `v2/images/session/runner/main.ts`, `Dockerfile`, `doctor.ts`, `docs/adapters.md`; `v2/src/workspace/`, `runner/hooks.ts`; `v2/app/`, `v2/src/modules/users.ts`, `v2/src/cli/user.ts` | wave 1 merged into `v2`, and the owner's `claude setup-token` token written into the service-owned token file (lane 4's real run needs it; question 2 covers the choice behind it) |
| 3 | 7 flow, 8 approval-lock, 9 session-screen | `v2/src/{flow,inbox,api handlers}`, `modules/{sessions,flow,inbox}.ts`; `v2/src/{tickets/local-store.ts,approval,cli}`, `modules/{tickets,approval}.ts`; `v2/app/public/screens/session.*`, its messages and fixture | wave 2 merged, and the example repository on GitHub (section 11) for lane 8's real proof |
| 4 | 10 inbox-screen | `v2/app/public/screens/inbox.*`, its messages and fixture | wave 3 merged |

A wave starts when the whole previous wave is merged, as the table says; a slot freed early (lane 3 is the shortest of wave 1) stays empty until then. The milestone proof (section 1) runs after wave 4, by the orchestrator, on the example repository, with Haiku fix lanes for what it finds; then, after the owner's go, on one GetSeetu ticket.

Files that two lanes touch are only touched across waves: `v2/images/session/Dockerfile` and `v2/scripts/doctor.ts` (lane 2, then lane 4), `v2/images/session/runner/hooks.ts` (lane 2's empty set, then lane 5), the module stubs and `adapters/index.ts` (lane 1, then one later lane each). `v2/package.json` is edited by one lane per wave: lane 1 (the `doctor` script entry and the `@ag-ui/core` dev dependency), lane 6 (the app scripts), lane 8 (the setup command); the other lanes of a wave add no script and no dependency.

## 10. Conventions that keep lanes apart

- **Module stubs and the registry.** Lane 1 creates `v2/src/modules/{sessions,users,tickets,flow,approval,inbox}.ts`, each exporting `{ tables: string[], routes: Route[], provide: Partial<Registry> }` with empty values, and `v2/src/modules/registry.ts` with the typed slots (`sessionAdapters`, `ticketStore`, `reviewRecorder`, `approvalWriter`, `users`), each with an in-memory default. `v2/src/main.ts` imports the six stubs and assembles the registry. A later lane fills its own stub and never edits `main.ts` or another stub. A module owns its tables (`CREATE TABLE IF NOT EXISTS` in its own file) so there is no shared migration list.
- **Screens and catalogs.** Lane 6 creates the three screen stubs and the per-screen message files; a screen lane edits only its screen file, its messages, its fixture and its tests. The catalog test (fr has every en key) runs over every file so a screen cannot ship half translated.
- **API types first.** Lane 1's `v2/src/api/types.ts` is the contract between the service (lane 7) and the app (lanes 6, 9, 10); a change to it after wave 1 is its own small lane, not a side edit.
- **One doctor.** `v2/scripts/doctor.ts` grows a section per lane that needs a real run on the server (Docker in lane 2, Claude Code in lane 4); it is what `cleared doctor` will run in milestone 5.
- **Real runs are labelled and quoted.** Any lane that runs Docker or a harness on this server uses the `cleared.dev=v2` label, binds nothing outside `127.0.0.1`, checks `ss -ltn` first, never touches `~/.claude` of the host, and pastes the raw proof lines in its pull request with ids and paths replaced.

## 11. Questions for the owner

Grouped as the brief asks, with a recommendation. The orchestrator sends them in its next report; everything else proceeds.

1. **A GitHub repository for the example.** The lock reads the pull request through `gh pr view` (`merge-pr.sh` line 101) and merges on GitHub, so the demo project needs a repository with pull requests. Options: (a) create a new repository, seeded from `examples/guestbook/` and kept in sync by hand, recommended; the name `cleared-example-guestbook`, the organisation (the one this repository lives in) and the visibility (public, like this repository) are proposals for the owner to confirm or change; (b) a repository under the GitHub account `gh` is signed in with on this server, which keeps the organisation clean but leaves the demo outside it; (c) run the demo pull requests inside the `cleared` repository itself, not recommended, since the lock would merge demo changes into `v2`. Needed before lane 8's real proof (wave 3). No default: creating a repository is outward facing.
2. **Login of the sessions.** adapters.md quotes the SDK overview: Anthropic does not allow third-party developers to offer claude.ai login for their products unless approved, and whether a self-hosted tool where the owner signs in to their own subscription is covered is unknown. Options: (a) the subscription, through a `claude setup-token` token held by the service, recommended, as v1 ran on the subscription; (b) an API key, which changes the cost model to per-token billing. Default if no answer by wave 2: (a), and the report says so.
3. **The watch window for the example.** The default `watch_minutes` is 15. For a demo that shows a rollback, a shorter window and `auto_rollback = true` are proposed in the example's config. Default: 3 minutes, `auto_rollback = true`, `failures_to_rollback = 2`; the lane sets it unless told otherwise.

## 12. Out of scope for milestone 1

The project lead session and the goal mode, the plans screen and `lead-and-plan.png`, web notifications, Codex and the handover (the button is present and disabled), "Open in terminal" and "Give back to Cleared", Linear and GitHub Issues mirrors, the installer and `cleared doctor` as a product command (the doctor script exists for the lanes), the removal of v1 files, the conversion of kept JavaScript that no lane touches, partial message streaming, the full devcontainer specification, the fast lane in the demo, and the GetSeetu run before the owner's go.

## 13. Unknowns, and who closes them

| Unknown on 2026-10-21 | Closed by |
| --- | --- |
| Name resolution and proxy variables on an internal network; the hosts Claude Code needs | lane 2 |
| Login with `CLAUDE_CODE_OAUTH_TOKEN` inside a container; an allow round trip; `interrupt`; `resume` after the container is recreated | lane 4 |
| Whether a message sent mid turn is taken into account before the turn ends | lane 4 |
| Whether subagent tool calls carry a parent id the app should group on | lane 4 |
| The mechanism of a user-input request (question) in the SDK and its answer shape | lane 4 |
| Which configuration makes the local tracker see the v2 service as `agents` without editing `local.mjs` | lane 8 |
| Whether `lib/limits.mjs` can give the share of the week for a container session | lane 9 |
| The policy of claude.ai login in a self-hosted tool | the owner, question 2 |
