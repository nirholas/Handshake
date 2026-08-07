// My Cosmetics — owned-item inventory + equip panel (R23).
//
// Shows every cosmetic the player owns (free + unlocked premium), grouped by
// slot (dye / headwear / eyewear / earrings / aura). Equipped items are
// highlighted; clicking equips the item (or unequips if already equipped, by
// sending the slot's `none` default). Locked premium items are shown dimmed
// with a "Shop" shortcut so the player can unlock them without leaving the
// wardrobe.
//
// Data source: the server's authoritative profile snapshot. Call setProfile()
// each time the `profile` message arrives; the panel re-renders in place
// without closing.
//
// Equipping is always server-authoritative: the panel fires onEquip(id) and
// the scene sends `equip-cosmetic` to the server. The server validates
// ownership, updates the schema (peers re-render), persists to the account,
// and echoes a fresh profile back — which lands in setProfile() and updates
// the UI. Unequip = equip the slot's `none` default (always free).

import {
	COSMETICS, SLOTS, SLOT_LABELS, DEFAULT_LOADOUT,
} from '../../multiplayer/src/cosmetics-catalog.js';
import { openModal } from './a11y.js';

function el(tag, props = {}, kids = []) {
	const n = document.createElement(tag);
	for (const [k, v] of Object.entries(props)) {
		if (k === 'class') n.className = v;
		else if (k === 'text') n.textContent = v;
		else if (k === 'html') n.innerHTML = v;
		else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
		else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v === true ? '' : v);
	}
	for (const kid of [].concat(kids)) {
		if (kid != null && kid !== false) {
			n.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
		}
	}
	return n;
}

const RARITY_LABEL = { common: 'Common', rare: 'Rare', epic: 'Epic', legendary: 'Legendary' };

// Cosmetics grouped and ordered by slot, matching SLOTS order.
const BY_SLOT = SLOTS.map((slot) => ({
	slot,
	label: SLOT_LABELS[slot] || slot,
	items: COSMETICS.filter((c) => c.slot === slot),
}));

export class CosmeticsWardrobe {
	/**
	 * @param {object} h handlers:
	 *   onEquip(id)   — player wants to equip/unequip id (scene sends to server)
	 *   onShop()      — player clicked "Open shop" on a locked item
	 */
	constructor(h = {}) {
		this.h = h;
		// profile snapshot cosmetics: { owned: string[], equipped: {slot: id} }
		this._cosmetics = null;
		// pending equip animation (id being processed by server)
		this._pending = null;
		this._build();
	}

	// ── build DOM ────────────────────────────────────────────────────────────

	_build() {
		this._injectStyles();

		this.closeBtn = el('button', {
			class: 'cw-close', type: 'button', 'aria-label': 'Close wardrobe',
			onclick: () => this.close(),
		}, [el('span', { 'aria-hidden': 'true', text: '✕' })]);

		this.body = el('div', { class: 'cw-body' });

		this.panel = el('div', {
			class: 'cw-panel', role: 'dialog', 'aria-modal': 'true',
			'aria-label': 'My Cosmetics wardrobe',
		}, [
			el('div', { class: 'cw-head' }, [
				el('div', { class: 'cw-title' }, [
					el('span', { class: 'cw-title-main', text: 'My Cosmetics' }),
					el('span', { class: 'cw-title-sub', text: 'Equip your owned looks — persists across all worlds' }),
				]),
				this.closeBtn,
			]),
			this.body,
		]);

		this.root = el('div', { class: 'cw-root', id: 'cc-wardrobe', hidden: true }, [this.panel]);
		this.root.addEventListener('click', (e) => { if (e.target === this.root) this.close(); });
		// World hotkeys live on `window`; keystrokes aimed at the wardrobe must not
		// also drive the avatar behind it.
		this.panel.addEventListener('keydown', (e) => e.stopPropagation());
		document.body.appendChild(this.root);
	}

	// ── open / close ──────────────────────────────────────────────────────────

	isOpen() { return !this.root.hidden; }
	toggle() { this.isOpen() ? this.close() : this.open(); }

	open() {
		if (this.isOpen()) return;
		this.root.hidden = false;
		requestAnimationFrame(() => this.root.classList.add('cw-in'));
		// Escape stack + Tab containment + focus restore, shared with every other
		// /play panel (src/game/a11y.js).
		this._releaseModal = openModal(this.panel, { close: () => this.close(), initialFocus: this.closeBtn });
		// If no profile yet show loading skeleton; it fills in when setProfile arrives.
		if (!this._cosmetics) this._renderLoading();
	}

	close() {
		if (!this.isOpen()) return;
		this.root.classList.remove('cw-in');
		this._releaseModal?.();
		this._releaseModal = null;
		setTimeout(() => { this.root.hidden = true; }, 180);
	}

	dispose() {
		this._releaseModal?.();
		this._releaseModal = null;
		this.root.remove();
	}

	// ── data ──────────────────────────────────────────────────────────────────

	/**
	 * Called by the scene each time a `profile` message arrives from the server.
	 * The panel re-renders in place; this is the single source of truth for what
	 * the player owns and what's currently equipped.
	 * @param {object} snap  profileSnapshot() — specifically snap.cosmetics
	 */
	setProfile(snap) {
		const cs = snap?.cosmetics;
		if (!cs) return;
		this._cosmetics = {
			owned: new Set(Array.isArray(cs.owned) ? cs.owned : []),
			equipped: (cs.equipped && typeof cs.equipped === 'object') ? cs.equipped : {},
		};
		// Clear any pending indicator — the server responded
		this._pending = null;
		if (this.isOpen()) this._render();
	}

	// ── rendering ─────────────────────────────────────────────────────────────

	_renderLoading() {
		this.body.textContent = '';
		for (const { slot, label } of BY_SLOT) {
			const row = el('div', { class: 'cw-slot-row', 'data-slot': slot });
			row.appendChild(el('div', { class: 'cw-slot-label', text: label }));
			const cards = el('div', { class: 'cw-cards' });
			for (let i = 0; i < 4; i++) cards.appendChild(el('div', { class: 'cw-card cw-skel' }));
			row.appendChild(cards);
			this.body.appendChild(row);
		}
	}

	_render() {
		if (!this._cosmetics) { this._renderLoading(); return; }

		const { owned, equipped } = this._cosmetics;
		this.body.textContent = '';

		for (const { slot, label, items } of BY_SLOT) {
			const row = el('div', { class: 'cw-slot-row', 'data-slot': slot });
			row.appendChild(el('div', { class: 'cw-slot-label', text: label }));
			const cards = el('div', { class: 'cw-cards' });
			for (const item of items) cards.appendChild(this._card(item, equipped, owned));
			row.appendChild(cards);
			this.body.appendChild(row);
		}
	}

	_isOwned(item, ownedSet) {
		return item.tier === 'free' || ownedSet.has(item.id);
	}

	_card(item, equipped, ownedSet) {
		const isOwned = this._isOwned(item, ownedSet);
		const equippedId = equipped[item.slot];
		const isEquipped = equippedId === item.id;
		const isPending = this._pending === item.id;

		// The none/default items are special: clicking them unequips the slot.
		const isNone = item.id === DEFAULT_LOADOUT[item.slot];

		const thumb = item.thumb
			? el('img', {
				class: 'cw-thumb-img', src: item.thumb, alt: item.name, loading: 'lazy',
				onerror: (e) => { e.target.replaceWith(this._swatch(item)); },
			})
			: this._swatch(item);

		const card = el('button', {
			class: 'cw-card'
				+ (isOwned ? '' : ' cw-locked')
				+ (isEquipped ? ' cw-equipped' : '')
				+ (isPending ? ' cw-pending' : ''),
			type: 'button',
			'data-id': item.id,
			'aria-pressed': isOwned ? (isEquipped ? 'true' : 'false') : undefined,
			'aria-label': isOwned
				? `${isEquipped ? 'Unequip' : 'Equip'} ${item.name}`
				: `${item.name} — locked, open shop to buy`,
			title: isOwned
				? (isEquipped ? `Equipped · click to unequip` : `Click to equip ${item.name}`)
				: `Locked · buy in the shop to unlock`,
			onclick: () => this._onCardClick(item, isOwned, isEquipped),
		}, [
			el('div', { class: 'cw-thumb' }, [
				thumb,
				isEquipped
					? el('span', { class: 'cw-check', 'aria-hidden': 'true' },
						[el('svg', { viewBox: '0 0 16 16', width: '12', height: '12', fill: 'none', stroke: 'currentColor', 'stroke-width': '2.2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
							[el('polyline', { points: '2 8 6 12 14 4' })])])
					: (isOwned ? null : el('span', { class: 'cw-lock', 'aria-hidden': 'true', text: '🔒' })),
				item.rarity !== 'common'
					? el('span', { class: 'cw-rarity', 'data-rarity': item.rarity, text: RARITY_LABEL[item.rarity] })
					: null,
			]),
			el('div', { class: 'cw-meta' }, [
				el('span', { class: 'cw-name', text: isNone ? 'None' : item.name }),
				!isOwned && item.price
					? el('span', { class: 'cw-price', text: `${item.price} $THREE` })
					: null,
				isEquipped
					? el('span', { class: 'cw-tag cw-tag-on', text: 'Equipped' })
					: (isPending ? el('span', { class: 'cw-tag cw-tag-pending', text: '…' }) : null),
			]),
		]);

		return card;
	}

	_swatch(item) {
		const v = item.visual;
		if (v?.tint || item.swatch) {
			return el('div', { class: 'cw-swatch', style: `background:${item.swatch || v.tint}` });
		}
		if (v?.aura || item.swatch) {
			return el('div', { class: 'cw-swatch cw-swatch-aura', style: `background:${item.swatch || v.aura}` });
		}
		const GLYPHS = { dye: '🎨', headwear: '🎩', eyewear: '🕶️', earrings: '💎', aura: '✨' };
		return el('div', { class: 'cw-glyph', 'aria-hidden': 'true', text: GLYPHS[item.slot] || '✦' });
	}

	// ── interaction ───────────────────────────────────────────────────────────

	_onCardClick(item, isOwned, isEquipped) {
		if (!isOwned) {
			// Locked item — shortcut to the shop so the player can buy it.
			try { this.h.onShop?.(); } catch { /* ignore */ }
			return;
		}
		// Equip the item, or unequip by equipping the slot's `none` default.
		const targetId = isEquipped ? DEFAULT_LOADOUT[item.slot] : item.id;
		if (this._pending === targetId) return; // already in flight
		this._pending = targetId;
		// Optimistic re-render: mark the card pending immediately.
		this._refreshCard(item.id, isEquipped);
		try { this.h.onEquip?.(targetId); } catch { /* ignore */ }
	}

	// Re-render a single card after a user action without a full panel repaint.
	// The server will echo a fresh profile shortly; this just gives instant feedback.
	_refreshCard(id, wasEquipped) {
		const card = this.body.querySelector(`.cw-card[data-id="${CSS.escape(id)}"]`);
		if (!card) return;
		card.classList.toggle('cw-pending', true);
		// Swap the equip tag in the meta section
		const tag = card.querySelector('.cw-tag');
		if (tag) {
			tag.textContent = '…';
			tag.className = 'cw-tag cw-tag-pending';
		} else {
			const meta = card.querySelector('.cw-meta');
			if (meta) meta.appendChild(el('span', { class: 'cw-tag cw-tag-pending', text: '…' }));
		}
	}

	// ── inline styles ─────────────────────────────────────────────────────────

	_injectStyles() {
		if (document.getElementById('cw-styles')) return;
		const css = `
.cw-root {
	position: fixed; inset: 0; z-index: 92;
	display: grid; place-items: center; padding: 20px;
	background: rgba(4, 4, 6, 0.62); backdrop-filter: blur(6px);
	opacity: 0; transition: opacity 0.18s ease;
	font: 14px/1.4 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
}
.cw-root.cw-in { opacity: 1; }

.cw-panel {
	width: min(720px, 100%); max-height: min(88vh, 760px);
	display: flex; flex-direction: column;
	background: var(--cc-panel-solid, #0c0c0c); color: var(--cc-text, #f5f5f6);
	border: 1px solid var(--cc-edge, rgba(255,255,255,.12));
	border-radius: var(--cc-radius, 4px);
	box-shadow: var(--cc-shadow, 0 16px 50px rgba(0,0,0,.7));
	transform: translateY(10px) scale(0.99); opacity: 0;
	transition: transform 0.2s cubic-bezier(0.16, 0.84, 0.34, 1), opacity 0.2s ease;
}
.cw-in .cw-panel { transform: none; opacity: 1; }

.cw-head {
	display: flex; align-items: center; justify-content: space-between;
	gap: 10px; padding: 16px 18px 14px;
	border-bottom: 1px solid var(--cc-edge-soft, rgba(255,255,255,.07)); flex: none;
}
.cw-title { display: flex; flex-direction: column; gap: 3px; flex: 1; min-width: 0; }
.cw-title-main { font-size: 17px; font-weight: 800; letter-spacing: 0.01em; }
.cw-title-sub { font-size: 12px; color: var(--cc-dim, #8c8c92); }

.cw-close {
	flex: none; width: 32px; height: 32px; display: grid; place-items: center;
	background: none; border: 1px solid var(--cc-edge, rgba(255,255,255,.12));
	border-radius: 2px; color: var(--cc-dim, #8c8c92); font-size: 14px; cursor: pointer;
	transition: color 0.12s ease, border-color 0.12s ease, background 0.12s ease;
}
.cw-close:hover { color: var(--cc-text, #f5f5f6); border-color: var(--cc-edge-hi, rgba(255,255,255,.55)); background: rgba(255,255,255,0.05); }
.cw-close:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }

.cw-body {
	flex: 1; min-height: 0; overflow-y: auto;
	padding: 14px 18px 20px; display: flex; flex-direction: column; gap: 20px;
}

/* Per-slot section */
.cw-slot-row { display: flex; flex-direction: column; gap: 9px; }
.cw-slot-label {
	font-size: 10.5px; font-weight: 800; letter-spacing: 0.1em; text-transform: uppercase;
	color: var(--cc-faint, #5a5a60);
}

.cw-cards {
	display: grid; gap: 9px;
	grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
}

/* A cosmetic card — the button itself */
.cw-card {
	display: flex; flex-direction: column; text-align: left;
	padding: 0; background: var(--cc-bg2, #101010);
	border: 1px solid var(--cc-edge-soft, rgba(255,255,255,.07));
	border-radius: var(--cc-radius, 4px);
	color: var(--cc-text, #f5f5f6); cursor: pointer; overflow: hidden;
	transition: transform 0.12s ease, border-color 0.12s ease, box-shadow 0.12s ease, opacity 0.12s ease;
	appearance: none; -webkit-appearance: none; font: inherit;
}
.cw-card:hover { transform: translateY(-2px); border-color: var(--cc-edge-hi, rgba(255,255,255,.55)); }
.cw-card:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
.cw-card.cw-equipped {
	border-color: #fff; box-shadow: 0 0 14px rgba(255,255,255,.25);
}
.cw-card.cw-locked { opacity: 0.5; cursor: default; }
.cw-card.cw-locked:hover { transform: none; border-color: var(--cc-edge-soft, rgba(255,255,255,.07)); }
.cw-card.cw-pending { pointer-events: none; opacity: 0.7; }

/* Thumbnail area */
.cw-thumb {
	position: relative; aspect-ratio: 1 / 1; width: 100%;
	display: grid; place-items: center; overflow: hidden;
	background:
		radial-gradient(120% 120% at 50% 20%, rgba(255,255,255,0.07), rgba(255,255,255,0) 60%),
		var(--cc-bg3, #181818);
	border-bottom: 1px solid var(--cc-edge-soft, rgba(255,255,255,.07));
}
.cw-thumb-img { width: 100%; height: 100%; object-fit: contain; padding: 8px; }
.cw-swatch {
	width: 52%; height: 52%; border-radius: 50%;
	box-shadow: 0 0 12px rgba(0,0,0,0.5);
}
.cw-swatch-aura {
	border-radius: 50%; opacity: 0.85;
	box-shadow: 0 0 18px currentColor;
}
.cw-glyph { font-size: 30px; line-height: 1; opacity: 0.8; filter: grayscale(1) brightness(1.4); }

/* Equipped checkmark badge */
.cw-check {
	position: absolute; bottom: 6px; right: 6px;
	width: 20px; height: 20px;
	display: grid; place-items: center;
	background: #fff; color: #060607;
	border-radius: 50%;
}
/* Locked glyph overlay */
.cw-lock {
	position: absolute; bottom: 6px; right: 6px; font-size: 13px; line-height: 1;
}
/* Rarity badge */
.cw-rarity {
	position: absolute; top: 5px; left: 5px;
	padding: 1px 6px; border-radius: 999px;
	font-size: 8.5px; font-weight: 800; letter-spacing: 0.1em; text-transform: uppercase;
	color: var(--cc-text, #f5f5f6); background: rgba(0,0,0,0.55);
	border: 1px solid var(--cc-edge, rgba(255,255,255,.12));
}
.cw-rarity[data-rarity="rare"] { border-color: rgba(255,255,255,.32); }
.cw-rarity[data-rarity="epic"] { border-color: rgba(255,255,255,.55); color: #fff; }
.cw-rarity[data-rarity="legendary"] { border-color: #fff; color: #060607; background: rgba(255,255,255,.92); }

/* Skeleton loading cards */
.cw-skel {
	pointer-events: none; background: var(--cc-bg2, #101010);
}
.cw-skel::before {
	content: ''; display: block; aspect-ratio: 1/1; width: 100%;
	background: linear-gradient(90deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.09) 50%, rgba(255,255,255,0.04) 100%);
	background-size: 200% 100%;
	animation: cw-shimmer 1.4s ease infinite;
}
@keyframes cw-shimmer { 0%{background-position:200% 0} 100%{background-position:-200% 0} }

/* Item meta (name / price / state tag) */
.cw-meta {
	display: flex; flex-direction: column; gap: 4px; padding: 8px 9px 9px;
}
.cw-name { font-size: 11.5px; font-weight: 700; letter-spacing: 0.01em; line-height: 1.2; }
.cw-price { font-size: 10px; font-weight: 700; color: var(--cc-dim, #8c8c92); letter-spacing: 0.02em; }
.cw-tag {
	margin-top: 2px; font-size: 10px; font-weight: 800; letter-spacing: 0.05em;
	text-transform: uppercase; align-self: flex-start;
	padding: 2px 6px; border-radius: 999px;
}
.cw-tag-on { color: #060607; background: #fff; }
.cw-tag-pending { color: var(--cc-dim, #8c8c92); background: rgba(255,255,255,.08); }

@media (max-width: 480px) {
	.cw-cards { grid-template-columns: repeat(auto-fill, minmax(80px, 1fr)); }
}
`;
		const style = el('style', { id: 'cw-styles' });
		style.textContent = css;
		document.head.appendChild(style);
	}
}
