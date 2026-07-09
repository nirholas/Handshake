
/**
 * Agent Marketplace — discovery + detail page controller.
 *
 * Two views in one SPA: list (with category sidebar + search) and detail
 * (5 tabs). Routing is path-based: /marketplace and /marketplace/agents/:id.
 */


import {
	renderDetailAvatar,
	renderDetailModelStage,
	startPreviewSession,
	submitPreviewMessage,
	openCreatorModal,
	closeCreatorModal,
	bindMobileSidebar,
	bindDetailExtras,
} from './marketplace-detail.js';
import { onchainBadgeHTML } from './shared/onchain-badge.js';
import { safeUrl } from './safe-url.js';
import { walletChipHTML, walletChipEl, wireWalletChips } from './shared/agent-wallet-chip.js';
import { seeInWorldHref, hasCustomAvatar } from './shared/agent-3d.js';
import { coinChipHTML } from './shared/agent-coin.js';
import { skeletonHTML, emptyStateHTML, errorStateHTML, ensureStateKitStyles } from './shared/state-kit.js';
import { debounce, syncStateToUrl } from './shared/list-controls.js';
import { log } from './shared/log.js';
import { track, trackError, ANALYTICS_EVENTS } from './analytics.js';
ensureStateKitStyles();

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
		log.error('[marketplace] purchases', err);
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
		log.error('[marketplace] bookmarks', err);
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
		log.error('[marketplace] toggle bookmark', err);
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

// Labels for 3D model_category values — what a model IS, not how it was created.
const MODEL_CATEGORY_LABELS = {
	avatar: 'Avatar',
	accessory: 'Accessory',
	item: 'Item',
	scene: 'Scene',
	creature: 'Creature',
	vehicle: 'Vehicle',
	other: 'Other',
};

// Icon glyphs shown on model category badges inside cards.
const MODEL_CATEGORY_ICONS = {
	avatar: '◉',
	accessory: '◈',
	item: '◇',
	scene: '▦',
	creature: '◆',
	vehicle: '▷',
	other: '○',
};

const state = {
	category: null, // null = Discover (all) — agent category
	modelCategory: null, // null = all 3D types — avatar/accessory/item/scene/creature/vehicle
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
	publicAvatarsError: false, // last avatar-feed fetch failed → show retry, not "No public avatars"
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
	modelCatChips: $('market-model-category-chips'),
	grid: $('market-grid'),
	pulse: $('market-pulse'),
	pulseTrack: $('market-pulse-track'),
	search: $('market-search'),
	sortSel: $('market-sort'),
	loadMore: $('market-loadmore'),
	back: $('market-back'),
};

// ── Routing ───────────────────────────────────────────────────────────────

// Filter values that round-trip through ?tab= on the list view. Kept here so
// readRoute and syncFilterToUrl agree on which strings are valid.
const LIST_FILTER_TABS = new Set(['agents', 'avatars', 'onchain']);
const SORT_VALUES = new Set(['recommended', 'recent', 'popular', 'top_rated']);

function readRoute() {
	const m = location.pathname.match(/^\/marketplace\/agents\/([^/]+)/);
	if (m) return { view: 'detail', id: m[1] };
	const av = location.pathname.match(/^\/marketplace\/avatars\/([^/]+)/);
	if (av) return { view: 'avatar-detail', id: av[1] };
	const tl = location.pathname.match(/^\/marketplace\/tools\/([^/]+)/);
	if (tl) return { view: 'tool-detail', id: decodeURIComponent(tl[1]) };
	const sk = location.pathname.match(/^\/marketplace\/skills\/([^/]+)/);
	if (sk) return { view: 'skill-detail', id: decodeURIComponent(sk[1]) };
	const an = location.pathname.match(/^\/marketplace\/animations\/([^/]+)/);
	if (an) return { view: 'anim-detail', id: decodeURIComponent(an[1]) };
	const oc = location.pathname.match(/^\/marketplace\/onchain\/([^/]+)/);
	if (oc) return { view: 'onchain-detail', id: decodeURIComponent(oc[1]) };
	const params = new URLSearchParams(location.search);
	const tab = params.get('tab');
	const tag = (params.get('tag') || '').trim().toLowerCase().slice(0, 40) || null;
	const q = (params.get('q') || '').trim().slice(0, 200);
	const sort = SORT_VALUES.has(params.get('sort')) ? params.get('sort') : null;
	const pricing = params.get('pricing') === 'paid' || params.get('pricing') === 'free' ? params.get('pricing') : null;
	if (tab === 'tools') return { view: 'tools', tag };
	if (tab === 'skills') return { view: 'skills', tag };
	if (tab === 'mine') return { view: 'mine', tag };
	if (tab === 'purchases') return { view: 'purchases', tag };
	if (tab === 'earn') return { view: 'earn', tag };
	if (tab === 'animations') return { view: 'animations', tag };
	if (tab === 'memory') return { view: 'memory', tag };
	const filter = LIST_FILTER_TABS.has(tab) ? tab : 'all';
	return { view: 'list', filter, tag, q, sort, pricing };
}

// Push the current list-view filter/search/sort into the URL so back/forward
// and page refresh both restore the same view. Uses replaceState by default
// to avoid flooding history with every keystroke; pass push=true when the
// change is user-meaningful (filter chip click, sort change).
// URL params owned by the discovery list view, with the default value that
// drops the param from the URL (canonical short links). Shared with /discover's
// scheme conceptually via the same syncStateToUrl helper from the list-controls
// toolkit, so both surfaces write querystrings the same way.
const LIST_URL_DEFAULTS = { tab: '', q: '', sort: 'recommended', pricing: 'all' };

function syncFilterToUrl({ push = false } = {}) {
	if (!location.pathname.startsWith('/marketplace')) return;
	// Only sync from the discovery list view — detail / tools / mine views
	// own their own URLs and we shouldn't trample them.
	if (location.pathname !== '/marketplace') return;
	syncStateToUrl(
		{
			tab: LIST_FILTER_TABS.has(state.filter) ? state.filter : '',
			q: state.q || '',
			sort: state.sort || 'recommended',
			pricing: state.priceFilter || 'all',
		},
		LIST_URL_DEFAULTS,
		{ push },
	);
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
		if (!r.ok) throw new Error(`HTTP ${r.status}`);
		const j = await r.json();
		renderCategories(j.data);
	} catch (err) {
		log.error('[marketplace] categories', err);
		renderCategoriesError();
	}
}

// The category sidebar is secondary chrome — a failure here must never leave a
// blank rail. Render a compact, retryable error in its place; chips collapse to
// just "All" so the user can still browse the full catalog while categories are
// unavailable.
function renderCategoriesError() {
	if (els.cats) {
		els.cats.innerHTML = errorStateHTML({
			title: "Categories unavailable",
			body: "Couldn't load categories. You can still browse all agents.",
			scope: 'categories',
		});
		if (!els.cats.dataset.catErrBound) {
			els.cats.dataset.catErrBound = '1';
			els.cats.addEventListener('click', (e) => {
				if (e.target.closest('[data-sk-retry]')) loadCategories();
			});
		}
	}
	if (els.catChips) {
		// Degrade chips to a single "All" pill so the row isn't left empty.
		renderCategoryChips({ total: state.items.length, categories: [] });
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

async function loadList(reset = false, opts = {}) {
	if (state.loading) return;
	state.loading = true;
	if (reset) {
		state.items = [];
		state.cursor = null;
		els.grid.setAttribute('aria-busy', 'true');
		els.grid.innerHTML = skeletonHTML(8, 'card');
	}
	try {
		const url = new URL(`${API}/marketplace/agents`, location.origin);
		if (state.category) url.searchParams.set('category', state.category);
		if (state.q) url.searchParams.set('q', state.q);
		if (state.sort) url.searchParams.set('sort', state.sort);
		// Paid/Free filter is resolved server-side so pagination stays correct.
		if (state.priceFilter && state.priceFilter !== 'all')
			url.searchParams.set('pricing', state.priceFilter);
		if (state.cursor) url.searchParams.set('cursor', state.cursor);
		const r = await fetch(url);
		if (!r.ok) throw new Error(`HTTP ${r.status}`);
		const j = await r.json();
		// Real endpoint wraps as { data: { items, next_cursor } }; legacy mock returns a bare array.
		const rawItems = Array.isArray(j) ? j : (j?.data?.items ?? []);
		const nextCursor = Array.isArray(j) ? null : (j?.data?.next_cursor ?? null);
		const items = rawItems.filter((a) => !isAutoNamedAgent(a.name));
		state.items = reset ? items : [...state.items, ...items];
		state.cursor = nextCursor;
		renderGrid();
	} catch (err) {
		log.error('[marketplace] list', err);
		els.grid.innerHTML = renderErrorState('agents');
	} finally {
		state.loading = false;
	}

	// A price-only refetch (agentsOnly) reuses the avatars/onchain already in
	// state — they're filtered client-side in renderGrid — so we skip reloading
	// them and avoid the flicker/extra requests.
	if (reset && !opts.agentsOnly) {
		loadPublicAvatars();
		loadFeatured();
		loadOnchainAgents(true);
		loadMarketplacePulse();
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
		if (state.modelCategory) url.searchParams.set('category', state.modelCategory);
		const r = await fetch(url);
		if (!r.ok) throw new Error(`HTTP ${r.status}`);
		const j = await r.json();
		const avatars = (j?.items || []).filter(
			(it) => it.kind === 'avatar' && it.glbUrl && !isAutoNamedAvatar(it.name),
		);
		state.publicAvatars = avatars;
		state.publicAvatarsLoaded = true;
		state.publicAvatarsError = false;
		state.stats = j?.totals || state.stats;
		renderGrid();
		updateOnchainChipCount();
	} catch (err) {
		log.error('[marketplace] public avatars', err);
		// Flip the loaded flag so renderGrid() stops showing a perpetual skeleton
		// when avatars were the only thing the grid was waiting on. Retry is wired
		// through bindEmptyStateActions (data-retry-scope="avatars").
		state.publicAvatars = [];
		state.publicAvatarsLoaded = true;
		state.publicAvatarsError = true;
		if (gridWouldBeEmptyWithout('avatars')) {
			els.grid.removeAttribute('aria-busy');
			els.grid.innerHTML = renderErrorState('avatars');
		} else {
			renderGrid();
		}
	}
}

// True when nothing else (agents, onchain, or the other surface) currently has
// cards in the shared grid, so a failed load would leave it blank/stuck — the
// only case where it's safe to take over the grid with an error state.
function gridWouldBeEmptyWithout(failedScope) {
	const haveAgents = state.items.length > 0;
	const haveAvatars = failedScope !== 'avatars' && state.publicAvatars.length > 0;
	const haveOnchain = failedScope !== 'onchain' && state.onchainItems.length > 0;
	return !haveAgents && !haveAvatars && !haveOnchain;
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
		if (!r.ok) throw new Error(`HTTP ${r.status}`);
		const j = await r.json();
		const items = (j?.items || []).filter((it) => it.kind === 'onchain' && it.glbUrl);
		state.onchainItems = reset ? items : [...state.onchainItems, ...items];
		state.onchainCursor = j?.nextCursor || null;
		state.onchainLoaded = true;
		if (state.filter === 'onchain' || state.filter === 'all') renderGrid();
		updateOnchainChipCount();
	} catch (err) {
		log.error('[marketplace] onchain', err);
		// Mark loaded so the onchain tab doesn't sit on a forever-skeleton. Only
		// commandeer the grid with an error when there's nothing else to show;
		// otherwise leave the populated grid untouched. A pagination failure
		// (append) keeps the rows already on screen. Retry: data-retry-scope.
		state.onchainLoaded = true;
		const isOnchainView = state.filter === 'onchain' || state.filter === 'all';
		if (isOnchainView && reset && gridWouldBeEmptyWithout('onchain')) {
			els.grid.removeAttribute('aria-busy');
			els.grid.innerHTML = renderErrorState('onchain');
		} else if (isOnchainView) {
			renderGrid();
		}
		updateOnchainChipCount();
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
		log.error('[marketplace] lobby load', err);
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
	renderThemeSkeleton();
	try {
		const r = await fetch(`${API}/marketplace/theme`);
		if (!r.ok) throw new Error(`HTTP ${r.status}`);
		const j = await r.json();
		const theme = j?.data?.theme;
		if (!theme) {
			hideThemeStrip();
			return;
		}
		state.theme = theme;
		renderTheme();
	} catch (err) {
		log.error('[marketplace] theme', err);
		hideThemeStrip();
	}
}

// The weekly theme is an optional top-of-page strip. On failure (or an empty
// week) hide it cleanly so the shimmer placeholder from renderThemeSkeleton()
// never sticks on screen.
function hideThemeStrip() {
	const strip = $('market-theme-strip');
	const picks = $('market-theme-picks');
	if (picks) {
		picks.innerHTML = '';
		picks.hidden = true;
	}
	if (strip) strip.hidden = true;
}

// Show the strip with a shimmer immediately so the top of the page never pops
// in late. Replaced by the real lineup once /theme resolves.
function renderThemeSkeleton() {
	const strip = $('market-theme-strip');
	const picks = $('market-theme-picks');
	if (!strip || !picks) return;
	picks.hidden = false;
	picks.innerHTML = Array.from({ length: 6 })
		.map(
			() =>
				`<div class="market-theme-pick is-skeleton" aria-hidden="true"><div class="market-theme-pick-stage"></div><div class="market-theme-pick-meta"><span class="market-theme-pick-name">&nbsp;</span><span class="market-theme-pick-cat">&nbsp;</span></div></div>`,
		)
		.join('');
	strip.hidden = false;
}

function renderTheme() {
	const strip = $('market-theme-strip');
	if (!strip || !state.theme) return;
	const titleEl = $('market-theme-title');
	const blurbEl = $('market-theme-blurb');
	if (titleEl) titleEl.textContent = state.theme.title;
	if (blurbEl) blurbEl.textContent = state.theme.blurb || '';
	const cta = $('market-theme-cta');
	// The theme endpoint scopes by category (general = all). Wire the CTA to
	// browse that category; hide it for the catch-all "general" weeks.
	const cat = state.theme.category;
	if (cta && cat && cat !== 'general') {
		cta.hidden = false;
		cta.textContent = `Browse ${CATEGORY_LABELS[cat] || cat} →`;
		cta.onclick = () => {
			state.category = cat;
			state.cursor = null;
			loadList(true);
			if (typeof highlightCategoryChips === 'function') highlightCategoryChips();
			window.scrollTo({ top: 0, behavior: 'smooth' });
		};
	} else if (cta) {
		cta.hidden = true;
	}
	renderThemePicks();
	strip.hidden = false;
}

// Render the randomized 3D lineup. Every agent here is guaranteed (by the API)
// to carry a public avatar GLB, so each card shows a live rotating model. We
// reshuffle client-side too, so revisiting the page varies the order even when
// the API response is served from cache.
function renderThemePicks() {
	const row = $('market-theme-picks');
	if (!row) return;
	const all = (state.theme?.agents || []).filter((a) => a.avatar_glb_url);
	if (!all.length) {
		row.hidden = true;
		row.innerHTML = '';
		return;
	}
	const picks = shuffle(all.slice()).slice(0, 6);
	row.hidden = false;
	row.innerHTML = picks
		.map((a, i) => {
			const views = a.views_count || 0;
			const catLabel = CATEGORY_LABELS[a.category] || a.category || 'Agent';
			return `<button type="button" class="market-theme-pick" role="listitem" data-id="${escapeHtml(a.id)}" title="${escapeHtml(a.name || 'Agent')}" aria-label="${escapeHtml(a.name || 'Agent')} — ${fmtNumber(views)} views">
				<div class="market-theme-pick-stage">
					<span class="market-theme-pick-rank">#${i + 1}</span>
					${views > 0 ? `<span class="market-theme-pick-views">⊙ ${fmtNumber(views)}</span>` : ''}
					<span class="market-theme-pick-placeholder" aria-hidden="true">${escapeHtml(initial(a.name || 'A'))}</span>
					<model-viewer
						src="${escapeHtml(a.avatar_glb_url)}"
						alt="${escapeHtml(a.name || 'Agent')}"
						${a.thumbnail_url ? `poster="${escapeHtml(a.thumbnail_url)}"` : ''}
						auto-rotate
						autoplay
						rotation-per-second="22deg"
						interaction-prompt="none"
						disable-zoom
						disable-pan
						disable-tap
						exposure="1.05"
						shadow-intensity="0.5"
						tone-mapping="aces"
						loading="lazy"
						reveal="auto"
					></model-viewer>
				</div>
				<div class="market-theme-pick-meta">
					<span class="market-theme-pick-name">${escapeHtml(a.name || 'Untitled')}</span>
					<span class="market-theme-pick-cat">${escapeHtml(catLabel)}</span>
				</div>
			</button>`;
		})
		.join('');
	row.querySelectorAll('.market-theme-pick').forEach((card) => {
		card.addEventListener('click', () => navTo(`/marketplace/agents/${card.dataset.id}`));
		const mv = card.querySelector('model-viewer');
		if (mv) {
			mv.addEventListener('load', () => card.classList.add('mv-loaded'), { once: true });
			mv.addEventListener('poster-dismissed', () => card.classList.add('mv-loaded'), { once: true });
			// If a GLB 404s or is CORS-blocked, drop the card so the strip never
			// shows an empty stage.
			mv.addEventListener(
				'error',
				() => {
					card.remove();
					if (!row.querySelector('.market-theme-pick')) row.hidden = true;
				},
				{ once: true },
			);
		}
	});
}

// Fisher–Yates shuffle. Browser-only path, so Math.random is fine here.
function shuffle(arr) {
	for (let i = arr.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[arr[i], arr[j]] = [arr[j], arr[i]];
	}
	return arr;
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
		if (!r.ok) throw new Error(`HTTP ${r.status}`);
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
		log.error('[marketplace] featured', err);
		// The hero is a non-essential showcase — hide it cleanly on failure
		// rather than risk a half-rendered stage. renderHero() hides when there
		// are no featured items; the grid below carries the page on its own.
		state.featured = [];
		renderHero();
	}
}

// ── Live sales pulse ──────────────────────────────────────────────────────
//
// A marquee of the most recent skill purchases across the whole marketplace.
// It's social proof — a visitor lands and immediately sees real money moving
// through real agents. Pulls from /api/marketplace/analytics (the same feed
// behind the analytics page), so there's one source of truth for "what sold".
// The strip is decorative-but-real: it hides cleanly when the market is empty
// or the fetch fails, and only ever appears on the discovery list view.

// USDC/SOL are the mints that actually carry decimals we care about; everything
// else (agent coins, $THREE) defaults to 6, which is the SPL norm. We only need
// enough precision to render a believable amount, not to settle a transaction.
const PULSE_MINT_META = {
	EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: 'USDC', decimals: 6 },
	So11111111111111111111111111111111111111112: { symbol: 'SOL', decimals: 9 },
};

function pulseAmountLabel(atomic, mint) {
	const meta = PULSE_MINT_META[mint] || { symbol: shortMintLabel(mint || ''), decimals: 6 };
	const ui = Number(atomic || 0) / Math.pow(10, meta.decimals);
	if (!Number.isFinite(ui) || ui <= 0) return `Free · ${meta.symbol}`;
	const places = ui >= 100 ? 0 : ui >= 1 ? 2 : 4;
	return `${ui.toLocaleString(undefined, { maximumFractionDigits: places })} ${meta.symbol}`;
}

async function loadMarketplacePulse() {
	// Only the discovery list view has the strip; skip the work entirely on
	// detail/skills/etc. and when a search or category is narrowing the grid
	// (the global pulse would feel disconnected from a filtered result set).
	if (!els.pulse || !els.pulseTrack) return;
	if (state.q || state.category) {
		els.pulse.hidden = true;
		return;
	}
	try {
		const r = await fetch(`${API}/marketplace/analytics`, { credentials: 'include' });
		if (!r.ok) throw new Error(`HTTP ${r.status}`);
		const j = await r.json();
		const sales = (j?.data?.recentSales || []).filter((s) => s.agentId && s.agentName);
		renderMarketplacePulse(sales);
	} catch (err) {
		log.error('[marketplace] pulse', err);
		els.pulse.hidden = true;
	}
}

function pulseItemHTML(sale) {
	const skill = String(sale.skill || 'a skill').replace(/[-_]/g, ' ');
	const amount = pulseAmountLabel(sale.amountAtomic, sale.currencyMint);
	const when = liveTime(sale.confirmedAt);
	const avatar = sale.agentImage
		? `<img class="market-pulse-av" src="${escapeHtml(sale.agentImage)}" alt="" loading="lazy" decoding="async" />`
		: `<span class="market-pulse-av" aria-hidden="true">${escapeHtml(initial(sale.agentName))}</span>`;
	const verb = sale.trial ? 'started a trial of' : 'unlocked';
	const amtClass = sale.trial ? 'market-pulse-amt is-trial' : 'market-pulse-amt';
	return (
		`<a class="market-pulse-item" href="/marketplace/agents/${encodeURIComponent(sale.agentId)}" ` +
		`data-agent="${escapeHtml(sale.agentId)}" ` +
		`title="${escapeHtml(sale.agentName)} — ${escapeHtml(skill)}${when ? ` · ${when}` : ''}">` +
		`${avatar}` +
		`<span><b>${escapeHtml(sale.agentName)}</b> ` +
		`<span class="market-pulse-skill">${escapeHtml(verb)} ${escapeHtml(skill)}</span></span>` +
		`<span class="${amtClass}">${escapeHtml(amount)}</span>` +
		(when ? `<span class="market-pulse-time">${escapeHtml(when)}</span>` : '') +
		`</a>`
	);
}

function renderMarketplacePulse(sales) {
	if (!els.pulse || !els.pulseTrack) return;
	if (!sales.length) {
		els.pulse.hidden = true;
		return;
	}
	const items = sales.map(pulseItemHTML).join('');
	// Duplicate the run so the -50% keyframe translate lands exactly one full
	// set over, giving a seamless infinite loop. aria-hidden the clone so screen
	// readers announce each sale only once. Pace the scroll to the content so a
	// short feed doesn't whip past and a long one doesn't crawl.
	els.pulseTrack.innerHTML = items + `<span aria-hidden="true">${items}</span>`;
	const seconds = Math.min(90, Math.max(24, sales.length * 6));
	els.pulseTrack.style.setProperty('--pulse-duration', `${seconds}s`);
	els.pulse.hidden = false;
	els.pulseTrack.querySelectorAll('.market-pulse-item').forEach((a) => {
		a.addEventListener('click', (e) => {
			e.preventDefault();
			navTo(`/marketplace/agents/${a.dataset.agent}`);
		});
	});
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

	// Price-filter chips (Any / Free / Paid). Agents are re-fetched server-side
	// so paging stays correct; avatars and onchain rows are re-filtered in place
	// (renderGrid runs inside loadList once the refetch returns).
	const priceChips = document.querySelectorAll('#market-price-filter-chips .market-chip');
	priceChips.forEach((chip) => {
		chip.addEventListener('click', () => {
			const val = chip.dataset.priceFilter || 'all';
			if (val === state.priceFilter) return;
			priceChips.forEach((c) => c.classList.toggle('active', c === chip));
			state.priceFilter = val;
			syncFilterToUrl({ push: true });
			loadList(true, { agentsOnly: true });
		});
	});

	// Model-category chips — filter 3D models by what they ARE (avatar, accessory, etc.).
	// Visible only when avatars are in the current view. Selecting a category
	// re-fetches the explore API with category= so the filter is server-side.
	const modelCatChips = document.querySelectorAll('#market-model-category-chips .market-chip');
	modelCatChips.forEach((chip) => {
		chip.addEventListener('click', () => {
			modelCatChips.forEach((c) => c.classList.toggle('active', c === chip));
			state.modelCategory = chip.dataset.modelCat || null;
			state.publicAvatars = [];
			state.publicAvatarsLoaded = false;
			loadPublicAvatars();
			renderGrid();
		});
	});
}

function syncModelCatChips() {
	if (!els.modelCatChips) return;
	const showAvatars = state.filter === 'all' || state.filter === 'avatars';
	els.modelCatChips.hidden = !showAvatars;
	els.modelCatChips.querySelectorAll('.market-chip').forEach((c) => {
		const val = c.dataset.modelCat || null;
		c.classList.toggle('active', val === state.modelCategory || (val === '' && !state.modelCategory));
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
	syncModelCatChips();
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

	// Price filter (Free / Paid). Agents are already filtered server-side; this
	// pass keeps avatars (priced one-off only) and onchain in sync, and mirrors
	// the server definition for agents so a stale/cached row never slips through.
	// Onchain agents aren't sold through this surface, so "paid" excludes them.
	if (state.priceFilter === 'free') {
		agentItems = agentItems.filter((a) => !isAgentPaid(a));
		avatars = avatars.filter((a) => !hasActivePrice(a.price));
	} else if (state.priceFilter === 'paid') {
		agentItems = agentItems.filter((a) => isAgentPaid(a));
		avatars = avatars.filter((a) => hasActivePrice(a.price));
		onchain = [];
	}

	renderTagBanner();

	const totalCards = agentItems.length + avatars.length + onchain.length;

	const resultCountEl = $('market-result-count');
	if (resultCountEl) {
		resultCountEl.textContent = totalCards
			? `${totalCards} result${totalCards === 1 ? '' : 's'}`
			: '';
	}

	if (!totalCards) {
		const stillLoading =
			(!state.publicAvatarsLoaded && state.filter !== 'agents' && state.filter !== 'onchain') ||
			(!state.onchainLoaded && state.filter === 'onchain');
		if (stillLoading) {
			els.grid.innerHTML = renderSkeletons(8);
		} else if (
			state.publicAvatarsError &&
			(state.filter === 'avatars' || state.filter === 'all') &&
			!state.q && !state.tag && !state.category
		) {
			// The avatar feed failed (e.g. rate-limited) — "No public avatars" would
			// be a lie when the catalog has thousands. Offer a retry instead.
			els.grid.innerHTML = renderErrorState('avatars');
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

	els.grid.removeAttribute('aria-busy');
	els.grid.innerHTML = html;

	// Poster cache + shimmer-off for model-viewers.
	attachModelViewerBehavior();

	// Wire wallet-chip copy buttons + explorer links so they act on the chip and
	// don't bubble a click up to the card's detail-navigation handler.
	wireWalletChips(els.grid);

	// Kick off infinite scroll observation.
	if (hasMore) _setupInfiniteScroll();

	els.grid.querySelectorAll('[data-id]').forEach((card) => {
		card.addEventListener('click', (e) => {
			// Inner links (e.g. the on-chain badge → explorer) handle their own
			// navigation; don't also route to the agent detail page.
			if (e.target.closest('a')) return;
			const star = e.target.closest('.card-star');
			if (star) {
				e.stopPropagation();
				toggleAgentBookmarkFromCard(star.dataset.agentBm || '', star);
				return;
			}
			navTo(`/marketplace/agents/${card.dataset.id}`);
		});
		card.addEventListener('keydown', (e) => {
			// A focused inner link (See in 3D, on-chain badge) handles its own
			// activation — don't hijack Enter/Space to the detail page.
			if (e.target.closest('a')) return;
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				navTo(`/marketplace/agents/${card.dataset.id}`);
			}
		});
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
		card.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				const id = card.dataset.avatarId;
				if (id) navTo(`/marketplace/avatars/${encodeURIComponent(id)}`);
			}
		});
	});
	els.grid.querySelectorAll('[data-onchain-id]').forEach((card) => {
		const oid = card.dataset.onchainId;
		// Prefer the internal rich detail page; fall back to the external link
		// only when we lack the chain/agent ids needed to route internally.
		const go = (e) => {
			if (e && e.target.closest('a')) return;
			if (oid) navTo(`/marketplace/onchain/${encodeURIComponent(oid)}`);
			else if (card.dataset.onchainHref) location.href = card.dataset.onchainHref;
		};
		card.addEventListener('click', go);
		card.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
		});
	});

	// Card profile links — intercept normal left-clicks for SPA navigation so
	// the user stays in the single-page context. Ctrl/Cmd/middle-click falls
	// through to let the browser open in a new tab as expected.
	els.grid.querySelectorAll('.card-profile-link').forEach((link) => {
		link.addEventListener('click', (e) => {
			if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
			e.preventDefault();
			navTo(link.getAttribute('href'));
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
	const loadTimeout = setTimeout(() => {
		const label = progressEl.querySelector('.modal-load-label');
		if (label) label.textContent = 'Failed to load 3D — try refreshing.';
	}, 15_000);
	mv.addEventListener('error', () => {
		clearTimeout(loadTimeout);
		const label = progressEl.querySelector('.modal-load-label');
		if (label) label.textContent = 'Failed to load 3D model.';
	}, { once: true });
	mv.addEventListener('load', () => clearTimeout(loadTimeout), { once: true });

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
			? `by <a href="${escapeHtml(safeUrl(avatar.author.profileUrl))}" rel="author">${escapeHtml(avatar.author.displayName || avatar.author.handle)}</a>`
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
		log.warn('[marketplace] sale-panel fetch failed', err);
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

// ── Subscription tiers ────────────────────────────────────────────────────
//
// Renders the creator's recurring plans on the agent detail page. The detail
// API (api/marketplace/[action].js → handleDetail) returns active tiers in
// `agent.subscription_tiers` and the viewer's active plan in
// `agent.user_subscription`. The current plan is highlighted and switched to a
// "Manage subscription" action; the other tiers are disabled while subscribed
// so a viewer can't accidentally stack two plans on one agent.
function renderSubscriptionTiers(agent) {
	const section = $('subscription-tiers-section');
	const grid = $('tiers-grid');
	if (!section || !grid) return;

	const status = $('d-subs-status');
	if (status) {
		status.textContent = '';
		status.className = 'd-subs-status';
	}

	const tiers = Array.isArray(agent.subscription_tiers) ? agent.subscription_tiers : [];
	if (!tiers.length) {
		section.hidden = true;
		grid.innerHTML = '';
		return;
	}
	section.hidden = false;

	const userSub = agent.user_subscription || null;
	const isOwner = !!(currentUserId && agent.author_id && currentUserId === agent.author_id);

	const sub = $('d-subs-sub');
	if (sub) {
		sub.textContent = isOwner
			? 'These are the plans subscribers see. Edit them from the agent editor.'
			: userSub
				? 'You are subscribed — manage your plan below.'
				: 'Back this creator with a recurring plan and unlock everything it includes.';
	}

	grid.innerHTML = tiers
		.map((tier) => {
			const isCurrent = !!(userSub && userSub.plan_id === tier.id);
			const subscribedElsewhere = !!(userSub && !isCurrent);
			const intervalLabel = tier.interval === 'weekly' ? 'week' : 'month';
			const price = Number(tier.price_usd || 0).toFixed(2);
			const perks = Array.isArray(tier.perks) ? tier.perks.filter(Boolean) : [];
			const skillCount = Array.isArray(tier.included_skills) ? tier.included_skills.length : 0;

			const perksHtml = perks.length
				? `<ul class="tier-perks">${perks.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul>`
				: '<p class="tier-perks-empty">Recurring support for this creator.</p>';

			const skillLine = skillCount
				? `<div class="tier-skills">Unlocks ${skillCount} included skill${skillCount === 1 ? '' : 's'}</div>`
				: '';

			let btn;
			if (isOwner) {
				btn = '<button class="tier-btn" type="button" disabled>Your plan</button>';
			} else if (isCurrent) {
				btn = `<button class="tier-btn current" type="button" data-sub-manage="${escapeHtml(userSub.id)}">Manage subscription</button>`;
			} else if (subscribedElsewhere) {
				btn = '<button class="tier-btn" type="button" disabled title="Cancel your current plan to switch tiers">Subscribe</button>';
			} else {
				btn = `<button class="tier-btn primary" type="button" data-sub-plan="${escapeHtml(tier.id)}">Subscribe</button>`;
			}

			return `<div class="tier-card${isCurrent ? ' subscribed' : ''}" role="listitem">
					${isCurrent ? '<div class="tier-badge">Current plan</div>' : ''}
					<div class="tier-name">${escapeHtml(tier.name)}</div>
					<div class="tier-price">$${escapeHtml(price)}<span class="tier-interval">/ ${intervalLabel}</span></div>
					${skillLine}
					${perksHtml}
					${btn}
				</div>`;
		})
		.join('');
}

async function initiateSubscription(planId, btn) {
	if (!currentUserId) {
		location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
		return;
	}
	if (!detailState?.agent) return;
	const agent = detailState.agent;
	const tier = (agent.subscription_tiers || []).find((t) => t.id === planId);
	if (!tier) return;

	const intervalLabel = tier.interval === 'weekly' ? 'week' : 'month';
	const price = Number(tier.price_usd || 0).toFixed(2);
	const status = $('d-subs-status');

	const confirmed = window.confirm(
		`Subscribe to "${tier.name}" for $${price} per ${intervalLabel}? You'll pay in USDC each ${intervalLabel} and can cancel anytime.`,
	);
	if (!confirmed) return;

	if (btn) {
		btn.disabled = true;
		btn.textContent = 'Subscribing…';
	}
	if (status) {
		status.textContent = '';
		status.className = 'd-subs-status';
	}

	try {
		const r = await apiPostWithCsrf('/api/subscriptions', { plan_id: planId });
		const j = await r.json().catch(() => ({}));
		if (!r.ok) {
			const msg = j.error_description || j.error || 'Could not start subscription. Try again.';
			if (status) {
				status.textContent = msg;
				status.className = 'd-subs-status err';
			}
			if (btn) {
				btn.disabled = false;
				btn.textContent = 'Subscribe';
			}
			return;
		}

		const payUrl = j?.payment?.payUrl || null;
		// Refresh detail so the tier flips to "Current plan" and the others lock.
		await loadDetail(agent.id);

		// Reuse the polished payment success card for the confirmation + the
		// real first-payment link (server builds an x402 checkout intent).
		const overlay = $('payment-modal-overlay');
		if (overlay) overlay.hidden = false;
		renderPaymentSuccess({
			title: 'Subscription started',
			message: payUrl
				? `You're subscribed to ${tier.name}. Complete your first ${intervalLabel}'s payment to activate every perk.`
				: `You're subscribed to ${tier.name}.`,
			primaryHref: payUrl,
			primaryLabel: payUrl ? 'Complete payment' : null,
			secondaryLabel: 'Done',
		});
	} catch (err) {
		if (status) {
			status.textContent = err.message || 'Network error — try again.';
			status.className = 'd-subs-status err';
		}
		if (btn) {
			btn.disabled = false;
			btn.textContent = 'Subscribe';
		}
	}
}

async function manageSubscription(subId, btn) {
	if (!detailState?.agent) return;
	const agent = detailState.agent;
	const tier = (agent.subscription_tiers || []).find(
		(t) => t.id === agent.user_subscription?.plan_id,
	);
	const tierName = tier?.name || 'this plan';
	const status = $('d-subs-status');

	const confirmed = window.confirm(
		`Cancel your subscription to "${tierName}"? Access to its perks ends right away and you won't be billed again.`,
	);
	if (!confirmed) return;

	if (btn) {
		btn.disabled = true;
		btn.textContent = 'Cancelling…';
	}

	try {
		const token = await getCsrfToken();
		_csrf = null;
		const r = await fetch(`/api/subscriptions/${encodeURIComponent(subId)}`, {
			method: 'DELETE',
			headers: { 'X-CSRF-Token': token },
			credentials: 'include',
		});
		const j = await r.json().catch(() => ({}));
		if (!r.ok) {
			const msg = j.error_description || j.error || 'Could not cancel. Try again.';
			if (status) {
				status.textContent = msg;
				status.className = 'd-subs-status err';
			}
			if (btn) {
				btn.disabled = false;
				btn.textContent = 'Manage subscription';
			}
			return;
		}
		await loadDetail(agent.id);
		const after = $('d-subs-status');
		if (after) {
			after.textContent = `Your subscription to ${tierName} has been cancelled.`;
			after.className = 'd-subs-status ok';
		}
	} catch (err) {
		if (status) {
			status.textContent = err.message || 'Network error — try again.';
			status.className = 'd-subs-status err';
		}
		if (btn) {
			btn.disabled = false;
			btn.textContent = 'Manage subscription';
		}
	}
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
		log.error('[marketplace] skills categories', err);
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
	if (!skillsState.categories.length) loadSkillCategories();
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
		log.error('[marketplace] skills load', err);
		if (grid && !append) {
			grid.innerHTML = renderErrorState('skills');
			grid.querySelector('[data-empty-action="empty-retry"]')?.addEventListener('click', () => {
				grid.setAttribute('aria-busy', 'true');
				grid.innerHTML = renderSkeletons(8);
				loadSkillsTab(true);
			});
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
		card.setAttribute('role', 'link');
		card.setAttribute('tabindex', '0');
		const go = () => { const id = card.dataset.skillId; if (id) navTo(`/marketplace/skills/${encodeURIComponent(id)}`); };
		card.addEventListener('click', go);
		card.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
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
			${paid ? '<span class="skill-x402-badge" title="Callable per-call via x402 USDC">x402</span>' : ''}
			${installsDisplay}
			${toolsDisplay}
			${ratingDisplay}
		</div>
		<div class="skill-meta skill-foot">
			${installedTag || '<span></span>'}
			<span class="open-cta">Details <span class="open-cta-arrow" aria-hidden="true">→</span></span>
		</div>
	</div>`;
}

// ── Skill detail page ─────────────────────────────────────────────────────
// Rich, deep-linkable page for a single skill at /marketplace/skills/:id.
// Shows the skill's tools, full instructions, interactive rating, a fully
// wired install/remove action, and related skills in the same category.

let _skillDetailId = null;
let _skillDetailData = null;

function _setSkillDetailState({ skeleton = false, empty = false, body = false }) {
	const skel = $('skill-detail-skeleton');
	const emptyEl = $('skill-detail-empty');
	const bodyEl = $('skill-detail-body');
	if (skel) skel.hidden = !skeleton;
	if (emptyEl) emptyEl.hidden = !empty;
	if (bodyEl) bodyEl.hidden = !body;
}

async function loadSkillDetail(id) {
	if (_skillDetailId === id && _skillDetailData) return;
	_setSkillDetailState({ skeleton: true });

	let skill = null;
	try {
		const r = await fetch(`${API}/skills/${encodeURIComponent(id)}`, { credentials: 'include' });
		if (r.ok) {
			const j = await r.json();
			skill = j?.skill || null;
		}
	} catch (err) {
		log.error('[marketplace] skill detail', err);
	}

	if (readRoute().view !== 'skill-detail') return;

	if (!skill) {
		_setSkillDetailState({ empty: true });
		setSocialMeta({
			title: 'Skill not found · three.ws',
			description: 'This skill may have been removed or the link is wrong.',
			url: location.origin + location.pathname,
			image: _socialMetaDefaults.image,
		});
		return;
	}

	_skillDetailData = skill;
	renderSkillDetail(skill);
	_skillDetailId = id;
}

function renderSkillDetail(skill) {
	const paid = isPaidSkill(skill);
	const rating = Number(skill.avg_rating) || 0;
	const installs = Number(skill.install_count) || 0;
	const tools = Array.isArray(skill.schema_json) ? skill.schema_json : [];
	const author = skill.author?.display_name || 'System';

	const iconEl = $('skill-detail-icon');
	if (iconEl) iconEl.textContent = (skill.name || '?')[0].toUpperCase();

	$('skill-detail-eyebrow').textContent = paid ? 'Paid skill' : 'Free skill';
	$('skill-detail-name').textContent = skill.name || 'Untitled skill';

	const authorEl = $('skill-detail-author');
	if (authorEl) {
		authorEl.hidden = false;
		authorEl.textContent = `by ${author}`;
	}

	const priceEl = $('skill-detail-price');
	if (priceEl) {
		priceEl.innerHTML = paid
			? `<span class="market-price-pill paid">$${Number(skill.price_per_call_usd).toFixed(3)}/call</span>`
			: `<span class="market-price-pill">Free</span>`;
	}

	const pillsEl = $('skill-detail-pills');
	if (pillsEl) {
		const pills = [`<span class="stat-pill" style="text-transform:capitalize">${escapeHtml(skill.category || 'general')}</span>`];
		if (tools.length) pills.push(`<span class="stat-pill">${tools.length} tool${tools.length === 1 ? '' : 's'}</span>`);
		if (installs > 0) pills.push(`<span class="stat-pill">↓ ${fmtNumber(installs)} installs</span>`);
		if (skill.rating_count > 0) pills.push(`<span class="stat-pill">★ ${rating.toFixed(1)} · ${skill.rating_count}</span>`);
		(skill.tags || []).forEach((t) => {
			pills.push(`<button type="button" class="tag-pill" data-tag="${escapeHtml(t)}">#${escapeHtml(t)}</button>`);
		});
		pillsEl.innerHTML = pills.join('');
		pillsEl.querySelectorAll('[data-tag]').forEach((btn) => {
			btn.addEventListener('click', () => navTo(`/marketplace?tab=skills&tag=${encodeURIComponent(btn.dataset.tag)}`));
		});
	}

	const descEl = $('skill-detail-desc');
	if (descEl) {
		descEl.textContent = skill.description || '';
		descEl.hidden = !skill.description;
	}

	// Install / remove — fully wired (the old modal button was a dead path).
	const installBtn = $('skill-detail-install');
	if (installBtn) {
		const sync = () => {
			installBtn.classList.toggle('installed', !!skill.installed);
			installBtn.textContent = skill.installed ? 'Installed ✓ — Remove' : paid ? 'Add skill' : 'Install';
		};
		sync();
		installBtn.disabled = false;
		installBtn.onclick = () => toggleSkillInstall(skill.id);
	}

	// Share.
	const shareBtn = $('skill-detail-share');
	if (shareBtn) shareBtn.onclick = () => shareCurrentPage(shareBtn, `${skill.name} — three.ws skill`, skill.description || 'Check out this agent skill on three.ws');

	// Author → creator modal.
	const authorBtn = $('skill-detail-author-btn');
	if (authorBtn) {
		if (skill.author?.id) {
			authorBtn.hidden = false;
			authorBtn.textContent = `View ${author}'s skills →`;
			authorBtn.onclick = () => openCreatorModal(skill.author.id);
		} else {
			authorBtn.hidden = true;
		}
	}

	// Interactive rating.
	const ratingWrap = $('skill-detail-rating-wrap');
	const ratingEl = $('skill-detail-rating');
	if (ratingWrap && ratingEl) {
		ratingWrap.hidden = false;
		const userRating = Math.round(rating);
		const stars = [1, 2, 3, 4, 5].map((n) =>
			`<button class="${n <= userRating ? 'active' : ''}" data-rating="${n}" aria-label="Rate ${n} star${n === 1 ? '' : 's'}">★</button>`,
		).join('');
		ratingEl.innerHTML = `${stars}<span class="rating-count">${skill.rating_count || 0} rating${skill.rating_count === 1 ? '' : 's'}</span>`;
		ratingEl.querySelectorAll('[data-rating]').forEach((btn) => {
			btn.addEventListener('click', () => rateSkill(skill.id, Number(btn.dataset.rating)));
		});
	}

	// Tools provided — reuses the tool-card layout from the plugin detail page.
	const toolsWrap = $('skill-detail-tools-wrap');
	const toolsEl = $('skill-detail-tools');
	const toolsCount = $('skill-detail-tools-count');
	if (toolsCount) toolsCount.textContent = tools.length ? `${tools.length}` : '';
	if (toolsWrap && toolsEl) {
		if (!tools.length) {
			toolsWrap.hidden = true;
		} else {
			toolsWrap.hidden = false;
			toolsEl.innerHTML = tools.map((g) => {
				const fn = g?.function || g?.clientDefinition || {};
				return renderToolCard({ name: fn.name, description: fn.description, parameters: fn.parameters });
			}).join('');
		}
	}

	// Instructions / content.
	const contentWrap = $('skill-detail-content-wrap');
	const contentEl = $('skill-detail-content');
	if (contentWrap && contentEl) {
		if (skill.content) {
			contentWrap.hidden = false;
			contentEl.textContent = skill.content.length > 8000 ? skill.content.slice(0, 8000) + '\n\n…' : skill.content;
		} else {
			contentWrap.hidden = true;
		}
	}

	// Per-call x402 gate — only shown for priced skills. Lets any x402 wallet
	// pay the skill's per-call price in USDC and receive its payload; payment
	// settles to the author. Backed by /api/x402/skill-call.
	renderSkillX402(skill, paid);

	// Related skills in the same category (excludes this one).
	const relWrap = $('skill-detail-related-wrap');
	const relEl = $('skill-detail-related');
	if (relWrap && relEl) {
		const related = skillsState.skills.filter((s) => s.id !== skill.id && s.category === skill.category).slice(0, 6);
		if (related.length) {
			relWrap.hidden = false;
			relEl.innerHTML = related.map(renderSkillCard).join('');
			relEl.querySelectorAll('[data-skill-id]').forEach((card) => {
				card.addEventListener('click', () => navTo(`/marketplace/skills/${encodeURIComponent(card.dataset.skillId)}`));
			});
		} else {
			relWrap.hidden = true;
		}
	}

	setSocialMeta({
		title: `${skill.name} — three.ws skill`,
		description: skill.description || `An agent skill on three.ws providing ${tools.length} tool${tools.length === 1 ? '' : 's'}.`,
		url: location.origin + location.pathname,
		image: _socialMetaDefaults.image,
	});
	document.title = `${skill.name} · three.ws`;

	_setSkillDetailState({ body: true });
}

// Copy text to the clipboard and flash the trigger button's label so the user
// gets confirmation. Restores the original label after a beat.
function copyToClipboard(text, btn) {
	if (!navigator.clipboard) return;
	navigator.clipboard.writeText(text).then(() => {
		if (!btn) return;
		const original = btn.textContent;
		btn.textContent = 'Copied!';
		btn.classList.add('copied');
		setTimeout(() => { btn.textContent = original; btn.classList.remove('copied'); }, 1500);
	}).catch((err) => log.error('[marketplace] clipboard', err));
}

// Render the per-call x402 panel. Free skills hide it entirely — there's
// nothing to pay for. Paid skills get a live endpoint URL + a copy-pasteable
// x402-fetch snippet priced at their per-call rate.
function renderSkillX402(skill, paid) {
	const wrap = $('skill-detail-x402-wrap');
	if (!wrap) return;
	if (!paid || !skill?.slug) {
		wrap.hidden = true;
		return;
	}
	wrap.hidden = false;

	const price = Number(skill.price_per_call_usd) || 0;
	const priceEl = $('skill-detail-x402-price');
	if (priceEl) priceEl.textContent = `$${price.toFixed(3)} / call`;

	const url = `${location.origin}/api/x402/skill-call?skill=${encodeURIComponent(skill.slug)}`;
	const urlEl = $('skill-detail-x402-url');
	if (urlEl) urlEl.textContent = url;

	const codeEl = $('skill-detail-x402-code');
	if (codeEl) {
		codeEl.textContent =
			`import { wrapFetchWithPayment } from '@three-ws/x402-fetch';\n\n` +
			`// wallet = a viem/ethers account funded with USDC on Base\n` +
			`const fetchWithPay = wrapFetchWithPayment(fetch, wallet);\n` +
			`const res = await fetchWithPay('${url}');\n` +
			`const { skill, tools, content } = await res.json();\n` +
			`// paid $${price.toFixed(3)} USDC → received ${skill.name}'s tool schema + instructions`;
	}

	const copyUrlBtn = $('skill-detail-x402-copy-url');
	if (copyUrlBtn) copyUrlBtn.onclick = () => copyToClipboard(url, copyUrlBtn);
	const copyCodeBtn = $('skill-detail-x402-copy-code');
	if (copyCodeBtn) copyCodeBtn.onclick = () => copyToClipboard(codeEl?.textContent || '', copyCodeBtn);
}

async function toggleSkillInstall(id) {
	const btn = $('skill-detail-install');
	if (!btn || btn.disabled) return;
	const wasInstalled = !!_skillDetailData?.installed;
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
		// Refresh the page data and the underlying grid so install state stays in sync.
		_skillDetailId = null;
		skillsState.loaded = false;
		await loadSkillDetail(id);
		loadSkillsTab(true);
	} catch (err) {
		log.error('[marketplace] skill install', err);
		btn.disabled = false;
		btn.textContent = wasInstalled ? 'Installed ✓ — Remove' : 'Install';
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
		_skillDetailId = null;
		await loadSkillDetail(id);
	} catch (err) {
		log.error('[marketplace] skill rate', err);
	}
}

// Shared share helper: native share with clipboard fallback + button feedback.
async function shareCurrentPage(btn, title, text) {
	const url = location.href;
	if (navigator.share) {
		try { await navigator.share({ title, text, url }); return; }
		catch { /* cancelled — fall through to copy */ }
	}
	try {
		await navigator.clipboard.writeText(url);
		const original = btn.textContent;
		btn.textContent = 'Link copied ✓';
		btn.classList.add('copied');
		setTimeout(() => { btn.textContent = original; btn.classList.remove('copied'); }, 1800);
	} catch (err) {
		log.error('[marketplace] share copy', err);
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
		log.error('[marketplace] purchases load', err);
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
	return `<div class="card card--interactive market-card-agent" data-purchase-agent="${escapeHtml(p.agent_id)}">
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
			fetch(`${API}/users/me/earnings`, { credentials: 'include' }),
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
		log.error('[marketplace] earn tab', err);
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
		log.error('[marketplace] revenue chart', err);
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
	const kindColors = { skill: '#60a5fa', avatar: '#888888', agent: '#34d399' };

	el.innerHTML = visible.map(e => {
		const icon = kindIcons[e.kind] || '·';
		const color = kindColors[e.kind] || 'var(--ink-dim)';
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

// ── Animations tab ───────────────────────────────────────────────────────

const animState = {
	loaded: false, loading: false, items: [], filter: 'all', q: '',
	listings: [], listingsLoaded: false,
};

async function loadAnimationsTab(force = false) {
	if (animState.loading) return;
	if (animState.loaded && !force) { renderCreatorListings(); renderAnimationsGrid(); return; }
	animState.loading = true;
	const grid = $('animations-grid');
	if (grid) grid.innerHTML = renderSkeletons(8);
	const listEl = ensureListingsContainer();
	if (listEl) listEl.querySelector('.market-anim-listings-grid').innerHTML = renderSkeletons(4);

	// Curated preset library + creator listings load independently — one failing
	// must not blank the other.
	const [presetRes, listingRes] = await Promise.allSettled([
		fetch('/animations/manifest.json').then((r) => {
			if (!r.ok) throw new Error(`manifest ${r.status}`);
			return r.json();
		}),
		fetch('/api/marketplace/animations?limit=48').then((r) => {
			if (!r.ok) throw new Error(`listings ${r.status}`);
			return r.json();
		}),
	]);

	if (presetRes.status === 'fulfilled') {
		const raw = presetRes.value;
		animState.items = Array.isArray(raw) ? raw : (raw.animations || []);
		animState.loaded = true;
	} else {
		log.error('[marketplace] animations presets', presetRes.reason);
		if (grid && !animState.items.length) grid.innerHTML = renderErrorState('animations');
	}

	if (listingRes.status === 'fulfilled') {
		animState.listings = listingRes.value.items || [];
	} else {
		log.error('[marketplace] animations listings', listingRes.reason);
		animState.listings = [];
	}
	animState.listingsLoaded = true;
	animState.loading = false;

	renderCreatorListings();
	renderAnimationsGrid();
	bindAnimationsEvents();
}

// ── Creator listings (paid / free marketplace clips) ──────────────────────
// Inserted as its own section above the curated preset library. The preset
// grid (#animations-grid) keeps its existing markup; this block is created
// on demand so the static HTML stays untouched.
function ensureListingsContainer() {
	let section = $('animations-listings');
	if (section) return section;
	const tab = document.querySelector('#market-animations-section .market-skills-tab');
	const grid = $('animations-grid');
	if (!tab || !grid) return null;
	section = document.createElement('div');
	section.id = 'animations-listings';
	section.className = 'market-anim-listings';
	section.innerHTML = `
		<div class="market-anim-listings-head">
			<h3 class="market-anim-listings-title">From creators</h3>
			<span class="market-anim-listings-sub" id="animations-listings-sub"></span>
		</div>
		<div class="market-grid market-anim-listings-grid" id="animations-listings-grid"></div>
		<div class="market-anim-library-head"><h3 class="market-anim-listings-title">Animation library</h3>
			<span class="market-anim-listings-sub">Curated clips, free on any avatar</span></div>`;
	tab.insertBefore(section, grid);
	return section;
}

function renderCreatorListings() {
	const section = ensureListingsContainer();
	if (!section) return;
	const grid = section.querySelector('.market-anim-listings-grid');
	const sub = $('animations-listings-sub');
	const q = animState.q.toLowerCase();

	const filtered = animState.listings.filter((it) => {
		if (animState.filter === 'loop' && it.loop !== true) return false;
		if (animState.filter === 'action' && it.loop !== false) return false;
		if (q && !(`${it.name} ${it.creator?.name || ''} ${(it.tags || []).join(' ')}`.toLowerCase().includes(q))) return false;
		return true;
	});

	// Hide the whole "From creators" header + library divider when there are no
	// listings at all (keeps the preset library looking intentional, not empty).
	if (!animState.listings.length) { section.hidden = true; return; }
	section.hidden = false;
	if (sub) sub.textContent = `${filtered.length} for sale`;

	if (!filtered.length) {
		grid.innerHTML = `<div class="market-empty">No creator animations match your filter.</div>`;
		return;
	}

	grid.innerHTML = filtered.map((it) => {
		const priceLabel = it.free ? 'Free' : `${formatPrice(it.price.amount)} ${it.price.currency}`;
		const dur = it.duration ? `${it.duration.toFixed(it.duration % 1 ? 1 : 0)}s` : '';
		const typeLabel = it.loop !== false ? 'Loop' : 'Action';
		const thumb = it.thumbnail_url
			? `<img class="anim-listing-thumb" src="${escapeHtml(it.thumbnail_url)}" alt="" loading="lazy" />`
			: `<div class="anim-listing-thumb anim-listing-thumb-empty">🎬</div>`;
		return `<article class="anim-listing-card" data-listing-id="${escapeHtml(it.id)}" tabindex="0" role="button" aria-label="${escapeHtml(it.name)} — ${priceLabel}">
			<div class="anim-listing-media">
				${thumb}
				<span class="anim-listing-price ${it.free ? 'free' : 'paid'}">${escapeHtml(priceLabel)}</span>
			</div>
			<div class="anim-listing-body">
				<div class="anim-listing-name">${escapeHtml(it.name)}</div>
				<div class="anim-listing-creator">${escapeHtml(it.creator?.name || 'Anonymous')}</div>
				<div class="anim-listing-meta">
					<span class="anim-type-pill ${it.loop !== false ? 'loop' : 'action'}">${typeLabel}</span>
					${dur ? `<span class="stat-pill">${escapeHtml(dur)}</span>` : ''}
					${it.purchase_count ? `<span class="stat-pill">${it.purchase_count} sold</span>` : ''}
				</div>
			</div>
			<div class="anim-listing-cta">${it.free ? 'Get →' : 'Buy →'}</div>
		</article>`;
	}).join('');

	grid.querySelectorAll('.anim-listing-card').forEach((card) => {
		const id = card.dataset.listingId;
		const open = () => openAnimationPurchase(id);
		card.addEventListener('click', open);
		card.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
		});
	});
}

function formatPrice(amount) {
	const n = Number(amount);
	if (!isFinite(n)) return amount;
	// Trim trailing zeros: 2.50 → 2.5, 2.00 → 2.
	return `$${n.toFixed(2).replace(/\.?0+$/, '')}`;
}

function renderAnimationsGrid() {
	const grid = $('animations-grid');
	if (!grid) return;
	const q = animState.q.toLowerCase();
	const filtered = animState.items.filter((a) => {
		if (animState.filter === 'loop' && a.loop !== true) return false;
		if (animState.filter === 'action' && a.loop !== false) return false;
		if (q && !(a.label || a.name || '').toLowerCase().includes(q)) return false;
		return true;
	});
	const sub = $('animations-subtitle');
	if (sub) sub.textContent = `${filtered.length} clip${filtered.length !== 1 ? 's' : ''}`;
	if (!filtered.length) {
		grid.innerHTML = `<div class="market-empty">No animations match your filter.</div>`;
		return;
	}
	grid.innerHTML = filtered.map((a) => {
		const name = a.label || a.name || 'Untitled';
		const isLoop = a.loop !== false;
		const typeLabel = isLoop ? 'Ambient' : 'Action';
		const typeClass = isLoop ? 'loop' : 'action';
		const icon = a.icon || (isLoop ? '↺' : '▶');
		return `<div class="market-anim-card" data-anim-name="${escapeHtml(a.name || '')}">
			<div class="anim-card-icon">${escapeHtml(icon)}</div>
			<div class="anim-card-body">
				<div class="anim-card-name">${escapeHtml(name)}</div>
				<div class="anim-card-meta">
					<span class="anim-type-pill ${typeClass}">${typeLabel}</span>
				</div>
			</div>
			<div class="anim-card-cta">Preview →</div>
		</div>`;
	}).join('');

	grid.querySelectorAll('.market-anim-card').forEach((card) => {
		const animName = card.dataset.animName;
		card.setAttribute('role', 'link');
		card.setAttribute('tabindex', '0');
		const go = () => { if (animName) navTo(`/marketplace/animations/${encodeURIComponent(animName)}`); };
		card.addEventListener('click', go);
		card.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
		});
	});
}

let _animEventsBound = false;
function bindAnimationsEvents() {
	if (_animEventsBound) return;
	_animEventsBound = true;
	const search = $('animations-search');
	if (search) {
		search.addEventListener('input', () => {
			animState.q = search.value.trim();
			renderCreatorListings();
			renderAnimationsGrid();
		});
	}
	document.querySelectorAll('[data-anim-filter]').forEach((btn) => {
		btn.addEventListener('click', () => {
			animState.filter = btn.dataset.animFilter;
			document.querySelectorAll('[data-anim-filter]').forEach((b) => b.classList.toggle('active', b === btn));
			renderCreatorListings();
			renderAnimationsGrid();
		});
	});
}

// ── Creator-animation purchase modal ──────────────────────────────────────
// Self-contained overlay: poster, metadata, and the buy/get action. Free clips
// download the GLB directly; paid clips pay once in USDC via the x402 endpoint
// (buy once, re-download free with the same wallet) and surface a ready-to-run
// snippet for agents/CLIs.
async function openAnimationPurchase(id) {
	const item = animState.listings.find((x) => x.id === id);
	if (!item) return;

	const existing = $('anim-buy-overlay');
	if (existing) existing.remove();

	const overlay = document.createElement('div');
	overlay.id = 'anim-buy-overlay';
	overlay.className = 'anim-buy-overlay';
	overlay.setAttribute('role', 'dialog');
	overlay.setAttribute('aria-modal', 'true');
	overlay.setAttribute('aria-label', `Get ${item.name}`);

	const priceLabel = item.free ? 'Free' : `${formatPrice(item.price.amount)} ${item.price.currency}`;
	const endpoint = `${location.origin}${item.download_url}`;
	const dur = item.duration ? `${item.duration.toFixed(item.duration % 1 ? 1 : 0)}s` : '';
	const snippet =
		`import { wrapFetchWithPayment } from '@three-ws/x402-fetch';\n` +
		`const res = await wrapFetchWithPayment(fetch, wallet)('${endpoint}');\n` +
		`const { downloadUrl } = await res.json(); // GLB, ready to play on any avatar`;

	overlay.innerHTML = `
		<div class="anim-buy-card">
			<button class="anim-buy-close" type="button" aria-label="Close">✕</button>
			<div class="anim-buy-media">
				${item.thumbnail_url
					? `<img loading="lazy" decoding="async" src="${escapeHtml(item.thumbnail_url)}" alt="" />`
					: `<div class="anim-buy-media-empty">🎬</div>`}
				<span class="anim-listing-price ${item.free ? 'free' : 'paid'}">${escapeHtml(priceLabel)}</span>
			</div>
			<div class="anim-buy-info">
				<h2 class="anim-buy-name">${escapeHtml(item.name)}</h2>
				<p class="anim-buy-creator">by ${escapeHtml(item.creator?.name || 'Anonymous')}</p>
				${item.description ? `<p class="anim-buy-desc">${escapeHtml(item.description)}</p>` : ''}
				<div class="anim-buy-meta">
					<span class="anim-type-pill ${item.loop !== false ? 'loop' : 'action'}">${item.loop !== false ? 'Loop' : 'Action'}</span>
					${dur ? `<span class="stat-pill">${escapeHtml(dur)}</span>` : ''}
					${item.frame_count ? `<span class="stat-pill">${item.frame_count} keys</span>` : ''}
					${item.purchase_count ? `<span class="stat-pill">${item.purchase_count} sold</span>` : ''}
				</div>
				${(item.tags || []).length ? `<div class="anim-buy-tags">${item.tags.slice(0, 6).map((t) => `<span class="anim-cat-pill">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
				<div class="anim-buy-actions">
					<button class="btn-primary anim-buy-go" type="button">${item.free ? 'Download GLB' : `Buy for ${escapeHtml(priceLabel)}`}</button>
				</div>
				<p class="anim-buy-note" id="anim-buy-note">${item.free
					? 'Free download — a self-contained animated GLB that plays on any three.ws avatar.'
					: 'Pay once in USDC (Base or Solana). Re-download free anytime by signing in with the same wallet.'}</p>
				${item.free ? '' : `
				<details class="anim-buy-snippet">
					<summary>Pay programmatically (agents / CLI)</summary>
					<div class="anim-buy-endpoint">
						<code>${escapeHtml(endpoint)}</code>
						<button class="market-chip anim-buy-copy-url" type="button">Copy URL</button>
					</div>
					<pre class="anim-buy-code"><code>${escapeHtml(snippet)}</code></pre>
				</details>`}
			</div>
		</div>`;

	document.body.appendChild(overlay);
	const close = () => overlay.remove();
	overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
	overlay.querySelector('.anim-buy-close').addEventListener('click', close);
	const escHandler = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', escHandler); } };
	document.addEventListener('keydown', escHandler);

	const copyUrl = overlay.querySelector('.anim-buy-copy-url');
	copyUrl?.addEventListener('click', () => {
		navigator.clipboard?.writeText(endpoint).then(() => {
			const t = copyUrl.textContent; copyUrl.textContent = 'Copied ✓';
			setTimeout(() => { copyUrl.textContent = t; }, 1400);
		});
	});

	const goBtn = overlay.querySelector('.anim-buy-go');
	const note = overlay.querySelector('#anim-buy-note');
	goBtn?.addEventListener('click', async () => {
		if (item.free) {
			goBtn.disabled = true; goBtn.textContent = 'Preparing…';
			try {
				const r = await fetch(endpoint, { headers: { accept: 'application/json' } });
				const body = await r.json();
				if (!r.ok || !body.downloadUrl) throw new Error(body.error_description || body.error || `download failed (${r.status})`);
				triggerDownload(body.downloadUrl, `${item.slug || 'animation'}.glb`);
				goBtn.textContent = 'Downloaded ✓';
				if (note) note.textContent = 'Your download has started. The GLB plays on any three.ws avatar.';
				if (item.purchase_count != null) item.purchase_count += 0;
			} catch (err) {
				goBtn.disabled = false; goBtn.textContent = 'Download GLB';
				if (note) { note.textContent = err.message; note.classList.add('anim-buy-note-err'); }
			}
		} else {
			// Paid: x402 settlement happens wallet-side. Surface the endpoint +
			// snippet (revealed below) — there's no custodial in-browser signer.
			const details = overlay.querySelector('.anim-buy-snippet');
			if (details) { details.open = true; details.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
			if (note) note.textContent = 'Pay from your wallet using the endpoint below. Once settled, the response carries a presigned GLB download URL.';
		}
	});
}

function triggerDownload(url, filename) {
	const a = document.createElement('a');
	a.href = url; a.download = filename; a.rel = 'noopener';
	document.body.appendChild(a); a.click(); a.remove();
}

// ── Animation detail page ─────────────────────────────────────────────────
// Rich, deep-linkable page at /marketplace/animations/:name. Plays the clip
// live on a preview avatar, shows clip metadata, and lists more animations.

const PREVIEW_AVATAR_GLB = '/animations/idle_female_jan25.glb';

let _animDetailId = null;
let _animDetailEl = null;

function teardownAnimDetailStage() {
	if (_animDetailEl) {
		try { _animDetailEl.remove(); } catch {}
		_animDetailEl = null;
	}
}

async function loadAnimDetail(name) {
	if (_animDetailId === name) return;

	// Ensure the manifest is loaded (deep links land with an empty animState).
	if (!animState.items.length) {
		try {
			const r = await fetch('/animations/manifest.json');
			if (r.ok) {
				const raw = await r.json();
				animState.items = Array.isArray(raw) ? raw : (raw.animations || []);
				animState.loaded = true;
			}
		} catch (err) {
			log.error('[marketplace] anim manifest', err);
		}
	}

	if (readRoute().view !== 'anim-detail') return;

	const anim = animState.items.find((a) => a.name === name);
	if (!anim) {
		teardownAnimDetailStage();
		$('anim-detail-body').hidden = true;
		$('anim-detail-empty').hidden = false;
		setSocialMeta({
			title: 'Animation not found · three.ws',
			description: 'This clip may have been renamed or removed.',
			url: location.origin + location.pathname,
			image: _socialMetaDefaults.image,
		});
		return;
	}

	renderAnimDetail(anim);
	_animDetailId = name;
}

function playAnimOnStage(anim) {
	const stage = $('anim-detail-stage');
	if (!stage) return;
	teardownAnimDetailStage();
	const load = $('anim-detail-stage-load');
	stage.querySelectorAll('agent-3d').forEach((el) => el.remove());
	if (load) load.hidden = false;

	const isLoop = anim.loop !== false;
	const agentEl = document.createElement('agent-3d');
	agentEl.setAttribute('src', PREVIEW_AVATAR_GLB);
	agentEl.setAttribute('eager', '');
	agentEl.style.cssText = 'width:100%;height:100%;display:block;';
	agentEl.addEventListener('agent:ready', () => {
		if (load) load.hidden = true;
		agentEl.play?.(anim.name, { loop: isLoop, fade_ms: 300 });
	}, { once: true });
	stage.appendChild(agentEl);
	_animDetailEl = agentEl;
}

function renderAnimDetail(anim) {
	$('anim-detail-empty').hidden = true;
	$('anim-detail-body').hidden = false;

	const name = anim.label || anim.name || 'Animation';
	const isLoop = anim.loop !== false;
	const typeLabel = isLoop ? 'Ambient' : 'Action';

	$('anim-detail-icon').textContent = anim.icon || (isLoop ? '↺' : '▶');
	$('anim-detail-name').textContent = name;
	$('anim-detail-clip').textContent = anim.name || '';

	$('anim-detail-pills').innerHTML = [
		`<span class="anim-type-pill ${isLoop ? 'loop' : 'action'}">${typeLabel}</span>`,
		`<span class="stat-pill">${isLoop ? 'Loops' : 'Plays once'}</span>`,
	].join('');

	const replayBtn = $('anim-detail-replay');
	if (replayBtn) replayBtn.onclick = () => playAnimOnStage(anim);

	const copyBtn = $('anim-detail-copy');
	if (copyBtn) {
		copyBtn.onclick = () => {
			navigator.clipboard?.writeText(anim.name || '').then(() => {
				const original = copyBtn.textContent;
				copyBtn.textContent = 'Copied ✓';
				copyBtn.classList.add('copied');
				setTimeout(() => { copyBtn.textContent = original; copyBtn.classList.remove('copied'); }, 1500);
			});
		};
	}

	const shareBtn = $('anim-detail-share');
	if (shareBtn) shareBtn.onclick = () => shareCurrentPage(shareBtn, `${name} — three.ws animation`, `The "${name}" animation clip on three.ws`);

	const rawBtn = $('anim-detail-raw');
	if (rawBtn) {
		if (anim.url) { rawBtn.hidden = false; rawBtn.href = anim.url; }
		else rawBtn.hidden = true;
	}

	// More animations of the same type.
	const relWrap = $('anim-detail-related-wrap');
	const relEl = $('anim-detail-related');
	if (relWrap && relEl) {
		const related = animState.items
			.filter((a) => a.name !== anim.name && (a.loop !== false) === isLoop)
			.slice(0, 8);
		if (related.length) {
			relWrap.hidden = false;
			relEl.innerHTML = related.map((a) => {
				const rl = a.loop !== false;
				return `<div class="market-anim-card" role="link" tabindex="0" data-anim-name="${escapeHtml(a.name || '')}">
					<div class="anim-card-icon">${escapeHtml(a.icon || (rl ? '↺' : '▶'))}</div>
					<div class="anim-card-body">
						<div class="anim-card-name">${escapeHtml(a.label || a.name || 'Untitled')}</div>
						<div class="anim-card-meta"><span class="anim-type-pill ${rl ? 'loop' : 'action'}">${rl ? 'Ambient' : 'Action'}</span></div>
					</div>
					<div class="anim-card-cta">View →</div>
				</div>`;
			}).join('');
			relEl.querySelectorAll('[data-anim-name]').forEach((card) => {
				card.addEventListener('click', () => navTo(`/marketplace/animations/${encodeURIComponent(card.dataset.animName)}`));
			});
		} else {
			relWrap.hidden = true;
		}
	}

	playAnimOnStage(anim);

	setSocialMeta({
		title: `${name} — three.ws animation`,
		description: `The "${name}" ${typeLabel.toLowerCase()} animation clip, playable on any three.ws avatar.`,
		url: location.origin + location.pathname,
		image: _socialMetaDefaults.image,
	});
	document.title = `${name} · three.ws`;
}

// ── Onchain (ERC-8004) agent detail page ──────────────────────────────────
// Rich, deep-linkable page at /marketplace/onchain/:chainId-:agentId. Replaces
// the old behaviour of bouncing the user straight out to a block explorer.

let _onchainDetailId = null;

function _setOnchainDetailState({ skeleton = false, empty = false, body = false }) {
	const skel = $('onchain-detail-skeleton');
	const emptyEl = $('onchain-detail-empty');
	const bodyEl = $('onchain-detail-body');
	if (skel) skel.hidden = !skeleton;
	if (emptyEl) emptyEl.hidden = !empty;
	if (bodyEl) bodyEl.hidden = !body;
}

async function loadOnchainDetail(composite) {
	if (_onchainDetailId === composite) return;
	_setOnchainDetailState({ skeleton: true });

	// Route id is "<chainId>-<agentId>"; agentId may itself contain no hyphen
	// (it's a uint256 decimal), so split on the first hyphen only.
	const dash = composite.indexOf('-');
	const chainId = dash >= 0 ? composite.slice(0, dash) : '';
	const agentId = dash >= 0 ? composite.slice(dash + 1) : '';

	let item = state.onchainItems.find((a) => `${a.chainId}-${a.agentId}` === composite);
	if (!item && chainId && agentId) {
		try {
			const url = new URL(`${API}/explore-item`, location.origin);
			url.searchParams.set('kind', 'onchain');
			url.searchParams.set('chain', chainId);
			url.searchParams.set('id', agentId);
			const r = await fetch(url);
			if (r.ok) {
				const j = await r.json();
				item = j?.item || null;
			}
		} catch (err) {
			log.error('[marketplace] onchain detail', err);
		}
	}

	if (readRoute().view !== 'onchain-detail') return;

	if (!item) {
		_setOnchainDetailState({ empty: true });
		setSocialMeta({
			title: 'Agent not found · three.ws',
			description: 'This onchain agent is no longer indexed, or the link is wrong.',
			url: location.origin + location.pathname,
			image: _socialMetaDefaults.image,
		});
		return;
	}

	renderOnchainDetail(item);
	_onchainDetailId = composite;
}

function renderOnchainDetail(a) {
	const name = a.name || `Agent #${a.agentId}`;
	const chain = a.chainShortName || a.chainName || `Chain ${a.chainId}`;

	// 3D / image stage.
	const stage = $('onchain-detail-stage');
	if (stage) {
		stage.querySelectorAll('model-viewer, img').forEach((el) => el.remove());
		if (a.glbUrl) {
			stage.hidden = false;
			const mv = document.createElement('model-viewer');
			mv.setAttribute('src', a.glbUrl);
			mv.setAttribute('alt', name);
			mv.setAttribute('auto-rotate', '');
			mv.setAttribute('rotation-per-second', '14deg');
			mv.setAttribute('camera-controls', '');
			mv.setAttribute('interaction-prompt', 'when-focused');
			mv.setAttribute('autoplay', '');
			mv.setAttribute('exposure', '1');
			mv.setAttribute('shadow-intensity', '0.5');
			mv.setAttribute('tone-mapping', 'aces');
			if (a.image) mv.setAttribute('poster', a.image);
			stage.appendChild(mv);
		} else if (a.image) {
			stage.hidden = false;
			const img = document.createElement('img');
			img.src = a.image;
			img.alt = name;
			img.loading = 'lazy';
			stage.appendChild(img);
		} else {
			stage.hidden = true;
		}
	}

	const iconEl = $('onchain-detail-icon');
	if (iconEl) iconEl.textContent = initial(name);

	$('onchain-detail-name').textContent = name;
	const ownerEl = $('onchain-detail-owner');
	if (ownerEl) ownerEl.textContent = a.ownerShort ? `Owner ${a.ownerShort}` : '';

	const pills = [
		'<span class="avatar-pill onchain">ERC-8004</span>',
		`<span class="stat-pill">${escapeHtml(chain)}</span>`,
	];
	if (a.x402Support) pills.push('<span class="onchain-x402" title="Accepts x402 micropayments">x402</span>');
	if (a.has3d) pills.push('<span class="stat-pill">3D</span>');
	if (a.registeredAt) pills.push(`<span class="stat-pill">registered ${escapeHtml(liveTime(a.registeredAt))}</span>`);
	$('onchain-detail-pills').innerHTML = pills.join('');

	const descEl = $('onchain-detail-desc');
	if (descEl) { descEl.textContent = a.description || ''; descEl.hidden = !a.description; }

	// Actions.
	const viewBtn = $('onchain-detail-view');
	if (viewBtn) {
		if (a.viewerUrl) { viewBtn.hidden = false; viewBtn.href = a.viewerUrl; }
		else viewBtn.hidden = true;
	}
	const tokenBtn = $('onchain-detail-token');
	if (tokenBtn) {
		if (a.tokenExplorerUrl) { tokenBtn.hidden = false; tokenBtn.href = a.tokenExplorerUrl; }
		else tokenBtn.hidden = true;
	}
	const ownerBtn = $('onchain-detail-owner-link');
	if (ownerBtn) {
		if (a.ownerExplorerUrl) { ownerBtn.hidden = false; ownerBtn.href = a.ownerExplorerUrl; }
		else ownerBtn.hidden = true;
	}
	const shareBtn = $('onchain-detail-share');
	if (shareBtn) shareBtn.onclick = () => shareCurrentPage(shareBtn, `${name} — ERC-8004 agent`, a.description || `An onchain ERC-8004 agent on ${chain}`);

	// Services (x402 / advertised endpoints).
	const svcWrap = $('onchain-detail-services-wrap');
	const svcEl = $('onchain-detail-services');
	const svcCount = $('onchain-detail-services-count');
	const services = (a.services || []).filter((s) => s && (s.name || s.endpoint));
	if (svcCount) svcCount.textContent = services.length ? `${services.length}` : '';
	if (svcWrap && svcEl) {
		if (!services.length) {
			svcWrap.hidden = true;
		} else {
			svcWrap.hidden = false;
			svcEl.innerHTML = services.map((s) => `<div class="tool-card">
				<div class="tool-card-head">
					<span class="tool-card-name">${escapeHtml(s.name || 'service')}</span>
					${s.version ? `<span class="tool-param-type">v${escapeHtml(String(s.version))}</span>` : ''}
				</div>
				${s.endpoint ? `<p class="tool-card-desc"><span class="tool-card-endpoint">${escapeHtml(s.endpoint)}</span></p>` : ''}
			</div>`).join('');
		}
	}

	// Onchain identity facts.
	const factsEl = $('onchain-detail-facts');
	if (factsEl) {
		const fact = (label, value, link) => {
			if (!value) return '';
			const v = link
				? `<a href="${escapeHtml(safeUrl(link))}" target="_blank" rel="noopener">${escapeHtml(value)}</a>`
				: escapeHtml(value);
			return `<div class="onchain-fact"><span class="onchain-fact-label">${escapeHtml(label)}</span><span class="onchain-fact-value">${v}</span></div>`;
		};
		factsEl.innerHTML = [
			fact('Chain', chain),
			fact('Agent ID', String(a.agentId)),
			fact('Owner', a.owner || a.ownerShort, a.ownerExplorerUrl),
			fact('Registered', a.registeredAt ? formatDate(a.registeredAt) : null),
			a.registeredTx && a.tokenExplorerUrl ? fact('Token', `#${a.agentId}`, a.tokenExplorerUrl) : '',
		].filter(Boolean).join('');
	}

	setSocialMeta({
		title: `${name} — ERC-8004 agent · three.ws`,
		description: a.description || `An onchain ERC-8004 agent on ${chain}.`,
		url: location.origin + location.pathname,
		image: a.image || _socialMetaDefaults.image,
	});
	document.title = `${name} · three.ws`;

	_setOnchainDetailState({ body: true });
}

// ── Memory tab ───────────────────────────────────────────────────────────

const memoryState = { loaded: false, loading: false, agents: [], entries: [] };

const MEMORY_TYPE_META = {
	user: { icon: '◉', label: 'User', desc: 'Who the user is, their role, preferences, and expertise.', example: '"I\'m a senior backend engineer focused on distributed systems."' },
	feedback: { icon: '◈', label: 'Feedback', desc: 'Corrections and confirmations that shape future behaviour.', example: '"Don\'t mock the database in tests — we got burned by mock/prod divergence."' },
	project: { icon: '◧', label: 'Project', desc: 'Ongoing work context, goals, and deadlines.', example: '"Merge freeze starts 2026-03-05 for the mobile release cut."' },
	reference: { icon: '◎', label: 'Reference', desc: 'Pointers to where information lives in external systems.', example: '"Pipeline bugs are tracked in Linear project INGEST."' },
};

async function loadMemoryTab(force = false) {
	if (memoryState.loading) return;
	if (memoryState.loaded && !force) { renderMemoryTab(); return; }
	memoryState.loading = true;
	const body = $('market-memory-body');
	if (body) {
		body.setAttribute('aria-busy', 'true');
		body.innerHTML = skeletonHTML(4, 'row');
	}
	try {
		const agentsRes = await fetch(`${API}/marketplace/agents/mine`, { credentials: 'include' });
		if (agentsRes.status === 401) {
			memoryState.loading = false;
			if (body) body.innerHTML = `<div class="market-empty-cta">
				<h3>Sign in to see agent memory</h3>
				<p>Your agents' persistent memory will appear here once you sign in.</p>
				<button id="memory-signin">Sign in</button>
			</div>`;
			$('memory-signin')?.addEventListener('click', () => {
				location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
			});
			return;
		}
		const j = await agentsRes.json().catch(() => ({}));
		memoryState.agents = Array.isArray(j) ? j : (j?.data?.items ?? []);

		// Fetch memories for all agents in parallel (up to 10)
		const slice = memoryState.agents.slice(0, 10);
		const memorySets = await Promise.all(
			slice.map((ag) =>
				fetch(`${API}/agent-memory?agentId=${ag.id}&limit=20`, { credentials: 'include' })
					.then((r) => (r.ok ? r.json() : { entries: [] }))
					.then((d) => (d.entries || []).map((e) => ({ ...e, agentName: ag.name || ag.title || 'Agent' })))
					.catch(() => [])
			)
		);
		memoryState.entries = memorySets.flat().sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
		memoryState.loaded = true;
	} catch (err) {
		log.error('[marketplace] memory', err);
	} finally {
		memoryState.loading = false;
	}
	renderMemoryTab();
}

function renderMemoryTab() {
	const body = $('market-memory-body');
	if (!body) return;

	const sub = $('memory-subtitle');
	if (sub) sub.textContent = memoryState.entries.length
		? `${memoryState.entries.length} entr${memoryState.entries.length !== 1 ? 'ies' : 'y'} across ${memoryState.agents.length} agent${memoryState.agents.length !== 1 ? 's' : ''}`
		: 'Persistent context that makes agents smarter';

	const typeCards = Object.entries(MEMORY_TYPE_META).map(([type, m]) => `
		<div class="market-memory-type-card" data-memory-type="${type}">
			<div class="memory-type-icon">${m.icon}</div>
			<div class="memory-type-body">
				<div class="memory-type-title">${m.label}</div>
				<div class="memory-type-desc">${m.desc}</div>
				<span class="memory-example-label">Example</span>
				<p class="memory-example-text">${m.example}</p>
			</div>
		</div>`).join('');

	const feedItems = memoryState.entries.length
		? memoryState.entries.slice(0, 20).map((e) => {
			const meta = MEMORY_TYPE_META[e.type] || { icon: '◇', label: e.type || 'general' };
			return `<div class="memory-feed-item">
				<div class="memory-feed-icon" style="${_memoryIconBg(e.type)}">${meta.icon}</div>
				<div class="memory-feed-body">
					<div class="memory-feed-type">${escapeHtml(meta.label)} · ${escapeHtml(e.agentName || '')}</div>
					<div class="memory-feed-content">${escapeHtml(e.content || '')}</div>
				</div>
			</div>`;
		}).join('')
		: `<div class="memory-feed-empty">${
			memoryState.agents.length
				? 'No memory entries yet. Chat with your agents to build up context.'
				: 'Create an agent first to start building memory.'
		}</div>`;

	body.innerHTML = `
		<div class="market-memory-intro">
			<div class="memory-intro-text">
				<h3 class="memory-intro-title">Agent Memory</h3>
				<p class="memory-intro-sub">Agents accumulate four types of memory as they interact — user context, feedback, project state, and references. This persistent layer makes every conversation smarter than the last.</p>
			</div>
			<div class="memory-intro-cta">
				<a href="/agent/new" class="market-memory-cta-btn">+ New Agent</a>
			</div>
		</div>

		<div>
			<p class="market-memory-section-title" style="margin-bottom:14px">Memory Types</p>
			<div class="market-memory-types">${typeCards}</div>
		</div>

		<div class="market-memory-how">
			<p class="market-memory-section-title">How Memory Works</p>
			<div class="memory-how-steps">
				<div class="memory-step"><div class="memory-step-num">1</div><div class="memory-step-text"><strong>Agents observe.</strong> During every conversation, agents detect facts about the user, their goals, and the project context.</div></div>
				<div class="memory-step"><div class="memory-step-num">2</div><div class="memory-step-text"><strong>Memories are classified.</strong> Each entry is typed — user, feedback, project, or reference — so the agent knows when to surface it.</div></div>
				<div class="memory-step"><div class="memory-step-num">3</div><div class="memory-step-text"><strong>Context is injected.</strong> On every new conversation, relevant memories are retrieved by recency and semantic similarity and injected into the agent's context.</div></div>
				<div class="memory-step"><div class="memory-step-num">4</div><div class="memory-step-text"><strong>You stay in control.</strong> Review, edit, or delete any memory entry from the agent dashboard at any time.</div></div>
			</div>
		</div>

		<div class="market-memory-live">
			<p class="market-memory-section-title">Recent Memories</p>
			<div class="memory-feed">${feedItems}</div>
			${memoryState.entries.length > 20 ? `<div class="market-memory-live-cta">Showing 20 most recent. <a href="/dashboard/agents">View all in dashboard →</a></div>` : ''}
		</div>
	`;
}

function _memoryIconBg(type) {
	const map = { user: 'background:rgba(59,130,246,0.15)', feedback: 'background:rgba(234,179,8,0.15)', project: 'background:rgba(34,197,94,0.15)', reference: 'background:rgba(255,255,255,0.07)' };
	return map[type] || 'background:rgba(255,255,255,0.06)';
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
		log.error('[marketplace] mine', err);
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
		grid.innerHTML = emptyStateHTML({
			icon: '🤖',
			title: 'No agents yet',
			body: "Agents you create show up here as drafts first, then go live once you publish. Each gets an on-chain identity, its own wallet, and attachable skills.",
			actions: [
				{ label: '+ New Agent', id: 'mine-empty-new', primary: true },
				{ label: "What's an agent?", href: '/docs/agents-vs-avatars' },
			],
		});
		grid.querySelector('[data-sk-action="mine-empty-new"]')?.addEventListener('click', () => {
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
	return skeletonHTML(n, 'card');
}

function renderEmptyState() {
	const hasSearch = !!state.q;
	const hasTag = !!state.tag;
	const hasCategory = !!state.category;

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

	// Use state-kit shell; keep data-empty-action for the existing delegation handler.
	const buttons = actions
		.map(
			(a) =>
				`<button type="button" class="tws-es-btn${a.primary ? ' tws-es-btn--primary' : ''}" data-empty-action="${a.id}">${escapeHtml(a.label)}</button>`,
		)
		.join('');

	return `<div class="tws-es" role="status">
		<h3 class="tws-es-title">${escapeHtml(title)}</h3>
		<p class="tws-es-body">${body}</p>
		<div class="tws-es-actions">${buttons}</div>
	</div>`;
}

function renderErrorState(scope = 'agents') {
	const label = scope === 'avatars' ? 'avatars' : scope === 'onchain' ? 'onchain agents' : 'agents';
	return `<div class="tws-es tws-es--error" role="alert">
		<div class="tws-es-icon tws-es-icon--err" aria-hidden="true"><svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="16" cy="16" r="14" stroke="currentColor" stroke-width="1.5" opacity=".35"/><path d="M16 9v8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="16" cy="22.5" r="1.25" fill="currentColor"/></svg></div>
		<h3 class="tws-es-title">Couldn't load ${escapeHtml(label)}</h3>
		<p class="tws-es-body">The marketplace server didn't respond. Check your connection and try again.</p>
		<div class="tws-es-actions">
			<button type="button" class="tws-es-btn tws-es-btn--primary" data-empty-action="empty-retry" data-retry-scope="${escapeHtml(scope)}">Retry</button>
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
			els.grid.setAttribute('aria-busy', 'true');
			els.grid.innerHTML = skeletonHTML(8, 'card');
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
		? `<a class="card-author" href="${escapeHtml(safeUrl(author.profileUrl))}" rel="author">${escapeHtml(author.displayName || author.handle)}</a>`
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
	return `<div class="${cardClasses}" role="link" tabindex="0" data-avatar-id="${escapeHtml(a.avatarId || '')}">
		<div class="thumb">${spotlightBadge}${priceBadge}${preview}</div>
		<div class="body">
			<div class="title-row">
				<a class="title card-profile-link" href="/marketplace/avatars/${encodeURIComponent(a.avatarId || '')}" tabindex="-1">${name}</a>
				<button type="button" class="card-heart${bmActive ? ' active' : ''}" data-bm-id="${escapeHtml(a.avatarId||'')}" aria-label="Bookmark" aria-pressed="${bmActive}">♥</button>
			</div>
			<div class="byline">${authorLine}${when ? `<span class="dot">·</span><span class="when">${escapeHtml(when)}</span>` : ''}</div>
			${desc ? `<div class="desc">${desc}</div>` : ''}
			${tagPills}
			<div class="footer">
				${modelCategoryBadge(a.modelCategory)}
				${a.glbUrl ? `<a class="compose-cta" href="/compose?glb=${encodeURIComponent(a.glbUrl)}" title="Open in Scene Composer" tabindex="-1" onclick="event.stopPropagation()">⚡ Compose</a>` : ''}
				<span class="open-cta">Open →</span>
			</div>
		</div>
	</div>`;
}

// Reputation-leaderboard badge — marks agents in the autonomous x402 top-10 trust
// ranking (agent-reputation-leaderboard loop entry). Score is synthesized from real
// on-chain pump.fun agent-payments activity, distribution/buyback success, and
// signed Solana attestations — not a subjective rating. Only shown when the
// autonomous loop has run and the field is set by the marketplace API.
function repFeaturedBadgeHTML(a) {
	if (!a.rep_featured) return '';
	return `<span class="stat-pill rep-featured-badge" title="Top 10 by on-chain trust score — ranked by the x402 reputation oracle">◈ Top Trust</span>`;
}

// Rare-pedigree badge — marks a bred agent by its lineage tier. Uncommon and up
// only, so the badge stays a genuine signal of scarcity (deep pedigree, emergent
// skills) rather than noise on every card. Links into the agent's lineage.
function oracleBadgeHTML(oracle) {
	if (!oracle || oracle.total < 3) return '';
	const wr = oracle.win_rate;
	if (wr == null) return '';
	const isGood = wr >= 50;
	const title = `Oracle: ${oracle.total} trades · ${oracle.wins} wins · ${wr.toFixed(1)}% win rate`;
	return `<span class="oracle-badge${isGood ? '' : ' neutral'}" title="${escapeHtml(title)}">⚡ ${wr.toFixed(0)}% win rate</span>`;
}

function pedigreeBadgeHTML(a) {
	const g = a.genome;
	if (!g || !g.bred || !g.pedigree_tier) return '';
	const tier = String(g.pedigree_tier);
	if (tier === 'common') return '';
	const glyph = g.emergent > 0 ? '⚡' : '◈';
	const title = `Generation ${g.generation} · ${tier} pedigree${g.emergent > 0 ? ` · ${g.emergent} emergent skill${g.emergent > 1 ? 's' : ''}` : ''}`;
	return `<a class="stat-pill pedigree-badge" data-tier="${escapeHtml(tier)}" href="/genome?a=${escapeHtml(a.id)}" title="${escapeHtml(title)}" onclick="event.stopPropagation()">${glyph} gen ${g.generation}</a>`;
}

function renderCard(a) {
	const published = a.published_at || a.published || a.created_at;
	const date = published ? formatDate(published) : '';
	const skillsCount = (a.skills || []).length;
	const author = a.author_name || a.author || 'Anonymous';
	const views = a.views_count ?? a.views ?? 0;
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
	const onchainBadge = onchainBadgeHTML(a);
	const pedigreeBadge = pedigreeBadgeHTML(a);
	const repBadge = repFeaturedBadgeHTML(a);
	return `<div class="card card--interactive market-card-agent" role="link" tabindex="0" data-id="${a.id}">
		${previewStrip}
		${priceBadge}
		${starBtn}
		<div class="head">
			${avatarBlock}
			<div style="min-width:0;flex:1">
				<a class="title card-profile-link" href="/marketplace/agents/${a.id}" tabindex="-1">${escapeHtml(a.name || 'Untitled')}</a>
				<div class="author">${escapeHtml(author)}</div>
			</div>
		</div>
		<div class="desc">${escapeHtml(a.description || '')}</div>
		<div class="stats">
			${a.activated ? '<span class="stat-pill live-badge" title="Live — funded and active on the Money Pulse">◉ Live</span>' : ''}
			${repBadge}
			${onchainBadge}
			${pedigreeBadge}
			${coinChipHTML(a)}
			<span class="stat-pill">⊙ ${fmtNumber(views)}</span>
			<span class="stat-pill">⑂ ${fmtNumber(forks)}</span>
			${skillsCount ? `<span class="stat-pill">▤ ${skillsCount}</span>` : ''}
			${ratingCount > 0 ? `<span class="rating" title="${ratingAvg.toFixed(2)} avg from ${ratingCount} review${ratingCount === 1 ? '' : 's'}">★ ${ratingAvg.toFixed(1)} <span class="count">(${fmtNumber(ratingCount)})</span></span>` : ''}
			${buyers > 0 ? `<span class="stat-pill" title="${buyers} confirmed purchase${buyers === 1 ? '' : 's'}${buyers24h ? `, ${buyers24h} in last 24h` : ''}">$ ${fmtNumber(buyers)}${buyers24h > 0 ? ` <em>(+${buyers24h}/24h)</em>` : ''}</span>` : ''}
			${skillPriceBadge}
			${!skillPriceBadge && paid ? `<span class="stat-pill paid-badge">$ Paid</span>` : ''}
			${oracleBadgeHTML(a.oracle)}
			${walletChipHTML(a, { isOwner: false, showPending: false, link: true })}
		</div>
		<div class="footer">
			<span>${date}</span>
			<span class="footer-right">
				<a class="card-see3d" href="${escapeHtml(seeInWorldHref(a))}" aria-label="${hasCustomAvatar(a) ? 'See' : 'View'} ${escapeHtml(a.name || 'agent')} in 3D in the three.ws world">
					<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>
					<span>${hasCustomAvatar(a) ? 'See in 3D' : 'View in 3D'}</span>
				</a>
				<span class="cat-pill">${CATEGORY_LABELS[a.category] || a.category || ''}</span>
			</span>
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
	const onchainId = a.chainId != null && a.agentId != null ? `${a.chainId}-${a.agentId}` : '';
	return `<div class="market-card-avatar onchain" role="link" tabindex="0" data-onchain-id="${escapeHtml(onchainId)}" data-onchain-href="${escapeHtml(href)}">
		<div class="thumb">${priceBadge}${preview}</div>
		<div class="body">
			<a class="title card-profile-link" href="/marketplace/onchain/${encodeURIComponent(onchainId)}" tabindex="-1">${name}</a>
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

const _viewedAgentIds = new Set();

async function loadDetail(id) {
	els.discovery.hidden = true;
	els.detail.hidden = false;
	els.detail.scrollIntoView({ behavior: 'instant', block: 'start' });

	// Engagement: agent profile opened. Deduped per id so re-opening the same
	// profile within a session doesn't inflate the count.
	if (!_viewedAgentIds.has(id)) {
		_viewedAgentIds.add(id);
		track(ANALYTICS_EVENTS.AGENT_PROFILE_VIEWED, { agent_id: id });
	}

	// Optimistically render from cached list item if available, then refresh from API.
	const cached = state.items.find((item) => item.id === id);
	if (cached) {
		// Seed the optimistic bookmark state from the client-side source of truth
		// (loaded with the user's bookmarks) so a star click during the refresh
		// window picks the correct DELETE/POST method instead of always adding.
		const bmOn = bookmarkedAgents.has(id);
		detailState = { agent: cached, bookmarked: bmOn };
		renderDetail(cached, bmOn);
	} else {
		showDetailState('loading');
	}

	try {
		const r = await fetch(`${API}/marketplace/agents/${id}`, { credentials: 'include' });
		if (!r.ok) {
			if (!cached) showDetailState(r.status === 404 ? 'notfound' : 'error', { id });
			else resolveSkillsLoading(cached);
			return;
		}
		const j = await r.json();
		const agent = j?.data?.agent;
		if (!agent) {
			if (!cached) showDetailState('notfound', { id });
			else resolveSkillsLoading(cached);
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
			// Guard against a stale response: if the user has since opened a
			// different agent, don't paint this one's versions/similar over it.
			if (detailState?.agent?.id !== id) return;
			const versions = versionsRes?.data?.items || versionsRes?.data?.versions || [];
			renderVersions(versions);
			const similar = similarRes?.data?.items || similarRes?.data?.similar || [];
			renderSimilar(similar);
		}).catch(() => { /* best-effort — main detail already rendered */ });
	} catch (err) {
		log.error('[marketplace] detail load', err);
		trackError('marketplace.detail_load', err, { agent_id: id });
		if (!cached) showDetailState('error', { id });
		else resolveSkillsLoading(cached);
	}
}

// When the detail fetch fails but a cached card is already on screen, the
// optimistic render may be showing pulsing "loading" price badges that would
// otherwise spin forever. Re-render the skills out of the loading state using
// whatever prices the cached item carries (none → Free) so the view settles.
function resolveSkillsLoading(cached) {
	const caps = cached.capabilities || {};
	const skillsArr = Array.isArray(caps.skills) ? caps.skills : cached.skills || [];
	renderSkills(skillsArr, cached, cached.skill_prices || {});
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
		// Clear (not set) inline opacity — an inline `1` would override the
		// `.mv-ready .avatar-detail-load-wrap { opacity: 0 }` fade-out rule.
		if (wrap) { wrap.hidden = false; wrap.style.removeProperty('opacity'); }
		if (empty) {
			empty.hidden = true;
			// Restore the default copy — the GLB-error path rewrites these.
			const titleEl = empty.querySelector('.avatar-detail-empty-title');
			const msgEl   = empty.querySelector('.avatar-detail-empty-msg');
			if (titleEl) titleEl.textContent = 'Avatar not found';
			if (msgEl)   msgEl.textContent = 'This avatar may have been removed or the link is wrong.';
		}
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
			log.error('[marketplace] avatar detail fetch', err);
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
			? `by <a href="${escapeHtml(safeUrl(avatar.author.profileUrl))}" rel="author">${escapeHtml(avatar.author.displayName || avatar.author.handle)}</a>`
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
				log.error('[marketplace] share copy', err);
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
		// A 404/CORS-blocked GLB never fires `load`, which would leave the
		// "Loading 3D…" overlay up forever. Swap to a designed error state and
		// un-cache the id so navigating back to this avatar retries the load.
		mv.addEventListener('error', () => {
			if (_avatarDetailMv !== mv) return; // a newer render replaced us
			_avatarDetailId = null;
			if (wrap) wrap.hidden = true;
			if (empty) {
				const titleEl = empty.querySelector('.avatar-detail-empty-title');
				const msgEl   = empty.querySelector('.avatar-detail-empty-msg');
				if (titleEl) titleEl.textContent = '3D model failed to load';
				if (msgEl)   msgEl.textContent = 'The model file could not be fetched. It may have been removed — try again or browse other avatars.';
				empty.hidden = false;
			}
			stage.classList.add('is-empty');
			mv.remove();
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

/**
 * Show a designed, recoverable state over the detail view.
 * @param {'loading'|'notfound'|'error'} kind
 * @param {{ id?: string }} [opts] — `id` enables the Retry action for errors.
 */
function showDetailState(kind, opts = {}) {
	const overlay = $('d-state');
	if (!overlay) {
		// Defensive fallback if the markup is ever absent.
		$('d-name').textContent =
			kind === 'notfound' ? 'Agent not found' : kind === 'error' ? 'Failed to load agent.' : 'Loading…';
		return;
	}

	const icon = $('d-state-icon');
	const title = $('d-state-title');
	const body = $('d-state-body');
	const actions = $('d-state-actions');

	overlay.classList.toggle('is-loading', kind === 'loading');

	if (kind === 'loading') {
		icon.textContent = '◍';
		title.textContent = 'Loading agent…';
		body.textContent = '';
		actions.innerHTML = '';
	} else if (kind === 'error') {
		icon.textContent = '⚠';
		title.textContent = "Couldn't load this agent";
		body.textContent = 'Something went wrong while loading. Check your connection and try again.';
		actions.innerHTML =
			'<button type="button" class="md-state-btn primary" data-act="retry">Retry</button>' +
			'<button type="button" class="md-state-btn" data-act="browse">Browse marketplace</button>';
	} else {
		icon.textContent = '∅';
		title.textContent = "This agent isn't available";
		body.textContent = 'It may have been removed, unpublished, or set to private by its creator.';
		actions.innerHTML =
			'<button type="button" class="md-state-btn primary" data-act="browse">Browse marketplace</button>';
	}

	actions.querySelector('[data-act="browse"]')?.addEventListener('click', () => navTo('/marketplace'));
	actions
		.querySelector('[data-act="retry"]')
		?.addEventListener('click', () => { if (opts.id) loadDetail(opts.id); });

	overlay.hidden = false;
	if (kind !== 'loading') actions.querySelector('button')?.focus();
}

function hideDetailState() {
	const overlay = $('d-state');
	if (overlay) overlay.hidden = true;
}

// Renders the skill rows in the detail view's Capabilities tab. `skillPrices`
// is the authoritative per-skill price map from the detail API. Pass `null` to
// render the loading state — pulsing placeholder badges shown while the detail
// fetch resolves, so paid agents don't flash "Free" on the optimistic render.
function renderSkills(skillsArr, a, skillPrices) {
	const el = $('d-skills');
	if (!el) return;

	const isLoading = skillPrices == null;

	el.innerHTML = skillsArr.length
		? skillsArr.map((s) => {
				const name = typeof s === 'string' ? s : (s.name || '');
				const purchaseKey = `${a.id}:${name}`;

				let badge;
				if (purchasedSkills.has(purchaseKey)) {
					badge = `<span class="price-badge price-owned">✓ Owned</span>`;
				} else if (isLoading) {
					badge = `<span class="price-badge price-loading" aria-label="Loading price" aria-busy="true">···</span>`;
				} else {
					const price = skillPrices[name];
					if (price) {
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
				}

				return `<div class="skill-row">
									<span class="skill-name">${escapeHtml(name)}</span>
									<span class="skill-actions">${badge}</span>
							</div>`;
		}).join('')
		: '<div>This Agent has no skills defined.</div>';
}

function renderDetail(a, bookmarked) {
	hideDetailState();
	const author = a.author_name || a.author || 'Anonymous';
	const published = a.published_at || a.published || a.created_at;
	const views = a.views_count ?? a.views ?? 0;
	const forks = a.forks_count ?? a.forks ?? 0;
	$('d-name').textContent = a.name || 'Untitled';
	renderDetailAvatar(a);
	renderDetailModelStage(a);

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

	// Agent custodial wallet chip, rendered in the identity stats row beside the
	// category/views. isOwner is true only when the signed-in viewer provably owns
	// this row (author match) — that unlocks the "✦ Vanity" entry point to the
	// wallet hub. The chip no-ops until the row carries a solana_address.
	const statsRow = $('d-views')?.parentElement;
	if (statsRow) {
		statsRow.querySelector('.twc')?.remove();
		const isOwner = !!(currentUserId && a.author_id && currentUserId === a.author_id);
		const chip = walletChipEl(a, { isOwner, showPending: false, link: true });
		if (chip) statsRow.appendChild(chip);
	}

	// Render pricing summary if agent has skill prices
	renderDetailPricingSummary(a);

	// Recurring subscription plans (cards + current-plan state)
	renderSubscriptionTiers(a);

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

	// The detail API returns the authoritative list of skills the signed-in user
	// has already unlocked for THIS agent (api/marketplace/[action].js →
	// purchased_skills, sourced from the confirmed skill_purchases table). Fold it
	// into the shared set so the "Owned" badge is correct even when the global
	// /users/me/purchased-skills fetch hasn't run or is stale — e.g. immediately
	// after a purchase, or a bearer/SSO session with no localStorage auth hint.
	if (Array.isArray(a.purchased_skills)) {
		for (const owned of a.purchased_skills) purchasedSkills.add(`${a.id}:${owned}`);
	}

	// skill_prices is only populated by the detail API. On the optimistic
	// cached-card render (state.items carries skills + has_paid_skills but not
	// the price map) it's absent — show pulsing loading badges for agents known
	// to sell skills instead of incorrectly flashing "Free", then swap in real
	// prices when the detail fetch resolves. Agents with no paid skills render
	// immediately with no jump.
	const skillPrices = a.skill_prices
		? a.skill_prices
		: a.has_paid_skills
			? null
			: {};

	renderSkills(skillsArr, a, skillPrices);

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

	// "Configure in wizard" — pre-loads this agent into the full embed editor
	const wizardLink = $('d-embed-wizard-link');
	if (wizardLink) {
		const p = new URLSearchParams({ avatar: agentId, mode: 'chat' });
		wizardLink.href = `/embed?${p}`;
	}
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

	// "View more" toggles the side list between the top 4 and the full set,
	// rather than dead-ending on an href="#". Only shown when there's more to see.
	const renderSideList = (expanded) => {
		const shown = expanded ? items : items.slice(0, 4);
		const moreLabel = items.length > 4 ? (expanded ? 'Show less ‹' : 'View more ›') : '';
		side.innerHTML =
			`<div class="related-side-title">Related Agents${
				moreLabel ? ` <a href="#" id="rel-more" role="button">${moreLabel}</a>` : ''
			}</div>` +
			shown
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
		const moreLink = side.querySelector('#rel-more');
		if (moreLink) {
			moreLink.addEventListener('click', (e) => {
				e.preventDefault();
				renderSideList(!expanded);
			});
		}
	};
	renderSideList(false);
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
		log.error('[marketplace] reviews', err);
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
				<span style="font-size:12px;color:var(--ink-dim)">Update your rating:</span>
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
			<span style="font-size:12px;color:var(--ink-dim)">Your rating:</span>
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
		log.error('[marketplace] submit review', err);
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
		log.error('[marketplace] delete review', err);
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
	const btn = $('d-fork');
	// In-flight guard: a fork is a real, persisted copy. Without this, a double
	// click POSTs /fork twice and spawns duplicate agents before navigation lands.
	if (btn?.disabled) return;
	const id = detailState.agent.id;
	if (btn) { btn.disabled = true; btn.textContent = 'Forking…'; }
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
		// Send the user to chat with their new fork. Leave the button disabled —
		// we're navigating away, so re-enabling would only flash the old label.
		const newId = j?.data?.agent?.id;
		if (newId) { location.href = `/agents/${newId}`; return; }
		throw new Error('Fork failed');
	} catch (err) {
		if (btn) { btn.disabled = false; btn.textContent = 'Fork & Chat'; }
		alert(err.message || 'Fork failed');
	}
}

async function toggleBookmark() {
	if (!detailState) return;
	const btn = $('d-bookmark');
	// In-flight guard: rapid toggles fire interleaved POST/DELETE requests whose
	// responses can land out of order, leaving the star out of sync with the server.
	if (btn?.disabled) return;
	const id = detailState.agent.id;
	const cur = detailState.bookmarked;
	if (btn) btn.disabled = true;
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
		btn?.classList.toggle('on', detailState.bookmarked);
		if (btn) btn.textContent = detailState.bookmarked ? '★' : '☆';
	} catch (err) {
		log.error('[marketplace] bookmark', err);
	} finally {
		if (btn) btn.disabled = false;
	}
}

// ── Wiring ────────────────────────────────────────────────────────────────

function bindEvents() {
	bindEmptyStateActions();
	// Shared 200ms debounce from the list-controls toolkit — same timing and
	// trailing-edge behaviour as /discover so search feels identical on both.
	const runSearch = debounce((value) => {
		state.q = value.trim();
		syncFilterToUrl();
		// Engagement: search intent. Debounced above, so this fires once per
		// settled query — never per keystroke. Length only, never the query text.
		track(ANALYTICS_EVENTS.MARKETPLACE_SEARCHED, {
			query_len: state.q.length,
			filters: { filter: state.filter, sort: state.sort },
		});
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
	els.search.addEventListener('input', (e) => runSearch(e.target.value));
	// Enter flushes the pending search immediately.
	els.search.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') {
			e.preventDefault();
			runSearch.flush(els.search.value);
		}
	});
	els.sortSel.addEventListener('change', (e) => {
		state.sort = e.target.value;
		syncFilterToUrl({ push: true });
		track(ANALYTICS_EVENTS.MARKETPLACE_SEARCHED, {
			query_len: state.q?.length || 0,
			filters: { filter: state.filter, sort: state.sort },
		});
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
	// Plugin detail back button → return to the tools tab.
	const toolDetailBack = $('tool-detail-back');
	if (toolDetailBack) toolDetailBack.addEventListener('click', () => { _toolDetailId = null; navTo('/marketplace?tab=tools'); });
	const skillDetailBack = $('skill-detail-back');
	if (skillDetailBack) skillDetailBack.addEventListener('click', () => { _skillDetailId = null; navTo('/marketplace?tab=skills'); });
	const animDetailBack = $('anim-detail-back');
	if (animDetailBack) animDetailBack.addEventListener('click', () => { _animDetailId = null; teardownAnimDetailStage(); navTo('/marketplace?tab=animations'); });
	const onchainDetailBack = $('onchain-detail-back');
	if (onchainDetailBack) onchainDetailBack.addEventListener('click', () => { _onchainDetailId = null; navTo('/marketplace?tab=onchain'); });
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
			if (agentId && skillName) openPurchaseFlow(agentId, skillName).catch((err) => log.error('[marketplace] purchase flow', err));
		}
		if (e.target.matches('.trial-btn')) {
			const skillName = e.target.dataset.skillName;
			const agentId = e.target.dataset.agentId;
			if (agentId && skillName) openTrialFlow(agentId, skillName, e.target).catch((err) => log.error('[marketplace] trial flow', err));
		}
		if (e.target.matches('.time-pass-btn')) {
			const skillName = e.target.dataset.skillName;
			const agentId = e.target.dataset.agentId;
			const duration = Number(e.target.dataset.duration);
			if (agentId && skillName && duration) openTimePassFlow(agentId, skillName, duration, e.target).catch((err) => log.error('[marketplace] time-pass flow', err));
		}
		const subPlanBtn = e.target.closest('[data-sub-plan]');
		if (subPlanBtn) {
			initiateSubscription(subPlanBtn.dataset.subPlan, subPlanBtn).catch((err) => log.error('[marketplace] subscribe flow', err));
			return;
		}
		const subManageBtn = e.target.closest('[data-sub-manage]');
		if (subManageBtn) {
			manageSubscription(subManageBtn.dataset.subManage, subManageBtn).catch((err) => log.error('[marketplace] manage subscription', err));
			return;
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
			const next = e.target.value.trim();
			if (next === skillsState.q) return;
			skillsState.q = next;
			loadSkillsTab(true);
		}, 250);
	});
	$('skills-sort')?.addEventListener('change', (e) => {
		const next = e.target.value;
		if (next === skillsState.sort) return;
		skillsState.sort = next;
		loadSkillsTab(true);
	});
	$('skills-loadmore')?.addEventListener('click', () => {
		if (skillsState.cursor) loadSkillsTab(false, true);
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

	// "Import from JSON" — reveal the paste area, then map LobeHub-compatible
	// agent JSON ({ config: { systemRole }, meta: { title, … } }) onto the form.
	const importToggle = $('market-import-toggle');
	const importArea = $('market-import-area');
	if (importToggle && importArea) {
		importToggle.setAttribute('aria-expanded', 'false');
		importToggle.setAttribute('aria-controls', 'market-import-area');
		importToggle.addEventListener('click', () => {
			const open = importArea.hidden;
			importArea.hidden = !open;
			importToggle.textContent = open ? 'Import from JSON ↑' : 'Import from JSON ↓';
			importToggle.setAttribute('aria-expanded', String(open));
			if (open) $('market-import-json')?.focus();
		});
	}
	$('market-import-apply')?.addEventListener('click', () => {
		errorEl.hidden = true;
		const raw = ($('market-import-json')?.value || '').trim();
		if (!raw) {
			errorEl.textContent = 'Paste agent JSON first.';
			errorEl.hidden = false;
			return;
		}
		let j;
		try {
			j = JSON.parse(raw);
		} catch {
			errorEl.textContent = 'Invalid JSON — check the pasted text and try again.';
			errorEl.hidden = false;
			return;
		}
		const meta = j.meta || {};
		const config = j.config || {};
		const name = meta.title || meta.name || '';
		const systemRole = config.systemRole || '';
		if (!name && !systemRole) {
			errorEl.textContent =
				'JSON parsed, but no agent fields found — expected { "config": { "systemRole" }, "meta": { "title" } }.';
			errorEl.hidden = false;
			return;
		}
		if (name) $('sf-name').value = name;
		if (meta.description) $('sf-description').value = meta.description;
		if (systemRole) $('sf-prompt').value = systemRole;
		if (config.greeting) $('sf-greeting').value = config.greeting;
		if (Array.isArray(meta.tags)) $('sf-tags').value = meta.tags.join(', ');
		const categorySel = $('sf-category');
		const category = String(meta.category || '').toLowerCase();
		if (category && [...categorySel.options].some((o) => o.value === category)) {
			categorySel.value = category;
		}
		importArea.hidden = true;
		if (importToggle) {
			importToggle.textContent = 'Import from JSON ↓';
			importToggle.setAttribute('aria-expanded', 'false');
		}
		$('sf-name').focus();
	});

	const submitAgent = async (publish, btn) => {
		const body = {
			name: $('sf-name').value,
			description: $('sf-description').value,
			system_prompt: $('sf-prompt').value,
			greeting: $('sf-greeting').value,
			category: $('sf-category').value,
			tags: $('sf-tags').value.split(',').map(t => t.trim()).filter(Boolean),
			publish,
		};

		const idleLabel = btn.textContent;
		btn.disabled = true;
		btn.textContent = publish ? 'Publishing…' : 'Saving…';
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
			if (publish) {
				closeSubmitModal();
				loadList(true);
			} else {
				// Drafts don't appear in the public list — confirm in place so the
				// user knows the save landed, then close.
				btn.textContent = 'Draft saved ✓';
				setTimeout(() => {
					closeSubmitModal();
					btn.textContent = idleLabel;
				}, 900);
			}
		} catch (err) {
			errorEl.textContent = err.message;
			errorEl.hidden = false;
		} finally {
			btn.disabled = false;
			if (publish || errorEl.hidden === false) btn.textContent = idleLabel;
		}
	};

	$('sf-publish').addEventListener('click', (e) => submitAgent(true, e.currentTarget));
	$('sf-save-draft').addEventListener('click', (e) => submitAgent(false, e.currentTarget));
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
function modelCategoryBadge(category) {
	const cat = category || 'avatar';
	const label = MODEL_CATEGORY_LABELS[cat] || cat;
	const icon = MODEL_CATEGORY_ICONS[cat] || '○';
	return `<span class="avatar-pill model-cat-pill model-cat-${escapeHtml(cat)}">${icon} ${escapeHtml(label)}</span>`;
}

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

// An agent is "paid" when it sells access in any form: a one-time asset price
// OR per-call skill pricing (agent_skill_prices, surfaced as has_paid_skills /
// skill_prices). Mirrors the server-side `pricing` filter in
// api/marketplace/[action].js so client and server agree on what "paid" means.
function isAgentPaid(a) {
	return (
		hasActivePrice(a.price) ||
		!!a.has_paid_skills ||
		Object.keys(a.skill_prices || {}).length > 0
	);
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
	bindProviderEvents(provider, entry.name);
	notifyWalletChanged();
}

function disconnectWallet() {
	try { connectedWallet?.provider?.disconnect?.(); } catch {}
	connectedWallet = null;
	notifyWalletChanged();
}

// Single fan-out for every wallet state transition. Keeps the in-modal
// purchase UI (`updateWalletUI`) and the persistent header control
// (`renderHeaderWallet`) reading from the same `connectedWallet` source.
function notifyWalletChanged() {
	updateWalletUI();
	renderHeaderWallet();
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

// ── Persistent header wallet control ───────────────────────────────────────
//
// Surfaces the wallet connection in the marketplace chrome (sidebar on
// desktop, topbar on mobile) so a buyer can connect once and reach any Buy
// action already-connected. Every `[data-wallet-connect]` slot renders from
// the shared `connectedWallet`, so connecting in either the header or the
// purchase modal updates both. Uses the real injected providers — Phantom,
// Solflare, Backpack — same as the purchase flow; no separate wallet lib.

const WALLET_EXPLORER = 'https://solscan.io/account/';
const _walletEventsBound = new WeakSet();

function walletInstallUrl(key) {
	if (key === 'solflare') return 'https://solflare.com';
	if (key === 'backpack') return 'https://backpack.app';
	return 'https://phantom.app';
}

function shortWalletAddress(pk) {
	return `${pk.slice(0, 4)}…${pk.slice(-4)}`;
}

function renderHeaderWallet() {
	const slots = document.querySelectorAll('[data-wallet-connect]');
	slots.forEach((slot) => {
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'mkt-wallet-btn';
		btn.setAttribute('aria-haspopup', 'menu');
		btn.setAttribute('aria-expanded', 'false');

		if (connectedWallet) {
			const pk = connectedWallet.publicKey.toBase58();
			btn.classList.add('is-connected');
			btn.innerHTML =
				'<span class="mkt-wallet-dot" aria-hidden="true"></span>' +
				`<span class="mkt-wallet-label">${escapeHtml(shortWalletAddress(pk))}</span>` +
				'<span class="mkt-wallet-caret" aria-hidden="true">▾</span>';
			btn.setAttribute(
				'aria-label',
				`${connectedWallet.name} wallet connected, ${pk}. Open wallet menu`,
			);
			btn.addEventListener('click', () => openConnectedWalletMenu(btn));
		} else {
			btn.innerHTML =
				'<span class="mkt-wallet-ico" aria-hidden="true">◎</span>' +
				'<span class="mkt-wallet-label">Connect Wallet</span>';
			btn.setAttribute('aria-label', 'Connect a Solana wallet');
			btn.addEventListener('click', () => onHeaderConnectClick(btn));
		}

		slot.replaceChildren(btn);
	});
}

async function onHeaderConnectClick(btn) {
	// Detect at click time — extensions can inject after page load.
	const available = listAvailableWallets();
	if (available.length === 1) {
		await headerConnectWallet(available[0].key, btn);
		return;
	}
	if (available.length > 1) {
		openWalletMenu(
			btn,
			available.map((w) => ({
				label: `Connect ${w.name}`,
				onClick: () => headerConnectWallet(w.key, btn),
			})),
		);
		return;
	}
	// No injected wallet — offer install links.
	openWalletMenu(
		btn,
		WALLET_PROVIDERS.map((p) => ({
			label: `Install ${p.name} ↗`,
			href: walletInstallUrl(p.key),
		})),
	);
}

async function headerConnectWallet(key, btn) {
	closeWalletMenu();
	const label = btn.querySelector('.mkt-wallet-label');
	const prev = label?.textContent;
	if (label) label.textContent = 'Connecting…';
	btn.classList.add('is-busy');
	btn.disabled = true;
	try {
		// Sets connectedWallet then notifyWalletChanged() re-renders every slot.
		await connectWalletProvider(key);
	} catch (e) {
		btn.disabled = false;
		btn.classList.remove('is-busy');
		if (label) label.textContent = prev || 'Connect Wallet';
		const rejected = e?.code === 4001 || /reject|cancel/i.test(e?.message || '');
		flashWalletBubble(btn, rejected ? 'Connection cancelled.' : e?.message || 'Could not connect wallet.', 'err');
	}
}

function openConnectedWalletMenu(btn) {
	if (!connectedWallet) return;
	const pk = connectedWallet.publicKey.toBase58();
	openWalletMenu(btn, [
		{ label: 'Copy address', onClick: () => copyWalletAddress(pk, btn) },
		{ label: 'View on Solscan ↗', href: WALLET_EXPLORER + pk },
		{ label: 'Disconnect', danger: true, onClick: () => disconnectWallet() },
	]);
}

async function copyWalletAddress(pk, btn) {
	closeWalletMenu();
	try {
		await navigator.clipboard.writeText(pk);
		flashWalletBubble(btn, 'Address copied', 'ok');
	} catch {
		flashWalletBubble(btn, 'Copy failed', 'err');
	}
}

// Keep the header in sync when the user disconnects or switches accounts from
// the wallet extension itself (not just via our UI). Bound once per provider.
function bindProviderEvents(provider, name) {
	if (!provider?.on || _walletEventsBound.has(provider)) return;
	_walletEventsBound.add(provider);
	provider.on('disconnect', () => {
		if (connectedWallet?.provider === provider) {
			connectedWallet = null;
			notifyWalletChanged();
		}
	});
	provider.on('accountChanged', async (pubKey) => {
		if (connectedWallet?.provider !== provider) return;
		if (!pubKey) {
			connectedWallet = null;
			notifyWalletChanged();
			return;
		}
		const { web3 } = await loadSolanaModules();
		connectedWallet = {
			provider,
			name,
			publicKey: typeof pubKey === 'string' ? new web3.PublicKey(pubKey) : pubKey,
		};
		notifyWalletChanged();
	});
}

// Silently restore a previously-authorized session on load — no popup. Phantom
// & friends resolve connect({ onlyIfTrusted:true }) only when already trusted.
async function eagerReconnectWallet() {
	if (connectedWallet) return;
	for (const entry of WALLET_PROVIDERS) {
		const provider = entry.detect();
		if (!provider?.connect) continue;
		try {
			const resp = await provider.connect({ onlyIfTrusted: true });
			const pubKey = resp?.publicKey ?? provider.publicKey;
			if (!pubKey) continue;
			const { web3 } = await loadSolanaModules();
			connectedWallet = {
				provider,
				name: entry.name,
				publicKey: typeof pubKey === 'string' ? new web3.PublicKey(pubKey) : pubKey,
			};
			bindProviderEvents(provider, entry.name);
			notifyWalletChanged();
			return;
		} catch {
			// Not trusted for this origin — try the next provider silently.
		}
	}
}

function mountHeaderWallet() {
	if (!document.querySelector('[data-wallet-connect]')) return;
	renderHeaderWallet();
	eagerReconnectWallet();
}

// ── Header wallet dropdown / feedback primitives ───────────────────────────
//
// A single body-mounted, viewport-clamped popover anchored to the wallet
// button (so the sidebar/topbar can't clip it). Closes on outside-click,
// Escape, scroll, or resize.

let _walletMenuEl = null;
let _walletMenuAnchor = null;

function openWalletMenu(anchor, items) {
	closeWalletMenu();
	const menu = document.createElement('div');
	menu.className = 'mkt-wallet-menu';
	menu.setAttribute('role', 'menu');
	for (const item of items) {
		let el;
		if (item.href) {
			el = document.createElement('a');
			el.href = item.href;
			el.target = '_blank';
			el.rel = 'noopener';
		} else {
			el = document.createElement('button');
			el.type = 'button';
			el.addEventListener('click', () => item.onClick?.());
		}
		el.className = 'mkt-wallet-menu-item' + (item.danger ? ' danger' : '');
		el.setAttribute('role', 'menuitem');
		el.textContent = item.label;
		menu.appendChild(el);
	}
	document.body.appendChild(menu);
	positionFloating(menu, anchor);
	anchor.setAttribute('aria-expanded', 'true');
	_walletMenuEl = menu;
	_walletMenuAnchor = anchor;
	requestAnimationFrame(() => menu.querySelector('.mkt-wallet-menu-item')?.focus());
	// Defer binding so the click that opened the menu doesn't immediately close it.
	setTimeout(() => {
		document.addEventListener('click', onWalletMenuOutside, true);
		document.addEventListener('keydown', onWalletMenuKeydown, true);
		window.addEventListener('resize', closeWalletMenu);
		window.addEventListener('scroll', closeWalletMenu, true);
	}, 0);
}

function closeWalletMenu() {
	_walletMenuAnchor?.setAttribute('aria-expanded', 'false');
	_walletMenuEl?.remove();
	_walletMenuEl = null;
	_walletMenuAnchor = null;
	document.removeEventListener('click', onWalletMenuOutside, true);
	document.removeEventListener('keydown', onWalletMenuKeydown, true);
	window.removeEventListener('resize', closeWalletMenu);
	window.removeEventListener('scroll', closeWalletMenu, true);
}

function onWalletMenuOutside(e) {
	if (!_walletMenuEl) return;
	if (_walletMenuEl.contains(e.target)) return;
	if (_walletMenuAnchor?.contains(e.target)) return;
	closeWalletMenu();
}

function onWalletMenuKeydown(e) {
	if (e.key === 'Escape') {
		const anchor = _walletMenuAnchor;
		closeWalletMenu();
		anchor?.focus();
	}
}

function positionFloating(el, anchor) {
	const r = anchor.getBoundingClientRect();
	const w = el.offsetWidth || 200;
	let left = r.left;
	if (left + w > window.innerWidth - 8) left = Math.max(8, r.right - w);
	el.style.top = `${Math.round(r.bottom + 6)}px`;
	el.style.left = `${Math.round(left)}px`;
}

let _walletBubbleTimer;
function flashWalletBubble(anchor, text, kind) {
	const bubble = document.createElement('div');
	bubble.className = 'mkt-wallet-bubble' + (kind ? ` ${kind}` : '');
	bubble.setAttribute('role', 'status');
	bubble.textContent = text;
	document.body.appendChild(bubble);
	positionFloating(bubble, anchor);
	requestAnimationFrame(() => bubble.classList.add('show'));
	clearTimeout(_walletBubbleTimer);
	_walletBubbleTimer = setTimeout(() => {
		bubble.classList.remove('show');
		setTimeout(() => bubble.remove(), 250);
	}, 2600);
}

function setStatus(text, kind) {
	const el = $('payment-status');
	if (!el) return;
	el.textContent = text;
	el.className = 'payment-status' + (kind ? ' ' + kind : '');
}

// Honest fee disclosure: once the server quotes a purchase, show how the price
// is split — a platform fee leg plus what the creator nets — before the buyer
// approves the transfer. No fee → the note stays hidden.
function renderFeeDisclosure(purchase) {
	const el = $('payment-fee-note');
	if (!el) return;
	const fee = purchase?.fee;
	if (!fee || !(Number(fee.amount) > 0)) {
		clearFeeDisclosure();
		return;
	}
	const decimals = Number(purchase.mint_decimals ?? 6);
	const places = decimals === 6 ? 2 : 4;
	const mintLabel = shortMintLabel(purchase.currency_mint);
	const toUi = (atomic) => (Number(atomic) / Math.pow(10, decimals)).toFixed(places);
	const creatorAtomic = purchase.creator_amount ?? String(BigInt(purchase.amount) - BigInt(fee.amount));
	const pct = (fee.bps / 100).toLocaleString(undefined, { maximumFractionDigits: 2 });
	el.innerHTML =
		`Includes a <strong>${pct}% platform fee</strong> (${toUi(fee.amount)} ${escapeHtml(mintLabel)}). ` +
		`Creator receives <strong>${toUi(creatorAtomic)} ${escapeHtml(mintLabel)}</strong>.`;
	el.hidden = false;
}

function clearFeeDisclosure() {
	const el = $('payment-fee-note');
	if (el) {
		el.hidden = true;
		el.innerHTML = '';
	}
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
	clearFeeDisclosure();
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
	clearFeeDisclosure();
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
	clearFeeDisclosure();
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
			amount: BigInt(purchase.creator_amount ?? purchase.amount),
			reference: purchase.reference,
			fee: purchase.fee
				? { recipient: purchase.fee.recipient, amount: BigInt(purchase.fee.amount) }
				: null,
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
		log.error('[marketplace] asset purchase failed', e);
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
		renderFeeDisclosure(purchase);
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
			amount: BigInt(purchase.creator_amount ?? purchase.amount),
			reference: purchase.reference,
			fee: purchase.fee
				? { recipient: purchase.fee.recipient, amount: BigInt(purchase.fee.amount) }
				: null,
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
		log.error('[marketplace] purchase failed', e);
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

// Build the purchase transfer. `amount` is the seller's leg (the full price when
// no platform fee applies). When `fee` is present, a second leg moves the
// platform fee to the treasury in the SAME transaction, so the buyer signs once
// and both legs settle atomically — no custody, no second approval.
async function buildSplTransferWithReference({ payer, recipient, mint, amount, reference, fee }) {
	const { web3, spl } = await loadSolanaModules();
	const { PublicKey, Transaction } = web3;
	const {
		getAssociatedTokenAddress,
		createTransferInstruction,
		createAssociatedTokenAccountIdempotentInstruction,
	} = spl;

	const recipientKey = new PublicKey(recipient);
	const mintKey = new PublicKey(mint);
	const referenceKey = new PublicKey(reference);

	const fromAta = await getAssociatedTokenAddress(mintKey, payer);
	const toAta = await getAssociatedTokenAddress(mintKey, recipientKey);

	const { blockhash } = await (await getSolanaConnection()).getLatestBlockhash('confirmed');
	const tx = new Transaction({ feePayer: payer, recentBlockhash: blockhash });

	// Fee leg first (when present): the platform fee to the treasury. The seller
	// leg goes LAST and carries the Solana-Pay reference — @solana/pay's
	// validateTransfer only inspects the FINAL instruction for the reference
	// binding, so the referenced transfer must be the last one in the tx.
	if (fee && fee.amount > 0n) {
		const feeOwner = new PublicKey(fee.recipient);
		const feeAta = await getAssociatedTokenAddress(mintKey, feeOwner);
		// Create the treasury's token account on first use (buyer funds the tiny
		// rent once); idempotent so repeat purchases add nothing.
		tx.add(createAssociatedTokenAccountIdempotentInstruction(payer, feeAta, feeOwner, mintKey));
		tx.add(createTransferInstruction(fromAta, feeAta, payer, fee.amount));
	}

	const ix = createTransferInstruction(fromAta, toAta, payer, amount);
	// Solana Pay: append the reference as a readonly, non-signer key so the
	// server can later locate this tx via getSignaturesForAddress(reference).
	ix.keys.push({ pubkey: referenceKey, isSigner: false, isWritable: false });
	tx.add(ix);

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
			(nav === 'earn' && r.view === 'earn') ||
		(nav === 'animations' && r.view === 'animations') ||
		(nav === 'memory' && r.view === 'memory');
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
		const routePricing = r.pricing || 'all';
		if (routePricing !== state.priceFilter) {
			state.priceFilter = routePricing;
			document.querySelectorAll('#market-price-filter-chips .market-chip').forEach((c) => {
				c.classList.toggle('active', (c.dataset.priceFilter || 'all') === routePricing);
			});
			loadList(true, { agentsOnly: true });
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
	const animSec = $('market-animations-section');
	const memorySec = $('market-memory-section');
	const discovery = els.discovery;
	const tools = els.tools;
	const detail = els.detail;

	const setHidden = (el, hidden) => { if (el) el.hidden = hidden; };

	// The tool-detail section is not touched by the other view branches, so
	// hide it by default and let only its own branch reveal it. This keeps
	// navigation away from a plugin page (e.g. back to the tools grid) clean.
	const toolDetailSec = $('market-tool-detail');
	setHidden(toolDetailSec, r.view !== 'tool-detail');
	if (r.view !== 'tool-detail' && _toolDetailId !== null) {
		_toolDetailId = null;
		resetSocialMeta();
	}

	const skillDetailSec = $('market-skill-detail');
	setHidden(skillDetailSec, r.view !== 'skill-detail');
	if (r.view !== 'skill-detail' && _skillDetailId !== null) {
		_skillDetailId = null;
		resetSocialMeta();
	}

	const animDetailSec = $('market-anim-detail');
	setHidden(animDetailSec, r.view !== 'anim-detail');
	if (r.view !== 'anim-detail' && _animDetailId !== null) {
		_animDetailId = null;
		teardownAnimDetailStage();
		resetSocialMeta();
	}

	const onchainDetailSec = $('market-onchain-detail');
	setHidden(onchainDetailSec, r.view !== 'onchain-detail');
	if (r.view !== 'onchain-detail' && _onchainDetailId !== null) {
		_onchainDetailId = null;
		resetSocialMeta();
	}

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
		setHidden(animSec, true);
		setHidden(memorySec, true);
		setHidden(avatarDetailSec, false);
		avatarDetailSec?.scrollIntoView({ behavior: 'instant', block: 'start' });
	} else if (r.view === 'tool-detail') {
		setHidden(discovery, true);
		setHidden(detail, true);
		setHidden(tools, true);
		setHidden(skillsSec, true);
		setHidden(mineSec, true);
		setHidden(purchasesSec, true);
		setHidden(earnSec, true);
		setHidden(animSec, true);
		setHidden(memorySec, true);
		setHidden(avatarDetailSec, true);
		loadToolDetail(r.id);
		toolDetailSec?.scrollIntoView({ behavior: 'instant', block: 'start' });
	} else if (r.view === 'skill-detail') {
		setHidden(discovery, true);
		setHidden(detail, true);
		setHidden(tools, true);
		setHidden(skillsSec, true);
		setHidden(mineSec, true);
		setHidden(purchasesSec, true);
		setHidden(earnSec, true);
		setHidden(animSec, true);
		setHidden(memorySec, true);
		setHidden(avatarDetailSec, true);
		loadSkillDetail(r.id);
		skillDetailSec?.scrollIntoView({ behavior: 'instant', block: 'start' });
	} else if (r.view === 'anim-detail') {
		setHidden(discovery, true);
		setHidden(detail, true);
		setHidden(tools, true);
		setHidden(skillsSec, true);
		setHidden(mineSec, true);
		setHidden(purchasesSec, true);
		setHidden(earnSec, true);
		setHidden(animSec, true);
		setHidden(memorySec, true);
		setHidden(avatarDetailSec, true);
		loadAnimDetail(r.id);
		animDetailSec?.scrollIntoView({ behavior: 'instant', block: 'start' });
	} else if (r.view === 'onchain-detail') {
		setHidden(discovery, true);
		setHidden(detail, true);
		setHidden(tools, true);
		setHidden(skillsSec, true);
		setHidden(mineSec, true);
		setHidden(purchasesSec, true);
		setHidden(earnSec, true);
		setHidden(animSec, true);
		setHidden(memorySec, true);
		setHidden(avatarDetailSec, true);
		loadOnchainDetail(r.id);
		onchainDetailSec?.scrollIntoView({ behavior: 'instant', block: 'start' });
	} else if (r.view === 'detail') {
		loadDetail(r.id);
		setHidden(discovery, true);
		setHidden(tools, true);
		setHidden(skillsSec, true);
		setHidden(mineSec, true);
		setHidden(purchasesSec, true);
		setHidden(earnSec, true);
		setHidden(animSec, true);
		setHidden(memorySec, true);
		setHidden(avatarDetailSec, true);
		setHidden(detail, false);
	} else if (r.view === 'tools') {
		setHidden(detail, true);
		setHidden(discovery, true);
		setHidden(skillsSec, true);
		setHidden(mineSec, true);
		setHidden(purchasesSec, true);
		setHidden(earnSec, true);
		setHidden(animSec, true);
		setHidden(memorySec, true);
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
		setHidden(animSec, true);
		setHidden(memorySec, true);
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
		setHidden(animSec, true);
		setHidden(memorySec, true);
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
		setHidden(animSec, true);
		setHidden(memorySec, true);
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
		setHidden(animSec, true);
		setHidden(memorySec, true);
		setHidden(earnSec, false);
		loadEarnTab();
	} else if (r.view === 'animations') {
		setHidden(detail, true);
		setHidden(discovery, true);
		setHidden(tools, true);
		setHidden(skillsSec, true);
		setHidden(mineSec, true);
		setHidden(purchasesSec, true);
		setHidden(earnSec, true);
		setHidden(memorySec, true);
		setHidden(avatarDetailSec, true);
		setHidden(animSec, false);
		loadAnimationsTab();
	} else if (r.view === 'memory') {
		setHidden(detail, true);
		setHidden(discovery, true);
		setHidden(tools, true);
		setHidden(skillsSec, true);
		setHidden(mineSec, true);
		setHidden(purchasesSec, true);
		setHidden(earnSec, true);
		setHidden(animSec, true);
		setHidden(avatarDetailSec, true);
		setHidden(memorySec, false);
		loadMemoryTab();
	} else {
		setHidden(detail, true);
		setHidden(avatarDetailSec, true);
		setHidden(tools, true);
		setHidden(skillsSec, true);
		setHidden(mineSec, true);
		setHidden(purchasesSec, true);
		setHidden(earnSec, true);
		setHidden(animSec, true);
		setHidden(memorySec, true);
		setHidden(discovery, false);
		document.title = 'Agent Marketplace · three.ws';
	}
}

// ── Accessible dialog manager ──────────────────────────────────────────────
//
// Every overlay on this page is a `[role="dialog"]` toggled via the `hidden`
// attribute (and, for the avatar modal, a `.show` class for the fade). The
// individual open/close helpers are scattered, so rather than thread focus
// logic through each one we observe the `hidden` attribute on every dialog and
// centrally apply the WCAG keyboard contract: move focus in on open, trap Tab
// inside, close on Escape, and restore focus to the trigger on close.
const FOCUSABLE_SELECTOR = [
	'a[href]',
	'button:not([disabled])',
	'input:not([disabled])',
	'select:not([disabled])',
	'textarea:not([disabled])',
	'[tabindex]:not([tabindex="-1"])',
].join(',');

function visibleFocusables(container) {
	return Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR)).filter(
		(el) => !el.hidden && el.offsetParent !== null && el.getClientRects().length > 0,
	);
}

function isDialogOpen(dialog) {
	return !dialog.hidden;
}

function setupAccessibleDialogs() {
	const dialogs = Array.from(document.querySelectorAll('.market-page [role="dialog"]'));
	const triggerByDialog = new WeakMap();

	const closeDialog = (dialog) => {
		// Prefer the dialog's own close affordance so its bespoke teardown
		// (model-viewer disposal, fade-out) runs; fall back to hiding it.
		const closeBtn = dialog.querySelector(
			'[id$="-close"], .market-modal-close, .avatar-modal-close, .creator-modal-close, .market-lobby-close',
		);
		if (closeBtn) closeBtn.click();
		else dialog.hidden = true;
	};

	const onKeydown = (dialog) => (e) => {
		if (!isDialogOpen(dialog)) return;
		if (e.key === 'Escape') {
			e.preventDefault();
			closeDialog(dialog);
			return;
		}
		if (e.key !== 'Tab') return;
		const focusables = visibleFocusables(dialog);
		if (focusables.length === 0) {
			e.preventDefault();
			dialog.focus();
			return;
		}
		const first = focusables[0];
		const last = focusables[focusables.length - 1];
		const active = document.activeElement;
		if (e.shiftKey && (active === first || !dialog.contains(active))) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && active === last) {
			e.preventDefault();
			first.focus();
		}
	};

	const activate = (dialog) => {
		triggerByDialog.set(
			dialog,
			document.activeElement instanceof HTMLElement ? document.activeElement : null,
		);
		if (!dialog.hasAttribute('tabindex')) dialog.setAttribute('tabindex', '-1');
		// Defer so any content the open() helper injects exists before we focus.
		requestAnimationFrame(() => {
			if (!isDialogOpen(dialog)) return;
			const focusables = visibleFocusables(dialog);
			const target =
				dialog.querySelector('[data-autofocus]') ||
				focusables.find(
					(el) => !/close/i.test(el.id) && !el.classList.contains('market-modal-close'),
				) ||
				focusables[0] ||
				dialog;
			try {
				target.focus({ preventScroll: true });
			} catch {
				dialog.focus();
			}
		});
	};

	const deactivate = (dialog) => {
		const trigger = triggerByDialog.get(dialog);
		triggerByDialog.delete(dialog);
		if (trigger && document.body.contains(trigger)) {
			try {
				trigger.focus({ preventScroll: true });
			} catch {
				/* trigger may be gone after a re-render — no-op */
			}
		}
	};

	dialogs.forEach((dialog) => {
		dialog.addEventListener('keydown', onKeydown(dialog));

		let wasOpen = isDialogOpen(dialog);
		if (wasOpen) activate(dialog);

		const obs = new MutationObserver(() => {
			const open = isDialogOpen(dialog);
			if (open === wasOpen) return;
			wasOpen = open;
			if (open) activate(dialog);
			else deactivate(dialog);
		});
		obs.observe(dialog, { attributes: true, attributeFilter: ['hidden'] });
	});
}

function init() {
	bindEvents();
	setupAccessibleDialogs();
	mountHeaderWallet();
	// Seed the price filter from a deep-linked ?pricing= before the first fetch.
	// render() runs after loadList() has already flipped state.loading, so its
	// pricing branch would bail on the in-flight load — seeding here makes the
	// very first request carry the right filter and keeps the chip in sync.
	const route0 = readRoute();
	if (route0.view === 'list' && route0.pricing) {
		state.priceFilter = route0.pricing;
		document.querySelectorAll('#market-price-filter-chips .market-chip').forEach((c) => {
			c.classList.toggle('active', (c.dataset.priceFilter || 'all') === route0.pricing);
		});
	}
	loadCategories();
	loadList(true);
	loadTheme();
	loadOracleStats();
	loadTopPerformers();
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
		if (grid) {
			grid.setAttribute('aria-busy', 'true');
			grid.innerHTML = renderSkeletons(6);
		}
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
		if (grid) grid.innerHTML = renderErrorState('plugins');
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
	// Whole-card navigation to the rich detail page. The install/buy button
	// inside stops propagation so it keeps its own behaviour.
	grid.querySelectorAll('[data-tool-id]').forEach((card) => {
		const go = () => navTo(`/marketplace/tools/${encodeURIComponent(card.dataset.toolId)}`);
		card.addEventListener('click', (e) => {
			if (e.target.closest('[data-plugin-id]')) return;
			go();
		});
		card.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
		});
	});
	grid.querySelectorAll('[data-plugin-id]').forEach((btn) => {
		btn.addEventListener('click', (e) => {
			e.stopPropagation();
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
	// Prefer a manifest emoji/glyph avatar; image URLs and missing avatars fall
	// back to the name's first letter so the grid stays visually uniform.
	const av = manifest?.meta?.avatar;
	const icon = av && !/^(https?:\/\/|\/)/.test(av)
		? escapeHtml(av)
		: (p.name || p.identifier || '?')[0].toUpperCase();
	const priceBadge = priceBadgeHtml(p.price);
	// Whole card deep-links to the plugin detail page when it has a DB id.
	const linkAttrs = p.id
		? `class="plugin-card plugin-card-clickable" data-tool-id="${escapeHtml(p.id)}" role="link" tabindex="0" aria-label="View ${title} details"`
		: 'class="plugin-card"';
	return `<div ${linkAttrs} style="position:relative">
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

// ── Plugin detail page ──────────────────────────────────────────────────────
// Rich, deep-linkable page for a single plugin at /marketplace/tools/:id.
// Lists every tool the plugin exposes with its parameters, plus the system
// role, author, pricing and an install / buy action.

let _toolDetailId = null;

function _setToolDetailState({ skeleton = false, empty = false, body = false }) {
	const skel = $('tool-detail-skeleton');
	const emptyEl = $('tool-detail-empty');
	const bodyEl = $('tool-detail-body');
	if (skel) skel.hidden = !skeleton;
	if (emptyEl) emptyEl.hidden = !empty;
	if (bodyEl) bodyEl.hidden = !body;
}

function _renderToolDetailEmpty() {
	_setToolDetailState({ empty: true });
	setSocialMeta({
		title: 'Plugin not found · three.ws',
		description: 'This plugin may have been removed or the link is wrong.',
		url: location.origin + location.pathname,
		image: _socialMetaDefaults.image,
	});
}

async function loadToolDetail(id) {
	if (_toolDetailId === id) return; // already rendered for this id

	_setToolDetailState({ skeleton: true });

	// Try the in-memory list first (instant if the user browsed there), then
	// fetch the canonical record. Don't cache the id until a successful render
	// so a transient failure leaves the page retryable.
	let plugin = pluginState.items.find((p) => p.id === id || p.identifier === id);
	if (!plugin) {
		try {
			const r = await fetch(`${PLUGIN_API}/${encodeURIComponent(id)}`);
			if (r.ok) {
				const j = await r.json();
				plugin = j?.data?.plugin || null;
			}
		} catch (err) {
			log.error('[marketplace] tool detail fetch', err);
		}
	}

	// Re-check the route — the user may have navigated away during the fetch.
	if (readRoute().view !== 'tool-detail') return;

	if (!plugin) {
		_renderToolDetailEmpty();
		return;
	}

	renderToolDetail(plugin);
	_toolDetailId = id;
}

function renderToolDetail(p) {
	const manifest = p.manifest_json ?? p;
	const title = p.name || manifest?.meta?.title || p.identifier || 'Untitled plugin';
	const desc = p.description || manifest?.meta?.description || '';
	const category = p.category || manifest?.meta?.category || 'general';
	const tags = p.tags || manifest?.meta?.tags || [];
	const tools = Array.isArray(manifest?.api) ? manifest.api : [];
	const version = manifest?.version || null;
	const homepage = manifest?.homepage || null;
	const manifestUrl = p.manifest_url || manifest?._manifest_url || null;
	const systemRole = manifest?.systemRole || '';
	const avatarUrl = manifest?.meta?.avatar || null;
	const rating = Number(p.avg_rating) || 0;

	// Icon — manifest avatar may be an image URL or an emoji/glyph. Anything
	// that looks like a URL renders as an <img>; everything else (emoji, short
	// glyph) renders as text, falling back to the title's first letter.
	const iconEl = $('tool-detail-icon');
	if (iconEl) {
		const isUrl = avatarUrl && /^(https?:\/\/|\/)/.test(avatarUrl);
		if (isUrl) {
			iconEl.innerHTML = `<img src="${escapeHtml(avatarUrl)}" alt="" loading="lazy" />`;
		} else {
			iconEl.textContent = avatarUrl || (title || '?')[0].toUpperCase();
		}
	}

	$('tool-detail-name').textContent = title;
	$('tool-detail-id').textContent = p.identifier || '';

	const authorEl = $('tool-detail-author');
	const authorName = p.author?.display_name || (typeof manifest?.author === 'string' ? manifest.author : null);
	if (authorEl) {
		if (authorName) {
			authorEl.hidden = false;
			authorEl.textContent = `by ${authorName}`;
		} else {
			authorEl.hidden = true;
			authorEl.textContent = '';
		}
	}

	// Price badge (reuses the listing pill).
	const priceEl = $('tool-detail-price');
	if (priceEl) priceEl.innerHTML = priceBadgeHtml(p.price);

	// Pills — category, tool count, installs, rating, version, then tags.
	const pillsEl = $('tool-detail-pills');
	if (pillsEl) {
		const pills = [];
		pills.push(`<span class="stat-pill">${escapeHtml(category)}</span>`);
		pills.push(`<span class="stat-pill">${tools.length} tool${tools.length !== 1 ? 's' : ''}</span>`);
		pills.push(`<span class="stat-pill">↓ ${fmtNumber(p.install_count || 0)} installs</span>`);
		if (rating > 0) pills.push(`<span class="stat-pill">★ ${rating.toFixed(1)}</span>`);
		if (version) pills.push(`<span class="stat-pill">v${escapeHtml(String(version))}</span>`);
		tags.forEach((t) => {
			pills.push(`<button type="button" class="tag-pill" data-tag="${escapeHtml(t)}">#${escapeHtml(t)}</button>`);
		});
		pillsEl.innerHTML = pills.join('');
		pillsEl.querySelectorAll('[data-tag]').forEach((btn) => {
			btn.addEventListener('click', () => navTo(`/marketplace?tab=tools&tag=${encodeURIComponent(btn.dataset.tag)}`));
		});
	}

	const descEl = $('tool-detail-desc');
	if (descEl) {
		descEl.textContent = desc;
		descEl.hidden = !desc;
	}

	// Install / buy CTA.
	const installBtn = $('tool-detail-install');
	if (installBtn) {
		const refreshCta = () => {
			const installed = getInstalledIds().has(p.identifier);
			const paid = hasActivePrice(p.price);
			installBtn.classList.toggle('installed', installed);
			installBtn.textContent = installed
				? 'Installed ✓ — Remove'
				: paid
					? `Buy ${formatAssetPrice(p.price)}`
					: 'Add to Agent';
		};
		refreshCta();
		installBtn.onclick = () => {
			const installed = getInstalledIds().has(p.identifier);
			const paid = hasActivePrice(p.price);
			if (paid && p.id && !installed) {
				openAssetPurchaseFlow({
					item_type: 'plugin',
					item_id: p.id,
					label: title,
					price: p.price,
				});
				return;
			}
			togglePluginInstall(manifest);
			refreshCta();
		};
	}

	// Share.
	const shareBtn = $('tool-detail-share');
	if (shareBtn) {
		shareBtn.onclick = async () => {
			const shareUrl = location.href;
			const shareTitle = `${title} — three.ws plugin`;
			const shareText = desc || 'Check out this agent plugin on three.ws';
			if (navigator.share) {
				try { await navigator.share({ title: shareTitle, text: shareText, url: shareUrl }); return; }
				catch { /* cancelled — fall through to copy */ }
			}
			try {
				await navigator.clipboard.writeText(shareUrl);
				const original = shareBtn.textContent;
				shareBtn.textContent = 'Link copied ✓';
				shareBtn.classList.add('copied');
				setTimeout(() => { shareBtn.textContent = original; shareBtn.classList.remove('copied'); }, 1800);
			} catch (err) {
				log.error('[marketplace] tool share copy', err);
			}
		};
	}

	// External links.
	const homeBtn = $('tool-detail-homepage');
	if (homeBtn) {
		if (homepage) { homeBtn.hidden = false; homeBtn.href = homepage; }
		else homeBtn.hidden = true;
	}
	const manifestBtn = $('tool-detail-manifest');
	if (manifestBtn) {
		if (manifestUrl) { manifestBtn.hidden = false; manifestBtn.href = manifestUrl; }
		else manifestBtn.hidden = true;
	}

	// System role.
	const sysWrap = $('tool-detail-systemrole-wrap');
	const sysEl = $('tool-detail-systemrole');
	if (sysWrap && sysEl) {
		if (systemRole) { sysWrap.hidden = false; sysEl.textContent = systemRole; }
		else sysWrap.hidden = true;
	}

	// Tools list — the heart of the detail page.
	const toolsWrap = $('tool-detail-tools-wrap');
	const toolsEl = $('tool-detail-tools');
	const toolsCount = $('tool-detail-tools-count');
	if (toolsCount) toolsCount.textContent = tools.length ? `${tools.length}` : '';
	if (toolsWrap && toolsEl) {
		if (!tools.length) {
			toolsWrap.hidden = true;
		} else {
			toolsWrap.hidden = false;
			toolsEl.innerHTML = tools.map(renderToolCard).join('');
		}
	}

	// Social meta for link unfurls.
	setSocialMeta({
		title: `${title} — three.ws plugin`,
		description: desc || `An agent plugin exposing ${tools.length} tool${tools.length !== 1 ? 's' : ''} on three.ws.`,
		url: location.origin + location.pathname,
		image: avatarUrl || _socialMetaDefaults.image,
	});
	document.title = `${title} · three.ws`;

	_setToolDetailState({ body: true });
}

function renderToolCard(tool) {
	const name = escapeHtml(tool?.name || 'tool');
	const description = escapeHtml(tool?.description || '');
	const endpoint = tool?.url ? `<span class="tool-card-endpoint">${escapeHtml(tool.url)}</span>` : '';
	const params = tool?.parameters;
	const props = params && typeof params.properties === 'object' ? params.properties : null;
	const required = new Set(Array.isArray(params?.required) ? params.required : []);

	let paramsHtml = '';
	if (props && Object.keys(props).length) {
		const rows = Object.entries(props).map(([key, schema]) => {
			const type = schema?.type ? escapeHtml(String(schema.type)) : 'any';
			const pdesc = schema?.description ? `<div class="tool-param-desc">${escapeHtml(schema.description)}</div>` : '';
			const isReq = required.has(key);
			const enumVals = Array.isArray(schema?.enum) ? schema.enum : null;
			const enumHtml = enumVals
				? `<div class="tool-param-enum">${enumVals.map((v) => `<code>${escapeHtml(String(v))}</code>`).join('')}</div>`
				: '';
			return `<div class="tool-param">
				<div class="tool-param-row">
					<span class="tool-param-name">${escapeHtml(key)}</span>
					<span class="tool-param-type">${type}</span>
					${isReq ? '<span class="tool-param-req">required</span>' : ''}
				</div>
				${pdesc}
				${enumHtml}
			</div>`;
		}).join('');
		paramsHtml = `<div class="tool-card-params">
			<div class="tool-card-params-label">Parameters</div>
			${rows}
		</div>`;
	} else {
		paramsHtml = '<p class="tool-card-noparams">No parameters.</p>';
	}

	return `<div class="tool-card">
		<div class="tool-card-head">
			<span class="tool-card-name">${name}</span>
			${endpoint}
		</div>
		${description ? `<p class="tool-card-desc">${description}</p>` : ''}
		${paramsHtml}
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

// ── Platform activity strip ────────────────────────────────────────────────

async function loadOracleStats() {
	const strip = $('market-activity-strip');
	if (!strip) return;
	try {
		const r = await fetch('/api/oracle/stats', { headers: { accept: 'application/json' } });
		if (!r.ok) return;
		const d = await r.json();
		if (!d) return;

		const setKpi = (id, val) => {
			const el = $(id);
			if (!el) return;
			el.textContent = val;
			el.classList.remove('loading');
		};

		setKpi('mkt-stat-agents', fmtNumber(d.agents_armed ?? 0));
		setKpi('mkt-stat-scored', fmtNumber(d.scored_24h ?? 0));
		setKpi('mkt-stat-winrate', d.win_rate != null ? `${Number(d.win_rate).toFixed(0)}%` : '—');
		setKpi('mkt-stat-actions', fmtNumber(d.open_actions ?? 0));
		setKpi('mkt-stat-wins', fmtNumber(d.total_wins ?? 0));
		strip.hidden = false;
	} catch {
		// non-fatal — strip stays hidden
	}
}

const TOP_RANK_COLORS = ['#f59e0b', '#94a3b8', '#cd7c4f'];
const TOP_RANK_LABELS = ['#1', '#2', '#3'];

async function loadTopPerformers() {
	const section = $('mkt-top-section');
	const podium = $('mkt-top-podium');
	if (!section || !podium) return;

	// Show skeleton cards immediately so there's no layout jump when data arrives.
	podium.innerHTML = [0, 1, 2].map((i) => `
		<div class="mkt-top-card mkt-skel" style="--rank-color:${TOP_RANK_COLORS[i]}">
			<span class="mkt-top-rank">${TOP_RANK_LABELS[i]}</span>
			<div class="mkt-top-av-wrap"></div>
			<div class="mkt-top-name" style="width:70%;height:12px">&nbsp;</div>
			<div class="mkt-top-wr" style="width:60%;height:28px;margin-top:8px">&nbsp;</div>
			<div class="mkt-top-wr-lbl" style="width:50%;height:10px">&nbsp;</div>
			<div class="mkt-top-meta" style="width:80%;height:10px">&nbsp;</div>
		</div>`).join('');
	section.hidden = false;

	try {
		const r = await fetch('/api/oracle/leaderboard?limit=3&min_actions=3', {
			headers: { accept: 'application/json' },
		});
		if (!r.ok) { section.hidden = true; return; }
		const data = await r.json();
		const agents = data.agents || [];
		if (agents.length === 0) { section.hidden = true; return; }

		podium.innerHTML = agents.map((a, i) => {
			const color = TOP_RANK_COLORS[i] || '#6b7280';
			const label = TOP_RANK_LABELS[i] || `#${i + 1}`;
			const winRate = a.win_rate != null ? `${a.win_rate}%` : '—';
			const pnl = a.realized_pnl_sol != null
				? `${a.realized_pnl_sol >= 0 ? '+' : ''}${Number(a.realized_pnl_sol).toFixed(3)} SOL`
				: null;
			const pnlClass = a.realized_pnl_sol != null
				? (a.realized_pnl_sol >= 0 ? 'pos' : 'neg')
				: '';
			const avatarHtml = a.image_url
				? `<img src="${escapeHtml(a.image_url)}" alt="" class="mkt-top-avatar" loading="lazy" onerror="this.style.display='none'">`
				: `<span class="mkt-top-avatar-fallback">${escapeHtml((a.name || '?')[0].toUpperCase())}</span>`;

			return `<a class="mkt-top-card" href="/agents/${encodeURIComponent(a.agent_id)}"
					style="--rank-color:${color}"
					title="${escapeHtml(a.name || a.agent_id)}"
					aria-label="${escapeHtml(a.name || 'Agent')} — rank ${i + 1}, ${winRate} oracle win rate">
				<span class="mkt-top-rank">${label}</span>
				<div class="mkt-top-av-wrap">${avatarHtml}</div>
				<div class="mkt-top-name">${escapeHtml(a.name || 'Agent')}</div>
				<div class="mkt-top-wr">${escapeHtml(winRate)}</div>
				<div class="mkt-top-wr-lbl">Win rate</div>
				<div class="mkt-top-meta">
					<span>${a.wins}W / ${a.losses}L${a.open > 0 ? ` / ${a.open} open` : ''}</span>
					${pnl ? `<span class="mkt-top-pnl ${pnlClass}">${escapeHtml(pnl)}</span>` : ''}
				</div>
			</a>`;
		}).join('');
	} catch {
		section.hidden = true;
	}
}

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

