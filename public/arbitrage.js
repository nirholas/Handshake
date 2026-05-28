// public/arbitrage.js — drives the x402 arbitrage page.
//
// Pulls /api/bazaar/arbitrage, renders one card per opportunity, supports
// a type filter (HTTP / MCP) and a free-text search across capability and
// provider host. "Pay cheapest" launches the existing x402.js payment modal
// so the arb view stays one click from execution.

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const els = {
	grid: $('#grid'),
	empty: $('#empty'),
	count: $('#count'),
	updated: $('#updated'),
	q: $('#q'),
};

const state = {
	all: [],
	filter: 'all',
	q: '',
};

function escapeHtml(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function relativeTime(iso) {
	if (!iso) return '—';
	const d = new Date(iso);
	const diff = Date.now() - d.getTime();
	if (diff < 60_000) return 'just now';
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
	return d.toLocaleString();
}

function renderSkeleton() {
	els.empty.hidden = true;
	const frag = document.createDocumentFragment();
	for (let i = 0; i < 6; i++) {
		const sk = document.createElement('div');
		sk.className = 'skeleton sk-card';
		frag.appendChild(sk);
	}
	els.grid.replaceChildren(frag);
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
	if (opps.length === 0) {
		els.grid.innerHTML = '';
		els.empty.hidden = false;
		els.empty.textContent = state.all.length
			? 'No matches. Clear the filter or search.'
			: 'No arbitrage opportunities right now. Check back as facilitators add listings.';
		return;
	}
	els.empty.hidden = true;
	const frag = document.createDocumentFragment();
	for (const o of opps) frag.appendChild(card(o));
	els.grid.replaceChildren(frag);
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
	worst.href = `/bazaar?q=${encodeURIComponent(o.capability || o.serviceName || '')}`;
	worst.textContent = `Avoid · ${o.maxPriceLabel}`;
	actions.append(best, worst);

	el.append(top, title, stats, providers, actions);
	return el;
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
		window.location.href = `/bazaar?q=${encodeURIComponent(o.capability)}`;
		return;
	}
	if (!window.X402 || typeof window.X402.pay !== 'function') {
		await loadX402();
	}
	btn.disabled = true;
	const orig = btn.textContent;
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
		if (e?.code !== 'cancelled') btn.textContent = `Error: ${e?.message || e}`;
		else btn.textContent = orig;
	} finally {
		setTimeout(() => { btn.disabled = false; if (!btn.textContent.startsWith('✓')) btn.textContent = orig; }, 4000);
	}
}

let _x402Loaded = null;
function loadX402() {
	if (_x402Loaded) return _x402Loaded;
	_x402Loaded = new Promise((resolve, reject) => {
		const s = document.createElement('script');
		s.type = 'module';
		s.src = '/x402.js';
		s.onload = () => resolve();
		s.onerror = (e) => reject(e);
		document.head.appendChild(s);
	});
	return _x402Loaded;
}

async function load() {
	renderSkeleton();
	try {
		const r = await fetch('/api/bazaar/arbitrage?minSpreadPct=0&limit=200');
		const data = await r.json();
		if (!r.ok) throw new Error(data?.error_description || data?.error || `HTTP ${r.status}`);
		state.all = data.opportunities || [];
		els.updated.textContent = relativeTime(data.updatedAt);
		renderGrid();
	} catch (e) {
		els.grid.innerHTML = '';
		els.empty.hidden = false;
		els.empty.className = 'err';
		els.empty.textContent = `Failed to load arbitrage: ${e?.message || e}`;
	}
}

for (const chip of $$('.chip[data-filter]')) {
	chip.addEventListener('click', () => {
		$$('.chip[data-filter]').forEach((c) => c.classList.toggle('active', c === chip));
		state.filter = chip.dataset.filter;
		renderGrid();
	});
}
els.q.addEventListener('input', () => { state.q = els.q.value; renderGrid(); });

load();
