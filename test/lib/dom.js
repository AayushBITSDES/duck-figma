/*
 * Fake DOM, good for exactly what the ui screens touch: getElementById,
 * innerHTML (which re-renders the fake tree), one createElement used only for
 * HTML-escaping, querySelectorAll (nothing under test reads its result, so it
 * just returns nothing), a body.classList stub, and the handful of element
 * properties the assertions in screens.test.js read back.
 *
 * getElementById returns null for any id not present in whatever HTML was
 * last actually assigned to #root, the same as a real DOM would for an id
 * nothing painted. A version that handed back a fresh dummy object for any
 * id ever asked, painted or not, is what let render() returning early while
 * collapsed (see render.ts) go unnoticed: production code kept dereferencing
 * elements from a screen that was never repainted, and the fake never threw
 * to show it, where a browser would.
 *
 * install() is called once, at the start of that file's run(): a render()
 * call clears out the previous screen's elements itself (see rerender
 * below), the same way a real DOM replace would, so scenarios do not need to
 * reset this between each other.
 */
const els = {};
// The last HTML actually written to #root. Nothing has painted yet at
// startup, so only 'root' itself (never part of its own content) resolves.
let currentHtml = '';

function el(id) {
  if (!els[id]) {
    els[id] = {
      id: id, value: '', dataset: {}, scrollTop: 0, scrollHeight: 0,
      onclick: null, onchange: null, oninput: null, focus: () => {}, _html: '',
      set innerHTML(v) { this._html = v; if (id === 'root') rerender(v); },
      get innerHTML() { return this._html; },
      set textContent(v) {
        this._html = String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      },
    };
  }
  return els[id];
}
// A real render replaces the DOM, so stale nodes and anything typed into them
// are gone. Without this the stub leaks one screen's input into the next.
function rerender(html) {
  currentHtml = html;
  for (const k of Object.keys(els)) if (k !== 'root') delete els[k];
  const unescape = (v) => v.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  const selected = /<option value="([^"]+)" selected>/.exec(html);
  if (selected) el('text-size').value = unescape(selected[1]);
}

// The gate a real getElementById applies before this stub hands back
// anything: an id nothing painted does not resolve to an element, whether
// or not this stub has been asked for it before.
function getElementById(id) {
  if (id !== 'root' && currentHtml.indexOf('id="' + id + '"') === -1) return null;
  return el(id);
}

// Only #grip's visibility runs through this in practice (see bridge.ts's
// 'window' handler), so it needs nothing beyond add/remove/toggle/contains.
const bodyClasses = new Set();
const body = {
  classList: {
    add: (c) => bodyClasses.add(c),
    remove: (c) => bodyClasses.delete(c),
    toggle: (c, on) => (on === undefined ? (bodyClasses.has(c) ? bodyClasses.delete(c) : bodyClasses.add(c)) : (on ? bodyClasses.add(c) : bodyClasses.delete(c))),
    contains: (c) => bodyClasses.has(c),
  },
};

const posted = [];
const windowListeners = [];

function install() {
  currentHtml = '';
  for (const k of Object.keys(els)) delete els[k];
  bodyClasses.clear();
  posted.length = 0;
  windowListeners.length = 0;
  global.document = {
    getElementById, createElement: () => el('tmp' + Math.random()), querySelectorAll: () => [], body,
    activeElement: null,
    // applyTextSize's only touch on the DOM: a CSS variable on the root element.
    documentElement: { style: { setProperty: () => {} } },
  };
  global.parent = { postMessage: (m) => posted.push(m.pluginMessage) };
  global.window = {
    addEventListener: (type, fn) => { windowListeners.push({ type, fn }); },
  };
  global.location = { hostname: 'www.figma.com' };
}

module.exports = {
  el,
  body,
  posted,
  windowListeners,
  install,
};
