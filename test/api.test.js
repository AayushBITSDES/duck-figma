/*
 * Runs against the COMPILED output in .test-build, not a reimplementation, so
 * these break when the real code drifts.
 *
 * Exercises state.js, providers.js, api.js and fallback.js directly, by their
 * real exports. None of these four touch the DOM, so this file needs no fake
 * document, just a stubbed fetch.
 *
 * The four providers disagree about auth headers, the name of the output cap,
 * where system instructions go, what the assistant role is called and where the
 * reply lives, so each one is pinned here.
 */
const path = require('path');
const { check } = require('./lib/check');
const { BUILD } = require('./lib/fresh');

let lastCall = null;
let nextResponse = null;
global.fetch = async (url, opts) => { lastCall = { url, opts }; return nextResponse; };

const stateMod = require(path.join(BUILD, 'ui', 'state'));
const api = require(path.join(BUILD, 'ui', 'api'));
const fallback = require(path.join(BUILD, 'ui', 'fallback'));

const { state } = stateMod;
const ok = (payload) => ({ ok: true, status: 200, json: async () => payload });

module.exports = async function run() {
  // Setup that used to happen by delivering 'settings' and 'board-context'
  // messages through the bridge. Those two message types just assign these
  // same fields, so setting them directly here exercises the same api.js
  // logic without needing the DOM-touching bridge/screens modules at all.
  state.provider = 'openrouter';
  state.storedKey = 'sk-or-v1-x';
  state.boardItems = ['nav | search', 'onboarding copy'];
  state.boardReadAt = Date.now();
  const convo = [{ role: 'user', content: 'I am stuck.' }];
  let b;

  // --- OpenRouter -----------------------------------------------------------
  state.messages = convo.slice();
  nextResponse = ok({ choices: [{ finish_reason: 'stop', message: { content: 'Quack.' } }] });
  await api.askDuck();
  b = JSON.parse(lastCall.opts.body);
  check('openrouter: url', lastCall.url, 'https://openrouter.ai/api/v1/chat/completions');
  check('openrouter: bearer auth', lastCall.opts.headers.Authorization, 'Bearer sk-or-v1-x');
  check('openrouter: model is a free one', [b.model, b.model.endsWith(':free')], ['thinkingmachines/inkling:free', true]);
  check('openrouter: max_completion_tokens, not max_tokens', [b.max_completion_tokens, b.max_tokens], [220, undefined]);
  check('openrouter: system is the first message', b.messages[0].role, 'system');
  check('openrouter: board snapshot reaches the model', b.messages[0].content.includes('nav | search'), true);
  check('openrouter: reply read', state.messages[1].content, 'Quack.');

  // --- OpenAI ---------------------------------------------------------------
  state.provider = 'openai'; state.storedKey = 'sk-o'; state.messages = convo.slice();
  nextResponse = ok({ choices: [{ message: { content: 'Hi.' } }] });
  await api.askDuck();
  b = JSON.parse(lastCall.opts.body);
  check('openai: url', lastCall.url, 'https://api.openai.com/v1/chat/completions');
  check('openai: model', b.model, 'gpt-5.6-luna');
  check('openai: max_completion_tokens, not max_tokens', [b.max_completion_tokens, b.max_tokens], [220, undefined]);

  // --- Anthropic ------------------------------------------------------------
  state.provider = 'anthropic'; state.storedKey = 'sk-ant-x'; state.messages = convo.slice();
  nextResponse = ok({ content: [{ type: 'text', text: 'Quack quack.' }] });
  await api.askDuck();
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
  check('anthropic: reply read from content[0].text', state.messages[1].content, 'Quack quack.');

  // --- Google ---------------------------------------------------------------
  state.provider = 'google'; state.storedKey = 'AIzaX';
  state.messages = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
    { role: 'user', content: 'still stuck' },
  ];
  nextResponse = ok({ candidates: [{ content: { parts: [{ text: 'Quack!' }] } }] });
  await api.askDuck();
  b = JSON.parse(lastCall.opts.body);
  check('google: url pins the model', lastCall.url,
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
  check('google: x-goog-api-key', lastCall.opts.headers['x-goog-api-key'], 'AIzaX');
  check('google: system becomes systemInstruction', typeof b.systemInstruction.parts[0].text, 'string');
  check('google: assistant role is renamed to model', b.contents.map((c) => c.role), ['user', 'model', 'user']);
  check('google: cap is maxOutputTokens', b.generationConfig.maxOutputTokens, 220);
  check('google: reply read from candidates', state.messages[3].content, 'Quack!');

  // --- Cross-cutting --------------------------------------------------------
  state.messages = [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'rejected that key', error: true },
    { role: 'user', content: 'second' },
  ];
  check('errors dropped, same-role turns merged so roles alternate',
    api.apiMessages(), [{ role: 'user', content: 'first\n\nsecond' }]);

  state.provider = 'anthropic'; state.storedKey = '';
  check('the shipped tester key is openrouter-only', stateMod.activeKey(), '');
  state.provider = 'openrouter';
  check('openrouter falls back to the shipped tester key', stateMod.activeKey(), stateMod.SHARED_KEY);

  state.provider = 'google';
  check('google 400 reads as a key problem', api.apiErrorMessage(400, 'API key not valid').includes('rejected that key'), true);
  state.provider = 'openrouter';
  check('openrouter 429 explains the shared free quota', api.apiErrorMessage(429, '').includes('50 a day'), true);
  state.provider = 'openai';
  check('openai 429 does not mention the free quota', api.apiErrorMessage(429, '').includes('50 a day'), false);
  check('404 names the provider and the model', api.apiErrorMessage(404, ''), 'OpenAI does not know the model gpt-5.6-luna.');

  check('stop reasons decoded for every provider vocabulary', [
    api.emptyReason({ choices: [{ finish_reason: 'length' }] }).includes('length cap'),
    api.emptyReason({ candidates: [{ finishReason: 'MAX_TOKENS' }] }).includes('length cap'),
    api.emptyReason({ stop_reason: 'max_tokens' }).includes('length cap'),
    api.emptyReason({ candidates: [{ finishReason: 'SAFETY' }] }).includes('content filter'),
  ], [true, true, true, true]);

  state.boardItems = ['nav | search', 'onboarding copy'];
  fallback.resetFallbackCursors();
  const r = [fallback.fallbackReply(true), fallback.fallbackReply(), fallback.fallbackReply()];
  check('keyless fallback quotes the real board',
    [r[0].startsWith('I can see 2 things'), r[0].includes('nav | search'), new Set(r).size], [true, true, 3]);
};
