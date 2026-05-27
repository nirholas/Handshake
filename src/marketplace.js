
/**
 * Agent Marketplace — discovery + detail page controller.
 *
 * Two views in one SPA: list (with category sidebar + search) and detail
 * (5 tabs). Routing is path-based: /marketplace and /marketplace/agents/:id.
 */


import {
	renderDetailAvatar,
	startPreviewSession,
	submitPreviewMessage,
	openCreatorModal,
	closeCreatorModal,
	bindMobileSidebar,
	bindDetailExtras,
} from './marketplace-detail.js';

const API = '/api';

let purchasedSkills = new Set();
let bookmarkedAgents = new Set();

function isLikelyAuthed() {
	try {
		const raw = localStorage.getItem('3dagent:auth-hint');
		if (!raw) return false;
		return JSON.parse(raw)?.authed === true;
	} catch (_) {
		return false;
	}
}

async function fetchUserPurchases() {
	if (!isLikelyAuthed()) return;
	try {
		const r = await fetch(`${API}/users/me/purchased-skills`, { credentials: 'include' });
		if (!r.ok) return;
		const j = await r.json();
		const list = j.data?.purchases || [];
		purchasedSkills = new Set(list.map((p) => `${p.agent_id}:${p.skill}`));
	} catch (err) {
		console.error('[marketplace] purchases', err);
	}
}

async function fetchUserBookmarks() {
	if (!isLikelyAuthed()) return;
	try {
		const r = await fetch(`${API}/users/me/bookmarks`, { credentials: 'include' });
		if (!r.ok) return;
		const j = await r.json();
		bookmarkedAgents = new Set(j.data?.agent_ids || []);
	} catch (err) {
		console.error('[marketplace] bookmarks', err);
	}
}

async function toggleAgentBookmarkFromCard(agentId, btn) {
	if (!isLikelyAuthed()) {
		location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
		return;
	}
	const wasOn = bookmarkedAgents.has(agentId);
	btn.classList.toggle('on', !wasOn);
	btn.setAttribute('aria-pressed', String(!wasOn));
	btn.textContent = !wasOn ? '★' : '☆';
	try {
		const r = await fetch(`${API}/marketplace/agents/${agentId}/bookmark`, {
			method: wasOn ? 'DELETE' : 'POST',
			credentials: 'include',
		});
		if (!r.ok) throw new Error(`bookmark failed ${r.status}`);
		const j = await r.json().catch(() => ({}));
		const nowOn = !!j?.data?.bookmarked;
		if (nowOn) bookmarkedAgents.add(agentId);
		else bookmarkedAgents.delete(agentId);
		btn.classList.toggle('on', nowOn);
		btn.setAttribute('aria-pressed', String(nowOn));
		btn.textContent = nowOn ? '★' : '☆';
	} catch (err) {
		btn.classList.toggle('on', wasOn);
		btn.setAttribute('aria-pressed', String(wasOn));
		btn.textContent = wasOn ? '★' : '☆';
		console.error('[marketplace] toggle bookmark', err);
	}
}


const CATEGORY_LABELS = {
	academic: 'Academic',
	career: 'Career',
	copywriting: 'Copywriting',
	design: 'Design',
	education: 'Education',
	emotions: 'Emotions',
	entertainment: 'Entertainment',
	games: 'Games',
	general: 'General',
	life: 'Life',
	marketing: 'Marketing',
	office: 'Office',
	programming: 'Programming',
	translation: 'Translation',
	blockchain: 'Blockchain',
};

const state = {
	category: null, // null = Discover (all)
	q: '',
	tag: null,      // ?tag=humanoid → filter all cards to entries containing this tag
	sort: 'recommended',
	filter: 'all', // all | agents | avatars | onchain
	priceFilter: 'all', // all | free | paid
	cursor: null,
	items: [],
	loading: false,
	publicAvatars: [],
	publicAvatarsLoaded: false,
	onchainItems: [],
	onchainCursor: null,
	onchainLoaded: false,
	featured: [],
	heroIndex: 0,
	heroTimer: null,
	stats: null,
	theme: null,
};


const $ = (id) => document.getElementById(id);
const els = {
	discovery: $('market-discovery'),
	detail: $('market-detail'),
	tools: $('market-tools'),
	cats: $('market-cats'),
	catChips: $('market-cat-chips'),
	grid: $('market-grid'),
	search: $('market-search'),
	sortSel: $('market-sort'),
	loadMore: $('market-loadmore'),
	back: $('market-back'),
};

// ── Routing ───────────────────────────────────────────────────────────────

// Filter values that round-trip through ?tab= on the list view. Kept here so
// readRoute and syncFilterToUrl agree on which strings are valid.
const LIST_FILTER_TABS = new Set(['agents', 'avatars', 'onchain']);
const SORT_VALUES = new Set(['recommended', 'recent', 'popular']);

function readRoute() {
	const m = location.pathname.match(/^\/marketplace\/agents\/([^/]+)/);
	if (m) return { view: 'detail', id: m[1] };
	const av = location.pathname.match(/^\/marketplace\/avatars\/([^/]+)/);
	if (av) return { view: 'avatar-detail', id: av[1] };
	const params = new URLSearchParams(location.search);
	const tab = params.get('tab');
	const tag = (params.get('tag') || '').trim().toLowerCase().slice(0, 40) || null;
	const q = (params.get('q') || '').trim().slice(0, 200);
	const sort = SORT_VALUES.has(params.get('sort')) ? params.get('sort') : null;
	if (tab === 'tools') return { view: 'tools', tag };
	if (tab === 'skills') return { view: 'skills', tag };
	if (tab === 'mine') return { view: 'mine', tag };
	if (tab === 'purchases') return { view: 'purchases', tag };
	if (tab === 'earn') return { view: 'earn', tag };
	const filter = LIST_FILTER_TABS.has(tab) ? tab : 'all';
	return { view: 'list', filter, tag, q, sort };
}

// Push the current list-view filter/search/sort into the URL so back/forward
// and page refresh both restore the same view. Uses replaceState by default
// to avoid flooding history with every keystroke; pass push=true when the
// change is user-meaningful (filter chip click, sort change).
function syncFilterToUrl({ push = false } = {}) {
	if (!location.pathname.startsWith('/marketplace')) return;
	// Only sync from the discovery list view — detail / tools / mine views
	// own their own URLs and we shouldn't trample them.
	const path = location.pathname;
	if (path !== '/marketplace') return;
	const url = new URL(location.href);
	const set = (key, val) => {
		if (val) url.searchParams.set(key, val);
		else url.searchParams.delete(key);
	};
	set('tab', LIST_FILTER_TABS.has(state.filter) ? state.filter : null);
	set('q', state.q || null);
	set('sort', state.sort && state.sort !== 'recommended' ? state.sort : null);
	if (url.href === location.href) return;
	if (push) history.pushState({}, '', url);
	else history.replaceState({}, '', url);
}

function navTo(path, replace = false) {
	const url = new URL(path, location.origin);
	if (replace) history.replaceState({}, '', url);
	else history.pushState({}, '', url);
	render();
}

window.addEventListener('popstate', render);

// ── List view ─────────────────────────────────────────────────────────────

// ── Poster cache (IndexedDB) ──────────────────────────────────────────────
// Caches captured model-viewer poster images client-side so subsequent page
// loads show instant thumbnails instead of the shimmer.

const _POSTER_DB = 'mv-poster-cache-v1';
const _POSTER_STORE = 'posters';
let _dbPromise = null;

function _openDb() {
	if (_dbPromise) return _dbPromise;
	_dbPromise = new Promise((resolve, reject) => {
		const req = indexedDB.open(_POSTER_DB, 1);
		req.onupgradeneeded = (e) => e.target.result.createObjectStore(_POSTER_STORE);
		req.onsuccess = (e) => resolve(e.target.result);
		req.onerror = () => { _dbPromise = null; reject(req.error); };
	});
	return _dbPromise;
}

async function _posterGet(key) {
	try {
		const db = await _openDb();
		return await new Promise((resolve) => {
			const tx = db.transaction(_POSTER_STORE, 'readonly');
			const req = tx.objectStore(_POSTER_STORE).get(key);
			req.onsuccess = () => resolve(req.result || null);
			req.onerror = () => resolve(null);
		});
	} catch { return null; }
}

async function _posterSet(key, blob) {
	try {
		const db = await _openDb();
		await new Promise((resolve) => {
			const tx = db.transaction(_POSTER_STORE, 'readwrite');
			tx.objectStore(_POSTER_STORE).put(blob, key);
			tx.oncomplete = resolve;
			tx.onerror = resolve;
		});
	} catch {}
}

/**
 * Apply lightweight preview behavior to every <model-viewer> inside `root`:
 *  1. Apply cached poster blob (instant thumbnails on repeat visits).
 *  2. Capture + cache poster on first load for next time.
 *  3. Mark the enclosing card/slide .mv-loaded once the GLB renders, so the
 *     placeholder gradient behind it fades out.
 *
 * Use `data-src` OR `src` as the cache key — avatar cards lazy-load via
 * data-src and only get src promoted on intersect, but the poster should be
 * visible immediately on render, before the GLB ever starts downloading.
 */
async function attachModelViewerBehavior(root = els.grid) {
	if (!root) return;
	const viewers = root.querySelectorAll('model-viewer');
	for (const mv of viewers) {
		if (mv.dataset.posterWired === '1') continue;
		mv.dataset.posterWired = '1';

		const key = mv.dataset.src || mv.getAttribute('src');
		if (!key) continue;

		// The placeholder is the closest ancestor we want to fade once loaded.
		// Cards use .market-card-avatar; hero uses .market-hero-slide; fall back
		// to the model-viewer itself so the .mv-loaded class always lands somewhere.
		const host =
			mv.closest('.market-card-avatar, .market-card-agent, .market-hero-slide') || mv;

		const cached = await _posterGet(key);
		if (cached) {
			mv.setAttribute('poster', URL.createObjectURL(cached));
			host.classList.add('mv-poster-ready');
		}

		const onLoad = async () => {
			host.classList.add('mv-loaded');
			if (!cached) {
				try {
					const blob = await mv.generatePosterBlob({ idealAspect: true });
					if (blob) await _posterSet(key, blob);
				} catch {}
			}
		};
		mv.addEventListener('load', onLoad, { once: true });
		// model-viewer fires 'poster-dismissed' when it transitions from poster → 3D.
		mv.addEventListener('poster-dismissed', () => host.classList.add('mv-loaded'), { once: true });
	}
}

// ── Infinite scroll ───────────────────────────────────────────────────────

let _infiniteObserver = null;

function _setupInfiniteScroll() {
	if (_infiniteObserver) { _infiniteObserver.disconnect(); _infiniteObserver = null; }
	const sentinel = els.grid.querySelector('.market-scroll-sentinel');
	if (!sentinel) return;
	_infiniteObserver = new IntersectionObserver((entries) => {
		if (entries[0]?.isIntersecting && !state.loading && state.cursor) {
			loadList(false);
		}
	}, { rootMargin: '200px' });
	_infiniteObserver.observe(sentinel);
}

// ── Category chips row ────────────────────────────────────────────────────

async function loadCategories() {
	if (!els.cats && !els.catChips) return;
	try {
		const r = await fetch(`${API}/marketplace/categories`);
		const j = await r.json();
		renderCategories(j.data);
	} catch (err) {
		console.error('[marketplace] categories', err);
	}
}

function renderCategoryChips(data) {
	if (!els.catChips) return;
	const total = data?.total || 0;
	const counts = Object.fromEntries((data?.categories || []).map((cat) => [cat.slug, cat.count]));
	const chips = [
		{ slug: null, label: 'All', count: total },
		...Object.keys(CATEGORY_LABELS)
			.map((slug) => ({ slug, label: CATEGORY_LABELS[slug], count: counts[slug] || 0 }))
			.filter((c) => c.count > 0),
	];
	els.catChips.innerHTML = chips.map((c) => {
		const active = (c.slug === null && !state.category) || state.category === c.slug;
		return `<button class="market-cat-chip${active ? ' active' : ''}" data-cat="${c.slug ?? ''}" type="button">
			${escapeHtml(c.label)}
			<span class="cat-chip-count">${c.count}</span>
		</button>`;
	}).join('');
	els.catChips.querySelectorAll('.market-cat-chip').forEach((btn) => {
		btn.addEventListener('click', () => {
			const slug = btn.dataset.cat || null;
			state.category = slug;
			state.cursor = null;
			loadList(true);
			highlightCategoryChips();
		});
	});
}

function highlightCategoryChips() {
	if (!els.catChips) return;
	els.catChips.querySelectorAll('.market-cat-chip').forEach((btn) => {
		const slug = btn.dataset.cat || null;
		btn.classList.toggle('active', slug === state.category || (slug === null && !state.category));
	});
}

function renderCategories(data) {
	renderCategoryChips(data);
	if (!els.cats) return;
	const total = data?.total || 0;
	const counts = Object.fromEntries((data?.categories || []).map((cat) => [cat.slug, cat.count]));
	// Hide categories with 0 published agents — they're noise. Keep "Discover" and
	// "All" pinned, and keep the currently-selected category visible even at 0.
	const populated = Object.keys(CATEGORY_LABELS)
		.map((slug) => ({ slug, label: CATEGORY_LABELS[slug], count: counts[slug] || 0 }))
		.filter((row) => row.count > 0 || state.category === row.slug);
	const rows = [
		{ slug: null, label: 'Discover', count: null, head: true },
		{ slug: 'all', label: 'All', count: total },
		...populated,
	];
	els.cats.innerHTML = rows
		.map((r) => {
			const active =
				(state.category === null && r.slug === null) ||
				(state.category === null && r.slug === 'all' && state.activeAll) ||
				state.category === r.slug;
			return `<div class="cat-row${active ? ' active' : ''}" data-cat="${r.slug ?? ''}">
				<span>${r.label}</span>
				${r.count != null ? `<span class="count">${r.count}</span>` : ''}
			</div>`;
		})
		.join('');
	els.cats.querySelectorAll('.cat-row').forEach((el) => {
		el.addEventListener('click', () => {
			const slug = el.dataset.cat || null;
			state.category = slug === 'all' ? null : slug;
			state.activeAll = slug === 'all';
			state.cursor = null;
			loadList(true);
			highlightActiveCat();
		});
	});
}

function highlightActiveCat() {
	if (!els.cats) return;
	els.cats.querySelectorAll('.cat-row').forEach((el) => {
		const slug = el.dataset.cat || null;
		const active =
			(state.category === null && !state.activeAll && slug === null) ||
			(state.activeAll && slug === 'all') ||
			state.category === slug;
		el.classList.toggle('active', !!active);
	});
}

async function loadList(reset = false) {
	if (state.loading) return;
	state.loading = true;
	if (reset) {
		state.items = [];
		state.cursor = null;
		els.grid.innerHTML = '<div class="market-empty">Loading…</div>';
	}
	try {
		const url = new URL(`${API}/marketplace/agents`, location.origin);
		if (state.category) url.searchParams.set('category', state.category);
		if (state.q) url.searchParams.set('q', state.q);
		if (state.sort) url.searchParams.set('sort', state.sort);
		if (state.cursor) url.searchParams.set('cursor', state.cursor);
		const r = await fetch(url);
		const j = await r.json();
		// Real endpoint wraps as { data: { items, next_cursor } }; legacy mock returns a bare array.
		const rawItems = Array.isArray(j) ? j : (j?.data?.items ?? []);
		const nextCursor = Array.isArray(j) ? null : (j?.data?.next_cursor ?? null);
		const items = rawItems.filter((a) => !isAutoNamedAgent(a.name));
		state.items = reset ? items : [...state.items, ...items];
		state.cursor = nextCursor;
		renderGrid();
	} catch (err) {
		console.error('[marketplace] list', err);
		els.grid.innerHTML = renderErrorState('agents');
	} finally {
		state.loading = false;
	}

	if (reset) {
		loadPublicAvatars();
		loadFeatured();
		loadOnchainAgents(true);
	}
}

// Mirrors server-side NAME_AUTONAMED_RE in api/explore.js. Client-side filter
// is defense-in-depth: until the server filter ships, the marketplace still
// looks curated by hiding obvious junk locally.
const AVATAR_AUTONAMED_RE =
	/^(Avatar #[0-9a-f]{6}|Avatar \d+\/\d+\/\d{4}.*|mo[a-z0-9]{4,}|draft-[a-z0-9]+|[a-f0-9-]{30,}|new_project_\d+|TEST|test|Untitled.*)$/i;

function isAutoNamedAvatar(name) {
	const n = String(name || '').trim();
	if (!n) return true;
	return AVATAR_AUTONAMED_RE.test(n);
}

// Mirrors server-side AGENT_AUTONAMED_RE_SQL in api/marketplace/[action].js.
// Defense-in-depth: even if a stale CDN cache or partial rollout serves
// unfiltered rows, the marketplace UI still hides obvious stubs.
const AGENT_AUTONAMED_RE =
	/^(Agent|My Agent|My First Agent|Demo Agent|Untitled.*|TEST|Test|test|mo[a-z0-9]{4,}|draft-[a-z0-9]+|new_project_\d+|Avatar\s*#[0-9a-f]{4,}(\s*agent)?|https?:\/\/.+)$/i;

function isAutoNamedAgent(name) {
	const n = String(name || '').trim();
	if (!n) return true;
	return AGENT_AUTONAMED_RE.test(n);
}

async function loadPublicAvatars() {
	try {
		const url = new URL(`${API}/explore`, location.origin);
		url.searchParams.set('source', 'avatar');
		url.searchParams.set('limit', '200');
		url.searchParams.set('quality', 'high');
		if (state.q) url.searchParams.set('q', state.q);
		const r = await fetch(url);
		if (!r.ok) return;
		const j = await r.json();
		const avatars = (j?.items || []).filter(
			(it) => it.kind === 'avatar' && it.glbUrl && !isAutoNamedAvatar(it.name),
		);
		state.publicAvatars = avatars;
		state.publicAvatarsLoaded = true;
		state.stats = j?.totals || state.stats;
		renderGrid();
		updateOnchainChipCount();
	} catch (err) {
		console.error('[marketplace] public avatars', err);
	}
}

// ── Onchain ERC-8004 agents (102k+ in DB) ────────────────────────────────

async function loadOnchainAgents(reset = false) {
	if (reset) {
		state.onchainItems = [];
		state.onchainCursor = null;
		state.onchainLoaded = false;
	}
	try {
		const url = new URL(`${API}/explore`, location.origin);
		url.searchParams.set('source', 'onchain');
		url.searchParams.set('only3d', '1');
		url.searchParams.set('limit', '60');
		if (state.q) url.searchParams.set('q', state.q);
		if (state.onchainCursor) url.searchParams.set('cursor', state.onchainCursor);
		const r = await fetch(url);
		if (!r.ok) return;
		const j = await r.json();
		const items = (j?.items || []).filter((it) => it.kind === 'onchain' && it.glbUrl);
		state.onchainItems = reset ? items : [...state.onchainItems, ...items];
		state.onchainCursor = j?.nextCursor || null;
		state.onchainLoaded = true;
		if (state.filter === 'onchain' || state.filter === 'all') renderGrid();
		updateOnchainChipCount();
	} catch (err) {
		console.error('[marketplace] onchain', err);
	}
}

function updateOnchainChipCount() {
	const el = $('chip-count-onchain');
	if (!el) return;
	const total = state.stats?.onchain;
	if (!total) {
		el.textContent = '';
		return;
	}
	el.textContent = fmtNumber(total);
	const chip = el.closest('.market-chip');
	if (chip) {
		chip.setAttribute(
			'aria-label',
			`Onchain — ${fmtNumber(total)} ERC-8004 agents indexed across all supported chains`,
		);
	}
}

// ── 3D Lobby (Three.js multi-avatar scene, opt-in) ──────────────────────

let lobbyHandle = null;

async function openLobby() {
	const overlay = $('market-lobby-overlay');
	const canvas = $('market-lobby-canvas');
	if (!overlay || !canvas) return;
	const slots = (state.featured.length ? state.featured : state.publicAvatars).slice(0, 5);
	if (!slots.length) return;
	overlay.hidden = false;
	stopHeroAutoplay();
	try {
		const mod = await import('./marketplace-lobby.js');
		lobbyHandle = await mod.mountLobby(canvas, slots, {
			onSelect: (avatar) => {
				closeLobby();
				if (avatar) openAvatarModal(avatar);
			},
		});
	} catch (err) {
		console.error('[marketplace] lobby load', err);
		closeLobby();
	}
}

function closeLobby() {
	const overlay = $('market-lobby-overlay');
	if (overlay) overlay.hidden = true;
	if (lobbyHandle?.dispose) lobbyHandle.dispose();
	lobbyHandle = null;
	if (state.featured.length) startHeroAutoplay();
}

// ── Weekly theme strip ───────────────────────────────────────────────────

async function loadTheme() {
	try {
		const r = await fetch(`${API}/marketplace/theme`);
		if (!r.ok) return;
		const j = await r.json();
		const theme = j?.data?.theme;
		if (!theme) return;
		state.theme = theme;
		renderTheme();
	} catch (err) {
		console.error('[marketplace] theme', err);
	}
}

function renderTheme() {
	const strip = $('market-theme-strip');
	if (!strip || !state.theme) return;
	$('market-theme-title').textContent = state.theme.title;
	$('market-theme-blurb').textContent = state.theme.blurb || '';
	const cta = $('market-theme-cta');
	if (state.theme.tag) {
		cta.hidden = false;
		cta.textContent = `Browse #${state.theme.tag} →`;
		cta.onclick = () => {
			els.search.value = state.theme.tag;
			state.q = state.theme.tag;
			loadList(true);
			window.scrollTo({ top: 0, behavior: 'smooth' });
		};
	} else {
		cta.hidden = true;
	}
	strip.hidden = false;
}

// ── Featured hero (rotating 3D showcase) ─────────────────────────────────

async function loadFeatured() {
	if (state.featured.length || state.q || state.category) return;
	try {
		const url = new URL(`${API}/explore`, location.origin);
		url.searchParams.set('source', 'avatar');
		url.searchParams.set('quality', 'high');
		url.searchParams.set('limit', '12');
		const r = await fetch(url);
		if (!r.ok) return;
		const j = await r.json();
		const named = (j?.items || []).filter(
			(it) =>
				it.kind === 'avatar' &&
				it.glbUrl &&
				!isAutoNamedAvatar(it.name) &&
				String(it.name).trim().length > 1,
		);
		state.featured = named.slice(0, 3);
		if (!state.featured.length) {
			// Fall back to any 3 avatars with a GLB so the hero never shows blank.
			state.featured = (j?.items || [])
				.filter((it) => it.kind === 'avatar' && it.glbUrl)
				.slice(0, 3);
		}
		state.heroIndex = 0;
		renderHero();
		startHeroAutoplay();
	} catch (err) {
		console.error('[marketplace] featured', err);
	}
}

function renderHero() {
	const hero = $('market-hero');
	if (!hero) return;
	if (!state.featured.length) {
		hero.hidden = true;
		return;
	}
	hero.hidden = false;
	const stage = $('market-hero-stage');
	const dots = $('market-hero-dots');
	stage.innerHTML = state.featured
		.map(
			(a, i) => `
				<div class="market-hero-slide${i === state.heroIndex ? ' active' : ''}" data-slot="${i}">
					<div class="market-hero-placeholder" aria-hidden="true">
						<span class="market-hero-placeholder-initial">${escapeHtml(initial(a.name || 'A'))}</span>
						<span class="market-hero-placeholder-name">${escapeHtml(a.name || 'Avatar')}</span>
					</div>
					<model-viewer
						src="${escapeHtml(a.glbUrl)}"
						alt="${escapeHtml(a.name || 'Avatar')}"
						auto-rotate
						autoplay
						rotation-per-second="20deg"
						camera-controls
						interaction-prompt="none"
						exposure="1.05"
						shadow-intensity="0.8"
						tone-mapping="aces"
						loading="${i === state.heroIndex ? 'eager' : 'lazy'}"
						reveal="auto"
					></model-viewer>
				</div>`,
		)
		.join('');
	attachModelViewerBehavior(stage);
	// If a hero GLB upstream blocks CORS or 404s, model-viewer logs to console
	// and shows nothing. Listen for that and remove the broken slide so we
	// don't show empty stages or pollute the console.
	stage.querySelectorAll('model-viewer').forEach((mv) => {
		mv.addEventListener('error', () => {
			const slot = Number(mv.closest('.market-hero-slide')?.dataset?.slot ?? -1);
			if (slot < 0) return;
			state.featured.splice(slot, 1);
			if (state.heroIndex >= state.featured.length) state.heroIndex = 0;
			if (state.featured.length) renderHero();
		}, { once: true });
	});
	dots.innerHTML = state.featured
		.map(
			(_, i) =>
				`<button class="market-hero-dot${i === state.heroIndex ? ' active' : ''}" data-dot="${i}" aria-label="Slide ${i + 1} of ${state.featured.length}"${i === state.heroIndex ? ' aria-current="true"' : ''}></button>`,
		)
		.join('');
	const dotButtons = dots.querySelectorAll('[data-dot]');
	dotButtons.forEach((btn) => {
		btn.addEventListener('click', () => {
			state.heroIndex = Number(btn.dataset.dot);
			renderHero();
			startHeroAutoplay();
		});
		// ArrowLeft/ArrowRight cycle focus + slide. Home/End jump to first/last.
		btn.addEventListener('keydown', (e) => {
			const last = state.featured.length - 1;
			let next = null;
			if (e.key === 'ArrowRight') next = Math.min(state.heroIndex + 1, last);
			else if (e.key === 'ArrowLeft') next = Math.max(state.heroIndex - 1, 0);
			else if (e.key === 'Home') next = 0;
			else if (e.key === 'End') next = last;
			if (next === null || next === state.heroIndex) return;
			e.preventDefault();
			state.heroIndex = next;
			renderHero();
			dots.querySelector(`[data-dot="${next}"]`)?.focus();
			startHeroAutoplay();
		});
	});
	bindHeroInteractions();
	updateHeroMeta();
}

let heroInteractionsBound = false;
function bindHeroInteractions() {
	if (heroInteractionsBound) return;
	const hero = $('market-hero');
	if (!hero) return;
	heroInteractionsBound = true;
	// Pause autoplay when the user is engaging with the hero (mouse over,
	// or keyboard focus inside) — resume on leave / blur.
	const pause = () => stopHeroAutoplay();
	const resume = () => {
		if (state.featured.length >= 2 && !document.hidden) startHeroAutoplay();
	};
	hero.addEventListener('mouseenter', pause);
	hero.addEventListener('mouseleave', resume);
	hero.addEventListener('focusin', pause);
	hero.addEventListener('focusout', (e) => {
		if (!hero.contains(e.relatedTarget)) resume();
	});
}

function updateHeroMeta() {
	const a = state.featured[state.heroIndex];
	if (!a) return;
	$('market-hero-title').textContent = a.name || 'Untitled avatar';
	$('market-hero-desc').textContent =
		a.description ||
		'A 3D avatar published to the community. Use it as the visual identity for a new agent.';
	const view = $('market-hero-view');
	if (view) {
		view.onclick = () => openAvatarModal(a);
	}
	const fork = $('market-hero-fork');
	if (fork) {
		fork.hidden = false;
		fork.textContent = 'Start an agent →';
		fork.onclick = () => {
			activeAvatar = a;
			startAgentFromAvatar();
		};
	}
	updateNavCounts();
}

// Update sidebar count badges from current state. Called after the explore
// feed settles so the nav reflects what's actually browsable.
function updateNavCounts() {
	const agentEl = $('nav-count-agent');
	const avatarEl = $('nav-count-avatar');
	const totals = state.stats || {};
	if (agentEl) {
		// Show curated agent count, not totals.onchain — the Onchain filter chip
		// already surfaces the ERC-8004 count, and showing "109k" next to a label
		// that reads just "Agent" conflicts with the visible "Agents N" section.
		const n = Number(state.items.length);
		if (Number.isFinite(n) && n > 0) {
			agentEl.textContent = fmtNumber(n);
			agentEl.hidden = false;
		} else {
			agentEl.hidden = true;
		}
	}
	if (avatarEl) {
		const n = Number(totals.avatars ?? state.publicAvatars.length);
		if (Number.isFinite(n) && n > 0) {
			avatarEl.textContent = fmtNumber(n);
			avatarEl.hidden = false;
		} else {
			avatarEl.hidden = true;
		}
	}
}

function startHeroAutoplay() {
	if (state.heroTimer) clearInterval(state.heroTimer);
	if (state.featured.length < 2) return;
	// Honor the OS-level reduced-motion preference — users on that setting
	// shouldn't see content silently rotating under them.
	if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) {
		return;
	}
	state.heroTimer = setInterval(() => {
		state.heroIndex = (state.heroIndex + 1) % state.featured.length;
		// Cheap update — just toggle active classes + meta, don't re-render model-viewers.
		document.querySelectorAll('.market-hero-slide').forEach((el) => {
			el.classList.toggle('active', Number(el.dataset.slot) === state.heroIndex);
		});
		document.querySelectorAll('.market-hero-dot').forEach((el) => {
			const isActive = Number(el.dataset.dot) === state.heroIndex;
			el.classList.toggle('active', isActive);
			if (isActive) el.setAttribute('aria-current', 'true');
			else el.removeAttribute('aria-current');
		});
		updateHeroMeta();
	}, 6500);
}

function stopHeroAutoplay() {
	if (state.heroTimer) clearInterval(state.heroTimer);
	state.heroTimer = null;
}

// ── Filter chips (All / Agents / Avatars / Onchain) ──────────────────────

function bindFilterChips() {
	const chips = document.querySelectorAll('#market-filter-chips .market-chip');
	chips.forEach((chip) => {
		chip.addEventListener('click', () => {
			chips.forEach((c) => {
				const isActive = c === chip;
				c.classList.toggle('active', isActive);
				c.setAttribute('aria-selected', isActive ? 'true' : 'false');
			});
			state.filter = chip.dataset.filter || 'all';
			syncFilterToUrl({ push: true });
			// Hero showcases community avatars; hide it for non-avatar filters.
			const hero = $('market-hero');
			if (hero) {
				if (state.filter === 'agents' || state.filter === 'onchain') {
					hero.hidden = true;
					stopHeroAutoplay();
				} else if (state.featured.length) {
					hero.hidden = false;
					startHeroAutoplay();
				}
			}
			if (state.filter === 'onchain' && !state.onchainLoaded) {
				loadOnchainAgents(true);
			}
			renderGrid();
		});
	});

	// Price-filter chips (Any / Free / Paid) act orthogonally to the kind
	// filter — toggling them just re-filters the in-memory grid without
	// triggering a refetch.
	const priceChips = document.querySelectorAll('#market-price-filter-chips .market-chip');
	priceChips.forEach((chip) => {
		chip.addEventListener('click', () => {
			priceChips.forEach((c) => c.classList.toggle('active', c === chip));
			state.priceFilter = chip.dataset.priceFilter || 'all';
			renderGrid();
		});
	});
}

function renderTagBanner() {
	const banner = $('market-tag-banner');
	if (!banner) return;
	if (!state.tag) {
		banner.hidden = true;
		banner.innerHTML = '';
		return;
	}
	banner.hidden = false;
	banner.innerHTML = `
		<span class="market-tag-banner-label">Filtering by tag</span>
		<span class="market-tag-banner-chip">
			${escapeHtml(state.tag)}
			<button class="market-tag-banner-clear" aria-label="Clear tag filter" type="button">✕</button>
		</span>`;
	banner.querySelector('.market-tag-banner-clear')?.addEventListener('click', () => {
		navTo('/marketplace');
	});
}

function renderGrid() {
	const showAgents = state.filter === 'all' || state.filter === 'agents';
	const showAvatars = (state.filter === 'all' || state.filter === 'avatars') && !state.category;
	const showOnchain = state.filter === 'all' || state.filter === 'onchain';
	let agentItems = showAgents ? state.items : [];
	let avatars = showAvatars ? state.publicAvatars : [];
	let onchain = showOnchain ? state.onchainItems : [];

	// Tag filter (?tag=humanoid) — case-insensitive exact-match on the .tags array
	if (state.tag) {
		const t = state.tag;
		const matches = (arr) =>
			Array.isArray(arr) && arr.some((x) => String(x).toLowerCase() === t);
		agentItems = agentItems.filter((a) => matches(a.tags));
		avatars = avatars.filter((a) => matches(a.tags));
		onchain = onchain.filter((a) => matches(a.tags));
	}

	// Price filter (Free / Paid). Onchain agents aren't sold through this
	// marketplace surface, so the filter only applies to agents + avatars.
	if (state.priceFilter === 'free') {
		agentItems = agentItems.filter((a) => !hasActivePrice(a.price));
		avatars = avatars.filter((a) => !hasActivePrice(a.price));
	} else if (state.priceFilter === 'paid') {
		agentItems = agentItems.filter((a) => hasActivePrice(a.price));
		avatars = avatars.filter((a) => hasActivePrice(a.price));
		onchain = [];
	}

	renderTagBanner();

	const totalCards = agentItems.length + avatars.length + onchain.length;

	if (!totalCards) {
		const stillLoading =
			(!state.publicAvatarsLoaded && state.filter !== 'agents' && state.filter !== 'onchain') ||
			(!state.onchainLoaded && state.filter === 'onchain');
		if (stillLoading) {
			els.grid.innerHTML = renderSkeletons(8);
		} else {
			els.grid.innerHTML = renderEmptyState();
		}
		els.loadMore.hidden = true;
		return;
	}

	let html = '';
	if (agentItems.length) {
		if (state.filter === 'all' && (avatars.length || onchain.length)) {
			html += `<div class="market-grid-section-title">Agents <span class="count">${agentItems.length}</span></div>`;
		}
		html += agentItems.map(renderCard).join('');
	}
	if (avatars.length) {
		if (state.filter === 'all' && (agentItems.length || onchain.length)) {
			html += `<div class="market-grid-section-title">Community Avatars <span class="count">${avatars.length} public</span></div>`;
		}
		// First avatar gets the featured spotlight (2×2) when avatars lead the grid.
		const isLeading = !agentItems.length && !onchain.length;
		html += avatars.map((a, i) => renderAvatarCard(a, isLeading && i === 0)).join('');
	}
	if (onchain.length) {
		if (state.filter === 'all' && (agentItems.length || avatars.length)) {
			const more = state.stats?.onchain ? `<span class="count">${fmtNumber(state.stats.onchain)} total</span>` : '';
			html += `<div class="market-grid-section-title">Onchain Agents ${more}</div>`;
		}
		html += onchain.map(renderOnchainCard).join('');
	}

	// Infinite scroll sentinel — observed below to auto-fetch next page.
	const hasMore =
		(state.filter === 'all' && (state.cursor || state.onchainCursor)) ||
		(state.filter === 'agents' && state.cursor) ||
		(state.filter === 'onchain' && state.onchainCursor);
	if (hasMore) {
		html += '<div class="market-scroll-sentinel" aria-hidden="true"></div>';
		html += '<div class="market-loadmore-spinner" aria-label="Loading more…"></div>';
	}

	els.grid.innerHTML = html;

	// Poster cache + shimmer-off for model-viewers.
	attachModelViewerBehavior();

	// Kick off infinite scroll observation.
	if (hasMore) _setupInfiniteScroll();

	els.grid.querySelectorAll('[data-id]').forEach((card) => {
		card.addEventListener('click', () => navTo(`/marketplace/agents/${card.dataset.id}`));
	});
	els.grid.querySelectorAll('[data-avatar-id]').forEach((card) => {
		card.addEventListener('click', (e) => {
			// Don't trigger card nav when clicking the embedded author link or heart.
			if (e.target.closest('a')) return;
			const bmBtn = e.target.closest('.card-heart');
			if (bmBtn) {
				e.stopPropagation();
				toggleAvatarBookmark(bmBtn.dataset.bmId || '');
				return;
			}
			const id = card.dataset.avatarId;
			if (id) navTo(`/marketplace/avatars/${encodeURIComponent(id)}`);
		});
	});
	els.grid.querySelectorAll('[data-onchain-href]').forEach((card) => {
		card.addEventListener('click', (e) => {
			if (e.target.closest('a')) return;
			const href = card.dataset.onchainHref;
			if (href) location.href = href;
		});
	});

	// Tag pills inside cards navigate to ?tag=X so the URL is shareable and
	// browser back/forward works. render() picks up state.tag from the route.
	els.grid.querySelectorAll('[data-tag]').forEach((pill) => {
		pill.addEventListener('click', (e) => {
			e.stopPropagation();
			const tag = pill.dataset.tag;
			if (!tag) return;
			navTo(`/marketplace?tag=${encodeURIComponent(tag)}`);
		});
	});

	// Hide the legacy load-more button — infinite scroll handles it.
	els.loadMore.hidden = true;

	observeCardModelViewers();
}

// ── 3D card performance: pause off-screen model-viewers ──────────────────
//
// Each <model-viewer> runs a continuous requestAnimationFrame loop while
// auto-rotate is set, regardless of whether the card is on screen. With
// 60+ cards in the grid that adds up to dropped frames on mid-tier devices.
// Solution: an IntersectionObserver toggles the `auto-rotate` attribute as
// each card enters/leaves the viewport. When detached, the model-viewer
// stops rendering entirely (model-viewer halts its raf when no rotate/no
// camera motion). We don't tear down the WebGL context — it's expensive
// to re-init — but pausing rotation drops GPU usage to ~0 for off-screen
// cards.

let cardObserver = null;
function observeCardModelViewers() {
	if (typeof IntersectionObserver === 'undefined') {
		// Browser without IntersectionObserver: eagerly promote data-src so
		// the cards still render. Acceptable fallback for ancient browsers.
		document.querySelectorAll('model-viewer[data-src]').forEach((mv) => {
			mv.setAttribute('src', mv.dataset.src);
			mv.setAttribute('auto-rotate', '');
		});
		return;
	}
	if (!cardObserver) {
		cardObserver = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					const mv = entry.target;
					if (entry.isIntersecting) {
						// Lazy promote data-src → src on first intersect (fires the GLB download).
						if (mv.dataset.src && !mv.getAttribute('src')) {
							mv.setAttribute('src', mv.dataset.src);
							delete mv.dataset.src;
						}
						if (mv.dataset.shouldRotate !== '0') mv.setAttribute('auto-rotate', '');
					} else {
						// Suspend rotation off-screen so model-viewer halts its raf loop.
						mv.removeAttribute('auto-rotate');
					}
				}
			},
			{ rootMargin: '200px 0px', threshold: 0.01 },
		);
	}
	document.querySelectorAll('.market-card-avatar model-viewer, .market-grid model-viewer').forEach((mv) => {
		if (mv.dataset.observed) return;
		mv.dataset.observed = '1';
		cardObserver.observe(mv);
	});
}

// ── Avatar detail modal ──────────────────────────────────────────────────

let activeAvatar = null;

function openAvatarModal(avatar) {
	activeAvatar = avatar;
	const overlay = $('avatar-modal-overlay');
	const stage = $('avatar-modal-stage');
	if (!overlay || !stage) return;

	const closeBtn = stage.querySelector('.avatar-modal-close');
	stage.innerHTML = '';
	if (closeBtn) stage.appendChild(closeBtn);
	const mv = document.createElement('model-viewer');
	mv.setAttribute('src', avatar.glbUrl || '');
	mv.setAttribute('alt', avatar.name || 'Avatar');
	mv.setAttribute('auto-rotate', '');
	mv.setAttribute('rotation-per-second', '18deg');
	mv.setAttribute('camera-controls', '');
	mv.setAttribute('interaction-prompt', 'none');
	mv.setAttribute('autoplay', '');
	mv.setAttribute('exposure', '1.05');
	mv.setAttribute('shadow-intensity', '0.7');
	mv.setAttribute('tone-mapping', 'aces');
	if (avatar.image) mv.setAttribute('poster', avatar.image);
	mv.style.cssText = 'opacity:0;transition:opacity .3s ease;';
	stage.appendChild(mv);

	const progressEl = Object.assign(document.createElement('div'), { className: 'modal-load-progress' });
	progressEl.innerHTML = '<div class="modal-load-bar-wrap"><div class="modal-load-bar" id="modal-load-bar"></div></div><span class="modal-load-label">Loading 3D…</span>';
	stage.insertBefore(progressEl, mv);
	mv.addEventListener('progress', (e) => {
		const bar = document.getElementById('modal-load-bar');
		if (bar) bar.style.width = Math.round((e.detail?.totalProgress || 0) * 100) + '%';
	});
	mv.addEventListener('load', () => { progressEl.remove(); mv.style.opacity = '1'; }, { once: true });

	$('avatar-modal-title').textContent = avatar.name || 'Untitled avatar';
	$('avatar-modal-desc').textContent =
		avatar.description || 'A 3D avatar published to the community. Use it as the face of a new AI agent.';

	let authorEl = document.getElementById('avatar-modal-author');
	if (avatar.author?.handle) {
		if (!authorEl) {
			authorEl = Object.assign(document.createElement('p'), { id: 'avatar-modal-author', className: 'avatar-modal-author' });
			$('avatar-modal-desc')?.insertAdjacentElement('afterend', authorEl);
		}
		authorEl.innerHTML = avatar.author.profileUrl
			? `by <a href="${escapeHtml(avatar.author.profileUrl)}" rel="author">${escapeHtml(avatar.author.displayName || avatar.author.handle)}</a>`
			: `by ${escapeHtml(avatar.author.displayName || avatar.author.handle)}`;
	} else if (authorEl) { authorEl.textContent = ''; }

	const meta = $('avatar-modal-meta');
	const pills = [];
	if (avatar.featured) pills.push('<span class="stat-pill featured-badge">⭐ Featured</span>');
	if (avatar.createdAt) pills.push(`<span class="stat-pill">${escapeHtml(liveTime(avatar.createdAt))}</span>`);
	pills.push('<span class="stat-pill">3D · GLB</span>');
	(avatar.tags || []).slice(0, 5).forEach((t) => {
		pills.push(`<button type="button" class="stat-pill tag-pill" data-tag="${escapeHtml(t)}" style="cursor:pointer">#${escapeHtml(t)}</button>`);
	});
	meta.innerHTML = pills.join('');
	meta.querySelectorAll('[data-tag]').forEach((btn) => {
		btn.addEventListener('click', () => { closeAvatarModal(); navTo(`/marketplace?tag=${encodeURIComponent(btn.dataset.tag)}`); });
	});

	const bm = getAvatarBookmarks().has(avatar.avatarId || '');
	const bmBtn = $('avatar-modal-bookmark');
	if (bmBtn) {
		bmBtn.classList.toggle('active', bm);
		bmBtn.setAttribute('aria-pressed', String(bm));
		bmBtn.onclick = () => {
			const now = toggleAvatarBookmark(avatar.avatarId || '');
			bmBtn.classList.toggle('active', now);
			bmBtn.setAttribute('aria-pressed', String(now));
		};
	}

	const view = $('avatar-modal-view');
	if (view) view.href = avatar.viewerUrl || (avatar.glbUrl ? `/app#model=${encodeURIComponent(avatar.glbUrl)}` : '#');
	const dl = $('avatar-modal-download');
	if (dl) { dl.href = avatar.glbUrl || '#'; dl.download = (avatar.slug || avatar.avatarId || 'avatar') + '.glb'; }

	overlay.hidden = false;
	requestAnimationFrame(() => overlay.classList.add('show'));

	// Render the sell-or-buy panel — empty for demo/onchain avatars.
	renderAvatarSalePanel(avatar);

	// Fire-and-forget view tracking — server rate-limits per IP/avatar so safe to call on every open.
	if (avatar.avatarId && !String(avatar.avatarId).startsWith('avatar_demo_')) {
		fetch(`${API}/avatars/view`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ avatar_id: avatar.avatarId }),
			keepalive: true,
		}).catch(() => {});
	}
}

// ── Sell-or-buy panel for the avatar detail modal ─────────────────────────
//
// Asks the server who owns the avatar + its active price, then renders one
// of two inline panels:
//   1. Owner → editor: set/clear a USDC price + payout wallet.
//   2. Non-owner → "Pay X USDC" button (only when there's an active price).
//
// Demo / onchain avatars skip the panel since they're not stored as our rows.
async function renderAvatarSalePanel(avatar) {
	const sale = $('avatar-modal-sale');
	if (!sale) return;
	sale.hidden = true;
	sale.innerHTML = '';

	const id = avatar.avatarId || '';
	if (!id || id.startsWith('avatar_demo_')) return;

	// Fetch the canonical avatar row to determine ownership + payout state.
	// `owner_id` is present in the response only when the caller IS the owner —
	// see api/_lib/avatars.js#stripOwnerFor. We use that as our cheap auth check.
	let detail;
	try {
		const r = await fetch(`${API}/avatars/${encodeURIComponent(id)}`, { credentials: 'include' });
		if (!r.ok) return;
		const j = await r.json();
		detail = j?.avatar;
	} catch (err) {
		console.warn('[marketplace] sale-panel fetch failed', err);
		return;
	}
	if (!detail) return;

	const isOwner = !!detail.owner_id;
	const price = detail.price || avatar.price || null;

	if (isOwner) {
		sale.hidden = false;
		const decimals = Number(price?.mint_decimals ?? 6);
		const currentUsd = price ? (Number(price.amount) / Math.pow(10, decimals)).toString() : '';
		sale.innerHTML = `
			<div class="sale-eyebrow">Sell this avatar</div>
			${price
				? `<div class="sale-price">${escapeHtml(formatAssetPrice(price) || 'Free')}</div>`
				: `<div class="sale-price free">Free</div>`}
			<div class="sale-row">
				<label>
					Price
					<input type="number" id="avatar-sale-price" min="0" step="0.01" placeholder="0.00" value="${escapeHtml(currentUsd)}" />
				</label>
				<span class="sale-currency">USDC</span>
			</div>
			<label>
				Solana payout wallet
				<input type="text" id="avatar-sale-payout" placeholder="Your Solana address" />
			</label>
			<div class="sale-row" style="gap:8px">
				<button class="sale-save" type="button" id="avatar-sale-save">${price ? 'Update price' : 'List for sale'}</button>
				${price ? '<button class="sale-clear" type="button" id="avatar-sale-clear">Make free</button>' : ''}
			</div>
			<p class="sale-status" id="avatar-sale-status"></p>
			<p class="sale-hint">Buyers pay USDC on Solana. We don't take a cut — funds land in your payout wallet (minus referral commission if applicable).</p>
		`;

		// Prefill payout wallet field from /api/billing/payout-wallets if the
		// seller already saved one. Falls back to empty otherwise.
		fetch(`${API}/billing/payout-wallets`, { credentials: 'include' })
			.then((r) => (r.ok ? r.json() : null))
			.then((j) => {
				const ws = j?.wallets || [];
				const solana = ws.find((w) => w.chain === 'solana' && w.is_default) || ws.find((w) => w.chain === 'solana');
				if (solana?.address) {
					const inp = $('avatar-sale-payout');
					if (inp && !inp.value) inp.value = solana.address;
				}
			})
			.catch(() => {});

		$('avatar-sale-save')?.addEventListener('click', () => saveAvatarPrice(id));
		$('avatar-sale-clear')?.addEventListener('click', () => clearAvatarPrice(id));
		return;
	}

	if (price) {
		sale.hidden = false;
		sale.innerHTML = `
			<div class="sale-eyebrow">For sale</div>
			<div class="sale-price">${escapeHtml(formatAssetPrice(price))}</div>
			<button class="sale-buy" type="button" id="avatar-sale-buy">Buy now with USDC</button>
			<p class="sale-status" id="avatar-sale-status"></p>
			<p class="sale-hint">Pay directly to the creator on Solana. You'll need a connected wallet with USDC.</p>
		`;
		$('avatar-sale-buy')?.addEventListener('click', () => openAssetPurchaseFlow({
			item_type: 'avatar',
			item_id: id,
			label: avatar.name || 'Avatar',
			price,
		}));
	}
}

async function saveAvatarPrice(avatarId) {
	const priceInput = $('avatar-sale-price');
	const payoutInput = $('avatar-sale-payout');
	const status = $('avatar-sale-status');
	if (!priceInput || !payoutInput) return;
	const usd = Number(priceInput.value || 0);
	const payout = (payoutInput.value || '').trim();
	if (!Number.isFinite(usd) || usd < 0) { setSaleStatus(status, 'Enter a valid price.', 'err'); return; }
	if (usd > 0 && !payout) { setSaleStatus(status, 'A payout wallet is required to charge.', 'err'); return; }

	setSaleStatus(status, 'Saving…');
	try {
		// 1. Save the payout wallet first (if provided) so the price is sellable
		//    the moment it's set. Server is idempotent on (user, chain, address).
		if (payout) {
			const r = await fetch(`${API}/billing/payout-wallets`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify({ address: payout, chain: 'solana', is_default: true }),
			});
			if (!r.ok && r.status !== 409) {
				const j = await r.json().catch(() => ({}));
				throw new Error(j.error_description || j.error || 'Failed to save payout wallet');
			}
		}

		// 2. Write the price. amount is in atomic USDC units (6 decimals).
		const amount = Math.round(usd * 1_000_000);
		const r = await apiPostWithCsrf('/api/marketplace/asset-price', {
			item_type: 'avatar',
			item_id: avatarId,
			amount,
			currency_mint: USDC_MAINNET_MINT,
			chain: 'solana',
			mint_decimals: 6,
		});
		const j = await r.json();
		if (!r.ok) throw new Error(j.error_description || j.error || 'Failed to save price');

		setSaleStatus(status, amount === 0 ? '✓ Avatar is now free.' : `✓ Listed for ${usd} USDC.`, 'ok');
		// Refresh the in-memory item so the card reflects the new price next time.
		if (activeAvatar?.avatarId === avatarId) activeAvatar.price = j.data.price;
		updateAvatarCardPriceInGrid(avatarId, j.data.price);
	} catch (err) {
		setSaleStatus(status, err.message || 'Save failed', 'err');
	}
}

async function clearAvatarPrice(avatarId) {
	const status = $('avatar-sale-status');
	setSaleStatus(status, 'Clearing…');
	try {
		const r = await apiPostWithCsrf('/api/marketplace/asset-price', {
			item_type: 'avatar',
			item_id: avatarId,
			amount: 0,
			currency_mint: USDC_MAINNET_MINT,
			chain: 'solana',
			mint_decimals: 6,
		});
		if (!r.ok) {
			const j = await r.json().catch(() => ({}));
			throw new Error(j.error_description || j.error || 'Failed to clear price');
		}
		setSaleStatus(status, '✓ Avatar is now free.', 'ok');
		if (activeAvatar?.avatarId === avatarId) activeAvatar.price = null;
		updateAvatarCardPriceInGrid(avatarId, null);
		// Re-render the panel so the editor shows the new free state.
		if (activeAvatar?.avatarId === avatarId) renderAvatarSalePanel(activeAvatar);
	} catch (err) {
		setSaleStatus(status, err.message || 'Failed', 'err');
	}
}

function setSaleStatus(el, text, kind) {
	if (!el) return;
	el.textContent = text || '';
	el.className = 'sale-status' + (kind ? ' ' + kind : '');
}

// Live-update the in-grid card pill so the seller sees the change without a reload.
function updateAvatarCardPriceInGrid(avatarId, price) {
	const card = document.querySelector(`.market-card-avatar[data-avatar-id="${avatarId}"]`);
	if (!card) return;
	const thumb = card.querySelector('.thumb');
	if (!thumb) return;
	const old = thumb.querySelector('.market-price-pill');
	if (old) old.remove();
	thumb.insertAdjacentHTML('afterbegin', priceBadgeHtml(price));
}

// ── Sell-or-buy panel for the agent detail view ──────────────────────────
//
// Renders inside the existing #agent-sale-panel container right under the
// agent's name. Mirrors the avatar modal panel: owner sees price/payout
// Renders a pricing summary strip on the detail page overview,
// showing the number of paid skills and lowest price.
function renderDetailPricingSummary(agent) {
	const existing = document.getElementById('d-pricing-summary');
	if (existing) existing.remove();
	const skillPrices = agent.skill_prices || {};
	const priced = Object.entries(skillPrices).filter(([, p]) => p && Number(p.amount) > 0);
	if (!priced.length) return;
	const overview = $('d-overview');
	if (!overview) return;
	const minAmount = Math.min(...priced.map(([, p]) => Number(p.amount)));
	const decimals = Number(priced[0]?.[1]?.mint_decimals ?? 6);
	const minUsd = minAmount / Math.pow(10, decimals);
	const formatted = minUsd >= 1 ? minUsd.toFixed(2) : minUsd >= 0.01 ? minUsd.toFixed(3) : minUsd.toFixed(6).replace(/0+$/, '');
	const strip = document.createElement('div');
	strip.id = 'd-pricing-summary';
	strip.className = 'd-pricing-summary';
	strip.innerHTML = `
		<span class="d-pricing-icon">$</span>
		<span>${priced.length} paid skill${priced.length === 1 ? '' : 's'} · from <strong>$${escapeHtml(formatted)}/call</strong></span>
	`;
	overview.insertAdjacentElement('afterend', strip);
}

// editor, non-owner with active price sees a Buy button. Free agents for
// non-owners get nothing.
function renderAgentSalePanel(agent) {
	const panel = $('agent-sale-panel');
	if (!panel || !agent) return;
	panel.hidden = true;
	panel.innerHTML = '';

	const isOwner = !!(currentUserId && agent.author_id && currentUserId === agent.author_id);
	const price = agent.price || null;

	if (isOwner) {
		panel.hidden = false;
		const decimals = Number(price?.mint_decimals ?? 6);
		const currentUsd = price ? (Number(price.amount) / Math.pow(10, decimals)).toString() : '';
		panel.innerHTML = `
			<div class="sale-eyebrow">Sell this agent</div>
			${price
				? `<div class="sale-price">${escapeHtml(formatAssetPrice(price) || 'Free')}</div>`
				: `<div class="sale-price free">Free</div>`}
			<div class="sale-row">
				<label>
					Price
					<input type="number" id="agent-sale-price" min="0" step="0.01" placeholder="0.00" value="${escapeHtml(currentUsd)}" />
				</label>
				<span class="sale-currency">USDC</span>
			</div>
			<label>
				Solana payout wallet
				<input type="text" id="agent-sale-payout" placeholder="Your Solana address" />
			</label>
			<div class="sale-row" style="gap:8px">
				<button class="sale-save" type="button" id="agent-sale-save">${price ? 'Update price' : 'List for sale'}</button>
				${price ? '<button class="sale-clear" type="button" id="agent-sale-clear">Make free</button>' : ''}
			</div>
			<p class="sale-status" id="agent-sale-status"></p>
			<p class="sale-hint">Per-skill prices are still available below — this sets a single one-time price to fork the whole agent.</p>
		`;
		fetch(`${API}/billing/payout-wallets`, { credentials: 'include' })
			.then((r) => (r.ok ? r.json() : null))
			.then((j) => {
				const ws = j?.wallets || [];
				const solana = ws.find((w) => w.chain === 'solana' && w.is_default) || ws.find((w) => w.chain === 'solana');
				if (solana?.address) {
					const inp = $('agent-sale-payout');
					if (inp && !inp.value) inp.value = solana.address;
				}
			})
			.catch(() => {});

		$('agent-sale-save')?.addEventListener('click', () => saveAgentPrice(agent.id));
		$('agent-sale-clear')?.addEventListener('click', () => clearAgentPrice(agent.id));
		return;
	}

	if (price) {
		panel.hidden = false;
		panel.innerHTML = `
			<div class="sale-eyebrow">For sale</div>
			<div class="sale-price">${escapeHtml(formatAssetPrice(price))}</div>
			<button class="sale-buy" type="button" id="agent-sale-buy">Buy agent with USDC</button>
			<p class="sale-status" id="agent-sale-status"></p>
			<p class="sale-hint">One-time purchase grants ownership to fork the whole agent. Per-skill prices below are separate.</p>
		`;
		$('agent-sale-buy')?.addEventListener('click', () => openAssetPurchaseFlow({
			item_type: 'agent',
			item_id: agent.id,
			label: agent.name || 'Agent',
			price,
		}));
	}
}

async function saveAgentPrice(agentId) {
	const priceInput = $('agent-sale-price');
	const payoutInput = $('agent-sale-payout');
	const status = $('agent-sale-status');
	if (!priceInput || !payoutInput) return;
	const usd = Number(priceInput.value || 0);
	const payout = (payoutInput.value || '').trim();
	if (!Number.isFinite(usd) || usd < 0) { setSaleStatus(status, 'Enter a valid price.', 'err'); return; }
	if (usd > 0 && !payout) { setSaleStatus(status, 'A payout wallet is required to charge.', 'err'); return; }

	setSaleStatus(status, 'Saving…');
	try {
		if (payout) {
			const r = await fetch(`${API}/billing/payout-wallets`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify({ address: payout, chain: 'solana', is_default: true }),
			});
			if (!r.ok && r.status !== 409) {
				const j = await r.json().catch(() => ({}));
				throw new Error(j.error_description || j.error || 'Failed to save payout wallet');
			}
		}
		const amount = Math.round(usd * 1_000_000);
		const r = await apiPostWithCsrf('/api/marketplace/asset-price', {
			item_type: 'agent',
			item_id: agentId,
			amount,
			currency_mint: USDC_MAINNET_MINT,
			chain: 'solana',
			mint_decimals: 6,
		});
		const j = await r.json();
		if (!r.ok) throw new Error(j.error_description || j.error || 'Failed to save price');

		setSaleStatus(status, amount === 0 ? '✓ Agent is now free.' : `✓ Listed for ${usd} USDC.`, 'ok');
		if (detailState?.agent?.id === agentId) detailState.agent.price = j.data.price;
		if (detailState?.agent?.id === agentId) renderAgentSalePanel(detailState.agent);
	} catch (err) {
		setSaleStatus(status, err.message || 'Save failed', 'err');
	}
}

async function clearAgentPrice(agentId) {
	const status = $('agent-sale-status');
	setSaleStatus(status, 'Clearing…');
	try {
		const r = await apiPostWithCsrf('/api/marketplace/asset-price', {
			item_type: 'agent',
			item_id: agentId,
			amount: 0,
			currency_mint: USDC_MAINNET_MINT,
			chain: 'solana',
			mint_decimals: 6,
		});
		if (!r.ok) {
			const j = await r.json().catch(() => ({}));
			throw new Error(j.error_description || j.error || 'Failed to clear price');
		}
		setSaleStatus(status, '✓ Agent is now free.', 'ok');
		if (detailState?.agent?.id === agentId) detailState.agent.price = null;
		if (detailState?.agent?.id === agentId) renderAgentSalePanel(detailState.agent);
	} catch (err) {
		setSaleStatus(status, err.message || 'Failed', 'err');
	}
}

function closeAvatarModal() {
	const overlay = $('avatar-modal-overlay');
	if (!overlay) return;
	overlay.classList.remove('show');
	setTimeout(() => {
		overlay.hidden = true;
		const stage = $('avatar-modal-stage');
		const closeBtn = stage?.querySelector('.avatar-modal-close');
		if (stage) {
			stage.innerHTML = '';
			if (closeBtn) stage.appendChild(closeBtn);
		}
		activeAvatar = null;
	}, 200);
}

// ── Avatar bookmarks (localStorage) ─────────────────────────────────────

const AVATAR_BOOKMARKS_KEY = 'mk_avatar_bm_v1';
function getAvatarBookmarks() {
	try { return new Set(JSON.parse(localStorage.getItem(AVATAR_BOOKMARKS_KEY) || '[]')); }
	catch { return new Set(); }
}
function toggleAvatarBookmark(avatarId) {
	const set = getAvatarBookmarks();
	if (set.has(avatarId)) set.delete(avatarId); else set.add(avatarId);
	try { localStorage.setItem(AVATAR_BOOKMARKS_KEY, JSON.stringify([...set])); } catch {}
	document.querySelectorAll(`[data-avatar-id="${avatarId}"] .card-heart`).forEach((btn) => {
		btn.classList.toggle('active', set.has(avatarId));
		btn.setAttribute('aria-pressed', String(set.has(avatarId)));
	});
	return set.has(avatarId);
}

async function startAgentFromAvatar() {
	if (!activeAvatar) return;
	const params = new URLSearchParams({ avatar_id: activeAvatar.avatarId || '' });
	if (activeAvatar.name) params.set('avatar_name', activeAvatar.name);
	if (activeAvatar.glbUrl) params.set('avatar_glb', activeAvatar.glbUrl);
	location.href = `/agent/new?${params.toString()}`;
}

// ── Skills marketplace tab ───────────────────────────────────────────────
//
// Backed by /api/skills (marketplace_skills table). Server-side search +
// category + sort with cursor pagination, plus client-side free/paid filter,
// install/uninstall, and 1–5 star ratings.

const skillsState = {
	loaded: false,
	loading: false,
	loadingMore: false,
	skills: [],
	cursor: null,
	q: '',
	filter: 'all',
	sort: 'popular',
	category: null,
	categories: [],
	detailId: null,
};

async function loadSkillCategories() {
	try {
		const r = await fetch(`${API}/skills/categories`);
		if (!r.ok) return;
		const j = await r.json();
		skillsState.categories = Array.isArray(j?.categories) ? j.categories : [];
		renderSkillCategoryChips();
	} catch (err) {
		console.error('[marketplace] skills categories', err);
	}
}

function renderSkillCategoryChips() {
	const wrap = $('skills-cat-chips');
	if (!wrap) return;
	const all = `<button class="market-chip ${skillsState.category == null ? 'active' : ''}" data-skill-cat="">All</button>`;
	const chips = skillsState.categories.map((c) => {
		const active = skillsState.category === c.slug ? 'active' : '';
		return `<button class="market-chip ${active}" data-skill-cat="${escapeHtml(c.slug)}">${escapeHtml(c.label)}<span class="chip-count">${c.count}</span></button>`;
	}).join('');
	wrap.innerHTML = all + chips;
	wrap.querySelectorAll('[data-skill-cat]').forEach((b) => {
		b.addEventListener('click', () => {
			const slug = b.dataset.skillCat || null;
			if (slug === skillsState.category) return;
			skillsState.category = slug;
			renderSkillCategoryChips();
			loadSkillsTab(true);
		});
	});
}

async function loadSkillsTab(force = false, append = false) {
	if (skillsState.loading || skillsState.loadingMore) return;
	if (skillsState.loaded && !force && !append) {
		renderSkillsGrid();
		return;
	}
	if (append) skillsState.loadingMore = true;
	else skillsState.loading = true;

	const grid = $('skills-grid');
	if (grid && !append) grid.innerHTML = renderSkeletons(8);

	try {
		const url = new URL(`${API}/skills`, location.origin);
		url.searchParams.set('limit', '24');
		if (skillsState.q) url.searchParams.set('q', skillsState.q);
		if (skillsState.category) url.searchParams.set('category', skillsState.category);
		if (skillsState.sort) url.searchParams.set('sort', skillsState.sort);
		if (append && skillsState.cursor) url.searchParams.set('cursor', skillsState.cursor);

		const r = await fetch(url, { credentials: 'include' });
		if (!r.ok) throw new Error(`HTTP ${r.status}`);
		const j = await r.json();
		const incoming = Array.isArray(j?.skills) ? j.skills : [];

		if (append) skillsState.skills = skillsState.skills.concat(incoming);
		else skillsState.skills = incoming;
		skillsState.cursor = j?.next_cursor || null;
		skillsState.loaded = true;
	} catch (err) {
		console.error('[marketplace] skills load', err);
		if (grid && !append) {
			grid.innerHTML = `<div class="market-empty">Failed to load skills. <button id="skills-retry" class="market-empty-cta-btn">Retry</button></div>`;
			$('skills-retry')?.addEventListener('click', () => loadSkillsTab(true));
		}
	} finally {
		skillsState.loading = false;
		skillsState.loadingMore = false;
	}
	renderSkillsGrid();
}

function isPaidSkill(s) {
	return Number(s?.price_per_call_usd) > 0;
}

function skillToolCount(s) {
	return Array.isArray(s?.schema_json) ? s.schema_json.length : 0;
}

function renderSkillsGrid() {
	const grid = $('skills-grid');
	if (!grid) return;
	const filtered = skillsState.skills.filter((s) => {
		if (skillsState.filter === 'paid' && !isPaidSkill(s)) return false;
		if (skillsState.filter === 'free' && isPaidSkill(s)) return false;
		return true;
	});

	const sub = $('skills-subtitle');
	if (sub) {
		const cat = skillsState.category
			? (skillsState.categories.find((c) => c.slug === skillsState.category)?.label || skillsState.category)
			: null;
		const noun = filtered.length === 1 ? 'skill' : 'skills';
		sub.textContent = cat
			? `${filtered.length} ${noun} in ${cat}${skillsState.cursor ? '+' : ''}`
			: `Browse ${filtered.length}${skillsState.cursor ? '+' : ''} ${noun} from the community`;
	}

	const loadMoreRow = $('skills-loadmore-row');
	if (loadMoreRow) loadMoreRow.hidden = !skillsState.cursor;

	if (!filtered.length) {
		const msg = !skillsState.skills.length
			? `<div class="market-empty-cta">
					<h3>No skills found</h3>
					<p>Try a different category, clear your search, or publish your own skill.</p>
					<div class="market-empty-cta-actions">
						<button class="market-empty-cta-btn" id="skills-empty-clear">Clear filters</button>
						<button class="market-empty-cta-btn primary" id="skills-empty-publish">Publish a Skill</button>
					</div>
				</div>`
			: '<div class="market-empty">No skills match your free/paid filter.</div>';
		grid.innerHTML = msg;
		$('skills-empty-clear')?.addEventListener('click', () => {
			skillsState.q = '';
			skillsState.category = null;
			skillsState.filter = 'all';
			const input = $('skills-search'); if (input) input.value = '';
			document.querySelectorAll('[data-skill-filter]').forEach((c) => {
				c.classList.toggle('active', c.dataset.skillFilter === 'all');
			});
			renderSkillCategoryChips();
			loadSkillsTab(true);
		});
		$('skills-empty-publish')?.addEventListener('click', openSubmitModal);
		return;
	}

	grid.innerHTML = filtered.map(renderSkillCard).join('');
	grid.querySelectorAll('[data-skill-id]').forEach((card) => {
		card.addEventListener('click', () => {
			const id = card.dataset.skillId;
			if (id) openSkillModal(id);
		});
	});
}

function renderSkillCard(s) {
	const paid = isPaidSkill(s);
	const installed = !!s.installed;
	const rating = Number(s.avg_rating) || 0;
	const installs = Number(s.install_count) || 0;
	const tools = skillToolCount(s);
	const category = s.category || 'general';
	const ratingDisplay = s.rating_count > 0
		? `<span class="rating" title="${rating.toFixed(1)} from ${s.rating_count} ${s.rating_count === 1 ? 'rating' : 'ratings'}">★ ${rating.toFixed(1)}</span>`
		: '';
	const installsDisplay = installs > 0
		? `<span class="installs" title="${installs.toLocaleString()} installs">${fmtNumber(installs)} installs</span>`
		: '';
	const toolsDisplay = tools > 0
		? `<span class="installs">${tools} tool${tools === 1 ? '' : 's'}</span>`
		: '';
	const installedTag = installed
		? `<span class="skill-installed-tag" title="Installed">✓ Installed</span>`
		: '';
	const desc = escapeHtml(s.description || s.content_preview || '');
	return `<div class="market-skill-card ${installed ? 'installed' : ''}" data-skill-id="${escapeHtml(s.id)}">
		<div class="skill-head">
			<div class="skill-name">${escapeHtml(s.name)}</div>
			<div class="skill-price ${paid ? 'paid' : 'free'}">${paid ? `$${Number(s.price_per_call_usd).toFixed(3)}/call` : 'Free'}</div>
		</div>
		<div class="skill-desc">${desc || '<em style="color:#52525b">No description.</em>'}</div>
		<div class="skill-meta">
			<span class="cat-pill">${escapeHtml(category)}</span>
			${installsDisplay}
			${toolsDisplay}
			${ratingDisplay}
		</div>
		<div class="skill-meta" style="justify-content:space-between">
			${installedTag || '<span></span>'}
			<span class="open-cta" style="color:#fafafa;opacity:0.6;font-weight:500">Details →</span>
		</div>
	</div>`;
}

// ── Skill detail modal ──────────────────────────────────────────────────

async function openSkillModal(id) {
	const overlay = $('skill-modal-overlay');
	if (!overlay) return;
	skillsState.detailId = id;
	overlay.hidden = false;
	$('skill-modal-title').textContent = 'Loading…';
	$('skill-modal-desc').textContent = '';
	$('skill-modal-meta').innerHTML = '';
	$('skill-modal-tools').hidden = true;
	$('skill-modal-content').hidden = true;
	$('skill-modal-rating').hidden = true;
	$('skill-modal-install').disabled = true;

	try {
		const r = await fetch(`${API}/skills/${encodeURIComponent(id)}`, { credentials: 'include' });
		if (!r.ok) throw new Error(`HTTP ${r.status}`);
		const j = await r.json();
		renderSkillModal(j.skill);
	} catch (err) {
		console.error('[marketplace] skill detail', err);
		$('skill-modal-title').textContent = 'Failed to load skill';
		$('skill-modal-desc').textContent = err.message;
	}
}

function closeSkillModal() {
	const overlay = $('skill-modal-overlay');
	if (overlay) overlay.hidden = true;
	skillsState.detailId = null;
}

function renderSkillModal(skill) {
	if (!skill) return;
	skillsState.detailId = skill.id;
	const paid = isPaidSkill(skill);
	$('skill-modal-title').textContent = skill.name;
	$('skill-modal-desc').textContent = skill.description || '';
	$('skill-modal-eyebrow').textContent = paid ? 'Paid skill' : 'Free skill';

	const meta = $('skill-modal-meta');
	const installs = Number(skill.install_count) || 0;
	const rating = Number(skill.avg_rating) || 0;
	const tools = Array.isArray(skill.schema_json) ? skill.schema_json.length : 0;
	const author = skill.author?.display_name || 'System';
	meta.innerHTML = `
		<span class="stat-pill" style="text-transform:capitalize">${escapeHtml(skill.category || 'general')}</span>
		<span class="stat-pill">By ${escapeHtml(author)}</span>
		${installs > 0 ? `<span class="stat-pill">${fmtNumber(installs)} installs</span>` : ''}
		${skill.rating_count > 0 ? `<span class="stat-pill">★ ${rating.toFixed(1)} · ${skill.rating_count}</span>` : ''}
		${tools > 0 ? `<span class="stat-pill">${tools} tool${tools === 1 ? '' : 's'}</span>` : ''}
		${paid ? `<span class="stat-pill" style="color:#fde047;border-color:rgba(253,224,71,0.3)">$${Number(skill.price_per_call_usd).toFixed(3)}/call</span>` : `<span class="stat-pill" style="color:#34d399;border-color:rgba(52,211,153,0.3)">Free</span>`}
	`;

	const toolsEl = $('skill-modal-tools');
	if (Array.isArray(skill.schema_json) && skill.schema_json.length) {
		toolsEl.hidden = false;
		toolsEl.innerHTML = `<h4>Tools provided</h4><ul>${skill.schema_json.map((g) => {
			const name = escapeHtml(g?.function?.name || g?.clientDefinition?.name || '?');
			const desc = escapeHtml(g?.function?.description || g?.clientDefinition?.description || '');
			return `<li>${name}${desc ? `<small>${desc}</small>` : ''}</li>`;
		}).join('')}</ul>`;
	} else {
		toolsEl.hidden = true;
	}

	const contentEl = $('skill-modal-content');
	if (skill.content) {
		contentEl.hidden = false;
		contentEl.textContent = skill.content.length > 4000 ? skill.content.slice(0, 4000) + '\n\n…' : skill.content;
	} else {
		contentEl.hidden = true;
	}

	const ratingEl = $('skill-modal-rating');
	if (ratingEl) {
		ratingEl.hidden = false;
		const userRating = Math.round(rating);
		const stars = [1, 2, 3, 4, 5].map((n) => {
			const active = n <= userRating ? 'active' : '';
			return `<button class="${active}" data-rating="${n}" aria-label="Rate ${n} star${n === 1 ? '' : 's'}">★</button>`;
		}).join('');
		ratingEl.innerHTML = `${stars}<span class="rating-count">${skill.rating_count || 0} rating${skill.rating_count === 1 ? '' : 's'}</span>`;
		ratingEl.querySelectorAll('[data-rating]').forEach((btn) => {
			btn.addEventListener('click', async () => {
				const n = Number(btn.dataset.rating);
				await rateSkill(skill.id, n);
			});
		});
	}

	const installBtn = $('skill-modal-install');
	installBtn.disabled = false;
	installBtn.textContent = skill.installed ? '✓ Installed (click to remove)' : 'Install';
	installBtn.dataset.skillId = skill.id;
	installBtn.dataset.installed = skill.installed ? '1' : '0';

	const authorBtn = $('skill-modal-author');
	if (skill.author?.id) {
		authorBtn.hidden = false;
		authorBtn.textContent = `View ${author}'s skills →`;
		authorBtn.onclick = () => {
			closeSkillModal();
			openCreatorModal(skill.author.id);
		};
	} else {
		authorBtn.hidden = true;
	}
}

async function toggleSkillInstall() {
	const btn = $('skill-modal-install');
	if (!btn || btn.disabled) return;
	const id = btn.dataset.skillId;
	if (!id) return;
	const wasInstalled = btn.dataset.installed === '1';
	btn.disabled = true;
	btn.textContent = wasInstalled ? 'Removing…' : 'Installing…';
	try {
		const r = await fetch(`${API}/skills/${encodeURIComponent(id)}/install`, {
			method: wasInstalled ? 'DELETE' : 'POST',
			credentials: 'include',
		});
		if (r.status === 401) {
			location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
			return;
		}
		if (!r.ok) throw new Error(`HTTP ${r.status}`);
		await openSkillModal(id);
		skillsState.loaded = false;
		loadSkillsTab(true);
	} catch (err) {
		console.error('[marketplace] skill install', err);
		btn.disabled = false;
		btn.textContent = wasInstalled ? '✓ Installed (click to remove)' : 'Install';
	}
}

async function rateSkill(id, rating) {
	try {
		const r = await fetch(`${API}/skills/${encodeURIComponent(id)}/rate`, {
			method: 'POST',
			credentials: 'include',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ rating }),
		});
		if (r.status === 401) {
			location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
			return;
		}
		if (!r.ok) throw new Error(`HTTP ${r.status}`);
		await openSkillModal(id);
	} catch (err) {
		console.error('[marketplace] skill rate', err);
	}
}


// ── My Purchases tab ─────────────────────────────────────────────────────

const purchasesState = { loaded: false, loading: false, items: [] };

async function loadPurchases(force = false) {
	if (purchasesState.loading) return;
	if (purchasesState.loaded && !force) return renderPurchasesGrid();
	purchasesState.loading = true;
	const grid = $('purchases-grid');
	if (grid) grid.innerHTML = renderSkeletons(4);
	try {
		const r = await fetch(`${API}/users/me/purchased-skills`, { credentials: 'include' });
		if (r.status === 401) {
			if (grid) grid.innerHTML = `<div class="market-empty-cta">
				<h3>Sign in to see your purchases</h3>
				<p>Your unlocked skills and trial access will appear here.</p>
				<button id="purchases-signin">Sign in</button>
			</div>`;
			$('purchases-signin')?.addEventListener('click', () => {
				location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
			});
			purchasesState.loading = false;
			return;
		}
		const j = await r.json().catch(() => ({}));
		purchasesState.items = j?.data?.purchases || [];
		purchasesState.loaded = true;
	} catch (err) {
		console.error('[marketplace] purchases load', err);
	} finally {
		purchasesState.loading = false;
	}
	renderPurchasesGrid();
}

function renderPurchasesGrid() {
	const grid = $('purchases-grid');
	const sub = $('purchases-subtitle');
	if (!grid) return;
	if (sub) {
		sub.textContent = purchasesState.items.length
			? `${purchasesState.items.length} ${purchasesState.items.length === 1 ? 'purchase' : 'purchases'}`
			: '';
	}
	if (!purchasesState.items.length) {
		grid.innerHTML = `<div class="market-empty-cta">
			<h3>No purchases yet</h3>
			<p>Skills you purchase or trial access you unlock will appear here.</p>
			<button id="purchases-browse">Browse Skills</button>
		</div>`;
		$('purchases-browse')?.addEventListener('click', () => navTo('/marketplace?tab=skills'));
		return;
	}
	grid.innerHTML = purchasesState.items.map(renderPurchaseCard).join('');
	grid.querySelectorAll('[data-purchase-agent]').forEach((card) => {
		card.addEventListener('click', (e) => {
			if (e.target.closest('.receipt-btn')) return;
			navTo(`/marketplace/agents/${card.dataset.purchaseAgent}`);
		});
	});
	grid.querySelectorAll('.receipt-btn').forEach((btn) => {
		btn.addEventListener('click', (e) => {
			e.stopPropagation();
			downloadReceipt(btn.dataset.purchaseId);
		});
	});
}

function renderPurchaseCard(p) {
	const agentName = escapeHtml(p.agent_name || 'Unknown Agent');
	const skill = escapeHtml(p.skill);
	const date = p.confirmed_at ? formatDate(p.confirmed_at) : formatDate(p.created_at);
	const chainBadge = `<span class="stat-pill">${escapeHtml(p.chain || 'solana')}</span>`;
	const isTrial = p.kind === 'trial' || p.status === 'trial';
	const kindBadge = isTrial
		? `<span class="stat-pill" style="color:#86efac">Trial${p.trial_remaining != null ? ` (${p.trial_remaining} left)` : ''}</span>`
		: `<span class="stat-pill" style="color:#ffffff">Owned</span>`;
	const hasReceipt = !isTrial;
	const thumb = p.agent_thumbnail
		? `<div class="avatar avatar-img" style="background-image:url('${escapeHtml(p.agent_thumbnail)}');width:36px;height:36px;border-radius:8px;flex-shrink:0"></div>`
		: `<div class="avatar" style="width:36px;height:36px;border-radius:8px;flex-shrink:0;display:flex;align-items:center;justify-content:center;background:#1a1a1a;font-size:16px">${escapeHtml(initial(p.agent_name || '?'))}</div>`;
	return `<div class="market-card-agent" data-purchase-agent="${escapeHtml(p.agent_id)}" style="cursor:pointer">
		<div class="head">
			${thumb}
			<div style="min-width:0;flex:1">
				<div class="title">${agentName}</div>
				<div class="author">${skill}</div>
			</div>
		</div>
		<div class="stats">
			${kindBadge}
			${chainBadge}
			<span class="stat-pill">${escapeHtml(date)}</span>
		</div>
		<div class="footer" style="justify-content:flex-end">
			${hasReceipt ? `<button class="btn-secondary receipt-btn" data-purchase-id="${escapeHtml(p.id)}" style="font-size:11px;padding:4px 10px">Receipt</button>` : ''}
			<span class="open-cta">View agent →</span>
		</div>
	</div>`;
}

async function downloadReceipt(purchaseId) {
	try {
		const r = await fetch(`${API}/billing/receipts?purchase_id=${encodeURIComponent(purchaseId)}`, { credentials: 'include' });
		if (!r.ok) {
			const j = await r.json().catch(() => ({}));
			alert(j.error_description || 'Receipt not available');
			return;
		}
		const j = await r.json();
		const blob = new Blob([JSON.stringify(j.data, null, 2)], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `receipt-${purchaseId.slice(0, 8)}.json`;
		a.click();
		URL.revokeObjectURL(url);
	} catch (err) {
		alert('Download failed: ' + err.message);
	}
}

// ── Earn tab ─────────────────────────────────────────────────────────────

const earnState = {
	loaded: false, loading: false, authFailed: false, errorMsg: null,
	pending_usd: 0, settled_usd: 0, entries: [], wallet: null,
	revBySkill: [], revTimeseries: [], revLoading: false,
	period: 30, txnVisible: 20,
};

function fmtUsd(n) {
	if (n == null || isNaN(n)) return '$0.00';
	if (n === 0) return '$0.00';
	const abs = Math.abs(n);
	if (abs < 0.01) return (n < 0 ? '-' : '') + '$' + abs.toFixed(4);
	if (abs < 1) return (n < 0 ? '-' : '') + '$' + abs.toFixed(3);
	return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function earnPeriodParams(days) {
	const to = new Date();
	if (days === 'all') return { from: new Date('2020-01-01'), to, granularity: 'month' };
	const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
	return { from, to, granularity: days <= 30 ? 'day' : 'week' };
}

function fmtChartDate(iso) {
	if (!iso) return '';
	const d = new Date(iso + (iso.length === 10 ? 'T00:00:00' : ''));
	return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

async function loadEarnTab(force = false) {
	if (earnState.loading) return;
	if (earnState.loaded && !force) { renderEarnTab(); return; }
	earnState.loading = true;
	earnState.authFailed = false;
	earnState.errorMsg = null;
	earnState.txnVisible = 20;

	const el = $('earn-content');
	if (el) el.innerHTML = renderEarnSkeleton();

	try {
		const [earningsRes, walletsRes] = await Promise.all([
			fetch(`${API}/users/earnings`, { credentials: 'include' }),
			fetch(`${API}/billing/payout-wallets`, { credentials: 'include' }),
		]);

		if (earningsRes.status === 401) {
			earnState.authFailed = true;
			earnState.loading = false;
			renderEarnTab();
			return;
		}

		if (earningsRes.ok) {
			const j = await earningsRes.json();
			earnState.pending_usd = j.pending_usd || 0;
			earnState.settled_usd = j.settled_usd || 0;
			earnState.entries = j.entries || [];
		} else {
			earnState.errorMsg = `Failed to load earnings (HTTP ${earningsRes.status})`;
		}

		if (walletsRes.ok) {
			const wj = await walletsRes.json();
			const wallets = wj.wallets || [];
			earnState.wallet = wallets.find((w) => w.is_default) || wallets[0] || null;
		}

		earnState.loaded = true;
	} catch (err) {
		console.error('[marketplace] earn tab', err);
		earnState.errorMsg = 'Network error — check your connection and try again.';
	} finally {
		earnState.loading = false;
	}
	renderEarnTab();
	loadEarnRevenue();
}

async function loadEarnRevenue() {
	if (earnState.revLoading) return;
	earnState.revLoading = true;
	const { from, to, granularity } = earnPeriodParams(earnState.period);
	try {
		const r = await fetch(
			`${API}/billing/revenue?granularity=${granularity}&from=${from.toISOString()}&to=${to.toISOString()}`,
			{ credentials: 'include' },
		);
		if (r.ok) {
			const j = await r.json();
			earnState.revBySkill = j.by_skill || [];
			earnState.revTimeseries = j.timeseries || [];
		}
	} catch (err) {
		console.error('[marketplace] revenue chart', err);
	} finally {
		earnState.revLoading = false;
	}
	renderEarnChart();
	renderEarnBreakdown();
}

function renderEarnSkeleton() {
	const cards = Array.from({ length: 4 }, () =>
		'<div class="earn-card earn-card-sk"><div class="earn-sk-line" style="width:60%;height:12px"></div><div class="earn-sk-line" style="width:40%;height:24px;margin-top:8px"></div></div>',
	).join('');
	const rows = Array.from({ length: 5 }, () =>
		'<div class="earn-txn-sk-row"><div class="earn-sk-line" style="width:30%"></div><div class="earn-sk-line" style="width:20%"></div></div>',
	).join('');
	return `<div class="earn-skeleton">
		<div class="earn-stats">${cards}</div>
		<div class="earn-chart-sk"><div class="earn-sk-block"></div></div>
		<div class="earn-txn-sk">${rows}</div>
	</div>`;
}

function renderEarnTab() {
	const el = $('earn-content');
	const sub = $('earn-subtitle');
	if (!el) return;

	if (earnState.authFailed) {
		if (sub) sub.textContent = 'Sign in to track your revenue';
		el.innerHTML = `<div class="earn-state-msg">
			<div class="earn-state-icon">$</div>
			<h3>Sign in to view earnings</h3>
			<p>Track revenue from your published agents, skills, and avatar sales.</p>
			<button class="market-mine-cta" data-action="earn-signin">Sign in</button>
		</div>`;
		return;
	}

	if (earnState.errorMsg) {
		if (sub) sub.textContent = 'Something went wrong';
		el.innerHTML = `<div class="earn-state-msg">
			<div class="earn-state-icon earn-icon-error">!</div>
			<h3>Something went wrong</h3>
			<p>${escapeHtml(earnState.errorMsg)}</p>
			<button class="market-mine-cta" data-action="earn-retry">Retry</button>
		</div>`;
		return;
	}

	if (earnState.loading) return;

	const total = earnState.pending_usd + earnState.settled_usd;
	const hasData = total > 0 || earnState.entries.length > 0;

	if (!hasData) {
		if (sub) sub.textContent = 'Get started by publishing a skill or agent';
		el.innerHTML = `<div class="earn-state-msg">
			<div class="earn-state-icon">$</div>
			<h3>No revenue yet</h3>
			<p>Publish agents or skills with prices to start earning. Revenue from purchases will appear here.</p>
			<div class="earn-empty-actions">
				<button class="market-mine-cta" data-action="earn-publish">Publish a Skill</button>
				<button class="market-btn-sec" data-action="earn-browse">Browse Marketplace</button>
			</div>
		</div>`;
		return;
	}

	if (sub) sub.textContent = `${fmtUsd(total)} total earned`;

	const walletAddr = earnState.wallet
		? (() => { const a = earnState.wallet.address; return a.length > 16 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a; })()
		: 'Not set';
	const walletTitle = earnState.wallet?.address || '';
	const walletBtnLabel = earnState.wallet ? 'Edit' : 'Set wallet';
	const pendingCount = earnState.entries.filter(e => e.status === 'pending').length;
	const settledCount = earnState.entries.filter(e => e.status === 'settled').length;

	el.innerHTML = `<div class="earn-dashboard">
		<div class="earn-stats">
			<div class="earn-card earn-card-total">
				<div class="earn-card-label">Total Earned</div>
				<div class="earn-card-value">${fmtUsd(total)}</div>
				<div class="earn-card-meta">${earnState.entries.length} transaction${earnState.entries.length !== 1 ? 's' : ''}</div>
			</div>
			<div class="earn-card">
				<div class="earn-card-label">Pending</div>
				<div class="earn-card-value earn-val-pending">${fmtUsd(earnState.pending_usd)}</div>
				<div class="earn-card-meta">${pendingCount} awaiting settlement</div>
			</div>
			<div class="earn-card">
				<div class="earn-card-label">Settled</div>
				<div class="earn-card-value earn-val-settled">${fmtUsd(earnState.settled_usd)}</div>
				<div class="earn-card-meta">${settledCount} completed</div>
			</div>
			<div class="earn-card earn-card-wallet">
				<div class="earn-card-label">Payout Wallet</div>
				<div class="earn-card-value earn-wallet-addr" title="${escapeHtml(walletTitle)}">${escapeHtml(walletAddr)}</div>
				<button class="earn-wallet-btn" data-action="earn-wallet-edit" aria-label="Edit payout wallet">${walletBtnLabel}</button>
			</div>
		</div>
		<div class="earn-chart-section">
			<div class="earn-section-header">
				<h3 class="earn-section-title">Revenue</h3>
				<div class="earn-period-chips" role="tablist" aria-label="Revenue period">
					<button class="earn-chip${earnState.period === 7 ? ' active' : ''}" data-period="7" role="tab" aria-selected="${earnState.period === 7}">7d</button>
					<button class="earn-chip${earnState.period === 30 ? ' active' : ''}" data-period="30" role="tab" aria-selected="${earnState.period === 30}">30d</button>
					<button class="earn-chip${earnState.period === 90 ? ' active' : ''}" data-period="90" role="tab" aria-selected="${earnState.period === 90}">90d</button>
					<button class="earn-chip${earnState.period === 'all' ? ' active' : ''}" data-period="all" role="tab" aria-selected="${earnState.period === 'all'}">All</button>
				</div>
			</div>
			<div class="earn-chart" id="earn-chart"><div class="earn-chart-loading">Loading revenue data…</div></div>
		</div>
		<div class="earn-breakdown-section" id="earn-breakdown-section" hidden>
			<h3 class="earn-section-title">Top Earners</h3>
			<div class="earn-breakdown" id="earn-breakdown"></div>
		</div>
		<div class="earn-txns-section">
			<div class="earn-section-header">
				<h3 class="earn-section-title">Recent Transactions</h3>
				<span class="earn-txn-count">${earnState.entries.length} total</span>
			</div>
			<div class="earn-txns" id="earn-txns"></div>
			${earnState.entries.length > earnState.txnVisible ? '<div class="earn-txns-more" id="earn-txns-more"><button class="earn-show-more" data-action="earn-more">Show more</button></div>' : ''}
		</div>
	</div>`;

	renderEarnTransactions();
}

function renderEarnChart() {
	const el = $('earn-chart');
	if (!el) return;

	if (earnState.revLoading) {
		el.innerHTML = '<div class="earn-chart-loading">Loading revenue data…</div>';
		return;
	}

	const ts = earnState.revTimeseries;
	if (!ts || !ts.length) {
		el.innerHTML = '<div class="earn-chart-empty">No revenue data for this period</div>';
		return;
	}

	const USDC_DIV = 1_000_000;
	const maxVal = Math.max(...ts.map(d => d.net_total), 1);
	const labelEvery = ts.length <= 7 ? 1 : ts.length <= 14 ? 2 : ts.length <= 30 ? 5 : 7;

	const bars = ts.map((d, i) => {
		const pct = Math.max((d.net_total / maxVal) * 100, d.net_total > 0 ? 3 : 0);
		const showLabel = i % labelEvery === 0 || i === ts.length - 1;
		const dateLabel = fmtChartDate(d.period);
		const usd = d.net_total / USDC_DIV;
		return `<div class="earn-bar" style="--h:${pct.toFixed(1)}%" title="${dateLabel}: ${fmtUsd(usd)}">
			<div class="earn-bar-col"></div>
			${showLabel ? `<span class="earn-bar-date">${escapeHtml(dateLabel)}</span>` : '<span class="earn-bar-date"></span>'}
		</div>`;
	}).join('');

	const periodTotal = ts.reduce((s, d) => s + d.net_total, 0) / USDC_DIV;
	const periodCount = ts.reduce((s, d) => s + d.count, 0);

	el.innerHTML = `<div class="earn-chart-meta">
		<span class="earn-chart-total">${fmtUsd(periodTotal)}</span>
		<span class="earn-chart-count">${periodCount} payment${periodCount !== 1 ? 's' : ''} this period</span>
	</div>
	<div class="earn-chart-bars">${bars}</div>`;
}

function renderEarnBreakdown() {
	const el = $('earn-breakdown');
	const section = $('earn-breakdown-section');
	if (!el || !section) return;

	const skills = earnState.revBySkill;
	if (!skills || !skills.length) { section.hidden = true; return; }
	section.hidden = false;

	const USDC_DIV = 1_000_000;
	const maxVal = Math.max(...skills.map(s => s.net_total), 1);

	el.innerHTML = skills.slice(0, 6).map(s => {
		const pct = (s.net_total / maxVal) * 100;
		const usd = s.net_total / USDC_DIV;
		return `<div class="earn-bk-row">
			<span class="earn-bk-name" title="${escapeHtml(s.skill || '')}">${escapeHtml(s.skill || '—')}</span>
			<div class="earn-bk-track"><div class="earn-bk-fill" style="width:${pct.toFixed(1)}%"></div></div>
			<span class="earn-bk-amount">${fmtUsd(usd)}</span>
			<span class="earn-bk-count">${s.count}×</span>
		</div>`;
	}).join('');
}

function renderEarnTransactions() {
	const el = $('earn-txns');
	if (!el) return;

	const visible = earnState.entries.slice(0, earnState.txnVisible);
	if (!visible.length) { el.innerHTML = ''; return; }

	const kindIcons = { skill: '≡', avatar: '◉', agent: '▣' };
	const kindColors = { skill: '#60a5fa', avatar: '#a78bfa', agent: '#34d399' };

	el.innerHTML = visible.map(e => {
		const icon = kindIcons[e.kind] || '·';
		const color = kindColors[e.kind] || 'var(--mk-text-3)';
		const statusCls = e.status === 'settled' ? 'earn-status-settled' : 'earn-status-pending';
		const date = e.created_at ? formatDate(e.created_at) : '';
		return `<div class="earn-txn">
			<div class="earn-txn-icon" style="color:${color}" aria-hidden="true">${icon}</div>
			<div class="earn-txn-info">
				<span class="earn-txn-name">${escapeHtml(e.skill_name || e.skill || '—')}</span>
				${e.agent_name ? `<span class="earn-txn-agent">${escapeHtml(e.agent_name)}</span>` : ''}
			</div>
			<div class="earn-txn-right">
				<span class="earn-txn-amount">${fmtUsd(e.price_usd)}</span>
				<span class="earn-txn-status ${statusCls}">${escapeHtml(e.status || '')}</span>
				<span class="earn-txn-date">${escapeHtml(date)}</span>
			</div>
		</div>`;
	}).join('');

	const moreEl = $('earn-txns-more');
	if (moreEl) moreEl.hidden = earnState.entries.length <= earnState.txnVisible;
}

function openPublishSkillModal() {
	const overlay = $('skill-publish-overlay');
	if (!overlay) return;
	$('sp-name').value = '';
	$('sp-description').value = '';
	$('sp-category').value = 'general';
	$('sp-price').value = '0';
	$('sp-tags').value = '';
	$('sp-schema').value = '';
	const errEl = $('skill-publish-error');
	if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
	overlay.hidden = false;
	$('sp-name').focus();
}

function closePublishSkillModal() {
	const overlay = $('skill-publish-overlay');
	if (overlay) overlay.hidden = true;
}

function openWalletSetupModal() {
	const overlay = $('wallet-setup-overlay');
	if (!overlay) return;
	$('ws-address').value = earnState.wallet?.address || '';
	$('ws-chain').value = earnState.wallet?.chain || 'solana';
	const errEl = $('wallet-setup-error');
	if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
	overlay.hidden = false;
	$('ws-address').focus();
}

function closeWalletSetupModal() {
	const overlay = $('wallet-setup-overlay');
	if (overlay) overlay.hidden = true;
}

function bindEarnTab() {
	$('earn-publish-skill-btn')?.addEventListener('click', openPublishSkillModal);

	const earnContent = $('earn-content');
	if (earnContent) {
		earnContent.addEventListener('click', (e) => {
			const chip = e.target.closest('[data-period]');
			if (chip) {
				const p = chip.dataset.period === 'all' ? 'all' : parseInt(chip.dataset.period, 10);
				if (p === earnState.period) return;
				earnState.period = p;
				earnContent.querySelectorAll('.earn-chip').forEach(c => {
					const on = c.dataset.period === String(p);
					c.classList.toggle('active', on);
					c.setAttribute('aria-selected', on);
				});
				loadEarnRevenue();
				return;
			}
			const btn = e.target.closest('[data-action]');
			if (!btn) return;
			const act = btn.dataset.action;
			if (act === 'earn-signin') location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
			else if (act === 'earn-retry') { earnState.loaded = false; loadEarnTab(true); }
			else if (act === 'earn-publish') openPublishSkillModal();
			else if (act === 'earn-browse') navTo('/marketplace');
			else if (act === 'earn-wallet-edit') openWalletSetupModal();
			else if (act === 'earn-more') { earnState.txnVisible += 20; renderEarnTransactions(); }
		});
	}

	// Close wallet modal
	$('wallet-setup-close')?.addEventListener('click', closeWalletSetupModal);
	$('wallet-setup-overlay')?.addEventListener('click', (e) => {
		if (e.target === $('wallet-setup-overlay')) closeWalletSetupModal();
	});

	// Save wallet
	$('ws-save')?.addEventListener('click', async () => {
		const address = ($('ws-address')?.value || '').trim();
		const chain = $('ws-chain')?.value || 'solana';
		const errEl = $('wallet-setup-error');
		if (!address) {
			if (errEl) { errEl.textContent = 'Address is required.'; errEl.hidden = false; }
			return;
		}
		const btn = $('ws-save');
		if (btn) btn.disabled = true;
		try {
			const r = await fetch(`${API}/billing/payout-wallets`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify({ address, chain, is_default: true }),
			});
			const j = await r.json();
			if (!r.ok) throw new Error(j.error_description || j.error || `HTTP ${r.status}`);
			earnState.wallet = j.wallet;
			earnState.loaded = false;
			closeWalletSetupModal();
			loadEarnTab(true);
		} catch (err) {
			if (errEl) { errEl.textContent = err.message; errEl.hidden = false; }
		} finally {
			if (btn) btn.disabled = false;
		}
	});

	// Close publish skill modal
	$('skill-publish-close')?.addEventListener('click', closePublishSkillModal);
	$('skill-publish-overlay')?.addEventListener('click', (e) => {
		if (e.target === $('skill-publish-overlay')) closePublishSkillModal();
	});

	// Publish skill submit
	$('sp-publish')?.addEventListener('click', async () => {
		const name = ($('sp-name')?.value || '').trim();
		const description = ($('sp-description')?.value || '').trim();
		const category = $('sp-category')?.value || 'general';
		const price_per_call_usd = parseFloat($('sp-price')?.value || '0') || 0;
		const tags = ($('sp-tags')?.value || '').split(',').map((t) => t.trim()).filter(Boolean);
		const schemaRaw = ($('sp-schema')?.value || '').trim();
		const errEl = $('skill-publish-error');

		if (!name) {
			if (errEl) { errEl.textContent = 'Name is required.'; errEl.hidden = false; }
			return;
		}
		if (!description) {
			if (errEl) { errEl.textContent = 'Description is required.'; errEl.hidden = false; }
			return;
		}

		let schema_json = null;
		if (schemaRaw) {
			try {
				schema_json = JSON.parse(schemaRaw);
			} catch {
				if (errEl) { errEl.textContent = 'Tool definitions must be valid JSON.'; errEl.hidden = false; }
				return;
			}
		}

		if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
		const btn = $('sp-publish');
		if (btn) { btn.disabled = true; btn.textContent = 'Publishing…'; }

		try {
			const r = await fetch(`${API}/skills`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify({ name, description, category, tags, schema_json, is_public: true, price_per_call_usd }),
			});
			const j = await r.json();
			if (!r.ok) throw new Error(j.error_description || j.error || `HTTP ${r.status}`);
			closePublishSkillModal();
			// Reload skills tab cache
			skillsState.skills = [];
			skillsState.loaded = false;
			earnState.loaded = false;
		} catch (err) {
			if (errEl) { errEl.textContent = err.message; errEl.hidden = false; }
		} finally {
			if (btn) { btn.disabled = false; btn.textContent = 'Publish Skill'; }
		}
	});

	// skills-empty-publish — should open skill modal, not agent modal
	document.addEventListener('click', (e) => {
		if (e.target?.id === 'skills-empty-publish') {
			e.stopPropagation();
			openPublishSkillModal();
		}
	});
}

// ── Agent Pricing Modal ───────────────────────────────────────────────────

const agentPricingState = { agentId: null, agentName: '', rows: [] };

function openAgentPricingModal(agentId, agentName) {
	const overlay = $('agent-pricing-overlay');
	if (!overlay) return;
	agentPricingState.agentId = agentId;
	agentPricingState.agentName = agentName;
	agentPricingState.rows = [];
	$('agent-pricing-title').textContent = `Set Skill Prices`;
	$('agent-pricing-hint').textContent = `Prices for "${agentName}". Leave a price blank or 0 to keep it free.`;
	$('ap-new-skill').value = '';
	const errEl = $('agent-pricing-error');
	if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
	overlay.hidden = false;
	renderAgentPricingRows();

	// Load existing prices
	fetch(`${API}/marketplace/agents/${encodeURIComponent(agentId)}`, { credentials: 'include' })
		.then((r) => r.json())
		.then((j) => {
			const prices = j.data?.agent?.skill_prices || {};
			agentPricingState.rows = Object.entries(prices).map(([skill, p]) => ({
				skill,
				amount_usd: (Number(p.amount || 0) / 1e6).toFixed(2),
			}));
			renderAgentPricingRows();
		})
		.catch(() => {});
}

function closeAgentPricingModal() {
	const overlay = $('agent-pricing-overlay');
	if (overlay) overlay.hidden = true;
	agentPricingState.agentId = null;
}

function renderAgentPricingRows() {
	const container = $('agent-pricing-rows');
	if (!container) return;
	if (!agentPricingState.rows.length) {
		container.innerHTML = '<div style="color:#71717a;font-size:0.85rem;margin-bottom:0.5rem">No skills yet — add one below.</div>';
		return;
	}
	container.innerHTML = agentPricingState.rows.map((row, i) => `
		<div class="agent-pricing-row" data-row="${i}">
			<span class="ap-skill-name">${escapeHtml(row.skill)}</span>
			<input class="ap-price-input" type="number" min="0" max="100" step="0.01"
				value="${escapeHtml(String(row.amount_usd))}" placeholder="0.00"
				data-row="${i}" />
			<span class="ap-unit">USDC</span>
			<button class="ap-remove" data-row="${i}" title="Remove">×</button>
		</div>
	`).join('');

	container.querySelectorAll('.ap-price-input').forEach((inp) => {
		inp.addEventListener('input', () => {
			const i = Number(inp.dataset.row);
			if (agentPricingState.rows[i]) agentPricingState.rows[i].amount_usd = inp.value;
		});
	});
	container.querySelectorAll('.ap-remove').forEach((btn) => {
		btn.addEventListener('click', () => {
			const i = Number(btn.dataset.row);
			agentPricingState.rows.splice(i, 1);
			renderAgentPricingRows();
		});
	});
}

function bindAgentPricingModal() {
	$('agent-pricing-close')?.addEventListener('click', closeAgentPricingModal);
	$('agent-pricing-overlay')?.addEventListener('click', (e) => {
		if (e.target === $('agent-pricing-overlay')) closeAgentPricingModal();
	});

	$('ap-add-skill')?.addEventListener('click', () => {
		const inp = $('ap-new-skill');
		const skill = (inp?.value || '').trim().toLowerCase().replace(/\s+/g, '-');
		if (!skill) return;
		if (agentPricingState.rows.some((r) => r.skill === skill)) {
			inp.value = '';
			return;
		}
		agentPricingState.rows.push({ skill, amount_usd: '0.00' });
		inp.value = '';
		renderAgentPricingRows();
	});

	$('ap-new-skill')?.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') { e.preventDefault(); $('ap-add-skill')?.click(); }
	});

	$('ap-save')?.addEventListener('click', async () => {
		const { agentId, rows } = agentPricingState;
		if (!agentId) return;
		const errEl = $('agent-pricing-error');
		if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
		const btn = $('ap-save');
		if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

		try {
			await Promise.all(rows.map(async (row) => {
				const amount = Math.round(parseFloat(row.amount_usd || '0') * 1e6);
				const r = await fetch(`${API}/marketplace/set-skill-price`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					credentials: 'include',
					body: JSON.stringify({
						agent_id: agentId,
						skill: row.skill,
						amount,
						currency_mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
						chain: 'solana',
					}),
				});
				if (!r.ok) {
					const j = await r.json().catch(() => ({}));
					throw new Error(j.error_description || `Failed for skill "${row.skill}"`);
				}
			}));
			closeAgentPricingModal();
			mineState.loaded = false;
			loadMine(true);
		} catch (err) {
			if (errEl) { errEl.textContent = err.message; errEl.hidden = false; }
		} finally {
			if (btn) { btn.disabled = false; btn.textContent = 'Save Prices'; }
		}
	});
}

// ── My Agents tab ────────────────────────────────────────────────────────

const mineState = { loaded: false, loading: false, items: [] };

async function loadMine(force = false) {
	if (mineState.loading) return;
	if (mineState.loaded && !force) return renderMineGrid();
	mineState.loading = true;
	const grid = $('mine-grid');
	if (grid) grid.innerHTML = renderSkeletons(4);
	try {
		const r = await fetch(`${API}/marketplace/agents/mine`, { credentials: 'include' });
		if (r.status === 401) {
			grid.innerHTML = `<div class="market-empty-cta">
					<h3>Sign in to see your agents</h3>
					<p>Your published and draft agents will appear here.</p>
					<button id="mine-signin">Sign in</button>
				</div>`;
			$('mine-signin')?.addEventListener('click', () => {
				location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
			});
			mineState.loading = false;
			return;
		}
		const j = await r.json().catch(() => ({}));
		mineState.items = Array.isArray(j) ? j : (j?.data?.items ?? []);
		mineState.loaded = true;
	} catch (err) {
		console.error('[marketplace] mine', err);
	} finally {
		mineState.loading = false;
	}
	renderMineGrid();
}

function renderMineGrid() {
	const grid = $('mine-grid');
	const sub = $('mine-subtitle');
	if (!grid) return;
	if (sub) {
		sub.textContent = mineState.items.length
			? `${mineState.items.length} ${mineState.items.length === 1 ? 'agent' : 'agents'}`
			: '';
	}
	if (!mineState.items.length) {
		grid.innerHTML = `<div class="market-empty-cta">
				<h3>No agents yet</h3>
				<p>Create your first agent — it'll appear here as draft, then publish when you're ready.</p>
				<button id="mine-empty-new">+ New Agent</button>
			</div>`;
		$('mine-empty-new')?.addEventListener('click', () => {
			location.href = '/agent/new';
		});
		return;
	}
	grid.innerHTML = mineState.items.map(renderCard).join('');
	grid.querySelectorAll('[data-id]').forEach((card) => {
		card.addEventListener('click', () => navTo(`/marketplace/agents/${card.dataset.id}`));
	});
}

function renderSkeletons(n) {
	const cards = Array.from({ length: n }, () =>
		`<div class="market-card-skeleton"><div class="sk-thumb"></div><div class="sk-line"></div><div class="sk-line short"></div></div>`,
	).join('');
	return cards;
}

// Empty-state block with a recovery action — when the grid is empty we want
// the user to be able to escape the dead-end with one click (clear the search,
// drop the filter, or submit/create their own content).
function renderEmptyState() {
	const hasSearch = !!state.q;
	const hasTag = !!state.tag;
	const hasCategory = !!state.category;
	const hasFilter = state.filter && state.filter !== 'all';

	let title;
	let body;
	const actions = [];

	if (hasSearch || hasTag || hasCategory) {
		title = 'No matches';
		const bits = [];
		if (hasSearch) bits.push(`"${escapeHtml(state.q)}"`);
		if (hasTag) bits.push(`tag ${escapeHtml(state.tag)}`);
		if (hasCategory) bits.push(`category ${escapeHtml(state.category)}`);
		body = `Nothing matched ${bits.join(' · ')}. Try a different term or clear the filters.`;
		actions.push({ id: 'empty-clear-filters', label: 'Clear filters', primary: true });
	} else if (state.filter === 'agents') {
		title = 'No agents published yet';
		body = 'Be the first to share an agent with the community.';
		actions.push({ id: 'empty-submit-agent', label: '+ Submit Agent', primary: true });
	} else if (state.filter === 'avatars') {
		title = 'No public avatars';
		body = 'Create a 3D avatar and publish it for others to use.';
		actions.push({ id: 'empty-create-avatar', label: '+ Create Avatar', primary: true });
	} else if (state.filter === 'onchain') {
		title = 'No onchain agents';
		body = 'No ERC-8004 agents match your current filters.';
		actions.push({ id: 'empty-clear-filters', label: 'Clear filters', primary: true });
	} else {
		title = 'Nothing here yet';
		body = 'Publish an agent or upload an avatar to start the catalog.';
		actions.push({ id: 'empty-submit-agent', label: '+ Submit Agent', primary: true });
		actions.push({ id: 'empty-create-avatar', label: '+ Create Avatar', primary: false });
	}

	const buttons = actions
		.map(
			(a) =>
				`<button type="button" class="market-empty-cta-btn${a.primary ? ' primary' : ''}" data-empty-action="${a.id}">${escapeHtml(a.label)}</button>`,
		)
		.join('');

	return `
		<div class="market-empty-cta" role="status">
			<h3>${escapeHtml(title)}</h3>
			<p>${body}</p>
			<div class="market-empty-cta-actions">${buttons}</div>
		</div>`;
}

// Error state with a retry CTA. Shown when an API call rejects so the user
// can recover without manually refreshing the page.
function renderErrorState(scope = 'agents') {
	const label = scope === 'avatars' ? 'avatars' : scope === 'onchain' ? 'onchain agents' : 'agents';
	return `
		<div class="market-empty-cta" role="alert">
			<h3>Couldn't load ${escapeHtml(label)}</h3>
			<p>The marketplace server didn't respond. Check your connection and try again.</p>
			<div class="market-empty-cta-actions">
				<button type="button" class="market-empty-cta-btn primary" data-empty-action="empty-retry" data-retry-scope="${escapeHtml(scope)}">Retry</button>
			</div>
		</div>`;
}

// Single delegated click handler so empty-state buttons keep working across
// re-renders (els.grid is innerHTML-replaced on every renderGrid).
function bindEmptyStateActions() {
	if (!els.grid || els.grid.dataset.emptyBound) return;
	els.grid.dataset.emptyBound = '1';
	els.grid.addEventListener('click', (e) => {
		const btn = e.target.closest('[data-empty-action]');
		if (!btn) return;
		const action = btn.dataset.emptyAction;
		if (action === 'empty-clear-filters') {
			state.q = '';
			state.tag = null;
			state.category = null;
			state.filter = 'all';
			const search = $('market-search');
			if (search) search.value = '';
			document.querySelectorAll('.market-chip[data-filter]').forEach((c) => {
				const isActive = c.dataset.filter === 'all';
				c.classList.toggle('active', isActive);
				c.setAttribute('aria-selected', isActive ? 'true' : 'false');
			});
			const hero = $('market-hero');
			if (hero && state.featured.length) {
				hero.hidden = false;
				startHeroAutoplay();
			}
			// Drop ?tab=, ?q=, ?tag= from the URL so the cleared state survives
			// refresh and the back button restores whatever the user came from.
			navTo('/marketplace');
			state.publicAvatarsLoaded = false;
			state.onchainLoaded = false;
			loadList(true);
			loadPublicAvatars();
			loadOnchainAgents(true);
		} else if (action === 'empty-submit-agent') {
			openSubmitModal();
		} else if (action === 'empty-create-avatar') {
			// /create is a separate page, not an SPA route on marketplace — use a
			// real navigation so the browser actually loads the avatar builder.
			location.href = '/create';
		} else if (action === 'empty-retry') {
			const scope = btn.dataset.retryScope || 'agents';
			els.grid.innerHTML = '<div class="market-empty">Retrying…</div>';
			if (scope === 'avatars') {
				state.publicAvatarsLoaded = false;
				loadPublicAvatars();
			} else if (scope === 'onchain') {
				state.onchainLoaded = false;
				loadOnchainAgents(true);
			} else {
				loadList(true);
			}
		}
	});
}

// Name-initial placeholder rendered behind every model-viewer preview. Stays
// visible until model-viewer loads (then faded out via .mv-loaded), so cards
// and the hero never show a blank black void while GLBs stream in.
function placeholderHtml(name) {
	const i = escapeHtml(initial(name || 'A'));
	return `<div class="mv-placeholder" aria-hidden="true"><span class="mv-placeholder-initial">${i}</span></div>`;
}

function renderAvatarCard(a, spotlight = false) {
	const name = escapeHtml(a.name || 'Untitled avatar');
	const desc = escapeHtml(a.description || '');
	const when = a.createdAt ? liveTime(a.createdAt) : '';
	const author = a.author;
	const authorLine = author?.profileUrl
		? `<a class="card-author" href="${escapeHtml(author.profileUrl)}" rel="author">${escapeHtml(author.displayName || author.handle)}</a>`
		: author?.handle
			? `<span class="card-author">${escapeHtml(author.displayName || author.handle)}</span>`
			: `<span class="card-author muted">Anonymous</span>`;
	const tags = (a.tags || []).slice(0, 3);
	const tagPills = tags.length
		? `<div class="card-tags">${tags.map((t) => `<button type="button" class="tag-pill" data-tag="${escapeHtml(t)}" title="Filter by ${escapeHtml(t)}">${escapeHtml(t)}</button>`).join('')}</div>`
		: '';
	// Lazy GLB load: don't set `src` until the card scrolls into view (handled
	// by observeCardModelViewers below). Each <model-viewer> instance still
	// allocates a WebGL context, so we also stash the URL in `data-src` and
	// the observer promotes it to `src` on intersect — no GLB download, no
	// scene parse, no animation loop until the card is actually on screen.
	// reveal="auto" (default) means model-viewer un-veils the model on load;
	// no explicit dismissPoster() call needed.
	const preview = a.image
		? `<img src="${escapeHtml(a.image)}" alt="${name}" loading="lazy" decoding="async" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'card-img-fallback'}))" />`
		: a.glbUrl
			? `${placeholderHtml(a.name)}<model-viewer
					data-src="${escapeHtml(a.glbUrl)}"
					alt="${name}"
					autoplay
					rotation-per-second="14deg"
					interaction-prompt="none"
					disable-zoom
					disable-pan
					disable-tap
					exposure="1"
					shadow-intensity="0.4"
					tone-mapping="aces"
					loading="lazy"
				></model-viewer>`
			: `<div class="thumb-fallback"><span class="thumb-fallback-initial">${escapeHtml(initial(a.name))}</span></div>`;
	const isSpotlight = spotlight || a.featured;
	const spotlightBadge = isSpotlight ? '<span class="card-featured-badge" title="Featured">⭐</span>' : '';
	const bmActive = getAvatarBookmarks().has(a.avatarId || '');
	const priceBadge = priceBadgeHtml(a.price);
	const cardClasses = ['market-card-avatar', isSpotlight && 'market-card-avatar--featured'].filter(Boolean).join(' ');
	return `<div class="${cardClasses}" data-avatar-id="${escapeHtml(a.avatarId || '')}">
		<div class="thumb">${spotlightBadge}${priceBadge}${preview}</div>
		<div class="body">
			<div class="title-row">
				<div class="title">${name}</div>
				<button type="button" class="card-heart${bmActive ? ' active' : ''}" data-bm-id="${escapeHtml(a.avatarId||'')}" aria-label="Bookmark" aria-pressed="${bmActive}">♥</button>
			</div>
			<div class="byline">${authorLine}${when ? `<span class="dot">·</span><span class="when">${escapeHtml(when)}</span>` : ''}</div>
			${desc ? `<div class="desc">${desc}</div>` : ''}
			${tagPills}
			<div class="footer">
				<span class="avatar-pill">3D Avatar</span>
				<span class="open-cta">Open →</span>
			</div>
		</div>
	</div>`;
}

function renderCard(a) {
	const published = a.published_at || a.published || a.created_at;
	const date = published ? formatDate(published) : '';
	const skillsCount = (a.skills || []).length;
	const author = a.author_name || a.author || 'Anonymous';
	const forks = a.forks_count ?? a.forks ?? 0;
	const buyers = a.buyers_total ?? 0;
	const buyers24h = a.buyers_24h ?? 0;
	const paid = a.has_paid_skills || Object.keys(a.skill_prices || {}).length > 0;
	const priceBadge = priceBadgeHtml(a.price);
	const skillPriceBadge = skillPriceBadgeHtml(a.skill_prices);
	const ratingAvg = Number(a.rating_avg || 0);
	const ratingCount = Number(a.rating_count || 0);
	const avatarBlock = a.thumbnail_url
		? `<div class="avatar avatar-img" style="background-image:url('${escapeHtml(a.thumbnail_url)}')"></div>`
		: `<div class="avatar">${escapeHtml(initial(a.name))}</div>`;
	// Preview strip: 3D model-viewer when the agent has a linked public avatar
	// GLB, static thumbnail when only an image is available, placeholder otherwise.
	const previewStrip = a.avatar_glb_url
		? `<div class="thumb">${placeholderHtml(a.name)}<model-viewer
				data-src="${escapeHtml(a.avatar_glb_url)}"
				alt="${escapeHtml(a.name || 'Agent')}"
				${a.thumbnail_url ? `poster="${escapeHtml(a.thumbnail_url)}"` : ''}
				autoplay
				rotation-per-second="14deg"
				interaction-prompt="none"
				disable-zoom
				disable-pan
				disable-tap
				exposure="1"
				shadow-intensity="0.4"
				tone-mapping="aces"
				loading="lazy"
			></model-viewer></div>`
		: a.thumbnail_url
			? `<div class="thumb" style="background:url('${escapeHtml(a.thumbnail_url)}') center/cover no-repeat #0a0a0d"></div>`
			: `<div class="thumb">${placeholderHtml(a.name)}</div>`;
	const bmOn = bookmarkedAgents.has(a.id);
	const starBtn = `<button type="button" class="card-star${bmOn ? ' on' : ''}" data-agent-bm="${escapeHtml(a.id)}" aria-label="Bookmark agent" aria-pressed="${bmOn}" title="${bmOn ? 'Remove bookmark' : 'Bookmark agent'}">${bmOn ? '★' : '☆'}</button>`;
	return `<div class="market-card-agent" data-id="${a.id}">
		${previewStrip}
		${priceBadge}
		${starBtn}
		<div class="head">
			${avatarBlock}
			<div style="min-width:0;flex:1">
				<div class="title">${escapeHtml(a.name || 'Untitled')}</div>
				<div class="author">${escapeHtml(author)}</div>
			</div>
		</div>
		<div class="desc">${escapeHtml(a.description || '')}</div>
		<div class="stats">
			<span class="stat-pill">⊙ ${fmtNumber(views)}</span>
			<span class="stat-pill">⑂ ${fmtNumber(forks)}</span>
			${skillsCount ? `<span class="stat-pill">▤ ${skillsCount}</span>` : ''}
			${ratingCount > 0 ? `<span class="rating" title="${ratingAvg.toFixed(2)} avg from ${ratingCount} review${ratingCount === 1 ? '' : 's'}">★ ${ratingAvg.toFixed(1)} <span class="count">(${fmtNumber(ratingCount)})</span></span>` : ''}
			${buyers > 0 ? `<span class="stat-pill" title="${buyers} confirmed purchase${buyers === 1 ? '' : 's'}${buyers24h ? `, ${buyers24h} in last 24h` : ''}">$ ${fmtNumber(buyers)}${buyers24h > 0 ? ` <em>(+${buyers24h}/24h)</em>` : ''}</span>` : ''}
			${skillPriceBadge}
			${!skillPriceBadge && paid ? `<span class="stat-pill paid-badge">$ Paid</span>` : ''}
		</div>
		<div class="footer">
			<span>${date}</span>
			<span class="cat-pill">${CATEGORY_LABELS[a.category] || a.category || ''}</span>
		</div>
	</div>`;
}

// ERC-8004 onchain agents — rendered as cards with chain badges, link to viewer.
function renderOnchainCard(a) {
	const name = escapeHtml(a.name || `Agent #${a.agentId}`);
	const desc = escapeHtml(a.description || '');
	const when = a.registeredAt ? liveTime(a.registeredAt) : '';
	const chain = escapeHtml(a.chainShortName || a.chainName || `Chain ${a.chainId}`);
	const ownerShort = a.ownerShort || '';
	const x402 = a.x402Support ? `<span class="onchain-x402" title="Accepts x402 micropayments">x402</span>` : '';
	const href = a.viewerUrl || a.tokenExplorerUrl || '#';
	const priceBadge = priceBadgeHtml(a.price);
	const preview = a.image
		? `<img src="${escapeHtml(a.image)}" alt="${name}" loading="lazy" decoding="async" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'card-img-fallback'}))" />`
		: a.glbUrl
			? `${placeholderHtml(a.name)}<model-viewer
					data-src="${escapeHtml(a.glbUrl)}"
					alt="${name}"
					autoplay
					rotation-per-second="14deg"
					interaction-prompt="none"
					disable-zoom
					disable-pan
					disable-tap
					exposure="1"
					shadow-intensity="0.4"
					tone-mapping="aces"
					loading="lazy"
					reveal="auto"
				></model-viewer>`
			: `<div class="thumb-fallback"><span class="thumb-fallback-initial">${escapeHtml(initial(a.name))}</span></div>`;
	return `<div class="market-card-avatar onchain" data-onchain-href="${escapeHtml(href)}">
		<div class="thumb">${priceBadge}${preview}</div>
		<div class="body">
			<div class="title">${name}</div>
			<div class="byline">
				<span class="card-chain">${chain}</span>
				${ownerShort ? `<span class="dot">·</span><span class="card-author muted">${escapeHtml(ownerShort)}</span>` : ''}
				${when ? `<span class="dot">·</span><span class="when">${escapeHtml(when)}</span>` : ''}
			</div>
			${desc ? `<div class="desc">${desc}</div>` : ''}
			<div class="footer">
				<span class="avatar-pill onchain">ERC-8004</span>
				<span class="open-cta">${x402 || 'View →'}</span>
			</div>
		</div>
	</div>`;
}

// ── Detail view ───────────────────────────────────────────────────────────

let detailState = null;

async function loadDetail(id) {
	els.discovery.hidden = true;
	els.detail.hidden = false;
	els.detail.scrollIntoView({ behavior: 'instant', block: 'start' });

	// Optimistically render from cached list item if available, then refresh from API.
	const cached = state.items.find((item) => item.id === id);
	if (cached) {
		detailState = { agent: cached, bookmarked: false };
		renderDetail(cached, false);
	} else {
		renderDetailError('Loading…');
	}

	try {
		const r = await fetch(`${API}/marketplace/agents/${id}`, { credentials: 'include' });
		if (!r.ok) {
			if (!cached) renderDetailError('Agent not found');
			return;
		}
		const j = await r.json();
		const agent = j?.data?.agent;
		if (!agent) {
			if (!cached) renderDetailError('Agent not found');
			return;
		}
		detailState = { agent, bookmarked: !!agent.bookmarked };
		renderDetail(agent, !!agent.bookmarked);
		loadReviews(id);
		loadReputation(id);

		// Versions + similar (best-effort).
		Promise.all([
			fetch(`${API}/marketplace/agents/${id}/versions`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
			fetch(`${API}/marketplace/agents/${id}/similar`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
		]).then(([versionsRes, similarRes]) => {
			const versions = versionsRes?.data?.items || versionsRes?.data?.versions || [];
			renderVersions(versions);
			const similar = similarRes?.data?.items || similarRes?.data?.similar || [];
			renderSimilar(similar);
		}).catch(() => { /* best-effort — main detail already rendered */ });
	} catch (err) {
		console.error('[marketplace] detail load', err);
		if (!cached) renderDetailError('Failed to load agent.');
	}
}

// ── Avatar deep-link detail ───────────────────────────────────────────────

/** Normalise the /api/avatars/:id response shape to the explore-API shape. */
function _normaliseAvatar(a) {
	return {
		avatarId:    a.id    || a.avatarId    || '',
		slug:        a.slug  || null,
		name:        a.name  || 'Untitled avatar',
		description: a.description || '',
		glbUrl:      a.model_url   || a.url     || a.glbUrl   || a.glb_url   || '',
		image:       a.thumbnail_url || a.image || null,
		tags:        Array.isArray(a.tags) ? a.tags : [],
		author:      a.author || null,
		createdAt:   a.created_at  || a.createdAt || null,
		viewCount:   Number(a.view_count || a.viewCount || 0),
		featured:    a.featured || false,
		viewerUrl:   a.viewerUrl || null,
	};
}

let _avatarDetailId = null;
let _avatarDetailMv = null;

// Defaults for restoring social meta when leaving an avatar detail view.
const _socialMetaDefaults = {
	title:       'Agent Marketplace · three.ws',
	description: 'Discover, fork, and chat with community-published AI agents.',
	url:         'https://three.ws/marketplace',
	image:       'https://three.ws/og-image.png',
};

// Update <title>, meta[name=description], and the og:* / twitter:* tags so the
// avatar detail page previews correctly when pasted into chats and crawlers.
function setSocialMeta({ title, description, url, image }) {
	if (title) document.title = title;
	const set = (selector, value) => {
		if (value == null) return;
		const el = document.querySelector(selector);
		if (el) el.setAttribute('content', value);
	};
	set('meta[name="description"]',         description);
	set('meta[property="og:title"]',        title);
	set('meta[property="og:description"]',  description);
	set('meta[property="og:url"]',          url);
	set('meta[property="og:image"]',        image);
	set('meta[name="twitter:title"]',       title);
	set('meta[name="twitter:description"]', description);
	set('meta[name="twitter:image"]',       image);
}

function resetSocialMeta() { setSocialMeta(_socialMetaDefaults); }

function _renderAvatarDetailEmpty() {
	const stage    = $('avatar-detail-stage');
	const emptyEl  = $('avatar-detail-empty');
	const loadWrap = $('avatar-detail-load-wrap');
	if (stage)    stage.classList.add('is-empty');
	if (loadWrap) loadWrap.hidden = true;
	if (emptyEl)  emptyEl.hidden = false;
	$('avatar-detail-name').textContent = 'Avatar not found';
	$('avatar-detail-desc').textContent = '';
	$('avatar-detail-author').innerHTML = '';
	$('avatar-detail-pills').innerHTML  = '';
	// Hide the action column entirely — no fake CTAs pointing at "#".
	const actions = document.querySelector('.market-avatar-detail-actions');
	if (actions) actions.hidden = true;
	const similarWrap = $('avatar-detail-similar-wrap');
	if (similarWrap) similarWrap.hidden = true;
	setSocialMeta({
		title:       'Avatar not found · three.ws',
		description: 'This avatar may have been removed or the link is wrong.',
		url:         location.origin + location.pathname,
		image:       _socialMetaDefaults.image,
	});
}

async function loadAvatarDetail(id) {
	if (_avatarDetailId === id) return;  // already rendered for this ID

	// Reset stage. Note: we intentionally do NOT set `_avatarDetailId = id`
	// here — only after a successful render, so a transient fetch failure
	// doesn't cache an empty state and block retries.
	const stage = $('avatar-detail-stage');
	const bar   = $('avatar-detail-load-bar');
	const wrap  = $('avatar-detail-load-wrap');
	const empty = $('avatar-detail-empty');
	const actions = document.querySelector('.market-avatar-detail-actions');
	if (stage) {
		if (_avatarDetailMv) { try { _avatarDetailMv.src = ''; } catch {} }
		stage.querySelectorAll('model-viewer').forEach((el) => el.remove());
		stage.classList.remove('mv-ready', 'is-empty');
		if (bar)  bar.style.width = '0%';
		if (wrap) { wrap.hidden = false; wrap.style.opacity = '1'; }
		if (empty) empty.hidden = true;
	}
	if (actions) actions.hidden = false;

	$('avatar-detail-name').textContent  = 'Loading…';
	$('avatar-detail-desc').textContent  = '';
	$('avatar-detail-author').innerHTML  = '';
	$('avatar-detail-pills').innerHTML   = '';
	const similarWrap = $('avatar-detail-similar-wrap');
	if (similarWrap) similarWrap.hidden = true;

	// Try the loaded list first (instant if user browsed there), then fetch.
	let avatar = state.publicAvatars.find((a) => a.avatarId === id || a.slug === id);
	if (!avatar) {
		try {
			const r = await fetch(`${API}/avatars/${encodeURIComponent(id)}`);
			if (r.ok) {
				const j = await r.json();
				avatar = _normaliseAvatar(j?.avatar || j?.data?.avatar || j);
			}
		} catch (err) {
			console.error('[marketplace] avatar detail fetch', err);
		}
	}

	if (!avatar?.glbUrl) {
		_renderAvatarDetailEmpty();
		return;  // don't cache id — let the user retry by navigating again
	}

	// Populate meta.
	$('avatar-detail-name').textContent = avatar.name || 'Untitled avatar';
	$('avatar-detail-desc').textContent = avatar.description || 'A 3D avatar published to the community.';

	const authorEl = $('avatar-detail-author');
	if (avatar.author?.handle) {
		authorEl.innerHTML = avatar.author.profileUrl
			? `by <a href="${escapeHtml(avatar.author.profileUrl)}" rel="author">${escapeHtml(avatar.author.displayName || avatar.author.handle)}</a>`
			: `by ${escapeHtml(avatar.author.displayName || avatar.author.handle)}`;
	}

	// Tag chips lead so the user reads what the avatar is *about* first; the
	// "3D · GLB" technical chip and view/recency stats follow.
	const pillsEl = $('avatar-detail-pills');
	const pills = [];
	(avatar.tags || []).forEach((t) => {
		pills.push(`<button type="button" class="stat-pill tag-pill" data-tag="${escapeHtml(t)}">#${escapeHtml(t)}</button>`);
	});
	pills.push('<span class="stat-pill">3D · GLB</span>');
	if (Number(avatar.viewCount) > 0) pills.push(`<span class="stat-pill">⊙ ${fmtNumber(avatar.viewCount)} views</span>`);
	if (avatar.createdAt) pills.push(`<span class="stat-pill">${escapeHtml(liveTime(avatar.createdAt))}</span>`);
	pillsEl.innerHTML = pills.join('');
	pillsEl.querySelectorAll('[data-tag]').forEach((btn) => {
		btn.addEventListener('click', () => navTo(`/marketplace?tag=${encodeURIComponent(btn.dataset.tag)}`));
	});

	// CTAs.
	const useBtn   = $('avatar-detail-use');
	const viewBtn  = $('avatar-detail-view');
	const dlBtn    = $('avatar-detail-download');
	const shareBtn = $('avatar-detail-share');
	if (useBtn) useBtn.onclick = () => {
		const p = new URLSearchParams();
		if (avatar.glbUrl) p.set('avatar_glb', avatar.glbUrl);
		if (avatar.name)   p.set('avatar_name', avatar.name);
		location.href = `/create?${p}`;
	};
	if (viewBtn) viewBtn.href = avatar.viewerUrl || `/app#model=${encodeURIComponent(avatar.glbUrl)}`;
	if (dlBtn)   { dlBtn.href = avatar.glbUrl; dlBtn.setAttribute('download', (avatar.slug || avatar.avatarId || 'avatar') + '.glb'); }
	if (shareBtn) {
		shareBtn.onclick = async () => {
			const shareUrl = location.href;
			const shareTitle = `${avatar.name || 'Avatar'} — three.ws`;
			const shareText = avatar.description || 'Check out this 3D avatar on three.ws';
			if (navigator.share) {
				try { await navigator.share({ title: shareTitle, text: shareText, url: shareUrl }); return; }
				catch { /* user cancelled or share unsupported — fall through to copy */ }
			}
			try {
				await navigator.clipboard.writeText(shareUrl);
				const original = shareBtn.textContent;
				shareBtn.textContent = 'Link copied ✓';
				shareBtn.classList.add('copied');
				setTimeout(() => { shareBtn.textContent = original; shareBtn.classList.remove('copied'); }, 1800);
			} catch (err) {
				console.error('[marketplace] share copy', err);
			}
		};
	}

	// Social meta — make the avatar's own thumbnail/glb show up in link unfurls.
	setSocialMeta({
		title:       `${avatar.name} — Community Avatar · three.ws`,
		description: avatar.description || 'A 3D avatar on three.ws — use it as the face of an AI agent.',
		url:         location.origin + location.pathname,
		image:       avatar.image || _socialMetaDefaults.image,
	});

	// Inject model-viewer into stage.
	if (stage) {
		const mv = document.createElement('model-viewer');
		mv.setAttribute('src', avatar.glbUrl);
		mv.setAttribute('alt', avatar.name || 'Avatar');
		mv.setAttribute('auto-rotate', '');
		mv.setAttribute('rotation-per-second', '12deg');
		mv.setAttribute('camera-controls', '');
		mv.setAttribute('interaction-prompt', 'when-focused');
		mv.setAttribute('autoplay', '');
		mv.setAttribute('exposure', '1.05');
		mv.setAttribute('shadow-intensity', '0.7');
		mv.setAttribute('tone-mapping', 'aces');
		if (avatar.image) mv.setAttribute('poster', avatar.image);
		mv.style.cssText = 'width:100%;height:100%;position:absolute;inset:0;';
		if (bar) {
			mv.addEventListener('progress', (e) => {
				bar.style.width = Math.round((e.detail?.totalProgress || 0) * 100) + '%';
			});
		}
		mv.addEventListener('load', () => {
			stage.classList.add('mv-ready');
		}, { once: true });
		stage.appendChild(mv);
		_avatarDetailMv = mv;
	}

	// Mark this id as the active render so re-entries are no-ops, but only
	// now that the render succeeded — a failed fetch above leaves the id null
	// so the user's next click can retry.
	_avatarDetailId = id;

	// Similar avatars — show others with overlapping tags. Deep links land
	// here with state.publicAvatars empty (no list ever fetched); pull the
	// list now so the "Similar avatars" block isn't permanently empty.
	if (!state.publicAvatarsLoaded) {
		await loadPublicAvatars();
	}
	const similar = state.publicAvatars
		.filter((a) => a.avatarId !== id && (a.tags || []).some((t) => (avatar.tags || []).includes(t)))
		.slice(0, 8);
	if (similar.length && similarWrap) {
		similarWrap.hidden = false;
		const grid = $('avatar-detail-similar-grid');
		if (grid) {
			grid.innerHTML = similar.map((a) => renderAvatarCard(a)).join('');
			grid.querySelectorAll('[data-avatar-id]').forEach((card) => {
				card.addEventListener('click', (e) => {
					if (e.target.closest('a')) return;
					navTo(`/marketplace/avatars/${encodeURIComponent(card.dataset.avatarId)}`);
				});
			});
			attachModelViewerBehavior();
			observeCardModelViewers();
		}
	}

	// Fire-and-forget view tracking.
	if (avatar.avatarId && !String(avatar.avatarId).startsWith('avatar_demo_')) {
		fetch(`${API}/avatars/view`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ avatar_id: avatar.avatarId }),
			keepalive: true,
		}).catch(() => {});
	}
}

function renderDetailError(msg) {
	$('d-name').textContent = msg;
	$('d-author').textContent = '';
	$('d-published').textContent = '';
	$('d-overview').textContent = '';
	const thread = $('d-preview-thread');
	if (thread) thread.innerHTML = '';
}

function renderDetail(a, bookmarked) {
	const author = a.author_name || a.author || 'Anonymous';
	const published = a.published_at || a.published || a.created_at;
	const views = a.views_count ?? a.views ?? 0;
	const forks = a.forks_count ?? a.forks ?? 0;
	$('d-name').textContent = a.name || 'Untitled';
	renderDetailAvatar(a);

	const authorBtn = $('d-author');
	authorBtn.textContent = author;
	if (a.author_id) {
		authorBtn.dataset.creatorId = a.author_id;
		authorBtn.disabled = false;
		authorBtn.style.cursor = 'pointer';
		authorBtn.style.textDecoration = '';
	} else {
		delete authorBtn.dataset.creatorId;
		authorBtn.disabled = true;
		authorBtn.style.cursor = 'default';
		authorBtn.style.textDecoration = 'none';
	}
	$('d-published').textContent = published ? formatDate(published) : '';
	$('d-category').textContent = CATEGORY_LABELS[a.category] || a.category || 'General';
	$('d-views').textContent = `⊙ ${fmtNumber(views)}`;
	$('d-overview').textContent = a.description || '';

	// Render pricing summary if agent has skill prices
	renderDetailPricingSummary(a);

	renderAgentSalePanel(a);
	$('d-profile').textContent = a.system_prompt || a.prompt || '(No profile yet.)';
	startPreviewSession(a);
	$('d-bookmark').classList.toggle('on', bookmarked);
	$('d-bookmark').textContent = bookmarked ? '★' : '☆';

	const forksEl = $('d-forks-pill');
	if (forks > 0) {
		forksEl.textContent = `⑂ ${fmtNumber(forks)} forks`;
		forksEl.hidden = false;
	} else {
		forksEl.hidden = true;
	}

	// Capabilities tab
	const caps = a.capabilities || {};
	const skillsArr = Array.isArray(caps.skills) ? caps.skills : a.skills || [];
	const libraryArr = Array.isArray(caps.library) ? caps.library : [];

	$('d-skills-count').textContent = skillsArr.length;
	$('d-library-count').textContent = libraryArr.length;

	const skillPrices = a.skill_prices || {};

	$('d-skills').innerHTML = skillsArr.length
		? skillsArr.map((s) => {
				const name = typeof s === 'string' ? s : (s.name || '');
				const price = skillPrices[name];
				const purchaseKey = `${a.id}:${name}`;

				let badge;
				if (purchasedSkills.has(purchaseKey)) {
					badge = `<span class="price-badge price-owned">✓ Owned</span>`;
				} else if (price) {
					const priceInUSDC = (price.amount / 1e6).toFixed(2);
					const trialUses = price.trial_uses || 0;
					const trialBtn = trialUses > 0
						? `<button class="trial-btn" data-skill-name="${escapeHtml(name)}" data-agent-id="${a.id}" data-trial-uses="${trialUses}">Try free (${trialUses} left)</button>`
						: '';
					const hasTimePass = price.time_pass_hours && price.time_pass_amount;
					const timePassBtn = hasTimePass
						? (() => {
								const tpHuman = (Number(price.time_pass_amount) / 1e6).toFixed(2);
								return `<button class="time-pass-btn" data-skill-name="${escapeHtml(name)}" data-agent-id="${a.id}" data-duration="${price.time_pass_hours}" data-amount="${price.time_pass_amount}">Get ${price.time_pass_hours}h access (${tpHuman} USDC)</button>`;
							})()
						: '';
					badge = `<span class="price-badge price-paid">${priceInUSDC} USDC</span>` +
						`<button class="purchase-btn" data-skill-name="${escapeHtml(name)}" data-agent-id="${a.id}">Purchase</button>` +
						trialBtn + timePassBtn;
				} else {
					badge = `<span class="price-badge price-free">Free</span>`;
				}

				return `<div class="skill-row">
									<span class="skill-name">${escapeHtml(name)}</span>
									${badge}
							</div>`;
		}).join('')
		: '<div>This Agent has no skills defined.</div>';

	$('d-library').innerHTML = libraryArr.length
		? libraryArr
				.map((l) => `<span class="stat-pill">${escapeHtml(typeof l === 'string' ? l : l.name || '')}</span>`)
				.join(' ')
		: '<div>This Agent includes the following Libraries to help answer more questions.</div>';

	// Profile capabilities list
	const list = caps.bullets && Array.isArray(caps.bullets) ? caps.bullets : [];
	$('d-capabilities-list').innerHTML = list
		.map((b) => `<li>${escapeHtml(b)}</li>`)
		.join('');

	// Embed tab
	renderEmbedTab(a);

	// Token card
	renderTokenCard(a);
}

function renderEmbedTab(a) {
	const agentId = a.id;
	const glbUrl = a.avatar_glb_url || '';
	const embedPageUrl = `${location.origin}/marketplace/agents/${agentId}`;
	const iframeSrc = `/agent/${agentId}/embed`;

	const wcSnippet = glbUrl
		? `<script type="module" src="https://three.ws/dist-lib/agent-3d.js"><\/script>\n<agent-3d\n  src="${glbUrl}"\n  agent-id="${agentId}"\n  style="width:480px;height:480px"\n></agent-3d>`
		: `<!-- No 3D avatar attached yet -->`;

	const iframeSnippet = `<iframe\n  src="${iframeSrc}"\n  width="480"\n  height="640"\n  style="border:0;border-radius:14px"\n  allow="autoplay; xr-spatial-tracking"\n></iframe>`;

	const wc = $('d-embed-wc');
	const iframe = $('d-embed-iframe');
	const link = $('d-embed-link');
	if (wc) wc.textContent = wcSnippet;
	if (iframe) iframe.textContent = iframeSnippet;
	if (link) link.textContent = embedPageUrl;
}

function renderTokenCard(a) {
	const card = $('d-token-card');
	if (!card) return;
	const mint = a.sol_mint_address;
	if (!mint) {
		card.hidden = true;
		return;
	}
	const net = a.pumpfun_network || 'mainnet';
	const short = `${mint.slice(0, 6)}…${mint.slice(-4)}`;
	const mintEl = $('d-token-mint');
	if (mintEl) mintEl.textContent = short;
	mintEl?.setAttribute('title', mint);

	const pumpEl = $('d-token-pump');
	if (pumpEl) pumpEl.href = `https://pump.fun/${mint}`;

	const jupEl = $('d-token-jup');
	if (jupEl) jupEl.href = `https://jup.ag/swap/SOL-${mint}`;

	card.hidden = false;
}

function renderVersions(versions) {
	const ul = $('d-versions');
	if (!versions.length) {
		ul.innerHTML = '<li>No published versions yet.</li>';
		return;
	}
	ul.innerHTML = versions
		.map(
			(v) => `<li>
				<span class="v">v${v.version}</span>
				<span class="changelog">${escapeHtml(v.changelog || '(no changelog)')}</span>
				<span class="when">${formatDate(v.created_at)}</span>
			</li>`,
		)
		.join('');
}

function renderSimilar(items) {
	const grid = $('d-similar');
	const side = $('d-related-side');
	if (!items.length) {
		grid.innerHTML = '<div class="market-empty">No related agents.</div>';
		side.innerHTML = '';
		return;
	}
	grid.innerHTML = items.map(renderCard).join('');
	grid.querySelectorAll('[data-id]').forEach((card) => {
		card.addEventListener('click', () => navTo(`/marketplace/agents/${card.dataset.id}`));
	});

	side.innerHTML =
		`<div class="related-side-title">Related Agents <a href="#" id="rel-more">View More ›</a></div>` +
		items
			.slice(0, 4)
			.map(
				(a) => `<div class="related-card" data-id="${a.id}">
					<div class="av">${initial(a.name)}</div>
					<div style="min-width:0">
						<div class="name">${escapeHtml(a.name || '')}</div>
						<div class="desc">${escapeHtml(a.description || '')}</div>
					</div>
				</div>`,
			)
			.join('');
	side.querySelectorAll('[data-id]').forEach((card) => {
		card.addEventListener('click', () => navTo(`/marketplace/agents/${card.dataset.id}`));
	});
}

// ── Reviews & Ratings ─────────────────────────────────────────────────────

const reviewsState = {
	agentId: null,
	summary: null,
	reviews: [],
	myReview: null,
	selectedRating: 0,
	loading: false,
	submitting: false,
};

async function loadReviews(agentId) {
	reviewsState.agentId = agentId;
	reviewsState.loading = true;
	renderReviewsSkeleton();

	try {
		const r = await fetch(`${API}/marketplace/agents/${agentId}/reviews`, { credentials: 'include' });
		if (!r.ok) throw new Error(`reviews fetch ${r.status}`);
		const j = await r.json();
		reviewsState.summary = j.data?.summary || { rating_avg: 0, rating_count: 0, breakdown: {} };
		reviewsState.reviews = j.data?.reviews || [];
		reviewsState.myReview = j.data?.my_review || null;
		reviewsState.selectedRating = reviewsState.myReview?.rating || 0;
		reviewsState.loading = false;
		renderReviewsSummary();
		renderReviewInput();
		renderReviewsList();
	} catch (err) {
		console.error('[marketplace] reviews', err);
		reviewsState.loading = false;
		const msg = $('d-rating-msg');
		if (msg) { msg.textContent = 'Could not load reviews.'; msg.classList.add('err'); }
	}
}

function renderReviewsSkeleton() {
	const summary = $('d-rating-summary');
	if (summary) {
		$('d-rating-avg').textContent = '—';
		$('d-rating-stars').textContent = '☆☆☆☆☆';
		$('d-rating-count').textContent = 'Loading…';
	}
	const list = $('d-reviews-list');
	if (list) {
		list.innerHTML = Array.from({ length: 3 }, () =>
			`<div class="review-card skeleton"><div class="review-skeleton-line w60"></div><div class="review-skeleton-line w80"></div><div class="review-skeleton-line w40"></div></div>`
		).join('');
	}
	const input = $('d-rating-input');
	if (input) input.hidden = true;
	const msg = $('d-rating-msg');
	if (msg) { msg.textContent = ''; msg.classList.remove('err', 'ok'); }
}

function starsHtml(rating, max = 5) {
	const full = Math.round(rating);
	let s = '';
	for (let i = 1; i <= max; i++) s += i <= full ? '★' : '☆';
	return s;
}

function renderReviewsSummary() {
	const s = reviewsState.summary;
	if (!s) return;
	$('d-rating-avg').textContent = s.rating_count > 0 ? Number(s.rating_avg).toFixed(1) : '—';
	$('d-rating-stars').innerHTML = s.rating_count > 0
		? `<span class="stars-filled">${starsHtml(s.rating_avg)}</span>`
		: '☆☆☆☆☆';
	$('d-rating-count').textContent = s.rating_count > 0
		? `${s.rating_count} review${s.rating_count === 1 ? '' : 's'}`
		: 'No reviews yet';

	const widget = $('d-rating-widget');
	if (!widget) return;
	let breakdownEl = widget.querySelector('.d-rating-breakdown');
	if (!breakdownEl) {
		breakdownEl = document.createElement('div');
		breakdownEl.className = 'd-rating-breakdown';
		const summaryEl = $('d-rating-summary');
		if (summaryEl) summaryEl.after(breakdownEl);
	}

	if (s.rating_count === 0) {
		breakdownEl.innerHTML = '';
		return;
	}

	const bd = s.breakdown || {};
	breakdownEl.innerHTML = [5, 4, 3, 2, 1].map((star) => {
		const count = bd[star] || 0;
		const pct = s.rating_count > 0 ? (count / s.rating_count * 100) : 0;
		return `<div class="breakdown-row">
			<span class="breakdown-label">${star}★</span>
			<div class="breakdown-track"><div class="breakdown-fill" style="width:${pct.toFixed(1)}%"></div></div>
			<span class="breakdown-count">${count}</span>
		</div>`;
	}).join('');
}

function renderReviewInput() {
	const input = $('d-rating-input');
	if (!input) return;

	if (!isLikelyAuthed()) {
		input.hidden = false;
		input.innerHTML = `<a href="/login?next=${encodeURIComponent(location.pathname)}" class="review-login-cta">Sign in to leave a review</a>`;
		return;
	}

	const isOwner = detailState?.agent?.is_mine || detailState?.agent?.is_owner;
	if (isOwner) {
		input.hidden = true;
		return;
	}

	input.hidden = false;

	if (reviewsState.myReview) {
		input.innerHTML = `
			<div class="review-mine-notice">
				<span>Your review: <strong>${starsHtml(reviewsState.myReview.rating)}</strong></span>
				<div class="review-mine-actions">
					<button type="button" class="review-edit-btn" id="d-review-edit">Edit</button>
					<button type="button" class="review-delete-btn" id="d-review-delete">Delete</button>
				</div>
			</div>
			<div class="review-edit-form" id="d-review-edit-form" hidden>
				<span style="font-size:12px;color:var(--mk-text-2)">Update your rating:</span>
				<span class="stars review-star-picker" id="d-rating-pick-edit" role="radiogroup" aria-label="Pick a rating">
					${[1,2,3,4,5].map(i => `<button type="button" class="star-pick${i <= reviewsState.myReview.rating ? ' active' : ''}" data-rating="${i}" aria-label="${i} star${i>1?'s':''}">${i <= reviewsState.myReview.rating ? '★' : '☆'}</button>`).join('')}
				</span>
				<textarea id="d-review-body-edit" placeholder="Write a short review (optional)" maxlength="2000">${escapeHtml(reviewsState.myReview.body || '')}</textarea>
				<div class="review-edit-actions">
					<button type="button" class="submit-review" id="d-review-update">Update review</button>
					<button type="button" class="review-cancel-btn" id="d-review-cancel">Cancel</button>
				</div>
			</div>`;

		$('d-review-edit')?.addEventListener('click', () => {
			$('d-review-edit-form').hidden = false;
			$('d-review-edit').parentElement.parentElement.querySelector('.review-mine-notice')?.classList.add('editing');
		});
		$('d-review-cancel')?.addEventListener('click', () => {
			$('d-review-edit-form').hidden = true;
			document.querySelector('.review-mine-notice')?.classList.remove('editing');
		});
		$('d-review-delete')?.addEventListener('click', deleteReview);
		$('d-review-update')?.addEventListener('click', () => {
			const body = $('d-review-body-edit')?.value || '';
			submitReview(reviewsState.selectedRating, body);
		});
		bindStarPicker($('d-rating-pick-edit'));
	} else {
		input.innerHTML = `
			<span style="font-size:12px;color:var(--mk-text-2)">Your rating:</span>
			<span class="stars review-star-picker" id="d-rating-pick" role="radiogroup" aria-label="Pick a rating">
				${[1,2,3,4,5].map(i => `<button type="button" class="star-pick" data-rating="${i}" aria-label="${i} star${i>1?'s':''}">${i <= reviewsState.selectedRating ? '★' : '☆'}</button>`).join('')}
			</span>
			<textarea id="d-review-body" placeholder="Write a short review (optional)" maxlength="2000"></textarea>
			<button type="button" class="submit-review" id="d-review-submit" disabled>Submit review</button>`;
		$('d-review-submit')?.addEventListener('click', () => {
			const body = $('d-review-body')?.value || '';
			submitReview(reviewsState.selectedRating, body);
		});
		bindStarPicker($('d-rating-pick'));
	}

	const msg = $('d-rating-msg');
	if (msg) { msg.textContent = ''; msg.classList.remove('err', 'ok'); }
}

function bindStarPicker(container) {
	if (!container) return;
	const buttons = container.querySelectorAll('.star-pick');
	buttons.forEach((btn) => {
		btn.addEventListener('mouseenter', () => {
			const r = Number(btn.dataset.rating);
			buttons.forEach((b) => {
				const v = Number(b.dataset.rating);
				b.textContent = v <= r ? '★' : '☆';
				b.classList.toggle('hover', v <= r);
			});
		});
		btn.addEventListener('click', () => {
			const r = Number(btn.dataset.rating);
			reviewsState.selectedRating = r;
			buttons.forEach((b) => {
				const v = Number(b.dataset.rating);
				b.textContent = v <= r ? '★' : '☆';
				b.classList.toggle('active', v <= r);
			});
			const submit = container.closest('.d-rating-input, .review-edit-form')?.querySelector('.submit-review');
			if (submit) submit.disabled = false;
		});
	});
	container.addEventListener('mouseleave', () => {
		const current = reviewsState.selectedRating;
		buttons.forEach((b) => {
			const v = Number(b.dataset.rating);
			b.textContent = v <= current ? '★' : '☆';
			b.classList.remove('hover');
			b.classList.toggle('active', v <= current);
		});
	});
}

async function submitReview(rating, body) {
	if (!rating || rating < 1 || rating > 5) return;
	if (!reviewsState.agentId) return;
	if (reviewsState.submitting) return;
	reviewsState.submitting = true;
	const msg = $('d-rating-msg');
	if (msg) { msg.textContent = 'Submitting…'; msg.classList.remove('err', 'ok'); }

	try {
		const r = await apiPostWithCsrf(
			`${API}/marketplace/agents/${reviewsState.agentId}/reviews`,
			{ rating, body: body?.trim() || null },
		);
		if (r.status === 401) {
			location.href = `/login?next=${encodeURIComponent(location.pathname)}`;
			return;
		}
		const j = await r.json();
		if (!r.ok) throw new Error(j?.error_description || j?.error || 'Review submission failed');

		if (msg) { msg.textContent = 'Review saved.'; msg.classList.add('ok'); }
		setTimeout(() => { if (msg) msg.textContent = ''; }, 3000);
		loadReviews(reviewsState.agentId);
	} catch (err) {
		console.error('[marketplace] submit review', err);
		if (msg) { msg.textContent = err.message || 'Failed to save review.'; msg.classList.add('err'); }
	} finally {
		reviewsState.submitting = false;
	}
}

async function deleteReview() {
	if (!reviewsState.agentId) return;
	if (reviewsState.submitting) return;
	const msg = $('d-rating-msg');
	if (msg) { msg.textContent = 'Deleting…'; msg.classList.remove('err', 'ok'); }
	reviewsState.submitting = true;
	try {
		const token = await getCsrfToken();
		_csrf = null;
		const r = await fetch(`${API}/marketplace/agents/${reviewsState.agentId}/reviews`, {
			method: 'DELETE',
			headers: { 'X-CSRF-Token': token },
			credentials: 'include',
		});
		if (!r.ok) {
			const j = await r.json().catch(() => ({}));
			throw new Error(j?.error_description || 'Delete failed');
		}
		reviewsState.myReview = null;
		reviewsState.selectedRating = 0;
		if (msg) { msg.textContent = 'Review deleted.'; msg.classList.add('ok'); }
		setTimeout(() => { if (msg) msg.textContent = ''; }, 3000);
		loadReviews(reviewsState.agentId);
	} catch (err) {
		console.error('[marketplace] delete review', err);
		if (msg) { msg.textContent = err.message || 'Delete failed.'; msg.classList.add('err'); }
	} finally {
		reviewsState.submitting = false;
	}
}

function renderReviewsList() {
	const list = $('d-reviews-list');
	if (!list) return;
	const reviews = reviewsState.reviews || [];

	if (!reviews.length) {
		list.innerHTML = `<div class="reviews-empty">
			<span class="reviews-empty-icon">☆</span>
			<p>No reviews yet.</p>
			<p class="reviews-empty-hint">Be the first to share your experience with this agent.</p>
		</div>`;
		return;
	}

	list.innerHTML = reviews.map((r) => {
		const avatar = r.author_avatar
			? `<div class="review-avatar" style="background-image:url('${escapeHtml(r.author_avatar)}')"></div>`
			: `<div class="review-avatar">${escapeHtml(initial(r.author_name))}</div>`;
		const dateStr = liveTime(r.updated_at || r.created_at);
		const edited = r.updated_at && r.created_at && r.updated_at !== r.created_at;
		const mine = r.is_mine ? ' mine' : '';
		return `<div class="review-card${mine}">
			<div class="review-header">
				${avatar}
				<div class="review-meta">
					<span class="review-author">${escapeHtml(r.author_name)}</span>
					<span class="review-date">${escapeHtml(dateStr)}${edited ? ' (edited)' : ''}</span>
				</div>
				<span class="review-stars">${starsHtml(r.rating)}</span>
			</div>
			${r.body ? `<p class="review-body">${escapeHtml(r.body)}</p>` : ''}
		</div>`;
	}).join('');
}

// ── On-chain Reputation ──────────────────────────────────────────────────

async function loadReputation(agentId) {
	const card = $('d-reputation-card');
	if (!card) return;
	try {
		const r = await fetch(`${API}/agents/${agentId}/reputation`);
		if (!r.ok) { card.hidden = true; return; }
		const j = await r.json();
		const rep = j?.data;
		if (!rep || (!rep.average && !rep.count)) { card.hidden = true; return; }
		card.hidden = false;
		const avg = Number(rep.average || 0);
		const count = Number(rep.count || 0);
		$('d-rep-avg').textContent = avg.toFixed(1);
		$('d-rep-count').textContent = `${count} on-chain vote${count === 1 ? '' : 's'}`;
		$('d-rep-stars').innerHTML = `<span class="stars-filled">${starsHtml(avg)}</span>`;
	} catch {
		if (card) card.hidden = true;
	}
}

// ── Tabs ──────────────────────────────────────────────────────────────────

function bindTabs() {
	document.querySelectorAll('.market-tabs button').forEach((btn) => {
		btn.addEventListener('click', () => {
			document.querySelectorAll('.market-tabs button').forEach((b) => b.classList.remove('active'));
			btn.classList.add('active');
			const tab = btn.dataset.tab;
			document.querySelectorAll('.market-panel').forEach((p) => {
				p.classList.toggle('active', p.dataset.panel === tab);
			});
		});
	});
}

// ── Actions ───────────────────────────────────────────────────────────────

function exportAgentJson() {
	if (!detailState?.agent) return;
	const a = detailState.agent;
	// Strip server-side internal fields and offer the agent as a portable JSON
	// snapshot the user can keep, share, or re-import via the submit modal.
	const exportable = {
		id: a.id,
		name: a.name,
		description: a.description,
		category: a.category,
		tags: a.tags || [],
		greeting: a.greeting || '',
		system_prompt: a.system_prompt || a.prompt || '',
		capabilities: a.capabilities || {},
		skills: a.skills || a.capabilities?.skills || [],
		fork_of: a.fork_of || null,
		exported_at: new Date().toISOString(),
		source: `https://three.ws/marketplace?id=${encodeURIComponent(a.id)}`,
	};
	const blob = new Blob([JSON.stringify(exportable, null, 2)], { type: 'application/json' });
	const url = URL.createObjectURL(blob);
	const link = document.createElement('a');
	link.href = url;
	const slug = (a.name || a.id || 'agent').toString().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
	link.download = `${slug || 'agent'}.three-ws.json`;
	document.body.appendChild(link);
	link.click();
	document.body.removeChild(link);
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function fork() {
	if (!detailState) return;
	const id = detailState.agent.id;
	try {
		const r = await fetch(`${API}/marketplace/agents/${id}/fork`, {
			method: 'POST',
			credentials: 'include',
		});
		if (r.status === 401) {
			location.href = `/login?next=${encodeURIComponent(location.pathname)}`;
			return;
		}
		const j = await r.json();
		if (!r.ok) throw new Error(j?.error_description || 'Fork failed');
		// Send the user to chat with their new fork.
		const newId = j?.data?.agent?.id;
		if (newId) location.href = `/agents/${newId}`;
	} catch (err) {
		alert(err.message || 'Fork failed');
	}
}

async function toggleBookmark() {
	if (!detailState) return;
	const id = detailState.agent.id;
	const cur = detailState.bookmarked;
	try {
		const r = await fetch(`${API}/marketplace/agents/${id}/bookmark`, {
			method: cur ? 'DELETE' : 'POST',
			credentials: 'include',
		});
		if (r.status === 401) {
			location.href = `/login?next=${encodeURIComponent(location.pathname)}`;
			return;
		}
		const j = await r.json();
		detailState.bookmarked = !!j?.data?.bookmarked;
		$('d-bookmark').classList.toggle('on', detailState.bookmarked);
		$('d-bookmark').textContent = detailState.bookmarked ? '★' : '☆';
	} catch (err) {
		console.error('[marketplace] bookmark', err);
	}
}

// ── Wiring ────────────────────────────────────────────────────────────────

function bindEvents() {
	bindEmptyStateActions();
	let searchTimer;
	els.search.addEventListener('input', (e) => {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => {
			state.q = e.target.value.trim();
			syncFilterToUrl();
			// All three feeds (agents, avatars, onchain) accept ?q= on the server.
			// If we only re-fetch agents on search, the grid keeps stale avatar +
			// onchain cards from the previous query — and the empty state never
			// fires when the query genuinely matches nothing.
			state.publicAvatarsLoaded = false;
			state.onchainLoaded = false;
			loadList(true);
			loadPublicAvatars();
			loadOnchainAgents(true);
		}, 200);
	});
	els.sortSel.addEventListener('change', (e) => {
		state.sort = e.target.value;
		syncFilterToUrl({ push: true });
		loadList(true);
	});
	els.loadMore.addEventListener('click', () => {
		// Load whichever list has a cursor; onchain owns its own pagination cursor.
		if (state.filter === 'onchain' && state.onchainCursor) {
			loadOnchainAgents(false);
		} else if (state.cursor) {
			loadList(false);
		} else if (state.onchainCursor) {
			loadOnchainAgents(false);
		}
	});
	els.back.addEventListener('click', () => navTo('/marketplace'));
	// Avatar detail back button.
	const avatarDetailBack = $('avatar-detail-back');
	if (avatarDetailBack) avatarDetailBack.addEventListener('click', () => { _avatarDetailId = null; navTo('/marketplace'); });
	$('d-fork').addEventListener('click', fork);
	$('d-bookmark').addEventListener('click', toggleBookmark);
	$('d-export-json')?.addEventListener('click', exportAgentJson);
	bindTabs();
	bindSubmit();
	bindFilterChips();

	// 3D Lobby: open from the hero button, close on overlay button or Escape.
	$('market-hero-lobby')?.addEventListener('click', openLobby);
	$('market-lobby-close')?.addEventListener('click', closeLobby);
	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape' && lobbyHandle) closeLobby();
	});
	// Pause the hero rotation when the page is hidden, resume when it returns —
	// avoids burning GPU on a tab the user isn't even looking at.
	document.addEventListener('visibilitychange', () => {
		if (document.hidden) stopHeroAutoplay();
		else if (state.featured.length) startHeroAutoplay();
	});

	document.body.addEventListener('click', async (e) => {
		const embedBtn = e.target.closest('.d-embed-copy');
		if (embedBtn) {
			const which = embedBtn.dataset.embed;
			const srcMap = { wc: 'd-embed-wc', iframe: 'd-embed-iframe', link: 'd-embed-link' };
			const src = $(srcMap[which]);
			if (src) {
				try {
					await navigator.clipboard.writeText(src.textContent);
					embedBtn.textContent = 'Copied ✓';
					embedBtn.classList.add('copied');
					setTimeout(() => {
						embedBtn.textContent = 'Copy';
						embedBtn.classList.remove('copied');
					}, 1800);
				} catch (_) { /* clipboard unavailable */ }
			}
			return;
		}
		if (e.target.matches('.purchase-btn')) {
			const skillName = e.target.dataset.skillName;
			const agentId = e.target.dataset.agentId;
			if (agentId && skillName) openPurchaseFlow(agentId, skillName).catch((err) => console.error('[marketplace] purchase flow', err));
		}
		if (e.target.matches('.trial-btn')) {
			const skillName = e.target.dataset.skillName;
			const agentId = e.target.dataset.agentId;
			if (agentId && skillName) openTrialFlow(agentId, skillName, e.target).catch((err) => console.error('[marketplace] trial flow', err));
		}
		if (e.target.matches('.time-pass-btn')) {
			const skillName = e.target.dataset.skillName;
			const agentId = e.target.dataset.agentId;
			const duration = Number(e.target.dataset.duration);
			if (agentId && skillName && duration) openTimePassFlow(agentId, skillName, duration, e.target).catch((err) => console.error('[marketplace] time-pass flow', err));
		}
	});

	$('payment-modal-close')?.addEventListener('click', closePaymentModal);
	$('payment-confirm-btn')?.addEventListener('click', handlePurchase);
	$('payment-modal-overlay')?.addEventListener('click', (e) => {
		if (e.target.id === 'payment-modal-overlay') closePaymentModal();
	});

	// Avatar detail modal
	$('avatar-modal-close')?.addEventListener('click', closeAvatarModal);
	$('avatar-modal-overlay')?.addEventListener('click', (e) => {
		if (e.target.id === 'avatar-modal-overlay') closeAvatarModal();
	});
	$('avatar-modal-use')?.addEventListener('click', startAgentFromAvatar);
	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape' && !$('avatar-modal-overlay')?.hidden) closeAvatarModal();
	});

	// Hero CTA — open most recent featured avatar in 3D modal
	$('market-hero-view')?.addEventListener('click', () => {
		const a = state.featured[state.heroIndex];
		if (a) openAvatarModal(a);
	});
	$('market-hero-fork')?.addEventListener('click', () => {
		const a = state.featured[state.heroIndex];
		if (a) {
			activeAvatar = a;
			startAgentFromAvatar();
		}
	});

	// Skills tab controls
	let skillsSearchTimer;
	$('skills-search')?.addEventListener('input', (e) => {
		clearTimeout(skillsSearchTimer);
		skillsSearchTimer = setTimeout(() => {
			skillsState.q = e.target.value.trim();
			renderSkillsGrid();
		}, 150);
	});
	document.querySelectorAll('[data-skill-filter]').forEach((chip) => {
		chip.addEventListener('click', () => {
			document.querySelectorAll('[data-skill-filter]').forEach((c) => c.classList.remove('active'));
			chip.classList.add('active');
			skillsState.filter = chip.dataset.skillFilter;
			renderSkillsGrid();
		});
	});

	// New Agent CTA on Mine tab
	$('market-new-agent-btn')?.addEventListener('click', () => {
		location.href = '/agent/new';
	});

	// Sidebar nav: intercept marketplace links so we route via SPA
	document.querySelectorAll('.market-nav a[data-nav]').forEach((a) => {
		a.addEventListener('click', (e) => {
			const href = a.getAttribute('href') || '';
			if (href.startsWith('/marketplace')) {
				e.preventDefault();
				navTo(href);
			}
		});
	});
}

// ── Submit Modal ──────────────────────────────────────────────────────────

function openSubmitModal() {
	$('market-submit-overlay').hidden = false;
	$('sf-name').focus();
}

function closeSubmitModal() {
	$('market-submit-overlay').hidden = true;
}

// sf-price-rows state for the submit modal
const sfPriceRows = [];

function renderSfPriceRows() {
	const container = $('sf-price-rows');
	if (!container) return;
	if (!sfPriceRows.length) { container.innerHTML = ''; return; }
	container.innerHTML = sfPriceRows.map((row, i) => `
		<div class="agent-pricing-row" data-row="${i}">
			<span class="ap-skill-name">${escapeHtml(row.skill)}</span>
			<input class="ap-price-input" type="number" min="0" max="100" step="0.01"
				value="${escapeHtml(String(row.amount_usd))}" placeholder="0.00" data-row="${i}" />
			<span class="ap-unit">USDC</span>
			<button class="ap-remove" data-row="${i}" title="Remove">×</button>
		</div>
	`).join('');
	container.querySelectorAll('.ap-price-input').forEach((inp) => {
		inp.addEventListener('input', () => {
			const i = Number(inp.dataset.row);
			if (sfPriceRows[i]) sfPriceRows[i].amount_usd = inp.value;
		});
	});
	container.querySelectorAll('.ap-remove').forEach((btn) => {
		btn.addEventListener('click', () => {
			sfPriceRows.splice(Number(btn.dataset.row), 1);
			renderSfPriceRows();
		});
	});
}

function bindSubmit() {
	// Exclude earn-publish-skill-btn from triggering the agent submit modal
	document.querySelectorAll('.market-submit-btn').forEach((b) => {
		if (b.id === 'earn-publish-skill-btn') return;
		b.addEventListener('click', openSubmitModal);
	});
	$('market-submit-close').addEventListener('click', closeSubmitModal);
	$('market-submit-overlay').addEventListener('click', (e) => {
		if (e.target === $('market-submit-overlay')) closeSubmitModal();
	});

	// Add skill price row in submit modal
	$('sf-add-skill')?.addEventListener('click', () => {
		const inp = $('sf-new-skill');
		const skill = (inp?.value || '').trim().toLowerCase().replace(/\s+/g, '-');
		if (!skill) return;
		if (sfPriceRows.some((r) => r.skill === skill)) { inp.value = ''; return; }
		sfPriceRows.push({ skill, amount_usd: '0.00' });
		inp.value = '';
		renderSfPriceRows();
	});
	$('sf-new-skill')?.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') { e.preventDefault(); $('sf-add-skill')?.click(); }
	});

	const form = $('market-submit-form');
	const errorEl = $('market-submit-error');
	form.addEventListener('submit', (e) => e.preventDefault());

	$('sf-publish').addEventListener('click', async () => {
		const body = {
			name: $('sf-name').value,
			description: $('sf-description').value,
			system_prompt: $('sf-prompt').value,
			greeting: $('sf-greeting').value,
			category: $('sf-category').value,
			tags: $('sf-tags').value.split(',').map(t => t.trim()).filter(Boolean),
			publish: true,
		};

		try {
			errorEl.hidden = true;
			const r = await fetch(`${API}/marketplace/agents`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify(body),
			});
			const j = await r.json();
			if (!r.ok) throw new Error(j.error_description || 'Submission failed');

			const agentId = j?.data?.agent?.id;

			// Save payout wallet if provided
			const payoutAddr = ($('sf-payout-wallet')?.value || '').trim();
			if (payoutAddr && agentId) {
				fetch(`${API}/billing/payout-wallets`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					credentials: 'include',
					body: JSON.stringify({ address: payoutAddr, chain: 'solana', agent_id: agentId, is_default: true }),
				}).catch(() => {});
			}

			// Save skill prices if any were set
			if (agentId && sfPriceRows.length) {
				Promise.all(sfPriceRows.map((row) => {
					const amount = Math.round(parseFloat(row.amount_usd || '0') * 1e6);
					if (!amount) return Promise.resolve();
					return fetch(`${API}/marketplace/set-skill-price`, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						credentials: 'include',
						body: JSON.stringify({
							agent_id: agentId,
							skill: row.skill,
							amount,
							currency_mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
							chain: 'solana',
						}),
					});
				})).catch(() => {});
			}

			sfPriceRows.length = 0;
			closeSubmitModal();
			loadList(true);
		} catch (err) {
			errorEl.textContent = err.message;
			errorEl.hidden = false;
		}
	});
}

// ── Util ──────────────────────────────────────────────────────────────────

function escapeHtml(s) {
	return String(s || '').replace(
		/[&<>"']/g,
		(ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch],
	);
}

function initial(name) {
	const s = String(name || '?').trim();
	return s ? s[0].toUpperCase() : '?';
}

function formatDate(iso) {
	if (!iso) return '';
	const d = new Date(iso);
	if (isNaN(d)) return '';
	return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function liveTime(iso) {
	if (!iso) return '';
	const d = new Date(iso);
	if (isNaN(d)) return '';
	const sec = (Date.now() - d.getTime()) / 1000;
	if (sec < 60) return 'just now';
	if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
	if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
	if (sec < 604800) return `${Math.floor(sec / 86400)}d ago`;
	if (sec < 2592000) return `${Math.floor(sec / 604800)}w ago`;
	return formatDate(iso);
}

function fmtNumber(n) {
	const num = Number(n);
	if (!Number.isFinite(num)) return String(n ?? '');
	if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(num >= 10_000_000 ? 0 : 1)}M`;
	if (num >= 1_000) return `${(num / 1_000).toFixed(num >= 10_000 ? 0 : 1)}k`;
	return String(num);
}

// USDC mainnet mint. Anything else gets shown as a generic token symbol.
const USDC_MAINNET_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Render a price object (from /api/explore or /api/marketplace/agents) as a
// human-readable string. Pass `null` / undefined to get "Free".
function formatAssetPrice(price) {
	if (!price || price.amount == null) return null;
	const decimals = Number(price.mint_decimals ?? 6);
	const amount = Number(price.amount);
	if (!Number.isFinite(amount) || amount <= 0) return null;
	const value = amount / Math.pow(10, decimals);
	const symbol = price.currency_mint === USDC_MAINNET_MINT ? 'USDC' : (price.currency_mint || '').slice(0, 4) + '…';
	const formatted = value >= 100 ? value.toFixed(0) : value >= 1 ? value.toFixed(2) : value.toFixed(3);
	return `${formatted.replace(/\.?0+$/, '')} ${symbol}`;
}

// Reusable badge HTML for a Free/Paid listing. Returns empty string when there
// is nothing to show.
function priceBadgeHtml(price) {
	const label = formatAssetPrice(price);
	if (label) {
		return `<span class="market-price-pill paid" title="${escapeHtml(label)}">${escapeHtml(label)}</span>`;
	}
	return `<span class="market-price-pill free">Free</span>`;
}

function hasActivePrice(price) {
	return !!(price && Number(price.amount) > 0);
}

/**
 * Build a "From $X/call" badge when the agent has priced skills.
 * Returns empty string when there are no skill prices.
 */
function skillPriceBadgeHtml(skillPrices) {
	if (!skillPrices || typeof skillPrices !== 'object') return '';
	const entries = Object.values(skillPrices).filter(p => p && Number(p.amount) > 0);
	if (!entries.length) return '';
	const minAmount = Math.min(...entries.map(p => Number(p.amount)));
	const decimals = Number(entries[0]?.mint_decimals ?? 6);
	const minUsd = minAmount / Math.pow(10, decimals);
	const formatted = minUsd >= 1 ? minUsd.toFixed(2) : minUsd >= 0.01 ? minUsd.toFixed(3) : minUsd.toFixed(6).replace(/0+$/, '');
	return `<span class="stat-pill skill-price-badge" title="Skill pricing starts at $${formatted}/call">From $${escapeHtml(formatted)}/call</span>`;
}

// ── Purchase Flow ─────────────────────────────────────────────────────────
//
// One-shot Solana Pay purchase: server mints a unique reference Pubkey, the
// buyer's connected Phantom wallet sends USDC + the reference in a single tx,
// the server verifies on-chain via findReference / validateTransfer, and the
// (user, agent, skill) tuple lands in skill_purchases as 'confirmed'.

let solanaConnection;
let solanaWeb3Mod;
let splTokenMod;

const WALLET_PROVIDERS = [
	{ key: 'phantom',  name: 'Phantom',  detect: () => window.phantom?.solana || (window.solana?.isPhantom && window.solana) },
	{ key: 'solflare', name: 'Solflare', detect: () => window.solflare },
	{ key: 'backpack', name: 'Backpack', detect: () => window.backpack?.solana || (window.solana?.isBackpack && window.solana) },
];

let connectedWallet = null; // { provider, name, publicKey }

async function loadSolanaModules() {
	if (!solanaWeb3Mod) solanaWeb3Mod = await import('@solana/web3.js');
	if (!splTokenMod) splTokenMod = await import('@solana/spl-token');
	return { web3: solanaWeb3Mod, spl: splTokenMod };
}

async function getSolanaConnection() {
	if (solanaConnection) return solanaConnection;
	const { web3 } = await loadSolanaModules();
	// Route through our same-origin proxy. Public mainnet RPC 403s most browsers.
	const rpcOrigin = window.location?.origin || 'https://three.ws';
	solanaConnection = new web3.Connection(`${rpcOrigin}/api/solana-rpc`, 'confirmed');
	return solanaConnection;
}

function listAvailableWallets() {
	return WALLET_PROVIDERS
		.map((p) => ({ ...p, provider: p.detect() }))
		.filter((p) => p.provider);
}

async function connectWalletProvider(providerKey) {
	const entry = WALLET_PROVIDERS.find((p) => p.key === providerKey);
	if (!entry) throw new Error('unknown wallet');
	const provider = entry.detect();
	if (!provider) throw new Error(`${entry.name} not installed`);
	const { web3 } = await loadSolanaModules();
	const resp = await provider.connect();
	const pubKey = resp?.publicKey ?? provider.publicKey;
	if (!pubKey) throw new Error('wallet did not return a public key');
	connectedWallet = {
		provider,
		name: entry.name,
		publicKey: typeof pubKey === 'string' ? new web3.PublicKey(pubKey) : pubKey,
	};
	updateWalletUI();
}

function disconnectWallet() {
	try { connectedWallet?.provider?.disconnect?.(); } catch {}
	connectedWallet = null;
	updateWalletUI();
}

function updateWalletUI() {
	const walletArea = $('payment-wallet-area');
	const confirmBtn = $('payment-confirm-btn');
	if (!walletArea) return;

	if (connectedWallet) {
		const pk = connectedWallet.publicKey.toBase58();
		walletArea.innerHTML = `
			<p>Connected via <strong>${escapeHtml(connectedWallet.name)}</strong>: ${pk.slice(0, 4)}…${pk.slice(-4)}</p>
			<button class="btn-secondary" id="payment-disconnect-btn">Disconnect</button>
		`;
		$('payment-disconnect-btn').addEventListener('click', disconnectWallet);
		if (confirmBtn) confirmBtn.disabled = false;
		return;
	}

	const available = listAvailableWallets();
	if (!available.length) {
		walletArea.innerHTML = `
			<p class="muted">No browser wallet detected.</p>
			<button class="btn-primary" id="payment-show-qr">Use a mobile wallet (QR)</button>
			<p class="muted small">Install <a href="https://phantom.app" target="_blank" rel="noopener">Phantom</a>,
			<a href="https://solflare.com" target="_blank" rel="noopener">Solflare</a>, or
			<a href="https://backpack.app" target="_blank" rel="noopener">Backpack</a>.</p>
		`;
	} else {
		const btns = available.map((w) =>
			`<button class="btn-primary wallet-pick" data-wallet="${w.key}">Connect ${escapeHtml(w.name)}</button>`
		).join('');
		walletArea.innerHTML = `
			${btns}
			<button class="btn-secondary" id="payment-show-qr">Use a mobile wallet (QR)</button>
		`;
		walletArea.querySelectorAll('.wallet-pick').forEach((btn) => {
			btn.addEventListener('click', async () => {
				const key = btn.dataset.wallet;
				btn.textContent = 'Connecting…';
				btn.disabled = true;
				try { await connectWalletProvider(key); }
				catch (e) {
					const name = WALLET_PROVIDERS.find((p) => p.key === key)?.name ?? key;
					btn.textContent = `Connect ${name}`;
					btn.disabled = false;
					setStatus(e.message, 'err');
				}
			});
		});
	}
	$('payment-show-qr')?.addEventListener('click', startQrPurchase);
	if (confirmBtn) confirmBtn.disabled = true;
}

function setStatus(text, kind) {
	const el = $('payment-status');
	if (!el) return;
	el.textContent = text;
	el.className = 'payment-status' + (kind ? ' ' + kind : '');
}

// ── Payment modal chrome helpers ──────────────────────────────────────────
//
// The same modal is reused by skill / time-pass / asset flows. These helpers
// keep title + sub-badge + success card in sync so each flow reads naturally
// to the user (e.g. "Get 2h access" with an expiry badge, not "Unlock Skill"
// with no hint that the access is temporary).

function setPaymentTitle(text) {
	const el = $('payment-modal-title');
	if (el) el.textContent = text;
}

function setPaymentLede(text) {
	const el = $('payment-modal-lede');
	if (el) el.textContent = text;
}

function setPaymentFromLabel(text) {
	const el = $('payment-item-from');
	if (el) el.textContent = text;
}

function setPaymentBadge(html, kind) {
	const el = $('payment-modal-badge');
	if (!el) return;
	if (!html) {
		el.hidden = true;
		el.innerHTML = '';
		el.className = 'payment-modal-badge';
		return;
	}
	el.hidden = false;
	el.className = 'payment-modal-badge' + (kind ? ' ' + kind : '');
	el.innerHTML = html;
}

// Swap the modal into "success" mode: persistent confirmation card with a
// one-click path to use what was just bought. No auto-close — the user
// decides when to dismiss, and we surface a clear next step (View / Done).
function renderPaymentSuccess({ title, message, primaryHref, primaryLabel, secondaryLabel = 'Done' }) {
	const body = $('payment-modal-body');
	const success = $('payment-modal-success');
	if (!body || !success) return;
	body.hidden = true;
	const primary = primaryHref
		? `<a class="btn-primary" href="${escapeHtml(primaryHref)}" data-success-primary>${escapeHtml(primaryLabel || 'View')}</a>`
		: '';
	success.innerHTML = `
		<div class="ps-check" aria-hidden="true">✓</div>
		<h3 class="ps-title">${escapeHtml(title)}</h3>
		${message ? `<p class="ps-sub">${escapeHtml(message)}</p>` : ''}
		<div class="ps-actions">
			${primary}
			<button type="button" class="btn-secondary" data-success-close>${escapeHtml(secondaryLabel)}</button>
		</div>`;
	success.hidden = false;
	success.querySelector('[data-success-close]')?.addEventListener('click', closePaymentModal);
}

// Swap the body's status row into a "verify again" card when server-side
// confirmation times out. The on-chain transfer already landed — only the
// indexer/poll didn't catch it in 60s. Users must NOT re-pay; they need a
// way to re-poll. Surface the txid so they can also check Solscan directly.
function renderPaymentVerifyAgain({ txid, message, retryFn }) {
	const status = $('payment-status');
	const confirmBtn = $('payment-confirm-btn');
	if (confirmBtn) confirmBtn.hidden = true;
	if (!status) return;
	const explorer = txid ? `https://solscan.io/tx/${encodeURIComponent(txid)}` : '';
	status.className = 'payment-status';
	status.innerHTML = `
		<div class="payment-modal-retry">
			<p>${escapeHtml(message || "We couldn't confirm with the server in time. Your payment is safe — re-verify below.")}</p>
			${explorer ? `<div class="retry-tx">Tx: <a href="${escapeHtml(explorer)}" target="_blank" rel="noopener">${escapeHtml(txid.slice(0, 12))}…</a></div>` : ''}
			<div class="retry-actions">
				<button type="button" class="retry-primary" data-retry-verify>Verify again</button>
				<button type="button" class="retry-secondary" data-retry-close>Close</button>
			</div>
		</div>`;
	const retryBtn = status.querySelector('[data-retry-verify]');
	retryBtn?.addEventListener('click', async () => {
		retryBtn.disabled = true;
		retryBtn.textContent = 'Verifying…';
		try {
			await retryFn();
		} catch (err) {
			retryBtn.disabled = false;
			retryBtn.textContent = 'Verify again';
			setStatus(err.message || 'Verification failed', 'err');
		}
	});
	status.querySelector('[data-retry-close]')?.addEventListener('click', closePaymentModal);
}

function closePaymentModal() {
	$('payment-modal-overlay').hidden = true;
	const qr = $('payment-qr'); if (qr) qr.innerHTML = '';
	const confirmBtn = $('payment-confirm-btn');
	if (confirmBtn) {
		delete confirmBtn.dataset.durationHours;
		delete confirmBtn.dataset.mode;
		confirmBtn.hidden = false;
		confirmBtn.disabled = true;
	}
	// Reset success/body visibility so the next open() shows the form, not
	// the last purchase's confirmation card.
	const body = $('payment-modal-body');
	const success = $('payment-modal-success');
	if (body) body.hidden = false;
	if (success) { success.hidden = true; success.innerHTML = ''; }
	setPaymentBadge('');
	setStatus('');
	pendingAssetPurchase = null;
}

function shortMintLabel(mint) {
	if (mint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') return 'USDC';
	if (mint === 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB') return 'USDT';
	return mint.slice(0, 4) + '…';
}



async function openTimePassFlow(agentId, skill, durationHours, btn) {
	if (!detailState?.agent || detailState.agent.id !== agentId) {
		alert('Agent not loaded; refresh and try again.');
		return;
	}
	const price = detailState.agent.skill_prices?.[skill];
	if (!price) { alert('No price set for this skill.'); return; }

	if (btn) {
		btn.disabled = true;
		btn.textContent = 'Preparing…';
	}

	// Open the normal purchase modal but with duration set, so the purchase
	// will create a time-pass row. We pass duration_hours in the body.
	setPaymentTitle(`Get ${durationHours}h access`);
	setPaymentLede('You are renting temporary access to this skill:');
	setPaymentFromLabel('on agent');
	setPaymentBadge(`<span class="payment-modal-badge-icon" aria-hidden="true">⏱</span><span>Access expires ${durationHours} hour${durationHours === 1 ? '' : 's'} after purchase. Not a permanent unlock.</span>`, 'warn');
	$('payment-skill-name').textContent = skill;
	$('payment-agent-name').textContent = detailState.agent.name;
	const tpAmount = price.time_pass_amount || price.amount;
	const decimals = Number(price.mint_decimals ?? 6);
	const human = (Number(tpAmount) / Math.pow(10, decimals)).toFixed(decimals === 6 ? 2 : 4);
	$('payment-price-display').textContent = `${human} ${shortMintLabel(price.currency_mint)}`;
	const qr = $('payment-qr'); if (qr) qr.innerHTML = '';
	setStatus('');
	$('payment-modal-overlay').hidden = false;
	updateWalletUI();

	// Store duration in a data attribute so handlePurchase can pick it up.
	const confirmBtn = $('payment-confirm-btn');
	confirmBtn.dataset.durationHours = String(durationHours);
	confirmBtn.textContent = `Pay & unlock ${durationHours}h access`;

	if (btn) {
		btn.disabled = false;
		btn.textContent = `Get ${durationHours}h access`;
	}
}

async function openTrialFlow(agentId, skill, btn) {
	if (!detailState?.agent || detailState.agent.id !== agentId) {
		alert('Agent not loaded; refresh and try again.');
		return;
	}
	if (btn) {
		btn.disabled = true;
		btn.textContent = 'Starting trial…';
	}
	try {
		const r = await apiPostWithCsrf('/api/marketplace/start-trial', { agent_id: agentId, skill });
		const j = await r.json().catch(() => ({}));
		if (!r.ok) {
			if (j.error === 'already_owned') {
				alert('You already own this skill.');
			} else if (j.error === 'trial_used') {
				alert('You have already used the trial for this skill.');
			} else {
				alert(j.error_description || j.error || 'Failed to start trial');
			}
			return;
		}
		await fetchUserPurchases();
		loadDetail(agentId);
	} catch (err) {
		alert(err.message || 'Failed to start trial');
	} finally {
		if (btn) {
			btn.disabled = false;
			btn.textContent = `Try free`;
		}
	}
}

async function openPurchaseFlow(agentId, skill) {
	if (!detailState?.agent || detailState.agent.id !== agentId) {
		alert('Agent not loaded; refresh and try again.');
		return;
	}
	const price = detailState.agent.skill_prices?.[skill];
	if (!price) { alert('No price set for this skill.'); return; }

	const decimals = Number(price.mint_decimals ?? 6);
	const human = (Number(price.amount) / Math.pow(10, decimals)).toFixed(decimals === 6 ? 2 : 4);

	setPaymentTitle('Unlock skill');
	setPaymentLede('You are purchasing permanent access to this skill:');
	setPaymentFromLabel('on agent');
	setPaymentBadge('');
	$('payment-skill-name').textContent = skill;
	$('payment-agent-name').textContent = detailState.agent.name;
	$('payment-price-display').textContent = `${human} ${shortMintLabel(price.currency_mint)}`;
	const confirmBtn = $('payment-confirm-btn');
	if (confirmBtn) confirmBtn.textContent = 'Confirm Purchase';
	const qr = $('payment-qr'); if (qr) qr.innerHTML = '';
	setStatus('');
	$('payment-modal-overlay').hidden = false;
	updateWalletUI();
}

// CSRF token cache; single-use, refetched lazily.
let _csrf = null;
async function getCsrfToken() {
	if (_csrf && _csrf.expiresAt > Date.now() + 5_000) return _csrf.token;
	const r = await fetch('/api/csrf-token', { credentials: 'include' });
	if (!r.ok) throw new Error('Could not obtain CSRF token; sign in again.');
	const j = await r.json();
	_csrf = { token: j.data.token, expiresAt: Date.now() + (j.data.expires_in - 30) * 1000 };
	return _csrf.token;
}
async function apiPostWithCsrf(url, body) {
	const token = await getCsrfToken();
	_csrf = null;
	return fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
		credentials: 'include',
		body: body == null ? undefined : JSON.stringify(body),
	});
}

async function createPendingPurchase(agentId, skill, durationHours = null) {
	const body = { agent_id: agentId, skill };
	if (durationHours) body.duration_hours = durationHours;
	const r = await apiPostWithCsrf('/api/marketplace/purchase', body);
	const j = await r.json();
	if (!r.ok) throw new Error(j.error_description || j.error || 'Failed to create purchase');
	return j.data;
}

// ── Asset purchase (avatar / agent / plugin) ──────────────────────────────
//
// Shares the payment modal UI with the skill purchase flow but routes to the
// generic /api/marketplace/buy-asset endpoint. The Confirm button reads
// `dataset.mode` to decide which handler runs, so the same modal can be
// re-used by both flows without duplicating wallet/UI plumbing.

let pendingAssetPurchase = null; // { item_type, item_id, label, price }

function openAssetPurchaseFlow(asset) {
	const confirmBtn = $('payment-confirm-btn');
	const skillName = $('payment-skill-name');
	const agentName = $('payment-agent-name');
	const priceDisplay = $('payment-price-display');
	if (!confirmBtn || !skillName || !priceDisplay) {
		alert('Payment UI not available on this page.');
		return;
	}

	pendingAssetPurchase = asset;
	confirmBtn.dataset.mode = 'asset';
	confirmBtn.disabled = false;
	confirmBtn.hidden = false;
	delete confirmBtn.dataset.durationHours;

	const typeLabel = asset.item_type ? asset.item_type.charAt(0).toUpperCase() + asset.item_type.slice(1) : 'Asset';
	setPaymentTitle(`Buy ${typeLabel}`);
	setPaymentLede(`You are buying this ${asset.item_type || 'asset'}:`);
	setPaymentFromLabel(typeLabel);
	setPaymentBadge('');
	confirmBtn.textContent = `Confirm purchase`;

	skillName.textContent = asset.label || 'Asset';
	// For assets the secondary line is just the type ("Avatar"), so suppress
	// the agent-name slot — there is no agent to attribute the purchase to.
	if (agentName) agentName.textContent = '';

	const decimals = Number(asset.price?.mint_decimals ?? 6);
	const human = (Number(asset.price?.amount || 0) / Math.pow(10, decimals)).toFixed(decimals === 6 ? 2 : 4);
	priceDisplay.textContent = `${human} ${shortMintLabel(asset.price?.currency_mint || '')}`;

	const qr = $('payment-qr'); if (qr) qr.innerHTML = '';
	setStatus('');
	$('payment-modal-overlay').hidden = false;
	updateWalletUI();
}

async function createPendingAssetPurchase(itemType, itemId) {
	const r = await apiPostWithCsrf('/api/marketplace/buy-asset', { item_type: itemType, item_id: itemId });
	const j = await r.json();
	if (!r.ok) throw new Error(j.error_description || j.error || 'Failed to create purchase');
	return j.data;
}

async function pollAssetConfirm(reference, windowMs = 60_000) {
	const deadline = Date.now() + windowMs;
	while (Date.now() < deadline) {
		const r = await apiPostWithCsrf(`/api/marketplace/buy-asset/${reference}/confirm`, null);
		const j = await r.json().catch(() => ({}));
		if (r.ok && j.data?.status === 'confirmed') return true;
		if (r.status === 410) throw new Error('Pending purchase expired. Please try again.');
		if (r.status === 409) throw new Error(j.error_description || 'Transfer did not match expected amount.');
		await new Promise((res) => setTimeout(res, 2500));
	}
	return false;
}

// Where to point the post-purchase "View" CTA for each asset type. Owned
// assets land in the user's dashboard, so the user can use them immediately
// without going back through the marketplace.
function assetViewTarget(asset) {
	const type = asset?.item_type;
	if (type === 'avatar') return { href: '/dashboard/avatars', label: 'View avatar' };
	if (type === 'agent') return { href: '/dashboard/agents', label: 'View agent' };
	if (type === 'plugin') return { href: '/dashboard', label: 'View plugin' };
	return { href: '/dashboard', label: 'View in dashboard' };
}

async function handleAssetPurchase() {
	const confirmBtn = $('payment-confirm-btn');
	const asset = pendingAssetPurchase;
	if (!asset) { setStatus('No asset selected.', 'err'); return; }
	if (!connectedWallet) { setStatus('Connect a wallet first.', 'err'); return; }

	confirmBtn.disabled = true;
	setStatus('Creating purchase…');

	let purchase;
	try {
		purchase = await createPendingAssetPurchase(asset.item_type, asset.item_id);
		if (purchase.already_owned) {
			const target = assetViewTarget(asset);
			renderPaymentSuccess({
				title: 'Already owned',
				message: `You already purchased ${asset.label}.`,
				primaryHref: target.href,
				primaryLabel: target.label,
			});
			return;
		}
	} catch (e) {
		setStatus(e.message, 'err');
		confirmBtn.disabled = false;
		return;
	}

	let txid;
	try {
		setStatus('Building transfer…');
		const tx = await buildSplTransferWithReference({
			payer: connectedWallet.publicKey,
			recipient: purchase.recipient,
			mint: purchase.currency_mint,
			amount: BigInt(purchase.amount),
			reference: purchase.reference,
		});

		setStatus('Approve in wallet…');
		if (typeof connectedWallet.provider.signAndSendTransaction === 'function') {
			const result = await connectedWallet.provider.signAndSendTransaction(tx);
			txid = result?.signature ?? result;
		} else {
			txid = await connectedWallet.provider.sendTransaction(tx, await getSolanaConnection());
		}

		setStatus('Waiting for on-chain confirmation…');
		await (await getSolanaConnection()).confirmTransaction(txid, 'confirmed');

		setStatus('Verifying with server…');
		const ok = await pollAssetConfirm(purchase.reference, 60_000);
		if (!ok) {
			renderPaymentVerifyAgain({
				txid,
				message: "We couldn't verify the transfer with the server in 60s. The on-chain transaction is safe — re-verify below.",
				retryFn: async () => {
					const ok2 = await pollAssetConfirm(purchase.reference, 60_000);
					if (!ok2) throw new Error('Still not confirmed — wait a few seconds and try again.');
					const target = assetViewTarget(asset);
					renderPaymentSuccess({
						title: `${asset.label} purchased`,
						message: `${asset.item_type === 'avatar' ? 'Your new avatar' : 'Your purchase'} is in your dashboard.`,
						primaryHref: target.href,
						primaryLabel: target.label,
					});
				},
			});
			return;
		}

		const target = assetViewTarget(asset);
		renderPaymentSuccess({
			title: `${asset.label} purchased`,
			message: `${asset.item_type === 'avatar' ? 'Your new avatar' : asset.item_type === 'agent' ? 'Your new agent' : 'Your purchase'} is in your dashboard.`,
			primaryHref: target.href,
			primaryLabel: target.label,
		});
	} catch (e) {
		console.error('[marketplace] asset purchase failed', e);
		// Differentiate "tx already sent, server lookup failing" from
		// "tx never built". If we have a txid, the user already paid and
		// must NOT be told to retry — surface the verify-again card.
		if (txid) {
			renderPaymentVerifyAgain({
				txid,
				message: e.message || 'Payment sent but verification failed — re-verify below.',
				retryFn: async () => {
					const ok2 = await pollAssetConfirm(purchase.reference, 60_000);
					if (!ok2) throw new Error('Still not confirmed — wait a few seconds and try again.');
					const target = assetViewTarget(asset);
					renderPaymentSuccess({
						title: `${asset.label} purchased`,
						message: `${asset.item_type === 'avatar' ? 'Your new avatar' : 'Your purchase'} is in your dashboard.`,
						primaryHref: target.href,
						primaryLabel: target.label,
					});
				},
			});
			return;
		}
		setStatus(e.message || 'Purchase failed', 'err');
		confirmBtn.disabled = false;
	}
}

async function handlePurchase() {
	const confirmBtn = $('payment-confirm-btn');
	// Asset purchases (avatar / agent / plugin) come through the same Confirm
	// button as skill purchases — the mode marker on the button decides which
	// backend flow to run.
	if (confirmBtn?.dataset.mode === 'asset') {
		return handleAssetPurchase();
	}
	if (!connectedWallet) { setStatus('Connect a wallet first.', 'err'); return; }
	if (!detailState?.agent) return;

	confirmBtn.disabled = true;
	setStatus('Creating purchase…');

	const agentId = detailState.agent.id;
	const skill = $('payment-skill-name').textContent;
	const durationHours = confirmBtn.dataset.durationHours ? Number(confirmBtn.dataset.durationHours) : null;

	const onUnlocked = async () => {
		await fetchUserPurchases();
		loadDetail(agentId);
		renderPaymentSuccess({
			title: durationHours ? `${durationHours}h access unlocked` : 'Skill unlocked',
			message: durationHours
				? `${skill} is now usable. Access ends ${durationHours} hour${durationHours === 1 ? '' : 's'} from now.`
				: `${skill} is now part of your library on ${detailState.agent.name}.`,
			primaryHref: null,
			secondaryLabel: 'Done',
		});
	};

	let purchase;
	try {
		purchase = await createPendingPurchase(agentId, skill, durationHours);
		if (purchase.already_owned) {
			await fetchUserPurchases();
			loadDetail(agentId);
			renderPaymentSuccess({
				title: 'Already unlocked',
				message: `You already have access to ${skill}.`,
				primaryHref: null,
				secondaryLabel: 'Continue',
			});
			return;
		}
	} catch (e) {
		setStatus(e.message, 'err');
		confirmBtn.disabled = false;
		return;
	}

	let txid;
	try {
		setStatus('Building transfer…');
		const tx = await buildSplTransferWithReference({
			payer: connectedWallet.publicKey,
			recipient: purchase.recipient,
			mint: purchase.currency_mint,
			amount: BigInt(purchase.amount),
			reference: purchase.reference,
		});

		setStatus('Approve in wallet…');
		if (typeof connectedWallet.provider.signAndSendTransaction === 'function') {
			const result = await connectedWallet.provider.signAndSendTransaction(tx);
			txid = result?.signature ?? result;
		} else {
			txid = await connectedWallet.provider.sendTransaction(tx, await getSolanaConnection());
		}

		setStatus('Waiting for on-chain confirmation…');
		await (await getSolanaConnection()).confirmTransaction(txid, 'confirmed');

		setStatus('Verifying with server…');
		const ok = await pollConfirm(purchase.reference, 60_000);
		if (!ok) {
			renderPaymentVerifyAgain({
				txid,
				message: "Payment is on-chain but the server hasn't seen it yet. Re-verify below.",
				retryFn: async () => {
					const ok2 = await pollConfirm(purchase.reference, 60_000);
					if (!ok2) throw new Error('Still not confirmed — wait a few seconds and try again.');
					await onUnlocked();
				},
			});
			return;
		}

		await onUnlocked();
	} catch (e) {
		console.error('[marketplace] purchase failed', e);
		if (txid) {
			renderPaymentVerifyAgain({
				txid,
				message: e.message || 'Payment sent but verification failed — re-verify below.',
				retryFn: async () => {
					const ok2 = await pollConfirm(purchase.reference, 60_000);
					if (!ok2) throw new Error('Still not confirmed — wait a few seconds and try again.');
					await onUnlocked();
				},
			});
			return;
		}
		setStatus(e.message || 'Purchase failed', 'err');
		confirmBtn.disabled = false;
	}
}

// Mobile-wallet path: render a Solana Pay QR. Buyer scans + signs on phone.
async function startQrPurchase() {
	if (!detailState?.agent) return;
	const agentId = detailState.agent.id;
	const skill = $('payment-skill-name').textContent;

	setStatus('Creating purchase…');
	let purchase;
	try {
		purchase = await createPendingPurchase(agentId, skill);
		if (purchase.already_owned) {
			await fetchUserPurchases();
			loadDetail(agentId);
			renderPaymentSuccess({
				title: 'Already unlocked',
				message: `You already have access to ${skill}.`,
				primaryHref: null,
				secondaryLabel: 'Continue',
			});
			return;
		}
	} catch (e) { setStatus(e.message, 'err'); return; }

	const decimals = Number(purchase.mint_decimals ?? 6);
	const human = (Number(purchase.amount) / Math.pow(10, decimals)).toString();
	const url = new URL(`solana:${purchase.recipient}`);
	url.searchParams.set('amount', human);
	url.searchParams.set('spl-token', purchase.currency_mint);
	url.searchParams.set('reference', purchase.reference);
	url.searchParams.set('label', purchase.label || `Skill: ${skill}`);
	url.searchParams.set('message', purchase.message || `Unlock '${skill}'`);

	const qrEl = $('payment-qr');
	if (qrEl) {
		qrEl.innerHTML = `<canvas id="payment-qr-canvas" width="240" height="240"></canvas>
			<p class="muted small">Scan with a Solana Pay wallet (Phantom mobile, Solflare mobile, etc.)</p>`;
		const QRCode = await import('qrcode');
		await (QRCode.default ?? QRCode).toCanvas(document.getElementById('payment-qr-canvas'), url.toString(), { width: 240 });
	}

	setStatus('Waiting for payment on your phone…');
	const ok = await pollConfirm(purchase.reference, 300_000);
	if (ok) {
		await fetchUserPurchases();
		loadDetail(agentId);
		renderPaymentSuccess({
			title: 'Skill unlocked',
			message: `${skill} is now part of your library on ${detailState.agent.name}.`,
			primaryHref: null,
			secondaryLabel: 'Done',
		});
	} else {
		// On QR flow we have no txid (buyer paid from their phone — txid is
		// known to the server only). Offer a verify-again that re-polls.
		renderPaymentVerifyAgain({
			txid: null,
			message: "No confirmation in 5 minutes. If you paid, re-verify below; otherwise the pending purchase will expire automatically.",
			retryFn: async () => {
				const ok2 = await pollConfirm(purchase.reference, 60_000);
				if (!ok2) throw new Error('Still no confirmation — give it another minute.');
				await fetchUserPurchases();
				loadDetail(agentId);
				renderPaymentSuccess({
					title: 'Skill unlocked',
					message: `${skill} is now part of your library on ${detailState.agent.name}.`,
					primaryHref: null,
					secondaryLabel: 'Done',
				});
			},
		});
	}
}

async function buildSplTransferWithReference({ payer, recipient, mint, amount, reference }) {
	const { web3, spl } = await loadSolanaModules();
	const { PublicKey, Transaction } = web3;
	const { getAssociatedTokenAddress, createTransferInstruction } = spl;

	const recipientKey = new PublicKey(recipient);
	const mintKey = new PublicKey(mint);
	const referenceKey = new PublicKey(reference);

	const fromAta = await getAssociatedTokenAddress(mintKey, payer);
	const toAta = await getAssociatedTokenAddress(mintKey, recipientKey);

	const ix = createTransferInstruction(fromAta, toAta, payer, amount);
	// Solana Pay: append the reference as a readonly, non-signer key so the
	// server can later locate this tx via getSignaturesForAddress(reference).
	ix.keys.push({ pubkey: referenceKey, isSigner: false, isWritable: false });

	const { blockhash } = await (await getSolanaConnection()).getLatestBlockhash('confirmed');
	const tx = new Transaction({ feePayer: payer, recentBlockhash: blockhash }).add(ix);
	return tx;
}

async function pollConfirm(reference, windowMs = 60_000) {
	const deadline = Date.now() + windowMs;
	while (Date.now() < deadline) {
		const r = await apiPostWithCsrf(`/api/marketplace/purchase/${reference}/confirm`, null);
		const j = await r.json().catch(() => ({}));
		if (r.ok && j.data?.status === 'confirmed') return true;
		if (j.status === 'tipped') {
			throw new Error('Payment received but amount/mint did not match — seller has been notified.');
		}
		if (r.status === 410) throw new Error('Pending purchase expired. Please try again.');
		if (r.status === 409 && !j.status) throw new Error(j.error_description || 'Transfer did not match.');
		await new Promise((res) => setTimeout(res, 2500));
	}
	return false;
}

function render() {
	const r = readRoute();

	document.querySelectorAll('.market-nav a[data-nav]').forEach((a) => {
		const nav = a.dataset.nav;
		const active =
			(nav === 'agent' && r.view === 'list' && r.filter !== 'avatars') ||
			(nav === 'agent' && r.view === 'detail') ||
			(nav === 'avatars' && r.view === 'list' && r.filter === 'avatars') ||
			(nav === 'tools' && r.view === 'tools') ||
			(nav === 'skills' && r.view === 'skills') ||
			(nav === 'mine' && r.view === 'mine') ||
			(nav === 'purchases' && r.view === 'purchases') ||
			(nav === 'earn' && r.view === 'earn');
		a.classList.toggle('active', active);
	});

	// Apply route-driven filter (e.g. ?tab=avatars selects the avatars chip).
	if (r.view === 'list' && r.filter && r.filter !== state.filter) {
		state.filter = r.filter;
		document.querySelectorAll('#market-filter-chips .market-chip').forEach((c) => {
			const isActive = c.dataset.filter === r.filter;
			c.classList.toggle('active', isActive);
			c.setAttribute('aria-selected', isActive ? 'true' : 'false');
		});
		// Re-render so the grid reflects the new filter without a refetch.
		if (state.publicAvatarsLoaded) renderGrid();
	}

	// Route-driven search + sort restore — refresh / back / forward all need
	// the controls to match the URL so the UI doesn't lie about what's loaded.
	if (r.view === 'list') {
		const routeQ = r.q || '';
		if (routeQ !== state.q) {
			state.q = routeQ;
			if (els.search && els.search.value !== routeQ) els.search.value = routeQ;
			state.publicAvatarsLoaded = false;
			state.onchainLoaded = false;
			loadList(true);
			loadPublicAvatars();
			loadOnchainAgents(true);
		}
		const routeSort = r.sort || 'recommended';
		if (routeSort !== state.sort) {
			state.sort = routeSort;
			if (els.sortSel && els.sortSel.value !== routeSort) els.sortSel.value = routeSort;
			loadList(true);
		}
	}

	// Route-driven tag filter — re-render whenever ?tag= changes.
	const newTag = r.tag ?? null;
	if (newTag !== state.tag) {
		state.tag = newTag;
		renderGrid();
	}

	const skillsSec = $('market-skills-section');
	const mineSec = $('market-mine');
	const purchasesSec = $('market-purchases');
	const earnSec = $('market-earn');
	const discovery = els.discovery;
	const tools = els.tools;
	const detail = els.detail;

	const setHidden = (el, hidden) => { if (el) el.hidden = hidden; };

	const avatarDetailSec = $('market-avatar-detail');
	// Leaving the avatar-detail view: clear the cached id so re-entry reloads
	// cleanly, and restore the page's default social meta.
	if (r.view !== 'avatar-detail' && _avatarDetailId !== null) {
		_avatarDetailId = null;
		resetSocialMeta();
	}
	if (r.view === 'avatar-detail') {
		loadAvatarDetail(r.id);
		setHidden(discovery, true);
		setHidden(detail, true);
		setHidden(tools, true);
		setHidden(skillsSec, true);
		setHidden(mineSec, true);
		setHidden(purchasesSec, true);
		setHidden(earnSec, true);
		setHidden(avatarDetailSec, false);
		avatarDetailSec?.scrollIntoView({ behavior: 'instant', block: 'start' });
	} else if (r.view === 'detail') {
		loadDetail(r.id);
		setHidden(discovery, true);
		setHidden(tools, true);
		setHidden(skillsSec, true);
		setHidden(mineSec, true);
		setHidden(purchasesSec, true);
		setHidden(earnSec, true);
		setHidden(avatarDetailSec, true);
		setHidden(detail, false);
	} else if (r.view === 'tools') {
		setHidden(detail, true);
		setHidden(discovery, true);
		setHidden(skillsSec, true);
		setHidden(mineSec, true);
		setHidden(purchasesSec, true);
		setHidden(earnSec, true);
		setHidden(avatarDetailSec, true);
		setHidden(tools, false);
		if (!pluginState.loaded) loadPlugins(true);
	} else if (r.view === 'skills') {
		setHidden(detail, true);
		setHidden(discovery, true);
		setHidden(tools, true);
		setHidden(mineSec, true);
		setHidden(purchasesSec, true);
		setHidden(earnSec, true);
		setHidden(avatarDetailSec, true);
		setHidden(skillsSec, false);
		loadSkillsTab();
	} else if (r.view === 'mine') {
		setHidden(detail, true);
		setHidden(discovery, true);
		setHidden(tools, true);
		setHidden(skillsSec, true);
		setHidden(purchasesSec, true);
		setHidden(earnSec, true);
		setHidden(avatarDetailSec, true);
		setHidden(mineSec, false);
		loadMine();
	} else if (r.view === 'purchases') {
		setHidden(detail, true);
		setHidden(discovery, true);
		setHidden(tools, true);
		setHidden(skillsSec, true);
		setHidden(mineSec, true);
		setHidden(avatarDetailSec, true);
		setHidden(earnSec, true);
		setHidden(purchasesSec, false);
		loadPurchases();
	} else if (r.view === 'earn') {
		setHidden(detail, true);
		setHidden(discovery, true);
		setHidden(tools, true);
		setHidden(skillsSec, true);
		setHidden(mineSec, true);
		setHidden(purchasesSec, true);
		setHidden(avatarDetailSec, true);
		setHidden(earnSec, false);
		loadEarnTab();
	} else {
		setHidden(detail, true);
		setHidden(avatarDetailSec, true);
		setHidden(tools, true);
		setHidden(skillsSec, true);
		setHidden(mineSec, true);
		setHidden(purchasesSec, true);
		setHidden(earnSec, true);
		setHidden(discovery, false);
		document.title = 'Agent Marketplace · three.ws';
	}
}

function init() {
	bindEvents();
	loadCategories();
	loadList(true);
	loadTheme();
	initPlugins();
	fetchUserPurchases();
	loadCurrentUser();
	bindDetailExtras({ navTo, openAvatarModal });
	render();
}

// Cached current user id. Used by the sell/buy panels to decide whether the
// viewer is the owner of the asset (and therefore should see the editor) or
// a potential buyer (and therefore should see the Buy button). Anonymous
// visitors get `null` and only see the buyer side.
let currentUserId = null;
async function loadCurrentUser() {
	try {
		const r = await fetch('/api/auth/me', { credentials: 'include' });
		if (!r.ok) return;
		const j = await r.json();
		currentUserId = j?.user?.id || j?.data?.id || j?.id || null;
	} catch {
		// non-fatal — page works fully for anonymous viewers
	}
}

// ── Plugin Marketplace ────────────────────────────────────────────────────────

const PLUGIN_API = '/api/plugins';
const PLUGIN_STORAGE_KEY = 'installed_plugins_v1';

const pluginState = {
	category: null,
	q: '',
	cursor: null,
	items: [],
	loading: false,
	loaded: false,
};

function getInstalledIds() {
	try {
		const raw = localStorage.getItem(PLUGIN_STORAGE_KEY);
		if (!raw) return new Set();
		return new Set(JSON.parse(raw).map((p) => p.identifier));
	} catch {
		return new Set();
	}
}

function saveInstalled(manifest) {
	try {
		const raw = localStorage.getItem(PLUGIN_STORAGE_KEY);
		const arr = raw ? JSON.parse(raw) : [];
		const idx = arr.findIndex((p) => p.identifier === manifest.identifier);
		if (idx >= 0) arr[idx] = manifest;
		else arr.push(manifest);
		localStorage.setItem(PLUGIN_STORAGE_KEY, JSON.stringify(arr));
	} catch {
		// storage full
	}
}

function removeInstalled(identifier) {
	try {
		const raw = localStorage.getItem(PLUGIN_STORAGE_KEY);
		if (!raw) return;
		const arr = JSON.parse(raw).filter((p) => p.identifier !== identifier);
		localStorage.setItem(PLUGIN_STORAGE_KEY, JSON.stringify(arr));
	} catch {}
}

function togglePluginInstall(manifest) {
	const installed = getInstalledIds();
	if (installed.has(manifest.identifier)) {
		removeInstalled(manifest.identifier);
	} else {
		saveInstalled(manifest);
		// fire-and-forget counter update if plugin has a DB id
		if (manifest.id) {
			fetch(`${PLUGIN_API}/${manifest.id}/install`, { method: 'POST' }).catch(() => {});
		}
	}
	renderPluginGrid();
}

async function loadPluginCategories() {
	try {
		const r = await fetch(`${PLUGIN_API}/categories`);
		const j = await r.json();
		renderPluginCats(j?.data?.categories || []);
	} catch {
		// non-fatal
	}
}

function renderPluginCats(cats) {
	const el = $('plugin-cats');
	if (!el) return;
	const all = [{ slug: null, label: 'All', count: null }, ...cats.map((cat) => ({
		slug: cat.slug,
		label: cat.slug.charAt(0).toUpperCase() + cat.slug.slice(1),
		count: cat.count,
	}))];
	el.innerHTML = all.map((cat) => {
		const active = pluginState.category === cat.slug;
		return `<div class="cat-row${active ? ' active' : ''}" data-cat="${cat.slug ?? ''}">
			<span>${escapeHtml(cat.label)}</span>
			${cat.count != null ? `<span class="count">${cat.count}</span>` : ''}
		</div>`;
	}).join('');
	el.querySelectorAll('.cat-row').forEach((row) => {
		row.addEventListener('click', () => {
			pluginState.category = row.dataset.cat || null;
			el.querySelectorAll('.cat-row').forEach((r) => r.classList.remove('active'));
			row.classList.add('active');
			loadPlugins(true);
		});
	});
}

async function loadPlugins(reset = false) {
	if (pluginState.loading) return;
	pluginState.loading = true;
	if (reset) {
		pluginState.items = [];
		pluginState.cursor = null;
		const grid = $('plugin-grid');
		if (grid) grid.innerHTML = '<div class="market-empty">Loading…</div>';
	}
	try {
		const url = new URL(PLUGIN_API + '/list', location.origin);
		if (pluginState.category) url.searchParams.set('category', pluginState.category);
		if (pluginState.q) url.searchParams.set('q', pluginState.q);
		if (pluginState.cursor) url.searchParams.set('cursor', pluginState.cursor);
		const r = await fetch(url);
		const j = await r.json();
		const items = j?.data?.items || [];
		pluginState.items = reset ? items : [...pluginState.items, ...items];
		pluginState.cursor = j?.data?.next_cursor || null;
		pluginState.loaded = true;
		renderPluginGrid();
	} catch {
		const grid = $('plugin-grid');
		if (grid) grid.innerHTML = '<div class="market-empty">Failed to load plugins.</div>';
	} finally {
		pluginState.loading = false;
	}
}

function renderPluginGrid() {
	const grid = $('plugin-grid');
	const more = $('plugin-loadmore');
	if (!grid) return;
	const installed = getInstalledIds();
	if (!pluginState.items.length) {
		grid.innerHTML = '<div class="market-empty">No plugins found.</div>';
		if (more) more.hidden = true;
		return;
	}
	grid.innerHTML = pluginState.items.map((p) => renderPluginCard(p, installed)).join('');
	grid.querySelectorAll('[data-plugin-id]').forEach((btn) => {
		btn.addEventListener('click', () => {
			const id = btn.dataset.pluginId;
			const pluginUuid = btn.dataset.pluginUuid || null;
			const isPaid = btn.dataset.pluginPaid === '1';
			const plugin = pluginState.items.find((p) => p.identifier === id);
			if (!plugin) return;

			// Paid plugins go through the asset purchase flow first; only
			// installed (already-purchased) ones can be added to the agent.
			if (isPaid && pluginUuid && !installed.has(id)) {
				openAssetPurchaseFlow({
					item_type: 'plugin',
					item_id: pluginUuid,
					label: plugin.name || id,
					price: plugin.price,
				});
				return;
			}
			togglePluginInstall(plugin.manifest_json ?? plugin);
		});
	});
	if (more) more.hidden = !pluginState.cursor;
}

function renderPluginCard(p, installed) {
	const manifest = p.manifest_json ?? p;
	const title = escapeHtml(p.name || manifest?.meta?.title || p.identifier || '?');
	const desc = escapeHtml(p.description || manifest?.meta?.description || '');
	const tags = (p.tags || manifest?.meta?.tags || []).slice(0, 3);
	const toolCount = Array.isArray(manifest?.api) ? manifest.api.length : 0;
	const isInstalled = installed.has(p.identifier);
	const cat = escapeHtml(p.category || manifest?.meta?.category || 'general');
	const icon = (p.name || p.identifier || '?')[0].toUpperCase();
	const priceBadge = priceBadgeHtml(p.price);
	return `<div class="plugin-card" style="position:relative">
		${priceBadge}
		<div class="head">
			<div class="avatar">${icon}</div>
			<div style="min-width:0;flex:1">
				<div class="title">${title}</div>
				<div class="author">${toolCount} tool${toolCount !== 1 ? 's' : ''} · ${cat}</div>
			</div>
		</div>
		<div class="desc">${desc}</div>
		<div class="plugin-tags">
			${tags.map((t) => `<span class="tag-pill">${escapeHtml(t)}</span>`).join('')}
		</div>
		<div class="plugin-card-footer">
			<span class="stat-pill">↓ ${p.install_count || 0}</span>
			<button class="plugin-install-btn${isInstalled ? ' installed' : ''}"
				data-plugin-id="${escapeHtml(p.identifier)}"
				data-plugin-uuid="${escapeHtml(p.id || '')}"
				data-plugin-paid="${hasActivePrice(p.price) ? '1' : '0'}">
				${isInstalled ? 'Installed ✓' : hasActivePrice(p.price) ? `Buy ${escapeHtml(formatAssetPrice(p.price))}` : 'Add to Agent'}
			</button>
		</div>
	</div>`;
}

// ── Add by URL modal ──────────────────────────────────────────────────────────

function openPluginUrlModal() {
	const modal = $('plugin-url-modal');
	const input = $('plugin-url-input');
	const errEl = $('plugin-url-error');
	const preview = $('plugin-url-preview');
	if (!modal) return;
	input.value = '';
	errEl.hidden = true;
	preview.hidden = true;
	preview.innerHTML = '';
	modal.hidden = false;
	input.focus();
}

function closePluginUrlModal() {
	const modal = $('plugin-url-modal');
	if (modal) modal.hidden = true;
}

async function fetchAndInstallByUrl() {
	const input = $('plugin-url-input');
	const errEl = $('plugin-url-error');
	const preview = $('plugin-url-preview');
	const fetchBtn = $('plugin-url-fetch');
	const url = (input?.value || '').trim();

	errEl.hidden = true;
	preview.hidden = true;

	if (!url) {
		showPluginUrlError('Please enter a URL.');
		return;
	}

	fetchBtn.disabled = true;
	fetchBtn.textContent = 'Fetching…';

	try {
		const r = await fetch(`${PLUGIN_API}/import`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ manifest_url: url }),
		});
		const j = await r.json();
		if (!r.ok) {
			showPluginUrlError(j?.error_description || `Error ${r.status}`);
			return;
		}
		const manifest = j?.data?.manifest;
		if (!manifest) {
			showPluginUrlError('Server returned no manifest.');
			return;
		}

		// Show preview
		const title = escapeHtml(manifest.meta?.title || manifest.identifier || '?');
		const desc = escapeHtml(manifest.meta?.description || '');
		const toolCount = Array.isArray(manifest.api) ? manifest.api.length : 0;
		preview.innerHTML = `<div class="plugin-preview-head">
			<strong>${title}</strong>
			<span class="muted">${toolCount} tool${toolCount !== 1 ? 's' : ''}</span>
		</div>
		${desc ? `<div class="plugin-preview-desc">${desc}</div>` : ''}
		<button class="plugin-modal-btn plugin-modal-btn-primary" id="plugin-url-install">Install Plugin</button>`;
		preview.hidden = false;

		$('plugin-url-install').addEventListener('click', () => {
			saveInstalled(manifest);
			closePluginUrlModal();
			// Refresh grid to show updated install state
			renderPluginGrid();
		});
	} catch (err) {
		showPluginUrlError(err.message || 'Failed to fetch manifest.');
	} finally {
		fetchBtn.disabled = false;
		fetchBtn.textContent = 'Fetch & Validate';
	}
}

function showPluginUrlError(msg) {
	const el = $('plugin-url-error');
	if (!el) return;
	el.textContent = msg;
	el.hidden = false;
}

// ── Plugin init / wiring ──────────────────────────────────────────────────────

function initPlugins() {
	// Add by URL button
	const addBtn = $('plugin-add-url');
	if (addBtn) addBtn.addEventListener('click', openPluginUrlModal);

	// Modal controls
	const cancelBtn = $('plugin-url-cancel');
	if (cancelBtn) cancelBtn.addEventListener('click', closePluginUrlModal);

	const fetchBtn = $('plugin-url-fetch');
	if (fetchBtn) fetchBtn.addEventListener('click', fetchAndInstallByUrl);

	// Close on overlay click
	const overlay = $('plugin-url-modal');
	if (overlay) {
		overlay.addEventListener('click', (e) => {
			if (e.target === overlay) closePluginUrlModal();
		});
	}

	// Plugin search
	let pluginSearchTimer;
	const searchInput = $('plugin-search');
	if (searchInput) {
		searchInput.addEventListener('input', (e) => {
			clearTimeout(pluginSearchTimer);
			pluginSearchTimer = setTimeout(() => {
				pluginState.q = e.target.value.trim();
				loadPlugins(true);
			}, 200);
		});
	}

	// Load more
	const loadMoreBtn = $('plugin-loadmore');
	if (loadMoreBtn) loadMoreBtn.addEventListener('click', () => loadPlugins(false));

	// Load categories (lazy — don't block initial page render)
	loadPluginCategories();
}

init();

