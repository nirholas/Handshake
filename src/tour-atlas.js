// tour-atlas.js: the /tour/atlas surface.
//
// Renders public/tour/atlas.json, the manifest scripts/capture-tour-atlas.mjs
// produces by driving a real Chromium across every stop of the guided tour. Each
// card is a real screenshot of the live site with the feature ringed by the
// tour's own spotlight, so the page doubles as a visual index of the product and
// as a health board for the tour itself: a stop whose CSS anchor no longer
// resolves shows up here (and fails `npm run audit:tour-atlas`) instead of
// silently degrading to a whole-page dim for visitors.
//
// Every card is one click from the live tour via /?tour=start&stop=<id>, which
// TourDirector.start() honours (src/feature-tour/director.js).

const MANIFEST_URL = '/tour/atlas.json';

const els = {
	stats: document.getElementById('ta-stats'),
	provenance: document.getElementById('ta-provenance'),
	search: document.getElementById('ta-search'),
	track: document.getElementById('ta-track'),
	health: document.getElementById('ta-health'),
	sections: document.getElementById('ta-sections'),
	count: document.getElementById('ta-count'),
	grid: document.getElementById('ta-grid'),
	lb: document.getElementById('ta-lb'),
	lbImg: document.getElementById('ta-lb-img'),
	lbKicker: document.getElementById('ta-lb-kicker'),
	lbTitle: document.getElementById('ta-lb-h'),
	lbSay: document.getElementById('ta-lb-say'),
	lbMeta: document.getElementById('ta-lb-meta'),
	lbActions: document.getElementById('ta-lb-actions'),
	lbNone: document.getElementById('ta-lb-none'),
	main: document.querySelector('main'),
};

const state = {
	manifest: null,
	query: '',
	track: 'all',
	health: 'all',
	section: 'all',
	visible: [],
	openIndex: -1,
	lastFocus: null,
	wired: false,
};

const esc = (s) =>
	String(s ?? '').replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);

const TRACKS = [
	{ id: 'all', label: 'All stops' },
	{ id: 'quick', label: 'Quick' },
	{ id: 'onboarding', label: 'Getting started' },
];

// The health lens. "Curated" and "Generic" are both working anchors: the
// difference is whether the tour points at the feature the narration names or at
// whatever heading the page happened to have, which is exactly the backlog of
// stops worth giving a real selector in scripts/build-tour.mjs.
const HEALTH = [
	{ id: 'all', label: 'Any state' },
	{ id: 'curated', label: 'Curated' },
	{ id: 'generic', label: 'Generic' },
	{ id: 'broken', label: 'Needs work' },
];

function healthOf(stop) {
	if (stop.status >= 400 || stop.status === 0) return 'broken';
	if (stop.anchor?.state === 'missing') return 'broken';
	return stop.anchor?.source === 'curriculum' ? 'curated' : 'generic';
}

function matches(stop) {
	if (state.section !== 'all' && stop.section !== state.section) return false;
	if (state.track !== 'all' && !(stop.tracks || []).includes(state.track)) return false;
	if (state.health !== 'all' && healthOf(stop) !== state.health) return false;
	if (!state.query) return true;
	const hay = `${stop.title} ${stop.path} ${stop.id} ${stop.narration} ${stop.section}`.toLowerCase();
	return hay.includes(state.query);
}

// ── Header ───────────────────────────────────────────────────────────────────
function renderStats() {
	const s = state.manifest.summary;
	const tiles = [
		{ n: s.total, l: 'stops', tone: '' },
		{ n: state.manifest.sections.length, l: 'chapters', tone: '' },
		{ n: s.captured, l: 'screenshots', tone: '' },
		{ n: s.curatedAnchor, l: 'curated anchors', tone: 'good' },
		{ n: s.fallbackAnchor, l: 'generic anchors', tone: s.fallbackAnchor ? 'warn' : '' },
		{ n: s.missingAnchor + s.unreachable, l: 'need work', tone: s.missingAnchor + s.unreachable ? 'bad' : 'good' },
	];
	els.stats.innerHTML = tiles
		.map(
			(t) =>
				`<div class="ta-stat"${t.tone ? ` data-tone="${t.tone}"` : ''}>` +
				`<span class="ta-stat-n">${t.n}</span><span class="ta-stat-l">${esc(t.l)}</span></div>`,
		)
		.join('');
}

function renderProvenance() {
	const m = state.manifest;
	const when = new Date(m.generatedAt);
	const stamp = Number.isNaN(when.getTime())
		? m.generatedAt
		: when.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
	els.provenance.innerHTML =
		`Captured from <code>${esc(m.base)}</code> on ${esc(stamp)} by ` +
		`<code>scripts/capture-tour-atlas.mjs</code>. Re-run it after any redesign: ` +
		`<code>npm run tour:atlas</code>.`;
}

// ── Filters ──────────────────────────────────────────────────────────────────
function renderSegments() {
	const seg = (host, defs, active, group) => {
		host.innerHTML = defs
			.map(
				(d) =>
					`<button type="button" data-group="${group}" data-val="${esc(d.id)}" ` +
					`aria-pressed="${d.id === active}">${esc(d.label)}</button>`,
			)
			.join('');
	};
	seg(els.track, TRACKS, state.track, 'track');
	seg(els.health, HEALTH, state.health, 'health');
}

function renderSections() {
	const counts = new Map();
	for (const stop of state.manifest.stops) {
		counts.set(stop.section, (counts.get(stop.section) || 0) + 1);
	}
	const defs = [
		{ id: 'all', title: 'Every chapter', n: state.manifest.stops.length },
		...state.manifest.sections
			.filter((s) => counts.has(s.id))
			.map((s) => ({ id: s.id, title: s.title || s.id, n: counts.get(s.id) })),
	];
	els.sections.innerHTML = defs
		.map(
			(d) =>
				`<button type="button" class="ta-chip" data-section="${esc(d.id)}" ` +
				`aria-pressed="${d.id === state.section}">${esc(d.title)}` +
				`<span class="ta-chip-n">${d.n}</span></button>`,
		)
		.join('');
}

// ── Grid ─────────────────────────────────────────────────────────────────────
function badgesFor(stop) {
	const out = [];
	if (stop.highlight) out.push({ t: 'Quick tour', tone: 'accent' });
	const health = healthOf(stop);
	if (health === 'broken') {
		out.push({
			t: stop.status >= 400 || stop.status === 0 ? `HTTP ${stop.status || 'no response'}` : 'Anchor lost',
			tone: 'bad',
		});
	} else if (health === 'generic') {
		out.push({ t: 'Generic anchor', tone: 'warn' });
	}
	if (stop.consoleErrors > 0) {
		out.push({ t: `${stop.consoleErrors} console`, tone: 'warn' });
	}
	return out;
}

// The alt text has to describe the picture for someone who cannot see it, so it
// names the feature and where the ring is, not just the page title.
function altFor(stop) {
	const where = stop.anchor?.state === 'resolved' ? `, with the ${stop.title} feature ringed` : '';
	return `Screenshot of ${stop.path} on three.ws${where}`;
}

// Why a stop has no picture. There are two very different reasons and the page
// used to print only the first one, which was a false statement about all 18 of
// the stops that actually have it: every uncaptured stop in the committed atlas
// answered HTTP 200 and then ran past the screenshot timeout, because it is a
// live 3D or live-data page that never stops painting. Saying "did not respond"
// about a page that answered fine sends the reader to debug the wrong thing.
function noShotReason(stop) {
	if (stop.status === 0) return 'No screenshot: this page did not answer when the atlas last ran.';
	if (stop.status >= 400) return `No screenshot: this page answered HTTP ${stop.status} when the atlas last ran.`;
	return 'No screenshot: this page was still painting when the atlas last ran. Open it to see it live.';
}

function cardHtml(stop, i) {
	const shot = stop.media?.thumb;
	const figure = shot
		? `<img src="${esc(shot.url)}" alt="${esc(altFor(stop))}" loading="lazy" decoding="async"
				width="${shot.width}" height="${shot.height}" />`
		: `<div class="ta-shot-none">${esc(noShotReason(stop))}</div>`;
	const badges = badgesFor(stop)
		.map((b) => `<span class="ta-badge" data-tone="${b.tone}">${esc(b.t)}</span>`)
		.join('');
	return (
		`<button type="button" class="ta-card" data-i="${i}" data-id="${esc(stop.id)}" ` +
		`aria-label="Open ${esc(stop.title)}">` +
		`<span class="ta-shot"><span class="ta-idx">${stop.index + 1}</span>${figure}</span>` +
		`<span class="ta-body">` +
		`<span class="ta-title">${esc(stop.title)}</span>` +
		`<span class="ta-path">${esc(stop.path)}</span>` +
		`<span class="ta-say">${esc(stop.narration)}</span>` +
		`<span class="ta-badges">${badges}</span>` +
		`</span></button>`
	);
}

function renderGrid() {
	state.visible = state.manifest.stops.filter(matches);
	const n = state.visible.length;
	const total = state.manifest.stops.length;
	const filtered = n !== total;
	els.count.innerHTML =
		`<span>${n} of ${total} stops</span>` +
		(filtered ? `<button type="button" class="ta-reset">Clear filters</button>` : '');

	if (!n) {
		els.grid.innerHTML =
			`<div class="ta-empty"><h2>Nothing matches those filters</h2>` +
			`<p>No tour stop matches that combination. Try a different chapter, or clear the search and start again.</p>` +
			`<button type="button" class="ta-btn" data-variant="primary" data-act="reset">Show every stop</button></div>`;
		return;
	}
	els.grid.innerHTML = state.visible.map(cardHtml).join('');
}

function renderSkeleton() {
	els.grid.innerHTML = Array.from(
		{ length: 8 },
		() =>
			`<div class="ta-skel" aria-hidden="true"><div class="ta-skel-shot"></div>` +
			`<div class="ta-skel-line"></div><div class="ta-skel-line"></div></div>`,
	).join('');
	els.count.textContent = 'Loading the atlas…';
}

// A visitor cannot act on "Failed to fetch" or on an instruction to run an npm
// script, so every failure is translated into a sentence that says what happened
// and what to do about it, next to a button that runs the same load again.
function renderError(message) {
	els.grid.innerHTML =
		`<div class="ta-empty"><h2>The atlas could not load</h2>` +
		`<p>${esc(message)}</p>` +
		`<div class="ta-empty-actions">` +
		`<button type="button" class="ta-btn" data-variant="primary" data-act="retry">Try again</button>` +
		`<a class="ta-btn" href="/tour">Take the guided tour instead</a></div></div>`;
	els.count.textContent = '';
}

class AtlasLoadError extends Error {
	constructor(message, cause) {
		super(message);
		this.name = 'AtlasLoadError';
		this.cause = cause;
	}
}

// fetch() rejects with a TypeError for every transport-level failure (offline,
// DNS, CORS, an aborted request), which is the only class we can name honestly
// without guessing.
function visitorMessage(err) {
	if (err instanceof AtlasLoadError) return err.message;
	if (err instanceof TypeError) {
		return 'Your connection dropped before the atlas finished loading. Check it and try again.';
	}
	return 'Something went wrong while opening the atlas. Try again in a moment.';
}

// ── Lightbox ─────────────────────────────────────────────────────────────────
function metaRow(term, value) {
	return `<div><dt>${esc(term)}</dt><dd>${esc(value)}</dd></div>`;
}

function openStop(i, { pushHash = true } = {}) {
	const stop = state.visible[i];
	if (!stop) return;
	// Remember what to give focus back to, but only on the first open: stepping
	// prev/next while the dialog is up must not overwrite it with a dialog button.
	if (els.lb.hidden) state.lastFocus = document.activeElement;
	state.openIndex = i;

	const hero = stop.media?.hero;
	if (hero) {
		els.lbImg.src = hero.url;
		els.lbImg.alt = altFor(stop);
		els.lbImg.hidden = false;
		els.lbNone.hidden = true;
		els.lbNone.textContent = '';
	} else {
		// Hiding the image on its own left a bare black band above the copy. The
		// stop still has a page and a narration worth reading, so the figure says
		// why there is no picture instead of showing an empty frame.
		els.lbImg.removeAttribute('src');
		els.lbImg.alt = '';
		els.lbImg.hidden = true;
		els.lbNone.textContent = noShotReason(stop);
		els.lbNone.hidden = false;
	}

	const sectionTitle =
		state.manifest.sections.find((s) => s.id === stop.section)?.title || stop.section;
	els.lbKicker.textContent = `${sectionTitle} · stop ${stop.index + 1} of ${state.manifest.stops.length}`;
	els.lbTitle.textContent = stop.title;
	els.lbSay.textContent = stop.narration;

	const anchorLabel =
		stop.anchor?.state === 'resolved'
			? stop.anchor.source === 'curriculum'
				? 'curated selector'
				: 'generic fallback'
			: 'not resolving';
	els.lbMeta.innerHTML = [
		metaRow('Page', stop.path),
		metaRow('Tracks', (stop.tracks || []).join(', ') || 'full'),
		metaRow('Spotlight anchor', anchorLabel),
		stop.anchor?.selector ? metaRow('Selector', stop.anchor.selector) : '',
		metaRow('HTTP', String(stop.status || 'no response')),
		stop.consoleErrors ? metaRow('Console errors', String(stop.consoleErrors)) : '',
	]
		.filter(Boolean)
		.join('');

	els.lbActions.innerHTML =
		`<a class="ta-btn" data-variant="primary" href="${esc(stop.path)}?tour=start&amp;stop=${encodeURIComponent(stop.id)}">` +
		`Start the tour here</a>` +
		`<a class="ta-btn" href="${esc(stop.path)}">Open the page</a>` +
		(hero ? `<a class="ta-btn" href="${esc(hero.url)}" target="_blank" rel="noopener">Full screenshot</a>` : '');

	els.lb.querySelector('[data-act="prev"]').disabled = i <= 0;
	els.lb.querySelector('[data-act="next"]').disabled = i >= state.visible.length - 1;

	const wasHidden = els.lb.hidden;
	els.lb.hidden = false;
	document.body.style.overflow = 'hidden';
	// aria-modal alone leaves every card behind the dialog reachable to a screen
	// reader's virtual cursor; inert takes them out of the tree too.
	if (els.main) els.main.inert = true;
	// Move focus into the dialog on open. While stepping through stops the
	// visitor's focus is already on prev/next, so leave it there.
	if (wasHidden) els.lb.querySelector('[data-act="close"]').focus();
	if (pushHash) history.replaceState(null, '', `#${stop.id}`);
}

function closeLightbox() {
	if (els.lb.hidden) return;
	els.lb.hidden = true;
	document.body.style.overflow = '';
	if (els.main) els.main.inert = false;
	state.openIndex = -1;
	history.replaceState(null, '', location.pathname + location.search);
	state.lastFocus?.focus?.();
}

function resetFilters() {
	state.query = '';
	state.track = 'all';
	state.health = 'all';
	state.section = 'all';
	els.search.value = '';
	renderSegments();
	renderSections();
	renderGrid();
}

// A shared /tour/atlas#<id> link has to land on that stop even when it sits
// outside the filters the visitor last had. Returns false for an id no stop
// carries, which leaves the grid alone rather than blanking it.
function openFromHash(id) {
	let i = state.visible.findIndex((s) => s.id === id);
	if (i < 0) {
		if (!state.manifest.stops.some((s) => s.id === id)) return false;
		resetFilters();
		i = state.visible.findIndex((s) => s.id === id);
		if (i < 0) return false;
	}
	openStop(i, { pushHash: false });
	return true;
}

function step(delta) {
	const next = state.openIndex + delta;
	if (next < 0 || next >= state.visible.length) return;
	openStop(next);
}

// ── Events ───────────────────────────────────────────────────────────────────
function wire() {
	if (state.wired) return;
	state.wired = true;
	let timer;
	els.search.addEventListener('input', (e) => {
		if (!state.manifest) return;
		const value = e.target.value.trim().toLowerCase();
		clearTimeout(timer);
		timer = setTimeout(() => {
			state.query = value;
			renderGrid();
		}, 110);
	});

	const onSeg = (e) => {
		const btn = e.target.closest('button[data-val]');
		if (!btn || !state.manifest) return;
		state[btn.dataset.group] = btn.dataset.val;
		renderSegments();
		renderGrid();
	};
	els.track.addEventListener('click', onSeg);
	els.health.addEventListener('click', onSeg);

	els.sections.addEventListener('click', (e) => {
		const btn = e.target.closest('button[data-section]');
		if (!btn || !state.manifest) return;
		state.section = btn.dataset.section;
		renderSections();
		renderGrid();
	});

	els.count.addEventListener('click', (e) => {
		if (e.target.closest('.ta-reset')) resetFilters();
	});
	els.grid.addEventListener('click', (e) => {
		if (e.target.closest('[data-act="reset"]')) {
			resetFilters();
			return;
		}
		if (e.target.closest('[data-act="retry"]')) {
			load();
			return;
		}
		const card = e.target.closest('.ta-card');
		if (card && state.manifest) openStop(Number(card.dataset.i));
	});

	els.lb.addEventListener('click', (e) => {
		const act = e.target.closest('[data-act]')?.dataset.act;
		if (act === 'close') closeLightbox();
		else if (act === 'prev') step(-1);
		else if (act === 'next') step(1);
		// A click on the scrim (never on the panel) closes, matching every other
		// modal on the site.
		else if (e.target === els.lb) closeLightbox();
	});

	window.addEventListener('hashchange', () => {
		if (!state.manifest) return;
		const id = decodeURIComponent(location.hash.slice(1));
		if (!id) {
			closeLightbox();
			return;
		}
		if (state.visible[state.openIndex]?.id === id) return;
		openFromHash(id);
	});

	document.addEventListener('keydown', (e) => {
		if (els.lb.hidden) {
			// "/" focuses search from anywhere on the page, unless the visitor is
			// already typing into something.
			if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) {
				e.preventDefault();
				els.search.focus();
			}
			return;
		}
		if (e.key === 'Escape') closeLightbox();
		else if (e.key === 'ArrowLeft') step(-1);
		else if (e.key === 'ArrowRight') step(1);
		else if (e.key === 'Tab') {
			// Keep focus inside the dialog while it is open.
			const focusable = els.lb.querySelectorAll('button:not([disabled]), a[href]');
			if (!focusable.length) return;
			const first = focusable[0];
			const last = focusable[focusable.length - 1];
			if (e.shiftKey && document.activeElement === first) {
				e.preventDefault();
				last.focus();
			} else if (!e.shiftKey && document.activeElement === last) {
				e.preventDefault();
				first.focus();
			}
		}
	});
}

// ── Boot ─────────────────────────────────────────────────────────────────────
async function load() {
	state.manifest = null;
	renderSkeleton();
	try {
		const res = await fetch(MANIFEST_URL, { cache: 'no-cache' });
		if (!res.ok) {
			throw new AtlasLoadError(
				`The atlas could not be reached (HTTP ${res.status}). It is usually back within a minute.`,
			);
		}
		const data = await res.json().catch((cause) => {
			throw new AtlasLoadError('The atlas came back in a form this page could not read.', cause);
		});
		if (!data || !Array.isArray(data.stops) || !data.stops.length) {
			throw new AtlasLoadError('The atlas has no stops recorded yet, so there is nothing to show.');
		}
		state.manifest = data;
		renderStats();
		renderProvenance();
		renderSegments();
		renderSections();
		renderGrid();

		// A shared /tour/atlas#<stop-id> link opens straight onto that card.
		const wanted = decodeURIComponent(location.hash.slice(1));
		if (wanted) openFromHash(wanted);
	} catch (err) {
		renderError(visitorMessage(err));
	}
}

// Wired before the first fetch so the toolbar and the retry button are live even
// on a load that never got a manifest; every handler returns early until one
// arrives.
wire();
load();
