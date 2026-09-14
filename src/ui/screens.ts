import { state, activeKey } from './state';
import { PROVIDERS, PROVIDER_IDS, ProviderId } from './providers';
import { render, escapeHtml, escapeAttr } from './render';
import { duckSvg } from './duck';
import { Mood, moodOpeners, fallbackReply, resetFallbackCursors } from './fallback';
import { askDuck } from './api';
import { post, requestBoard } from './bridge';

export function header(sub: string) {
  return (
    '<div class="hdr">' + duckSvg(20) +
    '<span class="hdr-title">Duck Check-In</span>' +
    '<span class="hdr-sub">' + escapeHtml(sub) + '</span>' +
    '</div>'
  );
}

export function idleDuck() {
  state.mode = 'idle';
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

export function openSettings() {
  if (!state.settingsLoaded) {
    state.mode = 'settings';
    render(
      '<div class="screen">' + header('settings') +
      '<div class="body"><div class="muted">Loading your saved settings...</div></div>' +
      '</div>'
    );
    return;
  }
  state.draftProvider = state.provider;
  state.draftKey = state.storedKey;
  showSettings();
}

export function showSettings() {
  state.mode = 'settings';
  const p = PROVIDERS[state.draftProvider];
  const options = PROVIDER_IDS.map(
    (id) =>
      '<option value="' + id + '"' + (id === state.draftProvider ? ' selected' : '') + '>' +
      escapeHtml(PROVIDERS[id].label) + '</option>'
  ).join('');
  render(
    '<div class="screen">' + header('settings') +
    '<div class="body">' +
    '<div><label for="provider">Provider</label>' +
    '<select id="provider">' + options + '</select></div>' +
    '<div><label for="key-input">API key</label>' +
    '<input id="key-input" type="text" spellcheck="false" autocomplete="off" placeholder="' + escapeAttr(p.hint) + '" value="' + escapeAttr(state.draftKey) + '" /></div>' +
    '<div class="muted tiny">Model: ' + escapeHtml(p.model) + '</div>' +
    '<div class="muted tiny">Your key is stored on this device only. In live mode your board text and messages go to ' + escapeHtml(p.label) + ' and nowhere else. Without a key I still read the board, but replies are canned templates rather than a conversation.</div>' +
    '</div>' +
    '<div class="ftr">' +
    '<button id="save" class="primary">Save</button>' +
    '<button id="back" class="ghost">Back</button>' +
    '</div></div>'
  );
  const select = document.getElementById('provider') as HTMLSelectElement;
  const input = document.getElementById('key-input') as HTMLInputElement;
  select.onchange = () => {
    state.draftProvider = select.value as ProviderId;
    // One key is kept, for the provider in use. Switching to a different one
    // needs its own key; switching back brings the saved one into view again.
    state.draftKey = state.draftProvider === state.provider ? state.storedKey : '';
    showSettings();
  };
  document.getElementById('save')!.onclick = () => {
    state.provider = state.draftProvider;
    state.storedKey = input.value.trim();
    post({ type: 'save-settings', provider: state.provider, key: state.storedKey });
    idleDuck();
  };
  document.getElementById('back')!.onclick = idleDuck;
}

export function showCheckIn() {
  state.mode = 'checkin';
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

export function startChat(mood: Mood) {
  state.messages = [];
  resetFallbackCursors();
  sendUserText(moodOpeners[mood], true);
}

function boardLine(): string {
  if (!state.boardReadAt) return 'Board not read yet.';
  if (!state.boardItems.length) return 'Nothing with text on the board right now.';
  return 'Reading ' + state.boardItems.length + (state.boardItems.length === 1 ? ' item' : ' items') + ' off the board.';
}

export async function sendUserText(userText: string, first = false) {
  state.messages.push({ role: 'user', content: userText });
  state.loading = !!activeKey();
  renderChat();
  await requestBoard();
  if (activeKey()) {
    await askDuck();
  } else {
    state.messages.push({ role: 'assistant', content: fallbackReply(first) });
  }
  // Unconditional: the key can disappear while the board request is in flight,
  // and the fallback branch used to leave this stuck on.
  state.loading = false;
  // The user may have walked away from the chat while this was in flight.
  // Repaint only if they are still looking at it.
  if (state.mode === 'chat') renderChat();
}

export function renderChat() {
  state.mode = 'chat';
  let turns = '';
  state.messages.forEach((m) => {
    const mine = m.role === 'user';
    const cls = m.error ? 'err' : mine ? 'mine' : 'them';
    turns +=
      '<div class="turn' + (mine ? ' mine' : '') + '">' +
      (mine || m.error ? '' : duckSvg(16)) +
      '<div class="bubble ' + cls + '">' + escapeHtml(m.content) + '</div></div>';
  });
  if (state.loading) {
    turns += '<div class="turn">' + duckSvg(16) + '<div class="bubble them muted">thinking...</div></div>';
  }
  const droppable = [...state.messages].reverse().find((m) => m.role === 'assistant' && !m.error);
  render(
    '<div class="screen">' +
    header(activeKey() ? PROVIDERS[state.provider].label : 'no key, canned replies') +
    '<div class="body" id="thread">' + turns + '</div>' +
    '<div class="ftr">' +
    '<textarea id="answer" rows="2" placeholder="Type here..."></textarea>' +
    '<div class="row">' +
    '<button id="send" class="primary"' + (state.loading ? ' disabled' : '') + '>Send</button>' +
    '<button id="refresh">Re-read board</button>' +
    '</div>' +
    (droppable ? '<button id="drop">Drop last reply on board</button>' : '') +
    '<button id="done" class="ghost">I\'m good, thanks</button>' +
    '<div class="muted tiny">' + escapeHtml(boardLine()) + '</div>' +
    '</div></div>'
  );
  const thread = document.getElementById('thread')!;
  thread.scrollTop = thread.scrollHeight;
  document.getElementById('send')!.onclick = () => {
    if (state.loading) return;
    const ta = document.getElementById('answer') as HTMLTextAreaElement;
    const val = ta.value.trim();
    if (!val) return;
    ta.value = '';
    sendUserText(val);
  };
  document.getElementById('refresh')!.onclick = async () => {
    await requestBoard();
    if (state.mode === 'chat') renderChat();
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
