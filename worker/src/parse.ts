import type { ClientMessage, Mood } from '../../src/shared/protocol';
import { SESSION_LIMITS } from '../../src/shared/protocol';

const MOODS: ReadonlySet<Mood> = new Set(['stuck', 'frustrated', 'thinking', 'fine']);
const CLIENT_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

export const ROOM_ID_RE = /^(file|local):[A-Za-z0-9._:-]{1,128}$/;

export type ParseResult =
  | { ok: true; value: ClientMessage }
  | { ok: true; ignored: true }
  | { ok: false; message: string };

export function sanitizeDisplayName(value: unknown): string {
  const cleaned = String(value ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim();
  const fallback = cleaned || 'Anonymous';
  return fallback.slice(0, SESSION_LIMITS.maxDisplayNameLength);
}

export function sanitizeBoard(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .slice(0, SESSION_LIMITS.maxBoardItems)
    .map((item) => String(item ?? '').slice(0, SESSION_LIMITS.maxBoardItemLength));
}

export function parseClientMessage(raw: string): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, message: 'Invalid JSON' };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, message: 'Invalid message' };
  }

  const msg = data as Record<string, unknown>;
  switch (msg.type) {
    case 'join': {
      if (typeof msg.clientId !== 'string' || !CLIENT_ID_RE.test(msg.clientId)) {
        return { ok: false, message: 'Invalid clientId' };
      }
      if (typeof msg.displayName !== 'string') {
        return { ok: false, message: 'Invalid displayName' };
      }
      return {
        ok: true,
        value: {
          type: 'join',
          clientId: msg.clientId,
          displayName: sanitizeDisplayName(msg.displayName),
        },
      };
    }
    case 'set-state': {
      if (!isRoundId(msg.roundId)) return { ok: false, message: 'Invalid roundId' };
      if (typeof msg.mood !== 'string' || !MOODS.has(msg.mood as Mood)) {
        return { ok: false, message: 'Invalid mood' };
      }
      return {
        ok: true,
        value: {
          type: 'set-state',
          roundId: msg.roundId,
          mood: msg.mood as Mood,
          board: sanitizeBoard(msg.board),
        },
      };
    }
    case 'contribute': {
      if (!isRoundId(msg.roundId)) return { ok: false, message: 'Invalid roundId' };
      if (typeof msg.text !== 'string') return { ok: false, message: 'Invalid text' };
      const text = msg.text.trim();
      if (!text) return { ok: false, message: 'Text is required' };
      if (text.length > SESSION_LIMITS.maxTextLength) {
        return { ok: false, message: 'Text is too long' };
      }
      return {
        ok: true,
        value: {
          type: 'contribute',
          roundId: msg.roundId,
          text,
          board: sanitizeBoard(msg.board),
        },
      };
    }
    case 'pass': {
      if (!isRoundId(msg.roundId)) return { ok: false, message: 'Invalid roundId' };
      return {
        ok: true,
        value: {
          type: 'pass',
          roundId: msg.roundId,
          board: sanitizeBoard(msg.board),
        },
      };
    }
    case 'retry': {
      if (!isRoundId(msg.roundId)) return { ok: false, message: 'Invalid roundId' };
      return { ok: true, value: { type: 'retry', roundId: msg.roundId } };
    }
    case 'ping':
      return { ok: true, value: { type: 'ping' } };
    default:
      return { ok: true, ignored: true };
  }
}

function isRoundId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}
