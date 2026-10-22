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

## 2026-10-21: Fable 5.1 used once to plan milestone 1

**Decision.** Fable 5.1 was used once, on 2026-10-21, to plan milestone 1: the split into lanes and waves, the session contract, the event subset, the policy rules and the choice of the Claude Code driving mode. Reason: strong planning, the case the "model choice per lane" entry allows. It wrote no code and reviewed nothing.

**Consequences.**
- The plan is [milestone-1-plan.md](milestone-1-plan.md). Its lanes are authored by Opus 5.5 or Haiku 5.5 and reviewed by Sonnet 5.5, as the model rule says.
- The decisions the plan takes (its section 2) are copied into this log, with their consequences, when the lane that implements each one lands.

## 2026-10-21: the guestbook example's own choices

**Decision.** Lane `v2-j1-example-app` builds `examples/guestbook/` as the milestone 1 plan describes (lane 3, decision 9). It takes these choices, which the plan leaves open:

1. **The demo needs no database password.** The Postgres containers (the test container, the CI service, the watcher's database, the `[session]` service) run with `POSTGRES_HOST_AUTH_METHOD=trust`, and every `DATABASE_URL` is `postgres://postgres@<host>:5432/postgres`. Reason: none of them is reachable from outside its job, its loopback port or its own Docker network, and with no password there is no secret to keep out of the repository. The guard also refuses a URL that carries a password.
2. **Every Docker object of the example carries a second label, `cleared.example=guestbook`**, besides `cleared.dev=v2`. The watcher filters on both, and removes only ids that such a filtered listing returned. Reason: lane 2 creates `cleared.dev=v2` objects on the same machine at the same time, and the watcher must never remove them.
3. **The app binds `127.0.0.1` by default; the image sets `HOST=0.0.0.0`**, and the watcher publishes `-p 127.0.0.1:8793:8793`. Reason: a published port cannot reach a process that listens on the container's loopback. On the host, only `127.0.0.1:8793` is bound.
4. **The watcher builds from `git archive <commit>` on the build's standard input**, never from a working tree. It keeps the database container, the network and the volume across deploys, and it removes the guestbook images other than the one running. A failed build leaves the running app untouched. A failed start comes after the old app container was removed, so no app runs until the head moves: `/health` then fails and the release watch rolls the merge back. A failed build or start is not retried until the head moves.
5. **The release window**, from question 3 of the plan: `deploy_grace_minutes = 2`, `watch_minutes = 5`, `failures_to_rollback = 2`, `auto_rollback = true`, and `reopen_state = Todo`, which a rollback requires. The plan proposed a 3-minute window. Review round 1 found that a 1-minute grace inside it left no margin for the watcher's poll and build. It also found that the value had been chosen without a measured build time. The grace must cover the time from the merge to the new version answering. Until then the probes reach the version before it, so a broken merge would pass for healthy. The release watch probes every 30 seconds from the end of the grace until the end of the window (`lib/release.mjs`, `watchRelease`). So the window gives 7 probes, enough for two failures in a row. Measured on this server on 2026-10-21, with `node:24-slim` already in Docker's build cache:
   - the watcher's build with `--no-cache`: 3.3 s, 1.9 s and 2.0 s; with `--no-cache --pull` as well: 2.1 s.
   - a whole tick, measured to the first 200 of `/health` after the tick started: 2.8 s for the first deploy (database, network and volume included); 2.2 s for a merge that changes code only; 4.0 s for a merge that changes `package.json`, which runs `npm ci` again.
   - With the default 30-second poll, the worst case measured from a merge to the new version answering is about 34 s. The 2-minute grace leaves about 86 s of margin. How long a first pull of `node:24-slim` takes on a host without it is unknown: it was not measured, because the build cache that holds it carries no `cleared.dev=v2` label and may not be emptied.
6. **The `[session]` keys** are `image`, `services`, `env`, `safe_commands` and `hosts`. Section 3 of the plan does not fix their names. Proposed values: `image = cleared-v2-session:latest`, which is also the only key of `.devcontainer/devcontainer.json`; `services = postgres:16 POSTGRES_HOST_AUTH_METHOD=trust`, a service being reached by its image name without the tag; `env = DATABASE_URL=postgres://postgres@postgres:5432/postgres`; `safe_commands = npm ci, npm test, npm run typecheck`; `hosts = registry.npmjs.org`. Lane 2 builds the image and reads these keys. The image tag and the key names are this lane's choice, and lane 2 had published nothing when they were written. Lane 2, or a small lane after wave 1, aligns one side with the other.
7. **The tracker's identity keys stay out of the committed file.** `agents_uid`, `owner_id` and `human_public_key` depend on the machine and on the owner's key, so they are written at setup (lane 8).

**Consequences.**
- `examples/guestbook/` has one runtime dependency, `pg` 8.23.1. Its devDependencies are `typescript` 7.0.2 and `@types/node` 24.19.2, pinned as in `v2/`, plus `@types/pg` 8.23.1. All three are for `tsc --noEmit` only.
- The database tests fail without `DATABASE_URL`; they do not skip. Each test file works in a schema of its own.
- The example's CI workflow runs only once the directory is the root of a repository (question 1 of the plan).
- This entry is the only change outside `examples/guestbook/`. The brief of the lane asks for it.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j1-example-app`.

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
- In Bash, `secret.read` reads the words of a simple command, except the words that are only text: the arguments of `echo` and `printf`, and the message of `git commit` (`-m`, `--message`). `git commit -m "document .env.example"` is allowed; `git commit -m x .env` and `git commit -F .env` are denied. A command the parser cannot read is read whole, so `cat $(echo .env)` is denied. Added in review round 1.
- A safe git command reads no file outside the workdir. A path operand outside the workdir asks, because `git diff` reads two paths outside the repository even without `--no-index`. `--no-index` asks. For `git commit`, `-F`, `--file`, `-t`, `--template`, `-C`, `-c`, `--reuse-message` and `--reedit-message` ask. Only `git commit`'s options are read as taking a value; for the other safe subcommands, every word that is not an option is checked as a path. Added in review round 1.
- Path checks are lexical: the evaluator resolves `..` and relative paths against the workdir but does not resolve symbolic links, since it runs on the host and sees only the tool input. A link inside the workdir that points outside it therefore passes `read.workdir`, `edit.workdir` and the path checks of `run.safe`. The container limits what such a link reaches: it mounts nothing of the host besides the workdir and, read only, the credential file (plan, section 5), which `secret.read` denies by name. A link created by a session needs `ln`, which no rule allows, or an edit under `.git/`, which asks. A link already committed in the project is not caught. Resolving links on the service side, against the host path of the workdir, is not done in milestone 1. Noted in review round 2.
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
- A result's content is read as Cleared's own form only when its `kind` is the call's kind and every field has the right type. Anything else is the tool's raw output: a command that prints JSON with a `kind` keeps its output, and a read of such a file keeps its real size. Added in review round 1.
- A malformed harness event is cleaned, never thrown on. An id that is not a string becomes empty; a `RUN_FINISHED` without a valid stop reason gets `error`; a step outside the measured ones is dropped. Added in review round 1.
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
- A ledger that cannot be opened (a directory that cannot be made, a file that is not a database) also stops the service with exit code 64 and the path. The store opens `ledger.db` as `lib/ledger.mjs` does for writing: WAL journal, 5 second busy timeout. Added in review round 1.
- On SIGINT and SIGTERM, the service ends every open connection after it stops accepting new ones. Otherwise `server.close` waits forever for the event streams lane 7 adds, and lane 7 cannot reach the server without editing `main.ts`. An app reconnects with the last seq it has. Added in review round 1.
- The `sessionAdapters` slot defaults to no adapter. The fake adapter is never registered: tests and fixtures create it.
- `TicketStore.move` refuses the go state. Only the approval writer records it (decision 6 of the plan).
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j1-contracts`.

## 2026-10-21: text is cleaned per message, at its end

**Decision.** The cleaner holds the deltas of a text message until its `TEXT_MESSAGE_END`, then cleans the whole text at once and stores it as one `TEXT_MESSAGE_CONTENT` just before the end. `createCleaner().clean` returns a list of events instead of one. A run that ends or fails while a message is open first stores that message's text and its end. Reason: each delta was cleaned on its own, so a secret split across two deltas was kept (review round 1 of lane 1, finding 4). The other option, requiring every adapter to send whole blocks, would leave a correctness rule outside the one function the plan makes responsible for cleaning.

**Consequences.**
- A message's text appears in the store and on the stream when the message ends, not while it is written. Milestone 1 has no partial messages (plan, section 4), so the session screen shows the same thing.
- An adapter calls `clean` once per harness event and stores every event it returns, in order. The fake adapter does.
- If partial messages come later, live display needs another path, for example a preview that is never stored. That is not designed here.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j1-contracts`.

## 2026-10-21: the session's Docker runtime (lane 2)

**Decision.** The runtime follows decisions 3 and 4 of the [milestone 1 plan](milestone-1-plan.md), with these choices made by the lane:

1. **The session network has no address on the host.** The internal network is created with `--opt com.docker.network.bridge.gateway_mode_ipv4=isolated`. Reason: on the first doctor run, with `--internal` alone, the network's gateway address was on the host's bridge. From the session, a TCP connect to that address reached a host service listening on all addresses. Every host service listening on all addresses would have been reachable the same way. With the isolated mode the network has no gateway, and the bridge holds no IPv4 address (`ip addr show` lists none besides link-local).
2. **The egress container has its own labelled bridge network**, `cleared-v2-<id>-out`, instead of Docker's default bridge. The plan names one internal network per session. Reason: the default bridge is an object without the label, and the rule is never to run docker against one. Also, egress containers of different sessions would otherwise share a network.
3. **Stop and remove act only on ids a labelled list just returned.** `docker stop`, `rm`, `exec`, `network rm` and `volume rm` take no `--filter`. So `docker.ts` lists with `--filter label=cleared.dev=v2 --filter label=cleared.session=<id>` in the same call, and names only those ids, after `--`. It holds no list of ids in memory, so a restarted service can still stop a session. A listed row without the label is refused, even if the CLI ignored the filter.
4. **The egress proxy:**
   - It accepts `CONNECT` only, to a host name on the allow list, on the listed port. A literal IP address is refused.
   - It refuses a name when any address it resolves to is private, loopback, link-local, shared (Tailscale's 100.64.0.0/10), multicast or reserved, or is one of the host's own addresses. It then dials the address it checked, not the name.
   - The allow list file sits in a folder mounted read only. Reason: the service replaces the file with a rename, which a single-file bind mount would not follow.
   - The proxy listens on the address its `egress` alias has on the session network. That is an address inside the container's network namespace, and nothing is published on the host.
5. **Test services come from a table of known images**, `postgres:16` only in milestone 1. The setting is `[session] services = [alias=]image:tag, ...`, for lane 3's example config. Reason: an image's `VOLUME` would create an anonymous volume without the label. The table makes each such path a tmpfs, and the doctor checks that the Postgres container has no volume mount. Postgres uses trust authentication: a disposable database on a network only the session reaches, so no password exists.
6. **The session container:**
   - It runs as the service's uid and gid, with a read-only root and `HOME=/tmp`.
   - It has no capability and `no-new-privileges`. Its default limits are 4 GB (swap equal), 2 CPUs and 1024 processes.
   - The image creates the config volume's folder with mode 1777, so the volume is writable whatever uid the service has.
7. **The devcontainer reading also takes `build.context`**, which the specification resolves like `build.dockerfile`. Without it, a Dockerfile that copies files from the repository root could not be built. Both paths must stay inside the checkout, symbolic links followed. An `image` the file names is pulled as it is, from any registry, with no check of who published it: the project chooses it, and the README says so.
8. **The image runs Claude Code's postinstall by name** (`npm install --allow-scripts=@anthropic-ai/claude-code`). The npm of `node:24` skips install scripts not allowed by name, and the package's postinstall puts the native binary in place. The SDK's peer dependencies resolved in the image to `@anthropic-ai/sdk` 1.0.0, `@modelcontextprotocol/sdk` 1.32.1 and `zod` 4.6.7. Only the SDK itself is pinned.

**Consequences.**
- The plan's unknowns for lane 2, as the doctor run measured them:
  - Names outside the session network do not resolve on an internal network, so the proxy resolves them.
  - npm and Claude Code 2.1.306 honour `HTTPS_PROXY`.
  - With `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` (set in the image), a `claude -p` run with an invalid key asked only for `api.anthropic.com:443`. Without it, it also asked for `http-intake.logs.us5.datadoghq.com:443`, which was refused.
  - The default allow list stays `api.anthropic.com` and `registry.npmjs.org`. Hosts a logged-in session needs are unknown until lane 4's run.
- A project whose devcontainer names another image needs Node 24, Claude Code and the SDK in that image for lane 4's runner.
- `docker.ts` gives lane 4 `Docker.attach` (`docker start --attach --interactive`) for the runner's standard streams, and `startSession` with `interactive: true` creates the session container without starting it.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j1-container`.

## 2026-10-21: the workspace around a session (lane 5)

**Decision.** The checkouts, the briefing, the handover, the publish step and the runner's hooks follow decisions 12 and 13 of the [milestone 1 plan](milestone-1-plan.md), with these choices made by the lane:

1. **The ticket branch is `cleared/<ticket>`.** The plan names none. One branch per ticket, shared by the author and the reviewer, since the reviewer works on the same branch (lane 7). A ticket id is one word of letters, digits, `-` and `_`.
2. **The ticket checkout is a clone of the service's project checkout, made with `--no-local`.** It is not a linked worktree and has no alternates, because it is mounted alone in the container and the host paths those point to are not. `--no-local` copies only what the project checkout's branches reach, through git's transport: no hard link into its objects, and no object that another ref holds there. `origin` is set back to the forge's address. The base it started from is kept as `refs/cleared/base`, which the runner's hook diffs against. A checkout already there on its branch is reused as it is. A new one is made in a sibling folder and renamed into place, so a checkout that fails half way leaves nothing behind that the next call would take for one to reuse.
3. **The host runs no git command in a ticket checkout once a session has used it.** The session can write its `.git` folder: hooks, `core.fsmonitor`, `url.*.insteadOf`, a push URL. Git run there by the host would execute what the session planted, or send the credential where the session chose. So:
   - publish fetches the branch out of `<workdir>/.git` into `refs/cleared/publish/<branch>` of the project checkout, then reads, guards and pushes from there, and deletes that ref afterwards. The one git process that reads the ticket checkout is the `upload-pack` that this fetch starts on it. The fetch runs with `transfer.fsckObjects` and `fetch.fsckObjects`, since the session wrote every object it brings in: a malformed one refuses the publish.
   - `writeBriefing` checks for a committed `CLAUDE.md` in the project checkout's `origin/<base>`.
   - A reused checkout's branch is read from `.git/HEAD` as a file.
   - `.git/info/exclude` is written without following a link. A `.git` that is a file or a link, a `commondir` or an `alternates` file is refused, because each would make that fetch read another repository. A test plants hooks and an fsmonitor in the ticket checkout, and none of them runs.
4. **The pull request is not a draft.** `merge-pr.sh` check 1 refuses a draft. Its title is the first commit's subject. Its body is the session's report, cleaned by `lib/pr-body.mjs`, then the list of commits; the report is left out when the guard refuses it, as in `push-lane.sh`. An open pull request of the branch is reused. `gh` gets `--repo`, `--base` and `--head` explicitly.
5. **The guard fails closed.** Publish runs `lib/guard/codex-guard.mjs --strict` on the commit messages and on the lines each commit adds, with the lists the project commits at `origin/<base>`. It reads every commit's own diff (`git log --patch`, a merge against its first parent), not the branch's net diff as v1's `push-lane.sh` does. Reason: a secret one commit adds and a later one removes is still in the history that is pushed (review round 1 of this lane). The container hook reads the commits the same way. When the project commits no `.cleared/agents.conf` or names no `[guard] terms` or `allowed` list, nothing leaves, as with v1's `guard_list`.
6. **The `PreToolUse` hook denies every `git push`, not only one to the base branch.** Decision 12 says the container never holds the forge credential and the service pushes from the host, so no push from a session can be legitimate. The rule then needs no base branch name in the container.
7. **The hook's guard is a copy of the guard's patterns.** The image copies `runner/hooks.ts` alone, from the `v2/images/session` build context, so the file imports Node built-ins only and cannot run `lib/guard`. A test keeps the ten patterns identical to `codex-guard.mjs`, as the cleaner's test does. The copy has no private-term list and no list of allowed fixture values, so the host's publish step stays the real gate.
8. **The `Stop` hook asks at each stop, at most once in a row.** It asks when `HANDOVER.md` is absent and `stop_hook_active` is false. The alternative was asking once per session. Reason: a ticket's author session runs again after a review asks for changes, and that round needs its own handover.
9. **lib/memory runs in a child Node process**, for the briefing and for the capture. Importing it runs `lib/conf.mjs`, which copies every `CLEARED_*` variable into `ORCH_*` in the importing process. The child reads the project checkout, not the ticket checkout, so only what the base commits is briefed.
10. **"Decisions linked to the ticket" means v1's selection:** up to five approved decisions that share a word with the ticket's title and body. lib/memory does not read the entries' `links` for the briefing. The five fields are filled with exactly the entries lib/memory chose, within its byte budget. v2 builds the briefing whatever `[memory] enabled` says, because decision 13 makes memory part of every session.
11. **A project that commits its own `CLAUDE.md` is refused.** An excluded path does not hide a tracked file, and the file is the project's. The example project commits none. Supporting such a project is left for later.
12. **Lane 2's placeholder test `v2/test/container/hooks.test.ts` is removed.** It asserted an empty hook set "until lane 5 fills it", and `v2/test/runner/hooks.test.ts` replaces it. That is this lane's only edit outside its files.

**Consequences.**
- **For lane 4, `settingSources: []` keeps `CLAUDE.md` from being read.** `sdk.d.ts` of `@anthropic-ai/claude-agent-sdk` 0.3.306 says `settingSources` "Must include `'project'` to load CLAUDE.md files", and plan section 6 has the runner pass `[]`.
  - `['project']` would also load the project's committed `.claude/settings.json` inside the container: its hooks and permission rules.
  - The other way is to pass the briefing in the system prompt and keep `[]`.
  - Whether the project's skills (`.claude/skills/`, present in the checkout as committed) load without `'project'` is unknown.
  - The choice belongs to lane 4 or to a small follow-up lane.
- **The briefing does not say when the previous handover was missing.** lib/memory writes that note into its text, not into an entry, and the contract's `Briefing` has no field for it.
- **The reviewer is asked for a handover it cannot write.** The policy's `reviewer.edit` rule denies every edit. Lane 7 settles it, either in the policy or in the reviewer's prompt.
- **A session needs a commit identity.** The ticket checkout sets none, and `HOME=/tmp` in the container has no git configuration. Whether lane 4's runner sets `GIT_AUTHOR_*` and `GIT_COMMITTER_*` is unknown.
- **Publish takes the forge's environments from `lib/forge.mjs`** (`forgeEnv` for git, `forgeGhEnv` for gh) in a child process, unless the caller passes them. A test runs that path with no app configured, so the environment is the ambient one. The GitHub App path was not run in this lane.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j1-workspace-memory`.

## 2026-10-21: the app signs people in from ledger.db

**Decision.** The users table belongs to the users module (`v2/src/modules/users.ts`), in `ledger.db`. The app process (`v2/app`) opens the same file to check a password, because the service's API (`v2/src/api/types.ts`) has no sign-in route and changing that file is a lane of its own. The app keeps its sign-in sessions in the same file, in its own table `app_sessions`. That table holds the SHA-256 of the session id, never the id, with the session's anti-forgery token and its expiry. The cookie is `cleared_v2_session`: `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`, 30 days.

**Consequences.**
- A restart of the app signs nobody out. A copy of the ledger does not give a usable cookie.
- `cleared-v2 user add <name>` is `npm run user -- add <name>` (`v2/src/cli/user.ts`) until the installer of milestone 5 installs a `cleared-v2` command. It asks for the password twice without echo, or reads two lines from a pipe.
- The service gets `SqliteUsers` in the `users` slot of the registry, so lanes 7 and 8 can resolve the user id the app forwards.
- `v2/test/modules/registry.test.ts` no longer expects the users module to be a stub. That test is lane 1's file, and this is the one line it had to change.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j1-app-shell-login`.

## 2026-10-21: the app's proof to the service

**Decision.** The shared secret of section 7 of the milestone 1 plan is the file `v2-app-proof` beside `ledger.db`: 64 hexadecimal characters, mode 0600. Whichever process starts first creates it, with an exclusive create, so two processes starting at once agree. `readOrCreateProof` refuses a file that is a link, belongs to another account, can be read by others, or is not 64 hexadecimal characters. It leaves that file as it is. The app sends the proof in `x-cleared-proof` and the user id in `x-cleared-user` on every request it forwards. Its request carries only `accept`, `content-type`, `content-length` and `last-event-id` from the browser, never the cookie, the anti-forgery token, `Authorization` or the browser's own `x-cleared-*` headers. Only `content-type`, `content-length`, `cache-control`, `allow` and `retry-after` of the answer reach the browser, so the service cannot set a cookie on the app.

**Consequences.**
- Lanes 7 and 8 check the header with `sameProof(given, proof)` from `v2/src/modules/users.ts`, which compares in constant time, and find the file with `proofPath(ledgerPath())`.
- In the plan (decision 6 and section 7), a session container mounts neither the ledger nor this secret, so nothing in a session can send the proof. Lane 2's runtime is where that holds.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j1-app-shell-login`.

## 2026-10-21: Argon2id parameters, and a throttle that refuses the right password too

**Decision.** Passwords are hashed with `crypto.argon2` of Node 24 (`argon2id`, no dependency) with the second recommended option of RFC 9106, section 4: "t=3 iterations, p=4 lanes, m=2^(16) (64 MiB of RAM), 128-bit salt, and 256-bit tag size". The first option needs 2 GiB per sign-in. One hash took about 100 ms on this server on 2026-10-21. The stored value is the PHC string (`$argon2id$v=19$m=65536,t=3,p=4$<salt>$<hash>`), so the parameters can change later without breaking stored hashes. An unknown name costs a hash too.

Failures are counted per peer address and per user name over 15 minutes. After five of either, the sign-in answers 429 with `Retry-After` until the window has passed, even for the right password, so a lucky guess during a lockout tells nothing. This differs from v1, where a right token always gets in. An attempt is counted when it starts, before its password is checked, and a right password takes its own attempt back. Counting only after the check let a burst of parallel requests all pass the count while it was still zero (review round 1, blocking 1).

A password is 15 to 1024 characters. NIST SP 800-63B-4 ("Password Verifiers") requires at least 15 characters for a password used as a single factor and asks verifiers to permit at least 64. The maximum is the sign-in form's `maxlength`, so any password the command accepts can be typed at sign-in.

**Consequences.**
- The counts live in memory: a restart of the app clears them, which only an account on this machine can cause.
- The peer is the TCP peer address. Behind a proxy on this machine (`CLEARED_V2_APP_ORIGIN`), every browser arrives as `127.0.0.1`, so five wrong passwords from anyone block every sign-in through the proxy for 15 minutes. The name key also lets anyone who knows a user name block that user for 15 minutes. Both are accepted for a tool with one owner on a private network: the cost is a 15 minute wait, never a way in. A forwarded address header is not trusted instead, since any client can send one (review round 1, followup 2).
- A sign-in form posted from another origin, or with `Sec-Fetch-Site` other than `same-origin`, is refused before any password is checked.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j1-app-shell-login`.

## 2026-10-21: the browser runs the app's TypeScript with its types stripped

**Decision.** The page's code is TypeScript under `v2/app/public/`. The app serves each `.ts` file as JavaScript through `stripTypeScriptTypes` of `node:module`, so there is no build step and no dependency. A screen exports pure functions (data and a translator in, escaped HTML out) and a `mount(root, context)` for the browser. The tests call the pure functions under Node, without a DOM library. The pages run under `Content-Security-Policy: default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`, with no inline script and no inline style. Browser code imports from `v2/src` with `import type` only, which stripping erases.

**Consequences.**
- `stripTypeScriptTypes` is marked experimental in Node 24.21.0 and prints one `ExperimentalWarning` the first time the app serves a `.ts` file. Whether it stays in later Node versions is unknown.
- `Referrer-Policy` is `same-origin`, not `no-referrer`. With `no-referrer`, Chromium sends `Origin: null` on a form POST, and the origin check refused the sign-in. The headless run of 2026-10-21 showed it.
- The app's tests live under `v2/app/test/` (lanes 9 and 10 add theirs there), and `npm test` runs them. The app has its own `v2/app/tsconfig.json` with the DOM types. CI runs `npx tsc --noEmit` on the root configuration only, and that step is not this lane's file to change. So `v2/app/test/static.test.ts` runs `tsc -p app`, and the app's type check runs in CI through `npm test`.
- The text of every screen comes from `v2/app/messages/<screen>.<language>.json`. `CLEARED_V2_APP_LANGUAGE` (`en` or `fr`) chooses the language, and a test requires every French file to have every English key with the same placeholders.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j1-app-shell-login`.

## 2026-10-21: the tower of milestone 1, against tower.png

**Decision.** The tower follows `tower.png` for layout, sizes and colours, and the plan for content. Where the capture shows what milestone 1 does not have, the plan wins:
- The tabs are Tower, Inbox with its count, Sessions and Tickets. Plans, Fuel and Rules are left out. Tickets is shown dimmed with a tooltip, because no lane of milestone 1 builds a tickets screen; tickets are created from the tower's bar.
- There is no "Lead · always on" pill and no "Claude 76 % left" in the grey line. Usage per subscription is an unknown that lane 9 closes.
- The lead card and the plans card say they come in milestone 2.
- The capture's plan card is left out, since a plan is not an inbox item in milestone 1, so the fixture's heading reads "Two things need you.".
- New ticket is the black primary button, because it is the bar's only action that works. New goal and Ask the lead are marked `aria-disabled` and say, when clicked, that they come in milestone 2.
- Landed today adds the time from creation to done after each title, because the plan asks for durations.
- A session that waits for the human shows a still amber dot, not the blue live one. DESIGN.md keeps the live dot for a session actually running.
- When the app runs on fixtures, the header shows "Sample data, not the service" in the style DESIGN.md gives a state chosen on purpose.

The fixture uses neutral names. The project is the example guestbook, and ticket ids are `LOCAL-<n>`, as the local tracker names them. The signed-in user of the captures is `demo`. Titles and status phrases are the capture's.

**Consequences.**
- The fixture is made by playing lane 1's fake adapter into an in-memory store. Each fixture session has stored events, and `CLEARED_V2_APP_SOURCE=fixtures` serves them as the service would, with ticket creation into an in-memory store. Against the live service, creating a ticket depends on lane 7's `POST /api/tickets`.
- Two art director passes by Sonnet 5.5 judged the captures against `app/DESIGN.md`. Most of their items asked for v1's tower: stage columns, the instruments strip, the porthole chips, a full-width Landed table. Those were not taken, because `tower.png` and the plan are this lane's reference. The items taken are in the pull request.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j1-app-shell-login`.

## 2026-10-21: the guard leaves out the app's two web fonts

**Decision.** `v2/scripts/guard.ts` checks every v2 file as a tree, and the guard's tree mode refuses any non-text file (`lib/guard/codex-guard.mjs` expects a snapshot pruned of non-text files beforehand). The plan copies the Geist fonts into `v2/app/public/fonts/`. The guard now leaves out exactly the files matching `^v2/app/public/fonts/[A-Za-z0-9-]+\.woff2$`, and says how many it left out. Every other binary under `v2/` is still refused, and the fonts' `LICENSE.txt` is still checked.

**Consequences.**
- A fake secret in a text file, a `.png` and a `.woff2` outside that folder, all planted for the check on 2026-10-21, were refused.
- The fonts are byte for byte the v1 files (`app/public/fonts/`, SIL Open Font License).
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j1-app-shell-login`.

## 2026-10-21: the example's repository and the sessions' login (plan questions 1 and 2)

**Decision.**
1. Question 1, answer (a): the demo project lives in its own public repository, `cleared-example-guestbook`, in the organisation this repository lives in, Apache-2.0, seeded from `examples/guestbook/` on `v2` and kept in sync by hand. No other organisation setting was changed. The lock's pull requests and merges for the demo happen there, never in this repository.
2. Question 2: for the real session runs, the owner chose on 2026-10-21 at 21:35 (Europe/Paris) to reuse, read only, the Claude Code login that already exists for the owner's account on the server, instead of a `claude setup-token` token. It is bind mounted read only into session containers labelled `cleared.dev=v2` and nowhere else; its content is never read, printed, copied, logged or committed, and never leaves the server. Its host path is set by an environment variable and is not written in this repository. No API key. This is a third option, outside the plan's (a) and (b); it closes question 2. It supersedes, for lane 4's runner and doctor and every later real session run, the plan's rule (section 11) that real runs never touch the host's Claude Code directory, and the setup-token mechanism of section 6 as the default (`/run/cleared/claude.token`, `CLAUDE_CODE_OAUTH_TOKEN`), which stays the documented fallback. The owner accepts, for this self-hosted use of the owner's own subscription, the open policy question on claude.ai login in third-party products. A read-only mount blocks token refresh; lane 4 measures whether long runs survive it and records the result.

**Consequences.** Lane 8's real proof (wave 3) runs against that repository. A change to `examples/guestbook/` is copied there by hand until milestone 4.
- Decided by the owner on 2026-10-21: question 1 at 21:33, question 2 at 21:35 (Europe/Paris); written by the orchestrator.

## 2026-10-21: the session login is the service account's existing Claude Code login (plan question 2)

**Decision.** By the owner, 2026-10-21 21:35, for milestone 1's real runs, in place of a `claude setup-token` token (which needs the owner's browser): the session containers use the existing Claude Code login of the account the service runs under, read only. The service names that login's credentials file with the `CLEARED_CLAUDE_CREDENTIALS` environment variable; no path to it is committed. Without the variable, the service uses `claude.token` in its state folder, where a `setup-token` token would go. The file is bind mounted read only at `/run/cleared/claude.token`, and only into session containers labelled `cleared.dev=v2`. Its content is never read, printed, copied or logged by the service, the doctor or the lane, and never leaves the server. This applies the default of the plan's question 2, option (a), the subscription.

**Consequences.**
- The runner reads the mounted file inside the container. It accepts a plain token (the `setup-token` form) or a credentials file, and it gives the CLI only the access token, as `CLAUDE_CODE_OAUTH_TOKEN`. The CLI is not given the refresh token, so a session never refreshes the login, which would rotate the refresh token and could sign out the host's own CLI.
- The refresh token is still in the mounted file, readable by the session's own processes (same uid). The policy denies any tool call that names `/run/cleared/` (`secret.read`, now checked before every tool call, see the next entry), and the egress proxy lets the session reach only its allow list. But a command the policy allows can run code the session wrote, for example `npm test` running an edited test, and that code can read the file. This is the cost of reusing the login; a `setup-token` token, which "can only make model requests", would remove it.
- The access token is in the CLI's environment (review round 1 of PR 143, followup 3). Measured on 2026-10-21 in a labelled container:
  - Claude Code 2.1.306 removes `CLAUDE_CODE_OAUTH_TOKEN` from the environment of the commands its Bash tool runs: a probe printed `absent`.
  - The `claude` process keeps the token in its own environment, and any process of the session's uid can read `/proc/<pid>/environ`: a probe found it there and printed only the process name.
  - The policy now denies, under `secret.read`, any tool call that names an `environ` file (`/proc/*/environ`, `/proc/self/environ`, `/proc/$PPID/environ`), `printenv` wherever it runs, and an `env` that runs no command. It denies these before they run, through the runner's tool check.
  - The SDK's own protection, `sandbox.credentials.envVars`, works only inside Claude Code's sandbox, which this container does not run. Claude Code 2.1.306 also reads an undocumented `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR`; using it would need the SDK's `spawnClaudeCodeProcess` around an internal interface, so it is left as an option, not adopted.
  - Residual risk: code that the policy lets run can still read `/proc/<pid>/environ`, for example a test the session edited and then ran with `npm test`, or an interpreter (`node -e`) that the inbox allowed. So can the mounted login file, as the previous point says. Shell built-ins that print the environment (`set`, `export -p`, `declare -x`) are not denied: they print the Bash child's environment, which holds no token. The model's context and the transcript on the config volume would then hold the token, until the volume is removed when the ticket is done. A `setup-token` token narrows what a leaked token allows; it does not remove the leak.
- The access token has a limited lifetime. The runner reads the file once, when its container starts, and the host CLI replaces its credentials file when it refreshes. So a session keeps the access token it started with. What happens when that token expires mid session is unknown; a resume starts a new container and reads the file again.
- A `setup-token` token "can only make model requests" (Claude Code authentication page); a full Claude Code login is not limited that way.
- Earlier the same day, before this decision, the lane had copied the access token alone into the service's token file, to unblock its first container runs. That copy was deleted when the decision arrived, and nothing of it was committed or printed.
- The open policy question on claude.ai login in third-party products (plan, section 11) stays open.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j1-claude-adapter`.

## 2026-10-21: the Claude Code adapter (lane 4)

**Decision.** The adapter follows section 6 of the [milestone 1 plan](milestone-1-plan.md), with these choices made by the lane, each checked with the real CLI in a labelled container ([adapters.md](../adapters.md), "Claude Code verified in a container"):

1. **The runner's protocol** is JSON lines. On stdin: `start` first (session id, model, `resume`, budget), then `user` (with a uuid chosen by the adapter), `answer`, `tool_verdict`, `interrupt`, `stop`. On stdout: `sdk` (each SDK message unchanged), `permission_request`, `question`, `tool_check`, `request_cancelled`, `error`, then `exit`. Reason: the host side owns policy and cleaning, so the runner stays small, and its line types are exported for both sides from `runner/main.ts`.
2. **Every tool call is checked against the policy before it runs.** A `PreToolUse` hook of the runner's own sends a `tool_check` and waits for the host's verdict; only a deny stops the call, and a check that is aborted fails closed. It runs before lane 5's hooks, which are spread after it. Reason: in `default` mode Claude Code runs a read without calling `canUseTool`. The first probe read a planted `.env`, and the model quoted its value. So without the check, section 5's deny rules (`secret.read` above all) would not apply to reads. An `ask` verdict is not raised by the check: it stays for `canUseTool`, so the inbox sees what Claude Code itself asks about, as the plan says. Making the check also escalate asks is possible, at the cost of many more inbox items; it is not done here.
3. **`CLAUDE.md` is appended to the `claude_code` system prompt preset** by the runner, instead of being loaded by Claude Code. Reason: with `settingSources: []` the SDK loads no `CLAUDE.md` ("Must include 'project' to load CLAUDE.md files"), and the `project` source would also load the project's settings and hooks. Lane 5 writes the file; nothing else changes for it.
4. **A turn starts at the CLI's `command_lifecycle` `started` frame**, whose `command_uuid` is the uuid the adapter gave the user message, so `RUN_STARTED.runId` names the message that started the turn. An `init` without user message uuids and a `result` of no turn (`num_turns: 0`), which the CLI prints after a resume, map to nothing.
5. **A message sent during a turn is only pushed to the SDK.** The run showed the running turn takes it in before it ends. The plan's fallback, an interrupt then the message, is not needed.
6. **Interrupt** first settles every request that waits (`cancelled`, by `policy`, rule `interrupt`), then asks the SDK to interrupt. The turn's `result` (`error_during_execution`, `aborted_tools`) maps to `RUN_FINISHED` `cancelled`.
7. **A question is `AskUserQuestion` through `canUseTool`.** It never goes through the policy. Its answer goes back in the tool's input as `answers`, keyed by question text.
8. **The session state** that the adapter keeps in `STATE_SNAPSHOT` and `STATE_DELTA` holds: a status phrase per tool call, the phase (`waiting_human` while a request waits or between turns), the files edited with their line counts, and the session's usage from the result's `modelUsage`. `RUN_FINISHED` carries the turn's `usage` and the session's `total_cost_usd`, which the SDK reports as a total so far.
9. **The ticket's prompt is the first user message, attributed to `cleared`**, since no user wrote it.
10. **The adapter's default runtime** is the service's state folder (`CLEARED_V2_STATE_DIR`, else `<XDG_STATE_HOME or ~/.local/state>/cleared-v2`), with the egress allow lists in it, the login of the previous entry, the host's own addresses and the service's uid. It is registered in `adapters/index.ts`, so lane 1's test that no adapter was registered now expects `claude-code`.
11. **The doctor's `claude-code` section runs only when named**, since it spends real model usage (about 0.006 USD with `claude-haiku-5-5`).

**Consequences.**
- The plan's unknowns for lane 4 are closed: login in a container, an allow round trip, interrupt, resume after the container is recreated, a message mid turn, subagent frames (`parent_tool_use_id` is the parent `Agent` call's id), and the question mechanism. A `setup-token` token in a container, and an access token that expires during a session, remain unknown.
- Lane 2's unknown, the hosts a logged-in session needs: `api.anthropic.com:443` only, with non-essential traffic off.
- A tool check adds one round trip between the runner and the host before each tool call; its latency was not measured.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j1-claude-adapter`.

## 2026-10-21: the human's approval, signed by the service, and the lock unchanged (lane 8)

**Decision.** Lane `v2-j1-approval-lock` implements decisions 6, 7 and 11 of the [milestone 1 plan](milestone-1-plan.md). It needs no edit of `lib/tracker/adapters/local.mjs`, `serve/release-broker.mjs` or `merge-pr.sh`: the identity unknown of section 13 ("which configuration makes the local tracker see the v2 service as `agents`") is closed by settings alone. The machine's settings file (`CLEARED_CONF`, not committed) holds:
- `[tracker] agents_uid` = the uid of the service account. `tracker.sh identity` then answers `app` (`lib/tracker/cli.mjs` line 15), because the local tracker run by that uid is the `agents` actor.
- `[tracker] owner_id` = the name of the app user who approves, which must differ from the service account's own name (`LocalTracker` throws when both are the same). `moved-by-owner` then reads the service's signed row as the human's (`local.mjs` lines 97 to 105).
- `[tracker] human_public_key`, the base64 of the PEM, committed in the project's file. `npm run setup -- --owner <name>` makes the key pair, writes the private key once (mode 0600, never over a key that exists), and prints the public key and these lines. It never prints the private key.
- `[security] human_user` = the service account. Without it the broker runs `getent passwd <owner_id>` at start and stops, since the app user is not a Unix account. With it the broker takes the service's uid as the human's, as the shared-uid default already does, and accepts the service's requests (`release-broker.mjs` lines 98 and 116, with `allow_shared_uid = true`, decision 7).

The choices the lane makes:
1. **A signed row is the owner's, and only the owner's.** The store signs a write as `owner_id` only for the signed-in user whose name is `owner_id`. Another user's ticket, move or comment is a `human` row without a proof, with their user id, which v1 reads as `other`: a guest's line never counts as the owner's (`byOwner`, check 4b of `merge-pr.sh`, the fast lane's label actors). Found in review before the first push.
2. **The approval route** is `POST /api/tickets/:id/approve`. Order of refusals, nothing signed until all pass: the app's proof (`sameProof`, 401), a user id (400), a user of the table (403), the owner (403), the ticket (404), the ticket in `validate_state` (409), the request time and the heads equal to `validations/<ticket>.json` (409). The body is at most 64 KiB, 1 to 8 pull requests with 40 hex heads. A service with no key, or no `owner_id`, answers 503 and says to run `npm run setup`.
3. **The grace is held by the service**, as the plan's lane 8 says: 202 with `dueAt`, 60 seconds, then every check is made again on the record as it is then (a new request, a new head or a card moved back writes nothing and records `refused`), then the signed move, in one `BEGIN IMMEDIATE` transaction. Undo is `POST /api/tickets/:id/approve/undo` (200, or 409 when nothing is held). Held approvals live in memory: a restart of the service during the grace loses them and writes nothing.
4. **The signature** is what `local.mjs` verifies: `JSON.stringify([n, status, at, owner_id, approval_context, null])` with `n` the ticket number, and `approval_context` = sha256 of `[ticket, request time, [{pr, head}] sorted by pr]` from the record `ask-validation.sh` keeps. The tests use v1 as the oracle (`LocalTracker` through `oracle.mjs`, `tracker.sh moved-by-owner` exit codes), not a mirror: a row altered after signing is `other`; a move for another request or other heads gives exit 8; a row signed by nobody gives exit 6.
5. **Ledger events.** Each approval writes `app_gesture` events with source `app`: `started`, `undone`, `written`, `refused`, `release_refused`, with the user id, the shown heads and, for a refusal, the reason.
6. **After the write, the service asks the broker for the release** (`request_release`, once per shown pull request, with an announcement built from the ticket and the approver), as the plan says. A refusal is recorded (`release_refused`) and the signed move stays: the human did approve. If the service stops between the write and that call, the card stays in the go state and nothing asks again. There is no retry in this lane.
7. **The review recorder** writes a `runs` row (`role = 'review'`, `source = 'dispatcher'`, `outcome = 'done'`, `pr_number`, `ticket`) and `reports/<ticket>-pr<n>-r<round>-<session>.md` with the front matter `commit`, `outcome`, `ended_at` and `## Report`. Its own `Verdict:` line comes first, with `[merge] verdict` for a pass and `not passed: changes requested` otherwise. A line of the reviewer's text that reads as a verdict or a heading is quoted, so a report cannot say the verdict for the recorder. `ReviewRecord` has no commit field and the lane may not change `registry.ts`, so `record` takes an optional `commit` (lane 7 should pass the reviewer's checkout head) and otherwise asks `gh pr view` in the project checkout; with neither it refuses.
8. **Tables.** The store and the recorder create `tracker_*`, `runs` and `events` with the statements of `local.mjs` and `lib/ledger.mjs`, one per statement. Two tests keep them identical to the v1 source.
9. **The key file** is `[tracker] human_private_key`, else `CLEARED_V2_APPROVAL_KEY`, else `approval.key` in the state directory. It must be a regular file (not a link) owned by the service account, mode 0600, outside the project.
10. **Plan decision 11 is kept:** tickets stay in the local tracker's tables, written from TypeScript.

**Consequences.**
- `v2/test/modules/registry.test.ts` expected the tickets and approval modules to be stubs. This lane's one edit of lane 1's test file: those two entries became `emptyModule`.
- **Follow-ups for other lanes.** `v2/src/api/types.ts` needs the Undo route (`POST /api/tickets/:id/approve/undo`) and the optional `dueAt` of the approve answer: a lane of its own. Lane 10's acceptance reads as if the app held the grace, and lane 8's text says the service does; this lane follows its own text, so the inbox screen calls approve and then Undo. `ReviewRecord` needs the `commit` field. Lane 7 creates and moves tickets through the store with the signed-in user, which signs only for the owner.
- **The example's committed `.cleared/agents.conf` cannot run the lock as it stands.** It lacks keys v1 requires: `[tracker] team`, `[lanes] root, base, push_roles, busy_states, closed_states, archives` and `[lead] report_on` (`conf_get` stops on them). The proof run added them to the machine's file. That file belongs to lane 3 and was not changed.
- `host-state.sh`, which `merge-pr.sh` runs for check 5, runs `docker ps` without a label filter. The proof run put a shim named `docker` first on the PATH, which prints nothing, so no docker command ran. A v1 line, for milestone 4.
- **Real proof, 2026-10-21 between 22:44 and 22:52 (Europe/Paris), on this server.** The release broker ran for the example project on a Unix socket in `/run/user/1000`; the v2 service ran on `127.0.0.1:8794`, the only new listening port (`ss -ltn` before, during, after). The example repository (`cleared-example-guestbook`, in this repository's organisation) got a branch `lock-proof/v2-j1-approval-lock` and its pull request 1 ("not for merge", one comment line in `src/config.ts`), closed after the proof; the branch stays. `merge-pr.sh --dry-run` was run directly on pull request 1; the real merge was never asked for: the service's own broker call went to a path where no broker listens, which `release_refused` records, and the pull request stayed open and unmerged. Results: before the request, "the user has not agreed"; after the broker's `--ask`, the app's approval (202, written 60 seconds later as `human`) and the review record, "would_merge": 1 with `kind: agreement` and `agreement: status`; after a new commit, "has no review"; after a review of that commit, "this version (abbc8b0b) is not the version he was shown (ad90145b)". The raw lines are in the pull request.
- **Not tested.** The app's password session and its forwarding (lane 6) were not in the loop: the run sent the request the way the forwarder does, with the proof and the user id. The real `request_release` without `--ask` ran only against a fake `gh` in `v2/test/approval/broker.test.ts` (it records `gh pr merge --match-head-commit <head>`), never against GitHub. Whether `merge-pr.sh` closes the ticket after a real merge was not run.
- Author: Sonnet 5.5 (claude-sonnet-5-5), lane `v2-j1-approval-lock`. The plan names Opus 5.5 for this lane; the session that wrote it ran Sonnet 5.5, so the plan's default reviewer (Sonnet 5.5) would review its own model. The reviewer must be another model.
- **Review round 1 of PR 151.** An empty or unreadable app proof now refuses every request: `verifyProof` is false when none is configured, and `sameProof` (lane 6's helper, one line) rejects an empty secret. `ApprovalWriter.approve()` does not check the proof, only the owner; no route may call it with a user id from a request that has not shown the proof (lane 7 and lane 6 check this). Lane 7's ticket routes must take the human actor from the proof-checked user id, never from the body.


## 2026-10-21: the ticket's path in the service (lane 7)

**Decision.** `v2/src/flow/` runs a ticket from Todo to the release request, as the [milestone 1 plan](milestone-1-plan.md) lane 7 says, with these choices made by the lane:

1. **A person starts a ticket, the service never does.** The routes `POST /api/tickets` and `POST /api/tickets/:id/move` (to Todo) start the flow, in the background. The service's own moves, including the move back to Todo when it stops a ticket, start nothing: a test proves an over-budget ticket is not restarted. `TicketStore.create` puts a ticket in Todo (lane 1's contract), so creating one starts it. Step 2 of the plan's proof ("moves it to Todo") is then a move of a ticket parked in another state.
2. **The flow owns a ticket's state from Todo until the lock has the release request.** The service moves it to In Progress, In Review and Needs Approval, and back to Todo with a note. The move route refuses (409) a ticket whose flow is active. Once the lock is asked the flow is over: while the release waits for approval a person can send the ticket back with a move to Todo (the inbox's "Send back" has no route of its own), which starts a new flow. A new release item settles the older waiting one of the same ticket. The move to the go state stays the approval's alone (the store refuses it).
3. **"Author done" is a `RUN_FINISHED` with `end_turn` and no request of that session waiting in the inbox.** `HANDOVER.md` being present proves nothing, since the Stop hook asks at every turn end. A cancelled turn (an interrupt) leaves the session paused, waiting for a message. Any other stop reason fails the session. A message to a finished session is refused (409); the author is reopened by the flow only.
4. **Steps are filed under the session that did the work.** `workspace`, `author` and `waiting_human` go to the author's events, `review`, `release` and `approval` to the reviewer's. The real adapter emits no step events, so the flow writes them all. `workspace` is written after the adapter has started the session, with the time it began, because the session's id does not exist before: in the stored order it comes after the session's first events. `watch` is the lock's, not the flow's. The `approval` step ends when a tick sees the ticket out of Needs Approval (the human's move to go, written by lane 8).
5. **The review.** Role `reviewer`, `claude-sonnet-5-5` (`CLEARED_V2_REVIEWER_MODEL`), the same checkout and branch, the reviewer policy. The prompt is `prompts/review.md` with the project's `[merge] verdict` phrase and the base branch filled in. The last `Verdict:` line of the last assistant message that has one decides: a pass carries the phrase and not "fix before merge". A review with no `Verdict:` line is not a pass: the ticket goes back to Todo with a note, nothing is published.
6. **Two review rounds per flow**, counted from the start the person gave the ticket (a ticket put back and started again begins at round 1), then the ticket goes back to Todo with the last report as a note (`CLEARED_V2_REVIEW_ROUNDS`). The plan gives no cap on rounds; two is the plan's number for the reviewer's rounds on a pull request. A requested change reopens the author with `resume` and sends the report as its next message; if the session cannot be resumed, a new author session starts from the ticket and the report. A request for change has no pull request, so it is not recorded through the review contract; the passing round is, with its round number.
7. **The sequence after a pass** is: `projectCheckout` (the refresh, issue 141), `publish`, `reviewRecorder.record`, then the lock's request, then the move to Needs Approval (made by the flow only if the lock did not make it: `ask-validation.sh` moves the card itself), then the release item. The item's `requestedAt` is the time the ticket store holds for that move, the request time lane 8 binds the approval to. A test asserts the refresh is the call right before publish. A refused publish or a refused request puts the ticket back with the reason.
8. **The request to the lock is `release-request.mjs request_release <ticket> <pr> --ask`** with the announcement on stdin, run as a child process with a 60 second limit. The release item shows the heads published.
9. **Idle stop at 15 minutes** (`CLEARED_V2_IDLE_MINUTES`), counted from the last event, message or answer of a session. Time a session waits for the human is not idle: a request waiting in the inbox exempts its session, because stopping it would lose the request, and the wait is the human's (the plan counts it apart as `waiting_human`). The idle stop writes a `RUN_ERROR` with code `idle` and puts the ticket back with a note.
10. **Budget stop**, `CLEARED_V2_BUDGET_USD` (none when unset). At each `RUN_FINISHED` the cost of every session of the ticket is added from the stored events; over the budget (the cost counts every session the ticket has ever had, so raise the budget before starting it again), every live session of the ticket stops with a `RUN_ERROR` code `budget`, and the ticket goes back to Todo with the spent amount. The SDK's own `maxBudgetUsd` still caps a single run; this one is per ticket. A session that never ends a turn is not seen until its turn ends.
11. **The inbox** is `flow_inbox` in `ledger.db`: permission and question items from the session's `CUSTOM` events, the release item from the flow. It keeps handled items for a day ("Handled today"). A `permission_answered` with no waiting request (a policy deny the adapter reports alone, issue 145 item 4) is ignored. "Always in this project" is saved in `policy_rules` by the answer route, because the adapter does not do it; the pattern is the command, path, URL or search text of the request.
12. **The API** is `v2/src/api/routes.ts`, split over the three modules (sessions, flow, inbox) by path. Every route checks the proof first (401), the service not being set up gives 503, and a write needs a user id the users table knows (403). Bodies are JSON of at most 64 KiB. The event stream starts after `?after=` or `Last-Event-ID`, which wins, answers keep-alive comments every 15 seconds, and releases its watcher when the client leaves. The approval route is lane 8's and is not declared here.
13. **Configuration** is the environment of the service; the flow is off without `CLEARED_V2_PROJECT`, and a project that is named but incompletely set up stops the service with exit code 64.

    | Variable | Default | Meaning |
    | --- | --- | --- |
    | `CLEARED_V2_PROJECT` | none | The project's name, as tickets name it. Unset: the API answers 503. |
    | `CLEARED_V2_PROJECT_DIR` | required | The service's checkout of the project (absolute). |
    | `CLEARED_V2_REPO_URL`, `CLEARED_V2_REPO` | required | The repository's address, and `owner/name` for `gh`. |
    | `CLEARED_V2_BASE` | `main` | The base branch. |
    | `CLEARED_V2_WORKDIRS` | `<state>/work` | Where the ticket checkouts live. |
    | `CLEARED_V2_AUTHOR_MODEL`, `CLEARED_V2_REVIEWER_MODEL` | `claude-opus-5-5`, `claude-sonnet-5-5` | Explicit model names. |
    | `CLEARED_V2_IDLE_MINUTES`, `CLEARED_V2_REVIEW_ROUNDS`, `CLEARED_V2_BUDGET_USD` | 15, 2, none | The limits above. |

    The verdict phrase, the safe commands and the hosts come from `.cleared/agents.conf` at the base branch of the project checkout, never from a session's copy; the scripts come from `package.json` at the same commit.

**Issue 139 (a reviewer asked for `HANDOVER.md`).** Settled in the flow and the prompt, not in the policy or the runner, which belong to lanes 1 and 5. The flow never captures a handover for a reviewer. The review prompt says the reviewer cannot write files and that its final message is the report, and tells it to answer the end-of-session notice in one sentence. The Stop hook still asks a reviewer once (it does not know the role), so a review costs one extra turn, and the report is read from the last message that has a `Verdict:` line, not the last message. Lasting fix, for a lane 5 follow-up: the runner skips the ask for the `reviewer` role (the role has to reach the runner through its environment, which is lane 4's file).

**Issue 141 (refresh before publish).** The flow calls `projectCheckout` immediately before `publish`, and a test fails without it. `publish.ts` itself is unchanged and still reads the base as the project checkout last fetched it.

**Consequences.**
- **A running flow does not survive a restart.** Live sessions, the active-ticket set and the timers are in memory; the inbox and the events are in the ledger. A ticket in progress when the service stops stays In Progress, with its sessions gone. After the restart a person can move it back to Todo, which starts it again in the existing checkout. Resuming where it stopped needs the adapter to persist `StartInput` (issue 145 item 2) and a recovery pass in the flow; neither is in milestone 1.
- **`ticketFiles` of the policy stays empty and `learned` is read when a session starts.** The deletion rule therefore asks for every file outside the (empty) list, and an "Always" answer applies from the next session. Refreshing both mid session needs the adapter's `policy` option, which `adapters/index.ts` does not pass.
- **A session's state is folded from its events at each read.** Fine for a demo's number of sessions; a stored snapshot is the answer if the list gets long.
- **Captures of the release item are empty** until the example's screens are captured, which is not part of this lane.
- **`test/modules/registry.test.ts` needed one edit outside the lane's files**: it asserted that the sessions, flow and inbox modules are empty, which they no longer are.
- Author: Sonnet 5.5 (claude-sonnet-5-5), lane `v2-j1-flow`; the plan names Opus 5.5 for this lane.

**Review round 1 of PR 150.** `settings()` now fetches the project first (a fresh service has no checkout, and the base is read as it is now). A new engine closes the permission and question items a dead process left waiting. An answer's kind must match the item's (answer for a question, allow or reject for a permission). A reopen whose message fails stops the resumed session. A store error on a route is a 409. `reject_always` is not accepted from the API, since no deny rule is recorded. Left open: the extra reviewer turn wording (confirm against the real adapter in lane 11), the author field of the plan.
## 2026-10-21: the session screen of milestone 1, against session.png (lane 9)

**Decision.** The session screen follows `session.png` for layout, sizes and colours, and the plan for content. It runs on the stored events of the session (AG-UI subset, plan section 4) and the service routes of `src/api/types.ts`, and shows only what those carry. The lane's choices:

1. **What the capture shows and milestone 1 has no carrier for gets an honest empty state, not an invented value.** The plan of the session: `TodoWrite` is mapped to `{ kind: 'think' }` with no content (`claude-code/map.ts`), and `SessionState` has no plan field, so the card says the plan shows when the harness reports one. The "Briefed with 4 decisions" line: no event or route carries it, so it is left out. "Screen so far": no route serves a capture of the example app from the container, so the card says there is no picture yet. The share of the week (plan, section 13, closing the `lib/limits.mjs` unknown): `lib/limits.mjs` keeps host-side readings in `state/limits/<adapter>.jsonl`, fed by the usage files of v1 lane runs; a container session writes none, and no API route exposes limits. So the status line shows the elapsed time and the tokens of `state.usage` (input plus output, cache left out), as the plan allows.
2. **Criteria are the checklist lines of the ticket body** (`- [x]` and `- [ ]`); the rest of the body is the description. The ticket type has no criteria field and the plan names none. Who ticks a box is the author or the lead editing the body, so a box ticks when the ticket does.
3. **Paths and commands are in the mono chip of the capture**, which departs from `DESIGN.md` (section 3: Geist Mono only for ticket and commit ids). The capture is this lane's reference, and a path or a command is code the reader may copy; ticket ids stay in the grey `id` style.
4. **A policy refusal has its own row** (issue 145, item 4). A `cleared.permission_answered` event with a reject decision, by `policy`, and no `cleared.permission_request` before it comes from two places in the adapter: the `tool_check` deny and a `canUseTool` verdict that is not `ask`. The event carries a request id and a rule, no tool call id and no message, so it cannot be attached to the tool row above it: the row reads "Blocked by the rules: pushing to the base branch." for the five deny rules of plan section 5, and "Blocked by the rules (<rule>)." for a rule the catalog does not know. A policy allow with no request is not shown: the tool row is already there and a line per allowed read would bury the timeline. A request that did precede its answer stays on its tool row, which then says who decided ("Allowed once by you", "Denied by a teammate", "Denied by the rules", "Cancelled when the turn was interrupted"); only an unanswered request shows its three buttons. The other items of issue 145 are not this lane's and stay open.
5. **A `cleared.question` is shown in the timeline with a link to the inbox**, which answers it (lane 10 owns that form). The first user message, attributed to `cleared` (the ticket's prompt), is the ticket card, not a row. Consecutive reads of no request are one row ("Read a.ts and 2 more files").
6. **The stream is read with one listener per AG-UI type**, because the service names each frame by its type and `onmessage` never fires for a named event. When it drops, the page closes it and reopens it after the last seq it has, with a doubling pause up to 10 s, instead of leaving EventSource to retry with the old `?after=`. The model ignores any event whose seq is not above the last one, so a server that replays more than asked adds nothing twice. The browser may only `import type` from `v2/src`, so the 17 names are copied and a test keeps the copy equal to `EVENT_TYPES`.
7. **The screen loads its own stylesheet**, `screens/session.css`, from `mount` (a `<link>` in `<head>`, allowed by `default-src 'self'`), because the shell page links only `style.css`, which lane 6 owns.
8. **The fixture is `fixtures/session.ts`, with a `sessionSource` that stands in for the service's session routes.** It is not wired into `fixtures/source.ts` (lane 6's file), so `CLEARED_V2_APP_SOURCE=fixtures` still serves the tower's thinner sessions on this screen. The tests and the capture script hand `sessionSource` to the app as its `DataSource`. Its data is the capture's, with the tower fixture's ticket (LOCAL-161), title and `npm install date-fns` request, so the two screens tell one story.
9. **Hand over to Codex** is an `aria-disabled` button with its milestone 3 note as title, description and, on click, a status line. Send and Interrupt and the field are disabled once the session is `done`, `stopped` or `failed`.

**Consequences.**
- This entry is the only change outside the lane's files, as the brief asks.
- Carrying the plan needs a content for `TodoWrite` in the cleaned tool input, or a `plan` field in `SessionState`: a change to lane 1's types and lane 4's mapper, so its own small lane. The picture of the example app needs a service route for it. Until then those two cards stay empty states.
- A `cleared.permission_answered` that follows a refused tool call has no tool id; adding one (or the message) to the event would let the refusal sit on its tool row. Not done here: `events.ts` is lane 1's.
- Captures of the visual loop are `/tmp/cleared-captures/j1/session-<width>-<theme>.png`, not committed. The reference was rendered from `/tmp/cleared-reference/session.html` in headless Chromium; the page loads Google Fonts, so the render shows Geist only if that request succeeded.
- Author: Sonnet 5.5 (claude-sonnet-5-5), lane `v2-j1-session-screen`. The plan assigned this lane to Opus 5.5; the session that ran it was Sonnet 5.5.

## 2026-10-21: the inbox screen of milestone 1, against inbox.png (lane 10)

**Decision.** The inbox follows `inbox.png` for layout, sizes and colours. Its content and gestures follow the plan, lane 7's API and lane 8's routes. Every gesture goes through lane 6's forwarding with the signed-in user. The lane's choices:

1. **The grace is the service's, as lane 8 holds it (its choice 3).**
   - "Approve the release" calls `POST /api/tickets/:id/approve` at once, with `requestedAt` and `heads` exactly as the release item shows them.
   - The screen counts down to the `dueAt` of the 202 answer, or 60 seconds when the answer has none. It shows a 4 px ink bar and Undo, which calls `POST /api/tickets/:id/approve/undo`.
   - The plan's acceptance for this lane reads as if the app held the grace. Its test is therefore run against a fixture service that holds the approval as lane 8's does:
     - an Undo within the grace leaves no write;
     - the write after the grace carries the versions shown and the signed-in user;
     - an Undo after the write is refused, and the screen says it came too late.
   - The Undo route is not in `src/api/types.ts`, so its answer is typed in `inbox.ts`. Lane 8 named that follow-up.
   - The grace and its outcome are kept in the tab's `sessionStorage`, so a reload during the grace still shows the bar.
   - After `dueAt` the screen says "Approved by you at HH:MM, landing." until the release leaves the list. It cannot tell whether the service's last checks refused the write (lane 8's `refused` event), because no route says so.
2. **"Send back" moves the ticket to Todo** (`POST /api/tickets/:id/move`, lane 7's choice 2), after one confirmation line, because it starts a new author session. The state name is `Todo`, the ticket store's default, and a test keeps the two equal. A project that renames its Todo state needs the name from the service, and no route gives it in milestone 1.
3. **Issue 145, item 4.**
   - A refusal by the policy never waited for the human. Lane 7's inbox does not list it, and the session screen shows it as a row of its own (lane 9).
   - So the inbox reads no session event. One event stream per session would also run into the browser's limit of six connections per origin.
   - What the inbox handles is a request settled without the person while it is on screen: an interrupt, the session's end, an answer from the session screen, or a restart. The answer route then answers 404, or 409 for a stopped session.
   - The screen then says "This request was settled without you", shows no button, refreshes, and keeps the link to the session, where the refusals are.
   - The live run below reproduced it.
4. **What the API does not carry is left out, not invented.**
   - A handled item has no outcome and no author: the item has a `state` only. "Handled today" therefore says "no longer waits for you".
   - The capture's rolled back card has no carrier in milestone 1. Its plan card belongs to milestone 2.
   - A release carries no file counts, so the change line is the pull request link and the checks.
   - A release carries no screen name, so the heading reads "What changes on screen".
   - Captures are null in milestone 1, so each frame says "No picture of this screen yet." A capture is shown only from a same-origin path, since the page runs under `default-src 'self'`.
5. **A permission** shows:
   - the command in the mono chip of the session screen (lane 9's choice 3; issue 149 is open on it);
   - its description;
   - the policy's reason, with its first letter capitalised and otherwise in the service's English;
   - the session's role and model, and how long it has been paused.
   Deny takes an optional reason. Without one, it sends the catalog's default, since `reject_once` needs a message.
6. **A question**:
   - Its choices are toggle buttons, one or several when `multiSelect`, plus a free answer.
   - The answers are keyed by the question's text. A free answer wins over the choices, and several choices are joined with ", ". That format was not checked against Claude Code: no multiple choice question was run live.
   - A label that ends in "(Recommended)" shows as the team's recommendation and goes back to the harness as written.
   - The question sits on `awaiting-surface`, with the ticket under the 3 × 56 px amber bar (DESIGN.md, section 4).
   - "Send the answer" stays disabled until every question has an answer.
7. **The list and the address.**
   - Releases come first, then permissions, then questions, each oldest first.
   - The address's hash names the item shown, as the tower links to `/inbox#<id>`. Below 1024 px the hash opens the detail as a page of its own, with a back link; Escape goes back to the list.
   - On a phone the captures start in their phone frame.
   - The page polls `/api/inbox` every 10 seconds and reloads after each gesture.
8. **The fixture** is `fixtures/inbox.ts`, with `inboxSource` standing in for the service routes, as `fixtures/session.ts` does. It is not wired into lane 6's `fixtures/source.ts`. So `CLEARED_V2_APP_SOURCE=fixtures` shows the tower fixture's two items on this screen, and that source refuses their gestures with a 404, which the screen reports as a refusal. Its captures are SVG drawings served by the stand-in.

**Consequences.**
- **Captures.**
  - The visual loop is in `/tmp/cleared-captures/j1/inbox-<width>-<theme>.png`, with the permission, question, grace and detail views as extras. None is committed.
  - The reference was rendered from `/tmp/cleared-reference/inbox.html` in headless Chromium as `inbox-reference.png`.
- **The art director's pass** was run once, by Sonnet 5.5 in a fresh session. Taken:
  - the phone detail as a full page;
  - safe-area padding;
  - 44 px targets for the frame switch and the session link;
  - the question on `awaiting-surface`;
  - readable field edges in both themes;
  - "Send the answer" disabled until answered;
  - the grace bar on its own row on a phone;
  - Allow once first when the buttons stack;
  - a hairline above the facts.
  Not taken:
  - "Clearing in 42 s": the screen's verb is "Approve", as the capture's button says.
  - The upward shadow shown only when more is below: the shadow was removed instead.
- `env(safe-area-inset-bottom)` stays 0 until the page's viewport meta says `viewport-fit=cover`. That meta is in lane 6's `server.ts`.
- **Live run, 2026-10-21 from 23:51 to 23:54 (Europe/Paris).**
  - **Setup.** This worktree's service ran on `127.0.0.1:8795` and its app on `8796`. `ss -ltn` was checked before and after. The orchestrator's proof service on 8791 was not called or changed; the value of `CLEARED_CLAUDE_CREDENTIALS` (a path) was taken from its process environment.
  - **What could not leave the server.** The run had its own state directory. The example repository, cloned bare on the server, was the only remote. `gh` was a stub that refuses, and there was no broker socket. So nothing could reach GitHub or the lock.
  - **Models and login.** `claude-haiku-5-5` for both roles, and the login named by `CLEARED_CLAUDE_CREDENTIALS`. The file's content was never read or printed.
  - **Ticket LOCAL-1.**
    - The author asked to run `npm install date-fns 2>&1; echo "exit=$?"` (rule `shell.compound`), and the inbox showed the request.
    - The turn was interrupted through the API, then "Allow once" was clicked. The answer route answered 404, and the screen said the request was settled without the person.
    - After a message, the new request was denied from the inbox with a typed reason: 200.
    - Lane 8's approve and Undo routes answered 409 through the forwarding: "the ticket is not waiting for the owner (it is in “In Progress”)" and "nothing is held for this ticket".
  - **Ticket LOCAL-2** checked the fixes the run led to: the list shows an answered request as handled at once, and the shell's count follows.
  - **Found, for lane 7 or lane 2.** Stopping the service with SIGTERM leaves a live session's containers, networks and config volume in place. The run removed them, two sessions, by their labels (`cleared.dev=v2` and the session id), and the config volume of the first session too.
- **Not run live.**
  - A release item. Publish was blocked on purpose: a release needs a pull request on the forge and the lock's request.
  - A question, and "Always in this project".
  These run against the fixture service only.
- This entry is the only change outside the lane's files.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j1-inbox-screen`.

## 2026-10-22: Fable 5.1 used once to plan milestone 2

**Decision.** Fable 5.1 was used once, on 2026-10-22, to plan milestone 2: the split into lanes and waves, the lead's tools and policy, the context cycle, the plan model and its runner's rules, and the notification kinds. Reason: strong planning, the case the "model choice per lane" entry allows. The planning session was opened by the orchestrator's brief, which named the model; brief rule 10 asks for the owner's explicit request for any use of Fable, and the orchestrator confirms that request, with its date, in its next report and adds it here. It wrote no code and reviewed nothing.

**Consequences.**
- The plan is [milestone-2-plan.md](milestone-2-plan.md). Its lanes are authored by Opus 5.5 or Haiku 5.5 and reviewed by a different model, as the model rule says.
- The decisions the plan takes (its section 2) are copied into this log, with their consequences, when the lane that implements each one lands.

## 2026-10-22: the contracts of milestone 2 (lane 1)

**Decision.** Lane `v2-j2-contracts` fixes what the other lanes of milestone 2 code against: `HostTool` and `StartInput.tools`, the new custom events and `SessionState.context`, the lead and plan API types and routes, the lead's tool contract (`src/lead/contract.ts`), the policy rows of decision 10 and of section 3.3, the `lead` and `notify` module slots (decision 14), the fake adapter's scripted lead, the lead fixture, and the empty `scripts/doctor-lead.ts`. The lane's choices:

1. **Compound commands (decision 10).** `parseList` splits the text at `&&`, `||`, `;` and `|` outside quotes, and each part is read by milestone 1's `parseCommand`, unchanged.
   - Output redirections are taken out of a part: `>`, `>>`, `N>`, `N>>`, `&>`, `&>>` with one word as the target, and the duplications `N>&M` (`2>&1`), which write no file.
   - Still refused, so asked as `shell.compound`: a lone `&`, `|&`, `>|`, `>&file`, an empty part, an input redirection, a here-document, a newline, `$(`, a backtick.
   - A target gets the verdict a `Write` of that path, without content, gets. Only `edit.workdir` keeps the command allowed. A deny stays a deny: a reviewer's redirection is `reviewer.edit`, `> .env` is `secret.read`. An ask keeps its own rule: `scripts.change` for `package.json`, `install.package` for the lock file. Any other target asks as `shell.compound`.
   - `/dev/null` is outside the workdir, so `2>/dev/null` asks, as decision 10 says. Allowing it (writing there changes nothing, and it is common) is proposed to the owner in the pull request, not decided here.
   - The first part that is not allowed gives the verdict. It keeps its rule when it has one of its own (`net.undeclared`, `install.package`, `delete.outside_ticket`). A part that only reaches `default` is reported as `shell.compound`, with a reason that names the part.
   - A learned command counts as allowed on its own.
   - Milestone 1 rows that changed, in `test/session/policy.test.ts`:
     - `cat a > b` asked; it allows.
     - `npm run test; curl https://example.invalid` asked as `shell.compound`; it asks as `net.undeclared`.
     - `npm run test | tee log` still asks as `shell.compound`, and the reason names `tee`.
     - `npm test 2>err` and `npm test &>out` left the parser-refusal list; they allow.
     - "A learned entry never allows a compound command" became "allows it part by part".
2. **The lead's rows (section 3.3)** run after milestone 1's denies and before the compound check. `shell.compound_safe` never applies to the lead.
   - A git read (`git log *`, `git show *`, `git diff *`, `git status`, `git branch --show-current`, milestone 1's conditions on the words) may stand alone, as the acceptance's `git log --oneline` does, or be piped into `head`.
   - `ls`, `grep` and `find` must be piped into `head`.
   - `head -n N file` alone is allowed: head is the lead's reader and caps itself.
   - `head` is `-n N` or `-nN`, with N from 1 to 400, and nothing else: a standalone head reads exactly one file, and the piped head reads none. A second count, a byte count or several files would lift the cap, so they deny.
   - Any redirection, a duplication included, denies as `lead.command`.
   - `git commit`, `push`, `checkout` or `add` anywhere in the text is `lead.edit`.
   - A `Read` with a limit but outside the workdir goes on to the role-free rows: it asks as `default`.
3. **Host tools.**
   - The schema subset is the `JsonSchema` type of `session/contract.ts`: object (`properties`, `required`), array (`items`), string (`enum`), number and boolean, each with an optional `description`.
   - A handler refuses by throwing `HostToolRefused`. Its message is the answer the model reads and the event's `message`. Any other error is `failed`, and the event carries a generic line, never the error.
   - `answer_question.answers` is a list of `{ question, answer }`, since the subset has no map.
   - The outputs are typed (`LeadToolOutput`).
   - `bindLeadTools` joins handlers to the contract by name and cuts the answers of `state` (2 KB) and of `ticket`, `session` and `search_memory` (8 KB) with `capAnswer`. The cut is in UTF-8 bytes, on a character boundary, with a last line `[cleared: N bytes cut]`.
   - `propose_plan.goal` is the id the goal turn gives the lead; lane 5 chooses its form.
4. **Events.**
   - `cleared.rate_limit.resetsAt` is an ISO time or null.
   - `cleared.context_usage` carries an optional `rawMaxTokens`, which lane 4's doctor names.
   - The fake's `STATE_DELTA` for the context is an `add` on `/context`.
5. **API.**
   - `PlanItemInbox` is in `InboxItem`, with `ticket` set to `LEAD_TICKET`.
   - `LeadState` adds `highestPercent`, beyond section 7.1's list, because step 8 of the proof reads the highest share on the lead screen. Its `phase` is one of `starting`, `idle`, `working`, `refreshing` and `down`; `down` is the danger pill.
   - `LeadMessage` carries an optional `question` (with its state), a `planId` and the `generation` of a refresh line.
   - The lead stream has three frames, written by `leadFrame`. A `message` frame carries the thread seq as its id, which a reconnect sends back. A `state` frame and a `plan` frame carry the whole value and no id.
   - `MILESTONE_2_ROUTES` lists the lead module's routes.
   - `NotificationStatus` keeps v1's reasons without the passkey one (`off`, `insecure`, `no_subject`, `store`). The three notification routes are typed in `NotificationRoutes` and are not in `API_ROUTES`, since they are the app's own (lane 3).
6. **The fake adapter** plays `hostCall`, `context` and `question` steps.
   - Its `run` now awaits the host tools, so after `await start()`, `answer()` or `send()` every call is answered.
   - An interrupt or a stop that comes while a host call is answered ends the turn there: the call writes nothing after it, and the next message starts the next turn.
   - After a `context` step the fake yields once, so a reader sees the measure before the turn goes on and can interrupt it there, as lane 5's threshold does.
   - A question is settled by `cleared.answered`, as the Claude Code mapper does.
   - `exampleLeadScript` and `examplePlanInput` are the scripted lead of lanes 5, 7 and 11.
7. **The lead fixture** (`app/fixtures/lead.ts`) plays that script into a store, with host tools that record what lanes 5 and 7 will store. The thread, the plan, the commitments and the context are read back from it.
   - The share ends at 45 % (the acceptance), not the capture's 31 %.
   - `totals.minutes` is 120, the critical path 1, 2, 3 with two at a time, as section 5.2 says; the capture's "2 h 15" is the sum.
   - The estimates and week shares are the capture's numbers, with 23 samples.
   - The content is the guestbook's, with the capture's shape: 2 after 1, 3 after 2, two fast lane items.
   - A refresh line, the handover of generation 2 and one done commitment are seeded, so the memory panel has both states.
   - The fixture source serves the lead's session by its id (detail and events). It is left out of `/api/sessions`, so the tower keeps its four sessions.

**Consequences.**
- **Edits outside the lane's files**, each the smallest the new types needed:
  - `test/flow/api.test.ts` line 45: the flow does not declare `MILESTONE_2_ROUTES`.
  - `test/flow/modules.test.ts` lines 32 and 38: eight module names.
  - `app/public/screens/tower.ts`, `need()` and its filter: a plan item is no need until lane 9 draws the plan card.
  - `app/public/screens/inbox.ts`: a local type and the `listed` filter leave plan items out of the list until lane 10.
  - `app/fixtures/inbox.ts` line 194: the answer route matches permissions and questions only.
- **Interface lane: no**, and the lane has no screen of its own. It did touch the tower and the inbox, so both were captured in fixtures mode at 1440, 1280, 768 and 390, light and dark, as `/tmp/cleared-captures/j2/{tower,inbox}-<width>-<theme>.png`. They render as before, without the plan item. The shell's inbox count (`app/public/app.ts`, lane 3's) counts every waiting item, so in fixtures mode it says 3 while the inbox lists 2. The count is right for milestone 2, since the plan waits for the owner; lane 10's list catches up with it.
- **Open on the answer cap (section 4.1).** The policy does not cap a `Grep` in content mode or a git read that stands alone. Whether and where Claude Code cuts a command's output was not measured here. Lanes 4 and 5 measure it against the plan's margin of about 4 000 tokens per answer.
- **Not done here.**
  - Issue 145, item 4 (a tool id on a policy refusal's `cleared.permission_answered`) needs lane 4's mapper.
  - Issue 132's lexical path checks apply to redirection targets too: a symlink in the workdir that points outside is not resolved.
  - A learned entry recorded from a compound request keeps the whole text as its pattern, so it never matches a part. A whole-text match belongs to decision 11 (lane 2) if it is wanted.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j2-contracts`.

## 2026-10-22: the app's notifications, the Plans tab and the lead stub (milestone 2, lane 3)

**Decision.**
1. **The routes.** `GET /api/notifications`, `POST /api/notifications/subscribe` and `POST /api/notifications/unsubscribe` are the app's own (`v2/app/src/notifications.ts`), not forwarded to the service.
   - They need the password session. A write also needs the anti-forgery token and the app's origin, as every write does. There is no passkey (decisions log, "app login by password, no passkeys").
   - The subscriptions go to `lib/notify/store.mjs`'s private directory, the one v1 used, through `notifyStore` and `validSubscription` unchanged. That gives the 0700 rule, the refusal of a looser directory, the ten devices with the oldest pushed out, and the known push hosts plus `CLEARED_NOTIFY_PUSH_HOSTS`.
   - The status answers `{ available, reason, publicKey, devices }`. `reason` is `off`, `insecure`, `no_subject`, `config` or `store`; v1's `no_passkey` is gone.
   - A device is stored as its user and platform only (`alex · iPhone`), never the full user agent.
2. **The settings are v1's.** They are read through `notifySettings` of `lib/notify/contract.mjs`:
   - `[notify] adapters`, `secrets_dir` and `vapid_subject`, from the project's `agents.conf` (`CLEARED_CONF`, else `<CLEARED_REPO>/.cleared/agents.conf`, parsed with `parseSections` of `v2/src/approval/conf.ts`);
   - `CLEARED_NOTIFY_LINK_BASE` and `CLEARED_NOTIFY_PUSH_HOSTS`, from the app's environment.

   `lib/notify` is loaded on the first request, not when the app starts. `lib/conf.mjs`, which `store.mjs` imports, copies every `CLEARED_*` variable to `ORCH_*` when it is imported, and the other lanes' app tests never touch a notification directory this way. The settings are read once: the app is restarted after a change.
3. **Insecure** means the browser's address is neither `https` nor `http` on `127.0.0.1`, `localhost` or `[::1]`. The address is `CLEARED_V2_APP_ORIGIN` when the request names its host, else the app's own. A subscribe from such an address is refused with 409.
4. **`v2/app/main.ts` is not edited.** It is not in the lane's files. `createAppHandler` builds the notifications from `process.env` when it is given none, and does so lazily.
5. **The button** is a bell left of the clock, a `<details>` menu like the signed-in person's. It is hidden when the status cannot be read or the service sends no Web Push. Otherwise its menu says:
   - the state for this device;
   - how many devices are told;
   - either the button that turns it on or off, or why there is none: iPhone or iPad outside the Home Screen, a browser without push, notifications blocked, an insecure address, no subject, unreadable settings, a refused directory.

   The bell is filled when this device is on. The menu hangs from the right of the header's group, so it stays on screen at 390 px. Its view is a pure function (`notifyView`, `renderNotifyMenu` in `v2/app/public/notify.ts`), tested under Node. A failed confirmation notification on the device does not undo a subscription.
6. **Installable.** `manifest.webmanifest`, `sw.js` and the three icons are served without a session, and every page links the manifest and the Apple icon. The icons are v1's (`app/public/icons/`), byte for byte. The worker is v1's, adapted: it shows what is pushed, opens only addresses of the app, and caches nothing. A `.png` is served only for those three names.
7. **The guard** leaves out exactly `v2/app/public/icons/{icon-192,icon-512,apple-touch-icon}.png`, as it does the fonts, and says how many. A copy of an icon under another name (`icons/icon-193.png`) and one in `fonts/` were planted on 2026-10-22 and refused.
8. **The Plans tab** comes after Tickets, as in the capture, and opens `/lead`. `/lead` and `/plans/<id>` mount the `lead` screen (`'lead'` added to `SCREENS` in `v2/app/src/catalog.ts`).
9. **The lead stub.** It shows the lead card, a sentence saying the lead does not run yet, and the draft in a field the person can copy. It has no Send button, because nothing on it can send.
10. **The tower bar.** New goal opens `/lead?goal=1&draft=<text>` and Ask the lead opens `/lead?draft=<text>`, with the bar's title, then its description when one is written, as the draft. The draft is cut at 2000 characters, so a long description cannot make the address exceed the server's header limit; the stub reads at most 2000. The two keys `later_goal` and `later_lead` are removed from `tower.{en,fr}.json`.

**Consequences.**
- **The headless check.** Headless Chromium 1243 and Chrome on this server refuse a push registration ("Registration failed - permission denied", even with the permission granted), checked on 2026-10-22. So `v2/app/test/notify/browser.test.ts` replaces the page's `PushManager` with an init script. The fake subscription points at `https://push.example.invalid/send/<uuid>`, with real-shaped keys, and is accepted only because the test sets `CLEARED_NOTIFY_PUSH_HOSTS=push.example.invalid`. The service worker, the permission and the button are the browser's own. The test runs only with `CLEARED_V2_PLAYWRIGHT` (the folder of an installed `playwright-core`) and optionally `CLEARED_V2_CHROME`; CI skips it.
- **For lane 6.** No browser on this server holds a real push subscription, so `npm run notify -- test` cannot deliver to "the browser subscribed in lane 3's loopback check". Lane 6 can either:
  - post to a fake push endpoint it serves itself; `pushHostAllowed` refuses a port, so that needs `https` on 443, which is not allowed here, or a test transport injected into `webpushAdapter`;
  - or wait for the owner's own browser over the https address of plan question 2.
- **Two readers of `[notify]`.** The app reads `[notify]` from the working tree's `agents.conf`, as the approval does. The plan has lane 6's dispatcher read it at the base branch. If the two differ on `secrets_dir` or `vapid_subject`, the app and the dispatcher would use different stores or subjects. Lane 6 should read the same file, or say which one wins.
- **Edits outside the plan's file list but inside the wave's folders:**
  - `v2/app/src/catalog.ts`: `'lead'` in `SCREENS`, without which `/messages/lead.json` answers 404 and the catalog test fails;
  - `v2/app/public/style.css`: the bell, its menu and the stub.
- **The art director's pass** was run once, by Sonnet 5.5 in a fresh session, on the header at 1440 and 390 in both themes. Taken:
  - the avatar's target is 44 px on a phone, with its circle kept at 30 px through a transparent border;
  - on a phone, the menu spans the 16 px gutters under the header's first row;
  - an 18 px bell, so the filled "on" state reads;
  - both menu buttons are 36 px on a computer;
  - an open state on the bell;
  - `text-wrap: pretty` in the menu.

  Not taken:
  - A static header on the phone, and hiding the clock there: both are milestone 1's shell, and the clock's place is the capture's.
  - Scroll padding on the tab strip: the strip is milestone 1's, and lane 9 adds to the header next.
  - The menu's radius and shadow: they are the existing `.menu` of the signed-in person's menu, kept the same.
  - Renaming the stub's heading "Plans": the screen is the lead and plan screen, and lane 8 owns its words.
- **Captures** are in `/tmp/cleared-captures/j2/`, none committed:
  - the tower, the lead stub and a plan page at 1440, 1280, 768 and 390, light and dark, with no horizontal overflow;
  - the menu off, on, and with the iPhone note.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j2-app-shell-notify`.

## 2026-10-22: the landing follow-through, the event bus and the policy per evaluation (milestone 2, lane 2)

**Decision.** Lane `v2-j2-flow-landing` implements decisions 11 and 12 of the [milestone 2 plan](milestone-2-plan.md) in `v2/src/flow/` and `v2/src/session/adapters/index.ts`, with these choices made by the lane:

1. **The lock's exit codes, as the flow sees them.** The plan speaks in merge-pr.sh's codes (3 queued, 6 refused). The flow runs `release-request.mjs`, and the broker maps those codes on the way (`serve/release-broker.mjs` line 139, `release-request.mjs` line 54). So `effects.mergeRelease` reads the client's exit:
   - 0 is `merged`;
   - 5 is `queued` (merge-pr.sh's 3 or 5, or the broker busy with another release);
   - 1 is `refused` for good (merge-pr.sh's 6, or a request the broker rejects);
   - anything else is `unavailable`, asked again like `queued`, and so is a call that does not answer within 15 minutes.
2. **The retries.** `request_release <ticket> <pr>` without `--ask`, with the release item's announcement on stdin (merge-pr.sh refuses an agreed change without one) and `ORCH_FROM_QUEUE=1`, so that merge-pr.sh answers "not now" without writing v1's `merge-queue/` file, which no v1 wake reads any more. Lane 8's approval writer asks the lock first, after the grace. The flow asks one interval (`CLEARED_V2_MERGE_RETRY_SECONDS`, 60) after its tick first sees the ticket in the go state, then one interval after each answer. It never runs two merges of one release at once, and it checks the ledger for the merge before every call. A refusal is noted on the ticket, which goes back to Todo (`ticket_put_back`, reason `merge_refused`): lane 7 counts a refused merge as a put back.
3. **What "merged" and "healthy" are read from.** The plan names a `release_health_ok` row; `lib/release.mjs` writes none. The lane reads:
   - the merge: merge-pr.sh's `merged_by_script` row in v1's `events` table (by ticket, `value` = the pull request, at or after the second of the human's move to go; times are compared as instants, since merge-pr.sh writes seconds and ask-validation.sh nanoseconds);
   - the verdict: the status of lib/release.mjs's `releases` row, the watch's own state, with the times and words of its `events` rows. `rollback_pushed` is `rolled_back`. `complete` is `release_landed` (`health: 'healthy'`), or `health: 'unwatched'` with `release_health_unconfigured`, when the project has no health check. `complete` after a `release_health_failing` (no automatic rollback), `failed` (a rollback the watch could not make, a monitor that stopped), or no row with `release_watch_failed` (the watch never started) is a 14th event, `release_unhealthy`: the change is live, nothing was reverted, the ticket gets a note and is not moved to Done by the flow. The owner decides.
   The `watch` step opens at the merge's time and closes at the verdict's, on the session that holds the `approval` step; it is also the persistent marker that lets a new engine go on where the last one stopped, so no table is added. The watch closes only after the ticket's move: Done for a landed release, Todo for a rolled back one, the note for an unhealthy one. A read of the ticket or a move that fails leaves the watch open and the next tick makes it again; only a ticket the store says is gone closes the watch without a move. The events are said once, after the move (review rounds 1 and 2 of PR 161). A refused merge whose put back fails is put back again without asking the lock again. `#putBack` says `ticket_put_back` only when the move was made. One gap remains: a service that dies between a rollback's move to Todo and the step's write loses the `rolled_back` event, since a ticket in Todo is no longer followed.
4. **Done.** merge-pr.sh moves the card to Done right after the merge when the user's agreement was the status (`merge-pr.sh` lines 320 to 331), before the watch says anything. That was read, not run: no real merge was made on the example repository. So the flow also follows a ticket in Done whose release was approved within the last two days, and a landed ticket still in go is moved to Done by the flow.
5. **The event bus.** `FlowEngine.subscribe(listener)` returns the function that stops it. An event is said after its write (the store, the inbox, the ticket move). A listener that throws or rejects is logged by its error class and dropped. Every event carries `at`, `project`, `ticket`, and the ids that apply (session, inbox item, request, pull request, user). `ticket_put_back` is said for every move back to Todo, with one of thirteen reasons, after a rollback too, where `rolled_back` comes first. `release_approved` is said only for a human's move to go made since the request, never when a person sends the release back; it is found in the ticket's history, since the lock may have merged and moved the ticket to Done before the tick sees it in go. `session_stopped` is said for a stopped or failed session, not a session done.
6. **The restart recovery** is `FlowEngine.recover()`, which the runtime runs once after building the engine:
   - each author or reviewer session of the project still marked live, and not live in this process, gets a `RUN_ERROR` with code `restart` and the phase `stopped`, and its inbox items are handled one by one (so this still holds once lane 7 narrows `handleRequests`);
   - each ticket left In Progress or In Review that this engine does not run goes back to Todo with a note.
   The lead's sessions are left to the lead engine.
7. **`start(ticket, by, origin?)`.** `origin` is `{ plan, item, note? }`: the comment reads "Started by the lead for plan P (item N), approved by U.", the `note` is added to the author's prompt, for the runner's second start of a ticket put back, and `ticket_started` carries the origin.
8. **The policy per evaluation.** `FlowEngine.policyFor(input)` returns the session's policy with `learned` read from `policy_rules` now and `ticketFiles` from the edits of the ticket's sessions whose result was not an error (a refused edit of a guarded file changed nothing), relative to the workdir, read incrementally per session. `AdapterDeps` gains `policy`, which `adapters/index.ts` passes to the Claude Code adapter. The runtime builds the adapters before the engine, so it passes a function that asks the engine once it exists and gives the start policy before. The lead's policy is returned as it started.
9. **Issue 157, item 3.** The tick reads a waiting release's checks at most once a minute per release, and logs a failure by its error class instead of dropping it. That `setReleaseChecks` ignores the item's state is `v2/src/inbox/store.ts`, not this lane's file.

**Consequences.**
- `FlowConfig` gains `mergeRetryMs` (`CLEARED_V2_MERGE_RETRY_SECONDS`, a positive whole number, 60 by default). `FlowDeps.store` gains `db`: the flow reads v1's `events` and `releases` tables and the inbox's release items with its own read-only queries. A ledger without the v1 tables reads as "nothing happened yet".
- **A new allow rule, `delete.ticket`, in `v2/src/session/policy.ts`** (lane 1's file, edited at the orchestrator's request after review round 1 of PR 161). An author's `rm` of files its ticket changed is allowed: plain `rm`, `-f` or `--force` and `--` at most, every operand inside the workdir and in `ticketFiles`. It comes after the deny rules, the safe commands and the learned answers, in the verdict of one simple command (`simple()`, lane 1's since the merge of its pull request 160), so a compound list whose every part is allowed on its own (decision 10) may hold it. Anything else still asks: `-r` and every other option, a file the ticket did not change, one such file among ticket files, a path outside the workdir, a glob. A reviewer never gets it. The milestone 1 row "rm of a ticket file asks as default" in `v2/test/session/policy.test.ts` now expects `allow delete.ticket`, and an `rm -r` row was added.
- A ticket the milestone 1 proof landed within the last two days is read once by the first tick of the new service: its `watch` step and its `release_merged` and `release_landed` events are written then.
- `ORCH_FROM_QUEUE` reaches merge-pr.sh only when the service calls the broker as the service account (`serve/release-broker.mjs` line 134, `allow_shared_uid`, as in milestone 1's lane 8 entry). Under another account merge-pr.sh writes v1's `merge-queue/` file again, which is harmless but unread: the proof checks the account.
- The containers, networks and config volumes of the sessions a stopped service leaves behind are not removed by the recovery: the adapter's runtime (lane 4's files) owns them. Still open, as the inbox screen's entry says.
- **The engine is built on the first API request**, as in milestone 1 (`runtime.ts` builds it lazily, and a module's `provide` has no registry). So after a restart, the recovery, the idle stop and the landing tick start only when the app first asks the service something. A service restarted at night with no browser open does nothing until then. Lane 5's module, which subscribes to the flow at start, needs the engine built at start too: a follow-up for it.
- The real merge through the lock, against GitHub, was not run by this lane: it is outward facing, and the milestone proof runs it.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j2-flow-landing`.

## 2026-10-22: the v2 notification dispatcher (milestone 2, lane 6)

**Decision.** Lane `v2-j2-notify` implements section 6 of the [milestone 2 plan](milestone-2-plan.md): the dispatcher in `v2/src/notify/`, the `notify` module, `npm run notify -- test`, the kinds `permission` and `plan` in `lib/notify/contract.mjs` and `lib/i18n/{en,fr}.json`, and a v2 section in [notifications.md](../notifications.md). The lane's choices:

1. **lib/notify runs in a child process.** Its import is not free of side effects: `lib/conf.mjs`, which `contract.mjs` imports, copies every `CLEARED_*` variable of the process to `ORCH_*`. So, as the plan says for that case, the service never imports it.
   - `v2/src/cli/notify.ts` has three commands. `test` is the person's. `settings` and `send` are the dispatcher's: `send` reads the facts of each message on stdin, renders them with `render` and prints, per adapter, `sent`, `failed` with its short code, or `abandoned` at the deadline.
   - The child refuses a message the dispatcher would not make: an unknown kind (`blocked` included), a link that is not `/`, `/inbox`, `/lead` with an item after `#`, a group of free text, a `from` other than `lead`.
   - `isQuiet` is ported to TypeScript (eight lines). Everything else of the rules comes from the child: `URGENT` and the new `URGENCY` list are printed by `settings`.
   - The settings are read only when something is to be sent, and kept five minutes. A quiet night starts no process.
2. **The sources are the inbox and v1's `events` table, not `FlowEngine.subscribe`.** This departs from the plan's "one event bus" (section 10).
   - The flow's engine is built on the first request to the API (lane 2's entry), and nothing outside `flow/runtime.ts` can tell when it exists. A notify module that waits for it would miss a rollback after a night restart with no browser open.
   - What waits for a person is polled from the inbox (`InboxStore.list()`, whose constructor writes nothing, unlike the engine's).
   - Rollbacks and the release watch's failures are read after a cursor from the `events` rows that `lib/release.mjs` writes and the flow itself reads for `rolled_back` (`flow/ledger.ts`): `rollback_pushed`, `prod_revert`, and the six failure kinds v1 already notified.
   - `release_unhealthy` is therefore not mapped: the rows it is built from are.
   - If the bus is wanted later, the one-line change is a getter or an `onEngine` hook in `v2/src/flow/runtime.ts`, not this lane's file.
   - The same lazy engine has a cost here: after a restart, the requests a stopped session left waiting are handled (`handleRequests('system')`) only when the engine is built. Until the first request to the API, the dispatcher sees them waiting and may send one that nobody can answer any more. The same hook would let the module wait for that pass.
3. **The settings file is the app's.** Both read `CLEARED_CONF`, else `<CLEARED_REPO>/.cleared/agents.conf`, with `parseSections`, so `secrets_dir` and `vapid_subject` cannot differ (lane 3's open point). A test subscribes through the app's `notificationsFrom` and has the dispatcher's child find that subscription. The plan's "at the base branch" holds as far as the service's own checkout of the project is on the base branch.
4. **Links, groups and titles.**
   - Links: `/inbox#<item id, encoded>` for approval, permission and a team's question; `/lead` for a plan and the lead's question; `/inbox` for a rollback; `/` for health. The child sets `url` from `CLEARED_NOTIFY_LINK_BASE` and the link, in place of v1's `#ticket=` porthole.
   - The lead's items (`LEAD_TICKET`) have no ticket in the message, so the subject is never "lead · …". Their group is `lead`, so a plan and a lead question are one notification per window.
   - `render` takes a new fact, `from: 'lead'`, which gives a question the sentences "The lead asks you a question" and "Open the lead to answer." v1 never passes it.
   - The title is a release's (the inbox item) or a plan's; a rollback's is the `releases` row's, as v1. A permission and a question carry none: the module has no ticket store, and the ticket's identifier is said.
5. **Where it is recorded.**
   - The queue is `v2_notify_queue`; its row `cursor` holds the last `event_id` read, and its absence is the first run. v1's `notify_queue` and `notify_state` are left to `lib/notify.mjs`.
   - Each delivery is a `notification_sent` row in v1's `events` table and each failure a `notification_failed` row, the shapes of v1. The approval module creates that table at every start (lane 8's `RUNS_TABLES`), and `npm run notify -- test` applies the same statements before writing its row.
   - A row that cannot be written is said by its kind and changes nothing.
   - Keys are the inbox item's id, `rollback:<event_id>` or `health:<event_id>`, so a restarted service sends nothing twice.
6. **Health from other modules.** `reportHealth(db, { code, ticket?, at? })` in `v2/src/notify/queue.ts` queues a health problem. Two codes are added to `HEALTH_CODES` with their sentences: `lead_start_failed` (lane 5) and `week_stop` (lane 7). Nothing calls it yet.
7. **The module** starts the dispatcher in `provide` when `CLEARED_V2_PROJECT` is set: a tick at once (the first run, which sends nothing and starts no process), then every 30 seconds, the timer unreferenced, a tick never over another one.
8. **`lib/notify/contract.mjs` stays `.mjs`, an exception to "converted when touched"**, as the plan foresaw: v1's `lib/notify.mjs`, `app/lib/notifications.mjs` and `test/notify.test.mjs` import it until milestone 4 removes them. Its changes are additive: two kinds at the end of `KINDS`, `URGENCY`, two health codes, the `from` fact. v1's 39 tests in `test/notify.test.mjs` pass unchanged, and v1's own dispatcher never makes the new kinds.

**Consequences.**
- A project whose `agents.conf` lists `[notify] events` itself gets neither `permission` nor `plan` until it adds them; one that lists none gets every kind. `lib/conf.mjs`'s v1 default list is unchanged, since v1 never makes them.
- **Edit outside the lane's files:** `v2/test/modules/registry.test.ts` (lane 1's), lines 6 and 21. It asserted that the `notify` stub is empty, which filling the module ends. The import and the `notify` entry of that loop are removed; `lead` is still checked.
- **The real check** (review round 1 of PR 166) was delivered on this server on 2026-10-22, at 04:27.
  - The setup was Google Chrome, headed under `xvfb-run`, driven by Playwright with a persistent profile, and lane 3's app on `http://127.0.0.1:18792`, a free port, with a temporary `agents.conf`, a temporary 0700 private directory and a temporary user. The app already on 8792 could not be used: no password for it was at hand, and its store may hold subscriptions of the owner's devices.
  - Signed in, then the bell's "Turn on notifications" gave a subscription on `fcm.googleapis.com`.
  - `npm run notify -- test` answered `webpush: sent`, and the page's service worker showed the notification about one second later.
  - What blocked lane 3's attempt: Playwright's default flags. With `--disable-background-networking`, `--disable-component-update` and `--disable-sync`, as in a plain `launch()`, Chromium 1243 and Chrome both answer "Registration failed - permission denied", headed or not.
  - The temporary app, profile and directory were removed after the run.
- **Two rules changed in review round 1:**
  - An occurrence that came while no adapter was ready now waits, not counted as a try, until a device can be told or its day ends. v1 dropped it as `undelivered`, so an approval that waited while no device was subscribed was never told.
  - The folded rows are finished only when the chosen notification is sent. Behind one given up after three tries, they are told in their turn.
- **Interface lane: no.** No file of the app was touched, so there is no capture.
- Issue 146 (the flaky VAPID test) is in `test/notify.test.mjs`, v1's, not this lane's file: still open.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j2-notify`.
