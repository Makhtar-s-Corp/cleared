# Security boundaries

Cleared is alpha software that can read source code, create pull requests, and, after approval, merge them. Run it on a host and repository you control. It gives models narrower CLI permissions than the dispatcher, but those permissions are **not a sandbox**. A shell, model CLI, container, Git hook, or project test can still need operating-system isolation and independent review.

## Identities and approval

The ticket owner and the agent should have separate identities. `linear.sh` prefers `LINEAR_APP_CLIENT_ID` and `LINEAR_APP_CLIENT_SECRET` for an agent application, with a short-lived token kept under the state directory. `LINEAR_API_KEY` can be used to explore and open a test team, but `[merge] separate_identity = required` blocks unattended shipping when Cleared cannot distinguish the agent from the ticket owner. Store credentials in environment variables or an untracked `.env.local`; the scripts read only the values they need, and the model adapters remove known API keys from their environment. Authenticate `gh`, Claude Code, and/or Codex separately. Never put credentials in `agents.conf`, a prompt, a ticket, or a pull request.

For application and guarded paths, `merge-pr.sh` checks a reviewed commit, successful checks, the owner's own ticket move to the configured go state, and the exact version previously shown. A change touching only configured `[merge] tooling_paths` skips the ticket approval check, but still needs review and green checks. Keep that list narrow and protect the base branch in GitHub; a person with direct merge rights can bypass Cleared. The script serializes merges under a lock and rechecks before shipping. When code or a conflict resolution changes the approved version, ask again. A clean merge of the base that adds no team code can keep approval.

## Private-term guard

The guard scans text and diffs sent to Linear or GitHub. It compares normalized words against SHA-256 fingerprints of project-specific private terms. `[guard] salt` is stored in the **project's** `.cleared/agents.conf` (or legacy `.ferme/agents.conf`); installation generates a random value when missing. Fingerprint lists named by `[guard] terms` and `allowed` live in the project and are read from its remote base branch, not from the working team's editable files. `none` is valid for a project with no list, but removes that part of the check. The guard also checks common secret and sensitive-data patterns and rejects text it cannot read safely.

A fingerprint list is a screening rule, not encryption or a guarantee against disclosure. It cannot catch terms that were never listed, encoded or transformed data, or every form of secret. A model or process with unrestricted network or file access can bypass text scanning; isolate it with host permissions, containers, and repository rules appropriate to your project. Do not copy real private terms into this tool repository.

## Permissions and host access

`[permissions.<role>]` maps command prefixes and read paths to provider CLI controls. The project lead and reviewer should be read-only; development roles may edit their own worktrees. `when-free.sh` gates commands that compete for host resources, such as screen tests. This is scheduling, not isolation. Dependencies from the base lock file are installed by the dispatcher with `npm ci --ignore-scripts`; a team's new dependency waits for CI after its pull request. Review CI and deployment workflows as carefully as code: `[merge] guarded_paths` should include them and the Cleared lock scripts.

The optional dashboard contains ticket titles and host status. `serve/install.sh` binds it to the host's Tailscale address and verifies that only the page is served. Configure network access separately; `serve/check.sh` can also probe from an existing container when `CLEARED_CHECK_CONTAINER` is set. No container is required for the normal check. State and tokens are kept outside the repository under `~/.local/state/cleared/<project>/`; limit filesystem access to that directory.

## Reporting a vulnerability

Use the private GitHub vulnerability report described in [SECURITY.md](../SECURITY.md). Do not post exploit details, credentials, or private project data in a public issue. The scope includes approval and merge checks, identity checks, adapters, guard bypasses, the dashboard, state and token handling, and installation scripts.
