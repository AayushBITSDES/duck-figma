/*
 * Entry point for `npm test`. Each file below runs against the COMPILED
 * output in .test-build (see package.json's test script), not a
 * reimplementation, so they break when the real code drifts. Split by module
 * boundary:
 *   - session.test.js  ui/session.js WebSocket client (no live Worker)
 *   - render.test.js   the markdown renderer and the dash normalizer
 *   - screens.test.js  screens.js and bridge.js, the DOM-touching modules
 *   - plugin.test.js   the FigJam-side plugin: code.js and friends
 */
const { counts } = require('./lib/check');
const { clearPendingTimers } = require('./lib/fresh');
const runSession = require('./session.test');
const runRender = require('./render.test');
const runScreens = require('./screens.test');
const runPlugin = require('./plugin.test');

async function main() {
  await runSession();
  await runRender();
  await runScreens();
  await runPlugin();
  clearPendingTimers();
  const { passed, failed } = counts();
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
}

main();
