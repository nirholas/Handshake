// Unit tests for GET /api/animations/signatures, the measured motion index as
// an API. The measurements themselves are proven in tests/motion-signature.test.js;
// these cover the HTTP contract: single-clip and slot-fit modes, the similar
// ranking, list filters, and the guarantee that the served signature is the
// shipped index's own row plus derived words, never a reshaped copy.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const rlState = { success: true, limit: 60, remaining: 59, reset: 0 };
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { publicIp: vi.fn(async () => rlState) },
	clientIp: vi.fn(() => '127.0.0.1'),
}));

const handler = (await import('../../api/animations/signatures.js')).default;
const { slotFit, similarTo, describe: describeSig } = await import('../../src/runtime/motion-signature.js');
const { SLOTS, DEFAULT_ANIMATION_MAP } = await import('../../src/runtime/animation-slots.js');

const ROOT = resolve(import.meta.dirname, '..', '..');
const INDEX = JSON.parse(readFileSync(resolve(ROOT, 'public/animations/signatures.json'), 'utf8'));

function mockRes() {
	const chunks = [];
	return {
		statusCode: 0,
		headers: {},
		setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
		getHeader(k) { return this.headers[String(k).toLowerCase()]; },
		writeHead(status, headers) {
			this.statusCode = status;
			for (const [k, v] of Object.entries(headers || {})) this.setHeader(k, v);
			return this;
		},
		end(body) { if (body) chunks.push(body); return this; },
		get body() { return chunks.join(''); },
		get parsed() { return JSON.parse(chunks.join('')); },
	};
}

const mockReq = (url, method = 'GET') => ({
	method,
	url,
	headers: { host: 'three.ws' },
	socket: { remoteAddress: '127.0.0.1' },
});

async function get(url) {
	const res = mockRes();
	await handler(mockReq(url), res);
	return res;
}

beforeEach(() => {
	rlState.success = true;
});

describe('GET /api/animations/signatures: single clip', () => {
	it('serves the shipped row for a clip, with the derived words added', async () => {
		const res = await get('/api/animations/signatures?clip=idle');
		expect(res.statusCode).toBe(200);
		const sig = res.parsed.signature;
		// Every measured field survives to the wire unchanged.
		for (const [k, v] of Object.entries(INDEX.clips.idle)) expect(sig[k]).toEqual(v);
		expect(sig.description).toBe(describeSig(INDEX.clips.idle));
		expect(typeof sig.band).toBe('string');
	});

	it('404s an unknown clip with a pointer to the listing', async () => {
		const res = await get('/api/animations/signatures?clip=not-a-clip');
		expect(res.statusCode).toBe(404);
		expect(res.parsed.error).toBe('unknown_clip');
		expect(res.headers['cache-control']).toBe('no-store');
	});
});

describe('GET /api/animations/signatures: slot fit', () => {
	it('answers clip+slot with exactly what slotFit computes', async () => {
		const res = await get('/api/animations/signatures?clip=wave&slot=wave');
		expect(res.statusCode).toBe(200);
		const expected = slotFit('wave', INDEX.clips.wave);
		expect(res.parsed.fit.level).toBe(expected.level);
		expect(res.parsed.fit.message).toBe(expected.message);
		expect(res.parsed.fit.slot).toBe('wave');
	});

	it('answers a bare slot with the health of its own default clip', async () => {
		const res = await get('/api/animations/signatures?slot=fidget');
		expect(res.statusCode).toBe(200);
		expect(res.parsed.fit.defaultClip).toBe(DEFAULT_ANIMATION_MAP.fidget);
		// The defaults are held to 'ok' by tests/motion-signature.test.js, so a
		// warn here means this endpoint and the runtime disagree about the map.
		expect(res.parsed.fit.level).toBe('ok');
	});

	it('rejects an unknown slot and names the real ones', async () => {
		const res = await get('/api/animations/signatures?clip=wave&slot=frolic');
		expect(res.statusCode).toBe(400);
		expect(res.parsed.error).toBe('unknown_slot');
		for (const slot of SLOTS.slice(0, 3)) expect(res.parsed.error_description).toContain(slot);
	});
});

describe('GET /api/animations/signatures: similar', () => {
	it('ranks neighbors exactly the way the runtime helper does', async () => {
		const res = await get('/api/animations/signatures?similar=wave&limit=3');
		expect(res.statusCode).toBe(200);
		const expected = similarTo('wave', INDEX.clips, 3).map((m) => m.clip);
		expect(res.parsed.similar.map((m) => m.clip)).toEqual(expected);
		expect(res.parsed.similar).toHaveLength(3);
	});

	it('clamps the limit into 1..20', async () => {
		const res = await get('/api/animations/signatures?similar=wave&limit=999');
		expect(res.parsed.similar.length).toBeLessThanOrEqual(20);
	});
});

describe('GET /api/animations/signatures: listing', () => {
	it('lists every measured clip by default', async () => {
		const res = await get('/api/animations/signatures');
		expect(res.statusCode).toBe(200);
		expect(res.parsed.total).toBe(Object.keys(INDEX.clips).length);
		expect(res.parsed.clips.length).toBe(res.parsed.total);
		expect(res.headers['cache-control']).toContain('public');
	});

	it('filters are conjunctive and honest against the index', async () => {
		const res = await get('/api/animations/signatures?overlay=true&loop=clean&lead=arms');
		for (const c of res.parsed.clips) {
			expect(c.overlay).toBe(true);
			expect(c.loopClean).toBe(true);
			expect(c.lead).toBe('arms');
		}
		const manual = Object.values(INDEX.clips).filter((s) => s.overlay && s.loopClean && s.lead === 'arms');
		expect(res.parsed.total).toBe(manual.length);
	});

	it('sorts by any documented key in either direction', async () => {
		const res = await get('/api/animations/signatures?sort=energy&order=asc&limit=5');
		const energies = res.parsed.clips.map((c) => c.energy);
		expect(energies).toEqual(energies.slice().sort((a, b) => a - b));
	});

	it('rejects an unknown sort key instead of silently ignoring it', async () => {
		const res = await get('/api/animations/signatures?sort=vibes');
		expect(res.statusCode).toBe(400);
		expect(res.parsed.error).toBe('unknown_sort');
	});

	it('paginates without losing anyone', async () => {
		const a = await get('/api/animations/signatures?limit=50');
		const b = await get('/api/animations/signatures?limit=50&offset=50');
		const seen = new Set([...a.parsed.clips, ...b.parsed.clips].map((c) => c.clip));
		expect(seen.size).toBe(Math.min(100, a.parsed.total));
	});
});

describe('GET /api/animations/signatures: envelope', () => {
	it('rejects non-GET', async () => {
		const res = mockRes();
		await handler(mockReq('/api/animations/signatures', 'POST'), res);
		expect(res.statusCode).toBe(405);
	});

	it('429s when the public bucket is exhausted', async () => {
		rlState.success = false;
		const res = await get('/api/animations/signatures');
		expect(res.statusCode).toBe(429);
	});
});
