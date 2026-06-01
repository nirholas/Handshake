// WorldPersistence — generic per-world JSON persistence for Colyseus rooms (T3).
//
// Rooms that need durable, non-voxel world state (placed props, gated-world pass
// rosters, mutable realm layout) use this instead of the voxel-specific
// block-store. A room typically:
//
//   import { worldPersistence } from '../persistence.js';
//   // onCreate:
//   const { doc, etag } = await worldPersistence.load(this.worldKey);
//   if (doc) this.restoreFrom(doc);
//   // on change:
//   worldPersistence.save(this.worldKey, () => this.snapshot());  // debounced
//   // onDispose:
//   await worldPersistence.flush(this.worldKey);
//
// Durable storage lives in the Vercel API (api/world/[action] → Postgres index +
// R2 blob). This process keeps only a memory mirror + the last-seen etag for
// optimistic concurrency, and signs a short-lived service token per request so
// the API trusts the write. The token format is mirrored byte-for-byte by the
// API verifier (api/_lib/world-service-auth.js).
//
// Two tiers, like block-store:
//   1. In-process memory — the latest doc-producer + last doc, so a re-created
//      room rehydrates instantly and a brief API outage doesn't lose the build.
//   2. The persistence API — survives this process dying / redeploying.

import crypto from 'node:crypto';

const API_BASE = (process.env.WORLD_API_BASE || 'https://three.ws').replace(/\/$/, '');
const SAVE_DEBOUNCE_MS = 4000;
const TOKEN_TTL_SEC = 120;

function secret() {
	return (
		process.env.MULTIPLAYER_SHARED_SECRET ||
		process.env.HOLDER_PASS_SECRET ||
		'dev-insecure-multiplayer-secret'
	);
}

// base64url(JSON{svc:'world',exp}).base64url(HMAC). Mirrors presence-token.js.
function signServiceToken() {
	const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_SEC;
	const payload = Buffer.from(JSON.stringify({ svc: 'world', exp }), 'utf8').toString('base64url');
	const sig = crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
	return `${payload}.${sig}`;
}

class WorldPersistence {
	constructor() {
		// worldId → { produce: () => doc, lastDoc, etag, version, dirty }
		this._mem = new Map();
		this._timers = new Map();
		// Flips true after a verified API round-trip; a room reads it to honestly
		// tell builders whether their work survives a restart.
		this._durable = false;
		this._warnedUnconfigured = false;
	}

	get durable() {
		return this._durable;
	}

	_entry(worldId) {
		let e = this._mem.get(worldId);
		if (!e) {
			e = { produce: null, lastDoc: null, etag: null, version: 0, dirty: false };
			this._mem.set(worldId, e);
		}
		return e;
	}

	// Load a world's current doc from the API, falling back to the in-memory
	// mirror if the network read fails. Returns { doc, etag, version }.
	async load(worldId) {
		const e = this._entry(worldId);
		try {
			const res = await fetch(`${API_BASE}/api/world/load?worldId=${encodeURIComponent(worldId)}`, {
				headers: { accept: 'application/json' },
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const body = await res.json();
			e.etag = body.etag ?? null;
			e.version = body.version ?? 0;
			e.lastDoc = body.doc ?? null;
			this._durable = true;
			return { doc: e.lastDoc, etag: e.etag, version: e.version };
		} catch (err) {
			// Memory tier: a re-created room in the same process still rehydrates.
			console.warn(`[world-persistence] load failed for ${worldId}: ${err?.message} — using memory mirror`);
			return { doc: e.lastDoc, etag: e.etag, version: e.version };
		}
	}

	// Record the latest doc producer and schedule a debounced durable write.
	// Synchronous so callers don't await on the hot path of an edit. `produce` is
	// called at flush time so the most recent state is what lands.
	save(worldId, produce) {
		if (typeof produce !== 'function') {
			throw new TypeError('worldPersistence.save(worldId, produce): produce must be a function returning the doc');
		}
		const e = this._entry(worldId);
		e.produce = produce;
		e.dirty = true;
		this._schedule(worldId);
	}

	_schedule(worldId) {
		if (this._timers.has(worldId)) return;
		const handle = setTimeout(() => {
			this._timers.delete(worldId);
			this.flush(worldId).catch(() => {});
		}, SAVE_DEBOUNCE_MS);
		if (typeof handle.unref === 'function') handle.unref();
		this._timers.set(worldId, handle);
	}

	// Write the current world doc to the API now. Called by the debounce timer and
	// on room dispose so the final state always lands.
	async flush(worldId) {
		const pending = this._timers.get(worldId);
		if (pending) {
			clearTimeout(pending);
			this._timers.delete(worldId);
		}
		const e = this._mem.get(worldId);
		if (!e || !e.dirty || !e.produce) return;

		const doc = e.produce();
		e.lastDoc = doc;

		// One retry: if a concurrent writer moved the etag, re-read it and
		// overwrite (a single always-on instance owns each world, so last-writer-
		// wins is the right policy here rather than a merge).
		for (let attempt = 0; attempt < 2; attempt++) {
			const outcome = await this._postSave(worldId, doc, e.etag);
			if (outcome === 'ok') {
				e.dirty = false;
				return;
			}
			if (outcome === 'conflict' && attempt === 0) {
				const fresh = await this.load(worldId);
				e.etag = fresh.etag;
				continue;
			}
			return; // network/other error or repeated conflict — keep dirty, retry next change
		}
	}

	async _postSave(worldId, doc, ifMatch) {
		try {
			const res = await fetch(`${API_BASE}/api/world/save`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${signServiceToken()}`,
				},
				body: JSON.stringify({ worldId, doc, ifMatch: ifMatch ?? null }),
			});
			if (res.ok) {
				const body = await res.json();
				const e = this._entry(worldId);
				e.etag = body.etag ?? e.etag;
				e.version = body.version ?? e.version;
				this._durable = true;
				return 'ok';
			}
			if (res.status === 409) return 'conflict';
			if (res.status === 401 || res.status === 403) {
				if (!this._warnedUnconfigured) {
					this._warnedUnconfigured = true;
					console.error(
						`[world-persistence] save rejected (${res.status}) — set MULTIPLAYER_SHARED_SECRET to match the API, or worlds are MEMORY-ONLY.`,
					);
				}
				this._durable = false;
				return 'error';
			}
			console.warn(`[world-persistence] save for ${worldId} failed: HTTP ${res.status}`);
			this._durable = false;
			return 'error';
		} catch (err) {
			console.warn(`[world-persistence] save for ${worldId} failed: ${err?.message}`);
			this._durable = false;
			return 'error';
		}
	}

	// Flush every dirty world. Call on SIGTERM (redeploy) so edits whose debounce
	// hasn't fired aren't lost.
	async flushAll() {
		await Promise.allSettled([...this._mem.keys()].map((id) => this.flush(id)));
	}
}

// One store shared by every room in the process — that shared memory is what lets
// a build outlive its room between disposal and the next join.
export const worldPersistence = new WorldPersistence();
