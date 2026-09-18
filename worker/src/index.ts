import { corsPreflight, json, originAllowed, text } from './cors';
import { GlobalLimiter } from './limiter';
import { ROOM_ID_RE } from './parse';
import { Room } from './room';

export { GlobalLimiter, Room };

function roomStub(env: Env, roomId: string): DurableObjectStub<Room> {
  return env.ROOM.getByName(roomId);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') return corsPreflight();

    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ ok: true });
    }

    if (url.pathname === '/room') {
      const roomId = url.searchParams.get('roomId') ?? '';
      if (!ROOM_ID_RE.test(roomId)) {
        return json({ error: 'bad_request', message: 'Invalid roomId' }, 400);
      }
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
        return text('Expected WebSocket', 426);
      }
      if (!originAllowed(request)) {
        return text('Forbidden', 403);
      }
      return roomStub(env, roomId).fetch(request);
    }

    return text('Not found', 404);
  },
} satisfies ExportedHandler<Env>;
