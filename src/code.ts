figma.showUI(__html__, { width: 280, height: 380, themeColors: true });

const IDLE_THRESHOLD_MS = 3 * 60 * 1000;
const CHECK_INTERVAL_MS = 15 * 1000;
const MAX_BOARD_ITEMS = 40;
const MAX_ITEM_LENGTH = 200;

let lastCreateTime = Date.now();
let checkInActive = false;

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

function resetActivity() {
  lastCreateTime = Date.now();
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

figma.on('documentchange', (event) => {
  const madeSomething = event.documentChanges.some((c) => c.type === 'CREATE');
  if (madeSomething) resetActivity();
});

setInterval(() => {
  const idleFor = Date.now() - lastCreateTime;
  if (idleFor > IDLE_THRESHOLD_MS && !checkInActive) {
    checkInActive = true;
    figma.ui.postMessage({ type: 'checkin', board: getBoardItems() });
  }
}, CHECK_INTERVAL_MS);

figma.clientStorage.getAsync('anthropicApiKey').then((key) => {
  figma.ui.postMessage({ type: 'api-key', key: key || null });
});

// Give the UI a board snapshot up front so the first reply is never board-blind.
sendBoard();

figma.ui.onmessage = (msg) => {
  if (msg.type === 'dismiss') {
    checkInActive = false;
    lastCreateTime = Date.now();
  }

  if (msg.type === 'get-board') {
    sendBoard();
  }

  if (msg.type === 'drop-sticky') {
    dropSticky(msg.text || 'What are you stuck on?');
  }

  if (msg.type === 'save-key') {
    figma.clientStorage.setAsync('anthropicApiKey', msg.key).then(() => {
      figma.ui.postMessage({ type: 'api-key', key: msg.key });
    });
  }

  if (msg.type === 'clear-key') {
    figma.clientStorage.deleteAsync('anthropicApiKey').then(() => {
      figma.ui.postMessage({ type: 'api-key', key: null });
    });
  }
};
