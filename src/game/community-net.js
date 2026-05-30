// CommunityNet — multiplayer client for Coin Communities.
//
// Each coin is its own world: we join the shared `walk_world` room definition
// but pass `token = <mint>` so Colyseus's filterBy matches us only with players
// who entered the same coin's community. The server (WalkRoom) is authoritative
// for position, emotes, avatars, and chat relay.
//
// This is a focused sibling of walk-net.js — it adds coin identity, avatar URL,
// and chat on top of the same room, and leaves the /walk page's client
// untouched.

import { Client, getStateCallbacks } from 'colyseus.js';

const ROOM_NAME = 'walk_world';
const RECONNECT_BASE_MS = 3000;
const RECONNECT_MAX_MS = 60_000;
const MAX_RECONNECT_ATTEMPTS = 6;
const SEND_HZ = 15;
const SEND_INTERVAL_MS = 1000 / SEND_HZ;
const POSITION_EPSILON = 0.01;
const YAW_EPSILON = 0.01;

function defaultServerUrl() {
	if (typeof window !== 'undefined' && window.GAME_SERVER_URL) return window.GAME_SERVER_URL;
	// Local dev always talks to the local Colyseus server (`npm run dev:walk-all`),
	// ignoring the production <meta game-server> baked into the static page.
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

export class CommunityNet {
	/**
	 * @param {object} opts
	 * @param {string} [opts.name]   display name
	 * @param {string} [opts.avatar] GLB/VRM URL for this player's avatar
	 * @param {string} [opts.agent]  optional three.ws agent id
	 * @param {object} [opts.coin]   { mint, name, symbol, image } — '' mint = lobby
	 * @param {string} [opts.url]    server override
	 */
	constructor(opts = {}) {
		this.name = opts.name || 'guest';
		this.avatar = opts.avatar || '';
		this.agent = opts.agent || '';
		this.coin = opts.coin || { mint: '', name: '', symbol: '', image: '' };
		this.url = opts.url || defaultServerUrl();

		this.client = null;
		this.room = null;
		this.status = 'idle';
		this.error = null;
		this.sessionId = null;

		this._handlers = {
			status: new Set(),
			ready: new Set(),  // (coinMeta)
			add: new Set(),    // (player, id)
			change: new Set(), // (player, id)
			remove: new Set(), // (id)
			chat: new Set(),   // ({id, name, text, ts})
		};
		this._lastSent = null;
		this._lastSentAt = 0;
		this._reconnectTimer = null;
		this._reconnectAttempts = 0;
		this._destroyed = false;
	}

	on(event, fn) {
		const bucket = this._handlers[event];
		if (!bucket) throw new Error(`CommunityNet: unknown event "${event}"`);
		bucket.add(fn);
		return () => bucket.delete(fn);
	}
	_emit(event, ...args) {
		for (const fn of this._handlers[event]) {
			try { fn(...args); } catch (e) { console.error(`[community-net] ${event} handler threw:`, e); }
		}
	}
	_setStatus(status, error = null) {
		this.status = status; this.error = error;
		this._emit('status', { status, error });
	}

	async connect() {
		if (this._destroyed) return;
		this._setStatus('connecting');
		try {
			this.client = new Client(this.url);
			const mint = this.coin.mint || '';
			const options = {
				// filterBy('coin') isolates each coin into its own instance; the
				// coin-less lobby ('') groups all lobby players into one world.
				coin: mint,
				coinName: this.coin.name || '',
				coinSymbol: this.coin.symbol || '',
				coinImage: this.coin.image || '',
				name: this.name,
				avatar: this.avatar,
				agent: this.agent,
			};
			this.room = await this.client.joinOrCreate(ROOM_NAME, options);
			this.sessionId = this.room.sessionId;

			this.room.onMessage('chat', (msg) => this._emit('chat', msg));

			const $ = getStateCallbacks(this.room);
			$(this.room.state).players.onAdd((player, id) => {
				this._emit('add', player, id);
				$(player).onChange(() => this._emit('change', player, id));
			});
			$(this.room.state).players.onRemove((_p, id) => this._emit('remove', id));

			this.room.onLeave((code) => {
				this._setStatus('offline');
				if (!this._destroyed && code !== 1000) this._scheduleReconnect();
			});
			this.room.onError((code, message) => console.warn('[community-net] room.onError', code, message));

			this._reconnectAttempts = 0;
			this._setStatus('online');
			this._emit('ready', {
				mint: this.room.state.coin,
				name: this.room.state.coinName,
				symbol: this.room.state.coinSymbol,
				image: this.room.state.coinImage,
			});
		} catch (err) {
			console.warn('[community-net] connect failed:', err?.message ?? err);
			this._setStatus('failed', err?.message ?? String(err));
			this._scheduleReconnect();
		}
	}

	// Exponential backoff with a hard ceiling. When the game server isn't
	// reachable at all (e.g. not deployed), every attempt costs an 8s+ XHR
	// timeout — retrying forever at a fixed 3s floods the console and the
	// network tab. After MAX_RECONNECT_ATTEMPTS we stop and stay 'offline';
	// the UI can offer manual reconnect via retry().
	_scheduleReconnect() {
		if (this._reconnectTimer || this._destroyed) return;
		if (this._reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
			this._setStatus('offline', 'multiplayer unreachable — single-player only');
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

	sendMove(state) {
		if (!this.room) return;
		const now = performance.now();
		if (now - this._lastSentAt < SEND_INTERVAL_MS) return;
		if (this._lastSent) {
			const moved = Math.hypot(state.x - this._lastSent.x, state.y - this._lastSent.y, state.z - this._lastSent.z);
			const turned = Math.abs(state.yaw - this._lastSent.yaw);
			if (moved < POSITION_EPSILON && turned < YAW_EPSILON && state.motion === this._lastSent.motion) return;
		}
		this.room.send('move', { x: state.x, y: state.y, z: state.z, yaw: state.yaw, motion: state.motion });
		this._lastSent = { ...state };
		this._lastSentAt = now;
	}

	sendEmote(name) { this.room?.send('emote', { name }); }
	sendChat(text) { this.room?.send('chat', { text }); }
	rename(name) { this.name = name; this.room?.send('rename', { name }); }
	setAvatar(avatar, agent) { this.avatar = avatar; this.room?.send('avatar', { avatar, agent }); }

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
		this.room = null; this.client = null;
	}
}
