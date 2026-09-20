/*
 * In-process WebSocket stand-in for ui/session.ts. Node's real WebSocket
 * would try to dial the Worker; this records constructors, outbound frames,
 * and lets a test inject server frames and drops.
 */
class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    FakeWebSocket.instances.push(this);
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  // The real close event carries a code and a reason, and session.ts reads
  // the reason to tell a takeover from a drop.
  close(code, reason) {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    if (this.onclose) this.onclose({ code: code === undefined ? 1000 : code, reason: reason || '' });
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    if (this.onopen) this.onopen();
  }

  incoming(msg) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(msg) });
  }
}

function reset() {
  FakeWebSocket.instances.forEach((socket) => {
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
  });
  FakeWebSocket.instances = [];
}

function install() {
  reset();
  global.WebSocket = FakeWebSocket;
}

function last() {
  return FakeWebSocket.instances[FakeWebSocket.instances.length - 1] || null;
}

function instances() {
  return FakeWebSocket.instances;
}

module.exports = { FakeWebSocket, install, reset, last, instances };
