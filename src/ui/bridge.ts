import { state } from './state';
import { PROVIDERS, ProviderId } from './providers';
import { idleDuck, showCheckIn, openSettings } from './screens';

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
  if (msg.type === 'settings') {
    const settings = msg.settings || {};
    if (PROVIDERS[settings.provider as ProviderId]) state.provider = settings.provider;
    state.storedKey = settings.key || '';
    state.settingsLoaded = true;
    if (state.mode === 'settings') openSettings();
  }
};
