// Widget gallery — native DOM, no framework.
// Renders showcase cards from /widgets-gallery/showcase.json with:
//  - skeleton loader while fetching
//  - filter bar by widget type
//  - click-to-load (+ auto-load at 50% visibility) iframes
//  - scroll-in fade animation per card
//  - responsive embed snippet

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
				// Re-stagger visible cards for alternating layout
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

	const widgetUrl = `${ORIGIN}/widget#widget=${encodeURIComponent(w.id)}&kiosk=true`;
	const pageUrl = `${ORIGIN}/w/${encodeURIComponent(w.id)}`;

	const allowAttr =
		w.type === 'talking-agent'
			? 'autoplay; xr-spatial-tracking; clipboard-write; microphone'
			: 'autoplay; xr-spatial-tracking; clipboard-write';

	// Responsive snippet — adapts to container, caps at native size
	const snippet =
		`<iframe src="${widgetUrl}" ` +
		`style="width:100%;aspect-ratio:${w.width}/${w.height};border:0;border-radius:12px;max-width:${w.width}px" ` +
		`allow="${allowAttr}" loading="lazy"></iframe>`;

	// ── Frame ──
	const frame = document.createElement('div');
	frame.className = 'showcase-frame';
	frame.style.aspectRatio = `${w.width} / ${w.height}`;
	frame.style.maxWidth = `${w.width}px`;

	const color = TYPE_COLORS[w.type] || 'var(--accent)';

	const placeholder = document.createElement('div');
	placeholder.className = 'frame-placeholder';
	placeholder.style.setProperty('--type-color', color);
	placeholder.innerHTML = `
		<div class="frame-ph-inner">
			<button type="button" class="play-btn" aria-label="Load ${w.label} preview">
				<svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor" aria-hidden="true">
					<path d="M8 5v14l11-7z"/>
				</svg>
			</button>
			<span class="frame-ph-label">${w.label}</span>
			<span class="frame-ph-dim">${w.width} × ${w.height}</span>
		</div>`;

	let iframeLoaded = false;
	const loadIframe = () => {
		if (iframeLoaded) return;
		iframeLoaded = true;
		placeholder.classList.add('frame-placeholder--loading');
		const iframe = document.createElement('iframe');
		iframe.src = widgetUrl;
		iframe.title = `${w.label} demo`;
		iframe.loading = 'eager';
		iframe.allow = allowAttr;
		iframe.onload = () => placeholder.remove();
		frame.appendChild(iframe);
	};

	placeholder.querySelector('.play-btn').addEventListener('click', loadIframe);
	frame.appendChild(placeholder);

	// Auto-load when the frame becomes 50% visible. No artificial delay —
	// IntersectionObserver only fires after layout, so by the time we get
	// here the user has actually scrolled the tile into view.
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

	// ── Meta ──
	const meta = document.createElement('div');
	meta.className = 'showcase-meta';

	const tag = document.createElement('span');
	tag.className = 'type-tag';
	tag.textContent = w.type.replace(/-/g, ' ');
	tag.style.setProperty('--type-color', color);
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

	const code = document.createElement('pre');
	code.className = 'snippet';
	code.setAttribute('aria-label', 'Embed snippet');
	const codeInner = document.createElement('code');
	codeInner.textContent = snippet;
	code.appendChild(codeInner);
	meta.appendChild(code);

	const row = document.createElement('div');
	row.className = 'snippet-row';

	const copyBtn = makeActionBtn('Copy iframe', `Copy embed snippet for ${w.label}`);
	copyBtn.addEventListener('click', () => copy(snippet, copyBtn));
	row.appendChild(copyBtn);

	const copyUrlBtn = makeActionBtn('Copy URL', `Copy shareable URL for ${w.label}`);
	copyUrlBtn.addEventListener('click', () => copy(pageUrl, copyUrlBtn));
	row.appendChild(copyUrlBtn);

	const studio = document.createElement('a');
	studio.href = `/studio?template=${encodeURIComponent(w.id)}`;
	studio.textContent = 'Open in Studio';
	studio.target = '_blank';
	studio.rel = 'noopener noreferrer';
	studio.setAttribute('aria-label', `Clone ${w.label} in Studio`);
	row.appendChild(studio);

	meta.appendChild(row);

	root.appendChild(frame);
	root.appendChild(meta);
	return root;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeActionBtn(text, ariaLabel) {
	const btn = document.createElement('button');
	btn.type = 'button';
	btn.textContent = text;
	btn.setAttribute('aria-label', ariaLabel);
	return btn;
}

async function copy(text, btn) {
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
		btn.textContent = orig;
		btn.classList.remove('copied');
	}, 1400);
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
		<span>${msg}${detail ? ` — <code>${detail}</code>` : ''}</span>`;
	return e;
}
