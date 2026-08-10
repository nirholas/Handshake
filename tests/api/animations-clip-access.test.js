/**
 * GET /api/animations/clips/:id access tests.
 *
 * Two things this endpoint has to get right, both regressions:
 *
 *  1. The route pattern (vercel.json) admits any hex-and-dash string, but the
 *     column is a uuid. A looser id used to reach Postgres as an invalid uuid
 *     literal and come back as a 500 with a support ref, when the caller had
 *     earned a 400.
 *  2. A clip listed for sale sells its motion through the x402 paid download
 *     (api/x402/animation-download.js), and the marketplace feed publishes the
 *     clip id to every browser. Handing the baked tracks back here for free
 *     would give away exactly what the paywall charges for. `public` visibility
 *     is the creator publishing to the free gallery, so it is never gated.
 *
 * The db, auth and R2 boundaries are stubbed; the handler, its http envelope
 * and the real gate logic run.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = { rows: [] };
vi.mock('../../api/_lib/db.js', () => ({
	sql: vi.fn(async () => db.rows),
}));

const session = { user: null };
vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => session.user),
	authenticateBearer: vi.fn(async () => null),
	extractBearer: vi.fn(() => null),
	hasScope: vi.fn(() => true),
}));

vi.mock('../../api/_lib/r2.js', () => ({
	getObjectBuffer: vi.fn(async () => Buffer.from('{"name":"offloaded","duration":1,"tracks":[]}')),
	putObject: vi.fn(async () => ({})),
	thumbnailUrl: vi.fn((key) => (key ? `https://cdn.test/${key}` : null)),
}));

const { default: handler } = await import('../../api/animations/[id].js');
const { getObjectBuffer } = await import('../../api/_lib/r2.js');

const OWNER = '11111111-1111-4111-8111-111111111111';
const CLIP_ID = '22222222-2222-4222-8222-222222222222';

const bakedClip = {
	name: 'Spin',
	duration: 1,
	tracks: [{ name: 'Hips.quaternion', type: 'quaternion', times: [0], values: [0, 0, 0, 1] }],
};

function row(overrides = {}) {
	return {
		id: CLIP_ID,
		owner_id: OWNER,
		avatar_id: null,
		slug: 'spin',
		name: 'Spin',
		description: null,
		kind: 'loop',
		format: 'three.ws.animation.v1',
		duration_ms: 1000,
		frame_count: 1,
		fps: 30,
		loop: true,
		clip: bakedClip,
		storage_key: null,
		editor_doc: { duration: 1, keyframes: [] },
		thumbnail_key: null,
		tags: [],
		visibility: 'unlisted',
		price_amount: null,
		price_currency: null,
		listed: false,
		play_count: 0,
		purchase_count: 0,
		created_at: 'now',
		updated_at: 'now',
		...overrides,
	};
}

function makeRes() {
	const r = { statusCode: 200, _h: {}, _b: null };
	r.setHeader = (k, v) => { r._h[k] = v; };
	r.getHeader = (k) => r._h[k];
	r.end = (b) => { r._b = b; };
	r.json = () => JSON.parse(r._b);
	return r;
}

async function get(id, query = '') {
	const res = makeRes();
	const req = {
		method: 'GET',
		url: `/api/animations/clips/${id}${query}`,
		query: { id },
		headers: { origin: 'https://three.ws' },
		socket: { remoteAddress: '127.0.0.1' },
	};
	await handler(req, res);
	return res;
}

beforeEach(() => {
	db.rows = [row()];
	session.user = null;
	vi.clearAllMocks();
});

describe('clip id validation', () => {
	it('rejects a hex-but-not-uuid id with a 400 instead of a database 500', async () => {
		const res = await get('aaaaaaaa');
		expect(res.statusCode).toBe(400);
		expect(res.json().error).toBe('invalid_request');
	});

	it('rejects an empty id', async () => {
		const res = await get('');
		expect(res.statusCode).toBe(400);
	});

	it('accepts a well-formed uuid', async () => {
		const res = await get(CLIP_ID);
		expect(res.statusCode).toBe(200);
	});
});

describe('private clips', () => {
	it('404s for a non-owner rather than admitting the clip exists', async () => {
		db.rows = [row({ visibility: 'private' })];
		const res = await get(CLIP_ID);
		expect(res.statusCode).toBe(404);
	});

	it('serves the owner their own private clip with the editing source', async () => {
		db.rows = [row({ visibility: 'private' })];
		session.user = { id: OWNER };
		const { clip } = (await get(CLIP_ID)).json();
		expect(clip.clip).toEqual(bakedClip);
		expect(clip.editable).toBe(true);
		expect(clip.paywalled).toBe(false);
	});
});

describe('paid listings stay behind the x402 paywall', () => {
	const paid = { listed: true, price_amount: '2.500000000', price_currency: 'USDC' };

	it('withholds the baked tracks from a non-owner and points at the paid download', async () => {
		db.rows = [row(paid)];
		const { clip } = (await get(CLIP_ID)).json();
		expect(clip.clip).toBeNull();
		expect(clip.paywalled).toBe(true);
		expect(clip.download_url).toBe(`/api/x402/animation-download?id=${CLIP_ID}`);
	});

	it('still ships the metadata a listing card renders', async () => {
		db.rows = [row({ ...paid, thumbnail_key: 'anim-thumb/x.png' })];
		const { clip } = (await get(CLIP_ID)).json();
		expect(clip.name).toBe('Spin');
		expect(clip.duration_ms).toBe(1000);
		expect(clip.price).toEqual({ amount: '2.500000000', currency: 'USDC' });
		expect(clip.thumbnail_url).toBe('https://cdn.test/anim-thumb/x.png');
	});

	it('never pays the R2 round-trip for an offloaded clip it will not return', async () => {
		db.rows = [row({ ...paid, clip: null, storage_key: 'u/x/animations/big.json' })];
		const { clip } = (await get(CLIP_ID)).json();
		expect(clip.clip).toBeNull();
		expect(getObjectBuffer).not.toHaveBeenCalled();
	});

	it('does not count a play for a fetch that delivered no motion', async () => {
		db.rows = [row(paid)];
		const { sql } = await import('../../api/_lib/db.js');
		await get(CLIP_ID, '?play=1');
		await new Promise((r) => queueMicrotask(r));
		expect(sql).toHaveBeenCalledTimes(1);
	});

	it('lets the owner keep working on their own listed clip', async () => {
		db.rows = [row(paid)];
		session.user = { id: OWNER };
		const { clip } = (await get(CLIP_ID)).json();
		expect(clip.paywalled).toBe(false);
		expect(clip.clip).toEqual(bakedClip);
	});

	it('leaves a public clip free: publishing to the gallery is the creator giving it away', async () => {
		db.rows = [row({ ...paid, visibility: 'public' })];
		const { clip } = (await get(CLIP_ID)).json();
		expect(clip.paywalled).toBe(false);
		expect(clip.clip).toEqual(bakedClip);
	});

	it('leaves a free listing playable', async () => {
		db.rows = [row({ listed: true, price_amount: null })];
		const { clip } = (await get(CLIP_ID)).json();
		expect(clip.paywalled).toBe(false);
		expect(clip.clip).toEqual(bakedClip);
	});

	it('resolves an offloaded clip from R2 when it is not paywalled', async () => {
		db.rows = [row({ clip: null, storage_key: 'u/x/animations/big.json' })];
		const { clip } = (await get(CLIP_ID)).json();
		expect(clip.clip.name).toBe('offloaded');
		expect(getObjectBuffer).toHaveBeenCalledWith('u/x/animations/big.json');
	});
});

describe('editing source', () => {
	it('never leaves the owner: editor_doc is null for everyone else', async () => {
		db.rows = [row()];
		const { clip } = (await get(CLIP_ID)).json();
		expect(clip.editor_doc).toBeNull();
		expect(clip.editable).toBe(false);
	});
});
