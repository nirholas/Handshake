// The one-line resilient fetch every api/** third-party call adopts:
// timeout, transient retry, Retry-After, ordered host fallback, last-good.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	fetchUpstream,
	fetchUpstreamJson,
	fetchAnyJson,
	lastGood,
	safeUrl,
	UpstreamError,
	_resetLastGood,
} from '../api/_lib/upstream-fetch.js';
import { _resetBreakers } from '../api/_lib/resilience.js';

const json = (body, init = {}) =>
	new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });

let origFetch;
beforeEach(() => {
	origFetch = global.fetch;
	_resetBreakers();
	_resetLastGood();
});
afterEach(() => {
	global.fetch = origFetch;
});

describe('fetchUpstream', () => {
	it('returns the response on 2xx without retrying', async () => {
		global.fetch = vi.fn(async () => json({ ok: 1 }));
		const res = await fetchUpstream('https://a.example/x');
		expect(res.status).toBe(200);
		expect(global.fetch).toHaveBeenCalledTimes(1);
	});

	it('passes a timeout signal to fetch', async () => {
		global.fetch = vi.fn(async (_u, init) => {
			expect(init.signal).toBeInstanceOf(AbortSignal);
			return json({});
		});
		await fetchUpstream('https://a.example/x', {}, { timeoutMs: 50 });
	});

	it('retries a 503 and then succeeds', async () => {
		let n = 0;
		global.fetch = vi.fn(async () => (++n < 3 ? new Response('down', { status: 503 }) : json({ n })));
		const data = await fetchUpstreamJson('https://a.example/x', {}, { attempts: 3 });
		expect(data).toEqual({ n: 3 });
		expect(global.fetch).toHaveBeenCalledTimes(3);
	});

	it('does not retry a 404 and surfaces status + body', async () => {
		global.fetch = vi.fn(async () => new Response('nope', { status: 404 }));
		await expect(fetchUpstream('https://a.example/x')).rejects.toMatchObject({
			name: 'UpstreamError',
			status: 404,
			body: 'nope',
		});
		expect(global.fetch).toHaveBeenCalledTimes(1);
	});

	it('gives up immediately on a Retry-After longer than it will wait', async () => {
		global.fetch = vi.fn(async () => new Response('slow down', { status: 429, headers: { 'retry-after': '120' } }));
		await expect(fetchUpstream('https://a.example/x', {}, { attempts: 3 })).rejects.toMatchObject({ status: 429, retryAfterMs: 120_000 });
		expect(global.fetch).toHaveBeenCalledTimes(1);
	});

	it('honours a short Retry-After before retrying', async () => {
		let n = 0;
		global.fetch = vi.fn(async () => (++n === 1 ? new Response('', { status: 429, headers: { 'retry-after': '0' } }) : json({ n })));
		await expect(fetchUpstreamJson('https://a.example/x', {}, { attempts: 2 })).resolves.toEqual({ n: 2 });
	});

	it('classifies a non-JSON 2xx body as a 502 upstream fault', async () => {
		global.fetch = vi.fn(async () => new Response('<html>cloudflare</html>', { status: 200 }));
		await expect(fetchUpstreamJson('https://a.example/x', {}, { attempts: 1 })).rejects.toMatchObject({ status: 502 });
	});

	it('opens the breaker after consecutive failures and stops calling fetch', async () => {
		global.fetch = vi.fn(async () => new Response('', { status: 500 }));
		const opts = { name: 'test:breaker', attempts: 1, breakerThreshold: 2 };
		await expect(fetchUpstream('https://a.example/x', {}, opts)).rejects.toBeInstanceOf(UpstreamError);
		await expect(fetchUpstream('https://a.example/x', {}, opts)).rejects.toBeInstanceOf(UpstreamError);
		const calls = global.fetch.mock.calls.length;
		await expect(fetchUpstream('https://a.example/x', {}, opts)).rejects.toBeInstanceOf(Error);
		expect(global.fetch.mock.calls.length).toBe(calls);
	});
});

describe('fetchAnyJson', () => {
	it('falls through to the next host and reports which one answered', async () => {
		global.fetch = vi.fn(async (url) => (String(url).includes('dead') ? new Response('', { status: 502 }) : json({ from: 'b' })));
		const r = await fetchAnyJson(['https://dead.example/', 'https://b.example/'], {}, { attempts: 1 });
		expect(r.value).toEqual({ from: 'b' });
		expect(r.index).toBe(1);
	});

	it('skips a healthy host whose body carries no usable data', async () => {
		global.fetch = vi.fn(async (url) => json(String(url).includes('a.') ? {} : { price: 1 }));
		const r = await fetchAnyJson(['https://a.example/', 'https://b.example/'], {}, { accept: (v) => v.price != null });
		expect(r.value.price).toBe(1);
	});

	it('throws a 503 when every host fails', async () => {
		global.fetch = vi.fn(async () => new Response('', { status: 500 }));
		await expect(fetchAnyJson(['https://a.example/', 'https://b.example/'], {}, { attempts: 1 })).rejects.toMatchObject({ status: 503 });
	});
});

describe('lastGood', () => {
	it('serves the previous value, flagged stale, when the loader fails', async () => {
		let fail = false;
		const load = async () => {
			if (fail) throw new Error('boom');
			return { v: 1 };
		};
		expect(await lastGood('k', load)).toMatchObject({ value: { v: 1 }, stale: false });
		fail = true;
		const r = await lastGood('k', load);
		expect(r.stale).toBe(true);
		expect(r.value).toEqual({ v: 1 });
	});

	it('rethrows when nothing was ever loaded', async () => {
		await expect(lastGood('empty', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
	});
});

describe('safeUrl', () => {
	it('redacts credential-looking query params', () => {
		expect(safeUrl('https://api.helius.xyz/v0/tx?api-key=abc&limit=1')).toBe('https://api.helius.xyz/v0/tx?api-key=REDACTED&limit=1');
	});
});
