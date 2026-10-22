# Notifications

The human is told on his phone as soon as something waits for him, with no outside service required. At the end of every wake (once a minute with the default timer), the dispatcher `lib/notify.mjs` looks at what the service itself recorded and sends what is new. A notification has a title in product words, one sentence, and a link that opens the ticket's porthole in the [app](app.md). It never carries a secret, an amount, a server path, or a ticket's text beyond its title.

## What you receive, and when

| Kind | Sent when | Source | Example (English / French) |
| --- | --- | --- | --- |
| `approval` | A release waits for your agreement: a *Ready to land* card, with a request of Cleared for a version. A new request for the same ticket is news again. | The board snapshot | *Ready to land* · "EX-12 · Rename the save button waits for your agreement." / *Prêt à partir* · "EX-12 · Rename the save button attend votre accord." |
| `question` | A team ended its session on a question for you: a *Question* card. | The board snapshot | *A team asks you a question* · "EX-12 · …: open it to answer." / *Une équipe vous pose une question* · "EX-12 · … : ouvrez-le pour répondre." |
| `rollback` | A release was reverted (`rollback_pushed`, `prod_revert`). | The ledger | *Release rolled back* · "EX-12 · … was taken out of production after failing its health checks." / *Retour arrière* |
| `health` | A health problem began (`heartbeat_problem`: late or failed wake, a lead past its time, an unreachable tracker or forge, an idle team…), or the release watch failed (`release_health_failing`, `rollback_health_still_failing`, `release_watch_failed`, `rollback_failed`, `rollback_migrations_blocked`, `rollback_ambiguous_base`). | The ledger | *Health problem* · "Cleared: the last wake failed." / *Problème de santé* · "Cleared : le dernier réveil a échoué." |
| `blocked` | A team could not open (no place on the machine, `lane_limit_reached`) or the rules gave up moving it (`lane_stuck`), and no run of that ticket started since, for longer than `[notify] blocked_minutes`. | The ledger | *A team is blocked* · "EX-12 · … has been blocked for 34 min." / *Une équipe est bloquée* · "EX-12 · … est bloqué depuis 34 min." |

The language is `[owner] language`. A health notification names the problem by a fixed sentence for a known code, and "a health problem was detected" otherwise; the name of the team, path or service that a ledger detail may hold is never said.

How long it takes: the wake runs the dispatcher last, after the board snapshot and the health are written. A card that appears is told at the next wake (a minute with the default timer). A rollback recorded by the release watch between two wakes is told at the next one. The dispatcher runs inside the wake's lock, so it is kept short: the adapters of one notification are called together, Web Push tells four browsers at a time (each call cut after 10 seconds), and after `CLEARED_NOTIFY_DEADLINE_SECONDS` (30 by default, 50 at most) what is still on its way is given up and waits for the next wake, not counted as a try and not recorded as sent. `wake.sh` stops it after 60 seconds whatever happens.

What is held, and what is dropped:

- **Coalescing.** One ticket is told at most once every `[notify] coalesce_minutes` (10 by default); a ticket-less health problem is grouped by its code. What comes meanwhile waits and is sent once the window is over, if it is still true. A rollback or a health problem waits only behind another one of those, never behind a request or a question. Several things at once for one ticket make one notification, the most pressing (rollback, then health, approval, question, blocked).
- **Quiet hours.** During `[notify] quiet_hours` (for example `22:00-07:00`, on `[notify] timezone`), approval, question and blocked wait; at the end of the quiet hours, what still waits is sent. Rollback and health are never held.
- **Gone.** A card that stops waiting before it is sent (you answered, you cleared it from another device, the team opened again) is not sent at all.
- **Old.** Something that waited more than a day without being sent is dropped.
- **First dispatch.** The first time the dispatcher runs, it takes note of what exists and sends nothing: turning notifications on does not bring a backlog. An occurrence that came while no adapter was ready (no phone subscribed yet) is not kept for later either.
- **Turned off.** A kind left out of `[notify] events` is never sent.

## Settings

All in the project's `.cleared/agents.conf`, section [`[notify]`](configuration.md#notify): the adapters, the kinds sent (each on or off), the quiet hours and their time zone, the coalescing window, the blocked threshold. Four service settings are not in that file: the address the link opens (`CLEARED_NOTIFY_LINK_BASE`, no link when unset), the extra push hosts (`CLEARED_NOTIFY_PUSH_HOSTS`), the mail program (`CLEARED_NOTIFY_SENDMAIL`) and how long one dispatch may send (`CLEARED_NOTIFY_DEADLINE_SECONDS`, 30 by default, 50 at most). They come from the service's environment, because a project's agent can write `agents.conf`. Secrets are never in that file.

### Service environment (systemd drop-in)

A stock install sets none of these variables, and the units do not read the shell that ran `serve/install.sh`. Without `CLEARED_NOTIFY_LINK_BASE` a notification has no link, and Web Push reports `no_subject` (the push services need a contact: the https link address, or `[notify] vapid_subject`). `serve/install.sh` warns about it, and refuses, before writing anything, a link in these drop-ins that is not `http(s)://host[:port]` or that is on port 80 or 443 (`https://host` with no port is 443). Set the variables with a drop-in on each unit, as the service account, then reload:

```sh
mkdir -p ~/.config/systemd/user/cleared-wake.service.d ~/.config/systemd/user/cleared-app.service.d
cat > ~/.config/systemd/user/cleared-wake.service.d/notify.conf <<'EOF'
[Service]
# The app's [app] public_origin, port included: never 443 (docs/app.md, Setup for the gestures).
Environment=CLEARED_NOTIFY_LINK_BASE=https://<machine>.<tailnet>.ts.net:8443
# Only for a self-hosted push service (the four browsers' own services are known already).
Environment=CLEARED_NOTIFY_PUSH_HOSTS=push.example.org
# Optional: CLEARED_NOTIFY_SENDMAIL=/usr/sbin/sendmail, CLEARED_NOTIFY_DEADLINE_SECONDS=30 (50 at most)
EOF
cat > ~/.config/systemd/user/cleared-app.service.d/notify.conf <<'EOF'
[Service]
# The same host as the wake's, when it is self-hosted: the app accepts a subscription to it.
Environment=CLEARED_NOTIFY_PUSH_HOSTS=push.example.org
EOF
systemctl --user daemon-reload
systemctl --user restart cleared-app.service
```

The wake reads its drop-in at its next run (a minute with the default timer). `CLEARED_NOTIFY_PUSH_HOSTS` belongs in both units: the app checks a subscription's address, and the wake checks it again before it sends. Leave the `PUSH_HOSTS` lines out when the push services are the browsers' own. Check the result with `notify.mjs test` as the service account; with the link set, the test message opens the app.

## Setup

Step 1 below needs the link, which is set in the drop-in above.

### Web Push, through the app (default)

Nothing outside your machine to sign up for: the browser's own push service (Google for Chrome and Android, Mozilla for Firefox, Apple for Safari and iPhone, Microsoft for Edge) carries a message encrypted for your device (RFC 8291), signed by a key of your service (VAPID, RFC 8292). Cleared implements both with Node's own crypto: no dependency.

1. Give the app an https address and set `CLEARED_NOTIFY_LINK_BASE` to it in the service's environment (for example `CLEARED_NOTIFY_LINK_BASE=https://<machine>.<tailnet>.ts.net:8443`, from `tailscale serve --bg --https=8443 http://127.0.0.1:8788`): the same address as `[app] public_origin`, port included. Never `tailscale serve` on its default port 443, which belongs to the machine's public proxy ([the app](app.md#setup-for-the-gestures)). Push needs a secure address. An app moved to another port is another origin for the browsers: turn notifications on again on each device from the new address (on iPhone, add it to the Home Screen again). The push services also want a contact: `[notify] vapid_subject` (a `mailto:` address or an https page); without it, the https link address is used.
2. Register a passkey first (`cleared app passkey`, see [the app](app.md)): turning notifications on or off is confirmed with it. Open the app on the phone or computer and sign in. Its header shows **Turn on notifications** when Web Push is offered. Tap it, allow notifications, confirm with the passkey (fingerprint, face or the device's code), and the device shows "Notifications are on" by itself. The button then reads **Notifications on**; tapping it again, and confirming, turns them off for that device. Up to ten devices can be subscribed; an eleventh pushes out the oldest.
3. Check the whole path from the machine, as the service account: `CLEARED_REPO=/path/to/project node /path/to/cleared/lib/notify.mjs test`. It sends a fixed test message to every configured adapter and says, per adapter, `sent`, `not ready (reason)` or `failed (code)`.

**On iPhone and iPad (iOS 16.4 or later), web notifications exist only for an app added to the Home Screen.** In Safari, open the app, tap **Share**, then **Add to Home Screen**, and open Cleared from its new icon. The installed app keeps its own cookies, apart from Safari: sign in again there (with the address of `cleared app --link`), then tap **Turn on notifications**. In Safari itself, the button only says this. Android, and Chrome, Edge or Firefox on a computer, need no installation (installing the app still gives it its own window and icon).

The Web Push key pair is made the first time the app is opened with Web Push offered, in `secrets_dir`, and is never replaced (a new one would void every subscription). A subscription the push service says is gone (the browser forgot it, the app was removed) is dropped at the next send. If notifications stop on a device, turn them off and on again there.

### ntfy

[ntfy](https://ntfy.sh) is open source and can be hosted on your own machine; the ntfy app on the phone subscribes to a topic. Choose a long random topic name: whoever knows it can read the messages. Put the server, the topic and, for a server that requires it, an access token in `credentials.json` (below), and add `ntfy` to `[notify] adapters`. The server address must be https (or http on this machine).

### E-mail

Cleared hands the message to the machine's own mail program (`CLEARED_NOTIFY_SENDMAIL`, else the first well-known one that is there: `/usr/sbin/sendmail`, Postfix, msmtp, OpenSMTPD…, a file no one else can write), which holds the mail account; Cleared holds no mail password. Put the recipient and the sender in `credentials.json` and add `email` to `[notify] adapters`. Check it with `notify.mjs test`.

### Telegram

Create a bot with @BotFather, send it one message from your account, and read your chat id (for example from `https://api.telegram.org/bot<token>/getUpdates`, in a private window). Put the bot token and the chat id in `credentials.json`, and add `telegram` to `[notify] adapters`. Messages are plain text.

### The private directory

`[notify] secrets_dir` (default `~/.config/cleared/notify` of the service account) is created by the app, mode `0700`, and must stay owned by the service account, outside the project and the Cleared checkout. Every read refuses a looser directory or file, a link, or a place inside a repository; `serve/install.sh` probes, as `[security] agent_user`, that the agents' account can reach none of it.

| File | Holds | Written by |
| --- | --- | --- |
| `vapid.json` | The Web Push key pair. | The app, the first time Web Push is offered |
| `subscriptions.json` | Each subscribed browser: its push service address, its keys, the device's short name. | The app (subscribe, unsubscribe); the dispatcher drops one the push service says is gone. Each change holds `subscriptions.lock` (flock) |
| `credentials.json` | What the other adapters need, by adapter. | You, by hand, mode `0600` |

`credentials.json`, with only the adapters you use (invented values):

```json
{
  "ntfy": { "server": "https://ntfy.example.org", "topic": "cleared-k3v9q2x7w1", "token": "tk_exampletokenvalue" },
  "telegram": { "bot_token": "123456789:EXAMPLE-token-from-BotFather-000000", "chat_id": "123456789" },
  "email": { "to": "you@example.org", "from": "cleared@example.org" }
}
```

```sh
install -d -m 0700 ~/.config/cleared/notify
install -m 0600 /dev/null ~/.config/cleared/notify/credentials.json   # then edit it
```

## Security model

- **Only the human subscribes, with his passkey.** Anyone who gets the app link must not be able to receive the human's notifications on their own phone. So subscribing a device, and removing one, require a fresh passkey assertion by the human: not just a session, not the access token, not the app link. The access token (which is what the app link carries) opens a session (`POST /session`), so a session alone does not prove the human: an agent holding the token could open one. Turning a device's notifications on or off therefore takes the same passkey ceremony as Clear to land and Send back: `POST /api/notifications/challenge` gives a one-time challenge bound to the session, the purpose (on or off) and a hash of the subscription (its address and keys); `subscribe` or `unsubscribe` then needs the WebAuthn assertion of a registered passkey (user verification required) on that challenge, plus the session cookie, the anti-forgery token and the app's own origin. A passkey is registered only with a grant the human's Unix account gets (`cleared app passkey`). With no passkey registered, nothing can be subscribed. So a session opened with the token alone can neither add a device (which would receive every notification) nor remove one, and cannot use the ten-device cap to push the human's devices out. Only an https address of a known push service is kept (`CLEARED_NOTIFY_PUSH_HOSTS` adds a self-hosted one), so the service never posts to an address of someone's choosing. Each attempt is one `app_gesture` event (`{gesture: "notifications", result, device}`), without the address. There are no notification settings in the app: they are in the configuration file and the service's environment; a settings change made in the app later must take the same passkey assertion.
- **No one chooses what is said.** The dispatcher takes no text: `notify.mjs` accepts `dispatch` (the wake) or `test` (a fixed message) and nothing else. An agent can cause an event (a team asks a question, a release request goes through the broker), never its words: a notification is built in `lib/notify/contract.mjs` from the kind, the ticket's identifier, a known health code, a number of minutes, the catalog's sentences and the ticket's title. A ledger detail, a team's question, a report or a ticket's body are never read for it.
- **The title is filtered.** A ticket's title can be written by anyone who can write a ticket, an agent included. Before it is used it goes through `sanitize`: links, absolute, home, relative and Windows paths, environment variables, tokens and keys (known prefixes, JWTs, long base64 or hex), `password=…`-like pairs, e-mail, IP and IPv6 addresses, domains and host names, `user:pass@host` credentials, Slack-style tokens, amounts with or without a currency (`5 k€`, `€5M`), and numbers of five digits or more are replaced (`[path]`, `[secret]`, `[amount]`…), invisible and direction-changing characters removed (a name whose last part is a file extension that is not a top-level domain, such as `agents.conf` or `app.test.mjs`, is kept, and so are a few usual file names whose extension is also a domain, such as `README.md` or `install.sh`; any other `name.sh`, `name.md`, `name.py`, `name.rs` or `name.zip` is a host), the result put on one line and cut to 80 characters; the whole message is filtered again. The tests try a title made to leak a credentials path and a token.
- **Secrets stay with the service.** The Web Push private key, the subscriptions (a push address is a capability) and the adapters' credentials live in `secrets_dir` only. They are never written to the ledger, a log, a notification or an error: a failed delivery is recorded as a short code (`ntfy refused (403)`, `telegram unreachable`, `push service refused`), never with its address, token or answer. The Telegram token travels in the address of each call, so that address is never said. Its API address can only be changed in the service's environment (`CLEARED_NOTIFY_TELEGRAM_API`, for a test double).
- **What the carriers see.** Web Push messages are encrypted for the device: the push service sees neither title nor text. ntfy, Telegram and e-mail carry the text (the kind, the ticket's identifier and filtered title) through their servers; choose them knowing that.
- **The link.** It is the app's address with `#ticket=<id>`: the part after `#` never reaches a server or its log, and it opens the porthole only after the usual sign-in. The service worker opens only an address of the app itself.
- **Spam is not capped.** An agent can spam the human by creating many tickets or questions: the 10-minute coalescing is per ticket, with no global cap.
- **The passkey prompt is thin.** The passkey prompt shows only the site, not what is confirmed.
- **The first run.** If the first run has no snapshot, health events are not initialised.
- **Limits.** Under one shared Unix account (`[security] allow_shared_uid`, no `agent_user`), an agent can read `secrets_dir` like any file of the service, and send what it likes with those keys: as for the rest of Cleared, the account boundary is the protection. Whoever holds an unlocked subscribed phone reads its notifications.

## The ledger: when you were told

Every notification sent is one `notification_sent` event: `at` is when it was sent, `ticket` the ticket (none for a ticket-less health problem), `value` the seconds between what it tells and the send, and `detail` `{"event": "<kind>", "adapter": "<adapter>"}` (one row per adapter that delivered it). A delivery that failed is a `notification_failed` event with `{"event", "adapter", "reason"}`. The test message is recorded with `"event": "test"`. With the human's gestures in the app (`app_gesture`), this gives the time from being told to acting:

```sh
node lib/ledger.mjs sql "SELECT n.ticket, n.at AS told, MIN(g.at) AS acted FROM events n JOIN events g ON g.ticket = n.ticket AND g.kind = 'app_gesture' AND g.at > n.at WHERE n.kind = 'notification_sent' AND json_extract(n.detail, '$.event') = 'approval' GROUP BY n.event_id"
```

The dispatcher keeps its own queue and cursor in two tables of the ledger's database (`notify_queue`, `notify_state`); finished entries are removed after two weeks. A notification delivered is marked sent in the queue first; if its `notification_sent` event then cannot be written (the ledger locked or full), the wake's log says so and it is not sent again: that row is missing from the measure, the human is not told twice.

## Limits of this version

- Nothing is sent while the wake does not run: an external [heartbeat monitor](heartbeat.md) covers a stopped machine.
- One human, one set of settings: no per-device choice of kinds or quiet hours.
- The settings are in the configuration file, not in the app.
- A notification given up at the deadline after its carrier did receive it is sent again at the next wake (a rare double).
- The title filter is for accidents, not for a writer who wants a name through: a ticket's author can still spell a host out in words.

## Version 2: the dispatcher in the service

Cleared v2 ([milestone 2 plan](v2/milestone-2-plan.md), section 6) keeps the adapters, the private directory, the catalog and the rules above. What changed, on 2026-10-22:

- **The dispatcher runs in the v2 service**, not at the end of a wake. `v2/src/notify/dispatcher.ts` ticks when the service starts and every 30 seconds after, as soon as a project is set (`CLEARED_V2_PROJECT`). It needs no browser open and no request to the service's API.
- **Where it looks.** The inbox (`flow_inbox`), for what waits for a person now, and v1's `events` table, for what the release watch wrote since the last tick (`rollback_pushed`, `prod_revert`, and the watch's failures listed under `health` above). The board snapshot and the `blocked` kind are v1's only.
- **Two new kinds**, `permission` and `plan`. The order of urgency is rollback, health, approval, plan, question, permission (`URGENCY` in `lib/notify/contract.mjs`).

| Kind | Sent when | The link opens |
| --- | --- | --- |
| `approval` | A release waits in the inbox for your approval. | `/inbox#<item>` |
| `permission` | A team asks for a permission the policy left to you. | `/inbox#<item>` |
| `question` | A team asks a question, or the lead does ("The lead asks you a question"). | `/inbox#<item>`, or `/lead` for the lead |
| `plan` | The lead proposes a plan. | `/lead` |
| `rollback` | The release watch reverted a release. | `/inbox` |
| `health` | The release watch failed; the lead could not start (`lead_start_failed`); the usage limit stops new tickets (`week_stop`). | `/` |

- **Groups.** One notification per ticket every `coalesce_minutes`, as above. The lead's plan and question have no ticket: they are one group, `lead`, told at most once per window.
- **What a notification says.** The kind, the ticket's identifier, a title and a health code, through the catalog. The title is a release's or a plan's; a permission and a question carry none, only the ticket. Nothing of a permission's command, a question's text, a plan's summary or a ledger row's detail is ever read for it.
- **Subscribing** is in the v2 app with the password session, the anti-forgery token and the app's origin. There is no passkey in v2 ([the decisions log](v2/decisions-log.md), "app login by password, no passkeys"), so the first point of the security model above does not hold in v2: any signed-in person can subscribe a device.
- **The settings** are read from the same file as the app's: `CLEARED_CONF`, else `<CLEARED_REPO>/.cleared/agents.conf`, and `CLEARED_NOTIFY_*` from the service's environment. So the app, which keeps the subscriptions, and the dispatcher, which sends to them, use one private directory and one key pair. The dispatcher reads them again at most every five minutes, and only when something is to be sent. A project that lists `[notify] events` itself must add `permission` and `plan` to its list to receive them; a project that lists none receives every kind.
- **lib/notify runs in a child process.** Importing it copies every `CLEARED_*` variable of the process to `ORCH_*` (`lib/conf.mjs`), which the service must not do. So the dispatcher hands the facts of each notification to `node v2/src/cli/notify.ts send` on its standard input, and that process makes the text, sends it and says per adapter what happened. It refuses a message the dispatcher would not make: an unknown kind, a link outside the app's pages, a group of free text.
- **Two rules differ from v1's.**
  - Something that comes while no device can be told (none subscribed yet, an adapter not ready) waits, for its day at most, and is sent once one can. v1 dropped it.
  - The things folded into a notification are dropped only when it is sent. Behind one given up after three tries, they still wait their turn.
- **The deadline** (`CLEARED_NOTIFY_DEADLINE_SECONDS`) holds for each batch: what is still on its way is given up and tried at the next tick, not counted as a try. The child is killed ten seconds after it.
- **Queue and measure.** The queue is the `v2_notify_queue` table of the ledger; the first run takes note of what waits and sends nothing. Each delivery is a `notification_sent` row in the `events` table and each failure a `notification_failed` row, as in v1, so the query of "The ledger: when you were told" works for v2 too. A plan's or a lead question's row has no ticket.
- **Check the setup** from `v2/`, as the service account: `npm run notify -- test`. It sends the fixed test message to every configured adapter and says, per adapter, `sent`, `not ready (reason)` or `failed (code)`.

Limits of the v2 dispatcher:

- The flow's events (`FlowEngine.subscribe`) are not read. The flow's engine is built at the first request to the service's API, so a service restarted at night with no browser open would never hear of a rollback; the release watch's rows are written in any case.
- After a restart, the requests a stopped session left waiting are closed by the flow's engine, which is built at the first request to the API. Until then the dispatcher sees them waiting and may send one that nobody can answer any more; the inbox shows it handled once the app is opened.
- The lead's health (`lead_start_failed`) and the usage stop (`week_stop`) are sent when the lead engine and the plan runner report them (`reportHealth` in `v2/src/notify/queue.ts`); until those land, nothing reports them.
