import { state } from './state';

const root = document.getElementById('root')!;

// A reply can land while the duck is collapsed, and screens repaint on their
// own schedule. Painting a full screen into a 70x70 window would shred it, so
// paints are swallowed while collapsed and the duck stays put. Expanding calls
// repaint() in screens.ts, which re-runs the current screen properly rather
// than restoring stale HTML with dead event handlers.
export function render(html: string) {
  if (state.minimized) return;
  root.innerHTML = html;
}

// The one paint that is allowed to run while collapsed, because it IS the
// collapsed view.
export function renderCollapsed(html: string) {
  root.innerHTML = html;
}

export function escapeHtml(s: string) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

export function escapeAttr(s: string) {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

const templates: Record<string, string> = {};

// The markup lives in <template> elements in ui.html, so it can be edited
// without touching TypeScript. {{name}} is text, escaped for an attribute
// since that is the stricter of the two places it can land. {{{name}}} is
// markup this code already built, inserted as is. A bare {{name}} where an
// attribute would go switches a boolean one: the parser keeps it as
// {{name}}="", and the value ("disabled", "selected") replaces the whole
// thing, or nothing does.
export function tpl(id: string, vals?: Record<string, string | number>): string {
  let src = templates[id];
  if (src === undefined) {
    const node = document.getElementById(id);
    if (!node) return '';
    src = templates[id] = node.innerHTML.trim();
  }
  return src.replace(/\{\{\{(\w+)\}\}\}|\{\{(\w+)\}\}(?:="")?/g, (_m, raw, text) => {
    const v = vals ? vals[raw || text] : undefined;
    const s = v === undefined || v === null ? '' : String(v);
    return raw ? s : escapeAttr(s);
  });
}

// A small markdown renderer for assistant bubbles, not a library: the model
// reply is untrusted text going into innerHTML, so it is escaped FIRST with
// escapeHtml above, and every transform below only ever rearranges the
// already-escaped string. None of them can turn model output into a live tag.
//
// Links and images are deliberately not supported, on purpose, forever: there
// is nowhere useful to navigate to from inside a plugin iframe, and a
// javascript: or data: URL in a model reply is otherwise a ready-made
// injection path. `[text](url)` is meant to come out as literal text.
export function renderMarkdown(raw: string): string {
  // Fenced blocks and inline spans are pulled out before anything else runs,
  // so bold/italic markup inside `code` or a ``` block is never touched.
  // Blocks and spans use different marker bytes so the block/paragraph pass
  // below can tell "a whole paragraph that is just a code block" (no <p>
  // wrapper needed, it is already its own element) from "a code span sitting
  // inside a sentence" (still wants the <p>).
  //
  // \x0e/\x0f are control characters escapeHtml never produces and a person
  // never types, but valid JSON can carry any byte in a string, sentinel
  // included, so a reply that happens to contain one is stripped before it
  // can forge a placeholder and splice a fake block or span into the output.
  let text = escapeHtml(raw.replace(/[\x0e\x0f]/g, ''));

  const blocks: string[] = [];
  const spans: string[] = [];
  text = text.replace(/```[^\n]*\n([\s\S]*?)```/g, (_, code) =>
    '\x0e' + (blocks.push('<pre><code>' + code.replace(/\n$/, '') + '</code></pre>') - 1) + '\x0e');
  text = text.replace(/`([^`\n]+)`/g, (_, code) =>
    '\x0f' + (spans.push('<code>' + code + '</code>') - 1) + '\x0f');

  const inline = (s: string) =>
    s
      .replace(/\*\*([^\n]+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
      // \b before/after `_` only exists where the neighbour is a non-word
      // char, so mid_word_underscores stay literal instead of italicizing.
      .replace(/\b_([^_\n]+)_\b/g, '<em>$1</em>');

  const html = text
    .split(/\n{2,}/) // a blank line is a paragraph break
    .map((block) => {
      if (/^\x0e\d+\x0e$/.test(block.trim())) return block.trim();
      const lines = block.split('\n');
      const bulleted = lines.every((l) => /^[-*]\s+/.test(l));
      const numbered = !bulleted && lines.every((l) => /^\d+\.\s+/.test(l));
      if (bulleted || numbered) {
        const tag = bulleted ? 'ul' : 'ol';
        const items = lines
          .map((l) => '<li>' + inline(l.replace(/^(?:[-*]|\d+\.)\s+/, '')) + '</li>')
          .join('');
        return '<' + tag + '>' + items + '</' + tag + '>';
      }
      // A fenced block sitting on its own line without a blank line around
      // it (no \n{2,} to split it into its own block above) still cannot
      // join the surrounding lines inside one <p>: <pre> is block-level, so
      // a browser auto-closes the paragraph there anyway, stranding
      // whatever came after outside the <p> and its margins. Building the
      // paragraph in pieces around it keeps everything properly closed.
      let out = '';
      let para: string[] = [];
      const flushPara = () => {
        if (para.length) {
          out += '<p>' + inline(para.join('<br>')) + '</p>';
          para = [];
        }
      };
      for (const line of lines) {
        if (/^\x0e\d+\x0e$/.test(line.trim())) {
          flushPara();
          out += line.trim();
        } else {
          para.push(line);
        }
      }
      flushPara();
      return out;
    })
    .join('');

  return html
    .replace(/\x0e(\d+)\x0e/g, (_, i) => blocks[+i])
    .replace(/\x0f(\d+)\x0f/g, (_, i) => spans[+i]);
}

// Models ignore a no-dash instruction often enough that prompting alone is
// not a fix, so facilitator text is rewritten on the way in. Stored
// normalized rather than only at render time, so Update summary posts the
// same cleaned string the bubble showed.
//
// Same fence shape the renderer treats as code, so a dash this function
// leaves alone is exactly a dash the bubble will show as code.
const FENCE = /```[^\n]*\n[\s\S]*?```/g;

// Both dashes collapse to a plain hyphen. Spaced ("a - b") and unspaced
// ("3-5") forms are preserved as they were written rather than forced into
// one shape, since a number range and a clause break want different spacing.
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
