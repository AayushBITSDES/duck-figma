export const MAX_BOARD_ITEMS = 40;
export const MAX_ITEM_LENGTH = 200;

export function getBoardItems(): string[] {
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

export function sendBoard() {
  figma.ui.postMessage({ type: 'board-context', board: getBoardItems() });
}
