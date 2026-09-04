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
let state = {
	door: null, handle: null, url: null, totals: null, blocks: [], knocks: [], loadingMore: false,
	// The escrowed lane's two halves: what we store (escrow) and what the chain
	// says (chainDoor). They can disagree, and the panel exists to say so.
	escrow: null, chainDoor: null,
};

document.addEventListener('DOMContentLoaded', () => {
	for (const id of [
		'directory', 'directory-empty', 'directory-loading', 'owner', 'owner-loading', 'signed-out',
		'door-open', 'door-price', 'door-solana', 'door-base', 'door-headline', 'door-greeting',
		'door-max', 'door-cap', 'door-listed', 'save', 'save-note', 'settings-error',
		'share-url', 'copy-share', 'share-block', 'endpoint-url', 'copy-endpoint',
		'stat-pending', 'stat-total', 'stat-earned', 'inbox', 'inbox-empty', 'inbox-loading',
		'load-more', 'blocks', 'blocks-empty', 'no-handle', 'inbox-section', 'blocks-section',
		'stat-escrowed', 'stat-escrowed-card', 'escrow-panel', 'escrow-enabled', 'escrow-window',
		'escrow-fields', 'escrow-address', 'chain-state', 'chain-dot', 'chain-text',
		'chain-actions', 'open-chain-door', 'chain-explorer',
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

	renderTotals(data.totals);
	renderEscrow(data.escrow, door);
	renderBlocks(data.blocks || []);
}

function renderTotals(totals) {
	els['stat-pending'].textContent = String(totals.pending);
	els['stat-total'].textContent = String(totals.total);
	els['stat-earned'].textContent = totals.earned;
	// Only shown once there is escrowed money to show. A permanent $0.00 tile
	// for a lane this owner does not use is furniture, not information.
	const escrowed = Number(totals.escrowed_pending || 0) > 0;
	els['stat-escrowed-card'].hidden = !escrowed;
	els['stat-escrowed'].textContent = totals.escrowed || '$0.00';
}

/**
 * The escrowed lane's own panel.
 *
 * Two things live here that nothing else in these settings does. The toggle is
 * an ordinary saved field, but the on-chain door beside it is not ours to
 * write: only this owner's wallet can open, reprice or shut it, so the panel
 * reads the chain and tells them what is actually true rather than what they
 * asked for.
 */
function renderEscrow(escrow, door) {
	state.escrow = escrow || null;
	if (!escrow) {
		els['escrow-panel'].hidden = true;
		return;
	}
	els['escrow-panel'].hidden = false;
	els['escrow-enabled'].checked = Boolean(escrow.enabled);
	els['escrow-window'].value = String(escrow.window_hours);
	els['escrow-window'].min = String(escrow.min_window_hours);
	els['escrow-window'].max = String(escrow.max_window_hours);
	els['escrow-fields'].hidden = !escrow.enabled;
	els['escrow-address'].hidden = !escrow.door || !escrow.enabled;
	els['escrow-address'].textContent = escrow.door ? `Your on-chain door: ${escrow.door}` : '';
	if (escrow.enabled) refreshChainState(door);
	else els['chain-actions'].hidden = true;
}

/** What the chain says about this owner's door, in their own words. */
async function refreshChainState(door) {
	const escrow = state.escrow;
	if (!escrow) return;
	if (!escrow.door) {
		return setChainState('warn', 'Add your Solana wallet above and save. It is half of your door\'s on-chain address.');
	}

	setChainState(null, 'Checking your on-chain door');
	els['chain-explorer'].hidden = false;
	els['chain-explorer'].href = `https://solscan.io/account/${escrow.door}`;

	try {
		const { connection, readDoor } = await import('./escrow-checkout.js');
		const onChain = await readDoor(await connection(), escrow.door);
		state.chainDoor = onChain;

		if (!onChain) {
			els['chain-actions'].hidden = false;
			els['open-chain-door'].textContent = 'Open my door on-chain';
			return setChainState(
				'warn',
				'Not opened yet. Until you open it, an escrowed knock has nowhere to land and senders see the normal lane.',
			);
		}

		const wanted = String(door.price_atomics);
		const wantedWindow = Number(escrow.window_hours) * 3600;
		const drifted = String(onChain.price) !== wanted || onChain.replyWindow !== wantedWindow || !onChain.open;
		els['chain-actions'].hidden = !drifted;
		els['open-chain-door'].textContent = 'Update it on-chain';

		if (!onChain.open) {
			return setChainState('warn', 'Shut on-chain. Escrowed knocks are refused until you reopen it.');
		}
		if (drifted) {
			return setChainState(
				'warn',
				`On-chain it charges ${formatAtomics(onChain.price)} and answers within ${Math.round(onChain.replyWindow / 3600)}h. That is what a sender agrees to, so bring it in line with the settings above.`,
			);
		}
		return setChainState(
			'live',
			`Open on-chain: ${formatAtomics(onChain.price)} per knock, ${Math.round(onChain.replyWindow / 3600)}h to answer. ${onChain.knocks} knock(s), ${onChain.answered} answered.`,
		);
	} catch (err) {
		setChainState('warn', `Could not read your on-chain door just now: ${err.message}`);
	}
}

function setChainState(tone, text) {
	els['chain-dot'].className = `dot${tone ? ` is-${tone}` : ''}`;
	els['chain-text'].textContent = text;
}

/** USDC atomics as a human amount, matching what the API formats elsewhere. */
function formatAtomics(atomics) {
	const value = Number(BigInt(atomics)) / 1e6;
	return `$${value.toFixed(value < 0.01 ? 4 : 2)}`;
}

/**
 * Open or update the on-chain door from the owner's own wallet.
 *
 * three.ws cannot do this for them and should not be able to: the account is
 * derived from their wallet, and only their signature can create or change it.
 */
async function openChainDoor() {
	const escrow = state.escrow;
	if (!escrow) return;
	const btn = els['open-chain-door'];
	const label = btn.textContent;
	btn.disabled = true;
	try {
		const { openDoorOnChain } = await import('./escrow-checkout.js');
		const { USDC_MINT } = await import('./escrow-program.js');
		const price = BigInt(state.door.price_atomics);
		if (price <= 0n) {
			showSettingsError('Set a price above zero before opening an escrowed door: the program will not hold nothing.');
			return;
		}
		await openDoorOnChain({
			handle: state.handle,
			priceAtomics: price,
			replyWindowSeconds: Number(els['escrow-window'].value || 24) * 3600,
			mint: USDC_MINT,
			onStatus: (status) => { btn.textContent = `${status}…`; },
		});
		showSettingsError('');
		await refreshChainState(state.door);
	} catch (err) {
		showSettingsError(err?.message || 'That did not go through.');
	} finally {
		btn.disabled = false;
		btn.textContent = label;
	}
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
		escrow_enabled: els['escrow-enabled'].checked,
		escrow_window_hours: Number(els['escrow-window'].value) || 24,
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
		if (data.totals) renderTotals(data.totals);
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

	if (knock.escrow) body.appendChild(escrowLine(knock.escrow));

	const actions = document.createElement('div');
	actions.className = 'knock-actions';
	if (knock.status !== 'replied') {
		const payable = knock.escrow?.state === 'pending' && !knock.escrow.expired;
		actions.appendChild(button(payable ? 'Reply and get paid' : 'Reply', () => openReply(li, knock)));
	}
	if (knock.escrow?.state === 'pending' && !knock.escrow.expired) {
		// Declining is a real answer, and the one the sender is owed a refund
		// for. It is offered next to the reply rather than buried, because a
		// door that will not answer should say so while the money can still go
		// back cleanly instead of waiting out the clock.
		actions.appendChild(button('Refuse and refund', () => onRefuse(knock), 'danger'));
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

/**
 * The on-chain half of one knock, said plainly.
 *
 * An escrowed knock is not money in the owner's pocket, and the inbox has to
 * stop implying that it is. Pending says what answering is worth and by when;
 * expired says the money is already owed back, which is the single most
 * important thing an owner can know before spending time on a reply.
 */
function escrowLine(escrow) {
	const el = document.createElement('div');
	el.className = `knock-escrow is-${escrow.state}${escrow.expired && escrow.state === 'pending' ? ' is-expired' : ''}`;
	if (escrow.state !== 'pending') {
		el.textContent =
			escrow.state === 'answered'
				? 'Escrow released to you.'
				: escrow.state === 'refused'
					? 'You declined this. The sender was refunded in full.'
					: 'The window closed and the sender took their payment back.';
		return el;
	}
	el.textContent = escrow.expired
		? 'Escrowed, but the window has closed. This is owed back to the sender now; a reply is still welcome, it just will not pay.'
		: `Escrowed on-chain. Answer within ${remaining(escrow.expires_in_seconds)} to be paid.`;
	return el;
}

function remaining(seconds) {
	const s = Math.max(0, Number(seconds) || 0);
	if (s >= 86400) return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
	if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
	return `${Math.max(1, Math.floor(s / 60))}m`;
}

/**
 * Release an escrowed knock's payment by answering it on-chain.
 *
 * The reply is already saved by the time this runs, so a wallet the owner
 * cancels costs them the payout and nothing else: the sender still gets their
 * answer, and the escrow refunds itself when the window closes. That ordering
 * is deliberate. The alternative loses a written reply to a wallet prompt.
 */
async function collectEscrow(knock, setStatus) {
	const { answerKnock } = await import('./escrow-checkout.js');
	await answerKnock({
		knockAddress: knock.escrow.knock,
		reply: knock.pendingReply,
		onStatus: setStatus,
	});
	await syncEscrowRow(knock.escrow.knock);
}

/** Decline an escrowed knock and hand every unit back. Owner-signed, no fee. */
async function onRefuse(knock) {
	try {
		const { refuseKnock } = await import('./escrow-checkout.js');
		await refuseKnock({ knockAddress: knock.escrow.knock });
		await act(knock.id, { status: 'dismissed' });
		await syncEscrowRow(knock.escrow.knock);
	} catch (err) {
		showSettingsError(err?.message || 'That refusal did not go through.');
	}
}

/**
 * Ask the server to re-read one escrow and update its cached state.
 *
 * Best effort on purpose: the chain is authoritative either way, and a failed
 * sync means a stale label on a row, not a lost settlement.
 */
async function syncEscrowRow(escrowKnock) {
	try {
		const { state } = await knockApi.syncEscrow(escrowKnock);
		state.escrowSyncedAt = Date.now();
		const data = await knockApi.inbox({ limit: Math.max(20, state.knocks?.length || 20) });
		state.knocks = data.knocks;
		renderInbox();
		if (data.totals) renderTotals(data.totals);
	} catch {
		// The row's label stays as it was. Nothing on-chain depends on it.
	}
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
		renderTotals(data.totals);
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
	els['escrow-enabled']?.addEventListener('change', () => {
		els['escrow-fields'].hidden = !els['escrow-enabled'].checked;
		els['chain-actions'].hidden = !els['escrow-enabled'].checked;
		hintPayout();
	});
	els['open-chain-door']?.addEventListener('click', openChainDoor);
}

function hintPayout() {
	const priced = (els['door-price'].value.trim() || '0') !== '0';
	const solana = els['door-solana'].value.trim();
	const needsWallet = els['door-open'].checked && priced && !solana && !els['door-base'].value.trim();
	if (needsWallet) return showSettingsError('A priced door needs the wallet that should receive the USDC.');
	// The escrowed lane needs Solana specifically: it is where an answer pays
	// out AND half of what derives the door's on-chain address, so a Base-only
	// door cannot run it. Saying so here beats a rejected save.
	if (els['escrow-enabled']?.checked && !solana) {
		return showSettingsError('Escrowed knocks need your Solana address: it is where an answer pays out, and half of your on-chain door address.');
	}
	showSettingsError('');
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
