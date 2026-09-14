import { getBoardItems } from './board';

export const IDLE_THRESHOLD_MS = 20 * 1000;
export const TICK_MS = 2 * 1000;

let lastActivity = Date.now();
let checkInActive = false;
let lastPresence = '';

// figma.activeUsers is FigJam-only and activeUsers[0] is the current user. Its
// cursor position covers hovering, and its viewport rect covers panning and
// zooming. There is no mouse event to subscribe to, so this gets polled.
// Returns '' if the permission is missing, which degrades to edits-only.
function presence(): string {
  try {
    const me = figma.activeUsers[0];
    if (!me) return '';
    const p = me.position;
    const v = me.viewport;
    return [
      p ? Math.round(p.x) : 'off',
      p ? Math.round(p.y) : 'off',
      Math.round(v.x),
      Math.round(v.y),
      Math.round(v.width),
      Math.round(v.height),
    ].join(',');
  } catch (e) {
    return '';
  }
}

function resetActivity() {
  lastActivity = Date.now();
  if (checkInActive) {
    checkInActive = false;
    figma.ui.postMessage({ type: 'resume' });
  }
}

export function dismissCheckIn() {
  checkInActive = false;
  lastActivity = Date.now();
}

// Any edit counts, not just creating something. Typing into a sticky that
// already exists is working, and the duck used to talk over it.
export function startIdleWatch() {
  figma.on('documentchange', resetActivity);
  lastPresence = presence();
  setInterval(() => {
    const now = presence();
    if (now !== lastPresence) {
      lastPresence = now;
      resetActivity();
      return;
    }
    if (Date.now() - lastActivity > IDLE_THRESHOLD_MS && !checkInActive) {
      checkInActive = true;
      figma.ui.postMessage({ type: 'checkin', board: getBoardItems() });
    }
  }, TICK_MS);
}
