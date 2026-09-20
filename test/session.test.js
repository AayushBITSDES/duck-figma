/*
 * Runs against the COMPILED output in .test-build, not a reimplementation.
 *
 * Exercises ui/session.js: it must not dial the Worker until the plugin
 * posts session identity, then join, apply server frames, and send round
 * actions with a fresh board snapshot. A FakeWebSocket stands in for the
 * network so these never leave the process.
 */
const path = require('path');
const { check } = require('./lib/check');
const { BUILD, clearBuildCache, clearPendingTimers } = require('./lib/fresh');
const dom = require('./lib/dom');
const ws = require('./lib/ws');

function boot() {
  clearPendingTimers();
  ws.reset();
  dom.posted.length = 0;
  clearBuildCache();
  // screens first so the session <-> bridge <-> screens cycle finishes
  // exporting before anyone calls into it.
  require(path.join(BUILD, 'ui', 'screens'));
  const session = require(path.join(BUILD, 'ui', 'session'));
  const { state } = require(path.join(BUILD, 'ui', 'state'));
  return { session, state };
}

function deliver(msg) {
  global.window.onmessage({ data: { pluginMessage: msg } });
}

function identity(over) {
  return Object.assign({
    type: 'session',
    roomId: 'file:abc',
    clientId: 'client-1',
    displayName: 'Ada Lovelace',
  }, over || {});
}

function snapshot(over) {
  return Object.assign({
    type: 'snapshot',
    roomId: 'file:abc',
    you: { clientId: 'client-1' },
    participants: [{ clientId: 'client-1', displayName: 'Ada Lovelace', status: 'pending' }],
    messages: [],
    round: { id: 1, status: 'collecting' },
  }, over || {});
}

async function flushBoard(board) {
  deliver({ type: 'board-context', board: board || [] });
  await Promise.resolve();
}

module.exports = async function run() {
  dom.install();
  ws.install();

  // --- waits for session identity -------------------------------------------
  let b = boot();
  check('no socket before the plugin posts identity', ws.instances().length, 0);
  check('and the client has not joined', b.state.ws, 'off');

  deliver(identity());
  check('identity opens the room socket', ws.instances().length, 1);
  check('against this file\'s room', ws.last().url,
    b.session.PRODUCTION_WS_ORIGIN + '/room?roomId=' + encodeURIComponent('file:abc'));
  check('and asks for a board snapshot',
    dom.posted.filter((m) => m.type === 'get-board').length > 0, true);
  check('join is withheld until the socket is live', ws.last().sent.length, 0);

  ws.last().open();
  check('an open socket sends join with the posted identity', ws.last().sent[0], {
    type: 'join',
    clientId: 'client-1',
    displayName: 'Ada Lovelace',
  });
  check('and reports itself live', b.state.ws, 'live');

  // --- snapshots, presence, messages, rounds --------------------------------
  ws.last().incoming(snapshot({
    messages: [{
      id: 'm1', at: 1, kind: 'system',
      author: { clientId: 'sys', displayName: 'Duck' },
      text: 'Ada Lovelace joined',
    }],
  }));
  check('a snapshot marks the session ready', b.state.gotSnapshot, true);
  check('and takes participants from the server', b.state.participants.length, 1);
  check('and the opening round', b.state.round, { id: 1, status: 'collecting' });
  check('and the backlog', b.state.messages[0].text, 'Ada Lovelace joined');

  ws.last().incoming({
    type: 'presence',
    participants: [
      { clientId: 'client-1', displayName: 'Ada Lovelace', status: 'pending' },
      { clientId: 'client-2', displayName: 'Grace', status: 'contributed' },
    ],
  });
  check('presence replaces the roster', b.state.participants.map((p) => p.displayName), ['Ada Lovelace', 'Grace']);

  ws.last().incoming({
    type: 'message',
    message: {
      id: 'm2', at: 2, kind: 'facilitator',
      author: { clientId: 'duck', displayName: 'Duck' },
      text: 'Try grouping — then the copy',
    },
  });
  check('facilitator text is dash-normalized on the way in',
    b.state.messages[b.state.messages.length - 1].text, 'Try grouping - then the copy');

  ws.last().incoming({ type: 'round', round: { id: 1, status: 'thinking' } });
  check('a round frame updates status', b.state.round.status, 'thinking');

  ws.last().incoming({ type: 'round', round: { id: 1, status: 'failed' } });
  check('a failed round surfaces a retry banner',
    [b.state.banner && b.state.banner.code, /could not reply/.test((b.state.banner && b.state.banner.text) || '')],
    ['facilitator_failed', true]);

  ws.last().incoming({
    type: 'error',
    code: 'session_cap',
    message: 'This session has reached its facilitator limit.',
  });
  ws.last().incoming({ type: 'round', round: { id: 1, status: 'failed' } });
  check('a failed round after a cap keeps the cap banner',
    [b.state.banner && b.state.banner.code, b.state.banner && b.state.banner.text],
    ['session_cap', 'This session has reached its facilitator limit.']);

  ws.last().incoming({
    type: 'error',
    code: 'rate_limited',
    message: 'The facilitator is at its demo limit. Try again later.',
  });
  ws.last().incoming({ type: 'round', round: { id: 1, status: 'failed' } });
  check('a failed round after a global cap keeps that banner',
    [b.state.banner && b.state.banner.code, b.state.banner && b.state.banner.text],
    ['rate_limited', 'The facilitator is at its demo limit. Try again later.']);

  ws.last().incoming({ type: 'pong' });
  check('pong is ignored', b.state.round.status, 'failed');

  ws.last().incoming('not-json');
  check('a garbage frame is ignored', b.state.round.status, 'failed');

  // --- mood / contribution / pass send the clipped board --------------------
  b = boot();
  deliver(identity());
  ws.last().open();
  ws.last().incoming(snapshot());

  let pending = b.session.actSetState('stuck');
  check('choosing a mood asks for a fresh board first',
    dom.posted.filter((m) => m.type === 'get-board').pop().type, 'get-board');
  await flushBoard(['nav | search', 'onboarding copy']);
  await pending;
  check('set-state carries mood, round, and board',
    ws.last().sent.filter((m) => m.type === 'set-state').pop(), {
      type: 'set-state',
      roundId: 1,
      mood: 'stuck',
      board: ['nav | search', 'onboarding copy'],
    });
  check('and counts as this client\'s action for the round', b.state.actedRoundId, 1);

  b = boot();
  deliver(identity());
  ws.last().open();
  ws.last().incoming(snapshot());
  await flushBoard(['already here']);
  const asked = dom.posted.filter((m) => m.type === 'get-board').length;
  pending = b.session.actSetState('stuck');
  check('a later check-in asks for the board again',
    dom.posted.filter((m) => m.type === 'get-board').length, asked + 1);
  await flushBoard(['changed on the page']);
  await pending;
  check('and the action carries the latest snapshot',
    ws.last().sent.filter((m) => m.type === 'set-state').pop().board, ['changed on the page']);

  pending = b.session.actContribute('a second thought');
  await flushBoard([]);
  await pending;
  check('a second action in the same round is ignored',
    ws.last().sent.filter((m) => m.type === 'contribute').length, 0);

  b = boot();
  deliver(identity());
  ws.last().open();
  ws.last().incoming(snapshot({ round: { id: 2, status: 'collecting' } }));

  const beforeBlank = ws.last().sent.length;
  const blank = await b.session.actContribute('   ');
  check('a blank contribution is not sent', ws.last().sent.length, beforeBlank);
  check('and reports no delivery', blank, false);

  b.state.draft = '  hello from the board  ';
  pending = b.session.actContribute('  hello from the board  ');
  await flushBoard(['x'.repeat(250)].concat(Array.from({ length: 45 }, (_, i) => 'item-' + i)));
  const delivered = await pending;
  const contrib = ws.last().sent.filter((m) => m.type === 'contribute').pop();
  check('contribute trims text', contrib.text, 'hello from the board');
  check('and clips the board to 40 x 200',
    [contrib.board.length, contrib.board[0].length, contrib.roundId], [40, 200, 2]);
  check('and reports delivery success', delivered, true);
  check('and clears the draft after a successful send', b.state.draft, '');

  // Socket drop while waiting for the board must not swallow the draft.
  b = boot();
  deliver(identity());
  ws.last().open();
  ws.last().incoming(snapshot({ round: { id: 2, status: 'collecting' } }));
  b.state.draft = 'keep me';
  const dropSock = ws.last();
  pending = b.session.actContribute('keep me');
  dropSock.close();
  await flushBoard([]);
  const dropped = await pending;
  check('socket loss during board wait does not deliver', dropped, false);
  check('and does not send contribute',
    dropSock.sent.filter((m) => m.type === 'contribute').length, 0);
  check('and does not count the round as acted', b.state.actedRoundId, null);
  check('and keeps the contribution draft', b.state.draft, 'keep me');
  check('and flags reconnecting', b.state.ws, 'reconnecting');
  check('and surfaces a send-failed banner',
    !!(b.state.banner && /Could not send/.test(b.state.banner.text)), true);

  b = boot();
  deliver(identity());
  ws.last().open();
  ws.last().incoming(snapshot({ round: { id: 3, status: 'collecting' } }));
  pending = b.session.actPass();
  await flushBoard(['keep me']);
  await pending;
  check('pass carries the board and round',
    ws.last().sent.filter((m) => m.type === 'pass').pop(), {
      type: 'pass',
      roundId: 3,
      board: ['keep me'],
    });

  b = boot();
  deliver(identity());
  ws.last().open();
  ws.last().incoming(snapshot({ round: { id: 4, status: 'failed' } }));
  b.session.actRetry();
  check('retry is sent for a failed round',
    ws.last().sent.filter((m) => m.type === 'retry').pop(), { type: 'retry', roundId: 4 });

  b = boot();
  deliver(identity());
  ws.last().open();
  ws.last().incoming(snapshot({ round: { id: 4, status: 'collecting' } }));
  const beforeRetry = ws.last().sent.length;
  b.session.actRetry();
  check('retry is ignored unless the round failed', ws.last().sent.length, beforeRetry);

  // --- reconnect and hard failure -------------------------------------------
  b = boot();
  deliver(identity());
  const first = ws.last();
  first.open();
  first.incoming(snapshot());
  first.close();
  check('a drop flags reconnecting', b.state.ws, 'reconnecting');
  await new Promise((r) => setTimeout(r, 550));
  check('and opens a new socket after the backoff', ws.instances().length, 2);
  ws.last().open();
  check('the replacement socket rejoins', ws.last().sent[0], {
    type: 'join',
    clientId: 'client-1',
    displayName: 'Ada Lovelace',
  });

  b = boot();
  deliver(identity());
  ws.last().open();
  ws.last().incoming({ type: 'error', code: 'room_full', message: 'This room is full.' });
  check('room_full hangs up', b.state.ws, 'off');
  check('and shows the server\'s message', b.state.banner && b.state.banner.code, 'room_full');
  // room_full answers the very first join, so this halt always lands before
  // a snapshot, on the connecting screen, which has no footer to put the
  // control in. It has to carry its own copy or the user is simply stuck.
  check('and offers Reconnect on the pre-snapshot screen',
    dom.el('root').innerHTML.indexOf('id="reconnect"') > -1, true);
  const hung = ws.instances().length;
  await new Promise((r) => setTimeout(r, 550));
  check('and does not reconnect', ws.instances().length, hung);

  // The room hangs up the older socket when the same clientId joins again
  // (two windows on one machine share a clientId). Reconnecting into that
  // would kick the other window, which would kick this one back, forever.
  b = boot();
  deliver(identity());
  ws.last().open();
  ws.last().incoming(snapshot());
  const beforeReplaced = ws.instances().length;
  ws.last().close(1000, 'replaced');
  check('a replaced socket hangs up instead of reconnecting', b.state.ws, 'off');
  check('and says which window is at fault',
    b.state.banner && b.state.banner.text.indexOf('another window') > -1, true);
  check('and offers the user a way back', b.state.banner && b.state.banner.action, 'reconnect');
  await new Promise((r) => setTimeout(r, 550));
  check('no socket is opened behind the user', ws.instances().length, beforeReplaced);
  b.session.reconnectSession();
  check('the Reconnect control opens a socket', ws.instances().length, beforeReplaced + 1);
  check('and clears the banner', b.state.banner, null);

  // An ordinary drop still reconnects on its own: only the reason above is
  // special-cased.
  b = boot();
  deliver(identity());
  ws.last().open();
  ws.last().incoming(snapshot());
  ws.last().close(1006, '');
  check('an abnormal close still reconnects', b.state.ws, 'reconnecting');

  // A socket that opens and dies without ever delivering a snapshot is a
  // failure however healthy the handshake looked, so the backoff has to keep
  // growing across those attempts instead of resetting on every open.
  b = boot();
  deliver(identity());
  ws.last().open();
  ws.last().close(1006, '');
  await new Promise((r) => setTimeout(r, 550));
  check('a snapshotless open still schedules the next attempt', ws.instances().length, 2);
  ws.last().open();
  ws.last().close(1006, '');
  const afterSecond = ws.instances().length;
  await new Promise((r) => setTimeout(r, 550));
  check('and the backoff has grown past the first step', ws.instances().length, afterSecond);
  await new Promise((r) => setTimeout(r, 600));
  check('so the third attempt lands on the longer wait', ws.instances().length, afterSecond + 1);

  b = boot();
  const RealWS = global.WebSocket;
  global.WebSocket = function () { throw new Error('refused'); };
  global.WebSocket.OPEN = 1;
  deliver(identity());
  check('a constructor failure schedules reconnect', b.state.ws, 'reconnecting');
  global.WebSocket = RealWS;
  await new Promise((r) => setTimeout(r, 550));
  check('and a later attempt constructs for real', ws.instances().length >= 1, true);

  b = boot();
  deliver(identity({ displayName: 'A'.repeat(80) }));
  ws.last().open();
  check('join clips an overlong display name', ws.last().sent[0].displayName.length, 40);

  b = boot();
  deliver(identity({ displayName: '   ' }));
  ws.last().open();
  check('a blank name joins as Anonymous', ws.last().sent[0].displayName, 'Anonymous');

  b = boot();
  deliver(identity());
  ws.last().open();
  const pagehide = dom.windowListeners.filter((l) => l.type === 'pagehide');
  check('the client listens for pagehide', pagehide.length >= 1, true);
  pagehide[pagehide.length - 1].fn();
  check('pagehide disconnects the socket', b.state.ws, 'off');

  check('the hosted origin is the one the manifest allows',
    b.session.PRODUCTION_WS_ORIGIN, 'wss://duck-facilitator.aayushkggn.workers.dev');
  check('local worker is an explicit flag, off by default', b.session.USE_LOCAL_WORKER, false);
  check('roomSocketUrl encodes the room id',
    b.session.roomSocketUrl('file:a/b'),
    b.session.PRODUCTION_WS_ORIGIN + '/room?roomId=' + encodeURIComponent('file:a/b'));
  check('and that encoded url uses the production origin',
    b.session.roomSocketUrl('file:a/b').indexOf('wss://duck-facilitator.aayushkggn.workers.dev/') === 0, true);
};
