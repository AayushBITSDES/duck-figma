import { DurableObject } from 'cloudflare:workers';
import type {
  ChatMessage,
  ClientMessage,
  Mood,
  Participant,
  ParticipantStatus,
  RoundState,
  ServerErrorCode,
  ServerMessage,
} from '../../src/shared/protocol';
import { SESSION_LIMITS } from '../../src/shared/protocol';
import { GLOBAL_LIMITER_INSTANCE } from './limiter';
import { completeFacilitator } from './openai';
import { parseClientMessage, sanitizeDisplayName } from './parse';

const GLOBAL_OPENAI_CAP_MESSAGE = 'The facilitator is at its demo limit. Try again later.';

const FACILITATOR_AUTHOR = { clientId: 'facilitator', displayName: 'Duck' } as const;
const JOIN_TIMEOUT_MS = 5_000;
const ROOM_ROW_ID = 1;

const MOOD_LABELS: Record<Mood, string> = {
  stuck: 'Stuck',
  frustrated: 'Frustrated',
  thinking: 'Thinking',
  fine: 'Fine, just slow',
};

const MOOD_OPENERS: Record<Mood, string> = {
  stuck: "I'm feeling stuck.",
  frustrated: "I'm feeling frustrated.",
  thinking: "I'm just thinking things through.",
  fine: "I'm fine, just moving slow.",
};

type Attachment = {
  clientId?: string;
  displayName?: string;
  joined?: boolean;
  times?: number[];
};

type StoredParticipant = {
  displayName: string;
  status: ParticipantStatus;
  text?: string;
  mood?: Mood;
};

type RoomRecord = {
  round: RoundState;
  participants: Record<string, StoredParticipant>;
  messages: ChatMessage[];
  board: string[];
  openAiCalls: number[];
};

function emptyRecord(): RoomRecord {
  return {
    round: { id: 1, status: 'collecting' },
    participants: {},
    messages: [],
    board: [],
    openAiCalls: [],
  };
}

export class Room extends DurableObject<Env> {
  private record: RoomRecord;
  private facilitating = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.record = emptyRecord();
    this.ctx.blockConcurrencyWhile(async () => {
      this.ensureTable();
      this.record = this.loadRecord();
      if (this.record.round.status === 'thinking') {
        this.record.round.status = 'failed';
        this.saveRecord();
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }
    if (this.unjoinedCount() >= SESSION_LIMITS.maxUnjoinedSockets) {
      return new Response('Too many connections', { status: 429 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ joined: false, times: [] } satisfies Attachment);
    this.ctx.waitUntil(this.closeIfUnjoined(server));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') {
      ws.close(1003, 'text only');
      return;
    }
    if (!this.rateOk(ws)) {
      this.sendError(ws, 'rate_limited', 'Too many messages. Slow down.');
      return;
    }
    if (message.length > 32_768) {
      this.sendError(ws, 'bad_request', 'Message is too large');
      ws.close(1009, 'too large');
      return;
    }
    const parsed = parseClientMessage(message);
    if ('ignored' in parsed) return;
    if (!parsed.ok) {
      this.sendError(ws, 'bad_request', parsed.message);
      return;
    }

    const msg = parsed.value;
    if (msg.type === 'join') {
      await this.handleJoin(ws, msg);
      return;
    }
    if (!this.attachment(ws).joined) {
      this.sendError(ws, 'bad_request', 'Join first');
      ws.close(1008, 'join required');
      return;
    }
    if (msg.type === 'ping') {
      this.send(ws, { type: 'pong' });
      return;
    }
    if (msg.type === 'retry') {
      await this.handleRetry(ws, msg.roundId);
      return;
    }
    await this.handleAct(ws, msg);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    try {
      ws.close(1000, 'durable object closing');
    } catch {
      // already closing
    }
    this.broadcast({ type: 'presence', participants: this.connectedParticipants() });
    await this.maybeFacilitate();
    if (this.ctx.getWebSockets().length === 0) {
      await this.ctx.storage.setAlarm(Date.now() + SESSION_LIMITS.reconnectWindowMs);
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    try {
      ws.close(1011, 'error');
    } catch {
      // already closing
    }
  }

  async alarm(): Promise<void> {
    if (this.ctx.getWebSockets().length > 0) return;
    await this.ctx.storage.deleteAll();
    this.record = emptyRecord();
  }

  private async closeIfUnjoined(ws: WebSocket): Promise<void> {
    await scheduler.wait(JOIN_TIMEOUT_MS);
    const att = this.attachment(ws);
    if (att.joined) return;
    try {
      ws.close(1008, 'join required');
    } catch {
      // already closed
    }
  }

  private async handleJoin(ws: WebSocket, msg: Extract<ClientMessage, { type: 'join' }>): Promise<void> {
    const displayName = sanitizeDisplayName(msg.displayName);
    const connected = this.connectedParticipants();
    const alreadyHere = connected.some((p) => p.clientId === msg.clientId);
    if (!alreadyHere && connected.length >= SESSION_LIMITS.maxParticipants) {
      this.sendError(ws, 'room_full', 'This room is full.');
      ws.close(1008, 'room full');
      return;
    }

    await this.ctx.storage.deleteAlarm();
    const existing = this.record.participants[msg.clientId];
    this.record.participants[msg.clientId] = {
      displayName,
      status: existing?.status ?? 'pending',
      text: existing?.text,
      mood: existing?.mood,
    };
    this.saveRecord();
    ws.serializeAttachment({
      clientId: msg.clientId,
      displayName,
      joined: true,
      times: this.attachment(ws).times ?? [],
    } satisfies Attachment);

    for (const other of this.ctx.getWebSockets()) {
      if (other === ws) continue;
      const att = this.attachment(other);
      if (att.joined && att.clientId === msg.clientId) {
        try {
          other.close(1000, 'replaced');
        } catch {
          // ignore
        }
      }
    }

    this.send(ws, {
      type: 'snapshot',
      roomId: this.roomId(),
      you: { clientId: msg.clientId },
      participants: this.connectedParticipants(),
      messages: this.record.messages,
      round: this.record.round,
    });
    this.broadcast({ type: 'presence', participants: this.connectedParticipants() });
  }

  private async handleAct(
    ws: WebSocket,
    msg: Extract<ClientMessage, { type: 'set-state' | 'contribute' | 'pass' }>
  ): Promise<void> {
    const att = this.attachment(ws);
    const clientId = att.clientId;
    if (!clientId) {
      this.sendError(ws, 'bad_request', 'Join first');
      return;
    }
    if (this.record.round.status !== 'collecting') {
      this.sendError(ws, 'round_locked', 'This round is locked.');
      return;
    }
    if (msg.roundId !== this.record.round.id) {
      this.sendError(ws, 'stale_round', 'That round has already moved on.');
      return;
    }
    if (this.record.round.id > SESSION_LIMITS.maxRounds) {
      this.sendError(ws, 'session_cap', 'This session has reached its round limit.');
      return;
    }
    const stored = this.record.participants[clientId];
    if (stored && (stored.status === 'contributed' || stored.status === 'passed')) {
      this.sendError(ws, 'already_acted', 'You already acted this round.');
      return;
    }

    const displayName = stored?.displayName ?? att.displayName ?? 'Anonymous';
    const board = 'board' in msg ? msg.board : undefined;
    if (board && board.length) this.record.board = board;

    let chat: ChatMessage;
    if (msg.type === 'set-state') {
      this.record.participants[clientId] = {
        displayName,
        status: 'contributed',
        text: MOOD_OPENERS[msg.mood],
        mood: msg.mood,
      };
      chat = this.makeMessage('state', displayName, clientId, displayName + ' is feeling ' + MOOD_LABELS[msg.mood] + '.', msg.mood);
    } else if (msg.type === 'contribute') {
      this.record.participants[clientId] = {
        displayName,
        status: 'contributed',
        text: msg.text,
      };
      chat = this.makeMessage('contribution', displayName, clientId, msg.text);
    } else {
      this.record.participants[clientId] = {
        displayName,
        status: 'passed',
        text: '(passed)',
      };
      chat = this.makeMessage('pass', displayName, clientId, displayName + ' passed.');
    }

    this.pushMessage(chat);
    this.saveRecord();
    this.broadcast({ type: 'message', message: chat });
    this.broadcast({ type: 'presence', participants: this.connectedParticipants() });
    await this.maybeFacilitate();
  }

  private async handleRetry(ws: WebSocket, roundId: number): Promise<void> {
    if (roundId !== this.record.round.id) {
      this.sendError(ws, 'stale_round', 'That round has already moved on.');
      return;
    }
    if (this.record.round.status !== 'failed') {
      this.sendError(ws, 'round_locked', 'Retry is only available after a facilitator failure.');
      return;
    }
    if (this.facilitating) return;
    if (!this.openAiBudgetOk()) {
      this.sendError(ws, 'session_cap', 'This session has reached its facilitator limit.');
      return;
    }
    this.facilitating = true;
    if (!(await this.consumeGlobalOpenAiAttempt())) {
      this.facilitating = false;
      this.sendError(ws, 'rate_limited', GLOBAL_OPENAI_CAP_MESSAGE);
      return;
    }
    this.record.round.status = 'thinking';
    this.saveRecord();
    this.broadcast({ type: 'round', round: this.record.round });
    await this.runFacilitator();
  }

  private async maybeFacilitate(): Promise<void> {
    if (this.record.round.status !== 'collecting' || this.facilitating) return;
    const connected = this.connectedParticipants();
    if (connected.length === 0) return;
    if (!connected.every((p) => p.status === 'contributed' || p.status === 'passed')) return;
    if (this.record.round.id > SESSION_LIMITS.maxRounds) {
      this.broadcastError('session_cap', 'This session has reached its round limit.');
      return;
    }
    if (!this.openAiBudgetOk()) {
      this.failRound('session_cap', 'This session has reached its facilitator limit.');
      return;
    }
    this.facilitating = true;
    if (!(await this.consumeGlobalOpenAiAttempt())) {
      this.facilitating = false;
      this.failRound('rate_limited', GLOBAL_OPENAI_CAP_MESSAGE);
      return;
    }
    this.record.round.status = 'thinking';
    this.saveRecord();
    this.broadcast({ type: 'round', round: this.record.round });
    await this.runFacilitator();
  }

  private async runFacilitator(): Promise<void> {
    try {
      if (!this.openAiBudgetOk()) {
        this.failRound('session_cap', 'This session has reached its facilitator limit.');
        return;
      }
      this.recordOpenAiAttempt();

      const roundLines = Object.entries(this.record.participants)
        .filter(([, p]) => p.status === 'contributed' || p.status === 'passed')
        .map(([clientId, p]) => ({
          displayName: p.displayName,
          text: p.text ?? '',
          passed: p.status === 'passed',
          clientId,
        }));
      const connectedIds = new Set(this.connectedParticipants().map((p) => p.clientId));
      const activeLines = roundLines.filter((line) => connectedIds.has(line.clientId));
      const priorFacilitator = this.record.messages
        .filter((m) => m.kind === 'facilitator')
        .map((m) => m.text);

      const result = await completeFacilitator({
        apiKey: this.env.OPENAI_API_KEY,
        model: this.env.OPENAI_MODEL,
        board: this.record.board,
        roundLines: activeLines.length ? activeLines : roundLines,
        priorFacilitator,
      });

      if (this.record.round.status !== 'thinking') return;

      if (!result.ok) {
        this.failRound('facilitator_failed', 'The facilitator could not reply. Send retry to try again.');
        return;
      }

      const message = this.makeMessage('facilitator', FACILITATOR_AUTHOR.displayName, FACILITATOR_AUTHOR.clientId, result.text);
      this.pushMessage(message);
      this.record.round = { id: this.record.round.id + 1, status: 'collecting' };
      for (const participant of Object.values(this.record.participants)) {
        participant.status = 'pending';
        delete participant.text;
        delete participant.mood;
      }
      this.saveRecord();
      this.broadcast({ type: 'message', message });
      this.broadcast({ type: 'round', round: this.record.round });
      this.broadcast({ type: 'presence', participants: this.connectedParticipants() });
    } finally {
      this.facilitating = false;
    }
  }

  private connectedParticipants(): Participant[] {
    const seen = new Set<string>();
    const out: Participant[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const att = this.attachment(ws);
      if (!att.joined || !att.clientId || seen.has(att.clientId)) continue;
      seen.add(att.clientId);
      const stored = this.record.participants[att.clientId];
      out.push({
        clientId: att.clientId,
        displayName: att.displayName ?? stored?.displayName ?? 'Anonymous',
        status: stored?.status ?? 'pending',
      });
    }
    return out;
  }

  private roomId(): string {
    return this.ctx.id.name ?? 'unknown';
  }

  private attachment(ws: WebSocket): Attachment {
    return (ws.deserializeAttachment() as Attachment | null) ?? {};
  }

  private unjoinedCount(): number {
    let n = 0;
    for (const ws of this.ctx.getWebSockets()) {
      if (!this.attachment(ws).joined) n += 1;
    }
    return n;
  }

  private openAiAttemptsInWindow(now = Date.now()): number[] {
    return (this.record.openAiCalls ?? []).filter((t) => now - t < SESSION_LIMITS.openAiCallWindowMs);
  }

  private openAiBudgetOk(): boolean {
    return this.openAiAttemptsInWindow().length < SESSION_LIMITS.maxOpenAiCallsPerWindow;
  }

  private async consumeGlobalOpenAiAttempt(): Promise<boolean> {
    try {
      return await this.env.GLOBAL_LIMITER.getByName(GLOBAL_LIMITER_INSTANCE).tryConsume();
    } catch {
      return false;
    }
  }

  private recordOpenAiAttempt(): void {
    const now = Date.now();
    this.record.openAiCalls = this.openAiAttemptsInWindow(now);
    this.record.openAiCalls.push(now);
    this.saveRecord();
  }

  private failRound(code: ServerErrorCode, message: string): void {
    this.record.round.status = 'failed';
    this.saveRecord();
    this.broadcastError(code, message);
    this.broadcast({ type: 'round', round: this.record.round });
  }

  private rateOk(ws: WebSocket): boolean {
    const att = this.attachment(ws);
    const now = Date.now();
    const times = (att.times ?? []).filter((t) => now - t < SESSION_LIMITS.clientMessageWindowMs);
    if (times.length >= SESSION_LIMITS.maxClientMessagesPerWindow) {
      ws.serializeAttachment({ ...att, times });
      return false;
    }
    times.push(now);
    ws.serializeAttachment({ ...att, times });
    return true;
  }

  private makeMessage(
    kind: ChatMessage['kind'],
    displayName: string,
    clientId: string,
    text: string,
    mood?: Mood
  ): ChatMessage {
    const message: ChatMessage = {
      id: crypto.randomUUID(),
      at: Date.now(),
      kind,
      author: { clientId, displayName },
      text,
    };
    if (mood) message.mood = mood;
    return message;
  }

  private pushMessage(message: ChatMessage): void {
    this.record.messages.push(message);
    if (this.record.messages.length > SESSION_LIMITS.maxMessages) {
      this.record.messages.splice(0, this.record.messages.length - SESSION_LIMITS.maxMessages);
    }
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // socket gone
    }
  }

  private broadcast(msg: ServerMessage): void {
    for (const ws of this.ctx.getWebSockets()) {
      if (this.attachment(ws).joined) this.send(ws, msg);
    }
  }

  private sendError(ws: WebSocket, code: ServerErrorCode, message: string): void {
    this.send(ws, { type: 'error', code, message });
  }

  private broadcastError(code: ServerErrorCode, message: string): void {
    this.broadcast({ type: 'error', code, message });
  }

  private ensureTable(): void {
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS room (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)'
    );
  }

  private loadRecord(): RoomRecord {
    this.ensureTable();
    const row = this.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM room WHERE id = ?', ROOM_ROW_ID).toArray()[0];
    if (!row?.data) return emptyRecord();
    try {
      const parsed = JSON.parse(row.data) as RoomRecord;
      if (!parsed?.round || !parsed.participants || !Array.isArray(parsed.messages)) return emptyRecord();
      return {
        round: parsed.round,
        participants: parsed.participants,
        messages: parsed.messages,
        board: Array.isArray(parsed.board) ? parsed.board : [],
        openAiCalls: Array.isArray(parsed.openAiCalls)
          ? parsed.openAiCalls.filter((t) => typeof t === 'number' && Number.isFinite(t))
          : [],
      };
    } catch {
      return emptyRecord();
    }
  }

  private saveRecord(): void {
    this.ensureTable();
    this.ctx.storage.sql.exec(
      'INSERT INTO room (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data',
      ROOM_ROW_ID,
      JSON.stringify(this.record)
    );
  }
}
