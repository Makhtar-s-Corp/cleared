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

`v2/app` is the web app: the sign-in page, the shell (project, Tower, Inbox with its count, Sessions, Tickets, the signed-in person, the clock, the theme button) and the screens. It holds no key and signs nothing. Every request a signed-in person makes to `/api/service/*` goes to the service on loopback as `/api/*`, with the person's id and the app's proof, and with nothing of the browser's cookie or anti-forgery token. Design: [`app/DESIGN.md`](../app/DESIGN.md), with the Geist fonts served by the app itself.

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
- Five wrong passwords from one address, or for one name, within 15 minutes block that address or name for the rest of the 15 minutes. During the block, even the right password gets `429`.
- A write needs the session, its anti-forgery token in `X-CSRF-Token` (from `GET /api/me`) and the app's own origin.
- A request for another host name gets `421`.
- The pages load nothing inline and nothing from another site.

Each screen is `app/public/screens/<screen>.ts`, with its words in `app/messages/<screen>.en.json` and `.fr.json`. The browser gets the TypeScript with its types stripped. The session and inbox screens are stubs that lanes 9 and 10 fill.

## The guard

The guard checks every v2 file except the app's web fonts (`app/public/fonts/*.woff2`), which are binary; it says how many it left out, and any other binary file is refused. The guard reads its private-term fingerprint lists from a project's committed `.cleared/agents.conf` (`[guard] salt`, `terms`, `allowed`), as v1 does. This repository commits no such list, so by default, and in CI, `npm run guard` checks secrets, private keys, IBANs, credentials in URLs, email addresses and phone numbers, and no private terms; it says so when it runs. This is a known gap: closing it in CI needs a fingerprint list the guard can read there, either a committed guard configuration with its lists or lists provided to the workflow. To check private terms too, point it at a project whose committed configuration names its lists: `CLEARED_REPO=<project checkout> [ORCH_GUARD_REF=<ref>] npm run guard`.

## CI

`.github/workflows/v2.yml` runs on pull requests to `v2`: `npm ci`, `npm test`, `npx tsc --noEmit`, then the guard with `--base` set to the pull request's base branch.
