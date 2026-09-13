figma.showUI(__html__, { width: 280, height: 380, themeColors: true });

const IDLE_THRESHOLD_MS = 20 * 1000;
const TICK_MS = 2 * 1000;
const MAX_BOARD_ITEMS = 40;
const MAX_ITEM_LENGTH = 200;
const STORE = 'duckSettings';
// Key names earlier builds used, before settings moved into one object. Each
// names a provider the plugin still supports, so they are migrated rather than
// dropped, and only deleted once the new settings have actually been written.
const LEGACY_KEYS: [string, string][] = [
  ['openrouterApiKey', 'openrouter'],
  ['openaiApiKey', 'openai'],
  ['anthropicApiKey', 'anthropic'],
];

let lastActivity = Date.now();
let checkInActive = false;
let lastPresence = '';

function getBoardItems(): string[] {
  const items: string[] = [];
  const nodes = figma.currentPage.findAll((n) => {
    return (
      n.type === 'STICKY' ||
      n.type === 'TEXT' ||
      n.type === 'SHAPE_WITH_TEXT' ||
      n.type === 'CODE_BLOCK' ||
      n.type === 'SECTION'
    );
  });
  for (const n of nodes) {
    let text = '';
    if (n.type === 'STICKY') text = (n as StickyNode).text.characters;
    else if (n.type === 'TEXT') text = (n as TextNode).characters;
    else if (n.type === 'SHAPE_WITH_TEXT') text = (n as ShapeWithTextNode).text.characters;
    else if (n.type === 'CODE_BLOCK') text = (n as CodeBlockNode).code;
    else if (n.type === 'SECTION') text = (n as SectionNode).name;
    text = (text || '').trim();
    if (text) items.push(text.slice(0, MAX_ITEM_LENGTH));
    if (items.length >= MAX_BOARD_ITEMS) break;
  }
  return items;
}

function sendBoard() {
  figma.ui.postMessage({ type: 'board-context', board: getBoardItems() });
}

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

// Setting characters on a sticky throws unless its font is loaded first, so this
// has to be async. Without the load the drop button silently did nothing.
async function dropSticky(text: string) {
  const sticky = figma.createSticky();
  try {
    await figma.loadFontAsync(sticky.text.fontName as FontName);
    sticky.text.characters = text;
  } catch (e) {
    sticky.remove();
    figma.notify("Couldn't write that sticky: the font wouldn't load.");
    return;
  }
  // Drop it where the user is looking instead of at the page origin.
  sticky.x = Math.round(figma.viewport.center.x - sticky.width / 2);
  sticky.y = Math.round(figma.viewport.center.y - sticky.height / 2);
  figma.currentPage.selection = [sticky];
  figma.notify('Dropped the note on your board.');
}

// Any edit counts, not just creating something. Typing into a sticky that
// already exists is working, and the duck used to talk over it.
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

async function loadSettings() {
  const settings = { provider: 'openrouter', key: '' };
  try {
    const stored = (await figma.clientStorage.getAsync(STORE)) || {};
    if (stored.provider) settings.provider = stored.provider;
    // `keys` is the per-provider shape an earlier build on this branch used.
    settings.key = stored.key || (stored.keys && stored.keys[settings.provider]) || '';
    if (!settings.key) {
      for (const entry of LEGACY_KEYS) {
        const legacy = await figma.clientStorage.getAsync(entry[0]);
        if (typeof legacy === 'string' && legacy.trim()) {
          settings.provider = entry[1];
          settings.key = legacy.trim();
          break;
        }
      }
      if (settings.key) {
        await figma.clientStorage.setAsync(STORE, settings);
        // Migrated, so don't leave the old secrets lying around. Re-running
        // this is harmless, so failing here costs nothing.
        for (const entry of LEGACY_KEYS) await figma.clientStorage.deleteAsync(entry[0]);
      }
    }
  } catch (e) {
    // Fall through with the defaults; the UI just shows an empty key field.
  }
  figma.ui.postMessage({ type: 'settings', settings });
}


loadSettings();

// Give the UI a board snapshot up front so the first reply is never board-blind.
sendBoard();

figma.ui.onmessage = (msg) => {
  if (msg.type === 'dismiss') {
    checkInActive = false;
    lastActivity = Date.now();
  }

  if (msg.type === 'get-board') {
    sendBoard();
  }

  if (msg.type === 'drop-sticky') {
    dropSticky(msg.text || 'What are you stuck on?');
  }

  // A save carries the whole of the settings, so there is nothing to merge onto
  // and nothing for two saves to race over.
  if (msg.type === 'save-settings') {
    figma.clientStorage
      .setAsync(STORE, { provider: msg.provider, key: msg.key || '' })
      .catch(() => figma.notify("Couldn't save your settings."));
  }
};
