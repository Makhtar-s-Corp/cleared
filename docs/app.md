# The Cleared app (Cockpit), read only

`cleared app` starts one interface for desktop and phone that shows the factory live. This first version **only reads**: it writes nothing, runs no command that writes and makes no outside call (no GitHub, no tracker probe, no quota probe). No route writes, moves a ticket, answers a question, or starts or stops a team. Places where actions will come later are marked as reserved and are not clickable.

```sh
cleared app            # serves the app; the installer registers it as cleared-app.service
cleared app --link     # prints http://<bind>:<port>/login#<token> to open on your phone
cleared app --demo     # serves invented data, for a look without a project
```

## Views

The look follows [`app/DESIGN.md`](../app/DESIGN.md) (a light, Vercel/Geist-based design; mockups in `app/reference/`). Geist and Geist Mono are served by the app itself (`app/public/fonts/`, SIL Open Font License); nothing is loaded from another site. Light is the default; dark is a button, never the system setting.

- **Header**: logo, project, views (only *Tower* exists; *Landed*, *Fuel* and *Rules* are dimmed and marked soon), the health pill, the time and the theme button.
- **Greeting band**: the date and pilot mode, a greeting with what waits for you ("Two things are ready to land." / "Nothing needs you."), and the stat strip: *In flight*, *Landed today*, *First-time clean* and *Fuel left this week* (one bar per subscription, never money; "not measured" otherwise).
- **Tower**: four columns (In progress, Checks, Review, Awaiting you), one card per open ticket. A card that waits for you carries the amber stripe: *Ready to land* (with before/after tiles for a screen ticket) or *Question*. A team waiting for a place has a dashed card with the reason. On a phone the tower is one list, awaiting cards first.
- **Landed today**: what shipped today, with its model and outcome (clean first time, review rounds, rolled back).
- **Porthole**: a right panel on a computer, a page on a phone. Title, stat strip (flight, share of this week's usage, tests), *Show me* (device frames for a screen ticket; otherwise an example, the tests and what it touches), *Where we are*, *The squad* and the *Black box* timeline (raw event on unfold). *Send back* and *Clear to land* are disabled placeholders marked soon.

The interface language follows `[owner] language` through the message catalog (`app_*` keys in `lib/i18n/`).

## Where each piece of data comes from

| Shown | Source |
| --- | --- |
| Cards and columns | Tracker tickets in the configured states, plus `runs` and `events` of the ledger. *Checks* is derived: a ticket in the progress state whose author run ended with a pull request and has no review run yet. |
| Harness, model, flight time | `runs` (provider, model, started/ended). |
| Share of this week's usage, on a card | The ticket's tokens divided by all tokens of the last seven days. It is a share of Cleared's own usage, not a share of the subscription: the subscription reports only percentages per window, not per ticket. |
| Status line, Where we are, tests, example | The ticket's handover (`memory_entries`) and the approval request comment. A line like "1 044 tests green" is shown only if the handover says it. |
| Fuel | `lib/limits.mjs summary` (the share left is 100 minus the most constraining window). |
| Landed today, first-time clean | `merged_by_script` events, with the ticket's runs: no changes asked by a review means clean first time; a `prod_revert` or `rollback_pushed` after the merge means rolled back. First-time clean is counted over the last seven days. |
| In flight | Tickets whose last author run is still running. |
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
