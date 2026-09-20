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

function isOnCurrentPage(node: BaseNode): boolean {
  let current: BaseNode | null = node;
  while (current) {
    if (current.type === 'PAGE') return current === figma.currentPage;
    current = current.parent;
  }
  return false;
}

// Reuse a remembered or tagged sticky only when it still lives on this page.
async function findSummarySticky(): Promise<StickyNode | null> {
  const storedId = figma.currentPage.getPluginData(PAGE_SUMMARY_ID_KEY);
  if (storedId) {
    const node = await figma.getNodeByIdAsync(storedId);
    if (node && !node.removed && node.type === 'STICKY' && isOnCurrentPage(node)) {
      return node;
    }
  }
  const tagged = figma.currentPage.findAll((n) => {
    return n.type === 'STICKY' && n.getPluginData(SUMMARY_ROLE_KEY) === SUMMARY_ROLE;
  });
  for (const n of tagged) {
    if (isOnCurrentPage(n)) return n as StickyNode;
  }
  return null;
}

// The page is passed in rather than read here: by the time this runs the
// user may have switched pages, and the id belongs to the page the sticky
// is actually on.
function tagSummary(sticky: StickyNode, page: PageNode) {
  sticky.setPluginData(SUMMARY_ROLE_KEY, SUMMARY_ROLE);
  sticky.name = 'Session Summary';
  page.setPluginData(PAGE_SUMMARY_ID_KEY, sticky.id);
}

// Runs are chained, never concurrent. Two quick clicks on Update summary
// used to start two runs, both of which awaited the node lookup, both of
// which found nothing, and both of which created a sticky: one ends up
// orphaned on the board with the page's stored id pointing at the other.
let queue: Promise<void> = Promise.resolve();

export function updateSummary(raw: string): Promise<void> {
  queue = queue.then(
    () => runUpdate(raw),
    () => runUpdate(raw)
  );
  return queue;
}

// One living sticky on the current page. Create if missing, otherwise write
// in place. The node is left on the board when the session ends; the Worker
// chat is what expires.
async function runUpdate(raw: string) {
  const text = typeof raw === 'string' ? raw : String(raw || '');
  // Every lookup below reads figma.currentPage, which the user can change
  // under us during any await. Pin the page we started on so a page switch
  // mid-write cannot adopt the new page's summary, delete the sticky we just
  // made on the old one, and stamp this text over someone else's.
  const startedOn = figma.currentPage;
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
    // The font load yields, which is long enough for a collaborator's sticky
    // to sync in. Creating a second one on top of theirs helps nobody, so
    // drop ours and write into what arrived.
    if (created) {
      // Its own catch: a failed lookup here is not the font failure the
      // outer handler reports, and is fine to ignore. Worst case we keep
      // the sticky we already made.
      let arrived: StickyNode | null = null;
      try {
        arrived = figma.currentPage === startedOn ? await findSummarySticky() : null;
      } catch {
        arrived = null;
      }
      if (arrived && arrived !== sticky) {
        sticky.remove();
        sticky = arrived;
        created = false;
        await loadStickyFonts(sticky);
      }
    }
    sticky.text.characters = text;
  } catch {
    if (created) sticky.remove();
    postError("Couldn't write that sticky: the font wouldn't load.");
    return;
  }

  tagSummary(sticky, startedOn);
  if (created) {
    sticky.x = Math.round(figma.viewport.center.x - sticky.width / 2);
    sticky.y = Math.round(figma.viewport.center.y - sticky.height / 2);
  }
  figma.currentPage.selection = [sticky];
  figma.notify(created ? 'Dropped the session summary on your board.' : 'Updated the session summary.');
  postUpdated(sticky.id);
}
