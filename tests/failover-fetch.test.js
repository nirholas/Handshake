import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchFirst, fetchFirstOrNull } from '../src/shared/failover-fetch.js';

const json = (body, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// Unique provider names per test — the cooldown map is module-global, so
// reusing a name across tests would leak one test's penalty into the next.
let seq = 0;
const provider = (over = {}) => ({ name: `p${++seq}-${over.tag || 'x'}`, url: `https://p${seq}.test/`, ...over });

describe('fetchFirst — ordered multi-provider failover', () => {
	let origFetch;
	beforeEach(() => { origFetch = global.fetch; });
	afterEach(() => { global.fetch = origFetch; });

	it('returns the first provider that succeeds without touching the rest', async () => {
		const a = provider(), b = provider();
		global.fetch = vi.fn(async () => json({ v: 1 }));
		const out = await fetchFirst([a, b]);
		expect(out).toEqual({ value: { v: 1 }, source: a.name });
		expect(global.fetch).toHaveBeenCalledTimes(1);
	});

	it('rolls past a network error and an HTTP error to the next provider', async () => {
		const a = provider(), b = provider(), c = provider();
		global.fetch = vi.fn(async (url) => {
			if (url === a.url) throw new TypeError('network down');
			if (url === b.url) return json({}, 429);
			return json({ v: 'third' });
		});
		const out = await fetchFirst([a, b, c]);
		expect(out.source).toBe(c.name);
		expect(out.value).toEqual({ v: 'third' });
	});

	it('treats a parse returning null as a miss and moves on', async () => {
		const a = provider({ parse: async () => null });
		const b = provider();
		global.fetch = vi.fn(async () => json({ v: 2 }));
		const out = await fetchFirst([a, b]);
		expect(out.source).toBe(b.name);
	});

	it('throws when every provider fails', async () => {
		const a = provider(), b = provider();
		global.fetch = vi.fn(async () => json({}, 500));
		await expect(fetchFirst([a, b], { label: 'unit' })).rejects.toThrow(/unit: all 2 providers failed/);
	});

	it('skips a provider that errored recently (cooldown), but retries once it expires', async () => {
		const a = provider(), b = provider();
		global.fetch = vi.fn(async (url) => (url === a.url ? json({}, 500) : json({ v: 'b' })));
		// First call: a errors → cooled; b answers.
		expect((await fetchFirst([a, b], { cooldownMs: 50 })).source).toBe(b.name);
		// Second call inside the cooldown window: a must be skipped entirely.
		global.fetch.mockClear();
		global.fetch.mockImplementation(async () => json({ v: 'b2' }));
		const out = await fetchFirst([a, b], { cooldownMs: 50 });
		expect(out.source).toBe(b.name);
		expect(global.fetch).toHaveBeenCalledTimes(1);
		expect(global.fetch).toHaveBeenCalledWith(b.url, expect.anything());
		// After expiry, a is back in rotation.
		await new Promise((r) => setTimeout(r, 60));
		global.fetch.mockClear();
		global.fetch.mockImplementation(async () => json({ v: 'a again' }));
		expect((await fetchFirst([a, b])).source).toBe(a.name);
	});

	it('a miss (no_data) does NOT cool the provider down', async () => {
		const a = provider({ parse: async (r) => ((await r.json()).known ? { hit: true } : null) });
		const b = provider();
		global.fetch = vi.fn(async (url) => (url === a.url ? json({ known: false }) : json({ v: 'b' })));
		expect((await fetchFirst([a, b])).source).toBe(b.name);
		// Next query: a answers for a token it DOES know — it must still be tried first.
		global.fetch = vi.fn(async () => json({ known: true }));
		expect((await fetchFirst([a, b])).source).toBe(a.name);
	});

	it('probes cooled providers anyway when the whole chain is cooling', async () => {
		const a = provider();
		global.fetch = vi.fn(async () => json({}, 500));
		await expect(fetchFirst([a], { cooldownMs: 60_000 })).rejects.toThrow();
		// Sole provider is cooling — a cold chain still probes for recovery.
		global.fetch = vi.fn(async () => json({ v: 'recovered' }));
		expect((await fetchFirst([a])).value).toEqual({ v: 'recovered' });
	});

	it('aborts the whole chain without penalty when the caller signal fires', async () => {
		const ctrl = new AbortController();
		const a = provider({ init: { signal: ctrl.signal } });
		const b = provider({ init: { signal: ctrl.signal } });
		// Real fetch rejects straight away when handed an already-aborted signal,
		// and only fires the listener for an abort that arrives later. The stub has
		// to do both: fetchFirst now awaits the fault lookup before calling fetch,
		// so a caller that aborts immediately gets here with the signal already
		// set, and a listen-only stub would simply never settle.
		global.fetch = vi.fn((url, { signal }) => new Promise((_, reject) => {
			const fail = () => reject(new DOMException('aborted', 'AbortError'));
			if (signal.aborted) return fail();
			signal.addEventListener('abort', fail, { once: true });
		}));
		const pending = fetchFirst([a, b]);
		ctrl.abort();
		await expect(pending).rejects.toThrow();
		expect(global.fetch).toHaveBeenCalledTimes(1); // never moved on to b
		// Neither provider was cooled by the abort.
		global.fetch = vi.fn(async () => json({ v: 'ok' }));
		expect((await fetchFirst([{ ...a, init: {} }, { ...b, init: {} }])).source).toBe(a.name);
	});

	it('times out a hung provider and falls through to the next', async () => {
		const a = provider(), b = provider();
		global.fetch = vi.fn((url, { signal }) => {
			if (url === a.url) {
				return new Promise((_, reject) => {
					const fail = () => reject(new DOMException('aborted', 'AbortError'));
					if (signal.aborted) return fail();
					signal.addEventListener('abort', fail, { once: true });
				});
			}
			return Promise.resolve(json({ v: 'fast' }));
		});
		const out = await fetchFirst([a, b], { timeoutMs: 30 });
		expect(out.source).toBe(b.name);
	});
});

describe('fetchFirstOrNull — best-effort variant', () => {
	let origFetch;
	beforeEach(() => { origFetch = global.fetch; });
	afterEach(() => { global.fetch = origFetch; });

	it('resolves the value on success and the fallback on total failure', async () => {
		global.fetch = vi.fn(async () => json({ v: 9 }));
		expect(await fetchFirstOrNull([provider()])).toEqual({ v: 9 });
		global.fetch = vi.fn(async () => json({}, 500));
		expect(await fetchFirstOrNull([provider()])).toBeNull();
		global.fetch = vi.fn(async () => json({}, 500));
		expect(await fetchFirstOrNull([provider()], { fallback: [] })).toEqual([]);
	});
});
