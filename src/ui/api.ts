import { state, activeKey } from './state';
import { PROVIDERS } from './providers';

const DUCK_BRIEF =
  "You are a small yellow rubber duck sitting on a FigJam board, keeping a designer company while they work. Warm, plain, brief, 2 to 4 sentences. Check in on how they are doing before problem solving. Ask one question at a time. Reference specific things from the board snapshot when it helps, otherwise ignore it. Never lecture, never sound like a corporate assistant. Never use em-dashes or en-dashes; write with plain hyphens or reword the sentence.";

// Models ignore the no-dash instruction in DUCK_BRIEF often enough that
// prompting alone is not a fix, so the reply is rewritten on the way in. It is
// stored normalized rather than normalized at render time, so the cleaned text
// is also what goes back as history on the next turn and the model is not
// handed its own em-dashes as an example to follow.
//
// Same fence shape the renderer treats as code (render.ts), so a dash this
// function leaves alone is exactly a dash the bubble will show as code.
const FENCE = /```[^\n]*\n[\s\S]*?```/g;

// Both dashes collapse to a plain hyphen. Spaced ("a - b") and unspaced
// ("3-5") forms are preserved as they were written rather than forced into one
// shape, since a number range and a clause break want different spacing.
//
// Only [ \t] is ever consumed around the dash, never \s: a model's list
// reply opens each item with an em-dash right after the newline
// ("\n\n\u2014 item"), and \s would eat that newline along with the dash,
// flattening the list onto one line. The two sides are judged independently
// (not "does either side have space, so both get one") so a dash sitting
// right after a newline stays tight on that side while the space before the
// next word is left alone.
export function stripDashes(text: string): string {
  let out = '';
  let last = 0;
  FENCE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FENCE.exec(text))) {
    out += stripProseDashes(text.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + stripProseDashes(text.slice(last));
}

function stripProseDashes(text: string): string {
  return text.replace(
    /([ \t]*)[\u2014\u2013]([ \t]*)/g,
    (_match, before: string, after: string) => (before ? ' ' : '') + '-' + (after ? ' ' : '')
  );
}

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
  // OpenAI and OpenRouter can answer 200 with a policy refusal in
  // message.refusal and no content at all. The generic "nothing in it" below
  // reads like a bug in the plugin, when the model actually said something
  // deliberate, so the refusal itself is shown instead.
  const refusal = c && c.message && c.message.refusal;
  if (typeof refusal === 'string' && refusal.trim()) return refusal.trim();
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
    state.messages.push({ role: 'assistant', content: stripDashes(text) });
  } catch (e) {
    state.messages.push({
      role: 'assistant',
      content: "Couldn't reach " + p.label + '. Check your connection, then try again.',
      error: true,
    });
  }
}
