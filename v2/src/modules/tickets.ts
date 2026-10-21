// The tickets module (lane 8, approval and lock): the TicketStore on the local
// tracker's tables in ledger.db, so ids, states and signatures are the ones
// tracker.sh and merge-pr.sh read. The ticket routes of the API are lane 7's.
import { approvalEnvironment } from '../approval/service.ts';
import { TICKET_TABLES } from '../tickets/local-store.ts';
import type { Module } from './registry.ts';

const tickets: Module = {
  tables: TICKET_TABLES,
  routes: [],
  provide: ({ store }) => ({ ticketStore: approvalEnvironment(store.db).ticketStore }),
};

export default tickets;
