/**
 * /spotlight — Agent Spotlight, the three.ws community showcase.
 *
 * One controller, three jobs: browse (sort + category + search + paging), vote,
 * and submit. State is a single `view` object that the URL mirrors, so every
 * filter combination is a shareable link and the back button works; the grid is
 * re-fetched from that object rather than mutated in place, which keeps the
 * "what am I looking at" question answerable from one value.
 *
 * A card's headline links to the ENTRY (/spotlight/:id), not the agent. The
 * write-up is the thing a showcase exists to publish, and burying it behind a
 * clamped three-line preview with no way to open it was the difference between a
 * showcase and a directory. Every card still carries direct links to the agent
 * itself in its footer.
 *
 * The 3D stage on the featured entry is deliberately lazy: <agent-3d> is a
 * WebGL component and this is a browse surface, so the loader script is only
 * injected once a featured entry with a public GLB actually scrolls into view.
 * Everything below the fold renders from thumbnails.
 */

import { apiFetch } from './api.js';
import {
	buildFields,
	fillCategories,
	readValues,
	saveEntry,
	validate,
} from './spotlight-form.js';
import { entryPath, errorMessage, monogram, relativeTime, stageFor, voteButton } from './spotlight-shared.js';

const PAGE_SIZE = 24;

const els = {
	grid: document.getElementById('sp-grid'),
	state: document.getElementById('sp-state'),
	stats: document.getElementById('sp-stats'),
	cats: document.getElementById('sp-cats'),
	more: document.getElementById('sp-more'),
	search: document.getElementById('sp-q'),
	sorts: Array.from(document.querySelectorAll('.sp-sort')),
	featured: document.getElementById('sp-featured'),
	featuredBody: document.getElementById('sp-featured-body'),
	panel: document.getElementById('sp-submit-panel'),
	panelToggle: document.getElementById('sp-submit-toggle'),
	panelAuth: document.getElementById('sp-submit-auth'),
	fields: document.getElementById('sp-fields'),
	cancel: document.getElementById('sp-cancel'),
	submit: document.getElementById('sp-submit'),
	formNote: document.getElementById('sp-form-note'),
	live: document.getElementById('sp-live'),
};

const view = { sort: 'trending', category: null, tag: null, q: '', offset: 0 };

let total = 0;
let categories = [];
let totals = { entries: 0, builders: 0, votes: 0 };
let loadToken = 0;
let formRefs = null;

/* ── url state ────────────────────────────────────────────────────────── */

function readUrl() {
	const p = new URLSearchParams(location.search);
	const sort = p.get('sort');
	if (sort === 'new' || sort === 'top' || sort === 'trending') view.sort = sort;
	view.category = p.get('category') || null;
	view.tag = p.get('tag') || null;
	view.q = p.get('q') || '';
	if (els.search) els.search.value = view.q;
}

function writeUrl({ replace = false } = {}) {
	const p = new URLSearchParams();
	if (view.sort !== 'trending') p.set('sort', view.sort);
	if (view.category) p.set('category', view.category);
	if (view.tag) p.set('tag', view.tag);
	if (view.q) p.set('q', view.q);
	const url = p.toString() ? `${location.pathname}?${p}` : location.pathname;
	history[replace ? 'replaceState' : 'pushState']({ ...view }, '', url);
}

/* ── small helpers ────────────────────────────────────────────────────── */

function el(tag, props = {}, children = []) {
	const node = document.createElement(tag);
	for (const [k, v] of Object.entries(props)) {
		if (v == null || v === false) continue;
		if (k === 'class') node.className = v;
		else if (k === 'text') node.textContent = v;
		else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
		else node.setAttribute(k, v === true ? '' : String(v));
	}
	for (const child of [].concat(children)) {
		if (child != null) node.append(child);
	}
	return node;
}

function announce(message) {
	if (els.live) els.live.textContent = message;
}

function plural(n, one, many) {
	return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

function categoryLabel(slug) {
	return categories.find((c) => c.slug === slug)?.label || slug;
}

function onVoted(entry) {
	totals.votes += entry.voted_by_me ? 1 : -1;
	renderStats();
}

/* ── featured ─────────────────────────────────────────────────────────── */

function renderFeatured(entries) {
	if (!entries.length) {
		els.featured.hidden = true;
		els.featuredBody.replaceChildren();
		return;
	}
	const entry = entries[0];
	const copy = el('div', { class: 'sp-featured-copy' }, [
		el('h3', {}, [el('a', { href: entryPath(entry), text: entry.title })]),
		el('p', { text: entry.tagline }),
		entry.story ? el('p', { class: 'sp-featured-story', text: entry.story }) : null,
		el('div', { class: 'sp-card-meta' }, metaBits(entry)),
		el('div', { class: 'sp-ctas' }, [
			el('a', { class: 'sp-btn sp-btn-primary', href: entryPath(entry), text: 'Read the write-up' }),
			el('a', { class: 'sp-btn', href: `/agents/${entry.agent.id}`, text: `Open ${entry.agent.name}` }),
			voteButton(entry, { announce, onVoted }),
		]),
	]);

	els.featuredBody.replaceChildren(stageFor(entry, { badge: "Editor's pick" }), copy);
	els.featured.hidden = false;
}

/* ── cards ────────────────────────────────────────────────────────────── */

function metaBits(entry) {
	const bits = [el('span', {}, [el('strong', { text: entry.agent.name })])];
	if (entry.builder?.name) {
		bits.push(el('span', { 'aria-hidden': 'true', text: '·' }));
		bits.push(
			entry.builder.profile_url
				? el('a', { href: entry.builder.profile_url, text: `by ${entry.builder.name}` })
				: el('span', { text: `by ${entry.builder.name}` }),
		);
	}
	if (entry.agent.chat_count > 0) {
		bits.push(el('span', { 'aria-hidden': 'true', text: '·' }));
		bits.push(el('span', { text: plural(entry.agent.chat_count, 'conversation', 'conversations') }));
	} else if (entry.agent.action_count > 0) {
		bits.push(el('span', { 'aria-hidden': 'true', text: '·' }));
		bits.push(el('span', { text: plural(entry.agent.action_count, 'action', 'actions') }));
	}
	bits.push(el('span', { 'aria-hidden': 'true', text: '·' }));
	bits.push(el('span', { text: relativeTime(entry.created_at) }));
	return bits;
}

function cardFor(entry) {
	const art = el('div', { class: 'sp-card-art' });
	art.append(
		entry.agent.thumbnail
			? el('img', {
					src: entry.agent.thumbnail,
					alt: `${entry.agent.name} avatar`,
					loading: 'lazy',
					decoding: 'async',
				})
			: monogram(entry.agent),
	);
	art.append(
		el('div', { class: 'sp-card-badges' }, [
			el('span', { class: 'sp-badge', text: categoryLabel(entry.category) }),
			entry.agent.is_registered ? el('span', { class: 'sp-badge sp-badge-onchain', text: 'On-chain' }) : null,
			entry.source === 'curated' ? el('span', { class: 'sp-badge sp-badge-curated', text: 'Curated' }) : null,
		]),
	);

	const tags = entry.tags.length
		? el(
				'div',
				{ class: 'sp-tags' },
				entry.tags.map((t) =>
					el('button', {
						type: 'button',
						class: 'sp-tag',
						text: `#${t}`,
						onclick: (event) => {
							event.preventDefault();
							event.stopPropagation();
							view.tag = view.tag === t ? null : t;
							view.offset = 0;
							writeUrl();
							load();
						},
					}),
				),
			)
		: null;

	const body = el('div', { class: 'sp-card-body' }, [
		el('h3', { class: 'sp-card-title' }, [el('a', { href: entryPath(entry), text: entry.title })]),
		el('p', { class: 'sp-card-tagline', text: entry.tagline }),
		el('div', { class: 'sp-card-meta' }, metaBits(entry)),
		tags,
	]);

	const links = el('div', { class: 'sp-card-links' }, [
		el('a', { href: `/agents/${entry.agent.id}`, text: 'Open agent' }),
		entry.demo_url
			? el('a', { href: entry.demo_url, target: '_blank', rel: 'noopener nofollow ugc', text: 'Demo' })
			: null,
		// Only an owner sees this, and it goes to the entry page where the edit
		// form lives, so there is exactly one place an entry is written.
		entry.editable_by_me ? el('a', { href: `${entryPath(entry)}?edit=1`, text: 'Edit' }) : null,
	]);

	return el('article', { class: 'sp-card' }, [
		art,
		body,
		el('div', { class: 'sp-card-foot' }, [links, voteButton(entry, { announce, onVoted })]),
	]);
}

/* ── loading ──────────────────────────────────────────────────────────── */

function skeletons(n = 6) {
	els.grid.replaceChildren(...Array.from({ length: n }, () => el('div', { class: 'sp-skeleton' })));
}

function renderEmpty() {
	const filtered = Boolean(view.q || view.category || view.tag);
	const box = el('div', { class: 'sp-empty' }, [
		el('h3', { text: filtered ? 'Nothing matches that yet' : 'The spotlight is open' }),
		el('p', {
			text: filtered
				? 'No showcased agent matches this filter. Clear it to see everything the community has published.'
				: 'No one has claimed the first slot. Build an agent, make it public, and write up what it does: the first entry gets the featured stage.',
		}),
	]);
	box.append(
		filtered
			? el('button', {
					type: 'button',
					class: 'sp-btn sp-btn-primary',
					text: 'Clear filters',
					onclick: () => {
						view.q = '';
						view.category = null;
						view.tag = null;
						view.offset = 0;
						if (els.search) els.search.value = '';
						writeUrl();
						renderCategories();
						load();
					},
				})
			: el('button', {
					type: 'button',
					class: 'sp-btn sp-btn-primary',
					text: 'Showcase your agent',
					onclick: () => openPanel(true),
				}),
	);
	if (!filtered) box.append(el('a', { class: 'sp-btn', href: '/create-agent', text: 'Create an agent first' }));
	els.state.replaceChildren(box);
}

function renderError(message) {
	els.state.replaceChildren(
		el('div', { class: 'sp-error' }, [
			el('h3', { text: 'The showcase did not load' }),
			el('p', { text: message }),
			el('button', { type: 'button', class: 'sp-btn sp-btn-primary', text: 'Try again', onclick: () => load() }),
		]),
	);
}

async function load({ append = false } = {}) {
	const token = ++loadToken;
	if (!append) {
		skeletons();
		els.state.replaceChildren();
		els.grid.setAttribute('aria-busy', 'true');
		els.more.hidden = true;
	} else {
		els.more.disabled = true;
		els.more.textContent = 'Loading…';
	}

	const p = new URLSearchParams({ sort: view.sort, limit: String(PAGE_SIZE), offset: String(view.offset) });
	if (view.category) p.set('category', view.category);
	if (view.tag) p.set('tag', view.tag);
	if (view.q) p.set('q', view.q);

	try {
		const res = await apiFetch(`/api/spotlight/list?${p}`, { allowAnonymous: true });
		if (token !== loadToken) return;
		if (res.status === 503) {
			els.grid.replaceChildren();
			renderEmpty();
			return;
		}
		const data = await res.json().catch(() => null);
		if (!res.ok) throw new Error(errorMessage(data, `the showcase returned ${res.status}`));

		const entries = Array.isArray(data.entries) ? data.entries : [];
		total = Number(data.total) || 0;

		if (append) {
			els.grid.append(...entries.map(cardFor));
		} else {
			els.grid.replaceChildren(...entries.map(cardFor));
			if (!entries.length) renderEmpty();
			else els.state.replaceChildren();
		}

		els.more.hidden = !data.has_more;
		els.more.disabled = false;
		els.more.textContent = 'Load more';
		view.offset = data.next_offset ?? view.offset;
		announce(`${plural(total, 'showcased agent', 'showcased agents')}, sorted by ${view.sort}.`);
	} catch (err) {
		if (token !== loadToken) return;
		els.grid.replaceChildren();
		renderError(err?.message || 'could not reach the showcase');
	} finally {
		if (token === loadToken) els.grid.setAttribute('aria-busy', 'false');
	}
}

function renderStats() {
	if (!totals.entries) {
		els.stats.replaceChildren();
		return;
	}
	const stat = (value, label) => el('div', {}, [el('dd', { text: value.toLocaleString() }), el('dt', { text: label })]);
	els.stats.replaceChildren(
		stat(totals.entries, totals.entries === 1 ? 'agent showcased' : 'agents showcased'),
		stat(totals.builders, totals.builders === 1 ? 'builder' : 'builders'),
		stat(totals.votes, totals.votes === 1 ? 'upvote' : 'upvotes'),
	);
}

/* ── featured rail + categories ───────────────────────────────────────── */

async function loadFeatured() {
	try {
		const res = await apiFetch('/api/spotlight/list?featured=1&limit=1&sort=trending', { allowAnonymous: true });
		if (!res.ok) return;
		const data = await res.json().catch(() => null);
		renderFeatured(Array.isArray(data?.entries) ? data.entries : []);
	} catch {
		// A missing featured rail is not worth an error state: the grid below it
		// is the page. Fail silently and leave the section hidden.
	}
}

function renderCategories() {
	els.cats.replaceChildren(
		el('button', {
			type: 'button',
			class: 'sp-cat',
			'aria-pressed': String(!view.category),
			text: 'All',
			onclick: () => selectCategory(null),
		}),
		...categories
			.filter((c) => c.count > 0 || c.slug === view.category)
			.map((c) =>
				el(
					'button',
					{
						type: 'button',
						class: 'sp-cat',
						'aria-pressed': String(view.category === c.slug),
						onclick: () => selectCategory(c.slug),
					},
					[el('span', { text: c.label }), el('span', { class: 'sp-cat-count', text: String(c.count) })],
				),
			),
	);
}

function selectCategory(slug) {
	view.category = view.category === slug ? null : slug;
	view.offset = 0;
	writeUrl();
	renderCategories();
	load();
}

async function loadCategories() {
	try {
		const res = await apiFetch('/api/spotlight/categories', { allowAnonymous: true });
		if (!res.ok) return;
		const data = await res.json().catch(() => null);
		categories = Array.isArray(data?.categories) ? data.categories : [];
		if (data?.totals) totals = data.totals;
		renderCategories();
		renderStats();
		if (formRefs) fillCategories(formRefs, categories);
	} catch {
		categories = [];
	}
}

/* ── submission ───────────────────────────────────────────────────────── */

let eligibleLoaded = false;

function openPanel(open) {
	els.panel.hidden = !open;
	els.panelToggle.setAttribute('aria-expanded', String(open));
	if (!open) return;
	els.panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
	if (!eligibleLoaded) loadEligible();
}

async function loadEligible() {
	eligibleLoaded = true;
	formRefs.agentSelect.replaceChildren(new Option('Loading your agents…', ''));
	try {
		const res = await apiFetch('/api/spotlight/eligible', { allowAnonymous: true });
		if (res.status === 401) {
			eligibleLoaded = false;
			showPanelAuth();
			return;
		}
		const data = await res.json().catch(() => null);
		if (!res.ok) throw new Error(errorMessage(data, 'could not load your agents'));

		if (Array.isArray(data.categories) && data.categories.length && !categories.length) {
			categories = data.categories.map((c) => ({ ...c, count: 0 }));
			renderCategories();
		}
		fillCategories(formRefs, categories);

		const agents = Array.isArray(data.agents) ? data.agents : [];
		if (!agents.length) {
			formRefs.agentSelect.replaceChildren(new Option('No eligible agents', ''));
			formRefs.agentSelect.disabled = true;
			els.submit.disabled = true;
			formRefs.agentHint.replaceChildren(
				document.createTextNode(
					'Every public agent you own is already showcased, or you have not made one yet. ',
				),
				el('a', { href: '/create-agent', text: 'Create an agent' }),
				document.createTextNode('.'),
			);
			return;
		}
		formRefs.agentSelect.disabled = false;
		els.submit.disabled = false;
		formRefs.agentSelect.replaceChildren(
			new Option('Choose an agent…', ''),
			...agents.map((a) => new Option(a.name, a.id)),
		);
		formRefs.agentHint.textContent = `${plural(agents.length, 'agent', 'agents')} you can showcase. Only public agents are listed.`;

		// Pre-fill the one-liner from the agent's own description: the builder
		// already wrote it once, and an empty field is the main reason a
		// submission gets abandoned halfway.
		formRefs.agentSelect.addEventListener('change', () => {
			const chosen = agents.find((a) => a.id === formRefs.agentSelect.value);
			if (chosen?.description && !formRefs.tagline.value.trim()) {
				formRefs.tagline.value = chosen.description.replace(/\s+/g, ' ').trim().slice(0, 160);
				formRefs.tagline.dispatchEvent(new Event('input'));
			}
		});
	} catch (err) {
		eligibleLoaded = false;
		formRefs.agentSelect.replaceChildren(new Option('Could not load your agents', ''));
		setNote(err?.message || 'could not load your agents', 'error');
	}
}

function showPanelAuth() {
	els.panelAuth.hidden = false;
	els.panelAuth.replaceChildren(
		el('span', { text: 'Sign in to put one of your agents in the spotlight.' }),
		el('a', {
			class: 'sp-btn sp-btn-sm sp-btn-primary',
			href: `/login?next=${encodeURIComponent(location.pathname + location.search)}`,
			text: 'Sign in',
		}),
		el('a', { class: 'sp-btn sp-btn-sm', href: '/register', text: 'Create an account' }),
	);
	formRefs.agentSelect.replaceChildren(new Option('Sign in first', ''));
	formRefs.agentSelect.disabled = true;
	els.submit.disabled = true;
}

function setNote(message, tone) {
	els.formNote.textContent = message;
	if (tone) els.formNote.dataset.tone = tone;
	else delete els.formNote.dataset.tone;
}

async function onSubmit(event) {
	event.preventDefault();
	const payload = readValues(formRefs);
	const problem = validate(payload);
	if (problem) return setNote(problem, 'error');

	els.submit.disabled = true;
	setNote('Publishing…');
	try {
		const entry = await saveEntry(payload);
		setNote('Published. Taking you to your entry…', 'success');
		announce(`${payload.title} is now in the showcase.`);
		location.href = entryPath(entry);
	} catch (err) {
		if (err.unauthorized) {
			showPanelAuth();
			setNote('sign in to publish', 'error');
			return;
		}
		setNote(err?.message || 'the submission did not go through', 'error');
	} finally {
		els.submit.disabled = false;
	}
}

/* ── wiring ───────────────────────────────────────────────────────────── */

function syncSortButtons() {
	for (const btn of els.sorts) {
		const active = btn.dataset.sort === view.sort;
		btn.classList.toggle('is-active', active);
		btn.setAttribute('aria-selected', String(active));
	}
}

function wire() {
	formRefs = buildFields(els.fields, { prefix: 'sp', withAgentPicker: true });

	for (const btn of els.sorts) {
		btn.addEventListener('click', () => {
			if (view.sort === btn.dataset.sort) return;
			view.sort = btn.dataset.sort;
			view.offset = 0;
			syncSortButtons();
			writeUrl();
			load();
		});
	}

	let searchTimer;
	els.search.addEventListener('input', () => {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => {
			const next = els.search.value.trim();
			if (next === view.q) return;
			view.q = next;
			view.offset = 0;
			writeUrl({ replace: true });
			load();
		}, 260);
	});

	els.more.addEventListener('click', () => load({ append: true }));
	els.panelToggle.addEventListener('click', () => openPanel(els.panel.hidden));
	els.cancel.addEventListener('click', () => openPanel(false));
	els.panel.addEventListener('submit', onSubmit);

	// `/` focuses search from anywhere on the page, the same shortcut the rest of
	// the site uses; Escape closes the submission panel.
	document.addEventListener('keydown', (event) => {
		if (event.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) {
			event.preventDefault();
			els.search.focus();
			els.search.select();
		} else if (event.key === 'Escape' && !els.panel.hidden) {
			openPanel(false);
			els.panelToggle.focus();
		}
	});

	window.addEventListener('popstate', () => {
		readUrl();
		view.offset = 0;
		syncSortButtons();
		renderCategories();
		load();
	});

	// Deep link from a card's "Edit" affordance or an empty state.
	if (new URLSearchParams(location.search).get('submit') === '1') openPanel(true);
}

readUrl();
syncSortButtons();
wire();
load();
loadCategories();
loadFeatured();
