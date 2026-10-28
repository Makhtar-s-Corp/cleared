## 2026-10-23: Cursor harness on the session adapter contract (lane j3-cursor-harness)

**Decision.** The author of the lane added a Cursor adapter beside Claude Code (matrix B5.1c, O6, B6.3 for its Cursor part, P42). These are the author's choices, not the owner's decisions; the owner's real trial is open.

- **Driving.** `agent -p --output-format stream-json`, one process per message in the session's container, resumed on the chat id Cursor names in its first line. No SDK exists for it.
- **Guard.** Print mode has no way to hold a call for a person, so the adapter fails closed in two layers: the policy compiled into Cursor's permissions file (deny first, never `--force`), and the unchanged policy evaluated on every reported call, which ends the turn on a deny and on an ask. A tripwire, not a prevention; stated in `docs/adapters.md`.
- **Usage.** Cursor's documented stream has no tokens and no cost: the run reports the model and a null cost, and nothing is estimated.
- **Take over.** The running turn ends, the terminal runs `agent --resume <chat> --model <model>` through a launcher that reads the key file inside the container, messages wait for Give back, and the next turn resumes the chat.
- **Login.** A Cursor API key file only. The host's browser login (owner note of 2026-10-22) is not used: where it lives is unverified.
- **Not done.** `images/session/Dockerfile` has no Cursor program (no pinned install source). Codex has no v2 adapter. Hand over, cross-harness review and two sessions on one ticket are not delivered.
- **Resources.** No Docker object was created, no port opened, no Cursor account used. The proof run, its state folder and its service were not touched.
- Author: Sonnet 5.5 (claude-sonnet-5-5), lane `j3-cursor-harness`.

## 2026-10-24: a ticket's author and reviewer settle a review in their own channel, three rounds by default (the author's choices, lane `j3-review-channel`, issue #291)

**The need.** Before this lane, the review loop already reopened the author with the report. But each round after the first started a new reviewer, with no memory of its own report and without the author's answer. Neither the exchange nor the author's side of it was shown anywhere: the flow's messages are hidden from the session screen. Two requests for change sent the ticket back to Todo (`CLEARED_V2_REVIEW_ROUNDS`, 2 by default). Issue #291 asks for a channel per ticket between the author and the reviewer, a bounded number of rounds before any return to Todo, every exchange in the ledger and on the screen, in French and in English.

**Decision.**
1. **The channel is the review loop, not a second mechanism beside it.**
   - A request for change goes to the author's session, resumed, as before; if it cannot be resumed, a new author gets the report.
   - When the author's turn ends, its last message goes back to **the same reviewer's session**, resumed under its own id. The message asks the reviewer to read the new commits, check each defect it listed, and give its full report again with its Verdict line. Both sides' messages are framed as reference data, not instructions.
   - The resumed reviewer's verdict is read from its new turn only. A turn with no Verdict line is "no verdict", never the earlier report read again.
   - If the reviewer cannot be resumed, a new reviewer gets the review prompt followed by the channel so far.
   - The code is in `v2/src/flow/channel.ts` and in the review path of `v2/src/flow/engine.ts` (`#reviewDone`, `#reopenAuthor`, `#authorDone`, `#answerReviewer`, `#startReview`).
2. **A round is a verdict, and one setting bounds the rounds.**
   - Rounds are counted from the `cleared.review_verdict` rows of the current flow's reviewers, since a resumed reviewer gives several verdicts in one session. A ticket put back and started again still begins at round 1.
   - `CLEARED_V2_REVIEW_ROUNDS` keeps its meaning, the verdicts a flow allows, and its default goes from 2 to 3: two exchanges in the channel, then the third verdict.
   - Not chosen: a second setting counting exchanges beside the rounds. Two limits on one loop would contradict each other.
3. **The bounce is unchanged.** A request for change at the last round puts the ticket back in Todo through the same `#putBack`, with reason `too_many_rounds` and the last report as the note. Lane `j3-autonomy` (issue #290) handles the third attempt after two put backs from what the flow says, so this lane does not touch the retry logic, the plan runner or the put back's reason and note.
4. **The ledger and the screen.**
   - Each message is a `cleared.review_channel` event: its round, the limit, the side it comes from, and its text through the service's cleaner. It is journaled on the sender's session and on the receiver's, so each is a row of `session_events` in ledger.db. No new table and no migration.
   - The session screen shows it as a row that opens to the text, for example "Reviewer to author: changes asked, round 1 of 3", or "De l'auteur au relecteur : réponse, tour 1 sur 3 · répondu en 12 min". The wait is a duration of `app/web/lib/time.ts`.
   - The whole ticket shows each message once, on the session it reached. The Author and Reviewer filters show what that role sent and received.
5. **The proofs follow.** The proof report counts a ticket's review rounds by its verdicts; for a reviewer that gave none, by its sessions as before. The j1 proof's review step follows the latest reviewer session, which can be the same one from round to round, up to `PROOF_REVIEW_ROUNDS` (3 by default).

**Consequences.**
- On a real Claude Code session the second round costs a resumed reviewer's turn, with its first report in context, instead of a whole new review.
- The one-service fixture (`v2/test/flow/fixtures/one-service-events.json`) was written again. It now has one reviewer session, not two, with the channel rows and the resumed review step. Nothing else in it changed.
- The rehearsal adapter (`v2/src/session/adapters/index.ts`) resumes every session with the author's reopen steps. Its scripted reviewers pass at the first round, so no rehearsal resumes a reviewer; a rehearsal that scripts a request for change will need a reviewer's resume script.
- Author: Opus 5.5 (claude-opus-5-5), lane `j3-review-channel`.

## 2026-10-24: Owner decision: the endurance proof shortened to 24 hours, then stopped early at step 07

**Decision.** On 2026-10-23 at 23:06 (Europe/Paris), at the owner's request, the endurance proof launched at 19:52 (the plan-2 entry above) was shortened from 48 hours to 24 hours.

**Outcome.**
- On 2026-10-24 at 15:45 the proof was stopped early: it had been stuck at step 07 since 08:47.
- What held it:
  - LOCAL-39, LOCAL-40 and LOCAL-41 were held after two bounces to Todo, and only the lead or the owner could start them again.
  - LOCAL-42 was waiting on a question to the owner.
- Result: 7 of 9 steps passed. Steps 07 and 08 were not reached.
- The fix is the lane `j3-autonomy` (issue #290): its entry below.

- Recorded by: Opus 5.5 (claude-opus-5-5), lane `j3-autonomy`.

## 2026-10-24: Orchestrator decision of 16:25: the end of the proof, and the cleanup

**Decision.** On 2026-10-24 at 16:25 (Europe/Paris), the orchestrator, not the owner, recorded the end of the endurance proof and its cleanup.

**What was done:**
- The proof service on 8791 and the app on 8792 were stopped with SIGTERM.
- Two sessions were stopped through Cleared's `stopSession()`, which filters on `cleared.dev=v2`:
  - `33602332`, plan-2's lead: 2 containers and 2 networks.
  - `23652120`, LOCAL-42's session: 3 containers and 2 networks.
- The proof's release broker and its watchers were stopped.
- The first piloted project's production was checked and is unchanged.
- No secret was printed or written.

**Consequences.**
- The proof's deploy containers are kept: `cleared-guestbook`, `cleared-filter-api` and `cleared-guestbook-db`.

- Recorded by: Opus 5.5 (claude-opus-5-5), lane `j3-autonomy`, at the orchestrator's request.

## 2026-10-24: a plan no longer freezes on a bounced ticket, an unanswered question or an idle session (the author's choices, lane `j3-autonomy`)

**The defect** (issue #290, the endurance proof above). Three rules each left a plan waiting for a person with no end:
- **Bounces.** A ticket put back twice held its item, and only start_ticket or the owner started it again. LOCAL-39, 40 and 41 waited there from 08:47.
- **Questions.** A team's question waited for the owner with no delay. LOCAL-42 waited about 7 hours, and its item, still `running`, kept its slot in the plan.
- **Idle sessions.** The flow's idle stop skips a session that waits for a person, so LOCAL-42's session and its containers ran for 7 hours. The orchestrator's cleanup of 16:25 found its 3 containers still there.

**Decision.**

1. **One automatic third attempt, then the lead, in its thread** (`lead/plans/runner.ts`, `lead/plans/retry.ts`, P66).
   - A ticket put back a second time is started a third time by the runner, as the first put back already was (`AUTOMATIC_ATTEMPTS` = 3).
   - Its author's prompt says it is the third and last automatic attempt. Beside the last note, it gets:
     - the report its reviewer wrote last (the last report with a Verdict line, `lastReport`);
     - the command and the output of the last test run that failed in one of its author sessions: an `execute` result marked as an error, whose command names test, check, typecheck, lint or a test runner.
   - Each is cut to 4,000 characters (the end of a test run is kept, where a runner says what failed) and cleaned again by the service's cleaner.
   - A third put back holds the item. The escalation is a line of the lead's thread (`serviceLine`), which the owner reads and which gives the lead a turn. Before, the hold was only an event of the lead's next turn (`enqueue`).
   - A held item takes no slot, so the next items start. The rest of the plan goes on, except the items that wait for the held one.
   - A put back by a restart still does not count.
   - Not chosen: more attempts, or another model on the third. Three attempts cost at most three author sessions per item before a person decides.

2. **Each question has its own delay, then the lead, then the declared answer or the park** (`flow/engine.ts`, `flow/questions.ts`, P54).
   - **The delay.** It counts from when the question was asked: `CLEARED_V2_QUESTION_TIMEOUT_MINUTES`, 30 by default. A wrong value stops the service, as the other settings do. The inbox item carries `timeout`: `at`, `leadUntil` and the declared `answers`.
   - **The lead.** Past the delay, the flow says `question_timed_out` (stage `lead`). The lead engine writes the question in its thread and gives the lead a turn at once: decide with answer_question, and what applies without an answer. The owner may still answer.
   - **The lead's window.** It is `QUESTION_LEAD_MINUTES`, 10 minutes, counted from when the lead was asked. It is a constant, not a setting: the brief asks for the question's delay alone to be configurable.
   - **The declared answer.** It is each question's first option whose label ends with "(Recommended)". That is Claude Code's AskUserQuestion convention, which the lead's prompt, the inbox and the proof's answer (P60) already read.
     - A request with one question that has none has no declared answer. So does a free question.
     - The author's prompt now asks for that label on the option it would take.
     - Not chosen: the first option, which nobody declared.
   - **The answer applied.** Past the window, it is given as a policy's answer under the rule `question_default`. It is logged:
     - in the session (`cleared.permission_answered`, `by: policy`);
     - on the ticket, as a comment;
     - in the ledger's `events` table (`question_default`, source `flow`);
     - on the bus (stage `default`).
   - **The park.** With no declared answer, the ticket is parked:
     - its sessions stop, their volumes kept;
     - it goes back to Todo with the new reason `parked`, in the ledger as `question_parked`;
     - its plan item takes the new state `parked`: not counted as a failure, its slot free, left alone by the runner, started again by the lead's start_ticket with the answer in its reason;
     - the runner says it in the lead's thread.
   - **Excluded.** The lead's own questions to the owner, which the lead engine keeps, and a session the owner took over.
   - **On the screens.**
     - The inbox's question says when the Lead decides and what then applies ("No answer in 25 min: the Lead decides, else “Newest first” applies."), in French and in English, through the shell's duration formatter.
     - A parked item reads « Mis de côté » (Parked) in the plan panel. The tower counts it with the held ones.

3. **An idle watchdog independent of the flow** (`session/watchdog.ts`, `modules/flow.ts`, P67).
   - **Its own clock.** A timer of its own, once a minute, started with the engine. What it reads is the ledger: each live author, reviewer or reader session of the project, and the time of its last event or of its row's last change.
   - **Its threshold.** It reuses `CLEARED_V2_IDLE_MINUTES` (15) rather than adding a second setting.
   - **A session the engine runs** is stopped by the engine (`FlowEngine.idleStop`):
     - One that waits for a person (a question, a permission, its session plan) is suspended. Its containers stop through the adapter's stop, its volume (the harness's transcript) stays, what it waits for stays in the inbox, and its ticket stays In Progress. Nothing is put back.
     - Its question's delay goes on. The answer, from the owner, the lead or the declared default, resumes it in a new container from its volume with the harness's resume, and is said to it as its next message. A message or a session plan's Go resumes it too.
     - One that waits for nothing is stopped by the existing idle rule, its ticket put back.
   - **A session nobody runs** gets its row stopped and a RUN_ERROR `idle`.
   - **Every stop:**
     - its containers and networks, labelled `cleared.dev=v2` and named after the session, are removed by name (`Docker.releaseStopped`);
     - its volume and its images are never removed;
     - a `session_idle_stopped` row goes to the ledger's `events` table (source `watchdog`) with what was removed and the volume kept.
   - **Left alone:**
     - the permanent lead, which waits between events by design and whose generations the lead engine ends;
     - a session the owner took over, which the terminal's own 15-minute rule closes.
   - **Limits, left for later:**
     - A suspended session that waits only for a permission has no delay. It keeps its plan slot until the owner answers.
     - An "allow once" given to a suspended session is said to it, and the resumed harness asks again when it runs the command.
     - After a restart, a suspended session's ticket is put back by the recovery (`restart`, not counted).

**Tests**, all on a simulated clock:
- `test/lead/plans/autonomy.test.ts`:
  - the third attempt's prompt: the note, the reviewer's report, the failing `npm test` and its output;
  - the hold after it, said once in the thread, and the next item starting in the freed slot with `maxParallel` 1;
  - the retry context cut and cleaned;
  - a ticket parked by a real unanswered question: the item parked, not counted, the next item started, and start_ticket starting it again.
  - On the old code, the first and the last fail: the item is held after the second put back, and no ticket is ever parked.
- `test/lead/plans/runner.test.ts`: the old two-put-backs case, now three.
- `test/flow/question-timeout.test.ts`:
  - 29:59 waits and 30:00 asks the lead, once, in the ledger;
  - the lead's answer in its window;
  - the declared answer at 40:00 in the session, on the ticket, in the ledger and on the bus, the ticket going on to its release;
  - the park of a free question;
  - the setting and its errors;
  - the lead's own question untouched;
  - the declared answers' rule.
- `test/session/watchdog.test.ts`:
  - a session nobody runs, 16 minutes idle while waiting: the labelled lists, the removals by name, no `volume rm`, the ledger's row; the busy, the 14:59, the done and the lead's left alone;
  - the engine's stop and a taken-over session skipped;
  - no events table;
  - the engine's suspension at 15:00 with its question kept and nothing put back, resumed by the owner's answer, by the declared answer at 40:00, and parked at 40:00 without one.
  - On the old code, the suspension tests fail: the session waits on and its containers run.
- `test/session/watchdog.test.ts` also runs the lead's own answer_question tool on a session the watchdog stopped: asked at 30:00, its answer resumes the session, and nothing is applied after it.
- `test/lead/engine.test.ts`: the lead's thread line and its turn, without the 60-second batch.
- `test/flow/events.test.ts`: `question_timed_out`, said after its write.
- `app/web/test/inbox/deadline.test.tsx`: the inbox's line in both languages, before and after the lead is asked, with and without a declared answer, and the parked item's label.

- Author: Opus 5.5 (claude-opus-5-5), lane `j3-autonomy`.

## 2026-10-24: the ledger's session history, read only, for agents through MCP (lane j3-ledger-mcp, issue 292)

**Decision.** The author of the lane added a read-only MCP server over stdio that lets an agent search the sessions and their events in `ledger.db` (matrix P68). These are the author's choices, not the owner's decisions.

- **Protocol by hand.** `src/mcp/server.ts` speaks newline-delimited JSON-RPC 2.0 itself (initialize, ping, tools/list, tools/call), without `@modelcontextprotocol/sdk`: the service has no runtime dependency. Versions 2025-11-25, 2025-06-18, 2025-03-26 and 2024-11-05 are answered as asked; another gets the newest.
- **Read only.** The ledger is opened with SQLite's read-only flag and `PRAGMA query_only`, never through `openStore`, which writes: it makes the folder, sets the journal, creates the tables, migrates and copies. A missing ledger is not created (exit 66). Only SQLite's own `-shm` and `-wal` files may appear beside a ledger in WAL mode, as with any reader.
- **Cleaned at read.** Events are cleaned before they are stored, but an old row or another writer may hold more. Every string goes through `cleanText` with the server's environment and the ledger's folder, then the token forms the guard does not name (GitHub, Slack, Linear, AWS, Google, Stripe, npm, JSON web tokens, bearer tokens), the value of a `NAME=value` whose name says key, token, secret or password, and secrets in an address's query. It is cut after cleaning: at 1000 characters in a search's answer, at 4096 (`COMMAND_OUTPUT_LIMIT`) in a timeline. `GUARD_PATTERNS` is unchanged; `GENERATED_ID` and `ID_KEYS` are now exported from `session/clean.ts`. A session's preview key is never given.
- **No oracle.** A search matches the whole cleaned text, before the cut (review of the lane: a term past the shown part was missed). A LIKE on the stored text only narrows the rows: by the term when it is plain ASCII, else by its runs of three ASCII characters or more, which JSON stores as they are; a term with no such run reads every row its other filters leave. A term that cleaning would change is refused; a piece of a secret finds nothing.
- **Pages.** 20 by default, 100 at most, beyond which a page is cut to 100. Keyset cursors: (created_at, id) for sessions, (at, session, seq) for events, seq for the timeline.
- **Words.** The tools' descriptions and errors are in their own catalog pair, `src/mcp/messages/ledger.en.json` and `.fr.json`, not in `app/messages/`, whose files must each be a screen. The language is the app's setting. A session's duration goes through `app/web/lib/time.ts` with the shell's units.
- **Install.** One line, in `README.md`, `docs/concepts.md` and `v2/README.md`: `claude mcp add cleared-ledger -e CLEARED_STATE_DIR=<folder of ledger.db> -- node <cleared checkout>/v2/src/cli/ledger-mcp.ts`. Not through `npm run`, whose banner would reach stdout.
- **Not done.** v1's `runs` and `events` tables, the inbox and the lead's tables are not served. No HTTP transport. The real ledger was never read: the tests use a ledger made in a temporary folder.
- **Resources.** No Docker object, no port, no tunnel. The proof run, its state folder and its service were not touched.
- Author: Opus 5.5 (claude-opus-5-5), lane `j3-ledger-mcp`.

## 2026-10-24: Codex harness on the session adapter contract (the author's choices, lane `j3-codex-harness`)

**The need.** Codex had no v2 adapter: `Harness` named it, the Consumption screen had a card for it and the terminal a name, but nothing could start, resume, guard, measure or take over a Codex session (matrix B5.1c, D13, O6, B6.3). The owner's decision O6 says Codex is tested without an account. These are the author's choices, not the owner's decisions; the real trial is open and listed in `docs/adapters.md`, Codex harness.

**Decision.**
1. **Driving: `codex exec --json`, not the app server.** The recommendation of 2026-10-21 names the app server, but its decision gate (`docs/adapters.md`) is not passed: no run has shown which approval policy sends every call to the client, and this lane could not run one. `exec` is the mode the gate allows and the one recorded on this server (proofs 7 and 8): one `docker exec` per message, the prompt on the standard input, then `codex exec resume <thread>` on the thread Codex names. The app server stays the target once the gate passes; it would give a true ask in the inbox.
2. **Guard: two layers, failing closed, as for Cursor.** Layer 1 is Codex's own sandbox by role: read only for a reviewer, a reader, the lead and an author whose plan waits; the checkout writable for an author at work, its network on because the container's egress is the network's guard. Approvals are `never`, and no program ever gets a bypass flag, `--full-auto`, `--approve-for-me` or `--ephemeral`. Layer 2 is the unchanged policy on every item Codex reports: a deny or an ask ends the turn. A file change is reported only once it is made, so for edits layer 2 is after the fact; the sandbox is what refuses. Not chosen: `danger-full-access` with the container as the only sandbox. It may become necessary if Codex's sandbox cannot start in the container (trial item 3), and that is the owner's call.
3. **The reviewer stays read only (B5.7, P48).** The reviewer's sandbox is `read-only`, in its turns and in its Take over terminal, and a file change or a writing command it reports stops its turn.
4. **Login: an API key file read into `CODEX_API_KEY` inside the container.** `codex login` is never run, so no credential is written to the session's volume. `CODEX_HOME` is the session's own, on its config volume. Not chosen: copying the host's ChatGPT `auth.json`. The host holds the owner's live login, and the sessions do not use it.
5. **Usage counted as Codex counts it.** Codex's `input_tokens` holds the cached input and its `output_tokens` the reasoning. A turn's usage therefore says the input without its cached part, so the Consumption screen's sum is Codex's own total. The session's state adds its turns, and the cost is null.
6. **Quota from the rollout file.** The recorded `exec` stream has no rate limits; the rollout file has them on its `token_count` lines. After each finished turn a fixed program in the container prints that thread's last `token_count` line, and the adapter keeps only the week and five-hour windows. The Codex card of the Consumption screen (O15) can then show a real share.
7. **Take over.** The running turn ends, and the terminal runs `codex resume` on the thread: without the shared background server, in the role's sandbox, approvals asked of the human by Codex itself. Messages wait for Give back; the next turn resumes the thread the human left.
8. **The policy locks `.codex/` in the checkout**, as it locks `.cursor/`: a session could otherwise change a project's own Codex configuration. A Claude Code or Cursor author now gets an ask there too.
9. **A file change Codex reports carries no text.** Codex names the changed files, not their content, and reports the change once it is made. An empty edit would have let the policy compare the changed `package.json` with itself and allow a new `test` script. So the request has no text: the policy asks (`scripts.change`, `install.package` for a lock file) and the turn ends. A delete ends the turn too (the policy has no rule for it). Both fail closed, at the cost of a turn (review of the author's own draft, before the pull request).
10. **The week is Claude Code's.** Until this lane only Claude Code reported `cleared.rate_limit`, and the plan runner's week stop and the scheduler's `weekShare` read the newest seven-day window of the project, whatever its harness. A Codex reading would have lifted or tripped the stop of B3.11. Both now skip a window journaled on a session whose harness is another; a row of a session the ledger does not know still counts. The reader reads its own session's window only and is unchanged.
11. **What the guard has seen is the turn's (review r2 of pull request 300).** Each `codex exec` numbers its items from `item_0` again. The guard kept the ids it had checked for the whole session, so in the second turn an `item_1` already seen in the first went through unchecked: layer 2 failed open. The ids it has checked are now cleared when each turn's process starts. The mapper's shown calls are cleared too, and the call ids in the thread carry the turn's number. A test reuses `item_1` across two turns: the second, `cat .env`, is refused, for a reviewer and for an author.

**Consequences.**
- `codex` is in the adapter registry (claude-code stays the default). As for Cursor, the flow and the lead still start every session as `claude-code`, so no ticket can name `codex` yet; choosing the harness per role or ticket, hand over and cross-harness review are B6.3's remaining part.
- The session image has no Codex program; a turn without it ends with `codex_not_installed`.
- One test run of this lane found this machine's own `codex` on the PATH. That was the "no program" case of the launcher test: an invented key, an empty prompt and a temporary `CODEX_HOME`. It exited 1 in under a second, and the owner's `~/.codex` was not written. The test now runs `/bin/sh` on a PATH of linked tools only.
- Resources: no Docker command or network, no port, no Codex account or model call; `codex --help` was the only use of the program.
- Author: Opus 5.5 (claude-opus-5-5), lane `j3-codex-harness`.

## 2026-10-24: the reviewer runs the service's declared test command, and the quota is read every hour and kept (the author's choices, lane `j3-review-tests-quota`, issues #268 and #270)

**The proposals** (validated by the owner on 2026-10-23 at 11:51). Issue #268: a reviewer reads the code but cannot prove it works. Issue #270: the quota is read through a terminal opened by hand, which breaks at the smallest change of its display.

**Decision.**

1. **One declared test command per service** (`flow/config.ts`, P70).
   - The key is `[session] test_command` in the service's `.cleared/agents.conf`, read at the base branch like the other keys. Its value is one simple command, read with the policy's own parser: a list, a pipe, a redirection or an expansion stops the configuration.
   - When the key is absent: `npm test` if `package.json` at the base has a `test` script, else no command. Until now the reviewer could already run `npm test`, so a service that declares nothing keeps that.
   - The guestbook and the filter API examples declare `test_command = npm test`.
   - Not chosen: v1's `[fast_lane] tests_command`. It belongs to another section and it takes the changed files as `{files}`.

2. **The reviewer's policy allows that command and nothing else that runs code or writes** (`session/policy.ts`, P70).
   - Allowed: the declared command, word for word, under the rule `reviewer.tests`. It is also allowed in a pipe or a list of reads, such as `npm test 2>&1 | tail -20`.
   - The reads stay as they were: milestone 1's reads (`run.safe`) and the reviewer's own reads (`reviewer.read`).
   - Refused, wherever they stand in a command:
     - Under `reviewer.edit`, programs that write files: `rm`, `mv`, `cp`, `touch`, `mkdir`, `tee`, an in-place `sed` or `perl`, and the like.
     - Under `reviewer.edit`, git's commands that change the checkout, its refs or a remote: `add`, `checkout`, `reset`, `stash`, `branch -D`, and the like.
     - Under `reviewer.run`, any program that runs code other than the declared command: `npm run typecheck`, `npm ci`, `npm test -- -u`, `CI=1 npm test`, `node --test`, `npx`, `make`, `bash -c`.
     - The refusal names the declared command, so the session can run it as declared.
   - These no longer apply to the reviewer:
     - the test runners of the default safe commands;
     - the project's own safe commands (the guestbook's include `npm ci`);
     - `npm run <script>`.
   - The author's and the reader's policies are unchanged.
   - Not chosen: asking the inbox for the other checks. The issue says the policy allows the declared command "and nothing else", and a request that asks is a person's decision, not the policy's.
   - The consequence for the proofs: a reviewer's `npm run typecheck` is now refused by the policy. Before, it went to the inbox and the proof's driver allowed it once (P52's driver part). The driver's rule stays for the author.

3. **The run goes into the verdict and the ticket's thread, read from the ledger** (`flow/review-tests.ts`, `flow/engine.ts`, P70).
   - The run is read from the reviewer's turn in the ledger, never from its report: the last call of the declared command, paired with its result.
     - `passed` or `failed`: it ran alone, and its result says whether it was an error.
     - `unclear`: it ran in a pipe or a list, where the exit status is the last program's.
     - `not_run`: no such call.
   - The run, with the last 15 lines of its output passed through the service's cleaner, is stored in four places:
     - on the verdict row: `cleared.review_verdict` gains an optional `tests` field, so the rows written before still read;
     - as a comment on the ticket at every verdict ("Review round N. Tests: `npm test` failed in the reviewer's session.");
     - as a line of the request for change the author receives;
     - on a pass, as a line of the report the pull request and the release's announcement carry.
   - The review prompt names the command and asks for it to run alone, not in a pipe, and for a `Tests:` line in the report.
   - Not chosen: refusing a pass whose tests failed. The verdict stays the reviewer's. The failure is in its row, in the thread and in the announcement, where the owner sees it before approving. It may also be an old failure the change does not touch.

4. **The quota's source answers in data** (`consumption/quota.ts`, P71).
   - For Claude Code, the source is `GET https://api.anthropic.com/api/oauth/usage`, called with the service's login: a setup-token token, or the access token of a credentials file, read as the session runner reads it.
   - It is the endpoint the CLI's `/usage` reads. In the installed CLI 2.1.310, `fetchUtilization` calls it, and its schema gives each window a `utilization` and a `resets_at` ISO text, both nullable.
   - The utilization is in percent, not a fraction: `/usage` prints it as `${Math.floor(l.utilization)}% used`, with no multiplication. The CLI's rate limit headers give a fraction, which the session mapper already converts.
   - It is not a model call: nothing is spent.
   - The answer is read strictly. A window absent or null is skipped. A window whose figures are not numbers or dates is a failed reading, and so is an answer with neither window: if the shape changes, a wrong figure would be worse than none.
   - Every failure is said in words that never carry the token or the answer's body:
     - no token;
     - the endpoint unreachable, or not answering in time (30 s);
     - an HTTP 401 or 403;
     - another HTTP status;
     - an answer that is not JSON;
     - an answer of another shape.
   - Codex has no hourly source: its windows come from its sessions' own reports, which its adapter reads from the rollout file (P69). They are shown on its card and never stop the plans.
   - Not chosen:
     - a probe turn of the harness, which spends tokens every hour;
     - reading the status line's `rate_limits`, which exists only inside a running session, where `cleared.rate_limit` already reads the same windows.

5. **Every hour, every attempt is kept, a failure without blocking** (`QuotaReader`, `modules/lead.ts`, P71).
   - **The timer.** The lead module's start runs a first reading, then one every `CLEARED_V2_QUOTA_MINUTES` minutes (60 by default). The timer never keeps the process alive, and 0 turns the reading off.
   - **The ledger.** `quota_readings` gets one row per window read, with its time, its source and its reset time. A failed reading is one row with `ok` set to 0 and its reason. Nothing is deleted.
   - **A failure** is a health notification `quota_read_failed`, once for a run of failures: the first one after a reading that worked. Nothing waits for the reading. The plans and the schedules go on with the newest figure they have.
   - **The alerts.** A window at 75 and then at 85 percent raises a health notification `quota_75` or `quota_85`, once per window cycle, keyed by its reset time. The alerts are kept in `quota_alerts`, so a restart does not alert again. The next cycle alerts again.
   - The three codes have their sentence in lib's catalog, in French and in English (`lib/notify/contract.mjs`, `lib/i18n`). A health notification passes the quiet hours, so a 75 percent alert reaches the owner at night too.
   - A notification that cannot be queued is written to the service's log and never stops a reading.

6. **One newest figure, read by the stop, the schedules and the screen** (`latestQuota`, P71).
   - The newest figure is the newest of the readings that worked and the sessions' own `cleared.rate_limit` reports. It is none once its reset time has passed.
   - It is one harness's, Claude Code's when the caller names none, and the stop and the scheduler name Claude Code. So the stop and the schedules read Claude Code's windows only: a Codex session's window, even above the stop, is its own and stops nothing (the rule of `j3-codex-harness`, decision 10, kept; review r2 of pull request 302). A report whose session has no row still counts as Claude Code's, as that rule reads it.
   - It replaces three copies of the same query: the plan runner's stop, the scheduler's `weekShare` and the Consumption screen's `quotaOf`.
   - So no lane starts at or above `CLEARED_V2_WEEK_STOP_PERCENT` (85 by default), even when no session has reported since the window filled.
   - The stop now reads the five-hour window too, with its own sentence in the lead's thread. The issue says no lane starts above 85 percent, and a five-hour window at 90 percent stops a session as surely as the week does.
   - The scheduler still reads the seven-day window only, against a schedule's own cap. The plan runner stops whatever the scheduler lets through.

7. **The Consumption screen says where each figure comes from** (`app/web/screens/consumption`, P71).
   - Under each quota, a line says when the figure was read and where: from the agent's usage page, or from a session's report.
   - When the harness's last reading failed, a line in the danger colour says when, with the reason as the service gives it, which is English. The figure read before it stays.
   - The line is shown in French and in English, and dates go through Intl.

**Limits.**
- The endpoint's answer is read from the shape the CLI's code expects. The fixtures under `test/consumption/fixtures/` are written to that shape with invented figures. No account was read: the lane runs on fakes only.
- If a setup-token token lacks the scope the endpoint needs, every reading fails visibly with "the endpoint refused the login (HTTP 403)". The plans then keep the sessions' own reports, as before.
- A ticket of several services reviews in the first service's checkout. Its test command is that service's.
- The test command runs in the author's checkout, which the reviewer shares. A runner that writes a cache or a coverage file there is not refused: the policy reads the command, not what the program does.
- Author: Opus 5.5 (claude-opus-5-5), lane `j3-review-tests-quota`.

## 2026-10-24: the proof's driver takes over an approved plan and says when a plan is blocked; the React port's follow-ups (the author's choices, lane `j3-driver-resume`)

**The defects.**
- **Issue #285.** The 48-hour proof's driver always sent a new goal. On 2026-10-23 it could not take over plan-1, approved with its five items put back, so the orchestrator paused plan-1 and started again from the beginning (the plan-2 entry above).
- **The 24-hour run** (the endurance proof's end, above). Step 07 waited from 08:47 to 15:45, with three items held and LOCAL-42 waiting on a question. The driver says "nothing to do now" only when what waits changes, and it had no rule for a plan that cannot move. Lane `j3-autonomy` (#297) now lets the plan go on, but the driver still could not tell a plan that waits from a plan that cannot move.
- **Issue #185.** The review follow-ups of the React port (#184).

**Decision.**

1. **The start check** (`startCheck`, `v2/scripts/proof-plan.ts`, P73).
   - Both drivers read the plans right after sign-in. A run that sends a new goal stops with exit 64 before its first gesture when a plan is approved and not paused. The reason names the plan, its items' states and the ways out.
   - A paused plan does not refuse a new goal: the runner starts nothing of it. This was the orchestrator's workaround of 19:50.
   - The multi-service proof has no plan of its own to take over. Its only way out is to pause the plan. A service with no lead (the plans answer 503) has no plan.
   - Steps 2 and 3 of the 48-hour proof now take only a plan proposed after the goal, never one left from before.
2. **The take-over** (`PROOF_RESUME_PLAN=<id>`, `v2/scripts/proof-j2.ts`).
   - The plan must be approved or paused, and no other plan may be approved.
   - Steps 1 to 3 are recorded as skipped. Step 4, `resume`, opens `/plans/<id>`; for a paused plan it clicks the panel's Resume, the owner's gesture. It then plants the two commitments, as after an approval.
   - Every measure runs from the take-over: the ledger's facts, the 48 hours (`PROOF_HOURS`), the night messages.
   - The report says what the plan was at the take-over. An item already running or landed then reads "… before the take-over", and its order ("3 after 2") is not read, since its start was never seen.
   - The rehearsal refuses `PROOF_RESUME_PLAN`: its service is new and has no plan.
   - The take-over and step 7's failure on a blocked plan are proven by the tests only. The fake-adapter rehearsal of `proof-j2.ts` ran the new-goal path: 9 of 9 steps, no blockage flagged at any reading. The take-over was never run against the proof's service.
3. **A blocked plan** (`planBlockage`, `PROOF_STUCK_MINUTES`).
   - A plan is blocked when nothing runs, nothing waits for approval, and nothing was put back (the runner starts that again), and every item left is held, parked, ready but not started (the week stop or the day budget), or after one of those or a cancelled one. A paused plan is blocked as a whole.
   - The rule is a state, not "no change for N minutes". A night with long sessions is not blocked, and a blocked plan is seen at once.
   - The 24-hour run's state at 08:47 would not have read as blocked at once: LOCAL-42 was still running, on its question. Under #297 that question parks the ticket after about 40 minutes (its 30, then the lead's 10). From then the plan is blocked, and step 7 fails 90 minutes later unless the lead starts an item again.
   - The blockage is logged when it starts, changes and ends, at night too. While the morning waits, a "nothing to do" line comes every 30 minutes, not only when what waits changes.
   - Step 7 fails when the same blockage lasts `PROOF_STUCK_MINUTES`, 90 by default, counted from when it was first seen, the night included. Then step 8 reads the lead at once instead of waiting out the hours left. 90 is above the service's own delays: a question's 30 minutes, then the lead's 10, and the watchdog's 15. So the lead gets its turn to start a held or parked item with `start_ticket` first.
   - `result.json` and `durations.md` keep the last blockage and say whether it stopped step 7.
4. **Issue #185, each point** (P74).
   - **Item 1: the log understated CopilotKit's hosts.** Done. Item 7 of the #184 entry now names `cdn.copilotkit.ai` beside `telemetry.copilotkit.ai`, twice each in the agent chunk of today's build, in ignore lists only. A Risk line names the trajectory collector, which is dead weight in the bundle. The body of merged pull request 184 was left as it is.
   - **The owner's added point: `agents__unsafe_dev_only`.** Checked in `@copilotkit/core` 1.77.2 (`dist/index.mjs`):
     - the constructor (line 6583) hands the agents to `AgentRegistry.initialize` (line 1702), which only keeps them in the page;
     - `NODE_ENV` changes nothing there;
     - with no `runtimeUrl`, `connectRuntime` returns at once (line 1739);
     - the learning bridge starts only with a `learning` option or a runtime.
     The app's server has no CopilotKit route; `src/` and `app/src/` name none. Nothing is exposed, so no priority lane is needed.
     A test now requires no runtime address, a connection status still `disconnected`, and no request over three connects and detaches with ten minutes of timers. The address is the check that matters: under Node the core skips the runtime connection anyway, as there is no `window`. A planted `runtimeUrl` fails the test.
   - **Item 2: a rebuild under a running app.** Done. `createAppHandler` reads the manifest again when its modification time changes. While no manifest is there (Vite is writing the build), a page answers 503, which says to build. Each page now costs one `stat`. The test fails on the old code.
   - **Item 3: the lock file and the guard.** Done. `test/scripts/guard.test.ts` runs `scripts/guard.ts --base` in a repository made in a temporary folder. A secret-shaped line in `v2/package-lock.json` fails the tree pass while the strict pass says nothing refused. The same line in another file fails both passes. The line is a secret pattern, since without `CLEARED_REPO` there is no private-term list, and it is built at run time so the test file holds none.
   - **Item 4: CI built twice.** Done. The verify job's Build step is gone, since `npm test` builds first. The browser job keeps its own build.
   - **Item 5: the design notes** (the phone header's height, the sign-in page's autofocus, the outline "play"). Not done: these are the owner's visual decisions and need captures.
   - **Item 6: the reviewer's coverage gap** (the 1280 and 768 captures, the dark pairs, `choices-*`). Not done: it asks for a second review, not a change.

**Resources.** No Docker object, no network, no tunnel. Only the fake-adapter rehearsal ran, on free loopback ports. The proof's service, its state folder and the example repositories were not touched.

- Author: Opus 5.5 (claude-opus-5-5), lane `j3-driver-resume`.

## 2026-10-24: an agent's question with choices in the inbox, the project's own delay and default (the author's choices, lane `j3-agent-questions`, issue #269)

**The need.** Issue #269 (validated by the owner on 2026-10-23 at 11:51) asks that an agent's question with choices reach the inbox within 5 s, with its choices as buttons, that a click send the answer to the session, that the delay and the default answer be set per project, that the proof script answer it, with service and browser tests. Lane `j3-autonomy` (pull request 297, issue #290) had already given each team question a delay, the lead's 10-minute window, the declared answer and the park (P54). This lane reuses that mechanism and adds what was left (matrix P72). These are the author's choices, not the owner's decisions.

**Decision.**
1. **The project's own delay and default, on the existing item.** Two keys of `[session]` in a service's `.cleared/agents.conf`, read at the base branch with the others (`projectSettings`):
   - `question_timeout_minutes`, a positive number: the delay of its questions. Unset, the service's `CLEARED_V2_QUESTION_TIMEOUT_MINUTES` applies, then 30 minutes.
   - `question_default`: `recommended` (unset means this: the session's declared answer, each question's "(Recommended)" option, as before), `first` (that option, else each question's first, one even for a multiple choice) or `park` (nothing is applied: the ticket is parked).
   - A wrong value is an error of the project's settings, as for `plan_go_minutes`.
   - Both are read for the asking session's service, so in a workspace of several services a question follows its own service's file.
   - They are written into the item's `timeout` when the question is asked (`#questionTimeout`, with `rule` when it is not `recommended`). `#dueQuestions`, `#applyDeclared` and `#park` are unchanged: they already read each item's own `at` and `answers`. The lead's 10-minute window stays a fixed constant.
   - The ticket's comment, the resumed session's message and the park's note say "the project's default" when the rule is `first` or `park`, not "the answer the session declared".
   - A question with no option still has no default under `first`: the ticket is parked.
2. **Within 5 s, the stream down included.** The way existed: the inbox store's write says `inbox` on the change stream, and the page's cache refetches it at once. While the stream is down, the cache polled every 10 s. The inbox is now polled every 3 s then (`INBOX_POLL_MS`), so with the 1-second tick a question is on screen within about 4 s. Every other resource keeps 10 s.
3. **One click answers.** In the inbox the choices were toggles and the bar's Send answered: two clicks. The only choice of one question is now a button that answers at once (`answersOnClick`, the session's and the lead's rule). Several questions, a multiple choice and a free answer keep the toggles and the bar's Send. A wrong click cannot be undone; the session's screen already behaved this way.
4. **One way for the proofs to answer.** `answerInInbox` in `scripts/proof-inbox.ts` gives the gestures (one click, or each pick then Send) from the labels the API gives. `proof-j2-multi.ts` uses it in place of its own code. `proof-j2.ts` now answers a team's question in its morning, after the permissions, unless `PROOF_OWNER_APPROVES=1`. It keeps the answers in `result.json` under `questions`. The lead's own question is still the owner's.

**Consequences.**
- No new interface string: the inbox's line already says when the Lead decides and what then applies, from the item's `answers`.
- The guestbook's `agents.conf` names the two keys in its comment on `[session]` and sets neither: the defaults apply.
- Resources: no Docker object, no network, no tunnel. The tests listen on ports the system gives, on 127.0.0.1. The browser tests use the Chromium Playwright installed on this machine.
- Author: Opus 5.5 (claude-opus-5-5), lane `j3-agent-questions`.

## 2026-10-24: parallel variants of one ticket (the author's choices, lane `j3-variants`, issue #271)

**The proposal** (validated by the owner on 2026-10-23 at 11:51). On an uncertain ticket, one attempt gives nothing to compare. Several authors work the same ticket; the owner picks the variant to review, and the others are closed.

**Decision.**

1. **The number is chosen at the start, 2 to 4** (`POST /api/tickets`, `FlowEngine.start`, P75).
   - `variants` in the ticket's body. Absent or 1, one author, as before. Out of 2 to 4, or on a workspace of several services, the route answers 400 before the ticket exists; `start` refuses it too.
   - The Tower's bar asks for it on a workspace of one service only: one author, 2, 3 or 4, shown once a title is typed.
   - Not chosen: variants on a ticket of several services. Its checkouts are `<ticket>/<service>`, its steps already run in parallel, and a variant of a train would need a checkout per service and per variant. It stays refused until a ticket needs it.

2. **Each variant is its own clone of the ticket branch** (`flow/variants.ts`, `flow/effects.ts`).
   - The folder is `<workdirs>/<ticket>.variant-<round>-<position>`: a ticket id has no dot, so no other ticket's checkout is ever named so. A new run of variants of the same ticket is a new round, with fresh clones.
   - Every variant's branch keeps the ticket branch's name, `cleared/<ticket>`. Each clone has its own `.git`, nothing is pushed before the review, and only the chosen one is published. So `ticketBranch`, `publish`, the lock and the guard are unchanged.
   - Not chosen: a branch name per variant (`cleared/<ticket>/variant-1`). Git cannot hold `cleared/<ticket>` and `cleared/<ticket>/...` in one repository, and the publish and the lock read the ticket's one branch.
   - Not chosen: a folder under `<workdirs>/<ticket>/`. That folder is the ticket's own checkout, and a later plain start would find it is not one.
   - What a variant changes is read as a step's branch is, out of its checkout into a ref of its own, `refs/cleared/variant/<service>/<folder>`: two variants that end at once never read each other's change. Only what is committed counts, as for publish.
   - A variant's session counts only its own checkout's files for the deletion rule, not its siblings'.

3. **At most the lanes at once** (`#runVariants`).
   - The limit is the Consumption screen's lanes (`maxLanes`), 3 when it sets none: the issue's 3 lanes in parallel. A fourth variant waits, and starts when a lane is free.
   - Not chosen: refusing 4 variants under 3 lanes. The issue asks for 2 to 4 within the limit, and waiting keeps both.

4. **A variant that fails fails alone** (`#stopTicket`, `#failVariant`).
   - Its run error, its idle stop, a stop before the end of its turn, a dead stream or a start that fails mark that variant failed, with its reason on the ticket. The others go on.
   - A spent budget stops them all: the money is the ticket's.
   - Every variant failed puts the ticket back in Todo (`variants_failed`), with each one's reason.

5. **The inbox compares them** (`variants` item, `app/web/screens/inbox`).
   - Once a variant is done, the item is added; it follows the others as they end.
   - One column per variant, side by side: its state, its files, its lines added and removed, its cost, its time (Intl), and its diff, cut at 64 KB with a line saying so.
   - Each variant that is done has its own button, "Review variant N". A failed, running or waiting variant has none.
   - Every text is in the inbox's and the tower's catalogs, in French and in English.

6. **The choice stops the others and releases their containers at once** (`POST /api/variants/:id/choose`, `FlowEngine.chooseVariant`).
   - The owner can choose as soon as one variant is done. The others stop whatever their state: a running one ends with `variant_dropped`, a waiting one never starts.
   - Their containers and networks, labelled `cleared.dev=v2` and named by session, are released by the same call (`Docker.releaseStopped`), not at the next tick. The answer counts them. The volumes stay, as for every stopped session.
   - The chosen variant hands over, the ticket moves to review, and the reviewer, the publish and a reopened author work in the chosen checkout. The sessions not chosen leave the ticket's flow, so the rounds, the human edits and the release card count the chosen one only.
   - A second choice, a variant that is not done or a ticket that no longer runs is refused with a 409.
   - A variant dropped while its checkout or its session was still starting is read again once its session exists: that session stops at once with `variant_dropped`, and its containers are released (review r2 of pull request 305).
   - Not chosen: keeping the handovers of the variants not chosen. They describe work that is not merged.

7. **A ticket that leaves the flow drops its open variants.** A put back, a set aside or a restart marks the variants still open as dropped and settles the item without a choice. A later plain start works in the chosen variant's checkout, if one was chosen, as a ticket keeps its own.

**Limits.**
- Tested on fakes only: the scripted adapter, recording effects, a temporary git repository and a fake docker CLI. No real session ran with variants.
- The checkouts of the variants not chosen stay on disk, as a put back ticket's does.
- A ticket from a plan never runs in variants: the plans name no number yet.
- Resources: no Docker command, network, port, account or model call.
- Author: Opus 5.5 (claude-opus-5-5), lane `j3-variants`.

## 2026-10-24: automatic repair of a pull request's failed checks (the author's choices, lane `j3-ci-repair`, issue #273)

**The need.** Issue #273 (validated by the owner on 2026-10-23 at 11:51, matrix P58, delivered as P77) asks that a failed CI on a pull request Cleared opened start a repair session on its own, which pushes a commit and reports the result in the inbox. At most 2 attempts, never on main, tested with a simulated CI. These are the author's choices, not the owner's decisions.

**Decision.**
1. **The trigger is the release card.** A pull request Cleared opened is the one a release card in the inbox shows: the flow already reads its checks once a minute while the ticket waits for approval. A failed reading starts the repair (`#checksFailed`, `v2/src/flow/engine.ts`).
   - The failure must be read on the card's own head. The host reads `gh pr view --json headRefOid,statusCheckRollup` (`ciFailures`, `v2/src/flow/effects.ts`). Right after a push the forge can still report the head before it; that reading starts nothing, and the next minute reads again. A reading that fails waits the same way.
   - The repair runs beside the tick, which goes on: resuming an author starts its container. The ticket is marked before the first wait, so two readings never start two repairs.
   - A train (a ticket of several services) is not repaired: its checks are per service and its card lands per service. That is more than this issue's effort.
2. **The repair is the existing path, not a new one.**
   - The card is handled first, so the red head can no longer be approved.
   - The ticket's last author is reopened on the ticket branch: resumed, else a new author given the ticket's prompt. It is told the attempt, the failed checks and the last 60 lines of each GitHub Actions job's failed log (`gh run view --job <id> --log-failed`, the first 5 checks), all through the service's cleaner and marked as data. It is told to fix the cause, not to skip, delete or weaken the check, and to leave the CI's configuration alone.
   - Its commit goes through the review again. The card says "Reviewed by" and the approval is bound to the head it shows, so an unreviewed commit would make both false. The repair is a new flow of the ticket: its review counts from round 1, so a ticket that used its rounds before still gets one.
   - Then the publish, as for any change: the ticket branch only, pushed without force, the open pull request reused, the base branch refused (`v2/src/workspace/publish.ts`, steps 1 and 3). A new card follows, checks pending, carrying the attempt.
3. **At most 2 attempts** (`CI_REPAIR_ATTEMPTS`, `v2/src/flow/ci-repair.ts`). The attempt is kept in the card's payload (`ReleaseItem.repair`: attempt, limit, state, the failed checks' names) and the next card inherits it. It holds across a restart without a new table. A person who sends the ticket back starts a fresh flow, whose card has no repair: the count starts again.
   - Red again after the second attempt: the card stays, says `gave_up`, and the owner decides. Nothing more is tried.
   - Green: the card says `repaired`. A card that gave up turns `repaired` too when the owner runs a job again and its head passes.
4. **Never on main.** Besides the publish's own refusal, a ticket branch that is the service's base or `main` (or `master`) is never repaired: the card says `refused`, once.
5. **The result in the inbox.** The card's detail has a fact, "Repair of the checks", for each state: started (on the handled card), published, repaired, still failing, refused. The list's line says when the attempts are spent. Both are in the inbox's catalog in French and English. Each step is also a comment on the ticket and a `ci_repair` event on the bus, which the lead reads as a line.

**Consequences.**
- No new table, no new setting, no new session event name.
- `#reopenAuthor` lost its resume-else-new part to `#reopenWith`, which the repair shares. The review channel's behaviour is unchanged, and its tests pass as before.
- The simulated CI (`simulatedCi`, `v2/test/flow/support.ts`) is keyed by head: each publish pushes a new head and its checks are scripted. Nothing reaches GitHub. `ciFailures` itself never ran against GitHub. Its parsers are tested on objects written to gh's documented JSON fields, not recorded from an account.
- Known limit: an approval clicked while the checks are red, and still in its undo window when the repair starts, is not cancelled by the repair. The lock still refuses to merge a red head.
- Resources: no Docker object, no network, no tunnel, no port. The tests run in memory.
- Author: Opus 5.5 (claude-opus-5-5), lane `j3-ci-repair`.

## 2026-10-24: the Consumption screen's review follow-ups (the author's choices, lane `j3-consumption-followups`, issue #293)

**Decision.** Five of the six follow-ups of #289 are done; the sixth stays open (item 6).
1. The French partial-cost line is "partiel : {reported} sur {turns} tours", with no plural to agree.
2. The screen keeps showing one window per harness, the seven-day one (the server returns both, seven-day first); the footer now says so rather than showing both, which the matrix wording does not ask.
3. A pause longer than `GOAL_PLAN_HOURS` (6) leaves the plan of a waiting goal run unapproved by the scheduler; it waits in the inbox for the owner. Documented in the scheduler's header, behaviour unchanged.
4. The levers' note is rendered only when there is a message.
5. `AUTHOR_MODELS` stays the list of choices, but `modelChoices` (consumption/levers.ts) adds the configured author model and a model stored earlier, never the reviewers'. That one set is both the options `leverChoices` offers and the validation of `LeverStore.set` (which takes the configured author model as a fifth argument, the route passing it), so no offered toggle is refused. A stored model that was left for another choice drops out. Not read from the configuration alone: the configuration names one model, not the choices.
6. Left open: the matrix status stays partial until a real Claude Code session reports its windows, and the dollars await the owner.

**Consequences.**
- No new table, setting or event. `set` now accepts the configured author model and the stored one, as the options do. The engine's fallback for a model that is the reviewer's is unchanged.
- Resources: no Docker object, no network, no tunnel, no port.
- Author: Sonnet 5.5 (claude-sonnet-5-5), lane `j3-consumption-followups`.

## 2026-10-24: Resume from here, a ticket started again from a step of its author's thread (the author's choices, lane `j3-replay`)

**The need.** Issue #272, approved by the owner on 2026-10-23 at 11:51 (P57, Devin's item 14). A session that went the wrong way had to start again from the beginning. The criteria: each step of the thread offers "Reprendre d'ici", the branch goes back to the step's commit, the old continuation stays readable, a service test and a browser test.

**Decision.** Matrix line P76, checked free on `origin/v2` (after pull requests 305 and 307 it holds P75 and P77, and P76 is still free; pull request 304 took P72). P57 and C14 point to it.

1. **A step is a row of the author's worklog** (a command, an edit, reads, a message of the review channel), the rows `Session.tsx` already draws as steps that open their detail. A ticket's `ticket_steps` are not used: a one-service ticket has only one.
2. **The step's commit is journaled, never guessed** (`cleared.checkpoint`, `flow/replay.ts`).
   - The flow reads the tip of the author's branch from the checkout's files, without git: `.git/HEAD`, the loose ref, else `packed-refs` (`readTip`, `workspace/checkout.ts`). It holds to the rule of that file: the host runs no git in a session's checkout.
   - The tip is read before the session starts, then after each tool result and at the end of each turn. It is journaled only when it moved.
   - The button means "from the branch as it was just before this step". A step's commit is the last checkpoint before the row's first event, else the session's first. The service (`stepCommit`) and the page apply the same rule, and a test runs both on the same events. So the owner redoes the step that went wrong with a corrected instruction.
   - The page sends the step's first event (`seq`), never a commit. The service finds the commit in its own ledger.
3. **The route** (`POST /api/sessions/:id/replay {seq, message}`).
   - It is the owner account's alone, as Take over is. The instruction is at most 2,000 characters and goes through the cleaner.
   - Before anything stops, the effect checks that the ticket's branch holds the step's commit (`replayCheck`). It reads the branch out of the checkout as publish does, which is safe while the session runs. A step of a continuation that an earlier resume left is refused this way (409), and the new author goes on.
   - It stops the ticket's live and dormant sessions (`RUN_ERROR` code `replayed`), settles what of the ticket waits in the inbox, and halts its train. This is Set aside's code, now shared (`#stopAll`).
   - The effect (`replay`, `flow/effects.ts`):
     - fetches the old branch out of the checkout into the service's own checkout, as a step's branch is read, under `refs/cleared/replay/<ticket>/<n>/previous`;
     - checks that the commit is in that history;
     - renames the checkout aside to `<workdirs>/.<ticket>.before-r<n>`, never deleting it;
     - makes a new checkout on `cleared/<ticket>.r<n>` that fetches only the step's commit (`ticketCheckout`'s new `start`). Its base for the hooks stays the service's base.
   - A new author starts there, through the same path as a start (`#startAuthor`). Its prompt is the ticket's, then where its checkout stands, then the owner's corrected instruction. The ticket keeps its plan item, its budget and its one step.
   - `ticket_replays` keeps the branch. The reviewer, the publish and a start after a restart use the newest resume branch (`#branchOf`). So does the automatic repair of failed checks (P77, pull request 307): its base-branch check and the branch it names to the author. That use has no test of its own: the repair's tests run on a ticket's own branch.
   - Both sessions get `cleared.replay`: the session left says where the ticket went on, the new one where it came from, with the instruction folded.
4. **Nothing is rewritten or forced.** A ticket id has no dot, so `cleared/<ticket>.r<n>` can be no ticket's own branch, and it does not sit under `cleared/<ticket>/`, which git could not hold beside `cleared/<ticket>`. The old branch stays as it was in three places: the checkout set aside, the service's ref, and the forge if it was pushed.
5. **The old continuation stays readable.** The old session keeps every event. In the ticket's view it is folded under its author, as any earlier session is, and opens to every row. Its steps from the one resumed from onwards no longer offer Resume from here, since the branch does not hold them. Its earlier steps still do.
6. **The page** (`Session.tsx`, `session.css`).
   - "Reprendre d'ici" (Phosphor's counter-clockwise arrow) sits under the step's detail, not in its summary, where a click folds the row.
   - It opens the instruction (shadcn's Textarea and Buttons), which names the commit the branch goes back to. A refusal by the owner rule is said apart.
   - Every string is in `session.{fr,en}.json`. The view follows the new author without a navigation.

**Limits.**
- A ticket of a workspace of several services is refused (409). Its checkouts, its steps and its contract would each need their own resume point.
- A ticket that ran variants (P75, pull request 305) is refused too (409): it works in its chosen variant's checkout, `<workdirs>/<ticket>.variant-<round>-<position>`, which the resume does not move aside.
- The new author starts a fresh conversation. The old session's conversation is not forked: what it knew is lost, except what the ticket, the corrected instruction and the committed code carry.
- Only what was committed comes back. Edits the author had not committed at that step are not in the new branch.
- The new branch opens its own pull request. One the old branch opened stays open on the forge: closing it is the owner's, an outward-facing act this service does not take.
- The checkpoint after a tool call is read when the flow handles its result. A commit made in the next few milliseconds by the next call would land on the next step. A tool call takes longer than that.
- A session started before this change has no checkpoint, so it offers no Resume from here.
- The checkout set aside, `<workdirs>/.<ticket>.before-r<n>`, is never removed by the service. Removing it is left to the owner.
- The old session's Editor reads the ticket's checkout path, which is now the new one. Its own files are in the checkout set aside and in its branch.
- The browser test runs on the session fixture, whose route stands in for the service's: the flow and the real git are proven by `test/flow/replay.test.ts`.

**Checks.** On this server: `npm run typecheck`; `npm test` after the merge of origin/v2 (pull requests 305 and 307) (1679 node tests pass, 38 skipped, 0 fail; 260 Vitest tests pass); the CI job's twelve browser files with `CLEARED_V2_PLAYWRIGHT` and Chromium, the new `app/test/session/replay-browser.test.ts` among them: 29 of 30 tests passed in one run, and after the last change the three session files passed again (7 of 7). The tab-switch budget measured 145 ms at p95 there, run beside the others on a loaded machine; alone it passed twice, at 29 ms.

**Resources.** No Docker object, no network, no tunnel, no port but the tests' loopback ones the system picks. The git tests run in temporary folders.

- Author: Opus 5.5 (claude-opus-5-5), lane `j3-replay`.

## 2026-10-24: follow-ups of the plans' autonomy (the author's choices, lane `j3-autonomy-followups`, issue #299)

**Context.** Issue #299 lists seven follow-ups of PR #297. Three are done here (P78 to P80). Four are left, with why.

**Decisions.**
1. **A permission request waits as long as a question and then parks the ticket** (`FlowEngine.#duePermissions`). It is never allowed on the owner's behalf: a permission has no answer the session declared, and allowing a tool by a delay would turn the owner's check into a timer. Rejecting it would make the session guess what to do next. Parking frees the plan's slot and keeps the volume, as an unanswered question with no default does. The delay is the question's (the project's `question_timeout_minutes`, else the service's), counted from when the request was raised; there is no lead window, since the lead has nothing to decide on a permission. No new bus event and no new inbox field: the ledger row `permission_parked` and the ticket's comment say it, and the inbox item leaves with the session. The inbox does not show the delay on a permission yet.
2. **`isTestCommand` reads the program, not a word.** After the leading `cd dir &&` and variable assignments, the line must start with a known runner. A runner missing from the list is not read as a test run; the third attempt then lacks its output, which is the safe side.
3. **A module may declare `stop`.** Added to `Module` and `App` (`registry.ts`) and awaited by `main.ts` before `store.close()`, because `process.exit(0)` followed a close that did not wait for a watchdog pass in progress. Reverse order, a failing stop said and skipped. Only the flow module uses it, for the watchdog. The human side's terminal timer is left as it was: it holds no pass.

**Not done, and why.**
- *Follow-up 2* (a `parked` item blocks the items that depend on it until the lead starts it again): the issue itself asks to watch it at the next endurance proof. A rule chosen without that run would be a guess.
- *Follow-up 5* (a suspended session's ticket is put back `restart` after the service restarts, instead of resumed): a suspended session lives in `#dormant`, in memory, with its start input; the adapter keeps no start input to rebuild it from the ledger (see `recover`). Resuming it needs that input stored, which is a change of what the ledger keeps and of its tests, not a follow-up.
- *Follow-up 6* (the watchdog proved on real containers): it belongs to the endurance run, which has the Docker daemon and the labels `cleared.dev=v2`. No container is made by this lane.
- *Follow-up 7* (B3.11 and P54 to done): after that run. Their rows stay as they are.

**Consequences.**
- No Docker object, no network, no tunnel, no port, no secret. The tests run in memory.
- Author: Sonnet 5.5 (claude-sonnet-5-5), lane `j3-autonomy-followups`.

## 2026-10-24: follow-ups of the ledger's MCP server (the author's choices, lane `j3-ledger-mcp-followups`, issue #301)

**Context.** Issue #301 lists six follow-ups of PR #298. All six are handled here (P95 to P100). One point the issue did not ask for is noted below.

**Decisions.**
1. **A marker is searched by its words, not by the stored text.** The LIKE that narrows the rows reads the stored text, which holds no `[removed: ...]`, so a search for a marker found nothing. The term is cut at its brackets (nothing else holds one) and a piece that is a part of a marker's words narrows nothing; the filter on the cleaned text decides. A short common word of a marker ("token", "key") therefore reads without narrowing, which the scan limit bounds. `MARKER_TEXTS` is the one list of the markers, and a test checks that every marker the cleaner writes on the fixture is in it, so a new category cannot bring the defect back unseen.
2. **A call reads at most 2000 rows.** The cost of a search is the cleaning of each row it reads, found or not. At the limit it answers `partial: true` with what it found and a `next` after the last row read, found or not, so an empty page can still go on and the cursors reach every match once. The limit is a constructor option for the tests.
3. **The cursor is the stored time and rowid, not an id.** Built on the cleaned id, two sessions whose ids read the same once cleaned were skipped, and building it on the raw id would have put a stored string, perhaps secret-shaped, in a value any client decodes (it is base64 of JSON). The order of rows at one moment is now the order they were written. A cursor of the old shape is refused as `error_cursor`. A session keeps its rowid when it is updated (`ON CONFLICT(id) DO UPDATE`, not a replace), and events are only appended, so a row cannot move between two pages.
4. **Key names are cleaned; a name is a secret's unless it holds an innocent word.** `whole` cleans each key and decides the id keys and `rawEvent` on the stored name; keys cleaned to the same text are numbered, so no value is lost. For `NAME=value`, a rule on the name's shape (the word between underscores) would have missed `PGPASSWORD`, `SSHPASS`, `APIKEY` and `GITHUBTOKEN`, which cannot be told from `BYPASS` by their letters. So the broad match stays and a short list of words that only hold the letters (`BYPASS`, `AUTHOR`, `KEYBOARD`, `MONKEY`, `COMPASS`...) is removed from the name before it is judged. A word missing from the list costs a hidden value, never a shown secret.
5. **EPIPE ends the server as a closed input would.** The client being gone is not an error: the input is let go (it stayed open and kept the process alive) and the command exits with 0. Any other failure of stdout is thrown and the command exits with 74 and says it on stderr.
6. **A stopped service's ledger in a read-only folder is read `immutable`.** The WAL mode reads through a `-shm` file that a read-only connection in such a folder cannot make; the open failed. When it fails, the folder cannot be written to (the service cannot run in it) and the ledger has no `-wal`, it is opened again as `file:...?immutable=1`, a snapshot. With a `-wal`, or in a folder that can be written to, it never is: the ledger may be written to and `immutable` would hide committed rows. The concurrent read in WAL is pinned by a test; it passed on the old code, and opening every ledger `immutable` makes it fail.

**Limits.**
- At the scan limit, `partial` and `next` are decided by the rows that passed the LIKE on the stored text. For a term that cleaning leaves unchanged, the answer tells whether at least 2001 stored rows hold it and where the 2000th is. The text of a secret is never shown, and a term shaped like a secret is refused or finds nothing; the position of a row is not a secret.

**Not done, and why.**
- `createdAt`, `updatedAt` and an event's `at` are shown as stored, not cleaned, as before this lane. They are timestamps the service writes; a writer that put something else there is outside what this lane was asked.

**Consequences.**
- No Docker object, no network, no tunnel, no port, no secret: the tests build their secret-shaped values at run time and run on temporary folders. The read-only folder test is skipped for root.
- The answers of `search_sessions` and `search_events` gain `partial`; the sort of rows at one moment changes.
- Author: Sonnet 5.5 (claude-sonnet-5-5), lane `j3-ledger-mcp-followups`.

## 2026-10-24: follow-ups of the review channel (the author's choices, lane `j3-review-channel-followups`, issue #296)

**Context.** Issue #296 lists five follow-ups of the review channel (#295). Four are done here (P90 to P92), one is left, with why.

**Decisions.**
1. **A message of the channel is journaled once on the side it reaches.** When the session resumed took the message and its `send` failed, the fallback session (a new reviewer, a new author) is given the message in its prompt and does not journal it again. Not chosen: journaling after a successful `send`. A scripted or fast turn ends inside `send`, so the row would come after the verdict it answers. The cost of the rule: the fallback session's screen does not show the message it was given; the session that took it does, and the ticket's `all` view shows it once. This is also the fix for the author's side (the request journaled on the resumed author and again on the new one), which the issue did not name.
2. **The fake adapter gets `reviewerResume: 'send_fails'`**, a reviewer resumed whose send throws, and it spends no round of the reviewers' scripts.
3. **Two tests that guard, not fix.** An author that cannot be resumed (follow-up 3) and a Claude Code reviewer resumed keeping its read-only policy (follow-up 4) already worked; they are pinned. The second was checked to bite: setting the role of a resume to `author` in the runner's start line, or the policy's role to `author` at a permission request, makes it fail.
4. **The runbook** (`proof-clean-base.md`) now lists `PROOF_REVIEW_ROUNDS` and `CLEARED_V2_REVIEW_ROUNDS` (3 by default, 2 before).

**Not done, and why.**
- *Follow-up 1* (the channel kept only in memory, to rebuild from the ledger after a restart): no state of the old code goes wrong. A restart ends every live author and reviewer session (`recover`), puts the ticket back in Todo with reason `restart`, and the adapter keeps no start input to resume a session from (`#inputs` is in memory too). A person who starts the ticket again begins a new flow at round 1, by design. No author's turn can end into a lost channel, so there is no test that fails on the old code, and a rebuild would be code for a case that cannot happen. It becomes real if sessions are made resumable after a restart (lane `j3-autonomy-followups`, follow-up 5): the open channel is then the last `reviewer` message of the flow with no `author` message after it, on the session that carries it.

**Consequences.**
- No Docker object, no network, no tunnel, no port, no secret. The tests run in memory.
- Author: Sonnet 5.5 (claude-sonnet-5-5), lane `j3-review-channel-followups`.

## 2026-10-24: follow-ups of the Cursor harness (the author's choices, lane `j3-cursor-followups`, issue #294)

**The need.** Issue #294 lists six follow-ups of pull request 288 (the Cursor harness). Matrix lines P86 and P87, checked free on `origin/v2` and in the open pull requests 308 (P82) and 309 (P78 to P80).

**What was already done.** Reading `origin/v2` first, three of the six were fixed by the review commit `1609429` of pull request 288, after the issue was written, and have tests:
- Follow-up 1 (`handedOver` set before the wait): `interactive()` sets it before `endRunningTurn`, and resets it if the turn does not end. `adapter.test.ts`, "Take over: a message sent while the turn ends does not start a turn beside the human".
- Follow-up 2 (two terminal events on `stop()`): the close handler skips `cancelled('waiting_human')` while `closing`. `adapter.test.ts`, "stop on a running turn leaves one terminal event, not two".
- Follow-up 5 (side effects on Claude Code): items 9 and 10 of the owner's trial list in `docs/adapters.md`.

**Decision.**
1. **Follow-up 4: a test through the adapter, not a longer deny list.** `permissions.test.ts` already proved `evaluate` denies `cat` and `head` on the credential file. The test added plays eight readers and two environment-file reads as Cursor `shell` calls through the real guard (P86). Denying `cat` or `less` in layer 1 would refuse every legitimate read of the checkout, and the policy already matches the credential's name in any word of a command.
2. **Follow-up 3: pinned, not changed.** The keep-out was already true (`HARNESS` is a constant in the engines). A test now says so (P87), so a later change has to meet the owner's trial first. The docs already call layer 2 a tripwire and list the trial (items 2 and 12).
3. **Follow-up 6 left.** The chat id is written and not read back, as with Claude Code. Reading it back is a service-restart feature for both harnesses, not a Cursor one.

**Not done, and why.** Whether `.cursor/cli.json` is honoured in print mode needs a real Cursor account, and none is used here (O6).

**Checks.** `npm run typecheck`; `npm test` (1683 node tests pass, 38 skipped, 0 fail; 260 Vitest tests pass); `npm run guard -- --base origin/v2`: nothing refused.

**Resources.** No Docker object, no network, no tunnel, no port. Fakes only.

- Author: Sonnet 5.5 (claude-sonnet-5-5), lane `j3-cursor-followups`.

## 2026-10-24: a project page per service, kept up to date (the author's choices, lane `j3-project-page`, issue #274)

**The need.** Issue #274, validated by the owner on 23 October: the context of a repository is rebuilt in every session. A page per service, made at its first connection, made again after each merge, and read by the sessions at their start. Matrix lines P101 to P105, checked free on `origin/v2` (ends at P87) and in the open pull requests: 311 holds P90 to P92, and 312 (the review follow-ups of the ledger's MCP server, issue #301) holds P95 to P100, so this lane starts at P101, not P100.

**Decision.**
1. **Where it lives: the state folder, not the repository.** `<state>/pages/<service>.md`. `lib/memory`'s `project` entry is the committed `docs/project.md`; writing there would be a commit and a push to the project. The page is Cleared's own, written beside itself then renamed, mode 0600. Not under `<state>/services/<name>/`, which only a memory level makes: two tests of milestone 1 pin that no such folder exists for the workspace's own checkout.
2. **What it holds, read from the base branch only** (`git ls-tree` and `git show` on `refs/remotes/origin/<base>`): the package name, the README's first paragraph, the layout to two levels (60 entries), the `package.json` scripts, the safe commands of `.cleared/agents.conf`, and the last 15 first-parent subjects as the recent decisions. An untracked file of the checkout cannot reach it (test).
3. **No secret (P102).** Files that can hold one are left out by name, even from the layout (`.env*`, keys and certificates, credentials, secrets, password and token files, `.npmrc`, `.netrc`); the text is then cleaned with `session/clean.ts` (the service's secret values, the guard's patterns) and a list of token shapes the guard does not name (the common forge, chat, cloud, registry and payment tokens, and JWTs) and a secret's name followed by its value. Each field (script, safe command, subject, README line) is cleaned on its own before it is formatted, since the guard's patterns for an assigned secret start at a line's beginning, which a field in the page no longer is; `.envrc` is denied too. The test commits an `.env`, an `.envrc`, a `config/.env.production`, a `.pem`, a README with a planted token, a commit subject with one, a script and a subject that set a secret of no known shape, and runs on the tracked files of `examples/guestbook`; it looks for them in the page and in the whole state folder.
4. **First connection = the first fetch of the service's checkout** (`refresh` in `flow/effects.ts`, which every first use of a service goes through). The page is made if absent, and a later fetch makes it again only if the base moved (the page carries the base's sha; an unmoved base leaves the file untouched). So a merge made on the forge itself, or by a train, is in the page at the next fetch even if no hook ran. A page that cannot be made is logged and never stops the fetch or the briefing.
5. **After a merge (P103).** `FlowEffects.updateProjectPages` (optional, so no fake changes), asked from the engine's `#emit` on `release_merged`, which the one-service merge and each merge of a train both emit; tracked by `settled()`, its failure logged and swallowed. It fetches each service's base and writes the page again only if the base moved (the page carries the base's sha). A queued or refused merge asks nothing.
6. **Read at the start (P104).** `CLAUDE.md` gets `## Generated page of the service <name>`, quoted line by line as memory data like every other memory block, for the author and the reviewer. The contract's `projectPage` carries it only when the project commits no page of its own: the committed `docs/project.md` stays the contract's page. `renderBriefing` with no option is unchanged.
7. **Size (P105).** At most 8 KiB.

**A test of milestone 1 changed.** "a one-service workspace briefs its session as milestone 1 did, byte for byte" compared the whole `CLAUDE.md` with the fixture. It now compares the fixture's length as a prefix (milestone 1's text, unchanged) and checks that the one section added is the generated page. The fixture is untouched; the other test's `services` assertion needed no change because of decision 1.

**Not done, and why.**
- The lead's briefing (`lead/briefing.ts`) is not given the page: it builds a list of service lines of its own from `lib/memory`, and a second format for it is a decision of its own. The issue asks for the sessions' briefing.
- No wiki, no editing, no screen (out of scope). The page is not yet shown in the app.
- Commit subjects stand for decisions. A project that keeps a decisions folder gets it through `lib/memory` as before; the page does not read it.

**Checks.** Tests written first and committed alone (`971d145`, rewritten before the pull request: its first version held a literal key marker the repository guard refused): 10 of 11 failed on the old code (the 11th, "a queued merge asks for no page", guards the old behaviour); the review round added 3 tests and a train test, and 12 of the 13 tests of the two files fail on `origin/v2`. `npm run typecheck`; `npm test` (1744 node tests: 1706 pass, 38 skipped, 0 fail; 260 Vitest tests pass); `npm run guard -- --base origin/v2`: nothing refused.

**Resources.** No Docker object, no network, no tunnel, no port. Sample repositories are local bare repositories in temporary folders; nothing is pushed.

- Author: Sonnet 5.5 (claude-sonnet-5-5), lane `j3-project-page`.

## 2026-10-24: Close a release card or a ticket (the author's choices, lane `j3-reject-close`, issue #249)

**The need.** A release card offered Approve (merge and deploy) and Send back (a new flow). A ticket that should never ship, such as a rehearsal ticket of a proof run, stayed waiting, and the proof's launch guard refused to start while a release waited. The owner approved "Rejeter ou Fermer une carte" on 2026-10-23. Matrix lines P53 (filled) and P110 to P114, checked free on `origin/v2` (P95 to P109 belong to other lanes).

**Decision.**
1. **One word, Close, one route.** `POST /api/tickets/:id/close` with a mandatory reason serves the release card and the ticket's page. The owner's text allows either word; Close says what happens (the ticket ends), and Reject already means refusing a knowledge item.
2. **Set aside is reused, not changed.** `FlowEngine.setAside` and `closeTicket` share one private path (`#takeOut`); set aside's messages, codes and refusals are as before, and its tests are untouched. Close adds the reason: on the ticket's comment (with who closed it), on the `ticket_put_back` event (reason `closed`), and on the release card as an `outcome` `{ decision: 'close', reason, by, at }`.
3. **No seventh state.** A closed ticket is in Todo, as a ticket set aside is, with its comment and its event; the tracker's six states and the configuration do not change. Done would count it as landed in the Tower, and a new state would change the tracker contract. The cost: nothing marks a closed ticket in Todo except its last comment and the journal. If the owner wants a closed ticket hidden from Todo, that is a state and a tracker change of its own.
4. **A done ticket is refused (409).** It shipped; there is nothing to close. Set aside keeps its rule (a done ticket's waiting knowledge item is settled).
5. **The pull request is left alone (P114).** The issue proposes closing it without deleting the branch. That is a forge write the service has no effect for today (only the proof's script runs `gh pr close`, P51), it is outward-facing, and it is not among the owner's three criteria. Not done; the question is open. Until then the owner closes the pull request on the forge, or the proof's script does.
6. **"Stays in the history" is the inbox's history.** The inbox shows what was handled in the last day (`InboxStore.list`), so the closed card is listed there for a day, like every handled card. The reason and who closed it stay for good in the ticket's comment. No new history screen.
7. **The ticket's Close is on the session screen**, so a ticket that never started has no page to close it from; the route serves it (a call, or a later screen).
8. **The Tower** lists what waits in the inbox, so a handled card leaves it without a change of its own; the browser test reads it before and after.
9. **The fixtures source closes in memory**, as it answers a request, so the browser test runs on the real screens in French and in English.

**Tests first.** The tests were written before the code and run on `origin/v2`: 4 of the 5 tests of `test/flow/close.test.ts`, the API cases and route lists that name the new route, the model tests of `app/test/inbox/close.test.ts` (their module did not exist), the 4 browser tests and the 3 Vitest tests all failed there. The one that passes on the old code, "set aside is as it was", pins P61 on purpose. Three existing Vitest tests that list a release card's buttons now list Close first.

**Checks.** `npm run typecheck`; `npm test`; the browser test with `CLEARED_V2_PLAYWRIGHT`; `npm run guard -- --base origin/v2`. `app/test/notify/browser.test.ts` fails on `origin/v2` too in this environment.

**Resources.** No Docker object, no network, no tunnel, no port, no secret.

- Author: Sonnet 5.5 (claude-sonnet-5-5), lane `j3-reject-close`.

## 2026-10-24: open the session's checkout in VS Code or Cursor (the author's choices, lane `j3-open-editor`, item 19 of the Devin complement, matrix C19)

**The need.** Milestone 3, item 19 of [complement-devin.md](complement-devin.md): from the session screen, a button that opens the session's worktree in VS Code or Cursor. Matrix lines P120 to P125, checked free on `origin/v2` (it ends at P105; `j3-reject-close` holds P110 and above, as the owner said, and this lane starts at P120).

**Decision.**
1. **A link, not a launch.** The service never starts an editor and runs nothing. `GET /api/sessions/:id/editor` answers `{ mode, links: [{ editor, url }] }` and the person's own browser hands the address to their own editor. Without SSH (`mode: local`) the links are `vscode://file/<path>` and `cursor://file/<path>`, for a browser on the machine the checkout is on; with `CLEARED_V2_EDITOR_SSH_HOST` set (`mode: ssh`) they are `vscode://vscode-remote/ssh-remote+<host>/<path>` and the `cursor://` twin, for an editor that reaches the server over SSH. The host is the name in the person's ssh config. Not a tunnel, not a port, not a proxy: Cleared opens nothing.
2. **The folder comes from the service, never from the request.** `engine.sessionWorkdir(id)`, the checkout the service itself prepared; a `?path=` or a header is not read (test). Then `realpath`, and the result must be a directory with a `.git`, strictly inside the work folder (`CLEARED_V2_WORKDIRS`): the folder itself, a link that leaves it, `..`, a sibling sharing its prefix, a relative path and control characters are refused (403); a checkout that is gone is 409. The link carries the real path.
3. **Who.** Any signed-in person the service knows (the proof, a known user, never the lead nor the flow, as the terminal and the editor's save ask). Not the owner account alone: the link reads nothing of the checkout and writes nothing, unlike a save. The route is not limited to a live session, so the checkout of an ended one can be opened while it still exists.
4. **Encoding and the host.** Each path segment goes through `encodeURIComponent`, and an apostrophe is encoded too (`%27`), which the screen would otherwise refuse, so a folder named `cleared editor #1 ?50% o'k` (the test's) cannot cut or change the link, nor hide the button. The SSH host is checked when the service starts (`FlowConfigError`): an optional `user@` and a name that starts with a letter or digit, never a dash (ssh would read an option), no slash, hash, question mark, percent sign, colon or space.
5. **The screen.** "Open in an editor" in the thread's header beside Take over; it reveals the two links as plain anchors (no `target`, no script). The screen asks the route when the session changes or ends, hides the button for any non-200, and keeps only an address of the editor it names (`vscode://` for VS Code, `cursor://` for Cursor, nothing with a space, quote or angle bracket), so a wrong answer never reaches an `href`. fr and en.
6. **The path leaves by this route alone.** The events and the files shown keep cleaning the host's paths (the cleaner strips the work folder and the home folder); this route gives the path to a signed-in person, is not logged, and a refusal names none. The tests and this entry use temporary folders and `example.invalid` hosts only.

**Edits made in the editor bypass the app's guard.** A save through the app's Editor tab passes `session/policy.ts` and is journaled as `cleared.human_edit`. A change made in VS Code or Cursor on the folder does neither. A taken-over session finds it at Give back (the git state, flow/takeover.ts); a live session sees the files change under it. The owner did not ask for a gate, so there is none; the button's note says that the person's own editor does the opening.

**Not done, and why.**
- No `code --folder-uri` or `cursor` command on the server, and no `docker` object: the owner asked for a link.
- No per-file link (`vscode://file/<path>:<line>`): the issue is the worktree.
- A checkout the service no longer knows (it restarted since the session ran) answers 409 as a gone one does, by the same path as the files route; only the gone checkout is tested.
- The remote link uses the SSH host as written; the user name, key and port are the person's ssh config's. A tailnet name is the owner's to put in `CLEARED_V2_EDITOR_SSH_HOST` and is never in the repository.
- A `devcontainer`/container-attach link (`attached-container`) for the session's Docker container: not asked, and the container is a Docker object.

**Checks.** Tests first and committed alone (`2a1b250`): on `origin/v2` the service test does not load (no `flow/editor.ts`: 0 of its 8 tests run), the 6 Vitest tests fail, and the browser test (skipped without `CLEARED_V2_PLAYWRIGHT`) fails at that commit in Chrome: it times out waiting for `#open-editor`. The test's assertions were then adjusted in the implementation commit (the encoded-folder pattern, a sibling folder that exists, the blank host read as unset, then an apostrophe in the folder's name), with no change to what each test checks. The browser test ran in Chrome through `playwright-core` from a folder outside the repository: 1 test, pass. The route lists and counts that three older tests pin (`test/api/types.test.ts`, `test/flow/modules.test.ts`, `test/flow/api.test.ts`) now include the new route. `npm run typecheck`; `npm test` (1781 node tests: 1738 pass, 43 skipped, 0 fail; 269 Vitest tests pass); `npm run guard -- --base origin/v2`: nothing refused.

**Resources.** No Docker object, no network, no tunnel, no port; the browser test listened on a loopback port chosen by the system, outside the reserved ones. Nothing installed globally (`npm ci` in `v2/` only). The first piloted project untouched.

- Author: Sonnet 5.5 (claude-sonnet-5-5), lane `j3-open-editor`.

## 2026-10-24: the contract formats JSON Schema, protobuf and events (the author's choices, lane `j3-contract-formats`, matrix M11, owner decision O11)

The contract step of a multi-service ticket read OpenAPI 3 only: `contract = <other>:<path>` was refused by the workspace file, and the fake could not read anything else. Owner decision O11 put the other formats in milestone 3. This lane reads them.

1. **The prefix is the format.** `contract = openapi|jsonschema|protobuf|events:<path>`. Any other prefix is refused with the list. One `ContractFormat` type (`api/types.ts`) is used by the service shape and the siblings' sources; the fake names the same four (`CONTRACT_FORMATS`) and a test compares the two lists, since the image cannot import from `src`.
2. **A format-less sibling is OpenAPI.** `SiblingSpec.contractFormat` is set only for the three new formats, so a milestone 2 plan, its tests and the container's environment are unchanged byte for byte; `FAKE_FORMAT` is passed to the fake only then. `stepSiblings` rebuilt a service step's fake field by field and would have dropped the format silently; it keeps it now, with a test.
3. **JSON Schema: examples, no validator.** The fake answers, it does not check. `GET /` is the root's example, `GET /<name>` each `$defs` entry. Order: `example`, first `examples`, `default`, `const`, first `enum`, then by type. Local `$ref` only; a `$ref` that leads back into itself leaves the property out. Strings are plain words (`string`, `user@example.com`, a nil uuid), never a shape the guard or a scanner would take for a secret.
4. **Protobuf: a minimal parser, not a library.** The fake image has no `npm install` and no dependency (its Dockerfile copies `.ts` files for Node's type stripping); a library such as protobufjs would add a build step and a supply chain to an image that runs next to a session, to read a shape the fake only needs the messages of, never to encode a byte. `images/fake/proto.ts` reads a stated subset of proto3 (messages, nested types, enums, `oneof`, `map`, `repeated`, `optional`, `reserved`, unary services) and refuses the rest with `file:line` (`import`, `extend`, field options in brackets, streaming, proto2, an unknown type, a field number used twice). A contract is therefore one file. **The fake speaks HTTP, not gRPC:** `POST /<package>.<Service>/<Method>` answers the response's example in the proto3 JSON mapping (lowerCamelCase, 64-bit integers as strings, enums by name, one element per list and map). A consumer that needs the binary protocol is not served by this fake; that is a decision for a later lane.
5. **Events: AsyncAPI 2.** Nothing in the matrix, the plans or O11's entry pinned the events format; AsyncAPI is the usual one, and a subset is enough: `GET /events/<channel>` answers the message's first `examples` payload, else a payload generated by the JSON Schema generator, else a 501 naming the channel; `POST /events/<channel>` answers 202 so a producer under test has somewhere to publish, and both are counted by `/__fake/calls`. AsyncAPI 3, bindings, a channel name that is not one path segment and a remote `$ref` are refused. The YAML subset has no list of mappings, so an `examples` list is written in JSON.
6. **The image copies what it imports.** The Dockerfile now copies `schema.ts`, `proto.ts` and `events.ts`; a test reads the imports of `fake.ts` (and of what it imports) and checks each is copied, since a forgotten module is a fake that cannot start and nothing else would notice before a real session.

**Two tests of milestone 2 changed on purpose.** `test/flow/config.test.ts` asserted that `contract = protobuf:filter.proto` is refused with "OpenAPI". It now asserts that the four formats are read, that an unknown prefix (`swagger:`) is refused with the list, and that a path outside the repository is still refused. `test/runner/image.test.ts` listed the fake image's two files and now lists its five. The swagger 2.0 refusal in `test/container/fake.test.ts` is untouched and passes.

**Not done, and why.**
- The contract step does not parse the contract the author proposed: a malformed `.proto` is found when a later step's fake starts, as a malformed OpenAPI file was before. A check at the step's end is a lane of its own (it needs the human's view of the failure).
- No binary gRPC, no JSON Schema validation, no AsyncAPI 3, no screen in the app showing the format.
- The contract step's prompt does not name the format; the author reads it from the file's extension and the workspace file.

**Checks.** Tests written first and committed alone (`85815e3`): 13 of 13 tests of the new file `test/container/fake-formats.test.ts` and the 4 added to `config`, `services`, `steps-model` and `session-runtime` failed on the old code (the Dockerfile test fails there on its size floor, not on a missing copy; the OpenAPI-default assertions inside the file's 11th test are guards of the old behaviour). `test/container/fake.test.ts` passes unchanged. A first run of the JSON Schema test found a real defect of the first version: a `$defs` entry that contains itself was expanded once before the cycle was seen; the definition's own reference is now on the stack from the start.

**Resources.** No Docker object, no image built, no network, no port, no tunnel, no secret. The tests are unit and loopback.

- Author: Sonnet 5.5 (claude-sonnet-5-5), lane `j3-contract-formats`.

## 2026-10-24: the matrix catches up with the merged lines of milestone 3 (the author's choices, lane `j3-matrix-sync`)

**The need.** Rule 1 of `requirements-matrix.md` says the lines are filled at every merge; many milestone 3 lines still read `in progress` with a lane name or an issue number, though their pull request is merged in `v2`. Documentation only: no code, no test changed.

**What was checked, line by line.** `gh pr view <n> --json state,mergeCommit` for 20 pull requests (288, 295, 297, 298, 300, 302 to 316): all `MERGED` into `v2`, each merge commit an ancestor of `origin/v2` at `78139de`. Every test file named in the "Proven by" column of the edited lines exists. With `npm ci` and `npm run build` in `v2/`: 635 tests of the named `node --test` files pass, 0 fail; the 13 browser tests they hold (consumption, close, questions, editor, replay) were skipped without `CLEARED_V2_PLAYWRIGHT` and pass with it and the installed Chromium (13 of 13); the 10 named Vitest files pass (55 tests). The body of each pull request names the ids it delivers (checked).

**Decision.**
1. **Pull request numbers, not issue numbers.** The column held issue numbers for five lanes: 249 is pull request 314, 274 is 313, 294 is 310, 296 is 311, 301 is 312. The cells now read `314 (lane j3-reject-close, issue #249)` and so on. A lane named without a number got its number (297, 298, 302 to 309, 315).
2. **Done:** P54, P57, P58, P65 to P68, P70, P72 to P80, P82, P86, P87, P90 to P92, P95 to P105, P110 to P113, P120 to P125, P130 to P135, P53, C14, C19, M11, B3.11. P58's proof, "P77's", now names P77's test files. P92's proof is a document: `proof-clean-base.md` names `PROOF_REVIEW_ROUNDS` and `CLEARED_V2_REVIEW_ROUNDS`, 3 by default, and says a round is a verdict of the same reviewer session.
3. **Judgement calls.**
   - C14 is `done`: the criteria the owner approved on issue #272 (a "Resume from here" on each step, the branch back to the step's commit, the old continuation readable, a service and a browser test) are the ones P76 meets. The note that the thread "is not played again" and the one-service limit stay in the cell. If the owner meant a playback of the old session by "Replay", C14 goes back to `partial`.
   - P53 is `done`: P114 (closing the pull request on the forge) is not among the criteria the owner approved and stays `open`.
   - O11: only its second half moves, to `done (the other formats, M11, 315)`; the OpenAPI half still waits on M2, which is `partial` (the real run).
   - M4 stays `partial`: only "once merged" became "delivered, 295"; the notes between the sessions of a ticket's steps are still later.
4. **Left as they were, and why.**
   - P71 stays `in progress`: its code and tests are merged (302) and green, but the usage endpoint's shape was read from the CLI's code, never from a real account; no lane runs on it, and its first real read is still to be made.
   - P69, B5.1c, D13, O6, B6.3, O15: the real Codex and Cursor trials are the owner's.
   - P114 is `open`, the owner's question.
   - C6 and P140 to P144 belong to pull request 317, still open.

**To follow up (not done here, the task is documentation only).** The CI job "browser" in `.github/workflows/v2.yml` lists 12 files and does not list `consumption-browser`, `close-browser`, `questions-browser` and `editor-browser`: those four are green only when run by hand with `CLEARED_V2_PLAYWRIGHT`, and CI never runs them. A lane should add them to the list.

**Checks.** `npm run typecheck`; `npm test`; `npm run guard -- --base origin/v2`; the results are in the pull request.

**Resources.** No Docker object, no image, no network call beyond `npm ci` and `gh`, no port opened but the browser tests' loopback ones, no tunnel, no secret, no real Codex or Cursor account.

- Author: Sonnet 5.5 (claude-sonnet-5-5), lane `j3-matrix-sync`.

## 2026-10-24: Hand over to Codex, and back, and the cross-harness review (the author's choices, lane `j3-handover-codex`, matrix B6.3, P150 to P155)

`handover()` rejected with `NotImplemented` on every adapter and the composer's "Hand over to Codex" button was off with "comes in milestone 3". The flow started every session on `claude-code` (`HARNESS`, pinned by P87), although the Codex adapter exists since P69. This lane makes a live author's work move to the other harness of the contract and back, and the review come from the other harness.

1. **A new session, not a resume.** Codex cannot read a Claude transcript, so the target is always a new author session on the same ticket, the same checkout and the same briefing (`workdir` is not prepared again: the source's uncommitted changes are the point). The way back is the same gesture in the other direction, a new Claude session, not the first one resumed: resuming Claude after a `stop()` that removed its container is not shown anywhere, and a new session with the note works the same in both directions. The cost is that the first Claude session's transcript stays in its own row (stopped), and the ticket now has three author rows.
2. **The contract returns a note; the engine does the rest.** `SessionHandle.handover(to)` writes nothing and stops nothing: it checks the target (`session/handover.ts`: claude-code or codex, not the session's own harness, not Cursor, a model named) and answers the note read from its own journal: the last thing it said (cut at 4000 characters), the files an edit changed and that did not fail, the plan it proposed. The same function serves the fake, Claude Code and Codex handles, so the note does not depend on the harness that wrote it. Cursor's handle keeps `NotImplemented`: Cursor stays out of the flows until the owner's trial (P87), whose test is unchanged and gained a line that the handover's targets name no Cursor. `HARNESS` in `flow/engine.ts` is still `claude-code`, character for character: it is the default, and a handover is the only way a session starts elsewhere.
3. **The source is paused first.** `handOver` uses Take over's own pause, so the end of the interrupted turn is not taken for the end of the work (no review, no `ticket_put_back`, no handover capture), then gives the note, starts the target, journals `cleared.handed_over` on both sessions, and only then stops the source (`stopped`). A target that does not start gives the source back with Give back and answers 503. Found while testing: the cancelled end of the interrupted turn could be read after the stop and put the stopped row back to `waiting_human`; a closed session now ignores it.
4. **Who may.** The owner account only, as Take over (the same checks, in the same file). A session the watchdog stopped while it waited for a person is handed over too: it is the stuck session the proof means (the idle rule parks a session that waits for a person after `idleMs`), and an advisor read of the engine found that `#liveSession` would have refused it with "stopped" while the row still offered the button. Nothing to interrupt there: its note is read from the journal, what it waited for is settled (`#endDormant`), and a target that does not start leaves it dormant for its answer. The session summary says `dormant` so that the screen does not take its `stopped` phase for an ended session. Refused with 409: a reviewer's session, a session taken over, a step's or a variant's session (their maps would need to follow the new id; not done), a session whose plan waits for its Go (the plan's gate is the session's), a stopped one. 400 for an unlisted harness, Cursor included, or an empty model; 503 when the target has no adapter. The route is in `flow/takeover.ts` because it shares the guard. The model, when the body names one, is letters, digits and `. _ : / -`: it reaches the Codex command line, and the app never sends it. The button is off while the session's plan waits for its Go, as the service refuses then.
5. **Every resume goes through the session's own adapter.** About fifteen places looked up `sessionAdapters[HARNESS]`. After a handover, Give back, the wake of a stopped session, the author reopened after a review or a CI failure and the reviewer resumed by the channel would have resumed a Codex session through Claude's adapter. They read the harness of the session's row now (`#harnessOf`); the starts of new tickets, steps and variants stay on Claude. A Codex author started again after a failed resume is started on Codex.
6. **The review is by the other harness, after a handover only.** A ticket whose flow had an author that is not on Claude is reviewed by the harness that did not write the last change: Codex's work by Claude, Claude's return by Codex (the reviewer's read only sandbox of P69). A ticket that never changed harness keeps its Claude reviewer: making every ticket cross-reviewed would need a Codex account for every ticket, and it is the owner's to choose. The flow's sessions are now read in the order the flow started them (a set), not by `created_at, id`: two sessions of a handover can share a millisecond (the fake clock does), and the last author was then picked by the random order of two UUIDs.
7. **Models.** A Codex target runs on `CODEX_MODEL = 'gpt-6-luna'`, the account's default found in `docs/adapters.md` (the app server's `model/list`), unless the body names a model. It is a constant of the engine, not a setting: a setting is a lane of its own. The reviewer on Codex uses it too; the `reviewer:<model>` sensitivity names a Claude model and is not read for Codex.
8. **The screen.** The composer's existing button is wired, not a new one: "Hand over to Codex" on a Claude author, "Hand back to Claude Code" on a Codex author, in French "Confier à Codex" and "Confier à Claude Code". It is off, with the reason said, for Cursor, a reviewer, an ended or a taken over session. The two keys of the old stub (`handover`, `handover_note`) are replaced. The stub was hidden in a narrow thread because it did nothing; it would have hidden the action, so a narrow composer wraps instead. The ticket's view follows the new author through the same refresh as Resume from here. The fixture source has the route, so the browser test clicks there and back in Chrome.
9. **The proof's step.** `scripts/proof-handover.ts` holds the decisions a driver takes (a session waiting for a person is stuck, one at work is waited for, a Codex, Cursor or taken over one is refused) and reads the sessions afterwards; its test plays the whole step with fakes, through the HTTP route: stuck Claude, hand over, fake Codex finishes, Claude reviews, the release card waits. The real run is the owner's: nothing here used a Codex or a Cursor account.

**Not done, and why.**
- Two sessions working on one ticket at once (the last words of B6.3) are not delivered: a handover stops the first.
- No row in the timeline says "handed over": the two sessions carry `cleared.handed_over`, the screen does not draw it yet.
- A Codex author has no host tools (its adapter takes none), so it cannot call `report_changes`; the release's flags read the last author's report, which is then none. A ticket handed to Codex publishes without the changes report of the Claude session.
- The question the owner may want to settle: whether every ticket, not only a handed over one, should be reviewed by the other harness (default taken: only after a handover).
- `session_stopped` is emitted for the source of a handover with the reason "Handed over to codex (id)": its only reader is the lead's prompt, which tells it in words; no plan item or notification reads it as a failure.
- Steps and variants cannot be handed over; a handover is not offered to the lead.

**Checks.** Tests first and committed alone (`2fdd685`). The app tests were then reworked in the implementation commit, after finding that the composer already had the button. The final tests, copied onto the code of `origin/v2` (`78139de`) in a temporary worktree: the service files `test/flow/handover.test.ts` (with the dormant session, the author tools on and the model name among its tests), `test/session/handover.test.ts`, `test/scripts/proof-handover.test.ts`, `app/test/session/handover.test.ts` and the three adapter files do not load (no `session/handover.ts`, no `HandoverRefused`); `test/session/cursor/reachability.test.ts`, `test/session/events.test.ts`, `test/api/types.test.ts` and `test/flow/modules.test.ts` fail on one to two assertions each; 3 Vitest tests fail (the composer's button, twice, and the old stub's assertion changed on purpose); the browser test (Chrome, `CLEARED_V2_PLAYWRIGHT` on another project's `playwright-core`, `CLEARED_V2_CHROME=/usr/bin/google-chrome`) fails. On the lane: `npm run typecheck`; `node --test` over the service and app files with the browser files run in Chrome (1828 tests, 1813 pass, 2 skipped, 13 fail), then the 271 Vitest tests pass; the four tests of `tabs-browser`, the new one among them, pass. The 13 failures are not this lane's: 12 browser tests (the inbox's answers and Close, the reviewer's request, the Traité group, two sessions visited, the lead's address) fail the same way on `origin/v2` in this environment, and `twenty switches among the five screens` (a 100 ms budget) failed under the load of the whole run and passes alone. `npm run guard -- --base origin/v2`.

**Resources.** No Docker object, no image, no network but loopback ports chosen by the system, no tunnel, no secret, no Codex or Cursor account (fakes only). `npm ci` in `v2/` only. A temporary git worktree in the scratchpad, removed. The first piloted project untouched.

- Author: Sonnet 5.5 (claude-sonnet-5-5), lane `j3-handover-codex`.

## 2026-10-24: notes between the steps, the contract step reopened, the handover filed in the right contract (the author's choices, lane `j3-contract-notes`, M4, P160 to P163)

**The need.** M4 of the multi-repository complement (item 4) was `partial`: the author-reviewer channel existed (P65), and three things were left: notes between the sessions of a ticket's steps, a contract change that reopens the contract step with the human's approval, and a handover that feeds the contract's memory. Tests were written first; each defect test fails on `23f8cc8` (checked on a copy of that tree with the new tests laid over it).

**Decision.**
1. **A changed contract reopens the contract step (P160), and this replaces a rule of lane 23.** Lane 23 put the ticket back (`step_failed`) when a service step ended with the validated contract changed, and `test/flow/steps.test.ts` pinned it. That test is rewritten, not doubled. The change is now a new `contract` item on the contract step (the step goes back to `validating` with the new file and blob), so Approve and Send back work unchanged and a Send back resumes the contract step's own session. The changing step waits, the ticket stays In Progress, a comment says what happened. The snapshot round is counted over the contract step's items, so a reopened contract never overwrites an earlier validated folder.
2. **What ran on the old contract runs again (P162).** On reopening, the ticket's other running sessions are stopped and their steps wait (they were built against a contract nobody approved any more). On Approve, the `done` steps that come after the contract step, directly or through others, wait again. The first approval has no such step, so it is unchanged.
3. **Notes (P161): a host tool, handed over at the next turn that exists.** `leave_note` is offered to the step sessions of a ticket on several services, whatever `authorTools` says, and not on a one-service ticket (its sessions get no tool, as before). A note is cleaned, journaled on the sender's session, and said to the lead as a flow event (`step_note`, a line of its thread). It is handed to a session when that session starts for another step (its prompt) or is reopened (the message that reopens it), as reference data, once per session. A running session is not interrupted: its container has no channel for a message mid-turn, and the review channel (P65) has the same limit. The seen notes are journaled on the receiver (`cleared.step_notes_read`) rather than kept in memory, so a restart does not hand them twice.
4. **The contract a handover is filed in (P163).** Lane 19 filed `## Lessons for the contract` in the session's own contract, else the first one it consumes. For a consumer of two providers whose ticket changes the second, the lesson went to the first. The engine now tells `captureHandover` which contract the step's prompt names; the lesson and the knowledge module's `## Decisions for the contract` follow it. With no contract named (the integration step, a one-service ticket) the rule is the old one, pinned by a test that passes on both.

**Left as it was, and why.** The contract memory level itself (lane 19) is unchanged. A note is not a lesson: it lives with the ticket and is not filed in any memory; the lessons and decisions sections of the handover are the path to memory, as before. A service step that changes the contract and another file is allowed as before (the contract step's "contract file only" rule stays for the contract step).

**To follow up (not done here).** The session screen does not yet show the notes (they are in the ledger as `cleared.step_note`, the lead sees them); a screen with its French and English words is a lane of its own. The two other callers of `captureHandover` (a variant's author and the author reopened after a review) still file contract lessons with the first-contract rule on a ticket of several services; they name no step.

**Checks.** `npm run typecheck`; `npm test`; `npm run guard -- --base origin/v2`; the results are in the pull request.

**Resources.** No Docker object, no image, no network call beyond `npm ci` and `gh`, no port opened, no tunnel, no secret.

- Author: Sonnet 5.5 (claude-sonnet-5-5), lane `j3-contract-notes`.

## 2026-10-24: the matrix synced to pull requests 319 and 320, C13 and O11 read (the author's choices, lane `j3-matrix-sync2`)

**The need.** Rule 1 of the matrix: a merged lane's lines carry the pull request number and their status. Pull requests 319 (P150 to P155) and 320 (P160 to P163, M4) were merged into `v2` and their lines still said `in progress`. C13 (Fix the CI) said `later` while P77 (pull request 307) had delivered issue #273. O11's OpenAPI half said `planned`. Documentation only, no code.

**Decision.**
1. **P150 to P155 and P160 to P163: `done`, with 319 and 320.** `gh pr view` shows both `MERGED` into `v2` (2026-10-24 21:36 and 21:52 UTC) and green `verify` and `browser` checks. Every test file the lines name exists and passes with `node --test` (the handover, the steps, the engine, the effects, the events, the knowledge, the proof-handover and the app files); the web files pass with `vitest run`. `app/test/session/tabs-browser.test.ts` skips its four Chrome tests unless `CLEARED_V2_PLAYWRIGHT` is set; they ran green in the `browser` job of both pull requests, which is what P153's Chrome click rests on.
2. **M4: `done`** (295 for the review channel, 320 for the rest). Its five test files pass, `test/flow/channel.test.ts` included. The session screen still shows no notes: a lane of its own, said in the line.
3. **C13: `done`, covered by P77 (307).** Issue #273's five criteria (a failed CI of a pull request Cleared opened, at most 2 attempts, the result in the inbox, never on `main`, a test with a simulated CI) are P77's, proved by `test/flow/ci-repair.test.ts` and `app/web/test/inbox/repair.test.tsx`, both green. P58 already said so. What C13 does not reach is written in the line: P77 repairs the one-service release card; a train and a pull request Cleared did not open are not repaired.
4. **O11: `partial`, not `planned`.** The other formats are `done` (M11, 315). OpenAPI 3 is delivered since milestone 2 (lanes 15, 23, 28) and its tests are green (listed in the line), but O11 rests on M2, which is `partial` until the real run of proof j2-multi; O11 follows it.

**Added after pull request 317 merged into `v2` (2026-10-24 22:28 UTC).** C6 and P140 to P144 are `done` with 317: its `verify` and `browser` checks are green, the named files pass here (`node --test`, `vitest run`), and the two Chrome tests of `app/test/tower-batch-browser.test.ts` skip without `CLEARED_V2_PLAYWRIGHT` and ran in the `browser` job.

**Left as it was, and why.** P114 and P170 and after (lane `j3-close-ticket-pr`, merged by 322, their lines are v2's); the owner's lines: B6.3 and B6.3p (the real Codex and Cursor runs), P69, P71, O15. B6.3 still names `lane j3-handover-codex` for its delivered part: the owner's line, the number follows with its real run.

**Checks.** The named tests above; `npm run guard -- --base origin/v2`.

**Resources.** No Docker object, no network call beyond `npm ci` and `gh`, no port opened, no tunnel, no secret.

- Author: Sonnet 5.5 (claude-sonnet-5-5), lane `j3-matrix-sync2`.

## 2026-10-24: Owner decision: closing a ticket in Cleared closes its pull request on GitHub (P114, issue #249, lane `j3-close-ticket-pr`)

**Decision (the owner, 2026-10-24 at 23:51).** Closing a ticket in Cleared also closes its pull request on GitHub, with a comment that gives the reason for the Close. The branch is never deleted. This answers the question P114 left open on 2026-10-24 (the Close of P110 to P113 settled the card and the ticket and left the forge as it was, see "Close a release card or a ticket", item 5).

**What the author did with it (lane `j3-close-ticket-pr`, matrix P114 and P170 to P173).**
1. **Through gh on the host, as the CI repair is (P77).** The pull request is read and closed with the host's `gh` and the forge's credential (`flow/pr-close.ts`, the new `closePullRequest` effect of `FlowEffects`, wired in `flow/effects.ts` on the service's repository). No session touches the forge. The effect is optional: an engine without it closes the ticket and leaves the forge as it is.
2. **Only a pull request Cleared opened.** The pull requests are the ones of the ticket's release cards, which Cleared makes from what it publishes (a repair reuses the pull request, so the cards of one ticket name it once; a train closes one per service, on that service's repository). `gh pr view` must then show a head that is one of the ticket's own branches (`cleared/<ticket>`, or the branch of a resume, issue #272). A pull request on any other branch is refused, a head that is the service's base or `main` or `master` is refused whatever the caller lists (`onBase`, the repair's rule): never on main.
3. **Idempotent.** A pull request already closed or already merged is left alone, with no comment and no error, so a second Close, or a Close after an approval, does nothing on the forge.
4. **The comment gives the reason.** `gh pr close <n> --repo <repo> --comment "Closed from Cleared: <reason>"` followed by a line that says the branch is kept. The reason is the owner's text (1 to 2000 characters, already checked by the Close) and reaches gh as one argument inside that sentence, so it can never be read as a flag. `--delete-branch` is never passed, and a test reads every argument of every call to check it.
5. **A failure is said and never blocks.** The ticket is taken out of the flow first (the Close of P110 is unchanged), then the pull requests are closed. A pull request that gh cannot close, or that is refused, is said in a comment on the ticket ("the pull request #n was not closed on GitHub: close it by hand if it should be"), with the end of gh's message cut to 300 characters and cleaned by the service's cleaner (as P77 cleans what it passes on), and in the service's log by the error's name only. The Close answers as before.
6. **Not changed.** The API's answer, the routes and the screens. A done ticket is still refused before anything is done, so no pull request of a shipped ticket is touched. The proof's own script still closes its pull requests itself (P51).

**Not done, and why.**
- A pull request that no release card names (published, then its card gone) is not found; a ticket that never published has none. The owner closes those on the forge.
- The Close's screen does not say whether the pull request was closed; the ticket's comment says it when it was not. A line on the card would be a lane of its own.
- The real `gh` was not run: the tests use a fake `gh` on PATH that records its arguments, as `test/workspace/publish.test.ts` does. Closing a real pull request is the owner's check on the first real Close.

**The Close waits for the forge.** The Close's answer comes after gh has run (at most 30 seconds per call, two calls per pull request, more for a train); the app's client sets no timeout of its own, so the owner does not see an error on a Close that worked. A slower forge makes the click slower, not wrong.

**Tests first.** `test/flow/close-pr.test.ts` and a case of `test/flow/train.test.ts` were committed alone (`e9c3c8d`) and failed on `origin/v2` (no `flow/pr-close.ts`, no effect). One assertion of the refusal test was wrong and was corrected with the code: it listed the foreign head among the ticket's branches, so the pull request was rightly accepted; the test now lists a head only in the cases of a base branch, which are refused whatever the caller lists. With the code, the 14 tests of `close-pr.test.ts` and the train case pass.

**Checks.** On the branch merged with `origin/v2` (`3d5122d`): `npm run typecheck`; `node --test` over `test/` (1453 tests, 1451 pass, 2 skipped, 0 fail); over `app/test/` after `npm run build` (401 tests, 359 pass, 42 skipped, 0 fail: the browser tests are skipped here, no Chrome or Playwright was set, and this lane changes no screen); Vitest (271 tests pass); `npm run guard -- --base origin/v2`.

**Resources.** No Docker object, no network (a fake `gh` on PATH), no tunnel, no secret. `npm ci` in `v2/` only. The first piloted project untouched.

- Author: Sonnet 5.5 (claude-sonnet-5-5), lane `j3-close-ticket-pr`.

## 2026-10-24: Batches of tickets (the author's choices, lane `j3-batch-sessions`, requirement C6)

**The need.** Requirement C6, "Multiple sessions in batches" (milestone 3, line `later` until now): several tickets launched at once, each its own session, without going past the lanes the Consumption screen allows or the week stop of the subscription. Matrix lines C6 (filled) and P140 to P144, checked free on `origin/v2` (P120 to P125 are #316's and P130 to P135 #315's, both merged).

**Decision.**
1. **A batch is a list of new tickets, not a plan.** `POST /api/batches` takes 2 to 20 titles (with an optional body and labels), creates the tickets in Todo in order, labelled `batch:<id>`, by the person who sent it, and starts them for that person. No lead, no estimate, no approval step: the person who sends a batch approves it by sending it, as with a ticket from the bar. A plan stays the lead's way to order dependent work.
2. **The lanes are the Consumption screen's `maxLanes`, 3 when unset**, the variants' default (issue #271). They count every ticket of the project In Progress or In Review, whoever started it, and the tickets being started, rather than the batch's own, because the limit protects the machine and the subscription, not one batch. Needs Approval frees a lane, as in the plans (a night fills the inbox without blocking). A lever lowered stops nothing that runs.
3. **The stop is the plans' stop, shared.** `quotaStop` in `consumption/quota.ts` (from the plan runner, which now calls it) returns the seven-day or the five-hour window of Claude Code's subscription at or above `CLEARED_V2_WEEK_STOP_PERCENT`. The batch's `hold` says the quota before the lanes, so the person sees the reason that lasts. The plans' day budget is not applied to batches: it is the lead's setting, and its message speaks of the plans.
4. **What starts a pass.** Every event of the project's flow (a lane may have freed), a 30-second timer (a falling figure says nothing on the bus) and the batch's creation. Passes run one at a time; an item is `started` before the flow is asked, so overlapping passes start a ticket once. `FlowEngine.launch` is `start` in the background, waited for by `settled()` like `begin`, but its failure is handed back so the item can say why.
5. **A ticket fails alone, once.** A ticket that cannot start is `failed` with the flow's message (the flow puts it back itself) and its lane goes to the next. A queued ticket that a person moved out of Todo is `failed` and not started. A batch starts each of its tickets once: a ticket the flow puts back later (review rounds spent, a release refused) is the person's to start again, as any ticket. Retrying is the plans' job, with their notes and their attempts.
6. **Kept in the ledger.** `batches` and `batch_items` are the flow module's tables, so a runner built after a restart finishes the queue. The restart recovery puts the running tickets back in Todo; their items stay `started`, as the item says what the batch did, and the ticket's status (read live) says where it is.
7. **The Tower.** A "Batch" chip ("Lot") beside Run a recipe opens a form of one ticket per line, checked in the page (2 to 20 lines, 200 characters each) before the call. The side card shows the three newest batches, with how many started, what holds the rest and each ticket's state. The form sends the workspace's id (`GET /api/workspace`), the project the service names, not the header's name (`me.project`, a label: "Guestbook" in the tests). The bar's New ticket still sends the header's name; that is outside this lane and is left for its own fix.
8. **The fixtures** run the service's own `BatchRunner` over the consumption fixture's ledger, so the batch reads the same lanes and windows as the Consumption screen; their flow only moves a ticket to In Progress. `lanes(n)` and `quota(p)` drive the browser test.

**A test written first was corrected.** `test/flow/modules.test.ts` listed `POST /api/batches` after the terminal routes, in a list the test sorts; it is now in its sorted place. Nothing else of the tests of `0b009a9` changed.

**Tests first.** The tests were committed alone in `0b009a9`, before any code: there, `test/flow/batch.test.ts`, `test/flow/batch-routes.test.ts` and `app/web/test/tower-batch.test.tsx` do not load (`flow/batch.ts` and the model's exports do not exist), the route counts of `test/api/types.test.ts`, `test/flow/api.test.ts` and `test/flow/modules.test.ts` fail, and the browser test calls `lanes` and `quota`, which the fixtures did not have.

**Checks** (after merging `origin/v2` at `cb4badc`, pull requests 316, 318, 319, 320 and 322). `npm run typecheck` and `npm run build` pass. The node tests ran in two parts (`test/`, then `app/test/` with `CLEARED_V2_PLAYWRIGHT`): 1874 tests, 1870 pass, 2 skipped, 2 fail. All 278 Vitest tests pass. The batch browser test passes in French and in English.
- `app/test/notify/browser.test.ts` ("a headless browser registers the worker...") fails the same way on `origin/v2` in this environment, checked in a temporary worktree.
- `app/test/foundation/budget-browser.test.ts` ("twenty switches") measured a p95 of 110.7 ms against its 100 ms budget in the full run, where the test files run in parallel. Its request and document assertions pass. Run alone three times, its median p95 is 35.8 to 38.7 ms on this branch, against 31.6 to 33.8 ms on `origin/v2` in a temporary worktree: the Tower's extra `/batches` read costs about 4 ms, far under the budget. In the earlier runs of this lane, under heavy load (load average 32 on 12 cores), it, `first-paint-browser`, `editor-browser` and `test/mcp/followups.test.ts` also failed once each, and each passed when run alone.

`npm run guard -- --base origin/v2`: nothing refused.

**Not in CI.** `app/test/tower-batch-browser.test.ts` is not in the list of the CI job "browser" (`.github/workflows/v2.yml`), like the four files the `j3-matrix-sync` entry names: it is green when run by hand with `CLEARED_V2_PLAYWRIGHT`. Adding it is the follow-up that entry proposes for the others.

**Resources.** No Docker object, no network, no tunnel, no secret; the tests listen on port 0 on loopback.

- Author: Opus 5.5 (claude-opus-5-5), lane `j3-batch-sessions`, after the tests and a checkpoint of Sonnet 5.5 (claude-sonnet-5-5) before the Orca restart.

## 2026-10-25: The i18n audit reads the code, and the numbers of a sentence are said in the page's language (the author's choices, lane `j2-i18n-audit`, requirement O23, P190 to P195)

**The need.** O23 was "in progress": the lane `i18n` of 2026-10-23 drew every screen of milestones 1 and 2 on the fixtures and checked each word against the catalogs, but a check on drawn screens sees only the states it draws, and the screens added at milestone 3 (Consumption, the batches, the hand over to Codex, the Close, the Editor and Terminal tabs, Open in an editor) were never in it. This lane reads the code itself.

**Decision.**
1. **The audit parses the code** (`app/web/test/i18n-audit.test.tsx`, `test/audit/scan.ts`). Every `.ts` and `.tsx` of `app/web` outside `test/` and `styles/` is parsed, and the test fails on: a word a person reads that is not a catalog key; a number, a duration or a date drawn without `lib/time.ts` and Intl in the page's language; a key the code names that the English or the French file of its catalog lacks; a key built from a prefix that no key matches; a French sentence equal to the English one. A component is checked against the catalog it is drawn with: a screen's own over the shell's, the shell's own files with the tower's over the shell's (as `App.tsx` gives the palette), and a shared component against the catalog of every screen that imports it (Choices and the Editor are in the session, the inbox and the lead). The exceptions are lists with a reason each, and an exception that no longer matches the code fails (P190).
2. **The reader is `rolldown/experimental`'s parser.** TypeScript 7 has no script API, and nothing else in the tree parses JSX. `rolldown` is Vite 8's own bundler; it is now a pinned development dependency (1.2.15, the version in the lock) instead of a transitive import the audit would lose with a Vite upgrade. It never reaches the app's bundle (P195).
3. **A number in a sentence is grouped by the translator.** `format` takes the catalog's `locale` and says each numeric value through `Intl.NumberFormat` ("2 000 caractères", "2,000 characters"); a string value is the caller's text and stays as it is, and a catalog with no `locale` (a test's) writes the number as it comes; the server's sign-in page translates with the shell's catalog, so it groups too. The other way, fixing each call site with `count()`, was not taken: the next call site would forget. A number that is an identifier is a string: three callers handed a pull request's number to `pr_link` and `version` as a number ("PR #1,234"), they pass `String(...)` now, and the audit fails on `number`, `pr`, `port`, `seq`, `year` or `issue` given to a sentence as a number (P191).
4. **The lines a file added and removed, and the Editor scope's counts, were drawn raw** ("+12345"); they go through `quantity` of `lib/time.ts`, and the two copies of `Counts` are one component (P192).
5. **The screens of milestone 3 are drawn in both languages** with the real catalogs and with a translator that says «key» for every key; what the English and the French draws share, of three letters or more, is a word the component wrote (P193). It found nothing: the lanes that added those screens had kept to the catalogs. It stays as the check that they do.
6. **The last clauses of O23 are pinned** (French when nothing chose, "Lead", "Relecteur"; P194), and O23 goes to `done` with the new tests in its column.

**What the audit found, and what it did not.** The code was cleaner than the line said: no JSX text, no visible attribute and no label of its own, and no key missing from a catalog or from one language. The defects were two kinds of number drawn as they came (items 3 and 4). `Consumption`'s own `Intl.NumberFormat` and `DateTimeFormat` calls take the page's language, so they are not a second formatter in the sense of O23; a call with a literal locale or none would fail.

**Fixed decimals stay ungrouped.** `fixed()` (a cost, "1234,50") keeps the earlier lane's choice of no grouping inside a sentence; a count is grouped ("1 234"). The line of O23 asks for Intl, which both use.

**Exceptions kept** (each with its reason in the test): `screens/tower/model.ts` `costUsd.toFixed(2)` (a card value that `planDetail` reads back with `Number()` and says through `decimal()`), `screens/lead/model.ts` `toDateString()` twice (compares two days, says nothing), `components/editor/model.ts` `padStart` (a hexadecimal digest), `Consumption.tsx` `cost.total` (a string `dollars()` already said), the letter `K` of the palette's shortcut, two AG-UI agent descriptions that are never drawn, 15 keys that only a run can tell (each named with where it resolves), and 4 groups of French sentences equal to English ones (names, "Lead", shared words, templates of shared words).

**Three earlier assertions were amended**, as the batch lane did for one of its own: `choices.test.tsx` ("An answer is at most 2,000 characters."), `session/tabs.test.tsx` and `app/test/session/tabs.test.ts` ("first 400 of its 1,000 lines") expected the number raw. Nothing else of the earlier tests changed.

**Tests first.** The tests were committed alone in `8637388`. On that code the formatter test fails on four places (the two `Counts`, each with its `added` and its `removed`), `i18n-numbers.test.tsx` fails in both of its tests (the translator does not group; the Editor tab says "+12345"), and the rule for identifiers, committed alone after it, fails on three callers of `pr_link` and `version`. The other tests pass: they are the coverage of the rest (the key checks, the words, milestone 3), and they stay green because the code was already right there. They are not counted as defect tests.

**Checks** (after merging `origin/v2` at `0baaf81`, pull request 321). `npm run typecheck` passes. `npm test` (the build, `node --test` and Vitest) passes: 1876 Node tests, 1830 pass, 46 skipped because `CLEARED_V2_PLAYWRIGHT` is not set in that run, 0 fail; 295 Vitest tests pass, among them the 17 of the three new files. The browser tests that draw numbers and words, run by hand with `CLEARED_V2_PLAYWRIGHT` (`app/test/i18n-browser.test.ts`, `consumption/consumption-browser.test.ts`, `tower-batch-browser.test.ts`, `inbox/close-browser.test.ts`): 12 of 12 pass. The other browser files were not run. `npm run guard -- --base origin/v2`: nothing refused.

**Resources.** No Docker object, no network, no tunnel, no secret, no account; the tests listen on port 0 on loopback. `package-lock.json` gained one line (the root's `rolldown` entry).


- Author: Sonnet 5.5 (claude-sonnet-5-5), lane `j2-i18n-audit`.
## 2026-10-25: Three gaps of milestone 2 closed: the plan's hold in the policy, the schedules' first tick, the schedule_failed line (the author's choices, lane `j2-plan-schedules`, P29, P33, P34, C12)

**The need.** The matrix kept three lines `partial`: P29 (`flow/engine.ts` `policyFor` did not set `planning`, so the rule `plan.before_go` of `session/policy.ts` was tested but never reached a real harness), P33 and C12 (a service restarted with no browser open ran no schedule), P34 (lib's catalog had no `schedule_failed` line, so a failed run said "a health problem was detected").

**Decision.**
1. **P29, the policy.** `#launch` gives a plan author's policy `planning: true` from its start, so the hold is on before the gate exists (a harness may ask the policy during `start`). `policyFor` then reads the gate: held while its phase is not `working` (`planning`, `held`, `unplanned`, and again after a Change), free from the Go. The session is found by its policy object (`live.input.policy === input.policy`), which an adapter's copy of the input keeps; a policy found nowhere keeps the start's value, which fails closed. A reviewer, a lead and a session with no plan are never `planning`.
2. **P33, the first tick.** The scheduler was already built at start (P62), but its timer first ticks a minute later. Measured before the change: the due schedule was taken after 61 s, not within 20 s. `FlowEngine.recovered` keeps the restart recovery the runtime starts, and the lead module's `start` ticks the scheduler once it is done: the recovery goes first, so it cannot put back to Todo a ticket the tick just started. The claim is the same `UPDATE` as before, so a schedule is taken once whichever tick finds it. A failed first tick is said by the error's name. A route that builds the plans later (a service whose lead was off at start) does not tick at once.
3. **P34, the catalog.** `schedule_failed` is in `HEALTH_CODES` (`lib/notify/contract.mjs`) with `notify_health_schedule_failed` in `lib/i18n/en.json` ("a scheduled run failed") and `fr.json` ("une exécution planifiée a échoué"). `week_stop` already had its line.
4. **Lines.** P180 (the policy), P181 (the first tick), P182 (the catalog line); P29, P33, P34 and C12 are `done`.

**Tests first.** `9901940` (P29), `0ad8836` (P34) and `af6af57` (P33) were committed before any code. On the old code: `test/flow/plan-policy.test.ts` failed (`planning` undefined), `test/notify.test.mjs`'s new test failed (the unknown-code sentence), `test/schedules/restart.test.ts` failed (no run within 20 s; with 80 s it passed at 61 s, which is the timer's minute). The code followed in `24066f5` and `51b8a20`. `af6af57` also renamed the third P29 test, which was named for a reviewer and tested a session with no plan.

**Checks.** See the pull request. `npm run guard -- --base origin/v2` is run before the READY.

**Resources.** No Docker object, no network, no tunnel, no secret, no real account; `restart.test.ts` starts the service as a process on a free loopback port, the lead on the rehearsal's fake adapter, every folder in the temporary directory.

- Author: Sonnet 5.5 (claude-sonnet-5-5), lane `j2-plan-schedules`.

## 2026-10-25: ten ideas from a compared product (owner decision of 01:09)

**Decision.** The owner validated ten ideas, taken from a compared product; they come before the remaining matrix gaps. Matrix lines P210-P219 (a block reserved for them, P183-P209 left to the running lanes), issues #326-#335 (label `v2`).

**Order.** Lanes start as slots free: P210 proof receipt, P211 cost per resolved ticket, P212 launch a ticket from chat; then P213 harness auto-pick, P214 ticket templates, P215 code Q&A with GitHub line links, P216 local agents via MCP, P217 mobile UI, P218 post-deploy verification (Cleared never deploys), P219 prompt-cache token reduction.

**Rules.** Money amounts only from a real source, else tokens and time; chat launch tested with a fake, no real Slack setup; no real Cursor/Codex accounts until the owner's trials.

- Author: Grok Bot (lead), lane `j3-ideas-docs`.

## 2026-10-25: rule 2 of the matrix read for milestones 1, 2 and "always" (the author's choices, lane `j2-matrix-audit`)

**The need.** Rule 2 of `requirements-matrix.md`: before `v2` is merged into `main`, every line of the milestone and of "always" is `done` with a green test, or the merge waits. This lane reads every line that is not `done` at `origin/v2` `0baaf81`, and again at `292ec62` after pull requests 323, 324 and 336 merged, and says what is missing. Documentation only, no code.

**Decision.**
1. **Pull requests.** `gh pr view` shows every pull request the lines name as `MERGED` into `v2`, and each merge commit is an ancestor of `origin/v2` (238, 240, 242, 244, 248, 251, 252, 255, 256, 275, 279 and 282 checked one by one). At the second reading this is the only open pull request into `v2`; 323, 324 and 336 are merged, and their conflicts with this branch were settled by hand in merges of `origin/v2`.
2. **Tests.** `npm ci` and `npm run build` in `v2/`; then the files the lines name: 94 node files (836 tests, 834 pass, 2 skipped, 0 fail), 7 Vitest files (54 pass), and the 9 browser files with `CLEARED_V2_PLAYWRIGHT` (25 tests, 0 skipped, 0 fail). The 2 skipped are the gated `test/terminal/real-harness.test.ts` (`CLEARED_V2_REAL_HARNESS=1`). The `verify` and `browser` checks of `v2` at `0baaf81` were green at `9765285` (their run at `55b35c6` had no result yet when this was written), and the `examples` workflow is green at `54b80e5` with `examples/` unchanged since, which covers the files B6.2m and O11 name there (not run here). The counts of item 2 are the author's own runs, repeated at `55b35c6`, the last commit that changed code, with the same result (836 node tests, 834 pass, 2 skipped; 13 Vitest files, 123 tests; 25 browser tests); they cannot be checked from the repository.
3. **Now `done`** (merged, named tests green, no real run in the proof column): O5 (the merge times of the plan's waves follow its order), O7 (the seed pull request of the filter API's repository is merged, its check passes), O20, O21 (the log entries of lanes 34 to 38 name Impeccable's findings), O22, O24, P46, P48, P49, P50 (the `doctor pool` run of 2026-10-23 is the one the line records), P60, P61, P62, P63 and P64. Their "Delivered by" now carries the number where it said the lane only (275, 279, 282).
4. **Not `done`, and why.** O17 is `partial` (a real review of a two-service ticket, proof j2-multi steps 5 and 6). P47 is `partial`: no run of the gated real-adapter test is recorded. P51 stays open: two real runs in a row. B5.5b, M7, C2, C11 and O12 name code that is still missing, each checked in the source (`settingSources: []` in the runner, `DECISION_HEADINGS` told by no briefing, no ask from the Plan tab, `allowedEdit` with no verdict for `.claude/`). The lines that wait for proof j2 or j2-multi, for the owner or for milestone 4 keep their status with the reason, and the new section "Reste avant v2 -> main" lists them in three groups: code to write, real proof, owner.
5. **Stale test names found.** B5.10a to B5.10e, D1, D5 and D16 are `done` but named test files that the React port deleted (`app/test/tower.test.ts`, `session/render.test.ts`, `lead/render.test.ts`, `lead/reply.test.ts`, `inbox/plan.test.ts`, `inbox/render.test.ts`, `shell.test.ts`), as are `app/test/notify/button.test.ts` (B5.10g) and `app/web/test/french.test.tsx` (O20, replaced by `i18n.test.tsx`). The cells now name the Vitest files that replaced them, which pass here; the statuses do not change.
6. **Left alone, as ordered, then done by others.** O23 (lane `j2-i18n-audit`, 324) and P29, P33, P34 and C12 (lane `j2-plan-schedules`, 323, P180 to P182) were not edited here; both pull requests merged into `v2` and made them `done`, which this branch took in its merges of `origin/v2`. The new section no longer lists them. The matrix was read again at `292ec62` (since `55b35c6` only P210 to P219 and a log entry came in, milestone 3 lines, kept as they are): the lines still not `done` for milestones 1, 2 and "always" are the ones the section lists.

**Checks.** The runs of item 2; `npm run guard -- --base origin/v2`.

**Resources.** No Docker object, no port opened, no tunnel, no secret; the browser tests listen on port 0 on loopback; the Claude login was not used and the gated real-harness test was not run.

- Author: Sonnet 5.5 (claude-sonnet-5-5), lane `j2-matrix-audit`.

## 2026-10-25: Two gaps of milestone 2 closed: the decisions headings in every briefing, the skill ticket's one file under .claude/ (the author's choices, lane `j2-knowledge`, C2, O12)

**The need.** C2 was `partial`: a handover's `## Decisions for ...` sections are read (`knowledge/proposals.ts`) but no briefing told the author the headings, only the lessons headings, and only on a workspace of several services. O12 was `partial`: the daily skill ticket writes `.claude/skills/cleared-<service>/SKILL.md`, and the policy locks `.claude/`, so each such ticket asked the owner.

**Decision.**
1. **C2.** The paragraph that names the lessons headings now names the decisions headings with the same filing: the workspace's memory, the service's (or the workspace's when its checkout is the workspace's), the contract's when one would take it. `DECISION_HEADINGS` moved to `workspace/briefing.ts` beside `LESSON_HEADINGS` (no import cycle: `proposals.ts` imports from `handover.ts`, which imports the briefing); `knowledge/proposals.ts` still exports it. A workspace of one service gets no such paragraph, as before, so the milestone 1 text is the same byte for byte (a test pins it). The choice made: "every service" is every service of a workspace of several, since the paragraph's condition (the filing targets) is not changed here.
2. **O12.** `Policy.skillFile` (a path relative to the workdir). `policyFor` sets it for an author on a ticket that has a row in `knowledge_skill_tickets` (the knowledge module writes that row when it makes the ticket, so a person cannot make a ticket a skill ticket by its text). `allowedEdit` allows an Edit, Write or MultiEdit whose path, resolved against the workdir, is exactly that file, with the rule `edit.skill`; the check comes before the `.claude/` lock and replaces nothing in it. The rows read the table directly (`skillTicketService`), and a store without the knowledge tables answers "no skill ticket", so no module order is needed.
3. **Not allowed, tested.** Any other path under `.claude/` (settings, hooks, commands, agents, another service's skill, another file of the same folder, a path through `..`, a nested `.claude/`), a notebook edit, a shell write of the skill file (stays `ask`), a reviewer, a reader and a plan awaiting its Go. An ordinary ticket has no `skillFile`.
4. **Left alone.** `settingSources` (B5.5b waits for a decision). A symlink in the checkout named like the skill file is not seen by the policy, as for every `edit.workdir` row; the ticket's review and the lock read the diff.
5. **Lines.** P200 (C2), P201 (O12); C2 and O12 are `done`.

**Tests first.** `914d388` was committed before any code. On the old code: the briefing test and the effects test failed (no decisions heading), `test/session/skill-policy.test.ts` ("writes its skill file without asking") and `test/flow/skill-policy.test.ts` failed (`ask`, rule `default`, not `allow`, `edit.skill`). The tests of the limits (nothing else under `.claude/`) pass on the old code too, as they guard what the change must not open.

**Checks.** See the pull request. `npm run guard -- --base origin/v2` is run before the READY.

**Resources.** No Docker object, no network beyond `npm ci` of the lock file, no tunnel, no secret.

- Author: Sonnet 5.5 (claude-sonnet-5-5), lane `j2-knowledge`.

## 2026-10-25: the cost of a resolved ticket, from the ledger, on the ticket card (the author's choices, lane `j3-ticket-cost`, P211)

**The need.** Issue #327, the owner's decision of 01:09 (P211): the cost of each resolved ticket, aggregated from the ledger, shown on the ticket card and in the pull request; dollars or euros only from a real source, else tokens and a readable time. The proof receipt of the pull request is lane `j3-proof-receipt`'s (P210, pull request 338): this lane gives it a function to call and edits none of its files.

**Decision.**
1. **Which sessions.** Every session the ledger holds for the ticket (`session_events.ticket`), whatever its role and its run: the authors (a put-back run, a variant, a handover to Codex included) and the reviewers. The lead's turns are stored under its own ticket (`lead/contract.ts` `LEAD_TICKET`), and a turn of the lead serves several tickets at once (`lead_messages` names a plan, not a ticket): the ledger gives no share of them to a ticket, so none is counted, and none is estimated.
2. **Tokens.** The four counts of each finished turn (input, output, cache read, cache write), as the Consumption screen and the receipt count them: `consumption/usage.ts` now exports `turnTokens`, the same one-word change pull request 338 makes. null when no turn finished.
3. **Time.** Two figures, both from the stored events: the agents' own time, each turn from its `RUN_STARTED` to its `RUN_FINISHED` or `RUN_ERROR` (a turn still running counts nothing yet); and the ticket's, from its first stored event to its last. Both are said with the app's `lasted` ("42 s", "37 min", "1 h 04", "2 j 2 h").
4. **Dollars.** The real source is the harness's own `total_cost_usd`, the figure the Consumption screen shows as API-equivalent, which a subscription does not bill. Claude Code reports the session's running total (lane 25's log), so a session's dollars are its last total, not the sum of its turns, which `flow/engine.ts` `#stepCost` and `#spent` still do. A turn with no total (a cancelled turn, `claude-code/map.ts`) is skipped, never read as zero. A total lower than the one before is a new process of the session (a resume after the container was recreated), and its totals add to what was spent. The receipt's `ticketUsage` takes each session's last total, which gives the same figure when no session resumed. The dollars are null when one session that finished a turn reported no total (Codex, Cursor): a partial sum is not the cost. Never euros: no source gives a rate.
5. **Where it lives.** `src/consumption/ticket-cost.ts`: `sessionsCost(sessions)` takes each session's events, the input shape of the receipt's `ticketUsage`; `ticketCost(db, { project, ticket })` finds the ticket's sessions through the `sessions` table (indexed by ticket), reads their events by `session_events`' key, and adds the ticket's time. `GET /api/tickets/:id/cost`, registered by the lead module with the Consumption routes (the same guard: the app's proof, then the flow running), so the flow module and `flow/engine.ts`, which pull request 338 edits, are untouched.
6. **The ticket card.** The session screen's ticket card of a Done ticket reads the route once (a Done ticket's sessions spend nothing more) and says three facts, a line each, so no fact is cut and no line ends on a separator in the narrow left column (lane 38's rule): "Cost: 232,900 tokens", "32 min of agent work over 38 min", "$1.03 API-equivalent, as the agents reported it" ("Coût : 232 900 jetons", "32 min de travail des agents sur 38 min", "1,03 $US en équivalent API, déclarés par les agents"). The dollars fact is absent when the figure is null, and the facts are absent before the cost is read or when no turn finished. Only a Done ticket: one still running has no final figure. The captures, at 1440, 1280, 768 and 390 pixels, light and dark, English and French, are in `docs/v2/ticket-cost/`; none scrolls sideways.
7. **The pull request.** The receipt of pull request 338 already says the tokens, the time and the dollars, with its own `ticketUsage` over the current run's sessions (`#flowRows`). Once both pull requests are merged, the receipt reads `sessionsCost(events)` in place of `ticketUsage(events)`, or `ticketCost(this.#store.db, { project, ticket })` for every run of the ticket; that change is in `flow/engine.ts` and `flow/receipt.ts`, which this lane leaves to lane `j3-proof-receipt`. Until then the card and the receipt can differ for a ticket that ran more than once, and P211 stays `partial`.
8. **Fixtures.** `app/fixtures/cost.ts`: the tower's landed ticket LOCAL-149 with an author's turn and a reviewer's, in a ledger of their own, with invented figures. The fixture source adds it only when asked (`fixtureSource({ resolved: true })`), so the session index, the tower and the counts other tests pin stay as they are. The fixture source answers the cost route with the service's own `ticketCost`.

**Tests first.** `ea6e8a4` was committed before any code: `test/consumption/ticket-cost.test.ts` (the running total, a null between two totals, a resume, a session with no total, the ledger's sessions of a ticket, the route), `app/web/test/session/ticket-cost.test.tsx` (the card in English and French, without dollars, with seconds and days, nothing on a ticket not Done) and `app/test/session/ticket-cost-browser.test.ts` (the card in Chromium on the fixtures, French on a 390-pixel phone). On the old code the first and the third failed to load their module, and five of the six Vitest tests failed (no line). The code followed. Two pinned figures of `test/api/types.test.ts` changed with the new route (the list and the count, 63 to 64). After the first commit of code, the card's one line became three facts (lane 38's rule, seen in the captures), so the Vitest and browser tests now compare the facts; the browser test's capture takes the ticket card, since on a phone the left column is `display: contents`, and checks that each fact starts its own line and that the line is visible. The browser test is in the CI's `browser` job list (`.github/workflows/v2.yml`), so it runs there.

**Checks.** See the pull request. `npm run guard -- --base origin/v2` is run before the READY.

**Resources.** No Docker object, no port opened outside the tests (port 0 on loopback), no tunnel, no secret, no real account; the browser tests run the fixtures source in Chromium.

- Pull request: 339, against `v2`.
- Author: Opus 5.5 (claude-opus-5-5), lane `j3-ticket-cost`.

## 2026-10-25: A ticket launched from a chat command, signed, tested with a fake client (the author's choices, lane `j3-chat-launch`, P212, issue #328)

**The need.** P212, one of the ten ideas of the owner's decision of 01:09: a Slack-style command `@cleared <task>` creates a ticket, answers with the ticket's link, then with the pull request's. The issue asks for a signed inbound route (a shared secret checked, a replay refused), the ticket in the right project, FR/EN, and a fake chat client instead of any real Slack setup. The brief pointed at sections 9 and 10 of `milestone-2-plan.md`, which has eight; the conventions followed are those of section 10 of `milestone-1-plan.md` (a lane fills its own module, never `main.ts`), which the registry's header names.

**Decision.**
1. **One route, outside the app's API.** `POST /hooks/chat` (`src/flow/chat.ts`), registered by the flow module, beside the batches. The app never calls it, so it is not in `api/types.ts`, and the app's proxy (`/api/service/*`) does not reach it. It does not take the app's proof: its own signature is its check. The service still listens on loopback only (B3.2); how a chat platform reaches it is the owner's setup, and no tunnel was opened.
2. **Slack's own signature,** so a real workspace could be pointed at it later without a change: `x-slack-signature` is `v0=` and the hex HMAC-SHA256 of `v0:<timestamp>:<raw body>`, compared with `timingSafeEqual` over the bytes as received. A timestamp more than five minutes off is refused; a signature seen before is refused with `409` (`chat_seen`, kept ten minutes, which covers the window). The secret is read from the file `CLEARED_V2_CHAT_SECRET_FILE` names, never from a variable; no file named, the route answers `404`. A file that cannot be read, a secret under 16 characters, a bad user list or a bad origin is said at start (never the value) and leaves the route off, rather than stopping the service.
3. **One wire format: the slash command,** form-encoded (`text`, `user_id`, `response_url`). The task is the text after a leading `@cleared` or the chat's `<@U...>` mention, with the chat's `&amp;`, `&lt;`, `&gt;` undone; the title is its first line, cut at a word under 200 characters, and the whole task is the body when they differ. The Events API's mentions (a JSON body with a URL challenge) are not taken: one format is enough to prove the path.
4. **Who launches.** A ticket needs a user of the service. `CLEARED_V2_CHAT_USERS=<chat user id>=<user id>,...` links chat accounts; an account not linked, or linked to a user the service does not know, is told so (`ephemeral`) and creates nothing.
5. **A batch of one.** The bar's New ticket starts at once, outside the lanes and the week stop. A command typed in a chat is easier to repeat than a click, so the ticket goes through `BatchRunner` instead: it starts within the Consumption screen's lanes and the stop (B3.11), and the answer says when it waits ("It waits for a free lane (1 in use, 1 allowed)."). `BatchRunner.create` and `validateBatch` take a `min` for that one caller; `POST /api/batches` still refuses fewer than two. The ticket is labelled `chat` and `batch:<id>`, so the Tower's batch card shows it too.
6. **The links.** The web app has no page per ticket: a ticket is shown in its author session's view. So the answer at once names the ticket and its title with the Tower's address; then, posted to the command's `response_url`, the author session's address at `ticket_started` and the pull request's at `release_requested` ("It waits for an approval in the Inbox."), each once per session and per pull request (`chat_replies`). The launches are in `chat_launches`, so a launcher built after a restart still sends what follows; an event missed while the service was down is not sent again. The addresses are the app's: `CLEARED_V2_APP_ORIGIN`, else `http://127.0.0.1:8792`, as `app/src/config.ts` reads them. A new `/tickets/:id` page was not added: it is a screen's work, with its own catalog and browser tests.
7. **Where replies go.** A `response_url` from a signed body is still an address to which the service would post: it is used only when its origin is one of `CLEARED_V2_CHAT_REPLY_ORIGINS` (`https://hooks.slack.com` by default), without user or password, checked at the command (else `400`, before any ticket) and again before each post. The poster follows no redirect and gives up after ten seconds; a failed reply is logged by its error's name only and is not retried. A real Slack `response_url` lasts 30 minutes; a pull request can take longer, so a real workspace would need the bot's own post, which is out of scope here.
8. **Words.** `src/flow/messages/chat.en.json` and `.fr.json`, over the shell's catalog for the locale, in the app's language (`CLEARED_V2_APP_LANGUAGE`), as the ledger's MCP server does. Numbers go through the translator (a pull request's number as a string, P191). No duration and no amount is said.
9. **Not done.** No reply when a ticket is put back or fails to start; no per-channel project (the service runs one project, and the ticket is created in it).

**Tests first.** The tests were committed alone in `00db860`. There, `test/flow/chat.test.ts` and `test/flow/chat-catalog.test.ts` do not load (`src/flow/chat.ts` does not exist), and `test/flow/modules.test.ts` fails on the same import (past it, it asks for `POST /hooks/chat` among the flow module's routes, the chat's tables, and 37 routes instead of 36). The fake chat client (`test/flow/chat-client.ts`) signs with `node:crypto` on its own, so the service's signature is checked against an independent one. Nothing else of the earlier tests changed.

**Checks.** `npm run typecheck` passes. `npm test` (the build, `node --test` and Vitest): 1910 Node tests, 1864 pass, 46 skipped because `CLEARED_V2_PLAYWRIGHT` is not set, 0 fail; 295 Vitest tests pass. No browser test was run: nothing of the app changed. After merging `origin/v2` at `2d3ff4e` (pull request 339, P211; the matrix keeps its P211 line and this lane's P212, every id once): `npm run typecheck` passes, `npm test` runs 1923 Node tests, 1875 pass, 48 skipped, 0 fail, and 301 Vitest tests pass. `npm run guard -- --base origin/v2`: nothing refused.

**Resources.** No Docker object, no chat, Cursor or Codex account, no network beyond `npm ci` of the lock file, no tunnel, no secret: the tests' signing values are fake, the service and the fake client listen on port 0 on loopback.

- Author: Opus 5.5 (claude-opus-5-5), lane `j3-chat-launch`.

## 2026-10-25: a proof receipt at the top of every pull request Cleared opens (the author's choices, lane `j3-proof-receipt`, issue #326, P210)

**The need.** The owner's decision of 01:09 (the ten ideas, P210): each pull request Cleared opens starts with a proof receipt holding a capture before and after, a video of about 20 seconds of the flow recorded by Playwright, the tests run with their result, and the cost (tokens and time; dollars or euros only from a real source).

**Decision.**
1. **The block is built from structured fields only** (`flow/receipt.ts`): the captures' file names and the codes of what was not taken, each review round's run of the declared test command as the flow journaled it (`cleared.review_verdict`, issue #268), and the ticket's tokens, dollars and time as its card says them (item 2). No report, no command output (the run's `tail` is left out), no error's text, no path. A command's backtick cannot end its code span.
2. **The cost is the ticket card's** (P211, pull request 339): `ticketCost(db, { project, ticket })` of `consumption/ticket-cost.ts`, over every session of every run of the ticket, the time from its first stored event to its last (the review's end, just before the publish). Its rules are the ones this lane first wrote in its own `ticketUsage`, now removed. `total_cost_usd` is a session's running total (the log of lane 25), so a session's dollars are its last total. A total lower than the one before, a resumed process, adds to it, which `ticketUsage` did not do. A session that finished a turn and never reported a total (Codex, Cursor) leaves the dollars out: a partial sum is not the cost. It does not reuse the engine's `#stepCost`, which sums every turn. The figure is in US dollars as the harness reports it, said "API-equivalent", as the Consumption screen frames it. No euros: no source gives them. The tokens are each turn's four counts (`turnTokens`). Without a turn, the receipt says the harness reported no tokens, never 0. The card and the receipt cannot differ, and P211 is `done`.
3. **In the project's language.** The receipt has its own catalog (`flow/messages/receipt.{en,fr}.json`) over the shell's for the units of a duration (`lasted`) and grouped numbers (`quantity`), as the ledger's MCP server does. `publish` reads `[owner] language` from the project's committed `.cleared/agents.conf` at the base (B3.6: a team's content stays in the project's language); `fr...` is French, anything else English.
4. **First in the body, and on a reused pull request too.** `publish` renders the receipt, puts it through the guard on its own, and puts it first, between `<!-- cleared:proof-receipt -->` markers. When the guard refuses the report, the body falls back to the commits and keeps the receipt. When an open pull request is reused (a later review round), `gh pr view --json body` then `gh pr edit --body-file` puts the new receipt in place of the old one and keeps the rest. A failed edit is logged by its error's name and never fails the publish, because the branch is already pushed.
5. **The captures are taken when the author is done, before its session closes**, so its trial environment still runs: in `#authorDone`, and in `#stepDone` for every step but a contract step. They are journaled on the author's session (`cleared.proof_captured`, a new custom name), and the receipt keeps the last capture of each service. Before is the page at the origin of the service's `health_url`, which runs its base (`127.0.0.1:8793/` for the guestbook). After is the author's run sibling through the service's own preview route on loopback, with the app's proof, as the preview listener sends it. The video records the after page: it scrolls down for the first half of 20 s, then back up. The time is measured, not assumed. A capture that throws, or a part that fails, is said by a code (`no_browser`, `no_before`, `no_after`, `failed`), never by the browser's text, which can hold an address or a token. A capture still running after 90 seconds (`proofTimeoutMs`) is journaled as failed, and the ticket goes on without it. A ticket of variants takes no capture: `#variantDone` does not call it, and that is a gap against "every pull request".
6. **The pages reach their own address only.** The after page is code the session wrote, run by a Chromium on the host, outside the session's container. Playwright's `extraHTTPHeaders` would send the app's proof on every request of that page, to any host. So each context has a route for every URL: a request under the page's own address goes on, and only the preview's own requests get the app's proof added. Every other request is aborted, every WebSocket is closed, and service workers are blocked. The page gets no network the session's container does not have (B5.3a), and the proof never leaves (B3.3). The real Chromium test puts an image, a fetch and a WebSocket to a third loopback server in the after page, and that server receives nothing.
7. **Playwright is loaded when a capture runs, never at start.** The service has no runtime dependency (`v2/README.md`), so `playwright-core` comes from `CLEARED_V2_PLAYWRIGHT` when it names one, else from v2's development dependencies, and Chromium from `CLEARED_V2_CHROME` or Playwright's own. Without them, the receipt says there was no browser. The browser starts only when there is a page to open.
8. **The captures are linked through the app, never attached to the forge.** gh cannot upload a file to a pull request. Committing the captures to the ticket branch would put them in the diff, and another branch is out of bounds. The files stay under `<workdirs>/.proof/<ticket>/<service>/` and are served by `GET /api/tickets/:id/proof/:service/:file` (`flow/proof-routes.ts`): the app's proof first, one of the three names only, a service of the workspace, a ticket the store knows, a plain file. The receipt links them at `CLEARED_NOTIFY_LINK_BASE` + `/api/service/...`, the app's address the notifications already use, so only a person signed in to the app opens them. With no link address, the receipt says they are kept by Cleared. Every pull request body then holds the app's address, a tailnet name when it is one, on the example repositories too: that is a choice, since the link is useless without it.
9. **Out of scope:** the ticket card's cost (P211, issue #327), and the engine's `#stepCost`, which still sums running totals (a followup the log of lane 25 names).

**What is proven, and what is not.** The renderer, the cost rule, the publish's body (a fake gh), the engine's capture and receipt (a fake capture effect), the route, and the recorder (a fake browser) are tested. The recorder also ran in a real Chromium, twice. The first run is the test gated by `CLEARED_V2_PLAYWRIGHT`, on two loopback pages on port 0: two PNG files and a WebM file. The second ran by hand on the example guestbook: its `createApp` on two memory stores, on free loopback ports, the base listing oldest first and the ticket's newest first. It recorded a video of 20.4 s, and the whole capture took 21.8 s. Not run: a capture through a real ticket's trial environment, which needs Docker and a session; P210 stays `partial` until a proof run does it.

**Tests first.** `d8163b6` committed the tests alone. On that code, none of them can run: the receipt, the recorder and the route modules do not exist. `publish` has no `receipt`, so the body does not start with one and a reused pull request is never edited. The engine takes no capture and hands publish no receipt. Four earlier tests were amended because they pin the list of routes or of custom names: `test/api/types.test.ts` (the new route, 64 routes), `test/flow/api.test.ts` (the flow's declared routes include `proofRoutes`), `test/flow/modules.test.ts` (the flow module's routes, 37) and `test/session/events.test.ts` (`cleared.proof_captured`). `test/flow/config.test.ts` gained the link address. Three later edits fixed mistakes in the tests themselves, not in the code. First, the wording of unreported tokens. Second, the reviewer-cost scenario: a resumed reviewer is one session, whose earlier total stands. Third, a `/token/` pattern that matched the receipt's own `tokens` field.

**The guard's false positives.** The guard of the lines changed read three things as secrets: a catalog key ending in `_tokens` with a sentence for its value, keys ending in `_passed`, and a literal `passed: '…'`. The keys are now `receipt_cost`, `receipt_cost_unreported` and `receipt_run_*`, picked by a `switch`, and the two test addresses with credentials are built from parts.

**The merge of 339.** The matrix keeps every line: P210 as this lane has it, and P211 as pull request 339 wrote it. P211's delivery now also names 338, its proof names `test/flow/proof-receipt.test.ts` (the receipt's figures equal `ticketCost`'s), and its status is `done`. The receipt's cost rule tests went with `ticketUsage`, since `test/consumption/ticket-cost.test.ts` covers that rule. Both lanes moved `test/api/types.test.ts` from 63 to 64 routes, and git kept 64; there are 65.

**The merge of 340.** The matrix keeps P210, P211 and P212, each once. Both lanes put their catalogs in `src/flow/messages/`, and the chat's test listed that folder as its two files only: it now lists the files named `chat.`, and the receipt's are beside them. Its French typography rule is the app's, a no-break space before `:`, which the receipt's French catalog did not keep (`Tests :`). It keeps it now, and `test/flow/receipt.test.ts` checks it as the chat's test does. The flow module's routes are 38, the receipt's and the chat's command both counted, where each side had written 37.

**Checks** (after the merge of `origin/v2` at `e107af7`, pull request 340). `npm run typecheck` passes. `npm test` passes: 1949 Node tests, 1900 pass, 49 skipped (the browser tests, with no `CLEARED_V2_PLAYWRIGHT`), 0 fail; Vitest, 301 tests pass. With `CLEARED_V2_PLAYWRIGHT`, `test/flow/proof-capture.test.ts` passes 6 of 6, the confinement included. `npm run guard -- --base origin/v2`: nothing refused. The v1 suite as the `checks` workflow runs it (`test/*.test.mjs`): 630 tests, 628 pass, 2 skipped, 0 fail.

**Resources.** No Docker object, no tunnel, no secret, no real account, no real GitHub call (a fake gh). The tests and the hand run listen on port 0 on loopback.

**Review 1, and a red `verify`.** The review asked for the merge of `origin/v2` (pull request 337: P200 and P201 kept before P210) and a green `verify`. That job failed in a v1 test the lane does not touch, `test/routing.test.mjs` (the Codex adapter and the door of the heavy commands). The cause is in the test's fake `gh`: it answered `0` to every call, the base's last commit date included, and `date -d 0` is today at midnight. So `host-state.sh` read a merge minutes old, and the host was "deploying" from 00:00 to 00:10. The run was at 00:09 UTC. The fakes of that test and of `test/guard.test.mjs` now answer an old date to `gh api`. The old fake fails with `TZ` set so that the local time is 00:04, and the new one passes then and at any other hour. Two of the review's followups are done: a proof file that disappears between its check and its read ends that answer only, and a receipt the guard refuses is logged. Three are left as they are. First, a page of the after environment that names its files from the root (`/app.js`) or redirects to `/` is outside the preview's prefix, so those requests are aborted and its capture may be empty: safe, and to be seen in the real proof run. Second, a capture given up at the cap still runs in the background until its own timeouts end (15 s per page, 20 s of flow). Third, "the last capture per service" follows the order of the sessions, which is right while a service has one author. The app sets `nosniff` on every answer it serves (`app/src/server.ts`), the captures included.

- Pull request: 338, against `v2`.
- Author: Opus 5.5 (claude-opus-5-5), lane `j3-proof-receipt`.

## 2026-10-25: Ready-made tickets, Bug, Review, CI and Question, picked in the tower's bar (the author's choices, lane `j3-ticket-templates`, P214, issue #330)

**The need.** P214, one of the ten ideas of the owner's decision of 01:09: four templates that create a ticket in one click, with prefilled fields, in French and in English, picked in the tower's bar; tested in the service and in a browser. The brief pointed at sections 9 and 10 of `milestone-2-plan.md`, which has eight; the conventions followed are those of section 10 of `milestone-1-plan.md` (a lane edits its own files, a screen's words in its catalogs, `api/types.ts` untouched), as lane `j3-chat-launch` did.

**Decision.**
1. **The kind is a label.** `src/tickets/templates.ts` holds the four ids (`bug`, `review`, `ci`, `question`) and the label a template's ticket carries, `type:<id>`, so a ticket's kind can be counted from the tracker's labels (P213's win per ticket type can read it). `POST /api/tickets` refuses a `type:` label that is not one of the four, or two of them, before the ticket exists; the other labels are not read. `CreateTicketBody` already had `labels`, so the API's contract does not change. The batches and the chat command do not take a template.
2. **The words are the app's.** Each template's name, its title placeholder and its description are keys of `tower.en.json` and `tower.fr.json`. The description is Markdown sections with no colon ("## Steps to reproduce", "## Étapes pour reproduire"), so the French typography rule holds without a no-break space. Bug: what happens, the steps, what should happen, and a test that fails before the fix. Review: what to review, what to look for, each finding with its file, line and severity, and the ones within reach fixed on the branch, each with a test. CI: the check and its run, the log lines, the check passing with no test skipped or removed. Question: the question, where to look (`service:path:line`), and the answer written where the next reader will look for it (the README, a doc, a comment beside the code), citing the code. A first wording told Review and Question to change no code; but a branch with no commit of its own is not published (`workspace/publish.ts`, refusal `empty`) and the ticket is put back (`publish_refused`), so two of the four templates would have steered their tickets there. Each template now ends in a commit. "Bug" and "Question" are the same words in French, listed with the shared words of the i18n audit.
3. **What is prefilled.** The description, and the title's placeholder ("What breaks, in a few words"). The title itself is not prefilled: a prefix such as "Bug: " would leave the title never empty, which the bar reads to show the description, the services and the authors, to reset them, and to refuse a ticket with no title. The label says the kind instead.
4. **A pick never loses words.** A template's sections go into a description that is empty, or still as another template left it; a description the person wrote is kept, and the note says so ("Your description is kept: a template only fills an empty one."). The same template again unpicks it, and takes its untouched sections with it. `pickTemplate` in `app/web/screens/tower/templates.ts` is the rule, a pure function. New ticket sends the label, then empties the bar and closes the row.
5. **In the bar.** A "Template" chip ("Modèle") before Batch shows a row of four toggles under the field, labelled like the authors' row and kept while one is picked; the chip then hides the row and unpicks. The row is in both shapes of the bar, with the services of a workspace of several or the authors of a workspace of one. Only the first pick takes the focus to the title, so the keys can go from one template to the next. A chip whose row or form is open (Template, and Run a recipe and Batch with it) is drawn in the hover's fill.
6. **The bar's rows.** The new chip made the actions wrap sooner: at 900 pixels (French) and already at 768 before this lane, New ticket ended alone on a line, and on a phone a third chip left the field a few letters ("Un obje…"). From the tower's 980-pixel step, the field and New ticket now keep the first row, the other actions take the lines under it, and what the bar opens comes after (`display: contents` on the actions, `order`, and an empty full-width item that ends the first row). On a phone this keeps lane 38's rule (the field and New ticket on one row); the bar is one line more there. Measured with and without the chip at 1440, 1280, 1024, 900, 768 and 600 pixels: New ticket is on the field's row at each. Under 980 pixels, Tab still reaches New ticket after the other actions, as a form's submit; moving it in the markup would break the order at the main widths. The captures, at 1440, 1280, 768 and 390 pixels, light and dark, English and French, and one of the French placeholder on a phone, are in `docs/v2/ticket-templates/`; none scrolls sideways.
7. **Question creates a ticket,** as the issue asks: an author session that writes its answer down. "Ask about the code" stays the read-only path, and P215 (answers citing code with line links) is its own line.
8. **Fixtures.** The fixture source keeps a new ticket's labels, checked as the service checks them, so the browser test reads the label back.

**Tests first.** `b04dd90` was committed before any code: `test/tickets/templates.test.ts` (the ids, the label, the refusals, the route keeping the label), `app/web/test/tower-templates.test.tsx` (the chip and the row in both languages and both bar shapes, the placeholder, the sections, the pick rule, the label sent) and `app/test/tower-templates-browser.test.ts` (French and English at 1440 pixels, French at 390). On that code the first two fail to load their module (`src/tickets/templates.ts`, `templates.ts` of the tower) and the three browser tests time out (no Template chip). Changed after that commit: the browser test compared the sent `project` with `guestbook`, but the bar sends the header's project name (`Guestbook`), which this lane does not touch, so it compares the title, the description and the labels; the Vitest test's em dash check is written with a character code, as `app/test/static.test.ts` asks; its check of the Question wording follows item 2 (an answer written down, no "no change to the code").

**Art-director pass** (Impeccable's critique, the design review in a separate agent, its detector on `Tower.tsx`: nothing found; its browser overlay not run, as it would open a listening server). Taken: the open chip's fill, the row's label, no hairline between the row and the description it fills, the focus on the first pick only, a capture of the placeholder. Not taken: the focus order under 980 pixels (item 6). Seen and left: on a 390-pixel phone the French placeholder "Ce qui casse, en quelques mots" is cut at the field's edge. The browser test is in the CI's `browser` job list (`.github/workflows/v2.yml`).

**Checks.** `npm run typecheck` passes. `npm test` (the build, `node --test` and Vitest): 1929 Node tests, 1878 pass, 51 skipped because `CLEARED_V2_PLAYWRIGHT` is not set, 0 fail; 306 Vitest tests pass. The browser job's thirteen files, this lane's and `tower-batch-browser.test.ts`, with `CLEARED_V2_PLAYWRIGHT` and `CLEARED_V2_CHROME` as the CI sets them: 38 tests, 37 pass in one run; the one that failed is the screen-switch budget of `foundation/budget-browser.test.ts` (a p95 of 123 ms over its 100 ms while fifteen browser files ran at once), which passed twice when run alone. Run again once the art-director pass was taken in: `tower-templates-browser.test.ts`, `tower-batch-browser.test.ts` and `shell/shell-browser.test.ts` (10 of 10 pass), and Vitest's 306. After merging `origin/v2` at `c6a1bf6` (pull request 338, P210; the log keeps its entry before this one, the matrix each id once): `npm run typecheck` passes, `npm test` runs 1955 Node tests, 1903 pass, 52 skipped, 0 fail, and 306 Vitest tests pass; `tower-templates-browser.test.ts` and `tower-batch-browser.test.ts`, 5 of 5 pass. `npm run guard -- --base origin/v2`: nothing refused.

**Resources.** No Docker object, no chat, Cursor or Codex account, no network beyond `npm ci` of the lock file, no tunnel, no secret; the tests and the captures listen on port 0 on loopback.

- Pull request: 342, against `v2`.
- Author: Opus 5.5 (claude-opus-5-5), lane `j3-ticket-templates`.

## 2026-10-25: the harness pick, a variant per harness and the cheapest green one kept (the author's choices, lane `j3-harness-pick`, P213)

**The need.** Issue #329, the owner's decision of 01:09 (P213): run variants across Claude Code, Codex and Cursor, keep the cheapest green pull request with the ticket cost of P211, stop the other variants and release their containers, and count the wins per ticket type on the Consumption screen. The limit of 3 lanes and the quota stop hold. Fakes only in the tests; the real Codex and Cursor wait for the owner's trials.

**Decision.**
1. **Green means the variant's own tests, read from the ledger.** A variant is green when it committed a change against the base and the service's declared test command (`[session] test_command`, else `npm test`) ran alone in its own session and exited 0. It is read from the session's events as the reviewer's run is (`review-tests.ts` `testRunOf`), never from what the author says. The author of a pick is told the rule and the command.
   - Not chosen: a pull request per variant and its checks on the forge. Every variant's clone carries the one ticket branch, `cleared/<ticket>` (P75, item 2), so publishing them all would push the same branch several times and open as many pull requests, all outward-facing. Only the variant kept is published, so the pull request is the kept variant's, after its review.
   - Not chosen: tests passing with nothing committed. A variant that changes nothing would win by spending least; it is not green (found in this lane's own reading of the diff, then tested).
   - No test command declared, or no variant green: nothing is kept by itself. The ticket's thread says why, and the owner chooses in the inbox as for plain variants.
2. **Cheapest is tokens, else time; never dollars.** The figures are P211's `sessionsCost` over the variant's session: the fewest tokens when every green variant reports tokens, else the shortest agent time (Cursor reports no tokens, `docs/adapters.md`), then the other measure, then the position. Dollars are left out: Codex and Cursor report none, and a figure for one harness only ranks nothing.
3. **The pick waits for every variant to end.** Once none is waiting or running, the flow keeps the winner through the owner's own choice path (`FlowEngine.#keep`, taken out of `chooseVariant`): the others are dropped, their containers and networks labelled `cleared.dev=v2` are released at once by session, the inbox item is handled by the service with the measure, and the review and the publish run on the kept checkout. The owner may still choose before the end; the pick then keeps nothing and counts no win.
   - Not chosen: stopping a running variant early once it has spent more than a green one. It saves quota, but it compares a running turn with a finished one; left for when real runs show it matters.
4. **One harness per variant, behind the owner's gate.** `POST /api/tickets` takes `harnesses`, 2 to 4 names (a name may repeat). `CLEARED_V2_PICK_HARNESSES` lists the harnesses allowed, `claude-code` alone by default, `codex` on `gpt-6-luna` unless `codex=<model>`, `cursor=<model>` (the Cursor adapter has no default model and none is guessed). A harness not listed, or with no adapter, is refused with a 400 before the ticket exists. The variable stays unset until the owner's trials (`docs/adapters.md`, the note under Cursor's reachability). A Codex or Cursor author gets no host tools, as in a handover.
5. **The reviewer is another harness.** The variants not kept leave the ticket's flow, so their harnesses count for nothing. A kept Codex or Cursor variant is reviewed by Claude Code. Before this lane a last author on Cursor would have been reviewed by Codex. A kept Claude Code variant keeps Claude Code's reviewer on its other model, as a ticket that never changed harness.
6. **The limits.** The lanes are P75's: the Consumption screen's lanes, 3 when it sets none. The quota stop is the plans' (`CLEARED_V2_WEEK_STOP_PERCENT`, 85 % by default), read per harness: a variant whose harness has a window at or above it does not start and fails with the reason, and the others go on. Every variant stopped so puts the ticket back (`variants_failed`). Not chosen: waiting for the window to fall, which would hold the pick until a reset days away. Plain variants (P75) are left as they were.
7. **The ticket type.** A ticket made from a template (P214, pull request 342) carries `type:<id>`, and that label is its type. Without one, the type is the ticket's first label among Bug, Review, CI and Question, whatever the case, else other. It is written on the variants when the run starts, since the Consumption screen reads the ledger, not the ticket store. (Written before 342 merged with the labels alone; the `type:` label was read once this branch merged it.)
8. **The wins.** `GET /api/consumption` gains `wins`: per type and harness, the variants that ran (a session started) in picks that ended, those green, and those the pick kept (`flow/harness-pick.ts` `harnessWins`, from `ticket_variants`). The Consumption screen shows them under the agents' cards, in the types' order and within a type the agent kept most often first. No pick ended: one sentence says so. The inbox's columns of a pick name the agent, its own run of the tests and its tokens; the item says what the pick kept and by which measure. Every text is in the consumption and inbox catalogs, in English and in French. The captures, at 1440, 1280, 768 and 390 pixels, light and dark, English and French, are in `docs/v2/harness-pick/`; none scrolls sideways. The inbox's pick columns are covered by Vitest only, with no capture: the fixtures' inbox keeps its plain variants, which other browser tests pin.
9. **Storage.** Migration 3 adds `harness`, `pick`, `kind`, `tests`, `tokens`, `work_ms` and `won` to `ticket_variants`; a row written before it reads as a plain Claude Code variant. The migration tests now take the planted failure after the last real migration rather than at version 3.

**Tests first.** `57f5d50` was committed before any code: `test/flow/harness-pick.test.ts`, the `harnesses` cases of `test/flow/api.test.ts`, `app/web/test/consumption-wins.test.tsx` and `app/web/test/inbox/harness-pick.test.tsx`. On the old code the first and the two Vitest files failed to load their modules, and the route answered 200 to `harnesses: "codex"`. Changed afterwards: the French strings of the two Vitest files follow the catalogs' straight apostrophe and no-break space before a colon; the empty line became one sentence (the copy rule of `app/test/polish/copy.test.ts`); the test of a variant that commits nothing was added with the rule. `app/test/consumption/wins-browser.test.ts` came with the panel and is in the CI's `browser` job list.

**Checks.** See the pull request. `npm run guard -- --base origin/v2` is run before the READY.

**Resources.** No Docker object, no port opened outside the tests (port 0 on loopback), no tunnel, no secret, no real account: the Codex and Cursor of the tests are the scripted fake adapter under their names, and their containers are a fake docker CLI's.

- Pull request: 341, against `v2`.
- Author: Opus 5.5 (claude-opus-5-5), lane `j3-harness-pick`.

## 2026-10-25: code Q&A answers cite code with GitHub links to the commit and the lines, built by the service (the author's choices, lane `j3-code-qa-links`, P215, issue #331)

**The need.** P215, one of the ten ideas of the owner's decision of 01:09: each citation of code in a reader's answer (C11) has a GitHub link to the exact commit and lines, built and checked against the repository by the service, never written by the model. The brief pointed at sections 9 and 10 of `milestone-2-plan.md`, which has eight, as lane `j3-chat-launch` noted; the conventions followed are those of section 10 of `milestone-1-plan.md` (a lane changes its own module).

**Decision.**
1. **What a citation is.** The reader's briefing already asked it to name what it relies on as `service/path:line`. It now also names `service/path:from-to`, and says Cleared links each one and that the reader writes no link itself. `src/reader/citations.ts` reads these mentions in the answer's text: a service of the ask, a path inside it (`servicePath`, as a target's), lines from 1. A leading `/workspace/` (the mount) and an en dash are taken. A mention written twice counts once, and an answer keeps at most 40. A bare `path:line` without its service is read only in an ask of one service, and kept only when the commit holds it, since `localhost:8080` has the same form.
2. **Which commit.** The commit the reader's folder was exported at: `exportBase` returned it already, and the reader's `prepare` now hands it back for each service. It is kept on the live session, not on the ask. A follow-up after the idle stop exports again, perhaps a newer base, and its turn links that commit while the earlier turns keep theirs. The base is never read again when a turn ends.
3. **Checked against git.** `linesAt(service, commit, path)` reads the file from git's objects in the service's own checkout, with the checks `fileAt` already made: the reader policy's Read verdict (a secret's name is refused), a plain blob only (a committed link is not followed), 1 MiB at most, text only. The two now share one reader. A citation holds when that commit has the file and 1 ≤ from ≤ to ≤ its line count.
4. **The link is the service's.** `https://github.com/<repo>/blob/<commit>/<path>#L<from>[-L<to>]`: the repository as the workspace names it (`owner/name`, checked), a commit of 40 or 64 hexadecimal characters, each part of the path encoded, a folder service's folder before its path. An address the reader writes is never taken. GitHub only, because Cleared works through `gh`; a repository name that is not `owner/name` gets no link.
5. **A citation that fails says why.** It keeps no link and a reason: `no_file`, `no_line`, `no_repository`, or `unchecked` for a read that broke otherwise (logged by its error's name). An invented citation shows as such instead of vanishing.
6. **Written with the answer.** The citations are checked before the turn is written `answered`, so the screen's poll never sees an answer without its links. A stop during the check keeps the answer and the state the stop wrote. They are stored in the turn's JSON, so the asks table needs no migration; a turn stored before reads with none.
7. **The screen.** The answer stays text. Each mention the service linked is cut out of it as a link, opened in a new tab (`target="_blank" rel="noopener noreferrer"`), its title naming the commit's first seven characters. Only an `https://github.com/` address sent by the service is drawn. What was cited and not found is a small muted list under the answer, each with its reason and commit. The words are in `app/messages/ask.{en,fr}.json`, the French with a no-break space before a colon. No new amount: a turn's cost stays as lane 25 measures it.
8. **Not done.** No link for a forge other than GitHub. A citation of a service the ask did not read is not linked: the reader did not read it.

**What is proven, and what is not.** The mentions, the link and the reasons (`test/reader/citations.test.ts`), the reader on the fake adapter (the turn written with its citations, never before; the commit of each session; a broken check), the commit and the line count from real git after the base moved on (`test/reader/workdir.test.ts`), the service's repository through the runtime, the screen's model and markup in both languages. A real Chromium (`app/test/ask/citations-browser.test.ts`, in CI's browser job) draws the links, opens the first in a new tab whose `opener` is null, keeps the screen where it was, sends no request but the click's (the test answers github.com itself), and has no horizontal scroll at 390 px in French. Captures at the four widths, light and dark, and in French at 1440 and 390, are in `docs/v2/code-qa-links/`. Not run: a real reader's answer through Claude Code, which needs Docker and a session, so whether the model writes the briefed form is not measured. P215 stays `partial` until a proof run does it.

**Tests first.** `67c73dc` committed the tests alone. On that code, `test/reader/citations.test.ts` does not load (the module does not exist), the reader's tests fail (`prepare` answers a folder only, and a turn has no citations), `workdir.test.ts` finds no commits and no `linesAt`, the runtime test finds no citation, `app/test/ask/model.test.ts` does not load (no `answerParts`), and two of `render.test.tsx`'s new tests find no link. The third, an address the reader wrote stays text, passed on the old code too: it guards what must not change. `test/api/types.test.ts` gained a citation. Three later edits fixed the tests themselves. A mention test asked with one service, where `vendor/guestbook/src/page.ts:3` is a bare path of that service; it asks with two. The browser test, written after that commit, compared the request that left with the link and its `#L12`, which a browser never sends. The i18n audit (`app/web/test/i18n.test.tsx`) now counts the pieces of an answer cut around its links as the answer's data.

**A second look, before the pull request.** Two faults were found in this lane's own code and fixed, tests first (`be4b20b`). The screen found a linked mention anywhere in the answer, so a checked `guestbook/src/page.ts:1` was drawn as a link at the start of an invented `guestbook/src/page.ts:150`; it now takes a mention only where it stands whole, as the service reads it (no path character before, no digit or range after). The bare-path rule counted the workspace's services, so an ask scoped to the guestbook in the two-service example never linked `src/page.ts:14`; it now counts the services the ask read, and a service the ask did not read gets no link even when a commit is known for it.

**Checks** (on `origin/v2` at `c6a1bf6`, which had not moved when this was pushed). `npm run typecheck` passes. `npm test` passes: 1972 Node tests, 1921 pass, 51 skipped (the browser tests, with no `CLEARED_V2_PLAYWRIGHT`), 0 fail; Vitest, 304 tests pass. With `CLEARED_V2_PLAYWRIGHT`, `app/test/ask/citations-browser.test.ts` passes 2 of 2, and 3 of 3 with `CLEARED_V2_SHOTS` (the captures). `test/ci-triggers.test.mjs` passes after the browser job's list gained the file. `npm run guard -- --base origin/v2`: nothing refused.

**The merge of 342** (P214, at `origin/v2` `7d3b75f`). The matrix keeps P214 as pull request 342 wrote it and this lane's P215, every id once. The log keeps 342's entry, then this one. CI's browser job lists both new files, `app/test/tower-templates-browser.test.ts` and `app/test/ask/citations-browser.test.ts`. After the merge: `npm run typecheck` passes; `npm test` runs 1978 Node tests, 1924 pass, 54 skipped (the browser tests), 0 fail, and 309 Vitest tests pass; with `CLEARED_V2_PLAYWRIGHT` the two browser files pass 5 of 5; `npm run guard -- --base origin/v2`: nothing refused.

**The merge of 341** (P213, at `origin/v2` `ec82103`), asked by both reviews of round 1, whose only blocking point it was. The log keeps 342's entry, then 341's, then this one. CI's browser job lists the three new files, `app/test/tower-templates-browser.test.ts`, `app/test/consumption/wins-browser.test.ts` and `app/test/ask/citations-browser.test.ts`. The matrix merged by itself and keeps every id once. The checks of the paragraphs above are those of their base; after this merge: `npm run typecheck` passes; `npm test` runs 1995 Node tests, 1939 pass, 56 skipped (the browser tests), 0 fail, and 316 Vitest tests pass; with `CLEARED_V2_PLAYWRIGHT` the three browser files pass 7 of 7; `test/ci-triggers.test.mjs` passes 4 of 4; `npm run guard -- --base origin/v2`: nothing refused. The reviews' followups (a `:12:5` column, a file ending in a blank line, a version-like bare path, a size check before reading a cited blob) are left as they are; none changes what is linked.

**Resources.** No Docker object, no account, no real GitHub call, no tunnel, no secret. The tests listen on port 0 on loopback; the browser test answers github.com from the test.

- Pull request: 343, against `v2`.
- Author: Opus 5.5 (claude-opus-5-5), lane `j3-code-qa-links`.

## 2026-10-25: the inbox on a 375-pixel phone, Go and Approve in reach above the bar of screens (the author's choices, lane `j3-mobile-ui`, P217, issue #333)

**The need.** Issue #333, the owner's decision of 01:09 (P217): the inbox, the session plan's Go and the release's Approve (the card whose approval the lock turns into the merge) usable on a 375-pixel phone, with browser tests in that viewport, in French and in English.

**What was wrong, measured.** On the fixtures at 375 by 667 pixels, touch, in both languages: the list and the details already fit the width (no sideways scroll, every row and button at least 44 pixels tall). But on a phone the detail's buttons are a sticky bar at `bottom: 0` (z-index 5), and the shell's bar of screens is fixed at the same foot (`.side-nav`, 56 pixels, z-index 20), so it lay over them. The session plan's Go and Change sat at 609 to 653 pixels, the bar of screens at 611 to 667; the point at each button's centre was a link of the bar of screens. The same held for the release's Approve, Send back and Close and for the lead plan's Approve. A tap there opened another screen. In French, Approve the release also wrapped its words over three lines in a 137-pixel button (76 pixels tall), beside Close and Send back.

**Decision.** In `inbox.css` only, its phone blocks:
1. **The buttons sit above the bar of screens.** Under 768 pixels the detail's bar sticks at `calc(var(--bottom-bar) + env(safe-area-inset-bottom))`. The bar of screens already pays the safe area, so the detail's bar no longer adds it (its own `padding-bottom` with the safe area was already overridden by the `padding` rule after it, and is removed). From 768 to 1023 pixels there is no bar of screens, and the sticky bar keeps `bottom: 0`.
2. **Approve the release on a row of its own under 480 pixels,** first, as Allow once is for a permission; Send back and Close share the row under it. Its words stay on one line and the commit under them. Not chosen: a shorter label on a phone, which would need its own key in both catalogs and would no longer say what is approved.
3. **The capture switch (Computer, Phone) is 44 pixels tall on a phone,** as every other target there; it was 38.
4. **Go is the wider of its two buttons on a phone,** as Approve the release and Approve the plan already were (`flex-grow: 1.6`): the rule did not name `plan_go`, so Go and Change were the same width (found by the art-director pass).
5. **The eyebrow keeps the kind on one line under 480 pixels;** the ticket and the link go under it when they no longer fit beside it. In French, "Mise en production à approuver" wrapped into a column of about 117 pixels beside the ticket and the link.
6. **One line above the buttons on a phone, not two:** the bar's `border-top` and a `box-shadow` of the same hairline stacked into 2 pixels; the shadow is removed.
7. **Not changed:** the list, the Go card's content and the release's content, which already fit. The lead plan's Approve is in the same bar and is fixed by item 1 with nothing of its own.

**Read.** `docs/v2/milestone-2-plan.md` has no sections 9 and 10. Read in their place: `milestone-1-plan.md` sections 9 and 10 (waves, conventions) and `ui-overhaul-plan.md` sections 9 and 10. The latter's "a mobile application" out of scope is a native application; this lane changes only the web page's phone layout.

**Tests first.** `f8864e7` was committed before any code: `app/test/inbox/mobile-browser.test.ts`, Chromium at 375 by 667 with touch, in French and in English, on the inbox's fixtures source with a session plan. Each button must be at least 44 pixels tall, on the screen without scrolling, and the point at its centre must be the button (`document.elementFromPoint`). Go must be wider than Change (added with item 4). A tap on Go must send the Go and show its line. A tap on Approve must start the grace, with Undo in reach. Approve's words must be on one line. Scrolled to its end, the detail's last line must stay above its buttons. On that code, six of the eight tests fail, each at the hit test (the point at the centre is in `#nav`). The two list tests pass there; they are kept as a check that nothing regresses, not as the defect's proof. With item 1 alone, the release tests still fail on Approve's three lines. Changed after that commit: the fixtures source keeps the real clock, since the page counts the grace down from the service's `dueAt` with its own clock, and `FIXTURE_NOW` put that time four days in the past.

**Captures.** At 375 by 667 pixels, light and dark, French and English: the list, the session plan and the release, in `docs/v2/mobile-ui/`. None scrolls sideways, and the page logged no error. The 390, 768, 1280 and 1440 widths are covered by the inbox's other browser tests, run again here.

**Art-director pass** (a separate agent on the twelve captures, the phone blocks of `inbox.css` and `app.css`, and `app/DESIGN.md`). It blocked on one finding, Go no wider than Change, which is taken (item 4) and checked by the browser test. Also taken: the French eyebrow (item 5) and the double line (item 6). Not taken, all seen before this lane and outside its scope: a shadow over the content while the detail scrolls under its buttons (DESIGN.md, section 4, never built in this sheet), "Consommation" a few pixels wider than its slot in the bar of screens, the capture switch's track and the list's hairlines nearly invisible in dark, the outline buttons' edges under 3:1, and Approve 2 pixels shorter than Send back and Close beside two lines of text.

**Checks.** `npm run typecheck` passes. `npm test` (the build, `node --test` and Vitest): 1980 Node tests, 1918 pass, 62 skipped because `CLEARED_V2_PLAYWRIGHT` is not set, 0 fail; 313 Vitest tests pass. The CI's `browser` job list, this lane's file added (sixteen files), with `CLEARED_V2_PLAYWRIGHT` and `CLEARED_V2_CHROME` as the CI sets them: 46 tests, 46 pass before the art-director pass. After it, 45 pass in one run; the one that failed is the screen-switch budget of `foundation/budget-browser.test.ts` with sixteen browser files at once, as in the ticket templates' entry, and it passed three times run alone (a p95 of 39, 39 and 42 ms). The inbox's four browser files and `i18n-browser.test.ts` after the pass: 22 of 22. `npm run guard -- --base origin/v2`: nothing refused, in the 680 v2 files and in the lines changed (run without a private-term list, `CLEARED_REPO` unset). After merging `origin/v2` at `31fccf1` (pull request 343, P215; the log keeps its entry before this one, the browser job both lanes' files, the matrix each id once): `npm run typecheck` passes. `npm test`: 2003 Node tests, 1939 pass, 64 skipped, 0 fail; 316 Vitest tests pass. Its first run had one failure, `test/mcp/followups.test.ts`'s closed-stdout test (an `EPIPE` from the test's own write after the child had exited, a race in the test). Neither this lane nor 343 touches that file, and it passed five times run alone and in the second full run. The browser job's seventeen files: 47 of 47 without the screen-switch budget, which failed once with all seventeen at once and passed three times run alone (a p95 of 33, 35 and 34 ms).

**Resources.** No Docker object, no chat, Cursor or Codex account, no network beyond `npm ci` of the lock file, no tunnel, no secret; the tests and the captures listen on port 0 on loopback.

- Pull request: 345, against `v2`.
- Author: Opus 5.5 (claude-opus-5-5), lane `j3-mobile-ui`.

## 2026-10-25: A local Claude Code reads the lanes and the files they hold through a read-only MCP route, behind a token of its own (the author's choices, lane `j3-local-mcp`, P216, issue #332)

**The need.** P216, one of the ten ideas of the owner's decision of 01:09: a local Claude Code sees the running lanes, the tickets and the files a session holds through a read-only MCP server, and checks before it edits; a local token, nothing reachable beyond the private network, a one-line install, tests. The brief pointed at sections 9 and 10 of `milestone-2-plan.md`, which has eight; the conventions followed are those of section 10 of `milestone-1-plan.md` (a lane fills its own module, never `main.ts`), as lanes `j3-chat-launch` and `j3-ticket-templates` did.

**Decision.**
1. **A route of the service, not a new listener.** `POST /mcp` (`src/mcp/http.ts`), registered by the flow module beside the chat's command. A token and a network rule mean nothing to a stdio server that opens the ledger file, and the live state (which flow runs, a session's plan, who took it over) is the engine's, which only the service holds. No port is opened for it: it is served where the service listens (B3.2). The app's proxy cannot reach it: it forwards `/api/service/<rest>` to `/api/<rest>` only, refuses `..`, and passes no `Authorization` (`app/src/server.ts`, `app/src/proxy.ts`).
2. **The transport.** MCP's Streamable HTTP, each answer one JSON body: no event stream and no session id, which the transport allows. `GET` and `DELETE` are `405` (the registry answers them, the route declaring `POST` only), a notification or a message the client answers is `202` with no body, an unknown `MCP-Protocol-Version` is `400`, a body that is not JSON or is a batch is `400` with the JSON-RPC error, a type other than JSON `415`, over 64 KB `413`.
3. **Three checks before a message is read.** The peer first: loopback and the tailnet (100.64.0.0/10 and its IPv6 `fd7a:115c:a1e0::/48`), IPv4 written in IPv6 too, as B3.2 says; anyone else is `403`, whatever `CLEARED_V2_HOST` says, so a service told to listen wider still answers no one outside. The other private ranges are not taken: a session's container reaches the host from a Docker bridge (172.17.0.0/16 and the like), and the service never trusts a container. A first version took them all, and was narrowed before the pull request. Then no `Origin`: a request from a web page is `403`, so a page the person opens cannot reach the route through their browser (the transport's rule against DNS rebinding). Then the token, `Authorization: Bearer`, compared in constant time; `401` says `WWW-Authenticate: Bearer` and never a value.
4. **A token of its own.** `v2-mcp-token`, beside `ledger.db`, made at the flow module's start by the app proof's own function (`readOrCreateProof`, which now names the file it refuses: an exclusive create, 64 hex characters, mode 600, this account's). It is never the app's proof: the proof with a user id opens every route that writes, and this token opens `POST /mcp` only; the test sends it to an `/api` route and is refused. A token that cannot be made is said at start, never its value, and the route answers `503`. To change it: delete the file, restart, run the install line again.
5. **Three tools that only read** (`src/mcp/lanes.ts`). `list_lanes`: each ticket out of Todo and not Done, its status, whether its flow runs now, each service's branch and pull request, since when, and its sessions (role, harness, model, phase, status, service, dormant, taken over). `list_tickets`: the open tickets, the most recently changed first, 100 at most and the number left (`more`); Done only when `status` asks; never a description or a comment. `locked_files`: the files a lane holds, relative to the repository's root, with the ticket, its title, the session, why (`edited`, `planned`), since when and for how long; `path` names a file or a folder (a folder is matched whole, `src/entr` finds nothing in `src/entries.ts`), `service` one service; `locked` says whether any is held. A path outside the checkout (`..`, `/etc/passwd`) is refused. Every string goes through the ledger server's cleaner (`redact.ts`), so a token in a title is removed. The tools are marked `readOnlyHint`, and the test counts every table's rows before and after.
6. **What "held" means.** Cleared takes no lock on a file. A file is held from the moment a lane's session edits it or names it in its session plan, until the ticket is Done or back in Todo. The engine ends a ticket's flow when its release waits for a person, but the pull request still carries the edits: following the flow (`isActive`) would let the files go while the branch is unmerged, so the ticket's status decides, and `running` says whether the flow runs. A lane's sessions are those started since the ticket last left Todo (its history), so a ticket put back and started again holds only what its new flow touched; a repair of a failed check reopens the same author, still counted. An edit counts once its arguments are journaled, as the Changes card counts it (`flow/state.ts`), not once its result says it was made, as the policy's ticket files do: a refused edit holds its file until the lane ends, the safer side for an agent about to edit it. Paths go through `checkoutPath` of `flow/files.ts`, so `/workspace/src/entries.ts` and `src/entries.ts` are one file. A file's service is its session's, else the ticket's only service, else none.
7. **One JSON-RPC core.** `src/mcp/rpc.ts` holds what the ledger's server had (initialize, ping, tools/list, tools/call, the arguments read as the schema says, a refusal as the tool's error) and both servers use it; its `handle` became asynchronous, since the ticket store is, and `serveStdio` awaits it. `HistoryError` is now a `ToolError`. The ledger's tests pass unchanged.
8. **Words and durations.** `src/mcp/messages/lanes.en.json` and `.fr.json`, over the shell's catalog, in the app's language (`CLEARED_V2_APP_LANGUAGE`, `fr` by default, as the ledger's server reads it); a lane is a "voie" in French, as on the Consumption screen. Durations are said as the app says them (`app/web/lib/time.ts`: "1h 30m", "1 h 30"). No amount is said.
9. **The install line.** `claude mcp add --transport http cleared-lanes http://127.0.0.1:8791/mcp --header "Authorization: Bearer $(cat <folder of ledger.db>/v2-mcp-token)"`, in `v2/README.md`, checked against `claude mcp add --help` only: running it would write the owner's Claude settings.
10. **Not done.** No real Claude Code was pointed at the route; no event stream, so a lane that starts is seen at the next call, not pushed; no lock that Cleared enforces, only what an agent reads before it edits.

**Tests first.** The tests were committed alone in `023d0d7`. There, `test/mcp/lanes.test.ts` and `test/mcp/lanes-http.test.ts` do not load (`src/mcp/lanes.ts` and `src/mcp/http.ts` do not exist), `test/mcp/catalog.test.ts` fails on the missing `lanes.*.json`, and `test/flow/modules.test.ts` asks for `POST /mcp` among the flow module's routes and 39 routes instead of 38. Changed after that commit: the three durations the tests expect are written with the no-break spaces the shell's catalog puts in them ("1h 30m"). The token file's constant is `MCP_ACCESS_FILE` and the key of the message for a token that cannot be read `http_unreadable`: the guard reads a name holding "token" given a quoted value as a secret.

**Checks.** `npm run typecheck` passes. `npm test` (the build, `node --test` and Vitest): 1974 Node tests, 1922 pass, 52 skipped because `CLEARED_V2_PLAYWRIGHT` is not set, 0 fail; 306 Vitest tests pass. A mutation check: without the filter on the sessions started since the ticket last left Todo, the put-back test fails. No browser test was run: nothing of the app changed. After merging `origin/v2` at `ec82103` (pull request 341, P213; the log keeps its entry before this one, the matrix each id once): `npm run typecheck` passes, `npm test` runs 1991 Node tests, 1937 pass, 54 skipped, 0 fail, and 313 Vitest tests pass. `npm run guard -- --base origin/v2`: nothing refused. After merging `origin/v2` at `31fccf1` (pull request 343, P215; the log keeps its entry after 341's and before this one, the matrix its P215 line and this lane's P216, each id once; the flow module's routes are still 39): `npm run typecheck` passes, `npm test` runs 2014 Node tests, 1958 pass, 56 skipped, 0 fail, and 316 Vitest tests pass. `npm run guard -- --base origin/v2`: nothing refused. The CI's `browser` job then failed once on `app/test/foundation/budget-browser.test.ts` ("twenty switches": the median of the runs' p95 104.8 ms, over its 100 ms), its other 39 tests passing; this lane changes no code the browser loads. Run alone three times on this server, its median p95 is 38.5 to 84.7 ms on this branch (the first run cold) and 35.6 to 50.6 ms on `origin/v2` at `c2bd384` in a temporary worktree: no cost of this lane, the shared runner's noise, as an earlier entry of this log measured. The budget is left as it is. After merging `origin/v2` at `c2bd384` (pull request 345, P217; the log keeps its entry after 343's and before this one, the matrix its P217 line and this lane's P216, each id once; the flow module's routes are still 39): `npm run typecheck` passes, `npm test` runs 2022 Node tests, 1958 pass, 64 skipped, 0 fail, and 316 Vitest tests pass; the budget test alone, three times, 33.2 to 34.3 ms. `npm run guard -- --base origin/v2`: nothing refused.

**Resources.** No Docker object, no Claude Code, chat, Cursor or Codex account, no network beyond `npm ci` of the lock file, no tunnel, no secret: the tests' tokens are made at run time, and the service and the fake client listen on port 0 on loopback.

- Pull request: 344, against `v2`.
- Author: Opus 5.5 (claude-opus-5-5), lane `j3-local-mcp`.

## 2026-10-25: the production page checked after a release landed; Cleared never deploys (the author's choices, lane `j3-post-deploy`, P218, issue #334)

**The need.** P218, one of the ten ideas of the owner's decision of 01:09: only after the human approved a release and the human or their CI deployed it, Cleared captures the configured production page and attaches it to the ticket; Cleared never deploys, and a test proves it; the tests use a fake page. The brief pointed at sections 9 and 10 of `milestone-2-plan.md`, which has eight, as lanes `j3-chat-launch` and `j3-code-qa-links` noted; the conventions followed are those of sections 9 and 10 of `milestone-1-plan.md` (a lane changes its own module and its own files).

**Decision.**
1. **When.** At `release_landed`, which the flow emits only for a release the human moved to go, that the lock merged, and whose release watch ended (`flow/ledger.ts landingOf`). A service's page is captured only when its own watch ended healthy: the watch probed the deployed version after the project's `deploy_grace_minutes`, which is what says that the human's or the CI's deploy is done. A rolled back release is not live: nothing is opened. A project with no health check lands `unwatched` at its merge, and nothing says when the deploy is done: no page is opened, and the ticket and its card say why, with the setting that would change it. A release that ends unhealthy emits no `release_landed`, so it gets no check; the owner decides on it as before.
2. **Which page.** `[release] production_url` in the service's own `.cleared/agents.conf`, read at its base branch with the other settings (`flow/config.ts`), so the one-service workspace built from the environment has it too. An http or https address, without a user or a password (the message never repeats it). Never the health address: the example's is loopback, and the issue asks for the configured page. v1's `releaseSettings` ignores the key; it is in `docs/configuration.md`.
3. **The capture.** `captureProduction` (`flow/proof-capture.ts`), beside the receipt's: one full-page screenshot, `production.png`, in the ticket's proof folder, at 1280 by 800. The page is read and never acted on: no click, no scroll, no form; a request that is not a GET or a HEAD of the page's own origin is aborted, every WebSocket closed, service workers blocked; a script or a form of the live page changes nothing there. What fails is a code (`no_browser`, `failed`), never a browser's words. The receipt's cap holds: a browser that hangs is `failed` after `PROOF_TIMEOUT_MS`, and the ticket stays Done.
4. **A train.** The train emits `release_landed` once, after its last service; each service is read from its own stop's landing, and each that configures a page has it captured, in its own folder.
5. **Attached.** The check (`ProductionCheck`: the service, the pull request, the address without its query, the time, the file or why there is none) is journaled as `cleared.production_checked` on the session the release was approved on, once per service: that session is the release's, so a later release of the same ticket gets its own check. The ticket gets a comment, cleaned, which says that Cleared did not deploy. `GET /api/tickets/:id/production` gives the last check of each service, and the receipt's file route serves `production.png`, both behind the app's proof. The Done ticket card says when the page was captured, a fact a line under the cost, with "See the capture" opening it through the app in a new tab, or why it was not; the card reads the checks again at each change, since the check is filed after the ticket is Done. The words are in `app/messages/session.{en,fr}.json`, the French with a no-break space before a colon. No amount: nothing here costs tokens.
6. **Never deploys.** `test/flow/never-deploys.test.ts`: no route of any module and no route of the API names a deploy, no effect of the real `FlowEffects` does, and no file under `v2/src` or `v2/app/src` names a deploy command of the usual hosts and CIs (`gh workflow run`, a workflow dispatch, a deployments endpoint, kubectl, helm, the hosting CLIs, `docker push`, a forced push). The two new routes are GETs.

**What is proven, and what is not.** The flow on the fake adapter, a fake lock and a fake capture (`test/flow/production.test.ts`): approved, merged, healthy, captured once with the configured address, journaled, said, served; nothing before the approval, while the watch runs, or after a rollback; `unwatched` with no health check; nothing at all with no `production_url`; a capture that throws or hangs is `failed`. A train's two services (`test/flow/train.test.ts`). The capture with a fake browser, then with a real Chromium on a fake production page served on loopback (`test/flow/production-capture.test.ts`, in CI's browser job): the page's POST, its form and its request to another origin never reach a server; a mutation that drops the method check makes it fail. The card in English and French (`app/web/test/session/production-check.test.tsx`), and in a real Chromium on the fixtures source (`app/test/session/production-browser.test.ts`, in CI's browser job): the line, the link and its new tab, the capture served, no horizontal scroll at 1440, 1280, 768 and 390, light and dark. The captures are in `docs/v2/post-deploy/`. The real capture test ran ten times in a row without a failure (its page submits a form while it loads, a navigation the route aborts). Not run: a real production page of a piloted project, since none sets `production_url` yet.

**Limits, accepted.** `release_landed` is said once: a service stopped between the watch's end and the capture's (at most the cap, 90 seconds) leaves that landing without a check, and its card says nothing; the next landing is checked as usual. A redirect to another origin is aborted like any other request, so `production_url` must be the final address (`docs/configuration.md` says so). The pull request's body is not edited: by the deploy it is merged, and writing to it is a write on the forge; the ticket's comment and its card are the report. The command scan reads `v2/src`, `v2/app/src`, v1's `lib/` and the lock's scripts at the root (`merge-pr.sh` and the others), which the service runs for a release; its patterns name the commands (`vercel deploy`, not `vercel`), since `lib/fast-lane.mjs` lists `vercel.json` and `wrangler.json` among the configuration files a fast change may not touch.

**Tests first.** `4d7fb76` committed the tests alone. On that code the capture test does not load (no `captureProduction`), the flow's six tests fail (no check, no route), two of the three never-deploys tests fail on the route and the effect they expect (the command scan passed, guarding what must not change; it was widened to v1's `lib/` and the root scripts after the guard's run, below), the new config and train tests fail, the pinned route lists (`test/api/types.test.ts`, `test/flow/modules.test.ts`) fail, and four of the card's five Vitest tests fail (the fifth, nothing drawn where nothing should be, passes on the old code too). Later edits to the tests: a replacement in `train.test.ts` had also hit two other tests, and was undone there; two assertions were loosened for TypeScript (an empty `deepEqual` narrows the array to `never`); the config test's address with a password is written in two parts, as `test/workspace/checkout.test.ts` does, after `npm run guard` refused it whole; the pinned count of the assembled routes and the list of custom events gained the new entries; the browser test of the card was written after the code, with the fixtures' resolved story journaling a check at the review's end so the ticket's time P211's tests pin stays 38 minutes.

**Checks** (on `origin/v2` at `31fccf1`). `npm run typecheck` passes. `npm test` runs 2012 Node tests, 1952 pass, 60 skipped (the browser tests, with no `CLEARED_V2_PLAYWRIGHT`), 0 fail; Vitest, 321 tests pass. With `CLEARED_V2_PLAYWRIGHT`, `test/flow/production-capture.test.ts` and `app/test/session/production-browser.test.ts` pass 6 of 6. `test/ci-triggers.test.mjs` passes 4 of 4. `npm run guard -- --base origin/v2`: nothing refused (its first run refused the config test's address with a password, written whole; see above).

**The merge of 345** (P217, at `origin/v2` `c2bd384`). The matrix keeps 345's P217 and this lane's P218, every id once. The log keeps 345's entry, then this one. CI's browser job lists 345's `app/test/inbox/mobile-browser.test.ts` and this lane's two files. After the merge: `npm run typecheck` passes; `npm test` runs 2020 Node tests, 1952 pass, 68 skipped (the browser tests), 0 fail, and 321 Vitest tests pass; with `CLEARED_V2_PLAYWRIGHT` the three browser files pass 14 of 14; `test/ci-triggers.test.mjs` passes 4 of 4; `npm run guard -- --base origin/v2`: nothing refused.

**Resources.** No Docker object, no account, no real deploy, no tunnel, no secret. The tests listen on port 0 on loopback; the real Chromium opens only those fake pages.

**The merge of 344** (P216, at `origin/v2` `c1940c2`). The log keeps 345's entry, then 344's, then this one and the P216 follow-ups after it. The matrix merged by itself and keeps every id once. The flow module's assembled routes count both lanes' new routes, 40 (`test/flow/modules.test.ts`); the API's list stays 66, since 344's MCP route is not one of the app's. After the merge: `npm run typecheck` passes; `npm test` runs 2039 Node tests, 1971 pass, 68 skipped (the browser tests), 0 fail, and 321 Vitest tests pass; `test/ci-triggers.test.mjs` passes 4 of 4; `npm run guard -- --base origin/v2`: nothing refused. CI's browser list run here whole with `CLEARED_V2_PLAYWRIGHT`: 53 of 54 pass. The one that fails is `app/test/foundation/budget-browser.test.ts` ("twenty switches", the median p95 at 119.1 and 129.9 ms, over its 100 ms), which 344's entry already saw fail once in CI. It is the load of 19 files at once on this server: run alone three times it passes at 29.9 to 33.6 ms, and the list without this lane's two browser files fails it too (133.0 and 139.3 ms). This lane changes no code that test loads.

- Pull request: 346, against `v2`.
- Author: Opus 5.5 (claude-opus-5-5), lane `j3-post-deploy`.

## 2026-10-25: the non-blocking follow-ups of P216 (pull request 344) filed as issues

**Decision.** The non-blocking follow-ups of P216 (#344) are open as issues #347 to #353, label `v2`: the Host header check of `POST /mcp` (#347), the language and the cleaner read at the start (#348), the stop when the ledger is not found (#349), a test of the MCP token (#350), safe durations on an invalid date (#351), one read of the history per call (#352), and the refusal of a peer outside the tailnet (#353). None blocks the merge of 344.

## 2026-10-25: stable prompt prefixes for the prompt cache, measured on a reference fake run (the author's choices, lane `j3-prompt-cache`, P219, issue #335)

**The need.** Issue #335, the owner's decision of 01:09 (P219): stable prompt prefixes (a fixed order, no timestamp at the top) and grouped tools, so that the prompt cache serves more of what the sessions send. A before and after measure on a reference fake run (input tokens, the share served by the cache) is recorded here. Sessions behave as before, and the existing tests stay green.

**What the cache can reuse.** A request is read as the tools, then the system prompt, then the messages. The cache serves a prefix only up to its first changed byte, and only at an end where an earlier request wrote an entry. An entry lives 5 minutes after its last use, and Opus 5.5 caches nothing shorter than 512 tokens (the Messages API's prompt caching). Within one session, Claude Code reuses its own prefix turn after turn, whatever Cleared writes. Cleared's choices change what one session can reuse of another's: the host tools, the preset, then the briefing (CLAUDE.md, which the runner appends to the system prompt).

**What the reading found.**
1. **The preset's per-session sections stood before the briefing.** With `append`, the `claude_code` preset writes the working directory and git status (the ticket's branch, its commits) into the system prompt, before CLAUDE.md. Two authors of a plan started together with the same briefing therefore differed before it, and shared only the tools and the preset's static part.
2. **The lead's briefing had its generation number and start time right after the rules,** above all its data: the timestamp at the top.
3. **The tools were already grouped.** The host tools are one in-process MCP server, `cleared`, loaded up front (`alwaysLoad`). The lead's list follows `LEAD_TOOLS` and the author's `AUTHOR_TOOLS`, whatever the generation or the ticket. An author who is not asked for a plan keeps `propose_session_plan`, which refuses the call. No description names a ticket. A step of a ticket on several services adds `leave_note` last. Nothing changed here; tests now pin it.
4. **The author's and the reviewer's CLAUDE.md, and the first turns, are left as they are.** The cache reads at the end of the system prompt, not inside the briefing, so an order inside it gains nothing. A one-service workspace's briefing is also pinned byte for byte (`test/flow/effects.test.ts`). The first turn's end is reached only by a session that sends the same first turn.

**Decision.**
1. **The runner's system prompt leaves out the preset's per-session sections** (`images/session/runner/main.ts`): `{ type: 'preset', preset: 'claude_code', append, excludeDynamicSections: true, snapshot: true }`. These options come from `sdk.d.ts` of SDK 0.3.306, the version the image pins. The SDK gives the working directory, auto-memory and git status to the model as the first user message. The SDK says that context then steers the model "marginally less" than from the system prompt; this is the one change of what the model reads, and it reads the same facts. `snapshot` is the SDK's default, written out: the prompt is recorded once per session.
   - The adapter turns a user frame into events only for its tool results. A context message the SDK might print reaches neither the ledger nor the thread (`test/session/claude-code/map.test.ts`).
   - Not chosen: a custom system prompt in blocks around `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`. It would replace Claude Code's own preset.
   - Not chosen: moving a ticket's decisions and last handover from CLAUDE.md to the first turn. More briefings would be alike, but the model would get them as a message instead of its instructions, which changes the sessions.
2. **The lead's briefing goes from what changes least to what changes most** (`src/lead/briefing.ts`): the rules, then under the reference line the memory, the open commitments, the last handover, and last one line, "You are generation N of the lead, started at T". The instruction that the structured parts win stays above the reference line. In the measure below this gains nothing: the briefing is read as one block, and a new generation starts hours after the last. It is done because the issue asks for no timestamp at the top, and it costs 14 tokens.
3. **The tools stay as they are**, pinned by tests (item 3 above).

**The measure.** `v2/scripts/prompt-cache.ts` (`node scripts/prompt-cache.ts`, or `--json`) builds the first request of each session of a reference fake run from Cleared's own code. The tools come from `LEAD_TOOLS` and `AUTHOR_TOOLS`. The briefings come from `renderLeadBriefing`, `renderBriefing` and `readerBriefing`, with the guestbook example's README as the project page. The first turns come from `authorPrompt`, `variantPrompt`, `pickPrompt`, `reviewPrompt`, `readerPrompt` and `openingPrompt`. The system prompt option comes from the runner itself, run on a stand-in query.
- **The model.**
  - The cache reads and writes at three ends: the end of the preset's static part, the end of the system prompt and the end of the first message. Of the first, `sdk.d.ts` says that blocks before that boundary are eligible for cross-session caching, and that blocks after it are not. The other two are this model's assumption: that the ordinary prefix cache still reads where Claude Code ends the system prompt and the first message. The briefing comes after the boundary, so every gain below rests on that assumption.
  - An entry lives 5 minutes from its last use.
  - The SDK's texts (the built-in tools, the preset, the per-session sections) count no tokens, and are told apart by what makes them differ: branch, commit, day.
  - Cleared's texts count one token per 4 bytes of UTF-8. That is an estimate, not the tokenizer's count.
  - Only each session's first request is measured.
- **The run**, 11 sessions:
  - the lead's first generation;
  - the plan's two first tickets one minute later, LOCAL-12 and LOCAL-13 (a plan starts two at a time, and neither carries a decision of its own);
  - a pick of three Claude Code variants of LOCAL-14 at 3 minutes, a ticket with an approved decision of its own;
  - two questions to the code, at 6 and 8 minutes;
  - the reviews of LOCAL-12 and LOCAL-13, at 25 and 26 minutes;
  - the lead's second generation, three hours later.
- **Before:** the script at `96f6437` (the tests and the script, the code as `origin/v2` at `c2bd384`). **After:** `9f5f54f`.

| Session | Before: input | Before: served | After: input | After: served |
| --- | ---: | ---: | ---: | ---: |
| lead, generation 1 | 5980 | 0 (0 %) | 5994 | 0 (0 %) |
| author LOCAL-12 | 3918 | 0 (0 %) | 3918 | 0 (0 %) |
| author LOCAL-13 | 3923 | 401 (10.2 %) | 3923 | 3549 (90.5 %) |
| author LOCAL-14, variant 1 of 3 | 4093 | 401 (9.8 %) | 4093 | 401 (9.8 %) |
| author LOCAL-14, variant 2 of 3 | 4093 | 3581 (87.5 %) | 4093 | 3581 (87.5 %) |
| author LOCAL-14, variant 3 of 3 | 4093 | 3581 (87.5 %) | 4093 | 3581 (87.5 %) |
| reader: Where is an entry checked before it is stored? | 278 | 0 (0 %) | 278 | 0 (0 %) |
| reader: What does /health answer when the database is slow? | 279 | 239 (85.7 %) | 279 | 239 (85.7 %) |
| reviewer LOCAL-12 | 3620 | 0 (0 %) | 3620 | 0 (0 %) |
| reviewer LOCAL-13 | 3625 | 0 (0 %) | 3625 | 3121 (86.1 %) |
| lead, generation 2 | 6123 | 0 (0 %) | 6137 | 0 (0 %) |
| **The run** | **40025** | **8203 (20.5 %)** | **40053** | **14472 (36.1 %)** |

Estimated tokens. "Served" is the part of a session's first request a cache entry of an earlier session covers.

**The lower bound.** `node scripts/prompt-cache.ts --no-system-entry` measures with no entry at the end of the system prompt. The run then shares only the authors' tools, 401 tokens in each of four sessions: 1604 of 40053, 4.0 %. That holds before and after alike, because the two entries left fall in the same places either way. If Claude Code writes no entry there, this change gains nothing.

**What it shows, and what it does not.**
- Under the model, the gain is in sessions of one role whose briefings are the same and that start within 5 minutes of each other: the plan's second ticket (401 to 3549) and its review (0 to 3121).
- The variants of one ticket already shared their whole system prompt: same branch, same commit, same day.
- A ticket with a decision or a handover of its own has a briefing of its own and gains nothing (LOCAL-14's first variant).
- The lead gains nothing.
- No money amount: no real source gives one for these runs.
- The model's read points beyond the documented boundary and its token counts are not the API's. Two things remain unmeasured: a real run's `cachedInputTokens` in the ledger (`RUN_FINISHED`'s usage), and the real CLI with the two options (`docs/adapters.md`, the paragraph of 2026-10-25). Both need the session image and the service's login, which this lane did not use; they are the owner's to run.

**Read.** `docs/v2/milestone-2-plan.md` has no sections 9 and 10, as lanes `j3-chat-launch`, `j3-code-qa-links` and `j3-mobile-ui` noted. Read in their place: `milestone-1-plan.md` sections 9 and 10 (waves, and the conventions that keep a lane to its own modules).

**Tests first.** `96f6437` was committed before any code. On that code:
- `test/lead/briefing.test.ts`'s new test fails: the two generations share 5152 characters, short of the memory's end at 5825.
- The two `systemPrompt` assertions of `test/session/claude-code/runner.test.ts` fail: the options lack the two keys.
- The last test of `test/scripts/prompt-cache.test.ts` fails: LOCAL-13 is served 401 tokens, not 3549.

These pass on that code and are kept as guards: the map test, the tools assertions added to `test/lead/engine.test.ts` (both generations' tools, byte for byte) and `test/flow/plan-gate.test.ts` (`AUTHOR_TOOLS` as written, no ticket id), and the model's own tests. Existing tests changed: the two runner assertions, whose expected object gained the two keys, and the two tests that gained the tools assertions. No assertion was removed.

**Checks** (on `origin/v2` at `c2bd384`, which had not moved when this was written). `npm run typecheck` passes. `npm test`: 2012 Node tests, 1948 pass, 64 skipped (the browser tests, with no `CLEARED_V2_PLAYWRIGHT`), 0 fail; 316 Vitest tests pass. `npm run guard -- --base origin/v2`: nothing refused, in the 685 v2 files and in the lines changed (run without a private-term list, `CLEARED_REPO` unset).

**The merge of 344** (P216, at `origin/v2` `c1940c2`). The log keeps 344's entry, then this one; the matrix merged by itself and keeps every id once. 344 touches none of this lane's files. After the merge: `npm run typecheck` passes; `npm test` runs 2031 Node tests, 1967 pass, 64 skipped (the browser tests), 0 fail, and 316 Vitest tests pass; `node scripts/prompt-cache.ts` gives the same 36.1 %, and 4.0 % with `--no-system-entry`; `npm run guard -- --base origin/v2`: nothing refused, in the 692 v2 files and in the lines changed.

**The merge of 346** (P218, at `origin/v2` `857a2b9`), after the two reviews passed. The log keeps 346's entry and the P216 follow-ups, then this one; the matrix keeps 346's P218 line and this lane's P219, every id once. 346 touches none of this lane's files. After the merge: `npm run typecheck` passes; `npm test` runs 2048 Node tests, 1980 pass, 68 skipped (the browser tests), 0 fail, and 321 Vitest tests pass; `node scripts/prompt-cache.ts` gives the same 36.1 %, and 4.0 % with `--no-system-entry`; `npm run guard -- --base origin/v2`: nothing refused, in the 698 v2 files and in the lines changed.

**Resources.** No Docker object, no session image, no login file read, no Slack, Cursor or Codex account, no network beyond `npm ci` of the lock file, no port, no tunnel, no secret.

- Pull request: 354, against `v2`.
- Author: Opus 5.5 (claude-opus-5-5), lane `j3-prompt-cache`.

## 2026-10-25: the lanes' MCP route reads its words and its cleaner at start, and no module starts without a ledger (the author's choices, lane `j3-mcp-startup`, P220, issues #348 and #349)

**The need.** Two follow-ups of P216 (pull request 344). #348: the flow module built `POST /mcp` with `CLEARED_V2_APP_LANGUAGE` and `createRedactor` read when the module was imported, so an environment set between the import and the start was not seen. The cleaner matters more than the words: `createRedactor` takes the secret values of the environment when it is made, and a secret set after the import was never removed. #349: the comment of `ledgerFolder` said that when the ledger's folder cannot be told, "the service stops at start", with no test named. The brief pointed at sections 9 and 10 of `milestone-2-plan.md`, which has eight; the conventions followed are those of section 10 of `milestone-1-plan.md` (a lane fills its own module, never `main.ts`), as the P216 lane did.

**Decision.**
1. **Read at start, engine or not.** The flow module's `start` reads the language and makes the cleaner first, before it looks for an engine: without one, `POST /mcp` still answers, and its refusals are in that language. A request before any start reads them then, once. A second start reads them again.
2. **Getters in `McpRouteDeps`.** `language` and `redactor` are functions, read per request. The tool server of an engine is made again when either changed, so a new start is seen without a new engine. The refusal's words are looked up per refusal; the catalog itself is read once per language, as before.
3. **#349: the claim holds, the comment now says why.** `main.ts` opens the ledger at `ledgerPath()` before it listens and exits with 64 when it has no place, and the modules start in the listen callback: a module's start never runs without a ledger. The test that proves it was already there, `test/main.test.ts` ("a ledger the service cannot place stops it before it listens"); it now names #349 and says so. The empty folder list is left for a start without `main.ts` (a test), whose `POST /mcp` then has no token and answers `503`.
4. **Not done.** No test sets a secret between the import and the start and reads it cleaned: that needs an engine and a tool call. The cleaner goes through the same path as the language, which the test checks. The token is still made once per process, as P216 left it.

**Tests first.** The tests were committed alone in `bf9eb1c`. There, `test/flow/mcp-startup.test.ts` imports the flow module with `CLEARED_V2_APP_LANGUAGE=fr`, sets `en`, starts it and sends `POST /mcp` with a wrong token: the refusal comes back in French. The renamed test in `test/main.test.ts` passes there, as it did before. Changed after that commit: the three calls of `lanesMcpRoutes` in `test/mcp/lanes-http.test.ts`, to the getters; and the new test sets `fr` back after the start, before the request, since the first version also passed with a read at the first request only.

**Checks.** `npm run typecheck` passes. `npm test` (the build, `node --test` and Vitest): 2049 Node tests, 1981 pass, 68 skipped (66 because `CLEARED_V2_PLAYWRIGHT` is not set, 2 because `CLEARED_V2_REAL_HARNESS` is not), 0 fail; 321 Vitest tests pass. A mutation check: without the read in `start`, `test/flow/mcp-startup.test.ts` fails (the refusal in French). No browser test was run: nothing of the app changed.

**Resources.** No Docker object, no Claude Code, Slack, Cursor or Codex account, no network beyond `npm ci` of the lock file, no tunnel, no secret: the test's service listens on port 0 on loopback.

- Pull request: 355, against `v2`.
- Author: Opus 5.5 (claude-opus-5-5), lane `j3-mcp-startup`.

## 2026-10-25: the lanes' MCP tools say no "NaN" and read the history once per call (the author's choices, lane `j3-mcp-lanes-perf`, P216, issues #351 and #352)

**The need.** Two non-blocking follow-ups of pull request 344 (P216). Issue #351: `since()` in `v2/src/mcp/lanes.ts` never says "NaN"; a date that is none gives a duration that is absent (`null`), and a test proves it. Issue #352: `lanes()` reads the open tickets' history without one read per ticket, or the measured call stays under a budget the test writes; `locked_files` does not read the lanes twice. The brief pointed at sections 9 and 10 of `milestone-2-plan.md`, which has eight, as earlier lanes noted; the conventions followed are those of sections 9 and 10 of `milestone-1-plan.md` (a lane changes its own files). Neither issue's text nor pull request 344's comments say where `locked_files` read the lanes twice: it calls `lanes()` once on `v2`, so the test pins that.

**Decision.**
1. **A duration from a date that is none is `null`.** `lasted` (`app/web/lib/time.ts`) gives "NaNd NaNh" for `NaN`, since `Math.max(0, NaN)` is `NaN`. The fix is in `lanes.ts`, not in the shared `time.ts`: `since()` returns `null` when the clock or the date is not a date, so `runningFor`, a session's `for` and a file's `heldFor` are `null`. The date itself (`startedAt`, `since`) is given as the tracker wrote it. No new word, so no catalog change.
2. **Every open ticket's history in one read.** `TicketStore` gains `histories(ids)`: a map from id to history, each as `history` gives it, an id the store does not know left out (`history` throws on one; a tool that lists must not fail on a ticket that went away between the two reads). The in-memory store reads its map; the local store runs one query, `tracker_history` joined to the ids through `json_each`, prepared once, and verifies each row's signature as `history` does, so a signed row is still the human's and an altered one is not. `lanes()` lists the tickets once, then reads the open ones' history once. Only these two stores implement the contract in the repository.
3. **A count, not a budget.** The issue allowed a time budget; it was not taken. On the in-memory store the whole test over 21 lanes ran in 17 ms on the old code, so a budget would pass on the old code (B4.6 asks a defect test to fail there) and would flake on a loaded runner, as the browser budget test does. The test counts the store's reads instead: over 21 lanes, `list_lanes` and `locked_files` each list once and read the history once, and `list_tickets` reads none.

**Tests first.** `6d9bc71` committed the tests alone. On that code four tests fail: the invalid date (`runningFor` is "NaNd NaNh"), the reads (21 reads of the history for 21 lanes), and the two `histories` tests (`histories is not a function`).

**Checks.** `npm run typecheck` passes. `npm test` runs 2052 Node tests, 1984 pass, 68 skipped (the browser tests, with no `CLEARED_V2_PLAYWRIGHT`), 0 fail; Vitest, 321 tests pass. No browser test was run: nothing of the app changed. `npm run guard -- --base origin/v2`: nothing refused.

**The merge of 355** (P220, at `origin/v2` `26822ed`). The log keeps 355's entry, then this one; the matrix merged by itself and keeps every id once (P216 with these follow-ups, P220 from 355). After the merge: `npm run typecheck` passes; `npm test` runs 2053 Node tests, 1985 pass, 68 skipped (the browser tests), 0 fail, and 321 Vitest tests pass; `test/ci-triggers.test.mjs` passes 4 of 4; `npm run guard -- --base origin/v2`: nothing refused.

**Resources.** No Docker object, no account, no network beyond `git fetch` and GitHub, no port, no secret.

- Pull request: 356, against `v2`.
- Author: Opus 5.5 (claude-opus-5-5), lane `j3-mcp-lanes-perf`.

## 2026-10-25: a question to the code from a session's Plan tab (the author's choices, lane `j3-plan-ask`, matrix C11)

**The need.** C11 was `partial`: decision 28 starts a reader "from the tower bar or a session's Plan tab", and the session screen only linked the reader's own rows. The section "Reste avant v2 -> main" listed it under code to write. No issue: the line is the brief. The brief pointed at sections 9 and 10 of `milestone-2-plan.md`, which has eight; the conventions followed are those of section 10 of `milestone-1-plan.md` (a lane changes its own files, a screen's words in its catalogs, `api/types.ts` untouched), as the earlier lanes did.

**Decision.**
1. **The same reader, the same routes, the same screen.** The Plan tab gains a card under the criteria, "Ask about the code": a field, Ask, and a line saying what the reader reads. Ask sends `POST /api/asks` through the app's forwarding, as the tower's bar does (`startAsk`), and opens `/ask/:id`, where each turn's answer, cost and tokens, the sum and the week share are drawn as lane 27 made them. Nothing of the service changed.
2. **About the session's service.** `planAskBody` is the tower's `askBody` with the session's service picked: a question that names a `service:path:line` of the workspace is about that line, of whichever service; else it is about the session's service; a session with no service asks every service. The workspace's services are read when the question is sent (`GET /api/workspace`); when that read fails, the list is empty and the service checks the target, as it already does.
3. **What the card says.** The reader works on the base branch, not on the session's checkout, so the card says so: "Read only, on the base branch of guestbook: the reader does not see this session's changes, and never edits, commits or pushes." The answer's page is named with its cost. No amount is drawn on the card: the cost is the reader's `total_cost_usd`, shown on the ask's screen as before.
4. **Whatever the session's state.** The card is drawn with no plan, while the plan waits for its Go, after it, and on an ended session: the reader reads the base branch, so the session's state changes nothing. It holds its own state, not the plan's Go and Change gesture, so a question on its way does not hold Go.
5. **The refusals.** An empty question, or one past the reader's 4000 characters, is said under the field and nothing is sent. A refusal of the route reads as the tower's does (`askFailure`: three asks at once, a target the service refused, questions off); the words are copied into `session.{en,fr}.json`, the screen's catalog.
6. **The fixtures.** Both fixture sources now keep the body's service and target in the ask they start (`startedAsk` in `app/fixtures/ask.ts`), and the session fixture answers the reader's two routes, so the browser test reads the ask's target on its screen.
7. **Not done.** The ask's screen still goes back to the tower, not to the session it was asked from; the ask keeps no link to that session. No live reader was run behind the app from the Plan tab: lane 25's real ask (2026-10-22) proves the reader, and proof j2 drives the app.

**Tests first.** `6d780d1` committed the tests and the fixture support alone. There, `app/test/session/plan-ask.test.ts` does not load (no `planAskBody` in `tabs.ts`), the five tests of `app/web/test/session/plan-ask.test.tsx` find no card, and both tests of `app/test/session/plan-ask-browser.test.ts` time out waiting for `#plan-ask-input`; `app/test/ask/app.test.ts` passes there with the fixture's change. Changed after that commit: the card's state field is `status`, not `note`, because the i18n audit reads a `note: ''` property as a catalog key; the Vitest file follows.

**Checks** (on `origin/v2` at `26822ed`). `npm run typecheck` passes. `npm test`: 2054 Node tests, 1984 pass, 70 skipped (68 because `CLEARED_V2_PLAYWRIGHT` is not set, 2 because `CLEARED_V2_REAL_HARNESS` is not), 0 fail; 326 Vitest tests pass. With `CLEARED_V2_PLAYWRIGHT`, the 20 files of CI's browser job, run together: 56 tests, 55 pass; the one that failed is `app/test/foundation/budget-browser.test.ts` (p95 of the tab switches 122.9 ms, over its 100 ms, with twenty files at once), which passes alone, twice (31.0 ms and 26.1 ms). Run again: the 20 files fail it at 104.0 ms, and the 19 files without `plan-ask-browser.test.ts` fail it too, at 117.8 ms, so it is this machine running the files at once, not the new file. `test/ci-triggers.test.mjs` passes 4 of 4 with the new file in the browser job. Captures at the four widths, light and dark, and in French at 1440 and 390, are in `docs/v2/plan-ask/`. `npm run guard -- --base origin/v2`: nothing refused.

**The merge of 356** (lane `j3-mcp-lanes-perf`, at `origin/v2` `3ba2799`). The log keeps 356's entry, then this one; the matrix merged by itself. After the merge: `npm run typecheck` passes; `npm test` runs 2058 Node tests, 1988 pass, 70 skipped, 0 fail, and 326 Vitest tests pass; with `CLEARED_V2_PLAYWRIGHT`, `plan-ask-browser`, `citations-browser` and `tabs-browser` pass 8 of 8; `npm run guard -- --base origin/v2`: nothing refused.

**Resources.** No Docker object, no Claude Code, Slack, Cursor or Codex account, no network beyond `npm ci` of the lock file, no tunnel, no secret; the browser tests listen on port 0 on loopback and abort any request that leaves the app.

- Pull request: 358, against `v2`.
- Author: Opus 5.5 (claude-opus-5-5), lane `j3-plan-ask`.

## 2026-10-25: the MCP route checks the Host, refuses a real peer outside the tailnet, and makes its token at start (the author's choices, lane `j3-mcp-access-sec`, P216, issues #347, #350, #353)

**The need.** Three of the non-blocking follow-ups of P216 (pull request 344): the `Host` header of `POST /mcp` checked before the token is read (#347); the refusal of a peer outside the tailnet proven on a real socket, not on a request made by hand (#353); the token's creation tested on a started service, with a token that cannot be read said in the log without its value and the route at `503` (#350). The brief pointed at sections 9 and 10 of `milestone-2-plan.md`, which has eight, as earlier lanes noted; the conventions followed are those of section 10 of `milestone-1-plan.md` (a lane changes its own module and its own files).

**Decision.**
1. **The Host, the third of four checks** (`allowedHost`, `src/mcp/http.ts`). The order is the peer, then no `Origin`, then the `Host`, then the token, so a refused `Host` never reads the token (the test counts the reads). Taken: `127.0.0.1`, `localhost` and `[::1]`, in any case, with or without a port, and the tailnet address the request came in on, which is the socket's own address when it falls in 100.64.0.0/10 or `fd7a:115c:a1e0::/48`. That last one needs no setting: whatever `CLEARED_V2_HOST` says, a client that reached the service on its tailnet address writes that address. An IPv6 address is compared as an address, so `[fd7a:115c:a1e0:0:0:0:eb2c:1]` is `[fd7a:115c:a1e0::eb2c:1]`. Refused, `403` with `http_host`: no `Host`, any other name (`evil.example`, `127.0.0.1.nip.io`, `localhost.`), another spelling of loopback (`127.1`, `0.0.0.0`, `[::ffff:127.0.0.1]`), a user part, a port that is not a number, and a tailnet address other than the one the request came in on. The name is matched as written, not through `new URL`, which would turn `127.1` into `127.0.0.1`. The message does not repeat the `Host` it got.
2. **A real peer outside the tailnet.** The test picks an IPv4 address of this machine outside loopback and the tailnet (`privatePeer` decides, as the route does) and sends the request from it to the service's listener on loopback, so the socket's peer is that address and nothing listens wider than loopback. `403` with `http_peer`, the token not read; the same server answers a loopback request `200`, so the `403` comes from the address. With no such address, or a system that will not route it, the test is skipped and says why. No address of the machine is written here, in the tests or in the pull request.
3. **The token at start, with or without a project.** The flow module's `start` made the token after its check for an engine, so a service with no project made it only at the first request, and the install line had no file to read. It is now the first thing `start` does. The service's folder is the one the app's proof is already made in, so no new place is written. The test starts the real service (`src/main.ts`) on a temporary folder with no project, so no engine and no container, on a free port of loopback: the file is there before any request, 64 hex characters and a newline, mode 600, this account's. A file holding a real-looking token at mode 644 is refused: one log line, `cleared-v2: the MCP token at <path> can be read by others: chmod 600 it`, no line holds the value, the file and its mode are left as they were, and `POST /mcp` with that value is `503`.
4. **Words.** `http_host` in `src/mcp/messages/lanes.en.json` and `.fr.json`. `v2/README.md` says the `Host` rule and that the token is made before a project is set up.

**Not done.** A MagicDNS name (`<machine>.<tailnet>.ts.net`) is refused: it is a name, and taking names is what the check is against; the install line from another machine uses the tailnet address, as the README already says. #348, #349, #351 and #352 are other lanes'.

**Tests first.** `e51fabe` committed the tests alone. On that code the two `Host` tests fail (`evil.example` and `100.70.0.2` are answered `200`), and the two start tests fail (no file after 5 seconds; nothing said in the log, since the token was never read before a request). The real-socket test passes there, the peer check being already in place; with that check removed it fails (`200` for `403`), and it passes again once restored. The existing Docker-bridge test now goes through the same helper as the new ones and counts the token's reads too. One change after that commit: the start test's service gets the environment `test/main.test.ts` gives its own (the temporary folder as its home, the lead off, no quota reading, no login variable). Without a project nothing of the service reads a login, since the quota reader waits for the flow's engine; this keeps it so.

**Checks** (on `origin/v2` at `291a8e0`, which had not moved when this was written). `npm run typecheck` passes. `npm test`: 2053 Node tests, 1985 pass, 68 skipped (the browser tests, with no `CLEARED_V2_PLAYWRIGHT`), 0 fail; 321 Vitest tests pass. The real-socket test ran here, not skipped. `npm run guard -- --base origin/v2`: nothing refused, in the 699 v2 files and in the lines changed (run without a private-term list, `CLEARED_REPO` unset). No browser test was run: nothing of the app changed.

**The merge of 355** (P220, at `origin/v2` `26822ed`). The log keeps 355's entry, then this one; the matrix keeps 355's P220 line and this lane's addition to P216, every id once. Two places met. First, the flow module's `start`: it makes the token first (this lane), then reads the route's language and cleaner (355), both before the check for an engine. Second, the test helper `direct`: it takes 355's getters for `language` and `redactor`. After the merge: `npm run typecheck` passes; `npm test` runs 2054 Node tests, 1986 pass, 68 skipped (the browser tests), 0 fail, and 321 Vitest tests pass; `npm run guard -- --base origin/v2`: nothing refused, in the 700 v2 files and in the lines changed.

**The merge of 356** (#351 and #352, at `origin/v2` `3ba2799`). The log keeps 356's entry, then this one. The matrix's P216 line keeps both lanes' additions: after the line's own delivery come this lane's 357, then 356, and its proofs name both lanes' tests. Every id is still there once. 356 touches none of this lane's code. After the merge: `npm run typecheck` passes; `npm test` runs 2058 Node tests, 1990 pass, 68 skipped (the browser tests), 0 fail, and 321 Vitest tests pass; `npm run guard -- --base origin/v2`: nothing refused, in the 700 v2 files and in the lines changed.

**The merge of 358** (C11, at `origin/v2` `b095624`). The log keeps 358's entry, then this one. The matrix merged by itself: 358's C11 line, and the P216 line with 357's and 356's additions, every id once. 358 touches none of this lane's files. After the merge `npm run typecheck` passes. The first `npm test` failed one test of 2063: `test/workspace/project-page.test.ts`, "after a merge the page is made again". Its page's modification time moved by about a tenth of a second between two updates of a base that had not moved. Neither that test nor `src/workspace/` is changed by this lane, and run alone three times it passes 12 of 12. Run again in full, `npm test` runs 2063 Node tests, 1993 pass, 70 skipped (the browser tests), 0 fail, and 326 Vitest tests pass. `npm run guard -- --base origin/v2`: nothing refused, in the 703 v2 files and in the lines changed.

**Resources.** No Docker object, no account, no network beyond `npm ci` of the lock file, no tunnel, no secret: the tokens are made at run time; the services listen on port 0 or a free port, on loopback only.

- Pull request: 357, against `v2`.
- Author: Opus 5.5 (claude-opus-5-5), lane `j3-mcp-access-sec`.

## 2026-10-25: the kept JavaScript of v2 converted, `lib/notify/contract.mjs` still an exception (the author's choices, lane `j3-js-convert`, matrix B5.11b)

**The need.** B5.11b was `partial`: kept JavaScript is converted when touched, and entirely before the end of milestone 4, with one logged exception (`lib/notify/contract.mjs`, 2026-10-22, lane `v2-j2-notify`, choice 8). The brief asked to start with that exception if its reason is gone, then convert what is left in the v2 core in one batch, with no change of behaviour. No issue: the line is the brief. The brief pointed at sections 9 and 10 of `milestone-2-plan.md`, which has eight; the conventions followed are those of section 10 of `milestone-1-plan.md` (a lane changes its own files), as the earlier lanes did.

**Decision.**
1. **`lib/notify/contract.mjs` stays `.mjs`: its reason holds.** On `origin/v2` at `b095624`, `git grep -l notify/contract` names four v1 files that import it, `lib/notify.mjs`, `app/main.mjs`, `test/notify.test.mjs` and `test/app-notify.test.mjs`, beside v2's `src/notify/dispatcher.ts` (a comment) and `test/notify/contract.test.ts`. The file itself imports seven v1 modules (`lib/i18n.mjs`, `lib/board-scrub.mjs`, `lib/conf.mjs` and the four adapters under `lib/notify/adapters/`). A `.ts` there means editing those four v1 files, which milestone 4 removes or rewrites. It is converted with them. The same holds for the rest of v1's kept JavaScript, the `keep` and `adapt` rows of [keep-and-drop.md](keep-and-drop.md) under `lib/`, `app/`, `serve/` and `test/`, and `release-request.mjs`: v1 runs and imports it, so B5.11b stays `partial` for milestone 4. This lane's batch is the JavaScript of the v2 core, `v2/`.
2. **The batch: the two v1 oracles of the tests.** `test/approval/oracle.mjs` and `test/store/v1-list.mjs` were the only kept JavaScript of `v2/`. They become `oracle.ts` and `v1-list.ts` (`git mv`, so the history follows), run by Node's type stripping as `test/store/failing-start.ts` already is. Their imports of v1 stay dynamic, each cast to the few members it uses, as `test/notify/contract.test.ts` does; the arguments are read with `as`, as `failing-start.ts` does. Same arguments, same output, same v1 code read. Their three callers (`test/approval/local-store.test.ts`, `test/approval/writer.test.ts`, `test/store/migrations.test.ts`) name the new files. The log's earlier entries keep the old names: they say what was true then.
3. **`app/public/sw.js` and `app/public/theme.js` stay JavaScript, by design.** They are not kept v1 code; they are v2's, served as they are. A browser registers the service worker by its address, before any page code runs, and `theme.js` runs in `<head>` before the bundle so the page never paints in the wrong theme. Each says so in its header. Making them TypeScript needs a build entry of their own, a change of the build and of what is served, which this batch does not make.
4. **A test holds the line.** `test/kept-javascript.test.ts` lists the tracked files of `v2/` (`git ls-files`) and expects exactly those two browser files with a JavaScript extension. A new `.mjs` under `v2/` now fails CI, not a `git grep` at milestone 4.
5. **No user string.** Nothing a person reads changed, so no catalog changed.

**Tests first.** `8c4fbb3` committed the test alone. There it fails: `test/approval/oracle.mjs` and `test/store/v1-list.mjs` are listed beside the two browser files.

**Checks** (on `origin/v2` at `b095624`). `npm run typecheck` passes. `npm test`: 2059 Node tests, 1989 pass, 70 skipped (the browser tests, with no `CLEARED_V2_PLAYWRIGHT`, and the gated real-harness tests), 0 fail; 326 Vitest tests pass. The callers of the two oracles, `test/approval/local-store.test.ts`, `test/approval/writer.test.ts` and `test/store/migrations.test.ts`, pass 32 of 32 with the `.ts` files. No browser test was run: nothing of the app changed. No v1 file changed, so v1's checks were not run. `npm run guard -- --base origin/v2`: nothing refused.

**The merge of 357** (lane `j3-mcp-access-sec`, at `origin/v2` `7304f41`). The log keeps 357's entry, then this one; the matrix merged by itself and keeps every id once. 357 adds no JavaScript under `v2/`. After the merge: `npm run typecheck` passes; `npm test` runs 2064 Node tests, 1994 pass, 70 skipped, 0 fail, and 326 Vitest tests pass; `test/kept-javascript.test.ts` passes; `npm run guard -- --base origin/v2`: nothing refused.

**Resources.** No Docker object, no Claude Code, Slack, Cursor or Codex account, no network beyond `npm ci` of the lock file, `git fetch` and GitHub, no port, no secret.

- Pull request: 359, against `v2`.
- Author: Opus 5.5 (claude-opus-5-5), lane `j3-js-convert`.

## 2026-10-25: the runner reads the user setting source alone, so sessions read the mounted skills (owner decision of 06:06, option A; B5.5b, M7, issue 140)

**Decision.** The runner (`v2/images/session/runner/main.ts`) gives `query()` `settingSources: ['user']`. Claude Code reads the skills mounted from the base branch; the checkout's `CLAUDE.md`, `.claude/settings.json`, `.claude/settings.local.json`, their hooks and the ticket branch's own `.claude/skills` stay unloaded. The briefing is still appended to the system prompt.

**Options weighed.**
- **A, `['user']` alone (taken).** In the container the user source is `CLAUDE_CONFIG_DIR`, the session's config volume, where lane 15 mounts the base branch's `.claude/skills` read only. It is enough for B5.5b and M7, and the repository gets no say over the session: no hook, no permission rule, no instruction file from the checkout.
- **`['user', 'project']`** (issue 140 asked for `['project']`). It would also load the checkout's settings: hooks that run commands outside the policy, permission rules that pass a call without `canUseTool`, and skills the ticket branch itself wrote. A ticket could change the rules of its own session.
- **`[]`** (kept since 2026-10-21). The mounted skills were never read, so B5.5b and M7 stayed `partial`.

**Supersedes** item 10 of the entry of 2026-10-22 on the runner ("It stays `[]`") and the consequence of 2026-10-21 that left the skills' loading unknown. Issue 140's other asks were met by then: the `stop_hook_active` test (`test/runner/hooks.test.ts`) and the commit identity (item 7 of the same entry).

- Decided by the owner, 2026-10-25 06:06.

## 2026-10-25: the v1 passkey code stays until milestone 4 (owner decision, option C; B5.9d)

**Decision.** The v1 passkey code (`app/lib/webauthn.mjs` and the passkey parts of the files the entry of 2026-10-21 lists) stays as it is until the milestone 4 conversion of the v1 app. B5.9d stays `partial`: the v2 app has no passkeys (135), and their removal from v1 comes with that conversion.

**Deferred with it.** The question the entry of 2026-10-21 ("app login by password, no passkeys") left open: what confirms "Clear to land", "Send back" and turning notifications on in v1, which a passkey confirms today. It is settled at milestone 4, with the code.

- Decided by the owner, 2026-10-25.

## 2026-10-25: the user setting source, its tests and what is left to run (the author's choices, lane `j3-skills-user`, B5.5b, M7, issue 140)

**The need.** The two decisions above, applied: `settingSources: ['user']` in the runner, tests that the mounted skills are read and the project's settings and hooks are not, and the matrix lines B5.5b, M7 and B5.9d. The brief pointed at sections 9 and 10 of `milestone-2-plan.md`, which has eight, as earlier lanes noted; the conventions followed are those of section 10 of `milestone-1-plan.md`.

**Decision.**
1. **What `'user'` reads, from the source.** `sdk.d.ts` of `@anthropic-ai/claude-agent-sdk` 0.3.306 (read from the package's tarball, nothing of it run): `'user'` is "Global user settings (`~/.claude/settings.json`)", `'project'` and `'local'` the checkout's two files, and "Must include `'project'` to load CLAUDE.md files". The `skills` option, left unset, "is **not** 'skills off'": the CLI's defaults stand. `system/init` carries `skills: string[]`. In the container, `CLAUDE_CONFIG_DIR` is set by the image and by the runtime to `/var/lib/cleared/claude-config`, the session's volume (`test/container/session-runtime.test.ts` now checks the runtime's), so the host's own settings never enter (the isolation of `docs/adapters.md` holds).
2. **The runner.** One option changed and its comment. The reload after a Take over builds its options from the same function, so a session given back to the runner reads the user source alone again, whatever sources the human's `claude --resume` read.
3. **The config volume is now read.** A `settings.json` written in it would bring hooks and permission rules into the session's next query. An Edit or Write there, or a shell write, is not allowed by any rule of the policy: it goes to the human (`default`, or `shell.compound`), `test/session/policy.test.ts` pins that. A human who answers "always in this project" to that exact write saves a learned rule that allows it for the project's later sessions, as for any path; the test says so too. The residual: a declared command that runs the checkout's scripts (`npm test`) can write there unasked. That command can already run anything in the container, so the user source adds no reach the session did not have; it stays inside the container.
4. **A skill may ask once.** The policy has no rule for the `Skill` tool. If Claude Code asks `canUseTool` for it, as for other tools in `default` mode (not seen in a run), its first use in a project goes to the inbox (`default`), and "always in this project" saves the answer. No rule was added for it: the owner's decision was about the setting sources, not the policy.
5. **The real check, written, not run.** The `claude-code` section of the doctor mounts a skills folder holding `doctor-skill`, plants `checkout-skill` in the checkout's `.claude/skills` and a `SessionStart` and `PreToolUse` hook in the checkout's `.claude/settings.json` that would write a marker, then checks after the first turn that `system/init` lists `doctor-skill`, not `checkout-skill`, and that no marker was written. The marker is the hook's test, not the `hook_*` frames: `sdk.d.ts` says SessionStart hook events are always emitted, and the runner has hooks of its own. It needs the session image built again (the runner is copied into it, the tag follows Claude Code's version and does not change) and the login, so it was not run here. B5.5b and M7 stay `partial` until it passes; "Reste avant v2 -> main" lists them under the real proof now.
6. **Lines.** B5.5b, M7 and B5.9d updated; no new P line, since the two decisions are the owner's and the lines are the brief's.

**Tests first.** `92cbc0b` committed the tests alone. There, three runner tests fail on `[]` (the start's options, the new test of the user source, the reload after a Take over); the policy test passes, as it guards what the change must not open; the doctor change typechecks.

**Checks** (on `origin/v2` at `7304f41`, which had not moved when this was written). `npm run typecheck` passes. `npm test`: 2065 Node tests, 1995 pass, 70 skipped (the browser tests without `CLEARED_V2_PLAYWRIGHT`, and the gated real-harness test), 0 fail; 326 Vitest tests pass. `test/container/session-runtime.test.ts` gained its `CLAUDE_CONFIG_DIR` check after that run and passes 31 of 31 alone. `npm run guard -- --base origin/v2`: nothing refused. No browser test was run: nothing of the app changed. The `claude-code` section of the doctor was not run (item 5).

**The merge of 359** (lane `j3-js-convert`, B5.11b, at `origin/v2` `8807382`). The log keeps 359's entry, then this lane's three. In the matrix, the "Later milestone" list keeps this lane's B5.9d bullet and 359's B5.11b bullet; every id is there once. 359 touches none of this lane's files. After the merge: `npm run typecheck` passes. The first `npm test` failed one test of 2066: `test/flow/one-service.test.ts`, "a ticket of a one-service workspace produces the events…". Neither that test nor `src/flow/` is changed by this lane, and run alone three times it passes. Run again in full, `npm test` runs 2066 Node tests, 1996 pass, 70 skipped, 0 fail, and 326 Vitest tests pass. `npm run guard -- --base origin/v2`: nothing refused.

**Resources.** No Docker object, no Claude Code, Slack, Cursor or Codex account, no login read, no network beyond `npm ci` of the lock file and `npm pack` of the SDK's tarball (read, not run), no tunnel, no port opened, no secret.

- Pull request: 361, against `v2`.
- Author: Opus 5.5 (claude-opus-5-5), lane `j3-skills-user`.

## 2026-10-25: the fast lane's rules on the real diff, and the approval while the checks run (the author's choices, lane `j3-fast-lane`, matrix B2.2)

**The need.** B2.2 was `partial`: pull request 172 gave a Quick ticket the label and the Haiku author (decision 15 of the first plan of milestone 2, pull request 159), and left the real-diff rules and the approval asked while the checks run to milestone 4. No issue: the line is the brief. The brief pointed at sections 9 and 10 of `milestone-2-plan.md`, which the replanned file does not have; they are the first plan's (waves, conventions), read at its merge commit `d30a02b`, and they were followed: a lane changes its own files and appends here.

**Decision.**
1. **v1's rules, as they are.** `lib/fast-lane.mjs` is kept by `keep-and-drop.md`; v2 runs its `decideLane` in a child process (`flow/fast-lane.ts`), with a record that opened fast, so only the settings and the diff decide. `readDiff` is v1's: `git merge-tree --write-tree` into a scratch object folder, three readings that must agree, the content rule on every gained line. `decide` and `demote` are not called: they check the service's Unix account and write v1's lane record and ledger events, which v2 does not keep.
2. **Where and when.** The real effect `fastLane` fetches the session's branch into the service's own checkout as a step's branch is fetched, or takes the head the publish left there, and judges it against `origin/<base>` after a fetch, with the `[fast_lane]` section of the base's `agents.conf`, never the branch's. The engine asks after each author session of a one-service ticket and again at the head it publishes.
3. **Back to the full circuit, for good.** A rule the diff breaks writes a `fast_lanes` row (the flow module's table), a comment on the ticket in v1's words ("Back to the full circuit: a file outside the safe list. ..."), then `fast_lane_fallback` on the bus, which the lead reads with the reasons and the first path that broke each rule. From then on `#authorModel` gives the full author model, after a restart too, and a review that asks for changes is answered by a new author on that model: the Haiku author is not resumed. A ticket sent back is not judged again.
4. **What says nothing of the change.** The fast lane off for the service, settings it cannot read (an unknown key) and a merge git cannot compute (a conflict, two merge bases) are the full circuit at that head only, as v1's `keep: false`: no row, no comment, and the card says "Full circuit for this version" with the reason. The author stays Haiku: decision 15's opening is not changed here.
5. **A question.** A Quick ticket whose author asks the owner a question goes back to the full circuit (reason `asked`, docs/fast-lane.md, "What qualifies"); the question is relayed as any other.
6. **Several services.** A Quick ticket that names several services goes back without a reading (reason `several_services`, v2's own): v1 judges one checkout, and a train's diffs are several. Its train card says so. A ticket that names one service of a workspace of several is judged as a one-service ticket, in that service's checkout, after its author and at the head of its one pull request.
7. **The approval while the checks run.** v2 already does this for every ticket: the review runs before the publish, the approval is asked right after it with the checks `pending`, and the lock's merge waits for them (`queued`). `test/flow/fast-lane.test.ts` proves it for a Quick ticket, and it passed on the code before this lane: it is a proof of the line, not a defect test. The card of a ticket on the fast lane says "Fast lane: approve now, it lands once all checks are green" while they run.
8. **The card.** `ReleaseItem.fastLane` (`api/types.ts`: `fast`, `full` or `off`, with `FAST_REASONS`) is drawn as a fact of the release card, "Lane", in English and French; the reasons are v1's words (`lib/i18n`, `app_srv_fast_reason_*`), the path never. A ticket without the label has no fact. Captures at the four widths, light and dark, and in French at 1440 and 390, the card on the fast lane and sent back, are in `docs/v2/fast-lane/`; they were taken on the fixtures source with the release answered in the page with a lane, on ports 0 of loopback.
9. **Not carried over, and why.**
   - merge-pr.sh spares a fast merge the unrelated checks only from v1's lane record in the lock's state; v2 does not write it, so a fast ticket's merge waits as any. Writing the lock's state from the service is a change of the lock, not of this line.
   - v1's light reviewer: decision 15 keeps the full circuit's review, so a demotion at the published head, after the review, needs no new review.
   - v1's targeted tests and its one capture: the v2 reviewer runs `[session] test_command`, and the proof receipt takes the captures.
   - Who set the label: decision 15 makes the owner's plan approval the owner's mark, and O12's skill ticket is the service's by the owner's decision.
   - O12's skill ticket writes under `.claude/`, which v1 never takes: on a service whose `[fast_lane]` is on, it goes back to the full circuit after its Haiku author's first session; elsewhere its card reads "off". No exception was added; widening the fast lane is the owner's call.
   - The examples' `agents.conf` have no `[fast_lane]` section, so their Quick tickets read "off". They were not edited: they are their own repositories, and the proof does not need a fast landing.
   - v1's `ticket_measured` by lane; a variant is judged at its published head only.
   - An author turn that ends with no commit is v1's `empty`, kept: the ticket goes back for good. A turn that ends with a session plan waiting for its Go does not reach the rules (`#gateHolds` returns first).

**Tests first.** `c49d338` committed the tests alone. There, every test of `test/flow/fast-lane-effect.test.ts` fails (no `fastLane` effect), and so do seven of the nine of `test/flow/fast-lane.test.ts` and the new bus test of `test/flow/events.test.ts`; the approval test and the unlabelled ticket's pass, as said above. In `app/web/test/inbox/fast-lane.test.tsx` the two tests that look for the fact fail; the reasons' words and "no lane, no fact" pass there, since nothing is drawn. Found in the final review: a one-service ticket of a workspace of several publishes through the train's path, which judged no head, so its card read "off"; the last test of `test/flow/fast-lane.test.ts` was written first and failed on that code (one reading instead of two), then the train's path judged the head of its one pull request. Also changed after that commit: the French lines of the Vitest file take the catalog's non-breaking space before the colon, and "contrôles" for the checks, as the rest of the card says.

**Checks.** `npm run typecheck` passes. `npm test`: 2075 Node tests, 2005 pass, 70 skipped (`CLEARED_V2_PLAYWRIGHT` and `CLEARED_V2_REAL_HARNESS` unset), 0 fail; 330 Vitest tests pass. With `CLEARED_V2_PLAYWRIGHT`, the four browser files of the inbox pass 20 of 20. The merge of 357 (lane `j3-mcp-access-sec`) went in by itself; after it `npm run typecheck` passes and `npm test` runs 2080 Node tests, 2010 pass, 70 skipped, 0 fail, and 330 Vitest tests pass; after the fix of the final review, 2081 Node tests, 2011 pass, 70 skipped, 0 fail, and 330 Vitest tests pass. `npm run guard -- --base origin/v2`: nothing refused.

**The merge of 359** (lane `j3-js-convert`, at `origin/v2` `8807382`). The log keeps 359's entry, then this one; in the matrix's section "Reste avant v2 -> main", the milestone 4 line keeps B5.9d and D17 with this lane's note and 359's B5.11b line, every id once. After the merge: `npm run typecheck` passes; `npm test` runs 2082 Node tests, 2012 pass, 70 skipped, 0 fail, and 330 Vitest tests pass; `npm run guard -- --base origin/v2`: nothing refused.

**The merge of 361** (lane `j3-skills-user`, at `origin/v2` `daf39b9`). The log keeps 361's three entries, then this one; in the matrix's section "Reste avant v2 -> main", the milestone 4 line keeps 361's note on B5.9d and this lane's on B2.2, every id once. After the merge: `npm run typecheck` passes; `npm test` runs 2084 Node tests, 2014 pass, 70 skipped, 0 fail, and 330 Vitest tests pass; `npm run guard -- --base origin/v2`: nothing refused.

**Resources.** No Docker object, no Claude Code, Slack, Cursor or Codex account, no network beyond `npm ci` of the lock file, no tunnel, no secret; git runs on temporary repositories; the app and the browser listen on port 0 on loopback.

- Pull request: 362, against `v2`.
- Author: Opus 5.5 (claude-opus-5-5), lane `j3-fast-lane`.

## 2026-10-25: v2 tracks and writes no bash script, and its core starts no shell on the host (the author's choices, lane `j3-no-bash-core`, matrix D11)

**The need.** D11, the owner's decision of 2026-10-21 ("Node for the whole core, no bash"), was `partial` with "CI" as its proof, which rule 4 of the matrix does not accept. The lane finds the bash scripts and the shell calls of `v2/`, moves them to Node, adds a test that keeps them out, and leaves v1's scripts to milestone 4. No issue was opened for it: the line is the brief, as for B5.11b. The brief pointed at sections 9 and 10 of `milestone-2-plan.md`, which has eight, as earlier lanes noted; the conventions followed are those of section 10 of `milestone-1-plan.md` (one doctor, a lane changes its own files).

**What was found** (at `origin/v2` `daf39b9`). `v2/` tracks no `.sh` file and no file with a shell shebang. Four places still wrote a shell script or started a shell on the host:
- `test/approval/harness.ts`: the fake `gh` and `docker` the lock's v1 scripts call in the approval tests were bash scripts, the only bash in `v2/`.
- `scripts/proof-rehearsal.ts` and `scripts/proof-rehearsal-multi.ts`: the `gh`, `docker` and `sendmail` stand-ins were `sh` scripts.
- `scripts/doctor.ts`: the example's seed ran `sh -c 'git archive … | tar -x …'`.
- `src/container/docker.ts`: util-linux's `script` runs the web terminal's docker client with `$SHELL -c`, `$SHELL` set to `/bin/sh`.

**Decision.**
1. **The definition.** "Bash" is what `keep-and-drop.md` calls it: a file that starts with a bash shebang. The test, `test/no-bash.test.ts`, checks three rules: `v2/` tracks no shell script (by extension or shebang); no tracked file of `v2/`, its tests included, writes a bash script or runs `bash` on the host; and the core (every `.ts` and `.tsx` file outside `test/` and `fixtures/`: the service, the app, the scripts, the images) starts no shell on the host. That means no shell as the program of a call, no `shell:` option, no `exec` or `execSync`, no shell given as `$SHELL` and no shell script written. Its patterns are built in pieces so that it does not match itself. A policy test's command, such as `'bash -lc …'`, is a string, not a call, and does not match.
2. **The four places, in Node.** The fake `gh` and `docker` are Node scripts with Node as their interpreter (`#!` and `process.execPath`). For the eight inputs tried, the fake `gh` gives the same output, byte for byte, as the bash one, and writes the same `pr-merged` file. The rehearsal's `gh` and `docker` stand-ins are written by `writeNodeStub`. Node is their interpreter, and they import the rehearsal script in the same process, with the words placed in `process.argv` first, because Linux gives a shebang a single argument. The pid, the input and the exit code are the script's, as with the `exec` of the old stand-ins, so a `SIGKILL` of the docker client still ends the stand-in (a Node parent around a child would have left the child holding the pipes). `sendmail` is `writeSendmailStub`, with the same dated line. The doctor's seed runs `git archive` and then `tar -x`, the archive passed as input. The doctor needs Docker and a login, so it was not run. Instead, the old pipeline and the new calls each extracted `examples/guestbook` and `examples/filter-api` into the scratch folder, and `diff -r` found the two trees identical (50 files).
3. **The exceptions, named in the test or here.**
   - **`script`.** util-linux's `script` (2.41) runs its `--command` with `$SHELL -c` and offers no other way. `docker exec --tty` needs a terminal on the client side, and Node has no terminal to give without a native module. Docker's API over the socket would end decision 3 of milestone 1 ("the `docker` CLI only"). It stays `sh`, not bash, in that file only. The test lists that file and that rule.
   - **What runs inside a session's container.** This is the project's image, not the core: the harnesses' launchers (`session/adapters/claude-code/interactive.ts`, `codex/interactive.ts`), the terminal's wrapper and its end (`terminal/container.ts`), and the doctor's probes. Each is an array given to `docker exec`, not a call on the host. The wrapper's `exec "$@"` gives the harness the pid the terminal writes down and ends, and Node has no `exec`. The human's shell in the container, `bash -l`, is a feature of the product (decision 32 of milestone 2).
   - The tests' own `sh` stand-ins for `claude`, `codex` and `cursor`, and the hooks and scripts they write into a checkout, stay. They are `sh`, not bash. The first group stands in for programs those launchers run, and the second is a project's content that the tests check is never run.
4. **What is left: milestone 4.** v1's 39 `.sh` files. Among them, `merge-pr.sh` and `ask-validation.sh` are still reached from v2, through the v1 release broker (`serve/release-broker.mjs`), by every release request: `src/flow/effects.ts` through `release-request.mjs`, `src/approval/broker.ts` and `src/release/lock.ts` through its socket. The approval tests drive the same scripts (`test/approval/harness.ts`). They move to Node with the guarded merge and the request for agreement (the entry of 2026-10-21), so D11 stays `partial`. "Reste avant v2 -> main" lists it under the later milestone, as B5.11b is.
5. **Lines.** D11 updated. No new P line, since the decision is the owner's and the line is the brief's. No user string changed, so no catalog changed.

**Tests first.** `0125d50` committed the tests alone. There, `test/no-bash.test.ts` fails on the four files of the first three places above: the approval harness, the two rehearsal scripts and the doctor. `docker.ts` passes, as the exception of item 3. `test/scripts/proof-rehearsal.test.ts` fails to load, since `writeNodeStub` and `writeSendmailStub` do not exist yet.

**Checks** (on `origin/v2` at `daf39b9`, which had not moved when this was written). `npm run typecheck` passes. `npm test`: 2071 Node tests, 2001 pass, 70 skipped (the browser tests without `CLEARED_V2_PLAYWRIGHT`, and the gated real-harness test), 0 fail; 326 Vitest tests pass. The approval and release-broker tests, which run the v1 lock's scripts against the Node fake `gh`, pass 71 of 71 with `test/no-bash.test.ts`. A `gh` stand-in written by `writeGhStub` answered `gh pr list` from a forge file and refused `gh api user`, as before. A `docker` stand-in of the multi-service rehearsal, written by `writeNodeStub`, refused `docker version` with its own message and exit code 1, as before. Nothing in `scripts/` or `test/` finds a stand-in by its `/proc/<pid>/cmdline`, where `docker-stub` and `gh-stub` no longer appear. `npm run guard -- --base origin/v2`: nothing refused. No browser test was run: nothing of the app changed. The doctor was not run (item 2). No v1 file changed, so v1's checks were not run.

**The merge of 362** (lane `j3-fast-lane`, B2.2, at `origin/v2` `2a8e785`). The log keeps 362's entry, then this lane's. The matrix merged by itself: the "Later milestone" list keeps 362's B5.9d and D17 bullet and this lane's D11 bullet, and every id is there once (321 rows). 362 starts no child process in `v2/`. After the merge: `npm run typecheck` passes; `npm test` runs 2089 Node tests, 2019 pass, 70 skipped, 0 fail, and 330 Vitest tests pass; `test/no-bash.test.ts` passes; `npm run guard -- --base origin/v2`: nothing refused.

**Resources.** No Docker object, no Claude Code, Slack, Cursor or Codex account, no login read, no network beyond `npm ci` of the lock file, `git fetch` and GitHub, no tunnel, no port opened, no secret.

- Pull request: 364, against `v2`.
- Author: Opus 5.5 (claude-opus-5-5), lane `j3-no-bash-core`.

## 2026-10-25: the project page written again over a base that had not moved (the author's choices, lane `j3-flaky-page`, matrix P103, issue #360)

**The need.** Issue #360: during a full `npm test`, `test/workspace/project-page.test.ts` saw the page's modification time move by about 130 ms between two updates of a base that had not moved (the tests "a fetch that finds the base unmoved" and "after a merge the page is made again"; the merge of 358 in lane `j3-mcp-access-sec` logged one). Run alone, the file passed. The issue asks for the cause, either a real rewrite or a fragile test, and a check that does not rest on time. The brief pointed at sections 9 and 10 of `milestone-2-plan.md`, which has eight; the conventions followed are those of section 10 of `milestone-1-plan.md` (a lane changes its own files), as the earlier lanes did.

**The cause: a real rewrite.** `store` writes the page beside itself and renames it over the old one, and nothing else touches the file, so a moved modification time is a write. `updateProjectPage` skips the write when the page names the base's tip (`` at `<the sha's first 12 characters>` ``). But the page's header went through the cleaner with the rest of the page, and the cleaner's phone number pattern (`0`, a digit from 1 to 9, then eight digits) matches inside a sha whose first 12 characters start with ten such digits followed by a letter. Such a page reads `` at `[removed: phone number]` `` followed by the last two characters, never names its base, and is made again, identical, at every fetch. Of 200,000 random short shas, 157 (0.08 %) are cut this way; two checks of the file are exposed, so about one full run in 600 fails. Two other paths could also write an unchanged page: `baseSha` turns any git failure into `null` (a spawn that fails under load), and `readProjectPage` turns any read error into "no page". A temporary probe logged every write of the page with its reason over 72 parallel runs of the file and three full runs of `npm test`. It found no write over an unmoved base, so neither path was seen. The phone shape is the cause the code and the new test show.

**Decision.**
1. **The header is not cleaned.** The service's name and the base's name go through `field`, as the page's other fields do. The sha's 12 characters come from git and are added after the cleaning, so the page always names its base.
2. **The tip is read once.** `generateProjectPage` takes the sha `updateProjectPage` read, so the check and the header cannot disagree.
3. **An unchanged page is not written.** When the check does not find the base in the page, the page is made again and written only if its text differs. Whatever made the check miss, a base that did not move rewrites nothing.
4. **Only a missing page counts as none.** The update reads the page itself: `ENOENT` means no page; any other error is thrown, the caller logs it, and nothing is written over a page that could not be read. `readProjectPage`, which the briefing uses, is unchanged.
5. **The test checks writes, not time.** Its two modification-time checks become the page's inode and `updateProjectPage`'s answer, `false`. Each write renames a new file over the page while the old one still exists, so a write always changes the inode, and nothing else does. No delay was raised.
6. **No user string.** The page is in English for the sessions, as before. Nothing a person reads in the app changed, so no catalog changed.

**Tests first.** `2ef6409` committed the tests alone. On the old code the new test fails twice. Its page reads `[removed: phone number]` where the sha should be; with that check set aside, a fetch over the unmoved base gives the page a new inode. Its merge is made on purpose, so the test is not a lottery: the dates are fixed, the test computes the commit's sha for `Add call.js 0`, `1`, ... until the cleaner cuts its 12 characters, then makes it with `git commit-tree` and checks the two shas are equal.

**Checks** (on `origin/v2` at `8807382`). `npm run typecheck` passes. `npm test` three times in a row: each time 2065 Node tests, 1995 pass, 70 skipped (the browser tests and the gated real-harness tests), 0 fail, and 326 Vitest tests pass. `test/workspace/project-page.test.ts`, run 72 times in parallel in batches of 24, passes 13 of 13 each time. `npm run guard -- --base origin/v2`: nothing refused.

**Another flaky test, left as it is.** One of the probe's full runs (before the fix) failed in `test/mcp/followups.test.ts`, "the server process whose client closed its stdout exits with 0". The failure is `EPIPE` in the test's own write to the child's stdin, after the child had exited. This lane does not touch it.

**The merge of 361** (lane `j3-skills-user`, at `origin/v2` `daf39b9`). The log keeps 361's entries, then this one. The matrix merged by itself, and every id is still there once. 361 touches neither `src/workspace/` nor the page's test. After the merge: `npm run typecheck` passes. `npm test` three times in a row: each time 2067 Node tests, 1997 pass, 70 skipped, 0 fail, and 326 Vitest tests pass. `npm run guard -- --base origin/v2`: nothing refused.

**The merge of 362** (lane `j3-fast-lane`, at `origin/v2` `2a8e785`). The log keeps 362's entry, then this one. The matrix merged by itself, and every id is still there once. 362 touches neither `src/workspace/` nor the page's test. After the merge `npm run typecheck` passes. Of the first three `npm test` runs, the second failed one test of 2085: `test/session/claude-code/adapter.test.ts`, "a runner that dies is a RUN_ERROR". It found no `runner_exit` event after a fixed 20 ms wait (`settle`), a timing flake in that test; no lane of this merge changes that file, and this lane leaves it as it is. Three runs in a row after it: each time 2085 Node tests, 2015 pass, 70 skipped, 0 fail, and 330 Vitest tests pass. `npm run guard -- --base origin/v2`: nothing refused.

**The merge of 364** (lane `j3-no-bash-core`, at `origin/v2` `d66b5d0`), merged into `v2` while 362's merge was being checked. The log keeps 364's entry, then this one. The matrix merged by itself, and every id is still there once. 364 touches neither `src/workspace/` nor the page's test. After the merge: `npm run typecheck` passes. `npm test` three times in a row: each time 2090 Node tests, 2020 pass, 70 skipped, 0 fail, and 330 Vitest tests pass. `npm run guard -- --base origin/v2`: nothing refused.

**Resources.** No Docker object, no Slack, Cursor or Codex account, no network beyond `npm ci` of the lock file, `git fetch` and GitHub, no port, no secret.

- Pull request: 363, against `v2`.
- Author: Opus 5.5 (claude-opus-5-5), lane `j3-flaky-page`.

## 2026-10-25: the v2 docs say where tonight's features are, and the words of every catalog are checked (the author's choices, lane `j3-docs-slop`, matrix P221)

**The need.** The ten ideas of the owner's decision of 01:09 (P210 to P219), the fast lane (B2.2) and the skills' setting source (B5.5b) were merged tonight, each with its matrix line and its log entry, but a developer who opens `v2/README.md` found only four of them (the chat, the harness pick, the lanes' MCP server and, in one settings row, the receipt). The pass also reads every user string, in French and in English, for filler, dashes used as pauses and durations a person cannot read. No behaviour change. No issue: the line is the brief. The brief pointed at sections 9 and 10 of `milestone-2-plan.md`, which has eight, as earlier lanes noted; the conventions followed are those of section 10 of `milestone-1-plan.md` (a lane changes its own files and appends here).

**Decision.**
1. **Where the docs go.** `v2/README.md` is where a developer looks first, so each feature has a short section there that names the file holding it: The flow, On a phone (under The app), The proof receipt, The cost of a ticket, Ticket templates, Code questions and their links, After a release: the production page, The fast lane, The prompt cache, Skills. The chat, the harness pick and the lanes' MCP server already had theirs. `docs/fast-lane.md`, v1's page, gains "In Cleared v2": what v2 keeps, where the rules run, the reasons it adds (`asked`, `several_services`) and what it leaves out. `docs/adapters.md` already held the harness pick, the prompt cache and the user setting source, and was not changed. `docs/configuration.md` already held `[release] production_url`; the README links to it. Each fact was read in `src/` before it was written, not copied from the matrix: two rows were corrected that way before the commit (past the review rounds the ticket goes back to Todo; a question past its wait goes to the lead first), and, after the pull request opened, four more: a Quick ticket's author stays the configured one when the reviewer is Haiku or a service is `sensitivity = full` (`engine.ts` `#authorModel`); with `[fast_lane]` off the ticket takes the full circuit; the service does not check that `CLEARED_V2_REVIEWER_MODEL` differs from the author's; the receipt's tests also say a run in a pipe. The README's first paragraph no longer calls the folder a skeleton.
2. **The flow's settings.** Fourteen answers in 13 files of `src/` and the lanes' MCP catalog say "the flow is not configured: see CLEARED_V2_PROJECT in v2/README.md", and the README did not name it. "The flow" lists the variables a developer sets to run tickets, read in `src/flow/config.ts` and `src/workspace/config.ts`: the one-service variables, `CLEARED_V2_WORKSPACE`, the state and work folders, the models, the review rounds, the idle stop and the question's wait. The README still does not list every `CLEARED_V2_*` the code reads (28 were missing at `d66b5d0`, among them the lead's, the budgets and the fake adapter's); the test checks the pointers only, so the rest is not a gap this lane closes.
3. **The words.** `test/wording.test.ts` reads the 22 catalogs of `app/` and `src/` (2830 strings), the chat's, the receipt's and the two MCP servers' included, which `app/test/shell/tokens.test.ts` did not read. It refuses emoji, exclamation marks, em dashes, a dash used as a pause, a list of filler words in each language, and a duration in milliseconds or a placeholder named in seconds. The French typography rules stay where they are (each catalog's own test). Nothing in the catalogs needed changing: the scan's other hits were loading states and placeholders ending in "…", "just now", the shell's own `{n} s`, the 60-second grace countdown and Markdown list items in the templates, all kept.
4. **The one raw duration.** `src/container/session-runtime.ts` said "postgres did not become ready within 60000 ms", and the engine writes that message into the ticket's comment ("The flow could not start: ..."). It now says "within 60 seconds", as the flow's other waits do (`src/flow/effects.ts`). The engine's ticket comments are English only, as before; moving them to catalogs is a change of the engine, not of this pass.

**Tests first.** `1cf3998` committed `test/docs.test.ts` and `test/wording.test.ts` alone. There, three of the five docs tests fail: no section for nine of the features, `CLEARED_V2_PROJECT` not in the README, no v2 section in `docs/fast-lane.md`. The adapters test and the no-em-dash test pass, and so do both wording tests: they guard, they do not fix. `eb9a836` committed the readiness test alone, and it failed on that code ("0 ms"). Its pattern was anchored on the message while `assert.rejects` matches the error's string ("RuntimeError: ..."), so the anchor was moved in the next commit; the old code fails that pattern too.

**Checks** (on `origin/v2` at `d66b5d0`, which had not moved when this was written). `npm run typecheck` passes. `npm test`: 2096 Node tests, 2026 pass, 70 skipped (`CLEARED_V2_PLAYWRIGHT` and `CLEARED_V2_REAL_HARNESS` unset), 0 fail; 330 Vitest tests pass. The i18n tests are among them (`app/test/catalog.test.ts`, `app/test/french-typography.test.ts`, `app/web/test/i18n.test.tsx`, each server's catalog test). `npm run guard -- --base origin/v2`: nothing refused. No browser test was run: no page and no sheet changed.

**The merge of 363** (lane `j3-flaky-page`, P103, at `origin/v2` `ac24420`), after review round 2. The log keeps 363's entry, then this one; the matrix merged by itself, every id once. The review also found "within 1 seconds": the readiness wait now says "second" for one, as the engine's "review round" does. `4df76e5` committed its test alone (`test/container/session-runtime.test.ts`, a wait of one second), which failed on that code. After the merge and the fix: `npm run typecheck` passes; `npm test` runs 2098 Node tests, 2028 pass, 70 skipped, 0 fail, and 330 Vitest tests pass; `npm run guard -- --base origin/v2`: nothing refused.

**Resources.** No Docker object, no Claude Code, Slack, Cursor or Codex account, no login read, no network beyond `git fetch` and GitHub, no tunnel, no port opened, no secret.

- Pull request: 365, against `v2`.
- Author: Opus 5.5 (claude-opus-5-5), lane `j3-docs-slop`.

## 2026-10-25: the polish pass over the screens of the ten ideas (the author's choices, lane `j3-ui-polish`, P222)

**The need.** No issue: the brief named `ui-overhaul-plan.md` section 5, item 3 (the art director's fresh look), and asked for Impeccable's critique and polish on the screens the ten ideas added tonight (the proof receipt, the ticket cost, the templates, the question from the Plan tab, the phone inbox, the harness stats, the production check), fixed in one pull request with before and after captures and no new feature, before `v2` goes to `main`.

**Read.** `milestone-2-plan.md` has no sections 9 and 10, as earlier lanes noted. Read in their place: `milestone-1-plan.md` sections 9 and 10 (a lane edits its screen, its catalogs and its tests) and `ui-overhaul-plan.md` sections 9 and 10 (its "a mobile application" out of scope is a native application). The matrix had no line for this pass: P222 is new. P222 was free when the lane began, then pull request 365 (lane `j3-docs-slop`) took it, so this lane moved to P222.

**Impeccable.** 4.7.0 in the lane's worktree, out of git (the anchored patterns were already in the shared exclude file); the installer's hooks file was removed before any edit; `DO_NOT_TRACK=1`; no live server, no listener. `critique`, two isolated assessments: the design review (Opus 5.5, on the forty before captures and the code) scored 26 of 40; the detector found nothing on the five screen files, with regex rules only (the rules that need a parsed page did not run, and no page was opened for it). `polish` was applied through the fixes below, on the screens' existing tokens and components: no new token, no orphaned style left.

**Decision.**
1. **A Done ticket speaks of a finished ticket.** Its right column says "No file changed." and "No check reported." ("Aucun fichier modifié.", "Aucune vérification annoncée."; keys `changes_none_done`, `checks_none_done`) and draws no "Screen so far" card, which could only say it had no picture. A ticket still running keeps "yet" and the card.
2. **The question card says nothing twice.** Its label is read out (`sr-only`), not drawn under the card's title; `plan_ask_opens` ("The answer opens on its own page…") is removed from both catalogs; the scope is one sentence: "Reads the base branch of guestbook, without this session's changes, and never edits the code." ("Lit la branche de base de guestbook, sans les changements de cette session, et ne modifie jamais le code."). Ask still answers an empty question with "Write the question first.", as lane `j3-plan-ask`'s browser test pins.
3. **The agent pick's words.** "Cheapest" ("la moins coûteuse") was not the rule `flow/harness-pick.ts` applies: the subtitle and the inbox's rule now say "the fewest tokens, or in the shortest time when tokens are not reported". English says "agent pick", as the table's title and every French sentence say "agent", not "harness pick"; "Waiting for a lane" is "Waiting for a free slot" ("En attente d'une place libre"); French "Rien de commité" is "Aucun commit".
4. **French Consumption says "jetons"**, as the session, the inbox, the questions and the receipt do (`consumption_usage_unit`, `consumption_day_usage`). No decision recorded "tokens" there: the commit that wrote it renamed the keys for the secrets guard and kept the value.
5. **The wins table on a phone.** The headers are "Type" (not "Ticket type", which took three lines in French at 390) and keep one line; French agrees with "variantes" ("Lancées", "Gardées") and says "Réussies" for the green runs; the last column has no trailing padding and the columns sit 6 pixels apart under 480, so the table fits its panel at 375 and 390 in both languages (in French at 375 its narrowest width is 297 pixels of 307).
6. **The templates.** The title's placeholders are short ("What breaks", "Ce qui casse"…): "Ce qui casse, en quelques mots" was cut by New ticket at 390. The row of templates no longer starts with the word "Template", which the chip above it already says.
7. **A release with no picture at all** says "No picture of this screen." ("Pas d'image de cet écran.") once, under the section's title, with no empty frame and no Computer/Phone switch; one picture on either side keeps the two frames. On a phone this brings the facts above the buttons.
8. **The receipt.** No capture is "Captures: none taken" ("Captures : aucune"): the engine leaves the list empty for any reason, so the old "(the flow has no browser…)" guessed. The figures' source is "the agents", as on the ticket card, not "the harness". From the art director: "{parts} kept by Cleared, without a link" and "ran inside a larger command, so its result is unknown".
9. **Consumption's words** (the art director's pass): the per-day average has its unit ("210.3M tokens per day on average", "210,3 M jetons par jour en moyenne"); the footer no longer says "ledger" or "harness" ("Figures come from this project's sessions. When an agent reports both windows, the seven-day one is shown."); the levers' "One click each." is gone ("A change applies to what starts next."); the model lever, on Default, says "Default model: Opus 5.5", not "Configured model"; the sessions lever says "Set by each plan" ("Fixée par chaque plan"), not "As each plan says".
10. **Durations.** Every duration on these screens already goes through `lib/time.ts` (`lasted`, `duration`), in the page's language; the shell's format ("3d 12h", "1 h 04") is not changed here.
11. **Not taken, logged.** The composer, Hand over and Interrupt on a Done session (a change of behaviour); "Close" read as "close this panel" (the form it opens says "Close the ticket"); disabling Ask on an empty question (a pinned behaviour); one money format (P211 keeps four decimals under a dollar on purpose); the ticket card's tokens beside the session's (different scopes, no label); the plan-ask fixtures' session with no service (the card says "every service"); the bottom bar's "Consommation", which the mobile lane noted as a few pixels too wide (it fits its slot here at 375 and 390: each slot grows to its label; the test written for it passed on the old code and was dropped).

**Tests first.** `d02771a` adds five named captures to `scripts/capture-screens.ts` (consumption, tower-template, resolved, plan-ask, inbox-release) and the before set. `ae54daf` commits the tests alone: in `app/web/test/ui-polish.test.tsx`, seven of eight fail on that code (the eighth, a running ticket keeps its "yet", guards the other side); both tests of `test/flow/receipt-words.test.ts` fail; in `app/test/polish/phone-fit-browser.test.ts` the eight tests fail (each header on one line, each placeholder whole, at 375 and 390, in both languages). The art director's first item (below) added an assertion to that file, that the table fits its panel, which failed on `b5ecebc` at 375 in English and at 375 and 390 in French. The file is in the CI's `browser` job list; it waits for the page's fonts before it measures, and measures the table at its narrowest width (`min-content`), not the 100 % it stretches to. `06f5921` commits the test of Consumption's words alone: it failed on that code at its first assertion, in English (the average's unit). Assertions of earlier tests changed with the words, not as defect tests: `consumption-wins.test.tsx`, `inbox/harness-pick.test.tsx`, `inbox/render.test.tsx`, `session/plan-ask.test.tsx`, `tower-templates.test.tsx`, `i18n-audit.test.tsx` (`consumption_wins_type` joins the words both languages share, `consumption_usage_unit` leaves them), `app/test/session/plan-ask.test.ts`, `plan-ask-browser.test.ts`, `tower-templates-browser.test.ts`, `consumption/wins-browser.test.ts`, `test/flow/receipt.test.ts`.

**Captures.** On the fixtures source with the repository's script, ports 0 on loopback, no page error and no request off the app's origins: before in `docs/v2/ui-polish/before/`, after in `docs/v2/ui-polish/after/`, at 1440, 1280, 768 and 390, light and dark, in English, and at 1440 and 390 in French. The proof receipt is Markdown with no screen; its words are covered by the receipt tests.

**Art-director pass** (Sonnet 5.5 in a fresh agent, on the after captures and the code, Impeccable's critique and polish read by itself). Taken before the merge: the French wins table hid its last column behind a scroll at 390 (made wider by this lane's one-line headers; item 5), the question card's scope sentence (item 2), the receipt's `receipt_kept` and `receipt_run_unclear` (item 8), and Consumption's five wording items (item 9). Not taken: French "reset" (about eight keys of O15's projections and three tests, a vocabulary of its own); the steps' "waits for 1" (lane 27's step lines, which need a plural key); the placeholder's `service:path:line` (the syntax the question's parser reads to pick the service). Its "Signed in as owner" is a false positive: "owner" is the fixtures' sign-in name (the capture script's account), not a role code. Logged too: the Tower bar's actions hidden at 390, raw model ids in the Tower's rows, the charts' day letters, the Done session's composer.

**Checks.** `npm run typecheck` passes. `npm test`: 2094 Node tests, 2016 pass, 78 skipped (`CLEARED_V2_PLAYWRIGHT` and `CLEARED_V2_REAL_HARNESS` unset), 0 fail; 338 Vitest tests pass. One earlier full run failed `test/mcp/followups.test.ts`'s closed-stdout test, the race earlier lanes logged; run alone it passed two times of three, and this lane does not touch it. The CI's `browser` list, this lane's file added (21 files), with `CLEARED_V2_PLAYWRIGHT`: 62 of 64. The screen-switch budget failed under the load of 21 files at once and passed twice alone (a p95 of 31.9 and 35.9 ms). `app/test/notify/browser.test.ts` times out on this host, and does the same on an untouched `origin/v2` (`2a8e785`) built in a temporary worktree: it is not this lane's, and its CI run decides. The browser files of these screens after the art director's pass: 18 of 18. `npm run guard -- --base origin/v2`: nothing refused (run without a private-term list, `CLEARED_REPO` unset).

**The merge of 363 and 364** (lanes `j3-flaky-page` and `j3-no-bash-core`, at `origin/v2` `ac24420`). The log keeps their entries, then this one; the matrix merged by itself, every id once. After the merge: `npm run typecheck` passes; `npm test` runs 2100 Node tests, 2022 pass, 78 skipped, 0 fail, and 338 Vitest tests pass; `npm run guard -- --base origin/v2`: nothing refused.

**After the art director's Consumption items** (and the 6-pixel gap): `npm run typecheck` passes; `npm test` runs 2100 Node tests, 2022 pass, 78 skipped, 0 fail, and 339 Vitest tests pass; the browser files of Consumption and `phone-fit-browser.test.ts`: 14 of 14; the root tests that read the docs or the workflows (`ci-triggers`, `neutral-project`, `fast-lane`, `merge`): 101 of 101; `npm run guard -- --base origin/v2`: nothing refused; the diff holds no person's or project's name (a grep, the guard having no private-term list).

**The merge of 365** (lane `j3-docs-slop`, at `origin/v2` `6c9600d`). The log keeps 365's entry, then this one; the matrix keeps 365's P221, then this lane's P222, every id once. After the merge: `npm run typecheck` passes; `npm test` runs 2108 Node tests, 2030 pass, 78 skipped, 0 fail, and 339 Vitest tests pass; 365's `test/wording.test.ts` and `test/docs.test.ts` pass with this lane's catalogs; `phone-fit-browser.test.ts`: 8 of 8; `npm run guard -- --base origin/v2`: nothing refused.

**Resources.** No Docker object, no Claude Code, Slack, Cursor or Codex account, no network beyond `npm ci` of the lock file and Impeccable's install, no tunnel, no secret; the app and the browser listen on port 0 on loopback.

- Pull request: 366, against `v2`.
- Author: Opus 5.5 (claude-opus-5-5), lane `j3-ui-polish`.

## 2026-10-25: the polish captures are compressed before v2 goes to main

The 120 PNG captures of `docs/v2/ui-polish/` (P222, 366) weighed 11.3 MB. They were compressed once, on a workstation, with `pngquant --quality=80-95 --skip-if-larger --force --ext .png` then `optipng -o2` on each file (system tools; no script is committed, since `v2/` tracks no shell script): 11,267,957 bytes before, 4,003,907 after (-64 %). Lossless alone (`optipng -o2`) gave 9.3 MB (-18 %); the quantized captures read the same for UI review. No code changes; the history keeps the old files (no rewrite, no force push), so only checkouts get lighter. Future captures can go through the same two commands before they are committed.

- Pull request: against `v2`, branch `amdiakhate/j3-png`.
- Author: the night driver, approved by the product owner on 2026-10-25.

## 2026-10-25: a milestone 3 report for the product owner

`docs/v2/milestone-3-report.md`, in French, next to the plans of milestones 1 and 2: what the ten ideas (P210 to P219) and the passes after them (P221, P222, B2.2, B5.5b, issues #347 to #353 and #360) bring, how each change is checked, what keeps running, and what waits for the owner (the open or partial lines B6.1q, B5.10g, D21, D13, B5.1c, O6, P69, B6.3p, P71, B3.10, P7, P47, P51). It adds no matrix line: it is a summary of lines already there, and three lanes were picking the next free ids at the time. Every id it cites was checked against the matrix; the test counts come from the last checks in this log (2108 Node, 339 Vitest, 0 fail). The 4.0 MB of the captures is the size after PR 369.

- Pull request: 370, against `v2`.
- Author: the night driver.

## 2026-10-25: a screen switch does only the work of drawing the next screen, and the budget is measured alone (the author's choices, lane `j3-tab-perf`, P223, issue #367)

**The need.** Pull request 366 saw `app/test/foundation/budget-browser.test.ts` fail in a full run of the browser job's files, which run in parallel, and pass alone at 31.9 and 35.9 ms. The brief asks for a reproducible measure of the p95 under load first, the real causes (renders, redundant reads, heavy work at the switch), fixes with no new feature and no visible change, and a budget test that does not flake. No issue existed: #367 was opened for this lane. The brief pointed at sections 9 and 10 of `milestone-2-plan.md`, which has eight; the conventions followed are those of section 10 of `milestone-1-plan.md` (a lane changes its own files), as the earlier lanes did.

**What was measured, on `origin/v2` at `ac24420`.**
- The failure, reproduced: in a run of the twenty files of the CI's browser list in parallel, the budget's p95 was 127.7 ms; alone, 26.7 and 27.7 ms.
- The load, reproduced: Chromium's own CPU throttling, four times, once the screens were drawn, gives the same numbers (122.6 and 147.2 ms alone). `CLEARED_V2_BUDGET_SLOWDOWN=4` now does it in the test.
- A CPU profile and a timeline trace of the switches, slowed four times, and counters installed in the page over a lap of the budget's fourteen switches (`LAP_TWO`, twice): which components each React commit draws again, the Intl formatters built, the permission reads, the reads of the service, and each forced layout with the function that forced it.

**The causes found.**
1. **Intl formatters built at every number.** `lib/time.ts` and the translator's `format` built an `Intl.NumberFormat` for each number said: 472 in one lap, 118 at each visit of the Lead. The Lead's thread built a date formatter for each line (`toLocaleDateString`).
2. **The page laid out twice in one frame.** The shell gave the window its scroll back (`useScrollKept`, which forces a layout) before it turned the next screen's sheets on, and the Lead's thread measured its height before them too (a child's layout effects run before the shell's). The sheets then changed every style, and the browser laid the page out again before painting. 4 of the lap's 14 scrolls happened with the previous screen's sheets on.
3. **A Lead visit asked the inbox again.** The Lead's stream says the lead's state again each time the screen opens it, and the screen asked the shell to recount the inbox for any state with a waiting question, so each visit read `/inbox` and drew the shell and the kept sessions again. The thread was also drawn again for each frame of that replay and for the same trains (10 React commits for a Lead visit).
4. **The sidebar's bell read the notification permission at every draw**, a call into the browser, and the sidebar draws at every switch (16 reads in the lap).
5. **A screen drawn again drew itself twice**: once from what it kept, then again when its first read of the cache brought the same values in a new object (the inbox's list was also copied at each read). And every refetch told the screens that read the resource, even when the service answered what the cache held, as the ten-second poll of the resources the change stream does not cover does.
6. **A screen's catalog over the shell's** was spread again at each switch, hundreds of keys.

**Decision.**
1. **One formatter per language and options**, kept for the page's life (`numberFormat` in `lib/i18n.ts`, used by `lib/time.ts` and the translator; the word for yesterday; the Lead's day and month through a kept `Intl.DateTimeFormat`, which says what `toLocaleDateString` said). The same text: `app/test/time.test.ts` and the new tests read it.
2. **One layout per switch.** The next screen's sheets go on in an insertion effect, before any layout effect, the screens' own included; the shell focuses the screen and writes the screen's name into the live region (through a ref, so the shell does not draw again for it); the scroll is given back last.
3. **The Lead's stream tells only what is new.** `frameChanges` drops a frame that changes nothing the screen holds, `inboxNews` asks the inbox again only for a question the screen did not hold or a plan proposed or moved, the same trains draw nothing, and the thread scrolls to its end on a new line only, not when the agent's thread replaces the kept one.
4. **The bell reads the browser once per answer of the service.** The permission changes only through the bell's own gesture, which reads again.
5. **The same values draw nothing.** `useKept` keeps what it holds when the new value has the same fields (`sameFields`); the inbox's `known` returns the list itself when every item is known; the cache tells no reader when a refetch answers what it held (the query client keeps the held value, its structural sharing).
6. **Catalogs made once** per screen and language.
7. **The budget is measured alone in CI.** The browser job runs the other files in parallel, then the budget's file alone, and adds its TAP to the same file, so the summary keeps its measures and the job's counts cover both. The budget itself is unchanged: 100 ms, from the click to the painted screen, the median of three runs' p95.
8. **Not done.** Keeping every screen mounted, as the sessions are, would remove most of what is left, but it changes how the screens live (the Lead's stream and timers while hidden, the ids); not a lane for a polish. Consumption, outside the budget's lap, still builds its formatters as it did.

**Tests first.** `c0e373b` and `3fc0ce3` hold the tests alone. On the old code: `switch-work-browser.test.ts` (in the CI's browser list) counts 472 formatters, 16 permission reads, 2 reads of the inbox from the Lead and 4 scrolls on the previous screen's sheets, where it wants none; `switch-work.test.ts` fails on the formatters built again, on `inboxNews` and `frameChanges`, which do not exist, and on a refetch of an unchanged resource telling its reader; `web/test/switch-work.test.tsx` fails on the catalogs made again, on `sameFields`, which does not exist, and on the inbox's list copied. `CLEARED_V2_BUDGET_SLOWDOWN=4` fails the budget at 122.6 and 147.2 ms.

**Measures**, on this lane's host, shared with other lanes (load average from 2 to 25 during the runs), so each before and after was run alternately, the old build served from a copy of its `dist/`:

| | Before (`ac24420`) | After |
| --- | --- | --- |
| p95 of 40 switches, 8 alternate pairs, median of the pairs | 29.9 ms (26.8 to 37.7) | 19.5 ms (17.6 to 20.7) |
| Median switch, same runs | 18.9 ms | 13.4 ms |
| The same with the CPU slowed four times: p95 | 130.3 ms (122.0 to 348.1) | 104.5 ms (87.8 to 265.9) |
| The same: median switch | 71.2 ms | 61.6 ms |
| The budget test, `CI=true`, the median of three runs' p95 | 39.5, 29.9, 39.6 ms | 26.8 ms, then 71.2 and 62.4 ms during a load average of 13.7 |
| The budget test slowed four times, `CI=true` | 154.3, 115.1, 145.6 ms (fails) | 94.4, 102.3, 90.7 ms (fails once) |
| The main thread's busy time per switch (CPU profile, not slowed) | 30 to 32 ms | 20 to 21 ms |
| React commits in a lap of seven switches | 35 (10 for the Lead) | 23 (6 for the Lead) |
| Style and layout passes per switch | 2 (the forced one, then the sheets') | 1 |

With the CPU slowed four times the budget is at its edge: what is left is the next screen's own style, layout and render, about a third of it the one layout. The parallel run is the reason for the CI's separate step: with the fixes, the twenty files in one parallel run still put the budget at 85.9, 128.5, 86.8, 116.0, 155.2 and 91.9 ms, failing three times in six while other lanes loaded the host; the CI's two commands replayed here three times gave 56 of 56 tests in the parallel part and the budget alone at 28.0, 27.5 and 29.5 ms (`CI=true`, load average 3 to 18).

**No visible change.** `scripts/capture-screens.ts --via click` on the old and the new build: the tower, the inbox, the sessions, a session and the Lead at 1440 and 390, light and dark, in English, and light in French, 30 captures, 29 identical to the byte; the 30th (the French tower at 1440) differs by 4 bytes and is drawn the same, and the new build gives one or the other of the two files from one capture to the next.

**Checks** (on `origin/v2` at `ac24420`). `npm run typecheck` passes. `npm test`: 2096 Node tests, 2025 pass, 71 skipped (the browser tests and the gated real-harness tests), 0 fail; 333 Vitest tests pass. The CI's browser step replayed three times: every test passes. `npm run guard -- --base origin/v2`: nothing refused.

**The merge of 365 and 366** (lanes `j3-docs-slop` and `j3-ui-polish`, at `origin/v2` `c41101e`). The log keeps their entries, then this one; the matrix keeps P221 and P222, then P223, every id once; the browser list keeps 366's `phone-fit-browser.test.ts` beside this lane's file, the budget still alone after them. Neither lane touches the files this lane changed in `app/web/lib`, the shell or the Lead. After the merge: `npm run typecheck` passes; `npm test`: 2114 Node tests, 2035 pass, 79 skipped, 0 fail, and 342 Vitest tests pass. The CI's browser step replayed three times, during a load average of 23 to 40 from other lanes: the budget alone at 29.8, 47.3 and 26.3 ms, and 64 of 64, 63 of 64 and 64 of 64 in the parallel part; the one failure is `app/test/session/production-browser.test.ts` waiting more than 30 seconds for its card, which passes alone twice. `npm run guard -- --base origin/v2`: nothing refused.

**The merge of 369 and 370** (the compressed captures and the milestone 3 report, at `origin/v2` `dbaeb4d`). The log keeps their entries, then this one. They change images and docs only, none of this lane's files. After the merge: `test/docs.test.ts`, `test/wording.test.ts` and the root tests that read the workflow pass; `npm run guard -- --base origin/v2`: nothing refused.

**Resources.** No Docker object, no Slack, Cursor or Codex account, no network beyond `npm ci` of the lock file, `git fetch` and GitHub, no port but the tests' loopback port 0, no secret.

- Pull request: 372, against `v2`.
- Author: Opus 5.5 (claude-opus-5-5), lane `j3-tab-perf`.

## 2026-10-25: the tests CI saw unstable, their causes, and tests on the error paths the coverage found unrun (the author's choices, lane `j3-test-gaps`, P225)

**The need.** No issue: the brief is the line. Measure the coverage of v2 without a new dependency, name the critical modules little covered (the engine, the fast lane, the harness pick, the receipt, the session runtime), add useful tests on their error paths and limits, and make stable the two tests CI saw unstable: `test/scripts/rehearsal-adapter.test.ts` (the lead's turn) and `app/test/inbox/mobile-browser.test.ts` (Go in French at 375 px, "Traité."), the real cause first. While the lane ran, the owner added two more seen on pull requests with no code: `app/test/consumption/wins-browser.test.ts`, "in French the panel is French, and holds on a phone" (no horizontal scroll, run 40176736780), and the Go test in English (pull request 370). No change of the product's behaviour. `milestone-2-plan.md` has no sections 9 and 10, as earlier lanes noted; the conventions followed are those of section 10 of `milestone-1-plan.md` (a lane changes its own files and appends here). P223 is lane `j3-tab-perf`'s (pull request 372) and P224 lane `j3-a11y`'s; this lane takes the next, P225.

**The Go on a phone: the cause.** The failed runs of the CI's `browser` job (40156763968 and the first attempt of 40172850057 in French; the first attempts of 40158528194 and of 40177143932, pull request 370's, in English) read "Traité." ("Handled.") where the test expects "Go donné à … L'auteur commence à écrire.". A tap on Go writes through the page's cache, which moves the session plan to what was handled at once (`app/web/lib/cache.ts`, `optimistic`), without its Go, which only the service's answer carries. While the write is on its way the item is `busy`, and `Actions` (`app/web/screens/inbox/Inbox.tsx`, the `item.state === 'handled'` branch) has no `busy` case for a session plan, so the detail draws `handled_note`; the Go's own line comes when the answer lands. The test waited for the first `.d-done` and read it. A probe that read the detail every 50 ms after the tap, the Go's answer held 400 ms by Playwright's `page.route`, saw "Traité." for 350 ms in French and 300 ms in English, then the Go's line.

**The lead's turn: the cause.** The failed `verify` job (the first attempt of run 40172850057) says the session has no pending request by the id the test answered, an id ending `[removed: phone number]e-turn-1-1`. The rehearsal adapter named its lead's question `<session id>-turn-<n>-<m>`. The cleaner keeps an identifier whole only when it has a generated shape (`GENERATED_ID`: a UUID, or `prefix_xxx`, fixed for the same reason in `38484f0`), so it read this one as text, and the session id's last group held ten digits from `01`, a French phone number's shape. The question was stored under the cleaned id, the test answered that id, and the fake adapter, which waits under the raw one, refused it. The real runner names its requests with `randomUUID` (`images/session/runner/main.ts`, `newId`), so only the rehearsal was exposed, there and in the proof rehearsals that answer a lead's question from the inbox. Lane `j3-flaky-page` found the same pattern cutting a sha (P103).

**The Consumption panel on a phone: the cause.** The test opens the screen at 1440 pixels, then sets the viewport to 390 and checks at once that the page has no horizontal scroll; run 40176736780 found one. In 20 switches between 1440 and 390 in one page, a check at each animation frame found the page 486 pixels wide at 390 in about 4 of them (12 frames recorded, at most three kept per switch), with every element's box inside the screen. The overflow was the content of `#notify-summary`, the shell's bell: 44 pixels wide, 148 pixels of content. The style moves to the phone's layout as soon as the width changes (`app/web/styles/app.css`, `@media (max-width: 767px)`), which puts the bell at the right end of the bottom bar. The sidebar's mode, `.app[data-sidebar]`, is React's (`app/web/shell/App.tsx`, `useBand`), and changes only on the media query's `change` event and the render after it. Until then it still says `open` (or `rail` from 1280), and with it the rule that gives each sidebar button its tooltip, an `::after` with `opacity: 0` placed 12 pixels to the right of the button: the bell's, now at the screen's edge, widens the page. The fonts were ruled out first: Geist was loaded before the panel showed, Geist Mono is not used on this screen, and the panel fits with the fonts blocked. The English test's check at 390, coming from the rail, has the same exposure.

**Decision.**
1. **The phone test waits for the Go's line.** `page.locator('#detail .d-done').filter({ hasText: words.go }).waitFor()`, then the same exact match. The Go's answer stays held 400 ms in the test, so the window CI fell into is open at every run, not only on a slow runner. The test does not assert the "Traité." in between: that would pin it.
2. **The screen is not changed.** A `busy` case in `Actions`, as `PermissionAnswers` has one, would hide "Traité." during a Go; it changes what a person sees, which the brief rules out. Logged here for the next interface lane.
3. **The Consumption panel is measured once the sidebar follows the width.** Each resize waits for `.app[data-sidebar]` to say the mode `sidebarMode` gives that width (`app/web/shell/model.ts`), then measures. The test holds the page's answer to its media queries 500 ms (an init script delays each `change` listener), so the moment CI fell into is there at every run. The tooltip of that moment is left as it is: a person does not move from a computer's width to a phone's in one step, and a rule that hides the tooltips under 768 pixels is a change of the style, which the brief rules out. Logged here for the next interface lane. No other browser test resizes and then measures the page's width; the phone tests open at their width.
4. **The rehearsal lead names its ids with UUIDs.** Each turn's `runId` and each act's id (a question's `requestId`, a host call's `toolCallId`, a reply's `messageId`) is `randomUUID()`, as the real runner's are. The cleaner is unchanged: it is the secrets guard, and widening what it lets through whole is not this lane's. The ids the fake adapter derives itself (`<session>-user-<n>`, `<call>-result`) are left: nothing looks them up by their raw value, and a cleaning changes them all alike.
5. **The coverage, with Node alone.** `node --test --experimental-test-coverage --test-coverage-include='src/**'` with the `lcov` reporter, over the suite `npm test` runs (Node 24.21.0). Vitest's coverage needs `@vitest/coverage-v8`, which is not installed; it was not added, and the Vitest side was not measured. The five modules are the service's, under `src/`, which only the Node suite runs. A script in the lane's scratch folder summed the lcov; none is committed.
6. **What was little covered.** Lines are not where the gaps are (97.8 % of `src/`); branches are. Before, then after this lane's tests:
   - `src/flow/engine.ts`: lines 97.0 % (3560 of 3671), branches 85.9 % (1438 of 1675), functions 88.0 %; after, 97.3 % (3571), 86.1 % (1456 of 1691), 88.3 %.
   - `src/flow/fast-lane.ts`: branches 84.1 % (37 of 44); after, 95.6 % (43 of 45).
   - `src/flow/harness-pick.ts`: branches 94.6 % (53 of 56); after, 100 % (59 of 59).
   - `src/flow/receipt.ts`: branches 90.0 % (45 of 50); after, 100 % (54 of 54).
   - `src/container/session-runtime.ts`: lines 97.8 %, branches 94.9 % (149 of 157), functions 96.8 %; after, 98.5 %, 96.3 % (158 of 164), 100 %.
   - All of `src/`: lines 97.8 %, branches 89.1 %, functions 92.1 %; after, 97.9 %, 89.3 %, 92.2 %. V8 counts the branches of a block once it runs, so a total can grow with the tests.
7. **The tests added.** `test/flow/engine-errors.test.ts`: checks the forge cannot say leave the card pending, are logged with the error's name and not its message (what the message carries does not reach the log), and are asked again a minute later, not before; a lock that throws is asked again after the retry delay, the ticket left in Ready to Ship and not put back; an author handover that cannot be stored is said on the ticket, cleaned, and the review still runs; a variant whose checkout cannot be made fails alone, said on the ticket and cleaned, and the other goes on. `test/flow/fast-lane.test.ts`: the lane's row (a head kept without its figures, a demotion once and for good, nothing after it brings the ticket back) and the card's lane (a demotion wins over any head, no verdict is `unreadable`, a verdict that says nothing of the change is `off`). `test/flow/harness-pick.test.ts`: zero tokens is no report, so the time decides; at the same time the tokens break the tie, an unreported count last; then the position; a ledger from before the pick counts no win. `test/flow/receipt.test.ts`: a link address that is no URL links nothing, a figure of a dollar or more has two decimals in both languages, a video of unknown length, an empty body, a start marker with no end. `test/container/session-runtime.test.ts`: a base layer that fails to build makes the sibling a fake, or, with no contract, stops the start before any object of the session exists; a ticket layer that fails with no contract runs the base layer; a base image with no absolute working folder gets no ticket layer; a sibling that stops while awaited is reported at once, not at the end of the minute.
8. **Not covered, named.** The engine's handover test reaches the catch of a ticket without steps (`engine.ts` line 2566); the catch of a ticket in steps (line 1320) stays unrun, as do the failures of Take over, Give back and Hand over (lines 3536 to 3643), which need a session taken over. `judgeDiff`'s answer that is not JSON needs `lib/fast-lane.mjs` to print something else, and the session runtime's rethrows of an error that is not Docker's need a Docker wrapper that throws something else; neither was forced.

**Tests first.** `832e810` holds the phone test with the Go's answer held 400 ms and the old wait: both languages fail every run, "Traité." and "Handled.". `46ef4a8` holds the rehearsal test alone: on the old ids it fails at the first id (`<session>-turn-1-1` does not match `GENERATED_ID`). `e065805` holds the Consumption test with the media queries answered 500 ms late and the old check: both of its tests fail every run, at 390 in English and on the phone in French. The coverage tests guard rather than fix: each passes on the code as it is, and no file of `src/` changed for them.

**Checks** (on `origin/v2` at `c41101e`). `npm run typecheck` passes. `npm test` five times over the lane, the last two on its final code: each time 2123 Node tests, 2045 pass, 78 skipped (`CLEARED_V2_PLAYWRIGHT` and `CLEARED_V2_REAL_HARNESS` unset), 0 fail, and 339 Vitest tests pass. The suite under coverage: 2123 tests, 0 fail. `test/scripts/` and `test/session/` together: 359 of 359. The CI's `browser` list (21 files) with `CLEARED_V2_PLAYWRIGHT`, three times, the host's load average up to 61 from other lanes: 61, 62 and 62 of 64. What failed was never this lane's: `app/test/notify/browser.test.ts` timed out each time, as lane `j3-ui-polish` found it does on an untouched `origin/v2` on this host; the screen-switch budget twice (issue #367, lane `j3-tab-perf`); `choices-browser` (a 30-second wait) and `stack-browser` (`ERR_NETWORK_CHANGED`) once, then 2 of 2 and 3 of 3 alone. `mobile-browser.test.ts` passed 8 of 8 in six runs at once and in four more under a load of 61, and `wins-browser.test.ts` 2 of 2 in four runs at once, each with its delay kept. `npm run guard -- --base origin/v2`: nothing refused (run without a private-term list, `CLEARED_REPO` unset). Its first run refused three lines of the new tests, a token-shaped string and the CI's session id quoted in a comment, which `c6d0185` replaced.

**The merge of 369 and 370** (lanes `j3-png` and `j3-m3-report`, at `origin/v2` `dbaeb4d`). The log keeps their entries, then this one; the matrix merged by itself, every id once. Neither touches `v2/`. After the merge: `npm run typecheck` passes; `npm test` runs 2123 Node tests, 2045 pass, 78 skipped, 0 fail, and 339 Vitest tests pass; `npm run guard -- --base origin/v2`: nothing refused.

**The merge of 372** (lane `j3-tab-perf`, P223, at `origin/v2` `6d7097f`). The log keeps 372's entry, then this one; the matrix keeps P223, then this lane's P225, every id once. 372 changes the shell (`App.tsx`, `NotifyButton.tsx`) and the cache's subscribers, but neither the sidebar's mode (`useBand`), nor the tooltips' rule, nor the Go's optimistic move, so the three causes above stand. After the merge: `npm run typecheck` passes; `npm test` runs 2129 Node tests, 2050 pass, 79 skipped, 0 fail, and 342 Vitest tests pass; this lane's six Node test files, 93 of 93; with `CLEARED_V2_PLAYWRIGHT`, `mobile-browser` 8 of 8, `wins-browser` 2 of 2, 372's `switch-work-browser` 1 of 1 and `budget-browser` alone 1 of 1, `phone-fit-browser` 8 of 8; `npm run guard -- --base origin/v2`: nothing refused.

**Resources.** No Docker object, no Claude Code, Slack, Cursor or Codex account, no login read, no network beyond `npm ci` of the lock file, `git fetch` and GitHub (the CI's logs read with `gh`), no tunnel, no secret; the app and the browser listen on port 0 on loopback.

- Pull request: 373, against `v2`.
- Author: Opus 5.5 (claude-opus-5-5), lane `j3-test-gaps`.

## 2026-10-25: the app against WCAG 2.2 AA, checked by axe in a real browser (the author's choices, lane `j3-a11y`, matrix P224)

**The need.** The lane's brief: an audit with tools of v2's main screens, light and dark, in French and in English, at 390 and 1440 px, on the fixtures, and the real defects fixed (accessible names, contrast, visible focus and keyboard order, the roles of the tabs and the dialogs, live announcements), with no new feature and no visual redesign. No issue: the line is the brief (issue #367 is lane `j3-tab-perf`'s). The id: P222 is lane `j3-ui-polish`'s (366), and `j3-tab-perf` had claimed none when this lane started, so P223 was left to it (it took it, pull request 372) and this lane takes P224; lane `j3-test-gaps` took P225 (373). The brief pointed at sections 9 and 10 of `milestone-2-plan.md`, which has eight, as earlier lanes noted; the conventions followed are those of section 10 of `milestone-1-plan.md` (a lane changes its own files and appends here).

**Decision.**
1. **The tool.** The brief said axe was already there beside Playwright; only Playwright was. `axe-core` 4.14.0 is added as an exact-version dev dependency: MPL-2.0, no dependency of its own, no install script, published on 2026-10-05, twenty days before this lane (lane 30's rule asks for 15). The test reads `axe.min.js` and evaluates it in the page through the browser's protocol: the app's policy refuses an inline script.
2. **What the test checks.** `app/test/a11y-browser.test.ts`, in the CI's `browser` job. For each language, a server on the fixtures source with the resolved story, on port 0 on loopback; for each theme and width, a new browser context, and the page's `lang` and `data-theme` checked before each run. Twelve places: the sign-in page, the tower, the command menu, the inbox with a release open, the sessions, a session and its Plan tab, a resolved ticket's session, the plans, the consumption, a question to the code, and the account menu; 96 runs in all. A place is checked once drawn: its element there, no `aria-busy`, the fonts loaded, no animation running. The rules: every rule axe tags WCAG 2.0, 2.1 or 2.2, A or AA (64 rules, the same list a run by those tags picks, which was checked), and four best practices: a dialog has a name, a page has an h1, all content is in landmarks, no two landmarks share a name. No rule is turned off.
3. **Label in name (WCAG 2.5.3): six controls left to their own names.** axe compares a control's accessible name with all the text inside it, glued together ("SearchCtrlK", "Oowner", "Approve the release3f9c2a1"). Six controls have their label in their name and other text beside it, and the test names them for that rule only: the tower's rows and the sessions index's rows, named by their title and described by their kind, their line and their meta (a choice `app/web/test/tower/rows.test.tsx` and `app/web/test/session/render.test.tsx` already pin); the search button, with its shortcut's keys; the account button, with its avatar's letter; Approve, with the short commit under its words (the full commit is in its name, pinned by `app/web/test/inbox/render.test.tsx`). A person who speaks the visible label reaches each of them. The rule runs on every other control.
4. **What axe found, and the fixes.**
   - WCAG 1.4.1: the inbox's link to the pull request, in its facts line, was told from the words around it by its colour alone (1.55:1 against them in light, 1.27:1 in dark, under 3:1). A link inside a line of text is now underlined: that one, a train stop's, and the tower's recipe note's. It is the lane's one visual change (`docs/v2/a11y/`, before on the left).
   - The account menu (Radix's popover, a dialog) had no name. It is named by its first line, "Signed in as ...".
   - The top bar was outside every landmark. It is the page's `header`, its banner.
   - The sidebar's live sessions were a `section` named "Live sessions", as the tower's block is, so two regions had that name. They are a group inside the sidebar's own landmark.
   - The inbox had no h1. Lane 37 removed its drawn heading, which repeated the top bar, and two tests pinned no h1 at all; the sessions index and the session have since kept that rule as "read out, not drawn", with an `sr-only` h1. The inbox now has one, "Inbox" or "Réception" (`screen_title` in its two catalogs), and the two assertions say so (`app/web/test/inbox/render.test.tsx`, `app/test/inbox/inbox-browser.test.ts`).
   - axe once reported low contrast in the command menu (2.02:1). It had measured the dialog while it faded in; once the animation is over, it finds nothing, and the test now waits for it.
5. **What axe does not see, read in the page.**
   - The keyboard. Tab through each screen, at both widths and in both themes: every stop draws its ring (`:focus-visible`, 2 px, the accent colour), and none is hidden, under the phone's bar included. The ring's contrast is 5.31:1 or more in light and 6.96:1 or more in dark, against the canvas, the sidebar, the surface and the sunken background, over the 3:1 of WCAG 1.4.11. The session's tabs already follow the tabs pattern (arrow keys, Home and End, one tab stop, `aria-controls` and `tabpanel`). The command menu, the shortcuts sheet and the account menu keep the focus inside and give it back to their button on Escape.
   - A defect: a two-step gesture lost the focus. The button pressed is drawn away with its step, and the focus fell to the page's body. Measured on `origin/v2`: Close on the session's page and in the inbox (when the reason's field opens, and again once the ticket is closed), and the inbox's Send back and its Keep. Now, on the session's page, Close moves the focus to the reason, Keep back to Close, and the outcome's line takes it once closed. In the inbox, a gesture made in the detail moves the focus once its step is drawn: to the field it opens, else back to the button that opened the step it leaves, else to the first button, else to the detail; Change, Undo and the contract's Send back follow the same rule, which the browser test does not drive. The inbox's live line, which said only a permission's answer, now says each gesture's outcome, from one function (`doneLine`, `screens/inbox/model.ts`) that the detail's line uses too.
   - Live lines. A question's line for an answer too long and a plan panel's line under its buttons were drawn only with their message, which not every screen reader says; the session's plan line was hidden with `display: none` while empty, out of the readers' tree. They are in the page from the start, empty, and an empty one is hidden without leaving it (`app.css`).
6. **Not changed.** The six controls of item 3; the rows stay named by their title. No colour changed: no contrast violation in the 96 runs.

**Tests first.** `3f1789d1` committed axe-core, `app/test/a11y-browser.test.ts`, `app/web/test/a11y-live.test.tsx` and the browser job's entry alone. There, the four browser tests fail (the faults of item 4 in both languages; the focus on the body after Close), and so do the two Vitest tests (no empty status line). The fixes' commit also made the test's two axe passes one, with the same rules, and the keyboard test then gained Send back.

**Visual check.** The main screens (8 places, 2 languages, 2 themes, at 1440, 1280, 768 and 390 px: 128 full-page captures) were taken from `origin/v2` and from this branch, on the fixtures, and compared pixel by pixel. The differences: the underline under the pull request's link; age labels that turned an hour between the two runs ("4d 1h", then "4d 2h"); and up to 25 pixels on the sidebar's icons and the account button's avatar in some captures (the rail at 1280 and 768 included, where the sidebar's sessions are hidden), which look the same side by side. No art-director pass: the one visual change is that underline, and the captures are not committed beyond its before and after in `docs/v2/a11y/`.

**Checks** (after merging `origin/v2` at `dbaeb4d`, pull requests 369 and 370, no conflict). `npm run typecheck` passes. `npm test`: 2112 Node tests, 2030 pass, 82 skipped (`CLEARED_V2_PLAYWRIGHT` and `CLEARED_V2_REAL_HARNESS` unset), 0 fail; 341 Vitest tests pass, the i18n tests among them (`app/test/catalog.test.ts`, `test/wording.test.ts`). `app/test/a11y-browser.test.ts` alone: 4 of 4, in 55 to 70 s. `npm run guard -- --base origin/v2`: nothing refused.

**The browser job's load.** Measured before 372 merged, when the budget test still ran beside the others: on this server, shared with other work (load average from 16 to 49), the job's 22 files gave 67 of 68, the budget failing (p95 286 ms, 528 ms in an earlier run), and the same files without this one 63 of 64, the budget failing too (p95 212 ms). Since 372 the budget runs alone once the others have ended; this file joins the parallel list beside 372's `switch-work-browser.test.ts`, and is its longest, about a minute.

**The merge of 372** (lane `j3-tab-perf`, P223, issue #367, at `origin/v2` `6d7097f`). The log keeps 372's entry, then this one; the matrix keeps P223, then P224, every id once. `.github/workflows/v2.yml`: 372's two runs (the parallel list, then the budget alone) with `app/test/a11y-browser.test.ts` added to the list. `app/web/shell/App.tsx`: this lane's `header` around the top bar, with 372's `#screen-said` written through its ref. After the merge: `npm run typecheck` passes; 344 Vitest tests pass; the docs, wording, catalog, French typography, switch-work, inbox and shell Node tests, 109 pass, 25 skipped (`CLEARED_V2_PLAYWRIGHT` unset there), 0 fail; with Chromium, `a11y-browser`, `inbox-browser`, `mobile-browser`, `close-browser`, `shell-browser`, `switch-work-browser` and `i18n-browser`, 30 of 30; the budget alone, p95 27.3 ms.

**The merge of 373** (lane `j3-test-gaps`, P225, at `origin/v2` `819ce38`). The log keeps 373's entry, then this one; the matrix keeps P224, then P225, every id once; no code conflict. After the merge: `npm run typecheck` passes; 344 Vitest tests pass; the docs, wording and catalog tests, 373's flow, container and rehearsal tests and the inbox's Node tests, 165 pass, 20 skipped (`CLEARED_V2_PLAYWRIGHT` unset there), 0 fail; with Chromium, `a11y-browser`, `mobile-browser`, `wins-browser` and `inbox-browser`, 20 of 20.

**Resources.** No Docker object, no Claude Code, Slack, Cursor or Codex account, no login read; the app on port 0 on loopback; no network beyond `git fetch`, GitHub and npm's registry for axe-core; no tunnel, no secret.

- Pull request: 374, against `v2`.
- Author: Opus 5.5 (claude-opus-5-5), lane `j3-a11y`.

## 2026-10-25: the proof receipt takes captures only when a screen changed, and the human can force them from the ticket (the author's choices, lane `j3-capture-detect`, P226, issue #368)

**The need.** Issue #368, after P210 (pull request 338): captures before and after only when the diff changes something a person sees (components, styles, displayed words and their catalogs, page routes, templates), none for a change of the backend alone, of tests, of CI or of docs. The receipt says why in one line, in the project's language ("No screen changed" / "Aucun écran modifié", or the screens touched), and the human forces captures on or off from the ticket. The brief pointed at sections 9 and 10 of `milestone-2-plan.md`, which has eight, as earlier lanes noted; the conventions followed are those of section 10 of `milestone-1-plan.md` (a lane changes its own files and appends here). P226 is the next free id: P224 is pull request 374's, P225 is on `v2`, and the `j3-visual-redesign` lane writes P227.

**Decision.**
1. **The rule is a pure function of the diff's paths** (`src/flow/capture-need.ts`, `captureNeed(paths, choice)`). Visible: components and markup by extension (`.tsx`, `.jsx`, `.vue`, `.svelte`, `.html`, templates), styles, the assets and fonts a page draws, catalogs (`.po`, `.ftl`, or a data file in a `messages`, `locales`, `i18n`... folder), code files in `screens`, `pages`, `routes`, `views`, `layouts`, `components` or `templates` folders, and a file named for what it draws (`page`, `layout`, `view`, `template`, so the guestbook's `src/page.ts`, the page P210 captures, counts). Not visible, whatever the extension: tests (`test/`, `*.test.*`, `*.spec.*`, stories, snapshots, fixtures), CI (`.github/`, `.gitlab-ci.yml`...), docs (`docs/`, `*.md`), an `api` folder and a server's own file in a routes folder (`+page.server.ts`). Everything else is the backend. What a path cannot say (a page rendered by a file not named for it) is the human's to force on, and the README says so.
2. **The screens are named, not guessed.** The folder under `screens/`, the page a `pages/` or `routes/` file is, a catalog's screen (`session.fr.json` is the session screen's words), else the file's own name, each once, in the diff's order. The receipt shows five, then how many more, so the reason stays one line.
3. **The human's choice wins, both ways; an unread diff is captured.** On takes the captures whatever the change, Off takes none whatever the change. A diff that cannot be read is captured and says so: a capture too many costs a minute of a browser, a missing one loses the proof. The read's error is never journaled, only the code `unread`.
4. **The decision is taken before any browser starts**, in `#captureProof`, for a one-service author and for each service step alike. The engine asks a new optional effect, `changedPaths` (`flow/effects.ts`): the author's branch fetched into the service's own checkout as a step's branch is, into a ref of its own (`refs/cleared/proof/<service>/<branch>`), committed paths only (publish refuses a branch with no commit of its own, so the authors commit), a folder service's in its folder. No git runs in the session's checkout. Without the effect (the tests' fakes), every author is captured as before and the receipt has no reason, so P210's receipts read as they did.
5. **Journaled on the capture's event.** `cleared.proof_captured` gains an optional `need` (`take`, `reason`, `screens`); a skipped capture is journaled with no file and no missing part. No new custom name.
6. **The choice is kept by ticket in the ledger, not on the tracker's ticket.** The ticket store has no field a ticket can change after it is created (labels are set at creation), and adding one would reopen lane 1's contract and every store. So a row of `capture_choices` (ticket, project, choice, who, when), the flow module's table, as the fast lane keeps its row; a ticket with no row is on Auto. `GET /api/tickets/:id/captures` answers the choice; `POST` takes `{ choice: 'auto' | 'on' | 'off' }` from a signed-in person only (the editor's save's check, `humanUser`), 404 for a ticket the store does not know. It counts from the next author that ends its work: captures already taken stay.
7. **The switch is on the ticket card**, the session screen's left column, under the ticket's facts: "Before and after captures" / "Captures avant et après", then Auto, On, Off (Auto, Oui, Non) drawn with the Editor's diff and file switch's existing classes (`.mode.scope`), and one line that says what the pressed one does. The sheets are left to the `j3-visual-redesign` lane, which redraws `session.css` and `app.css` (pull request 377): one scoped rule only, for the touch target (below). Not drawn before the choice is read, nor on a ticket that is Done or Ready to Ship, nor for an answer that is not a choice. The choice is read once with the view and set by its own save. A failed save says so under the switch and keeps the old choice pressed. "Auto" joins the words French spells as English in `app/web/test/i18n-audit.test.tsx`.

**Tests first.** `4722a0b` committed the tests alone, on `origin/v2` at `819ce38`. On that code `test/flow/capture-need.test.ts` and `test/flow/capture-detect.test.ts` cannot load (`capture-need.ts` and `capture-choice.ts` do not exist); the receipt has no reason (six of seven tests of `test/flow/receipt-need.test.ts` fail, the seventh guards a capture journaled before the rule); both tests of `test/flow/capture-paths.test.ts` fail (`changedPaths` is not an effect); the routes and the switch are absent (three of four tests of `app/web/test/session/capture-choice.test.tsx` fail, the fourth, nothing drawn before the choice is read, guards the other side). `test/api/types.test.ts` (68 routes) and `test/flow/modules.test.ts` (42 routes, the new table) were amended with them, since they pin those lists. The browser test, `app/test/session/capture-choice-browser.test.ts`, was written after the code, to take the card's captures and to prove the click, the save and the reload in Chromium; it is in the CI's `browser` job list. Two test edits came after the first full run, both in the tests: the browser test first opened a session the default fixtures source does not serve (it now finds the ticket's author in the source's list), and it compared the chooser with the account's name where the service keeps its id.

**Art-director pass** (Sonnet 5.5 in a fresh agent, on the twenty captures, `CaptureSwitch`, the catalogs, the session sheet and `app/DESIGN.md`; Impeccable's critique as its checklist; the first brief named a wrong path for the design file, and a second message gave it the right one). No breakage in the code. Taken: the switch's buttons are 44 px tall up to 1100 px, as the screen's other controls are (DESIGN.md section 8; they were the Editor switch's 36 px at 768), by one rule scoped to `.ticket-captures` at the end of `session.css`, so the Editor's own switch and the redraw of pull request 377 are left alone; the status line is always in the page (a live region inserted with its text is often missed); the group is described by its hint (`aria-describedby`); a save in flight ignores a second click instead of disabling the buttons, which faded the pressed one. Not taken: a focus ring of its own, since `app.css` already draws the app's ring (`--ring`) on every `:focus-visible`; the dark contrast of the unpressed choices, the Editor switch's styling before this lane, for the lane that redraws the sheets; the fixed ids, which follow the card's own (`ticket-title`, `criteria-title`); the hints' wording, since the heading says what is taken.

**Two defects the browser list found, both fixed before the pull request.** The stack and continuity tests serve the session view from sources that answer every route they do not know with something that is not a choice, and the switch drew a missing key (`captures_undefined_hint`). The view now draws the switch only for an answer that is a choice (`captureChoiceOf`, tested on such answers). And the choice was read again at every change of the service, by each of the up to five views the stack keeps mounted: it is now read once with the view and set by its own save, so a choice made in another tab shows on the next visit.

**Captures** (the visual loop, B4.5). The ticket card before and after, at 1440, 1280, 768 and 390 pixels, light and dark, in English, and at 1440 and 390 in French: `docs/v2/capture-detect/{before,after}/`, taken by the browser test with `CLEARED_V2_SHOTS` on the fixtures source: the before set on a detached checkout of `819ce38`, the after set on this branch after the merge of 374 and the art director's items (the 768 pictures show the 44 px buttons). Twenty PNG files, about 10 KB each; not put through `pngquant` and `optipng`, which this machine does not have, and small enough as they are.

**Not done.** The rule reads paths, not content: a server file that renders a page (the guestbook's `src/server.ts` serves `renderPage`) counts as the backend; the switch is the answer. A ticket of variants still takes no capture (P210's gap). No real ticket ran through a trial environment: P210's own proof run is still to come, and it will show the rule on a real diff.

**The merge of 374** (lane `j3-a11y`, at `origin/v2` `2b2314e`). The log keeps 374's entry, then this one; the matrix keeps P224 and P225, then P226, every id once; the browser job's list keeps `a11y-browser.test.ts` beside this lane's file. 374 changed `CloseTicket.tsx` and the inbox, not the files of this lane; its axe test runs on the session screen with the switch drawn and finds nothing (it needs `axe-core`, which 374 added to the lock file: `npm ci` again).

**Checks** (after the merge, at `2b2314e` merged). `npm run typecheck` passes. `npm test`: 2161 Node tests, 2075 pass, 86 skipped (the browser tests and the gated real-harness tests), 0 fail; 349 Vitest tests pass. The CI's `browser` job list, run as the job runs it (with `CLEARED_V2_PLAYWRIGHT` and `CLEARED_V2_CHROME`): 71 tests, 70 pass, 1 skipped (this lane's captures, which then needed `CLEARED_V2_SHOTS`; see below), 0 fail; then the tab-switch budget alone: passes, p95 56.3 ms, 0 documents, at most 0 requests a switch. An earlier run of that list, before the fixes above, failed the stack and continuity tests (the missing key) and, after the merge, the axe test (no `axe-core` installed yet). `npm run guard -- --base origin/v2`: nothing refused.

**Resources.** No Docker object, no Claude Code, Slack, Cursor or Codex account, no login read, no network beyond `npm ci` of the lock file, `git fetch` and GitHub, no tunnel, no secret; the app, the fixtures source and the browser listen on port 0 on loopback.

**The CI's browser job, red on 378** (run 40184013377: "1 browser test(s) skipped"). The job fails when any test is skipped, and this lane's capture test skipped itself without `CLEARED_V2_SHOTS`, which CI does not set; the local run had counted that skip as harmless. The test now always runs: without `CLEARED_V2_SHOTS` the card is captured into a temporary folder, removed after, and each file is checked to be a PNG with pixels; with it, the captures land in the named folder as before. It also measures each choice at least 44 px tall up to 1100 px, the art director's item, which the Editor switch's 36 px at 768 would fail. Run as CI runs it: 3 of 3 pass, none skipped.

- Pull request: 378, against `v2`.
- Author: Opus 5.5 (claude-opus-5-5), lane `j3-capture-detect`.

## 2026-10-25: Take over keeps its terminal while an older list lands, and the Consumption panel on a phone proven fixed by 373 (the author's choices, lane `j3-flaky-ci`, P228, issue #376)

**The need.** Issue #376 named five tests CI saw unstable; pull request 373 (lane `j3-test-gaps`, P225) fixed items 1, 2 and 4, and the owner's comment left item 3, "in French the panel is French, and holds on a phone" (no horizontal scroll, runs 40176736780 and 40179273206), and item 5, "Take over, type in the terminal, save in the editor; no policy violation with both mounted" (the first attempt of run 40178300390). The brief: the real cause from the CI's logs and a reproduction under load, a fix by an observable state, never a longer wait, a retry or a skip, and no change of the product's behaviour unless the cause is a product bug, then with a test that fails first. The id: P226 is lane `j3-capture-detect`'s (issue #368, its branch not pushed yet, the id in its matrix line) and P227 lane `j3-visual-redesign`'s (pull request 377), so this lane takes P228. The brief pointed at sections 9 and 10 of `milestone-2-plan.md`, which has eight, as earlier lanes noted; the conventions followed are those of section 10 of `milestone-1-plan.md`.

**Item 5: the cause, a product bug.** The CI's log: the test expected the terminal opened twice, on the harness then on the shell, and the fixture's source saw `harness`, `harness`, `shell`. Reproduced on this server with the CI's test copied, the page's CPU slowed six times by the browser's protocol and eight copies at once: 1 failure in 24 runs. A probe that logged each request to `/api/service/sessions*` beside each time the terminal came into the page or left it showed the run that failed: Take over answered, the terminal drawn, the first `terminal/open` sent, then the Take over button back and the terminal gone, before any new list of sessions had arrived; the next list put it back, and its `open` was answered 409, a terminal already open, attached. The session screen (`app/web/screens/session/Session.tsx`) holds what a gesture of the tab knows, `taken`, newer than the list, and dropped it at the first `refresh()` once the gesture was over. But `refresh()` runs whenever a resource the screen read has a new value, and reads the list from the page's cache: the session's own answer, refetched after Take over with the list, landed first, and the redraw it caused read the list the cache still held, from before Take over, which said nobody had it. A person saw the terminal leave and come back; the slow runner only made the window wide enough for the test to see it after the first `open`.

**Item 3: the cause, already fixed.** Both failed runs ran on commits without 373's fix: run 40176736780 on `4991c80` (pull request 369) and run 40179273206 on `8ed4af7` (pull request 374, before it merged 373); neither holds `b9835ac` nor `788fdba`, where 373 makes the test measure a width only once the shell's sidebar mode has followed it (its log entry: the bell's hidden tooltip widened the page to 486 px for a few frames). No run of the `browser` job has failed on that test since 373 merged. On the untouched build of `origin/v2` at `2b2314e`: 10 copies at once five times (load average up to 24), 50 of 50. On this lane's build, where the Consumption screen and its test are unchanged: the page's CPU slowed four times and 8 copies at once thirteen times, 104 of 104. No fix was added: the fonts and the tooltip were left as 373 left them (it ruled the fonts out, and logged the tooltip for an interface lane).

**Decision.**
1. **The tab's word stays until the list says the same, or a newer list says otherwise.** Take over and Give back, once the service accepted them, keep with their `taken` the list the cache holds at that moment (the cache answers it at once). `refresh()` drops `taken` only when the list it reads is another value than that one, or says the same as `taken` for the session. A redraw for another resource reads the same list, and the tab's word stays; the list fetched after the gesture says the same and drops it; a list from after the gesture that says otherwise (a Give back from another tab) still wins, as before. Give back has the mirror case, a list from before it saying the session is taken, and the same rule covers it.
2. **A refetch after a write does not join a read asked before it** (`app/web/lib/cache.ts`, `write`). The rule above takes any list that lands after the gesture for newer. The cache's refetch of what a write touched went through `fetchQuery`, which shares a request already on its way: a list read asked before Take over (an event's refetch) would stand for the read after it, and on a live session its answer is another value than the one held (`lastSeq` and `updatedAt` move with every stored event, `src/api/types.ts`), so the tab's word would drop on a list that does not know the gesture, and no new list would be asked until the next event. The fixture's list moves only its `takenOver`, so the browser test could not show it. Now each touched resource is refetched with TanStack's `refetchQueries(..., { cancelRefetch: true })`: a read on its way is dropped, the value held kept, and a new request goes out. `cancelQueries` then `fetchQuery` was tried first and left `cache.test.ts` hanging: a silent cancel makes the dropped fetch's promise wait for the query's next fetch, which `cancelQueries` waited for before any could start. The inbox's own cancel before an optimistic move is unchanged.
3. **The test holds the list.** `app/test/session/terminal-browser.test.ts` answers every `/api/service/sessions` read as the service had it when asked, 400 ms later, so the session's own answer lands first at every run, not only on a slow runner. An init script records each time the terminal comes into the page or leaves it: after the shell, only `in`; after Give back, once the list asked after it has landed, `in`, `out`, and no `terminal/open` after Give back. The count of opens, `harness` then `shell`, stays.

**Tests first.** `05ac9eb` holds the browser test alone: on the screen of `origin/v2` it fails at every run, the terminal `in`, `out`, `in`, three runs alone and 10 of 10 at once. The Give back half passes on the old screen too (three runs): it guards the rule, it did not fail first. `42af540` holds `app/test/foundation/cache.test.ts`'s new test alone: a list read held on its way, a write accepted, then the old read answered; on the old cache it fails, two requests where three are expected.

**Proof under load** (this server, shared with other lanes; Chromium 1248). With the screen's fix alone (`7c31b4e`):
- the committed test, 10 copies at once: 10 of 10 (load average 32);
- the committed test with the page's CPU slowed six times, 8 copies at once, thirteen times: 104 of 104 (load average 18 to 30);
- the CI's own version of the test (no list held) with the same slowdown: 104 of 104, where the old screen failed 1 in 24;
- the CI's `browser` list, its 22 files at once then the budget alone, three times (load average 16 to 24): 69 of 69, 68 of 69 and 69 of 69. The one failure is `app/test/inbox/inbox-browser.test.ts`, "A on a walked row that is not the one shown shows it first", a 30-second wait for a row of the list that never came; neither of this lane's tests.

With both fixes (`8dd564d`), the final code, all again: the committed test 10 copies at once, 10 of 10; slowed six times, 8 at once, thirteen times, 104 of 104, with and without the list held (load average 5 to 23); the CI's `browser` list once, 69 of 69. The slowed copies were made for the measure and are not committed.

**Not this lane's.** In the first 50 runs of `wins-browser.test.ts`, the English test timed out twice waiting 30 s for the panel to show, in the round where the load average reached 24; the French test passed in the same processes. It did not come back in the 104 slowed runs, nor in 48 more with 12 copies at once (load average up to 35). The screen reads the Consumption once at its start and again every minute (`REFRESH_MS`): a first read that failed would leave it on its error for longer than the test's wait. The inbox's failure in the CI's list above has the same shape, a wait for data that never drew. Neither was reproduced, so neither is fixed; both are named here for the next lane that sees them.

**Checks** (on `origin/v2` at `2b2314e`). `npm run typecheck` passes. `npm test` on the final code: 2134 Node tests, 2051 pass, 83 skipped (`CLEARED_V2_PLAYWRIGHT` and `CLEARED_V2_REAL_HARNESS` unset), 0 fail; 344 Vitest tests pass. `npm run guard -- --base origin/v2`: nothing refused (run without a private-term list, `CLEARED_REPO` unset).

**The merge of 378** (lane `j3-capture-detect`, P226, at `origin/v2` `2165da3`). The log keeps 378's entry, then this one; the matrix keeps P226, then P228, every id once. 378 adds the capture choice to the session's left cards, not the takeover's state, and writes through the same cache, so both causes and both fixes stand. After the merge: `npm run typecheck` passes; `npm test` runs 2162 Node tests, 2076 pass, 86 skipped, 0 fail, and 349 Vitest tests pass; the CI's `browser` list once, with 378's new file (23 files and the budget), 72 of 72.

**Resources.** No Docker object, no Claude Code, Slack, Cursor or Codex account, no login read; the app on port 0 on loopback; no network beyond `npm ci` of the lock file, `git fetch` and GitHub (the CI's logs read with `gh`); no tunnel, no secret.

- Pull request: 379, against `v2`.
- Author: Opus 5.5 (claude-opus-5-5), lane `j3-flaky-ci`.

## 2026-10-25: the navigation, the session, the inbox and Consumption redrawn as one calm workbench (the author's choices, lane `j3-visual-redesign`, P227, issue #375)

**Design direction** (written after Impeccable's `init`, `document` and `critique`, and committed ahead of the sheets' commit; the sheets were drafted beside it). The brief pins the world: the web and desktop apps of Codex and Devin, which `ui-overhaul-plan.md` section 3 already reads, with Linear and Raycast as second references; the tokens of `styles/app.css` stay, no gradient, no new feature. So this is the category's own look played straight, not a new world: no concept roll, no comp.
1. **One framed surface per screen.** What the person works in is the one raised pane (the session's thread, the inbox's detail); what stands beside it lies on the page, its sections parted by a hairline, never a card beside a card or a card in a card.
2. **A calm source list.** The sidebar is a list on its tinted ground: the search is a row of it, not a field; the screen shown is a raised row (the surface and its one-pixel ring), as a native source list draws it; a live session's title starts where a screen's name starts, its state's dot in the icons' column.
3. **Amber is a dot.** In the inbox's list, the kind of what waits is said in words with one amber dot before it; the detail keeps its amber kind, the one place the eye goes.
4. **A computer's controls on a computer.** With a mouse from 1024 px, buttons are 32 to 36 px, one line each (Approve's commit beside its label); touch screens and every width under 1024 keep 44 px (P217).
5. **Consumption after the product owner's reference** (a capture validated for this screen, kept out of the repository, nothing of its names taken): the period, the title, the line under it, the dates at the right; a card per agent on the sunken ground with its figures on the left and its curve beside them; the limits, the cost and the levers as sections of the page; each lever's choices drawn as radio options, the picked one ringed in ink, not filled. What the reference shows and Cleared does not have (a stacked cost bar, a button to a principle, one radio group across levers) is not added.
6. **Type and colour.** Sentence case everywhere, no letters spaced out (DESIGN.md section 3); the token scale only; red text for a limit that will be reached, its bar in the same red, not the brighter fill.
7. **Motion unchanged.** The brief's "smooth transitions" are the app's existing ones: `tokens.test.ts` allows only opacity and transform at `--motion`, and P223 keeps a screen switch free of animation, so no transition is added.

**The need.** Issue #375: a full visual redesign, with no new feature and no behaviour change, of the navigation, the session, the inbox and Consumption. The look should be a modern native app's, with the Codex and Devin apps as references. Impeccable runs first. The design direction is written here before the code. The work is audited and polished, with before and after captures. The brief named sections 9 and 10 of `milestone-2-plan.md`, which has eight; read in their place, as earlier lanes did: `ui-overhaul-plan.md` sections 3 (the references), 5 (the visual loop), 6 (Impeccable), 9 (its questions' defaults: the phone's bottom bar is kept) and 10 (out of scope).

**The id.** P224 (pull request 374) and P225 (373) were taken. Issue #368, the coming lane `j3-capture-detect`, was opened before #375 and takes the next free id, so this lane took P227. Checked again before the pull request: `origin/v2` holds P223 and P225, and no open pull request claims P226 or P227; issue #368 names no id of its own, and its lane has started.

**The product owner's reference.** The owner validated a capture as the reference for Consumption during the lane. It is kept out of the repository: it carries other products' names (rule 6 of the matrix), and none of them is written here. Taken from it: the hierarchy, the card per agent with its curve, the block that anticipates the limits, the levers' choices as radio options, the sober colours. Not taken: its capitals over the title (DESIGN.md section 3; the period stays, in sentence case), a stacked cost bar, a button to a principle and one radio group across the levers. Cleared has none of these: the levers are independent settings, and Pause is an action.

**Impeccable.** 4.7.0 in the lane's worktree, out of git; the installer's hooks file was removed before any edit; `DO_NOT_TRACK=1`; no live server, no listener.
- `init` wrote PRODUCT.md from the plans and the brief, with no interview, since the brief fixes its inputs.
- `document` recorded the incumbent sheets in the root DESIGN.md (excluded from git; the tracked `app/DESIGN.md` is untouched).
- The direction is pinned by the brief, so `concept-seed`, the decision page (a listener), comps and `build-phase` did not run. The build is code-led on the existing tokens.
- `critique` ran in a fresh agent (Opus 5.5) on the before captures and the code, and scored 27 of 40. Its first finding, that screen sheets leak into each other, is a false positive: `lib/sheets.ts` turns every other screen's sheets off (`media="not all"`). Its other CSS-level findings were taken: the session's side cards made flat, the composer, a quiet disabled Send, the tab track at 768, the inbox's amber made a dot, the quiet row answers, the summary on the sunken ground, the search as a row, a quiet avatar, the agent cards' curve beside the figures, the limit's bar in the danger text colour, the warning chip without a ring.
- The detector, run once on the four changed sheets, flags only Geist, which B3.8 requires.

**Audit** (Impeccable's `audit`, one bounded pass on the after set and the evidence below).
- Accessibility: PR 374's axe test (`app/test/a11y-browser.test.ts`, WCAG 2.2 AA, French and English, light and dark, 1440 and 390) was run on a scratch merge of this lane and 374's branch, with 374's lock file installed there only: 15 of 15 with this lane's and the inbox's browser files, no violation. The code merged without a conflict; only the log did.
- Contrast: `tokens.test.ts` passes, and every new ground under text is one it already checks (`--surface`, `--sunken`, `--tab-fill`, `--selected`).
- Theming: no colour is written in the diff, only tokens.
- Performance: no animation, blur or `will-change` is added; the only new shadow is the card's elevation on the two framed panes.
- Responsive: 44 px under a coarse pointer and under 1024 px, the phone tests of P217 and P222 pass, text sizes stay in rem.
- `polish`: its checklist added nothing mechanical beyond the critique's and the art director's items.

**What changed**, in `styles/app.css`, `inbox.css`, `session.css` and `consumption.css` only. No DOM, copy, catalog or token was added or renamed.
- The sidebar:
  - The search is a row of the list.
  - The screen shown and the session shown are a raised row (the surface and its ring), with no change of weight.
  - The live sessions' state dots sit in the icons' column, and their titles at the screens' names.
  - There is no hairline above the sessions.
  - The phone's bar draws its current item with no ring.
- The session:
  - The left and right columns' sections lie on the page, parted by hairlines.
  - The ticket's title is the screen's 20 px.
  - The thread is the one framed surface (12 px, the card's elevation).
  - The composer is a full-width field, then one row with Send at its right.
  - With a mouse, buttons are 32 px; on touch, 44 at every width.
- The inbox:
  - The page uses the scale's spacing.
  - The detail is the one framed surface.
  - A kind is said in words with an amber dot (a train's coloured chips stay).
  - The row answers are quiet fills, 44 px under a coarse pointer.
  - From 1024 px with a mouse, the detail's buttons are 36 px, one line each, the commit beside Approve's label.
- Consumption:
  - The period is in sentence case.
  - The agents' cards and the wins sit on the sunken ground.
  - The right column's three sections lie on the page.
  - The quota bars are 4 px.
  - The levers are sections with a hairline between them, and their choices are radio options (a ringed mark, the picked one ringed in ink, never filled).
  - A lever of one button has no mark.

**Art-director pass** (Sonnet 5.5 in a fresh agent, a different model from the author, on the before and after captures, the diff, the reference and Impeccable's critique and polish). Of its eight items:
- Taken: the 32 px buttons, choices and row answers on a touch screen wider than a phone, now 44 under a coarse pointer.
- Not taken, as the before set already had them: the phone bar's "Consumption" (P222 measured it within its slot at 375 and 390, in both languages), the fixed bar drawn mid-page in a whole-page capture (a capture artefact), and the phone's Interrupt as an icon (lane 38's).
- Not taken, disproved: the danger text's and the group titles' contrast. `tokens.test.ts` holds `--danger-text` and `--text-faint` at 4.5:1 or more on those grounds in both themes.
- Logged for later: two columns of unequal length on Consumption (moving the wins is a DOM change); the figure as large as the reference's (20 px is the scale's largest size); copy (the limit's sentence says three things; French "reset"; one cost row repeating the total); the sample-data pill on every screen; the permission card's amber fill; a pass of its own at 768.

**Tests first.**
- `5388c3d` commits the tests alone, failing on `6d7097f`:
  - `app/test/redesign/rules.test.ts` fails on Consumption's capitals.
  - `app/test/redesign/redesign-browser.test.ts` (added to the CI's `browser` list) fails four of five: the session's title at 16 px for the screens' 40; the side sections drawn as cards; the inbox's 44 px buttons at 1440; the levers as cards in a card. The fifth, the phone's 44 px buttons, is the guard that passes on both sides.
- After the critique, the lever test learnt that a lone action has no mark (Pause is not an option). This was written in the same commit as the sheets and noted in its message.
- No earlier test needed a change: the tests that pin the inbox on a phone, the wins table and the placeholders pass as they were.

**Captures.** On the fixtures with `scripts/capture-screens.ts`, ports 0 on loopback, no page error and no request off the app's origins: inbox, session, sessions and consumption at 1440, 768 and 390, light and dark, in English, and at 1440 and 390 in French, under `docs/v2/visual-redesign/{before,after}/`. Each set was compressed with `pngquant --quality=80-95 --skip-if-larger` then `optipng -o2` (system tools, run once, nothing scripted in `v2/`): before 3,255,956 bytes to 1,138,773; after 3,203,724 to 1,111,125. A wider set in the scratchpad (the tower, the Lead, the palette, the rail's tooltip, the release on a phone and the Plan tab, at the three widths, both themes) was compared before and after. Each differs only in the shared shell, and the phone's release keeps Approve on its own row with 44 px buttons.

**The tab-switch budget (P223).**
- Measured alone with `CI=true` on this lane's host, which other lanes shared (load average 9 to 29). The lane and an untouched `origin/v2` (`6d7097f`) were built in a scratchpad worktree and run alternately.
- Unslowed: the base's runs gave a median p95 of 42.4 and 31.0 ms, the lane's 39.6 and 37.8 ms, in a quiet stretch; a loaded first round gave 57 to 68 ms for the base and 77 to 117 ms for the lane.
- Slowed four times: the median p95 was 163.6 and 149.0 ms on the base, 167.0 and 166.5 ms on the lane.
- The budget passed every unslowed run, and after the merge alone at 22.8, 25.3 and 23.6 ms. A cost of a few percent at most cannot be ruled out on this host; the lane adds no animation, no blur and no forced layout.

**Checks** (after the merge of 373).
- `npm run typecheck` passes.
- `npm test` runs 2135 Node tests: 2051 pass, 84 skipped (`CLEARED_V2_PLAYWRIGHT` and `CLEARED_V2_REAL_HARNESS` unset), 0 fail. 342 Vitest tests pass.
- The CI's browser list with this lane's file: 68 of 68, then the budget alone.
- `app/test/notify/browser.test.ts` times out on this host and does the same on an untouched `origin/v2` (`6d7097f`) built in a scratchpad worktree, as lane `j3-ui-polish` logged. It is not this lane's, and its CI run decides.
- `npm run guard -- --base origin/v2`: nothing refused.

**The merge of 373** (lane `j3-test-gaps`, P225, at `origin/v2` `819ce38`). The log keeps 373's entry, then this one; the matrix keeps P225, then P227. 373's changed browser tests (the phone's inbox, the wins) pass on this lane's sheets.

**Resources.** No Docker object, no Slack, Cursor or Codex account, no network beyond `npm ci` of the lock file, Impeccable's install, the Debian packages of pngquant and optipng unpacked in the scratchpad, `git fetch` and GitHub, no port but loopback port 0, no secret. The reference capture stays outside the repository.

- Pull request: 377, against `v2`.
- Author: Opus 5.5 (claude-opus-5-5), lane `j3-visual-redesign`.

**The merge of 374** (lane `j3-a11y`, P224, at `origin/v2` `2b2314e`). The log keeps 374's entry, then this one. The matrix keeps P224 and P225, then P227, every id once. The CI's browser list keeps 374's `a11y-browser.test.ts` beside this lane's file. After the merge, with 374's lock file installed:
- `npm run typecheck` passes.
- `npm test` runs 2139 Node tests: 2051 pass, 88 skipped, 0 fail. 344 Vitest tests pass.
- With the CI's Chromium, 33 of 33 pass: 374's axe test, this lane's file, the inbox's, the phone's inbox, `phone-fit` and the wins.
- The budget runs alone at 26.7, 25.7 and 28.1 ms.
- `npm run guard -- --base origin/v2`: nothing refused.

**A capture for the product owner, during the lane, then cancelled.** At the owner's request, the current state was captured with the same script, in French, dark, at 1440 and 390, compressed with the same two commands, and pushed as one commit on a separate branch from `origin/v2`, with no pull request; this lane's branch was not touched by it. The owner then cancelled that request: this pull request's captures are enough. The separate branch was left as it is, since no branch is deleted; it is not part of this work.

## 2026-10-25: the sidebar is for the development; Consumption becomes a quota gauge at its foot (owner decision of 11:14, P227, issue #375)

**Decision** (the product owner, on pull request 377): "Consommation ne doit pas être dans la sidebar, la sidebar doit être en priorité pour tout ce qui concerne le dev."
1. Consumption leaves the sidebar's screens. The sidebar keeps the tower, the inbox, the sessions and the plans, then the sessions' groups. The tower stays: it is the development's overview, what waits and what runs.
2. A compact quota gauge at the sidebar's foot shows:
   - the week's percent used;
   - its colour at the Consumption screen's thresholds;
   - its reset as a weekday and a clock through `lib/time.ts` ("reset mar. 9 h 59", "resets Tue 9:59").

   A click opens the whole Consumption screen. Its route stays, and the palette's Go to, the G C chord and the account menu reach it too.
3. In French and English, read out with its percent and its reset, reached by the keyboard.

**The author's choices** (lane `j3-visual-redesign`).
- **The thresholds** are the Consumption screen's own: `verdictOf`, imported from its model, not copied.
  - That screen has no percent thresholds. A quota that reaches 100 % before its reset, or has reached it, is drawn in the danger text colour; any other is drawn in the progress colour, as its bars are.
  - So the gauge and the screen never disagree.
- **Which quota.** Of the agents' seven-day quotas, the first to reach 100 % before its reset (one already at 100 % first); else the most used. A five-hour window is never the week's. On the fixtures: Codex, 62 %, red.
- **Its words.**
  - It shows "Weekly quota", "62% used" and "resets Sat 21:41" ("Quota de la semaine", "62 % utilisés", "reset sam. 21 h 41").
  - Its accessible name holds the same words in the same order: "Weekly quota: 62% used, resets Sat 21:41. Opens Consumption." This is WCAG 2.5.3, label in name, which P224's axe test checks. A first wording without "used" in sight failed it, and was changed before any commit.
  - With nothing measured, it says "Not measured" ("Non mesuré") and still opens Consumption.
  - The agent's name is not shown: the shell's catalog has none, and the screen it opens names them.
- **Its place.** The gauge sits at the sidebar's foot, above the Lead's state. On the screen it opens, it is the raised row with `aria-current`, as a screen's item is. Folded on the rail, it is its bar alone, its words in its tooltip. On a phone it is not shown: the top bar has no room. There the palette and the account menu open Consumption, and the bar of screens at the foot loses Consumption with the sidebar.
- **The settings.** The app has no settings screen; the account menu is where the theme and the language are chosen. It gains a link to Consumption, and the menu closes on its way.
- **Its data.** The shell reads `/consumption` for the person's zone once they are known, then each minute: the Consumption screen's own pace (`REFRESH_MS`).
  - The cache does not hold it (its address has a query string), so this is one request a minute, never one per screen switch.
  - The budget's per-switch request count still allows one.
  - A failed read keeps what the gauge shows.
- **`lib/time.ts`** gains `weekdayClock`: the weekday from Intl, and the clock in the catalog's words (`time_weekday_clock`, "{day} {h} h {m}" and "{day} {h}:{m}"). One formatter is kept per language and zone, as P223 asks, and an unknown zone reads as UTC.

**Tests first.** `03fd1a4` commits the tests alone; all fail on the code before it.
- `app/test/shell/quota.test.ts`:
  - NAV is the four screens, SCREENS the five, the palette's Go to and `hrefOf` keep Consumption.
  - The quota picked, and its verdict for each projection, matches the screen's `verdictOf`.
  - The reset, in both languages, and in an unknown zone.
- `app/test/redesign/redesign-browser.test.ts`, three tests:
  - No Consumption item. The gauge at the foot: its name, its words, its red as the danger text token computes it, focus and Enter, `aria-current`, a click from another screen.
  - The palette and the account menu.
  - The French name.
- Changed with the decision, as the owner changed what they pinned:
  - `app/test/shell/sidebar.test.ts` pins SCREENS for the addresses and chords, and NAV for the four screens.
  - `app/test/consumption/consumption-browser.test.ts` opens Consumption from the gauge, not from the removed item.
  - `app/test/shell/tokens.test.ts` adds the sidebar's ground and its hover to the grounds the danger text is checked on.
- The palette test waits for the palette's field and its selected item before Enter: a fix to the new test, in the implementation's commit.
- `app/test/polish/copy.test.ts` (an empty state says one sentence) refused the first `quota_name_none`. It became one sentence, "Weekly quota not measured" ("Quota de la semaine non mesuré"); the key was not renamed around the rule.

**Captures.** The after set was taken again at this head with the same commands: the gauge at the sidebar's foot on every screen, and the phone's bar of four screens. It was compressed with `pngquant --quality=80-95 --skip-if-larger` then `optipng -o2`, and taken once more after the merge of 378 below, from 3,248,631 bytes to 1,127,636. The before set is unchanged.

**Checks** (at `origin/v2` `2b2314e`):
- `npm run typecheck` passes.
- `npm test` runs 2145 Node tests: 2054 pass, 91 skipped, 0 fail. 344 Vitest tests pass.
- With the CI's Chromium, 79 of 79 pass in one parallel run: the CI's browser list with 374's axe test, this lane's file, and `consumption-browser.test.ts`. The notify file is left out, for the host reason already logged.
- The budget runs alone at a p95 of 18.0, 25.4 and 20.5 ms, with no request per switch, during a load average of 25.
- `npm run guard -- --base origin/v2`: nothing refused.

**The merge of 378** (lane `j3-capture-detect`, P226, at `origin/v2` `2165da3`). The log keeps 378's entry, then this lane's two; the matrix keeps P226, then P227, every id once. 378 adds a capture switch to the session's left column, where it lies on the page as this lane's sections do; the after set was taken again for it. After the merge:
- `npm run typecheck` passes.
- `npm test` runs 2173 Node tests: 2079 pass, 94 skipped, 0 fail. 349 Vitest tests pass.
- The CI's browser list with `consumption-browser.test.ts`, the notify file left out: 78 of 78.
- The budget runs alone at 20.9, 19.6 and 20.6 ms, with no request per switch.
- `npm run guard -- --base origin/v2`: nothing refused.

- Pull request: 377, against `v2`.
- Author: Opus 5.5 (claude-opus-5-5), lane `j3-visual-redesign`.

## 2026-10-25: the quota gauge on a phone too (owner answer of 12:20, P227, issue #375)

**Decision** (the product owner, on pull request 377): "Ajouter la jauge sur mobile, puis merger." It replaces the previous entry's choice to leave the gauge off a phone.

**The author's choices** (lane `j3-visual-redesign`).
- **Its place:** the phone's top bar, between the search and the sample-data pill, the person and the bell.
  - Not a row above the bar of screens. That row would take height from every screen. It would also move every offset P217 pins, such as the inbox's buttons held above that bar.
  - The bar of screens keeps its four.
- **Its look:** the percent ("62%", "62 %") over a thin bar, in the verdict's colour, a 44 px touch target. The label and the reset are in its accessible name only, the same name as on a computer ("Weekly quota: 62% used, resets Sat 21:41. Opens Consumption."). The percent shown is a word of that name, as WCAG 2.5.3 asks. With nothing measured it shows the gauge's icon.
- **On the screen it opens** it takes the hover's fill, not the raised row, which reads as a button in a top bar.
- **The project's name:** with the sample-data pill shown (the fixtures), the name in the top bar is shortened with an ellipsis ("Guest…"), as it already was whenever it did not fit. Without the fixtures there is no pill.
- **A tap** opens Consumption. Nothing changes on a computer or a tablet.

**Tests first.** `a4ed715` commits two tests alone, in `app/test/redesign/redesign-browser.test.ts`, in English and in French at 390. Both fail on the code before it, which hid the gauge on a phone. They check:
- the gauge is shown in the top bar, at least 44 by 44 px;
- its name holds its percent and its reset, and its text is the percent alone;
- it is not in the bar of screens, which keeps its four;
- nothing of the top bar overlaps, and the page has no sideways scroll;
- a tap opens Consumption, which marks the gauge `aria-current`.

P224's axe test reads the phone's screens at 390 in both languages and themes, the gauge included.

**Captures.** The after set was taken again at this head with the same commands. Only the 16 captures at 390 changed (the gauge in the top bar); the others came out identical to the byte. They were compressed with `pngquant --quality=80-95 --skip-if-larger` then `optipng -o2`; the after set is 1,332,225 bytes in all.

**Checks** (at `origin/v2` `2165da3`):
- `npm run typecheck` passes.
- `npm test` runs 2175 Node tests: 2079 pass, 96 skipped, 0 fail. 349 Vitest tests pass.
- With the CI's Chromium, 80 of 80 pass: the CI's browser list (P224's axe test at 390 included) and `consumption-browser.test.ts`, the notify file left out.
- The budget runs alone at 17.3, 20.6 and 18.6 ms, with no request per switch.
- `npm run guard -- --base origin/v2`: nothing refused.

**The merge of 379** (lane `j3-flaky-ci`, P228, at `origin/v2` `199d059`). The log keeps 379's entry before this lane's three. The matrix keeps the ids in order, P226, P227, P228. 379 changes `lib/cache.ts`, `Session.tsx` and their tests, none of this lane's lines. After the merge:
- `npm run typecheck` passes.
- `npm test` runs 2176 Node tests: 2080 pass, 96 skipped, 0 fail. 349 Vitest tests pass.
- With the CI's Chromium, 79 of 80 pass. The one failure is `app/test/session/production-browser.test.ts` under the parallel run, the load flake lane `j3-tab-perf` logged; alone it passes, 3 of 3, twice.
- The budget runs alone at 21.2, 19.1 and 17.2 ms, with no request per switch.
- The 40 captures were taken again: 39 are identical to the byte, and the 40th (`sessions-768-dark`) is drawn the same. So the committed set stands.
- `npm run guard -- --base origin/v2`: nothing refused.

**The merge.** The owner's "puis merger" asks for the merge into `v2`. This lane does not write to `v2` (the brief's rule); the pull request is left ready for the orchestrator, who merges.

- Pull request: 377, against `v2`.
- Author: Opus 5.5 (claude-opus-5-5), lane `j3-visual-redesign`.

## 2026-10-25: the project's name whole in the phone's top bar (the author's choices, lane `j3-mobile-title`, P229, issue #380)

**The problem.** At 390, with the sample-data pill shown (the fixtures), the project's name in the top bar was cut: "Guestbook" took 78 px and had 63 in English, 58 in French ("Guestb…"). The bar holds the mark, the name, the search, the quota gauge, the pill, the person and the bell. This entry replaces the choice of P227's entry of 12:20, which kept the name shortened with an ellipsis whenever the pill is shown.

**The author's choices.**
- **The name is the bar's title.** Below 768 px the product's mark is hidden. That gives the name 26 px, the width of the 18 px mark and its gap. On a phone the name says where the person is, as a native app's title does; the mark is still on the login page and on a computer. The mark is `aria-hidden`, so the link's name does not change: the project's name, a link to the tower, 44 px tall.
- **The bar's foot keeps the bar's own gap.** The gauge, the pill and the person were 8 px apart, against 4 px between the bar's other items. They are now 4 px apart, which gives the name 8 px more. In French at 390, the name has 14 px to spare.
- **Not a smaller gauge.** It is at its 44 px target already. Its percent, its bar and its name are unchanged.
- **The pill keeps its ground and its word.** Taking off its fill would put muted text on the sidebar's ground, a new pair for contrast, and the room was not needed.
- **A longer name** is still shortened with an ellipsis, and the link still reads it whole.
- **Words.** No string changed, so neither catalog changed.
- **Widths.** Nothing changes on a computer or a tablet: the rules are inside `max-width: 767px`. At 375 in English the name is whole too.

**Tests first.** `5b9e229` commits two tests alone, in `app/test/redesign/redesign-browser.test.ts`, in English and in French at 390 on a touch screen. Both fail on the code before it ("Guestbook" is cut: 78 px in 63, and 78 px in 58). They check:
- the project's name is whole and the link reads it alone;
- the pill's word is whole;
- the gauge is at least 44 by 44, and the name's link, the search, the person and the bell are 44 px tall;
- the page has no sideways scroll.

P227's test of the gauge on a phone still checks that nothing of the top bar overlaps, and P224's axe test reads the screens at 390 in both languages and themes.

**Captures.** The 16 after captures at 390 (inbox, session, sessions and consumption; light and dark; English and French) were taken again at this head with `scripts/capture-screens.ts --widths 390`. They were compressed with `pngquant --quality=80-95 --skip-if-larger` then `optipng -o2`: from 1,007,716 bytes to 339,862, in place of 409,616. The other widths were not taken again. The French Consumption page is now 2,559 px tall where the committed capture was 2,475: `origin/v2` draws it at 2,559 too, so that comes from a change merged after that capture, not from this lane.

**Checks** (at `origin/v2` `2cf78d4`):
- `npm run typecheck` passes.
- `npm test` runs 2178 Node tests: 2080 pass, 98 skipped, 0 fail. 349 Vitest tests pass.
- With Playwright's Chromium, the CI's browser list passes 82 of 83 in one parallel run, under a load average of 15. The one failure is `app/test/session/tabs-browser.test.ts` ("the four tabs switch, and the Go of a waiting plan calls its route": "Go given by a teammate" where it waits for "by you"). That is a plan's Go and the user who gave it, which this lane's two CSS rules do not reach. Alone it passes 4 of 4, twice.
- The budget runs alone at a p95 of 22.9 ms, with no document and no request per switch.
- `npm run guard -- --base origin/v2`: nothing refused.

**What was read.** `docs/v2/milestone-2-plan.md` ends at its section 8. The sections 9 and 10 read were the milestone 1 plan's (waves, conventions that keep lanes apart) and the interface overhaul plan's (questions for the owner: the phone's bar of four, the default kept; out of scope).

- Pull request: 383, against `v2`.
- Author: Opus 5.5 (claude-opus-5-5), lane `j3-mobile-title`.

