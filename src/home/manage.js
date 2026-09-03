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

	const add = el('button', 'hm-btn hm-btn-ghost', 'Connect another');
	add.type = 'button';
	add.addEventListener('click', () => onReconnect && onReconnect());
	head.append(add);
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
	const open = el('a', 'hm-btn hm-btn-ghost', 'Open');
	open.href = `/smart-home/${encodeURIComponent(home.id)}`;
	const drop = el('button', 'hm-btn hm-btn-danger', 'Disconnect');
	drop.type = 'button';
	drop.addEventListener('click', () => confirmDisconnect(card, home, onDisconnect));
	actions.append(open, drop);

	card.append(main, actions);
	li.append(card);

	const detail = el('div');
	detail.style.marginTop = 'var(--space-sm)';
	detail.append(summary(home));
	li.append(detail);
	return li;
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
