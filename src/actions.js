// -----------------------------------------------------------------------------
// Manifest actions (buttons of the Configuration screen). Gladys shows in
// green what a handler returns and in red what it throws: every failure
// (nothing configured, no instance chosen, Incus silent or refusing) throws
// an ActionFailure (src/texts.js).
// -----------------------------------------------------------------------------

import { OPERATIONS } from './incus/client.js';

const run = (operation) => async (hub, fields) =>
  (await hub.operate(fields?.instance, operation)).message;

export const ACTIONS = {
  test_connection: (hub) => hub.testConnection(),
  trust_server_again: (hub) => hub.resetPin(),
  start_instance: run(OPERATIONS.START),
  stop_instance: run(OPERATIONS.STOP),
  restart_instance: run(OPERATIONS.RESTART),
};
