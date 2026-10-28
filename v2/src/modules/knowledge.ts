// The knowledge module (docs/v2/milestone-2-plan.md, decision 27, lane 24):
// a handover's lessons and decisions proposed as inbox items, Approve and
// Reject, and the skill of each service, kept in its tables
// (knowledge/store.ts). When a workspace is set (CLEARED_V2_WORKSPACE or
// CLEARED_V2_PROJECT, as the flow reads it), it starts with the service, or
// once the flow runs on the one the assistant writes later (issue #420): it
// listens to the stored handovers (workspace/handover.ts) and ticks for the
// daily skill tickets, with no request to the API, as the notify module
// does. Its tickets are written in
// the tickets module's store, which approval/service.ts keeps one of per
// ledger.
import { approvalEnvironment } from '../approval/service.ts';
import { FlowConfigError, loadFlowConfig, workspaceOf } from '../flow/config.ts';
import { runtime as flowRuntime } from '../flow/runtime.ts';
import { InboxStore } from '../inbox/store.ts';
import { knowledgeRoutes } from '../knowledge/routes.ts';
import { Knowledge } from '../knowledge/service.ts';
import { KNOWLEDGE_TABLES } from '../knowledge/store.ts';
import { cleanText, secretValues } from '../session/clean.ts';
import type { Store } from '../store/db.ts';
import { setHandoverSink } from '../workspace/handover.ts';
import type { Module } from './registry.ts';

export type KnowledgeModuleOptions = {
  readonly env: NodeJS.ProcessEnv;
  readonly intervalMs?: number;
};

export type KnowledgeModule = Module & { knowledge(): Knowledge | undefined };

export function createKnowledgeModule(options: KnowledgeModuleOptions): KnowledgeModule {
  const { env } = options;
  let knowledge: Knowledge | undefined;
  // Made and started when the settings name a workspace; false while they name none.
  function build(store: Store): boolean {
    let config;
    try {
      config = loadFlowConfig(env);
    } catch (error) {
      // The tickets module has said why and stopped the service.
      if (!(error instanceof FlowConfigError)) throw error;
      return true;
    }
    if (!config) return false;
    const workspace = workspaceOf(config);
    const servicePaths = [...new Set([env.CLEARED_V2_STATE_DIR, env.HOME, config.projectDir, config.workdirRoot].filter((p): p is string => !!p && p !== '/'))];
    const approval = approvalEnvironment(store.db, env);
    knowledge = new Knowledge({
      db: store.db, inbox: new InboxStore(store.db), tickets: approval.ticketStore, workspace,
      memory: { project: config.projectDir, env }, ownerId: approval.conf.ownerId,
      clean: (text) => cleanText(text, { secrets: secretValues(env), servicePaths }),
      serviceOf: (session) => store.sessions.get(session)?.service,
    });
    const listening = knowledge;
    setHandoverSink((handover) => { listening.propose(handover); });
    knowledge.startTimer(options.intervalMs);
    return true;
  }
  return {
    tables: KNOWLEDGE_TABLES,
    routes: knowledgeRoutes({
      knowledge: () => knowledge,
      proof: () => flowRuntime.proof(),
      start: async (registry, ticket, by) => { await flowRuntime.engine(registry)?.start(ticket, by); },
    }),
    provide: ({ store }) => {
      if (knowledge) return {};
      if (!build(store)) flowRuntime.whenEngine(() => { if (!knowledge) build(store); });
      return {};
    },
    knowledge: () => knowledge,
  };
}

const knowledge: KnowledgeModule = createKnowledgeModule({ env: process.env });

export default knowledge;
