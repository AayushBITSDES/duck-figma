# Duck Check-In

FigJam plugin. A small yellow duck sits in the corner. If 3 minutes pass with no new stickies or shapes, it checks in: asks how you're feeling first, then talks it through with you, using what's actually on the board.

## Live chat vs fallback
Board reading works either way, no cost, it's just pulling text off the canvas.

- No API key: fallback mode. Replies are canned templates with real sticky/text content dropped into them. The chat panel says so on screen, because it is not a conversation.
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
- Idle detection is based on node creation events (`documentchange`, type `CREATE`), not cursor position. Cursor movement alone never resets the timer, and editing text inside an existing sticky does not count as activity.
- Threshold is 3 min, checked every 15s. Constants are at the top of `src/code.ts`.
- Board snapshot caps at 40 items, 200 characters each, to keep things fast. It is re-read before every reply, and the chat footer shows how many items the duck is actually working from.
- Live mode uses `claude-haiku-4-5`, 220 max tokens per reply.
- API failures are shown as what they are (rejected key, rate limit, no network) instead of the duck pretending it lost its train of thought. Failed turns are kept out of the history sent to the API.
- "Drop last reply on board" loads the sticky font first, then places the sticky at the centre of your current viewport. It does not move your camera.
- The duck only interrupts when it is resting. A check-in will not wipe an open conversation or a half-typed API key.
