# Take over, played for real (issue #463)

Step 11 of the multi-service proof (`v2/scripts/proof-j2-multi.ts`), played on a real Claude Code session by `v2/scripts/proof-takeover-live.ts`, then again after a restart of the service. The run of record is the seventh of 2026-10-28, 13:45 to 13:53 Europe/Paris: 7 phases ok, 0 failed. Its log is [run.log](run.log), its report [result.json](result.json); both are redacted (no home folder, no temporary folder, no login path, no token, no cookie).

## The install

- The service and the app of the lane's branch, started by the script on three free ports of 9700 to 9799 on `127.0.0.1`, in a temporary folder, on the real Claude Code adapter.
- The project: the example guestbook (`examples/guestbook/`), its remote a bare copy of it (no fork), the forge the rehearsal's `gh` stand-in. No Linear.
- The login: the server's Claude Code login, named to the service by its path and mounted read only in the session containers (the owner's decision of 2026-10-22 on #147, confirmed for this lane). The script checks its mode and never opens it.
- The models: Haiku 5.5 for the author and the reviewer, one review round, at most 2 USD a ticket. The service reads no quota on the host, runs no lead and no service map.
- The session and egress images, built from the branch and labelled `cleared.dev=v2`. Every container, network and volume of the run's sessions is removed by its label at the end; none was left.

## What was played

| Phase | What the owner did | What was seen |
| --- | --- | --- |
| A-author | Ticket LOCAL-1 created from the tower bar, its session plan given its Go; the author taken over once it had changed `src/page.ts`; one line typed to the harness; the Shell: `git status`, `npm ci`, `npm test`; one line of `src/page.ts` changed and saved in the Editor; Give back | The terminal opened on "Claude Code, resumed on this session" ([capture](02-harness-author.png)) and the model answered 42; `git status` answered, `npm ci` installed, `npm test` passed 48, failed 0 ([capture](04-shell-tests.png)); the save answered 200 ([capture](05-editor-saved.png)), journaled as one `cleared.human_edit`; after Give back the session's turn began with the notice naming `src/page.ts` |
| A-reviewer | The reviewer taken over, one line to its harness, Give back | Claude Code resumed on the reviewer's session and answered 42 ([capture](07-harness-reviewer.png)); the review went on and ended with its verdict: changes requested, the owner's line in `src/page.ts:1` among its defects, so the change was in the ticket's diff |
| A-end | The ticket set aside (nothing approved) | The author's screen reads "Done" ([capture](10-A-end.png)), not "Working" (#233) |
| B-restart | Ticket LOCAL-2's author taken over, then the service stopped (SIGTERM) and started again with the same command | The session did not survive: `stopped`, no longer taken over, `RUN_ERROR` `restart`, the ticket back in Todo, the screen "Stopped", its containers released ([capture](12-B-restart.png)); issue #468 |
| B-after-restart | The ticket moved to Todo; the new author taken over on the restarted service, the harness, the Shell, the Editor, Give back | As A-author, on the new session; the Editor changed `test/page.test.ts`, the one file that author had changed |

## The runs before it

The six earlier runs of the same day, each stopped, cleaned and read before the next:

1. The Editor tab lists the changed files only, and the author was taken over before it had changed one: the script now waits for a changed file, as step 11 waits for `src/page.ts`.
2. Seven phases ok. The report counted the editor's edits from the Give back, listed each quota figure many times, and listed another process's containers as left: fixed in the script.
3. After the restart the new author changed only its test, then ended: the Editor now opens a file the author changed, `src/page.ts` first, and an author that ended with none is said at once.
4. Seven phases ok. The done author's screen read "Stopped": Claude Code's own `stopped` delta is journaled after the engine's closing snapshot. Fixed on the screen: an ended session's row is the word (#233).
5. The reviewer was taken over one second before its first turn opened: the runner held that turn and carried it on after the Give back, with no new `RUN_STARTED`, which the script waited for. The script now waits for any of the session's own work.
6. The author of LOCAL-2 was taken over 0.4 s before its first turn opened, and the session failed with `error_during_execution`. Fixed in the Claude Code adapter's mapper: an interrupt asked with no turn open reads that end as a cancelled turn.

## The real-adapter test

`v2/test/terminal/real-harness.test.ts` (P47) ran with its gate open on 2026-10-28 at 12:36: both cases passed in 80 s. The author's terminal closed in 699 ms and its transcript went from 33 to 51 lines; the reviewer's closed in 505 ms, from 25 to 42 lines.

## The quota

The seven-day window, as the sessions reported it: 21 % at the first figure of the runs (12:44), 23 % at the last (13:48), on a login other sessions of this server use too. The run's sessions reported 0.2 USD in all. The stops (5 points spent, or 90 % of the week) were never reached.

## What it does not prove

- A session that survives a restart of the service: none does (#468).
- Step 4 of the multi-service proof (the Browser tab on a two-service trial environment): this run has one service.
- The release card and its approval: nothing is approved by the script, so no merge, no deploy and no release watch.
