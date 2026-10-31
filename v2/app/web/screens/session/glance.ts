// The session in five seconds (the owner's request of 2026-10-31, issue #499).
// Written after its tests' first run: test/session/glance.test.ts.
import type { NextInboxItem, SessionPlan } from '../../../../src/api/types.ts';
import type { Ticket } from '../../../../src/tickets/contract.ts';
import type { Translate } from '../../lib/i18n.ts';
import type { QuestionRow, RequestState, SessionView, ToolRow } from './model.ts';

export type PendingAction = { readonly total: number } & (
  | { readonly kind: 'permission'; readonly session: string; readonly requestId: string; readonly row: ToolRow; readonly request: RequestState }
  | { readonly kind: 'question'; readonly session: string; readonly requestId: string; readonly row: QuestionRow }
  | { readonly kind: 'plan'; readonly session: string; readonly plan: SessionPlan }
  | { readonly kind: 'review'; readonly href: string; readonly pr?: PullRequest }
  | { readonly kind: 'giveback' }
);
export type PullRequest = { readonly number: number; readonly url: string };
export type Stage = { readonly key: string; readonly state: 'done' | 'current' | 'failed' | 'todo' };
export type StageView = { readonly stages: readonly Stage[]; readonly current: number; readonly total: number };
export type Capture = { readonly kind: 'before' | 'after' | 'production'; readonly service: string; readonly href: string };
export type Result = { readonly pr?: PullRequest; readonly captures: readonly Capture[] };
export type ServiceHome = { readonly name: string; readonly url: string };

const later = (): never => { throw new Error('not written yet'); };
export const pendingAction = (_view: SessionView, _inbox: readonly NextInboxItem[]): PendingAction | null => later();
export const doingNow = (_view: SessionView, _t: Translate): string => later();
export const stageOf = (_view: SessionView, _inbox: readonly NextInboxItem[]): StageView | null => later();
export const planSteps = (_plan: SessionPlan): string[] => later();
export const sessionFacts = (_view: SessionView, _t: Translate): { readonly duration: string; readonly cost?: string } => later();
export const pullRequestOf = (_ticket: Ticket | undefined, _services: readonly ServiceHome[], _inbox: readonly NextInboxItem[]): PullRequest | undefined => later();
export const resultOf = (_view: SessionView, _services: readonly ServiceHome[], _inbox: readonly NextInboxItem[]): Result | null => later();
