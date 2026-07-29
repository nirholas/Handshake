// @vitest-environment jsdom
//
// The shared sanitized Markdown pipeline (src/shared/markdown.js). This module
// replaced eight hand-rolled renderers, so the suite covers both the feature
// surface those renderers lacked (tables, nested lists, GFM) and the injection
// vectors they were individually responsible for blocking.
import { describe, it, expect } from 'vitest';
import { renderMarkdown, stripMarkdown } from '../src/shared/markdown.js';

describe('renderMarkdown — structure', () => {
	it('renders headings, emphasis, and code', () => {
		const html = renderMarkdown('# Title\n\nSome **bold** and `code`.');
		expect(html).toContain('<h1>Title</h1>');
		expect(html).toContain('<strong>bold</strong>');
		expect(html).toContain('<code>code</code>');
	});

	it('renders fenced code blocks with the content escaped', () => {
		const html = renderMarkdown('```\n<script>x</script>\n```');
		expect(html).toContain('<pre>');
		expect(html).toContain('&lt;script&gt;');
		expect(html).not.toContain('<script>');
	});

	it('renders GFM tables (no hand-rolled renderer supported these)', () => {
		const html = renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |');
		expect(html).toContain('<table>');
		expect(html).toContain('<td>1</td>');
	});

	it('renders nested lists (the hand-rolled renderers flattened them)', () => {
		const html = renderMarkdown('- outer\n    - inner');
		expect(html).toContain('<ul>');
		expect(html.match(/<ul>/g).length).toBeGreaterThan(1);
		expect(html).toContain('inner');
	});

	it('renders ordered lists as ol, not ul', () => {
		const html = renderMarkdown('1. first\n2. second');
		expect(html).toContain('<ol>');
		expect(html).toContain('<li>first</li>');
	});

	it('returns an empty string for null/empty input', () => {
		expect(renderMarkdown(null)).toBe('');
		expect(renderMarkdown('')).toBe('');
		expect(renderMarkdown(undefined)).toBe('');
	});
});

describe('renderMarkdown — sanitization', () => {
	it('strips raw script tags', () => {
		const html = renderMarkdown('hello <script>alert(1)</script> world');
		expect(html).not.toContain('<script');
		expect(html).not.toContain('alert(1)');
	});

	it('strips inline event handlers', () => {
		const html = renderMarkdown('<div onclick="alert(1)">click</div>');
		expect(html).not.toContain('onclick');
	});

	it('strips img-based payloads (no media tags allowed)', () => {
		const html = renderMarkdown('![x](https://e.example/a.png "t")\n\n<img src=x onerror=alert(1)>');
		expect(html).not.toContain('<img');
		expect(html).not.toContain('onerror');
	});

	it('drops javascript: hrefs but keeps the link text', () => {
		const html = renderMarkdown('[click me](javascript:alert(1))');
		expect(html).not.toContain('javascript:');
		expect(html).toContain('click me');
	});

	it('drops data: hrefs', () => {
		const html = renderMarkdown('[x](data:text/html;base64,PHNjcmlwdD4=)');
		expect(html).not.toContain('data:text/html');
	});

	it('hardens allowed links with target and rel', () => {
		const html = renderMarkdown('[three](https://three.ws)');
		expect(html).toContain('href="https://three.ws"');
		expect(html).toContain('rel="noopener noreferrer nofollow"');
		expect(html).toContain('target="_blank"');
	});

	it('keeps root-relative and anchor hrefs', () => {
		expect(renderMarkdown('[a](/create)')).toContain('href="/create"');
		expect(renderMarkdown('[a](#top)')).toContain('href="#top"');
	});

	it('strips style, iframe, and form elements', () => {
		const html = renderMarkdown('<style>body{}</style><iframe src="x"></iframe><form><input></form>');
		expect(html).not.toContain('<style');
		expect(html).not.toContain('<iframe');
		expect(html).not.toContain('<form');
		expect(html).not.toContain('<input');
	});
});

describe('renderMarkdown — options', () => {
	it('applies caller CSS classes so existing page styles keep working', () => {
		const html = renderMarkdown('# T\n\n- a', { classes: { h1: 'md-h1', ul: 'md-ul' } });
		expect(html).toContain('class="md-h1"');
		expect(html).toContain('class="md-ul"');
	});

	it('demotes headings by the requested number of levels', () => {
		const html = renderMarkdown('# One\n\n## Two', { demoteHeadings: 2 });
		expect(html).toContain('<h3>One</h3>');
		expect(html).toContain('<h4>Two</h4>');
	});

	it('clamps demoted headings at h6', () => {
		const html = renderMarkdown('##### Five', { demoteHeadings: 3 });
		expect(html).toContain('<h6>Five</h6>');
	});
});

describe('stripMarkdown', () => {
	it('removes syntax and leaves the words', () => {
		expect(stripMarkdown('# Hi\n\n**bold** and `code` and [link](https://x.example)')).toBe(
			'Hi bold and code and link',
		);
	});

	it('drops fenced code blocks', () => {
		expect(stripMarkdown('before\n```\nconst x = 1\n```\nafter')).toBe('before after');
	});

	it('flattens list markers and quotes', () => {
		expect(stripMarkdown('- one\n- two\n\n> quoted')).toBe('one two quoted');
	});

	it('handles null input', () => {
		expect(stripMarkdown(null)).toBe('');
	});
});
