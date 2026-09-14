/*
 * Every compiled module under .test-build carries its own module-level
 * mutable state (state.js's `state` object, fallback.js's two cursors,
 * duck.js's id counter, bridge.js's boardWaiters...). require() caches by
 * filename, so two "boot a fresh instance" scenarios back to back would
 * otherwise share one copy of all of that. Clearing the require cache before
 * each boot is the CommonJS stand-in for what `new Function(source)()` gave
 * for free before the split: a brand new module graph, every time.
 */
const path = require('path');

const BUILD = path.join(__dirname, '..', '..', '.test-build');

function clearBuildCache() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(BUILD)) delete require.cache[key];
  }
}

module.exports = { BUILD, clearBuildCache };
