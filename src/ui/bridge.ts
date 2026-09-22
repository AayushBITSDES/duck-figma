import { connectSession } from './session';
import { paintSession, repaint, showCollapsed } from './screens';
import { state } from './state';

// One CSS variable drives the whole panel: every control already inherits its
// font, so nothing else has to know the size changed.
export function applyTextSize(px: number) {
  state.textSize = Math.min(18, Math.max(9, Math.round(px)));
  document.documentElement.style.setProperty('--duck-font', state.textSize + 'px');
}

export function post(msg: any) {
  parent.postMessage({ pluginMessage: msg }, '*');
}

// Asks code.ts for a board snapshot and waits for it, so a contribution
// never quotes a board that has moved on. Resolves anyway if the reply never
// lands. The plugin reuses a recent same-page snapshot; this side always
// asks, so a page switch or edit cannot send stale text.
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
  if (msg.type === 'session') {
    connectSession(msg.roomId || '', msg.clientId || '', msg.displayName || '');
    requestBoard();
  }
  if (msg.type === 'board-context') {
    state.boardItems = Array.isArray(msg.board) ? msg.board : [];
    const waiters = boardWaiters;
    boardWaiters = [];
    waiters.forEach((w) => w());
  }
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
  if (msg.type === 'summary-updated') {
    setBanner('info', 'Summary updated on the board.');
  }
  if (msg.type === 'summary-error') {
    setBanner('error', msg.message || 'Could not update the summary.');
  }
};

// There is one banner slot, and while a session is halted that slot carries
// the only Reconnect control there is (screens.ts, footerInner). A summary
// result replaces its text, never the way back to a connection: dropping the
// action leaves the panel claiming it is reconnecting when nothing is.
function setBanner(kind: 'error' | 'info', text: string) {
  const action = state.banner && state.banner.action;
  state.banner = action ? { kind, text, action } : { kind, text };
  paintSession();
}
