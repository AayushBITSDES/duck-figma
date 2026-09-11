type Mood = 'stuck' | 'frustrated' | 'thinking' | 'fine';
type ChatMsg = { role: 'user' | 'assistant'; content: string };

const root = document.getElementById('root')!;
let visible = false;
let apiKey: string | null = null;
let messages: ChatMsg[] = [];
let loading = false;
let boardContext = '';

const moodOpeners: Record<Mood, string> = {
  stuck: "I'm feeling stuck.",
  frustrated: "I'm feeling frustrated.",
  thinking: "I'm just thinking things through.",
  fine: "I'm fine, just moving slow.",
};

const fallbackFollowUps = [
  "What's the actual goal on this board?",
  "What have you already tried?",
  "What's the smallest next step you could take?",
  "What would 'done' look like here?",
  "What's one thing you're avoiding right now?",
];
let fallbackIndex = 0;

function post(msg: any) {
  parent.postMessage({ pluginMessage: msg }, '*');
}

function render(html: string) {
  root.innerHTML = html;
}

function boardItemCount(): number {
  return boardContext ? boardContext.split(' | ').filter(Boolean).length : 0;
}

let duckIdCounter = 0;
function duckSvg(size: number) {
  const fid = 'duckSketch' + (duckIdCounter++);
  const h = Math.round(size * 1.2);
  return (
    '<svg width="' + size + '" height="' + h + '" viewBox="0 0 100 120" aria-hidden="true">' +
    '<defs><filter id="' + fid + '" x="-25%" y="-25%" width="150%" height="150%">' +
    '<feTurbulence type="fractalNoise" baseFrequency="0.05" numOctaves="2" seed="4" result="n"/>' +
    '<feDisplacementMap in="SourceGraphic" in2="n" scale="3.4"/>' +
    '</filter></defs>' +
    '<g filter="url(#' + fid + ')" stroke="#C98A1F" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">' +
    '<ellipse cx="50" cy="80" rx="27" ry="31" fill="#FFD35B"/>' +
    '<path d="M23 70 Q12 78 20 92 Q27 85 29 74 Z" fill="#FFC531"/>' +
    '<path d="M77 70 Q88 78 80 92 Q73 85 71 74 Z" fill="#FFC531"/>' +
    '<path d="M72 62 Q86 54 82 70 Q76 66 72 62 Z" fill="#FFC531"/>' +
    '<line x1="41" y1="104" x2="39" y2="110"/>' +
    '<line x1="59" y1="104" x2="61" y2="110"/>' +
    '<ellipse cx="38" cy="113" rx="8" ry="4" fill="#FF9F40"/>' +
    '<ellipse cx="62" cy="113" rx="8" ry="4" fill="#FF9F40"/>' +
    '<circle cx="52" cy="33" r="23" fill="#FFDD70"/>' +
    '<ellipse cx="51" cy="50" rx="11" ry="6" fill="#FF9F40"/>' +
    '<path d="M40 50 L62 50" stroke="#C97116" stroke-width="2"/>' +
    '<circle cx="43" cy="27" r="2.8" fill="#3B2A18" stroke="none"/>' +
    '<circle cx="60" cy="25" r="2.8" fill="#3B2A18" stroke="none"/>' +
    '<ellipse cx="36" cy="37" rx="6" ry="4" fill="#FFAFA0" stroke="none" opacity="0.55"/>' +
    '<ellipse cx="67" cy="33" rx="6" ry="4" fill="#FFAFA0" stroke="none" opacity="0.55"/>' +
    '</g>' +
    '</svg>'
  );
}

function idleDuck() {
  visible = false;
  render(
    '<div style="display:flex; flex-direction:column; align-items:flex-end; gap:6px;">' +
    '<div id="duck" style="cursor:pointer; animation:bob 2.4s ease-in-out infinite;" title="Talk to the duck">' + duckSvg(56) + '</div>' +
    '<button id="settings" style="border:none; background:none; color:#B08900; font-size:11px; cursor:pointer; padding:0;">settings</button>' +
    '</div>'
  );
  document.getElementById('duck')!.onclick = () => {
    post({ type: 'get-board' });
    showCheckIn();
  };
  document.getElementById('settings')!.onclick = showSettings;
}

function showSettings() {
  render(
    '<div class="panel">' +
    '<div style="display:flex; gap:8px; align-items:center; margin-bottom:8px;">' + duckSvg(28) + '<p class="msg" style="margin:0;">Add your Anthropic API key so I can actually talk back and read the board.</p></div>' +
    '<input id="key-input" type="password" placeholder="sk-ant-..." value="' + (apiKey || '') + '" style="width:100%; box-sizing:border-box; padding:6px; border-radius:8px; border:1px solid #ddd; font-size:12px; margin-bottom:8px;" />' +
    '<div class="actions">' +
    '<button id="save-key">Save</button>' +
    (apiKey ? '<button id="clear-key">Remove key</button>' : '') +
    '<button id="back">Back</button>' +
    '</div>' +
    '<p style="font-size:10px; color:#999; margin-top:8px;">Stored locally on this device. Board text and your messages get sent to api.anthropic.com when you chat. Without a key I fall back to canned prompts and won\'t read the board.</p>' +
    '</div>'
  );
  document.getElementById('save-key')!.onclick = () => {
    const val = (document.getElementById('key-input') as HTMLInputElement).value.trim();
    if (val) post({ type: 'save-key', key: val });
    idleDuck();
  };
  const clearBtn = document.getElementById('clear-key');
  if (clearBtn) clearBtn.onclick = () => { post({ type: 'clear-key' }); idleDuck(); };
  document.getElementById('back')!.onclick = idleDuck;
}

function showCheckIn() {
  visible = true;
  render(
    '<div class="panel">' +
    '<div style="display:flex; gap:8px; align-items:center; margin-bottom:8px;">' + duckSvg(32) + '<p class="msg" style="margin:0;">Hey. Board\'s been quiet a bit. How are you doing?</p></div>' +
    '<div class="moods">' +
    '<button data-m="stuck">Stuck</button>' +
    '<button data-m="frustrated">Frustrated</button>' +
    '<button data-m="thinking">Thinking</button>' +
    '<button data-m="fine">Fine, just slow</button>' +
    '</div>' +
    '<button class="dismiss" id="dismiss">Not now</button>' +
    '</div>'
  );
  document.querySelectorAll<HTMLButtonElement>('.moods button').forEach((b) => {
    b.onclick = () => startChat(b.dataset.m as Mood);
  });
  document.getElementById('dismiss')!.onclick = () => {
    post({ type: 'dismiss' });
    idleDuck();
  };
}

function startChat(mood: Mood) {
  messages = [];
  fallbackIndex = -1;
  const opener = moodOpeners[mood];
  if (apiKey) {
    askDuck(opener);
  } else {
    messages.push({ role: 'user', content: opener });
    messages.push({ role: 'assistant', content: fallbackReply(true) });
    renderChat();
  }
}

function fallbackReply(first = false): string {
  fallbackIndex = (fallbackIndex + 1) % fallbackFollowUps.length;
  const line = fallbackFollowUps[fallbackIndex];
  if (first && boardItemCount() > 0) {
    return "I can see " + boardItemCount() + " things already on the board. " + line;
  }
  return line;
}

async function askDuck(userText: string) {
  messages.push({ role: 'user', content: userText });
  loading = true;
  renderChat();
  try {
    const boardNote = boardContext
      ? '\n\nHere is a snapshot of text currently on the board, in no particular order: ' + boardContext
      : '\n\nThe board looks empty right now, or has nothing with text on it.';
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey || '',
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 220,
        system:
          "You are a small yellow rubber duck sitting on a FigJam board, keeping a designer company while they work. Warm, plain, brief, 2 to 4 sentences. Check in on how they are doing before problem solving. Ask one question at a time. Reference specific things from the board snapshot when it helps, otherwise ignore it. Never lecture, never sound like a corporate assistant." +
          boardNote,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
      }),
    });
    const data = await res.json();
    const text = (data && data.content && data.content[0] && data.content[0].text) || "Hmm, lost my train of thought. Try again?";
    messages.push({ role: 'assistant', content: text });
  } catch (e) {
    messages.push({ role: 'assistant', content: "Couldn't reach the server. Check your key or connection, or keep going without me." });
  }
  loading = false;
  renderChat();
}

function renderChat() {
  visible = true;
  let bubbles = '';
  messages.forEach((m) => {
    const isUser = m.role === 'user';
    bubbles +=
      '<div style="display:flex; ' + (isUser ? 'justify-content:flex-end;' : 'justify-content:flex-start; gap:6px;') + ' margin-bottom:6px;">' +
      (isUser ? '' : duckSvg(20)) +
      '<div style="max-width:75%; background:' + (isUser ? '#FFEFC2' : '#F7F7F7') + '; border-radius:10px; padding:6px 9px; font-size:12px; line-height:1.4;">' + escapeHtml(m.content) + '</div>' +
      '</div>';
  });
  if (loading) {
    bubbles += '<div style="display:flex; gap:6px; align-items:center;">' + duckSvg(20) + '<span style="font-size:11px; color:#999;">thinking...</span></div>';
  }
  render(
    '<div class="panel" style="display:flex; flex-direction:column; max-height:300px;">' +
    '<div id="thread" style="overflow-y:auto; flex:1; margin-bottom:8px;">' + bubbles + '</div>' +
    '<textarea id="answer" rows="2" placeholder="Type here..." style="width:100%; box-sizing:border-box; margin-bottom:6px;"></textarea>' +
    '<div class="actions">' +
    '<button id="send">Send</button>' +
    (apiKey ? '<button id="refresh">Look at the board again</button>' : '') +
    '<button id="drop">Drop last reply on board</button>' +
    '<button id="done">I\'m good, thanks</button>' +
    '</div></div>'
  );
  const thread = document.getElementById('thread')!;
  thread.scrollTop = thread.scrollHeight;
  document.getElementById('send')!.onclick = () => {
    const ta = document.getElementById('answer') as HTMLTextAreaElement;
    const val = ta.value.trim();
    if (!val) return;
    ta.value = '';
    if (apiKey) {
      askDuck(val);
    } else {
      messages.push({ role: 'user', content: val });
      messages.push({ role: 'assistant', content: fallbackReply() });
      renderChat();
    }
  };
  const refreshBtn = document.getElementById('refresh');
  if (refreshBtn) refreshBtn.onclick = () => post({ type: 'get-board' });
  document.getElementById('drop')!.onclick = () => {
    const last = [...messages].reverse().find((m) => m.role === 'assistant');
    post({ type: 'drop-sticky', text: last ? last.content : 'What are you stuck on?' });
    post({ type: 'dismiss' });
    idleDuck();
  };
  document.getElementById('done')!.onclick = () => {
    post({ type: 'dismiss' });
    idleDuck();
  };
}

function escapeHtml(s: string) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

window.onmessage = (event) => {
  const msg = event.data.pluginMessage;
  if (!msg) return;
  if (msg.type === 'checkin') {
    boardContext = msg.board || '';
    if (!visible) showCheckIn();
  }
  if (msg.type === 'board-context') boardContext = msg.board || '';
  if (msg.type === 'resume') idleDuck();
  if (msg.type === 'api-key') apiKey = msg.key;
};

idleDuck();
