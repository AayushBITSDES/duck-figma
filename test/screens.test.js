/*
 * Runs against the COMPILED output in .test-build, not a reimplementation, so
 * these break when the real code drifts.
 *
 * Exercises screens.js and bridge.js, the modules that actually touch the DOM
 * (through render.js) and the postMessage bridge. Each scenario below boots a
 * fresh copy of that module graph (see lib/fresh.js), the CommonJS stand-in
 * for what `new Function(source)()` gave for free before the split.
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
  const stateMod = require(path.join(BUILD, 'ui', 'state'));
  const screens = require(path.join(BUILD, 'ui', 'screens'));
  screens.showConnecting(); // mirrors what the real ui.ts entry point does at boot
  return {
    state: stateMod.state,
    openSettings: screens.openSettings,
    showConnecting: screens.showConnecting,
    showSession: screens.showSession,
    deliver: (m) => global.window.onmessage({ data: { pluginMessage: m } }),
  };
}

function html() {
  return dom.el('root').innerHTML;
}

// A real reconnect: the socket drops, the backoff timer opens a new one, and
// the snapshot arrives on that. Sending a second snapshot down the same socket
// is what a reset looks like instead.
async function reconnect() {
  ws.last().close(1006, '');
  await new Promise((r) => setTimeout(r, 550));
  const sock = ws.last();
  sock.open();
  return sock;
}

function live(b, extra) {
  b.deliver({ type: 'session', roomId: 'file:abc', clientId: 'client-1', displayName: 'Ada' });
  const sock = ws.last();
  sock.open();
  sock.incoming(Object.assign({
    type: 'snapshot',
    roomId: 'file:abc',
    session: 's1',
    you: { clientId: 'client-1' },
    participants: [{ clientId: 'client-1', displayName: 'Ada', status: 'pending' }],
    messages: [],
    round: { id: 1, status: 'collecting' },
  }, extra || {}));
  return sock;
}

module.exports = async function run() {
  dom.install();
  ws.install();
  const el = dom.el;

  // --- Boot paints an explicit connecting session, not an idle duck ---------
  const start = boot();
  check('boot reports connecting, not idle', start.state.mode, 'connecting');
  check('and says it is joining this board\'s session',
    html().indexOf('Joining this board') > -1, true);

  // --- Settings is text size only ------------------------------------------
  const set = boot();
  set.openSettings();
  const setHtml = html();
  check('settings offers text size', setHtml.indexOf('id="text-size"') > -1, true);
  check('and no provider, key, or save controls',
    [setHtml.indexOf('id="provider"') > -1, setHtml.indexOf('id="key-input"') > -1, setHtml.indexOf('id="save"') > -1],
    [false, false, false]);
  check('opening settings reports settings',
    dom.posted.filter((m) => m.type === 'mode').pop(), { type: 'mode', mode: 'settings' });

  el('text-size').value = '14';
  dom.posted.length = 0;
  el('text-size').onchange();
  check('changing text size posts it to the plugin',
    dom.posted.filter((m) => m.type === 'text-size').pop(), { type: 'text-size', size: 14 });

  el('back').onclick();
  check('Back from settings returns to connecting when no snapshot has landed',
    set.state.mode, 'connecting');

  const sized = boot();
  sized.deliver({ type: 'window', width: 280, height: 380, minimized: false, textSize: 16 });
  sized.openSettings();
  check('settings show the saved text size', el('text-size').value, '16');

  // --- Explicit session UI --------------------------------------------------
  const session = boot();
  live(session);
  check('a snapshot paints the session screen', session.state.mode, 'session');
  check('round one offers the four mood buttons',
    ['mood-stuck', 'mood-frustrated', 'mood-thinking', 'mood-fine']
      .every((id) => html().indexOf('id="' + id + '"') > -1), true);
  check('and names this participant', html().indexOf('Ada (you)') > -1, true);
  check('entering the session reports session',
    dom.posted.filter((m) => m.type === 'mode').pop(), { type: 'mode', mode: 'session' });

  // The board request between a click and the socket send is a real wait, and
  // withBoard drops anything clicked inside it. The composer has to say so.
  const busy = boot();
  live(busy);
  el('mood-stuck').onclick();
  check('a mood click disables the moods while the board is being read',
    /id="mood-frustrated"[^>]*\sdisabled/.test(html()), true);
  busy.deliver({ type: 'board-context', board: ['a sticky'] });
  await Promise.resolve();
  await Promise.resolve();
  check('and the state reaches the room once it comes back',
    ws.last().sent.filter((m) => m.type === 'set-state').length, 1);

  // The header status is where "your turn" and "thinking" are said now, so it
  // has to be the live region a screen reader listens to.
  check('the round and its demand are one live region',
    /class="hdr-status" aria-live="polite" aria-atomic="true">[\s\S]*?id="hdr-title"[\s\S]*?id="hdr-sub"/.test(html()), true);

  // The first facilitator line can arrive with no change to the composer's
  // kind. The summary link has to come on anyway, not wait for the next
  // round frame to repaint it.
  const spoke = boot();
  const spokeSock = live(spoke, { round: { id: 2, status: 'collecting' } });
  check('before the duck speaks, summary is off', /id="summary"[^>]*\sdisabled/.test(html()), true);
  spokeSock.incoming({
    type: 'message',
    message: { id: 'f1', at: 5, kind: 'facilitator', author: { clientId: 'duck', displayName: 'Duck' }, text: 'What is in your way?' },
  });
  check('a facilitator line alone turns summary on', /id="summary"[^>]*\sdisabled/.test(html()), false);

  const later = boot();
  live(later, { round: { id: 2, status: 'collecting' } });
  const laterHtml = html();
  check('later rounds offer a composer and Pass',
    [laterHtml.indexOf('id="answer"') > -1, laterHtml.indexOf('id="pass"') > -1, laterHtml.indexOf('id="send"') > -1],
    [true, true, true]);

  // --- An in-progress contribution survives live session frames ------------
  const draft = boot();
  live(draft, { round: { id: 2, status: 'collecting' } });
  el('answer').value = 'half a thought';
  el('answer').selectionStart = 4;
  el('answer').selectionEnd = 7;
  el('answer').oninput();
  global.document.activeElement = el('answer');
  check('typing stores the draft in session state', draft.state.draft, 'half a thought');

  ws.last().incoming({
    type: 'presence',
    participants: [
      { clientId: 'client-1', displayName: 'Ada', status: 'pending' },
      { clientId: 'client-2', displayName: 'Grace', status: 'pending' },
    ],
  });
  check('incoming presence does not erase the draft', draft.state.draft, 'half a thought');
  check('and the composer still shows it', el('answer').value, 'half a thought');
  check('and restores the caret', [el('answer').selectionStart, el('answer').selectionEnd], [4, 7]);
  check('and still names the new arrival', html().indexOf('Grace') > -1, true);

  // Names land inside the rail's aria-label, a double-quoted attribute. A "
  // left raw there ends the attribute and lets a peer's display name add its
  // own, so every template blank is escaped for an attribute.
  ws.last().incoming({
    type: 'presence',
    participants: [
      { clientId: 'client-1', displayName: 'Ada', status: 'pending' },
      { clientId: 'client-3', displayName: 'x" onmouseover="alert(1)', status: 'pending' },
    ],
  });
  check('a quote in a display name cannot open an attribute of its own',
    [html().indexOf('" onmouseover="') === -1, html().indexOf('x&quot; onmouseover=&quot;alert(1)') > -1],
    [true, true]);
  const thread = el('thread');
  check('presence does not rebuild the chat log node', el('thread') === thread, true);

  ws.last().incoming({
    type: 'message',
    message: {
      id: 'm-peer', at: 3, kind: 'system',
      author: { clientId: 'sys', displayName: 'Duck' },
      text: 'Grace joined',
    },
  });
  check('incoming message does not erase the draft', draft.state.draft, 'half a thought');
  check('and the composer still holds the typed text', el('answer').value, 'half a thought');
  check('and the caret is still where it was', [el('answer').selectionStart, el('answer').selectionEnd], [4, 7]);

  ws.last().incoming({ type: 'round', round: { id: 2, status: 'collecting' } });
  check('a live round frame keeps the in-progress contribution', el('answer').value, 'half a thought');

  ws.last().close();
  check('reconnect keeps the draft in state', draft.state.draft, 'half a thought');
  check('and shows reconnecting chrome rather than an empty composer', /Reconnecting/.test(html()), true);

  await new Promise((r) => setTimeout(r, 550));
  ws.last().open();
  ws.last().incoming({
    type: 'snapshot',
    roomId: 'file:abc',
    you: { clientId: 'client-1' },
    participants: [
      { clientId: 'client-1', displayName: 'Ada', status: 'pending' },
      { clientId: 'client-2', displayName: 'Grace', status: 'pending' },
    ],
    messages: [],
    round: { id: 2, status: 'collecting' },
  });
  check('coming back live restores the in-progress contribution', el('answer').value, 'half a thought');
  check('and the caret after reconnect', [el('answer').selectionStart, el('answer').selectionEnd], [4, 7]);

  const submitted = boot();
  live(submitted, { round: { id: 2, status: 'collecting' } });
  el('answer').value = 'ship it';
  el('answer').oninput();
  el('send').onclick();
  check('submit keeps the draft until delivery succeeds', submitted.state.draft, 'ship it');
  submitted.deliver({ type: 'board-context', board: [] });
  await new Promise((r) => setTimeout(r, 0));
  check('successful send then clears the stored draft', submitted.state.draft, '');

  const lost = boot();
  live(lost, { round: { id: 2, status: 'collecting' } });
  el('answer').value = 'do not lose this';
  el('answer').oninput();
  el('send').onclick();
  ws.last().close();
  lost.deliver({ type: 'board-context', board: [] });
  await new Promise((r) => setTimeout(r, 0));
  check('socket loss during board wait keeps the draft', lost.state.draft, 'do not lose this');
  check('and does not count the round as acted', lost.state.actedRoundId, null);
  check('and shows reconnecting chrome rather than an empty composer', /Reconnecting/.test(html()), true);
  check('and shows that the send did not go through', /Could not send/.test(html()), true);

  await new Promise((r) => setTimeout(r, 550));
  ws.last().open();
  ws.last().incoming({
    type: 'snapshot',
    roomId: 'file:abc',
    you: { clientId: 'client-1' },
    participants: [{ clientId: 'client-1', displayName: 'Ada', status: 'pending' }],
    messages: [],
    round: { id: 2, status: 'collecting' },
  });
  check('coming back live restores the unsent contribution', el('answer').value, 'do not lose this');

  // --- Update summary posts the last facilitator turn -----------------------
  const summary = boot();
  live(summary, {
    messages: [{
      id: 'f1', at: 1, kind: 'facilitator',
      author: { clientId: 'duck', displayName: 'Duck' },
      text: 'Try grouping the nav.',
    }],
  });
  check('a facilitator turn enables Update summary', /id="summary"[^>]*disabled/.test(html()), false);
  dom.posted.length = 0;
  el('summary').onclick();
  check('Update summary posts the last facilitator text',
    dom.posted.filter((m) => m.type === 'update-summary').pop(), {
      type: 'update-summary',
      text: 'Try grouping the nav.',
    });

  summary.deliver({ type: 'summary-updated', nodeId: 's1' });
  check('a successful upsert tells the session the board changed',
    summary.state.banner && summary.state.banner.kind, 'info');

  summary.deliver({ type: 'summary-error', message: 'Could not write that sticky.' });
  check('a failed upsert surfaces the plugin error',
    summary.state.banner && summary.state.banner.text, 'Could not write that sticky.');

  const noFacilitator = boot();
  live(noFacilitator);
  check('with no facilitator turn the summary action is disabled',
    /id="summary"[^>]*\sdisabled/.test(html()), true);
  dom.posted.length = 0;
  el('summary').onclick();
  check('and clicking it posts nothing',
    dom.posted.filter((m) => m.type === 'update-summary').length, 0);

  // --- Cap failures keep the limit copy and hide Retry ---------------------
  const cap = boot();
  live(cap);
  ws.last().incoming({
    type: 'error',
    code: 'session_cap',
    message: 'This session has reached its facilitator limit.',
  });
  ws.last().incoming({ type: 'round', round: { id: 1, status: 'failed' } });
  check('a cap failure keeps the real limit message',
    html().indexOf('This session has reached its facilitator limit.') > -1, true);
  check('and does not offer Retry', html().indexOf('id="retry"') > -1, false);

  const failed = boot();
  live(failed);
  ws.last().incoming({ type: 'round', round: { id: 1, status: 'failed' } });
  check('a facilitator failure still offers Retry', html().indexOf('id="retry"') > -1, true);

  // --- Settings from the session returns to the session ---------------------
  const roundTrip = boot();
  live(roundTrip);
  el('settings').onclick();
  check('session settings is still text-size only', html().indexOf('id="text-size"') > -1, true);
  el('back').onclick();
  check('Back from settings returns to the live session', roundTrip.state.mode, 'session');

  // --- A paint while collapsed must not reach into an unpainted screen ------
  const collapsed = boot();
  live(collapsed);
  collapsed.deliver({ type: 'window', minimized: true });
  let threw = false;
  try {
    ws.last().incoming({
      type: 'message',
      message: {
        id: 'm9', at: 9, kind: 'system',
        author: { clientId: 'sys', displayName: 'Duck' },
        text: 'Grace joined',
      },
    });
  } catch (e) {
    threw = true;
  }
  check('a session frame while collapsed does not throw reaching into an unpainted thread', threw, false);

  collapsed.deliver({ type: 'window', minimized: false });
  check('expanding repaints the session rather than the connecting screen',
    collapsed.state.mode, 'session');
  check('and shows messages that arrived while collapsed',
    html().indexOf('Grace joined') > -1, true);

  // --- The resize grip must not stay live behind the collapsed duck --------
  // ui.html hides #grip with `body.min #grip`, since #grip lives outside
  // #root and no selector built on #root's own content can reach it. This
  // pins the class toggle that CSS depends on; there is no CSS engine here
  // to check the display:none itself.
  const grip = boot();
  grip.deliver({ type: 'window', minimized: true });
  check('collapsing marks the body so the stylesheet hides #grip', dom.body.classList.contains('min'), true);
  grip.deliver({ type: 'window', minimized: false });
  check('expanding clears it again', dom.body.classList.contains('min'), false);

  // --- Every screen change reports itself to the plugin --------------------
  const modes = boot();
  dom.posted.length = 0;
  modes.showConnecting();
  check('the connecting screen reports connecting', dom.posted.filter((m) => m.type === 'mode').pop(), {
    type: 'mode',
    mode: 'connecting',
  });

  dom.posted.length = 0;
  modes.openSettings();
  check('opening settings reports settings', dom.posted.filter((m) => m.type === 'mode').pop(), {
    type: 'mode',
    mode: 'settings',
  });

  // --- Someone holding the round up: nudge, and go on without them ---------
  const holding = { round: { id: 2, status: 'collecting' }, participants: [
    { clientId: 'client-1', displayName: 'Ada', status: 'contributed' },
    { clientId: 'client-2', displayName: 'Grace Hopper', status: 'pending' },
  ] };
  const held = boot();
  const heldSock = live(held, holding);
  check('once you are in, the strip offers a nudge and a way on',
    [html().indexOf('Waiting on Grace Hopper') > -1, html().indexOf('>Nudge Grace<') > -1, html().indexOf('>Go on without Grace<') > -1],
    [true, true, true]);
  el('nudge').onclick();
  check('Nudge asks the room to nudge this round', heldSock.sent.filter((m) => m.type === 'nudge').pop(), { type: 'nudge', roundId: 2 });
  check('and says it did, switched off for the cooldown', /id="nudge"[^>]*\sdisabled[^>]*>Nudged</.test(html()), true);
  el('close-round').onclick();
  check('Go on without asks the room to start the countdown',
    heldSock.sent.filter((m) => m.type === 'close-round').pop(), { type: 'close-round', roundId: 2 });

  heldSock.incoming({ type: 'round', round: { id: 2, status: 'collecting', closesAt: Date.now() + 20_000 } });
  check('the countdown replaces the offer', [html().indexOf('Going on without Grace Hopper') > -1, html().indexOf('id="nudge"') > -1], [true, false]);
  check('and its clock shows the seconds left', /^(19|20)s$/.test(el('round-clock').innerHTML), true);

  const holdout = boot();
  live(holdout, { round: { id: 2, status: 'collecting', closesAt: Date.now() + 20_000 }, participants: [
    { clientId: 'client-1', displayName: 'Ada', status: 'pending' },
    { clientId: 'client-2', displayName: 'Grace', status: 'contributed' },
  ] });
  check('the person being waited on is told the round is closing', html().indexOf('The round closes soon. Answer or pass.') > -1, true);

  // --- Being nudged ---------------------------------------------------------
  const poked = boot();
  const pokedSock = live(poked, { round: { id: 2, status: 'collecting' } });
  dom.posted.length = 0;
  pokedSock.incoming({ type: 'nudged', by: 'Grace' });
  check('a nudge says who is waiting, in the strip', /id="round"[\s\S]*Grace is waiting on you\./.test(html()), true);
  check('and asks the plugin for a toast that reaches a collapsed panel',
    dom.posted.filter((m) => m.type === 'notify').pop(), { type: 'notify', text: 'Grace is waiting on you in Duck Check-In.' });

  // --- New session ----------------------------------------------------------
  const fresh = boot();
  const freshSock = live(fresh, {
    round: { id: 3, status: 'collecting' },
    messages: [{ id: 'old-1', at: 1, kind: 'contribution', author: { clientId: 'client-2', displayName: 'Grace' }, text: 'An old answer' }],
  });
  fresh.state.draft = 'half an old thought';
  fresh.openSettings();
  el('new-session').onclick();
  check('one tap on New session only arms it',
    [freshSock.sent.filter((m) => m.type === 'reset').length, html().indexOf('Tap again to clear it for everyone') > -1], [0, true]);
  el('new-session').onclick();
  check('the second tap asks the room for a new session', freshSock.sent.filter((m) => m.type === 'reset').length, 1);
  check('and goes back to the chat', fresh.state.mode, 'session');
  freshSock.incoming({
    type: 'snapshot', roomId: 'file:abc', you: { clientId: 'client-1' },
    participants: [{ clientId: 'client-1', displayName: 'Ada', status: 'pending' }],
    messages: [{ id: 'sys-1', at: 2, kind: 'system', author: { clientId: 'client-2', displayName: 'Grace' }, text: 'Grace started a new session.' }],
    round: { id: 1, status: 'collecting' },
  });
  check('the fresh snapshot clears the old chat off the screen',
    [html().indexOf('An old answer') > -1, html().indexOf('Grace started a new session.') > -1], [false, true]);
  check('and drops the draft that belonged to the old session', fresh.state.draft, '');

  // A reset during round 1 keeps the round number, so only the session name
  // tells it apart from a reconnect.
  const roundOneMsgs = [{ id: 'r1-a', at: 1, kind: 'contribution', author: { clientId: 'client-2', displayName: 'Grace' }, text: 'Round one answer' }];
  const again = boot();
  const againSock = live(again, { messages: roundOneMsgs, participants: [
    { clientId: 'client-1', displayName: 'Ada', status: 'pending' },
    { clientId: 'client-2', displayName: 'Grace', status: 'contributed' },
  ] });
  againSock.incoming({ type: 'nudged', by: 'Grace' });
  again.state.draft = 'typed in the old round 1';
  const resetSnap = {
    type: 'snapshot', roomId: 'file:abc', session: 's2', you: { clientId: 'client-1' },
    participants: [{ clientId: 'client-1', displayName: 'Ada', status: 'pending' }, { clientId: 'client-2', displayName: 'Grace', status: 'pending' }],
    messages: [{ id: 'sys-2', at: 2, kind: 'system', author: { clientId: 'client-2', displayName: 'Grace' }, text: 'Grace started a new session.' }],
    round: { id: 1, status: 'collecting' },
  };
  againSock.incoming(resetSnap);
  check('a new session started in round 1 drops the old nudge',
    [html().indexOf('Grace is waiting on you.') > -1, again.state.nudgedBy], [false, '']);
  check('and the draft typed for the old round 1', again.state.draft, '');

  // A Worker from before session names sends none, and a round-1 reset keeps
  // the round number. The second snapshot on one socket still gives it away.
  const legacy = boot();
  const legacySock = live(legacy, { session: undefined, messages: roundOneMsgs, participants: resetSnap.participants });
  legacySock.incoming({ type: 'nudged', by: 'Grace' });
  legacy.state.draft = 'typed before an old Worker reset';
  legacySock.incoming(Object.assign({}, resetSnap, { session: undefined }));
  check('a reset from a Worker without session names still drops the nudge and the draft',
    [html().indexOf('Grace is waiting on you.') > -1, legacy.state.draft], [false, '']);

  const rejoin = boot();
  live(rejoin, { messages: roundOneMsgs }).incoming({ type: 'nudged', by: 'Grace' });
  const rejoinSock = await reconnect();
  rejoinSock.incoming({
    type: 'snapshot', roomId: 'file:abc', session: 's1', you: { clientId: 'client-1' },
    participants: [{ clientId: 'client-1', displayName: 'Ada', status: 'pending' }],
    messages: roundOneMsgs, round: { id: 1, status: 'collecting' },
  });
  check('a reconnect snapshot of the same thread keeps the nudge', html().indexOf('Grace is waiting on you.') > -1, true);

  // Away long enough that the capped thread shares no turns with the one on
  // screen: still the same session, so the draft stays.
  const away = boot();
  live(away, { messages: roundOneMsgs });
  away.state.draft = 'written before the laptop slept';
  const awaySock = await reconnect();
  const missed = [];
  for (let i = 0; i < 100; i++) {
    missed.push({ id: 'later-' + i, at: 10 + i, kind: 'contribution', author: { clientId: 'client-2', displayName: 'Grace' }, text: 'Later ' + i });
  }
  awaySock.incoming({
    type: 'snapshot', roomId: 'file:abc', session: 's1', you: { clientId: 'client-1' },
    participants: [{ clientId: 'client-1', displayName: 'Ada', status: 'pending' }],
    messages: missed, round: { id: 15, status: 'collecting' },
  });
  check('a long absence in the same session keeps the draft', [away.state.draft, el('answer').value],
    ['written before the laptop slept', 'written before the laptop slept']);

  // --- A New session that could not send stays on settings and says so ----
  const unsent = boot();
  const unsentSock = live(unsent);
  unsent.openSettings();
  el('new-session').onclick();
  unsentSock.readyState = 3; // died without a close event reaching us yet
  el('new-session').onclick();
  check('a second tap that could not send stays on settings', unsent.state.mode, 'settings');
  check('with the button back to New session, and the reason on screen',
    [html().indexOf('>New session<') > -1, html().indexOf('nothing was cleared') > -1], [true, true]);

  // --- Settings follows the connection ------------------------------------
  const drop = boot();
  const dropSock = live(drop);
  drop.openSettings();
  check('New session is on while connected', /id="new-session"[^>]*\sdisabled/.test(html()), false);
  dropSock.close(1006, '');
  check('and switches off when the connection drops, without leaving settings',
    [drop.state.mode, /id="new-session"[^>]*\sdisabled/.test(html())], ['settings', true]);

  // --- Collapsed from settings still tracks the turn ----------------------
  const tucked = boot();
  const tuckedSock = live(tucked, { round: { id: 2, status: 'collecting' }, participants: [
    { clientId: 'client-1', displayName: 'Ada', status: 'contributed' },
    { clientId: 'client-2', displayName: 'Grace', status: 'pending' },
  ] });
  tucked.openSettings();
  tucked.deliver({ type: 'window', minimized: true });
  check('collapsed from settings with nothing to do, the duck sits still', /class="collapsed\s*"/.test(html()), true);
  tuckedSock.incoming({ type: 'round', round: { id: 3, status: 'collecting' } });
  tuckedSock.incoming({ type: 'presence', participants: [
    { clientId: 'client-1', displayName: 'Ada', status: 'pending' },
    { clientId: 'client-2', displayName: 'Grace', status: 'pending' },
  ] });
  check('and bobs once the next round is waiting on you', /class="collapsed turn"/.test(html()), true);
  tucked.deliver({ type: 'window', minimized: false });
  check('expanding goes back to settings', tucked.state.mode, 'settings');
};
