// -----------------------------------------------------------------------------
// Scene action handlers (manifest `scene_actions`, Gladys 5.1+): start, stop
// or restart an instance chosen among the instance devices. "Is it running?"
// is already a scene condition on the device's switch; these actions are what
// a condition cannot do, with the state read back from Incus as an output.
// A failure throws (the scene logs it and goes on).
// -----------------------------------------------------------------------------

import { OPERATIONS } from './incus/client.js';

const run =
  (operation) =>
  async (hub, { fields }) => {
    const result = await hub.operate(fields?.instance, operation);
    return { instance_name: result.name, running: result.running };
  };

export const SCENE_ACTIONS = {
  start_instance: run(OPERATIONS.START),
  stop_instance: run(OPERATIONS.STOP),
  restart_instance: run(OPERATIONS.RESTART),
};
