# Heartbeat and status

Cleared cannot notify anyone after its wake process stops. A push monitoring service can alert you when it stops receiving beats. The same beat reports known stalls while Cleared is still running.

## Set up a push monitor

1. Create a free push or heartbeat check in a service such as Healthchecks.io, Uptime Kuma, or Better Stack. Set its expected interval to one minute and choose a grace period appropriate for your host.
2. Save its success and optional failure URLs in regular files outside the project, owned by the Cleared service account and mode `0600`. Set `[heartbeat] ping_url_file` and `fail_url_file` in the project's tracked `.cleared/agents.conf`. A private repository may instead use `ping_url` and `fail_url` directly. URLs must use HTTPS except on loopback.
3. Commit the config, let `cleared-wake.timer` run, and verify one received ping and an alert route in the service. Test a missed beat using the service's own test feature.

No monitoring provider is required by Cleared. A successful wake calls the success URL once. A failed wake calls the failure URL if configured. When a stall is detected, Cleared sends the failure URL only; its POST body contains stable problem codes such as `lane_idle`, never ticket text, response bodies, paths, credentials, or URLs. Without a failure URL, the service detects the missing success ping. Both URLs are credentials: keep the private files and logs access controlled. The configured URL is never written to the ledger. An agent running under the same Unix account can read those files and spoof a heartbeat; use an independent monitoring check if that threat matters.

## `cleared status`

Run `CLEARED_REPO=/path/to/project /path/to/cleared/cleared status` under the Cleared service account. It shows the last wake and lead run, tracker and GitHub reachability, the identity the forge calls use (`as <app login>` with a GitHub App in [`[forge]`](configuration.md#forge), otherwise `ambient credential`), open lanes, tickets waiting on the owner, the most recent subscription reading, the release watch, and one line per problem. It exits with code 1 when problems exist and code 2 when status cannot be collected. The tracker and forge probes have a timeout; the quota API is checked only if `[heartbeat] quota_url` or `quota_url_file` is configured. A missing quota reading is displayed as such, not treated as an outage. With a GitHub App, the forge probe mints or reuses its installation token and lists the installation's repositories, which only that token can do; a token that cannot be had is the `forge_credential` problem, whose message names the setting to check. Run `--reap` as the separate human account described below.

`cleared status --json` emits one JSON object, schema `1`. The stable top-level keys are `schema`, `project`, `checkedAt`, `ok`, `lastWake`, `lastLead`, `services`, `lanes`, `waiting`, `quota`, `watching`, and `problems`. `services.forge.identity` is `{ "kind": "app", "login", "commits" }`, `{ "kind": "ambient" }`, or `{ "kind": "error" }`. Each problem has `code`, `id`, and `message`. The status command may include ticket titles for the local operator; those titles are never sent to the push monitor.

Cleared records each continuous problem once in the ledger. A late wake means more than three configured timer intervals since the last completed wake. Pending changes mean the wake saw actionable tracker or forge changes but no lead session followed for 30 minutes. A service outage is reported after 10 minutes, an active lane session without branch or ledger movement after two hours, and a Cleared session or watch process unattached to an open lane or active watch after six hours. A lead session past `[lead] max_minutes` is also reported. Thresholds are configurable in `[heartbeat]`. Sessions started with `[terminal] adapter = none` are checked the same way: the run folder's `pid` file names the detached session process.

`cleared status --reap` sends SIGTERM only to verified, old, unattached Cleared session, wait, or watch processes. Run it through `sudo` as root, supplying `CLEARED_REPO` and `CLEARED_STATE_DIR` for the service account's project and state; Cleared checks that the state belongs to that project. The caller recorded by sudo must be a separate human Unix account from the Cleared service. With the local tracker, `[tracker] owner_id` must match sudo's original username; with a remote tracker, set `[heartbeat] reap_owner_uid` to the human account's numeric UID. Deny sudo access to the Cleared service account. Reaping never runs during an ordinary wake. A process can be reaped only if its command still identifies it as a Cleared process. If the agents and owner share a Unix account, the operating system cannot distinguish them and reaping is unavailable.

```sh
sudo CLEARED_REPO=/path/to/project CLEARED_STATE_DIR=/home/cleared/.local/state/cleared/project /path/to/cleared/cleared status --reap
```
