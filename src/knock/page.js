// The /knock hub: your own door, the knocks it has taken, and everyone else's.
//
// Signed out, this page is a directory: who is reachable and for how much. The
// directory is public on purpose, because a door nobody can find is not a door.
//
// Signed in, the same page grows the owner half: the price, the wallet the
// money lands in, the share link, the inbox, and the block list. Everything
// saves through PATCH /api/knock/settings, which refuses to open a priced door
// with no payout address, so the UI never has to guess whether a save was safe.

import { knockApi } from './api.js';

const els = {};
let state = { door: null, handle: null, url: null, totals: null, blocks: [], knocks: [], loadingMore: false };

document.addEventListener('DOMContentLoaded', () => {
	for (const id of [
		'directory', 'directory-empty', 'directory-loading', 'owner', 'owner-loading', 'signed-out',
		'door-open', 'door-price', 'door-solana', 'door-base', 'door-headline', 'door-greeting',
		'door-max', 'door-cap', 'door-listed', 'save', 'save-note', 'settings-error',
		'share-url', 'copy-share', 'share-block', 'endpoint-url', 'copy-endpoint',
		'stat-pending', 'stat-total', 'stat-earned', 'inbox', 'inbox-empty', 'inbox-loading',
		'load-more', 'blocks', 'blocks-empty', 'no-handle', 'inbox-section', 'blocks-section',
	]) {
		els[id] = document.getElementById(id);
	}
	bind();
	loadDirectory();
	loadOwner();
});

// ── Directory (public) ──────────────────────────────────────────────────────

async function loadDirectory() {
	try {
		const { doors } = await knockApi.directory(60);
		els['directory-loading'].hidden = true;
		if (!doors.length) {
			els['directory-empty'].hidden = false;
			return;
		}
		els.directory.hidden = false;
		els.directory.replaceChildren(...doors.map(doorCard));
	} catch {
		els['directory-loading'].hidden = true;
		els['directory-empty'].hidden = false;
		els['directory-empty'].querySelector('[data-msg]').textContent =
			'The directory could not be reached. Reload to try again.';
	}
}

function doorCard(door) {
	const a = document.createElement('a');
	a.className = 'door-card';
	a.href = `/knock/${encodeURIComponent(door.handle)}`;
	const face = document.createElement('div');
	face.className = 'face';
	face.dataset.initial = (door.display_name || door.handle).slice(0, 1).toUpperCase();
	if (door.avatar_url) {
		const img = document.createElement('img');
		img.src = door.avatar_url;
		img.alt = '';
		img.loading = 'lazy';
		face.appendChild(img);
	}
	const body = document.createElement('div');
	body.className = 'door-card-body';
	const name = document.createElement('div');
	name.className = 'door-card-name';
	name.textContent = door.display_name;
	const handle = document.createElement('div');
	handle.className = 'door-card-handle';
	handle.textContent = `@${door.handle}`;
	body.append(name, handle);
	if (door.headline) {
		const head = document.createElement('div');
		head.className = 'door-card-headline';
		head.textContent = door.headline;
		body.appendChild(head);
	}
	const price = document.createElement('span');
	price.className = `door-card-price${door.price_atomics === '0' ? ' is-free' : ''}`;
	price.textContent = door.price_atomics === '0' ? 'Free' : door.price;
	a.append(face, body, price);
	return a;
}

// ── Owner half ──────────────────────────────────────────────────────────────

async function loadOwner() {
	try {
		const data = await knockApi.settings();
		applyOwner(data);
		els['owner-loading'].hidden = true;
		els.owner.hidden = false;
		await loadInbox();
	} catch (err) {
		els['owner-loading'].hidden = true;
		if (err.status === 401) {
			// Signed out. The directory below stays public; the owner-only
			// sections are hidden outright rather than left spinning on a
			// request that will never be allowed to complete.
			els['signed-out'].hidden = false;
			els['inbox-loading'].hidden = true;
			els['inbox-section'].hidden = true;
			els['blocks-section'].hidden = true;
			return;
		}
		els.owner.hidden = false;
		showSettingsError(err.message);
	}
}

function applyOwner(data) {
	state = { ...state, ...data };
	const door = data.door;
	els['door-open'].checked = Boolean(door.open);
	els['door-price'].value = door.free ? '0' : String(Number(door.price_atomics) / 1e6);
	els['door-solana'].value = door.pay_to_solana || '';
	els['door-base'].value = door.pay_to_base || '';
	els['door-headline'].value = door.headline || '';
	els['door-greeting'].value = door.greeting || '';
	els['door-max'].value = String(door.max_chars);
	els['door-cap'].value = String(door.daily_cap);
	els['door-listed'].checked = Boolean(door.listed);

	els['no-handle'].hidden = Boolean(data.handle);
	els['share-block'].hidden = !data.handle;
	if (data.url) {
		els['share-url'].textContent = data.url;
		els['copy-share'].dataset.copy = data.url;
	}
	if (data.endpoint) {
		els['endpoint-url'].textContent = data.endpoint;
		els['copy-endpoint'].dataset.copy = data.endpoint;
	}

	els['stat-pending'].textContent = String(data.totals.pending);
	els['stat-total'].textContent = String(data.totals.total);
	els['stat-earned'].textContent = data.totals.earned;

	renderBlocks(data.blocks || []);
}

function renderBlocks(blocks) {
	state.blocks = blocks;
	if (!blocks.length) {
		els.blocks.hidden = true;
		els['blocks-empty'].hidden = false;
		return;
	}
	els['blocks-empty'].hidden = true;
	els.blocks.hidden = false;
	els.blocks.replaceChildren(
		...blocks.map((b) => {
			const li = document.createElement('li');
			const label = document.createElement('span');
			label.textContent = b.subject;
			const btn = document.createElement('button');
			btn.type = 'button';
			btn.className = 'btn btn-sm';
			btn.textContent = 'Unblock';
			btn.addEventListener('click', async () => {
				btn.disabled = true;
				try {
					const data = await knockApi.saveSettings({ unblock: b.id });
					applyOwner(data);
				} catch (err) {
					showSettingsError(err.message);
					btn.disabled = false;
				}
			});
			li.append(label, btn);
			return li;
		}),
	);
}

async function saveSettings() {
	showSettingsError('');
	const patch = {
		open: els['door-open'].checked,
		price: els['door-price'].value.trim() || '0',
		pay_to_solana: els['door-solana'].value.trim() || null,
		pay_to_base: els['door-base'].value.trim() || null,
		headline: els['door-headline'].value.trim() || null,
		greeting: els['door-greeting'].value.trim() || null,
		max_chars: Number(els['door-max'].value) || 600,
		daily_cap: Number(els['door-cap'].value) || 25,
		listed: els['door-listed'].checked,
	};
	els.save.disabled = true;
	els.save.textContent = 'Saving…';
	try {
		applyOwner(await knockApi.saveSettings(patch));
		els['save-note'].textContent = patch.open ? 'Saved. Your door is open.' : 'Saved. Your door is shut.';
		els['save-note'].hidden = false;
		setTimeout(() => { els['save-note'].hidden = true; }, 2600);
	} catch (err) {
		showSettingsError(err.message);
	} finally {
		els.save.disabled = false;
		els.save.textContent = 'Save door';
	}
}

function showSettingsError(message) {
	els['settings-error'].textContent = message;
	els['settings-error'].hidden = !message;
}

// ── Inbox ───────────────────────────────────────────────────────────────────

async function loadInbox({ append = false } = {}) {
	if (state.loadingMore) return;
	state.loadingMore = true;
	const before = append && state.knocks.length ? state.knocks[state.knocks.length - 1].created_at : null;
	try {
		const data = await knockApi.inbox({ limit: 20, before });
		state.knocks = append ? [...state.knocks, ...data.knocks] : data.knocks;
		els['inbox-loading'].hidden = true;
		els['load-more'].hidden = !data.has_more;
		renderInbox();
		if (data.totals) {
			els['stat-pending'].textContent = String(data.totals.pending);
			els['stat-total'].textContent = String(data.totals.total);
			els['stat-earned'].textContent = data.totals.earned;
		}
	} catch (err) {
		els['inbox-loading'].hidden = true;
		els['inbox-empty'].hidden = false;
		els['inbox-empty'].querySelector('[data-msg]').textContent =
			err.status === 401 ? 'Sign in to read your knocks.' : 'Could not load your knocks. Reload to try again.';
	} finally {
		state.loadingMore = false;
	}
}

function renderInbox() {
	if (!state.knocks.length) {
		els.inbox.hidden = true;
		els['inbox-empty'].hidden = false;
		return;
	}
	els['inbox-empty'].hidden = true;
	els.inbox.hidden = false;
	els.inbox.replaceChildren(...state.knocks.map(knockRow));
}

function knockRow(knock) {
	const li = document.createElement('li');
	li.className = `knock${knock.status === 'pending' ? ' is-new' : ''}`;
	li.dataset.id = knock.id;

	const head = document.createElement('div');
	head.className = 'knock-head';
	const who = document.createElement('strong');
	who.textContent = knock.sender_name;
	const amount = document.createElement('span');
	amount.className = `knock-amount${knock.amount_atomics === '0' ? ' is-free' : ''}`;
	amount.textContent = knock.amount_atomics === '0' ? 'free' : knock.amount;
	const when = document.createElement('time');
	when.dateTime = knock.created_at;
	when.textContent = relative(knock.created_at);
	head.append(who, amount, when);

	const body = document.createElement('div');
	body.className = 'knock-body';
	if (knock.subject) {
		const subject = document.createElement('div');
		subject.className = 'knock-subject';
		subject.textContent = knock.subject;
		body.appendChild(subject);
	}
	const text = document.createElement('p');
	text.textContent = knock.message;
	body.appendChild(text);
	if (knock.sender_url) {
		const link = document.createElement('a');
		link.className = 'knock-link';
		link.href = knock.sender_url;
		link.textContent = knock.sender_url;
		link.rel = 'nofollow noopener noreferrer';
		link.target = '_blank';
		body.appendChild(link);
	}
	if (knock.reply_text) {
		const reply = document.createElement('div');
		reply.className = 'knock-reply';
		reply.textContent = knock.reply_text;
		body.appendChild(reply);
	}

	const actions = document.createElement('div');
	actions.className = 'knock-actions';
	if (knock.status !== 'replied') {
		const replyBtn = button('Reply', () => openReply(li, knock));
		actions.appendChild(replyBtn);
	}
	if (knock.status === 'pending') {
		actions.appendChild(button('Mark read', () => act(knock.id, { status: 'read' })));
	}
	if (knock.status !== 'dismissed') {
		actions.appendChild(button('Dismiss', () => act(knock.id, { status: 'dismissed' })));
	}
	actions.appendChild(button('Block sender', () => act(knock.id, { status: 'dismissed', block: true }), 'danger'));

	li.append(head, body, actions);
	return li;
}

function button(label, onClick, tone = null) {
	const b = document.createElement('button');
	b.type = 'button';
	b.className = `btn btn-sm${tone === 'danger' ? ' btn-danger' : ''}`;
	b.textContent = label;
	b.addEventListener('click', onClick);
	return b;
}

function openReply(li, knock) {
	if (li.querySelector('.reply-form')) return;
	const form = document.createElement('form');
	form.className = 'reply-form';
	const area = document.createElement('textarea');
	area.maxLength = 2000;
	area.placeholder = `Answer ${knock.sender_name}. They read it through their receipt link.`;
	area.required = true;
	const row = document.createElement('div');
	row.className = 'reply-row';
	const send = document.createElement('button');
	send.type = 'submit';
	send.className = 'btn btn-sm btn-primary';
	send.textContent = 'Send reply';
	const cancel = button('Cancel', () => form.remove());
	row.append(send, cancel);
	form.append(area, row);
	form.addEventListener('submit', async (e) => {
		e.preventDefault();
		const reply = area.value.trim();
		if (!reply) return;
		send.disabled = true;
		send.textContent = 'Sending…';
		await act(knock.id, { status: 'replied', reply });
	});
	li.appendChild(form);
	area.focus();
}

async function act(id, patch) {
	try {
		const { knock } = await knockApi.actOn(id, patch);
		state.knocks = state.knocks.map((k) => (k.id === id ? { ...k, ...knock } : k));
		renderInbox();
		if (patch.block) applyOwner(await knockApi.settings());
		else refreshTotals();
	} catch (err) {
		showSettingsError(err.message);
	}
}

async function refreshTotals() {
	try {
		const data = await knockApi.inbox({ limit: 1 });
		els['stat-pending'].textContent = String(data.totals.pending);
		els['stat-total'].textContent = String(data.totals.total);
		els['stat-earned'].textContent = data.totals.earned;
	} catch {
		// The list on screen is already correct; a stale counter is not worth
		// an error banner.
	}
}

function relative(iso) {
	const then = Date.parse(iso);
	if (Number.isNaN(then)) return '';
	const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
	if (secs < 60) return 'just now';
	if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
	if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
	return `${Math.floor(secs / 86400)}d ago`;
}

// ── Wiring ──────────────────────────────────────────────────────────────────

function bind() {
	els.save?.addEventListener('click', saveSettings);
	els['load-more']?.addEventListener('click', () => loadInbox({ append: true }));
	for (const btn of document.querySelectorAll('[data-copy]')) {
		btn.addEventListener('click', () => copy(btn));
	}
	// Opening a priced door with no wallet is the one save that always fails,
	// so say it before the round trip rather than after.
	els['door-open']?.addEventListener('change', hintPayout);
	els['door-price']?.addEventListener('input', hintPayout);
	els['door-solana']?.addEventListener('input', hintPayout);
}

function hintPayout() {
	const priced = (els['door-price'].value.trim() || '0') !== '0';
	const needsWallet = els['door-open'].checked && priced && !els['door-solana'].value.trim() && !els['door-base'].value.trim();
	showSettingsError(needsWallet ? 'A priced door needs the wallet that should receive the USDC.' : '');
}

async function copy(btn) {
	const text = btn.dataset.copy;
	if (!text) return;
	try {
		await navigator.clipboard.writeText(text);
		const original = btn.textContent;
		btn.textContent = 'Copied';
		btn.classList.add('is-ok');
		setTimeout(() => {
			btn.textContent = original;
			btn.classList.remove('is-ok');
		}, 1400);
	} catch {
		btn.textContent = 'Copy failed';
		setTimeout(() => { btn.textContent = 'Copy'; }, 1400);
	}
}
