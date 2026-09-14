import { state } from './state';

export type Mood = 'stuck' | 'frustrated' | 'thinking' | 'fine';

export const moodOpeners: Record<Mood, string> = {
  stuck: "I'm feeling stuck.",
  frustrated: "I'm feeling frustrated.",
  thinking: "I'm just thinking things through.",
  fine: "I'm fine, just moving slow.",
};

export const fallbackFollowUps = [
  "What's the actual goal on this board?",
  "What have you already tried?",
  "What's the smallest next step you could take?",
  "What would 'done' look like here?",
  "What's one thing you're avoiding right now?",
];
export const fallbackItemTemplates = [
  "You've got \"ITEM\" up there. What's stopping you from moving on it?",
  "I see \"ITEM\" on the board. Still relevant, or is it stale?",
  "Out of everything there, is \"ITEM\" the one you're actually stuck on?",
  "\"ITEM\" is sitting on the board. Worth revisiting, or can it go?",
];
let fallbackTurn = 0;
let fallbackItemCursor = 0;

// startChat resets these for a fresh conversation; exported as a function
// rather than the raw cursors, since an importer can read but never assign to
// an exported `let`.
export function resetFallbackCursors() {
  fallbackTurn = 0;
  fallbackItemCursor = 0;
}

export function fallbackReply(first = false): string {
  const useItem = state.boardItems.length > 0 && (first || fallbackTurn % 2 === 0);
  const turn = fallbackTurn++;
  if (useItem) {
    const raw = state.boardItems[fallbackItemCursor % state.boardItems.length];
    const template = fallbackItemTemplates[fallbackItemCursor % fallbackItemTemplates.length];
    fallbackItemCursor++;
    const item = raw.length > 60 ? raw.slice(0, 60) + '...' : raw;
    const line = template.replace('ITEM', item);
    if (first) {
      return 'I can see ' + state.boardItems.length + (state.boardItems.length === 1 ? ' thing' : ' things') + ' on the board. ' + line;
    }
    return line;
  }
  return fallbackFollowUps[turn % fallbackFollowUps.length];
}
