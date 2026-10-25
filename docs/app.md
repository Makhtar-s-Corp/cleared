# The Cleared app (Cockpit)

`cleared app` starts one interface for desktop and phone that shows the factory live, and lets the human do three things from it: **clear a ticket to land**, **send it back** and **answer a question**. It makes no outside call of its own to read: the wake collects the board into a versioned `snapshot.json` in the project state directory, and the app reads that file and the ledger only, so GitHub and Linear delays cannot block its pages. Its only writes are the three gestures below (and the sign-in and passkey routes they need), and a browser's request to be [notified](notifications.md). It never starts or stops a team and never talks to the release service: giving an agreement is all it does, the lock does the rest.

The principle: **the app has no privilege.** It writes into the ticket tracker exactly what the human would write by hand, under the human's own identity, and the normal circuit (the wake, the lock) does the rest. See [Gestures](#gestures) and [Setup for the gestures](#setup-for-the-gestures).

```sh
cleared app            # serves the app; the installer registers it as cleared-app.service
cleared app --link     # prints http://<bind>:<port>/login#<token> to open on your phone
cleared app --demo     # serves invented data, for a look without a project
cleared app passkey    # (the human's own account) prints the address that registers a passkey on a phone
```

## Views

The look follows [`app/DESIGN.md`](../app/DESIGN.md) (a light, Vercel/Geist-based design; mockups in `app/reference/`). Geist and Geist Mono are served by the app itself (`app/public/fonts/`, SIL Open Font License); nothing is loaded from another site. Light is the default; dark is a button, never the system setting.

- **Header**: logo, project, views (only *Tower* exists; *Landed*, *Fuel* and *Rules* are dimmed and marked soon), the health pill, the time and the theme button.
- **Greeting band**: the date and pilot mode, a greeting with what waits for you ("Two things are ready to land." / "Nothing needs you."), and the stat strip: *In flight*, *Landed today*, *First-time clean* and *Fuel left this week* (one bar per subscription, never money; "not measured" otherwise).
- **Tower**: four columns (In progress, Checks, Review, Awaiting you), one card per open ticket. A card that waits for you carries the amber stripe: *Ready to land* (with before/after tiles for a screen ticket, and one line on its pull request: number, files, lines, checks) or *Question* (the question itself as the title, its first sentence never cut, then the rest of it, the team's recommendation and its choices in a few lines, and "Read it all and answer"). Both say since when they wait, and the longest waiting comes first. A ticket that only sits in the tracker's approval status, with no request from Cleared behind it, is not ready to land: it is listed apart under the waiting cards, quiet, with nothing to clear. A team waiting for a place has a dashed card with the reason. On a phone the tower is one list, awaiting cards first.
- **Landed today**: what shipped today, with its model and outcome (clean first time, review rounds, rolled back).
- **Porthole**: a right panel on a computer, a page on a phone. Title and since when it waits, then what is asked of you: the whole question (or each question) with the team's recommendation, or the request to clear a version. Then a stat strip (flight, checks, and the share of this week's usage when it means something), *What changed* (the pull request with its link, files and lines, checks running, green or red; device frames for a screen ticket, or "no capture yet" and why; an example), *Where we are* (the team's report to you: Done, Still to do; "No report from the team yet" without one), *The squad* and the *Black box* timeline (raw event on unfold). *Clear to land*, *Send back* and the answer form of a question are real and stay at the bottom of the panel, see [Gestures](#gestures). A value that is not known says "not measured".

The interface language follows `[owner] language` through the message catalog (`app_*` keys in `lib/i18n/`).

## Where each piece of data comes from

| Shown | Source |
| --- | --- |
| Cards and columns | The wake's board snapshot, built from tracker tickets in the configured states, plus `runs` and `events` of the ledger. *Checks* is derived: a ticket in the progress state whose author run ended with a pull request and has no review run yet. |
| Harness, model, flight time | `runs` (provider, model, started/ended). |
| Share of this week's usage, on a card | The ticket's tokens divided by all tokens of the last seven days. It is a share of Cleared's own usage, not a share of the subscription: the subscription reports only percentages per window, not per ticket. It is shown only once at least five tickets (`SHARE_MIN_TICKETS` in `lib/board-collector.ts`) had a run in those seven days; below that one ticket's share says nothing ("79 %" of a week of two tickets) and is left out, on cards, in the porthole and in Landed today. |
| Question, recommendation, choices | The `lane_asks` event: the "Questions for the user" lines of the team's report. A line that asks (a question mark) or carries its own recommendation opens a question, even when numbered; short list lines under it (`- text`, `1. text`, `A) text`, four at most) are its choices; a recommendation is taken only when the team writes one ("I recommend", "Recommendation:", "Je recommande", "Recommandation :"…), never made up. Up to four questions, each up to 1 500 characters. |
| Where we are, example | The team's report to the user: the report file the dispatcher keeps for the run (`state/reports/<run>.md`, sections Done, Remaining work, Questions for the user, in the owner's language), of the newest finished run of a role that writes the change (`[lanes] push_roles` and `[review] author_role`; a triage, cleanup or lead run never replaces it), or its rewrite for the user when `[tracker] writeup_role` formatted that very run. For a ticket ready to land, the request for agreement comment too. Never the handover (`memory_entries`): it is the team's internal note for its next session, and the Black box only says that one was kept. |
| Status line, tests | A line like "1 044 tests green" is shown only if the report (or, for the count alone, the handover) says it. |
| What changed | The pull request of the ticket's runs. Its checks (running, green, red), files and lines come from the wake's own listing of open pull requests (`wake/state.json`, kept by `wake.sh` from the one `gh pr list` it makes); lines otherwise from the ledger (`runs.lines_changed`). What the wake did not see is "not measured". |
| Ready to land, Question, tracker only | *Ready to land* needs a request of Cleared for that version (`state/validations/<ticket>.json`); a ticket in `[tracker] validate_state` without one is shown apart as tracker only. |
| Fuel | The wake's snapshot of `lib/limits.ts summary` (the share left is 100 minus the most constraining window). |
| Landed today, first-time clean | `merged_by_script` events, with the ticket's runs: no changes asked by a review means clean first time; a `prod_revert` or `rollback_pushed` after the merge means rolled back. First-time clean is counted over the last seven days. |
| In flight | Tickets whose last author run is still running. |
| Health | What the wake recorded (`heartbeat_state` and `heartbeat_incidents`, read-only), plus the snapshot generation time. The app shows the snapshot age and reports one older than three wake intervals. It also reports a missing or unknown snapshot format. |
| Pilot mode | Derived from `[merge] tooling_paths`: whether tooling paths may merge after review. |
| Captures | The wake copies images from local, GitHub or Linear ticket comments to the project state cache, using the configured tracker identity for private remote assets, and the PNG and JPEG files the team set apart for the user (`[lanes] kept_in/<ticket>/`, no link followed, eight at most, 5 MB each; a name with "before" or "avant" is the before side). The snapshot contains only local `/media/` references. A screen ticket without any says "No capture yet" and why: the team is still working, it kept none, or `[lanes] kept_in` is not set. |

## Snapshot publication

At the end of a successful wake, `lib/board-collector.ts` collects cards, porthole details, Landed today, fuel and health. It validates and caches the captures, then writes `snapshot.json` through a temporary file and rename. A failed collection leaves the last complete file in place and marks the wake failed in health. The JSON format is versioned with `schema: 1`; the app accepts only that version. No server path, secret or money amount is included in JSON.

## Access

The server listens on `[app] bind` and refuses any peer outside `[app] ranges` (Tailscale and this machine by default) and any `Host` it does not expect. Every route except the sign-in page needs the access token (an `Authorization: Bearer` header) or a session. The token file is a private regular file (mode `0600`) outside the project; `cleared app` creates it on first start and never prints it except for `--link`. The sign-in page reads the token after the `#` sign (never sent in a request) and sends it in a header to `POST /session`, which answers with a **session cookie**: a random id, `HttpOnly`, `SameSite=Strict`, `Secure` whenever the connection is encrypted (TLS, or a proxy on this machine such as `tailscale serve` that says `X-Forwarded-Proto: https`). The cookie holds no token; the id is a key into the server's memory, and a restart ends every session. Wrong tokens are counted per peer (ten a minute, then `429`); a right one always gets in.

Reads are `GET` and `HEAD`. The only writes are the `POST` routes of the table below. **Every write needs the session cookie** (the access token alone is refused), the **anti-forgery token** of that session in an `X-CSRF-Token` header (read from `GET /api/me`), an `Origin` equal to the app's own address (`[app] public_origin` when set), `Sec-Fetch-Site: same-origin` when the browser sends it, and a JSON body of 16 KB at most. The page loads no script, font, image or style from another site (`Content-Security-Policy: default-src 'self'`).

| Route | Needs |
| --- | --- |
| `POST /session`, `POST /session/logout` | the access token (sign-in) / the session |
| `POST /api/actions/challenge`, `POST /api/actions/confirm` | session, anti-forgery token, **passkey** |
| `POST /api/actions/undo` | session, anti-forgery token (only the session that confirmed) |
| `POST /api/actions/answer` | session, anti-forgery token (no passkey: an answer puts nothing live) |
| `POST /api/passkeys/options`, `POST /api/passkeys/finish` | session, anti-forgery token, a one-time grant from the human's account |
| `POST /api/notifications/challenge` | session, anti-forgery token (a passkey challenge for one subscription: notifications on or off for this device) |
| `POST /api/notifications/subscribe`, `POST /api/notifications/unsubscribe` | session, anti-forgery token, passkey assertion on that challenge (a browser of the human asks to be notified, or no longer; see [Notifications](notifications.md)) |

Besides the sign-in page, what makes the app installable is served without the token, with no data in it: `/manifest.webmanifest`, the service worker `/sw.js` and the three icons under `/icons/`. `GET /api/notifications` (the session only) says whether Web Push is offered and gives the service's public key.

## Gestures

### Clear to land
Offered only on a card that waits for an agreement (*Ready to land*), with the request the team made on the ticket. The button carries the **exact version** (the first seven characters of each commit) from the request kept in `state/validations/<ticket>.json`. If a new commit arrives while the porthole is open, the board changes under it, the button becomes **New version, review again** and an agreement on the old one is no longer possible. A click asks for a **passkey** (fingerprint or Face ID on the phone), then starts a **60 second grace delay held on the server** with a thin bar that empties and an **Undo** beside it. Nothing is written during that time. Undo before the end writes nothing. When it ends, the server reads the board again; if the version is still the one shown, it writes the human's agreement (moves the ticket to `[tracker] go_state`) under the human's identity, for that version, while holding the same lock (`state/merge.lock`) as `ask-validation.sh` and `merge-pr.sh`. After the write the tracker's history is read back: the result says whether it already shows the human as the author (a tracker's history may lag, and the lock checks it again at merge); a move that was made is never reported as a failure. Only one Clear can wait per ticket; every device of the human sees it and may Undo it; a Send back made meanwhile (from any device) withdraws it; and an agreement answers the exact request on screen, so a request made again for the same commit voids a waiting one. The card then reads "Cleared by you at 14:02, landing" until the next snapshot. If the app restarts during the delay, nothing is written (the ledger shows `confirmed` and no `written`).

### Send back
A required text ("what needs to change") and a passkey. The app writes the text as a comment, then moves the ticket to `[app] sent_back_state` (default `[tracker] progress_state`), both as the human. The team reopens with that word through the existing circuit: a comment of the owner after the last run is handed to the lane, and the ticket shows at work.

### Answer a question
On a *Question* card the options the team put under its question (lines like `- text`, `1. text` or `A) text`, four at most) become buttons, plus a free text field. When the team stated a recommendation, one more button, *Follow the recommendation*, answers "I follow your recommendation." with the recommendation quoted (with several questions, each answer names its question). It needs the session only, no passkey. The app writes the answer as a comment as the human.

### The ledger
Every gesture attempt, refused or not, is one `app_gesture` event: `{gesture, result, device, version}` with the time and the ticket. Results: `confirmed` (grace started), `undone`, `written`, `refused_new_version`, `failed_<code>`, `registered` (a passkey). The device is a short name from the browser ("iPhone · 3fa1") and the first four characters of the session.

## Setup for the gestures

The gestures stay greyed out, with the reason shown, until all of this exists.

1. **A secure address.** Passkeys work only on `https` (or `localhost`). Publish the app on the Tailscale network with `tailscale serve` on HTTPS port 8443 (or 10000, the other HTTPS ports Tailscale Serve accepts), never 443: `tailscale serve --bg --https=8443 http://127.0.0.1:8788` (8788 is the v1 app's port, `CLEARED_APP_PORT` of `serve/install.sh`; the Cleared v2 service never uses it, see [v2/README.md](../v2/README.md#settings)). That gives `https://<machine>.<tailnet>.ts.net:8443`: set `[app] public_origin = https://<machine>.<tailnet>.ts.net:8443`, port included. When it is set, the app listens on `[app] bind` (this machine only by default), and a write is refused unless the request carries that origin, port included; once it is set, `serve/install.sh` prints the `tailscale serve` command with the right ports. A passkey is bound to the host name, not the port: one registered on the same name at another port still works.

   **Never `tailscale serve --bg 8788` (no `--https`) nor `--https=443`.** Its default HTTPS port is 443, and it holds that port on the machine's Tailscale address: a public reverse proxy on the same machine then cannot bind `0.0.0.0:443` (a wildcard bind fails on a port one address already holds). On 2026-10-17 that kept a production site offline for six hours after a reboot. Ports 80 and 443 belong to the machine's public proxy: `serve/install.sh` refuses a `public_origin` on them, and `https://…` without a port is 443 ([Decisions](concepts.md#decisions)). An app already served on 443: `tailscale serve --https=443 off`, then the command above, the new `public_origin`, and the same address in `CLEARED_NOTIFY_LINK_BASE` ([Notifications](notifications.md#service-environment-systemd-drop-in)).

   `serve/install.sh` also refuses the port of `public_origin` when something other than `tailscaled` holds it (a holder it cannot name, on the Tailscale address, passes only when `tailscale serve status` lists that port, so a re-run works), and nothing is written then.
   It reads `CLEARED_NOTIFY_LINK_BASE` (or `ORCH_NOTIFY_LINK_BASE`) from the drop-ins of `cleared-wake.service` and `cleared-app.service` too, and refuses a value that is not `http(s)://host[:port]` or that lands on 80 or 443, such as `HTTPS://host`.
2. **The human's own accesses to the tracker**, in `[app] human_credentials_dir` (default `~/.config/cleared/human` of the account that runs the app): the directory `0700`, `credentials.json` `0600`, owned by the app's service account, outside the project and the Cleared checkout. **The agents' account must not be able to read it**; the app refuses a directory or file that is looser, and `serve/install.sh` probes it as the agents' account. How to get each access is in [Ticket trackers](trackers.md#the-humans-accesses-for-the-app).
3. **`[tracker] owner_id`** (the human's login or Linear id), as for the lock.
4. **A passkey.** On the machine, under the human's own Unix account (`[security] human_user`, or the local tracker's `owner_id`): `cleared app passkey`. It asks the running app, over the Unix socket `[app] grant_socket` (an absolute path in a service-owned directory the human can traverse, like the release broker's socket), for a one-time grant. The app reads the caller's UID from the kernel (`SO_PEERCRED`) and answers only the human's UID, so the agents' account cannot obtain one however it reaches the app. The command prints an address; open it on the phone while signed in to the app (the grant is valid for ten minutes and works once), and confirm with fingerprint or Face ID. Up to five passkeys can be registered. The human's command reads the committed `.cleared/agents.conf` from the project checkout, which belongs to the service account. It runs read-only git on it, with what the checkout's own configuration could run neutralised for each command (`core.fsmonitor`, hooks, pager, external diff, signature programs, any transport), through the command's environment (`lib/git-checkout.ts`): nothing is written to any git configuration, and the human needs no `git config` step. Do not add the checkout to the human's global `safe.directory` instead. The service account is trusted not to plant configuration; shell scripts and included configuration files are not covered, see [Security](security.md#the-humans-commands-read-the-services-checkout). If git still refuses, the command says `cleared: git refused or could not read <project>: <git's first line>` and stops instead of blaming a setting.

The app writes through a short-lived child process (`app/human-write.ts`) that reads the credentials, checks the tracker sees them as the human (the tracker's own "who am I", and `[tracker] owner_id`), writes, and reads the history back. The web server itself never holds the tokens. The API address of GitHub or Linear can be changed only in the service's environment (`CLEARED_APP_GITHUB_API`, `CLEARED_APP_LINEAR_API`, for GitHub Enterprise or a test double), never by the project's settings.

## Live events

`GET /events` is a Server-Sent Events stream. Each frame is `id:`, `event:` and a `data:` line holding one envelope:

```json
{ "id": 12, "type": "ticket.updated", "at": "2026-10-13T08:14:02.000Z", "data": { "...": "..." } }
```

| `type` | `data` |
| --- | --- |
| `snapshot` | The whole state, sent once on connect (same as `GET /api/snapshot`). |
| `ticket.updated` | One ticket card (new or changed; a card changing column is this event). |
| `ticket.removed` | `{ "id": "EX-12" }` |
| `fuel.updated` | The list of fuel entries. |
| `health.updated` | `{ "health": {...}, "mode": {...}, "generatedAt": "..." }` |
| `stats.updated` | `{ "stats": {...}, "landed": [...], "owner": {...} }`: the stat strip and the Landed today table. |
| `heartbeat` | `{}` every 15 s, so the page can tell silence from calm. |

The page shows "Connection lost, last update HH:MM" at the top when the stream breaks or no frame arrives for 40 s. The names are dotted, `data` is plain JSON and there is no library dependency, so a later converter can map them to AG-UI: `snapshot` to `STATE_SNAPSHOT`, `*.updated` and `*.removed` to `STATE_DELTA`, `heartbeat` to a custom event.

## Installing it, and notifications

The app can be added to a phone's Home Screen (a manifest, icons and a service worker that caches nothing), and its header offers **Turn on notifications** when `[notify] adapters` includes `webpush`, the app has an https `public_origin` and a passkey is registered: turning notifications on or off for a device is confirmed with the passkey, like Clear to land. The app only keeps the browser's subscription; the wake's dispatcher sends the notifications. A notification opens `/#ticket=<id>`, the ticket's porthole (after the sign-in when the session is gone). On iPhone, web notifications need the app added to the Home Screen first. See [Notifications](notifications.md).

## Limits of this version

One project per server (tabs appear when a source lists several). One human, no accounts. No rollback button (rollback stays `cleared rollback` on the machine and the automatic one on health), no free conversation with the tower or the teams. No flight plans, estimates or money amounts.
