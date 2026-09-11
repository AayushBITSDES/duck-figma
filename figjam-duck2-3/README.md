# Duck Check-In

> Older iteration, kept for reference. `../figjam-duck2-4` is the current version and the one to import.

FigJam plugin. A small yellow duck sits in the corner. If 3 minutes pass with no new stickies or shapes, it checks in: asks how you're feeling first, then talks it through with you, using what's actually on the board.

## Live chat vs fallback
Click "settings" under the duck and paste an Anthropic API key. With a key it reads text from stickies, text nodes, shapes-with-text, code blocks, and section names on the current page, and can reference them in replies. Without a key it falls back to canned prompts and does not read the board.

The key is stored locally via `figma.clientStorage`. Board text and your messages are sent to `api.anthropic.com` on every chat turn when a key is set, nowhere else.

## Setup
Already built. Import `manifest.json` in FigJam: Plugins → Development → Import plugin from manifest.

To change the code:
```
npm install
npm run build
```
`npm run watch` rebuilds automatically while editing.

## Notes
- Idle detection is based on node creation events (`documentchange`, type `CREATE`), not cursor position. Cursor movement alone never resets the timer.
- Threshold is 3 min, checked every 15s. Constants are at the top of `src/code.ts`.
- Board snapshot caps at 40 items, 200 characters each, to keep requests small.
- Live mode uses `claude-haiku-4-5-20251001`, 220 max tokens per reply.
