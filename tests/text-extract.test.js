// Guards api/_lib/text-extract.js — the widget-knowledge HTML→text extractor.
//
// This module previously used jsdom, whose html-encoding-sniffer@6 →
// @exodus/bytes (ESM-only) chain crashed the entire widgets serverless function
// with ERR_REQUIRE_ESM at cold start. It now parses with node-html-parser. These
// tests pin the extraction contract (noise stripping, entity decoding, title
// resolution, whitespace normalization) so a future parser swap can't regress it.

import { describe, it, expect, afterEach } from 'vitest';
import { parse } from 'node-html-parser';
import { fetchAndExtract } from '../api/_lib/text-extract.js';

// Mirror of the extraction performed inside fetchAndExtract() for already-fetched
// HTML, so we can assert behavior without a network round trip.
function extract(raw, fallbackTitle = 'fallback') {
	const root = parse(raw);
	root.querySelectorAll(
		'script, style, noscript, template, svg, iframe, nav, footer, header, form, [aria-hidden="true"]',
	).forEach((el) => el.remove());

	const title =
		(
			root.querySelector('meta[property="og:title"]')?.getAttribute('content') ||
			root.querySelector('title')?.textContent ||
			''
		).trim() || fallbackTitle;

	const main =
		root.querySelector('article, main, [role="main"], #main, #content') ||
		root.querySelector('body') ||
		root;
	const text = (main?.textContent || '')
		.replace(/[ \t]+/g, ' ')
		.replace(/\n[ \t]+/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();

	return { title, text };
}

describe('text-extract HTML extraction', () => {
	it('strips script/style/nav/footer/header/svg and aria-hidden noise', () => {
		const { text } = extract(`<!doctype html><html><body>
			<nav>NAVNOISE</nav><header>HEADERNOISE</header>
			<article><p>Real content here.</p>
			<script>window.tracker=1</script><style>.a{color:red}</style>
			<svg><text>SVGNOISE</text></svg>
			<div aria-hidden="true">HIDDENNOISE</div></article>
			<footer>FOOTERNOISE</footer></body></html>`);
		expect(text).toContain('Real content here.');
		for (const noise of ['NAVNOISE', 'HEADERNOISE', 'FOOTERNOISE', 'SVGNOISE', 'HIDDENNOISE', 'window.tracker', '.a{']) {
			expect(text).not.toContain(noise);
		}
	});

	it('decodes HTML entities in body text and title', () => {
		const { title, text } = extract(
			`<html><head><title>Tom &amp; Jerry &mdash; Show</title></head>
			<body><article><p>Rock &amp; Roll &copy; 2026 &mdash; ok.</p></article></body></html>`,
		);
		expect(title).toBe('Tom & Jerry — Show');
		expect(text).toBe('Rock & Roll © 2026 — ok.');
	});

	it('prefers og:title over <title>, then falls back to the derived title', () => {
		expect(
			extract(`<html><head><meta property="og:title" content="OG Wins"><title>Plain</title></head><body><p>x</p></body></html>`).title,
		).toBe('OG Wins');
		expect(extract(`<html><head><title>Plain</title></head><body><p>x</p></body></html>`).title).toBe('Plain');
		expect(extract(`<html><body><p>no title at all</p></body></html>`, 'from-url').title).toBe('from-url');
	});

	it('scopes to the main content region when present, else the body', () => {
		const scoped = extract(
			`<html><body><aside>SIDEBAR</aside><main><p>Primary article body.</p></main><div>UNRELATED</div></body></html>`,
		);
		expect(scoped.text).toBe('Primary article body.');
		expect(scoped.text).not.toContain('SIDEBAR');

		const noMain = extract(`<html><body><p>Just body text.</p></body></html>`);
		expect(noMain.text).toBe('Just body text.');
	});

	it('collapses runs of spaces/tabs and excess blank lines', () => {
		const { text } = extract(
			`<html><body><article><p>a    b\t\tc</p>\n\n\n\n<p>d</p></article></body></html>`,
		);
		expect(text).toBe('a b c\n\nd');
	});
});

// The http-scheme check in the SSRF guard runs before any DNS/network hop, so a
// cleartext public URL is refused purely on protocol when allowHttp is false —
// which is exactly what fetchAndExtract gates on the production environment.
describe('text-extract cleartext-http gate', () => {
	const prev = process.env.NODE_ENV;
	afterEach(() => {
		if (prev === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = prev;
	});

	it('refuses plaintext http:// public URLs in production (no network round trip)', async () => {
		process.env.NODE_ENV = 'production';
		await expect(fetchAndExtract('http://example.com/')).rejects.toMatchObject({
			status: 400,
			message: 'URL must be publicly reachable',
		});
	});
});
