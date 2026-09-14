/*
 * Runs against the COMPILED output in .test-build, not a reimplementation.
 *
 * Boots the plugin entry (code.js, wiring board.js/idle.js/settings-store.js/
 * sticky.js) against a stubbed figma global, the same way FigJam's plugin
 * sandbox would load it, and inspects what it posts back to the UI and what
 * it writes to clientStorage.
 */
const path = require('path');
const { check } = require('./lib/check');
const { BUILD, clearBuildCache, clearPendingTimers } = require('./lib/fresh');

function bootPlugin(store) {
  // A previous boot may still have a debounced clientStorage write pending
  // (window.ts's PERSIST_DEBOUNCE_MS); see the comment in lib/fresh.js for
  // why that timer has to be swept before this boot's global.figma goes in.
  clearPendingTimers();
  clearBuildCache();
  const state = Object.assign({}, store);
  const sent = [];
  const resizes = [];
  const realSetInterval = global.setInterval;
  let poll = null;
  global.setInterval = (fn) => { poll = fn; return 0; };
  global.__html__ = '<html></html>';
  global.figma = {
    showUI: () => {}, on: () => {}, notify: () => {},
    currentPage: { findAll: () => [], selection: [] },
    viewport: { center: { x: 0, y: 0 } },
    activeUsers: [],
    ui: { postMessage: (m) => sent.push(m), onmessage: null, resize: (w, h) => resizes.push([w, h]) },
    clientStorage: {
      getAsync: async (k) => (k in state ? state[k] : undefined),
      setAsync: async (k, v) => { state[k] = v; },
      deleteAsync: async (k) => { delete state[k]; },
    },
    createSticky: () => ({ text: {}, remove: () => {} }),
    loadFontAsync: async () => {},
  };
  const stub = global.figma;
  require(path.join(BUILD, 'plugin', 'code'));
  global.setInterval = realSetInterval;
  return {
    state: state,
    send: (m) => stub.ui.onmessage(m),
    settings: () => sent.filter((m) => m.type === 'settings').pop(),
    window: () => sent.filter((m) => m.type === 'window').pop(),
    resizes: resizes,
    lastResize: () => resizes[resizes.length - 1],
    checkins: () => sent.filter((m) => m.type === 'checkin'),
    // Jump past the idle threshold and run one poll tick, rather than
    // holding the suite up for the real 20 seconds.
    idleTick: () => {
      const realNow = Date.now;
      Date.now = () => realNow() + 60 * 1000;
      try { poll(); } finally { Date.now = realNow; }
    },
  };
}

const settled = () => new Promise((r) => setTimeout(r, 0));

module.exports = async function run() {
  let boot = bootPlugin({ duckSettings: { provider: 'google', key: 'AIza' } });
  await settled();
  check('saved settings are handed to the UI', boot.settings().settings, { provider: 'google', key: 'AIza' });

  boot = bootPlugin({});
  await settled();
  check('a fresh install starts on openrouter with no key',
    boot.settings().settings, { provider: 'openrouter', key: '' });
  check('and writes nothing to storage', Object.keys(boot.state).length, 0);

  // A key saved by an older build must survive the upgrade, not be deleted.
  boot = bootPlugin({ anthropicApiKey: 'sk-ant-legacy' });
  await settled();
  check('a legacy key is migrated rather than destroyed',
    boot.settings().settings, { provider: 'anthropic', key: 'sk-ant-legacy' });
  check('and is persisted under the current name', boot.state.duckSettings.key, 'sk-ant-legacy');
  check('with the old entry cleaned up', 'anthropicApiKey' in boot.state, false);

  // The per-provider shape an earlier build on this branch wrote.
  boot = bootPlugin({ duckSettings: { provider: 'openai', keys: { openai: 'sk-o', google: 'AIza' } } });
  await settled();
  check('the older per-provider shape is read through',
    boot.settings().settings, { provider: 'openai', key: 'sk-o' });

  // A key the user deliberately cleared must stay cleared, even if a legacy
  // entry survived an earlier failed cleanup.
  boot = bootPlugin({ duckSettings: { provider: 'google', key: '' }, anthropicApiKey: 'sk-ant-old' });
  await settled();
  check('an explicitly cleared key is not resurrected from a legacy entry',
    boot.settings().settings, { provider: 'google', key: '' });
  check('and the stale legacy entry is cleaned up', 'anthropicApiKey' in boot.state, false);

  // Saving writes the whole of the settings, so there is nothing to merge.
  boot = bootPlugin({ duckSettings: { provider: 'openrouter', key: 'old' } });
  await settled();
  boot.send({ type: 'save-settings', provider: 'google', key: 'AIza-new' });
  await settled();
  check('a save replaces the settings outright',
    boot.state.duckSettings, { provider: 'google', key: 'AIza-new' });

  // --- window geometry ------------------------------------------------------
  // Its own clientStorage key on purpose: see the STORE comment in window.ts.

  boot = bootPlugin({});
  await settled();
  check('with nothing stored the window opens at the default size', boot.lastResize(), [280, 380]);
  check('and reports itself to the UI', boot.window(), { type: 'window', width: 280, height: 380, minimized: false, textSize: 11 });

  boot = bootPlugin({ duckWindow: { width: 420, height: 560, minimized: false } });
  await settled();
  check('a saved size is restored on startup', boot.lastResize(), [420, 560]);

  // A corrupt or absurd stored value must never produce an unusable panel.
  boot = bootPlugin({ duckWindow: { width: 10, height: 10, minimized: false } });
  await settled();
  check('an undersized stored value is clamped up', boot.lastResize(), [240, 320]);

  boot = bootPlugin({ duckWindow: { width: 'nonsense', height: null, minimized: false } });
  await settled();
  check('a corrupt stored value falls back to the default', boot.lastResize(), [280, 380]);

  // A stored value must never produce a panel too large for its own resize
  // grip and minimize button to stay on screen, either.
  boot = bootPlugin({ duckWindow: { width: 999999, height: 999999, minimized: false } });
  await settled();
  check('an oversized stored value is clamped down on restore', boot.lastResize(), [800, 720]);

  boot = bootPlugin({ duckWindow: { width: 300, height: 400, minimized: true } });
  await settled();
  check('a window saved collapsed reopens collapsed', boot.lastResize(), [70, 70]);
  check('and still remembers the open size behind it',
    boot.window(), { type: 'window', width: 300, height: 400, minimized: true, textSize: 11 });

  // Minimize and expand round trip without losing the open size.
  boot = bootPlugin({ duckWindow: { width: 320, height: 420, minimized: false } });
  await settled();
  boot.send({ type: 'minimize' });
  await settled();
  check('minimize collapses to the 70x70 floor', boot.lastResize(), [70, 70]);
  check('and is written through immediately, not debounced', boot.state.duckWindow.minimized, true);
  boot.send({ type: 'expand' });
  await settled();
  check('expand restores the size it was collapsed from', boot.lastResize(), [320, 420]);

  // A drag fires resize continuously. The panel must follow every event, but
  // clientStorage must not be written on every one of them.
  boot = bootPlugin({});
  await settled();
  const before = boot.resizes.length;
  for (let w = 300; w <= 340; w += 10) boot.send({ type: 'resize', width: w, height: 400 });
  check('every resize event moves the panel', boot.resizes.length - before, 5);
  check('the panel is at the last size dragged to', boot.lastResize(), [340, 400]);
  check('and nothing is persisted yet, mid-drag', boot.state.duckWindow, undefined);
  await new Promise((r) => setTimeout(r, 500));
  check('the drag is written once it settles', boot.state.duckWindow.width, 340);

  // window.ts's debounce timer reads `figma` off the global at the moment it
  // fires, and this test process reassigns global.figma on every bootPlugin
  // call. A timer left running by one boot must not survive to fire against
  // a later boot's store once that boot has replaced global.figma.
  let leaker = bootPlugin({});
  await settled();
  leaker.send({ type: 'resize', width: 500, height: 600 });
  boot = bootPlugin({});
  await settled();
  await new Promise((r) => setTimeout(r, 500));
  check("a pending debounce from a previous boot never lands in the next boot's storage", boot.state.duckWindow, undefined);
  check('nor does it land anywhere at all once the next boot has started', leaker.state.duckWindow, undefined);

  boot = bootPlugin({});
  await settled();
  boot.send({ type: 'resize', width: 50, height: 50 });
  check('a resize below the minimum is clamped', boot.lastResize(), [240, 320]);

  boot = bootPlugin({});
  await settled();
  boot.send({ type: 'resize', width: 999999, height: 999999 });
  check('a resize above the maximum is clamped', boot.lastResize(), [800, 720]);

  // A message handler should not trust the sender's claimed state: a resize
  // arriving while minimized (a lost pointerup leaving a drag stuck active,
  // say) must not stretch the collapsed 70x70 duck across a full window.
  boot = bootPlugin({ duckWindow: { width: 300, height: 400, minimized: true } });
  await settled();
  const minimizedResizeCount = boot.resizes.length;
  boot.send({ type: 'resize', width: 500, height: 600 });
  check('a resize while minimized does not move the panel', boot.resizes.length, minimizedResizeCount);
  check('the panel stays at the collapsed size', boot.lastResize(), [70, 70]);
  check('and nothing is persisted from it', boot.state.duckWindow, { width: 300, height: 400, minimized: true });

  // A check-in posted to a collapsed duck would land on a 70x70 window nobody
  // can read, so it has to open the panel first, but only once the UI has
  // reported itself idle (see the 'mode' entry in window.ts's MESSAGE
  // CONTRACT). idle.ts fires purely off its own inactivity timer and has no
  // idea what screen the UI is actually showing.
  boot = bootPlugin({ duckWindow: { width: 300, height: 400, minimized: true } });
  await settled();
  check('the duck starts collapsed', boot.lastResize(), [70, 70]);
  boot.send({ type: 'mode', mode: 'idle' });
  boot.idleTick();
  await settled();
  check('a check-in pops the collapsed duck open once the UI is idle', boot.lastResize(), [300, 400]);
  check('and the question is actually asked', boot.checkins().length, 1);

  // The bug this guards against: collapse, go quiet long enough to trip the
  // timer, but never hear from the UI that its mode is 'idle' (it could be
  // mid-chat, in settings, anything). Popping the window open here would be
  // pure noise: the UI is never going to show the question either way.
  boot = bootPlugin({ duckWindow: { width: 300, height: 400, minimized: true } });
  await settled();
  boot.idleTick();
  await settled();
  check('an unreported UI mode does not expand the window', boot.lastResize(), [70, 70]);
  check('the question is still posted; it is the UI\'s job to decide not to show it', boot.checkins().length, 1);

  boot = bootPlugin({ duckWindow: { width: 300, height: 400, minimized: true } });
  await settled();
  boot.send({ type: 'mode', mode: 'chat' });
  boot.idleTick();
  await settled();
  check('a check-in does not expand the window while the UI is in chat mode', boot.lastResize(), [70, 70]);

  // The same tick must not resize a panel that is already open, or it would
  // fight whatever the user just dragged it to.
  boot = bootPlugin({ duckWindow: { width: 300, height: 400, minimized: false } });
  await settled();
  const openResizes = boot.resizes.length;
  boot.idleTick();
  await settled();
  check('a check-in on an open panel resizes nothing', boot.resizes.length, openResizes);
  check('but still asks', boot.checkins().length, 1);

  // Text size is a display preference, so it rides with the geometry rather
  // than with duckSettings, whose saves have to stay whole-object.
  boot = bootPlugin({});
  await settled();
  boot.send({ type: 'text-size', size: 15 });
  await settled();
  check('a text size nudge is persisted with the geometry', boot.state.duckWindow.textSize, 15);
  check('and reported back so the UI can apply it', boot.window().textSize, 15);
  boot.send({ type: 'text-size', size: 99 });
  await settled();
  check('an out of range text size is clamped', boot.window().textSize, 18);

  boot = bootPlugin({ duckWindow: { width: 300, height: 400, minimized: false, textSize: 16 } });
  await settled();
  check('a saved text size is restored on startup', boot.window().textSize, 16);
};
