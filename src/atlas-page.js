/**
 * /atlas: the whole platform as one page.
 *
 * The Cmd+K palette (public/atlas.js) is for people who know roughly what they
 * want. This page is for the other case: someone who wants to see what the
 * product actually contains. 600+ routes is too many to list flat and hope, so
 * the page browses by section by default, collapses to a single ranked list the
 * moment you type, and puts the curated task shortcuts above both.
 *
 * It reads the exact same generated index and the exact same ranking module as
 * the palette, so a result can never be reachable in one and missing from the
 * other. Search state lives in the URL (?q=), which makes any filtered view a
 * link you can send to someone.
 */
import { rankPages, rankIntents, highlight } from '../public/atlas/score.js';

const INDEX_URL = '/atlas-index.json';

const $q = /** @type {HTMLInputElement} */ (document.getElementById('at-q'));
const $clear = document.getElementById('at-clear');
const $rail = document.getElementById('at-rail');
const $intentsWrap = document.getElementById('at-intents-wrap');
const $intents = document.getElementById('at-intents');
const $intentCount = document.getElementById('at-intent-count');
const $body = document.getElementById('at-body');
const $live = document.getElementById('at-live');

/** @type {{sections:any[],pages:any[][],intents:any[],pageCount:number}|null} */
let index = null;
let frame = 0;

function el(tag, className, text) {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text != null) node.textContent = text;
	return node;
}

/** Paint `text` into `node`, wrapping the matched runs in <mark>. */
function paint(node, text, query) {
	node.textContent = '';
	const runs = query ? highlight(text, query) : [{ t: text, hit: false }];
	for (const run of runs) {
		if (run.hit) node.appendChild(el('mark', null, run.t));
		else node.appendChild(document.createTextNode(run.t));
	}
}

function sectionById(id) {
	return index.sections.find((s) => s.id === id) || { id, title: id, hint: '' };
}

function pageCard(page, query) {
	const card = el('a', 'at-card');
	card.href = page[0];

	const title = el('div', 'at-card-title');
	const name = el('span');
	paint(name, page[1], query);
	title.appendChild(name);
	const path = el('span', 'at-card-path');
	paint(path, page[0], query);
	title.appendChild(path);
	if (page[5] & 1) title.appendChild(el('span', 'at-tag', 'sign-in'));
	card.appendChild(title);

	if (page[2]) {
		const desc = el('div', 'at-card-desc');
		paint(desc, page[2], query);
		card.appendChild(desc);
	}
	return card;
}

function intentCard(intent) {
	const card = el('article', 'at-intent');
	card.appendChild(el('h3', null, intent.title));
	if (intent.blurb) card.appendChild(el('p', null, intent.blurb));

	const ol = el('ol');
	for (const step of intent.steps) {
		const li = el('li');
		if (step.to) {
			const a = el('a', null, step.do);
			a.href = step.to;
			li.appendChild(a);
		} else {
			li.appendChild(document.createTextNode(step.do));
		}
		if (step.note) {
			li.appendChild(document.createTextNode(' '));
			li.appendChild(el('em', null, `(${step.note})`));
		}
		ol.appendChild(li);
	}
	card.appendChild(ol);
	return card;
}

function renderRail(counts) {
	$rail.textContent = '';
	for (const section of index.sections) {
		const n = counts ? counts.get(section.id) || 0 : sectionPages(section.id).length;
		if (n === 0) continue;
		const chip = el('a', 'at-chip');
		chip.href = `#section-${section.id}`;
		chip.appendChild(document.createTextNode(section.title));
		chip.appendChild(el('span', null, String(n)));
		$rail.appendChild(chip);
	}
}

function sectionPages(id) {
	return index.pages.filter((p) => p[3] === id);
}

/** Grouped browse view: every section, every page. */
function renderBrowse() {
	$body.textContent = '';
	renderRail(null);

	for (const section of index.sections) {
		const pages = sectionPages(section.id);
		if (!pages.length) continue;

		const wrap = el('section', 'at-section');
		wrap.id = `section-${section.id}`;

		const head = el('div', 'at-section-head');
		head.appendChild(el('h2', null, section.title));
		head.appendChild(el('span', 'at-count', `${pages.length} ${pages.length === 1 ? 'page' : 'pages'}`));
		if (section.hint) head.appendChild(el('p', null, section.hint));
		wrap.appendChild(head);

		const grid = el('div', 'at-grid');
		// Highest priority first, then alphabetical, so the surfaces that matter
		// lead each section instead of whatever order the route table happens to
		// hold.
		const ordered = pages.slice().sort((a, b) => (b[4] || 0) - (a[4] || 0) || a[1].localeCompare(b[1]));
		for (const page of ordered) grid.appendChild(pageCard(page, ''));
		wrap.appendChild(grid);
		$body.appendChild(wrap);
	}

	$intentsWrap.hidden = false;
	$intents.textContent = '';
	for (const intent of index.intents) $intents.appendChild(intentCard(intent));
	$intentCount.textContent = `${index.intents.length} shortcuts`;

	$live.textContent = `${index.pageCount} pages across ${index.sections.length} sections.`;
	watchSections();
}

/** Filtered view: one ranked list, grouped by section so the result keeps context. */
function renderSearch(query) {
	const matches = rankPages(query, index.pages, { limit: 400 });
	const intents = rankIntents(query, index.intents, { limit: 4 });

	$intents.textContent = '';
	if (intents.length) {
		for (const { intent } of intents) $intents.appendChild(intentCard(intent));
		$intentCount.textContent = `${intents.length} matching`;
		$intentsWrap.hidden = false;
	} else {
		$intentsWrap.hidden = true;
	}

	$body.textContent = '';

	if (!matches.length) {
		if (!intents.length) {
			const state = el('div', 'at-state');
			state.appendChild(el('strong', null, `No page matches "${query}"`));
			state.appendChild(
				document.createTextNode('Try a single shorter word. Every page is listed when the box is empty.'),
			);
			$body.appendChild(state);
		}
		$rail.textContent = '';
		$live.textContent = intents.length
			? `No pages match "${query}", but ${intents.length} task shortcut${intents.length === 1 ? '' : 's'} do.`
			: `No results for "${query}".`;
		return;
	}

	const grouped = new Map();
	for (const { page } of matches) {
		if (!grouped.has(page[3])) grouped.set(page[3], []);
		grouped.get(page[3]).push(page);
	}
	renderRail(new Map([...grouped].map(([id, list]) => [id, list.length])));

	// Section order follows the best-ranked hit in each section, so the section
	// holding the strongest match leads.
	for (const [id, pages] of grouped) {
		const section = sectionById(id);
		const wrap = el('section', 'at-section');
		wrap.id = `section-${id}`;
		const head = el('div', 'at-section-head');
		head.appendChild(el('h2', null, section.title));
		head.appendChild(el('span', 'at-count', `${pages.length} ${pages.length === 1 ? 'match' : 'matches'}`));
		wrap.appendChild(head);
		const grid = el('div', 'at-grid');
		for (const page of pages) grid.appendChild(pageCard(page, query));
		wrap.appendChild(grid);
		$body.appendChild(wrap);
	}

	$live.textContent = `${matches.length} page${matches.length === 1 ? '' : 's'} match "${query}".`;
}

function render() {
	if (!index) return;
	const query = $q.value.trim();
	$clear.hidden = query.length === 0;
	if (query) renderSearch(query);
	else renderBrowse();
}

/** Mark the section chip for whatever is on screen. Browse view only. */
let observer = null;
function watchSections() {
	if (observer) observer.disconnect();
	if (!('IntersectionObserver' in window)) return;
	const visible = new Set();
	observer = new IntersectionObserver(
		(entries) => {
			for (const entry of entries) {
				if (entry.isIntersecting) visible.add(entry.target.id);
				else visible.delete(entry.target.id);
			}
			for (const chip of $rail.querySelectorAll('.at-chip')) {
				const id = chip.getAttribute('href').slice(1);
				chip.setAttribute('aria-current', visible.has(id) ? 'true' : 'false');
			}
		},
		{ rootMargin: '-72px 0px -70% 0px' },
	);
	for (const section of $body.querySelectorAll('.at-section')) observer.observe(section);
}

function syncUrl() {
	const query = $q.value.trim();
	const url = new URL(location.href);
	if (query) url.searchParams.set('q', query);
	else url.searchParams.delete('q');
	history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}

$q.addEventListener('input', () => {
	// One render per frame. Ranking 633 pages is sub-millisecond, but a
	// keystroke-per-render still forces layout on a 600-node list.
	cancelAnimationFrame(frame);
	frame = requestAnimationFrame(() => {
		render();
		syncUrl();
	});
});

$q.addEventListener('keydown', (e) => {
	if (e.key === 'Escape' && $q.value) {
		e.preventDefault();
		$q.value = '';
		render();
		syncUrl();
	}
});

$clear.addEventListener('click', () => {
	$q.value = '';
	$q.focus();
	render();
	syncUrl();
});

fetch(INDEX_URL, { credentials: 'omit' })
	.then((r) => {
		if (!r.ok) throw new Error(`atlas index ${r.status}`);
		return r.json();
	})
	.then((data) => {
		index = data;
		$q.value = new URL(location.href).searchParams.get('q') || '';
		render();
		// Deep link to a section survives the async render.
		if (location.hash.startsWith('#section-')) {
			document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: 'start' });
		}
	})
	.catch(() => {
		$body.textContent = '';
		const state = el('div', 'at-state');
		state.appendChild(el('strong', null, 'The map did not load'));
		state.appendChild(document.createTextNode('The route index is unavailable right now. '));
		const link = el('a', null, 'The sitemap');
		link.href = '/sitemap';
		state.appendChild(link);
		state.appendChild(document.createTextNode(' lists every page and does not depend on it.'));
		$body.appendChild(state);
		$live.textContent = 'The route index failed to load.';
	});
