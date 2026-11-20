// -----------------------------------------------------------------------------
// Raw answers of the Incus API -> one snapshot the rest of the code reads.
//
// Field notes (Incus `shared/api/instance.go`, `instance_state.go`):
//   - `status` is Running, Stopped, Frozen (paused) or Error, among a few
//     transient ones (Starting, Stopping…);
//   - `type` is `container` or `virtual-machine`;
//   - `project` is there with `all-projects=true`, `default` otherwise;
//   - `state.cpu.usage` is the CPU time used since the start, in
//     nanoseconds: a percentage needs two reads;
//   - `state.memory.usage` is in bytes;
//   - `state.network` holds the interfaces (`lo` too) and their addresses,
//     `scope: "global"` for the routable ones. A VM reports them only with
//     its agent (`incus-agent`) running.
// -----------------------------------------------------------------------------

export const INSTANCE_TYPES = Object.freeze({
  CONTAINER: 'container',
  VM: 'virtual-machine',
});

export const STATUS = Object.freeze({
  RUNNING: 'Running',
  STOPPED: 'Stopped',
  FROZEN: 'Frozen',
  ERROR: 'Error',
});

export const DEFAULT_PROJECT = 'default';

const nonNegative = (value) => (Number.isFinite(value) && value >= 0 ? value : null);

/** The first global IPv4 address, else the first global IPv6 one, else null. */
export function mainAddress(network) {
  if (!network || typeof network !== 'object') {
    return null;
  }
  const addresses = Object.entries(network)
    .filter(([name]) => name !== 'lo')
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([, iface]) => (Array.isArray(iface?.addresses) ? iface.addresses : []))
    .filter((entry) => entry?.scope === 'global' && typeof entry.address === 'string');
  const pick =
    addresses.find((entry) => entry.family === 'inet') ??
    addresses.find((entry) => entry.family === 'inet6');
  return pick?.address ?? null;
}

/**
 * The CPU threads an instance may use: `limits.cpu` ("2", "0-3", "1,3"), or
 * every thread of the host.
 */
export function cpuLimit(config, hostThreads) {
  const raw = config?.['limits.cpu'];
  if (typeof raw === 'string' && raw.trim()) {
    const text = raw.trim();
    if (/^\d+$/.test(text)) {
      return Number(text) || hostThreads;
    }
    let count = 0;
    for (const part of text.split(',')) {
      const range = part.trim().match(/^(\d+)(?:-(\d+))?$/);
      if (!range) {
        return hostThreads;
      }
      count += range[2] === undefined ? 1 : Math.max(0, Number(range[2]) - Number(range[1]) + 1);
    }
    return count || hostThreads;
  }
  return hostThreads;
}

/**
 * The CPU an instance may use, in threads: `state.cpu.allocated_time` when
 * Incus gives it (ns of CPU per second, from the effective CPUs and the CFS
 * quota, extension `instance_state_cpu_time`), else `limits.cpu`, else one
 * vCPU for a VM (the QEMU default of Incus) and every host thread for a
 * container.
 */
export function cpuThreads(raw, state, hostThreads) {
  const allocated = state?.cpu?.allocated_time;
  if (Number.isFinite(allocated) && allocated > 0) {
    return allocated / 1e9;
  }
  const config = raw.expanded_config ?? raw.config;
  if (raw.type === INSTANCE_TYPES.VM && !config?.['limits.cpu']) {
    return 1;
  }
  return cpuLimit(config, hostThreads);
}

/** One instance of the list, null when unusable. */
export function parseInstance(raw, hostThreads = null) {
  if (!raw || typeof raw !== 'object' || typeof raw.name !== 'string' || !raw.name) {
    return null;
  }
  const status = typeof raw.status === 'string' ? raw.status : 'Unknown';
  const running = status === STATUS.RUNNING;
  const state = raw.state && typeof raw.state === 'object' ? raw.state : {};
  return {
    name: raw.name,
    project: typeof raw.project === 'string' && raw.project ? raw.project : DEFAULT_PROJECT,
    type: raw.type === INSTANCE_TYPES.VM ? INSTANCE_TYPES.VM : INSTANCE_TYPES.CONTAINER,
    status,
    running,
    location: typeof raw.location === 'string' && raw.location !== 'none' ? raw.location : '',
    cpuNs: running ? nonNegative(state.cpu?.usage) : null,
    cpuThreads: cpuThreads(raw, state, hostThreads),
    memoryBytes: running ? nonNegative(state.memory?.usage) : null,
    address: running ? mainAddress(state.network) : null,
  };
}

/** A unique, readable label: `name`, or `project/name` outside the default project. */
export const instanceLabel = (instance) =>
  instance.project === DEFAULT_PROJECT ? instance.name : `${instance.project}/${instance.name}`;

/**
 * @param {{ product: string, version: string, cpuThreads: number|null, instances: object[] }} raw
 *   what IncusClient.read returned
 */
export function parseSnapshot(raw) {
  const instances = (raw.instances ?? [])
    .map((entry) => parseInstance(entry, raw.cpuThreads ?? null))
    .filter(Boolean)
    .sort((a, b) => instanceLabel(a).localeCompare(instanceLabel(b)));
  return { product: raw.product, version: raw.version, instances };
}

/** The figures of the server device, the widget and the report. */
export function totals(snapshot) {
  const { instances } = snapshot;
  return {
    total: instances.length,
    running: instances.filter((i) => i.running).length,
  };
}

/**
 * CPU use between two reads, in % of the threads the instance may use.
 * @returns {number|null} rounded to 0.1, null without a previous read
 */
export function cpuPercent(previous, current) {
  if (
    !previous ||
    previous.cpuNs === null ||
    current.cpuNs === null ||
    current.cpuNs < previous.cpuNs ||
    current.at <= previous.at
  ) {
    return null;
  }
  const threads = current.cpuThreads || 1;
  const percent =
    ((current.cpuNs - previous.cpuNs) / ((current.at - previous.at) * 1e6 * threads)) * 100;
  return Math.round(Math.min(100, Math.max(0, percent)) * 10) / 10;
}
