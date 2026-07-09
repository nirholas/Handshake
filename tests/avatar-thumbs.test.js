// api/_lib/avatar-thumbs.js — the module that owns avatar thumbnail coverage.
//
// The invariant under test, and the reason this module exists:
//
//   A `thumbnail_key` is only ever persisted AFTER the object behind it has been
//   confirmed to exist in R2.
//
// Violating it is not a cosmetic bug. A key pointing at a missing object makes R2
// answer 404 with a `text/plain` body; Chrome then refuses that response for an
// <img> request and logs net::ERR_BLOCKED_BY_ORB. That is exactly what shipped on
// the homepage until 2026-07-09. These tests pin the invariant on both write
// paths (forge-preview adoption and chromium render) so it cannot regress.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// `sql` is a tagged template. Route each call by the SQL text so a test can drive
// the multi-statement flows (select candidates → update → delete claim).
const sqlCalls = [];
let sqlRoutes = [];
// Records every statement, then answers from `sqlRoutes` (first match wins).
// `sqlOrder` lets a test observe write ordering across r2 + db.
const sqlOrder = [];
const defaultSqlImpl = (strings, ...vals) => {
	const text = Array.isArray(strings) ? strings.join('?') : String(strings);
	sqlCalls.push({ text, vals });
	if (/UPDATE avatars/i.test(text)) sqlOrder.push('db');
	const handler = sqlRoutes.find((r) => r.match.test(text));
	return Promise.resolve(handler ? handler.rows : []);
};
const sqlMock = vi.fn(defaultSqlImpl);
vi.mock('../api/_lib/db.js', () => ({ sql: (...a) => sqlMock(...a) }));

const headObjectMock = vi.fn();
const putObjectMock = vi.fn();
const presignGetMock = vi.fn(async ({ key }) => `https://signed.example/${key}`);
vi.mock('../api/_lib/r2.js', () => ({
	headObject: (...a) => headObjectMock(...a),
	putObject: (...a) => putObjectMock(...a),
	presignGet: (...a) => presignGetMock(...a),
	publicUrl: (key) => `https://cdn.example/${key}`,
	isLegacyOgThumbnailKey: (k) => /^https?:\/\/.*_og\.png$/i.test(String(k || '')),
}));

const renderGlbToPngMock = vi.fn();
vi.mock('../api/_lib/render-glb.js', () => ({ renderGlbToPng: (...a) => renderGlbToPngMock(...a) }));

const { adoptForgePreviews, renderThumbnail, renderBatch, thumbKeyFor, isMissingThumbnail } =
	await import('../api/_lib/avatar-thumbs.js');

const updates = () => sqlCalls.filter((c) => /UPDATE avatars/i.test(c.text));

beforeEach(() => {
	sqlCalls.length = 0;
	sqlOrder.length = 0;
	sqlRoutes = [];
	// mockClear() leaves a previous test's mockImplementation in place — reset the
	// behaviour, not just the call log, or one test silently starves the next.
	sqlMock.mockReset().mockImplementation(defaultSqlImpl);
	headObjectMock.mockReset();
	putObjectMock.mockReset().mockResolvedValue(undefined);
	renderGlbToPngMock.mockReset();
});

describe('isMissingThumbnail — the shared predicate', () => {
	it('treats null / empty as missing', () => {
		expect(isMissingThumbnail(null)).toBe(true);
		expect(isMissingThumbnail('')).toBe(true);
	});

	it('treats an absolute URL as missing (publicUrl passes it through to an origin with no object)', () => {
		expect(isMissingThumbnail('https://three.ws/avatars/michelle_og.png')).toBe(true);
		expect(isMissingThumbnail('https://example.com/x.png')).toBe(true);
	});

	it('treats a relative bucket key as present', () => {
		expect(isMissingThumbnail('thumb/abc.png')).toBe(false);
		expect(isMissingThumbnail('forge/deadbeef/x-poster.webp')).toBe(false);
	});
});

describe('adoptForgePreviews — zero-copy adoption', () => {
	it('persists the preview key once the object is confirmed present', async () => {
		sqlRoutes = [{ match: /FROM avatars a[\s\S]*JOIN forge_creations/i, rows: [{ id: 'av-1', preview_key: 'forge/aa/bb.jpg' }] }];
		headObjectMock.mockResolvedValue({ ContentLength: 1234 });

		const res = await adoptForgePreviews({ limit: 10 });

		expect(res).toEqual({ adopted: 1, missing: 0 });
		expect(headObjectMock).toHaveBeenCalledWith('forge/aa/bb.jpg');
		const up = updates();
		expect(up).toHaveLength(1);
		expect(up[0].vals).toContain('forge/aa/bb.jpg');
	});

	it('NEVER persists a key when the preview object is absent from R2', async () => {
		sqlRoutes = [{ match: /FROM avatars a[\s\S]*JOIN forge_creations/i, rows: [{ id: 'av-1', preview_key: 'forge/gone.jpg' }] }];
		headObjectMock.mockResolvedValue(null); // object was pruned

		const res = await adoptForgePreviews({ limit: 10 });

		expect(res).toEqual({ adopted: 0, missing: 1 });
		// This is the whole point: no UPDATE, so no 404 → no ORB.
		expect(updates()).toHaveLength(0);
	});

	it('treats a headObject failure as absent rather than adopting optimistically', async () => {
		sqlRoutes = [{ match: /FROM avatars a[\s\S]*JOIN forge_creations/i, rows: [{ id: 'av-1', preview_key: 'forge/x.jpg' }] }];
		headObjectMock.mockRejectedValue(new Error('network'));

		const res = await adoptForgePreviews({ limit: 10 });

		expect(res.adopted).toBe(0);
		expect(updates()).toHaveLength(0);
	});

	it('short-circuits with no candidates', async () => {
		sqlRoutes = [];
		const res = await adoptForgePreviews({ limit: 10 });
		expect(res).toEqual({ adopted: 0, missing: 0 });
		expect(headObjectMock).not.toHaveBeenCalled();
	});
});

describe('renderThumbnail — render then commit', () => {
	it('uploads a PNG under thumb/<id>.png with an image/png content-type', async () => {
		renderGlbToPngMock.mockResolvedValue(Buffer.from('fake-png-bytes'));

		const r = await renderThumbnail({ id: 'av-9', storage_key: 'u/1/model.glb' });

		expect(putObjectMock).toHaveBeenCalledTimes(1);
		const arg = putObjectMock.mock.calls[0][0];
		expect(arg.key).toBe('thumb/av-9.png');
		expect(arg.key).toBe(thumbKeyFor('av-9'));
		// A wrong content-type here is the ORB failure mode the audit *thought* it saw.
		expect(arg.contentType).toBe('image/png');
		expect(r.key).toBe('thumb/av-9.png');
	});

	it('presigns the durable storage key rather than trusting a stale URL', async () => {
		renderGlbToPngMock.mockResolvedValue(Buffer.from('png'));
		await renderThumbnail({ id: 'av-9', storage_key: 'u/1/model.glb' });
		expect(presignGetMock).toHaveBeenCalledWith(expect.objectContaining({ key: 'u/1/model.glb' }));
		expect(renderGlbToPngMock.mock.calls[0][0].glbUrl).toBe('https://signed.example/u/1/model.glb');
	});

	it('commits thumbnail_key only after the upload resolves', async () => {
		renderGlbToPngMock.mockResolvedValue(Buffer.from('png'));
		putObjectMock.mockImplementation(async () => { sqlOrder.push('put'); });

		await renderThumbnail({ id: 'av-9', storage_key: 'k.glb' });

		// Upload first, key second. Reverse this and a failed upload leaves a
		// thumbnail_key pointing at nothing — a 404 the browser blocks as ORB.
		expect(sqlOrder).toEqual(['put', 'db']);
	});

	it('throws and writes nothing when the renderer yields no bytes', async () => {
		renderGlbToPngMock.mockResolvedValue(Buffer.alloc(0));
		await expect(renderThumbnail({ id: 'av-9', storage_key: 'k.glb' })).rejects.toThrow(/no bytes/i);
		expect(putObjectMock).not.toHaveBeenCalled();
		expect(updates()).toHaveLength(0);
	});

	it('does not commit a key when the upload fails', async () => {
		renderGlbToPngMock.mockResolvedValue(Buffer.from('png'));
		putObjectMock.mockRejectedValue(new Error('r2 down'));
		await expect(renderThumbnail({ id: 'av-9', storage_key: 'k.glb' })).rejects.toThrow(/r2 down/);
		expect(updates()).toHaveLength(0);
	});
});

describe('renderBatch — bounded drain', () => {
	it('records a failure and keeps going instead of aborting the batch', async () => {
		sqlRoutes = [
			{ match: /WITH candidates/i, rows: [
				{ id: 'ok-1', storage_key: 'a.glb', name: 'Ok' },
				{ id: 'bad-1', storage_key: 'b.glb', name: 'Bad' },
			] },
		];
		renderGlbToPngMock.mockImplementation(async ({ glbUrl }) => {
			if (glbUrl.includes('b.glb')) throw new Error('corrupt glb');
			return Buffer.from('png');
		});

		const r = await renderBatch({ limit: 2, concurrency: 1 });

		expect(r.claimed).toBe(2);
		expect(r.rendered).toBe(1);
		expect(r.failed).toBe(1);
		// The failure is written to the ledger so retries stay bounded.
		expect(sqlCalls.some((c) => /avatar_thumbnail_backfill[\s\S]*last_error/i.test(c.text))).toBe(true);
	});

	it('is a no-op when nothing can be claimed', async () => {
		sqlRoutes = [];
		const r = await renderBatch({ limit: 5 });
		expect(r).toMatchObject({ claimed: 0, rendered: 0, failed: 0 });
		expect(renderGlbToPngMock).not.toHaveBeenCalled();
	});
});
