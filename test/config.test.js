import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, normalizeConfig, parseApiUrl, parseTrustToken } from '../src/config.js';
import { SERVER_FINGERPRINT, makeToken } from './helpers/fakeIncus.js';

test('the API address accepts what people type', () => {
  assert.equal(parseApiUrl('192.0.2.30'), 'https://192.0.2.30:8443');
  assert.equal(parseApiUrl(' 192.0.2.30:9443 '), 'https://192.0.2.30:9443');
  assert.equal(parseApiUrl('https://server.lan:8443/'), 'https://server.lan:8443');
  assert.equal(parseApiUrl('https://server.lan'), 'https://server.lan:8443');
  assert.equal(parseApiUrl('https://proxy.lan/incus'), 'https://proxy.lan/incus');
  assert.equal(parseApiUrl('[2001:db8::1]:8443'), 'https://[2001:db8::1]:8443');
  assert.equal(parseApiUrl('incus.lan:443'), 'https://incus.lan');
  assert.equal(parseApiUrl('https://incus.lan:443/'), 'https://incus.lan');
});

test('the API address refuses what cannot work', () => {
  for (const raw of [
    '',
    '   ',
    null,
    42,
    'unix:///var/lib/incus/unix.socket',
    'http://server.lan:8443',
    'https://user:pass@server.lan:8443',
    'https://server.lan:8443/?x=1',
    '0.0.0.0:8443',
    'https://',
  ]) {
    assert.equal(parseApiUrl(raw), null, String(raw));
  }
});

test('a trust token is decoded, its fingerprint kept, never its secret in clear', () => {
  const token = parseTrustToken(`  ${makeToken()}\n`);
  assert.equal(token.fingerprint, SERVER_FINGERPRINT);
  assert.deepEqual(token.addresses, ['192.0.2.30:8443']);
  assert.match(token.id, /^[0-9a-f]{16}$/);
  assert.equal(parseTrustToken('hello'), null);
  assert.equal(parseTrustToken(Buffer.from('{"client_name":"x"}').toString('base64')), null);
  assert.equal(parseTrustToken(''), null);
});

test('normalizeConfig applies the defaults and reports what is unusable', () => {
  const empty = normalizeConfig({});
  assert.equal(empty.url, null);
  assert.equal(empty.token, null);
  assert.equal(empty.name, 'Incus');
  assert.equal(empty.pollIntervalMs, Number(DEFAULT_CONFIG.poll_interval) * 1000);
  assert.equal(empty.language, 'fr');
  assert.deepEqual(empty.problems, []);

  const bad = normalizeConfig({ api_url: 'http://x', trust_token: 'nope', poll_interval: '7' });
  assert.deepEqual(bad.problems, ['invalidToken', 'invalidUrl']);
  assert.equal(bad.pollIntervalMs, 30_000);

  const fromToken = normalizeConfig({ trust_token: makeToken(), host_name: '  Lab  ' });
  assert.equal(fromToken.url, 'https://192.0.2.30:8443');
  assert.equal(fromToken.name, 'Lab');
  const typed = normalizeConfig({ api_url: '198.51.100.7', trust_token: makeToken() });
  assert.equal(typed.url, 'https://198.51.100.7:8443', 'the typed address wins');
});
