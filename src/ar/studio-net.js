// Realtime client for the shared AR Studio — wraps colyseus.js with a tiny event
// API so src/ar-studio.js can join a shared room and live-sync placed models
// without knowing anything about Colyseus. Mirrors src/irl-net.js in shape
// (status model, single-retry reconnect, no storms) so the two transports read
// the same.
//
// What it does: joins the `studio_world` room for a given roomKey (a shared code,
// or a QR-marker id when co-located) and relays the shared scene — every model's
// add / change / remove — plus live presence (who else is in the room). Local
// edits are sent up via spawn/update/remove; the server owner-gates, caps, and
// rate-limits, then delta-broadcasts to every peer.
//
// Transforms ride in the room's shared LOGICAL frame (relEast / relNorth metres,
// yawDeg) — see multiplayer/src/studio-schemas.js. Mapping to/from each device's
// local scene is the caller's job (src/ar/studio-coords.js).
//
// Graceful degradation: no server configured, or the socket can't be reached
// after one retry → a distinct status (`unavailable` / `failed`) and the studio
// simply stays single-player. Never loops on a dead endpoint.

import { Client, getStateCallbacks } from 'colyseus.js';
import { StudioState } from '../../multiplayer/src/studio-schemas.js';
import { joinRoomWithTimeout } from '../shared/colyseus-connect.js';
import { log } from '../shared/log.js';

const ROOM_NAME = 'studio_world';
const MAX_RETRIES = 1;

// Resolve the Colyseus host the same way irl-net does — the studio world runs on
// the SAME server as /walk and /irl (a new room, not a new process).
function defaultServerUrl() {
	if (typeof window !== 'undefined') {
		if (window.STUDIO_SERVER_URL) return String(window.STUDIO_SERVER_URL).trim().replace(/\/$/, '');
		if (window.IRL_SERVER_URL) return String(window.IRL_SERVER_URL).trim().replace(/\/$/, '');
		if (window.WALK_SERVER_URL) return String(window.WALK_SERVER_URL).trim().replace(/\/$/, '');
	}
	if (typeof document !== 'undefined') {
		for (const name of ['studio-server', 'irl-server', 'walk-server']) {
			const v = document.querySelector(`meta[name="${name}"]`)?.getAttribute('content')?.trim();
			if (v) return v.replace(/\/$/, '');
		}
	}
	try {
		const envUrl = import.meta?.env?.VITE_IRL_SERVER_URL || import.meta?.env?.VITE_WALK_SERVER_URL;
		if (envUrl) return String(envUrl).trim().replace(/\/$/, '');
	} catch (_) {}
	if (typeof location !== 'undefined') {
		const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const host = location.hostname;
		const fwd = host.match(/^(.*)-(\d+)\.(app\.github\.dev|githubpreview\.dev|gitpod\.io)$/);
		if (fwd) return `${proto}//${fwd[1]}-2567.${fwd[3]}`;
		let isProd = false;
		try { isProd = import.meta?.env?.PROD === true; } catch (_) {}
		const isLocalHost = host === 'localhost' || host === '127.0.0.1';
		if (!isProd || isLocalHost) return `${proto}//${host}:2567`;
		return '';
	}
	return '';
}

export class StudioNet {
	/**
	 * @param {object} opts
	 * @param {string} opts.roomKey   Shared match key (code or marker id).
	 * @param {string} [opts.clientId] Stable per-browser id → model ownership.
	 * @param {string} [opts.name]     Optional display name for presence.
	 * @param {string} [opts.url]      Override server URL (tests).
	 */
	constructor({ roomKey, clientId = '', name = '', url } = {}) {
		this.roomKey = String(roomKey || '').slice(0, 64);
		this.clientId = String(clientId || '').slice(0, 80);
		this.name = String(name || '').slice(0, 120);
		this.url = (url ?? defaultServerUrl()) || '';
		this.status = 'idle';
		this.error = '';
		this.room = null;
		this.client = null;
		this._listeners = { status: [], models: [], model: [], presence: [], reject: [] };
		this._retries = 0;
		this._reconnectTimer = null;
		this._connectGen = 0;
		this._destroyed = false;
		this._presenceQueued = false;
	}

	on(event, fn) {
		(this._listeners[event] ||= []).push(fn);
		return this;
	}

	_emit(event, payload) {
		for (const fn of this._listeners[event] || []) {
			try { fn(payload); } catch (e) { log.warn(`[studio-net] ${event} listener error:`, e?.message || e); }
		}
	}

	_setStatus(status, error = '') {
		this.status = status;
		this.error = error;
		this._emit('status', { status, error });
	}

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
		if (!this.url) { this._setStatus('unavailable'); return; }
		if (!this.roomKey) { this._setStatus('unavailable'); return; }
		const gen = ++this._connectGen;
		this._setStatus('connecting');
		try {
			this.client = new Client(this.url);
			const room = await joinRoomWithTimeout(this.client, ROOM_NAME, {
				roomKey: this.roomKey,
				clientId: this.clientId,
				name: this.name,
			}, StudioState);
			if (this._destroyed || gen !== this._connectGen) {
				try { room.leave(); } catch {}
				return;
			}
			this.room = room;
			this._retries = 0;

			const $ = getStateCallbacks(this.room);

			// The shared scene: any model add / per-field change / remove re-emits the
			// full model list so the studio reconciles its local placements against it.
			// The join handshake fires onAdd once per existing model, so we coalesce
			// the burst into a single emit next tick.
			const $models = $(this.room.state)?.models;
			if ($models) {
				$models.onAdd((model, id) => {
					$(model).onChange(() => this._emit('model', this._modelShape(model, id)));
					this._queueModels();
				});
				$models.onRemove((model, id) => {
					this._emit('model', { id, removed: true });
					this._queueModels();
				});
			}

			const $viewers = $(this.room.state)?.viewers;
			if ($viewers) {
				$viewers.onAdd(() => this._queuePresence());
				$viewers.onRemove(() => this._queuePresence());
			}

			// A rejected op (room/owner full) — surface it so the UI can explain.
			this.room.onMessage('model:reject', (msg) => this._emit('reject', msg));

			this.room.onLeave((code) => {
				if (this._destroyed || code === 1000) return;
				this._setStatus('offline');
				this._scheduleReconnect();
			});
			this.room.onError((code, message) => log.warn('[studio-net] room.onError', code, message));

			this._setStatus('online');
			// Emit the initial scene + presence once the handshake burst settles.
			this._queueModels();
			this._queuePresence();
		} catch (err) {
			const reason = err?.message || (err?.code != null ? `code ${err.code}` : String(err));
			log.warn('[studio-net] connect failed:', reason);
			this._setStatus('failed', reason);
			this._scheduleReconnect();
		}
	}

	_scheduleReconnect() {
		if (this._reconnectTimer || this._destroyed) return;
		if (this._retries >= MAX_RETRIES) { this._setStatus('unavailable', this.error); return; }
		this._retries++;
		const delay = 2500 + Math.random() * 1500;
		this._reconnectTimer = setTimeout(() => {
			this._reconnectTimer = null;
			if (this._destroyed) return;
			this.connect();
		}, delay);
	}

	_modelShape(m, id) {
		return {
			id: id ?? m.id,
			src: m.src,
			title: m.title,
			relEast: m.relEast,
			relNorth: m.relNorth,
			yawDeg: m.yawDeg,
			scale: m.scale,
			height: m.height,
			ownerId: m.ownerId,
			mine: !!this.clientId && m.ownerId === this.clientId,
		};
	}

	_queueModels() {
		if (this._modelsQueued || this._destroyed) return;
		this._modelsQueued = true;
		Promise.resolve().then(() => {
			this._modelsQueued = false;
			if (this._destroyed || !this.room) return;
			const map = this.room.state?.models;
			if (!map) return;
			const models = [];
			map.forEach((m, id) => models.push(this._modelShape(m, id)));
			this._emit('models', models);
		});
	}

	_queuePresence() {
		if (this._presenceQueued || this._destroyed) return;
		this._presenceQueued = true;
		Promise.resolve().then(() => {
			this._presenceQueued = false;
			if (this._destroyed || !this.room) return;
			const map = this.room.state?.viewers;
			if (!map) return;
			let count = 0;
			const names = [];
			map.forEach((v) => { count++; if (v.name) names.push(v.name); });
			this._emit('presence', { count, names });
		});
	}

	_live() {
		return this.status === 'online' && this.room && this.room.connection?.isOpen === true;
	}

	/** Add a model to the shared scene. `model` is in the shared logical frame. */
	spawn(model) {
		if (!this._live()) return false;
		try {
			this.room.send('model:spawn', {
				id: model.id,
				src: String(model.src || ''),
				title: String(model.title || '').slice(0, 120),
				relEast: Number(model.relEast) || 0,
				relNorth: Number(model.relNorth) || 0,
				yawDeg: Number(model.yawDeg) || 0,
				scale: Number(model.scale) || 1,
				height: Number(model.height) || 0,
			});
			return true;
		} catch (e) {
			log.warn('[studio-net] spawn failed:', e?.message || e);
			return false;
		}
	}

	/** Move / resize / rotate a model you own. Partial patch. */
	update(id, patch) {
		if (!this._live() || !id) return false;
		const msg = { id: String(id) };
		for (const k of ['relEast', 'relNorth', 'yawDeg', 'scale']) {
			if (Number.isFinite(patch?.[k])) msg[k] = patch[k];
		}
		try { this.room.send('model:update', msg); return true; } catch (e) {
			log.warn('[studio-net] update failed:', e?.message || e);
			return false;
		}
	}

	/** Remove a model you own. */
	remove(id) {
		if (!this._live() || !id) return false;
		try { this.room.send('model:remove', { id: String(id) }); return true; } catch (e) {
			log.warn('[studio-net] remove failed:', e?.message || e);
			return false;
		}
	}

	heartbeat() {
		if (!this._live()) return;
		try { this.room.send('heartbeat', {}); } catch (e) { log.warn('[studio-net] heartbeat failed:', e?.message || e); }
	}

	destroy() {
		this._destroyed = true;
		if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
		this._closeRoom();
		try { this.client = null; } catch {}
		this._setStatus('destroyed');
	}
}
