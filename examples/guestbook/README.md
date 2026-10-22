# Guestbook, the demo project of Cleared v2

A web page that lists guestbook entries and adds one, on Postgres. Cleared v2's milestone 1 takes one ticket on this project from Todo to live, entirely in sessions (`docs/v2/milestone-1-plan.md` in the Cleared repository, lane 3). The project is meant to live in a repository of its own, seeded from this directory; until that repository exists, it lives here.

- `node:http`, no framework. The `pg` package is the only runtime dependency: Node has no Postgres client. `typescript`, `@types/node` and `@types/pg` are needed only for `npm run typecheck`.
- TypeScript run by Node's type stripping (Node 24), with no build step and erasable syntax only.

## Routes

| Route | What it does |
| --- | --- |
| `GET /` | The page: the entries, oldest first, then the form. |
| `POST /entries` | Adds an entry from the form (`name` up to 80 characters, `message` up to 500). Answers 303 to `/` when stored, or 400 with the page and the error when a field is empty or too long. Answers 415 for a body that is not a form, and 413 for a body over 16 KiB. With a filter (`FILTER_URL`), the entry is checked first: one it refuses is 400 with the words it names, and when the filter fails or takes more than 2 seconds the entry is 503 and not stored. |
| `GET /health` | `200 {"status":"ok"}` while the database answers within 2 seconds, else `503 {"status":"unavailable"}`. It never calls the filter. With `PROOF_BREAK_HEALTH` on, `503 {"status":"broken","reason":"PROOF_BREAK_HEALTH"}`. |

One table, `entries (id, name, message, created_at)`, which the app creates if it is missing when it starts.

## Run it

```sh
npm ci
DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres npm start
```

`HOST` defaults to `127.0.0.1` and `PORT` to `8793`. Ports 80, 443, 8787, 8788 and 8790 are refused.

## The filter API, when `FILTER_URL` is set

The guestbook consumes the filter API (`examples/filter-api/` in the Cleared repository, its own repository for the demo): with `FILTER_URL` set to its address, for example `http://127.0.0.1:8795`, every entry is sent to its `POST /check` as `{"text": "<name>\n<message>"}` before it is stored. Unset, the filter is never called, as before. Nothing is stored unchecked: a filter that answers anything but its contract's `200 {"ok", "words"}`, or nothing within 2 seconds, makes the entry a 503 with the form kept. `FILTER_URL` is an http or https address with no credentials, no query and no fragment. The deploy watcher passes no `FILTER_URL` to the app it runs.

## The proof's switch: `PROOF_BREAK_HEALTH`

`PROOF_BREAK_HEALTH` in `src/config.ts` is `false` as committed. The multi-service proof's second ticket sets it to `true` in a change of its own: once that change is deployed, `/health` answers 503 and the release watch rolls the guestbook back. `PROOF_BREAK_HEALTH=1` in the environment turns it on by hand. Nothing else changes: the page and the form still work.

## Tests

The tests need a Postgres database in `DATABASE_URL`. The filter's tests run a fake filter API of their own (`test/helpers/fake-filter.ts`) on a port the system picks. Each test file works in a schema of its own, which it drops at the end. Without `DATABASE_URL` the database tests fail; they do not skip. For example, with a throwaway container on a loopback port that `ss -ltn` shows free:

```sh
docker run -d --name cleared-v2-guestbook-test --label cleared.dev=v2 --label cleared.example=guestbook \
  -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1:55432:5432 postgres:16
DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres npm test
npm run typecheck
docker ps -aq --filter label=cleared.dev=v2 --filter label=cleared.example=guestbook --filter name=cleared-v2-guestbook-test | xargs -r docker rm -f
```

The CI workflow, `.github/workflows/checks.yml`, does the same with a Postgres service container. GitHub runs it once this directory is the root of a repository. In the Cleared repository, `.github/workflows/examples.yml` runs the same steps for both examples.

## The deployment: `deploy/watch.ts`

The watcher stands in for a deployment system. It polls the base branch of a clone of the guestbook's repository. When the head moves, it builds that exact commit into an image and replaces the app container. The commit reaches the build through `git archive`, so the build never uses a working tree. A merge therefore goes live, and the revert of a rollback brings the previous version back.

```sh
node deploy/watch.ts --repo /path/to/clone [--remote origin] [--branch main] [--interval 30] [--once]
```

- The app container publishes `127.0.0.1:8793` only. Inside the container the app listens on `0.0.0.0`, which the published port needs.
- The database is a `postgres:16` container on a network of their own, with a named volume. It publishes no port, and it is not recreated on a deploy.
- Every object the watcher creates carries the labels `cleared.dev=v2` and `cleared.example=guestbook`. It only stops, starts or removes an id that a listing filtered on both labels returned.
- A build that fails leaves the running app as it is. A start that fails comes after the old app container was removed, so no app runs until the head moves again: `/health` then fails, and the release watch rolls the merge back. A failed build or start is not retried until the head moves, and neither is an app of the head that crash-loops (Docker shows it `restarting`).
- From a merge to the new version answering: at most one poll (30 seconds by default), then the build and the start, measured at 4 seconds at most on the demo machine with the base image in Docker's build cache.
- Each tick prints one JSON line: `deployed`, `unchanged`, `build-failed`, `run-failed`, `skipped-failed` or `port-busy`, with the commit.
- Stopping the watcher leaves the app running. To remove everything it created:

```sh
docker ps -aq --filter label=cleared.dev=v2 --filter label=cleared.example=guestbook | xargs -r docker rm -f
docker network ls -q --filter label=cleared.dev=v2 --filter label=cleared.example=guestbook | xargs -r docker network rm
docker volume ls -q --filter label=cleared.dev=v2 --filter label=cleared.example=guestbook | xargs -r docker volume rm
docker image ls -q --filter label=cleared.dev=v2 --filter label=cleared.example=guestbook | sort -u | xargs -r docker image rm
```

## The Cleared settings: `.cleared/agents.conf`

The local tracker with its six states. The release watch probes `http://127.0.0.1:8793/health` every 30 seconds from minute 2 to minute 5 after a merge, and reverts the merge after two failed probes in a row. `[security] allow_shared_uid = true` follows decision 7 of the plan. The `[session]` section is read by the v2 service only: the session image, the `postgres:16` test service, `DATABASE_URL` for the session, the commands a session may run without asking, and the hosts the egress proxy lets through. The tracker's identity keys (`agents_uid`, `owner_id`, `human_public_key`) are written at setup, on the machine that runs the demo.

## The demo ticket

The owner creates this ticket in the Cleared app, then moves it to Todo. It changes one line of `src/store.ts` and the test that states the order, in `test/store.test.ts`.

> **Title:** The guestbook shows the newest entry first
>
> **Description:** The page lists the entries oldest first, so a new entry lands at the bottom, out of sight once the list is long. Show the newest entry at the top.
>
> **Acceptance criteria:**
> - The page lists the entries from the newest to the oldest.
> - A test adds three entries one after the other and checks that the list gives them back newest first.
> - `npm test` and `npm run typecheck` pass.

## The proof's tickets, with the filter API

Cleared v2's multi-service proof (`docs/v2/milestone-2-plan.md` in the Cleared repository, section 2.2) runs in a workspace of two services, the guestbook and the filter API (`examples/workspace.conf` there). The owner creates these three tickets in the Cleared app, in that order, naming the services each one touches.

**Ticket 1**, on the guestbook and the filter API:

> **Title:** An entry the filter flags is held for review instead of refused
>
> **Description:** Today an entry with a word of the filter's list is refused, and the visitor loses it. The filter API's `POST /check` should also answer a `severity`: `none` when `ok` is true, `review` otherwise. The guestbook stores an entry whose severity is `review` as held: it is not shown on the page, and the visitor reads that the entry waits for review.
>
> **Acceptance criteria:**
> - `contract/openapi.yaml` of the filter API gives `severity` in the answer of `POST /check`, with its examples, and the contract test passes.
> - The filter API answers `severity`, with a test for each value.
> - The guestbook stores a flagged entry as held and leaves it off the page, with a test using a fake filter.
> - `npm test` and `npm run typecheck` pass in both projects.

**Ticket 2**, on the guestbook and the filter API, the proof's provoked failure:

> **Title:** The filter refuses "casino", and the guestbook's refusal lists the words in bold
>
> **Description:** Add `casino` to the filter API's `words.txt`. In the guestbook, show each word of a refusal in bold. This ticket also sets `PROOF_BREAK_HEALTH` to `true` in the guestbook's `src/config.ts`: it is the proof's provoked failure, and the guestbook's release must be rolled back.
>
> **Acceptance criteria:**
> - The filter API refuses a text holding "Casino", with a test.
> - The guestbook's refusal shows each word in `<strong>`, with a test.
> - `PROOF_BREAK_HEALTH` is `true` in the guestbook's `src/config.ts`, and its config test says so.
> - `npm test` and `npm run typecheck` pass in both projects.

**Ticket 3**, on the filter API only:

> **Title:** The filter API answers where each word was found
>
> **Description:** `POST /check` also answers `positions`: for each word found, the character offsets where it starts in the text. Change the contract and the app; the guestbook is not part of this ticket.
>
> **Acceptance criteria:**
> - `contract/openapi.yaml` gives `positions` in the answer of `POST /check`, with its examples, and the contract test passes.
> - `npm test` and `npm run typecheck` pass.

The third ticket changes the contract the guestbook consumes without a step on the guestbook, so Cleared blocks its release card before approval and proposes to extend the ticket to the guestbook or keep the contract backward compatible.
