# Roadmap

Cleared is an alpha maintained around one real project. The items below are directions for contributors, not commitments or claims that these features already work.

- **Memory.** Keep a concise, inspectable record of project decisions and prior findings for new agent sessions. The ledger records actions and outcomes today; it is not a general agent memory.
- **Cockpit.** Make the static dashboard more useful for humans reviewing active teams, approvals, queues, cost, and host health. The current page is read-only and generated from the ledger.
- **OpenCode.** Add an adapter that follows the same list-models, version, run, talk, report, and permission contract as Claude Code and Codex.
- **Ticket tracker contract.** Separate the ticket API from Linear-specific scripts so another tracker can supply tickets, comments, owner identity, and status transitions without weakening approval checks.
- **Terminal adapter.** Open and manage team sessions without Orca. Today Orca provides automatic terminals and readable worktree names; without it, a team can be prepared but the terminal must be run by hand.
- **Broader project support.** Remove assumptions about Node projects, `CLAUDE.md`, and example capture paths where the project supplies its own workflow. Keep documented French ticket commands usable where the parser supports them.

Small changes should arrive with a focused issue, a test for behavior, and a review from someone other than the author. See [Contributing](../CONTRIBUTING.md).
