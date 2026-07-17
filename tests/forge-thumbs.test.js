// api/_lib/forge-thumbs.js — server-side thumbnail backfill for the Forge.
//
// The invariant under test: a `preview_image_url` is only ever persisted AFTER
// the PNG behind it has been uploaded to R2, and only when the slot is still
// empty (fill-only). Violating the first half puts a card's <img> at a missing
// object (net::ERR_BLOCKED_BY_ORB); violating the second clobbers a poster the
// maker captured. These tests pin both on the render path.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// `sql` is a tagged template; route each call by its text and record order so a
// test can assert the R2-before-DB sequencing.
const sqlCalls = [];
let sqlRoutes = [];
const order = [];
const defaultSqlImpl = (strings, ...vals) => {
	const text = Array.isArray(strings) ? strings.join('?') : String(strings);
	sqlCalls.push({ text, vals });
	if (/UPDATE forge_creations/i.test(text)) order.push('db');
	const handler = sqlRoutes.find((r) => r.match.test(text));
	return Promise.resolve(handler ? handler.rows : []);
};
const sqlMock = vi.fn(defaultSqlImpl);
vi.mock('../api/_lib/db.js', () => ({ sql: (...a) => sqlMock(...a) }));

const putObjectMock = vi.fn(async () => order.push('r2'));
vi.mock('../api/_lib/r2.js', () => ({
	putObject: (...a) => putObjectMock(...a),
	publicUrl: (key) => `https://cdn.example/${key}`,
}));

const renderGlbToPngMock = vi.fn(async () => Buffer.from('x'.repeat(5000)));
vi.mock('../api/_lib/render-glb.js', () => ({
	renderGlbToPng: (...a) => renderGlbToPngMock(...a),
	isBrowserInfrastructureError: () => false,
}));

// avatar-thumbs is imported only for thumbBackdropFor (a pure helper).
vi.mock('../api/_lib/avatar-thumbs.js', () => ({
	thumbBackdropFor: (id) => ({ inner: '#111', outer: '#000', _id: id }),
}));

const { renderThumbnail, forgeThumbKeyFor } = await import('../api/_lib/forge-thumbs.js');

beforeEach(() => {
	sqlCalls.length = 0;
	order.length = 0;
	sqlRoutes = [];
	sqlMock.mockClear();
	putObjectMock.mockClear();
	renderGlbToPngMock.mockClear();
});

describe('renderThumbnail', () => {
	it('uploads to R2 before it commits the preview key (ORB-safety)', async () => {
		sqlRoutes = [{ match: /UPDATE forge_creations/i, rows: [{ id: 'c-1' }] }];
		await renderThumbnail({ id: 'c-1', glb_url: 'https://cdn/x.glb' });
		expect(putObjectMock).toHaveBeenCalledTimes(1);
		// R2 write happens strictly before the DB commit.
		expect(order).toEqual(['r2', 'db']);
	});

	it('writes the PNG at the forge/thumb/<id>.png key and fills preview + preview_key', async () => {
		sqlRoutes = [{ match: /UPDATE forge_creations/i, rows: [{ id: 'c-2' }] }];
		const r = await renderThumbnail({ id: 'c-2', glb_url: 'https://cdn/y.glb' });
		expect(putObjectMock.mock.calls[0][0].key).toBe(forgeThumbKeyFor('c-2'));
		expect(r.key).toBe('forge/thumb/c-2.png');
		expect(r.url).toBe('https://cdn.example/forge/thumb/c-2.png');
		expect(r.filled).toBe(true);
		// The UPDATE is fill-only — guarded by preview_image_url IS NULL.
		const upd = sqlCalls.find((c) => /UPDATE forge_creations/i.test(c.text));
		expect(upd.text).toMatch(/preview_image_url IS NULL/i);
	});

	it('reports filled:false when the slot was already taken (a poster won the race)', async () => {
		sqlRoutes = [{ match: /UPDATE forge_creations/i, rows: [] }]; // no row updated
		const r = await renderThumbnail({ id: 'c-3', glb_url: 'https://cdn/z.glb' });
		expect(r.filled).toBe(false);
		// Object was still uploaded (idempotent key), just not committed as the preview.
		expect(putObjectMock).toHaveBeenCalledTimes(1);
	});

	it('throws (and never commits) when the renderer returns no bytes', async () => {
		renderGlbToPngMock.mockResolvedValueOnce(Buffer.alloc(0));
		await expect(renderThumbnail({ id: 'c-4', glb_url: 'https://cdn/e.glb' })).rejects.toThrow(/no bytes/);
		expect(putObjectMock).not.toHaveBeenCalled();
		expect(sqlCalls.some((c) => /UPDATE forge_creations/i.test(c.text))).toBe(false);
	});
});
