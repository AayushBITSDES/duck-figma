/*
 * Runs against the COMPILED output in .test-build, not a reimplementation.
 *
 * Covers the two transforms applied to facilitator text on its way to the
 * screen: the markdown renderer and the dash normalizer in ui/render.js.
 * Both take untrusted text from a remote API, so the markdown cases that
 * matter most are the ones asserting what does NOT come out.
 */
const path = require('path');
const { check } = require('./lib/check');
const { BUILD, clearBuildCache } = require('./lib/fresh');
const dom = require('./lib/dom');

module.exports = async function run() {
  dom.install();
  clearBuildCache();
  const { renderMarkdown, stripDashes } = require(path.join(BUILD, 'ui', 'render'));

  check('markdown: bold', renderMarkdown('**bold**'), '<p><strong>bold</strong></p>');
  check('markdown: italic', renderMarkdown('*it*'), '<p><em>it</em></p>');
  check('markdown: inline code', renderMarkdown('`code`'), '<p><code>code</code></p>');
  check('markdown: fenced block', renderMarkdown('```js\nconst x=1\n```'), '<pre><code>const x=1</code></pre>');
  check('markdown: bullet list', renderMarkdown('- a\n- b'), '<ul><li>a</li><li>b</li></ul>');
  check('markdown: ordered list', renderMarkdown('1. a\n2. b'), '<ol><li>a</li><li>b</li></ol>');
  check('markdown: single newline is a line break', renderMarkdown('line1\nline2'), '<p>line1<br>line2</p>');

  // The reply is remote text going into innerHTML. Escaping runs before any
  // transform, so a tag in a reply can only ever come out as text.
  const injected = renderMarkdown('<img src=x onerror=alert(1)>');
  check('markdown: a tag in a reply is inert', injected, '<p>&lt;img src=x onerror=alert(1)&gt;</p>');
  check('markdown: and no live tag survives', /<img/.test(injected), false);

  // Links are deliberately unsupported: a javascript: or data: URL would
  // otherwise be a ready-made injection path out of a model reply.
  const link = renderMarkdown('[click](javascript:alert(1))');
  check('markdown: link markup stays literal text', link, '<p>[click](javascript:alert(1))</p>');
  check('markdown: and never becomes an anchor', /<a[\s>]/.test(link), false);

  // A fenced block with no blank line around it used to auto-close the <p>
  // at <pre> (a block-level element) and strand the trailing text outside
  // it, losing .bubble p's margins. This is the default shape of a reply
  // that includes a code block without extra spacing around it.
  check('markdown: a fenced block with no blank line around it does not spill the paragraph',
    renderMarkdown('Here:\n```\ncode\n```\nmore text'),
    '<p>Here:</p><pre><code>code</code></pre><p>more text</p>');

  // JSON can carry any byte in a string, sentinel included, so a reply that
  // happens to contain the placeholder marker used to forge a block or span
  // and splice "undefined" into the output via an index nothing pushed.
  check('markdown: a forged block sentinel does not resurrect a block',
    renderMarkdown('x \x0e0\x0e y'), '<p>x 0 y</p>');
  check('markdown: a forged span sentinel does not resurrect a span',
    renderMarkdown('x \x0f0\x0f y'), '<p>x 0 y</p>');

  // Spaced and unspaced dashes want different results: a clause break reads
  // as " - ", a number range as "-".
  check('dashes: an em dash between words keeps its spaces', stripDashes('a — b'), 'a - b');
  check('dashes: an unspaced en dash in a range stays tight', stripDashes('3–5'), '3-5');
  check('dashes: a spaced en dash is normalized too', stripDashes('x – y'), 'x - y');
  check('dashes: text without any is untouched', stripDashes('plain - hyphen'), 'plain - hyphen');

  // A model's list reply opens every item with an em-dash right after the
  // newline. \s* used to swallow that newline along with the dash, flattening
  // the whole list onto one line.
  check('dashes: a list opened with em-dashes keeps its line breaks',
    stripDashes('Two things:\n\n— Tighten the nav\n— Then the copy\n\nWhich?'),
    'Two things:\n\n- Tighten the nav\n- Then the copy\n\nWhich?');

  // The newline before it is left alone; only the space already sitting
  // after the dash carries through.
  check('dashes: a dash at the start of a line keeps the newline before it',
    stripDashes('intro\n— item'), 'intro\n- item');

  // A dash inside a fenced code block can be meaningful code (a CLI flag, a
  // print statement with a literal em-dash in it), so that region is left
  // untouched entirely, the same fence shape the markdown renderer treats
  // as code. Previously this also merged the two code lines onto one.
  check('dashes: a dash inside a fenced code block is left alone',
    stripDashes('```js\nconst gap = a — b\nlet x = 1\n—y\n```'),
    '```js\nconst gap = a — b\nlet x = 1\n—y\n```');
};
