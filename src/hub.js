// -----------------------------------------------------------------------------
// The Incus hub: the server read on a timer of the container (the interval
// chosen in the configuration); the trust of the client certificate (token)
// and the pin of the server certificate; the states of the devices the user
// added published to Gladys when they change, the scene events fired on
// transitions (src/alerts.js), the operations on instances (switch, actions,
// widget, scenes), and the views the widget reads.
//
// Gladys never polls these devices (should_poll: false): the interval goes up
// to 5 minutes, beyond the fixed list of the core scheduler, the CPU use
// needs two reads a known time apart, and the scene events must fire for
// every instance, added to Gladys or not.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { Watcher } from './alerts.js';
import {
  DEVICE_TYPES,
  HOST_ID,
  buildDevice,
  deviceIds,
  featureValues,
  instanceDeviceId,
  instanceKey,
  parseDeviceId,
} from './devices.js';
import { ERROR_KINDS, IncusClient, IncusError, OPERATIONS, UNFREEZE } from './incus/client.js';
import { STATUS, cpuPercent, instanceLabel, parseSnapshot, totals } from './incus/model.js';
import { createTransport } from './incus/transport.js';
import { hostOf } from './config.js';
import { createIssueLog } from './logs.js';
import {
  ACTION_TEXT,
  ActionFailure,
  CONNECTION_TEXT,
  OPERATION_TEXT,
  REPORT_TEXT,
  allLanguages,
  errorText,
  labelled,
  pick,
} from './texts.js';

const logger = createLogger({ name: 'incus-hub' });

export const WIDGET_KEY = 'instances';

// Scene trigger keys (manifest `scene_triggers`): permanent once published.
export const TRIGGERS = Object.freeze({
  STOPPED: 'instance_stopped',
  UNREACHABLE: 'incus_unreachable',
});

export const HUB_TIMINGS = {
  // A failed read is retried this soon, to tell a blip from an outage.
  retryMs: 15_000,
  // Failures in a row before the machine counts as unreachable (scene event).
  downAfterFailures: 2,
  // An unchanged value is sent again after this long (the core marks a value
  // outdated after 48 hours).
  heartbeatMs: 6 * 3600_000,
  // An operation reads Incus first when the last read is older.
  freshMs: 15_000,
};

const MAX_TRANSPORTS_PER_REQUEST = 100;

export class IncusHub {
  /**
   * @param {object} options
   * @param {object} options.gladys GladysIntegration (or the SDK's fake Gladys)
   * @param {object} options.store persistence (src/store.js)
   * @param {Function} [options.createTransport] transport seam (tests)
   * @param {boolean} [options.timers] periodic timers (off in tests)
   * @param {object} [options.timings] HUB_TIMINGS overrides
   * @param {object} [options.clientTimings] client TIMINGS overrides
   * @param {() => number} [options.now]
   */
  constructor({
    gladys,
    store,
    createTransport: transport = createTransport,
    timers = true,
    timings,
    clientTimings,
    now,
  }) {
    this.gladys = gladys;
    this.store = store;
    this.createTransport = transport;
    /** The client certificate, read or created under /data at the start. */
    this.identity = null;
    /** The pinned fingerprint of the server certificate (null: next one seen). */
    this.pin = null;
    /** Hash of the last trust token Incus refused: not sent again. */
    this.refusedToken = null;
    /** instance key -> { cpuNs, at }: the previous CPU counter. */
    this.cpuReads = new Map();
    this.timersEnabled = timers;
    this.timings = { ...HUB_TIMINGS, ...timings };
    this.clientTimings = clientTimings;
    this.now = now ?? (() => Date.now());
    this.config = null;
    this.client = null;
    this.watcher = new Watcher();
    this.resetRead();
    this.transports = new Map();
    this.connection = null;
    this.discovered = null;
    this.pollTimer = null;
    this.retryTimer = null;
    this.polling = null;
    this.stopped = false;
    this.generation = 0;
    // Failures that repeat at every read: one line, then one when they heal.
    this.issues = createIssueLog(logger);
  }

  resetRead() {
    /** @type {object|null} the last snapshot read (src/incus/model.js) */
    this.snapshot = null;
    this.error = null;
    this.failures = 0;
    this.down = false;
    this.readAt = 0;
    /** instance key -> CPU % between the last two reads. */
    this.cpu = new Map();
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(config) {
    const saved = await this.store.load();
    this.watcher = new Watcher(saved);
    this.pin = typeof saved.pin === 'string' ? saved.pin : null;
    this.pinnedUrl = typeof saved.pinnedUrl === 'string' ? saved.pinnedUrl : null;
    // The token whose fingerprint was applied: not applied again at each start.
    this.pinnedToken = typeof saved.pinnedToken === 'string' ? saved.pinnedToken : null;
    this.identity = await this.store.identity();
    logger.info(`Client certificate fingerprint: ${this.identity.fingerprint}`);
    await this.reconfigure(config);
  }

  /** What is kept under /data: the trigger states and the server pin. */
  saved() {
    return {
      ...this.watcher.saved,
      pin: this.pin,
      pinnedUrl: this.pinnedUrl,
      pinnedToken: this.pinnedToken,
    };
  }

  save() {
    return this.store.save(this.saved());
  }

  /** Gladys reconnected (it restarted): send everything again. */
  async resync(config) {
    this.gladys.forgetPublishedStates?.();
    this.transports.clear();
    this.connection = null;
    this.discovered = null;
    await this.reconfigure(config);
  }

  async reconfigure(config) {
    const tokenChanged = config.token?.id !== this.config?.token?.id;
    if (config.url !== this.config?.url || tokenChanged) {
      // Another server: its states are recorded at the first read, not
      // announced as transitions, and its certificate is pinned afresh.
      if (this.config && config.url !== this.config.url) {
        this.watcher = new Watcher({ unreachable: false });
      }
      // A token carries the fingerprint of the server: it wins over trust on
      // first use, once (a later "Trust the server certificate again" stays).
      const token = config.token;
      if (config.url !== this.pinnedUrl) {
        this.pin = token?.fingerprint ?? null;
        this.pinnedUrl = config.url;
        this.pinnedToken = token?.id ?? null;
      } else if (token && token.id !== this.pinnedToken) {
        if (token.fingerprint) {
          this.pin = token.fingerprint;
        }
        this.pinnedToken = token.id;
      }
      this.refusedToken = null;
      this.cpuReads.clear();
      this.save();
      // A read in progress belongs to the previous configuration: ignored.
      this.generation += 1;
      this.polling = null;
      clearTimeout(this.retryTimer);
      this.resetRead();
      this.client = config.url && this.identity ? this.newClient(config.url) : null;
    }
    if (this.config?.language !== config.language || this.config?.name !== config.name) {
      this.discovered = null;
    }
    this.config = config;
    try {
      await this.pollNow({ publish: true });
    } finally {
      // Even after an unexpected failure: the readings must go on.
      this.schedulePoll();
    }
  }

  /** A client of the server at `url`, with the certificate pinned. */
  newClient(url) {
    const request = this.createTransport({
      url,
      identity: this.identity,
      pinning: {
        expected: () => this.pin,
        seen: (fingerprint) => {
          // A read of a previous configuration: not this server.
          if (url !== this.config?.url || this.pin) {
            return;
          }
          // Trusted on first use, kept under /data.
          this.pin = fingerprint;
          this.pinnedUrl = url;
          logger.info(`Server certificate pinned: ${fingerprint}`);
          this.save();
        },
      },
    });
    return new IncusClient({ request, timings: this.clientTimings });
  }

  /** "Trust the server certificate again": the next one presented is pinned. */
  async resetPin() {
    if (!this.client) {
      throw new ActionFailure(ACTION_TEXT.notConfigured);
    }
    logger.info('Server certificate pin cleared by the user');
    this.pin = null;
    this.save();
    await this.pollNow();
    if (this.error) {
      const { name } = this.config;
      throw new ActionFailure(
        allLanguages((language) => labelled(name, errorText(this.error, language), language)),
      );
    }
    return ACTION_TEXT.pinReset;
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.pollTimer);
    clearTimeout(this.retryTimer);
    await this.store.flush();
  }

  schedulePoll() {
    clearTimeout(this.pollTimer);
    if (!this.timersEnabled || this.stopped || !this.client) {
      return;
    }
    this.pollTimer = setTimeout(async () => {
      try {
        await this.pollNow();
        this.issues.ok('poll', 'Polling works again');
      } catch (err) {
        this.issues.fail('poll', 'error', 'Poll failed', err);
      }
      this.schedulePoll();
    }, this.config.pollIntervalMs);
  }

  scheduleRetry() {
    clearTimeout(this.retryTimer);
    if (!this.timersEnabled || this.stopped) {
      return;
    }
    this.retryTimer = setTimeout(() => {
      this.pollNow()
        .then(() => this.issues.ok('retry', 'Retry works again'))
        .catch((err) => this.issues.fail('retry', 'error', 'Retry failed', err));
    }, this.timings.retryMs);
    this.retryTimer.unref?.();
  }

  // --- Reading -------------------------------------------------------------------

  /** Read Incus and publish what changed. */
  async pollNow({ publish = false, fresh = false } = {}) {
    const widgetChanged = await this.poll({ fresh });
    await this.publishDevices({ force: publish });
    await this.publishStates();
    await this.publishTransports();
    await this.publishConnectionStatus();
    if (widgetChanged) {
      this.gladys.requestWidgetRefresh(WIDGET_KEY);
    }
  }

  /** Read Incus again when the last read is older than `freshMs`. */
  async refreshIfStale() {
    if (this.now() - this.readAt >= this.timings.freshMs) {
      await this.pollNow();
    }
  }

  /**
   * One read of Incus. Concurrent calls share it, except a `fresh` one: it
   * waits for the read in flight (started before an operation, it may show
   * the old state) and makes a new one.
   * @returns {Promise<boolean>} whether the widget should be refreshed now
   */
  async poll({ fresh = false } = {}) {
    if (!this.client) {
      return false;
    }
    if (fresh) {
      while (this.polling) {
        await this.polling.catch(() => {});
      }
    }
    if (!this.polling) {
      const generation = this.generation;
      const polling = this.read(generation).finally(() => {
        if (this.polling === polling) {
          this.polling = null;
        }
      });
      this.polling = polling;
    }
    return this.polling;
  }

  async read(generation) {
    let raw;
    try {
      raw = await this.readTrusted();
    } catch (err) {
      if (!(err instanceof IncusError)) {
        throw err;
      }
      return generation === this.generation ? this.applyFailure(err) : false;
    }
    return generation === this.generation ? this.applySuccess(raw) : false;
  }

  /**
   * Read the server; not trusted yet and a token configured: present it once
   * (Incus consumes it and trusts the certificate), then read again.
   */
  async readTrusted() {
    try {
      return await this.client.read();
    } catch (err) {
      const token = this.config.token;
      if (err?.kind !== ERROR_KINDS.UNTRUSTED || !token) {
        throw err;
      }
      if (this.refusedToken === token.id) {
        throw new IncusError(ERROR_KINDS.TOKEN_REFUSED, 'trust token already refused');
      }
      try {
        await this.client.trust(token.token);
      } catch (trustErr) {
        if (trustErr?.kind === ERROR_KINDS.TOKEN_REFUSED) {
          this.refusedToken = token.id;
        }
        throw trustErr;
      }
      logger.info(`${this.config.name}: the client certificate is now trusted`);
      return this.client.read();
    }
  }

  /** A fingerprint of what the widget shows: refreshed when it changes. */
  widgetKey(snapshot) {
    return JSON.stringify(snapshot.instances.map((i) => [instanceKey(i), i.status]));
  }

  /** CPU % of each running instance since the previous read. */
  measureCpu(snapshot, now) {
    const cpu = new Map();
    const reads = new Map();
    for (const instance of snapshot.instances) {
      const key = instanceKey(instance);
      if (instance.cpuNs === null) {
        continue;
      }
      const current = { cpuNs: instance.cpuNs, cpuThreads: instance.cpuThreads, at: now };
      cpu.set(key, cpuPercent(this.cpuReads.get(key), current));
      reads.set(key, current);
    }
    this.cpuReads = reads;
    this.cpu = cpu;
  }

  async applySuccess(raw) {
    const now = this.now();
    const snapshot = parseSnapshot(raw);
    const widgetChanged =
      this.error !== null ||
      this.readAt === 0 ||
      !this.snapshot ||
      this.widgetKey(this.snapshot) !== this.widgetKey(snapshot);
    if (this.error) {
      logger.info(`${this.config.name} answers again`);
    }
    if (this.snapshot?.version !== snapshot.version) {
      logger.info(
        `${this.config.name} (${hostOf(this.config.url)}): ${snapshot.product} ${
          snapshot.version
        }, ${snapshot.instances.length} instances`,
      );
    }
    this.measureCpu(snapshot, now);
    this.snapshot = snapshot;
    this.error = null;
    this.failures = 0;
    this.down = false;
    this.readAt = now;
    clearTimeout(this.retryTimer);

    const found = this.watcher.apply(snapshot, now);
    this.watcher.unreachable = false;
    for (const instance of found.stopped) {
      logger.debug(`${instanceLabel(instance)} stopped (${instance.status})`);
      const fired = await this.fireEvent(TRIGGERS.STOPPED, {
        instance: instanceDeviceId(this.gladys, instance),
        instance_name: instance.name,
        project: instance.project,
        status: instance.status,
      });
      if (!fired) {
        this.watcher.retry(instance);
      }
    }
    this.save();
    return widgetChanged;
  }

  async applyFailure(err) {
    const wasError = this.error?.kind;
    this.error = { kind: err.kind, message: err.message };
    this.readAt = this.now();
    if (wasError !== err.kind) {
      logger.warn(`${this.config.name}: ${err.message}`);
    } else {
      logger.debug(`${this.config.name}: ${err.message}`);
    }
    // Only silence counts as unreachable: a wrong address is a configuration
    // problem, reported by the connection status.
    if (err.kind !== ERROR_KINDS.UNREACHABLE) {
      this.failures = 0;
      return wasError !== err.kind;
    }
    this.failures += 1;
    if (this.failures === 1) {
      this.scheduleRetry();
    }
    if (!this.down && this.failures >= this.timings.downAfterFailures) {
      this.down = true;
      // Already announced before a restart of the integration: not again.
      if (!this.watcher.unreachable) {
        const fired = await this.fireEvent(TRIGGERS.UNREACHABLE, {
          host_name: this.config.name,
        });
        if (fired) {
          this.watcher.unreachable = true;
          this.save();
        } else {
          this.down = false; // announced at the next failed read
        }
      }
      return true;
    }
    return wasError !== err.kind;
  }

  /** @returns {Promise<boolean>} whether Gladys accepted the event */
  async fireEvent(key, data) {
    try {
      await this.gladys.publishSceneEvent(key, data);
      this.issues.ok('scene', 'Scene events accepted again');
      return true;
    } catch (err) {
      this.issues.fail('scene', 'warn', `Scene event ${key} refused: ${err.message}`);
      return false;
    }
  }

  // --- Devices -----------------------------------------------------------------

  /** Every device the last snapshot proposes, with its item. */
  items() {
    const { snapshot } = this;
    if (!snapshot) {
      return [];
    }
    return [
      {
        type: DEVICE_TYPES.HOST,
        key: HOST_ID,
        name: this.config.name,
        item: { snapshot, totals: totals(snapshot) },
      },
      ...snapshot.instances.map((instance) => ({
        type: DEVICE_TYPES.INSTANCE,
        key: instanceKey(instance),
        name: instanceLabel(instance),
        model: instance.type,
        item: { instance, cpu: this.cpu.get(instanceKey(instance)) ?? null },
      })),
    ];
  }

  discoveredDevices() {
    return this.items().map((entry) =>
      buildDevice(this.gladys, { ...entry, language: this.config.language }),
    );
  }

  /** Publish the Discovery list when it changed (an instance created, deleted…). */
  async publishDevices({ force = false } = {}) {
    if (!this.snapshot && !force) {
      return;
    }
    const devices = this.discoveredDevices();
    const key = JSON.stringify(devices);
    if (!force && key === this.discovered) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.discovered = key;
      this.issues.ok('discovery', 'Discovered devices accepted again');
    } catch (err) {
      this.issues.fail('discovery', 'warn', `Discovered devices refused: ${err.message}`);
    }
  }

  /** "Search" in the Discovery tab: read Incus, publish the list again. */
  async rediscover() {
    await this.pollNow({ publish: true });
  }

  /** The devices of this integration the user added, with their parsed identity. */
  createdDevices() {
    const devices = [];
    for (const device of this.gladys.devices ?? []) {
      const parsed = parseDeviceId(this.gladys, device.external_id);
      if (parsed) {
        devices.push({ device, ...parsed });
      }
    }
    return devices;
  }

  /** The item a device stands for in the last snapshot, null when gone. */
  itemFor(type, key) {
    return this.items().find((entry) => entry.type === type && entry.key === key)?.item ?? null;
  }

  /** The user added (or updated) a device: Gladys dropped the states sent before. */
  async onDeviceCreated(device) {
    if (!parseDeviceId(this.gladys, device.external_id)) {
      return;
    }
    // The SDK forgot the states of this device: they go again.
    this.transports.delete(device.external_id);
    await this.publishStates();
    await this.publishTransports();
    this.gladys.requestWidgetRefresh(WIDGET_KEY);
  }

  onDeviceDeleted(device) {
    if (typeof device?.external_id === 'string') {
      this.transports.delete(device.external_id);
    }
    this.gladys.requestWidgetRefresh(WIDGET_KEY);
  }

  // --- Publishing to Gladys ----------------------------------------------------------

  /** The states of the added devices, the changed ones (deduplicated by the SDK). */
  async publishStates() {
    if (!this.snapshot && !this.down) {
      return;
    }
    const states = [];
    for (const { device, type, key } of this.createdDevices()) {
      let values;
      if (this.error) {
        // Nothing read: only say the machine is unreachable, once it is.
        if (!(this.down && type === DEVICE_TYPES.HOST)) {
          continue;
        }
        values = featureValues(type, null, { reachable: false });
      } else {
        values = featureValues(type, this.itemFor(type, key));
      }
      const ids = deviceIds(this.gladys, type, key);
      // Only the features the device has in Gladys.
      const known = Array.isArray(device.features)
        ? new Set(device.features.map((feature) => feature.external_id))
        : null;
      for (const [featureKey, value] of Object.entries(values)) {
        const externalId = ids.feature(featureKey);
        if (value === null || (known && !known.has(externalId))) {
          continue;
        }
        states.push(
          typeof value === 'string'
            ? { device_feature_external_id: externalId, text: value }
            : { device_feature_external_id: externalId, state: value },
        );
      }
    }
    if (states.length === 0) {
      return;
    }
    try {
      await this.gladys.publishChangedStates(states, { heartbeat: this.timings.heartbeatMs });
      this.issues.ok('states', 'States accepted again');
    } catch (err) {
      this.issues.fail('states', 'warn', `States refused: ${err.message}`);
    }
  }

  /** The badge of the added devices: "local", or "unreachable" while Incus fails. */
  async publishTransports() {
    if (this.readAt === 0) {
      return;
    }
    const entries = [];
    for (const { device, type, key } of this.createdDevices()) {
      // An instance deleted from the server is unreachable too.
      const reachable =
        this.error === null && (type === DEVICE_TYPES.HOST || this.itemFor(type, key) !== null);
      const transport = reachable ? DEVICE_TRANSPORTS.LOCAL : DEVICE_TRANSPORTS.UNREACHABLE;
      if (this.transports.get(device.external_id) !== transport) {
        entries.push({ external_id: device.external_id, transport });
      }
    }
    for (let at = 0; at < entries.length; at += MAX_TRANSPORTS_PER_REQUEST) {
      const batch = entries.slice(at, at + MAX_TRANSPORTS_PER_REQUEST);
      try {
        await this.gladys.publishTransports(batch);
        for (const entry of batch) {
          this.transports.set(entry.external_id, entry.transport);
        }
        this.issues.ok('transports', 'Transports accepted again');
      } catch (err) {
        this.issues.fail('transports', 'warn', `Transports refused: ${err.message}`);
      }
    }
  }

  /** What the configuration lacks, as a multi-language message; null when complete. */
  configProblem() {
    const config = this.config;
    if (config?.problems.length) {
      return allLanguages((language) =>
        config.problems.map((problem) => pick(CONNECTION_TEXT[problem], language)).join('\n'),
      );
    }
    if (!config?.url) {
      return CONNECTION_TEXT.noUrl;
    }
    return null;
  }

  /** The status under the integration name. */
  connectionStatus() {
    const problem = this.configProblem();
    if (problem) {
      return { connected: false, message: problem };
    }
    if (this.error) {
      return {
        connected: false,
        message: allLanguages((language) => errorText(this.error, language)),
      };
    }
    return { connected: true };
  }

  async publishConnectionStatus() {
    const status = this.connectionStatus();
    const key = JSON.stringify(status);
    if (key === this.connection) {
      return;
    }
    try {
      await this.gladys.setConnectionStatus(status.connected, status.message);
      this.connection = key;
      this.issues.ok('connection', 'Connection status accepted again');
    } catch (err) {
      this.issues.fail('connection', 'warn', `Connection status refused: ${err.message}`);
    }
  }

  // --- Views and operations -------------------------------------------------------

  /** What the widget shows of the machine. */
  view() {
    return {
      name: this.config?.name ?? '',
      online: this.error === null && this.snapshot !== null,
      error: this.error,
      snapshot: this.snapshot,
      totals: this.snapshot ? totals(this.snapshot) : null,
    };
  }

  /** The name given in Gladys to a device, `fallback` when it was not added. */
  gladysName(externalId, fallback) {
    const device = (this.gladys.devices ?? []).find((entry) => entry.external_id === externalId);
    return typeof device?.name === 'string' && device.name.trim() ? device.name : fallback;
  }

  /** "Test the connection": read Incus now and say what was found. */
  async testConnection() {
    await this.pollNow({ publish: true });
    const problem = this.configProblem();
    if (problem) {
      throw new ActionFailure(problem);
    }
    const { name } = this.config;
    if (this.error) {
      throw new ActionFailure(
        allLanguages((language) => labelled(name, errorText(this.error, language), language)),
      );
    }
    const { snapshot } = this;
    const { running, total } = totals(snapshot);
    return allLanguages((language) => {
      const text = REPORT_TEXT[language];
      const parts = [
        text.ok,
        `${snapshot.product} ${snapshot.version}`.trim(),
        text.instances(running, total),
      ];
      return labelled(name, parts.join(', '), language);
    });
  }

  /**
   * The instance a device external id (the `source: "devices"` selects) or
   * an instance label (`name`, `project/name`) stands for, in a fresh read.
   */
  async resolveInstance(target) {
    if (!this.client) {
      throw new ActionFailure(ACTION_TEXT.notConfigured);
    }
    if (typeof target !== 'string' || !target.trim()) {
      throw new ActionFailure(ACTION_TEXT.noInstance);
    }
    await this.refreshIfStale();
    if (this.error || !this.snapshot) {
      throw new ActionFailure(
        allLanguages((language) =>
          labelled(
            pick(ACTION_TEXT.unreadable, language),
            errorText(this.error, language),
            language,
          ),
        ),
      );
    }
    const wanted = target.trim();
    const parsed = parseDeviceId(this.gladys, wanted);
    const instance = parsed
      ? parsed.type === DEVICE_TYPES.INSTANCE &&
        this.snapshot.instances.find((i) => instanceKey(i) === parsed.key)
      : this.snapshot.instances.find((i) => instanceLabel(i) === wanted);
    if (!instance) {
      throw new ActionFailure(ACTION_TEXT.unknownInstance);
    }
    return instance;
  }

  /**
   * Start, stop or restart an instance, then read Incus again so that the
   * switch, the widget and the outputs show the new state. Nothing is sent
   * when the instance already is in the state asked; a restart of a stopped
   * instance starts it, a start of a paused one resumes it.
   * @param {string} target a device external id or an instance label
   * @param {string} operation an OPERATIONS value
   * @returns {Promise<{ name: string, project: string, running: boolean, message: object }>}
   */
  async operate(target, operation) {
    const instance = await this.resolveInstance(target);
    const label = instanceLabel(instance);
    const display = this.gladysName(instanceDeviceId(this.gladys, instance), label);
    const frozen = instance.status === STATUS.FROZEN;
    let action = operation;
    let done = true;
    if (operation === OPERATIONS.START && instance.running) {
      done = false;
    } else if (operation === OPERATIONS.STOP && !instance.running && !frozen) {
      done = false;
    } else if (operation === OPERATIONS.START && frozen) {
      action = UNFREEZE;
    } else if (operation === OPERATIONS.RESTART && !instance.running) {
      action = frozen ? UNFREEZE : OPERATIONS.START;
    }
    const outcome = operation === OPERATIONS.RESTART && action !== operation ? 'already' : 'done';
    if (done) {
      if (operation !== OPERATIONS.START) {
        this.watcher.expect(instance, this.now());
      }
      try {
        await this.client.control(instance.name, instance.project, action);
      } catch (err) {
        this.watcher.done(instance);
        if (!(err instanceof IncusError)) {
          throw err;
        }
        logger.warn(
          `${operation} ${label} failed: ${err.message}${err.cause ? ` (${err.cause})` : ''}`,
        );
        const cause = err.cause ? `: ${err.cause.slice(0, 90)}` : '';
        throw new ActionFailure(
          allLanguages((language) =>
            labelled(
              display,
              `${OPERATION_TEXT[language].failed}, ${errorText(err, language)}${cause}`,
              language,
            ),
          ),
        );
      }
      await this.pollNow({ fresh: true });
      // Read back: no more expectation. Unread (Incus silent), the
      // expectation runs out by itself, so the stop is never announced.
      if (!this.error) {
        this.watcher.done(instance);
      }
    }
    logger.info(`${operation} ${label}${done ? '' : ' (nothing to do)'}`);
    const key = instanceKey(instance);
    const now = this.snapshot?.instances.find((i) => instanceKey(i) === key);
    return {
      name: instance.name,
      project: instance.project,
      running: now ? now.running : operation !== OPERATIONS.STOP,
      message: allLanguages((language) =>
        labelled(
          display,
          OPERATION_TEXT[language][operation][done ? outcome : 'already'],
          language,
        ),
      ),
    };
  }

  /** The switch of an instance device: 1 starts it, 0 stops it. */
  async setRunning(device, value) {
    const operation = Number(value) === 1 ? OPERATIONS.START : OPERATIONS.STOP;
    await this.operate(device.external_id, operation);
  }
}
