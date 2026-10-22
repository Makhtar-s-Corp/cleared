# Filter API, the second demo project of Cleared v2

A small web service that tells whether a text holds a word of its list. The guestbook (`examples/guestbook/` in the Cleared repository) consumes it: with `FILTER_URL` set, the guestbook checks every entry here before storing it. Together they make the two-service workspace of Cleared v2's multi-service proof (`docs/v2/milestone-2-plan.md` in the Cleared repository, section 2.2). The project lives in a repository of its own, seeded from that directory and kept in sync by hand.

- `node:http`, no framework, no runtime dependency. `typescript` and `@types/node` are needed only for `npm run typecheck`.
- TypeScript run by Node's type stripping (Node 24), with no build step and erasable syntax only.

## Routes

| Route | What it does |
| --- | --- |
| `POST /check` | Takes `{"text": "..."}` as JSON and answers `200 {"ok": true, "words": []}`, or `{"ok": false, "words": [...]}` naming each listed word found, once, in the order of the text. Answers 400 for a body that is not JSON or has no `text` string, 415 for a body not sent as `application/json`, and 413 for a body over 16 KiB. |
| `GET /health` | `200 {"status":"ok"}`. |

A word is a run of letters and digits, in any script. A listed word matches only as a whole word, whatever its case: `spam` matches "SPAM" and "spam-free", not "spammer".

The list is `words.txt`: one word per line, blank lines and `#` comments left out. A line that is not one word stops the app at its start, with the line number.

## The contract: `contract/openapi.yaml`

OpenAPI 3.1, one example per answer. Cleared builds a fake of this service from it for a ticket's trial environment: each operation answers its first example (`responses`, the first 2xx, `content`, `application/json`, then `example`, or the first entry of `examples` and its `value`), so the first answer of `POST /check` is an accepted text and a guestbook in a trial stores its entries. `test/contract.test.ts` sends each request example to the app and checks it gets the response example of the same name, so an example cannot say what the app does not.

The file keeps to a small block subset of YAML, which the test's reader (`test/helpers/yaml.ts`, no dependency) accepts and nothing more: two spaces per level, `key: value` and `key:` with a more indented block under it, sequences of scalars only (`- value`), plain, double-quoted or single-quoted scalars, `true`, `false`, `null`, whole numbers, the empty `[]` and `{}`, and comments on lines of their own. A value holding `: ` or ` #` is quoted.

## Run it

```sh
npm ci
npm start
```

`HOST` defaults to `127.0.0.1` and `PORT` to `8795`. Ports 80, 443, 8787, 8788 and 8790 to 8794 are refused.

## Tests

```sh
npm test
npm run typecheck
```

No database: the tests start the app on a port the system picks.

## The deployment: `deploy/watch.ts`

The guestbook's watcher, without the database. It polls the base branch of a clone of this repository; when the head moves, it builds that exact commit (from `git archive`, never a working tree) into an image and replaces the app container.

```sh
node deploy/watch.ts --repo /path/to/clone [--remote origin] [--branch main] [--interval 30] [--once]
```

- The app container publishes `127.0.0.1:8795` only. Inside the container the app listens on `0.0.0.0`, which the published port needs.
- Every object the watcher creates carries the labels `cleared.dev=v2` and `cleared.example=filter-api`. It only removes an id that a listing filtered on both labels returned, so it never touches the guestbook's objects.
- A build that fails leaves the running app as it is. A failed build or start is not retried until the head moves, and neither is an app of the head that crash-loops (Docker shows it `restarting`).
- Each tick prints one JSON line: `deployed`, `unchanged`, `build-failed`, `run-failed`, `skipped-failed` or `port-busy`, with the commit.
- Stopping the watcher leaves the app running. To remove everything it created:

```sh
docker ps -aq --filter label=cleared.dev=v2 --filter label=cleared.example=filter-api | xargs -r docker rm -f
docker image ls -q --filter label=cleared.dev=v2 --filter label=cleared.example=filter-api | sort -u | xargs -r docker image rm
```

## The Cleared settings: `.cleared/agents.conf`

The local tracker with its six states. The release watch probes `http://127.0.0.1:8795/health` every 30 seconds from minute 2 to minute 5 after a merge, and reverts the merge after two failed probes in a row: the guestbook's window. `[merge]` counts `contract/` and `words.txt` as code. The `[session]` section, read by the v2 service only, starts no test service: the filter API has no database.

## What the proof's tickets change

The owner creates three tickets in the Cleared app, in the two-service workspace of `examples/workspace.conf` in the Cleared repository; the guestbook's README gives their text.

1. **An entry the filter flags is held for review instead of refused.** Here: `contract/openapi.yaml` gains a `severity` in the answer of `POST /check`, validated by the owner first; the app answers it, with its tests. In the guestbook: an entry the filter flags is stored as held, not shown. The filter API lands first, then the guestbook.
2. **The provoked failure.** Here: a word added to `words.txt`, which changes no contract. In the guestbook: a change that also sets `PROOF_BREAK_HEALTH` to `true` in its `src/config.ts`, so the guestbook's `/health` answers 503 once deployed. The guestbook's watch fails twice and reverts the guestbook's merge; the train then reverts this repository's merge.
3. **A contract change with no step on the guestbook.** Here: `POST /check` also answers where each word was found, in the contract and the app, and the ticket names this service only. The release card is blocked before approval: the guestbook consumes this service and is not changed by the ticket.

`PROOF_BREAK_HEALTH` is the guestbook's switch, not this service's: it is `false` as committed, and `PROOF_BREAK_HEALTH=1` in the guestbook's environment turns it on by hand.
