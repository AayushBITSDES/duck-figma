/*
 * Runs against the COMPILED output in .test-build, not a reimplementation, so
 * these assertions break when the real adapters drift.
 *
 *   npm test
 *
 * The four providers disagree about auth headers, the name of the output cap,
 * where system instructions go, what the assistant role is called and where the
 * reply lives, so each one is pinned here.
 */
const fs = require('fs');
const path = require('path');

const BUILD = path.join(__dirname, '..', '.test-build');
let failed = 0;
let passed = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else {
    failed++;
    console.log('FAIL ' + name + '\n  got:  ' + JSON.stringify(actual) + '\n  want: ' + JSON.stringify(expected));
    return;
  }
  console.log('pass ' + name);
}

/* ---------------------------------------------------------------- ui.ts --- */

const els = {};
function el(id) {
  if (!els[id]) {
    els[id] = {
      id: id, value: '', dataset: {}, scrollTop: 0, scrollHeight: 0,
      onclick: null, onchange: null, _html: '',
      set innerHTML(v) { this._html = v; if (id === 'root') rerender(v); },
      get innerHTML() { return this._html; },
      set textContent(v) {
        this._html = String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      },
    };
  }
  return els[id];
}

// A real render replaces the DOM, so stale nodes and the values typed into them
// are gone. Without this the stub would leak a previous screen's input value
// into the next one and invent bugs that a browser would never have.
function rerender(html) {
  for (const k of Object.keys(els)) if (k !== 'root') delete els[k];
  const unescape = (v) => v.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const input = /id="key-input"[^>]*\svalue="([^"]*)"/.exec(html);
  if (input) el('key-input').value = unescape(input[1]);
  const selected = /<option value="([^"]+)" selected>/.exec(html);
  if (selected) el('provider').value = selected[1];
}
global.document = {
  getElementById: el,
  createElement: () => el('scratch-' + Math.random()),
  querySelectorAll: () => [],
};
const posted = [];
global.parent = { postMessage: (m) => posted.push(m.pluginMessage) };
global.window = {};

let lastCall = null;
let nextResponse = null;
global.fetch = async (url, opts) => {
  lastCall = { url: url, opts: opts };
  return nextResponse;
};

const uiSrc = fs.readFileSync(path.join(BUILD, 'ui.js'), 'utf8');

// Each call boots a fresh copy of the compiled UI with its own module state, so
// startup-ordering cases can be tested without leaking into the others.
function makeUi() {
  const api = newUiInstance();
  api.deliver = (pluginMessage) => window.onmessage({ data: { pluginMessage: pluginMessage } });
  return api;
}

function newUiInstance() { return new Function(uiSrc + `; return {
  get messages(){return messages}, set messages(v){messages=v},
  set boardItems(v){boardItems=v},
  get provider(){return provider}, set provider(v){provider=v},
  get keys(){return keys}, set keys(v){keys=v},
  get draftProvider(){return draftProvider},
  set fallbackTurn(v){fallbackTurn=v}, set fallbackItemCursor(v){fallbackItemCursor=v},
  PROVIDERS, activeKey, askDuck, apiMessages, apiErrorMessage, emptyReason,
  fallbackReply, openSettings, idleDuck };`)(); }

const ui = makeUi();

const ok = (payload) => ({ ok: true, status: 200, json: async () => payload });

async function run() {
  // Real startup order: code.ts sends the saved settings, then the board.
  ui.deliver({ type: 'settings', settings: { provider: 'openrouter', keys: {} } });
  ui.deliver({ type: 'board-context', board: ['nav | search', 'onboarding copy'] });
  const convo = [{ role: 'user', content: 'I am stuck.' }];
  let b;

  // --- OpenRouter -----------------------------------------------------------
  ui.provider = 'openrouter'; ui.keys = { openrouter: 'sk-or-v1-x' }; ui.messages = convo.slice();
  nextResponse = ok({ choices: [{ finish_reason: 'stop', message: { content: 'Quack.' } }] });
  await ui.askDuck();
  b = JSON.parse(lastCall.opts.body);
  check('openrouter: url', lastCall.url, 'https://openrouter.ai/api/v1/chat/completions');
  check('openrouter: bearer auth', lastCall.opts.headers.Authorization, 'Bearer sk-or-v1-x');
  check('openrouter: model is a free one', [b.model, b.model.endsWith(':free')], ['thinkingmachines/inkling:free', true]);
  check('openrouter: max_completion_tokens, not max_tokens', [b.max_completion_tokens, b.max_tokens], [220, undefined]);
  check('openrouter: system is the first message', b.messages[0].role, 'system');
  check('openrouter: reply read', ui.messages[1].content, 'Quack.');

  // --- OpenAI ---------------------------------------------------------------
  ui.provider = 'openai'; ui.keys = { openai: 'sk-o' }; ui.messages = convo.slice();
  nextResponse = ok({ choices: [{ message: { content: 'Hi.' } }] });
  await ui.askDuck();
  b = JSON.parse(lastCall.opts.body);
  check('openai: url', lastCall.url, 'https://api.openai.com/v1/chat/completions');
  check('openai: model', b.model, 'gpt-5.6-luna');
  check('openai: max_completion_tokens, not max_tokens', [b.max_completion_tokens, b.max_tokens], [220, undefined]);

  // --- Anthropic ------------------------------------------------------------
  ui.provider = 'anthropic'; ui.keys = { anthropic: 'sk-ant-x' }; ui.messages = convo.slice();
  nextResponse = ok({ content: [{ type: 'text', text: 'Quack quack.' }] });
  await ui.askDuck();
  b = JSON.parse(lastCall.opts.body);
  const h = lastCall.opts.headers;
  check('anthropic: url', lastCall.url, 'https://api.anthropic.com/v1/messages');
  check('anthropic: model', b.model, 'claude-haiku-4-5');
  check('anthropic: x-api-key, not bearer', [h['x-api-key'], h.Authorization], ['sk-ant-x', undefined]);
  check('anthropic: version + browser opt-in headers', [h['anthropic-version'], h['anthropic-dangerous-direct-browser-access']], ['2023-06-01', 'true']);
  check('anthropic: system is top level, first message is the user', [typeof b.system, b.messages[0].role], ['string', 'user']);
  check('anthropic: max_tokens, not max_completion_tokens', [b.max_tokens, b.max_completion_tokens], [220, undefined]);
  check('anthropic: reply read from content[0].text', ui.messages[1].content, 'Quack quack.');

  // --- Google ---------------------------------------------------------------
  ui.provider = 'google'; ui.keys = { google: 'AIzaX' };
  ui.messages = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
    { role: 'user', content: 'still stuck' },
  ];
  nextResponse = ok({ candidates: [{ content: { parts: [{ text: 'Quack!' }] } }] });
  await ui.askDuck();
  b = JSON.parse(lastCall.opts.body);
  check('google: url pins the model', lastCall.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
  check('google: x-goog-api-key', lastCall.opts.headers['x-goog-api-key'], 'AIzaX');
  check('google: system becomes systemInstruction', typeof b.systemInstruction.parts[0].text, 'string');
  check('google: assistant role is renamed to model', b.contents.map((c) => c.role), ['user', 'model', 'user']);
  check('google: cap is maxOutputTokens', b.generationConfig.maxOutputTokens, 220);
  check('google: reply read from candidates', ui.messages[3].content, 'Quack!');

  // --- History hygiene ------------------------------------------------------
  ui.messages = [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'rejected that key', error: true },
    { role: 'user', content: 'second' },
  ];
  check('errors dropped, same-role turns merged so roles alternate',
    ui.apiMessages(), [{ role: 'user', content: 'first\n\nsecond' }]);

  // --- Key scoping ----------------------------------------------------------
  ui.provider = 'anthropic'; ui.keys = {};
  check('shared tester key is openrouter-only', ui.activeKey(), '');
  ui.provider = 'openrouter';
  check('openrouter falls back to the shared tester key',
    ui.activeKey(), uiSrc.match(/SHARED_KEY = '(.*)'/)[1]);

  // --- Error copy -----------------------------------------------------------
  ui.provider = 'google';
  check('google 400 reads as a key problem', ui.apiErrorMessage(400, 'API key not valid').includes('rejected that key'), true);
  ui.provider = 'openrouter';
  check('openrouter 429 explains the shared free quota', ui.apiErrorMessage(429, '').includes('50 a day'), true);
  ui.provider = 'openai';
  check('openai 429 does not mention the free quota', ui.apiErrorMessage(429, '').includes('50 a day'), false);
  check('404 names the provider and the model', ui.apiErrorMessage(404, ''), 'OpenAI does not know the model gpt-5.6-luna.');

  check('stop reasons decoded for every provider vocabulary', [
    ui.emptyReason({ choices: [{ finish_reason: 'length' }] }).includes('length cap'),
    ui.emptyReason({ candidates: [{ finishReason: 'MAX_TOKENS' }] }).includes('length cap'),
    ui.emptyReason({ stop_reason: 'max_tokens' }).includes('length cap'),
    ui.emptyReason({ candidates: [{ finishReason: 'SAFETY' }] }).includes('content filter'),
  ], [true, true, true, true]);

  // --- Keyless fallback -----------------------------------------------------
  ui.boardItems = ['nav | search', 'onboarding copy'];
  ui.fallbackTurn = 0; ui.fallbackItemCursor = 0;
  const r = [ui.fallbackReply(true), ui.fallbackReply(), ui.fallbackReply()];
  check('keyless fallback quotes the real board',
    [r[0].startsWith('I can see 2 things'), r[0].includes('nav | search'), new Set(r).size], [true, true, 3]);

  // --- Settings are a draft until Save --------------------------------------
  ui.provider = 'openrouter';
  ui.keys = { openrouter: 'sk-or-keep', anthropic: 'sk-ant-keep' };
  ui.openSettings();
  el('provider').value = 'anthropic';
  el('provider').onchange();
  check('switching the dropdown does not change the live provider', ui.provider, 'openrouter');
  check('switching the dropdown does move the draft', ui.draftProvider, 'anthropic');
  el('back').onclick();
  check('Back discards the provider change', ui.provider, 'openrouter');

  ui.openSettings();
  el('key-input').value = 'sk-or-typed-but-abandoned';
  el('back').onclick();
  check('Back discards an edited key', ui.keys.openrouter, 'sk-or-keep');

  ui.openSettings();
  el('provider').value = 'google';
  el('provider').onchange();
  el('key-input').value = 'AIza-new';
  posted.length = 0;
  el('save').onclick();
  check('Save applies the provider', ui.provider, 'google');
  check('Save applies the new key and keeps the others',
    [ui.keys.google, ui.keys.openrouter, ui.keys.anthropic], ['AIza-new', 'sk-or-keep', 'sk-ant-keep']);
  const saved = posted.filter((m) => m.type === 'save-settings').pop();
  check('Save persists through one save-settings message',
    posted.filter((m) => m.type === 'save-settings').length, 1);
  check('Save sends only what changed, never the whole key map',
    [saved.provider, saved.edits, 'keys' in saved], ['google', { google: 'AIza-new' }, false]);

  // --- Settings opened before startup finishes ------------------------------
  // code.ts needs several storage round-trips before it can send the saved
  // settings. Seeding a draft from the empty pre-load state and then saving it
  // would persist that emptiness over every provider's key.
  const early = makeUi();
  early.openSettings();
  const earlyHtml = el('root').innerHTML;
  check('settings opened before load shows a wait state, with nothing to Save',
    [earlyHtml.indexOf('Loading') > -1, earlyHtml.indexOf('id="save"') > -1], [true, false]);

  early.deliver({ type: 'settings', settings: { provider: 'anthropic', keys: { openrouter: 'sk-or-saved', anthropic: 'sk-ant-saved' } } });
  check('the screen re-seeds itself once settings arrive', el('provider').value, 'anthropic');

  el('key-input').value = 'sk-ant-edited';
  posted.length = 0;
  el('save').onclick();
  check('saving after a late load keeps the other provider keys',
    [early.keys.anthropic, early.keys.openrouter], ['sk-ant-edited', 'sk-or-saved']);
  check('and sends only the edited provider',
    posted.filter((m) => m.type === 'save-settings').pop().edits, { anthropic: 'sk-ant-edited' });

  // Storage failure still has to unblock the screen.
  const broken = makeUi();
  broken.openSettings();
  broken.deliver({ type: 'settings', settings: null });
  check('a settings message with no payload still unblocks the screen', typeof el('save').onclick, 'function');

  await runCodeTests();

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
}

/* -------------------------------------------------------------- code.ts --- */

// Boots code.js against a stub Figma and checks the one-way door: upgrading
// must not throw away keys saved by earlier builds under their old names.
function bootPlugin(store, failOn) {
  const state = Object.assign({}, store);
  const sent = [];
  const notified = [];
  const fail = failOn || {};
  const realSetInterval = global.setInterval;
  global.setInterval = () => 0;
  global.__html__ = '<html></html>';
  global.figma = {
    showUI: () => {},
    on: () => {},
    notify: (t) => { notified.push(t); },
    currentPage: { findAll: () => [], selection: [] },
    viewport: { center: { x: 0, y: 0 } },
    activeUsers: [],
    ui: { postMessage: (m) => sent.push(m), onmessage: null },
    clientStorage: {
      getAsync: async (k) => {
        if (fail.get === k) throw new Error('storage unavailable');
        return k in state ? state[k] : undefined;
      },
      setAsync: async (k, v) => {
        if (fail.set === k) throw new Error('storage unavailable');
        state[k] = v;
      },
      deleteAsync: async (k) => {
        if (fail.del === k) throw new Error('storage unavailable');
        delete state[k];
      },
    },
    createSticky: () => ({ text: {}, remove: () => {} }),
    loadFontAsync: async () => {},
  };
  const stub = global.figma;
  new Function(fs.readFileSync(path.join(BUILD, 'code.js'), 'utf8'))();
  global.setInterval = realSetInterval;
  return {
    state: state,
    sent: sent,
    notified: notified,
    send: (msg) => stub.ui.onmessage(msg),
    settings: () => sent.filter((m) => m.type === 'settings').pop(),
  };
}

const settled = () => new Promise((r) => setTimeout(r, 0));

async function runCodeTests() {
  // An install from the OpenRouter-only build.
  let boot = bootPlugin({ openrouterApiKey: 'sk-or-v1-legacy' });
  await settled();
  let msg = boot.sent.filter((m) => m.type === 'settings').pop();
  check('legacy openrouter key is migrated, not destroyed', msg.settings.keys.openrouter, 'sk-or-v1-legacy');
  check('migrated settings are persisted', boot.state.duckSettings.keys.openrouter, 'sk-or-v1-legacy');
  check('legacy entry is removed only after the write', 'openrouterApiKey' in boot.state, false);

  // Older installs: both of these name providers the plugin still supports.
  boot = bootPlugin({ anthropicApiKey: 'sk-ant-legacy', openaiApiKey: 'sk-openai-legacy' });
  await settled();
  msg = boot.sent.filter((m) => m.type === 'settings').pop();
  check('legacy anthropic and openai keys are migrated too',
    [msg.settings.keys.anthropic, msg.settings.keys.openai], ['sk-ant-legacy', 'sk-openai-legacy']);

  // Already migrated: a saved key must never be clobbered by a stale legacy one.
  boot = bootPlugin({
    duckSettings: { provider: 'google', keys: { openrouter: 'sk-or-current' } },
    openrouterApiKey: 'sk-or-stale',
  });
  await settled();
  msg = boot.sent.filter((m) => m.type === 'settings').pop();
  check('a stale legacy entry never overwrites the saved key', msg.settings.keys.openrouter, 'sk-or-current');
  check('the saved provider survives', msg.settings.provider, 'google');

  // Nothing stored at all.
  boot = bootPlugin({});
  await settled();
  msg = boot.sent.filter((m) => m.type === 'settings').pop();
  check('a fresh install starts on openrouter with no keys', [msg.settings.provider, msg.settings.keys], ['openrouter', {}]);
  check('a fresh install writes nothing to storage', Object.keys(boot.state).length, 0);

  // --- Saving is a merge onto real storage, never a replace ----------------
  boot = bootPlugin({ duckSettings: { provider: 'openrouter', keys: { openrouter: 'sk-or', anthropic: 'sk-ant', google: 'AIza' } } });
  await settled();
  boot.send({ type: 'save-settings', provider: 'google', edits: { google: 'AIza-new' } });
  await settled();
  check('an edit to one provider leaves the others alone',
    boot.state.duckSettings.keys, { openrouter: 'sk-or', anthropic: 'sk-ant', google: 'AIza-new' });
  check('and the selected provider is stored', boot.state.duckSettings.provider, 'google');

  boot.send({ type: 'save-settings', provider: 'google', edits: { anthropic: null } });
  await settled();
  check('a null edit removes just that key',
    boot.state.duckSettings.keys, { openrouter: 'sk-or', google: 'AIza-new' });

  // A save from a UI that believes storage is empty must still not wipe it.
  boot.send({ type: 'save-settings', provider: 'openai', edits: { openai: 'sk-o' } });
  await settled();
  check('a save from a UI with a stale view cannot wipe stored keys',
    boot.state.duckSettings.keys, { openrouter: 'sk-or', google: 'AIza-new', openai: 'sk-o' });

  // --- Storage failures ----------------------------------------------------
  // Migration wrote the credentials, then cleanup failed. That must not be
  // reported as an empty install, or the next save would overwrite them.
  boot = bootPlugin({ openrouterApiKey: 'sk-or-legacy', anthropicApiKey: 'sk-ant-legacy' }, { del: 'anthropicApiKey' });
  await settled();
  msg = boot.settings();
  check('a cleanup failure still reports the migrated keys',
    [msg.settings.keys.openrouter, msg.settings.keys.anthropic], ['sk-or-legacy', 'sk-ant-legacy']);
  check('and is not flagged as a failed load', !!msg.failed, false);
  check('the migrated credentials are on disk', boot.state.duckSettings.keys.anthropic, 'sk-ant-legacy');

  // A read that genuinely fails is flagged, so the UI can say so.
  boot = bootPlugin({ duckSettings: { provider: 'google', keys: { google: 'AIza' } } }, { get: 'duckSettings' });
  await settled();
  msg = boot.settings();
  check('a failed read is flagged rather than passed off as empty',
    [msg.failed, msg.settings.keys], [true, {}]);

  // A save cannot merge if it cannot read. Refusing is the safe outcome: the
  // stored credentials survive and the user is told, rather than a blind write
  // replacing keys the UI never saw.
  boot.send({ type: 'save-settings', provider: 'openai', edits: { openai: 'sk-o' } });
  await settled();
  check('a save that cannot read storage refuses instead of overwriting',
    boot.state.duckSettings.keys, { google: 'AIza' });
  check('and says so rather than failing silently', boot.notified.length, 1);
}

run();
