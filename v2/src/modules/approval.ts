// The approval module (lane 8, approval and lock): the approval route and its
// Undo, the signer behind them, the review recorder merge-pr.ts reads. It
// fills the approvalWriter and reviewRecorder slots; the signing key is read
// by this process alone (plan, decision 6).
// A workspace of several services approves its tickets as release trains
// (lane 16): the routes then go through the train approvals.
import { approvalEnvironment, APPROVAL_TABLES, trainApprovals, type TrainApprovals } from '../approval/service.ts';
import { createApprovalRoutes } from '../approval/route.ts';
import { TRAIN_TABLE } from '../release/store.ts';
import type { Module } from './registry.ts';

let trains: TrainApprovals | undefined;

const approval: Module = {
  tables: [...APPROVAL_TABLES, TRAIN_TABLE],
  routes: createApprovalRoutes(() => trains),
  provide: ({ store }) => {
    const { approvalWriter, reviewRecorder } = approvalEnvironment(store.db);
    trains = trainApprovals(store.db);
    return { approvalWriter, reviewRecorder };
  },
};

export default approval;
