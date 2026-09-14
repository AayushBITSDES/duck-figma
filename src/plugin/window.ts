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
// clientStorage round trip) and the size to reopen at on restore, clamped
// so a corrupt or absurd stored value can never produce a panel too small
// to use. Defaults match figma.showUI's own call in code.ts, so a user with
// nothing saved yet sees no change.
let openWidth = DEFAULT_WIDTH;
let openHeight = DEFAULT_HEIGHT;
let minimized = false;
let textSize = DEFAULT_TEXT_SIZE;

let persistTimer: ReturnType<typeof setTimeout> | undefined;

function clampOpen(width: number, height: number): { width: number; height: number } {
  const w = Number.isFinite(width) ? width : DEFAULT_WIDTH;
  const h = Number.isFinite(height) ? height : DEFAULT_HEIGHT;
  return {
    width: Math.max(MIN_OPEN_WIDTH, Math.round(w)),
    height: Math.max(MIN_OPEN_HEIGHT, Math.round(h)),
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
  const clamped = clampOpen(width, height);
  openWidth = clamped.width;
  openHeight = clamped.height;
  figma.ui.resize(openWidth, openHeight);
  postWindow();
  schedulePersist();
}

export function handleMinimize() {
  minimized = true;
  figma.ui.resize(MINIMIZED_SIZE, MINIMIZED_SIZE);
  postWindow();
  // Minimize/expand are discrete clicks, not a drag burst: nothing to
  // coalesce, so write right away instead of waiting out the resize debounce.
  persistNow();
}

export function handleExpand() {
  minimized = false;
  figma.ui.resize(openWidth, openHeight);
  postWindow();
  persistNow();
}

// Nudged from the settings screen. The UI applies the size itself the moment
// the message comes back, so there is nothing to apply here beyond storing it.
export function handleTextSize(px: number) {
  textSize = clampText(Number.isFinite(px) ? px : DEFAULT_TEXT_SIZE);
  postWindow();
  persistNow();
}

// Called from idle.ts when a check-in fires while the duck is collapsed, so
// the user actually sees it asking instead of the question landing on a
// panel nobody can see. A no-op while already open: the duck must never
// interrupt or resize a conversation someone has on screen (see idle.ts's
// own comments about not stomping an in-flight screen).
export function expandForCheckIn() {
  if (!minimized) return;
  handleExpand();
}
