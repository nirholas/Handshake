// Coin Communities lobby — the front door to three.ws worlds.
//
// Every coin on three.ws is its own 3D world at /walk?coin=<mint>; its
// CoinCommunities community is the live social layer inside. This page does two
// things with zero friction:
//   1. Lets a visitor pick or drop in an avatar / 3D agent (no sign-in) and
//      remembers it.
//   2. Lists the live coin-worlds (GET /api/community/worlds) and drops the
//      visitor into any of them — or the open mainland — in one click.
//
// Data is real (CoinCommunities via the api/community/* proxy). Every state is
// designed: loading skeletons, empty, error, and the graceful "not configured"
// path where the social layer is offline but worlds are still enterable.

import { AvatarGalleryPicker } from './avatar-gallery-picker.js';

// ── tiny DOM helpers ─────────────────────────────────────────────────────────
const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, attrs = {}, children = []) => {
	const node = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (k === 'class') node.className = v;
		else if (k === 'html') node.innerHTML = v;
		else if (k === 'text') node.textContent = v;
		else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
		else if (v !== false && v != null) node.setAttribute(k, v);
	}
	for (const c of [].concat(children)) {
		if (c == null || c === false) continue;
		node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
	}
	return node;
};

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// ── persisted onboarding choice ──────────────────────────────────────────────
const LS = {
	name: 'tws:walkName',
	avatarId: 'tws:worldAvatarId',
	avatarName: 'tws:worldAvatarName',
	avatarUrl: 'tws:worldAvatarUrl',
	avatarThumb: 'tws:worldAvatarThumb',
};
const lsGet = (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v ?? ''); } catch {} };

// Curated instant avatars (stable demo fixtures — animated rigs first so a
// brand-new visitor can one-click drop in and immediately look alive).
const QUICK_AVATARS = [
	{ id: 'avatar_demo_disk_saga', name: 'Saga', tag: 'robot' },
	{ id: 'avatar_demo_disk_agent', name: 'Agent', tag: 'soldier' },
	{ id: 'avatar_demo_disk_boss', name: 'Boss', tag: 'soldier' },
	{ id: 'avatar_demo_disk_cz', name: 'CZ', tag: 'humanoid' },
];

const state = {
	worlds: [],
	worldsStatus: 'loading', // loading | ready | empty | error | unconfigured
	worldsError: '',
	query: '',
	avatar: null, // { id, name, model_url, thumbnail_url }
};

// ── avatar onboarding ────────────────────────────────────────────────────────
function currentAvatar() {
	if (state.avatar) return state.avatar;
	const id = lsGet(LS.avatarId);
	if (id) {
		return {
			id,
			name: lsGet(LS.avatarName) || 'Avatar',
			model_url: lsGet(LS.avatarUrl) || '',
			thumbnail_url: lsGet(LS.avatarThumb) || '',
		};
	}
	return null;
}

function setAvatar(a) {
	state.avatar = a;
	lsSet(LS.avatarId, a?.id || '');
	lsSet(LS.avatarName, a?.name || '');
	lsSet(LS.avatarUrl, a?.model_url || '');
	lsSet(LS.avatarThumb, a?.thumbnail_url || '');
	renderAvatarPanel();
}

async function resolveAvatar(id) {
	const res = await fetch(`/api/avatars/${encodeURIComponent(id)}`, { credentials: 'include' });
	if (!res.ok) throw new Error(`Couldn't load that avatar (${res.status}).`);
	const { avatar } = await res.json();
	return {
		id: avatar.id,
		name: avatar.name || 'Avatar',
		model_url: avatar.model_url || avatar.url || '',
		thumbnail_url: avatar.thumbnail_url || '',
	};
}

function renderAvatarPanel() {
	const host = $('#wl-avatar');
	if (!host) return;
	const a = currentAvatar();
	const nameInput = $('#wl-name');
	host.innerHTML = '';

	// 3D / thumbnail preview of the chosen avatar.
	const preview = el('div', { class: 'wl-avatar-preview' });
	if (a?.model_url && window.customElements?.get('model-viewer')) {
		const mv = document.createElement('model-viewer');
		mv.setAttribute('src', a.model_url);
		mv.setAttribute('camera-orbit', '0deg 90deg 2.4m');
		mv.setAttribute('camera-target', '0m 1m 0m');
		mv.setAttribute('field-of-view', '24deg');
		mv.setAttribute('disable-zoom', '');
		mv.setAttribute('interaction-prompt', 'none');
		mv.setAttribute('autoplay', '');
		mv.setAttribute('shadow-intensity', '0.7');
		mv.setAttribute('exposure', '1');
		mv.style.cssText = 'width:100%;height:100%;--poster-color:transparent;background:transparent';
		preview.appendChild(mv);
	} else if (a?.thumbnail_url) {
		preview.appendChild(el('img', { src: a.thumbnail_url, alt: a.name, loading: 'lazy' }));
	} else {
		preview.appendChild(el('div', { class: 'wl-avatar-ph', 'aria-hidden': 'true', html: PERSON_SVG }));
	}
	host.appendChild(preview);

	const meta = el('div', { class: 'wl-avatar-meta' }, [
		el('div', { class: 'wl-avatar-name', text: a ? a.name : 'No avatar yet' }),
		el('div', { class: 'wl-avatar-sub', text: a ? 'Ready to drop in' : 'Pick one below to get started' }),
	]);
	host.appendChild(meta);

	if (nameInput && !nameInput.value) {
		nameInput.value = lsGet(LS.name) || `guest-${Math.random().toString(36).slice(2, 6)}`;
	}
}

function buildQuickAvatars() {
	const row = $('#wl-quick');
	if (!row) return;
	for (const q of QUICK_AVATARS) {
		const btn = el('button', {
			class: 'wl-quick-btn', type: 'button', 'data-id': q.id,
			title: `Use ${q.name} (${q.tag})`,
		}, [
			el('span', { class: 'wl-quick-dot', 'aria-hidden': 'true' }),
			el('span', { text: q.name }),
		]);
		btn.addEventListener('click', async () => {
			row.querySelectorAll('.wl-quick-btn').forEach((b) => b.classList.remove('is-on'));
			btn.classList.add('is-on');
			btn.disabled = true;
			try {
				setAvatar(await resolveAvatar(q.id));
			} catch (err) {
				toast(err.message, 'error');
			} finally {
				btn.disabled = false;
			}
		});
		row.appendChild(btn);
	}
}

function wireAvatarActions() {
	$('#wl-browse')?.addEventListener('click', () => {
		const signedIn = document.cookie.includes('session');
		const picker = new AvatarGalleryPicker({
			source: signedIn ? 'both' : 'public',
			title: 'Choose your avatar or 3D agent',
			ctaLabel: 'Use this avatar',
			showModes: false,
			onSelect: (avatar) => {
				picker.close();
				setAvatar({
					id: avatar.id,
					name: avatar.name || 'Avatar',
					model_url: avatar.model_url || '',
					thumbnail_url: avatar.thumbnail_url || '',
				});
			},
		});
		picker.openModal();
	});

	// Drop in by id / paste — three.ws avatar id or agent avatar id.
	const idForm = $('#wl-id-form');
	idForm?.addEventListener('submit', async (e) => {
		e.preventDefault();
		const raw = $('#wl-id-input')?.value.trim();
		if (!raw) return;
		const id = raw.replace(/^.*\/(avatars?)\//, '').replace(/[?#].*$/, '').trim();
		const btn = $('#wl-id-btn');
		btn?.setAttribute('disabled', 'true');
		try {
			setAvatar(await resolveAvatar(id));
			$('#wl-id-input').value = '';
			toast('Avatar loaded.', 'ok');
		} catch (err) {
			toast(err.message, 'error');
		} finally {
			btn?.removeAttribute('disabled');
		}
	});

	$('#wl-create-link')?.setAttribute('href', '/create');

	const nameInput = $('#wl-name');
	nameInput?.addEventListener('change', () => lsSet(LS.name, nameInput.value.trim().slice(0, 24)));
}

// ── enter a world ────────────────────────────────────────────────────────────
function enterWorld(coin) {
	const a = currentAvatar();
	const name = ($('#wl-name')?.value || lsGet(LS.name) || '').trim().slice(0, 24);
	if (name) lsSet(LS.name, name);
	const params = new URLSearchParams();
	if (coin) params.set('coin', coin);
	if (a?.id) params.set('avatar', a.id);
	if (name) params.set('name', name);
	const qs = params.toString();
	window.location.href = `/walk${qs ? `?${qs}` : ''}`;
}

// ── worlds grid ──────────────────────────────────────────────────────────────
async function loadWorlds() {
	state.worldsStatus = 'loading';
	renderWorlds();
	try {
		const res = await fetch('/api/community/worlds', { headers: { accept: 'application/json' } });
		// 503 = CoinCommunities not configured; 404 = the community proxy isn't
		// deployed on this target yet. Both mean "no live social layer" — degrade
		// to the same graceful state where worlds are still enterable, rather than
		// a hard error.
		if (res.status === 503 || res.status === 404) { state.worldsStatus = 'unconfigured'; renderWorlds(); return; }
		if (!res.ok) throw new Error(`worlds ${res.status}`);
		const body = await res.json();
		const worlds = body?.data?.worlds || [];
		state.worlds = worlds;
		state.worldsStatus = worlds.length ? 'ready' : 'empty';
	} catch (err) {
		state.worldsStatus = 'error';
		state.worldsError = err.message;
	}
	renderWorlds();
}

function worldCard(w) {
	const symbol = w.symbol ? `$${w.symbol}` : `${w.token.slice(0, 4)}…${w.token.slice(-4)}`;
	const card = el('button', { class: 'wl-card', type: 'button', title: `Enter ${symbol}` }, [
		el('div', { class: 'wl-card-art' }, [
			w.image
				? el('img', { src: w.image, alt: symbol, loading: 'lazy', referrerpolicy: 'no-referrer' })
				: el('div', { class: 'wl-card-art-ph', text: symbol.slice(0, 3) }),
			el('span', { class: 'wl-card-live' }, [el('span', { class: 'wl-live-dot' }), 'live']),
		]),
		el('div', { class: 'wl-card-body' }, [
			el('div', { class: 'wl-card-sym', text: symbol }),
			el('div', { class: 'wl-card-stats' }, [
				stat(PEOPLE_SVG, w.members, 'members'),
				stat(CHAT_SVG, w.posts, 'posts'),
				stat(HEART_SVG, w.likes, 'likes'),
			]),
		]),
		el('span', { class: 'wl-card-enter', text: 'Enter →' }),
	]);
	card.addEventListener('click', () => enterWorld(w.token));
	return card;
}

function stat(svg, n, label) {
	return el('span', { class: 'wl-stat', title: `${n} ${label}` }, [
		el('span', { class: 'wl-stat-i', 'aria-hidden': 'true', html: svg }),
		el('span', { text: compact.format(n || 0) }),
	]);
}

function renderWorlds() {
	const host = $('#wl-worlds');
	const count = $('#wl-worlds-count');
	if (!host) return;
	host.innerHTML = '';

	if (state.worldsStatus === 'loading') {
		for (let i = 0; i < 8; i++) host.appendChild(el('div', { class: 'wl-card wl-skel' }));
		if (count) count.textContent = '';
		return;
	}
	if (state.worldsStatus === 'unconfigured') {
		host.appendChild(emptyBlock(
			'The live community layer is offline',
			'CoinCommunities isn’t configured on this deployment yet — but worlds are still open. Drop into the mainland, or enter any coin by pasting its mint below.',
			'Enter the mainland', () => enterWorld(''),
		));
		host.appendChild(manualMint());
		if (count) count.textContent = '';
		return;
	}
	if (state.worldsStatus === 'error') {
		host.appendChild(emptyBlock(
			'Couldn’t load worlds',
			state.worldsError || 'Something went wrong fetching live communities.',
			'Retry', loadWorlds,
		));
		if (count) count.textContent = '';
		return;
	}
	if (state.worldsStatus === 'empty') {
		host.appendChild(emptyBlock(
			'No live communities yet',
			'Be the first — drop into the open mainland world and bring people in.',
			'Enter the mainland', () => enterWorld(''),
		));
		host.appendChild(manualMint());
		if (count) count.textContent = '';
		return;
	}

	const q = state.query.toLowerCase();
	const list = state.worlds.filter((w) =>
		!q || (w.symbol || '').toLowerCase().includes(q) || w.token.toLowerCase().includes(q));
	if (count) count.textContent = `${list.length} world${list.length === 1 ? '' : 's'}`;
	if (!list.length) {
		host.appendChild(emptyBlock('No match', `No live world matches “${state.query}”.`, 'Clear', () => {
			state.query = ''; $('#wl-search').value = ''; renderWorlds();
		}));
		return;
	}
	for (const w of list) host.appendChild(worldCard(w));
}

function emptyBlock(title, body, ctaLabel, onCta) {
	return el('div', { class: 'wl-empty' }, [
		el('div', { class: 'wl-empty-icon', 'aria-hidden': 'true', html: GLOBE_SVG }),
		el('h3', { text: title }),
		el('p', { text: body }),
		el('button', { class: 'wl-btn wl-btn-primary', type: 'button', onclick: onCta, text: ctaLabel }),
	]);
}

function manualMint() {
	const form = el('form', { class: 'wl-mint-form' }, [
		el('input', {
			type: 'text', id: 'wl-mint-input', class: 'wl-input',
			placeholder: 'Paste a coin mint to enter its world…', autocomplete: 'off',
			'aria-label': 'Coin mint address',
		}),
		el('button', { class: 'wl-btn', type: 'submit', text: 'Enter' }),
	]);
	form.addEventListener('submit', (e) => {
		e.preventDefault();
		const mint = $('#wl-mint-input').value.trim();
		if (!MINT_RE.test(mint)) { toast('That doesn’t look like a valid mint address.', 'error'); return; }
		enterWorld(mint);
	});
	return form;
}

// ── toast ────────────────────────────────────────────────────────────────────
let toastTimer = null;
function toast(text, kind = 'info') {
	const t = $('#wl-toast');
	if (!t) return;
	t.textContent = text;
	t.dataset.kind = kind;
	t.classList.add('show');
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

// ── icons ────────────────────────────────────────────────────────────────────
const PERSON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4.5 4.5-7 8-7s6.5 2.5 8 7"/></svg>`;
const PEOPLE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M16 19c0-2.5-2-4.5-4.5-4.5S7 16.5 7 19"/><circle cx="11.5" cy="9" r="3"/><path d="M19 18c0-1.8-1-3.3-2.5-3.9"/></svg>`;
const CHAT_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.5 7.2L4 20l.8-5.5A8 8 0 1 1 21 12Z"/></svg>`;
const HEART_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20s-7-4.3-9.2-8.5C1.3 8.7 2.7 5.5 6 5.5c2 0 3.2 1.3 4 2.5.8-1.2 2-2.5 4-2.5 3.3 0 4.7 3.2 3.2 6C19 15.7 12 20 12 20Z"/></svg>`;
const GLOBE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.5 2.5 15 0 18M12 3c-2.5 2.5-2.5 15 0 18"/></svg>`;

// ── boot ─────────────────────────────────────────────────────────────────────
export function bootLobby() {
	buildQuickAvatars();
	wireAvatarActions();
	renderAvatarPanel();

	$('#wl-enter-mainland')?.addEventListener('click', () => enterWorld(''));
	const search = $('#wl-search');
	search?.addEventListener('input', () => { state.query = search.value.trim(); renderWorlds(); });

	loadWorlds();
	// Keep the lobby feeling live.
	setInterval(loadWorlds, 30_000);
}

document.addEventListener('DOMContentLoaded', bootLobby);
