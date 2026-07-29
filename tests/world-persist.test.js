// P3.1 — the browser's half of the durable per-world build store.
//
// These lock the invariants that decide whether a community's build survives:
// the world key must match WalkRoom's byte-for-byte, the client must never write
// while the authoritative room holds the pen, a 409 must MERGE rather than
// clobber, and a permission refusal must be terminal and reported (never a
// silent retry loop that tells the player their work is saved when it isn't).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WorldBuildStore, worldIdForCoin, docObjects, WORLD_SAVE_DEBOUNCE_MS } from '../src/game/world-persist.js';

const MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump'; // $THREE

function jsonResponse(status, body) {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
	};
}

// A fetch stand-in that records every call and replies from a queue.
function fakeFetch(replies) {
	const calls = [];
	const fn = vi.fn(async (url, init) => {
		calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : null });
		const next = replies.shift();
		if (typeof next === 'function') return next(url, init);
		if (next instanceof Error) throw next;
		return next ?? jsonResponse(200, { etag: 'e', version: 1 });
	});
	fn.calls = calls;
	return fn;
}

describe('worldIdForCoin', () => {
	it('mirrors WalkRoom.worldKey for every tier', () => {
		expect(worldIdForCoin(MINT)).toBe(MINT);
		expect(worldIdForCoin(MINT, 'holders')).toBe(`${MINT}#holders`);
		expect(worldIdForCoin('', '')).toBe('mainland');
		expect(worldIdForCoin('  ')).toBe('mainland');
	});
});

describe('docObjects', () => {
	it('keeps well-formed rows and drops the rest', () => {
		const objects = docObjects({
			objects: [
				{ id: 'a', x: 1, y: 0, z: 2, type: 'crate' },
				{ id: '', x: 0, y: 0, z: 0 },                 // no id
				{ id: 'b', x: NaN, y: 0, z: 0 },              // NaN position
				{ id: 'c', x: 0, y: 0, z: 0, scale: -3 },     // bad scale is normalised
				'nonsense',
			],
		});
		expect(objects.map((o) => o.id)).toEqual(['a', 'c']);
		expect(objects[0]).toMatchObject({ kind: 'prop', yaw: 0, scale: 1, url: '' });
		expect(objects[1].scale).toBe(1);
	});

	it('never throws on a malformed doc', () => {
		expect(docObjects(null)).toEqual([]);
		expect(docObjects({})).toEqual([]);
		expect(docObjects({ objects: 'nope' })).toEqual([]);
	});
});

describe('WorldBuildStore', () => {
	beforeEach(() => { vi.useFakeTimers(); });
	afterEach(() => { vi.useRealTimers(); });

	it('loads a world doc and remembers its etag for the next write', async () => {
		const fetchImpl = fakeFetch([jsonResponse(200, { doc: { objects: [] }, etag: 'v1', version: 3, ownerId: 'u1' })]);
		const store = new WorldBuildStore({ worldId: MINT, fetchImpl });
		const res = await store.load();
		expect(res.error).toBeNull();
		expect(store.etag).toBe('v1');
		expect(store.version).toBe(3);
		expect(store.ownerId).toBe('u1');
		expect(fetchImpl.calls[0].url).toContain(`worldId=${encodeURIComponent(MINT)}`);
	});

	it('resolves with doc:null (never throws) when the read fails', async () => {
		const store = new WorldBuildStore({ worldId: MINT, fetchImpl: fakeFetch([new Error('offline')]) });
		const res = await store.load();
		expect(res.doc).toBeNull();
		expect(res.error).toBe('offline');
	});

	it('coalesces a burst of edits into one debounced write', async () => {
		const fetchImpl = fakeFetch([jsonResponse(200, { etag: 'v2', version: 4 })]);
		const store = new WorldBuildStore({ worldId: MINT, fetchImpl });
		store.queueSave(() => ({ objects: [{ id: 'a' }] }));
		store.queueSave(() => ({ objects: [{ id: 'a' }, { id: 'b' }] }));
		store.queueSave(() => ({ objects: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }));
		expect(fetchImpl).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(WORLD_SAVE_DEBOUNCE_MS + 1);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		// The LAST producer wins: the write carries the freshest state, not the first.
		expect(fetchImpl.calls[0].body.doc.objects).toHaveLength(3);
		expect(store.etag).toBe('v2');
	});

	it('sends the etag it read as ifMatch', async () => {
		const fetchImpl = fakeFetch([
			jsonResponse(200, { doc: null, etag: 'v9', version: 1 }),
			jsonResponse(200, { etag: 'v10', version: 2 }),
		]);
		const store = new WorldBuildStore({ worldId: MINT, fetchImpl });
		await store.load();
		store.queueSave(() => ({ objects: [] }));
		await store.flush();
		expect(fetchImpl.calls[1].body.ifMatch).toBe('v9');
	});

	it('merges rather than clobbers on a 409: re-reads, re-runs the producer, retries', async () => {
		const fetchImpl = fakeFetch([
			jsonResponse(409, { message: 'conflict' }),
			jsonResponse(200, { doc: { objects: [{ id: 'theirs', x: 0, y: 0, z: 0 }] }, etag: 'v5', version: 7 }),
			jsonResponse(200, { etag: 'v6', version: 8 }),
		]);
		const store = new WorldBuildStore({ worldId: MINT, fetchImpl });
		// A real merging producer: keep whatever the freshest doc holds, add ours.
		store.queueSave((base) => ({ objects: [...docObjects(base), { id: 'mine', x: 1, y: 0, z: 1 }] }));
		const outcome = await store.flush();
		expect(outcome).toBe('ok');
		const finalWrite = fetchImpl.calls[2].body.doc.objects.map((o) => o.id);
		expect(finalWrite).toEqual(['theirs', 'mine']);
		expect(fetchImpl.calls[2].body.ifMatch).toBe('v5');
	});

	it('treats a 401 as terminal, reports it once, and stops writing', async () => {
		const onDenied = vi.fn();
		const fetchImpl = fakeFetch([jsonResponse(401, { message: 'authentication required' })]);
		const store = new WorldBuildStore({ worldId: MINT, fetchImpl, onDenied });
		store.queueSave(() => ({ objects: [] }));
		expect(await store.flush()).toBe('denied');
		expect(onDenied).toHaveBeenCalledWith(expect.objectContaining({ reason: 'signin', status: 401 }));
		expect(store.writable).toBe(false);
		// Further edits must not queue another doomed request.
		store.queueSave(() => ({ objects: [{ id: 'x' }] }));
		await vi.advanceTimersByTimeAsync(WORLD_SAVE_DEBOUNCE_MS + 1);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it('reports a 403 as an ownership refusal, not a sign-in prompt', async () => {
		const onDenied = vi.fn();
		const store = new WorldBuildStore({
			worldId: MINT, onDenied,
			fetchImpl: fakeFetch([jsonResponse(403, { message: 'not permitted' })]),
		});
		store.queueSave(() => ({ objects: [] }));
		await store.flush();
		expect(onDenied).toHaveBeenCalledWith(expect.objectContaining({ reason: 'owner', status: 403 }));
	});

	it('surfaces a 413 as a size error without going terminal', async () => {
		const onError = vi.fn();
		const store = new WorldBuildStore({
			worldId: MINT, onError,
			fetchImpl: fakeFetch([jsonResponse(413, { message: 'too large' })]),
		});
		store.queueSave(() => ({ objects: [] }));
		expect(await store.flush()).toBe('too_large');
		expect(onError).toHaveBeenCalledWith(expect.objectContaining({ reason: 'too_large' }));
		expect(store.writable).toBe(true);
	});

	it('writes nothing while disarmed — the authoritative room owns the doc', async () => {
		const fetchImpl = fakeFetch([]);
		const store = new WorldBuildStore({ worldId: MINT, fetchImpl });
		store.setArmed(false);
		store.queueSave(() => ({ objects: [{ id: 'a' }] }));
		await vi.advanceTimersByTimeAsync(WORLD_SAVE_DEBOUNCE_MS * 2);
		expect(await store.flush()).toBe('idle');
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('drops a pending debounce when the room takes over mid-burst', async () => {
		const fetchImpl = fakeFetch([]);
		const store = new WorldBuildStore({ worldId: MINT, fetchImpl });
		store.queueSave(() => ({ objects: [{ id: 'a' }] }));
		expect(store.pending).toBe(true);
		store.setArmed(false);
		await vi.advanceTimersByTimeAsync(WORLD_SAVE_DEBOUNCE_MS * 2);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('does not double-post when flush races the debounce timer', async () => {
		const fetchImpl = fakeFetch([jsonResponse(200, { etag: 'v2', version: 2 })]);
		const store = new WorldBuildStore({ worldId: MINT, fetchImpl });
		store.queueSave(() => ({ objects: [] }));
		const [a, b] = await Promise.all([store.flush(), store.flush()]);
		expect([a, b]).toEqual(['ok', 'ok']);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it('stops writing after dispose', async () => {
		const fetchImpl = fakeFetch([]);
		const store = new WorldBuildStore({ worldId: MINT, fetchImpl });
		store.queueSave(() => ({ objects: [] }));
		store.dispose();
		await vi.advanceTimersByTimeAsync(WORLD_SAVE_DEBOUNCE_MS * 2);
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});
