// /walkthroughs/<slug> — the interactive walkthrough player.
//
// Each step is a real frame captured from the live product
// (scripts/capture-walkthroughs.mjs) plus the normalized rectangle of the
// element the step is about. The player zooms and pans the frame to that
// rectangle, cuts a spotlight out of a dimming layer around it, and anchors a
// callout to whichever side has room. The result reads like a screen recording
// but is a handful of JPEGs: instant, deep-linkable per step, translatable,
// keyboard-operable, and it degrades to a plain annotated still when the
// visitor asks for reduced motion.
//
// Geometry lives in ./walkthrough-geometry.js so its edge cases are unit
// testable without a DOM.

import { stepLayout } from './walkthrough-geometry.js';

const AUTOPLAY_MS = 7600;
const MANIFEST_URL = '/walkthroughs/manifest.json';

const state = {
	walkthrough: null,
	index: 0,
	playing: false,
	timer: null,
	motion: true,
	sheet: false,
};

const el = {};

function esc(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function slugFromLocation() {
	const m = location.pathname.match(/\/walkthroughs\/([a-z0-9-]+)\/?$/);
	return m ? m[1] : '';
}

function stepFromHash() {
	const m = location.hash.match(/^#step-(\d+)$/);
	if (!m) return 0;
	return Math.max(0, Number(m[1]) - 1);
}

function setState(root, name) {
	root.setAttribute('data-state', name);
}

// ── Rendering ────────────────────────────────────────────────────────────────

function shellHtml(w) {
	const steps = w.steps.length;
	return `
	<header class="wt-head">
		<a class="wt-back" href="/walkthroughs">
			<span aria-hidden="true">←</span> All walkthroughs
		</a>
		<h1 class="wt-title">${esc(w.title)}</h1>
		<p class="wt-outcome">${esc(w.outcome)}</p>
		<ul class="wt-meta">
			<li class="wt-chip wt-chip-level">${esc(w.level)}</li>
			<li class="wt-chip">${w.minutes} min read</li>
			<li class="wt-chip">${steps} steps</li>
		</ul>
	</header>

	<div class="wt-stagewrap">
		<button type="button" class="wt-arrow wt-arrow-prev" id="wt-prev" aria-label="Previous step">
			<span aria-hidden="true">‹</span>
		</button>
		<figure class="wt-stage" id="wt-stage" role="group" aria-roledescription="walkthrough" aria-label="${esc(w.title)}">
			<img class="wt-frame" id="wt-frame" alt="" decoding="async" />
			<div class="wt-spot" id="wt-spot" aria-hidden="true"></div>
			<div class="wt-callout" id="wt-callout" data-side="right">
				<p class="wt-callout-count" id="wt-count"></p>
				<h2 class="wt-callout-title" id="wt-steptitle"></h2>
				<p class="wt-callout-body" id="wt-body"></p>
				<p class="wt-callout-tip" id="wt-tip"></p>
				<a class="wt-callout-action" id="wt-action" href="/"></a>
			</div>
			<figcaption class="wt-caption" id="wt-caption"></figcaption>
		</figure>
		<button type="button" class="wt-arrow wt-arrow-next" id="wt-next" aria-label="Next step">
			<span aria-hidden="true">›</span>
		</button>
	</div>

	<div class="wt-bar">
		<button type="button" class="wt-play" id="wt-play" aria-pressed="false">
			<span class="wt-play-icon" aria-hidden="true"></span>
			<span class="wt-play-label">Play</span>
		</button>
		<ol class="wt-rail" id="wt-rail"></ol>
		<a class="wt-visit" id="wt-visit" href="${esc(w.cta.href)}"><span id="wt-visit-label">${esc(w.cta.label)}</span> <span aria-hidden="true">↗</span></a>
	</div>

	<div class="wt-progress" id="wt-progress" aria-hidden="true"><span id="wt-progress-fill"></span></div>

	<footer class="wt-foot">
		<div class="wt-foot-next">
			<p class="wt-foot-label">When you are ready</p>
			<a class="wt-foot-cta" href="${esc(w.cta.href)}">${esc(w.cta.label)}</a>
		</div>
		${
			w.related && w.related.length
				? `<div class="wt-foot-related">
			<p class="wt-foot-label">Keep going</p>
			<ul>${w.related.map((r) => `<li><a href="${esc(r.href)}">${esc(r.label)}</a></li>`).join('')}</ul>
		</div>`
				: ''
		}
	</footer>

	<p class="wt-sr" id="wt-live" role="status" aria-live="polite"></p>`;
}

function cacheNodes(root) {
	const ids = [
		'wt-stage',
		'wt-frame',
		'wt-spot',
		'wt-callout',
		'wt-count',
		'wt-steptitle',
		'wt-body',
		'wt-tip',
		'wt-action',
		'wt-caption',
		'wt-rail',
		'wt-play',
		'wt-prev',
		'wt-next',
		'wt-visit',
		'wt-visit-label',
		'wt-live',
		'wt-progress-fill',
	];
	for (const id of ids) el[id] = root.querySelector('#' + id);
}

function renderRail(w) {
	el['wt-rail'].innerHTML = w.steps
		.map(
			(s, i) =>
				`<li><button type="button" class="wt-rail-btn" data-step="${i}" aria-label="Step ${i + 1}: ${esc(s.title)}"><span class="wt-rail-n">${i + 1}</span><span class="wt-rail-t">${esc(s.title)}</span></button></li>`,
		)
		.join('');
}

function applyStep(i, opts = {}) {
	const w = state.walkthrough;
	state.index = Math.max(0, Math.min(w.steps.length - 1, i));
	const step = w.steps[state.index];
	const layout = stepLayout(step.hotspot, { motion: state.motion, sheet: state.sheet });

	el['wt-frame'].src = step.shot;
	el['wt-frame'].alt = `${step.pageTitle || w.title}: ${step.title}`;
	el['wt-frame'].style.transform = `translate(${(layout.transform.x * 100).toFixed(4)}%, ${(layout.transform.y * 100).toFixed(4)}%) scale(${layout.transform.scale.toFixed(4)})`;

	const s = layout.spot;
	const spot = el['wt-spot'];
	spot.style.left = `${(s.x * 100).toFixed(4)}%`;
	spot.style.top = `${(s.y * 100).toFixed(4)}%`;
	spot.style.width = `${(s.w * 100).toFixed(4)}%`;
	spot.style.height = `${(s.h * 100).toFixed(4)}%`;

	const c = el['wt-callout'];
	c.dataset.side = layout.callout.side;
	if (layout.callout.side === 'sheet') {
		// The sheet is placed entirely in CSS; inline coordinates would win
		// against it and drag the card off the bottom of the stage.
		c.style.removeProperty('left');
		c.style.removeProperty('top');
	} else {
		c.style.left = `${(layout.callout.x * 100).toFixed(4)}%`;
		c.style.top = `${(layout.callout.y * 100).toFixed(4)}%`;
	}

	el['wt-count'].textContent = `Step ${state.index + 1} of ${w.steps.length}`;
	el['wt-steptitle'].textContent = step.title;
	el['wt-body'].textContent = step.body;
	el['wt-tip'].textContent = step.tip || '';
	el['wt-tip'].hidden = !step.tip;

	const action = step.action || { label: `Open ${step.path}`, href: step.path };
	el['wt-action'].textContent = action.label;
	el['wt-action'].href = action.href;

	el['wt-caption'].textContent = `Captured from ${step.path}`;
	el['wt-visit'].href = step.path;
	el['wt-visit-label'].textContent = `Open ${step.path}`;

	el['wt-prev'].disabled = state.index === 0;
	el['wt-next'].disabled = state.index === w.steps.length - 1;

	for (const btn of el['wt-rail'].querySelectorAll('.wt-rail-btn')) {
		const on = Number(btn.dataset.step) === state.index;
		btn.setAttribute('aria-current', on ? 'step' : 'false');
	}

	el['wt-progress-fill'].style.width = `${(((state.index + 1) / w.steps.length) * 100).toFixed(2)}%`;
	el['wt-live'].textContent = `Step ${state.index + 1} of ${w.steps.length}. ${step.title}. ${step.body}`;

	if (!opts.silent) {
		const hash = `#step-${state.index + 1}`;
		if (location.hash !== hash) history.replaceState(null, '', location.pathname + hash);
	}

	preloadNeighbours();
}

function preloadNeighbours() {
	const w = state.walkthrough;
	for (const i of [state.index + 1, state.index - 1]) {
		const s = w.steps[i];
		if (!s) continue;
		const img = new Image();
		img.decoding = 'async';
		img.src = s.shot;
	}
}

// ── Playback ─────────────────────────────────────────────────────────────────

function stop() {
	state.playing = false;
	clearInterval(state.timer);
	state.timer = null;
	el['wt-play'].setAttribute('aria-pressed', 'false');
	el['wt-play'].querySelector('.wt-play-label').textContent = 'Play';
	el['wt-play'].classList.remove('is-playing');
}

function play() {
	if (state.index === state.walkthrough.steps.length - 1) applyStep(0);
	state.playing = true;
	el['wt-play'].setAttribute('aria-pressed', 'true');
	el['wt-play'].querySelector('.wt-play-label').textContent = 'Pause';
	el['wt-play'].classList.add('is-playing');
	clearInterval(state.timer);
	state.timer = setInterval(() => {
		if (state.index >= state.walkthrough.steps.length - 1) {
			stop();
			return;
		}
		applyStep(state.index + 1);
	}, AUTOPLAY_MS);
}

function togglePlay() {
	if (state.playing) stop();
	else play();
}

function go(delta) {
	stop();
	applyStep(state.index + delta);
}

// ── Wiring ───────────────────────────────────────────────────────────────────

function bind(root) {
	el['wt-prev'].addEventListener('click', () => go(-1));
	el['wt-next'].addEventListener('click', () => go(1));
	el['wt-play'].addEventListener('click', togglePlay);
	el['wt-rail'].addEventListener('click', (e) => {
		const btn = e.target.closest('.wt-rail-btn');
		if (!btn) return;
		stop();
		applyStep(Number(btn.dataset.step));
	});

	el['wt-stage'].addEventListener('click', (e) => {
		if (e.target.closest('.wt-callout')) return;
		go(1);
	});

	root.addEventListener('keydown', (e) => {
		if (e.target.matches('input, textarea')) return;
		if (e.key === 'ArrowRight') {
			e.preventDefault();
			go(1);
		} else if (e.key === 'ArrowLeft') {
			e.preventDefault();
			go(-1);
		} else if (e.key === 'Home') {
			e.preventDefault();
			stop();
			applyStep(0);
		} else if (e.key === 'End') {
			e.preventDefault();
			stop();
			applyStep(state.walkthrough.steps.length - 1);
		} else if (e.key === ' ' || e.key === 'Spacebar') {
			e.preventDefault();
			togglePlay();
		} else if (e.key === 'Escape') {
			stop();
		}
	});

	window.addEventListener('hashchange', () => applyStep(stepFromHash(), { silent: true }));

	// Autoplay is a convenience, never a trap: any hover or focus inside the
	// stage hands control back to the reader.
	for (const evt of ['pointerdown', 'focusin']) {
		el['wt-stage'].addEventListener(evt, (e) => {
			if (state.playing && e.target.closest('.wt-callout')) stop();
		});
	}

	const motionMq = window.matchMedia('(prefers-reduced-motion: reduce)');
	const sheetMq = window.matchMedia('(max-width: 860px)');
	const sync = (rerender) => {
		state.motion = !motionMq.matches;
		state.sheet = sheetMq.matches;
		root.classList.toggle('wt-static', !state.motion);
		if (rerender && state.walkthrough) applyStep(state.index, { silent: true });
	};
	motionMq.addEventListener('change', () => sync(true));
	sheetMq.addEventListener('change', () => sync(true));
	sync(false);
}

function renderError(root, heading, detail, retry) {
	setState(root, 'error');
	root.innerHTML = `
	<div class="wt-msg">
		<h1>${esc(heading)}</h1>
		<p>${esc(detail)}</p>
		<div class="wt-msg-actions">
			<a class="wt-msg-btn" href="/walkthroughs">Browse all walkthroughs</a>
			${retry ? '<button type="button" class="wt-msg-btn wt-msg-btn-ghost" id="wt-retry">Try again</button>' : ''}
		</div>
	</div>`;
	const btn = root.querySelector('#wt-retry');
	if (btn) btn.addEventListener('click', () => boot());
}

async function boot() {
	const root = document.getElementById('wt-root');
	if (!root) return;
	const slug = slugFromLocation();
	if (!slug) {
		renderError(root, 'No walkthrough selected', 'The address is missing a walkthrough name.', false);
		return;
	}

	setState(root, 'loading');
	root.innerHTML = `
	<div class="wt-skeleton" aria-hidden="true">
		<div class="wt-sk-line wt-sk-line-lg"></div>
		<div class="wt-sk-line wt-sk-line-sm"></div>
		<div class="wt-sk-stage"></div>
		<div class="wt-sk-bar"></div>
	</div>
	<p class="wt-sr" role="status" aria-live="polite">Loading walkthrough</p>`;

	let manifest;
	try {
		const res = await fetch(MANIFEST_URL, { cache: 'no-cache' });
		if (!res.ok) throw new Error(`manifest ${res.status}`);
		manifest = await res.json();
	} catch (err) {
		renderError(root, 'Could not load the walkthroughs', `The walkthrough media did not load (${err.message}). Your connection may have dropped.`, true);
		return;
	}

	const w = (manifest.walkthroughs || []).find((x) => x.slug === slug);
	if (!w || !w.steps.length) {
		renderError(root, 'That walkthrough does not exist', `Nothing is published under "${slug}".`, false);
		return;
	}

	document.title = `${w.title} · Walkthrough · three.ws`;
	const desc = document.querySelector('meta[name="description"]');
	if (desc) desc.setAttribute('content', `${w.outcome} ${w.blurb}`);
	document.documentElement.style.setProperty('--wt-accent', w.accent);

	state.walkthrough = w;
	setState(root, 'ready');
	root.innerHTML = shellHtml(w);
	cacheNodes(root);
	renderRail(w);
	bind(root);
	applyStep(stepFromHash(), { silent: true });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
