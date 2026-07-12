// /search — cross-entity discovery over GET /api/search. Debounced text query
// + type filter chips, fanning out to the federated backend (api/search.js /
// api/_lib/cross-search.js) and rendering one ranked grid of avatar/agent/
// model/world/coin cards. Model results carry a real, wired "Remix — $0.25"
// action against the same paid rail /creations uses (POST /api/x402/remix-asset)
// — reusing that flow rather than re-deriving it.

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
	avatar: { label: 'Create an avatar', href: '/create-avatar' },
	agent: { label: 'Create an agent', href: '/agent/new' },
	model: { label: 'Forge a 3D model', href: '/forge' },
	world: { label: 'Build a world', href: '/diorama' },
	coin: { label: 'Launch a coin', href: '/launch' },
};

const state = { q: '', type: 'all', loading: false, controller: null };

function esc(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function cssEscape(s) {
	return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&');
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
		.map(
			([key, label]) =>
				`<button type="button" class="sr-type-btn${key === state.type ? ' active' : ''}" data-type="${key}" aria-pressed="${key === state.type}">${label}</button>`,
		)
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

function cardHtml(item) {
	const followers = item.signals?.followerCount;
	const creator = item.creator
		? `<a class="sr-card-creator" href="${esc(item.creator.url || '#')}"${item.creator.url ? '' : ' aria-disabled="true" tabindex="-1"'}>${esc(item.creator.label)}</a>${
				typeof followers === 'number' ? `<span class="sr-card-followers">· ${followers} follower${followers === 1 ? '' : 's'}</span>` : ''
			}`
		: '';
	const remixBtn = item.remix
		? `<button class="sr-card-btn sr-card-btn--remix" type="button" data-remix-open="${esc(item.id)}">Remix — $${item.remix.priceUsd.toFixed(2)}</button>`
		: '';
	const remixInline = item.remix
		? `<div class="sr-remix-inline" data-remix-inline="${esc(item.id)}">
				<input type="text" class="sr-remix-input" placeholder='Describe the change, e.g. "make it metallic"' maxlength="500" />
				<button class="sr-card-btn sr-card-btn--remix" type="button" data-remix-pay="${esc(item.id)}" data-remix-glb="${esc(item.glbUrl || '')}">Pay &amp; remix</button>
				<div class="sr-remix-status" role="status" aria-live="polite"></div>
			</div>`
		: '';
	return `
		<article class="sr-card" data-item-id="${esc(item.id)}">
			<a href="${esc(item.assetUrl || '#')}" target="${item.assetUrl?.startsWith('http') ? '_blank' : '_self'}" rel="noopener noreferrer">${cardThumb(item)}</a>
			<span class="sr-card-type">${esc(item.type)}</span>
			<div class="sr-card-body">
				<h3 class="sr-card-title"><a href="${esc(item.assetUrl || '#')}" target="${item.assetUrl?.startsWith('http') ? '_blank' : '_self'}" rel="noopener noreferrer">${esc(item.title)}</a></h3>
				${item.description ? `<p class="sr-card-desc">${esc(item.description)}</p>` : ''}
				<div class="sr-card-meta">${creator}</div>
				<div class="sr-card-actions">
					<a class="sr-card-btn" href="${esc(item.assetUrl || '#')}" target="${item.assetUrl?.startsWith('http') ? '_blank' : '_self'}" rel="noopener noreferrer">View</a>
					${remixBtn}
				</div>
				${remixInline}
			</div>
		</article>`;
}

function emptyStateHtml() {
	if (!state.q) {
		return '';
	}
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

function skeletonHtml(n = 8) {
	return Array.from({ length: n }, () => '<div class="sr-skeleton"></div>').join('');
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
		$('sr-quicklinks')?.removeAttribute('hidden');
		state.loading = false;
		return;
	}
	$('sr-quicklinks')?.setAttribute('hidden', '');
	grid.setAttribute('aria-busy', 'true');
	grid.innerHTML = skeletonHtml();

	try {
		const params = new URLSearchParams({ q: state.q, type: state.type, limit: '24' });
		const res = await fetch(`/api/search?${params}`, { signal: controller.signal, headers: { accept: 'application/json' } });
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(data?.message || `search returned ${res.status}`);
		if (controller.signal.aborted) return;

		const items = Array.isArray(data.items) ? data.items : [];
		if (countEl) {
			countEl.textContent = items.length
				? `${items.length} result${items.length === 1 ? '' : 's'} for "${state.q}"`
				: '';
		}
		grid.innerHTML = items.length ? items.map(cardHtml).join('') : emptyStateHtml();
	} catch (err) {
		if (controller.signal.aborted) return;
		grid.innerHTML = `<div class="sr-error"><div class="sr-empty-title">Search is temporarily unavailable</div><p>${esc(err?.message || 'Please try again.')} — <a href="#" data-retry>Retry</a></p></div>`;
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
		history.replaceState(null, '', state.q ? `?q=${encodeURIComponent(state.q)}${state.type !== 'all' ? `&type=${state.type}` : ''}` : location.pathname);
		debouncedSearch();
	});
	$('sr-types')?.addEventListener('click', (e) => {
		const btn = e.target.closest('[data-type]');
		if (!btn) return;
		state.type = btn.dataset.type;
		renderTypeChips();
		if (state.q) runSearch();
	});
	$('sr-grid')?.addEventListener('click', (e) => {
		if (e.target.closest('[data-retry]')) {
			e.preventDefault();
			runSearch();
			return;
		}
		const openId = e.target.closest('[data-remix-open]')?.dataset.remixOpen;
		if (openId) {
			const inline = document.querySelector(`[data-remix-inline="${cssEscape(openId)}"]`);
			inline?.classList.toggle('is-open');
			if (inline?.classList.contains('is-open')) inline.querySelector('input')?.focus();
			return;
		}
		const payId = e.target.closest('[data-remix-pay]')?.dataset.remixPay;
		if (payId) return remixOne(payId, e.target.closest('.sr-card'));
	});
}

async function remixOne(sourceId, cardEl) {
	const inline = cardEl?.querySelector('[data-remix-inline]');
	const input = inline?.querySelector('.sr-remix-input');
	const statusEl = inline?.querySelector('.sr-remix-status');
	const payBtn = cardEl?.querySelector(`[data-remix-pay="${cssEscape(sourceId)}"]`);
	const instruction = input?.value.trim();
	if (!instruction) {
		if (statusEl) statusEl.textContent = 'Describe the change first.';
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
			action: 'Remix this model — $0.25 USDC (a royalty routes to its creator)',
		});
		const remix = out?.result?.remix;
		const royalty = out?.result?.royalty;
		if (statusEl) {
			statusEl.dataset.kind = 'done';
			statusEl.innerHTML = remix?.viewerUrl
				? `Remixed! <a href="${esc(remix.viewerUrl)}" target="_blank" rel="noopener noreferrer">View your new model →</a>` +
					(royalty?.paid ? ` · $${royalty.creatorUsd} routed to the original creator.` : '')
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

function initFromUrl() {
	const params = new URLSearchParams(location.search);
	const q = (params.get('q') || '').trim();
	const type = params.get('type');
	if (q) {
		state.q = q;
		const input = $('sr-q');
		if (input) input.value = q;
	}
	if (type && TYPE_LABELS[type]) state.type = type;
}

document.addEventListener('DOMContentLoaded', () => {
	wireControls();
	initFromUrl();
	if (state.q) runSearch();
	else $('sr-quicklinks')?.removeAttribute('hidden');
});
