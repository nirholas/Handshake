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
	 * @param {string} [opts.tier]   '' (open General world) | 'holders' (gated)
	 * @param {string} [opts.holderPass] signed pass required to join a holder world
	 * @param {number} [opts.holderMinUsd] USD floor the holder world gated on (HUD)
	 * @param {string} [opts.url]    server override
	 */
	constructor(opts = {}) {
		this.name = opts.name || 'guest';
		this.avatar = opts.avatar || '';
		this.agent = opts.agent || '';
		this.coin = opts.coin || { mint: '', name: '', symbol: '', image: '' };
		this.tier = opts.tier === 'holders' ? 'holders' : '';
		this.holderPass = opts.holderPass || '';
		this.holderMinUsd = Number(opts.holderMinUsd) || 0;
		this.url = opts.url || defaultServerUrl();

		this.client = null;
		this.room = null;
		this.status = 'idle';
		this.error = null;
		this.sessionId = null;
		this.persistent = false; // set true once the server says this world is Redis-backed

		this._handlers = {
			status: new Set(),
			ready: new Set(),  // (coinMeta)
			add: new Set(),    // (player, id)
			change: new Set(), // (player, id)
			remove: new Set(), // (id)
			chat: new Set(),   // ({id, name, text, ts})
			interact: new Set(), // ({from, fromName, action, ts}) — a peer interacted with us
			denied: new Set(),  // (reason) — server refused the join (e.g. holder gate); no retry
			voiceSignal: new Set(), // ({from, data}) — relayed WebRTC SDP/ICE from a peer
			ping: new Set(),   // (ms) — smoothed round-trip latency to the server
			blockAdd: new Set(),    // (key, type) — a voxel appeared (placed or restored)
			blockChange: new Set(), // (key, type) — a voxel was repainted
			blockRemove: new Set(), // (key) — a voxel was broken
			editReject: new Set(),  // ({reason}) — the server refused one of our edits
			persistent: new Set(),  // (bool) — whether this world's build is durably saved
		};
		this.ping = null;        // smoothed RTT in ms, null until the first echo
		this._pingSentAt = 0;    // perf-clock stamp of the last move awaiting an echo
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

	// Detach and close the current room without triggering a reconnect. Every
	// (re)connect replaces this.room; if the previous room were left live its
	// socket would keep firing onMessage('chat') alongside the new one, so a
	// single broadcast got appended once per leftover connection — the duplicate
	// chat bug. State-based events (move/avatar/blocks) hid it by being
	// idempotent; chat appends a row on every delivery, so it showed.
	_closeRoom() {
		const room = this.room;
		if (!room) return;
		this.room = null;
		// Drop onLeave/onError/onMessage first so leaving doesn't schedule a
		// reconnect or surface a spurious error.
		try { room.removeAllListeners(); } catch {}
		try { room.leave(); } catch {}
	}

	async connect() {
		if (this._destroyed) return;
		this._closeRoom();
		this._setStatus('connecting');
		try {
			this.client = new Client(this.url);
			const mint = this.coin.mint || '';
			const options = {
				// filterBy('coin','tier') isolates each coin into its own instance and
				// splits the open General world from the gated Holders world; the
				// coin-less lobby ('') groups all lobby players into one world.
				coin: mint,
				tier: this.tier,
				coinName: this.coin.name || '',
				coinSymbol: this.coin.symbol || '',
				coinImage: this.coin.image || '',
				name: this.name,
				avatar: this.avatar,
				agent: this.agent,
			};
			// Holder worlds require a signed pass the server verifies in onAuth; carry
			// it (and the floor it gated on, for the seed room's HUD) only for holders.
			if (this.tier === 'holders') {
				options.holderPass = this.holderPass;
				options.holderMinUsd = this.holderMinUsd;
			}
			this.room = await this.client.joinOrCreate(ROOM_NAME, options);
			this.sessionId = this.room.sessionId;

			this.room.onMessage('chat', (msg) => this._emit('chat', msg));
			this.room.onMessage('interact', (msg) => this._emit('interact', msg));
			this.room.onMessage('voice-signal', (msg) => this._emit('voiceSignal', msg));
			// The server replies here when it refuses one of our place/break edits
			// (budget full, rate limited, …) so the HUD can explain the no-op.
			this.room.onMessage('edit-reject', (msg) => this._emit('editReject', msg || {}));

			const $ = getStateCallbacks(this.room);
			$(this.room.state).players.onAdd((player, id) => {
				this._emit('add', player, id);
				$(player).onChange(() => {
					// The server echoes our own authoritative state back after each
					// move; the gap from send → echo is a real network+server RTT.
					if (id === this.sessionId && this._pingSentAt) {
						const rtt = performance.now() - this._pingSentAt;
						this._pingSentAt = 0;
						if (rtt > 0 && rtt < 5000) {
							this.ping = this.ping == null ? rtt : this.ping * 0.7 + rtt * 0.3;
							this._emit('ping', Math.round(this.ping));
						}
					}
					this._emit('change', player, id);
				});
			});
			$(this.room.state).players.onRemove((_p, id) => this._emit('remove', id));

			// Voxel builds: the server is authoritative for every block, so the
			// world's geometry is driven entirely by these state callbacks — local
			// place/break clicks only *send*; the block appears when the server
			// echoes it back, keeping every client's build identical. onAdd fires
			// for the full persisted build at join time and for each new placement.
			$(this.room.state).blocks.onAdd((block, key) => {
				this._emit('blockAdd', key, block.t);
				$(block).onChange(() => this._emit('blockChange', key, block.t));
			});
			$(this.room.state).blocks.onRemove((_b, key) => this._emit('blockRemove', key));

			// Durability flag for this world's build (Redis-backed vs memory-only).
			// Set once at room creation; listen so the HUD reflects it as soon as the
			// first state patch lands and if it ever degrades mid-session.
			this.persistent = !!this.room.state.persistent;
			$(this.room.state).listen('persistent', (v) => { this.persistent = !!v; this._emit('persistent', !!v); });

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
			const msg = err?.message ?? String(err);
			// A holder-gate refusal (onAuth threw) is terminal, not a flaky link —
			// retrying with the same expired/invalid pass just loops. Surface it so
			// the scene can route the player back to the gate, and stop here.
			if (/holder_pass/i.test(msg)) {
				console.warn('[community-net] holder gate denied join:', msg);
				this._setStatus('denied', msg);
				this._emit('denied', msg);
				return;
			}
			console.warn('[community-net] connect failed:', msg);
			this._setStatus('failed', msg);
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
		// Stamp this move for RTT measurement unless one is already awaiting its
		// echo, so each sample pairs a single send with its first state echo.
		if (!this._pingSentAt) this._pingSentAt = now;
	}

	sendEmote(name) { this.room?.send('emote', { name }); }
	sendChat(text) { this.room?.send('chat', { text }); }
	// Place/break a voxel at an integer grid cell. Server-authoritative: these only
	// request the edit; the block is added/removed locally when the server patches
	// state.blocks (see the onAdd/onRemove wiring above).
	sendPlace(x, y, z, t) { this.room?.send('place', { x, y, z, t }); }
	sendRemove(x, y, z) { this.room?.send('remove', { x, y, z }); }
	sendInteract(to, action) { this.room?.send('interact', { to, action }); }
	// Spatial voice: relay a WebRTC offer/answer/ICE candidate to one peer, and
	// flag ourselves in/out of voice so peers know whether to connect to us.
	sendVoiceSignal(to, data) { this.room?.send('voice-signal', { to, data }); }
	setVoiceActive(on) { this.room?.send('voice-state', { on: !!on }); }
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
		this._closeRoom();
		this.client = null;
	}
}
