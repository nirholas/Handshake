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
		// Cosmetic id the current session just unlocked (an event souvenir drop),
		// badged "New" until the player opens the panel and sees it.
		this._newId = null;
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
		// Otherwise repaint: a souvenir may have been granted (markNew) while the
		// panel was closed, and the stale render wouldn't be showing it.
		if (!this._cosmetics) this._renderLoading();
		else { this._render(); this._scrollToNew(); }
	}

	// Bring a freshly granted souvenir into view. A wardrobe with five slots of
	// cards can easily open with the new item below the fold, which would make the
	// "go look in My Fits" prompt land on an apparently unchanged panel.
	_scrollToNew() {
		if (!this._newId) return;
		const card = this.body.querySelector(`.cw-card[data-id="${CSS.escape(this._newId)}"]`);
		card?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
	}

	close() {
		if (!this.isOpen()) return;
		// The panel has been seen, so the "New" highlight has done its job. Leaving
		// it up would turn a one-time nudge into permanent noise.
		this._newId = null;
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
		// Only clear the pending indicator once the equipped loadout actually
		// reflects the change we asked for. Clearing on ANY profile message meant
		// an unrelated echo (a gold change from a mob hit, a quest payout) wiped
		// the spinner while the equip was still in flight, so the card looked
		// settled before it was.
		if (this._pending && this._equippedHas(this._pending)) this._pending = null;
		if (this.isOpen()) this._render();
	}

	// Is `id` currently worn in any slot of the latest snapshot? An unequip
	// (pending id '') settles when no slot holds the item any more, which the
	// caller expresses by passing the emptied slot's id.
	_equippedHas(id) {
		const eq = this._cosmetics?.equipped || {};
		return Object.values(eq).includes(id);
	}

	/**
	 * The server refused the in-flight equip. There is no profile echo on that
	 * path, so without this the card's pending spinner would run forever.
	 * @param {string} [text] the server's reason, shown on the panel
	 */
	onRejected(text) {
		if (!this._pending) return;
		this._pending = null;
		this._rejectNote = text || 'That change did not go through.';
		if (this.isOpen()) this._render();
	}

	/**
	 * Flag a cosmetic as freshly unlocked this session, so the panel points at it
	 * when the player gets here. Called by the souvenir drop (src/game/
	 * event-souvenir.js is the toast; this is the other half of the same moment,
	 * for the player who dismisses the toast and comes looking later).
	 * @param {string} id catalog id the server just granted
	 */
	markNew(id) {
		if (typeof id !== 'string' || !id) return;
		this._newId = id;
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

		// A refused change explains itself at the top of the panel rather than
		// leaving the player to guess why nothing happened.
		if (this._rejectNote) {
			this.body.appendChild(el('div', { class: 'cw-reject', role: 'status', text: this._rejectNote }));
		}

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
		// Event souvenirs are granted for being somewhere at some time and have no
		// purchase path at all, so a locked one must never be dressed up as
		// something to buy: no price, no shop shortcut, and copy that says why it
		// is locked instead of implying money would fix it.
		const isEvent = item.tier === 'event';
		// The item this session's souvenir drop just granted, highlighted until the
		// player has actually laid eyes on the panel.
		const isNew = this._newId === item.id && isOwned;

		const thumb = item.thumb
			? el('img', {
				class: 'cw-thumb-img', src: item.thumb, alt: item.name, loading: 'lazy',
				onerror: (e) => { e.target.replaceWith(this._swatch(item)); },
			})
			: this._swatch(item);

		const lockedReason = isEvent
			? 'Event exclusive, granted to everyone in the world while the event was live'
			: 'Locked · buy in the shop to unlock';

		const card = el('button', {
			class: 'cw-card'
				+ (isOwned ? '' : ' cw-locked')
				+ (isEquipped ? ' cw-equipped' : '')
				+ (isPending ? ' cw-pending' : '')
				+ (isNew ? ' cw-new' : ''),
			type: 'button',
			'data-id': item.id,
			'data-tier': item.tier,
			'aria-pressed': isOwned ? (isEquipped ? 'true' : 'false') : undefined,
			'aria-label': isOwned
				? `${isEquipped ? 'Unequip' : 'Equip'} ${item.name}${isNew ? ', just unlocked' : ''}`
				: `${item.name}: ${isEvent ? 'event exclusive, not for sale' : 'locked, open shop to buy'}`,
			title: isOwned
				? (isEquipped ? `Equipped · click to unequip` : `Click to equip ${item.name}`)
				: lockedReason,
			onclick: () => this._onCardClick(item, isOwned, isEquipped),
		}, [
			el('div', { class: 'cw-thumb' }, [
				thumb,
				isEquipped
					? el('span', { class: 'cw-check', 'aria-hidden': 'true' },
						[el('svg', { viewBox: '0 0 16 16', width: '12', height: '12', fill: 'none', stroke: 'currentColor', 'stroke-width': '2.2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
							[el('polyline', { points: '2 8 6 12 14 4' })])])
					: (isOwned ? null : el('span', { class: 'cw-lock', 'aria-hidden': 'true', text: isEvent ? '🏅' : '🔒' })),
				item.rarity !== 'common'
					? el('span', { class: 'cw-rarity', 'data-rarity': item.rarity, text: RARITY_LABEL[item.rarity] })
					: null,
			]),
			el('div', { class: 'cw-meta' }, [
				el('span', { class: 'cw-name', text: isNone ? 'None' : item.name }),
				isEvent
					? el('span', { class: 'cw-price cw-price-event', text: isOwned ? 'Event souvenir' : 'Not for sale' })
					: (!isOwned && item.price
						? el('span', { class: 'cw-price', text: `${item.price} $THREE` })
						: null),
				isEquipped
					? el('span', { class: 'cw-tag cw-tag-on', text: 'Equipped' })
					: (isPending
						? el('span', { class: 'cw-tag cw-tag-pending', text: '…' })
						: (isNew ? el('span', { class: 'cw-tag cw-tag-new', text: 'New' }) : null)),
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
			// A locked event souvenir has no purchase path, so sending this player to
			// the shop would be a dead end, so the card is simply inert and its
			// title/aria copy already explains that it had to be earned live.
			if (item.tier === 'event') return;
			// Locked item — shortcut to the shop so the player can buy it.
			try { this.h.onShop?.(); } catch { /* ignore */ }
			return;
		}
		// Looking at it counts as seeing it: clear the "new" highlight on the item
		// the souvenir drop flagged, so it doesn't keep shouting after the visit.
		if (this._newId === item.id) this._newId = null;
		// Equip the item, or unequip by equipping the slot's `none` default.
		const targetId = isEquipped ? DEFAULT_LOADOUT[item.slot] : item.id;
		if (this._pending === targetId) return; // already in flight
		this._pending = targetId;
		this._rejectNote = ''; // a fresh attempt clears the previous refusal
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
.cw-reject {
	margin: 0 0 12px; padding: 9px 12px;
	border: 1px solid rgba(224, 108, 117, 0.4);
	border-radius: 8px;
	background: rgba(224, 108, 117, 0.1);
	color: #e8a0a6; font-size: 12px; line-height: 1.45;
}
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
.cw-tag-new { color: #060607; background: #fff; }

/* Event souvenirs: earned, never sold. A locked one is inert: no hover lift, no
   pointer, nothing implying a purchase would unlock it. */
.cw-price-event { font-style: normal; letter-spacing: 0.06em; text-transform: uppercase; font-size: 9px; }
.cw-card[data-tier="event"].cw-locked { cursor: default; }
.cw-card[data-tier="event"].cw-locked:hover { transform: none; }
/* The souvenir just granted this session: a steady ring, plus one attention
   pulse that settles rather than looping forever. */
.cw-card.cw-new { border-color: #fff; box-shadow: 0 0 16px rgba(255,255,255,.3); }
.cw-card.cw-new .cw-thumb::after {
	content: ''; position: absolute; inset: 0; pointer-events: none;
	box-shadow: inset 0 0 24px rgba(255,255,255,.32);
	animation: cw-new-pulse 1.5s ease-out 3;
}
@keyframes cw-new-pulse { 0%, 100% { opacity: 0.25; } 50% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
	.cw-card.cw-new .cw-thumb::after { animation: none; opacity: 0.5; }
}

@media (max-width: 480px) {
	.cw-cards { grid-template-columns: repeat(auto-fill, minmax(80px, 1fr)); }
}
`;
		const style = el('style', { id: 'cw-styles' });
		style.textContent = css;
		document.head.appendChild(style);
	}
}
