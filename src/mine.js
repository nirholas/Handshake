/**
 * /mine, "My Creations".
 *
 * The answer to the one question a new creator asks after they build something:
 * "where did it go?". Everything a person has made on three.ws lands in a single
 * newest-first grid: agents, saved 3D avatars, forged models, and saved worlds,
 * with an Open and an Edit path on every card.
 *
 * Data flow (all real, no mocks; every source is optional and failures degrade):
 *   GET /api/auth/me                       → session + username
 *   GET /api/agents                        → agents owned by the session
 *   GET /api/avatars/mine?limit=           → avatars saved to the account
 *   GET /api/forge-gallery?limit=          → models forged in THIS browser
 *                                            (x-forge-client, works signed out)
 *   GET /api/users/:username/creations     → models + worlds forged while signed
 *                                            in, from any browser
 *
 * The forge lanes are anonymous-by-design (a hashed browser key, no account), so
 * the browser-scoped feed is what rescues a creation made before signing up. The
 * username feed covers the other direction: signed in, different device. Both
 * are merged and de-duplicated by id.
 */

import { createLogger } from './shared/log.js';
import {
	emptyStateHTML,
	errorStateHTML,
	ensureStateKitStyles,
	attachRetry,
} from './shared/state-kit.js';

const log = createLogger('mine');

const MAX_LIVE_VIEWERS = 6;
const AVATAR_LIMIT = 60;
const MODEL_LIMIT = 48;

const $ = (id) => document.getElementById(id);
const esc = (s) =>
	String(s ?? '').replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);

const state = {
	items: [],
	filter: 'all',
	query: '',
	signedIn: false,
	loaded: false,
};

// ── Sources ─────────────────────────────────────────────────────────────────

/** The browser-local forge handle. Never minted here: an absent id means this
 *  browser has forged nothing, and hitting the feed without one would read the
 *  shared anonymous bucket. */
function forgeClientId() {
	try {
		return localStorage.getItem('forge:cid') || null;
	} catch {
		return null;
	}
}

async function getJSON(url, { headers } = {}) {
	const res = await fetch(url, {
		credentials: 'include',
		headers: { accept: 'application/json', ...(headers || {}) },
	});
	if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
	return res.json();
}

async function fetchSession() {
	try {
		const data = await getJSON('/api/auth/me');
		return data?.user ?? null;
	} catch {
		return null;
	}
}

function truncate(s, n) {
	const t = String(s || '').trim();
	return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function relativeTime(iso) {
	const then = new Date(iso).getTime();
	if (!Number.isFinite(then)) return '';
	const secs = Math.max(1, Math.floor((Date.now() - then) / 1000));
	const units = [
		['y', 31536000], ['mo', 2592000], ['w', 604800],
		['d', 86400], ['h', 3600], ['m', 60],
	];
	for (const [label, size] of units) {
		const v = Math.floor(secs / size);
		if (v >= 1) return `${v}${label} ago`;
	}
	return 'just now';
}

function normalizeAgent(a) {
	return {
		kind: 'agent',
		key: `agent:${a.id}`,
		id: a.id,
		title: a.name || 'Untitled agent',
		sub: a.description ? truncate(a.description, 70) : 'AI agent',
		poster: a.avatar_thumbnail_url || null,
		model: a.avatar_model_url || null,
		href: a.home_url || `/agents/${a.id}`,
		editHref: `/agents/${a.id}/edit`,
		editLabel: 'Edit',
		createdAt: a.created_at || null,
		flag: a.onchain || a.meta?.sol_mint_address || a.meta?.erc8004_agent_id ? 'on-chain' : '',
	};
}

function normalizeAvatar(a) {
	return {
		kind: 'avatar',
		key: `avatar:${a.id}`,
		id: a.id,
		title: a.name || 'Untitled avatar',
		sub: a.visibility === 'public' ? 'Public avatar' : 'Private avatar',
		poster: a.has_thumbnail ? `/api/avatars/${encodeURIComponent(a.id)}/thumb` : null,
		model: null,
		href: `/avatars/${encodeURIComponent(a.slug || a.id)}`,
		editHref: `/avatars/${encodeURIComponent(a.id)}/edit`,
		editLabel: 'Edit',
		createdAt: a.created_at || null,
		flag: '',
	};
}

function normalizeForgeCreation(c) {
	return {
		kind: 'model',
		key: `model:${c.id}`,
		id: c.id,
		title: truncate(c.prompt || 'Forged model', 60) || 'Forged model',
		sub: c.model_category && c.model_category !== 'other' ? `3D model · ${c.model_category}` : '3D model',
		poster: c.preview_image_url || null,
		model: c.web_glb_url || c.glb_url || null,
		href: `/m/${encodeURIComponent(c.id)}`,
		// /forge?prompt= is the real re-run path (see handleQueryParams in
		// src/forge.js): it drops the original prompt back into the textarea.
		editHref: c.prompt ? `/forge?prompt=${encodeURIComponent(c.prompt)}` : null,
		editLabel: 'Forge again',
		createdAt: c.created_at || null,
		flag: '',
	};
}

/** Items from /api/users/:username/creations: models, worlds and restyles the
 *  creator made while signed in (any browser). Shape differs from the forge
 *  gallery feed, so it gets its own mapper. */
function normalizeProfileCreation(it) {
	if (it.type === 'world') {
		return {
			kind: 'world',
			key: `world:${it.id}`,
			id: it.id,
			title: truncate(it.title || it.prompt || 'Saved world', 60) || 'Saved world',
			sub: 'World',
			poster: null,
			model: it.thumbnailUrl || null,
			href: `/diorama?id=${encodeURIComponent(it.id)}`,
			editHref: null,
			editLabel: '',
			createdAt: it.createdAt || null,
			flag: '',
		};
	}
	const glb = it.thumbnailUrl || null;
	return {
		kind: 'model',
		key: `model:${it.id}`,
		id: it.id,
		title: truncate(it.title || it.prompt || 'Forged model', 60) || 'Forged model',
		sub: it.type === 'restyle' ? '3D model · restyled' : '3D model',
		poster: null,
		model: glb,
		href: it.type === 'restyle' ? `/viewer?src=${encodeURIComponent(glb || '')}` : `/m/${encodeURIComponent(it.id)}`,
		editHref: it.prompt ? `/forge?prompt=${encodeURIComponent(it.prompt)}` : null,
		editLabel: 'Forge again',
		createdAt: it.createdAt || null,
		flag: it.isRemix ? 'remix' : '',
	};
}

/**
 * Load every source in parallel. Each one resolves to a list or an error marker,
 * so one dead endpoint costs its own section and nothing else. Returns the merged
 * item list plus the number of sources that failed.
 */
async function loadEverything(user) {
	const cid = forgeClientId();
	const username = user?.username || null;

	const jobs = [];
	if (user) {
		jobs.push({ name: 'agents', run: () => getJSON('/api/agents') });
		jobs.push({ name: 'avatars', run: () => getJSON(`/api/avatars/mine?limit=${AVATAR_LIMIT}`) });
	}
	if (cid) {
		jobs.push({
			name: 'forge',
			run: () => getJSON(`/api/forge-gallery?limit=${MODEL_LIMIT}`, { headers: { 'x-forge-client': cid } }),
		});
	}
	if (username) {
		jobs.push({
			name: 'profile',
			run: () => getJSON(`/api/users/${encodeURIComponent(username)}/creations?limit=${MODEL_LIMIT}`),
		});
	}

	const settled = await Promise.allSettled(jobs.map((j) => j.run()));
	const items = [];
	let failures = 0;

	settled.forEach((result, i) => {
		const name = jobs[i].name;
		if (result.status === 'rejected') {
			failures += 1;
			log.warn(`${name} source failed`, result.reason?.message || result.reason);
			return;
		}
		const data = result.value || {};
		if (name === 'agents') items.push(...(data.agents || []).map(normalizeAgent));
		else if (name === 'avatars') items.push(...(data.avatars || []).map(normalizeAvatar));
		else if (name === 'forge') items.push(...(data.creations || []).map(normalizeForgeCreation));
		else if (name === 'profile') items.push(...(data.items || []).map(normalizeProfileCreation));
	});

	// The forge-gallery feed and the profile feed overlap for a signed-in creator
	// forging in their own browser: same row, two sources. First write wins, and
	// the browser-scoped one comes with a poster image, so it is loaded first.
	const seen = new Set();
	const merged = [];
	for (const item of items) {
		if (seen.has(item.key)) continue;
		seen.add(item.key);
		merged.push(item);
	}

	merged.sort((a, b) => {
		const ta = new Date(a.createdAt || 0).getTime() || 0;
		const tb = new Date(b.createdAt || 0).getTime() || 0;
		return tb - ta;
	});

	return { items: merged, failures, sources: jobs.length };
}

// ── Lazy 3D previews ────────────────────────────────────────────────────────
// Each <model-viewer> holds a live WebGL context and browsers cap concurrent
// contexts at ~16, so cards paint a poster and mount a viewer on demand: on
// hover for pointer devices, on tap of the badge for touch. Oldest viewers are
// torn down first once the budget is spent.

/** @type {HTMLElement[]} */
const liveViewers = [];

function mountViewer(thumb) {
	if (thumb.dataset.mounted === '1') return;
	const src = thumb.dataset.model;
	if (!src) return;
	thumb.dataset.mounted = '1';

	while (liveViewers.length >= MAX_LIVE_VIEWERS) {
		const oldest = liveViewers.shift();
		if (oldest && oldest !== thumb) disposeViewer(oldest);
	}

	const mv = document.createElement('model-viewer');
	mv.setAttribute('src', src);
	mv.setAttribute('alt', `${thumb.dataset.name || 'Creation'} in 3D`);
	mv.setAttribute('camera-controls', '');
	mv.setAttribute('auto-rotate', '');
	mv.setAttribute('rotation-per-second', '24deg');
	mv.setAttribute('interaction-prompt', 'none');
	mv.setAttribute('shadow-intensity', '1');
	mv.setAttribute('exposure', '1');
	mv.setAttribute('tone-mapping', 'aces');
	mv.setAttribute('disable-tap', '');
	thumb.appendChild(mv);
	thumb.classList.add('is-live');
	liveViewers.push(thumb);
}

function disposeViewer(thumb) {
	thumb.querySelector('model-viewer')?.remove();
	thumb.classList.remove('is-live');
	thumb.dataset.mounted = '';
	const i = liveViewers.indexOf(thumb);
	if (i !== -1) liveViewers.splice(i, 1);
}

const canHover = typeof window.matchMedia === 'function' && window.matchMedia('(hover: hover)').matches;

// Posterless cards have nothing to show until a viewer mounts, so they mount as
// they scroll into view rather than waiting for an interaction.
const posterlessObserver = new IntersectionObserver(
	(entries) => {
		for (const entry of entries) {
			if (!entry.isIntersecting) continue;
			mountViewer(/** @type {HTMLElement} */ (entry.target));
			posterlessObserver.unobserve(entry.target);
		}
	},
	{ rootMargin: '200px' },
);

function wireThumb(thumb) {
	if (!thumb.dataset.model) return;
	const hasPoster = thumb.dataset.poster === '1';

	if (canHover) {
		let leaveTimer = 0;
		thumb.addEventListener('pointerenter', () => {
			clearTimeout(leaveTimer);
			mountViewer(thumb);
		});
		thumb.addEventListener('pointerleave', () => {
			if (!hasPoster) return;
			leaveTimer = window.setTimeout(() => disposeViewer(thumb), 240);
		});
	} else {
		thumb.querySelector('.mn-preview-btn')?.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			mountViewer(thumb);
		});
	}

	if (!hasPoster) posterlessObserver.observe(thumb);
}

// ── Rendering ───────────────────────────────────────────────────────────────

const KIND_LABEL = { agent: 'Agent', avatar: 'Avatar', model: '3D model', world: 'World' };

function monogram(title) {
	const ch = String(title || '?').trim().charAt(0).toUpperCase();
	return /[A-Z0-9]/.test(ch) ? ch : '◆';
}

function cardHTML(item) {
	const posterHTML = item.poster
		? `<img src="${esc(item.poster)}" alt="" loading="lazy" decoding="async" data-mn-poster />`
		: `<span class="mn-mono" aria-hidden="true">${esc(monogram(item.title))}</span>`;
	const previewBtn = item.model
		? `<button type="button" class="mn-preview-btn">3D</button>`
		: '';
	const meta = [item.sub, item.createdAt ? relativeTime(item.createdAt) : '']
		.filter(Boolean)
		.map((t) => `<span>${esc(t)}</span>`)
		.join('');
	const flag = item.flag ? `<span class="mn-flag">${esc(item.flag)}</span>` : '';

	return `
	<article class="mn-card" data-kind="${esc(item.kind)}" data-key="${esc(item.key)}">
		<a class="mn-thumb" href="${esc(item.href)}" aria-label="Open ${esc(item.title)}"
			${item.model ? `data-model="${esc(item.model)}"` : ''}
			data-poster="${item.poster ? '1' : '0'}" data-name="${esc(item.title)}">
			${posterHTML}
			<span class="mn-kind">${esc(KIND_LABEL[item.kind] || item.kind)}</span>
			${previewBtn}
		</a>
		<div class="mn-body">
			<a class="mn-name" href="${esc(item.href)}" title="${esc(item.title)}">${esc(item.title)}</a>
			<div class="mn-meta">${meta}${flag}</div>
		</div>
		<div class="mn-actions">
			<a class="mn-action" href="${esc(item.href)}">Open</a>
			${item.editHref ? `<a class="mn-action" href="${esc(item.editHref)}">${esc(item.editLabel || 'Edit')}</a>` : ''}
			<button type="button" class="mn-action" data-copy="${esc(item.href)}">Copy link</button>
		</div>
	</article>`;
}

function skeletons(n = 8) {
	return Array.from(
		{ length: n },
		() => `
		<div class="mn-skel" aria-hidden="true">
			<div class="mn-skel-thumb"></div>
			<div class="mn-skel-body">
				<div class="mn-skel-line"></div>
				<div class="mn-skel-line mn-skel-line--short"></div>
			</div>
		</div>`,
	).join('');
}

function visibleItems() {
	const q = state.query.trim().toLowerCase();
	return state.items.filter((item) => {
		if (state.filter !== 'all' && item.kind !== state.filter) return false;
		if (!q) return true;
		return `${item.title} ${item.sub}`.toLowerCase().includes(q);
	});
}

function emptyHTML() {
	if (!state.items.length) {
		return state.signedIn
			? emptyStateHTML({
					title: 'Nothing here yet',
					body: 'Build an agent, forge a 3D model, or make an avatar and it shows up here the moment it saves.',
					actions: [
						{ label: 'Create an agent', href: '/create-agent', primary: true },
						{ label: 'Forge a 3D model', href: '/forge' },
					],
				})
			: emptyStateHTML({
					title: 'Nothing found in this browser',
					body: 'Sign in to see the agents and avatars saved to your account, or make something new.',
					actions: [
						{ label: 'Sign in', href: '/login?next=%2Fmine', primary: true },
						{ label: 'Forge a 3D model', href: '/forge' },
					],
				});
	}
	return emptyStateHTML({
		title: 'No matches',
		body: 'Nothing in this view matches that filter. Clear the search or switch back to All.',
		actions: [{ label: 'Show everything', id: 'mn-clear', primary: true }],
	});
}

function render() {
	const grid = $('mn-grid');
	const items = visibleItems();

	if (!items.length) {
		grid.dataset.state = 'empty';
		grid.innerHTML = emptyHTML();
		grid.removeAttribute('aria-busy');
		return;
	}

	grid.dataset.state = 'list';
	grid.innerHTML = items.map(cardHTML).join('');
	grid.removeAttribute('aria-busy');
	grid.querySelectorAll('.mn-thumb').forEach((thumb) => wireThumb(/** @type {HTMLElement} */ (thumb)));
}

function renderCounts() {
	const count = (kind) => state.items.filter((i) => i.kind === kind).length;
	// Worlds are rare and share the model filter's mental model ("things I forged"),
	// so the tile counts them with models rather than adding a fourth column.
	$('mn-stat-agents').textContent = String(count('agent'));
	$('mn-stat-avatars').textContent = String(count('avatar'));
	$('mn-stat-models').textContent = String(count('model') + count('world'));
}

function setFilter(next) {
	state.filter = next;
	document.querySelectorAll('.mn-chip').forEach((chip) => {
		const on = chip.dataset.filter === next;
		chip.classList.toggle('is-on', on);
		chip.setAttribute('aria-selected', on ? 'true' : 'false');
	});
	render();
}

// ── Boot ────────────────────────────────────────────────────────────────────

async function boot() {
	ensureStateKitStyles();
	const grid = $('mn-grid');
	grid.innerHTML = skeletons();

	const user = await fetchSession();
	state.signedIn = !!user;
	$('mn-anon-note').hidden = state.signedIn;

	let result;
	try {
		result = await loadEverything(user);
	} catch (err) {
		log.error('load failed', err);
		grid.dataset.state = 'error';
		grid.innerHTML = errorStateHTML({
			title: 'Could not load your creations',
			body: 'The request did not complete. Your work is safe. This is only the view.',
			scope: 'mine',
		});
		grid.removeAttribute('aria-busy');
		return;
	}

	state.items = result.items;
	state.loaded = true;

	// Every source down (and there was at least one to try) is an error, not an
	// empty account: telling someone their creations are gone when the API is
	// merely unreachable is the worst thing this page could do.
	if (result.sources > 0 && result.failures === result.sources && !state.items.length) {
		grid.dataset.state = 'error';
		grid.innerHTML = errorStateHTML({
			title: 'Could not reach your creations',
			body: 'Nothing loaded. Your work is safe. This is only the view. Try again in a moment.',
			scope: 'mine',
		});
		grid.removeAttribute('aria-busy');
		return;
	}

	renderCounts();
	$('mn-stats').hidden = !state.items.length;
	$('mn-controls').hidden = state.items.length < 2;
	$('mn-elsewhere').hidden = false;
	render();
}

function wireControls() {
	const grid = $('mn-grid');

	document.querySelectorAll('.mn-chip').forEach((chip) => {
		chip.addEventListener('click', () => setFilter(chip.dataset.filter));
	});

	document.querySelectorAll('[data-stat-filter]').forEach((tile) => {
		tile.addEventListener('click', (e) => {
			e.preventDefault();
			setFilter(tile.dataset.statFilter);
			grid.scrollIntoView({ behavior: 'smooth', block: 'start' });
		});
	});

	let debounce = 0;
	$('mn-search-input').addEventListener('input', (e) => {
		clearTimeout(debounce);
		const value = e.target.value;
		debounce = window.setTimeout(() => {
			state.query = value;
			render();
		}, 140);
	});

	grid.addEventListener('click', async (e) => {
		const clear = e.target.closest('[data-sk-action="mn-clear"]');
		if (clear) {
			$('mn-search-input').value = '';
			state.query = '';
			setFilter('all');
			return;
		}

		const copy = e.target.closest('[data-copy]');
		if (!copy) return;
		e.preventDefault();
		const url = new URL(copy.dataset.copy, location.origin).href;
		try {
			await navigator.clipboard.writeText(url);
			const original = copy.textContent;
			copy.textContent = 'Copied';
			copy.classList.add('is-done');
			setTimeout(() => {
				copy.textContent = original;
				copy.classList.remove('is-done');
			}, 1400);
		} catch {
			// Clipboard blocked (permission, insecure context): fall back to
			// selecting the URL so the person can copy it by hand.
			window.prompt('Copy this link', url);
		}
	});

	// A poster that 404s (thumbnail purged, avatar never rendered one) must not
	// leave a broken-image glyph in the card; swap it for the monogram tile.
	grid.addEventListener(
		'error',
		(e) => {
			const img = e.target;
			if (!(img instanceof HTMLImageElement) || !img.hasAttribute('data-mn-poster')) return;
			const thumb = img.closest('.mn-thumb');
			const name = thumb?.dataset.name || '';
			const span = document.createElement('span');
			span.className = 'mn-mono';
			span.setAttribute('aria-hidden', 'true');
			span.textContent = monogram(name);
			img.replaceWith(span);
			if (thumb) thumb.dataset.poster = '0';
		},
		true,
	);

	attachRetry(grid, () => {
		grid.dataset.state = 'list';
		grid.innerHTML = skeletons();
		grid.setAttribute('aria-busy', 'true');
		boot();
	});
}

wireControls();
boot();
