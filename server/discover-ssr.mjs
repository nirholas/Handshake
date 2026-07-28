// Server-rendered directory content for /discover.
// ---------------------------------------------------------------------------
// The /discover shell is a client-rendered grid: crawlers and no-JS visitors
// used to receive an empty <div data-role="grid"> and nothing else. This
// module injects a real, indexable listing of the newest agents into that
// container at request time, using the exact same data source the client
// fetches (GET /api/explore, self-requested in-process so the endpoint's own
// caching, rate limiting, and query logic stay authoritative).
//
// The client (public/discover/discover.js) starts every load with
// `els.grid.innerHTML = ''` (resetAndLoad), so the injected markup is replaced
// wholesale on hydration: no duplication, no divergence. This mirrors the
// static-fallback-inside-the-container pattern used by docs/index.html.
//
// Behaviour:
//  - Success: injected HTML cached in-process for CACHE_TTL_MS (10 min).
//  - Any failure (API error, timeout, marker missing): returns null and
//    caches the failure for FAIL_TTL_MS (60 s); the caller serves the plain
//    static shell, so /discover never breaks because of this feature.

import { readFile } from 'node:fs/promises';

const CACHE_TTL_MS = 10 * 60 * 1000;
const FAIL_TTL_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 4000;
// Mirrors the client's first page (3D-first showcase) but capped so the
// document stays lean while still giving crawlers a real directory sample.
const ITEM_LIMIT = 24;

const GRID_MARKER = '<div class="explore-grid" data-role="grid"></div>';
const STATS_MARKER = '<p class="explore-stats" data-role="stats" hidden></p>';

let cache = { html: null, expires: 0 };
let inFlight = null;

function escapeHtml(s) {
	return String(s ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}
const escapeAttr = (s) => escapeHtml(s).replace(/'/g, '&#39;');

/** Canonical on-site detail URL for an /api/explore item, or null. */
function detailUrl(item) {
	if (item.kind === 'avatar' && item.avatarId != null) {
		return `/avatars/${encodeURIComponent(item.avatarId)}`;
	}
	if (item.kind === 'solana') {
		if (item.asset) return `/discover/a/sol/${encodeURIComponent(item.asset)}`;
		// Own three.ws Solana agents without a Core asset still have a profile page.
		if (item.source === 'three.ws' && item.agentId != null) return `/agent/${encodeURIComponent(item.agentId)}`;
		return null;
	}
	if (item.chainId != null && item.agentId != null) {
		return `/discover/a/${encodeURIComponent(item.chainId)}/${encodeURIComponent(item.agentId)}`;
	}
	return null;
}

function itemBadge(item) {
	if (item.kind === 'avatar') return 'Public avatar';
	if (item.kind === 'solana') return 'Solana';
	return item.chainName || 'On-chain';
}

/** One lean, semantic card. Same class vocabulary as the hydrated grid so the
 *  pre-hydration paint reads as the same page; no model-viewer (heavy) and
 *  lazy images keep the document small. */
function renderItem(item) {
	const url = detailUrl(item);
	if (!url) return '';
	const name = item.name || 'Agent';
	const nameHtml = url
		? `<a class="explore-card-name-link" href="${escapeAttr(url)}">${escapeHtml(name)}</a>`
		: escapeHtml(name);
	const desc = (item.description || '').slice(0, 200);
	const thumb = item.image
		? `<a class="explore-card-thumb" href="${escapeAttr(url)}"><img src="${escapeAttr(item.image)}" alt="${escapeAttr(name)}" loading="lazy" /></a>`
		: '';
	return `<article class="explore-card${item.has3d ? ' explore-card--3d' : ''}">
	${thumb}
	<div class="explore-card-body">
		<div class="explore-card-head"><h3 class="explore-card-name">${nameHtml}</h3></div>
		<div class="explore-card-badges"><span class="explore-badge">${escapeHtml(itemBadge(item))}</span>${item.has3d ? '<span class="explore-badge explore-badge--3d">3D</span>' : ''}${item.x402Support ? '<span class="explore-badge explore-badge--x402">x402</span>' : ''}</div>
		${desc ? `<p class="explore-card-desc">${escapeHtml(desc)}</p>` : ''}
		<div class="explore-card-foot"><a class="explore-card-link" href="${escapeAttr(url)}">Details</a></div>
	</div>
</article>`;
}

function renderStatsText(totals) {
	const fmt = (n) => Number(n || 0).toLocaleString('en-US');
	const parts = [`${fmt(totals.all)} agents`];
	if (totals.threeD) parts.push(`${fmt(totals.threeD)} with 3D avatars`);
	if (totals.onchain) parts.push(`${fmt(totals.onchain)} on EVM chains`);
	if (totals.solana) parts.push(`${fmt(totals.solana)} on Solana`);
	return parts.join(' · ');
}

async function build(shellPath, apiBase) {
	const [shell, res] = await Promise.all([
		readFile(shellPath, 'utf8'),
		fetch(`${apiBase}/api/explore?only3d=1&limit=${ITEM_LIMIT}&quality=high`, {
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			headers: { accept: 'application/json' },
		}),
	]);
	if (!shell.includes(GRID_MARKER)) return null; // shell changed shape — serve it untouched
	if (!res.ok) throw new Error(`explore API HTTP ${res.status}`);
	const data = await res.json();
	const items = (data.items || []).slice(0, ITEM_LIMIT);
	if (items.length === 0) return null; // nothing real to inject — plain shell

	const cards = items.map(renderItem).filter(Boolean).join('\n');
	if (!cards) return null;

	let html = shell.replace(
		GRID_MARKER,
		`<div class="explore-grid" data-role="grid">${cards}</div>`,
	);
	if (data.totals && html.includes(STATS_MARKER)) {
		html = html.replace(
			STATS_MARKER,
			`<p class="explore-stats" data-role="stats">${escapeHtml(renderStatsText(data.totals))}</p>`,
		);
	}
	return html;
}

/**
 * Injected /discover HTML, or null when the plain static shell should be
 * served instead (data unavailable, marker missing, previous recent failure).
 * Never throws.
 *
 * @param {string} shellPath absolute path to dist/discover/index.html
 * @param {string} apiBase   origin the server itself listens on, e.g. http://127.0.0.1:8080
 */
export async function renderDiscoverHtml(shellPath, apiBase) {
	const now = Date.now();
	if (now < cache.expires) return cache.html;
	if (inFlight) return inFlight;
	inFlight = (async () => {
		try {
			const html = await build(shellPath, apiBase);
			cache = { html, expires: Date.now() + (html ? CACHE_TTL_MS : FAIL_TTL_MS) };
			return html;
		} catch (err) {
			console.error('[discover-ssr] falling back to plain shell:', err?.message || err);
			cache = { html: null, expires: Date.now() + FAIL_TTL_MS };
			return null;
		} finally {
			inFlight = null;
		}
	})();
	return inFlight;
}
