import { ChatMessage, Mood, Participant, RoundState, ServerErrorCode } from '../shared/protocol';

export type Mode = 'connecting' | 'session' | 'settings';
export type SocketStatus = 'off' | 'connecting' | 'live' | 'reconnecting';

export type Banner = {
  kind: 'error' | 'info';
  text: string;
  code?: ServerErrorCode;
  // Set when the only way forward is the user asking for another connection
  // attempt, so the footer can offer one instead of claiming it is already
  // reconnecting. Nothing auto-retries while this is set.
  action?: 'reconnect';
};

// A single mutable object rather than exported `let` bindings: ES module live
// bindings let an importer read an exported `let`, but never assign to it, and
// every screen needs to flip these in place.
export const state = {
  mode: 'connecting' as Mode,
  // Mirrors the plugin side's window state. The plugin owns the truth (it is
  // the only side that can call figma.ui.resize), and tells us via 'window'.
  minimized: false,
  textSize: 11,

  roomId: '',
  clientId: '',
  displayName: '',
  ws: 'off' as SocketStatus,
  gotSnapshot: false,
  participants: [] as Participant[],
  messages: [] as ChatMessage[],
  round: { id: 1, status: 'collecting' } as RoundState,
  // Set as soon as we send an action for this round so waiting UI appears
  // before the server's presence frame; snapshot/presence remain the truth
  // for everyone else's names and for our own messages.
  actedRoundId: null as number | null,
  busy: false,
  banner: null as Banner | null,

  boardItems: [] as string[],

  // Survives innerHTML repaints from presence/message/round/reconnect.
  // Cleared only after a contribution is successfully delivered.
  draft: '',
};

export const MOODS: { id: Mood; label: string; buttonId: string }[] = [
  { id: 'stuck', label: 'Stuck', buttonId: 'mood-stuck' },
  { id: 'frustrated', label: 'Frustrated', buttonId: 'mood-frustrated' },
  { id: 'thinking', label: 'Thinking', buttonId: 'mood-thinking' },
  { id: 'fine', label: 'Fine, just slow', buttonId: 'mood-fine' },
];

export function moodLabel(mood: Mood): string {
  for (let i = 0; i < MOODS.length; i++) {
    if (MOODS[i].id === mood) return MOODS[i].label;
  }
  return mood;
}

export function me(): Participant | undefined {
  for (let i = 0; i < state.participants.length; i++) {
    if (state.participants[i].clientId === state.clientId) return state.participants[i];
  }
  return undefined;
}

export function iHaveActed(): boolean {
  const self = me();
  if (self && self.status !== 'pending') return true;
  return state.actedRoundId === state.round.id;
}

export function lastFacilitatorText(): string {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    if (state.messages[i].kind === 'facilitator') return state.messages[i].text;
  }
  return '';
}
