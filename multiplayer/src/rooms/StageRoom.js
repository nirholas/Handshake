// StageRoom — the live-performance world (stage_world) for three.ws Living Stages.
//
// An embodied AI agent hosts a real-time show in a 3D venue: it opens, riffs,
// runs its format, takes audience questions, and — the heart of the loop —
// reacts on the spot to real $THREE tips that settle on-chain to its wallet. The
// crowd is co-present (privacy-clean presence like IrlRoom), reactions ripple,
// and a live tip leaderboard drives who the host shouts out.
//
// What this room owns:
//   • AUDIENCE presence — a session id + opt-in name/avatar + a server-assigned
//     ring seat (never a client-reported coordinate), heartbeats + a reaper.
//   • The HOST performance frame — each beat bumps `utteranceId` and broadcasts a
//     timed `utterance` { id, text, voice, cue, beat, durationMs } that every
//     client renders identically: spatial voice (client fetches /api/tts/speak),
//     lip-sync, animation cue, and live captions. Captions are also written into
//     synced state so a late joiner / no-WebGL client still reads the show.
//   • The TIP TICKER + leaderboard — fed by the API over /internal/stage the
//     instant a tip settles, so the host pre-empts its next beat to react in ~1s.
//
// The show's DECISIONS (which beat, who's top, which question) live in the pure
// ShowDirector (../stage-show.js); this room is the socket+schema shell. The
// host's WORDS come from the brain via /api/stage/host (latest Claude). Money is
// integer atomic units end to end; the room never trusts a client-asserted tip —
// only the API's verified, signature-deduped settlement reaches injectTip().

import { Room } from '@colyseus/core';

import { StageState, StageAudience, StageTipper } from '../stage-schemas.js';
import { ShowDirector, BEAT } from '../stage-show.js';
import { registerStage, unregisterStage } from '../stage-registry.js';
import { signStageRequest } from '../presence-token.js';
import { installUnknownMessageGuard } from '../room-compat.js';

const PATCH_RATE_MS = 100; // 10 Hz — snappy enough for the tip ticker + captions
const MAX_CLIENTS = 200; // a busy venue; bound so a flood degrades gracefully
const BEAT_INTERVAL_MS = 13_000; // cadence between host beats when nothing pre-empts
const SPEAK_ESTIMATE_MS = 90; // per character, for the speaking → idle timer
const SPEAK_MIN_MS = 3_000;
const SPEAK_MAX_MS = 22_000;
const HEARTBEAT_STALE_MS = 45_000;
const REAPER_INTERVAL_MS = 15_000;
const REACTIONS_PER_SEC = 4; // anti-spam on the emoji channel
const QUESTIONS_PER_MIN = 6;
const VIP_TIP_THRESHOLD = 50_000 * 1_000_000; // ≥ 50k $THREE (6 decimals) → VIP front row
const RING_RADIUS = 6; // metres — audience seated on a ring around the stage

const API_BASE = (
	process.env.THREEWS_API_BASE ||
	process.env.MULTIPLAYER_API_BASE ||
	'https://three.ws'
).replace(/\/$/, '');

const REACTIONS = new Set(['clap', 'fire', 'heart', 'laugh', 'wow', 'cheer']);

export class StageRoom extends Room {
	constructor() {
		super();
		this.maxClients = MAX_CLIENTS;
		this.stageId = '';
		this._director = null;
		this._beatTimer = null;
		this._speakTimer = null;
		this._beatRunning = false;
		this._rate = new Map(); // sessionId → { react:{ts,n}, ask:{ts,n} }
		this._configLoaded = false;
	}

	async onCreate(options) {
		this.stageId = String(options?.stageId || '').slice(0, 64);
		this.setState(new StageState());
		this.state.stageId = this.stageId;
		this.state.phase = 'preshow';
		this.setPatchRate(PATCH_RATE_MS);
		this.autoDispose = false; // a scheduled show outlives an empty crowd between beats
		// Unknown message types are ignored, never a session kill (room-compat.js).
		installUnknownMessageGuard(this, 'stage');

		this._director = new ShowDirector({ stageId: this.stageId });

		// Audience reactions ripple to the whole crowd; questions queue for the host
		// to pick; heartbeats keep the reaper from dropping a live viewer.
		this.onMessage('reaction', (client, payload) => this._guard('reaction', () => this._handleReaction(client, payload)));
		this.onMessage('question', (client, payload) => this._guard('question', () => this._handleQuestion(client, payload)));
		this.onMessage('heartbeat', (client) => this._guard('heartbeat', () => this._handleHeartbeat(client)));

		this.clock.setInterval(() => this._reap(), REAPER_INTERVAL_MS);

		// Register BEFORE the async config load so a tip arriving during boot finds
		// the room (it queues into the director regardless of config).
		registerStage(this.stageId, this);

		await this._loadConfig();

		// The performance heartbeat: pick + perform the next beat on a cadence. A
		// tip pre-empts this (see injectTip) so a shoutout never waits a full beat.
		// The cadence is gated on a present audience (see _runBeat) so the host never
		// burns the brain performing to an empty room between shows.
		this._beatTimer = this.clock.setInterval(() => this._runBeat('cadence'), BEAT_INTERVAL_MS);

		console.log(`${this._tag()} created (host=${this.state.host.name || 'unknown'})`);
	}

	_tag() {
		return `[stage_world ${this.roomId} stage=${this.stageId || 'invalid'}]`;
	}

	_guard(label, fn) {
		try {
			fn();
		} catch (err) {
			console.error(`${this._tag()} ${label} handler error:`, err?.message || err);
		}
	}

	// Pull the stage's display config (host agent name/avatar/voice, title, format,
	// schedule, phase) from the API. The persona + memory the brain needs live
	// server-side in /api/stage/host — this room only needs what it renders.
	async _loadConfig() {
		try {
			const res = await fetch(`${API_BASE}/api/stage?id=${encodeURIComponent(this.stageId)}`, {
				headers: { accept: 'application/json' },
				signal: AbortSignal.timeout(6_000),
			});
			if (!res.ok) throw new Error(`config http ${res.status}`);
			const data = await res.json();
			const stage = data?.stage || data;
			if (stage) {
				this.state.title = clean(stage.title, 120);
				this.state.format = clean(stage.format, 60);
				this.state.nextShowAt = Number(stage.next_show_at) || 0;
				const h = this.state.host;
				h.agentId = clean(stage.agent_id, 64);
				h.name = clean(stage.host_name || stage.agent_name, 80) || 'The Host';
				h.avatar = clean(stage.host_avatar || stage.avatar_url, 512);
				h.voice = clean(stage.voice, 40) || 'nova';
				this._director.hostName = h.name;
				this._director.format = this.state.format || 'open mic';
			}
			this._configLoaded = true;
		} catch (err) {
			// A config miss must not silence the show — fall back to a generic host
			// identity so the room still runs (real beats, just an unstyled name).
			console.warn(`${this._tag()} config load failed: ${err?.message || err}`);
			const h = this.state.host;
			if (!h.name) h.name = 'The Host';
			if (!h.voice) h.voice = 'nova';
		}
	}

	// ── audience presence ─────────────────────────────────────────────────────
	onJoin(client, options) {
		const member = new StageAudience();
		member.id = client.sessionId;
		member.name = clean(options?.name, 40);
		member.avatar = clean(options?.avatar, 512);
		const seat = this._assignSeat();
		member.x = seat.x;
		member.z = seat.z;
		member.tsServer = Date.now();
		this.state.audience.set(client.sessionId, member);
		this._director.noteAudience(this.state.audience.size);
		console.log(`${this._tag()} +join (audience=${this.state.audience.size})`);
		// Open the show for the first arrival (or whenever the host hasn't spoken
		// yet) so a joiner never lands on a silent stage — but only once someone is
		// actually here to hear it.
		if (this.state.host.utteranceId === 0) this._runBeat('open');
	}

	onLeave(client) {
		this._rate.delete(client.sessionId);
		const had = this.state.audience.delete(client.sessionId);
		if (had) console.log(`${this._tag()} -leave (audience=${this.state.audience.size})`);
	}

	// Seat each arrival on a ring around the stage, golden-angle spaced so the
	// crowd fans out evenly instead of stacking. Server-assigned (never a client
	// coordinate) so presence can't be used to probe or spoof a position.
	_assignSeat() {
		const i = this.state.audience.size;
		const angle = i * 2.399963; // golden angle (rad)
		const r = RING_RADIUS + (i % 3) * 1.6; // a few concentric rings as it fills
		return { x: Math.cos(angle) * r, z: Math.sin(angle) * r };
	}

	_handleReaction(client, payload) {
		if (!this.state.audience.has(client.sessionId)) return;
		if (!this._rateOk(client.sessionId, 'react', REACTIONS_PER_SEC, 1000)) return;
		const emoji = typeof payload?.emoji === 'string' ? payload.emoji : '';
		if (!REACTIONS.has(emoji)) return;
		const member = this.state.audience.get(client.sessionId);
		member.reaction = emoji;
		member.reactionTs = Date.now();
		// Broadcast so the whole crowd renders the ripple at once (sender included).
		this.broadcast('reaction', { id: client.sessionId, emoji, ts: member.reactionTs }, { afterNextPatch: false });
	}

	_handleQuestion(client, payload) {
		if (!this.state.audience.has(client.sessionId)) return;
		if (!this._rateOk(client.sessionId, 'ask', QUESTIONS_PER_MIN, 60_000)) {
			client.send('question_ack', { ok: false, reason: 'slow_down' });
			return;
		}
		const member = this.state.audience.get(client.sessionId);
		const ok = this._director.queueQuestion({
			id: `${client.sessionId}:${Date.now()}`,
			from: member.name || 'someone',
			text: typeof payload?.text === 'string' ? payload.text : '',
			ts: Date.now(),
		});
		client.send('question_ack', { ok, queued: this._director.pendingQuestionCount() });
	}

	_handleHeartbeat(client) {
		const member = this.state.audience.get(client.sessionId);
		if (member) member.tsServer = Date.now();
	}

	_reap() {
		const cutoff = Date.now() - HEARTBEAT_STALE_MS;
		for (const [id, m] of this.state.audience) {
			if (m.tsServer < cutoff) {
				this.state.audience.delete(id);
				this._rate.delete(id);
			}
		}
	}

	_rateOk(sessionId, key, limit, windowMs) {
		const now = Date.now();
		let buckets = this._rate.get(sessionId);
		if (!buckets) {
			buckets = {};
			this._rate.set(sessionId, buckets);
		}
		let b = buckets[key];
		if (!b || now - b.ts > windowMs) {
			b = { ts: now, n: 0 };
			buckets[key] = b;
		}
		b.n += 1;
		return b.n <= limit;
	}

	// ── tips (injected by the API over /internal/stage) ───────────────────────
	// The ONLY path a tip enters the show. The API has already verified the
	// on-chain settlement signature, the $THREE/USDC mint, and deduped by
	// signature, so this is a trusted, distinct, real tip. We rank it, sync the
	// leaderboard, broadcast the ticker event (visible reaction < 1s), and
	// pre-empt the next host beat so the spoken shoutout follows immediately.
	injectTip(tip) {
		if (!tip || !this._director) return { ok: false };
		const amount = Number(tip.amount) || 0;
		const { tip: recorded, isNewTopTipper } = this._director.ingestTip({
			tipperId: tip.tipperId || tip.tipper || tip.signature,
			label: tip.label || tip.tipperLabel || 'someone',
			amount,
			mint: tip.mint || tip.currencyMint || null,
			signature: tip.signature || null,
			message: tip.message || '',
			ts: Date.now(),
		});

		this.state.totalTipsAtomic = this._director.totalTipsAtomic;
		this.state.tipCount = this._director.tipCount;
		this._syncLeaderboard();

		// Promote a big tipper to the VIP front row (the host's direct attention).
		if (amount >= VIP_TIP_THRESHOLD) this._promoteVip(recorded.tipperId, tip.tipperSession);

		this.broadcast('tip', {
			label: recorded.label,
			amount: recorded.amount,
			mint: recorded.mint,
			message: recorded.message,
			isNewTopTipper,
			explorer: tip.explorer || null,
			ts: recorded.ts,
		}, { afterNextPatch: false });

		// React fast: pre-empt the cadence with an immediate beat (it will resolve
		// to a TIP_SHOUTOUT for this fresh tip). Guarded so a tip storm coalesces
		// into one in-flight beat rather than stacking brain calls.
		this._runBeat('tip');
		return { ok: true, recorded: { label: recorded.label, amount: recorded.amount } };
	}

	_promoteVip(tipperId, sessionId) {
		// Match the tipper to a connected audience member by their session (passed
		// by the API when the tipper is in the room) or by display name as a fallback.
		for (const [sid, m] of this.state.audience) {
			if ((sessionId && sid === sessionId) || (!sessionId && m.name && m.name === tipperId)) {
				m.vip = true;
				return;
			}
		}
	}

	_syncLeaderboard() {
		const ranked = this._director.leaderboard(10);
		// Rebuild the ArraySchema in place (clear + push) — a small, capped list, so
		// a full rewrite each tip is cheaper than diffing and keeps order exact.
		this.state.leaderboard.length = 0;
		for (const t of ranked) {
			const row = new StageTipper();
			row.id = t.id;
			row.label = t.label;
			row.total = t.total;
			row.count = t.count;
			this.state.leaderboard.push(row);
		}
	}

	// ── the host loop ─────────────────────────────────────────────────────────
	async _runBeat(trigger) {
		if (this._beatRunning) return; // one beat in flight at a time
		// Don't perform to an empty room on the cadence — only a real trigger (a tip,
		// or the opener fired by the first arrival) speaks when nobody is present.
		if (trigger === 'cadence' && this.state.audience.size === 0) return;
		this._beatRunning = true;
		try {
			const beat = this._director.nextBeat();
			const context = this._buildContext(beat);
			const { text, cue } = await this._fetchBeat(beat, context);
			const words = clean(text, 600) || this._fallbackLine(beat);
			this._performUtterance(beat, words, cue);
			this._director.markSpoken(beat.kind);
		} catch (err) {
			console.warn(`${this._tag()} beat (${trigger}) failed: ${err?.message || err}`);
		} finally {
			this._beatRunning = false;
		}
	}

	_buildContext(beat) {
		const standings = this._director.standings();
		const ctx = {
			stageId: this.stageId,
			beat: beat.kind,
			hostName: this.state.host.name,
			title: this.state.title,
			format: this.state.format,
			audience: this.state.audience.size,
			standings,
		};
		if (beat.tip) {
			ctx.tip = {
				label: beat.tip.label,
				amount: beat.tip.amount,
				mint: beat.tip.mint,
				message: beat.tip.message,
			};
		}
		if (beat.question) ctx.question = { from: beat.question.from, text: beat.question.text };
		return ctx;
	}

	// Ask the brain (latest Claude, server-side at /api/stage/host) for the host's
	// next words. Signed with the shared secret so only this server can drive the
	// host. Returns { text, cue }; throws on transport/non-2xx so the caller's
	// fallback line keeps the show alive.
	async _fetchBeat(beat, context) {
		const body = { stageId: this.stageId, beat: beat.kind, context };
		const { ts, sig } = signStageRequest(body);
		const res = await fetch(`${API_BASE}/api/stage/host`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-stage-ts': String(ts),
				'x-stage-sig': sig,
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(20_000),
		});
		if (!res.ok) throw new Error(`host http ${res.status}`);
		const data = await res.json();
		return { text: data?.text || '', cue: data?.cue || cueFor(beat.kind) };
	}

	_performUtterance(beat, words, cue) {
		const h = this.state.host;
		h.utteranceId = (h.utteranceId + 1) % 0xffffffff;
		h.beat = beat.kind;
		h.caption = words;
		h.cue = cue || cueFor(beat.kind);
		h.speaking = true;
		h.startedAtMs = Date.now();
		if (this.state.phase === 'preshow') this.state.phase = 'live';

		const durationMs = Math.min(SPEAK_MAX_MS, Math.max(SPEAK_MIN_MS, words.length * SPEAK_ESTIMATE_MS));

		// The timed performance frame every client renders in sync: each fetches TTS
		// for `text` (spatial voice + lip-sync) and shows `text` as live captions.
		this.broadcast('utterance', {
			id: h.utteranceId,
			beat: beat.kind,
			text: words,
			voice: h.voice,
			cue: h.cue,
			durationMs,
			ts: h.startedAtMs,
		}, { afterNextPatch: false });

		if (this._speakTimer) this._speakTimer.clear();
		this._speakTimer = this.clock.setTimeout(() => {
			h.speaking = false;
			h.cue = 'idle';
		}, durationMs);
	}

	// Failsafe line when the brain is briefly unreachable — a real acknowledgement
	// of real show state, never invented data. Keeps the stage from going silent on
	// a transient outage; the next beat retries the brain.
	_fallbackLine(beat) {
		const name = this.state.host.name || 'your host';
		if (beat.kind === BEAT.TIP_SHOUTOUT && beat.tip) {
			return `Huge love to ${beat.tip.label} for the tip — you keep this stage alive!`;
		}
		if (beat.kind === BEAT.ANSWER && beat.question) {
			return `Good question from ${beat.question.from} — let me come back to that one.`;
		}
		if (beat.kind === BEAT.OPENER) return `Welcome in — ${name} on the stage. Pull up a seat.`;
		return `Stay with me — more coming up right now.`;
	}

	onDispose() {
		if (this._beatTimer) this._beatTimer.clear();
		if (this._speakTimer) this._speakTimer.clear();
		unregisterStage(this.stageId, this);
		console.log(`${this._tag()} disposed`);
	}
}

function cueFor(beatKind) {
	switch (beatKind) {
		case BEAT.TIP_SHOUTOUT: return 'cheer';
		case BEAT.ANSWER: return 'point';
		case BEAT.GAME: return 'dj';
		case BEAT.OPENER: return 'cheer';
		default: return 'talk';
	}
}

function clean(v, max) {
	if (typeof v !== 'string') return '';
	// Strip control characters (incl. newlines) then collapse whitespace, so no
	// multi-line or unprintable caller text reaches the synced caption or a prompt.
	return v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
