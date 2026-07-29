// The renderer is browser-only by design (DOMPurify needs a live window, and
// the widget only ever runs in a page), so the suite installs a jsdom window
// before importing the module under test.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

let renderMarkdown, stripMarkdown, escapeHtml;

before(async () => {
	const dom = new JSDOM('<!doctype html><html><body></body></html>');
	globalThis.window = dom.window;
	globalThis.document = dom.window.document;
	({ renderMarkdown, stripMarkdown, escapeHtml } = await import('../src/markdown.js'));
});

test('removes injected HTML from model output', () => {
	const html = renderMarkdown('<img src=x onerror=alert(1)> & <b>bold</b>');
	assert.ok(!html.includes('<img'));
	assert.ok(!html.includes('onerror'));
	assert.ok(html.includes('&amp;'));
});

test('strips script, style, iframe, and form elements', () => {
	const html = renderMarkdown('<script>alert(1)</script><style>x{}</style><iframe></iframe><form><input></form>');
	for (const tag of ['<script', '<style', '<iframe', '<form', '<input']) {
		assert.ok(!html.includes(tag), `expected ${tag} to be stripped`);
	}
});

test('renders paragraphs, bold, italic, code', () => {
	const html = renderMarkdown('Hello **world**, try `npm i` and *relax*.\n\nSecond para.');
	assert.ok(html.includes('<strong>world</strong>'));
	assert.ok(html.includes('<code>npm i</code>'));
	assert.ok(html.includes('<em>relax</em>'));
	assert.equal((html.match(/<p>/g) || []).length, 2);
});

test('renders bullet and numbered lists', () => {
	const html = renderMarkdown('- one\n- two\n\n1. first\n2. second');
	assert.ok(html.includes('<ul>'));
	assert.ok(html.includes('<li>one</li>'));
	assert.ok(html.includes('<ol>'));
	assert.ok(html.includes('<li>first</li>'));
});

test('renders GFM tables and nested lists', () => {
	assert.ok(renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |').includes('<table>'));
	const nested = renderMarkdown('- outer\n    - inner');
	assert.ok((nested.match(/<ul>/g) || []).length > 1);
});

test('renders fenced code blocks with escaping', () => {
	const html = renderMarkdown('```\nconst a = "<script>";\n```');
	assert.ok(html.includes('<pre><code'));
	assert.ok(html.includes('&lt;script&gt;'));
	assert.ok(!html.includes('<script>'));
});

test('links: http(s)/mailto/relative allowed, javascript: stripped', () => {
	const ok = renderMarkdown('[docs](https://three.ws/docs)');
	assert.ok(ok.includes('href="https://three.ws/docs"'));
	assert.ok(ok.includes('rel="noopener noreferrer"'));
	const rel = renderMarkdown('[here](/pricing)');
	assert.ok(rel.includes('href="/pricing"'));
	const evil = renderMarkdown('[click](javascript:alert(1))');
	assert.ok(!evil.includes('href'));
	assert.ok(evil.includes('click'));
});

test('empty input returns empty string', () => {
	assert.equal(renderMarkdown(''), '');
	assert.equal(renderMarkdown(null), '');
	assert.equal(renderMarkdown(undefined), '');
});

test('stripMarkdown yields speakable text', () => {
	assert.equal(stripMarkdown('**Bold** and `code` and [link](https://x.test)'), 'Bold and code and link');
	assert.equal(stripMarkdown('- item one\n- item two'), 'item one item two');
	assert.ok(stripMarkdown('```\nlet x=1\n```').includes('code sample'));
});

test('escapeHtml covers the special five', () => {
	assert.equal(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
});
