// Realtime client for /stage — wraps colyseus.js with a small event API so
// stage.js can subscribe to the live show without knowing Colyseus. Mirrors
// irl-net.js / walk-net.js in shape (status model, single-retry reconnect, no
// storms) so the transports read the same.
//
// It joins the stage_world room for a given stageId and relays:
//   • host       — the host's performance frame (caption/beat/cue/speaking) as it
//                  changes, so the page renders captions + animation in sync.
//   • utterance  — the timed spoken beat { id, text, voice, cue, durationMs }; the
//                  page fetches TTS for it and plays spatial voice + lip-sync.
//   • audience   — the live crowd (count + members) for the 3D venue.
//   • tip        — a settled tip event (ticker + crowd cheer), within ~1s.
//   • leaderboard— the synced top-tippers board.
//   • reaction   — an emoji another audience member fired.
//
// Graceful degradation: if no server is configured or the socket can't be
// reached after one retry, it settles into a distinct status so the page shows an
// honest "performance feed offline" state — captions/tips still work via polling.

import { Client, getStateCallbacks } from 'colyseus.js';
import { StageState } from '../multiplayer/src/stage-schemas.js';
import { joinRoomWithTimeout } from './shared/colyseus-connect.js';
import { log } from './shared/log.js';

const ROOM_NAME = 'stage_world';
const MAX_RETRIES = 1;

// Same resolution chain as irl-net: explicit override → meta → env → Codespaces
// port forwarding → same-host:2567 in dev. '' in prod with none set ⇒ poll mode.
function defaultServerUrl() {
	if (typeof window !== 'undefined') {
		if (window.STAGE_SERVER_URL) return String(window.STAGE_SERVER_URL).trim().replace(/\/$/, '');
		if (window.WALK_SERVER_URL) return String(window.WALK_SERVER_URL).trim().replace(/\/$/, '');
	}
	if (typeof document !== 'undefined') {
		for (const name of ['stage-server', 'walk-server']) {
			const v = document.querySelector(`meta[name="${name}"]`)?.getAttribute('content')?.trim();
			if (v) return v.replace(/\/$/, '');
		}
	}
	try {
		const envUrl = import.meta?.env?.VITE_STAGE_SERVER_URL || import.meta?.env?.VITE_WALK_SERVER_URL;
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

export class StageNet {
	constructor(opts = {}) {
		this.stageId = String(opts.stageId || '');
		this.name = opts.name || '';
		this.avatar = opts.avatar || '';
		this.url = opts.url || defaultServerUrl();

		this.client = null;
		this.room = null;
		this.status = 'idle'; // idle | connecting | online | offline | failed | unavailable
		this.error = null;
		this.sessionId = null;
		this._handlers = {
			status: new Set(),
			host: new Set(),
			utterance: new Set(),
			audience: new Set(),
			tip: new Set(),
			leaderboard: new Set(),
			reaction: new Set(),
		};
		this._retries = 0;
		this._reconnectTimer = null;
		this._destroyed = false;
		this._connectGen = 0;
		this._audienceQueued = false;
		this._hb = null;
	}

	on(event, fn) {
		const bucket = this._handlers[event];
		if (!bucket) throw new Error(`StageNet: unknown event "${event}"`);
		bucket.add(fn);
		return () => bucket.delete(fn);
	}

	_emit(event, ...args) {
		for (const fn of this._handlers[event]) {
			try { fn(...args); } catch (e) { log.error(`[stage-net] ${event} handler threw:`, e); }
		}
	}

	_setStatus(status, error = null) {
		this.status = status;
		this.error = error;
		this._emit('status', { status, error });
	}

	_closeRoom() {
		const room = this.room;
		if (this._hb) { clearInterval(this._hb); this._hb = null; }
		if (!room) return;
		this.room = null;
		try { room.removeAllListeners(); } catch {}
		try { room.leave(); } catch {}
	}

	async connect() {
		if (this._destroyed) return;
		this._closeRoom();
		if (!this.url || !this.stageId) {
			this._setStatus('unavailable');
			return;
		}
		const gen = ++this._connectGen;
		this._setStatus('connecting');
		try {
			this.client = new Client(this.url);
			const room = await joinRoomWithTimeout(this.client, ROOM_NAME, {
				stageId: this.stageId,
				name: this.name,
				avatar: this.avatar,
			}, StageState);
			if (this._destroyed || gen !== this._connectGen) {
				try { room.leave(); } catch {}
				return;
			}
			this.room = room;
			this.sessionId = room.sessionId;
			this._retries = 0;

			const $ = getStateCallbacks(this.room);

			// Host performance frame — emit the full host snapshot on any change.
			const $host = $(this.room.state)?.host;
			if ($host) {
				$host.onChange(() => this._emit('host', snapshotHost(this.room.state.host)));
			}

			// Audience — coalesce the join-time burst into one emit.
			const $aud = $(this.room.state)?.audience;
			if ($aud) {
				$aud.onAdd((m) => { $(m).onChange(() => this._queueAudience()); this._queueAudience(); });
				$aud.onRemove(() => this._queueAudience());
			}

			// Leaderboard — the synced top-tippers array.
			const $lb = $(this.room.state)?.leaderboard;
			if ($lb) {
				$lb.onAdd(() => this._emitLeaderboard());
				$lb.onRemove(() => this._emitLeaderboard());
				$lb.onChange?.(() => this._emitLeaderboard());
			}

			// Transient broadcasts.
			this.room.onMessage('utterance', (msg) => this._emit('utterance', msg));
			this.room.onMessage('tip', (msg) => this._emit('tip', msg));
			this.room.onMessage('reaction', (msg) => this._emit('reaction', msg));
			this.room.onMessage('question_ack', (msg) => this._emit('reaction', { ack: msg }));

			this.room.onLeave((code) => {
				if (this._destroyed || code === 1000) return;
				this._setStatus('offline');
				this._scheduleReconnect();
			});
			this.room.onError((code, message) => log.warn('[stage-net] room.onError', code, message));

			// Initial full snapshots + a heartbeat so the reaper keeps us.
			this._emit('host', snapshotHost(this.room.state.host));
			this._emitLeaderboard();
			this._queueAudience();
			// connection.isOpen catches the CLOSING/CLOSED window before onLeave
			// fires — ws.send() there logs a console warning instead of throwing.
			this._hb = setInterval(() => {
				if (this.room?.connection?.isOpen !== true) return;
				try { this.room.send('heartbeat'); } catch {}
			}, 15_000);

			this._setStatus('online');
		} catch (err) {
			const reason = err?.message || (err?.code != null ? `code ${err.code}` : String(err));
			log.warn('[stage-net] connect failed:', reason);
			this._setStatus('failed', reason);
			this._scheduleReconnect();
		}
	}

	_scheduleReconnect() {
		if (this._reconnectTimer || this._destroyed) return;
		if (this._retries >= MAX_RETRIES) {
			this._setStatus('unavailable', this.error);
			return;
		}
		this._retries++;
		const delay = 2500 + Math.random() * 1500;
		this._reconnectTimer = setTimeout(() => {
			this._reconnectTimer = null;
			if (this._destroyed) return;
			this.connect();
		}, delay);
	}

	react(emoji) {
		if (this.status !== 'online' || this.room?.connection?.isOpen !== true) return;
		try { this.room.send('reaction', { emoji: String(emoji) }); } catch (e) {
			log.warn('[stage-net] reaction send failed:', e?.message || e);
		}
	}

	ask(text) {
		if (this.status !== 'online' || this.room?.connection?.isOpen !== true) return false;
		try { this.room.send('question', { text: String(text) }); return true; } catch (e) {
			log.warn('[stage-net] question send failed:', e?.message || e);
			return false;
		}
	}

	_queueAudience() {
		if (this._audienceQueued || this._destroyed) return;
		this._audienceQueued = true;
		Promise.resolve().then(() => {
			this._audienceQueued = false;
			this._emitAudience();
		});
	}

	_emitAudience() {
		if (this._destroyed || !this.room) return;
		const map = this.room.state?.audience;
		if (!map) return;
		const members = [];
		map.forEach((m, id) => {
			members.push({ id, name: m.name || '', avatar: m.avatar || '', x: m.x, z: m.z, vip: !!m.vip, reaction: m.reaction || '', reactionTs: m.reactionTs });
		});
		this._emit('audience', { count: members.length, members, selfId: this.room.sessionId });
	}

	_emitLeaderboard() {
		if (this._destroyed || !this.room) return;
		const lb = this.room.state?.leaderboard;
		if (!lb) return;
		const rows = [];
		lb.forEach((t) => rows.push({ label: t.label, total: Number(t.total), count: t.count }));
		this._emit('leaderboard', {
			rows,
			totalTipsAtomic: Number(this.room.state.totalTipsAtomic || 0),
			tipCount: this.room.state.tipCount || 0,
			phase: this.room.state.phase,
		});
	}

	retry() {
		if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
		this._retries = 0;
		this.connect();
	}

	destroy() {
		this._destroyed = true;
		if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
		this._closeRoom();
		this.client = null;
	}
}

function snapshotHost(h) {
	if (!h) return null;
	return {
		agentId: h.agentId, name: h.name, avatar: h.avatar, voice: h.voice,
		utteranceId: h.utteranceId, beat: h.beat, caption: h.caption, cue: h.cue,
		speaking: h.speaking, startedAtMs: h.startedAtMs,
	};
}
