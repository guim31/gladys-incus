// -----------------------------------------------------------------------------
// The hub against the SDK's fake Gladys and the fake Incus server (answers
// shaped after the Incus API): trust by token, certificate pin, discovery,
// states, CPU, the switch, the actions, the scene triggers, the persistence
// under /data, the logs and the own timer.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { GladysApiError } from '@gladysassistant/integration-sdk';
import { TRIGGERS } from '../src/hub.js';
import { ERROR_KINDS, IncusError } from '../src/incus/errors.js';
import { fixture, OTHER_FINGERPRINT, SERVER_FINGERPRINT } from './helpers/fakeIncus.js';
import {
  FakeIncus,
  baseConfig,
  createClock,
  createDevices,
  createWorld,
  hostId,
  instanceId,
  makeToken,
} from './helpers/world.js';

async function world(t, options = {}) {
  const result = await createWorld({ clock: createClock(), ...options });
  t.after(() => result.app.stop());
  return result;
}

const feature = (w, name, key, project) => `${instanceId(w.gladys, name, project)}:${key}`;
const host = (w, key) => `${hostId(w.gladys)}:${key}`;
const events = (w, key) => w.fake.sceneEvents.filter((event) => event.key === key);

/** The lines written at `LOG_LEVEL=info` from now on. */
function captureLogs(t) {
  const previous = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = 'info';
  const lines = [];
  for (const stream of ['log', 'error']) {
    t.mock.method(console, stream, (...args) => lines.push(args.join(' ')));
  }
  t.after(() => {
    process.env.LOG_LEVEL = previous;
  });
  return lines;
}

test('discovery proposes the server and every instance of every project', async (t) => {
  const w = await world(t);
  const devices = w.fake.discoveredDevices;
  assert.deepEqual(
    devices.map((d) => [d.name, d.model]),
    [
      ['Home server', 'Incus server'],
      ['broken', 'Incus container'],
      ['lab/nextcloud', 'Incus container'],
      ['paused', 'Incus container'],
      ['web', 'Incus container'],
      ['windows', 'Incus virtual machine'],
    ],
  );
  for (const device of devices) {
    assert.equal(device.should_poll, false);
    assert.equal(device.poll_frequency, undefined);
  }
  assert.match(instanceId(w.gladys, 'nextcloud', 'lab'), /:instance:lab\.nextcloud$/);
  const web = devices.find((d) => d.name === 'web');
  const running = web.features.find((f) => f.external_id.endsWith(':running'));
  assert.equal(running.category, 'switch');
  assert.equal(running.read_only, false);
  assert.equal(w.fake.states.length, 0, 'no state before a device is added');
  assert.deepEqual(w.fake.connectionStatus, { connected: true });
  assert.ok(w.incus.calls.includes('GET /1.0/instances?recursion=2&all-projects=true'));
});

test('adding a device publishes its states; CPU from two reads; a stop changes them', async (t) => {
  const w = await world(t);
  await createDevices(w);
  assert.equal(w.fake.lastState(host(w, 'reachable')), 1);
  assert.equal(w.fake.lastState(host(w, 'version')), 'Incus 6.18');
  assert.equal(w.fake.lastState(host(w, 'instances_running')), 2);
  assert.equal(w.fake.lastState(host(w, 'instances_total')), 5);
  assert.equal(w.fake.lastState(feature(w, 'web', 'running')), 1);
  assert.equal(w.fake.lastState(feature(w, 'web', 'memory')), 256);
  assert.equal(w.fake.lastState(feature(w, 'web', 'address')), '192.0.2.101');
  assert.equal(w.fake.lastState(feature(w, 'web', 'cpu')), undefined, 'one read: no CPU yet');
  assert.equal(w.fake.lastState(feature(w, 'paused', 'running')), 0);
  assert.ok(w.fake.widgetRefreshes.length > 0);

  // 30 s later: web used 6 s of CPU over 8 threads (2.5 %), nextcloud 15 s
  // over its limits.cpu of 2 (25 %).
  w.clock.advance(30_000);
  w.incus.instance('web').state.cpu.usage += 6e9;
  w.incus.instance('nextcloud', 'lab').state.cpu.usage += 15e9;
  await w.hub.pollNow();
  assert.equal(w.fake.lastState(feature(w, 'web', 'cpu')), 2.5);
  assert.equal(w.fake.lastState(feature(w, 'nextcloud', 'cpu', 'lab')), 25);

  w.incus.setStatus('web', 'Stopped');
  w.clock.advance(30_000);
  await w.hub.pollNow();
  assert.equal(w.fake.lastState(feature(w, 'web', 'running')), 0);
  assert.equal(w.fake.lastState(feature(w, 'web', 'cpu')), 0);
  assert.equal(w.fake.lastState(feature(w, 'web', 'memory')), 0);
  assert.equal(w.fake.lastState(host(w, 'instances_running')), 1);

  const before = w.fake.states.length;
  w.clock.advance(30_000);
  await w.hub.pollNow();
  assert.equal(w.fake.states.length, before, 'nothing changed, nothing published');
});

test('a token trusts the certificate once, pins the server, and is never sent again', async (t) => {
  const incus = new FakeIncus();
  incus.trusted = false;
  incus.tokenSecret = 'a1b2c3d4e5f6';
  const w = await world(t, { incus, config: baseConfig({ trust_token: makeToken() }) });
  assert.deepEqual(w.fake.connectionStatus, { connected: true });
  assert.equal(w.incus.calls.filter((c) => c === 'POST /1.0/certificates').length, 1);
  assert.equal(w.hub.pin, SERVER_FINGERPRINT);
  assert.equal(w.fake.discoveredDevices.length, 6);

  // The certificate removed on the server: the used token is tried once more,
  // refused, and not again.
  incus.trusted = false;
  w.clock.advance(60_000);
  await w.hub.pollNow();
  await w.hub.pollNow();
  assert.equal(w.incus.calls.filter((c) => c === 'POST /1.0/certificates').length, 2);
  assert.match(w.fake.connectionStatus.message.en, /token refused/);
  assert.match(w.fake.connectionStatus.message.fr, /jeton de confiance refusé/);

  // A new token: trusted again.
  incus.tokenSecret = 'ffeeddcc';
  await w.fake.configUpdated(baseConfig({ trust_token: makeToken({ secret: 'ffeeddcc' }) }));
  assert.deepEqual(w.fake.connectionStatus, { connected: true });
});

test('without a token, an untrusted Gladys says what to do', async (t) => {
  const incus = new FakeIncus();
  incus.trusted = false;
  const w = await world(t, { incus });
  assert.equal(w.fake.connectionStatus.connected, false);
  assert.match(w.fake.connectionStatus.message.en, /incus config trust add/);
  assert.ok(!w.incus.calls.some((c) => c.startsWith('POST')));
  const ack = await w.fake.action('test_connection', {});
  assert.equal(ack.success, false);
  assert.match(ack.error.fr, /pas encore autorisé/);
  const bad = await world(t, { config: baseConfig({ trust_token: 'not a token' }) });
  assert.match(bad.fake.connectionStatus.message.en, /Trust token not understood/);
});

test('another certificate than the pinned one: nothing sent, red until trusted again', async (t) => {
  const incus = new FakeIncus();
  incus.trusted = false;
  incus.tokenSecret = 'a1b2c3d4e5f6';
  // The token names another fingerprint than the one the server presents.
  const w = await world(t, {
    incus,
    config: baseConfig({ trust_token: makeToken({ fingerprint: OTHER_FINGERPRINT }) }),
  });
  assert.deepEqual(w.incus.calls, [], 'the token never left');
  assert.match(w.fake.connectionStatus.message.en, /server certificate changed/);
  await w.hub.pollNow();
  assert.equal(events(w, TRIGGERS.UNREACHABLE).length, 0, 'not an outage');

  // Trusted on first use, kept under /data.
  const fresh = await world(t);
  assert.equal(fresh.hub.pin, SERVER_FINGERPRINT);
  await fresh.hub.store.flush();
  const saved = JSON.parse(readFileSync(join(fresh.dataDir, 'incus-state.json'), 'utf8'));
  assert.equal(saved.pin, SERVER_FINGERPRINT);
  fresh.incus.fingerprint = OTHER_FINGERPRINT;
  await fresh.hub.pollNow();
  assert.equal(fresh.fake.connectionStatus.connected, false);
  let ack = await fresh.fake.action('test_connection', {});
  assert.match(ack.error.fr, /certificat du serveur a changé/);
  ack = await fresh.fake.action('trust_server_again', {});
  assert.equal(ack.success, true);
  assert.equal(fresh.hub.pin, OTHER_FINGERPRINT);
  assert.deepEqual(fresh.fake.connectionStatus, { connected: true });
});

test('the client certificate is created once under /data, its key private', async (t) => {
  const w = await world(t);
  const key = join(w.dataDir, 'client.key');
  assert.ok(existsSync(join(w.dataDir, 'client.crt')));
  assert.equal(statSync(key).mode & 0o777, 0o600);
  const first = w.hub.identity.fingerprint;
  await w.app.stop();
  const again = await world(t, { incus: w.incus, dataDir: w.dataDir });
  assert.equal(again.hub.identity.fingerprint, first);
  assert.equal(again.hub.pin, SERVER_FINGERPRINT, 'the pin survives a restart');
});

test('the switch starts and stops the instance, without firing a trigger', async (t) => {
  const w = await world(t);
  await createDevices(w);
  const device = w.fake.devices.find((d) => d.name === 'web');
  const running = device.features.find((f) => f.external_id.endsWith(':running'));
  assert.deepEqual(await w.fake.setValue(device, running, 0), { success: true });
  assert.ok(w.incus.calls.includes('PUT /1.0/instances/web/state?project=default'));
  assert.ok(
    w.incus.calls.includes(
      'GET /1.0/operations/7c5d2f1e-3a4b-4c6d-8e9f-0a1b2c3d4e5f/wait?timeout=60',
    ),
  );
  assert.equal(w.fake.lastState(running.external_id), 0);
  assert.deepEqual(await w.fake.setValue(device, running, 1), { success: true });
  assert.equal(w.fake.lastState(running.external_id), 1);
  w.clock.advance(30_000);
  await w.hub.pollNow();
  assert.deepEqual(w.fake.sceneEvents, []);

  w.incus.refuse.set('web', 'Failed shutting down instance: context deadline exceeded');
  const ack = await w.fake.setValue(device, running, 0);
  assert.equal(ack.success, false);
  assert.match(ack.error.fr, /^web : échec, Incus a refusé: Failed shutting down/);
});

test('actions: green messages on success, red failures with a reason', async (t) => {
  const w = await world(t);
  const web = instanceId(w.gladys, 'web');

  let ack = await w.fake.action('test_connection', {});
  assert.equal(ack.success, true);
  assert.equal(
    ack.data.message.fr,
    'Home server : connecté, Incus 6.18, instances en marche : 2/5',
  );

  ack = await w.fake.action('stop_instance', { instance: web });
  assert.deepEqual(ack, {
    success: true,
    data: {
      message: {
        en: 'web: stopped',
        fr: 'web : arrêtée',
        de: 'web: gestoppt',
        es: 'web: detenida',
      },
    },
  });
  const puts = () => w.incus.calls.filter((c) => c.startsWith('PUT')).length;
  const sent = puts();
  ack = await w.fake.action('stop_instance', { instance: web });
  assert.equal(ack.data.message.fr, 'web : déjà arrêtée');
  assert.equal(puts(), sent, 'nothing sent when already stopped');
  ack = await w.fake.action('restart_instance', { instance: web });
  assert.equal(ack.data.message.en, 'web: started');
  ack = await w.fake.action('restart_instance', { instance: web });
  assert.equal(ack.data.message.en, 'web: restarted');
  ack = await w.fake.action('start_instance', { instance: web });
  assert.equal(ack.data.message.en, 'web: already running');

  // A paused instance is resumed by a start.
  ack = await w.fake.action('start_instance', { instance: instanceId(w.gladys, 'paused') });
  assert.equal(ack.success, true);
  assert.equal(w.incus.instance('paused').status, 'Running');

  ack = await w.fake.action('start_instance', {});
  assert.equal(ack.success, false);
  assert.equal(ack.error.fr, 'Choisissez une instance.');

  ack = await w.fake.action('start_instance', { instance: hostId(w.gladys) });
  assert.equal(ack.success, false);
  assert.match(ack.error.fr, /n'existe plus/);

  // By label too, project included.
  ack = await w.fake.action('stop_instance', { instance: 'lab/nextcloud' });
  assert.equal(ack.data.message.en, 'lab/nextcloud: stopped');
  assert.ok(w.incus.calls.includes('PUT /1.0/instances/nextcloud/state?project=lab'));

  w.incus.instances = w.incus.instances.filter((i) => i.name !== 'web');
  w.clock.advance(60_000);
  ack = await w.fake.action('start_instance', { instance: web });
  assert.equal(ack.success, false);
  assert.match(ack.error.en, /no longer exists/);

  w.incus.failure = 'down';
  w.clock.advance(60_000);
  ack = await w.fake.action('restart_instance', { instance: web });
  assert.equal(ack.success, false);
  assert.match(ack.error.fr, /illisible/);
  ack = await w.fake.action('test_connection', {});
  assert.equal(ack.success, false);
  assert.equal(ack.error.fr, 'Home server : le serveur Incus ne répond pas');
});

test('actions without configuration fail, and the status says what to do', async (t) => {
  const w = await world(t, { config: { language: 'en' } });
  let ack = await w.fake.action('restart_instance', { instance: 'web' });
  assert.equal(ack.success, false);
  assert.equal(ack.error.fr, "L'intégration n'est pas encore configurée.");
  ack = await w.fake.action('trust_server_again', {});
  assert.equal(ack.success, false);
  assert.equal(w.fake.connectionStatus.connected, false);
  assert.match(w.fake.connectionStatus.message.fr, /Saisissez l'adresse/);
  const bad = await world(t, { config: { api_url: 'http://192.0.2.30:8443' } });
  assert.match(bad.fake.connectionStatus.message.en, /Address not understood/);
  assert.equal((await bad.fake.action('test_connection', {})).success, false);
});

test('the address of the token is used when none is typed', async (t) => {
  const w = await world(t, { config: { language: 'en', trust_token: makeToken() } });
  assert.deepEqual(w.fake.connectionStatus, { connected: true });
  assert.equal(w.hub.config.url, 'https://192.0.2.30:8443');
});

test('scene actions return the instance and its state read back', async (t) => {
  const w = await world(t);
  const ack = await w.fake.sceneAction('stop_instance', {
    instance: instanceId(w.gladys, 'web'),
  });
  assert.deepEqual(ack.data.outputs, { instance_name: 'web', running: false });
  const failed = await w.fake.sceneAction('start_instance', { instance: 'nope' });
  assert.equal(failed.success, false);
});

test('a stop or an error fires "stopped unexpectedly" once; a pause does not', async (t) => {
  const w = await world(t);
  w.incus.setStatus('web', 'Stopped');
  w.incus.setStatus('nextcloud', 'Frozen', 'lab');
  await w.hub.pollNow();
  await w.hub.pollNow();
  assert.deepEqual(events(w, TRIGGERS.STOPPED), [
    {
      key: TRIGGERS.STOPPED,
      data: {
        instance: instanceId(w.gladys, 'web'),
        instance_name: 'web',
        project: 'default',
        status: 'Stopped',
      },
    },
  ]);
  w.incus.setStatus('nextcloud', 'Running', 'lab');
  await w.hub.pollNow();
  w.incus.setStatus('nextcloud', 'Error', 'lab');
  await w.hub.pollNow();
  assert.equal(events(w, TRIGGERS.STOPPED).at(-1).data.status, 'Error');
  assert.equal(events(w, TRIGGERS.STOPPED).at(-1).data.project, 'lab');
  assert.equal(events(w, TRIGGERS.STOPPED).length, 2);
});

test('the first read only records; a restart of the integration announces nothing twice', async (t) => {
  const w = await world(t);
  // The fixtures already hold a stopped VM and an instance in error.
  assert.deepEqual(w.fake.sceneEvents, []);
  w.incus.setStatus('web', 'Stopped');
  await w.hub.pollNow();
  assert.equal(events(w, TRIGGERS.STOPPED).length, 1);
  await w.app.stop();

  const again = await world(t, { incus: w.incus, dataDir: w.dataDir });
  await again.hub.pollNow();
  assert.deepEqual(again.fake.sceneEvents, []);
  w.incus.setStatus('web', 'Running');
  await again.hub.pollNow();
  w.incus.setStatus('web', 'Stopped');
  await again.hub.pollNow();
  assert.equal(events(again, TRIGGERS.STOPPED).length, 1);
});

test('an event Gladys refused is announced at the next read', async (t) => {
  const w = await world(t);
  const publish = w.gladys.publishSceneEvent.bind(w.gladys);
  let refuse = true;
  t.mock.method(w.gladys, 'publishSceneEvent', async (...args) => {
    if (refuse) {
      throw new GladysApiError(429, 'TOO_MANY_REQUESTS', 'slow down');
    }
    return publish(...args);
  });
  w.incus.setStatus('web', 'Stopped');
  await w.hub.pollNow();
  assert.equal(events(w, TRIGGERS.STOPPED).length, 0);
  refuse = false;
  await w.hub.pollNow();
  assert.equal(events(w, TRIGGERS.STOPPED).length, 1);
});

test('Incus silent twice: unreachable, once per outage, devices marked', async (t) => {
  const w = await world(t);
  await createDevices(w);
  w.incus.failure = 'down';
  await w.hub.pollNow();
  assert.equal(events(w, TRIGGERS.UNREACHABLE).length, 0, 'a blip is not an outage');
  await w.hub.pollNow();
  await w.hub.pollNow();
  assert.deepEqual(events(w, TRIGGERS.UNREACHABLE), [
    { key: TRIGGERS.UNREACHABLE, data: { host_name: 'Home server' } },
  ]);
  assert.equal(w.fake.lastState(host(w, 'reachable')), 0);
  assert.equal(w.fake.connectionStatus.connected, false);
  assert.equal(w.fake.connectionStatus.message.de, 'der Incus-Server antwortet nicht');
  const transports = new Map(w.fake.transports.map((e) => [e.device_external_id, e.transport]));
  assert.equal(transports.get(instanceId(w.gladys, 'web')), 'unreachable');

  w.incus.failure = null;
  await w.hub.pollNow();
  assert.equal(w.fake.lastState(host(w, 'reachable')), 1);
  assert.deepEqual(w.fake.connectionStatus, { connected: true });
  assert.equal(events(w, TRIGGERS.STOPPED).length, 0);
});

test('a web page at the address is a configuration problem, not an outage', async (t) => {
  const w = await world(t);
  w.incus.failure = 'html';
  await w.hub.pollNow();
  await w.hub.pollNow();
  assert.equal(events(w, TRIGGERS.UNREACHABLE).length, 0);
  assert.match(w.fake.connectionStatus.message.en, /no Incus or LXD API/);
});

test('an LXD server without all-projects reads the default project', async (t) => {
  const incus = new FakeIncus();
  incus.server = fixture('server-lxd');
  const w = await world(t, { incus });
  assert.ok(w.incus.calls.includes('GET /1.0/instances?recursion=2'));
  assert.ok(!w.fake.discoveredDevices.some((d) => d.name === 'lab/nextcloud'));
  await createDevices(w);
  assert.equal(w.fake.lastState(host(w, 'version')), 'LXD 5.21.3');
});

test('another address starts afresh', async (t) => {
  const w = await world(t);
  w.incus.setStatus('web', 'Stopped');
  await w.fake.configUpdated(baseConfig({ api_url: '198.51.100.7' }));
  assert.equal(w.hub.config.url, 'https://198.51.100.7:8443');
  assert.deepEqual(w.fake.sceneEvents, [], 'the first read of the other server only records');
});

test('a normal cycle writes nothing at the info level', async (t) => {
  const w = await world(t);
  await createDevices(w);
  const lines = captureLogs(t);
  w.incus.setStatus('web', 'Stopped');
  for (let read = 0; read < 4; read += 1) {
    w.clock.advance(31_000);
    w.incus.instance('nextcloud', 'lab').state.cpu.usage += 1e9;
    await w.hub.pollNow();
  }
  await w.hub.rediscover();
  assert.ok(w.fake.sceneEvents.length >= 1);
  assert.deepEqual(lines, []);

  w.incus.failure = 'down';
  for (let read = 0; read < 4; read += 1) {
    await w.hub.pollNow();
  }
  w.incus.failure = null;
  await w.hub.pollNow();
  assert.equal(lines.length, 2, lines.join('\n'));
  assert.match(lines[0], /ECONNREFUSED/);
  assert.match(lines[1], /answers again/);
});

test('the container reads Incus on its own timer, without any poll from Gladys', async (t) => {
  const incus = new FakeIncus();
  const w = await world(t, { incus, timers: true, config: baseConfig({ poll_interval: '15' }) });
  await createDevices(w);
  const reads = () => incus.calls.filter((c) => c.startsWith('GET /1.0/instances')).length;
  const before = reads();
  // Shorten the wait: the interval is read from the config at each schedule.
  w.hub.config.pollIntervalMs = 20;
  w.hub.schedulePoll();
  incus.setStatus('web', 'Stopped');
  await sleep(120);
  assert.ok(reads() > before, 'read again by the timer');
  assert.equal(w.fake.lastState(feature(w, 'web', 'running')), 0);
});

test('a stop asked while a read is in flight never fires a trigger, and reads the new state', async (t) => {
  const w = await world(t);
  const request = w.hub.client.request;
  let releaseStop;
  const stopHeld = new Promise((resolve) => {
    releaseStop = resolve;
  });
  let stopDone;
  const stopAnswered = new Promise((resolve) => {
    stopDone = resolve;
  });
  let holdList = false;
  w.hub.client.request = async (call) => {
    if (call.path.includes('/wait')) {
      await stopHeld;
      const response = await request(call);
      stopDone();
      return response;
    }
    if (holdList && call.path.startsWith('/1.0/instances?')) {
      // This read saw the instance running: its answer arrives after the stop.
      holdList = false;
      const response = await request(call);
      await stopAnswered;
      return response;
    }
    return request(call);
  };
  const action = w.fake.sceneAction('stop_instance', { instance: instanceId(w.gladys, 'web') });
  await sleep(10);
  // The timer's read starts while Incus is still stopping the instance.
  holdList = true;
  const timerRead = w.hub.pollNow();
  await sleep(10);
  releaseStop();
  const ack = await action;
  await timerRead;
  assert.deepEqual(ack.data.outputs, { instance_name: 'web', running: false });
  w.clock.advance(30_000);
  await w.hub.pollNow();
  assert.deepEqual(events(w, TRIGGERS.STOPPED), []);
});

test('a token keeps its pin across an address fix, and a manual re-trust survives a restart', async (t) => {
  const incus = new FakeIncus();
  incus.trusted = false;
  incus.tokenSecret = 'a1b2c3d4e5f6';
  const token = makeToken({ fingerprint: OTHER_FINGERPRINT });
  const w = await world(t, { incus, config: baseConfig({ trust_token: token }) });
  assert.equal(w.hub.pin, OTHER_FINGERPRINT);
  // The address fixed, the token unchanged: still its fingerprint, nothing sent.
  await w.fake.configUpdated(baseConfig({ api_url: '198.51.100.7', trust_token: token }));
  assert.equal(w.hub.pin, OTHER_FINGERPRINT);
  assert.deepEqual(w.incus.calls, []);

  // Back to the first address; the user trusts the new certificate by hand.
  await w.fake.configUpdated(baseConfig({ trust_token: token }));
  await w.fake.action('trust_server_again', {});
  assert.equal(w.hub.pin, SERVER_FINGERPRINT);
  await w.app.stop();
  const again = await world(t, {
    incus,
    dataDir: w.dataDir,
    config: baseConfig({ trust_token: token }),
  });
  assert.equal(again.hub.pin, SERVER_FINGERPRINT, 'the old token does not pin again');
});

test('a stop that cannot be read back stays expected: no false "stopped unexpectedly"', async (t) => {
  const w = await world(t);
  const request = w.hub.client.request;
  let silent = false;
  w.hub.client.request = async (call) => {
    if (silent && call.method === 'GET' && !call.path.includes('/wait')) {
      throw new IncusError(ERROR_KINDS.UNREACHABLE, 'GET: ECONNREFUSED');
    }
    const answer = await request(call);
    if (call.path.includes('/wait')) {
      silent = true; // Incus stops answering right after the stop.
    }
    return answer;
  };
  await w.fake.sceneAction('stop_instance', { instance: instanceId(w.gladys, 'web') });
  silent = false;
  w.clock.advance(30_000);
  await w.hub.pollNow();
  assert.deepEqual(events(w, TRIGGERS.STOPPED), []);
});
