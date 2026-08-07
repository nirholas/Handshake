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
		this.card = el('div', { class: 'ec-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, [
			el('div', { class: 'ec-head' }, [
				el('span', { class: 'ec-title', text: title }),
				el('button', { class: 'ec-x', type: 'button', 'aria-label': 'Close', text: '✕', onclick: () => this.close() }),
			]),
			this.body,
			this.status,
		]);
		this.overlay = el('div', { class: 'ec-overlay', onpointerdown: (e) => { if (e.target === this.overlay) this.close(); } }, [this.card]);
		this.card.addEventListener('keydown', (e) => {
			if (e.key === 'Escape') this.close();
			e.stopPropagation();
		});
		document.body.appendChild(this.overlay);
		requestAnimationFrame(() => this.overlay.classList.add('ec-on'));
	}

	track(unsub) { if (typeof unsub === 'function') this._unsubs.push(unsub); }

	setStatus(text, kind) {
		this.status.textContent = text || '';
		this.status.setAttribute('data-kind', kind || '');
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

		this.tabs = el('div', { class: 'ec-tabs' }, [
			el('button', { class: 'ec-tab ec-on', type: 'button', text: 'Buy', onclick: () => this._setTab('buy') }),
			el('button', { class: 'ec-tab', type: 'button', text: 'Sell', onclick: () => this._setTab('sell') }),
		]);
		this.purse = el('div', { class: 'ec-purse' }, [
			el('span', { text: 'Cash on hand' }),
			el('b', { text: '0' }),
		]);
		this.card.insertBefore(this.purse, this.body);
		this.card.insertBefore(this.tabs, this.purse);

		this.track(net.on('store', (msg) => { this.catalog = { sell: msg?.sell || [], buy: msg?.buy || [] }; this._render(); }));
		this.track(net.on('profile', (snap) => { this.endRequest(); this._applyProfile(snap); }));
		this.track(net.on('inv', (delta) => { this.endRequest(); this._applyProfile(delta); }));
		// A refused trade (no cash, pack full, not for sale) answers with a notice
		// and no snapshot, so it has to release the in-flight slot too.
		this.track(net.on('notice', (n) => {
			if (n?.kind !== 'store' && n?.kind !== 'full') return;
			this.endRequest();
			this.setStatus(n.text || '', n.kind === 'full' ? 'err' : 'ok');
		}));

		net.requestStore();
		net.requestProfile();
		this._render();
	}

	_applyProfile(snap) {
		if (!snap) return;
		if (Number.isFinite(snap.gold)) this.profile.gold = snap.gold;
		if (Array.isArray(snap.inv)) this.profile.inv = snap.inv;
		this.purse.lastChild.textContent = this.profile.gold.toLocaleString();
		this._render();
	}

	_setTab(tab) {
		this.tab = tab;
		for (const b of this.tabs.children) b.classList.toggle('ec-on', b.textContent.toLowerCase() === tab);
		this._render();
	}

	_render() {
		this.body.replaceChildren();
		if (this.tab === 'buy') this._renderBuy(); else this._renderSell();
	}

	// Re-render is enough: every button derives its disabled state from `pending`.
	_syncPending() { this._render(); }

	_renderBuy() {
		if (!this.catalog.buy.length) {
			this.body.appendChild(el('div', { class: 'ec-empty', text: 'Loading the catalog…' }));
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

		this.purse = el('div', { class: 'ec-purse' }, [
			el('span', { text: 'Cash on hand' }),
			el('b', { text: '0' }),
		]);
		this.bankLine = el('div', { class: 'ec-purse' }, [
			el('span', { text: 'Banked (protected)' }),
			el('b', { text: '0' }),
		]);
		this.card.insertBefore(this.purse, this.body);
		this.card.insertBefore(this.bankLine, this.body);

		this.depositInput = el('input', { type: 'number', min: '0', step: '1', class: 'ec-bank-input', 'aria-label': 'Amount to deposit', placeholder: '0' });
		this.withdrawInput = el('input', { type: 'number', min: '0', step: '1', class: 'ec-bank-input', 'aria-label': 'Amount to withdraw', placeholder: '0' });

		this.depositBtn = el('button', { class: 'ec-row-btn', type: 'button', text: 'Deposit', onclick: () => this._deposit() });
		this.withdrawBtn = el('button', { class: 'ec-row-btn ec-secondary', type: 'button', text: 'Withdraw', onclick: () => this._withdraw() });

		this.body.appendChild(el('div', { class: 'ec-row-sub', text: 'Deposit — protects cash from a death drop.' }));
		this.body.appendChild(el('div', { class: 'ec-bank-amount' }, [this.depositInput, this.depositBtn]));
		this.body.appendChild(el('div', { class: 'ec-bank-presets' }, [
			el('button', { class: 'ec-bank-preset', type: 'button', text: 'Max', onclick: () => { this.depositInput.value = String(this.gold); } }),
		]));

		this.body.appendChild(el('div', { class: 'ec-row-sub', text: 'Withdraw — moves banked cash back to your purse.' }));
		this.body.appendChild(el('div', { class: 'ec-bank-amount' }, [this.withdrawInput, this.withdrawBtn]));
		this.body.appendChild(el('div', { class: 'ec-bank-presets' }, [
			el('button', { class: 'ec-bank-preset', type: 'button', text: 'Max', onclick: () => { this.withdrawInput.value = String(this.bankBal); } }),
		]));

		this.track(net.on('profile', (snap) => { this.endRequest(); this._applyProfile(snap); }));
		// A transfer the server clamped to zero (nothing on hand, nothing banked)
		// answers with a notice and no snapshot, so release the slot on it too.
		this.track(net.on('notice', (n) => {
			if (n?.kind !== 'bank') return;
			this.endRequest();
			this.setStatus(n.text || '', 'ok');
		}));

		net.requestProfile();
	}

	// Both transfer buttons ride the panel's single in-flight slot, so a
	// double-tapped Deposit can never send the same amount twice.
	_syncPending() {
		const busy = !!this.pending;
		this.depositBtn.disabled = busy;
		this.withdrawBtn.disabled = busy;
	}

	_applyProfile(snap) {
		if (!snap) return;
		if (Number.isFinite(snap.gold)) this.gold = snap.gold;
		if (Number.isFinite(snap.bank)) this.bankBal = snap.bank;
		this.purse.lastChild.textContent = this.gold.toLocaleString();
		this.bankLine.lastChild.textContent = this.bankBal.toLocaleString();
	}

	_deposit() {
		const amount = Math.max(0, Math.floor(Number(this.depositInput.value) || 0));
		if (!amount) { this.setStatus('Enter an amount to deposit.', 'err'); return; }
		this.setStatus('Depositing…');
		this.net.bank(amount);
		this.depositInput.value = '';
	}

	_withdraw() {
		const amount = Math.max(0, Math.floor(Number(this.withdrawInput.value) || 0));
		if (!amount) { this.setStatus('Enter an amount to withdraw.', 'err'); return; }
		this.setStatus('Withdrawing…');
		this.net.bank(-amount);
		this.withdrawInput.value = '';
	}
}
