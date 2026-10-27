// Issue #432: the assistant makes the approval key and names the owner, and
// no step asks the person to commit the public half to a repository that
// is not even linked yet. The service checks the owner's signed rows with
// the public half of the key it holds when the project's agents.conf names
// none; a key the file names still wins.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { approvalEnvironment, APPROVAL_TABLES, TICKET_TABLES } from '../../src/approval/service.ts';
import { generateKeyPair } from '../../src/approval/signer.ts';
import { SqliteUsers, USERS_TABLE } from '../../src/modules/users.ts';
import { makeApprovalKey } from '../../src/setup/approval-key.ts';
import { applyTables } from '../../src/store/db.ts';

const FAST = { algorithm: 'argon2id', memory: 64, passes: 1, parallelism: 1, saltLength: 16, tagLength: 32 } as const;

async function owned(conf: string) {
  const state = mkdtempSync(join(tmpdir(), 'cleared-approval-env-'));
  const db = new DatabaseSync(join(state, 'ledger.db'));
  applyTables(db, [USERS_TABLE, ...TICKET_TABLES, ...APPROVAL_TABLES]);
  const user = await new SqliteUsers(db, { params: FAST }).add('alex', 'a long passphrase for the owner');
  const key = join(state, 'approval.key');
  const { publicKey } = makeApprovalKey(key);
  const file = join(state, 'agents.conf');
  writeFileSync(file, conf);
  const env: NodeJS.ProcessEnv = { CLEARED_STATE_DIR: state, CLEARED_V2_STATE_DIR: state, CLEARED_CONF: file, CLEARED_V2_APPROVAL_KEY: key, CLEARED_V2_OWNER_ID: 'alex' };
  const { ticketStore } = approvalEnvironment(db, env);
  const ticket = await ticketStore.create({ title: 'The heading says hello', project: 'guestbook' }, { kind: 'human', id: user.id });
  const history = await ticketStore.history(ticket.id);
  return { publicKey, kind: history[0]?.by.kind, close: () => { db.close(); rmSync(state, { recursive: true, force: true }); } };
}

test('the owner\'s rows are checked with the key the service holds when the project\'s file names none', async () => {
  const { kind, close } = await owned('[tracker]\n');
  try { assert.equal(kind, 'human'); } finally { close(); }
});

test('a public key the project\'s file names still wins over the one the service holds', async () => {
  const other = generateKeyPair().publicKey;
  const { kind, close } = await owned(`[tracker]\nhuman_public_key = ${other}\n`);
  try { assert.equal(kind, 'other', 'signed with the service\'s key, checked with the file\'s: not the owner\'s'); } finally { close(); }
});

// P249's open point, with issue #420: on a fresh install the service starts
// before the owner exists. The assistant then makes the key and names the
// owner while it runs, and the approval reads them at its next need, with
// no restart; once both are there they are kept.
test('a key made and an owner named after the service started are used at the next approval, with no restart', async () => {
  const state = mkdtempSync(join(tmpdir(), 'cleared-approval-later-'));
  const db = new DatabaseSync(join(state, 'ledger.db'));
  try {
    applyTables(db, [USERS_TABLE, ...TICKET_TABLES, ...APPROVAL_TABLES]);
    const file = join(state, 'agents.conf');
    writeFileSync(file, '[tracker]\n');
    const key = join(state, 'approval.key');
    const env: NodeJS.ProcessEnv = { CLEARED_STATE_DIR: state, CLEARED_V2_STATE_DIR: state, CLEARED_CONF: file, CLEARED_V2_APPROVAL_KEY: key };
    const error = console.error;
    console.error = () => undefined;
    let environment;
    try { environment = approvalEnvironment(db, env); } finally { console.error = error; }
    const { ticketStore } = environment;
    assert.equal(ticketStore.canSign, false, 'no key, no owner yet');
    const user = await new SqliteUsers(db, { params: FAST }).add('alex', 'a long passphrase for the owner');
    makeApprovalKey(key);
    env.CLEARED_V2_OWNER_ID = 'alex';                       // what refreshSettings sets from the file the app wrote
    assert.equal(ticketStore.canSign, true, 'read again at the next need');
    const ticket = await ticketStore.create({ title: 'The heading says hello', project: 'guestbook' }, { kind: 'human', id: user.id });
    assert.equal((await ticketStore.history(ticket.id))[0]?.by.kind, 'human', 'signed with the new key, checked with its public half');
    delete env.CLEARED_V2_OWNER_ID;
    assert.equal(ticketStore.canSign, true, 'kept once complete');
  } finally {
    db.close();
    rmSync(state, { recursive: true, force: true });
  }
});
