# Duck Check-In

FigJam plugin. A small yellow duck sits in the panel. When you actually go quiet it checks in: asks how you're feeling first, then talks it through with you, using what's actually on the board.

## When the duck speaks up
After 20 seconds in which you have done none of these:

- moved your cursor on the canvas
- panned or zoomed
- changed anything in the document, including editing text in something that already exists

So hovering counts as working, and so does reading around the board. The duck only appears when you have genuinely stopped, or walked away. If you left, it is already waiting when you get back.

## Live chat vs fallback
Board reading works either way, no key, no cost. It is just pulling text off the canvas.

- No key: fallback mode. Replies are canned templates with real sticky text dropped into them. The panel says so on screen, because it is not a conversation.
- Key set: live mode. Real conversational replies, still using the board snapshot as context.

Pick a provider in settings and paste a key. Keys are kept per provider, so you can switch without retyping.

| Provider | Model | Notes |
| --- | --- | --- |
| OpenRouter | `thinkingmachines/inkling:free` | Free. 20 requests a minute, 50 a day per account, 1000 a day once the account has bought $10 of credit. The cap is per account, not per model, so every `:free` model shares it. |
| OpenAI | `gpt-5.6-luna` | Paid, pay as you go. |
| Anthropic | `claude-haiku-4-5` | Paid, pay as you go. |
| Google AI Studio | `gemini-3.8-flash` | Has a free tier. |

Keys are stored locally via `figma.clientStorage`. In live mode, board text and your messages go to the selected provider on every chat turn, nowhere else.

For tester builds, put an OpenRouter key in `SHARED_KEY` at the top of `src/ui.ts` and nobody has to set anything up. It ships inside the plugin, so it is public: free models only, and don't commit one.

## Setup
Already built. Import `manifest.json` in FigJam: Plugins → Development → Import plugin from manifest. Needs the Figma desktop app.

To change the code:
```
npm install
npm run build
```
`npm run watch` rebuilds automatically while editing.

Run the checks with:
```
npm test
```
That compiles `src/` and asserts against the compiled output: each provider's URL, auth header, request body, role mapping and reply path, the error copy, and the migration that carries keys saved by older builds into the current settings.

## Notes
- Cursor and viewport come from `figma.activeUsers[0]`, which is FigJam-only and needs the `activeusers` permission. There is no mouse event to subscribe to, so it is polled every 2s. Without the permission the duck falls back to document edits alone.
- Constants are at the top of `src/code.ts`. Provider definitions are at the top of `src/ui.ts`. Adding a provider means adding one entry there and one case in `test/adapters.test.js`.
- Settings edits are held in a draft and applied on Save, so Back discards them rather than quietly pointing the next conversation somewhere else.
- Keys saved by older builds (`openrouterApiKey`, `openaiApiKey`, `anthropicApiKey`) are migrated into the current settings on load, and only deleted once the migration has been written.
- `code.ts` owns the stored settings. Saving sends only the entries the user changed; `code.ts` merges them onto whatever is actually in storage and reports back what landed. The UI never advances its own copy on its own say-so, so a settings screen working from a stale or failed read cannot wipe a key it never saw.
- Saves are serialised, because read-modify-write is not atomic and two in flight would otherwise merge onto the same snapshot.
- A save that cannot read storage is refused, not written blind, and the edit is kept so pressing Save again retries it.
- Board snapshot caps at 40 items, 200 characters each. It is re-read before every reply, and the panel footer shows how many items the duck is working from.
- All four providers answer CORS for a null origin, which is what a plugin iframe sends, so the plugin calls them directly with no proxy. Anthropic needs the `anthropic-dangerous-direct-browser-access` header; the others need nothing special.
- API failures are shown as what they are (rejected key, rate limit, no network) instead of the duck pretending it lost its train of thought. Failed turns are kept out of the history sent to the model, and same-role turns are merged because Anthropic and Google require roles to alternate.
- "Drop last reply on board" loads the sticky font first, then places the sticky at the centre of your current viewport. It does not move your camera.
- The duck only interrupts when it is resting. A check-in will not wipe an open conversation or a half-typed API key.
- The panel is built on Figma's own `--figma-color-*` variables, so it follows the editor's light and dark themes.
