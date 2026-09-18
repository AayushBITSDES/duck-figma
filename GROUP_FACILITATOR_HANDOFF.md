# Group facilitator demo handoff

## Goal

Turn Duck Check-In from an individual inactivity intervention into an explicitly invoked group facilitator. The demo should help a FigJam team discuss the board together without monitoring motion or interrupting people automatically.

## Start here

1. Confirm the working tree, then create `feat/group-facilitator-demo` from `main` before editing implementation files.
2. Read `src/plugin/code.ts`, `src/plugin/idle.ts`, `src/plugin/board.ts`, `src/plugin/sticky.ts`, and `src/ui/screens.ts`.
3. Implement the smallest synchronized demo described below.
4. Run `npm test`, `npm run build`, and `npm run test:bundle`.
5. Push the branch and open a PR to `main`. Wait for Greptile, address its findings, then merge.

## Locked product decisions

- Remove inactivity, cursor, viewport, and motion monitoring entirely.
- The facilitator speaks only inside an explicit group session.
- Any teammate can start by choosing the existing state options: Stuck, Frustrated, Thinking, or Fine, just slow.
- A participant's Figma name and chosen state appear immediately in the shared chat.
- One temporary session belongs to one FigJam file.
- Chat is synchronized through a hosted Cloudflare Worker and Durable Object.
- No authentication for this demo. Use Figma display names and strict demo usage limits.
- The backend owns the OpenAI key. Remove participant provider and API-key controls.
- Facilitation happens in rounds. Every connected participant must contribute once or press Pass before the AI responds.
- Keep the existing board reader unchanged: at most 40 text-bearing objects, at most 200 characters each.
- A participant can press Update summary. This creates or replaces one Session Summary object on the board.
- When everyone disconnects, discard backend chat state after a short reconnect window. The latest board summary remains.

## Demo flow

```text
Open plugin
  -> join the temporary room for this FigJam file
  -> see connected participants
  -> choose a state or contribute to the current round
  -> contribute or Pass
  -> after everyone is ready, OpenAI responds to the group
  -> optionally press Update summary
  -> one board summary is created or updated
```

## Technical direction

- Add the `currentuser` permission and remove the `activeusers` permission from `manifest.json`.
- Remove `startIdleWatch()` and all automatic check-in behavior.
- Use one Durable Object instance per FigJam room for WebSocket connections, presence, messages, round status, and temporary state.
- Keep `OPENAI_API_KEY` as a Worker secret. Use one backend-selected model rather than preserving all four client-side provider adapters.
- Never place the OpenAI key in plugin code, bundled HTML, repository files, or PR text.
- The Worker URL must be added to `manifest.json` network access before the hosted demo can run.
- Prefer one living summary node updated in place over creating repeated sticky notes.

## Demo completion criteria

- Two plugin instances on the same FigJam file see the same participants and messages live.
- A round cannot trigger the facilitator until every connected participant contributes or passes.
- One OpenAI response is broadcast to everyone when the round completes.
- Update summary creates one board object and later updates that same object.
- Closing all plugin instances expires the temporary backend session.
- No motion, cursor, viewport, or inactivity data is read.
- Existing source tests and shipped-bundle tests pass.

## Explicitly deferred

Authentication, permanent transcripts, analytics, admin tools, multiple rooms per file, richer spatial board understanding, production billing, and production-scale abuse prevention are outside this demo.
