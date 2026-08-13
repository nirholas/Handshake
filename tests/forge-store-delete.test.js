/**
 * deleteCreation() + source-upload tracking (the "Your creations" delete flow).
 *
 * A creation must be fully erasable by its owner: the stored GLB, the stored
 * preview, every recorded source upload (an image-to-3D run's reference
 * photos), and the row itself. These tests pin three contracts:
 *
 *   1. deleteCreation removes every bucket object the row points at (key
 *      columns, URL-derived legacy keys, source_image_keys) and then the row.
 *   2. Object-storage failure aborts BEFORE the row delete, so the user can
 *      retry; bytes are never stranded without a handle.
 *   3. createCreation resolves bucket-hosted reference URLs to object keys at
 *      insert time and drops provider-hosted ones (not ours to delete).
 *
 * Only the db/object-storage boundaries are stubbed, matching this repo's
 * forge-store test conventions (see tests/forge-store-materialize.test.js).
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';

beforeAll(() => {
	Object.assign(process.env, {
		DATABASE_URL: 'postgres://test:test@localhost:5432/test',
		S3_ENDPOINT: 'https://s3.example.com',
		S3_BUCKET: 'test-bucket',
		S3_PUBLIC_DOMAIN: 'https://cdn.example.com',
		S3_ACCESS_KEY_ID: 'test-key',
		S3_SECRET_ACCESS_KEY: 'test-secret',
	});
});

let selectRows = [];
const sqlMock = vi.fn(async (strings, ...values) => {
	const text = Array.isArray(strings) ? strings.join(' ') : String(strings);
	if (text.includes('select')) return selectRows;
	return [];
});

vi.mock('../api/_lib/db.js', () => ({
	sql: (...args) => sqlMock(...args),
	isDbUnavailableError: () => false,
}));

const deleteObjectMock = vi.fn(async () => {});
vi.mock('../api/_lib/r2.js', () => ({
	putObject: vi.fn(async () => {}),
	publicUrl: (key) => `https://cdn.example.com/${key}`,
	deleteObject: (...args) => deleteObjectMock(...args),
	keyFromPublicUrl: (url) =>
		typeof url === 'string' && url.startsWith('https://cdn.example.com/')
			? url.slice('https://cdn.example.com/'.length).split(/[?#]/)[0]
			: null,
}));

vi.mock('../api/_lib/forge-events.js', () => ({
	recordGenerationEvent: vi.fn(async () => {}),
}));

const { deleteCreation, createCreation } = await import('../api/_lib/forge-store.js');

afterEach(() => {
	sqlMock.mockClear();
	deleteObjectMock.mockClear();
	deleteObjectMock.mockImplementation(async () => {});
	selectRows = [];
});

function deleteStatements() {
	return sqlMock.mock.calls
		.map(([strings]) => (Array.isArray(strings) ? strings.join(' ') : String(strings)))
		.filter((t) => t.includes('delete from forge_creations'));
}

describe('deleteCreation', () => {
	it('removes the stored GLB, preview, source uploads, and the row', async () => {
		selectRows = [
			{
				id: 'c-1',
				glb_key: 'forge/client-abc/c-1.glb',
				glb_url: 'https://cdn.example.com/forge/client-abc/c-1.glb',
				preview_key: 'forge/client-abc/c-1.png',
				preview_image_url: 'https://cdn.example.com/forge/client-abc/c-1.png',
				source_image_keys: ['forge/uploads/client-abc/photo-1.jpg', 'forge/uploads/client-abc/photo-2.jpg'],
			},
		];
		const out = await deleteCreation({ id: 'c-1', clientKey: 'client-key' });
		expect(out).toBe('deleted');
		const deletedKeys = deleteObjectMock.mock.calls.map(([k]) => k).sort();
		expect(deletedKeys).toEqual([
			'forge/client-abc/c-1.glb',
			'forge/client-abc/c-1.png',
			'forge/uploads/client-abc/photo-1.jpg',
			'forge/uploads/client-abc/photo-2.jpg',
		]);
		expect(deleteStatements()).toHaveLength(1);
	});

	it('derives legacy keys from URLs when the key columns are empty', async () => {
		// Rows written before the *_key columns (or whose preview copy failed and
		// still points at the raw upload) must still have their bytes removed.
		selectRows = [
			{
				id: 'c-2',
				glb_key: null,
				glb_url: 'https://cdn.example.com/forge/client-abc/c-2.glb',
				preview_key: null,
				preview_image_url: 'https://cdn.example.com/forge/uploads/client-abc/original.png',
				source_image_keys: null,
			},
		];
		const out = await deleteCreation({ id: 'c-2', clientKey: 'client-key' });
		expect(out).toBe('deleted');
		const deletedKeys = deleteObjectMock.mock.calls.map(([k]) => k).sort();
		expect(deletedKeys).toEqual([
			'forge/client-abc/c-2.glb',
			'forge/uploads/client-abc/original.png',
		]);
	});

	it('never deletes outside the forge/ namespace, even from a poisoned row', async () => {
		selectRows = [
			{
				id: 'c-3',
				glb_key: 'u/someone-else/avatar.glb',
				glb_url: 'https://cdn.example.com/u/someone-else/avatar.glb',
				preview_key: 'forge/client-abc/c-3.png',
				preview_image_url: null,
				source_image_keys: ['../../etc/passwd', 'u/victim/photo.png'],
			},
		];
		const out = await deleteCreation({ id: 'c-3', clientKey: 'client-key' });
		expect(out).toBe('deleted');
		expect(deleteObjectMock.mock.calls.map(([k]) => k)).toEqual(['forge/client-abc/c-3.png']);
	});

	it("returns not_found for a row the caller doesn't own, touching nothing", async () => {
		selectRows = [];
		const out = await deleteCreation({ id: 'c-4', clientKey: 'client-key' });
		expect(out).toBe('not_found');
		expect(deleteObjectMock).not.toHaveBeenCalled();
		expect(deleteStatements()).toHaveLength(0);
	});

	it('keeps the row when object storage refuses, so the user can retry', async () => {
		selectRows = [
			{
				id: 'c-5',
				glb_key: 'forge/client-abc/c-5.glb',
				glb_url: null,
				preview_key: null,
				preview_image_url: null,
				source_image_keys: null,
			},
		];
		deleteObjectMock.mockImplementation(async () => {
			throw new Error('storage down');
		});
		const out = await deleteCreation({ id: 'c-5', clientKey: 'client-key' });
		expect(out).toBe('error');
		expect(deleteStatements()).toHaveLength(0);
	});
});

describe('createCreation source-upload tracking', () => {
	function insertedValues() {
		const call = sqlMock.mock.calls.find(([strings]) =>
			(Array.isArray(strings) ? strings.join(' ') : '').includes('insert into forge_creations'),
		);
		return call ? call.slice(1) : [];
	}

	it('records bucket-hosted reference views as object keys, dropping external URLs', async () => {
		const id = await createCreation({
			clientKey: 'client-key',
			prompt: 'me as a 3d model',
			previewImageUrl: 'https://cdn.example.com/forge/uploads/client-abc/selfie.jpg',
			sourceImageUrls: [
				'https://cdn.example.com/forge/uploads/client-abc/selfie.jpg',
				'https://cdn.example.com/forge/uploads/client-abc/side-view.jpg',
				'https://replicate.delivery/pbxt/external-flux-view.png',
			],
			backend: 'trellis',
			tier: 'standard',
			path: 'image',
		});
		expect(id).toBeTruthy();
		const stored = insertedValues().find((v) => typeof v === 'string' && v.startsWith('['));
		expect(JSON.parse(stored)).toEqual([
			'forge/uploads/client-abc/selfie.jpg',
			'forge/uploads/client-abc/side-view.jpg',
		]);
	});

	it('falls back to the preview URL when no explicit list is passed', async () => {
		await createCreation({
			clientKey: 'client-key',
			prompt: 'single view',
			previewImageUrl: 'https://cdn.example.com/forge/uploads/client-abc/only.png',
			backend: 'trellis',
			tier: 'standard',
			path: 'image',
		});
		const stored = insertedValues().find((v) => typeof v === 'string' && v.startsWith('['));
		expect(JSON.parse(stored)).toEqual(['forge/uploads/client-abc/only.png']);
	});

	it('stores null for text-to-3D rows whose preview is provider-hosted', async () => {
		await createCreation({
			clientKey: 'client-key',
			prompt: 'a fox',
			previewImageUrl: 'https://replicate.delivery/pbxt/flux-preview.png',
			backend: 'trellis',
			tier: 'standard',
			path: 'text',
		});
		const stored = insertedValues().find((v) => typeof v === 'string' && v.startsWith('['));
		expect(stored).toBeUndefined();
	});
});
