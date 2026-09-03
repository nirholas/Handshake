/**
 * The manage view: states 6 (connected), 9 (degraded) and 11 (many homes).
 *
 * One list that scales from one house to many without a redesign, a measured
 * summary per house rather than an assumed one, the standing allowances with a
 * revoke on each, the action log, and a disconnect that says plainly what it
 * does to the stored token.
 *
 * State 9 is the one that separates a product from a demo: when a house stops
 * answering, the last known room list stays on screen, visibly marked stale with
 * its age. A user watching their home should see it go grey, not watch it vanish.
 */

import { clear, el, noticeEl } from './connect.js';

/** Past this, "moments ago" stops being honest. */
const STALE_AFTER_MS = 90_000;

export function renderManage({ homes, notice, onDisconnect, onReconnect }) {
	const frag = document.createDocumentFragment();
	if (notice) frag.append(noticeEl(notice));

	const panel = el('section', 'hm-panel');
	const head = el('div', 'hm-panel-head');
	const heading = el('div');
	heading.append(
		el('h2', 'hm-panel-title', homes.length === 1 ? 'Your home' : `Your homes (${homes.length})`),
		el('p', 'hm-panel-sub', 'Your agent can read everything here. Anything that unlocks, opens or disarms still stops and asks, unless you have granted it below.'),
	);
	head.append(heading);

	const headActions = el('div', 'hm-card-actions');
	// The plan surface, reachable from the place a person is when they wonder how
	// many of these they are allowed. A limit that can only be found after it
	// refuses you was never shown to you.
	const plan = el('a', 'hm-btn hm-btn-ghost', 'Plan and usage');
	plan.href = '/smart-home/plan';
	headActions.append(plan);

	const add = el('button', 'hm-btn hm-btn-ghost', 'Connect another');
	add.type = 'button';
	add.addEventListener('click', () => onReconnect && onReconnect());
	headActions.append(add);
	head.append(headActions);
	panel.append(head);

	const list = el('ul', 'hm-list');
	for (const home of homes) list.append(homeCard(home, { onDisconnect }));
	panel.append(list);
	frag.append(panel);
	return frag;
}

function homeCard(home, { onDisconnect }) {
	const li = el('li');
	const card = el('div', 'hm-card');

	const main = el('div', 'hm-card-main');
	// textContent throughout: the label is whatever the user typed and the URL is
	// whatever they pasted.
	main.append(el('p', 'hm-card-label', home.label || hostOf(home.base_url)));
	main.append(el('p', 'hm-card-url', home.base_url || ''));
	main.append(statusLine(home));

	const actions = el('div', 'hm-card-actions');
	// The live 3D house is the product, so it leads. "Open" beside it is the
	// settings view for the same home: grants, the action log, disconnect.
	const scene = el('a', 'hm-btn', 'Live 3D home');
	scene.href = `/home/${encodeURIComponent(home.id)}`;
	const open = el('a', 'hm-btn hm-btn-ghost', 'Open');
	open.href = `/smart-home/${encodeURIComponent(home.id)}`;
	const drop = el('button', 'hm-btn hm-btn-danger', 'Disconnect');
	drop.type = 'button';
	drop.addEventListener('click', () => confirmDisconnect(card, home, onDisconnect));
	actions.append(scene, open, drop);

	card.append(main, actions);
	li.append(card);

	const detail = el('div');
	detail.style.marginTop = 'var(--space-sm)';
	detail.append(summary(home));
	detail.append(grantsPanel(home));
	detail.append(logPanel(home));
	li.append(detail);
	return li;
}

/**
 * The standing allowances, with a revoke on each.
 *
 * Loaded on expand rather than on page load: a user with six houses should not
 * pay six extra round trips to see a list most of them will be empty.
 */
function grantsPanel(home) {
	return lazyPanel({
		title: 'Standing allowances',
		summary: 'What your agent may open without asking you first.',
		load: () => getJson(`/api/home/${encodeURIComponent(home.id)}/grants`),
		render: (body, rerender) => {
			const grants = Array.isArray(body?.grants) ? body.grants : [];
			if (!grants.length) {
				return emptyBlock(
					'Nothing is pre-approved.',
					'Every unlock, every opening and every disarm stops and asks you. When you grant one, it appears here with a revoke.',
				);
			}
			const list = el('ul', 'hm-rows');
			for (const grant of grants) list.append(grantRow(home, grant, rerender));
			return list;
		},
	});
}

function grantRow(home, grant, rerender) {
	const li = el('li', 'hm-row');
	const main = el('div', 'hm-row-main');
	// An entity id is a string the house controls. Text only.
	const title = el('p', 'hm-row-title');
	title.append(el('span', 'hm-mono', grant.entity_id));
	main.append(title);
	main.append(el('p', 'hm-row-meta', grant.expires_at
		? `Allowed until ${formatWhen(grant.expires_at)}.`
		: 'Allowed until you revoke it.'));

	const revoke = el('button', 'hm-btn hm-btn-danger', 'Revoke');
	revoke.type = 'button';
	revoke.addEventListener('click', async () => {
		revoke.disabled = true;
		revoke.textContent = 'Revoking';
		try {
			await sendJson(`/api/home/${encodeURIComponent(home.id)}/grants?entity_id=${encodeURIComponent(grant.entity_id)}`, 'DELETE');
			rerender();
		} catch (err) {
			revoke.disabled = false;
			revoke.textContent = 'Try again';
			main.append(el('p', 'hm-row-meta', err?.message || 'That did not go through.'));
		}
	});

	li.append(main, revoke);
	return li;
}

/** Every write the platform made in this house, refusals included. */
function logPanel(home) {
	return lazyPanel({
		title: 'What happened in this house',
		summary: 'Every action your agent took, and every one it refused.',
		load: () => getJson(`/api/home/${encodeURIComponent(home.id)}/log?limit=25`),
		render: (body) => {
			const rows = Array.isArray(body?.actions) ? body.actions : [];
			if (!rows.length) {
				return emptyBlock(
					'Nothing yet.',
					'Once your agent turns a light on or refuses to open a door, it lands here with who asked and what happened.',
				);
			}
			const list = el('ul', 'hm-rows');
			for (const row of rows) list.append(logRow(row));
			return list;
		},
	});
}

function logRow(row) {
	const li = el('li', 'hm-row');
	const main = el('div', 'hm-row-main');
	const title = el('p', 'hm-row-title');
	title.append(el('span', 'hm-mono', row.action || 'unknown action'));
	main.append(title);

	const targets = Array.isArray(row.entity_ids) ? row.entity_ids : [];
	const parts = [
		`${formatWhen(row.created_at)}`,
		`by ${row.actor || 'unknown'}`,
		targets.length ? targets.join(', ') : null,
		row.guarded ? (row.confirmed_by ? 'confirmed by a person' : 'stopped by the gate') : null,
	].filter(Boolean);
	main.append(el('p', 'hm-row-meta', parts.join(' · ')));

	const outcome = String(row.outcome || 'ok');
	const tag = el('span', `hm-tag hm-tag-${outcome}`, outcome === 'refused' ? 'refused' : outcome === 'failed' ? 'failed' : 'done');
	li.append(main, tag);
	return li;
}

/**
 * A collapsed section that fetches on first open, keeps a skeleton the exact
 * height of its content while it loads, and renders its own error state rather
 * than throwing the whole page away.
 */
function lazyPanel({ title, summary: summaryText, load, render }) {
	const wrap = el('details', 'hm-panel');
	wrap.style.marginTop = 'var(--space-sm)';
	wrap.style.background = 'transparent';

	const head = el('summary');
	head.style.cursor = 'pointer';
	head.append(el('span', '', title));
	wrap.append(head);

	const caption = el('p', 'hm-hint', summaryText);
	wrap.append(caption);

	const body = el('div');
	body.style.marginTop = 'var(--space-sm)';
	wrap.append(body);

	let loaded = false;
	const run = async () => {
		clear(body);
		const skeleton = el('div', 'hm-skeleton');
		skeleton.style.height = '3.4rem';
		body.append(skeleton);
		try {
			const data = await load();
			clear(body);
			body.append(render(data, run));
		} catch (err) {
			clear(body);
			body.append(noticeEl({
				tone: 'error',
				title: 'We could not load this.',
				body: err?.message || 'Try opening it again in a moment.',
			}));
		}
	};

	wrap.addEventListener('toggle', () => {
		if (!wrap.open || loaded) return;
		loaded = true;
		run();
	});
	return wrap;
}

function emptyBlock(title, body) {
	const wrap = el('div', 'hm-empty');
	wrap.style.padding = 'var(--space-md) 0';
	wrap.append(el('p', 'hm-empty-title', title), el('p', 'hm-empty-body', body));
	return wrap;
}

async function getJson(url) {
	const res = await fetch(url, { credentials: 'include', headers: { accept: 'application/json' } });
	const body = await res.json().catch(() => null);
	if (!res.ok) throw new Error(body?.message || body?.error_description || `Request failed (${res.status}).`);
	return body;
}

async function sendJson(url, method) {
	const headers = { accept: 'application/json' };
	try {
		const csrfRes = await fetch('/api/csrf-token', { credentials: 'include' });
		if (csrfRes.ok) {
			const csrf = await csrfRes.json();
			const token = csrf?.token || csrf?.data?.token;
			if (token) headers['x-csrf-token'] = token;
		}
	} catch {
		// No CSRF token available: let the server refuse rather than guessing.
	}
	const res = await fetch(url, { method, credentials: 'include', headers });
	const body = await res.json().catch(() => null);
	if (!res.ok) throw new Error(body?.message || body?.error_description || `Request failed (${res.status}).`);
	return body;
}

function formatWhen(iso) {
	const at = Date.parse(iso || '');
	if (!Number.isFinite(at)) return 'an unknown time';
	return new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * The measured summary. Every number here came back from the house at connect
 * time; a capability we could not measure prints as "not measured", never as a
 * confident zero.
 */
function summary(home) {
	const caps = home.capabilities || {};
	const wrap = el('div', 'hm-stats');
	wrap.append(
		stat(count(caps.areaCount), 'Rooms'),
		stat(count(caps.entityCount), 'Devices'),
		stat(count(caps.macroCount), 'Scenes'),
		stat(caps.haVersion || 'Not measured', 'Home Assistant'),
	);

	const holder = el('div');
	holder.append(wrap);

	// A house without mcp_server is an ordinary house, so this is an upgrade
	// offer, never an error.
	if (caps.mcp) {
		holder.append(noticeEl({
			tone: 'ok',
			title: `Model Context Protocol server connected (${count(caps.mcpToolCount)} tools).`,
			body: 'Your agent uses the exact tools you exposed in Home Assistant, with your own exposure rules.',
		}));
	} else if (caps.websocket) {
		holder.append(noticeEl({
			tone: 'info',
			title: 'Optional: turn on the Model Context Protocol server.',
			body: 'Add the Model Context Protocol Server integration in Home Assistant, under Settings, Devices and services, to give your agent the exact tool set you curated. Everything already works without it.',
		}));
	}
	return holder;
}

function stat(value, label) {
	const box = el('div', 'hm-stat');
	box.append(el('span', 'hm-stat-value', value), el('span', 'hm-stat-label', label));
	return box;
}

function count(value) {
	return Number.isFinite(Number(value)) ? String(Number(value)) : 'Not measured';
}

/**
 * State 9 lives here. A connected home whose last handshake has aged past the
 * window is rendered as stale with its age spelled out, so "is this live?" is
 * answerable at a glance rather than inferred from a dot nobody can read.
 */
function statusLine(home) {
	const wrap = el('p', 'hm-status');
	const stale = isStale(home);
	const key = stale ? 'stale' : home.status || 'pending';

	const dot = el('span', `hm-dot hm-dot-${key}`);
	dot.setAttribute('aria-hidden', 'true');
	wrap.append(dot, el('span', '', statusText(home, stale)));
	return wrap;
}

function isStale(home) {
	if (home.status !== 'connected') return false;
	const last = Date.parse(home.last_ok_at || '');
	if (!Number.isFinite(last)) return false;
	return Date.now() - last > STALE_AFTER_MS;
}

function statusText(home, stale) {
	if (stale) return `Last answered ${ago(home.last_ok_at)}. Showing the last state we saw.`;
	switch (home.status) {
		case 'connected': return `Live${home.last_ok_at ? `, updated ${ago(home.last_ok_at)}` : ''}.`;
		case 'auth_failed': return home.status_detail || 'Home Assistant rejected the stored token. Reconnect with a new one.';
		case 'unreachable': return home.status_detail || 'Not answering right now. The last state we saw is below.';
		case 'revoked': return 'Disconnected.';
		default: return home.status_detail || 'Connecting.';
	}
}

/** Plain language, and never a future tense for a past timestamp. */
function ago(iso) {
	const then = Date.parse(iso || '');
	if (!Number.isFinite(then)) return 'at an unknown time';
	const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
	if (seconds < 45) return 'moments ago';
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
	const days = Math.round(hours / 24);
	return `${days} day${days === 1 ? '' : 's'} ago`;
}

/**
 * Disconnecting destroys a credential, so it confirms in place rather than
 * behind a browser dialog: the confirmation says exactly what happens to the
 * token, on our side and on theirs.
 */
function confirmDisconnect(card, home, onDisconnect) {
	const existing = card.parentElement.querySelector('[data-confirm]');
	if (existing) existing.remove();

	const box = el('div', 'hm-notice hm-notice-warn');
	box.dataset.confirm = 'true';
	box.setAttribute('role', 'alertdialog');
	box.setAttribute('aria-label', `Disconnect ${home.label || 'this home'}`);

	const content = el('div');
	content.append(
		el('p', 'hm-notice-title', `Disconnect ${home.label || hostOf(home.base_url)}?`),
		el('p', 'hm-notice-body', 'The access token we hold is erased immediately and your agent loses all access to this house. Your standing allowances and the action log are kept so you can still read what happened.'),
		el('p', 'hm-notice-body', 'This does not delete the token inside Home Assistant. Delete it there too if you want it gone on both sides.'),
	);

	const actions = el('div', 'hm-actions');
	actions.style.marginTop = 'var(--space-sm)';
	const yes = el('button', 'hm-btn hm-btn-danger', 'Disconnect and erase the token');
	yes.type = 'button';
	const no = el('button', 'hm-btn hm-btn-ghost', 'Keep it connected');
	no.type = 'button';

	no.addEventListener('click', () => {
		box.remove();
		card.querySelector('.hm-btn-danger')?.focus();
	});
	yes.addEventListener('click', async () => {
		yes.disabled = true;
		no.disabled = true;
		yes.textContent = 'Disconnecting';
		try {
			await onDisconnect(home);
		} catch (err) {
			clear(content);
			content.append(
				el('p', 'hm-notice-title', 'That did not go through.'),
				el('p', 'hm-notice-body', err?.message || 'Try again in a moment.'),
			);
			yes.disabled = false;
			no.disabled = false;
			yes.textContent = 'Try again';
		}
	});

	actions.append(yes, no);
	content.append(actions);
	box.append(content);
	card.parentElement.append(box);
	yes.focus();
}

function hostOf(url) {
	try {
		return new URL(url).host;
	} catch {
		return url || 'this home';
	}
}
