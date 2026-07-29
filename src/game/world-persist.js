// world-persist: the browser's half of the per-world build store (P3.1).
//
// `/play` builds into two different authorities depending on the connection:
//
//   • ONLINE (a live `walk_world` room). The Colyseus room is authoritative for
//     every object and writes the durable doc itself with a service token
//     (multiplayer/src/persistence.js → /api/world/save). The browser must NOT
//     write in this mode (two writers on one doc is how builds get clobbered),
//     so this module is only ever armed while the room is not the authority.
//
//   • SOLO / PRE-JOIN (the room is unreachable, or we're still connecting). The
//     world's persisted build is still a real, shared place: this module reads it
//     straight from the same store (GET /api/world/load) so the player walks into
//     the community's creation instead of an empty plaza, and writes back through
//     POST /api/world/save with the etag it read, so a build made offline survives
//     and shows up for everyone the next time the room boots.
//
// Concurrency is the store's own optimistic-etag model: we send the etag we last
// read as `ifMatch`; a 409 means someone else moved the doc, so we re-read and
// re-run the producer against the FRESH doc (the producer merges: it never
// blindly overwrites) and commit once more. Permission failures (401 anonymous,
// 403 not this world's owner) are terminal for the session and reported through
// `onDenied` so the HUD can stop promising the build is saved.
//
// Storage contract, kept identical to the server's so both writers agree:
//   doc = { objects: [ { id, type, kind, ownerId, x, y, z, yaw, scale, url? } ] }

import { log } from '../shared/log.js';

// Matches SAVE_DEBOUNCE_MS in multiplayer/src/persistence.js: a burst of
// placements coalesces into one write, exactly like the server's.
export const WORLD_SAVE_DEBOUNCE_MS = 4000;

/**
 * The store key for a coin world. Mirrors WalkRoom's `worldKey` byte-for-byte
 * (multiplayer/src/rooms/WalkRoom.js) so the browser and the room read and write
 * the SAME document: a different key here would silently fork the build.
 * @param {string} mint coin mint address, '' for the mainland world
 * @param {string} [tier] 'holders' for a coin's gated tier
 */
export function worldIdForCoin(mint, tier = '') {
	const coin = typeof mint === 'string' ? mint.trim() : '';
	if (!coin) return 'mainland';
	return tier === 'holders' ? `${coin}#holders` : coin;
}

/** Objects out of a loaded doc, shape-checked. Never throws on a malformed doc. */
export function docObjects(doc) {
	const list = Array.isArray(doc?.objects) ? doc.objects : [];
	const out = [];
	for (const o of list) {
		if (!o || typeof o.id !== 'string' || !o.id) continue;
		if (![o.x, o.y, o.z].every((n) => Number.isFinite(n))) continue;
		out.push({
			id: o.id,
			type: typeof o.type === 'string' ? o.type : '',
			kind: typeof o.kind === 'string' && o.kind ? o.kind : 'prop',
			ownerId: typeof o.ownerId === 'string' ? o.ownerId : '',
			x: o.x, y: o.y, z: o.z,
			yaw: Number.isFinite(o.yaw) ? o.yaw : 0,
			scale: Number.isFinite(o.scale) && o.scale > 0 ? o.scale : 1,
			url: typeof o.url === 'string' ? o.url : '',
		});
	}
	return out;
}

// Turn a save response into the one word the caller needs to act on.
function outcomeOf(status) {
	if (status >= 200 && status < 300) return 'ok';
	if (status === 409) return 'conflict';
	if (status === 401 || status === 403) return 'denied';
	if (status === 413) return 'too_large';
	return 'error';
}

/**
 * A single world's durable document, as seen from the browser.
 *
 * Lifecycle: `load()` once on entering the world, `queueSave(produce)` on every
 * change while this client is the writer, `flush()` before the tab goes away,
 * `dispose()` on leaving the world.
 */
export class WorldBuildStore {
	/**
	 * @param {object} opts
	 * @param {string} opts.worldId
	 * @param {typeof fetch} [opts.fetchImpl] injectable for tests
	 * @param {number} [opts.debounceMs]
	 * @param {(info:{reason:string,status:number,message:string})=>void} [opts.onDenied]
	 * @param {(info:{reason:string,status:number})=>void} [opts.onError]
	 * @param {()=>void} [opts.onSaved]
	 */
	constructor({ worldId, fetchImpl, debounceMs = WORLD_SAVE_DEBOUNCE_MS, onDenied, onError, onSaved } = {}) {
		this.worldId = worldId;
		this._fetch = fetchImpl || ((...a) => fetch(...a));
		this._debounceMs = debounceMs;
		this._onDenied = onDenied || null;
		this._onError = onError || null;
		this._onSaved = onSaved || null;
		this.etag = null;
		this.version = 0;
		this.ownerId = null;
		this.doc = null;
		// Terminal for this session once the store refuses our identity: retrying a
		// 403 on every placement would spam the API and lie to the player twice.
		this.denied = false;
		this.lastError = null;
		this._produce = null;
		this._timer = null;
		this._inFlight = null;
		this._disposed = false;
		// Armed = this client is the writer. Disarmed the moment an authoritative
		// room takes over (it writes the same doc with a service token), so the two
		// never race each other over one document.
		this._armed = true;
	}

	get armed() { return this._armed; }

	/**
	 * Hand the pen over, or take it back. Disarming drops any pending debounce
	 * without writing: the room that just took authority has the same objects and
	 * will persist them itself.
	 */
	setArmed(on) {
		this._armed = !!on;
		if (!this._armed && this._timer) { clearTimeout(this._timer); this._timer = null; }
	}

	/** Has a real round-trip proven this client can write? Drives the HUD badge. */
	get writable() { return !this.denied; }

	/**
	 * Read the world's current document. Never throws: a network failure resolves
	 * with `doc: null` and an `error` so the caller can render the offline state
	 * instead of a broken world.
	 * @returns {Promise<{doc:object|null, etag:string|null, version:number, error:string|null}>}
	 */
	async load() {
		const url = `/api/world/load?worldId=${encodeURIComponent(this.worldId)}`;
		try {
			const res = await this._fetch(url, { headers: { accept: 'application/json' } });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const body = await res.json();
			this.etag = body.etag ?? null;
			this.version = Number(body.version) || 0;
			this.ownerId = body.ownerId ?? null;
			this.doc = body.doc ?? null;
			this.lastError = null;
			return { doc: this.doc, etag: this.etag, version: this.version, error: null };
		} catch (err) {
			const message = err?.message || 'load failed';
			this.lastError = message;
			log.warn('[world-persist] load failed', this.worldId, message);
			return { doc: null, etag: null, version: 0, error: message };
		}
	}

	/**
	 * Record the producer for this world and arm a debounced durable write.
	 * Synchronous so a placement never awaits the network.
	 * @param {(base:object|null)=>object} produce called at flush time with the
	 *   freshest known doc; must MERGE onto it and return the doc to save.
	 */
	queueSave(produce) {
		if (typeof produce !== 'function') {
			throw new TypeError('WorldBuildStore.queueSave(produce): produce must be a function returning the doc');
		}
		if (this._disposed || this.denied || !this._armed) return;
		this._produce = produce;
		if (this._timer) return;
		this._timer = setTimeout(() => { this._timer = null; this.flush().catch(() => {}); }, this._debounceMs);
	}

	/** Is a write pending (debounce armed or in flight)? */
	get pending() { return !!this._timer || !!this._inFlight; }

	/**
	 * Write the current doc now. Safe to call at any time; coalesces with an
	 * in-flight write so a flush during a save doesn't double-post.
	 * @returns {Promise<'ok'|'conflict'|'denied'|'too_large'|'error'|'idle'>}
	 */
	async flush() {
		if (this._timer) { clearTimeout(this._timer); this._timer = null; }
		if (this._disposed || this.denied || !this._armed || !this._produce) return 'idle';
		if (this._inFlight) return this._inFlight;
		this._inFlight = this._flushOnce().finally(() => { this._inFlight = null; });
		return this._inFlight;
	}

	async _flushOnce() {
		// Two attempts: the second runs the producer against a freshly-read doc, so
		// a concurrent writer's props are merged in rather than overwritten.
		for (let attempt = 0; attempt < 2; attempt++) {
			const doc = this._produce(this.doc);
			const outcome = await this._post(doc);
			if (outcome === 'ok') { this.doc = doc; this._onSaved?.(); return 'ok'; }
			if (outcome === 'conflict' && attempt === 0) { await this.load(); continue; }
			return outcome;
		}
		return 'conflict';
	}

	async _post(doc) {
		let res;
		try {
			res = await this._fetch('/api/world/save', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify({ worldId: this.worldId, doc, ifMatch: this.etag ?? null }),
			});
		} catch (err) {
			this.lastError = err?.message || 'network error';
			this._onError?.({ reason: 'network', status: 0 });
			return 'error';
		}
		const outcome = outcomeOf(res.status);
		let body = null;
		try { body = await res.json(); } catch { /* empty or non-JSON body */ }

		if (outcome === 'ok') {
			this.etag = body?.etag ?? this.etag;
			this.version = Number(body?.version) || this.version;
			this.lastError = null;
			return 'ok';
		}
		if (outcome === 'denied') {
			this.denied = true;
			this.lastError = body?.message || 'not permitted to build in this world';
			this._onDenied?.({
				reason: res.status === 401 ? 'signin' : 'owner',
				status: res.status,
				message: this.lastError,
			});
			return 'denied';
		}
		if (outcome === 'too_large') {
			this.lastError = body?.message || 'this world is full';
			this._onError?.({ reason: 'too_large', status: res.status });
			return 'too_large';
		}
		if (outcome === 'conflict') return 'conflict';
		this.lastError = body?.message || `HTTP ${res.status}`;
		this._onError?.({ reason: 'server', status: res.status });
		return 'error';
	}

	/** Stop writing. Any armed debounce is dropped; call flush() first to keep it. */
	dispose() {
		this._disposed = true;
		if (this._timer) { clearTimeout(this._timer); this._timer = null; }
		this._produce = null;
	}
}
