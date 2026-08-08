// Event souvenir drop: the in-world moment when a live event hands you a
// commemorative wearable.
//
// The server grants the item (multiplayer/src/event-drop.js →
// WalkRoom._grantEventSouvenir) and sends ONE `souvenir` message on the join
// where the unlock actually landed. That message is a moment, not a state sync:
// it never repeats on a reconnect, so this surface can treat every arrival as
// "you just earned this".
//
// Deliberately NOT a modal. A player mid-conversation, mid-dance-off, or lining
// up a photo does not want their input stolen for a reward they already have.
// This is a card that slides in over the corner of the HUD, states what landed,
// offers to put it on in one click, and leaves on its own. Keyboard and pointer
// both reach it; nothing traps focus; Escape dismisses.
//
// Rendering reads the shared catalog, so the card shows the item's real poster
// and name rather than re-describing it (an event that swaps its souvenir needs
// no change here).

import { getCosmetic } from '../../multiplayer/src/cosmetics-catalog.js';

// How long the card lingers before retiring itself. Long enough to read, notice
// the item, and decide; short enough that it never becomes furniture. The timer
// pauses while the pointer or keyboard focus is on the card, so it can't vanish
// mid-decision.
const LINGER_MS = 14_000;
const EXIT_MS = 260;

function el(tag, props = {}, kids = []) {
	const n = document.createElement(tag);
	for (const [k, v] of Object.entries(props)) {
		if (k === 'class') n.className = v;
		else if (k === 'text') n.textContent = v;
		else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
		else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v === true ? '' : v);
	}
	for (const kid of [].concat(kids)) {
		if (kid != null && kid !== false) n.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
	}
	return n;
}

const STYLE = `
.es-card {
	position: fixed; right: 16px; bottom: 96px; z-index: 60;
	width: min(340px, calc(100vw - 32px));
	display: flex; gap: 12px; padding: 13px;
	background: var(--cc-panel-solid, #0c0c0c);
	border: 1px solid var(--cc-edge-hi, rgba(255,255,255,.55));
	border-radius: var(--cc-radius, 4px);
	box-shadow: var(--cc-shadow, 0 16px 50px rgba(0,0,0,.7)), 0 0 22px rgba(255,255,255,.18);
	color: var(--cc-text, #f5f5f6);
	transform: translateY(14px) scale(0.98); opacity: 0;
	transition: transform ${EXIT_MS}ms cubic-bezier(0.16, 0.84, 0.34, 1), opacity ${EXIT_MS}ms ease;
}
.es-card.es-in { transform: none; opacity: 1; }

.es-thumb {
	flex: none; width: 72px; height: 72px; border-radius: 2px;
	display: grid; place-items: center; overflow: hidden;
	background:
		radial-gradient(120% 120% at 50% 20%, rgba(255,255,255,0.12), rgba(255,255,255,0) 62%),
		var(--cc-bg3, #181818);
	border: 1px solid var(--cc-edge-soft, rgba(255,255,255,.07));
}
.es-thumb img { width: 100%; height: 100%; object-fit: contain; padding: 4px; }
.es-thumb-glyph { font-size: 30px; line-height: 1; filter: grayscale(1) brightness(1.4); }

.es-copy { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.es-kicker {
	display: inline-flex; align-items: center; gap: 6px;
	font-size: 9.5px; font-weight: 800; letter-spacing: 0.16em; text-transform: uppercase;
	color: var(--cc-dim, #8c8c92);
}
.es-spark { width: 6px; height: 6px; border-radius: 50%; background: #fff; }
.es-name { font-size: 14.5px; font-weight: 800; letter-spacing: 0.01em; line-height: 1.2; }
.es-sub {
	font-size: 11.5px; line-height: 1.35; color: var(--cc-dim, #8c8c92);
	overflow: hidden; text-overflow: ellipsis;
}
.es-actions { display: flex; gap: 6px; margin-top: 7px; }
.es-btn {
	appearance: none; -webkit-appearance: none; font: inherit; cursor: pointer;
	padding: 5px 11px; border-radius: 2px;
	font-size: 11px; font-weight: 800; letter-spacing: 0.04em;
	transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease, transform 0.12s ease;
}
.es-btn:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
.es-btn-primary { background: #fff; color: #060607; border: 1px solid #fff; }
.es-btn-primary:hover { transform: translateY(-1px); }
.es-btn-primary:active { transform: none; }
.es-btn-primary[disabled] { cursor: default; opacity: 0.62; transform: none; }
.es-btn-ghost {
	background: none; color: var(--cc-dim, #8c8c92);
	border: 1px solid var(--cc-edge, rgba(255,255,255,.12));
}
.es-btn-ghost:hover { color: var(--cc-text, #f5f5f6); border-color: var(--cc-edge-hi, rgba(255,255,255,.55)); }

/* Time-remaining hairline: an honest read on when the card retires itself. */
.es-timer {
	position: absolute; left: 0; bottom: 0; height: 2px; width: 100%;
	transform-origin: left center; background: rgba(255,255,255,0.5);
	animation: es-drain linear forwards;
}
.es-card:hover .es-timer, .es-card:focus-within .es-timer { animation-play-state: paused; }
@keyframes es-drain { from { transform: scaleX(1); } to { transform: scaleX(0); } }

@media (prefers-reduced-motion: reduce) {
	.es-card { transition: opacity ${EXIT_MS}ms ease; transform: none; }
	.es-card.es-in { transform: none; }
	.es-btn-primary:hover { transform: none; }
}
@media (max-width: 560px) {
	.es-card { right: 8px; left: 8px; bottom: 80px; width: auto; }
}
`;

let _styled = false;
function injectStyles() {
	if (_styled) return;
	_styled = true;
	document.head.appendChild(el('style', { id: 'es-style', text: STYLE }));
}

export class SouvenirDrop {
	/**
	 * @param {object} h handlers:
	 *   onEquip(id)   : player wants to wear it now (scene sends equip-cosmetic)
	 *   onWardrobe()  : player wants to see it in the wardrobe instead
	 */
	constructor(h = {}) {
		this.h = h;
		this.card = null;
		this._timer = 0;
		this._onKey = (e) => { if (e.key === 'Escape' && this.card) this.dismiss(); };
	}

	/**
	 * Announce a granted souvenir.
	 * @param {object} msg the server's `souvenir` payload: { id, name, eventName }
	 */
	show(msg) {
		const id = typeof msg?.id === 'string' ? msg.id : '';
		const item = getCosmetic(id);
		// An id this build's catalog doesn't know (a server running ahead of this
		// client) is still granted and still persists, it just has no poster to
		// show, so there is no honest moment to render. Staying silent beats a
		// card describing an item we cannot name.
		if (!item) return;

		injectStyles();
		this.dismiss(true);

		const thumb = item.thumb
			? el('img', {
				src: item.thumb, alt: '', loading: 'lazy',
				onerror: (e) => e.target.replaceWith(el('span', { class: 'es-thumb-glyph', 'aria-hidden': 'true', text: '🏅' })),
			})
			: el('span', { class: 'es-thumb-glyph', 'aria-hidden': 'true', text: '🏅' });

		const eventName = String(msg?.eventName || '').slice(0, 90);

		this.equipBtn = el('button', {
			class: 'es-btn es-btn-primary', type: 'button',
			onclick: () => this._equip(item),
		}, ['Wear it']);

		this.card = el('div', {
			class: 'es-card', role: 'status', 'aria-live': 'polite',
			'aria-label': `Souvenir unlocked: ${item.name}`,
		}, [
			el('div', { class: 'es-thumb' }, [thumb]),
			el('div', { class: 'es-copy' }, [
				el('div', { class: 'es-kicker' }, [
					el('span', { class: 'es-spark', 'aria-hidden': 'true' }),
					'Souvenir unlocked',
				]),
				el('div', { class: 'es-name', text: item.name }),
				el('div', {
					class: 'es-sub',
					text: eventName ? `Yours for being at ${eventName}. Kept forever.` : 'Yours for being here. Kept forever.',
				}),
				el('div', { class: 'es-actions' }, [
					this.equipBtn,
					el('button', {
						class: 'es-btn es-btn-ghost', type: 'button',
						onclick: () => { this.dismiss(); try { this.h.onWardrobe?.(); } catch { /* panel unavailable */ } },
					}, ['My Fits']),
				]),
			]),
			el('div', { class: 'es-timer', 'aria-hidden': 'true', style: `animation-duration:${LINGER_MS}ms` }),
		]);

		document.body.appendChild(this.card);
		requestAnimationFrame(() => this.card?.classList.add('es-in'));
		document.addEventListener('keydown', this._onKey, true);
		this._arm();
	}

	// Retire on a timer, but never out from under someone who is reading or
	// tabbing through it: the CSS pauses the hairline, and these listeners pause
	// the real clock with it.
	_arm() {
		const start = () => {
			clearTimeout(this._timer);
			this._timer = setTimeout(() => this.dismiss(), LINGER_MS);
		};
		const stop = () => clearTimeout(this._timer);
		this.card.addEventListener('mouseenter', stop);
		this.card.addEventListener('mouseleave', start);
		this.card.addEventListener('focusin', stop);
		this.card.addEventListener('focusout', start);
		start();
	}

	_equip(item) {
		if (this.equipBtn) {
			this.equipBtn.disabled = true;
			this.equipBtn.textContent = 'Wearing…';
		}
		try { this.h.onEquip?.(item.id); } catch { /* net unavailable; card still retires */ }
		// Leave the confirmation up briefly so the click reads as accepted, then
		// clear the screen, the avatar itself is the real confirmation.
		clearTimeout(this._timer);
		this._timer = setTimeout(() => this.dismiss(), 900);
	}

	dismiss(immediate = false) {
		const card = this.card;
		if (!card) return;
		this.card = null;
		clearTimeout(this._timer);
		document.removeEventListener('keydown', this._onKey, true);
		if (immediate) { card.remove(); return; }
		card.classList.remove('es-in');
		setTimeout(() => card.remove(), EXIT_MS);
	}

	dispose() {
		this.dismiss(true);
	}
}
