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
import { joinRoomWithTimeout } from './shared/colyseus-connect.js';
import { defaultGameServerUrl } from './shared/game-server-url.js';
import { log } from './shared/log.js';

const ROOM_NAME = 'stage_world';
const MAX_RETRIES = 1;

// Resolution order: an explicit stage override (window.STAGE_SERVER_URL, the
// stage-server meta, VITE_STAGE_SERVER_URL), then the shared game-server chain
// every other realtime surface uses (src/shared/game-server-url.js): localhost
// always talks to the local server, production reads the game-server meta baked
// into the page, and '' with nothing configured means "stay offline" rather than
// loop on a dead socket. Before this shared the chain, production resolved to ''
// because /stage never carried its own meta, so every live show read "feed
// offline" while the room kept performing to nobody.
function defaultServerUrl() {
	const trim = (v) => String(v).trim().replace(/\/$/, '');
	if (typeof window !== 'undefined' && window.STAGE_SERVER_URL) return trim(window.STAGE_SERVER_URL);
	if (typeof document !== 'undefined') {
		const v = document.querySelector('meta[name="stage-server"]')?.getAttribute('content')?.trim();
		if (v) return trim(v);
	}
	try {
		const envUrl = import.meta?.env?.VITE_STAGE_SERVER_URL;
		if (envUrl) return trim(envUrl);
	} catch (_) { /* import.meta.env is absent outside the bundler */ }
	return defaultGameServerUrl();
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
			// No root-schema class passed on purpose: the client decodes state from
			// the schema the server reflects during the handshake, so a field the
			// deployed room adds never desyncs a bundle that predates it.
			const room = await joinRoomWithTimeout(this.client, ROOM_NAME, {
				stageId: this.stageId,
				name: this.name,
				avatar: this.avatar,
			});
			if (this._destroyed || gen !== this._connectGen) {
				try { room.leave(); } catch {}
				return;
			}
			this.room = room;
			this.sessionId = room.sessionId;
			this._retries = 0;

			// Message handlers first: the room opens the show the instant the first
			// audience member joins, and that `utterance` lands before any state work
			// below completes. A handler registered late drops the opening line.
			this.room.onMessage('utterance', (msg) => this._emit('utterance', msg));
			this.room.onMessage('tip', (msg) => this._emit('tip', msg));
			this.room.onMessage('reaction', (msg) => this._emit('reaction', msg));
			this.room.onMessage('question_ack', (msg) => this._emit('reaction', { ack: msg }));

			const $ = getStateCallbacks(this.room);

			// Host performance frame. The join resolves on JOIN_ROOM, before the first
			// state patch, so `state.host` has no decoder ref yet and `onChange` on it
			// throws ("Can't addCallback on 'REPLACE'"). `listen` on the root defers
			// until the child lands and fires at once when it is already there, which
			// also hands a late joiner the current caption.
			$(this.room.state).listen('host', (host) => {
				if (!host) return;
				$(host).onChange(() => this._emit('host', snapshotHost(host)));
				this._emit('host', snapshotHost(host));
			});

			// Audience: coalesce the join-time burst into one emit. Collection
			// proxies defer on their own until the map is decoded.
			const $aud = $(this.room.state).audience;
			$aud.onAdd((m) => { $(m).onChange(() => this._queueAudience()); this._queueAudience(); });
			$aud.onRemove(() => this._queueAudience());

			// Leaderboard: the synced top-tippers array.
			const $lb = $(this.room.state).leaderboard;
			$lb.onAdd(() => this._emitLeaderboard());
			$lb.onRemove(() => this._emitLeaderboard());
			$lb.onChange(() => this._emitLeaderboard());

			this.room.onLeave((code) => {
				if (this._destroyed || code === 1000) return;
				this._setStatus('offline');
				this._scheduleReconnect();
			});
			this.room.onError((code, message) => log.warn('[stage-net] room.onError', code, message));

			// Initial snapshots (a no-op until the first patch decodes the state) +
			// a heartbeat so the reaper keeps us.
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
			// A join that succeeded but failed to wire must not leave a live socket
			// behind: the next attempt would double-deliver every broadcast.
			this._closeRoom();
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
		if (this._destroyed || this.status === 'connecting' || this.status === 'online') return;
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
