/*
 * Runs against the COMPILED output in .test-build, not a reimplementation, so
 * these break when the real code drifts.
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
  if (ok) { passed++; console.log('pass ' + name); return; }
  failed++;
  console.log('FAIL ' + name + '\n  got:  ' + JSON.stringify(actual) + '\n  want: ' + JSON.stringify(expected));
}

/* ------------------------------------------------------------ fake DOM --- */

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
// A real render replaces the DOM, so stale nodes and anything typed into them
// are gone. Without this the stub leaks one screen's input into the next.
function rerender(html) {
  for (const k of Object.keys(els)) if (k !== 'root') delete els[k];
  const unescape = (v) => v.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  const input = /id="key-input"[^>]*\svalue="([^"]*)"/.exec(html);
  if (input) el('key-input').value = unescape(input[1]);
  const selected = /<option value="([^"]+)" selected>/.exec(html);
  if (selected) el('provider').value = selected[1];
}
global.document = { getElementById: el, createElement: () => el('tmp' + Math.random()), querySelectorAll: () => [] };
const posted = [];
global.parent = { postMessage: (m) => posted.push(m.pluginMessage) };
global.window = {};

let lastCall = null;
let nextResponse = null;
global.fetch = async (url, opts) => { lastCall = { url, opts }; return nextResponse; };

const uiSrc = fs.readFileSync(path.join(BUILD, 'ui.js'), 'utf8');

// Each call boots a fresh copy of the compiled UI with its own module state.
function makeUi() {
  const api = new Function(uiSrc + `; return {
    get messages(){return messages}, set messages(v){messages=v},
    set boardItems(v){boardItems=v},
    get provider(){return provider}, set provider(v){provider=v},
    get storedKey(){return storedKey}, set storedKey(v){storedKey=v},
    get mode(){return mode}, get loading(){return loading},
    set fallbackTurn(v){fallbackTurn=v}, set fallbackItemCursor(v){fallbackItemCursor=v},
    PROVIDERS, activeKey, askDuck, apiMessages, apiErrorMessage, emptyReason,
    fallbackReply, openSettings, idleDuck, sendUserText };`)();
  api.deliver = (m) => window.onmessage({ data: { pluginMessage: m } });
  return api;
}

const ok = (payload) => ({ ok: true, status: 200, json: async () => payload });
const ui = makeUi();

async function run() {
  ui.deliver({ type: 'settings', settings: { provider: 'openrouter', key: 'sk-or-v1-x' } });
  ui.deliver({ type: 'board-context', board: ['nav | search', 'onboarding copy'] });
  const convo = [{ role: 'user', content: 'I am stuck.' }];
  let b;

  // --- OpenRouter -----------------------------------------------------------
  ui.messages = convo.slice();
  nextResponse = ok({ choices: [{ finish_reason: 'stop', message: { content: 'Quack.' } }] });
  await ui.askDuck();
  b = JSON.parse(lastCall.opts.body);
  check('openrouter: url', lastCall.url, 'https://openrouter.ai/api/v1/chat/completions');
  check('openrouter: bearer auth', lastCall.opts.headers.Authorization, 'Bearer sk-or-v1-x');
  check('openrouter: model is a free one', [b.model, b.model.endsWith(':free')], ['thinkingmachines/inkling:free', true]);
  check('openrouter: max_completion_tokens, not max_tokens', [b.max_completion_tokens, b.max_tokens], [220, undefined]);
  check('openrouter: system is the first message', b.messages[0].role, 'system');
  check('openrouter: board snapshot reaches the model', b.messages[0].content.includes('nav | search'), true);
  check('openrouter: reply read', ui.messages[1].content, 'Quack.');

  // --- OpenAI ---------------------------------------------------------------
  ui.provider = 'openai'; ui.storedKey = 'sk-o'; ui.messages = convo.slice();
  nextResponse = ok({ choices: [{ message: { content: 'Hi.' } }] });
  await ui.askDuck();
  b = JSON.parse(lastCall.opts.body);
  check('openai: url', lastCall.url, 'https://api.openai.com/v1/chat/completions');
  check('openai: model', b.model, 'gpt-5.6-luna');
  check('openai: max_completion_tokens, not max_tokens', [b.max_completion_tokens, b.max_tokens], [220, undefined]);

  // --- Anthropic ------------------------------------------------------------
  ui.provider = 'anthropic'; ui.storedKey = 'sk-ant-x'; ui.messages = convo.slice();
  nextResponse = ok({ content: [{ type: 'text', text: 'Quack quack.' }] });
  await ui.askDuck();
  b = JSON.parse(lastCall.opts.body);
  const h = lastCall.opts.headers;
  check('anthropic: url', lastCall.url, 'https://api.anthropic.com/v1/messages');
  check('anthropic: model', b.model, 'claude-haiku-4-5');
  check('anthropic: x-api-key, not bearer', [h['x-api-key'], h.Authorization], ['sk-ant-x', undefined]);
  check('anthropic: version + browser opt-in headers',
    [h['anthropic-version'], h['anthropic-dangerous-direct-browser-access']], ['2023-06-01', 'true']);
  check('anthropic: system is top level, first message is the user',
    [typeof b.system, b.messages[0].role], ['string', 'user']);
  check('anthropic: max_tokens, not max_completion_tokens', [b.max_tokens, b.max_completion_tokens], [220, undefined]);
  check('anthropic: reply read from content[0].text', ui.messages[1].content, 'Quack quack.');

  // --- Google ---------------------------------------------------------------
  ui.provider = 'google'; ui.storedKey = 'AIzaX';
  ui.messages = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
    { role: 'user', content: 'still stuck' },
  ];
  nextResponse = ok({ candidates: [{ content: { parts: [{ text: 'Quack!' }] } }] });
  await ui.askDuck();
  b = JSON.parse(lastCall.opts.body);
  check('google: url pins the model', lastCall.url,
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
  check('google: x-goog-api-key', lastCall.opts.headers['x-goog-api-key'], 'AIzaX');
  check('google: system becomes systemInstruction', typeof b.systemInstruction.parts[0].text, 'string');
  check('google: assistant role is renamed to model', b.contents.map((c) => c.role), ['user', 'model', 'user']);
  check('google: cap is maxOutputTokens', b.generationConfig.maxOutputTokens, 220);
  check('google: reply read from candidates', ui.messages[3].content, 'Quack!');

  // --- Cross-cutting --------------------------------------------------------
  ui.messages = [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'rejected that key', error: true },
    { role: 'user', content: 'second' },
  ];
  check('errors dropped, same-role turns merged so roles alternate',
    ui.apiMessages(), [{ role: 'user', content: 'first\n\nsecond' }]);

  ui.provider = 'anthropic'; ui.storedKey = '';
  check('the shipped tester key is openrouter-only', ui.activeKey(), '');
  ui.provider = 'openrouter';
  check('openrouter falls back to the shipped tester key', ui.activeKey(), uiSrc.match(/SHARED_KEY = '(.*)'/)[1]);

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

  ui.boardItems = ['nav | search', 'onboarding copy'];
  ui.fallbackTurn = 0; ui.fallbackItemCursor = 0;
  const r = [ui.fallbackReply(true), ui.fallbackReply(), ui.fallbackReply()];
  check('keyless fallback quotes the real board',
    [r[0].startsWith('I can see 2 things'), r[0].includes('nav | search'), new Set(r).size], [true, true, 3]);

  // --- Settings -------------------------------------------------------------
  const set = makeUi();
  set.deliver({ type: 'settings', settings: { provider: 'openrouter', key: 'sk-or-saved' } });
  set.openSettings();
  el('key-input').value = 'typed-then-abandoned';
  el('back').onclick();
  check('Back discards an edited key', [set.storedKey, set.mode], ['sk-or-saved', 'idle']);

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
  posted.length = 0;
  el('save').onclick();
  const saved = posted.filter((m) => m.type === 'save-settings').pop();
  check('Save sends the whole of the settings', [saved.provider, saved.key], ['google', 'AIza-new']);
  check('and applies them', [set.provider, set.storedKey, set.mode], ['google', 'AIza-new', 'idle']);

  // Opening settings before startup finishes must not seed an empty key and
  // let Save wipe the real one.
  const early = makeUi();
  early.openSettings();
  const earlyHtml = el('root').innerHTML;
  check('settings opened before load waits, with nothing to Save',
    [earlyHtml.indexOf('Loading') > -1, earlyHtml.indexOf('id="save"') > -1], [true, false]);
  early.deliver({ type: 'settings', settings: { provider: 'anthropic', key: 'sk-ant-saved' } });
  check('and seeds itself once the settings arrive',
    [el('provider').value, el('key-input').value], ['anthropic', 'sk-ant-saved']);

  // --- An in-flight reply must not repaint over another screen --------------
  const stomp = makeUi();
  stomp.deliver({ type: 'settings', settings: { provider: 'openrouter', key: 'sk-or' } });
  stomp.messages = [];
  const reply = stomp.sendUserText('still there?');
  check('the panel shows thinking while a reply is expected', stomp.loading, true);
  stomp.idleDuck();
  stomp.openSettings();
  stomp.deliver({ type: 'board-context', board: [] });
  await reply;
  check('a reply landing elsewhere does not repaint over settings', stomp.mode, 'settings');

  // Losing the key mid-send used to leave the panel stuck on "thinking...".
  const wedge = makeUi();
  wedge.deliver({ type: 'settings', settings: { provider: 'openrouter', key: 'sk-or' } });
  wedge.messages = [];
  const inflight = wedge.sendUserText('are you there');
  wedge.deliver({ type: 'settings', settings: { provider: 'openrouter', key: '' } });
  wedge.deliver({ type: 'board-context', board: [] });
  await inflight;
  check('losing the key mid-send falls back instead of hanging on thinking',
    [wedge.loading, wedge.messages.length], [false, 2]);

  await runCodeTests();
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
}

/* -------------------------------------------------------------- code.ts --- */

function bootPlugin(store) {
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
  new Function(fs.readFileSync(path.join(BUILD, 'code.js'), 'utf8'))();
  global.setInterval = realSetInterval;
  return {
    state: state,
    send: (m) => stub.ui.onmessage(m),
    settings: () => sent.filter((m) => m.type === 'settings').pop(),
  };
}

const settled = () => new Promise((r) => setTimeout(r, 0));

async function runCodeTests() {
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
}

run();
