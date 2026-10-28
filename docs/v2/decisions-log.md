# Cleared v2: decisions log

**New entries go at the end of [decisions-log-milestone-6.md](decisions-log-milestone-6.md)**, the current milestone's file. When a new milestone starts, its first entry opens `decisions-log-milestone-<N>.md` and adds a line to the table below. This page only lists the files and holds no entry.

Each entry has a date, the decision as it was taken, and its consequences for this repository. Until 2026-10-28 the log was this one page. It grew to 1.4 MB, so it was split into one file per milestone by lane `v2-j6-decisions-log-split` (issue #478). No entry was edited, moved or reordered: the files, read in order, are the old page byte for byte, and `v2/test/decisions-log.test.ts` checks that against the SHA-256 of the old page and checks every link of these files.

| Milestone | File | Dates | Entries | From |
| --- | --- | --- | --- | --- |
| 1 | [decisions-log-milestone-1.md](decisions-log-milestone-1.md) | 2026-10-21 | 35 | the log's first heading and its preamble |
| 2 | [decisions-log-milestone-2.md](decisions-log-milestone-2.md) | 2026-10-22 to 2026-10-23 | 81 | "Fable 5.1 used once to plan milestone 2" |
| 3 | [decisions-log-milestone-3.md](decisions-log-milestone-3.md) | 2026-10-23 to 2026-10-25 | 68 | "Cursor harness on the session adapter contract", lane `j3-cursor-harness` |
| 4 | [decisions-log-milestone-4.md](decisions-log-milestone-4.md) | 2026-10-25 | 12 | "the tickets mirrored on GitHub Issues and Linear", lane `v2-j4-issue-mirrors` |
| 5 | [decisions-log-milestone-5.md](decisions-log-milestone-5.md) | 2026-10-25 to 2026-10-27 | 17 | "milestone 5's plan", lane `v2-j5-plan` |
| 6 | [decisions-log-milestone-6.md](decisions-log-milestone-6.md) | from 2026-10-28 | open | "the heavy captures compressed", lane `v2-j6-png-compress` |

A file starts at the first entry written for its milestone and runs to the entry before the next file's first. The entries kept their order, so a few late entries of an earlier milestone stay where they were written: the four entries of 2026-10-25 from lanes `j2-i18n-audit`, `j2-plan-schedules`, `j2-matrix-audit` and `j2-knowledge` (milestone 2's gaps) are in the milestone 3 file.

The files sit next to this page, not in a folder of their own, because the entries' relative links (`milestone-2-plan.md`, `../adapters.md` and over a hundred others) resolve from `docs/v2/`, and moving a file down a folder would break them or require editing the entries.
