export type Mood = 'stuck' | 'frustrated' | 'thinking' | 'fine';

export type ParticipantStatus = 'pending' | 'contributed' | 'passed';
export type RoundStatus = 'collecting' | 'thinking' | 'failed';

export interface Participant {
  clientId: string;
  displayName: string;
  status: ParticipantStatus;
}

export interface RoundState {
  id: number;
  status: RoundStatus;
  // Set while someone's close-round countdown runs: the Worker's clock, in
  // epoch ms, at which it closes the round without whoever has not acted.
  closesAt?: number;
}

export type ChatMessageKind = 'state' | 'contribution' | 'pass' | 'facilitator' | 'system';

export interface ChatMessage {
  id: string;
  at: number;
  kind: ChatMessageKind;
  author: {
    clientId: string;
    displayName: string;
  };
  text: string;
  mood?: Mood;
}

export type ClientMessage =
  | { type: 'join'; clientId: string; displayName: string }
  | { type: 'set-state'; roundId: number; mood: Mood; board?: string[] }
  | { type: 'contribute'; roundId: number; text: string; board?: string[] }
  | { type: 'pass'; roundId: number; board?: string[] }
  | { type: 'retry'; roundId: number }
  // Everyone still pending this round hears that the sender is waiting.
  | { type: 'nudge'; roundId: number }
  // Starts the countdown after which the round closes without the holdouts.
  | { type: 'close-round'; roundId: number }
  // Clears the chat and starts round 1 for everyone in the room.
  | { type: 'reset' }
  | { type: 'ping' };

export type ServerErrorCode =
  | 'bad_request'
  | 'room_full'
  | 'already_acted'
  | 'stale_round'
  | 'round_locked'
  | 'session_cap'
  | 'rate_limited'
  | 'facilitator_failed';

export type ServerMessage =
  | {
      type: 'snapshot';
      roomId: string;
      // Changes only when the room starts over (a new session, or a wipe
      // after everyone left), so a panel can tell that from a reconnect,
      // however much it missed while away.
      session: string;
      you: { clientId: string };
      participants: Participant[];
      messages: ChatMessage[];
      round: RoundState;
    }
  | { type: 'presence'; participants: Participant[] }
  | { type: 'message'; message: ChatMessage }
  | { type: 'round'; round: RoundState }
  | { type: 'error'; code: ServerErrorCode; message: string }
  // Sent only to the participants a nudge reached.
  | { type: 'nudged'; by: string }
  | { type: 'pong' };

// A room keeps one socket per clientId. When the same clientId joins again,
// the older socket is closed with this reason so the client can tell a
// takeover from an ordinary drop and stop reconnecting into a kick war.
export const REPLACED_CLOSE_REASON = 'replaced';

export const SESSION_LIMITS = {
  maxParticipants: 8,
  maxMessages: 100,
  maxRounds: 20,
  maxTextLength: 500,
  maxDisplayNameLength: 40,
  maxBoardItems: 40,
  maxBoardItemLength: 200,
  maxClientMessagesPerWindow: 20,
  clientMessageWindowMs: 10_000,
  reconnectWindowMs: 30_000,
  openAiTimeoutMs: 20_000,
  maxOpenAiCallsPerWindow: 10,
  openAiCallWindowMs: 10 * 60 * 1000,
  maxUnjoinedSockets: 8,
  // How long a started close-round countdown runs before the round closes.
  closeRoundDelayMs: 30_000,
  // How often one person can be nudged, whoever is doing the nudging.
  nudgeCooldownMs: 30_000,
  // Worker-global OpenAI attempt budget. Opaque room IDs are the room
  // capability, so inventing rooms must not bypass this demo cap.
  maxOpenAiCallsGlobalPerWindow: 100,
  openAiCallGlobalWindowMs: 24 * 60 * 60 * 1000,
} as const;
