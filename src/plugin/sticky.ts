// Setting characters on a sticky throws unless its font is loaded first, so this
// has to be async. Without the load the drop button silently did nothing.
export async function dropSticky(text: string) {
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
