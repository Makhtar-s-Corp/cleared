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
| `npm test` | Runs the unit tests with `node --test`. |
| `npx tsc --noEmit` | Type checks `src/`, `test/` and `scripts/` (`npm run typecheck` does the same). |
| `npm run guard` | Runs the repository's private terms and secrets guard (`lib/guard/codex-guard.mjs`) on every v2 file and the v2 workflow. `-- --base origin/v2` also checks the lines changed since that ref, in the guard's `--strict` diff mode. |

## Settings

| Variable | Default | Notes |
| --- | --- | --- |
| `CLEARED_V2_HOST` | `127.0.0.1` | This machine only. |
| `CLEARED_V2_PORT` | `8791` | Refused: 80 and 443 (the machine's public proxy, see [Decisions](../docs/concepts.md#decisions)), 8787 and 8788 (the v1 dashboard and app), 8790. A port already in use stops the service with a message. |

`GET /health` (and `HEAD`) answers `200` with `{"status":"ok"}`. Any other path is `404`; another method on `/health` is `405`; a request target the URL parser refuses (such as `//[`) is `400`.

## The guard

The guard reads its private-term fingerprint lists from a project's committed `.cleared/agents.conf` (`[guard] salt`, `terms`, `allowed`), as v1 does. This repository commits no such list, so by default, and in CI, `npm run guard` checks secrets, private keys, IBANs, credentials in URLs, email addresses and phone numbers, and no private terms; it says so when it runs. This is a known gap: closing it in CI needs a fingerprint list the guard can read there, either a committed guard configuration with its lists or lists provided to the workflow. To check private terms too, point it at a project whose committed configuration names its lists: `CLEARED_REPO=<project checkout> [ORCH_GUARD_REF=<ref>] npm run guard`.

## CI

`.github/workflows/v2.yml` runs on pull requests to `v2`: `npm ci`, `npm test`, `npx tsc --noEmit`, then the guard with `--base` set to the pull request's base branch.
