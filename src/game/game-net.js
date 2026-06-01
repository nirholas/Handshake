// Multiplayer client for /play (Coin Communities) — wraps colyseus.js with a small
// event API the game scene subscribes to without knowing anything about
// Colyseus. Mirrors the design of walk-net.js: graceful offline fallback,
// bounded reconnect, and a flat event surface.
//
// Unlike walk (free 3D position at 15Hz), the game is tile-stepped: the client
// sends one 'step' per tile as the avatar paths, plus discrete intents
// (gather, attack, inventory ops, banking). The server is authoritative for
// all of it.

import { Client, getStateCallbacks } from 'colyseus.js';

const REALMS = ['mainland', 'wilderness', 'whisperwood', 'pond'];
const DEFAULT_REALM = 'mainland';
const RECONNECT_BASE_MS = 3000;
const RECONNECT_MAX_MS = 60_000;
const MAX_RECONNECT_ATTEMPTS = 6;

function defaultServerUrl() {
	// Resolution priority mirrors community-net / walk-net:
	//   1. window.GAME_SERVER_URL  (test override)
	//   2. local dev → ws://<host>:2567, ignoring the production <meta> baked
	//      into the static page (so `npm run dev:walk-all` works out of the box)
	//   3. <meta name="game-server"> then <meta name="walk-server"> (prod host)
	//   4. Same host on :2567
	if (typeof window !== 'undefined' && window.GAME_SERVER_URL) return window.GAME_SERVER_URL;
	const host = typeof location !== 'undefined' ? location.hostname : '';
	if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0') {
		return `ws://${host}:2567`;
	}
	if (typeof document !== 'undefined') {
		for (const sel of ['meta[name="game-server"]', 'meta[name="walk-server"]']) {
			const v = document.querySelector(sel)?.getAttribute('content')?.trim();
			if (v) return v;
		}
	}
	if (typeof location !== 'undefined') {
		const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
		return `${proto}//${location.hostname}:2567`;
	}
	return 'ws://localhost:2567';
}

export class GameNet {
	constructor(opts = {}) {
		this.name = opts.name || 'guest';
		this.avatar = opts.avatar || ''; // loadable GLB/VRM URL or path; '' = default
		this.pid = opts.pid || ''; // stable account id (wallet / persistent guest) — keys persistence
		// One Colyseus room definition per realm (game_mainland, game_wilderness,
		// …). Each realm is its own instance, so players in different realms never
		// see or affect one another. Defaults to Mainland.
		this.realm = REALMS.includes(opts.realm) ? opts.realm : DEFAULT_REALM;
		this.roomName = `game_${this.realm}`;
		this.url = opts.url || defaultServerUrl();
		this.client = null;
		this.room = null;
		this.status = 'idle'; // 'idle'|'connecting'|'online'|'offline'|'failed'
		this.error = null;
		this.sessionId = null;
		this._handlers = {
			status: new Set(),
			realm: new Set(), // (layout)
			items: new Set(), // (registry) — server item catalogue: icons, labels, mount tuning
			notice: new Set(), // ({kind, text})
			chat: new Set(), // ({id, name, text, ts}) player msg | ({system, kind, text, ts}) system/command reply
			bank: new Set(), // ({slots})
			skills: new Set(), // ({cap, skills, total, average}) — requester's own XP detail
			levelup: new Set(), // ({skill, level}) — a skill the local player just raised
			died: new Set(), // ({realm, danger, respawnAt, dropped, byName}) — local death
			cooked: new Set(), // ({cooked, burned, level}) — result of a cook action at the Roast Pit
			playerAdd: new Set(), // (player, id)
			playerChange: new Set(), // (player, id)
			playerRemove: new Set(), // (id)
			nodeAdd: new Set(),
			nodeChange: new Set(),
			nodeRemove: new Set(),
			mobAdd: new Set(),
			mobChange: new Set(),
			mobRemove: new Set(),
			tombAdd: new Set(), // (tombstone, id)
			tombChange: new Set(), // (tombstone, id)
			tombRemove: new Set(), // (id)
			quests: new Set(), // ({tutorial, daily, badges, guide, npc}) — requester's own quest snapshot
		};
		this._reconnectTimer = null;
		this._reconnectAttempts = 0;
		this._destroyed = false;
	}

	on(event, fn) {
		const bucket = this._handlers[event];
		if (!bucket) throw new Error(`GameNet: unknown event "${event}"`);
		bucket.add(fn);
		return () => bucket.delete(fn);
	}

	_emit(event, ...args) {
		for (const fn of this._handlers[event]) {
			try { fn(...args); } catch (e) { console.error(`[game-net] ${event} handler threw:`, e); }
		}
	}

	_setStatus(status, error = null) {
		this.status = status;
		this.error = error;
		this._emit('status', { status, error });
	}

	async connect() {
		if (this._destroyed) return;
		this._setStatus('connecting');
		try {
			this.client = new Client(this.url);
			this.room = await this.client.joinOrCreate(this.roomName, { name: this.name, avatar: this.avatar, pid: this.pid });
			this.sessionId = this.room.sessionId;

			this.room.onMessage('realm', (layout) => this._emit('realm', layout));
			this.room.onMessage('items', (r) => this._emit('items', r));
			this.room.onMessage('notice', (n) => this._emit('notice', n));
			this.room.onMessage('chat', (m) => this._emit('chat', m));
			this.room.onMessage('bank', (b) => this._emit('bank', b));
			this.room.onMessage('skills', (s) => this._emit('skills', s));
			this.room.onMessage('levelup', (l) => this._emit('levelup', l));
			this.room.onMessage('died', (d) => this._emit('died', d));
			this.room.onMessage('cooked', (c) => this._emit('cooked', c));
			this.room.onMessage('quests', (q) => this._emit('quests', q));

			const $ = getStateCallbacks(this.room);
			const wire = (mapName, addEv, changeEv, removeEv) => {
				$(this.room.state)[mapName].onAdd((item, id) => {
					this._emit(addEv, item, id);
					$(item).onChange(() => this._emit(changeEv, item, id));
				});
				$(this.room.state)[mapName].onRemove((_item, id) => this._emit(removeEv, id));
			};
			wire('players', 'playerAdd', 'playerChange', 'playerRemove');
			wire('nodes', 'nodeAdd', 'nodeChange', 'nodeRemove');
			wire('mobs', 'mobAdd', 'mobChange', 'mobRemove');
			wire('tombstones', 'tombAdd', 'tombChange', 'tombRemove');

			this.room.onLeave((code) => {
				this._setStatus('offline');
				if (!this._destroyed && code !== 1000) this._scheduleReconnect();
			});
			this.room.onError((code, message) => console.warn('[game-net] room.onError', code, message));

			this._reconnectAttempts = 0;
			this._setStatus('online');
		} catch (err) {
			console.warn('[game-net] connect failed:', err?.message ?? err);
			this._setStatus('failed', err?.message ?? String(err));
			this._scheduleReconnect();
		}
	}

	// Exponential backoff with a hard ceiling. When the server is unreachable
	// (e.g. not deployed), each attempt costs a connection timeout — retrying
	// forever at a fixed interval floods the console. After MAX_RECONNECT_ATTEMPTS
	// we stop and stay 'offline'; the UI offers a manual reconnect via retry().
	_scheduleReconnect() {
		if (this._reconnectTimer || this._destroyed) return;
		if (this._reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
			this._setStatus('offline', 'game server unreachable');
			return;
		}
		const attempt = this._reconnectAttempts++;
		const backoff = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
		const delay = backoff + Math.random() * 1000;
		this._reconnectTimer = setTimeout(() => {
			this._reconnectTimer = null;
			if (!this._destroyed) this.connect();
		}, delay);
	}

	// ----- intents ---------------------------------------------------------

	step(tx, ty, yaw) { this.room?.send('step', { tx, ty, yaw }); }
	setAvatar(url) { this.avatar = url; this.room?.send('setAvatar', { avatar: url }); }
	chat(text) { this.room?.send('chat', { text }); }
	gather(id) { this.room?.send('gather', { id }); }
	attack(id) { this.room?.send('attack', { id }); }
	fish() { this.room?.send('fish'); }
	tombLoot(id) { this.room?.send('tombLoot', { id }); }
	cook(qty = 1) { this.room?.send('cook', { qty }); }
	consume(ref) { this.room?.send('consume', { slot: ref }); }
	invMove(from, to) { this.room?.send('invMove', { from, to }); }
	equip(slot) { this.room?.send('equip', { slot }); }
	bankOpen() { this.room?.send('bankOpen'); }
	skills() { this.room?.send('skills'); }
	bankDeposit(i, qty) { this.room?.send('bankDeposit', { i, qty }); }
	bankWithdraw(i, qty) { this.room?.send('bankWithdraw', { i, qty }); }
	// Quests: request a fresh snapshot, talk to an NPC, claim a finished daily.
	questOpen() { this.room?.send('questOpen'); }
	npcTalk(id) { this.room?.send('npcTalk', { id }); }
	questTurnIn(id) { this.room?.send('questTurnIn', { id }); }
	// Mounts (Task 09): ride the active hotbar item if it's a mount, leave the
	// saddle, and a generic slash-command channel (Task 13 chat forwards here).
	use(slot) { this.room?.send('use', slot == null ? {} : { slot }); }
	dismount() { this.room?.send('dismount'); }
	command(text) { this.room?.send('command', { text }); }

	get state() { return this.room?.state ?? null; }

	retry() {
		if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
		this._reconnectAttempts = 0;
		this.connect();
	}

	destroy() {
		this._destroyed = true;
		if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
		try { this.room?.leave(); } catch {}
		this.room = null;
		this.client = null;
	}
}
