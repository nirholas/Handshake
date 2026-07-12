// Server-side helpers for turning a URL into plain text we can chunk + embed.
// PDFs are extracted client-side (pdfjs in the studio bundle) and posted as
// text, so this module only needs to handle HTML / plain content fetches.
//
// HTML parsing uses node-html-parser, not jsdom. jsdom (≥27.4) pulls in
// html-encoding-sniffer@6 → @exodus/bytes, an ESM-only module that
// html-encoding-sniffer `require()`s — which throws ERR_REQUIRE_ESM at cold
// start on the deployed Node runtime and crashes the entire widgets serverless
// function (taking stats/transcripts down with it). node-html-parser is a
// dependency-light, CJS-clean parser that reproduces our exact extraction
// (querySelector / remove / textContent with HTML-entity decoding) without the
// fragile ESM/CJS chain. Our usage is trivial DOM scraping; jsdom was overkill.

import { parse } from 'node-html-parser';
import { fetchSafePublicUrl, SsrfBlockedError } from './ssrf-guard.js';
import { env } from './env.js';

const FETCH_TIMEOUT_MS = 12_000;
const MAX_BYTES = 4 * 1024 * 1024; // 4 MB hard cap per source
const USER_AGENT = 'three.ws/widget-knowledge-bot (+https://three.ws)';

/**
 * Fetch a URL and return { title, text, byteSize, contentType }. Strips
 * script/style/nav/footer noise and collapses whitespace.
 *
 * Throws an Error with .status for caller-friendly mapping.
 */
export async function fetchAndExtract(url) {
	const u = new URL(url);
	if (u.protocol !== 'http:' && u.protocol !== 'https:') {
		throw Object.assign(new Error('only http(s) URLs are supported'), { status: 400 });
	}

	// SSRF guard: every hop (including each redirect Location) is DNS-resolved
	// and checked against private/loopback/link-local/metadata ranges before we
	// connect. `fetchSafePublicUrl` follows redirects manually and re-validates
	// each one — a public URL that 302s to 169.254.169.254 (or a decimal/hex IP
	// form) is rejected instead of followed.
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	let res;
	try {
		res = await fetchSafePublicUrl(
			u.toString(),
			{
				headers: {
					'user-agent': USER_AGENT,
					accept: 'text/html,text/plain,application/xhtml+xml',
				},
				signal: controller.signal,
			},
			// Production requires HTTPS: cleartext http:// public fetches are
			// MITM-tamperable, and ingested content lands in the knowledge base.
			// Plaintext stays allowed in dev/tests for local sources.
			{ allowHttp: !env.isProduction },
		);
	} catch (err) {
		clearTimeout(timer);
		if (err instanceof SsrfBlockedError) {
			throw Object.assign(new Error('URL must be publicly reachable'), { status: 400 });
		}
		throw Object.assign(new Error(`fetch failed: ${err.message}`), { status: 502 });
	}
	clearTimeout(timer);

	if (!res.ok) {
		throw Object.assign(new Error(`fetch ${res.status} ${res.statusText}`), { status: 502 });
	}

	const contentType = (res.headers.get('content-type') || '').toLowerCase();
	const isHtml = /html|xhtml/.test(contentType);
	const isPlain = /^text\//.test(contentType) || /json$/.test(contentType);
	if (!isHtml && !isPlain) {
		throw Object.assign(
			new Error(
				`unsupported content-type ${contentType || 'unknown'} — only HTML and text URLs are accepted`,
			),
			{ status: 415 },
		);
	}

	const buf = await readWithCap(res, MAX_BYTES);
	const raw = buf.toString('utf8');

	if (!isHtml) {
		return {
			title: derivedTitleFromUrl(u),
			text: raw.trim(),
			byteSize: buf.byteLength,
			contentType,
		};
	}

	const root = parse(raw);
	root.querySelectorAll(
		'script, style, noscript, template, svg, iframe, nav, footer, header, form, [aria-hidden="true"]',
	).forEach((el) => el.remove());

	const title =
		(
			root.querySelector('meta[property="og:title"]')?.getAttribute('content') ||
			root.querySelector('title')?.textContent ||
			''
		).trim() || derivedTitleFromUrl(u);

	const main =
		root.querySelector('article, main, [role="main"], #main, #content') ||
		root.querySelector('body') ||
		root;
	const text = (main?.textContent || '')
		.replace(/[ \t]+/g, ' ')
		.replace(/\n[ \t]+/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();

	return { title, text, byteSize: buf.byteLength, contentType };
}

function derivedTitleFromUrl(u) {
	const last = u.pathname.split('/').filter(Boolean).pop();
	return decodeURIComponent(last || u.hostname);
}

async function readWithCap(res, limit) {
	const reader = res.body?.getReader();
	if (!reader) {
		const ab = await res.arrayBuffer();
		if (ab.byteLength > limit)
			throw Object.assign(new Error('source exceeds 4MB'), { status: 413 });
		return Buffer.from(ab);
	}
	const chunks = [];
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > limit) {
			reader.cancel().catch(() => {});
			throw Object.assign(new Error('source exceeds 4MB'), { status: 413 });
		}
		chunks.push(Buffer.from(value));
	}
	return Buffer.concat(chunks);
}
