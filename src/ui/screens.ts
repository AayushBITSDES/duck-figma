import { state, activeKey, Mode } from './state';
import { PROVIDERS, PROVIDER_IDS, ProviderId } from './providers';
import { render, renderCollapsed, escapeHtml, escapeAttr, renderMarkdown } from './render';
import { duckSvg } from './duck';
import { Mood, moodOpeners, fallbackReply, resetFallbackCursors } from './fallback';
import { askDuck } from './api';
import { post, requestBoard, applyTextSize } from './bridge';

// The plugin has no window into which screen is up, and it needs one: a
// check-in firing while the duck is collapsed should only pop the panel open
// if the duck is actually going to ask something. Reporting every screen
// change beats the plugin guessing, and beats it expanding on a check-in the
// UI then declines to show. See the MESSAGE CONTRACT in plugin/window.ts.
//
// Every screen goes through here rather than assigning state.mode directly,
// so a new screen cannot forget to report itself.
function setMode(mode: Mode) {
  state.mode = mode;
  post({ type: 'mode', mode: mode });
}

export function header(sub: string) {
  return (
    '<div class="hdr">' + duckSvg(20) +
    '<span class="hdr-title">Duck Check-In</span>' +
    '<span class="hdr-sub">' + escapeHtml(sub) + '</span>' +
    minimizeButton() +
    '</div>'
  );
}

// Clicks are handled by one delegated listener in ui.ts rather than rebound by
// every screen after every paint, so this is markup only.
// 9 to 18 matches the clamp in plugin/window.ts. Anything outside it is
// clamped over there anyway, so the list just avoids offering a size that
// would silently snap back.
function textSizeOptions() {
  let out = '';
  for (let px = 9; px <= 18; px++) {
    out += '<option value="' + px + '"' + (px === state.textSize ? ' selected' : '') + '>' + px + 'px</option>';
  }
  return out;
}

export function minimizeButton() {
  return '<button id="min" class="ghost mini" title="Collapse to the duck">-</button>';
}

// The collapsed view: a 70x70 window that is all duck. 70 is figma.showUI's
// hard floor for width, so this is as small as a plugin window goes.
export function showCollapsed() {
  renderCollapsed('<div class="collapsed" id="collapsed" title="Open the duck">' + duckSvg(44) + '</div>');
}

// Expanding cannot just restore the HTML that was on screen before, because
// its event handlers died with it. Re-running the screen rebinds them.
export function repaint() {
  // openSettings() reseeds the draft from storage, which is right for a
  // fresh entry into settings but wrong for coming back from a collapse: it
  // would throw away whatever the user had typed. Once settings have loaded
  // the draft is the source of truth, so re-run the form as-is instead of
  // re-opening it. Before that load finishes there is no draft to lose (the
  // form itself has not rendered yet), so openSettings() is still right.
  if (state.mode === 'settings') return state.settingsLoaded ? showSettings() : openSettings();
  if (state.mode === 'checkin') return showCheckIn();
  if (state.mode === 'chat') return renderChat();
  return idleDuck();
}

export function idleDuck() {
  setMode('idle');
  render(
    '<div class="screen"><div class="idle">' +
    '<div id="duck" class="idle-duck" title="Talk to the duck">' + duckSvg(72) + '</div>' +
    '<div class="muted">Working away. I\'ll say hi if the board goes quiet.</div>' +
    '<button id="settings" class="ghost">Settings</button>' +
    '</div>' + minimizeButton() + '</div>'
  );
  // render() already swallowed the paint above while collapsed, leaving
  // #root's old (or absent) content in place; wiring handlers to elements
  // that were never (re)painted is what used to throw here. The mode change
  // above still stands, so expanding later repaints the right screen.
  if (state.minimized) return;
  document.getElementById('duck')!.onclick = () => {
    post({ type: 'get-board' });
    showCheckIn();
  };
  document.getElementById('settings')!.onclick = openSettings;
}

export function openSettings() {
  if (!state.settingsLoaded) {
    setMode('settings');
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
  setMode('settings');
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
    '<div><label for="text-size">Text size</label>' +
    '<select id="text-size">' + textSizeOptions() + '</select></div>' +
    '<div class="muted tiny">Model: ' + escapeHtml(p.model) + '</div>' +
    '<div class="muted tiny">Your key is stored on this device only. In live mode your board text and messages go to ' + escapeHtml(p.label) + ' and nowhere else. Without a key I still read the board, but replies are canned templates rather than a conversation.</div>' +
    '</div>' +
    '<div class="ftr">' +
    '<button id="save" class="primary">Save</button>' +
    '<button id="back" class="ghost">Back</button>' +
    '</div></div>'
  );
  // Same reasoning as idleDuck(): nothing was actually painted while
  // collapsed, so there is nothing here to wire up yet.
  if (state.minimized) return;
  const select = document.getElementById('provider') as HTMLSelectElement;
  const input = document.getElementById('key-input') as HTMLInputElement;
  // Kept in sync on every keystroke (paste included) rather than read once at
  // Save time, because a repaint of this screen can happen for reasons that
  // have nothing to do with the key: a text size change, or the panel being
  // collapsed and expanded while settings is still open. Either would
  // otherwise rebuild the form from the stale draft and silently drop
  // whatever was typed.
  input.oninput = () => {
    state.draftKey = input.value;
  };
  select.onchange = () => {
    state.draftProvider = select.value as ProviderId;
    // One key is kept, for the provider in use. Switching to a different one
    // needs its own key; switching back brings the saved one into view again.
    state.draftKey = state.draftProvider === state.provider ? state.storedKey : '';
    showSettings();
  };
  const size = document.getElementById('text-size') as HTMLSelectElement | null;
  if (size) {
    size.onchange = () => {
      const px = parseInt(size.value, 10);
      applyTextSize(px);
      post({ type: 'text-size', size: px });
      showSettings();
    };
  }
  document.getElementById('save')!.onclick = () => {
    state.provider = state.draftProvider;
    state.storedKey = input.value.trim();
    post({ type: 'save-settings', provider: state.provider, key: state.storedKey });
    idleDuck();
  };
  document.getElementById('back')!.onclick = idleDuck;
}

export function showCheckIn() {
  setMode('checkin');
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
  // Same reasoning as idleDuck(): nothing was actually painted while
  // collapsed, so there is nothing here to wire up yet.
  if (state.minimized) return;
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
  setMode('chat');
  let turns = '';
  state.messages.forEach((m) => {
    const mine = m.role === 'user';
    const cls = m.error ? 'err' : mine ? 'mine' : 'them';
    // The user typed theirs literally, and our own error copy has no markdown
    // in it, so only a successful assistant reply gets the markdown pass.
    const body = mine || m.error ? escapeHtml(m.content) : renderMarkdown(m.content);
    turns +=
      '<div class="turn' + (mine ? ' mine' : '') + '">' +
      (mine || m.error ? '' : duckSvg(16)) +
      '<div class="bubble ' + cls + '">' + body + '</div></div>';
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
  // Same reasoning as idleDuck(): a reply can land while collapsed (nothing
  // awaits sendUserText, so this runs on its own schedule), and nothing was
  // actually painted just now, so there is nothing here to scroll or wire up.
  if (state.minimized) return;
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
