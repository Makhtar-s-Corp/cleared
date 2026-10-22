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

## 2026-10-22: the lead engine, its thread, its commitments and its context cycle (milestone 2, lane 5)

**Decision.** Lane `v2-j2-lead-core` implements decisions 3, 4 and 8 and section 4 of the [milestone 2 plan](milestone-2-plan.md) in `v2/src/lead/` (`config`, `store`, `engine`, `prompts`, `tools`, `routes`, `briefing`) and `v2/src/modules/lead.ts`, on the fake adapter. The lane's choices:

1. **One turn at a time.** The engine sends a turn only after the previous `RUN_FINISHED`, because the real adapter folds a message sent mid turn into the running turn. Owner lines come first, then the flow's events. A line the lead must answer (an owner's message or goal, or a line the service adds such as "Plan P approved") has a `turn` state in `lead_messages`: `queued`, `sent`, `done`. A line still `sent` when its generation ends is sent again to the next generation, saying it has no answer yet. So a refresh or a restart in the middle of an owner turn loses nothing.
2. **The reply** of an owner turn is the turn's last assistant text, cleaned. The texts of opening, event and handover turns stay on the session. Only `tell_owner` writes to the thread from those turns, and it is refused in a turn the owner started.
3. **The opening turn.** The adapter sends `StartInput.prompt` as the first turn, so each generation starts with a short "Ready." turn. That turn also gives the first measure of the briefing's share. The share of the opening turn never triggers a refresh: the handover point counts only once the generation has served a turn. Otherwise a threshold below the base share (the doctor's 5 %) would refresh in a loop. A harness that plays no opening turn (lane 1's `exampleLeadScript`) is ready at its first measure.
4. **When the measure comes.** The runner measures after a turn's result. So the end of a turn waits up to 2 seconds for that measure before the next turn is sent. If the measure arrives sooner, the wait ends there. This keeps the handover at the end of the turn that crossed 40 %. A measure at or above the threshold during a turn interrupts the turn at once, in the same handler. A handover turn is never interrupted.
5. **Machine handover.** The service writes the handover itself in three cases: the lead does not call `handover` in the turn that asked for it, the generation fails (`RUN_ERROR`, the stream ends), or the service restarted. A generation that fails before serving a turn is replaced only after the 60-second retry delay, so a session that dies at once cannot loop. A generation that cannot start leaves the lead `down`; a tick starts it later.
6. **The briefing** (`CLAUDE.md` in the lead's workdir) puts the lead's rules first, as the only instructions. Then, under lib/memory's reference line and quoted line by line, come: the open commitments read from the table, the last handover record (the lead's account, the structured parts, the thread's last ten messages) and the memory. The handover summary, the messages and the commitments come from a model, the owner or a team, and they carry across generations. That is an injection path, so they are data: a heading in them opens nothing. The briefing says the structured parts win over the summary.
7. **The byte budget** (advisor point C9). With every part full, the parts add up to more than the 20 KB of the acceptance:
   - the rules, about 4 KB;
   - the memory, 12 000 bytes, lib/memory's own budget for the `lead` role;
   - the summary, 4 KB;
   - the messages, 6 KB, the newest kept;
   - the structured parts.

   The acceptance's 20 KB applies to a fresh generation, which has no handover, and a test asserts it with a full memory budget. A refreshed generation's briefing can reach about 35 KB, which is about 9 000 tokens, under 5 % of a 200 000-token window, well below the 40 % handover point. Commitments are never cut, since the property test needs every open one in every briefing. `commit` keeps them bounded instead: one sentence of at most 300 characters, and at most 20 open. Order of cuts: lib/memory cuts its own entries; the summary is cut at 4 KB; the messages are cut to the newest that fit in 6 KB.
8. **The goal id** is `goal-<seq>`, the thread seq of the owner's goal line. It is said in the goal turn, which tells the lead to propose its plan with this id (lane 7's `propose_plan.goal`).
9. **The lead's workdir** is `<workdirs>/lead`, cloned again from the base at each generation. `ticketCheckout` reuses a checkout as it is, so the old clone is removed first. The lead edits nothing, so a `CLAUDE.md` the project commits is replaced in that clone, not refused. lib/memory runs in a child process of the lane's own, for the lead's `briefing` (role `lead`, budget 12 000) and for `search`. `workspace/briefing.ts` knows only `briefing` and `capture`, and it is not this lane's file.
10. **Host tools.**
    - Every handler, lane 7's included, refuses a call that comes from a session other than the live generation's.
    - `answer_question` turns the list into `Decision.answers`, keyed by question text, and refuses a question the request did not ask (issue 163).
    - `message_session` and `answer_question` act only on an author's or a reviewer's session, never the lead's own.
    - `ticket`, `session` and `search_memory` answer cleaned text.
    - `search_memory` keeps approved decisions first, then the glossary and the lessons.
    - The policy's `lead.tools` row allows any `mcp__cleared__*` name (issue 163). The host gives the session only the bound tools, and the fake adapter answers an unknown name with a failure; what lane 4's runner does with one is its own.
11. **The thread and the stream.** A question row in `lead_messages` takes its state from its inbox item, so there is one source of truth. The stream sends the thread after `?after=` or `Last-Event-ID`, then a state frame, then each message and state change. Its listener is set before the backlog is read, and a message already sent is not sent twice.
12. **For lane 7** (it may edit only `modules/lead.ts` and `prompts.ts` of the lead), the engine gives these registration points:
    - `LeadExtensions`: `tools` (`propose_plan`, `start_ticket`), `state` lines for the compact state, and `handover` sections for the structured record;
    - `enqueue(text, urgent)` for plan events;
    - `serviceLine(text)` for "Plan P approved";
    - `planLine(planId, text)` for a `plan` row in the thread;
    - `publishPlan(plan)` for a `plan` frame.

    `createLeadRuntime` takes the extensions.
13. **Configuration**, from the service's environment. A setting that is set but wrong stops the service with exit code 64, as the flow's do.

    | Variable | Default | Meaning |
    | --- | --- | --- |
    | `CLEARED_V2_LEAD_ENABLED` | on when `CLEARED_V2_PROJECT` is set | `off`, `0` or `false` turns the lead off. |
    | `CLEARED_V2_LEAD_MODEL` | `claude-opus-5-5` | The lead's model, an explicit name (decision 13). |
    | `CLEARED_V2_LEAD_CONTEXT_PERCENT` | 50 | The threshold: the running turn is interrupted, then the lead hands over. |
    | `CLEARED_V2_LEAD_HANDOVER_PERCENT` | 40, or 80 % of the threshold when that is lower | The handover point: the lead hands over at the end of the turn. It must be below the threshold. |
    | `CLEARED_V2_LEAD_BATCH_SECONDS` | 60 | How long the flow's events are batched into one event turn. |

    The plan gives the handover point a fixed default of 40. The lane takes 80 % of the threshold when the threshold is 50 or lower, so that `CLEARED_V2_LEAD_CONTEXT_PERCENT=5` alone (the doctor's and the rehearsal's setting) is valid.

**Consequences.**
- **Gaps across lanes, named here and in the pull request; this lane did not edit the files involved:**
  - *Answering the lead's question through the session route.* `FlowEngine.answer` (`v2/src/flow/engine.ts`, `#liveSession`, line 1005) knows only the sessions the flow started. The lead's session has a row in `sessions` but none in the flow's live map, so `POST /api/sessions/:id/requests/:requestId/answer` answers 409 for it. The owner answers through `POST /api/lead/messages`, which answers the pending question when one waits (decision 8). The acceptance's "answered from the answer route" is met through that route, not through the session route. Until `FlowEngine.answer` hands a session it does not own to `LeadEngine.answer` (already written), the inbox and lane 8 cannot answer a lead question through the session route. Lane 10 links the question to `/lead`, so it is not blocked.
  - *`stop_session`.* `FlowEngine` has no public stop: `#stopTicket` and `#close` are private. The port's `stopSession` is optional and the tool refuses while it is missing. `flowPort` picks up a public `stopSession(id, reason, by)` by name once `engine.ts` has one.
  - *Restart and the inbox.* The flow's constructor runs `inbox.handleRequests('system')`, which also handles the lead's waiting question. The lead runtime builds the flow engine first, so nothing the lead adds afterwards is cleared. Keeping the question across a restart is lane 7's narrowing.
  - *Lazy start.* A module's `provide` has no registry, so the lead starts on the first request to a lead route, as the flow's engine does (lane 2's entry). A service that restarts at night does nothing until a browser asks; lane 9's 15-second poll of `GET /api/lead` starts it. A start hook for modules would be a change to `registry.ts` and `main.ts`, a lane of its own.
  - *Listings.* `GET /api/sessions` lists the lead's sessions (role `lead`, ticket `lead`). Lane 9 and the tower should leave them out or show them as the lead.
  - *The config volume.* The adapter's `stop()` keeps the session's config volume so that `resume` works (`claude-code.ts`, header). The plan wants it removed for a lead generation, which is never resumed. Removing it is lane 4's file.
- **The answer cap (section 4.1) is only half proven.** The test of the 8 KB answer covers the host tools. The open point of lane 1's entry stays open: the policy does not cap a `Grep` in content mode or a git read that stands alone, and how much of a command's output Claude Code keeps was not measured. It needs lane 4's real run.
- **What this lane makes live before lanes 9 and 10.** This lane is the first to create inbox items of the lead: a question with ticket `lead`. Until lanes 9 and 10 land:
  - the milestone 1 inbox lists it with answer buttons, which get 409 from the session route (the first gap above);
  - the shell's count and the tower count it;
  - lane 6's dispatcher will notify it as a `question`.
  Issue 163 called this "future"; it is now real.
- **Edit outside the lane's files:** `v2/test/modules/registry.test.ts` lines 10 to 26, because the lead module is no longer empty. Lanes 7 and 8 of milestone 1 made the same kind of edit.
- **The doctor's `lead` check** (`v2/scripts/doctor-lead.ts`) is written. It runs a real generation on the doctor's model: a commit, a refresh forced at 5 %, then the commitment asked of generation 2. **It was not run.** Lane 4's runner, which carries the host tools and the context line, is not in `v2` yet, and the check needs it. It runs once lane 4 is merged and `doctor.ts` imports the list.
- **No screen changed:** the lane touches no file of the app, so no capture was made.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j2-lead-core`.

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
- **Edit outside the lane's files:** `v2/test/modules/registry.test.ts` (lane 1's). It asserted that the `notify` stub is empty, which filling the module ends. Merged with lane 5's edit of the same lines: neither stub is left, so the loop over stubs is removed, and lane 5's check that `lead` provides no slot stays.
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

## 2026-10-22: the runner's host tools, the context measure and the login wait (milestone 2, lane 4)

**Decision.** Lane `v2-j2-runner-host-tools` implements decisions 2 and 3 of the [milestone 2 plan](milestone-2-plan.md) in the runner (`v2/images/session/runner/`) and the host side of the Claude Code adapter, with these choices made by the lane. The measures behind them are in [adapters.md](../adapters.md), "Host tools, context and login in a container (2026-10-22)".

1. **The runner's protocol grows by three lines each way.**
   - The `start` line carries `role` (always sent by the host; `author` when absent) and `tools` (name, description, input schema, without the handler).
   - New runner lines: `host_call` (call id, tool use id, name, input), `context` (after a turn or a tool), `login` (`failed`, `renewed`) and, for the doctor only, `measure`.
   - New host lines: `host_result` (call id, ok, text) and `measure`.
   - A start whose tools fall outside the schema subset, or that has tools without the SDK's MCP functions, exits with code 4 before any query.
2. **Host tools are the in-process MCP server `cleared`.** `createSdkMcpServer` with `alwaysLoad: true` (never deferred behind tool search) and a 5-minute call timeout, so a host that never answers cannot hold a turn for ever.
   - `tool()` of SDK 0.3.306 takes a zod raw shape, not a JSON Schema. `schema.ts` builds the shape from the contract's subset with the image's zod, and refuses anything outside it with the key's path.
   - zod is now pinned in the image (4.6.7, what npm had resolved as the SDK's peer dependency). No dependency is added to `v2/package.json`; the unit tests use a stand-in builder.
   - The tool use id comes from `_meta['claudecode/toolUseId']`, which the CLI 2.1.306 gives every call (measured). The runner also records the ids its `PreToolUse` check lets through, by name and input, as a fallback.
   - The host answers only a name of `StartInput.tools` (issue 163's follow-up on `lead.tools`); any other name is `failed`. A string answer goes back as it is, any other value as JSON. `HostToolRefused` is `refused` with its message; any other error is `failed`, and both the model and the event read the generic "The host could not run this tool."
   - In `default` mode the CLI asks `canUseTool` for a host tool call, as for a write; the policy allows it as `lead.tools`, and the runner's tool check runs before it as for any tool.
3. **The context measure** is `getContextUsage({ detail: 'summary' })`, after every turn's result (awaited, the CLI is idle then) and from a `PostToolUse` hook that returns at once and prints the line when the measure answers. Only the fields the host uses are forwarded, never the categories or the grid. A measure slower than 200 ms makes the hook measure every third call; none was (median 9 to 11 ms over ten calls, in three runs). The `full` detail was timed too (median about 10 ms, but its first call of a session took 0.6 s and 1 s in two runs) and is not used: the two agreed after a turn, and between turns the summary read more (19 181 tokens against 17 829), which errs on the safe side for a threshold. The host maps the line to `cleared.context_usage` and an `add` on `/context` of the state, so a later `STATE_SNAPSHOT` holds it.
4. **Rate limits.** The `rate_limit_event` frame carries the windows in `unifiedWindows` (not in `sdk.d.ts`): `five_hour` and `seven_day`, each a utilization as a fraction and a reset time in seconds, which is how the CLI's own code reads them (`Math.round(utilization * 100)`, `new Date(resets_at * 1000)`). The mapper says `cleared.rate_limit` per window when its value changes. The experimental usage call answered `rate_limits_available: false` and no subscription type for a session logged in with `CLAUDE_CODE_OAUTH_TOKEN`, so it is not a source of the week share here; it is not adopted.
5. **`compact_boundary`** maps to `cleared.compacted`. None was seen: haiku's window is reported as 1 000 000 tokens with auto compaction at 967 000, so Claude Code does not compact below 50 % on its own. `settings.autoCompactWindow` was not tried: nothing needs a larger window.
6. **The Stop hook is an author's only.** `hooks.ts` gains `hooksFor(role)`, which leaves the Stop hook out for `lead` and `reviewer` (issue 139's lasting fix). The push and pull request rules stay for every role.
7. **The commit identity is `Cleared` with no address**, through `GIT_AUTHOR_*` and `GIT_COMMITTER_*` in the CLI's environment. Git 2.39 in the image accepts an empty address from these variables (checked in a labelled container); without them a commit fails, since `HOME=/tmp` has no git configuration. An empty address gives the guard nothing to refuse.
8. **Login resilience.** A frame whose typed error is `authentication_failed` (an assistant message or an API retry, never the text) is remembered for the turn. The CLI retries a 401, so the failure is decided at the turn's `result`: an error result prints `login failed` before it, and a successful one (the retry worked) is a turn like any other. After a failure the runner closes the query and reads the login file every 10 seconds until its token changes. Then it prints `login renewed`, recreates the query with `resume` in the same container and pushes a message of its own saying the login was renewed; the failed turn is not sent again.
   - Measured with an invalid token in a file the doctor owns: the CLI 2.1.306 reports it as `system/api_retry` with `error: 'authentication_failed'` and `error_status: 401`; the runner waited, saw a rewrite of the file, resumed the same session (whose first turn had failed) and failed again on the new invalid token, as expected.
   - The mapper ends that turn as `RUN_FINISHED` cancelled, with the status "Waiting for a new login", not as a `RUN_ERROR`. Reason: the flow stops the ticket on any `RUN_ERROR` (`flow/engine.ts`), which would remove the container that waits.
   - The turn queue ends the first query's iteration before the second starts, so no turn reaches a closed query.
   - **The bind mount limits this.** The login is mounted as one file. A rewrite in place is seen in the container; a rename over it (a new inode) is not, measured in a labelled container. So the resilience works only if the host CLI rewrites its credentials file in place, which was not measured (the lane does not touch that file). A `setup-token` token (plan question 1) does not need it.
9. **Smaller fixes.**
   - The runner no longer awaits an interrupt in its input loop, so a verdict sent right after it is not held (issue 145, item 5).
   - The doctor reads the Claude Code version from the Dockerfile (issue 145, item 6).
   - A test checks that every runner file is copied into the image, and that a runner file imports the service by type only.
   - A context measure that does not answer within 5 seconds is given up and logged, so the end-of-turn measure, which the relay awaits, cannot hold the session.
10. **Issue 140** asked for `settingSources: ['project']`. It stays `[]`: the briefing is appended to the system prompt (decisions log, 2026-10-21, the Claude Code adapter, item 3), and the project source would also load the project's settings and hooks. The `stop_hook_active` test it asked for exists in `test/runner/hooks.test.ts`.

**Consequences.**
- **For lane 5.**
  - The per-tool measure lags: taken in `PostToolUse`, the summary answers from the last response's usage, so it does not yet count the tool's own answer. Measured with an 8 461-byte answer: 19 181 tokens before the call, 19 181 right after it, 20 999 at the end of the turn. The next measure counts it, so a threshold is crossed at most one answer late, which the plan's answer cap already bounds.
  - The window is the model's: 1 000 000 tokens for `claude-haiku-5-5`. The plan's arithmetic (section 4.1) assumed 200 000. The threshold stays a share, and the margin between the handover point and the threshold only grows.
  - A host call's `turn` is the mapper's running turn id: the `command_lifecycle` uuid of the user message that started it.
  - The doctor's `lead` check (`scripts/doctor-lead.ts`) was run on this lane's runner after the merge of lane 5. The host tools and the context line reach the lead engine: a `commit` was refused for a due time without its offset, then accepted. But the check fails with "no refresh at 5 %": the generation sits at 2 % (22 560 of 1 000 000 tokens), because its threshold of 5 % assumes a 200 000-token window. A threshold of 2 %, or one set from the first measure, would make it refresh. That file is lane 5's, so it is left for a fix lane.
- **For lane 7.** No week share yet: the usage call is unavailable with this login, and `cleared.rate_limit` gives the seven-day window from the frames. Whether the week share is right against `/usage` on the host is for the orchestrator's evening and morning readings.
- **Not measured:** the recovering half of the login (a valid token after a failure). The service's token file holds no `setup-token` token, and only the owner may put one there. The proof observes a natural refresh.
- **Left as they are:**
  - A host call the CLI gave up on (an abort or the 5-minute timeout) is still journaled with the host's outcome, though the model never read the answer.
  - A session waiting for a new login is still stopped by the flow's idle rule after 15 minutes (`CLEARED_V2_IDLE_MINUTES`). A lead is exempt from that rule (plan, section 4.3), so a lead waits as long as the login takes.
  - The containers a stopped service leaves behind are still not removed at the next start (lane 2's entry names the adapter's runtime for it); that is not in this lane's goal.
- **For plan question 1.** The bind mount finding weighs for answer (a), a `setup-token` token: with the host login, a refresh by rename is invisible to a running session.
- No screen changed: lane 4 is not an interface lane, so there was no visual loop and no capture.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j2-runner-host-tools`.

## 2026-10-22: goal mode, the estimates and the plan runner (milestone 2, lane 7)

**Decision.** Lane `v2-j2-plans` implements decisions 5, 6, 7 and 15 and section 5 of the [milestone 2 plan](milestone-2-plan.md) in `v2/src/lead/plans/` (`store`, `estimates`, `runner`, `tools`, `routes`), `v2/src/inbox/store.ts`, `v2/src/modules/lead.ts`, the plan paragraph of `v2/src/lead/prompts.ts` and one helper in `v2/src/flow/engine.ts`. The lane's choices:

1. **The item rows are the truth.** `plan_items` keeps each item's state, its ticket, how many times it was put back and the last note. The runner moves them from the flow's bus (`ticket_started`, `release_requested`, `release_landed`, `release_unhealthy`, `ticket_put_back`), matched by ticket id, not by `origin`, so a ticket a person sends back and starts again is still followed. The bus lives in memory, so each 30-second tick also reads the tickets: an item running or in Needs Approval whose ticket is back in Todo, and not run by the flow, is a put back the bus did not say. A Done ticket the bus did not land is landed when it never asked for a release (a person closed it), or when lane 2's `landingOf` reads its release as landed.
2. **Landed is not Done.** merge-pr.sh moves a card to Done before the release watch's verdict (lane 2's entry), so a dependent waits for `release_landed`, never for the Done status alone. A release live but not healthy (`release_unhealthy`) holds its item, so the items after it wait, and the lead is told. A rollback after a landing is a put back, as section 5.3 says.
3. **Put backs.** The first counted put back makes the item `put_back`; the next tick starts it again, with the note and "integrate the base branch first" added to the author's prompt through `Origin.note`. The second holds the item and sends the lead an urgent event that names `start_ticket`. A put back with the reason `restart` does not count: decision 12 has the runner start such a ticket again, and the service's restart is not the ticket's fault. The tick may read a ticket back in Todo before the flow says why, since the flow says it after its comment and its move. A put back that comes for an item already `put_back` therefore only replaces the note, so one put back never counts twice. An item already held is not announced to the lead again.
4. **Starting.** An item is set to `running` before the flow is asked, and the runner counts its own running items. Without that, two ticks during one slow start (a clone) could start a third ticket. The flow's `FlowError` for a ticket in another state is left to the next tick's reading; a ticket that is gone holds its item.
5. **Approval.** `approve` first moves the plan from `proposed` to `approved` in one `UPDATE ... WHERE state = 'proposed'`. A second approval is a 409. The tickets are created by the tick, never by the approval itself, so a timer's tick that runs during the approval cannot create them twice: ticks run one at a time. They are created in position order, by the approving person (`{ kind: 'human' }`, as `POST /api/tickets` does), with the labels `plan:<id>`, `size:<s>` and `Quick` for a fast item. A creation that fails is tried again at each tick. The approval waits for that tick, so the first tickets start at once rather than up to 30 seconds later.
6. **Estimates** (section 5.2). The plan's time is the runner's own rule played on the estimates: items start in position order once every item they wait for is done, at most `maxParallel` at once. On lane 1's fixture this gives the fixture's 120 minutes. `totals.samples` is the fewest samples of any item, so the screen says "Default estimates" as soon as one item uses them. `weekPercent` stays null: lane 4 reports the seven-day window as a share of the subscription, with no cost per share, so an item's share cannot be derived from it. Dollars are shown, as the plan says.
7. **The week stop and the day budget.** The runner reads the newest `cleared.rate_limit` of the `seven_day` window among the project's events. At or above `CLEARED_V2_WEEK_STOP_PERCENT` (85) it starts nothing new: no first starts, no restarts after a put back, no `start_ticket`.
   - A measure whose `resetsAt` has passed does not stop anything. Lane 4's mapper reports a window only when its value changes, and while the plans are stopped no session runs to report the reset.
   - `CLEARED_V2_DAY_BUDGET_USD`, when set, applies beside the week measure, and the stricter of the two wins. It is the sum of `total_cost_usd` of the project's `RUN_FINISHED` events since midnight, in the server's time zone.
   - The plan (section 5.3, rule 6) makes the budget a fallback for when there is no week measure. This departs from that: lane 4 has closed that unknown, so real sessions now always report the window, and a fallback-only budget would never apply. The proof sets the budget, so it must apply. Both stops tell the lead once, with an urgent event, and the owner once, with `reportHealth(db, { code: 'week_stop' })` (lane 6). They do so only when something was ready to start. "Once" is kept in memory: a service restarted during a stop says it again. Both settings are read when the module is provided; a value that is set but wrong stops the service with exit code 64, as the lead's settings do.
8. **Decision 15.** `flow/engine.ts` gains `QUICK_LABEL` ("Quick") and `QUICK_MODEL` (`claude-haiku-5-5`). A ticket with the label gets Haiku as its author, on its first start and when a new author replaces one that cannot be resumed after a review. The exception is a configuration whose reviewer is Haiku: the author keeps `CLEARED_V2_AUTHOR_MODEL`, so the reviewer stays another model.
9. **The inbox.** The plan item is `plan:<id>`, under `LEAD_TICKET`, with no session and its plan id in `request_id`. `find`, `waitingFor` and `handleSession` now read permissions and questions only, so a plan item never counts as a session's request and no answer route reaches it. `handleRequests('system', live?)`, which a new flow engine runs, handles only the permissions of any session and the questions of the teams, outside the `live` set it is given. A release, a proposed plan and the lead's question survive a restart; the lead's next generation receives that question's answer (section 3.3). Issue 157, item 3: `setReleaseChecks` writes only a release that still waits.
10. **The tools and the lead.** `propose_plan` and `start_ticket` are registered through lane 5's `LeadExtensions`, with the plans' lines of the compact state and their section of the handover record, without editing `lead/tools.ts`. The model's titles, bodies and summary go through the service's cleaner before they become a plan or a ticket. A proposal adds a `plan` line to the thread ("Plan to approve: ..., 5 tickets, about 1 h 42 of work.") and a `plan` frame on the stream. Every change of a plan or an item sends a frame. Approve, reject, pause and resume each add a service line to the thread, which is an owner turn for the lead. The runner does not repeat into the lead's queue what lane 5 already hears from the bus (a start, a landing, a put back). It adds only what the bus does not say: an item held, a plan done, a stop.
11. **Validation.** A plan has a goal id (any text of at most 120 characters: `goal-<seq>` from a goal turn, or a word for a ticket the owner asked for in conversation, which is a one-item plan), a title and a summary, and 1 to 12 items. Each item has a title of at most 120 characters, a body with at least one unticked `- [ ]` line, a lane and a size. `after` holds existing positions other than the item's own, with no cycle; a forward position is allowed when it makes no cycle, and a position given twice is kept once.
12. **The module.** The runner is built with the lead, on the first request to a lead or plan route. The lead's routes build it too, so lane 9's poll of `GET /api/lead` runs the plans after a restart. It subscribes to the flow in the same synchronous call as the flow engine's construction. Its tick runs every 30 seconds.

**Consequences.**
- **Edits outside the lane's files:** `v2/test/lead/module.test.ts` (lane 5's), which asserted the module's exact tables and routes. It now expects the plans' tables after the lead's, and checks the lead's five routes among the eleven.
- **Not done here.**
  - `cancelled` is never reached: no route or tool cancels an item. A plan with a held item is done only once that item lands.
  - A rollback after the plan is `done` is not followed: a done plan is no longer read.
  - Issue 168, item 3 (answering the lead's question through the session answer route) needs `FlowEngine.answer` to hand the lead's session to the lead, which is beyond this lane's edit of `engine.ts`. Lane 8 can answer through `POST /api/lead/messages`, which answers the pending question.
- **Proven on the fake adapter, through the real flow engine.** A five-item night (1, 2 and 4 independent, 3 after 2, 5 after 3): at most two live tickets; 1, 2 and 4 in Needs Approval in the morning with 3 and 5 waiting; 3 started after 2's `release_landed`; the plan done when 5 lands. Also: a put back started again with the note then held; pause and resume; the estimates from a seeded history of 7 tickets (median, `samples: 7`) and of 2 (the defaults, `samples: 2`); the critical path; the three refusals; the approval's labels, bodies and the 409; a new engine over a proposed plan and the lead's question; and a scripted lead proposing through its host tool. The defect tests of the inbox narrowing, the checks and the Haiku author fail on the code before this lane.
- **No real run.** Nothing here calls a model or Docker: the runner's real use is the milestone proof.
- **No screen changed.** The lane touches no file of the app, so it ran no visual loop and made no capture. Lanes 8, 9 and 10 draw the plan.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j2-plans`.

## 2026-10-22: the tower of milestone 2, against tower.png (milestone 2, lane 9)

**Decision.** Lane `v2-j2-tower-m2` gives the tower its milestone 2 state (plan, section 7.2) in `v2/app/public/screens/tower.ts`, with the "Lead · always on" pill in the shell's header. The lane's choices:

1. **What the tower reads.** Sessions, inbox and tickets are still required: if one fails, the tower says it cannot reach the service, as in milestone 1. `GET /api/lead`, the thread and `GET /api/plans` are read apart (`loadTower`), and a failure gives no lead and no plans. So a service with the lead off, or without lane 7's plan routes, still shows milestone 1's tower.
2. **The lead card.**
   - The state line is "Always on · context N % · refreshed N min ago" for `idle` and `working`. The share is left out before the first measure. "refreshed" is left out for a first generation (`refreshCount` 0). It is "refreshed", not the plan's "refreshed from memory", because the longer form wrapped to two lines in the 360 px column; the capture says "refreshed".
   - `starting` reads "Starting" and `refreshing` reads "Refreshing from memory". `down`, and a lead the tower could not read, read "Not running" in the danger colour.
   - The last line is the lead's last thread line to the owner: a message, a plan or a question, never the owner's line nor a refresh. It is quoted with `<q>`, so the browser uses the page's language for the quotation marks, and clamped to three lines.
   - The thread is read whole once, then with `?after=<last seq>` at each 10-second refresh, so a 48-hour thread is not fetched again and again.
   - "Message the lead…" opens `/lead?draft=<text>`, as Ask the lead does. The tower sends nothing to the lead itself: the reply shows on the lead's screen, and lane 8's screen is where a message is sent. A redraw keeps what is typed in the field.
3. **The plans card** lists the plans `approved` or `paused`. Proposed plans are cards under Needs you, and done, rejected and superseded plans are not shown.
   - Each plan has a bar with one segment per item, in position order: green landed, blue running, amber waiting for approval, red held, grey still to start (`waiting`, `ready`, `put_back`). A cancelled item has no segment and is not counted.
   - The segments are equal flex items with classes, not widths, because the page runs with no inline style.
   - The line reads "3 of 6 landed · 1 running · 1 to approve · 1 held · next: <title>", with "Paused" first when paused and zero counts left out. "next" is the item still to start with the lowest position. The plan's "next tonight" would need a schedule nothing computes.
   - The bar's `aria-label` names every coloured count.
   - Each plan links to `/plans/<id>`.
4. **The plan card under Needs you** reads "Plan · <age>", with "Goal" in the id slot, the plan's title and "The lead proposes N tickets, about 2 h of work and 4 % of the week." Without the week share it reads "…, about $3.90." (plan, section 5.2), and one ticket is in the singular. "about 2 h" comes from `totals.minutes`: whole hours have no minutes, otherwise it reads "2 h 15". The French catalog writes decimals with a comma (`decimal_mark`).
   - **Order:** what the teams wait for comes first, oldest first, then the plans, as the capture orders them. A plan waits for a decision; it holds no session.
   - **Link:** the plan card links to `/plans/<id>`, the lead's screen for that plan, because lane 10's inbox detail is not there yet.
5. **The lead's items and session** (issues 163 and 168, lane 5's entry).
   - A question whose ticket is `lead` shows "Lead" in the id slot, never the sentinel. It says "The lead waits for your answer on its screen." and links to `/lead`, where it is answered (the session answer route still refuses it; lane 5's entry).
   - Sessions of role `lead` are left out of Live sessions and their count: the lead is its card.
   - The browser cannot import `LEAD_TICKET`, so `tower.ts` repeats the constant, as it does `DONE_STATE`.
6. **The grey line** gains "N plans in progress" (approved and paused) when there is one, and "Claude N % left" when the week is measured. **No route reports the week left yet.** `LeadState` has no week share, and `cleared.rate_limit` lives only in session events. So `TowerData.weekLeft` is always null in `loadTower`. It is rendered and tested with a value, and a route that carries it is a change to `src/api/types.ts`, a lane of its own (plan, section 10).
7. **The pill.**
   - The server renders `<a class="lead-pill" id="lead-pill" href="/lead" hidden>` first in the header's right group, as in the capture. `app.ts` reads `GET /api/lead` on the inbox count's 15-second poll, on every page, and shows the pill for `idle`, `working` and `refreshing`. A refresh is part of being always on, and hiding the pill for it would make it flicker. The pill is hidden for `starting`, for `down` and on any error.
   - That read also starts the lead after a service restart (lane 5's lazy start), so the lead does not wait for its screen to be opened.
   - `leadPillShown` is exported from `app.ts` for the tests. `app.ts` now starts the page only when a `document` exists, so Node can import it.
8. **`DRAFT_MAX` lives in `tower.ts`** (issue 164): the tower no longer imports `screens/lead.ts`, which lane 8 rewrites in this wave. It is still 2000, what the lead's screen reads.

**Consequences.**
- **The fixture** (`app/fixtures/tower.ts`) adds the capture's milestone 2 data, with guestbook content:
  - a lead at 31 %, refreshed 10 minutes ago;
  - its line about LOCAL-161 and LOCAL-163;
  - a plan under way ("Entries on desktop", 3 of 6 landed, 1 running);
  - a proposed plan of 5 items waiting for 25 minutes, about 2 h and 4 % of the week.

  The rendering tests read it.
- **In fixtures mode** the lead and the proposed plan come from lane 1's lead fixture, so the tower and the lead's screen agree. The tower adds its plan under way. Against the capture, the plan card is then 6 minutes old and the share 45 %.
- **Edits outside the lane's files**, each named in the pull request:
  - `v2/app/fixtures/source.ts`, lines 50 to 52, 69, 84 and 85: `/api/plans` serves the tower's plan under way after the lead fixture's, and `/api/inbox` leaves out the tower fixture's own plan item, so the proposal is not listed twice.
  - `v2/app/test/fixtures.test.ts`: two plans, one plan item.
  - `v2/app/public/style.css`: the pill, the lead card, the plans card, and the art director's items. The tower's rules already lived there.
  - When lane 8 adds its running and done plans to `fixtures/lead.ts`, fixtures mode will show two plans under way. The merge can drop the tower's one from `source.ts`.
- **The visual loop:**
  - It ran on the app in fixtures mode on `127.0.0.1:18893` (checked free), with a temporary state folder and user.
  - Captures are `/tmp/cleared-captures/j2/tower-{1440,1280,768,390}-{light,dark}.png`, with no horizontal overflow at any width. They replace lane 1's captures of the tower, which issue 164 said were stale.
  - The art director's pass was run once, by Sonnet 5.5 in a fresh session.
  - Taken:
    - at 768 the side cards no longer stretch to the same height;
    - an odd last card under Needs you spans the row at two columns;
    - the bar's label names approvals and held items;
    - `text-wrap: pretty` on the plan line;
    - a two-line clamp on a plan's title;
    - still-to-start segments in `--dashed`, which reads in dark.
  - Not taken:
    - **The placeholder colour (`--placeholder`, 3.2:1 in light).** It is milestone 1's token, shared with the bar, and a change belongs to a design fix for every field.
    - **Moving the lead card above Live sessions below 1100 px.** That is milestone 1's layout and the capture's order.
    - **Smaller polish:** the field's radius, and a focus check the global rule already covers.
- **Not done:** the week share (item 6); answering the lead's question from the tower.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j2-tower-m2`.

## 2026-10-22: the lead and plan screen, against lead-and-plan.png (milestone 2, lane 8)

**Decision.** Lane `v2-j2-lead-screen` fills lane 3's stub with the screen of section 7.2 of the [milestone 2 plan](milestone-2-plan.md): `screens/lead.ts`, `screens/lead.css`, `public/plan-panel.ts`, the lead catalogs and the lead fixture. The screen follows `lead-and-plan.png` for layout, sizes and colours, and the plan and lanes 1 and 5 for content. The lane's choices:

1. **The reply always goes through `POST /api/lead/messages`.** The plan says the reply field answers the pending question "through the session answer route with the lead's session id". That route answers 409 for the lead's session (issue 168, item 3; lane 5's entry), and lane 5's `post()` answers the pending question itself (decision 8). So:
   - with Goal pressed, the field sends `{ text, goal: true }`, which never answers a question: a goal wins over a waiting question, and the question keeps waiting;
   - else, when `LeadState.pendingQuestion` is set, `{ text }` answers it, and the button reads "Answer";
   - else `{ text }` is a message.
   An option of the question sends its label as the text, "(Recommended)" kept, as the inbox does. Lane 5 gives the same text to every question of one ask, so options are buttons only for an ask of one question; an ask of several shows its options as a list and says to answer them in one message.
2. **A Goal toggle in the reply field.** The capture has none, but a goal needs `goal: true` to get its id (`goal-<seq>`) for `propose_plan`. The tower bar's New goal (`?goal=1`) presses it. It is released after a send.
3. **The draft leaves the address.** `?draft=` and `?goal=1` are read once, then `history.replaceState` drops them from the tab's address and its back history. The browser's global history still records the address the tower opened, so issue 164's item is narrowed, not closed: closing it means the tower passing the draft another way (lane 9's file). `draftFrom`, `planFrom` and `DRAFT_MAX` keep their names and behaviour, since `tower.ts` imports `DRAFT_MAX`.
4. **Which plan the panel shows.** On `/plans/<id>`, that plan. On `/lead`: a plan to approve; else a running or paused one; else the last done; newest first in each group. A superseded or rejected plan is shown only from its address. The other plans are listed under the panel with their state, as links to `/plans/<id>`.
5. **The panel's gestures.**
   - Approve, Pause and Resume call their route at once, with no grace (decision 6). The panel redraws from the plan the route answers, and the shell recounts the inbox.
   - A 409 says the plan changed meanwhile, and the panel reloads that plan. Any other failure says the gesture failed.
   - "Change the plan" only focuses the reply field, with the hint "Tell the lead what to change"; it rejects nothing. A paused plan offers it too, as section 5.4 changes an approved plan.
   - Approve and Resume are in ink; Change and Pause are outlined, because a running plan needs nothing from the person.
   - The panel has amber only while the plan waits for approval.
6. **The plan panel is shared** (`renderPlanPanel`, pure, with the translator it is given). Its keys are all prefixed `plan_` and named in `PLAN_PANEL_KEYS`. A test checks that every `'plan_…'` literal of the file is in the list, and that the list is in `lead.en` and `lead.fr`. Lane 10 copies the list into `inbox.*`. Its rules (`.plan-*`, `.lane`, `.item-state`) live in `screens/lead.css`, unscoped, so the inbox can load that sheet; every other rule of the sheet is under `.lead-screen`, since the inbox already uses `option`, `options`, `q-header`, `q-text` and `bubble` for its own question form.
7. **Estimates.** A share of the week when it is measured, else dollars, as section 5.2 says ("$0.30", "About $1.70"). This departs from DESIGN.md's "don't show money"; the plan wins on content. Below 3 samples the footer says the estimates are defaults. The work time is the critical path the service gives (`totals.minutes`), written "2 h", "2 h 15", "42 min".
8. **The thread.**
   - A refresh is a grey line with the generation and the time, and a service line uses the same style.
   - A question that waits sits on `awaiting-surface` with its header, options and how to answer. Once settled it reads as a line of the lead, as in the capture, with the owner's answer below it.
   - Whether a question waits is read from `LeadState.pendingQuestion`, not from the row.
   - A time line comes after 30 minutes of silence, so the morning's account shows when the night's messages came.
   - The plan message links to the panel where the panel goes under the thread, and to `/plans/<id>` for another plan.
9. **The header line.**
   - `idle` and `working` read "Always on · context N % · refreshed from memory X ago".
   - `starting` reads "Starting", and `refreshing` reads "Refreshing from memory".
   - `down` is a danger pill, "The lead is not running". So is a `GET /api/lead` that fails, a 503 included.
10. **What the lead remembers** opens a panel in the lead's card with:
    - the refresh count, the highest share and the model;
    - the last handover: the lead's own words, or the line that the service wrote it;
    - the commitments, open then done, with their times.
11. **The stream** is read with one listener per frame name (`message`, `state`, `plan`). When it drops, it is reopened after the last message seq with a doubling pause, as the session screen does. A message already seen is not delivered twice.
12. **Below 1024 px** the page scrolls, not the thread (the art director's item 1), and the panel follows the thread. On a phone, the reply field takes its own row above Goal and Send.

**Consequences.**
- **The fixture** (`app/fixtures/lead.ts`) keeps lane 1's values unchanged, so `fixtures.test.ts` and `fixtures/source.ts` stay as they are. It adds, as separate exports:
  - `otherPlans` (a running plan, the same paused, a done one), with the guestbook's content of plan question 5;
  - `waitingForAnswer`, the thread while the lead's question waits;
  - `leadSource`, a stand-in for the lead and plan routes that answers their writes as lanes 5 and 7 do, for the tests and the visual loop. `fixtures/source.ts` still refuses every write.
- **Edit outside the lane's files:** `v2/app/test/shell.test.ts`, the test of lane 3's stub (`renderLeadStub`, gone) and its two imports, removed. The tests of `draftFrom` and `planFrom` stay.
- **The stub's rules stay in `style.css`** (`.lead-stub`, `.lead-draft`), now unused. That file is not this lane's.
- **Live run: not done.** Lane 7's plan routes are not in `v2` (its branch had no commit on 2026-10-22 at 05:00), so the screen ran only against the fixtures and `leadSource`. In headless Chromium, `mount` was driven through Approve, Pause, a message, Change the plan, the memory panel, an answer by option and a goal from the tower's draft. There was no page error; the only 404 was `/favicon.ico`, which the shell does not serve. The run against the live service waits for lane 7.
- **Captures**, none committed, in `/tmp/cleared-captures/j2/`:
  - `lead-<width>-<theme>.png`, at 1440, 1280, 768 and 390, light and dark, with no horizontal overflow;
  - the same for `lead-question`, `lead-running`, `lead-done`, `lead-memory` and `lead-down`;
  - `lead-reference.png`, rendered from `/tmp/cleared-reference/lead-and-plan.html`.
  The app ran on an ephemeral `127.0.0.1` port with a temporary ledger and user.
- **The art director's pass** was run once, by Sonnet 5.5 in a fresh session. Taken:
  - one scroll below 1024 px, the memory panel unclipped;
  - the reply field on its own row on a phone;
  - 44 px targets for the panel link and the other plans;
  - a tighter phone header;
  - "About $1.70" kept on one line (a non-breaking space);
  - the other plans' states aligned right, amber for a plan to approve;
  - more room under the last item;
  - the link keeps its colour when open;
  - Pause outlined;
  - a link from the plan message to the panel on narrow screens;
  - the estimate on the title's line;
  - an outline on the lead's bubble in dark.
  Not taken:
  - a fade at the bottom of the scrolling list, which would be a gradient;
  - a sticky "plan waits" chip on a phone, replaced by the plan message's link.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j2-lead-screen`.

## 2026-10-22: the inbox's plan item and the lead's question, against inbox.png (milestone 2, lane 10)

**Decision.** Lane `v2-j2-inbox-plan` adds the lead's two kinds of item to the inbox of milestone 1 (plan, section 7.2): the plan the lead proposes, and the question the lead asks. It edits `screens/inbox.ts`, `screens/inbox.css`, the inbox catalogs, the inbox fixture and the inbox tests. The lane's choices:

1. **The list follows the capture's order:** releases, permissions, plans, then questions, each oldest first. The plan card reads "Plan · 25 min", its title, and "5 tickets · 2 h 15 · 3.9 % of the week". Until the week is measured it reads "…, about $3.05", the plan panel's cost (section 5.2). One ticket is in the singular.
2. **The detail reads the plan.** The inbox item carries only the plan's totals, so the page reads `GET /api/plans` with the list whenever a plan item is in it.
   - The plan is matched by the item's `planId`, never by its id: the service writes `plan:<id>`, lane 1's fixture `plan-item-<id>`.
   - `readPlan` checks the plan's shape before lane 8's panel draws it. The panel writes the plan's states into attributes and looks them up in maps, so a state it does not know would blank it (issue 177, item 2, which stays open on `plan-panel.ts`).
   - A plan not read yet, or not readable, shows what the item says: the title, the summary, the ticket count, the work and the share. Approve still works there.
3. **The panel without its buttons.** The inbox's bar holds the gestures, as for a release, so the phone keeps its sticky bar and the gestures share the screen's busy state and its messages.
   - "Approve the plan and start" is `data-act="approve_plan"`, the selector for lane 11's `proof-inbox.ts`.
   - "Change the plan" is a link to `/plans/<id>`. Section 5.4 has it focus the reply field, which only the lead's screen has. There is no reject in the inbox.
   - The panel's own eyebrow is hidden in the detail, whose eyebrow says the plan's state ("Plan to approve", or "Running · 0 of 5 landed") with "Lead" and "Open on the lead's screen".
   - The page loads `screens/lead.css` before its own sheet, since lane 8 left the panel's rules unscoped for this. `inbox.css` flattens the panel into the detail.
4. **Approve** calls `POST /api/plans/:id/approve` at once, with no grace (decision 6). The plan the service answers replaces the one shown, and the bar says "Approved by you at HH:MM. The tickets start in order, the first ones now." Nothing is kept in `sessionStorage`: the service's list already shows the plan as handled.
   - A refusal reads the list and the plan again, and the reread plan says what happened.
   - 409 says the plan changed meanwhile (approved elsewhere, replaced, or not approved). 404 says it no longer exists, and 503 that the service runs without the lead.
   - This rereading also covers issue 175, item 2. An approval the service wrote but answered with a failure shows the plan running, and the bar says the plan changed meanwhile instead of "Try again".
5. **A handled plan** reads "Lead · Running · 0 of 5 landed" in the list. Its detail is the panel with each item's state and ticket, and no button. A handled plan not read reads "Lead · no longer waits for you".
6. **The lead's question** is shown read only, its choices as lines, with one outlined link to `/lead`: "The lead waits for your answer on its screen." The session answer route refuses the lead's session (issue 168, item 3; lanes 5, 7 and 8), and the inbox would have reported that refusal as a request settled without the person.
7. **The lead's ticket is never shown.** `inbox.ts` repeats `LEAD_TICKET`, as it does `TODO_STATE`, and a test keeps the two equal. "Lead" stands in the id slot and leads the item's line.
8. **The catalogs.** Every key of `PLAN_PANEL_KEYS` is copied into `inbox.en` and `inbox.fr`. A test checks that each one is word for word the lead's. The inbox's own new keys carry no `plan_` prefix, so that prefix stays the panel's. The French inbox called the lead "Responsable", and now says "Lead", as the tower and the lead's screen do.
9. **The fixture** adds the capture's plan, with the guestbook's content of the plan's question 5: five items, 25 minutes old, 2 h 15 of work as the critical path two at a time, 3.9 % of the week. It goes after milestone 1's items, so the list holds the capture's four waiting items. The lead's question is a separate export (`leadQuestion`). `inboxSource` answers `GET /api/plans`, `GET /api/plans/:id` and `POST /api/plans/:id/approve` as lane 7's routes do: the item is handled, and a second approval is a 409.

**Consequences.**
- **Tests first.** They failed on the code before this lane: the missing exports, and "3 waiting" where the capture has four. They cover:
  - the card and its three forms;
  - the panel in the detail, and the fallback;
  - the shape check;
  - the handled and approved states;
  - the lead's question;
  - the sentinel never shown;
  - the redraw key;
  - the failures;
  - the catalog, French included, and the escaping.
  Through the app and the fixture service, Approve calls the plan's route with the signed-in user and no body, the item leaves what waits, and a second approval is a 409.
- **Chromium, against the fixture service.** Clicking Approve wrote the plan, and the detail turned to "Running" with no page error. A plan approved from another tab before the click gave the 409 line, the plan read again as Running, no button, and "3 waiting".
- **Captures**, none committed, in `/tmp/cleared-captures/j2/`. They replace the stale inbox captures of lane 1:
  - `inbox-<width>-<theme>.png` with the plan selected, at 1440, 1280, 768 and 390, light and dark, with no horizontal overflow;
  - `inbox-end-390-<theme>.png`, the phone scrolled to its sticky bar;
  - `inbox-list-{768,390}-<theme>.png`;
  - `inbox-lead-question-<width>-<theme>.png`;
  - `inbox-plan-approved-{1440,390}-<theme>.png`;
  - `inbox-reference.png`, rendered from `/tmp/cleared-reference/inbox.html`.
  The app ran on an ephemeral `127.0.0.1` port with an in-memory ledger.
- **The art director's pass** was run once, by Sonnet 5.5 in a fresh session. Taken:
  - the lead's choices as lines, not faded buttons;
  - one way to the lead's screen, in the bar, outlined, since it only opens a page;
  - the plan's totals in one column on a phone.
  Not taken:
  - **Within lane 8's shared panel** (a label above the items, stronger key figures, 14 px item titles, the phone row layout): the panel stays the same on both screens, and those changes belong to lane 8's file.
  - **An upward shadow on the sticky bar:** milestone 1's inbox removed it.
  - **A success mark on the approved line, and a lighter summary box in dark:** the release's approved line and announcement look the same, and the two kinds stay alike.
- **Fixtures mode.** Lane 1's `fixtures/source.ts` answers every write with a 404. Under `CLEARED_V2_APP_SOURCE=fixtures`, Approve on its plan therefore says the plan no longer exists, as milestone 1's release gestures there are refused. That source is not this lane's file.
- **Not run live.** Lane 7's routes are in `v2`, but a proposed plan needs a lead generation proposing one. The fake adapter behind the service is lane 11's, in this wave.
- **Left for other lanes:**
  - the tower's plan card still links to `/plans/<id>`, which lane 9 chose because this detail did not exist (`tower.ts`, lane 9's file);
  - issue 177, item 2, in `plan-panel.ts`;
  - answering the lead's question from the inbox (issue 168, item 3).
- This entry is the only change outside the lane's files.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j2-inbox-plan`.

## 2026-10-22: Owner decision on plan question 1: the current Claude login, read-only, for the example project only

**Decision.** On 2026-10-22 at 05:05 (Europe/Paris), in reply to plan question 1 (section 11), the owner chose option (b): the sessions use the current Claude Code login, read-only, for the example project only. During the 48-hour proof, the runner is relaunched when the login reports a revoked token, and each cut is counted in the proof report. Issue 147 stays open, as an accepted risk scoped to the example project.

- Author: the owner, relayed on 2026-10-22 05:05 (Europe/Paris); written in this log.

## 2026-10-22: Owner note for milestone 3: a Cursor harness next to Codex

**Note.** Milestone 3 adds a Cursor harness next to Codex. The owner's Codex account is paused, so real trials run with Cursor, and Codex is tested without an account.

- Author: the owner, relayed on 2026-10-22 05:05 (Europe/Paris); written in this log.

## 2026-10-22: how the two owner entries above are applied (the author's choices and proposals)

**Decision.** These are the author's choices and proposals for applying the two owner entries above, not the owner's decisions.

- **The login (choices).** The login is mounted read-only into the session containers. Its content is never read, printed, copied, logged or committed by the runner, `doctor.ts` or a lane. `CLEARED_CLAUDE_CREDENTIALS` names the host's login file. Without it, the runner falls back to a token file in the state folder (option (a), a setup-token token), which nothing creates. The open policy question on a claude.ai login in third-party products is not settled by this choice. The policy already denies tool calls that name `/proc/*/environ`, and `printenv` (`v2/src/session/policy.ts`).
- **Milestone 3 (proposals).**
  - Cursor's real trials use the same arrangement as Claude Code: the host's existing login, read-only.
  - The Cursor and Codex harnesses follow the session adapter contract (plan, section 6), with the harness named in `StartInput.harness`.
  - Until a harness is named, the default stays `claude-code`.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j2-fix-doctor-window`.

## 2026-10-22: Owner decision: the complement text is integrated into milestones 1 to 5

**Decision.** On 2026-10-22 at 06:45 (Europe/Paris), the owner decided how the complement text ([complement-devin.md](complement-devin.md)) is integrated:

- Milestone 1 items 1, 8, 9 and 10 become a milestone 2 catch-up wave, after the React port and the clickable answers lane, before the 48 h proof.
- Milestone 2 items 2, 7, 11 and 12 are added to milestone 2.
- The other items will be planned in the milestone 3, 4 and 5 plans.
- The order and the proofs of the milestones do not change.

- Author: the owner, relayed on 2026-10-22 06:45 (Europe/Paris); written in this log.
- A second owner complement (a workspace is several services; a ticket can span several repositories) is recorded in [complement-multi-depots.md](complement-multi-depots.md); milestone 2 is being replanned to include it.

## 2026-10-22: the milestone 2 proof script and its rehearsal (milestone 2, lane 11)

**Decision.** Lane `v2-j2-proof-script` writes `v2/scripts/proof-j2.ts`, the driver of section 1 of the [milestone 2 plan](milestone-2-plan.md), with its pure parts in `scripts/proof-report.ts`, its rehearsal in `scripts/proof-rehearsal.ts`, the morning's inbox rules in `scripts/proof-inbox.ts`, and the `CLEARED_V2_ADAPTER=fake` setting in `src/session/adapters/index.ts`. The lane's choices:

1. **One driver, two modes.** `node scripts/proof-j2.ts` runs against the running app, as `proof-j1.ts` does. `PROOF_REHEARSAL=1` first starts a service and an app of its own, then runs the same steps. The steps are numbered as section 1: 0 sign-in, 1 the goal, 2 the questions, 3 the plan, 4 the approval and the two planted commitments, 5 the night, 6 the morning, 7 the inbox until the plan is done, 8 what the lead remembers. Each step that fails is recorded with what the screen showed, and the steps after it go on when they can.
2. **What it reads.** The app's routes, through the signed-in page's own `fetch` on `/api/service/*`, as the screens read them. The ledger is read too, read only, when `PROOF_LEDGER` names it (the rehearsal always does). It gives what no screen shows: notifications by kind, the lead's turns, cost and highest share, each ticket's sessions, review rounds and cost, each ticket's first start and its landing (`release_watch_complete`, the row the flow reads), the most tickets live at once, and the login cuts. A reading every few minutes misses short states, so the earlier of the reading and the ledger wins. The first rehearsal showed why: two tickets reached Needs Approval before the first reading.
3. **The goal is given on the lead screen** with Goal pressed, not from the tower bar. The bar's title field holds 200 characters, and the goal of question 5 (a) is longer. The tower's New goal opens the same screen and the same field.
4. **The planted commitments.** After the approval, the owner writes two messages in the thread: "When the first ticket lands, tell me how long it took from start to live." and "Tomorrow at 08:00, remind me to check the texts of the page." Around each message, the proof reads `GET /api/lead/memory` and keeps the ids of the commitments the lead's reply recorded. Step 8 judges those ids first, whatever their words. Their words are the fallback, for a commitment the lead made again later. Each planted commitment is:
   - done or open;
   - lost: recorded at step 4 and held no more, which the milestone must never show;
   - not recorded: the lead never wrote it down. The third commitment is the plan's own "after". The check covers every `after` of the plan the lead proposes: an item must start no earlier than its dependency's landing. The goal of question 5 (a) has no "3 after 2", so a check fixed on items 3 and 2 would prove nothing in the real run.
5. **The morning** (`morningAction`):
   - permissions come first, since each one pauses a session;
   - then a plan item, which lane 10's inbox approves with the shared panel's button;
   - then the releases whose checks passed, oldest first, each approved once and not again while its 60-second grace runs;
   - a question is left to the owner.
   With `PROOF_OWNER_APPROVES=1` the proof only watches.
6. **Issue 157, item 4.** A request is allowed once only when every simple command in it is work inside the checkout. Anything else is denied, and the rule denies when unsure, since the proof answers alone through a night. The list was narrowed in review round 1 (B2).
   - **Allowed:**
     - `npm test`, `npm run` and `npm ci`;
     - `node --test` and nothing else of `node`;
     - git without push, fetch or `-c`;
     - `sed -n` with line ranges only;
     - `find` without `-exec`, `-execdir`, `-ok` or `-delete`;
     - the shell's readers and writers, on relative paths or `/workspace`;
     - a few variables that change nothing that runs, such as `NODE_ENV` and `CI`.
   - **How a command is split:** on `&&`, `||`, `;`, `|`, a single `&` and a newline. `2>&1` and `&>` are first set aside as redirections.
   - **Always denied:** `$(...)`, backticks, `${...}`, `$NAME`, `<(...)` and `>(...)`.
   - **A second check on the whole text:** the first rule's names of programs that install, fetch or reach another machine (`curl`, `wget`, `ssh`, `npx`, `pip`, `npm install` and the like).
   - **Its limit (F1):** `npm test`, `npm run` and `node --test` run the project's own code, which can reach whatever the session's network allows. That is the work a ticket asks for, and the egress proxy and the policy bound it, not this rule.
   `proof-j1.ts` now judges the command from the screens' code chip, not the whole row.
7. **The fake adapter behind a setting.** `CLEARED_V2_ADAPTER=fake` with `CLEARED_V2_FAKE_SCRIPT` (a JSON file) registers the fake adapter under the `claude-code` name, which the flow and the lead start sessions with. The service refuses it with exit code 64 unless the ledger's folder, and `CLEARED_V2_STATE_DIR`, `CLEARED_V2_WORKDIRS` and `CLEARED_V2_PROJECT_DIR` when set, are inside the temporary folder (paths resolved, links followed). So no rehearsal can write fake sessions into a real ledger.
8. **A lead that answers each turn by rule.** The number and order of a night's event turns cannot be known in advance, so a fixed script would play the wrong turn. The rehearsal's lead answers each turn with the acts of the first rule whose regular expression matches the turn's text:
   - The acts are: say, ask through AskUserQuestion, or call a host tool.
   - `$1` passes a match group (the goal id); `${name}` passes an id a tool answered (commit's).
   - A rule can apply once.
   - The turn's steps are added to the fake adapter's script when its message comes. `fake.ts` reads its steps as it plays them, so it is unchanged.
   - The share starts at 1 % and rises 0.5 points per turn. With the 5 % threshold, the handover point is 4 %, so a handover turn ends at 4.5 %: one turn grows less than the gap, as section 4.1 wants.
   - The rules are tested against the engine's own texts (`goalTurn`, `eventTurn`, `commitmentDue`, `HANDOVER_REQUEST`), and against a compact state that lists the commitments, which must not make the lead record them again.
9. **Authors leave a real commit.** `publish` refuses a branch with no commit of its own. So a rehearsal author first commits one file of its ticket (`notes/<ticket>.md`) in its checkout, with the runner's commit identity, then plays its steps. The third author asks to run `npm view embedded-postgres version`, a permission that waits through the night and is denied in the morning. The plan is lane 7's night (1, 2 and 4 independent, 3 after 2, 5 after 3) with the guestbook's content of question 5 (a). It passes lane 7's `validatePlan`.
10. **Stand-ins at the edges of the machine.** The flow's effects are real (git, `gh`, the lock), and `runtime.ts` and `effects.ts` are not this lane's files. So the rehearsal replaces what lies beyond the process:
    - The forge: a bare copy of the example as the remote, and a `gh` stand-in first on `PATH`. It knows `pr list`, `pr create`, `pr checks` and `pr view` and refuses everything else, and the repository name `rehearsal/guestbook` exists nowhere.
    - The lock: a broker on a Unix socket of the temporary state folder. On `--ask` it writes `validations/<ticket>.json` as ask-validation.sh does; the approval is refused without it, as the second rehearsal found. On a merge it merges into the bare copy and writes `merged_by_script`, then after 15 seconds a complete `releases` row and `release_watch_complete`.
    - The mail: the e-mail notifier's sendmail is a script that appends to a file.
    - HOME is the temporary folder, so the notifier's private folder and no file of the account's own are used.
    `durations.md` lists these under "What the rehearsal replaced", since the rehearsal does not prove them. The ports are two free ones from 9700 to 9799, checked with `ss -ltn` and never a reserved one, on `127.0.0.1`. An interrupted rehearsal stops its service and app.
11. **Notifications are skipped in the real run (the owner's update of 2026-10-22).** Plan question 2, the https address for the Mac, has no answer, so the 48-hour proof runs without Mac notifications, on the inbox only. `PROOF_NOTIFICATIONS` is `skipped` by default for a real run. Step 3 then does not wait for the plan's notification. A step `3 notifications` is recorded as skipped, with the reason, not failed. `durations.md` says "Skipped", reads the waits from the inbox, and still gives the count the service recorded. The rehearsal counts them by default through its e-mail stand-in. `PROOF_NOTIFICATIONS=counted` brings the count back for a real run once the address exists.
12. **Login cuts (question 1, option b: the owner's entry above).** The runner keeps the host login. On an authentication error it waits for the login file to change, then relaunches the session in the same container with `resume` (lane 4, `v2/images/session/runner/main.ts`). The adapter shows the cut as the status "Waiting for a new login" (`claude-code/map.ts`). The proof report counts each cut from the ledger: when it began, the session's role and ticket, when the session's next turn started (the relaunch), and how long it lasted. In the real mapper, the resumed query's first frame starts a run (`begin()` in `claude-code/map.ts`), so the next `RUN_STARTED` is the relaunch. A cut never relaunched says so, and says when the session ended instead (a lead whose generation was replaced). The relaunch itself is lane 4's code, which this lane does not edit.

**Consequences.**
- **Rehearsals on this server, 2026-10-22, on the fake adapter, 4-minute nights:**
  - **Run 1:** steps 0 to 6 and 8 passed. Step 7 failed on the proof's own wait for the inbox's detail.
  - **Run 2:** the approval answered 409 ("no request for agreement is kept"), because the lock stand-in kept no request for agreement. That led to the `validations` record (choice 10).
  - **Run 3** (after merging `origin/v2` with lane 10) passed all 9 steps in 12 minutes:
    - one question; a plan of 5 items, notified 16 s after it was proposed;
    - at most 2 tickets live;
    - in the morning, 2 releases and 1 permission waited;
    - the permission was denied, and the 5 releases were approved and merged one by one, each with its 60-second grace;
    - 2 refreshes, highest share 4.5 % (threshold 5 %);
    - both planted commitments done, the reminder fulfilled 5 s after its due time;
    - 7 notifications (plan 1, approval 5, permission 1), 11 owner gestures.
    Its "3 after 2" read as broken, wrongly: a landing seen by a reading 90 s late. This led to the ledger's landing time and to readings during the morning's waits (choice 2).
  - **Run 4**, with `PROOF_NOTIFICATIONS=skipped` as the real run will have it: 9 steps ok and step `3 notifications` skipped. The plan was done 12 minutes after the goal. Both commitments were done, and every "after" was kept: item 3 started 25 s after item 2 landed, item 5 8 s after item 3. No login cut. The plan's own notification was not sent in this run: the dispatcher's first tick sends nothing (v1's rule), and the plan came before its second. The real run should start the service well before the goal.
  - **Run 5**, on the final code, notifications skipped: 9 steps ok, 1 skipped, none failed. Step 4 recorded the planted commitments' ids (c1, c2), and step 8 found both done. Every "after" was kept.
- **Captures and results** are in `/tmp/cleared-captures/j2/rehearsal/` (mode 644, the pointer moved off the buttons), with `durations.md` and `result.json`. Each rehearsal folder (`/tmp/cleared-j2-rehearsal-*`) is kept for reading, its password file removed.
- **No screen changed**, so the lane ran no visual loop.
- **Not proven here:**
  - The real run: a model, the real lock and release watch, the forge, a deployment, a login cut. That is the milestone proof, by the orchestrator, after wave 4.
  - A real login cut: the rehearsal's cuts are events of the adapter's shape played by the fake adapter (F3).
  - The inbox's plan approval (lane 10) is in `morningAction`, but the rehearsal approves the plan from the lead screen, as section 8 says.
- **Real run settings:**
  - `PROOF_PASSWORD_FILE`, `PROOF_PLAYWRIGHT`, `PROOF_CHROME`, and `PROOF_LEDGER` (the service's `ledger.db`) for the counts.
  - `PROOF_MORNING` if the morning is not the next 08:00.
  - `PROOF_OWNER_APPROVES=1` if the owner approves in the morning.
  - `CLEARED_V2_LEAD_CONTEXT_PERCENT` for the threshold the report prints.
- **Review round 1 of PR 181 (changes asked).** Each blocking point now has a test that fails on the code before it.
  - **B1.** The lead's generation 1 starts with the service, before the goal. It was left out of the lead's cost, turns, highest share, compactions and login cuts, because only sessions created after the goal were read. A lead session now counts when it has any event after the goal. The highest share is the larger of the ledger's and the lead's own record (`highestShare`), not the first one known.
  - **B2.** The checkout rule (choice 6). The review's three commands, a newline before `curl`, `& curl` and `find -exec curl`, are now denied with many more like them.
  - **F2.** Each reading counts the notifications alone (`notificationCount`), so the whole ledger is read once, at the end, not every few seconds for 48 hours.
  - **F3.** The rehearsal scripts two login cuts: one on the lead's generation 1, in the turn that takes the plan's approval, and one on the second author. Each is relaunched by its next turn, so the count is read from a real ledger. The scripted lead gained an `emit` act for this.
  - **F4.** The script exits with 1 when a step failed; a skipped step leaves 0.
  - **F5, F6, F7.** The report says how a cut is read and its blind spot after a restart; comments name `v2/images/session/runner/main.ts`; with notifications skipped, the count the service still recorded is said to be for the record only, not a pass or a fail.
  - **Rehearsal 6**, after these fixes, notifications skipped: 9 steps ok, 1 skipped, none failed.
    - The lead's figures now include generation 1: 3 generations live after the goal, 15 turns, $0.60 (15 times the script's $0.04). Before, they were 8 turns and $0.32.
    - The two scripted cuts were counted and relaunched, the lead's with the role `lead` (generation 1) and the author's.
    - Both planted commitments were done and every "after" was kept.
- **Files.** Section 8 names `proof-j2.ts` and `proof-inbox.ts`. Section 9 gives this wave `v2/scripts/proof-*.ts`, and the lane used that room:
  - `proof-report.ts` and `proof-rehearsal.ts` are new;
  - `proof-j1.ts` gained one change: it judges the command chip with the narrowed rule.
  Beyond those, the lane edited `v2/src/session/adapters/index.ts` and its tests under `v2/test/scripts/`. This entry is the only change outside the lane's files.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j2-proof-script`.

## 2026-10-22: Owner decision: the v2 interface moves to React, with CopilotKit for the chat

**Decision.** On 2026-10-22 at 06:29 (Europe/Paris), the owner decided that the v2 interface moves to React, with CopilotKit for the chat:
- open source packages only: no Copilot Cloud, no public API key, nothing sent to CopilotKit's servers;
- CopilotKit's telemetry turned off, with every opt-out set, and a test or a check that no request leaves for CopilotKit's hosts;
- a justified exception to "no build": Vite, for the front end only. The service stays native TypeScript (erasable syntax, no build).

- Author: the owner, relayed on 2026-10-22 06:29 (Europe/Paris); written in this log.

## 2026-10-22: Owner decision: shadcn/ui as the component library

**Decision.** On 2026-10-22 at 06:30 (Europe/Paris), the owner decided that shadcn/ui is the component library of the v2 interface:
- the components are copied into the repository (Radix plus Tailwind);
- light and dark themes go through the shadcn CSS variables, keeping the current colours and the Geist font, with no gradients;
- English by default, translatable to French;
- no generic shadcn look: the interface keeps the identity of the kit's mockups.

- Author: the owner, relayed on 2026-10-22 06:30 (Europe/Paris); written in this log.

## 2026-10-22: Owner decision: Phosphor icons everywhere

**Decision.** On 2026-10-22 at 06:30 (Europe/Paris), the owner decided that the v2 interface uses Phosphor icons (`@phosphor-icons/react`) everywhere, instead of shadcn's default Lucide, in one consistent weight: regular, and bold only for active states if needed.

- Author: the owner, relayed on 2026-10-22 06:30 (Europe/Paris); written in this log.

## 2026-10-22: the v2 interface in React, with CopilotKit, shadcn/ui and Phosphor (the author's choices, lane j2-react-port)

**Decision.** These are the author's choices for applying the three owner entries above, not the owner's decisions. Lane `v2-j2-react-port` ports the tower, the session, the lead and the inbox screens and the sign-in page to React with strict TypeScript, with the same routes, the same server checks (anti-forgery token, origin, host, password session) and the same look. For the page's code, it supersedes the 2026-10-21 entry "the browser runs the app's TypeScript with its types stripped": the service and the app's server still run that way.

1. **Where the code is.** The React front end is `v2/app/web/` (Vite's root, its own `tsconfig.json`). Vite builds it into `v2/app/dist/`, which git ignores. `v2/app/public/` stays Vite's public folder, so the fonts, the icons, the manifest and `sw.js` keep their addresses and the guard's binary exclusions. The theme script is now plain `theme.js`: it must run before the bundle.
2. **The server writes each page.** For each route it writes the HTML: the language, the title, the screen and what the header shows first (`<body data-screen data-project data-user data-source>`). It names the bundle's files from `dist/.vite/manifest.json`, and preloads the screen's chunk with its sheets, the imported ones first (the lead's sheet before the inbox's, which adapts the plan panel). Without a build, a page answers 503 and `app/main.ts` stops at once; both say to run `npm run build`. The sign-in form still posts to `/login`. A refusal comes back with the server's sentence on `<body data-error>`, since the page runs no inline script. The CSP is unchanged.
3. **Same markup.** The components render the classes, ids and data attributes of the HTML renderers, so the kit's sheets apply as they are and the proof scripts' selectors still match (`#timeline [data-row]`, `[data-act="approve_plan"]`, `#plan-side [data-plan][data-state]`, and the others). Each screen keeps its own chunk and sheet, as each screen loaded its own sheet before. The rules are in each screen's `model.ts`, as pure functions, and the components draw them.
4. **shadcn/ui.** Button, Input, Textarea, Popover and Toggle are copied into `app/web/components/ui/` and restyled. The theme is shadcn/ui's variables (`--background`, `--card`, `--primary` ...) with the kit's colours, light and dark under `data-theme`; the kit's roles (`--canvas`, `--surface`, `--ink` ...) are read from them. Tailwind brings its theme and utilities in layers, without its preflight. The kit's sheets stay unlayered, so they win, and a component's base sets nothing they would have to undo (no gap, height or alignment). The notifications and avatar menus are non-modal Popovers instead of `<details>`: a modal popover locks the scroll with an injected `<style>`, which the CSP refuses.
5. **Phosphor**, regular weight: the bell (bold while this device is told), the moon and the sun, the inbox's back arrow, the timeline's marks (read, edit, run, search, fetch, delete, move, refused, interrupted, error, verdict) and the criteria's marks. They replace the drawn SVGs and the text glyphs. The brand's triangle stays: it is the logo, not an icon.
6. **CopilotKit.**
   - The version is 1.77.2, pinned exactly; it was two weeks old on this date.
   - Only the headless entries of `@copilotkit/react-core` are imported (`/v2/headless`, `/v2/context`). A `CopilotKitCoreReact` with the screen's agents is provided through CopilotKit's own context, with no runtime URL, no public API key and no license key. The root and `/v2` entries would bring CopilotKit's stylesheet, its prebuilt chat (Lucide icons) and its inspector (Google Fonts).
   - Each thread is an AG-UI agent (`AbstractAgent` of `@ag-ui/client`). The session's agent follows the session's stored AG-UI events. The lead's agent follows the lead's stream, whose frames are not AG-UI. `connect()` opens one AG-UI run for the screen's life and publishes the thread as STATE_SNAPSHOT and MESSAGES_SNAPSHOT events. The screens read them with `useAgent`.
   - Snapshots, not the stored events: AG-UI's verifier refuses a stream that starts inside a run or carries several runs, which a stored session does.
   - The person's words, answers and gestures go through the app's routes, as before. `run()` refuses.
   - Not used: CopilotKit's chat components (their look and Lucide) and `useHumanInTheLoop`, since the harness's questions are not front-end tool calls.
   - Risk: local agents go through `agents__unsafe_dev_only`, CopilotKit's only path without a runtime, and a later version may change it. `app/web/test/copilot.test.tsx` holds the behaviour.
7. **Every opt-out**, and what checks it:
   - `v2/.npmrc` runs no install script, and `scarfSettings.enabled = false` turns off `@scarf/scarf`, which CopilotKit pulls in.
   - The CI job sets `SCARF_ANALYTICS=false`, `DO_NOT_TRACK=1` and `COPILOTKIT_TELEMETRY_DISABLED=true`. Vite defines the same, and `NODE_ENV=production`, so the inspector never mounts.
   - `@copilotkit/web-inspector` is replaced by an empty module at build time.
   - Telemetry lives in CopilotKit's runtime package, which is not installed. The built page names `telemetry.copilotkit.ai` only in a list of addresses CopilotKit's capture ignores.
   - The test runs the core with both agents while `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` and `sendBeacon` are watched, and requires no request at all. A planted request makes it fail.
   - In Chromium, every capture logged its requests: none left the app's origin.
8. **zod** is one copy (an `overrides` entry), set to `jitless` before any schema is built. Otherwise zod probes `new Function`, which the CSP reports, since it allows no eval.
9. **The catalogs** are the same files, bundled into the page by screen. A key missing from French falls back to English, as on the server. `/messages/<screen>.json` is still served. The catalog test now reads every file of a screen's folder and of the shell.
10. **Tests.**
    - The models' tests stay under `node --test`.
    - The renderers' tests moved to `app/web/test/` and run under Vitest, under Node, with the components rendered to HTML (`react-dom/server`). The helper drops shadcn/ui's `data-slot` and utility classes, so the assertions read the kit's classes. Assertions on exact markup were rewritten for attribute order.
    - Counts: 183 app tests before the port; 87 under `node --test` and 101 under Vitest after it, the three CopilotKit tests and two server tests added.
    - `npm test` builds first.
11. **The guard.**
    - Its git calls get a 256 MB buffer: the lock file's diff passed Node's 1 MB.
    - The strict diff pass leaves out `v2/package-lock.json`. There, the "assigned secret" rule reads the dependency js-tokens, followed by its version range, as a secret. The tree pass still checks the whole file.
12. **Dependencies.** All are dev dependencies: the service and the app's server still have no runtime dependency, and the rest is types, tools or code Vite bundles. The pull request lists each with its licence and size. The 598 installed packages are MIT, ISC, Apache-2.0, BSD, MPL-2.0, 0BSD or Unlicense. Two have other forms, both open source. `@bufbuild/protobuf` (through AG-UI's client) is Apache-2.0 AND BSD-3-Clause. `khroma` declares no licence field, but its licence file is MIT; it comes in through CopilotKit's markdown renderer (streamdown, mermaid), which the headless entries do not bundle.

**Consequences.**
- **Captures**, none committed, in `/tmp/cleared-captures/j2/`:
  - `before-<screen>-<width>-<theme>.png` were taken at `a31851c` before any change, and `after-*.png` on this branch, at 1440, 1280, 768 and 390, light and dark. The screens are tower, session, lead, inbox, inbox-plan (the plan selected) and login: 48 of each.
  - The app ran on ephemeral `127.0.0.1` ports, with each screen's fixture source and a fixed clock.
  - Pair by pair, every page has the same size. At most 0.12 % of the pixels differ, and only the Phosphor icons account for it.
  - Both runs logged the same 24 errors, a 404 of `/api/service/lead` from the two fixture sources without the lead's routes. Neither run had a CSP violation, a request off the origin, or horizontal overflow.
- **Behaviour in Chromium**, against the fixture sources: 51 checks across the sign-in, the tower bar and its draft to the lead, the lead's goal, memory, Change and Approve, the session's answer, message, interrupt and hand-over note, the inbox's grace, Undo, Send back, frame switch, deny with a reason, answer and plan approval, Escape, and sign out. The lead's waiting question was answered by its option button. `app/test/notify/browser.test.ts` passes (the worker, subscribe and unsubscribe through the menu). No page error.
- **Size.** The shell's chunk is 122 kB gzipped (React, Radix, the shell). The CopilotKit chunk is 156 kB gzipped (CopilotKit's core, AG-UI's client, rxjs, zod) and loads on the session and lead screens only.
- **The art director's pass** was run once, by Sonnet 5.5 in a fresh session, on the after captures and the kit's references.
  - Taken: 44 px targets on a phone for the brand, "Open inbox", "Open session" (43 px before), the lead card's title, the lead pill, the crumbs and the other plans. Each uses padding cancelled by a negative margin, or a pseudo-element, so the captures do not change.
  - Not taken: the phone header's two rows, the kit's light grey for placeholders, non-breaking spaces in figures, the inbox bar's 46 and 44 px buttons, the tower bar's button order and the dark selection ring. They are the kit's current design, identical before the port, and outside a like-for-like port.
  - Not a fault: the sticky bar over the last plan item is the full-page capture of a sticky bar, as lane 10 noted. The lead pill missing on the session and inbox captures comes from their fixture sources, which have no lead route.
- **The plans' file lists** (milestone 1 and 2) still name `v2/app/public/screens/*.ts`. Those files are now `v2/app/web/screens/<screen>/`.
- **A v1 test.** `test/tracker.test.mjs` reads every tracked `.json` for a tracker provider's name or query. It now leaves out npm's lock files: v2's names the `graphql` package, which CopilotKit pulls in, and no tracker.
- Files outside the app: `test/tracker.test.mjs`, `v2/scripts/guard.ts`, `.github/workflows/v2.yml`, `v2/README.md`, `v2/package.json` and its lock file, `v2/.npmrc`, `v2/.gitignore` and this log.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j2-react-port`.

## 2026-10-22: Fable 5.1 used once to replan milestone 2

**Decision.** Fable 5.1 was used once more, on 2026-10-22 at 07:05 (Europe/Paris), to replan what remains of milestone 2 after the owner's decisions of the same morning: the interface moves to React with CopilotKit, shadcn/ui and Phosphor (06:29 and 06:30), a workspace is several services ([complement-multi-depots.md](complement-multi-depots.md)), and the two complements are integrated into the milestones (06:45). Reason: the migration of the project to a workspace of services touches the ledger, the containers and the lock at once, which is the strong-planning case the "model choice per lane" entry allows. Brief rule 10 asks for the owner's explicit request for any use of Fable: the orchestrator's brief for this session named the model, and the orchestrator confirms that request, with its date, in its next report. The session wrote no code and reviewed nothing; it edited three documentation files and this log only.

**Consequences.**
- [milestone-2-plan.md](milestone-2-plan.md) is rewritten for what remains, in the owner's order: the React port (lane 12, merged as pull request 184 on 2026-10-22 while this plan was under review), the clickable answers on CopilotKit keeping the AG-UI question format (lane 13), the data model migration to workspace and services with a tested SQLite migration (lanes 14 to 16), the milestone 1 catch-up (complement items 1, 8, 9, 10 and multi-repository items 1, 3, 5, 8: lanes 17 to 22), the milestone 2 additions (complement items 2, 7, 11, 12 and multi-repository items 2, 7, 9: lanes 23 to 27), then the proof (lanes 28 and 29). Eighteen lanes in seven waves of at most three, numbered 5 to 11 after the first plan's four; each lane names its model, its files with no overlap inside a wave, its dependencies, its tests first and its acceptance proof. The plan takes decisions 16 to 31, numbered after the first plan's fifteen, which the lanes implement and copy here as they land.
- The proof is extended: the 48-hour guestbook proof keeps its eight steps, read from the inbox only, the Mac notifications skipped until the https question is answered, the runner relaunched on a revoked token with each cut counted; and a multi-service proof on a second example, a small filter API the guestbook consumes, shows a contract validated, a fake service, an integration step, a single release card, an ordered landing, a rollback in reverse order on a provoked failure and a blocked card for an untouched consumer. No repository is created by a lane: the second example's repository is the owner's question 1 of the plan, with options and a recommendation.
- [requirements-matrix.md](requirements-matrix.md) is created: every requirement of the brief, of the owner's decisions and of the two complements, with its milestone, the pull request that delivers it, the test that proves it and its status; the merged lines are filled from pull requests 118 to 181. Its rules: it is updated at every merge into `v2`, and checked line by line before every merge of `v2` into `main`, where no line of the milestone may lack a green test.
- The quota cost of the replan is estimated from the measured cost so far (about 4 points of the weekly quota per wave of three lanes, milestone 1 and waves 1 to 4 included): about 34 points in all, 26 of them for the seven waves, the rest for the fix lanes and the two proofs; the orchestrator reads the week's share before each wave and each proof, and the waves that do not fit under 85 % wait for the week's reset (decision 31 of the plan).
- The three owner entries on React, CopilotKit, shadcn/ui and Phosphor landed with the React port (pull request 184); this lane's merge of `origin/v2` kept both tails of this log, the port's entries before this one. This entry does not repeat them.
- The clickable answers branch (`v2-j2-choices`, three commits, on hold) is not merged: its component was built on the old front end; lane 13 rebuilds it on the React port and keeps its model tests and the lead's prompt rule on options.
- Review round 1 (Opus 5.5) asked for changes, taken on 2026-10-22: both proofs run after the last wave, as the brief asks, and an early run is only a question; no lane depends on a lane of its own wave, the API shapes being written one wave ahead by the lane that owns `v2/src/api/types.ts` in each wave, and the proof lane runs alone in wave 11; no lane needs a file another lane of its wave owns; the trial environment is served from a separate loopback origin, sandboxed, without the owner's credentials, so a page a session wrote can approve nothing; a sibling is built in two layers, the ticket layer with no network and no instruction from the branch; the login decision's scope for the second example is a part of question 1 with no default, and until then no session runs on it; the brokers share one ledger through `ORCH_LEDGER` with one state folder each, and no file under `serve/` is edited. The requirements matrix gained the owner's decisions of 2026-10-22 (`O` lines), the proof lines of milestones 0, 3, 4 and 5, the brief's process rules, and marks B3.10, B6.1 and M2 partial. Review round 2 (Sonnet 5.5), taken the same day: the `contract` and `knowledge` inbox kinds are built by lane 17 in wave 7, and lanes 23 and 24 only call them; the preview's operation is specified (the app's `frame-src`, a public preview origin setting, the app's own proof towards the service, an unguessable per-session address); the paused state is lane 20's in the engine; the backup copies are 0600, timestamped and removed by the owner only; the proof's morning rule gives Go to a session plan item. Review round 3 (Sonnet 5.5), taken the same day: lane 16 makes the release item and the publish step carry optional groups and flags from a `release/flags.ts` function with an empty default, and lane 18 only fills that function; the author's own pass over every lane goal against its files then moved to the lane that owns the file: the `plan_gate` step name (lane 17, `flow/state.ts`), the sensitivity validation (lane 14), the ticket creation with services and the preview key column (lane 14), the preview key's issue (lane 15), the contract step's file restriction as a diff check in the flow (lane 23), the reader's own session start (lane 25), and the schedule's budget on `Origin` (lane 26, which owns the engine in wave 10). Review round 4 (Sonnet 5.5), taken the same day: lane 16 fixes the signature `flags({ diff, report })` with the report optional, and its publish step reads the session's last `cleared.changes` journal event by its name; lane 17 only writes that event, and validates the report in the tool that writes it. Review round 5 (Sonnet 5.5), taken the same day, after pull request 184 merged: lane 12 is recorded as merged and dropped from wave 5, decision 16 states the port's facts from its log entry (Vitest for the component tests, the models under `node --test`, `npm test` building first), the app lanes' test folders name both places, the quota drops to about 32 points, and the matrix rows the port delivers are done.
- Author: Fable 5.1 (claude-fable-5-1), lane `v2-j2-replan`, at the orchestrator's request.

## 2026-10-22: the filter API example, the guestbook as its consumer, and the workspace file (milestone 2, lane 28)

**Decision.** Lane `v2-j2-filter-api-example` builds the second example of the multi-service proof (plan section 2.2, lane 28) and takes these choices, which the plan leaves open:

1. **The owner's answer to plan question 1, option (a), received during this lane on 2026-10-22.** The filter API has its own public repository, `cleared-example-filter-api`, in the organisation this repository lives in, Apache-2.0, created by the orchestrator on 2026-10-22 with a short README on `main`. The read-only Claude Code login of the owner's decision of 05:05 is also allowed on this second example, so the multi-service proof and lane 15's doctor run may start sessions on it. The code stays in `examples/filter-api/` and is copied to that repository by hand, as the guestbook's is: this lane pushed a branch `seed` there, built from this branch's `examples/filter-api/` (commit 8f57eda), and opened its pull request 1 against `main`; it never pushed to `main` and the merge is the owner's.
2. **The filter API listens on 8795.** `ss -ltn` on this server on 2026-10-22 at 08:30 showed it free; 80, 443, 8787, 8788 and 8790 to 8794 are refused by its configuration. The deploy watcher publishes `127.0.0.1:8795` only and `[release] health_url` probes it.
3. **A word is a run of letters and digits, in any script, compared whole and case-folded.** "spam" matches "SPAM" and "spam-free", never "spammer". The answer names each listed word found once, in the order of the text. A line of `words.txt` that is not one word stops the app at its start, so a typo is never a word that matches nothing.
4. **The contract's examples are the app's answers.** `contract/openapi.yaml` is OpenAPI 3.1 with named `examples`; `test/contract.test.ts` sends each request example of `POST /check` to the app and requires the response example of the same name, and checks every example against its schema. The first answer of `POST /check` is an accepted text (`ok: true`), so a fake built from it lets the guestbook store entries in a trial; `/health` has an example too, so the fake does not answer it 501. The path the fake reads is: the operation's `responses`, its first 2xx, `content`, `application/json`, then `example`, or the first entry of `examples` and its `value` (lane 15).
5. **The contract keeps to a small block subset of YAML, read with no dependency.** Two spaces per level, mappings, sequences of scalars only, plain or quoted scalars, `true`, `false`, `null`, whole numbers, the empty `[]` and `{}`, comments on their own line. `test/helpers/yaml.ts` reads it and refuses anything else with its line, so the file cannot drift out of what a dependency-free fake reads; lane 15 may copy that reader. The other choice, YAML written as JSON, was left: the owner validates the contract's diff in the inbox (proof step 3), and a block diff reads better.
6. **The guestbook consumes the filter only with `FILTER_URL`, and never stores an unchecked entry.** Set, each entry's name and message are sent as one text (`<name>\n<message>`) to `POST /check` after the form's own checks; a refusal is a 400 page naming the words with the form kept; a filter that answers anything but the contract's 200, or nothing within 2 seconds, makes the entry a 503 with the form kept, and nothing is stored. Unset, the filter is never called. `/health` still checks the database only: a filter that is down must not fail the guestbook's release watch and blur the train's rollback order. `FILTER_URL` must be http or https with no credentials, query or fragment, and a wrong value is never echoed.
7. **`PROOF_BREAK_HEALTH` lives in the guestbook's `src/config.ts`, `false` as committed.** Proof step 8 needs a change a session makes and a merge deploys: the guestbook's watcher passes no extra environment and its Dockerfile is not this lane's, so an environment switch alone could not be turned on by a ticket. The proof's second ticket sets the constant to `true`; `/health` then answers `503 {"status":"broken","reason":"PROOF_BREAK_HEALTH"}` while the page still works. `PROOF_BREAK_HEALTH=1` in the environment turns it on by hand. The filter API has no such switch: the proof breaks the guestbook only.
8. **The three proof tickets** are written in the guestbook's README as the owner will create them: the held entry (a contract change on both services), "casino" refused with the words in bold plus the switch (both services, no contract change: the provoked failure), and the words' positions on the filter API only (the blocked card). The filter API's README says what each changes there.
9. **The watcher is the guestbook's, without the database**, with its own labels (`cleared.dev=v2`, `cleared.example=filter-api`) and names (`cleared-filter-api`), so neither watcher's labelled listings or image removal can touch the other's objects. The crash-loop case of issue 131 is handled as the guestbook's (an app of the head that is `restarting` is not rebuilt) and tested. The Dockerfile has no `RUN` step: no runtime dependency, which also suits decision 20's ticket layer.
10. **The workspace file's keys** (`examples/workspace.conf`), which lane 14 parses in the same wave: `[workspace]` with `id` and `name`; `[service <name>]` with `kind`, `repository`, `url`, `base`, `path`, `health_url`, `sensitivity`, `consumes` (comma-separated names), `run`, `contract` (`openapi:<path>`), `broker_socket` and `broker_state`. `run` is a Dockerfile path and a port separated by a space (`run = Dockerfile 8793`). The id is `guestbook`, the project value the rehearsals and tests use; a server whose `CLEARED_V2_PROJECT` names another puts that name in its copy. The repositories are written `example-org/...` and the broker paths are a proposal, so that no organisation name is in this repository: the server's copy names them. Lane 14 aligns its parser to these names or corrects this file.
11. **`.github/workflows/examples.yml`** runs both examples' install, tests and types on pull requests to `v2` and pushes to it that touch `examples/` or the workflow, the guestbook against a `postgres:16` service container with trust authentication. Its actions and the filter API's own `checks.yml` are pinned to commits (`actions/checkout` and `actions/setup-node` v4.4.0, resolved with `gh api` on 2026-10-22), as issue 131 asks; the guestbook's own `checks.yml` is not this lane's file and keeps its tags.

**Consequences.**
- `examples/filter-api/` has no runtime dependency. Its devDependencies are `typescript` 7.0.2 and `@types/node` 24.19.2, pinned as in the guestbook, for `tsc --noEmit` only. The guestbook gains no dependency: its client uses Node's `fetch`.
- The deployed guestbook does not reach the deployed filter API: its watcher runs it on its own network and passes no `FILTER_URL`. The proof's landing and rollback do not need it; a run where the live guestbook calls the live filter needs the guestbook's watcher (or the orchestrator's setup) to pass `FILTER_URL` and join a network both reach, which is not a file of this lane.
- The guestbook's changes (`src/`, `test/`, `README.md`) are copied to its own repository by the orchestrator after the merge, as the decision of 2026-10-21 says, and logged. The orchestrator installs the filter API's watcher and starts its broker on this server before the multi-service proof.
- Checked on this server: the filter API's image built from this directory with both labels, run on `127.0.0.1:8795`, answered `/health` and `POST /check`, then its container and image were removed by label; the guestbook's tests ran against a labelled `postgres:16` on `127.0.0.1:55433`, removed after.
- Files outside `examples/`: `.github/workflows/examples.yml`, this log and the requirements matrix (rows B3.1, B3.2, O1, B6.2m, and the new O7, P10 and P11).
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j2-filter-api-example`.

## 2026-10-22: the workspace and its services in the store, and the versioned migrations (milestone 2, lane 14)

**Decision.** Lane `v2-j2-workspace-store` applies decisions 18 and 19 of the [milestone 2 plan](milestone-2-plan.md) in the store and the configuration, and writes the API shapes of waves 5 and 6. The lane's choices:

1. **Migrations.** `v2/src/store/migrations.ts` holds the ordered list; `v2_schema` (version, applied at) records what ran. Version 1 adds `service` and `preview_key` to `sessions` and `service` to `session_events`; version 2 adds `service` and `step` to `flow_inbox`. The `CREATE TABLE` statements of milestone 2 are not edited: on a fresh ledger the tables are made as before, then migrated, so one path is tested. Each migration names the tables it needs and runs, in one `BEGIN IMMEDIATE` transaction, only once they all exist. `openStore` runs those of its own tables and `applyTables` those of the tables it has just created. The list stops at the first migration whose tables are missing: the app and the user command call `applyTables` with a few tables only, and must not record a version whose table the service creates later. Inside the transaction the version is read again, so two processes starting at once apply a migration once. Each step checks `PRAGMA table_info` first, as `lib/tracker/adapters/local.mjs` does.
2. **The copy before the first migration of a start.** `VACUUM INTO` with a bound file name, outside the transaction and before `v2_schema` exists, so the copy is the ledger as it was. It is named `ledger.db.before-<version>-<time>` (the time in UTC to the millisecond, without separators), next to the ledger. The store creates that file itself first, exclusively and 0600, and `VACUUM INTO` fills it (it accepts an empty file): the copy holds the users' password hashes and is never readable by others, whatever the umask or the folder's mode. A file already at that name is refused. A ledger with no row in any table is not copied (a fresh install has nothing to keep). One copy per database handle per process. The code never reads or removes a copy. A copy that cannot be made stops the migration before anything changes.
3. **Exit 64 without editing `main.ts`.** `main.ts` calls `applyTables` outside its `orExit`. So `applyTables` itself prints `cleared-v2: <message>` and exits 64 on a `MigrationError`, as `modules/sessions.ts` already does for a badly set up project. `migrate` throws, for the tests. A failure in `openStore` is a `StoreError`, which `orExit` already turns into exit 64. A ledger whose `v2_schema` is newer than the code is refused, not used.
4. **The workspace's tables** (`workspaces`, `services`, `ticket_services`) are `WORKSPACE_TABLES` of the tickets module, apart from `TICKET_TABLES`, which a test keeps identical to v1's. `LocalTicketStore` also creates `ticket_services` itself, so a store opened on the tracker tables alone (the approval's tests, a v1 tool) reads and writes a ticket's services. `ticket_services.ticket` is `LOCAL-<n>`, as the v2 tables name tickets. A ticket names its services only when they are given: a ticket with no `ticket_services` row has no `services` field, and reads exactly as in milestone 1. In a one-service workspace it is on that service.
5. **The workspace rows** are written by the tickets module's `provide`, from the configuration, at every start: an upsert that keeps each row's creation time, so a second start changes nothing. A service removed from the file keeps its row: nothing is deleted. A badly set up workspace stops the service with exit 64, as a badly set up project does.
6. **The workspace file.** The keys are decision 18's columns, written `kind`, `repository`, `url`, `base`, `path`, `health_url`, `sensitivity`, `consumes`, `run`, `contract`, plus `broker_socket` and `broker_state` (decision 21) and `dir`. `dir` is the service's checkout on this server, where the flow reads its `.cleared/agents.conf` at the base branch, as `CLEARED_V2_PROJECT_DIR` is today. It defaults to `<CLEARED_V2_STATE_DIR>/services/<name>/checkout`, beside the memory folders of decision 25. `run` is the Dockerfile's path and its port, as `Dockerfile:3000` or `Dockerfile 3000`. `contract` is `openapi:<path>` only (question 5's default). An unknown key or section is refused, as are: an unknown kind; a folder without `path`, and a `path` on a repository; a path outside the repository; a `consumes` naming no service, the service itself, or a cycle (the landing order needs providers first); a sensitivity naming no user or no model; and a `reviewer:<model>` equal to the configured author model. A service name is lower case, digits and dashes, at most 40 characters: it is a path segment and a container's name. Lane 28's `examples/workspace.conf`, written in the same wave on its own branch, was read on this server and parses as it is (its `dir` defaults).
7. **Which variables win.** With `CLEARED_V2_WORKSPACE` set, the file is the workspace. `CLEARED_V2_PROJECT` may be set too only if it equals the file's id; otherwise the service refuses to start, since the two would name different rows. The milestone 1 fields of `FlowConfig` (`project`, `projectDir`, `repo`, `repoUrl`, `base`) name the workspace's id and its first service, until lane 16 publishes per service. `FlowConfig.workspace` is optional in the type, so the configurations other lanes' tests write still compile. `workspaceOf(config)` gives the one-service workspace of their fields. `parseConf` moved to `workspace/config.ts` and is exported again by `flow/config.ts`, so the imports go one way.
8. **The sessions' new columns in the store.** `SessionRecord` gains optional `service` and `previewKey`, read back as null when unset. A put that leaves them out keeps them (`COALESCE`), so the engine's status updates never erase them. An event's `service` is its session's, filled by the insert itself, so the event log's type does not change. Lane 15 stores the preview key through `store.sessions.put`.
9. **The API shapes.** Additive and optional where other lanes' files build the type as a literal:
   - wave 5: `Workspace`, `Service`, `Ticket.services` (`TicketService`: name, branch, pull request, state, `open` at creation), `SessionSummary.service`, `SessionDetail.previewKey` and `GET /api/workspace`, which the tickets module serves (modules claim routes by path) without the server's paths;
   - wave 6: `ReleaseItem.train` with `TrainState` (`blocked`, `waiting`, `landing`, `landed`, `rolled_back`; the services in landing order, each `waiting`, `merged`, `healthy`, `failed` or `reverted`; the compatibility line; the block's reason and proposal), and `GET /api/sessions/:id/preview/*` in `API_ROUTES`, named `SESSION_PREVIEW_ROUTE`.
   `POST /api/tickets` takes `services`: a non-empty list of the workspace's service names, each once, or nothing.
10. **One file outside the lane's list.** `v2/test/flow/api.test.ts` requires the flow's API to declare every route of `API_ROUTES` but the approval and the lead's. The plan puts the preview route in `API_ROUTES` and gives it to lane 15, so that test leaves out `SESSION_PREVIEW_ROUTE` as it leaves out the approval (two lines).

**Consequences.**
- Tests first, each failing on `origin/v2` at `50faee9` (the modules and exports did not exist): `test/store/migrations.test.ts` (the fixture ledger `test/store/fixtures/ledger-m2.sql`, made on that commit, its tickets, sessions, events and policy rule through the real stores and its plan, inbox and lead rows as plain inserts, migrated and compared by content, its copy, a second start, the v1 reader through `test/store/v1-list.mjs`, a throwing migration in process and through `test/store/failing-start.ts` with exit 64, a fresh ledger, a partial caller, a newer ledger, the sessions' columns); `test/tickets/services.test.ts`; the workspace tests in `test/flow/config.test.ts`; the shapes and the 25 routes in `test/api/types.test.ts`.
- `npm test`: 687 tests under `node --test` (686 pass, 1 skipped as before) and 101 under Vitest; `npm run typecheck` and the guard pass. The registry still has eight modules.
- The rows of [requirements-matrix.md](requirements-matrix.md) this lane delivers: M0 and P1 done, M1 partial (the three memory levels are lane 19's), M8 names this lane for the parsing and the validation.
- Review round 1 (Sonnet 5.5) passed, with followups, taken on 2026-10-22, each with a test that failed before the fix:
  1. `v2_schema` is created inside the first migration's transaction, so a failing migration leaves the ledger exactly as it was.
  2. A service's `url`, from the file or from `CLEARED_V2_REPO_URL`, is refused when it carries credentials (a user or a password on an http address, a password on any other), with a message that does not repeat it. A clone authenticates through git's credentials. `GET /api/workspace` and the `services` rows never hold a secret. `git@host:owner/name.git` stays accepted.
  3. The service of a one-service workspace is named by the service name rule from the project value (`My_Project.v2` gives `my-project-v2`, at most 40 characters, `service` when nothing is left), so lane 15 can use it as a path segment and a container's name. The workspace's id stays the project value.
  4. The copy is created by the store, exclusively and 0600, before `VACUUM INTO` writes into it.
  5. A test forces the copy to fail (a file already at its name): nothing is migrated, not even `v2_schema`.
  6. For lane authors: `applyTables` exits the process on a failing migration (exit 64), since `main.ts` is not edited. A test that needs a failing migration calls `migrate`, which throws, or runs `applyTables` in a child process, as `test/store/failing-start.ts` does.
  The merged `examples/workspace.conf` of lane 28 is parsed by a test.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j2-workspace-store`.

## 2026-10-22: Owner decisions on the milestone 2 replan's questions 1 to 7

**Decision.** On 2026-10-22 at 08:27 (Europe/Paris), the owner answered the seven questions of the replan ([milestone-2-plan.md](milestone-2-plan.md), section 6):

1. **The second example repository: (a).** The repository `cleared-example-filter-api` is created, and the read-only login (the owner's decision of 05:05) is allowed on it.
2. **The Mac notifications: (b).** No Mac notifications in the proof; the step is recorded as skipped.
3. **Taking over a session: (b).** A web terminal in the app: the human types into the session's container, with Take over and Give back. The owner asked for an addendum to milestone 2 if this changes the split of the lanes: the web terminal is in milestone 2, not in the later milestone the question's option named.
4. **The Editor tab: (b).** An editable Editor tab; the session is told of the human's changes.
5. **The contract formats.** OpenAPI 3 in milestone 2; JSON Schema, protobuf and events in milestone 3.
6. **Approved knowledge into the skill: (a).** A daily fast-lane ticket per service writes the skill file, through the lock.
7. **An early run of the 48-hour proof: (a).** The final run only, once every lane is merged.

- Author: the owner, relayed on 2026-10-22 08:27 (Europe/Paris); written in this log.

## 2026-10-22: how the owner's answers of 08:27 are applied (the author's choices, lane v2-j2-plan-addendum)

**Decision.** These are the author's choices for applying the owner entry above, not the owner's decisions. The lane edited three documentation files and wrote no code: [milestone-2-plan.md](milestone-2-plan.md), [requirements-matrix.md](requirements-matrix.md) and this log.

**Consequences.**
- **The plan takes decisions 32 and 33**, numbered after the replan's 31, and amends decision 30. Decision 32, the web terminal: it opens only on a session taken over and closes on Give back, so the human and the harness never type at once; it runs a shell in the session's own container, as the session's user, in the checkout, with exactly the container's reach. Its transport is server-sent events for the output and posts for the keystrokes, not a WebSocket: a browser cannot put the anti-forgery header on a WebSocket handshake, and the posts reuse the app's write checks unchanged. The safety rules are the orchestrator's requirements for this addendum, not the owner's words (the owner's entry above holds no rule): the authenticated owner only, anti-forgery and origin checks, loopback only, no agent session can reach it, everything typed journaled. They become mechanisms with a test each. The owner is the signed-in app user who took the session over, since the users module has no role; the flow's and the lead's identities are refused. Every post carries the anti-forgery token and the app's origin. Nothing new listens, and the app answers the terminal routes on its loopback origin only; on the public origin the tab shows the resume command, as the Browser tab says it works on this machine only. A session container, a host tool and a preview page cannot reach it. The typed input is journaled line by line through the cleaner, so a secret typed in pieces is masked; the output is never stored. Decision 33, the editable editor: a save goes through the files route's refusals, then `evaluate()` of the session's policy as a `Write` of the author, on the host; an `ask` of `install.package` or `scripts.change` becomes a confirmation journaled as that user's answer "once", and any other `ask` is a refusal; the write happens inside the session's container, since the session controls its checkout; a stale hash answers 409; the session is told at once while it is live, and at Give back, with the terminal's changes, while it is taken over.
- **The author's choices, listed for the owner's review.** The transport: the question's option (b) named a WebSocket to the container; the plan uses server-sent events for the output and posts for the keystrokes instead, for the anti-forgery reason above, with the same result for the owner. What the terminal runs (a shell in the session's container, its first line the resume command), the owner's meaning (the user who took the session over), the loopback gate with the resume command as the fallback on the public origin, and the editor's write inside the container are the author's choices too.
- **Review round 1 (Sonnet 5.5), taken on 2026-10-22.** An `ask` is confirmable in the editor for `install.package` and `scripts.change` only, any other (`default` included, which is what `.git/**`, `.claude/**` and `CLAUDE.md` get) is a refusal, with a test per protected path; `evaluate()` is given the container path and the file's current text. The editor's write happens inside the session's container through the wrapper's existing `exec`, the policy check staying on the host, so a parent folder swapped for a link between the check and the write cannot send it outside what the session itself reaches; a test swaps one. The reviewer's prompt call site is lane 23's, with `flow/human-edits.ts` returning an empty list by default, and lane 31 only fills that function. The safety rules of the web terminal are labelled as the orchestrator's requirements, in this entry and in the plan's section 6.
- **Review round 2 (Sonnet 5.5) passed, with followups, taken on 2026-10-22.** The editor's in-container program checks the real path its rename will write and refuses `.git`, `.claude` and `CLAUDE.md` behind a link the session made, with tests for a link made before the save and one swapped in during it; Take over, and so the terminal and the editor's saves, is limited in milestone 2 to the single owner account (the first account of the users table), roles coming later; the lane that writes a route ahead of its server adds the exclusion to `test/flow/api.test.ts` and the serving lane removes it; the wave 5 row is rewritten.
- **Three lanes and a wave.** Lane 30 (Haiku 5.5, wave 5) adds the terminal and editor packages as their own small lane, since `v2/package.json` belongs to no other lane; their versions and licences are unknown until it reads them, and a package that needs a looser `Content-Security-Policy` is not added. Lane 31 (Opus 5.5, wave 10) is the service's part: the terminal, the docker wrapper's `terminal` method under the label rule, the editor's write route, the notices, the reviewer's prompt and the app's loopback gate. Lane 32 (Opus 5.5, interface, a new wave 11) is the session screen's part. The proof lane 29 moves to wave 12 and drives a new step 11 of the multi-service proof (take over, type, save, give back). Lane 17 writes the routes, the shapes and the four event names for waves 9 to 11; lane 16's shapes gain the `paused` state with the user who took over; lane 20 records that user, keeps the resume command as the fallback and gains the symbolic link tests on its read route; lane 22 shows a taken-over session on the tower. Lane 21 is unchanged.
- **The other answers.** Question 1: the multi-service proof runs real sessions on both examples; lane 28 (pull request 186, merged while this lane ran) opened the seed pull request in the new repository, whose merge is the owner's; lane 15's doctor keeps its session on the guestbook. Question 2: section 2.1 cites the owner's decision, not a default. Question 5: decision 20 and section 4.7 name milestone 3 for the other formats. Questions 6 and 7: the recommendations stand; the 48-hour proof runs once, after wave 12.
- **The quota** grows by about 4.5 points: lanes 30 to 32 (4.0, lane 32's style nonce included), one more fix lane (0.3) and step 11 (0.3). Lanes 14 and 28, merged as pull requests 187 and 186 while this lane ran, are spent and no longer counted, so about 34 points remain, 25 of them for the eight waves (wave 5 is lane 30 alone, 0.5); what remains no longer fits in the current week if more than about 50 points are already spent.
- **Followups F5 and F8 of review round 1, taken on 2026-10-22.** F5: lanes 14 and 28 are marked merged in section 1, in their lane sections and in wave 5, and their estimates leave the quota table. F8: the per-page style nonce is lane 32's by default, in its files (`app/src/server.ts`, a new `app/test/style-nonce.test.ts`), its acceptance proof and its estimate (1.5 to 2.0); lane 30 measures the packages with and without it, names each package's nonce option, and its report decides whether lane 32 drops it; `unsafe-inline` is never allowed.
- **The matrix.** Lines O8 to O13 record the owner's answers 2 to 7, since lane 28's O7 already records answer 1; P12 and P13 record decisions 32 and 33, after lane 28's P10 and P11; B5.10f, D4 and C1 name lanes 30 to 32 and step 11; O1 and B6.2m no longer wait for question 1; M2 now covers OpenAPI 3 only, in milestone 2, and the new M11 holds the other formats in milestone 3; M7 and B6.2p cite the owner's decisions. B5.10g and D21 stay `partial`: the owner's decision takes the delivery to the Mac out of the proof but names no milestone for it, so under the matrix's rule 2 these two lines are not `done` at the milestone 2 merge; the orchestrator reports that to the owner then, rather than marking them done or not taken.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j2-plan-addendum`, at the orchestrator's request.

## 2026-10-22: the editor package added, the terminal package refused under the app's policy (the author's choices, lane v2-j2-deps-terminal-editor)

**Decision.** Lane 30 adds the editor's packages (CodeMirror 6 with the JavaScript and JSON language packs) as exact-version dev dependencies, and does not add the terminal package (`@xterm/xterm`), which violates the app's `Content-Security-Policy` as it is and has no nonce option to fix it. Per the plan, the orchestrator chooses the terminal package; until it does, lanes 31 and 32's terminal parts have no package.

**Consequences.**
- **The editor's packages.** `codemirror@6.0.2` (MIT, published 2025-06-19), `@codemirror/lang-javascript@6.2.5` (MIT, 2026-03-02, for the examples' `.ts` files) and `@codemirror/lang-json@6.0.2` (MIT, 2025-06-19, for the `.json` files). No markdown or YAML language pack: the examples' `.md` and `.yml` files open as plain text, and lane 32 adds a pack only if the owner asks for the highlighting.
- **Transitive packages.** Twenty packages come with them, all MIT, none with an install script, one copy each (`npm ls` shows every shared package deduped). They were installed with `npm install --before=2026-10-08`, so every version was published at least 15 days before the lane (the oldest 2023-06-07, the newest 2026-10-07). The lock file gains 221 lines and loses none, except the root's own dependency list, which changes with the three pins in `package.json`.
- **Bundled size.** A scratch page with `codemirror`, the two language packs and the base setup built with Vite 8 is 501.6 kB minified and 168.5 kB gzipped. Lane 32 loads it by dynamic import on the session screen only, as the plan says.
- **The policy check.** A throwaway page outside the repository, built with Vite and served on the loopback address with the app's policy verbatim (`app/src/server.ts`), was loaded in Chromium 1248 and every `securitypolicyviolation` counted. The control page with no package had 0 violations. Results, under the policy as it is (no nonce):
  - CodeMirror: 1 violation, `style-src-elem` on the `<style>` element its style module writes. Without it the theme does not apply (the scroller's font is `Times New Roman`, the gutter 1264 px wide).
  - xterm 6.0.0 (refused): 8 violations, all `style-src-elem`, from the `<style>` elements its DOM renderer and viewport create at run time.
- **The nonce.** With the per-page nonce (`style-src 'self' 'nonce-<value>'`, the rest of the policy unchanged) and `EditorView.cspNonce` set to the same value, CodeMirror has 0 violations and its theme applies (monospace, gutter 31 px). xterm still has 8: its typings and its built code have no nonce option, so the nonce cannot reach its elements. The plan's rule applies: xterm is not added, and `unsafe-inline` is never allowed.
- **For lane 32.** The per-page style nonce is needed, not optional: CodeMirror violates the policy without it. Lane 32 keeps F8's nonce in `app/src/server.ts` and passes the value to `EditorView.cspNonce`.
- **The terminal package is open.** The orchestrator chooses another package for lanes 31 and 32's terminal part, and the choice is checked with the same probe before it is added. The replan's decisions 32 and 33 are unchanged. Rows O9, O10 and C1 name lane 30's part; P14 records what it delivered.
- **Tests.** The lane owns only `v2/package.json` and its lock file, so it adds no test file under `v2/test`. The test is the probe: before the install its build failed to resolve `@xterm/xterm` (red), after it the CodeMirror page reached 0 violations with the nonce (green). The probe, its server and the Playwright runner are scratch files outside the repository, and nothing in the repository imports the new packages yet.
- **Checks.** `npm ci`, `npm test` (which builds first; 101 tests), `npm run typecheck` and `npm run guard -- --base origin/v2` are green on a clean install.
- Author: Haiku 5.5 (claude-haiku-5-5), lane `v2-j2-deps-terminal-editor`, at the orchestrator's request.

## 2026-10-22: the siblings of a session, the fake, the skills mount and the preview (milestone 2, lane 15)

**Decision.** Lane `v2-j2-workspace-runtime` applies decision 20 of the [milestone 2 plan](milestone-2-plan.md) in the containers and the workspace, and the skills mount of decision 27. The lane's choices:

1. **How the siblings reach the runtime.** `StartInput` gains `service`, `siblings` and `skills`, all optional. A sibling is a `SiblingSpec` (`container/services.ts`): its name (its alias on the session network), its port, its `real` part (the folder of its base branch, its `run` Dockerfile, the base layer's tag, and the ticket checkout when the ticket has one) and its `contract`. `startSession` builds the layers itself, since only it knows the session id the ticket layer is labelled with. When the flow gives no siblings, the runtime (`flow/runtime.ts`, around each adapter it makes) plans them from the workspace: every service with a `run` or a contract; the session's own service when it runs (it is the Browser tab's page); real when it runs, else its fake; with its ticket checkout when `<workdirs>/<ticket>/<service>` is a plain folder. A service whose base cannot be read is left out, and its error is logged by name only.
2. **The base branch is exported, never read from a working tree.** `exportBase` (`workspace/checkout.ts`) writes `refs/remotes/origin/<base>` of the service's own checkout with `git archive`, once per commit, under `<state>/siblings/<service>/<commit>`, through a partial folder renamed into place. The base layer, the fake's contract and the skills are read from there: landed code only, never a ticket checkout, never the checkout's uncommitted files.
3. **The two layers.** The base layer is the service's own Dockerfile built from that export, with the network (it installs the dependencies, as the deploy watcher's build does), tagged `cleared-v2-base-<service>:<commit, 12 characters>`, labelled `cleared.dev=v2` only and shared by the sessions of that commit. The ticket layer is a Dockerfile Cleared writes outside the checkout, `FROM` the base layer and `COPY . <the base image's working folder>/` (read with `image inspect`; a base with none is refused), built with `--network none`, labelled with the session and tagged `cleared-v2-<session>-sib-<service>:ticket`. The copy is the whole checkout over the base's files, so the base's installed dependencies stay unless the checkout brings its own.
4. **The fallbacks.** A checkout whose `package.json` `dependencies`, `devDependencies`, `optionalDependencies` or `peerDependencies`, or whose lock file (`package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`), differs from the base's, or whose ticket layer fails to build, becomes the fake when the service has a contract, else runs the base layer. A base layer that fails becomes the fake, else the start is refused. The checkout's files are read without following a link: a `package.json`, a lock file or a folder that is a link is a change. The reason is on the started sibling (`StartedSibling.reason`), for the release card's `dependency` flag (lane 18).
5. **How a sibling runs.** Its container has no capability, `no-new-privileges`, the test services' limits, the session's internal network only under the service's name, and the test services' variables (the guestbook's `DATABASE_URL`). The VOLUME paths of the image it runs are tmpfs, as lane 2's table does for the test services: Docker would otherwise create an anonymous volume, without the label, for each. The fake also runs with a read-only root and the contract's folder mounted read only. Each sibling is awaited with a TCP connect run from the session's egress container, which is Cleared's own Node image on that network, to the sibling's address on the session network, read from a labelled inspect while it runs, never to its name: a name that no longer resolves on that network would be looked up outside it, through the egress container's other network. A sibling that never answers, or exits, is reported (`ready: false`) and does not stop the start, so a session that broke its own service can still start and fix it.
6. **The fake image** (`v2/images/fake/`, `node:24-slim`, no `RUN`) copies `fake.ts` and lane 28's YAML reader (`yaml.ts`, copied as its log entry allows). It reads the first example of each operation along the path lane 28 fixed, and answers 501 with the operation's name when there is none, 404 for an unknown path and 405 for an unknown method. `GET /__fake/calls` counts the answered calls per operation, the 501s included. Its port is the service's `run` port, else the contract's first server's port, else 8080. The YAML subset has no list of mappings, so a contract that names its servers is written in JSON.
7. **The skills.** The session's service's `.claude/skills`, as its base branch holds them, is exported alone (`<state>/skills/<service>/<commit>`) and mounted read only at `<CLAUDE_CONFIG_DIR>/skills`, the folder where Claude Code reads its configuration's skills. It is not mounted over the checkout's own `.claude/skills`: the checkout stays writable for lane 24's skill ticket, and a skill a session changed reaches no later session before it lands.
8. **The preview route** answers on `/api/sessions/:id/preview/:key` and up to 16 segments after it, one route per depth, since the registry matches a fixed number of segments. It asks for the app's proof (401); an unknown session and a wrong key get the same 404, the key compared in constant time. The session's network has no address on the host and a sibling publishes nothing, so the service relays through the session's egress container: one `docker exec` of a Node `fetch` to the sibling's address on the session network while it runs (a sibling that does not run is a 502, and nothing is relayed), the body brought back as base64 (8 MB at most, 15 seconds), about 200 ms a request on this server. No header of the app's request reaches the sibling. The answer drops `Set-Cookie`, the sibling's own `Content-Security-Policy`, the transfer headers and `content-encoding`, and adds `Content-Security-Policy: sandbox allow-scripts allow-forms`, `no-store`, `nosniff` and `no-referrer`; a redirect is kept as a path when it stays on the sibling (its address or its name) and dropped otherwise.
9. **The preview key** is 32 random bytes in base64url, issued when the session's containers have started, only when the session's own service runs, and stored with the session's service by `store.sessions.put` before the engine's own put, which keeps both (lane 14's `COALESCE`). A session's service is `StartInput.service`, else the workspace's first service (the one the milestone 1 fields name), until the flow names one. The lead's sessions are left as they are.
10. **The folder kind.** `ticketCheckout` takes the service's `path` and answers `cwd`, each part a plain folder of the checkout, never a link.
11. **The Docker wrapper.** `build` takes `network: 'none'` and the session's label. `image ls` prints no labels, so every listed image is inspected and its labels checked before anything acts on it (`images(session)`, `image(tag)`, `removeImage(tag)`). `removeSession` removes the session's images after its containers and networks.
12. **Two files outside the lane's list.** `v2/src/session/adapters/claude-code.ts` gains one line passing `siblings` and `skills` to `startSession`: the adapter copies the start input into the runtime's spec field by field, so without it the plan's `StartInput.siblings` would reach nothing; no lane owns the file in milestone 2. `v2/test/flow/modules.test.ts` (two lines) leaves the preview routes out of the sessions module's route list, since the plan has that module register them. `v2/test/flow/api.test.ts` keeps its exclusion of the preview route: the addendum's rule that the serving lane removes it applies to the flow's API, and the preview is served by the sessions module, as the approval route is by its own.

**Consequences.**
- Tests first, failing on `v2` at `fc0004e` (commit a8d2c44 holds them alone): `test/container/fake.test.ts` (the filter API's contract copied as `test/container/fixtures/filter-api.openapi.yaml`), `services.test.ts`, `session-runtime.test.ts` (the adapter's forward included), `docker.test.ts`, `preview.test.ts` (the route and the runtime's key, siblings and skills over two temporary repositories), `test/workspace/checkout.test.ts`, `test/runner/image.test.ts`.
- `npm test`: 739 tests under `node --test` (738 pass, 1 skipped as before) and 101 under Vitest; `npm run typecheck` and the guard pass.
- `doctor workspace` ran on this server on 2026-10-22, labelled: a session on the guestbook with a real `postgres:16`, the guestbook's sibling in two layers from the proof's `examples/workspace.conf`, and the filter API as its fake, because the ticket's checkout of it adds a dependency. The guestbook's `/health` answered `{"status":"ok"}` on its name from inside the session, the sibling held the ticket's change, the fake answered `POST /check` with the contract's first example and counted it, and the skills were readable and read only. Neither sibling had a volume mount. The preview's answer carried the sandbox policy and no `Set-Cookie`. Stop left nothing with the session label (containers, networks, volumes, images), the doctor removed the base layers of its own seeded commits, and no socket was opened on the host. The doctor seeds temporary repositories from `examples/` and calls no model. The owner's decision of 08:27 extends the login to the filter API, but the doctor keeps its session on the guestbook, as the addendum says.
- The plan's first unknown is closed: a ticket layer built with `--network none` from a local base layer builds and starts (the guestbook in the doctor; the filter API's base layer was built there too). Measured with Docker's cache: base layer 0.6 to 2.9 s, ticket layer 0.4 to 0.7 s, a session start with postgres and two siblings 5.4 to 7.4 s. The first build of a base layer on a new commit adds its dependency install.
- **Open, for other lanes:**
  - The skills are mounted, but Claude Code reads them only once the runner's `settingSources` includes `'user'`. The runner passes `[]` (`images/session/runner/main.ts`, issue 140), and the runner is not this lane's file.
  - The runner works in `/workspace` (`cwd: WORKDIR`), so the folder kind's `cwd` reaches the session only when the runner takes it.
  - `sessionDetail` (`flow/engine.ts`, lane 16's in this wave) does not answer the row's `previewKey` and `service` yet; lane 20's Browser tab needs both.
  - The events a session stores while its adapter starts come before its row, and carry no service.
  - A consumer's sibling gets no address variable for the services it consumes: the guestbook reads `FILTER_URL`, a name of its own. `SiblingSpec.env` carries it when the flow sets it (lane 23, for proof step 4).
  - The base layers of old commits are kept, labelled; nothing prunes them yet.
- The rows of [requirements-matrix.md](requirements-matrix.md) this lane delivers: P9 done; B5.5b, M3 and P8 partial (the skills' loading, the Browser tab and lane 20's isolation test remain); B4.6 names `doctor workspace`.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j2-workspace-runtime`.

## 2026-10-22: the clickable answers on the React screens (milestone 2, lane 13)

**Decision.** Lane `v2-j2-choices` applies decision 17 of the [milestone 2 plan](milestone-2-plan.md) on the React port. A question a session or the lead asks is shown as buttons, multi-select when it says so, the recommendation marked, with a free answer, on the session screen, the lead screen and the inbox's question detail. The on-hold branch of the same name, built on the old front end, was not merged: its model, its tests, its catalog keys and the lead's rule were ported. The lane's choices:

1. **One component.** `app/web/components/choices/` holds the pure model (`model.ts`, under `node --test`), the component (`Choices.tsx`) and its sheet (`choices.css`). Each screen's sheet sets only its size: the inbox keeps its 18 px question and 44 px fields, and the lead's bubble keeps the question in the lead's regular weight with its header as a small amber line.
   - Two modes. `inline` (the session and the lead): a click on the only choice of one question answers at once; otherwise the clicks toggle and Send answers. `bar` (the inbox): the clicks only pick, and the inbox's bar sends, as before.
   - The states: waiting, busy (the buttons wait while the answer is on its way), answered (by whom, and with what when this tab sent it), cancelled (the turn was interrupted), settled (the answer came after the question stopped waiting: 404 or 409), ended (the session ended before an answer), and read (shown only).
2. **The thread's interrupt, without `useInterrupt`.** The session's thread state gains `interrupts`: one AG-UI `Interrupt` per question that waits, its id the request's, `reason: 'cleared.question'`, and the AskUserQuestion questions kept as asked in its `metadata`. The screen reads it through `useAgent`, as it reads the rest of the thread. CopilotKit's `useInterrupt` was not used, for two reasons read in its 1.77.2 source:
   - it sets its pending interrupt only when a run finalizes, and the screen's agent keeps one run open for the screen's life (the React port's choice), so it would never fire;
   - its `resolve` and `cancel` call `copilotkit.runAgent`, which the agents refuse, since decision 17 sends the answer through the app's routes.
   The lead's question is read from `LeadState.pendingQuestion` and the thread's question message, as lane 8 did.
3. **The routes.** A session's answer posts `{ decision: { kind: 'answer', answers } }` to the session answer route, keyed by the question's text, each label as written ("(Recommended)" kept). It has its own handler: the permission buttons' `decisionOf` would read an option's label as a denial. The lead's answer goes through `POST /api/lead/messages` (lane 8's choice, issue 168, item 3).
   - One question sends its answer as it is.
   - Several questions of one ask, now answered by picks then Send, send one text with one line per question, named by its header. The lead engine gives that one text to every question of the ask, as it does for a typed reply.
   - The lead's reply field stays the free answer: the bubble has no field of its own. That field keeps its 20,000-character limit: nothing downstream of `POST /api/lead/messages` caps an answer, so no cap was invented.
4. **The 2000-character limit** (what the session answer route accepts per answer) applies to the composed value of each question: the free answer, or the picks joined with ", ". Over it, the component says so and Send stays off. The inbox's `answersFor` now delegates to the component's, so the inbox refuses too.
5. **A defect fixed, test first.** A question cancelled by an interrupt stayed pending in the session model forever. The adapters cancel it with `cleared.permission_answered` (`decision: 'cancelled'`, by the policy), which the model only read for permissions. Before the fix, `pending` still held the request after the cancel (run recorded in the pull request). The question now leaves `pending` and its row says cancelled.
6. **"With what" is this tab's knowledge.** `cleared.answered` carries the request and who answered, not the answer, and the Claude Code adapter stores the answer nowhere else in the session's events. So "Answered by you: <label>" shows in the tab that sent it until a reload, and "Answered by you" after it. On the lead screen the owner's answer is the next bubble anyway, and a handled question reads as a line of the lead, as in the capture.
7. **Selectors.** Every option carries `data-answer` with its label as written, the attribute proof-j2 reads in `#thread .bubble.question [data-answer]`. On the session screen, options sit under `[data-row="question"]` and the permission buttons under `[data-row="request"]`, which is the scope proof-j1 uses, so the two never mix. The inbox's options had `data-option`; they now carry `data-answer`, which no script read.
8. **One wording.** "Recommended" on the three screens, where the inbox said "Recommended by the team": the asker is a team or the lead, and the component is shared. The session's `question_open` and `question_answered`, the lead's `lead_question_recommended` and `lead_question_several`, and the inbox's `recommended` and `free_answer` were replaced by the `choice_*` keys, which the session, lead and inbox catalogs hold alike in English and French (a test checks it).
9. **The lead's rule.** "Give options whenever the question allows it: two to four options, each a short label the owner's screen shows as buttons, with a description when the label alone is not enough. Put your recommendation first and end its label with "(Recommended)". Add no "Other" option: the owner can always answer in their own words." The rules stay under 5 KB (4612 bytes).

**Consequences.**
- **Tests.**
  - `app/test/choices.test.ts`: the model and the three catalogs.
  - `app/test/session/choices.test.ts`: the interrupts, the cancel and the answer body.
  - `app/test/choices-app.test.ts`: the three pages load the component's rules, and the fixture sources receive what a click sends.
  - `app/web/test/choices.test.tsx` and `app/web/test/{session,lead}/choices.test.tsx`: the component and its states, both languages, the escaping.
  - `test/lead/prompts.test.ts`: the lead's rule.
  - `app/test/choices-browser.test.ts`: a click in headless Chromium on the session screen and on the lead screen, asserting the route each one called. It is skipped unless `CLEARED_V2_PLAYWRIGHT` names a `playwright-core`, as `notify/browser.test.ts` is. It passed here against Chrome 153, with no page error and no request off the app's origin.
  - `npm test`: 706 under `node --test` (703 pass, 3 skipped: the two browser tests and the notify one) and 117 under Vitest. `npm run typecheck` and the guard pass.
- **The fixture** (`app/fixtures/session.ts`) gains `sessionFixture(now, { question: true })`: the author asks the month question through AskUserQuestion, with three options, and its inbox item is a question. Its source now answers a question with `cleared.answered` instead of a permission answer, answers 404 for a request that no longer waits, and cancels what waits on an interrupt, as the adapters do. The lead fixture is not this lane's: the tests and the captures give `leadSource` a three-option question.
- **Captures**, none committed, in `/tmp/cleared-captures/j2/`. They replace the stale `choices-*` files of the on-hold attempt.
  - `choices-<scenario>-<width>-<theme>.png` for `session`, `session-typed`, `session-answered`, `lead` and `inbox`, at 1440, 1280, 768 and 390, light and dark: 40 files, mode 644, the pointer away from every button.
  - `choices-reference-{session,lead-and-plan,inbox}.png`, rendered from `/tmp/cleared-reference/`.
  - The app ran on an ephemeral `127.0.0.1` port with the fixture sources. There was no page error, no request off the origin, and no horizontal overflow.
  - The references have no question with options. The comparison was against `origin/v2`'s own question renderings, captured the same way, and the tokens of the reference's request card. The lead's and the inbox's questions keep their earlier look, apart from the descriptions, which the lead now shows. A question that no longer waits on the session screen loses its amber.
- **The art director's pass** was run once, by Sonnet 5.5 in a fresh session, on these captures and the references. Taken:
  - the enabled Send drew its label in its own fill's colour, so it was unreadable: the ink fill and its label are now set by the component;
  - the question's header pill, invisible on the amber surface, now has the highlight fill;
  - a 14 px question on the session screen, and a 12 px gap above the options;
  - in the answered state, the check hangs in the gutter so the labels share one edge, and the answered line is quieter, under a hairline;
  - one field ring for the free answer on every screen;
  - a readable disabled Send in dark;
  - a hairline frame for a settled question in dark;
  - plain wrapping for the lead's question in its bubble.
  Not taken:
  - "Recommended" as a filled tag: it keeps the underlined mark of lane 10's inbox;
  - quieter option rings in the lead's bubble: the options are the gesture the bubble waits for;
  - a narrower inbox column and the question outside the amber card: both are lane 10's design, unchanged here;
  - the inbox bar's own Send: it is the bar's, not the component's.
- **Left as it was:** answering the lead's question from the inbox (issue 168, item 3): the inbox still sends the person to the lead's screen. That is the inbox's bar, outside this lane's question detail.
- **For lane 29.** On `v2` before this lane, a lead question that was single but multi-select was answered by one click, which sent its label. Now its clicks toggle, and `[data-choice-send]` sends, as for an ask of several questions. Proof-j2's step 2 clicks one `[data-answer]` and waits for the question to clear, so against such a question it would wait out its two minutes. `scripts/proof-j2.ts` is lane 29's file and was not edited.
- **Edits beyond the question detail**, mechanical: in the inbox, the bar's Send says when an answer is over the limit (`Inbox.tsx`), the model's `answersFor` delegates to the component's, and `.deny-reason input` keeps its rules in `inbox.css`, which it shared with the removed `.free input`.
- **The branch.** This lane's branch is `v2-j2-choices-react`. The local name `v2-j2-choices` belongs to the on-hold worktree, which was left untouched.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j2-choices`.

## 2026-10-22: the terminal package added, with the page's style nonce given by a shim (the orchestrator's choice, checked by lane v2-j2-deps-xterm)

**Decision.** After lane 30 refused `@xterm/xterm` (pull request 194: 8 violations under the app's `Content-Security-Policy`, no nonce option), the orchestrator chose to keep xterm 6.0.0 and `@xterm/addon-fit` 0.11.0 with a small shim, `v2/app/web/lib/style-nonce.ts`, that gives the page's style nonce to every `<style>` element a script inserts, by wrapping the insertion as bundlers' nonce hooks do, never `unsafe-inline`; the web terminal is the owner's requirement (O9, question 3 (b)). This lane re-ran lane 30's probe and found the choice right but not sufficient on its own. With the nonce shim, xterm has 0 violations for plain and 256-colour output, with its rows rendered, the fit applied and its theme applied. But its DOM renderer also writes colours as `style` attributes (a cell in 24-bit colour, a selected cell, a decoration with an RGB colour), which no nonce can allow: a selection of 20 cells gave 8 `style-src-attr` violations, two 24-bit cells gave 2. The lane therefore adds a second, separate function to the shim, `installStyleAttributeCssom`, which writes such an attribute through the CSSOM when it holds only `color` and `background-color` with a hex, `rgb()` or `rgba()` value. With both functions, every terminal case of the probe has 0 violations. The second function is this lane's addition, for the orchestrator to confirm.

**Consequences.**
- **The packages.** `@xterm/xterm@6.0.0` (MIT, published 2025-12-22) and `@xterm/addon-fit@0.11.0` (MIT, 2025-12-22) are exact dev dependencies, installed with `npm install --before=2026-10-07 --save-dev --save-exact`, so both were published at least 15 days before the lane (rule P14). Neither has a dependency or an install script. The lock gains their two entries and the root's two pins, and nothing else changes. Bundled by Vite 8: xterm is 330.9 kB minified (83.0 kB gzipped), the fit addon 1.2 kB (0.5 kB), and xterm's stylesheet 3.9 kB (1.0 kB), a same-origin file the policy allows. Nothing imports them yet; lane 32 loads them on the session screen by dynamic import.
- **The probe.** As lane 30's: a throwaway page outside the repository, built with Vite 8.3.4 and served on `127.0.0.1:47613` (free in `ss -ltn`, stopped afterwards) with the policy of `app/src/server.ts` read from the file. Under `/nonce/` the same policy gains `style-src 'self' 'nonce-<value>'`, with a fresh value per response written in the page as `<meta property="csp-nonce" nonce>`. The page imports the shim from the worktree, so the probe measures the file this lane ships. It runs in headless Chromium 156 (Playwright's build 1248) and counts every `securitypolicyviolation`. Since Chromium hides the nonce attribute, the probe reads its effect: the rows' colour is the theme's `rgb(1, 2, 3)` and their font `monospace` only when the theme's `<style>` element applied. Results:
  - The control, with and without the nonce: 0.
  - CodeMirror: 1 without the nonce, 0 with `EditorView.cspNonce`, 0 with the nonce shim and no option.
  - xterm without the shim: 12 `style-src-elem`, and the theme is lost, whether or not the header carries a nonce. Lane 30 counted 8; this page also fits the terminal and writes to it, and each of those rewrites a style element.
  - xterm with the nonce shim: 0. It is 80 by 24 before the fit and 74 by 23 after, which is what `proposeDimensions` gives for a 643 by 377 px box. All 23 rows render with the text in them, the theme applies, and ANSI red is `rgb(204, 0, 0)`. With 256 colours: 0, and the palette's red and blue apply.
  - xterm with the shim given a wrong nonce, or with no nonce in the header: 12. The 0 above comes from the nonce.
  - 24-bit colour with the nonce shim only: 2 `style-src-attr`, and the cells' colour is lost. 200 lines, a resize, a scroll and a selection of 20 cells: 8 `style-src-attr`, and 0 without the selection.
  - With both functions: 24-bit colour 0 (the cell's `rgb(200, 30, 40)` applies), the session with the selection 0, the contrast path (`minimumContrastRatio: 4.5`) 0, both packages on one page 0.
  - Wide characters (an emoji, CJK, box drawing) in 24-bit colour with a selection across them: 20 `style-src-attr` with the nonce shim only, 0 with both functions. xterm writes only `color` and `background-color` there too; it sets `letter-spacing` afterwards through the CSSOM.
  - The negative controls with both functions installed: a script's `setAttribute('style', 'position:fixed')` and a colour in markup set by `innerHTML` give 1 violation each and stay unstyled.
- **Why the CSSOM function is safe.** The policy governs a style attribute, not the CSSOM. Any script of the page's origin can already write `element.style`, so turning a script-set attribute into the same declarations gives no script a power it lacks. Markup, which is what an injection produces, never goes through the wrapper, and its style attributes stay blocked (the control above). The conversion takes only the two properties xterm writes, each with a plain colour (no `url()`, no `!important`, no other property); anything else goes to the native `setAttribute`.
- **The nonce shim's exposure.** While the shim is installed, any `<style>` element a script of the page inserts directly gets the nonce. That exposure is bounded by `script-src`, which falls back to `'self'`, so only the app's own bundle runs. No code under `v2/app/web/` builds a `<style>` element from session data: xterm's and CodeMirror's are built from their own options, which lane 32's code sets. A style element inside a fragment or in parsed markup gets none.
- **The alternatives.** The nonce shim alone leaves violations in ordinary use (selecting text), so lane 32's check that the session screen has no violation would pass only for a test that never selects. The fallback the orchestrator named, the terminal page on a separate loopback origin in a sandboxed iframe like the preview, was not needed, and it costs more than it looks: that origin holds no cookie and no anti-forgery token (decision 20's rule for the preview), so the terminal's posts would need their own authentication there, which undoes decision 32's transport and lane 31's gate. If the orchestrator refuses the CSSOM function, lane 32 installs the nonce shim only, and a selection or 24-bit colour fires `style-src-attr` reports. The selection still copies (`getSelection` gave the 20 characters), but the selected and 24-bit cells lose their colour.
- **For lane 32.** The session screen installs both functions just before `term.open()` and uninstalls them when the terminal is disposed. CodeMirror keeps `EditorView.cspNonce`. The server writes the nonce in the page as `<meta property="csp-nonce" nonce="<value>">`, and the screen reads it from the element's `nonce` property. The browser test shows a 256-colour line and a 24-bit line and selects text before it counts.
- **Tests.** `v2/app/test/style-nonce-shim.test.ts` has 8 tests run by node --test on fake prototypes, since the repository has no DOM library. It is named so as not to take lane 32's `style-nonce.test.ts`. The browser proof is the probe, outside the repository; its raw output is in the pull request.
- **Checks.** `npm ci`, `npm test` (which builds first; 759 node tests pass and 3 are skipped, and 117 Vitest tests pass), `npm run typecheck` and `npm run guard -- --base origin/v2`.
- **Records.** P14 is `done`; P17 is new; O9 and C1 name this lane. The plan's lanes 30 and 32, its section 8 and its note on `v2/package.json` are updated.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j2-deps-xterm` (pull request 199), at the orchestrator's request.

## 2026-10-22: the lock per service and the release train (the author's choices, lane v2-j2-workspace-lock)

**Decision.** Lane 16 applies decision 21 of the [milestone 2 plan](milestone-2-plan.md), places the call of decision 23 and writes the API shapes of waves 7 and 8. A ticket of a workspace of several services lands as a release train: one pull request per service on the same branch, each service's review and approval kept by that service's own release broker, the services landed in order with the health read between landings, the rollback in reverse order, and the card blocked before approval when a contract changes without its consumer. A ticket of a one-service workspace runs as in milestone 1. Nothing under `serve/`, `merge-pr.sh` or `ask-validation.sh` was edited; `lib/release.mjs` gained `ownRelease` in review round 1 (below). The lane's choices:

1. **One owner gesture, one signed move per service.** Each service's `merge-pr.sh` reads the owner's move to go against its own `validations/<ticket>.json`, in its own state folder. It also closes the ticket once every pull request of that record is merged, which means its own one. So one signed move cannot satisfy two brokers, and the first landing closes the ticket. The real run below shows both. The train therefore works this way:
   - At publish, it asks `--ask` on every service's broker, in landing order. Each keeps its own record.
   - The approval route checks the owner's heads against every service's card head and record, then holds the grace with the approval writer on the first service's ticket store. The move written after the grace is bound to the first service's record.
   - Before each later service lands, the train puts the ticket back in the validate state as the service account. Then it signs the owner's move again, bound to that service's record, only after checking that the record still holds exactly the head the card showed.
   - A record that changed signs nothing. The train halts and the ticket goes back to Todo with the reason, naming what is live.
   - The approver's user id is kept with the train by the route, and forgotten on Undo.

   **This is a choice for the owner's review: one approval in the app becomes one signature per service, each bound only to what the card showed.**
2. **Where the train lives.** `v2/src/release/`:
   - `order.ts`: the landing order, providers first, followed through untouched services, then the workspace's position. Also the compatibility check and its proposal.
   - `store.ts`: `release_trains`, one row per release item, read again at every tick so that a new process goes on.
   - `train.ts`: the landing loop the flow's tick runs.
   - `lock.ts`: what the train asks of one service's lock.
   - `flags.ts`: `flags({ diff, report })` with its empty default, and `changesReport(events)`, which reads the session's last `cleared.changes` event by that name.
   The real per-service lock is `serviceLocks` in `approval/service.ts`: the broker over its own socket, the validations and the review reports in its own state folder, the shared ledger. A service with no `broker_socket` or `broker_state` takes the milestone 1 socket and state folder. Two services resolving to one socket or one state folder are refused, since a broker rewrites its secret at start.
3. **The landing.**
   - A service's merge is asked with `from_queue`. A queued merge is asked again after `CLEARED_V2_MERGE_RETRY_SECONDS`.
   - Its watch is read with `landingOf` from the time its merge was asked, which keeps two pull requests numbered 7 of two repositories apart, since they land one after the other.
   - Between landings, a ticket the lock closed is put back in the validate state, so it is never Done while a service is still to land.
   - A healthy last service makes the ticket Done and says `release_landed` once, with the services. An unhealthy one, with nothing reverted, halts the train and leaves the decision to the owner.
   - A failing watch the service's own `auto_rollback` reverted makes the train ask `request_rollback` of each earlier landed service, newest first. The train is `rolled_back`, `rolled_back` is said once, naming the failing service, and the ticket goes back to Todo with the note.
   - The time of a merge request is kept before the call, and a merge the ledger already shows is not asked again.
4. **The card.**
   - The release item carries `train`, from the train's store as it lands, waiting or handled. Its `pr` is the first service's, and its `heads` are every service's.
   - `TrainStop` gains `head` and `note`, and `TrainState` gains `halted`.
   - `groups` and `flags` are kept only when there are some, so a one-service card is unchanged until lane 18 fills `flags.ts`.
   - The diff given to `flags()` is the services' diffs one after the other, each with its repository's own paths.
   - What a provider changes that cannot be read is not taken as compatible: with a consumer the ticket does not change, the card is blocked.
   - The approve route answers 409 with `proposal` for a blocked card.
5. **Workdirs and publish.**
   - A train ticket has a checkout per service under `<workdirs>/<ticket>/<service>`, through `ticketCheckout` as it is. A one-service ticket keeps `<workdirs>/<ticket>`.
   - The author and the reviewer work in the first named service's checkout until lane 23's steps.
   - A ticket that names no service is on the workspace's first service.
   - Each service is published from its own checkout, with its own repository, base and forge. A service whose branch has no commit of its own is left out of the train, with a note.
   - Each review run is named by `reviewRun(session, service)`, so two pull requests #7 never share a `runs` row.
6. **The API shapes of waves 7 and 8** (`v2/src/api/types.ts`):
   - `SessionPlan`, on the API's session state (`ApiSessionState.plan`), and `SessionPlanItem`.
   - The routes `POST /api/sessions/:id/plan/go` and `change` (lane 17's), `GET /api/sessions/:id/files` and `files/*`, `POST /api/sessions/:id/takeover` and `giveback` (lane 20's). Each route is excluded from `test/flow/api.test.ts` through `SESSION_PLAN_ROUTES` and `SESSION_TABS_ROUTES`, with the serving lane named.
   - `ReleaseItem.groups` and `flags`, `ChangesReport`, `PlanItem.sensitivity`, `ServiceSensitivity`, `SessionFiles` and `SessionFile`.
   - The taken-over session as `takenOver` (`by`, `at`) on `SessionSummary` and the session state, with `ApiSessionPhase` (`paused` added).

   Two of these are additive only, because the screens map every member of `InboxItem` and `SessionPhase` and fail the typecheck otherwise:
   - `SessionPlanItem` is in `NextInboxItem`, not yet in `InboxItem`. Lane 21 adds it with the inbox screen that renders it.
   - `SessionSummary.phase` keeps the harness's phases. `paused` joins it with lanes 20 and 22, which own those screens.
7. **What lane 15 left to this lane's engine.**
   - The session JSON (`sessionDetail`) answers the `service` and the `previewKey` its row holds, and has neither field when the row holds none.
   - A train ticket's sessions carry `StartInput.service`: the first service the ticket names. A one-service ticket's carry none, so lane 15's runtime takes the workspace's first service.
8. **Two files outside the lane's list:** `v2/test/api/types.test.ts`, which pins the route list (31 routes now), and `v2/test/flow/fixtures/one-service-events.json`, the fixture below.

**Consequences.**
- **Tests first.** Each one failed on `origin/v2` at `81bf1d6`, where the modules did not exist:
  - `test/release/order.test.ts`, `flags.test.ts` and `brokers.test.ts`.
  - `test/flow/train.test.ts`: the fake adapter with a fake lock per service, covering the landing in order with the gap, the queued retry, the reverse rollback, a refused rollback, the block, a drifted head, the unread change and the restart's merge.
  - `test/flow/effects-services.test.ts` (two real temporary repositories) and the new cases of `test/flow/inbox-store.test.ts`.
  - `test/approval/train.test.ts`: the route, with v1's `tracker.sh moved-by-owner` as the oracle of each signed move.
  - `test/flow/one-service.test.ts` wrote its fixture on the engine before this lane and still matches it after. It compares the events, flow events, inbox items, calls, starts and moves of a whole one-service ticket, with the configuration as milestone 1 writes it and with its one-service workspace spelled out.
- **The real run** (`test/release/brokers.test.ts`, on this server, 2026-10-22). Two real brokers ran with one shared `ORCH_LEDGER`, two state folders and two temporary repositories, both pull requests numbered 7, with a fake `gh` and `docker`. Results:
  - Before the approval, `merge-pr.sh --dry-run` of the filter API said "the user has not agreed".
  - After it, the filter API's dry run said `would_merge: 7` with its own reviewed commit, found in the shared ledger with its report in its own folder.
  - The guestbook's dry run refused the first move: "the move of the user to « Ready to Ship » is older than the request".
  - The filter API's real merge (its fake `gh` recorded exactly its head) left the ticket Done.
  - Once the train put the ticket back and signed again for the guestbook's record, the guestbook's dry run said `would_merge: 7` with its own commit, and its merge followed. The ledger holds two `merged_by_script` rows, in that order.
- **Section 8's unknown.** Five rounds of both brokers' `merge-pr.sh` run at once on the one ledger each answered what it answers alone (0 and 6), with no lock error. Within what was run, the brokers contend on nothing beyond SQLite's own locking: `merge.lock`, the secret and the validations are per state folder.
- **`request_rollback` from the service account is accepted by the broker under the setup's `human_user`.** It reached `lib/release.mjs rollback`, which answered "No Cleared release recorded" (the fake `gh` gives no merge commit, so no watch started).
- **The gap the first round left, closed in review round 1.** On a shared ledger, `lib/release.mjs rollback <ticket>` took the ticket's newest `releases` row. After the guestbook's own rollback, that row was the guestbook's, so the filter API's `request_rollback` answered "This release was already rolled back", and the reverse rollback of an earlier service could not work through the lock. See review round 1.
- **For lane 20.** Lane 15's runtime looks for a sibling's ticket checkout at `<workdirs>/<ticket>/<service>` (`flow/runtime.ts`), and a one-service ticket's checkout stays `<workdirs>/<ticket>`, as the one-service test requires. So a one-service workspace written as a file whose service has a `run` would preview its base branch, not the ticket's change. Neither proof meets it: the workspace built from the milestone 1 variables has no `run`, and the multi-service proof's tickets are trains. The Browser tab's lane decides whether the runtime also looks at `<workdirs>/<ticket>`.
- **Not run here.** A real `gh` and forge, a real release watch with a health check, `auto_rollback` on a real deploy, and the guestbook and filter API brokers of this server. These are the multi-service proof's (lane 29).
- **Checks.** `npm test` (the node suites and 101 Vitest tests), `npm run typecheck` and `npm run guard -- --base origin/v2` are green.
- **The requirements matrix.** M5 is `partial` (the card is lane 21's), delivered by this lane's pull request (198), proven by its train tests and the real run. The new line P18 records choice 1 (P15 and P16 are lane 13's, P17 is pull request 199's).
- **Review round 1 (Sonnet 5.5), taken on 2026-10-22: the reverse rollback.** The reviewer blocked on the gap above. The orchestrator chose its option (a): the v1 fix in this pull request, since the reverse rollback is part of the milestone 2 proof (steps 8 and 9 of the multi-service proof).
  - **Why `lib/release.mjs` is added to this lane's files.** No lane of the plan owns it, and the train is the only caller that needs it changed. The change is the smallest that makes `request_rollback` mean "this repository's release" on a shared ledger.
  - **The change.** The new `ownRelease(conf, db, repo, ticket)`: the ticket's newest row whose merge commit is on this repository's base, after a fetch of it (`git merge-base --is-ancestor`, a commit the repository does not have counting as another's). The manual `rollback` command uses it. A ticket with no row still says "No Cleared release recorded"; one whose rows are all another repository's says "No Cleared release of this repository recorded".
  - **One-repository ledgers are unchanged.** There, the ticket's newest row is always on its own base, so the same row is chosen as before. The automatic rollback, which acts on its watch's own row by id, is unchanged.
  - **Tests, failing on the old code.** `test/rollback.test.mjs` has two new cases: two repositories on one ledger, and a ticket whose only rows are another repository's. The first ran against the module before the change and failed for want of the export. In `v2/test/release/brokers.test.ts`, the provider's `request_rollback` through its real broker now reverts its own merge. With the old `lib/release.mjs` the same test failed with "This release was already rolled back".
  - **The raw lines** (local paths left out, the preview's dash written as a hyphen):

    ```
    [releases rows] [{"ticket":"LOCAL-1","pr":7,"merge_sha":"f682dd18...","status":"complete","rollback_sha":null},{"ticket":"LOCAL-1","pr":7,"merge_sha":"6ad316fb...","status":"rolled_back","rollback_sha":"ffff..."}]
    [filter-api request_rollback, after the guestbook's own rollback] {"ok":true,"message":"Ticket: LOCAL-1 - Held for review\nMerge to revert: f682dd185f207b339e41852e0d96ccd1c36b451a\nFiles:\n  src/check.ts\nPushed revert c842c5e044453092a8d503c812363637e5f91614"}
    [the filter API's release after it] {"merge_sha":"f682dd18...","status":"verifying_rollback","rollback_sha":"c842c5e0..."}
    ```

    The filter API's base holds the revert, and the guestbook's base is untouched.
  - **F1, taken too.** A ticket published again halts its older trains (`TrainStore.haltActive`), so the owner's approval of the new card never lands an older one. `test/flow/train.test.ts` gained a case, which failed before the change.
  - **F4, in part.** `TrainApprovals.waiting` logs a release item it cannot read. Between two landings, the ticket reads Done for the moment between the lock's close and the train's move back to Needs Approval; matrix line P18 says so.
  - **Left as followups.** F2: the ledger reads are keyed on the ticket and the pull request; only the order of the landings keeps two `#7`s apart. F3: a test of Undo when the train stops waiting during the grace. F4: a blocked train stays active until a new one replaces it, which F1's halt now does.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j2-workspace-lock`, at the orchestrator's request.

## 2026-10-22: the release card's groups and flags, and the sensitivity per service (the author's choices, lane v2-j2-release-intent-sensitivity)

**Decision.** Lane 18 applies decision 23's service side and decision 24 of the [milestone 2 plan](milestone-2-plan.md). It fills `release/flags.ts`, the function lane 16 placed with an empty default. It flags a plan's items from the services they name, makes a fast item on a `full` service full, gives the lead its rules paragraph, and names the approver of a `human:<user>` service in the approval route. The engine and the inbox store are not edited: the reviewer per service and the Quick refusal in the engine are lane 17's. The lane's choices:

1. **The groups** are the report's groups, in the report's order, each keeping only the files the diff changes. A file named twice stays in its first group, and a group left with no file is dropped. The changed files no group names go to "Other changes". Without a report there is no group, so a card with nothing reported has no `groups` field, as before; the one-service fixture of lane 16 is unchanged. With a report and no diff to read (the engine passes `''` when `git diff` failed), the report's groups are kept as the author gave them.
2. **The flags**, in one fixed order, each listing its files:
   - `schema`: a file under a `migrations/`, `migration/` or `migrate/` folder, or a `.sql` file.
   - `dependency`: a lock file (`package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`), or a changed line of `package.json` inside a dependencies block (`dependencies`, `devDependencies`, `peerDependencies`, `optionalDependencies`, the bundled ones, `overrides`, `resolutions`). A hunk that does not show which block it is in gets the flag, unless the line is a known top-level field such as `version`, since a chip is never a block. A change to `scripts` or `version` gets none.
   - `config`: `.github/`, `.cleared/`, and the guarded paths given.
   - `secret_shape`: an added line that one of the guard's patterns flags. It uses the copy `session/clean.ts` keeps word for word, removed lines are not counted, and the detail names the pattern's kind and the file, never the line, and asks the owner to read it before approving. The private-term part of the guard needs the project's salt and is not run here; the guard at publish still runs it.
   - `contract`: a contract file given.
   - `large`: more than 400 lines added over the whole ticket, the files with additions listed.
3. **The diff is read hunk by hunk**, by the counts of each hunk header, so an added line such as `+++ b/.github/x` is a line, not a new file. Quoted paths, deleted, new and binary files are read. A train's diffs, one repository after another, name a shared path (two `package.json`) once and raise each flag once.
4. **Two optional inputs the engine does not pass yet.** `FlagsInput` gains `contracts` (the services' contract files) and `guarded` (their `[merge] guarded_paths`), since lane 16's call passes only `diff` and the report, and `flow/engine.ts` is lane 17's in this wave. Until the engine passes them, the card raises no `contract` chip, and `config` covers `.github/` and `.cleared/` only. A changed contract with an untouched consumer still blocks the card, through lane 16's compatibility check. **Followup for lane 23** (owner of `v2/src/flow/**` in wave 9): pass `contracts` from the services' contract files and `guarded` from each service's settings at the call.
5. **The plan's sensitivity.** The services are read from the ledger's `services` table, which the tickets module writes at every start, through a new `PlanStore.services()`. The order is the order the rows were first recorded, which is the workspace file's. A ledger with no such table gives none, so a store opened on the plans' tables alone reads as before.
   - An item names a service when its body holds the service's name as a whole word, whatever its case; a dash is part of a name, so `filter-api-v2` is not `filter-api`. An item that names none is on the workspace's first service, where the engine runs its ticket.
   - `PlanItem.sensitivity` lists those services with their sensitivity, `normal` included, so the plan panel (lane 22) can show the services and their chips. It is derived when the plan is read, never stored, and left out when there is no service.
   - **Fast to full.** A fast item that names a `full` service is made full in `planExtensions` (`tools.ts`), before `runner.propose` validates and estimates it, so its estimate is the full lane's and its ticket gets no Quick label. `runner.ts` is lane 17's in this wave, so it is not edited. The note goes at the end of the item's body ("Cleared: this item runs in the full lane, ..."), where the lead, the plan panel and the ticket's author read it. `plan_items.note` is not used, since the runner gives it to the author when it restarts a ticket.
   - `estimates.ts` needed no change: an item's estimate already follows the lane it is given.
6. **The lead's rules** gain a "Sensitive services" section: name the services in each body, and what `full`, `reviewer:<model>` and `human:<user>` mean for the lead. `LEAD_RULES` must stay under 5 KB (lane 7's test). It is now 5059 bytes, so the next lane to add a paragraph (lane 23) has about 60 bytes left and must make room.
7. **The approver of a `human:<user>` service.** The approver of a service is the user its sensitivity names, else the owner its lock trusts (`[tracker] owner_id`). The checks run before anything is held:
   - Another user answers 403: "Only alice approves the release of payments: its sensitivity is human:alice."
   - A ticket whose services name two different approvers answers 409 for everyone, naming each with its services. One gesture cannot be two people's, and a move signed for one of them would be refused by the other service's lock.
   - A ticket with no `human:` service is checked as before, by the approval writer.
   - The designated user's approval is signed for that user, never as the owner. In a train, `TrainApprovals` builds the first service's writer and each service's store with that service's approver as `ownerId`, so the moves the train signs later are that user's too, and Undo is that user's.
   - The one-service path keeps the registry's approval writer. The new `approverGate` in the route checks it, and refuses a `human:<user>` service whose lock trusts another `owner_id` as not set up (503, naming both), rather than signing a move that lock's `merge-pr.sh` would refuse.

   **This is a choice for the owner's review: a `human:<user>` service needs a lock that trusts that user.** That is the `[tracker] owner_id` of that service's `agents.conf`, which every lock already reads; v1's `tracker.sh moved-by-owner` compares the move's author with it. v2 does not read each train service's own lock settings (lane 16 reads one `agents.conf` for all of them). So a train service whose lock trusts another account refuses the move at its merge, and the train halts with its note, as for any refused move. Roles, and several approvers for one ticket, come with the several users of a later milestone.

**Consequences.**
- **Tests first.** The new tests were run against `origin/v2` at `596d085`. Without stub exports, three of the four files fail at import, and `card.test.ts` fails on the empty card. With stub exports added so they load, 27 tests fail there. The 7 that pass on both are the unchanged-behaviour guards: no report, no services table, a train of normal services, a non-human one-service workspace.
  - `test/release/flags.test.ts`: every flag from planted diffs, the groups, the header-like lines, a train's two diffs, quoted, deleted and binary files.
  - `test/release/card.test.ts`: the end to end. On the fake adapter, a report is planted as the author session's last `cleared.changes` event, and the release item made through lane 16's `addRelease` carries the groups and the `schema` and `dependency` flags.
  - `test/lead/plans/sensitivity.test.ts`: the fast item made full (its estimate from the full lane's history, its ticket without Quick), the chips in the published frame, the whole-name rule, the first service, no table, and the rules paragraph.
  - `test/approval/sensitivity.test.ts`: the owner's 403 naming alice; alice's 202, the moves signed for her, and the oracle of a lock trusting alice (0) and of one trusting the owner (6); Undo; the two approvers' 409; the one-service gate (403, 202, the 503 setup refusal); normal services unchanged.
- **Two files outside the lane's list:**
  - `v2/test/approval/support.ts`, under the lane's test folder: an `ownerId` option and a user `alice`.
  - The rules paragraph's test sits in `test/lead/plans/sensitivity.test.ts`, not in `test/lead/prompts.test.ts` (lane 13's), so no other test file is touched.
- **Not done here.** The engine passing `contracts` and `guarded` (followup above). The diff is cut at 4 MiB by `effects.ts` (`MAX_DIFF`), so a file past the cut gets no flag and is in no group. The card's rendering is lane 21's, and the chip on the plan panel lane 22's. `report_changes` and its validation are lane 17's.
- **Checks.** `npm test`: 835 node tests (832 pass, 3 skipped as before, for want of `CLEARED_V2_PLAYWRIGHT`) and 117 Vitest tests. `npm run typecheck` and `npm run guard -- --base origin/v2` pass.
- **The requirements matrix.** C10 and M8 name this lane's pull request (203) and its tests, both `partial` (C10: the card is lane 21's and the engine's two inputs are a followup; M8: the engine's part is lane 17's and the chip on screen lane 22's). The new line P19 records choice 7. Lanes 17 and 19, running beside this one, may also add P lines; the orchestrator renumbers at merge, as for lane 16's P18.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j2-release-intent-sensitivity`, at the orchestrator's request.

## 2026-10-22: the three memory levels (the author's choices, lane v2-j2-memory-levels)

**Decision.** Lane 19 applies decision 25 of the [milestone 2 plan](milestone-2-plan.md): `lib/memory` is run once for the workspace, once for the session's service and once for each contract its ticket touches. A handover's lessons are filed by level, the lead's briefing lists the services' pages, and `docs/memory.md` has a v2 section. Nothing under `lib/memory/` changed. The lane's choices:

1. **The workspace's level is milestone 1's memory, where it already is.** Decision 25 names `<state>/memory`. The lane keeps the workspace's level in the ledger the service already uses (`ORCH_LEDGER`, else `CLEARED_STATE_DIR/ledger.db`), read on the workspace's checkout (its first service's, `FlowConfig.projectDir`). Reason: each ticket's last handover, the approved decisions and the `handover_missing` events are rows of that ledger, so a new folder would lose them at the first start, and the lead's `search_memory` reads that ledger too. The other two levels follow the decision: `<state>/services/<name>/memory` and `<state>/contracts/<name>/memory`. `<state>` is the folder of the workspace's memory as `approval/service.ts` finds the state folder: `CLEARED_STATE_DIR`, `ORCH_STATE_DIR`, else the folder of `ORCH_LEDGER`. No field of `FlowConfig` is added.
2. **A level's environment names its ledger every way.** `lib/memory` reads `ORCH_LEDGER` before any state folder, and `lib/conf.mjs` copies each `CLEARED_*` into `ORCH_*`. A level's context therefore sets `CLEARED_STATE_DIR`, `ORCH_STATE_DIR`, `CLEARED_LEDGER` and `ORCH_LEDGER` to its own folder, which the service makes `0700`. A test plants `ORCH_LEDGER` for the workspace and finds three ledgers, each with only its own rows.
3. **Which levels a session reads.**
   - The service's level is left out when its checkout is the workspace's, so a page is never briefed twice. That is the first service of a workspace, and the only one of a one-service workspace, which is therefore briefed exactly as in milestone 1. A committed golden made by `origin/v2` at `596d085` proves it (`test/workspace/fixtures/briefing-m1.md`).
   - The contracts: the service's own, then those of the services it consumes, then those of the ticket's other services, each once.
   - The author's session fetches the workspace's checkout and the providers' before it is briefed, so a consumer reads the contract's page as its base has it. A fetch that fails is not in the session's way.
4. **A contract's files sit beside the contract.** For `contract/openapi.yaml`: the page `contract/openapi.md`, the glossary `contract/openapi.glossary.md`, the decisions `contract/openapi.decisions/`, the role lessons `contract/openapi.lessons/<role>.md`. The level is `lib/memory` on the provider's checkout, given those four paths through `createMemory`'s `conf` option. The plan names no file. Reason: the contract's level should not repeat its provider's page, and the page is next to the file whose change it explains.
5. **One byte budget.** The budget is the one the workspace's settings give the role (`[memory] budget_<role>`, else `budget`, 12 000 by default); a service's own setting does not apply. It is counted in the bytes of `lib/memory`'s own text, its reference line once. Each level is given what the levels before it left, so `lib/memory` keeps its own selection and its rule that a block is never cut. A level with nothing left is named "Not briefed: the memory's byte budget is used up"; one that left entries out says how many (its `memory_briefing` event). A level whose checkout is not on the server, or whose memory cannot be read, is named "Not briefed: this memory could not be read for this session", with no detail, since a detail could carry a path of the server. The session still starts. The workspace's level fails the briefing as in milestone 1.
6. **The rendered briefing.** Milestone 1's text is unchanged: the reference-data line once, then the five sections. The levels follow it, as `## Memory of the service <name>` and `## Memory of the contract of <name>`, each with only its non-empty parts (`### Page`, decisions, glossary, lessons), every entry quoted as before. The engine still gets the contract's five fields (`session/contract.ts` is not this lane's): the workspace's, with the levels' decisions, glossary and lessons after them.
7. **Lessons by level.**
   - A handover may end with `## Lessons for the workspace`, `## Lessons for the service` and `## Lessons for the contract`. The plan named the last two; the first is added so that "else the workspace's" has a heading too.
   - A heading counts as a whole line, at its start, outside a fenced code block, and the section runs to the next level-two heading (issue 35 asks the same of the five headings).
   - The text is taken from the entry `lib/memory` stored, not from a second read of the file.
   - Each section is written as a `lesson` of the author's role (`role:<role>`), with `agent:<role>/<model>` and `session:<id>` as its source, as a **proposal**. `lib/memory` briefs only committed lesson files, and approving knowledge is lane 24's inbox item (decision 27), so a filed lesson is not briefed. The ticket's own handover, which holds it, is still briefed in full, as in milestone 1.
   - The service is the one whose checkout the session worked in (`<workdirs>/<ticket>/<service>`), since `FlowEffects.captureHandover` carries no service and `flow/engine.ts` is not this lane's. Otherwise it is the workspace's first service.
   - A service whose checkout is the workspace's has no level of its own, so its lessons go to the workspace's memory. That is the first service, and the guestbook of the 48-hour proof. Every filed lesson is then in a ledger some briefing reads.
   - The contract is the service's own, else the first one it consumes. A level the session does not have files into the workspace's memory.
   - On a workspace of several services, the briefing tells the author where each heading is filed. A one-service workspace's briefing does not, to stay byte for byte.
   - A lesson that cannot be filed is logged with its level and the error's name, and the capture still answers the handover's id. Reason: the engine comments "The author's handover could not be stored" on any error of the capture (`flow/engine.ts`), which would be false once the handover is stored.
8. **The lead.** The lead's memory is the workspace's level. After it comes one entry, "The services' pages, first lines": for each service but the first, its name and the first line of its page, read in its level. The services are taken from `LeadEffectsConfig.services`, else from the environment's workspace (`loadFlowConfig`), never failing. A line is cut to 160 bytes and the list to 2000, with "and N more services." The lines come out of the lead's 12 000-byte budget, so the lead's memory stays in it. A service whose checkout is not on the server has no line. `lead/engine.ts` is unchanged.

**Consequences.**
- **Tests first** (commit `1416511`), each failing on `origin/v2` at `596d085`, where the exports and the service lines did not exist:
  - `test/workspace/levels.test.ts`: the level folders; the three levels in order with the reference-data line once; the shared budget, where the contract page fits alone but not after the others; a level the budget has no room for; the three ledgers with `ORCH_LEDGER` planted; a contract with no checkout; the headings' parsing; the three lessons sections filed in their levels as proposals; the workspace's fallback; the author told where each heading goes.
  - `test/flow/effects.test.ts`: a two-service workspace briefed in order; a consumer briefed with the contract's page and not the provider's, the provider cloned for it; the capture of a session on the filter API filing in its two levels.
  - `test/lead/briefing.test.ts`: the service lines, and a full list of services within the budget and under 20 KB.
  - The one-service golden of `test/flow/effects.test.ts` passed on the old code too. It is the regression test: the same project and ticket give the same file.
  - After the advisor's review of the first version, two more, each failing on commit `25b7117`: a guestbook session's service lesson lands in the workspace's ledger (it went to `services/guestbook/memory`, which nothing briefs), and a lesson that cannot be filed leaves the capture answering its id (it threw).
- **Issue 168, item 4, taken.** `test/lead/briefing.test.ts` briefs a refreshed generation with every part at its cap: 20 open commitments of 300 characters, a 9 000-byte account cut to 4 096, ten 1 000-byte messages, the memory at 12 000 bytes with 15 services' lines. It measures 34 800 bytes, as the lane 5 entry's "about 35 KB" says, and the test bounds it at 36 KB.
- **Not run here.** A real session on the two examples. The multi-service proof (lane 29) briefs its sessions this way.
- **For lane 24.** An approved knowledge item of level `service` or `contract` has to be written where a briefing reads it. `lib/memory`'s briefing reads committed files and approved decisions, not an approved `lesson` entry. Lane 24 either writes it as an approved decision of that level (its context is `levelContext` in `workspace/briefing.ts`), or lands it in a committed file, as its skill does.
- **For lane 23.** A ticket's contract step runs on the providing service, whose own contract comes first in its briefing.
- **The requirements matrix.** M1 is done (lane 14's model and this lane's levels, pull request 202). M4's note names the contract level. P20 records choices 1, 5 and 7 (P19 is lane 18's, merged first as pull request 203).
- **Checks.** `npm test`, `npm run typecheck` and `npm run guard` are green.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j2-memory-levels`, at the orchestrator's request.

## 2026-10-22: the session plan validated before the code, the author's report by intent, and the shapes of waves 9 to 11 (the author's choices, lane v2-j2-session-plan-gate)

**Decision.** Lane 17 applies decision 22 of the [milestone 2 plan](milestone-2-plan.md), writes the author's half of decision 23 (`report_changes`), the engine's half of decision 24, the inbox kinds that lanes 23 and 24 call, and the API shapes, routes and event names of waves 9 to 11. The author's first turn ends with its session plan, and the flow holds it until a Go. The lane's choices:

1. **The author's host tools** (`v2/src/flow/author-tools.ts`) are declared as data like the lead's and bound per author session by the engine.
   - `propose_session_plan` takes steps (1 to 30), files (paths in the checkout; the container's mount point is taken off, a path outside it is refused), a confidence (`low`, `medium` or `high`) and its reason.
   - `report_changes` takes groups of an intent and its files. A file named in two groups is refused, by name. A file the journal shows the ticket edited but no group names goes to "Other changes", a name the author may not use itself. A file the journal does not know (written by a command) stays in the group the author put it in. Lane 18 compares the report with the published diff.
   - Both journal on the calling session through the cleaner: `cleared.session_plan` and `cleared.changes`.
2. **The hold.** The tool answers at once and the author ends its turn: the runner gives up on a host call after 5 minutes, and the delay is 10. The engine holds at the end of the turn, when nothing else waits.
   - **Steps.** The hold closes the `author` step and opens `plan_gate`; the Go closes `plan_gate` and opens `author` again. The gate is thus counted apart from the working time, and a Change keeps one `plan_gate` from the first proposal to the Go.
   - **The plan.** It goes into the inbox as a `session_plan` item, and the session's phase is `waiting_human`. The session JSON answers it as `state.plan`, which is the last `cleared.session_plan`.
   - **The Go** is the plan journaled again with `go: { by, at }`, where `by` is the owner's id, `delay` or `lead`. The author is then told to carry the plan out and to call `report_changes` at the end.
   - **A Change** handles the item and sends the owner's message, framed as reference data, to the live author. The author's next proposal is a new item that replaces the first. A proposal made while a plan waits (the owner wrote to the author) replaces it too.
3. **The three Gos.**
   - **The owner's** is `POST /api/sessions/:id/plan/go`, or `.../change` with a message of at most 2000 characters. Both routes are in `flow/plan-gate.ts` and registered by the flow module, with the API's checks: the proof (401), the flow (503), a known user (403), then the session (404, or 409 when no plan waits).
   - **The delay's** is `[session] plan_go_minutes` of the service's `agents.conf` (10 by default), counted from the start of the hold. At the delay, a high confidence starts by itself; a medium or low one waits for the owner, through the night if need be. A held session is not idle: the idle stop skips it.
   - **The lead's** applies at once to a high confidence of a ticket the plan runner started (the `Origin` it already passes to `start`). Nothing waits in the inbox then. `lead/plans/runner.ts` needed no change, since the origin carries the plan item into the flow. A paused plan's running ticket still gets this Go, as rule 4 of the runner lets its running tickets go on.
4. **What is not proposed again, and what is not proposed at all.**
   - An author reopened after a review keeps its tools, but `propose_session_plan` is refused: its gate stays `working`, and a closed session's working gate is kept for its resume.
   - A new author started after a review, because the old one could not resume, is bound without the plan: its prompt asks only for the report, and the call is refused.
   - A first turn that ends with no plan holds the session for the same delay, unless a message makes it propose. At the delay the session is stopped with the `RUN_ERROR` code `no_plan`, and the ticket is put back with a note. That note says the author did not propose a session plan, so it never started on the code.
5. **Where the gate is on.** `FlowConfig.authorTools`, which `loadFlowConfig` always sets. A configuration written by hand, as milestone 1's and the tests of every other lane are, runs the flow as before: no tool, no plan asked, no gate. Lane 16's one-service fixture still matches. `[session] plan_go_minutes` is in `ProjectSettings` only when the service sets it, so the settings tests of lane 19's `effects.test.ts` see nothing new.
6. **The policy.** The runner asks the policy before every tool call, and `session/policy.ts` (not this lane's file) has no row for an author's `mcp__cleared__*` tools, so a real author's call would become a permission request. The engine therefore adds the author's two tools as learned answers in the policy it gives the session and in `policyFor`, and only those two names. A row `author.tools` beside the lead's `lead.tools` is a followup for lane 25, which owns the policy in wave 9.
7. **The inbox kinds** (`v2/src/inbox/store.ts`).
   - **`session_plan`** is a request of its session: it counts in `waitingFor`, no answer route finds it, and it leaves with the session (`handleSession`) and at a restart (`handleRequests`). It is numbered per session, so a plan proposed again in the same second is a new item.
   - **`contract`** (a ticket, a step, the providing service, the contract file and its diff) and **`knowledge`** (a text, a level, the service when the level is not the workspace's, the source session) outlive their session. Each has its add, its list and its handle method, and the handle writes `outcome` (the decision, the message of a Send back, by whom and when). An item is handled once; a second answer is refused.
   - The service and the step are kept in the payload, not in lane 14's `flow_inbox.service` and `step` columns, which the tests' tables, made without the migrations, do not have.
   - `list()` stays typed `InboxItem[]`, because `modules/notify.ts` types the inbox by it, but it returns every kind, as `GET /api/inbox` answers them; the notifications and the lead's state skip a kind they do not know. `items()` is the typed accessor (`NextInboxItem[]`). Lanes 21 and 27, whose screens map every kind, join the new kinds to `InboxItem`.
8. **Decision 24 in the engine.**
   - The reviewer is named by the first service of the ticket that names one with `reviewer:<model>`, else the configured reviewer.
   - A Quick ticket is written by the author model, not Haiku, when a service it touches is `full`, or when Haiku reviews it, so the reviewer is always another model.
9. **The API of waves 9 to 11** (`v2/src/api/types.ts`).
   - **The shapes:** `TicketStep`, `ContractItem`, `KnowledgeItem`, `Ask` and `AskAnswer`, `Recipe`, `Schedule`, `TerminalChunk` (with `TerminalClosed`, the bodies and `TERMINAL_INPUT_MAX_BYTES` of 4096), `FileWrite`, `FileWriteRefusal`, `FileWritten` and `HumanEdit`.
   - **The paths the plan fixes:** lane 25's asks, lane 26's recipes and schedules, lane 31's terminal and the `PUT` of the editor's save.
   - **The paths this lane chose:** `GET /api/tickets/:id/steps` and `POST /api/contracts/:id/approve` and `sendback` for lane 23; `POST /api/knowledge/:id/approve` and `reject`, and `POST /api/services/:name/skill` for "Update the skill now", for lane 24. A contract or a knowledge item is named by its inbox id. None is under `/api/lead` or `/api/plans`, which the lead module's route list is read from.
   - **The exclusions.** Each group is a list (`STEP_ROUTES`, `KNOWLEDGE_ROUTES`, `ASK_ROUTES`, `RECIPE_ROUTES`, `TERMINAL_ROUTES`), excluded from `test/flow/api.test.ts` with its serving lane named. `SESSION_PLAN_ROUTES` leaves the exclusions, since lane 17 serves them. The route list holds 51 routes.
10. **The event names.**
    - `plan_gate` joins `STEP_NAMES`.
    - `cleared.session_plan` and `cleared.changes` are this lane's.
    - `cleared.terminal_opened` (by whom, the size), `cleared.terminal_input` (one line, by whom), `cleared.terminal_closed` (why, and the output's byte count, never the output) and `cleared.human_edit` (a `HumanEdit` without its time, never the content) are lane 31's to emit.
11. **Files outside the lane's list.** None. The tests changed under `test/flow/` are the lane's, `effects.test.ts` excepted. Among them, `modules.test.ts` now lists the flow module's two plan routes.

**Consequences.**
- **Tests first.** Commit 73edb86 holds them alone, and each failed on `origin/v2` at 596d085, where `flow/author-tools.ts` and `flow/plan-gate.ts` did not exist. The new files are:
  - `test/flow/author-tools.test.ts`, `inbox-kinds.test.ts`, `plan-gate.test.ts`, `plan-routes.test.ts` and `sensitivity.test.ts`;
  - new cases in `test/flow/config.test.ts`, `test/api/types.test.ts` (the 51 routes and the shapes), `test/session/events.test.ts`, `test/flow/modules.test.ts` and `test/flow/api.test.ts`.
- **What `plan-gate.test.ts` proves**, on the fake adapter:
  - a high plan still waits at 9:59 and starts at 10:00 by the delay;
  - a medium plan still waits at 11 minutes and two hours later, never idle-stopped, until the owner's Go;
  - a Change reopens the author with the message, and the next proposal replaces the first;
  - a ticket the lead started with a high plan starts at once, and a medium one waits;
  - a reopened author, and a new one after a failed resume, propose nothing;
  - a silent first turn is put back at the delay, which `plan_go_minutes = 25` moves past the 15-minute idle stop;
  - a report with a file in two groups is refused, and the next one is kept;
  - a restart handles a waiting plan.
- **A test made stable.** `test/flow/engine.test.ts`'s idle test depends on how many microtasks a tick yields before its idle check. The engine's own journaled events are read by the session's loop as activity, so a tick that yields earlier moves `lastActivity`. The gate's scan in the tick is therefore synchronous, after the idle loop: a tick with nothing due yields as before. The race itself was there before this lane and is left as it is.
- **Checks.** `npm test`: 833 node tests, 830 pass and 3 skipped as before; 117 Vitest tests pass. `npm run typecheck` and `npm run guard -- --base origin/v2` are green.
- **Section 8's unknown** ("whether the author proposes a plan before reading the code, or after, and how long the gate adds") is not closed here: it needs a real author, in the proof (lane 29). The prompt asks the author to read what it needs, then propose before any change.
- **Open, for other lanes:**
  - A waiting session plan raises no notification: `flow/events.ts` and `notify/sources.ts` are not this lane's files (lane 26 owns both in wave 10). The inbox and the session JSON show it.
  - The author is not kept read-only before its Go: a model that writes code in its planning turn is not stopped by the policy. A read-only policy until the Go needs the policy's rows (lane 25).
  - The app's session catalogs have no `step_plan_gate` key yet (lane 20's file in wave 8).
  - Lane 21 renders the `session_plan` item, and lane 27 renders the `contract` and `knowledge` items. Until lane 21 lands, the inbox screen receives `session_plan` items from `GET /api/inbox` with no rank, title or chip key for that kind: a real server with the gate on shows them as unlabelled rows.
  - **The rehearsal of lane 11 stops completing once this lane lands.** `scripts/proof-rehearsal.ts` starts the real service (`src/main.ts`), where `loadFlowConfig` turns the gate on. The rehearsal's author scripts never call `propose_session_plan`, so each author is put back with `no_plan` after the delay. The plan runner starts it once more, then holds the item. Lane 29 needs both changes: a proposal step in the author scripts (`src/session/adapters/index.ts`), and a Go in the morning rule of `proof-inbox.ts`.
- **The requirements matrix.** C8, C9, C10, C2, M2 and M8 name this pull request (204) and are `partial`. P21 records the gate's choices and P22 the policy's answer to the author's tools (P19 and P20 are lanes 18's and 19's, merged first as pull requests 203 and 202).
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j2-session-plan-gate`, at the orchestrator's request.

## 2026-10-22: Owner decision: the CSSOM style-attribute function of pull request 199 is validated

**Decision.** On 2026-10-22 at 11:27 (Europe/Paris), the owner validated the CSSOM style-attribute function of pull request 199: `installStyleAttributeCssom` in `v2/app/web/lib/style-nonce.ts`, which the lane `v2-j2-deps-xterm` added for the orchestrator to confirm (its log entry of 2026-10-22).

- Consequence: lane 32 installs both functions of the shim, `installStyleNonce` and `installStyleAttributeCssom`, as that entry says. Matrix line O14 records the decision; P14's note on a refusal of that part no longer applies, and P17 names the validation.
- Author: the owner, relayed on 2026-10-22 11:27 (Europe/Paris); written in this log.

## 2026-10-22: the plan panel's services, the tower's workspace line and the lead's train lines (the author's choices, lane v2-j2-plan-flags-screens)

**Decision.** Lane 22 (pull request 209) applies the lead and tower parts of decisions 18 and 24, and the tower's part of decision 30, of the [milestone 2 plan](milestone-2-plan.md). It edits only the plan panel, the lead and tower screens, their catalogs and fixtures, and their tests. The lane's choices:

1. **The plan panel's chips** (`app/web/plan-panel/`).
   - Each item names the services its body names, from lane 18's `PlanItem.sensitivity`. A service of normal sensitivity is a quiet tag. `full`, `reviewer:<model>` and `human:<user>` read "full review", "reviewed by Opus" and "approved by <user>", with a shield, in ink, never in amber, which stays for what waits for a person.
   - **When they show.** Once the plan names two services, or one item names a service that is not of normal sensitivity. A plan of a one-service workspace shows no chip, so it reads as before.
   - **A sensitivity this screen does not know** reads as written ("guestbook · audit:weekly"), never as an unknown key.
   - **Opt-in, for the inbox's sake.** The chips' keys (`PLAN_SERVICE_KEYS`) are not in `PLAN_PANEL_KEYS`, which the inbox's catalog must hold. The inbox's catalog is lane 21's file in this wave, and the translator throws on a missing key, so a chip in the inbox's plan item would blank it. The lead screen asks for the chips with `services: true`; the inbox draws the panel as before until its catalog holds the five keys and it passes the option. That is a followup for the inbox's lane (21, or 27 in wave 10).
   - **Issue 177, item 2.** A plan or item state the maps do not know reads as the service wrote it, instead of throwing.
2. **The tower's workspace line** (`app/web/screens/tower/`).
   - It shows only for a workspace of two services or more, read from `GET /api/workspace` apart from the tower's own reads: a service without the route, or a workspace of one service, shows milestone 1's tower, byte for byte (a test compares the markup).
   - Each service shows its live sessions (from `SessionSummary.service`) and one train: a landing in progress on it (the first stop of a `landing` train that is not yet healthy), else a train rolled back in the inbox's day (handled release items stay listed a day). Only the rollback is in red.
   - In such a workspace each live session names its service beside its ticket.
3. **A session taken over** (decision 30, lane 16's shape).
   - It stays among the live sessions when `takenOver` is set or when its phase is `paused` (lane 20's phase), and reads "Taken over by you · 6 min" in place of its phrase, with a still ink dot.
   - **Who.** `takenOver.by` is a user id, and no route maps an id to a name. The tower says "you" when the id is the signed-in user's, else "another account". In milestone 2 only the owner account takes over (decision 32), so the owner reads "you".
4. **The services of a new ticket.** A chip per service in the bar, shown with the description once a title is typed, as a Radix toggle (`aria-pressed`). The body carries `services` only when some are picked, since the service takes a non-empty list or nothing (lane 14).
5. **A session plan in Needs you.** Lane 17's `session_plan` items reach `GET /api/inbox` since pull request 204, and the tower put an `undefined` card in its needs for them (the render then fails on `card.kind`). It now draws them: the ticket's title, the plan's reason and its confidence ("Medium confidence: the author waits for your Go."), linked to the inbox. A kind the tower does not draw yet (a contract, a knowledge item: lane 27) is left out instead.
6. **A blocked train in Needs you** says the block's reason and "It cannot be approved as it is; its card proposes how.", never "Your approval ships it."
7. **The lead's train and block lines** (`app/web/screens/lead/`).
   - No thread message says a train: `LeadMessage` has no kind for one, the lead hears of landings and rollbacks in its event turns only, and `src/api/types.ts` belongs to no lane in wave 8. So the screen reads the trains from the inbox's release items that carry `train`, waiting or handled in the last day, and places each line among the lead's messages at the time its train last moved (the latest of the item's time and its stops' times).
   - A line says where the train is, each service in landing order with its pull request and state, a block's reason and proposal, and links to the card. A block or a train waiting for approval is amber; a rollback or a halt is red.
   - The screen reads the inbox once the thread is there and at each 30-second tick (`LeadAgent.readTrains`). The agent's start keeps its three reads, which `web/test/copilot.test.tsx` pins.
   - A thread line written by the service, so the lead's own account and the screen agree, is a followup for a lane that owns the lead's types.
8. **Issue 173, item 5.** A test pins the tower's `DRAFT_MAX` to the lead screen's.
9. **Fixtures.** The capture's data is unchanged. New values sit beside it: `WORKSPACE`, `trainItems`, `workspaceFixture` and `towerSource` in `fixtures/tower.ts`; `servicePlan` in `fixtures/lead.ts`, and `leadSource` answering the inbox with release items. `fixtures/source.ts`, lane 20's in this wave, does not answer `/api/workspace` yet; `towerSource` stands in for the tests and the visual loop, and lane 20 can serve `WORKSPACE` from it.

**Consequences.**
- **Tests first.** The tests were written and run before any change to the screens: on the code of `origin/v2` at 26fafbd plus the lane's new fixture values (data only), every new test failed (3 of 3 node test files at import, 10 of 13 Vitest tests), and the old `towerModel` returned `["release","permission","plan",undefined]` for an inbox with a session plan. Commit 30d4ecb holds the code with them, and the pull request quotes the red runs. The new files: `app/test/lead/services.test.ts`, `app/test/lead/trains.test.ts`, `app/test/tower-workspace.test.ts` (models, `node --test`); `app/web/test/lead/services.test.tsx`, `app/web/test/lead/trains.test.tsx`, `app/web/test/tower-workspace.test.tsx` (components, Vitest). Among them: creating a ticket with two services posts both, with a stubbed api and through the app to `towerSource`.
- **Checks.** `npm test`: 905 node tests, 902 pass and 3 skipped as before (883 before the lane); 130 Vitest tests pass (117 before). `npm run typecheck` and `npm run guard` are green.
- **The visual loop.**
  - The app ran on an ephemeral `127.0.0.1` port (after `ss -ltn`) with `towerSource`, `leadSource` and the fixture source, a fixed clock at the fixtures' time, in headless Chromium.
  - Captures, none committed, mode 644: `/tmp/cleared-captures/j2/lane22-<screen>-<width>-<theme>.png` for `tower`, `tower-bar` (a title typed, both services picked), `tower-plain` (one service), `lead` (the plan across two services, the three trains) and `lead-plain`, at 1440, 1280, 768 and 390, light and dark; and `lane22-reference-tower.png`, `lane22-reference-lead-and-plan.png`, rendered from `/tmp/cleared-reference/`.
  - All 40: no horizontal overflow, no page error, no `securitypolicyviolation`, no request off the app's origin.
  - In the same browser, the bar's picks reach the route: with both services picked (one picked, unpicked and picked again), `towerSource` received `services: ["guestbook","filter-api"]`, the chips were reset after the creation, and a second ticket with none picked was posted with no `services`.
  - The browser tests run with `CLEARED_V2_PLAYWRIGHT`: both of `app/test/choices-browser.test.ts` pass, the lead's question answered by its option included. `app/test/notify/browser.test.ts` times out waiting for the notifications toggle, on this branch and on `origin/v2` at 26fafbd alike, in this server's headless Chromium: it does not come from this lane.
- **The art director's pass** was run once, by Sonnet 5.5 in a fresh session, on the captures, the references and `app/DESIGN.md`.
  - Taken: the service chips of the bar outlined in ink with a check when picked, never the ink fill of the bar's actions, 28 px on a computer and 44 px on a phone; the live session's service tag in Geist, rounded, muted; the workspace line tied to the greeting; the landing dot in ink instead of the reviewer's teal; the taken-over line's icon at 16 px in ink; a shield instead of a square on a sensitive service, a lighter outline; the train's stops wrapping as rounded boxes on a phone; the block's reason and proposal at 13 px.
  - Not taken: the ticket ids inside the workspace line in mono (they sit inside a translated sentence); the plan item's chips and "After" on one line on a phone (the item's grid is lane 8's layout); the first bubble cut under the thread's header on a computer (the thread scrolls to its end, as lane 8 built it).
  - Not a regression: `tower-plain` matches the reference.
- **Open, for other lanes:**
  - The inbox's plan item shows no service chip until the inbox's catalog holds `PLAN_SERVICE_KEYS` and its panel passes `services: true` (lanes 21 or 27).
  - The fixture source answers `/api/workspace` in lane 20 (`WORKSPACE` is exported for it).
  - A thread line for a train written by the service, as above.
  - The tower names another account's takeover "another account" until a route maps a user id to a name.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j2-plan-flags-screens`.

## 2026-10-22: the release card as a train, the groups and flags, and the session plan in the inbox (the author's choices, lane v2-j2-inbox-train)

**Decision.** Lane 21 applies the inbox's part of decisions 21, 22, 23 and 24 of the [milestone 2 plan](milestone-2-plan.md) (complement item 10, multi-repository item 5), on the React port, in the lane's files only: `v2/app/web/screens/inbox/**`, the `inbox` catalogs, `v2/app/fixtures/inbox.ts`, `v2/app/test/inbox/**` and `v2/app/web/test/inbox/**`. The lane's choices:

1. **`api/types.ts` is not edited; the screen reads `NextInboxItem`.** The logs of lanes 16 and 17 say lane 21 joins the new kinds to `InboxItem`. But the wave 8 table gives `types.ts` to no lane, and `InboxItem` is switched on exhaustively in files of other lanes: `notify/sources.ts`, `notify/dispatcher.ts`, the tower's model and the tower's and session's fixtures. So the inbox's model names `Item = NextInboxItem`, and every function of the screen maps the seven kinds.
   - `known()` leaves out a kind the screen does not know. A later kind is then not drawn as a row with no words, as a `session_plan` was on `v2` before this lane: no chip, a NaN in the sort, and a detail that crashed.
   - The shared test helper `web/test/render.tsx` keeps `renderActions(item: InboxItem)`. This lane's tests go through `renderDetail` for the new kinds.
   - **Followup for lane 23**, which owns `types.ts` in wave 9: join the kinds to `InboxItem` with the notifications and the tower, or keep `NextInboxItem` as the screens' type.
2. **The order of the kinds:** release, permission, session plan, the lead's plan, question, contract, knowledge. A session plan holds its session as a permission does.
3. **Approve only when the card can be approved.** `approvable(item)` is true for a release with no train, or with a train that waits.
   - A blocked train shows its reason and the service's proposal. It offers Send back and "Ask the lead to add the step", a link to `/lead` and the primary gesture: decision 21 leaves the owner the lead's missing step.
   - A train that lands, landed, rolled back or halted shows where it is, "Nothing to approve now", even if its item reads waiting (P18: the ticket goes back to the validate state between two landings).
   - A train's Approve reads "Approve 2 pull requests" and stays bound to every head (`approveBody`, unchanged).
4. **Where a train is, in the list and on the card.**
   - The list line reads "LOCAL-170 · 2 services · Reviewed by Sonnet, checks green" while the train waits. In any other state it reads "LOCAL-170 · Landing, 1 of 2 landed", "Landed, 2 of 2", "Rolled back, 2 of 2" (the reverted ones), "Halted, 1 of 2 landed" or "Blocked: a consumer is not changed".
   - A state chip sits beside the kind, so a rolled-back train filed under "Handled today" is still seen.
   - Each service shows its state (waits for your approval, lands next, merged with its health being checked, landed and healthy, unhealthy, reverted), its time and its note. The detail is drawn again when a service's state, time or note changes (`detailKey`).
5. **The groups and the flags.**
   - The groups are the service's, in its order. "Other changes" (`OTHER_CHANGES`, kept equal to `release/flags.ts` by a test) is translated.
   - A flag is a chip with its meaning, both from the catalog by kind, in the service's order. Each file a flag names carries the flag's chip.
   - The service's `detail` text is not shown: it is English. What it adds to the catalog's meaning is lost on screen: the guard's pattern names for `secret_shape`, and the line count for `large`.
   - The catalog names `secret_shape`'s keys `flag_credential_shape` (`flagKey()`). The guard's strict pass (`--base origin/v2`) reads a catalog key with "secret" in it, followed by a text with a space, as an assigned secret, and an object literal mapping that kind as a literal secret.
6. **Sentences from the service are shown as data, in English:** the compatibility line, the block's reason and proposal, and a service's note. The service writes them in `release/order.ts` and the train. Translating them needs their parts in the API, a change of `types.ts` for a later lane.
7. **The session plan.**
   - Its title is the ticket's title, else its first step. The detail shows the service, the confidence with its reason in a card of the confidence's colour, the rule that applies while it waits ("A medium or low confidence waits for your Go", or that a high one starts by itself after the delay), the steps, the files, the session and when it was proposed.
   - **Go** posts `/sessions/:id/plan/go` with no body.
   - **Change** first opens a field. Its text is trimmed, and an empty one or one over `CHANGE_MAX` (2000, kept equal to `flow/plan-gate.ts` by a test) is refused before sending. Then it posts `{ message }`. The text is kept by the screen, not by the detail, so a refused Change keeps it.
   - **Refusals:** 404 or 409 means no plan waits any more, so the item is settled and the inbox reloaded. 403 is an unknown user, 503 a service without the flow, and 400 a refused message.
   - A handled plan says who started it: you, a user's id, the delay or the lead (`SessionPlan.go`).
8. **The contract and knowledge items** have their rank, their chip, their list line and a read-only detail: the contract's diff, the knowledge's text and level. Their bar says "Shown for reading". Lane 27 replaces `ContractBody` and `KnowledgeBody` and adds the gestures.
9. **A train with no picture** of its screens shows no frames. A release of one service keeps milestone 1's frames, empty or not, and is unchanged otherwise.
10. **The fixture.** `trainRelease(now, state)` builds the multi-service proof's first ticket (filter-api, then guestbook) in each state, and its third ticket for `blocked`. The fixture also exports `sessionPlanItem(now, confidence)`, `contractItem` and `knowledgeItem`.
    - `inboxFixture(now, { train, sessionPlan, reading })` adds them to the list. The default stays the capture's four waiting items, so the earlier tests are unchanged.
    - `inboxSource` answers the plan's Go and Change as lane 17's routes do, and refuses a blocked train's approval with 409 and the proposal, as lane 16's route does.
    - `fixtures/source.ts` (lane 20's in this wave) is not edited. In the app's fixtures mode the new kinds therefore do not appear yet.
11. **Selectors for lane 29:**
    - the train: `data-train` (its state), `data-train-line` and `data-train-chip`;
    - each service: `data-stop` with `data-state`;
    - the block: `data-blocked`;
    - the changes: `data-flag`, `data-group`, `data-file` and `data-file-flag`;
    - the session plan: `data-confidence`, and `data-act` set to `plan_go`, `plan_change`, `plan_change_send` or `plan_keep`.

**Consequences.**
- **Tests first.** Commit `47b8e31` holds them alone, with the fixture. On `origin/v2` at `26fafbd`:
  - the 14 Vitest tests fail: the blocked card shows Approve, a `session_plan` item crashes the detail in `answersFor`, and the new kinds have no catalog key;
  - the node file fails at import, since the model's new functions did not exist.
  New files:
  - `app/test/inbox/train.test.ts`:
    - the order of the kinds, and an unknown kind left out;
    - `approvable` and the train's lines in both languages;
    - each service's line, and the detail's redraws;
    - the session plan's title and line, and who gave the Go;
    - Go and Change against a stubbed api, and the Change's checks and refusals;
    - through the app's forwarding, Go as the signed-in user, then a second Go settled, and a blocked approval refused with 409;
    - `OTHER_CHANGES` and `CHANGE_MAX` equal to the service's;
    - the catalogs complete, with no em dash.
  - `app/web/test/inbox/train.test.tsx`: rendering on the fixture of a two-service train in each state (waiting, blocked, landing, landed, rolled back, halted), the groups and the flags, the `secret_shape` chip, the list's state chips, the session plan item and its Change field, the reading items, every word from the catalog in both languages, and no inline style.
  - `app/web/test/inbox/plan.test.tsx`: its item lists are typed `NextInboxItem`.
- **Checks.**
  - `npm test`: 898 node tests (895 pass, 3 skipped as before) and 134 Vitest tests.
  - `npm run typecheck` is green.
  - `npm run guard -- --base origin/v2` is green. It ran without a private-term list, since `CLEARED_REPO` is unset here.
- **Captures**, none committed, in `/tmp/cleared-captures/j2/`:
  - `inbox-train-<scenario>-<width>-<theme>.png` for `inbox` (the list with the waiting train), `inbox-blocked`, `inbox-landing`, `inbox-rolled-back` and `inbox-session-plan`, at 1440, 1280, 768 and 390, light and dark. That is 40 files, mode 644, with the pointer away from every button.
  - `inbox-train-reference-inbox.png`, rendered from `/tmp/cleared-reference/inbox.html`.
  - The app ran on an ephemeral `127.0.0.1` port with the fixture's source. There was no page error, no request off the origin and no horizontal overflow.
- **The art director's pass** was run once, by Sonnet 5.5 in a fresh session, on the captures and the references.
  - **Taken:**
    - Approve on one line ("Approve 2 pull requests");
    - the flags' chip and meaning on one row on a phone;
    - the train's state chip in the list;
    - the confidence as the card's colour, with a stronger chip;
    - "Ask the lead" as the blocked card's primary gesture;
    - "Proposed" showing the time alone;
    - the stop's time muted, apart from its state;
    - the rail between two services closed.
  - **Not taken:**
    - a red kind chip reading "Rolled back" in place of "Release": the kind chip stays the kind, and the state chip sits beside it;
    - the session plan's empty space above the bar: it is the detail's fixed height, as for every kind.
- **Followups.**
  - Lane 23: the kinds and `InboxItem` (choice 1).
  - Lane 26: the notification of a waiting session plan (issue 207, item 7; `flow/events.ts` and `notify/sources.ts` are its files).
  - Lane 27: the contract and knowledge items' gestures (choice 8).
  - Lane 29: the selectors (choice 11). The multi-service proof's step 9 reads "Rolled back, 2 of 2" with a capital R. The fixtures source does not serve the new kinds yet (choice 10).
  - Issue 179, item 1 (the lead's sentinel on a release) and issue 155's items stay open: they are not this lane's.
- **The requirements matrix.**
  - C8 and C9 name this pull request (208) and its tests. They stay `partial` for the session screen's Plan tab (lane 20).
  - C10 names it too, `partial` until lane 23 passes `contracts` and `guarded`.
  - M5 names it too, `partial` until the multi-service proof's steps 6 to 10.
  - The new line P24 records choices 1 and 3 (P23 is lane 22's, merged first as pull request 209).
  - Lanes 20 and 22, beside this one, may also add P lines; the orchestrator renumbers at merge.
- **Review round 1 (Sonnet 5.5), taken on 2026-10-22: the Blocked chip.**
  - **The blocking item.** The list's Blocked chip had the class `blocked`, the train's state, so it took the detail's blocked panel rule: its padding, its ring and its margin. It is now `train-chip-<state>`, and the panel rule is scoped to `.d-body .blocked`.
  - **The check.** `app/web/test/inbox/train.test.tsx` checks that no chip's class holds a bare state. It failed on the previous `Inbox.tsx` and passes now.
  - **The captures.** The blocked set was captured again at the four widths in both themes. A new `inbox-train-inbox-blocked-list-*` set shows the list with nothing selected at 768 and 390, where the chip was also wrong.
  - **Followups taken:**
    - the blocked card's two buttons are centred, and stacked under 400 px (2);
    - the stop's state line lost its `aria-label` (4);
    - a Change whose plan no longer waits drops its text (5).
  - **Followup 6, said here:** the 768 and 390 captures are full-page, so the sticky action bar shows in the middle of the page. That comes from the capture, not from the screen.
  - **Left:** followup 3, "Rolled back" twice on a handled train's card (the chip and the line). The line is what the multi-service proof's step 9 reads.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j2-inbox-train`.
## 2026-10-22: the session screen's four tabs, Take over and Give back, the files route and the preview listener (the author's choices, lane v2-j2-session-tabs)

**Decision.** Lane 20 applies decision 30 of the [milestone 2 plan](milestone-2-plan.md) and the app's half of decision 20. The session screen's middle panel has four tabs: Plan, Terminal (opened first), Editor (read only) and Browser. Take over and Give back sit beside them. The service gains the files route, Take over and Give back, and the paused session; the app gains its preview listener. The lane's choices:

1. **"Paused" is said by `takenOver`, not by a phase.**
   - `src/api/types.ts` belongs to no lane in wave 8, and the screens map every member of `SessionPhase`. So the row's status keeps the harness's phase (`waiting_human` once the turn is interrupted), and the session's summary and state carry `takenOver: { by, at }`, which lane 16 wrote for this.
   - The engine keeps who took a session over in memory. A restart stops every live session (`recover`), so a paused one is stopped as any other: nothing is left paused with no process behind it.
   - No event name, step name or column is added: `session/events.ts` and the store are not this lane's files.
   - The screens read `takenOver` (this lane's session screen; lane 22's tower).
2. **What Take over does** (`POST /api/sessions/:id/takeover`, `flow/takeover.ts`; the engine's `takeOver`):
   - Only an author's live session is taken over. A reviewer's is refused (409): its policy reads only, and decision 33's saves are refused during the review.
   - The session is marked paused first, then its turn is interrupted. The end of the interrupted turn is therefore never taken for the end of the work.
   - The adapter cancels the request of the turn it interrupts. Any permission or question still waiting is then settled here, once, as `cancelled` with the rule `takeover`.
   - A session plan waiting for its Go stays in the inbox. Settling it would break the gate after Give back.
   - The owner check: the first account of the users table (`users.list()`, ordered by creation). Any other signed-in account gets 403 before the session is looked at, so nothing changes. Give back is the owner's too, and only by the account that took the session over.
3. **What the flow leaves alone while a session is paused:**
   - the idle stop;
   - the delay's Go and the put-back of a session that proposed no plan (`#dueGates`);
   - the end of a turn (no review, no gate);
   - messages, answers, the Go and the Change, which answer 409 ("give it back first").
   An interrupt is still allowed.
4. **Give back** (`POST /api/sessions/:id/giveback`) calls the adapter's `resume` with the same id. The Claude Code adapter returns the open handle in the common case (as the followup of pull request 189 notes).
   - **A handle that `resume` made anew** replaces the old one. The old reading stops, so no event is handled twice.
   - **The idle rule** counts from the Give back.
   - **The notice.** The session is told, as the flow's user, that the owner gave the session back and that it should read again any file before editing it. Lane 31 adds the list of changed files to that notice.
   - **No notice while its plan waits for a Go:** the Go is what tells it.
   - **A `resume` that fails** answers 503 and leaves the session paused, so the owner can try again.
5. **The Terminal tab of a session taken over** shows the command that resumes it in its container, `docker exec -it cleared-v2-<id>-session claude --resume <id>`.
   - The container's name is copied from `sessionNames` into the screen's model, and a test keeps the two equal.
   - The harness's session id is Cleared's (`images/session/runner/main.ts`).
   - The composer is disabled while the session is taken over. Lane 32 mounts the web terminal beside the command, which stays the fallback of decision 32.
6. **The files route** (`GET /api/sessions/:id/files` and `files/<path>`, `flow/files.ts`).
   - **Why no host git.** The session writes its checkout, and `workspace/checkout.ts` says the host reads it without git once a session has run.
   - **The list** is the session's stored edits, relative to its checkout, with the Changes card's counts. A file changed only by a command is not listed.
   - **A file** is read with no link followed:
     - every folder of the path is a plain folder;
     - the file is opened with `O_NOFOLLOW`;
     - the real path of the opened file (`/proc/self/fd`) must still be inside the checkout and outside `.git`, which catches a folder swapped for a link between the check and the open.
   - **What is refused:**
     - a path the session's own `Read` is denied (`evaluate()` of `session/policy.ts`: `.env`, keys, credential files) answers 403 with the rule;
     - the checkout's `.git` answers 403;
     - a file with a NUL or that is not UTF-8 answers 415;
     - a file over 16 MB answers 413.
   - **The text** goes through the events' cleaner, cut at 400 lines. `lines` is the whole file's count and `cut` says it was cut, and the screen writes the sentence.
   - **The hash** is the SHA-256 of the whole file's bytes, which lane 31's save sends back.
   - **The diff.** `SessionFiles` has no diff, so `?version=base` answers the same file as the ticket's base holds it. Its commit is read from the checkout's `refs/cleared/base`, without git. The file itself is read by `git cat-file blob` in the service's own project checkout, which no session writes, with the safe settings of `checkout.ts`. The screen draws a line diff of the two.
   - **The workdir** is the one the engine started the session with (`sessionWorkdir`). A session of an earlier process answers 409.
   - **One route per depth**, up to 16 segments, since the registry matches a fixed number of segments.
7. **The preview listener** (`app/src/preview.ts`, started by `app/main.ts`).
   - **Where it listens.** `127.0.0.1:CLEARED_V2_PREVIEW_PORT`, 8794 by default. A reserved port, the app's or the service's is refused.
   - **Its origin.** `CLEARED_V2_PREVIEW_ORIGIN` when set, else the loopback address.
   - **What it answers.** `GET` and `HEAD` of `/preview/<session>/<key>/<path>` only, from the service's `/api/sessions/<session>/preview/<key>/<path>`. It asks with the app's proof and no other header.
   - **What it never passes on.** The browser sends it the app's cookie, since cookies do not tell ports apart. The listener forwards that cookie to no one, and drops every `Set-Cookie`.
   - **Its own policy** is `sandbox allow-scripts allow-forms; frame-ancestors <the app's origins>`.
   - **What it refuses.** Another path answers 404, a write 405, another `Host` 421.
   - **Redirects.** A redirect to the sibling is kept under the session's preview address.
   - **The settings live in `preview.ts`**, since `app/src/config.ts` is not this lane's file.
8. **The app's side of the preview** (`app/src/server.ts`), beyond `frame-src`:
   - **The policy** gains `frame-src <the preview origin>` when there is one, and is unchanged otherwise.
   - **The page learns the origin** from `<body data-preview>`. `/api/me` is lane 31's in wave 10, and `Me` is in `lib/screen.ts`, not this lane's file.
   - **The app's origin refuses `/api/service/sessions/<id>/preview/...` (404).** Before this lane, that path reached lane 15's route with the proof. `proxy.ts` drops the sandbox policy, so a page the session wrote would have run on the app's origin, under its policy, with the owner's cookie.
   - **The Browser tab's frame** is `sandbox="allow-scripts allow-forms"`, never `allow-same-origin`, with `referrerpolicy="no-referrer"`.
   - **On the public origin** with a loopback preview origin, the tab says the trial environment opens on this machine's browser only.
9. **The screen.**
   - **The tabs** follow the ARIA tabs pattern (the arrow keys, Home and End), built from plain buttons. No new dependency, and neither of lane 30's packages: both wait for lane 32's style nonce.
   - **The address keeps the tab** (`#plan`, `#editor`, `#browser`). Every milestone 1 id and `data-` selector stays on the Terminal tab, so the proof scripts are unchanged.
   - **The plan.** The Plan tab shows the session plan, its confidence and reason, its steps and files, Go and Change (at most 2000 characters) while it waits, then who gave the Go, and the ticket's criteria.
   - **The left plan card** says the plan in short.
   - **The timeline** shows the proposal and the Go as rows. The host call of `propose_session_plan` is not a row.
   - **The Editor tab** lists the changed files and shows a file as its changes against the base, or whole. It is read only, and says so.
   - **The service line** ("on filter-api") is on the ticket card when the session names a service.
   - **New words.** The catalogs gain `step_plan_gate`, without which a `plan_gate` step made the Checks card throw, and the tabs' words, in English and French.
10. **The fixtures.**
    - **The session fixture's story** gains the plan, proposed then given its Go before the first edit, and a `{ plan: 'waiting' }` story.
    - **The changed files' contents** are the base and the checkout, with the Changes card's counts (+24 -6, +41 -12, +38).
    - **The preview** has a key, and the example app's upcoming screen as its trial environment (`fixturePreview`).
    - **Both fixture sources** answer this wave's routes: the workspace, the files, Take over and Give back, and the Go and the Change. The tower's sessions have no waiting plan, so there a Go is a 409.
11. **Files outside the lane's list.**
    - `v2/app/test/main.test.ts` gives the preview listener a free port, so a test never binds 8794, and checks that it answers.
    - `v2/test/flow/api.test.ts` and `v2/test/flow/modules.test.ts` count the files route per depth as one, and drop lane 16's exclusion of this lane's routes, as section 4 asks.
    - `v2/app/test/session/model.test.ts` and `v2/app/web/test/session/render.test.tsx` follow the fixture's new rows and steps.
12. **Lane 16's open point** (whether the runtime also looks at `<workdirs>/<ticket>` for a one-service workspace whose service has a `run`) is left as it is: no runtime change. Neither proof meets it, and `flow/runtime.ts` is not this lane's file.

**Consequences.**
- **Tests first.** Commit 60a3c38 holds them alone, and each failed on `origin/v2` at 26fafbd, where `flow/takeover.ts`, `flow/files.ts`, `app/src/preview.ts` and the tabs did not exist. They are:
  - `test/flow/takeover.test.ts` (on the fake adapter);
  - `test/flow/files.test.ts` (a real temporary git checkout, with a link to a stand-in login file and a linked folder);
  - `app/test/preview.test.ts`, `app/test/session/tabs.test.ts` and `app/web/test/session/tabs.test.tsx`;
  - `app/test/session/tabs-browser.test.ts` (Chromium, skipped unless `CLEARED_V2_PLAYWRIGHT` is set, as the other browser tests).
- **Known limits, for later lanes:**
  - **Root-absolute addresses.** A page in the preview that uses them (the guestbook's form posts to `/entries` and redirects to `/`) leaves the session's preview address, and the listener answers 404.
  - **No writes.** The preview route is read only (lane 15), so a form's post is not relayed either.
  - **The base** is read in the project checkout. A base commit it no longer holds answers 404, and the diff shows the whole file as added.
  - **The rehearsal's app** (`v2/scripts/proof-rehearsal.ts`, lane 29's) starts `app/main.ts` without `CLEARED_V2_PREVIEW_PORT`. Beside a running app, whose listener holds 8794, it would now stop at once. Lane 29 sets that variable to a free port, as `app/test/main.test.ts` does.
- **The requirements matrix.** C1, C8, C9, M3, P8, B5.10f, O9 and O10 name this pull request (212). C9 and P8 are `done`; the rest stay `partial` for lanes 31 and 32 or for the proofs. The new line P25 records choices 1 to 4, and P26 records choice 6 (P23 and P24 are lanes 22's and 21's, merged first as pull requests 209 and 208).
- **Browser tests.** They need `CLEARED_V2_PLAYWRIGHT` and, where playwright-core's own build is not installed, `CLEARED_V2_CHROME`.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j2-session-tabs`.

## 2026-10-22: Owner decision: the Consumption screen is planned for milestone 3

**Decision.** On 2026-10-22 the owner added a Consumption screen (Consommation) at milestone 3. Its content:

- a projection per harness (Claude, Cursor, Codex): at the current pace, the harness reaches 100 % at time T, shown before and after the reset;
- a tokens-per-day curve per harness;
- clickable levers: change the model, limit the lanes run in parallel, pause new starts;
- cost in dollars only from a real source. Without one, nothing is shown, never an estimate.

A visual reference exists outside the repository. It is inspiration only; nothing is copied from it.

- Consequence: the screen is planned in [milestone-2-plan.md](milestone-2-plan.md), section 4.7, as a milestone 3 item with no lane yet. Matrix line O15 records it as `planned`, with no pull request or test yet.
- Author: the owner, relayed on 2026-10-22; written in this log by Haiku 5.5 (claude-haiku-5-5), lane `v2-j2-docs-consommation`.

## 2026-10-22: knowledge proposed, approved in the inbox, landed in the skill (the author's choices, lane v2-j2-knowledge-skills)

**Decision.** Lane 24 applies decision 27 of the [milestone 2 plan](milestone-2-plan.md). A handover's lessons and decisions become `knowledge` inbox items. Approve writes the entry into `lib/memory` at its level at once and queues it for the skill. Reject writes nothing. A Quick ticket per service asks for `.claude/skills/cleared-<service>/SKILL.md`, once a day or on "Update the skill now". The `knowledge` module is the ninth. Nothing under `lib/`, `flow/`, `inbox/store.ts` or `api/types.ts` changed. The lane's choices:

1. **How the module hears of a handover.** The handover is captured by the flow (`flow/effects.ts`, lane 23's in this wave), after `author_done` is emitted, and a module's `provide` has no registry. So `workspace/handover.ts` gains a sink, `setHandoverSink`, which the knowledge module sets when it starts. Once the handover is stored, the sink is given the entry `lib/memory` stored and the service and contract its lessons were filed for. A sink that fails is logged, and the capture still answers the handover's id. With no knowledge module (the flow's own tests), nothing changes.
2. **What a handover proposes.**
   - The lessons sections are lane 19's (`## Lessons for the workspace`, `... the service`, `... the contract`). The decisions sections are this lane's: `## Decisions for the workspace`, `... the service`, `... the contract`. The handover has no heading for a decision otherwise.
   - Each top-level list item of a section is one item, with its continuation lines. The text before a section's first item is one item too, and a section with no list is one item. The same text twice at one level is proposed once. An entry is cut at 4000 characters and says so.
   - Every text goes through the cleaner before it is added, so the inbox never shows a secret.
   - What a handover of the same ticket already proposed at the same level and service, waiting or answered, is not proposed again. An author reopened after a review writes its handover anew, and the owner would otherwise answer the same lesson twice.
   - The level follows lane 19's filing. The service is the session's (the store's `sessions.service`, else the one its lessons were filed for, else the first service). The contract is the service's own, else the first one it consumes. A contract entry of a service with neither is the workspace's. The kind (lesson or decision) is kept in `knowledge_proposals`, since `KnowledgeItem` has no field for it.
3. **Only the owner answers.** Approve, Reject and "Update the skill now" are answered for the signed-in user whose name is `[tracker] owner_id`. That is the one user `lib/memory` lets approve and the one the tickets' signatures name. Another user gets 403 with the owner's name. With no `owner_id`, the routes answer 503. The checks run in order: the app's proof (401), the knowledge set up (503), a known user (403), the owner (403), the item (404, or 409 once answered).
4. **What Approve writes, and where.**
   - The entry is written as a `decision`, proposed then approved, in a child process of its own (`knowledge/memory.ts`). `lib/memory` records the approval as its `memory_approved` event.
   - `lib/memory` approves only for the human its tracker names. The service has already verified that human (the app's proof, then the owner's name), so the child's tracker answers that owner and the settings it compares name the same one.
   - Why a decision: `lib/memory` briefs approved decisions that share words with the ticket (at most five) and never briefs a lesson row, only a committed lessons file. A lesson is therefore written as a decision whose text starts with `Lesson: `. So "the next briefing has it" holds for a ticket whose title or body shares a word with it, and no more.
   - The level: the workspace's memory; a service's level, unless the service's checkout is the workspace's (the first service), whose memory it then is; a contract's level, beside the contract in its provider's checkout. That is where lane 19's briefing reads each.
   - The entry is written first, then the item is handled. A memory that cannot be written leaves the item waiting, with nothing queued, for another try. A double click is answered once: the second gets 409 while the first writes.
   - The proposals lane 19 files from the same handover stay as they are: proposed lesson rows that nothing briefs. Reject does not touch them.
5. **The queue and the skill.**
   - An approved entry is queued for every service's skill when it is the workspace's, for its service's when it is a service's, and for the provider's and each consumer's when it is a contract's. A consumer's sessions read the contract they call.
   - The skill file is Cleared's. It is rendered whole from every approved entry of the service (`knowledge/skill.ts`): front matter `name: cleared-<service>` and `description` only, a line saying the file is rewritten, then `## The workspace`, `## The service <name>` and `## The contract of <provider>`, each with `### Decisions` before `### Lessons`, one list item per entry with its other lines indented, so an entry opens no section.
   - The ticket carries the whole file in a fence longer than any backtick run in it, its path, and the rule to change nothing else. Its author copies; it decides nothing. A ticket that never lands loses nothing: the next one carries every approved entry.
   - `checkSkill` validates the front matter: the two keys only, each once; the name is the service's skill name, in the standard format's characters; the description is not empty, at most 1024 characters, with no tag; the body is not empty.
6. **The skill ticket.**
   - It is labelled `Quick` (so its author is Haiku, unless the service is `full` or Haiku reviews it, lane 17's rule) and created in Todo by the flow's identity, on the workspace, naming its service when the workspace has several.
   - **Daily:** from 03:00 in the server's time zone, at the first tick (every 10 minutes, and once at start), for each service with something queued and no skill ticket made that day. It is created and not started: the flow starts a ticket for a person, or for the plan runner on an approved plan, and the service never starts one by itself. It waits in Todo for the owner.
   - **"Update the skill now"** (`POST /api/services/:name/skill`) makes the ticket at once, whatever the day, then starts it for the owner who asked. A start that fails leaves it in Todo. With nothing queued, it answers `ticket: null`.
   - The ticket takes the queued entries in `knowledge_skill` and is recorded in `knowledge_skill_tickets` (service and day).
7. **The registry.** `MODULE_NAMES` gains `knowledge` and `main.ts` imports it, the plan's one allowed edit of both. `assemble` still takes the whole record, so `main.ts` cannot leave a module out unnoticed.
8. **Issue 206, items 6 and 7** (`workspace/handover.ts` is this lane's in wave 9).
   - The sections are now read by `sectionsOf`: a fence of three or more backticks or tildes, indented by at most three spaces, is closed only by a line of the same character, at least as long, with nothing after it. `lessonsOf` reads the sections through it.
   - A lesson filed twice in one ledger by one handover is filed once.

**Consequences.**
- **Tests first** (commit `af52c47`), each failing on `origin/v2` at `9e7d68e`, where `src/knowledge/` did not exist:
  - `test/knowledge/proposals.test.ts`: two lessons and a decision give three items at their levels; list items, continuation lines and the paragraph before them; the fences of issue 206 for both `proposalsOf` and `lessonsOf`; the duplicate; the cut; the line endings.
  - `test/knowledge/knowledge.test.ts`, on real `lib/memory` and two temporary repositories:
    - a captured handover with two lessons and one decision gives three items;
    - a planted key is masked;
    - Approve writes the approved decision in the right ledger, and a real briefing of a ticket sharing its words has it;
    - the queue per service;
    - Reject leaves every ledger as it was;
    - the owner only, once, a double click writing once;
    - a failing memory leaving the item waiting;
    - the daily ticket from 03:00, once per service per day, not with an empty queue, with the whole file in its body;
    - a workspace entry making a ticket per service;
    - "Update the skill now".
    - After the advisor's review of the first version, two more: a ticket's later handover proposes only what is new (it proposed every entry again on commit `7a46c54`), and the module as `main.ts` starts it, with a project and a settings file, proposes a captured handover's lesson and lets the settings' owner approve it.
  - `test/knowledge/skill.test.ts`: the front matter and its check, the sections, an entry of several lines, the ticket's fence.
  - `test/knowledge/routes.test.ts`: 401, 403, 404, 409, 503, the answers, and the started ticket.
  - `test/modules/registry.test.ts`: nine modules.
- **Two lines outside the lane's files.** `test/flow/modules.test.ts` pins `MODULE_NAMES` and assembles the whole record of modules. Its two lines gain `knowledge`, since the ninth module is this lane's by the plan. The file is lane 23's in this wave, so a merge of the two takes both changes.
- **Not closed by this lane, for the orchestrator:**
  - **No author is told the decisions headings, and on a one-service workspace none is told the lessons headings either.** `renderBriefing` names the lessons headings only on a workspace of several services, and `workspace/briefing.ts` and `flow/prompts.ts` are not this lane's. So the 48-hour guestbook proof will likely see no knowledge item unless an author writes one of the six headings by itself. A small lane on the briefing's text, after wave 9, closes it. Section 8's unknown ("how many knowledge items a night produces") is measured by the proof all the same.
  - **The skill ticket's write asks the owner.** `session/policy.ts` allows no edit under `.claude/`, so the author's write of the skill file becomes a permission request in the inbox, which the owner answers once (or "always in this project"). A row for that one path belongs to the policy's lane (lane 25 in this wave).
  - **The skill is read by sessions** once lane 15's mount reaches Claude Code's skills, which needs the runner's `settingSources` to include `'user'` (issue 140, matrix line B5.5b).
  - **The knowledge item raises no notification** (the notify sources skip a kind they do not know), and the inbox screen renders it from lane 27.
- **The requirements matrix.** C2, O12 and M7 name this pull request (216). P27 records choices 1, 4 and 6.
- **Checks.** `npm test`: 980 node tests, 974 pass and 6 skipped; 154 Vitest tests pass. `npm run typecheck` and `npm run guard -- --base origin/v2` are green. This is not an interface lane, so there are no captures.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j2-knowledge-skills`, at the orchestrator's request.

## 2026-10-22: a read-only question to the code or to the platform, the reader's policy and its read-only workdir (the author's choices, lane v2-j2-ask-code)

**Decision.** Lane 25 applies decision 28 of the [milestone 2 plan](milestone-2-plan.md). `v2/src/reader/` answers a question to the code with a `reader` session. The question is about one service (named, or named by a `service:path:line` target) or about the whole platform. The three routes lane 17 wrote ahead are served: `POST /api/asks`, `GET /api/asks/:id` and `POST /api/asks/:id/follow`. Each turn carries its answer, its cost and its tokens; the ask carries their sums and the week share. The lane's choices:

1. **The reader's policy** (`session/policy.ts`, role `reader`):
   - The reviewer's rows, under the rule `reader.edit`: no edit tool, no `git commit`, no `git push`. A redirection that writes a file is refused the same way.
   - The lead's cap on a Read (`reader.read_cap`, at most 400 lines through `limit`). The reader's first turn says so, since the real run's first Read had no limit and was refused.
   - `AskUserQuestion` is refused (`reader.question`): nobody answers a reader.
   - Whatever the other rows would `ask` is refused as `reader.ask`, keeping the reason. A reader never waits for the inbox.
   - The learned "Always in this project" answers are ignored for a reader. The flow's `policyFor` merges them into every policy of the project, and a learned allow would otherwise widen a reader.
   - The reader also refuses at once any question or permission request that still reaches it, so a turn never hangs until the idle stop.
2. **The workdir is read only, said by a file in it.** The ask's folder is `<CLEARED_V2_WORKDIRS>/asks/<ask id>`. It holds:
   - one folder per named service, exported from its base branch (`exportBase`: landed code only, without `.git`; a monorepo folder service is its folder alone);
   - the reader's `CLAUDE.md`;
   - a `HANDOVER.md` placeholder;
   - the mark `READ_ONLY_MARK` (`.cleared-read-only`).

   `container/session-runtime.ts` mounts a workdir that holds the mark (a plain file, not a link or a folder) read only. Reason: the Claude Code adapter gives the runtime the workdir, the siblings and the skills only, and `session/adapters/claude-code.ts` is not this lane's file. A session that writes the mark in its own checkout only makes its next start read only. Every service of a platform question sits inside that one read-only mount. There are no per-service bind mounts, since a bind's source is resolved on the host and a folder swapped for a link would reach outside. The command line without the mark is unchanged (a test).
3. **The `HANDOVER.md` placeholder.** The runner's Stop hook (`images/session/runner/hooks.ts`, `hooksFor`) asks every role but the lead and the reviewer for a `HANDOVER.md`, and a reader cannot write one. The hook passes when the file exists, so the folder holds one. The runner is not this lane's file, and changing it means rebuilding the shared session image (followup).
4. **The excerpt of a target** is read from git's objects in the service's own checkout, never from a folder a session writes (`ls-tree` then `cat-file blob` at `refs/remotes/origin/<base>`).
   - A link, a folder, a binary, a file over 1 MB, a path outside the service, and a name the policy calls a secret (`secret.read`) are refused with 400.
   - The named line and ten lines on each side are numbered, the named one marked, cleaned, and put in the first turn: a question on `guestbook:src/page.ts:12` holds lines 2 to 22.
   - A line past the end is refused before anything starts.
5. **Starting and stopping.** `POST /api/asks` answers at once with the ask `starting`, and the session starts in the background.
   - It starts through the registry's adapter, the flow runtime's wrapper, with `siblings: []` and no test service, so the wrapper starts none.
   - Its session row has the role `reader` and the ask's id as its ticket (`ask-<uuid>`, a form no tracker gives). Its status is `working` while a turn runs, `done` between turns, then `stopped` or `failed`.
   - The flow's tick, idle rule and restart recovery handle authors and reviewers only. The reader has its own idle rule: the flow's `idleMs`, checked every 30 seconds. An idle stop removes the session's containers, its config volume and the ask's folder.
   - A follow-up goes to the live session, or, after a stop or a failure, to a new session whose first turn holds the earlier questions and answers. A restart stops what the last process left live and cleans it up, at the service's start (`recoverAsks`).
   - At most three asks run at once (409 beyond).
6. **The cost.**
   - **A turn's cost** is the session's `total_cost_usd` at the end of the turn minus its total at the end of the turn before. Claude Code's result carries the session's running total: the real run read 0.00233103, then 0.00269304.
   - **Tokens.** A turn's input tokens are its new, cached and cache-written input tokens; its output tokens are the turn's.
   - **The week share** is the seven-day window as the reader's session last reported it (`cleared.rate_limit`), null until reported.
   - **Storage.** The sums are read from the turns, which the `asks` table (a table of the sessions module) keeps as JSON.
7. **The model** is `CLEARED_V2_READER_MODEL`, `claude-sonnet-5-5` by default: a reader reads as a reviewer does. The real run set Haiku.
8. **Issue 207, item 4: an author before its Go changes nothing.** `Policy.planning`, when true for an author, refuses the edit tools (`plan.before_go`), except `HANDOVER.md` at the root, which the Stop hook asks for at the end of every turn. It also refuses `git commit`, `git push`, `git add`, `git checkout` and `rm`. Reads and safe commands stay allowed. Nothing sets the field yet: `flow/engine.ts` is lane 23's in this wave (followup).
9. **Outside the lane's files**: two lines of `v2/test/flow/modules.test.ts`, lane 23's folder in this wave. Its route list of the sessions module now leaves out `/api/asks` as it leaves out the preview, and `test/reader/routes.test.ts` proves the registration. The route lists and the count, which lane 23 changes, are untouched.

**The real run**, on this server, 2026-10-22 14:23 (Europe/Paris), driven in-process from a script outside the repository: no listener, `ss -ltn` the same 34 lines before and after. One ask on the guestbook (a copy of `examples/guestbook` in a temporary repository) with `claude-haiku-5-5`, on the login named by `CLEARED_CLAUDE_CREDENTIALS`, whose content was never read:

- turn 1, "What does line 12 of the page do, and which function calls it?" on `guestbook:src/page.ts:12`: answered in 12 s, `costUsd=0.002331 inputTokens=38064 outputTokens=1017 weekPercent=29`, naming `ESCAPES` and `escapeHtml`;
- the session container's mounts: `/workspace rw=false`, the login `rw=false`, the config volume `rw=true`; `touch /workspace/guestbook/x` inside it: `Read-only file system`;
- the policy's answers in the session: one `reject_once:reader.read_cap`;
- the follow-up, "Which test file covers that function?": answered in 2 s, `costUsd=0.000362 inputTokens=20350 outputTokens=48`; the ask's total `costUsd=0.002693 inputTokens=58414 outputTokens=1065`;
- after the idle rule: the ask and its row `stopped`; nothing left with the session's label (containers, volumes, networks).

**Followups.**

- `session/adapters/claude-code.ts`: forward a read-only flag of `StartInput` to the runtime, in place of the mark.
- `images/session/runner/hooks.ts`: no Stop hook for a reader, then drop the placeholder.
- `flow/engine.ts`, `policyFor`: set `planning: true` while the author's gate is `planning` (lane 23 or a small fix lane).
- The tower and `GET /api/sessions` list a reader's session like any other (`role: 'reader'`, its ask's id as the ticket), and a platform ask's row names the workspace's first service, which the wrapper sets. Lane 27 shows the ask screen, and may leave the reader out of the live sessions or link it to `/ask/:id`.
- **The cost of a session of several turns is over-counted in three places.** Each adds up `total_cost_usd` over every `RUN_FINISHED` event, and the real run shows that value is the session's running total:
  - `flow/engine.ts` (about line 1075): the ticket's budget stop. A reopened author is the same session, so a ticket can be put back before its budget is spent.
  - `lead/plans/runner.ts` (about line 531): the plans' day budget. The lead is one long session per generation, so the day stop can trip early, during the 48-hour proof too.
  - `lead/plans/estimates.ts` (about line 65): the estimates' median cost.

  A small fix lane before wave 12 would count the last total of each session instead.
- A reader sees no git history: the export carries none.
- A reader has no cost ceiling of its own. The registry's adapter sets no `maxBudgetUsd`, and the flow's ticket budget never sees a reader. Its bounds are the idle rule and three asks at once.
- `test/reader/runtime.test.ts` covers the production path: the model setting, the recovery at start, the reader built once from the flow's configuration, and a reader's start through the flow runtime's wrapper (no sibling planned, a reader's row).

- Pull request: 218, against `v2`.
- The requirements matrix: C11 and M9, and this lane's own lines P28 (the reader's policy and read-only workdir) and P29 (an author before its Go). They were P27 and P28 in the pull request and were renumbered at the merge of `origin/v2`, since lane 24 (pull request 216) took P27 first.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j2-ask-code`.

## 2026-10-22: a ticket runs in steps, the contract validated in the inbox, and the reviewer told of a human's edits (the author's choices, lane v2-j2-ticket-steps)

**Decision.** Lane 23 applies decision 26 of the [milestone 2 plan](milestone-2-plan.md), and places decision 33's call in the reviewer's prompt. A ticket of several services runs in steps, kept in `ticket_steps` (`flow/steps.ts`, a table of the flow module): a contract step on the providing service, a service step per service, then an integration step on the consumer. Each step is an author session in its own service's checkout. Once every step is done, the review, the publish and the train follow as before. A one-service ticket has one `service` step, and its events, inbox items and calls are the same as before (`test/flow/one-service.test.ts`). The steps are on in every configuration the service reads (`FlowConfig.steps`, set by `loadFlowConfig`).

1. **Where the steps come from.** A plan item's `steps`, carried by the plan runner's start as `Origin.steps`, with the plan's `maxParallel`. Without them, `deriveSteps` answers from the workspace: a contract step for each named service that has a contract and is consumed by another named service; a service step per named service in landing order, after the contract steps; an integration step on each named consumer, after every service step. A ticket started again keeps the steps it has.
2. **How they run.** The flow starts each waiting step whose steps before it are done, in position order, at most the plan's `maxParallel` sessions at once (two without a plan), and never two steps of one service at once, since they share its checkout. A step is marked running before the first wait, so two ticks never start it twice. The sessions are watched once the whole batch has started, so a step that ends at once never races the start of the next one.
3. **The contract step is held to its contract file by a read of its branch, not by a policy rule** (`session/policy.ts` is lane 25's in this wave). At the step's end, `stepChanges` (`flow/effects.ts`) fetches the step's branch out of its checkout into a private ref of the service's own checkout, as publish fetches a branch: every object checked, no git of the session's run, and a checkout with a linked `.git`, a `commondir` or alternates refused.
   - A branch that changed another file than the contract fails the step, with a note naming the files. Those commits stay on the ticket branch, and the note says to take them off before the ticket starts again.
   - No change to the contract: the step is done, and nothing is proposed.
   - Otherwise the contract's diff becomes a `contract` inbox item, and the contract as committed is copied to `<workdirs>/<ticket>/.validated/step-<n>-<round>/`, outside every session's mount, so the fakes of the later steps read the validated version whatever the branch does next.
   - Only what is committed counts: a change left uncommitted in the checkout is not seen. The provider's service step works in the same checkout, and whatever it commits is reviewed as part of the ticket.
   - The ref is per service (`refs/cleared/step/<service>/<branch>`), since two folder services of one repository share its checkout. A folder service's contract is compared as a path of the repository, inside its folder, as `release/order.ts` reads it; the card's `contract` chip reads it the same way.
   - The notes a step fails with are cleaned before they are kept, since the failed step's next first turn reads them.
4. **Approve and Send back** (`POST /api/contracts/:id/approve`, `/sendback`, in `flow/steps.ts`, with the checks of every route of the service's API): the item is answered at once, and what follows runs in the background, since a click does not wait for clones and containers. Approve validates the contract and starts the next steps if the ticket runs. Send back resumes the step's session, in the same container, with the owner's message. When the resume fails, a new session runs the step, with the message in its first turn. An item is answered once. A ticket put back meanwhile goes on from there when it starts again. A contract item survives a restart (it is not a session's request).
   - **Correction to the inbox store** (`inbox/store.ts`, this lane's for corrections): a contract item's id was per session, so a resumed session's second proposal was silently dropped. It is now numbered per step: the diff proposed again while the item waits is that item, and after an answer it is a new one.
5. **The siblings of each kind of step** (`stepSiblings`), from what the runtime plans for a session on that service (`container/services.ts`, now called by `flow/runtime.ts` for the engine too). The contract step keeps them as planned. A service step keeps its own service, runs every other service with a contract as its fake from the validated contract, and leaves the others out, since their own steps change their checkouts meanwhile. The integration step keeps every sibling real from the ticket branch, a fake reading the validated contract. A consumer's own sibling gets the address of each service it names in `[session] service_urls` (`filter-api:FILTER_URL`): a variable must be upper case and end in `_URL`, so no setting names `PATH` or `NODE_OPTIONS`.
6. **A provider's service step that changes the validated contract fails**: its branch's contract blob is compared with the validated one. A change to the contract goes through the contract step.
7. **A step that fails** (its session's error, its idle or budget stop, a refused read) fails with its note: "Step 2 of 4 (the service step of filter-api) failed: ...". The ticket's other sessions stop, and the ticket goes back to Todo with the reason `step_failed`, which the lead reads in its events. Done steps stay done. Started again, the ticket goes on from the first step not done, and the failed step's first turn holds its note. A ticket whose steps were all done (its review, its release or the owner sent it back) does its service and integration steps again, on the contract as validated.
8. **After the steps.** The review reads the ticket branch in the first service's checkout, as before. A review that asks for changes resumes the last author, which is the integration step's session: it works on the consumer's checkout only, so it cannot make a fix the review asks on another service. Such a ticket ends its rounds and goes back to Todo, and the put back's note reaches the plan item's next start (followup).
9. **The session plan's gate applies to each step** (with the author's tools on in production): each step's author proposes its plan, and the inbox item names the step's own service (it named the ticket's first). A high-confidence plan of a plan's ticket gets the lead's Go at once, as before.
10. **The plan's steps** (`lead/plans/`): `propose_plan` takes `steps` per item. The checks: a known kind, a service of the workspace, a contract step only on a service with a contract, positions among the item's steps, no cycle, and no two steps of one service that could run at once. Each step has its estimate by kind (`stepEstimate`): the medians of done steps of the same kind, item size and lane with three samples or more, read from `ticket_steps`; else the default of the step's size (a contract step `xs`, an integration step `s` at most, a service step the item's size). The item's cost adds its steps', its time is their critical path at the plan's `maxParallel` (two when the plan runs none), and the plan's totals add the items. The steps are kept in `plan_steps`, a table of their own, so a ledger written before them gains it without a migration (`store/migrations.ts` is not this lane's). The ticket of an item with steps names their services. In a workspace of several services, an item without steps names the services its body names.
11. **The lead's rules** gain a `## Steps` paragraph. The rules must stay under 5 KB (lane 7's test), and they were 5059 bytes, so room was made by cutting two sentences that repeated another rule ("you start no work outside an approved plan", "Put the independent work first") and by shortening three others. They are 5112 bytes. The details of each kind are in `propose_plan`'s schema.
12. **Issue 205, item 1, taken.** The release card's flags now get the contract files of the ticket's services (the `contract` chip) and their `[merge] guarded_paths` (the `config` chip), on the one-service card and on the train. `test/flow/steps.test.ts` proves both end to end.
13. **Decision 33's call.** `flow/human-edits.ts` holds `humanEdits({ events })`, returning no edit until lane 31 fills it. The review's start passes it the events of every author session of the flow (a ticket in steps has several). `reviewPrompt` gains an optional `humanEdits`, which adds a paragraph naming each file, who changed it, where and the line counts. With none, the prompt is the one before.
14. **The cost and time of a step** are the sums of its sessions' `total_cost_usd` and running time, as the ticket's budget counts them. Lane 25's log found that value to be a session's running total; the step cost is the fourth place its followup names.
15. **Outside the lane's files**:
    - `v2/src/lead/contract.ts`, for `propose_plan`'s schema and `PlanItemInput.steps`, which the lane's goal needs and no lane of wave 9 owns;
    - `v2/test/lead/contract.test.ts`, for its schema;
    - `v2/src/api/types.ts` (a correction lane 17 left out): `PlanItem.steps` and `PlanStep`.

**Followups.**

- No `FlowEvent` says a contract waits for the owner, so no notification is raised for it. `flow/events.ts` and `notify/sources.ts` are lane 26's in wave 10.
- Lane 27 shows the steps (`GET /api/tickets/:id/steps`, with the cost of each) and the contract item's Approve and Send back.
- A review's fix on a service other than the consumer (choice 8): reopen the step of the service the report names, or a new session on it.
- `policyFor` setting `Policy.planning` while an author's gate is `planning` (lane 25's followup 3) is not taken: the policy is evaluated from the session's `StartInput`, which does not name the session. A small fix lane can key it.
- The cost over-count of a session of several turns (lane 25's followup), now also in the step's cost.
- The card's groups read the last author's report only (`#report`), which is the integration step's: what the contract and service steps committed falls under "Other changes". Merge each author session's last `cleared.changes`.

- Pull request: 220, against `v2`.
- The requirements matrix: M2, C10, O10 and this lane's own lines P30 and P31.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j2-ticket-steps`.

## 2026-10-22: recipes in the repository, schedules in the store, a schedule's budget on its tickets (the author's choices, lane v2-j2-recipes-schedules)

**Decision.** Lane 26 applies decision 29 of the [milestone 2 plan](milestone-2-plan.md). A recipe is `.cleared/recipes/<name>.md` in a service's repository, read at its base branch (`v2/src/recipes/`). A ticket recipe runs as a one-item plan of the plan runner, approved by whoever runs it. A goal recipe is an owner turn to the lead. A schedule is a row of `schedules` (`v2/src/schedules/`). The scheduler runs each due schedule through the plan runner, with the creator's approval, given when the schedule was made, as the plan's approval. Each ticket's budget is the schedule's, carried on the flow's `Origin`. A release still waits for the owner, and the week stop still wins. The lane's choices:

1. **The recipe file** (`recipes/recipe.ts`).
   - **The front matter** is a strict subset of YAML, read with no dependency. It takes `name`, `kind`, `title`, `lane`, `size`, `services` and `parameters`, and refuses any other key, so a typo never passes for a default.
   - **`title` is the lane's addition** to the plan's list, since a plan item needs a title. When it is absent, the title is the recipe's name.
   - **Defaults.** A ticket recipe runs in the `full` lane, at size `s`, on its own service.
   - **A goal recipe** takes no lane or size: the lead chooses them in its plan.
   - **A ticket recipe's body** needs a `- [ ]` criterion, as a plan item's does, and is refused when its file is read rather than when it runs.
   - **The name** is the file's name, in lower-case letters, digits and dashes. A name holding `{{` is refused.
   - **Marks.** Every `{{mark}}` in the body or the title must name a declared parameter.
2. **Reading** (`recipes/source.ts`).
   - **Where.** The files are read from git's objects at `refs/remotes/origin/<base>` of the service's own checkout, as the reader reads a file. The working tree and an unpushed commit are not seen. A committed link is refused, never followed. A file is at most 64 KiB.
   - **A folder service** reads the `.cleared/recipes/` of its own folder.
   - **Problems.** What cannot be read is a problem of its file, logged once, never a failure of the list.
   - **A name used twice.** The run route names a recipe by its name alone, so the first service in the workspace's order keeps the name, and a later service's recipe of that name is such a problem.
   - **A run fetches first.** Before a run, the recipe's service is fetched, as the flow's effects fetch it before an author's first turn. A fetch that fails is logged, and the run goes on with the base as last fetched.
3. **The values** are substituted in one pass, so a value is never read for marks.
   - Each value is one line of at most 500 characters, with no `{{` or `}}`.
   - A missing required parameter is refused, and so is an unknown one. An optional parameter left out is empty.
   - The title, the body and the goal go through the service's cleaner.
4. **A ticket recipe runs** through the runner's own `propose` (`recipes/service.ts`).
   - **Sensitivity.** `applySensitivity` is applied first, as the lead's `propose_plan` does, so a fast recipe on a `full` service runs in the full lane (decision 24).
   - **Steps.** A recipe naming several services gets the steps `deriveSteps` gives (decision 26). One naming a single service, in a workspace of several, gets that service's one step, so its ticket names that service.
   - **Approval.** The plan is then approved by `Recipes.approve`, which does what the runner's `approve` does: the plan's inbox item handled, the tick that creates and starts the ticket, the plan's frame. The service line is its own, so the lead is told once and truly ("Schedule sch-1 ran the recipe ...", or "The owner (u1) ran the recipe ..."). The runner's line, "The owner approved plan ...", would be false for a run at 03:00.
   - **The goal id** is unique per run (`recipe-<name>-<time>-<n>`), so one run never supersedes another's proposal.
5. **A goal recipe** is `post(text, user, true)` on the lead: an owner turn as a goal, by the person who runs it. The route answers the message's sequence number.
6. **A schedule.**
   - **`every`** is `day HH:MM`, `weekdays HH:MM`, a day of the week with `HH:MM`, or `hour :MM`, in the server's time zone. At the end of summer time, a daily run comes 25 hours after the one before.
   - **`at`** is an ISO time in the server's zone, or one with its offset, and must be to come. A schedule `at` a time is disabled once it has run.
   - **Creation checks** the recipe and its parameters, so a schedule is refused when it is made, not at 03:00. The budget is above 0 and at most $1000. The cap is 1 to 100 % of the seven-day window. The creator is the signed-in user.
   - **Deleting** a schedule marks its row removed (`removed_at`), so its id is never given again, and its runs in `schedule_runs` stay its own: a plan it started keeps its budget.
7. **The scheduler** (`schedules/scheduler.ts`) ticks each minute.
   - **A run starts once.** It is taken in one `UPDATE` that moves the schedule to its next run, so overlapping ticks never start it twice. After a stop of the service, a schedule catches up once, not once per missed period.
   - **The week check.** A run is skipped when the seven-day window is at or above the smaller of the schedule's cap and the runner's week stop. The window is read as the runner reads it: the query is copied, since the runner's `#stop` is private. A skip still moves the schedule to its next run.
   - **A failed run** (skipped, a recipe gone or refused, a start that failed) is kept in `schedule_runs` and said once as a `schedule_failed` event (`Scheduler.subscribe`). The lead gets a non-urgent event, which it tells the owner in the morning, and a notification is sent.
   - **A failure that repeats is told once.** When the schedule's last run failed for the same reason, the lead and the owner are not told again until a run goes well, so an hourly schedule whose recipe is gone does not wake the owner every hour.
8. **A goal schedule.**
   - Its text tells the lead that the plan it proposes is approved for the creator, with the schedule's budget per ticket, and that the owner is away: it asks nothing, and writes its assumptions in the plan's summary. In goal mode the lead would otherwise ask its questions first, and the plan would miss the night.
   - The plan the lead proposes for that goal (`goal-<seq>`) within six hours is approved for the creator at the next tick. A plan of another goal is left to the owner.
   - The plan says the creator's approval is the plan's; this applies it to goals too, so a goal schedule runs at night as a recipe does.
9. **The budget on `Origin`** (`flow/events.ts`, `flow/engine.ts`).
   - `Origin.budgetUsd` is the schedule's budget, and the engine's budget check reads it before `CLEARED_V2_BUDGET_USD`.
   - **How it gets there.** The lead module gives the runner a flow (`schedules/budget.ts`) that adds the budget of the origin's plan, read from `schedule_runs`. So a start again after a put back, and the lead's `start_ticket`, keep it too, although the engine forgets an origin at a put back.
   - **Timing.** The approval's tick starts the ticket, so the scheduler learns of the plan from the run (`planned`) before the approval, and the budget is known at that first start.
   - **The scheduler's place.** The recipes and the scheduler are built with the plans, in `plansOf` of `modules/lead.ts`, which registers their tables and routes.
10. **The notifications** (`notify/sources.ts`).
    - **A failed run** is a `health` notification: `week_stop` when the week skipped it (lib's catalog words that one), else `schedule_failed`.
    - **A run that went well notifies nothing.** This departs from the plan's "the `schedule_ran` and `schedule_failed` events for the notifications (`health` kind)". A health notification is urgent and passes the quiet hours, and lib's catalog says "a health problem was detected" for a code it does not know, so a nightly `schedule_ran` would be a false alarm at 03:00. A run that went well tells the lead by its line, and its release waits in the inbox as any other.
    - **Not a `FlowEvent`.** The two events are not on the flow's bus: its `Base` needs a ticket, and the dispatcher reads no `FlowEvent`. The scheduler adds the occurrence to the queue itself.
11. **Issue 207, item 7, and lane 23's followup, taken.**
    - A session plan waiting for its Go, and a contract waiting for its validation, are notified as a team's permission is, with their inbox link: lib's catalog has no kind of their own, and "open it to allow or deny" is what each asks.
    - A knowledge item waits for the owner's morning, untold.
12. **Files outside the lane's list.**
    - `v2/test/lead/module.test.ts` and `v2/test/lead/plans/module.test.ts` pinned the lead module's exact tables and routes, as lane 7 recorded for the first.
    - `v2/test/flow/api.test.ts`: its comment now names the lead module for the recipes and the schedules, as the plan asks. `RECIPE_ROUTES` stays excluded there, since the flow's API does not serve them.

**Consequences.**
- **Tests first.** Commit c7ae472 holds them alone. Each failed on `origin/v2` at 5d68c50, where `recipes/` and `schedules/` did not exist and `notify/sources.ts` had no `scheduleOccurrence`. The new files are:
  - `test/recipes/{recipe,source,run}.test.ts`;
  - `test/schedules/{when,scheduler,budget,routes}.test.ts`;
  - `test/notify/sources.test.ts`.
- **What the tests prove**, the plan's acceptance first:
  - a recipe with two parameters runs as a one-item plan with the substituted body and the labels, approved by who ran it, and the lead is told once;
  - a missing parameter is refused, and so is a name with `{{`;
  - a goal recipe sends an owner turn;
  - `every: day 03:00` runs at the first tick past 03:00 and not twice, with the budget on the ticket's origin; a ticket past that budget is put back, though the service sets none;
  - a run at the week stop is skipped with a `schedule_failed` and a `week_stop` notification;
  - a disabled schedule never runs;
  - the creator is the plan's approver;
  - and beyond it: the summer time's end, a catch up once after a stop, a repeated failure told once, a removed schedule's id never given again, a schedule `at` a time disabled once run, a goal schedule's plan approved for its creator, a recipe gone, the creation's refusals, the routes' guards, a recipe naming two services run in steps, a fast recipe on a `full` service run in the full lane, and the base read from git's objects, never the working tree.
- **Checks.** `npm test`: 1083 node tests, 1077 pass and 6 skipped; 154 Vitest tests pass. `npm run typecheck` and `npm run guard -- --base origin/v2` are green.
- **No real run.** Nothing here calls a model or Docker. A schedule's real run belongs to the proof (lane 29).
- **No screen changed.** The lane touches no file of the app, so it ran no visual loop and made no capture. Lane 27 draws "Run a recipe" and the schedules in the tower's plans card.
- **Followups.**
  - **A schedule needs the plans to be built.** The scheduler, like the plans, is built on the first request to a lead, plan, recipe or schedule route, since a module's `provide` has no registry. A service restarted at night with no browser open runs no schedule until the app is opened, and a schedule then catches up once. Building the plans at start needs the registry in `provide` (`modules/registry.ts`, `main.ts`).
  - **lib's catalog** (`lib/notify/contract.mjs` `HEALTH_CODES`, `lib/i18n/{en,fr}.json`) has no `schedule_failed` line, so that notification says "a health problem was detected" until a small lane adds one.
  - **No route enables, disables or edits a schedule** (the API lane 17 fixed has none): delete it and create it again.
  - **The schedule's week cap** is read when a run starts. Its tickets then keep to the runner's own week stop.
  - **A goal schedule's plan** is approved only when the lead proposes it under the goal's id. Otherwise it waits for the owner.
- Pull request: 222, against `v2`.
- **The requirements matrix.** C7 and C12 (partial: the screens are lane 27's), C8 and M2 (the notifications), and this lane's own lines P32, P33 and P34.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j2-recipes-schedules`.

## 2026-10-22: the web terminal in the session's container, the editor's save through the policy and the container, and the human's edits told to the session (the author's choices, lane v2-j2-terminal-editor-service)

**Decision.** Lane 31 applies the service's part of decisions 32 and 33 of the [milestone 2 plan](milestone-2-plan.md). A session taken over gets a web terminal: a shell in its own container, opened by the user who took it over, journaled line by line, closed at Give back. The Editor tab's files route gains its save, judged as the session's own `Write` and written inside the container. At Give back the session is told every file the human changed, and the reviewer's prompt names them through lane 23's call, which `flow/human-edits.ts` now fills. No screen changes in this lane: lane 32 mounts the terminal and the editable editor, so there are no captures. The lane's choices:

1. **The terminal's process** (`container/docker.ts` `terminal`, `terminal/container.ts`).
   - **The command.** `docker exec --interactive --tty --env TERM=xterm-256color --user <the container's user> --workdir /workspace -- <id> sh -c '<shell>'`, run under util-linux's `script --quiet --return --flush --command '<that line>' /dev/null`, which gives the client the terminal `--tty` needs.
     - The id comes from a labelled list and the label rule is asserted. The user is read from `docker inspect` and checked. The command line is built from fixed words, the owned id, the user and the folder, each quoted for `sh`.
     - What is typed goes to the process's input only. The wrapper's test writes a line full of shell syntax and finds no new command line.
   - **The shell** is `echo $$ > /tmp/.cleared-terminal.pid; exec bash -l`, so the close can find it. Ending the docker client does not end a process of `docker exec`: on this server, `bash -l` and a `sleep 600 &` were still in `docker top` after the client was killed.
   - **The close** runs a fixed program in the container through the existing `exec`: `pkill -HUP -s <pid>`, then `pkill -KILL -s <pid>` a second later. A pid file that is not a number ends nothing. Then the client is killed.
   - **The size.** The client's terminal starts at 0 by 0. The host sets it with `stty -F <the client's pts>` (found under `/proc` from the `script` process), and the kernel signals the client, which resizes the shell's terminal. **Section 8's unknown is closed:** a resize passes (`stty size` answered 30 100, then 40 132, in the real run), so no fixed 120 by 32 is needed.
   - **The first line** of the stream is the service's own: "The session is paused. To run its harness here: claude --resume <id>". `TerminalOpened.resume` carries the same command.
2. **The terminal's manager** (`terminal/terminals.ts`, `terminal/lines.ts`).
   - One terminal per session; a second open answers 409.
   - **The journal.** Each typed line is journaled at its Enter, carriage return or line feed, and the rest at the close, as `cleared.terminal_input` with the user. The line goes through the events' cleaner as a whole, so a key typed in three posts is masked once.
   - **What the line is.** It is the keys, not what the shell made of them: Backspace and Ctrl-U are applied, escape sequences (arrows, function keys) are left out, Ctrl-C ends the line as `^C`, and empty lines are not journaled.
   - **The output** is decoded as a stream of UTF-8, so a character split across two chunks is whole, and is never journaled. It is kept in memory only, its last 1 MiB of text, so that a stream that reconnects (`Last-Event-ID` or `?after=`) gets what it missed. `cleared.terminal_closed` carries the output's byte count.
   - **When it closes:**
     - after 15 minutes without input, by a sweep every 30 seconds; the session stays paused;
     - at the shell's exit (`exit`);
     - at the user's close (`closed`);
     - at Give back (`give_back`);
     - when its session is no longer taken over, for example after a restart (`closed`).
3. **The terminal's routes** (`terminal/routes.ts`, registered by `modules/flow.ts`). The checks run in this order:
   - the app's proof (401);
   - the flow (503);
   - a known user who is not `cleared` nor `lead` (403);
   - the session (404);
   - taken over (409);
   - by this user (403);
   - then one terminal at a time (409).
   An input post is at most 4096 bytes (413). The stream is `data` frames (a `TerminalChunk`, its seq as the id), then one `closed` frame. The app's proxy (`app/src/proxy.ts`, unchanged) sends the user and the proof on every method, and passes `Last-Event-ID` on, so the stream reaches these checks as the posts do.
4. **The app's gate** (`app/src/server.ts`).
   - `/api/service/sessions/:id/terminal/*` is forwarded only when the request reached the app on a loopback socket, with a `Host` of `127.0.0.1`, `localhost` or `[::1]` at its port, and not the public origin's host.
   - Every post needs the anti-forgery token, `Sec-Fetch-Site: same-origin` when sent, and an `Origin` equal to that loopback address; the public origin's `Origin` is refused even on the loopback `Host`.
   - The stream needs the cookie, and refuses another `Sec-Fetch-Site` or `Origin`.
   - `/api/me` gains `terminal: true | false`, true on the loopback address only.
   - The editor's `PUT` is not a terminal route: it is a write like the others, allowed on the public origin.
5. **The save** (`PUT /api/sessions/:id/files/<path>`, one route per depth, in `flow/files.ts`).
   - **Who.** The owner account only (the first account, as Take over), never `cleared` nor `lead`, and never another account than the one that took the session over.
   - **When.** On an author's session that this process started, live (`starting`, `working`, `waiting_human`), of a ticket in progress, with no review running. A reviewer's checkout answers 409.
   - **The checks, in order:**
     1. the files route's own refusals (`.git`, what the session's `Read` is refused);
     2. the body: the text with no NUL and at most 2 MiB, the loaded hash, a `confirm` that is only `install.package` or `scripts.change`;
     3. the current file, read in the container: a link is refused, a missing file answers 404, a file that is not UTF-8 or holds a NUL answers 415, and a file over 400 lines is read only (`editor.cut`);
     4. the hash, where a stale one answers 409 with the current hash;
     5. `evaluate()` with a `Write` of `/workspace/<path>` and the file's current text as `readFile`.
   - **The verdicts.** A `deny` refuses with its rule and its message. An `ask` for `install.package` or `scripts.change` answers 403 with `confirmable: true`, and a second save carrying that rule writes. Any other `ask` is refused with `confirmable: false`; `.claude/**` and `CLAUDE.md` answer `default`, and `.git/**` is refused first by the files route.
   - **The policy** is the author's as the engine's `policyFor` builds it for a `Write`: the role's rows, the workdir, the credential file and the "Always in this project" answers. The scripts, hosts and ticket files judge commands only. The tests compare each row with `evaluate()` under the engine's own `policyFor` of the session's start input.
   - **The write** is a fixed program run by the image's `node` through the existing `exec`: `node -e <program> -- /workspace <path> <hash>`, with the text on its input.
     - It checks the hash, writes a temporary file in the file's real folder (the mode kept), then checks the place again before the rename.
     - The place: the folder's and the file's real paths stay inside the checkout, out of `.git` and `.claude`, the file is no `CLAUDE.md` and no link. Otherwise the temporary file is removed and the save refused.
     - The host never writes. A test gives a container that answers "saved" without writing, and the host file is unchanged.
   - **After a confirmed save,** the answer is journaled as `cleared.permission_answered` (`allow_once`, the user, the rule). Every save is journaled as `cleared.human_edit` (`via: editor`), with the counts of a line diff, never the content.
6. **What the session is told** (`flow/takeover.ts`, `terminal/human.ts`, `flow/human-edits.ts`).
   - **A live session** is told at once through the engine's `send`, as `cleared`: "<name> changed these files: <path> (+a, -r). Read them again before editing them."
   - **At Take over,** the checkout's state is read in the container, never with git on the host: the commit, and the hash of each file that differs from it.
   - **At Give back,** before the engine resumes the session:
     1. the terminal is closed;
     2. the same program compares the checkout with the take-over commit, so a commit made in the terminal, a change undone and a new file are found, and a link is hashed by where it points;
     3. each file the terminal changed is journaled (`via: terminal`); an editor save made while taken over and left as saved is not counted again;
     4. after the engine's `giveBack`, one notice names every file, the editor's first.
   - **Why two messages.** The engine sends its own words at Give back (`GIVEN_BACK`), and the engine is lane 26's file in wave 10, so this lane cannot make it send one message. The notice follows within milliseconds, and the real runner queues a message sent as a turn starts (`images/session/runner/main.ts`). Reassigning the exported constant around the engine's call would work only through ES module live bindings and a lock, so it was not done.
   - **A Give back that fails** (the resume) keeps the changes for the next Give back, and the state moves on, so nothing is journaled twice.
   - **A session whose plan waits for its Go is told nothing,** at a save or at Give back. A message would make the author propose again (lane 17), and the Go tells it; the reviewer's prompt still names the files.
   - **`humanEdits({ events })`** merges the `cleared.human_edit` events per path: the counts added up, the first `before`, the last `after`, and the last `by`, `at` and `via`.
7. **The journal without the engine.** The terminal's and the save's events are appended through the store the flow module receives in `provide` (`terminal/human.ts`), since the engine's journal is its own. The engine's stream listeners see them at their next wake (15 seconds at most), not at once. The session's adapter reads them from the log as any event.
8. **Files outside the lane's list.**
   - `test/flow/steps-model.test.ts`: lane 23's test of the empty default now asserts the filled function.
   - `test/flow/api.test.ts` and `test/flow/modules.test.ts`: the terminal routes and the save leave lane 17's exclusions, and the module counts 26 routes.
   - `test/terminal/support.ts`: the local container of the tests.
   - The requirements matrix.

**Consequences.**
- **Tests first.** Commit 1532793 holds them alone. Run against the code of `origin/v2` at 5d68c50, every new test file fails. The one test of `app/test/terminal-gate.test.ts` that passes there is the preview listener refusing a write, which already held. The new files are:
  - `test/terminal/lines.test.ts`, `container.test.ts` and `routes.test.ts`;
  - `test/flow/files-save.test.ts` and `human-edits.test.ts`;
  - `app/test/terminal-gate.test.ts`;
  - new cases in `test/container/docker.test.ts`, `test/flow/api.test.ts`, `test/flow/modules.test.ts` and `test/flow/steps-model.test.ts`.
- **The labelled run on this server** (Docker 29.8.1, util-linux 2.41.5): two sessions started by the session runtime, labelled `cleared.dev=v2`, on a copy of the guestbook, with a dummy token file and no login (this lane never reads the owner's login file).
  - In the terminal, `pwd` answered `/workspace` and `git status` answered "nothing to commit, working tree clean".
  - `git push origin main` failed with "CONNECT tunnel failed, response 403": the forge is not on the session's allow list, and the container holds no credential.
  - A one-line save of `src/server.ts` through the write program landed. A save through a link to a host folder found nothing there (`missing`), and the host file was unchanged. A save of `scripts/pre-commit` with `scripts -> .git/hooks` was refused, and no hook was written.
  - After the close, `docker top` showed only the container's own `sleep infinity`; the shell and its `sleep 600 &` were gone.
  - The Give back program found the saved file and the file the terminal created.
  - From the other session's container, a host listener on `127.0.0.1` gave no answer (`ECONNREFUSED` on 127.0.0.1, `ENETUNREACH` on each host address).
  - After the stop, no container was left with the run's session labels.
  - **What the run did not show:** a real harness's next turn starting with the notice, which needs a real login. That turn is proven on the fake adapter (`test/flow/human-edits.test.ts`), and the proof's step 11 runs it for real.
- **Section 8.** Whether the terminal runs under `script`, whether a resize passes and whether Give back leaves no process are closed by this run. How a save in the middle of a turn affects that turn, and how often the write program's window between its check and its rename loses a change, stay for the proof's step 11.
- **Open, for other lanes:**
  - **One message at Give back:** the engine's `giveBack` could take the notice from `flow/takeover.ts` (a fix lane after wave 10, when the engine is free).
  - **A forgotten Take over** still holds the container (issue 213, item 2): the terminal closes after 15 minutes, but the session stays paused until Give back. A cap belongs to the engine.
  - **The files route's reads** check the proof only (issue 213, item 4). The save checks the owner.
  - **The terminal's counts** are against the take-over commit, so a file the session had left changed counts the session's lines too. The hashes say exactly whether the human changed it.
  - **Lane 32** reads `Me.terminal`, mounts the terminal on the stream and the posts, and the editor on the `PUT`, with `FileWriteRefusal.confirmable` for the confirmation.
- **Checks**, after the merge of `origin/v2` at 92793d5: `npm test` runs 1116 node tests, 1110 pass and 6 are skipped as before, and 154 Vitest tests pass; `npm run typecheck` and `npm run guard -- --base origin/v2` are green.
- **The requirements matrix.** B5.10f, D4, O9, O10 and C1 name this pull request and stay `partial` for lane 32's screens. P12 and P13 are `done`. The new lines P35 (the terminal's process) and P36 (what a human changed and how the session is told) record choices 1 and 6 (P32 to P34 are lane 26's, merged first as pull request 222).
- Pull request: 224, against `v2`.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j2-terminal-editor-service`.

## 2026-10-22: the steps, the contract and knowledge gestures, the questions to the code, the recipes and the schedules on the screens (the author's choices, lane v2-j2-additions-screens)

**Decision.** Lane 27 applies the app's part of decisions 26 to 29 of the [milestone 2 plan](milestone-2-plan.md). It adds:

- the ticket's steps on the session screen's Plan tab, on the tower's live sessions ("step 2 of 4, filter-api") and in the plan panel;
- the contract item's Validate and Send back, and the knowledge item's Approve and Reject, in the inbox, and both kinds in the tower's Needs you;
- the `/ask/:id` screen and "Ask about the code" in the tower's bar;
- "Run a recipe" with its parameters' form, and the schedules in the tower's plans card.

The lane's choices:

1. **The `/ask/:id` page needs one line outside the lane's files.** `app/src/server.ts` writes a page only for the addresses of its `PAGES` list, and that file is lane 31's in wave 10. The plan names `app/src/catalog.ts` for the ask screen, which adds `ask` to the screens, but no page is served without the list's row.
   - The lane adds the one row `/^\/ask\/[A-Za-z0-9_-]{1,64}$/`. It sits away from lane 31's edits (the loopback gate and `/api/me`), and a merge takes both.
   - The rest is inside the lane's `v2/app/web/**`: `main.tsx`, `shell/App.tsx` (the screen's chunk), `ShellScreen` in `shell/Header.tsx` (no tab of its own), `lib/catalogs.ts`, and `title_ask` in the shell's catalogs.
   - The screen is `screens/ask/Ask.tsx`, so the server's manifest reader finds its chunk and its sheet.
2. **The ask screen** (`screens/ask/`).
   - **Layout.** One reading column: the question as the page's title, what it is about (a service, a file and a line, or the whole platform), each turn as a card with its answer, then the sum and the follow-up field. No kit reference exists for it; it follows `app/DESIGN.md`.
   - **Answers** are text (`white-space: pre-wrap`), never markup.
   - **The cost.** A turn under a cent reads to the hundredth of a cent ($0.0023), else in cents. The week share is "week used at 29 %": the seven-day window as the reader's session last saw it, not this ask's share, as lane 25's `Ask.weekPercent` says. It is left out while it is null.
   - **Polling.** The ask is read again every 2 seconds while a turn runs (`starting` or `running`), and never once it ended.
   - **The follow-up** is held while a turn runs, since the reader answers 409 then. It is checked against `QUESTION_MAX`, which a test keeps equal to the reader's `MAX_QUESTION` (4000).
   - **Refusals.** 409 reads as three questions at once for a new ask, and as a turn that runs for a follow-up.
3. **"Ask about the code" in the bar.**
   - The title and the description are the question.
   - **Its target** is a `service:path:line` token of a workspace service (any service when the workspace could not be read, since the service checks it); a time such as 10:30:15 is no target. Else the one service picked; else the whole platform.
   - The tower opens `/ask/<id>` at once.
   - **A reader's session** is no longer drawn among the tower's live sessions (lane 25's followup): its role had no word in the tower's catalog, so it would have thrown, and it is the ask screen's. The sessions list (`/sessions`) had the same throw: it now lists a reader's session as "A question to the code", linked to its ask.
   - **Not built:** an ask started from a session's Plan tab, which decision 28 also names (the lane's goal names the bar only). C11 stays `partial` for it.
4. **The contract and knowledge items** (`screens/inbox/`).
   - **Answered at once, with no grace.** Both routes answer before the work they start: the next steps for a contract, the memory's write for knowledge.
   - **Send back** opens a field as the session plan's Change does, checked against `SEND_BACK_MAX`, which a test keeps equal to `MAX_SEND_BACK` of `flow/steps.ts`.
   - **Refusals.** 404 and 409 read as already answered, and the list is read again. A knowledge item's 403 says only the workspace's owner answers it (lane 24's choice 3).
   - **A handled item** says who did what and when, with a Send back's message.
   - **Ids.** The routes name an item by its inbox id, encoded (it holds colons).
   - **In the tower.** Both kinds join Needs you; a contract's title is the catalog's ("Contract of filter-api").
5. **The steps.** They show only for a ticket of two steps or more, so a one-service ticket's screens are unchanged (tests compare the markup).
   - **The session screen** reads `GET /api/tickets/:id/steps` at once and on its 10-second tick. The Plan tab shows a card of the steps, this session's outlined in ink, each with its state and cost. The ticket card's service line reads "on filter-api · step 2 of 4".
   - **The tower** reads the steps in a workspace of several services only, once per ticket of its live authors.
   - **The plan panel** lists an item's steps under its whole width (decision 26: "the plan shows the steps' order and dependencies"; matrix line M2 names lane 27 for it).
   - **A steps answer that is not a list** shows no steps. The browser tests found it: a stand-in answering `/tickets/:id/steps` with the ticket made the session screen throw before its timeline drew.
   - **Words.** A step's dependency reads "waits for 2 and 3": "after" was taken for an English sentence left in the French screens by the inbox's catalog check (the word is in a class name).
6. **Recipes and schedules** (lane 26's routes, built beside this lane and merged before it as pull request 222; the screens send and read its shapes as served: the declared parameters only, the run's `plan` or `message`). Both are optional reads, so a service without them shows the tower as before: no "Run a recipe", no schedules.
   - **The form** refuses a missing required parameter before anything is posted, with its own sentence. The form is `noValidate`, so the browser's bubble does not stand in for it; the `required` attribute stays for assistive technology.
   - **Run** is outlined until the recipe can run, then in ink, so the bar's New ticket is not a second ink gesture on screen.
   - **A run** says what it became and links to the plan (a ticket recipe) or the lead (a goal recipe).
   - **A schedule** shows its next run ("tomorrow at 03:00", "on Mon at 08:00") and its budget; one switched off reads "Off" and comes last. The `every` text (lane 26's `day 03:00`, `weekdays 08:00`) is not shown: it is English, and the next run says when.
7. **The French amounts** put a no-break space before the dollar, as the plan panel's `plan_cost` does.
8. **Fixtures.**
   - `fixtures/source.ts` (this lane's in wave 10) answers every route of this lane: the steps, the contract and knowledge gestures kept in memory, the asks (a new one stays `starting`, a follow-up runs, a second one is a 409), the recipes and their run, and the schedules. The inbox there now lists a contract and a knowledge item.
   - `towerSource` and `inboxSource` answer them too.
   - New values: `fixtures/ask.ts`, and in `fixtures/tower.ts` `ticketSteps`, `RECIPES` and `schedulesFixture`. In `fixtures/lead.ts`, `stepsPlan`.
9. **Selectors for lane 29:**
   - the bar: `data-bar="ask"`, `data-bar="recipe"`;
   - the recipe form: `data-recipe`, `data-param`, `data-act="recipe_run"`;
   - the inbox: `data-act` set to `contract_approve`, `contract_send_back`, `contract_send_back_send`, `contract_keep`, `knowledge_approve` or `knowledge_reject`;
   - the steps: `data-step` on a live session's tag, on the Plan tab's rows (with `data-state`) and in the plan panel (with `data-kind`);
   - the ask: `data-ask` and `data-state` on the screen, `#follow-input`, `data-act="follow"`, `data-ask-total`;
   - the schedules: `data-schedule`.
10. **Review followups taken:** issue 210, item 1 (the services picked are dropped once the title is cleared, which hid their chips), and item 5 (the inbox's plan item shows each item's services: its catalog holds `PLAN_SERVICE_KEYS`, and it passes `services: true`).

**Consequences.**
- **Tests first.** Commit `9bbf704` holds them alone, with the fixtures' new values (data only). On `origin/v2` at `5d68c50`:
  - 8 of the 11 node tests failed: the files failed at import, or the page answered 404;
  - 16 Vitest tests in 6 files failed.

  The new files are:
  - `app/test/ask/model.test.ts` and `app/test/ask/app.test.ts`;
  - `app/test/tower-additions.test.ts`, `app/test/inbox/additions.test.ts`, `app/test/session/steps.test.ts` and `app/test/lead/steps.test.ts`;
  - their Vitest files under `app/web/test/`.

  Among them: a test that Approve on a contract calls its route and the item leaves what waits, through the app; and a test that the recipe form refuses a missing parameter before posting.
  - **Changed in the first commit:** lane 21's test of the reading-only items now expects the gestures, and `app/test/fixtures.test.ts` lists the new kinds.
  - **Adjusted while the code was written:** a contract's need title is the catalog's (`needTitle`); the French amounts use the no-break space; "waits for" replaces "after"; and lane 22's test of a kind the tower does not draw now uses a later kind, since knowledge is drawn.
- **Checks.**
  - `npm test`, after the merge of `origin/v2`: 1119 node tests (1113 pass, 6 skipped as before; 1036 before the lane, 47 of them lane 26's) and 177 Vitest tests (154 before).
  - `npm run typecheck` is green.
  - `npm run guard -- --base origin/v2` is green, without a private-term list (`CLEARED_REPO` unset).
  - **The browser tests**, with `CLEARED_V2_PLAYWRIGHT` and `CLEARED_V2_CHROME`: the five of `app/test/session/tabs-browser.test.ts` and `app/test/choices-browser.test.ts` pass. On the lane's code before the guard above, four of them timed out on the session screen, while all five passed on `origin/v2` at `5d68c50`. `app/test/notify/browser.test.ts` times out on this branch and on `origin/v2` alike, as lane 22 logged.
- **The visual loop.** The app ran on an ephemeral `127.0.0.1` port per source (after `ss -ltn`), in headless Chromium, with the clock fixed at the fixtures' time.
  - Captures, none committed, mode 644, with the pointer in an empty corner: `/tmp/cleared-captures/j2/additions-<screen>-<width>-<theme>.png` for `tower`, `tower-recipe`, `ask`, `ask-running`, `ask-starting`, `inbox-contract`, `inbox-contract-send-back`, `inbox-knowledge`, `session-steps` and `lead-steps`, at 1440, 1280, 768 and 390, light and dark. That is 80 files, with `additions-reference-<screen>.png` rendered from `/tmp/cleared-reference/`.
  - All 80: no horizontal overflow, no page error, no `securitypolicyviolation`, no request off the app's origin.
  - The first loop found the follow-up's button unreadable (ink on ink, `.btn` being each screen's own rule) and the recipe form without the bar's margins; both were fixed before the art director's pass.
- **The art director's pass** was run once, by Sonnet 5.5 in a fresh session, on the captures, the references and `app/DESIGN.md`.
  - **Taken:**
    - an item's steps under its whole width in the plan panel;
    - the step's "This session" under its line on a phone;
    - a goal's schedule on two lines instead of cut;
    - Run in ink only once the recipe can run;
    - "Keep it as proposed" in place of the plan's "Keep the plan" on a contract;
    - the ask's total wrapped without an orphan, and no resize grip;
    - no eye icon on the ask's read-only line.
  - **Not taken:**
    - **dropping every dollar amount**, which the pass read in `DESIGN.md`'s "never a currency" (written of the tower's instruments). Decision 28 asks for each answer's `total_cost_usd`; the plan panel already shows the cost until the week share is measured (section 5.2 of the first plan); and the owner's decision on the Consumption screen allows dollars from a real source, which `total_cost_usd` is;
    - the contract's file in Geist Mono, as the session's file paths are (issue 213, item 6, the same question);
    - the shield on a sensitive service, lane 22's;
    - the facts' label column on the knowledge item, the inbox's layout for every kind.
- **Followups.**
  - **A schedule's period** in the reader's words (lane 26's `every` format), beside its next run.
  - **Lane 31:** the `PAGES` row of choice 1 is in `server.ts`, its file; a merge keeps both.
  - **Lane 29:** the selectors of choice 9. Through the fixture source, a new ask stays `starting`, and its rehearsal needs a reader on the fake adapter.
  - **Polling cost.** The tower reads one steps route per live author's ticket every 10 seconds in a workspace of several services. A step on `SessionSummary` would save those reads (a change of `types.ts`).
  - **Issue 211, item 3** ("Rolled back" twice on a handled train) is left: lane 29's step 9 reads the line, and the chip is what files the train under "Handled today".
  - **Issue 213's nits** on the session screen ("Done when" twice, the editor's selected file) are left to a pass on that screen.
- **The requirements matrix.** C2, C7, C11, C12, M2, M8 and M9 name this pull request (225). M8 and M9 are `done`, the live runs being lane 29's. C7 is `done`, lane 26 being merged; C11 stays `partial` for the Plan tab's entry, and C12 for lane 26's restart note. The new lines P37 (choices 1 to 3) and P38 (choices 4 to 7) record the lane's choices. They were P32 and P33 in the first version of the pull request, then P35 and P36 after lane 26 (pull request 222) took P32 to P34; lane 31 (pull request 224) took P35 and P36 before this lane merged.
- Pull request: 225, against `v2`.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j2-additions-screens`.

## 2026-10-22: the web terminal and the editable editor on the session screen, and the page's style nonce (the author's choices, lane v2-j2-terminal-editor-screens)

**Decision.** Lane 32 applies the session screen's part of decisions 32 and 33 of the [milestone 2 plan](milestone-2-plan.md), on lane 20's tabs and lane 31's routes. The Terminal tab of a session taken over by the signed-in account, on the app's loopback address, mounts the web terminal. The Editor tab opens a changed file for editing and saves it. Every page carries its own style nonce, which both packages need. The lane's choices:

1. **Where the terminal goes** (`components/terminal/`, `screens/session/`).
   - It takes the timeline's place while the session is taken over by the signed-in account and `/api/me` says `terminal: true`. The timeline does not move while the session is paused, and comes back at Give back.
   - The notice stays above it, shorter. The server command (`docker exec -it ... claude --resume <id>`) stays in it as the fallback, as lane 20 asked. The disabled composer stays below.
   - Elsewhere (the public origin, or an app that does not say) the tab shows lane 20's command and says why: the web terminal opens on this machine's browser only. Another account's take over shows the command and no terminal.
2. **How it talks to lane 31's routes** (`components/terminal/model.ts`, `Terminal.tsx`).
   - **The open waits for the tab.** A hidden terminal has no size to give the shell, so the first open happens when the Terminal tab is first shown. The terminal then stays mounted while other tabs are open.
   - **Open, then the stream.** An open answered 409 is a terminal already open (a reload of the page): the stream is attached, the service replays what it holds, and the size is posted again. Each chunk is written once, by its seq.
   - **The end.** The stream's `closed` frame ends it with its reason (Give back, idle, closed, exit), and the screen says it in words. A stream that gives up is "lost". Open again opens a new one, except after Give back.
   - **The keys.** They are batched every 30 ms into posts of at most 4096 bytes of UTF-8, cut between characters, never between the two halves of a surrogate pair. The posts are sent one at a time, so they reach the shell in order. A refused post stops the batcher and says the typed text was not sent.
   - **The size** follows the panel (a `ResizeObserver` and the fit addon), posted 150 ms after the last change. **The colours** follow the page's theme (a `MutationObserver` on `data-theme`).
3. **The shims, once per screen** (issue 200, items 2 and 3). `screenShims.hold(nonce)` installs `installStyleNonce` and `installStyleAttributeCssom` at the first hold, just before `term.open()`, and removes them at the last release, after `term.dispose()`. Each release counts once. So a second mount (React's StrictMode, a reopen) can never remove them from under a live terminal. xterm writes `<style>` elements on fit and on theme changes too, not only at open, which is why they stay installed while it is mounted.
   - **Not done here, for lane `v2-j2-deps-xterm`'s file:** the unwrapped insertion methods and the colour pattern (issue 200, items 1 and 4). `style-nonce.ts` is imported, not edited. The xterm pin stays exact for that reason, and `app/test/session/terminal-browser.test.ts` is to be run again on every bump of either package.
4. **When a file can be edited** (`components/editor/model.ts`).
   - **Only when the text on screen is the file.** Lane 20's files route cleans the text it shows (a secret's shape, a path of the service) but hashes the file's bytes. Saving the cleaned text with that hash would pass the hash check and write the mask over the file. So the editor hashes the text it was given (SHA-256, `crypto.subtle`) and compares it with the route's hash. If they differ, the file is read only, and the bar says that some of its text is hidden on screen.
   - **Other read-only cases:** a file the viewer cut at 400 lines; a page with no digest (not a secure context, which the loopback address and the https proxy both are); an ended session, a reviewer's, or another account's take over.
   - **What the service still checks:** the owner account, the review running, the ticket's state. Those come back as the save's refusal, with their sentence.
5. **The editor's states.**
   - **Save** sends the text and the hash the editor loaded, then the hash each save answered. Typing can go on during a save: the text sent is kept apart, and what was typed meanwhile stays unsaved.
   - **A 409 with a hash is a conflict.** Its Reload takes the file as it is now and drops the person's changes. The sentence says so before the click.
   - **A 403** shows the rule and its reason. For `install.package` and `scripts.change` the route answers `confirmable`, and the editor shows "Save anyway", which sends the rule. A `confirmable` with any other rule is shown as a refusal.
   - **The session's own change to the open file** (lane 20's refetch, when the session's files move) never replaces the editor's text. The tab says the session changed the file and offers Reload.
   - **The file list** is held while there are unsaved changes, so no edit is dropped by a click on another file. "Stop editing" puts the file back.
   - **The editor keeps a file's own line ends** (`\r\n` through `EditorState.lineSeparator`). Mod-S saves.
   - **After a save** the viewer holds the saved text and hash, so the file is not taken for the session's change.
6. **The packages load by a dynamic import of the session screen only.**
   - `components/terminal/xterm.ts` and `components/editor/codemirror.ts` are the only modules that import them. The session screen imports each with `import()`, so Vite builds them as chunks of their own: xterm 332 kB, CodeMirror 501 kB.
   - xterm's sheet is in xterm's chunk, a file of the app's origin.
   - `codemirror.ts` also imports `@codemirror/state`, `@codemirror/view`, `@codemirror/language` and `@lezer/highlight`. They come with `codemirror` (lane 30), and no dependency is added.
   - CodeMirror takes the nonce through `EditorView.cspNonce`. The terminal's shims are not for it.
7. **The style nonce** (`app/src/server.ts`).
   - **Every page gets one**, the sign-in page included, as the plan says ("each page it writes"). Each draws 128 random bits, adds `style-src 'self' 'nonce-<value>'` to that response's policy, and writes `<meta property="csp-nonce" nonce="<value>">` in the page.
   - **The page reads it** from the element's `nonce` property, since Chromium hides the attribute.
   - **What is unchanged:** every other directive; `script-src` still falls back to `default-src 'self'`; never `unsafe-inline`.
   - **What carries no nonce:** a file, a catalog and an API answer keep the policy as it was. `contentPolicy(previewOrigin)` without a nonce is the policy of before.
8. **The fixture sources** (`fixtures/session.ts` `fixtureHuman`, used by `sessionSource` and `fixtures/source.ts`) answer the terminal's routes and the save.
   - **A stand-in shell.** Its first line is the service's. Then come a line in 256 colours and one in 24-bit colour, for the violation count. It echoes what is typed and answers `ls`, `pwd`, `git status`, `colours` and `exit`.
   - **Its stream** answers after `Last-Event-ID` or `?after=` and is held open until the terminal closes. Give back closes it.
   - **The checkout's files** are kept as the editor saves them: a stale hash is a 409 with the current one; `CLAUDE.md` and `.claude/` are refused by `default`; a dependency of `package.json` asks for its confirmation.
9. **Issue 213's nit (a) is taken:** the selected file in the Editor's list is a tint, without the heavy ink bar. The other nits ("Done when" twice, Give back on its own row at 768) are left.

**Consequences.**
- **Tests first.** Commit 07ba31f holds them alone, and each failed on `origin/v2` at b62572c. Two files failed at import, two style-nonce tests and three bundle tests failed, and the Vitest file failed to load. The new files are:
  - `app/test/session/terminal.test.ts`: the batching (no post above 4 KiB, a burst in order, one post at a time), the choice between the terminal and the command, the chunks once, the closed reasons, the routes with the anti-forgery header, the nonce's reading, and the shims held once per screen;
  - `app/test/session/editor.test.ts`: when a file is editable, the states, the answers of the save, the PUT with the loaded hash;
  - `app/test/style-nonce.test.ts`: two pages, two nonces, each in its page; no `unsafe-inline`; the other directives as before; a file, a catalog and an API answer with no nonce;
  - `app/test/session/bundles.test.ts`: the build manifest read, so neither package is in any chunk the entry or a screen loads at once, both are behind the session screen's dynamic import only, and xterm's sheet is in no other screen's sheets;
  - `app/web/test/session/terminal-editor.test.tsx`: each state of the terminal's frame and of the editor, the command and why, both languages, no inline style;
  - `app/test/session/fixture-human.test.ts`, written after the code: the tower fixture source's terminal, stream, save and Give back, through the app;
  - `app/test/session/terminal-browser.test.ts` (Chromium). It takes a session over, types `ls` and Enter and finds the input route called with `ls\r`. It saves a change and finds the PUT carrying the loaded hash, then a 409 showing the conflict with Reload, then a 403 showing the rule's reason. With both packages mounted, it shows a line in 256 colours and one in 24-bit colour, selects text in the terminal, types in the editor, opens its completion list and its search panel, then counts the page's `securitypolicyviolation` events: 0 (issue 195, F3). A second test, through an `/api/me` that says `terminal: false`, shows the command and why.
- **The violation count proves something.** With the shims' hold removed, the same test counted `style-src-elem` violations and failed. The hold was then put back.
- **Files outside the lane's list:**
  - `app/test/static.test.ts` and `app/test/preview.test.ts` compared a page's whole policy with the old string. They now accept that string with the page's `style-src` nonce, and nothing else.
  - `docs/v2/requirements-matrix.md`.
- **Checks.**
  - `npm test`: 1183 node tests, 1175 pass and 8 skipped (the browser tests, without `CLEARED_V2_PLAYWRIGHT`), and 183 Vitest tests pass.
  - `npm run typecheck` and `npm run guard -- --base origin/v2` are green. The guard ran without a private-term list (`CLEARED_REPO` unset).
  - The browser tests pass with `CLEARED_V2_PLAYWRIGHT` and `CLEARED_V2_CHROME` (Chromium 1248): this lane's two, lane 20's three, and lane 13's two.
- **The visual loop.** The app ran on an ephemeral `127.0.0.1` port (after `ss -ltn`), against the session fixture's source, in headless Chromium, with the clock fixed at the fixture's time.
  - **The captures** are `/tmp/cleared-captures/j2/terminal-editor-<state>-<width>-<theme>.png`: the states `terminal`, `terminal-closed`, `editor`, `editor-saved`, `editor-conflict` and `editor-confirm`, at 1440, 1280, 768 and 390, light and dark. Beside them are `terminal-command` at 1440 and 390, and `terminal-editor-reference-session.png` rendered from `/tmp/cleared-reference/session.html`. That is 51 files, mode 644, with the pointer in an empty corner. None is committed.
  - **The checks:** every capture had no horizontal overflow, no page error and no `securitypolicyviolation`.
  - **The first loop found** a global `.open` rule (`margin-left: auto`) taking the state dot's class, the closed terminal's footer and the confirmation's buttons below the panel at 1440, and the phone's state dot on its own line. All were fixed before the art director's pass.
- **The art director's pass** was run once, by Sonnet 5.5 in a fresh session, on the captures, the reference and `app/DESIGN.md`. It found the identity held.
  - **Taken:**
    - the code's colours as `--code-*` tokens per theme, since CodeMirror's default palette is for light only and was unreadable in dark;
    - the terminal's ANSI colours lifted on its dark surface, and a neutral selection;
    - a confirmation on the amber card, as every gesture that waits for the person;
    - a conflict that leads with Reload in ink, its sentence not in red;
    - the editor's focus ring in the link colour;
    - the footer centred;
    - the command's label as a muted meta line;
    - a 12 px terminal font on a phone;
    - Save kept in view below 1440 (a footer sticky to the tab's scroll).
  - **Not taken:**
    - dropping the notice's title, which repeats lane 20's state strip but carries the time;
    - resetting the editor's horizontal scroll, which follows the cursor as any editor does;
    - Give back on its own row at 768, which is lane 20's strip (issue 213);
    - the two primaries on a phone while editing (Give back and Save): each is the gesture of its own area.
- **Followups.**
  - **Lane 29 (the proof's step 11):** the selectors are `[data-terminal-state]` with `data-reason`, `.term-host` (click it to type), `[data-act="terminal_open"]`, and `[data-act]` set to `editor_edit`, `editor_save`, `editor_reload`, `editor_confirm` or `editor_close`, with `[data-editor-state]`. The terminal needs the loopback address.
  - **Issue 200, items 1 and 4,** in `style-nonce.ts`, for its own small lane.
  - **A save that changes nothing** is still a save (the route writes and journals it). The editor's Save is disabled until the text differs from what it loaded.
- **The requirements matrix.** B5.10f, D4, O9, O10 and C1 name this pull request (228) and stay `partial` only for the live run (proof j2-multi steps 4 and 11). O14 and P17 are `done`. The new lines are P39 (the terminal, choices 1 to 3), P40 (the editor, choices 4 to 6) and P41 (the nonce, choice 7).
- Pull request: 228, against `v2`.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j2-terminal-editor-screens`.

## 2026-10-22: Owner request: Take over attaches the web terminal directly to the session's harness

**Decision.** The owner asked on 2026-10-22 at 17:26 for a lane outside the [milestone 2 plan](milestone-2-plan.md). On Take over, the web terminal attaches directly to the session's interactive harness: for Claude Code, the equivalent of `claude --resume <session id>` inside the session's container. It goes through the harness adapter so that it stays generic: the adapter interface gets a method for the interactive resume, Claude Code implements it, and the other adapters (Cursor and Codex, later) answer unsupported with a clear message. The raw shell becomes a secondary option, a Shell button. The displayed `docker exec` command and the words "run this in a terminal on the server" are removed entirely. Give back leaves the interactive session cleanly (the harness exits, the transcript is saved) and hands control back to Cleared, which resumes with the updated journal.

**Consequences.** This changes decision 30 (the command on the server, where the web terminal is not offered) and decision 32 (the terminal's first line naming `claude --resume`, a shell by default) for milestone 2. The safety rules of decision 32 are unchanged: the owner account only, the anti-forgery and origin checks, the loopback address only, everything typed journaled. The requirements matrix records the request as O16, and the author's choices as P42 and P43 (the entry below).

## 2026-10-22: the web terminal on the session's own harness, Shell beside it, Give back from the transcript (the author's choices, lane v2-j2-takeover-harness-direct)

**Decision.** The lane applies the owner's request of 17:26 (the entry above). Its choices:

1. **The adapter interface** (`session/contract.ts`).
   - `SessionAdapter.interactive?(id)` answers `{ supported: true, name, command }` or `{ supported: false, reason }`. The command is what to run in the session's container: fixed words, the session and its model, never a secret.
   - **Optional, not required.** `session/adapters/index.ts` (lane 29's file in this wave) and several test adapters build the interface, so a required method would break them. `interactiveResume(adapter, id)` turns a missing method, a missing adapter or one that throws into unsupported. The sentence says to open the Shell instead: "The codex harness cannot be resumed in a terminal yet: open the Shell instead." The error of an adapter that throws stays on the host.
   - The fake adapter answers that a scripted session has no interactive harness.
   - When an adapter answers supported, its own harness process has been handed over, so only one harness writes the session at a time. `resume()` then takes it back from the transcript.
2. **The runner hands its harness over without ending** (`images/session/runner/main.ts`).
   - **Why the runner changes.** Take over only interrupted the SDK's query, and the query kept its context in memory. A human's `claude --resume` beside it would fork the transcript, and Give back would answer from the old context. The runner is the container's command, so closing the query must not end it either.
   - `release` closes the query and the runner says `released`. This also works while the runner waits for a new login: the wait wakes at once.
   - `reload` starts a new query with `resume: <id>`, which reads the transcript as the human's harness left it, and the login file again. A turn sent meanwhile waits for it.
   - `stop` and the end of the input end a released runner.
   - An image built before this lane ignores the two lines. Its adapter then answers unsupported ("rebuild the session image") after `releaseTimeoutMs` (15 seconds by default).
3. **Claude Code's interactive resume** (`session/adapters/claude-code.ts`, `claude-code/interactive.ts`).
   - `interactive()` asks the runner to release, waits for `released`, and answers Claude Code with `interactiveCommand(id, model)`. `resume()` sends `reload` before any turn once a release was sent. The engine's `giveBack` already calls `resume()`, so the engine is not edited.
   - **A Give back during the hand-over.** The release is recorded as sent before it is written, so a Give back that lands before the runner says `released` still reloads it (the runner keeps a `reload` that comes before it parks). `interactive()` then answers unsupported ("given back"), so no `claude --resume` starts beside the reloaded runner. A timeout keeps the release as sent too.
   - **The launcher** is `sh -c` with positional words: the session, its model, the login's program, the login file's mount point, and the config's program. Nothing is quoted into the script.
   - **The login.** It reads the login file inside the container, as the runner's `loginToken` does: a token, or only the access token of a credentials file. It puts the token in the harness's environment only: never a word of a command line (the host's `ps` and `docker inspect` would show it), never printed. Without a login it exits 3 with a sentence.
   - It sets the runner's git identity and execs `claude --resume "$1" --model "$2"`, on the same session id (`--fork-session` is not given) and on the session's model.
   - **The first run** (found by the labelled run). Claude Code started interactively for the first time in a config folder shows its first-run screens. Their connectivity check reaches `platform.claude.com`, which the session's egress refuses, and the harness exits. The launcher therefore first marks the session's own config (`$CLAUDE_CONFIG_DIR/.claude.json`, on the session's volume): `hasCompletedOnboarding`, and the checkout as trusted. Every other key is kept, and a config that is not JSON is left as it is. The egress allow list is not widened.
   - **What the harness's tools see.** They see the login in their environment, as the runner's harness's tools do (issue 147). The shell does not: the labelled run printed an empty `${CLAUDE_CODE_OAUTH_TOKEN:+yes}` there.
   - **Who answers its permission requests.** In the terminal the harness asks the human directly, in its own manual mode, not through the policy and the inbox. It loads the checkout's `CLAUDE.md`, which holds the briefing. The container keeps its reach (the egress list, no forge credential), so a push fails as the session's would.
4. **The terminal's two modes** (`terminal/`, `api/types.ts`).
   - `POST .../terminal/open` takes `mode: 'harness' | 'shell'`, with `harness` as the default.
   - **The harness.** The human side asks the session's adapter (by the session's `harness`) for its interactive resume and runs that command.
   - **Answers.** A harness that cannot be resumed answers 501 with the adapter's sentence, and nothing opens. A second open answers 409 with the mode of the one open, so a reloaded page attaches to it. Any other mode answers 400.
   - **The terminal's one slot** is claimed before the adapter is asked, so a second open during the release is a conflict.
   - **Give back during an open** (issue 226, item 1). After the process starts, the terminal checks that the session is still taken over. If it was given back meanwhile, what started is ended at once and the open answers 409, so the human's harness and the reloaded runner never run the session together.
   - **The wrapper** is `echo $$ > <pid file>; exec "$@"`, with the program's words as arguments, for the harness and for `bash -l` alike.
   - **The close** sends a hang-up, as a closed terminal does. It then waits up to 5 seconds for the program itself to leave (a zombie counts as gone, since nothing in the container reaps it), then kills what is left of its session. The labelled run measured 523 ms for Claude Code, which wrote its last transcript lines as it left.
   - **The first line** says what runs: "Claude Code, resumed on this session. Give the session back when you are done", or "A shell in the session's container". `cleared.terminal_opened` carries the mode. `TerminalOpened` carries the mode and the harness's name instead of the `resume` command.
5. **The screen** (`components/terminal/`, `screens/session/`, the `session` catalogs).
   - **The command is gone.** `resumeCommand`, `containerName` and the `takeover_command_label` key are removed, and `takeover_body` and `terminal_here_only` are rewritten. No word of Take over or of the terminal, in either language, sends anyone to a terminal on the server; a test reads the catalogs. On the public origin the notice says the terminal opens on this machine's browser only, with no command.
   - **What runs.** A line above the terminal names it ("Claude Code, resumed on this session", or "Shell in the session's container"). Beside it, an outline button gives the other mode: Shell, or Back to Claude Code. Give back stays the primary gesture.
   - **The switch** closes the open terminal (the harness leaves, its transcript kept), then opens the other. The `closed` frame of the terminal that closed is not shown.
   - **A harness that cannot be resumed.** The header says "<name> cannot be resumed here", the adapter's sentence is shown once, and only Shell is offered, with no empty terminal.
   - **The harness's exit** reads "The harness ended", apart from the shell's.
   - **The fixture sources** answer both modes. A stand-in harness shows the session's last words and answers each line with a sentence that says it is a stand-in; `/exit` ends it. The shell stand-in is lane 32's.
6. **The engine's words at Give back** (`flow/takeover.ts`, `GIVEN_BACK`) now say that what the owner did with the session meanwhile is in the conversation above.

**Consequences.**
- **Tests first.** Commit 47a02f9 holds them alone, and each failed on `origin/v2` at 309aea5. The new files are:
  - `test/session/interactive.test.ts`;
  - `test/session/claude-code/interactive.test.ts`: the launcher run by this machine's `sh` and `node`, with a stand-in `claude` and a test login file;
  - `test/terminal/harness.test.ts`.
  The new cases are in `test/session/claude-code/{runner,adapter}.test.ts`, `test/terminal/{routes,container}.test.ts`, `app/test/session/{terminal,tabs,fixture-human,terminal-browser}.test.ts` and `app/web/test/session/{terminal-editor,tabs}.test.tsx`. Three tests were added later, each failing first: the release during a login wait and the first run's config (both found by the labelled run), and a Give back during the hand-over (found by the review before the pull request). Lane 20's `app/test/session/tabs-browser.test.ts` asserted the server command; it now asserts the harness attached and no command.
- **The labelled run on this server** (Docker 29.8.1). A probe image `cleared-v2-session:takeover-probe` was built from this branch's `images/session` and labelled `cleared.dev=v2`. The real Claude Code adapter, terminal and docker wrapper ran one session on a temporary checkout, with a dummy login file written for the run (never a real login), so every API call was refused.
  - The first turn was refused, and the runner said it waits for a new login.
  - **The release.** `interactive()` answered `supported` while the runner waited. `ps` in the container then showed only `node /opt/cleared/runner/main.ts`: the runner's harness was gone, and the container was still up.
  - **The harness.** The terminal opened `claude --resume <id> --model claude-haiku-5-5`. The screen showed Claude Code 2.1.306 on Haiku 5.5, with the session's own first turn ("Say hello.", then the refusal). A line typed to it reached it, and the transcript went from 25 to 41 lines. The dummy login appeared nowhere in the output.
  - **Give back.** The terminal closed in 523 ms, and the transcript went from 41 to 44 lines as the harness left. `ps` showed no `claude`.
  - **The reload.** `resume()` returned the same handle, and the runner reloaded and ran the next turn: the turns ended went from 1 to 2.
  - **The shell.** It had no login in its environment, and `pgrep` is in the image.
  - **The cleanup.** After the stop, no container with the session label was left; the volume was removed, and so was the probe image.
  - **The first of three runs** found the first-run screens (choice 3). The second measured a 5-second close, because zombies were counted (choice 4). The third is the one above.
  - **What the run did not show:** a harness turn on a real login. It belongs to the proof's step 11.
- **The visual loop.** The app ran on an ephemeral `127.0.0.1` port (after `ss -ltn`), on the session fixture's source, in headless Chromium 1248, with the clock fixed at the fixture's time.
  - **The captures** are `/tmp/cleared-captures/j2/takeover/takeover-<state>-<width>-<theme>.png`, for the states `harness`, `shell`, `unsupported`, `given-back` and `public`, at 1440, 1280, 768 and 390, light and dark. With `takeover-reference-session.png`, rendered from `/tmp/cleared-reference/session.html`, that is 41 files, mode 644, with the pointer in a corner away from the buttons. None is committed.
  - **The checks:** every capture had no horizontal overflow, no page error, no `securitypolicyviolation`, and no `docker exec` or "on the server" in the Terminal tab.
  - **The loop found** the stand-in's hard line breaks wrapping mid-word, and an empty terminal in the unsupported state. Both were fixed.
- **The art director's pass** was run once, by Sonnet 5.5 in a fresh session, on the captures, the reference and `app/DESIGN.md`. It found the identity held (Geist, hairlines, tokens, no gradient, one icon weight, no command anywhere).
  - **Taken:** in the unsupported state, the header named the harness as resumed and the reason appeared twice. It now says "<name> cannot be resumed here", with the adapter's sentence once.
  - **Not taken:**
    - the notice over the feed on the public origin, which is lane 20's sticky notice by design (rows scroll under it; the full-page capture shows the feed scrolled);
    - the status line under the terminal and Give back's row at 768, both lane 32's and lane 20's layout, already declined there (issue 213);
    - the composer's clipped placeholder at 1280, which is lane 32's words;
    - "Back to Claude Code" wrapping to its own row at 390, which stays readable.
- **Open, for other lanes:**
  - **Lane 29 (the proof's step 11).** Take over now opens the harness, so `git status` and `npm test` typed first would go to Claude Code. The step clicks `[data-act="terminal_shell"]` first, or types to the harness, as the proof chooses. The selectors are `[data-terminal-state]` with `data-mode` (`harness` or `shell`) and `data-reason` (`unsupported` added), and `[data-act="terminal_shell"]` and `[data-act="terminal_harness"]` beside lane 32's. The rehearsal on the fake adapter gets the unsupported state and the Shell. The real run rebuilds the session image first, for the runner's two lines.
  - **The proof's step 11** also closes what this run could not: a harness turn on the real login, and whether the harness's first screen asks anything else.
  - **Issue 226, item 1** is fixed here (choice 4).
- **Checks.**
  - `npm test`: 1195 node tests pass and 8 are skipped (the browser tests, without `CLEARED_V2_PLAYWRIGHT`), and 184 Vitest tests pass.
  - With `CLEARED_V2_PLAYWRIGHT` and `CLEARED_V2_CHROME`, the 8 browser tests pass.
  - `npm run typecheck` and `npm run guard -- --base origin/v2` are green. The guard ran without a private-term list (`CLEARED_REPO` unset).
- **The requirements matrix.** O16 (the owner's request, `partial` until the proof's step 11 runs a real turn), P42 (the adapter's interactive resume) and P43 (the terminal's modes and the screen) are new. B5.10f, D4, O9 and C1 name this pull request. P39 says the server command it kept was removed.
- Pull request: 230, against `v2`.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j2-takeover-harness-direct`.

## 2026-10-22: the proof scripts on the React screens and the replanned milestone 2, and the multi-service proof's driver (the author's choices, lane v2-j2-proof-scripts-m2)

**Decision.** Lane 29 adapts the 48-hour proof of pull request 181 (`v2/scripts/proof-j2.ts`) to the React screens and to what waves 5 to 11 added, and writes `v2/scripts/proof-j2-multi.ts`, the driver of section 2.2 of the [milestone 2 plan](milestone-2-plan.md), each with a rehearsal on the fake adapter. It does not start either real run: both are the orchestrator's, after this wave. The lane's choices:

1. **The 48-hour proof, on the built app.**
   - **The build first.** The rehearsal runs `npm run build` before it starts the app, so the pages come from the manifest of the code it rehearses. The real run is against the app the orchestrator built and started.
   - **The selectors the port kept** still drive steps 0 to 8. One changed: the inbox's plan approval is `[data-act="approve_plan"]`, not the old panel's button.
   - **A question of several choices** (lane 13's note) is answered by its option, then its `[data-choice-send]`.
   - **The preview listener.** The rehearsal's app gets `CLEARED_V2_PREVIEW_PORT` on a free port, as lane 20 asked. 8794 and 8795 join the ports a rehearsal never takes.
2. **The morning rule** (`proof-inbox.ts`).
   - **A session plan gets its Go** after the permissions and before the plan and the releases. A medium or low confidence holds its ticket until the morning, and step 7 would otherwise wait forever.
   - **A knowledge item is left to the owner and counted.** `durations.md` says how many.
   - **A contract item is never answered by the 48-hour proof.** The multi-service proof validates one at its step 3.
   - **The owner who approves** (`PROOF_OWNER_APPROVES=1`) gives the Go too.
3. **Step 7 reads each card before it approves it:** its intent groups with their file counts and its flags, from the item, and what the screen shows of them (`[data-group]`, `[data-flag]`). `durations.md` lists the cards, the session plans (confidence, who gave the Go, how long the gate held) and what was left to the owner.
4. **The skipped step's note** is "skipped: no Mac notifications in this proof (owner decision)", in the steps table and in the notifications section. The header comment says the owner decided it, not that the question is open.
5. **The rehearsal's authors propose a session plan first** (decision 22). This closes the break lane 17 logged.
   - A plan proposed with `propose_session_plan` ends the first turn. The fake adapter commits the author's files at the Go, the first message that starts with "Go:", not when the session starts, so a Change commits nothing.
   - The work turn shows an Edit per file, as the Claude Code adapter maps one, then `report_changes`.
   - Most rehearsal authors are high: the lead's Go starts them "by the plan". The third is medium: it waits through the night, takes the morning's Go, then asks the permission that is denied.
   - Every default author leaves a `HANDOVER.md` with a lesson, so the knowledge module proposes items.
6. **The fake adapter's author rules** (`src/session/adapters/index.ts`, `authorRules`). The first rule whose regular expression matches the start's prompt, and whose service, when it names one, is the start's, gives the files to commit (whole, or one line replaced), the steps and the handover. `{ticket}` is filled in the steps too. A reopened author can commit what its checkout holds (`reopenCommits`): the human's change after Give back. A one-service ticket in a workspace of several gets the author's prompt alone, with no step text (`flow/engine.ts` `start`), so its rule matches the ticket only.
7. **The rehearsal never reaches a real folder or remote.** The fake adapter, already refused unless the state folders are temporary, now also refuses `CLEARED_V2_REPO_URL`, the workspace file, and each service's `dir`, `url`, `broker_socket` and `broker_state`, unless each one is an absolute path inside the temporary folder. A network address is never one. So the committed `examples/workspace.conf` (127.0.0.1:8793, the server's brokers) cannot be given to a rehearsal; it writes its own copy (`rehearsalWorkspace`).
8. **The multi-service proof's driver** (`proof-j2-multi.ts`) takes section 2.2's eleven steps through the browser.
   - **The tickets.** It creates the four tickets from the tower bar, with each one's service chips. Tickets 1 to 3 are the guestbook README's; ticket 4, step 11's, is on the guestbook alone: "The page says how many entries it holds".
   - **The Go.** It gives each of its tickets' session plans its Go from the inbox, as the owner, while it waits. Section 2.2 names no Go, but every author now proposes a plan, and an owner-made ticket has no lead's Go.
   - **The checks of each step:**
     - the steps' kinds and order;
     - the contract's diff naming `severity`;
     - the Browser tab's frame;
     - the integration step done;
     - the landing order and the compatibility line;
     - the ticket Done after the landing;
     - "Rolled back, 2 of 2", with the guestbook reverted before the filter API;
     - the blocked card with no Approve, and its proposal;
     - the terminal on the session's own harness (pull request 230), or the reason it cannot be resumed, recorded; then the Shell beside it, where the two lines are typed; the editor's save, Give back, and the owner's file on the ticket's next card.
   - **The trial environment.** Step 4 loads the guestbook's root page only. Its form posts to `/entries`, which leaves the preview address, and the preview relays no write: a known limit of the Browser tab (issue 213, item 5), not a failure of the step.
   - **The fake's calls** are read through the docker wrapper under its label rule. The session's egress container asks the fake's `/__fake/calls` with the preview's own relay, as the preview asks the page. The real run's only docker commands are these, through the wrapper, which lists by the label and acts on what the list returned.
   - **Each save and its answer are recorded,** and whether the branch carries it. That is the rate issue 226 (item 7) asks the real run's step 11 for.
   - **Its own table,** `renderMultiDurations` in `proof-report.ts`, covers the measured gaps, the steps of each ticket (their cost, and their time from the ledger's `ticket_steps`), the trains in landing order with the gap and the order of the reverts (`trainFacts`, from `release_trains`), the fake's calls, step 11 from the session's journal (`humanFacts`: the lines journaled, the close and its output bytes, the edits, the notice's turn), the saves, the session plans, the owner's gestures and the stand-ins.
   - **The screens.** The proof captures the screens it drove, at 1440, 1280, 768 and 390, light and dark, in the state it left them.
9. **The multi-service rehearsal** (`proof-rehearsal-multi.ts`) runs the real service and app on the fake adapter, on a two-service workspace of its own. It adds three stand-ins to lane 11's:
   - **The locks.** Two stand-in brokers, one socket and one state folder each, both writing the one temporary ledger. The guestbook's watch fails twice when the merged `src/config.ts` turns `PROOF_BREAK_HEALTH` on, then reverts its merge and writes `rollback_pushed`, as the real watch would on `/health`. A `request_rollback` reverts the ticket's newest merge of its repository.
   - **The containers.** `docker` is a stand-in on `PATH`. It answers only these:
     - the labelled lists of a session's containers;
     - their inspection;
     - the service's own programs (the editor's read and save, the checkout at Take over and Give back), run on the session's checkout here;
     - the preview's relay, sent to the trial stand-in;
     - the terminal's Shell (`terminalCommand(SHELL_COMMAND)`), given a stand-in shell, and its end. A harness resumed in the terminal is refused: the fake adapter has none, and its scripted sessions answer that they cannot be resumed.
     It refuses anything else, a run, a build, a push and any other program included, and never runs the real docker. The stand-in shell answers `pwd`, runs `git status` on the checkout, says it does not run `npm test`, and refuses a push for want of a credential. The terminal's real shell script, whose pid file is in the container's `/tmp` and whose end is a `pkill -s`, never runs on this machine.
   - **The trial environment.** A loopback server stands for a session's siblings: the guestbook's page, which checks a sample entry with the filter API's fake at each load, and the fake itself. The fake is `images/fake/fake.ts`, built from the contract the owner validated (`ticket_steps.contract`), one per session.
   - **The forge.** The gh stand-in keeps each pull request's repository: the services of a ticket share their branch name, and the numbers run across the forge, so `pr view`, which names no repository, finds the right one.

**Consequences.**
- **Tests first.** Commit `22e0b27` holds them alone, and each failed on `origin/v2` at `309aea5`: three files at import (`leftForOwner`, `NOTIFICATIONS_SKIPPED_NOTE`, `proof-rehearsal-multi.ts` missing), and the gh stand-in, the reserved ports, the rollback request, the commit at the Go, the author rules and the workspace check in the others. The new file is `test/scripts/proof-rehearsal-multi.test.ts`. `proof-inbox`, `proof-report`, `proof-rehearsal` and `rehearsal-adapter` gained cases.
- **The rehearsal before this lane** (run 0, on `origin/v2`): steps 0 to 6 passed on the React screens with the selectors of pull request 181. The night then held every author without a plan, as lane 17 foresaw: `item 4: ready → put_back → held`.
- **Rehearsals on this server, 2026-10-22, on the fake adapter:**
  - **The 48-hour proof, 3-minute night, notifications skipped:** 9 steps ok, 1 skipped (the notifications, with the owner's note), none failed, the plan done 11 minutes after the goal (on the merged head with pull request 230).
    - The session plans: four high, with the lead's Go at once, and one medium, held 2 min 37 s until the morning's Go.
    - The night left 2 releases, 1 session plan and 2 knowledge items. The morning gave the Go, denied the permission that followed, and approved the 5 cards, each with 1 group.
    - 5 knowledge items were left to the owner.
    - 2 refreshes, highest share 4.5 % (threshold 5 %). Both planted commitments were done, and every "after" was kept.
    - The two scripted login cuts were counted and relaunched.
  - **The multi-service proof, first run:** steps 0 to 8 and 10 passed; 9 and 11 failed. Each failure found a fault, fixed since:
    - **The lock stand-in closed its side of the socket** as soon as the request ended, so an answer written after a git merge or revert never reached the client: `approval/broker.ts` read "invalid release broker reply". The merges still landed, because the train reads the ledger before it asks again (lane 16), which hid the fault since lane 11. The filter API's rollback was refused, and the card said "Rolled back, 1 of 2". The server is now half open.
    - **The proof waited for buttons on a handled card.** It now waits for the item to be shown.
    - **The reopened author's commit named `CLAUDE.md`, which git ignores, in an exclusion,** so the notice's turn failed. It now adds the tracked files the human changed (`git add --update`).
  - **The multi-service proof, final run on the merged head (`bf709b1`):** 12 steps ok (0 to 11), none failed, in about 14 minutes.
    - Ticket 1's steps: the contract, then each service, then the integration. The contract's diff with `severity` was validated 8 s after it was shown. The two service steps ran at once (read from the ledger's sessions). The Browser tab showed the trial page, whose fake answered 1 call.
    - The card: two pull requests, the filter API first, the compatibility line, the `contract` flag. The train landed the filter API, then the guestbook, 45 s apart, each healthy.
    - Ticket 2: the guestbook's watch failed twice, it reverted, then the filter API was rolled back. The card says "Rolled back, 2 of 2" and the ticket is in Todo.
    - Ticket 3: the card was blocked with the proposal and had no Approve.
    - Ticket 4: taken over. The terminal opened on the harness and said it cannot be resumed ("Claude Code cannot be resumed here": the fake adapter's scripted session has no interactive harness, said as such in the step). The Shell button opened the Shell, where `git status` and `npm test` were typed and both journaled; one line of `src/page.ts` saved (200), given back. The notice's turn came 1 s after Give back, and `src/page.ts` was on the ticket's next card.
- **The merge of `origin/v2` with pull request 230** (the web terminal on the session's own harness, Shell beside it). Take over now opens the harness by default, so step 11 records what the terminal showed, then opens the Shell for its two lines; the docker stand-in recognises the Shell by `terminalCommand(SHELL_COMMAND)`, which replaced `TERMINAL_SHELL`. The adaptation is in the merge commit with the matrix's renumbering (this lane's lines became P44 and P45). Both rehearsals were run again after it.
- **Captures and results.** `/tmp/cleared-captures/j2/rehearsal/` and `/tmp/cleared-captures/j2/multi-rehearsal/` hold each step's capture, `result.json` and `durations.md`, mode 644, with the pointer off the buttons. Each rehearsal's folder (`/tmp/cleared-j2-rehearsal-*`, `/tmp/cleared-j2-multi-*`) is kept for reading, its password file removed.
- **The visual loop.** No screen file changed. The multi-service proof captured the tower, the inbox, the lead screen and step 11's session, in the state it left them, at 1440, 1280, 768 and 390, light and dark: `/tmp/cleared-captures/j2/proof-multi-<screen>-<width>-<theme>.png`, 32 files, mode 644. They are a record, not a design pass, and no art director's pass was run.
- **Not proven here:**
  - **The real runs.** These need a model, the forge, the real brokers and watches, the deployments, real containers and siblings, a real fake image, and a login cut. They are the orchestrator's, after this wave: the 48-hour proof first, then the multi-service proof.
  - **The parts the rehearsal's stand-ins replace,** listed under "What the rehearsal replaced" in each `durations.md`.
  - **Step 4 on the real guestbook.** The check is the guestbook's own heading in the Browser tab's frame, which the real page and the stand-in share. The real guestbook calls the filter only on an entry's post, which the preview does not relay, so the real run may read 0 calls from the fake. The step records that count; it does not fail on it.
  - **Step 11's real path assumes** a live author that edits `src/page.ts`, so the file is in the Editor's list before its turn ends, and that the owner's saved line reaches the ticket's card. The rehearsal forces the last part with `reopenCommits`; in the real run it depends on the model committing after the notice. These are assumptions for the orchestrator's run.
  - **Section 8's open unknowns,** for the proof to close: when the author proposes, how long the gate adds in a real night, how many knowledge items a night makes, and how a save during a turn fares.
- **Real run settings.**
  - **The 48-hour proof:** as lane 11's entry says. `PROOF_NOTIFICATIONS` stays `skipped` by default.
  - **The multi-service proof:** `PROOF_PLAYWRIGHT`, `PROOF_CHROME`, `PROOF_PASSWORD_FILE` and `PROOF_LEDGER`. `PROOF_APP_URL` must be the app's loopback address, since the web terminal opens there only. The service runs with the server's copy of `examples/workspace.conf`.
  - **What the real run's step 11 types:** in the session's real container, `npm test` runs the guestbook's tests.
- **Followups.**
  - **Recipes, schedules and asks.** The matrix lines C7, C11 and M9 say "the live run: lane 29". Section 4.6 gives this lane neither a recipe, nor a schedule, nor an ask, and neither proof drives them, so their live run is still open. The orchestrator decides whether a step joins a proof.
  - **The session screen at 390** after Give back reads "Working" while the review has started. It is visible in `proof-multi-session-390-dark.png`, and not this lane's file: issue 233.
- **Files.** All are of the lane's list: `v2/scripts/proof-*.ts` (`proof-j2-multi.ts` and `proof-rehearsal-multi.ts` new), `v2/src/session/adapters/index.ts`, and the tests under `v2/test/scripts/`. Beyond them, only this entry and `docs/v2/requirements-matrix.md`:
  - B6.2p, B6.2m, O8, C2, C8, C10, M2, M3, M5, B5.10f and O1 name this pull request (232).
  - They stay `partial` or `planned` until the real runs.
  - The new lines are P44 (choices 1 to 6 and 8) and P45 (choices 7 and 9); P42 and P43 are pull request 230's, merged first.
- **Checks.**
  - `npm test`: 1204 node tests, 1196 pass and 8 skipped (the browser tests, without `CLEARED_V2_PLAYWRIGHT`), and 183 Vitest tests pass.
  - `npm run typecheck` is green.
  - `npm run guard -- --base origin/v2` is green. It ran without a private-term list (`CLEARED_REPO` unset).
- **Review round 1 (2026-10-22), CHANGES, taken:**
  - the merge of `origin/v2` with pull request 230 (`61b6795`) is pushed; it resolves the conflicts in this log and the matrix, adapts the stand-in and step 11 to the harness-first terminal, and renumbers this lane's matrix lines P44 and P45, which B6.2p and B6.2m cite;
  - both rehearsals ran again on the merged head, and the `durations.md` the pull request quotes are those runs';
  - after the round, step 4 checks the guestbook's own heading in the frame rather than the stand-in's words, reads the fake's count until it answered once or for a minute (0 is recorded, not a failure), and takes the fake's port as the runtime plans it;
  - step 11 says whether Take over attached to the harness or found it unsupported (the fake adapter, said as such), then the Shell with `git status` and `npm test`, the editor's save and Give back;
  - "What the rehearsal replaced" says the live-harness path (Take over attached to Claude Code, then the Shell) is the real run's only;
  - the "Working" label after Give back is issue 233.
- **Checks on the merged head:** `npm test` (1224 node tests, 1216 pass and 8 skipped; 184 Vitest tests pass), `npm run typecheck` and `npm run guard -- --base origin/v2` are green.
- Pull request: 232, against `v2`.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j2-proof-scripts-m2`.

## 2026-10-22: the guestbook's heading in step 4 of the multi-service proof, and the rehearsal's stand-in in the counted form (the author's choices, lane v2-j2-proof-step4-heading)

**Decision.** Step 4 reads the guestbook's heading with one matcher, `/^Guestbook\b/`, which takes the bare "Guestbook" and the counted "Guestbook (N entries)" (`v2/scripts/proof-guestbook-heading.ts`, with `guestbookHeading(n)` for the counted form). The rehearsal's stand-in prints the counted form for an empty guestbook, "Guestbook (0 entries)", so the rehearsal runs the format that the count (ticket 4) adds.

**Consequences.**
- Step 4 no longer fails on the counted heading. The old matcher `/^Guestbook$/` matched only the bare form.
- The rehearsal now carries the counted heading, so an exact-match regression in step 4 would fail the rehearsal.
- What the repository shows, which the run's failure does not confirm:
  - At HEAD, `examples/guestbook/src/page.ts` prints a bare `<h1>Guestbook</h1>`.
  - The counted form appears in the count demo's spec (`v2/scripts/proof-j1.ts`) and in ticket 4 of the rehearsal (`proof-rehearsal-multi.ts`). Ticket 4 runs after step 4, so the repository does not show which heading the failed run's guestbook carried. The matcher change covers both forms; the cause of the step 04 timeout is not confirmed.
- Other text matches in `proof-j2-multi.ts` and `proof-j2.ts` were checked:
  - `proof-j2-multi.ts`: "Rolled back, 2 of 2" (the app's card), "On branch|branch" (the real `git status` output in the terminal), and `src/page.ts` (the guestbook's page, `examples/guestbook/src/page.ts`). None is an exact match against an example page, so none changed.
  - `proof-j2.ts`: "Recommended|Recommandé" and "Undo|Annuler" (the app's own labels). No example-page match.
- The stand-in for the heading is the one place that changed in `proof-rehearsal-multi.ts`.

**Checks.**
- `npm test`: 1227 node tests, 1219 pass and 8 skipped (the browser tests, without `CLEARED_V2_PLAYWRIGHT`), 0 fail; 184 Vitest tests pass.
- `npm run typecheck` is green.

**Author.** Haiku 5.5 (claude-haiku-5-5), lane `v2-j2-proof-step4-heading`.

## 2026-10-22: Owner decisions of 20:33: the reviewer of a multi-service ticket sees the change of every service, and the first real multi-service run

**Decision 1.** On 2026-10-22 at 20:33 (Europe/Paris), the owner decided that the reviewer of a ticket of several services receives the diffs of all the ticket's services, and the contract's change, in its checkout or its prompt, and evaluates the acceptance criteria on the whole. It is a requirement of the multi-repository addition ([complement-multi-depots.md](complement-multi-depots.md)), in the scope of milestone 2. It is not in the lane list of the [milestone 2 plan](milestone-2-plan.md): the lane `v2-j2-review-multi-service-diff` implements it and cites this entry.

**Why.** On 2026-10-22, the real multi-service proof's ticket LOCAL-10 was refused twice. Its reviewer worked in the guestbook's checkout and read the guestbook's diff only, so it judged criteria 1 and 2, the filter API's work, unmet.

**Consequences.** Issue 221, item 4 ("the review starts on the first service only") becomes a requirement. The requirements matrix records the decision as O17, and the author's choices as P46 (the entry below).

The owner took three more decisions at the same time. They are recorded here as relayed; this lane implements none of them.

**Decision 2: the lead's question on LOCAL-10.** The owner answered the lead:
- when the filter's answer has no `severity`, the guestbook falls back to the filter's `ok` field, so the contract stays backward compatible;
- the guestbook records why an entry is held;
- the README is updated;
- the work restarts with a plan.

**Decision 3: the milestone 1 leftovers.**
- LOCAL-3, LOCAL-4 and LOCAL-5 were closed in Cleared as leftovers. Their guestbook pull requests, 2 to 4, were closed unmerged, and their branches are kept.
- LOCAL-7's permission request had already been closed by the service's restart, and LOCAL-7 was closed.

**Decision 4: the first real multi-service run.** It was stopped at step 06. Its logs are kept as `proofmulti-run1`, and LOCAL-10 was closed so that the run can start again cleanly.

- Author: the owner, relayed on 2026-10-22 20:33 (Europe/Paris); written in this log by Opus 5.5 (claude-opus-5-5), lane `v2-j2-review-multi-service-diff`.

## 2026-10-22: the reviewer of a ticket of several services reads every service's change and the contract's (the author's choices, lane v2-j2-review-multi-service-diff)

**Decision.** The lane applies the owner's decision 1 of 20:33 (the entry above). Its choices:

1. **The prompt, not the checkout.** The reviewer keeps the first service's checkout, where it can run that service's tests, and its prompt carries the other services' diffs. Reason: a checkout holding every service would change the session's mounts and runtime (`container/session-runtime.ts`, the adapters), which are not this lane's files. The reviewer would also lose the one service checkout where its tests run today.
2. **Each service's branch is read on the host, as a step's is.** `branchChanges` (`flow/effects.ts`) reads `<workdirs>/<ticket>/<service>` with the fetch the step read already used, now shared as `fetchBranch`. The branch is fetched into a private ref of the service's own checkout, with every object checked. A `.git` that is a link, a linked worktree or has alternates is refused, and no git of the session's runs. Only committed changes count. A service the ticket has no checkout of has no change.
3. **What the reviewer is told** (`reviewPrompt`'s `services` and `contracts`, `flow/prompts.ts`):
   - the ticket's services, and which one is its checkout;
   - that the git commands show that service's change only, and that the others' are in the prompt;
   - the rule: judge each acceptance criterion on the change of every service together. A criterion another service's change meets is met; a criterion no service's change meets is not;
   - a defect outside the checkout is named with its service.
4. **The contract on its own, first.** A contract file the ticket changes (a service's `contract`, as a path of its repository) gets its own block.
   - It is said validated when a `contract` inbox item of the ticket, for that service and path, was approved. Otherwise the prompt says it was not validated in the inbox.
   - Its chunk is taken out of its service's diff, so it is not shown twice.
   - A contract of the reviewer's own service is shown too.
5. **Reference data, cleaned, within a budget.** Each diff goes through the service's cleaner, sits between BEGIN and END lines, and is called reference data written by the ticket's sessions. The diffs shown share 96 KiB (`REVIEW_DIFF_BUDGET`) in equal parts. Each is cut at a line, the cut is said, and the file list stays whole. Reason: the card's 4 MB cut is no prompt's size.
6. **No review on half the change.** When a service's change cannot be read, the review does not start: the ticket goes back to Todo with `review_failed` and the reason. Without the reader (only the tests' configurations lack it), the prompt says each other service's change could not be read. The reviewer is then asked to count as unmet a criterion only that change would meet.
7. **The base.** In a workspace of several services, the reviewer's git commands name its own service's base. Before, they named the workspace's configured base.
8. **One service, unchanged.** A ticket of one service gets the review prompt as before and no branch is read. In a one-service workspace the prompt is the same byte for byte. In a workspace of several, the only difference is the base its git commands name, its service's own (choice 7).

**Files.** The lane is not in the plan's lane list, so it names its own: `v2/src/flow/{engine,prompts,effects}.ts`; under `v2/test/flow/`, `review-services.test.ts` (new), `steps.test.ts`, `effects-services.test.ts` and `support.ts` (the cleaner as a setup option); this log and `docs/v2/requirements-matrix.md`. No screen changed, so there is no visual loop and no capture.

**Tests.**
- `test/flow/review-services.test.ts`:
  - the prompt's text: two services, the contract validated or not, the provider as the checkout, a service with no change, one that could not be read, the budget's cut, the split of a diff by file, and a single service unchanged;
  - on the fake adapter, LOCAL-10's shape (a train ticket on the guestbook and the filter API): the guestbook's reviewer gets the filter API's diff, the contract's diff and its own base;
  - an approved contract item is said validated, an unreadable branch puts the ticket back, the diffs go through the cleaner, and a one-service ticket reads no branch.
- `test/flow/steps.test.ts`: after the steps, the reviewer gets the contract as validated and the filter API's diff.
- `test/flow/effects-services.test.ts`: the real read on two temporary repositories (committed changes only, no checkout means no change, a `commondir` refused).
- On the old code, the steps and effects tests fail, and the new file's four flow tests fail.

**Followups.**
- Issue 221, item 4, is taken in part: the review now sees every service. The other half stays. A review that asks for changes reopens the last author, the integration step's session on the consumer, which cannot fix another service. Such a ticket ends its rounds and goes back to Todo (lane 23's choice 8).
- The reviewer reads the other services' diffs but cannot run their tests; the integration step runs the tests that cross the services.
- No real run: as the brief asked, no proof or rehearsal ran against the live service on 8791 and 8792, where a real proof setup was in progress. The next review of a two-service ticket in the multi-service proof shows the change.

**Checks.**
- `npm test`: 1240 node tests, 1232 pass and 8 skipped (the browser tests, without `CLEARED_V2_PLAYWRIGHT`), 0 fail; 184 Vitest tests pass.
- `npm run typecheck` is green.
- `npm run guard -- --base origin/v2` is green. It ran without a private-term list (`CLEARED_REPO` unset).

- Pull request: 238, against `v2`.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j2-review-multi-service-diff`.
