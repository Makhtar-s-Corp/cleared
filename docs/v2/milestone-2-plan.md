# Cleared v2: milestone 2 plan, replanned

Milestone 2 gives Cleared its project lead, its goal mode, night work on an approved plan, the lead and plan screen and a notification for every wait. Its first plan (pull request 159) split that into eleven lanes in four waves; the four waves are merged and the eleventh lane, the proof script, is open (pull request 181). On 2026-10-22 the owner added three things before the milestone's proof: the interface moves to React, the workspace becomes several services, and two complements are integrated into the milestones. This page replans what remains, in this order: the React port, the clickable answers, the data model migration to workspace and services, the milestone 1 catch-up, the milestone 2 additions, then the proof. It contains no code: every lane writes its own, tests first.

Written on 2026-10-22 by a Fable 5.1 planning session (logged in [decisions-log.md](decisions-log.md)). Inputs: the brief (sections 3 to 6), the owner's decisions of 2026-10-21 and 2026-10-22 (the latest last, in the log), [complement-devin.md](complement-devin.md), [complement-multi-depots.md](complement-multi-depots.md), [milestone-1-plan.md](milestone-1-plan.md), the first milestone 2 plan (its decisions 1 to 15 and sections 3 to 7 stay the reference of what landed; they are not repeated here), the `v2/` code at commit `f86c147`, the merged pull requests 160 to 180, pull request 181 and the two worktrees not yet pushed on this server (`v2-j2-react-port`, `v2-j2-choices`). Every version, table, route and file below was read on this server on 2026-10-22; "unknown" marks what was not verified.

## 1. Where milestone 2 stands

| Lane | Branch | Pull request | State |
| --- | --- | --- | --- |
| 1 contracts | `v2-j2-contracts` | 160 | merged |
| 2 flow-landing | `v2-j2-flow-landing` | 161 | merged |
| 3 app-shell-notify | `v2-j2-app-shell-notify` | 162 | merged |
| 4 runner-host-tools | `v2-j2-runner-host-tools` | 169 | merged |
| 5 lead-core | `v2-j2-lead-core` | 167 | merged |
| 6 notify | `v2-j2-notify` | 166 | merged |
| 7 plans | `v2-j2-plans` | 172 | merged |
| 8 lead-screen | `v2-j2-lead-screen` | 174 | merged |
| 9 tower-m2 | `v2-j2-tower-m2` | 171 | merged |
| 10 inbox-plan | `v2-j2-inbox-plan` | 178 | merged |
| 11 proof-script | `v2-j2-proof-script` | 181 | open: five rehearsals passed on the fake adapter; it already skips the Mac notifications and counts the login cuts |
| fix doctor-window | `v2-j2-fix-doctor-window` | 176 | merged |
| complement doc | `v2-j2-complement-doc` | 180 | merged |
| React port | `v2-j2-react-port` | none yet | in progress on this server, not pushed: one commit (the three owner decisions of 06:29 and 06:30 on React, CopilotKit, shadcn/ui and Phosphor, in the decisions log) and an uncommitted tree under `v2/app/web/` |
| clickable answers | `v2-j2-choices` | none yet | on hold, not pushed: three commits of a home-made component on the old front end, to be redone on the React port |

Two facts the lanes below depend on. First, the React port's commit was made before pull request 180 and rewrites the log's last entry: when that lane merges `origin/v2`, the log must keep both the owner's complement entry and the three React entries, each once. Second, the proof script of pull request 181 drives the old screens through the browser; it is merged as it is, and lane 29 adapts it to the React screens.

The lead's tools, its context cycle, the plan model, the runner's rules and the notification kinds are implemented; their reference is now the decisions log entries of lanes 1 to 10 and the code under `v2/src/lead/`, `v2/src/notify/` and `v2/src/flow/`. What follows plans only what remains.

## 2. The proof, extended

The milestone has two proofs. Both run in the app, with no command on the server, and each step's time is shown or recorded.

### 2.1 The 48-hour guestbook proof

Unchanged in its steps from the first plan's section 1, run on the React screens, with the owner's decisions of 2026-10-22 applied:

| Step | What the owner does or sees | Measured as |
| --- | --- | --- |
| 1 | In the evening, opens the lead screen (or types in the tower bar and chooses New goal) and gives a goal | goal sent at |
| 2 | Answers the one or two questions the lead asks, by clicking an answer in the thread | first question shown at, answers at, number of questions, number of clicked answers versus typed ones |
| 3 | Sees the plan: 4 to 6 tickets, each with its lane, its dependencies, its estimated time and cost; the plan item is in the inbox | plan proposed at (from the last answer), inbox item at |
| 4 | Approves the plan with "Approve the plan and start"; the first tickets start | approved at, first session start at (at most 2 at a time) |
| 5 | Closes the laptop. During the night the tickets advance; every wait is an inbox item; the lead answers a team's question only when a recorded decision settles it, and escalates the rest | per ticket: started, session plan and its confidence, Go (by the owner, by the delay, or by the lead's approval), review verdict, waiting for approval; number of waits; number of waits still open in the morning, and which |
| 6 | In the morning, opens the app: the tower says what waits and what ran; the inbox holds the releases to approve and any question; the lead thread holds the night's account | items waiting at 08:00 by kind; tickets by state; the thread's night messages with their times |
| 7 | Approves the releases from the inbox, each card grouped by intent with its flags; the dependent tickets start as their dependencies land; the plan ends | approval times, each dependent start after its dependency's landing, plan done at |
| 8 | 48 hours after the goal, reads on the lead screen: the number of refreshes, the highest context share reached, and the commitments, each done or still open | highest context share, below the threshold; refresh count; the three planted commitments each done or open, none lost |

What the owner's decisions change:

- **Inbox only.** Every wait is read from the inbox. The Mac notifications are a skipped step, not a failed one, until the https question is answered (section 6, question 2); the `notification_sent` events are still counted, and the step says "skipped: no secure address for the Mac".
- **The login.** The sessions run on the current Claude Code login, read-only, for the example project only (owner decision, 2026-10-22 05:05). The runner relaunches a session after a revoked token once the login file changes; the report counts each cut: when it began, when the next turn started, how long it lasted, or that it was not relaunched and whether the session ended.
- **The catch-up items in the night.** Each ticket's author proposes its session plan with a confidence before writing code (lane 17); a high-confidence plan of a ticket the lead started counts the plan's approval as its Go, so the night is not held by the gate; a medium or low one waits in the inbox and the morning counts it. Each release card is grouped by intent with its flags (lane 18).
- **No lane runs during the 48 hours** (the quota is shared, brief rule 11), and the week share is read before the proof starts (section 5).

The demo runs on the example guestbook (`examples/guestbook/`, its own repository decided on 2026-10-21), as a one-service workspace, with the goal of the first plan's question 5, option (a), unless the owner writes another. A run on one goal of the first piloted project comes after the owner's go and is not part of this plan.

### 2.2 The multi-service proof

A second example repository, a small filter API the guestbook consumes (lane 28, section 4.6; the repository itself is the owner's question 1), makes a two-service workspace: the guestbook, which consumes, and the filter API, which provides. The proof is one ticket that crosses both, then one provoked failure:

| Step | What the owner does or sees | Measured as |
| --- | --- | --- |
| 1 | Creates the ticket "An entry the filter flags is held for review instead of refused" from the tower bar, naming both services; or gives it to the lead as a goal | ticket created at |
| 2 | Sees the ticket split into steps: the contract first, one step per service, then the integration, each with its order, its dependencies and its estimated cost | steps proposed at; cost per step |
| 3 | Validates the contract in the inbox: the change to `openapi.yaml` (a `severity` answer on `POST /check`), shown as a diff, with Approve and Send back | contract validated at (from the request) |
| 4 | Sees the two service steps run in parallel, each in its own container; on the guestbook's session, the Browser tab shows the trial environment, where the filter API is a fake built from the validated contract and answers the guestbook's call | step durations; the fake's first answer at; the number of calls the fake answered |
| 5 | Sees the integration step: both checkouts at the ticket branch, the real filter API as a sibling, the end-to-end test green | integration duration, test result |
| 6 | Sees one release card in the inbox: two pull requests, the landing order (the filter API first, the guestbook after), the compatibility line ("the guestbook consumes the filter API and is changed in this ticket"), the intent groups and the flags; approves with one gesture | approval at |
| 7 | Sees the train land in order: the filter API merged, its health checked, then the guestbook merged, its health checked; the ticket Done | each merge at; each health verdict at; the gap between the two landings |
| 8 | Creates a second two-service ticket whose guestbook change breaks `/health` after the deploy (the proof's provoked failure, a planted change behind a `PROOF_BREAK_HEALTH` setting of the example); approves its release | approval at |
| 9 | Sees the rollback in reverse order: the guestbook's watch fails twice and reverts the guestbook's merge; the train then reverts the filter API's merge; the card says "rolled back, 2 of 2"; the ticket is back in Todo with the note; an inbox item says so | first failing probe at; the guestbook's revert at; the filter API's revert at; the order of the two |
| 10 | Creates a third ticket that changes the contract without touching the guestbook (the untouched consumer); sees the card blocked before approval with the proposal (extend the contract, or keep it backward compatible), and no Approve button | the block shown at; the proposal's text |

Both examples run their deploy watchers on this server (`127.0.0.1:8793` for the guestbook; the filter API's port is chosen by lane 28 after `ss -ltn`, never 80, 443 or 8788). Nothing is created on the forge by a lane: the second repository is the owner's gesture (question 1).

### 2.3 What is measured besides the steps

Per brief rule 12, for each ticket of both proofs: the sessions and their cost (`total_cost_usd`), the review rounds, the waits and the time between a wait and its answer, the owner's gestures, and the lead's own cost over the 48 hours (the sum of its turns' cost and their number). The durations table of each proof is written by the proof script (`durations.md`, as milestone 1 did) and quoted in the milestone report. The quota share is read on the host before and after each proof and written in the report (section 5).

## 3. Decisions this replan takes

Numbered after the first plan's fifteen, so the log can cite them. The orchestrator copies each one into [decisions-log.md](decisions-log.md), with its consequences, when the lane that implements it lands.

16. **The front end is React, built by Vite; the service and the app's server are not built.** The owner's decisions of 06:29 and 06:30 stand as the React port's worktree applies them: React 19, CopilotKit 1.77 through its headless entries only (no runtime, no Copilot Cloud, no public key, telemetry off, the web inspector replaced by an empty module), shadcn/ui components copied into `v2/app/web/components/ui/` on Radix and Tailwind 4, Phosphor icons in the regular weight, Vite 8 bundling `v2/app/web/` into `v2/app/dist/` which the server serves from the build manifest. `dist/` is never committed: CI and the server's start build it. The screens keep the kit's identity: the same tokens, Geist, no gradient, the four reference captures as before. The pure parts of each screen (its model) stay under test with `node --test`; a component test, if the lane needs one, names its runner and justifies it in one line.
17. **Clickable answers keep AG-UI's format.** A question a session or the lead asks is the `cleared.question` CUSTOM event, whose questions carry Claude Code's `AskUserQuestion` shape (header, options with label and description, multiSelect). The React screens render it through CopilotKit's headless hooks as the thread's interrupt, as buttons plus a free answer; the answer goes through the app's answer routes (anti-forgery token, origin), never through a CopilotKit run. The lead's rule from the on-hold branch is kept: two to four options when the question allows it, the recommendation first with "(Recommended)" at the end of its label, no "Other" option.
18. **A workspace is several services; a ticket belongs to the workspace.** Two tables, owned by the store: `workspaces` (id, name, created at) and `services` (workspace, name, kind `repository` or `folder`, repository `owner/name`, url, base branch, path for a folder of a monorepo, health url, sensitivity, consumes, run, contract, created at). A ticket's per-service parts are `ticket_services` (ticket, service, branch, pull request, state). The `project` column of every existing table keeps its name and now holds the workspace id; no v1 table changes (`tracker_*`, `runs`, `events`, `releases`). Reason: the local tracker and `merge-pr.sh` read `project` as it is, and a rename would touch every query for a word. The TypeScript names say `workspace`. A one-service workspace needs no new file: the service builds it from the milestone 1 environment (`CLEARED_V2_PROJECT`, `_PROJECT_DIR`, `_REPO`, `_REPO_URL`, `_BASE`), so the guestbook becomes a one-service workspace on its first start after the migration. A workspace of several services is described by one file named by `CLEARED_V2_WORKSPACE`, in the format of `agents.conf` (`[workspace] name`, one `[service <name>]` section per service with the columns above); each service repository keeps its own `.cleared/agents.conf`, read at its base branch, as today.
19. **The store is migrated by versioned, tested migrations.** A table `v2_schema` (version, applied at) and an ordered list in `v2/src/store/migrations.ts`, applied in one transaction each at open, after the module tables are created. Before the first migration of a start, the store copies `ledger.db` (and its WAL) to `ledger.db.before-<version>` next to it, so the step is reversible by hand; the copy is never read by the code. A migration is idempotent and tested against a fixture ledger made by the schema before it (the fixture SQL is committed under `v2/test/store/fixtures/`), run twice, and the v1 reader of the tracker tables (`lib/tracker/adapters/local.mjs`) still reads it. Milestone 1's rule that a module creates its tables with `CREATE TABLE IF NOT EXISTS` stays: a migration is for changing what exists.
20. **One checkout per ticket and per service; the other services are siblings, real or fake.** The workdir of a session is `<workdirs>/<ticket>/<service>`, a clone of that service's repository on the ticket branch (the same branch name on every service the ticket touches); for a folder of a monorepo, the clone is the repository and the session's `cwd` is the folder. The other services of the workspace reach the session's internal network as sibling containers: a real one, built from that service's checkout at the ticket branch when it has one and at its base otherwise, through the `run` setting of the service (a Dockerfile path and a port, as the guestbook's own `Dockerfile` already allows); or a fake, when the service declares no `run` or its build fails, generated from the service's contract (`contract = openapi:<path>`, OpenAPI 3 only in this milestone: each operation answers its first example, or a 501 with the operation's name when it has none), run by Cleared's own labelled `cleared-v2-fake` image. These siblings are the ticket's trial environment, which the Browser tab reaches through a service route the app proxies (`/api/sessions/:id/preview/`), never through a published port.
21. **The lock stays per service; the train lives in the v2 service.** A release broker runs per service, on its own socket (`CLEARED_V2_BROKER_SOCKETS`, one per service name; the one-service case keeps the milestone 1 socket), each with its service's `ORCH_REPO` and `agents.conf`. The v2 service keeps `release_trains` (ticket, services in landing order, state per service: `waiting`, `merged`, `healthy`, `failed`, `reverted`): the landing order is providers before consumers from the services' `consumes` lines, then position; each landing is `request_release` on that service's broker, waited to exit 0, then the service's watch read from its ledger until a healthy verdict, before the next; a failing watch rolls that service back by its own `auto_rollback`, and the train then asks `request_rollback` of each earlier landed service, newest first. The compatibility check before approval: a ticket that changes a service's contract file without a step on every service that consumes it is blocked on the card, with the proposal to extend the contract or keep it backward compatible; the owner can still ask the lead to add the missing step. The broker refuses `request_rollback` from an account that is not the configured human (`serve/release-broker.mjs` line 143): lane 16 checks whether `[security] allow_shared_uid` covers it, and if not makes the one-line change, reviewed as a security change, as milestone 1's lane 8 did.
22. **The session plan is validated before the code, with a confidence.** The author's first turn ends with a host tool call `propose_session_plan({ steps, files, confidence: 'low' | 'medium' | 'high', reason })` (the author now has host tools, lane 4), journaled as `cleared.session_plan`; the flow holds the author until a Go: the owner's, from a `session_plan` inbox item ("Go", "Change" with a message that reopens the author); or the delay's, `[session] plan_go_minutes` of the service's `agents.conf` (10 by default), after which a high-confidence plan starts by itself and a medium or low one keeps waiting; or the lead's, for a ticket of an approved plan with a high confidence, since the owner approved that plan. A reopened author after a review does not propose again. The measured step is `plan_gate`, counted apart from working time.
23. **The release request is grouped by intent, with flags.** At the end of its work the author calls `report_changes({ groups: [{ intent, files }] })`; the service checks every changed file is in exactly one group (the rest go to "Other changes"), and computes the flags from the diff: `schema` (a migration folder or `.sql`), `dependency` (`package.json` dependencies or the lock file), `config` (`guarded_paths`, `.github/`, `.cleared/`), `secret_shape` (a line the guard would flag, which also refuses the publish), `contract` (a service's contract file), `large` (more than 400 lines added). The card shows the groups with their files and the flags; a flag is a chip, never a block, except `contract` on an untouched consumer (decision 21).
24. **Sensitivity per service, flagged from the plan.** `sensitivity = normal | full | reviewer:<model> | human:<user>` on a service: `full` refuses the fast lane for any ticket touching it (a fast plan item becomes full with a note); `reviewer:<model>` makes that model the reviewer of the ticket's sessions on that service (another model than the author's, else refused at configuration); `human:<user>` adds that user as the one who must approve the release (the signed-in owner's approval is refused for another user, with the message naming who). The plan panel shows a sensitivity chip on each item from the services its body names, and the lead's rules say it.
25. **Memory has three levels: workspace, service, contract.** `lib/memory` is run three times, each in its own state directory: `<state>/memory` (the workspace), `<state>/services/<name>/memory` (each service), `<state>/contracts/<name>/memory` (each contract, named by the service that provides it). The briefing of a session on a service reads the workspace page, then that service's page and lessons, then the pages of the contracts its ticket touches, within the same byte budget; a handover files its lessons in the level the author names (`## Lessons for the service`, `## Lessons for the contract`), else in the workspace's. The lead's briefing reads the workspace level and the service pages' first lines.
26. **A ticket runs in steps.** `ticket_steps` (ticket, kind `contract` | `service` | `integration`, service, position, after, state, session, cost): the contract step is a session on the providing service that changes only the contract file and ends with the contract's diff proposed as an inbox `contract` item (Approve, Send back); the service steps run after it, in parallel, each with the fakes of decision 20 (the fake of a changed contract is built from the validated one); the integration step runs last on the consuming service with every sibling real, and its tests are the ticket's criteria. A one-service ticket has one `service` step and nothing else changes. The lead's plan items gain `steps`, with a cost per step from the estimates (lane 7's medians by size, per step kind); the plan shows the steps' order and dependencies.
27. **Knowledge is proposed, then approved in the inbox, then landed in the skill.** A handover's lessons and the decisions it names become `knowledge` inbox items (text, level, source session), with Approve and Reject; approving writes the entry into `lib/memory` at its level at once (the next briefing has it), and queues it for the service's skill; once a day, or on the owner's "Update the skill now", a fast-lane ticket per service writes the queued entries into `.claude/skills/cleared-<service>/SKILL.md` in the standard skill format (front matter `name`, `description`; the body in sections per level), through the lock like any change. The approval-by-comment of v1 is not carried over. The project's skills under `.claude/skills/` are mounted into the session as they are (milestone 1's lane 5 named it; nothing of it exists in the code on 2026-10-22, so this lane does it).
28. **A read-only question to the code, or to the platform, with its cost.** A `reader` role: a session on the base branch of the named service (or, for the platform, on a workdir holding every service's checkout, read-only), with the reviewer's policy (no edit, no commit, no push), briefed with the question, which may name a service, a file and a line (`service:path:line`; the briefing adds the file's lines around it); started from the tower bar ("Ask about the code") or a session's Plan tab, shown on a `/ask/:id` screen with the answer, its cost (`total_cost_usd`, tokens, and the week share when measured) and a follow-up field; stopped by the idle rule. It is never a plan item and never writes.
29. **Recipes live in the repository; schedules live in the store.** A recipe is `.cleared/recipes/<name>.md` in a service's repository (front matter: `name`, `kind: ticket | goal`, `parameters`, `lane`, `size`, `services`; the body is the ticket's body or the goal's text with `{{parameter}}` marks), read at the base branch; the tower bar lists them ("Run a recipe") and runs one as a one-item plan (a ticket) or an owner turn to the lead (a goal). A schedule is a row of `schedules` (recipe or goal, `at` or `every` in the server's time zone, budget in USD, week-share cap, created by, enabled): the scheduler ticks each minute and starts the run through the plan runner, with the creator's approval given at creation as the plan's approval; the ticket's budget is the schedule's; a release still waits for the owner; the week stop still wins. The tower's plans card lists the schedules and their next run.
30. **The session screen has four tabs, and the owner can take over.** Plan (the session plan with its confidence and Go, the criteria, the steps of the ticket), Terminal (milestone 1's live timeline and the message field), Editor (read-only: the changed files with their diffs and a file viewer of the checkout through a service route with the events' cleaner and limits; an editable editor is question 4), Browser (the trial environment of decision 20, else milestone 1's "Screen so far" capture). "Take over" pauses the session (`interrupt`, then the inbox requests settled as `cancelled`) and shows the command to resume it in a terminal on the server (`docker exec -it cleared-v2-<id>-session claude --resume <id>`); "Give back" resumes it with the harness's `resume` in the same container. This is brief 5.10's "Open in terminal" and "Give back to Cleared".
31. **The quota is measured before each wave and each proof.** The orchestrator reads the seven-day share on the host (`/usage`, or the newest `cleared.rate_limit` event of the `seven_day` window) and writes it in the daily report; a wave starts only when the share plus the wave's estimate (section 5) stays under 85; a proof starts only with its own estimate of headroom and no lane running. A lane that passes 5 points of the week is stopped and analysed, as brief section 4 says.

## 4. The lanes

Branch names: `v2-j2-<topic>`, from `v2`, pull request to `v2`; `origin/v2` is merged into a branch, never rebased. Author models: Opus 5.5 for the core, Haiku 5.5 for small fixes; the reviewer is always a different model from the author, in a fresh session, two rounds. Fix lanes after a review are Haiku lanes `v2-j2-fix-<topic>`, not counted below. Every lane: tests first, each defect test fails on the old code, `npm test`, `npm run typecheck` and the guard green, erasable syntax in the service, no new dependency without a one-line reason, English, no em dash, nothing of the owner's name or the first piloted project's name in the repository, Docker objects labelled `cleared.dev=v2`, nothing bound outside `127.0.0.1`, `ss -ltn` before any listener. Each lane appends its entry to [decisions-log.md](decisions-log.md), which is the one file every lane may touch. The API types (`v2/src/api/types.ts`) are edited by one lane per wave, named in section 4.8, which writes the shapes this plan fixes for the other lanes of its wave and the next app wave.

### 4.1 The React port

#### Lane 12: `v2-j2-react-port` (in progress)

- **Goal**: decision 16. The four screens, the shell, the login, the notifications button and the plan panel as React components under `v2/app/web/`, each screen keeping its pure model (`model.ts`) and its catalog; the AG-UI thread agents for the session's timeline and the lead's thread through CopilotKit's headless hooks; the server writing each page from the build manifest; `npm run build` and `npm run dev` (Vite's server on `127.0.0.1` only, proxying the app); the CI building before the tests; `v2/app/dist/` ignored by git; the guard leaving out nothing new (the fonts and icons are already named); the theme script kept as a plain file; the catalog test over every file still; the visual loop again on the four captures at 1440, 1280, 768 and 390, light and dark, with the art-director pass, since every pixel is redrawn. The lane merges `origin/v2` and keeps every log entry once (section 1).
- **Files**: `v2/app/**` (the whole folder: `web/`, `src/`, `public/`, `fixtures/`, `messages/`, `test/`, `tsconfig.json`), `v2/package.json`, `v2/package-lock.json`, `.github/workflows/v2.yml` (the build step), `v2/README.md` (the app section), `.gitignore` (`v2/app/dist/`).
- **Acceptance proof**: a test watches every request the page makes on the fixtures source for a minute and asserts none leaves for a host other than the app's (CopilotKit's hosts included), and that the bundle holds no `copilotkit.ai`, `scarf` or Google Fonts address (a grep of `dist/`); the three telemetry switches are asserted in the Vite config; every milestone 1 and 2 rendering and flow test of the app is green on the React screens or replaced by an equal one, named in the pull request; the headless browser tests of milestone 1 (the session's follow, the inbox's flow, the lead's app test) pass on the built app; the catalog test stays complete; the visual loop's captures of the four screens before and after are in `/tmp/cleared-captures/j2-react/`, not committed; the CI builds then tests; `npm start` of the app refuses to start without a build, with the message naming `npm run build`.
- **Dependencies**: none.
- **Author**: Opus 5.5 (the lane is running). **Interface lane**: yes, against the four captures.

### 4.2 Clickable answers

#### Lane 13: `v2-j2-choices`

- **Goal**: decision 17, on the React port. The `Choices` component (options as buttons, multi-select when the question says so, the recommended mark, the free answer, the answered, cancelled and settled states) rendered from the thread agent's interrupt on the session screen and on the lead screen; the inbox's question detail using the same component; the lead's prompt rule for options (the on-hold branch's wording) and its test; the on-hold branch's model tests (`choices.test.ts` and the two screen tests) ported to the component's model; the catalogs' `choice_*` keys.
- **Files**: `v2/app/web/components/choices/**` (new), `v2/app/web/screens/session/**`, `v2/app/web/screens/lead/**`, `v2/app/web/screens/inbox/**` (the question detail only), `v2/app/messages/{session,lead,inbox}.{en,fr}.json`, `v2/app/fixtures/session.ts`, `v2/app/test/**` (its own tests), `v2/src/lead/prompts.ts`, `v2/test/lead/prompts.test.ts`.
- **Acceptance proof**: model tests prove a click sends exactly the option's label as written (the "(Recommended)" suffix kept), a multi-select sends every picked label, a free answer of more than 2000 characters is refused before sending, an answered question shows who answered and with what, an interrupted turn shows cancelled; a browser test on the fixtures source clicks an option on the session screen and asserts the answer route was called with it, and the same on the lead screen for the lead's pending question; the prompt test asserts the options rule; the visual loop on `session.png` and `lead-and-plan.png` (a question bubble with three options) at the four widths, light and dark; fr complete.
- **Dependencies**: lane 12.
- **Author**: Opus 5.5. **Interface lane**: yes.

### 4.3 The data model migration to workspace and services

#### Lane 14: `v2-j2-workspace-store`

- **Goal**: decisions 18 and 19 in the store and the configuration. `v2/src/store/migrations.ts` with `v2_schema`, the backup copy, the first migrations (create `workspaces`, `services`, `ticket_services`; add `service TEXT` to `sessions` and `session_events`, and `service` and `step` to `flow_inbox`; write the one-service workspace row from the environment on first start); `v2/src/workspace/config.ts` reading `CLEARED_V2_WORKSPACE` or building the one-service workspace from the milestone 1 variables; `FlowConfig` becoming a workspace config with a `services` list (the one-service case identical to today's values); the ticket store's `services` on a ticket (`ticket_services`); the API types: `Workspace`, `Service`, `Ticket.services`, `SessionSummary.service`, the workspace route `GET /api/workspace` (the fixtures source answers it in lane 22).
- **Files**: `v2/src/store/{db,migrations}.ts`, `v2/test/store/**` (its fixtures included), `v2/src/workspace/config.ts` (new), `v2/src/flow/config.ts`, `v2/src/tickets/{contract,local-store}.ts`, `v2/src/modules/tickets.ts`, `v2/src/api/types.ts`, `v2/src/api/routes.ts` (the workspace route), tests under `v2/test/tickets/`, `v2/test/flow/config.test.ts`, `v2/test/api/`.
- **Acceptance proof**: a test opens a copy of a fixture ledger made by the milestone 2 schema (committed SQL), with sessions, events, tickets, plans and inbox rows, runs the store, and asserts `v2_schema` holds the version, the backup file exists and equals the original, every old row is intact, the new columns are null, the one-service workspace row names the project, and a second open changes nothing; a test proves `lib/tracker/adapters/local.mjs` still lists the tickets of the migrated file; a test proves a migration that throws leaves the file as it was (the transaction) and the service exits 64 with the message; the configuration tests prove the one-service workspace from the milestone 1 variables equals the old `FlowConfig`, and a two-service file parses with its kinds, `consumes`, `run`, `contract` and `sensitivity`, refusing an unknown kind, a service that consumes itself, and a sensitivity naming no user; the milestone 1 and 2 suites stay green; the registry test still expects eight modules.
- **Dependencies**: none.
- **Author**: Opus 5.5. **Interface lane**: no.

#### Lane 15: `v2-j2-workspace-runtime`

- **Goal**: decision 20 in the containers and the workspace: the checkout per ticket and per service (`ticketCheckout` with a service, the folder kind), the same branch name on every service; `session-runtime.ts` starting sibling services from the workspace (a real one built from its checkout with its `run` Dockerfile, labelled, on the session's internal network under the service's name; a fake from the contract); the fake image `v2/images/fake/` (TypeScript, `node:http`, OpenAPI 3 read with no dependency, the first example per operation, a 501 otherwise, a `/__fake/calls` counter the proof reads); the preview route `GET /api/sessions/:id/preview/*` on the service, proxied by the app in a later lane, reaching the `run` sibling of the session's own service; the doctor's `workspace` section (a labelled run with one real sibling and one fake).
- **Files**: `v2/src/container/{session-runtime,services,docker}.ts`, `v2/src/workspace/checkout.ts`, `v2/src/flow/runtime.ts`, `v2/src/session/contract.ts` (`StartInput.service`, `StartInput.siblings`, additive), `v2/images/fake/**` (new), `v2/scripts/doctor.ts`, `v2/src/container/preview.ts` (new, the preview route, registered by `v2/src/modules/sessions.ts`), tests under `v2/test/container/`, `v2/test/workspace/`, `v2/test/runner/image.test.ts`.
- **Acceptance proof**: tests over the wrapper prove every command line for a sibling and for the fake carries the labels; a test builds the fake from the filter API's contract (lane 28's file, copied as a fixture) and asserts each operation's example answer, the 501, and the call counter; a checkout test makes two temporary repositories and asserts the same branch on both, and the folder kind's `cwd`; on this server, labelled, the doctor's `workspace` section starts a session with a real postgres, a real sibling built from the guestbook's Dockerfile and a fake filter API, proves from inside the session that the sibling answers on its name and the fake answers an example, and that `stop` leaves nothing with the session label; the raw lines are in the pull request.
- **Dependencies**: lanes 14 (the workspace config) and 28 (the contract, copied as a fixture).
- **Author**: Opus 5.5. **Interface lane**: no.

#### Lane 16: `v2-j2-workspace-lock`

- **Goal**: decision 21: the brokers per service (`CLEARED_V2_BROKER_SOCKETS`, `SocketReleaseBroker` chosen by service), `release_trains` in `v2/src/release/` (store, order from `consumes`, the landing loop in the flow's tick, the health read per service from its ledger, the reverse rollback), the release item of the inbox carrying its services and the train's state, the compatibility check at publish (the card blocked with the proposal), the flow's publish per service (one pull request per touched service, the same branch), the `review` record per pull request; the API types: `ReleaseItem.train`, `TrainState`; the one-service case unchanged in behaviour (a test says so by diffing the milestone 1 flow test's events).
- **Files**: `v2/src/release/**` (new), `v2/src/approval/{broker,service,route}.ts`, `v2/src/flow/{engine,effects,events,ledger}.ts`, `v2/src/inbox/store.ts`, `v2/src/modules/{approval,flow}.ts`, `v2/src/api/types.ts`, `serve/release-broker.mjs` (the one-line rollback change, only if needed, reviewed as a security change), tests under `v2/test/release/`, `v2/test/flow/`, `v2/test/approval/`.
- **Acceptance proof**: on the fake adapter with fake brokers, a two-service ticket lands in order (the provider's broker called first, the consumer's only after the provider's ledger says healthy), the gaps asserted; a provoked failing watch on the consumer asserts its auto rollback is read, then `request_rollback` on the provider, the train `reverted` in reverse order, the ticket back in Todo with the note, the `rolled_back` event once for the train; a contract file changed with no step on a consumer blocks the item and the approval route answers 409 with the proposal; the one-service ticket produces the same events as before; the milestone 1 and 2 suites stay green; on this server, `merge-pr.sh --dry-run` through two brokers on two temporary repositories reaches "would merge" in order (a fake `gh`); the raw lines are in the pull request.
- **Dependencies**: lane 14.
- **Author**: Opus 5.5. **Interface lane**: no.

### 4.4 The milestone 1 catch-up

#### Lane 17: `v2-j2-session-plan-gate`

- **Goal**: decision 22 (complement items 8 and 9): the author's host tools `propose_session_plan` and `report_changes` (`v2/src/flow/author-tools.ts`, declared as data like the lead's), the `cleared.session_plan` and `cleared.changes` events, the `plan_gate` step, the `session_plan` inbox item (Go, Change), the delay per service, the lead's Go for a high confidence of a plan item, the author's prompt asking for the plan first and the report at the end; the API types of this wave: `SessionPlanItem`, `SessionState.plan` (steps, files, confidence, reason, go: by whom and when), `ReleaseItem.groups` and `flags` (lane 18 fills them), `PlanItem.sensitivity` (lane 18), `ServiceSensitivity`.
- **Files**: `v2/src/flow/{engine,prompts,author-tools}.ts`, `v2/src/inbox/store.ts`, `v2/src/session/events.ts` (the two custom names), `v2/src/api/types.ts`, `v2/src/lead/plans/runner.ts` (the lead's Go), tests under `v2/test/flow/`, `v2/test/session/events.test.ts`.
- **Acceptance proof**: on the fake adapter, a scripted author proposes a plan with `high` and no Go comes for 10 minutes of fake time: the author starts by itself and the step `plan_gate` is closed "by the delay"; with `medium`, it still waits at 11 minutes and the inbox item is there; a Go from the route closes it "by the owner"; a Change reopens the author with the message and the next proposal replaces the first; a ticket started by the lead with `high` starts at once "by the plan"; a reopened author after a review proposes nothing; `report_changes` with a file in two groups is refused and the rest go to "Other changes"; every flag has a test on a planted diff; a session that never calls the tool is held at most `plan_go_minutes` then put back with a note, not started.
- **Dependencies**: lanes 14, 16 (the release item's shape).
- **Author**: Opus 5.5. **Interface lane**: no.

#### Lane 18: `v2-j2-release-intent-sensitivity`

- **Goal**: decision 23's service side (the groups and flags on the release item from the author's report and the diff, the `contract` flag from lane 16's check) and decision 24 (complement multi-repository item 8): sensitivity per service in the workspace config, the fast lane refused on a `full` service, the reviewer model per service, the approver per service in the approval route, the sensitivity on plan items from the services their body names, the lead's rules paragraph.
- **Files**: `v2/src/release/**`, `v2/src/approval/{route,service}.ts`, `v2/src/workspace/config.ts`, `v2/src/lead/plans/{tools,estimates,store}.ts`, `v2/src/lead/prompts.ts`, tests under `v2/test/release/`, `v2/test/approval/`, `v2/test/lead/plans/`.
- **Acceptance proof**: tests prove the groups are built from the report, the `large`, `schema`, `dependency`, `config` and `contract` flags from planted diffs; a fast item naming a `full` service becomes full with its note; a `reviewer:claude-opus-5-5` service with an Opus author is refused at configuration; a `human:<user>` service makes the owner's approval answer 403 naming the user, and that user's approval pass; the plan panel's data carries the chip; the prompt test asserts the paragraph.
- **Dependencies**: lanes 14, 16, 17 (the types, written in lane 17 from this plan).
- **Author**: Opus 5.5. **Interface lane**: no.

#### Lane 19: `v2-j2-memory-levels`

- **Goal**: decision 25 (complement multi-repository item 1's memory): the three memory levels through `lib/memory` in three state directories, the briefing per service and per contract, the handover's lessons filed by level, the lead's briefing reading the service pages' first lines, `docs/memory.md` with a v2 section.
- **Files**: `v2/src/workspace/{briefing,handover}.ts`, `v2/src/lead/briefing.ts`, `v2/src/flow/effects.ts` (the call passing the ticket's services), `docs/memory.md`, tests under `v2/test/workspace/`, `v2/test/lead/briefing.test.ts`.
- **Acceptance proof**: a test with three temporary memories asserts the briefing's sections in order (workspace, service, contract) within the byte budget and the reference-data line once; a handover with the three lessons sections files each in its level; a one-service workspace with no service memory yet produces the milestone 1 briefing byte for byte; the lead's briefing test asserts the service lines.
- **Dependencies**: lane 14.
- **Author**: Opus 5.5. **Interface lane**: no.

#### Lane 20: `v2-j2-session-tabs`

- **Goal**: decision 30 (complement item 1, and the Browser tab of multi-repository item 3): the four tabs on the session screen, the Plan tab with the session plan, its confidence, Go and Change (lane 17's item), the Editor tab (the changed files' diffs through `GET /api/sessions/:id/files` and `.../files/*`, a service route this lane adds under `v2/src/flow/files.ts` with the cleaner and a 400-line cap), the Browser tab on the app's proxy of lane 15's preview route, "Take over" and "Give back" (`POST /api/sessions/:id/takeover` and `giveback` in `v2/src/flow/takeover.ts`, the command shown with the container's name), the service line on the screen ("on filter-api"), the catalogs, the fixture.
- **Files**: `v2/app/web/screens/session/**`, `v2/app/messages/session.{en,fr}.json`, `v2/app/fixtures/session.ts`, `v2/app/src/proxy.ts` (the preview path), `v2/app/test/session/**`, `v2/src/flow/{files,takeover}.ts` (new), `v2/src/modules/flow.ts` (their registration), tests under `v2/test/flow/`.
- **Acceptance proof**: model tests for each tab on the fixture; a test that the files route refuses a path outside the checkout, a `.env`, and cuts at 400 lines with the line saying so; a test that takeover interrupts, settles the waiting requests as cancelled, marks the session `paused` and that giveback resumes it (the fake adapter's `resume` called with the same id); a browser test on the fixtures source switches the four tabs and clicks Go; the visual loop on `session.png` at the four widths, light and dark, with the art-director pass; fr complete.
- **Dependencies**: lanes 12, 13, 15, 17.
- **Author**: Opus 5.5. **Interface lane**: yes.

#### Lane 21: `v2-j2-inbox-train`

- **Goal**: the inbox's part of decisions 21, 22, 23 and 24 (complement item 10, multi-repository item 5): the release card as a train (the services in landing order with each one's state and pull request, the compatibility line or block, the intent groups with their files and the flags as chips), the `session_plan` item (the plan, the confidence with its reason, Go and Change), the `contract` item's shape reserved for lane 27, the handled states, the catalogs, the fixtures.
- **Files**: `v2/app/web/screens/inbox/**`, `v2/app/messages/inbox.{en,fr}.json`, `v2/app/fixtures/inbox.ts`, `v2/app/test/inbox/**`.
- **Acceptance proof**: rendering tests on the fixture for a two-service train in each state (waiting, landing, landed, rolled back, blocked), for the groups and flags, for the session plan item; a test that the blocked card has no Approve; a test that Go calls the route; the visual loop on `inbox.png` at the four widths, light and dark, with the art-director pass; fr complete.
- **Dependencies**: lanes 12, 13, 16, 17, 18 (against fixtures during the wave).
- **Author**: Opus 5.5. **Interface lane**: yes.

#### Lane 22: `v2-j2-plan-flags-screens`

- **Goal**: the lead and tower parts of decisions 18 and 24: the plan panel's sensitivity chip per item and the services an item names, the tower's workspace line (the services with their state: live sessions, a landing in progress, a train rolled back), the ticket creation from the bar naming services (a chip per service), the lead screen's thread lines for a train and a block, the catalogs, the fixtures.
- **Files**: `v2/app/web/plan-panel/**`, `v2/app/web/screens/lead/**`, `v2/app/web/screens/tower/**`, `v2/app/messages/{lead,tower}.{en,fr}.json`, `v2/app/fixtures/{lead,tower,source}.ts` (the fixtures source answers `GET /api/workspace`), `v2/app/test/lead/**`, `v2/app/test/tower*.test.ts`, `v2/app/test/fixtures.test.ts`.
- **Acceptance proof**: rendering tests on the fixtures; a test that creating a ticket with two services posts both; the visual loop on `tower.png` and `lead-and-plan.png` at the four widths, light and dark, with the art-director pass; fr complete.
- **Dependencies**: lanes 12, 13, 14, 18.
- **Author**: Opus 5.5. **Interface lane**: yes.

### 4.5 The milestone 2 additions

#### Lane 23: `v2-j2-ticket-steps`

- **Goal**: decision 26 (complement multi-repository item 2): `ticket_steps`, the contract step and its `contract` inbox item, the service steps with their fakes built from the validated contract, the integration step, the steps' dependencies and the flow's tick running them (at most the plan's `maxParallel` sessions per ticket), the estimates per step, the lead's `propose_plan` accepting `steps` per item and the plan's cost per step, the lead's rules paragraph; the API types of this wave: `TicketStep`, `ContractItem`, `KnowledgeItem` (lane 24), `Ask` and `AskAnswer` (lane 25), `Recipe`, `Schedule` (lane 26), the routes of lanes 24 to 26 named in `API_ROUTES`.
- **Files**: `v2/src/flow/**`, `v2/src/lead/plans/**`, `v2/src/lead/prompts.ts`, `v2/src/inbox/store.ts`, `v2/src/api/types.ts`, tests under `v2/test/flow/`, `v2/test/lead/plans/`, `v2/test/api/`.
- **Acceptance proof**: on the fake adapter, a two-service ticket runs the contract step, waits for the item, is sent back once (the step reopened with the message), validated, runs the two service steps in parallel with a fake each (the runtime's spec asserted), then the integration with real siblings, then one release card; a one-service ticket runs one step and the same events as before; the estimates give a cost per step and the plan's totals add them; `propose_plan` refuses a step naming an unknown service; a step that fails holds the ticket's others and tells the lead.
- **Dependencies**: lanes 15, 16, 17.
- **Author**: Opus 5.5. **Interface lane**: no.

#### Lane 24: `v2-j2-knowledge-skills`

- **Goal**: decision 27 (complement item 2, multi-repository item 7): the `knowledge` module (`MODULE_NAMES` gains `knowledge`, the one allowed edit of the registry and `main.ts` in this wave), the proposals from a handover, the inbox item with Approve and Reject, the write into `lib/memory` at the level, the queue per service, the daily skill ticket (fast lane, Haiku) writing `SKILL.md`, the skills under `.claude/skills/` mounted into the session read-only, "Update the skill now" on the tower's lead card as a route.
- **Files**: `v2/src/knowledge/**` (new), `v2/src/modules/{knowledge,registry}.ts`, `v2/src/main.ts`, `v2/src/workspace/handover.ts`, `v2/src/container/session-runtime.ts` (the skills mount only), tests under `v2/test/knowledge/`, `v2/test/modules/registry.test.ts` (nine modules), `v2/test/container/session-runtime.test.ts`.
- **Acceptance proof**: a handover with two lessons and one decision produces three items; Approve writes the entry (asserted by reading the memory back) and queues it; Reject writes nothing; the daily ticket is created with the queued entries in its body and the `Quick` label, once per service per day, and not when the queue is empty; the `SKILL.md` the ticket's author is asked for is validated by a test on its front matter; a session's container has the skills folder mounted read-only (the command line asserted); a test proves an entry's text goes through the cleaner.
- **Dependencies**: lanes 14, 19.
- **Author**: Opus 5.5. **Interface lane**: no.

#### Lane 25: `v2-j2-ask-code`

- **Goal**: decision 28 (complement items 11 and multi-repository item 9): the `reader` role in the contract and the policy (the reviewer's rows, no edit, no commit, no push, plus `lead.read_cap`'s 400-line cap), the platform workdir (every service's checkout, read-only mounts), the `asks` table and routes (`POST /api/asks`, `GET /api/asks/:id`, `POST /api/asks/:id/follow`), the briefing with the question and the named file's lines, the cost on the answer (`total_cost_usd`, tokens, the week share when the window is measured), the idle stop.
- **Files**: `v2/src/reader/**` (new), `v2/src/session/{contract,policy}.ts`, `v2/src/modules/sessions.ts` (the routes' registration), tests under `v2/test/reader/`, `v2/test/session/policy.test.ts`.
- **Acceptance proof**: policy rows have one test each for `reader`; a scripted reader answers a question naming `guestbook:src/page.ts:12` and the briefing holds lines 2 to 22; the answer carries the cost of its turn; a follow-up adds a turn and its cost to the sum; an `Edit` by a reader is denied; the platform workdir mounts every service read-only (the command line asserted); on this server, one real ask on the guestbook with `claude-haiku-5-5`, its cost line in the pull request.
- **Dependencies**: lanes 14, 15.
- **Author**: Opus 5.5. **Interface lane**: no.

#### Lane 26: `v2-j2-recipes-schedules`

- **Goal**: decision 29 (complement items 7 and 12): the recipes read at each service's base branch (`v2/src/recipes/`), their routes (`GET /api/recipes`, `POST /api/recipes/:name/run`), the parameters' substitution and validation, the `schedules` table and routes (`GET`, `POST`, `DELETE /api/schedules/:id`), the scheduler's tick, the budget and the week cap on the run, the `schedule_ran` and `schedule_failed` events for the notifications (`health` kind), the lead told once when a schedule starts a plan.
- **Files**: `v2/src/recipes/**` (new), `v2/src/schedules/**` (new), `v2/src/modules/lead.ts` (their registration with the plan runner), `v2/src/notify/sources.ts` (the two events), tests under `v2/test/recipes/`, `v2/test/schedules/`, `v2/test/notify/`.
- **Acceptance proof**: a recipe file with two parameters runs as a one-item plan with the substituted body and the labels, a missing parameter is refused, a recipe with `{{` in its name is refused, a goal recipe sends an owner turn; a schedule `every: day 03:00` runs at the first tick past 03:00 and not twice, with the budget on the ticket, and is skipped with a `schedule_failed` event when the week share is at the stop; a disabled schedule never runs; a schedule's creator is the plan's approver.
- **Dependencies**: lanes 23 (the types), 17.
- **Author**: Opus 5.5. **Interface lane**: no.

#### Lane 27: `v2-j2-additions-screens`

- **Goal**: the app's part of decisions 26 to 29: the ticket's steps on the session screen's Plan tab and on the tower's live sessions ("step 2 of 4, filter-api"), the `contract` item in the inbox (the diff, Approve, Send back) and the `knowledge` item (the text, its level, Approve, Reject), the `/ask/:id` screen (the question, the answer, the cost line, the follow-up field) and "Ask about the code" in the tower bar, "Run a recipe" in the bar with the parameters' form, the schedules in the tower's plans card ("next run at"), the catalogs, the fixtures.
- **Files**: `v2/app/web/screens/**`, `v2/app/web/shell/**` (the bar's two entries), `v2/app/messages/*.json`, `v2/app/fixtures/*.ts`, `v2/app/src/catalog.ts` (the `ask` screen), `v2/app/test/**`.
- **Acceptance proof**: rendering tests on the fixtures for each new item and screen; a test that Approve on a contract item calls its route and the item leaves the list; a test that the recipe form refuses a missing parameter before posting; the visual loop on the four captures at the four widths, light and dark, with the art-director pass (the new screen follows `app/DESIGN.md`, with no capture); fr complete.
- **Dependencies**: lanes 20, 21, 22, 23; lanes 24 to 26 for the live run.
- **Author**: Opus 5.5. **Interface lane**: yes.

### 4.6 The proof

#### Lane 28: `v2-j2-filter-api-example`

- **Goal**: the second example under `examples/filter-api/`: a Node web app with no framework (`node:http`, TypeScript) answering `POST /check` with `{ text }` to `{ ok, words }` from a word list in `words.txt`, `/health`, tests with `node --test`, its `contract/openapi.yaml` with an example per operation, a `Dockerfile`, a `.devcontainer/devcontainer.json`, a `.github/workflows/checks.yml`, a `.cleared/agents.conf` (the six states, `[release] health_url` on its port, the demo window, `[session]` with no service, `[merge] verdict`), a `README.md` saying what the proof's tickets change and the `PROOF_BREAK_HEALTH` switch, and a `deploy/watch.ts` as the guestbook's; the guestbook consuming it when `FILTER_URL` is set (an entry the filter refuses is refused with the words; unset, no call), its `.cleared/agents.conf` gaining nothing, its tests covering both cases with a fake filter in the test; the workspace file of the two services as the proof will use it, under `examples/workspace.conf`, with `consumes = filter-api` on the guestbook and `contract = openapi:contract/openapi.yaml` on the filter API.
- **Files**: `examples/filter-api/**` (new), `examples/guestbook/{src,test,README.md,package.json}`, `examples/workspace.conf` (new).
- **Acceptance proof**: `npm test` of both examples passes locally; the filter's `watch.test.ts` asserts the labels on every docker command line as the guestbook's does; the port is free on this server on the day the lane runs (`ss -ltn` in the pull request); the contract validates against the OpenAPI 3.1 schema in a test with no dependency (a structural check of the keys the fake reads); the guestbook's README names the three proof tickets of section 2.2 as the owner will create them.
- **Dependencies**: none. The repository on the forge is question 1 and is needed only for the proof.
- **Author**: Opus 5.5. **Interface lane**: no.

#### Lane 29: `v2-j2-proof-scripts-m2`

- **Goal**: the proof script of pull request 181 adapted to the React screens (the same steps, the clicked answers of step 2, the Go of step 5, the grouped card of step 7), and `v2/scripts/proof-j2-multi.ts` driving section 2.2 through the browser (the two-service workspace started from `examples/workspace.conf`, the three tickets, the contract validation, the Browser tab's fake, the train's landing, the provoked rollback, the blocked card), with a rehearsal mode on the fake adapter and two lock stand-ins; `proof-report.ts` extended with the train's times and the fake's calls; `durations.md` for both.
- **Files**: `v2/scripts/proof-*.ts`, `v2/src/session/adapters/index.ts` (the rehearsal's two services), tests under `v2/test/scripts/`.
- **Acceptance proof**: the pure parts tested; a rehearsal of each proof against the service and the app on the fake adapter completes every step and writes its `durations.md`; the real runs are the milestone proofs, by the orchestrator, after the waves (section 4.8).
- **Dependencies**: lanes 20, 21, 27, 28, 23, 16.
- **Author**: Opus 5.5. **Interface lane**: no.

### 4.7 Lanes to come in milestones 3, 4 and 5

Not planned here, as the owner decided: complement items 6, 13, 14, 19 and multi-repository item 4 (milestone 3); items 3, 5, 17 and multi-repository item 6 (milestone 4); items 4, 15, 16, 18 and multi-repository item 10 (milestone 5). "Working from the phone" and "service integrations beyond the harness's MCPs" are not taken.

### 4.8 Waves

At most three lanes run at once, and lanes in one wave never edit the same file. The waves continue the first plan's numbering.

| Wave | Lanes | The file `v2/src/api/types.ts` belongs to | Needs before it starts |
| --- | --- | --- | --- |
| 5 | 12 react-port (`v2/app/**`, `v2/package*.json`, the workflow), 14 workspace-store (`v2/src/{store,tickets,workspace/config.ts,flow/config.ts,api}`), 28 filter-api-example (`examples/**`) | 14 | pull request 181 merged |
| 6 | 13 choices (`v2/app/web/**` named files, `v2/src/lead/prompts.ts`), 15 workspace-runtime (`v2/src/container/`, `v2/src/workspace/checkout.ts`, `v2/src/flow/runtime.ts`, `v2/images/fake/`, `doctor.ts`), 16 workspace-lock (`v2/src/release/`, `v2/src/approval/`, `v2/src/flow/{engine,effects,events,ledger}.ts`, `v2/src/inbox/store.ts`) | 16 | wave 5 merged |
| 7 | 17 session-plan-gate (`v2/src/flow/{engine,prompts,author-tools}.ts`, `v2/src/inbox/store.ts`, `v2/src/session/events.ts`, `v2/src/lead/plans/runner.ts`), 18 release-intent-sensitivity (`v2/src/release/`, `v2/src/approval/`, `v2/src/workspace/config.ts`, `v2/src/lead/plans/{tools,estimates,store}.ts`, `v2/src/lead/prompts.ts`), 19 memory-levels (`v2/src/workspace/{briefing,handover}.ts`, `v2/src/lead/briefing.ts`, `v2/src/flow/effects.ts`, `docs/memory.md`) | 17 | wave 6 merged |
| 8 | 20 session-tabs (`v2/app/web/screens/session/`, `v2/app/src/proxy.ts`, `v2/src/flow/{files,takeover}.ts`, `v2/src/modules/flow.ts`), 21 inbox-train (`v2/app/web/screens/inbox/`), 22 plan-flags-screens (`v2/app/web/plan-panel/`, `screens/lead/`, `screens/tower/`) | none | wave 7 merged |
| 9 | 23 ticket-steps (`v2/src/flow/`, `v2/src/lead/plans/`, `v2/src/lead/prompts.ts`, `v2/src/inbox/store.ts`), 24 knowledge-skills (`v2/src/knowledge/`, `v2/src/modules/{knowledge,registry}.ts`, `v2/src/main.ts`, `v2/src/workspace/handover.ts`, `v2/src/container/session-runtime.ts`), 25 ask-code (`v2/src/reader/`, `v2/src/session/{contract,policy}.ts`, `v2/src/modules/sessions.ts`) | 23 | wave 8 merged |
| 10 | 26 recipes-schedules (`v2/src/{recipes,schedules}/`, `v2/src/modules/lead.ts`, `v2/src/notify/sources.ts`), 27 additions-screens (`v2/app/web/**`, `v2/app/src/catalog.ts`), 29 proof-scripts-m2 (`v2/scripts/proof-*.ts`, `v2/src/session/adapters/index.ts`) | none | wave 9 merged |

A wave starts when the whole previous wave is merged and the quota allows it (decision 31); a slot freed early stays empty. Each wave's messages and fixtures under `v2/app/` are edited by the app lanes of that wave only, each on its own screen's files; the shell's files (`v2/app/web/shell/**`) belong to lane 12 in wave 5 and lane 27 in wave 10. Files that two lanes touch are touched across waves only: `v2/src/flow/engine.ts` (16, 17, 23), `v2/src/flow/effects.ts` (16, 19), `v2/src/inbox/store.ts` (16, 17, 23), `v2/src/lead/prompts.ts` (13, 18, 23), `v2/src/lead/plans/runner.ts` (17, 23), `v2/src/workspace/config.ts` (14, 18), `v2/src/container/session-runtime.ts` (15, 24), `v2/src/modules/registry.ts` and `main.ts` (24 only), `v2/src/session/adapters/index.ts` (29 only), `v2/scripts/doctor.ts` (15 only), `v2/package.json` (12 only).

The proofs: the 48-hour guestbook proof runs after wave 8 by default (question 7), with no lane during its 48 hours, with Haiku fix lanes for what it finds before wave 9 starts; the multi-service proof runs after wave 10, once the second repository exists (question 1). Then, after the owner's go, one goal on the first piloted project, which is not part of this plan.

## 5. The quota cost of the replan

The measure so far: milestone 1 and waves 1 to 4 of milestone 2 used about 4 points of the weekly quota per wave of three lanes, reviews and fix lanes included, so about 1.3 points per Opus lane. An interface lane costs a little more (the visual loop and the art-director pass); a Haiku fix lane about 0.3; the React port is already partly spent.

| Lane | Kind | Estimate, points of the week |
| --- | --- | --- |
| 12 react-port (remaining) | interface, large | 2.0 |
| 13 choices | interface | 1.5 |
| 14 workspace-store | core | 1.3 |
| 15 workspace-runtime | core, with a real run | 1.5 |
| 16 workspace-lock | core, with a real run | 1.5 |
| 17 session-plan-gate | core | 1.3 |
| 18 release-intent-sensitivity | core | 1.3 |
| 19 memory-levels | core, small | 1.0 |
| 20 session-tabs | interface | 1.5 |
| 21 inbox-train | interface | 1.5 |
| 22 plan-flags-screens | interface | 1.5 |
| 23 ticket-steps | core, large | 1.5 |
| 24 knowledge-skills | core | 1.3 |
| 25 ask-code | core, with a real run | 1.3 |
| 26 recipes-schedules | core | 1.3 |
| 27 additions-screens | interface, large | 2.0 |
| 28 filter-api-example | core, small | 1.0 |
| 29 proof-scripts-m2 | core | 1.3 |
| Haiku fix lanes, about eight | fixes | 2.5 |
| The 48-hour proof (the lead on Opus for two days, five tickets, rehearsals) | proof | 4.0 |
| The multi-service proof (three tickets, two rehearsals) | proof | 2.0 |
| **Total** | | **about 34 points, 26 of them for the six waves** |

Per wave: 5 is 4.3, 6 is 4.5, 7 is 3.6, 8 is 4.5, 9 is 4.1, 10 is 4.6, before the fix lanes. With the 85 % rule, the six waves and the two proofs do not fit in what remains of the current week if more than about 50 points are already spent; the orchestrator reads the share before each wave (decision 31) and the waves that do not fit wait for the week's reset. The measured cost of each lane goes into the daily report, and this table is corrected in the decisions log when a wave lands.

## 6. Questions for the owner

Grouped as the brief asks, with a recommendation. The orchestrator sends them in its next report; everything else proceeds with the default named.

1. **A second example repository, for the multi-service proof.** The lock reads pull requests through `gh` and merges on the forge, so the filter API needs a repository of its own. Options: (a) a new public repository, `cleared-example-filter-api`, in the organisation this repository lives in, Apache-2.0, seeded from `examples/filter-api/` on `v2` and kept in sync by hand as the guestbook's is, recommended: it proves the multi-repository case the complement describes; (b) a folder `filter-api/` in the guestbook's repository, which proves only the monorepo-folder kind (the folder kind is also covered by a unit test); (c) no second repository, and the multi-service proof deferred to milestone 3. No default: creating a repository is outward facing and the owner's gesture. Needed before the multi-service proof, not before any lane.
2. **The https address for the Mac's notifications**, unchanged from the first plan: (a) `tailscale serve --bg --https=8443 http://127.0.0.1:8792` on the tailnet, with `CLEARED_NOTIFY_LINK_BASE` set, recommended; (b) no Mac notifications in the proof; (c) ntfy on the phone. Default while unanswered: (b), the step recorded as skipped.
3. **Taking over a session in a terminal.** Options: (a) the app shows the command to run in a shell on the server, recommended: no new listener, no new dependency, the brief's own wording; (b) a web terminal in the app (a terminal component, a WebSocket to the container), a later milestone. Default: (a).
4. **The Editor tab.** Options: (a) read-only in milestone 2: the changed files' diffs and a file viewer, recommended: an edit by the owner would bypass the session's policy and the review, and the owner can take over for that; (b) an editable editor (a large dependency and a new write path to the checkout). Default: (a).
5. **The contract formats of milestone 2.** Options: (a) OpenAPI 3 only, the fake built from its examples, recommended: it covers the two examples and the complement's reference case; (b) OpenAPI plus JSON Schema events; (c) protobuf too, which needs a toolchain in the fake image. Default: (a); (b) and (c) in milestone 3.
6. **Approved knowledge into the skill.** Options: (a) a daily fast-lane ticket per service writes the skill file, through the lock, recommended: no change lands without the lock, and the skill stays reviewed; (b) the service commits to the base branch itself, which breaks that rule; (c) memory only, the skill never written, which is not what the complement asks. Default: (a).
7. **When the 48-hour proof runs.** Options: (a) after wave 8, before the additions, recommended: the proof's steps need nothing of waves 9 and 10, its two quiet days let the week's quota breathe before the last two waves, and what it finds is fixed before the additions build on it; (b) after wave 10, with the multi-service proof. Default: (a).
8. **The lead's model, the quiet hours and the goal of the proof** keep the first plan's defaults ((a) in each case) unless the owner says otherwise; no new question.

## 7. Out of scope for milestone 2

Codex, Cursor and the handover between harnesses (milestone 3), two sessions on one ticket, notes between the sessions of a ticket and a contract change reopening the contract step (multi-repository item 4, milestone 3), the services map and the impact analysis (item 6, milestone 4), connecting a workspace with setup sessions and the GitLab adapter (item 10, milestone 5), the fast lane's real-diff rules and the approval asked while the checks run (milestone 4), stacked branches, the Linear and GitHub Issues mirrors, the removal of v1 files, a two-model lead, the morning digest as a document, the installer and `cleared doctor` as a product command, partial message streaming, the tickets screen, an editable editor and a web terminal (questions 3 and 4), contract formats other than OpenAPI 3 (question 5), a run on the first piloted project before the owner's go.

## 8. Unknowns, and who closes them

| Unknown on 2026-10-22 | Closed by |
| --- | --- |
| Whether CopilotKit's headless entries render the interrupt without its stylesheet, and the bundle's size | lane 12 |
| Whether a sibling built from a checkout inside the session's internal network can be built without the egress proxy (the build's package downloads) | lane 15 |
| Whether the broker's `request_rollback` accepts the service's account under `allow_shared_uid` | lane 16 |
| Whether `merge-pr.sh` run by two brokers at once on two repositories shares any state file | lane 16 |
| How long the fake's build and the real sibling's build add to a session's start | lane 15, then the proof |
| Whether the author proposes a plan before reading the code, or after, and how long the gate adds | lane 17, then the proof |
| How many knowledge items a night produces, and how many the owner approves | the proof |
| Web Push from the v2 app through the tailnet's https address | the proof, after question 2 |
| The quota already spent this week, and whether the six waves fit before the reset | the orchestrator, before wave 5 |
