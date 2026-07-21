// /objects — the CC0 3D object/prop library gallery.
//
// Browses the free, commercial-OK props served by GET /api/objects/library
// (manifest on R2, mirroring /character-library). Each card renders a live
// <model-viewer> off the GLB's CDN url and offers:
//   Preview  → /app#model=<glb>   (real three.js viewer)
//   Download → the GLB directly   (every object is CC0 — free to reuse)
//
// The library is a few hundred entries, so the whole manifest is fetched once
// and filtered/sorted client-side — instant search, no pagination round-trips.

const els = {
	grid: document.querySelector('[data-role="grid"]'),
	loading: document.querySelector('[data-role="loading"]'),
	empty: document.querySelector('[data-role="empty"]'),
	emptySearch: document.querySelector('[data-role="empty-search"]'),
	error: document.querySelector('[data-role="error"]'),
	errorMsg: document.querySelector('[data-role="error-msg"]'),
	search: document.querySelector('[data-role="search"]'),
	sort: document.querySelector('[data-role="sort"]'),
	count: document.querySelector('[data-role="count"]'),
	heroStats: document.querySelector('[data-role="hero-stats"]'),
	clearSearch: document.querySelector('[data-role="clear-search"]'),
	retry: document.querySelector('[data-role="retry"]'),
	catChips: document.querySelector('[data-role="chips"]'),
};

const state = { all: [], query: '', sort: 'az', category: '' };

function escapeHtml(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) =>
		({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const escapeAttr = escapeHtml;
function show(el, on) { if (el) el.hidden = !on; }
function formatBytes(n) {
	if (!n) return '';
	const mb = n / 1024 / 1024;
	return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
}

function renderCard(o) {
	const glbUrl = o.url || '';
	const previewUrl = glbUrl ? `/app#model=${encodeURIComponent(glbUrl)}` : '#';
	const thumb = o.thumb || '';
	const alt = o.label || o.name || 'Object';
	const cat = (o.categories && o.categories[0]) || '';

	const card = document.createElement('article');
	card.className = 'ch-card';
	card.innerHTML = `
		<a class="ch-card-thumb" href="${escapeAttr(previewUrl)}" aria-label="Preview ${escapeAttr(alt)} in 3D">
			<model-viewer
				src="${escapeAttr(glbUrl)}"
				alt="${escapeAttr(alt)}"
				class="ch-card-mv"
				reveal="auto" loading="lazy" disable-zoom disable-pan disable-tap
				interaction-prompt="none" camera-controls="false"
				auto-rotate rotation-per-second="20deg"
				environment-image="neutral" shadow-intensity="0.4" exposure="1"
				${thumb ? `poster="${escapeAttr(thumb)}"` : ''}
			></model-viewer>
			<span class="ch-card-pill">CC0</span>
			<span class="ch-card-play" aria-hidden="true">▶</span>
		</a>
		<div class="ch-card-body">
			<h3 class="ch-card-name">${escapeHtml(o.label || o.name)}</h3>
			<div class="ch-card-meta">
				<span>${escapeHtml(cat)}${cat ? ' · ' : ''}${escapeHtml(formatBytes(o.bytes))}</span>
			</div>
			<div class="ch-card-actions">
				<a class="ch-btn ch-btn--primary" href="${escapeAttr(previewUrl)}" title="Open in the 3D viewer">Preview</a>
				<a class="ch-btn ch-btn--ghost" href="${escapeAttr(glbUrl)}" download title="Download the GLB (CC0, free to reuse)">Download</a>
			</div>
		</div>
	`;
	return card;
}

function categories() {
	const set = new Set();
	for (const o of state.all) for (const c of o.categories || []) set.add(c);
	return [...set].sort();
}

function renderChips() {
	if (!els.catChips) return;
	const cats = categories();
	if (!cats.length) return;
	els.catChips.innerHTML =
		`<button class="ch-chip${state.category === '' ? ' is-active' : ''}" data-cat="">All</button>` +
		cats.map((c) => `<button class="ch-chip${state.category === c ? ' is-active' : ''}" data-cat="${escapeAttr(c)}">${escapeHtml(c)}</button>`).join('');
	els.catChips.querySelectorAll('.ch-chip').forEach((b) => b.addEventListener('click', () => {
		state.category = b.dataset.cat;
		renderChips();
		applyView();
	}));
}

function applyView() {
	const q = state.query.trim().toLowerCase();
	let list = state.all;
	if (state.category) list = list.filter((o) => (o.categories || []).includes(state.category));
	if (q) list = list.filter((o) => (o.label || o.name || '').toLowerCase().includes(q) ||
		(o.tags || []).some((t) => t.toLowerCase().includes(q)));

	list = list.slice().sort((a, b) => {
		const la = (a.label || a.name || '').toLowerCase(), lb = (b.label || b.name || '').toLowerCase();
		if (state.sort === 'za') return lb.localeCompare(la);
		if (state.sort === 'largest') return (b.bytes || 0) - (a.bytes || 0);
		if (state.sort === 'smallest') return (a.bytes || 0) - (b.bytes || 0);
		return la.localeCompare(lb);
	});

	if (state.all.length === 0) {
		show(els.loading, false); show(els.grid, false); show(els.emptySearch, false); show(els.error, false); show(els.empty, true);
		if (els.count) els.count.textContent = '';
		return;
	}
	if (list.length === 0) {
		show(els.loading, false); show(els.grid, false); show(els.empty, false); show(els.error, false); show(els.emptySearch, true);
		if (els.count) els.count.textContent = '0 objects';
		return;
	}
	const frag = document.createDocumentFragment();
	for (const o of list) frag.appendChild(renderCard(o));
	els.grid.replaceChildren(frag);
	show(els.loading, false); show(els.empty, false); show(els.emptySearch, false); show(els.error, false); show(els.grid, true);
	if (els.count) els.count.textContent = `${list.length} of ${state.all.length}`;
}

async function load() {
	show(els.loading, true); show(els.grid, false); show(els.empty, false); show(els.emptySearch, false); show(els.error, false);
	try {
		const res = await fetch('/api/objects/library');
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = await res.json();
		state.all = Array.isArray(data.objects) ? data.objects : [];
		if (els.heroStats) els.heroStats.textContent = state.all.length ? `${state.all.length} CC0 props · free to use` : '';
		renderChips();
		applyView();
	} catch (err) {
		show(els.loading, false); show(els.grid, false); show(els.empty, false); show(els.emptySearch, false); show(els.error, true);
		if (els.errorMsg) els.errorMsg.textContent = `Failed to load objects: ${err?.message || 'network error'}`;
	}
}

function wire() {
	let t;
	els.search?.addEventListener('input', (e) => {
		clearTimeout(t); const v = e.target.value;
		t = setTimeout(() => { state.query = v; applyView(); }, 120);
	});
	els.sort?.addEventListener('change', (e) => { state.sort = e.target.value; applyView(); });
	els.clearSearch?.addEventListener('click', () => { state.query = ''; state.category = ''; if (els.search) els.search.value = ''; renderChips(); applyView(); });
	els.retry?.addEventListener('click', load);
	document.addEventListener('keydown', (e) => {
		if (e.key === '/' && document.activeElement !== els.search) { e.preventDefault(); els.search?.focus(); }
	});
}

wire();
load();
