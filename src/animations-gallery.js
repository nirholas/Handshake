// /animations — public animation gallery.
//
// Surfaces three sources in one searchable, filterable grid:
//   • Community clips published by three.ws users (GET /api/animations/clips
//     ?include_public=true&visibility=public). Appear first, newest-first.
//   • The built-in three.ws motion library (/animations/manifest.json) — the
//     same curated clips the /pose studio ships with. Always present.
//   • The full motion library (GET /api/animations/library) — the complete
//     Mixamo-sourced catalog (2,800+ clips) hosted on the R2 CDN.
//
// All are normalized to one card shape — poster thumbnail, derived category
// (src/animation-categories.js), duration, loop mode — then filtered (search +
// category + loop/once), sorted, and paginated client-side (PAGE_SIZE at a time,
// infinite-scroll, lazy thumbnails). The full catalog is fetched from the CDN in
// bounded pages (LIBRARY_PAGE_SIZE) rather than one large response, so a library
// that grows past thousands of clips never lands as a single unbounded payload.
//
// Previews run through ONE shared WebGL engine (src/animations-live-preview.js):
// hovering a card (or opening the detail modal) moves the singleton canvas into
// that card and plays the retargeted clip on the preview avatar. No iframes,
// no per-card GL contexts, nothing 3D loaded until the first preview.
//
// Deep links: ?clip=<id> opens the detail modal; q/cat/filter/sort round-trip
// through the URL so filtered views are shareable.

import { GALLERY_CATEGORIES, galleryCategoryOf } from './animation-categories.js';
import { getLivePreview } from './animations-live-preview.js';

const API_BASE = '/api/animations/clips';
const MANIFEST_URL = '/animations/manifest.json';
const LIBRARY_API = '/api/animations/library';
const PAGE_SIZE = 36;
// Cap community pagination so a large catalog can't stall first paint.
const COMMUNITY_MAX = 300;
// Page size for the full CDN catalog fetch. Matches the endpoint's max page so
// each response stays bounded (~400 KB) as the library grows past thousands of
// clips, instead of one ever-growing blob. A hard ceiling of pages guards
// against a runaway manifest.
const LIBRARY_PAGE_SIZE = 1000;
const LIBRARY_MAX_PAGES = 50;
const HOVER_DELAY_MS = 130;

const REDUCED_MOTION = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const TOUCH_ONLY = window.matchMedia?.('(hover: none)').matches;

const $ = (role) => document.querySelector(`[data-role="${role}"]`);
const els = {
	loading: $('loading'),
	grid: $('grid'),
	empty: $('empty'),
	emptySearch: $('empty-search'),
	emptySearchMsg: $('empty-search-msg'),
	clearSearch: $('clear-search'),
	error: $('error'),
	retry: $('retry'),
	search: $('search'),
	chips: $('chips'),
	typeFilter: $('type-filter'),
	sort: $('sort'),
	count: $('count'),
	heroStats: $('hero-stats'),
	loadMore: $('load-more'),
	loadMoreBtn: $('load-more-btn'),
	sentinel: $('sentinel'),
	// Detail modal
	modal: $('modal'),
	modalStage: $('modal-stage'),
	modalSpinner: $('modal-spinner'),
	modalTitle: $('modal-title'),
	modalMeta: $('modal-meta'),
	modalTags: $('modal-tags'),
	modalStudio: $('modal-studio'),
	modalCopyLink: $('modal-copy-link'),
	modalCopyEmbed: $('modal-copy-embed'),
	modalPlay: $('modal-play'),
	modalSpeed: $('modal-speed'),
	modalSpeedVal: $('modal-speed-val'),
	modalScrub: $('modal-scrub'),
	modalTime: $('modal-time'),
	modalClose: $('modal-close'),
	modalPrev: $('modal-prev'),
	modalNext: $('modal-next'),
	modalError: $('modal-error'),
	modalTransport: $('modal-transport'),
};

// URL params are user-editable, so every one is validated against the values the
// UI can actually represent. An unknown ?sort= used to blank the sort <select>,
// and an unknown ?cat= filtered the whole grid away with no chip to clear it.
const TYPE_FILTERS = new Set(['', 'loop', 'once']);
const SORTS = new Set(['featured', 'az', 'za', 'shortest', 'longest', 'shuffle']);
const CATEGORY_KEYS = new Set(GALLERY_CATEGORIES.map((c) => c.key));
const oneOf = (allowed, value, fallback) => (allowed.has(value) ? value : fallback);

const params = new URLSearchParams(location.search);
const state = {
	query: params.get('q') || '',
	filter: oneOf(TYPE_FILTERS, params.get('filter') || '', ''), // '' | loop | once
	category: oneOf(CATEGORY_KEYS, params.get('cat') || '', ''), // '' | GALLERY_CATEGORIES key
	sort: oneOf(SORTS, params.get('sort') || 'featured', 'featured'),
	all: [],
	filtered: [],
	shown: 0,
	loaded: false,
	modalIndex: -1, // index into state.filtered while the modal is open
};

const live = getLivePreview();

if (state.query) els.search.value = state.query;
if (els.sort) els.sort.value = state.sort;
syncTypeFilter();

// ── URL state ──────────────────────────────────────────────────────────────

function syncUrl(clipId) {
	const p = new URLSearchParams();
	if (state.query) p.set('q', state.query);
	if (state.category) p.set('cat', state.category);
	if (state.filter) p.set('filter', state.filter);
	if (state.sort !== 'featured') p.set('sort', state.sort);
	if (clipId) p.set('clip', clipId);
	const qs = p.toString();
	const next = qs ? `${location.pathname}?${qs}` : location.pathname;
	if (next !== location.pathname + location.search) history.replaceState(null, '', next);
}

// ── Fetch + normalize ───────────────────────────────────────────────────────

async function fetchLibrary() {
	const res = await fetch(MANIFEST_URL, { cache: 'force-cache' });
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const manifest = await res.json();
	if (!Array.isArray(manifest)) return [];
	return manifest.map(normalizeLibraryClip);
}

async function fetchCommunity() {
	const out = [];
	let cursor = null;
	while (out.length < COMMUNITY_MAX) {
		const p = new URLSearchParams({ include_public: 'true', visibility: 'public', limit: '50' });
		if (cursor) p.set('cursor', cursor);
		const res = await fetch(`${API_BASE}?${p}`, { credentials: 'include' });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = await res.json();
		const incoming = Array.isArray(data.items) ? data.items : [];
		out.push(...incoming);
		cursor = data.next_cursor || null;
		if (!cursor || incoming.length === 0) break;
	}
	return out.slice(0, COMMUNITY_MAX).map(normalizeCommunityClip);
}

/**
 * Page through the full CDN catalog with the endpoint's opt-in ?limit/?offset so
 * each response is bounded and individually CDN-cacheable. `next_offset: null`
 * marks the last page; the page ceiling is a runaway guard.
 *
 * Each page is handed to `onPage` as soon as it lands rather than being held
 * back until the whole catalog is in hand. The grid used to wait for every page
 * before painting a single card, so time-to-first-card was the size of the
 * entire library: 1.1 MB at 2,874 clips, and growing with every seeding batch.
 * Streaming makes first paint cost one page no matter how large the catalog
 * gets, which is the whole reason the endpoint pages at all.
 *
 * @param {(clips: object[]) => void} [onPage]
 */
async function fetchFullLibrary(onPage) {
	const out = [];
	let offset = 0;
	for (let i = 0; i < LIBRARY_MAX_PAGES; i++) {
		const res = await fetch(`${LIBRARY_API}?limit=${LIBRARY_PAGE_SIZE}&offset=${offset}`, {
			cache: 'force-cache',
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = await res.json();
		const clips = Array.isArray(data.clips) ? data.clips : [];
		const normalized = clips.map(normalizeFullLibraryClip);
		out.push(...normalized);
		if (onPage && normalized.length) onPage(normalized);
		if (data.next_offset == null || clips.length === 0) break;
		offset = data.next_offset;
	}
	return out;
}

function normalizeLibraryClip(clip) {
	return {
		id: clip.name,
		source: 'library',
		name: clip.label || clip.name,
		loop: clip.loop !== false,
		icon: clip.icon || '🎬',
		tags: [],
		category: galleryCategoryOf(clip.name, clip.label),
		duration_ms: clip.duration ? Math.round(clip.duration * 1000) : null,
		url: clip.url, // site-relative clip JSON — playable by the live preview
		thumbnail_url: `/animations/thumbs/${encodeURIComponent(clip.name)}.webp`,
		price: null,
	};
}

function normalizeFullLibraryClip(clip) {
	return {
		id: clip.name,
		source: 'mixamo',
		name: clip.label || clip.name,
		loop: clip.loop !== false,
		icon: clip.icon || '🎬',
		tags: clip.category ? [clip.category] : [],
		category: galleryCategoryOf(clip.name, clip.label),
		duration_ms: clip.duration ? Math.round(clip.duration * 1000) : null,
		url: clip.url, // absolute CDN url
		// The library manifest publishes a `thumb` url only for clips that have
		// one baked. Guessing the CDN convention for the rest (853 of 2,874 today)
		// requested an object that is never there: every one 404s, and the browser
		// logs a blocked cross-origin read before the card falls back to its icon.
		// No thumb in the manifest means no request.
		thumbnail_url: clip.thumb || null,
		price: null,
	};
}

function normalizeCommunityClip(clip) {
	return {
		id: clip.id,
		source: 'community',
		name: clip.name || 'Untitled',
		loop: clip.loop !== false,
		icon: '🎬',
		tags: Array.isArray(clip.tags) ? clip.tags : [],
		category: galleryCategoryOf(clip.id, clip.name),
		duration_ms: clip.duration_ms || null,
		url: null, // fetched through /api/animations/clips/:id by the preview engine
		thumbnail_url: clip.thumbnail_url || null,
		price: clip.price || null,
	};
}

async function loadAll() {
	showState('loading');
	// The curated manifest and the community feed are both small and bounded, so
	// they are awaited together. The full CDN catalog is the unbounded one and is
	// streamed in behind them: the first page paints, the rest merge in as they
	// land. A user is looking at cards after one page instead of after the whole
	// library, which is what keeps first paint flat as seeding grows the catalog.
	const [libRes, comRes] = await Promise.allSettled([fetchLibrary(), fetchCommunity()]);
	const library = libRes.status === 'fulfilled' ? libRes.value : [];
	const community = comRes.status === 'fulfilled' ? comRes.value : [];

	// Community clips lead (fresh, human-authored); the curated library follows;
	// the full catalog trails, minus anything the curated set already surfaces.
	const curatedNames = new Set(library.map((c) => c.id));
	state.all = [...community, ...library];

	let painted = false;
	const paint = () => {
		state.loaded = true;
		renderHeroStats();
		renderChips();
		applyFilters();
		painted = true;
	};

	let fullFailed = false;
	try {
		await fetchFullLibrary((clips) => {
			const fresh = clips.filter((c) => !curatedNames.has(c.id));
			if (!fresh.length) return;
			state.all = state.all.concat(fresh);
			// The first page is what ends the loading state; later pages refresh a
			// grid the user is already reading, so they only re-render what the
			// counts and filters depend on.
			paint();
		});
	} catch {
		fullFailed = true;
	}

	const results = [libRes, comRes, { status: fullFailed ? 'rejected' : 'fulfilled' }];
	state.loaded = true;

	// Nothing to show AND at least one source errored is a failure, not an empty
	// library: "be the first to publish" would be a lie, and Retry is the action
	// the user needs. A genuinely empty catalog (every source answered, none had
	// clips) still falls through to the empty state below.
	if (state.all.length === 0 && results.some((r) => r.status === 'rejected')) {
		showState('error');
		return;
	}

	if (!painted) paint();
	else {
		renderHeroStats();
		renderChips();
		applyFilters();
	}

	// ?clip= deep link → open the modal once data exists.
	const wanted = new URLSearchParams(location.search).get('clip');
	if (wanted) {
		const idx = state.filtered.findIndex((c) => c.id === wanted);
		if (idx >= 0) openModal(idx);
		else {
			const item = state.all.find((c) => c.id === wanted);
			if (item) {
				// Visible under different filters, so clear them for the link.
				state.query = '';
				state.category = '';
				state.filter = '';
				els.search.value = '';
				syncTypeFilter();
				renderChips();
				applyFilters();
				openModal(state.filtered.findIndex((c) => c.id === wanted));
			}
		}
	}
}

// ── Hero stats + chips ───────────────────────────────────────────────────────

function renderHeroStats() {
	if (!els.heroStats) return;
	const total = state.all.length;
	const community = state.all.filter((c) => c.source === 'community').length;
	const cats = new Set(state.all.map((c) => c.category)).size;
	els.heroStats.textContent = `${total.toLocaleString()} clips · ${cats} categories${
		community ? ` · ${community} community-authored` : ''
	}`;
}

function renderChips() {
	if (!els.chips) return;
	const counts = new Map();
	for (const item of state.all) counts.set(item.category, (counts.get(item.category) || 0) + 1);
	els.chips.innerHTML = '';
	const mk = (key, label, icon, count) => {
		const btn = document.createElement('button');
		btn.className = 'ag-chip';
		btn.setAttribute('role', 'tab');
		btn.dataset.cat = key;
		btn.setAttribute('aria-selected', String(state.category === key));
		btn.innerHTML = `${icon ? `<span aria-hidden="true">${icon}</span> ` : ''}${escHtml(label)}${
			count != null ? ` <span class="ag-chip-count">${count.toLocaleString()}</span>` : ''
		}`;
		els.chips.appendChild(btn);
	};
	mk('', 'All', '', state.all.length);
	for (const cat of GALLERY_CATEGORIES) {
		const n = counts.get(cat.key);
		if (n) mk(cat.key, cat.label, cat.icon, n);
	}
}

function syncChips() {
	els.chips?.querySelectorAll('[data-cat]').forEach((btn) => {
		btn.setAttribute('aria-selected', String(btn.dataset.cat === state.category));
	});
}

// Keep the loop/once segmented control showing what is actually filtering. The
// chips render from state on every pass; these three buttons are static markup,
// so a ?filter= deep link (or the clear-filters button) has to press them.
function syncTypeFilter() {
	els.typeFilter?.querySelectorAll('[data-filter]').forEach((btn) => {
		btn.setAttribute('aria-pressed', String((btn.dataset.filter || '') === state.filter));
	});
}

// ── Filter + sort + render ───────────────────────────────────────────────────

function applyFilters() {
	const q = state.query.toLowerCase();
	state.filtered = state.all.filter((item) => {
		if (state.filter === 'loop' && !item.loop) return false;
		if (state.filter === 'once' && item.loop) return false;
		if (state.category && item.category !== state.category) return false;
		if (q) {
			const hay = `${item.name} ${item.tags.join(' ')} ${item.category}`.toLowerCase();
			if (!hay.includes(q)) return false;
		}
		return true;
	});
	sortFiltered();
	state.shown = 0;
	renderCount();
	renderGrid();
}

function sortFiltered() {
	const arr = state.filtered;
	switch (state.sort) {
		case 'az':
			arr.sort((a, b) => a.name.localeCompare(b.name));
			break;
		case 'za':
			arr.sort((a, b) => b.name.localeCompare(a.name));
			break;
		case 'shortest':
			arr.sort((a, b) => (a.duration_ms ?? 1e9) - (b.duration_ms ?? 1e9));
			break;
		case 'longest':
			arr.sort((a, b) => (b.duration_ms ?? -1) - (a.duration_ms ?? -1));
			break;
		case 'shuffle': {
			// Reshuffled on every filter pass, so changing a chip or the search
			// while shuffled deals a fresh hand rather than the same order.
			for (let i = arr.length - 1; i > 0; i--) {
				const j = Math.floor(Math.random() * (i + 1));
				[arr[i], arr[j]] = [arr[j], arr[i]];
			}
			break;
		}
		default:
			// 'featured' — the assembled source order (community → curated → catalog).
			break;
	}
}

function renderCount() {
	if (!els.count) return;
	if (!state.loaded) {
		els.count.textContent = '';
		return;
	}
	const n = state.filtered.length;
	els.count.textContent = n === state.all.length
		? `${n.toLocaleString()} animations`
		: `${n.toLocaleString()} of ${state.all.length.toLocaleString()}`;
}

function renderGrid() {
	if (state.filtered.length === 0) {
		if (state.all.length === 0) {
			showState('empty');
		} else {
			showState('empty-search');
			if (els.emptySearchMsg) {
				els.emptySearchMsg.textContent = state.query
					? `No animations match “${state.query}”.`
					: 'No animations match these filters.';
			}
		}
		return;
	}

	showState('grid');

	const start = state.shown;
	const end = Math.min(start + PAGE_SIZE, state.filtered.length);
	if (start === 0) {
		live.stop();
		els.grid.innerHTML = '';
	}

	const fragment = document.createDocumentFragment();
	for (let i = start; i < end; i++) {
		fragment.appendChild(buildCard(state.filtered[i], i));
	}
	els.grid.appendChild(fragment);
	state.shown = end;

	els.loadMore.hidden = state.shown >= state.filtered.length;
}

function showMore() {
	if (state.shown < state.filtered.length) renderGrid();
}

function fmtDuration(ms) {
	if (ms == null) return '';
	const s = ms / 1000;
	if (s < 60) return `${s.toFixed(1)}s`;
	const m = Math.floor(s / 60);
	return `${m}m ${Math.round(s % 60)}s`;
}

const CATEGORY_BY_KEY = new Map(GALLERY_CATEGORIES.map((c) => [c.key, c]));

function sourceLabel(source) {
	return source === 'community' ? 'Community' : source === 'mixamo' ? 'Mocap' : 'Studio';
}

// ── Card ────────────────────────────────────────────────────────────────────

function buildCard(clip, index) {
	const card = document.createElement('article');
	card.className = 'ag-card';
	card.dataset.index = String(index);

	const cat = CATEGORY_BY_KEY.get(clip.category);
	const studioUrl = `/pose?anim=${encodeURIComponent(clip.id)}`;

	card.innerHTML = `
		<div class="ag-card-preview" role="button" tabindex="0"
			aria-label="${escHtml(clip.name)}: open details">
			${clip.thumbnail_url
				? `<img class="ag-card-thumb" src="${escHtml(clip.thumbnail_url)}" alt="" loading="lazy" decoding="async" />`
				: ''}
			<div class="ag-card-thumb-fallback" aria-hidden="true" ${clip.thumbnail_url ? 'hidden' : ''}>${escHtml(clip.icon || '🎬')}</div>
			<div class="ag-card-live" aria-hidden="true"></div>
			<span class="ag-card-duration">${fmtDuration(clip.duration_ms)}</span>
			${clip.loop ? '' : '<span class="ag-card-once" title="Plays once">once</span>'}
			${clip.price ? `<span class="ag-card-price">$${(Number(clip.price.amount) / 1_000_000).toFixed(2)}</span>` : ''}
		</div>
		<div class="ag-card-meta">
			<h3 class="ag-card-title" title="${escHtml(clip.name)}">${escHtml(clip.name)}</h3>
			<div class="ag-card-sub">
				<button class="ag-card-cat" data-cat-jump="${escHtml(clip.category)}"
					title="Show all ${escHtml(cat?.label || 'More')} animations">${cat?.icon || ''} ${escHtml(cat?.label || 'More')}</button>
				<span class="ag-card-source">${sourceLabel(clip.source)}</span>
			</div>
			<div class="ag-card-actions">
				<a href="${escHtml(studioUrl)}" class="ag-card-btn ag-card-btn--primary"
					title="Open this animation in the Studio to remix or apply to your avatar">Open in Studio</a>
				<button class="ag-card-btn" data-details
					aria-label="Details and preview for ${escHtml(clip.name)}">Details</button>
			</div>
		</div>
	`;

	const previewZone = card.querySelector('.ag-card-preview');
	const liveHost = card.querySelector('.ag-card-live');
	const img = card.querySelector('.ag-card-thumb');
	const fallback = card.querySelector('.ag-card-thumb-fallback');
	if (img && fallback) {
		img.addEventListener('error', () => {
			img.remove();
			fallback.hidden = false;
		});
	}

	// Hover → live preview through the shared engine (skipped for touch and
	// reduced-motion users; both get the full preview in the details modal).
	if (!TOUCH_ONLY && !REDUCED_MOTION) {
		let hoverTimer = 0;
		previewZone.addEventListener('mouseenter', () => {
			hoverTimer = setTimeout(() => {
				card.classList.add('is-loading-preview');
				live
					.play(liveHost, clip)
					.then(() => {
						if (live.active === clip) card.classList.add('is-live');
					})
					.catch(() => {})
					.finally(() => card.classList.remove('is-loading-preview'));
			}, HOVER_DELAY_MS);
		});
		previewZone.addEventListener('mouseleave', () => {
			clearTimeout(hoverTimer);
			card.classList.remove('is-live', 'is-loading-preview');
			if (live.active === clip) live.stop();
		});
	}

	const open = () => openModal(index);
	previewZone.addEventListener('click', open);
	previewZone.addEventListener('keydown', (e) => {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			open();
		}
	});
	card.querySelector('[data-details]').addEventListener('click', open);
	card.querySelector('[data-cat-jump]').addEventListener('click', (e) => {
		state.category = e.currentTarget.dataset.catJump || '';
		syncChips();
		syncUrl();
		applyFilters();
		window.scrollTo({ top: 0, behavior: 'smooth' });
	});

	return card;
}

function escHtml(s) {
	return String(s ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

// ── Detail modal ─────────────────────────────────────────────────────────────

// The element that opened the modal, so closing returns focus where the user
// left it instead of dropping it on <body> and restarting the tab order.
let modalOpener = null;

function openModal(index) {
	const clip = state.filtered[index];
	if (!clip || !els.modal) return;
	// Stepping prev/next re-opens the modal; only a cold open owns the opener,
	// and only a cold open moves focus (stepping with the keyboard has to leave
	// focus on Next so the next press steps again).
	const coldOpen = els.modal.hidden;
	if (coldOpen && document.activeElement instanceof HTMLElement) {
		modalOpener = document.activeElement;
	}
	state.modalIndex = index;

	els.modalTitle.textContent = clip.name;
	const cat = CATEGORY_BY_KEY.get(clip.category);
	els.modalMeta.innerHTML = [
		cat ? `${cat.icon} ${escHtml(cat.label)}` : null,
		clip.duration_ms ? escHtml(fmtDuration(clip.duration_ms)) : null,
		clip.loop ? 'loops' : 'plays once',
		escHtml(sourceLabel(clip.source)),
	]
		.filter(Boolean)
		.map((x) => `<span>${x}</span>`)
		.join('<span class="ag-dot" aria-hidden="true">·</span>');
	els.modalTags.innerHTML = clip.tags?.length
		? clip.tags.slice(0, 8).map((t) => `<span class="ag-tag">${escHtml(t)}</span>`).join('')
		: '';
	els.modalStudio.href = `/pose?anim=${encodeURIComponent(clip.id)}`;
	els.modalError.hidden = true;
	els.modalSpinner.hidden = false;
	// Nothing is playing yet, so the transport would be a row of controls that
	// do nothing. It comes back the moment the clip is on the stage, and stays
	// away entirely if the preview fails.
	els.modalTransport.hidden = true;
	els.modalPrev.disabled = index <= 0;
	els.modalNext.disabled = index >= state.filtered.length - 1;

	// Transport defaults.
	els.modalSpeed.value = '1';
	els.modalSpeedVal.textContent = '1×';
	els.modalScrub.value = '0';
	setPlayIcon(false);

	els.modal.hidden = false;
	document.body.style.overflow = 'hidden';
	// Focus the dialog itself, not its close button: a screen reader then reads
	// the clip title first, and Space stays free for the play/pause shortcut the
	// on-screen hint advertises.
	if (coldOpen) els.modal.focus();
	syncUrl(clip.id);

	let scrubbing = false;
	els.modalScrub.oninput = () => {
		scrubbing = true;
		live.seek(Number(els.modalScrub.value) / 1000);
	};
	els.modalScrub.onchange = () => {
		scrubbing = false;
	};

	live
		.play(els.modalStage, clip, {
			onFrame: (t, d) => {
				if (!scrubbing && d > 0) {
					els.modalScrub.value = String(Math.round(((t % d) / d) * 1000));
					els.modalTime.textContent = `${(t % d).toFixed(1)}s / ${d.toFixed(1)}s`;
				}
			},
		})
		.then(() => {
			els.modalSpinner.hidden = true;
			els.modalTransport.hidden = false;
			live.refit();
		})
		.catch(() => {
			els.modalSpinner.hidden = true;
			els.modalError.hidden = false;
		});
}

function closeModal() {
	if (els.modal.hidden) return;
	els.modal.hidden = true;
	document.body.style.overflow = '';
	live.stop();
	state.modalIndex = -1;
	syncUrl();
	// The opener can be gone (a filter change rebuilt the grid under the modal);
	// fall back to the search field so focus never lands on <body>.
	const back = modalOpener?.isConnected ? modalOpener : els.search;
	modalOpener = null;
	back?.focus();
}

const FOCUSABLE =
	'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

// aria-modal="true" promises the rest of the page is inert, so Tab has to wrap
// inside the dialog instead of walking off into the grid behind it.
function trapModalFocus(e) {
	const nodes = [...els.modal.querySelectorAll(FOCUSABLE)].filter(
		(n) => n.offsetWidth > 0 || n.offsetHeight > 0,
	);
	if (!nodes.length) return;
	const first = nodes[0];
	const last = nodes[nodes.length - 1];
	const active = document.activeElement;
	const outside = !els.modal.contains(active);
	if (e.shiftKey && (outside || active === first)) {
		e.preventDefault();
		last.focus();
	} else if (!e.shiftKey && (outside || active === last)) {
		e.preventDefault();
		first.focus();
	}
}

function stepModal(delta) {
	const next = state.modalIndex + delta;
	if (next < 0 || next >= state.filtered.length) return;
	// Ensure the card list has rendered far enough that "next" stays in sync
	// with what the user returns to after closing.
	while (state.shown <= next && state.shown < state.filtered.length) showMore();
	openModal(next);
}

function setPlayIcon(paused) {
	els.modalPlay.innerHTML = paused
		? '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"/></svg>'
		: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="4" width="5" height="16"/><rect x="14" y="4" width="5" height="16"/></svg>';
	els.modalPlay.setAttribute('aria-label', paused ? 'Play' : 'Pause');
}

els.modalPlay?.addEventListener('click', () => {
	const paused = !live.isPaused();
	live.setPaused(paused);
	setPlayIcon(paused);
});
els.modalSpeed?.addEventListener('input', () => {
	const f = Number(els.modalSpeed.value);
	live.setSpeed(f);
	els.modalSpeedVal.textContent = `${f}×`;
});
els.modalClose?.addEventListener('click', closeModal);
els.modalPrev?.addEventListener('click', () => stepModal(-1));
els.modalNext?.addEventListener('click', () => stepModal(1));
els.modal?.addEventListener('click', (e) => {
	if (e.target === els.modal) closeModal();
});
els.modalCopyLink?.addEventListener('click', async () => {
	const clip = state.filtered[state.modalIndex];
	if (!clip) return;
	const url = `${location.origin}/animations?clip=${encodeURIComponent(clip.id)}`;
	await navigator.clipboard.writeText(url).catch(() => {});
	flashButton(els.modalCopyLink, 'Copied!');
});
els.modalCopyEmbed?.addEventListener('click', async () => {
	const clip = state.filtered[state.modalIndex];
	if (!clip) return;
	const src = `${location.origin}/embed/avatar?anim=${encodeURIComponent(clip.id)}`;
	const snippet = `<iframe src="${src}" width="360" height="480" style="border:0;border-radius:12px" allow="autoplay" title="${clip.name} on three.ws"></iframe>`;
	await navigator.clipboard.writeText(snippet).catch(() => {});
	flashButton(els.modalCopyEmbed, 'Copied!');
});

function flashButton(btn, msg) {
	const prev = btn.textContent;
	btn.textContent = msg;
	btn.disabled = true;
	setTimeout(() => {
		btn.textContent = prev;
		btn.disabled = false;
	}, 1200);
}

// ── State display ──────────────────────────────────────────────────────────

function showState(which) {
	els.loading.hidden = which !== 'loading';
	els.grid.hidden = which !== 'grid';
	els.empty.hidden = which !== 'empty';
	els.emptySearch.hidden = which !== 'empty-search';
	els.error.hidden = which !== 'error';
	if (which !== 'grid') els.loadMore.hidden = true;
}

// ── Controls ───────────────────────────────────────────────────────────────

let searchDebounce;
els.search?.addEventListener('input', () => {
	clearTimeout(searchDebounce);
	searchDebounce = setTimeout(() => {
		state.query = els.search.value.trim();
		syncUrl();
		if (state.loaded) applyFilters();
	}, 180);
});

els.chips?.addEventListener('click', (e) => {
	const btn = e.target.closest('[data-cat]');
	if (!btn) return;
	state.category = btn.dataset.cat;
	syncChips();
	syncUrl();
	if (state.loaded) applyFilters();
});

els.typeFilter?.addEventListener('click', (e) => {
	const btn = e.target.closest('[data-filter]');
	if (!btn) return;
	state.filter = btn.dataset.filter || '';
	syncTypeFilter();
	syncUrl();
	if (state.loaded) applyFilters();
});

els.sort?.addEventListener('change', () => {
	state.sort = els.sort.value;
	syncUrl();
	if (state.loaded) applyFilters();
});

els.clearSearch?.addEventListener('click', () => {
	state.query = '';
	state.filter = '';
	state.category = '';
	els.search.value = '';
	syncTypeFilter();
	syncChips();
	syncUrl();
	if (state.loaded) applyFilters();
});

els.retry?.addEventListener('click', () => loadAll());
els.loadMoreBtn?.addEventListener('click', showMore);

// Infinite scroll sentinel.
if ('IntersectionObserver' in window && els.sentinel) {
	const observer = new IntersectionObserver(
		(entries) => {
			if (entries[0].isIntersecting) showMore();
		},
		{ rootMargin: '600px' },
	);
	observer.observe(els.sentinel);
}

// ── Keyboard ────────────────────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
	if (!els.modal.hidden) {
		// The scrub and speed sliders own their own arrow and space keys; stealing
		// them would scrub and step the clip list at the same time.
		const tag = document.activeElement?.tagName || '';
		const onSlider = /^(INPUT|SELECT|TEXTAREA)$/.test(tag);
		if (e.key === 'Escape') closeModal();
		else if (e.key === 'Tab') trapModalFocus(e);
		else if (onSlider) return;
		else if (e.key === 'ArrowLeft') stepModal(-1);
		else if (e.key === 'ArrowRight') stepModal(1);
		else if (e.key === ' ' && tag !== 'BUTTON' && tag !== 'A' && !els.modalTransport.hidden) {
			e.preventDefault();
			els.modalPlay.click();
		}
		return;
	}
	const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
	if (e.key === '/' && !typing) {
		e.preventDefault();
		els.search.focus();
	} else if (e.key === 'Escape' && typing && document.activeElement === els.search) {
		els.search.blur();
	}
});

// ── Boot ───────────────────────────────────────────────────────────────────

loadAll();
