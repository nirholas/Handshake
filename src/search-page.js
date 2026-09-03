// /search: cross-entity discovery over GET /api/search. Debounced text query
// + type filter chips, fanning out to the federated backend (api/search.js /
// api/_lib/cross-search.js) and rendering one ranked grid of avatar/agent/
// model/world/coin cards. Model results carry a real, wired "Remix, $0.25"
// action against the same paid rail /creations uses (POST /api/x402/remix-asset),
// reusing that flow rather than re-deriving it.

import { ensureX402 } from './shared/x402-loader.js';

const $ = (id) => document.getElementById(id);

const TYPE_LABELS = {
	all: 'All',
	avatar: 'Avatars',
	agent: 'Agents',
	model: 'Models',
	world: 'Worlds',
	coin: 'Coins',
};

const TYPE_CREATE_CTA = {
	avatar: { label: 'Create an avatar', href: '/create#avatar-options' },
	agent: { label: 'Create an agent', href: '/create-agent' },
	model: { label: 'Forge a 3D model', href: '/forge' },
	world: { label: 'Build a world', href: '/diorama' },
	coin: { label: 'Launch a coin', href: '/launch' },
};

// Browse surfaces that stay useful when the search index itself is unreachable.
const FALLBACK_BROWSE = [
	{ label: 'Creator Gallery', href: '/creations' },
	{ label: 'Avatar Gallery', href: '/gallery' },
	{ label: 'Agents Index', href: '/agents' },
];

const state = { q: '', type: 'all', loading: false, controller: null, counts: null };

function esc(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function cssEscape(s) {
	return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&');
}

function isExternal(href) {
	return /^https?:/i.test(href || '');
}

// Off-site destinations open in a new tab and need rel hardening; in-site ones
// are plain same-tab links, so they get neither attribute.
function linkAttrs(href) {
	return isExternal(href) ? ' target="_blank" rel="noopener noreferrer"' : '';
}

function debounce(fn, ms) {
	let t;
	return (...args) => {
		clearTimeout(t);
		t = setTimeout(() => fn(...args), ms);
	};
}

function renderTypeChips() {
	const wrap = $('sr-types');
	if (!wrap) return;
	wrap.innerHTML = Object.entries(TYPE_LABELS)
		.map(([key, label]) => {
			const active = key === state.type;
			// counts come from the last "all" response, where every source really
			// was queried. A scoped response only counts its own type, so its
			// zeroes say nothing about the others and are ignored.
			const noMatches = !active && state.counts && key !== 'all' && state.counts[key] === 0;
			const cls = `sr-type-btn${active ? ' active' : ''}${noMatches ? ' is-empty' : ''}`;
			const title = noMatches ? ` title="No ${label.toLowerCase()} matched this query"` : '';
			return `<button type="button" class="${cls}" data-type="${key}" aria-pressed="${active}"${title}>${label}</button>`;
		})
		.join('');
}

function cardThumb(item) {
	if (item.glbUrl) {
		return `<div class="sr-card-thumb"><model-viewer class="sr-card-mv" src="${esc(item.glbUrl)}" auto-rotate camera-controls disable-zoom loading="lazy" reveal="auto" exposure="1.1"></model-viewer></div>`;
	}
	if (item.image) {
		return `<div class="sr-card-thumb"><img class="sr-card-img" src="${esc(item.image)}" alt="" loading="lazy" /></div>`;
	}
	return `<div class="sr-card-thumb"><div class="sr-card-noimg">${esc((item.title || '?')[0]?.toUpperCase() || '?')}</div></div>`;
}

function creatorHtml(item) {
	if (!item.creator) return '';
	const followers = item.signals?.followerCount;
	// A creator with no resolvable profile (a pure on-chain owner address, an
	// anonymous forge creation) is rendered as text, never as a dead "#" link.
	const name = item.creator.url
		? `<a class="sr-card-creator" href="${esc(item.creator.url)}"${linkAttrs(item.creator.url)}>${esc(item.creator.label)}</a>`
		: `<span class="sr-card-creator">${esc(item.creator.label)}</span>`;
	const count =
		typeof followers === 'number' && followers > 0
			? `<span class="sr-card-followers">· ${followers} follower${followers === 1 ? '' : 's'}</span>`
			: '';
	return name + count;
}

function cardHtml(item) {
	const href = item.assetUrl ? esc(item.assetUrl) : '';
	const attrs = linkAttrs(item.assetUrl);
	const title = esc(item.title);
	// The thumbnail repeats the title link's destination, so it stays out of the
	// tab order and the accessibility tree rather than shipping as a link with
	// no accessible name.
	const thumb = href
		? `<a class="sr-card-thumb-link" href="${href}"${attrs} tabindex="-1" aria-hidden="true">${cardThumb(item)}</a>`
		: cardThumb(item);
	const remixBtn = item.remix
		? `<button class="sr-card-btn sr-card-btn--remix" type="button" data-remix-open="${esc(item.id)}" aria-expanded="false" aria-label="Remix ${title} for $${item.remix.priceUsd.toFixed(2)}">Remix, $${item.remix.priceUsd.toFixed(2)}</button>`
		: '';
	const remixInline = item.remix
		? `<div class="sr-remix-inline" data-remix-inline="${esc(item.id)}">
				<label class="sr-remix-label" for="sr-remix-${esc(item.id)}">Describe the change</label>
				<input type="text" class="sr-remix-input" id="sr-remix-${esc(item.id)}" placeholder='e.g. "make it metallic"' maxlength="500" />
				<button class="sr-card-btn sr-card-btn--remix" type="button" data-remix-pay="${esc(item.id)}">Pay and remix</button>
				<div class="sr-remix-status" role="status" aria-live="polite"></div>
			</div>`
		: '';
	return `
		<article class="sr-card" data-item-id="${esc(item.id)}">
			${thumb}
			<span class="sr-card-type">${esc(item.type)}</span>
			<div class="sr-card-body">
				<h3 class="sr-card-title">${href ? `<a href="${href}"${attrs}>${title}</a>` : title}</h3>
				${item.description ? `<p class="sr-card-desc">${esc(item.description)}</p>` : ''}
				<div class="sr-card-meta">${creatorHtml(item)}</div>
				<div class="sr-card-actions">
					${href ? `<a class="sr-card-btn" href="${href}"${attrs} aria-label="View ${title}">View</a>` : ''}
					${remixBtn}
				</div>
				${remixInline}
			</div>
		</article>`;
}

function emptyStateHtml() {
	const cta = state.type !== 'all' && TYPE_CREATE_CTA[state.type] ? TYPE_CREATE_CTA[state.type] : null;
	const ctas = Object.values(TYPE_CREATE_CTA);
	return `
		<div class="sr-empty">
			<div class="sr-empty-title">Nothing matched "${esc(state.q)}"</div>
			<p class="sr-empty-sub">Try a broader term, switch type filters, or be the first to make one.</p>
			<div class="sr-empty-ctas">
				${cta ? `<a class="sr-card-btn sr-card-btn--remix" href="${cta.href}">${esc(cta.label)}</a>` : ctas.map((c) => `<a class="sr-card-btn" href="${c.href}">${esc(c.label)}</a>`).join('')}
			</div>
		</div>`;
}

// The backend answers 200 with { enabled: false } when its creation stores are
// not reachable. That is not "nothing matched", so it gets its own honest state
// pointing at the browse surfaces that are still live.
function warmingStateHtml() {
	return `
		<div class="sr-empty">
			<div class="sr-empty-title">Search is warming up</div>
			<p class="sr-empty-sub">The creation index is not reachable right now, so this query could not run. Browse by type in the meantime, or retry in a moment.</p>
			<div class="sr-empty-ctas">
				${FALLBACK_BROWSE.map((b) => `<a class="sr-card-btn" href="${b.href}">${b.label}</a>`).join('')}
				<button class="sr-card-btn sr-card-btn--remix" type="button" data-retry>Retry</button>
			</div>
		</div>`;
}

function errorStateHtml(message) {
	return `
		<div class="sr-error">
			<div class="sr-empty-title">Search is temporarily unavailable</div>
			<p class="sr-empty-sub">${esc(message)}</p>
			<div class="sr-empty-ctas">
				<button class="sr-card-btn sr-card-btn--remix" type="button" data-retry>Retry</button>
				${FALLBACK_BROWSE.map((b) => `<a class="sr-card-btn" href="${b.href}">${b.label}</a>`).join('')}
			</div>
		</div>`;
}

function skeletonHtml(n = 8) {
	return Array.from({ length: n }, () => '<div class="sr-skeleton"></div>').join('');
}

function syncUrl() {
	const params = new URLSearchParams();
	if (state.q) params.set('q', state.q);
	if (state.type !== 'all') params.set('type', state.type);
	const qs = params.toString();
	history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
}

async function runSearch() {
	const grid = $('sr-grid');
	const countEl = $('sr-count');
	if (!grid) return;
	state.controller?.abort();
	const controller = new AbortController();
	state.controller = controller;
	state.loading = true;

	if (!state.q) {
		grid.innerHTML = '';
		if (countEl) countEl.textContent = '';
		state.counts = null;
		renderTypeChips();
		$('sr-quicklinks')?.removeAttribute('hidden');
		state.loading = false;
		return;
	}
	$('sr-quicklinks')?.setAttribute('hidden', '');
	grid.setAttribute('aria-busy', 'true');
	if (countEl) countEl.textContent = 'Searching…';
	grid.innerHTML = skeletonHtml();

	try {
		const params = new URLSearchParams({ q: state.q, type: state.type, limit: '24' });
		const res = await fetch(`/api/search?${params}`, { signal: controller.signal, headers: { accept: 'application/json' } });
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(data?.message || `search returned ${res.status}`);
		if (controller.signal.aborted) return;

		if (data.enabled === false) {
			state.counts = null;
			renderTypeChips();
			if (countEl) countEl.textContent = 'Search index unavailable';
			grid.innerHTML = warmingStateHtml();
			return;
		}

		const items = Array.isArray(data.items) ? data.items : [];
		state.counts = state.type === 'all' && data.counts ? data.counts : null;
		renderTypeChips();
		if (countEl) {
			countEl.textContent = items.length
				? `${items.length} result${items.length === 1 ? '' : 's'} for "${state.q}"`
				: `No results for "${state.q}"`;
		}
		grid.innerHTML = items.length ? items.map(cardHtml).join('') : emptyStateHtml();
	} catch (err) {
		if (controller.signal.aborted) return;
		if (countEl) countEl.textContent = 'Search failed';
		grid.innerHTML = errorStateHtml(err?.message || 'The search service did not respond. Please try again.');
	} finally {
		grid.removeAttribute('aria-busy');
		state.loading = false;
	}
}

const debouncedSearch = debounce(runSearch, 300);

function wireControls() {
	renderTypeChips();
	const input = $('sr-q');
	input?.addEventListener('input', (e) => {
		state.q = e.target.value.trim();
		syncUrl();
		debouncedSearch();
	});
	// Enter runs the query immediately instead of waiting out the debounce;
	// Escape clears it and returns the page to its idle browse state.
	input?.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') {
			e.preventDefault();
			state.q = input.value.trim();
			syncUrl();
			runSearch();
		} else if (e.key === 'Escape' && input.value) {
			e.preventDefault();
			input.value = '';
			state.q = '';
			syncUrl();
			runSearch();
		}
	});
	$('sr-types')?.addEventListener('click', (e) => {
		const btn = e.target.closest('[data-type]');
		if (!btn || btn.dataset.type === state.type) return;
		state.type = btn.dataset.type;
		state.counts = null;
		renderTypeChips();
		syncUrl();
		if (state.q) runSearch();
	});
	$('sr-grid')?.addEventListener('click', (e) => {
		if (e.target.closest('[data-retry]')) {
			runSearch();
			return;
		}
		const openBtn = e.target.closest('[data-remix-open]');
		if (openBtn) {
			const inline = document.querySelector(`[data-remix-inline="${cssEscape(openBtn.dataset.remixOpen)}"]`);
			const open = inline?.classList.toggle('is-open');
			openBtn.setAttribute('aria-expanded', String(Boolean(open)));
			if (open) inline.querySelector('input')?.focus();
			return;
		}
		const payId = e.target.closest('[data-remix-pay]')?.dataset.remixPay;
		if (payId) remixOne(payId, e.target.closest('.sr-card'));
	});
}

async function remixOne(sourceId, cardEl) {
	const inline = cardEl?.querySelector('[data-remix-inline]');
	const input = inline?.querySelector('.sr-remix-input');
	const statusEl = inline?.querySelector('.sr-remix-status');
	const payBtn = cardEl?.querySelector(`[data-remix-pay="${cssEscape(sourceId)}"]`);
	const instruction = input?.value.trim();
	if (!instruction) {
		if (statusEl) {
			statusEl.dataset.kind = 'error';
			statusEl.textContent = 'Describe the change first.';
		}
		input?.focus();
		return;
	}
	if (payBtn) payBtn.disabled = true;
	if (statusEl) {
		statusEl.textContent = 'Opening payment…';
		statusEl.dataset.kind = 'busy';
	}
	try {
		const X402 = await ensureX402();
		const out = await X402.pay({
			endpoint: '/api/x402/remix-asset',
			method: 'POST',
			body: { source_creation_id: sourceId, instruction },
			merchant: 'three.ws Remix Bazaar',
			action: 'Remix this model for $0.25 USDC (a royalty routes to its creator)',
		});
		const remix = out?.result?.remix;
		const royalty = out?.result?.royalty;
		if (statusEl) {
			statusEl.dataset.kind = 'done';
			statusEl.innerHTML = remix?.viewerUrl
				? `Remixed! <a href="${esc(remix.viewerUrl)}" target="_blank" rel="noopener noreferrer">View your new model</a>` +
					(royalty?.paid ? ` · $${esc(royalty.creatorUsd)} routed to the original creator.` : '')
				: 'Remix submitted.';
		}
		if (input) input.value = '';
	} catch (err) {
		if (statusEl) {
			statusEl.dataset.kind = 'error';
			statusEl.textContent = err?.message || 'Remix failed. Try again.';
		}
	} finally {
		if (payBtn) payBtn.disabled = false;
	}
}

// Runs BEFORE wireControls() paints the chips: reading ?type= afterwards left
// the chip row claiming "All" while the results were already scoped.
function initFromUrl() {
	const params = new URLSearchParams(location.search);
	const q = (params.get('q') || '').trim().slice(0, 80);
	const type = params.get('type');
	if (q) {
		state.q = q;
		const input = $('sr-q');
		if (input) input.value = q;
	}
	if (type && TYPE_LABELS[type]) state.type = type;
}

function boot() {
	initFromUrl();
	wireControls();
	if (state.q) runSearch();
	else $('sr-quicklinks')?.removeAttribute('hidden');
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
