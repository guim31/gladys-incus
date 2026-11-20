// -----------------------------------------------------------------------------
// The client certificate made without dependency (src/incus/cert.js): an
// X.509 v3 certificate Node (and so OpenSSL) reads back, self-signed, for
// client authentication, valid ten years.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { createClientCertificate, fingerprintOfPem } from '../src/incus/cert.js';

test('a self-signed P-384 client certificate, valid ten years', () => {
  const now = Date.parse('2026-11-19T20:53:00Z');
  const identity = createClientCertificate({ now });
  const cert = new X509Certificate(identity.cert);
  assert.equal(cert.subject, 'O=Gladys Assistant\nCN=gladys-incus');
  assert.equal(cert.issuer, cert.subject);
  assert.ok(cert.verify(cert.publicKey), 'self-signed signature checks');
  assert.ok(cert.checkPrivateKey(createPrivateKey(identity.key)));
  assert.equal(cert.publicKey.asymmetricKeyDetails.namedCurve, 'secp384r1');
  assert.deepEqual(cert.keyUsage, ['1.3.6.1.5.5.7.3.2']);
  assert.equal(cert.ca, false);
  assert.equal(Date.parse(cert.validFrom), now - 3600_000);
  assert.equal(Date.parse(cert.validTo), Date.parse('2036-11-19T20:53:00Z'));
  assert.equal(identity.fingerprint, cert.fingerprint256.replace(/:/g, '').toLowerCase());
  assert.equal(fingerprintOfPem(identity.cert), identity.fingerprint);
  assert.equal(fingerprintOfPem('garbage'), null);
  assert.notEqual(createClientCertificate({ now }).fingerprint, identity.fingerprint);
});

test('a date after 2049 is written as a GeneralizedTime', () => {
  const identity = createClientCertificate({ now: Date.parse('2045-01-01T00:00:00Z') });
  const cert = new X509Certificate(identity.cert);
  assert.equal(Date.parse(cert.validTo), Date.parse('2055-01-01T00:00:00Z'));
});
