/*
 * Runs the bundle tests: the ones that exercise dist/ rather than src/.
 *
 * Separate from `npm test` because these need `npm run build` to have run
 * first, and because they answer a different question. The unit tests compile
 * src/ to CommonJS and call its exports. These load the webpack ESM bundle
 * that FigJam actually loads, in a real DOM, and drive it with real pointer
 * and click events over a fake session WebSocket. A circular import that
 * resolves fine under CommonJS, or a control wired with addEventListener
 * that no exported function touches, is invisible to the unit tests and
 * caught here.
 */
const fs = require('fs');
const path = require('path');
const { counts } = require('../lib/check');

const DIST = path.join(__dirname, '..', '..', 'dist');

async function main() {
  for (const f of ['ui.html', 'code.js']) {
    if (!fs.existsSync(path.join(DIST, f))) {
      console.error('dist/' + f + ' is missing. Run `npm run build` first.');
      process.exit(1);
    }
  }
  await require('./boots.test.js')();
  await require('./controls.test.js')();
  const { passed, failed } = counts();
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
