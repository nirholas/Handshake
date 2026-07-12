// Full-text article extraction — the ladder behind the /markets/news reader.
// ---------------------------------------------------------------------------
// Many crypto publishers (The Defiant, CoinDesk, The Block, …) sit behind
// Cloudflare and answer a plain server-side fetch with a 403, so the reader
// used to fall straight through to the RSS teaser — a single truncated
// sentence ending "Read the full story at …". That reads as an empty page.
//
// This module gives the extractor a real ladder:
//   1. page    — fetch the publisher HTML directly and pull its <article> prose
//   2. reader  — when the page is blocked or JS-rendered, re-fetch it through
//                Jina Reader (r.jina.ai), a free, keyless reader service that
//                renders the page and returns clean markdown. This recovers the
//                full body for the Cloudflare-blocked publishers.
//   3. feed    — the publisher's own RSS content:encoded body (full for the
//                WordPress-style feeds, a teaser for the rest)
//   4. preview — honest metadata-only preview with a read-at-source CTA
//
// Every rung is SSRF-guarded: the caller validates the target is a public URL
// before we ever hand it to the reader service (which would otherwise proxy it).

import { lookup } from 'node:dns/promises';
import { stripHtml } from './news.js';

const FETCH_TIMEOUT_MS = 10_000;
const READER_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

// Realistic desktop UA — some publishers 403 obvious bots but serve a browser
// UA. The reader rung covers the ones that still block (JS challenges).
const BROWSER_UA =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

// ── SSRF protection ────────────────────────────────────────────────────────

function isPrivateOrReservedHost(hostname) {
	const host = hostname.toLowerCase();
	if (['localhost', 'metadata.google.internal', 'metadata.google', 'instance-data'].includes(host)) return true;
	const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (v4) {
		const [, a, b] = v4.map(Number);
		if (
			a === 0 || a === 10 || a === 127 ||
			(a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 168)
		) return true;
	}
	const bare = host.replace(/^\[|\]$/g, '');
	if (bare === '::1' || /^(fc|fd)/i.test(bare) || /^fe[89ab]/i.test(bare)) return true;
	return false;
}

export async function assertPublicUrl(urlString) {
	const parsed = new URL(urlString);
	if (!/^https?:$/.test(parsed.protocol)) throw new Error('only http(s) urls are supported');
	if (isPrivateOrReservedHost(parsed.hostname)) throw new Error('url targets a private address');
	// DNS-rebinding guard: resolve and re-check the actual address
	if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(parsed.hostname) && !parsed.hostname.includes(':')) {
		const { address } = await lookup(parsed.hostname);
		if (isPrivateOrReservedHost(address)) throw new Error('url resolves to a private address');
	}
}

// ── Rung 1: direct HTML ────────────────────────────────────────────────────

export async function fetchArticleHtml(url) {
	await assertPublicUrl(url);
	const resp = await fetch(url, {
		headers: {
			'user-agent': BROWSER_UA,
			accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
			'accept-language': 'en-US,en;q=0.9',
		},
		redirect: 'follow',
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!resp.ok) throw Object.assign(new Error(`source responded ${resp.status}`), { status: resp.status });
	const contentType = resp.headers.get('content-type') || '';
	if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
		throw new Error(`unsupported content type: ${contentType.split(';')[0] || 'unknown'}`);
	}
	const declared = parseInt(resp.headers.get('content-length') || '0', 10);
	if (declared > MAX_RESPONSE_BYTES) throw new Error('article page too large');
	const html = await resp.text();
	if (html.length > MAX_RESPONSE_BYTES) throw new Error('article page too large');
	return html;
}

export function extractParagraphs(html) {
	// Prefer semantic containers; fall back to the whole document.
	const scoped =
		html.match(/<article[^>]*>([\s\S]*?)<\/article>/i)?.[1] ||
		html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)?.[1] ||
		html;
	const cleaned = scoped
		.replace(/<script[\s\S]*?<\/script>/gi, ' ')
		.replace(/<style[\s\S]*?<\/style>/gi, ' ')
		.replace(/<(nav|header|footer|aside|form|figure)[\s\S]*?<\/\1>/gi, ' ');
	const paragraphs = [];
	for (const m of cleaned.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)) {
		const text = stripHtml(m[1]);
		// skip boilerplate fragments (share prompts, cookie banners, bylines-only)
		if (text.length < 40) continue;
		paragraphs.push(text);
		if (paragraphs.length >= 60) break;
	}
	// Some sites (notably CMS-rendered Chinese outlets) use <div> text blocks.
	if (!paragraphs.length) {
		const text = stripHtml(cleaned);
		if (text.length > 200) {
			for (let i = 0; i < text.length && paragraphs.length < 20; i += 400) {
				paragraphs.push(text.slice(i, i + 400));
			}
		}
	}
	return paragraphs;
}

// ── Rung 2: reader service (Jina) ──────────────────────────────────────────

// Boilerplate a reader render still leaves in the markdown — nav labels, share
// prompts, subscribe CTAs, cookie notices. Matched case-insensitively against
// the whole line.
const READER_NOISE = /^(share|tweet|copy link|subscribe|sign up|sign in|log in|newsletter|advertisement|related|read more|read next|follow us|cookie|we use cookies|©|all rights reserved|disclaimer|table of contents|menu|toggle|skip to|home\b|search\b|back to)/i;

// Nav/UI chrome a reader render leaves inline reads like a run of short labels
// with no sentence punctuation ("Toggle navigation menu Toggle theme", "Markets
// Prices Research Events"). A real article paragraph almost always ends a
// sentence — so require sentence punctuation unless the block is long-form.
function looksLikeProse(block) {
	if (!/[.!?。]/.test(block)) return false; // no sentence terminator → nav/label chrome
	// Run-together nav menus ("DeFiCeFiTradFi & FintechBlockchains…") have almost
	// no spaces relative to their length.
	const spaces = (block.match(/\s/g) || []).length;
	if (spaces / block.length < 0.08) return false;
	// A run of Title-Case single words is a nav bar, not a sentence.
	const words = block.split(/\s+/);
	const titleWords = words.filter((w) => /^[A-Z][a-z’']+$/.test(w)).length;
	if (words.length >= 5 && titleWords / words.length > 0.7) return false;
	return true;
}

/**
 * Parse Jina Reader markdown into clean article paragraphs. Jina emits:
 *   Title: …
 *   URL Source: …
 *   Markdown Content:
 *   <the body, links as [text](url), images as ![alt](url), blank-line paras>
 */
export function paragraphsFromReaderMarkdown(md) {
	let body = md;
	const marker = md.indexOf('Markdown Content:');
	if (marker !== -1) body = md.slice(marker + 'Markdown Content:'.length);
	const out = [];
	// Paragraphs are blank-line separated; a single \n inside a block is a soft
	// wrap we join back together.
	for (const rawBlock of body.split(/\n{2,}/)) {
		let block = rawBlock
			.replace(/!\[[^\]]*\]\([^)]*\)/g, '') // images
			.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links → text
			.replace(/^#{1,6}\s+/gm, '') // headings → text
			.replace(/^>\s?/gm, '') // blockquote markers
			.replace(/[*_`]{1,3}/g, '') // emphasis / code marks
			.replace(/\s*\n\s*/g, ' ') // soft-wrap → space
			.trim();
		if (block.length < 45) continue; // teaser fragments, captions, nav labels
		if (READER_NOISE.test(block)) continue;
		if (/^[-*•|]/.test(block)) continue; // list / table chrome
		if ((block.match(/https?:\/\//g) || []).length > 2) continue; // link farms
		if (!looksLikeProse(block)) continue; // nav bars, label runs
		out.push(block.slice(0, 2000));
		if (out.length >= 60) break;
	}
	return out;
}

export async function fetchViaReader(url) {
	await assertPublicUrl(url);
	// r.jina.ai renders the page and returns readable markdown. Keyless and
	// free; a token unlocks higher limits but is not required.
	const resp = await fetch(`https://r.jina.ai/${url}`, {
		headers: {
			accept: 'text/plain',
			'x-return-format': 'markdown',
			'user-agent': BROWSER_UA,
		},
		redirect: 'follow',
		signal: AbortSignal.timeout(READER_TIMEOUT_MS),
	});
	if (!resp.ok) throw Object.assign(new Error(`reader responded ${resp.status}`), { status: resp.status });
	const md = await resp.text();
	if (md.length > MAX_RESPONSE_BYTES) throw new Error('reader response too large');
	return paragraphsFromReaderMarkdown(md);
}

// ── Rung 3: publisher feed body ────────────────────────────────────────────

export function paragraphsFromFeed(contentText) {
	return String(contentText || '')
		.split(/(?<=[.!?。])\s+(?=[A-Z0-9"“【「])|\n+/)
		.reduce((acc, sentence) => {
			const last = acc[acc.length - 1];
			if (last && last.length + sentence.length < 420) acc[acc.length - 1] = `${last} ${sentence}`;
			else acc.push(sentence);
			return acc;
		}, [])
		.filter((p) => p.trim().length > 20);
}

// A feed body that is just the publisher's teaser + a "read the full story"
// stub is NOT the full article — treat it as thin so the reader rung runs.
function feedBodyIsTeaser(paragraphs) {
	if (paragraphs.length >= 3) return false;
	const joined = paragraphs.join(' ');
	return joined.length < 600 || /read (the )?(full|more|rest)|continue reading|\[…\]|\.\.\.$/i.test(joined);
}

/**
 * Run the full extraction ladder for one article URL.
 *
 * @param {string} url             the (already-validated-as-absolute) target
 * @param {object} [opts]
 * @param {string} [opts.feedContentText]  publisher feed body, if any
 * @returns {Promise<{ paragraphs: string[], extraction: 'page'|'reader'|'feed'|'preview', blocked_reason: string|null, html: string|null }>}
 */
export async function extractArticle(url, { feedContentText = null } = {}) {
	let html = null;
	let fetchError = null;
	try {
		html = await fetchArticleHtml(url);
	} catch (err) {
		fetchError = err;
	}

	// Rung 1 — direct page prose.
	let paragraphs = html ? extractParagraphs(html) : [];
	if (paragraphs.length >= 3) {
		return { paragraphs, extraction: 'page', blocked_reason: null, html };
	}

	// Rung 2 — reader service. Runs when the page was blocked or yielded almost
	// nothing (paywall interstitial, JS-only shell). Never lose a good page
	// result: only replace it if the reader returns strictly more prose.
	let readerError = null;
	try {
		const readerParas = await fetchViaReader(url);
		if (readerParas.length > paragraphs.length && readerParas.length >= 2) {
			return { paragraphs: readerParas, extraction: 'reader', blocked_reason: null, html };
		}
	} catch (err) {
		readerError = err;
	}

	// A partial direct page (2 paragraphs) still beats the feed teaser.
	if (paragraphs.length >= 2) {
		return { paragraphs, extraction: 'page', blocked_reason: null, html };
	}

	// Rung 3 — publisher feed body, when it is more than a teaser.
	if (feedContentText) {
		const feedParas = paragraphsFromFeed(feedContentText);
		if (feedParas.length && !feedBodyIsTeaser(feedParas)) {
			return { paragraphs: feedParas, extraction: 'feed', blocked_reason: null, html };
		}
		// Even a teaser is better than nothing when both live rungs failed.
		if (feedParas.length && !html && readerError) {
			return { paragraphs: feedParas, extraction: 'feed', blocked_reason: null, html };
		}
	}

	// Rung 4 — honest preview.
	const reason = fetchError
		? String(fetchError.message || 'fetch failed')
		: readerError
			? String(readerError.message || 'reader failed')
			: 'no extractable article body';
	return { paragraphs, extraction: 'preview', blocked_reason: reason, html };
}
