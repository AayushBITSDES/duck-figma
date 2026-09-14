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
const { BUILD, clearBuildCache } = require('./lib/fresh');

function bootPlugin(store) {
  clearBuildCache();
  const state = Object.assign({}, store);
  const sent = [];
  const realSetInterval = global.setInterval;
  global.setInterval = () => 0;
  global.__html__ = '<html></html>';
  global.figma = {
    showUI: () => {}, on: () => {}, notify: () => {},
    currentPage: { findAll: () => [], selection: [] },
    viewport: { center: { x: 0, y: 0 } },
    activeUsers: [],
    ui: { postMessage: (m) => sent.push(m), onmessage: null },
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
};
