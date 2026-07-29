// @vitest-environment jsdom
//
// The bounty/copilot Markdown preset (src/md.js). It is a thin wrapper over the
// shared sanitized pipeline (marked + DOMPurify, see tests/shared-markdown.test.js)
// that demotes headings two levels and tags <pre> with the md-pre class.
//
// Assertions are behavioural rather than exact-string so the suite survives
// upstream whitespace changes in marked; the sanitizer contract is asserted
// exactly where it matters.
import { describe, it, expect } from 'vitest';
import { mdToHtml } from '../src/md.js';

describe('mdToHtml — formatting', () => {
	it('renders headings shifted under the section h2', () => {
		expect(mdToHtml('# Title').trim()).toBe('<h3>Title</h3>');
		expect(mdToHtml('### Deep').trim()).toBe('<h5>Deep</h5>');
	});

	it('renders emphasis and inline code', () => {
		expect(mdToHtml('a **b** c *d* `e`').trim()).toBe(
			'<p>a <strong>b</strong> c <em>d</em> <code>e</code></p>',
		);
	});

	it('renders unordered and ordered lists', () => {
		const ul = mdToHtml('- one\n- two');
		expect(ul).toContain('<ul>');
		expect(ul).toContain('<li>one</li>');
		const ol = mdToHtml('1. a\n2. b');
		expect(ol).toContain('<ol>');
		expect(ol).toContain('<li>a</li>');
	});

	it('renders blockquotes and horizontal rules', () => {
		expect(mdToHtml('> quote')).toContain('<blockquote>');
		expect(mdToHtml('> quote')).toContain('quote');
		expect(mdToHtml('---').trim()).toBe('<hr>');
	});

	it('renders fenced code blocks with escaped contents and the md-pre class', () => {
		const html = mdToHtml('```\n<x> & y\n```');
		expect(html).toContain('<pre class="md-pre">');
		expect(html).toContain('&lt;x&gt; &amp; y');
		expect(html).not.toContain('<x>');
	});

	it('separates paragraphs and keeps single newlines as line breaks', () => {
		const html = mdToHtml('one\ntwo\n\nthree');
		expect(html).toContain('<p>one<br>two</p>');
		expect(html).toContain('<p>three</p>');
	});

	it('renders tables and nested lists the previous renderer could not', () => {
		expect(mdToHtml('| a | b |\n|---|---|\n| 1 | 2 |')).toContain('<table>');
		const nested = mdToHtml('- outer\n    - inner');
		expect(nested.match(/<ul>/g).length).toBeGreaterThan(1);
	});

	it('returns empty string for null/undefined', () => {
		expect(mdToHtml(null)).toBe('');
		expect(mdToHtml(undefined)).toBe('');
	});
});

describe('mdToHtml — links', () => {
	it('linkifies [label](url) for safe schemes with noopener', () => {
		expect(mdToHtml('[docs](https://pump.fun/go)').trim()).toBe(
			'<p><a href="https://pump.fun/go" target="_blank" rel="noopener noreferrer nofollow">docs</a></p>',
		);
	});

	it('autolinks bare http(s) URLs', () => {
		const html = mdToHtml('see https://three.ws here');
		expect(html).toContain('<a href="https://three.ws"');
		expect(html).toContain('rel="noopener noreferrer nofollow"');
	});
});

describe('mdToHtml — safety', () => {
	it('removes raw script tags entirely', () => {
		const html = mdToHtml('<script>alert(1)</script>');
		expect(html).not.toContain('script');
		expect(html).not.toContain('alert(1)');
	});

	it('strips inline event handlers from raw HTML', () => {
		expect(mdToHtml('<div onclick="alert(1)">hi</div>')).not.toContain('onclick');
	});

	it('does not produce an href for javascript: scheme', () => {
		const out = mdToHtml('[x](javascript:alert(1))');
		expect(out).not.toContain('href=');
		expect(out).not.toContain('javascript:');
		expect(out).toContain('x');
	});

	it('never mistakes spaced literal numbers for token placeholders', () => {
		expect(mdToHtml('I need 3 logos and 5 banners').trim()).toBe(
			'<p>I need 3 logos and 5 banners</p>',
		);
	});

	it('does not let emphasis bleed into code spans', () => {
		expect(mdToHtml('`a*b*c`').trim()).toBe('<p><code>a*b*c</code></p>');
	});
});
