// -----------------------------------------------------------------------------
// Small persistence under /data (the only writable path of the container):
//
//   - incus-state.json: what the scene triggers compare with (the last state
//     of each instance, whether "Incus unreachable" was announced) and the
//     pinned fingerprint of the server certificate. Losing it is harmless:
//     the first read after it only records the states, and pins the
//     certificate the server presents again;
//   - client.crt / client.key: the client certificate of the integration,
//     created at the first start. The key never leaves /data (mode 0600).
//     Losing them means trusting a new certificate on the server.
// (Adapted from guim31/gladys-podman.)
// -----------------------------------------------------------------------------

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '@gladysassistant/integration-sdk';
import { createClientCertificate, fingerprintOfPem } from './incus/cert.js';
import { createIssueLog } from './logs.js';

const logger = createLogger({ name: 'incus-store' });
const FILE_NAME = 'incus-state.json';
export const CERT_FILE = 'client.crt';
export const KEY_FILE = 'client.key';

export class Store {
  constructor(directory = process.env.INCUS_DATA_DIR || '/data', { now = Date.now } = {}) {
    this.directory = directory;
    this.now = now;
    this.path = join(directory, FILE_NAME);
    this.pending = null;
    this.writing = null;
    // A /data that refuses writes refuses them at every read: logged once.
    this.issues = createIssueLog(logger);
  }

  async load() {
    try {
      const data = JSON.parse(await readFile(this.path, 'utf8'));
      return data && typeof data === 'object' ? data : {};
    } catch (err) {
      if (err.code !== 'ENOENT') {
        logger.warn(`Cannot read ${this.path}: ${err.message}`);
      }
      return {};
    }
  }

  // Writes are coalesced and atomic (temporary file + rename): a crash never
  // leaves half a JSON file behind.
  save(data) {
    this.latest = data;
    if (!this.pending) {
      // Chained after the write in progress, if any: one writer at a time.
      this.pending = (this.writing ?? Promise.resolve()).then(async () => {
        const snapshot = this.latest;
        this.pending = null;
        try {
          await mkdir(this.directory, { recursive: true });
          const temporary = `${this.path}.tmp`;
          await writeFile(temporary, JSON.stringify(snapshot));
          await rename(temporary, this.path);
          this.issues.ok('write', `${this.path} written again`);
        } catch (err) {
          this.issues.fail('write', 'warn', `Cannot write ${this.path}: ${err.message}`);
        }
      });
      this.writing = this.pending;
    }
    return this.pending;
  }

  /**
   * The client certificate: read from /data, created there the first time.
   * Without a writable /data it lives in memory only (and must be trusted
   * again after a restart): said once in the logs.
   * @returns {Promise<{ cert: string, key: string, fingerprint: string }>}
   */
  async identity() {
    const certPath = join(this.directory, CERT_FILE);
    const keyPath = join(this.directory, KEY_FILE);
    try {
      const [cert, key] = await Promise.all([
        readFile(certPath, 'utf8'),
        readFile(keyPath, 'utf8'),
      ]);
      const fingerprint = fingerprintOfPem(cert);
      if (fingerprint) {
        return { cert, key, fingerprint };
      }
      logger.warn(`${certPath} is unreadable: a new client certificate is created`);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        logger.warn(`Cannot read the client certificate: ${err.message}`);
      }
    }
    const identity = createClientCertificate({ now: this.now() });
    try {
      await mkdir(this.directory, { recursive: true });
      await writeFile(keyPath, identity.key, { mode: 0o600 });
      await chmod(keyPath, 0o600);
      await writeFile(certPath, identity.cert);
      logger.info(`New client certificate created in ${certPath}`);
    } catch (err) {
      logger.warn(`Cannot keep the client certificate in ${this.directory}: ${err.message}`);
    }
    return identity;
  }

  /** Resolves once every write requested so far is on disk. */
  flush() {
    return this.writing ?? Promise.resolve();
  }
}
