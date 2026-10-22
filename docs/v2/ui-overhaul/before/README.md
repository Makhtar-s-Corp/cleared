# The "before" captures of the interface overhaul

Taken on 2026-10-22 between 22:10 and 22:20 (Europe/Paris) for [../../ui-overhaul-plan.md](../../ui-overhaul-plan.md), section 1. Each file was looked at before it was copied here: no secret, no person's name and no organisation's name is visible. The "after" captures of each lane go to `../after/<lane>/`.

## Sources

- `live-*.png`: the proof instance's app on `127.0.0.1:8792` at `origin/v2` commit `d0e5e0e`, English, the example workspace of two services after a day of real proof runs. Headless Chromium 1243 through playwright-core 1.63.0, signed in as the proof's owner account with its password read from a file. Clicks: the header's links, the session's tab buttons, the reviewer's link in the crumbs, a list item of the inbox. No action button was pressed. The dark theme is set through the app's own `cleared-v2-theme` storage key; the pointer is parked in the corner. Sizes 1440x900, 1280x800, 768x1024, 390x844. The inbox at 1440 with its first item (a release) opened is not here: its detail quotes the pull request's address.
- `demo-login-*.png`: the owner's demo app on `127.0.0.1:8798` (French), its sign-in page only; nobody signed in, nothing clicked.
- `wave8-*.png`: the fixtures source after wave 8 (from `/tmp/cleared-captures/j2/wave8/`, its index says how).
- `takeover-harness-1440-dark.png`: the Terminal tab after Take over, on the fixtures source (from `/tmp/cleared-captures/j2/takeover/`).
- `proofmulti-inbox-full-page.png`: the real multi-service proof's run of 2026-10-22 (from `/tmp/cleared-captures/j2/proofmulti/`), the proof's full-page capture of the inbox at its step 5, 11,353 pixels tall, a permission's detail open. The proof's later inbox capture, whose open release detail quotes the pull request's address, is not here.
- `timings.json`: the measures of the plan's section 1.2, one row per navigation (`contentMs` is the time from the click to the screen's first node present and not busy; `blank` marks the sessions index that never drew; `requests` counts the requests of that navigation).

## Files

- `live-tower-{1440-light,1440-dark,1280-light,768-light,390-dark}.png`: the tower.
- `live-inbox-390-dark.png`: the inbox's list alone.
- `live-inbox-permission-{1440-light,1440-dark,1280-light,768-light,390-dark}.png`: the inbox with the LOCAL-14 permission selected: the raw command as title, "Why it asks", the three buttons at the foot.
- `live-sessions-{1440-light,1440-dark,390-dark}.png`: the sessions index, blank (the `role_lead` crash, plan section 1.4).
- `live-session-terminal-{1440-light,1440-dark,1280-light,768-light,390-dark}.png`: an ended author session, Terminal tab.
- `live-session-{plan,editor,browser}-{1440-light,1440-dark,390-dark}.png`: its other tabs (the Editor says the files could not be loaded).
- `live-session-reviewer-{1440-light,1440-dark,390-dark}.png`: the reviewer's session after the crumbs' link (a full page load).
- `live-lead-{1440-light,1440-dark,390-dark}.png`: the lead screen.
- `demo-login-{1440-dark,1440-light,390-dark}.png`.
- `wave8-inbox-1440-light.png`, `wave8-session-terminal-1440-light.png`, `wave8-lead-1440-light.png`, `takeover-harness-1440-dark.png`, `proofmulti-inbox-full-page.png`.
