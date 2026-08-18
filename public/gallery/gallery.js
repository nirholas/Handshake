/**
 * /gallery — public avatar gallery.
 *
 * Lists every avatar with visibility=public on three.ws via GET /api/avatars/public.
 * Supports debounced search (?q=), category filter (?category=), tag filter (?tag=),
 * infinite scroll via cursor pagination, and URL state sync so deep links restore filters.
 *
 * Card actions:
 *   • Preview  → /app#model=<glb-url>  (opens in the main viewer)
 *   • Studio   → /studio?avatar=<id>   (preselect in widget studio)
 *   • Details  → /avatars/<id> (avatar studio page)
 *   • Embed    → /api/avatars/view tracker fires when the link is followed
 *   • Equip    → /avatars/:id/edit?equip-glb=… (accessory category only)
 */

// One-click "Surprise me" instant avatar. Self-wiring on import: attaches to the
// hero's [data-surprise-avatar] button and handles ?surprise=<seed> deep links.
import './surprise.js';

const els = {
	search: document.querySelector('[data-role="search"]'),
	searchClear: document.querySelector('[data-role="search-clear"]'),
	sort: document.querySelector('[data-role="sort"]'),
	catWrap: document.querySelector('[data-role="cat-wrap"]'),
	cats: document.querySelector('[data-role="cats"]'),
	rigWrap: document.querySelector('[data-role="rig-wrap"]'),
	rigs: document.querySelector('[data-role="rigs"]'),
	popWrap: document.querySelector('[data-role="pop-wrap"]'),
	pops: document.querySelector('[data-role="pops"]'),
	tagWrap: document.querySelector('[data-role="tag-wrap"]'),
	tags: document.querySelector('[data-role="tags"]'),
	grid: document.querySelector('[data-role="grid"]'),
	status: document.querySelector('[data-role="status"]'),
	loadMore: document.querySelector('[data-role="load-more"]'),
	sentinel: document.querySelector('[data-role="sentinel"]'),
	statCount: document.querySelector('[data-role="stat-count"]'),
	myAvatarsChip: document.querySelector('[data-role="my-avatars-chip"]'),
};

// Hydrate filters from the URL so deep links restore state.
const initialParams = new URLSearchParams(location.search);
const state = {
	query: initialParams.get('q') || '',
	tag: initialParams.get('tag') || '',
	category: initialParams.get('category') || '',
	rigged: initialParams.get('rigged') || '',
	sortBy: initialParams.get('sort') || 'newest',
	cursor: null,
	loading: false,
	loadedTags: new Set(),
	totalLoaded: 0,
	total: null,
};

if (state.query) els.search.value = state.query;
updateSearchClearVisibility();

// Reveal "My avatars" chip when signed in. Endpoint matches /discover.
fetch('/api/auth/me', { credentials: 'include' })
	.then((r) => (r.ok ? r.json() : null))
	.then((data) => {
		if (data?.user && els.myAvatarsChip) els.myAvatarsChip.hidden = false;
	})
	.catch(() => {});

function updateSearchClearVisibility() {
	if (!els.searchClear) return;
	els.searchClear.hidden = !els.search.value;
}

function syncUrl() {
	const p = new URLSearchParams();
	if (state.query) p.set('q', state.query);
	if (state.category) p.set('category', state.category);
	if (state.rigged) p.set('rigged', state.rigged);
	if (state.tag) p.set('tag', state.tag);
	if (state.sortBy !== 'newest') p.set('sort', state.sortBy);
	const qs = p.toString();
	const next = qs ? `${location.pathname}?${qs}` : location.pathname;
	if (next !== location.pathname + location.search) {
		history.replaceState(null, '', next);
	}
}

let searchDebounce;
els.search.addEventListener('input', () => {
	updateSearchClearVisibility();
	clearTimeout(searchDebounce);
	searchDebounce = setTimeout(() => {
		state.query = els.search.value.trim();
		renderPopular();
		syncUrl();
		resetAndLoad();
	}, 250);
});

els.searchClear.addEventListener('click', () => {
	els.search.value = '';
	state.query = '';
	updateSearchClearVisibility();
	renderPopular();
	syncUrl();
	resetAndLoad();
	els.search.focus();
});

els.sort?.addEventListener('change', () => {
	state.sortBy = els.sort.value;
	syncUrl();
	resetAndLoad();
});

if (els.sort && state.sortBy !== 'newest') {
	els.sort.value = state.sortBy;
}

els.tags.addEventListener('click', (e) => {
	const btn = e.target.closest('[data-tag]');
	if (!btn) return;
	const tag = btn.dataset.tag === state.tag ? '' : btn.dataset.tag;
	state.tag = tag;
	renderTags();
	syncUrl();
	resetAndLoad();
});

els.cats?.addEventListener('click', (e) => {
	const btn = e.target.closest('[data-cat]');
	if (!btn) return;
	const cat = btn.dataset.cat === state.category ? '' : btn.dataset.cat;
	state.category = cat;
	renderCats();
	syncUrl();
	resetAndLoad();
});

els.rigs?.addEventListener('click', (e) => {
	const btn = e.target.closest('[data-rig]');
	if (!btn) return;
	const rig = btn.dataset.rig === state.rigged ? '' : btn.dataset.rig;
	state.rigged = rig;
	renderRigs();
	syncUrl();
	resetAndLoad();
});

els.pops?.addEventListener('click', (e) => {
	const btn = e.target.closest('[data-pop]');
	if (!btn) return;
	// A second click on the active chip clears it, matching the tag/category chips.
	const next = btn.dataset.pop === state.query ? '' : btn.dataset.pop;
	state.query = next;
	els.search.value = next;
	clearTimeout(searchDebounce);
	updateSearchClearVisibility();
	renderPopular();
	syncUrl();
	resetAndLoad();
});

els.loadMore.addEventListener('click', () => loadPage());

els.status.addEventListener('click', (e) => {
	if (e.target.closest('[data-role="clear-filters"]')) clearAllFilters();
});

els.grid.addEventListener('click', (e) => {
	const embedBtn = e.target.closest('[data-role="card-embed"]');
	if (embedBtn) {
		e.preventDefault();
		e.stopPropagation();
		openAvatarEmbedModal({
			avatarId: embedBtn.dataset.avatarId,
			glbUrl: embedBtn.dataset.glbUrl,
			name: embedBtn.dataset.name,
		});
		return;
	}
	const equipBtn = e.target.closest('[data-role="card-equip"]');
	if (equipBtn) {
		e.preventDefault();
		e.stopPropagation();
		openEquipModal({
			accessoryId: equipBtn.dataset.avatarId,
			glbUrl: equipBtn.dataset.glbUrl,
			name: equipBtn.dataset.name,
			thumb: equipBtn.dataset.thumb,
		});
	}
});

// IntersectionObserver-based infinite scroll. Falls back to the manual
// "Load more" button if IO isn't available.
let io;
if ('IntersectionObserver' in window) {
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

function clearAllFilters() {
	state.query = '';
	state.tag = '';
	state.category = '';
	state.rigged = '';
	state.sortBy = 'newest';
	els.search.value = '';
	if (els.sort) els.sort.value = 'newest';
	updateSearchClearVisibility();
	renderTags();
	renderCats();
	renderRigs();
	renderPopular();
	syncUrl();
	resetAndLoad();
}

function resetAndLoad() {
	state.cursor = null;
	state.totalLoaded = 0;
	state.total = null;
	els.grid.innerHTML = '';
	renderSkeletons(8);
	loadPage();
}

function renderSkeletons(n) {
	const frag = document.createDocumentFragment();
	for (let i = 0; i < n; i++) {
		const card = document.createElement('article');
		card.className = 'gallery-card gallery-card--skel';
		card.innerHTML = `
			<div class="gallery-card-thumb"></div>
			<div class="gallery-card-body">
				<div class="gallery-card-name">&nbsp;</div>
				<div class="gallery-card-desc">&nbsp;</div>
				<div class="gallery-card-tags">&nbsp;</div>
			</div>
		`;
		frag.appendChild(card);
	}
	els.grid.appendChild(frag);
}

function clearSkeletons() {
	for (const node of els.grid.querySelectorAll('.gallery-card--skel')) node.remove();
}

async function loadPage() {
	if (state.loading) return;
	state.loading = true;
	els.loadMore.hidden = true;
	const isFirstPage = !state.cursor;
	if (!isFirstPage) {
		els.status.textContent = 'Loading more…';
	} else if (!els.grid.querySelector('.gallery-card--skel')) {
		els.status.textContent = 'Loading…';
	} else {
		els.status.textContent = '';
	}

	const params = new URLSearchParams();
	if (state.query) params.set('q', state.query);
	if (state.category) params.set('category', state.category);
	if (state.rigged) params.set('rigged', state.rigged);
	if (state.tag) params.set('tag', state.tag);
	if (state.cursor) params.set('cursor', state.cursor);
	params.set('limit', '24');
	if (isFirstPage) params.set('totals', '1');

	try {
		const res = await fetch(`/api/avatars/public?${params.toString()}`);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = await res.json();

		clearSkeletons();

		let avatars = Array.isArray(data.avatars) ? data.avatars : [];

		// Client-side sort (applies within the loaded set, like the server's
		// newest-first default does across pages).
		if (state.sortBy === 'alpha') {
			avatars = [...avatars].sort((a, b) =>
				(a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }),
			);
		} else if (state.sortBy === 'rigged') {
			// Rigged first, then by newest within each bucket.
			avatars = [...avatars].sort(
				(a, b) =>
					Number(isRigged(b)) - Number(isRigged(a)) ||
					new Date(b.created_at || 0) - new Date(a.created_at || 0),
			);
		}

		for (const a of avatars) {
			els.grid.appendChild(renderCard(a));
			state.totalLoaded += 1;
			for (const t of a.tags || []) state.loadedTags.add(t);
		}

		if (isFirstPage) {
			if (typeof data.total === 'number') state.total = data.total;
		}

		updateStats();
		renderTags();
		if (isFirstPage) renderCats();

		state.cursor = data.next_cursor || null;
		els.loadMore.hidden = !state.cursor;

		if (els.grid.children.length === 0) {
			const filtersActive = !!state.query || !!state.tag || !!state.category || !!state.rigged;
			els.status.innerHTML = filtersActive
				? `<div class="gallery-empty">
						<div class="gallery-empty-art">🔍</div>
						<h3>No public avatars match your filters</h3>
						<p>Try clearing the search or tag — or be the first to share one matching this query.</p>
						<button type="button" class="gallery-clear-filters" data-role="clear-filters">Clear filters</button>
						<a class="gallery-clear-cta" href="/dashboard/avatars">Upload yours</a>
					</div>`
				: `<div class="gallery-empty">
						<div class="gallery-empty-art">✨</div>
						<h3>No public avatars yet</h3>
						<p>Be the first — describe an avatar in a sentence and generate it, or upload a GLB in the dashboard and set its visibility to <strong>public</strong>.</p>
						<a class="gallery-clear-cta" href="/create/prompt">Create from a prompt</a>
						<a class="gallery-clear-cta" href="/dashboard/avatars">Open dashboard</a>
					</div>`;
		} else {
			els.status.textContent = '';
		}
	} catch (err) {
		clearSkeletons();
		els.status.innerHTML = `<div class="gallery-error">Failed to load avatars: ${escapeHtml(err.message)}</div>`;
	} finally {
		state.loading = false;
	}
}

function updateStats() {
	if (!els.statCount) return;
	els.statCount.textContent =
		state.total != null ? state.total.toLocaleString() : state.totalLoaded.toLocaleString();
}

function renderTags() {
	const tags = [...state.loadedTags].sort((a, b) => a.localeCompare(b));
	if (!tags.length && !state.tag) {
		els.tagWrap.hidden = true;
		els.tags.innerHTML = '';
		return;
	}
	els.tagWrap.hidden = false;
	const all = state.tag && !tags.includes(state.tag) ? [state.tag, ...tags] : tags;
	els.tags.innerHTML = all
		.map(
			(t) =>
				`<button type="button" class="gallery-tag${
					t === state.tag ? ' is-active' : ''
				}" data-tag="${escapeAttr(t)}">${escapeHtml(t)}</button>`,
		)
		.join('');
}

const CATEGORY_LABELS = [
	{ value: '', label: 'All' },
	{ value: 'avatar', label: 'Avatars' },
	{ value: 'accessory', label: 'Accessories' },
	{ value: 'item', label: 'Items' },
	{ value: 'scene', label: 'Scenes' },
	{ value: 'creature', label: 'Creatures' },
];

function renderCats() {
	if (!els.cats) return;
	els.cats.innerHTML = CATEGORY_LABELS
		.map(
			({ value, label }) =>
				`<button type="button" class="gallery-tag${
					value === state.category ? ' is-active' : ''
				}" data-cat="${escapeAttr(value)}">${escapeHtml(label)}</button>`,
		)
		.join('');
}

const RIG_LABELS = [
	{ value: '', label: 'All' },
	{ value: 'rigged', label: '⛹ Rigged' },
	{ value: 'static', label: '▢ Not rigged' },
];

function renderRigs() {
	if (!els.rigs) return;
	els.rigs.innerHTML = RIG_LABELS.map(
		({ value, label }) =>
			`<button type="button" class="gallery-tag${
				value === state.rigged ? ' is-active' : ''
			}" data-rig="${escapeAttr(value)}">${escapeHtml(label)}</button>`,
	).join('');
}

// ── Popular searches ───────────────────────────────────────────────────────
// Chips for the queries that surface the most public inventory, served by
// GET /api/avatars/popular-searches off the warm cache the Avatar Search Index
// Warmup pipeline fills. Each chip carries a sample thumbnail from that query's
// real top result, so the row previews what the search will return.
let popularSearches = [];

function renderPopular() {
	if (!els.pops || !els.popWrap) return;
	if (!popularSearches.length) {
		els.popWrap.hidden = true;
		els.pops.innerHTML = '';
		return;
	}
	els.popWrap.hidden = false;
	els.pops.innerHTML = popularSearches
		.map((s) => {
			const active = s.query === state.query;
			// Eager: these are 22px images at the top of the controls, always in the
			// first viewport, so deferring them only delays the row settling.
			const thumb = s.sample_thumbnail
				? `<img class="gallery-pop-thumb" src="${escapeAttr(s.sample_thumbnail)}" alt="" decoding="async" />`
				: '';
			const count = s.result_count > 0 ? `<span class="gallery-pop-count">${s.result_count}</span>` : '';
			const label = active ? `Clear the ${s.query} search` : `Search for ${s.query}`;
			return `<button type="button" class="gallery-tag gallery-pop${active ? ' is-active' : ''}" data-pop="${escapeAttr(
				s.query,
			)}" aria-pressed="${active}" aria-label="${escapeAttr(label)}">${thumb}<span>${escapeHtml(
				s.query,
			)}</span>${count}</button>`;
		})
		.join('');
	// A thumbnail whose object was pruned would otherwise leave a broken-image
	// box in the chip; drop the img and let the chip render as text only.
	for (const img of els.pops.querySelectorAll('.gallery-pop-thumb')) {
		img.addEventListener('error', () => img.remove(), { once: true });
	}
}

async function loadPopularSearches() {
	try {
		const res = await fetch('/api/avatars/popular-searches?limit=10');
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = await res.json();
		popularSearches = Array.isArray(data?.searches) ? data.searches.filter((s) => s?.query) : [];
		renderPopular();
	} catch {
		// Additive row: if the warm cache is unreachable the gallery loses a
		// shortcut, never a capability, so leave the row hidden and stay silent.
		popularSearches = [];
		renderPopular();
	}
}

loadPopularSearches();

// Classify a card's rig state via the shared classifier (window.twsRig bridge),
// degrading to source_meta inspection if the module hasn't loaded yet.
function isRigged(a) {
	if (window.twsRig?.classifyRig) return window.twsRig.classifyRig(a).rigged;
	const m = a?.source_meta || {};
	return m.is_rigged === true || (typeof m.skeleton_joint_count === 'number' && m.skeleton_joint_count > 0);
}

function renderCard(a) {
	const card = document.createElement('article');
	card.className = 'gallery-card';

	const glbUrl = a.model_url || '';
	const detailUrl = `/avatars/${a.id}`;
	const studioUrl = `/studio?avatar=${encodeURIComponent(a.id)}`;
	const animateUrl = `/pose?avatar=${encodeURIComponent(a.id)}`;

	const thumbSrc = a.thumbnail_url || `/api/avatars/${encodeURIComponent(a.id)}/og`;
	const altText = a.alt_text || a.name || 'Avatar';
	const created = formatRelative(a.created_at);

	const thumbContent = glbUrl
		? `<model-viewer
				src="${escapeAttr(glbUrl)}"
				alt="${escapeAttr(altText)}"
				class="gallery-card-mv"
				reveal="auto"
				loading="lazy"
				disable-zoom
				disable-pan
				disable-tap
				interaction-prompt="none"
				camera-controls="false"
				auto-rotate
				rotation-per-second="18deg"
				environment-image="neutral"
				shadow-intensity="0"
				exposure="1"
				poster="${escapeAttr(thumbSrc)}"
			></model-viewer>`
		: `<img src="${escapeAttr(thumbSrc)}" alt="${escapeAttr(altText)}" loading="lazy" decoding="async" />`;

	const tagChips = (a.tags || [])
		.slice(0, 3)
		.map((t) => `<span class="gallery-card-tag">${escapeHtml(t)}</span>`)
		.join('');

	const onchainBadge = window.twsOnchainBadge?.onchainBadgeHTML
		? window.twsOnchainBadge.onchainBadgeHTML(a, { link: false, showChain: true, size: 'sm' })
		: '';

	const rigBadge = window.twsRig?.rigBadgeHTML ? window.twsRig.rigBadgeHTML(a) : '';

	card.innerHTML = `
		<a class="gallery-card-thumb" href="${escapeAttr(detailUrl)}" aria-label="Open ${escapeAttr(a.name || 'Avatar')}">
			${thumbContent}
			<span class="gallery-card-3dpill">3D</span>
			${rigBadge ? `<span class="gallery-card-rig">${rigBadge}</span>` : ''}
			<span class="gallery-card-play" aria-hidden="true">▶</span>
		</a>
		<div class="gallery-card-body">
			<h3 class="gallery-card-name"><a href="${escapeAttr(detailUrl)}">${escapeHtml(a.name || 'Untitled')}</a></h3>
			${onchainBadge ? `<div class="gallery-card-onchain" style="margin:4px 0 2px">${onchainBadge}</div>` : ''}
			${a.description ? `<p class="gallery-card-desc">${escapeHtml(a.description)}</p>` : ''}
			${tagChips ? `<div class="gallery-card-tags">${tagChips}</div>` : ''}
			<div class="gallery-card-foot">
				<span class="gallery-card-meta">
					<span title="${escapeAttr(new Date(a.created_at || Date.now()).toLocaleString())}">${escapeHtml(created)}</span>
					${a.forked_from ? `<span class="gallery-card-fork" title="Forked from ${escapeAttr(a.forked_from.owner_name || a.forked_from.name || 'another avatar')}">⑂ fork</span>` : ''}
					${a.fork_count > 0 ? `<span class="gallery-card-fork" title="${a.fork_count} ${a.fork_count === 1 ? 'fork' : 'forks'}">⑂ ${a.fork_count}</span>` : ''}
				</span>
				<div class="gallery-card-actions">
					<button type="button" class="gallery-card-btn gallery-card-btn--ghost" data-role="card-embed"
						data-avatar-id="${escapeAttr(String(a.id))}"
						data-glb-url="${escapeAttr(glbUrl)}"
						data-name="${escapeAttr(a.name || 'Avatar')}">Embed</button>
					${a.model_category === 'accessory'
						? `<button type="button" class="gallery-card-btn gallery-card-btn--primary" data-role="card-equip"
								data-avatar-id="${escapeAttr(String(a.id))}"
								data-glb-url="${escapeAttr(glbUrl)}"
								data-name="${escapeAttr(a.name || 'Accessory')}"
								data-thumb="${escapeAttr(a.thumbnail_url || '')}">Equip</button>`
						: `<a class="gallery-card-btn gallery-card-btn--primary" href="${escapeAttr(studioUrl)}" title="Use in Widget Studio">Use</a>
						   <a class="gallery-card-btn gallery-card-btn--ghost" href="${escapeAttr(animateUrl)}" title="Animate this avatar in the Animation Studio">Animate</a>`
					}
				</div>
			</div>
		</div>
	`;
	return card;
}

function formatRelative(iso) {
	if (!iso) return '';
	const then = new Date(iso).getTime();
	if (Number.isNaN(then)) return '';
	const diff = Date.now() - then;
	const s = Math.max(0, Math.floor(diff / 1000));
	if (s < 60) return 'just now';
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	const d = Math.floor(h / 24);
	if (d < 7) return `${d}d ago`;
	const w = Math.floor(d / 7);
	if (w < 5) return `${w}w ago`;
	const mo = Math.floor(d / 30);
	if (mo < 12) return `${mo}mo ago`;
	const y = Math.floor(d / 365);
	return `${y}y ago`;
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

// ── Equip modal — pick an avatar to wear this accessory on ─────────────────
async function openEquipModal({ accessoryId, glbUrl, name, thumb }) {
	document.querySelector('.gallery-equip-modal')?.remove();

	const modal = document.createElement('div');
	modal.className = 'gallery-equip-modal embed-modal';
	modal.setAttribute('role', 'dialog');
	modal.setAttribute('aria-modal', 'true');
	modal.setAttribute('aria-label', `Equip ${name || 'accessory'}`);

	modal.innerHTML = `
		<div class="embed-modal__backdrop" data-role="close"></div>
		<div class="embed-modal__panel" role="document" style="max-width:460px">
			<header class="embed-modal__head">
				<div>
					<h2 class="embed-modal__title">Equip ${escapeHtml(name || 'Accessory')}</h2>
					<p class="embed-modal__sub">Choose an avatar to wear this accessory on.</p>
				</div>
				<button type="button" class="embed-modal__close" data-role="close" aria-label="Close">×</button>
			</header>
			<div class="equip-modal-body" data-role="equip-body">
				<div class="equip-modal-loading">Loading your avatars…</div>
			</div>
		</div>
	`;
	document.body.appendChild(modal);

	const close = () => {
		modal.remove();
		document.removeEventListener('keydown', onEsc);
	};
	const onEsc = (e) => { if (e.key === 'Escape') close(); };
	document.addEventListener('keydown', onEsc);
	modal.querySelectorAll('[data-role="close"]').forEach((el) => el.addEventListener('click', close));

	const body = modal.querySelector('[data-role="equip-body"]');

	try {
		const res = await fetch('/api/avatars', { credentials: 'include' });
		if (res.status === 401) {
			body.innerHTML = `
				<p class="equip-modal-hint">Sign in to equip accessories on your avatars.</p>
				<a class="gallery-card-btn gallery-card-btn--primary equip-signin-btn" href="/login?redirect=${encodeURIComponent(location.href)}">Sign in</a>
			`;
			return;
		}
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = await res.json();
		const avatars = Array.isArray(data.avatars) ? data.avatars : [];

		if (!avatars.length) {
			body.innerHTML = `
				<p class="equip-modal-hint">You have no avatars yet. Upload one first.</p>
				<a class="gallery-card-btn gallery-card-btn--primary equip-signin-btn" href="/dashboard/avatars">Upload avatar</a>
			`;
			return;
		}

		const list = document.createElement('div');
		list.className = 'equip-avatar-list';
		for (const av of avatars.slice(0, 12)) {
			const editUrl = `/avatars/${encodeURIComponent(av.id)}/edit?equip-glb=${encodeURIComponent(glbUrl || '')}&equip-name=${encodeURIComponent(name || '')}&equip-bone=Head`;
			const thumbSrc = av.thumbnail_url || `/api/avatars/${encodeURIComponent(av.id)}/og`;
			const row = document.createElement('a');
			row.href = editUrl;
			row.className = 'equip-avatar-row';
			row.innerHTML = `
				<img class="equip-avatar-thumb" src="${escapeAttr(thumbSrc)}" alt="" loading="lazy" decoding="async" />
				<span class="equip-avatar-name">${escapeHtml(av.name || 'Untitled')}</span>
				<span class="equip-avatar-cta">Equip →</span>
			`;
			list.appendChild(row);
		}
		body.innerHTML = '';
		body.appendChild(list);
	} catch (err) {
		body.innerHTML = `<p class="equip-modal-hint equip-modal-error">Could not load your avatars — ${escapeHtml(err.message)}</p>`;
	}
}

// Embed modal
const LIB_CDN_URL = 'https://three.ws/agent-3d/latest/agent-3d.js';

function openAvatarEmbedModal({ avatarId, glbUrl, name }) {
	document.querySelector('.gallery-embed-modal')?.remove();
	const origin = location.origin;
	const viewerUrl = glbUrl ? `${origin}/app#model=${encodeURIComponent(glbUrl)}` : `${origin}/avatars/${avatarId}`;
	const apiUrl = `${origin}/api/avatars/${avatarId}`;
	const displayName = name || 'Avatar';

	const snippets = {
		webComponent: `<script type="module" src="${LIB_CDN_URL}"><\/script>\n<agent-3d src="${apiUrl}" mode="inline" width="480px" responsive></agent-3d>`,
		iframe: `<iframe src="${viewerUrl}" width="480" height="600" style="border:0;border-radius:12px" allow="autoplay; xr-spatial-tracking" sandbox="allow-scripts allow-same-origin allow-popups" title="${displayName}"></iframe>`,
		link: viewerUrl,
		markdown: `[${displayName}](${viewerUrl})`,
	};

	const modal = document.createElement('div');
	modal.className = 'gallery-embed-modal embed-modal';
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
					<p class="embed-pane__hint">Full fidelity via the &lt;agent-3d&gt; web component.</p>
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
				<a href="${escapeAttr(`${origin}/avatars/${avatarId}`)}" target="_blank" rel="noopener" class="embed-foot-link">Avatar details ↗</a>
			</footer>
		</div>
	`;
	document.body.appendChild(modal);

	const close = () => {
		modal.remove();
		document.removeEventListener('keydown', onEsc);
	};
	const onEsc = (e) => { if (e.key === 'Escape') close(); };
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
				navigator.clipboard.writeText(text).then(() => done(true), () => done(false));
			} else {
				const ta = modal.querySelector(`[data-pane="${key}"] .embed-snippet`);
				ta?.select();
				try { document.execCommand('copy'); done(true); } catch { done(false); }
			}
		});
	});

	setTimeout(() => {
		const first = modal.querySelector('.embed-pane.is-active .embed-snippet');
		first?.focus();
		first?.select?.();
	}, 50);
}

renderCats();
renderRigs();
resetAndLoad();

// =============================================================================
// From the Forge — community 3D models auto-saved when users generate on /forge
// Cards use the same gallery-card design system for visual consistency.
// =============================================================================

const forgeEls = {
	section: document.getElementById('forge-section'),
	grid: document.getElementById('forge-grid'),
	count: document.getElementById('forge-count'),
};

// Deterministic gradient from prompt text — same string always same colors,
// so placeholders aren't a uniform dark void.
function forgePromptGradient(str) {
	let h = 0;
	for (let i = 0; i < (str || '').length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
	const hue = Math.abs(h) % 360;
	const hue2 = (hue + 50) % 360;
	return `linear-gradient(135deg, hsl(${hue},30%,13%) 0%, hsl(${hue2},22%,8%) 100%)`;
}

function forgeTimeAgo(iso) {
	const t = Date.parse(iso);
	if (!Number.isFinite(t)) return '';
	const m = Math.floor((Date.now() - t) / 60000);
	if (m < 1) return 'just now';
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	const d = Math.floor(h / 24);
	if (d < 7) return `${d}d ago`;
	const w = Math.floor(d / 7);
	if (w < 5) return `${w}w ago`;
	return `${Math.floor(d / 30)}mo ago`;
}

const FORGE_ENGINE_LABELS = {
	nvidia: 'Free',
	trellis: 'Trellis',
	meshy: 'Meshy',
	tripo: 'Tripo',
	hunyuan3d: 'Hunyuan3D',
	triposg: 'TripoSG',
};

function renderForgeCard(c) {
	const label = c.prompt || 'Forged model';
	const hasModel = !!c.glb_url;
	const openUrl = c.id
		? `/forge?share=${encodeURIComponent(c.id)}`
		: hasModel
		? `/app#model=${encodeURIComponent(c.glb_url)}`
		: c.prompt
		? `/forge?prompt=${encodeURIComponent(c.prompt)}`
		: '/forge';

	const card = document.createElement('div');
	card.className = 'gallery-card forge-card' + (hasModel ? '' : ' forge-card--no-model');
	// Plain container, NOT role="button": the card wraps a Remix <button> and a
	// View <a>, and an interactive card wrapping them is a nested-interactive
	// WCAG failure (4.1.2) plus aria-prohibited-attr (aria-label on a div).
	// The primary "open" action is a stretched transparent <a> appended at the
	// end of renderForgeCard; the footer sits above it via z-index.

	// Thumbnail — real image when available, deterministic gradient otherwise
	const thumb = document.createElement('div');
	thumb.className = 'gallery-card-thumb';

	if (c.preview_image_url) {
		const img = document.createElement('img');
		img.src = c.preview_image_url;
		img.alt = '';
		img.loading = 'lazy';
		img.decoding = 'async';
		thumb.appendChild(img);
	} else {
		// Gradient placeholder — deterministic color, centered cube icon
		thumb.style.background = forgePromptGradient(label);
		const glyph = document.createElement('span');
		glyph.className = 'forge-card-ph';
		glyph.setAttribute('aria-hidden', 'true');
		glyph.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2 3 7v10l9 5 9-5V7l-9-5Z"/><path d="m3 7 9 5 9-5"/><line x1="12" y1="12" x2="12" y2="22"/></svg>`;
		thumb.appendChild(glyph);
	}

	// Badge — "3D" for model cards, amber "prompt" for prompt-only
	const pill = document.createElement('span');
	if (hasModel) {
		pill.className = 'gallery-card-3dpill';
		pill.textContent = '3D';
	} else {
		pill.className = 'gallery-card-3dpill forge-card-prompt-pill';
		pill.textContent = 'prompt';
	}
	thumb.appendChild(pill);

	// Hover icon — play for model cards, remix arrow for prompt-only
	const play = document.createElement('div');
	play.className = 'gallery-card-play';
	play.setAttribute('aria-hidden', 'true');
	play.innerHTML = hasModel
		? `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.14v14l11-7-11-7Z"/></svg>`
		: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>`;
	thumb.appendChild(play);

	card.appendChild(thumb);

	// Body
	const body = document.createElement('div');
	body.className = 'gallery-card-body';

	const name = document.createElement('h3');
	name.className = 'gallery-card-name';
	name.title = label;
	// Limit display to keep cards compact — full prompt in title attr
	name.textContent = label.length > 60 ? label.slice(0, 57) + '…' : label;
	body.appendChild(name);

	// Engine/tier tags when available
	const tagsRow = document.createElement('div');
	tagsRow.className = 'gallery-card-tags';
	const tierStr = c.tier ? c.tier.charAt(0).toUpperCase() + c.tier.slice(1) : null;
	const backendStr = c.backend && c.backend !== 'trellis' ? FORGE_ENGINE_LABELS[c.backend] || c.backend : null;
	if (tierStr) {
		const t = document.createElement('span');
		t.className = 'gallery-card-tag';
		t.textContent = tierStr;
		tagsRow.appendChild(t);
	}
	if (backendStr) {
		const b = document.createElement('span');
		b.className = 'gallery-card-tag';
		b.textContent = backendStr;
		tagsRow.appendChild(b);
	}
	if (tagsRow.children.length) body.appendChild(tagsRow);

	// Footer
	const foot = document.createElement('div');
	foot.className = 'gallery-card-foot';

	const meta = document.createElement('span');
	meta.className = 'gallery-card-meta';
	meta.textContent = forgeTimeAgo(c.created_at);
	foot.appendChild(meta);

	const actions = document.createElement('div');
	actions.className = 'gallery-card-actions';

	if (hasModel && c.prompt) {
		const remixBtn = document.createElement('button');
		remixBtn.type = 'button';
		remixBtn.className = 'gallery-card-btn gallery-card-btn--ghost';
		remixBtn.textContent = 'Remix';
		remixBtn.title = 'Open in Forge with this prompt pre-loaded';
		remixBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			window.location.href = `/forge?prompt=${encodeURIComponent(c.prompt)}`;
		});
		actions.appendChild(remixBtn);
	}

	const openBtn = document.createElement('a');
	openBtn.className = 'gallery-card-btn gallery-card-btn--primary';
	openBtn.href = openUrl;
	openBtn.textContent = hasModel ? 'View' : 'Remix';
	openBtn.setAttribute('aria-label', hasModel ? `View "${label}" in Forge` : `Remix "${label}" prompt`);
	openBtn.addEventListener('click', (e) => e.stopPropagation());
	actions.appendChild(openBtn);

	foot.appendChild(actions);
	body.appendChild(foot);
	card.appendChild(body);

	// Stretched primary action (see the note at the top of renderForgeCard):
	// a real link, so keyboard and middle-click work natively.
	const stretch = document.createElement('a');
	stretch.className = 'forge-card-stretch';
	stretch.href = openUrl;
	stretch.setAttribute('aria-label', `Open in Forge: ${escapeAttr(label)}`);
	card.appendChild(stretch);
	return card;
}

function renderForgeSkeleton(n) {
	const frag = document.createDocumentFragment();
	for (let i = 0; i < n; i++) {
		const card = document.createElement('div');
		card.className = 'gallery-card gallery-card--skel forge-card';
		card.innerHTML = `
			<div class="gallery-card-thumb"></div>
			<div class="gallery-card-body">
				<div class="gallery-card-name">&nbsp;</div>
				<div class="gallery-card-desc">&nbsp;</div>
				<div class="gallery-card-tags">&nbsp;</div>
			</div>
		`;
		frag.appendChild(card);
	}
	forgeEls.grid.appendChild(frag);
}

async function loadForgeSection() {
	if (!forgeEls.section || !forgeEls.grid) return;
	renderForgeSkeleton(8);
	try {
		const res = await fetch('/api/forge-gallery?scope=community&limit=16');
		if (!res.ok) return;
		const data = await res.json().catch(() => ({}));
		forgeEls.grid.innerHTML = '';
		const all = Array.isArray(data?.creations) ? data.creations : [];

		// Dedupe by normalized prompt — no gallery of six identical teapots
		const seen = new Set();
		const creations = all.filter((c) => {
			const key = (c.prompt || c.id || '').toLowerCase().replace(/\s+/g, ' ').trim();
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});

		if (!data?.enabled || creations.length === 0) return;

		for (const c of creations) forgeEls.grid.appendChild(renderForgeCard(c));

		if (forgeEls.count) {
			forgeEls.count.textContent = `${creations.length} models`;
		}

		forgeEls.section.hidden = false;
	} catch {
		// Silently suppress — forge section is additive, never blocks the gallery
		forgeEls.grid.innerHTML = '';
	}
}

loadForgeSection();
