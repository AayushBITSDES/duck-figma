/*
 * Runs against the COMPILED output in .test-build, not a reimplementation.
 *
 * Covers the two transforms applied to a model's reply on its way to the
 * screen: the markdown renderer in ui/render.js, and the dash normalizer in
 * ui/api.js. Both take untrusted text from a remote API, so the markdown
 * cases that matter most are the ones asserting what does NOT come out.
 */
const path = require('path');
const { check } = require('./lib/check');
const { BUILD, clearBuildCache } = require('./lib/fresh');
const dom = require('./lib/dom');

module.exports = async function run() {
  dom.install();
  clearBuildCache();
  const { renderMarkdown } = require(path.join(BUILD, 'ui', 'render'));
  const { stripDashes, emptyReason } = require(path.join(BUILD, 'ui', 'api'));

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

  // Spaced and unspaced dashes want different results: a clause break reads
  // as " - ", a number range as "-".
  check('dashes: an em dash between words keeps its spaces', stripDashes('a — b'), 'a - b');
  check('dashes: an unspaced en dash in a range stays tight', stripDashes('3–5'), '3-5');
  check('dashes: a spaced en dash is normalized too', stripDashes('x – y'), 'x - y');
  check('dashes: text without any is untouched', stripDashes('plain - hyphen'), 'plain - hyphen');

  // A 200 with message.refusal and no content is the model declining, not the
  // plugin malfunctioning, so say what it actually said.
  check('a refusal is shown rather than reported as an empty reply',
    emptyReason({ choices: [{ message: { refusal: 'I cannot help with that.' } }] }),
    'I cannot help with that.');
  check('a genuinely empty reply still reads as empty',
    emptyReason({ choices: [{ message: {} }] }),
    'The API answered, but with nothing in it. Try again?');
};
