# Heartbeat and status

Cleared cannot notify anyone after its wake process stops. A push monitoring service can alert you when it stops receiving beats. The same beat reports known stalls while Cleared is still running.

## Set up a push monitor

1. Create a free push or heartbeat check in a service such as Healthchecks.io, Uptime Kuma, or Better Stack. Set its expected interval to one minute and choose a grace period appropriate for your host.
2. Copy its success URL into `[heartbeat] ping_url` in the project's tracked `.cleared/agents.conf`. If the service provides a failure URL, also set `fail_url`.
3. Commit the config, let `cleared-wake.timer` run, and verify one received ping and an alert route in the service. Test a missed beat using the service's own test feature.

No monitoring provider is required by Cleared. A successful wake calls `ping_url` once. A failed wake calls `fail_url` if configured. When a stall is detected, Cleared sends the failure URL only; its POST body contains stable problem codes such as `lane_idle`, never ticket text, response bodies, paths, credentials, or URLs. Without `fail_url`, the service detects the missing success ping. Both URLs are credentials: keep the project config and logs access controlled. The configured URL is never written to the ledger.

## `cleared status`

Run `CLEARED_REPO=/path/to/project /path/to/cleared/cleared status` under the Cleared service account. It shows the last wake and lead run, tracker and GitHub reachability, open lanes, tickets waiting on the owner, the most recent subscription reading, the release watch, and one line per problem. It exits with code 1 when problems exist or when status cannot be read. The tracker and forge probes have a timeout; the quota API is checked only if `[heartbeat] quota_url` is configured. A missing quota reading is displayed as such, not treated as an outage.

`cleared status --json` emits one JSON object, schema `1`. The stable top-level keys are `schema`, `project`, `checkedAt`, `ok`, `lastWake`, `lastLead`, `services`, `lanes`, `waiting`, `quota`, `watching`, and `problems`. Each problem has `code`, `id`, and `message`. The status command may include ticket titles for the local operator; those titles are never sent to the push monitor.

Cleared records each continuous problem once in the ledger. A late wake means more than three configured timer intervals since the last completed wake. Pending changes mean the wake saw tracker or forge changes but no lead action followed for 30 minutes. A service outage is reported after 10 minutes, a lane without branch or ledger movement after two hours, and a Cleared session or watch process unattached to an open lane or active watch after six hours. Thresholds are configurable in `[heartbeat]`.

`cleared status --reap` sends SIGTERM only to verified, old, unattached Cleared session, wait, or watch processes. It is available only with the local tracker, separate agent and human Unix accounts, and the configured human owner account. It never runs during an ordinary wake. A process can be reaped only if its command still identifies it as a Cleared process. If the agents and owner share a Unix account, the operating system cannot distinguish them and reaping is unavailable.
