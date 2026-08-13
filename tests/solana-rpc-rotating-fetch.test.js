import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	makeRotatingFetch,
	classifyRpcBody,
	markEndpointCooldown,
} from '../api/_lib/solana/connection.js';

// A Response carrying either a raw string body or a JSON-encoded object, the way a
// Solana RPC node answers a JSON-RPC POST.
const resp = (body, status = 200) =>
	new Response(typeof body === 'string' ? body : JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
const VALID = { jsonrpc: '2.0', id: 1, result: { ok: true } };

// makeRotatingFetch must NEVER hand its caller (web3.js Connection or the
// /api/solana-rpc proxy) an unvalidated body. The specific production failure this
// guards: every endpoint cooling from a prior request used to fall back to a raw,
// unvalidated `fetch(soonest)` whose `[]` / HTML / truncated body went straight to
// the browser, where web3.js choked with a StructError (or silently mis-read `[]`).
describe('makeRotatingFetch — never leaks an unvalidated upstream body', () => {
	let origFetch;
	beforeEach(() => {
		origFetch = global.fetch;
	});
	afterEach(() => {
		global.fetch = origFetch;
	});

	it('fails over past a 200-but-empty `[]` body to the next healthy endpoint', async () => {
		const eps = ['https://leak-a1.test/', 'https://leak-a2.test/'];
		global.fetch = vi.fn(async (url) => (url === eps[0] ? resp('[]') : resp(VALID)));
		const out = await makeRotatingFetch(eps)(null, { method: 'POST', body: '{}' });
		expect((await out.json()).result).toEqual({ ok: true });
	});

	it('throws instead of returning `[]` when every endpoint yields garbage — even once all are cooling', async () => {
		const eps = ['https://leak-b1.test/', 'https://leak-b2.test/'];
		global.fetch = vi.fn(async () => resp('[]'));
		const rf = makeRotatingFetch(eps);
		// First request exercises and cools both endpoints.
		await expect(rf(null, { method: 'POST', body: '{}' })).rejects.toThrow();
		// Second request: both already cooling. The old code did a raw fetch(soonest)
		// and returned the `[]`; the fixed code validates the all-cooling pass and
		// still throws — the caller never sees an empty array.
		await expect(rf(null, { method: 'POST', body: '{}' })).rejects.toThrow();
	});

	it('recovers on a later request when a previously-cooled endpoint starts serving valid data', async () => {
		const eps = ['https://leak-c1.test/', 'https://leak-c2.test/'];
		let healthy = false;
		global.fetch = vi.fn(async () => (healthy ? resp({ ...VALID, result: 'recovered' }) : resp('[]')));
		const rf = makeRotatingFetch(eps);
		await expect(rf(null, { method: 'POST', body: '{}' })).rejects.toThrow(); // cools both
		healthy = true;
		// Both endpoints are still inside their cooldown window, so pass 1 skips them;
		// the cooldown-ignoring second pass re-probes and returns the now-valid body.
		const out = await rf(null, { method: 'POST', body: '{}' });
		expect((await out.json()).result).toBe('recovered');
	});

	it('returns a well-formed JSON-RPC result straight through without rotating', async () => {
		const eps = ['https://ok-d1.test/', 'https://ok-d2.test/'];
		const fetchSpy = vi.fn(async () => resp(VALID));
		global.fetch = fetchSpy;
		const out = await makeRotatingFetch(eps)(null, { method: 'POST', body: '{}' });
		expect((await out.json()).result).toEqual({ ok: true });
		// First healthy endpoint answers — no failover round-trips.
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	// A keyless lane that gates a method behind its paid/registered tier answers 200
	// with a method-shaped JSON-RPC error. It is provider-specific — the next lane
	// serves the call — so it must rotate rather than surface. Production symptom:
	// the ring leak scanner's getSignaturesForAddress and the balance reader's
	// getBalance both hard-failed whenever rotation cascaded onto Tatum.
	// -16401 is the code Tatum actually returns (verified live against
	// solana-mainnet.gateway.tatum.io); -32601 covers a provider that reuses the
	// standard method-not-found code for the same gate. Both must rotate, so the
	// match is on the message, never the code.
	it.each([
		[-16401, "Method 'getSignaturesForAddress' is not available for anonymous access. Please register at https://co.tatum.io/signup."],
		[-32601, "Method 'getBalance' is available for paid plans only. To access this feature, please upgrade your subscription at https://co.tatum.io/upgrade."],
	])('fails over past a provider tier gate (code %i)', async (code, message) => {
		const eps = [`https://tier-${-code}.test/`, `https://tier-${-code}-next.test/`];
		const gated = { jsonrpc: '2.0', id: 1, error: { code, message } };
		global.fetch = vi.fn(async (url) => (url === eps[0] ? resp(gated) : resp(VALID)));
		const out = await makeRotatingFetch(eps)(null, { method: 'POST', body: '{}' });
		expect((await out.json()).result).toEqual({ ok: true });
	});

	// A lane whose fetch THROWS (connection refused, DNS failure, or the 10s
	// attempt bound aborting a hung provider) must rotate to the next lane like
	// any other failure. Regression: `attemptSignal` was declared inside the try
	// block but read in the catch, where a try-scoped const is not visible, so
	// every thrown attempt raised ReferenceError out of the rotation instead of
	// failing over. That is how one hung free lane turned the /play balance gate
	// into a hard 502 (2026-08-13).
	it('fails over past a lane whose fetch throws, instead of leaking the throw', async () => {
		const eps = ['https://throw-e1.test/', 'https://throw-e2.test/'];
		global.fetch = vi.fn(async (url) => {
			if (url === eps[0]) throw new TypeError('fetch failed');
			return resp(VALID);
		});
		const out = await makeRotatingFetch(eps)(null, {
			method: 'POST',
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTokenAccountsByOwner', params: [] }),
		});
		expect((await out.json()).result).toEqual({ ok: true });
		expect(global.fetch).toHaveBeenCalledTimes(2);
	});

	// The mirror-image guard: a genuinely absent method is deterministic across every
	// provider, so rotating on it would just retry a guaranteed failure on each lane.
	// It must reach the caller untouched.
	it('surfaces a genuine method-not-found without rotating', async () => {
		const eps = ['https://mnf-1.test/', 'https://mnf-2.test/'];
		const missing = { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } };
		const fetchSpy = vi.fn(async () => resp(missing));
		global.fetch = fetchSpy;
		const out = await makeRotatingFetch(eps)(null, { method: 'POST', body: '{}' });
		expect((await out.json()).error.message).toBe('Method not found');
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});
});

// QuickNode signals an exhausted DAILY cap with `-32003 "daily request limit reached
// - upgrade your account"`. Over HTTP it arrives as a 429; on providers that answer
// 200 + JSON-RPC error it must still be treated as a fail-over signal (a capacity
// problem the next lane does not share), and it must park the endpoint for the long
// quota window, not a 10-minute rate-limit blip that re-probes a dead-for-the-day lane.
describe('provider daily-limit (-32003 / "request limit reached")', () => {
	const HOUR = 3_600_000;

	it('classifies a 200 + -32003 body as a fail-over (429), not a usable response', () => {
		const bad = classifyRpcBody(
			JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32003, message: 'daily request limit reached - upgrade your account' } }),
		);
		expect(bad).not.toBeNull();
		expect(bad.status).toBe(429);
	});

	it('classifies the phrase alone (unknown code) as capacity too', () => {
		const bad = classifyRpcBody(
			JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32099, message: 'request limit reached' } }),
		);
		expect(bad).not.toBeNull();
		expect(bad.status).toBe(429);
	});

	it('parks a daily-limit 429 for the long quota window, not the short rate-limit one', () => {
		const quota = markEndpointCooldown('https://q.daily-limit.test/', 429, 'daily request limit reached');
		const plain = markEndpointCooldown('https://q.plain-429.test/', 429, 'slow down');
		expect(quota).toBeGreaterThan(HOUR); // 6h quota park
		expect(plain).toBeLessThanOrEqual(15 * 60_000); // ~10m transient
	});

	it('fails over a 200 + -32003 endpoint to a healthy next lane', async () => {
		const origFetch = global.fetch;
		try {
			const capped = { jsonrpc: '2.0', id: 1, error: { code: -32003, message: 'daily request limit reached' } };
			const fetchSpy = vi.fn(async (url) =>
				String(url).includes('capped') ? resp(capped) : resp(VALID),
			);
			global.fetch = fetchSpy;
			const out = await makeRotatingFetch(['https://capped.test/', 'https://healthy.test/'])(null, {
				method: 'POST',
				body: '{}',
			});
			expect((await out.json()).result).toEqual({ ok: true });
			expect(fetchSpy).toHaveBeenCalledTimes(2);
		} finally {
			global.fetch = origFetch;
		}
	});
});
