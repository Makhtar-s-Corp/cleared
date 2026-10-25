// The owner the setup assistant names (docs/v2/milestone-5-plan.md, section
// 5.2, lane v2-j5-assistant): the lock's settings read CLEARED_V2_OWNER_ID,
// which the settings file sets, when the project's file names no owner_id;
// a file that names one still wins.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLockConf } from '../../src/approval/conf.ts';

test('the owner comes from the settings when the file names none, and from the file when it does', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cleared-owner-conf-'));
  try {
    const none = join(dir, 'none.conf');
    writeFileSync(none, '[tracker]\nhuman_public_key = abc\n');
    assert.equal(readLockConf({ CLEARED_CONF: none, CLEARED_V2_OWNER_ID: 'alex' }).ownerId, 'alex');
    assert.equal(readLockConf({ CLEARED_CONF: none }).ownerId, undefined);
    const named = join(dir, 'named.conf');
    writeFileSync(named, '[tracker]\nowner_id = sam\n');
    assert.equal(readLockConf({ CLEARED_CONF: named, CLEARED_V2_OWNER_ID: 'alex' }).ownerId, 'sam');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
