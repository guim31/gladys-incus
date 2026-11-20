// -----------------------------------------------------------------------------
// The transition behind the scene trigger "instance stopped unexpectedly",
// read after read: an instance running at the previous read, and Stopped or
// in Error now, without Gladys asking (a crash, an out-of-memory kill, a
// shutdown inside the guest, `incus stop` by hand). A pause (Frozen) is not
// a stop; an instance deleted is not announced either.
//
// A stop or a restart asked through Gladys (switch, action, widget, scene)
// is expected: it fires nothing — a scene stopping an instance must not
// trigger itself.
//
// The state is saved under /data (src/store.js): a restart of the integration
// neither misses a transition nor announces one twice. The very first read
// (nothing saved) only records the states, without events.
// -----------------------------------------------------------------------------

import { STATUS } from './incus/model.js';
import { instanceKey } from './devices.js';

export const ALERT_TIMINGS = {
  // An operation asked through Gladys stays expected this long at most.
  expectedForMs: 10 * 60_000,
  // An instance gone for that long is forgotten.
  forgetAfterMs: 7 * 24 * 3600_000,
};

const STOPPED = new Set([STATUS.STOPPED, STATUS.ERROR]);

export class Watcher {
  /** @param {object} [saved] what `saved` returned before (src/store.js) */
  constructor(saved = {}, timings = {}) {
    this.timings = { ...ALERT_TIMINGS, ...timings };
    this.seeded = saved.seeded === true;
    this.instances = { ...saved.instances };
    // The server announced unreachable: not announced again after a restart.
    this.unreachable = saved.unreachable === true;
    // key -> until (ms): operations asked through Gladys, in memory only.
    this.expected = new Map();
  }

  /** What to save under /data. */
  get saved() {
    return { seeded: this.seeded, instances: this.instances, unreachable: this.unreachable };
  }

  /** Gladys is about to stop or restart this instance: no event for it. */
  expect(instance, now) {
    this.expected.set(instanceKey(instance), now + this.timings.expectedForMs);
  }

  /** The operation asked through Gladys is over, and read back. */
  done(instance) {
    this.expected.delete(instanceKey(instance));
  }

  /** Gladys refused the event: the next read announces it again. */
  retry(instance) {
    const entry = this.instances[instanceKey(instance)];
    if (entry) {
      entry.running = true;
    }
  }

  /**
   * Compare a snapshot with the previous one.
   * @returns {{ stopped: object[] }} the transitions to announce
   */
  apply(snapshot, now) {
    const found = { stopped: [] };
    const seen = new Set();
    for (const instance of snapshot.instances) {
      const key = instanceKey(instance);
      seen.add(key);
      const previous = this.instances[key];
      const until = this.expected.get(key);
      const expected = until !== undefined && until > now;
      if (until !== undefined && !expected) {
        this.expected.delete(key);
      }
      if (this.seeded && previous?.running && STOPPED.has(instance.status) && !expected) {
        found.stopped.push(instance);
      }
      this.instances[key] = { running: instance.running, seenAt: now };
    }
    for (const [key, entry] of Object.entries(this.instances)) {
      if (!seen.has(key)) {
        // Deleted: an instance created again under that name starts afresh.
        entry.running = false;
        if (now - (entry.seenAt ?? 0) > this.timings.forgetAfterMs) {
          delete this.instances[key];
        }
      }
    }
    this.seeded = true;
    return found;
  }
}
