// Unit tests for the generic per-world persistence store (T3).
//
// The store's orchestration (size limits, content hashing, inline-vs-R2 routing,
// optimistic-concurrency conflict mapping, blob GC) is exercised against an
// in-memory backend that honours the same compare-and-set contract as the
// production Postgres+R2 backend. The service-token gate that keeps a browser
// from forging a server write is tested against api/_lib/world-service-auth.js.

import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import {
	createWorldStore,
	canWriteWorld,
	isValidWorldId,
	etagOf,
	ConflictError,
	TooLargeError,
	INLINE_MAX_BYTES,
	MAX_DOC_BYTES,
} from '../api/_lib/world-store.js';
import { verifyWorldServiceToken } from '../api/_lib/world-service-auth.js';

// In-memory backend mirroring the production CAS contract exactly: an INSERT
// happens only when no row exists (regardless of ifMatch); an UPDATE commits only
// when ifMatch is '*' or equals the stored etag — otherwise it reports no commit.
function makeBackend() {
	const rows = new Map();
	const blobs = new Map();
	let clock = 0;
	return {
		rows,
		blobs,
		async readRow(worldId) {
			return rows.has(worldId) ? { ...rows.get(worldId) } : null;
		},
		async readBlob(key) {
			if (!blobs.has(key)) throw new Error(`no such blob: ${key}`);
			return blobs.get(key);
		},
		async writeBlob(key, bytes) {
			blobs.set(key, Buffer.from(bytes));
		},
		async deleteBlob(key) {
			blobs.delete(key);
		},
		async upsert({ worldId, schemaVersion, etag, size, inlineDoc, r2Key, owner, writer, ifMatch }) {
			const existing = rows.get(worldId);
			if (existing) {
				const ok = ifMatch === '*' || existing.etag === ifMatch;
				if (!ok) return { committed: false };
				const row = {
					...existing,
					schema_version: schemaVersion,
					doc_version: existing.doc_version + 1,
					etag,
					size_bytes: size,
					inline_doc: inlineDoc,
					r2_key: r2Key,
					updated_by: writer,
					updated_at: ++clock,
				};
				rows.set(worldId, row);
				return { committed: true, version: row.doc_version, etag, ownerId: row.owner_id ?? null, updatedAt: row.updated_at };
			}
			const row = {
				world_id: worldId,
				schema_version: schemaVersion,
				doc_version: 1,
				etag,
				size_bytes: size,
				inline_doc: inlineDoc,
				r2_key: r2Key,
				owner_id: owner ?? null,
				updated_by: writer,
				updated_at: ++clock,
			};
			rows.set(worldId, row);
			return { committed: true, version: 1, etag, ownerId: row.owner_id, updatedAt: row.updated_at };
		},
		async remove(worldId) {
			if (!rows.has(worldId)) return false;
			const r2 = rows.get(worldId).r2_key;
			rows.delete(worldId);
			return r2;
		},
	};
}

describe('world-store: validation', () => {
	it('accepts mints, tier keys, and realm slugs; rejects junk', () => {
		expect(isValidWorldId('So11111111111111111111111111111111111111112')).toBe(true);
		expect(isValidWorldId('mint#holders')).toBe(true);
		expect(isValidWorldId('realm:wilderness')).toBe(true);
		expect(isValidWorldId('')).toBe(false);
		expect(isValidWorldId('has space')).toBe(false);
		expect(isValidWorldId('../etc/passwd')).toBe(false);
		expect(isValidWorldId('x'.repeat(129))).toBe(false);
	});

	it('etag is deterministic and content-sensitive', () => {
		const a = etagOf(Buffer.from('{"a":1}'));
		const b = etagOf(Buffer.from('{"a":1}'));
		const c = etagOf(Buffer.from('{"a":2}'));
		expect(a).toBe(b);
		expect(a).not.toBe(c);
	});
});

describe('world-store: round-trip + concurrency', () => {
	let backend;
	let store;
	beforeEach(() => {
		backend = makeBackend();
		store = createWorldStore(backend);
	});

	it('saves and restores an arbitrary JSON doc', async () => {
		expect(await store.loadWorld('coinA')).toBeNull();

		const doc = { objects: [{ id: 'o1', x: 3, y: 0, z: -2 }], theme: 'forest' };
		const saved = await store.saveWorld({ worldId: 'coinA', doc, writer: 'service' });
		expect(saved.version).toBe(1);
		expect(saved.etag).toMatch(/^[0-9a-f]{24}$/);

		const loaded = await store.loadWorld('coinA');
		expect(loaded.doc).toEqual(doc);
		expect(loaded.version).toBe(1);
		expect(loaded.etag).toBe(saved.etag);
	});

	it('bumps the version and etag on each successful save', async () => {
		const v1 = await store.saveWorld({ worldId: 'w', doc: { n: 1 }, writer: 's' });
		const v2 = await store.saveWorld({ worldId: 'w', doc: { n: 2 }, ifMatch: v1.etag, writer: 's' });
		expect(v2.version).toBe(2);
		expect(v2.etag).not.toBe(v1.etag);
		expect((await store.loadWorld('w')).doc).toEqual({ n: 2 });
	});

	it('rejects a stale write with ConflictError', async () => {
		const v1 = await store.saveWorld({ worldId: 'w', doc: { n: 1 }, writer: 's' });
		await store.saveWorld({ worldId: 'w', doc: { n: 2 }, ifMatch: v1.etag, writer: 's' });
		// v1.etag is now stale — a second writer holding it must lose.
		await expect(
			store.saveWorld({ worldId: 'w', doc: { n: 99 }, ifMatch: v1.etag, writer: 's' }),
		).rejects.toBeInstanceOf(ConflictError);
		expect((await store.loadWorld('w')).doc).toEqual({ n: 2 });
	});

	it('treats a create (ifMatch=null) against an existing world as a conflict', async () => {
		await store.saveWorld({ worldId: 'w', doc: { n: 1 }, writer: 's' });
		await expect(
			store.saveWorld({ worldId: 'w', doc: { n: 2 }, ifMatch: null, writer: 's' }),
		).rejects.toBeInstanceOf(ConflictError);
	});

	it('ifMatch="*" overwrites unconditionally', async () => {
		await store.saveWorld({ worldId: 'w', doc: { n: 1 }, writer: 's' });
		const forced = await store.saveWorld({ worldId: 'w', doc: { n: 42 }, ifMatch: '*', writer: 's' });
		expect(forced.version).toBe(2);
		expect((await store.loadWorld('w')).doc).toEqual({ n: 42 });
	});

	it('preserves the original owner across later saves', async () => {
		const a = await store.saveWorld({ worldId: 'w', doc: { n: 1 }, writer: 'alice', owner: 'alice' });
		expect(a.ownerId).toBe('alice');
		// A later save passing a different owner must not reassign ownership.
		const b = await store.saveWorld({ worldId: 'w', doc: { n: 2 }, ifMatch: a.etag, writer: 'alice', owner: 'mallory' });
		expect(b.ownerId).toBe('alice');
	});
});

describe('world-store: large-doc R2 offload', () => {
	let backend;
	let store;
	beforeEach(() => {
		backend = makeBackend();
		store = createWorldStore(backend);
	});

	it('offloads docs past the inline cap to a content-addressed blob and reads them back', async () => {
		const big = { blob: 'x'.repeat(INLINE_MAX_BYTES + 1024) };
		const saved = await store.saveWorld({ worldId: 'big', doc: big, writer: 's' });

		// Stored out-of-line: index row carries an r2_key, no inline doc.
		expect(backend.rows.get('big').inline_doc).toBeNull();
		expect(backend.rows.get('big').r2_key).toContain('worlds/big/');
		expect(backend.blobs.size).toBe(1);

		const loaded = await store.loadWorld('big');
		expect(loaded.doc).toEqual(big);
		expect(loaded.etag).toBe(saved.etag);
	});

	it('GCs the previous blob when a large doc is superseded', async () => {
		const v1 = await store.saveWorld({ worldId: 'big', doc: { blob: 'a'.repeat(INLINE_MAX_BYTES + 10) }, writer: 's' });
		const firstKey = backend.rows.get('big').r2_key;
		await store.saveWorld({ worldId: 'big', doc: { blob: 'b'.repeat(INLINE_MAX_BYTES + 10) }, ifMatch: v1.etag, writer: 's' });
		const secondKey = backend.rows.get('big').r2_key;

		expect(secondKey).not.toBe(firstKey);
		expect(backend.blobs.has(firstKey)).toBe(false); // old blob retired
		expect(backend.blobs.has(secondKey)).toBe(true);
		expect(backend.blobs.size).toBe(1);
	});

	it('rejects a doc larger than the hard cap with TooLargeError', async () => {
		const huge = { blob: 'x'.repeat(MAX_DOC_BYTES + 16) };
		await expect(store.saveWorld({ worldId: 'huge', doc: huge, writer: 's' })).rejects.toBeInstanceOf(TooLargeError);
		// Nothing partially persisted.
		expect(backend.rows.has('huge')).toBe(false);
		expect(backend.blobs.size).toBe(0);
	});
});

describe('world-store: deleteWorld', () => {
	it('removes the index row and any offloaded blob', async () => {
		const backend = makeBackend();
		const store = createWorldStore(backend);
		const v1 = await store.saveWorld({ worldId: 'big', doc: { blob: 'x'.repeat(INLINE_MAX_BYTES + 10) }, writer: 's' });
		expect(v1.version).toBe(1);
		expect(await store.deleteWorld('big')).toBe(true);
		expect(backend.rows.has('big')).toBe(false);
		expect(backend.blobs.size).toBe(0);
		expect(await store.deleteWorld('big')).toBe(false); // already gone
	});
});

describe('world-store: write permission model (T16 hook)', () => {
	it('the game server is always permitted', () => {
		expect(canWriteWorld({ isService: true, account: null, currentOwner: 'alice' })).toBe(true);
	});
	it('anonymous browsers can never write', () => {
		expect(canWriteWorld({ isService: false, account: null, currentOwner: null })).toBe(false);
	});
	it('the first writer may seed an unowned world; others are owner-gated', () => {
		expect(canWriteWorld({ isService: false, account: 'alice', currentOwner: null })).toBe(true);
		expect(canWriteWorld({ isService: false, account: 'alice', currentOwner: 'alice' })).toBe(true);
		expect(canWriteWorld({ isService: false, account: 'mallory', currentOwner: 'alice' })).toBe(false);
	});
});

describe('world-service-auth: only the multiplayer server can forge a service write', () => {
	const secret = process.env.MULTIPLAYER_SHARED_SECRET || process.env.HOLDER_PASS_SECRET || 'dev-insecure-multiplayer-secret';
	function sign(payloadObj, withSecret = secret) {
		const payload = Buffer.from(JSON.stringify(payloadObj), 'utf8').toString('base64url');
		const sig = crypto.createHmac('sha256', withSecret).update(payload).digest('base64url');
		return `${payload}.${sig}`;
	}
	const future = Math.floor(Date.now() / 1000) + 120;
	const past = Math.floor(Date.now() / 1000) - 10;

	it('accepts a valid, unexpired world token', async () => {
		expect(await verifyWorldServiceToken(sign({ svc: 'world', exp: future }))).toEqual({ svc: 'world' });
	});
	it('rejects an expired token', async () => {
		expect(await verifyWorldServiceToken(sign({ svc: 'world', exp: past }))).toBeNull();
	});
	it('rejects a token for a different service', async () => {
		expect(await verifyWorldServiceToken(sign({ svc: 'presence', exp: future }))).toBeNull();
	});
	it('rejects a token signed with the wrong secret', async () => {
		expect(await verifyWorldServiceToken(sign({ svc: 'world', exp: future }, 'not-the-secret'))).toBeNull();
	});
	it('rejects a tampered signature and outright garbage', async () => {
		const tok = sign({ svc: 'world', exp: future });
		const tampered = tok.slice(0, -1) + (tok.endsWith('A') ? 'B' : 'A');
		expect(await verifyWorldServiceToken(tampered)).toBeNull();
		expect(await verifyWorldServiceToken('nope')).toBeNull();
		expect(await verifyWorldServiceToken('')).toBeNull();
		expect(await verifyWorldServiceToken(null)).toBeNull();
	});
});
