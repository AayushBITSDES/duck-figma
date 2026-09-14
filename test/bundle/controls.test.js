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
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const REPO = path.join(__dirname, '..', '..');
const { ok } = require('../lib/check');

const html = fs.readFileSync(path.join(REPO, 'dist/ui.html'), 'utf8');
const bundleSrc = /<script[^>]*>([\s\S]*?)<\/script>/.exec(html)[1];
const codeSrc = fs.readFileSync(path.join(REPO, 'dist/code.js'), 'utf8');

/*
 * Stands both halves up and connects them, so this exercises the real message
 * contract rather than a guess at it.
 */
function wire() {
  const dom = new JSDOM(html.replace(/<script[\s\S]*?<\/script>/, ''), {
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
  const win = dom.window;

  const store = {};
  const resizes = [];
  let uiHandler = null;

  const figma = {
    showUI: () => {},
    ui: {
      postMessage: (m) => win.onmessage && win.onmessage({ data: { pluginMessage: m } }),
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
    currentPage: { findAll: () => [], selection: [] },
    viewport: { center: { x: 0, y: 0 } },
    activeUsers: [{ position: { x: 1, y: 2 }, viewport: { x: 0, y: 0, width: 100, height: 100 } }],
    on: () => {},
    notify: () => {},
    createSticky: () => ({ text: { characters: '', fontName: {} }, remove: () => {} }),
    loadFontAsync: async () => {},
  };

  // The UI's outgoing messages go straight into the plugin's handler, which is
  // what makes this an integration test rather than two separate mocks.
  Object.defineProperty(win, 'parent', {
    value: { postMessage: (m) => uiHandler && uiHandler(m.pluginMessage) },
    writable: true,
  });
  win.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

  // jsdom implements pointer capture as a no-op pair that throws on an
  // uncaptured id, so these keep ui.ts's capture calls from blowing up.
  win.Element.prototype.setPointerCapture = function () {};
  win.Element.prototype.releasePointerCapture = function () {};
  win.Element.prototype.hasPointerCapture = function () { return false; };

  const ticks = [];
  new Function('figma', '__html__', 'setInterval', 'clearTimeout', 'setTimeout', codeSrc)(
    figma, '<html></html>', (fn) => { ticks.push(fn); return 0; }, (id) => clearTimeout(id), (fn, ms) => setTimeout(fn, ms));
  win.eval(bundleSrc);

  return { win, doc: win.document, store, resizes, figma, ticks };
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

module.exports = async function run() {
  console.log('[A] the collapse button, clicked for real');
  {
    const { doc, resizes, store } = wire();
    await wait(60);
    const min = doc.getElementById('min');
    ok('the idle screen draws a collapse button', min !== null);
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
    await wait(60);
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
    await wait(60);
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
    await wait(60);
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

  console.log('\n[E] going quiet while collapsed really does pop the panel open');
  {
    const { doc, resizes, ticks } = wire();
    await wait(60);
    click(doc.getElementById('min'));
    await wait(30);
    ok('the duck is collapsed and resting', doc.getElementById('collapsed') !== null);
    const before = resizes.length;

    // Fast-forward past IDLE_THRESHOLD_MS and run the poll that idle.ts
    // registered, rather than waiting 20 real seconds for it.
    const realNow = Date.now;
    Date.now = () => realNow() + 25000;
    ticks.forEach((fn) => fn());
    Date.now = realNow;
    await wait(40);

    const last = resizes[resizes.length - 1];
    ok('the window pops itself open', resizes.length > before && last[0] >= 240 && last[1] >= 320,
       JSON.stringify(last));
    ok('and the duck is actually asking, not just a bigger empty panel',
       /How are you doing/.test(doc.getElementById('root').innerHTML),
       doc.getElementById('root').innerHTML.slice(0, 200));
    ok('with the mood buttons ready', doc.querySelector('button[data-m]') !== null);
  }

  console.log('\n[E2] going quiet mid-conversation does NOT pop it open');
  {
    const { doc, resizes, ticks } = wire();
    await wait(60);
    // Into a chat first, then collapse, so the reported mode is not idle.
    const duck = doc.getElementById('duck');
    if (duck) click(duck);
    await wait(30);
    const mood = doc.querySelector('button[data-m]');
    if (mood) click(mood);
    await wait(80);
    click(doc.getElementById('min'));
    await wait(30);
    const before = resizes.length;

    const realNow = Date.now;
    Date.now = () => realNow() + 25000;
    ticks.forEach((fn) => fn());
    Date.now = realNow;
    await wait(40);

    ok('the window stays collapsed instead of growing to ask nothing',
       resizes.length === before, (resizes.length - before) + ' stray resizes');
    ok('and the duck is still the duck', doc.getElementById('collapsed') !== null);
  }

  console.log('\n[F] the text size control, changed for real');
  {
    const { doc, store } = wire();
    await wait(80);
    doc.getElementById('settings') && click(doc.getElementById('settings'));
    await wait(40);
    const size = doc.getElementById('text-size');
    ok('the settings screen offers a text size', size !== null,
       'root: ' + doc.getElementById('root').innerHTML.slice(0, 200));
    if (size) {
      const key = doc.getElementById('key-input');
      if (key) {
        key.value = 'sk-or-v1-pasted-by-hand';
        key.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true }));
      }
      size.value = '16';
      size.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true }));
      await wait(40);
      ok('the panel font size really changes',
         doc.documentElement.style.getPropertyValue('--duck-font') === '16px',
         'got: ' + JSON.stringify(doc.documentElement.style.getPropertyValue('--duck-font')));
      const after = doc.getElementById('key-input');
      ok('and the key the user just pasted is still in the field',
         after && after.value === 'sk-or-v1-pasted-by-hand',
         'got: ' + JSON.stringify(after && after.value));
      await wait(500);
      ok('the text size is persisted with the geometry',
         store.duckWindow && store.duckWindow.textSize === 16,
         JSON.stringify(store.duckWindow));
    }
  }

};
