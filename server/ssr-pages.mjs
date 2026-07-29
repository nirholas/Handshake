// Server-rendered content for JS-only pages.
//
// Some directory pages ship a static shell whose entire body is fetched and
// rendered by client JS. That is fine for a visitor with JavaScript, but a
// crawler, a text browser, a link unfurler, or anyone on a slow connection sees
// an empty page: /discover indexes 150k+ agents and served a 6.8 KB shell with
// zero agents in it.
//
// This module injects the page's OWN first view into the shell before it leaves
// the server. It is progressive enhancement, not cloaking: the markup rendered
// here is the same default query the client issues on load, so what a crawler
// reads is what a visitor sees. The client then replaces the block wholesale on
// hydration (each registered page clears its container before rendering), so
// there is never duplicated content.
//
// Safety rules this module holds itself to:
//   - Never fail a page. Any error, timeout, or malformed payload falls back to
//     the untouched static shell.
//   - Never block on a slow upstream: one short timeout, then fall back.
//   - Never stampede: concurrent requests share one in-flight refresh, and a
//     stale-but-good render keeps serving while a refresh runs.
//
// Adding a page: append an entry to PAGES. `marker` must appear exactly once in
// the shell, and the page's client code must clear that container before it
// renders, or the SSR block and the hydrated block would both be visible.

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 2500;
// A stale render still beats an empty grid, so we keep serving one for a while
// after its TTL if refreshes are failing.
const STALE_GRACE_MS = 60 * 60 * 1000;

function escapeHtml(s) {
	return String(s ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

const fmtInt = (n) => Number(n || 0).toLocaleString('en-US');

// ── /discover ───────────────────────────────────────────────────────────────
// Mirrors renderCard() in public/discover/discover.js closely enough that the
// pre-hydration paint is the real page rather than a placeholder, but ships no
// buttons: every control in the live card needs JS, and a dead button is worse
// than no button.
function renderDiscoverCard(item) {
	const name = escapeHtml(item.name || 'Agent');
	const chainName = escapeHtml(item.chainShortName || item.chainName || '');
	// Only on-chain items have a canonical detail page. Avatars and Solana rows
	// carry different identifiers, so they link to the surface that can show them.
	const detailUrl =
		item.kind === 'onchain' && item.chainId != null && item.agentId != null
			? `/discover/a/${encodeURIComponent(item.chainId)}/${encodeURIComponent(item.agentId)}`
			: item.viewerUrl || null;
	const heading = detailUrl
		? `<a class="explore-card-name-link" href="${escapeHtml(detailUrl)}">${name}</a>`
		: name;
	const badges = [];
	if (chainName) badges.push(`<span class="explore-badge">${chainName}</span>`);
	if (item.has3d) badges.push('<span class="explore-badge">3D</span>');
	if (item.x402Support) badges.push('<span class="explore-badge">x402</span>');
	const desc = item.description
		? `<p class="explore-card-desc">${escapeHtml(String(item.description).slice(0, 200))}</p>`
		: '';
	return (
		`<article class="explore-card">` +
		`<div class="explore-card-body">` +
		`<div class="explore-card-head"><h3 class="explore-card-name">${heading}</h3></div>` +
		(badges.length ? `<div class="explore-card-badges">${badges.join('')}</div>` : '') +
		desc +
		`</div>` +
		`</article>`
	);
}

function renderDiscover(data) {
	const items = Array.isArray(data?.items) ? data.items : [];
	if (!items.length) return null; // nothing real to say — leave the shell alone
	const cards = items.map(renderDiscoverCard).join('');
	const t = data.totals || {};
	const parts = [`${fmtInt(t.all)} agents`];
	if (t.threeD) parts.push(`${fmtInt(t.threeD)} with 3D avatars`);
	if (t.onchain) parts.push(`${fmtInt(t.onchain)} on EVM chains`);
	if (t.solana) parts.push(`${fmtInt(t.solana)} on Solana`);
	return {
		grid: cards,
		stats: escapeHtml(parts.join(' · ')),
	};
}

const PAGES = [
	{
		route: '/discover',
		file: 'discover/index.html',
		// The client's own first-load query (see loadPage() in discover.js), so the
		// server-rendered view and the hydrated view agree.
		api: '/api/explore?limit=24',
		build: renderDiscover,
		// Each replacement's marker must be unique within the shell.
		apply(html, rendered) {
			let out = html.replace(
				'<div class="explore-grid" data-role="grid"></div>',
				`<div class="explore-grid" data-role="grid">${rendered.grid}</div>`,
			);
			out = out.replace(
				'<p class="explore-stats" data-role="stats" hidden></p>',
				`<p class="explore-stats" data-role="stats">${rendered.stats}</p>`,
			);
			return out;
		},
	},
];

const byRoute = new Map(PAGES.map((p) => [p.route, p]));
const cache = new Map(); // route -> { html, builtAt, inflight }

export function isSsrRoute(pathname) {
	return byRoute.has(pathname);
}

async function fetchPageData(page, origin) {
	const ctl = new AbortController();
	const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
	try {
		const res = await fetch(new URL(page.api, origin), {
			signal: ctl.signal,
			headers: { accept: 'application/json' },
		});
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null; // network error, timeout, malformed JSON — all fall back
	} finally {
		clearTimeout(timer);
	}
}

async function refresh(page, shellHtml, origin) {
	const data = await fetchPageData(page, origin);
	if (!data) return null;
	let rendered;
	try {
		rendered = page.build(data);
	} catch {
		return null; // a shape change upstream must not take the page down
	}
	if (!rendered) return null;
	const html = page.apply(shellHtml, rendered);
	// A marker that no longer matches means the shell was edited without updating
	// this module. Serving the untouched shell is the honest outcome.
	return html === shellHtml ? null : html;
}

/**
 * Server-rendered HTML for a registered route, or null to serve the static file.
 *
 * @param {string} pathname   Request path, already resolved by the route table.
 * @param {string} shellHtml  The static shell as it exists on disk.
 * @param {string} origin     Loopback origin for the internal API call.
 * @returns {Promise<string|null>}
 */
export async function renderSsrPage(pathname, shellHtml, origin) {
	const page = byRoute.get(pathname);
	if (!page) return null;

	const now = Date.now();
	let entry = cache.get(pathname);
	if (!entry) {
		entry = { html: null, builtAt: 0, inflight: null };
		cache.set(pathname, entry);
	}

	const ttl = page.ttlMs || DEFAULT_TTL_MS;
	const fresh = entry.html && now - entry.builtAt < ttl;
	if (fresh) return entry.html;

	if (!entry.inflight) {
		entry.inflight = refresh(page, shellHtml, origin)
			.then((html) => {
				if (html) {
					entry.html = html;
					entry.builtAt = Date.now();
				}
				return html;
			})
			.catch(() => null)
			.finally(() => {
				entry.inflight = null;
			});
	}

	// A usable stale render serves immediately and lets the refresh finish in the
	// background; only a cold cache waits on the upstream.
	if (entry.html && now - entry.builtAt < ttl + STALE_GRACE_MS) return entry.html;
	return await entry.inflight;
}

export const __test = { renderDiscover, renderDiscoverCard, escapeHtml, PAGES };
