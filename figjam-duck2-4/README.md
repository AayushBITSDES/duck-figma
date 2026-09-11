# Duck Check-In

FigJam plugin. A small yellow duck sits in the corner. If 3 minutes pass with no new stickies or shapes, it checks in: asks how you're feeling first, then talks it through with you, using what's actually on the board.

## Live chat vs fallback
Board reading works either way, no cost, it's just pulling text off the canvas.

- No API key: fallback mode. Replies are template-based but reference actual sticky/text content, no AI call, free.
- API key set (Anthropic, paid pay-as-you-go): live mode. Real conversational replies via the API, still using the board snapshot as context.

Click "settings" under the duck to add or remove a key.

The key is stored locally via `figma.clientStorage`. In live mode, board text and your messages are sent to `api.anthropic.com` on every chat turn, nowhere else.

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
- Board snapshot caps at 40 items, 200 characters each, to keep things fast.
- Live mode uses `claude-haiku-4-5-20251001`, 220 max tokens per reply.
