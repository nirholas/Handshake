// Widget gallery — native DOM, no framework.
// Each card:
//   - Preview / Code tabs in the frame area (shadcn-style inline switch)
//   - Customize panel: size preset, accent color, per-type fields (mint, kind)
//     wired through to /app via hash params; the iframe reloads as you tweak.
//   - Snippet block reflects current customizer state.
//   - Copy split-button with 3 formats: iframe, JSX, URL.
//   - "Open in Studio" template clone.
// Top of page: faceted filter chips (type), skeleton loader, fade-in.

const GRID_EL = document.getElementById('gallery-grid');
const ORIGIN = location.origin;

const TYPE_COLORS = {
	turntable: '#f59e0b',
	'animation-gallery': '#3b82f6',
	'talking-agent': '#10b981',
	passport: '#a78bfa',
	'hotspot-tour': '#f97316',
	'pumpfun-feed': '#ec4899',
	'kol-trades': '#22d3ee',
	'live-trades-canvas': '#f43f5e',
};

// Which customize knobs apply to which type. Universal knobs (size, accent)
// are always present; this map adds type-specific ones.
const TYPE_KNOBS = {
	turntable: [],
	'animation-gallery': [],
	'talking-agent': [],
	passport: [],
	'hotspot-tour': [],
	'pumpfun-feed': ['kind'],
	'kol-trades': ['mint'],
	'live-trades-canvas': ['mint'],
};

const SIZE_PRESETS = {
	S: 0.6,
	M: 1.0,
	L: 1.4,
};

const FORMATS = [
	{ id: 'iframe', label: 'HTML iframe' },
	{ id: 'jsx', label: 'JSX (React)' },
	{ id: 'url', label: 'Share URL' },
];

// Fade-in cards as they scroll into view
const cardObserver = new IntersectionObserver(
	(entries) => {
		entries.forEach((e) => {
			if (e.isIntersecting) {
				e.target.classList.add('sc-visible');
				cardObserver.unobserve(e.target);
			}
		});
	},
	{ threshold: 0.06 },
);

(async function init() {
	showSkeleton(3);

	let showcase;
	try {
		const res = await fetch('/widgets-gallery/showcase.json', { cache: 'no-cache' });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		showcase = await res.json();
	} catch (err) {
		GRID_EL.innerHTML = '';
		GRID_EL.appendChild(errorEl('Could not load showcase config.', err.message));
		GRID_EL.removeAttribute('aria-busy');
		return;
	}

	const widgets = showcase.widgets || [];

	renderFilters(widgets);
	updateHeroCount(widgets.length);

	GRID_EL.innerHTML = '';
	for (const w of widgets) {
		const card = renderShowcase(w);
		GRID_EL.appendChild(card);
		cardObserver.observe(card);
	}
	GRID_EL.removeAttribute('aria-busy');
})();

// ─── Skeleton ────────────────────────────────────────────────────────────────

function showSkeleton(n) {
	GRID_EL.innerHTML = '';
	for (let i = 0; i < n; i++) {
		const s = document.createElement('div');
		s.className = 'showcase showcase-skeleton';
		s.innerHTML = `
			<div class="showcase-frame skel-block"></div>
			<div class="showcase-meta">
				<div class="skel-line" style="width:6rem;height:1rem"></div>
				<div class="skel-line" style="width:70%;height:1.6rem;margin-top:.5rem"></div>
				<div class="skel-line" style="width:90%;height:.9rem;margin-top:.75rem"></div>
				<div class="skel-line" style="width:75%;height:.9rem;margin-top:.4rem"></div>
				<div class="skel-line" style="height:5rem;margin-top:1.2rem"></div>
				<div class="skel-row">
					<div class="skel-line" style="flex:1;height:2rem"></div>
					<div class="skel-line" style="flex:1;height:2rem"></div>
					<div class="skel-line" style="flex:1;height:2rem"></div>
				</div>
			</div>`;
		GRID_EL.appendChild(s);
	}
}

// ─── Filter bar ──────────────────────────────────────────────────────────────

function renderFilters(widgets) {
	const types = [...new Set(widgets.map((w) => w.type))];

	const bar = document.createElement('div');
	bar.className = 'filter-bar';
	bar.setAttribute('role', 'group');
	bar.setAttribute('aria-label', 'Filter by widget type');

	const allBtn = makeFilterBtn('All', null, true);
	bar.appendChild(allBtn);
	for (const t of types) {
		bar.appendChild(makeFilterBtn(t.replace(/-/g, '‑'), t, false)); // non-breaking hyphens
	}

	bar.addEventListener('click', (e) => {
		const btn = e.target.closest('.filter-btn');
		if (!btn) return;
		bar.querySelectorAll('.filter-btn').forEach((b) => b.removeAttribute('data-active'));
		btn.setAttribute('data-active', 'true');
		const type = btn.dataset.type || null;
		let visIdx = 0;
		document.querySelectorAll('#gallery-grid .showcase:not(.showcase-skeleton)').forEach((card) => {
			const show = !type || card.dataset.type === type;
			card.hidden = !show;
			if (show) {
				card.style.setProperty('--card-idx', visIdx++);
			}
		});
		GRID_EL.dataset.filtered = type ? 'true' : '';
	});

	GRID_EL.before(bar);
}

function makeFilterBtn(label, type, active) {
	const btn = document.createElement('button');
	btn.type = 'button';
	btn.className = 'filter-btn';
	btn.textContent = label;
	if (type) {
		btn.dataset.type = type;
		const c = TYPE_COLORS[type];
		if (c) btn.style.setProperty('--type-color', c);
	}
	if (active) btn.setAttribute('data-active', 'true');
	return btn;
}

// ─── Hero count ──────────────────────────────────────────────────────────────

function updateHeroCount(n) {
	const el = document.getElementById('widget-count');
	if (el) el.textContent = n;
}

// ─── Showcase card ───────────────────────────────────────────────────────────

function renderShowcase(w) {
	const root = document.createElement('article');
	root.className = 'showcase';
	root.dataset.type = w.type;
	root.setAttribute('aria-labelledby', `sc-${w.id}-title`);

	const color = TYPE_COLORS[w.type] || 'var(--accent)';
	root.style.setProperty('--type-color', color);

	const allowAttr =
		w.type === 'talking-agent'
			? 'autoplay; xr-spatial-tracking; clipboard-write; microphone'
			: 'autoplay; xr-spatial-tracking; clipboard-write';

	// Customizer state — mutated by inputs, read by snippet + iframe builders.
	const state = {
		size: 'M',
		accent: TYPE_COLORS[w.type] || '#8b5cf6',
		mint:
			w.type === 'live-trades-canvas'
				? 'So11111111111111111111111111111111111111112'
				: w.type === 'kol-trades'
					? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
					: '',
		kind: 'all',
		format: 'iframe',
	};

	function currentWidth() {
		return Math.round(w.width * SIZE_PRESETS[state.size]);
	}

	function buildHashParams() {
		const parts = [`widget=${encodeURIComponent(w.id)}`, 'kiosk=true'];
		if (state.accent && state.accent !== TYPE_COLORS[w.type]) {
			parts.push(`accent=${encodeURIComponent(state.accent)}`);
		}
		if (TYPE_KNOBS[w.type]?.includes('mint') && state.mint) {
			parts.push(`mint=${encodeURIComponent(state.mint)}`);
		}
		if (TYPE_KNOBS[w.type]?.includes('kind') && state.kind && state.kind !== 'all') {
			parts.push(`kind=${encodeURIComponent(state.kind)}`);
		}
		return parts.join('&');
	}

	function widgetUrl() {
		// Gallery is dense (N widgets per page) → reveal=interaction keeps
		// WebGL slots free until the visitor clicks; auto-poster from
		// /api/widgets/<id>/og means each card shows the avatar instantly.
		const poster = `${ORIGIN}/api/widgets/${encodeURIComponent(w.id)}/og`;
		return `${ORIGIN}/widget#${buildHashParams()}&reveal=interaction&poster=${encodeURIComponent(poster)}`;
	}
	function pageUrl() {
		// /w/<id> currently only carries the saved config — for customized embeds
		// we link the /widget hash form which preserves all overrides.
		const customized = state.size !== 'M' || state.accent !== TYPE_COLORS[w.type] ||
			(TYPE_KNOBS[w.type]?.includes('mint') && state.mint !== defaultMint(w.type)) ||
			(TYPE_KNOBS[w.type]?.includes('kind') && state.kind !== 'all');
		return customized ? widgetUrl() : `${ORIGIN}/w/${encodeURIComponent(w.id)}`;
	}

	function buildSnippet(format) {
		const url = widgetUrl();
		const mw = currentWidth();
		if (format === 'url') return pageUrl();
		if (format === 'jsx') {
			return (
				`<iframe\n` +
				`  src="${url}"\n` +
				`  title="${escAttr(w.label)}"\n` +
				`  allow="${allowAttr}"\n` +
				`  loading="lazy"\n` +
				`  style={{\n` +
				`    width: '100%',\n` +
				`    aspectRatio: '${w.width}/${w.height}',\n` +
				`    border: 0,\n` +
				`    borderRadius: 12,\n` +
				`    maxWidth: ${mw},\n` +
				`  }}\n` +
				`/>`
			);
		}
		return (
			`<iframe src="${url}" ` +
			`style="width:100%;aspect-ratio:${w.width}/${w.height};border:0;border-radius:12px;max-width:${mw}px" ` +
			`allow="${allowAttr}" loading="lazy"></iframe>`
		);
	}

	// ── Frame + tabs ──
	const frameWrap = document.createElement('div');
	frameWrap.className = 'showcase-frame-wrap';

	const tabBar = document.createElement('div');
	tabBar.className = 'frame-tabs';
	tabBar.setAttribute('role', 'tablist');
	const previewTab = makeTab('Preview', true);
	const codeTab = makeTab('Code', false);
	tabBar.appendChild(previewTab);
	tabBar.appendChild(codeTab);
	frameWrap.appendChild(tabBar);

	const frame = document.createElement('div');
	frame.className = 'showcase-frame';
	frame.style.aspectRatio = `${w.width} / ${w.height}`;
	frame.style.maxWidth = `${currentWidth()}px`;

	const placeholder = document.createElement('div');
	placeholder.className = 'frame-placeholder';
	placeholder.innerHTML = `
		<div class="frame-ph-inner">
			<button type="button" class="play-btn" aria-label="Load ${escHtml(w.label)} preview">
				<svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor" aria-hidden="true">
					<path d="M8 5v14l11-7z"/>
				</svg>
			</button>
			<span class="frame-ph-label">${escHtml(w.label)}</span>
			<span class="frame-ph-dim">${w.width} × ${w.height}</span>
		</div>`;

	let iframe = null;
	let iframeLoaded = false;
	const loadIframe = () => {
		if (iframeLoaded) return;
		iframeLoaded = true;
		placeholder.classList.add('frame-placeholder--loading');
		iframe = document.createElement('iframe');
		iframe.src = widgetUrl();
		iframe.title = `${w.label} demo`;
		iframe.loading = 'eager';
		iframe.allow = allowAttr;
		iframe.onload = () => placeholder.remove();
		frame.appendChild(iframe);
	};
	const reloadIframe = () => {
		if (!iframe) return;
		iframe.src = widgetUrl();
	};

	placeholder.querySelector('.play-btn').addEventListener('click', loadIframe);
	frame.appendChild(placeholder);

	// Auto-load when the frame becomes 50 % visible.
	const autoObs = new IntersectionObserver(
		(entries) => {
			if (entries[0].isIntersecting) {
				loadIframe();
				autoObs.disconnect();
			}
		},
		{ threshold: 0.5 },
	);
	autoObs.observe(frame);

	// Code panel — shown when Code tab active. Mirrors the snippet element below
	// the customizer for power users who want it in the preview area too.
	const codePanel = document.createElement('div');
	codePanel.className = 'frame-code-panel';
	codePanel.hidden = true;
	const codePanelPre = document.createElement('pre');
	codePanelPre.className = 'frame-code';
	const codePanelInner = document.createElement('code');
	codePanelPre.appendChild(codePanelInner);
	codePanel.appendChild(codePanelPre);

	frameWrap.appendChild(frame);
	frameWrap.appendChild(codePanel);

	previewTab.addEventListener('click', () => switchTab('preview'));
	codeTab.addEventListener('click', () => switchTab('code'));
	function switchTab(which) {
		const isPreview = which === 'preview';
		previewTab.setAttribute('aria-selected', String(isPreview));
		codeTab.setAttribute('aria-selected', String(!isPreview));
		previewTab.dataset.active = isPreview ? 'true' : '';
		codeTab.dataset.active = isPreview ? '' : 'true';
		frame.hidden = !isPreview;
		codePanel.hidden = isPreview;
		if (!isPreview) refreshSnippetOutputs();
	}

	// ── Meta ──
	const meta = document.createElement('div');
	meta.className = 'showcase-meta';

	const tag = document.createElement('span');
	tag.className = 'type-tag';
	tag.textContent = w.type.replace(/-/g, ' ');
	meta.appendChild(tag);

	const h = document.createElement('h3');
	h.id = `sc-${w.id}-title`;
	h.textContent = w.label;
	meta.appendChild(h);

	const desc = document.createElement('p');
	desc.textContent = w.tagline;
	meta.appendChild(desc);

	if (w.features?.length) {
		const ul = document.createElement('ul');
		ul.className = 'widget-features';
		for (const f of w.features) {
			const li = document.createElement('li');
			li.textContent = f;
			ul.appendChild(li);
		}
		meta.appendChild(ul);
	}

	// ── Customize panel ──
	const customize = document.createElement('details');
	customize.className = 'customize';
	customize.open = false;

	const summary = document.createElement('summary');
	summary.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
		<circle cx="12" cy="12" r="3"/>
		<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
	</svg><span>Customize</span>`;
	customize.appendChild(summary);

	const knobs = document.createElement('div');
	knobs.className = 'customize-knobs';

	// Size preset
	const sizeRow = makeKnobRow('Size');
	const sizeBtns = document.createElement('div');
	sizeBtns.className = 'size-presets';
	['S', 'M', 'L'].forEach((s) => {
		const b = document.createElement('button');
		b.type = 'button';
		b.textContent = s;
		b.dataset.size = s;
		if (s === state.size) b.dataset.active = 'true';
		b.addEventListener('click', () => {
			state.size = s;
			sizeBtns.querySelectorAll('button').forEach((bb) =>
				bb.removeAttribute('data-active'),
			);
			b.dataset.active = 'true';
			frame.style.maxWidth = `${currentWidth()}px`;
			refreshSnippetOutputs();
		});
		sizeBtns.appendChild(b);
	});
	sizeRow.appendChild(sizeBtns);
	knobs.appendChild(sizeRow);

	// Accent color
	const accentRow = makeKnobRow('Accent');
	const accentInput = document.createElement('input');
	accentInput.type = 'color';
	accentInput.value = state.accent;
	accentInput.setAttribute('aria-label', `Accent color for ${w.label}`);
	accentInput.addEventListener('input', () => {
		state.accent = accentInput.value;
		root.style.setProperty('--type-color', state.accent);
		refreshSnippetOutputs();
		debouncedReload();
	});
	const accentValue = document.createElement('span');
	accentValue.className = 'accent-value';
	accentValue.textContent = state.accent;
	accentInput.addEventListener('input', () => {
		accentValue.textContent = accentInput.value;
	});
	accentRow.appendChild(accentInput);
	accentRow.appendChild(accentValue);
	knobs.appendChild(accentRow);

	// Per-type: mint
	if (TYPE_KNOBS[w.type].includes('mint')) {
		const mintRow = makeKnobRow('Mint');
		const mintInput = document.createElement('input');
		mintInput.type = 'text';
		mintInput.value = state.mint;
		mintInput.placeholder = 'Solana mint address';
		mintInput.spellcheck = false;
		mintInput.setAttribute('aria-label', `Token mint for ${w.label}`);
		mintInput.addEventListener('input', () => {
			state.mint = mintInput.value.trim();
			refreshSnippetOutputs();
			debouncedReload();
		});
		mintRow.appendChild(mintInput);
		knobs.appendChild(mintRow);
	}

	// Per-type: kind (pumpfun-feed)
	if (TYPE_KNOBS[w.type].includes('kind')) {
		const kindRow = makeKnobRow('Kind');
		const kindSelect = document.createElement('select');
		kindSelect.setAttribute('aria-label', `Event kind for ${w.label}`);
		['all', 'claims', 'graduations'].forEach((opt) => {
			const o = document.createElement('option');
			o.value = opt;
			o.textContent = opt;
			if (opt === state.kind) o.selected = true;
			kindSelect.appendChild(o);
		});
		kindSelect.addEventListener('change', () => {
			state.kind = kindSelect.value;
			refreshSnippetOutputs();
			debouncedReload();
		});
		kindRow.appendChild(kindSelect);
		knobs.appendChild(kindRow);
	}

	// Reset
	const resetBtn = document.createElement('button');
	resetBtn.type = 'button';
	resetBtn.className = 'customize-reset';
	resetBtn.textContent = 'Reset';
	resetBtn.addEventListener('click', () => {
		state.size = 'M';
		state.accent = TYPE_COLORS[w.type] || '#8b5cf6';
		state.mint = defaultMint(w.type);
		state.kind = 'all';
		accentInput.value = state.accent;
		accentValue.textContent = state.accent;
		root.style.setProperty('--type-color', state.accent);
		sizeBtns.querySelectorAll('button').forEach((b) => {
			b.dataset.active = b.dataset.size === 'M' ? 'true' : '';
		});
		frame.style.maxWidth = `${currentWidth()}px`;
		knobs.querySelectorAll('input[type=text]').forEach((i) => (i.value = state.mint));
		knobs.querySelectorAll('select').forEach((s) => (s.value = state.kind));
		refreshSnippetOutputs();
		debouncedReload();
	});
	knobs.appendChild(resetBtn);

	customize.appendChild(knobs);
	meta.appendChild(customize);

	// ── Snippet block ──
	const codeBlock = document.createElement('pre');
	codeBlock.className = 'snippet';
	codeBlock.setAttribute('aria-label', 'Embed snippet');
	const codeInner = document.createElement('code');
	codeBlock.appendChild(codeInner);
	meta.appendChild(codeBlock);

	// ── Actions row: format split-button + studio link ──
	const row = document.createElement('div');
	row.className = 'snippet-row';

	const splitBtn = document.createElement('div');
	splitBtn.className = 'split-btn';

	const copyMain = document.createElement('button');
	copyMain.type = 'button';
	copyMain.className = 'split-btn-main';
	copyMain.setAttribute('aria-label', `Copy ${w.label} embed`);
	splitBtn.appendChild(copyMain);

	const formatToggle = document.createElement('button');
	formatToggle.type = 'button';
	formatToggle.className = 'split-btn-toggle';
	formatToggle.setAttribute('aria-haspopup', 'menu');
	formatToggle.setAttribute('aria-expanded', 'false');
	formatToggle.setAttribute('aria-label', 'Choose embed format');
	formatToggle.innerHTML = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>`;
	splitBtn.appendChild(formatToggle);

	const menu = document.createElement('div');
	menu.className = 'split-btn-menu';
	menu.setAttribute('role', 'menu');
	menu.hidden = true;
	FORMATS.forEach((f) => {
		const item = document.createElement('button');
		item.type = 'button';
		item.className = 'split-btn-menu-item';
		item.setAttribute('role', 'menuitemradio');
		item.textContent = f.label;
		item.dataset.format = f.id;
		if (f.id === state.format) item.setAttribute('aria-checked', 'true');
		item.addEventListener('click', () => {
			state.format = f.id;
			menu.querySelectorAll('[role=menuitemradio]').forEach((mi) =>
				mi.setAttribute('aria-checked', mi.dataset.format === f.id ? 'true' : 'false'),
			);
			closeMenu();
			refreshSnippetOutputs();
		});
		menu.appendChild(item);
	});
	splitBtn.appendChild(menu);
	row.appendChild(splitBtn);

	function openMenu() {
		menu.hidden = false;
		formatToggle.setAttribute('aria-expanded', 'true');
	}
	function closeMenu() {
		menu.hidden = true;
		formatToggle.setAttribute('aria-expanded', 'false');
	}
	formatToggle.addEventListener('click', (e) => {
		e.stopPropagation();
		if (menu.hidden) openMenu();
		else closeMenu();
	});
	document.addEventListener('click', (e) => {
		if (!splitBtn.contains(e.target)) closeMenu();
	});

	copyMain.addEventListener('click', () => copy(currentSnippet(), copyMain, formatLabelShort(state.format)));

	const studio = document.createElement('a');
	studio.href = `/studio?template=${encodeURIComponent(w.id)}`;
	studio.textContent = 'Open in Studio';
	studio.target = '_blank';
	studio.rel = 'noopener noreferrer';
	studio.setAttribute('aria-label', `Clone ${w.label} in Studio`);
	studio.className = 'studio-link';
	row.appendChild(studio);

	meta.appendChild(row);

	root.appendChild(frameWrap);
	root.appendChild(meta);

	// ── Debounced iframe reload while typing ──
	let reloadTimer = null;
	function debouncedReload() {
		if (!iframeLoaded) return;
		clearTimeout(reloadTimer);
		reloadTimer = setTimeout(reloadIframe, 350);
	}

	function currentSnippet() {
		return buildSnippet(state.format);
	}
	function refreshSnippetOutputs() {
		const text = currentSnippet();
		codeInner.textContent = text;
		codePanelInner.textContent = text;
		copyMain.textContent = `Copy ${formatLabelShort(state.format)}`;
	}
	refreshSnippetOutputs();

	return root;
}

function defaultMint(type) {
	if (type === 'live-trades-canvas') return 'So11111111111111111111111111111111111111112';
	if (type === 'kol-trades') return 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
	return '';
}

function formatLabelShort(id) {
	if (id === 'iframe') return 'iframe';
	if (id === 'jsx') return 'JSX';
	if (id === 'url') return 'URL';
	return id;
}

function makeKnobRow(label) {
	const row = document.createElement('div');
	row.className = 'knob-row';
	const lab = document.createElement('label');
	lab.textContent = label;
	row.appendChild(lab);
	return row;
}

function makeTab(label, active) {
	const btn = document.createElement('button');
	btn.type = 'button';
	btn.className = 'frame-tab';
	btn.setAttribute('role', 'tab');
	btn.setAttribute('aria-selected', String(!!active));
	if (active) btn.dataset.active = 'true';
	btn.textContent = label;
	return btn;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function copy(text, btn, formatShort) {
	try {
		await navigator.clipboard.writeText(text);
	} catch {
		const ta = document.createElement('textarea');
		ta.value = text;
		ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
		document.body.appendChild(ta);
		ta.select();
		try {
			document.execCommand('copy');
		} catch {}
		ta.remove();
	}
	const orig = btn.textContent;
	btn.classList.add('copied');
	btn.textContent = 'Copied!';
	setTimeout(() => {
		btn.textContent = formatShort ? `Copy ${formatShort}` : orig;
		btn.classList.remove('copied');
	}, 1400);
}

function escHtml(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) =>
		({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
	);
}
function escAttr(s) {
	return escHtml(s);
}

function errorEl(msg, detail) {
	const e = document.createElement('div');
	e.className = 'error-state';
	e.innerHTML = `
		<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" style="flex-shrink:0">
			<circle cx="12" cy="12" r="10"/>
			<line x1="12" y1="8" x2="12" y2="12"/>
			<circle cx="12" cy="16" r=".5" fill="currentColor"/>
		</svg>
		<span>${escHtml(msg)}${detail ? ` — <code>${escHtml(detail)}</code>` : ''}</span>`;
	return e;
}
