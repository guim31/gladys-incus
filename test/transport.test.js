// -----------------------------------------------------------------------------
// The real TLS transport and the client against a local HTTPS server that
// authenticates clients the way Incus does (the certificate presented in the
// handshake, trusted by a token): loopback only, certificates made by
// src/incus/cert.js on both sides.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { X509Certificate } from 'node:crypto';
import { createClientCertificate, fingerprintOf } from '../src/incus/cert.js';
import { ERROR_KINDS, IncusClient, IncusError } from '../src/incus/client.js';
import { createTransport } from '../src/incus/transport.js';
import { fixture, makeToken } from './helpers/fakeIncus.js';

/** A small Incus look-alike: GET /1.0, POST /1.0/certificates, GET /1.0/instances. */
async function startServer(t) {
  const identity = createClientCertificate();
  const state = { trusted: new Set(), requests: [], secret: 'a1b2c3d4e5f6' };
  const server = https.createServer(
    { cert: identity.cert, key: identity.key, requestCert: true, rejectUnauthorized: false },
    (req, res) => {
      const peer = req.socket.getPeerCertificate();
      const client = peer?.raw ? fingerprintOf(peer.raw) : null;
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        state.requests.push({ method: req.method, url: req.url, body, client });
        const send = (data, status = 200) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(data));
        };
        const trusted = client && state.trusted.has(client);
        if (req.method === 'GET' && req.url === '/1.0') {
          return send(fixture(trusted ? 'server-trusted' : 'server-untrusted'));
        }
        if (req.method === 'POST' && req.url === '/1.0/certificates') {
          const { trust_token: token } = JSON.parse(body);
          const { secret } = JSON.parse(Buffer.from(token, 'base64').toString());
          if (secret !== state.secret) {
            return send(fixture('error-forbidden'), 403);
          }
          state.secret = null;
          state.trusted.add(client);
          return send(fixture('certificate-added'), 201);
        }
        if (!trusted) {
          return send(fixture('error-forbidden'), 403);
        }
        if (req.url.startsWith('/1.0/instances')) {
          return send(fixture('instances'));
        }
        if (req.url === '/1.0/resources') {
          return send(fixture('resources'));
        }
        return send(fixture('error-not-found'), 404);
      });
    },
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `https://127.0.0.1:${server.address().port}`;
  const fingerprint = fingerprintOf(new X509Certificate(identity.cert).raw);
  return { url, state, fingerprint };
}

function pinning(initial = null) {
  const pin = { value: initial, seen: [] };
  pin.expected = () => pin.value;
  pin.seenFn = (fingerprint) => {
    pin.seen.push(fingerprint);
    pin.value = fingerprint;
  };
  return pin;
}

const clientFor = (url, identity, pin) =>
  new IncusClient({
    request: createTransport({
      url,
      identity,
      pinning: { expected: pin.expected, seen: pin.seenFn },
    }),
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

test('untrusted, then trusted by a token: the certificate of the handshake is the identity', async (t) => {
  const server = await startServer(t);
  const identity = createClientCertificate();
  const pin = pinning();
  const client = clientFor(server.url, identity, pin);

  assert.equal(await kindOf(client.read()), ERROR_KINDS.UNTRUSTED);
  assert.deepEqual(pin.seen, [server.fingerprint], 'trusted on first use');
  assert.equal(server.state.requests[0].client, identity.fingerprint);

  assert.equal(
    await kindOf(client.trust(makeToken({ secret: 'wrong' }))),
    ERROR_KINDS.TOKEN_REFUSED,
  );
  await client.trust(makeToken());
  const raw = await client.read();
  assert.equal(raw.product, 'Incus');
  assert.equal(raw.version, '6.18');
  assert.equal(raw.cpuThreads, 8);
  assert.equal(raw.instances.length, 5);
  assert.equal(await kindOf(client.trust(makeToken())), ERROR_KINDS.TOKEN_REFUSED, 'single use');
});

test('another server certificate than the pinned one: refused before any byte is sent', async (t) => {
  const server = await startServer(t);
  const client = clientFor(server.url, createClientCertificate(), pinning('0'.repeat(64)));
  assert.equal(await kindOf(client.trust(makeToken())), ERROR_KINDS.CERT_CHANGED);
  assert.equal(await kindOf(client.read()), ERROR_KINDS.CERT_CHANGED);
  assert.deepEqual(server.state.requests, [], 'the token never reached the server');
});

test('nothing listening is unreachable; a plain HTTP server is not Incus', async (t) => {
  const plain = http.createServer((req, res) => res.end('<html>hello</html>'));
  await new Promise((resolve) => plain.listen(0, '127.0.0.1', resolve));
  const port = plain.address().port;
  t.after(() => plain.close());
  const identity = createClientCertificate();
  const httpClient = clientFor(`https://127.0.0.1:${port}`, identity, pinning());
  assert.equal(await kindOf(httpClient.read()), ERROR_KINDS.NOT_INCUS);

  const closed = http.createServer();
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const closedPort = closed.address().port;
  await new Promise((resolve) => closed.close(resolve));
  const silent = clientFor(`https://127.0.0.1:${closedPort}`, identity, pinning());
  assert.equal(await kindOf(silent.read()), ERROR_KINDS.UNREACHABLE);
});
