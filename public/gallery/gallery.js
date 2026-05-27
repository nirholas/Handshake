/**
 * /gallery — public avatar gallery.
 *
 * Lists every avatar with visibility=public on three.ws via GET /api/avatars/public.
 * Supports debounced search (?q=), tag filter (?tag=), infinite scroll via cursor
 * pagination, and URL state sync so deep links restore filters.
 *
 * Card actions:
 *   • Preview  → /app#model=<glb-url>  (opens in the main viewer)
 *   • Studio   → /studio?avatar=<id>   (preselect in widget studio)
 *   • Details  → /avatars/<id> (avatar studio page)
 *   • Embed    → /api/avatars/view tracker fires when the link is followed
 */

const els = {
	search: document.querySelector('[data-role="search"]'),
	searchClear: document.querySelector('[data-role="search-clear"]'),
	sort: document.querySelector('[data-role="sort"]'),
	tagWrap: document.querySelector('[data-role="tag-wrap"]'),
	tags: document.querySelector('[data-role="tags"]'),
	grid: document.querySelector('[data-role="grid"]'),
	status: document.querySelector('[data-role="status"]'),
	loadMore: document.querySelector('[data-role="load-more"]'),
	sentinel: document.querySelector('[data-role="sentinel"]'),
	statCount: document.querySelector('[data-role="stat-count"]'),
	statViews: document.querySelector('[data-role="stat-views"]'),
	myAvatarsChip: document.querySelector('[data-role="my-avatars-chip"]'),
};

// Hydrate filters from the URL so deep links restore state.
const initialParams = new URLSearchParams(location.search);
const state = {
	query: initialParams.get('q') || '',
	tag: initialParams.get('tag') || '',
	sortBy: initialParams.get('sort') || 'newest',
	cursor: null,
	loading: false,
	loadedTags: new Set(),
	totalLoaded: 0,
	total: null,
	totalViews: null,
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
		syncUrl();
		resetAndLoad();
	}, 250);
});

els.searchClear.addEventListener('click', () => {
	els.search.value = '';
	state.query = '';
	updateSearchClearVisibility();
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

els.loadMore.addEventListener('click', () => loadPage());

els.status.addEventListener('click', (e) => {
	if (e.target.closest('[data-role="clear-filters"]')) clearAllFilters();
});

els.grid.addEventListener('click', (e) => {
	const btn = e.target.closest('[data-role="card-embed"]');
	if (!btn) return;
	e.preventDefault();
	e.stopPropagation();
	openAvatarEmbedModal({
		avatarId: btn.dataset.avatarId,
		glbUrl: btn.dataset.glbUrl,
		name: btn.dataset.name,
	});
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
	state.sortBy = 'newest';
	els.search.value = '';
	if (els.sort) els.sort.value = 'newest';
	updateSearchClearVisibility();
	renderTags();
	syncUrl();
	resetAndLoad();
}

function resetAndLoad() {
	state.cursor = null;
	state.totalLoaded = 0;
	state.total = null;
	state.totalViews = null;
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

		// Client-side sort
		if (state.sortBy === 'popular') {
			avatars = [...avatars].sort((a, b) => (b.view_count || 0) - (a.view_count || 0));
		} else if (state.sortBy === 'alpha') {
			avatars = [...avatars].sort((a, b) =>
				(a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }),
			);
		}

		for (const a of avatars) {
			els.grid.appendChild(renderCard(a));
			state.totalLoaded += 1;
			for (const t of a.tags || []) state.loadedTags.add(t);
		}

		if (isFirstPage) {
			if (typeof data.total === 'number') state.total = data.total;
			if (typeof data.total_views === 'number') state.totalViews = data.total_views;
		}

		updateStats();
		renderTags();

		state.cursor = data.next_cursor || null;
		els.loadMore.hidden = !state.cursor;

		if (els.grid.children.length === 0) {
			const filtersActive = !!state.query || !!state.tag;
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
						<p>Be the first — upload a GLB in the dashboard and set its visibility to <strong>public</strong> so it shows up here.</p>
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
	els.statCount.textContent =
		state.total != null ? state.total.toLocaleString() : state.totalLoaded.toLocaleString();
	els.statViews.textContent =
		state.totalViews != null ? formatCompact(state.totalViews) : '—';
}

function formatCompact(n) {
	if (n < 1000) return String(n);
	if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '') + 'k';
	if (n < 1_000_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
	return (n / 1_000_000_000).toFixed(1).replace(/\.0$/, '') + 'B';
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

function renderCard(a) {
	const card = document.createElement('article');
	card.className = 'gallery-card';

	const glbUrl = a.model_url || '';
	const viewerUrl = glbUrl ? `/app#model=${encodeURIComponent(glbUrl)}` : '#';
	const detailUrl = `/avatars/${a.id}`;
	const studioUrl = `/studio?avatar=${encodeURIComponent(a.id)}`;

	const thumbSrc = a.thumbnail_url || `/api/avatars/${encodeURIComponent(a.id)}/og`;
	const thumb = `<img src="${escapeAttr(thumbSrc)}" alt="${escapeAttr(a.name || 'Avatar')}" loading="lazy" decoding="async" />`;

	const tagChips = (a.tags || [])
		.slice(0, 3)
		.map(
			(t) => `<span class="gallery-card-tag">${escapeHtml(t)}</span>`,
		)
		.join('');

	const created = formatRelative(a.created_at);

	card.innerHTML = `
		<a class="gallery-card-thumb" href="${escapeAttr(detailUrl)}" aria-label="${escapeAttr(a.name || 'Avatar')} details">
			${thumb}
			<span class="gallery-card-3dpill">3D</span>
			<span class="gallery-card-play" aria-hidden="true">▶</span>
		</a>
		<div class="gallery-card-body">
			<h3 class="gallery-card-name"><a href="${escapeAttr(detailUrl)}">${escapeHtml(a.name || 'Untitled')}</a></h3>
			${a.description ? `<p class="gallery-card-desc">${escapeHtml(a.description)}</p>` : ''}
			${tagChips ? `<div class="gallery-card-tags">${tagChips}</div>` : ''}
			<div class="gallery-card-foot">
				<span class="gallery-card-meta">
					<span title="${escapeAttr(new Date(a.created_at || Date.now()).toLocaleString())}">${escapeHtml(created)}</span>
				</span>
				<div class="gallery-card-actions">
					<a class="gallery-card-btn" href="${escapeAttr(viewerUrl)}" title="Open in viewer">View 3D</a>
					<a class="gallery-card-btn gallery-card-btn--primary" href="${escapeAttr(studioUrl)}" title="Use in Widget Studio">Use</a>
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

resetAndLoad();
