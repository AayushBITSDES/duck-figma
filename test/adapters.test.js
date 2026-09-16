/*
 * Entry point for `npm test`. Each file below runs against the COMPILED
 * output in .test-build (see package.json's test script), not a
 * reimplementation, so they break when the real code drifts. Split by module
 * boundary:
 *   - api.test.js      state.js, providers.js, api.js, fallback.js (no DOM)
 *   - render.test.js   the markdown renderer and the dash normalizer
 *   - screens.test.js  screens.js and bridge.js, the DOM-touching modules
 *   - plugin.test.js   the FigJam-side plugin: code.js and friends
 */
const { counts } = require('./lib/check');
const runApi = require('./api.test');
const runRender = require('./render.test');
const runScreens = require('./screens.test');
const runPlugin = require('./plugin.test');

async function main() {
  await runApi();
  await runRender();
  await runScreens();
  await runPlugin();
  const { passed, failed } = counts();
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
}

main();
