# Cleared v2 service

The core of Cleared v2, rewritten as a Node service in TypeScript. This folder holds only the skeleton: a health endpoint, its tests and its checks. The v1 code at the root of the repository is unchanged and keeps working on its own.

## Why a separate folder

`v2/` has its own `package.json`, lock file and `tsconfig.json`, so v2 dependencies and settings never reach v1, and the v1 checks (`.github/workflows/checks.yml`, which list v1 paths) never pick up v2 files. The folder is named after the `v2` branch it targets.

## Requirements

Node.js 24 or later. Node runs the service's and the app server's `.ts` files directly through its type stripping: no build step and no emitted JavaScript for them. Only syntax Node can erase is allowed (no `enum`, no `namespace`, no constructor parameter properties); `tsc` enforces it with `erasableSyntaxOnly`. Relative imports name the `.ts` file.

The one exception is the app's front end (`app/web/`, React): Vite builds it into `app/dist/`, which the app serves (the owner's decision of 2026-10-22, in the [decisions log](../docs/v2/decisions-log.md)). `npm run app` and `npm test` build it first. The app reads the build's file names once, at its first page: restart it after a new `npm run build`.

## Commands

Run from `v2/`:

| Command | What it does |
| --- | --- |
| `npm ci` | Installs the pinned dev dependencies. The service and the app's server have no runtime dependency: every package is either a type, a test or build tool, or code that Vite bundles into the page. `.npmrc` runs no install script (CopilotKit pulls in `@scarf/scarf`, whose install script reports installs), and `package.json` turns Scarf off too (`scarfSettings`). |
| `npm run build` | Builds the front end with Vite (`app/web/vite.config.ts`) into `app/dist/`. |
| `npm start` | Starts the service (`node src/main.ts`). |
| `npm run app` | Starts the app (`node app/main.ts`), see [The app](#the-app). |
| `npm run user -- add <name>` | Adds a person who signs in to the app (the `cleared-v2 user add <name>` command). |
| `npm test` | Builds the front end, runs the unit tests with `node --test` (`test/` and `app/test/`), then the components' tests with Vitest (`app/web/test/`, rendered to HTML under Node). |
| `npx tsc --noEmit` | Type checks `src/`, `test/` and `scripts/`. `npm run typecheck` also checks the app's server with `tsc --noEmit -p app` and the front end with `tsc --noEmit -p app/web`; `npm test` runs both through `app/test/static.test.ts`. |
| `node src/cli/ledger-mcp.ts` | Serves the ledger's session history to an agent as a read-only MCP server on stdio, see [The ledger's MCP server](#the-ledgers-mcp-server). Not through `npm run`, whose banner would reach the protocol's stdout. |
| `npm run guard` | Runs the repository's private terms and secrets guard (`lib/guard/codex-guard.mjs`) on every v2 file and the v2 workflow. `-- --base origin/v2` also checks the lines changed since that ref, in the guard's `--strict` diff mode. |

## Settings

| Variable | Default | Notes |
| --- | --- | --- |
| `CLEARED_V2_HOST` | `127.0.0.1` | This machine only. |
| `CLEARED_V2_PORT` | `8791` | Refused: 80 and 443 (the machine's public proxy, see [Decisions](../docs/concepts.md#decisions)), 8787 and 8788 (the v1 dashboard and app), 8790. A port already in use stops the service with a message. |
| `CLEARED_V2_EDITOR_SSH_HOST` | none | For Open in an editor: the host your VS Code or Cursor reaches this server by over SSH, as your ssh config names it, with an optional `user@` (letters, digits, dots, dashes, underscores; anything else stops the service at start). Unset, the links open the session's checkout on the machine the browser is on (`vscode://file/<path>`); set, they are the remote ones (`vscode://vscode-remote/ssh-remote+<host>/<path>`). The service runs no editor. |

`GET /health` (and `HEAD`) answers `200` with `{"status":"ok"}`. Any other path is `404`; another method on `/health` is `405`; a request target the URL parser refuses (such as `//[`) is `400`.

## The app

`v2/app` is the web app: the sign-in page, the shell (project, Tower, Inbox with its count, Sessions, Tickets, Plans, the notifications button, the clock, the theme button, the signed-in person) and the screens. It holds no key and signs nothing. Every request a signed-in person makes to `/api/service/*` goes to the service on loopback as `/api/*`, with the person's id and the app's proof, and with nothing of the browser's cookie or anti-forgery token. Design: [`app/DESIGN.md`](../app/DESIGN.md), with the Geist fonts served by the app itself.

To try it on sample data, without the service:

```sh
CLEARED_STATE_DIR=/tmp/cleared-v2-try npm run user -- add demo
CLEARED_STATE_DIR=/tmp/cleared-v2-try CLEARED_V2_APP_SOURCE=fixtures npm run app
```

Then open `http://127.0.0.1:8792/` and sign in. Check that the port is free first (`ss -ltn`).

| Variable | Default | Notes |
| --- | --- | --- |
| `CLEARED_V2_APP_HOST` | `127.0.0.1` | This machine only: `127.0.0.1`, `::1` or `localhost`; anything else is refused. |
| `CLEARED_V2_APP_PORT` | `8792` | The service's reserved ports are refused, and so is the service's own port. |
| `CLEARED_V2_APP_SOURCE` | `service` | `fixtures` answers the service's read routes from sample data played by the fake adapter, and creates tickets in memory. The header then says "Sample data, not the service". |
| `CLEARED_V2_PORT` | `8791` | Where the app finds the service, on `127.0.0.1`. |
| `CLEARED_V2_APP_LANGUAGE` | `fr` | `fr` or `en`. |
| `CLEARED_V2_APP_PROJECT` | the last part of `CLEARED_REPO` | The project name in the header. |
| `CLEARED_V2_APP_ORIGIN` | none | The address the browser uses when a proxy on this machine serves the app, such as `https://<machine>.<tailnet>.ts.net:8443`. Writes must come from it. |

The app finds `ledger.db` as the service does (`CLEARED_STATE_DIR`, and so on). It keeps there the users (`users`, Argon2id hashes) and the sign-in sessions (`app_sessions`, the SHA-256 of each session id), and it makes the proof file `v2-app-proof` (mode 0600) beside it.

Sign-in and writes:
- The session cookie is `HttpOnly`, `Secure`, `SameSite=Strict` and lasts 30 days. It survives a restart of the app.
- A session ends 30 days after its sign-in, whatever happens in between: it is not renewed by use. Then the app asks for the password again.
- `Secure` is set even on plain `http://127.0.0.1:8792`. Headless Chromium kept the cookie there on 2026-10-21. Review round 1 of the pull request reports that Safari does not keep a `Secure` cookie on plain `http`; that was not checked here. In Safari, open the app through an `https` address (`CLEARED_V2_APP_ORIGIN`, served by a proxy on this machine) or sign-in will not hold.
- A password is 15 to 1024 characters (`cleared-v2 user add` refuses others). NIST SP 800-63B-4 asks for at least 15 for a password used alone, and 1024 is the sign-in form's limit.
- Five sign-in attempts from one address, or for one name, within 15 minutes block that address or name for the rest of the 15 minutes. An attempt counts from the moment it arrives, so a burst sent at once is limited the same way, and a right password does not count. During the block, even the right password gets `429`.
- A write needs the session, its anti-forgery token in `X-CSRF-Token` (from `GET /api/me`) and the app's own origin.
- A request for another host name gets `421`.
- The pages load nothing inline and nothing from another site.

### The front end

The pages are React (strict TypeScript) under `app/web/`, built by Vite into `app/dist/`:

- **Each screen** is `app/web/screens/<screen>/`: `model.ts`, its rules as pure functions (the tests run them under Node), `<Screen>.tsx`, the component, and its sheet. Its words are in `app/messages/<screen>.en.json` and `.fr.json`, bundled into the page; the language is `CLEARED_V2_APP_LANGUAGE`, and a key missing from French falls back to English.
- **The shell** (`app/web/shell/`) draws the header and the sign-in page. The server writes each page's HTML: its language, its title, the screen and what the header shows first on `<body>`, and the bundle's files from `dist/.vite/manifest.json`. The sign-in form posts to `/login` as before; a refusal comes back with the server's sentence on `<body data-error>`.
- **The components** are shadcn/ui's (`app/web/components/ui/`, Radix plus Tailwind), copied in and restyled to the kit. The theme is shadcn/ui's CSS variables with the kit's colours (`app/web/styles/app.css`), light and dark, chosen with the button (`data-theme`, never the system's setting). Tailwind is loaded without its preflight, so the kit's sheets keep the look. The icons are Phosphor's (`@phosphor-icons/react`), regular weight; the bell is bold while this device is told.
- **CopilotKit** holds the session's and the lead's threads, open source and local only: the headless React entries of `@copilotkit/react-core`, with no runtime, no Copilot Cloud, no public API key and no license key. Each thread is an AG-UI agent (`app/web/copilot/agent.ts`) that reads the app's own stream and publishes the thread as AG-UI state and message snapshots; the screens draw what CopilotKit holds, and the person's answers go through the app's routes as before. CopilotKit's inspector is replaced by an empty module at build time, and `app/web/test/copilot.test.tsx` checks that CopilotKit sends no request of its own. The page's Content-Security-Policy (`default-src 'self'`) would refuse one anyway.

The lead screen (`/lead` and `/plans/<id>`, the Plans tab) reads the draft that the tower's New goal and Ask the lead send as `?draft=` (and `?goal=1`), then drops it from the address.

### Notifications

The bell in the header turns this browser's notifications on or off, and says how many devices are told. A signed-in person does it with the same checks as any write (the session, the anti-forgery token, the app's origin); there is no passkey in v2. The app only keeps the subscriptions: the service's dispatcher sends the notifications.

- **Where they are kept.** In the service's private notification directory, the one v1 used: `[notify] secrets_dir`, by default `~/.config/cleared/notify` of the account the app and the service run under. The app creates it with mode 0700 and the Web Push key pair in it (`vapid.json`, 0600) the first time a signed-in page asks for the status (every page does, to draw the bell), and refuses it, without repairing it, when it is looser, a link, owned by another account, or inside the project or this checkout. The browsers are in `subscriptions.json`: at most ten, the oldest pushed out, each named by its user and platform only (`alex · iPhone`).
- **What a browser may give.** An `https` address of a known push service (Google, Mozilla, Apple, Microsoft), without a port, and its two keys. `CLEARED_NOTIFY_PUSH_HOSTS` (comma separated) adds hosts, for a self-hosted push service or a test.
- **The settings.** `[notify] adapters` must include `webpush` (the default), and the service needs an address to sign with: `[notify] vapid_subject` (a `mailto:` address or an `https` address), or else `CLEARED_NOTIFY_LINK_BASE` when it is `https`. They are read from the project's `agents.conf` (`CLEARED_CONF`, else `<CLEARED_REPO>/.cleared/agents.conf`) and the app's environment, once, at the first use: restart the app after changing them.
- **The https address.** Web Push needs a secure origin. `http://127.0.0.1:8792` is one for a browser on this machine. Any other device needs the app's `https` address, served by a proxy on this machine: set it as `CLEARED_V2_APP_ORIGIN` for the app and as `CLEARED_NOTIFY_LINK_BASE` for the service, so a notification opens the app there. On plain `http` from another address, the menu says notifications need the https address.
- **iPhone and iPad.** Web notifications exist only for the app added to the Home Screen (Share, then Add to Home Screen); the menu says so in Safari. The app serves `manifest.webmanifest`, its icons and the service worker `sw.js` without a session, so it can be installed. The worker shows what is pushed, opens only addresses of the app, and caches nothing.
- **Routes.** `GET /api/notifications` answers `{ available, reason, publicKey, devices }`, with `reason` one of `off` (no Web Push), `insecure`, `no_subject`, `config` (a setting cannot be read) and `store` (the directory is refused). `POST /api/notifications/subscribe` takes `{ subscription }` as the browser gives it, and `POST /api/notifications/unsubscribe` takes `{ endpoint }`.

## The ledger's MCP server

An agent searches the sessions' history through it (issue 292): the sessions, their events, the review verdicts, the questions and the permission answers that `ledger.db` keeps. To install it, give the agent this line: `claude mcp add cleared-ledger -e CLEARED_STATE_DIR=<folder of ledger.db> -- node <cleared checkout>/v2/src/cli/ledger-mcp.ts`.

- **Tools.** `search_sessions` (text, ticket, project, role, status, dates), `search_events` (text, ticket, project, session, event type or custom name such as `cleared.review_verdict`, dates) and `get_session_timeline` (one session's events in order). Dates are ISO days (`2026-10-20`, the whole day) or moments; both ends are included. Newest first; the timeline in its order.
- **Pages.** 20 items by default, 100 at most (more is cut to 100). Each answer gives `next`: the cursor of the next page for a search, the `after_seq` of the next page for the timeline, `null` on the last page. A search reads at most 2000 rows per call; at that limit it answers `partial: true` with what it found so far, perhaps nothing, and a `next` that goes on after the last row read. A cursor holds the stored time and rowid of a row, never an id. A term that is the words of a marker (`[removed: GitHub token]`) finds the text that was cleaned.
- **Read only.** The file is opened with SQLite's read-only flag and `PRAGMA query_only`, never through `openStore`: no folder made, no table created, no migration, no copy. A stopped service's ledger in a folder that cannot be written to (no `-wal`, no `-shm`) is read `immutable`; one with a `-wal` never is. A ledger that does not exist is not created; the server stops with code 66 and says where it looked (64 when it cannot tell where the ledger is, as the service does). The tools are marked `readOnlyHint`.
- **Secrets.** Every string of an answer goes through the events' cleaner (`session/clean.ts`: the guard's patterns, the values of the environment variables whose names say secret, the service's folders), then the GitHub, Slack, Linear, AWS, Google, Stripe and npm token forms, JSON web tokens, bearer tokens, and the value of any `NAME=value` whose name says key, token, secret or password. Then it is cut, so a secret is never shown in part: at 1000 characters in a search's answer, at 4096 (a command output's limit) in a timeline. A session's preview key is never given. A search reads the whole cleaned text, not the part an answer shows: a term shaped like a secret is refused, and a piece of a secret finds nothing, so a search cannot tell whether a secret is in the ledger. The server cleans with its own environment: a secret the service knew but the server's environment does not hold is removed only if one of the patterns finds it.
- **Words.** The tools' descriptions and errors are in `src/mcp/messages/ledger.en.json` and `.fr.json`, in the app's language (`CLEARED_V2_APP_LANGUAGE`, `fr` by default). A session's duration is said as the app says it (`app/web/lib/time.ts`: "1 h 30", "1h 30m").
- **Protocol.** MCP over stdio, one JSON-RPC 2.0 message per line, written in `src/mcp/server.ts` without the SDK (the service has no runtime dependency). stdout carries only the protocol; anything else goes to stderr. No port is opened.

## The guard

The guard checks every v2 file except the app's web fonts (`app/public/fonts/*.woff2`) and its three icons (`app/public/icons/icon-192.png`, `icon-512.png` and `apple-touch-icon.png`, by exact name), which are binary; it says how many it left out, and any other binary file is refused. The guard reads its private-term fingerprint lists from a project's committed `.cleared/agents.conf` (`[guard] salt`, `terms`, `allowed`), as v1 does. This repository commits no such list, so by default, and in CI, `npm run guard` checks secrets, private keys, IBANs, credentials in URLs, email addresses and phone numbers, and no private terms; it says so when it runs. This is a known gap: closing it in CI needs a fingerprint list the guard can read there, either a committed guard configuration with its lists or lists provided to the workflow. To check private terms too, point it at a project whose committed configuration names its lists: `CLEARED_REPO=<project checkout> [ORCH_GUARD_REF=<ref>] npm run guard`. The lines changed since `--base` leave out `package-lock.json`, which npm writes: the strict mode reads a dependency named `js-tokens` with a version range as an assigned secret. The tree check still reads the whole lock file. `app/dist/` is not checked: it is built, and git ignores it.

## CI

`.github/workflows/v2.yml` runs on pull requests to `v2`: `npm ci`, `npm run typecheck` (the service, the app's server and the front end), `npm run build` (Vite), `npm test`, then the guard with `--base` set to the pull request's base branch. The job sets every opt-out of the front end's packages: `SCARF_ANALYTICS=false`, `DO_NOT_TRACK=1` and `COPILOTKIT_TELEMETRY_DISABLED=true`.

## Docker

A session runs in Docker containers that the service creates through the `docker` CLI (`src/container/docker.ts`, milestone 1 plan, lane 2). It needs the isolated gateway mode of bridge networks (`com.docker.network.bridge.gateway_mode_ipv4=isolated`), checked with Docker 29.8.1; which earlier versions have it was not checked.

### The label rule

Every object v2 creates carries `cleared.dev=v2`, and every session object also carries `cleared.session=<id>` and `cleared.role=<session|egress|service>`. `docker.ts` checks each command line before it runs:

- a create or build without the label is refused;
- a list without `--filter label=cleared.dev=v2` is refused, and so is a listed row without the label;
- `start`, `stop`, `rm`, `exec`, `inspect`, `logs`, `network rm` and `volume rm` take no filter, so they only name ids that a labelled list returned in the same call, after `--`;
- any other command (`run`, `kill`, `prune`, `pull`, ...) is refused.

### What a session is made of

| Object | Name | What it does |
| --- | --- | --- |
| network | `cleared-v2-<id>` | `--internal`, with the isolated gateway mode: no route out and no address on the host |
| network | `cleared-v2-<id>-out` | the egress container's own bridge; it does not use Docker's default bridge |
| volume | `cleared-v2-<id>-config` | `CLAUDE_CONFIG_DIR`. It is kept after `stop` so the session can resume, and removed when the ticket is done |
| container | `cleared-v2-<id>-svc-<alias>` | each declared test service, reachable as `<alias>` |
| container | `cleared-v2-<id>-egress` | the CONNECT proxy, reachable as `egress:3128` |
| container | `cleared-v2-<id>-session` | the session |

The session container runs as the service's uid and gid with a read-only root file system. Only `/tmp` (tmpfs, also `HOME`), `/workspace` (the ticket checkout) and the config volume are writable. It has no capability, `no-new-privileges`, no published port and no Docker socket. The token file is mounted read only at `/run/cleared/claude.token`. Default limits are 4 GB of memory (no swap on top), 2 CPUs and 1024 processes. A service gets 1 GB, 1 CPU and 512 processes; the egress container gets 256 MB, half a CPU and 128 processes.

`stop` stops and removes the session's containers, then its networks. A start refuses a session that still has containers or networks, and touches nothing of it. A failed start removes only what that call created; if that cleanup fails too, the error says so and names what may be left behind.

### Egress

The session's only way out is `HTTPS_PROXY` and `HTTP_PROXY` (upper and lower case), which point at `http://egress:3128`. The proxy (`images/egress/proxy.ts`) only accepts `CONNECT`. It opens a tunnel only when all of these hold:

- the host name is in the allow list, on the listed port (443 by default);
- the target is not a literal IP address;
- every address the name resolves to is public and not one of the host's own addresses.

It then dials the address it checked. It refuses every other request and logs one JSON line per decision.

The allow list is `api.anthropic.com` and `registry.npmjs.org`, plus the hosts the project declares. The service writes it to a folder mounted read only in the egress container and replaces it in one rename. The proxy reads it again for every CONNECT.

### Test services

A project declares its services in its configuration as `[session] services = postgres:16` (a comma-separated list of `[alias=]image:tag`, each optionally followed by `NAME=value` words that restate the image's fixed environment, as the guestbook's `postgres:16 POSTGRES_HOST_AUTH_METHOD=trust` does). The service reads the setting at the base branch and starts the services beside every session of the project. Milestone 1 knows one image, `postgres:16`. Its data folder is a tmpfs, so Docker creates no unlabelled anonymous volume. It uses trust authentication, and the session gets `DATABASE_URL=postgres://postgres@postgres:5432/postgres`. The session starts once `pg_isready` answers. Any other image is refused until its writable paths are added to the table in `src/container/services.ts`.

### The session image

`images/session/Dockerfile` is `node:24` with git, Claude Code `2.1.306` and `@anthropic-ai/claude-agent-sdk` `0.3.306` in `/opt/cleared/runner`, next to the runner's hook file. It sets `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` and `DISABLE_AUTOUPDATER=1`. Build both images with the label:

```sh
docker build --label cleared.dev=v2 --tag cleared-v2-session:2.1.306 v2/images/session
docker build --label cleared.dev=v2 --tag cleared-v2-egress:1 v2/images/egress
```

`src/container/devcontainer.ts` reads a project's `.devcontainer/devcontainer.json` (comments and trailing commas allowed) for two things only: `image`, or `build.dockerfile` with `build.context`, resolved from the `.devcontainer` folder and kept inside the checkout. Without either, the session uses Cleared's image. Every other key (features, mounts, `runArgs`, lifecycle commands, ports) is reported as ignored and never applied: the rest of the devcontainer specification is out of scope. A project image must carry what the runner needs (Node 24, Claude Code and the SDK); the runner arrives in lane 4. An image the devcontainer file names is pulled from its registry as it is, with no check of who published it: choosing it is the project's decision, unlike Cleared's own images, which are built from `node:24` here.

### The doctor

`node scripts/doctor.ts docker` builds both images and starts a session with a `postgres:16` service. From inside the session container it checks:

- the uid, the writable and read-only paths, and the token file;
- that there is no Docker command or socket;
- that Postgres answers;
- name resolution, the proxy (allowed, refused and bypassed), npm and Claude Code through the proxy;
- the host's addresses, each with a control connection from the host.

It then inspects the limits and mounts, stops the session, starts it again to check what the config volume kept, stops it, and shows that nothing with the session label remains. It prints every docker command line as it runs, with the session id, the scratch folder, the checkout path and container ids replaced, and every address that is not loopback replaced by its interface name or `<ipv4>` / `<ipv6>`. It prints the number of listening sockets before and after, and the new ones, not the host's list. `--no-build` skips the builds. It listens on `127.0.0.1:8791` for the run (the v2 health server) when that port is free, so the probe from the session is measured against a real listener.

What the run on this server established on 2026-10-21:

- External names do not resolve on an `--internal` network (`getent hosts api.anthropic.com` exits 2). Service and egress aliases do resolve. The proxy resolves external names, since CONNECT carries the name.
- npm and Claude Code honour the proxy variables (`npm view left-pad version` printed `1.3.0`; `claude -p` with an invalid key got `Invalid API key`, an answer from the API).
- With `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, Claude Code 2.1.306 asked the proxy for `api.anthropic.com:443` only. With that variable and `DISABLE_AUTOUPDATER` emptied, it also asked for `http-intake.logs.us5.datadoghq.com:443`, which was refused. This covers a failed login only. Hosts a real session needs beyond these are unknown until lane 4's run.
- After `stop`, a new start of the same session id finds what the session wrote in the config volume and the workdir: `docker volume create` on the kept volume succeeds and reuses it. Whether Claude Code itself resumes from it is lane 4's run.
- Without the isolated gateway mode, the internal network's gateway address is on the host, and a host service listening on all addresses answered there from the session.
