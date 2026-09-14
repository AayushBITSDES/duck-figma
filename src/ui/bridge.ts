import { state } from './state';
import { PROVIDERS, ProviderId } from './providers';
import { idleDuck, showCheckIn, openSettings, showCollapsed, repaint } from './screens';

// One CSS variable drives the whole panel: every control already inherits its
// font, so nothing else has to know the size changed.
export function applyTextSize(px: number) {
  state.textSize = Math.min(18, Math.max(9, Math.round(px)));
  document.documentElement.style.setProperty('--duck-font', state.textSize + 'px');
}

export function post(msg: any) {
  parent.postMessage({ pluginMessage: msg }, '*');
}

// Asks code.ts for a fresh board snapshot and waits for it, so a reply never
// quotes a board that has moved on. Resolves anyway if the reply never lands.
let boardWaiters: Array<() => void> = [];
export function requestBoard(): Promise<void> {
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

window.onmessage = (event) => {
  const msg = event.data.pluginMessage;
  if (!msg) return;
  if (msg.type === 'checkin') {
    state.boardItems = Array.isArray(msg.board) ? msg.board : [];
    state.boardReadAt = Date.now();
    // Only interrupt the resting duck: never wipe a chat or a half-typed key.
    if (state.mode === 'idle') showCheckIn();
  }
  if (msg.type === 'board-context') {
    state.boardItems = Array.isArray(msg.board) ? msg.board : [];
    state.boardReadAt = Date.now();
    const waiters = boardWaiters;
    boardWaiters = [];
    waiters.forEach((w) => w());
  }
  // Back to work: stand down only if the duck is still just asking.
  if (msg.type === 'resume' && state.mode === 'checkin') idleDuck();
  // The plugin owns window state, since it is the only side that can call
  // figma.ui.resize. We follow what it reports rather than tracking our own,
  // so a clamp applied over there can never leave the two disagreeing.
  if (msg.type === 'window') {
    const was = state.minimized;
    state.minimized = !!msg.minimized;
    // #grip lives outside #root so it survives every screen repaint, which
    // means no selector built on #root's own content can ever hide it (see
    // ui.html). This class is the only thing standing between the collapsed
    // 70x70 duck and a dead resize handle drawn on top of it.
    document.body.classList.toggle('min', state.minimized);
    if (typeof msg.textSize === 'number') applyTextSize(msg.textSize);
    if (state.minimized && !was) showCollapsed();
    else if (!state.minimized && was) repaint();
  }
  if (msg.type === 'settings') {
    const settings = msg.settings || {};
    if (PROVIDERS[settings.provider as ProviderId]) state.provider = settings.provider;
    state.storedKey = settings.key || '';
    state.settingsLoaded = true;
    if (state.mode === 'settings') openSettings();
  }
};
