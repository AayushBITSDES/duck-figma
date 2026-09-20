import { ChatMessage, Participant, SESSION_LIMITS } from '../shared/protocol';
import { post, applyTextSize } from './bridge';
import { duckSvg } from './duck';
import { escapeHtml, render, renderCollapsed, renderMarkdown } from './render';
import { actContribute, actPass, actRetry, actSetState, onPaint, reconnectSession } from './session';
import { iHaveActed, lastFacilitatorText, moodLabel, MOODS, Mode, state } from './state';

// The plugin has no window into which screen is up. Every screen goes through
// here rather than assigning state.mode directly, so a new screen cannot
// forget to report itself.
function setMode(mode: Mode) {
  state.mode = mode;
  post({ type: 'mode', mode: mode });
}

export function header(sub: string) {
  return (
    '<header class="hdr">' + duckSvg(20) +
    '<span class="hdr-title">Duck Check-In</span>' +
    '<span id="hdr-sub" class="hdr-sub">' + escapeHtml(sub) + '</span>' +
    minimizeButton() +
    '</header>'
  );
}

function textSizeOptions() {
  let out = '';
  for (let px = 9; px <= 18; px++) {
    out += '<option value="' + px + '"' + (px === state.textSize ? ' selected' : '') + '>' + px + 'px</option>';
  }
  return out;
}

export function minimizeButton() {
  return '<button type="button" id="min" class="ghost mini" title="Collapse to the duck" aria-label="Collapse to the duck">-</button>';
}

export function showCollapsed() {
  renderCollapsed(
    '<button type="button" class="collapsed" id="collapsed" title="Open the duck" aria-label="Open the duck">' +
    duckSvg(44) +
    '</button>'
  );
}

export function repaint() {
  if (state.mode === 'settings') return showSettings();
  if (state.gotSnapshot) return showSession({ focus: true });
  return showConnecting();
}

export function paintSession() {
  if (state.mode === 'settings') return;
  if (state.gotSnapshot) showSession({ focus: state.mode === 'connecting' });
  else showConnecting();
}

onPaint(paintSession);

export function showConnecting() {
  setMode('connecting');
  const err = state.banner && state.banner.kind === 'error' ? state.banner.text : '';
  const line =
    state.ws === 'reconnecting'
      ? 'Reconnecting to this board\'s session...'
      : 'Joining this board\'s session...';
  render(
    '<div class="screen">' +
    '<div class="idle" role="status" aria-live="polite">' +
    '<div class="idle-duck" aria-hidden="true">' + duckSvg(72) + '</div>' +
    '<div>' + escapeHtml(line) + '</div>' +
    (err ? '<div class="bubble err">' + escapeHtml(err) + '</div>' : '') +
    '</div>' +
    minimizeButton() +
    '</div>'
  );
}

export function openSettings() {
  showSettings();
}

export function showSettings() {
  setMode('settings');
  render(
    '<div class="screen">' + header('settings') +
    '<div class="body">' +
    '<div><label for="text-size">Text size</label>' +
    '<select id="text-size">' + textSizeOptions() + '</select></div>' +
    '<p class="muted tiny">Text size is saved on this device.</p>' +
    '<div><button type="button" id="reset-size">Reset panel size</button></div>' +
    '<p class="muted tiny">Drag the right or bottom edge to resize. If the panel ends up bigger than your Figma window, reset it here.</p>' +
    '</div>' +
    '<footer class="ftr">' +
    '<button type="button" id="back" class="ghost">Back</button>' +
    '</footer></div>'
  );
  if (state.minimized) return;
  const size = document.getElementById('text-size') as HTMLSelectElement | null;
  if (size) {
    size.onchange = () => {
      const px = parseInt(size.value, 10);
      applyTextSize(px);
      post({ type: 'text-size', size: px });
      showSettings();
    };
    size.focus();
  }
  const resetSize = document.getElementById('reset-size');
  if (resetSize) resetSize.onclick = () => post({ type: 'reset-size' });
  const back = document.getElementById('back');
  if (back) {
    back.onclick = () => {
      if (state.gotSnapshot) showSession({ focus: true });
      else showConnecting();
    };
  }
}

function subtitle(): string {
  if (state.ws === 'reconnecting') return 'reconnecting';
  if (state.ws !== 'live') return 'connecting';
  if (state.round.status === 'thinking') return 'thinking...';
  if (state.round.status === 'failed') return 'retry';
  const n = state.participants.length;
  const pending = pendingOthers();
  if (iHaveActed() && pending.length) {
    const extra = pending.length > 1 ? ' +' + (pending.length - 1) : '';
    return 'waiting on ' + pending[0].displayName + extra;
  }
  return n + ' here';
}

function pendingOthers(): Participant[] {
  const out: Participant[] = [];
  for (let i = 0; i < state.participants.length; i++) {
    const p = state.participants[i];
    if (p.status === 'pending' && p.clientId !== state.clientId) out.push(p);
  }
  return out;
}

function presenceInner(): string {
  if (!state.participants.length) {
    return '<span class="muted tiny">No one else is here yet.</span>';
  }
  let chips = '';
  for (let i = 0; i < state.participants.length; i++) {
    const p = state.participants[i];
    const mine = p.clientId === state.clientId;
    const status =
      p.status === 'contributed' ? 'contributed' :
      p.status === 'passed' ? 'passed' : 'here';
    const label = p.displayName + (mine ? ' (you)' : '');
    chips +=
      '<span class="chip' + (mine ? ' you' : '') + (p.status !== 'pending' ? ' done' : '') +
      '" role="listitem">' + escapeHtml(label) + ', ' + status + '</span>';
  }
  return chips;
}

function presenceHtml(): string {
  return '<div id="presence" class="presence" role="list" aria-label="Connected">' +
    presenceInner() + '</div>';
}

function roundLine(): string {
  if (state.ws === 'reconnecting') return 'Reconnecting. Your messages stay until a fresh snapshot arrives.';
  if (state.round.status === 'thinking') return 'Everyone is in. The duck is thinking.';
  if (state.round.status === 'failed') return 'The duck could not reply. Anyone can retry.';
  if (iHaveActed()) {
    const pending = pendingOthers();
    if (!pending.length) return 'Waiting for the rest of the group.';
    const names = pending.map((p) => p.displayName).join(', ');
    return 'Waiting on ' + names + '.';
  }
  if (state.round.id <= 1) return 'Choose how you are doing. That counts as your turn.';
  return 'Add something for this round, or pass.';
}

function isMine(m: ChatMessage): boolean {
  return !!(state.clientId && m.author && m.author.clientId === state.clientId);
}

function turnHtml(m: ChatMessage): string {
  const mine = isMine(m);
  const name = (m.author && m.author.displayName) || 'Someone';
  const kind = m.kind;
  if (kind === 'facilitator') {
    return (
      '<div class="turn">' + duckSvg(16) +
      '<div class="stack">' +
      '<div class="who">' + escapeHtml(name || 'Duck') + '</div>' +
      '<div class="bubble them">' + renderMarkdown(m.text) + '</div>' +
      '</div></div>'
    );
  }
  if (kind === 'pass' || kind === 'system') {
    const text = kind === 'pass' ? name + ' passed' : m.text;
    return (
      '<div class="turn">' +
      '<div class="stack">' +
      '<div class="who">' + escapeHtml(name) + '</div>' +
      '<div class="bubble them muted">' + escapeHtml(text) + '</div>' +
      '</div></div>'
    );
  }
  if (kind === 'state') {
    const mood = m.mood ? moodLabel(m.mood) : '';
    const text = m.text || (name + (mood ? ' is ' + mood + '.' : ' checked in.'));
    return (
      '<div class="turn' + (mine ? ' mine' : '') + '">' +
      '<div class="stack">' +
      '<div class="who">' + escapeHtml(mine ? 'You' : name) + '</div>' +
      '<div class="bubble ' + (mine ? 'mine' : 'them') + '">' + escapeHtml(text) + '</div>' +
      '</div></div>'
    );
  }
  // contribution
  return (
    '<div class="turn' + (mine ? ' mine' : '') + '">' +
    '<div class="stack">' +
    '<div class="who">' + escapeHtml(mine ? 'You' : name) + '</div>' +
    '<div class="bubble ' + (mine ? 'mine' : 'them') + '">' + escapeHtml(m.text) + '</div>' +
    '</div></div>'
  );
}

function threadHtml(): string {
  let turns = '';
  for (let i = 0; i < state.messages.length; i++) {
    turns += turnHtml(state.messages[i]);
  }
  if (state.round.status === 'thinking') {
    turns += thinkingTurnHtml();
  }
  if (state.banner && state.banner.kind === 'error') {
    turns += bannerTurnHtml(state.banner.text);
  }
  return turns;
}

function thinkingTurnHtml(): string {
  return '<section id="thinking-turn" class="turn">' + duckSvg(16) +
    '<div class="bubble them muted">thinking...</div></section>';
}

function bannerTurnHtml(text: string): string {
  return '<section id="banner-turn" class="turn"><div class="bubble err">' +
    escapeHtml(text) + '</div></section>';
}

type Composer = 'moods' | 'contribute' | 'waiting' | 'thinking' | 'failed' | 'offline';

function composerKind(): Composer {
  if (state.ws !== 'live') return 'offline';
  if (state.round.status === 'thinking') return 'thinking';
  if (state.round.status === 'failed') return 'failed';
  if (iHaveActed()) return 'waiting';
  if (state.round.id <= 1) return 'moods';
  return 'contribute';
}

function moodButtons(): string {
  const disabled = state.busy ? ' disabled' : '';
  return MOODS.map((m) =>
    '<button type="button" id="' + m.buttonId + '" data-m="' + m.id + '"' + disabled + '>' +
    escapeHtml(m.label) + '</button>'
  ).join('');
}

function capLocked(): boolean {
  return !!(state.banner && (state.banner.code === 'session_cap' || state.banner.code === 'rate_limited'));
}

function footerInner(kind: Composer): string {
  const summaryText = lastFacilitatorText();
  const summaryDisabled = summaryText ? '' : ' disabled';
  const summary =
    '<button type="button" id="summary" class="ghost"' + summaryDisabled + '>Update summary</button>';
  const settings = '<button type="button" id="settings" class="ghost">Settings</button>';
  const locked = state.busy ? ' disabled' : '';
  const info = state.banner && state.banner.kind === 'info' ? state.banner.text : '';
  const infoHtml = info ? '<p class="muted tiny">' + escapeHtml(info) + '</p>' : '';
  if (kind === 'moods') {
    return moodButtons() + summary + settings + infoHtml;
  }
  if (kind === 'contribute') {
    return (
      '<textarea id="answer" rows="2" maxlength="' + SESSION_LIMITS.maxTextLength +
      '" placeholder="Type here..." aria-label="Message to the group"' +
      (state.busy ? ' disabled' : '') + '>' + escapeHtml(state.draft) + '</textarea>' +
      '<div class="row">' +
      '<button type="button" id="send" class="primary"' + locked + '>Send</button>' +
      '<button type="button" id="pass" class="ghost"' + locked + '>Pass</button>' +
      '</div>' +
      summary + settings + infoHtml
    );
  }
  if (kind === 'failed') {
    const retry = capLocked() ? '' : '<button type="button" id="retry" class="primary">Retry</button>';
    return retry + summary + settings + infoHtml;
  }
  if (kind === 'waiting' || kind === 'thinking') {
    return summary + settings + infoHtml;
  }
  // 'offline' covers both "the socket dropped and we are on it" and "we have
  // stopped trying and only the user can decide what happens next".
  if (state.banner && state.banner.action === 'reconnect') {
    return '<button type="button" id="reconnect" class="primary">Reconnect</button>' +
      summary + settings + infoHtml;
  }
  return '<p class="muted tiny">Reconnecting...</p>' + summary + settings + infoHtml;
}

function footerHtml(kind: Composer): string {
  return '<footer class="ftr" id="composer">' + footerInner(kind) + '</footer>';
}

// innerHTML rebuilds destroy the textarea; these remember caret/focus across
// every live paint so typing is not kicked out by presence or a peer message.
let composerFocus = false;
let composerCaret = 0;
let composerCaretEnd = 0;

function captureComposer() {
  const answer = document.getElementById('answer') as HTMLTextAreaElement | null;
  if (!answer) return;
  state.draft = answer.value;
  if (typeof answer.selectionStart === 'number') {
    composerCaret = answer.selectionStart;
    composerCaretEnd = typeof answer.selectionEnd === 'number' ? answer.selectionEnd : composerCaret;
  }
  const active = document.activeElement as HTMLElement | null;
  composerFocus = !!(active && (active === answer || active.id === 'answer'));
}

function restoreCaret(answer: HTMLTextAreaElement) {
  const max = answer.value.length;
  const start = Math.max(0, Math.min(composerCaret, max));
  const end = Math.max(0, Math.min(composerCaretEnd, max));
  if (typeof answer.setSelectionRange === 'function') {
    try { answer.setSelectionRange(start, end); } catch (_) {}
  } else {
    answer.selectionStart = start;
    answer.selectionEnd = end;
  }
}

function wireComposer(answer: HTMLTextAreaElement) {
  answer.value = state.draft;
  answer.oninput = () => {
    state.draft = answer.value;
    if (typeof answer.selectionStart === 'number') {
      composerCaret = answer.selectionStart;
      composerCaretEnd = typeof answer.selectionEnd === 'number' ? answer.selectionEnd : composerCaret;
    }
  };
}

function wireFooter(kind: Composer, focus?: boolean) {
  MOODS.forEach((m) => {
    const btn = document.getElementById(m.buttonId);
    if (btn) btn.onclick = () => actSetState(m.id);
  });
  const send = document.getElementById('send');
  if (send) {
    send.onclick = () => {
      const ta = document.getElementById('answer') as HTMLTextAreaElement | null;
      if (!ta) return;
      const val = ta.value.trim();
      if (!val) return;
      // Keep the draft until the socket send succeeds. Clearing here loses
      // the text if the board wait outlives the connection.
      if (!state.draft) state.draft = ta.value;
      void actContribute(val);
    };
  }
  const pass = document.getElementById('pass');
  if (pass) pass.onclick = () => actPass();
  const retry = document.getElementById('retry');
  if (retry) retry.onclick = () => actRetry();
  const reconnect = document.getElementById('reconnect');
  if (reconnect) reconnect.onclick = () => reconnectSession();
  const summary = document.getElementById('summary');
  if (summary) {
    summary.onclick = () => {
      const text = lastFacilitatorText();
      if (!text) return;
      post({ type: 'update-summary', text: text });
    };
  }
  const settings = document.getElementById('settings');
  if (settings) settings.onclick = openSettings;

  const answer = document.getElementById('answer') as HTMLTextAreaElement | null;
  if (kind === 'contribute' && answer) wireComposer(answer);

  const restoreAnswer = kind === 'contribute' && !!answer && composerFocus;
  if (restoreAnswer && answer) {
    answer.focus();
    restoreCaret(answer);
    return;
  }
  if (!focus) return;
  if (kind === 'moods') {
    const first = document.getElementById('mood-stuck');
    if (first) first.focus();
  } else if (kind === 'contribute' && answer) {
    answer.focus();
    restoreCaret(answer);
  } else if (kind === 'failed') {
    const retryBtn = document.getElementById('retry');
    if (retryBtn) retryBtn.focus();
  }
}

type FocusMemory = { id: string; start?: number; end?: number };

let paintedMessageIds: string[] = [];
let paintedComposer: Composer | null = null;
let paintedInfo = '';
let paintedThinking = false;
let paintedBanner = '';

function sessionDomReady(): boolean {
  return !!(
    document.getElementById('thread') &&
    document.getElementById('presence') &&
    document.getElementById('round') &&
    document.getElementById('composer') &&
    document.getElementById('hdr-sub')
  );
}

function captureFocus(): FocusMemory | null {
  const active = document.activeElement as HTMLElement | null;
  if (!active || !active.id) return null;
  const memory: FocusMemory = { id: active.id };
  if (active.id === 'answer') {
    const answer = active as HTMLTextAreaElement;
    if (typeof answer.selectionStart === 'number') {
      memory.start = answer.selectionStart;
      memory.end = typeof answer.selectionEnd === 'number' ? answer.selectionEnd : answer.selectionStart;
    }
  }
  return memory;
}

function restoreFocus(memory: FocusMemory | null) {
  if (!memory) return;
  const node = document.getElementById(memory.id) as HTMLTextAreaElement | null;
  if (!node) return;
  node.focus();
  if (memory.id === 'answer' && typeof memory.start === 'number') {
    composerCaret = memory.start;
    composerCaretEnd = typeof memory.end === 'number' ? memory.end : memory.start;
    restoreCaret(node);
  }
}

function rememberPainted(kind: Composer) {
  paintedMessageIds = state.messages.map((m) => m.id);
  paintedComposer = kind;
  paintedInfo = state.banner && state.banner.kind === 'info' ? state.banner.text : '';
  paintedThinking = state.round.status === 'thinking';
  paintedBanner = state.banner && state.banner.kind === 'error' ? state.banner.text : '';
}

function stripTagged(html: string, id: string): string {
  const needle = 'id="' + id + '"';
  const at = html.indexOf(needle);
  if (at < 0) return html;
  const open = html.lastIndexOf('<', at);
  const tagMatch = /^<([a-zA-Z0-9]+)/.exec(html.slice(open));
  if (!tagMatch || open < 0) return html;
  const close = html.indexOf('</' + tagMatch[1] + '>', at);
  if (close < 0) return html;
  return html.slice(0, open) + html.slice(close + tagMatch[1].length + 3);
}

function syncThreadExtras(thread: HTMLElement) {
  const thinking = state.round.status === 'thinking';
  const banner = state.banner && state.banner.kind === 'error' ? state.banner.text : '';
  let html = thread.innerHTML;
  if (thinking !== paintedThinking || banner !== paintedBanner) {
    html = stripTagged(html, 'thinking-turn');
    html = stripTagged(html, 'banner-turn');
    if (thinking) html += thinkingTurnHtml();
    if (banner) html += bannerTurnHtml(banner);
    thread.innerHTML = html;
  }
  paintedThinking = thinking;
  paintedBanner = banner;
  thread.setAttribute('aria-busy', thinking ? 'true' : 'false');
}

function appendNewTurns(thread: HTMLElement) {
  let added = '';
  for (let i = 0; i < state.messages.length; i++) {
    const message = state.messages[i];
    if (paintedMessageIds.indexOf(message.id) !== -1) continue;
    added += turnHtml(message);
    paintedMessageIds.push(message.id);
  }
  if (added) thread.innerHTML += added;
}

function patchSession(kind: Composer, focus?: boolean): boolean {
  const presence = document.getElementById('presence');
  const sub = document.getElementById('hdr-sub');
  const round = document.getElementById('round');
  const thread = document.getElementById('thread');
  const composer = document.getElementById('composer');
  if (!presence || !sub || !round || !thread || !composer) return false;

  presence.innerHTML = presenceInner();
  sub.innerHTML = escapeHtml(subtitle());
  round.innerHTML = escapeHtml(roundLine());
  appendNewTurns(thread);
  syncThreadExtras(thread);

  const info = state.banner && state.banner.kind === 'info' ? state.banner.text : '';
  if (kind !== paintedComposer || info !== paintedInfo) {
    composer.innerHTML = footerInner(kind);
    paintedComposer = kind;
    paintedInfo = info;
    wireFooter(kind, !!focus);
  } else if (focus) {
    wireFooter(kind, true);
  }

  thread.scrollTop = thread.scrollHeight;
  return true;
}

function paintSessionScreen(kind: Composer, focus?: boolean) {
  const thinking = state.round.status === 'thinking';
  render(
    '<div class="screen">' +
    header(subtitle()) +
    presenceHtml() +
    '<p id="round" class="round muted tiny" aria-live="polite">' + escapeHtml(roundLine()) + '</p>' +
    '<main class="body" id="thread" role="log" aria-live="polite" aria-relevant="additions"' +
    (thinking ? ' aria-busy="true"' : '') + '>' +
    threadHtml() +
    '</main>' +
    footerHtml(kind) +
    '</div>'
  );
  rememberPainted(kind);
  if (state.minimized) return;
  const thread = document.getElementById('thread');
  if (thread) thread.scrollTop = thread.scrollHeight;
  wireFooter(kind, !!focus);
}

export function showSession(opts?: { focus?: boolean }) {
  captureComposer();
  const prevFocus = captureFocus();
  const kind = composerKind();
  const focus = !!(opts && opts.focus);
  const canPatch = state.mode === 'session' && !state.minimized && sessionDomReady();

  setMode('session');
  // render() swallows paints while collapsed. Do not bookkeep that as a
  // finished paint: the incremental path would then skip messages that
  // arrived while the duck was the only thing on screen.
  if (state.minimized) return;
  if (canPatch && patchSession(kind, focus)) {
    if (!focus) restoreFocus(prevFocus);
    return;
  }

  paintedMessageIds = [];
  paintedComposer = null;
  paintedInfo = '';
  paintedThinking = false;
  paintedBanner = '';
  paintSessionScreen(kind, focus);
  if (!focus) restoreFocus(prevFocus);
}
