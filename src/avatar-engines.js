// Avatar Engines Atlas: renders the curated engine registry into a filterable,
// searchable, deep-linkable catalog. Pure client render from avatar-engines-data.js;
// no network. Filters reflect into the URL query so a filtered view is shareable.

import {
	ENGINES,
	FAMILIES,
	INTEGRATIONS,
	REPRESENTATIONS,
	engineStats,
	isRetired,
} from './avatar-engines-data.js';

const $ = (sel, root = document) => root.querySelector(sel);

// ── Small DOM helpers ────────────────────────────────────────────────────────
function el(tag, attrs = {}, children = []) {
	const node = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (v == null || v === false) continue;
		if (k === 'class') node.className = v;
		else if (k === 'text') node.textContent = v;
		else if (k.startsWith('data-') || k === 'href' || k === 'type' || k === 'target' || k === 'rel' || k === 'aria-pressed' || k === 'aria-label' || k === 'value' || k === 'hidden')
			node.setAttribute(k, v);
		else node[k] = v;
	}
	for (const c of [].concat(children)) {
		if (c == null) continue;
		node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
	}
	return node;
}

function icon(path, size = 13) {
	const ns = 'http://www.w3.org/2000/svg';
	const svg = document.createElementNS(ns, 'svg');
	svg.setAttribute('width', size);
	svg.setAttribute('height', size);
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('fill', 'none');
	svg.setAttribute('stroke', 'currentColor');
	svg.setAttribute('stroke-width', '2');
	svg.setAttribute('stroke-linecap', 'round');
	svg.setAttribute('stroke-linejoin', 'round');
	const p = document.createElementNS(ns, 'path');
	p.setAttribute('d', path);
	svg.appendChild(p);
	return svg;
}

const ICONS = {
	external: 'M15 3h6v6 M10 14 21 3 M21 14v7H3V3h7',
	arrow: 'M5 12h14 M13 5l7 7-7 7',
	doc: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6',
	cube: 'M21 16V8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z M3.3 7 12 12l8.7-5 M12 22V12',
};

// ── State, synced to the URL ─────────────────────────────────────────────────
const state = {
	q: '',
	family: '',
	integration: '',
	sort: 'family',
	commercialOnly: false,
};

function readUrl() {
	const p = new URLSearchParams(location.search);
	state.q = p.get('q') || '';
	state.family = p.get('family') || '';
	state.integration = p.get('int') || '';
	state.sort = p.get('sort') || 'family';
	state.commercialOnly = p.get('commercial') === '1';
}

function writeUrl() {
	const p = new URLSearchParams();
	if (state.q) p.set('q', state.q);
	if (state.family) p.set('family', state.family);
	if (state.integration) p.set('int', state.integration);
	if (state.sort && state.sort !== 'family') p.set('sort', state.sort);
	if (state.commercialOnly) p.set('commercial', '1');
	const qs = p.toString();
	history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
}

// ── Filtering + sorting (pure) ───────────────────────────────────────────────
function matches(engine) {
	if (state.family && engine.family !== state.family) return false;
	if (state.integration && engine.integration !== state.integration) return false;
	if (state.commercialOnly && !engine.commercial) return false;
	if (state.q) {
		const hay = `${engine.name} ${engine.org} ${engine.blurb} ${engine.input} ${engine.output} ${engine.license} ${engine.venue}`.toLowerCase();
		if (!hay.includes(state.q.toLowerCase())) return false;
	}
	return true;
}

function sortEngines(list) {
	const copy = list.slice();
	if (state.sort === 'name') copy.sort((a, b) => a.name.localeCompare(b.name));
	else if (state.sort === 'newest') copy.sort((a, b) => b.year - a.year || a.name.localeCompare(b.name));
	return copy;
}

// ── Card render ──────────────────────────────────────────────────────────────
function linkBtn(href, label, { primary = false, external = true } = {}) {
	const isInternal = href.startsWith('/');
	const attrs = {
		class: `ae-btn${primary ? ' ae-btn--primary' : ''}`,
		href,
	};
	if (!isInternal && external) {
		attrs.target = '_blank';
		attrs.rel = 'noopener noreferrer';
	}
	return el('a', attrs, [
		label,
		isInternal ? icon(ICONS.arrow, 12) : icon(ICONS.external, 12),
	]);
}

function card(engine) {
	const rep = REPRESENTATIONS[engine.representation];
	const integ = INTEGRATIONS[engine.integration];

	const heading = el('h3', { text: engine.name });
	if (isRetired(engine)) {
		heading.appendChild(el('span', { class: 'ae-retired', title: 'This project or service no longer operates' }, 'Retired'));
	}

	const top = el('div', { class: 'ae-card-top' }, [
		el('div', {}, [
			heading,
			el('p', { class: 'ae-org', text: `${engine.org} · ${engine.year}` }),
		]),
		el('span', { class: 'ae-rep', 'data-rep': engine.representation, title: rep?.note || '' }, rep?.label || engine.representation),
	]);

	const meta = el('dl', { class: 'ae-meta' }, [
		el('dt', { text: 'Input' }), el('dd', { text: engine.input }),
		el('dt', { text: 'Output' }), el('dd', { text: engine.output }),
		el('dt', { text: 'Runs on' }), el('dd', { text: engine.compute }),
		el('dt', { text: 'Venue' }), el('dd', { text: engine.venue }),
	]);

	const tags = el('div', { class: 'ae-tags' }, [
		el('span', { class: `ae-tag ${engine.commercial ? 'ae-tag--ok' : 'ae-tag--no'}` }, [
			el('span', { class: 'ae-tdot' }),
			engine.commercial ? 'Commercial-use OK' : 'Non-commercial',
		]),
		el('span', { class: 'ae-tag', title: 'License' }, engine.license),
	]);

	const integBox = el('div', { class: 'ae-int' }, [
		el('span', { class: 'ae-int-badge', 'data-tone': integ?.tone || 'reference', text: integ?.label || 'Reference' }),
		el('span', { text: engine.integrationNote }),
	]);

	// Actions: primary CTA (forge/splat/live deep-link) then repo / paper.
	const actions = el('div', { class: 'ae-actions' });
	if (engine.cta) {
		actions.appendChild(linkBtn(engine.cta.href, engine.cta.label, { primary: true }));
	} else if (engine.integration === 'splat') {
		actions.appendChild(linkBtn('/splat', 'Open Splat Viewer', { primary: true }));
	}
	if (engine.links?.repo) actions.appendChild(linkBtn(engine.links.repo, repoLabel(engine.links.repo)));
	if (engine.links?.paper && engine.links.paper !== engine.links.repo)
		actions.appendChild(linkBtn(engine.links.paper, 'Paper'));
	if (engine.links?.docs && engine.links.docs !== engine.links.repo)
		actions.appendChild(linkBtn(engine.links.docs, 'Docs'));
	if (engine.links?.demo && engine.links.demo !== engine.cta?.href && !engine.links.demo.startsWith('/') && engine.links.demo !== engine.links.repo && engine.links.demo !== engine.links.paper)
		actions.appendChild(linkBtn(engine.links.demo, 'Demo'));

	return el('article', { class: 'ae-card', 'data-id': engine.id, 'data-status': isRetired(engine) ? 'retired' : 'active' }, [
		top,
		el('p', { class: 'ae-blurb', text: engine.blurb }),
		meta,
		tags,
		integBox,
		actions,
	]);
}

function repoLabel(url) {
	if (url.includes('github.com')) return 'GitHub';
	if (url.includes('huggingface.co')) return 'Hugging Face';
	return 'Project';
}

// ── Render ───────────────────────────────────────────────────────────────────
function renderStats() {
	const s = engineStats();
	const host = $('#ae-stats');
	host.innerHTML = '';
	const items = [
		[s.total, 'engines'],
		[s.families, 'families'],
		[s.live, 'live in three.ws'],
		[s.commercial, 'commercial-use'],
	];
	// A <dl> of label/value pairs: the numbers are content, not decoration, so a
	// screen reader gets "engines, 24" rather than a bare unlabelled digit.
	for (const [n, l] of items) {
		host.appendChild(el('div', { class: 'ae-stat' }, [
			el('dt', { class: 'ae-stat-l', text: l }),
			el('dd', { class: 'ae-stat-n', text: String(n) }),
		]));
	}
}

function renderFamilyOptions() {
	const sel = $('#ae-family');
	for (const f of FAMILIES) sel.appendChild(el('option', { value: f.id, text: f.label }));
}

function render() {
	const results = $('#ae-results');
	const empty = $('#ae-empty');
	const count = $('#ae-count');
	results.innerHTML = '';

	const filtered = ENGINES.filter(matches);
	count.textContent = `${filtered.length} of ${ENGINES.length} engine${ENGINES.length === 1 ? '' : 's'}`;

	if (filtered.length === 0) {
		empty.hidden = false;
		return;
	}
	empty.hidden = true;

	// Grouped by family unless an explicit sort is chosen.
	if (state.sort === 'family' && !state.family) {
		for (const fam of FAMILIES) {
			const group = filtered.filter((e) => e.family === fam.id);
			if (!group.length) continue;
			const section = el('section', { class: 'ae-family' }, [
				el('div', { class: 'ae-family-head' }, [el('h2', { text: fam.label }), el('p', { text: fam.blurb })]),
				el('div', { class: 'ae-grid' }, group.map(card)),
			]);
			results.appendChild(section);
		}
	} else {
		const sorted = sortEngines(filtered);
		results.appendChild(el('div', { class: 'ae-grid' }, sorted.map(card)));
	}
}

function syncControls() {
	$('#ae-search').value = state.q;
	$('#ae-family').value = state.family;
	$('#ae-integration').value = state.integration;
	$('#ae-sort').value = state.sort;
	const t = $('#ae-commercial');
	t.setAttribute('aria-pressed', String(state.commercialOnly));
}

function apply() {
	writeUrl();
	render();
}

let _searchTimer = null;

function init() {
	if (!$('#ae-results')) return;
	// The pre-hydration skeleton stays until real cards exist; the inline
	// watchdog in the page turns it into an error state if we never get here.
	const boot = $('#ae-boot');
	if (boot) boot.hidden = true;
	document.documentElement.setAttribute('data-ae', 'ready');
	readUrl();
	renderStats();
	renderFamilyOptions();
	syncControls();
	render();

	$('#ae-search').addEventListener('input', (e) => {
		state.q = e.target.value;
		clearTimeout(_searchTimer);
		_searchTimer = setTimeout(apply, 120);
	});
	$('#ae-family').addEventListener('change', (e) => { state.family = e.target.value; apply(); });
	$('#ae-integration').addEventListener('change', (e) => { state.integration = e.target.value; apply(); });
	$('#ae-sort').addEventListener('change', (e) => { state.sort = e.target.value; apply(); });
	$('#ae-commercial').addEventListener('click', () => {
		state.commercialOnly = !state.commercialOnly;
		$('#ae-commercial').setAttribute('aria-pressed', String(state.commercialOnly));
		apply();
	});
	$('#ae-reset').addEventListener('click', () => {
		Object.assign(state, { q: '', family: '', integration: '', sort: 'family', commercialOnly: false });
		syncControls();
		apply();
	});
}

// The registry is the entire page. A throw anywhere in the render would leave a
// hero above an empty void, so failure has to surface as the designed error
// state rather than as a silent blank.
function bootstrap() {
	try {
		init();
	} catch (err) {
		const boot = $('#ae-boot');
		const error = $('#ae-error');
		if (boot) boot.hidden = true;
		if (error) error.hidden = false;
		console.error('[avatar-engines] registry render failed', err);
	}
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootstrap);
else bootstrap();
