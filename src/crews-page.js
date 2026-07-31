// Crew HQ (/crews and /crews/<TAG>) — the browser half of the crews system.
//
// The crews backend (api/crews/*, api/_lib/crews-store.js, the 2026-06-05
// migration) has been complete and reachable since the /play world shipped, but
// nothing in the product ever rendered it: the only reference anywhere in the
// frontend was a `if (a.openCrew)` branch in the game HUD that nothing supplied,
// so the button never drew. This page is the surface that closes that gap, and
// src/game/hud/index.js now supplies openCrew so the in-world button opens it.
//
// What makes it a room rather than a list: every member stands in the HQ as
// their own agent's avatar (crews-store.standeesFor resolves each account's
// renderable agent), lit when they are online in a realm and unlit when they are
// not. Presence is read from the same Redis the friends list reads, so "online"
// here means the same thing it means in-world.
//
// Three views share one page, chosen by URL and session:
//   /crews          signed out → the directory (public, no auth call needed)
//   /crews          signed in  → my HQ, or the found-a-crew flow plus invites
//   /crews/<TAG>    anyone     → that crew's public HQ, read-only
//
// WebGL contexts are the one hard budget here: browsers cap them (~16) and a
// 12-person crew asking for 12 canvases would evict the site's other viewers.
// LIVE_FIGURE_BUDGET caps how many members render as a live <agent-3d>; the rest
// render as their avatar still, which is the same figure, just not animated.

import { apiFetch } from './api.js';

const LIVE_FIGURE_BUDGET = 6;
const DEFAULT_RIG = '/avatars/default.glb';
const PRESENCE_POLL_MS = 20_000;
const SEARCH_DEBOUNCE_MS = 250;
const TAG_RE = /^[A-Z0-9]{2,6}$/;
// Kept in sync with RESERVED_TAGS in api/_lib/crews-store.js. Duplicated rather
// than fetched so the founding form can say "reserved" as you type instead of
// after a round trip; the server remains the authority and rejects it anyway.
const RESERVED_TAGS = new Set(['SEARCH', 'INDEX', 'API', 'ADMIN', 'NEW', 'ME', 'ALL', 'NULL']);

const $ = (id) => document.getElementById(id);

const esc = (s) =>
	String(s ?? '').replace(/[&<>"']/g, (c) =>
		({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);

// ── crest ────────────────────────────────────────────────────────────────────
// A crew's colour is derived from its tag, so it is stable everywhere the crew
// appears (room, directory, share card) without anyone picking or storing one.
function crestHues(tag) {
	let h = 2166136261;
	for (const ch of String(tag || '')) {
		h ^= ch.charCodeAt(0);
		h = Math.imul(h, 16777619) >>> 0;
	}
	const hue = h % 360;
	return { hue, hue2: (hue + 58) % 360 };
}

function applyCrewHues(el, tag) {
	const { hue, hue2 } = crestHues(tag);
	el.style.setProperty('--crew-hue', String(hue));
	el.style.setProperty('--crew-hue-2', String(hue2));
}

function crestHtml(tag, small = false) {
	const { hue, hue2 } = crestHues(tag);
	return (
		`<div class="cw-crest${small ? ' sm' : ''}" aria-hidden="true" ` +
		`style="--crew-hue:${hue};--crew-hue-2:${hue2}">${esc(tag)}</div>`
	);
}

// ── presence wording ─────────────────────────────────────────────────────────
// Matches src/game/friends-panel.js so the same person reads the same in both.
function realmLabel(realm, server) {
	if (!realm) return '';
	const r = String(realm)
		.replace(/[_-]+/g, ' ')
		.replace(/\b\w/g, (c) => c.toUpperCase());
	return server ? `${r} · Server ${server}` : r;
}

function presenceLine(m) {
	if (!m.online) return 'Offline';
	const where = realmLabel(m.realm, m.server);
	return where ? `In ${where}` : 'Online';
}

function joinedLabel(iso) {
	if (!iso) return '';
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return '';
	return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// ── errors ───────────────────────────────────────────────────────────────────
// Every mutation surfaces the server's own reason. The store throws typed codes
// and http.error() emits them as { error, error_description }; anything without
// one still gets a sentence rather than "undefined".
async function readError(res) {
	const body = await res.json().catch(() => null);
	return (
		body?.error_description ||
		body?.error ||
		(res.status === 429 ? 'Too many requests. Wait a moment and try again.' : `Request failed (${res.status}).`)
	);
}

// ── state ────────────────────────────────────────────────────────────────────
const state = {
	/** @type {'mine'|'public'} */ mode: 'mine',
	publicTag: '',
	me: null, // { crew, members, invites } for the signed-in account
	viewing: null, // { crew, members } currently rendered in the room
	authed: false,
	loaded: false,
	pollTimer: null,
	searchTimer: null,
	liveFigures: 0,
};

// ── toast ────────────────────────────────────────────────────────────────────
let toastTimer = null;
function toast(message, tone = 'good') {
	const el = $('cw-toast');
	if (!el) return;
	el.textContent = message;
	el.dataset.tone = tone;
	el.dataset.show = 'true';
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => {
		el.dataset.show = 'false';
	}, 4200);
}

// ── the room ─────────────────────────────────────────────────────────────────
function renderRoom(crew, members, { canManage }) {
	const room = $('cw-room');
	const stage = $('cw-stage');
	const head = $('cw-room-head');
	room.hidden = false;
	applyCrewHues(room, crew.tag);

	const online = members.filter((m) => m.online).length;
	const memberWord = members.length === 1 ? 'member' : 'members';
	head.innerHTML =
		crestHtml(crew.tag) +
		'<div class="cw-room-title">' +
		`<h2>${esc(crew.name)} <span class="cw-tag-badge">${esc(crew.tag)}</span></h2>` +
		`<p>${members.length} ${memberWord} · ${
			online ? `<span class="cw-live">${online} in world now</span>` : 'nobody in world right now'
		}</p>` +
		'</div>' +
		'<div class="cw-room-actions">' +
		`<button type="button" class="cw-btn sm" id="cw-share" title="Copy this crew's public link">Copy link</button>` +
		'<a class="cw-btn sm" href="/play" title="Open the 3D world where crews meet">Enter the world</a>' +
		(canManage ? '<button type="button" class="cw-btn sm danger" id="cw-leave">Leave crew</button>' : '') +
		'</div>';

	state.liveFigures = 0;
	stage.innerHTML = members.map(standeeHtml).join('');
	mountFigures(stage);

	$('cw-share').addEventListener('click', () => shareCrew(crew.tag));
	$('cw-leave')?.addEventListener('click', leaveCrew);
}

function standeeHtml(m) {
	const live = state.liveFigures < LIVE_FIGURE_BUDGET;
	if (live) state.liveFigures++;
	const model = m.standee?.modelUrl || DEFAULT_RIG;
	const label = m.standee?.agentName ? `${m.name} as ${m.standee.agentName}` : m.name;
	// Only link where there is somewhere real to go: the member's agent, else
	// their profile, else nothing. A standee with no destination stays a figure
	// rather than becoming an anchor to /u/ with no username behind it.
	const href = m.standee?.agentId
		? `/a/${encodeURIComponent(m.standee.agentId)}`
		: m.username
			? `/u/${encodeURIComponent(m.username)}`
			: '';
	const figure = live
		? `<div class="cw-figure" data-model="${esc(model)}" data-label="${esc(label)}"></div>`
		: `<div class="cw-figure"><img class="cw-figure-img" src="${esc(
				m.standee?.thumbUrl || m.avatarUrl || '/favicon.svg',
			)}" alt="" loading="lazy" decoding="async" /></div>`;

	const tag = href ? 'a' : 'div';
	return (
		`<${tag} class="cw-standee" data-online="${m.online ? 'true' : 'false'}"` +
		(href ? ` href="${esc(href)}"` : '') +
		` title="${esc(label)} · ${esc(presenceLine(m))}">` +
		figure +
		'<span class="cw-plinth"></span>' +
		'<span class="cw-nameplate">' +
		`<b>${esc(m.name)}</b>` +
		`<span class="${m.online ? 'cw-live' : ''}">${esc(presenceLine(m))}</span>` +
		'</span>' +
		`</${tag}>`
	);
}

// The live figures are mounted only when they scroll into the stage, so a crew
// wider than the viewport never pays for the members you cannot see.
function mountFigures(stage) {
	const pending = stage.querySelectorAll('.cw-figure[data-model]');
	if (!pending.length) return;
	if (!('IntersectionObserver' in window)) {
		pending.forEach(mountFigure);
		return;
	}
	const io = new IntersectionObserver(
		(entries) => {
			for (const e of entries) {
				if (!e.isIntersecting) continue;
				io.unobserve(e.target);
				mountFigure(e.target);
			}
		},
		{ root: stage, rootMargin: '160px' },
	);
	pending.forEach((el) => io.observe(el));
}

function mountFigure(el) {
	const model = el.dataset.model;
	if (!model) return;
	delete el.dataset.model;
	const tag = document.createElement('agent-3d');
	tag.setAttribute('src', model);
	tag.setAttribute('animation', 'idle');
	tag.setAttribute('hide-chrome', '');
	tag.setAttribute('aria-label', el.dataset.label || 'Crew member');
	el.appendChild(tag);
}

// ── roster ───────────────────────────────────────────────────────────────────
function renderRoster(members, { canKick }) {
	const list = $('cw-roster');
	list.innerHTML = members
		.map((m) => {
			const joined = joinedLabel(m.joinedAt);
			const meta = [presenceLine(m), joined ? `joined ${joined}` : ''].filter(Boolean).join(' · ');
			return (
				'<li class="cw-row">' +
				`<img class="cw-avatar" src="${esc(m.avatarUrl || m.standee?.thumbUrl || '/favicon.svg')}" alt="" loading="lazy" decoding="async" />` +
				'<span class="cw-row-main">' +
				`<b>${esc(m.name)}</b><span>${esc(meta)}</span>` +
				'</span>' +
				(m.role === 'owner' ? '<span class="cw-tag-badge owner">Owner</span>' : '') +
				(canKick && m.role !== 'owner'
					? `<button type="button" class="cw-btn sm danger" data-kick="${esc(m.id)}" data-name="${esc(m.name)}">Remove</button>`
					: '') +
				'</li>'
			);
		})
		.join('');

	list.querySelectorAll('[data-kick]').forEach((btn) => {
		btn.addEventListener('click', () => kickMember(btn.dataset.kick, btn.dataset.name));
	});
}

// ── invites addressed to me ──────────────────────────────────────────────────
function renderInvites(invites) {
	const panel = $('cw-invites-panel');
	const list = $('cw-invites');
	panel.hidden = !invites.length;
	if (!invites.length) return;
	list.innerHTML = invites
		.map(
			(i) =>
				'<div class="cw-invite">' +
				crestHtml(i.tag, true) +
				'<span class="cw-row-main">' +
				`<b>${esc(i.name)} <span class="cw-tag-badge">${esc(i.tag)}</span></b>` +
				`<span>Invited by ${esc(i.inviter?.name || 'a member')}</span>` +
				'</span>' +
				'<span class="cw-invite-actions">' +
				`<button type="button" class="cw-btn sm primary" data-accept="${esc(i.crewId)}">Accept</button>` +
				`<button type="button" class="cw-btn sm" data-decline="${esc(i.crewId)}">Decline</button>` +
				'</span>' +
				'</div>',
		)
		.join('');

	list.querySelectorAll('[data-accept]').forEach((b) =>
		b.addEventListener('click', () => respondToInvite('accept', b.dataset.accept, b)),
	);
	list.querySelectorAll('[data-decline]').forEach((b) =>
		b.addEventListener('click', () => respondToInvite('decline', b.dataset.decline, b)),
	);
}

// ── directory ────────────────────────────────────────────────────────────────
async function loadDirectory() {
	const wrap = $('cw-dir');
	try {
		const res = await apiFetch('/api/crews/directory?limit=24', { allowAnonymous: true });
		if (!res.ok) throw new Error(await readError(res));
		const { data } = await res.json();
		const crews = (data?.crews || []).filter((c) => c.tag !== state.me?.crew?.tag);
		if (!crews.length) {
			wrap.innerHTML =
				'<p class="cw-empty" style="grid-column:1/-1"><strong>No crews yet</strong>' +
				'Found the first one. Its tag is yours for good.</p>';
			return;
		}
		wrap.innerHTML = crews
			.map(
				(c) =>
					`<a class="cw-dir-card" href="/crews/${encodeURIComponent(c.tag)}" title="Open ${esc(c.name)}">` +
					crestHtml(c.tag, true) +
					'<span class="cw-row-main">' +
					`<b>${esc(c.name)}</b>` +
					`<span>${c.memberCount} member${c.memberCount === 1 ? '' : 's'}</span>` +
					'<span class="cw-faces">' +
					c.faces
						.map((f) =>
							f.avatarUrl
								? `<img src="${esc(f.avatarUrl)}" alt="" loading="lazy" decoding="async" />`
								: '<span class="cw-face-blank"></span>',
						)
						.join('') +
					'</span>' +
					'</span>' +
					'</a>',
			)
			.join('');
	} catch (err) {
		wrap.innerHTML =
			'<p class="cw-empty" style="grid-column:1/-1"><strong>The directory did not load</strong>' +
			esc(err.message || 'Try again in a moment.') +
			'</p>';
	}
}

// ── founding a crew ──────────────────────────────────────────────────────────
function wireFoundForm() {
	const form = $('cw-found');
	const tagInput = $('cw-found-tag');
	const nameInput = $('cw-found-name');
	const note = $('cw-found-tag-note');
	const submit = $('cw-found-submit');

	const validate = () => {
		const tag = tagInput.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
		if (tagInput.value !== tag) tagInput.value = tag;
		let msg = '';
		let tone = '';
		let ok = false;
		if (!tag) {
			msg = '2 to 6 letters or digits. This is the badge worn over your avatar in world.';
		} else if (!TAG_RE.test(tag)) {
			msg = tag.length < 2 ? 'A tag needs at least 2 characters.' : 'A tag is at most 6 characters.';
			tone = 'bad';
		} else if (RESERVED_TAGS.has(tag)) {
			msg = `${tag} is reserved by the site.`;
			tone = 'bad';
		} else {
			msg = `${tag} looks good.`;
			tone = 'good';
			ok = true;
		}
		note.textContent = msg;
		note.dataset.tone = tone;
		tagInput.setAttribute('aria-invalid', tone === 'bad' ? 'true' : 'false');
		submit.disabled = !ok || nameInput.value.trim().length < 2;
		return ok;
	};

	tagInput.addEventListener('input', validate);
	nameInput.addEventListener('input', validate);
	validate();

	form.addEventListener('submit', async (e) => {
		e.preventDefault();
		if (!validate()) return;
		submit.disabled = true;
		submit.textContent = 'Founding…';
		try {
			const res = await apiFetch('/api/crews', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					action: 'create',
					tag: tagInput.value.trim(),
					name: nameInput.value.trim(),
				}),
			});
			if (!res.ok) throw new Error(await readError(res));
			toast(`${tagInput.value.trim()} is yours. Invite your first member.`);
			await refresh();
		} catch (err) {
			toast(err.message || 'Could not found the crew.', 'bad');
			submit.disabled = false;
		} finally {
			submit.textContent = 'Found the crew';
		}
	});
}

// ── inviting ─────────────────────────────────────────────────────────────────
function wireInviteSearch() {
	const input = $('cw-invite-q');
	const results = $('cw-results');

	const run = async () => {
		const q = input.value.trim();
		if (q.length < 2) {
			results.innerHTML =
				'<li class="cw-empty">Type at least 2 characters of a name or username.</li>';
			return;
		}
		results.innerHTML = '<li class="cw-empty">Searching…</li>';
		try {
			const res = await apiFetch(`/api/crews/search?q=${encodeURIComponent(q)}`);
			if (!res.ok) throw new Error(await readError(res));
			const { data } = await res.json();
			const hits = data?.results || [];
			if (!hits.length) {
				results.innerHTML = `<li class="cw-empty">Nobody matches “${esc(q)}”.</li>`;
				return;
			}
			results.innerHTML = hits.map(inviteRowHtml).join('');
			results.querySelectorAll('[data-invite]').forEach((b) =>
				b.addEventListener('click', () => sendInvite(b.dataset.invite, b.dataset.name, b)),
			);
		} catch (err) {
			results.innerHTML = `<li class="cw-empty">${esc(err.message || 'Search failed.')}</li>`;
		}
	};

	input.addEventListener('input', () => {
		clearTimeout(state.searchTimer);
		state.searchTimer = setTimeout(run, SEARCH_DEBOUNCE_MS);
	});
}

// A hit renders its true state: already in a crew, already invited, or invitable.
// The reason is on the row, so nobody clicks a button that was always going to
// be refused.
function inviteRowHtml(u) {
	let action;
	if (u.crew) {
		action = `<span class="cw-tag-badge" title="Already flies ${esc(u.crew.name)}">${esc(u.crew.tag)}</span>`;
	} else if (u.invited) {
		action = '<span class="cw-tag-badge">Invited</span>';
	} else {
		action = `<button type="button" class="cw-btn sm primary" data-invite="${esc(u.id)}" data-name="${esc(u.name)}">Invite</button>`;
	}
	return (
		'<li class="cw-row">' +
		`<img class="cw-avatar" src="${esc(u.avatarUrl || '/favicon.svg')}" alt="" loading="lazy" decoding="async" />` +
		'<span class="cw-row-main">' +
		`<b>${esc(u.name)}</b><span>${u.username ? '@' + esc(u.username) : 'No username'}</span>` +
		'</span>' +
		action +
		'</li>'
	);
}

async function sendInvite(userId, name, btn) {
	btn.disabled = true;
	btn.textContent = 'Inviting…';
	try {
		const res = await apiFetch('/api/crews', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ action: 'invite', userId }),
		});
		if (!res.ok) throw new Error(await readError(res));
		btn.replaceWith(Object.assign(document.createElement('span'), {
			className: 'cw-tag-badge',
			textContent: 'Invited',
		}));
		toast(`Invite sent to ${name}.`);
	} catch (err) {
		btn.disabled = false;
		btn.textContent = 'Invite';
		toast(err.message || 'Could not send that invite.', 'bad');
	}
}

async function respondToInvite(action, crewId, btn) {
	const buttons = btn.closest('.cw-invite').querySelectorAll('button');
	buttons.forEach((b) => (b.disabled = true));
	try {
		const res = await apiFetch('/api/crews', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ action, crewId }),
		});
		if (!res.ok) throw new Error(await readError(res));
		toast(action === 'accept' ? 'You are in. Welcome to the crew.' : 'Invite declined.');
		await refresh();
	} catch (err) {
		buttons.forEach((b) => (b.disabled = false));
		toast(err.message || 'That did not go through.', 'bad');
	}
}

// ── destructive actions ──────────────────────────────────────────────────────
async function leaveCrew() {
	const crew = state.me?.crew;
	if (!crew) return;
	const lastOne = (state.me.members || []).length <= 1;
	const warning = lastOne
		? `You are the only member of ${crew.name}. Leaving disbands the crew and frees the tag ${crew.tag}. Continue?`
		: crew.isOwner
			? `Leave ${crew.name}? Ownership passes to the longest-standing member.`
			: `Leave ${crew.name}?`;
	if (!confirm(warning)) return;
	try {
		const res = await apiFetch('/api/crews', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ action: 'leave' }),
		});
		if (!res.ok) throw new Error(await readError(res));
		const { data } = await res.json();
		toast(data?.disbanded ? `${crew.name} has been disbanded.` : `You left ${crew.name}.`);
		await refresh();
	} catch (err) {
		toast(err.message || 'Could not leave the crew.', 'bad');
	}
}

async function kickMember(userId, name) {
	if (!confirm(`Remove ${name} from the crew?`)) return;
	try {
		const res = await apiFetch('/api/crews', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ action: 'kick', userId }),
		});
		if (!res.ok) throw new Error(await readError(res));
		toast(`${name} was removed.`);
		await refresh();
	} catch (err) {
		toast(err.message || 'Could not remove that member.', 'bad');
	}
}

async function shareCrew(tag) {
	const url = `${location.origin}/crews/${encodeURIComponent(tag)}`;
	try {
		await navigator.clipboard.writeText(url);
		toast('Public crew link copied.');
	} catch {
		// Clipboard is blocked in some embedded contexts; show the URL so the
		// action still succeeds by hand rather than failing silently.
		toast(url, 'good');
	}
}

// ── loading ──────────────────────────────────────────────────────────────────
function showSkeleton() {
	$('cw-room').hidden = false;
	$('cw-stage').innerHTML =
		'<div class="cw-skeleton">' +
		Array.from({ length: 4 }, () => '<div class="cw-shimmer"></div>').join('') +
		'</div>';
	$('cw-room-head').innerHTML = '<div class="cw-room-title"><h2>Loading the HQ…</h2></div>';
}

function showError(message, retry) {
	const box = $('cw-error');
	box.hidden = false;
	box.innerHTML = `<p>${esc(message)}</p><button type="button" class="cw-btn" id="cw-retry">Try again</button>`;
	$('cw-retry').addEventListener('click', () => {
		box.hidden = true;
		retry();
	});
}

async function loadPublicCrew(tag) {
	showSkeleton();
	try {
		const res = await apiFetch(`/api/crews/${encodeURIComponent(tag)}`, { allowAnonymous: true });
		if (res.status === 404) {
			$('cw-room').hidden = true;
			$('cw-manage').hidden = true;
			showError(`No crew flies the tag ${tag}. It is still available.`, () => loadPublicCrew(tag));
			$('cw-found-panel').hidden = false;
			$('cw-found-tag').value = tag;
			$('cw-found-tag').dispatchEvent(new Event('input'));
			return;
		}
		if (!res.ok) throw new Error(await readError(res));
		const { data } = await res.json();
		const crew = data.crew;
		state.viewing = { crew, members: crew.members };
		document.title = `${crew.name} (${crew.tag}) · Crew HQ · three.ws`;
		renderRoom(crew, crew.members, { canManage: false });
		renderRoster(crew.members, { canKick: false });
		$('cw-roster-panel').hidden = false;
		$('cw-public-note').hidden = false;
		$('cw-public-note').innerHTML =
			`Viewing <b>${esc(crew.name)}</b> as a visitor. <a href="/crews">Your own Crew HQ</a> is one click away.`;
	} catch (err) {
		$('cw-room').hidden = true;
		showError(err.message || 'That crew could not be loaded.', () => loadPublicCrew(tag));
	}
}

async function loadMine() {
	try {
		const res = await apiFetch('/api/crews', { allowAnonymous: true });
		if (res.status === 401) {
			state.authed = false;
			state.me = null;
			return;
		}
		if (!res.ok) throw new Error(await readError(res));
		const { data } = await res.json();
		state.authed = true;
		state.me = data;
	} catch (err) {
		state.authed = false;
		state.me = null;
		throw err;
	}
}

// Re-read everything and re-render. Used after every mutation and by the
// presence poll, so the room is never a stale snapshot of who is in world.
async function refresh() {
	if (state.mode === 'public') return loadPublicCrew(state.publicTag);
	try {
		await loadMine();
	} catch (err) {
		showError(err.message || 'Your crew could not be loaded.', refresh);
		return;
	}
	renderMine();
}

function renderMine() {
	const signedOut = !state.authed;
	const crew = state.me?.crew || null;
	const members = state.me?.members || [];

	$('cw-signedout').hidden = !signedOut;
	$('cw-found-panel').hidden = signedOut || !!crew;
	$('cw-manage').hidden = !crew;
	$('cw-roster-panel').hidden = !crew;
	$('cw-room').hidden = !crew;
	$('cw-dir-panel').hidden = false;

	renderInvites(signedOut ? [] : state.me?.invites || []);

	if (crew) {
		renderRoom(crew, members, { canManage: true });
		renderRoster(members, { canKick: crew.isOwner });
		document.title = `${crew.name} (${crew.tag}) · Crew HQ · three.ws`;
		$('cw-manage-hint').textContent = crew.isOwner
			? 'You own this crew. Invite anyone with an account; they join the moment they accept.'
			: 'Invite anyone with an account to fly your tag. Only the owner can remove members.';
	}
	state.loaded = true;
}

// ── presence polling ─────────────────────────────────────────────────────────
// Only while the tab is visible: an idle background tab does not need to know
// who walked into a realm, and a poll it cannot show is wasted DB and Redis.
function startPolling() {
	const tick = async () => {
		if (document.visibilityState !== 'visible') return;
		if (!state.loaded) return;
		try {
			if (state.mode === 'public') await loadPublicCrew(state.publicTag);
			else if (state.me?.crew) {
				await loadMine();
				renderMine();
			}
		} catch {
			// A failed poll is not an error state — the last good render stands and
			// the next tick tries again.
		}
	};
	state.pollTimer = setInterval(tick, PRESENCE_POLL_MS);
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'visible') tick();
	});
}

// ── boot ─────────────────────────────────────────────────────────────────────
function tagFromPath() {
	const m = location.pathname.match(/^\/crews\/([A-Za-z0-9]{2,6})\/?$/);
	return m ? m[1].toUpperCase() : '';
}

async function boot() {
	wireFoundForm();
	wireInviteSearch();

	const tag = tagFromPath();
	if (tag) {
		state.mode = 'public';
		state.publicTag = tag;
		$('cw-found-panel').hidden = true;
		$('cw-dir-panel').hidden = false;
		await Promise.all([loadPublicCrew(tag), loadDirectory()]);
		// A visitor who is signed in still gets their invites, so a link shared in
		// chat and an invite sitting in the app converge on the same page.
		try {
			await loadMine();
			renderInvites(state.me?.invites || []);
		} catch {
			/* an anonymous visitor simply has no invites */
		}
		state.loaded = true;
	} else {
		showSkeleton();
		await refresh();
		await loadDirectory();
	}
	startPolling();
}

boot();
