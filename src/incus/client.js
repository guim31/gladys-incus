// -----------------------------------------------------------------------------
// The Incus REST API (LXD has the same one), over the TLS transport
// (src/incus/transport.js) or a fake one in the tests.
//
//   GET  /1.0                                    server: auth, version, extensions
//   POST /1.0/certificates                       trust the client certificate (token)
//   GET  /1.0/instances?recursion=2&all-projects=true   instances with their state
//   GET  /1.0/resources                          CPU threads of the host (once)
//   PUT  /1.0/instances/{name}/state?project=p   start, stop, restart (async)
//   GET  /1.0/operations/{id}/wait?timeout=n     waits for that operation
//
// Every answer is an envelope: `{ type: "sync", metadata }`,
// `{ type: "async", operation }` or `{ type: "error", error_code, error }`.
// -----------------------------------------------------------------------------

import { ERROR_KINDS, IncusError } from './errors.js';

export { ERROR_KINDS, IncusError };

// The operations of the instance devices, the actions and the widget.
export const OPERATIONS = Object.freeze({
  START: 'start',
  STOP: 'stop',
  RESTART: 'restart',
});

// Resumes a paused (Frozen) instance: what a start of one means.
export const UNFREEZE = 'unfreeze';

// Seconds Incus waits for a clean shutdown (`incus stop --timeout`): a
// container stops in a few seconds, a VM needs its guest to shut down.
export const STOP_TIMEOUT_S = 30;

export const TIMINGS = {
  readTimeoutMs: 15_000,
  // The operation itself, waited for up to WAIT_S on the server side.
  controlTimeoutMs: 15_000,
  waitS: STOP_TIMEOUT_S + 30,
};

export const API_EXTENSIONS = Object.freeze({
  ALL_PROJECTS: 'instance_all_projects',
});

export class IncusClient {
  /**
   * @param {object} options
   * @param {Function} options.request the transport (createTransport)
   * @param {object} [options.timings] TIMINGS overrides
   */
  constructor({ request, timings = {} }) {
    this.request = request;
    this.timings = { ...TIMINGS, ...timings };
    /** CPU threads of the host, read once (null when unknown). */
    this.cpuTotal = undefined;
  }

  /** One request; the envelope of a sync or async answer, IncusError otherwise. */
  async call(method, path, { body, timeoutMs = this.timings.readTimeoutMs } = {}) {
    const { status, text } = await this.request({ method, path, body, timeoutMs });
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    if (!json || typeof json !== 'object' || typeof json.type !== 'string') {
      throw new IncusError(ERROR_KINDS.NOT_INCUS, `${method} ${path}: not the Incus API`, {
        status,
      });
    }
    if (json.type === 'error') {
      const code = Number(json.error_code) || status;
      const cause = typeof json.error === 'string' ? json.error : null;
      const kind =
        code === 403
          ? ERROR_KINDS.FORBIDDEN
          : code === 404
            ? ERROR_KINDS.NOT_FOUND
            : ERROR_KINDS.HTTP;
      throw new IncusError(kind, `${method} ${path}: HTTP ${code}`, { status: code, cause });
    }
    return json;
  }

  /** `GET /1.0`: who the server is, and whether it trusts us. */
  async server() {
    const { metadata } = await this.call('GET', '/1.0');
    if (!metadata || typeof metadata.auth !== 'string') {
      throw new IncusError(ERROR_KINDS.NOT_INCUS, 'GET /1.0: no auth field');
    }
    const environment = metadata.environment ?? {};
    return {
      trusted: metadata.auth === 'trusted',
      product: environment.server === 'lxd' ? 'LXD' : 'Incus',
      version: typeof environment.server_version === 'string' ? environment.server_version : '',
      extensions: Array.isArray(metadata.api_extensions) ? metadata.api_extensions : [],
    };
  }

  /** Trust the client certificate with a token of `incus config trust add`. */
  async trust(token) {
    try {
      await this.call('POST', '/1.0/certificates', {
        body: { type: 'client', trust_token: token },
      });
    } catch (err) {
      if (err instanceof IncusError && err.kind === ERROR_KINDS.FORBIDDEN) {
        throw new IncusError(ERROR_KINDS.TOKEN_REFUSED, 'POST /1.0/certificates: token refused');
      }
      throw err;
    }
  }

  /** CPU threads of the host, to express the CPU use of an instance in %. */
  async cpuThreads() {
    if (this.cpuTotal === undefined) {
      try {
        const { metadata } = await this.call('GET', '/1.0/resources');
        const total = metadata?.cpu?.total;
        this.cpuTotal = Number.isInteger(total) && total > 0 ? total : null;
      } catch (err) {
        // A restricted certificate may not read the resources: per thread.
        // Any other failure is retried at the next read.
        if (err?.kind === ERROR_KINDS.FORBIDDEN) {
          this.cpuTotal = null;
        }
        return null;
      }
    }
    return this.cpuTotal;
  }

  /** The server, every instance with its state, and the CPU threads. */
  async read() {
    const server = await this.server();
    if (!server.trusted) {
      throw new IncusError(ERROR_KINDS.UNTRUSTED, 'GET /1.0: client certificate not trusted');
    }
    const allProjects = server.extensions.includes(API_EXTENSIONS.ALL_PROJECTS);
    let answer;
    try {
      answer = await this.call(
        'GET',
        `/1.0/instances?recursion=2${allProjects ? '&all-projects=true' : ''}`,
      );
    } catch (err) {
      // A certificate restricted to some projects may not list all of them.
      if (!allProjects || err.kind !== ERROR_KINDS.FORBIDDEN) {
        throw err;
      }
      answer = await this.call('GET', '/1.0/instances?recursion=2');
    }
    if (!Array.isArray(answer.metadata)) {
      throw new IncusError(ERROR_KINDS.NOT_INCUS, 'GET /1.0/instances: not a list');
    }
    return {
      product: server.product,
      version: server.version,
      cpuThreads: await this.cpuThreads(),
      instances: answer.metadata,
    };
  }

  /**
   * Start, stop or restart an instance, and wait for the end of the operation.
   * @param {string} name
   * @param {string} project
   * @param {string} action an OPERATIONS value, or UNFREEZE
   */
  async control(name, project, action) {
    if (![...Object.values(OPERATIONS), UNFREEZE].includes(action)) {
      throw new TypeError(`Unknown operation ${action}`);
    }
    const path = `/1.0/instances/${encodeURIComponent(name)}/state?project=${encodeURIComponent(
      project,
    )}`;
    const refused = (err) => {
      if (err instanceof IncusError && err.kind === ERROR_KINDS.HTTP) {
        return new IncusError(ERROR_KINDS.REFUSED, err.message, err);
      }
      return err;
    };
    let answer;
    try {
      answer = await this.call('PUT', path, {
        body: { action, timeout: STOP_TIMEOUT_S, force: false, stateful: false },
        timeoutMs: this.timings.controlTimeoutMs,
      });
    } catch (err) {
      throw refused(err);
    }
    if (answer.type !== 'async' || typeof answer.operation !== 'string') {
      return;
    }
    const [operationPath, query] = answer.operation.split('?');
    const waitPath = `${operationPath}/wait?timeout=${this.timings.waitS}${query ? `&${query}` : ''}`;
    let waited;
    try {
      waited = await this.call('GET', waitPath, {
        timeoutMs: (this.timings.waitS + 15) * 1000,
      });
    } catch (err) {
      throw refused(err);
    }
    const operation = waited.metadata ?? {};
    if (operation.status !== 'Success') {
      const cause = typeof operation.err === 'string' && operation.err ? operation.err : null;
      throw new IncusError(
        ERROR_KINDS.REFUSED,
        `${action} ${name}: operation ${operation.status ?? 'unknown'}`,
        { cause },
      );
    }
  }
}
