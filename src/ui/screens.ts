import { ChatMessage, Participant, SESSION_LIMITS } from '../shared/protocol';
import { post, applyTextSize } from './bridge';
import { duckHeadSvg } from './duck';
import { escapeHtml, render, renderCollapsed, renderMarkdown, tpl } from './render';
import { actContribute, actPass, actRetry, actSetState, onPaint, reconnectSession } from './session';
import { iHaveActed, lastFacilitatorText, moodLabel, MOODS, Mode, state } from './state';

// The plugin has no window into which screen is up. Every screen goes through
// here rather than assigning state.mode directly, so a new screen cannot
// forget to report itself.
function setMode(mode: Mode) {
  state.mode = mode;
  post({ type: 'mode', mode: mode });
}

function roundLabel(): string {
  return 'Round ' + state.round.id;
}

// The round number recedes, what the round wants from you does not. The
// plugin's own name is not news to someone already looking at the panel, and
// at 280px it was spending the width that the demand now uses.
function sessionHeader(): string {
  return tpl('t-session-header', {
    lead: roundLabel(),
    sub: subtitle(),
    min: minimizeButton(),
    menu: tpl('t-btn-menu'),
    rail: presenceHtml(),
  });
}

function textSizeOptions() {
  let out = '';
  for (let px = 9; px <= 18; px++) {
    out += tpl('t-size-option', { px: px, selected: px === state.textSize ? 'selected' : '' });
  }
  return out;
}

// Wired by delegation in ui.ts, so it works from whichever header draws it.
function minimizeButton() {
  return tpl('t-btn-min');
}

// The round is waiting on this user specifically: everyone else can be
// pending without it being your move, so this is the only condition worth
// spending the collapsed tile's one signal on.
function needsYou(): boolean {
  return state.ws === 'live' && state.round.status === 'collecting' && !iHaveActed();
}

export function showCollapsed() {
  const turn = needsYou();
  renderCollapsed(tpl('t-collapsed', {
    turn: turn ? 'turn' : '',
    label: turn ? 'Your turn. Open the duck' : 'Open the duck',
    duck: duckHeadSvg(44),
  }));
}

export function repaint() {
  if (state.mode === 'settings') return showSettings();
  if (state.gotSnapshot) return showSession({ focus: true });
  return showConnecting();
}

export function paintSession() {
  if (state.mode === 'settings') return;
  // render() swallows paints while collapsed, so the tile would keep whatever
  // it was drawn with when the panel closed. It now carries a signal that
  // changes with the round, which makes it the one screen that has to repaint
  // while minimized.
  if (state.minimized) return showCollapsed();
  if (state.gotSnapshot) showSession({ focus: state.mode === 'connecting' });
  else showConnecting();
}

onPaint(paintSession);

export function showConnecting() {
  setMode('connecting');
  const err = state.banner && state.banner.kind === 'error' ? state.banner.text : '';
  // A halt before the first snapshot is the common case, not the rare one:
  // room_full arrives in answer to the very first join. This screen has no
  // footer, so without its own copy of the control the user would be told
  // what went wrong and given no way to act on it.
  const halted = !!(state.banner && state.banner.action === 'reconnect');
  const line = halted
    ? 'Not connected.'
    : state.ws === 'reconnecting'
      ? 'Reconnecting to this board\'s session...'
      : 'Joining this board\'s session...';
  const lead = halted ? 'Not connected' : state.ws === 'reconnecting' ? 'Reconnecting' : 'Joining';
  // Halted means nothing is happening, so the rail stops running: a moving
  // bar over "Not connected" would be the panel contradicting itself.
  render(tpl('t-connecting', {
    header: tpl('t-connecting-header', {
      lead: lead,
      min: minimizeButton(),
      menu: tpl('t-btn-menu'),
      rail: tpl(halted ? 't-rail-stopped' : 't-rail-loading'),
    }),
    line: line,
    detail: halted ? '' : tpl('t-connecting-detail'),
    error: err ? tpl('t-error', { text: err }) : '',
    action: halted ? tpl('t-btn-reconnect') : '',
  }));
  if (state.minimized) return;
  const reconnect = document.getElementById('reconnect');
  if (reconnect) reconnect.onclick = () => reconnectSession();
  const settings = document.getElementById('settings');
  if (settings) settings.onclick = openSettings;
}

export function openSettings() {
  showSettings();
}

export function showSettings() {
  setMode('settings');
  // Back lives in the header, the way Figma's own sub-panels do it, so the
  // screen needs no footer at all.
  render(tpl('t-settings', {
    header: tpl('t-settings-header', { min: minimizeButton() }),
    sizes: textSizeOptions(),
  }));
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

// Says what the round wants, not who is in it: the rail below already carries
// the roster, and the old subtitle spent the header printing a name that the
// round line printed again two rows down.
function subtitle(): string {
  if (state.ws === 'reconnecting') return 'reconnecting';
  if (state.ws !== 'live') return 'connecting';
  if (state.round.status === 'thinking') return 'thinking';
  if (state.round.status === 'failed') return 'retry';
  if (!iHaveActed()) return 'your turn';
  const pending = pendingOthers().length;
  return pending ? 'waiting on ' + pending : 'waiting';
}

function pendingOthers(): Participant[] {
  const out: Participant[] = [];
  for (let i = 0; i < state.participants.length; i++) {
    const p = state.participants[i];
    if (p.status === 'pending' && p.clientId !== state.clientId) out.push(p);
  }
  return out;
}

// One segment per person, colour carrying the whole vocabulary: brand for in,
// border for still out, secondary for passed. The room caps a session at
// eight, so the segments never get narrower than a few pixels. This replaces
// the chips, which spelled every status as a comma-spliced sentence and
// wrapped to three rows at five people. Which segment is yours lives in the
// label, not in an outline: alone in a session, an outlined segment drew one
// empty bordered bar that read as broken.
function presenceInner(): string {
  if (!state.participants.length) return tpl('t-rail-nobody');
  let segs = '';
  for (let i = 0; i < state.participants.length; i++) {
    const p = state.participants[i];
    const mine = p.clientId === state.clientId;
    const status =
      p.status === 'contributed' ? 'contributed' :
      p.status === 'passed' ? 'passed' : 'still to answer';
    const tone = p.status === 'contributed' ? 'in' : p.status === 'passed' ? 'passed' : '';
    const label = p.displayName + (mine ? ' (you)' : '') + ', ' + status;
    segs += tpl('t-seg', { tone: tone, label: label });
  }
  return segs;
}

function presenceHtml(): string {
  return tpl('t-rail', { segments: presenceInner() });
}

function blocker(text: string, meta?: string): string {
  return tpl('t-blocker', { text: text, meta: meta || '' });
}

// Only speaks when something is holding the round up. "Your turn" and
// "thinking" are already in the header, and saying them again here is what
// made the old round line read as filler.
function roundInner(): string {
  if (state.ws === 'reconnecting') return blocker('Reconnecting. Your messages stay until a fresh snapshot arrives.');
  if (state.round.status === 'failed') return blocker('The duck could not reply. Anyone can retry.');
  if (state.round.status === 'thinking' || !iHaveActed()) return '';
  const pending = pendingOthers();
  if (!pending.length) return '';
  let done = 0;
  for (let i = 0; i < state.participants.length; i++) {
    if (state.participants[i].status !== 'pending') done++;
  }
  return blocker(
    'Waiting on ' + pending.map((p) => p.displayName).join(', '),
    done + ' of ' + state.participants.length + ' in'
  );
}

function isMine(m: ChatMessage): boolean {
  return !!(state.clientId && m.author && m.author.clientId === state.clientId);
}

function turnHtml(m: ChatMessage): string {
  const mine = isMine(m);
  const name = (m.author && m.author.displayName) || 'Someone';
  const kind = m.kind;
  if (kind === 'facilitator') {
    return tpl('t-turn-duck', { name: name || 'Duck', text: renderMarkdown(m.text) });
  }
  // An event, not something anyone said: no bubble, and no name label above
  // a line that already starts with the name.
  if (kind === 'pass' || kind === 'system') {
    return tpl('t-turn-note', { text: kind === 'pass' ? (mine ? 'You' : name) + ' passed' : m.text });
  }
  let text = m.text;
  if (kind === 'state') {
    const mood = m.mood ? moodLabel(m.mood) : '';
    text = m.text || (name + (mood ? ' is ' + mood + '.' : ' checked in.'));
  }
  return mine ? tpl('t-turn-mine', { text: text }) : tpl('t-turn-them', { name: name, text: text });
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
  return tpl('t-turn-thinking');
}

function bannerTurnHtml(text: string): string {
  return tpl('t-turn-error', { text: text });
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
  const disabled = state.busy ? 'disabled' : '';
  return MOODS.map((m) =>
    tpl('t-mood', { id: m.buttonId, mood: m.id, label: m.label, disabled: disabled })
  ).join('');
}

function capLocked(): boolean {
  return !!(state.banner && (state.banner.code === 'session_cap' || state.banner.code === 'rate_limited'));
}

// One template per state of the turn, all sharing the summary link and the
// info line. Which one shows is the only decision made here.
function footerInner(kind: Composer): string {
  const info = state.banner && state.banner.kind === 'info' ? state.banner.text : '';
  const shared = {
    summary: tpl('t-btn-summary', { disabled: lastFacilitatorText() ? '' : 'disabled' }),
    info: info ? tpl('t-info', { text: info }) : '',
  };
  if (kind === 'moods') return tpl('t-footer-moods', { ...shared, moods: moodButtons() });
  if (kind === 'contribute') {
    return tpl('t-footer-contribute', {
      ...shared,
      max: SESSION_LIMITS.maxTextLength,
      draft: state.draft,
      disabled: state.busy ? 'disabled' : '',
    });
  }
  if (kind === 'failed') return tpl('t-footer-failed', { ...shared, retry: capLocked() ? '' : tpl('t-btn-retry') });
  if (kind === 'waiting' || kind === 'thinking') return tpl('t-footer-waiting', shared);
  // 'offline' covers both "the socket dropped and we are on it" and "we have
  // stopped trying and only the user can decide what happens next".
  if (state.banner && state.banner.action === 'reconnect') {
    return tpl('t-footer-halted', { ...shared, reconnect: tpl('t-btn-reconnect') });
  }
  return tpl('t-footer-reconnecting', shared);
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
let paintedBusy = false;

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
  paintedBusy = state.busy;
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
  // The round number moves on without the composer changing kind, so it has
  // to be patched here or the header keeps naming a round that is over.
  const title = document.getElementById('hdr-title');
  if (title) title.innerHTML = escapeHtml(roundLabel());
  sub.innerHTML = escapeHtml(subtitle());
  round.innerHTML = roundInner();
  appendNewTurns(thread);
  syncThreadExtras(thread);

  const info = state.banner && state.banner.kind === 'info' ? state.banner.text : '';
  // busy is in here because footerInner spells the disabled state into the
  // markup: without it an action that leaves the composer on the same kind
  // (every board wait) paints nothing, and a second click in that gap is
  // dropped by withBoard with no sign it ever landed.
  if (kind !== paintedComposer || info !== paintedInfo || state.busy !== paintedBusy) {
    composer.innerHTML = footerInner(kind);
    paintedComposer = kind;
    paintedInfo = info;
    paintedBusy = state.busy;
    wireFooter(kind, !!focus);
  } else if (focus) {
    wireFooter(kind, true);
  }

  thread.scrollTop = thread.scrollHeight;
  return true;
}

function paintSessionScreen(kind: Composer, focus?: boolean) {
  const thinking = state.round.status === 'thinking';
  render(tpl('t-session', {
    header: sessionHeader(),
    round: roundInner(),
    busy: thinking ? 'true' : 'false',
    thread: threadHtml(),
    composer: footerInner(kind),
  }));
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
  paintedBusy = false;
  paintSessionScreen(kind, focus);
  if (!focus) restoreFocus(prevFocus);
}
