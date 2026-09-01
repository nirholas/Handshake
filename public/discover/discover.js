/**
 * /discover — ERC-8004 agent marketplace grid.
 *
 * Pulls from GET /api/explore (legacy endpoint name, indexes ERC-8004 directory).
 * Filters + infinite pagination via cursor.
 * Clicking a card opens the on-chain token page on the source chain's
 * explorer; clicking the 3D preview (when present) loads the GLB in the
 * main viewer via /app#model=<url>.
 *
 * Controls (search · filter · source · sort) are driven by the shared
 * list-controls toolkit (src/shared/list-controls.js) so /discover and
 * /marketplace browse identically: same debounced search, same chip/sort
 * vocabulary, same URL-sync, same back/forward behaviour. Loading / empty /
 * error states use the shared state-kit so every browse surface reads as one
 * product. This file owns only the page-specific data flow (the /api/explore
 * fetch, the chain dropdown, card rendering, infinite scroll, embed modals).
 */

import { createListControls } from '../../src/shared/list-controls.js';
import { skeletonHTML, emptyStateHTML, errorStateHTML } from '../../src/shared/state-kit.js';

const CHAINS = [
	{ id: 8453, name: 'Base' },
	{ id: 42161, name: 'Arbitrum One' },
	{ id: 56, name: 'BNB Chain' },
	{ id: 1, name: 'Ethereum' },
	{ id: 10, name: 'Optimism' },
	{ id: 137, name: 'Polygon' },
	{ id: 43114, name: 'Avalanche' },
	{ id: 100, name: 'Gnosis' },
	{ id: 250, name: 'Fantom' },
	{ id: 42220, name: 'Celo' },
	{ id: 59144, name: 'Linea' },
	{ id: 534352, name: 'Scroll' },
	{ id: 5000, name: 'Mantle' },
	{ id: 324, name: 'zkSync Era' },
	{ id: 1284, name: 'Moonbeam' },
	{ id: 97, name: 'BSC Testnet' },
	{ id: 84532, name: 'Base Sepolia' },
	{ id: 421614, name: 'Arbitrum Sepolia' },
	{ id: 11155111, name: 'Ethereum Sepolia' },
	{ id: 11155420, name: 'Optimism Sepolia' },
	{ id: 80002, name: 'Polygon Amoy' },
	{ id: 43113, name: 'Avalanche Fuji' },
];

const els = {
	listControls: document.querySelector('[data-role="list-controls"]'),
	chain: document.querySelector('[data-role="chain"]'),
	grid: document.querySelector('[data-role="grid"]'),
	stats: document.querySelector('[data-role="stats"]'),
	status: document.querySelector('[data-role="status"]'),
	loadMore: document.querySelector('[data-role="load-more"]'),
	sentinel: document.querySelector('[data-role="sentinel"]'),
	myAgentsChip: document.querySelector('[data-role="my-agents-chip"]'),
};

// Reveal "View my agents" chip + nav link when signed in.
fetch('/api/auth/me', { credentials: 'include' })
	.then((r) => (r.ok ? r.json() : null))
	.then((data) => {
		if (!data?.user) return;
		if (els.myAgentsChip) els.myAgentsChip.hidden = false;
		const navLink = document.getElementById('nav-my-agents');
		if (navLink) navLink.hidden = false;
	})
	.catch(() => {});

// Populate chain dropdown (page-specific — long dynamic option list, kept out of
// the shared toolkit which models fixed chip/sort vocabularies).
for (const c of CHAINS) {
	const opt = document.createElement('option');
	opt.value = String(c.id);
	opt.textContent = c.name;
	els.chain.appendChild(opt);
}

// Page state. Search / filter / source / sort are owned by the shared
// list-controls toolkit; chain + pagination cursor live here.
const state = {
	filter: '3d', // 'all' | '3d' | 'x402'
	source: 'all', // 'all' | 'onchain' | 'avatar' | 'solana'
	chainId: '',
	query: '',
	sortBy: 'newest', // 'newest' | 'x402' | 'alpha'
	cursor: null,
	loading: false,
};

const initialParams = new URLSearchParams(location.search);
const hasAnyParam = initialParams.toString().length > 0;

// Pre-select the chain dropdown from the URL (falls back to All for an unknown id).
const initialChain = initialParams.get('chain') || '';
if (initialChain) {
	const opt = els.chain.querySelector(`option[value="${CSS.escape(initialChain)}"]`);
	if (opt) els.chain.value = initialChain;
}

// Map /discover's legacy URL scheme (only3d / x402 / source / q / sort) onto the
// toolkit's state keys. Kept here so existing deep links from register-ui and
// shared bookmarks keep resolving, and the discover-rename test contract holds.
function hydrateFromUrl(params) {
	const only3d = params.get('only3d');
	const x402 = params.get('x402');
	let filter = 'all';
	if (only3d !== '0') filter = '3d'; // default: 3D-first showcase
	if (x402 === '1') filter = 'x402';
	if (only3d === '0' && x402 !== '1') filter = 'all';
	const source = ['onchain', 'avatar', 'solana'].includes(params.get('source'))
		? params.get('source')
		: 'all';
	return {
		q: (params.get('q') || '').trim(),
		filter,
		source,
		sort: params.get('sort') || 'newest',
	};
}

/** Write the toolkit/page state back to the URL in the legacy scheme. */
function syncUrl() {
	const p = new URLSearchParams();
	if (state.filter === '3d') p.set('only3d', '1');
	else if (state.filter === 'x402') { p.set('only3d', '0'); p.set('x402', '1'); }
	else p.set('only3d', '0');
	if (state.source !== 'all') p.set('source', state.source);
	if (state.chainId) p.set('chain', state.chainId);
	if (state.query) p.set('q', state.query);
	if (state.sortBy !== 'newest') p.set('sort', state.sortBy);
	const qs = p.toString();
	const next = qs ? `${location.pathname}?${qs}` : location.pathname;
	if (next !== location.pathname + location.search) {
		history.replaceState(null, '', next);
	}
}

// Shared list-controls toolkit: debounced search, filter + source chip segments,
// sort dropdown. URL-sync is owned by this page (legacy scheme), so urlSync:false.
const controls = createListControls({
	mount: els.listControls,
	searchKey: 'q',
	searchPlaceholder: 'Search by name or description…',
	searchLabel: 'Search agents',
	urlSync: false,
	hydrate: hydrateFromUrl,
	defaults: { q: '', filter: 'all', source: 'all', sort: 'newest' },
	segments: [
		{
			key: 'filter',
			label: 'Agent type',
			options: [
				{ value: 'all', label: 'All agents' },
				{ value: '3d', label: '3D only' },
				{ value: 'x402', label: 'x402' },
			],
		},
		{
			key: 'source',
			label: 'Source',
			options: [
				{ value: 'all', label: 'All sources' },
				{ value: 'solana', label: 'Solana' },
				{ value: 'onchain', label: 'EVM' },
				{ value: 'avatar', label: 'Avatars' },
			],
		},
	],
	sortKey: 'sort',
	sortOptions: [
		{ value: 'newest', label: 'Newest' },
		{ value: 'x402', label: 'x402 first' },
		{ value: 'alpha', label: 'A → Z' },
	],
	onChange: (s, meta) => {
		state.filter = s.filter;
		state.source = s.source;
		state.query = s.q;
		state.sortBy = s.sort;
		// popstate may have changed the chain via the dropdown's own URL handling;
		// re-read it so back/forward restores chain too.
		if (meta.reason === 'popstate') {
			const ch = new URLSearchParams(location.search).get('chain') || '';
			els.chain.value = ch && els.chain.querySelector(`option[value="${CSS.escape(ch)}"]`) ? ch : '';
			state.chainId = els.chain.value;
		}
		syncUrl();
		resetAndLoad();
	},
});

// Move the page-specific chain selector into the toolbar's primary row so it
// sits inline with search + sort (one visual control bar).
const chainWrap = document.querySelector('[data-role="chain-wrap"]');
const primaryRow = els.listControls.querySelector('.tws-lc-row--primary');
if (chainWrap && primaryRow) primaryRow.appendChild(chainWrap);

els.chain.addEventListener('change', () => {
	state.chainId = els.chain.value;
	syncUrl();
	resetAndLoad();
});

// Seed page state from the toolkit's hydrated (URL-derived) values so the first
// load reflects deep links and the 3D-first default before any user interaction.
{
	const s = controls.getState();
	state.filter = s.filter;
	state.source = s.source;
	state.query = s.q;
	state.sortBy = s.sort;
	state.chainId = els.chain.value;
}

// Canonicalise the URL on first load (covers the 3D-first default + ?q= deep links).
if (!hasAnyParam) syncUrl();

els.loadMore.addEventListener('click', () => loadPage());

// IntersectionObserver-based infinite scroll. Falls back to the manual button.
let io;
if ('IntersectionObserver' in window && els.sentinel) {
	io = new IntersectionObserver(
		(entries) => {
			for (const entry of entries) {
				if (entry.isIntersecting && state.cursor && !state.loading) loadPage();
			}
		},
		{ rootMargin: '480px 0px' },
	);
	io.observe(els.sentinel);
}

// Attended rotation, the same policy as src/shared/attended-rotation.js (this
// file ships from public/ verbatim, so it cannot import it). A card turns when
// it scrolls into view, settles once it has turned far enough to read as 3D,
// and turns again on hover or focus. Before this every card in the grid rotated
// for the life of the tab, and model-viewer blits each element's pixels every
// frame: four of them cost 31 s of main-thread time in a 40 s Lighthouse run
// and the page never went quiet enough to answer input.
const MV_SEL = 'model-viewer.explore-card-mv';
const SETTLE_MS = 12_000;
const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
function setCardRotation(mv, on) {
	if (!mv) return;
	if (on && !reduceMotion) mv.setAttribute('auto-rotate', '');
	else mv.removeAttribute('auto-rotate');
}
function turnCard(mv) {
	if (!mv || reduceMotion) return;
	setCardRotation(mv, true);
	clearTimeout(mv._settleTimer);
	mv._settleTimer = setTimeout(() => {
		if (!mv.matches(':hover') && !mv.closest('article')?.contains(document.activeElement)) {
			setCardRotation(mv, false);
		}
	}, SETTLE_MS);
}
const cardViewer = (target) => (target && target.closest ? target.closest(MV_SEL) : null);
els.grid.addEventListener('pointerover', (e) => turnCard(cardViewer(e.target)));
els.grid.addEventListener('pointerout', (e) => {
	const mv = cardViewer(e.target);
	if (mv && !(e.relatedTarget && mv.contains(e.relatedTarget))) setCardRotation(mv, false);
});
els.grid.addEventListener('focusin', (e) => {
	const card = e.target && e.target.closest ? e.target.closest('article') : null;
	turnCard(card && card.querySelector(MV_SEL));
});
els.grid.addEventListener('focusout', (e) => {
	const card = e.target && e.target.closest ? e.target.closest('article') : null;
	if (card && !(e.relatedTarget && card.contains(e.relatedTarget))) {
		setCardRotation(card.querySelector(MV_SEL), false);
	}
});
// Cards arrive from an infinite-scroll feed, so the observer is re-applied
// after every page render (see renderPage below); bound viewers are skipped.
const cardTurnObserver = 'IntersectionObserver' in window && !reduceMotion
	? new IntersectionObserver((entries) => {
		for (const entry of entries) {
			if (entry.isIntersecting) turnCard(entry.target);
			else setCardRotation(entry.target, false);
		}
	}, { rootMargin: '80px 0px' })
	: null;
function observeCardTurns() {
	if (!cardTurnObserver) return;
	for (const mv of els.grid.querySelectorAll(MV_SEL)) {
		if (mv.dataset.turnObserved === '1') continue;
		mv.dataset.turnObserved = '1';
		cardTurnObserver.observe(mv);
	}
}

// Delegated copy-URI click
els.grid.addEventListener('click', (e) => {
	const btn = e.target.closest('[data-role="card-copy-uri"]');
	if (!btn) return;
	e.preventDefault();
	e.stopPropagation();
	const uri = btn.dataset.uri;
	const done = (ok) => {
		btn.textContent = ok ? 'Copied!' : 'Failed';
		setTimeout(() => (btn.textContent = 'URI'), 1400);
	};
	if (navigator.clipboard?.writeText) {
		navigator.clipboard.writeText(uri).then(() => done(true), () => done(false));
	} else {
		done(false);
	}
});

// Delegated embed-button click — cards can be re-rendered freely
els.grid.addEventListener('click', (e) => {
	const btn = e.target.closest('[data-role="card-embed"]');
	if (!btn) return;
	e.preventDefault();
	e.stopPropagation();
	if (btn.dataset.kind === 'avatar') {
		openAvatarEmbedModal({
			avatarId: btn.dataset.avatarId,
			glbUrl: btn.dataset.glbUrl,
			name: btn.dataset.name,
		});
	} else {
		openEmbedModal({
			chainId: Number(btn.dataset.chainId),
			agentId: btn.dataset.agentId,
			name: btn.dataset.name,
		});
	}
});

// Loading placeholders use the shared state-kit skeleton (same shimmer + token
// vocabulary as /marketplace) so both browse surfaces look identical while data
// streams in. A wrapper class keeps them removable as a group.
function renderSkeletons(n) {
	const wrap = document.createElement('div');
	wrap.className = 'explore-skeletons';
	wrap.style.display = 'contents';
	wrap.innerHTML = skeletonHTML(n, 'card');
	els.grid.appendChild(wrap);
}

function clearSkeletons() {
	for (const node of els.grid.querySelectorAll('.explore-skeletons')) node.remove();
}

function resetAndLoad() {
	state.cursor = null;
	els.grid.innerHTML = '';
	renderSkeletons(12);
	loadPage();
}

async function loadPage() {
	if (state.loading) return;
	state.loading = true;
	els.loadMore.hidden = true;
	if (!state.cursor) {
		els.status.textContent = '';
		els.status.hidden = true;
	} else {
		els.status.hidden = false;
		els.status.textContent = 'Loading more…';
	}

	const params = new URLSearchParams();
	// x402 filter — fetch all then client-sort; 3d flag still goes to API
	if (state.filter === '3d') params.set('only3d', '1');
	if (state.source !== 'all') params.set('source', state.source);
	if (state.chainId) params.set('chain', state.chainId);
	if (state.query) params.set('q', state.query);
	if (state.cursor) params.set('cursor', state.cursor);
	params.set('limit', '48');

	const isFirstPage = !state.cursor;
	try {
		const res = await fetch(`/api/explore?${params.toString()}`);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = await res.json();

		clearSkeletons();

		let items = data.items || [];

		// Client-side x402 filter (API returns all; we narrow here)
		if (state.filter === 'x402') {
			items = items.filter((i) => i.x402Support || i.price != null);
		}

		// Client-side sort overlay
		if (state.sortBy === 'x402') {
			items = [...items].sort((a, b) => {
				const ax = a.x402Support || a.price != null ? 1 : 0;
				const bx = b.x402Support || b.price != null ? 1 : 0;
				return bx - ax;
			});
		} else if (state.sortBy === 'alpha') {
			items = [...items].sort((a, b) =>
				(a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }),
			);
		}

		for (const item of items) {
			els.grid.appendChild(renderCard(item));
		}
		observeCardTurns();
		state.cursor = data.nextCursor;
		els.loadMore.hidden = !state.cursor;

		// Directory totals are a snapshot of the whole index, not the current
		// page — render them once on the first page so they don't double-count or
		// flicker as more cards stream in on paginated loads.
		if (isFirstPage && data.totals) renderStats(data.totals);

		const visibleCards = els.grid.querySelectorAll('.explore-card').length;
		if (visibleCards === 0) {
			const filtersActive =
				controls.isFiltered() || !!state.chainId || state.filter !== 'all';
			// Shared state-kit empty shell — identical look to /marketplace's
			// zero-results. The "Clear filters" CTA carries data-role="clear-filters"
			// so the existing delegated handler resets every control.
			els.status.innerHTML = filtersActive
				? emptyStateHTML({
						title: 'No agents match these filters',
						body: 'Try a broader search, a different chain, or clear everything to see the full directory.',
						actions: [{ label: 'Clear filters', id: 'clear-filters', primary: true }],
					}).replace('data-sk-action="clear-filters"', 'data-sk-action="clear-filters" data-role="clear-filters"')
				: emptyStateHTML({
						title: 'No agents indexed yet',
						body: 'Be the first — forge a 3D model from a text prompt and register it as an agent.',
						actions: [{ label: 'Forge a model', href: '/forge', primary: true }],
					});
			els.status.hidden = false;
		} else {
			els.status.textContent = '';
			els.status.hidden = true;
		}
	} catch (err) {
		clearSkeletons();
		// Shared state-kit error shell with a retry CTA (data-sk-retry).
		els.status.innerHTML = errorStateHTML({
			title: "Couldn't load agents",
			body: 'Check your connection and try again.',
			scope: 'discover',
		});
		els.status.hidden = false;
	} finally {
		state.loading = false;
	}
}

// Delegated status-block clicks (the block is re-rendered each load). Matches
// both the state-kit hooks (data-sk-action / data-sk-retry) and the legacy
// data-role marker kept for backward-compatible selectors/tests.
els.status.addEventListener('click', (e) => {
	if (
		e.target.closest('[data-role="clear-filters"]') ||
		e.target.closest('[data-sk-action="clear-filters"]')
	) {
		clearAllFilters();
		return;
	}
	if (e.target.closest('[data-sk-retry]')) {
		els.status.textContent = 'Loading…';
		loadPage();
	}
});

// Resetting every control flows through the shared toolkit, which re-renders the
// chips, clears the search box, syncs the URL, and fires onChange → resetAndLoad.
function clearAllFilters() {
	els.chain.value = '';
	state.chainId = '';
	controls.reset();
}

function renderStats(totals) {
	if (!els.stats) return;
	const fmt = (n) => Number(n || 0).toLocaleString();
	const parts = [`${fmt(totals.all)} agents`];
	if (totals.threeD) parts.push(`${fmt(totals.threeD)} with 3D avatars`);
	if (totals.onchain) parts.push(`${fmt(totals.onchain)} on EVM chains`);
	if (totals.solana) parts.push(`${fmt(totals.solana)} on Solana`);
	els.stats.textContent = parts.join(' · ');
	els.stats.hidden = false;
}

function renderCard(item) {
	if (item.kind === 'avatar') return renderAvatarCard(item);
	if (item.kind === 'solana') return renderSolanaCard(item);
	return renderOnchainCard(item);
}

/**
 * Card thumbnail. Priority:
 *   1. Static image (R2 thumbnail or remote PNG)
 *   2. Live <model-viewer> preview of the GLB (lazy, no controls)
 *   3. Emoji placeholder
 * model-viewer is loaded once via index.html; lazy reveal limits work to
 * cards actually in viewport.
 */
function renderThumb({ image, glbUrl, has3d, alt }) {
	if (image) {
		// `decoding="async"` keeps the decode of every directory thumbnail off the
		// critical rendering path. These are 768px source images painted into a
		// 293px box, so a synchronous decode of a grid's worth of them lands as
		// main-thread blocking time right when the page is trying to become
		// interactive. The box itself is already reserved by CSS
		// (.explore-card-thumb is `aspect-ratio: 1 / 1`), so nothing shifts.
		return `<img src="${escapeAttr(image)}" alt="${escapeAttr(alt || '')}" loading="lazy" decoding="async" data-fallback="element" data-fallback-class="explore-card-ph" data-fallback-text="${has3d ? '🎭' : '🤖'}" />`;
	}
	if (glbUrl) {
		return `<model-viewer
			src="${escapeAttr(glbUrl)}"
			alt="${escapeAttr(alt || '')}"
			class="explore-card-mv"
			reveal="auto"
			loading="lazy"
			disable-zoom
			disable-pan
			disable-tap
			interaction-prompt="none"
			camera-controls="false"
			rotation-per-second="20deg"
			environment-image="neutral"
			shadow-intensity="0"
			exposure="1"
		></model-viewer>`;
	}
	return `<div class="explore-card-ph">${has3d ? '🎭' : '🤖'}</div>`;
}

function renderOnchainCard(item) {
	const card = document.createElement('article');
	card.className = 'explore-card' + (item.has3d ? ' explore-card--3d' : '');

	const thumb = renderThumb({
		image: item.image,
		glbUrl: item.glbUrl,
		has3d: item.has3d,
		alt: item.name,
	});

	const badges = [];
	badges.push(
		`<span class="explore-badge explore-badge--chain">${escapeHtml(item.chainName)}</span>`,
	);
	if (item.has3d) badges.push(`<span class="explore-badge explore-badge--3d">3D</span>`);
	if (item.x402Support)
		badges.push(`<span class="explore-badge explore-badge--x402">x402</span>`);

	const serviceChips = (item.services || [])
		.filter((s) => s.name && !['avatar', '3d'].includes(String(s.name).toLowerCase()))
		.slice(0, 3)
		.map((s) => `<span class="explore-svc">${escapeHtml(s.name)}</span>`)
		.join('');

	const detailUrl = item.detailUrl || `/a/${item.chainId}/${item.agentId}`;

	card.innerHTML = `
		<a class="explore-card-thumb" href="${escapeAttr(detailUrl)}">
			${thumb}
			${item.has3d ? '<span class="explore-card-play">▶</span>' : ''}
		</a>
		<div class="explore-card-body">
			<div class="explore-card-head">
				<h3 class="explore-card-name"><a class="explore-card-name-link" href="${escapeAttr(detailUrl)}">${escapeHtml(item.name)}</a></h3>
				<span class="explore-card-id">#${escapeHtml(item.agentId)}</span>
			</div>
			<div class="explore-card-badges">${badges.join('')}</div>
			${item.description ? `<p class="explore-card-desc">${escapeHtml(item.description)}</p>` : ''}
			${serviceChips ? `<div class="explore-card-svcs">${serviceChips}</div>` : ''}
			<div class="explore-card-foot">
				${item.ownerShort && item.ownerExplorerUrl
					? `<a class="explore-card-owner" href="${escapeAttr(item.ownerExplorerUrl)}" target="_blank" rel="noopener" title="${escapeAttr(item.owner)}">${escapeHtml(item.ownerShort)}</a>`
					: '<span class="explore-card-owner-empty" aria-hidden="true"></span>'}
				<div class="explore-card-actions">
					<a class="explore-card-link" href="${escapeAttr(detailUrl)}">Details</a>
					${item.viewerUrl ? `<a class="explore-card-link" href="${escapeAttr(item.viewerUrl)}">View 3D</a>` : ''}
					<button type="button" class="explore-card-link explore-card-link--ghost" data-role="card-copy-uri"
						data-uri="${escapeAttr(`agent://${item.chainId}/${item.agentId}`)}" title="Copy agent:// URI">URI</button>
					<button type="button" class="explore-card-link explore-card-link--ghost" data-role="card-embed"
						data-kind="onchain"
						data-chain-id="${escapeAttr(String(item.chainId))}"
						data-agent-id="${escapeAttr(String(item.agentId))}"
						data-name="${escapeAttr(item.name || `Agent #${item.agentId}`)}">Embed</button>
				</div>
			</div>
		</div>
	`;
	return card;
}

function renderAvatarCard(item) {
	const card = document.createElement('article');
	card.className = 'explore-card explore-card--3d explore-card--avatar';

	const thumb = renderThumb({
		image: item.image,
		glbUrl: item.glbUrl,
		has3d: true,
		alt: item.name,
	});

	const badges = [
		`<span class="explore-badge explore-badge--avatar">Public avatar</span>`,
		`<span class="explore-badge explore-badge--3d">3D</span>`,
	];

	const tagChips = (item.tags || [])
		.slice(0, 3)
		.map((t) => `<span class="explore-svc">${escapeHtml(t)}</span>`)
		.join('');

	const viewerUrl = item.viewerUrl || '#';
	const detailUrl = `/avatars/${encodeURIComponent(item.avatarId)}`;

	card.innerHTML = `
		<a class="explore-card-thumb" href="${escapeAttr(detailUrl)}">
			${thumb}
			<span class="explore-card-play">▶</span>
		</a>
		<div class="explore-card-body">
			<div class="explore-card-head">
				<h3 class="explore-card-name"><a class="explore-card-name-link" href="${escapeAttr(detailUrl)}">${escapeHtml(item.name)}</a></h3>
			</div>
			<div class="explore-card-badges">${badges.join('')}</div>
			${item.description ? `<p class="explore-card-desc">${escapeHtml(item.description)}</p>` : ''}
			${tagChips ? `<div class="explore-card-svcs">${tagChips}</div>` : ''}
			<div class="explore-card-foot">
				<span class="explore-card-owner" title="Avatar made public by its creator">
					@${escapeHtml(item.slug || 'avatar')}
				</span>
				<div class="explore-card-actions">
					<a class="explore-card-link" href="${escapeAttr(detailUrl)}">View avatar</a>
					<button type="button" class="explore-card-link explore-card-link--ghost" data-role="card-embed"
						data-kind="avatar"
						data-avatar-id="${escapeAttr(String(item.avatarId))}"
						data-glb-url="${escapeAttr(item.glbUrl || '')}"
						data-name="${escapeAttr(item.name || 'Avatar')}">Embed</button>
				</div>
			</div>
		</div>
	`;
	return card;
}

function renderSolanaCard(item) {
	const card = document.createElement('article');
	card.className = 'explore-card' + (item.has3d ? ' explore-card--3d' : '');

	const thumb = renderThumb({
		image: item.image,
		glbUrl: null,
		has3d: item.has3d,
		alt: item.name,
	});

	const badges = [
		`<span class="explore-badge explore-badge--solana">◎ Solana</span>`,
	];
	if (item.has3d) badges.push(`<span class="explore-badge explore-badge--3d">3D</span>`);

	const skillChips = (item.skills || [])
		.slice(0, 3)
		.map((s) => `<span class="explore-svc">${escapeHtml(s)}</span>`)
		.join('');

	// The API's detailUrl is authoritative: three.ws agents get their canonical
	// /agents/:id page, external registry rows their /discover/a/sol/:asset
	// detail. The local fallback covers a cached bundle outliving the API, and
	// only when the item actually has an asset; a platform agent without a mint
	// otherwise produced a dead /discover/a/sol/undefined link.
	const detailUrl = item.detailUrl
		|| (item.asset ? `/discover/a/sol/${encodeURIComponent(item.asset)}` : `/agents/${encodeURIComponent(item.agentId)}`);

	card.innerHTML = `
		<a class="explore-card-thumb" href="${escapeAttr(detailUrl)}">
			${thumb}
		</a>
		<div class="explore-card-body">
			<div class="explore-card-head">
				<h3 class="explore-card-name"><a class="explore-card-name-link" href="${escapeAttr(detailUrl)}">${escapeHtml(item.name)}</a></h3>
			</div>
			<div class="explore-card-badges">${badges.join('')}</div>
			${item.description ? `<p class="explore-card-desc">${escapeHtml(item.description)}</p>` : ''}
			${skillChips ? `<div class="explore-card-svcs">${skillChips}</div>` : ''}
			<div class="explore-card-foot">
				${(item.ownerShort || '') && item.ownerExplorerUrl
					? `<a class="explore-card-owner" href="${escapeAttr(item.ownerExplorerUrl)}" target="_blank" rel="noopener" title="${escapeAttr(item.owner || '')}">${escapeHtml(item.ownerShort)}</a>`
					: '<span class="explore-card-owner-empty" aria-hidden="true"></span>'}
				<div class="explore-card-actions">
					<a class="explore-card-link" href="${escapeAttr(detailUrl)}">Details</a>
					<a class="explore-card-link" href="${escapeAttr(item.explorerUrl || '#')}" target="_blank" rel="noopener">Solscan</a>
				</div>
			</div>
		</div>
	`;
	return card;
}

function escapeHtml(s) {
	return String(s ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}
function escapeAttr(s) {
	return escapeHtml(s).replace(/'/g, '&#39;');
}

// ─── Embed modal ──────────────────────────────────────────────────────────
const LIB_CDN_URL = 'https://three.ws/agent-3d/latest/agent-3d.js';

function openEmbedModal({ chainId, agentId, name }) {
	document.querySelector('.embed-modal')?.remove();

	const origin = location.origin;
	const pageUrl = `${origin}/a/${chainId}/${agentId}`;
	const embedUrl = `${origin}/a/${chainId}/${agentId}/embed`;
	const agentUri = `agent://${chainId}/${agentId}`;
	const displayName = name || `Agent #${agentId}`;

	const snippets = {
		webComponent: `<script type="module" src="${LIB_CDN_URL}"></script>\n<agent-3d src="${agentUri}" mode="inline" width="480px" responsive></agent-3d>`,
		iframe: `<iframe src="${embedUrl}" width="480" height="600" style="border:0;border-radius:12px" allow="autoplay; xr-spatial-tracking" sandbox="allow-scripts allow-same-origin allow-popups" title="${displayName}"></iframe>`,
		link: pageUrl,
		markdown: `[![${displayName}](${origin}/api/a-og?chain=${chainId}&id=${agentId})](${pageUrl})`,
		farcaster: pageUrl,
	};

	const modal = document.createElement('div');
	modal.className = 'embed-modal';
	modal.setAttribute('role', 'dialog');
	modal.setAttribute('aria-modal', 'true');
	modal.innerHTML = `
		<div class="embed-modal__backdrop" data-role="close"></div>
		<div class="embed-modal__panel" role="document">
			<header class="embed-modal__head">
				<div>
					<h2 class="embed-modal__title">Embed ${escapeHtml(displayName)}</h2>
					<p class="embed-modal__sub">Drop this anywhere — any site, any doc, any chat.</p>
				</div>
				<button type="button" class="embed-modal__close" data-role="close" aria-label="Close">×</button>
			</header>
			<div class="embed-modal__tabs" role="tablist">
				<button type="button" class="embed-tab is-active" data-tab="webComponent" role="tab" aria-selected="true">Web component</button>
				<button type="button" class="embed-tab" data-tab="iframe" role="tab" aria-selected="false">iframe</button>
				<button type="button" class="embed-tab" data-tab="link" role="tab" aria-selected="false">Link</button>
				<button type="button" class="embed-tab" data-tab="markdown" role="tab" aria-selected="false">Markdown</button>
				<button type="button" class="embed-tab" data-tab="farcaster" role="tab" aria-selected="false">Farcaster</button>
			</div>
			<div class="embed-modal__body">
				<div class="embed-pane is-active" data-pane="webComponent">
					<p class="embed-pane__hint">Full fidelity — avatar, animations, voice, memory. Requires script module.</p>
					<textarea class="embed-snippet" readonly rows="3">${escapeHtml(snippets.webComponent)}</textarea>
					<button type="button" class="embed-copy-btn" data-role="copy" data-key="webComponent">Copy</button>
				</div>
				<div class="embed-pane" data-pane="iframe">
					<p class="embed-pane__hint">Works anywhere that allows iframes: Notion, Substack, Ghost, blogs.</p>
					<textarea class="embed-snippet" readonly rows="3">${escapeHtml(snippets.iframe)}</textarea>
					<button type="button" class="embed-copy-btn" data-role="copy" data-key="iframe">Copy</button>
				</div>
				<div class="embed-pane" data-pane="link">
					<p class="embed-pane__hint">Unfurls in Slack, X, Discord, iMessage with a rich preview card.</p>
					<input class="embed-snippet embed-snippet--input" readonly value="${escapeAttr(snippets.link)}" />
					<button type="button" class="embed-copy-btn" data-role="copy" data-key="link">Copy</button>
				</div>
				<div class="embed-pane" data-pane="markdown">
					<p class="embed-pane__hint">GitHub README, Markdown blog — renders a preview card that links to the viewer.</p>
					<textarea class="embed-snippet" readonly rows="2">${escapeHtml(snippets.markdown)}</textarea>
					<button type="button" class="embed-copy-btn" data-role="copy" data-key="markdown">Copy</button>
				</div>
				<div class="embed-pane" data-pane="farcaster">
					<p class="embed-pane__hint">Cast this link — Warpcast and compatible clients render an interactive Frame with View 3D + Explore buttons.</p>
					<input class="embed-snippet embed-snippet--input" readonly value="${escapeAttr(snippets.farcaster)}" />
					<button type="button" class="embed-copy-btn" data-role="copy" data-key="farcaster">Copy</button>
				</div>
			</div>
			<footer class="embed-modal__foot">
				<a href="${escapeAttr(pageUrl)}" target="_blank" rel="noopener" class="embed-foot-link">Open standalone page ↗</a>
				<a href="${escapeAttr(embedUrl)}" target="_blank" rel="noopener" class="embed-foot-link">Preview iframe ↗</a>
			</footer>
		</div>
	`;
	document.body.appendChild(modal);

	const close = () => {
		modal.remove();
		document.removeEventListener('keydown', onEsc);
	};
	const onEsc = (e) => {
		if (e.key === 'Escape') close();
	};
	document.addEventListener('keydown', onEsc);
	modal
		.querySelectorAll('[data-role="close"]')
		.forEach((el) => el.addEventListener('click', close));

	modal.querySelectorAll('.embed-tab').forEach((tab) => {
		tab.addEventListener('click', () => {
			modal.querySelectorAll('.embed-tab').forEach((t) => {
				t.classList.toggle('is-active', t === tab);
				t.setAttribute('aria-selected', t === tab ? 'true' : 'false');
			});
			modal.querySelectorAll('.embed-pane').forEach((p) => {
				p.classList.toggle('is-active', p.dataset.pane === tab.dataset.tab);
			});
		});
	});

	modal.querySelectorAll('[data-role="copy"]').forEach((btn) => {
		btn.addEventListener('click', () => {
			const key = btn.dataset.key;
			const text = snippets[key];
			if (!text) return;
			const done = (ok) => {
				btn.textContent = ok ? 'Copied ✓' : 'Copy failed';
				setTimeout(() => (btn.textContent = 'Copy'), 1400);
			};
			if (navigator.clipboard?.writeText) {
				navigator.clipboard.writeText(text).then(
					() => done(true),
					() => done(false),
				);
			} else {
				const ta = modal.querySelector(`[data-pane="${key}"] .embed-snippet`);
				ta?.select();
				try {
					document.execCommand('copy');
					done(true);
				} catch {
					done(false);
				}
			}
		});
	});

	setTimeout(() => {
		const first = modal.querySelector('.embed-pane.is-active .embed-snippet');
		first?.focus();
		first?.select?.();
	}, 50);
}

function openAvatarEmbedModal({ avatarId, glbUrl, name }) {
	document.querySelector('.embed-modal')?.remove();
	const origin = location.origin;
	const viewerUrl = `${origin}/app#model=${encodeURIComponent(glbUrl)}`;
	const apiUrl = `${origin}/api/avatars/${avatarId}`;
	const displayName = name || 'Avatar';

	const snippets = {
		webComponent: `<script type="module" src="${LIB_CDN_URL}"></script>\n<agent-3d src="${apiUrl}" mode="inline" width="480px" responsive></agent-3d>`,
		iframe: `<iframe src="${viewerUrl}" width="480" height="600" style="border:0;border-radius:12px" allow="autoplay; xr-spatial-tracking" sandbox="allow-scripts allow-same-origin allow-popups" title="${displayName}"></iframe>`,
		link: viewerUrl,
		markdown: `[${displayName}](${viewerUrl})`,
	};

	const modal = document.createElement('div');
	modal.className = 'embed-modal';
	modal.setAttribute('role', 'dialog');
	modal.setAttribute('aria-modal', 'true');
	modal.innerHTML = `
		<div class="embed-modal__backdrop" data-role="close"></div>
		<div class="embed-modal__panel" role="document">
			<header class="embed-modal__head">
				<div>
					<h2 class="embed-modal__title">Embed ${escapeHtml(displayName)}</h2>
					<p class="embed-modal__sub">Public avatar — drop it in any page or doc.</p>
				</div>
				<button type="button" class="embed-modal__close" data-role="close" aria-label="Close">×</button>
			</header>
			<div class="embed-modal__tabs" role="tablist">
				<button type="button" class="embed-tab is-active" data-tab="webComponent" role="tab" aria-selected="true">Web component</button>
				<button type="button" class="embed-tab" data-tab="iframe" role="tab" aria-selected="false">iframe</button>
				<button type="button" class="embed-tab" data-tab="link" role="tab" aria-selected="false">Link</button>
				<button type="button" class="embed-tab" data-tab="markdown" role="tab" aria-selected="false">Markdown</button>
			</div>
			<div class="embed-modal__body">
				<div class="embed-pane is-active" data-pane="webComponent">
					<p class="embed-pane__hint">Renders the avatar via the &lt;agent-3d&gt; web component.</p>
					<textarea class="embed-snippet" readonly rows="3">${escapeHtml(snippets.webComponent)}</textarea>
					<button type="button" class="embed-copy-btn" data-role="copy" data-key="webComponent">Copy</button>
				</div>
				<div class="embed-pane" data-pane="iframe">
					<p class="embed-pane__hint">Works in Notion, Substack, Ghost, blogs.</p>
					<textarea class="embed-snippet" readonly rows="3">${escapeHtml(snippets.iframe)}</textarea>
					<button type="button" class="embed-copy-btn" data-role="copy" data-key="iframe">Copy</button>
				</div>
				<div class="embed-pane" data-pane="link">
					<p class="embed-pane__hint">Direct link to the viewer.</p>
					<input class="embed-snippet embed-snippet--input" readonly value="${escapeAttr(snippets.link)}" />
					<button type="button" class="embed-copy-btn" data-role="copy" data-key="link">Copy</button>
				</div>
				<div class="embed-pane" data-pane="markdown">
					<p class="embed-pane__hint">For READMEs and Markdown blogs.</p>
					<textarea class="embed-snippet" readonly rows="2">${escapeHtml(snippets.markdown)}</textarea>
					<button type="button" class="embed-copy-btn" data-role="copy" data-key="markdown">Copy</button>
				</div>
			</div>
			<footer class="embed-modal__foot">
				<a href="${escapeAttr(viewerUrl)}" target="_blank" rel="noopener" class="embed-foot-link">Open viewer ↗</a>
			</footer>
		</div>
	`;
	document.body.appendChild(modal);

	const close = () => {
		modal.remove();
		document.removeEventListener('keydown', onEsc);
	};
	const onEsc = (e) => {
		if (e.key === 'Escape') close();
	};
	document.addEventListener('keydown', onEsc);
	modal.querySelectorAll('[data-role="close"]').forEach((el) => el.addEventListener('click', close));

	modal.querySelectorAll('.embed-tab').forEach((tab) => {
		tab.addEventListener('click', () => {
			modal.querySelectorAll('.embed-tab').forEach((t) => {
				t.classList.toggle('is-active', t === tab);
				t.setAttribute('aria-selected', t === tab ? 'true' : 'false');
			});
			modal.querySelectorAll('.embed-pane').forEach((p) => {
				p.classList.toggle('is-active', p.dataset.pane === tab.dataset.tab);
			});
		});
	});

	modal.querySelectorAll('[data-role="copy"]').forEach((btn) => {
		btn.addEventListener('click', () => {
			const key = btn.dataset.key;
			const text = snippets[key];
			if (!text) return;
			const done = (ok) => {
				btn.textContent = ok ? 'Copied ✓' : 'Copy failed';
				setTimeout(() => (btn.textContent = 'Copy'), 1400);
			};
			if (navigator.clipboard?.writeText) {
				navigator.clipboard.writeText(text).then(
					() => done(true),
					() => done(false),
				);
			} else {
				const ta = modal.querySelector(`[data-pane="${key}"] .embed-snippet`);
				ta?.select();
				try {
					document.execCommand('copy');
					done(true);
				} catch {
					done(false);
				}
			}
		});
	});
}

// Initial load — render shared skeletons then fetch the first page.
resetAndLoad();
