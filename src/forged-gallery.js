// /forged: the agent-forged gallery: 3D props the platform's autonomous agents
// BOUGHT with real on-chain USDC via x402, with the receipts to prove it.
//
// Feed: GET /api/forged (forge_autonomous_props). Every card renders a live
// <model-viewer> off the GLB's CDN url plus its payment provenance:
//   price paid → the USDC amount the agent settled for this generation
//   payer      → the agent wallet (short form)
//   receipt    → the Solana settlement signature, linked to Solscan
//
// The feed is honest by design: no synthetic entries, so before the first paid
// generation completes the page shows the designed empty state instead.

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

const state = { all: [], stats: null, query: '', sort: 'newest', category: '' };

function escapeHtml(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) =>
		({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const escapeAttr = escapeHtml;
function show(el, on) { if (el) el.hidden = !on; }

function formatUsdc(n) {
	if (n == null) return '';
	return n < 0.01 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`;
}

function formatWhen(ts) {
	const d = new Date(ts);
	if (Number.isNaN(d.getTime())) return '';
	const mins = Math.round((Date.now() - d.getTime()) / 60000);
	if (mins < 60) return `${Math.max(1, mins)}m ago`;
	if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
	return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function renderCard(p) {
	const glbUrl = p.glb_url || '';
	const alt = p.prompt || 'Agent-forged prop';
	const previewUrl = glbUrl
		? `/app#model=${encodeURIComponent(glbUrl)}&kind=object&title=${encodeURIComponent(alt)}`
		: '#';

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
			></model-viewer>
			<span class="ch-card-pill">${escapeHtml(p.category || 'prop')}</span>
			<span class="ch-card-play" aria-hidden="true">▶</span>
		</a>
		<div class="ch-card-body">
			<h3 class="ch-card-name" title="${escapeAttr(alt)}">${escapeHtml(alt)}</h3>
			<div class="ch-card-meta">
				<span>${escapeHtml(formatWhen(p.ts))}${p.novelty != null ? ` · novelty ${Number(p.novelty).toFixed(2)}` : ''}</span>
			</div>
			<div class="fg-receipt" title="This asset was bought by an autonomous agent with real USDC on Solana">
				<span class="fg-receipt-amount">${escapeHtml(formatUsdc(p.price_usdc))} USDC</span>
				<span class="fg-receipt-payer">${escapeHtml(p.payer_short || 'agent wallet')}</span>
				${p.explorer_url ? `<a class="fg-receipt-tx" href="${escapeAttr(p.explorer_url)}" target="_blank" rel="noopener noreferrer" title="View the settlement transaction on Solscan">receipt ↗</a>` : ''}
			</div>
			<div class="ch-card-actions">
				<a class="ch-btn ch-btn--primary" href="${escapeAttr(previewUrl)}" title="Open in the 3D viewer">Preview</a>
				<a class="ch-btn ch-btn--ghost" href="${escapeAttr(glbUrl)}" download title="Download the GLB">Download</a>
			</div>
		</div>
	`;
	return card;
}

function categories() {
	const set = new Set();
	for (const p of state.all) if (p.category) set.add(p.category);
	return [...set].sort();
}

function renderChips() {
	if (!els.catChips) return;
	const cats = categories();
	if (!cats.length) { els.catChips.innerHTML = ''; return; }
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
	if (state.category) list = list.filter((p) => p.category === state.category);
	if (q) list = list.filter((p) => (p.prompt || '').toLowerCase().includes(q));

	list = list.slice().sort((a, b) => {
		if (state.sort === 'oldest') return new Date(a.ts) - new Date(b.ts);
		if (state.sort === 'priciest') return (b.price_usdc || 0) - (a.price_usdc || 0);
		if (state.sort === 'novel') return (b.novelty || 0) - (a.novelty || 0);
		return new Date(b.ts) - new Date(a.ts); // newest
	});

	if (state.all.length === 0) {
		show(els.loading, false); show(els.grid, false); show(els.emptySearch, false); show(els.error, false); show(els.empty, true);
		if (els.count) els.count.textContent = '';
		return;
	}
	if (list.length === 0) {
		show(els.loading, false); show(els.grid, false); show(els.empty, false); show(els.error, false); show(els.emptySearch, true);
		if (els.count) els.count.textContent = '0 props';
		return;
	}
	const frag = document.createDocumentFragment();
	for (const p of list) frag.appendChild(renderCard(p));
	els.grid.replaceChildren(frag);
	show(els.loading, false); show(els.empty, false); show(els.emptySearch, false); show(els.error, false); show(els.grid, true);
	if (els.count) els.count.textContent = `${list.length} of ${state.all.length}`;
}

async function load() {
	show(els.loading, true); show(els.grid, false); show(els.empty, false); show(els.emptySearch, false); show(els.error, false);
	try {
		const res = await fetch('/api/forged?limit=100');
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = await res.json();
		state.all = Array.isArray(data.props) ? data.props : [];
		state.stats = data.stats || null;
		if (els.heroStats && state.stats) {
			const s = state.stats;
			els.heroStats.textContent = s.done
				? `${s.done} props forged · ${formatUsdc(s.spent_usdc)} USDC settled on-chain${s.queued ? ` · ${s.queued} generating` : ''}`
				: '';
		}
		renderChips();
		applyView();
	} catch (err) {
		show(els.loading, false); show(els.grid, false); show(els.empty, false); show(els.emptySearch, false); show(els.error, true);
		if (els.errorMsg) els.errorMsg.textContent = `Failed to load the gallery: ${err?.message || 'network error'}`;
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
