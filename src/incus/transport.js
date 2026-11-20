// -----------------------------------------------------------------------------
// HTTPS to the Incus (or LXD) REST API with the client certificate of the
// integration, and the server certificate pinned by its fingerprint.
//
// An Incus server presents a self-signed certificate: no authority to check
// it against. Its SHA-256 fingerprint is pinned instead — taken from the
// trust token when there is one (`incus config trust add` puts it there), or
// trusted on first use and kept under /data. The check runs right after the
// TLS handshake, BEFORE a single byte of the request is sent: a trust token
// never leaves for a server that is not the pinned one.
//
// `node:http` over a TLS socket made by `createConnection`: no dependency,
// and the hook where the pin is checked. One connection per request
// (`Connection: close`): a read every 15 seconds at most.
// -----------------------------------------------------------------------------

import http from 'node:http';
import { isIP } from 'node:net';
import tls from 'node:tls';
import { fingerprintOf } from './cert.js';
import { ERROR_KINDS, IncusError } from './errors.js';

// Connection errors that mean "nothing answers there".
const SILENT = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EPIPE',
]);

/**
 * Compare the certificate a server presented with the pin.
 * @param {string} fingerprint of the server certificate
 * @param {object} pinning `expected()` the pinned fingerprint (null: none
 *   yet), `seen(fingerprint)` called with the one of a new server
 */
export function checkPeer(fingerprint, pinning) {
  const expected = pinning?.expected?.() ?? null;
  if (expected && expected !== fingerprint) {
    throw new IncusError(ERROR_KINDS.CERT_CHANGED, `server certificate ${fingerprint} not pinned`);
  }
  if (!expected) {
    pinning?.seen?.(fingerprint);
  }
}

/**
 * @param {object} options
 * @param {string} options.url `https://host:port[/path]` (src/config.js)
 * @param {{ cert: string, key: string }} options.identity the client certificate
 * @param {object} options.pinning see checkPeer
 * @returns {(request: { method: string, path: string, body?: object, timeoutMs: number }) =>
 *   Promise<{ status: number, text: string }>}
 */
export function createTransport({ url, identity, pinning }) {
  const target = new URL(url);
  const host = target.hostname.replace(/^\[|\]$/g, '');
  const port = Number(target.port) || 443;
  const base = target.pathname.replace(/\/+$/, '');

  return ({ method, path, body, timeoutMs }) =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
      let settled = false;
      let socket = null;
      let deadline = null;
      const settle = () => {
        settled = true;
        clearTimeout(deadline);
      };
      const fail = (err) => {
        if (!settled) {
          settle();
          reject(err);
        }
      };
      const request = http.request({
        method,
        path: `${base}${path}`,
        headers: {
          host: target.host,
          accept: 'application/json',
          connection: 'close',
          ...(payload
            ? { 'content-type': 'application/json', 'content-length': payload.length }
            : {}),
        },
        createConnection: (_options, done) => {
          socket = tls.connect({
            host,
            port,
            servername: isIP(host) ? undefined : host,
            cert: identity.cert,
            key: identity.key,
            // Self-signed by design: the fingerprint is checked below.
            rejectUnauthorized: false,
          });
          socket.once('secureConnect', () => {
            try {
              checkPeer(fingerprintOf(socket.getPeerCertificate().raw), pinning);
            } catch (err) {
              socket.destroy();
              done(err);
              return;
            }
            done(null, socket);
          });
          socket.once('error', (err) => done(err));
        },
      });
      // One deadline for the whole exchange: the `timeout` option of
      // http.request only starts once the TLS handshake is over, and a port
      // that accepts and never answers would hang the read for good.
      deadline = setTimeout(() => {
        const err = new IncusError(ERROR_KINDS.UNREACHABLE, `${method} ${path}: timeout`);
        fail(err);
        request.destroy(err);
        socket?.destroy();
      }, timeoutMs);
      deadline.unref?.();
      request.on('error', (err) => {
        if (err instanceof IncusError) {
          fail(err);
          return;
        }
        const code = err?.code ?? err?.name ?? 'error';
        // Something answered, but not in TLS (an HTTP page, another service).
        const notTls =
          !SILENT.has(code) && (code === 'EPROTO' || String(code).startsWith('ERR_SSL'));
        const kind = notTls ? ERROR_KINDS.NOT_INCUS : ERROR_KINDS.UNREACHABLE;
        fail(new IncusError(kind, `${method} ${path}: ${code}`));
      });
      request.on('response', (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          if (settled) {
            return;
          }
          settle();
          resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString('utf8') });
        });
        response.on('error', (err) =>
          fail(new IncusError(ERROR_KINDS.UNREACHABLE, `${method} ${path}: ${err.code ?? err}`)),
        );
      });
      request.end(payload ?? undefined);
    });
}
