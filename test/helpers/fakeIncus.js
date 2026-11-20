// -----------------------------------------------------------------------------
// A fake Incus server, served through the transport seam (createTransport):
// answers shaped after the Incus API structures (test/fixtures/incus), the
// instances editable by the tests, the trust of a token, the certificate pin
// checked as the real transport does (checkPeer), and start/stop/restart
// applied the way Incus answers (async operation, then its result).
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { checkPeer } from '../../src/incus/transport.js';
import { ERROR_KINDS, IncusError } from '../../src/incus/errors.js';

export const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`../fixtures/incus/${name}.json`, import.meta.url), 'utf8'));

export const API_URL = 'https://192.0.2.30:8443';
export const SERVER_FINGERPRINT =
  '5b2c1a9f0e6d4c3b8a7f6e5d4c3b2a1908f7e6d5c4b3a29180f7e6d5c4b3a291';
export const OTHER_FINGERPRINT = 'f'.repeat(64);

/** A trust token as `incus config trust add gladys` prints it. */
export function makeToken({ secret = 'a1b2c3d4e5f6', fingerprint = SERVER_FINGERPRINT } = {}) {
  return Buffer.from(
    JSON.stringify({
      client_name: 'gladys',
      fingerprint,
      addresses: ['192.0.2.30:8443'],
      secret,
      expires_at: '0001-01-01T00:00:00Z',
    }),
  ).toString('base64');
}

const STATUS_CODES = { Running: 103, Stopped: 102, Frozen: 110, Error: 112 };

export class FakeIncus {
  constructor() {
    this.server = fixture('server-trusted');
    this.instances = fixture('instances').metadata;
    this.resources = fixture('resources');
    this.fingerprint = SERVER_FINGERPRINT;
    this.trusted = true;
    /** secret of the token that trusts the client, consumed once */
    this.tokenSecret = null;
    /** 'down', 'html', or null */
    this.failure = null;
    /** name -> error text of a failed operation */
    this.refuse = new Map();
    this.calls = [];
    this.createTransport = this.createTransport.bind(this);
  }

  instance(name, project = 'default') {
    return this.instances.find((i) => i.name === name && i.project === project);
  }

  setStatus(name, status, project = 'default') {
    const instance = this.instance(name, project);
    instance.status = status;
    instance.status_code = STATUS_CODES[status];
    instance.state.status = status;
    instance.state.status_code = STATUS_CODES[status];
  }

  createTransport({ pinning }) {
    return async ({ method, path, body }) => {
      if (this.failure === 'down') {
        throw new IncusError(ERROR_KINDS.UNREACHABLE, `${method} ${path}: ECONNREFUSED`);
      }
      // Checked before anything is sent, as the real transport does.
      checkPeer(this.fingerprint, pinning);
      this.calls.push(`${method} ${path}`);
      if (this.failure === 'html') {
        return { status: 200, text: '<html>hello</html>' };
      }
      return this.answer(method, path, body);
    };
  }

  answer(method, path, body) {
    const json = (data, status = 200) => ({ status, text: JSON.stringify(data) });
    const { pathname, searchParams } = new URL(path, 'https://incus');
    if (method === 'GET' && pathname === '/1.0') {
      return json(this.trusted ? this.server : fixture('server-untrusted'));
    }
    if (method === 'POST' && pathname === '/1.0/certificates') {
      let secret = null;
      try {
        secret = JSON.parse(Buffer.from(body.trust_token, 'base64').toString()).secret;
      } catch {
        secret = null;
      }
      if (body.type !== 'client' || !this.tokenSecret || secret !== this.tokenSecret) {
        return json(fixture('error-forbidden'), 403);
      }
      this.tokenSecret = null; // single use
      this.trusted = true;
      return json(fixture('certificate-added'), 201);
    }
    if (!this.trusted) {
      return json(fixture('error-forbidden'), 403);
    }
    if (method === 'GET' && pathname === '/1.0/instances') {
      const all = searchParams.get('all-projects') === 'true';
      const list = this.instances.filter((i) => all || i.project === 'default');
      return json({ ...fixture('instances'), metadata: list });
    }
    if (method === 'GET' && pathname === '/1.0/resources') {
      return json(this.resources);
    }
    const state = pathname.match(/^\/1\.0\/instances\/([^/]+)\/state$/);
    if (method === 'PUT' && state) {
      const instance = this.instance(
        decodeURIComponent(state[1]),
        searchParams.get('project') ?? 'default',
      );
      if (!instance) {
        return json(fixture('error-not-found'), 404);
      }
      if (body.action === 'start' && instance.status === 'Running') {
        return json(fixture('error-already-running'), 400);
      }
      this.pendingOperation = { instance, action: body.action };
      return json(fixture('operation-created'), 202);
    }
    if (method === 'GET' && /^\/1\.0\/operations\/[^/]+\/wait$/.test(pathname)) {
      const { instance, action } = this.pendingOperation;
      this.pendingOperation = null;
      if (this.refuse.has(instance.name)) {
        const failure = fixture('operation-failure');
        failure.metadata.err = this.refuse.get(instance.name);
        return json(failure);
      }
      this.setStatus(instance.name, action === 'stop' ? 'Stopped' : 'Running', instance.project);
      return json(fixture('operation-success'));
    }
    return json(fixture('error-not-found'), 404);
  }
}
