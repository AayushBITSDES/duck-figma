/*
 * Every compiled module under .test-build carries its own module-level
 * mutable state (state.js's `state` object, session.js's socket generation,
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

/*
 * window.ts debounces its clientStorage write with a real setTimeout, and
 * ui/session.ts schedules reconnects, a board-wait timeout, and a ping
 * interval the same way. Those callbacks read `figma` / module state off the
 * global at the moment they fire rather than at the moment they were
 * scheduled. That's fine in a real plugin sandbox, where there is only ever
 * one `figma`, but this test process reassigns global.figma on every
 * bootPlugin() call. A timer left running by one boot would otherwise fire
 * after a later boot has replaced global.figma, and persist the old boot's
 * geometry into the new boot's store — or reopen a socket against a discarded
 * session module, or keep the test process alive with a ping interval.
 *
 * clearBuildCache() gives every boot a fresh module graph; this gives every
 * boot a guarantee that no timer from an earlier graph is still ticking.
 * setTimeout/clearTimeout still run for real (tests rely on that to observe
 * the debounce actually firing), this just tracks what's outstanding so it
 * can be swept before the next boot starts.
 */
const pendingTimers = new Set();
const pendingIntervals = new Set();
const realSetTimeout = global.setTimeout;
const realClearTimeout = global.clearTimeout;
const realSetInterval = global.setInterval;
const realClearInterval = global.clearInterval;

global.setTimeout = (fn, ms, ...args) => {
  const id = realSetTimeout(() => {
    pendingTimers.delete(id);
    fn(...args);
  }, ms);
  pendingTimers.add(id);
  return id;
};

global.clearTimeout = (id) => {
  pendingTimers.delete(id);
  realClearTimeout(id);
};

global.setInterval = (fn, ms, ...args) => {
  const id = realSetInterval(fn, ms, ...args);
  pendingIntervals.add(id);
  return id;
};

global.clearInterval = (id) => {
  pendingIntervals.delete(id);
  realClearInterval(id);
};

function clearPendingTimers() {
  pendingTimers.forEach((id) => realClearTimeout(id));
  pendingTimers.clear();
  pendingIntervals.forEach((id) => realClearInterval(id));
  pendingIntervals.clear();
}

module.exports = { BUILD, clearBuildCache, clearPendingTimers };
