import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ApprovalSigner, SigningKeyError, approvalPayload, generateKeyPair } from '../../src/approval/signer.ts';
import { approvalContext, readApprovalRecord, sameVersions } from '../../src/approval/record.ts';
import { keyPair, scratch } from './harness.ts';

const head = (c: string) => c.repeat(40);

test('a signed payload is the one the local tracker verifies: [number, status, at, actor, context, content hash]', () => {
  assert.equal(approvalPayload(1, 'Ready to Ship', '2026-10-21T10:00:00.000Z', 'demo', 'abc', null), '[1,"Ready to Ship","2026-10-21T10:00:00.000Z","demo","abc",null]');
  const keys = keyPair();
  const dir = scratch('cleared-v2-signer-');
  const file = join(dir, 'key');
  writeFileSync(file, keys.privatePem, { mode: 0o600 });
  const signer = ApprovalSigner.load(file);
  const proof = signer.sign('payload');
  assert.equal(verify(null, Buffer.from('payload'), createPublicKey(Buffer.from(keys.publicKey, 'base64')), Buffer.from(proof, 'base64')), true);
  assert.equal(signer.publicKey, keys.publicKey, 'the public key is the base64 of the PEM, as [tracker] human_public_key holds it');
});

test('a key file that others can read, a link, a directory or a missing file is refused', () => {
  const dir = scratch('cleared-v2-signer-');
  const keys = keyPair();
  const open = join(dir, 'open');
  writeFileSync(open, keys.privatePem, { mode: 0o644 });
  chmodSync(open, 0o644);
  assert.throws(() => ApprovalSigner.load(open), SigningKeyError);
  assert.throws(() => ApprovalSigner.load(open), /mode 600/);
  const real = join(dir, 'real');
  writeFileSync(real, keys.privatePem, { mode: 0o600 });
  symlinkSync(real, join(dir, 'link'));
  assert.throws(() => ApprovalSigner.load(join(dir, 'link')), SigningKeyError);
  assert.throws(() => ApprovalSigner.load(dir), SigningKeyError);
  assert.throws(() => ApprovalSigner.load(join(dir, 'nothing')), SigningKeyError);
  const text = join(dir, 'text');
  writeFileSync(text, 'not a key', { mode: 0o600 });
  assert.throws(() => ApprovalSigner.load(text), SigningKeyError);
  const rsa = join(dir, 'rsa');
  writeFileSync(rsa, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  assert.throws(() => ApprovalSigner.load(rsa), /not an Ed25519 key/);
});

test('the context is sha256 of [ticket, at, versions sorted by pr, each as {pr, head}], as local.mjs computes it', () => {
  const versions = [{ pr: 9, head: head('b') }, { pr: 3, head: head('a') }];
  const expected = spawnSync(process.execPath, ['-e', `
    const { createHash } = require('node:crypto');
    const v = JSON.parse(process.argv[1]).map(({ pr, head }) => ({ pr, head })).sort((a, b) => a.pr - b.pr);
    process.stdout.write(createHash('sha256').update(JSON.stringify(['LOCAL-1', '2026-10-21T10:00:00.000000000Z', v])).digest('hex'));`, JSON.stringify(versions)], { encoding: 'utf8' }).stdout;
  assert.equal(approvalContext('LOCAL-1', '2026-10-21T10:00:00.000000000Z', versions), expected);
  assert.equal(approvalContext('LOCAL-1', '2026-10-21T10:00:00.000000000Z', [versions[1]!, versions[0]!]), expected, 'the order given does not matter');
  assert.notEqual(approvalContext('LOCAL-1', '2026-10-21T10:00:01.000000000Z', versions), expected);
  assert.notEqual(approvalContext('LOCAL-1', '2026-10-21T10:00:00.000000000Z', [{ pr: 3, head: head('c') }, versions[0]!]), expected);
});

test('the record ask-validation.ts keeps is read as lib/validation-record.mjs reads it, and nothing else is', () => {
  const state = scratch('cleared-v2-record-');
  const write = (text: string) => { writeFileSync(join(state, 'validations', 'LOCAL-1.json'), text); };
  assert.equal(readApprovalRecord(state, 'LOCAL-1'), undefined, 'none kept');
  mkdirSync(join(state, 'validations'), { recursive: true });
  write(JSON.stringify({ ticket: 'LOCAL-1', at: '2026-10-21T10:00:00.123456789Z', pulls: [{ pr: 9, head: head('b'), merged_at: null }, { pr: 3, head: head('a') }] }));
  assert.deepEqual(readApprovalRecord(state, 'LOCAL-1'), { at: '2026-10-21T10:00:00.123456789Z', versions: [{ pr: 3, head: head('a') }, { pr: 9, head: head('b') }] });
  for (const bad of [
    { ticket: 'LOCAL-2', at: '2026-10-21T10:00:00Z', pulls: [{ pr: 3, head: head('a') }] },
    { ticket: 'LOCAL-1', at: 'yesterday', pulls: [{ pr: 3, head: head('a') }] },
    { ticket: 'LOCAL-1', at: '2026-10-21T10:00:00Z', pulls: [] },
    { ticket: 'LOCAL-1', at: '2026-10-21T10:00:00Z', pulls: [{ pr: 3, head: 'abc' }] },
    { ticket: 'LOCAL-1', at: '2026-10-21T10:00:00Z', pulls: [{ pr: 3, head: head('a') }, { pr: 3, head: head('b') }] },
  ]) {
    write(JSON.stringify(bad));
    assert.equal(readApprovalRecord(state, 'LOCAL-1'), undefined, JSON.stringify(bad));
  }
  write('{');
  assert.equal(readApprovalRecord(state, 'LOCAL-1'), undefined);
  assert.equal(readApprovalRecord(state, '../LOCAL-1'), undefined);
});

test('sameVersions compares the pull requests and their heads, in order', () => {
  assert.equal(sameVersions([{ pr: 1, head: head('a') }], [{ pr: 1, head: head('a') }]), true);
  assert.equal(sameVersions([{ pr: 1, head: head('a') }], [{ pr: 1, head: head('b') }]), false);
  assert.equal(sameVersions([{ pr: 1, head: head('a') }], []), false);
  assert.equal(sameVersions([{ pr: 1, head: head('a') }], undefined as never), false);
});

test('setup writes a new key pair (mode 600, never over a key) and prints the public key and the settings, not the private key', () => {
  const dir = scratch('cleared-v2-setup-');
  const file = join(dir, 'nested', 'approval.key');
  const setup = new URL('../../src/cli/setup.ts', import.meta.url).pathname;
  const run = () => spawnSync(process.execPath, [setup, '--key', file, '--owner', 'demo'], { encoding: 'utf8' });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, 'nested')).mode & 0o777, 0o700);
  const privatePem = readFileSync(file, 'utf8');
  assert.match(privatePem, new RegExp(`BEGIN ${'PRIVATE'} KEY`));
  assert.ok(!first.stdout.includes('PRIVATE') && !first.stderr.includes('PRIVATE') && !first.stdout.includes(privatePem.split('\n')[1]!), 'the private key is never printed');
  const printed = /human_public_key = (\S+)/.exec(first.stdout)?.[1] ?? '';
  assert.equal(ApprovalSigner.load(file).publicKey, printed);
  assert.match(first.stdout, /owner_id = demo/);
  assert.match(first.stdout, new RegExp(`agents_uid = ${process.getuid?.()}`));
  assert.match(first.stdout, /human_user = /);
  assert.match(first.stdout, /allow_shared_uid = true/);
  const second = run();
  assert.notEqual(second.status, 0, 'a key is never overwritten');
  assert.match(second.stderr, /already exists/);
  assert.equal(readFileSync(file, 'utf8'), privatePem);
  assert.deepEqual(Object.keys(generateKeyPair()).sort(), ['privatePem', 'publicKey']);
  const bad = spawnSync(process.execPath, [setup, '--key', file, '--owner', userInfo().username], { encoding: 'utf8' });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /owner_id must differ/);
  assert.ok(!existsSync(join(dir, 'nested', 'approval.key.part')));
});
