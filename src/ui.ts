type Mood = 'stuck' | 'frustrated' | 'thinking' | 'fine';
type ChatMsg = { role: 'user' | 'assistant'; content: string; error?: boolean };
type Mode = 'idle' | 'settings' | 'checkin' | 'chat';
type ProviderId = 'openrouter' | 'openai' | 'anthropic' | 'google';

const MAX_REPLY_TOKENS = 220;
// Only meaningful for OpenRouter, whose free models cost nothing. Paste a key here
// and testers need no setup. It ships inside the plugin, so treat it as public:
// free models only, never a key with credit on it, and don't commit one.
const SHARED_KEY = '';

const DUCK_BRIEF =
  "You are a small yellow rubber duck sitting on a FigJam board, keeping a designer company while they work. Warm, plain, brief, 2 to 4 sentences. Check in on how they are doing before problem solving. Ask one question at a time. Reference specific things from the board snapshot when it helps, otherwise ignore it. Never lecture, never sound like a corporate assistant.";

type Provider = {
  label: string;
  model: string;
  hint: string;
  url: string;
  headers: (key: string) => Record<string, string>;
  body: (system: string, msgs: { role: string; content: string }[]) => any;
  reply: (data: any) => string | undefined;
};

// Every one of these was checked against a live preflight: all four answer CORS
// for a null origin, which is the origin a Figma plugin iframe sends.
const PROVIDERS: Record<ProviderId, Provider> = {
  openrouter: {
    label: 'OpenRouter',
    model: 'thinkingmachines/inkling:free',
    hint: 'sk-or-v1-...  free, 20 req/min and 50/day per account',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    headers: (key) => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }),
    body: (system, msgs) => openAiBody(PROVIDERS.openrouter.model, system, msgs),
    reply: (d) => d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content,
  },
  openai: {
    label: 'OpenAI',
    model: 'gpt-5.6-luna',
    hint: 'sk-...  paid, pay as you go',
    url: 'https://api.openai.com/v1/chat/completions',
    headers: (key) => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }),
    body: (system, msgs) => openAiBody(PROVIDERS.openai.model, system, msgs),
    reply: (d) => d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content,
  },
  anthropic: {
    label: 'Anthropic',
    model: 'claude-haiku-4-5',
    hint: 'sk-ant-...  paid, pay as you go',
    url: 'https://api.anthropic.com/v1/messages',
    headers: (key) => ({
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    }),
    body: (system, msgs) => ({
      model: PROVIDERS.anthropic.model,
      max_tokens: MAX_REPLY_TOKENS,
      system,
      messages: msgs,
    }),
    reply: (d) => d && d.content && d.content[0] && d.content[0].text,
  },
  google: {
    label: 'Google AI Studio',
    model: 'gemini-3.8-flash',
    hint: 'AIza...  free tier available',
    url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent',
    headers: (key) => ({ 'Content-Type': 'application/json', 'x-goog-api-key': key }),
    body: (system, msgs) => ({
      systemInstruction: { parts: [{ text: system }] },
      contents: msgs.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
      generationConfig: { maxOutputTokens: MAX_REPLY_TOKENS },
    }),
    reply: (d) =>
      d && d.candidates && d.candidates[0] && d.candidates[0].content &&
      d.candidates[0].content.parts && d.candidates[0].content.parts[0] &&
      d.candidates[0].content.parts[0].text,
  },
};

function openAiBody(model: string, system: string, msgs: { role: string; content: string }[]) {
  return {
    model,
    max_completion_tokens: MAX_REPLY_TOKENS,
    messages: [{ role: 'system', content: system }].concat(msgs),
  };
}

const PROVIDER_IDS: ProviderId[] = ['openrouter', 'openai', 'anthropic', 'google'];

const root = document.getElementById('root')!;
let mode: Mode = 'idle';
let provider: ProviderId = 'openrouter';
let keys: { [k: string]: string } = {};
let messages: ChatMsg[] = [];
let loading = false;
let boardItems: string[] = [];
let boardReadAt = 0;
// Settings edits live here until Save, so Back discards them instead of
// silently pointing the next conversation at a provider that was never saved.
let draftProvider: ProviderId = 'openrouter';
let draftKeys: { [k: string]: string } = {};
// code.ts reads storage over several async round-trips before it can send the
// saved settings. Until that lands, seeding a draft would snapshot an empty key
// map, and saving it would wipe every other provider's key.
let settingsLoaded = false;

function activeKey(): string {
  const stored = (keys[provider] || '').trim();
  if (stored) return stored;
  return provider === 'openrouter' ? SHARED_KEY.trim() : '';
}

const moodOpeners: Record<Mood, string> = {
  stuck: "I'm feeling stuck.",
  frustrated: "I'm feeling frustrated.",
  thinking: "I'm just thinking things through.",
  fine: "I'm fine, just moving slow.",
};

const fallbackFollowUps = [
  "What's the actual goal on this board?",
  "What have you already tried?",
  "What's the smallest next step you could take?",
  "What would 'done' look like here?",
  "What's one thing you're avoiding right now?",
];
const fallbackItemTemplates = [
  "You've got \"ITEM\" up there. What's stopping you from moving on it?",
  "I see \"ITEM\" on the board. Still relevant, or is it stale?",
  "Out of everything there, is \"ITEM\" the one you're actually stuck on?",
  "\"ITEM\" is sitting on the board. Worth revisiting, or can it go?",
];
let fallbackTurn = 0;
let fallbackItemCursor = 0;

function post(msg: any) {
  parent.postMessage({ pluginMessage: msg }, '*');
}

function render(html: string) {
  root.innerHTML = html;
}

// Asks code.ts for a fresh board snapshot and waits for it, so a reply never
// quotes a board that has moved on. Resolves anyway if the reply never lands.
let boardWaiters: Array<() => void> = [];
function requestBoard(): Promise<void> {
  post({ type: 'get-board' });
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      boardWaiters = boardWaiters.filter((w) => w !== done);
      resolve();
    }, 1500);
    boardWaiters.push(done);
  });
}

let duckIdCounter = 0;
function duckSvg(size: number) {
  const fid = 'duckSketch' + (duckIdCounter++);
  const h = Math.round(size * 1.3);
  return (
    '<svg width="' + size + '" height="' + h + '" viewBox="0 0 100 130" aria-hidden="true">' +
    '<defs><filter id="' + fid + '" x="-25%" y="-25%" width="150%" height="150%">' +
    '<feTurbulence type="fractalNoise" baseFrequency="0.045" numOctaves="2" seed="4" result="n"/>' +
    '<feDisplacementMap in="SourceGraphic" in2="n" scale="3"/>' +
    '</filter></defs>' +
    '<ellipse cx="50" cy="122" rx="26" ry="5" fill="#000000" opacity="0.08"/>' +
    '<g filter="url(#' + fid + ')" stroke="#C98A1F" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">' +
    '<ellipse cx="50" cy="86" rx="25" ry="27" fill="#FFD662"/>' +
    '<ellipse cx="50" cy="100" rx="19" ry="12" fill="#FFC531" opacity="0.5" stroke="none"/>' +
    '<path d="M25 76 Q13 82 19 98 Q27 92 30 80 Z" fill="#FFC531"/>' +
    '<path d="M75 76 Q87 82 81 98 Q73 92 70 80 Z" fill="#FFC531"/>' +
    '<path d="M70 60 Q84 52 79 70 Q73 66 70 60 Z" fill="#FFC531"/>' +
    '<line x1="40" y1="110" x2="38" y2="117"/>' +
    '<line x1="60" y1="110" x2="62" y2="117"/>' +
    '<ellipse cx="37" cy="120" rx="9" ry="4.5" fill="#FF9F40"/>' +
    '<ellipse cx="63" cy="120" rx="9" ry="4.5" fill="#FF9F40"/>' +
    '<circle cx="50" cy="36" r="27" fill="#FFDD70"/>' +
    '<ellipse cx="49" cy="55" rx="13" ry="7" fill="#FF9F40"/>' +
    '<path d="M37 55 Q49 60 61 55" stroke="#C97116" stroke-width="2" fill="none"/>' +
    '<circle cx="40" cy="28" r="3.4" fill="#33261A" stroke="none"/>' +
    '<circle cx="60" cy="28" r="3.4" fill="#33261A" stroke="none"/>' +
    '<circle cx="41.2" cy="26.6" r="1" fill="#ffffff" stroke="none"/>' +
    '<circle cx="61.2" cy="26.6" r="1" fill="#ffffff" stroke="none"/>' +
    '<ellipse cx="31" cy="40" rx="6.5" ry="4.3" fill="#FFAFA0" stroke="none" opacity="0.6"/>' +
    '<ellipse cx="69" cy="40" rx="6.5" ry="4.3" fill="#FFAFA0" stroke="none" opacity="0.6"/>' +
    '</g>' +
    '</svg>'
  );
}

function header(sub: string) {
  return (
    '<div class="hdr">' + duckSvg(20) +
    '<span class="hdr-title">Duck Check-In</span>' +
    '<span class="hdr-sub">' + escapeHtml(sub) + '</span>' +
    '</div>'
  );
}

function idleDuck() {
  mode = 'idle';
  render(
    '<div class="screen"><div class="idle">' +
    '<div id="duck" class="idle-duck" title="Talk to the duck">' + duckSvg(72) + '</div>' +
    '<div class="muted">Working away. I\'ll say hi if the board goes quiet.</div>' +
    '<button id="settings" class="ghost">Settings</button>' +
    '</div></div>'
  );
  document.getElementById('duck')!.onclick = () => {
    post({ type: 'get-board' });
    showCheckIn();
  };
  document.getElementById('settings')!.onclick = openSettings;
}

function openSettings() {
  if (!settingsLoaded) {
    mode = 'settings';
    render(
      '<div class="screen">' + header('settings') +
      '<div class="body"><div class="muted">Loading your saved settings...</div></div>' +
      '</div>'
    );
    return;
  }
  draftProvider = provider;
  draftKeys = Object.assign({}, keys);
  showSettings();
}

// Reads whatever is in the key field into the draft before the screen redraws.
function stashDraftKey() {
  const input = document.getElementById('key-input') as HTMLInputElement | null;
  if (!input) return;
  const val = input.value.trim();
  if (val) draftKeys[draftProvider] = val;
  else delete draftKeys[draftProvider];
}

function showSettings() {
  mode = 'settings';
  const p = PROVIDERS[draftProvider];
  const options = PROVIDER_IDS.map(
    (id) =>
      '<option value="' + id + '"' + (id === draftProvider ? ' selected' : '') + '>' +
      escapeHtml(PROVIDERS[id].label) + (draftKeys[id] ? ' (key saved)' : '') +
      '</option>'
  ).join('');
  render(
    '<div class="screen">' + header('settings') +
    '<div class="body">' +
    '<div><label for="provider">Provider</label>' +
    '<select id="provider">' + options + '</select></div>' +
    '<div><label for="key-input">API key</label>' +
    '<input id="key-input" type="text" spellcheck="false" autocomplete="off" placeholder="' + escapeAttr(p.hint) + '" value="' + escapeAttr(draftKeys[draftProvider] || '') + '" /></div>' +
    '<div class="muted tiny">Model: ' + escapeHtml(p.model) + '</div>' +
    '<div class="muted tiny">Keys are stored on this device only. In live mode your board text and messages go to ' + escapeHtml(p.label) + ' and nowhere else. Without a key I still read the board, but replies are canned templates rather than a conversation.</div>' +
    '</div>' +
    '<div class="ftr">' +
    '<button id="save" class="primary">Save</button>' +
    '<div class="row">' +
    (draftKeys[draftProvider] ? '<button id="clear">Remove key</button>' : '') +
    '<button id="back" class="ghost">Back</button>' +
    '</div></div></div>'
  );
  const select = document.getElementById('provider') as HTMLSelectElement;
  select.onchange = () => {
    stashDraftKey();
    draftProvider = select.value as ProviderId;
    showSettings();
  };
  document.getElementById('save')!.onclick = () => {
    stashDraftKey();
    provider = draftProvider;
    keys = Object.assign({}, draftKeys);
    post({ type: 'save-settings', settings: { provider, keys } });
    idleDuck();
  };
  const clear = document.getElementById('clear');
  if (clear) clear.onclick = () => {
    delete draftKeys[draftProvider];
    showSettings();
  };
  document.getElementById('back')!.onclick = idleDuck;
}

function showCheckIn() {
  mode = 'checkin';
  const moods: [Mood, string][] = [
    ['stuck', 'Stuck'],
    ['frustrated', 'Frustrated'],
    ['thinking', 'Thinking'],
    ['fine', 'Fine, just slow'],
  ];
  render(
    '<div class="screen">' + header('') +
    '<div class="body">' +
    '<div class="turn"><div class="bubble them">Hey. Board\'s been quiet a bit. How are you doing?</div></div>' +
    moods.map((m) => '<button data-m="' + m[0] + '">' + m[1] + '</button>').join('') +
    '</div>' +
    '<div class="ftr"><button id="dismiss" class="ghost">Not now</button></div>' +
    '</div>'
  );
  document.querySelectorAll<HTMLButtonElement>('.body button').forEach((b) => {
    b.onclick = () => startChat(b.dataset.m as Mood);
  });
  document.getElementById('dismiss')!.onclick = () => {
    post({ type: 'dismiss' });
    idleDuck();
  };
}

function startChat(mood: Mood) {
  messages = [];
  fallbackTurn = 0;
  fallbackItemCursor = 0;
  sendUserText(moodOpeners[mood], true);
}

function fallbackReply(first = false): string {
  const useItem = boardItems.length > 0 && (first || fallbackTurn % 2 === 0);
  const turn = fallbackTurn++;
  if (useItem) {
    const raw = boardItems[fallbackItemCursor % boardItems.length];
    const template = fallbackItemTemplates[fallbackItemCursor % fallbackItemTemplates.length];
    fallbackItemCursor++;
    const item = raw.length > 60 ? raw.slice(0, 60) + '...' : raw;
    const line = template.replace('ITEM', item);
    if (first) {
      return 'I can see ' + boardItems.length + (boardItems.length === 1 ? ' thing' : ' things') + ' on the board. ' + line;
    }
    return line;
  }
  return fallbackFollowUps[turn % fallbackFollowUps.length];
}

async function sendUserText(userText: string, first = false) {
  messages.push({ role: 'user', content: userText });
  loading = !!activeKey();
  renderChat();
  await requestBoard();
  if (activeKey()) {
    await askDuck();
    loading = false;
  } else {
    messages.push({ role: 'assistant', content: fallbackReply(first) });
  }
  renderChat();
}

// Error bubbles never go back to the model. Consecutive same-role turns are
// merged because Anthropic and Google both require the roles to alternate.
function apiMessages() {
  const out: { role: string; content: string }[] = [];
  for (const m of messages) {
    if (m.error) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += '\n\n' + m.content;
    else out.push({ role: m.role, content: m.content });
  }
  return out;
}

function apiErrorMessage(status: number, detail: string): string {
  const who = PROVIDERS[provider].label;
  const tail = detail ? ' (' + detail + ')' : '';
  if (status === 400 && provider === 'google') return who + ' rejected that key or request' + tail + '.';
  if (status === 401) return who + ' rejected that key. Check it in settings' + tail + '.';
  if (status === 402) return 'That key has no credit left for this model' + tail + '.';
  if (status === 403) return "That key isn't allowed to use this model" + tail + '.';
  if (status === 404) return who + ' does not know the model ' + PROVIDERS[provider].model + tail + '.';
  if (status === 429) {
    return provider === 'openrouter'
      ? 'Too many requests. Free models allow 20 a minute and 50 a day, shared by everyone using this key' + tail + '.'
      : 'Rate limited, or the account is out of credit. Give it a minute' + tail + '.';
  }
  if (status >= 500) return who + "'s server errored (" + status + '). Try again in a moment.';
  return who + ' refused that request (' + status + ')' + tail + '.';
}

// Each provider names its stop reason differently; this covers all four.
function emptyReason(data: any): string {
  const c = data && data.choices && data.choices[0];
  const g = data && data.candidates && data.candidates[0];
  const stop = (c && c.finish_reason) || (g && g.finishReason) || (data && data.stop_reason);
  if (stop === 'content_filter' || stop === 'SAFETY') return 'That one got caught by the content filter.';
  if (stop === 'length' || stop === 'max_tokens' || stop === 'MAX_TOKENS') {
    return 'That reply hit the length cap before any of it came out.';
  }
  return 'The API answered, but with nothing in it. Try again?';
}

async function askDuck() {
  const p = PROVIDERS[provider];
  try {
    const system =
      DUCK_BRIEF +
      (boardItems.length
        ? '\n\nHere is a snapshot of text currently on the board, in no particular order:\n- ' + boardItems.join('\n- ')
        : '\n\nThe board looks empty right now, or has nothing with text on it.');
    const res = await fetch(p.url, {
      method: 'POST',
      headers: p.headers(activeKey()),
      body: JSON.stringify(p.body(system, apiMessages())),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const detail = (data && data.error && data.error.message) || '';
      messages.push({ role: 'assistant', content: apiErrorMessage(res.status, detail), error: true });
      return;
    }
    const text = p.reply(data);
    if (!text) {
      messages.push({ role: 'assistant', content: emptyReason(data), error: true });
      return;
    }
    messages.push({ role: 'assistant', content: text });
  } catch (e) {
    messages.push({
      role: 'assistant',
      content: "Couldn't reach " + p.label + '. Check your connection, then try again.',
      error: true,
    });
  }
}

function boardLine(): string {
  if (!boardReadAt) return 'Board not read yet.';
  if (!boardItems.length) return 'Nothing with text on the board right now.';
  return 'Reading ' + boardItems.length + (boardItems.length === 1 ? ' item' : ' items') + ' off the board.';
}

function renderChat() {
  mode = 'chat';
  let turns = '';
  messages.forEach((m) => {
    const mine = m.role === 'user';
    const cls = m.error ? 'err' : mine ? 'mine' : 'them';
    turns +=
      '<div class="turn' + (mine ? ' mine' : '') + '">' +
      (mine || m.error ? '' : duckSvg(16)) +
      '<div class="bubble ' + cls + '">' + escapeHtml(m.content) + '</div></div>';
  });
  if (loading) {
    turns += '<div class="turn">' + duckSvg(16) + '<div class="bubble them muted">thinking...</div></div>';
  }
  const droppable = [...messages].reverse().find((m) => m.role === 'assistant' && !m.error);
  render(
    '<div class="screen">' +
    header(activeKey() ? PROVIDERS[provider].label : 'no key, canned replies') +
    '<div class="body" id="thread">' + turns + '</div>' +
    '<div class="ftr">' +
    '<textarea id="answer" rows="2" placeholder="Type here..."></textarea>' +
    '<div class="row">' +
    '<button id="send" class="primary"' + (loading ? ' disabled' : '') + '>Send</button>' +
    '<button id="refresh">Re-read board</button>' +
    '</div>' +
    '<div class="row">' +
    (droppable ? '<button id="drop">Drop last reply on board</button>' : '') +
    '<button id="done" class="ghost">I\'m good, thanks</button>' +
    '</div>' +
    '<div class="muted tiny">' + escapeHtml(boardLine()) + '</div>' +
    '</div></div>'
  );
  const thread = document.getElementById('thread')!;
  thread.scrollTop = thread.scrollHeight;
  document.getElementById('send')!.onclick = () => {
    if (loading) return;
    const ta = document.getElementById('answer') as HTMLTextAreaElement;
    const val = ta.value.trim();
    if (!val) return;
    ta.value = '';
    sendUserText(val);
  };
  document.getElementById('refresh')!.onclick = async () => {
    await requestBoard();
    renderChat();
  };
  const dropBtn = document.getElementById('drop');
  if (dropBtn && droppable) {
    dropBtn.onclick = () => {
      post({ type: 'drop-sticky', text: droppable.content });
      post({ type: 'dismiss' });
      idleDuck();
    };
  }
  document.getElementById('done')!.onclick = () => {
    post({ type: 'dismiss' });
    idleDuck();
  };
}

function escapeHtml(s: string) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function escapeAttr(s: string) {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

window.onmessage = (event) => {
  const msg = event.data.pluginMessage;
  if (!msg) return;
  if (msg.type === 'checkin') {
    boardItems = Array.isArray(msg.board) ? msg.board : [];
    boardReadAt = Date.now();
    // Only interrupt the resting duck: never wipe a chat or a half-typed key.
    if (mode === 'idle') showCheckIn();
  }
  if (msg.type === 'board-context') {
    boardItems = Array.isArray(msg.board) ? msg.board : [];
    boardReadAt = Date.now();
    const waiters = boardWaiters;
    boardWaiters = [];
    waiters.forEach((w) => w());
  }
  // Back to work: stand down only if the duck is still just asking.
  if (msg.type === 'resume' && mode === 'checkin') idleDuck();
  if (msg.type === 'settings') {
    const settings = msg.settings || {};
    if (PROVIDERS[settings.provider as ProviderId]) provider = settings.provider;
    keys = settings.keys || {};
    settingsLoaded = true;
    // Re-seed a settings screen that was opened before this arrived.
    if (mode === 'settings') openSettings();
  }
};

idleDuck();
