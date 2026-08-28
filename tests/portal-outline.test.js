// The outline reader is the contract everything downstream depends on: the
// layout, the GLB export, the SDK and the MCP tools all consume this shape and
// never see HTML again. These tests pin the properties that make a world
// shareable (determinism) and safe (bounded output).
import { describe, it, expect } from 'vitest';
import { outlineFromHtml, absolutize, normalizeColor, slugify, LIMITS } from '../api/_lib/portal/outline.js';

const page = (body, head = '') => `<!doctype html><html lang="en"><head><title>Test</title>${head}</head><body>${body}</body></html>`;

describe('outlineFromHtml', () => {
	it('opens a section at every heading and attributes what follows to it', () => {
		const o = outlineFromHtml(
			page('<h1>One</h1><p>alpha beta</p><h2>Two</h2><p>gamma</p><p>delta</p>'),
			'https://site.test/',
		);
		expect(o.sections.map((s) => s.heading)).toEqual(['One', 'Two']);
		expect(o.sections[0].words).toBe(2);
		expect(o.sections[1].paragraphs).toBe(2);
		expect(o.words).toBe(4);
	});

	it('counts a paragraph once, even nested inside another text block', () => {
		const o = outlineFromHtml(page('<h1>H</h1><blockquote><p>one two three</p></blockquote>'), 'https://site.test/');
		expect(o.sections[0].words).toBe(3);
		expect(o.sections[0].paragraphs).toBe(1);
	});

	it('counts <pre><code> as one code block', () => {
		const o = outlineFromHtml(page('<h1>H</h1><pre><code>npm i</code></pre>'), 'https://site.test/');
		expect(o.sections[0].codeBlocks).toBe(1);
	});

	it('collects links nested inside prose and marks internal ones', () => {
		const o = outlineFromHtml(
			page('<h1>H</h1><div><p>see <a href="/inside">in</a> and <a href="https://other.test/x">out</a></p></div>'),
			'https://site.test/',
		);
		expect(o.sections[0].links).toEqual([
			{ href: 'https://site.test/inside', text: 'in', internal: true },
			{ href: 'https://other.test/x', text: 'out', internal: false },
		]);
		expect(o.linkCounts).toEqual({ internal: 1, external: 1 });
	});

	it('drops chrome and scripts rather than reading them as content', () => {
		const o = outlineFromHtml(
			page('<nav><a href="/nav">nav</a></nav><h1>H</h1><p>body</p><script>var x = "hi";</script><footer><p>footer</p></footer>'),
			'https://site.test/',
		);
		expect(o.sections).toHaveLength(1);
		expect(o.sections[0].links).toEqual([]);
		expect(o.sections[0].summary).toBe('body');
	});

	it('is deterministic: the same bytes always produce the same outline', () => {
		const html = page('<h1>One</h1><p>a b c</p><h2>Two</h2><img src="/i.png" alt="pic">');
		expect(JSON.stringify(outlineFromHtml(html, 'https://site.test/'))).toBe(
			JSON.stringify(outlineFromHtml(html, 'https://site.test/')),
		);
	});

	it('bounds every list, so one hostile page cannot produce a giant world', () => {
		const links = Array.from({ length: 60 }, (_, i) => `<a href="/l${i}">link ${i}</a>`).join('');
		const headings = Array.from({ length: 60 }, (_, i) => `<h2>Section ${i}</h2><p>text</p>`).join('');
		const o = outlineFromHtml(page(`<h1>H</h1><p>${links}</p>${headings}`), 'https://site.test/');
		expect(o.sections.length).toBeLessThanOrEqual(LIMITS.sections);
		expect(o.sections[0].links.length).toBeLessThanOrEqual(LIMITS.linksPerSection);
		expect(o.title.length).toBeLessThanOrEqual(LIMITS.titleChars);
	});

	it('gives every section a unique id even when headings repeat', () => {
		const o = outlineFromHtml(page('<h1>Same</h1><p>a</p><h2>Same</h2><p>b</p>'), 'https://site.test/');
		expect(new Set(o.sections.map((s) => s.id)).size).toBe(o.sections.length);
	});

	it('reads metadata a site actually publishes', () => {
		const o = outlineFromHtml(
			page('<h1>H</h1><p>x</p>', '<meta property="og:title" content="Better Title"><meta name="description" content="Desc"><meta name="theme-color" content="#0b7"><link rel="canonical" href="https://site.test/canonical">'),
			'https://site.test/page',
		);
		expect(o.title).toBe('Better Title');
		expect(o.description).toBe('Desc');
		expect(o.themeColor).toBe('#00bb77');
		expect(o.canonical).toBe('https://site.test/canonical');
	});

	it('falls back to the document title when a page opens with no heading', () => {
		const o = outlineFromHtml(page('<p>just prose</p>'), 'https://site.test/');
		expect(o.sections).toHaveLength(1);
		expect(o.sections[0].heading).toBe('Test');
	});
});

describe('helpers', () => {
	it('absolutizes only real web links', () => {
		expect(absolutize('/a', 'https://s.test/x')).toBe('https://s.test/a');
		expect(absolutize('mailto:a@b.c', 'https://s.test/')).toBeNull();
		expect(absolutize('javascript:alert(1)', 'https://s.test/')).toBeNull();
		expect(absolutize('#anchor', 'https://s.test/')).toBeNull();
	});

	it('normalizes the colour forms a page can carry', () => {
		expect(normalizeColor('#abc')).toBe('#aabbcc');
		expect(normalizeColor('#AABBCC')).toBe('#aabbcc');
		expect(normalizeColor('rgb(255, 0, 128)')).toBe('#ff0080');
		expect(normalizeColor('hotpink')).toBeNull();
	});

	it('slugs headings, and falls back when there is nothing to slug', () => {
		expect(slugify('Hello, World!', 'x')).toBe('hello-world');
		expect(slugify('   ', 'fallback')).toBe('fallback');
	});
});
