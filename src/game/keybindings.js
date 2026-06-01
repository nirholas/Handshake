// Central keybinding registry for the isometric MMO client (/play).
//
// Single source of truth for action -> key. Both the renderer (iso-game.js) and
// the controls UI (iso-controls.js) route through this instead of hard-coding
// key literals, so a player can rebind anything and it persists. Movement
// (WASD / arrows) stays a held-key set in the renderer; this map owns the
// discrete actions the world guide specifies (hotbar, panels, camera, system).
//
// Persistence is per account. Until Task 16 (account-keyed persistence) lands we
// key on the chosen display name — the only stable account proxy the client has
// — through localStorage. `_load`/`_save` are the single seam Task 16 swaps for a
// server-backed store without touching any caller.

// Canonical action list, in display order, grouped for the settings UI. `def` is
// the default key (already normalized: lowercase, single tokens like 'escape').
// `fixed: true` marks system keys that must not be rebound (rebinding the key
// that closes dialogs would let a player lock themselves out of the UI).
export const ACTIONS = [
	{ id: 'hotbar1', label: 'Hotbar slot 1', group: 'Hotbar', def: '1' },
	{ id: 'hotbar2', label: 'Hotbar slot 2', group: 'Hotbar', def: '2' },
	{ id: 'hotbar3', label: 'Hotbar slot 3', group: 'Hotbar', def: '3' },
	{ id: 'hotbar4', label: 'Hotbar slot 4', group: 'Hotbar', def: '4' },
	{ id: 'hotbar5', label: 'Hotbar slot 5', group: 'Hotbar', def: '5' },
	{ id: 'hotbar6', label: 'Hotbar slot 6', group: 'Hotbar', def: '6' },
	{ id: 'hotbarClear', label: 'Clear hotbar selection', group: 'Hotbar', def: '0' },
	{ id: 'inventory', label: 'Inventory', group: 'Panels', def: 'i' },
	{ id: 'map', label: 'Map', group: 'Panels', def: 'm' },
	{ id: 'build', label: 'Build', group: 'Panels', def: 'b' },
	{ id: 'chat', label: 'Chat', group: 'Panels', def: 'c' },
	{ id: 'friends', label: 'Friends', group: 'Panels', def: 'f' },
	{ id: 'skills', label: 'Skills', group: 'Panels', def: 'k' },
	{ id: 'rotateCam', label: 'Rotate camera', group: 'Camera', def: 'r' },
	{ id: 'closeModal', label: 'Close / cancel', group: 'System', def: 'escape', fixed: true },
	{ id: 'confirm', label: 'Confirm', group: 'System', def: 'enter', fixed: true },
];

const ACTION_BY_ID = new Map(ACTIONS.map((a) => [a.id, a]));
const STORE_PREFIX = 'kg-keybinds:';

// Normalize a KeyboardEvent.key into a stable token used everywhere (map keys,
// storage, lookups). Letters/digits lowercase; space and named keys spelled out.
export function normalizeKey(key) {
	if (!key) return '';
	if (key === ' ' || key === 'Spacebar') return 'space';
	return String(key).toLowerCase();
}

// Human label for a key token, for the settings UI and hints.
export function keyLabel(token) {
	if (!token) return '—';
	const named = {
		escape: 'Esc',
		enter: 'Enter',
		space: 'Space',
		tab: 'Tab',
		arrowup: '↑',
		arrowdown: '↓',
		arrowleft: '←',
		arrowright: '→',
		backspace: '⌫',
		delete: 'Del',
		' ': 'Space',
	};
	if (named[token]) return named[token];
	return token.length === 1 ? token.toUpperCase() : token.replace(/^\w/, (m) => m.toUpperCase());
}

export function defaultBindings() {
	const m = {};
	for (const a of ACTIONS) m[a.id] = a.def;
	return m;
}

export class Keybindings {
	constructor(accountKey = '') {
		this.accountKey = accountKey || '_';
		this.map = { ...defaultBindings(), ...this._load() };
		// Repair any unknown/missing ids (e.g. after an action list change) so the
		// stored map can never drift out of sync with the canonical actions.
		for (const a of ACTIONS) if (!this.map[a.id]) this.map[a.id] = a.def;
		this._listeners = new Set();
	}

	// Swap the persistence scope at runtime (called once the player picks a name).
	// Re-reads that account's saved map, falling back to defaults.
	setAccount(accountKey) {
		const next = accountKey || '_';
		if (next === this.accountKey) return;
		this.accountKey = next;
		this.map = { ...defaultBindings(), ...this._load() };
		for (const a of ACTIONS) if (!this.map[a.id]) this.map[a.id] = a.def;
		this._emit();
	}

	get(id) {
		return this.map[id];
	}

	// Which action a key currently triggers, or null. Fixed system keys win so
	// 'escape'/'enter' always resolve to their system action.
	actionFor(token) {
		const key = normalizeKey(token);
		for (const a of ACTIONS) if (a.fixed && this.map[a.id] === key) return a.id;
		for (const a of ACTIONS) if (!a.fixed && this.map[a.id] === key) return a.id;
		return null;
	}

	// Assign `token` to `id`. Returns { ok, reason?, conflicts } where conflicts is
	// the list of OTHER action ids that share this key (the caller decides whether
	// to warn or auto-clear; we keep both bound and surface the clash, matching how
	// most game settings present it). Rebinding a fixed action is refused.
	set(id, token) {
		const action = ACTION_BY_ID.get(id);
		if (!action) return { ok: false, reason: 'unknown', conflicts: [] };
		if (action.fixed) return { ok: false, reason: 'fixed', conflicts: [] };
		const key = normalizeKey(token);
		if (!key) return { ok: false, reason: 'empty', conflicts: [] };
		// Reserve the system keys — assigning Esc/Enter to a normal action would
		// shadow closing/confirming dialogs.
		if (key === this.map.closeModal || key === this.map.confirm) {
			return { ok: false, reason: 'reserved', conflicts: [] };
		}
		this.map[id] = key;
		this._save();
		this._emit();
		return { ok: true, conflicts: this.conflictsFor(id) };
	}

	conflictsFor(id) {
		const key = this.map[id];
		const out = [];
		for (const a of ACTIONS) if (a.id !== id && this.map[a.id] === key) out.push(a.id);
		return out;
	}

	// All keys bound to more than one action -> [{ key, ids }]. Drives the live
	// conflict warnings in the settings panel.
	allConflicts() {
		const byKey = new Map();
		for (const a of ACTIONS) {
			const k = this.map[a.id];
			if (!byKey.has(k)) byKey.set(k, []);
			byKey.get(k).push(a.id);
		}
		const out = [];
		for (const [key, ids] of byKey) if (ids.length > 1) out.push({ key, ids });
		return out;
	}

	reset() {
		this.map = defaultBindings();
		this._save();
		this._emit();
	}

	subscribe(fn) {
		this._listeners.add(fn);
		return () => this._listeners.delete(fn);
	}
	_emit() {
		for (const fn of this._listeners) {
			try {
				fn(this.map);
			} catch (e) {
				console.error('[keybindings] listener threw:', e);
			}
		}
	}

	// ----- persistence seam (Task 16 replaces these two) -------------------
	_storeKey() {
		return STORE_PREFIX + this.accountKey;
	}
	_load() {
		try {
			const raw = localStorage.getItem(this._storeKey());
			if (!raw) return {};
			const parsed = JSON.parse(raw);
			return parsed && typeof parsed === 'object' ? parsed : {};
		} catch {
			return {};
		}
	}
	_save() {
		try {
			localStorage.setItem(this._storeKey(), JSON.stringify(this.map));
		} catch {
			/* storage disabled — bindings stay session-only */
		}
	}
}
