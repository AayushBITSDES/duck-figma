/*
 * Fake DOM, good for exactly what the ui screens touch: getElementById,
 * innerHTML (which re-renders the fake tree), one createElement used only for
 * HTML-escaping, querySelectorAll (nothing under test reads its result, so it
 * just returns nothing), and the handful of element properties the
 * assertions in screens.test.js read back.
 *
 * install() is called once, at the start of that file's run(): a render()
 * call clears out the previous screen's elements itself (see rerender
 * below), the same way a real DOM replace would, so scenarios do not need to
 * reset this between each other.
 */
const els = {};
function el(id) {
  if (!els[id]) {
    els[id] = {
      id: id, value: '', dataset: {}, scrollTop: 0, scrollHeight: 0,
      onclick: null, onchange: null, _html: '',
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
  for (const k of Object.keys(els)) if (k !== 'root') delete els[k];
  const unescape = (v) => v.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  const input = /id="key-input"[^>]*\svalue="([^"]*)"/.exec(html);
  if (input) el('key-input').value = unescape(input[1]);
  const selected = /<option value="([^"]+)" selected>/.exec(html);
  if (selected) el('provider').value = selected[1];
}

const posted = [];
let lastCall = null;
// Good enough for any scenario that exercises askDuck() only incidentally,
// i.e. checking loading/mode transitions rather than reply content.
let nextResponse = { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };

function install() {
  global.document = { getElementById: el, createElement: () => el('tmp' + Math.random()), querySelectorAll: () => [] };
  global.parent = { postMessage: (m) => posted.push(m.pluginMessage) };
  global.window = {};
  global.fetch = async (url, opts) => { lastCall = { url, opts }; return nextResponse; };
}

module.exports = {
  el,
  posted,
  install,
  setNextResponse: (r) => { nextResponse = r; },
  getLastCall: () => lastCall,
};
