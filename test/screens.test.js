/*
 * Runs against the COMPILED output in .test-build, not a reimplementation, so
 * these break when the real code drifts.
 *
 * Exercises screens.js and bridge.js, the modules that actually touch the DOM
 * (through render.js) and the postMessage bridge. Each scenario below boots a
 * fresh copy of that module graph (see lib/fresh.js), the CommonJS stand-in
 * for what `new Function(source)()` gave for free before the split.
 */
const path = require('path');
const { check } = require('./lib/check');
const { BUILD, clearBuildCache } = require('./lib/fresh');
const dom = require('./lib/dom');

function boot() {
  clearBuildCache();
  const stateMod = require(path.join(BUILD, 'ui', 'state'));
  const screens = require(path.join(BUILD, 'ui', 'screens'));
  screens.idleDuck(); // mirrors what the real ui.ts entry point does at boot
  return {
    state: stateMod.state,
    openSettings: screens.openSettings,
    idleDuck: screens.idleDuck,
    sendUserText: screens.sendUserText,
    deliver: (m) => global.window.onmessage({ data: { pluginMessage: m } }),
  };
}

module.exports = async function run() {
  dom.install();
  const el = dom.el;

  // --- Settings ---------------------------------------------------------
  const set = boot();
  set.deliver({ type: 'settings', settings: { provider: 'openrouter', key: 'sk-or-saved' } });
  set.openSettings();
  el('key-input').value = 'typed-then-abandoned';
  el('back').onclick();
  check('Back discards an edited key', [set.state.storedKey, set.state.mode], ['sk-or-saved', 'idle']);

  set.openSettings();
  el('provider').value = 'anthropic';
  el('provider').onchange();
  check('switching provider clears the key field, since only one is kept', el('key-input').value, '');
  el('provider').value = 'openrouter';
  el('provider').onchange();
  check('switching back brings the saved key into view', el('key-input').value, 'sk-or-saved');

  el('provider').value = 'google';
  el('provider').onchange();
  el('key-input').value = 'AIza-new';
  dom.posted.length = 0;
  el('save').onclick();
  const saved = dom.posted.filter((m) => m.type === 'save-settings').pop();
  check('Save sends the whole of the settings', [saved.provider, saved.key], ['google', 'AIza-new']);
  check('and applies them', [set.state.provider, set.state.storedKey, set.state.mode], ['google', 'AIza-new', 'idle']);

  // Opening settings before startup finishes must not seed an empty key and
  // let Save wipe the real one.
  const early = boot();
  early.openSettings();
  const earlyHtml = el('root').innerHTML;
  check('settings opened before load waits, with nothing to Save',
    [earlyHtml.indexOf('Loading') > -1, earlyHtml.indexOf('id="save"') > -1], [true, false]);
  early.deliver({ type: 'settings', settings: { provider: 'anthropic', key: 'sk-ant-saved' } });
  check('and seeds itself once the settings arrive',
    [el('provider').value, el('key-input').value], ['anthropic', 'sk-ant-saved']);

  // --- An in-flight reply must not repaint over another screen --------------
  const stomp = boot();
  stomp.deliver({ type: 'settings', settings: { provider: 'openrouter', key: 'sk-or' } });
  stomp.state.messages = [];
  const reply = stomp.sendUserText('still there?');
  check('the panel shows thinking while a reply is expected', stomp.state.loading, true);
  stomp.idleDuck();
  stomp.openSettings();
  stomp.deliver({ type: 'board-context', board: [] });
  await reply;
  check('a reply landing elsewhere does not repaint over settings', stomp.state.mode, 'settings');

  // Losing the key mid-send used to leave the panel stuck on "thinking...".
  const wedge = boot();
  wedge.deliver({ type: 'settings', settings: { provider: 'openrouter', key: 'sk-or' } });
  wedge.state.messages = [];
  const inflight = wedge.sendUserText('are you there');
  wedge.deliver({ type: 'settings', settings: { provider: 'openrouter', key: '' } });
  wedge.deliver({ type: 'board-context', board: [] });
  await inflight;
  check('losing the key mid-send falls back instead of hanging on thinking',
    [wedge.state.loading, wedge.state.messages.length], [false, 2]);
};
