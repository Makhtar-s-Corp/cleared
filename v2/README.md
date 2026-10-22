# Cleared v2 service

The core of Cleared v2, rewritten as a Node service in TypeScript. This folder holds only the skeleton: a health endpoint, its tests and its checks. The v1 code at the root of the repository is unchanged and keeps working on its own.

## Why a separate folder

`v2/` has its own `package.json`, lock file and `tsconfig.json`, so v2 dependencies and settings never reach v1, and the v1 checks (`.github/workflows/checks.yml`, which list v1 paths) never pick up v2 files. The folder is named after the `v2` branch it targets.

## Requirements

Node.js 24 or later. Node runs the `.ts` files directly through its type stripping: there is no build step and no emitted JavaScript. Only syntax Node can erase is allowed (no `enum`, no `namespace`, no constructor parameter properties); `tsc` enforces it with `erasableSyntaxOnly`. Relative imports name the `.ts` file.

## Commands

Run from `v2/`:

| Command | What it does |
| --- | --- |
| `npm ci` | Installs the pinned dev dependencies (TypeScript and Node types only; the service has no runtime dependency). |
| `npm start` | Starts the service (`node src/main.ts`). |
| `npm run app` | Starts the app (`node app/main.ts`), see [The app](#the-app). |
| `npm run user -- add <name>` | Adds a person who signs in to the app (the `cleared-v2 user add <name>` command). |
| `npm test` | Runs the unit tests with `node --test`: `test/` and `app/test/`. |
| `npx tsc --noEmit` | Type checks `src/`, `test/` and `scripts/`. `npm run typecheck` also checks `app/` with `tsc --noEmit -p app`, which `npm test` runs too. |
| `npm run guard` | Runs the repository's private terms and secrets guard (`lib/guard/codex-guard.mjs`) on every v2 file and the v2 workflow. `-- --base origin/v2` also checks the lines changed since that ref, in the guard's `--strict` diff mode. |

## Settings

| Variable | Default | Notes |
| --- | --- | --- |
| `CLEARED_V2_HOST` | `127.0.0.1` | This machine only. |
| `CLEARED_V2_PORT` | `8791` | Refused: 80 and 443 (the machine's public proxy, see [Decisions](../docs/concepts.md#decisions)), 8787 and 8788 (the v1 dashboard and app), 8790. A port already in use stops the service with a message. |

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
| `CLEARED_V2_APP_LANGUAGE` | `en` | `en` or `fr`. |
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

Each screen is `app/public/screens/<screen>.ts`, with its words in `app/messages/<screen>.en.json` and `.fr.json`. The browser gets the TypeScript with its types stripped. The lead screen (`/lead` and `/plans/<id>`, the Plans tab) is a stub until lane 8 of milestone 2 fills it: it keeps the draft that the tower's New goal and Ask the lead send as `?draft=` (and `?goal=1`), and sends nothing.

### Notifications

The bell in the header turns this browser's notifications on or off, and says how many devices are told. A signed-in person does it with the same checks as any write (the session, the anti-forgery token, the app's origin); there is no passkey in v2. The app only keeps the subscriptions: the service's dispatcher sends the notifications.

- **Where they are kept.** In the service's private notification directory, the one v1 used: `[notify] secrets_dir`, by default `~/.config/cleared/notify` of the account the app and the service run under. The app creates it with mode 0700 and the Web Push key pair in it (`vapid.json`, 0600) the first time a signed-in page asks for the status (every page does, to draw the bell), and refuses it, without repairing it, when it is looser, a link, owned by another account, or inside the project or this checkout. The browsers are in `subscriptions.json`: at most ten, the oldest pushed out, each named by its user and platform only (`alex · iPhone`).
- **What a browser may give.** An `https` address of a known push service (Google, Mozilla, Apple, Microsoft), without a port, and its two keys. `CLEARED_NOTIFY_PUSH_HOSTS` (comma separated) adds hosts, for a self-hosted push service or a test.
- **The settings.** `[notify] adapters` must include `webpush` (the default), and the service needs an address to sign with: `[notify] vapid_subject` (a `mailto:` address or an `https` address), or else `CLEARED_NOTIFY_LINK_BASE` when it is `https`. They are read from the project's `agents.conf` (`CLEARED_CONF`, else `<CLEARED_REPO>/.cleared/agents.conf`) and the app's environment, once, at the first use: restart the app after changing them.
- **The https address.** Web Push needs a secure origin. `http://127.0.0.1:8792` is one for a browser on this machine. Any other device needs the app's `https` address, served by a proxy on this machine: set it as `CLEARED_V2_APP_ORIGIN` for the app and as `CLEARED_NOTIFY_LINK_BASE` for the service, so a notification opens the app there. On plain `http` from another address, the menu says notifications need the https address.
- **iPhone and iPad.** Web notifications exist only for the app added to the Home Screen (Share, then Add to Home Screen); the menu says so in Safari. The app serves `manifest.webmanifest`, its icons and the service worker `sw.js` without a session, so it can be installed. The worker shows what is pushed, opens only addresses of the app, and caches nothing.
- **Routes.** `GET /api/notifications` answers `{ available, reason, publicKey, devices }`, with `reason` one of `off` (no Web Push), `insecure`, `no_subject`, `config` (a setting cannot be read) and `store` (the directory is refused). `POST /api/notifications/subscribe` takes `{ subscription }` as the browser gives it, and `POST /api/notifications/unsubscribe` takes `{ endpoint }`.

## The guard

The guard checks every v2 file except the app's web fonts (`app/public/fonts/*.woff2`) and its three icons (`app/public/icons/icon-192.png`, `icon-512.png` and `apple-touch-icon.png`, by exact name), which are binary; it says how many it left out, and any other binary file is refused. The guard reads its private-term fingerprint lists from a project's committed `.cleared/agents.conf` (`[guard] salt`, `terms`, `allowed`), as v1 does. This repository commits no such list, so by default, and in CI, `npm run guard` checks secrets, private keys, IBANs, credentials in URLs, email addresses and phone numbers, and no private terms; it says so when it runs. This is a known gap: closing it in CI needs a fingerprint list the guard can read there, either a committed guard configuration with its lists or lists provided to the workflow. To check private terms too, point it at a project whose committed configuration names its lists: `CLEARED_REPO=<project checkout> [ORCH_GUARD_REF=<ref>] npm run guard`.

## CI

`.github/workflows/v2.yml` runs on pull requests to `v2`: `npm ci`, `npm test`, `npx tsc --noEmit`, then the guard with `--base` set to the pull request's base branch.

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
