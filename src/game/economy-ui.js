// Economy UI (W04) — the general store and bank/ATM modals opened by walking
// up to their NPC and pressing E (npc/economy-npcs.js). Both are thin, honest
// clients of the server-authoritative cash economy: every button sends an
// intent over CommunityNet, the server prices/validates/mutates the profile,
// and the result streams back through the existing 'store'/'profile'/'inv'/
// 'notice' events — this module never assumes a trade landed until the server
// confirms it. The $THREE boutique is a separate, on-chain flow that lives in
// the wardrobe panel (play-systems.js), not here.

import './economy-ui.css';
import { itemDisplay } from './items.js';
import { openModal, announce } from './a11y.js';

function el(tag, props = {}, kids = []) {
	const n = document.createElement(tag);
	for (const [k, v] of Object.entries(props)) {
		if (k === 'class') n.className = v;
		else if (k === 'text') n.textContent = v;
		else if (k === 'html') n.innerHTML = v;
		else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
		else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v === true ? '' : v);
	}
	for (const kid of [].concat(kids)) if (kid != null && kid !== false) n.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
	return n;
}

// Base modal shell shared by the store, the bank, and (src/game/quests-ui.js)
// the Jobs Board — overlay, card, header with a title + close button, and
// open/close lifecycle (fade + teardown). Exported so sibling panels reuse the
// exact same shell instead of forking it.
export class EconPanel {
	constructor({ title, onClose }) {
		this._unsubs = [];
		this._onClose = onClose;
		this.body = el('div', { class: 'ec-body' });
		this.status = el('div', { class: 'ec-status', role: 'status', 'aria-live': 'polite' });
		this.closeBtn = el('button', { class: 'ec-x', type: 'button', 'aria-label': 'Close', text: '✕', onclick: () => this.close() });
		this.card = el('div', { class: 'ec-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, [
			el('div', { class: 'ec-head' }, [
				el('span', { class: 'ec-title', text: title }),
				this.closeBtn,
			]),
			this.body,
			this.status,
		]);
		this.overlay = el('div', { class: 'ec-overlay', onpointerdown: (e) => { if (e.target === this.overlay) this.close(); } }, [this.card]);
		// Game hotkeys live on `window`; a keystroke aimed at this card must never
		// also drive the avatar behind it.
		this.card.addEventListener('keydown', (e) => e.stopPropagation());
		document.body.appendChild(this.overlay);
		requestAnimationFrame(() => this.overlay.classList.add('ec-on'));
		// `aria-modal` is a promise to keep focus inside; openModal is what makes
		// it true, and it also puts this panel on the shared Escape stack so the
		// top-most panel is the one Escape closes.
		this._releaseModal = openModal(this.card, { close: () => this.close(), initialFocus: this.closeBtn });
		announce(title);
	}

	track(unsub) { if (typeof unsub === 'function') this._unsubs.push(unsub); }

	setStatus(text, kind) {
		this.status.textContent = text || '';
		this.status.setAttribute('data-kind', kind || '');
	}

	// --- first-snapshot loading state -----------------------------------------
	//
	// Every panel here opens before its data exists: the constructor fires a
	// request and the server answers over the socket a moment later. Rendering
	// the empty state in that gap tells the player "the shelves are bare" when
	// the truth is "we haven't looked yet", and if the reply never lands (the
	// socket dropped between the walk-up and the open) that lie is permanent.
	// So panels start in `loading`, settle on the first snapshot, and fall to an
	// honest, retryable error if nothing arrives.

	/** Begin waiting for the first server snapshot. `retry` re-sends the request. */
	awaitFirstSnapshot(retry, { timeoutMs = 9000 } = {}) {
		this.loading = true;
		this.loadFailed = false;
		this._retry = retry;
		clearTimeout(this._loadTimer);
		this._loadTimer = setTimeout(() => {
			if (!this.loading) return;
			this.loading = false;
			this.loadFailed = true;
			this._render?.();
		}, timeoutMs);
	}

	/** The first snapshot landed: leave the loading state for good. */
	settleFirstSnapshot() {
		if (!this.loading && !this.loadFailed) return;
		clearTimeout(this._loadTimer);
		this._loadTimer = null;
		this.loading = false;
		this.loadFailed = false;
	}

	/** Placeholder rows shaped like the real ones, so nothing jumps on arrival. */
	skeleton(rows = 3) {
		const wrap = el('div', { class: 'ec-skel' });
		for (let i = 0; i < rows; i++) {
			wrap.appendChild(el('div', { class: 'ec-skel-row' }, [
				el('span', { class: 'ec-skel-glyph' }),
				el('div', { class: 'ec-skel-main' }, [el('span', { class: 'ec-skel-line' }), el('span', { class: 'ec-skel-line ec-skel-line-sm' })]),
				el('span', { class: 'ec-skel-btn' }),
			]));
		}
		return wrap;
	}

	/** The honest dead end: what went wrong, and the one button that fixes it. */
	loadError(what) {
		return el('div', { class: 'ec-empty ec-error' }, [
			el('div', { class: 'ec-error-glyph', 'aria-hidden': 'true', text: '📡' }),
			el('div', { class: 'ec-error-title', text: `Couldn't reach ${what}` }),
			el('div', { text: 'The world stopped answering. Nothing was lost.' }),
			el('button', {
				class: 'ec-row-btn ec-error-retry', type: 'button', text: 'Try again',
				onclick: () => { this.awaitFirstSnapshot(this._retry); this._retry?.(); this._render?.(); },
			}),
		]);
	}

	// --- one in-flight intent per panel ---------------------------------------
	//
	// Every trade is priced and applied by the server, which answers each intent
	// with a fresh snapshot. So the honest way to stop a double-click from buying
	// twice is to hold exactly one intent open at a time and wait for that answer:
	// no optimistic balance maths on the client, and no second charge in flight
	// while the first is still unresolved. Subclasses implement `_syncPending()`
	// to re-render their buttons against `this.pending`.

	// Claim the panel's single in-flight slot. Returns false when one is already
	// open (the click is swallowed) or the world is offline (the player is told).
	beginRequest(label, { timeoutMs = 9000, onTimeout } = {}) {
		if (this.pending) return false;
		if (this.net?.status && this.net.status !== 'online') {
			this.setStatus('Reconnecting to the world. Nothing was charged, try again in a moment.', 'err');
			return false;
		}
		this.pending = label;
		this.setStatus(label);
		this._syncPending?.();
		clearTimeout(this._pendingTimer);
		// A dropped reply must not strand the UI mid-trade with a stale balance:
		// clear the guard, say plainly that nothing was charged, and re-read the
		// authoritative profile rather than trusting anything local.
		this._pendingTimer = setTimeout(() => {
			this.pending = null;
			this._syncPending?.();
			this.setStatus('No answer from the world. Nothing was charged. Re-checking your purse…', 'err');
			try { this.net?.requestProfile?.(); } catch { /* offline; the reconnect will resync */ }
			onTimeout?.();
		}, timeoutMs);
		return true;
	}

	// Release the slot once the server has answered (an inv/profile echo, or a
	// notice explaining the refusal). Idempotent.
	endRequest() {
		if (!this.pending) return;
		clearTimeout(this._pendingTimer);
		this._pendingTimer = null;
		this.pending = null;
		this._syncPending?.();
	}

	close() {
		if (this._closed) return;
		this._closed = true;
		this._releaseModal?.();
		this.overlay.classList.remove('ec-on');
		clearTimeout(this._pendingTimer);
		for (const u of this._unsubs) { try { u(); } catch { /* ignore */ } }
		this._unsubs = [];
		setTimeout(() => this.overlay.remove(), 180);
		this._onClose?.();
	}
}

let _openStore = null;
let _openBank = null;

// ---------------------------------------------------------------- store

/**
 * Open the general store: buy tools/consumables with cash, or sell gathered
 * goods for cash. Idempotent — a second call while one is open just refocuses
 * it (mirrors coin-buy.js's TradeModal singleton).
 * @param {{ ui: object, net: object }} deps
 */
export function openStorePanel({ ui, net }) {
	if (!net) return;
	if (_openStore) return;
	_openStore = new StorePanel({ ui, net, onClose: () => { _openStore = null; } });
}

class StorePanel extends EconPanel {
	constructor({ ui, net, onClose }) {
		super({ title: 'General Store', onClose });
		this.ui = ui;
		this.net = net;
		this.tab = 'buy';
		this.catalog = { sell: [], buy: [] };
		this.profile = { gold: 0, inv: [] };

		this.tabs = el('div', { class: 'ec-tabs', role: 'tablist', 'aria-label': 'Store mode' }, [
			el('button', { class: 'ec-tab ec-on', type: 'button', role: 'tab', 'data-tab': 'buy', 'aria-selected': 'true', text: 'Buy', onclick: () => this._setTab('buy') }),
			el('button', { class: 'ec-tab', type: 'button', role: 'tab', 'data-tab': 'sell', 'aria-selected': 'false', text: 'Sell', onclick: () => this._setTab('sell') }),
		]);
		this.purseValue = el('b', { text: '0' });
		this.purse = el('div', { class: 'ec-purse' }, [
			el('span', { text: 'Cash on hand' }),
			this.purseValue,
		]);
		this.card.insertBefore(this.purse, this.body);
		this.card.insertBefore(this.tabs, this.purse);

		this.track(net.on('store', (msg) => {
			this.settleFirstSnapshot();
			this.catalog = { sell: msg?.sell || [], buy: msg?.buy || [] };
			this._render();
		}));
		this.track(net.on('profile', (snap) => { this.endRequest(); this._applyProfile(snap); }));
		this.track(net.on('inv', (delta) => { this.endRequest(); this._applyProfile(delta); }));
		// A refused trade (no cash, pack full, not for sale) answers with a notice
		// and no snapshot, so it has to release the in-flight slot too.
		this.track(net.on('notice', (n) => {
			if (n?.kind !== 'store' && n?.kind !== 'full') return;
			this.endRequest();
			this.setStatus(n.text || '', n.kind === 'full' ? 'err' : 'ok');
		}));

		this.awaitFirstSnapshot(() => { net.requestStore(); net.requestProfile(); });
		net.requestStore();
		net.requestProfile();
		this._render();
	}

	_applyProfile(snap) {
		if (!snap) return;
		const before = this.profile.gold;
		if (Number.isFinite(snap.gold)) this.profile.gold = snap.gold;
		if (Array.isArray(snap.inv)) this.profile.inv = snap.inv;
		this.purseValue.textContent = this.profile.gold.toLocaleString();
		// The purse is a plain number on screen — nothing a screen reader would
		// revisit after a trade. Announce the delta so the outcome of a buy/sell
		// is audible, not just visible.
		if (Number.isFinite(snap.gold) && snap.gold !== before) {
			const delta = snap.gold - before;
			announce(`${delta > 0 ? 'Gained' : 'Spent'} ${Math.abs(delta).toLocaleString()}. Cash on hand ${this.profile.gold.toLocaleString()}.`);
		}
		this._render();
	}

	_setTab(tab) {
		this.tab = tab;
		// Keyed on data-tab, never the visible label: the label is translated copy.
		for (const b of this.tabs.children) {
			const on = b.dataset.tab === tab;
			b.classList.toggle('ec-on', on);
			b.setAttribute('aria-selected', on ? 'true' : 'false');
		}
		this._render();
	}

	_render() {
		this.body.replaceChildren();
		if (this.loading) { this.body.appendChild(this.skeleton(4)); return; }
		if (this.loadFailed) { this.body.appendChild(this.loadError('the store')); return; }
		if (this.tab === 'buy') this._renderBuy(); else this._renderSell();
	}

	// Re-render is enough: every button derives its disabled state from `pending`.
	_syncPending() { this._render(); }

	_renderBuy() {
		if (!this.catalog.buy.length) {
			this.body.appendChild(el('div', { class: 'ec-empty', text: 'The shelves are bare right now. The storekeeper restocks as the world turns over, so check back after a job or two.' }));
			return;
		}
		for (const entry of this.catalog.buy) {
			const disp = itemDisplay(entry.item);
			const afford = this.profile.gold >= entry.price;
			this.body.appendChild(el('div', { class: 'ec-row' }, [
				el('span', { class: 'ec-row-glyph', text: disp?.glyph || '📦' }),
				el('div', { class: 'ec-row-main' }, [
					el('div', { class: 'ec-row-name', text: `${entry.qty > 1 ? entry.qty + '× ' : ''}${entry.label || disp?.name || entry.item}` }),
					el('div', { class: 'ec-row-sub', text: `${entry.price} cash` }),
				]),
				el('button', {
					class: 'ec-row-btn', type: 'button', text: 'Buy', disabled: !afford || !!this.pending,
					'aria-label': `Buy ${entry.label || entry.item} for ${entry.price} cash`,
					onclick: () => {
						if (!this.beginRequest('Buying…')) return;
						this.net.storeBuy(entry.item);
					},
				}),
			]));
		}
	}

	_renderSell() {
		const sellable = new Set(this.catalog.sell.map((s) => s.item));
		const priceOf = new Map(this.catalog.sell.map((s) => [s.item, s.price]));
		const rows = this.profile.inv
			.map((slot, i) => ({ slot, i }))
			.filter(({ slot }) => slot?.item && slot.qty > 0 && sellable.has(slot.item));
		if (!rows.length) {
			this.body.appendChild(el('div', { class: 'ec-empty', text: 'Nothing to sell yet — gather wood, stone, coal, fish or hides out in the world and bring them back.' }));
			return;
		}
		for (const { slot, i } of rows) {
			const disp = itemDisplay(slot.item);
			const price = priceOf.get(slot.item) || 0;
			this.body.appendChild(el('div', { class: 'ec-row' }, [
				el('span', { class: 'ec-row-glyph', text: disp?.glyph || '📦' }),
				el('div', { class: 'ec-row-main' }, [
					el('div', { class: 'ec-row-name', text: `${disp?.name || slot.item} × ${slot.qty}` }),
					el('div', { class: 'ec-row-sub', text: `${price} cash each · ${price * slot.qty} total` }),
				]),
				el('button', {
					class: 'ec-row-btn', type: 'button', text: 'Sell all', disabled: !!this.pending,
					'aria-label': `Sell all ${disp?.name || slot.item} for ${price * slot.qty} cash`,
					onclick: () => {
						if (!this.beginRequest('Selling…')) return;
						this.net.storeSell({ zone: 'inv', i });
					},
				}),
			]));
		}
	}
}

// ---------------------------------------------------------------- bank

/**
 * Open the bank/ATM: move cash between the carried purse and the protected
 * bank. Banked cash survives a death drop; carried cash doesn't.
 * @param {{ ui: object, net: object }} deps
 */
export function openBankPanel({ ui, net }) {
	if (!net) return;
	if (_openBank) return;
	_openBank = new BankPanel({ ui, net, onClose: () => { _openBank = null; } });
}

class BankPanel extends EconPanel {
	constructor({ ui, net, onClose }) {
		super({ title: 'Bank / ATM', onClose });
		this.ui = ui;
		this.net = net;
		this.gold = 0;
		this.bankBal = 0;

		// Until the server's profile lands, both balances read as unknown rather
		// than as a confident "0" — telling a player they are broke when we have
		// simply not looked yet is the worst thing this panel could say.
		this.purseValue = el('b', { class: 'ec-pending-val', text: '…' });
		this.purse = el('div', { class: 'ec-purse' }, [
			el('span', { text: 'Cash on hand' }),
			this.purseValue,
		]);
		this.bankValue = el('b', { class: 'ec-pending-val', text: '…' });
		this.bankLine = el('div', { class: 'ec-purse' }, [
			el('span', { text: 'Banked (protected)' }),
			this.bankValue,
		]);
		this.card.insertBefore(this.purse, this.body);
		this.card.insertBefore(this.bankLine, this.body);

		this.depositInput = el('input', { type: 'number', min: '0', step: '1', class: 'ec-bank-input', 'aria-label': 'Amount to deposit', placeholder: '0' });
		this.withdrawInput = el('input', { type: 'number', min: '0', step: '1', class: 'ec-bank-input', 'aria-label': 'Amount to withdraw', placeholder: '0' });

		this.depositBtn = el('button', { class: 'ec-row-btn', type: 'button', text: 'Deposit', onclick: () => this._deposit() });
		this.withdrawBtn = el('button', { class: 'ec-row-btn ec-secondary', type: 'button', text: 'Withdraw', onclick: () => this._withdraw() });

		// "Max" fills the field from a balance we may not know yet, so both
		// presets are held with the transfer buttons until the profile lands.
		this.depositMaxBtn = el('button', { class: 'ec-bank-preset', type: 'button', text: 'Max', onclick: () => { this.depositInput.value = String(this.gold); } });
		this.withdrawMaxBtn = el('button', { class: 'ec-bank-preset', type: 'button', text: 'Max', onclick: () => { this.withdrawInput.value = String(this.bankBal); } });

		this.body.appendChild(el('div', { class: 'ec-row-sub', text: 'Deposit: protects cash from a death drop.' }));
		this.body.appendChild(el('div', { class: 'ec-bank-amount' }, [this.depositInput, this.depositBtn]));
		this.body.appendChild(el('div', { class: 'ec-bank-presets' }, [this.depositMaxBtn]));

		this.body.appendChild(el('div', { class: 'ec-row-sub', text: 'Withdraw: moves banked cash back to your purse.' }));
		this.body.appendChild(el('div', { class: 'ec-bank-amount' }, [this.withdrawInput, this.withdrawBtn]));
		this.body.appendChild(el('div', { class: 'ec-bank-presets' }, [this.withdrawMaxBtn]));

		this.track(net.on('profile', (snap) => {
			this.settleFirstSnapshot();
			this.endRequest();
			this._applyProfile(snap);
			this._render();
		}));
		// A transfer the server clamped to zero (nothing on hand, nothing banked)
		// answers with a notice and no snapshot, so release the slot on it too.
		this.track(net.on('notice', (n) => {
			if (n?.kind !== 'bank') return;
			this.endRequest();
			this.setStatus(n.text || '', 'ok');
		}));

		this.awaitFirstSnapshot(() => net.requestProfile());
		net.requestProfile();
		this._render();
	}

	// The bank's body is static, so "render" here means syncing the two live
	// bits: whether the balances are known yet, and whether a transfer is open.
	_render() {
		if (this.loadFailed) this.setStatus('Could not read your balance. The world stopped answering. Nothing was moved.', 'err');
		this._syncPending();
	}

	// Both transfer buttons ride the panel's single in-flight slot, so a
	// double-tapped Deposit can never send the same amount twice.
	_syncPending() {
		const blocked = !!this.pending || this.loading || this.loadFailed;
		this.depositBtn.disabled = blocked;
		this.withdrawBtn.disabled = blocked;
		this.depositMaxBtn.disabled = blocked;
		this.withdrawMaxBtn.disabled = blocked;
	}

	_applyProfile(snap) {
		if (!snap) return;
		const before = { gold: this.gold, bank: this.bankBal };
		if (Number.isFinite(snap.gold)) this.gold = snap.gold;
		if (Number.isFinite(snap.bank)) this.bankBal = snap.bank;
		this.purseValue.textContent = this.gold.toLocaleString();
		this.bankValue.textContent = this.bankBal.toLocaleString();
		this.purseValue.classList.remove('ec-pending-val');
		this.bankValue.classList.remove('ec-pending-val');
		// A transfer only changes two numbers on screen; say them out loud so a
		// screen-reader player knows the deposit actually landed.
		if (this.gold !== before.gold || this.bankBal !== before.bank) {
			announce(`Cash on hand ${this.gold.toLocaleString()}. Banked ${this.bankBal.toLocaleString()}.`);
		}
	}

	_deposit() {
		const amount = Math.max(0, Math.floor(Number(this.depositInput.value) || 0));
		if (!amount) { this.setStatus('Enter an amount to deposit.', 'err'); return; }
		if (amount > this.gold) { this.setStatus(`You're only carrying ${this.gold.toLocaleString()}.`, 'err'); return; }
		if (!this.beginRequest('Depositing…')) return;
		this.net.bank(amount);
		this.depositInput.value = '';
	}

	_withdraw() {
		const amount = Math.max(0, Math.floor(Number(this.withdrawInput.value) || 0));
		if (!amount) { this.setStatus('Enter an amount to withdraw.', 'err'); return; }
		if (amount > this.bankBal) { this.setStatus(`You've only got ${this.bankBal.toLocaleString()} banked.`, 'err'); return; }
		if (!this.beginRequest('Withdrawing…')) return;
		this.net.bank(-amount);
		this.withdrawInput.value = '';
	}
}
