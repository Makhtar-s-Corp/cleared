# Cleared v2: decisions log

Each entry has a date, the decision as it was taken, and its consequences for this repository. Path-level verdicts are in [keep-and-drop.md](keep-and-drop.md). Counts were taken on the `v2` branch at commit `bd496f1`.

## 2026-10-21: what Cleared v2 is

**Decision.** Cleared v2 is a harness for many parallel coding sessions. Claude Code and Codex sessions run in parallel, each in its own Docker container. A project lead session coordinates them. v2 also has memory, review by a model other than the author's, and human approval before any deploy, through the existing lock service (the release broker, `serve/release-broker.mjs`).

**Consequences.**
- Sessions are long-lived and run in containers. v1 lanes are one-shot CLI runs in host worktrees, opened by bash (`spawn-lane.sh`, `lane-run.sh`, `flow-lanes.sh`). The lane model is replaced, not ported.
- The release broker and its client `release-request.mjs` stay. So do the checks the broker runs before a merge, today in `merge-pr.sh`.
- Cross-model review stays. `review-pr.sh` (bash) has to exist in Node before milestone 4.
- The project lead becomes a session. The prompts of the v1 lead wake (`prompts/release.md`, `prompts/release-live.md`, `prompts/handover.md`, `prompts/talk.md`) are adapted.

## 2026-10-21: Node for the whole core, no bash

**Decision.** The whole core is written in Node. No bash script remains.

**Consequences.**
- The repository tracks 39 `.sh` files (`git ls-files '*.sh' | wc -l`). All 39 are removed in milestone 4.
- Some of them carry behavior v2 keeps, so that behavior has to exist in Node before the file goes:
  - `merge-pr.sh`: the guarded merge
  - `ask-validation.sh`: the approval request
  - `review-pr.sh`: cross-model review
  - `wake.sh`: the wake
  - `lib/ports.sh`: the port rules
  - `serve/install.sh`: the installer
  - `tracker.sh`, `lib/tracker/adapters/dispatch.sh`, `lib/tracker/adapters/linear.sh`, `lib/tracker/adapters/env.sh`, `lib/tracker/guard.sh`: tracker access
  - the `guard_text` function of `lib/common.sh`
- `.github/workflows/checks.yml` runs `bash -n` on every shell file. That step goes.
- `CONTRIBUTING.md` lists bash and jq as requirements for the local suite. That list changes.
- The jq files under `prompts/` are run by `wake.sh`. Their content moves with the wake.
- 27 of the 36 files under `test/` name a `.sh` file (`grep -lE '[A-Za-z0-9_-]+\.sh' $(git ls-files test) | wc -l`). Tests of kept areas keep their cases and change their harness. Tests of dropped areas go.

## 2026-10-21: app login by password, no passkeys

**Decision.** The app signs the human in with a password. Passkeys are dropped.

**Consequences.**
- These files go: `app/lib/webauthn.mjs`, `app/lib/grant-socket.mjs`, `app/public/register.html`, `app/public/register.js` and `test/app-authenticator.mjs`.
- `cleared app passkey` (`app/main.mjs`) goes.
- Some files lose their passkey parts: `app/lib/actions.mjs`, `app/lib/notifications.mjs`, `app/lib/credentials.mjs`, `app/public/actions.js`, `app/public/notify.js` and `app/screenshots-actions.mjs`.
- Open: today a passkey confirms "Clear to land", "Send back" and turning notifications on, each time. What confirms these gestures with a password login is not decided.

## 2026-10-21: Claude Code first, then Codex

**Decision.** v2 supports Claude Code sessions first. Codex sessions follow.

**Consequences.**
- v1 requires the reviewer to be a different model from the one that wrote the change (README, Principles).
- Until Codex sessions exist, another Claude model reviews: see "model choice per lane" below.
- `lib/route.mjs`, which picks a model per role with fallbacks, is proposed for keep.

## 2026-10-21: what v2 keeps

**Decision.** v2 keeps:
- the tracker contract and adapters (`lib/tracker`), with the local adapter becoming the ticket store
- memory (`lib/memory`)
- the deploy lock service
- automatic and manual rollback
- the post deploy health watch
- the heartbeat and `cleared status`
- the fast lane rules on the real diff
- web notifications
- the private terms and secrets guard
- the SQLite ledger
- the app: the Node server, the snapshot, `app/DESIGN.md` and the en and fr catalog

**Consequences.**
- These paths stay:
  - `lib/tracker/`, `lib/memory/`, `lib/ledger.mjs`, `lib/release.mjs`, `lib/heartbeat.mjs`, `lib/fast-lane.mjs`
  - `lib/guard/`, `lib/notify.mjs`, `lib/notify/`, `lib/i18n.mjs`, `lib/i18n/`
  - `lib/board-collector.mjs`, `lib/board-report.mjs`, `lib/board-scrub.mjs`
  - `serve/release-broker.mjs`, `release-request.mjs`, `cleared` and `app/`
- The local adapter stores tickets, comments and history in `ledger.db` today. Its approval proof needs two system accounts and an Ed25519 key held by the human (docs/trackers.md).
- Open: the three system accounts mode is dropped, so what proves a human approval in the local store is not decided.
- Web notifications are kept. The `ntfy`, `telegram` and `email` adapters in `lib/notify/adapters/` are not named. Open.

## 2026-10-21: what v2 drops

**Decision.** v2 drops:
- the bash lanes
- the one-shot harness adapters (`claude -p`, `codex exec`)
- the terminal adapters (Orca, none)
- the permission translation per CLI
- the three system accounts default mode
- sudo
- bubblewrap
- the heavy operations lock
- passkeys
- the special Codex container mode
- every remaining bash script of the core

**Consequences.**
- Removed in milestone 4:
  - `adapters/` and `lib/contract.sh`
  - `lib/terminal/`
  - the lane scripts (`spawn-lane.sh`, `lane-run.sh`, `flow-lanes.sh`, `kill-lane.sh`, `tidy-lanes.sh`, `adopt-lane.sh`, `tell-lane.sh`, `push-lane.sh`)
  - `when-free.sh`, `host-state.sh` and `lib/screens.mjs`
  - `lead-command.mjs`, `serve/lead-actions.mjs` and `serve/check-harness.sh`
- `[permissions.*]`, `[terminal]`, `[adapter.claude]` and `[adapter.codex]` go from `agents.example.conf` and `docs/configuration.md`.
- `docs/security.md` loses its sections on the agents' account, bubblewrap, sudo and the heavy-command door.
- Some files only serve dropped parts but are not named in the decision. The static dashboard (`dashboard.sh`, `lib/dashboard.mjs`, its three units) and the decision flow of `talk.sh` (`decide.sh`, `confirm-decision.sh`) are examples. They are marked `proposed` in keep-and-drop.md and still need a decision.

## 2026-10-21: removals happen in milestone 4

**Decision.** Most removals happen in milestone 4.

**Consequences.**
- No milestone plan exists in the repository. Every removal in keep-and-drop.md is placed in M4 until one does.
- Until milestone 4, v1 files stay in the tree next to the v2 code.

## 2026-10-21: v1 is stopped without an archive

**Decision.** The owner decided not to archive the v1 state when stopping it, because it is not needed. The v1 services and timers are disabled.

**Consequences.**
- No copy of the v1 runtime state (ledger, lanes, worktrees, snapshot) is made before it stops. v2 starts from the repository, not from a v1 archive.
- The orchestrator reported on 2026-10-21 that the v1 stop was executed and verified, including the disabled services and timers. This change does not verify it.
- The units `serve/` installs are still tracked: `cleared-wake.timer`, `cleared-dashboard-refresh.timer`, `cleared-legacy-import.timer` and their services. Their verdicts are in keep-and-drop.md.

## 2026-10-21: lane branches are named v2-jN-topic

**Decision.** A v2 lane's branch is named `v2-jN-topic`, where N is the milestone number, for example `v2-j0-keep-and-drop`. Its pull request targets the `v2` branch.

**Consequences.**
- The name `v2/jN-topic` is not possible. Git stores branches as paths under `refs/heads/`, so `refs/heads/v2/...` cannot exist next to `refs/heads/v2`. Locally, `git branch -m v2/j0-keep-and-drop` fails with "'refs/heads/v2' exists; cannot create 'refs/heads/v2/j0-keep-and-drop'". The remote has a `v2` branch too.
- The `v2` branch keeps its name.

## 2026-10-21: model choice per lane

**Decision.**
- The model may vary from lane to lane: Haiku for small fixes and simple docs, Opus for the core, Sonnet for review.
- The reviewer is always a different model from the author.
- Fable is allowed only when strong planning is needed, for example splitting a milestone into lanes or designing the session contract. It is never used for coding or review.
- Every use of Fable is logged in this file, with its reason.

**Consequences.**
- Milestone 0 used no Fable.
- The milestone 0 lanes (keep-and-drop, skeleton-ci and adapters-doc) were authored by Opus 5.5 and reviewed by Sonnet 5.5, in two rounds and in fresh sessions. For this lane, the two reviews on its pull request are signed "Sonnet 5.5, fresh session". For the other two lanes, this is as the orchestrator reported it.
- Until Codex sessions exist, the reviewer is a different Claude model from the author. This settles the review question in the "Claude Code first, then Codex" entry.

## 2026-10-21: CI runs on pushes to v2

**Decision.** The v2 workflow and the checks workflow also run on pushes to the `v2` branch, not only on pull requests.

**Consequences.**
- `.github/workflows/v2.yml` gets `push: branches: [v2]`. Its `pull_request` trigger stays on `branches: [v2]`.
- `.github/workflows/checks.yml` (the v1 verify job) had `push: branches: [main]`. It is now `[main, v2]`. Its `pull_request` trigger has no branch filter and is unchanged.
- A push to `v2` now starts both workflows. Their jobs have timeouts of 10 and 15 minutes.
- The guard step of `v2.yml` used `github.base_ref`, which GitHub leaves empty on a push. It now takes `github.event.before` on a push, so the guard checks the commits the push brings. When `before` is all zeros (a new branch), it uses `HEAD~1`. The checkout has `fetch-depth: 0`, so `before` is present in the history. Checked locally: `--base origin/` exits 1, and a real commit as base passes. Not tested on a real push: the push path runs only after merge.
- `test/ci-triggers.test.mjs` reads both `on:` blocks and fails if a trigger is removed.
- Author: Haiku 5.5 (claude-haiku-5-5), lane `v2-j1-ci-housekeeping`.

## 2026-10-21: dashboard-builder is defined outside the repository

**Decision.** The `dashboard-builder` agent is not defined in this repository. Its definition is `~/.claude/agents/dashboard-builder.md`, in the user's agents directory. Its frontmatter says `model: opus`. This lane does not change that file.

**Consequences.**
- The repository has no `.claude/agents/` directory, and no tracked file other than this log names `dashboard-builder`. Checked with `git grep -n dashboard-builder` on the branch, excluding this log.
- The file is per user, so a change to it applies to every project on that machine, not to this repository.
- To run this agent on Haiku, change line 5 of that file to `model: haiku`. This is not tested: the lane did not spawn the agent after the change, so whether the next spawn uses Haiku is unknown.
- The `Agent` tool also takes a `model` argument per call. The spawns in the global CLAUDE.md do not pass one, so the frontmatter decides.
- Author: Haiku 5.5 (claude-haiku-5-5), lane `v2-j1-ci-housekeeping`.

## 2026-10-21: the policy gets the inputs its rules need

**Decision.** Lane 1 adds three fields to the `Policy` type of the milestone 1 plan (section 5), and one optional evaluation input:
- `workdir`: the workdir as the harness sees it, its mount point in the container. `read.workdir`, `edit.workdir` and the path checks of `run.safe` need it, and the tool inputs name container paths, not the host path of `StartInput.workdir`.
- `scripts`: the script names of `package.json` on the base branch, read by the service. `npm run <script>` is allowed only for these, as the plan's `run.safe` row says.
- `credentialFile`: the harness's credential file as mounted, for `secret.read`.
- `PolicyContext.readFile`: the current text of a workdir file. The service passes it so the evaluator can tell what an edit of `package.json` changes.

**Consequences.**
- `StartInput.policy` carries the three fields. The service fills them (lane 7).
- An edit of `package.json` is applied to the current text and both versions are compared. A changed `scripts` block asks as `scripts.change`. Changed dependencies ask as `install.package`. An edit the service cannot read or apply also asks as `scripts.change`, with a reason that says so.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j1-contracts`.

## 2026-10-21: the policy refuses to read what it cannot parse

**Decision.** Lane 1's evaluator goes beyond the rows of the plan's table where a row's intent needs it:
- The shell-word parser understands quotes and backslashes only. Besides the plan's list (`;`, `&&`, `||`, `|`, `$(`, a backtick, a redirection, a newline), it refuses any unquoted `$`, `*`, `?` or `[`, a `~` or `#` at the start of a word, and brace expansion. These ask as `shell.compound`. Without this, `cat /run/cle*/claude.token` or `cat $HOME/x` would name a secret the deny rules cannot see.
- `cat`, `head`, `tail`, `ls`, `grep` and `find` are safe only when every path they name resolves under the workdir. `cat /proc/self/environ` asks.
- git's global options are folded for the deny rules, as the plan says. For an allow, only `-C` is folded. `-c`, `--git-dir`, `--work-tree` and the like make a git command ask, because `-c core.pager=...` runs a program.
- `push.base` also denies refspecs `HEAD:main`, `+main` and `refs/heads/main`, and `--mirror` and `--all`.
- `find -fls` asks, like `-fprint`: it writes a file.
- An edit under `.git/` asks. The service pushes the branch from the host (decision 12 of the plan), and a hook written in the workdir would run there.
- `docker` and `sudo` are denied where they run as a program: the first word of a command, after a wrapper such as `env`, `xargs` or `sh -c`, or after `find -exec`. Named as text, as in `git commit -m "docker notes"`, they are not denied.
- `secret.read` reads the fields of a request that name files or places, not what a tool writes. These fields are a command, a URL, a file path, Glob's and Grep's paths, Glob's pattern and Grep's glob. Code that says `event.key` and a README that names `.env.example` would otherwise be denied, and a deny cannot be answered with "Always in this project". A tool the evaluator does not know is read whole.
- The plan's `id_*` is narrowed to the key names `ssh-keygen` writes (`id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519`, with `_sk` and `.pub`), so `src/id_generator.ts` stays readable.
- Every `npx` asks as `install.package`. The plan's "npx <name not in the project's scripts>" is not checkable from script names alone, and an `npx` that is in them would still ask under `default`.

**Consequences.**
- `ls *.ts` asks. A session writes `ls` or `find . -name '*.ts'` instead, which are allowed.
- The deny rules read every simple command of the raw text, with quotes dropped, so `ls; docker ps` and `echo $(git push origin main)` are denied.
- Each case has a row in `v2/test/session/policy.test.ts`.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j1-contracts`.

## 2026-10-21: the cleaner copies the guard's patterns

**Decision.** `v2/src/session/clean.ts` copies the patterns of `lib/guard/codex-guard.mjs` (its `always`, `envAssignments` and `directOnly` lists) instead of importing them. It replaces each match with `[removed: <category>]`. A test reads `codex-guard.mjs` and fails if a copied pattern is not in it word for word. The private-term check uses the guard's fingerprinting (`sha256(salt + term)` over runs of one to four normalised words).

**Consequences.**
- `codex-guard.mjs` cannot be imported: it parses its arguments and exits when loaded. `private-terms.mjs` runs `git` when loaded.
- A change to the guard's patterns fails the v2 test until `clean.ts` is updated.
- The guard only finds a key's first line. The cleaner removes the whole block up to its end line, or to the end of the text when the end was cut off.
- A private term replaces the whole value with `[removed: private term]`, because a fingerprint says that a term is present, not where.
- Command output is cut to `COMMAND_OUTPUT_LIMIT`, 4096 characters: the first 1024 and the last 3072, with a line saying how many were cut. The end of a test run carries its summary. Commands, descriptions and errors are cut the same way.
- The cleaner remembers each tool call's kind and path from its `TOOL_CALL_ARGS`. A read's result keeps its path and size only. A result whose call it never saw keeps its kind, and for a read its path and size, but no output and no error. Lane 4 should check this for subagent tool calls, whose ARGS may not reach the cleaner (an open question of the plan, section 13).
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j1-contracts`.

## 2026-10-21: typed tool input and output inside AG-UI's string fields

**Decision.** AG-UI's `TOOL_CALL_ARGS.delta` and `TOOL_CALL_RESULT.content` are strings. Cleared puts the JSON of a typed value in them (`ToolInput` and `ToolOutput` in `v2/src/session/events.ts`), with Cleared's `kind` inside. `RUN_FINISHED` carries the stop reason and `total_cost_usd` in AG-UI's `result` field, and the tokens in its `usage` list with AG-UI's `TokenUsage` names.

**Consequences.**
- A stored event is valid AG-UI as it is, and the app reads it back typed with `readToolInput` and `readToolOutput`.
- Each argument list is sent whole in one `TOOL_CALL_ARGS`, as the plan has no partial messages in milestone 1.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j1-contracts`.

## 2026-10-21: modules receive the store; main.ts is final

**Decision.** A module's `provide` is a function of `{ store }`, not the plain object of the plan's section 10. `main.ts` does the following:
- it opens `ledger.db`;
- it creates every module's tables;
- it assembles the registry;
- it serves the modules' routes through a dispatcher in `v2/src/modules/registry.ts`, which leaves `/health` and unknown paths to `server.ts`.

**Consequences.**
- Lane 8's ticket store and lane 6's users need the database handle, which a plain object cannot get without opening the ledger at import.
- Lanes 6, 7 and 8 fill their module and never edit `main.ts` or `server.ts`.
- Two modules filling one slot, or declaring one route, stop the service at start with a message naming both.
- A table statement that is not `CREATE TABLE IF NOT EXISTS` (or `CREATE INDEX IF NOT EXISTS`) is refused, so opening the store never changes a table another component owns.
- A failing handler answers 500 `{"error":"internal error"}`. The service log names the route and the error's class only, because an error message may carry what the cleaner removes.
- The service finds `ledger.db` as v1 does (`ORCH_LEDGER`, then `CLEARED_STATE_DIR` or `ORCH_STATE_DIR`, then `<state home>/cleared/<project name>`), except v1's last resort of asking git. Without a state directory or a project name, it stops with exit code 64. `v2/test/main.test.ts` gives every service it starts a temporary state directory.
- The `sessionAdapters` slot defaults to no adapter. The fake adapter is never registered: tests and fixtures create it.
- `TicketStore.move` refuses the go state. Only the approval writer records it (decision 6 of the plan).
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j1-contracts`.
