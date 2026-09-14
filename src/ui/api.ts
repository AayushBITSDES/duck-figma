import { state, activeKey } from './state';
import { PROVIDERS } from './providers';

const DUCK_BRIEF =
  "You are a small yellow rubber duck sitting on a FigJam board, keeping a designer company while they work. Warm, plain, brief, 2 to 4 sentences. Check in on how they are doing before problem solving. Ask one question at a time. Reference specific things from the board snapshot when it helps, otherwise ignore it. Never lecture, never sound like a corporate assistant.";

// Error bubbles never go back to the model. Consecutive same-role turns are
// merged because Anthropic and Google both require the roles to alternate.
export function apiMessages() {
  const out: { role: string; content: string }[] = [];
  for (const m of state.messages) {
    if (m.error) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += '\n\n' + m.content;
    else out.push({ role: m.role, content: m.content });
  }
  return out;
}

export function apiErrorMessage(status: number, detail: string): string {
  const who = PROVIDERS[state.provider].label;
  const tail = detail ? ' (' + detail + ')' : '';
  if (status === 400 && state.provider === 'google') return who + ' rejected that key or request' + tail + '.';
  if (status === 401) return who + ' rejected that key. Check it in settings' + tail + '.';
  if (status === 402) return 'That key has no credit left for this model' + tail + '.';
  if (status === 403) return "That key isn't allowed to use this model" + tail + '.';
  if (status === 404) return who + ' does not know the model ' + PROVIDERS[state.provider].model + tail + '.';
  if (status === 429) {
    return state.provider === 'openrouter'
      ? 'Too many requests. Free models allow 20 a minute and 50 a day, shared by everyone using this key' + tail + '.'
      : 'Rate limited, or the account is out of credit. Give it a minute' + tail + '.';
  }
  if (status >= 500) return who + "'s server errored (" + status + '). Try again in a moment.';
  return who + ' refused that request (' + status + ')' + tail + '.';
}

// Each provider names its stop reason differently; this covers all four.
export function emptyReason(data: any): string {
  const c = data && data.choices && data.choices[0];
  const g = data && data.candidates && data.candidates[0];
  const stop = (c && c.finish_reason) || (g && g.finishReason) || (data && data.stop_reason);
  if (stop === 'content_filter' || stop === 'SAFETY') return 'That one got caught by the content filter.';
  if (stop === 'length' || stop === 'max_tokens' || stop === 'MAX_TOKENS') {
    return 'That reply hit the length cap before any of it came out.';
  }
  return 'The API answered, but with nothing in it. Try again?';
}

export async function askDuck() {
  const p = PROVIDERS[state.provider];
  try {
    const system =
      DUCK_BRIEF +
      (state.boardItems.length
        ? '\n\nHere is a snapshot of text currently on the board, in no particular order:\n- ' + state.boardItems.join('\n- ')
        : '\n\nThe board looks empty right now, or has nothing with text on it.');
    const res = await fetch(p.url, {
      method: 'POST',
      headers: p.headers(activeKey()),
      body: JSON.stringify(p.body(system, apiMessages())),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const detail = (data && data.error && data.error.message) || '';
      state.messages.push({ role: 'assistant', content: apiErrorMessage(res.status, detail), error: true });
      return;
    }
    const text = p.reply(data);
    if (!text) {
      state.messages.push({ role: 'assistant', content: emptyReason(data), error: true });
      return;
    }
    state.messages.push({ role: 'assistant', content: text });
  } catch (e) {
    state.messages.push({
      role: 'assistant',
      content: "Couldn't reach " + p.label + '. Check your connection, then try again.',
      error: true,
    });
  }
}
