// Cosmetics Shop (R21 browse/preview + R22 x402 purchase) — in-world panel to
// browse the cosmetics catalog, filter by rarity, preview any item LIVE on your
// own avatar, and BUY a premium item with a real USDC payment over x402.
//
// The shop is pure 2D chrome: it fetches the real catalog and calls back into
// the scene (coincommunities.js) to equip/unequip a preview on the local rig. A
// "Buy" runs the x402 flow in cosmetics-purchase.js — open wallet, settle USDC,
// record ownership server-side — and flips the card to owned only once the
// server confirms it (no optimistic unlock). Owned state is read per-account
// from the R22 ledger. The item's value is quoted in $THREE (the only coin);
// USDC is the settlement asset shown on the buy button.
//
// Catalog source: the real endpoint /api/cosmetics/catalog (with the caller's
// account, so owned items render owned), with the static CDN mirror
// /cosmetics/catalog.json as a resilient fallback (and the dev source, where
// /api/* proxies to prod). Both are real network fetches — no sample array.

import { log } from '../shared/log.js';
import { purchaseCosmetic, resolveShopAccount } from './cosmetics-purchase.js';
import { openModal } from './a11y.js';
import { t } from './i18n-play.js';

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

const RARITY_LABEL = { common: 'Common', rare: 'Rare', epic: 'Epic', legendary: 'Legendary' };
// Placeholder glyph per slot, shown when an item has no preview image.
const SLOT_GLYPH = { hat: '🎩', glasses: '🕶️', earrings: '💎', outfit: '👕', skin: '🎨', emote: '✨' };

const fmtPrice = (n) => {
	if (!n || !isFinite(n)) return '0';
	if (n >= 1000) return (n / 1000).toFixed(n % 1000 ? 1 : 0) + 'K';
	return String(n);
};

// Fetch the catalog from the real endpoint, falling back to the static mirror.
// Throws only if neither source yields items, so the UI can show its error state.
// `account` (when set) makes premium items the account already bought read as
// owned — the static mirror has no account view, so it always shows them locked.
async function fetchCatalog(account) {
	const qs = account ? `?account=${encodeURIComponent(account)}` : '';
	const sources = [`/api/cosmetics/catalog${qs}`, '/cosmetics/catalog.json'];
	for (const url of sources) {
		try {
			const r = await fetch(url, { headers: { accept: 'application/json' } });
			if (!r.ok) continue;
			const data = await r.json();
			if (Array.isArray(data?.items)) return data.items;
		} catch { /* try the next source */ }
	}
	throw new Error('catalog unavailable');
}

export class CosmeticsShop {
	/**
	 * @param {object} h handlers:
	 *   onPreview(item)        — equip the item live on the local avatar.
	 *   onEndPreview()         — revert the active preview.
	 *   onPurchased(item)      — (optional) a premium item was just bought.
	 *   account                — (optional) verified wallet to key ownership on;
	 *                            falls back to the persisted guest id.
	 */
	constructor(h = {}) {
		this.h = h;
		this.items = [];
		this.rarity = 'all';       // active rarity filter
		this.previewId = null;     // id of the item currently previewing (toggle)
		this.state = 'idle';       // idle | loading | ready | error
		this.buyingId = null;      // id of the item whose payment is in flight
		// The account ownership + purchases are keyed on. Resolved once at build;
		// re-resolved on each open() in case the player signs in between sessions.
		this.account = resolveShopAccount(h.account);
		this._build();
	}

	_build() {
		this.closeBtn = el('button', {
			class: 'cc-shop-close', type: 'button', 'aria-label': 'Close shop',
			onclick: () => this.close(),
		}, [el('span', { 'aria-hidden': 'true', text: '✕' })]);

		this.filters = el('div', { class: 'cc-shop-filters', role: 'tablist', 'aria-label': 'Filter by rarity' });

		this.grid = el('div', { class: 'cc-shop-grid' });
		this.statusEl = el('div', { class: 'cc-shop-status', hidden: true, role: 'status', 'aria-live': 'polite' });

		this.body = el('div', { class: 'cc-shop-body' }, [this.statusEl, this.grid]);

		this.panel = el('div', {
			class: 'cc-shop-panel', role: 'dialog', 'aria-modal': 'true',
			'aria-label': t('play.shop_aria', 'Open cosmetics shop'),
			'data-i18n-attr': 'aria-label:play.shop_panel_aria',
		}, [
			el('div', { class: 'cc-shop-head' }, [
				el('div', { class: 'cc-shop-title' }, [
					el('span', { class: 'cc-shop-title-main', text: 'Cosmetics', 'data-i18n': 'play.shop_h' }),
					el('span', { class: 'cc-shop-title-sub', text: 'Preview live on your avatar', 'data-i18n': 'play.shop_sub' }),
				]),
				// Rarest Fits — the platform flex board (R25). Lazy-loaded on click so
				// it never weighs down the shop bundle.
				el('button', {
					class: 'cc-shop-flex', type: 'button', title: 'See the rarest fits & top earning creators',
					'aria-label': 'Open rarest fits leaderboard',
					onclick: () => this._openFlex(),
				}, [el('span', { 'aria-hidden': 'true', text: '✦' }), el('span', { class: 'cc-shop-flex-text', text: 'Rarest Fits' })]),
				this.closeBtn,
			]),
			this.filters,
			this.body,
		]);

		this.root = el('div', { class: 'cc-shop', id: 'cc-shop', hidden: true }, [this.panel]);
		// Backdrop tap closes; panel taps don't bubble out.
		this.root.addEventListener('click', (e) => { if (e.target === this.root) this.close(); });
		// World hotkeys live on `window`; keystrokes aimed at the shop must not
		// also drive the avatar behind it.
		this.panel.addEventListener('keydown', (e) => e.stopPropagation());

		document.body.appendChild(this.root);
		this._buildFilters();
	}

	_buildFilters() {
		this.filters.textContent = '';
		const make = (key, label) => el('button', {
			class: 'cc-shop-chip' + (this.rarity === key ? ' cc-active' : ''),
			type: 'button', role: 'tab', 'aria-selected': this.rarity === key ? 'true' : 'false',
			'data-rarity': key,
			onclick: () => this._setRarity(key),
		}, label);
		this.filters.appendChild(make('all', 'All'));
		for (const r of ['common', 'rare', 'epic', 'legendary']) this.filters.appendChild(make(r, RARITY_LABEL[r]));
	}

	_setRarity(key) {
		if (this.rarity === key) return;
		this.rarity = key;
		this._buildFilters();
		this._render();
	}

	// ── open / close ──────────────────────────────────────────────────────────

	isOpen() { return !this.root.hidden; }
	toggle() { this.isOpen() ? this.close() : this.open(); }

	async open() {
		if (this.isOpen()) return;
		this.root.hidden = false;
		requestAnimationFrame(() => this.root.classList.add('cc-shop-in'));
		// Escape stack + Tab containment + focus restore, shared with every other
		// /play panel (src/game/a11y.js).
		this._releaseModal = openModal(this.panel, { close: () => this.close(), initialFocus: this.closeBtn });
		// Re-resolve the account in case the player signed in since last open, so a
		// fresh wallet sees its owned items rather than the guest's.
		const acct = resolveShopAccount(this.h.account);
		const accountChanged = acct !== this.account;
		this.account = acct;
		// Load once; re-open reuses the catalog (cheap, and avoids a flash) — unless
		// the account changed, which flips owned/locked state and needs a refetch.
		if (this.state !== 'ready' || accountChanged) await this._load();
		else this._render();
	}

	close() {
		if (!this.isOpen()) return;
		this.root.classList.remove('cc-shop-in');
		this._releaseModal?.();
		this._releaseModal = null;
		// Reverting any live preview is the whole point — don't leave a tried-on
		// item stuck on the avatar after the shop closes.
		this._clearPreview();
		// Match the CSS transition before hiding so the exit animates.
		setTimeout(() => { this.root.hidden = true; }, 180);
	}

	dispose() {
		this._releaseModal?.();
		this._releaseModal = null;
		this.root.remove();
	}

	// ── data ──────────────────────────────────────────────────────────────────

	async _load() {
		this.state = 'loading';
		this._renderSkeleton();
		try {
			// Always fetch the full catalog (keyed on the account so owned items read
			// owned); rarity filtering is client-side so switching tabs is instant.
			this.items = await fetchCatalog(this.account);
			this.state = 'ready';
			this._render();
		} catch (err) {
			log.warn('[shop] catalog load failed:', err?.message);
			this.state = 'error';
			this._renderError();
		}
	}

	// ── rendering ───────────────────────────────────────────────────────────────

	_status(text, kind = '') {
		this.statusEl.textContent = text || '';
		this.statusEl.hidden = !text;
		this.statusEl.dataset.kind = text ? kind : '';
	}

	_renderSkeleton() {
		this._status('');
		this.grid.textContent = '';
		this.grid.classList.remove('cc-shop-empty-grid');
		for (let i = 0; i < 8; i++) {
			this.grid.appendChild(el('div', { class: 'cc-shop-card cc-shop-skel', 'aria-hidden': 'true' }, [
				el('div', { class: 'cc-shop-thumb cc-skel-box' }),
				el('div', { class: 'cc-shop-meta' }, [
					el('div', { class: 'cc-skel-line' }),
					el('div', { class: 'cc-skel-line cc-skel-short' }),
				]),
			]));
		}
	}

	_renderError() {
		this._status('');
		this.grid.textContent = '';
		this.grid.classList.add('cc-shop-empty-grid');
		this.grid.appendChild(el('div', { class: 'cc-shop-empty' }, [
			el('div', { class: 'cc-shop-empty-ico', 'aria-hidden': 'true', text: '⚠' }),
			el('div', { class: 'cc-shop-empty-title', text: 'Couldn’t load the shop' }),
			el('div', { class: 'cc-shop-empty-sub', text: 'The catalog didn’t load. Check your connection and try again.' }),
			el('button', { class: 'cc-shop-retry', type: 'button', text: 'Retry', onclick: () => this._load() }),
		]));
	}

	_render() {
		if (this.state === 'loading') return this._renderSkeleton();
		if (this.state === 'error') return this._renderError();

		const list = this.rarity === 'all' ? this.items : this.items.filter((i) => i.rarity === this.rarity);
		this.grid.textContent = '';

		if (!list.length) {
			this.grid.classList.add('cc-shop-empty-grid');
			this.grid.appendChild(el('div', { class: 'cc-shop-empty' }, [
				el('div', { class: 'cc-shop-empty-ico', 'aria-hidden': 'true', text: '🔍' }),
				el('div', { class: 'cc-shop-empty-title', text: 'Nothing in this tier yet' }),
				el('div', { class: 'cc-shop-empty-sub', text: 'No cosmetics match this rarity. Try another filter.' }),
				el('button', { class: 'cc-shop-retry', type: 'button', text: 'Show all', onclick: () => this._setRarity('all') }),
			]));
			this._status('');
			return;
		}

		this.grid.classList.remove('cc-shop-empty-grid');
		const ownedCount = list.filter((i) => i.owned).length;
		this._status(`${list.length} item${list.length === 1 ? '' : 's'} · ${ownedCount} owned`);
		for (const item of list) this.grid.appendChild(this._card(item));
	}

	_card(item) {
		const active = this.previewId === item.id;

		const thumb = item.previewImage
			? el('img', {
				class: 'cc-shop-thumb-img', src: item.previewImage, alt: '', loading: 'lazy',
				// Missing/404 art degrades to the slot glyph instead of a broken icon.
				onerror: (e) => { e.target.replaceWith(this._glyph(item)); },
			})
			: this._glyph(item);

		// The thumb is the live-preview toggle (R21): a button so it's keyboard- and
		// screen-reader-operable on its own, separate from the Buy button below.
		const previewBtn = el('button', {
			class: 'cc-shop-thumb cc-shop-thumb-btn',
			type: 'button',
			'aria-pressed': active ? 'true' : 'false',
			'aria-label': `${active ? 'Stop previewing' : 'Preview'} ${item.name} on your avatar`,
			title: active ? 'Click to stop preview' : 'Click to preview on your avatar',
			onclick: () => this._toggleItem(item),
		}, [
			thumb,
			el('span', { class: 'cc-shop-rarity', 'data-rarity': item.rarity, text: RARITY_LABEL[item.rarity] }),
			el('span', { class: 'cc-shop-preview-tag', 'aria-hidden': 'true', text: active ? 'Previewing' : 'Preview' }),
		]);

		const card = el('div', {
			class: 'cc-shop-card'
				+ ` cc-rarity-${item.rarity}`
				+ (item.owned ? ' cc-is-owned' : ' cc-is-locked')
				+ (active ? ' cc-active' : ''),
			'data-id': item.id,
		}, [
			previewBtn,
			el('div', { class: 'cc-shop-meta' }, [
				el('span', { class: 'cc-shop-name', text: item.name }),
				// The item's value is quoted in $THREE — the only coin (R21 copy).
				el('span', { class: 'cc-shop-value', text: `${fmtPrice(item.price)} $THREE` }),
				this._action(item),
			]),
		]);
		return card;
	}

	// The owned badge or the Buy button (R22). Built separately so a settled
	// purchase can swap just this node to "Owned" without re-rendering the grid.
	_action(item) {
		if (item.owned) {
			return el('span', { class: 'cc-shop-action cc-shop-badge cc-owned', text: 'Owned' });
		}
		const pending = this.buyingId === item.id;
		const buy = el('button', {
			class: 'cc-shop-action cc-shop-buy',
			type: 'button',
			disabled: pending || undefined,
			// USDC is the settlement asset (not a coin we hold) — labelled on the CTA.
			'aria-label': `Buy ${item.name} for ${item.priceUsdc} USDC`,
			text: pending ? 'Opening wallet…' : `Buy · $${item.priceUsdc} USDC`,
			onclick: () => this._buy(item),
		});
		return buy;
	}

	_glyph(item) {
		return el('div', { class: 'cc-shop-glyph', 'aria-hidden': 'true', text: SLOT_GLYPH[item.slot] || '✦' });
	}

	// Open the Rarest Fits flex board (R25), highlighting the current coin world.
	// Lazy chunk — the leaderboard UI only loads when a player asks for it.
	async _openFlex() {
		try {
			const { openCosmeticsFlex } = await import('./cosmetics-flex.js');
			openCosmeticsFlex({ coinMint: this.h.coinMint || '' });
		} catch (err) {
			log.warn('[shop] flex board failed to load', err?.message);
			this._status('Couldn’t open the flex board. Try again in a moment.', 'error');
		}
	}

	// ── purchase (R22) ──────────────────────────────────────────────────────────
	// Run the real x402 USDC payment for a locked item and, on the server's
	// confirmation, flip the card to owned. Every state is honest: pending while
	// the wallet is open, owned only after the payment verifies, an actionable
	// message on failure (including insufficient funds). No optimistic unlock.
	async _buy(item) {
		if (this.buyingId || item.owned) return;
		this.buyingId = item.id;
		const card = this.grid.querySelector(`.cc-shop-card[data-id="${CSS.escape(item.id)}"]`);
		this._swapAction(card, item);
		this._status(`Settling payment for ${item.name}…`, 'pending');
		try {
			const ticket = await purchaseCosmetic(item, { account: this.account, coin: this.h.coinMint });
			this.buyingId = null;
			item.owned = true;
			if (card) {
				card.classList.remove('cc-is-locked');
				card.classList.add('cc-is-owned');
				this._swapAction(card, item);
			}
			this._status(
				ticket.newlyOwned ? `Unlocked ${item.name}.` : `${item.name} is already in your wardrobe.`,
				'ok',
			);
			try { this.h.onPurchased?.(item, ticket); } catch (err) { log.warn('[shop] onPurchased', err?.message); }
		} catch (err) {
			this.buyingId = null;
			this._swapAction(card, item);
			if (err?.code === 'cancelled') { this._status(''); return; }
			const msg = String(err?.message || err);
			// The wallet relays an insufficient-balance error verbatim — turn it into
			// an actionable nudge instead of a raw failure string.
			const insufficient = /insufficient|balance|not enough|exceeds/i.test(msg);
			this._status(
				insufficient
					? `Not enough USDC to buy ${item.name}. Top up your wallet and try again.`
					: `Purchase failed: ${msg}`,
				'error',
			);
		}
	}

	// Replace just the action node of a card in place (Buy ⇄ pending ⇄ Owned).
	_swapAction(card, item) {
		const old = card?.querySelector('.cc-shop-action');
		if (old) old.replaceWith(this._action(item));
	}

	// ── preview toggle ────────────────────────────────────────────────────────

	async _toggleItem(item) {
		// Re-selecting the active item ends the preview.
		if (this.previewId === item.id) { this._clearPreview(); this._render(); return; }
		this.previewId = item.id;
		this._render();
		try {
			await this.h.onPreview?.(item);
		} catch (err) {
			log.warn('[shop] preview failed:', err?.message);
		}
	}

	_clearPreview() {
		if (!this.previewId) return;
		this.previewId = null;
		try { this.h.onEndPreview?.(); } catch { /* ignore */ }
	}
}
