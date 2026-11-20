// -----------------------------------------------------------------------------
// The client and the model on the answers shaped after the Incus API
// (test/fixtures/incus): envelopes, projects, CPU limits, addresses, errors.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERROR_KINDS, IncusClient, IncusError, OPERATIONS } from '../src/incus/client.js';
import {
  cpuLimit,
  cpuPercent,
  cpuThreads,
  mainAddress,
  parseSnapshot,
  totals,
} from '../src/incus/model.js';
import { FakeIncus, fixture } from './helpers/fakeIncus.js';

const client = (incus) => new IncusClient({ request: incus.createTransport({}) });

test('reads the server, every instance of every project, and the CPU threads', async () => {
  const incus = new FakeIncus();
  const raw = await client(incus).read();
  assert.equal(raw.cpuThreads, 8);
  const snapshot = parseSnapshot(raw);
  assert.equal(snapshot.product, 'Incus');
  assert.equal(snapshot.version, '6.18');
  assert.deepEqual(
    snapshot.instances.map((i) => [i.project, i.name, i.type, i.status, i.running, i.address]),
    [
      ['default', 'broken', 'container', 'Error', false, null],
      ['lab', 'nextcloud', 'container', 'Running', true, '192.0.2.102'],
      ['default', 'paused', 'container', 'Frozen', false, null],
      ['default', 'web', 'container', 'Running', true, '192.0.2.101'],
      ['default', 'windows', 'virtual-machine', 'Stopped', false, null],
    ],
  );
  const nextcloud = snapshot.instances.find((i) => i.name === 'nextcloud');
  assert.equal(nextcloud.cpuThreads, 2, 'limits.cpu');
  assert.equal(nextcloud.memoryBytes, 536870912);
  assert.deepEqual(totals(snapshot), { total: 5, running: 2 });
  assert.deepEqual(incus.calls, [
    'GET /1.0',
    'GET /1.0/instances?recursion=2&all-projects=true',
    'GET /1.0/resources',
  ]);
});

test('CPU limits, addresses and percentages', () => {
  assert.equal(cpuLimit({ 'limits.cpu': '4' }, 8), 4);
  assert.equal(cpuLimit({ 'limits.cpu': '0-3' }, 8), 4);
  assert.equal(cpuLimit({ 'limits.cpu': '1,3,5-6' }, 8), 4);
  assert.equal(cpuLimit({ 'limits.cpu': 'weird' }, 8), 8);
  assert.equal(cpuLimit({}, 8), 8);
  assert.equal(cpuLimit({}, null), null);
  // allocated_time first, then one vCPU for an unlimited VM.
  const vm = { type: 'virtual-machine', expanded_config: {} };
  assert.equal(cpuThreads(vm, { cpu: { allocated_time: 0 } }, 16), 1);
  assert.equal(cpuThreads(vm, { cpu: { allocated_time: 4e9 } }, 16), 4);
  const ct = { type: 'container', expanded_config: { 'limits.cpu': '4' } };
  assert.equal(cpuThreads(ct, { cpu: { allocated_time: 5e8 } }, 16), 0.5, 'CFS allowance');
  assert.equal(cpuThreads(ct, {}, 16), 4);
  const network = fixture('instances').metadata[0].state.network;
  assert.equal(mainAddress(network), '192.0.2.101');
  assert.equal(
    mainAddress({
      eth0: { addresses: [{ family: 'inet6', address: '2001:db8::5', scope: 'global' }] },
    }),
    '2001:db8::5',
  );
  assert.equal(mainAddress(null), null);
  const at = (cpuNs, ms, cpuThreads = 2) => ({ cpuNs, at: ms, cpuThreads });
  assert.equal(cpuPercent(null, at(1e9, 1000)), null);
  assert.equal(cpuPercent(at(0, 0), at(1e9, 1000)), 50);
  assert.equal(cpuPercent(at(0, 0), at(5e9, 1000)), 100, 'capped');
  assert.equal(cpuPercent(at(5e9, 0), at(1e9, 1000)), null, 'counter reset by a restart');
  assert.equal(cpuPercent(at(0, 0), at(1e9, 1000, null)), 100, 'one thread when unknown');
});

const kindOf = async (promise) => {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof IncusError, err.message);
    return err.kind;
  }
  return 'resolved';
};

test('errors are sorted by kind', async () => {
  const incus = new FakeIncus();
  incus.trusted = false;
  assert.equal(await kindOf(client(incus).read()), ERROR_KINDS.UNTRUSTED);
  assert.equal(await kindOf(client(incus).trust('bm90IGEgdG9rZW4=')), ERROR_KINDS.TOKEN_REFUSED);
  incus.trusted = true;
  incus.failure = 'html';
  assert.equal(await kindOf(client(incus).read()), ERROR_KINDS.NOT_INCUS);
  incus.failure = 'down';
  assert.equal(await kindOf(client(incus).read()), ERROR_KINDS.UNREACHABLE);
  incus.failure = null;
  const c = client(incus);
  assert.equal(await kindOf(c.control('ghost', 'default', 'start')), ERROR_KINDS.NOT_FOUND);
  assert.equal(await kindOf(c.control('web', 'default', 'start')), ERROR_KINDS.REFUSED);
  await assert.rejects(c.control('web', 'default', 'explode'), TypeError);
});

test('an operation is waited for, and its failure carries the message of Incus', async () => {
  const incus = new FakeIncus();
  const c = client(incus);
  await c.control('windows', 'default', OPERATIONS.START);
  assert.equal(incus.instance('windows').status, 'Running');
  incus.refuse.set('windows', 'Failed shutting down instance: context deadline exceeded');
  let error;
  try {
    await c.control('windows', 'default', OPERATIONS.STOP);
  } catch (err) {
    error = err;
  }
  assert.equal(error.kind, ERROR_KINDS.REFUSED);
  assert.match(error.cause, /context deadline exceeded/);
  assert.deepEqual(incus.calls.slice(-2), [
    'PUT /1.0/instances/windows/state?project=default',
    'GET /1.0/operations/7c5d2f1e-3a4b-4c6d-8e9f-0a1b2c3d4e5f/wait?timeout=60',
  ]);
});
