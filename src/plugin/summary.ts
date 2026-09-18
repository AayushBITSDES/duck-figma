export const SUMMARY_ROLE_KEY = 'duckRole';
export const SUMMARY_ROLE = 'session-summary';
export const PAGE_SUMMARY_ID_KEY = 'duckSummaryNodeId';

function postUpdated(nodeId: string) {
  figma.ui.postMessage({ type: 'summary-updated', nodeId });
}

function postError(message: string) {
  figma.ui.postMessage({ type: 'summary-error', message });
  figma.notify(message);
}

async function loadStickyFonts(sticky: StickyNode): Promise<void> {
  const text = sticky.text;
  const len = text.characters.length;
  const fonts = len > 0 ? text.getRangeAllFontNames(0, len) : [];
  if (fonts.length > 0) {
    await Promise.all(fonts.map((font) => figma.loadFontAsync(font)));
    return;
  }
  const name = text.fontName;
  if (name === figma.mixed) {
    await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
    return;
  }
  await figma.loadFontAsync(name);
}

async function findSummarySticky(): Promise<StickyNode | null> {
  const storedId = figma.currentPage.getPluginData(PAGE_SUMMARY_ID_KEY);
  if (storedId) {
    const node = await figma.getNodeByIdAsync(storedId);
    if (node && !node.removed && node.type === 'STICKY') return node;
  }
  const tagged = figma.currentPage.findAll((n) => {
    return n.type === 'STICKY' && n.getPluginData(SUMMARY_ROLE_KEY) === SUMMARY_ROLE;
  });
  if (tagged.length > 0) return tagged[0] as StickyNode;
  return null;
}

function tagSummary(sticky: StickyNode) {
  sticky.setPluginData(SUMMARY_ROLE_KEY, SUMMARY_ROLE);
  sticky.name = 'Session Summary';
  figma.currentPage.setPluginData(PAGE_SUMMARY_ID_KEY, sticky.id);
}

// One living sticky on the current page. Create if missing, otherwise write
// in place. The node is left on the board when the session ends; the Worker
// chat is what expires.
export async function updateSummary(raw: string) {
  const text = typeof raw === 'string' ? raw : String(raw || '');
  let sticky: StickyNode | null = null;
  let created = false;
  try {
    sticky = await findSummarySticky();
    if (!sticky) {
      sticky = figma.createSticky();
      created = true;
    }
  } catch {
    postError("Couldn't create a session summary sticky.");
    return;
  }

  try {
    await loadStickyFonts(sticky);
    sticky.text.characters = text;
  } catch {
    if (created) sticky.remove();
    postError("Couldn't write that sticky: the font wouldn't load.");
    return;
  }

  tagSummary(sticky);
  if (created) {
    sticky.x = Math.round(figma.viewport.center.x - sticky.width / 2);
    sticky.y = Math.round(figma.viewport.center.y - sticky.height / 2);
  }
  figma.currentPage.selection = [sticky];
  figma.notify(created ? 'Dropped the session summary on your board.' : 'Updated the session summary.');
  postUpdated(sticky.id);
}
