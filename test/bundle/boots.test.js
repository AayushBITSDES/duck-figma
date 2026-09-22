/*
 * Boots the ACTUAL shipped artifacts (dist/ui.html and dist/code.js) rather
 * than the CommonJS build the unit tests use. The unit tests compile with
 * tsc --module commonjs; FigJam loads a webpack ESM bundle. Circular imports
 * resolve differently between the two, so only this can prove the shipped
 * thing boots.
 *
 * Session traffic used to be a check-in plus four client-side model hosts.
 * The facilitator now speaks only inside an explicit group session, over a
 * WebSocket the iframe opens after the plugin posts identity. jsdom has no
 * socket, so a fake Durable Object (fake-ws.js) answers join/presence/round
 * frames. Two windows that share that hub have to see the same people.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { createHub } = require('./fake-ws');

const REPO = path.join(__dirname, '..', '..');
const { ok } = require('../lib/check');

const html = fs.readFileSync(path.join(REPO, 'dist/ui.html'), 'utf8');
const scriptMatch = /<script[^>]*>([\s\S]*?)<\/script>/.exec(html);
if (!scriptMatch) throw new Error('no inline script in dist/ui.html, was npm run build skipped?');
const bundleSrc = scriptMatch[1];
const codeSrc = fs.readFileSync(path.join(REPO, 'dist/code.js'), 'utf8');
console.log('bundle: ' + (bundleSrc.length / 1024).toFixed(1) + ' KiB of inlined script');

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

function bootUi(hub, opts) {
  const options = opts || {};
  const dom = new JSDOM(html.replace(/<script[\s\S]*?<\/script>/, ''), {
    pretendToBeVisual: true,
    runScripts: 'outside-only',
    url: 'https://www.figma.com/',
  });
  const win = dom.window;
  const sent = [];
  const board = options.board || ['nav | search', 'onboarding copy'];
  Object.defineProperty(win, 'parent', {
    value: {
      postMessage: (m) => {
        sent.push(m.pluginMessage);
        if (m.pluginMessage && m.pluginMessage.type === 'get-board') {
          setTimeout(() => {
            if (win.onmessage) {
              win.onmessage({ data: { pluginMessage: { type: 'board-context', board } } });
            }
          }, 0);
        }
      },
    },
    writable: true,
  });
  win.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
  hub.install(win);
  win.eval(bundleSrc);
  const deliver = (m) => win.onmessage({ data: { pluginMessage: m } });
  return {
    win,
    doc: win.document,
    root: win.document.getElementById('root'),
    deliver,
    sent,
  };
}

async function joinSession(ui, session) {
  ui.deliver({ type: 'window', width: 280, height: 380, minimized: false, textSize: 11 });
  ui.deliver({
    type: 'session',
    roomId: session.roomId,
    clientId: session.clientId,
    displayName: session.displayName,
  });
  const ready = await waitUntil(() => ui.root.querySelector('button[data-m]') !== null);
  return ready;
}

function pluginFigma(store, posted, resizes, intervals) {
  const rootData = {};
  const pageData = {};
  const stickyData = {};
  const stickies = [];
  let uiHandler = null;
  return {
    showUI: () => {},
    ui: {
      postMessage: (m) => posted.push(m),
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
    currentUser: { name: 'Ada Lovelace' },
    fileKey: 'abcFileKey',
    root: {
      getPluginData: (k) => rootData[k] || '',
      setPluginData: (k, v) => { rootData[k] = String(v); },
    },
    currentPage: {
      findAll: () => stickies.slice(),
      selection: [],
      getPluginData: (k) => pageData[k] || '',
      setPluginData: (k, v) => { pageData[k] = String(v); },
    },
    viewport: { center: { x: 0, y: 0 } },
    getNodeByIdAsync: async (id) => stickies.filter((s) => s.id === id)[0] || null,
    // A method so the new sticky can go where Figma puts one: the page in
    // view at the moment of the call.
    createSticky() {
      const sticky = {
        id: 'sticky-summary',
        type: 'STICKY',
        parent: this.currentPage,
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
        getPluginData: (k) => stickyData[k] || '',
        setPluginData: (k, v) => { stickyData[k] = String(v); },
        remove: () => { sticky.removed = true; },
      };
      stickies.push(sticky);
      return sticky;
    },
    loadFontAsync: async () => {},
    on: () => {},
    notify: () => {},
    mixed: {},
    _handler: () => uiHandler,
  };
}

module.exports = async function run() {
  console.log('\n[0] shipped artifacts dropped the retired surface');
  const uiHtml = html;
  const pluginJs = codeSrc;
  const both = uiHtml + '\n' + pluginJs;
  const forbidden = [
    ['openrouter domain', /openrouter\.ai/],
    ['openai api domain', /api\.openai\.com/],
    ['anthropic domain', /api\.anthropic\.com/],
    ['google generative-language domain', /generativelanguage\.googleapis\.com/],
    ['API key input', /key-input/],
    ['openrouter key hint', /sk-or-v1/],
    ['x-api-key header', /x-api-key/],
    ['x-goog-api-key header', /x-goog-api-key/],
    ['OPENAI_API_KEY secret name', /OPENAI_API_KEY/],
    ['save-settings message', /save-settings/],
    ['activeUsers idle watch', /activeUsers/],
    ['checkin plugin message', /"checkin"|type:"checkin"/],
    ['quiet-board check-in copy', /Board['’]s been quiet/],
    ['idle-monitoring copy', /board goes quiet/],
    ['old how-are-you prompt', /How are you doing\?/],
  ];
  for (const [name, re] of forbidden) {
    ok('shipped bundles omit ' + name, !re.test(both));
  }
  ok('UI bundle still talks to the session worker', /duck-facilitator/.test(uiHtml));
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'manifest.json'), 'utf8'));
  const allowed = (manifest.networkAccess && manifest.networkAccess.allowedDomains) || [];
  const bundledWss = [...new Set(uiHtml.match(/wss:\/\/[A-Za-z0-9.-]+(?::\d+)?/g) || [])];
  ok('UI bundle includes a wss origin', bundledWss.length > 0, JSON.stringify(bundledWss));
  for (const origin of bundledWss) {
    ok('bundled origin ' + origin + ' is in manifest networkAccess.allowedDomains',
      allowed.indexOf(origin) !== -1,
      'allowedDomains=' + JSON.stringify(allowed));
  }
  ok('UI bundle still offers Update summary', /Update summary/.test(uiHtml));
  ok('plugin bundle still posts session identity', /duckClientId/.test(pluginJs));

  console.log('\n[1] shipped UI bundle boots');
  {
    const hub = createHub();
    const ui = bootUi(hub);
    ok('no exception during module evaluation (circular import)', ui.root !== null);
    ok('paints the connecting session screen',
      /Joining this board/.test(ui.root.innerHTML),
      ui.root.innerHTML.slice(0, 220));
    ok('connecting screen runs the rail instead of a mascot',
      ui.root.querySelector('.rail.loading') !== null && ui.root.querySelector('svg') === null);
  }

  console.log('\n[2] geometry handshake');
  {
    const hub = createHub();
    const ui = bootUi(hub);
    ui.deliver({ type: 'window', width: 280, height: 380, minimized: false, textSize: 11 });
    ok('survives the startup window message', ui.root.innerHTML.length > 0);
    ok('does not paint a provider or API-key form',
      ui.root.querySelector('#provider') === null && ui.root.querySelector('#key-input') === null,
      ui.root.innerHTML.slice(0, 220));
  }

  console.log('\n[3] collapse and expand');
  {
    const hub = createHub();
    const ui = bootUi(hub);
    ui.deliver({ type: 'window', width: 280, height: 380, minimized: true, textSize: 11 });
    const collapsed = ui.root.innerHTML;
    ok('collapsed view paints something', collapsed.length > 0);
    ok('collapsed view is smaller than the full panel', collapsed.length < 4000,
      'collapsed html was ' + collapsed.length + ' chars');
    ok('collapsed view still shows a duck', ui.root.querySelector('svg') !== null);

    ui.deliver({ type: 'window', width: 280, height: 380, minimized: false, textSize: 11 });
    ok('expanding repaints a real screen',
      ui.root.querySelector('#collapsed') === null && /Joining this board/.test(ui.root.innerHTML));
  }

  console.log('\n[4] fake-websocket session: identity, people, round, mood');
  {
    const hub = createHub();
    hub.facilitatorReply = 'Hold that thought.';
    const ada = bootUi(hub);
    const ben = bootUi(hub);
    const roomId = 'room:abcFileKey';
    ok('Ada joined the room', await joinSession(ada, {
      roomId, clientId: 'client-ada-01', displayName: 'Ada',
    }));
    ok('Ben joined the same room', await joinSession(ben, {
      roomId, clientId: 'client-ben-01', displayName: 'Ben',
    }));

    await waitUntil(() => /Ben/.test(ada.root.innerHTML) && /Ada/.test(ben.root.innerHTML));
    ok('Ada sees both participants',
      /Ada \(you\)/.test(ada.root.innerHTML) && /Ben/.test(ada.root.innerHTML),
      ada.root.innerHTML.slice(0, 400));
    ok('Ben sees both participants',
      /Ben \(you\)/.test(ben.root.innerHTML) && /Ada/.test(ben.root.innerHTML),
      ben.root.innerHTML.slice(0, 400));
    ok('round 1 still asks for a state',
      /Choose how you are doing/.test(ada.root.innerHTML),
      ada.root.querySelector('#round') && ada.root.querySelector('#round').textContent);

    const moodBtn = ada.root.querySelector('button[data-m="stuck"]') || ada.root.querySelector('button[data-m]');
    ok('mood buttons are wired', moodBtn !== null);
    if (moodBtn) {
      moodBtn.onclick();
      const parsedSent = () => hub.sockets.map((s) => s.sent.map((raw) => {
        try { return JSON.parse(raw); } catch (_) { return null; }
      })).reduce((all, msgs) => all.concat(msgs), []);
      await waitUntil(() => parsedSent().some((m) => m && m.type === 'set-state'), 600);
      const act = parsedSent().filter((m) => m && m.type === 'set-state').pop();
      ok('clicking a mood sends set-state over the socket',
        !!(act && act.mood && act.roundId === 1),
        JSON.stringify(act));
      ok('and quotes the board on that action',
        !!(act && Array.isArray(act.board) && act.board.indexOf('nav | search') !== -1),
        JSON.stringify(act && act.board));
    }

    await waitUntil(() => /feeling Stuck/.test(ada.root.innerHTML) && /feeling Stuck/.test(ben.root.innerHTML));
    ok('Ada\'s state is in both threads',
      /feeling Stuck/.test(ada.root.innerHTML) && /feeling Stuck/.test(ben.root.innerHTML));
    ok('Ada is waiting on Ben rather than expanding a chat composer',
      /Waiting on Ben/.test(ada.root.innerHTML) && !ada.root.querySelector('#answer'),
      ada.root.querySelector('#round') && ada.root.querySelector('#round').textContent);
    ok('Ben can still take a turn',
      ben.root.querySelector('button[data-m]') !== null);

    const benMood = ben.root.querySelector('button[data-m="thinking"]') || ben.root.querySelector('button[data-m]');
    ok('Ben still has a mood to click', benMood !== null);
    if (benMood) {
      benMood.onclick();
      await waitUntil(() =>
        /Hold that thought/.test(ada.root.innerHTML) && /Hold that thought/.test(ben.root.innerHTML), 800);
    }
    ok('both windows get the same round-1 facilitator reply',
      /Hold that thought/.test(ada.root.innerHTML) && /Hold that thought/.test(ben.root.innerHTML),
      ada.root.innerHTML.slice(0, 400));

    hub.facilitatorReply = 'One reply for the pair.';
    const passReady = await waitUntil(() =>
      ada.root.querySelector('#pass') !== null && ben.root.querySelector('#pass') !== null, 800);
    ok('round 2 wires Pass in both windows', passReady,
      'ada pass=' + !!ada.root.querySelector('#pass') + ' ben pass=' + !!ben.root.querySelector('#pass'));
    const adaPass = ada.root.querySelector('#pass');
    if (adaPass) adaPass.onclick();
    await waitUntil(() => /passed/.test(ada.root.innerHTML) && /passed/.test(ben.root.innerHTML), 800);
    const benPass = ben.root.querySelector('#pass');
    ok('Ben\'s Pass is still there after Ada passes', benPass !== null);
    if (benPass) benPass.onclick();
    await waitUntil(() =>
      /One reply for the pair/.test(ada.root.innerHTML) && /One reply for the pair/.test(ben.root.innerHTML), 800);
    ok('Pass completes the round with one shared facilitator reply',
      /One reply for the pair/.test(ada.root.innerHTML) && /One reply for the pair/.test(ben.root.innerHTML),
      ada.root.innerHTML.slice(-400));

    const sock = hub.lastSocket();
    ok('the socket opened the opaque document room',
      !!(sock && /roomId=room%3AabcFileKey|roomId=room:abcFileKey/.test(sock.url)),
      sock && sock.url);
  }

  console.log('\n[5] markdown rendering, in a real DOM, from untrusted facilitator text');
  // Drives the real render path: the bundle is a closure, so the only honest
  // way in is a facilitator frame on the session socket.
  async function bubbleFor(reply) {
    const hub = createHub();
    const ui = bootUi(hub);
    await joinSession(ui, {
      roomId: 'room:md',
      clientId: 'client-md-01',
      displayName: 'Ada',
    });
    const sock = hub.lastSocket();
    sock.deliver({
      type: 'message',
      message: {
        id: 'fac-md',
        at: Date.now(),
        kind: 'facilitator',
        author: { clientId: 'facilitator', displayName: 'Duck' },
        text: reply,
      },
    });
    return { win: ui.win, root: ui.root };
  }

  const cases = [
    ['bold', 'That is **important** here.', (h) => /<strong>important<\/strong>/.test(h)],
    ['italic', 'That is *soft* here.', (h) => /<em>soft<\/em>/.test(h)],
    ['inline code', 'Try `npm test` now.', (h) => /<code>npm test<\/code>/.test(h)],
    ['bullets', '- one\n- two', (h) => /<ul><li>one<\/li><li>two<\/li><\/ul>/.test(h)],
    ['fenced code', 'Run:\n\n```js\nlet x = 1;\n```', (h) => /<pre><code>let x = 1;<\/code><\/pre>/.test(h)],
    ['digits survive', 'I see 3 things and 12 more.', (h) => /3 things and 12 more/.test(h)],
  ];

  for (const [name, reply, want] of cases) {
    const { root: r } = await bubbleFor(reply);
    ok('markdown: ' + name, want(r.innerHTML), r.innerHTML.slice(-400));
  }

  console.log('\n[6] injection attempts from the model');
  const attacks = [
    ['img onerror', '<img src=x onerror=alert(1)>'],
    ['markdown link with javascript url', '[click](javascript:alert(1))'],
    ['raw script tag', '<script>alert(1)</script>'],
    ['svg onload', '<svg onload=alert(1)>'],
    ['unclosed fence', '```js\nlet x = 1;'],
    ['nul sentinel forgery', 'see \x000\x00 here'],
  ];
  for (const [name, reply] of attacks) {
    const { root: r } = await bubbleFor(reply);
    const liveImg = r.querySelectorAll('img').length;
    const liveScript = r.querySelectorAll('script').length;
    const anchors = r.querySelectorAll('a').length;
    // Walk real DOM attributes. A regex over innerHTML gives false positives,
    // because correctly-escaped text like &lt;img onerror=x&gt; still contains
    // the literal characters " onerror=" while being completely inert.
    let onAttr = false;
    r.querySelectorAll('*').forEach((el) => {
      for (const a of Array.from(el.attributes)) {
        if (/^on/i.test(a.name)) onAttr = true;
      }
    });
    ok('inert: ' + name,
      liveImg === 0 && liveScript === 0 && anchors === 0 && !onAttr,
      'img=' + liveImg + ' script=' + liveScript + ' a=' + anchors + ' onAttr=' + onAttr);
  }

  console.log('\n[7] shipped plugin bundle boots against a stubbed figma api');
  {
    const store = {};
    const posted = [];
    const resizes = [];
    const intervals = [];
    const figma = pluginFigma(store, posted, resizes, intervals);
    let uiHandler = null;
    Object.defineProperty(figma.ui, 'onmessage', {
      get: () => uiHandler,
      set: (fn) => { uiHandler = fn; },
    });
    let codeBootError = null;
    try {
      new Function('figma', '__html__', 'setInterval', 'clearTimeout', 'setTimeout', codeSrc)(
        figma, '<html></html>', (fn) => { intervals.push(fn); return 0; }, () => {}, (fn) => { fn(); return 0; });
    } catch (e) { codeBootError = e; }
    ok('plugin bundle evaluates', !codeBootError,
      codeBootError ? codeBootError.stack.split('\n').slice(0, 3).join('\n    ') : '');

    if (!codeBootError) {
      await wait(60);
      ok('registers a ui message handler', typeof uiHandler === 'function');
      ok('sends the ui its startup messages', posted.length > 0,
        'posted: ' + JSON.stringify(posted.map((p) => p.type)));
      const types = posted.map((p) => p.type);
      ok('posts session identity rather than provider settings',
        types.indexOf('session') !== -1 && types.indexOf('settings') === -1,
        JSON.stringify(types));
      ok('does not post a check-in', types.indexOf('checkin') === -1, JSON.stringify(types));
      const session = posted.filter((p) => p.type === 'session').pop();
      const opaqueRoom = figma.root.getPluginData('duckRoomId');
      ok('session uses an opaque document room, not the file key',
        !!(session && session.roomId === 'room:' + opaqueRoom && session.roomId.indexOf('abcFileKey') === -1 &&
          session.displayName === 'Ada Lovelace' && session.clientId),
        JSON.stringify(session));
      ok('that room token is stored on the document',
        typeof opaqueRoom === 'string' && opaqueRoom.length > 0, JSON.stringify(opaqueRoom));
      ok('client id is persisted for the next boot',
        typeof store.duckClientId === 'string' && store.duckClientId === session.clientId,
        JSON.stringify(store.duckClientId));
      ok('plugin registered no idle poll', intervals.length === 0,
        intervals.length + ' intervals');

      if (typeof uiHandler === 'function') {
        const before = resizes.length;
        uiHandler({ type: 'minimize' });
        await wait(20);
        ok('minimize resizes to the 70px floor',
          resizes.length > before && resizes[resizes.length - 1][0] === 70,
          JSON.stringify(resizes));

        const collapsedAt = resizes.length;
        intervals.forEach((fn) => fn());
        await wait(20);
        ok('leftover timers do not pop the collapsed duck open',
          resizes.length === collapsedAt, JSON.stringify(resizes.slice(collapsedAt)));

        uiHandler({ type: 'expand' });
        await wait(20);
        const last = resizes[resizes.length - 1];
        ok('expand restores a usable panel', last[0] >= 200 && last[1] >= 260, JSON.stringify(last));

        uiHandler({ type: 'resize', width: 10, height: 10 });
        await wait(20);
        const clamped = resizes[resizes.length - 1];
        ok('an absurd resize is clamped, not applied',
          clamped[0] >= 200 && clamped[1] >= 260, JSON.stringify(clamped));
      }
    }
  }

  console.log('\n[8] socket loss during board wait keeps the contribution draft');
  {
    const hub = createHub();
    hub.facilitatorReply = 'Round one is in.';
    const ui = bootUi(hub);
    ok('Ada joined for a drop-during-send', await joinSession(ui, {
      roomId: 'room:dropBoard',
      clientId: 'client-drop-01',
      displayName: 'Ada',
    }));
    const mood = ui.root.querySelector('button[data-m="fine"]') || ui.root.querySelector('button[data-m]');
    ok('round 1 has a mood to click', mood !== null);
    if (mood) mood.onclick();
    const composerReady = await waitUntil(() => ui.root.querySelector('#answer') !== null, 800);
    ok('round 2 paints a composer', composerReady);
    const answer = ui.root.querySelector('#answer');
    if (answer) {
      answer.value = 'keep this thought';
      answer.dispatchEvent(new ui.win.Event('input', { bubbles: true }));
    }
    const firstSock = hub.lastSocket();
    const send = ui.root.querySelector('#send');
    ok('Send is wired', send !== null && firstSock !== null);
    if (send && firstSock) {
      send.onclick();
      firstSock.close();
      await wait(40);
      ok('a drop during board wait shows reconnecting',
        /Reconnecting/.test(ui.root.innerHTML),
        ui.root.innerHTML.slice(0, 400));
      ok('and shows that the send did not go through',
        /Could not send/.test(ui.root.innerHTML),
        ui.root.innerHTML.slice(-400));
      const contributed = firstSock.sent.some((raw) => {
        try { return JSON.parse(raw).type === 'contribute'; } catch (_) { return false; }
      });
      ok('and the dropped socket never got contribute', !contributed,
        JSON.stringify(firstSock.sent));
      const restored = await waitUntil(() => {
        const ta = ui.root.querySelector('#answer');
        return !!(ta && ta.value === 'keep this thought');
      }, 1200);
      ok('and the draft returns after reconnect', restored,
        (ui.root.querySelector('#answer') && ui.root.querySelector('#answer').value) ||
        ui.root.innerHTML.slice(0, 400));
    }
  }
};
