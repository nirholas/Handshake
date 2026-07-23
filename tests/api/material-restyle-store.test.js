// Tests for api/_lib/material-restyle-store.js — the durable, best-effort
// record of Material Studio outputs that powers the "Creations" tab on a
// signed-in creator's public portfolio (/u/:username). DB is mocked: these
// prove the write/read shape and the fail-soft behavior (a DB hiccup or a
// deployment that hasn't run the migration yet must never throw).

import { describe, it, expect, vi, beforeEach } from 'vitest';

const queue = [];
vi.mock('../../api/_lib/db.js', () => {
	const sql = vi.fn(async () => (queue.length ? queue.shift() : []));
	return { sql, isDbUnavailableError: () => false };
});
vi.mock('../../api/_lib/env.js', () => ({ databaseConfigured: () => true }));
vi.mock('../../api/_lib/streaks.js', () => ({
	recordDailyActivity: vi.fn(async () => {}),
	maybeAwardFirstCreation: vi.fn(async () => {}),
}));

import {
	recordMaterialRestyle,
	listRestylesByUser,
	countRestylesByUser,
} from '../../api/_lib/material-restyle-store.js';
import { sql } from '../../api/_lib/db.js';

beforeEach(() => {
	queue.length = 0;
	vi.clearAllMocks();
});

describe('recordMaterialRestyle', () => {
	it('inserts a row and returns its id for a signed-in restyle', async () => {
		queue.push([]); // insert
		const id = await recordMaterialRestyle({
			userId: 'user-1',
			action: 'restyle',
			sourceUrl: 'https://cdn.three.ws/src.glb',
			resultUrl: 'https://cdn.three.ws/out.glb',
			instruction: 'make it chrome',
		});
		expect(typeof id).toBe('string');
		expect(sql).toHaveBeenCalledOnce();
	});

	it('no-ops (returns null) when resultUrl is missing', async () => {
		const id = await recordMaterialRestyle({ userId: 'user-1', action: 'restyle', sourceUrl: 'x' });
		expect(id).toBeNull();
		expect(sql).not.toHaveBeenCalled();
	});

	it('fails soft to null when the insert throws (e.g. migration not applied yet)', async () => {
		sql.mockImplementationOnce(async () => {
			throw new Error('relation "material_restyles" does not exist');
		});
		const id = await recordMaterialRestyle({
			userId: 'user-1',
			action: 'variants',
			sourceUrl: 'https://cdn.three.ws/src.glb',
			resultUrl: 'https://cdn.three.ws/variant-1.glb',
			preset: 'chrome',
			seed: 42,
		});
		expect(id).toBeNull();
	});
});

describe('listRestylesByUser / countRestylesByUser', () => {
	it('returns [] with no userId, without querying the db', async () => {
		const rows = await listRestylesByUser({ userId: null });
		expect(rows).toEqual([]);
		expect(sql).not.toHaveBeenCalled();
	});

	it('maps rows into the shared creation-card shape', async () => {
		queue.push([
			{
				id: 'r1',
				action: 'restyle',
				label: null,
				source_url: 'https://cdn.three.ws/src.glb',
				result_url: 'https://cdn.three.ws/out.glb',
				instruction: 'make it wooden',
				preset: null,
				created_at: '2026-07-23T00:00:00Z',
			},
		]);
		const rows = await listRestylesByUser({ userId: 'user-1' });
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			type: 'restyle',
			glbUrl: 'https://cdn.three.ws/out.glb',
			prompt: 'make it wooden',
			category: 'AI restyle',
		});
	});

	it('counts a user\'s restyles', async () => {
		queue.push([{ n: 7 }]);
		const n = await countRestylesByUser({ userId: 'user-1' });
		expect(n).toBe(7);
	});

	it('fails soft to 0 on a query error', async () => {
		sql.mockImplementationOnce(async () => {
			throw new Error('db unavailable');
		});
		const n = await countRestylesByUser({ userId: 'user-1' });
		expect(n).toBe(0);
	});
});
