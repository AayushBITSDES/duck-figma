import { ChatMessage, Participant, SESSION_LIMITS } from '../shared/protocol';
import { post, applyTextSize } from './bridge';
import { duckSvg } from './duck';
import { escapeHtml, render, renderCollapsed, renderMarkdown } from './render';
import { actContribute, actPass, actRetry, actSetState, onPaint } from './session';
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
    '<span class="hdr-sub">' + escapeHtml(sub) + '</span>' +
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

function presenceHtml(): string {
  if (!state.participants.length) {
    return '<div id="presence" class="presence" role="list" aria-label="Connected">' +
      '<span class="muted tiny">No one else is here yet.</span></div>';
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
  return '<div id="presence" class="presence" role="list" aria-label="Connected">' + chips + '</div>';
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
    turns += '<div class="turn">' + duckSvg(16) + '<div class="bubble them muted">thinking...</div></div>';
  }
  if (state.banner && state.banner.kind === 'error') {
    turns += '<div class="turn"><div class="bubble err">' + escapeHtml(state.banner.text) + '</div></div>';
  }
  return turns;
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

function footerHtml(kind: Composer): string {
  const summaryText = lastFacilitatorText();
  const summaryDisabled = summaryText ? '' : ' disabled';
  const summary =
    '<button type="button" id="summary" class="ghost"' + summaryDisabled + '>Update summary</button>';
  const settings = '<button type="button" id="settings" class="ghost">Settings</button>';
  const locked = state.busy ? ' disabled' : '';
  if (kind === 'moods') {
    return moodButtons() + summary + settings;
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
      summary + settings
    );
  }
  if (kind === 'failed') {
    return (
      '<button type="button" id="retry" class="primary">Retry</button>' +
      summary + settings
    );
  }
  if (kind === 'waiting' || kind === 'thinking') {
    return summary + settings;
  }
  return '<p class="muted tiny">Reconnecting...</p>' + summary + settings;
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
      state.draft = '';
      composerFocus = false;
      ta.value = '';
      actContribute(val);
    };
  }
  const pass = document.getElementById('pass');
  if (pass) pass.onclick = () => actPass();
  const retry = document.getElementById('retry');
  if (retry) retry.onclick = () => actRetry();
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

export function showSession(opts?: { focus?: boolean }) {
  captureComposer();
  setMode('session');
  const kind = composerKind();
  const thinking = state.round.status === 'thinking';
  const info = state.banner && state.banner.kind === 'info' ? state.banner.text : '';
  render(
    '<div class="screen">' +
    header(subtitle()) +
    presenceHtml() +
    '<p id="round" class="round muted tiny" aria-live="polite">' + escapeHtml(roundLine()) + '</p>' +
    '<main class="body" id="thread" role="log" aria-live="polite" aria-relevant="additions"' +
    (thinking ? ' aria-busy="true"' : '') + '>' +
    threadHtml() +
    '</main>' +
    '<footer class="ftr">' +
    footerHtml(kind) +
    (info ? '<p class="muted tiny">' + escapeHtml(info) + '</p>' : '') +
    '</footer></div>'
  );
  if (state.minimized) return;
  const thread = document.getElementById('thread');
  if (thread) thread.scrollTop = thread.scrollHeight;
  wireFooter(kind, !!(opts && opts.focus));
}

export function showCheckIn() {
  // Kept as a no-op name so older call sites cannot crash mid-merge; the
  // group session has no idle check-in.
  showConnecting();
}

export function idleDuck() {
  showConnecting();
}
