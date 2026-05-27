// Skills Marketplace — browse, search, and install agent skills.
//
// Fetches from /api/skills (list), /api/skills/categories, /api/skills/:id (detail).
// Supports search, category filtering, sort, cursor pagination, and detail drawer.

const PAGE_SIZE = 20;
const DEBOUNCE_MS = 250;
const SORT_OPTIONS = [
	{ key: 'popular', label: 'Popular' },
	{ key: 'new',     label: 'New' },
	{ key: 'az',      label: 'A–Z' },
];

const CATEGORY_ICONS = {
	general:       '\u{1F9E9}',
	automation:    '\u{2699}️',
	data:          '\u{1F4CA}',
	communication: '\u{1F4AC}',
	finance:       '\u{1F4B0}',
	media:         '\u{1F3A8}',
	development:   '\u{1F4BB}',
	analytics:     '\u{1F50D}',
	security:      '\u{1F512}',
	education:     '\u{1F4DA}',
	health:        '\u{1F3E5}',
	productivity:  '\u{1F4DD}',
	social:        '\u{1F310}',
	marketing:     '\u{1F4E2}',
};

let state = {
	skills: [],
	categories: [],
	query: '',
	category: null,
	sort: 'popular',
	cursor: null,
	hasMore: false,
	loading: false,
	detailSkill: null,
	detailLoading: false,
	user: null,
};

let els = {};

(async function boot() {
	injectShell();
	injectStyles();
	cacheEls();
	bindEvents();
	await Promise.all([loadUser(), loadCategories(), loadSkills()]);
})();

function esc(s) {
	return String(s ?? '').replace(/[&<>"']/g, c =>
		({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function relTime(iso) {
	const ms = Date.now() - new Date(iso).getTime();
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s ago`;
	const m = Math.round(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.round(m / 60);
	if (h < 48) return `${h}h ago`;
	const d = Math.round(h / 24);
	if (d < 30) return `${d}d ago`;
	return new Date(iso).toLocaleDateString();
}

async function api(path) {
	const res = await fetch(path, { credentials: 'include' });
	if (!res.ok) {
		const body = await res.json().catch(() => ({}));
		throw Object.assign(new Error(body.message || res.statusText), { status: res.status });
	}
	return res.json();
}

async function loadUser() {
	try {
		const data = await api('/api/auth/me');
		state.user = data?.user ?? null;
	} catch {
		state.user = null;
	}
}

// ── Shell ─────────────────────────────────────────────────────────────────

function injectShell() {
	document.body.innerHTML = `
		<div class="sk-page">
			<header class="sk-header" id="sk-header"></header>
			<div class="sk-layout">
				<aside class="sk-sidebar" id="sk-sidebar">
					<div class="sk-sidebar-inner"></div>
				</aside>
				<main class="sk-main" id="sk-main">
					<div class="sk-toolbar" id="sk-toolbar"></div>
					<div class="sk-grid" id="sk-grid" role="list" aria-label="Skills"></div>
					<div class="sk-load-more" id="sk-load-more"></div>
				</main>
			</div>
			<div class="sk-drawer-backdrop" id="sk-backdrop" hidden></div>
			<aside class="sk-drawer" id="sk-drawer" hidden aria-label="Skill detail">
				<div class="sk-drawer-inner" id="sk-drawer-inner"></div>
			</aside>
		</div>
	`;
	loadNav();
}

async function loadNav() {
	try {
		const res = await fetch('/nav.html');
		if (!res.ok) return;
		const html = await res.text();
		const header = document.getElementById('sk-header');
		header.innerHTML = html;
		const script = document.createElement('script');
		script.src = '/nav.js';
		script.defer = true;
		document.head.appendChild(script);
	} catch { /* nav is optional */ }
}

function cacheEls() {
	els = {
		sidebar: document.querySelector('#sk-sidebar .sk-sidebar-inner'),
		toolbar: document.getElementById('sk-toolbar'),
		grid: document.getElementById('sk-grid'),
		loadMore: document.getElementById('sk-load-more'),
		drawer: document.getElementById('sk-drawer'),
		drawerInner: document.getElementById('sk-drawer-inner'),
		backdrop: document.getElementById('sk-backdrop'),
	};
}

// ── Categories ────────────────────────────────────────────────────────────

async function loadCategories() {
	try {
		const data = await api('/api/skills/categories');
		state.categories = data?.categories ?? [];
	} catch {
		state.categories = [];
	}
	renderSidebar();
}

function renderSidebar() {
	const total = state.categories.reduce((s, c) => s + c.count, 0);
	const cats = state.categories;

	els.sidebar.innerHTML = `
		<div class="sk-sb-section">
			<div class="sk-sb-title">Categories</div>
			<button class="sk-sb-cat${state.category === null ? ' is-active' : ''}" data-cat="">
				<span class="sk-sb-cat-icon" aria-hidden="true">*</span>
				<span class="sk-sb-cat-label">All skills</span>
				<span class="sk-sb-cat-count">${total}</span>
			</button>
			${cats.map(c => `
				<button class="sk-sb-cat${state.category === c.slug ? ' is-active' : ''}" data-cat="${esc(c.slug)}">
					<span class="sk-sb-cat-icon" aria-hidden="true">${CATEGORY_ICONS[c.slug] || '\u{1F4E6}'}</span>
					<span class="sk-sb-cat-label">${esc(c.label)}</span>
					<span class="sk-sb-cat-count">${c.count}</span>
				</button>
			`).join('')}
		</div>
		<div class="sk-sb-section sk-sb-cta">
			<a href="/dashboard/monetize" class="sk-btn sk-btn-primary sk-btn-block">Publish a Skill</a>
		</div>
	`;
}

// ── Toolbar ───────────────────────────────────────────────────────────────

function renderToolbar() {
	const catLabel = state.category
		? (state.categories.find(c => c.slug === state.category)?.label ?? state.category)
		: 'All skills';

	els.toolbar.innerHTML = `
		<div class="sk-toolbar-left">
			<h1 class="sk-page-title">Skills</h1>
			<span class="sk-toolbar-cat">${esc(catLabel)}</span>
		</div>
		<div class="sk-toolbar-right">
			<div class="sk-search-wrap" role="search">
				<svg class="sk-search-icon" viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="7" cy="7" r="4.5"/><path d="M13 13l-3-3"/></svg>
				<input type="text" class="sk-search" id="sk-search" placeholder="Search skills..." value="${esc(state.query)}" autocomplete="off" spellcheck="false" aria-label="Search skills" />
				<kbd class="sk-search-kbd" aria-hidden="true">/</kbd>
			</div>
			<div class="sk-sort" role="group" aria-label="Sort">
				${SORT_OPTIONS.map(s => `
					<button class="sk-sort-btn${state.sort === s.key ? ' is-active' : ''}" data-sort="${s.key}">${s.label}</button>
				`).join('')}
			</div>
		</div>
	`;
}

// ── Grid ──────────────────────────────────────────────────────────────────

async function loadSkills(append = false) {
	if (state.loading) return;
	state.loading = true;

	if (!append) {
		state.cursor = null;
		state.skills = [];
		renderSkeletons();
	}
	renderToolbar();
	renderLoadMore();

	const params = new URLSearchParams();
	params.set('limit', PAGE_SIZE);
	params.set('sort', state.sort);
	if (state.query) params.set('q', state.query);
	if (state.category) params.set('category', state.category);
	if (state.cursor) params.set('cursor', state.cursor);

	try {
		const data = await api(`/api/skills?${params}`);
		const skills = data?.skills ?? [];
		state.hasMore = !!data?.next_cursor;
		state.cursor = data?.next_cursor ?? null;

		if (append) {
			state.skills.push(...skills);
		} else {
			state.skills = skills;
		}
	} catch (err) {
		if (!append) state.skills = [];
		state.hasMore = false;
		console.error('[skills] load failed:', err);
	}

	state.loading = false;
	renderGrid();
	renderLoadMore();
}

function renderSkeletons() {
	els.grid.innerHTML = Array.from({ length: 8 }, () => `
		<div class="sk-card sk-card-skeleton" aria-hidden="true">
			<div class="sk-card-head">
				<div class="sk-skel sk-skel-icon"></div>
				<div style="flex:1">
					<div class="sk-skel" style="height:14px;width:60%;margin-bottom:6px"></div>
					<div class="sk-skel" style="height:11px;width:40%"></div>
				</div>
			</div>
			<div class="sk-skel" style="height:12px;width:90%;margin:8px 0"></div>
			<div class="sk-skel" style="height:12px;width:70%"></div>
			<div class="sk-card-foot">
				<div class="sk-skel" style="height:11px;width:50px"></div>
				<div class="sk-skel" style="height:11px;width:50px"></div>
			</div>
		</div>
	`).join('');
}

function renderGrid() {
	if (!state.skills.length && !state.loading) {
		els.grid.innerHTML = renderEmpty();
		return;
	}
	els.grid.innerHTML = state.skills.map(renderCard).join('');
}

function renderEmpty() {
	if (state.query || state.category) {
		return `
			<div class="sk-empty">
				<div class="sk-empty-icon">
					<svg viewBox="0 0 48 48" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="20" cy="20" r="14"/><path d="M30 30l10 10"/><path d="M15 20h10" opacity="0.4"/></svg>
				</div>
				<h3 class="sk-empty-title">No skills found</h3>
				<p class="sk-empty-sub">Try a different search term or category.</p>
				<button class="sk-btn" onclick="document.getElementById('sk-search').value='';document.getElementById('sk-search').dispatchEvent(new Event('input'))">Clear search</button>
			</div>
		`;
	}
	return `
		<div class="sk-empty">
			<div class="sk-empty-icon">
				<svg viewBox="0 0 48 48" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="6" y="8" width="36" height="32" rx="4"/><path d="M6 18h36"/><path d="M18 28h12"/><path d="M21 33h6"/></svg>
			</div>
			<h3 class="sk-empty-title">No skills yet</h3>
			<p class="sk-empty-sub">Be the first to publish a skill that other agents can use.</p>
			<a href="/dashboard/monetize" class="sk-btn sk-btn-primary">Publish a Skill</a>
		</div>
	`;
}

function renderCard(skill) {
	const icon = CATEGORY_ICONS[skill.category] || '\u{1F4E6}';
	const stars = renderStars(skill.avg_rating);
	const price = skill.price_per_call_usd > 0
		? `<span class="sk-card-price">$${skill.price_per_call_usd.toFixed(skill.price_per_call_usd < 0.01 ? 4 : 2)}/call</span>`
		: '<span class="sk-card-free">Free</span>';

	return `
		<article class="sk-card" role="listitem" data-id="${esc(skill.id)}" tabindex="0" aria-label="${esc(skill.name)}">
			<div class="sk-card-head">
				<span class="sk-card-icon" aria-hidden="true">${icon}</span>
				<div class="sk-card-meta">
					<h3 class="sk-card-name">${esc(skill.name)}</h3>
					<span class="sk-card-author">${skill.author ? esc(skill.author.display_name) : 'Anonymous'}</span>
				</div>
				${price}
			</div>
			<p class="sk-card-desc">${esc(skill.description)}</p>
			${skill.tags?.length ? `<div class="sk-card-tags">${skill.tags.slice(0, 4).map(t => `<span class="sk-tag">${esc(t)}</span>`).join('')}</div>` : ''}
			<div class="sk-card-foot">
				<span class="sk-card-stat" title="Installs">
					<svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M7 2v8M4 7l3 3 3-3"/><path d="M2 11h10"/></svg>
					${(skill.install_count || 0).toLocaleString()}
				</span>
				<span class="sk-card-stat" title="Rating">${stars} <span class="sk-card-rating-num">${skill.avg_rating > 0 ? skill.avg_rating.toFixed(1) : ''}</span></span>
				<span class="sk-card-cat">${esc(skill.category)}</span>
			</div>
		</article>
	`;
}

function renderStars(rating) {
	const full = Math.floor(rating);
	const half = rating - full >= 0.3;
	const empty = 5 - full - (half ? 1 : 0);
	let out = '';
	for (let i = 0; i < full; i++) out += '<svg class="sk-star sk-star-full" viewBox="0 0 12 12" width="12" height="12"><path d="M6 1l1.5 3 3.3.5-2.4 2.3.6 3.3L6 8.3 3 10.1l.6-3.3L1.2 4.5l3.3-.5z" fill="currentColor"/></svg>';
	if (half) out += '<svg class="sk-star sk-star-half" viewBox="0 0 12 12" width="12" height="12"><path d="M6 1l1.5 3 3.3.5-2.4 2.3.6 3.3L6 8.3 3 10.1l.6-3.3L1.2 4.5l3.3-.5z" fill="currentColor" opacity="0.3"/><path d="M6 1v7.3L3 10.1l.6-3.3L1.2 4.5l3.3-.5z" fill="currentColor"/></svg>';
	for (let i = 0; i < empty; i++) out += '<svg class="sk-star" viewBox="0 0 12 12" width="12" height="12"><path d="M6 1l1.5 3 3.3.5-2.4 2.3.6 3.3L6 8.3 3 10.1l.6-3.3L1.2 4.5l3.3-.5z" fill="currentColor" opacity="0.15"/></svg>';
	return out;
}

function renderLoadMore() {
	if (state.loading) {
		els.loadMore.innerHTML = '<div class="sk-spinner" aria-label="Loading"></div>';
		return;
	}
	if (state.hasMore) {
		els.loadMore.innerHTML = '<button class="sk-btn" id="sk-more-btn">Load more</button>';
	} else if (state.skills.length > 0) {
		els.loadMore.innerHTML = `<p class="sk-load-end">${state.skills.length} skill${state.skills.length !== 1 ? 's' : ''}</p>`;
	} else {
		els.loadMore.innerHTML = '';
	}
}

// ── Detail drawer ─────────────────────────────────────────────────────────

async function openDetail(id) {
	state.detailLoading = true;
	els.drawer.hidden = false;
	els.backdrop.hidden = false;
	document.body.classList.add('sk-drawer-open');
	renderDetailSkeleton();

	try {
		const data = await api(`/api/skills/${encodeURIComponent(id)}`);
		state.detailSkill = data?.skill ?? null;
	} catch {
		state.detailSkill = null;
	}
	state.detailLoading = false;
	renderDetail();
}

function closeDetail() {
	els.drawer.hidden = true;
	els.backdrop.hidden = true;
	document.body.classList.remove('sk-drawer-open');
	state.detailSkill = null;
}

function renderDetailSkeleton() {
	els.drawerInner.innerHTML = `
		<div class="sk-detail-head">
			<div class="sk-skel" style="height:18px;width:60%;margin-bottom:8px"></div>
			<div class="sk-skel" style="height:13px;width:40%"></div>
		</div>
		<div style="padding:20px">
			<div class="sk-skel" style="height:13px;width:100%;margin-bottom:8px"></div>
			<div class="sk-skel" style="height:13px;width:85%;margin-bottom:8px"></div>
			<div class="sk-skel" style="height:13px;width:70%;margin-bottom:20px"></div>
			<div class="sk-skel" style="height:38px;width:100%;border-radius:8px"></div>
		</div>
	`;
}

function renderDetail() {
	const s = state.detailSkill;
	if (!s) {
		els.drawerInner.innerHTML = `
			<div class="sk-detail-head">
				<button class="sk-detail-close" aria-label="Close" data-action="close-detail">&times;</button>
				<h2>Skill not found</h2>
			</div>
			<div style="padding:20px;color:rgba(255,255,255,0.5)">This skill may have been removed.</div>
		`;
		return;
	}

	const icon = CATEGORY_ICONS[s.category] || '\u{1F4E6}';
	const stars = renderStars(s.avg_rating);
	const price = s.price_per_call_usd > 0
		? `$${s.price_per_call_usd.toFixed(s.price_per_call_usd < 0.01 ? 4 : 2)} per call`
		: 'Free';

	const schemaHtml = s.schema_json?.length
		? `<div class="sk-detail-section">
				<h3 class="sk-detail-section-title">Tool Schema</h3>
				<div class="sk-detail-schema">
					${s.schema_json.map(tool => `
						<div class="sk-schema-tool">
							<div class="sk-schema-name">${esc(tool.function?.name ?? 'unknown')}</div>
							${tool.function?.parameters ? `<pre class="sk-schema-params">${esc(JSON.stringify(tool.function.parameters, null, 2))}</pre>` : ''}
						</div>
					`).join('')}
				</div>
			</div>`
		: '';

	const contentHtml = s.content
		? `<div class="sk-detail-section">
				<h3 class="sk-detail-section-title">Content</h3>
				<div class="sk-detail-content">${esc(s.content).replace(/\n/g, '<br>')}</div>
			</div>`
		: '';

	els.drawerInner.innerHTML = `
		<div class="sk-detail-head">
			<button class="sk-detail-close" aria-label="Close" data-action="close-detail">
				<svg viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 2l10 10M12 2L2 12"/></svg>
			</button>
			<div class="sk-detail-icon">${icon}</div>
			<h2 class="sk-detail-name">${esc(s.name)}</h2>
			<div class="sk-detail-author">by ${s.author ? esc(s.author.display_name) : 'Anonymous'}</div>
		</div>
		<div class="sk-detail-body">
			<div class="sk-detail-stats">
				<div class="sk-detail-stat">
					<div class="sk-detail-stat-val">${(s.install_count || 0).toLocaleString()}</div>
					<div class="sk-detail-stat-label">Installs</div>
				</div>
				<div class="sk-detail-stat">
					<div class="sk-detail-stat-val">${stars} ${s.avg_rating > 0 ? s.avg_rating.toFixed(1) : '—'}</div>
					<div class="sk-detail-stat-label">${s.rating_count || 0} rating${s.rating_count !== 1 ? 's' : ''}</div>
				</div>
				<div class="sk-detail-stat">
					<div class="sk-detail-stat-val">${price}</div>
					<div class="sk-detail-stat-label">Pricing</div>
				</div>
			</div>

			<p class="sk-detail-desc">${esc(s.description)}</p>

			${s.tags?.length ? `<div class="sk-detail-tags">${s.tags.map(t => `<span class="sk-tag">${esc(t)}</span>`).join('')}</div>` : ''}

			<div class="sk-detail-actions">
				${s.installed
					? '<button class="sk-btn sk-btn-installed" disabled>Installed</button>'
					: '<button class="sk-btn sk-btn-primary sk-btn-lg" data-action="install">Install Skill</button>'
				}
				<button class="sk-btn sk-btn-outline" data-action="try-skill">Try It</button>
			</div>

			${schemaHtml}
			${contentHtml}

			<div class="sk-detail-section sk-detail-meta">
				<div class="sk-detail-meta-row"><span>Category</span><span>${esc(s.category)}</span></div>
				<div class="sk-detail-meta-row"><span>Slug</span><code>${esc(s.slug)}</code></div>
				<div class="sk-detail-meta-row"><span>Added</span><time datetime="${esc(s.created_at)}">${relTime(s.created_at)}</time></div>
			</div>
		</div>
	`;
}

// ── Events ────────────────────────────────────────────────────────────────

function bindEvents() {
	let searchTimer = null;

	document.addEventListener('input', (e) => {
		if (e.target.id === 'sk-search') {
			clearTimeout(searchTimer);
			searchTimer = setTimeout(() => {
				state.query = e.target.value.trim();
				loadSkills();
			}, DEBOUNCE_MS);
		}
	});

	document.addEventListener('click', (e) => {
		const catBtn = e.target.closest('[data-cat]');
		if (catBtn) {
			state.category = catBtn.dataset.cat || null;
			renderSidebar();
			loadSkills();
			return;
		}

		const sortBtn = e.target.closest('[data-sort]');
		if (sortBtn) {
			state.sort = sortBtn.dataset.sort;
			loadSkills();
			return;
		}

		if (e.target.id === 'sk-more-btn') {
			loadSkills(true);
			return;
		}

		const card = e.target.closest('.sk-card[data-id]');
		if (card) {
			openDetail(card.dataset.id);
			return;
		}

		if (e.target.closest('[data-action="close-detail"]') || e.target.id === 'sk-backdrop') {
			closeDetail();
			return;
		}

		if (e.target.closest('[data-action="try-skill"]') && state.detailSkill) {
			window.location.href = `/brain?skill=${encodeURIComponent(state.detailSkill.slug)}`;
			return;
		}
	});

	document.addEventListener('keydown', (e) => {
		if (e.key === '/' && !e.ctrlKey && !e.metaKey && document.activeElement?.tagName !== 'INPUT') {
			e.preventDefault();
			document.getElementById('sk-search')?.focus();
		}
		if (e.key === 'Escape' && !els.drawer.hidden) {
			closeDetail();
		}
	});

	document.addEventListener('keydown', (e) => {
		if (e.key === 'Enter' && e.target.closest('.sk-card[data-id]')) {
			openDetail(e.target.closest('.sk-card').dataset.id);
		}
	});
}

// ── Styles ────────────────────────────────────────────────────────────────

function injectStyles() {
	const style = document.createElement('style');
	style.textContent = `
:root {
	--sk-bg: #0c0d10;
	--sk-bg-1: #131419;
	--sk-bg-2: #1a1b22;
	--sk-bg-3: #22232c;
	--sk-ink: #e4e5ea;
	--sk-ink-dim: #8b8d98;
	--sk-ink-faint: #5a5c68;
	--sk-accent: #6c8aff;
	--sk-accent-dim: rgba(108,138,255,0.12);
	--sk-green: #34d399;
	--sk-border: rgba(255,255,255,0.07);
	--sk-radius: 10px;
	--sk-radius-lg: 14px;
	--sk-sidebar-w: 260px;
	--sk-drawer-w: 440px;
	--sk-header-h: 56px;
}
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: var(--sk-bg); color: var(--sk-ink); font: 14px/1.5 'Inter', system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
a { color: inherit; text-decoration: none; }

.sk-page { display: flex; flex-direction: column; min-height: 100vh; }
.sk-header { position: sticky; top: 0; z-index: 100; background: rgba(12,13,16,0.85); backdrop-filter: blur(12px); border-bottom: 1px solid var(--sk-border); }
.sk-layout { display: grid; grid-template-columns: var(--sk-sidebar-w) 1fr; flex: 1; }
.sk-sidebar { position: sticky; top: var(--sk-header-h); height: calc(100vh - var(--sk-header-h)); overflow-y: auto; border-right: 1px solid var(--sk-border); padding: 20px 0; }
.sk-sidebar-inner { padding: 0 16px; }
.sk-main { padding: 24px 32px; min-width: 0; }

/* Sidebar */
.sk-sb-section { margin-bottom: 24px; }
.sk-sb-title { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--sk-ink-dim); padding: 0 10px; margin-bottom: 8px; }
.sk-sb-cat { display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 10px; border: none; background: none; color: var(--sk-ink-dim); font: inherit; font-size: 13px; border-radius: 7px; cursor: pointer; transition: background 0.15s, color 0.15s; }
.sk-sb-cat:hover { background: var(--sk-bg-2); color: var(--sk-ink); }
.sk-sb-cat.is-active { background: var(--sk-accent-dim); color: var(--sk-accent); font-weight: 500; }
.sk-sb-cat-icon { width: 18px; text-align: center; font-size: 14px; flex-shrink: 0; }
.sk-sb-cat-label { flex: 1; text-align: left; }
.sk-sb-cat-count { font-size: 11px; color: var(--sk-ink-faint); min-width: 20px; text-align: right; }
.sk-sb-cta { padding: 0 4px; }

/* Toolbar */
.sk-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 20px; flex-wrap: wrap; }
.sk-toolbar-left { display: flex; align-items: baseline; gap: 12px; }
.sk-page-title { font-size: 24px; font-weight: 700; margin: 0; letter-spacing: -0.02em; }
.sk-toolbar-cat { font-size: 13px; color: var(--sk-ink-dim); }
.sk-toolbar-right { display: flex; align-items: center; gap: 12px; }

/* Search */
.sk-search-wrap { position: relative; }
.sk-search-icon { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: var(--sk-ink-faint); pointer-events: none; }
.sk-search { width: 260px; padding: 8px 36px 8px 34px; border: 1px solid var(--sk-border); border-radius: 8px; background: var(--sk-bg-1); color: var(--sk-ink); font: inherit; font-size: 13px; outline: none; transition: border-color 0.15s, box-shadow 0.15s; }
.sk-search:focus { border-color: var(--sk-accent); box-shadow: 0 0 0 3px var(--sk-accent-dim); }
.sk-search::placeholder { color: var(--sk-ink-faint); }
.sk-search-kbd { position: absolute; right: 8px; top: 50%; transform: translateY(-50%); font-size: 11px; padding: 1px 5px; border: 1px solid var(--sk-border); border-radius: 4px; color: var(--sk-ink-faint); pointer-events: none; }
.sk-search:focus ~ .sk-search-kbd { display: none; }

/* Sort */
.sk-sort { display: flex; border: 1px solid var(--sk-border); border-radius: 8px; overflow: hidden; }
.sk-sort-btn { padding: 7px 14px; border: none; background: none; color: var(--sk-ink-dim); font: inherit; font-size: 12px; font-weight: 500; cursor: pointer; transition: background 0.12s, color 0.12s; }
.sk-sort-btn:not(:last-child) { border-right: 1px solid var(--sk-border); }
.sk-sort-btn:hover { background: var(--sk-bg-2); color: var(--sk-ink); }
.sk-sort-btn.is-active { background: var(--sk-accent-dim); color: var(--sk-accent); }

/* Grid */
.sk-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(290px, 1fr)); gap: 14px; }
.sk-card { background: var(--sk-bg-1); border: 1px solid var(--sk-border); border-radius: var(--sk-radius); padding: 18px; cursor: pointer; transition: transform 0.15s ease, border-color 0.15s, box-shadow 0.15s; outline: none; }
.sk-card:hover, .sk-card:focus-visible { transform: translateY(-2px); border-color: rgba(108,138,255,0.25); box-shadow: 0 4px 20px rgba(0,0,0,0.25); }
.sk-card:focus-visible { box-shadow: 0 0 0 3px var(--sk-accent-dim), 0 4px 20px rgba(0,0,0,0.25); }

.sk-card-head { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 10px; }
.sk-card-icon { font-size: 28px; line-height: 1; flex-shrink: 0; width: 40px; height: 40px; display: flex; align-items: center; justify-content: center; background: var(--sk-bg-3); border-radius: 10px; }
.sk-card-meta { flex: 1; min-width: 0; }
.sk-card-name { font-size: 15px; font-weight: 600; margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sk-card-author { font-size: 12px; color: var(--sk-ink-dim); }
.sk-card-price { font-size: 12px; font-weight: 600; color: var(--sk-accent); background: var(--sk-accent-dim); padding: 3px 8px; border-radius: 6px; white-space: nowrap; flex-shrink: 0; }
.sk-card-free { font-size: 12px; font-weight: 500; color: var(--sk-green); background: rgba(52,211,153,0.1); padding: 3px 8px; border-radius: 6px; white-space: nowrap; flex-shrink: 0; }

.sk-card-desc { font-size: 13px; color: var(--sk-ink-dim); margin: 0 0 10px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; line-height: 1.5; }
.sk-card-tags { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 10px; }
.sk-tag { font-size: 11px; padding: 2px 7px; border-radius: 5px; background: var(--sk-bg-3); color: var(--sk-ink-dim); }

.sk-card-foot { display: flex; align-items: center; gap: 14px; font-size: 12px; color: var(--sk-ink-faint); }
.sk-card-stat { display: flex; align-items: center; gap: 4px; }
.sk-card-stat svg { opacity: 0.6; }
.sk-card-cat { margin-left: auto; text-transform: capitalize; }
.sk-card-rating-num { font-size: 11px; }

.sk-star { color: #fbbf24; }
.sk-star-full { color: #fbbf24; }
.sk-star-half { color: #fbbf24; }

/* Skeleton */
.sk-card-skeleton { pointer-events: none; }
.sk-skel { background: linear-gradient(90deg, var(--sk-bg-2) 30%, var(--sk-bg-3) 50%, var(--sk-bg-2) 70%); background-size: 200% 100%; border-radius: 6px; animation: sk-shimmer 1.5s ease-in-out infinite; }
.sk-skel-icon { width: 40px; height: 40px; border-radius: 10px; flex-shrink: 0; }
@keyframes sk-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }

/* Spinner */
.sk-spinner { width: 28px; height: 28px; border: 2.5px solid var(--sk-border); border-top-color: var(--sk-accent); border-radius: 50%; animation: sk-spin 0.7s linear infinite; margin: 24px auto; }
@keyframes sk-spin { to { transform: rotate(360deg); } }

/* Load more */
.sk-load-more { text-align: center; padding: 24px 0; }
.sk-load-end { color: var(--sk-ink-faint); font-size: 13px; margin: 0; }

/* Empty */
.sk-empty { grid-column: 1 / -1; text-align: center; padding: 60px 20px; }
.sk-empty-icon { color: var(--sk-ink-faint); margin-bottom: 16px; }
.sk-empty-title { font-size: 18px; font-weight: 600; margin: 0 0 6px; }
.sk-empty-sub { color: var(--sk-ink-dim); margin: 0 0 16px; }

/* Buttons */
.sk-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 8px 18px; border: 1px solid var(--sk-border); border-radius: 8px; background: var(--sk-bg-2); color: var(--sk-ink); font: inherit; font-size: 13px; font-weight: 500; cursor: pointer; transition: background 0.12s, border-color 0.12s; }
.sk-btn:hover { background: var(--sk-bg-3); border-color: rgba(255,255,255,0.12); }
.sk-btn-primary { background: var(--sk-accent); color: #fff; border-color: var(--sk-accent); }
.sk-btn-primary:hover { background: #5a7aef; border-color: #5a7aef; }
.sk-btn-outline { background: transparent; border-color: var(--sk-border); }
.sk-btn-outline:hover { background: var(--sk-bg-2); }
.sk-btn-installed { background: rgba(52,211,153,0.1); color: var(--sk-green); border-color: rgba(52,211,153,0.2); cursor: default; }
.sk-btn-lg { padding: 11px 28px; font-size: 14px; }
.sk-btn-block { display: flex; width: 100%; }

/* Drawer */
.sk-drawer-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 200; transition: opacity 0.2s; }
.sk-drawer { position: fixed; top: 0; right: 0; bottom: 0; width: var(--sk-drawer-w); max-width: 100vw; z-index: 201; background: var(--sk-bg-1); border-left: 1px solid var(--sk-border); overflow-y: auto; transform: translateX(0); transition: transform 0.25s ease; }
.sk-drawer[hidden] { display: block; transform: translateX(100%); pointer-events: none; opacity: 0; }
body.sk-drawer-open { overflow: hidden; }

.sk-detail-head { position: relative; padding: 28px 24px 20px; border-bottom: 1px solid var(--sk-border); }
.sk-detail-close { position: absolute; top: 16px; right: 16px; width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; border: none; background: var(--sk-bg-3); color: var(--sk-ink-dim); border-radius: 8px; cursor: pointer; transition: background 0.12s; }
.sk-detail-close:hover { background: var(--sk-bg-2); color: var(--sk-ink); }
.sk-detail-icon { font-size: 36px; margin-bottom: 10px; }
.sk-detail-name { font-size: 20px; font-weight: 700; margin: 0 0 4px; }
.sk-detail-author { font-size: 13px; color: var(--sk-ink-dim); }
.sk-detail-body { padding: 20px 24px 40px; }

.sk-detail-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 20px; }
.sk-detail-stat { text-align: center; padding: 14px 8px; background: var(--sk-bg-2); border-radius: 10px; }
.sk-detail-stat-val { font-size: 16px; font-weight: 600; margin-bottom: 2px; display: flex; align-items: center; justify-content: center; gap: 4px; }
.sk-detail-stat-label { font-size: 11px; color: var(--sk-ink-dim); }

.sk-detail-desc { font-size: 14px; line-height: 1.6; color: var(--sk-ink); margin: 0 0 14px; }
.sk-detail-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 20px; }
.sk-detail-actions { display: flex; gap: 10px; margin-bottom: 24px; }

.sk-detail-section { margin-bottom: 24px; }
.sk-detail-section-title { font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--sk-ink-dim); margin: 0 0 10px; }
.sk-detail-schema { background: var(--sk-bg-2); border-radius: 8px; padding: 14px; }
.sk-schema-tool { margin-bottom: 10px; }
.sk-schema-tool:last-child { margin-bottom: 0; }
.sk-schema-name { font-size: 13px; font-weight: 600; color: var(--sk-accent); margin-bottom: 6px; font-family: 'SF Mono', 'Fira Code', monospace; }
.sk-schema-params { font-size: 12px; line-height: 1.5; color: var(--sk-ink-dim); margin: 0; overflow-x: auto; white-space: pre-wrap; word-break: break-word; }
.sk-detail-content { font-size: 13px; line-height: 1.6; color: var(--sk-ink-dim); max-height: 300px; overflow-y: auto; padding: 14px; background: var(--sk-bg-2); border-radius: 8px; }
.sk-detail-meta { border-top: 1px solid var(--sk-border); padding-top: 16px; }
.sk-detail-meta-row { display: flex; justify-content: space-between; padding: 6px 0; font-size: 13px; }
.sk-detail-meta-row > span:first-child { color: var(--sk-ink-dim); }
.sk-detail-meta-row code { font-size: 12px; color: var(--sk-accent); }

/* Responsive */
@media (max-width: 900px) {
	.sk-layout { grid-template-columns: 1fr; }
	.sk-sidebar { display: none; }
	.sk-main { padding: 20px 16px; }
	.sk-toolbar { flex-direction: column; align-items: stretch; }
	.sk-toolbar-right { flex-wrap: wrap; }
	.sk-search { width: 100%; }
	.sk-grid { grid-template-columns: 1fr; }
	.sk-drawer { width: 100vw; }
}
@media (max-width: 600px) {
	.sk-page-title { font-size: 20px; }
	.sk-detail-stats { grid-template-columns: 1fr; }
}
`;
	document.head.appendChild(style);
}
