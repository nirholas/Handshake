// Server-side helpers for turning a URL into plain text we can chunk + embed.
// PDFs are extracted client-side (pdfjs in the studio bundle) and posted as
// text, so this module only needs to handle HTML / plain content fetches.

import { JSDOM } from 'jsdom';

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
	if (isPrivateHost(u.hostname)) {
		throw Object.assign(new Error('URL must be publicly reachable'), { status: 400 });
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	let res;
	try {
		res = await fetch(u.toString(), {
			redirect: 'follow',
			headers: {
				'user-agent': USER_AGENT,
				accept: 'text/html,text/plain,application/xhtml+xml',
			},
			signal: controller.signal,
		});
	} catch (err) {
		clearTimeout(timer);
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

	const dom = new JSDOM(raw);
	const doc = dom.window.document;
	doc.querySelectorAll(
		'script, style, noscript, template, svg, iframe, nav, footer, header, form, [aria-hidden="true"]',
	).forEach((el) => el.remove());

	const title =
		(
			doc.querySelector('meta[property="og:title"]')?.getAttribute('content') ||
			doc.querySelector('title')?.textContent ||
			''
		).trim() || derivedTitleFromUrl(u);

	const main = doc.querySelector('article, main, [role="main"], #main, #content') || doc.body;
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

// Block SSRF to private/loopback/link-local ranges. Resolution-time check is
// not perfect (DNS rebinding) but it eliminates accidental leaks; production
// should layer a network egress firewall on top.
function isPrivateHost(host) {
	const h = host.toLowerCase();
	if (h === 'localhost' || h === '0.0.0.0' || h === 'broadcasthost') return true;
	if (/\.local$|\.internal$|\.intranet$/.test(h)) return true;
	if (/^(?:127\.|10\.|192\.168\.|169\.254\.|::1$|fe80::|fc[0-9a-f]{2}:|fd[0-9a-f]{2}:)/i.test(h))
		return true;
	const m = h.match(/^172\.(\d{1,3})\./);
	if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
	return false;
}
