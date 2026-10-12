# Roadmap

Cleared is an alpha for developers, maintained around one real project. It aims to work with as many coding harnesses as practical. The items below are directions for contributors, not commitments or claims that these features already work.

- **Memory.** Keep a concise, inspectable record of project decisions and prior findings for new agent sessions. The ledger records actions and outcomes today; it is not a general agent memory.
- **Cleared app.** Build an app for developers to review active teams, approvals, queues, cost, and host health. Today's static dashboard is read-only and generated from the ledger.
- **More coding harnesses.** Add OpenCode, Gemini CLI, and Copilot CLI adapters alongside today's Claude Code and Codex CLI adapters, following the documented adapter contract.
- **Review with one subscription.** When another model is available, use it for review. Otherwise, allow a fresh session on the same subscription without the author's context. Today the reviewer must use a different model.
- **Ticket tracker adapters.** Improve the first Linear, GitHub Issues, and local SQLite adapters, especially pagination, capture review, and offline use. GitHub remains the only forge; GitLab and Gitea are outside this contract.
- **Terminal adapter.** Support Orca, tmux, and no terminal so Cleared can run without a graphical terminal. Today Orca provides automatic terminals and readable worktree names; without it, a team can be prepared but the terminal must be run by hand.
- **Broader project support.** Remove assumptions about Node projects, `CLAUDE.md`, and example capture paths where the project supplies its own workflow. Keep documented French ticket commands usable where the parser supports them.

Small changes should arrive with a focused issue, a test for behavior, and a review from someone other than the author. See [Contributing](../CONTRIBUTING.md).
