# Duck Check-In

A rubber duck that sits in your FigJam board and notices when you get stuck.

It watches for you going quiet. After 20 seconds with no cursor movement, no
panning and no edits, it asks how you're doing. It reads the text on your board
too, so it can ask about the sticky you've been circling rather than something
generic. Rubber duck debugging, with the duck deciding when to ask.

## Installing it

You need the Figma **desktop app**. The browser version cannot load a plugin
from a folder.

1. Download this project to your computer.
2. Open a FigJam file in the desktop app.
3. Go to Plugins > Development > Import plugin from manifest.
4. Choose the `manifest.json` file inside the folder you downloaded.

The duck now appears under Plugins > Development > Duck Check-In. You only do
this once.

## Talking to it

It works right away, though its replies come from a fixed script.

For a real conversation, open Settings in the panel and paste in an API key.
OpenRouter has a free tier; OpenAI, Anthropic and Google AI Studio also work.
Your key stays on your own machine.

## Working on the code

`npm install`, then `npm run build`. `npm test` runs the checks.
