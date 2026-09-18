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
      you: { clientId: string };
      participants: Participant[];
      messages: ChatMessage[];
      round: RoundState;
    }
  | { type: 'presence'; participants: Participant[] }
  | { type: 'message'; message: ChatMessage }
  | { type: 'round'; round: RoundState }
  | { type: 'error'; code: ServerErrorCode; message: string }
  | { type: 'pong' };

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
  // Worker-global OpenAI attempt budget. Opaque room IDs are the room
  // capability, so inventing rooms must not bypass this demo cap.
  maxOpenAiCallsGlobalPerWindow: 100,
  openAiCallGlobalWindowMs: 24 * 60 * 60 * 1000,
} as const;
