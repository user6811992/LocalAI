// Static checks on the web UI: no third-party CDN loads, wired controls, safe fallbacks.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('no external script or stylesheet is loaded from a CDN', () => {
  const external = html.match(/<(script|link)[^>]+(src|href)=["']https?:\/\/[^"']+["']/gi) || [];
  assert.deepEqual(external, []);
});

test('vendored libraries are present and referenced locally', () => {
  for (const f of ['marked.min.js', 'purify.min.js', 'highlight.min.js', 'github-dark.min.css']) {
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', 'vendor', f)), f + ' missing');
    assert.ok(html.includes('/vendor/' + f), f + ' not referenced');
  }
});

test('Stats button is wired to a click handler and modal', () => {
  assert.ok(html.includes("getElementById('statsBtn')"));
  assert.ok(html.includes("fetch('/api/stats')"));
  assert.ok(html.includes('id="statsBackdrop"'));
});

test('system prompt Save button exists in markup and in script', () => {
  assert.ok(html.includes('id="savePromptBtn"'));
  assert.ok(html.includes("getElementById('savePromptBtn')"));
});

test('markdown output falls back to escaped text when DOMPurify is unavailable', () => {
  assert.ok(!/DOMPurify\.sanitize\(rawHtml\) : rawHtml;/.test(html), 'raw HTML fallback still present');
  assert.ok(html.includes('escHtml(finalText)'));
});

test('RAG citation document names are escaped', () => {
  assert.ok(!/\+ \(c\.docName \|\| 'doc'\)/.test(html), 'unescaped docName still present');
});

test('code preview iframe is sandboxed', () => {
  assert.ok(/<iframe id="codePreviewFrame" sandbox=/.test(html));
});
