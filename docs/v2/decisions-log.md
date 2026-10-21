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
2. **The ticket checkout is a clone of the service's project checkout, made with `--no-hardlinks`.** It is not a linked worktree and has no alternates, because it is mounted alone in the container and the host paths those point to are not. `origin` is set back to the forge's address. The base it started from is kept as `refs/cleared/base`, which the runner's hook diffs against. A checkout already there on its branch is reused as it is.
3. **No git command runs in the ticket checkout once a session has used it.** The session can write its `.git` folder: hooks, `core.fsmonitor`, `url.*.insteadOf`, a push URL. Git run there by the host would execute what the session planted, or send the credential where the session chose. So publish fetches the branch out of `<workdir>/.git` into `refs/cleared/publish/<branch>` of the project checkout, then reads, guards and pushes from there. A `.git` that is a file or a link, a `commondir` or an `alternates` file is refused, because each would make that fetch read another repository. A test plants hooks and an fsmonitor in the ticket checkout, and none of them runs.
4. **The pull request is not a draft.** `merge-pr.sh` check 1 refuses a draft. Its title is the first commit's subject. Its body is the session's report, cleaned by `lib/pr-body.mjs`, then the list of commits; the report is left out when the guard refuses it, as in `push-lane.sh`. An open pull request of the branch is reused. `gh` gets `--repo`, `--base` and `--head` explicitly.
5. **The guard fails closed.** Publish runs `lib/guard/codex-guard.mjs --strict` on the commit messages and the added lines, with the lists the project commits at `origin/<base>`. When the project commits no `.cleared/agents.conf` or names no `[guard] terms` or `allowed` list, nothing leaves, as with v1's `guard_list`.
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
- **Publish takes the forge's environments from `lib/forge.mjs`** (`forgeEnv` for git, `forgeGhEnv` for gh) in a child process, unless the caller passes them. Only the ambient case was run here; the GitHub App path was not run in this lane.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j1-workspace-memory`.
