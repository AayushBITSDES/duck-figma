# Mascots

Flat replacements for the inline duck in `src/ui/duck.ts`: one silhouette in `currentColor` plus at most one amber accent. No filters, strokes, shadows, or ids, so several can inline on one page and all inherit the Figma theme. Checked at 16px and 72px, light and dark.

- **owl.svg** — The watcher. The silhouette is mostly a pair of steady eyes, which is what "I noticed you went quiet" should look like.
- **duck.svg** — The incumbent, redrawn as a bath-duck profile. Keeps the rubber-duck premise and the plugin's name.
- **cat.svg** — A loaf. Sits near your work for hours, asks nothing, looks up now and then.
- **tortoise.svg** — Unhurried by construction, for when the check-in should feel like it has all day.
- **frog.svg** — Still, then suddenly talking. Widest silhouette, friendliest when small.

## Ship the owl

Attentiveness is the product, and the owl is the only one that still reads as attentive at 16px, where the rest read as merely cute. Its tall shape suits a narrow panel. The cost is a rename, since the plugin is "Duck Check-In"; if that is off the table, ship `duck.svg`.
