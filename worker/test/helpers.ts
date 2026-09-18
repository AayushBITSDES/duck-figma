import type { ChatMessage, ClientMessage, ServerMessage } from '../../src/shared/protocol';
import { exports } from 'cloudflare:workers';

export function roomId(label: string): string {
  return 'file:' + label + '-' + crypto.randomUUID();
}

export async function openSocket(
  id: string,
  origin: string | null = 'null'
): Promise<{ response: Response; ws: WebSocket | null }> {
  const headers = new Headers({ Upgrade: 'websocket' });
  if (origin !== null) headers.set('Origin', origin);
  const response = await exports.default.fetch(
    new Request('https://example.com/room?roomId=' + encodeURIComponent(id), { headers })
  );
  const ws = response.webSocket ?? null;
  if (ws) ws.accept();
  return { response, ws };
}

export class TestClient {
  readonly log: ServerMessage[] = [];
  private queue: ServerMessage[] = [];
  private waiters: Array<(msg: ServerMessage) => void> = [];

  constructor(readonly ws: WebSocket) {
    ws.addEventListener('message', (event) => {
      const raw = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data);
      const msg = JSON.parse(raw) as ServerMessage;
      this.log.push(msg);
      const waiter = this.waiters.shift();
      if (waiter) waiter(msg);
      else this.queue.push(msg);
    });
  }

  send(msg: ClientMessage): void {
    this.ws.send(JSON.stringify(msg));
  }

  async next(timeoutMs = 5000): Promise<ServerMessage> {
    if (this.queue.length) return this.queue.shift()!;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for WebSocket message')), timeoutMs);
      this.waiters.push((msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });
  }

  async until(type: ServerMessage['type'], timeoutMs = 5000): Promise<ServerMessage> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const msg = await this.next(Math.max(1, deadline - Date.now()));
      if (msg.type === type) return msg;
    }
    throw new Error('Timed out waiting for ' + type);
  }

  async untilMessageKind(kind: ChatMessage['kind'], timeoutMs = 8000): Promise<ChatMessage> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const msg = await this.next(Math.max(1, deadline - Date.now()));
      if (msg.type === 'message' && msg.message.kind === kind) return msg.message;
    }
    throw new Error('Timed out waiting for message kind ' + kind);
  }
}

export async function joinClient(id: string, clientId: string, displayName: string): Promise<TestClient> {
  const { response, ws } = await openSocket(id);
  if (response.status !== 101 || !ws) {
    throw new Error('Expected WebSocket upgrade, got ' + response.status);
  }
  const client = new TestClient(ws);
  client.send({ type: 'join', clientId, displayName });
  await client.until('snapshot');
  await client.until('presence');
  return client;
}

let clientSeq = 0;
export function clientId(prefix = 'person'): string {
  clientSeq += 1;
  return (prefix + '-' + String(clientSeq).padStart(6, '0')).slice(0, 64);
}
