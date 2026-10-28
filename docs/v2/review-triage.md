# Cleared v2: review follow-up triage

Lane `v2-j6-review-triage`, issue #476, 2026-10-28. Every open issue labelled `review-followup` on this repository (135) was checked against `origin/v2` at `9e32fb8cc66f9c75af20e2330a2cd80b368c298e`. No code changed.

## The rules applied

- **Closed obsolete** only with a proof: the commit that removed the code the issue is about, or the commit, file and line, or test that fixed it. A file renamed to TypeScript is not a removal: an issue whose behaviour survived the rename stays valid. A rollup of several items is closed only when every item is proven done.
- **Grouped**: every other issue, including those where the check could not prove the fix ("not shown fixed; kept"). Each umbrella issue has a checklist linking the originals, and each original is closed as a duplicate of its umbrella, with a comment naming it. The umbrellas carry the `review-followup` label, so the query that matrix line B4.4 cites still finds the work.
- **Kept (security)**: an issue labelled `security` is left open, untouched: no comment, no label, no regrouping.

In all: 19 closed obsolete (15 whose code was removed, 4 fixed), 111 grouped into 5 umbrellas, 5 kept open as security.

## The umbrellas

| Umbrella | Scope | Issues |
| --- | --- | --- |
| umbrella U1: v1 modules kept on v2 | The guard, the trackers, memory, release and rollback, `cleared status`, the release broker, the board snapshot and the root app (`lib/`, `serve/`, `app/`, `docs/`, `.github/workflows/checks.yml`). | 42 |
| umbrella U2: v2 service: flow, sessions, lead and workspace | `v2/src/` and the session runner: the flow engine, approval and release, the lead and its plans, knowledge, schedules, the reader, the terminal service, the workspace store and runtime. | 24 |
| umbrella U3: v2 hardening: session policy, isolation and the app's gates | The session policy and hooks, publish, the container runtime, the app's sign-in and proxy gates, the access token, the example services' limits. None is labelled security; they are kept together so they are read as a set. | 13 |
| umbrella U4: v2 web app: screens, i18n and accessibility | `v2/app/web/`: the tower, inbox, session, lead and ask screens, the shell, the stylesheets and the catalogs. | 16 |
| umbrella U5: v2 proofs, CI, tests and docs | The proof scripts, the workflows, flaky tests, and wording in `docs/v2/`. | 16 |

## Kept open: labelled security

- #4 Restrict the installer wake bypass to the real self-update path
- #9 Review case-insensitive parsing of owner merge approval lines
- #12 Decide whether omitted private-term lists should disable that guard
- #31 Strengthen memory approval isolation for shared host accounts
- #46 Isolate heartbeat credentials and state from same-account agents

## Every issue

| Issue | Title | Decision | Proof |
| --- | --- | --- | --- |
| #4 | Restrict the installer wake bypass to the real self-update path | kept (security) | Labelled security. For the owner: `CLEARED_INSTALL_FROM_WAKE` is still read at `serve/install.ts:73`. |
| #5 | Clarify that guard list settings must be configured together | grouped into umbrella U1 | `docs/configuration.md:216-217` still calls `terms` and `allowed` each optional. |
| #6 | Print a newline after the quickstart salt command | closed obsolete (code removed) | The quickstart's `od ... \| tr -d` line left `README.md` in `c267af34793d4a053c4e073ac3cf51b97188af72`; `git grep salt` finds nothing in `README.md`. |
| #7 | Review changed French user-facing message wording | closed obsolete (code removed) | `talk_wait_notice`, `decision_saved` and `talk_pending_decisions` left both catalogs with `talk.sh` in `c267af34793d4a053c4e073ac3cf51b97188af72`; `git grep` finds none. |
| #8 | Exercise the wake installer guard against a real activating systemd unit | grouped into umbrella U1 | `test/neutral-project.test.ts:144` still drives the installer's guard with a fake `systemctl`; no real activating unit is exercised. |
| #9 | Review case-insensitive parsing of owner merge approval lines | kept (security) | Labelled security. |
| #10 | Avoid a Node subprocess for each empty config lookup | closed obsolete (code removed) | `lib/common.sh` and its `conf_get` left in `1ec1aff30362c871496b0f9300db2628bc20d471`; `confGet` (`lib/script.ts:160`) asks `requiredValue` in the same process, no Node subprocess. |
| #11 | Test English Codex guard report labels end to end | closed obsolete (code removed) | `adapters/codex.sh` and its guard-label filter left in `c267af34793d4a053c4e073ac3cf51b97188af72`; no adapter of that kind remains. |
| #12 | Decide whether omitted private-term lists should disable that guard | kept (security) | Labelled security. |
| #13 | Remove the fallback probe key from the production message catalog | grouped into umbrella U1 | `lib/i18n/en.json:19` still ships `catalog_fallback_probe`, read by `test/flow.test.ts:157`. |
| #14 | Correct the guard comment about omitted list settings | closed obsolete (code removed) | The comment lived in `lib/common.sh`, removed in `1ec1aff30362c871496b0f9300db2628bc20d471`; the Node guard (`lib/guard/private-terms.ts:140`) reads an omitted or `none` list as disabled, with no contrary comment. |
| #15 | Document the required allowed-list fingerprint format | grouped into umbrella U1 | `docs/security.md:52` shows how to build the `terms` list only; the `allowed` format is not shown. |
| #16 | Handle an empty committed project config consistently in the guard | grouped into umbrella U1 | `lib/guard/private-terms.ts:133` still reads an empty committed config as unreadable; the shell path is gone, the distinction is still missing. |
| #17 | Define draft PR CI policy and leave enough test timeout | grouped into umbrella U1 | `.github/workflows/checks.yml` runs drafts in full under `timeout-minutes: 15`; no written draft policy. |
| #18 | Detect merge orders missed by the lane-message advisory filter | closed obsolete (code removed) | `lib/lane-message.mjs` left with the bash lanes in `c267af34793d4a053c4e073ac3cf51b97188af72`. |
| #20 | Match no-tools behavior for Codex text-only runs | closed obsolete (code removed) | `adapters/codex.sh` and the one-shot text runs left in `c267af34793d4a053c4e073ac3cf51b97188af72`. |
| #21 | Add verified interactive Codex discussion support | closed obsolete (code removed) | `talk.sh` and `adapters/codex.sh`, the path this issue extends, left in `c267af34793d4a053c4e073ac3cf51b97188af72`; v2's Take over runs through `v2/src/session/adapters/codex/interactive.ts`. |
| #22 | Reduce host Codex heavy-slot contention | closed obsolete (code removed) | `adapters/codex.sh` and `when-free.sh` (the heavy lock's door) left in `c267af34793d4a053c4e073ac3cf51b97188af72`. |
| #25 | Harden GitHub label status transitions and history | grouped into umbrella U1 | `lib/tracker/adapters/github.ts:249` and `:274` still read `labeled` events only. |
| #26 | Scale GitHub Project polling and paginate project memberships | grouped into umbrella U1 | `lib/tracker/adapters/github.ts:124` still reads `projectItems(first:100)` with no cursor. |
| #27 | Reject GitHub pull requests as tracker tickets | grouped into umbrella U1 | `getTicket` (`lib/tracker/adapters/github.ts:160`) still normalizes a pull request; only the lists filter them (`:162`). |
| #28 | Move embedded provider tests into adapter suites | grouped into umbrella U1 | `[Linear adapter]` cases are still in `test/app.test.ts:412` and `test/fast-lane.test.ts:697`. |
| #31 | Strengthen memory approval isolation for shared host accounts | kept (security) | Labelled security. |
| #32 | Improve decision and glossary relevance in memory briefings | grouped into umbrella U1 | Briefing ranking in `lib/memory/adapters/local.ts` (`search`, `:236`) not shown changed; kept. |
| #33 | Define how role lessons differ from role instructions | grouped into umbrella U1 | `lesson` is still a memory type beside role instructions (`lib/memory/adapters/local.ts:43`); no format defined. |
| #34 | Design delivery for handovers larger than the briefing budget | grouped into umbrella U1 | The briefing still works to a byte budget (`lib/memory/adapters/local.ts:250`); no delivery for an oversized handover. |
| #35 | Tighten session handover heading validation | grouped into umbrella U1 | `lib/memory/adapters/local.ts:301` still finds the headings with `indexOf`. |
| #36 | Add bulk human approval for existing decision files | grouped into umbrella U1 | `lib/memory/cli.ts:30-33`: `approve` still takes one ID; no `--all`. |
| #38 | Observe health for longer after a rollback | grouped into umbrella U1 | `rollback_health_ok` is still one event after one probe (`lib/ledger.ts:114`). |
| #39 | Select a specific release when rolling back a ticket | grouped into umbrella U1 | `cleared rollback` (`cleared.ts:18`) has no release selector. |
| #40 | Report the actual cause of a failed git revert | grouped into umbrella U1 | `lib/release.ts:307` still maps every revert failure to a conflict. |
| #41 | Keep queued merges alive during long release watches | grouped into umbrella U1 | `[merge] queue_hours` still defaults to 24 (`lib/conf.ts:34`) with no check against `watch_minutes`. |
| #42 | Use a non-starting tracker status after rollback | grouped into umbrella U1 | `agents.example.conf:86` still sets `reopen_state = Todo`. |
| #43 | Support rollback when branch protection rejects a direct revert push | grouped into umbrella U1 | Rollback still pushes the revert directly (`docs/security.md:34`); no pull request path. |
| #45 | Make manual status probes observational | grouped into umbrella U1 | `lib/heartbeat.ts:304` still writes `service_*_failed_since` from any status run. |
| #46 | Isolate heartbeat credentials and state from same-account agents | kept (security) | Labelled security. |
| #47 | Audit human process reaping without root-owned SQLite files | grouped into umbrella U1 | `lib/heartbeat.ts:226`: the human reaper path records no ledger event. |
| #48 | Remove the unused agent-session environment guard in reaping | grouped into umbrella U1 | `lib/heartbeat.ts:479` still checks `CLEARED_AGENT_SESSION`. |
| #52 | app: blocking tracker calls for Linear/GitHub freeze the server | closed obsolete (code removed) | Since `64f363162d071ac88f12e0bb037afd2297a5e94c` the app reads only the wake's board snapshot: `app/sources/live.ts:1-2`, "No tracker or forge code is imported". |
| #53 | app: approval-request picking in the porthole | grouped into umbrella U1 | `lib/board-collector.ts:444` still matches `/agree\|approve\|approval\|accord/`, so "disagree" counts. |
| #54 | app: i18n gaps (fr-FR, landmark names, tests-green regex, captions) | grouped into umbrella U1 | `app/public/app.js:17` still compares the language to exactly `fr`. |
| #55 | app: log read errors on the server | grouped into umbrella U1 | `app/server.ts:100` still answers a bare 503 and logs nothing. |
| #56 | app: UX details (focus after redraw, error labels, approved tickets) | grouped into umbrella U1 | `lib/i18n/en.json:66` "Connection lost" is still the only silence label; not shown changed. |
| #57 | app: test hygiene | grouped into umbrella U1 | The app's test hygiene items are not shown fixed in `test/app.test.ts`; kept. |
| #58 | app: sessions are lost at each restart | grouped into umbrella U1 | `app/lib/session.ts:21-36` keeps sessions in an in-memory map: lost at each restart. |
| #59 | Harden release broker availability and restart behavior | grouped into umbrella U1 | `serve/release-broker.ts:62-66` still starts `python3` for each connection. |
| #60 | Limit approval-request and lead actions to the lead role | grouped into umbrella U1 | The lead-actions bridge left in `c267af34793d4a053c4e073ac3cf51b97188af72`, but any agent can still call `release-request.ts --ask` (`:23`). |
| #61 | Clean up broker queue fixture path, audit fields and client portability | grouped into umbrella U1 | `lib/queues.ts:78` still has the `ORCH_BROKER_SECRET` branch. |
| #62 | Verify broker and both harnesses under separate Unix accounts on the server | closed obsolete (code removed) | `serve/install.ts:12-14`: the Node installer drops the three system accounts mode (no sudo probe, no bubblewrap); the host Claude Code and Codex adapters it would verify left in `c267af34793d4a053c4e073ac3cf51b97188af72`. |
| #64 | app: design leftovers (progress rail partial fill, key-figure tiles, label, chevron, scale values) | grouped into umbrella U1 | The root app's design leftovers are not shown fixed (`lib/i18n/en.json:31` "Fuel" exists, the other items are not checked); kept. |
| #65 | app: design tests judge lines, not rules, and tokens by value | grouped into umbrella U1 | `test/app.test.ts:27` still judges amber with one line pattern. |
| #66 | app: question text is cut at 160 characters and appears nowhere else | grouped into umbrella U1 | Not shown fixed; kept. |
| #67 | app: demo times move on every read before 11:46 | grouped into umbrella U1 | `app/sources/demo.ts:128` still derives the demo times from `Date.now()` before 11:46. |
| #69 | Bound board snapshot capture cache retention | grouped into umbrella U1 | `lib/board-collector.ts:529` fills `snapshot-captures` and nothing prunes it. |
| #70 | App gestures: the button shows 7 hex characters; a commit with the same prefix can be requested again unnoticed | grouped into umbrella U1 | `app/public/actions.js:158` still shows 7 characters and no request time. |
| #71 | App gestures: 'landing' is shown even when the lock will refuse (branch moved without a new request, two-team ticket, no review for that version) | grouped into umbrella U1 | Not shown fixed; kept. |
| #72 | App: grant socket and writer hardening (refused-UID ledger flood, socket ancestors, journal exposure, X-Forwarded-Proto trust, non-loopback [app] bind under https) | grouped into umbrella U1 | Not shown fixed; kept. |
| #73 | App gestures: test gaps listed by the review | grouped into umbrella U1 | Not shown fixed; kept. |
| #90 | review-followup (#89): hide digits-only secrets and tokens joined by ~ % @ in a failed probe's reason | closed obsolete (code removed) | `lib/contract.sh` and its `secret()` left in `c267af34793d4a053c4e073ac3cf51b97188af72`. |
| #91 | review-followup (#89): an unparsed JSON stdout line is shown raw as the reason of a failed Claude probe | closed obsolete (code removed) | `adapters/claude.sh` left in `c267af34793d4a053c4e073ac3cf51b97188af72`. |
| #92 | review-followup (#89): interrupting the installer leaves the probe's CLI running until its timeout | closed obsolete (code removed) | `serve/check-harness.sh` and the adapters' probe left in `c267af34793d4a053c4e073ac3cf51b97188af72`; `serve/install.ts` runs no harness probe. |
| #121 | v2 skeleton: review follow-ups from #120 | grouped into umbrella U5 | Item 5: `.github/workflows/v2.yml:33` still uses `actions/checkout@v4`, not a SHA. |
| #122 | docs/adapters.md: review follow-ups from #119 | grouped into umbrella U5 | Not shown fixed in `docs/adapters.md`; kept. |
| #123 | v2 keep-and-drop: open decisions and follow-ups from #118 | grouped into umbrella U5 | `docs/v2/keep-and-drop.md` still has rows marked `proposed` (`:23`). |
| #127 | CI push trigger: review follow-ups from #125 | grouped into umbrella U5 | `test/ci-triggers.test.ts:30` still at the root, not under `v2/`. |
| #131 | Example guestbook: review follow-ups from #128 | grouped into umbrella U5 | Pinning and the crash-loop case not shown done; kept. |
| #132 | Contracts: review follow-ups from #130 | grouped into umbrella U3 | `v2/src/main.ts:74` still calls `closeAllConnections`. |
| #133 | Container runtime: review follow-ups from #129 | grouped into umbrella U3 | `v2/src/container/docker.ts:545` still runs `rm --force --volumes`. |
| #137 | v2 hooks: push and PR detection over-matches on prose | grouped into umbrella U3 | `v2/images/session/runner/hooks.ts:119` still re-parses any word holding a blank. |
| #138 | v2 publish: refuse symlinked .git/objects, .git/refs, packed-refs, shallow | grouped into umbrella U3 | `v2/src/workspace/publish.ts:218` still checks `commondir` and `alternates` only. |
| #139 | v2 flow: reviewer sessions are asked for a HANDOVER.md they cannot write | closed obsolete (fixed) | Fixed by `2c2b9879cbbd9b28393106e726bcdfe28f9fed71`: `hooksFor()` leaves the Stop hook out for a reviewer and a lead (`v2/images/session/runner/hooks.ts:13-16`); test "the Stop hook is an author's only" (`v2/test/runner/hooks.test.ts:38`). |
| #140 | v2 runner: cover stop_hook_active, commit identity and settingSources | closed obsolete (fixed) | All three done: `settingSources: ['user']` (`v2/images/session/runner/main.ts:500`, the owner's decision of 2026-10-25, matrix B5.5b, pull request 361); `GIT_IDENTITY` (`main.ts:80`); `stop_hook_active` tested in `v2/test/runner/hooks.test.ts:121-128`. |
| #141 | v2 publish: refresh the project checkout before publish | grouped into umbrella U2 | Not shown fixed in `v2/src/workspace/publish.ts`; kept. |
| #142 | v2 hooks and publish: followups from review round 2 of #136 | grouped into umbrella U3 | Items 1 to 5 not shown fixed (`hooks.ts:170` still reads `+++ ` without `--- `); kept. |
| #144 | v2 app: followups from reviews of #135 | grouped into umbrella U3 | `v2/app/src/server.ts:401` still throttles on `remoteAddress`. |
| #145 | v2 claude-code adapter: followups from review round 1 of #143 | grouped into umbrella U2 | `v2/scripts/doctor.ts:326` still hard-codes `2.1.306`. |
| #146 | Flaky test: VAPID key with a leading zero byte | closed obsolete (fixed) | Fixed by `458489361a5558f3b8e59c33b9b9700d06fbd450`: fixed scalars, no random draw (`test/notify.test.ts:84-90`). |
| #147 | v2 sessions: the access token is readable by code the session runs | grouped into umbrella U3 | Accepted residual risk, open by the owner's decision (comment on the issue); still true. |
| #149 | v2 session screen: followups from review round 1 of #148 | grouped into umbrella U4 | Not shown fixed; kept. |
| #152 | v2 flow: followups from reviews of #150 | grouped into umbrella U2 | `v2/src/flow/engine.ts:2519` still ends the reviewer on `end_turn`; the extra turn is not checked. |
| #153 | v2 approval and lock: followups from reviews of #151 | grouped into umbrella U2 | `ApprovalWriter.approve` (`v2/src/approval/writer.ts:114`) unchanged in kind; kept. |
| #155 | v2 inbox screen: followups from review round 1 of #154 | grouped into umbrella U4 | "Always in this project" (`v2/app/messages/inbox.en.json:80`) still has no confirmation; kept. |
| #157 | v2: followups from review round 1 of #156 (milestone 1 proof) | grouped into umbrella U2 | `GENERATED_ID` (`v2/src/session/clean.ts:84`) still skips the passes for id-shaped strings. |
| #163 | v2 milestone 2 contracts: followups from reviews of #160 | grouped into umbrella U2 | `v2/src/session/policy.ts:1016` still allows any `mcp__cleared__` name. |
| #164 | v2 app shell and notifications: followups from reviews of #162 | grouped into umbrella U4 | Not shown fixed; kept. |
| #165 | v2 flow landing: followups from reviews of #161 | grouped into umbrella U2 | `recover()` (`v2/src/flow/engine.ts:2102`) still sends tickets back to Todo; kept. |
| #168 | v2 lead core: followups from review round 1 of #167 | grouped into umbrella U2 | `v2/src/lead/engine.ts:650` still marks events sent before the turn runs. |
| #170 | review-followup: #169 runner host tools | grouped into umbrella U2 | `renewedLogin` (`v2/images/session/runner/main.ts:521`) and the empty author email (`main.ts:80`) remain. |
| #173 | review-followup: #171 tower milestone 2 | grouped into umbrella U4 | `LeadStore.messages` cap and the week share not shown fixed; kept. |
| #175 | review-followup: #172 plans runner | grouped into umbrella U2 | `v2/src/lead/plans/runner.ts:486`: `tickets.create` and `setTicket` are still two steps. |
| #177 | review-followup: #174 lead screen | grouped into umbrella U4 | The vanilla screens it cites left in `677ea894e193889a8a3ab5b8678de6aaff62fbda`, but the live run (item 1) and the draft in the address (item 6) are not shown done; kept. |
| #179 | review-followup: #178 inbox plan item | grouped into umbrella U4 | `plan_approved` (`v2/app/web/screens/inbox/Inbox.tsx:988`) not shown persisted; kept. |
| #182 | review-followup: #181 proof script | grouped into umbrella U5 | `v2/scripts/proof-j2.ts:421` still calls `facts()` in the wait loop. |
| #185 | review-followup: #184 React port | grouped into umbrella U3 | The CopilotKit dev-mode check (the issue's comment, marked priority) is not shown done; kept. |
| #188 | review-followup: #186 filter API example | grouped into umbrella U3 | `examples/guestbook/src/config.ts:15` still omits 8791 to 8795. |
| #190 | review-followup: #187 workspace store | grouped into umbrella U2 | `v2/src/store/migrations.ts:31` still creates `v2_schema` outside the transaction. |
| #191 | review-followup: #189 plan addendum | grouped into umbrella U3 | `hostAllowed` (`v2/app/src/preview.ts:119`) still reads headers; the terminal gate items are not shown closed; kept. |
| #195 | review-followup: #194 terminal and editor dependencies | grouped into umbrella U5 | `docs/v2/decisions-log.md:1516` still says "Twenty packages come with them". |
| #196 | review-followup: #193 workspace runtime | grouped into umbrella U2 | `v2/src/container/services.ts:199` still overlays the checkout with `COPY`. |
| #197 | review-followup: #192 clickable answers | grouped into umbrella U4 | `busy` (`v2/app/web/screens/session/Session.tsx:136`) is still read from state; kept. |
| #200 | review-followup: #199 xterm and style shims | grouped into umbrella U4 | `v2/app/web/lib/style-nonce.ts:6` still wraps only `appendChild`, `insertBefore`, `append` and `prepend`. |
| #201 | review-followup: #198 workspace lock | grouped into umbrella U2 | `#publishTrain` (`v2/src/flow/engine.ts:3106`) not shown halting older trains; kept. |
| #205 | review-followup: #203 release intent and sensitivity | grouped into umbrella U2 | `PACKAGE_FIELDS` (`v2/src/release/flags.ts:58`) not shown widened; kept. |
| #206 | review-followup: #202 memory levels | grouped into umbrella U2 | `v2/src/lead/briefing.ts:193` still cuts with `slice(0, -1)`. |
| #207 | review-followup: #204 session plan gate | grouped into umbrella U2 | `planChange` (`v2/src/flow/engine.ts:2427`) not shown changed; kept. |
| #210 | review-followup: #209 lane 22 plan-flags-screens | grouped into umbrella U4 | `.ask-services` (`v2/app/web/screens/tower/tower.css:51`) not shown changed; kept. |
| #211 | review-followup: #208 lane 21 inbox-train | grouped into umbrella U4 | Not shown fixed; kept. |
| #213 | review-followup: #212 lane 20 session-tabs | grouped into umbrella U2 | `#paused` (`v2/src/flow/engine.ts:437`) still has no cap. |
| #215 | review-followup: #214 docs Consumption screen J3 | grouped into umbrella U5 | `docs/v2/requirements-matrix.md:127` still puts O15 before O14. |
| #217 | review-followup: #216 lane 24 knowledge-skills | grouped into umbrella U2 | `v2/src/knowledge/service.ts:230`: `took` still follows the ticket's creation. |
| #219 | review-followup: #218 lane 25 ask-code | grouped into umbrella U3 | `v2/src/session/policy.ts:72` still allows `cat *`, `head *`, `tail *`, `grep *` and `find *` for the reader. |
| #221 | review-followup: #220 lane 23 ticket-steps | grouped into umbrella U2 | `v2/src/flow/effects.ts:331` still runs `--name-only` without `-z`. |
| #223 | review-followup: #222 lane 26 recipes-schedules | grouped into umbrella U2 | `#approveGoalPlans` (`v2/src/schedules/scheduler.ts:190`) not shown re-checking the cap; kept. |
| #226 | review-followup: #224 lane 31 terminal-editor-service | grouped into umbrella U2 | `closeAll` (`v2/src/terminal/terminals.ts:196`) not shown called at shutdown; kept. |
| #227 | review-followup: #225 lane 27 additions-screens | grouped into umbrella U4 | `runRecipe` (`v2/app/web/screens/tower/Tower.tsx:36`) not shown keyed by service; kept. |
| #229 | review-followup: #228 lane 32 terminal-editor-screens | closed obsolete (code removed) | The issue lists no follow-up: its body is the heading only. Pull request 228 merged at `309aea5b7200b5460eca922ac866f8eca54bd7a9`. |
| #231 | review-followup: #230 takeover-harness-direct | grouped into umbrella U2 | `v2/src/session/contract.ts:168` still names the raw harness id. |
| #234 | review-followup: #232 lane 29 proof-scripts-m2 | grouped into umbrella U5 | C7, C11 and M9's live runs not shown placed; kept. |
| #237 | review-followup: #236 fix lane proof-step4-heading | grouped into umbrella U5 | `v2/scripts/proof-j2-multi.ts:498` still cites `examples/guestbook/src/page.ts`. |
| #239 | review-followup: #238 lane review-multi-service-diff | grouped into umbrella U2 | `v2/src/flow/prompts.ts:144` still uses fixed `BEGIN DIFF` and `END DIFF` markers. |
| #243 | review-followup: #242 takeover-real-harness | grouped into umbrella U3 | `v2/test/terminal/real-harness.test.ts:59` still calls `docker images` outside the wrapper. |
| #245 | review-followup: #241 ui-native-overhaul plan | closed obsolete (fixed) | F1: pull request 241 merged at `cb50b500f7bae7adddcedb67984540f6de7c5c47`. F2 and F3: `role_lead` in `v2/app/messages/session.en.json:114` since `ee602989fd9dd64f56090c4f817ba6a348e7cb4c`. F4: `docs/v2/ui-overhaul-plan.md:146` names SSE, `text/event-stream` and `EventSource`. |
| #246 | review-followup: #240 reviewer-policy | grouped into umbrella U3 | `v2/src/session/policy.ts:377`: `-C` is still not risky by its value. |
| #247 | review-followup: #244 deps-ui-foundation (lane 33) | grouped into umbrella U5 | `.github/workflows/v2.yml` caches npm only, not `~/.cache/ms-playwright`. |
| #250 | review-followup: #248 ui-foundation (lane 34) | grouped into umbrella U4 | `v2/app/web/lib/sheets.ts:2` still loads sheets with `media="not all"`. |
| #253 | review-followup: #252 ui-shell (lane 35) | grouped into umbrella U4 | `SCREEN_KEYS` (`v2/app/web/shell/keys.ts:4`) and the palette items not shown changed; kept. |
| #254 | review-followup: #251 ui-session-continuity (lane 36) | grouped into umbrella U4 | Item 1 is done (`v2/scripts/proof-j1.ts` no longer clicks `a.tab`); `handover_to_codex` is still shown (`v2/app/messages/session.en.json:147`). |
| #257 | review-followup: #255 ui-inbox-fr (lane 37) | grouped into umbrella U4 | Item 1's file left in `7c8008d2b59b7bfc2be27bd9905b38eda08852f1`; `special()` (`v2/app/web/lib/request.ts:59`) not shown widened. |
| #258 | review-followup: #256 polish-measures (lane 38) | grouped into umbrella U5 | `v2/scripts/proof-words.ts:32` still uses an unanchored `.+?`. |
| #260 | review-followup: #259 ops decisions-log | grouped into umbrella U5 | The two wording items in the decisions log not shown corrected; kept. |
| #262 | review-followup: #261 ops decisions-log | grouped into umbrella U5 | The superseding clauses in the decisions log not shown added; kept. |
| #264 | review-followup: #263 j2-ui-i18n: fr/en catalogs, Intl durations, language selector | grouped into umbrella U4 | `Math.max(0, ...)` (`v2/app/web/lib/time.ts:48`) still lets NaN through. |
| #276 | review-followup: #275 j2-proof-clean-base | grouped into umbrella U5 | `PROOF_REPOS` checks in `v2/scripts/proof-base.ts` not shown changed; kept. |
| #468 | v2: a live session does not survive a restart of the service, a taken-over one included | grouped into umbrella U2 | `recover()` (`v2/src/flow/engine.ts:2105`) still stops every live session at a restart. |
| #471 | v2 tests: the fake adapter's random session ids can hold a phone number's shape, and one-service.test.ts then fails | grouped into umbrella U5 | `v2/src/session/adapters/fake.ts:19` still draws `randomUUID()` ids. |
