figma.showUI(__html__, { width: 280, height: 380, themeColors: true });

const IDLE_THRESHOLD_MS = 3 * 60 * 1000;
const CHECK_INTERVAL_MS = 15 * 1000;
const MAX_BOARD_ITEMS = 40;
const MAX_ITEM_LENGTH = 200;

let lastCreateTime = Date.now();
let checkInActive = false;

function getBoardSummary(): string {
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
  return items.length ? items.join(' | ') : '';
}

function resetActivity() {
  lastCreateTime = Date.now();
  if (checkInActive) {
    checkInActive = false;
    figma.ui.postMessage({ type: 'resume' });
  }
}

figma.on('documentchange', (event) => {
  const madeSomething = event.documentChanges.some((c) => c.type === 'CREATE');
  if (madeSomething) resetActivity();
});

setInterval(() => {
  const idleFor = Date.now() - lastCreateTime;
  if (idleFor > IDLE_THRESHOLD_MS && !checkInActive) {
    checkInActive = true;
    figma.ui.postMessage({ type: 'checkin', board: getBoardSummary() });
  }
}, CHECK_INTERVAL_MS);

figma.clientStorage.getAsync('anthropicApiKey').then((key) => {
  figma.ui.postMessage({ type: 'api-key', key: key || null });
});

figma.ui.onmessage = (msg) => {
  if (msg.type === 'dismiss') {
    checkInActive = false;
    lastCreateTime = Date.now();
  }

  if (msg.type === 'get-board') {
    figma.ui.postMessage({ type: 'board-context', board: getBoardSummary() });
  }

  if (msg.type === 'drop-sticky') {
    const sticky = figma.createSticky();
    sticky.text.characters = msg.text || 'What are you stuck on?';
    figma.currentPage.appendChild(sticky);
    figma.viewport.scrollAndZoomIntoView([sticky]);
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
