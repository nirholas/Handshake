// /character-library — the Mixamo character library gallery.
//
// Browses the 106 professionally rigged humanoid characters served by
// GET /api/avatars/library (manifest on R2, mirroring the /animations gallery).
// Each card renders a live <model-viewer> off the GLB's CDN url and deep-links
// into the three viewers that accept a raw model URL:
//   Preview → /app#model=<glb>      (real three.js viewer)
//   Use     → /studio?model=<glb>   (widget studio)
//   Animate → /pose?src=<glb>       (animation studio; r2.dev is a trusted host)
//
// The library is small (106 entries) so the whole manifest is fetched once and
// filtered/sorted client-side — no pagination round-trips, instant search.

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
};

const state = {
	all: [],
	query: '',
	sort: 'az',
};

function escapeHtml(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) =>
		({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
	);
}
function escapeAttr(s) {
	return escapeHtml(s);
}

function show(el, on) {
	if (el) el.hidden = !on;
}

function formatBytes(n) {
	if (!n) return '';
	const mb = n / 1024 / 1024;
	return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
}

function renderCard(a) {
	const glbUrl = a.url || '';
	const previewUrl = glbUrl ? `/app#model=${encodeURIComponent(glbUrl)}` : '#';
	const useUrl = glbUrl ? `/studio?model=${encodeURIComponent(glbUrl)}` : '#';
	const animateUrl = glbUrl ? `/pose?src=${encodeURIComponent(glbUrl)}&title=${encodeURIComponent(a.label || a.name)}` : '#';
	const thumb = a.thumb || '';
	const alt = a.label || a.name || 'Character';

	const card = document.createElement('article');
	card.className = 'ch-card';
	card.innerHTML = `
		<a class="ch-card-thumb" href="${escapeAttr(previewUrl)}" aria-label="Preview ${escapeAttr(alt)} in 3D">
			<model-viewer
				src="${escapeAttr(glbUrl)}"
				alt="${escapeAttr(alt)}"
				class="ch-card-mv"
				reveal="auto"
				loading="lazy"
				disable-zoom
				disable-pan
				disable-tap
				interaction-prompt="none"
				camera-controls="false"
				auto-rotate
				rotation-per-second="20deg"
				environment-image="neutral"
				shadow-intensity="0"
				exposure="1"
				${thumb ? `poster="${escapeAttr(thumb)}"` : ''}
			></model-viewer>
			<span class="ch-card-pill">Rigged</span>
			<span class="ch-card-play" aria-hidden="true">▶</span>
		</a>
		<div class="ch-card-body">
			<h3 class="ch-card-name">${escapeHtml(a.label || a.name)}</h3>
			<div class="ch-card-meta">
				<span title="Skinned mesh, ready to animate">Mixamo · ${escapeHtml(formatBytes(a.bytes))}</span>
			</div>
			<div class="ch-card-actions">
				<a class="ch-btn ch-btn--primary" href="${escapeAttr(useUrl)}" title="Use in Widget Studio">Use</a>
				<a class="ch-btn ch-btn--ghost" href="${escapeAttr(animateUrl)}" title="Animate in the Animation Studio">Animate</a>
				<a class="ch-btn ch-btn--ghost" href="${escapeAttr(previewUrl)}" title="Open in the 3D viewer">Preview</a>
			</div>
		</div>
	`;
	return card;
}

function applyView() {
	const q = state.query.trim().toLowerCase();
	let list = state.all;
	if (q) list = list.filter((a) => (a.label || a.name || '').toLowerCase().includes(q));

	list = list.slice().sort((a, b) => {
		const la = (a.label || a.name || '').toLowerCase();
		const lb = (b.label || b.name || '').toLowerCase();
		if (state.sort === 'za') return lb.localeCompare(la);
		if (state.sort === 'largest') return (b.bytes || 0) - (a.bytes || 0);
		if (state.sort === 'smallest') return (a.bytes || 0) - (b.bytes || 0);
		return la.localeCompare(lb); // 'az' default
	});

	// Nothing at all in the library (manifest empty / not uploaded yet).
	if (state.all.length === 0) {
		show(els.loading, false);
		show(els.grid, false);
		show(els.emptySearch, false);
		show(els.error, false);
		show(els.empty, true);
		if (els.count) els.count.textContent = '';
		return;
	}

	// A search that matches nothing.
	if (list.length === 0) {
		show(els.loading, false);
		show(els.grid, false);
		show(els.empty, false);
		show(els.error, false);
		show(els.emptySearch, true);
		if (els.count) els.count.textContent = '0 characters';
		return;
	}

	const frag = document.createDocumentFragment();
	for (const a of list) frag.appendChild(renderCard(a));
	els.grid.replaceChildren(frag);

	show(els.loading, false);
	show(els.empty, false);
	show(els.emptySearch, false);
	show(els.error, false);
	show(els.grid, true);
	if (els.count) els.count.textContent = `${list.length} of ${state.all.length}`;
}

async function load() {
	show(els.loading, true);
	show(els.grid, false);
	show(els.empty, false);
	show(els.emptySearch, false);
	show(els.error, false);

	try {
		const res = await fetch('/api/avatars/library');
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = await res.json();
		state.all = Array.isArray(data.avatars) ? data.avatars : [];
		if (els.heroStats) {
			els.heroStats.textContent = state.all.length
				? `${state.all.length} rigged characters · ready to animate`
				: '';
		}
		applyView();
	} catch (err) {
		show(els.loading, false);
		show(els.grid, false);
		show(els.empty, false);
		show(els.emptySearch, false);
		show(els.error, true);
		if (els.errorMsg) els.errorMsg.textContent = `Failed to load characters: ${err?.message || 'network error'}`;
	}
}

function wire() {
	let t;
	els.search?.addEventListener('input', (e) => {
		clearTimeout(t);
		const v = e.target.value;
		t = setTimeout(() => {
			state.query = v;
			applyView();
		}, 120);
	});
	els.sort?.addEventListener('change', (e) => {
		state.sort = e.target.value;
		applyView();
	});
	els.clearSearch?.addEventListener('click', () => {
		state.query = '';
		if (els.search) els.search.value = '';
		applyView();
	});
	els.retry?.addEventListener('click', load);

	// "/" focuses search, matching the /animations gallery affordance.
	document.addEventListener('keydown', (e) => {
		if (e.key === '/' && document.activeElement !== els.search) {
			e.preventDefault();
			els.search?.focus();
		}
	});
}

wire();
load();
