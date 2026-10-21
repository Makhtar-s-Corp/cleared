# Guestbook, the demo project of Cleared v2

A web page that lists guestbook entries and adds one, on Postgres. Cleared v2's milestone 1 takes one ticket on this project from Todo to live, entirely in sessions (`docs/v2/milestone-1-plan.md` in the Cleared repository, lane 3). The project is meant to live in a repository of its own, seeded from this directory; until that repository exists, it lives here.

- `node:http`, no framework. The `pg` package is the only runtime dependency: Node has no Postgres client. `typescript`, `@types/node` and `@types/pg` are needed only for `npm run typecheck`.
- TypeScript run by Node's type stripping (Node 24), with no build step and erasable syntax only.

## Routes

| Route | What it does |
| --- | --- |
| `GET /` | The page: the entries, oldest first, then the form. |
| `POST /entries` | Adds an entry from the form (`name` up to 80 characters, `message` up to 500). Answers 303 to `/` when stored, or 400 with the page and the error when a field is empty or too long. Answers 415 for a body that is not a form, and 413 for a body over 16 KiB. |
| `GET /health` | `200 {"status":"ok"}` while the database answers within 2 seconds, else `503 {"status":"unavailable"}`. |

One table, `entries (id, name, message, created_at)`, which the app creates if it is missing when it starts.

## Run it

```sh
npm ci
DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres npm start
```

`HOST` defaults to `127.0.0.1` and `PORT` to `8793`. Ports 80, 443, 8787, 8788 and 8790 are refused.

## Tests

The tests need a Postgres database in `DATABASE_URL`. Each test file works in a schema of its own, which it drops at the end. Without `DATABASE_URL` the database tests fail; they do not skip. For example, with a throwaway container on a loopback port that `ss -ltn` shows free:

```sh
docker run -d --name cleared-v2-guestbook-test --label cleared.dev=v2 --label cleared.example=guestbook \
  -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1:55432:5432 postgres:16
DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres npm test
npm run typecheck
docker rm -f $(docker ps -aq --filter label=cleared.dev=v2 --filter label=cleared.example=guestbook --filter name=cleared-v2-guestbook-test)
```

The CI workflow, `.github/workflows/checks.yml`, does the same with a Postgres service container. GitHub runs it once this directory is the root of a repository.

## The deployment: `deploy/watch.ts`

The watcher stands in for a deployment system. It polls the base branch of a clone of the guestbook's repository. When the head moves, it builds that exact commit into an image and replaces the app container. The commit reaches the build through `git archive`, so the build never uses a working tree. A merge therefore goes live, and the revert of a rollback brings the previous version back.

```sh
node deploy/watch.ts --repo /path/to/clone [--remote origin] [--branch main] [--interval 30] [--once]
```

- The app container publishes `127.0.0.1:8793` only. Inside the container the app listens on `0.0.0.0`, which the published port needs.
- The database is a `postgres:16` container on a network of their own, with a named volume. It publishes no port, and it is not recreated on a deploy.
- Every object the watcher creates carries the labels `cleared.dev=v2` and `cleared.example=guestbook`. It only stops, starts or removes an id that a listing filtered on both labels returned.
- A build that fails leaves the running app as it is. A failed build or start is not retried until the head moves again.
- Each tick prints one JSON line: `deployed`, `unchanged`, `build-failed`, `run-failed`, `skipped-failed` or `port-busy`, with the commit.
- Stopping the watcher leaves the app running. To remove everything it created:

```sh
docker rm -f $(docker ps -aq --filter label=cleared.dev=v2 --filter label=cleared.example=guestbook)
docker network rm $(docker network ls -q --filter label=cleared.dev=v2 --filter label=cleared.example=guestbook)
docker volume rm $(docker volume ls -q --filter label=cleared.dev=v2 --filter label=cleared.example=guestbook)
```

## The Cleared settings: `.cleared/agents.conf`

The local tracker with its six states. The release watch probes `http://127.0.0.1:8793/health` for 3 minutes after a merge, and reverts the merge after two failed probes in a row. `[security] allow_shared_uid = true` follows decision 7 of the plan. The `[session]` section is read by the v2 service only: the session image, the `postgres:16` test service, `DATABASE_URL` for the session, the commands a session may run without asking, and the hosts the egress proxy lets through. The tracker's identity keys (`agents_uid`, `owner_id`, `human_public_key`) are written at setup, on the machine that runs the demo.

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
