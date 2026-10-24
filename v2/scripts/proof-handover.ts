// The step of the milestone 3 proof that hands a stuck Claude session over to
// Codex from the app (matrix B6.3p), as decisions a driver can take from the
// service's own answers: when a session may be handed over, what to ask for,
// and what the ticket's sessions must show afterwards. The real run, with a
// real Claude Code and a real Codex account, is the owner's; this file and its
// test (test/scripts/proof-handover.test.ts) are what a simulated run, with
// fakes only, checks beforehand.
import type { SessionSummary } from '../src/api/types.ts';

const ENDED: readonly string[] = ['done', 'stopped', 'failed'];

export type HandoverDecision =
  | { readonly kind: 'hand_over'; readonly session: string; readonly body: { readonly harness: 'codex' } }
  | { readonly kind: 'wait'; readonly reason: string }
  | { readonly kind: 'refuse'; readonly reason: string };

// A session is stuck when its author waits for a person: a permission or a
// question nobody has answered. A session at work is not stuck, and a taken
// over one is the owner's.
export function handoverDecision(sessions: readonly Pick<SessionSummary, 'id' | 'role' | 'harness' | 'phase' | 'takenOver'>[]): HandoverDecision {
  const authors = sessions.filter((s) => s.role === 'author' && !ENDED.includes(s.phase));
  const author = authors.at(-1);
  if (!author) return { kind: 'refuse', reason: 'no author session is live: there is nothing to hand over' };
  if (author.harness === 'codex') return { kind: 'refuse', reason: `the live author ${author.id} already runs on Codex` };
  if (author.harness !== 'claude-code') return { kind: 'refuse', reason: `the live author ${author.id} runs on ${author.harness}, which stays out of the flows` };
  if (author.takenOver) return { kind: 'refuse', reason: `the live author ${author.id} is taken over: give it back first` };
  if (author.phase !== 'waiting_human') return { kind: 'wait', reason: `the Claude author ${author.id} is ${author.phase}: only a session that waits for a person is stuck` };
  return { kind: 'hand_over', session: author.id, body: { harness: 'codex' } };
}

export type HandoverReport = { readonly ok: boolean; readonly lines: readonly string[] };

// What the ticket's sessions show once the Codex author has finished: the
// Claude author stopped, a Codex author after it, and the review done by
// Claude, the harness that did not write the change.
export function handoverReport(sessions: readonly Pick<SessionSummary, 'id' | 'role' | 'harness' | 'phase'>[]): HandoverReport {
  const authors = sessions.filter((s) => s.role === 'author');
  const reviewers = sessions.filter((s) => s.role === 'reviewer');
  const claude = authors.find((s) => s.harness === 'claude-code');
  const codex = authors.find((s) => s.harness === 'codex');
  const lines: string[] = [];
  let ok = true;
  const check = (passed: boolean, said: string, failed: string): void => {
    lines.push(passed ? `ok: ${said}` : `FAILED: ${failed}`);
    if (!passed) ok = false;
  };
  check(claude?.phase === 'stopped', 'the Claude author was stopped by the handover', `the Claude author is ${claude?.phase ?? 'missing'}, not stopped`);
  check(codex !== undefined, 'a Codex author took the ticket over', 'no Codex author session exists');
  check(codex?.phase === 'done', 'the Codex author finished its work', `the Codex author is ${codex?.phase ?? 'missing'}, not done`);
  const review = reviewers.at(-1);
  check(review?.harness === 'claude-code', 'the review was done by Claude, not by the harness that wrote the change', `the reviewer ran on ${review?.harness ?? 'nothing'}`);
  return { ok, lines };
}
