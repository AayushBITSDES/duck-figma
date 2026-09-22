/*
 * Runs against the COMPILED output in .test-build, not a reimplementation.
 *
 * Boots the plugin entry (code.js, wiring board.js/session.js/summary.js/
 * window.ts) against a stubbed figma global, the same way FigJam's plugin
 * sandbox would load it, and inspects what it posts back to the UI and what
 * it writes to clientStorage.
 */
const fs = require('fs');
const path = require('path');
const { check } = require('./lib/check');
const { BUILD, clearBuildCache, clearPendingTimers } = require('./lib/fresh');

function makeSticky(id, extra) {
  const data = {};
  const node = {
    id: id,
    type: 'STICKY',
    removed: false,
    name: '',
    x: 0, y: 0, width: 80, height: 80,
    text: {
      characters: '',
      fontName: { family: 'Inter', style: 'Regular' },
      getRangeAllFontNames: function () {
        return this.characters.length ? [{ family: 'Inter', style: 'Regular' }] : [];
      },
    },
    getPluginData: (k) => data[k] || '',
    setPluginData: (k, v) => { data[k] = String(v); },
    remove: () => { node.removed = true; },
  };
  return Object.assign(node, extra || {});
}

function makeFigma(opts) {
  opts = opts || {};
  const store = Object.assign({}, opts.store || {});
  const rootData = Object.assign({}, opts.rootData || {});
  const pageData = Object.assign({}, opts.pageData || {});
  const nodes = (opts.nodes || []).slice();
  const nodeById = Object.assign({}, opts.nodeById || {});
  const sent = [];
  const resizes = [];
  const notifies = [];
  const stickies = [];
  const accessed = { activeUsers: false, findAll: 0, findAllWithCriteria: 0 };
  const listeners = { documentchange: [], currentpagechange: [] };
  let nextStickyId = 1;

  const page = {
    id: opts.pageId || 'page-1',
    type: 'PAGE',
    appendChild: (n) => {
      n.parent = page;
      if (nodes.indexOf(n) === -1) nodes.push(n);
    },
    findAll: (pred) => {
      accessed.findAll += 1;
      return typeof pred === 'function' ? nodes.filter(pred) : nodes.slice();
    },
    findAllWithCriteria: (query) => {
      accessed.findAllWithCriteria += 1;
      const types = (query && query.types) || [];
      return nodes.filter((n) => types.indexOf(n.type) !== -1);
    },
    selection: [],
    getPluginData: (k) => pageData[k] || '',
    setPluginData: (k, v) => { pageData[k] = String(v); },
  };

  const figma = {
    showUI: () => {},
    on: (type, fn) => {
      if (!listeners[type]) listeners[type] = [];
      listeners[type].push(fn);
    },
    notify: (m) => notifies.push(m),
    fileKey: opts.fileKey,
    currentUser: opts.currentUser,
    root: {
      getPluginData: (k) => rootData[k] || '',
      setPluginData: (k, v) => { rootData[k] = String(v); },
    },
    currentPage: page,
    viewport: { center: { x: opts.cx || 0, y: opts.cy || 0 } },
    ui: {
      postMessage: (m) => sent.push(m),
      onmessage: null,
      resize: (w, h) => resizes.push([w, h]),
    },
    clientStorage: {
      getAsync: async (k) => (k in store ? store[k] : undefined),
      setAsync: async (k, v) => { store[k] = v; },
      deleteAsync: async (k) => { delete store[k]; },
    },
    // Like Figma's, onto whichever page is in view at the moment of the call,
    // not the page the plugin started on.
    createSticky: () => {
      const sticky = makeSticky('s' + nextStickyId++, { parent: figma.currentPage });
      stickies.push(sticky);
      nodes.push(sticky);
      nodeById[sticky.id] = sticky;
      return sticky;
    },
    loadFontAsync: opts.loadFontAsync || (async () => {}),
    getNodeByIdAsync: async (id) => nodeById[id] || null,
    mixed: { mixed: true },
  };
  Object.defineProperty(figma, 'activeUsers', {
    get() { accessed.activeUsers = true; return []; },
    configurable: true,
  });

  return {
    figma, store, rootData, pageData, nodes, nodeById, sent, resizes, notifies,
    stickies, accessed,
    edit: (origin) => {
      (listeners.documentchange || []).forEach((fn) => fn({ documentChanges: [{ origin: origin }] }));
    },
    changePage: (id) => {
      page.id = id;
      (listeners.currentpagechange || []).forEach((fn) => fn());
    },
  };
}

function bootPlugin(store, opts) {
  // A previous boot may still have a debounced clientStorage write pending
  // (window.ts's PERSIST_DEBOUNCE_MS); see the comment in lib/fresh.js for
  // why that timer has to be swept before this boot's global.figma goes in.
  clearPendingTimers();
  clearBuildCache();
  const env = makeFigma(Object.assign({ store: store || {} }, opts || {}));
  let intervals = 0;
  const realSetInterval = global.setInterval;
  global.setInterval = (fn) => { intervals++; return 0; };
  global.__html__ = '<html></html>';
  global.figma = env.figma;
  require(path.join(BUILD, 'plugin', 'code'));
  global.setInterval = realSetInterval;
  return {
    env: env,
    state: env.store,
    send: (m) => env.figma.ui.onmessage(m),
    window: () => env.sent.filter((m) => m.type === 'window').pop(),
    session: () => env.sent.filter((m) => m.type === 'session').pop(),
    lastResize: () => env.resizes[env.resizes.length - 1],
    resizes: env.resizes,
    intervals: intervals,
    accessed: env.accessed,
    edit: env.edit,
    sent: env.sent,
    rootData: env.rootData,
    notifies: env.notifies,
    stickies: env.stickies,
  };
}

function loadPlugin(name, opts) {
  clearPendingTimers();
  clearBuildCache();
  const env = makeFigma(opts || {});
  global.figma = env.figma;
  const mod = require(path.join(BUILD, 'plugin', name));
  return { env, mod };
}

const settled = () => new Promise((r) => setTimeout(r, 0));

module.exports = async function run() {
  // --- session identity -----------------------------------------------------
  let { env, mod: sess } = loadPlugin('session', {
    fileKey: '  FigFileKey  ',
    currentUser: { name: 'Ada Lovelace' },
    store: { duckClientId: 'client-01' },
  });
  const firstRoom = sess.resolveRoomId();
  const mintedDespiteFileKey = env.rootData.duckRoomId;
  check('a file key still mints opaque pluginData', typeof mintedDespiteFileKey, 'string');
  check('and the room id is that token, not the file key', firstRoom, 'room:' + mintedDespiteFileKey);
  check('and the guessable file key is not in the room id', firstRoom.indexOf('FigFileKey') === -1, true);
  check('current user is the display name', sess.displayName(), 'Ada Lovelace');
  await sess.bootSession();
  check('boot posts the opaque document-scoped room', env.sent.filter((m) => m.type === 'session').pop(), {
    type: 'session',
    roomId: 'room:' + mintedDespiteFileKey,
    clientId: 'client-01',
    displayName: 'Ada Lovelace',
  });
  check('and reuses the stored client id', env.store.duckClientId, 'client-01');

  ({ env, mod: sess } = loadPlugin('session', {
    fileKey: 'FigFileKey',
    rootData: { duckRoomId: 'already-minted' },
    currentUser: { name: '   ' },
  }));
  check('teammates share the stored pluginData even when a file key exists',
    sess.resolveRoomId(), 'room:already-minted');
  check('and still do not use the file key', sess.resolveRoomId().indexOf('FigFileKey') === -1, true);
  check('a blank current user falls back to Anonymous', sess.displayName(), 'Anonymous');

  ({ env, mod: sess } = loadPlugin('session', {
    rootData: { duckRoomId: 'already-minted' },
  }));
  check('without a file key, document pluginData is still the room', sess.resolveRoomId(), 'room:already-minted');

  ({ env, mod: sess } = loadPlugin('session', {
    currentUser: { name: 'A'.repeat(80) },
  }));
  check('an overlong display name is clipped to 40', sess.displayName().length, 40);
  await sess.bootSession();
  const minted = env.rootData.duckRoomId;
  check('a first open mints pluginData', typeof minted, 'string');
  check('and posts a room-prefixed id', env.sent.filter((m) => m.type === 'session').pop().roomId, 'room:' + minted);
  check('a second resolve reuses that id', sess.resolveRoomId(), 'room:' + minted);

  ({ env, mod: sess } = loadPlugin('session', {}));
  Object.defineProperty(env.figma, 'currentUser', {
    get() { throw new Error('no permission'); },
  });
  check('a missing currentuser permission falls back to Anonymous', sess.displayName(), 'Anonymous');

  ({ env, mod: sess } = loadPlugin('session', { store: { duckClientId: 'short' } }));
  await sess.bootSession();
  check('an undersized stored client id is rejected and replaced',
    [env.store.duckClientId === 'short', /^[A-Za-z0-9-]{8,64}$/.test(env.store.duckClientId)],
    [false, true]);

  ({ env, mod: sess } = loadPlugin('session', { store: { duckClientId: 'spaces not ok' } }));
  await sess.bootSession();
  check('a stored client id with spaces is rejected', env.store.duckClientId === 'spaces not ok', false);

  const race = bootPlugin({ duckClientId: 'client-01' }, {
    fileKey: 'FileA',
    rootData: { duckRoomId: 'aaa' },
  });
  await settled();
  check('code.ts posts the opaque room on boot, not the file key', race.session().roomId, 'room:aaa');
  race.rootData.duckRoomId = 'bbb';
  race.edit('REMOTE');
  check('a remote pluginData write switches the posted room', race.session().roomId, 'room:bbb');
  const sessionPosts = race.sent.filter((m) => m.type === 'session').length;
  race.edit('LOCAL');
  check('a local documentchange does not rebroadcast session',
    race.sent.filter((m) => m.type === 'session').length, sessionPosts);

  const named = bootPlugin({ duckClientId: 'client-99' }, {
    fileKey: 'FileA',
    currentUser: { name: 'Grace' },
    rootData: { duckRoomId: 'shared-token' },
  });
  await settled();
  check('code.ts posts opaque room, client id, and current user together', named.session(), {
    type: 'session',
    roomId: 'room:shared-token',
    clientId: 'client-99',
    displayName: 'Grace',
  });
  check('and leaves the guessable file key out of the room id',
    named.session().roomId.indexOf('FileA') === -1, true);

  // --- no activeUsers / motion / idle ---------------------------------------
  const pluginSrc = ['code', 'session', 'board', 'summary', 'window']
    .map((n) => fs.readFileSync(path.join(BUILD, 'plugin', n + '.js'), 'utf8'))
    .join('\n');
  check('plugin entry does not load an idle module', /require\(['"]\.\/idle['"]\)/.test(pluginSrc), false);
  check('plugin source never reads activeUsers', pluginSrc.indexOf('activeUsers') > -1, false);
  check('plugin source never starts idle watch', pluginSrc.indexOf('startIdleWatch') > -1, false);

  const quiet = bootPlugin({ duckClientId: 'client-01' }, { fileKey: 'F' });
  await settled();
  quiet.send({ type: 'mode', mode: 'idle' });
  quiet.edit('LOCAL');
  quiet.edit('REMOTE');
  check('boot never starts an idle poll', quiet.intervals, 0);
  check('and never reads activeUsers', quiet.accessed.activeUsers, false);
  check('and never posts a check-in or resume',
    quiet.sent.filter((m) => m.type === 'checkin' || m.type === 'resume').length, 0);

  // --- board contract -------------------------------------------------------
  const long = 'x'.repeat(250);
  const many = [];
  for (let i = 0; i < 45; i++) many.push({ type: 'TEXT', characters: 'n' + i });
  const { env: boardEnv, mod: board } = loadPlugin('board', {
    nodes: [
      { type: 'STICKY', text: { characters: '  sticky note  ' } },
      { type: 'TEXT', characters: 'plain text' },
      { type: 'SHAPE_WITH_TEXT', text: { characters: 'shape copy' } },
      { type: 'CODE_BLOCK', code: 'const x = 1' },
      { type: 'SECTION', name: 'Onboarding' },
      { type: 'TEXT', characters: '   ' },
      { type: 'TEXT', characters: long },
      { type: 'RECTANGLE' },
    ].concat(many),
  });
  check('board caps match the protocol', [board.MAX_BOARD_ITEMS, board.MAX_ITEM_LENGTH], [40, 200]);
  const items = board.getBoardItems();
  check('text-bearing types are collected and trimmed',
    items.slice(0, 5), ['sticky note', 'plain text', 'shape copy', 'const x = 1', 'Onboarding']);
  check('blank text is skipped', items.indexOf('') > -1, false);
  check('each item is clipped to 200 characters', items[5], 'x'.repeat(200));
  check('and the list stops at 40', items.length, 40);
  check('board reads typed nodes instead of walking every child',
    [boardEnv.accessed.findAllWithCriteria > 0, boardEnv.accessed.findAll], [true, 0]);
  const walks = boardEnv.accessed.findAllWithCriteria;
  const again = board.getBoardItems();
  check('a second read reuses the recent snapshot', again, items);
  check('and does not walk the page again', boardEnv.accessed.findAllWithCriteria, walks);
  board.sendBoard();
  check('sendBoard posts the snapshot the UI asked for',
    boardEnv.sent.filter((m) => m.type === 'board-context').pop(), { type: 'board-context', board: items });
  boardEnv.changePage('page-2');
  board.getBoardItems();
  check('switching pages walks again', boardEnv.accessed.findAllWithCriteria, walks + 1);
  const afterPage = boardEnv.accessed.findAllWithCriteria;
  board.getBoardItems();
  check('the new page snapshot is reused', boardEnv.accessed.findAllWithCriteria, afterPage);
  boardEnv.nodes.unshift({ type: 'TEXT', characters: 'just added' });
  boardEnv.edit('LOCAL');
  const afterEdit = board.getBoardItems();
  check('a document change walks again', boardEnv.accessed.findAllWithCriteria > afterPage, true);
  check('and includes the new text', afterEdit[0], 'just added');

  const viaCode = bootPlugin({ duckClientId: 'client-01' }, { fileKey: 'F' });
  await settled();
  viaCode.send({ type: 'get-board' });
  check('get-board from the UI re-reads the page',
    viaCode.sent.filter((m) => m.type === 'board-context').length >= 2, true);

  // --- one living summary sticky --------------------------------------------
  let { env: sumEnv, mod: summary } = loadPlugin('summary', { cx: 100, cy: 200 });
  await summary.updateSummary('First pass');
  check('a missing summary creates one sticky', sumEnv.stickies.length, 1);
  const living = sumEnv.stickies[0];
  check('tagged as the session summary', [living.name, living.getPluginData('duckRole')],
    ['Session Summary', 'session-summary']);
  check('with the text written through', living.text.characters, 'First pass');
  check('placed at the viewport center', [living.x, living.y], [60, 160]);
  check('and remembered on the page', sumEnv.pageData.duckSummaryNodeId, living.id);
  check('and reported to the UI',
    sumEnv.sent.filter((m) => m.type === 'summary-updated').pop(), { type: 'summary-updated', nodeId: living.id });
  check('with a created-notify', sumEnv.notifies[sumEnv.notifies.length - 1],
    'Dropped the session summary on your board.');

  const createdX = living.x;
  living.x = 12;
  await summary.updateSummary('Second pass');
  check('a later update writes the same sticky', sumEnv.stickies.length, 1);
  check('in place, without recreating it', living.text.characters, 'Second pass');
  check('and without moving it', living.x, 12);
  check('and notifies an update, not a drop', sumEnv.notifies[sumEnv.notifies.length - 1],
    'Updated the session summary.');
  living.x = createdX;

  ({ env: sumEnv, mod: summary } = loadPlugin('summary', { cx: 100, cy: 200 }));
  const otherPage = { type: 'PAGE' };
  const moved = makeSticky('moved-off-page', { parent: otherPage });
  moved.setPluginData('duckRole', 'session-summary');
  moved.name = 'Session Summary';
  moved.text.characters = 'Left behind';
  sumEnv.nodeById[moved.id] = moved;
  sumEnv.pageData.duckSummaryNodeId = moved.id;
  await summary.updateSummary('Stays on this page');
  check('a remembered sticky on another page is not updated', moved.text.characters, 'Left behind');
  check('and a new summary is created on the current page', sumEnv.stickies.length, 1);
  check('with the new text', sumEnv.stickies[0].text.characters, 'Stays on this page');
  check('and the page now remembers the on-page sticky', sumEnv.pageData.duckSummaryNodeId, sumEnv.stickies[0].id);

  ({ env: sumEnv, mod: summary } = loadPlugin('summary'));
  const strayPage = { type: 'PAGE' };
  const stray = makeSticky('stray-off-page', { parent: strayPage });
  stray.setPluginData('duckRole', 'session-summary');
  stray.text.characters = 'Other page';
  sumEnv.nodeById[stray.id] = stray;
  sumEnv.pageData.duckSummaryNodeId = stray.id;
  const onPage = makeSticky('already-here', { parent: sumEnv.figma.currentPage });
  onPage.setPluginData('duckRole', 'session-summary');
  onPage.name = 'Session Summary';
  onPage.text.characters = 'Here already';
  sumEnv.nodes.push(onPage);
  sumEnv.nodeById[onPage.id] = onPage;
  await summary.updateSummary('Updated here');
  check('an off-page remembered id falls through to the tagged sticky on this page',
    [stray.text.characters, onPage.text.characters, sumEnv.stickies.length],
    ['Other page', 'Updated here', 0]);
  check('and remembers the on-page sticky', sumEnv.pageData.duckSummaryNodeId, onPage.id);

  ({ env: sumEnv, mod: summary } = loadPlugin('summary'));
  const section = { type: 'SECTION', parent: sumEnv.figma.currentPage };
  const nested = makeSticky('nested-on-page', { parent: section });
  nested.setPluginData('duckRole', 'session-summary');
  nested.name = 'Session Summary';
  nested.text.characters = 'Inside a section';
  sumEnv.nodes.push(nested);
  sumEnv.nodeById[nested.id] = nested;
  sumEnv.pageData.duckSummaryNodeId = nested.id;
  await summary.updateSummary('Still nested');
  check('a nested sticky on the current page is reused', sumEnv.stickies.length, 0);
  check('and updated in place', nested.text.characters, 'Still nested');

  ({ env: sumEnv, mod: summary } = loadPlugin('summary'));
  sumEnv.figma.createSticky = () => { throw new Error('no stickies'); };
  await summary.updateSummary('nope');
  check('a create failure reports an error',
    sumEnv.sent.filter((m) => m.type === 'summary-error').pop(), {
      type: 'summary-error',
      message: "Couldn't create a session summary sticky.",
    });

  ({ env: sumEnv, mod: summary } = loadPlugin('summary'));
  sumEnv.figma.loadFontAsync = async () => { throw new Error('font'); };
  await summary.updateSummary('font-fail');
  check('a font failure removes the sticky it just created', sumEnv.stickies[0].removed, true);
  check('and reports the write error',
    sumEnv.sent.filter((m) => m.type === 'summary-error').pop(), {
      type: 'summary-error',
      message: "Couldn't write that sticky: the font wouldn't load.",
    });

  // Two clicks on Update summary before the first finishes. Both used to
  // look for a sticky, both used to miss, and both used to create one.
  ({ env: sumEnv, mod: summary } = loadPlugin('summary', { cx: 0, cy: 0 }));
  await Promise.all([summary.updateSummary('First click'), summary.updateSummary('Second click')]);
  check('a double click writes one sticky, not two', sumEnv.stickies.length, 1);
  check('and the later click is what survives', sumEnv.stickies[0].text.characters, 'Second click');

  // Same race across the network: a collaborator's summary syncs in while
  // our own font load is still pending.
  ({ env: sumEnv, mod: summary } = loadPlugin('summary'));
  const theirs = makeSticky('theirs', { parent: sumEnv.figma.currentPage });
  theirs.setPluginData('duckRole', 'session-summary');
  theirs.name = 'Session Summary';
  let injected = false;
  sumEnv.figma.loadFontAsync = async () => {
    if (injected) return;
    injected = true;
    sumEnv.nodes.push(theirs);
    sumEnv.nodeById[theirs.id] = theirs;
  };
  await summary.updateSummary('Ours');
  check("a collaborator's sticky arriving mid-write is adopted", theirs.text.characters, 'Ours');
  check('and the duplicate we made is removed', sumEnv.stickies[0].removed, true);
  check('leaving the page pointed at the surviving sticky', sumEnv.pageData.duckSummaryNodeId, theirs.id);

  // Switching pages while the font load is pending must not let the write
  // wander: the adoption lookup reads figma.currentPage, so unpinned it
  // could delete the sticky just made here and overwrite the other page's.
  ({ env: sumEnv, mod: summary } = loadPlugin('summary'));
  const pageTwoData = {};
  const pageTwo = {
    id: 'page-2',
    type: 'PAGE',
    selection: [],
    getPluginData: (k) => pageTwoData[k] || '',
    setPluginData: (k, v) => { pageTwoData[k] = String(v); },
    findAll: (pred) => (typeof pred === 'function' ? [elsewhere].filter(pred) : [elsewhere]),
  };
  const elsewhere = makeSticky('page-two-summary', { parent: pageTwo });
  elsewhere.setPluginData('duckRole', 'session-summary');
  elsewhere.name = 'Session Summary';
  elsewhere.text.characters = 'Page two summary';
  sumEnv.nodeById[elsewhere.id] = elsewhere;
  let switched = false;
  sumEnv.figma.loadFontAsync = async () => {
    if (switched) return;
    switched = true;
    sumEnv.figma.currentPage = pageTwo;
  };
  await summary.updateSummary('Started on page one');
  check('a page switch mid-write leaves the other page alone',
    elsewhere.text.characters, 'Page two summary');
  check('and still writes the sticky it created', sumEnv.stickies[0].text.characters, 'Started on page one');
  check('and does not delete it', sumEnv.stickies[0].removed, false);
  check('and remembers it on the page it started from, not the one in view',
    [sumEnv.pageData.duckSummaryNodeId, pageTwoData.duckSummaryNodeId],
    [sumEnv.stickies[0].id, undefined]);

  // The same switch one await earlier, while the remembered id is being
  // resolved. The fallback search used to run against whatever page was in
  // view by then, so it adopted that page's summary and wrote this page's
  // text into it.
  ({ env: sumEnv, mod: summary } = loadPlugin('summary'));
  const otherData = {};
  const farSticky = makeSticky('far-summary');
  const farPage = {
    id: 'page-far',
    type: 'PAGE',
    selection: [],
    getPluginData: (k) => otherData[k] || '',
    setPluginData: (k, v) => { otherData[k] = String(v); },
    findAll: (pred) => (typeof pred === 'function' ? [farSticky].filter(pred) : [farSticky]),
  };
  farSticky.parent = farPage;
  farSticky.setPluginData('duckRole', 'session-summary');
  farSticky.name = 'Session Summary';
  farSticky.text.characters = 'Their summary';
  const here = makeSticky('here-summary', { parent: sumEnv.figma.currentPage });
  here.setPluginData('duckRole', 'session-summary');
  here.name = 'Session Summary';
  sumEnv.nodes.push(here);
  sumEnv.nodeById[here.id] = here;
  sumEnv.pageData.duckSummaryNodeId = here.id;
  sumEnv.figma.getNodeByIdAsync = async (id) => {
    sumEnv.figma.currentPage = farPage;
    return sumEnv.nodeById[id] || null;
  };
  await summary.updateSummary('Started here');
  check('a page switch during the id lookup leaves the other page alone',
    farSticky.text.characters, 'Their summary');
  check('and writes the sticky on the page the click came from',
    [here.text.characters, sumEnv.stickies.length], ['Started here', 0]);
  check('and leaves the other page remembering nothing',
    [sumEnv.pageData.duckSummaryNodeId, otherData.duckSummaryNodeId], [here.id, undefined]);

  // The same switch when the remembered sticky is gone, so the lookup comes
  // back empty and a new one is made. createSticky lands on the page in view,
  // so unpinned the summary was created on the other page, remembered on
  // this one, and assigned to this page's selection.
  ({ env: sumEnv, mod: summary } = loadPlugin('summary'));
  const home = sumEnv.figma.currentPage;
  const awayData = {};
  const away = {
    id: 'page-away',
    type: 'PAGE',
    selection: [],
    getPluginData: (k) => awayData[k] || '',
    setPluginData: (k, v) => { awayData[k] = String(v); },
    findAll: () => [],
  };
  sumEnv.pageData.duckSummaryNodeId = 'deleted-sticky';
  sumEnv.figma.getNodeByIdAsync = async () => {
    sumEnv.figma.currentPage = away;
    return null;
  };
  await summary.updateSummary('Made here');
  check('a sticky created after a mid-lookup switch lands on the page the click came from',
    [sumEnv.stickies.length, sumEnv.stickies[0] && sumEnv.stickies[0].parent === home],
    [1, true]);
  check('and is the one that page remembers and selects',
    [sumEnv.pageData.duckSummaryNodeId, home.selection[0] && home.selection[0].id, away.selection.length],
    [sumEnv.stickies[0] && sumEnv.stickies[0].id, sumEnv.stickies[0] && sumEnv.stickies[0].id, 0]);

  const throughCode = bootPlugin({ duckClientId: 'client-01' }, { fileKey: 'F', cx: 0, cy: 0 });
  await settled();
  throughCode.send({ type: 'update-summary', text: 'From the UI' });
  await settled();
  check('update-summary from the UI creates the living sticky',
    throughCode.stickies[0].text.characters, 'From the UI');

  // --- window geometry ------------------------------------------------------
  // Its own clientStorage key on purpose: see the STORE comment in window.ts.

  let boot = bootPlugin({});
  await settled();
  check('with nothing stored the window opens at the default size', boot.lastResize(), [280, 380]);
  check('and reports itself to the UI', boot.window(), { type: 'window', width: 280, height: 380, minimized: false, textSize: 11 });

  boot = bootPlugin({ duckWindow: { width: 420, height: 560, minimized: false } });
  await settled();
  check('a saved size is restored on startup', boot.lastResize(), [420, 560]);

  // A corrupt or absurd stored value must never produce an unusable panel.
  boot = bootPlugin({ duckWindow: { width: 10, height: 10, minimized: false } });
  await settled();
  check('an undersized stored value is clamped up', boot.lastResize(), [200, 260]);

  boot = bootPlugin({ duckWindow: { width: 'nonsense', height: null, minimized: false } });
  await settled();
  check('a corrupt stored value falls back to the default', boot.lastResize(), [280, 380]);

  // A stored value must never produce an absurd panel, either. Settings is
  // anchored to the top left and so stays reachable at any size; its reset
  // button is what rescues a panel bigger than the Figma window.
  boot = bootPlugin({ duckWindow: { width: 999999, height: 999999, minimized: false } });
  await settled();
  check('an oversized stored value is clamped down on restore', boot.lastResize(), [800, 720]);

  boot = bootPlugin({ duckWindow: { width: 300, height: 400, minimized: true } });
  await settled();
  check('a window saved collapsed reopens collapsed', boot.lastResize(), [70, 70]);
  check('and still remembers the open size behind it',
    boot.window(), { type: 'window', width: 300, height: 400, minimized: true, textSize: 11 });

  // Minimize and expand round trip without losing the open size.
  boot = bootPlugin({ duckWindow: { width: 320, height: 420, minimized: false } });
  await settled();
  boot.send({ type: 'minimize' });
  await settled();
  check('minimize collapses to the 70x70 floor', boot.lastResize(), [70, 70]);
  check('and is written through immediately, not debounced', boot.state.duckWindow.minimized, true);
  boot.send({ type: 'expand' });
  await settled();
  check('expand restores the size it was collapsed from', boot.lastResize(), [320, 420]);

  // A drag fires resize continuously. The panel must follow every event, but
  // clientStorage must not be written on every one of them.
  boot = bootPlugin({});
  await settled();
  const before = boot.resizes.length;
  for (let w = 300; w <= 340; w += 10) boot.send({ type: 'resize', width: w, height: 400 });
  check('every resize event moves the panel', boot.resizes.length - before, 5);
  check('the panel is at the last size dragged to', boot.lastResize(), [340, 400]);
  check('and nothing is persisted yet, mid-drag', boot.state.duckWindow, undefined);
  await new Promise((r) => setTimeout(r, 500));
  check('the drag is written once it settles', boot.state.duckWindow.width, 340);

  // window.ts's debounce timer reads `figma` off the global at the moment it
  // fires, and this test process reassigns global.figma on every bootPlugin
  // call. A timer left running by one boot must not survive to fire against
  // a later boot's store once that boot has replaced global.figma.
  let leaker = bootPlugin({});
  await settled();
  leaker.send({ type: 'resize', width: 500, height: 600 });
  boot = bootPlugin({});
  await settled();
  await new Promise((r) => setTimeout(r, 500));
  check("a pending debounce from a previous boot never lands in the next boot's storage", boot.state.duckWindow, undefined);
  check('nor does it land anywhere at all once the next boot has started', leaker.state.duckWindow, undefined);

  // figma.ui.onmessage is live from the plugin's first tick, but the stored
  // geometry only arrives once clientStorage resolves. An action taken in that
  // gap is newer than the snapshot, so the snapshot must not land on top of it.
  // The missing `await settled()` before the send is the whole point.
  boot = bootPlugin({ duckWindow: { width: 300, height: 400, minimized: false } });
  boot.send({ type: 'minimize' });
  await settled();
  check('a minimize during the startup read is not undone by the snapshot', boot.window().minimized, true);
  check('and the panel stays collapsed', boot.lastResize(), [70, 70]);

  boot = bootPlugin({});
  await settled();
  boot.send({ type: 'resize', width: 50, height: 50 });
  check('a resize below the minimum is clamped', boot.lastResize(), [200, 260]);

  boot = bootPlugin({});
  await settled();
  boot.send({ type: 'resize', width: 999999, height: 999999 });
  check('a resize above the maximum is clamped', boot.lastResize(), [800, 720]);

  // Width and height move independently, so an edge grip can widen the panel
  // without dragging its height along.
  boot = bootPlugin({ duckWindow: { width: 300, height: 400, minimized: false } });
  await settled();
  boot.send({ type: 'resize', width: 700, height: 400 });
  check('a width-only drag leaves the height alone', boot.lastResize(), [700, 400]);
  boot.send({ type: 'resize', width: 700, height: 650 });
  check('a height-only drag leaves the width alone', boot.lastResize(), [700, 650]);

  // The escape hatch for a panel dragged bigger than the Figma window, where
  // every right-anchored control is off screen.
  boot = bootPlugin({ duckWindow: { width: 760, height: 700, minimized: false } });
  await settled();
  boot.send({ type: 'reset-size' });
  await settled();
  check('reset-size returns the panel to the default', boot.lastResize(), [280, 380]);
  check('and writes it through immediately', boot.state.duckWindow.width, 280);

  // A panel minimized and then reset must come back open, not stay a duck.
  boot = bootPlugin({ duckWindow: { width: 760, height: 700, minimized: true } });
  await settled();
  boot.send({ type: 'reset-size' });
  await settled();
  check('reset-size also un-minimizes', boot.window(), { type: 'window', width: 280, height: 380, minimized: false, textSize: 11 });

  // A message handler should not trust the sender's claimed state: a resize
  // arriving while minimized (a lost pointerup leaving a drag stuck active,
  // say) must not stretch the collapsed 70x70 duck across a full window.
  boot = bootPlugin({ duckWindow: { width: 300, height: 400, minimized: true } });
  await settled();
  const minimizedResizeCount = boot.resizes.length;
  boot.send({ type: 'resize', width: 500, height: 600 });
  check('a resize while minimized does not move the panel', boot.resizes.length, minimizedResizeCount);
  check('the panel stays at the collapsed size', boot.lastResize(), [70, 70]);
  check('and nothing is persisted from it', boot.state.duckWindow, { width: 300, height: 400, minimized: true });

  // Text size is a display preference, so it rides with the geometry rather
  // than with a settings object, whose saves have to stay whole-object.
  boot = bootPlugin({});
  await settled();
  boot.send({ type: 'text-size', size: 15 });
  await settled();
  check('a text size nudge is persisted with the geometry', boot.state.duckWindow.textSize, 15);
  check('and reported back so the UI can apply it', boot.window().textSize, 15);
  boot.send({ type: 'text-size', size: 99 });
  await settled();
  check('an out of range text size is clamped', boot.window().textSize, 18);

  boot = bootPlugin({ duckWindow: { width: 300, height: 400, minimized: false, textSize: 16 } });
  await settled();
  check('a saved text size is restored on startup', boot.window().textSize, 16);

  boot = bootPlugin({ duckSettings: { provider: 'openai', key: 'sk-secret' }, duckClientId: 'client-01' });
  await settled();
  check('legacy provider settings are ignored, not posted',
    boot.sent.filter((m) => m.type === 'settings').length, 0);
};
