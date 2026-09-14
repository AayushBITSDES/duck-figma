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
    showCheckIn: screens.showCheckIn,
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

  // --- A paste into the settings form must survive a repaint that has ------
  // --- nothing to do with the key -------------------------------------------
  const size = boot();
  size.deliver({ type: 'settings', settings: { provider: 'openrouter', key: '' } });
  size.openSettings();
  el('key-input').value = 'pasted-key';
  el('key-input').oninput();
  el('text-size').value = '14';
  el('text-size').onchange();
  dom.posted.length = 0;
  el('save').onclick();
  const sizeSaved = dom.posted.filter((m) => m.type === 'save-settings').pop();
  check('a text size change does not discard a pasted key', sizeSaved.key, 'pasted-key');

  // Collapsing rebuilds #root from scratch (see showCollapsed()), which used
  // to lose the same draft a different way: repaint() re-ran openSettings(),
  // which reseeds the draft from storage rather than the in-progress edit.
  const collapseSettings = boot();
  collapseSettings.deliver({ type: 'settings', settings: { provider: 'openrouter', key: '' } });
  collapseSettings.openSettings();
  el('key-input').value = 'pasted-key';
  el('key-input').oninput();
  collapseSettings.deliver({ type: 'window', minimized: true });
  collapseSettings.deliver({ type: 'window', minimized: false });
  check('a pasted key survives collapsing and expanding the panel', el('key-input').value, 'pasted-key');

  // --- render() swallows a paint while collapsed; the caller must not then -
  // --- reach into a screen that was never painted ---------------------------
  const resumeCollapsed = boot();
  resumeCollapsed.showCheckIn();
  resumeCollapsed.deliver({ type: 'window', minimized: true });
  let resumeThrew = false;
  try {
    resumeCollapsed.deliver({ type: 'resume' });
  } catch (e) {
    resumeThrew = true;
  }
  check('resuming while collapsed does not throw reaching into an unpainted idle screen', resumeThrew, false);
  check('the duck still stands down to idle underneath', resumeCollapsed.state.mode, 'idle');

  // A reply landing after the user collapsed mid-send used to throw from
  // inside renderChat() as an unhandled rejection, since nothing awaits
  // sendUserText() from its real caller (the Send button's onclick).
  const replyCollapsed = boot();
  replyCollapsed.deliver({ type: 'settings', settings: { provider: 'openrouter', key: 'sk-or' } });
  replyCollapsed.state.messages = [];
  const sendWhileCollapsing = replyCollapsed.sendUserText('are you there');
  replyCollapsed.deliver({ type: 'window', minimized: true });
  replyCollapsed.deliver({ type: 'board-context', board: [] });
  let replyThrew = false;
  try {
    await sendWhileCollapsing;
  } catch (e) {
    replyThrew = true;
  }
  check('a reply landing while collapsed does not throw reaching into an unpainted thread', replyThrew, false);

  // --- The resize grip must not stay live behind the collapsed duck --------
  // ui.html hides #grip with `body.min #grip`, since #grip lives outside
  // #root and no selector built on #root's own content can reach it. This
  // pins the class toggle that CSS depends on; there is no CSS engine here
  // to check the display:none itself.
  const grip = boot();
  grip.deliver({ type: 'window', minimized: true });
  check('collapsing marks the body so the stylesheet hides #grip', dom.body.classList.contains('min'), true);
  grip.deliver({ type: 'window', minimized: false });
  check('expanding clears it again', dom.body.classList.contains('min'), false);

  // --- Every screen change reports itself to the plugin --------------------
  // The plugin cannot see which screen is up, and expandForCheckIn refuses to
  // pop the panel open unless it has been told the UI is idle. So if these
  // stop being posted, a collapsed duck goes quiet: the check-in still fires,
  // the window never opens, and nobody sees the question. That failure is
  // invisible on the plugin side, which is why it is pinned here.
  const modes = boot();
  dom.posted.length = 0;
  modes.showCheckIn();
  check('entering the check-in reports checkin', dom.posted.filter((m) => m.type === 'mode').pop(), {
    type: 'mode',
    mode: 'checkin',
  });

  dom.posted.length = 0;
  modes.idleDuck();
  check('going back to rest reports idle', dom.posted.filter((m) => m.type === 'mode').pop(), {
    type: 'mode',
    mode: 'idle',
  });

  dom.posted.length = 0;
  modes.deliver({ type: 'settings', settings: { provider: 'openrouter', key: 'sk-or-saved' } });
  modes.openSettings();
  check('opening settings reports settings', dom.posted.filter((m) => m.type === 'mode').pop(), {
    type: 'mode',
    mode: 'settings',
  });
};
