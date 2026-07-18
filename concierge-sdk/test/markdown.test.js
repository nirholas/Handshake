import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, stripMarkdown, escapeHtml } from '../src/markdown.js';

test('escapes raw HTML, no injection from model output', () => {
	const html = renderMarkdown('<img src=x onerror=alert(1)> & <b>bold</b>');
	assert.ok(!html.includes('<img'));
	assert.ok(html.includes('&lt;img'));
	assert.ok(html.includes('&amp;'));
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
	assert.ok(html.includes('<ul><li>one</li><li>two</li></ul>'));
	assert.ok(html.includes('<ol><li>first</li><li>second</li></ol>'));
});

test('renders fenced code blocks with escaping', () => {
	const html = renderMarkdown('```\nconst a = "<script>";\n```');
	assert.ok(html.includes('<pre><code>'));
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

test('stripMarkdown yields speakable text', () => {
	assert.equal(stripMarkdown('**Bold** and `code` and [link](https://x.test)'), 'Bold and code and link');
	assert.equal(stripMarkdown('- item one\n- item two'), 'item one item two');
	assert.ok(stripMarkdown('```\nlet x=1\n```').includes('code sample'));
});

test('escapeHtml covers the special five', () => {
	assert.equal(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
});
