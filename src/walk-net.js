// Multiplayer client for /walk — wraps colyseus.js with a tiny event API
// that walk.js can subscribe to without knowing anything about Colyseus.
//
// Design goals:
//   - Graceful single-player fallback. If the server is unreachable, the
//     page still works; we surface the state via onStatus so the HUD can
//     show "offline".
//   - Bounded send rate. The render loop runs at 60+ Hz; we throttle to
//     15Hz outbound, matching the room's patch rate. Anything faster just
//     wastes bandwidth.
//   - No reconnection storms. On disconnect we attempt one reconnect with
//     jittered backoff, then give up until the user clicks the HUD pill
//     (handled in walk.js).

import { Client, getStateCallbacks } from 'colyseus.js';

const ROOM_NAME = 'walk_world';
const SEND_HZ = 15;
const SEND_INTERVAL_MS = 1000 / SEND_HZ;
const POSITION_EPSILON = 0.005; // m — skip send if nothing meaningful changed
const YAW_EPSILON = 0.01;       // rad

function defaultServerUrl() {
	// Resolution priority:
	//   1. window.WALK_SERVER_URL  (test override)
	//   2. <meta name="walk-server" content="...">
	//   3. Same host on :2567 (dev convenience)
	if (typeof window !== 'undefined' && window.WALK_SERVER_URL) {
		return window.WALK_SERVER_URL;
	}
	if (typeof document !== 'undefined') {
		const meta = document.querySelector('meta[name="walk-server"]');
		const v = meta?.getAttribute('content')?.trim();
		if (v) return v;
	}
	if (typeof location !== 'undefined') {
		const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
		return `${proto}//${location.hostname}:2567`;
	}
	return 'ws://localhost:2567';
}

export class WalkNet {
	/**
	 * @param {object} opts
	 * @param {string} [opts.name] Display name (1–24 chars after server clean)
	 * @param {string} [opts.url] Override server URL (otherwise resolved from meta)
	 */
	constructor(opts = {}) {
		this.name = opts.name || 'guest';
		this.url = opts.url || defaultServerUrl();
		this.client = null;
		this.room = null;
		this.status = 'idle'; // 'idle' | 'connecting' | 'online' | 'offline' | 'failed'
		this.error = null;
		this.mySessionId = null;
		this._handlers = {
			status: new Set(),
			add: new Set(),     // (player, sessionId)
			remove: new Set(),  // (sessionId)
			change: new Set(),  // (player, sessionId)
		};
		this._lastSent = null; // { x, y, z, yaw, motion } we last broadcast
		this._lastSentAt = 0;
		this._reconnectTimer = null;
		this._destroyed = false;
	}

	on(event, fn) {
		const bucket = this._handlers[event];
		if (!bucket) throw new Error(`WalkNet: unknown event "${event}"`);
		bucket.add(fn);
		return () => bucket.delete(fn);
	}

	_emit(event, ...args) {
		for (const fn of this._handlers[event]) {
			try { fn(...args); } catch (e) { console.error(`[walk-net] ${event} handler threw:`, e); }
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
			this.room = await this.client.joinOrCreate(ROOM_NAME, { name: this.name });
			this.mySessionId = this.room.sessionId;

			// Colyseus 0.16 moved schema callbacks behind getStateCallbacks(room)
			// — the legacy `state.players.onAdd(fn)` form no longer exists.
			const $ = getStateCallbacks(this.room);
			$(this.room.state).players.onAdd((player, sessionId) => {
				this._emit('add', player, sessionId);
				// Per-instance onChange fires on every field delta.
				$(player).onChange(() => this._emit('change', player, sessionId));
			});
			$(this.room.state).players.onRemove((_player, sessionId) => {
				this._emit('remove', sessionId);
			});

			this.room.onLeave((code) => {
				this._setStatus('offline');
				if (!this._destroyed && code !== 1000) this._scheduleReconnect();
			});
			this.room.onError((code, message) => {
				console.warn('[walk-net] room.onError', code, message);
			});

			this._setStatus('online');
		} catch (err) {
			console.warn('[walk-net] connect failed:', err?.message ?? err);
			this._setStatus('failed', err?.message ?? String(err));
			// Single retry after ~3s — most failures here are "server not
			// running yet" during local dev. After that we go offline until
			// the user clicks the HUD pill (handled by walk.js).
			this._scheduleReconnect();
		}
	}

	_scheduleReconnect() {
		if (this._reconnectTimer || this._destroyed) return;
		const delay = 3000 + Math.random() * 1500;
		this._reconnectTimer = setTimeout(() => {
			this._reconnectTimer = null;
			if (this._destroyed) return;
			this.connect();
		}, delay);
	}

	/**
	 * Send our local state to the server. Throttled to SEND_HZ — call this
	 * every frame and it'll do the right thing.
	 *
	 * @param {{ x:number, y:number, z:number, yaw:number, motion:string }} state
	 */
	sendState(state) {
		if (!this.room) return;
		const now = performance.now();
		if (now - this._lastSentAt < SEND_INTERVAL_MS) return;

		// Skip if nothing meaningful changed since the last send.
		if (this._lastSent) {
			const dx = state.x - this._lastSent.x;
			const dy = state.y - this._lastSent.y;
			const dz = state.z - this._lastSent.z;
			const dyaw = state.yaw - this._lastSent.yaw;
			const positionStill = Math.hypot(dx, dy, dz) < POSITION_EPSILON;
			const yawStill = Math.abs(dyaw) < YAW_EPSILON;
			const motionSame = state.motion === this._lastSent.motion;
			if (positionStill && yawStill && motionSame) return;
		}

		this.room.send('move', {
			x: state.x,
			y: state.y,
			z: state.z,
			yaw: state.yaw,
			motion: state.motion,
		});
		this._lastSent = { ...state };
		this._lastSentAt = now;
	}

	rename(name) {
		this.name = name;
		this.room?.send('rename', { name });
	}

	/** Force a reconnect (e.g. after the user clicks the offline pill). */
	retry() {
		if (this._reconnectTimer) {
			clearTimeout(this._reconnectTimer);
			this._reconnectTimer = null;
		}
		this.connect();
	}

	destroy() {
		this._destroyed = true;
		if (this._reconnectTimer) {
			clearTimeout(this._reconnectTimer);
			this._reconnectTimer = null;
		}
		try { this.room?.leave(); } catch {}
		this.room = null;
		this.client = null;
	}
}
