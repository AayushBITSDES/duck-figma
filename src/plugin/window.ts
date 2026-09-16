/*
 * Sandbox-side state and persistence for the collapsible duck window: the
 * full panel ("open") and the 70x70 collapsed duck ("minimized"). The UI
 * side owns the drag grip and the duck art; this module owns the geometry,
 * where it lives in clientStorage, and applying it via figma.ui.resize.
 *
 * MESSAGE CONTRACT between src/ui and src/plugin (the pluginMessage /
 * figma.ui.postMessage envelope, same as every other message in this repo):
 *
 * UI -> plugin
 *   {type: 'resize', width, height}
 *     Sent on every pointermove while the user drags the open panel's
 *     resize grip. Only sent while open; the minimized duck has no grip,
 *     its size is fixed. The plugin clamps, applies immediately, and
 *     persists on a debounce.
 *   {type: 'minimize'}
 *     Collapse to the 70x70 duck.
 *   {type: 'expand'}
 *     Restore the last open size.
 *   {type: 'text-size', size}
 *     Set the panel's font size. Clamped to 9..18. Rides with the geometry
 *     rather than with settings; see the STORE comment below.
 *   {type: 'mode', mode}
 *     Sent whenever the UI's own state.mode changes (src/ui/state.ts's Mode
 *     type: 'idle' | 'settings' | 'checkin' | 'chat'). This is the only way
 *     the plugin finds out whether the UI is actually resting: bridge.ts
 *     shows the check-in screen only while its mode is 'idle', and idle.ts
 *     fires expandForCheckIn purely off its own inactivity timer, with no
 *     idea what the UI is showing. Posted by setMode() in src/ui/screens.ts,
 *     which every screen routes through so a new one cannot forget to report
 *     itself. None arrives until the UI's first render, so until then the
 *     plugin assumes it is not idle and never expands on a guess.
 *
 * plugin -> UI
 *   {type: 'window', width, height, minimized, textSize}
 *     The geometry now in effect. width/height are always the OPEN panel's
 *     size, even while minimized (the collapsed duck is always exactly
 *     70x70, so there is nothing useful to report there beyond the flag).
 *     Sent once at startup once clientStorage has been read, and again
 *     after every resize/minimize/expand, so the UI can tell which layout
 *     to render and never has to guess at what figma.ui.resize actually
 *     applied (clamping included).
 *
 * Nothing here rides on 'settings' or duckSettings; see the STORE comment
 * below for why.
 */

const MINIMIZED_SIZE = 70; // figma.showUI's own hard floor for width; reused as the collapsed duck's fixed size.
const MIN_OPEN_WIDTH = 240;
const MIN_OPEN_HEIGHT = 320;
// Both the resize grip (right:0; bottom:0) and the minimize button (top:6;
// right:6) are anchored to the iframe's own right edge, so a panel wider or
// taller than the screen can push both off screen with no way back short of
// clearing clientStorage by hand. 1280x800 is about as small as a laptop
// display gets in practice; capping comfortably under that keeps both
// controls reachable everywhere, with room left over for Figma's own chrome.
const MAX_OPEN_WIDTH = 800;
const MAX_OPEN_HEIGHT = 720;
const DEFAULT_WIDTH = 280;
const DEFAULT_HEIGHT = 380;
const PERSIST_DEBOUNCE_MS = 400;
const DEFAULT_TEXT_SIZE = 11;
const MIN_TEXT_SIZE = 9;
const MAX_TEXT_SIZE = 18;

// Its own clientStorage key, deliberately not folded into duckSettings.
// settings-store.ts just went through a long run of fixes (see git log) to
// make a settings save replace the whole object outright, specifically so
// two saves can never race or clobber each other. Geometry saves happen on
// every resize-drag tick, far more often than a settings save; sharing one
// object with settings would reintroduce that exact race for an unrelated
// reason. A separate key means the two can never interact at all.
const STORE = 'duckWindow';

interface WindowGeometry {
  width: number;
  height: number;
  minimized: boolean;
  // Text size lives here rather than in duckSettings for the same reason the
  // rest of this does: it is a display preference the user nudges repeatedly,
  // not a behaviour setting, and duckSettings saves must stay whole-object.
  textSize: number;
}

// The open size to keep in memory (so expand doesn't need another
// clientStorage round trip) and the size to reopen at on restore, clamped so
// a corrupt or absurd stored value can never produce a panel too small to
// use, or (MAX_OPEN_WIDTH/HEIGHT above) too large for its own controls to
// stay on screen. Defaults match figma.showUI's own call in code.ts, so a
// user with nothing saved yet sees no change.
let openWidth = DEFAULT_WIDTH;
let openHeight = DEFAULT_HEIGHT;
let minimized = false;
let textSize = DEFAULT_TEXT_SIZE;

// Last mode the UI reported via {type: 'mode'} (see the MESSAGE CONTRACT
// above). Starts false: until the UI has told us otherwise, expandForCheckIn
// must assume it is not idle, so it never expands the window on a guess.
let uiIsIdle = false;

// figma.ui.onmessage is live from code.ts's first tick, but initWindow's
// clientStorage read only lands a few ticks later. Anything the user does in
// that gap is newer than the stored snapshot, and the handler that did it has
// already persisted its own result, so the snapshot has to be dropped rather
// than applied over the top of it.
let userActed = false;

let persistTimer: ReturnType<typeof setTimeout> | undefined;

function clampOpen(width: number, height: number): { width: number; height: number } {
  const w = Number.isFinite(width) ? width : DEFAULT_WIDTH;
  const h = Number.isFinite(height) ? height : DEFAULT_HEIGHT;
  return {
    width: Math.min(MAX_OPEN_WIDTH, Math.max(MIN_OPEN_WIDTH, Math.round(w))),
    height: Math.min(MAX_OPEN_HEIGHT, Math.max(MIN_OPEN_HEIGHT, Math.round(h))),
  };
}

function clampText(px: number): number {
  return Math.min(MAX_TEXT_SIZE, Math.max(MIN_TEXT_SIZE, Math.round(px)));
}

function applyCurrentSize() {
  if (minimized) {
    figma.ui.resize(MINIMIZED_SIZE, MINIMIZED_SIZE);
  } else {
    figma.ui.resize(openWidth, openHeight);
  }
}

function postWindow() {
  figma.ui.postMessage({ type: 'window', width: openWidth, height: openHeight, minimized, textSize });
}

function persistNow() {
  if (persistTimer !== undefined) {
    clearTimeout(persistTimer);
    persistTimer = undefined;
  }
  const geometry: WindowGeometry = { width: openWidth, height: openHeight, minimized, textSize };
  figma.clientStorage.setAsync(STORE, geometry).catch(() => {
    // Losing a geometry write is harmless: worst case the window opens at
    // its last-known-good size next time instead of this one.
  });
}

// A drag fires resize continuously, so only the write is debounced; the
// figma.ui.resize call that actually moves the panel happens synchronously
// every time, in handleResize below.
function schedulePersist() {
  if (persistTimer !== undefined) clearTimeout(persistTimer);
  persistTimer = setTimeout(persistNow, PERSIST_DEBOUNCE_MS);
}

// Called once at startup, alongside loadSettings(). figma.showUI has
// already opened at the hardcoded default in code.ts; once storage has been
// read this resizes to whatever the user actually left it at.
export function initWindow(): Promise<void> {
  return figma.clientStorage
    .getAsync(STORE)
    .then((stored: WindowGeometry | undefined) => {
      // The user got in first. Their action is newer than this snapshot and is
      // already both on screen and in storage; applying the snapshot now would
      // silently undo it.
      if (userActed) return;
      if (stored) {
        const clamped = clampOpen(stored.width, stored.height);
        openWidth = clamped.width;
        openHeight = clamped.height;
        minimized = !!stored.minimized;
        if (Number.isFinite(stored.textSize)) textSize = clampText(stored.textSize);
      }
      applyCurrentSize();
      postWindow();
    })
    .catch(() => {
      // Fall through on whatever figma.showUI already applied; nothing to undo.
    });
}

export function handleResize(width: number, height: number) {
  // The minimized duck has no resize grip, so this should only ever arrive
  // while open. Guard anyway rather than trust the sender's claimed state: a
  // message handler shouldn't assume it, and a lost pointerup leaving a drag
  // stuck active is a plausible way for this to fire while minimized, which
  // would otherwise stretch the collapsed 70x70 markup across a full window.
  if (minimized) return;
  userActed = true;
  const clamped = clampOpen(width, height);
  openWidth = clamped.width;
  openHeight = clamped.height;
  figma.ui.resize(openWidth, openHeight);
  postWindow();
  schedulePersist();
}

export function handleMinimize() {
  userActed = true;
  minimized = true;
  figma.ui.resize(MINIMIZED_SIZE, MINIMIZED_SIZE);
  postWindow();
  // Minimize/expand are discrete clicks, not a drag burst: nothing to
  // coalesce, so write right away instead of waiting out the resize debounce.
  persistNow();
}

export function handleExpand() {
  userActed = true;
  minimized = false;
  figma.ui.resize(openWidth, openHeight);
  postWindow();
  persistNow();
}

// Nudged from the settings screen. The UI applies the size itself the moment
// the message comes back, so there is nothing to apply here beyond storing it.
export function handleTextSize(px: number) {
  userActed = true;
  textSize = clampText(Number.isFinite(px) ? px : DEFAULT_TEXT_SIZE);
  postWindow();
  persistNow();
}

// Called from code.ts when a {type: 'mode'} message arrives; see the
// MESSAGE CONTRACT above.
export function handleUiMode(mode: string) {
  uiIsIdle = mode === 'idle';
}

// Called from idle.ts when a check-in fires while the duck is collapsed, so
// the user actually sees it asking instead of the question landing on a
// panel nobody can see. A no-op while already open: the duck must never
// interrupt or resize a conversation someone has on screen (see idle.ts's
// own comments about not stomping an in-flight screen).
//
// Also a no-op unless the UI has told us it is actually idle. idle.ts fires
// this off its own inactivity timer with no idea what screen the UI is on;
// popping the window open only for bridge.ts to ignore the question because
// its mode wasn't 'idle' is exactly the bug this guards against.
export function expandForCheckIn() {
  if (!minimized || !uiIsIdle) return;
  handleExpand();
}
