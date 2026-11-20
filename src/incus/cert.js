// -----------------------------------------------------------------------------
// The client certificate of the integration: Incus (and LXD) authenticate a
// REST client by the TLS certificate it presents, trusted once on the server
// (`incus config trust add`, a token pasted in the configuration, or
// `incus config trust add-certificate` with the PEM file).
//
// Node can create the key pair (node:crypto) but not an X.509 certificate:
// the few DER structures of a self-signed certificate are written here, the
// same shape as the certificates the `incus` client makes for itself (ECDSA
// P-384, SHA-384, client authentication, ten years). No dependency.
// -----------------------------------------------------------------------------

import { X509Certificate, createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

// --- DER ---------------------------------------------------------------------

function length(n) {
  if (n < 0x80) {
    return Buffer.from([n]);
  }
  const bytes = [];
  for (let rest = n; rest > 0; rest >>= 8) {
    bytes.unshift(rest & 0xff);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const tlv = (tag, ...content) => {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
};
const sequence = (...items) => tlv(0x30, ...items);
const set = (...items) => tlv(0x31, ...items);
const explicit = (n, ...items) => tlv(0xa0 + n, ...items);
const octetString = (content) => tlv(0x04, content);
const bitString = (content) => tlv(0x03, Buffer.from([0]), content);
const utf8 = (text) => tlv(0x0c, Buffer.from(text, 'utf8'));
const boolean = (value) => tlv(0x01, Buffer.from([value ? 0xff : 0]));

function integer(bytes) {
  // Positive: a leading 0 when the high bit is set.
  const body = bytes[0] & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes;
  return tlv(0x02, body);
}

function oid(text) {
  const parts = text.split('.').map(Number);
  const bytes = [40 * parts[0] + parts[1]];
  for (const part of parts.slice(2)) {
    const chunk = [part & 0x7f];
    for (let rest = part >> 7; rest > 0; rest >>= 7) {
      chunk.unshift(0x80 | (rest & 0x7f));
    }
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

/** UTCTime until 2049, GeneralizedTime after (RFC 5280, 4.1.2.5). */
function time(date) {
  const iso = date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const year = date.getUTCFullYear();
  return year < 2050
    ? tlv(0x17, Buffer.from(`${iso.slice(2)}Z`, 'ascii'))
    : tlv(0x18, Buffer.from(`${iso}Z`, 'ascii'));
}

const OIDS = {
  ecdsaWithSha384: '1.2.840.10045.4.3.3',
  organization: '2.5.4.10',
  commonName: '2.5.4.3',
  keyUsage: '2.5.29.15',
  extKeyUsage: '2.5.29.37',
  basicConstraints: '2.5.29.19',
  clientAuth: '1.3.6.1.5.5.7.3.2',
};

const extension = (id, critical, value) =>
  sequence(oid(id), ...(critical ? [boolean(true)] : []), octetString(value));

// --- Certificate ---------------------------------------------------------------

export const CERT_VALIDITY_YEARS = 10;
export const CERT_SUBJECT = 'gladys-incus';

/** SHA-256 of a DER certificate, lowercase hex: the fingerprint Incus shows. */
export const fingerprintOf = (der) => createHash('sha256').update(der).digest('hex');

/**
 * A new self-signed client certificate.
 * @param {object} [options]
 * @param {number} [options.now] creation time (ms), the clock of the tests
 * @returns {{ cert: string, key: string, fingerprint: string }} PEM texts
 */
export function createClientCertificate({ now = Date.now() } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-384' });
  const algorithm = sequence(oid(OIDS.ecdsaWithSha384));
  const name = sequence(
    set(sequence(oid(OIDS.organization), utf8('Gladys Assistant'))),
    set(sequence(oid(OIDS.commonName), utf8(CERT_SUBJECT))),
  );
  // An hour back: a clock of the server slightly late must accept it.
  const notBefore = new Date(now - 3600_000);
  const notAfter = new Date(now);
  notAfter.setUTCFullYear(notAfter.getUTCFullYear() + CERT_VALIDITY_YEARS);
  const serial = randomBytes(16);
  serial[0] &= 0x7f;
  serial[0] |= 0x01;
  const tbs = sequence(
    explicit(0, integer(Buffer.from([2]))), // v3
    integer(serial),
    algorithm,
    name,
    sequence(time(notBefore), time(notAfter)),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    explicit(
      3,
      sequence(
        // digitalSignature only (bit 0).
        extension(OIDS.keyUsage, true, bitString(Buffer.from([0x80]))),
        extension(OIDS.extKeyUsage, false, sequence(oid(OIDS.clientAuth))),
        extension(OIDS.basicConstraints, true, sequence()),
      ),
    ),
  );
  const signature = sign('sha384', tbs, { key: privateKey, dsaEncoding: 'der' });
  const der = sequence(tbs, algorithm, bitString(signature));
  const base64 = der.toString('base64').replace(/.{64}/g, '$&\n');
  return {
    cert: `-----BEGIN CERTIFICATE-----\n${base64.trimEnd()}\n-----END CERTIFICATE-----\n`,
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    fingerprint: fingerprintOf(der),
  };
}

/** The fingerprint of a PEM certificate, null when unreadable. */
export function fingerprintOfPem(pem) {
  try {
    return fingerprintOf(new X509Certificate(pem).raw);
  } catch {
    return null;
  }
}
