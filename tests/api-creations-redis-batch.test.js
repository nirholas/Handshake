// /api/creations against a configured Redis backend. The gallery's aggregation
// surfaces enrich a SCAN_CAP-deep slice of the Loom feed, and the audit found
// they were doing a GET + an LRANGE per creation: two Upstash REST round-trips
// per item, ~1200 HTTP calls to render one page of the feed. enrichAll batches
// them into one MGET plus one pipelined LRANGE.
//
// This pins BOTH halves of that fix against a recording fake client: the command
// count must stay flat as the feed grows, and the records it produces must be
// identical to what the per-item reads produced.
import { describe, it, expect, beforeEach, vi } from 'vitest';

// A minimal Redis stand-in covering exactly the commands these modules issue,
// recording every command so the test can assert on round-trip counts.
class FakeRedis {
	constructor() {
		this.store = new Map();
		this.lists = new Map();
		this.sets = new Map();
		this.calls = [];
	}

	_list(k) {
		if (!this.lists.has(k)) this.lists.set(k, []);
		return this.lists.get(k);
	}

	async get(k) {
		this.calls.push(['get', k]);
		return this.store.get(k) ?? null;
	}

	async set(k, v) {
		this.calls.push(['set', k]);
		this.store.set(k, v);
		return 'OK';
	}

	async mget(...keys) {
		const flat = keys.length === 1 && Array.isArray(keys[0]) ? keys[0] : keys;
		this.calls.push(['mget', flat.length]);
		return flat.map((k) => this.store.get(k) ?? null);
	}

	async lpush(k, v) {
		this.calls.push(['lpush', k]);
		this._list(k).unshift(v);
		return this._list(k).length;
	}

	async rpush(k, v) {
		this.calls.push(['rpush', k]);
		this._list(k).push(v);
		return this._list(k).length;
	}

	async ltrim(k, start, stop) {
		this.calls.push(['ltrim', k]);
		const list = this._list(k);
		this.lists.set(k, start < 0 ? list.slice(start) : list.slice(start, stop + 1));
		return 'OK';
	}

	async lrange(k, start, stop) {
		this.calls.push(['lrange', k]);
		return this._list(k).slice(start, stop + 1);
	}

	async scard(k) {
		this.calls.push(['scard', k]);
		return (this.sets.get(k) || new Set()).size;
	}

	async sadd(k, v) {
		this.calls.push(['sadd', k]);
		if (!this.sets.has(k)) this.sets.set(k, new Set());
		this.sets.get(k).add(v);
		return 1;
	}

	async sismember(k, v) {
		this.calls.push(['sismember', k]);
		return (this.sets.get(k) || new Set()).has(v) ? 1 : 0;
	}

	// One pipeline() + exec() is ONE round trip, which is the whole point of the
	// fix, so it records itself as a single call.
	pipeline() {
		const queued = [];
		const self = this;
		const builder = {
			lrange(k, start, stop) {
				queued.push(() => self._list(k).slice(start, stop + 1));
				return builder;
			},
			async exec() {
				self.calls.push(['pipeline', queued.length]);
				return queued.map((fn) => fn());
			},
		};
		return builder;
	}
}

const redis = new FakeRedis();
vi.mock('../api/_lib/redis.js', () => ({ getRedis: () => redis }));

const { writeCreation } = await import('../api/loom.js');
const { default: handler } = await import('../api/creations.js');

function mkReq(url) {
	return {
		method: 'GET',
		url,
		headers: { host: 'three.ws' },
		socket: { remoteAddress: '198.51.100.8' },
		on(event, cb) {
			if (event === 'end') queueMicrotask(() => cb());
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
		writeHead(code) {
			this.statusCode = code;
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

async function call(url) {
	const res = mkRes();
	await handler(mkReq(url), res);
	return res;
}

async function seed(count) {
	for (let i = 0; i < count; i++) {
		await writeCreation({
			id: `redis-seed-${String(i).padStart(3, '0')}`,
			prompt: `a voxel creature number ${i}`,
			glbUrl: `https://three.ws/models/redis-${i}.glb`,
			previewImageUrl: null,
			author: `creator-${i % 5}`,
			tier: null,
			backend: null,
			createdAt: 1_700_000_000_000 + i * 1000,
		});
	}
}

function overlayReads(calls) {
	return calls.filter(
		([cmd, arg]) =>
			cmd === 'mget' || cmd === 'pipeline' || (cmd === 'get' && String(arg).startsWith('cre:meta:')) ||
			(cmd === 'lrange' && String(arg).startsWith('cre:children:')),
	);
}

beforeEach(() => {
	redis.store.clear();
	redis.lists.clear();
	redis.sets.clear();
	redis.calls.length = 0;
});

describe('/api/creations overlay batching on Redis', () => {
	it('reads the whole feed slice in two overlay round-trips, however deep it is', async () => {
		await seed(40);
		redis.calls.length = 0;
		await call('/api/creations?limit=120');
		const overlay = overlayReads(redis.calls);

		// Exactly one MGET (all meta) and one pipeline (all children lists).
		expect(overlay.map(([cmd]) => cmd).sort()).toEqual(['mget', 'pipeline']);
		expect(overlay.find(([cmd]) => cmd === 'mget')[1]).toBe(40);
		expect(overlay.find(([cmd]) => cmd === 'pipeline')[1]).toBe(40);
	});

	it('does not grow its round-trip count as the feed grows', async () => {
		await seed(20);
		redis.calls.length = 0;
		await call('/api/creations?limit=120');
		const small = overlayReads(redis.calls).length;

		await seed(80);
		redis.calls.length = 0;
		await call('/api/creations?limit=120');
		const large = overlayReads(redis.calls).length;

		expect(small).toBe(2);
		expect(large).toBe(2);
	});

	it('returns the same enriched records the per-item reads produced', async () => {
		await seed(5);
		const feed = await call('/api/creations');
		expect(feed.statusCode).toBe(200);
		expect(feed.json.creations).toHaveLength(5);

		// The single-item path still enriches one creation at a time; the batched
		// feed entry for the same id must match it field for field.
		const newest = feed.json.creations[0];
		const item = await call(`/api/creations?op=item&id=${newest.id}`);
		expect(item.statusCode).toBe(200);
		const { childIds, ...single } = item.json.creation;
		expect(single).toEqual(newest);
		expect(childIds).toEqual([]);
	});

	it('survives an overlay MGET that returns nulls for un-overlaid creations', async () => {
		await seed(3);
		// Nothing wrote cre:meta:* for these, so every mget slot comes back null:
		// the legacy-Loom case the enrichment is explicitly defensive about.
		expect([...redis.store.keys()].some((k) => k.startsWith('cre:meta:'))).toBe(false);

		const res = await call('/api/creations');
		expect(res.statusCode).toBe(200);
		for (const c of res.json.creations) {
			expect(c.title).toBeTruthy();
			expect(c.license).toBe('remix-cc');
			expect(c.remixCount).toBe(0);
			expect(c.parentId).toBeNull();
		}
	});
});
