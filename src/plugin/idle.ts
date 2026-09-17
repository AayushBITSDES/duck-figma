import { getBoardItems } from './board';
import { expandForCheckIn } from './window';

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
//
// Only the current user's edits, though. documentchange fires for REMOTE
// changes too, meaning every keystroke by anyone else in the file, and
// resetActivity does not care who caused it. On a board with one active
// collaborator that is enough to hold the timer open forever: you stop, they
// keep working, your timer keeps resetting, the duck never checks in. Their
// presence is also not information about you, which is the whole thing this
// module is trying to measure. presence() already reads activeUsers[0], which
// is this user alone, so that path was never affected.
export function startIdleWatch() {
  figma.on('documentchange', (e: DocumentChangeEvent) => {
    for (let i = 0; i < e.documentChanges.length; i++) {
      if (e.documentChanges[i].origin === 'LOCAL') {
        resetActivity();
        return;
      }
    }
  });
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
      // A question posted to a collapsed duck lands on a 70x70 window nobody
      // can read, so open up first. This module only knows the user has gone
      // quiet, not what screen the UI is showing; expandForCheckIn is the one
      // that knows, and is a no-op both when the panel is already open (so
      // this can never resize a conversation out from under someone) and
      // when the UI hasn't reported itself idle (so this can never pop the
      // window open to ask a question nobody is going to see).
      expandForCheckIn();
      figma.ui.postMessage({ type: 'checkin', board: getBoardItems() });
    }
  }, TICK_MS);
}
