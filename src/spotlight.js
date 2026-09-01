/**
 * /spotlight: Agent Spotlight, the three.ws community showcase.
 *
 * One controller, three jobs: browse (sort + category + search + paging), vote,
 * and submit. State is a single `view` object that the URL mirrors, so every
 * filter combination is a shareable link and the back button works; the grid is
 * re-fetched from that object rather than mutated in place, which keeps the
 * "what am I looking at" question answerable from one value.
 *
 * The 3D stage on the featured entry is deliberately lazy: <agent-3d> is a
 * WebGL component and the showcase is a browse surface, so the loader script is
 * only injected once a featured entry with a public GLB actually scrolls into
 * view. Everything below the fold renders from thumbnails.
 */

import { apiFetch } from './api.js';

const AGENT_3D_LOADER = 'https://three.ws/agent-3d/latest/agent-3d.js';
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
	agentSelect: document.getElementById('sp-agent'),
	agentHint: document.getElementById('sp-agent-hint'),
	categorySelect: document.getElementById('sp-category'),
	cancel: document.getElementById('sp-cancel'),
	submit: document.getElementById('sp-submit'),
	formNote: document.getElementById('sp-form-note'),
	live: document.getElementById('sp-live'),
};

const view = {
	sort: 'trending',
	category: null,
	tag: null,
	q: '',
	offset: 0,
};

let total = 0;
let categories = [];
let totals = { entries: 0, builders: 0, votes: 0 };
let loadToken = 0;

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
		if (child == null) continue;
		node.append(child);
	}
	return node;
}

function announce(message) {
	if (els.live) els.live.textContent = message;
}

function plural(n, one, many) {
	return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

function relativeTime(iso) {
	const then = new Date(iso).getTime();
	if (!Number.isFinite(then)) return '';
	const mins = Math.round((Date.now() - then) / 60000);
	if (mins < 1) return 'just now';
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.round(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.round(hours / 24);
	if (days < 30) return `${days}d ago`;
	return new Date(then).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

// Deterministic hue from the agent id: the same agent keeps the same monogram
// colour on every card, in every session, without storing anything.
function hueOf(id) {
	let h = 0;
	for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
	return h;
}

function monogram(agent) {
	const hue = hueOf(agent.id || agent.name || 'agent');
	const initials = (agent.name || '?')
		.split(/\s+/)
		.slice(0, 2)
		.map((w) => w[0])
		.join('')
		.toUpperCase();
	const node = el('div', { class: 'sp-mono', 'aria-hidden': 'true', text: initials });
	node.style.background = `linear-gradient(140deg, hsl(${hue} 62% 26%), hsl(${(hue + 48) % 360} 55% 14%))`;
	return node;
}

function categoryLabel(slug) {
	return categories.find((c) => c.slug === slug)?.label || slug;
}

/* ── the featured stage ───────────────────────────────────────────────── */

let agent3dRequested = false;
function loadAgent3d() {
	if (agent3dRequested) return;
	agent3dRequested = true;
	const s = document.createElement('script');
	s.type = 'module';
	s.src = AGENT_3D_LOADER;
	document.head.appendChild(s);
}

// Hide the still only once <agent-3d> has painted a canvas of its own. There is
// no documented ready event on the component, and a canvas in the DOM is the
// one signal that means the model is genuinely on screen. Give up after a
// bounded wait and leave the still in place, which is the correct outcome when
// the GLB never arrives.
function revealWhenPainted(viewer, still) {
	let settled = false;
	const done = () => {
		if (settled) return;
		settled = true;
		observer.disconnect();
		clearTimeout(timer);
		still.classList.add('is-hidden');
	};
	const painted = () =>
		Boolean(viewer.querySelector('canvas') || viewer.shadowRoot?.querySelector('canvas'));

	const observer = new MutationObserver(() => {
		if (painted()) done();
	});
	observer.observe(viewer, { childList: true, subtree: true });
	const timer = setTimeout(() => {
		observer.disconnect();
	}, 15000);
	if (painted()) done();
}

function stageFor(entry) {
	const stage = el('div', { class: 'sp-stage' });
	stage.append(el('span', { class: 'sp-stage-badge', text: "Editor's pick" }));

	// The still image goes in first and stays until the 3D viewer has actually
	// painted a canvas. A GLB can fail to load for reasons this page does not
	// control (a cold CDN, a blocked origin, no WebGL on the device), and a
	// silently empty hero is the worst version of that failure.
	const still = entry.agent.thumbnail
		? el('img', {
				class: 'sp-stage-still',
				src: entry.agent.thumbnail,
				alt: `${entry.agent.name} avatar`,
				loading: 'lazy',
				decoding: 'async',
			})
		: monogram(entry.agent);
	stage.append(still);

	if (!entry.agent.glb_url) return stage;

	// Mounted only when the stage is actually on screen. Below-the-fold WebGL on
	// a browse page costs a visitor real frames for something they may never
	// scroll to.
	const mount = () => {
		loadAgent3d();
		const viewer = el('agent-3d', {
			body: entry.agent.glb_url,
			autorotate: 'true',
			'camera-controls': 'true',
			'aria-label': `${entry.agent.name} in 3D`,
		});
		stage.append(viewer);
		revealWhenPainted(viewer, still);
	};

	if ('IntersectionObserver' in window) {
		const io = new IntersectionObserver(
			(entries, obs) => {
				if (entries.some((e) => e.isIntersecting)) {
					obs.disconnect();
					mount();
				}
			},
			{ rootMargin: '200px' },
		);
		io.observe(stage);
	} else {
		mount();
	}
	return stage;
}

function renderFeatured(entries) {
	if (!entries.length) {
		els.featured.hidden = true;
		els.featuredBody.replaceChildren();
		return;
	}
	const entry = entries[0];
	const copy = el('div', { class: 'sp-featured-copy' }, [
		el('h3', {}, [el('a', { href: `/agents/${entry.agent.id}`, text: entry.title })]),
		el('p', { text: entry.tagline }),
		entry.story ? el('p', { class: 'sp-featured-story', text: entry.story }) : null,
		el('div', { class: 'sp-card-meta' }, metaBits(entry)),
		el('div', { class: 'sp-ctas' }, [
			el('a', { class: 'sp-btn sp-btn-primary', href: `/agents/${entry.agent.id}`, text: `Open ${entry.agent.name}` }),
			el('a', { class: 'sp-btn', href: `/agents/${entry.agent.id}/profile`, text: 'Read the profile' }),
			entry.demo_url
				? el('a', {
						class: 'sp-btn',
						href: entry.demo_url,
						target: '_blank',
						rel: 'noopener nofollow ugc',
						text: 'See it live',
					})
				: null,
			voteButton(entry),
		]),
	]);

	els.featuredBody.replaceChildren(stageFor(entry), copy);
	els.featured.hidden = false;
}

/* ── cards ────────────────────────────────────────────────────────────── */

function metaBits(entry) {
	const bits = [el('span', {}, [el('strong', { text: entry.agent.name })])];
	if (entry.builder?.name) {
		bits.push(el('span', { 'aria-hidden': 'true', text: '·' }));
		const by = entry.builder.profile_url
			? el('a', { href: entry.builder.profile_url, text: `by ${entry.builder.name}` })
			: el('span', { text: `by ${entry.builder.name}` });
		bits.push(by);
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

function voteButton(entry) {
	const count = el('span', { class: 'sp-vote-count', text: String(entry.vote_count) });
	const btn = el(
		'button',
		{
			type: 'button',
			class: 'sp-vote',
			'aria-pressed': String(Boolean(entry.voted_by_me)),
			'aria-label': `Upvote ${entry.title}`,
			title: 'Upvote',
		},
		[el('span', { class: 'sp-vote-caret', 'aria-hidden': 'true', text: '▲' }), count],
	);

	btn.addEventListener('click', async (event) => {
		event.preventDefault();
		event.stopPropagation();
		btn.classList.add('is-busy');
		try {
			const res = await apiFetch('/api/showcase/vote', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ id: entry.id }),
				allowAnonymous: true,
			});
			if (res.status === 401) {
				location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
				return;
			}
			const data = await res.json().catch(() => null);
			if (!res.ok) {
				announce(data?.error?.message || 'the vote did not go through');
				return;
			}
			entry.vote_count = data.vote_count;
			entry.voted_by_me = data.voted;
			count.textContent = String(data.vote_count);
			btn.setAttribute('aria-pressed', String(data.voted));
			announce(`${data.voted ? 'Upvoted' : 'Removed your upvote from'} ${entry.title}. ${data.vote_count} total.`);
		} catch {
			announce('the vote did not go through; check your connection');
		} finally {
			btn.classList.remove('is-busy');
		}
	});

	return btn;
}

function cardFor(entry) {
	const art = el('div', { class: 'sp-card-art' });
	if (entry.agent.thumbnail) {
		art.append(
			el('img', {
				src: entry.agent.thumbnail,
				alt: `${entry.agent.name} avatar`,
				loading: 'lazy',
				decoding: 'async',
			}),
		);
	} else {
		art.append(monogram(entry.agent));
	}

	const badges = el('div', { class: 'sp-card-badges' }, [
		el('span', { class: 'sp-badge', text: categoryLabel(entry.category) }),
		entry.agent.is_registered ? el('span', { class: 'sp-badge sp-badge-onchain', text: 'On-chain' }) : null,
		entry.source === 'curated' ? el('span', { class: 'sp-badge sp-badge-curated', text: 'Curated' }) : null,
	]);
	art.append(badges);

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
		el('h3', { class: 'sp-card-title' }, [el('a', { href: `/agents/${entry.agent.id}`, text: entry.title })]),
		el('p', { class: 'sp-card-tagline', text: entry.tagline }),
		el('div', { class: 'sp-card-meta' }, metaBits(entry)),
		tags,
	]);

	const links = el('div', { class: 'sp-card-links' }, [
		el('a', { href: `/agents/${entry.agent.id}`, text: 'Open' }),
		el('a', { href: `/agents/${entry.agent.id}/profile`, text: 'Profile' }),
		entry.demo_url
			? el('a', { href: entry.demo_url, target: '_blank', rel: 'noopener nofollow ugc', text: 'Demo' })
			: null,
	]);

	const foot = el('div', { class: 'sp-card-foot' }, [links, voteButton(entry)]);

	return el('article', { class: 'sp-card' }, [art, body, foot]);
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
				: 'No one has claimed the first slot. Build an agent, make it public, and write up what it does; the first entry gets the featured stage.',
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
			el('button', {
				type: 'button',
				class: 'sp-btn sp-btn-primary',
				text: 'Try again',
				onclick: () => load(),
			}),
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
		const res = await apiFetch(`/api/showcase/list?${p}`, { allowAnonymous: true });
		if (token !== loadToken) return;
		if (res.status === 503) {
			renderEmpty();
			els.grid.replaceChildren();
			return;
		}
		const data = await res.json().catch(() => null);
		if (!res.ok) throw new Error(data?.error?.message || `the showcase returned ${res.status}`);

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
	els.stats.replaceChildren(
		el('div', {}, [
			el('dd', { text: totals.entries.toLocaleString() }),
			el('dt', { text: totals.entries === 1 ? 'agent showcased' : 'agents showcased' }),
		]),
		el('div', {}, [
			el('dd', { text: totals.builders.toLocaleString() }),
			el('dt', { text: totals.builders === 1 ? 'builder' : 'builders' }),
		]),
		el('div', {}, [
			el('dd', { text: totals.votes.toLocaleString() }),
			el('dt', { text: totals.votes === 1 ? 'upvote' : 'upvotes' }),
		]),
	);
}

/* ── featured rail + categories ───────────────────────────────────────── */

async function loadFeatured() {
	try {
		const res = await apiFetch('/api/showcase/list?featured=1&limit=1&sort=trending', { allowAnonymous: true });
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
				el('button', { type: 'button', class: 'sp-cat', 'aria-pressed': String(view.category === c.slug), onclick: () => selectCategory(c.slug) }, [
					el('span', { text: c.label }),
					el('span', { class: 'sp-cat-count', text: String(c.count) }),
				]),
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
		const res = await apiFetch('/api/showcase/categories', { allowAnonymous: true });
		if (!res.ok) return;
		const data = await res.json().catch(() => null);
		categories = Array.isArray(data?.categories) ? data.categories : [];
		if (data?.totals) totals = data.totals;
		renderCategories();
		renderStats();
		fillCategorySelect();
	} catch {
		categories = [];
	}
}

function fillCategorySelect() {
	if (!els.categorySelect || !categories.length) return;
	els.categorySelect.replaceChildren(
		...categories.map((c) => el('option', { value: c.slug, text: c.label })),
	);
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
	els.agentSelect.replaceChildren(el('option', { value: '', text: 'Loading your agents…' }));
	try {
		const res = await apiFetch('/api/showcase/eligible', { allowAnonymous: true });
		if (res.status === 401) {
			eligibleLoaded = false;
			showPanelAuth();
			return;
		}
		const data = await res.json().catch(() => null);
		if (!res.ok) throw new Error(data?.error?.message || 'could not load your agents');

		if (Array.isArray(data.categories) && data.categories.length && !categories.length) {
			categories = data.categories.map((c) => ({ ...c, count: 0 }));
			fillCategorySelect();
		}

		const agents = Array.isArray(data.agents) ? data.agents : [];
		if (!agents.length) {
			els.agentSelect.replaceChildren(el('option', { value: '', text: 'No eligible agents' }));
			els.agentSelect.disabled = true;
			els.submit.disabled = true;
			els.agentHint.replaceChildren(
				document.createTextNode('Every public agent you own is already showcased, or you have not made one yet. '),
				el('a', { href: '/create-agent', text: 'Create an agent' }),
				document.createTextNode('.'),
			);
			return;
		}
		els.agentSelect.disabled = false;
		els.submit.disabled = false;
		els.agentSelect.replaceChildren(
			el('option', { value: '', text: 'Choose an agent…' }),
			...agents.map((a) => el('option', { value: a.id, text: a.name })),
		);
		els.agentHint.textContent = `${plural(agents.length, 'agent', 'agents')} you can showcase. Only public agents are listed.`;

		// Pre-fill the one-liner from the agent's own description: the builder
		// already wrote it once, and an empty field is the main reason a
		// submission gets abandoned halfway.
		els.agentSelect.addEventListener('change', () => {
			const chosen = agents.find((a) => a.id === els.agentSelect.value);
			const tagline = document.getElementById('sp-tagline');
			if (chosen?.description && tagline && !tagline.value.trim()) {
				tagline.value = chosen.description.replace(/\s+/g, ' ').trim().slice(0, 160);
				tagline.dispatchEvent(new Event('input'));
			}
		});
	} catch (err) {
		eligibleLoaded = false;
		els.agentSelect.replaceChildren(el('option', { value: '', text: 'Could not load your agents' }));
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
	els.agentSelect.replaceChildren(el('option', { value: '', text: 'Sign in first' }));
	els.agentSelect.disabled = true;
	els.submit.disabled = true;
}

function setNote(message, tone) {
	els.formNote.textContent = message;
	if (tone) els.formNote.dataset.tone = tone;
	else delete els.formNote.dataset.tone;
}

function parseTags(raw) {
	return raw
		.split(',')
		.map((t) => t.trim().toLowerCase().replace(/\s+/g, '-'))
		.filter(Boolean)
		.slice(0, 6);
}

async function onSubmit(event) {
	event.preventDefault();
	const agentId = els.agentSelect.value;
	if (!agentId) return setNote('pick which agent you are showcasing', 'error');

	const payload = {
		agentId,
		title: document.getElementById('sp-title').value.trim(),
		tagline: document.getElementById('sp-tagline').value.trim(),
		story: document.getElementById('sp-story').value.trim() || null,
		demoUrl: document.getElementById('sp-demo').value.trim() || null,
		category: els.categorySelect.value,
		tags: parseTags(document.getElementById('sp-tags').value),
	};

	if (payload.title.length < 3) return setNote('the headline needs at least 3 characters', 'error');
	if (payload.tagline.length < 10) return setNote('the one-liner needs at least 10 characters', 'error');

	els.submit.disabled = true;
	setNote('Publishing…');
	try {
		const res = await apiFetch('/api/showcase/submit', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(payload),
			allowAnonymous: true,
		});
		if (res.status === 401) {
			showPanelAuth();
			setNote('sign in to publish', 'error');
			return;
		}
		const data = await res.json().catch(() => null);
		if (!res.ok) throw new Error(data?.error?.message || `the submission returned ${res.status}`);

		setNote('Published. Your agent is in the showcase.', 'success');
		els.panel.reset();
		eligibleLoaded = false;
		view.offset = 0;
		view.sort = 'new';
		syncSortButtons();
		writeUrl();
		await Promise.all([load(), loadCategories()]);
		announce(`${payload.title} is now in the showcase.`);
		setTimeout(() => openPanel(false), 1200);
	} catch (err) {
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

function wireCharCounters() {
	for (const counter of document.querySelectorAll('[data-count-for]')) {
		const field = document.getElementById(counter.dataset.countFor);
		if (!field) continue;
		const update = () => {
			counter.textContent = String(field.value.length);
		};
		field.addEventListener('input', update);
		update();
	}
}

function wire() {
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

	wireCharCounters();
}

readUrl();
syncSortButtons();
wire();
load();
loadCategories();
loadFeatured();
