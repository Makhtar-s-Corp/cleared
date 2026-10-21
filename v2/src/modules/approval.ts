// The approval module (lane 8, approval and lock): the approval route and its
// Undo, the signer behind them, the review recorder merge-pr.sh reads. It
// fills the approvalWriter and reviewRecorder slots; the signing key is read
// by this process alone (plan, decision 6).
import { approvalEnvironment, APPROVAL_TABLES } from '../approval/service.ts';
import { approvalRoutes } from '../approval/route.ts';
import type { Module } from './registry.ts';

const approval: Module = {
  tables: APPROVAL_TABLES,
  routes: approvalRoutes,
  provide: ({ store }) => {
    const { approvalWriter, reviewRecorder } = approvalEnvironment(store.db);
    return { approvalWriter, reviewRecorder };
  },
};

export default approval;
