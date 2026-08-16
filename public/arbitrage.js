// public/arbitrage.js drives the x402 arbitrage page.
//
// Pulls /api/bazaar/arbitrage, renders one card per opportunity, supports
// a type filter (HTTP / MCP) and a free-text search across capability and
// provider host. "Pay cheapest" launches the existing x402.js payment modal
// so the arb view stays one click from execution.
//
// Inbound state comes from the query string: /bazaar deep-links here as
// /arbitrage?focus=<service> when a listing has priced peers, and the filter
// state is written back with replaceState so a filtered view is shareable.

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const els = {
	grid: $('#grid'),
	empty: $('#empty'),
	count: $('#count'),
	updated: $('#updated'),
	sources: $('#sources'),
	q: $('#q'),
};

const FILTERS = new Set(['all', 'http', 'mcp']);

const params = new URLSearchParams(location.search);
const initialFilter = String(params.get('type') || '').toLowerCase();

const state = {
	all: [],
	filter: FILTERS.has(initialFilter) ? initialFilter : 'all',
	// /bazaar sends the capability it wants compared as ?focus=; ?q= is the
	// form this page writes back, so accept either.
	q: params.get('focus') || params.get('q') || '',
};

function escapeHtml(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function relativeTime(iso) {
	if (!iso) return 'unknown';
	const d = new Date(iso);
	const diff = Date.now() - d.getTime();
	if (diff < 60_000) return 'just now';
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
	return d.toLocaleString();
}

function hostOf(u) {
	try { return new URL(u).host; } catch { return String(u || ''); }
}

// A spread is only as complete as the catalogs behind it. One facilitator
// dropping out removes its listings from every comparison, which reads as
// "fewer opportunities today" rather than "this scan is partial". Name the
// sources, and say plainly when the view is degraded.
function renderSources(sources, errors) {
	const byHost = new Map();
	for (const s of sources || []) {
		const host = hostOf(s.facilitator);
		if (!host) continue;
		const prev = byHost.get(host) || { host, count: 0, ok: true, reasons: [] };
		prev.count += Number(s.count) || 0;
		if (!s.ok) prev.ok = false;
		byHost.set(host, prev);
	}
	for (const e of errors || []) {
		const host = hostOf(e.facilitator);
		const prev = byHost.get(host);
		if (!prev) continue;
		prev.ok = false;
		if (e.error && !prev.reasons.includes(e.error)) prev.reasons.push(e.error);
	}
	const all = [...byHost.values()];
	if (all.length === 0) {
		els.sources.replaceChildren();
		return;
	}
	const down = all.filter((s) => !s.ok);
	const frag = document.createDocumentFragment();
	if (down.length) {
		const warn = document.createElement('span');
		warn.className = 'degraded';
		warn.textContent = `Partial scan: ${down.length} of ${all.length} facilitators unreachable`;
		frag.appendChild(warn);
	}
	for (const s of all) {
		const span = document.createElement('span');
		span.className = `src ${s.ok ? 'ok' : 'down'}`;
		span.textContent = s.ok ? `${s.host} ${s.count.toLocaleString()}` : `${s.host} unreachable`;
		if (s.reasons.length) span.title = s.reasons.join('; ');
		frag.appendChild(span);
	}
	els.sources.replaceChildren(frag);
}

function renderSkeleton() {
	els.empty.hidden = true;
	els.sources.replaceChildren();
	els.grid.setAttribute('aria-busy', 'true');
	els.updated.textContent = 'loading';
	const frag = document.createDocumentFragment();
	for (let i = 0; i < 6; i++) {
		const sk = document.createElement('div');
		sk.className = 'skeleton sk-card';
		frag.appendChild(sk);
	}
	els.grid.replaceChildren(frag);
}

// Keep the address bar in step with the visible filters so a filtered view can
// be shared or reloaded. replaceState keeps the back button pointing at
// whatever page linked here rather than at every keystroke.
function syncUrl() {
	const next = new URLSearchParams();
	if (state.filter !== 'all') next.set('type', state.filter);
	if (state.q.trim()) next.set('q', state.q.trim());
	const qs = next.toString();
	history.replaceState(null, '', qs ? `${location.pathname}?${qs}` : location.pathname);
}

function visibleOpps() {
	const q = state.q.trim().toLowerCase();
	return state.all.filter((o) => {
		if (state.filter !== 'all' && o.type !== state.filter) return false;
		if (!q) return true;
		const hay = [
			o.capability,
			o.serviceName,
			o.description,
			...(o.tags || []),
			...o.providers.flatMap((p) => [p.host, p.facilitator, p.serviceName]),
		].filter(Boolean).join(' ').toLowerCase();
		return hay.includes(q);
	});
}

function renderGrid() {
	const opps = visibleOpps();
	els.count.textContent = String(opps.length);
	els.grid.setAttribute('aria-busy', 'false');
	if (opps.length === 0) {
		renderEmpty();
		return;
	}
	els.empty.hidden = true;
	const frag = document.createDocumentFragment();
	for (const o of opps) frag.appendChild(card(o));
	els.grid.replaceChildren(frag);
}

// Two distinct empty states: the filters excluded everything (recoverable right
// here), or the feed genuinely has no cross-provider gap right now (the next
// useful move is the full catalog).
function renderEmpty() {
	els.grid.replaceChildren();
	els.empty.hidden = false;
	els.empty.className = 'empty';
	els.empty.removeAttribute('role');
	const narrowed = state.all.length > 0;
	els.empty.innerHTML = narrowed
		? `<div class="empty-title">No opportunities match these filters</div>
			<div>${state.all.length} live ${state.all.length === 1 ? 'opportunity is' : 'opportunities are'} hidden by the current type filter or search.</div>
			<div class="empty-actions"><button type="button" class="clear-btn">Clear filters</button><a href="/bazaar">Browse the full catalog</a></div>`
		: `<div class="empty-title">No cross-provider price gaps right now</div>
			<div>Every capability in the merged catalog is currently quoted at one price. New listings land continuously, so this fills back in on its own.</div>
			<div class="empty-actions"><button type="button" class="clear-btn">Refresh</button><a href="/bazaar">Browse the full catalog</a><a href="/providers">See provider profiles</a></div>`;
	els.empty.querySelector('.clear-btn').addEventListener('click', narrowed ? clearFilters : load);
}

function clearFilters() {
	state.filter = 'all';
	state.q = '';
	els.q.value = '';
	syncChips();
	syncUrl();
	renderGrid();
}

function syncChips() {
	for (const chip of $$('.chip[data-filter]')) {
		const on = chip.dataset.filter === state.filter;
		chip.classList.toggle('active', on);
		chip.setAttribute('aria-pressed', on ? 'true' : 'false');
	}
}

function card(o) {
	const el = document.createElement('div');
	el.className = 'arb';

	const top = document.createElement('div');
	top.className = 'top';
	top.innerHTML = `
		<span class="type-pill ${o.type === 'mcp' ? 'mcp' : ''}">${o.type.toUpperCase()}</span>
		<span class="spread-pill">+${o.spreadPct.toFixed(1)}% spread</span>
	`;

	const title = document.createElement('div');
	title.className = 'title';
	const icon = document.createElement('div');
	icon.className = 'icon';
	if (o.iconUrl) {
		const img = document.createElement('img');
		img.src = o.iconUrl;
		img.alt = '';
		img.referrerPolicy = 'no-referrer';
		img.onerror = () => { icon.textContent = (o.capability || '?').charAt(0).toUpperCase(); img.remove(); };
		icon.appendChild(img);
	} else {
		icon.textContent = (o.capability || '?').charAt(0).toUpperCase();
	}
	const t = document.createElement('div');
	t.className = 't';
	t.innerHTML = `${escapeHtml(o.capability || 'Capability')}<div class="sub">${escapeHtml(o.serviceName && o.serviceName !== o.capability ? o.serviceName : (o.tags || []).slice(0, 3).join(' · '))}</div>`;
	title.append(icon, t);

	const stats = document.createElement('div');
	stats.className = 'stats';
	stats.innerHTML = `
		<div><div class="k">Spread</div><div class="v amber">${escapeHtml(formatSpread(o))}</div></div>
		<div><div class="k">Providers</div><div class="v">${o.providerCount}</div></div>
		<div><div class="k">Listings</div><div class="v">${o.listingCount}</div></div>
		<div><div class="k">Facilitators</div><div class="v">${o.facilitatorCount}</div></div>
	`;

	const providers = document.createElement('div');
	providers.className = 'providers';
	const sorted = [...o.providers].sort((a, b) => a.priceAtomic - b.priceAtomic);
	const cheapestAtomic = sorted[0]?.priceAtomic;
	for (const p of sorted.slice(0, 5)) {
		const row = document.createElement('a');
		row.className = 'provider' + (p.priceAtomic === cheapestAtomic ? ' cheapest' : '');
		row.href = `/providers?host=${encodeURIComponent(p.host)}`;
		row.innerHTML = `
			<span class="dot"></span>
			<span class="host" title="${escapeHtml(p.resource)}">${escapeHtml(p.host || p.resource)}</span>
			<span class="fac" title="via ${escapeHtml(p.facilitator)}">${escapeHtml(shortFac(p.facilitator))}</span>
			<span class="price">${escapeHtml(p.priceLabel)}</span>
		`;
		providers.appendChild(row);
	}
	if (sorted.length > 5) {
		const more = document.createElement('div');
		more.className = 'provider';
		more.style.justifyContent = 'center';
		more.style.color = 'var(--muted)';
		more.textContent = `+${sorted.length - 5} more`;
		providers.appendChild(more);
	}

	const actions = document.createElement('div');
	actions.className = 'actions';
	const best = document.createElement('button');
	best.type = 'button';
	best.className = 'btn-best';
	best.textContent = `Pay cheapest · ${o.minPriceLabel}`;
	best.onclick = () => payCheapest(o, best);
	const worst = document.createElement('a');
	worst.className = 'btn-worst';
	worst.href = bazaarLink(o);
	worst.title = `Most expensive listing is ${o.mostExpensive?.host || 'unknown'} at ${o.maxPriceLabel}. Opens every listing for this capability in the catalog.`;
	worst.textContent = `Avoid · ${o.maxPriceLabel}`;
	actions.append(best, worst);

	el.append(top, title, stats, providers, actions);
	return el;
}

// The catalog defaults to HTTP listings, so an MCP capability has to say so or
// the deep link lands on a tab that cannot contain it.
function bazaarLink(o) {
	const p = new URLSearchParams({ q: o.capability || o.serviceName || '' });
	if (o.type === 'mcp') p.set('type', 'mcp');
	return `/bazaar?${p.toString()}`;
}

function formatSpread(o) {
	const usdc = o.spreadAtomic / 1_000_000;
	if (usdc >= 0.01) return `${usdc.toFixed(usdc < 1 ? 4 : 2)} USDC`;
	return `${o.spreadPct.toFixed(1)}%`;
}

function shortFac(host) {
	if (!host) return '';
	return host.replace(/^api\./, '').replace(/^facilitator\./, '').slice(0, 24);
}

async function payCheapest(o, btn) {
	if (!o.cheapest?.resource) return;
	if (o.type === 'mcp') {
		// MCP tools are invoked through a client session, not a one-shot HTTP
		// payment, so the cheapest listing opens in the catalog's tool inspector.
		window.location.href = bazaarLink(o);
		return;
	}
	const orig = btn.textContent;
	if (!window.X402 || typeof window.X402.pay !== 'function') {
		btn.disabled = true;
		btn.textContent = 'Loading payment modal…';
		try {
			await loadX402();
		} catch {
			// /x402.js 404'd or failed to evaluate: surface it instead of no-op.
			btn.textContent = 'Payment modal failed to load';
			setTimeout(() => { btn.disabled = false; btn.textContent = orig; }, 4000);
			return;
		}
		if (!window.X402 || typeof window.X402.pay !== 'function') {
			btn.textContent = 'Payment modal failed to load';
			setTimeout(() => { btn.disabled = false; btn.textContent = orig; }, 4000);
			return;
		}
	}
	btn.disabled = true;
	btn.textContent = 'Opening modal…';
	try {
		const out = await window.X402.pay({
			endpoint: o.cheapest.resource,
			method: 'GET',
			merchant: o.cheapest.host,
			action: o.capability,
		});
		if (out?.ok) {
			btn.textContent = '✓ Paid';
		} else if (out?.error) {
			btn.textContent = `Failed: ${out.error}`;
		} else {
			btn.textContent = orig;
		}
	} catch (e) {
		// Closing the modal is a deliberate "not now", not a failure: hand the
		// button straight back rather than parking it in a progress cursor for
		// four seconds while the user tries to click it again.
		if (e?.code === 'cancelled') {
			btn.disabled = false;
			btn.textContent = orig;
			return;
		}
		btn.textContent = `Error: ${e?.message || e}`;
	}
	setTimeout(() => { btn.disabled = false; if (!btn.textContent.startsWith('✓')) btn.textContent = orig; }, 4000);
}

let _x402Loaded = null;
function loadX402() {
	if (_x402Loaded) return _x402Loaded;
	_x402Loaded = new Promise((resolve, reject) => {
		const s = document.createElement('script');
		s.type = 'module';
		s.src = '/x402.js';
		s.onload = () => resolve();
		s.onerror = (e) => {
			// Drop the cached promise so a later click can retry the load.
			_x402Loaded = null;
			s.remove();
			reject(e);
		};
		document.head.appendChild(s);
	});
	return _x402Loaded;
}

async function load() {
	renderSkeleton();
	try {
		// Bound the request so a hung facilitator can't leave the skeletons up
		// forever. AbortSignal.timeout rejects with a TimeoutError after 20s.
		const r = await fetch('/api/bazaar/arbitrage?minSpreadPct=0&limit=200', {
			signal: AbortSignal.timeout(20000),
		});
		const data = await r.json();
		if (!r.ok) throw new Error(data?.error_description || data?.error || `HTTP ${r.status}`);
		state.all = data.opportunities || [];
		els.updated.textContent = relativeTime(data.updatedAt);
		renderSources(data.sources, data.errors);
		renderGrid();
	} catch (e) {
		const timedOut = e?.name === 'TimeoutError';
		const network = e instanceof TypeError;
		const title = timedOut
			? 'Request timed out'
			: network ? "Couldn't reach the arbitrage feed" : 'Failed to load arbitrage';
		const sub = timedOut
			? 'The facilitator feed took too long to respond.'
			: network ? 'Check your connection and try again.' : escapeHtml(e?.message || String(e));
		els.grid.replaceChildren();
		els.grid.setAttribute('aria-busy', 'false');
		els.sources.replaceChildren();
		els.count.textContent = '0';
		els.updated.textContent = 'unavailable';
		els.empty.hidden = false;
		els.empty.className = 'err';
		els.empty.setAttribute('role', 'alert');
		els.empty.innerHTML = `
			<div class="err-title">${title}</div>
			<div>${sub}</div>
			<button type="button" class="retry-btn">Retry</button>
		`;
		els.empty.querySelector('.retry-btn').addEventListener('click', load);
	}
}

for (const chip of $$('.chip[data-filter]')) {
	chip.addEventListener('click', () => {
		state.filter = chip.dataset.filter;
		syncChips();
		syncUrl();
		renderGrid();
	});
}
els.q.addEventListener('input', () => { state.q = els.q.value; syncUrl(); renderGrid(); });

els.q.value = state.q;
syncChips();

load();
