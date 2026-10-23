// The free subnets of Docker's address pools (issue 265), as the doctor's
// pool section counts them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Docker } from '../../src/container/docker.ts';
import { DOCKER_DEFAULT_POOLS, interfaceSubnets, parseCidr, poolUsage, poolsOfDaemon, subnetsOf } from '../../src/container/pool.ts';
import { FakeDocker } from './fake-docker.ts';

test('Docker\'s default pools give 31 subnets: 15 of /16 in 172.17 to 172.31, 16 of /20 in 192.168', () => {
  const subnets = subnetsOf(DOCKER_DEFAULT_POOLS);
  assert.equal(subnets.length, 31);
  assert.equal(subnets[0], '172.17.0.0/16');
  assert.equal(subnets[14], '172.31.0.0/16');
  assert.equal(subnets[15], '192.168.0.0/20');
  assert.equal(subnets.at(-1), '192.168.240.0/20');
});

test('the pool of the issue: 29 of 31 taken leaves 2; every taken subnet, labelled or not, counts once', () => {
  const all = subnetsOf(DOCKER_DEFAULT_POOLS);
  const taken = all.slice(0, 29).map((cidr) => cidr.replace(/\.0\/(\d+)$/, '.1/$1'));   // a gateway's address and its prefix, as an interface shows it
  assert.deepEqual(poolUsage(DOCKER_DEFAULT_POOLS, [...taken, taken[0] as string, '10.0.0.5/8', '127.0.0.1/8']), { total: 31, taken: 29, free: 2 });
  assert.deepEqual(poolUsage(DOCKER_DEFAULT_POOLS, []), { total: 31, taken: 0, free: 31 });
});

test('daemon.json\'s default-address-pools replace the defaults; anything else keeps them', () => {
  assert.deepEqual(poolsOfDaemon('{"default-address-pools":[{"base":"10.200.0.0/16","size":24}]}'), [{ base: '10.200.0.0/16', size: 24 }]);
  assert.equal(subnetsOf(poolsOfDaemon('{"default-address-pools":[{"base":"10.200.0.0/16","size":24}]}') ?? []).length, 256);
  for (const text of ['', 'not json', '{}', '{"default-address-pools":[]}', '{"default-address-pools":[{"base":"10.0.0.0/16","size":8}]}']) assert.equal(poolsOfDaemon(text), undefined, text);
  assert.equal(parseCidr('300.1.1.1/8'), undefined);
  assert.deepEqual(parseCidr('172.18.0.1/16'), { start: (172 * 2 ** 24) + (18 * 2 ** 16), bits: 16 });
});

test('the host\'s interfaces give their IPv4 subnets, loopback and IPv6 left out', () => {
  assert.deepEqual(interfaceSubnets({
    lo: [{ family: 'IPv4', cidr: '127.0.0.1/8', internal: true }],
    docker0: [{ family: 'IPv4', cidr: '172.17.0.1/16', internal: false }, { family: 'IPv6', cidr: 'fe80::1/64', internal: false }],
    'br-1a2b': [{ family: 4, cidr: '172.18.0.1/16', internal: false }],
  }), ['172.17.0.1/16', '172.18.0.1/16']);
});

test('the labelled networks\' subnets: one labelled list, one inspection of what it returned; an unlabelled network is never named', async () => {
  const fake = new FakeDocker();
  fake.networks.push(
    { id: 'n1', name: 'cleared-v2-a', labels: { 'cleared.dev': 'v2' }, subnet: '172.20.0.0/16' },
    { id: 'n2', name: 'cleared-v2-a-out', labels: { 'cleared.dev': 'v2' }, subnet: '172.21.0.0/16' },
    { id: 'n3', name: 'someone-else', labels: {}, subnet: '172.22.0.0/16' },
  );
  assert.deepEqual(await new Docker(fake.runner).networkSubnets(), [{ name: 'cleared-v2-a', subnets: ['172.20.0.0/16'] }, { name: 'cleared-v2-a-out', subnets: ['172.21.0.0/16'] }]);
  assert.deepEqual(fake.calls.map((c) => c.args.join(' ')), ['network ls --no-trunc --filter label=cleared.dev=v2 --format {{json .}}', 'network inspect -- n1 n2']);
});
