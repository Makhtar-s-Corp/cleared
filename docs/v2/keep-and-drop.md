# Cleared v2: keep and drop

This is the verdict on every top-level and second-level path that `git ls-files` lists on the `v2` branch at commit `bd496f1` (297 tracked files, 169 paths at those two levels), plus the `docs/v2/` directory this change adds. The decisions behind it are in [decisions-log.md](decisions-log.md).

## How to read the tables

- **Path**: a file, or a directory with a trailing `/`. A directory row covers every tracked file below it. A second-level directory row (for example `lib/tracker/`) also covers its deeper files; its reason names the deeper files that are treated differently.
- **Verdict**:
  - `keep`: the file stays in v2, with at most small edits.
  - `adapt`: the behavior stays, but the file changes substantially or is rewritten in Node.
  - `drop`: the behavior and the file go.
- **Milestone**: when the current file is removed. On an `adapt` file row, `M4` means the whole file is removed in M4 once its kept behavior exists in Node. On an `adapt` directory row, `M4` applies only to the children the reason lists after "M4 removes"; the other children are edited in place and stay. `M4` is milestone 4, the only milestone the decisions name for removals; every removal below is placed there until a milestone plan exists. `-` means the file is not removed.
- **Basis**:
  - `decided`: follows directly from a decision of 2026-10-21 in the decisions log.
  - `proposed`: this review's reading of the code, not decided yet. Confirm or change it before milestone 4.

"Bash" below means a file that starts with `#!/usr/bin/env bash` or is sourced by one. The repository has 39 tracked `.sh` files; v2 drops every bash script of the core, so all 39 are removed in M4. When such a file carries behavior that v2 keeps, its verdict is `adapt` and the reason says what has to exist in Node before it goes.

## Root

| Path | Verdict | Reason | Milestone | Basis |
| --- | --- | --- | --- | --- |
| `.github/` | adapt | Issue templates, pull request template and CI; see the `.github/` rows. | - | proposed |
| `adapters/` | drop | One-shot harness adapters (`claude -p`, `codex exec`); see the `adapters/` rows. | M4 | decided |
| `adopt-lane.sh` | drop | Bash; writes a lane's terminal handle for `tell-lane.sh`, which exists only for the terminal adapters. | M4 | decided |
| `agents.example.conf` | adapt | Sections of dropped features go (`[terminal]`, `[permissions.*]`, `[adapter.claude]`, `[adapter.codex]`, the heavy-command keys of `[lanes]`, and `[dashboard]` if the proposed dashboard drop is confirmed); sections of kept features stay (`[tracker]`, `[memory]`, `[release]`, `[fast_lane]`, `[heartbeat]`, `[guard]`, `[notify]`, `[app]`). | - | decided |
| `app/` | adapt | The app is kept; passkeys are replaced by a password login. See the `app/` rows. | - | decided |
| `ask-validation.sh` | adapt | Bash; posts the approval request on the ticket and records the shown PR versions. Human approval before any deploy is kept, so this request moves to Node. | M4 | decided |
| `check-cli.sh` | drop | Bash; weekly check of how far the adapter CLIs lag their latest release, tied to the one-shot adapters. | M4 | decided |
| `check-lead-model.sh` | drop | Bash; checks the lead's model against the ledger before `wake.sh` starts it. The v2 project lead session needs its own start check if this rule is kept. | M4 | decided |
| `cleared` | adapt | Node CLI: `status`, `app`, `rollback`, `ticket`. All four are kept features; it grows the v2 commands, and `ticket` changes with the local adapter becoming the ticket store. | - | decided |
| `CODE_OF_CONDUCT.md` | keep | Community policy, independent of the architecture. | - | proposed |
| `confirm-decision.sh` | drop | Bash; human confirmation of a decision proposed during a `talk.sh` conversation. Not named in the decisions; goes with `talk.sh` unless v2 keeps the flow in Node. | M4 | proposed |
| `CONTRIBUTING.md` | adapt | Lists bash and jq as test requirements and asks for `bash -n` on shell files; both change when the core is Node only. | - | decided |
| `dashboard.sh` | drop | Bash; writes the static dashboard page from the ledger. The app shows the same data live. | M4 | proposed |
| `decide.sh` | drop | Bash; holds a decision proposed in a conversation until `confirm-decision.sh`. Same fate as `confirm-decision.sh`. | M4 | proposed |
| `digest-note.sh` | drop | Bash; keeps a note for the morning digest. The notes need a Node writer if the digest is kept. | M4 | proposed |
| `docs/` | adapt | v1 documentation; most pages describe dropped parts. See the `docs/` rows. | - | decided |
| `flow-lanes.sh` | drop | Bash lanes: moves lanes forward each minute (1004 lines). | M4 | decided |
| `host-state.sh` | drop | Bash; host status (CI, deployment settling, screen tests) read by the heavy operations lock and the lead. | M4 | decided |
| `kill-lane.sh` | drop | Bash lanes: closes a lane's terminals, worktree and branch. | M4 | decided |
| `lane-run.sh` | drop | Bash lanes: runs a one-shot adapter inside a lane terminal and posts its report. | M4 | decided |
| `lead-command.mjs` | drop | Node, but its only job is to reach `serve/lead-actions.mjs` through `sudo -n -u` the service account (three system accounts mode, sudo). | M4 | decided |
| `lib/` | adapt | Node modules mostly kept; bash files and lane, terminal and adapter modules go. See the `lib/` rows. | - | decided |
| `LICENSE` | keep | License text. | - | proposed |
| `merge-pr.sh` | adapt | Bash; the guarded merge the release broker runs (green checks, reviewed head, human approval of the shown version, merge lock). The deploy lock service is kept, so these checks move to Node. | M4 | decided |
| `project-update.sh` | drop | Bash; fast-forwards the project checkout after a go-live, started by `wake.sh`. | M4 | proposed |
| `prompts/` | adapt | Session prompts; see the `prompts/` rows. | - | proposed |
| `push-lane.sh` | drop | Bash lanes: pushes a lane branch and opens its pull request. v2 sessions need a Node path for this. | M4 | decided |
| `README.md` | adapt | Describes v1 (scripts, Orca terminals, the agents' system account, the Codex container runner); rewritten for v2. | - | decided |
| `release-request.mjs` | keep | Node client of the release broker socket (`request_release`, `request_rollback`, `status`): the deploy lock service. | - | decided |
| `review-pr.sh` | adapt | Bash; opens a review by a model other than the author. Cross-model review is kept, so this moves to Node. | M4 | decided |
| `SECURITY.md` | adapt | Its scope lists the dashboard and permissions of v1; scope text changes, the private reporting channel stays. | - | proposed |
| `self-update.sh` | drop | Bash; fast-forwards the Cleared checkout from `wake.sh`. | M4 | proposed |
| `serve/` | adapt | systemd units, installer, release broker; see the `serve/` rows. | - | decided |
| `spawn-lane.sh` | drop | Bash lanes: opens a worktree and a terminal for one role on one ticket (460 lines). | M4 | decided |
| `talk-run.sh` | drop | Bash; runs the interactive conversation `talk.sh` opened in a terminal. | M4 | decided |
| `talk.sh` | drop | Bash; opens a conversation with the project lead in a terminal. The v2 project lead session replaces it. | M4 | decided |
| `tell-lane.sh` | drop | Bash; types a message into a lane's terminal (terminal adapters). | M4 | decided |
| `test/` | adapt | Most tests drive bash scripts; see the `test/` rows. | - | decided |
| `tidy-lanes.sh` | drop | Bash lanes: closes idle or merged lanes once a day. | M4 | decided |
| `tracker.sh` | adapt | Bash entry point to the tracker (`lib/tracker/adapters/dispatch.sh`). The tracker contract is kept; callers move to `lib/tracker/cli.mjs`. | M4 | decided |
| `wake.sh` | adapt | Bash; the per-minute wake that feeds the heartbeat, the snapshot, notifications and the lead (367 lines). Those are kept, so the wake moves to Node. | M4 | decided |
| `when-free.sh` | drop | Bash; the heavy operations lock (one heavy command at a time on the host). | M4 | decided |

## .github

| Path | Verdict | Reason | Milestone | Basis |
| --- | --- | --- | --- | --- |
| `.github/ISSUE_TEMPLATE/` | keep | `bug.yml` and `idea.yml`, not tied to v1. | - | proposed |
| `.github/pull_request_template.md` | keep | Generic sections and checklist. | - | proposed |
| `.github/workflows/` | adapt | `checks.yml` runs `bash -n` on every `.sh` file; that step goes when the bash scripts go. | - | decided |

## adapters

| Path | Verdict | Reason | Milestone | Basis |
| --- | --- | --- | --- | --- |
| `adapters/claude.sh` | drop | Bash; runs Claude Code one shot (`cli -p`, lines 53 and 74) and translates role permissions. | M4 | decided |
| `adapters/codex.sh` | drop | Bash; runs Codex one shot (`exec --json`, lines 174 and 251), with the `runner = container` mode. | M4 | decided |

## app

| Path | Verdict | Reason | Milestone | Basis |
| --- | --- | --- | --- | --- |
| `app/.gitignore` | keep | Ignores `node_modules/`. | - | proposed |
| `app/DESIGN.md` | keep | Named in the decisions as kept. | - | decided |
| `app/human-write.mjs` | keep | Short-lived writer of the human's gestures to the tracker; unaffected by the login change. | - | proposed |
| `app/lib/` | adapt | M4 removes `webauthn.mjs` and `grant-socket.mjs` (passkeys). Edited in place: `actions.mjs`, `notifications.mjs` and `credentials.mjs` lose their passkey parts for a password login; `session.mjs` and `access.mjs` change with the login. | M4 | decided |
| `app/main.mjs` | adapt | Starts the server; the `cleared app passkey` subcommand goes. | - | decided |
| `app/package.json` | keep | No runtime dependency; `playwright-core` for screenshots only. | - | proposed |
| `app/package-lock.json` | keep | Lock file for `app/package.json`. | - | proposed |
| `app/public/` | adapt | M4 removes `register.html` and `register.js` (passkey registration). Edited in place: `login.*`, `actions.js` and `notify.js`, for the password login. Unchanged: fonts, icons, `style.css`, `sw.js`, `manifest.webmanifest`. | M4 | decided |
| `app/reference/` | keep | Design references `tower.html` and `porthole-phone.html`. | - | proposed |
| `app/screenshots/` | keep | Reference pictures (63 tracked files), not code. Pictures of passkey gestures (for example `gesture-no-passkey.png`) go out of date and are retaken. | - | proposed |
| `app/screenshots-actions.mjs` | adapt | Drives the gestures with a virtual passkey authenticator; switches to the password login. | - | decided |
| `app/screenshots.mjs` | keep | Screenshots from the demonstration data. | - | proposed |
| `app/server.mjs` | adapt | The app server is kept; its sign-in and passkey routes change to a password login. | - | decided |
| `app/sources/` | keep | `live.mjs` reads the snapshot and ledger; `demo.mjs` holds demonstration data. | - | decided |

## docs

| Path | Verdict | Reason | Milestone | Basis |
| --- | --- | --- | --- | --- |
| `docs/adapters.md` | adapt | Documents the bash adapter contract of `lib/contract.sh`; rewritten for the v2 session adapters. | - | decided |
| `docs/app.md` | adapt | Describes passkey-confirmed gestures; changes to the password login. | - | decided |
| `docs/concepts.md` | adapt | Lanes, terminals and daily commands of v1. | - | decided |
| `docs/configuration.md` | adapt | 600 lines; sections for `[terminal]`, `[permissions.*]`, adapters and the heavy-command keys go with their features. | - | decided |
| `docs/fast-lane.md` | keep | Fast lane rules on the real diff are kept. | - | decided |
| `docs/heartbeat.md` | keep | Heartbeat and `cleared status` are kept. | - | decided |
| `docs/memory.md` | keep | Memory is kept. | - | decided |
| `docs/notifications.md` | adapt | Web notifications are kept; turning them on is confirmed by a passkey today. | - | decided |
| `docs/roadmap.md` | adapt | v1 roadmap (tmux terminal adapter, more one-shot harnesses); replaced by the v2 plan. | - | decided |
| `docs/security.md` | adapt | Sections on bubblewrap, sudo, the agents' account and the heavy-command door go; the release lock threat model and the guard stay. | - | decided |
| `docs/trackers.md` | adapt | The local adapter becomes the ticket store; its approval proof today needs two system accounts and a signing key. | - | decided |
| `docs/v2/` | keep | This page and the decisions log, added by this change. | - | decided |

## lib

| Path | Verdict | Reason | Milestone | Basis |
| --- | --- | --- | --- | --- |
| `lib/board-collector.mjs` | keep | Writes the board snapshot the app reads. Today `wake.sh` and `lib/wake.mjs` call it. | - | decided |
| `lib/board-report.mjs` | keep | Extracts a team's report for the snapshot and PR body. | - | decided |
| `lib/board-scrub.mjs` | keep | Filters display text before it enters the snapshot. | - | decided |
| `lib/common.sh` | drop | Bash shared by all scripts (1158 lines): config reads, sudo and bubblewrap launch, permission translation, terminal calls. Its `guard_text` (run the guard from the tracked branch) needs a Node equivalent first. | M4 | decided |
| `lib/conf.mjs` | keep | Reads `agents.conf` and the state directory for every Node module. | - | proposed |
| `lib/contract.sh` | drop | Bash contract of the one-shot adapters. | M4 | decided |
| `lib/dashboard.mjs` | drop | Renders the static dashboard; used only by `dashboard.sh`. The app shows the same data. | M4 | proposed |
| `lib/fast-lane.mjs` | keep | Fast lane rules on the real diff. | - | decided |
| `lib/forge.mjs` | keep | GitHub credential for pushes, PRs, merges and the rollback revert; used by the release broker and `lib/release.mjs`. | - | proposed |
| `lib/git-checkout.mjs` | keep | Safe git environment to read a checkout Cleared does not own; used by `cleared`, the guard, memory, heartbeat and release. | - | proposed |
| `lib/guard/` | keep | Private terms and secrets guard (`private-terms.mjs`, `codex-guard.mjs`). | - | decided |
| `lib/heartbeat.mjs` | keep | Health snapshot, push heartbeat and `cleared status`. | - | decided |
| `lib/i18n/` | keep | The en and fr catalog (`en.json`, `fr.json`). | - | decided |
| `lib/i18n.mjs` | keep | Loader of the catalog, used by the app and the snapshot. | - | decided |
| `lib/lane-message.mjs` | drop | Message filter for `tell-lane.sh` only (terminal adapters). | M4 | proposed |
| `lib/lanes.mjs` | drop | Reads the last report of each bash lane's session log for `wake.sh`. | M4 | proposed |
| `lib/ledger.mjs` | keep | SQLite ledger. | - | decided |
| `lib/limits.mjs` | keep | Subscription windows from session usage; read by the snapshot and the heartbeat. | - | proposed |
| `lib/memory/` | keep | Memory contract, local adapter and CLI. | - | decided |
| `lib/merge.mjs` | keep | Pure checks behind the guarded merge (which approval a PR needs, the reviewer's conclusion). | - | proposed |
| `lib/notify/` | keep | Notification contract, store and `webpush` adapter (web notifications, decided). The `ntfy`, `telegram` and `email` adapters are not named in the decisions: open. | - | decided |
| `lib/notify.mjs` | keep | Notification dispatcher run at the end of each wake. | - | decided |
| `lib/ports.sh` | adapt | Bash; refuses ports 80, 443 and any port in use before install. The rule is kept, so it moves to Node. | M4 | decided |
| `lib/pr-body.mjs` | adapt | Builds a PR body from a team's report and strips machine paths and tokens. Its only caller, `push-lane.sh`, drops, and no v2 component that opens a session's pull request is named yet; it is wired to that component or dropped. | - | proposed |
| `lib/release.mjs` | keep | Post deploy health watch, automatic and manual rollback. | - | decided |
| `lib/reviews.mjs` | adapt | Reviews run and branch authors, read from the ledger and from the session log of a lane worktree; the authorship source changes with v2 sessions. | - | proposed |
| `lib/route.mjs` | keep | Picks a model per role with fallbacks; needed for Claude Code first then Codex and for a reviewer from another model. All callers today are bash. | - | proposed |
| `lib/screens.mjs` | drop | Reads screen tests from the process table for `host-state.sh` (heavy operations lock). | M4 | decided |
| `lib/session-usage.mjs` | adapt | Counts tokens of an interactive session from its CLI log. Its only caller, `talk-run.sh`, drops, and no v2 session runner is named yet; it is wired to that runner or dropped. | - | proposed |
| `lib/terminal/` | drop | Terminal adapters `orca.sh` and `none.sh`. | M4 | decided |
| `lib/tracker/` | adapt | M4 removes the bash files `guard.sh`, `adapters/dispatch.sh`, `adapters/env.sh` and `adapters/linear.sh`, once their behavior is in Node, and `adapters/import-legacy.mjs` (imports old sessions into the ledger) if its proposed drop is confirmed. Edited in place: the contract and the Node adapters; the local adapter becomes the ticket store. | M4 | decided |
| `lib/validation-record.mjs` | keep | Records the PR versions shown when approval is asked; read by the app and the snapshot. | - | proposed |
| `lib/wake.mjs` | adapt | Pre-check of what moved since the last wake; its caller `wake.sh` moves to Node. | - | proposed |

## prompts

| Path | Verdict | Reason | Milestone | Basis |
| --- | --- | --- | --- | --- |
| `prompts/dev.md` | adapt | Development session prompt; refers to worktree lanes and project files the v2 session layout may change. | - | proposed |
| `prompts/events/` | adapt | 22 jq files that turn wake events into the lead's prompt; run from `wake.sh`. The content stays; the jq files are removed when the wake moves to Node. | M4 | proposed |
| `prompts/fast-lane-author.md` | keep | Fast lane author addendum. | - | decided |
| `prompts/fast-lane-review.md` | keep | Fast lane review addendum. | - | decided |
| `prompts/handover.md` | adapt | First wake of an incoming project lead; the project lead becomes a v2 session. | - | proposed |
| `prompts/lane-handover.md` | keep | Asks a session for `HANDOVER.md`, which memory reads for the next briefing. | - | proposed |
| `prompts/release-live.md` | adapt | Project lead wake prompt; changes with the v2 project lead session. | - | proposed |
| `prompts/release.md` | adapt | Observation-only lead prompt; changes with the v2 project lead session. | - | proposed |
| `prompts/review.md` | keep | Cross-model review prompt. | - | decided |
| `prompts/smoke.md` | drop | Dry-run prompt; `git grep smoke` finds no other reference to it. | M4 | proposed |
| `prompts/talk.md` | adapt | Conversation prompt of `talk.sh`; reused for the v2 project lead session. | - | proposed |
| `prompts/wake-events.jq` | adapt | jq dispatcher over `prompts/events/`; moves into Node with the wake. | M4 | proposed |
| `prompts/writeup.md` | keep | Rewrites a team's report for a phone. | - | proposed |

## serve

| Path | Verdict | Reason | Milestone | Basis |
| --- | --- | --- | --- | --- |
| `serve/check-harness.sh` | drop | Bash; probes each model as a lane starts it, through sudo and bubblewrap. | M4 | decided |
| `serve/check.sh` | drop | Bash; checks who can read the static dashboard. | M4 | decided |
| `serve/cleared-app.service` | keep | systemd unit of the app (`cleared app`). | - | proposed |
| `serve/cleared-dashboard-refresh.service` | drop | Runs `dashboard.sh`. | M4 | proposed |
| `serve/cleared-dashboard-refresh.timer` | drop | Every 10 minutes, for the static dashboard. | M4 | proposed |
| `serve/cleared-dashboard.service` | drop | Serves the static dashboard page. | M4 | proposed |
| `serve/cleared-lead-model.service` | drop | Runs `check-lead-model.sh`. | M4 | decided |
| `serve/cleared-legacy-import.service` | drop | Runs `lib/tracker/adapters/import-legacy.mjs`. | M4 | proposed |
| `serve/cleared-legacy-import.timer` | drop | Hourly, for the legacy import. | M4 | proposed |
| `serve/cleared-release-broker.service` | keep | systemd unit of the deploy lock service. | - | decided |
| `serve/cleared-wake.service` | adapt | Its `ExecStart` is `wake.sh`; points to the Node wake. | - | decided |
| `serve/cleared-wake.timer` | keep | Every minute; the heartbeat and status expect a regular wake. | - | proposed |
| `serve/install.sh` | adapt | Bash installer (291 lines): port checks, harness probe, units. Installing the kept services stays, so it moves to Node without the sudo and bubblewrap steps. | M4 | decided |
| `serve/lead-actions.mjs` | drop | Entry point that sudoers allows for the lead (sudo). | M4 | decided |
| `serve/release-broker.mjs` | keep | The deploy lock service: checks the peer UID and runs the guarded merge. | - | decided |
| `serve/serve-dashboard.mjs` | adapt | M4 removes the whole file. The static page server goes, but `app/lib/access.mjs` imports `allowed` and `TAILSCALE` from it, so those move into the app first. | M4 | proposed |

## test

A test of a kept area that drives a dropped script is `adapt`: the cases stay and the harness changes.

| Path | Verdict | Reason | Milestone | Basis |
| --- | --- | --- | --- | --- |
| `test/app-actions.test.mjs` | adapt | App write routes; the passkey ceremony cases change to the password login. | - | decided |
| `test/app-authenticator.mjs` | drop | Software passkey authenticator for the tests. | M4 | decided |
| `test/app-box.mjs` | keep | Scratch project and writer process for the writer tests. | - | proposed |
| `test/app-notify.test.mjs` | adapt | Web notifications kept; the passkey challenge for subscribing changes. | - | decided |
| `test/app-owner-view.test.mjs` | adapt | Owner view kept; references `flow-lanes.sh` and `push-lane.sh`. | - | decided |
| `test/app.test.mjs` | adapt | App routes and access; passkey routes change. | - | decided |
| `test/app-writers-linear.test.mjs` | keep | Linear writer of the human's gestures. | - | proposed |
| `test/app-writers.test.mjs` | adapt | Local and GitHub writers kept; references `serve/install.sh`. | - | proposed |
| `test/cleanup.test.mjs` | drop | `tidy-lanes.sh`, `kill-lane.sh`, `project-update.sh`, `self-update.sh`. | M4 | decided |
| `test/codex-host.test.mjs` | drop | Host Codex sessions and their heavy-command slot. | M4 | decided |
| `test/dashboard.test.mjs` | drop | Static dashboard server. | M4 | proposed |
| `test/fast-lane.test.mjs` | adapt | Fast lane kept (1232 lines); references `spawn-lane.sh`, `lane-run.sh`, `merge-pr.sh`. | - | decided |
| `test/fixtures/` | keep | Guard fixtures (`codex-guard-allow.json`, `private-terms.json`). | - | decided |
| `test/flow.test.mjs` | adapt | 2238 lines over `wake.sh`, `flow-lanes.sh` and others; the `lib/wake.mjs` pre-check cases stay, the lane cases go. | - | proposed |
| `test/forge.test.mjs` | adapt | Forge credentials kept; references `common.sh`, `lane-run.sh`, `install.sh`. | - | proposed |
| `test/git-checkout-planted.test.mjs` | adapt | Refused checkouts kept; references `common.sh`. | - | proposed |
| `test/git-checkout.test.mjs` | adapt | Git read environment kept; references `common.sh`, `install.sh`, `tracker.sh`. | - | proposed |
| `test/guard.test.mjs` | adapt | Guard kept; the cases on role permissions go (permission translation); references `codex.sh`, `common.sh`. | - | decided |
| `test/harness-probe.test.mjs` | drop | Probe of the one-shot adapters and `check-harness.sh`. | M4 | decided |
| `test/heartbeat.test.mjs` | adapt | Heartbeat kept; references `wake.sh` and `when-free.sh`. | - | decided |
| `test/heavy-door.test.mjs` | drop | Heavy operations lock. | M4 | decided |
| `test/lane-commit.test.mjs` | drop | Commits of bash lanes (`lane-run.sh`, `spawn-lane.sh`). | M4 | decided |
| `test/limits.test.mjs` | adapt | Subscription limits kept; references `spawn-lane.sh`, `lane-run.sh`, `tell-lane.sh`. | - | proposed |
| `test/memory.test.mjs` | adapt | Memory kept; references `spawn-lane.sh`, `lane-run.sh`, `tidy-lanes.sh`. | - | decided |
| `test/merge.test.mjs` | adapt | Cross-model review and guarded merge kept; references `review-pr.sh` and `merge-pr.sh`. | - | decided |
| `test/neutral-project.test.mjs` | adapt | Guard salt cases kept; references `common.sh`, `install.sh`, `ports.sh`. | - | decided |
| `test/notify.test.mjs` | adapt | Notifications kept (Web Push encryption, VAPID); references `wake.sh`, `talk.sh`, `install.sh`. | - | decided |
| `test/ports.test.mjs` | adapt | Port rules kept; tests `lib/ports.sh`. | - | decided |
| `test/release-broker.test.mjs` | adapt | Deploy lock service kept; references `merge-pr.sh`. | - | decided |
| `test/rollback.test.mjs` | keep | Rollback and health watch; no bash script involved. | - | decided |
| `test/routing.test.mjs` | adapt | Model routing kept; references `spawn-lane.sh`, `lane-run.sh`, `claude.sh`, `codex.sh`. | - | proposed |
| `test/support.mjs` | adapt | Shared test setup; references 23 bash scripts by name. | - | decided |
| `test/teams.test.mjs` | drop | Two bash lanes on one ticket. | M4 | proposed |
| `test/terminal.test.mjs` | drop | Terminal adapters. | M4 | decided |
| `test/tracker.test.mjs` | adapt | Tracker contract kept; references `linear.sh`, `spawn-lane.sh`, `orca.sh`. | - | decided |
