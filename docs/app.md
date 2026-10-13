# The Cleared app (Cockpit), read only

`cleared app` starts one interface for desktop and phone that shows the factory live. This first version **only reads**: it writes nothing, runs no command that writes and makes no outside call (no GitHub, no tracker probe, no quota probe). No route writes, moves a ticket, answers a question, or starts or stops a team. Places where actions will come later are marked as reserved and are not clickable.

```sh
cleared app            # serves the app; the installer registers it as cleared-app.service
cleared app --link     # prints http://<bind>:<port>/login#<token> to open on your phone
cleared app --demo     # serves invented data, for a look without a project
```

## Views

- **Tower**: four columns (In progress, Checks, Review, Awaiting you), one card per open ticket. Cards that wait for you are yellow and first in their column. A team waiting for a place on the machine has a dashed card with the reason. On a phone the tower is one list, with the cards that wait for you first.
- **Porthole**: one ticket and its squad. *Where we are*, *The squad*, *Show me* (before/after captures for a screen ticket; otherwise an example, the tests added or changed and what it touches), and the *Black box*, a plain-language timeline from the ledger; unfold a line for the raw event.
- **Top bar**: project tabs when there are several, **Fuel** (the most constraining window per subscription and its reset time, never a money amount; `not measured` otherwise), the recorded health of the wake, and the pilot mode.

The interface language follows `[owner] language` through the message catalog (`app_*` keys in `lib/i18n/`).

## Where each piece of data comes from

| Shown | Source |
| --- | --- |
| Cards and columns | Tracker tickets in the configured states, plus `runs` and `events` of the ledger. *Checks* is derived: a ticket in the progress state whose author run ended with a pull request and has no review run yet. |
| Harness, model, flight time | `runs` (provider, model, started/ended). |
| Share of this week's usage, on a card | The ticket's tokens divided by all tokens of the last seven days. It is a share of Cleared's own usage, not a share of the subscription: the subscription reports only percentages per window, not per ticket. |
| Status line, Where we are, tests, example | The ticket's handover (`memory_entries`) and the approval request comment. A line like "1 044 tests green" is shown only if the handover says it. |
| Fuel | `lib/limits.mjs summary`. |
| Health | What the wake recorded (`heartbeat_state` and `heartbeat_incidents`, read-only), with its age ("status from 40 s ago"). If the wake has not reported for more than three wake intervals, that is itself shown as a problem ("wake has not reported for 4 min"). The app never runs `cleared status`. |
| Pilot mode | Derived from `[merge] tooling_paths`: whether tooling paths may merge after review. |
| Captures | Images attached to the ticket's comments, for the local tracker. Remote tracker images are not proxied in this version. |

## Access

The server listens on `[app] bind` and refuses any peer outside `[app] ranges` (Tailscale and this machine by default) and any `Host` it does not expect. Every route except the sign-in page needs the access token, from a cookie or an `Authorization: Bearer` header. The token file is a private regular file (mode `0600`) outside the project; `cleared app` creates it on first start and never prints it except for `--link`. The sign-in page reads the token after the `#` sign (never sent in a request), sends it in a header to `/session` and gets an `HttpOnly`, `SameSite=Strict` cookie. Only `GET` and `HEAD` are accepted; anything else is `405`. The page loads no script, font, image or style from another site (`Content-Security-Policy: default-src 'self'`).

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
| `health.updated` | `{ "health": {...}, "mode": {...} }` |
| `heartbeat` | `{}` every 15 s, so the page can tell silence from calm. |

The page shows "Connection lost, last update HH:MM" at the top when the stream breaks or no frame arrives for 40 s. The names are dotted, `data` is plain JSON and there is no library dependency, so a later converter can map them to AG-UI: `snapshot` to `STATE_SNAPSHOT`, `*.updated` and `*.removed` to `STATE_DELTA`, `heartbeat` to a custom event.

## Limits of this version

One project per server (tabs appear when a source lists several). No accounts. No flight plans, estimates or money amounts.
