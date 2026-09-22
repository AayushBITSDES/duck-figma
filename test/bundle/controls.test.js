/*
 * Drives the shipped UI bundle with REAL pointer and click events, end to end
 * against the real plugin bundle, instead of hand-posting messages at it.
 *
 * The unit tests call exported functions and the earlier smoke test delivered
 * messages by hand. Neither touches the controls a person actually uses: the
 * resize grip, the collapse button, and the collapsed duck. Those are wired
 * with addEventListener in ui.ts, and nothing anywhere has ever fired an event
 * at them. This does, and it wires the two bundles to each other so a click on
 * one side really does drive figma.ui.resize on the other.
 *
 * The iframe opens a session socket after the plugin posts identity. A fake
 * Worker (fake-ws.js) answers, so a mood click and Update summary run through
 * the real message contract without a hosted Durable Object.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { createHub } = require('./fake-ws');

const REPO = path.join(__dirname, '..', '..');
const { ok } = require('../lib/check');

const html = fs.readFileSync(path.join(REPO, 'dist/ui.html'), 'utf8');
const bundleSrc = /<script[^>]*>([\s\S]*?)<\/script>/.exec(html)[1];
const codeSrc = fs.readFileSync(path.join(REPO, 'dist/code.js'), 'utf8');

function makeSticky(id) {
  const data = {};
  const sticky = {
    id: id || 'sticky-summary',
    type: 'STICKY',
    name: '',
    x: 0,
    y: 0,
    width: 240,
    height: 240,
    removed: false,
    text: {
      characters: '',
      fontName: { family: 'Inter', style: 'Regular' },
      getRangeAllFontNames: () => [],
    },
    getPluginData: (k) => data[k] || '',
    setPluginData: (k, v) => { data[k] = String(v); },
    remove: () => { sticky.removed = true; },
  };
  return sticky;
}

/*
 * Stands both halves up and connects them, so this exercises the real message
 * contract rather than a guess at it. Plugin -> UI posts are deferred a tick
 * so requestBoard's waiter is registered before board-context lands — Figma
 * queues pluginMessage; a fully sync stub would miss it and sit out the
 * 1500ms board timeout.
 */
function wire(opts) {
  const options = opts || {};
  const hub = options.hub || createHub();
  const dom = new JSDOM(html.replace(/<script[\s\S]*?<\/script>/, ''), {
    pretendToBeVisual: true,
    runScripts: 'outside-only',
    url: 'https://www.figma.com/',
  });
  const win = dom.window;

  const store = Object.assign({
    duckClientId: options.clientId || 'client-ada-wire1',
  }, options.store || {});
  const resizes = [];
  const stickies = [];
  const rootData = options.rootData || {};
  const pageData = {};
  let uiHandler = null;

  const figma = {
    showUI: () => {},
    ui: {
      postMessage: (m) => {
        setTimeout(() => {
          if (win.onmessage) win.onmessage({ data: { pluginMessage: m } });
        }, 0);
      },
      resize: (w, h) => resizes.push([w, h]),
      reposition: () => {},
      get onmessage() { return uiHandler; },
      set onmessage(fn) { uiHandler = fn; },
    },
    clientStorage: {
      getAsync: async (k) => store[k],
      setAsync: async (k, v) => { store[k] = v; },
      deleteAsync: async (k) => { delete store[k]; },
    },
    currentUser: { name: options.displayName || 'Ada' },
    fileKey: options.fileKey || 'sharedFile',
    root: {
      getPluginData: (k) => rootData[k] || '',
      setPluginData: (k, v) => { rootData[k] = String(v); },
    },
    currentPage: {
      findAll: () => stickies.filter((s) => !s.removed),
      selection: [],
      getPluginData: (k) => pageData[k] || '',
      setPluginData: (k, v) => { pageData[k] = String(v); },
    },
    viewport: { center: { x: 40, y: 60 } },
    getNodeByIdAsync: async (id) => stickies.filter((s) => s.id === id)[0] || null,
    createSticky: () => {
      const sticky = makeSticky('sticky-' + (stickies.length + 1));
      // Where Figma puts one: the page in view at the moment of the call.
      sticky.parent = figma.currentPage;
      stickies.push(sticky);
      return sticky;
    },
    loadFontAsync: async () => {},
    on: () => {},
    notify: () => {},
    mixed: {},
  };

  Object.defineProperty(win, 'parent', {
    value: { postMessage: (m) => uiHandler && uiHandler(m.pluginMessage) },
    writable: true,
  });
  win.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
  hub.install(win);

  win.Element.prototype.setPointerCapture = function () {};
  win.Element.prototype.releasePointerCapture = function () {};
  win.Element.prototype.hasPointerCapture = function () { return false; };

  const ticks = [];
  win.eval(bundleSrc);
  new Function('figma', '__html__', 'setInterval', 'clearTimeout', 'setTimeout', codeSrc)(
    figma, '<html></html>', (fn) => { ticks.push(fn); return 0; }, (id) => clearTimeout(id), (fn, ms) => setTimeout(fn, ms));

  return { win, doc: win.document, store, resizes, figma, ticks, hub, stickies };
}

function pointer(el, type, x, y) {
  const ev = new el.ownerDocument.defaultView.Event(type, { bubbles: true, cancelable: true });
  ev.clientX = x;
  ev.clientY = y;
  ev.pointerId = 1;
  el.dispatchEvent(ev);
}

function click(el) {
  el.dispatchEvent(new el.ownerDocument.defaultView.Event('click', { bubbles: true, cancelable: true }));
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(pred, ms) {
  const budget = ms == null ? 800 : ms;
  const t0 = Date.now();
  while (Date.now() - t0 < budget) {
    if (pred()) return true;
    await wait(10);
  }
  return !!pred();
}

async function waitForSession(doc) {
  return waitUntil(() => doc.querySelector('button[data-m]') !== null || doc.getElementById('thread') !== null);
}

module.exports = async function run() {
  console.log('[A] the collapse button, clicked for real');
  {
    const { doc, resizes, store } = wire();
    await waitForSession(doc);
    const min = doc.getElementById('min');
    ok('the session screen draws a collapse button', min !== null);
    if (min) {
      click(min);
      await wait(30);
      const last = resizes[resizes.length - 1];
      ok('clicking it collapses the window to the duck', last && last[0] === 70 && last[1] === 70,
        JSON.stringify(resizes));
      ok('the panel repaints as the collapsed duck',
        doc.getElementById('collapsed') !== null,
        doc.getElementById('root').innerHTML.slice(0, 160));
      ok('the body is marked so the stylesheet hides the grip',
        doc.body.classList.contains('min'));
      await wait(500);
      ok('the collapsed state is persisted', store.duckWindow && store.duckWindow.minimized === true,
        JSON.stringify(store.duckWindow));
    }
  }

  console.log('\n[B] clicking the collapsed duck brings the panel back');
  {
    const { doc, resizes } = wire();
    await waitForSession(doc);
    click(doc.getElementById('min'));
    await wait(30);
    const duck = doc.getElementById('collapsed');
    ok('the collapsed duck is in the DOM to be clicked', duck !== null);
    if (duck) {
      // Click the svg inside it, the way a real cursor would land, to prove
      // the delegated closest('#collapsed') lookup is doing the work.
      const target = duck.querySelector('svg') || duck;
      click(target);
      await wait(30);
      const last = resizes[resizes.length - 1];
      ok('clicking the duck restores a usable panel', last && last[0] >= 240 && last[1] >= 320,
        JSON.stringify(last));
      ok('and the full screen is painted again', doc.getElementById('min') !== null);
      ok('and the grip is unhidden', !doc.body.classList.contains('min'));
    }
  }

  console.log('\n[C] dragging the resize grip');
  {
    const { doc, resizes, store } = wire();
    await waitForSession(doc);
    const grip = doc.getElementById('grip');
    ok('the panel draws a resize grip', grip !== null);
    if (grip) {
      pointer(grip, 'pointerdown', 280, 380);
      for (let i = 0; i < 12; i++) pointer(grip, 'pointermove', 300 + i * 15, 400 + i * 12);
      pointer(grip, 'pointerup', 465, 524);
      const last = resizes[resizes.length - 1];
      ok('the drag resizes the window', last && last[0] > 280 && last[1] > 380, JSON.stringify(last));
      ok('every move applies immediately, not just the last', resizes.length > 5,
        resizes.length + ' resize calls');
      const during = store.duckWindow;
      await wait(500);
      ok('but the drag is only written to storage once it settles',
        during === undefined && store.duckWindow !== undefined,
        'during=' + JSON.stringify(during) + ' after=' + JSON.stringify(store.duckWindow));
      ok('and the size that persisted is the one it ended on',
        store.duckWindow.width === last[0] && store.duckWindow.height === last[1],
        JSON.stringify(store.duckWindow) + ' vs ' + JSON.stringify(last));
    }
  }

  console.log('\n[D] the grip is dead while collapsed');
  {
    const { doc, resizes } = wire();
    await waitForSession(doc);
    click(doc.getElementById('min'));
    await wait(30);
    const before = resizes.length;
    const grip = doc.getElementById('grip');
    pointer(grip, 'pointerdown', 70, 70);
    for (let i = 0; i < 6; i++) pointer(grip, 'pointermove', 200 + i * 40, 300 + i * 40);
    pointer(grip, 'pointerup', 440, 540);
    await wait(30);
    ok('dragging the hidden grip cannot stretch the collapsed duck',
      resizes.length === before, (resizes.length - before) + ' stray resizes');
  }

  console.log('\n[E] a live session never pops the collapsed duck open');
  {
    const hub = createHub();
    hub.facilitatorReply = 'Stay small.';
    const { doc, resizes, ticks } = wire({ hub, clientId: 'client-ada-stay1' });
    await waitForSession(doc);
    click(doc.getElementById('min'));
    await wait(30);
    ok('the duck is collapsed and resting', doc.getElementById('collapsed') !== null);
    const before = resizes.length;

    const sock = hub.lastSocket();
    if (sock) {
      sock.deliver({
        type: 'presence',
        participants: [
          { clientId: 'client-ada-stay1', displayName: 'Ada', status: 'pending' },
          { clientId: 'client-ben-stay1', displayName: 'Ben', status: 'pending' },
        ],
      });
      sock.deliver({
        type: 'message',
        message: {
          id: 'fac-quiet',
          at: Date.now(),
          kind: 'facilitator',
          author: { clientId: 'facilitator', displayName: 'Duck' },
          text: 'Stay small.',
        },
      });
    }
    ticks.forEach((fn) => fn());
    await wait(40);

    ok('incoming session frames do not resize the window',
      resizes.length === before, JSON.stringify(resizes.slice(before)));
    ok('and the collapsed duck is still the duck',
      doc.getElementById('collapsed') !== null,
      doc.getElementById('root').innerHTML.slice(0, 200));
    ok('plugin registered no idle poll that could have asked',
      ticks.length === 0, ticks.length + ' intervals');
  }

  console.log('\n[F] the text size control, changed for real');
  {
    const { doc, store } = wire();
    await waitForSession(doc);
    doc.getElementById('settings') && click(doc.getElementById('settings'));
    await wait(40);
    ok('settings has no API-key field',
      doc.getElementById('key-input') === null && doc.getElementById('provider') === null,
      doc.getElementById('root').innerHTML.slice(0, 240));
    const size = doc.getElementById('text-size');
    ok('the settings screen offers a text size', size !== null,
      'root: ' + doc.getElementById('root').innerHTML.slice(0, 200));
    if (size) {
      size.value = '16';
      size.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true }));
      await wait(40);
      ok('the panel font size really changes',
        doc.documentElement.style.getPropertyValue('--duck-font') === '16px',
        'got: ' + JSON.stringify(doc.documentElement.style.getPropertyValue('--duck-font')));
      await wait(500);
      ok('the text size is persisted with the geometry',
        store.duckWindow && store.duckWindow.textSize === 16,
        JSON.stringify(store.duckWindow));
    }
  }

  console.log('\n[G] two windows on one fake socket share people and a mood');
  {
    const hub = createHub();
    hub.facilitatorReply = 'Two heads.';
    const sharedRoot = { duckRoomId: 'sync-shared-room' };
    const a = wire({ hub, clientId: 'client-ada-sync1', displayName: 'Ada', fileKey: 'syncFile', rootData: sharedRoot });
    const b = wire({ hub, clientId: 'client-ben-sync1', displayName: 'Ben', fileKey: 'syncFile', rootData: sharedRoot });
    ok('Ada\'s panel joined', await waitForSession(a.doc));
    ok('Ben\'s panel joined', await waitForSession(b.doc));
    await waitUntil(() => /Ben/.test(a.doc.body.innerHTML) && /Ada/.test(b.doc.body.innerHTML));
    ok('Ada sees Ben in presence', /Ben/.test(a.doc.getElementById('presence').innerHTML),
      a.doc.getElementById('presence') && a.doc.getElementById('presence').textContent);
    ok('Ben sees Ada in presence', /Ada/.test(b.doc.getElementById('presence').innerHTML),
      b.doc.getElementById('presence') && b.doc.getElementById('presence').textContent);

    const mood = a.doc.querySelector('button[data-m="stuck"]') || a.doc.querySelector('button[data-m]');
    ok('Ada has a mood to click', mood !== null);
    if (mood) click(mood);
    await waitUntil(() => /feeling Stuck/.test(a.doc.body.innerHTML) && /feeling Stuck/.test(b.doc.body.innerHTML), 800);
    ok('both threads show Ada\'s state',
      /feeling Stuck/.test(a.doc.body.innerHTML) && /feeling Stuck/.test(b.doc.body.innerHTML));
    ok('the round does not complete until Ben acts',
      !/Two heads/.test(a.doc.body.innerHTML) && b.doc.querySelector('button[data-m]') !== null,
      a.doc.getElementById('round') && a.doc.getElementById('round').textContent);

    const benMood = b.doc.querySelector('button[data-m="thinking"]') || b.doc.querySelector('button[data-m]');
    ok('Ben still has a mood to click', benMood !== null);
    if (benMood) click(benMood);
    await waitUntil(() =>
      /Two heads/.test(a.doc.body.innerHTML) && /Two heads/.test(b.doc.body.innerHTML), 800);
    ok('both windows get the same round-1 facilitator reply',
      /Two heads/.test(a.doc.body.innerHTML) && /Two heads/.test(b.doc.body.innerHTML));

    hub.facilitatorReply = 'Pass was enough.';
    const passReady = await waitUntil(() =>
      a.doc.getElementById('pass') !== null && b.doc.getElementById('pass') !== null, 800);
    ok('round 2 paints a Pass control in both windows', passReady);
    const adaPass = a.doc.getElementById('pass');
    ok('Ada\'s Pass is wired', adaPass !== null);
    if (adaPass) click(adaPass);
    await waitUntil(() => /passed/.test(a.doc.body.innerHTML) && /passed/.test(b.doc.body.innerHTML), 800);
    const benPass = b.doc.getElementById('pass');
    ok('Ben can still Pass after Ada does', benPass !== null);
    if (benPass) click(benPass);
    await waitUntil(() =>
      /Pass was enough/.test(a.doc.body.innerHTML) && /Pass was enough/.test(b.doc.body.innerHTML), 800);
    ok('a real Pass click finishes the round with one shared reply',
      /Pass was enough/.test(a.doc.body.innerHTML) && /Pass was enough/.test(b.doc.body.innerHTML),
      a.doc.body.innerHTML.slice(-400));
  }

  console.log('\n[H] mood, facilitator reply, Update summary');
  {
    const hub = createHub();
    hub.facilitatorReply = 'Name the smallest next step.';
    const { doc, stickies } = wire({ hub, clientId: 'client-ada-sum1', displayName: 'Ada' });
    await waitForSession(doc);
    const summary = doc.getElementById('summary');
    ok('Update summary starts disabled, before any facilitator line',
      !!(summary && summary.disabled),
      summary && summary.outerHTML);

    const mood = doc.querySelector('button[data-m="thinking"]') || doc.querySelector('button[data-m]');
    ok('a mood is there to click', mood !== null);
    if (mood) click(mood);
    await waitUntil(() => /Name the smallest next step/.test(doc.body.innerHTML), 800);
    ok('the facilitator reply lands without opening a bigger window',
      /Name the smallest next step/.test(doc.body.innerHTML));
    ok('and the duck does not auto-expand anything — the panel was already open',
      doc.getElementById('collapsed') === null && doc.getElementById('min') !== null);

    const ready = doc.getElementById('summary');
    ok('Update summary is enabled once the duck has spoken',
      !!(ready && !ready.disabled),
      ready && ready.outerHTML);
    if (ready && !ready.disabled) click(ready);
    await waitUntil(() => /Summary updated on the board/.test(doc.body.innerHTML), 800);
    ok('the plugin reports the summary write back into the thread',
      /Summary updated on the board/.test(doc.body.innerHTML),
      doc.body.innerHTML.slice(-300));
    ok('one session summary sticky was written',
      stickies.length === 1 && stickies[0].text.characters === 'Name the smallest next step.',
      JSON.stringify(stickies.map((s) => s.text && s.text.characters)));
  }
};
