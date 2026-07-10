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
import { log } from './shared/log.js';
import { joinRoomWithTimeout } from './shared/colyseus-connect.js';

const ROOM_NAME = 'walk_world';
const SEND_HZ = 15;
const SEND_INTERVAL_MS = 1000 / SEND_HZ;
const POSITION_EPSILON = 0.005; // m — skip send if nothing meaningful changed
const YAW_EPSILON = 0.01;       // rad

function defaultServerUrl() {
	// Resolution priority:
	//   1. window.WALK_SERVER_URL            (runtime / test override)
	//   2. <meta name="walk-server" content> (per-page production config)
	//   3. VITE_WALK_SERVER_URL              (build-time production config)
	//   4. Codespaces / Gitpod port-subdomain forwarding (-3000 → -2567)
	//   5. Same host on :2567                (DEV ONLY convenience)
	// In production with none of the above set we return '' so the caller stays
	// in graceful offline mode — the public domain does not expose :2567, so a
	// same-host fallback would only produce a doomed connect + reconnect storm.
	if (typeof window !== 'undefined' && window.WALK_SERVER_URL) {
		return window.WALK_SERVER_URL;
	}
	if (typeof document !== 'undefined') {
		const meta = document.querySelector('meta[name="walk-server"]');
		const v = meta?.getAttribute('content')?.trim();
		if (v) return v;
	}
	try {
		const envUrl = import.meta?.env?.VITE_WALK_SERVER_URL;
		if (envUrl) return String(envUrl).trim().replace(/\/$/, '');
	} catch (_) {}
	if (typeof location !== 'undefined') {
		const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const host = location.hostname;
		// Cloud dev environments expose each forwarded port as its own
		// subdomain (<name>-<port>.app.github.dev), NOT host:port. The app runs
		// on -3000; the walk server is the same name on -2567.
		const fwd = host.match(/^(.*)-(\d+)\.(app\.github\.dev|githubpreview\.dev|gitpod\.io)$/);
		if (fwd) return `${proto}//${fwd[1]}-2567.${fwd[3]}`;
		// Same-host:2567 is a dev convenience only. In production the walk server
		// is a separately-deployed Colyseus host addressed via the meta tag or
		// VITE_WALK_SERVER_URL above; never assume it lives on the public domain.
		let isProd = false;
		try { isProd = import.meta?.env?.PROD === true; } catch (_) {}
		const isLocalHost = host === 'localhost' || host === '127.0.0.1';
		if (!isProd || isLocalHost) return `${proto}//${host}:2567`;
		return '';
	}
	return '';
}

export class WalkNet {
	/**
	 * @param {object} opts
	 * @param {string} [opts.name] Display name (1–24 chars after server clean)
	 * @param {string} [opts.url] Override server URL (otherwise resolved from meta)
	 * @param {string} [opts.room] Room type to join (default 'walk_world'). The Agora
	 *   Commons joins its dedicated 'agora_world' room through the same client —
	 *   identical status model, throttle, and reconnect semantics.
	 * @param {string} [opts.avatar] Loadable GLB URL for this player's avatar / 3D agent
	 * @param {string} [opts.agent] three.ws agent id this player embodies (cross-links)
	 * @param {string} [opts.coin] Coin mint — joins that coin's community world ('' = mainland)
	 * @param {string} [opts.coinName] Coin display name (seeds room identity on create)
	 * @param {string} [opts.coinSymbol] Coin ticker
	 * @param {string} [opts.coinImage] Coin image URL
	 */
	constructor(opts = {}) {
		this.name = opts.name || 'guest';
		this.url = opts.url || defaultServerUrl();
		this.roomName = opts.room || ROOM_NAME;
		this.avatar = opts.avatar || '';
		this.agent = opts.agent || '';
		// Coin community this client is entering. `coin` (the mint) doubles as the
		// matchmaking key so everyone in the same coin lands in one room instance.
		this.coin = opts.coin || '';
		this.coinName = opts.coinName || '';
		this.coinSymbol = opts.coinSymbol || '';
		this.coinImage = opts.coinImage || '';
		// Pre-join cosmetic loadout (R23): the wire string the player last equipped,
		// so peers in this world see their fit the moment they appear. The server
		// re-validates each id against what the account owns before publishing it.
		this.cosmetics = opts.cosmetics || '';
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
			chat: new Set(),    // ({ id, name, text, ts })
			social: new Set(),  // ({ type, ... }) — friends events: live DM, request/accept (Task 15)
		};
		// Optional async presence-ticket supplier (Task 15). When provided, its
		// resolved token rides the join so this coin world publishes the player's
		// account presence to friends and can deliver DMs here live.
		this.getPresence = typeof opts.getPresence === 'function' ? opts.getPresence : null;
		// No `playPass` field here (community-net.js's join carries one) — /walk has
		// no wallet sign-in UI to mint one. Harmless today (PLAY_GATE_MINT unset by
		// default), but WalkRoom.onAuth will hard-reject every /walk join the moment
		// that gate is turned on. See the landmine note at WalkRoom.onAuth before
		// enabling PLAY_GATE_MINT/THREE_MINT in production.
		this._lastSent = null; // { x, y, z, yaw, motion } we last broadcast
		this._lastSentAt = 0;
		this._reconnectTimer = null;
		this._destroyed = false;
		this._connectGen = 0;
	}

	on(event, fn) {
		const bucket = this._handlers[event];
		if (!bucket) throw new Error(`WalkNet: unknown event "${event}"`);
		bucket.add(fn);
		return () => bucket.delete(fn);
	}

	_emit(event, ...args) {
		for (const fn of this._handlers[event]) {
			try { fn(...args); } catch (e) { log.error(`[walk-net] ${event} handler threw:`, e); }
		}
	}

	_setStatus(status, error = null) {
		this.status = status;
		this.error = error;
		this._emit('status', { status, error });
	}

	// Detach and close the current room without triggering a reconnect. Every
	// (re)connect replaces this.room; left live, the old socket would keep firing
	// onMessage('chat') alongside the new one, so a single broadcast got appended
	// once per leftover connection — the duplicate chat bug. State events
	// (move/avatar/blocks) hid it by being idempotent; chat appends a row per
	// delivery, so it showed.
	_closeRoom() {
		const room = this.room;
		if (!room) return;
		this.room = null;
		try { room.removeAllListeners(); } catch {}
		try { room.leave(); } catch {}
	}

	async connect() {
		if (this._destroyed) return;
		this._closeRoom();
		// No multiplayer server resolved for this environment (e.g. production
		// with no walk-server meta/env configured). Surface a distinct, honest
		// 'unavailable' state — the page still works solo — instead of throwing
		// in `new Client('')`, looping on a dead endpoint, or showing a
		// "reconnecting…" pill that will never reconnect (no server exists).
		if (!this.url) {
			this._setStatus('unavailable');
			return;
		}
		// Bump a generation token so a slower in-flight connect (e.g. a manual
		// retry racing the auto-reconnect timer) can detect it's been superseded
		// after its await resolves and discard the room it joined, rather than
		// orphaning a second live socket — the same duplicate-chat leak.
		const gen = ++this._connectGen;
		this._setStatus('connecting');
		try {
			this.client = new Client(this.url);
			// `token` is the server's filterBy key (matchmaking): clients with the
			// same coin mint join one room instance. `coin`/`coinName`/… seed that
			// room's identity the first time it's created. Empty coin → mainland.
			const presence = this.getPresence ? await this.getPresence().catch(() => null) : null;
			// Hard timeout on the join: a hung handshake (cold-start server, proxy
			// holding the WS upgrade) would otherwise strand us in 'connecting'
			// forever — joinOrCreate has no timeout. On timeout this throws and the
			// catch below schedules a reconnect.
			const room = await joinRoomWithTimeout(this.client, this.roomName, {
				name: this.name,
				avatar: this.avatar,
				agent: this.agent,
				token: this.coin,
				coin: this.coin,
				coinName: this.coinName,
				coinSymbol: this.coinSymbol,
				coinImage: this.coinImage,
				cosmetics: this.cosmetics,
				...(presence ? { presence } : {}),
				// No root-schema class passed on purpose: decode state from the server's
				// reflected schema (handshake) so the client never desyncs when a deployed
				// server adds an append-only field this bundle predates. See joinRoomWithTimeout.
			});
			if (this._destroyed || gen !== this._connectGen) {
				try { room.leave(); } catch {}
				return;
			}
			this.room = room;
			this.mySessionId = this.room.sessionId;

			// Colyseus 0.16 moved schema callbacks behind getStateCallbacks(room)
			// — the legacy `state.players.onAdd(fn)` form no longer exists.
			const $ = getStateCallbacks(this.room);
			const $players = $(this.room.state)?.players;
			if ($players) {
				$players.onAdd((player, sessionId) => {
					this._emit('add', player, sessionId);
					// Per-instance onChange fires on every field delta.
					$(player).onChange(() => this._emit('change', player, sessionId));
				});
				$players.onRemove((_player, sessionId) => {
					this._emit('remove', sessionId);
				});
			}

			// Chat is broadcast (not schema state) so it arrives as a room message.
			// We relay it through our own event API; walk.js renders the bubble +
			// log line and routes it to the right remote player.
			this.room.onMessage('chat', (msg) => this._emit('chat', msg));
			// Friends (Task 15): live DM + request/accept events pushed by the social hub.
			this.room.onMessage('social', (msg) => this._emit('social', msg));

			this.room.onLeave((code) => {
				this._setStatus('offline');
				if (!this._destroyed && code !== 1000) this._scheduleReconnect();
			});
			this.room.onError((code, message) => {
				log.warn('[walk-net] room.onError', code, message);
			});

			this._setStatus('online');
		} catch (err) {
			// Colyseus handshake failures often carry an empty message (the 403
			// is only visible on the WS upgrade) — fall back to code/String so
			// the diagnostic is never blank.
			const reason = err?.message || (err?.code != null ? `code ${err.code}` : String(err));
			log.warn('[walk-net] connect failed:', reason);
			this._setStatus('failed', reason);
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
	// Send a message only when the wire is actually open. `this.room` alone isn't
	// enough: between the socket entering CLOSING and onLeave firing, the room
	// reference is still live, and ws.send() on that socket logs a console
	// warning per message ("WebSocket is already in CLOSING or CLOSED state").
	// Returns true when the message reached an open socket.
	_send(type, payload) {
		const room = this.room;
		if (!room || room.connection?.isOpen !== true) return false;
		try { room.send(type, payload); } catch { return false; }
		return true;
	}

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

		if (!this._send('move', {
			x: state.x,
			y: state.y,
			z: state.z,
			yaw: state.yaw,
			motion: state.motion,
		})) return;
		this._lastSent = { ...state };
		this._lastSentAt = now;
	}

	rename(name) {
		this.name = name;
		this._send('rename', { name });
	}

	sendEmote(name) {
		this._send('emote', { name });
	}

	sendChat(text) {
		const t = String(text || '').trim().slice(0, 200);
		if (t) this._send('chat', { text: t });
	}

	/** Swap this player's avatar mid-session (after picking a new one). */
	sendAvatar(avatar, agent) {
		this.avatar = avatar || this.avatar;
		if (agent != null) this.agent = agent;
		this._send('avatar', { avatar: this.avatar, agent: this.agent });
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
		this._closeRoom();
		this.client = null;
	}
}
