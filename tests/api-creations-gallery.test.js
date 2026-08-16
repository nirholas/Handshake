// /api/creations, the creator-gallery + remix-economy overlay on top of the
// Loom feed. Covers the two defects the batch-05 API audit found, plus the
// dispatcher's success and failure paths:
//
//   1. Aggregation depth. creations.js reads a SCAN_CAP (600) deep slice of the
//      Loom feed to rank creators and trending assets, but loom.readFeed used
//      to clamp EVERY caller to the public MAX_LIMIT (120). Creator counts and
//      gallery pagination silently stopped at 120 items no matter how much the
//      feed actually held.
//   2. Overlay round-trips. Enriching that slice did a getMeta + getChildren
//      per creation. enrichAll batches both, so the shape it returns must stay
//      byte-identical to the per-item path it replaced.
//
// Redis is left unconfigured so both modules run on their documented in-process
// fallback, which is the same code path dev and CI take.
import { describe, it, expect, beforeAll } from 'vitest';

const { writeCreation, readFeed } = await import('../api/loom.js');
const { default: handler } = await import('../api/creations.js');

const GLB = (n) => `https://three.ws/models/audit-${n}.glb`;

function mkReq({ method = 'GET', url = '/api/creations', body = null } = {}) {
	const headers = { host: 'three.ws' };
	if (body != null) headers['content-type'] = 'application/json';
	return {
		method,
		url,
		headers,
		body: body ?? undefined,
		socket: { remoteAddress: '198.51.100.7' },
		on(event, cb) {
			if (event === 'data' && body != null) {
				queueMicrotask(() => {
					cb(Buffer.from(JSON.stringify(body)));
					this._endCb?.();
				});
			} else if (event === 'end') {
				this._endCb = cb;
				if (body == null) queueMicrotask(() => cb());
			}
		},
	};
}

function mkRes() {
	return {
		statusCode: 200,
		headers: {},
		chunks: [],
		writableEnded: false,
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		writeHead(code, headers = {}) {
			this.statusCode = code;
			for (const [k, v] of Object.entries(headers)) this.setHeader(k, v);
		},
		write(s) {
			this.chunks.push(String(s));
			return true;
		},
		end(b) {
			if (b) this.chunks.push(String(b));
			this.writableEnded = true;
		},
		get json() {
			return JSON.parse(this.chunks.join(''));
		},
	};
}

async function call(opts) {
	const res = mkRes();
	await handler(mkReq(opts), res);
	return res;
}

// 150 seeded creations: deliberately more than loom's public MAX_LIMIT (120) so
// a re-introduced clamp shows up as a missing tail rather than a passing test.
const SEEDED = 150;
const OLDEST_AUTHOR = 'deep-catalog-creator';

beforeAll(async () => {
	for (let i = 0; i < SEEDED; i++) {
		await writeCreation({
			id: `audit-seed-${String(i).padStart(3, '0')}`,
			prompt: `a stylized robot number ${i}`,
			glbUrl: GLB(i),
			previewImageUrl: null,
			// The first writes are the OLDEST (writeCreation unshifts), so this
			// author sits past the 120-item cut-off in the newest-first feed.
			author: i < 5 ? OLDEST_AUTHOR : `creator-${i % 7}`,
			tier: null,
			backend: null,
			createdAt: 1_700_000_000_000 + i * 1000,
		});
	}
});

describe('loom readFeed depth', () => {
	it('honors an internal scan deeper than the public MAX_LIMIT', async () => {
		const deep = await readFeed(600, NaN);
		expect(deep.length).toBe(SEEDED);
	});

	it('still returns only what was asked for on a shallow read', async () => {
		const shallow = await readFeed(10, NaN);
		expect(shallow.length).toBe(10);
	});
});

describe('/api/creations aggregation depth', () => {
	it('counts creations past the 120-item mark for a creator', async () => {
		const res = await call({ url: `/api/creations?op=creator&id=${OLDEST_AUTHOR}` });
		expect(res.statusCode).toBe(200);
		// All five of this author's items live in the oldest tail of the feed.
		expect(res.json.creator.creationCount).toBe(5);
		expect(res.json.creations).toHaveLength(5);
	});

	it('reports a total covering the whole scanned feed, so pagination reaches the tail', async () => {
		const first = await call({ url: '/api/creations?limit=36' });
		expect(first.json.total).toBe(SEEDED);
		expect(first.json.hasMore).toBe(true);

		const last = await call({ url: '/api/creations?limit=36&page=4' });
		expect(last.json.creations.length).toBe(SEEDED - 4 * 36);
		expect(last.json.hasMore).toBe(false);
	});

	it('aggregates every creator in the feed, not just the newest page', async () => {
		const res = await call({ url: '/api/creations?op=creators&limit=50' });
		expect(res.statusCode).toBe(200);
		const keys = res.json.creators.map((c) => c.key);
		expect(keys).toContain(OLDEST_AUTHOR);
		const total = res.json.creators.reduce((n, c) => n + c.creationCount, 0);
		expect(total).toBe(SEEDED);
	});
});

describe('/api/creations publish and remix lineage', () => {
	it('publishes, links a remix, and reflects the lineage in item + trending', async () => {
		const parent = await call({
			method: 'POST',
			body: {
				op: 'publish',
				prompt: 'a lowpoly fantasy knight',
				glbUrl: GLB('parent'),
				author: 'audit-parent',
				title: 'Knight',
				tags: ['knight', 'armor'],
				type: 'character',
				style: 'lowpoly',
				license: 'remix-royalty',
			},
		});
		expect(parent.statusCode).toBe(201);
		const parentId = parent.json.creation.id;
		expect(parent.json.creation.title).toBe('Knight');
		expect(parent.json.creation.remixCount).toBe(0);

		const child = await call({
			method: 'POST',
			body: {
				op: 'publish',
				prompt: 'a lowpoly fantasy knight, now on horseback',
				glbUrl: GLB('child'),
				author: 'audit-remixer',
				parentId,
			},
		});
		expect(child.statusCode).toBe(201);
		const childId = child.json.creation.id;

		const item = await call({ url: `/api/creations?op=item&id=${parentId}` });
		expect(item.statusCode).toBe(200);
		expect(item.json.creation.remixCount).toBe(1);
		expect(item.json.lineage.children.map((c) => c.id)).toEqual([childId]);
		// The batched enrich must still produce a full record for each child.
		expect(item.json.lineage.children[0]).toMatchObject({
			id: childId,
			author: 'audit-remixer',
			parentId,
			licenseInfo: expect.objectContaining({ remixable: true }),
		});
		expect(item.json.provenance.some((p) => p.event === 'remixed-by')).toBe(true);

		const trending = await call({ url: '/api/creations?op=trending' });
		expect(trending.json.trending.map((c) => c.id)).toContain(parentId);
		expect(trending.json.recentRemixes[0]).toMatchObject({ parentId, childId });
	});
});

describe('/api/creations failure paths', () => {
	it('rejects an unknown GET op', async () => {
		const res = await call({ url: '/api/creations?op=bogus' });
		expect(res.statusCode).toBe(400);
		expect(res.json.error).toBe('bad_request');
	});

	it('404s an item that does not exist', async () => {
		const res = await call({ url: '/api/creations?op=item&id=no-such-creation' });
		expect(res.statusCode).toBe(404);
		expect(res.json.error).toBe('not_found');
	});

	it('rejects a publish whose glbUrl is not on an allowed host', async () => {
		const res = await call({
			method: 'POST',
			body: { op: 'publish', prompt: 'a robot', glbUrl: 'https://evil.example/pwn.glb' },
		});
		expect(res.statusCode).toBe(400);
		expect(res.json.error).toBe('invalid_glb_url');
	});

	it('refuses a self-referential remix edge', async () => {
		const res = await call({
			method: 'POST',
			body: { op: 'remix', parentId: 'audit-seed-000', childId: 'audit-seed-000' },
		});
		expect(res.statusCode).toBe(400);
		expect(res.json.error_description).toMatch(/cannot remix itself/);
	});

	it('rejects a non-GET, non-POST method', async () => {
		const res = await call({ method: 'DELETE' });
		expect(res.statusCode).toBe(405);
	});
});
