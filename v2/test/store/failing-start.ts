// A start whose migration after the real ones throws, as main.ts starts: the store opened,
// then the modules' tables created by applyTables, which runs the migrations.
//   node failing-start.ts <ledger.db>
import approval from '../../src/modules/approval.ts';
import flow from '../../src/modules/flow.ts';
import inbox from '../../src/modules/inbox.ts';
import lead from '../../src/modules/lead.ts';
import notify from '../../src/modules/notify.ts';
import sessions from '../../src/modules/sessions.ts';
import tickets from '../../src/modules/tickets.ts';
import users from '../../src/modules/users.ts';
import { applyTables, openStore } from '../../src/store/db.ts';
import { MIGRATIONS } from '../../src/store/migrations.ts';

const store = openStore(process.argv[2] as string);
const planted = { version: MIGRATIONS.length + 1, name: 'planted', tables: ['sessions'], up: () => { throw new Error('planted failure'); } };
applyTables(store.db, [sessions, users, tickets, flow, approval, inbox, lead, notify].flatMap((module) => module.tables), [...MIGRATIONS, planted]);
console.log('not reached');
