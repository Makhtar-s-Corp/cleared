// The owner step's approval key (docs/v2/milestone-5-plan.md, section 5.2,
// lane v2-j5-assistant): made as `npm run setup` makes it, once, mode 600,
// never over a key that exists; its public key shown with where it goes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalSigner } from '../../src/approval/signer.ts';
import { approvalKeyPath, makeApprovalKey } from '../../src/setup/approval-key.ts';
import { PASSWORD, startSetup } from './support.ts';

test('the key is made once, mode 600; made again, the one there is kept and its public key given', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cleared-key-'));
  try {
    const path = join(dir, 'approval.key');
    const first = makeApprovalKey(path);
    assert.equal(first.existed, false);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(ApprovalSigner.load(path).publicKey, first.publicKey);
    const before = readFileSync(path, 'utf8');
    const second = makeApprovalKey(path);
    assert.equal(second.existed, true);
    assert.equal(second.publicKey, first.publicKey);
    assert.equal(readFileSync(path, 'utf8'), before, 'never overwritten');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the key\'s place: CLEARED_V2_APPROVAL_KEY, else approval.key in the state folder, as the approval service reads it', () => {
  assert.equal(approvalKeyPath({ CLEARED_STATE_DIR: '/srv/state' }), '/srv/state/approval.key');
  assert.equal(approvalKeyPath({ CLEARED_STATE_DIR: '/srv/state', CLEARED_V2_APPROVAL_KEY: '/keys/a.key' }), '/keys/a.key');
});

test('the owner step answers the owner\'s name and the public key, with the setting it goes in', async () => {
  const service = await startSetup();
  try {
    const alex = await service.directory.add('alex', PASSWORD);
    const none = await service.call('/api/setup/owner', { user: alex.id });
    assert.equal(none.status, 200);
    assert.deepEqual(none.json, { name: 'alex', publicKey: null, setting: 'human_public_key' });
    const made = makeApprovalKey(join(service.dir, 'approval.key'));
    const view = await service.call('/api/setup/owner', { user: alex.id });
    assert.equal(view.json.publicKey, made.publicKey);
    assert.ok(!view.text.includes('PRIVATE'), 'never the private key');
  } finally { await service.close(); }
});
