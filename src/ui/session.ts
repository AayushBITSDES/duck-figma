import {
  ChatMessage,
  ClientMessage,
  Mood,
  REPLACED_CLOSE_REASON,
  SESSION_LIMITS,
  ServerErrorCode,
  ServerMessage,
} from '../shared/protocol';
import { post, requestBoard } from './bridge';
import { stripDashes } from './render';
import { iHaveActed, state } from './state';

// Hosted Worker. Must match manifest.json networkAccess.allowedDomains
// (both wss:// and https://). Figma CSPs any other host before the upgrade.
// The iframe never talks to a model host; it only opens this session socket.
export const PRODUCTION_WS_ORIGIN = 'wss://duck-facilitator.aayushkggn.workers.dev';

// `npx wrangler dev` on the default port. Flip this flag to talk to it —
// the plugin iframe origin is null, so hostname sniffing cannot choose
// local for you. Do not put secrets here; the Worker holds the model key.
export const LOCAL_WS_ORIGIN = 'ws://localhost:8787';
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
  socketHasSnapshot = false;
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
    // The backoff is reset when a snapshot lands (applyFrame), not here. A
    // socket that opens and then dies without one is a failure however
    // healthy the handshake looked, and resetting on open lets that loop run
    // at full speed forever.
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
  next.onclose = (event?: { code?: number; reason?: string }) => {
    if (myGen !== gen || socket !== next) return;
    socket = null;
    clearTimers();
    if (halt || tearingDown) return;
    // The room keeps one socket per clientId and hangs up on the older one
    // when the same person joins again (worker/src/room.ts, handleJoin).
    // clientStorage is per device, so the same file open in two windows
    // gives both the same clientId: reconnecting here would kick the other
    // window, which would kick this one back, forever. Stop and let the user
    // pick which window wins.
    if (event && event.reason === REPLACED_CLOSE_REASON) {
      halt = true;
      state.ws = 'off';
      state.banner = {
        kind: 'error',
        text: 'Duck is open in another window. Only one can be connected.',
        action: 'reconnect',
      };
      paint();
      return;
    }
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

// The name the Worker gave the session on screen. The thread cannot stand in
// for it: after a long enough absence a reconnect snapshot shares no turns
// with what is here (both sides keep only the last maxMessages), and a reset
// during round 1 keeps the round number.
let roomSession = '';
// The Worker answers a join with one snapshot, and the only other time it
// sends one is a reset. So a second snapshot on the same socket is a new
// session whatever it carries, which also covers a Worker that predates
// session names.
let socketHasSnapshot = false;

function isNewSession(snap: Extract<ServerMessage, { type: 'snapshot' }>): boolean {
  if (socketHasSnapshot) return true;
  if (snap.round.id < state.round.id) return true;
  return !!(snap.session && roomSession && snap.session !== roomSession);
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
    if (state.gotSnapshot && isNewSession(parsed)) {
      state.session += 1;
      // The Worker forgets its nudge cooldowns on a reset, and a nudge from
      // round 1 of the old session would otherwise show in round 1 of this one.
      state.nudgedAt = 0;
      state.nudgedBy = '';
      state.nudgedRound = 0;
    }
    state.gotSnapshot = true;
    socketHasSnapshot = true;
    if (parsed.session) roomSession = parsed.session;
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
  } else if (parsed.type === 'nudged') {
    state.nudgedBy = parsed.by;
    state.nudgedRound = state.round.id;
    // A toast from the plugin reaches someone heads-down in the board, or
    // with the panel collapsed, where nothing in the panel would.
    post({ type: 'notify', text: parsed.by + ' is waiting on you in Duck Check-In.' });
  } else if (parsed.type === 'error') {
    if (parsed.code === 'already_acted') {
      state.actedRoundId = state.round.id;
    } else if (parsed.code === 'room_full') {
      halt = true;
      clearTimers();
      closeSocket();
      state.ws = 'off';
      // Someone may leave; offer the retry rather than making the user
      // reopen the whole plugin to get another attempt.
      state.banner = { kind: 'error', text: parsed.message, code: parsed.code, action: 'reconnect' };
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

// Deliberate, user-driven retry after a halt (a replaced socket, a full
// room). Everything else reconnects on its own, so nothing else calls this.
export function reconnectSession() {
  if (!state.roomId || !state.clientId) return;
  halt = false;
  tearingDown = false;
  attempt = 0;
  state.banner = null;
  openSocket(++gen);
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

export function actNudge() {
  if (state.round.status !== 'collecting' || !iHaveActed()) return;
  if (send({ type: 'nudge', roundId: state.round.id })) {
    state.nudgedAt = Date.now();
    // Brings the button back once the Worker would let another nudge through.
    setTimeout(paint, SESSION_LIMITS.nudgeCooldownMs + 50);
  } else {
    markSendFailed();
  }
  paint();
}

export function actCloseRound() {
  if (state.round.status !== 'collecting' || !iHaveActed() || state.round.closesAt) return;
  if (!send({ type: 'close-round', roundId: state.round.id })) markSendFailed();
  paint();
}

// The fresh snapshot the Worker sends everyone is what repaints; this only
// reports whether the request left.
export function actReset(): boolean {
  if (send({ type: 'reset' })) return true;
  markSendFailed();
  paint();
  return false;
}

export function actRetry() {
  if (state.round.status !== 'failed') return;
  send({ type: 'retry', roundId: state.round.id });
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', disconnectSession);
}
