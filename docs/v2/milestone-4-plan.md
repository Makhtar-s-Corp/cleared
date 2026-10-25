# Cleared v2: milestone 4 plan

Milestone 4 makes the trackers two-way mirrors (issue #381) and cleans v1 out of the core (issue #382): what [keep-and-drop.md](keep-and-drop.md) drops is deleted, no bash script is left, and the JavaScript that stays is strict TypeScript. This page plans both lanes and gives the second its steps.

Written on 2026-10-25 by the author of issue #382 (Opus 5.5), before any code of the milestone. Inputs: issues #381 and #382, [keep-and-drop.md](keep-and-drop.md), the [decisions log](decisions-log.md) (the entries of 2026-10-21 on what v2 keeps and drops, and its latest entries, the ten ideas of 2026-10-25 among them), the [requirements matrix](requirements-matrix.md) (B2.1, B5.8b, B5.9d, B5.11a, B5.11b, B6.4, B6.4p, D11, D17), sections 9 and 10 of [milestone-1-plan.md](milestone-1-plan.md) (the brief named sections 9 and 10 of `milestone-2-plan.md`, which has eight, as earlier lanes noted), and the code at `origin/v2` `2cf78d4`. The brief itself is not in the repository: its section 6 and its line 177 are cited here through the matrix lines that carry them (B6.4 and B6.4p for section 6, B5.11a, B5.11b and D11 for line 177), not quoted.

## 1. Where milestone 4 starts

- **v1 is stopped** (the entry of 2026-10-21): its timers and services are disabled. Its files are still tracked next to `v2/`: 224 files outside `v2/`, `examples/` and `docs/`, of which 39 are `.sh` files and 109 are JavaScript (about 27 000 lines).
- **v2 still runs some of v1.** Every release request of the flow goes through v1's lock:
  - `v2/src/flow/effects.ts` runs `release-request.mjs`;
  - `v2/src/approval/broker.ts` speaks to `serve/release-broker.mjs` on its socket;
  - the broker runs `merge-pr.sh` and `ask-validation.sh`, which source `lib/common.sh` and call `tracker.sh`, `host-state.sh` and `lib/*.mjs`.

  `v2/test/approval/harness.ts` drives those same scripts. v2 also loads `lib/memory/`, `lib/conf.mjs`, `lib/fast-lane.mjs`, `lib/notify/` and `lib/guard/` by address.
- **The matrix lines.** D11, B5.11b and B5.9d are `partial`, with milestone 4 named. B6.4, B6.4p, B2.1, B5.8b and D17 are `later`.

## 2. The lanes

| Lane | Issue | Branch | Owns |
| --- | --- | --- | --- |
| mirrors | #381 | `v2-j4-issue-mirrors` | `v2/` (the mirrors of the v2 ticket store), its docs and its matrix lines (B5.8b, D17) |
| cleanup | #382 | `v2-j4-cleanup` | every tracked file outside `v2/`, `examples/` and `docs/v2/` except the docs pages, `.github/workflows/checks.yml`, the v2 files that name a v1 path they load (only that path changes), and its matrix lines (B5.9d, B5.11b, B6.4 in part, B6.4p, D11, and P229) |

The two lanes run in parallel. The mirrors lane does not edit v1's `lib/tracker/`: what it needs of it, it reads. Both lanes write this page and the log, and the one that merges second merges `origin/v2` and keeps both. The proof of the milestone (B6.4p: a ticket created in the app appears in Linear and the reverse, a human move in Linear wins, `git grep` finds no bash script in the core) runs after both are merged.

## 3. The cleanup lane, in four steps

Each step is one or more commits, and each one leaves these green: the v1 suite (`node --test test/*.test.mjs`, then its TypeScript name), v2's `npm test` and `npm run typecheck`, and `npm run guard -- --base origin/v2`. A step that does not fit stops the lane at the last green commit. The lines it leaves stay `partial` and name what is left; a port is never merged half done.

### Step a: what is dropped and that nothing kept needs

Every `drop` row of keep-and-drop whose files no kept file runs, sources, imports or installs:

- `adapters/`, `lib/contract.sh`, `lib/terminal/`;
- the lane scripts: `spawn-lane.sh`, `lane-run.sh`, `flow-lanes.sh`, `kill-lane.sh`, `tidy-lanes.sh`, `adopt-lane.sh`, `tell-lane.sh`, `push-lane.sh`;
- `when-free.sh`, `check-cli.sh`, `check-lead-model.sh`, `talk.sh`, `talk-run.sh`, `decide.sh`, `confirm-decision.sh`, `digest-note.sh`, `dashboard.sh`, `project-update.sh`, `self-update.sh`;
- `lead-command.mjs`, `serve/lead-actions.mjs`, `serve/check-harness.sh`, `serve/check.sh`;
- `lib/screens.mjs`, `lib/dashboard.mjs`, `lib/lane-message.mjs`, `lib/lanes.mjs` with `lib/tracker/adapters/import-legacy.mjs`;
- the dashboard, lead-model and legacy-import units;
- `prompts/smoke.md`;
- the tests of dropped areas: `test/cleanup`, `codex-host`, `dashboard`, `harness-probe`, `heavy-door`, `lane-commit`, `teams` and `terminal`.

`serve/serve-dashboard.mjs` goes once `allowed` and `TAILSCALE` live in `app/lib/access.mjs`.

The kept files that call a dropped one lose that call, and nothing else:

- **The wake** loses the v1 lead's session, which ran through the terminal and one-shot adapters. The v2 lead session replaces it. `prompts/events/` and `prompts/wake-events.jq` built that session's prompt, so they go with it. The wake's pre-check (`lib/wake.mjs`) stays: the snapshot reads each pull request's size and checks from the state it writes.
- **`review-pr.sh` goes** (decision 3).
- **`host-state.sh`** loses its count of the host's screen tests (`lib/screens.mjs`).
- **The installer** loses the harness probe, the lead bridge's probes, the heavy-command door and the dashboard.
- **The example settings** lose the sections of the dropped features. So do their defaults in `lib/conf.mjs`, and the catalog keys that only the dropped files used.

A test case that only proves a dropped behaviour goes with it, and the log names each file it left.

Kept until a later step, although dropped: `host-state.sh` and `lib/common.sh`. `merge-pr.sh` runs or sources both.

### Step b: v2's release path in Node

The guarded merge (`merge-pr.sh`), the request for agreement (`ask-validation.sh`) and the tracker's entry point (`tracker.sh`, `lib/tracker/adapters/dispatch.sh`, `linear.sh`, `env.sh`, `guard.sh`) are written in Node. Each keeps its arguments, exit codes, messages and state files, so the broker, `release-request.mjs` and v2's broker client change only the path they run. The check of the host that `merge-pr.sh` reads from `host-state.sh` moves into it.

What these scripts did only for dropped features is not carried over, and the log says so: the lane records, the two teams on one ticket, and the screen tests of the host. The no-behaviour-change oracle is the suites that drive the scripts today: v1's `test/merge.test.mjs`, `test/release-broker.test.mjs` and `test/tracker.test.mjs`, and v2's `test/approval/` and `test/release/`. They pass on the Node scripts, and where they change it is the path only.

### Step c: the rest of the kept bash

- **`wake.sh`.** What step a leaves of it moves to Node: the pre-check, the snapshot (`lib/board-collector.mjs`), the heartbeat's wake end, the notifications' dispatch, the release watch's `reconcile`, the outbox, the queued go-lives and the GitHub outage note.
- **`lib/ports.sh` and `serve/install.sh`** are written in Node, without the sudo and bubblewrap steps (dropped).
- **`lib/common.sh` goes last**, once `guard_text` exists in Node.
- **CI.** The `bash -n` step of `checks.yml` goes.

The proof is a v2 test over the whole repository: no tracked file outside `examples/` is a shell script (by extension or by a bash shebang). It extends `v2/test/no-bash.test.ts` to the repository and is B6.4p's `git grep`, run by CI.

### Step d: the kept JavaScript in strict TypeScript

Every remaining `.mjs` and `.js` file outside `v2/` and `examples/`, the `cleared` command and the tests among them, becomes `.ts`. That covers the kept modules under `lib/`, `app/`, `serve/` and `test/`, and `release-request.mjs`. The service worker and the scripts of `app/public/` stay plain JavaScript, as `v2/app/public/sw.js` and `theme.js` do (decision 4).

The rules are v2's: Node runs the files through its type stripping, `erasableSyntaxOnly`, `strict`, and relative imports that name the `.ts` file. A `tsconfig.json` at the root, typechecked in CI, holds the converted files. The v2 files that load a v1 module by address change only that address.

The proof is `v2/test/kept-javascript.test.ts`, extended to the repository: no tracked JavaScript outside `examples/` but the named browser files.

## 4. Decisions this plan takes

1. **"The core" is every tracked file outside `examples/` and `docs/`.** The example projects are projects Cleared works on, not Cleared. A test proves each of the two "no" rules (no bash, no kept JavaScript) on the whole repository, so a `git grep` at the milestone's end only repeats what CI already checks.
2. **v1's files are converted where they are**, not moved under `v2/`. The broker, the units and v2's loads by address name these paths. A move would change every one of them for no behaviour. The decision of 2026-10-21 that keeps v1 next to v2 until milestone 4 ends with this lane only for the removed files.
3. **`review-pr.sh` goes instead of being adapted.** Its keep-and-drop verdict was `adapt` because cross-model review is kept, and v2 keeps it in its reviewer session (B5.7, D8). The script itself only opens a v1 review lane, through `spawn-lane.sh`, so it has no Node form to take. The tests of the guarded merge record their review as the v2 service does (`v2/src/approval/review.ts`).
4. **The browser's scripts stay JavaScript.** `app/public/*.js` are loaded by their address into the page, with no build step, as v2's two browser files are. The B5.11b line already names that exception for v2.
5. **The `proposed` drops are confirmed by issue #382** ("delete everything keep-and-drop.md marks dropped"). The log lists each of them.
6. **No new behaviour.** A port keeps its interface. What is not carried over is named, and every item of it serves a dropped feature.

## 5. Questions for the owner

1. **The v1 passkeys (B5.9d).** In v1, a passkey confirms Clear to land, Send back and turning notifications on. Removing the passkey files without another confirmation leaves those gestures unconfirmed, and the owner's decision of 2026-10-25 (option C) deferred the question to milestone 4. Options: (a) the passkey files stay, and B5.9d stays `partial` until the v1 app is retired or given the v2 password session; (b) the v1 app's gestures use the password session of the v2 app; (c) the v1 app is dropped, since the v2 app replaces it. **Default, applied: (a).** The passkey files are converted with the rest, and nothing about the gestures changes.
2. **The v1 app itself.** `app/` is `adapt` in keep-and-drop ("the app is kept"), but the v2 app serves the same screens. Dropping it would remove about 4 500 lines from step d: the app's 2 500 and its tests' 2 000. **Default, applied: it stays and is converted.** A drop is the owner's decision.

## 6. Out of scope

- The v1 docs pages under `docs/` (`adapt`, not removed): they are rewritten for v2 in a docs lane. This lane only changes the lines that name a removed file as something to run.
- The heartbeat and `cleared status` in the v2 service (B2.1): they stay v1's modules, converted in step d, and run by the Node wake of step c.
- Anything under `v2/` but the paths it loads, the two tests named in steps c and d, and the matrix and the log.
