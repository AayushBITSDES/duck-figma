/*
 * A fake Worker for the shipped UI bundle. The iframe never talks to a
 * model host; it opens one WebSocket per FigJam room. jsdom has no socket,
 * and these tests must not hit the network, so this stands in for the
 * Durable Object: join, presence, round actions, and a canned facilitator
 * reply once everyone connected has acted.
 *
 * Two JSDOM windows that share one hub see the same participants and
 * messages, which is the thing the demo has to prove.
 */
const { URL } = require('url');

function roomIdFromUrl(url) {
  try {
    const parsed = new URL(String(url), 'wss://example.test');
    return parsed.searchParams.get('roomId') || '';
  } catch (_) {
    const match = /roomId=([^&]+)/.exec(String(url));
    return match ? decodeURIComponent(match[1]) : '';
  }
}

function createHub(opts) {
  const sockets = [];
  const rooms = new Map();
  let msgSeq = 0;
  let facilitatorReply = (opts && opts.facilitatorReply) || 'The duck heard the group.';

  function room(id) {
    if (!rooms.has(id)) {
      rooms.set(id, {
        id,
        sockets: [],
        people: new Map(),
        messages: [],
        round: { id: 1, status: 'collecting' },
      });
    }
    return rooms.get(id);
  }

  function connected(r) {
    const seen = new Set();
    const out = [];
    for (const sock of r.sockets) {
      if (sock.readyState !== FakeWebSocket.OPEN || !sock.joined || !sock.clientId) continue;
      if (seen.has(sock.clientId)) continue;
      seen.add(sock.clientId);
      const stored = r.people.get(sock.clientId);
      out.push({
        clientId: sock.clientId,
        displayName: (stored && stored.displayName) || sock.displayName || 'Anonymous',
        status: (stored && stored.status) || 'pending',
      });
    }
    return out;
  }

  function broadcast(r, frame, except) {
    const payload = JSON.stringify(frame);
    for (const sock of r.sockets) {
      if (sock === except) continue;
      if (sock.readyState !== FakeWebSocket.OPEN) continue;
      sock._push(payload);
    }
  }

  function sendTo(sock, frame) {
    sock._push(JSON.stringify(frame));
  }

  function makeMessage(kind, author, text, mood) {
    return {
      id: 'm' + (++msgSeq),
      at: Date.now(),
      kind,
      author: {
        clientId: author.clientId,
        displayName: author.displayName,
      },
      text,
      mood,
    };
  }

  function maybeFacilitate(r) {
    if (r.round.status !== 'collecting') return;
    const people = connected(r);
    if (!people.length) return;
    if (!people.every((p) => p.status === 'contributed' || p.status === 'passed')) return;
    r.round = { id: r.round.id, status: 'thinking' };
    broadcast(r, { type: 'round', round: r.round });
    const message = makeMessage(
      'facilitator',
      { clientId: 'facilitator', displayName: 'Duck' },
      facilitatorReply
    );
    r.messages.push(message);
    r.round = { id: r.round.id + 1, status: 'collecting' };
    for (const stored of r.people.values()) {
      stored.status = 'pending';
      delete stored.mood;
    }
    broadcast(r, { type: 'message', message });
    broadcast(r, { type: 'round', round: r.round });
    broadcast(r, { type: 'presence', participants: connected(r) });
  }

  function handle(sock, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (_) {
      return;
    }
    if (!msg || !msg.type) return;
    const r = sock.room;
    if (!r) return;

    if (msg.type === 'join') {
      sock.clientId = msg.clientId;
      sock.displayName = msg.displayName || 'Anonymous';
      sock.joined = true;
      const existing = r.people.get(sock.clientId);
      r.people.set(sock.clientId, {
        displayName: sock.displayName,
        status: (existing && existing.status) || 'pending',
        mood: existing && existing.mood,
      });
      sendTo(sock, {
        type: 'snapshot',
        roomId: r.id,
        you: { clientId: sock.clientId },
        participants: connected(r),
        messages: r.messages.slice(),
        round: r.round,
      });
      broadcast(r, { type: 'presence', participants: connected(r) });
      return;
    }

    if (!sock.joined) return;
    if (msg.type === 'ping') {
      sendTo(sock, { type: 'pong' });
      return;
    }
    if (msg.type === 'retry') {
      if (r.round.status !== 'failed') return;
      maybeFacilitate(r);
      return;
    }
    if (msg.type !== 'set-state' && msg.type !== 'contribute' && msg.type !== 'pass') return;
    if (r.round.status !== 'collecting') return;
    if (msg.roundId !== r.round.id) return;

    const stored = r.people.get(sock.clientId) || {
      displayName: sock.displayName || 'Anonymous',
      status: 'pending',
    };
    if (stored.status !== 'pending') return;

    const name = stored.displayName;
    let chat;
    if (msg.type === 'set-state') {
      const labels = {
        stuck: 'Stuck',
        frustrated: 'Frustrated',
        thinking: 'Thinking',
        fine: 'Fine, just slow',
      };
      stored.status = 'contributed';
      stored.mood = msg.mood;
      chat = makeMessage(
        'state',
        { clientId: sock.clientId, displayName: name },
        name + ' is feeling ' + (labels[msg.mood] || msg.mood) + '.',
        msg.mood
      );
    } else if (msg.type === 'contribute') {
      stored.status = 'contributed';
      chat = makeMessage(
        'contribution',
        { clientId: sock.clientId, displayName: name },
        msg.text || ''
      );
    } else {
      stored.status = 'passed';
      chat = makeMessage(
        'pass',
        { clientId: sock.clientId, displayName: name },
        name + ' passed.'
      );
    }
    r.people.set(sock.clientId, stored);
    r.messages.push(chat);
    broadcast(r, { type: 'message', message: chat });
    broadcast(r, { type: 'presence', participants: connected(r) });
    maybeFacilitate(r);
  }

  function FakeWebSocket(url) {
    if (!(this instanceof FakeWebSocket)) return new FakeWebSocket(url);
    this.url = String(url);
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    this.joined = false;
    this.clientId = '';
    this.displayName = '';
    this.room = room(roomIdFromUrl(url));
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    sockets.push(this);
    this.room.sockets.push(this);
    const self = this;
    setTimeout(() => {
      if (self.readyState !== FakeWebSocket.CONNECTING) return;
      self.readyState = FakeWebSocket.OPEN;
      if (self.onopen) self.onopen();
    }, 0);
  }

  FakeWebSocket.CONNECTING = 0;
  FakeWebSocket.OPEN = 1;
  FakeWebSocket.CLOSING = 2;
  FakeWebSocket.CLOSED = 3;

  FakeWebSocket.prototype.send = function (data) {
    this.sent.push(data);
    handle(this, data);
  };

  FakeWebSocket.prototype.close = function () {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    const r = this.room;
    if (r) r.sockets = r.sockets.filter((s) => s !== this);
    const fn = this.onclose;
    this.onclose = null;
    if (fn) fn({ code: 1000, reason: '', wasClean: true });
    if (r) broadcast(r, { type: 'presence', participants: connected(r) });
  };

  FakeWebSocket.prototype._push = function (payload) {
    if (this.readyState !== FakeWebSocket.OPEN) return;
    if (this.onmessage) this.onmessage({ data: payload });
  };

  FakeWebSocket.prototype.deliver = function (frame) {
    this._push(typeof frame === 'string' ? frame : JSON.stringify(frame));
  };

  return {
    WebSocket: FakeWebSocket,
    sockets,
    rooms,
    get facilitatorReply() { return facilitatorReply; },
    set facilitatorReply(text) { facilitatorReply = text; },
    install(win) {
      win.WebSocket = FakeWebSocket;
    },
    connected(roomId) {
      return connected(room(roomId));
    },
    lastSocket() {
      return sockets[sockets.length - 1] || null;
    },
    socketsFor(roomId) {
      return room(roomId).sockets.slice();
    },
  };
}

module.exports = { createHub, roomIdFromUrl };
