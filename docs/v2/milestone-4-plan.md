# Cleared v2: milestone 4 plan

Written on 2026-10-25, before the code of milestone 4. The brief's section 6 for milestone 4 is not in this repository; its content is taken from the matrix's lines B6.4 and B6.4p ([requirements-matrix.md](requirements-matrix.md), section C), which repeat it: two-way Linear and GitHub Issues, v1 data reused, every removal of [keep-and-drop.md](keep-and-drop.md) done, no bash in the core; the proof, "a ticket created in the app appears in Linear and the reverse; a human move in Linear wins; `git grep` finds no bash script in the core".

Milestone 4 runs as lanes, each with its issue: the mirrors (issue #381, lane `v2-j4-issue-mirrors`, section 2 below), the cleanup (issue #382: the dropped files, the bash of the core, the kept JavaScript in strict TypeScript) and the import of v1's data (issue #385, lane `v2-j4-v1-import`, section 3 below). Each lane adds its own section to this file. `milestone-2-plan.md` has no sections 9 and 10; the conventions followed are those of sections 9 and 10 of [milestone-1-plan.md](milestone-1-plan.md), as the lanes of milestone 3 noted: a lane fills its own module, never `main.ts`; a screen's words live in its catalogs; `api/types.ts` is not changed on the side.

## 1. The proof, the mirrors' part

B6.4p, steps 1 to 3 (step 4, `git grep`, is the cleanup's):

1. A ticket created in the app appears in Linear, in the state it has in the app, at the next pass of the mirror.
2. An issue created in Linear appears in the app as a ticket, in the state it has in Linear.
3. A person moves the issue in Linear while an agent moves the ticket in the app, between two passes: after the pass both sides hold the person's state.

Linear is a fake server here, never a real account and never a real key (the issue's rule): the steps run in `test/tickets/mirror-proof.test.ts` on the real ticket store over a fake Linear GraphQL server on loopback. The same steps are run against GitHub Issues, faked in the tests and once for real on the example repository `cleared-example-guestbook`, the run quoted in the pull request. A real Linear trial is the owner's.

## 2. The mirrors lane (`v2-j4-issue-mirrors`, issue #381)

### 2.1 Context

The v2 ticket store lives in the app (`tickets/local-store.ts`, decision 11 of milestone 1), and D17 asks for it to be kept in step with Linear and GitHub Issues, with the app alone sufficing when nothing is configured. v1 had Linear and GitHub adapters (`lib/tracker/`) but as the tracker itself, not as mirrors of the app's store, and its bash Linear adapter is one of the files milestone 4 removes. This lane adds a mirror that polls each configured tracker, applies the changes both ways and settles a conflict by a written rule.

### 2.2 What exists at the end, and how it is proven

- `src/tickets/mirror.ts`: the mirror's tables, its pass, the conflict rule as a pure function, its settings. `src/tickets/mirror-github.ts` and `src/tickets/mirror-linear.ts`: the two trackers behind one small interface. `src/tickets/messages/mirror.{en,fr}.json`: the words it writes.
- The tickets module (`modules/tickets.ts`) starts the mirror's timer at the service's start and stops it at its stop; with nothing configured it starts nothing.
- [docs/v2/mirrors.md](mirrors.md): the settings, what is mirrored and what is not, and the conflict rule in full. `v2/README.md` points to it.
- Proven by `test/tickets/mirror-rule.test.ts` (the rule, case by case), `test/tickets/mirror.test.ts` (the pass on the real store with a tracker in memory), `test/tickets/mirror-github.test.ts` and `test/tickets/mirror-linear.test.ts` (each tracker against its fake HTTP server), `test/tickets/mirror-proof.test.ts` (section 1), and the real GitHub run quoted in the pull request.

### 2.3 The conflict rule

The rule, as `docs/v2/mirrors.md` writes it for a person:

1. For each ticket and each tracker, the mirror keeps the last state both sides agreed on. At each pass it reads the state of each side.
2. Only one side changed since: that side's state is written on the other.
3. Both changed to the same state: nothing to write.
4. Both changed to different states: the change made by a person wins over the change made by an agent, whatever their times. Between two changes made by people, the later one wins. Between two changes made by agents, the app's wins. Two changes at the same second: the app's wins.
5. Who made a change. In the app: a person when the history row is the owner's signed row, an agent otherwise (the service, the flow, the lead). On the tracker: an agent when the event's actor is a bot or an integration, or when the actor is unknown; the mirror's own writes are recognised and never count as a change; any other actor is a person.
6. What a tracker never does through the mirror, whoever made the change. It never approves: a move to the go state ("Ready to Ship") is the owner's approval, given in the app only (B5.3c), so it is not applied, the tracker is put back to the app's state and a comment says why. It never moves a ticket the owner approved, or one whose release is landing: same answer. It never starts a session by itself: a ticket moved to Todo on the tracker waits in the app's Todo until someone starts it in the app (a ticket of a plan the owner approved goes on as the plan says). A tracker in a state the app does not have is not written over by an agent's change, only by the owner's.
7. A person's move on the tracker of a ticket the flow is working on wins too: the flow sets the ticket aside first (its sessions stop, nothing of it waits in the inbox), as the app's Set aside does, then the person's state is written.

### 2.4 Decisions this lane takes

- **Polling, no webhook.** A webhook needs an address the tracker can reach, and the brief forbids tunnels and new listeners. The mirror reads each tracker every minute by default (`CLEARED_V2_MIRROR_POLL_SECONDS`, at least 15).
- **What is mirrored.** The creation of a ticket, both ways (title, body; GitHub's labels), and its state, both ways. Not mirrored: later edits of the title and the body (the app has no edit of them, and the approval binds them through `content_hash`), comments, assignees, the trackers' states that are not the six of the app (Linear's Backlog, Triage, Canceled; an issue closed as not planned). Only tickets and issues created after the mirror's first pass are mirrored, so turning it on does not copy a project's whole history.
- **States.** Linear: the team's workflow states, matched by name to the app's six. GitHub: one label `status:<state>` on an open issue, as v1's GitHub adapter did; Done is the issue closed as completed, with its `status:Done` label.
- **Where.** GitHub: the repository of the ticket's first service, else of the workspace's first service; an issue of a service's repository becomes a ticket on that service when the workspace has several. Linear: one team for the workspace.
- **Who writes in the app.** A change the mirror applies is written as `agents`, id `cleared-mirror`, never as a signed human row: a tracker cannot forge the owner's signature. Who made it on the tracker, person or agent, with the tracker's name and time, is kept in the mirror's own table and read back by the rule.
- **Secrets.** The tokens are read from files (`CLEARED_V2_MIRROR_GITHUB_TOKEN_FILE`, `CLEARED_V2_MIRROR_LINEAR_TOKEN_FILE`), never from the environment, and never written in a log or an error. An API address other than the trackers' own must be on loopback (the tests' fakes).
- **Language.** The comment the mirror writes on a tracker follows `CLEARED_V2_APP_LANGUAGE` (French by default), as the chat's replies do; the note on a ticket set aside follows it too.
- **Matrix lines.** P230 (the mirror's pass and its settings), P231 (the conflict rule), P232 (what a tracker never does through the mirror); B5.8b, D17, B6.4 and B6.4p updated.

### 2.5 Out of scope

Comments and later edits of title and body both ways; Linear's labels, projects and assignees; a real Linear account; webhooks; a screen that shows a ticket's mirrors (the mirror's state is in its tables and its log lines); mapping a tracker's people to the app's users, which a session started from the tracker would need; v1 data reused for estimates (B6.4's other part).

### 2.6 Files this lane owns

`v2/src/tickets/mirror*.ts`, `v2/src/tickets/messages/mirror.*.json`, `v2/test/tickets/mirror*.test.ts` and their fakes, `docs/v2/mirrors.md`; one function added to `modules/tickets.ts` (start and stop); one optional argument added to `FlowEngine.setAside` (the note's words); its lines of the matrix and its log entry.

### 2.7 Unknowns, and who closes them

| Unknown on 2026-10-25 | Closed by |
| --- | --- |
| How Linear shows an OAuth application acting as itself (`actor=app`) in an issue's history: `botActor`, or the user | the owner's real trial; until then such an event reads as an agent's |
| Whether GitHub's issue events lag behind the issue's labels | the real GitHub run of this lane; a stale read of the mirror's own write is not a change either way |
| A crash between the tracker's creation of an issue and the mirror's record of it creates the issue again at the next pass | not closed: named in `docs/v2/mirrors.md` |

## 3. The v1 import lane (`v2-j4-v1-import`, issue #385)

### 3.1 Context

B6.4 asks for v1's data to be reused: its memory, and its ticket history for the estimates. v2 opens a ledger in v1's format (decision 11 of milestone 1), but v1 was stopped without an archive (log entry of 2026-10-21), and a v2 service started on a state folder of its own has none of v1's rows: its plans are estimated from the defaults until three v2 tickets of a size are done, and the decisions the owner approved in v1 are proposals again. This lane adds a command that reads a v1 ledger, never writing it, and brings into v2's ledger what v2 can use, once, however many times it is run.

### 3.2 What exists at the end, and how it is proven

- `src/import/v1.ts`: the reading of a v1 ledger; `src/import/apply.ts`: what it would bring and, with `--apply`, what is written in v2's ledger; `src/import/samples.ts`: the samples' table and its reading by the estimates; `src/import/report.ts` and `src/import/messages/import.{en,fr}.json`: its words. `src/cli/import-v1.ts`, run as `npm run import-v1 -- --from <v1 ledger.db>`: a dry run by default, `--apply` to write, as `repair-services` does.
- The plans' estimates (`lead/plans/estimates.ts`) count the imported tickets with v2's own.
- Proven by `test/import/v1.test.ts` (the reading, on fixtures written by v1's own code), `test/import/apply.test.ts` (dry run, apply, a second apply, the same file refused, the v1 file untouched), `test/import/memory.test.ts` (an approved decision briefed by v2 after the import, and the cases where it is not), `test/import/cli.test.ts` (the command, in French and in English), `test/import/catalog.test.ts`, and `test/lead/plans/estimates.test.ts` (samples without a cost).

### 3.3 What is imported

1. **The ticket history.** One sample per v1 ticket that v1 measured when its pull request merged (its last `ticket_measured` event), for the workspace the service is configured with:
   - **The lane**: the event's own, fast or full.
   - **The minutes**: from the ticket's first run at or after its Todo time (else its Todo time) to its merge, less the time the owner took to answer (`human_wait_min`). v2 counts from the author's first start to the release request, less the owner's waits; v1 has no release request event, so the few minutes from the owner's answer to the merge are counted too.
   - **The size**: v1 had no sizes. A `size:<s>` label on the v1 ticket wins when there is one; else the lines its merged pull request changed (`runs.lines_changed`): 20 or fewer xs, 100 or fewer s, 400 or fewer m, more l. A ticket with neither has no size and is not a sample.
   - **The tokens**: the sum of its runs' tokens, kept and said, not used by the estimates.
   - **No money.** v1 kept euros: either the CLI's dollars times a rate v1 does not keep, or tokens times a price table, which is not a real source. An imported sample has no cost; the estimates take the median cost of the samples that have one, and the default when fewer than three do. A default cost is never said to come from history: the plan's panel says "Estimates from {n} similar tickets" from three samples, so the count is then the samples that have a cost, and the panel says "Default estimates".
2. **The approved decisions.** A decision file the owner approved in v1 stays approved in v2 when all of these hold: v1's entry is approved and v1 holds its `memory_approved` event; that event's owner is the owner v2's settings name (`[tracker] owner_id`); the file, at the same path in v2's checkout, has the same text committed and on disk as the text v1 approved. Then the import approves v2's entry through lib/memory, in a child process, as the knowledge module does, and keeps v1's record (who, when) in its own table. Anything else stays a proposal, as editing a file does in v1.

Not imported: the files' entries themselves (lib/memory indexes them from the checkout); the handovers, scoped to a v1 ticket id that v2 gives to another ticket (`LOCAL-<n>` from 1 in both ledgers), so one would brief an unrelated ticket; proposals; v1's sessions, runs and events, which no v2 screen reads; the tickets themselves, which would appear on the board and in the mirrors.

### 3.4 Decisions this lane takes

- **Read-only on v1.** The v1 ledger and its write-ahead log are copied into a private temporary folder and read there: SQLite opened read-only on a ledger in WAL mode still creates its `-shm` and `-wal` files beside it. The copy is removed at the end. The command refuses a v1 ledger that is v2's own file.
- **Idempotent.** A sample is keyed by the workspace and the v1 ticket; an approval is not made twice. A second `--apply` writes nothing and says so. A v1 ticket measured again after the first import keeps its first sample, and a ticket number already imported from another measure is said as such, never as already imported.
- **One v1 ledger per workspace.** v1 kept a ledger per project; the import brings one into the workspace, read against the workspace's checkout (its first service's), where the workspace's memory reads its files.
- **Its own tables.** `v1_ticket_samples` and `v1_memory_approvals`, created by the command; the estimates read the first one when it exists.
- **The dry run** says what `--apply` would write and why each skipped item is skipped, in counts, durations a person reads and ticket ids; never a decision's text.
- **Language.** `CLEARED_V2_APP_LANGUAGE`, French by default, as the service's other words.
- **Fixtures.** Written in the tests by v1's own code (`lib/ledger.mjs`, `lib/memory`, the local tracker), with invented tickets and texts. No real v1 ledger is read in this lane.
- **Matrix lines.** P233 (the command), P234 (the samples and the estimates), P235 (the approved decisions); B6.4 updated.

### 3.5 Out of scope

v1's handovers, events and sessions; several v1 ledgers into one workspace (a second one's tickets of numbers already imported are left out and said, and its decisions, read against the first service's checkout, come out missing or changed, never filed in another service's level); a v1 tracker other than the ledger's (a Linear ticket's labels are not read: its size comes from its lines); a screen for the import; the import of a v2 ledger into another; the removal of v1's files, the cleanup lane's.

### 3.6 Files this lane owns

`v2/src/import/`, `v2/src/cli/import-v1.ts`, `v2/test/import/`; the `import-v1` script in `v2/package.json`; the samples read in `lead/plans/estimates.ts` (`historyOf`, and the cost's median over the samples that have one); a row in `v2/README.md`; its lines of the matrix and its log entry.

### 3.7 Unknowns, and who closes them

| Unknown on 2026-10-25 | Closed by |
| --- | --- |
| Whether the first piloted project's v1 ledger holds `ticket_measured` events and lines changed for most of its tickets (the samples need both) | the owner's dry run on that ledger; its counts say it, and nothing is written |
| Whether the size thresholds (20, 100, 400 lines) match the sizes the lead gives | the owner (question in the log entry, default applied) |
| A v1 ledger written while it is copied | not closed: v1 is stopped (D22), and the command is run on a stopped v1 |

## 4. The cleanup lane (`v2-j4-cleanup`, issue #382)

This section was written on 2026-10-25 by the author of issue #382 (Opus 5.5), before the lane's code. Inputs: issues #381 and #382, [keep-and-drop.md](keep-and-drop.md), the [decisions log](decisions-log.md) (the entries of 2026-10-21 on what v2 keeps and drops, and its latest entries, the ten ideas of 2026-10-25 among them), the [requirements matrix](requirements-matrix.md) (B2.1, B5.8b, B5.9d, B5.11a, B5.11b, B6.4, B6.4p, D11, D17), sections 9 and 10 of [milestone-1-plan.md](milestone-1-plan.md) (the brief named sections 9 and 10 of `milestone-2-plan.md`, which has eight, as earlier lanes noted), and the code at `origin/v2` `2cf78d4`. The brief itself is not in the repository: its section 6 and its line 177 are cited here through the matrix lines that carry them (B6.4 and B6.4p for section 6, B5.11a, B5.11b and D11 for line 177), not quoted.

### 4.1 Where the cleanup starts

- **v1 is stopped** (the entry of 2026-10-21): its timers and services are disabled. Its files are still tracked next to `v2/`: 224 files outside `v2/`, `examples/` and `docs/`, of which 39 are `.sh` files and 109 are JavaScript (about 27 000 lines).
- **v2 still runs some of v1.** Every release request of the flow goes through v1's lock:
  - `v2/src/flow/effects.ts` runs `release-request.mjs`;
  - `v2/src/approval/broker.ts` speaks to `serve/release-broker.mjs` on its socket;
  - the broker runs `merge-pr.sh` and `ask-validation.sh`, which source `lib/common.sh` and call `tracker.sh`, `host-state.sh` and `lib/*.mjs`.

  `v2/test/approval/harness.ts` drives those same scripts. v2 also loads `lib/memory/`, `lib/conf.mjs`, `lib/fast-lane.mjs`, `lib/notify/` and `lib/guard/` by address.
- **The matrix lines.** D11, B5.11b and B5.9d are `partial`, with milestone 4 named. B2.1 is `later`. B5.8b, D17, B6.4 and B6.4p are the mirrors lane's too (pull request 384).

### 4.2 The two lanes and their files

| Lane | Issue | Branch | Owns |
| --- | --- | --- | --- |
| mirrors | #381 | `v2-j4-issue-mirrors` | `v2/` (the mirrors of the v2 ticket store), its docs and its matrix lines (B5.8b, D17) |
| cleanup | #382 | `v2-j4-cleanup` | every tracked file outside `v2/`, `examples/` and `docs/v2/` except the docs pages, `.github/workflows/checks.yml`, the v2 files that name a v1 path they load (only that path changes), and its matrix lines (B5.9d, B5.11b, B6.4 in part, B6.4p, D11, and P236) |

The two lanes ran in parallel; the mirrors lane merged first (pull request 384), and this lane merged `origin/v2` after it, keeping both sections of this page. The mirrors lane does not edit v1's `lib/tracker/`: what it needs of it, it reads. The proof of the milestone (B6.4p: a ticket created in the app appears in Linear and the reverse, a human move in Linear wins, `git grep` finds no bash script in the core) runs after both are merged.

### 4.3 The four steps

Each step is one or more commits, and each one leaves these green: the v1 suite (`node --test test/*.test.mjs`, then its TypeScript name), v2's `npm test` and `npm run typecheck`, and `npm run guard -- --base origin/v2`. A step that does not fit stops the lane at the last green commit. The lines it leaves stay `partial` and name what is left; a port is never merged half done.

#### Step a: what is dropped and that nothing kept needs

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
- **`review-pr.sh` goes** (section 4.4, decision 3).
- **`host-state.sh`** loses its count of the host's screen tests (`lib/screens.mjs`).
- **The installer** loses the harness probe, the lead bridge's probes, the heavy-command door and the dashboard.
- **The example settings** lose the sections of the dropped features. So do their defaults in `lib/conf.mjs`, and the catalog keys that only the dropped files used.

A test case that only proves a dropped behaviour goes with it, and the log names each file it left.

Kept until a later step, although dropped: `host-state.sh` and `lib/common.sh`. `merge-pr.sh` runs or sources both.

#### Step b: v2's release path in Node

The guarded merge (`merge-pr.sh`), the request for agreement (`ask-validation.sh`) and the tracker's entry point (`tracker.sh`, `lib/tracker/adapters/dispatch.sh`, `linear.sh`, `env.sh`, `guard.sh`) are written in Node. Each keeps its arguments, exit codes, messages and state files, so the broker, `release-request.mjs` and v2's broker client change only the path they run. The check of the host that `merge-pr.sh` reads from `host-state.sh` moves into it.

What these scripts did only for dropped features is not carried over, and the log says so: the lane records, the two teams on one ticket, and the screen tests of the host. The no-behaviour-change oracle is the suites that drive the scripts today: v1's `test/merge.test.mjs`, `test/release-broker.test.mjs` and `test/tracker.test.mjs`, and v2's `test/approval/` and `test/release/`. They pass on the Node scripts, and where they change it is the path only.

#### Step c: the rest of the kept bash

- **`wake.sh`.** What step a leaves of it moves to Node: the pre-check, the snapshot (`lib/board-collector.mjs`), the heartbeat's wake end, the notifications' dispatch, the release watch's `reconcile`, the outbox, the queued go-lives and the GitHub outage note.
- **`lib/ports.sh` and `serve/install.sh`** are written in Node, without the sudo and bubblewrap steps (dropped).
- **`lib/common.sh` goes last**, once `guard_text` exists in Node.
- **CI.** The `bash -n` step of `checks.yml` goes.

The proof is a v2 test over the whole repository: no tracked file outside `examples/` is a shell script (by extension or by a bash shebang). It extends `v2/test/no-bash.test.ts` to the repository and is B6.4p's `git grep`, run by CI.

#### Step d: the kept JavaScript in strict TypeScript

Every remaining `.mjs` and `.js` file outside `v2/` and `examples/`, the `cleared` command and the tests among them, becomes `.ts`. That covers the kept modules under `lib/`, `app/`, `serve/` and `test/`, and `release-request.mjs`. The service worker and the scripts of `app/public/` stay plain JavaScript, as `v2/app/public/sw.js` and `theme.js` do (section 4.4, decision 4).

The rules are v2's: Node runs the files through its type stripping, `erasableSyntaxOnly`, `strict`, and relative imports that name the `.ts` file. A `tsconfig.json` at the root, typechecked in CI, holds the converted files. The v2 files that load a v1 module by address change only that address.

The proof is `v2/test/kept-javascript.test.ts`, extended to the repository: no tracked JavaScript outside `examples/` but the named browser files.

### 4.4 Decisions this lane takes

1. **"The core" is every tracked file outside `examples/` and `docs/`.** The example projects are projects Cleared works on, not Cleared. A test proves each of the two "no" rules (no bash, no kept JavaScript) on the whole repository, so a `git grep` at the milestone's end only repeats what CI already checks.
2. **v1's files are converted where they are**, not moved under `v2/`. The broker, the units and v2's loads by address name these paths. A move would change every one of them for no behaviour. The decision of 2026-10-21 that keeps v1 next to v2 until milestone 4 ends with this lane only for the removed files.
3. **`review-pr.sh` goes instead of being adapted.** Its keep-and-drop verdict was `adapt` because cross-model review is kept, and v2 keeps it in its reviewer session (B5.7, D8). The script itself only opens a v1 review lane, through `spawn-lane.sh`, so it has no Node form to take. The tests of the guarded merge record their review as the v2 service does (`v2/src/approval/review.ts`).
4. **The browser's scripts stay JavaScript.** `app/public/*.js` are loaded by their address into the page, with no build step, as v2's two browser files are. The B5.11b line already names that exception for v2.
5. **The `proposed` drops are confirmed by issue #382** ("delete everything keep-and-drop.md marks dropped"). The log lists each of them.
6. **No new behaviour.** A port keeps its interface. What is not carried over is named, and every item of it serves a dropped feature.

### 4.5 Questions for the owner

1. **The v1 passkeys (B5.9d).** In v1, a passkey confirms Clear to land, Send back and turning notifications on. Removing the passkey files without another confirmation leaves those gestures unconfirmed, and the owner's decision of 2026-10-25 (option C) deferred the question to milestone 4. Options: (a) the passkey files stay, and B5.9d stays `partial` until the v1 app is retired or given the v2 password session; (b) the v1 app's gestures use the password session of the v2 app; (c) the v1 app is dropped, since the v2 app replaces it. **Default, applied: (a).** The passkey files are converted with the rest, and nothing about the gestures changes.
2. **The v1 app itself.** `app/` is `adapt` in keep-and-drop ("the app is kept"), but the v2 app serves the same screens. Dropping it would remove about 4 500 lines from step d: the app's 2 500 and its tests' 2 000. **Default, applied: it stays and is converted.** A drop is the owner's decision.

### 4.6 Out of scope

- The v1 docs pages under `docs/` (`adapt`, not removed): they are rewritten for v2 in a docs lane. This lane only changes the lines that name a removed file as something to run.
- The heartbeat and `cleared status` in the v2 service (B2.1): they stay v1's modules, converted in step d, and run by the Node wake of step c.
- Anything under `v2/` but the paths it loads, the two tests named in steps c and d, and the matrix and the log.

## 5. The mirrors' follow-ups (`v2-j4-mirror-followups`, issue #386)

Section 4 is the cleanup lane's (issue #382, pull request 388).

### 5.1 Context

Pull request 384 mirrors a ticket's creation and its state, and left three things out (section 2.5, and `docs/v2/mirrors.md`, "What is proven, and what is left"): the comments, the later edits of the title and the description, and an open page of the app, which does not redraw when the mirror writes in the store. This lane adds the three on the same mirror, with the same conflict rule for the edits, against GitHub's example repositories and a fake Linear server only.

### 5.2 What exists at the end, and how it is proven

- **Comments, both ways.** Each comment of a mirrored ticket is written once on each of its trackers, and each comment of a mirrored issue once in the app. The tracker's comments are read by their own time (GitHub: the repository's issue comments since the last read; Linear: the team's comments since then), not through the issue's last change.
- **Edits of the title and the description, both ways**, one field at a time, settled by `decide()` (section 2.3) as the state is: against the value both sides last agreed on.
- **Live redraw.** Each write the mirror makes in the app says the ticket on the change stream (`api/events.ts`, `ChangeHub.say('ticket', id)`), so an open board or ticket refetches it. No change to `api/types.ts`: the `ticket` kind already refetches the ticket, the list, its steps and the plans.
- Proven by new cases in `test/tickets/mirror.test.ts` (the pass on the real store with the tracker in memory), `mirror-github.test.ts` and `mirror-linear.test.ts` (each tracker against its fake), `mirror-proof.test.ts` (a comment and an edit each way on both fakes), `mirror-catalog.test.ts`, `test/tickets/contract.test.ts` (the store's edit), `test/tickets/services.test.ts` (the tables), and the real run on the example repository, quoted in the pull request.

### 5.3 The rules

1. **What a comment carries.** Its text, with a first line that says who wrote it and where: on a tracker, "{who}, in Cleared:" for the owner's signed comment, "A user of Cleared:" for another user's, "Cleared:" for the service's; in the app, "{who}, on {tracker}:". A comment that came from a tracker is written in the app as the mirror (`agents`, `cleared-mirror`), never as a signed person, so it never counts as the owner's line. It goes on to the other trackers as it is, never back to the one it came from. Images (`local://capture/`) are not sent.
2. **Which comments.** All the app's comments of a mirrored ticket, the service's notes included: today the app shows no comment and its users write none, so the service's notes and v1's tools are the only writers, and the tracker's reader learns from them why a ticket moved. A question for the owner, default applied (the log entry).
3. **Each once.** The mirror keeps each comment's pair, the app's id and the tracker's, in `mirror_comments`, its own comments on a tracker (the put-backs) included, so none comes back. A link the mirror made before this lane's code ran starts from the first pass after it: comments older than that are not copied, either way.
4. **Edits.** Per link and field, the value both sides last agreed on is kept (`mirror_fields`). One side changed: it is written on the other. Both changed: `decide()`, a person's change over an agent's, the later of two people's, the app's between agents or at the same second.
5. **Who made an edit.** On GitHub, a title's change is the issue's `renamed` event, with its actor. GitHub's issue events have no event for a change of the description, so its author is not named, and the rule reads it as an agent's (2.3, rule 5). On Linear, the issue's history (`fromTitle`, `toTitle`, `updatedDescription`) with its actor. In the app, the mirror is the only writer of a title or a description: who made the value it wrote is kept in `mirror_edits`, as `mirror_applied` keeps it for a state.
6. **What a tracker never edits.** A ticket the owner approved, until it is released: the tracker's field is put back to the app's, with a comment, as a move is (2.3, rule 6). A title left empty is not written in the app.
7. **What an edit does to the creator's signature.** The store's `content_hash` is written on the creation row only, never on the approval's: section 2.4 says the approval binds the title and the body, and the code does not. A changed title or description therefore makes the creation row of a ticket the owner wrote read as `other` (`LocalTicketStore.#verified`): the text is no longer the one the owner signed. Nothing in v2 reads a ticket's creator (the readers of `history` filter on the go state), and the approval is untouched.

### 5.4 Decisions this lane takes

- **New tables, not new columns.** `CREATE TABLE IF NOT EXISTS` does not add a column to the `mirror_links` 384 made: `mirror_fields` (the agreed value and the tracker's last read, per link and field), `mirror_edits`, `mirror_comments` and `mirror_followed` (the time this code first followed a link) are new tables of the tickets module.
- **The store's edit.** `TicketStore.edit(id, { title?, body? }, by)`, on `LocalTicketStore` and `MemoryTicketStore`: it writes `tracker_tickets` and its `updated_at`, no history row (the history is the states'). The mirror is its only caller.
- **The tracker's interface.** `Tracker.commentsSince(since)`, `Tracker.edit(id, fields)`, and `Tracker.comment` returns the comment's id; `TrackerIssue.edits` lists who changed a field, as `changes` does for the state.
- **The redraw.** An optional `changed(ticket)` in the mirror's dependencies, wired by `modules/tickets.ts` to the engine's change hub.
- **Language.** The comments' first lines and the edit's refusal follow `CLEARED_V2_APP_LANGUAGE`, French by default, as the mirror's other words.
- **Matrix line.** P237 (P236 is the cleanup's); B5.8b, P230 and `docs/v2/mirrors.md` updated.

### 5.5 Out of scope

A comment edited or deleted after it was mirrored; a screen of the app that shows comments, or that edits a title or a description; the labels' later edits; a real Linear account; a webhook.

### 5.6 Files this lane owns

`v2/src/tickets/mirror*.ts`, `v2/src/tickets/messages/mirror.*.json`, `v2/test/tickets/mirror*.test.ts` and the fakes; the `edit` of `tickets/contract.ts` and `tickets/local-store.ts` and its case in `test/tickets/contract.test.ts`; the wiring in `modules/tickets.ts`; the pinned tables in `test/tickets/services.test.ts`; `docs/v2/mirrors.md`; its matrix line and its log entry.

### 5.7 Unknowns, and who closes them

| Unknown on 2026-10-25 | Closed by |
| --- | --- |
| Whether GitHub records who changed an issue's description anywhere its REST API reads | closed by the real run of this lane, on the example repository: neither the issue's events nor its timeline hold an event for it, a new title is `renamed` |
| Whether Linear's `Comment.botActor` names an integration's comment, and whether its history's `toTitle` and `updatedDescription` are filled as its schema says | the owner's real trial; until then an unnamed author reads as an agent's |

## 6. The passkeys lane (`v2-j4-passkeys`, issue #389)

This section was written on 2026-10-25 by the author of issue #389 (Opus 5.5), before the lane's tests and code. Inputs: issue #389, the [decisions log](decisions-log.md) (the entries "app login by password, no passkeys" of 2026-10-21, "the v1 passkey code stays until milestone 4" of 2026-10-25, and the latest ones, the ten ideas among them), the [requirements matrix](requirements-matrix.md) (B3.9, B5.9d, B5.10g, D17, D18, D21), section 4 of this page (question 1), and the v1 app as pull request 388 leaves it, in TypeScript. As earlier lanes noted, the brief's section 6 and sections 9 and 10 of `milestone-2-plan.md` are not in the repository; the conventions followed are those of sections 9 and 10 of [milestone-1-plan.md](milestone-1-plan.md).

### 6.1 Context

The v2 app signs the human in with a password and has no passkeys (pull request 135, B3.9). The v1 app (`app/`, kept and converted by pull request 388) still asks a passkey for Clear to land, Send back and turning a browser's notifications on or off, registered with `cleared app passkey` through a grant socket. Issue #389 removes that code, as the owner's decision of 2026-10-21 and B5.9d ask, and so answers question 1 of section 4.5, which 388 left at its default (a), the files kept.

### 6.2 What exists at the end, and how it is proven

- Gone: `app/lib/webauthn.ts`, `app/lib/grant-socket.ts`, `app/public/register.html`, `app/public/register.js`, `test/app-authenticator.ts`; the routes `GET /register`, `GET /register.js`, `POST /api/passkeys/options` and `POST /api/passkeys/finish`; the passkey file's reading and writing in `app/lib/credentials.ts`; the `[app] grant_socket` setting; the passkey words of both catalogs.
- `cleared app passkey` says that passkeys are gone and where the gestures are confirmed now, in the owner's language, and exits 2 without starting the server.
- The three gestures are confirmed by the signed-in session (decision below). The rest stays as it is: a one-time challenge bound to the session, the gesture, the version on screen and the text sent back (or the subscription); the 60 second grace delay held on the server and its Undo; a Send back that withdraws a waiting Clear; the board read again before the agreement is written; an https address (or this machine) required.
- Proven by `test/app-actions.test.ts` and `test/app-notify.test.ts` (a session alone confirms; another session, a reused challenge, a changed text or subscription, no cookie, no anti-forgery token, another origin, an insecure address are refused and nothing is written), `test/app.test.ts` (the routes), `v2/test/keep-and-drop.test.ts` and `v2/test/repository-core.test.ts` (the passkey files no longer tracked), and the v1 and v2 suites green.

### 6.3 Decisions this lane takes

1. **What confirms the gestures: the signed-in session.** The owner's decisions already say it for v2: "the identity for an agreement is the app session" (D18) and "subscription without a passkey" (D21, B5.10g). The v1 access token, like v2's password, is held by the human alone: it lives in a private file of the app's account, which the agents' account cannot read (`test/app-writers.test.ts`), and nothing but the human's browser, `cleared app --link` and the screenshot tool (with a token of its own) sends it. Rejected: refusing the three gestures in v1 (the app would lose Clear to land, Send back and its notifications, far more than the passkey code); dropping the v1 app (question 2 of section 4.5, the owner's). Asked to the owner in the log entry, this default applied.
2. **The one behaviour change.** An installation with no passkey registered refused Clear to land, Send back and notifications; it now takes them from a signed-in session over https. An installation with passkeys registered no longer asks for one. A `passkeys.json` left in the human credentials directory is no longer read, and never deleted by Cleared.
3. **`[app] grant_socket`** is no longer read; a setting file that still has it starts as before.
4. **The pictures** of the gestures that show a passkey (`app/screenshots/`) are not retaken here; the v1 docs pages lose the lines that describe the passkey, nothing else.
5. **Lines.** P238 (this lane; P236 is the cleanup's, P237 the mirrors follow-ups'); B5.9d `done`; the shared line "B5.9d and D17: milestone 4" of "Reste avant v2 -> main" loses B5.9d, D17 keeps its own status (the Linear trial).

### 6.4 Out of scope

The v2 app and its password login (unchanged); the v1 access token and its sign-in; dropping the v1 app; the v1 docs beyond their passkey lines; retaking the v1 pictures.

### 6.5 Files this lane owns

The passkey files above; the passkey parts of `app/lib/actions.ts`, `app/lib/notifications.ts`, `app/lib/credentials.ts`, `app/main.ts`, `app/server.ts`, `app/public/actions.js`, `app/public/notify.js`, `app/public/login.js`, `app/screenshots.ts`, `app/screenshots-actions.ts`, `app/DESIGN.md`, `lib/i18n/{en,fr}.json`, and of the v1 tests and docs pages that name them; the passkey rows of `keep-and-drop.md`, `v2/test/keep-and-drop.test.ts` and `v2/test/repository-core.test.ts`; its lines of the matrix and its log entry.

### 6.6 Unknowns, and who closes them

| Unknown on 2026-10-25 | Closed by |
| --- | --- |
| Whether the owner wants the v1 gestures confirmed by the session, refused, or the v1 app dropped | the owner (question in the log entry, the session applied) |

## 7. Deploy checklist (v2 server switch)

Written on 2026-10-25 at the lead's request, after pull request 388 merged (the v1 drops gone, `wake.ts` in place of the bash wake). These are steps for the owner or the operator on each server; no lane runs them, and nothing in this repository does them.

1. **Run `serve/install.ts` again on each server**, from the checkout the units should use, so that its systemd user units name `wake.ts` instead of `wake.sh` and `serve/install.sh` (decisions log, the cleanup's entry, "For an installation"). It checks every port it binds before it writes anything (its header, `serve/install.ts`).

## 8. The v2 service's heartbeat and status (`v2-j4-heartbeat`, issue #392)

Section 4 is the cleanup lane's (pull request 388); sections 6 and 7 are the passkeys lane's and its deploy checklist (pull request 391).

### 8.1 Context

B2.1 keeps v1's heartbeat and `cleared status` (`keep-and-drop.md`: `lib/heartbeat.mjs`, now `lib/heartbeat.ts`, and `docs/heartbeat.md`). Pull request 388 keeps them as v1's modules, in TypeScript, run by v1's wake, and leaves out "the heartbeat and `cleared status` in the v2 service" (its section 4). v2 has neither: when its service stops, nobody hears it, and no command says what it is doing. This lane gives the v2 service a beat a push monitor listens to, and a status command that reads v2's ledger, in strict TypeScript, without touching v1's files that 388 rewrites.

### 8.2 What exists at the end, and how it is proven

- `src/heartbeat/settings.ts`: the settings, read from the environment, and the monitor's addresses, read from private files. `src/heartbeat/snapshot.ts`: what v2's ledger says of the service's health, read-only. `src/heartbeat/beat.ts`: the problems (`diagnose`, a pure function), each continuous problem recorded once, and the beat sent to the monitor. `src/heartbeat/status.ts` and `src/heartbeat/messages/heartbeat.{en,fr}.json`: the status's words and its JSON.
- `src/cli/status.ts`, run as `npm run status` (`-- --json` for one JSON object): exit 0 when nothing is wrong, 1 with a problem (a notice never counts), 2 when the status cannot be collected.
- The notify module (`modules/notify.ts`) starts the beat at the service's start, with or without a project, and stops it at its stop.
- Proven by `test/heartbeat/diagnose.test.ts` (each problem, case by case), `test/heartbeat/settings.test.ts` (the files and the addresses refused), `test/heartbeat/beat.test.ts` (the beat against a fake monitor on loopback: success, failure, a problem recorded once, a failed delivery said once an hour, and never an address, a title or a path in what leaves or in the ledger), `test/heartbeat/snapshot.test.ts` (on the real tables), `test/heartbeat/status.test.ts` (the words and the JSON), `test/heartbeat/cli.test.ts` (the command, in French and in English, its JSON and its exit codes, against a fake `/health`), `test/heartbeat/catalog.test.ts`, and `test/notify/module.test.ts` (the beat starts and stops with the service).

### 8.3 What it watches, from what v2 has

v2 has no per-minute wake: its service runs. The beat is the service's own timer, and what v1 read from its wake, its lanes and its processes is read from v2's tables.

| Problem code | When | Read from |
| --- | --- | --- |
| `beat_missing` | no beat recorded (the status only) | `v2_heartbeat_state` |
| `beat_late` | the last beat is older than three intervals (the status); the beat before this one was (the service) | `v2_heartbeat_state` |
| `beat_failed` | the last beat could not read the ledger | `v2_heartbeat_state` |
| `service_unreachable` | the service's `/health` does not answer (the status only) | `CLEARED_V2_HOST`, `CLEARED_V2_PORT` |
| `session_stalled` | an author, reviewer or reader session alive and unmoved for more than two hours: the idle watchdog stops one at 15 minutes, so this one escaped it | `sessions`, `session_events` |
| `tracker_stale` | a configured mirror whose last full pass is older than ten minutes | `mirror_trackers` |
| `monitor_invalid` | a monitor address file the service refused | `v2_heartbeat_state` |

A notice, never a failure: `monitor_off`, no success address is set, so nobody hears it when the service stops. The status also says, without a problem: the sessions running, what waits for the owner in the inbox (the oldest item, its kind and for how long), the subscription's two windows (`latestQuota`, percent only, no money), the mirrors' last reads and the release trains not landed.

Not carried from v1, each for its reason: the wake's own records (`wake_failed`, `pending_stalled`), its lead (`lead_stuck`: v2's lead is a permanent session that waits by design, as the watchdog says), its lanes and orphan processes (`lane_idle`, `orphan_process`, `--reap`: v2's sessions are containers labelled `cleared.dev=v2`, stopped by the watchdog and the restart recovery), its forge and tracker probes (`forge_credential`, a `gh` or `tracker.sh` call: v2 runs neither for its status, and the mirrors' reads say a tracker's health), its shared-account and heavy-lock checks (v1's settings).

### 8.4 Decisions this lane takes

- **The beat.** Every `CLEARED_V2_HEARTBEAT_SECONDS` (60 by default, 15 to 3600), and once at the start. Each beat writes its time, finds the problems, records each continuous problem once (`v2_heartbeat_incidents`, and a `heartbeat_problem` row of the ledger's `events` with its code), then calls the success address with no problem, or the failure address with one. Without a failure address, the monitor sees the missing success.
- **What leaves the host.** A GET with no body for a success; a POST whose body is `Cleared health: blocked` and the problems' codes, one per line, for a failure. Never a ticket, a title, a session id, a path or an address. A delivery that fails is a `heartbeat_delivery_failed` event, at most one an hour, with no address.
- **The addresses are credentials.** `CLEARED_V2_HEARTBEAT_PING_URL_FILE` and `CLEARED_V2_HEARTBEAT_FAIL_URL_FILE` name files, as the mirrors' tokens do; never a variable holding the address. Each file is a regular file, not a link, owned by the service's account, readable by it alone (no group or other bit), outside the project's checkout. The address is HTTPS, or HTTP on loopback, without a user or a password. A refused file is said by its variable, never its content, and leaves the beat on without that address (`monitor_invalid`).
- **The status reads no secret.** It reads the ledger read-only and the thresholds from the environment; whether the monitor is on, off or refused is what the service last wrote. It asks the service's own `/health` on its configured address, nothing else.
- **Thresholds.** `CLEARED_V2_HEARTBEAT_SESSION_MINUTES` (120) and `CLEARED_V2_HEARTBEAT_TRACKER_MINUTES` (10), as v1's `lane_idle_minutes` and `service_minutes`.
- **Tables.** `v2_heartbeat_state` and `v2_heartbeat_incidents`, of the notify module: v2's ledger is in v1's format and may be v1's own file, which has `heartbeat_state` and `heartbeat_incidents`.
- **Where it starts.** In the notify module, the one whose job is what leaves the host for the owner, so neither `main.ts` nor `registry.ts` changes (388 changed the registry while this lane ran). A tenth module is the other way (question for the owner, default applied, in the log entry).
- **JSON.** `schema: 1` and v1's stable keys where v2 has them (`schema`, `project`, `checkedAt`, `ok`, `problems`, `notices`, `waiting`, `quota`), with v2's own (`service`, `lastBeat`, `monitor`, `sessions`, `trackers`, `releases`). Each problem has `code`, `id`, `level` and a `message` in the status's language.
- **Language.** `CLEARED_V2_APP_LANGUAGE`, French by default; every duration through `app/web/lib/time.ts` ("2 h", never "120 minutes").
- **`cleared status`.** v1's root command keeps reading v1's state. Pointing it (`cleared.ts`, since 388) at v2's status is not done here, to keep the lane to v2; the v2 status is `npm run status` in `v2/`.
- **Matrix lines.** P239 (the beat, the status, their settings); B2.1 updated.

### 8.5 Out of scope

v1's `lib/heartbeat.mjs`, `cleared`, `wake.sh` and `test/heartbeat.test.mjs`, which 388 made `lib/heartbeat.ts`, `cleared.ts`, `wake.ts` and `test/heartbeat.test.ts`; a screen of the app that shows the status; reaping processes; a real monitoring service (the tests' monitor is a fake on loopback); the lead's health.

### 8.6 Files this lane owns

`v2/src/heartbeat/`, `v2/src/cli/status.ts`, `v2/test/heartbeat/`; the `status` script in `v2/package.json`; the beat's start and stop and its tables in `modules/notify.ts` and their case in `test/notify/module.test.ts`; a row in `v2/README.md`; its lines of the matrix and its log entry.

### 8.7 Unknowns, and who closes them

| Unknown on 2026-10-25 | Closed by |
| --- | --- |
| Whether a monitoring service the owner picks accepts a POST body on its failure address | the owner's set-up; the body is plain text of a few lines, as v1's |
| Whether the first piloted project's service runs the status under its own account | the owner; the status reads no secret, so another account reads it when it can read the ledger |

## 9. The project page, per service (`v2-j4-project-page`, issue #394)

Written on 2026-10-25 by the author of issue #394 (Opus 5.5), before the lane's tests and code. Sections 6 to 8 are the lanes of pull requests 391 and 393, merged into `v2` before this one. Inputs: issues #394 and #274, the [decisions log](decisions-log.md) (the entries of lanes `j3-project-page` and `j3-flaky-page`, and the ten ideas of 2026-10-25), the matrix (P59, P101 to P105), and sections 9 and 10 of [milestone-1-plan.md](milestone-1-plan.md), since `milestone-2-plan.md` has no sections 9 and 10.

### 9.1 Context

Milestone 3 made the page (pull requests 313 and 363, P101 to P105): made at a service's first fetch from its base branch, made again after each merge, quoted in every author's and reviewer's `CLAUDE.md`. P59 stayed `later` because three things were left. A folder service of a monorepo gets a page of the whole repository under its own name, so two folder services have the same page. The only test on an example copies the guestbook alone, never the two-service workspace of `examples/workspace.conf`. The lead's briefing reads a service's committed `docs/project.md` only, so a project that commits none gives the lead nothing of it.

### 9.2 What exists at the end, and how it is proven

- **A folder service's page is its folder's.** Its layout lists the folder only, its `package.json` and README are the folder's, its recent decisions are the first-parent commits that touch the folder or `.cleared/agents.conf`, and its header names the folder and the last such commit. A merge in another folder leaves the page as it is.
- **The page says where the service sits in the workspace**: the services it consumes and the contract it provides, when the workspace names them.
- **The lead reads the pages.** A service with no committed page gets a line in the lead's briefing from its generated page: the README's first paragraph, else the package name. The workspace's own service too, when its checkout commits no `docs/project.md`.
- Proven by `test/workspace/project-page-workspace.test.ts`: the tracked files of `examples/guestbook` and `examples/filter-api` as the two services of `examples/workspace.conf`, through the real effects on local bare repositories (first connection of each, a merge on one, a session of each, no secret), then the same two as folders of one repository; and new cases in `test/lead/briefing.test.ts`.

### 9.3 Decisions this lane takes

- **The folder's tip, not the base's.** The page carries the sha of the last commit that touched the folder or `.cleared/agents.conf` (the safe commands are the repository's), so `updateProjectPage`'s check stays "the page names the tip it was made from".
- **The page stays English**, written for the sessions as before. No word a person reads in the app changes, so no catalog changes.
- **Matrix lines.** P240 (a folder service's page), P241 (the workspace's part of the page), P242 (the lead's lines); P59 `done`, naming 313, 363 and this lane's pull request. P238 is lane `v2-j4-passkeys`'s and P239 lane `v2-j4-heartbeat`'s.

### 9.4 Out of scope

A screen that shows the page; a page edited by hand; a page in the project's language; the decisions folder of a project (read through `lib/memory`, as before); a real account of any kind. The tests run on local repositories in temporary folders, and nothing is pushed.

### 9.5 Files this lane owns

`v2/src/workspace/project-page.ts`, the page's call in `v2/src/flow/effects.ts`, the lead's service lines in `v2/src/lead/briefing.ts`, `v2/test/workspace/project-page-workspace.test.ts`, the new cases of `v2/test/lead/briefing.test.ts`, this section, its matrix lines and its log entry.
