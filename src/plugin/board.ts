export const MAX_BOARD_ITEMS = 40;
export const MAX_ITEM_LENGTH = 200;
export const BOARD_CACHE_MS = 4_000;

const TEXT_TYPES = ['STICKY', 'TEXT', 'SHAPE_WITH_TEXT', 'CODE_BLOCK', 'SECTION'] as const;

type CachedBoard = { at: number; items: string[] };
let cached: CachedBoard | null = null;

function nodeText(n: SceneNode): string {
  if (n.type === 'STICKY') return (n as StickyNode).text.characters;
  if (n.type === 'TEXT') return (n as TextNode).characters;
  if (n.type === 'SHAPE_WITH_TEXT') return (n as ShapeWithTextNode).text.characters;
  if (n.type === 'CODE_BLOCK') return (n as CodeBlockNode).code;
  if (n.type === 'SECTION') return (n as SectionNode).name;
  return '';
}

function readPage(): string[] {
  const page = figma.currentPage as PageNode & {
    findAllWithCriteria?: (query: { types: SceneNode['type'][] }) => SceneNode[];
  };
  const nodes =
    typeof page.findAllWithCriteria === 'function'
      ? page.findAllWithCriteria({ types: TEXT_TYPES.slice() })
      : page.findAll((n) => TEXT_TYPES.indexOf(n.type as (typeof TEXT_TYPES)[number]) !== -1);
  const items: string[] = [];
  for (const n of nodes) {
    const text = (nodeText(n) || '').trim();
    if (!text) continue;
    items.push(text.slice(0, MAX_ITEM_LENGTH));
    if (items.length >= MAX_BOARD_ITEMS) break;
  }
  return items;
}

export function getBoardItems(): string[] {
  const now = Date.now();
  if (cached && now - cached.at < BOARD_CACHE_MS) return cached.items.slice();
  const items = readPage();
  cached = { at: now, items };
  return items.slice();
}

export function sendBoard() {
  figma.ui.postMessage({ type: 'board-context', board: getBoardItems() });
}
