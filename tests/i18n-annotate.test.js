/**
 * i18n auto-annotator — unit tests.
 *
 * The annotator injects data-i18n* attributes into static copy so the extract →
 * translate pipeline can localize a page. These tests pin the two properties
 * that make auto-editing hand-authored HTML safe:
 *   1. edits are byte-surgical — output equals input plus only the inserted
 *      attribute strings (never a reserialization);
 *   2. selection is conservative and idempotent — code/dynamic/opt-out/nested
 *      copy is skipped, and a second pass is a no-op.
 */

import { describe, it, expect } from 'vitest';
import { planAnnotations, applyEdits } from '../scripts/i18n-annotate.mjs';
import { extractFromHtml } from '../scripts/i18n-extract.mjs';

const plan = (html, file = 'pages/sample.html') => planAnnotations(html, file);
const annotate = (html, file = 'pages/sample.html') => {
	const { edits } = plan(html, file);
	return applyEdits(html, edits);
};

describe('planAnnotations — selection', () => {
	it('annotates a plain-text copy element with data-i18n', () => {
		const { keys } = plan('<h1>Build agents</h1>');
		const [k, v] = [...keys][0];
		expect(k).toMatch(/^sample\./);
		expect(v).toBe('Build agents');
		expect(annotate('<h1>Build agents</h1>')).toContain('data-i18n="sample.build_agents"');
	});

	it('uses data-i18n-html when the element carries inline markup', () => {
		const out = annotate('<li><strong>Earn</strong> USDC per chat</li>');
		expect(out).toContain('data-i18n-html=');
		expect(out).not.toMatch(/<li data-i18n="/);
	});

	it('skips layout containers (block children) and annotates their leaves', () => {
		const html = '<div><h2>Title</h2><p>Body copy here</p></div>';
		const out = annotate(html);
		// the div is never annotated; the h2 and p are
		expect(out).toContain('<div>');
		expect((out.match(/data-i18n=/g) || []).length).toBe(2);
	});

	it('never annotates inside script / style / svg / pre / code', () => {
		const html = `
			<script>const s = "hello world";</script>
			<style>.x::after{content:"nope"}</style>
			<svg><text>icon label</text></svg>
			<pre>literal block</pre>
			<code>inline code</code>`;
		const { edits } = plan(html);
		expect(edits.length).toBe(0);
	});

	it('skips dynamic copy with {{ }} or ${ } placeholders', () => {
		expect(plan('<p>Hello {{name}}</p>').edits.length).toBe(0);
		expect(plan('<p>Total ${count} items</p>').edits.length).toBe(0);
	});

	it('skips pure-symbol / number / emoji-only elements (needs a letter)', () => {
		expect(plan('<span>→</span>').edits.length).toBe(0);
		expect(plan('<span>42</span>').edits.length).toBe(0);
		expect(plan('<span>🎲</span>').edits.length).toBe(0);
	});

	it('honors translate="no" and data-no-i18n opt-outs', () => {
		expect(plan('<p translate="no">Brand Name</p>').edits.length).toBe(0);
		expect(plan('<div data-no-i18n><p>skip me</p></div>').edits.length).toBe(0);
	});

	it('captures translatable copy attributes (aria-label, placeholder, alt)', () => {
		const out = annotate('<button aria-label="Close dialog"><svg></svg></button>');
		expect(out).toContain('data-i18n-attr="aria-label:');
	});

	it('annotates <title> and translatable meta tags', () => {
		const html =
			'<title>My Page</title><meta name="description" content="A description of the page.">';
		const out = annotate(html);
		expect(out).toContain('data-i18n="sample.meta_title"');
		expect(out).toContain('data-i18n-attr="content:sample.meta_description"');
	});

	it('does not wrap an element that already contains an annotated descendant', () => {
		const html = '<a href="/x">Go <span data-i18n="common.now">now</span></a>';
		const { edits } = plan(html);
		// the <a> must not be annotated (its child is the unit); no new text key
		expect(edits.every((e) => !/data-i18n="sample\./.test(e.insert))).toBe(true);
	});
});

describe('planAnnotations — safety properties', () => {
	const sample = `<!doctype html><html><head><title>Home</title></head>
		<body>
			<h1 class="hero">The <em>3D</em> agent layer</h1>
			<p>Create agents in a minute.</p>
			<ul><li>Earn USDC</li><li>Embed anywhere</li></ul>
			<a href="/x" aria-label="Open the forge">Text to 3D</a>
			<script>ignore("me")</script>
		</body></html>`;

	it('is byte-surgical — stripping inserted attrs reproduces the original', () => {
		const out = annotate(sample);
		const strip = (s) => s.replace(/ data-i18n(?:-html|-attr)?="[^"]*"/g, '');
		expect(strip(out)).toBe(sample);
		expect(out.length).toBeGreaterThan(sample.length);
	});

	it('is idempotent — a second pass finds nothing to do', () => {
		const once = annotate(sample);
		expect(plan(once).edits.length).toBe(0);
	});

	it('produces keys the extractor reads back with matching values', () => {
		const out = annotate(sample);
		const extracted = extractFromHtml(out);
		const { keys } = plan(sample);
		for (const [key, value] of keys) {
			expect(extracted.get(key)).toBe(value);
		}
	});

	it('assigns unique keys even for repeated copy', () => {
		const { keys } = plan('<p>Learn more</p><p>Learn more</p><p>Learn more</p>');
		const names = [...keys.keys()];
		expect(new Set(names).size).toBe(names.length);
		expect(names.length).toBe(3);
	});
});
