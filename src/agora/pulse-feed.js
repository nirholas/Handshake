// Pulse feed — the heartbeat that drives the Commons economy visuals.
//
// Polls the two real, agora-specific read endpoints and turns them into a small
// event stream the job board, ticker and economy FX subscribe to:
//   • /api/agora/board  → open tasks + x402 services (job-board markers)
//   • /api/agora/pulse  → population, 24h economy, top earners, recent narration
//
// Discipline the DoD asks for:
//   • De-dupe by activity id. The FIRST pulse seeds the "seen" set silently so we
//     don't replay history as fresh events (no phantom plinth on page load); only
//     genuinely new activities after that emit `activity` (→ claim-walks,
//     completions). The full recent list still ships as `pulse` for the ticker.
//   • Exponential backoff on failure (per resource), capped, with jitter.
//   • Pause entirely while the tab is hidden (visibilitychange); refresh
//     immediately on return so an away-then-back user sees current state, not a
//     stale frame, and we never poll — or thrash the GPU — in the background.
//
// SSE note: api/feed-stream.js is the *platform-wide* feed; the agora narration
// is only a projection within it and isn't id-addressable per citizen, so a
// short, deduped poll of the agora-specific endpoints is the honest, robust
// source. The interface here is event-based so a future agora SSE can replace
// the poller without touching a single consumer.

const DEFAULTS = {
	pulseInterval: 5000,    // ms between pulse polls when healthy
	boardInterval: 12000,   // ms between board polls when healthy
	maxBackoff: 60000,      // ceiling for failed-poll backoff
	fetchTimeout: 12000,    // per-request abort timeout
	seenCap: 600,           // bounded de-dupe memory
};

export class PulseFeed {
	constructor(opts = {}) {
		this.opts = { ...DEFAULTS, ...opts };
		this._listeners = new Map();   // type → Set<fn>
		this._timers = { pulse: null, board: null };
		// One request per resource at a time. A visibility change or a refreshNow()
		// used to open a second poll alongside a slow one, and the newcomer's abort
		// timeout killed the request already on the wire: an aborted fetch that read
		// as a failure even though the data was arriving fine.
		this._inFlight = { pulse: false, board: false };
		this._backoff = { pulse: 0, board: 0 };
		this._seen = new Set();
		this._seenOrder = [];
		this._seeded = false;
		this._running = false;
		this._lastPulse = null;
		this._lastBoard = null;
		this._onVisibility = this._handleVisibility.bind(this);
	}

	on(type, fn) {
		if (!this._listeners.has(type)) this._listeners.set(type, new Set());
		this._listeners.get(type).add(fn);
		return () => this._listeners.get(type)?.delete(fn);
	}

	_emit(type, payload) {
		const set = this._listeners.get(type);
		if (!set) return;
		for (const fn of set) {
			try { fn(payload); } catch (err) { console.warn(`[agora] feed listener (${type}) threw:`, err?.message); }
		}
	}

	start() {
		if (this._running) return;
		this._running = true;
		document.addEventListener('visibilitychange', this._onVisibility);
		if (!document.hidden) {
			this._poll('pulse');
			this._poll('board');
		}
	}

	stop() {
		this._running = false;
		document.removeEventListener('visibilitychange', this._onVisibility);
		for (const k of Object.keys(this._timers)) {
			if (this._timers[k]) { clearTimeout(this._timers[k]); this._timers[k] = null; }
		}
		this._listeners.clear();
	}

	// Force an immediate refresh of both resources (e.g. after returning to tab).
	refreshNow() {
		if (!this._running || document.hidden) return;
		this._poll('pulse', true);
		this._poll('board', true);
	}

	_handleVisibility() {
		if (document.hidden) {
			for (const k of Object.keys(this._timers)) {
				if (this._timers[k]) { clearTimeout(this._timers[k]); this._timers[k] = null; }
			}
		} else if (this._running) {
			this._poll('pulse', true);
			this._poll('board', true);
		}
	}

	_schedule(resource) {
		if (!this._running || document.hidden) return;
		if (this._timers[resource]) clearTimeout(this._timers[resource]);
		const base = resource === 'pulse' ? this.opts.pulseInterval : this.opts.boardInterval;
		const backoff = this._backoff[resource];
		const delay = backoff > 0
			? Math.min(this.opts.maxBackoff, backoff) + Math.random() * 1000
			: base + Math.random() * 600;
		this._timers[resource] = setTimeout(() => this._poll(resource), delay);
	}

	async _poll(resource, immediate = false) {
		if (!this._running || document.hidden) return;
		// A poll already on the wire owns this resource; it will deliver and
		// reschedule. Opening a second one only aborts the first.
		if (this._inFlight[resource]) return;
		if (immediate && this._timers[resource]) { clearTimeout(this._timers[resource]); this._timers[resource] = null; }
		this._inFlight[resource] = true;

		const url = resource === 'pulse'
			? '/api/agora/pulse'
			: '/api/agora/board?maxItems=60';

		const controller = new AbortController();
		const to = setTimeout(() => controller.abort(), this.opts.fetchTimeout);
		try {
			const res = await fetch(url, { headers: { accept: 'application/json' }, signal: controller.signal });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			this._backoff[resource] = 0;
			if (resource === 'pulse') this._handlePulse(data);
			else this._handleBoard(data);
		} catch (err) {
			// Grow backoff: 2s → 4s → … → maxBackoff. Surface once for observability.
			const next = this._backoff[resource] ? this._backoff[resource] * 2 : 2000;
			this._backoff[resource] = Math.min(this.opts.maxBackoff, next);
			this._emit('error', { resource, error: err?.message || 'poll_failed', backoff: this._backoff[resource] });
		} finally {
			clearTimeout(to);
			this._inFlight[resource] = false;
			this._schedule(resource);
		}
	}

	_markSeen(id) {
		this._seen.add(id);
		this._seenOrder.push(id);
		if (this._seenOrder.length > this.opts.seenCap) {
			const drop = this._seenOrder.shift();
			this._seen.delete(drop);
		}
	}

	_handlePulse(data) {
		this._lastPulse = data;
		this._emit('pulse', data);

		const recent = Array.isArray(data?.recent) ? data.recent : [];
		if (!this._seeded) {
			// Seed silently — these are history, not live events.
			for (const a of recent) if (a?.id != null) this._markSeen(a.id);
			this._seeded = true;
			return;
		}
		// Oldest-first so consumers process activities in chronological order.
		for (let i = recent.length - 1; i >= 0; i--) {
			const a = recent[i];
			if (a?.id == null || this._seen.has(a.id)) continue;
			this._markSeen(a.id);
			this._emit('activity', a);
		}
	}

	_handleBoard(data) {
		this._lastBoard = data;
		this._emit('board', data);
	}
}
