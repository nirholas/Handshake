/**
 * /smart-home/privacy: everything three.ws holds about your connected homes.
 *
 * The endpoint behind this screen existed before the screen did, which made it
 * a dead path: a user could exercise none of it without a terminal. This is the
 * surface that makes the promises in docs/home-privacy.md things a person can
 * act on rather than things they have to trust.
 *
 * Four jobs, in the order somebody actually wants them:
 *
 *   1. SEE IT. The inventory, rendered from the server's own list rather than a
 *      copy in this file, next to live counts of what is actually stored. A row
 *      the server marks as never-persisted renders as a promise, not a zero,
 *      because "0 entity states" invites the question "so where do they go".
 *   2. CONTROL IT. The action-log window, per home, applied immediately with the
 *      number of rows that went.
 *   3. EXPORT IT. One link. It is a link and not a fetch on purpose: the
 *      response sets Content-Disposition, so the browser saves it properly.
 *   4. DELETE IT. Per home, or everything. Both are irreversible and neither is
 *      one click: they confirm in place, and the destructive one asks the person
 *      to type the word rather than to click a second button they have already
 *      decided to click.
 *
 * Deliberately NOT the disconnect on the manage screen. Disconnecting erases the
 * credential and keeps the record so the action log keeps its lineage; this is
 * the other verb, and the screen says so where somebody might confuse them.
 */

import {
	PRIVACY_EXPORT_URL,
	deleteHomeData,
	getPrivacy,
	setRetention,
} from './api.js';
import { clear, el, noticeEl } from './connect.js';
import {
	DELETE_ALL_PHRASE,
	RETENTION_PRESETS,
	deletedSentence,
	describeWindow,
	phraseMatches,
	statRows,
} from './privacy-copy.js';

const root = document.getElementById('hm-root');

let state = { loading: true, data: null, error: null, notice: null };

boot();

async function boot() {
	render();
	await load();
}

async function load() {
	try {
		const data = await getPrivacy();
		state = { ...state, loading: false, data, error: null };
	} catch (err) {
		state = {
			...state,
			loading: false,
			error:
				err?.code === 'unauthorized'
					? { title: 'Sign in to see your data', body: 'This page shows what we store about your homes, so it can only show it to you.', action: { label: 'Sign in', href: `/login?next=${encodeURIComponent('/smart-home/privacy')}` } }
					: { title: 'Could not load your data', body: err?.message || 'Something went wrong. Try again in a moment.', action: { label: 'Retry', onClick: retry } },
		};
	}
	render();
}

function retry() {
	state = { ...state, loading: true, error: null };
	render();
	return load();
}

function render() {
	if (!root) return;
	clear(root);

	root.append(header());

	if (state.notice) root.append(noticeEl(state.notice));

	if (state.loading) return root.append(skeleton());
	if (state.error) {
		return root.append(
			noticeEl({
				tone: 'error',
				title: state.error.title,
				body: state.error.body,
				action: state.error.action,
			}),
		);
	}

	const { data } = state;
	root.append(summaryPanel(data));
	if (data.homes?.length) root.append(retentionPanel(data));
	root.append(inventoryPanel(data));
	root.append(exportPanel());
	root.append(deletePanel(data));
}

function header() {
	const head = el('header', 'hm-head');
	head.append(
		el('p', 'hm-eyebrow', 'Your data'),
		el('h1', 'hm-title', 'What we store about your homes'),
		el(
			'p',
			'hm-sub',
			'All of it, with why it exists and how long it stays. Everything on this page is yours to export or delete, without asking anyone.',
		),
	);
	return head;
}

/**
 * Real structure, not a spinner: the shape of the page it becomes is already on
 * screen, so nothing jumps when the data lands. `hm-skeleton` is the shimmering
 * element itself here, matching the rest of the surface, rather than a wrapper.
 */
function skeleton() {
	const wrap = el('div');
	wrap.setAttribute('aria-busy', 'true');
	wrap.setAttribute('aria-label', 'Loading what we store about your homes');
	for (const height of ['7rem', '11rem', '16rem']) {
		const panel = el('section', 'hm-panel');
		const bar = el('div', 'hm-skeleton');
		bar.style.height = height;
		panel.append(bar);
		wrap.append(panel);
	}
	return wrap;
}

// ── 1. See it ────────────────────────────────────────────────────────────────

function summaryPanel(data) {
	const panel = el('section', 'hm-panel');
	panel.append(el('h2', 'hm-panel-title', 'Right now'));

	const live = (data.homes || []).filter((h) => !h.revoked_at).length;
	const counts = data.counts || {};

	if (!live && !counts.home_members) {
		panel.append(
			el(
				'p',
				'hm-panel-sub',
				'You have not connected a home, so there is nothing here yet. When you do, this page will show every row it creates.',
			),
		);
		const link = el('a', 'hm-btn hm-btn-primary', 'Connect a home');
		link.href = '/smart-home';
		const actions = el('div', 'hm-actions');
		actions.append(link);
		panel.append(actions);
		return panel;
	}

	const stats = el('div', 'hm-stats');
	for (const [label, value] of statRows(data)) {
		const stat = el('div', 'hm-stat');
		stat.append(el('span', 'hm-stat-value', String(value)), el('span', 'hm-stat-label', label));
		stats.append(stat);
	}
	panel.append(stats);
	return panel;
}


function inventoryPanel(data) {
	const panel = el('section', 'hm-panel');
	panel.append(
		el('h2', 'hm-panel-title', 'Everything we hold, and everything we do not'),
		el(
			'p',
			'hm-panel-sub',
			'This list comes from the code that stores it, not from a document somebody remembered to update.',
		),
	);

	const kept = (data.inventory || []).filter((row) => row.table);
	const never = (data.inventory || []).filter((row) => !row.table);

	// The promises first. They are the part somebody came to check, and putting
	// them under a table of what we DO keep buries the better news.
	if (never.length) {
		const promises = el('div', 'hm-promises');
		promises.append(el('h3', 'hm-promises-title', 'Never stored'));
		const list = el('ul', 'hm-promises-list');
		for (const row of never) {
			const item = el('li');
			item.append(el('strong', '', row.data), el('span', '', ` ${row.retention}`));
			list.append(item);
		}
		promises.append(list);
		panel.append(promises);
	}

	const scroll = el('div', 'table-scroll');
	scroll.setAttribute('role', 'region');
	scroll.setAttribute('tabindex', '0');
	scroll.setAttribute('aria-label', 'What we store');
	const table = el('table', 'hm-table');
	const thead = el('thead');
	const hrow = el('tr');
	for (const h of ['What', 'Why', 'How long', 'What removes it']) hrow.append(el('th', '', h));
	thead.append(hrow);
	table.append(thead);
	const tbody = el('tbody');
	for (const row of kept) {
		const tr = el('tr');
		const what = el('td');
		what.append(el('span', '', row.data));
		if (row.sensitive) {
			const tag = el('span', 'hm-tag', 'sensitive');
			tag.title = 'Encrypted at rest, or removed the moment it stops being needed.';
			what.append(tag);
		}
		tr.append(what, el('td', '', row.why), el('td', '', row.retention), el('td', '', row.deletedBy));
		tbody.append(tr);
	}
	table.append(tbody);
	scroll.append(table);
	panel.append(scroll);

	const more = el('a', 'hm-disclosure-more', 'The full version, with the schema');
	more.href = '/docs/home-privacy';
	panel.append(more);
	return panel;
}

// ── 2. Control it ────────────────────────────────────────────────────────────

function retentionPanel(data) {
	const panel = el('section', 'hm-panel');
	panel.append(
		el('h2', 'hm-panel-title', 'How long your action log lives'),
		el(
			'p',
			'hm-panel-sub',
			'The log is how you check what your agent did in your house. Read the other way round it is a record of when you were home, so the window is yours. Shortening it takes effect immediately.',
		),
	);

	for (const home of (data.homes || []).filter((h) => !h.revoked_at)) {
		panel.append(retentionRow(home, data.retention || {}));
	}
	return panel;
}

function retentionRow(home, bounds) {
	const row = el('div', 'hm-retention');
	const head = el('div', 'hm-retention-head');
	head.append(
		el('span', 'hm-retention-home', home.label || 'This home'),
		el('span', 'hm-retention-current', describeWindow(home.action_log_retention_days)),
	);
	row.append(head);

	if (home.action_log_retention_reason) {
		row.append(el('p', 'hm-hint', `Kept longer because: ${home.action_log_retention_reason}`));
	}

	const group = el('div', 'hm-retention-choices');
	group.setAttribute('role', 'group');
	group.setAttribute('aria-label', `Action-log window for ${home.label || 'this home'}`);

	for (const preset of RETENTION_PRESETS) {
		const btn = el('button', 'hm-chip', preset.label);
		btn.type = 'button';
		const current = preset.days === home.action_log_retention_days;
		btn.setAttribute('aria-pressed', current ? 'true' : 'false');
		if (current) btn.classList.add('hm-chip-on');
		btn.addEventListener('click', () => applyRetention(home, preset.days, row));
		group.append(btn);
	}
	row.append(group);
	return row;
}


/**
 * A window longer than the default has to say why, so the reason is asked for
 * in the row rather than in a browser prompt: a native prompt() is unstyled,
 * blocked in some embedding contexts, and gives a person nowhere to read the
 * sentence explaining what they are being asked. This asks in place, keeps the
 * choice visible while they type, and cancels without changing anything.
 */
function askReason(home, days, row) {
	row.querySelector('.hm-reason')?.remove();
	const box = el('div', 'hm-reason');
	const id = `hm-reason-${home.id}`;
	const label = el('label', 'hm-label', `Why does ${home.label || 'this home'} keep its log for ${describeWindow(days).replace('Kept for ', '')}?`);
	label.htmlFor = id;
	const input = el('input', 'hm-input');
	input.id = id;
	input.type = 'text';
	input.maxLength = 500;
	input.placeholder = 'Building operator: incident records are kept for a year.';
	const hint = el('p', 'hm-hint', 'Kept on the record, so the answer to "why does this building hold a year of data" exists before anyone asks.');
	hint.id = `${id}-hint`;
	input.setAttribute('aria-describedby', hint.id);

	const actions = el('div', 'hm-actions');
	const save = el('button', 'hm-btn hm-btn-primary', 'Save this window');
	save.type = 'button';
	save.disabled = true;
	const cancel = el('button', 'hm-btn hm-btn-ghost', 'Cancel');
	cancel.type = 'button';
	cancel.addEventListener('click', () => box.remove());
	input.addEventListener('input', () => {
		save.disabled = input.value.trim().length < 8;
	});
	save.addEventListener('click', () => {
		box.remove();
		applyRetention(home, days, row, input.value.trim());
	});
	actions.append(save, cancel);
	box.append(label, input, hint, actions);
	row.append(box);
	queueMicrotask(() => input.focus());
}

async function applyRetention(home, days, row, reason = null) {
	if (days > 90 && !reason) return askReason(home, days, row);

	const buttons = [...row.querySelectorAll('button')];
	for (const b of buttons) b.disabled = true;
	try {
		const result = await setRetention(home.id, days, reason);
		state.notice = {
			tone: 'ok',
			title: `${home.label || 'This home'} now keeps ${days === 1 ? 'a day' : `${days} days`}`,
			body: result.purged
				? `${result.purged} ${result.purged === 1 ? 'entry was' : 'entries were'} deleted straight away.`
				: 'Nothing needed deleting: no entry was older than the new window.',
		};
		await load();
	} catch (err) {
		state.notice = {
			tone: 'error',
			title: 'Could not change the window',
			body:
				err?.code === 'retention_over_plan'
					? err.message
					: err?.message || 'Something went wrong. Nothing was changed.',
			action: err?.code === 'retention_over_plan' ? { label: 'See plans', href: '/pricing' } : null,
		};
		render();
	} finally {
		for (const b of buttons) b.disabled = false;
	}
}

// ── 3. Export it ─────────────────────────────────────────────────────────────

function exportPanel() {
	const panel = el('section', 'hm-panel');
	panel.append(
		el('h2', 'hm-panel-title', 'Take a copy'),
		el(
			'p',
			'hm-panel-sub',
			'Every row above, as JSON. Your Home Assistant token is deliberately not in it: it is a key to your building and it does not belong in a downloads folder.',
		),
	);
	const actions = el('div', 'hm-actions');
	const link = el('a', 'hm-btn hm-btn-primary', 'Download my home data');
	link.href = PRIVACY_EXPORT_URL;
	link.setAttribute('download', '');
	actions.append(link);
	panel.append(actions);
	return panel;
}

// ── 4. Delete it ─────────────────────────────────────────────────────────────

function deletePanel(data) {
	const panel = el('section', 'hm-panel hm-panel-danger');
	panel.append(
		el('h2', 'hm-panel-title', 'Delete it'),
		el(
			'p',
			'hm-panel-sub',
			'This is not the same as disconnecting. Disconnecting erases the token and keeps your action log so you can still check what happened. This removes the record too, and nothing is recoverable afterwards.',
		),
	);

	const live = (data.homes || []).filter((h) => !h.revoked_at);
	for (const home of live) {
		const row = el('div', 'hm-danger-row');
		row.append(el('span', 'hm-danger-label', home.label || 'This home'));
		const btn = el('button', 'hm-btn hm-btn-danger', 'Delete this home and its history');
		btn.type = 'button';
		btn.addEventListener('click', () => confirmDeleteHome(row, home));
		row.append(btn);
		panel.append(row);
	}

	const all = el('div', 'hm-danger-row hm-danger-row-all');
	all.append(
		el(
			'span',
			'hm-danger-label',
			live.length > 1 ? 'Every home, and everything they hold' : 'Everything this feature holds about me',
		),
	);
	const allBtn = el('button', 'hm-btn hm-btn-danger', 'Delete everything');
	allBtn.type = 'button';
	allBtn.addEventListener('click', () => confirmDeleteAll(all));
	all.append(allBtn);
	panel.append(all);
	return panel;
}

/**
 * One home. It confirms in place rather than in a dialog, so the thing being
 * deleted stays on screen next to the question about deleting it.
 */
function confirmDeleteHome(row, home) {
	if (row.querySelector('[data-confirm]')) return;
	const box = el('div', 'hm-notice hm-notice-warn');
	box.dataset.confirm = 'true';
	box.setAttribute('role', 'alertdialog');
	box.setAttribute('aria-label', `Delete ${home.label || 'this home'}`);
	box.append(
		el('p', 'hm-notice-title', `Delete ${home.label || 'this home'} and everything about it?`),
		el(
			'p',
			'hm-notice-body',
			'Its action log, standing permissions, household members and invitations all go. Your other homes are untouched. This cannot be undone.',
		),
	);
	const actions = el('div', 'hm-actions');
	const yes = el('button', 'hm-btn hm-btn-danger', 'Delete it');
	yes.type = 'button';
	const no = el('button', 'hm-btn hm-btn-ghost', 'Keep it');
	no.type = 'button';
	no.addEventListener('click', () => box.remove());
	yes.addEventListener('click', async () => {
		yes.disabled = true;
		no.disabled = true;
		yes.textContent = 'Deleting';
		try {
			const result = await deleteHomeData({ scope: 'home', homeId: home.id });
			state.notice = {
				tone: 'ok',
				title: `${home.label || 'That home'} is gone`,
				body: deletedSentence(result.before),
			};
			await load();
		} catch (err) {
			state.notice = { tone: 'error', title: 'Could not delete it', body: err?.message || 'Nothing was deleted.' };
			render();
		}
	});
	actions.append(yes, no);
	box.append(actions);
	row.append(box);
	queueMicrotask(() => yes.focus());
}

/**
 * Everything. This one asks for the phrase to be typed, because the button that
 * opens it and the button that confirms it would otherwise be the same gesture
 * twice, and somebody who mis-clicked once will mis-click twice.
 */
function confirmDeleteAll(row) {
	if (row.querySelector('[data-confirm]')) return;
	const box = el('div', 'hm-notice hm-notice-warn');
	box.dataset.confirm = 'true';
	box.setAttribute('role', 'alertdialog');
	box.setAttribute('aria-label', 'Delete everything');
	box.append(
		el('p', 'hm-notice-title', 'Delete every home and everything they hold?'),
		el(
			'p',
			'hm-notice-body',
			'Every home, every action log, every standing permission, your household memberships on other people’s homes, and any invitation addressed to you. Your three.ws account itself stays. This cannot be undone.',
		),
	);

	const wrap = el('div', 'hm-field');
	const id = 'hm-delete-all-confirm';
	const label = el('label', 'hm-label', `Type ${DELETE_ALL_PHRASE} to confirm`);
	label.htmlFor = id;
	const input = el('input', 'hm-input');
	input.id = id;
	input.type = 'text';
	input.autocomplete = 'off';
	input.spellcheck = false;
	input.setAttribute('aria-describedby', `${id}-hint`);
	const hint = el('p', 'hm-hint', 'Exactly those two words, in lower case.');
	hint.id = `${id}-hint`;
	wrap.append(label, input, hint);
	box.append(wrap);

	const actions = el('div', 'hm-actions');
	const yes = el('button', 'hm-btn hm-btn-danger', 'Delete everything');
	yes.type = 'button';
	yes.disabled = true;
	const no = el('button', 'hm-btn hm-btn-ghost', 'Cancel');
	no.type = 'button';
	no.addEventListener('click', () => box.remove());
	input.addEventListener('input', () => {
		yes.disabled = !phraseMatches(input.value);
	});
	yes.addEventListener('click', async () => {
		yes.disabled = true;
		no.disabled = true;
		yes.textContent = 'Deleting';
		try {
			const result = await deleteHomeData({ scope: 'all' });
			state.notice = {
				tone: 'ok',
				title: 'All of it is gone',
				body: deletedSentence(result.before),
			};
			await load();
		} catch (err) {
			state.notice = { tone: 'error', title: 'Could not delete it', body: err?.message || 'Nothing was deleted.' };
			render();
		}
	});
	actions.append(yes, no);
	box.append(actions);
	row.append(box);
	queueMicrotask(() => input.focus());
}


