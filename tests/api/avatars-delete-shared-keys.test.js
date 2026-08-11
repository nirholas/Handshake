// Tests for deleteAvatar's R2 cleanup: the reference check that keeps a
// soft-deleted copy from blanking the live avatar it shares objects with.
//
// A copy, remix or forge variant reuses the source avatar's storage_key and
// thumbnail_key rather than duplicating the bytes, so deleting objects by key
// alone used to 404 live avatars' models and thumbnails. DB and R2 are mocked
// so the suite runs offline.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const sqlState = {
	deletedRow: { storage_key: 'u/user-1/orbit.glb', thumbnail_key: 'thumb/orbit.png' },
	// Keys some OTHER live avatar row still points at.
	stillReferenced: [],
	refCheckError: null,
};

vi.mock('../../api/_lib/db.js', () => ({
	sql: vi.fn(async (strings) => {
		const text = Array.isArray(strings) ? strings.join('?') : String(strings);
		if (/update avatars set deleted_at/i.test(text)) {
			return sqlState.deletedRow ? [sqlState.deletedRow] : [];
		}
		if (/select storage_key/i.test(text)) {
			if (sqlState.refCheckError) throw sqlState.refCheckError;
			return sqlState.stillReferenced.map((k) => ({ k }));
		}
		return [];
	}),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

const deleteObject = vi.fn(async () => {});
vi.mock('../../api/_lib/r2.js', () => ({
	deleteObject: (...a) => deleteObject(...a),
	publicUrl: (key) => `https://cdn.test/${key}`,
	thumbnailUrl: (key) => `https://cdn.test/${key}`,
	presignGet: async (key) => `https://cdn.test/${key}?signed`,
}));

const { deleteAvatar } = await import('../../api/_lib/avatars.js');

// deleteAvatar schedules its cleanup on a microtask that then awaits the DB, so
// give the queue a few turns before asserting on the bucket calls.
const settle = async () => {
	for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('deleteAvatar object cleanup', () => {
	beforeEach(() => {
		deleteObject.mockClear();
		sqlState.deletedRow = { storage_key: 'u/user-1/orbit.glb', thumbnail_key: 'thumb/orbit.png' };
		sqlState.stillReferenced = [];
		sqlState.refCheckError = null;
	});

	it('deletes both objects when no live avatar references them', async () => {
		expect(await deleteAvatar({ id: 'a1', userId: 'user-1' })).toBe(true);
		await settle();
		expect(deleteObject.mock.calls.map((c) => c[0]).sort()).toEqual([
			'thumb/orbit.png',
			'u/user-1/orbit.glb',
		]);
	});

	it('keeps a thumbnail another live avatar still points at', async () => {
		sqlState.stillReferenced = ['thumb/orbit.png'];
		await deleteAvatar({ id: 'a1', userId: 'user-1' });
		await settle();
		expect(deleteObject.mock.calls.map((c) => c[0])).toEqual(['u/user-1/orbit.glb']);
	});

	it('keeps the model a live copy still points at', async () => {
		sqlState.stillReferenced = ['u/user-1/orbit.glb', 'thumb/orbit.png'];
		await deleteAvatar({ id: 'a1', userId: 'user-1' });
		await settle();
		expect(deleteObject).not.toHaveBeenCalled();
	});

	it('keeps every object when the reference check itself fails', async () => {
		sqlState.refCheckError = new Error('db unavailable');
		await deleteAvatar({ id: 'a1', userId: 'user-1' });
		await settle();
		expect(deleteObject).not.toHaveBeenCalled();
	});

	it('skips the bucket entirely when the row has no keys', async () => {
		sqlState.deletedRow = { storage_key: null, thumbnail_key: null };
		expect(await deleteAvatar({ id: 'a1', userId: 'user-1' })).toBe(true);
		await settle();
		expect(deleteObject).not.toHaveBeenCalled();
	});

	it('returns false and touches nothing when the row is not the caller’s', async () => {
		sqlState.deletedRow = null;
		expect(await deleteAvatar({ id: 'a1', userId: 'someone-else' })).toBe(false);
		await settle();
		expect(deleteObject).not.toHaveBeenCalled();
	});
});
