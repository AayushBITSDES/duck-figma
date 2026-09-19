import {
  ChatMessage,
  ClientMessage,
  Mood,
  SESSION_LIMITS,
  ServerErrorCode,
  ServerMessage,
} from '../shared/protocol';
import { requestBoard } from './bridge';
import { stripDashes } from './render';
import { iHaveActed, state } from './state';

// Hosted Worker. Must match manifest.json networkAccess.allowedDomains
// (both wss:// and https://). Figma CSPs any other host before the upgrade.
// The iframe never talks to a model host; it only opens this session socket.
export const PRODUCTION_WS_ORIGIN = 'wss://duck-facilitator.example.workers.dev';

// `npx wrangler dev` on the default port. Flip this flag to talk to it —
// the plugin iframe origin is null, so hostname sniffing cannot choose
// local for you. Do not put secrets here; the Worker holds the model key.
export const LOCAL_WS_ORIGIN = 'ws://127.0.0.1:8787';
export const USE_LOCAL_WORKER = false;

const PING_MS = 20_000;
const RECONNECT_MS = [500, 1000, 2000, 4000];

type PaintFn = () => void;
let paint: PaintFn = () => {};

export function onPaint(fn: PaintFn) {
  paint = fn;
}

function wsOrigin(): string {
  return USE_LOCAL_WORKER ? LOCAL_WS_ORIGIN : PRODUCTION_WS_ORIGIN;
}

export function roomSocketUrl(roomId: string): string {
  return wsOrigin() + '/room?roomId=' + encodeURIComponent(roomId);
}

let gen = 0;
let socket: WebSocket | null = null;
let pingTimer: ReturnType<typeof setInterval> | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let attempt = 0;
let halt = false;
let tearingDown = false;

function clearTimers() {
  if (pingTimer !== undefined) {
    clearInterval(pingTimer);
    pingTimer = undefined;
  }
  if (reconnectTimer !== undefined) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
}

function clipName(name: string): string {
  const trimmed = (name || '').trim().slice(0, SESSION_LIMITS.maxDisplayNameLength);
  return trimmed || 'Anonymous';
}

function clippedBoard(): string[] {
  return state.boardItems
    .slice(0, SESSION_LIMITS.maxBoardItems)
    .map((item) => item.slice(0, SESSION_LIMITS.maxBoardItemLength));
}

function send(msg: ClientMessage): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(msg));
  return true;
}

function closeSocket() {
  clearTimers();
  const current = socket;
  socket = null;
  if (!current) return;
  current.onopen = null;
  current.onmessage = null;
  current.onerror = null;
  current.onclose = null;
  try {
    current.close();
  } catch (_) {
    // Already closing is fine.
  }
}

function scheduleReconnect(myGen: number) {
  if (tearingDown || halt || myGen !== gen) return;
  state.ws = 'reconnecting';
  paint();
  const wait = attempt >= RECONNECT_MS.length ? RECONNECT_MS[RECONNECT_MS.length - 1] : RECONNECT_MS[attempt];
  attempt++;
  reconnectTimer = setTimeout(() => openSocket(myGen), wait);
}

function openSocket(myGen: number) {
  if (tearingDown || halt || myGen !== gen) return;
  if (typeof WebSocket === 'undefined') {
    state.ws = 'connecting';
    paint();
    return;
  }
  closeSocket();
  state.ws = 'connecting';
  paint();
  let next: WebSocket;
  try {
    next = new WebSocket(roomSocketUrl(state.roomId));
  } catch (_) {
    scheduleReconnect(myGen);
    return;
  }
  socket = next;
  next.onopen = () => {
    if (myGen !== gen || socket !== next) return;
    attempt = 0;
    state.ws = 'live';
    send({
      type: 'join',
      clientId: state.clientId,
      displayName: clipName(state.displayName),
    });
    pingTimer = setInterval(() => {
      send({ type: 'ping' });
    }, PING_MS);
    paint();
  };
  next.onmessage = (event) => {
    if (myGen !== gen || socket !== next) return;
    applyFrame(event.data);
  };
  next.onerror = () => {
    // onclose follows; reconnect is scheduled there.
  };
  next.onclose = () => {
    if (myGen !== gen || socket !== next) return;
    socket = null;
    clearTimers();
    if (halt || tearingDown) return;
    scheduleReconnect(myGen);
  };
}

function quietError(code: ServerErrorCode): boolean {
  return code === 'already_acted' || code === 'stale_round' || code === 'round_locked';
}

function ingestMessage(message: ChatMessage): ChatMessage {
  if (message.kind !== 'facilitator') return message;
  return {
    id: message.id,
    at: message.at,
    kind: message.kind,
    author: message.author,
    text: stripDashes(message.text || ''),
    mood: message.mood,
  };
}

function applyFrame(raw: unknown) {
  let parsed: ServerMessage;
  try {
    const text = typeof raw === 'string' ? raw : String(raw);
    parsed = JSON.parse(text) as ServerMessage;
  } catch (_) {
    return;
  }
  if (!parsed || !parsed.type) return;
  if (parsed.type === 'pong') return;

  if (parsed.type === 'snapshot') {
    state.gotSnapshot = true;
    if (parsed.roomId) state.roomId = parsed.roomId;
    if (parsed.you && parsed.you.clientId) state.clientId = parsed.you.clientId;
    state.participants = parsed.participants || [];
    state.messages = (parsed.messages || []).map(ingestMessage);
    state.round = parsed.round;
    const self = state.participants.filter((p) => p.clientId === state.clientId)[0];
    state.actedRoundId = self && self.status !== 'pending' ? state.round.id : null;
    state.banner = null;
    halt = false;
    attempt = 0;
  } else if (parsed.type === 'presence') {
    state.participants = parsed.participants || [];
    const self = state.participants.filter((p) => p.clientId === state.clientId)[0];
    // Presence can arrive for someone else's join before our own action is
    // applied. Only promote to acted here; round-id changes clear the flag.
    if (self && self.status !== 'pending') state.actedRoundId = state.round.id;
  } else if (parsed.type === 'message') {
    state.messages.push(ingestMessage(parsed.message));
    if (state.messages.length > SESSION_LIMITS.maxMessages) {
      state.messages = state.messages.slice(-SESSION_LIMITS.maxMessages);
    }
  } else if (parsed.type === 'round') {
    if (parsed.round.id !== state.round.id) state.actedRoundId = null;
    state.round = parsed.round;
    if (parsed.round.status === 'failed') {
      const keepCap =
        !!state.banner &&
        (state.banner.code === 'session_cap' || state.banner.code === 'rate_limited');
      if (!keepCap) {
        state.banner = {
          kind: 'error',
          text: 'The duck could not reply. Retry this round.',
          code: 'facilitator_failed',
        };
      }
    } else if (state.banner && state.banner.code === 'facilitator_failed') {
      state.banner = null;
    }
  } else if (parsed.type === 'error') {
    if (parsed.code === 'already_acted') {
      state.actedRoundId = state.round.id;
    } else if (parsed.code === 'room_full') {
      halt = true;
      clearTimers();
      closeSocket();
      state.ws = 'off';
      state.banner = { kind: 'error', text: parsed.message, code: parsed.code };
    } else {
      if (
        parsed.code === 'stale_round' ||
        parsed.code === 'round_locked' ||
        parsed.code === 'rate_limited' ||
        parsed.code === 'bad_request' ||
        parsed.code === 'session_cap'
      ) {
        const self = state.participants.filter((p) => p.clientId === state.clientId)[0];
        if (!self || self.status === 'pending') {
          if (state.actedRoundId === state.round.id) state.actedRoundId = null;
        }
      }
      if (!quietError(parsed.code)) {
        state.banner = { kind: 'error', text: parsed.message, code: parsed.code };
      }
    }
  } else {
    return;
  }

  paint();
}

export function connectSession(roomId: string, clientId: string, displayName: string) {
  if (!roomId || !clientId) return;
  const name = clipName(displayName);
  const sameRoom = state.roomId === roomId && state.clientId === clientId;
  if (
    sameRoom &&
    socket &&
    socket.readyState === WebSocket.OPEN &&
    state.ws === 'live'
  ) {
    state.displayName = name;
    return;
  }
  if (!sameRoom) {
    state.gotSnapshot = false;
    state.participants = [];
    state.messages = [];
    state.round = { id: 1, status: 'collecting' };
    state.actedRoundId = null;
    state.banner = null;
    state.draft = '';
  }
  state.roomId = roomId;
  state.clientId = clientId;
  state.displayName = name;
  halt = false;
  attempt = 0;
  tearingDown = false;
  const myGen = ++gen;
  openSocket(myGen);
}

export function disconnectSession() {
  tearingDown = true;
  gen++;
  halt = true;
  closeSocket();
  state.ws = 'off';
}

function markSendFailed() {
  if (state.banner && state.banner.kind === 'error') return;
  state.banner = {
    kind: 'error',
    text: state.ws === 'live' ? 'Could not send. Try again.' : 'Could not send. Reconnecting...',
  };
}

function clearSendFailed() {
  if (state.banner && state.banner.text.indexOf('Could not send') === 0) {
    state.banner = null;
  }
}

async function withBoard<T extends ClientMessage>(build: () => T): Promise<boolean> {
  if (state.busy) return false;
  if (state.round.status !== 'collecting') return false;
  if (iHaveActed()) return false;
  const roundId = state.round.id;
  const sock = socket;
  state.busy = true;
  paint();
  await requestBoard();
  if (state.round.id !== roundId || state.round.status !== 'collecting') {
    state.busy = false;
    paint();
    return false;
  }
  const stillOpen = !!(sock && socket === sock && sock.readyState === WebSocket.OPEN);
  let ok = false;
  if (stillOpen) {
    ok = send(build());
    if (ok) {
      state.actedRoundId = roundId;
      clearSendFailed();
    }
  }
  if (!ok) markSendFailed();
  state.busy = false;
  paint();
  return ok;
}

export async function actSetState(mood: Mood): Promise<boolean> {
  return withBoard(() => ({
    type: 'set-state',
    roundId: state.round.id,
    mood,
    board: clippedBoard(),
  }));
}

export async function actContribute(text: string): Promise<boolean> {
  const clipped = text.trim().slice(0, SESSION_LIMITS.maxTextLength);
  if (!clipped) return false;
  const pendingDraft = state.draft || text;
  const ok = await withBoard(() => ({
    type: 'contribute',
    roundId: state.round.id,
    text: clipped,
    board: clippedBoard(),
  }));
  if (ok) {
    state.draft = '';
  } else {
    state.draft = pendingDraft;
    paint();
  }
  return ok;
}

export async function actPass(): Promise<boolean> {
  return withBoard(() => ({
    type: 'pass',
    roundId: state.round.id,
    board: clippedBoard(),
  }));
}

export function actRetry() {
  if (state.round.status !== 'failed') return;
  send({ type: 'retry', roundId: state.round.id });
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', disconnectSession);
}
