# Duck Check-In

A temporary group facilitator for FigJam.

Everyone who opens the plugin in the same file joins one shared session. Each
round waits for every connected participant to contribute or pass, then the
duck responds once to the group. Nothing monitors cursor movement, viewport
changes, motion, or inactivity.

The Worker keeps chat state temporarily. **Update summary** creates one Session
Summary sticky on the board and updates that same sticky on later clicks.

## Install dependencies

Use Node 22:

```sh
npm ci
npm ci --prefix worker
```

Run every automated check with:

```sh
npm run verify
```

## Test locally in FigJam

1. Create `worker/.dev.vars` containing `OPENAI_API_KEY=...`. This file is
   ignored by Git; never commit or paste the key into plugin code.
2. Start the local backend:

   ```sh
   npm --prefix worker run dev
   ```

3. In `src/ui/session.ts`, set `USE_LOCAL_WORKER` to `true`, then build:

   ```sh
   npm run build
   ```

4. In the Figma desktop app, open a FigJam file and choose
   **Plugins > Development > Import plugin from manifest**, then select this
   repository's `manifest.json`.
5. Have a second Figma user import the same development plugin and open it in
   the same FigJam file.
6. Confirm both names appear, choose a state in each window, and verify the
   facilitator responds only after both people act. In the next round, test a
   contribution and **Pass**.
7. Click **Update summary** twice and confirm there is still only one Session
   Summary sticky and its text changes.
8. Close both plugin windows, wait more than 30 seconds, reopen them, and
   confirm the temporary chat is empty while the board summary remains.

Set `USE_LOCAL_WORKER` back to `false` and rebuild before committing.

## Deploy the Worker

Authenticate Wrangler, add the secret, and deploy:

```sh
cd worker
npx wrangler login
npx wrangler secret put OPENAI_API_KEY
npm run deploy
```

Replace `duck-facilitator.example.workers.dev` in both `manifest.json` and
`src/ui/session.ts` with the deployed hostname, then run `npm run verify`.
The hostname must match in both places or Figma will block the WebSocket.

The plugin never receives the OpenAI key. The Worker selects the model through
its non-secret `OPENAI_MODEL` setting.
