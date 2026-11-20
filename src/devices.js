// -----------------------------------------------------------------------------
// The Gladys devices of an Incus (or LXD) server, proposed in the Discovery
// tab: the user adds the ones to follow, nothing is created on their behalf.
//
//   - the server: reachable, version, instances running, instances in total;
//   - one device per instance (container or virtual machine): running (a
//     switch: on = start, off = stop), CPU and memory used, main IP address.
//
// Identity: the instance NAME and its project (`name` in the default project,
// `project.name` elsewhere: an Incus name has no dot), not its volatile UUID.
// An instance rebuilt under the same name keeps its device, its history and
// its scenes. Kept as is up to 64 characters, hashed beyond.
//
// Published with should_poll: false: the hub reads Incus on its own timer
// (src/hub.js), at the interval chosen in the configuration.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import {
  DEVICE_FEATURE_CATEGORIES as CATEGORY,
  DEVICE_FEATURE_TYPES as TYPE,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { DEFAULT_PROJECT, INSTANCE_TYPES } from './incus/model.js';

export const DEVICE_TYPES = Object.freeze({
  HOST: 'host',
  INSTANCE: 'instance',
});

// The platform id of the one host device.
export const HOST_ID = 'main';

// Suffixes of the feature external ids: permanent once published.
export const FEATURE_KEYS = Object.freeze({
  REACHABLE: 'reachable',
  VERSION: 'version',
  INSTANCES_RUNNING: 'instances_running',
  INSTANCES_TOTAL: 'instances_total',
  RUNNING: 'running',
  CPU: 'cpu',
  MEMORY: 'memory',
  ADDRESS: 'address',
});

const K = FEATURE_KEYS;

// Feature names, in the language chosen in the configuration (Gladys does not
// tell a device integration the user's language). Frozen at creation in Gladys.
export const NAMES = {
  en: {
    [K.REACHABLE]: 'Reachable',
    [K.VERSION]: 'Version',
    [K.INSTANCES_RUNNING]: 'Instances running',
    [K.INSTANCES_TOTAL]: 'Instances',
    [K.RUNNING]: 'Running',
    [K.CPU]: 'CPU',
    [K.MEMORY]: 'Memory',
    [K.ADDRESS]: 'IP address',
  },
  fr: {
    [K.REACHABLE]: 'Joignable',
    [K.VERSION]: 'Version',
    [K.INSTANCES_RUNNING]: 'Instances en marche',
    [K.INSTANCES_TOTAL]: 'Instances',
    [K.RUNNING]: 'En marche',
    [K.CPU]: 'Processeur',
    [K.MEMORY]: 'Mémoire',
    [K.ADDRESS]: 'Adresse IP',
  },
  de: {
    [K.REACHABLE]: 'Erreichbar',
    [K.VERSION]: 'Version',
    [K.INSTANCES_RUNNING]: 'Laufende Instanzen',
    [K.INSTANCES_TOTAL]: 'Instanzen',
    [K.RUNNING]: 'Läuft',
    [K.CPU]: 'Prozessor',
    [K.MEMORY]: 'Arbeitsspeicher',
    [K.ADDRESS]: 'IP-Adresse',
  },
  es: {
    [K.REACHABLE]: 'Accesible',
    [K.VERSION]: 'Versión',
    [K.INSTANCES_RUNNING]: 'Instancias en marcha',
    [K.INSTANCES_TOTAL]: 'Instancias',
    [K.RUNNING]: 'En marcha',
    [K.CPU]: 'Procesador',
    [K.MEMORY]: 'Memoria',
    [K.ADDRESS]: 'Dirección IP',
  },
};

export const MODELS = {
  [DEVICE_TYPES.HOST]: 'Incus server',
  [INSTANCE_TYPES.CONTAINER]: 'Incus container',
  [INSTANCE_TYPES.VM]: 'Incus virtual machine',
};

// Display bounds (the core never applies them on write).
export const COUNT_MAX = 100000;
// 1 TiB in MB.
export const MEMORY_MAX_MB = 1048576;

const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const HASHED_KEY = /^h[0-9a-f]{12}$/;

/** The platform id of an instance: `name` or `project.name` when safe, hashed otherwise. */
export function instanceKey({ name, project = DEFAULT_PROJECT }) {
  const raw = project === DEFAULT_PROJECT ? name : `${project}.${name}`;
  if (SAFE_KEY.test(raw) && !HASHED_KEY.test(raw)) {
    return raw;
  }
  return `h${createHash('sha1').update(`${project}/${name}`).digest('hex').slice(0, 12)}`;
}

/** External ids of a device. */
export const deviceIds = (gladys, type, key = HOST_ID) => gladys.externalIds(type, key);

/** The device external id of an instance. */
export const instanceDeviceId = (gladys, instance) =>
  deviceIds(gladys, DEVICE_TYPES.INSTANCE, instanceKey(instance)).device;
/**
 * The type and key of a device external id, null when not ours.
 * @returns {{ type: string, key: string }|null}
 */
export function parseDeviceId(gladys, externalId) {
  if (typeof externalId !== 'string') {
    return null;
  }
  for (const type of Object.values(DEVICE_TYPES)) {
    const prefix = gladys.externalIds(type, '').device;
    if (externalId.startsWith(prefix)) {
      const key = externalId.slice(prefix.length);
      return SAFE_KEY.test(key) ? { type, key } : null;
    }
  }
  return null;
}

const counter = (key) => ({
  key,
  category: CATEGORY.COUNTER_SENSOR,
  type: TYPE.SENSOR.INTEGER,
  read_only: true,
  has_feedback: false,
  min: 0,
  max: COUNT_MAX,
});
const text = (key) => ({
  key,
  category: CATEGORY.TEXT,
  type: TYPE.TEXT.TEXT,
  read_only: true,
  has_feedback: false,
  min: 0,
  max: 0,
});
const binary = (key) => ({
  key,
  category: CATEGORY.INPUT,
  type: TYPE.SENSOR.BINARY,
  read_only: true,
  has_feedback: false,
  min: 0,
  max: 1,
});

/** The features of a device type. */
export function featureDefinitions(type) {
  if (type === DEVICE_TYPES.HOST) {
    return [
      binary(K.REACHABLE),
      text(K.VERSION),
      counter(K.INSTANCES_RUNNING),
      counter(K.INSTANCES_TOTAL),
    ];
  }
  return [
    {
      key: K.RUNNING,
      category: CATEGORY.SWITCH,
      type: TYPE.SWITCH.BINARY,
      // Commanded: on starts the instance, off stops it; the state read
      // back from Incus confirms it.
      read_only: false,
      has_feedback: true,
      min: 0,
      max: 1,
    },
    {
      // No generic percentage category in the core: the fill-level couple,
      // as gladys-glances does for its CPU, with its 0-100 gauge.
      key: K.CPU,
      category: CATEGORY.LEVEL_SENSOR,
      type: TYPE.LEVEL_SENSOR.LIQUID_LEVEL_PERCENT,
      unit: DEVICE_FEATURE_UNITS.PERCENT,
      read_only: true,
      has_feedback: false,
      min: 0,
      max: 100,
    },
    {
      key: K.MEMORY,
      category: CATEGORY.DATA,
      type: TYPE.DATA.SIZE,
      unit: DEVICE_FEATURE_UNITS.MEGABYTE,
      read_only: true,
      has_feedback: false,
      min: 0,
      max: MEMORY_MAX_MB,
    },
    text(K.ADDRESS),
  ];
}

/**
 * A device of the Discovery tab.
 * @param {object} gladys
 * @param {object} entry
 * @param {string} entry.type a DEVICE_TYPES value
 * @param {string} entry.key the platform id (HOST_ID for the server)
 * @param {string} entry.name the device name proposed
 * @param {string} [entry.model] MODELS key (the instance type)
 * @param {string} entry.language feature-name language
 */
export function buildDevice(gladys, { type, key, name, model, language }) {
  const ids = deviceIds(gladys, type, key);
  const names = NAMES[language] ?? NAMES.en;
  return {
    name,
    external_id: ids.device,
    model: MODELS[model ?? type],
    should_poll: false,
    features: featureDefinitions(type).map(({ key: featureKey, ...definition }) => ({
      name: names[featureKey],
      external_id: ids.feature(featureKey),
      ...definition,
    })),
  };
}

/**
 * The values of a device, `null` when unknown (not sent).
 * @param {string} type a DEVICE_TYPES value
 * @param {object|null} item the server `{ snapshot, totals }` or the instance
 *   `{ instance, cpu }`; null when gone
 * @returns {Record<string, number|string|null>} by feature key
 */
export function featureValues(type, item, { reachable = true } = {}) {
  if (type === DEVICE_TYPES.HOST) {
    if (!reachable || !item) {
      return { [K.REACHABLE]: 0 };
    }
    const { snapshot, totals } = item;
    return {
      [K.REACHABLE]: 1,
      [K.VERSION]: snapshot.version ? `${snapshot.product} ${snapshot.version}` : null,
      [K.INSTANCES_RUNNING]: totals.running,
      [K.INSTANCES_TOTAL]: totals.total,
    };
  }
  if (!item) {
    // An instance deleted: it no longer runs.
    return { [K.RUNNING]: 0 };
  }
  const { instance, cpu } = item;
  if (!instance.running) {
    // Stopped: nothing used. The address stays the last one shown.
    return { [K.RUNNING]: 0, [K.CPU]: 0, [K.MEMORY]: 0 };
  }
  return {
    [K.RUNNING]: 1,
    [K.CPU]: cpu,
    [K.MEMORY]:
      instance.memoryBytes === null ? null : Math.round((instance.memoryBytes / 1048576) * 10) / 10,
    [K.ADDRESS]: instance.address,
  };
}
