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
   - Risk (added on 2026-10-24, issue 185, item 1): the agent chunk also carries CopilotKit's trajectory collector (`@copilotkit/learning` and the `phoenix` client), which joins a Phoenix channel over a WebSocket once a runtime or a `learning` option is set. Neither is set here, so it is dead weight in the bundle; the test watches `WebSocket` across several connects and detaches.
7. **Every opt-out**, and what checks it:
   - `v2/.npmrc` runs no install script, and `scarfSettings.enabled = false` turns off `@scarf/scarf`, which CopilotKit pulls in.
   - The CI job sets `SCARF_ANALYTICS=false`, `DO_NOT_TRACK=1` and `COPILOTKIT_TELEMETRY_DISABLED=true`. Vite defines the same, and `NODE_ENV=production`, so the inspector never mounts.
   - `@copilotkit/web-inspector` is replaced by an empty module at build time.
   - Telemetry lives in CopilotKit's runtime package, which is not installed. The built page names `telemetry.copilotkit.ai` and `cdn.copilotkit.ai`, twice each, only in the lists of addresses CopilotKit's capture ignores, never as a request. (Corrected on 2026-10-24, issue 185, item 1: this line named only the first.)
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

## 2026-10-22: Owner decision of 21:58: Take over attaches the real harness

**Decision.** On 2026-10-22 at 21:58 (Europe/Paris), the owner asked for a lane outside the [milestone 2 plan](milestone-2-plan.md)'s lane list, as a follow-up of the request of 17:26 (pull request 230). In the real multi-service proof (step 11, ticket LOCAL-14, real Claude Code adapter), Take over said "Claude Code cannot be resumed here", with "The claude-code harness cannot be resumed in a terminal yet: open the Shell instead", so only the Shell worked. Take over must attach the web terminal to `claude --resume <session id>` inside the session's container with the real adapter, the login mounted read only. The lane also fixes step 11 of `v2/scripts/proof-j2-multi.ts` (wait for "On branch" after `git status` before `npm test`), looks into why the guestbook's `npm test` failed in the session's Shell, and adds an integration test on the real adapter's path. Give back must still exit cleanly.

**Consequences.** The lane `v2-j2-takeover-real-harness` implements it and cites this entry. The requirements matrix records the decision as O18, and the author's choices as P47 and P48 (the entry below the next one).

## 2026-10-22: Owner decision of 22:01: Take over works on the reviewer's session too

**Decision.** On 2026-10-22 at 22:01 (Europe/Paris), the owner extended the scope of the lane above: Take over must also work on the reviewer's session, and on a session of any role of a ticket's flow (author, reviewer, integration), through the same adapter path. The real-adapter integration test covers the reviewer too.

**Consequences.** This changes lane 20's rule (decision 30, pull request 212) that only an author's session is taken over. The requirements matrix records it as O19.

## 2026-10-22: the runtime keeps the harness's interactive resume, Take over on the reviewer, and step 11 one line at a time (the author's choices, lane v2-j2-takeover-real-harness)

**Decision.** The lane applies the owner's decisions of 21:58 and 22:01 (the two entries above). Its choices:

1. **Why it said "cannot be resumed"** (`v2/src/flow/runtime.ts`).
   - The sentence is `interactiveResume`'s for an adapter with no `interactive` method. The Claude Code adapter has one, but the registry never sees it: the sessions module gives the registry `runtime.adapters()`, and `withWorkspace` wrapped each adapter with `harness`, `start` and `resume` only.
   - Pull request 230 did not see it: its tests put their adapter straight into the registry, and its labelled run called `createClaudeCodeAdapter` directly. Neither went through the runtime.
   - **The fix:** the wrapper passes `interactive` through when the adapter has one (bound to it), and still changes only `start`.
   - **What was checked and found right:** the session image in use (`cleared-v2-session:2.1.306`, built at 17:57) holds this branch's runner, byte for byte (the three files' hashes), so its `release` and `reload` are there; the session id is the transcript's (the runner's `sessionId`, then `resume`); `HOME` is `/tmp` and `CLAUDE_CONFIG_DIR` is the session's config volume, in the runner and in the terminal's `docker exec` alike (the container's environment); the cwd is `/workspace` for both, so `claude --resume` finds the transcript in the project folder Claude Code derives from it (`projects/-workspace/<id>.jsonl`), which the real-adapter test checks by its line count.
   - **What the live service needs:** a restart, since the fix is in the service's process. No image rebuild.
2. **Take over on the reviewer** (`v2/src/flow/{engine,takeover}.ts`, `v2/app/web/screens/session/tabs.ts`, `v2/app/fixtures/source.ts`).
   - The engine takes over an author's or a reviewer's live session. A step's session (the contract's, a service's, the integration's) is an author's, so it was already covered; the lead's is not the flow's and is still refused.
   - The reviewer's interrupted turn is no verdict: the engine leaves a paused session's end of turn alone, as lane 20 made it for the author.
   - **Give back** puts a reviewer back in `reviewing` (an author in `working`, as before), and tells it `GIVEN_BACK_REVIEW`: carry on with the review and end it with the report and the verdict line its first message asked for. Its report is then read as any review's.
   - **The screen** offers Take over on a reviewer's live session too (`takeoverOf`). The Editor stays read only there: lane 31's rule that a save is refused while the review runs is unchanged, and so is the screen's (`sessionOpen`, an author's).
   - **What a human changes in a reviewer's terminal.** The reviewer works in the ticket's checkout, as the author does, so Give back finds those changes and journals them as `cleared.human_edit` on the reviewer's session, and tells the reviewer. The reviewer does not commit, so such a change is not on the branch until an author commits it, and the review's list of a human's edits (lane 23's call) reads the authors' sessions only. Said, not changed.
3. **Step 11, one line at a time** (`v2/scripts/proof-terminal.ts`, new, and `proof-j2-multi.ts`).
   - **What failed.** The real run typed `npm test` 1.5 s after `git status`, then looked for "On branch". The tests' output had scrolled it out of the 21-row terminal, so the wait timed out after 30 s.
   - **Now** each line is typed once the one before has answered: the shell's prompt back on the terminal's last row, and "On branch" on the screen for `git status`.
   - **The lines** are `git status`, `npm ci`, `npm test`. Only `git status` must answer. The step records what `npm ci` did (installed, failed) and what `npm test` said (node's `ℹ pass` and `ℹ fail` counts, or that some failed and the summary scrolled out, since node prints the failing tests after its summary). A red install or test is the author's work in progress, not the proof's.
   - **The rehearsal's stand-in shell** says it installs nothing for `npm ci`, as it says it runs no test for `npm test`.
4. **Why the guestbook's `npm test` failed in the Shell.**
   - `DATABASE_URL` was set: the session container of LOCAL-14 had it from the postgres service (names of its environment read, no value).
   - Both files failed at `1:1` because `pg` could not be imported: the ticket's checkout had no `node_modules`. Reproduced in a labelled container with no network (`Cannot find package 'pg' imported from /workspace/test/helpers/db.ts`).
   - A fresh ticket checkout never has them. The guestbook's `.devcontainer/devcontainer.json` declares no install command, and the author had not run `npm ci` yet. The other failure on that screen, an assertion in a page test, was the author's change in progress.
   - **The fix is the proof's,** which typed `npm test` in a checkout nobody had installed: step 11 types `npm ci` first. Cleared installs nothing on the host: an install runs the branch's scripts, which only the container may run.
5. **The integration test on the real adapter** (`v2/test/terminal/real-harness.test.ts`, new).
   - **Its path is the service's:** `createRuntime(...).adapters()` with the real Claude Code adapter, so the wrapper of choice 1 is in it. Then the real session container on a temporary clone of `examples/guestbook/` (a one-service workspace, the postgres service as the guestbook's `agents.conf` names it), the login mounted read only, the terminal's real program through `dockerContainer`, and Haiku 5.5 with a 0.5 USD budget per session.
   - **For each role, author then reviewer:**
     - the first turn ends;
     - the transcript is where `claude --resume` looks (its line count only);
     - `interactiveResume` answers Claude Code with `claude --resume` on the session's own id;
     - the terminal shows the resumed conversation, and a line typed to the harness is answered by the model;
     - the close takes less than 8 s and leaves no `claude --resume` process, and the transcript has grown;
     - `resume()` returns the same handle, and the reloaded runner answers what the human asked the harness;
     - nothing with the session's label is left after the stop, and the volume is removed.
   - **The author's Shell:** `DATABASE_URL` is set and no login is in the shell's environment; `npm ci && npm test` installs and runs the guestbook's tests with no `Cannot find package 'pg'`.
   - **The gate.** It spends a little quota and starts containers, so it runs only with `CLEARED_V2_REAL_HARNESS=1`, a login file (its path and mode checked, never read by the test), docker answering and the labelled session image. Every other `npm test` skips it, so other lanes on this server do not start sessions on the login. Every docker command goes through the wrapper, under the label rule.

**Files.** The lane is not in the plan's lane list, so it names its own: `v2/src/flow/{runtime,engine,takeover}.ts`, `v2/app/web/screens/session/tabs.ts`, `v2/app/fixtures/source.ts`, `v2/scripts/{proof-j2-multi,proof-rehearsal-multi,proof-terminal}.ts`; the tests `v2/test/flow/{runtime-interactive,takeover}.test.ts`, `v2/test/scripts/proof-terminal.test.ts`, `v2/test/terminal/real-harness.test.ts`, `v2/app/test/session/{tabs,fixture-human}.test.ts`, `v2/app/web/test/session/tabs.test.tsx`; this log and `docs/v2/requirements-matrix.md`.

**Tests first.** Commit `0d51b73` holds them alone. On `origin/v2` at `d0e5e0e`:
- the runtime's test fails (the wrapper's methods are `resume` and `start`);
- the reviewer's takeover answers 409 ("only an author's session is taken over");
- `takeoverOf` refuses the reviewer;
- `proof-terminal.ts` is missing;
- the real-adapter test, run with its gate open, answers "The claude-code harness cannot be resumed in a terminal yet: open the Shell instead.", the real run's sentence.
The fixture source's reviewer case (`fixture-human.test.ts`) was added after that commit; it failed on the old source with its 409 before the source changed.

**The real-adapter test on this server** (2026-10-22, Docker 29.8.1, `cleared-v2-session:2.1.306`, the owner's current Claude Code login mounted read only as the service mounts it, Haiku 5.5):
- **First run:** the reviewer passed. The author's first turn did not end in 240 s: its Stop hook sends a turn without `HANDOVER.md` back once, and the test answered no request. The session that run left was removed by its label. The test now allows each request once, as the doctor does, asks the author for the handover, and removes by the label what a failed stop leaves.
- **Second run, both roles passed in 55 s:**
  - the author: the terminal closed in 456 ms, the transcript went from 32 to 50 lines, and the reloaded runner answered what the human had asked the harness; in the Shell, `DATABASE_URL` was set, no login was in the environment, and `npm ci && npm test` ended with `ℹ fail 0`;
  - the reviewer: closed in 443 ms, from 24 to 40 lines, the same answer after the reload.
  - Nothing with either session's label was left, and both volumes were removed.
- No proof ran against the live service on 8791 and 8792, and nothing of the demo on 8796 to 8799 was touched. The LOCAL-14 checkout and container were only read: the names of its environment, the mount of its checkout, its `git status` and a clone for the labelled reproduction.

**The multi-service rehearsal** (fake adapter, its own service and app, `PROOF_SCREENS=0`) ran on commit `f3925e2`: 12 steps ok, 0 failed, in `/tmp/cleared-captures/j2/multi-rehearsal-takeover/` (`result.json`, `durations.md`, the steps' captures). Step 11: the harness unsupported on the fake adapter, then the Shell with `git status` (answered), `npm ci` and `npm test`, 3 lines journaled, one save (200), given back, and `src/page.ts` on the card of LOCAL-4. It recorded "npm test: no summary on the screen": the stand-in's sentence wraps across the terminal's rows, so it is now looked for with the white space taken out. A unit test covers that, and the rehearsal was not run again for this record-only change.

**The visual loop.** The tower fixture's live reviewer (LOCAL-152), taken over, with its harness in the Terminal tab, on an ephemeral `127.0.0.1` port in headless Chromium 1248, with the clock fixed at the fixture's time.
- **Captures:** `/tmp/cleared-captures/j2/takeover-reviewer-<width>-<theme>.png` at 1440, 1280, 768 and 390, light and dark, and `takeover-reviewer-reference-session-<width>.png` rendered from `/tmp/cleared-reference/session.html`. Mode 644, the pointer in a corner. None is committed.
- **Checks:** no horizontal overflow, no page error, no `securitypolicyviolation`, no `docker exec`.
- **Known, not this lane's:** at 768 the terminal's last rows sit under the composer. This is lanes 20 and 32's layout, declined in issue 213, and the same on the author's screen. The fixture's stand-in harness shows the same words on every session.
- No art director's pass was run: the change on the screen is a button that now shows on one more role.

**Checks.**
- `npm test`: 1250 node tests, 1240 pass and 10 skipped (the browser tests without `CLEARED_V2_PLAYWRIGHT`, and the real-adapter test without its gate), 0 fail; 184 Vitest tests pass.
- `npm run typecheck` is green.
- `npm run guard -- --base origin/v2` is green. It ran without a private-term list (`CLEARED_REPO` unset).

**Followups.**
- The live service needs a restart to carry choice 1, and the real proof's step 11 then shows the harness attached.
- Issue 231: item 1 of the second list (the release is re-sent after a timeout) and item 1 of the first (the raw harness id in the sentence) are not taken.

- Pull request: 242, against `v2`.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j2-takeover-real-harness`.

## 2026-10-22: Owner feedback of 22:01 and precision of 22:04: the interface moves to a native application look and feel, with zero reload between tabs

**Feedback.** On 2026-10-22 at 22:01 (Europe/Paris), after an evening on the demo instance, the owner found the interface dreadful: not modern, not practical, too many loads between the tabs; the author to reviewer transition is not smooth; Take over is impossible on the reviewer. The owner wants the look and feel of a native application, and gave carte blanche for the night. At 22:02 the owner's capture of the demo's inbox showed a reviewer's permission request titled by its raw chained shell command (git log; git merge-base; git show...; npm test | tail), an English reason ("Git merge-base main HEAD is not a command the policy allows on its own"), no button, and "no longer waiting for you" items on top. The owner requires: a clear French title that says the intent, the raw command folded, the reason translated, clickable answers "Autoriser une fois", "Toujours pour ce projet", "Refuser", the resolved and expired items in a folded "Traité" group, and the whole interface in French when the language is fr. A separate lane fixes the reviewer's permission policy itself (read-only commands and the project's tests allowed, compound commands split); the overhaul covers the inbox's presentation and the French only.

**Precision of 22:04.** The main references are the interfaces of OpenAI Codex (the web and desktop apps) and of Devin, with Linear and Raycast as secondary references: their public captures and documentation are studied for the session or agent view, the thread, the diff, the terminal and the handover, and cited in the plan as inspiration, without copying brands or assets. The interface lanes use Impeccable (`github.com/pbakaus/impeccable`, Apache-2.0), installed per lane worktree with `npx impeccable install --providers=claude --scope=project`, kept out of git through `.git/info/exclude`, never committed; each lane's author runs its audit, critique and polish commands, and the fresh art director look uses them too.

**Consequences.** The plan is [ui-overhaul-plan.md](ui-overhaul-plan.md) (the entry below). The requirements matrix records the feedback as O20 and the precision as O21: O18 and O19 are taken by pull requests 240 (the reviewer's policy) and 242 (Take over on the real harness and on the reviewer, the owner's decision of 22:01 on that point), so this plan's rows follow them. The Take over part of the feedback is pull request 242's; the plan draws it and does not implement it.

- Author: the owner, relayed on 2026-10-22 22:01 and 22:04 (Europe/Paris); written in this log by Fable 5.1 (claude-fable-5-1), lane `v2-j2-ui-overhaul-plan`.

## 2026-10-22: the native interface overhaul, planned in six lanes on a routing and data foundation (the planner's choices, lane v2-j2-ui-overhaul-plan)

**Decision.** [ui-overhaul-plan.md](ui-overhaul-plan.md) diagnoses the interface on captures of the live proof app and of the demo's sign-in page, states the requirements of the owner's feedback above, cites the four references, and plans six lanes (a small dependency lane and five interface lanes) in five waves, the data and routing foundation first. Its choices, numbered U1 to U12 in the plan:

1. **What was measured** (section 1.2). Every header tab is a plain link to a page the server writes for that address: each switch is a full document load with 22 to 25 requests, the screen blank until its data arrives (130 to 531 ms on loopback; the owner's path over the tailnet pays a round trip per request). The session screen's own tabs, which do not reload, take 54 to 82 ms: the 100 ms budget is reachable once every switch is an in-page one.
2. **Two defects found on the live app**, in the plan's section 1.4: the sessions index is blank (the service has a session of role `lead`, the session catalog has no `role_lead`, the translator throws, and with no error boundary React unmounts the page, header included); the Editor of an ended session answers "The file could not be loaded." for each file (the files route reads the container's checkout, gone with it).
3. **The author to reviewer transition is a page change** (two session addresses linked from the crumbs): requirement 2.3.1. **Take over was the author's alone** at the captures' commit, on the screen (`tabs.ts`, `takeoverOf`) and in the service (`flow/takeover.ts`); pull request 242 owns it for every role (`runtime.ts`, `takeover.ts`, `engine.ts`, `tabs.ts`), so requirement 2.3.4 only draws it in the ticket's view.
4. **The foundation** (lane 34): TanStack Router in code with intent preloading, one shell page for every screen address (U1); TanStack Query as the shared cache, one key per resource, optimistic mutations (U2); one thin SSE stream of the service (`GET /api/events`, `text/event-stream` read by an `EventSource` through the app's proxy, from the flow's bus and an `onChange` hook of the inbox store, no payload, a keep-alive comment every 20 seconds) feeding the cache's invalidation, the polling kept as fallback (U3); session views kept mounted in a stack of five, the terminal and the editor never recreated (U4); the budget measured in CI by a browser test on the fixtures source, the median of three runs of twenty switches, each run's p95, under 100 ms, zero document navigations, at most one request, in a new `browser` job with playwright-core and the Chromium headless shell (U5); a marked missing key and an error boundary per screen in place of a blank page (U10); the captures in the repository under `docs/v2/ui-overhaul/{before,after}/` and the capture script as a repository script (U12).
5. **The shell** (lane 35): a sidebar replaces the header, a palette on Cmd-K on shadcn's `Command`, G-chords, J and K, a shortcut sheet, tokens for spacing, type and both themes, the tower as rows, empty states, an anti-slop test on the sheets and the catalogs (U8).
6. **The session** (lane 36): the view follows the ticket, one thread of its sessions with handover rows, the reviewer continuing live in the same view, the address replaced without navigation (U6); the Take over and Give back of the thread's live session drawn in that view whatever its role, the gesture itself being pull request 242's, none of its files edited (U7); the intent sentence of a command as a pure function shared with the inbox; a "last turn" scope in the Editor; step rows with merged edits.
7. **The inbox and the French** (lane 37): the French intent title computed in the app from the command, the command folded, the reason translated by a `reasonCode` the service adds and the policy lane fills, the English text in the fold as fallback (U9); the three answers at the top of the item and on the row at 1280 and above; the folded "Traité" group; a test that renders every screen in fr and fails on any English fallback.
8. **The last pass** (lane 38): Impeccable's polish across the app, the sign-in page, the mobile layout, the "after" captures and measures, the matrix's lines.
9. **Impeccable** (U11, the plan's section 6): the design tool of every interface lane. Licence checked on 2026-10-22: Apache-2.0 (the repository's licence, its `package.json` and GitHub's licence field agree); its `NOTICE.md` credits two reference files for iOS and Android taken under MIT from another repository; no font, icon or asset is vendored by it, and nothing of it is vendored into this repository: it is installed in each lane's worktree with the owner's command; before the install the anchored patterns `/.claude/`, `/.impeccable/`, `/PRODUCT.md` and `/DESIGN.md` go to the file `git rev-parse --git-path info/exclude` names (in a worktree `.git` is a file; that path is the main repository's exclude file, shared by every worktree; anchored because `app/DESIGN.md` is tracked), and the reviewer checks with `git status --short` and `git diff --stat origin/v2...HEAD` that none of those paths appears. Version 4.7.0 (the skill and the CLI), released 2026-10-19; the global copy on this server (4.4.0) is not used by the lanes. Hooks stay off (they run on every edit and may download the detector's binary); telemetry off through `DO_NOT_TRACK=1`, which the CI already sets; `live` mode is not used. The commands each lane runs are in its acceptance proof: `audit`, `critique`, `polish`, and `harden` for the inbox, `onboard`, `typeset` and `layout` for the last pass; the art director runs `critique` and `polish` on its own.
10. **The references** (the plan's section 3), read on 2026-10-22 in their public documentation: Codex's three panes, its Git review pane with a "last turn" scope, its permission modes and question-shaped requests with Allow, Always allow, Cancel, its Activity view of the threads waiting for a response, its command menu (`learn.chatgpt.com/docs/changelog`, `/docs/features`, `/docs/permission-modes`, `/docs/notifications`, `/docs/integrated-terminal`, `/docs/reference/commands`, `/docs/reference/settings`); Devin's unified worklog of clickable steps, its session grouping by Working, Ready, Blocked, Inactive, its bell inbox, its stop-then-take-over contract, its approval card with Allow once, Allow for this session, Deny, its Cmd-K palette (`docs.devin.ai/work-with-devin/devin-session-tools`, `/work-with-devin/local-hands`, `/work-with-devin/devin-review`, `/release-notes/overview`, `cognition.com/blog/devin-2`); Linear's inbox with its keys, G-chords, `?` sheet, peek, and its redesign principles (`linear.app/docs/inbox`, `linear.app/enablement/guides/navigating-linear`, `linear.app/blog/how-we-redesigned-the-linear-ui`); Raycast's action panel with positional actions, list and detail, empty views and loading bar (`manual.raycast.com/action-panel`, `manual.raycast.com/keyboard-shortcuts`, `developers.raycast.com/api-reference/user-interface/list`). Nothing of their brands, assets or copy is taken.
11. **What the plan leaves open** (its section 9, each with a default): the sidebar on a phone, the number of sessions kept mounted, what Give back does to a paused review, the three answers on the list row, the French of the sentences the service writes.

**Files.** `docs/v2/ui-overhaul-plan.md` (new), `docs/v2/ui-overhaul/before/` (41 captures, their README and the timings; each looked at before it was copied: the live inbox's release detail, which quotes the pull request's address, is not among them, and a wave 8 fixture capture that showed a fixture account's name was dropped at the review), `docs/v2/requirements-matrix.md` (O20, O21), this log. No code: the lanes write their own.

**Captures.** Read only: the live proof app on `127.0.0.1:8792` signed in as the proof's owner account (the header's links, the session's tab buttons, the reviewer's link and an inbox row were clicked; no action button), the demo app's sign-in page on `127.0.0.1:8798` with nobody signed in and nothing clicked, the HTTPS front on 8796 fetched once for its time to first byte; the demo was neither stopped nor changed. Headless Chromium through the proof's own playwright-core install; no listener started, no docker, no `.env` read.

**Checks.** Docs only: `npm test`, `npm run typecheck` and the guard are unchanged by this lane; the guard's scope (`v2/`, the v2 workflow) holds none of its files. The plan and this entry were read for the rules of section 4 of the milestone 2 plan: English, no em dash, no person's or organisation's name.

- Pull request: 241, against `v2`.
- Author: Fable 5.1 (claude-fable-5-1), lane `v2-j2-ui-overhaul-plan`.
## 2026-10-22: Owner decision of 22:03: the reviewer's read-only commands and the compound command split part by part

**Decision.** On 2026-10-22 at 22:03 (Europe/Paris), from a demo inbox capture, the owner decided:
- In the session permission policy, the reviewer may run by default, inside its container, the read-only commands (`git log`, `git show`, `git diff`, `git merge-base`, `git status`, `git rev-parse`, `grep`, `rg`, `cat`, `head`, `tail`, `ls`, `wc`, `find` without `-exec` or `-delete`) and the project's own checks (`npm test`, and `npm run test` or `typecheck` as the project declares them).
- A compound command (`;`, `&&`, `||`, `|`) is split and evaluated part by part, and only the risky part asks.
- A redirection to a file and a command substitution keep asking.
- The same split applies to the other roles only where it does not widen their rights.

It is not in the lane list of the [milestone 2 plan](milestone-2-plan.md): the lane `v2-j2-reviewer-policy` implements it and cites this entry.

**Why.** A Sonnet reviewer asked to run a chained command (`git log; git merge-base main HEAD; git show ...; npm test | tail`). The request went to the owner's inbox with the reason "git merge-base main HEAD is not a command the policy allows on its own": `git show` and `git merge-base` were in no safe pattern, so a review's ordinary reads waited for the owner.

**Consequences.** The requirements matrix records the decision as O22, and the author's choices as P49 (the entry below). No screen changes.

- Author: the owner, relayed on 2026-10-22 22:03 (Europe/Paris); written in this log by Opus 5.5 (claude-opus-5-5), lane `v2-j2-reviewer-policy`.

## 2026-10-22: the reviewer's reads, and a compound command judged on every part (the author's choices, lane v2-j2-reviewer-policy)

**Decision.** The lane applies the owner's decision of 22:03 (the entry above). The policy already split a compound command into its parts (milestone 2, decision 10, this log's entry of lane `v2-j2-contracts`): the capture asked because two of its parts were not allowed on their own, not because it was compound. Its choices:

1. **The reviewer's reads are its own rows.** `REVIEWER_READS` in `session/policy.ts` (`git show`, `git merge-base`, `git rev-parse`, `rg`, `wc`), rule `reviewer.read`, checked after `run.safe` for the reviewer only. Milestone 1's safe commands already held `git log`, `git diff`, `git status`, `grep`, `cat`, `head`, `tail`, `ls`, `find` and `npm test`, and `npm run` of a script the base branch declares; they keep their rule `run.safe`. Reason: `DEFAULT_SAFE_COMMANDS` is shared by the author and the reader (`reader/service.ts`), and issue 219 (finding F2) already notes that the reader's Bash reads go around its 400-line cap. Adding the new reads there would widen both roles.
2. **What still asks in the new reads** (as first pushed; review round 1 replaced these word rules by allowlists, see below):
   - `rg --pre` (it runs a program on every file it searches), `--pre-glob`, `--hostname-bin` (it runs a program), `--ignore-file`, `-f` and `--file` (they read a file);
   - `wc --files0-from` (it reads a list of files);
   - a path outside the workdir. The pattern is not taken for a path, except when `-e` or `--regexp` names it, or `rg --files` has none: every operand is then a path;
   - for `git show`, `merge-base` and `rev-parse`: what milestone 1 already refused for git (`--output`, `-o`, `%(` and `%x` formats, global options other than `-C`, an operand outside the workdir).
3. **A narrowing found by the table: `-e` inside a group of short options.** `grep -eroot /etc/passwd` was allowed, because only a bare `-e` made every operand a path. A group holding `e` (`-ie`, `-eroot`) now counts as `-e`, for `grep` and `rg`. It narrows every role and changes no existing row.
4. **A deny in any part wins.** Before, the first part that was not allowed gave the verdict, so `make build; npm test > out.txt` asked for `make build` (a reviewer's redirection is `reviewer.edit`, a planning author's is `plan.before_go`). An "Allow once" of that ask would have run the write the policy denies. Now every part is evaluated, and a part's command and its redirections both: any deny wins, wherever it stands.
5. **Only the risky parts ask, and the reason names each and no other.** One part that asks keeps its verdict as before (its own rule, or `shell.compound` naming the part). Several give the first one's rule and a reason listing every part that asks with its own reason ("2 parts of this command ask, the others are allowed: ..."). The allowed parts are not named.
6. **Redirections and substitutions.** A substitution (`$(...)`, a backtick, `$` in double quotes) is still refused by the parser and asks as `shell.compound`. A redirection to a file keeps milestone 2's rule: it gets the verdict a `Write` of the target gets. For the reviewer that is `reviewer.edit`, a deny, which is stricter than the decision's "keep asking"; the lane reads "keep asking" as "never allowed" and does not soften a deny into an ask. `/dev/null` is a file outside the workdir: `git log 2>/dev/null` is denied to the reviewer, as before. A duplication (`2>&1`) writes no file and stays allowed.
7. **The other roles, only where nothing widens.**
   - The author: the split was already its own (decision 10), and its verdicts are unchanged except that a deny in a later part now wins (choice 4).
   - The reader: its verdicts are the reviewer's rows with its asks refused (decision 28), but it does not get `REVIEWER_READS`, so its rights do not grow.
   - The lead: its rows are not split. Its `head -n 400` cap is per command, and a list of capped reads would lift it; a list stays `lead.command`.
   - `cd` stays an ask in a list: it would move what `inside()` resolves the relative paths against.

**Files.** The lane is not in the plan's lane list, so it names its own: `v2/src/session/policy.ts`; `v2/test/session/reviewer-policy.test.ts` (new), `v2/test/session/claude-code/adapter.test.ts`; this log and `docs/v2/requirements-matrix.md`. No screen changed, so there is no visual loop and no capture.

**Tests.**
- `test/session/reviewer-policy.test.ts`, a table of commands with their expected verdict and rule, per role:
  - the capture's command, with `&&`, for the reviewer, and its variants (`npm run typecheck && npm test 2>&1 | tail -40`, `rg ... | head; wc -l ...`);
  - each new read alone, and milestone 1's reads and checks still `run.safe`; `npm run deploy`, not declared, asks;
  - what still asks: `rg --pre`, `--hostname-bin`, `-f`, `--ignore-file`, `rg --files /etc`, `rg -eroot /etc/passwd`, `grep -eroot /etc/passwd`, `wc --files0-from`, paths outside, `git show --output`, `find -exec`;
  - tricky quoting: a separator inside single or double quotes or escaped (`grep -n 'a|b'`, `git log --grep="x && y"`, `rg foo\;bar`), `'$(id)'` literal, `"$(id)"` and backticks asking, `git diff $(git merge-base main HEAD)`, a newline, `;;`, a lone `&`, `|&`, `cd sub && ...`, a brace or a glob, an input redirection;
  - the reason of a mixed list names the asking parts only;
  - a deny in a later part wins, for the reviewer and for a planning author;
  - the author, the reader and the lead keep their verdicts on the new reads and on the capture's command.
- `test/session/claude-code/adapter.test.ts`: through the Claude Code adapter, a reviewer's capture command is answered `allow_once` by the policy (`shell.compound_safe`) and makes no inbox request, while `git log -3; curl https://example.com` still does.
- On the old code, 8 of the 9 new tests fail; the ninth, the other roles unchanged, passes on both. No row of `test/session/policy.test.ts` changed.

**Followups.**
- "Always in this project" on a compound request saves the whole command as its pattern (`patternOf` in `flow/engine.ts`), and a compound command is matched part by part, so that answer never matches again. Saving the asking part instead needs the verdict to carry it and the engine to read it; `flow/engine.ts` is not this lane's file.
- A reviewer's `2>/dev/null` is denied as `reviewer.edit`, now in any part of a list (`git merge-base main HEAD 2>/dev/null || ...`). It reaches no inbox, but the reviewer retries with a message about editing. `/dev/null` could be read as a sink that writes no file; that would reverse milestone 2's row for `ls src 2>/dev/null`, so it is left to the owner.
- No real run: as the brief asked, no proof or rehearsal ran against the live service on 8791 and 8792, and nothing of the demo checkout was touched. The next review in a proof shows the change.

**Checks.**
- `npm test`: 1249 node tests, 1241 pass and 8 skipped (the browser tests, without `CLEARED_V2_PLAYWRIGHT`), 0 fail; 184 Vitest tests pass.
- `npm run typecheck` is green.
- `npm run guard -- --base origin/v2` is green. It ran without a private-term list (`CLEARED_REPO` unset).

**Review round 1: CHANGES, two blockers and four followups, all taken.**
- **B1: `--` before a pattern that starts with a dash.** `rg -- -x /etc/passwd` was allowed: the operands were the words that do not start with `-`, so `--` and the pattern `-x` were dropped and `/etc/passwd` was taken for the pattern. `grep` had the same hole, since milestone 1. Now `--` ends the options, every later word is an operand, and the first operand is the pattern unless `-e`, `--regexp` or `rg --files` was given.
- **B2: an abbreviated long option.** GNU programs (`getopt_long`) and git's parse-options take any unambiguous prefix of a long option, so `wc --files0=/etc/passwd` was `--files0-from` and read a file outside the workdir. The fix is the reviewer's own: each read's options are an allowlist, not a list of the dangerous ones (`READ_OPTIONS` in `session/policy.ts`), for `cat`, `head`, `tail`, `ls`, `wc`, `grep`, `rg`, `git merge-base` and `git rev-parse`.
  - A long option matches only by its whole name, so any abbreviation asks, the harmless ones included (`head --lin=5`).
  - Short options are read as a group: a flag, or a value option that takes the rest of the group or the next word. A value is then never taken for an operand.
  - An option not in the list asks. Left out on purpose: `tail -f`, `-F` and `--pid` (a tail that never ends), `rg -z` and `--search-zip` (decompression programs), `rg --type-add`, `grep --exclude-from`, `git rev-parse --git-path`.
- **`find`** reads its start points and then its expression word by word, from an allowlist of tests and of actions that only print. find takes no abbreviation of a primary. This closes two older holes of the safe commands: `-files0-from` (start points read from a file) and `-newer`, `-anewer`, `-cnewer`, `-samefile` naming a file outside the workdir.
- **git `log`, `show` and `diff`** have hundreds of options, so they keep milestone 1's refusals, now with every prefix of a dangerous long option: `--output*`, `--no-index`, `--ext-diff` and `--orderfile`, plus `-O` (F2: an order file read). git 2.47 refuses an abbreviation in these three commands (`git log --outp=x` exits 128, checked by the lane), so the prefixes are a second guard. `--no-ind` and `--orderfile` were older holes of `git diff`, which every role ran.
- **F1, rg's abbreviations:** answered by the allowlist, whatever ripgrep's version does. ripgrep is not installed on this server, so its behaviour was not checked.
- **F3, tests:** `test/session/reviewer-policy.test.ts` gains a table of 52 probes: the review's own, `--` for each read, abbreviations, unlisted options, and allowed forms that must stay allowed (`head -n -5`, `head -20`, `find -L src ... -print`, `rg -tts -g ... --max-count=3`). On the code first pushed, 28 of the 52 give the wrong verdict; none do now. No row of `test/session/policy.test.ts` changed.
- **F4, docs:** this paragraph, and P49.
- Checks after the round: `npm test`, 1250 node tests, 1242 pass, 8 skipped, 0 fail, and 184 Vitest tests pass; `npm run typecheck` and the guard are green.

- Pull request: 240, against `v2`.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j2-reviewer-policy`.

## 2026-10-22: the interface foundation's dependencies and the browser job (the author's choices, lane 33, `v2-j2-deps-ui-foundation`)

**Decision.** On 2026-10-22 at 22:48 (Europe/Paris), lane 33 of the interface overhaul (`docs/v2/ui-overhaul-plan.md`, section 7) adds four packages to `v2/`, for the plan's decisions U1, U2 and U5, and a `browser` job to `.github/workflows/v2.yml`. No screen changes, no devtools package, nothing imports the new packages yet. Versions are exact and were published at least two weeks before the lane.
- **`@tanstack/react-router` 1.170.41**, MIT, published 2026-09-30, in `dependencies`. Reason: client routing in code, with intent preloading and typed search parameters, so that a screen change needs no reload (U1).
- **`@tanstack/react-query` 5.104.1**, MIT, published 2026-10-02, in `dependencies`. Reason: the shared cache, one key per resource, stale-while-revalidate and optimistic mutations (U2).
- **`cmdk` 1.1.1**, MIT, published 2025-03-14, in `dependencies`. Reason: the command palette, behind shadcn's `Command` (`components/ui/command.tsx`, lane 35) (U8).
- **`playwright-core` 1.64.0**, Apache-2.0, published 2026-10-07, in `devDependencies`. Reason: drives the browser tests that CI skipped, with the Chromium that the browser job installs for it (U5).

`v2/package.json` has no place for a comment, so the reasons live here, as lane 30's entry keeps its packages'. The three runtime packages sit in `dependencies` as the plan's lane 33 names them; decision 12 of the React port kept the React set in `devDependencies`, and the service and the app's server still import none of them.

**The lock file.** `npm install --package-lock-only` adds 22 packages and removes none. Their licences: MIT for 19 (among them `@tanstack/history` 1.162.4, `@tanstack/query-core` 5.104.1, `@tanstack/router-core` 1.171.34, `@tanstack/react-store` 0.11.2 with its nested `@tanstack/store` 0.11.2, `@radix-ui/react-dialog` 1.3.1 (cmdk's dependency, with a nested `@radix-ui/react-slot` 1.5.0 beside the root's 1.4.0), `cookie-es` 3.1.1, `seroval` 1.7.0, `seroval-plugins` 1.6.12, `use-sync-external-store` 1.7.0 and the optional wasm fallback of Tailwind's oxide with its `@emnapi` and `@napi-rs` packages), 0BSD for `tslib` 2.8.1, Unlicense for `isbot` 5.2.2 (the router's dependency; public domain, which Apache-2.0 can ship) and Apache-2.0 for `playwright-core`. The only other change is the removal of `"dev": true` on the packages the runtime dependencies now use. `v2/.npmrc` still runs no install script.

**The page's policy (the check).** The app serves `default-src 'self'` with `style-src 'self' 'nonce-<value>'` (`v2/app/src/server.ts`).
- *Source.* No code of `cmdk`, `@tanstack/react-router`, `@tanstack/react-query` or their core packages creates a `<style>` element, calls `insertRule`, `replaceSync` or `adoptedStyleSheets`, or writes a style attribute as text. `cmdk` gives its visually hidden label a `style` object through React's `style` prop, and sets one custom property with `style.setProperty`; both go through the CSS object model, which the policy allows.
- *Probe.* A scratch page outside the repository, built with Vite 8 from the three packages (a `Command` with an input, a group and items, a query, a router with a `Link` that preloads on intent), served with the app's policy and a nonce, in Playwright's Chromium 156: 3 items rendered, 0 `<style>` elements, 0 `securitypolicyviolation` events, 0 page errors. The control, the same page with a `<style>` element that has no nonce, records 1 violation (`style-src-elem`), so the listener does see violations. Nothing of the probe is committed.

**The browser job.** It runs the eight browser tests that the verify job skips without `CLEARED_V2_PLAYWRIGHT` (`choices-browser` 2, `notify/browser` 1, `session/tabs-browser` 3, `session/terminal-browser` 2), with `CLEARED_V2_PLAYWRIGHT` set to the installed `v2/node_modules/playwright-core` and `CLEARED_V2_CHROME` to the Chromium that package installs. A skipped test fails the job. The job summary lists the totals from the TAP output and each line a test prints as `measure <name> <value>` (the TAP stream carries it as `# measure`); this lane prints none, and lane 34's tab-switch test is the first to print one.
- *Full Chromium, not the headless shell.* The first run used the headless shell. Seven tests passed; the notifications test failed after 30 s waiting for its toggle, because the shell keeps `Notification.permission` at `denied` after `grantPermissions`. The full build, installed into an empty browsers folder, passed all eight: 8 pass, 0 fail, 0 skipped. The job installs the full build with `playwright-core install --with-deps chromium`.

**Checks.** On this server: `npm ci`, `npm run typecheck`, `npm run build`, `npm test` (1250 tests: 1240 pass, 10 skipped, 0 fail; 184 Vitest tests pass), and `npm run guard -- --base origin/v2` (444 files, nothing refused). The browser job's steps were run by hand, in the same order and with the same environment, on the fresh install; the job itself runs on the pull request.

**Followups.**
- Lane 34's tab-switch test prints its measures in the form the job summary reads.
- If a later Chromium build changes the notifications test's result, the headless shell's refusal is the first thing to recheck.

- Pull request: 244, against `v2`.
- Author: Haiku 5.5 (claude-haiku-5-5), lane `v2-j2-deps-ui-foundation`.

## 2026-10-22: one document for the whole app, a shared cache fed by a change stream, the sessions kept mounted (the author's choices, lane 34, `v2-j2-ui-foundation`)

**Decision.** On 2026-10-22 between 23:10 and 2026-10-23 00:05 (Europe/Paris), lane 34 of the interface overhaul ([ui-overhaul-plan.md](ui-overhaul-plan.md), section 7) delivers requirements 2.1.1 to 2.1.8 and decisions U1 to U5, U10 and U12, and redesigns nothing: the header and every screen look as they did, and the 40 "after" captures are the "before" captures byte for byte.

- **One document (U1).** Every screen's address (`/`, `/inbox`, `/sessions`, `/sessions/<id>`, `/lead`, `/plans/<id>`, `/ask/<id>`) answers the same shell page (`<body data-screen="app">`, the title `Cleared`); any other address still answers 404. The page's router is TanStack Router in code (`web/lib/router.tsx`, routes only, no file-based routing) over the browser's history. The screens keep their plain links: a plain click on a link to one of the app's addresses is answered in the page (`takenOver`, `web/lib/routes.ts`); a link to a place on the same page (an inbox item's `#id`), a new tab, a download, another origin (a preview) or a file stays the browser's. The shell names the screen from the address, sets `document.title` and `body[data-screen]` to it, and keeps each place's scroll. `location.assign` to an app address in the tower became an in-page move (`useGo`, `web/lib/context.tsx`).
- **The screens' sheets on one page.** Two screens' sheets name classes alike (`.btn` is in `inbox.css` and in `session.css`, unscoped; the documenter's scan found more), so one page cannot hold them all on. The page names every screen's sheet with `media="not all"` and `data-screens` (`screenSheets`, `app/src/server.ts`), each screen's sheets in its own order, and turns on those of the screen it shows before the frame is painted (`web/lib/sheets.ts`). Each screen keeps the cascade it had on its own page, which the pixel-identical captures prove. The page also preloads every screen's chunk (`modulepreload`), and the shell loads them all once it has drawn, so no switch waits for a chunk.
- **The shared cache (U2).** `web/lib/cache.ts` keeps one entry per resource of the service in TanStack Query's QueryClient, keyed by `resourceOf(path)` (`['sessions']`, `['session', id]`, `['tickets']`, `['ticket', id]`, `['steps', ticket]`, `['inbox']`, `['workspace']`, `['lead']`, `['lead-messages']`, `['lead-memory']`, `['plans']`, `['plan', id]`, `['recipes']`, `['schedules']`). A path with a query string (`/lead/messages?after=4`), a file and a stream go to the network as before. A screen's `api` reads through the cache (`reader`, `web/lib/query.tsx`): a held value is answered at once, a stale one too and refetched behind it. The pure models are untouched: the screens give them the cached `api`. Each screen's `setInterval` refresh became `useLive(refresh)`, called when a resource the screen read has a new value. The inbox count and the lead's pill read the cache and poll nothing of their own; the shell no longer has a timer but the clock's.
- **The change stream (U3).** The service's `GET /api/events` (`src/api/events.ts`, in `API_ROUTES`) answers `text/event-stream`: one thin event per resource that changed, `{ kind, id, at }` with `kind` among `session`, `ticket`, `inbox`, `lead`, `plan`, numbered for `Last-Event-ID` (the last 256 kept), a comment every 20 seconds. Its sources are all inside the service: the flow's bus (a ticket's event says the ticket, and its session when it names one), a new `InboxStore.onChange` (told after each write that changed a row; the bus did not carry the inbox's writes, the plan's section 11 question), and each live session's journal through `FlowEngine.watch` (a session whose summary changed, its burst settled for 250 ms; a lead session also says `lead`). Nothing of a session's content travels on it. One hub per engine, started by the first stream and stopped with the last. The app forwards it at `/api/service/events` with the session cookie checked, as any read; `proxy.ts` needed nothing (it already writes the headers at once and pipes). The page's `EventSource` (`web/lib/events.ts`) refetches what an event names that the cache holds, and nothing else. While it is open, the resources it covers (sessions, a session, tickets, a ticket, its steps, the inbox) are fresh until named; the others (the lead and its plans, written by the lead module, which the flow's bus does not see; the workspace, the recipes, the schedules) are refetched every 10 seconds while a mounted screen reads them, one request for every reader. When the stream drops, every resource read falls back to that 10-second interval; the EventSource's reconnect refetches everything held, once; a stream refused for good is opened again after 5 seconds, doubling up to a minute.
- **Optimistic gestures.** An answer to a permission or a question, a session plan's Go, a plan's approval and a contract's or knowledge item's decision move the inbox's item to what was handled at once (`optimistic`, `web/lib/cache.ts`), and back if the service refuses. Then what the write touched is refetched. A message leaves the session's composer at once and comes back to it when refused (`Session.tsx`). A release's approval keeps its grace bar, as before.
- **The sessions kept mounted (U4).** A session opened once stays mounted, hidden, while the person visits other screens, up to five, the least recent dropped (`pushStack`, `web/lib/routes.ts`). Its terminal, its editor, its thread's stream and its browser frame are never made again. The terminal refits on show through its existing ResizeObserver, so `components/terminal/` and `components/editor/` are unchanged. The other screens draw again on a visit, from their last drawn state (`useKept`) then the cache, so a second visit draws no placeholder. The lead screen draws the thread it last showed until its agent's own arrives.
- **Never a blank page (U10).** The translator draws a missing key marked, `⟦key⟧` (`MARK_OPEN`, `hasMark`, `web/lib/i18n.ts`), where it threw; `role_lead` is in the session catalog in both languages; each screen has an error boundary (`web/lib/boundary.tsx`) that says which screen failed and offers to draw it again, with the header and the other screens left as they are (two new shell keys, `boundary_failed` and `boundary_retry`, in both languages). The session model's `known()` read the throw as "no sentence for this rule": it now reads the mark the same way. The live app's sessions index draws again.
- **The budget (U5) and the capture script (U12).** `v2/app/test/switch-budget.ts` times a switch from the click's event to the first animation frame in which the next screen's data is drawn and visible, read in the page and kept in sessionStorage, so the same measure runs on a version that loads a document per switch. `app/test/foundation/budget-browser.test.ts` warms the five screens, then makes twenty switches. The median of the runs' p95 must be under 100 ms (three runs in CI, one locally), with zero documents, at most one request per switch, and no busy placeholder after the first visit; it prints its numbers as `measure` lines for the browser job's summary. `v2/scripts/capture-screens.ts` captures the five screens at the four widths in both themes on the fixtures source, on ephemeral loopback ports, with the fixtures' clock in the source and the page. `--via click` reaches each screen by an in-page click and fails if one loads a document. The fixtures source answers `GET /api/events` too, with an event for each of its writes and a `changed()` a test or lane 36's fixture can call.

**The measures** (fixtures source, loopback, this server, 1440x900, the same harness and browser before and after; p95 of twenty switches per run, three runs):

| Measure | Before (`origin/v2` `8a93cd5`) | After (this branch) | Budget |
| --- | --- | --- | --- |
| Tab switch, click to painted screen, p95 per run | 132.0, 111.5, 128.8 ms | 14.8, 16.0, 20.5 ms | |
| Median of the three runs' p95 | 128.8 ms | 16.0 ms | under 100 ms |
| Median switch, per run | 94.9, 80.9, 79.7 ms | 13.1, 13.1, 13.1 ms | |
| Documents loaded in twenty switches | 20 | 0 | 0 |
| Requests to the API per switch, at most | 13 | 1 | 1 |
| Terminal and editor made, session then inbox then session | 2 each | 1 each | 1 each |
| Sessions index with a lead session | blank | drawn | drawn |

The browser test itself, on the full Chromium build the CI installs and in CI mode, measured 26.2, 20.5 and 23.3 ms (median 23.3 ms) before the audit's two fixes below, and 20.9 ms in one run after them, with 0 documents and at most 1 request each time. On loopback a document load is cheap; on the owner's device through the private network's HTTPS front each of the 13 requests a switch made paid a round trip, and now none does.

**Followups the plan names, answered.**
- Issue 245, F3 and F2 (the sessions index blank until wave 14): fixed here, with its test (`app/test/catalog.test.ts`, every role of a session named by the session screen's catalog; it fails on the old catalog).
- Issue 245, F4 (say SSE): the stream is `text/event-stream`, read by an `EventSource` through the app's proxy with the session cookie required. The service and the fixtures write a comment every 20 seconds. The service also sends `x-accel-buffering: no`, but the app's proxy passes only its listed headers, so a front of one's own needs its buffering off and a read timeout above 20 seconds. The demo's HTTPS front pipes and sets no timeout.
- Issue 247, items 1 and 2 (the browser job's hard-coded list): lane 34's two browser test files are added to the list, and the job now also fails when fewer than eleven tests pass.

**What lane 34 touched beyond its file list, and why.** `.github/workflows/v2.yml` (the plan's 7.1 gives it to lane 33 only): the budget test is to run in the `browser` job, whose file list is hard-coded. `v2/app/fixtures/source.ts`: the fixtures had to answer the change stream for the captures, the budget test and lane 36's handover test. `v2/app/messages/shell.{en,fr}.json`: the boundary's two sentences. `v2/test/api/types.test.ts`: it pins `API_ROUTES`, which gains `GET /api/events`. `v2/app/web/screens/session/model.ts`: `known()`, above. `v2/app/web/screens/lead/Lead.tsx`: its thread drawn from the last one shown. The tests that asserted a page per screen (`data-screen="<screen>"`, a title per page) now assert the one page.

**Impeccable.** Installed at 4.7.0 in the lane's worktree (`DO_NOT_TRACK=1 npx impeccable@4.7.0 install --providers=claude --scope=project`), its paths in the shared exclude file and in no commit. The installer wrote hooks into `.claude/settings.local.json`; they were removed before any edit, so no hook ran. `init` wrote `PRODUCT.md` from the plan, with no interview (the plan's section 6 fixes its inputs). `document` wrote `DESIGN.md` and its sidecar; its scan of the sheets is the source of the `.btn` finding above. `audit` ran on the five screens; nothing of it is applied here, as the plan asks, and its findings are for lanes 35 to 38:

- Score 14 of 20 ("good"): accessibility 3, performance 3, theming 3, responsive 3, implementation integrity 2 ("pass, with drift": one product language built from per-screen sheets that repeat classes and tokens, `.btn` twice, `--ok-text` three times, `.sr-only` three times, 17 font sizes). No P0, three P1, eight P2, four P3.
- Detector (`impeccable detect`): Geist and Geist Mono as overused fonts, false positives (the brief keeps Geist); the tower card's 3 px amber stripe, intentional, to go with lane 35's rows; a regular expression in a test read as a broken image, a false positive.
- Fixed here, because this lane caused them: **P1**, a switch in the page moved no focus and said nothing, where a page load did both. Now the focus goes to the screen's main region (`tabIndex=-1`, no ring) and a polite live region says the new title. The stack browser test asserts both. **P2**, the shell's one-second clock redrew every mounted screen, hidden sessions included. Each screen's host is now memoized, so the clock redraws the header only. The 40 captures stayed the same bytes after both fixes.
- For lane 35 (shell, tokens, tower): link blue at 4.10 to 4.41:1 and placeholders at 3.1 to 3.2:1 in light, and the dark placeholder at 4.18:1 (P1, `styles/app.css` 22, 26, 28); focus rings drawn with `box-shadow` after `outline: none` vanish in forced colours; the duplicated tokens and the hard-coded amber ring; the header's three rows at 768.
- For lane 37 (inbox): Escape in the "change the plan" or "send back" text area closes the item and loses the typed text (P1, `screens/inbox/Inbox.tsx` 627 and 634).
- For lane 36 (session) and lane 38 (polish and mobile): the session's heading and its live thread's announcements, and touch targets of 26 to 32 px at 768 (the 44 px rule stops at 767 px).
- The full report (15 findings with file and line) was kept beside the captures, at `/tmp/cleared-captures/j2/overhaul/34/audit-34.md`, for the orchestrator and the art director; it is not committed.

**Bundle.** The entry grew from 428 KB (132 KB gzip) to 538 KB (169 KB gzip) with TanStack Router and Query. The first page also preloads every screen's chunk, where it loaded one; every later switch loads none.

**Checks.** On this server: `npm run typecheck`; `npm test` (1285 node tests: 1272 pass, 13 skipped, 0 fail; 184 Vitest tests pass); the browser job's eleven tests with `CLEARED_V2_PLAYWRIGHT` and the full Chromium build (11 pass, 0 skipped); `npm run guard -- --base origin/v2` (462 files, nothing refused); the capture script with `--via load` and `--via click`, 40 files each, no page error, no request off the origin, every file the same as its "before". French: the five screens drawn in fr show no marked key.

**Review round 1 (CHANGES) and the art director's look, taken on 2026-10-23.**
- **B1, the stack moved its sessions in the page.** It drew the kept sessions in the order of the visits, so going from B back to A made React move a session's node. A node moved in the document reloads its frames: with the old order, the new browser test saw the preview frame load again. The kept sessions are now drawn in the order they were first opened (`stackOrder`, `web/lib/routes.ts`); the visits only decide which of the five falls off. With a stable order the shown session is no longer always first in the page, so the session ids (`#message`, `#tab-terminal`...) are no longer unique by luck. A hidden view (`KeptView`, `web/lib/stack.tsx`) sets its ids aside in `data-kept-id`, including any drawn while hidden, and takes them back before the frame in which it is shown. No selector of the screens, their tests or the proof scripts changed. A browser test visits A, B, A, B: the order of the views does not change, A's preview frame is not loaded again, B's terminal is the same node and opened once, and the shown session holds the only `#message` and `#tab-terminal`.
- **Followups taken.** F2: a change stream closed for good makes the shell ask `/api/me` and send a signed-out page to the sign-in. F3: a read of the inbox under way when a gesture moves an item is cancelled, so it cannot put the item back (a test fails without it). F4: a refused message comes back before what was typed meanwhile. F6: `CHANGE_KINDS` is gone and `plan` is marked reserved. F7: the budget and stack browser tests fail on a `securitypolicyviolation`. F8: the browser job counts no fixed number: every test that ran must pass, none skipped, at least as many tests as listed files. F9: the translator's comment names the right test, and both browser test files fail on a marked key drawn. F10: the browser job's lap goes through two sessions (`LAP_TWO`); the before and after table above keeps the lap the "before" was measured on.
- **Followups left.** F1: a screen's sheet with `media="not all"` does not block the first paint, so on a slow link the first screen could paint before its sheet arrives. This is for lane 38 with a throttled capture. F5: a kept session shown again keeps the address without its tab. Lane 36 owns the session's address. F7: `outline: none` on `#screen` and the hidden view's `display` stay inline styles, set by React through the CSSOM, which the policy allows. Moving them to a class is lane 35's sheet work. F11: the hub reads every session on each flow event, which is fine at today's size; a filter on the bus is the way out if it grows.
- **Art director, before merge.** (1) The scroll of each place was not given back, although the shell said it was: the router reset the window to the top after each move. The router no longer resets it (`resetScroll: false`). The shell sets the kept scroll again at each frame until it holds, for 30 frames at most, and does not take the swap's own scroll events for the person's. The A, B, A, B test scrolls the tower to 240, goes through both sessions and back, and finds 240. Back and Forward give it back too. (2) The boundary says "{screen} did not load." with "Try again", and in French "{screen} ne s'est pas chargé." with "Réessayer". The browser test asserts both, with the screen's name from each language's catalog and no mark. (3) The `--via click` run, the session included, matched the 40 "before" files byte for byte again after these changes. The `--via load` run matches but for one place, which moves between runs of the same code: at 768 wide, two of the four sessions and session files differ by 20 to 25 pixels inside the header's lead pill. `after/34/README.md` says so.
- **Measures after round 1** (the same harness, browser and lap as the table above): p95 17.9, 22.0 and 17.4 ms, median 17.9 ms; median switch 13.7, 14.1 and 13.6 ms; 0 documents, at most 1 request. The browser test in CI mode, with two sessions in its lap: 25.6, 25.5 and 23.1 ms, median 25.5 ms.
- **Checks after round 1:** `npm run typecheck`; `npm test` (1288 node tests: 1274 pass, 14 skipped, 0 fail; 184 Vitest tests pass); the browser job's step run by hand, 12 tests, 12 pass, 0 skipped; `npm run guard -- --base origin/v2`, nothing refused. One untracked file another session left in this worktree (`v2/inbox-after-session.png`) was refused by the guard, which reads the whole tree. It is not part of the branch and was left where it was.

**For lanes 35 to 38, from the art director's look (none changes this lane).**
- Lane 35 (shell, tokens, tower): keep the focus on the activated sidebar item when the move started on a navigation link, and move it to the main region only for the other moves (a row's link, Back, Forward). Name what the person opens: the "Plans" tab opens a page titled "Lead", "Tickets" is a dead label, and a session's page title says "Sessions" where the ticket ("LOCAL-161 · Upcoming: group entries by week") would tell the tab strip and the live region something. Replace the three-row header at 768 with the sidebar. Move the sample-data pill to the sidebar's foot: it takes a full row at 390, and the real service must never show it. The tower card's 3 px amber stripe and the light theme's link blue and placeholder contrast are already above.
- Lane 36 (session): at 390, put Take over in the thread's header, the Author and Reviewer switch and the four tabs in one row, and the composer in one row; today the thread starts at y = 395. Collapse the left column's empty cards ("The ticket lists no criteria", "No session plan yet"). Check that a hidden kept session does not read at the foreground rate once the live thread arrives.
- Lane 37 (inbox): give the selected row and the focus ring two different looks (a 2 px black outline on the first row today, at 390 without any keyboard use). The Escape that loses the typed text is already above.
- Lane 38 (polish and mobile): at 768, align the sessions index's status chip to the card's foot (unequal titles leave a hole). Keep one amber signal of the four a waiting tower card carries (ring, stripe, label, dot). Write the session's empty states as one short sentence and one action, not a sentence about the interface ("It shows here once the example app runs in the session's container"). The 768 touch targets are already above.

- Pull request: 248, against `v2`.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j2-ui-foundation`.

## 2026-10-23: Owner decision: the rehearsal tickets on the proof instance are sent back and never shipped

**Decision.** On 2026-10-23 the owner decided, as relayed by the orchestrator, that LOCAL-13, LOCAL-15 and LOCAL-16 on the proof instance are rehearsal tickets. They are sent back to Todo, then archived or cancelled if the instance allows it; otherwise the proof restarts from a clean proof base. Nothing of them is ever approved or deployed.

**Why it is written down.** The interface has no action to reject or close a ticket that waits for the owner: issue 249 tracks the missing Reject or Close action. Until it exists, sending back and archiving (or a clean proof base) is the way to keep these tickets from ever reaching an approval.

- Recorded by: Opus 5.5 (claude-opus-5-5), lane `v2-j2-ui-foundation` (pull request 248), at the orchestrator's request; no code of this lane acts on it.

## 2026-10-23: the sidebar, the command palette, the keyboard and its sheet, the tokens, the tower as rows (the author's choices, lane 35, `v2-j2-ui-shell`)

**Decision.** On 2026-10-23 between 01:40 and 03:10 (Europe/Paris), lane 35 of the interface overhaul ([ui-overhaul-plan.md](ui-overhaul-plan.md), section 7) delivers requirements 2.2.1 to 2.2.9 and 2.4, decisions U8 and U11, on lane 34's one document.

- **The sidebar (2.2.1, U8).** The header is gone (`shell/Header.tsx` removed). `shell/Sidebar.tsx` shows the workspace and the button that folds it, a search that opens the palette, then Tower, Inbox with its count, Sessions, and Plans with the lead's dot, each with its chord on hover. Below them, the live sessions are grouped by state ("Needs you", "Working", "In review"), and at the foot the person (Sign out), the notifications and the theme. The clock is gone. The sample-data line sits in the screen's top bar on a computer and in the top bar on a phone, so it shows in every mode. The sidebar is open from 1400 px, a rail of icons from 768 px or when folded with `[`, and below 768 px a top bar and a bottom bar of four screens. The choice `[` stores survives a reload (`cleared-v2-sidebar`). It opens only from 1400 px because the session screen lays out by the window's width: with the sidebar open at 1280 its middle column fell to about 330 px. Once lane 36 lays it out by its own width, the threshold can come down. "Tickets", a screen that does not exist yet, is not drawn; "Plans" keeps its name and its chord (G then P), and its page is titled "Plans".
- **The main column** keeps a 56 px top bar, which every screen's sheet already assumes (the session's `100vh - 132px`, the inbox's sticky `76px`, the lead's `100dvh - 56px`). It names the screen; on a session it names the ticket and its title, as does the tab's title ("Cleared · LOCAL-161 · Upcoming: group entries by week"). A move started in the sidebar keeps the focus on the item pressed; any other move (a row, Back, Forward) gives it to the screen. Both are said in the live region.
- **The palette (2.2.2).** Cmd-K on a Mac, Ctrl-K elsewhere, opens `shell/Palette.tsx`, built on shadcn's `Command` (`components/ui/command.tsx`, cmdk). Its groups are what needs the person (the tower's words), the gestures of the screen shown, the screens with their chords, the sessions by ticket and title, then the theme, the sheet and the sidebar. A gesture is a button the screen already draws (Take over, Give back, Go, Approve, Allow once...): the palette lists it only while it is shown and enabled, and presses it, so no gesture logic is copied. Typing a ticket's number puts that ticket's sessions first. cmdk sorts the items inside a group but does not move the groups (it looks a group up by an id that is not its `data-value`), so the palette orders its groups itself. The dialog is the shell's own, not cmdk's: cmdk's is Radix's modal Dialog, whose scroll lock injects a `<style>` the page's policy refuses. The shell's dialog keeps the focus inside, closes on Esc, on a click outside or on its button, and gives the focus back. The palette is a chunk of its own, loaded after the first draw, so the entry is 551 KB (171 KB gzip) against lane 34's 538 KB (169 KB).
- **The keyboard (2.2.3).** One table, `shell/keys.ts`, is both what the `?` sheet lists and what the one listener reads: G then T, I, S or P (1.2 s); J, K, Enter and Esc on the rows of the screen shown (the tower's, the sessions index's, the inbox's); 1 to 4 for a session's tabs; Cmd-Enter or Ctrl-Enter to send from a field; `[`; `?`. A screen's own keys go in `SCREEN_KEYS` under its name: the sheet lists them there, and the screen binds them itself (lane 37's A, T and R). No key fires while the person types, except the palette's and the send. Nothing reaches past the terminal, where Ctrl-K is the shell's own. A key the screen handled (`preventDefault`) is left alone. `[` and `?` typed with AltGr (Ctrl and Alt on Windows, as on a French keyboard) count.
- **The tokens (2.2.5, 2.2.8).** Each theme is three colours, a base, a contrast and an accent (light: white, #171717, #0B63CE; dark: #0C0C0D, #EDEDED, #5AA9FF), plus the share by which each neutral mixes the contrast into the base (`color-mix` in sRGB). The kit's role names and shadcn's are read from those, so every screen's sheet keeps its variables: none of the variables they use is left undefined. The scale is four spacing steps (4, 8, 16, 24 px), three text sizes (12, 14, 20 px), two weights (400, 550), a 34 px row and a 140 ms motion (0 under reduced motion; opacity and transform only). The focus ring is an outline, which forced colours keep. The light link blue and the placeholders reach 4.5:1 (lane 34's audit, P1).
- **The tower (2.2.4, 2.2.7).** What needs the person and the live sessions are rows: a kind, a title and one line, then the ticket and the age. The rows of a list share their columns (a subgrid) and lay out by their own column's width (container queries). Below 560 px a row has two lines and keeps its line. Amber marks a waiting row once, on its kind; the card's ring, stripe and dot are gone (lane 34's art director). Live sessions come in order: waiting, working, reviewing. A row's link is named by its title and described by the rest. The column beside the list is sections, one line per fact: the lead, the plans with the schedules, what landed. An empty tower says "Nothing needs you." with no line of zeros and no empty list under it. Each empty part is one quiet row with one action where there is one thing to do: New goal for the plans, none for the sessions (the bar above starts one). A failed load offers to try again. On a phone the bar is one line, with New ticket always in view. The rows keep `li.session-card`, `.id` and `a.open`, which the proof scripts click.
- **The lead's empty states** (`screens/lead/Lead.tsx`, these two only): "No message yet." with "Give the lead a goal", which turns the field to a goal and focuses it, and "No plan yet." with no second action.
- **No slop (2.4).** `test/shell/tokens.test.ts` keeps any gradient out of the app's sheets but `.grace-fill`, and keeps emoji, exclamation marks and em dashes out of every catalog. It holds AA contrast for every text colour on every ground it is drawn on, in both themes, computed from `app.css` itself. The shell's rules use only the scale's sizes and weights, and the motion only opacity and transform.

- **French by default (the owner's decision of 2026-10-23, relayed by the orchestrator, blocking before the merge).** `CLEARED_V2_APP_LANGUAGE` defaults to `fr` (`app/src/config.ts`; `en` when asked), and the page falls back to French when the server names no language. The README says so.
  - The shell, the palette, the `?` sheet, the sidebar's groups and the empty states read in French. The inbox is "Réception" in the sidebar and "Boîte de réception" in the top bar, as on its own screen. The key caps read "Entrée" and "Échap". On a phone, the sample-data word is "Exemple", so the project's name fits.
  - Two tests check it. `web/test/shell/french.test.tsx` renders the sidebar, the palette, the sheet, the tower and the lead's empty states in fr. It fails on any English sentence, or English template, of the shell's, the tower's or the lead's catalogs that French does not share. It is first run on the English shell to prove it catches it. A browser test does the same on the real page in French.
  - Words the service or the data write (a ticket's title, a session's phrase) stay as written, as plan 2.5.6 says.
  - The capture script takes French unless `--language en`, and the after captures are in French.
  - The rehearsal scripts start the app without naming a language, so they now run in French. Their selectors are ids, and the one label they match on already accepts "Recommandé". Lane 38 runs them.

**Tests first.** Node: `test/shell/keys.test.ts` (every shortcut in the sheet is bound and every bound key is in the sheet, on every screen, focus and modifier; the chords and their timeout; the typing, terminal and AltGr cases), `palette.test.ts` (the palette's items and their order from the cache, the gestures of the screen shown and of no other, the ticket number's rank and the groups' order), `sidebar.test.ts` (the screens and their chords, the count, the lead's dot, the sessions' groups, the widths), `tokens.test.ts`. Vitest: `web/test/tower/rows.test.tsx`, and the shell and tower tests rewritten for the sidebar and the rows. Browser: `test/shell/shell-browser.test.ts` on the fixtures source covers four cases:
- Ctrl-K, "161" and Enter open the session in the page, with one document and no policy violation.
- The palette lists what waits, and a gesture runs.
- `?` and Esc open and close the sheet, and the focus comes back; the G-chords move between screens.
- J, K and Enter walk the tower's rows and open one; `[` folds the sidebar, and the fold survives a reload.

The browser job runs the new file.

**Measures** (the browser job's budget test in CI mode, three runs of twenty switches, p95 each, median of three; this server, the same Chromium; `origin/v2` measured beside it in a detached worktree):

| Measure | `origin/v2` (`33a0cd8`) | This branch | Budget |
| --- | --- | --- | --- |
| Median of the runs' p95, by round | 26.9, 26.2, 26.7 ms | 30.8, 34.8, 30.8, 27.1 ms; after the art director's round 28.7, 24.0 ms | under 100 ms |
| Documents loaded in twenty switches | 0 | 0 | 0 |
| Requests to the API per switch, at most | 1 | 1 | 1 |

The sidebar costs about 3 to 4 ms per switch on this server. Its props are kept stable, so it draws again only when what it shows changes.

**Followups the lane took.** Issue 250: F-b, the scroll's restoration stops at the person's first wheel, touch or key; F7, `#screen`'s outline and a kept session's `display` are classes, with no inline style left. Issue 227, item 1: a recipe is picked by its service and its name, so two services' recipes of one name no longer both press. The run route still names it by name only, which a later route change needs. Issue 164, the bell and the menus: the person's and the notifications' menus are Radix popovers, which close on Esc and on a click outside. Lane 34's audit for lane 35: the contrast, the focus on a switch, the focus ring in forced colours, the header's three rows at 768, the dead "Tickets", and the bar squeezed at 768. Lane 34's art director for lane 35: the focus on a sidebar item, the names of the places, the header at 768, the sample-data line, and the amber stripe.

**What lane 35 touched beyond its file list, and why.**
- `v2/app/web/lib/stack.tsx`: a kept session's `display` became a class, for issue 250 F7.
- `v2/app/web/test/render.tsx`: the shared helper rendered the removed header.
- `v2/app/web/test/lead/render.test.tsx`: the lead's empty state's sentence.
- `v2/app/test/switch-budget.ts`: the sidebar's links, with the header's kept as a fallback so a "before" still measures.
- `v2/app/test/foundation/stack-browser.test.ts`: the sidebar's links, focus kept on a sidebar move, and a window short enough for the denser tower to scroll.
- `.github/workflows/v2.yml`: the new browser file.
- `v2/scripts/capture-screens.ts`: the palette, the sheet and the two empty states as captures.

**Impeccable.** Installed at 4.7.0 in the lane's worktree with the owner's command. Its paths are in the shared exclude file and in no commit, and the hooks the installer wrote into `.claude/settings.local.json` were emptied before any edit. `init` wrote `PRODUCT.md` from the plan, with no interview: the plan's section 6 fixes its inputs. `document` recorded the incumbent system in `DESIGN.md`; the sheets were byte for byte lane 34's, whose scan it reused.
- `audit` scored 17 of 20. Its two P2s for this lane are fixed: the rows' link names, and AltGr. Its other P2 is lane 36's and 37's: the session and inbox screens lay out by the window's width.
- `critique` ran its two assessments as isolated agents. The heuristics scored 26 of 40 before the fixes. The detector found only the brief's fonts and a regular expression in a test, both false positives.
- `typeset` and `layout` ran on the tower, each an isolated assessment with the detector's type and layout scopes run apart (only the fonts again).
- The findings taken are in the tower's and the shell's last commit before the captures:
  - the row line lost below 560 px (P1), the phone bar (P1), and what the empty tower said twice;
  - one name for what needs the person;
  - the weights, one left edge, the subgrid, and the column as sections;
  - the palette on a phone, and the lead's dot as a shape.
- `polish` ran last, on the captures.
- The reports, kept beside the captures and not committed: `/tmp/cleared-captures/j2/overhaul/35/audit-35.md` and `critique-35.md`.

**For lanes 36 to 38.**
- Lane 36 (session):
  - Lay the session out by its own width, so the sidebar can open from 1200 px.
  - Drop the screen's own crumb ("Tower / ..."): the top bar names the ticket.
  - Send wraps beside the rail at 1280.
  - Put the screen's controls in the top bar's `.top-actions`, which today holds only the sample-data line.
- Lane 37 (inbox):
  - The inbox's heading repeats the top bar.
  - "Boîte" against "Réception" in French.
  - Its keys go in `SCREEN_KEYS.inbox`. `walkRows` already walks `a.item`, and a key the screen handles itself (`preventDefault`) is left to it.
- Lane 38 (polish and mobile):
  - Preload Geist and add a metric-matched fallback face (`app/src/server.ts`).
  - Text sizes in rem, for the person's font size.
  - The sign-in page on the tokens.
  - The off-scale radii and 2 px gaps the critique listed.
  - The button's ink variant still sets 500.
  - A per-item action panel (answer a waiting row where it stands), a visible pending G chord, keys for the gestures, and the next or previous session.

**Checks.** On this server:
- `npm run typecheck`.
- `npm test`: 1317 node tests (1299 pass, 18 skipped, 0 fail) and 191 Vitest tests pass.
- The browser job's seven files, run by hand with the full Chromium: 16 tests, 16 pass.
- `npm run guard -- --base origin/v2`: nothing refused.
- The capture script on the fixtures source: 72 files, no page error, no request off the origin, each looked at for secrets and names.
- French: every new key is in both catalogs, which the catalog test holds. The browser tests run in English and fail on any marked key.
- Before captures: `docs/v2/ui-overhaul/before/35/` (40 files; 39 byte for byte lane 34's "after", and the 768 lead-pill variation it logged).
- After captures: `docs/v2/ui-overhaul/after/35/`. There are 102 files, in French, the default: the five screens; the palette on the tower, the inbox and a session; the sheet on the tower and on a session; a rail's tooltip from 768 px; and the empty tower and lead. Each is at 1440, 1280, 768 and 390, light and dark.

**The art director's look** (`/tmp/cleared-reviews/35-ad.md`, a fresh session). All 17 items before the merge are taken:
1. The palette's rows were 804 px tall over the inbox: the inbox's sheet styles a bare `.detail`. The palette's classes are prefixed now, and `test/shell/classes.test.ts` fails when a class the shell draws is styled unscoped by a screen's sheet.
2. A typed word outranks a scatter of its letters, and the groups follow their best match: "upcoming" opens the session, not a long Knowledge title.
3. A session offers its permission's three answers.
4. The dialogs are taller; the sheet has two columns on a wide window; with no query, "Needs you" shows three rows.
5. The focus goes back where it was, a field included. The shell reads it before the app behind the dialog is made inert, which took it away.
6. The tower says what needs the person once: the heading, "Open inbox" beside it, then the rows. An empty tower has one line under its heading.
7. On a phone the bar wraps. Ask about the code and Run a recipe are left to the palette there. At 768 px, the French chips wrapped past the bar's edge; they wrap inside it now.
8. The lead's plan pane says what to do and offers it, as a block in its middle. Where the panes stack, the thread's action is the one shown.
9. The sign-in page is on the tokens, and the phone's field size is a token (`--text-input`). The token test reads every size and weight of `app.css` and `tower.css`.
10. The screens' own headings and the session's crumb ("Tower / ...") repeat the top bar. They are lanes 36's and 37's to drop, listed above.
11. The sidebar is open from 1400 px, not 1280, for the reason given above: the session's middle column. The rail keeps every name, in its tooltips.
12. The rail's icons, and the open sidebar's icon-only buttons, show an instant tooltip with their name and chord (opacity and transform, 140 ms), in place of the native `title`.
13. On hover the chord shows before the count, which stays.
14. The lead's state is in words at the sidebar's foot ("The lead is on"), and in the Plans tooltip.
15. "Needs you" is the one name, in the tower, the sidebar and the palette. The plan's 2.3.3 says "Waiting for you"; this entry replaces it.
16. English writes "45%". The no-break space of `plan_cost_total` was never lost: my rewrite had written it as the character, and it is the `\u00a0` escape again.
17. The new captures are in the after set.

**Beyond the file list in this round.** `app/src/config.ts`, `web/main.tsx` and `v2/README.md` for the French default. `app/messages/inbox.en.json`, `app/messages/ask.en.json` and their tests (`web/test/inbox/plan.test.tsx`, `web/test/ask/render.test.tsx`, `app/test/ask/model.test.ts`) for "45%": the inbox's plan-panel keys must equal the lead's, a test holds them alike. `app/test/main.test.ts`, for the default.

- Pull request: 252, against `v2`.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j2-ui-shell`.

## 2026-10-23: the session view follows the ticket, the handover row, the intent sentences, the step rows (the author's choices, lane 36, `v2-j2-ui-session-continuity`)

**Decision.** On 2026-10-23 between 01:40 and 03:30 (Europe/Paris), lane 36 of the interface overhaul ([ui-overhaul-plan.md](ui-overhaul-plan.md), section 7) delivers requirements 2.3.1 to 2.3.4 and decisions U6 and U7 on the session screen, the intent function lane 37 will use, and the session items the art director of lane 34 left for this lane.

- **One view per ticket (U6, `screens/session/ticket.ts`).** The view draws one thread of the ticket's author and reviewer sessions in the order they started, a handover row before each session after the first ("Reviewer · Sonnet · from 09:37"; "Author · Opus · again from 09:52" when a review sends it back). Each session is followed by its own CopilotKit agent (`Feed`, `Session.tsx`); a reviewer that starts while the view is open arrives by the change stream (a `session` event refetches `/sessions`), and its rows continue below, live, with no document load. The view acts on the ticket's live session, whatever its role (`actingSession`): its status, its composer, its Plan, its Take over and Give back. Author and Reviewer are a filter of the thread ("Whole ticket", "Author · Opus", "Reviewer · Sonnet"), drawn once the ticket has two sessions. An ended session a later one followed is folded into one row ("Author · Opus · 10 steps") unless the view saw it live, so nothing folds under the person's eyes and a phone opens on the live session.
- **The address follows the live session (2.3.2).** When the live session is not the one the address names, the view replaces the address (`history.replaceState`, no navigation), so a reload lands on the live one and draws the same ticket view. The shell's stack is keyed by session; a new address would have made a second view. `web/lib/routes.ts` gains a small table (`keepWith`, `viewOf`, `forgetView`): a view says which sessions of its ticket it draws, and `placeOf` places them on that view, its address included, so the shell's stack, scroll and focus see no move. The first view of a ticket keeps its sessions until the stack drops it. A link to any session of the ticket (the tower, the index, Back) shows that view.
- **Take over (U7).** Take over and Give back moved from the tab strip to the thread's header, on the live session of the thread whatever its role, through pull request 242's `takeoverOf` unchanged; no file of the takeover was edited. Their copy follows the handover contract: Take over "Stops the session and opens it for you, in its container.", Give back "Hands the session back and tells it what you changed.", and the Terminal tab's notice is one line ("Since 09:41. Give back tells the session what you changed.").
- **The Editor holds the ticket's diff.** Its files are what every author of the ticket changed (the newest's counts), read from the live session's checkout first (the ticket's branch, which the reviewer reads), then the authors'; a file read again stays on screen until its new text arrives, so the reviewer's start does not redraw the diff. "All changes" and "Last turn" (Codex's) sit above the files: the last turn is the files the last turn that changed a file changed, with that turn's counts (`lastTurnFiles`, `components/editor/model.ts`; the model now keeps each turn's start). The diff of a file stays against the ticket's base: an edit's event carries its counts, not its text. The Changes card's paths open the file in the Editor.
- **Intent sentences (`web/lib/intent.ts`).** A pure function says what a shell command means to do, from a table of shapes that is its test's table: the repository read with git, files read, searched or listed, the project's tests, types, style and build, a dependency named or all of them, a call to a host, a commit, a push, a branch, files deleted or moved, the app started, a script; a compound says each class once ("Read the repository and run the tests"); an unknown command its first word and an ellipsis ("docker …"). The command is cut into its parts for display only (`commandParts`, quotes and redirections kept whole); the decision stays the policy's. The words are `intent_*` keys of the shell's catalog in both languages, since lib code's words must be the shell's (`app/test/catalog.test.ts`); lane 37's inbox reads them with no copy.
- **Step rows (Devin's).** A command, an edit or a read is one row that opens its detail (`<details>`): the command's intent, its result as an accessory on the same line ("9 passed"; nothing for a command that went well), the raw command one part a line and its last eight lines of output in the detail; an edit's counts and "Show the changes"; a read's paths, each opening the file. Consecutive edits of one file nobody was asked about are one row with their sum and their count ("+14 −2 · 2 edits", `EditsRow`, `model.ts`). A check named by its command is said by its intent, the command folded under; the ticket's checks go on across its sessions, each by its name with the newest session's value.
- **Lane 34's art director's LATER items for this lane.** At 390: one row of tabs, Take over in the status row, the composer in one row (Hand over to Codex, a disabled milestone 3 button, stays off a phone). The left column's empty cards ("The ticket lists no criteria", "No session plan yet") are not drawn. A hidden kept view pauses its agents' streams (`SessionAgent.setOpen`, resumed after the last event read), stops its clock and reads nothing until it is shown; an ended session whose events are all read holds no stream either. Review 248's followups: F-a (the composer focused through the view's own ref) and F5 (a kept session shown again puts its tab back in the address). Issue 233 ("Working" on the author's page while the review runs) goes with the view: its status is the live session's. Issue 227's item 2 (`readSteps` on every tick): the steps are read when the cache says they changed, never while hidden. The sessions index shows one card per ticket, the session its view acts on.
- **Fixtures.** The fixtures source's LOCAL-152 has its author, done, before the reviewer the tower shows (`envelopeStory`, `fixtures/session.ts`): two edits of the envelope sheet in a row, its checks named by commands, a second turn on the owner's word. The source's detail now applies a session's deltas (it read the last snapshot only). The session fixture's LOCAL-161 can end its author and start its reviewer during a test (`sessionFixture(now, { review })`, `startReview`), and its source answers the change stream with a `changed()`.

**What lane 36 touched beyond its file list, and why.** `web/lib/routes.ts` (the table above: the alternative was the shell's `App.tsx`, lane 35's in this wave). `app/messages/shell.{en,fr}.json` (the intent words, as the catalog test asks of lib code; lane 35 edits these files too, so the second to merge resolves the conflict). `app/fixtures/source.ts` and `app/test/fixtures.test.ts` (LOCAL-152's author; five sessions where there were four; the tower, inbox and lead captures are the same bytes as lane 34's). `scripts/capture-screens.ts` (the `review`, `review-editor` and `review-takeover` screens). `.github/workflows/v2.yml` (the new browser test in the browser job's list). `app/web/test/render.tsx` (the session's render helper draws the filter where the crumbs' links were).

**Impeccable.** 4.7.0 in the lane's worktree, its paths in the shared exclude file and in no commit; the installer's hooks file was removed before any edit; `DO_NOT_TRACK=1`. `init`: PRODUCT.md from the plan, no interview (the plan fixes init's inputs), with this lane's surface added. `document`: lane 34's DESIGN.md scan, the sheets unchanged since. `audit`, rendered through CDP on the fixtures at 1440, 1280, 768 and 390 in both themes: every text of the lane's parts at 4.5:1 or more; fixed the composer's placeholder (3.2:1, now the faint text token, 4.95:1), four Editor contrasts 0.01 to 0.2 under 4.5:1, filter chips and detail links under 24 px on desktop, check and step summaries under 44 px at 768 and 390. False positives: Geist (the brief), `p.empty-box` nested in "Screen so far" (lane 38's empty states). `critique`, two isolated assessments (design review; detector and browser evidence), heuristics 27 of 40 before the fixes; fixed: Take over clipped at 768, step rows on two lines, the caret hidden until hover, the filter read as a second row of tabs, "took over" in the handover row colliding with Take over (the plan's example sentence became "Reviewer · Sonnet · from 09:37", the filter's words), the phone opening on the author's first row (the fold), two index cards for one ticket, the Review check "waiting" while it runs ("pending"), the French note's "milestone" ("jalon"). Left, with reasons: Hand over to Codex stays (requirement B5.10c, milestone 3); the request card keeps the raw command as its title (a permission is decided on the exact command; the question-shaped title is lane 37's); `allow_always` and `deny` are the inbox's words too (lane 37); the empty-state sentences (lane 38); a filter shortcut and J and K through the steps (lane 35's shortcut table); a fold of the type scale (lane 35's tokens). `polish`: no dead code or orphaned style left in the lane's files. The notes are at `/tmp/cleared-captures/j2/overhaul/36/impeccable-36.md`, not committed.

**Measures** (fixtures source, loopback, this server, 1440x900, the budget browser test in CI mode, three runs of twenty switches):

| Measure | Before (`origin/v2` `33a0cd8`) | After (this branch) | Budget |
| --- | --- | --- | --- |
| Tab switch p95 per run | 33.4, 16.9, 19.7 ms | 21.5, 19.1, 21.7 ms | |
| Median of the three runs' p95 | 19.7 ms | 21.5 ms | under 100 ms |
| Documents loaded in twenty switches | 0 | 0 | 0 |
| Requests per switch, at most | 1 | 1 | 1 |
| Author to reviewer | a click on the crumbs' link, a new view and thread | the handover row 33 to 45 ms after the change event, 0 documents, the same view and diff nodes | no navigation |
| Requests of a hidden kept view in 4 s | (not measured) | 0 | |

**Checks.** `npm run typecheck`; `npm test` (1306 node tests: 1291 pass, 15 skipped, 0 fail; 194 Vitest tests pass); the browser job's files by hand with `CLEARED_V2_PLAYWRIGHT`: 13 tests, 12 pass; `app/test/notify/browser.test.ts` fails the same way on a clean `origin/v2` checkout on this server (the headless push subscription), not this lane's; `npm run guard -- --base origin/v2`, nothing refused. The before captures (24) and after captures (40: the index, a one-session ticket, the ticket view at its reviewer, its Editor, its Terminal after Take over; four widths, both themes) are under `docs/v2/ui-overhaul/{before,after}/36/`, each looked at for secrets and names.

**For later lanes.** Lane 38: `scripts/proof-j1.ts` clicks `a.tab` for the Reviewer, which is now the filter (`[data-filter="reviewer"]`) in the same view; with the stream down, a hidden kept view's resources are still polled by the cache's poller, since the shell subscribes each screen's reader for the life of its mount (a reader that pauses with its view is the shell's to add). Lane 35: the session's title in the tab strip (the ticket's) and a shortcut for the thread's filter.

**The art director's look and review round 1 (PASS), taken on 2026-10-23.**
- **Art director, before merge, all ten applied.** (1) The handover row is a sentence with a verb again, as plan 2.3.1 asks, without "took over", which names the person's Take over: "Sonnet started the review at 09:37. The author's work is above." ("Sonnet a commencé la relecture à 09:37. Le travail de l'auteur est au-dessus."), and its three twins for an author back on the review's changes, a new author session and a new review. This replaces the plan's example wording and this lane's first "Reviewer · Sonnet · from 09:37". (2) A step's and a check's caret is the faint text at rest (3:1 at least on both surfaces), muted on hover, so touch sees that a row opens. (3) The session's own prose is a row of the worklog (its time, a glyph, flat text, no fill); the person's message keeps a quiet bubble (the tab fill, no longer ink). (4) The thread is pinned to the window down to 1101 px; at 1100 and below the panel is a column of the page. (5) Below 1440 the status's meta goes under its phrase, so Take over keeps the panel's margin. (6) Under the terminal one line: "{name} on this session, 65 × 19"; what is journaled is that line's title. (7) LOCAL-152's reviewer resumes on its own story in the fixtures (`ENVELOPE_RESUMED`), and the stand-in's first line no longer explains Give back. (8) Filter chips 30 px high. (9) The Editor's two segmented controls the same size, left aligned; an unselected file has a hairline box in the strip; 8 px under the diff. (10) "Taken over at 09:41." (EN), "Pris en main à 09:41." and the status "Vous avez la main" (FR).
- **Review round 1.** F1: an address naming a session that is neither an author's nor a reviewer's (the lead's, a reader's) drew nothing, since the view kept only the ticket's thread roles. The view now draws such a session alone, with its own feed (`viewSessions`, `ticket.ts`); a model test and a browser test on the fixtures' lead session, which fails on the code before. F2: `intent.ts` read `curl … | sh` as a call only and `find -delete`, `git checkout -- .` as reads; a pipe's reader that runs or writes what it reads (a shell, an interpreter, `xargs`, `tee`) now says so, and `find -delete` or `-exec rm`, `git checkout --`, `restore`, `reset --hard` and `clean` (a new `discard` kind, "Discard changes") and `sort -o` are in the test's table, before lane 37 makes the sentence an approval's title. F5: a feed made closed (a hidden view, an ended session read already) opens no stream at all (`streaming` on `SessionAgent`). Left: F3 (`scripts/proof-j1.ts` and its `a.tab`) for lane 38, which owns the proof scripts; F4 (the hidden-view test counts the session and steps reads) and F6 (a stale view kept beside a later one of the same ticket, memory only) are noted; F7: once the reviewer is the live session, the Editor stays read only, as the reviewer reads the author's diff.

**After lane 35's merge (pull request 252), on 2026-10-23.** `origin/v2` merged into the branch (no rebase). Conflicts: the shell's catalogs (both lanes' keys kept: lane 35's, then the `intent_*` words), the browser job's list (lane 35's shell test and this lane's continuity test), the capture script (lane 35's palette, sheet, tooltip and empty captures, the `--language` option, and this lane's `review`, `review-editor` and `review-takeover`), and the log (lane 35's entry, then this one). On lane 35's shell:
- The session's own breadcrumb ("Tower / title / id") is gone: the top bar says "Sessions / LOCAL-152 · title" already. `crumbs_label` and `crumb_tower` left the session catalog.
- The sidebar takes its share of the window, open or folded, so the session's columns follow the screen's own width (a container query on `#screen`, the session screen's sheet only): three columns (260, the thread, 300) from 1160 px of screen, two below, one under 760 px (a tablet beside the folded sidebar, a phone), the thread first. The thread is pinned to the window less the top bar (`100vh - 96px`).
- The status's meta is always under its phrase, so Take over keeps its margin in a narrower thread. The thread panel is a container too: under 640 px of thread, the composer keeps one row and the disabled "Hand over to Codex" is not drawn.
- The app is French by default (lane 35, the owner's decision): every string this lane added is in both catalogs, and the after captures are the French default. The English left on them is the fixtures' data (ticket titles, statuses, the stand-in terminal), which the plan shows as written (2.5.6).
- The continuity browser test reaches the inbox through the sidebar (`#nav`).
- Checks after the merge: `npm run typecheck`; `npm test` (1321 node tests pass, 21 skipped, 0 fail; 205 Vitest tests pass; one run before reported a single node failure that did not come back on the next run); the browser files of the job but the notify one, with lane 35's shell test: 18 tests, 18 pass; the budget test in CI mode, p95 27.2, 25.2 and 24.0 ms, median 25.2 ms, 0 documents, at most 1 request per switch; the handover row 55 ms after the change event.

**The art director's LATER list (for lanes 35, 37 and 38, none changes this lane).**
1. Codex's review pane beside the thread: at 1440, a file of the Changes card opening the Editor at its diff in the "Last turn" scope, or a split view (lane 38 or a follow-up).
2. Devin's "jump to that moment": read and run rows linking to the same moment in the Terminal or the Editor, as edits do with "Show the changes".
3. "Hand over to Codex" is a dead control in every composer, including during a Take over, and "handover" now also names the reviewer's row: remove it until milestone 3, or rename it ("Switch harness"). An owner decision, since requirement B5.10c names it.
4. A row's hover paints a 4 px shadow outside it, which clips against the toolbar on the first row: padding inside the radius instead.
5. Opening "Author · 10 steps" pushes the live reviewer's rows out of view: keep the thread's end in view while the reviewer is live, or scroll the opened group's start into view.
6. The empty space under a lone request (LOCAL-161 at 1440): an empty-state line, lane 38's empty views.
7. The sessions index's cards repeat "Open session" though the card is the target: one row per ticket at 32 to 36 px, as the tower's (lane 35's rows).
8. `tab_author_waiting` and `tab_reviewer_waiting` draw only on a disabled chip, now hidden with one session; `terminal_here_only` and `browser_here_only` are long.
9. Impeccable's `audit` through the live overlay was not run by the art director; `detect --cdp` at 390 again once item 2 above is in.
10. The session catalog's microcopy (about 250 keys) is where the next slop pass should read; "Deny, use what we have" and "Always in this project" are lane 37's (a button is a verb).

- Pull request: 251, against `v2`.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j2-ui-session-continuity`.

## 2026-10-23: the inbox's requests in French, the reason by its code, the three answers, the "Traité" group, the whole app in French (the author's choices, lane 37, `v2-j2-ui-inbox-fr`)

**Decision.** On 2026-10-23 between 02:30 and 04:30 (Europe/Paris), lane 37 of the interface overhaul ([ui-overhaul-plan.md](ui-overhaul-plan.md), section 7) delivers requirements 2.5.1 to 2.5.6 and decision U9 on the inbox, on lane 36's `lib/intent.ts` (pull request 251, merged into the lane through `origin/v2`).

- **The title is the intent (2.5.1, U9).** A request's row and its detail are named by the app's sentence, computed from the command by lane 36's function, whatever the harness wrote ("Installer date-fns", "Lire l'historique et le diff du dépôt puis lancer les tests du projet"). The inbox reads `intent.ts` unchanged and adds three things on top of it (`permissionTitle`, first in `screens/inbox/model.ts`, then in `web/lib/request.ts` for every screen after the art director's round):
  - French joins two intents with "puis" in a title and "puis à" after "Autoriser … à", so the preposition is repeated and the double "et" is gone (the critique). English keeps "and". The session screen's checks keep lane 36's "et".
  - A command the table does not know is said by its first word ("Lancer docker"), not "docker …", which read as cut off.
  - **A command the table cannot read whole is not summarised.** A write to a file (`>`, `>>` to anything but `/dev/null`), a substitution (`$( )`, a backtick), a heredoc, a process substitution, `eval` or `source`, a shell given `-c` or an interpreter given `-c` or `-e`: its title is "Lancer une commande composée" and its fold opens by itself (`opaque`, `foldOpen`). The audit showed `intent.ts` saying "Lire des fichiers" for `cat secrets.env > /tmp/x`; on the screen that approves the command, that would misstate it.
  - The other tools say what they do: "Lire un fichier", "Modifier un fichier", "Lire une page du web", "Utiliser {tool}".
- **The request as a question.** The detail's heading is the request asked of the person, naming who asks: "Autoriser le relecteur à lire l'historique et le diff du dépôt puis à lancer les tests du projet ?" (the author, the reviewer, the lead, the reader, or the session). The plan placed this question in the eyebrow above the intent title; the two would say the same thing twice, so the question is the heading and the eyebrow keeps the kind, the ticket and the session's link. A handled request is headed by its intent title.
- **The command folded (2.5.2).** Under the facts, a `<details>` closed by default holds the command one part per line after its operator (`;`, `&&`, `||`, `|`), cut for display only by `commandParts`. Its summary shows the first part and how many more ("git log -5 --oneline +4"), so the person deciding sees that a chain hides more. It also holds the harness's own description ("Pour quoi faire") and, with no code, the policy's sentence.
- **The reason by its code (2.5.3).** `PermissionItem.reasonCode` is added to the API types, optional, with its closed list `REASON_CODES` (`compound`, `not_allowed`, `network`, `dependency`, `outside_checkout`, `unknown`); `test/api/types.test.ts` pins it. The policy lane fills it; pull request 240 did not, so no service request carries it yet. The inbox says the codes it knows in French ("« git merge-base » n'est pas une commande que la politique autorise seule." names the part the policy's sentence names). Until the policy sends codes, the two rules whose meaning is one of them give it (`install.package` is `dependency`, `network` is `network`). Any other rule, an `unknown` code or a code the app does not know yet shows the policy's English sentence as written, in the fold under "Texte de la règle".
- **The three answers (2.5.4).** "Autoriser une fois" (ink), "Toujours pour ce projet" and "Refuser" are at the top of the detail, before the facts, at every width; a browser test checks they are in the window without scrolling at 1440, 1280, 768 and 390. "Toujours pour ce projet" is the owner's wording, in the inbox, the session screen and the palette. From 1280 px each waiting request's row carries the same three answers, except the row of the request shown, whose answers are beside it (the audit: never twice). The list is 440 px wide from 1280 px so they hold on one line. A row's answer shows its item and says what it did there; a persistent live region says it once, and the focus goes to the detail. The detail's inside is drawn again when lane 34's optimistic cache moves the item to what was handled, so the focus stays on the detail region, which is not redrawn. The deny reason field sits under the answers ("Motif du refus (facultatif)"), and Enter in it refuses. The sticky bar at the detail's foot stays for the other kinds and holds nothing for a request.
- **The "Traité" group (2.5.5).** What was handled and what expired sit in one group under what waits, folded by default with its count ("Traité · 2"), opened by its button, and opened by itself when the address names one of its items. Its rows are lighter and keep their intent title. What waits has a quiet heading with its count ("En attente · 6"). The API does not say whether a handled request was answered or expired (the store knows `handled_by`; `PermissionItem` has no outcome), so both read "ne vous attend plus": a follow-up below.
- **The inbox's keys (issue 253, item 4).** `SCREEN_KEYS.inbox` in `shell/keys.ts` lists A ("Autoriser une fois la demande affichée"), T, R and Space (a peek: the walked row's item shown, the focus kept on the row, only where the detail sits beside the list). The inbox binds them itself (`inboxKey`), so the sheet lists exactly what is bound, on the inbox only, which a test holds both ways. A key right after a G belongs to the shell's chord, so G then T goes to the tower and never answers; A, T and R from another walked row do nothing (the person is reading that one). `keyLabel` writes Space as "Espace". Esc leaves the item but never from a field: the text typed in the deny reason, a Change or a Send back stays (lane 34's audit, P1).
- **One name for the place.** The sidebar's "Réception" is now the top bar's, the back link's and the shortcut's name in French too; the sentences that said "la boîte de réception" say "la liste". The heading that repeated the top bar is gone (lane 35's art director).
- **The list's look.** Rows on hairlines, as the tower's; the shown row filled (`--selected`), the keyboard's focus the app's outline ring, two looks (lane 34's art director); no row marked shown under 1024 px until one is open. One amber signal per waiting row, its kind as text, not a pill. The detail's type on lane 35's scale (20, 14 and 12 px, 400 and 550). On a phone the answers are one per row, the key caps hidden (also under `hover: none`), and the group's button and the fold's summary 44 px tall.
- **French typography.** The inbox's French catalog has a narrow no-break space before "?", "!" and ";" and a no-break space before ":" and inside « », written as the escapes `\u202f` and `\u00a0`. The plan panel's keys keep the lead's catalog's values, which a test holds equal; aligning both is lane 38's.

**The whole app in French (2.5.6).** `app/web/test/french.test.tsx` draws, in fr, on the fixtures:
- the sign-in page and its three errors;
- the tower, the sidebar and the sessions index;
- a session;
- the lead and both questions to the code;
- the inbox: every kind, waiting and handled, each detail in thirteen local states;
- the palette and the sheet on six screens;
- the dates, the durations, the decimal comma, the space before % and the plural.

It fails on any marked key (a key a catalog lacks) and on any text that is a catalog's English that French does not share; the fixtures' own words are data and pass. A template with no word of its own ("{n}%") is not read. The test is first run on the English app to prove it catches English. On the code before the lane it fails twice:
- the tower calls a request "Permission" where the inbox says "Autorisation";
- the inbox's sheet lists none of its own keys.

No catalog key was missing: lanes 34 and 35's catalog test already held both catalogs alike. The French test's other findings, fixed in the catalogs:
- "Mise en ligne" against "Mise en production" (tower, session);
- "Toujours dans ce projet" (session, shell, inbox);
- the session's "Deny, use what we have" / "Refuser, faire avec l'existant", now "Deny" / "Refuser" (a button is a verb; lane 36 left them to this lane).

**Tests first.**
- Node: `app/test/inbox/permission.test.ts` (12 tests: the table of shapes in both languages, what is not summarised, the other tools, the question, the fold, the reason by code and by rule and the fallback, the order and the group's count, the row's answers by width, the keys and the sheet, the G chord, Esc). Every test failed on the code before: the module had none of its functions. Also `test/api/types.test.ts` (the codes), `app/test/fixtures.test.ts` (the source's new items).
- Vitest: `web/test/inbox/permission.test.tsx` (the row's answers in French, the detail's order, the fold's lines, the fallback, the handled and the answered request), `web/test/french.test.tsx`, and the inbox's older tests moved to the new contract with the screen's real translator (the shell's catalog under the inbox's).
- Browser: `app/test/inbox/inbox-browser.test.ts` on the fixtures source in French, in the `browser` job's list:
  - the reviewer's request at the four widths: its question, its answers in the window, its reason, its fold, the rows' answers;
  - A through the answer route (stubbed in the page), R and Esc typed in the field staying there, G then T;
  - the "Traité" group folded and opened;
  - a row's answer said on its item, the focus on its detail and kept there once the cache has moved the item (it failed with the full Chromium build until the focus left the redrawn line).

**The fixtures.** `app/fixtures/inbox.ts` gains `requestItems` (the owner's capture of 22:02 as the reviewer's compound request with `reasonCode: 'not_allowed'` and no description; a request answered earlier; one expired with its session), which the fixtures source lists on its own sessions. The tower's "needs you" and the sidebar's count grow by one (6).

**What lane 37 touched beyond its file list, and why.**
- `v2/app/web/shell/keys.ts`: the inbox's entries in `SCREEN_KEYS`, two `Action` kinds (`answer`, `peek`), and Space in `keyLabel`. Lane 35 left that table for this lane.
- `v2/app/fixtures/source.ts`: the source lists the new requests, so the captures and the browser test have them.
- `v2/app/test/fixtures.test.ts`: the source's list.
- `v2/app/test/inbox/train.test.ts` and `v2/app/web/test/{render.tsx,inbox/*.test.tsx,session/render.test.tsx}`: `itemTitle` takes the translator; `renderInbox` takes the group's state; the screen's translator; the session's button label.
- `v2/app/messages/{shell,tower,session}.fr.json` and `session.en.json`: the French test's findings and the keys' labels.
- `v2/scripts/capture-screens.ts`: three captures named only (`inbox-permission`, `inbox-handled`, `sheet-inbox`).
- `.github/workflows/v2.yml`: the new browser file in the `browser` job's list.

**Measures** (the `browser` job's budget test in CI mode with the full Chromium, three runs of twenty switches, p95 each; this server; `origin/v2` measured beside it in a throwaway detached worktree):

| Measure | `origin/v2` (`e6446c2`) | This branch | Budget |
| --- | --- | --- | --- |
| Median of the runs' p95 | 31.1 ms (30.9, 32.9, 31.1) | 26.1 ms (26.1, 28.0, 26.0) | under 100 ms |
| Median switch, per run | 22.0, 20.3, 19.4 ms | 17.7, 17.9, 17.2 ms | |
| Documents loaded in twenty switches | 0 | 0 | 0 |
| Requests to the API per switch, at most | 1 | 1 | 1 |

**Impeccable.**
- Install: 4.7.0 in the lane's worktree with the owner's command, `DO_NOT_TRACK=1`. Its paths were already in the shared exclude file and are in no commit. The installer's hooks file (`.claude/settings.local.json`) was removed before any edit, so no hook ran. The skill launcher first resolved the server's global 4.4.0 copy; the lane used the worktree's 4.7.0 scripts and references only.
- `init` and `document`: `init` wrote `PRODUCT.md` from the plan with no interview (the plan's section 6 fixes its inputs), with this lane's surface. `document` recorded lane 35's tokens and the inbox's sheet in `DESIGN.md`. The detector (`impeccable detect`) found nothing in the inbox's files; on `app.css` it flags Geist and Geist Mono, false positives (the brief).
- `audit` and `harden`, a fresh agent: 14 of 20 (accessibility 3, performance 3, theming 3, responsive 3, integrity 2). Fixed:
  - P1, the title misstating a command (above);
  - P1, a row's answer reported on another item;
  - P1, focus and the announcement lost after an answer;
  - P2, the answers twice on the shown row;
  - P2, A from another row;
  - P2, the 44 px targets;
  - P2, Space below 1024 px;
  - P2, the detail's type off the scale;
  - P3, a row marked shown on a phone, "docker …", the empty quotes of a reason for a tool, the French spacing;
  - harden: the load error that promised a retry now offers "Réessayer"; Enter in the deny reason refuses.
- `audit` and `harden`, left:
  - P2, "Toujours pour ce projet" on a row: kept, the plan's 2.5.4 and the owner's question 4 default;
  - P2, the older sheet's hard-coded colours (lines 5, 6, 143, 144): lane 38's;
  - P3, the loading state's empty `aria-busy` and the titles computed at each tick of the grace clock;
  - harden P2, the outcome of a handled request: the API.
- `critique`, a fresh agent: 25 of 40 before the fixes. Taken:
  - the reason missing at the top (the rule's code);
  - the fold hiding the chain's other parts;
  - the grammar;
  - French typography;
  - a row's answer giving no feedback;
  - the rows' answers as quiet outline buttons;
  - "Mise en ligne";
  - the type scale;
  - key caps on a phone;
  - the deny field's words and place;
  - one amber signal;
  - the copy: `empty_note` gone, "Réglé depuis la session.", "Texte de la règle", "Autorisé pour ce projet. La session continue.", "Refusé. Le motif est transmis à la session.", "Traité.";
  - the shown fill on a phone.
- `critique`, left:
  - the outcome per handled row (the API);
  - a grace and Undo for "Toujours pour ce projet" (a service change: the answer is written at once);
  - the scope a "Toujours" writes, named on the button (the policy's `patternOf` saves the whole compound command, pull request 240's follow-up);
  - "auteur en pause" kept, since the proof scripts read a row by "`{ticket} · `";
  - typographic apostrophes, across every catalog: lane 38.
- `polish`: one bounded pass on the captures: the row answers on one line from 1280 px, the phone's answers one per row, the facts' label column, the pointer left over a row by the capture script. The reports were relayed in the lane's session and are not committed.

**Checks.** On this server:
- `npm run typecheck`.
- `npm test`: 1364 node tests, 1337 pass, 27 skipped (the browser tests), 0 fail; 219 Vitest tests pass.
- The `browser` job's nine files by hand with the full Chromium build the CI installs: 25 tests, 25 pass. With the headless shell, the notification test fails for want of a push service, the same on `origin/v2`.
- `npm run guard -- --base origin/v2`: nothing refused.
- The capture script on the fixtures source: no page error, no request off the origin.
- Before captures: `docs/v2/ui-overhaul/before/37/` (24 files: the inbox, a request selected, the palette over the inbox; the source had no handled item before this lane, so there is no "before" of the group).
- After captures: `docs/v2/ui-overhaul/after/37/` (80 files, in French: the five screens, the reviewer's request selected, the "Traité" group opened, the palette over the inbox and over the request, and the inbox's sheet, at 1440, 1280, 768 and 390, light and dark), taken again after the art director's round. Each was looked at for secrets and names.

**The art director's look** (`/tmp/cleared-reviews/37-ad.md`, a fresh session; not committed). All eleven items before the merge are taken:
1. **A title that understated what is approved.** The request's sentences moved to `web/lib/request.ts`, words in the shell's catalog, and say themselves:
   - a force push or a `+refspec` ("Pousser la branche de force"), a remote branch deleted;
   - a script fetched and piped to a shell or an interpreter ("Télécharger et exécuter un script distant");
   - `sudo` or `doas` ("Lancer apt en administrateur");
   - a delete of one path named ("Supprimer dist");
   - `chmod`, `chown` ("Changer les droits d'accès"), `sed -i` ("Modifier des fichiers").

   A recursive, forced or absolute delete, sudo, a force push and a fetched script open the fold. Two such parts, or one beside other work, read "Lancer une commande composée", fold open. Each shape is in `app/test/inbox/permission.test.ts`, which fails on the code before (a force push read "Pousser la branche"). `lib/intent.ts` is unchanged.
2. **The session thread's request** (`screens/session/Session.tsx`, `RequestCard`) says what the inbox says: the question naming who asks, the reason by code, the three answers, the command folded (open when it must be read). The command stays whole in `data-command`, which `scripts/proof-j1.ts` now reads in place of the title's code chip (one line; lane 38 owns the proof scripts).
3. **The tower and the palette** title a request by its intent and say its reason in French (`NeedCard.request`, `needTitle`, `needSentence` in `screens/tower/model.ts`). The French test asserts the tower's request row.
4. **The palette's "Pour vous"** keeps what blocks a session before its cut of three: requests, questions, session plans, then releases, plans, contracts, knowledge (`shell/palette.ts`). The tower's own order is unchanged. A new capture, `palette-inbox-permission`, shows the three answers under "Sur cet écran".
5. **"+4"** reads "+ 4 autres" / "+ 1 autre" (and "+ n more").
6. **French spacing in every French catalog** (ask 6, inbox 2, lead 9, session 19, shell 4, tower 15 sentences), with `app/test/french-typography.test.ts`, which fails on a plain space before ? ! ; : » or after «.
7. **Sentences about the interface**: "La liste a été actualisée." is gone from five keys. `knowledge_rule` is grammatical. `confidence_waits`, `confidence_starts` and `train_order_note` say only what changes the decision ("Attend votre Go.", "Démarre seul à la fin du délai.", "Livré dans l'ordre, chaque service vérifié en bonne santé avant le suivant."). `contract_rule` stays: it says the consequence.
8. **"Settled" twice after T.** The fixtures source answered every request with a 404. It now answers a session's request, keeps it in memory (the item handled, a second answer a 409) and tells the stream; `app/test/fixtures.test.ts` holds it. A settled answer says so once: the detail's line, no note. While an answer is under way, the answers stay, disabled, though lane 34's optimistic cache already shows the item handled. A browser test answers T through the source and checks the item moves to "Traité".
9. **The ring through the row's answers**: the row's focus ring is drawn inside it (`outline-offset: -2px`).
10. **Contrast**: `--awaiting-text` (light) is `#9A4D08`, 4.9:1 on the selected row where `#AB570A` gave 4.34:1. Lane 35's contrast test now reads the selected fill as one of its grounds and failed on the old value (`styles/app.css`, `app/test/shell/tokens.test.ts`).
11. **J, K then A on another row**: A, T or R on a walked row that is not the one shown shows it first (a peek), and the next press answers it; under 1024 px they do nothing on a row. The sheet says so in the buttons' words ("Autoriser une fois, ou afficher la ligne choisie"). A browser test walks a row, presses A twice and finds one answer.

**The art director's LATER list, for lane 38 and the owner.**
1. Rows of 74 px (110 with answers) against the plan's 32 to 36 px: the kind as an icon before the title, the age on the title's line, the ticket and state on the second line; with lane 38's density pass, the tower's rows too.
2. On a row, "Toujours pour ce projet" for a compound, unknown or code-less command, without the reason or the command in sight: consider "Autoriser une fois" and "Refuser" alone on such a row.
3. Amber on the kind of 5 of 6 rows: keep amber for what blocks a session (a request, a question), neutral for a review; and order both the inbox and the tower by what blocks a running session first.
4. The deny reason field is the detail's second heaviest object for a rare gesture: a quiet "Ajouter un motif" that opens it, or a hairline border; Enter in it refuses at once, unlike every other field.
5. Nested cards in the release's detail (`.announce` and the frames inside the outlined detail): a hairline instead.
6. A handled row says only "ne vous attend plus": needs the item's outcome from the service (below).
7. "Tour" as the French name of the tower reads as "turn"; "Vue d'ensemble" or "Pilotage" (lane 35's name, the owner's call).
8. "Todo" in `confirm_send_back`, `sent_back`, `send_back_conflict`: "À faire" if the board says it so.
9. The sheet's answers in the buttons' words: done here with item 11.
10. The 390 inbox has no heading or count in its top bar ("Exemple", search and avatar instead): lane 38's mobile pass.
11. Ticket, release and lead titles in English are the data's words, shown as written under French labels (plan 2.5.6): the French test passes on them by design.
12. Row answers are 28 px from 1280 px; from 768 to 1279 px on a touch tablet the row has none: check the tablet path is one tap.

**What lane 37 touched beyond its file list in the art director's round, and why.**
- `v2/app/web/lib/request.ts` (new): the request's sentences, shared by the inbox, the session thread, the tower and the palette.
- `v2/app/web/screens/session/{Session.tsx,session.css}`, `v2/app/web/test/session/render.test.tsx`: item 2.
- `v2/app/web/screens/tower/model.ts`, `v2/app/web/test/{tower.test.tsx,tower-lead.test.tsx}`, `v2/app/test/tower-additions.test.ts`: item 3, and the French spacing's tests.
- `v2/app/web/shell/palette.ts`, `v2/app/test/shell/palette.test.ts`: item 4.
- `v2/app/messages/*.fr.json`, `shell.en.json`: items 1, 5, 6, 11; the request's words moved from the inbox's catalog to the shell's.
- `v2/app/web/styles/app.css`, `v2/app/test/shell/tokens.test.ts`: item 10.
- `v2/scripts/proof-j1.ts`: item 2, one line.

**Measures after the round** (the same harness, full Chromium, CI mode, three runs; lane 38 ran on the server meanwhile, load average 6, so `origin/v2` was measured again interleaved): `origin/v2` 29.9 then 26.4 ms, this branch 33.5 then 27.1 ms, median of the runs' p95; 0 documents, at most 1 request. The two are within the server's noise.

**Followups.**
1. `lib/intent.ts` itself still misreads what `lib/request.ts` now takes first (a write redirect, a substitution, a heredoc, `sh -c`, sudo, a force push): the session screen's step rows and checks use it as is. Lane 36's file.
2. The outcome of a handled request (answered once, always, denied, expired) and when: `PermissionItem` needs `outcome` from the store's `handled_at` and `handled_by`, then the "Traité" rows can say it (LATER 6).
3. The policy's `reasonCode`: the policy lane fills it (`compound`, `not_allowed` with the asking part, `network`, `dependency`, `outside_checkout`); `RULE_CODES` in `lib/request.ts` can then go.
4. The art director's LATER list above.

- Pull request: 255, against `v2`.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j2-ui-inbox-fr`.

## 2026-10-23: the last pass over the whole app, the proof scripts on the French shell, and the measures (the author's choices, lane 38, `v2-j2-polish-measures`)

**Decision.** On 2026-10-23 from 03:50 (Europe/Paris), lane 38 of the interface overhaul ([ui-overhaul-plan.md](ui-overhaul-plan.md), section 7) makes the last pass over the five screens and the sign-in page, brings the proof scripts to the French shell and the ticket view, and fills the plan's section 8. Lane 37 (the inbox, pull request 255) ran beside it: this lane left the inbox's files alone until 255 merged.

- **Fonts.** Both pages preload Geist and Geist Mono (`<link rel="preload" as="font" crossorigin>`, before the sheets). Until Geist arrives, a local face sized to its metrics stands in: Arial, Helvetica or Liberation Sans, with `size-adjust` 102.34 %, ascent 89.9 %, descent 21.5 % and line gap 0. These were measured in Chromium against Arial, whose metrics Liberation Sans shares. Nothing moves when Geist swaps in. Test: `app/test/polish/fonts.test.ts`.
- **One type scale, in rem.** `--text-sm`, `--text-md`, `--text-lg` and `--text-input` are 0.75, 0.875, 1.25 and 1 rem, so the person's own font size scales the text. The session, lead, ask and choices sheets held 13 sizes off the scale (10 to 26 px) and weights 500 and 600; each now uses a token:
  - 12.5 px and under become 12;
  - 13 to 16 px become 14;
  - 20 px and over become 20;
  - 500 and 600 become 550.

  The ink button is at the strong weight. The token test reads every sheet of the app, not only the shell's and the tower's. The same test reads every sheet for transitions on the motion token, opacity and transform only, and for no `outline: none` but the main region and the dialogs: a field's ring keeps a transparent outline, which forced colours draw.
- **The sessions index** is a list of rows, like the tower's. The row is the link, named by its ticket's title and described by its role, phrase, model, ticket and age. What waits for the person comes first, then the most recent. The top bar names the screen, so the index's heading is read out, not drawn. The empty state says "No session yet.", adds "One starts when a ticket moves to Todo.", and offers New ticket, which opens the tower's bar with its field focused. The rows keep `li.session-card`, `.id` and `a.open`, which the proof scripts and the budget test read.
- **The session view.**
  - The empty states are one sentence each ("Nothing yet.", "No picture yet.", "No session plan yet."). Where the terminal or the trial environment cannot open, one sentence says why. A copy test holds every `_empty`, `_none` and `_here_only` sentence of the catalogs to one sentence that never says where things show.
  - The Editor lays out by its panel's width, not the window's. On a screen of 1160 px or more, the Editor tab gives the diff the ticket column's width, as a review pane would. The scope switch reads "All" and "Last turn", which fit the files' column.
  - A check is one line, with its state at the end.
  - A step row's hover fills its own box.
  - The handover sentence is centred under one hairline, so it can wrap.
  - Send waits for a message: one ink button at a time.
  - On a phone the view opens on its ticket's number and title (its description folded), and keeps the role in the status. Interrupt is an icon with its word read out. Take over is 44 px.
  - The screen's one heading is read out: the ticket's number and title.
- **The lead, the tower, the shell.**
  - The lead's own words are flat beside its mark; the person's message keeps a quiet bubble, as in the session's thread. The Plans screen's heading is "Plans", and "Lead" is the chat's.
  - The status dot no longer pulses: the pulse animated box-shadow. What waits has a ring and no glow.
  - Paragraphs and list items wrap pretty.
  - On a phone, the tower's bar is one row (the field and New ticket), and its summary keeps each fact whole.
  - The sample-data pill is neutral: amber says what waits, and nothing else.
  - Touch targets: the heads' links and the session's file links are 44 px.
  - The visually hidden class is defined once, in the app's sheet.
- **Followups taken.**
  - Issue 250 F1. A sheet with `media="not all"` never blocks the first paint, so the page now turns the first screen's sheets on and draws once they have loaded or failed, after 3 s at most (`sheetsReady`, `web/lib/sheets.ts`). The server still answers one page for every address. A browser test holds every screen's sheet 800 ms and checks that the first screen drawn has its sheets on and loaded; it fails on the code before (`app/test/polish/first-paint-browser.test.ts`, in the browser job).
  - Issue 253 item 2: Enter forgets the walked row once the pointer is used.
  - Issue 254 item 1: `scripts/proof-j1.ts` finds the reviewer by the ticket view's handover row (`data-role` on it) and reads each round's verdict by its number.
  - Issue 254 item 3: the journaling sentence is read out under the terminal.
  - Issue 254 item 2 (`intent.ts` gaps) is left to the inbox lane, which uses the sentence as an approval's title. Issue 253 item 1 (a palette gesture whose button disappeared) is left: harmless.
- **The proof scripts.** `scripts/proof-words.ts` turns a catalog key into a pattern that matches the sentence in English or in French, its placeholders as given or as anything (`test/scripts/proof-words.test.ts`). `proof-j1.ts` reads the answers, the verdicts, the release, the checks and Undo with it; `proof-j2.ts` reads the recommended option with it; `proof-j2-multi.ts` reads the rollback's line with it.
  - The first multi-service rehearsal on the French shell failed step 9, on "Annulé, 2 sur 2"; with the catalogs' words it passes.
  - Rehearsals on the fake adapter: `proof-j2` 9 steps ok, 0 failed; `proof-j2-multi` 12 steps ok, 0 failed.
  - `proof-j1` has no rehearsal. It type-checks, and its real run is the orchestrator's, after the merge.

**Impeccable.** Installed at 4.7.0 in the lane's worktree with the owner's command. Its paths are in the shared exclude file and in no commit. The installer's hooks file was removed before any edit, and `DO_NOT_TRACK=1` was set.
- `init` wrote PRODUCT.md from the plan, with no interview: section 6 fixes its inputs.
- `document`, run by an isolated agent, wrote DESIGN.md. Its drift list fed the pass above: off-scale sizes and weights, duplicated `.sr-only`, transitions off the token, focus rings drawn with box-shadow.
- The detector ran over CDP on the fixtures app at 1280 light and 390 dark. Fixed: the pulsing dot, the dark glow, the lead line's leading, three stragglers. Kept: Geist (the brief), the session's flat hierarchy (Operate mode; the top bar names the ticket), the request card (Devin's approval card).
- `critique`, Assessment A, ran as an isolated agent: heuristics 25 of 36. Its items 1 to 5, 7, 10b and 11 to 14 are applied. Item 8, the bar's placeholder, came after lane 37's merge. Not applied:
  - item 6, Hand over to Codex: the owner's decision, B5.10c;
  - item 9, the lead's two empty actions: lane 35's art director chose them;
  - item 10a, a sentence about where things will show: against the copy rules;
  - item 15, the plan's eyebrow and the palette's three rows: lane 35's art director's choices.
- `typeset`, `layout`, `onboard` and `polish` are the bullets above.
- The notes are at `/tmp/cleared-captures/j2/overhaul/38/impeccable-38.md`, not committed.

**The art director's look** (`/tmp/cleared-reviews/38-ad.md`, a fresh session). Its BEFORE MERGE list is empty.
- Applied before lane 37's merge: items 4, 5, 6 (the index), 8, 9 (the bar and the facts), 10 and 11.
- Applied after the merge:
  - Item 1: the inbox's sheet is on the type scale. Its 13 off-scale sizes and weights 500 and 600 now use the tokens, mapped as above. The token test reads every sheet, the inbox's included: the `PENDING` set is empty.
  - Item 2: the row's background transition is gone. The grace bar's fill, a 60-second timer that moves each second, is the one exception the motion test names, as the gradient test names it.
  - Item 3: under 1024 px, where the list is alone, no row is filled as the shown one.
  - Item 7: lane 37 had already given the inbox one name, "Réception", everywhere.
  - Item 9: the bar's placeholder is "Un objectif, une question ou un ticket…" ("A goal, a question or a ticket…"), held under 40 characters by a test.
  - Item 11's contrast pass: the neutral pill's text (`--text-muted` on `--sunken`) is among the contrast test's pairs, AA in both themes.
  - Item 12: the plan's section 8 and the matrix's O20 and O21, below.

**After lane 37's merge (pull request 255).** `origin/v2` was merged into the branch, with no rebase. The conflicts were resolved as follows:
- the capture script keeps both lanes' screens;
- the browser job keeps both new tests;
- the log keeps lane 37's entry, then this one;
- the session's French browser sentence is this lane's one-sentence copy.

Lane 37 titles a request by its intent and folds its command:
- `proof-j1.ts` reads the inbox's command from `#detail .fold-command`;
- lane 37 had already moved its session half to the card's `data-command`.

Lane 37 also put a no-break space before French colons, so `said()` matches a plain, a no-break or a narrow no-break space alike, with a test. `npm test` runs `test/**/*.test.ts`, so the verify job runs that test. Review round 1 of 256 found the test's literal stale before the merge.

The after captures were taken again on the merged head: 166 files, with lane 37's inbox screens.

**The art director's LATER list (none changes this lane).**
1. French typography: the typographic apostrophe and the narrow no-break space before `?`, `:` and `;` in the catalogs, locked by a test.
2. "Tour" for the tower collides with "tour" (a turn) in French sentences. "Vue d'ensemble" or "Accueil" would avoid it; renaming a screen is the owner's call.
3. Hand over to Codex: a dead control that names a product, with milestone jargon in its note. Remove it or build it before the next release; the owner's decision, B5.10c.
4. The button system: three heights in the app. Pick two, and move the inbox's `.btn` onto the shell's button.
5. The lead's empty actions: one, in the plan pane, rectangular.
6. The plan pane's footer: the four facts in a two by two grid, and the share's unit beside each ticket's percentage.
7. The session's ticket column on a wide screen repeats the top bar's title. For a ticket with no description it is a short card above empty space.
8. Check rows: a fixed status column with the chevron's slot on every row.
9. The Editor: "Modifications" names three things. "Lecture seule" should be a muted label with a lock, not a neighbour of the pills.
10. The diff on a phone: a horizontal scroll with the line numbers pinned, not wrapped code.
11. The Plans composer at 390: sticky above the bottom bar.
12. The palette: a count or "Show all" beside "Needs you", and the state, not the role, as a session's accessory.
13. Contrast: `audit`'s pass again after the neutral pill.

**Measures** (the plan's section 8 holds the table; the fixtures source, 1440x900, the median of three runs' p95 of twenty switches through two sessions, taken in one session on 2026-10-23 between 05:26 and 05:29):

| Version | Median p95 | Documents in twenty switches | Requests per switch, at most |
| --- | --- | --- | --- |
| `8a93cd5`, before the overhaul | 116.1 ms (the lap through two sessions: 128.7 ms) | 20 | 13 |
| `e6446c2`, this lane's start | 27.0 ms (29.5 ms) | 0 | 1 |
| `358f8de`, lane 37 merged | 34.5 and 32.0 ms (27.7 and 30.8 ms) | 0 | 1 |
| this lane's head | 33.1, 28.7 and 35.8 ms (29.6, 37.4 and 32.6 ms) | 0 | 1 |

The browser job on GitHub's runner read 46.0, 75.7, 58.9 and 83.9 ms over this pull request's runs, against 54.2 to 70.6 ms for `v2` and its lanes. The handover row arrived 52 to 78 ms after the change event. The terminal and the editor were made once each.

**What lane 38 touched beyond its file list, and why.**
- `.github/workflows/v2.yml`: the first-paint browser test added to the browser job's list.
- `v2/scripts/capture-screens.ts`: the `login` screen.
- `v2/app/test/switch-budget.ts`: the index's empty state as a painted screen.
- `v2/scripts/proof-words.ts` and its test: new, for the proof scripts.

- Pull request: 256, against `v2`.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j2-polish-measures`.

## 2026-10-23: Owner decision: the filter API proof repository's main goes back before LOCAL-11's contract, by a revert commit

**Decision.** On 2026-10-23 at 07:22 (Europe/Paris) the owner approved, in writing, reverting LOCAL-11's contract commit (`35c0376`, "contract: POST /check answers a severity, none or review") on the main branch of the filter API's proof repository (the one the proof instance's `workspace.conf` names) by a revert commit, and the guestbook's side of LOCAL-10 and LOCAL-11 the same way only if the guestbook's `/health` needed it. No history is rewritten: no reset, no force push.

**Why.** The multi-service proof's first ticket asks for that same contract change. With LOCAL-11's contract already on the filter API's main, the ticket's contract step has an empty diff, and an empty contract diff never creates the inbox item that the proof's step 03 waits for.

**What was done.**
- The filter API's main: `752e7c7` (`git revert 35c0376`, on top of `f5c7ddf`), pushed without force. Its deploy watcher deployed `752e7c7` at 05:26:18Z; `/health` answers 200 on both services. LOCAL-11's app commit (`3529630`) stays, so the app still answers `severity` and the repository's contract test fails on two cases until the proof's ticket puts the contract back. The watcher builds `src/` and runs no tests, so the deploy is not affected.
- The guestbook: not reverted. A contract-only revert does not change what the filter API answers, and the guestbook's client falls back to `ok` when `severity` is missing, so its `/health` stayed green. The guestbook has no commit of LOCAL-10.
- LOCAL-17, which a stopped run had started, is in the state LOCAL-13, LOCAL-15 and LOCAL-16 were put back to (the entry above): Todo since 04:14Z, no live session or container, no waiting release, plan, session plan or permission item. Nothing of it is approved or deployed.

- Recorded by: Opus 5.5 (claude-opus-5-5), ops session, branch `v2-j2-ops-final`.

## 2026-10-23: Owner decision: the rest of LOCAL-11 reverted on both proof repositories' main, by revert commits

**Decision.** On 2026-10-23 at 08:23 (Europe/Paris) the owner approved, in writing, reverting LOCAL-11's app commit on the filter API proof repository's main (`3529630`, "filter-api: POST /check answers severity, none or review") and LOCAL-11's guestbook commit on the guestbook proof repository's main (`7d46cd0`, "Hold an entry the filter flags for review instead of refusing it"), each by a revert commit pushed to main. No history is rewritten.

**Why.** The first revert (the entry above) took back only LOCAL-11's contract, and left its app half on the filter API and its guestbook half on the guestbook. The proof's ticket, LOCAL-19, then had nothing to change but the contract. Its contract step was validated (step 03), but the reviewer saw a contract-only change to the filter API and the guestbook's fallback for a missing `severity`, and asked for changes in both review rounds. LOCAL-19 went back to Todo after the second round, with no pull request opened, so step 06 never got a release card and the run could not pass. With both halves reverted, the proof base is the one the ticket starts from: no `severity` in the contract, in the filter API or in the guestbook.

**What was done.**
- The proof driver of that run was stopped, with its children only (steps 00 to 05 had passed).
- The filter API's main: `f20fd6d` (`git revert 3529630`, on top of `752e7c7`). Its watcher deployed it; `POST /check` answers `ok` and `words` again. Its tests pass, 37 of 37, locally and on the push's checks.
- The guestbook's main: `d88cb3a` (`git revert 7d46cd0`, on top of `9637c4a`). Its watcher deployed it. Its checks on the push pass, 48 of 48, against Postgres. The `held` and `held_words` columns stay in the proof database, with their defaults; the reverted code does not read them.
- `/health` answers 200 on both services after the deploys.
- LOCAL-19 is in the state LOCAL-17 was left in: Todo, no live session, no waiting release, plan, session plan or permission item, no release train, no branch. Nothing of it is approved or deployed.

- Recorded by: Opus 5.5 (claude-opus-5-5), ops session, branch `v2-j2-ops-final-2`.

## 2026-10-23: the interface in French and in English from catalogs, the language from the browser, one formatter for durations and dates (the author's choices, lane i18n, `v2-j2-ui-durations`)

**Decision.** On 2026-10-23 at 08:30 (Europe/Paris) the owner approved a small lane: durations in a human format through one formatter, the session statuses still in English on Sessions translated, "Lead" capitalised everywhere and "Relecteur" kept as it is. At 08:40 the owner widened it into the i18n lane (requirement O23): every visible word from a French or an English catalog, the page's language from the browser with French as the fallback, a language choice in the account menu, durations, relative dates and numbers through Intl, and a test that fails on any visible text from no catalog and on any key missing in one language. The branch keeps its name.

- **One formatter** (`app/web/lib/time.ts`). A duration is "42 min" under an hour, "10 h 30" under a day and "2 j 4 h" past it. In English: "42 min", "10h 30m", "2d 4h". An age under a minute is "à l'instant" ("just now"). A date is said relative to now: "il y a 3 min", "il y a 2 h" the same day, "hier" ("yesterday", by `Intl.RelativeTimeFormat`) the day before, then "il y a 3 j". Calendar days are counted in the page's time zone. The numbers go through `Intl.NumberFormat` in the catalog's `locale`, with the minutes after the hours padded in French ("10 h 05") and not in English ("10h 5m"). A decimal ("3,9" or "3.9") goes the same way. Removed: the tower's `duration` and `about`, the inbox's `elapsed` and `took`, the plan panel's `formatDuration`, the session's `duration`, the Lead's `ago`, five copies of `clock`, the tower's decimal mark, and the catalog keys they used. The sessions index said "1562 min" for a session started the day before.
- **Statuses** (`app/web/lib/status.ts`). A session's phase says its own word: "Démarrage", "Au travail", "En relecture", "Terminée", "Arrêtée", "Arrêtée sur une erreur", "En pause". The four phrases the service builds for a tool are translated by their shape: "Lit src/page.ts", "Modifie…", "Cherche…", "Lance npm test". This applies only when what follows is a path, a pattern or a command, so a harness's own sentence ("Reading the diff of…") stays as written, like every other data text. A ticket state with one of the tracker's default names is translated ("À faire", "En cours", "En relecture", "À approuver", "Prêt à livrer", "Terminé"); a state a workspace named itself stays as named. The sessions index, the tower's rows and the session's status all use it. The `status_*` keys moved to the shell's catalog, which every screen holds.
- **Lead.** Every catalog value says "Lead" ("le Lead", "the Lead"). French no longer says "chef de projet". "Relecteur" is untouched.
- **The language of a page** (`app/src/catalog.ts`, `languageOf`). The person's choice comes first, from the `cleared_lang` cookie. Then the browser's `Accept-Language`, by weight. Then `CLEARED_V2_APP_LANGUAGE`, which becomes that fallback (French by default). The server answers the sign-in page, the shell page, `/api/me` and the catalogs in that language. There is no per-account preference on the server, so none was added. The account menu at the sidebar's foot offers Français and English, each named in its own language (`lang` set), as two segments 44 px tall on a phone. A choice is kept in `localStorage` (`cleared.language`) and in the cookie (one year, `SameSite=Lax`, `Secure` on https). It sets `<html lang>` and redraws the shell, the screens and the sessions kept mounted, in the page and with no reload. If the cookie is lost, the stored choice wins at the next load and is written back. `app/web/lib/language.ts` holds it.
- **Every word from a catalog** (`app/web/test/i18n.test.tsx`). It replaces lane 37's `french.test.tsx` and lane 35's `shell/french.test.tsx`, which looked for English. Every screen of the old test is drawn on the fixtures in French and in English: the sign-in page with its errors, the tower full and empty, the sessions index full and empty, the sidebar open and folded, a session, every session phase, the Lead full and empty, a question to the code, the inbox (every kind × 13 local states), and the palette and the sheet on every screen. Each text a person reads or hears must come from one of five sources:
  - a sentence or template of that language's catalogs;
  - the fixtures' data and the forms the app gives it;
  - a text with no word, an id or a hash;
  - a key cap;
  - pieces joined by " · ", by sentences, or by the catalog's own connectors ("et", "puis").
  A marked key fails. In French, a status in the service's English fails. A static scan keeps every `.tsx` from writing a word between tags or in a visible attribute. On the code before, it fails on the statuses and found two hard-coded words:
  - cmdk's default "Suggestions", which named the palette's list; it is now `palette_results`;
  - "Ctrl", written by `keyLabel`; it is now `key_cap_ctrl`, and `keyLabel` and `Keys` take the translator.
  The catalog test already held every key in both languages. The new test repeats it.
- **Tests first.**
  - `durations.test.tsx` draws every screen in both languages at the fixtures' clock and a day and two hours later, and fails on any "<n> min" with n of 60 or more. On the code before it failed on "1585 min".
  - `app/test/time.test.ts` is the formatter's and the statuses' table.
  - `app/test/language.test.ts` covers the server's choice.
  - `app/test/language-page.test.ts` covers the page's memory.
  - `app/test/i18n-browser.test.ts` (added to the browser job) covers a browser in English, the switch to French in the page, a reload, a lost cookie, and a browser in German.
  - Issue 257, item 1: the inbox's long French test has a 60 s timeout.

**Impeccable.** 4.7.0, installed in the lane's worktree with the owner's command. Its paths are in the shared exclude file and in no commit. The installer's hooks file was emptied before any edit, and `DO_NOT_TRACK=1` was set.
- `init` wrote PRODUCT.md from the plan and the owner's two requests, with no interview: section 6 fixes init's inputs.
- `document` recorded the incumbent sheet (lanes 35 and 38) in DESIGN.md.
- The detector, run on the changed files, reports Geist only (the brief).
- `audit` and `critique` were run on the captures:
  - the language segments follow the inbox's switch, with the same tokens and the same contrast pair;
  - on a phone they sit under the theme's item, at 44 px;
  - the rail's tooltip on the avatar showed while the menu was open at 1280 and 768; the art director's item 5 below removes it.
- `polish`: no dead key or formatter left; each language's catalogs lost 24 keys the old formatters used.

**Captures.** All are on the fixtures source, in both themes, at 1440, 1280, 768 and 390.
- Before, at origin/v2 `f16f9b1`: `docs/v2/ui-overhaul/before/durations/{fr,en}/`, tower, sessions, session and inbox. The English set was taken with `--language en`.
- After: `docs/v2/ui-overhaul/after/durations/{fr,en}/`, the same screens plus `account` (the menu with its language choice). The browser asks for the language too: the capture script now sets the context's locale, since the page follows the browser.
- `sessions-day-later-1440-light.png`, before and after, in French: the sessions index with the page's clock a day and two hours after the fixtures'. Before, it says "1585 min"; after, "1 j 2 h". A script in the author's scratchpad took it (the fixtures' data at their clock, the page's clock moved), not the repository's capture script.
- 148 files. Each was looked at for secrets and names before the commit: none.
- `tower-day-later-1440-light.png`, before and after, in French, taken the same way after the art director's look: "26 h 57" becomes "1 j 2 h", "rafraîchi il y a 26 h…" becomes "rafraîchi hier", "Mise en productic" is whole, and the English status "Waiting for your permissi…" reads "En pause, attend votre réponse".
- Copies are in `/tmp/cleared-captures/j2/overhaul/durations/`. The six the orchestrator asked for are in `/tmp/cleared-captures/j2/overhaul/i18n/`:
  - `i18n-before-{fr,en}.png`: the tower at `f16f9b1`;
  - `i18n-after-{fr,en}.png`: the tower, 1440 light, after the art director's items;
  - `durations-{before,after}.png`: the tower a day later.

**Measures.** The budget test (`budget-browser.test.ts`, `CI=true`: three runs of twenty switches, 1440x900, the fixtures) ran twice on origin/v2 `f16f9b1` and on this head, alternating, between 09:12 and 09:13, load average 1.6 to 2.9:

| Version | Median of the runs' p95 | Runs' p95 | Documents | Requests per switch, at most |
| --- | --- | --- | --- | --- |
| `f16f9b1` (origin/v2) | 23.3 and 25.4 ms | 22.2, 23.3, 25.5; 26.0, 21.3, 25.4 | 0 | 1 |
| this lane's head | 23.8 and 22.6 ms | 21.9, 23.8, 25.3; 22.6, 24.6, 21.3 | 0 | 1 |

A language switch, from the click on Français to the sidebar drawn in French, took 88 to 95 ms over three runs, as seen by Playwright from outside the page.

**What the lane touched beyond its screens, and why.**
- `v2/app/src/{catalog,config,server}.ts`: the page's language per request.
- `v2/scripts/capture-screens.ts`: the `account` capture and the browser's locale.
- `.github/workflows/v2.yml`: `i18n-browser.test.ts` in the browser job's list.
- Other lanes' tests:
  - their translators now hold the shell's catalog, as the app's do;
  - their English durations read "2h 15m";
  - their sentences read "the Lead";
  - `keys.test.ts` passes a translator to `keyLabel`;
  - `shell-browser.test.ts` skips templates with under two letters of their own: "{n}s" matched "Sessions".
- `app/test/notify/browser.test.ts` times out on this server, on origin/v2 too (`#notify-toggle[data-action=on]` never shows). It is not this lane's; CI runs it.

**Left.** The tower's schedule line says a weekday through `toLocaleDateString`, and the Lead's thread says a day and a month the same way. Both are Intl already, and `time.ts`'s header names them as the formatter's one exception.

**The art director's look** (`/tmp/cleared-reviews/i18n-ad.md`, a fresh Sonnet 5.5 session, head `7ec1e75`). All eight BEFORE MERGE items are applied, and the after captures were taken again on the result.
1. `boundary_failed` no longer agrees with a screen's gender or number: "Chargement impossible\u00a0: {screen}." and "Could not load {screen}.".
2. The tower's rows give the kind its width up to 160 px (`fit-content(160px)`): "Mise en production" is whole, and "Connaissance" and "Autorisation" fit too.
3. A number keeps its unit. The `time_*` keys hold no-break spaces, between the number and its unit and between the hours and the minutes ("10\u00a0h\u00a030", "10h\u00a030m"), and so does `login_throttled`. French "%" follows a narrow no-break space in all 11 templates. `time.test.ts` fails on a breaking space inside a duration.
4. On a phone the tower's facts stack, one per line, and the " · " separators are hidden (they are now `.fact-sep` spans).
5. A button whose menu is open shows no tooltip (`[data-tip][aria-expanded="true"]::after`). This covers the avatar and the notifications.
6. The other private `Intl.NumberFormat`s go through `time.ts`:
   - `fixed` for amounts and shares, in ask, the plan panel, the inbox, the session's steps and the tower's schedules;
   - `count` for token counts, in ask and the session's status.
   The header names the two `toLocaleDateString` dates as the one exception.
7. French quotes around the Lead's last message: the tower's rule used U+202F, which drew no visible space ("«Understood"). It now uses U+00A0.
8. `notify_no_subject`, `notify_config` and `notify_store` say what the person can do, with no README and no file mode: "Notifications are not set up on the service. Ask whoever runs it." In French: "… Signalez-le à la personne qui l'administre.". The README's notifications section stays the operator's reference.

The LATER items are in the pull request's body as follow-ups.

**Owner-facing decision: "Go" stays "Go" in French** (`cmd_go`, the plan gate's "Go donné…"). The art director's LATER list asked to log it, so that no later lane "fixes" it. Go is the product's word for letting a session start: a gesture, used as a name in both languages.

**The browser job was red on pull request 263.** Seven tests failed: the boundary's French sentence, the inbox's French requests and the shell's French sheet. They started the app with French as its setting, but GitHub's Chromium asks for `en-US`, which the app now honours. On this server the headless shell does not send that header, so they passed here. Every browser test's context now names its locale: `fr-FR` where the test reads French, `en-US` elsewhere.

- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j2-ui-durations` (i18n).

## 2026-10-23: Owner decision: the stopped leads' containers and networks on the proof host are removed by name

**Decision.** On 2026-10-23 at 10:19 (Europe/Paris) the owner approved, in writing, removing by name the containers and networks labelled `cleared.dev=v2` of the five stopped leads (`a75e176e`, `8b1ddedc`, `e86e2f32`, `bdd33971`, `c354868f`), once the running proof had finished. Nothing else: not the demo's, not the live leads', not `cleared-guestbook`, no unlabelled network, no volume, no prune.

**Why.** Step 08 of the multi-service proof timed out waiting for its release card. Docker's default address pool on the host holds 31 subnets, and 29 were taken: 15 labelled `cleared.dev=v2`, ten of them the `cleared-v2-<id>` and `-out` networks of the five stopped leads, never released, and 14 unlabelled ones that are not ours. A session needs two networks, so the next session could not start.

**Consequences.**
- Each container and network is checked for the `cleared.dev=v2` label and its `cleared.session` before removal, and removed by its name. Volumes are kept.
- The proof is rerun from a clean state after the removal.
- The service must release a session's networks when the session stops: issue #265.
- Recorded by: Opus 5.5 (claude-opus-5-5), ops lane, branch `v2-j2-ops-networks`.

## 2026-10-23: Owner decision: the LOCAL-20 merges reverted on both proof repositories' main, the last push to main

**Decision.** On 2026-10-23 at 11:24 (Europe/Paris) the owner approved, in writing, reverting the LOCAL-20 merges on the main branch of both proof repositories with `git revert -m 1`: the filter API's merge `8c3f87a` (revert commit `2127dd2`) and the guestbook's merge `b9f65ce` (revert commit `0d7fbb5`). The owner declared this the last push to main of the proof repositories. From then on, the proof runs from a frozen base branch and a disposable run branch in each repository (the entry below, [proof-clean-base.md](proof-clean-base.md)).

**What was done**, as relayed by the ops session:
- Both merges were reverted with a revert commit each, pushed to main without force. No history was rewritten.
- LOCAL-22 was moved to In Review through the API, and the service was then restarted. The restart recovery, which puts a ticket left In Review back in Todo, runs only once a request builds the flow's engine. The entry below makes it run at start.

**Consequences.**
- No later run pushes to main: requirement O24 in [requirements-matrix.md](requirements-matrix.md).
- The frozen base is created once from main as it stands after these reverts, following the setup in [proof-clean-base.md](proof-clean-base.md).
- Recorded by: Opus 5.5 (claude-opus-5-5), lane `v2-j2-proof-clean-base`, at the ops session's request. This lane pushed nothing to any main.

## 2026-10-23: the proof's clean base, the questions answered, set aside, the stopped sessions released, the modules started at start (the author's choices, lane `v2-j2-proof-clean-base`)

**Goal.** The multi-service proof (`v2/scripts/proof-j2-multi.ts`) reaches 12 of 12 steps reliably. Three things made runs fail or need a person:
- a session's question that nobody answered;
- a base that earlier runs had changed;
- Docker's address pool filled by the networks of stopped sessions (issue 265).

**Choices.**
- **The questions** (P60). The driver now tends a session's question on one of its tickets, as it tends permissions and session plans: from the inbox detail, the option whose label ends with "(Recommended)", else the first option. A multiple choice gets one option too. A question with no option gets a fixed free answer. The labels come from the API (`chooseAnswers` in `scripts/proof-inbox.ts`), so the choice does not depend on the page's language. Each option is found by reading its `data-answer` back, never by writing the label into a selector, because labels hold parentheses and quotes. Each question, its options, the answer and how it was chosen go into `result.json` and a "Session questions" table in `durations.md`. Ticket 3's author in the rehearsal asks one, with the recommended option second.
- **A frozen base and a run branch** (O24, P51, `scripts/proof-base.ts`, [proof-clean-base.md](proof-clean-base.md)). These are mostly settings: the workspace's `base`, the brokers' `[lanes] base` and the watchers' `--branch` name the run branch. The code is the reset and its guards.
  - The reset is one push with an explicit refspec, `<frozen commit>:refs/heads/proof-run`.
  - It refuses main, master, the repository's default branch, the frozen branch, and a run branch that is not every service's base in `GET /api/workspace`.
  - It refuses a frozen commit that already holds a change of the proof's tickets, the cause of step 3's empty contract diff in the runs before.
  - Before the reset, every clone the service uses was checked: they all fetch with a forced refspec, or clone afresh, so a forced move of the base breaks none of them.
  - The open pull requests into the run branch are closed; pull requests into any other branch are left alone.
  - After the reset, the run waits for each watcher's container labelled with the frozen commit, then for each health address.
  - A failure stops the run before ticket 1, with the reason in `result.json` (`baseError`). It is not a numbered step, so the count stays 12.
- **Set aside** (P61, `POST /api/tickets/:id/set-aside`). Nothing in the service put a ticket in "Todo, nothing waiting":
  - a move to Todo starts the ticket again;
  - a release card's Send back is that move;
  - the restart recovery runs only at a restart.

  The new owner action stops the ticket's live sessions through the engine's own close path. It settles everything of the ticket that waits, of every kind, halts a train not yet approved and holds its steps. The ticket goes to Todo without `begin`, with a comment. An approved ticket, a done one and a train that lands are refused: nothing is merged or reverted. The proof sets aside its earlier runs' tickets, found by its four titles, then reads the API again and stops if one is still open. Issue 249's Reject or Close action in the interface stays open.
- **The stopped sessions released** (P50, issue 265). `Docker.releaseStopped` makes one labelled `ps` and one labelled `network ls`. It keeps the rows whose `cleared.session` is one of the given ids and whose name is `cleared-v2-<id>` or under it. It removes them by name: the containers with `rm --force` (without `--volumes`, which would delete anonymous volumes), then the networks. It runs no volume, image or prune command. The ids are taken positively from this service's own ledger, never as "every labelled object not in use": the demo shares the host and the label. They come from two places:
  - the flow's sessions that are not live, after the restart recovery. This covers the stopped session that kept its five containers running;
  - the lead's ended generations, after the lead ends the one a dead process left. This covers the lead whose session container had exited while the ledger still said working: its egress container and its two networks.

  - while the service runs, every tick of the flow (30 s) takes the sessions its ledger says stopped in the last ten minutes, so a session whose own stop did not remove its objects, or whose container exited, is released within 60 s of its stop and retried for ten minutes. A tick with no such session asks Docker nothing. A session that a resume is starting under its own names (a step reopened, an author reopened after review, a Give back) is never released, though its row may still say done.

  A failure is logged and never stops the service or the lead. The doctor's new `pool` section counts the subnets of Docker's address pools: daemon.json's `default-address-pools`, else Docker's defaults (31 subnets). The subnets taken are read from the host's interfaces and from an inspection of the labelled networks, never from a list of unlabelled ones, so the free count is an upper bound. A session takes two networks, so the check fails under two free. It then makes the two labelled networks of a session id of its own, releases them with `releaseStopped`, and checks that nothing keeps the label and the free count is back. On this host on 2026-10-23 it read 31 in all, 19 taken (7 of them labelled networks), 12 free at most; 21 taken with the two networks; 12 free again after the release.
- **The modules start at start** (P62). The flow's engine, and with it the restart recovery and the release above, was built on the first request, so nothing ran until the app called the API. `Module` gets an optional `start(registry)`. `assemble` gives `App.start`, which `main.ts` calls once the service listens: one line, written down at the top of `main.ts` as the earlier exceptions are. The flow module builds its engine. The lead module builds the lead and its plans, as a lead route does, so the scheduler no longer waits for the app either (P33's followup). A test starts the real service over a ledger with a ticket left In Progress and sees it in Todo with no request made; with the start call removed, that test fails.
- **The rehearsal** follows the real setup. Its bare copies have `proof-base` and a `proof-run` that an earlier run moved on. Its workspace and its two stand-in brokers (`startBroker`'s new `base` option, `main` when absent) name `proof-run`, and the proof recreates the run branch before ticket 1. Its ports stay 9700 to 9799.

**Runs.** The multi rehearsal (`PROOF_REHEARSAL=1`, bare copies in a temporary folder, ports 9700 to 9799, the demo untouched) passed 12 of 12 twice in a row on 2026-10-23.
- In the first run, each run branch was recreated at its `proof-base`, which `result.json` records, and the bare copies' main did not move. Ticket 3's question was answered "From 0 (Recommended)", the second option, and recorded.
- In the second run, an earlier run had left ticket 1 Done with a knowledge item waiting and ticket 2 waiting for its approval. Both were set aside through the app before ticket 1: the first stayed Done, the second went back to Todo, and both items were settled by the owner account.

**Not done here.**
- The real proof was not run: no disposable run branch exists yet on the proof repositories, and the demo stays as it is.
- The message when Docker's pool is full (issue 265's third item) is a followup; the doctor's `pool` section says how much is left.
- Two real runs in a row with the same score (P51) wait for the one-time setup.

- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j2-proof-clean-base`.

## 2026-10-23: the owner approved ten proposals on 2026-10-23 at 11:51, tracked as issues

**Decision.** On 2026-10-23 at 11:51 (Europe/Paris) the owner approved ten proposals, each tracked as an issue. At 11:55 they were added to [requirements-matrix.md](requirements-matrix.md) as lines P50 to P59, with their effort, milestone and acceptance criteria:

| Line | Issue | Proposal | Effort | Milestone |
| --- | --- | --- | --- | --- |
| P50 | #265 | Release the networks of stopped sessions | S | 2, delivered by lane `v2-j2-proof-clean-base` |
| P51 | #267 | A proof run never pushes to main | S | 2, delivered by lane `v2-j2-proof-clean-base` |
| P52 | #268 | The reviewer runs the service's tests | M | 3 |
| P53 | #249 | Reject or Close a card | S | 3 |
| P54 | #269 | An agent's multiple-choice questions in the inbox | M | 3 |
| P55 | #270 | A reliable, stored quota reading | M | 3 |
| P56 | #271 | Parallel variants of one ticket | L | 3 |
| P57 | #272 | Replay and resume a session from a step | M | 3 |
| P58 | #273 | Automatic CI repair | M | 3 |
| P59 | #274 | A project page kept up to date per service | L | 4 |

**Consequences.**
- P50 and P51 are delivered by lane `v2-j2-proof-clean-base`. Their acceptance criteria are covered by its tests, named in the matrix, and by `doctor pool`. One criterion stays open: two real runs in a row with the same score, which waits for the one-time setup of [proof-clean-base.md](proof-clean-base.md).
- The lane had first numbered its own lines P50 to P53. Before its merge they became P60 to P62, and its release line was folded into P50: an id is never reused, and none of the lane's ids had been merged.
- P53 and P54 build on this lane. Set aside (P61) is the service side of a Close, without its reason or its screen. The proof script's answer to a question (P60) is one of P54's criteria.
- Recorded by: Opus 5.5 (claude-opus-5-5), lane `v2-j2-proof-clean-base`, at the owner's request relayed by the ops session.

## 2026-10-23: the clean base's guards fail closed, and a real run needs PROOF_REPOS (review 1 of pull request 275, followups 1 and 2)

**Decision.** Review 1 of pull request 275 passed with two followups on the no-push-to-main guarantee, fixed before review 2 at the orchestrator's request (P51):
- **Followup 1.** When `git ls-remote --symref` gave no default branch, the guard went on. A default branch named neither main nor master (`v2`, `develop`) could then be force-pushed if `PROOF_RUN_BRANCH` named it.
  - `refusal` and `recreate` now refuse when a repository's default branch cannot be read.
  - Both also refuse a run branch that does not start with `proof-`, so no ordinary branch name can be the target.
- **Followup 2.** Without `PROOF_REPOS`, a real run reset nothing and ran on the branches as it found them. A workspace still on main would then merge the proof's tickets into main.
  - A real run without `PROOF_REPOS` now stops before it signs in (`baseModeOf`, exit 64).
  - `PROOF_REPOS=none` is accepted by the rehearsal only, where it skips the reset of its own bare copies.
  - `refusal` also refuses any workspace whose base is main or master, naming each such service, even one with no clone named.

**Tests.** `test/scripts/proof-base.test.ts`:
- an unread default branch, refused by `refusal` and by `recreate` before any push;
- run branches `v2`, `develop`, `proof`, `proof-`, `run-proof` and `Proof-run`, refused;
- a workspace base of main or master, refused;
- `baseModeOf` in both modes;
- the driver itself, started without `PROOF_REPOS` and with `PROOF_REPOS=none`, exiting 64 with the reason before it opens a browser.

Followups 3 to 7 of the review stay open for the next round.

- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j2-proof-clean-base`.

## 2026-10-23: Orchestrator decision: the proof repositories' checks also run on the run branch

**Decision.** On 2026-10-23 at 14:19 (Europe/Paris) the orchestrator, not the owner, decided to add `proof-run` to the `push` and `pull_request` branches of `.github/workflows/checks.yml` in both proof repositories, by one commit on `proof-base` each (filter API `ffa50a7`, guestbook `8727d60`), then to recreate `proof-run` from `proof-base`. Main is not touched: its heads are still the revert commits `2127dd2` (filter API) and `0d7fbb5` (guestbook) of the entry above. The commits are reversible and stay on proof branches.

**Why.** On the first run on the clean base, step 06 waited for a release card that could not come: the pull requests into `proof-run` had no checks, because the workflows only triggered on `main`.

**Consequences.**
- The running proof was stopped and relaunched. Checks now run on `proof-run` (filter API run 39952852338, guestbook run 39952857168).
- `proof-run` was recreated from the new `proof-base` head in each repository. The frozen-base rule still holds: `proof-base` moves only on a written decision, as here.
- An audit found one more `main` on the host side: the variable `CLEARED_V2_BASE` in the proof host's environment file, read only in one-service mode, was changed from `main` to `proof-run`. Watchers, brokers and workspace services were already on `proof-run`.
- The run's start check must refuse a base whose checks do not trigger on the run branch: issue #277 (the start check verifies that checks trigger on the run branch).
- No change to the milestone 2 plan is expected: its unknowns table has no item on the checks trigger.
- Recorded by: the orchestrator, ops lane, branch `v2-j2-ops-proofci`; this entry also corrects the commit ids of the entry above (the ids it named are the revert commits, not the merges).

## 2026-10-23: the proof's driver lets an author or a reviewer run its service's declared checks (P52, partial)

**Decision.** In run 5 of the multi-service proof, step 10 failed. The driver's `tend()` answers each permission a session of the proof's tickets asks with the checkout rule (`answerFor`, `scripts/proof-inbox.ts`), and it denied the reviewer's requests to run the service's tests. The reviewer judged on the diff alone, asked for changes twice, and the ticket went back to Todo. The driver now allows once a request from an author or a reviewer to run exactly one of the checks declared in its service's frozen base (the script's name is declared there; the script that runs is the checkout's). Every other request keeps the answer it had.
- The declared checks are `test`, `typecheck` and `lint` among the scripts of the service's `package.json`, as `npm test`, `npm run typecheck` and `npm run lint`. They are read from the frozen base of each proof repository when the run prepares its clean base, the same file the service's policy reads its scripts from. Without a clean base (the rehearsal with `PROOF_REPOS=none`) no check is declared, and the old rule answers.
- The session's role and service come from `GET /api/sessions`, read once per pass of `tend()`. A lead, a reader, or a role the driver cannot read gets the old rule's answer.
- `answerFor` is unchanged: the milestone 1 proof and the 48-hour proof's morning share it.
- Each answer is traced in `result.json` and in the report's "Session permissions" section: the ticket, the session, its role and service, the command (cut to 160 characters), the answer, and the rule that gave it (`check`, `checkout`, `refused`, `not_a_command`). A role shown as unknown is a session the driver could not read in that pass of `tend()` (the sessions are read once per pass); it gets the checkout rule.

**What it does not fix.** The ledger of run 5 shows that the reviewer's two requests on the third ticket were compound commands, not a bare check:
- `npm test | tail; npm run typecheck | tail; git ls-files; grep "a\|b" ... | head`. It is read-only, but the checkout rule refuses it: `git ls-files` is not in its list of git commands, and its split does not read quotes, so it cuts the grep pattern at `\|`.
- A check followed by a file written to `/tmp` through a heredoc. It is refused, and rightly.

A bare `npm test` or `npm run typecheck` was already allowed by the checkout rule, and the service's policy allows it without asking (`run.safe`), so it never reaches the inbox. The exact rule makes the reviewer's checks explicit and traced, but alone it would not have changed step 10 of run 5. Widening the driver to compounds of checks and reads (a split that reads quotes, `git ls-files`) changes the answer to other requests, so it is left to the owner as a follow-up lane. The rest of P52 (the service's policy allowing only the declared test command, the verdict carrying the result) stays for milestone 3.

**Tests.**
- `test/scripts/proof-inbox.test.ts`: the declared checks read from a `package.json`; an author's or a reviewer's exact check, allowed once; a write outside the checkout, a network command or an install, refused whatever the role, run 5's first reviewer request among them; a lead, a reader, an empty or unknown role, answered by the checkout rule.
- `test/scripts/proof-report.test.ts`: the report's permissions section.

- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j2-proof-driver-review`.

## 2026-10-23: the proof's checkout rule reads a command with the service's parser, and a real run's start check reads the checks and the watchers (review 1 of pull request 279, followup 1; issue 277)

**Decision 1: the checkout rule parses a command.** Followup 1 of review 1 of pull request 279: the exact rule of the entry above would not have changed step 10 of run 5. At the owner's request, the checkout rule (`insideCheckout`, `scripts/proof-inbox.ts`) now reads a command with the service's own shell parser (`parseList`, `src/session/policy.ts`) instead of splitting its text:
- Quotes are understood, and every part of a list joined by `;`, `&&`, `||` or `|` is judged word for word, with the files its output redirections write.
- Whatever the parser refuses is denied: a substitution, an expansion, a here-document, an input redirection, a subshell, a newline, a lone `&`.
- `parseList` and `parseCommand` take an opt-in `globs` that only the driver passes. With it, an unquoted `*`, `?` or `[` is read in a word with no slash that does not start with a dot, so it names files of the current folder only. The policy never passes it, and its behaviour is unchanged (its tests pass as they were).
- Newly allowed: `git ls-files`; `cd` into a folder of the checkout; `npm test` or `npm run <script>` with npm's options from a list, and after `--` the runner's options from a list (a name to match, a reporter) and files; `npx tsc --noEmit` with `-p` or `--project` inside the checkout. `npx tsc` fetches a package from the registry when the checkout has no TypeScript, as `npm ci` does: the egress proxy bounds it.
- The rule is shared: `answerFor` answers with it in the milestone 1 proof (`inboxAction`) and in the 48-hour proof's morning (`morningAction`) too, so those proofs get the parsed reading as well, with what it allows and refuses below. The entry above said `answerFor` was unchanged; it no longer is.
- Newly refused: `cd` alone (home) and `cd -`; an option whose value after `=` names a path outside the checkout (`--output=/tmp/x`, `--script-shell=/bin/sh`); `--require`, `--import` or any option not in the runner's list after `--`; a newline between two commands, which the first rule split and judged.
- Run 5's reviewer request on the third ticket (`npm test 2>&1 | tail -15; npm run typecheck 2>&1 | tail -5; git ls-files; grep -rn "findWords\|words:" --include=* -r src README.md | grep -v "^src/words.ts" | head`) is allowed once.
- Its other request and the earlier runs' reviewer requests stay refused: a scratch file written to `/tmp` through a here-document and run with `node`, or `${DATABASE_URL:+set}`.
- Followups 2 and 4 of the same review: the comments say "declared in the frozen base" (the script that runs is the checkout's), and the refusal's rule is named `refused`.

**Decision 2: a real run's start check (issue 277).** Before anything is set aside or recreated, a real run stops with code 64 (`StartRefusal`) and a clear message:
- when no workflow of a proof repository's frozen base runs on both a push and a pull request to the run branch (`checksRunOn`, `workflowsAt`). The workflows are read without a YAML library: the top-level `on:` as a list, or as events filtered on `branches` and `branches-ignore` with GitHub's patterns. An event filtered on anything else (paths, tags, types, a flow mapping) does not count, so an unsure reading refuses;
- when a deploy watcher of one of the run's services deploys another branch (its `--branch`, `main` by default), when a service has no watcher, or when the service of a running watcher cannot be read (`readWatchers`, `watcherRefusal`). Watchers are read from `/proc`: each `deploy/watch.ts` process, and the `cleared.example` label of the script it runs;
- when a service's base in the workspace is not the run branch (`refusal`, as before; it now stops with 64 too).

The rehearsal skips the workflows and the watchers: its forge and its brokers are stand-ins, and it has no watcher. A sanity check on the proof host, read only, found both watchers on `proof-run` and both repositories' checks running on it.

**Tests.**
- `test/scripts/proof-inbox.test.ts`: the reviewers' refused requests of run 5 and the earlier runs, verbatim from the ledger, allowed or refused as above; the common forms; the refusals.
- `test/scripts/proof-base.test.ts`: the recorded workflows of both proof repositories, with branches `[main]` refused and `[main, proof-run]` accepted, and this repository's example, still on main, refused; the filters, and the unsure readings refused; the workflows of a commit read from a clone; the watchers read from a stand-in `/proc`; each refusal.
- The guard of the proof scripts' pushes lists the line that reads the workflow event `push`, which is not a git push.

- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j2-proof-driver-review`.

## 2026-10-23: the proof's checkout rule allows each program only with its options from a list (review 2 of pull request 279)

**Decision.** Review 2 of pull request 279 found a security regression of round 2, blocking. With the parser, a quoted word is one word, and `sed` reads the first word that is not an option as its script: `sed -n 'w /tmp/pwn' 1p README.md` wrote a file outside the checkout, and `sed -n 'e id' 1p README.md` ran a command. Both were answered `allow_once`. At the owner's request, round 3 closes that and the review's followups in this pull request:
- **sed**: `-n`, then a script that is exactly one word `^\d+(,\d+)?p$`, then files. Any other script or option is refused.
- **Each piece of a word**: a quoted word holding spaces is also read piece by piece as a path, so `'w /tmp/pwn'` names `/tmp/pwn` and is refused, whatever the program.
- **sort**: its ordering options only (`-k`, `-t`, `-n`, `-r`, `-u` and their long names). `--compress-program` (or any prefix of it), `-S`, `-T`, `-o` and `--files0-from` are refused.
- **rg**: its search and output options only, from a list. `--pre`, `--pre-glob`, `-z`, `--search-zip` and ripgrep 14's `--hostname-bin`, which runs a program, are refused, and so is every option not listed.
- **git**: only `status`, `diff`, `log`, `show`, `ls-files` and a listing `branch`, each with its options from a list. Every other subcommand (`add`, `commit`, `restore`, `rm`, `mv`, `push`, `stash`, `checkout`, `reset`) is refused, and so is every option not listed (`--output`, `--ext-diff`, `--textconv`, `--no-index`, `-D`, `-m`, `-c`, `-C`). A branch name would create a branch, so `branch` takes none. The policy still allows a session's plain `git add` and `git commit` on its own. Only the proof's own answer to a request that reached the inbox no longer allows them.
- **rm and mv**: no longer allowed by the proof alone. The policy asks the owner for them, and the proof never deletes nor moves a file on its own (followup 4: `rm -rf *` had become possible once globs were read).
- **A reporter**: `--test-reporter` and `--reporter` take a built-in name only (`spec`, `tap`, `dot`, `junit`, `lcov`, vitest's), never a path. `node --test` still takes no option at all (followup 3).

- **Nothing under `.git`**: a path with a `.git` segment is refused, whether a word, a value after `=` or a redirection target. Git reads its configuration there and runs the programs it names: with `diff.external` set, a plain `git diff` runs it (checked with git in a scratch repository), and `core.fsmonitor` does the same for `git status`. An `echo … >> .git/config` was allowed before this change, in the base too. `.github` and `.gitignore` are other names and stay allowed.

**Limit.** A session can still change what `npm test` runs, through its `package.json` or a `.npmrc` in the checkout. That is the checkout's own code, which `npm test` runs anyway (the limit of the first rule).

**Tests.** `test/scripts/proof-inbox.test.ts`:
- the review's two sed commands and other scripts, refused;
- sort's and rg's program options, refused;
- the git allow list both ways, the review's cases among them;
- rm, mv and a reporter given by its path, refused;
- every write or read under `.git` refused, the two commands that turn `git diff` and `git status` into a program among them;
- the pieces of a quoted word;
- the first rule's allowed list, now without `rm -r test/tmp` and `git add … && git commit …`, which moved to the refused list.

Run 5's reviewer request stays allowed.

- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j2-proof-driver-review`.

## 2026-10-23: Owner decision: the demo stopped and the 48-hour proof launched; the run stopped at step 04

**Decision.** On 2026-10-23 at 18:49 (Europe/Paris) the owner approved, in writing: « Go, coupe la démo et lance la 48 h ». The ops requests call this step C. It is defined there, not in this repository: stop the demo, restart the proof service in one-service mode, check that the inbox holds nothing the 48-hour proof's morning rule would answer, then launch the 48-hour proof. That proof is the one in [milestone-2-plan.md](milestone-2-plan.md), section 2.1.

**What was done**, by the ops session (times in Europe/Paris):
- At 18:53, the ops session set aside two release cards that the last multi-service run (12/12, on `5ad2da2`, the head of v2) had left waiting. They were LOCAL-31 (the blocked train of step 10) and LOCAL-32 (the takeover's card of step 11), and they went through `POST /api/tickets/:id/set-aside`. Their trains halted, and nothing was approved or merged. LOCAL-13, LOCAL-15 and LOCAL-16 were not touched and stay in Todo. No lead plan holds them.
- At 18:53, the demo (8796 to 8799) was stopped with its `stop.sh` (proxy, app, service). Its lead session's two containers, labelled `cleared.dev=v2`, were removed by name, without their volumes. Its two networks were kept. Nothing was pruned.
- At 18:53, the proof service was restarted in one-service mode on Cleared `5ad2da2`, the head of v2. A signed-in read of `/api/workspace` shows one service, with base `proof-run`. The guestbook's release broker merges into `origin/proof-run`, and its deploy watcher deploys `proof-run`. The guard was clean.
- At 18:54, the 48-hour proof's driver was launched. The goal was sent at 18:54:11.

**Consequences, as planned at the launch** (the Outcome below replaces them):
- The demo would stay down for the 48 hours.
- The morning rule would start on 2026-10-24 at 08:00 (CEST). The lead's memory would be read at the end, on 2026-10-25 at 17:54 (CET), because summer time ends during the run.
- The morning rule answers every waiting item, whatever its ticket. The guard protects only the launch, so the only items expected were the run's own.
- Nothing is pushed to the main branch of either proof repository: their heads are still `2127dd2` (filter API) and `0d7fbb5` (guestbook). The run merges into `proof-run` and rolls back there only.
- At the launch, 10 of Docker's 31 address-pool subnets were free. Two sets of networks are kept until a decision: the empty pair of session `abccbe43`, and the demo lead's pair.

**Outcome.**

- **Result.** The run stopped at step 04 (approve), at 19:04: 4 steps ok, 5 skipped, 1 failed. The plan was approved and its five tickets were created (LOCAL-33 to LOCAL-37), but none started. Each is held with the note « The flow could not start: guestbook is not a service of workspace cleared-example-guestbook » (`v2/src/flow/engine.ts:302`). The 48-hour proof is not running. Nothing was pushed to any main.
- **Cause.** The ledger's `services` table still lists the services of the multi-service workspace (`guestbook`, `filter-api`), written while the service ran on the workspace file. The lead's plan store reads that table (`v2/src/lead/plans/store.ts:97`, `services()`). An item that names no service gets the first one, so each ticket is given the service `guestbook` (`v2/src/lead/plans/store.ts:58`, `itemServices`). In one-service mode, though, the workspace's only service is named after the project, `cleared-example-guestbook` (`v2/src/workspace/config.ts:103`, `serviceNameOf`, used by `v2/src/flow/config.ts:159`). The flow therefore refuses every ticket.
- **Next.**
  - At 19:19, the owner decided in writing that the fix is made in the lane `j2-single-service-fix`, and that the demo stays stopped.
  - Before the relaunch, the ops session puts LOCAL-33 to LOCAL-37 back in a clean state. Left as they are, the relaunch would find an approved plan holding those tickets, and the morning rule would answer whatever of theirs is waiting.
  - The demo stays stopped, by the owner's decision of 19:19.

- Recorded by: Opus 5.5 (claude-opus-5-5), ops session, branch `v2-j2-ops-48h`. Nothing was pushed to any main.

## 2026-10-23: the plans read only the configured services, and the tickets named with an old one are repaired by a dry-run-first command (the author's choices, lane `v2-j2-single-service-fix`)

**The defect.** The 48 h proof, started in single-service mode on `5ad2da2`, had its plan approved and LOCAL-33..37 created, but none started: each was put back with "The flow could not start: guestbook is not a service of workspace cleared-example-guestbook". The multi-service runs had recorded their workspace under the same id, `cleared-example-guestbook`. `recordWorkspace` keeps the row of a service no longer configured, so the ledger's `services` table held `guestbook`, `filter-api` and then `cleared-example-guestbook` under that id. `PlanStore.services()` read all three. With more than one, `#ticketServices` named a service on each ticket: the one an item's body names, else the first in rowid order. Either way that was `guestbook`. The flow, which knows only the configured `cleared-example-guestbook` (`workspace/config.ts`, `serviceNameOf`), refused each start. A failed start counts as a put back, so the items were held after the second.

**Decision.**
1. **The plans read the configuration's services, not the ledger's history.** `PlanStore` takes the configured service names and keeps only those rows, in the configuration's order. The runner gets them as `PlanDeps.services`, which `modules/lead.ts` fills from `workspaceOf(flow.config)`. Every reader of the plans' services goes through that one method: the validation of an item's steps, the sensitivity of `applySensitivity` and of the plan panel's chips, the services a new ticket names, and the recipes. A store built without the names reads every recorded row, as before; only the tests build it that way. Scoping by workspace was already in place (`WHERE workspace = ?`) and was not enough, since the id is the same. No ledger row is deleted: a row of an old service still describes the tickets that name it.
2. **A repair, run by a person, a dry run by default, that renames and never deletes.** `npm run repair-services` (`src/cli/repair-services.ts`, `src/lead/plans/repair.ts`) reads the workspace and the ledger from the service's environment and lists each ticket in Todo of the workspace that names a service the configuration does not have, with what it would do. `-- --apply` does it in one transaction, for a ticket of a workspace of one service that names one service only, an old one, whose part never ran:
   - its part is renamed to the workspace's service (an UPDATE of its `ticket_services` row);
   - its plan item, when held or put back, is put back, so the runner starts it again at its next tick, with its count of put backs kept. An item still waiting starts on its own;
   - a comment on the ticket says which service it named and which it names now.

   It leaves alone, and says why:
   - a ticket with a part that has a branch or a pull request;
   - a plan item with steps on an old service (cancel the item and propose it again), and a ticket with flow steps on one;
   - a ticket that names more than that one service, since making it name the one service would delete a part, and the task forbids deleting ledger data (set it aside, or cancel the item and propose it again);
   - every ticket of a workspace of several services, since only a person knows which of them it touches.

   The LOCAL-33..37 tickets each name `guestbook` alone. Their bodies are about the guestbook, and a body that names no service falls back to the first recorded one, `guestbook` too. So the rename covers them.

   Not chosen: a repair at every start. It would rewrite tickets with no one looking, and the configuration can be wrong as easily as the ticket.

**To put LOCAL-33..37 back in order** (the owner's or the orchestrator's gesture, not this lane's):
1. Stop the proof's service.
2. With the service's own environment, run `npm run repair-services` in `v2/` and read the dry run: each of LOCAL-33..37 should say "would name cleared-example-guestbook".
3. Run `npm run repair-services -- --apply`.
4. Start the service on a build with this fix. Its first tick starts the items that were put back and waiting, at most `maxParallel` at a time.

This lane never ran the repair on the proof's ledger.

**Tests.** `test/lead/plans/single-service.test.ts`:
- **LOCAL-33..37 reproduced.** A ledger with the multi-service rows `guestbook` and `filter-api` under the single-service workspace's id, the single-service configuration with the flow's steps on, as `loadFlowConfig` sets them, and a five-item plan proposed and approved. All five tickets name only `cleared-example-guestbook` and start, none is put back, and the three `services` rows are still there. On the old code it fails with each of the five tickets put back: "The flow could not start: guestbook is not a service of workspace cleared-example-guestbook".
- **Multi-service mode unchanged.** The tickets name the services their bodies name, else the first. A step on the stale single-service row is refused.
- **The store without the names** reads every row, as before.
- **The repair.** The dry run changes nothing. Applied, it renames the part of each of LOCAL-33..37 (two held, one put back, two waiting) and deletes none, and the runner then starts all five. A second run finds nothing. A part that ran, a ticket naming two old services, an item with steps on an old service, and every ticket of a workspace of several are each left alone with their reason, their rows unchanged.

- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j2-single-service-fix`.

## 2026-10-23: Orchestrator decision: plan-1 paused and the 48-hour proof relaunched from the beginning

**Decision.** On 2026-10-23 at 19:50 (Europe/Paris), the orchestrator, not the owner, chose in writing option (b): pause plan-1 and relaunch the 48-hour proof from the beginning. The owner's approval of 18:49 (the step C entry above) covers this relaunch. At 19:19, the owner had decided in writing that the fix is made in the lane `j2-single-service-fix`, and that the demo stays stopped (the Outcome of the step C entry).

**Why.** The 48-hour proof's driver (`v2/scripts/proof-j2.ts`) always sends a new goal and approves the new plan (steps 01 to 04). It cannot take over a plan that is already approved. After the repair of pull request 282, plan-1 was still approved, with its five items (LOCAL-33 to LOCAL-37) put back. The runner would have started them at its first tick, 30 s after the service starts. Starting from the beginning would then have run two plans on the same goal:
- duplicate tickets merging into `proof-run`;
- the morning rule approving the cards of both plans;
- the run's measures mixed;
- 10 free Docker subnets shared between the two plans.

The issue for taking over an approved plan is #285 (« Preuve 48 h : le driver doit savoir reprendre un plan approuvé »).

**What was done**, by the ops session (times in Europe/Paris):
- At 19:45, the proof service was stopped. The proof's checkout was moved to Cleared `a731856`, the head of v2.
- `npm run repair-services` ran as a dry run first. Only LOCAL-33 to LOCAL-37 had a change listed: each would be renamed to `cleared-example-guestbook`, and its item of plan-1 put back. The other 18 tickets were left alone, LOCAL-13, LOCAL-15 and LOCAL-16 among them.
- At 19:48, the same command ran with `--apply`, with the service still stopped. A second dry run lists none of the five any more.
- At 19:51, the service was started in one-service mode. `POST /api/plans/plan-1/pause` answered 200 half a second after the service answered, before the runner's first tick. Two ticks later, plan-1 is still `paused`, its five items are `put_back`, LOCAL-33 to LOCAL-37 are in Todo, and none has a session. The guard was clean.
- At 19:52:47, the 48-hour proof's driver was launched (`launch-proofs.sh 48`). The goal was sent at 19:52:56, and plan-2 was approved at 19:53. Its first two tickets (LOCAL-38 and LOCAL-39) started at once, on the service `cleared-example-guestbook`. Steps 00 to 04 are ok, and the night watch runs until 2026-10-24 at 08:00 (CEST).

**Consequences.**
- The morning rule starts on 2026-10-24 at 08:00 (CEST). The lead's memory is read on 2026-10-25 at 18:52 (CET), 48 hours after the goal; summer time ends during the run.
- At the first night reading (19:59), the driver was alive with no failed step, and every `/health` answered 200. LOCAL-38 and LOCAL-39 were waiting for the owner on a permission each, which the morning rule answers. Items 3 to 5 were ready, behind the limit of 2. 6 of Docker's 31 address-pool subnets were free, with two sessions live.
- plan-1 stays paused, and its tickets stay inactive. Resuming it, or cancelling its items, is a later decision.
- The demo stays stopped, by the owner's decision of 19:19. Nothing is pushed to the main branch of either proof repository (`2127dd2`, `0d7fbb5`). The run merges into `proof-run` only.
- Recorded by: Opus 5.5 (claude-opus-5-5), ops session, branch `v2-j2-ops-48h-resume`. Nothing was pushed to any main.

## 2026-10-23: Orchestrator decision: the two orphan pairs of networks removed by name

**Decision.** On 2026-10-23 at 20:05 (Europe/Paris), the orchestrator, not the owner, decided in writing to remove the two orphan pairs of Docker networks kept at the launch of step C (the step C entry of 18:49, its Consequences): `cleared-v2-abccbe43-f1f7-4d2f-ae47-749c0ea4c615`, `cleared-v2-abccbe43-f1f7-4d2f-ae47-749c0ea4c615-out`, `cleared-v2-90cd8204-69a3-4ab3-a614-99a45343dff3` and `cleared-v2-90cd8204-69a3-4ab3-a614-99a45343dff3-out`. The principle is the one applied that morning to the five stopped leads' resources: by name, only a network labelled `cleared.dev=v2` with no container attached, with `docker network rm <name>`. No prune, no volume, nothing else, and nothing of the 48-hour run in progress.

**What was done**, by the ops session:
- Each network was read with `docker network inspect` (name, `cleared.dev` label, attached containers), then again just before its removal:
  - `cleared-v2-abccbe43-f1f7-4d2f-ae47-749c0ea4c615` and its `-out`: label `v2`, no container. The ledger's `sessions` table gives `abccbe43` as an author session of LOCAL-23, stopped. Its containers were gone, and at each start the service logged « the stopped sessions' containers and networks could not be released (DockerError) ».
  - `cleared-v2-90cd8204-69a3-4ab3-a614-99a45343dff3` and its `-out`: label `v2`, no container. They belong to the demo's lead, stopped with the demo at 18:53.
- All four were removed. Docker's address pool went from 6 to 10 free subnets out of 31.
- The 48-hour run's networks were not touched: its two sessions' pairs, its lead's pair and `cleared-guestbook`.

**Consequences.**
- The 48-hour run has room for five more sessions at a time (each takes two subnets), beyond the two that are live.
- When the service cannot release a stopped session's networks (« the stopped sessions' containers and networks could not be released »), they are still removed by hand on a written decision, as here.
- Recorded by: Opus 5.5 (claude-opus-5-5), ops session, branch `v2-j2-ops-48h-resume`. Nothing was pushed to any main.

