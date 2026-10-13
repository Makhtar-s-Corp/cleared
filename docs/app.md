# The Cleared app (Cockpit)

`cleared app` starts one interface for desktop and phone that shows the factory live, and lets the human do three things from it: **clear a ticket to land**, **send it back** and **answer a question**. It makes no outside call of its own to read: the wake collects the board into a versioned `snapshot.json` in the project state directory, and the app reads that file and the ledger only, so GitHub and Linear delays cannot block its pages. Its only writes are the three gestures below (and the sign-in and passkey routes they need). It never starts or stops a team and never talks to the release service: giving an agreement is all it does, the lock does the rest.

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
- **Tower**: four columns (In progress, Checks, Review, Awaiting you), one card per open ticket. A card that waits for you carries the amber stripe: *Ready to land* (with before/after tiles for a screen ticket) or *Question*. A team waiting for a place has a dashed card with the reason. On a phone the tower is one list, awaiting cards first.
- **Landed today**: what shipped today, with its model and outcome (clean first time, review rounds, rolled back).
- **Porthole**: a right panel on a computer, a page on a phone. Title, stat strip (flight, share of this week's usage, tests), *Show me* (device frames for a screen ticket; otherwise an example, the tests and what it touches), *Where we are*, *The squad* and the *Black box* timeline (raw event on unfold). *Clear to land*, *Send back* and the answer form of a question are real, see [Gestures](#gestures).

The interface language follows `[owner] language` through the message catalog (`app_*` keys in `lib/i18n/`).

## Where each piece of data comes from

| Shown | Source |
| --- | --- |
| Cards and columns | The wake's board snapshot, built from tracker tickets in the configured states, plus `runs` and `events` of the ledger. *Checks* is derived: a ticket in the progress state whose author run ended with a pull request and has no review run yet. |
| Harness, model, flight time | `runs` (provider, model, started/ended). |
| Share of this week's usage, on a card | The ticket's tokens divided by all tokens of the last seven days. It is a share of Cleared's own usage, not a share of the subscription: the subscription reports only percentages per window, not per ticket. |
| Status line, Where we are, tests, example | The ticket's handover (`memory_entries`) and the approval request comment. A line like "1 044 tests green" is shown only if the handover says it. |
| Fuel | The wake's snapshot of `lib/limits.mjs summary` (the share left is 100 minus the most constraining window). |
| Landed today, first-time clean | `merged_by_script` events, with the ticket's runs: no changes asked by a review means clean first time; a `prod_revert` or `rollback_pushed` after the merge means rolled back. First-time clean is counted over the last seven days. |
| In flight | Tickets whose last author run is still running. |
| Health | What the wake recorded (`heartbeat_state` and `heartbeat_incidents`, read-only), plus the snapshot generation time. The app shows the snapshot age and reports one older than three wake intervals. It also reports a missing or unknown snapshot format. |
| Pilot mode | Derived from `[merge] tooling_paths`: whether tooling paths may merge after review. |
| Captures | The wake copies images from local, GitHub or Linear ticket comments to the project state cache, using the configured tracker identity for private remote assets. The snapshot contains only local `/media/` references. |

## Snapshot publication

At the end of a successful wake, `lib/board-collector.mjs` collects cards, porthole details, Landed today, fuel and health. It validates and caches the captures, then writes `snapshot.json` through a temporary file and rename. A failed collection leaves the last complete file in place and marks the wake failed in health. The JSON format is versioned with `schema: 1`; the app accepts only that version. No server path, secret or money amount is included in JSON.

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

## Gestures

### Clear to land
Offered only on a card that waits for an agreement (*Ready to land*), with the request the team made on the ticket. The button carries the **exact version** (the first seven characters of each commit) from the request kept in `state/validations/<ticket>.json`. If a new commit arrives while the porthole is open, the board changes under it, the button becomes **New version, review again** and an agreement on the old one is no longer possible. A click asks for a **passkey** (fingerprint or Face ID on the phone), then starts a **60 second grace delay held on the server** with a thin bar that empties and an **Undo** beside it. Nothing is written during that time. Undo before the end writes nothing. When it ends, the server reads the board again; if the version is still the one shown, it writes the human's agreement (moves the ticket to `[tracker] go_state`) under the human's identity, for that version, while holding the same lock (`state/merge.lock`) as `ask-validation.sh` and `merge-pr.sh`. After the write the tracker's history must show the human as the author, or the gesture is reported as failed. The card then reads "Cleared by you at 14:02, landing" until the next snapshot. If the app restarts during the delay, nothing is written (the ledger shows `confirmed` and no `written`).

### Send back
A required text ("what needs to change") and a passkey. The app writes the text as a comment, then moves the ticket to `[app] sent_back_state` (default `[tracker] progress_state`), both as the human. The team reopens with that word through the existing circuit: a comment of the owner after the last run is handed to the lane, and the ticket shows at work.

### Answer a question
On a *Question* card the options the team put under its question (lines like `- text`, `1. text` or `A) text`, four at most) become buttons, plus a free text field. It needs the session only, no passkey. The app writes the answer as a comment as the human.

### The ledger
Every gesture attempt, refused or not, is one `app_gesture` event: `{gesture, result, device, version}` with the time and the ticket. Results: `confirmed` (grace started), `undone`, `written`, `refused_new_version`, `failed_<code>`, `registered` (a passkey). The device is a short name from the browser ("iPhone · 3fa1") and the first four characters of the session.

## Setup for the gestures

The gestures stay greyed out, with the reason shown, until all of this exists.

1. **A secure address.** Passkeys work only on `https` (or `localhost`). Put the app behind `tailscale serve` (`tailscale serve --bg 8788`), which gives `https://<machine>.<tailnet>.ts.net`, and set `[app] public_origin` to it. When it is set, a write is refused unless the request carries that origin.
2. **The human's own accesses to the tracker**, in `[app] human_credentials_dir` (default `~/.config/cleared/human` of the account that runs the app): the directory `0700`, `credentials.json` `0600`, owned by the app's service account, outside the project and the Cleared checkout. **The agents' account must not be able to read it**; the app refuses a directory or file that is looser, and `serve/install.sh` probes it as the agents' account. How to get each access is in [Ticket trackers](trackers.md#the-humans-accesses-for-the-app).
3. **`[tracker] owner_id`** (the human's login or Linear id), as for the lock.
4. **A passkey.** On the machine, under the human's own Unix account (`[security] human_user`, or the local tracker's `owner_id`): `cleared app passkey`. It asks the running app, over the Unix socket `[app] grant_socket` (an absolute path in a service-owned directory the human can traverse, like the release broker's socket), for a one-time grant. The app reads the caller's UID from the kernel (`SO_PEERCRED`) and answers only the human's UID, so the agents' account cannot obtain one however it reaches the app. The command prints an address; open it on the phone while signed in to the app (the grant is valid for ten minutes and works once), and confirm with fingerprint or Face ID. Up to five passkeys can be registered.

The app writes through a short-lived child process (`app/human-write.mjs`) that reads the credentials, checks the tracker sees them as the human (the tracker's own "who am I", and `[tracker] owner_id`), writes, and reads the history back. The web server itself never holds the tokens. The API address of GitHub or Linear can be changed only in the service's environment (`CLEARED_APP_GITHUB_API`, `CLEARED_APP_LINEAR_API`, for GitHub Enterprise or a test double), never by the project's settings.

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

## Limits of this version

One project per server (tabs appear when a source lists several). One human, no accounts. No rollback button (rollback stays `cleared rollback` on the machine and the automatic one on health), no free conversation with the tower or the teams. No flight plans, estimates or money amounts.
