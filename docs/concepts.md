# Concepts and lifecycle

Cleared is a set of scripts around a Git repository and a configured ticket tracker. A model can write code and prose, but scripts decide what happens next. Each operation is checked against GitHub, the tracker, git, the host, and the SQLite ledger.

## Team (lane)

A team is a Git worktree and a branch such as `dev/EX-12`. `spawn-lane.sh` chooses a configured model, opens the worktree, and starts the session through the terminal adapter named by `[terminal] adapter`: an Orca terminal by default, or `none`, a detached session with no terminal. Either way, the harness runs under `[security] agent_user` when it is set. The team receives the ticket and user comments as quoted data. It can commit on its branch; Cleared pushes and opens a draft pull request after the session, whose description carries the team's report to the user (Done, Remaining work, Questions for the user) as the team wrote it, without any path of the machine, read by the guard first and left out if refused. `flow-lanes.sh` reopens it for failed checks, reviewer findings, a changed base, or a new user comment. A ticket can have two independent teams when its owner writes `Teams: both` or the French equivalent. The owner then chooses `Team 1` or `Team 2` on the ticket.

A team's role is a permission and routing profile, not a different program. Example roles are `dev`, `mechanical`, `review`, `release`, `talk`, and `writing`. `[roles]` picks an alias; `[rules]` can override it using ticket labels, ticket project, changed paths, or pull request size. `[fallbacks]` applies only when a model cannot start. A model failure does not silently try another model. `[review] differs_from_author` prevents a model from reviewing its own change. The release role observes events and asks for work through scripts; it has no authority to bypass those scripts.

## Ticket states and approval

The names are configured in `[tracker]`. A typical path is `Todo` → `In Progress` → `In Review` → `Needs Approval` → `Ready to Ship` → `Done`. A ticket moved to Todo can open a team. Once checks pass and a different model has reviewed its pull request, the release broker posts a product-language request showing the exact commit and moves the ticket to the validation state. The owner personally moves it to the configured go state to approve shipping. the release broker checks who moved the ticket and whether the reviewed commit is still the version shown. If a team changed its code after the request, Cleared asks again. A merge of the base that changes no team code can retain approval. For two teams, only the selected pull request can ship.

Paths under `[merge] tooling_paths` may merge without a ticket approval once review and checks pass. This is a real exception to the normal human approval step; configure the list narrowly. Paths under `guarded_paths`, including the scripts that enforce shipping, always require the owner's own approval. These rules classify paths; they never let a model grant itself approval.

## Ledger

The SQLite database lives under `~/.local/state/cleared/<project>/ledger.db` by default. `runs` records the selected and actual model, provider, role, worktree, times, outcome, token counts, estimated cost, pull request, and human decision data. `events` records routing changes, wakes, limits, reviews, refusals, merge events, and failures. Scripts write the ledger; agents do not. For example:

```sh
CLEARED_REPO=/path/to/project node lib/ledger.ts sql 'select model, count(*), sum(cost_eur) from runs group by model'
```

Agents can search the v2 sessions and their events through a read-only MCP server that removes secrets from every answer; give an agent this line to install it: `claude mcp add cleared-ledger -e CLEARED_STATE_DIR=<folder of ledger.db> -- node <cleared checkout>/v2/src/cli/ledger-mcp.ts` ([details](../v2/README.md#the-ledgers-mcp-server)).

CLI-reported cost is used when available. Otherwise `[prices]` and `[currency]` estimate it; if no price is known, the value stays empty. API list prices allow comparison between models, but they are not a claim about what a subscription charged. The dashboard is a static page built from this ledger and current host readings.

## Limits and queues

`[limits] max_lanes` caps simultaneous counted teams. Subscription percentages and the per-ticket cost cap can delay or stop openings. A standalone `Cap 80` (or `Plafond 80`) line on a ticket changes that ticket's cap. Reviews and merges that cannot run yet wait in queues and are retried by the wake. The project lead's short sessions are triggered by configured events; other events wait for the next useful session. `tidy-lanes.sh` closes idle or finished worktrees only after checking whether the branch still holds work that must be kept.

## Decisions

- **2026-10-17: the installation never publishes on ports 80 and 443, nor on a port already in use, and checks it before writing anything** (issue #112). 80 and 443 belong to the machine's public reverse proxy: `tailscale serve` on its default port held 443 on the Tailscale address, and after a reboot the proxy could not bind `0.0.0.0:443`, which kept production offline for six hours. In a container or WSL, where the cgroup has no `user@UID.service`, the installer cannot recognise the unit of the running app as its own: it refuses that port, so stop the unit first or pass a free port.
  `serve/install.sh` refuses those ports (also as the port of `[app] public_origin` or of the `tailscale serve` command it prints) and any port another process listens on, before its first write, and stops when it cannot read the listening ports; no setting turns this off.
  The port of an https `public_origin` (the one `tailscale serve` is told to publish) is checked as in use too: the one holder accepted is `tailscaled` (named by `ss`, or by `/proc/<pid>/comm`), or, since it runs as root and cannot be named without root, a holder of another account on a Tailscale address whose port `tailscale serve status` lists; anything else, or a holder it cannot tell from it, is refused with the `sudo ss -ltnp` command that names it.
  The notification link (`CLEARED_NOTIFY_LINK_BASE`, and the legacy `ORCH_NOTIFY_LINK_BASE`) is checked in the installer's shell and in the `Environment=` lines of the drop-ins of `cleared-wake.service` and `cleared-app.service` (read as text as systemd reads them, the last assignment winning, never evaluated; a drop-in it cannot read refuses): a value that is not `http(s)://host[:port]`, scheme in any case, or whose port is 80 or 443 (`HTTPS://host` included) is refused.

## Commands in daily use

- `spawn-lane.sh dev EX-12 --dry-run` shows routing before opening anything.
- `spawn-lane.sh dev EX-12` opens a team and starts its session.
- `review-pr.sh 41 EX-12` opens a separate read-only review.
- `ask-validation.sh EX-12 request.md --pr 41` shows the user the commit to approve.
- `release-request.ts request_release EX-12 41 < announcement.md` asks the local broker to verify and ship.
- `dashboard.sh` rewrites the static dashboard page.

For command flags and settings, use [Configuration](configuration.md), [Adapters](adapters.md), and [Security](security.md).
