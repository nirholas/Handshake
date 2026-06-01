// Controls layer for the isometric MMO (/game) — hotbar selection, the panel
// toggles (inventory · map · build · friends), and the rebindable Controls
// settings UI.
//
// This module is the single home for discrete keyboard input. It owns one
// capture-phase keydown listener that routes every game action through the
// central keybinding map (keybindings.js) instead of scattered key literals, so
// any action can be rebound and the binding persists per account. Movement
// (WASD / arrows) stays a held-key set inside iso-game.js; this layer never
// touches it — when a pressed key isn't a bound action it lets the event flow
// through to the renderer untouched.
//
// The visual hotbar lives in game-hud.js (#kq-hotbar), fed by the renderer's
// authoritative player sync (it already reflects the active slot). This layer
// drives that hotbar by keyboard — selection routes through game._equipOrRide so
// 1–6 ride a mount slot just like a click does, and 0 sends equip(-1) to clear.
//
// It attaches to the live IsoGame instance (window.__ISO__) and subscribes to the
// network bus directly (game.net.on('playerChange', …)) for the local player's
// inventory / active slot, which back the Inventory panel. That keeps the
// renderer (which is large and evolving) free of UI-coupling: this file is
// self-contained and self-mounting.

import { Keybindings, ACTIONS, normalizeKey, keyLabel } from './keybindings.js';
import { itemDisplay } from './items.js';
import { FriendsPanel } from './friends-panel.js';
import { friendsClient } from '../friends.js';

const HOTBAR = 6;
const INV = 24;

// Designed placeholders for panels whose owning task hasn't landed yet. The key
// is never dead: it opens this surface, and the owning task fills the body.
const PLACEHOLDERS = {};

// Tiny DOM helper (mirrors the el() convention used elsewhere in src/game).
function el(tag, attrs = {}, kids = []) {
	const n = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (v == null || v === false) continue;
		if (k === 'class') n.className = v;
		else if (k === 'text') n.textContent = v;
		else if (k === 'html') n.innerHTML = v;
		else if (k === 'dataset') Object.assign(n.dataset, v);
		else if (k.startsWith('on') && typeof v === 'function')
			n.addEventListener(k.slice(2).toLowerCase(), v);
		else if (v === true) n.setAttribute(k, '');
		else n.setAttribute(k, v);
	}
	for (const c of [].concat(kids)) {
		if (c == null || c === false) continue;
		n.append(c.nodeType ? c : document.createTextNode(String(c)));
	}
	return n;
}

export class IsoControls {
	constructor(game) {
		this.game = game;
		this.kb = new Keybindings(localStorage.getItem('cc-name') || '');

		// Local-player mirror, fed by the network bus — backs the Inventory panel.
		this._inv = Array.from({ length: INV }, () => ({ item: '', qty: 0 }));
		this._gold = 0;
		this._me = null;

		this._open = []; // stack of open surface keys (top = last)
		this._surfaces = {}; // key -> { overlay, card, body }
		this._capture = null; // { id, chip } while rebinding
		this._lastFocus = null; // restore target when a surface closes
		this._mapTimer = null;
		this._netBound = false;

		// Friends (Task 15): the shared social-graph client + the panel view bound
		// to the friends surface. The panel mounts lazily on first open; the client
		// lives for the session so the HUD unread badge stays live in the background.
		this._friends = friendsClient();
		this._friendsPanel = null;
		this._friendsBtn = null;
		this._friendsUnsub = null;

		this._onKeyDown = this._onKeyDown.bind(this);
		this._sync = this._sync.bind(this);
	}

	// -------------------------------------------------------------- mount
	mount() {
		if (this._mounted) return;
		this._mounted = true;

		this._buildGear();
		this._buildFriendsButton();

		window.addEventListener('keydown', this._onKeyDown, true);
		this._unsub = this.kb.subscribe(() => this._onBindingsChanged());

		// Keep the HUD unread badge live whether or not the panel is open. A single
		// background load seeds existing unread; live DM events keep it current.
		this._friendsUnsub = this._friends.subscribe(() => this._updateFriendsBadge());
		this._friends.refresh();

		// Poll for the network connection + phase changes. Cheap (5Hz) and only
		// needs to wire the net bus once; visibility follows game.phase.
		this._syncTimer = setInterval(this._sync, 200);
		this._sync();
	}

	_sync() {
		const game = this.game;
		if (game.net && !this._netBound) {
			this._netBound = true;
			this.kb.setAccount(localStorage.getItem('cc-name') || '');
			game.net.on('playerAdd', (p, id) => this._onPlayer(p, id));
			game.net.on('playerChange', (p, id) => this._onPlayer(p, id));
			// Friends realtime (Task 15): live DMs + request/accept events arrive on
			// whatever realm room this account is connected to; hand them to the
			// shared friends client so the panel + unread badge update instantly.
			game.net.on('social', (m) => this._friends.handleSocial(m));
		}
		// A reconnect builds a fresh GameNet; rebind against the new bus.
		if (game.net && this._boundNet && this._boundNet !== game.net) {
			this._netBound = false;
		}
		this._boundNet = game.net || this._boundNet;
		this._applyPhase(game.phase);
	}

	_applyPhase(phase) {
		const world = phase === 'world';
		if (this._gearEl) this._gearEl.hidden = !world;
		if (this._friendsBtn) this._friendsBtn.hidden = !world;
		if (world && !this._hintDone) {
			this._updateHint();
			this._hintDone = true;
		}
		if (!world && this._open.length) this._closeAll();
	}

	// -------------------------------------------------------------- network
	_onPlayer(p, id) {
		const myId = this.game.myId || this.game.net?.sessionId;
		if (!myId || id !== myId) return;
		const read = (arr, n) =>
			Array.from({ length: n }, (_, i) => ({
				item: arr?.[i]?.item || '',
				qty: arr?.[i]?.qty | 0,
			}));
		this._inv = read(p.inv, INV);
		this._gold = p.gold | 0;
		this._me = { tx: p.tx | 0, ty: p.ty | 0 };
		if (this._isOpen('inv')) this._renderInv();
	}

	// -------------------------------------------------------------- hotbar
	// Select hotbar slot `i` (0-5); pass -1 to clear. Selecting is idempotent so
	// 1–6 always *set* the active slot per the world-guide spec; 0 clears.
	//
	// Selection routes through the renderer's _equipOrRide so a number key behaves
	// exactly like clicking the slot in the game-hud hotbar — equip, and ride the
	// steed if the slot holds a mount. The visual (active-slot highlight) is owned
	// by that hotbar, fed by the server's authoritative activeSlot patch. Clearing
	// has no slot to ride, so it sends equip(-1) straight to the net; the server
	// accepts -1 and patches activeSlot back, dropping the highlight.
	_select(i) {
		const net = this.game.net;
		if (!net) return;
		if (i >= 0 && typeof this.game._equipOrRide === 'function') this.game._equipOrRide(i);
		else net.equip(i);
	}

	// -------------------------------------------------------------- gear button
	_buildGear() {
		this._gearEl = el(
			'button',
			{
				id: 'kg-controls-btn',
				class: 'kg-iconbtn',
				type: 'button',
				hidden: true,
				'aria-haspopup': 'dialog',
				'aria-controls': 'kg-ov-settings',
				'aria-label': 'Controls and settings',
				title: 'Controls',
				onclick: () => this._toggle('settings'),
			},
			'⚙',
		);
		const bar = document.getElementById('kg-topbar');
		const status = document.getElementById('kg-status');
		if (bar && status) bar.insertBefore(this._gearEl, status);
		else if (bar) bar.appendChild(this._gearEl);
		else document.body.appendChild(this._gearEl);
	}

	// -------------------------------------------------------------- friends button
	// A topbar entry point for the friends panel (Task 15), alongside the F hotkey.
	// Carries a live unread badge so a new DM is noticeable without opening it.
	_buildFriendsButton() {
		this._friendsBadge = el('span', { class: 'kg-fr-hudbadge', hidden: true, 'aria-hidden': 'true' });
		this._friendsBtn = el(
			'button',
			{
				id: 'kg-friends-btn',
				class: 'kg-iconbtn',
				type: 'button',
				hidden: true,
				'aria-haspopup': 'dialog',
				'aria-controls': 'kg-ov-friends',
				'aria-label': 'Friends',
				title: 'Friends (F)',
				onclick: () => this._toggle('friends'),
			},
			['👥', this._friendsBadge],
		);
		const bar = document.getElementById('kg-topbar');
		if (this._gearEl && this._gearEl.parentNode) this._gearEl.parentNode.insertBefore(this._friendsBtn, this._gearEl);
		else if (bar) bar.appendChild(this._friendsBtn);
		else document.body.appendChild(this._friendsBtn);
	}

	_updateFriendsBadge() {
		if (!this._friendsBadge) return;
		const n = this._friends.totalUnread;
		this._friendsBadge.textContent = n > 9 ? '9+' : String(n);
		this._friendsBadge.hidden = n <= 0;
		this._friendsBtn?.classList.toggle('kg-iconbtn--alert', n > 0);
	}

	// -------------------------------------------------------------- keyboard
	_onKeyDown(e) {
		if (this._capture) {
			e.preventDefault();
			e.stopImmediatePropagation();
			this._applyCapture(e);
			return;
		}

		const key = normalizeKey(e.key);
		const a = document.activeElement;
		const onButton = a && a.tagName === 'BUTTON' && a.closest && a.closest('.kg-ov');

		// While a controls surface is open, the modal owns the keyboard: Esc closes,
		// Enter confirms (unless a control is focused, then it activates it), Tab
		// navigates, and every other key is swallowed so the avatar can't walk or
		// switch slots beneath the dialog.
		if (this._open.length) {
			if (key === this.kb.get('closeModal')) {
				e.preventDefault();
				e.stopImmediatePropagation();
				this._closeTop();
				return;
			}
			if (key === this.kb.get('confirm')) {
				if (onButton) {
					e.stopImmediatePropagation();
					return;
				}
				e.preventDefault();
				e.stopImmediatePropagation();
				this._confirmTop();
				return;
			}
			if (key === 'tab') {
				e.stopImmediatePropagation();
				return;
			}
			if (onButton && key === 'space') {
				e.stopImmediatePropagation();
				return;
			}
			e.preventDefault();
			e.stopImmediatePropagation();
			return;
		}

		if (this._isTyping()) return; // chat / name inputs own their keys
		if (this.game.phase !== 'world') return;

		const action = this.kb.actionFor(key);
		if (!action || action === 'closeModal' || action === 'confirm') return;

		e.preventDefault();
		e.stopImmediatePropagation();
		this._dispatch(action);
	}

	_dispatch(action) {
		if (action.startsWith('hotbar') && action !== 'hotbarClear') {
			this._select(Number(action.slice(6)) - 1);
			return;
		}
		switch (action) {
			case 'hotbarClear':
				this._select(-1);
				break;
			case 'inventory':
				this._toggle('inv');
				break;
			case 'quests':
				this.game.q?.toggleQuests();
				break;
			case 'map':
				this._toggle('map');
				break;
			case 'build':
				// Delegate to the renderer's build-menu toggle (Task 07) so B opens the
				// real game-hud build panel, not a placeholder surface here.
				this.game._toggleBuildMenu?.();
				break;
			case 'friends':
				this._toggle('friends');
				break;
			case 'chat':
				this.game._openChat?.();
				break;
			case 'skills':
				this.game._toggleSkills?.();
				break;
			case 'rotateCam':
				this._rotateCamera();
				break;
			default:
				break;
		}
	}

	// Snap the follow camera 45° (matches the fixed three-quarter read). camYaw is
	// the renderer's public orbit angle, consumed every frame by _placeCamera.
	_rotateCamera() {
		this.game.camYaw = (this.game.camYaw || 0) - Math.PI / 4;
	}

	_isTyping() {
		const a = document.activeElement;
		return !!(a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable));
	}

	// -------------------------------------------------------------- surfaces
	_isOpen(key) {
		return this._open.includes(key);
	}

	_toggle(key) {
		this._isOpen(key) ? this._close(key) : this._openSurface(key);
	}

	_openSurface(key) {
		// Single-panel policy: opening one closes the others (and the skills drawer)
		// so the screen never stacks competing dialogs.
		for (const k of [...this._open]) if (k !== key) this._close(k);
		this.game._toggleSkills?.(false);

		const surf = this._ensureSurface(key);
		if (!surf) return;
		this._lastFocus = document.activeElement;
		surf.overlay.hidden = false;
		// reflow so the fade/scale transition runs
		void surf.overlay.offsetWidth;
		surf.overlay.classList.add('kg-ov--in');
		this._open.push(key);
		this._renderSurface(key);
		if (key === 'map') this._mapTimer = setInterval(() => this._renderMap(), 700);
		(surf.card.querySelector('button, [tabindex]') || surf.card).focus();
	}

	_close(key) {
		const surf = this._surfaces[key];
		if (!surf) return;
		surf.overlay.classList.remove('kg-ov--in');
		surf.overlay.hidden = true;
		this._open = this._open.filter((k) => k !== key);
		if (key === 'map' && this._mapTimer) {
			clearInterval(this._mapTimer);
			this._mapTimer = null;
		}
		if (key === 'friends' && this._friendsPanel) {
			this._friendsPanel.unmount();
			this._friendsPanel = null;
		}
		if (this._capture && key === 'settings') this._capture = null;
		const back = this._lastFocus;
		if (back && document.contains(back)) back.focus();
		else this._gearEl?.focus();
	}

	_closeTop() {
		if (this._open.length) this._close(this._open[this._open.length - 1]);
	}
	_closeAll() {
		for (const k of [...this._open]) this._close(k);
	}

	_confirmTop() {
		const key = this._open[this._open.length - 1];
		const surf = this._surfaces[key];
		surf?.card.querySelector('.kg-ov-primary')?.click();
	}

	_ensureSurface(key) {
		if (this._surfaces[key]) return this._surfaces[key];
		const titles = { inv: 'Inventory', map: 'Map', settings: 'Controls', friends: 'Friends' };
		const title = titles[key] || PLACEHOLDERS[key]?.title || key;
		const closeBtn = el(
			'button',
			{
				class: 'kg-ov-x',
				type: 'button',
				'aria-label': 'Close',
				onclick: () => this._close(key),
			},
			'✕',
		);
		const head = el('div', { class: 'kg-ov-head' }, [
			el('h2', { class: 'kg-ov-title', id: `kg-ov-title-${key}` }, title),
			closeBtn,
		]);
		const body = el('div', { class: 'kg-ov-body' });
		const card = el(
			'div',
			{
				class: 'kg-ov-card',
				role: 'dialog',
				'aria-modal': 'true',
				'aria-labelledby': `kg-ov-title-${key}`,
				tabindex: '-1',
			},
			[head, body],
		);
		const overlay = el(
			'div',
			{
				id: `kg-ov-${key}`,
				class: 'kg-ov',
				hidden: true,
				onclick: (e) => {
					if (e.target === overlay) this._close(key);
				},
			},
			[card],
		);
		document.body.appendChild(overlay);
		this._surfaces[key] = { overlay, card, body };
		return this._surfaces[key];
	}

	_renderSurface(key) {
		if (key === 'inv') this._renderInv();
		else if (key === 'map') this._renderMap();
		else if (key === 'settings') this._renderControls();
		else if (key === 'friends') this._mountFriends();
		else this._renderPlaceholder(key);
	}

	// -------------------------------------------------------------- inventory
	_renderInv() {
		const body = this._surfaces.inv?.body;
		if (!body) return;
		body.innerHTML = '';
		body.append(
			el('div', { class: 'kg-inv-meta' }, [
				el('span', {}, [el('b', {}, String(this._gold)), ' gold']),
				el('span', { class: 'kg-inv-hint' }, 'Slots 1–6 are your hotbar.'),
			]),
		);
		const grid = el('div', { class: 'kg-inv-grid' });
		const filled = this._inv.some((s) => s.item);
		for (let i = 0; i < INV; i++) {
			const cell = this._inv[i] || { item: '', qty: 0 };
			const disp = itemDisplay(cell.item);
			const node = el(
				'div',
				{
					class:
						'kg-inv-cell' +
						(i < HOTBAR ? ' kg-inv-cell--hb' : '') +
						(cell.item ? '' : ' kg-inv-cell--empty'),
					title: disp ? disp.name : '',
					'aria-label': disp
						? `${disp.name}${cell.qty > 1 ? ` ×${cell.qty}` : ''}`
						: 'Empty slot',
				},
				[
					el(
						'span',
						{ class: 'kg-inv-glyph', 'aria-hidden': 'true' },
						disp ? disp.glyph : '',
					),
					cell.qty > 1 ? el('span', { class: 'kg-inv-qty' }, String(cell.qty)) : null,
				],
			);
			grid.append(node);
		}
		body.append(grid);
		if (!filled) {
			body.append(
				el(
					'p',
					{ class: 'kg-ov-empty' },
					'Your backpack is empty. Gather wood and stone, or defeat mobs to fill it.',
				),
			);
		}
	}

	// -------------------------------------------------------------- map
	_renderMap() {
		let surf = this._surfaces.map;
		if (!surf) return;
		if (!surf._canvas) {
			const cv = el('canvas', {
				class: 'kg-map-canvas',
				width: '260',
				height: '260',
				role: 'img',
				'aria-label': 'Realm map',
			});
			const legend = el('div', { class: 'kg-map-legend' }, [
				el('span', {}, [el('i', { class: 'kg-map-dot kg-map-dot--me' }), 'You']),
				el('span', {}, [el('i', { class: 'kg-map-dot kg-map-dot--peer' }), 'Players']),
				el('span', {}, [el('i', { class: 'kg-map-sw kg-map-sw--bank' }), 'Bank']),
				el('span', {}, [el('i', { class: 'kg-map-sw kg-map-sw--block' }), 'Blocked']),
			]);
			surf.body.append(cv, legend);
			surf._canvas = cv;
		}
		const cv = surf._canvas;
		const realm = this.game.realm;
		const ctx = cv.getContext('2d');
		const SZ = cv.width;
		ctx.clearRect(0, 0, SZ, SZ);
		if (!realm) {
			ctx.fillStyle = '#95a1b6';
			ctx.font = '13px system-ui';
			ctx.textAlign = 'center';
			ctx.fillText('Map loads when you enter the world.', SZ / 2, SZ / 2);
			return;
		}
		const grid = realm.grid || 48;
		const s = SZ / grid;
		ctx.fillStyle = '#33492b';
		ctx.fillRect(0, 0, SZ, SZ);
		ctx.fillStyle = 'rgba(8,11,16,0.55)';
		for (const b of realm.blocked || [])
			ctx.fillRect(b.x0 * s, b.y0 * s, (b.x1 - b.x0 + 1) * s, (b.y1 - b.y0 + 1) * s);
		ctx.fillStyle = 'rgba(255,206,92,0.6)';
		for (const t of realm.bankZone || []) ctx.fillRect(t.tx * s, t.ty * s, s, s);
		if (realm.fountain) {
			ctx.fillStyle = '#3aa0d0';
			ctx.beginPath();
			ctx.arc(
				(realm.fountain.tx + 0.5) * s,
				(realm.fountain.ty + 0.5) * s,
				Math.max(2.5, s * 0.7),
				0,
				Math.PI * 2,
			);
			ctx.fill();
		}
		for (const [, pv] of this.game.players || []) {
			if (pv.dead) continue;
			const me = pv.isLocal;
			ctx.fillStyle = me ? '#ffffff' : '#8fd3ff';
			const r = Math.max(me ? 2.6 : 1.9, s * (me ? 0.75 : 0.55));
			ctx.beginPath();
			ctx.arc((pv.tx + 0.5) * s, (pv.ty + 0.5) * s, r, 0, Math.PI * 2);
			ctx.fill();
			if (me) {
				ctx.strokeStyle = '#0d1420';
				ctx.lineWidth = 1.5;
				ctx.stroke();
			}
		}
	}

	// -------------------------------------------------------------- friends
	// Lazily mount the friends panel into its surface body on first open; reuse it
	// thereafter. The panel owns its own polling/realtime lifecycle via mount()/
	// unmount() (the latter fires from _close).
	_mountFriends() {
		const body = this._surfaces.friends?.body;
		if (!body) return;
		if (!this._friendsPanel) {
			body.innerHTML = '';
			this._friendsPanel = new FriendsPanel(body);
		}
		this._friendsPanel.mount();
	}

	// -------------------------------------------------------------- placeholder
	_renderPlaceholder(key) {
		const meta = PLACEHOLDERS[key];
		const body = this._surfaces[key]?.body;
		if (!meta || !body) return;
		body.innerHTML = '';
		body.append(
			el('div', { class: 'kg-ph' }, [
				el('div', { class: 'kg-ph-glyph', 'aria-hidden': 'true' }, meta.glyph),
				el('p', { class: 'kg-ph-blurb' }, meta.blurb),
				el('p', { class: 'kg-ph-note' }, meta.note),
			]),
		);
		body.append(
			el('div', { class: 'kg-ov-foot' }, [
				el(
					'button',
					{
						class: 'kg-ov-btn kg-ov-primary',
						type: 'button',
						onclick: () => this._close(key),
					},
					'Got it',
				),
			]),
		);
	}

	// -------------------------------------------------------------- controls UI
	_renderControls() {
		const body = this._surfaces.settings?.body;
		if (!body) return;
		body.innerHTML = '';
		body.append(
			el(
				'p',
				{ class: 'kg-ov-sub' },
				'Click a key to rebind it, then press the new key. Esc cancels. Esc and Enter are reserved.',
			),
		);

		const conflicts = new Map();
		for (const { key, ids } of this.kb.allConflicts()) conflicts.set(key, ids);

		const groups = [];
		for (const a of ACTIONS) {
			let g = groups.find((x) => x.name === a.group);
			if (!g) {
				g = { name: a.group, items: [] };
				groups.push(g);
			}
			g.items.push(a);
		}

		for (const g of groups) {
			const rows = [];
			for (const action of g.items) {
				const cur = this.kb.get(action.id);
				const sharedIds = (conflicts.get(cur) || []).filter((id) => id !== action.id);
				const chip = action.fixed
					? el(
							'span',
							{
								class: 'kg-bind-chip kg-bind-chip--fixed',
								title: 'System key (cannot be rebound)',
							},
							keyLabel(cur),
						)
					: el(
							'button',
							{
								class: 'kg-bind-chip',
								type: 'button',
								dataset: { action: action.id },
								'aria-label': `Rebind ${action.label}, currently ${keyLabel(cur)}`,
								onclick: (e) => this._beginCapture(action.id, e.currentTarget),
							},
							keyLabel(cur),
						);
				const row = el(
					'div',
					{ class: 'kg-bind-row' + (sharedIds.length ? ' kg-bind-row--conflict' : '') },
					[el('span', { class: 'kg-bind-label' }, action.label), chip],
				);
				if (sharedIds.length) {
					const names = sharedIds
						.map((id) => ACTIONS.find((x) => x.id === id)?.label || id)
						.join(', ');
					row.append(
						el(
							'span',
							{ class: 'kg-bind-warn', role: 'note' },
							`⚠ shared with ${names}`,
						),
					);
				}
				rows.push(row);
			}
			body.append(
				el('section', { class: 'kg-bind-group' }, [
					el('h3', { class: 'kg-bind-h' }, g.name),
					...rows,
				]),
			);
		}

		this._msgEl = el(
			'p',
			{ class: 'kg-bind-msg', role: 'status', 'aria-live': 'polite' },
			this._pendingMsg || '',
		);
		this._pendingMsg = '';
		body.append(this._msgEl);
		body.append(
			el('div', { class: 'kg-ov-foot' }, [
				el(
					'button',
					{
						class: 'kg-ov-btn kg-ov-ghost',
						type: 'button',
						onclick: () => this._resetBindings(),
					},
					'Reset to defaults',
				),
				el(
					'button',
					{
						class: 'kg-ov-btn kg-ov-primary',
						type: 'button',
						onclick: () => this._close('settings'),
					},
					'Done',
				),
			]),
		);
	}

	_beginCapture(id, chip) {
		this._capture = { id, chip };
		chip.classList.add('kg-bind-chip--capturing');
		chip.textContent = 'Press a key…';
		this._setMsg(`Press a key for “${ACTIONS.find((a) => a.id === id)?.label}”. Esc cancels.`);
	}

	_applyCapture(e) {
		const { id } = this._capture;
		const key = normalizeKey(e.key);
		this._capture = null;
		if (key === 'escape' || key === 'tab') {
			this._setMsg('Rebind cancelled.');
			this._renderControls();
			this._focusChip(id);
			return;
		}
		const res = this.kb.set(id, key);
		if (!res.ok) {
			const reasons = {
				fixed: 'That action can’t be rebound.',
				reserved: 'Esc and Enter are reserved.',
				empty: 'Unrecognized key.',
				unknown: 'Unknown action.',
			};
			this._setMsg(reasons[res.reason] || 'Could not bind that key.');
		} else if (res.conflicts.length) {
			const names = res.conflicts
				.map((c) => ACTIONS.find((a) => a.id === c)?.label || c)
				.join(', ');
			this._setMsg(`Bound to ${keyLabel(key)} — also used by ${names}.`);
		} else {
			this._setMsg(`Bound to ${keyLabel(key)}.`);
		}
		this._renderControls();
		this._focusChip(id);
	}

	_focusChip(id) {
		this._surfaces.settings?.body.querySelector(`.kg-bind-chip[data-action="${id}"]`)?.focus();
	}

	_setMsg(text) {
		this._pendingMsg = text;
		if (this._msgEl) this._msgEl.textContent = text;
	}

	_resetBindings() {
		this.kb.reset();
		this._setMsg('Restored default controls.');
		this._renderControls();
	}

	_onBindingsChanged() {
		this._updateHint();
		if (this._isOpen('settings')) {
			const msg = this._pendingMsg;
			this._renderControls();
			if (msg) this._setMsg(msg);
		}
	}

	_updateHint() {
		const hint = document.getElementById('kg-hint');
		if (!hint) return;
		const kl = (id) => keyLabel(this.kb.get(id));
		hint.innerHTML =
			`<kbd>WASD</kbd> move · <kbd>${kl('hotbar1')}</kbd>–<kbd>${kl('hotbar6')}</kbd> hotbar · ` +
			`<kbd>${kl('inventory')}</kbd> bag · <kbd>${kl('quests')}</kbd> quests · ` +
			`<kbd>${kl('map')}</kbd> map · <kbd>${kl('build')}</kbd> build · ` +
			`<kbd>${kl('skills')}</kbd> skills · <kbd>${kl('chat')}</kbd> chat · <kbd>⚙</kbd> controls`;
	}

	// -------------------------------------------------------------- teardown
	destroy() {
		window.removeEventListener('keydown', this._onKeyDown, true);
		clearInterval(this._syncTimer);
		if (this._mapTimer) clearInterval(this._mapTimer);
		this._unsub?.();
		this._friendsUnsub?.();
		this._friendsPanel?.unmount();
		this._friendsPanel = null;
		this._gearEl?.remove();
		this._friendsBtn?.remove();
		for (const k of Object.keys(this._surfaces)) this._surfaces[k].overlay.remove();
		this._surfaces = {};
		this._mounted = false;
	}
}

// Self-mount onto the live game instance. iso-game.js creates window.__ISO__ at
// module load; we poll briefly to cover either load order, then attach once.
function boot() {
	const attach = () => {
		const game = window.__ISO__;
		if (!game) return false;
		if (game.__controls) return true;
		game.__controls = new IsoControls(game);
		game.__controls.mount();
		return true;
	};
	if (attach()) return;
	const t = setInterval(() => {
		if (attach()) clearInterval(t);
	}, 120);
	setTimeout(() => clearInterval(t), 30000);
}

if (typeof window !== 'undefined') boot();
