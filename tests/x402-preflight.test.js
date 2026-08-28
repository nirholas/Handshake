// x402 Preflight: the signed assurance that a seller can settle before you pay.
//
// Every case here is written against the incident that produced the format. On
// 2026-08-28 three.ws was a seller whose fee sponsor held 0.000899107 SOL
// against a 0.02 floor, so every payment it was handed failed at simulation with
// InsufficientFundsForRent. 95 attempts, 0 settled, three hours. Each of those
// buyers could have known before signing, from state the server already had.
//
// The properties under test are the ones a buyer's money rests on:
//   * a tampered report does not verify
//   * an expired attestation does not verify, at any layer
//   * an attestation for one origin cannot be presented as covering another
//   * "cannot tell" is never reported as "payable"
//   * the client half and the server half agree byte-for-byte on the signature,
//     which is what makes the browser SDK able to check the server's work
//
// The cross-implementation case at the end is the load-bearing one: the server
// signs with node crypto and @noble/curves, the SDK verifies with @noble/hashes
// and @noble/curves, and if their canonical JSON ever diverged every signature
// in the ecosystem would break silently.

import { describe, it, expect } from 'vitest';
import { Keypair } from '@solana/web3.js';

import {
	buildPreflightReport,
	decideNetworkPayability,
	signPreflight,
	verifyPreflight,
	networkVerdict,
	sampleConfidence,
	normalizeOrigin,
	PREFLIGHT_SPEC,
	PREFLIGHT_ENVELOPE_VERSION,
	PREFLIGHT_MAX_TTL_SECONDS,
} from '../api/_lib/x402/preflight.js';

import { verifyPreflight as sdkVerify, networkVerdict as sdkVerdict, payableNetworks } from '../packages/x402-preflight/src/verify.js';
import { preflight, assertPayable, chooseNetwork, guardedFetch, PreflightError, clearPreflightCache } from '../packages/x402-preflight/src/index.js';

const SIGNER = Keypair.generate();
const ORIGIN = 'https://three.ws';
const SOLANA = 'solana:mainnet';
const BASE = 'eip155:8453';

// The exact shape of the 2026-08-28 outage: Solana unpayable because the
// seller's sponsor is empty, Base healthy because it never used that sponsor.
function outageNetworks() {
	return {
		[SOLANA]: decideNetworkPayability({ configured: true, sponsorBelowFloor: true }),
		[BASE]: decideNetworkPayability({
			configured: true,
			settleStatus: 'ok',
			settleRate: 0.98,
			attempts: 412,
			windowHours: 3,
		}),
	};
}

function sign(networks = outageNetworks(), opts = {}) {
	const report = buildPreflightReport({ subject: ORIGIN, networks, ...opts });
	return signPreflight(report, SIGNER.secretKey);
}

describe('decideNetworkPayability: never guess in the buyer\'s disfavour', () => {
	it('names a dry sponsor as the reason, which no buyer action can fix', () => {
		const v = decideNetworkPayability({ configured: true, sponsorBelowFloor: true });
		expect(v.payable).toBe(false);
		expect(v.reason).toBe('sponsor_below_floor');
		// A human with a wallet has to act, so the back-off is minutes, not seconds.
		expect(v.retry_after).toBeGreaterThanOrEqual(300);
	});

	it('reports unknown, never payable, when nothing could be measured', () => {
		// The expensive mistake is a false `true`: the buyer makes an irreversible
		// transfer on the strength of it. A false `unknown` costs a retry.
		expect(decideNetworkPayability({ configured: true }).payable).toBe('unknown');
		expect(decideNetworkPayability({ configured: true, settleStatus: 'unknown' }).payable).toBe('unknown');
		expect(
			decideNetworkPayability({ configured: true, settleStatus: 'ok', facilitatorReachable: false }).payable,
		).toBe('unknown');
	});

	it('only says payable on positive evidence', () => {
		const v = decideNetworkPayability({
			configured: true,
			sponsorBelowFloor: false,
			settleStatus: 'ok',
			settleRate: 0.99,
			attempts: 300,
			windowHours: 3,
		});
		expect(v.payable).toBe(true);
		expect(v.retry_after).toBe(null);
	});

	it('treats a degraded rail as not payable rather than probably fine', () => {
		expect(decideNetworkPayability({ configured: true, settleStatus: 'degraded' }).payable).toBe(false);
		expect(decideNetworkPayability({ configured: true, settleStatus: 'down' }).payable).toBe(false);
	});

	it('carries the window and sample with every rate, so a rate is never a rumour', () => {
		const v = decideNetworkPayability({
			configured: true, sponsorBelowFloor: false, settleStatus: 'ok',
			settleRate: 1, attempts: 3, windowHours: 3,
		});
		// A 100% rate over 3 attempts must not read like a proven rail.
		expect(v.settle.attempts).toBe(3);
		expect(v.settle.window_hours).toBe(3);
		expect(v.settle.confidence).toBeLessThan(0.3);
	});
});

describe('sampleConfidence', () => {
	it('rises with the sample and never reaches certainty', () => {
		expect(sampleConfidence(0)).toBe(0);
		expect(sampleConfidence(10)).toBeLessThan(sampleConfidence(100));
		expect(sampleConfidence(1e9)).toBeLessThanOrEqual(0.99);
	});
});

describe('buildPreflightReport', () => {
	it('computes alternates so a client re-routes without a second round trip', () => {
		const env = sign();
		expect(networkVerdict(env, SOLANA).alternates).toEqual([BASE]);
		expect(networkVerdict(env, BASE).alternates).toEqual([]);
		expect(env.report.payable_any).toBe(true);
	});

	it('sorts networks so the signed bytes do not depend on gather order', () => {
		const a = buildPreflightReport({ subject: ORIGIN, networks: outageNetworks(), issuedAt: '2026-08-28T00:00:00.000Z' });
		const flipped = {};
		for (const k of Object.keys(outageNetworks()).reverse()) flipped[k] = outageNetworks()[k];
		const b = buildPreflightReport({ subject: ORIGIN, networks: flipped, issuedAt: '2026-08-28T00:00:00.000Z' });
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
	});

	it('caps the validity window, because an hour-long assurance is not one', () => {
		const env = sign(outageNetworks(), { ttlSeconds: 86_400 });
		const life = (Date.parse(env.report.expires_at) - Date.parse(env.report.issued_at)) / 1000;
		expect(life).toBe(PREFLIGHT_MAX_TTL_SECONDS);
	});
});

describe('verifyPreflight: the trust boundary', () => {
	it('accepts a well-formed attestation for the origin it names', () => {
		const v = verifyPreflight(sign(), { subject: 'https://three.ws/' });
		expect(v.valid).toBe(true);
		expect(v.issuer).toBe(SIGNER.publicKey.toBase58());
	});

	it('rejects a report edited after signing', () => {
		// The whole point: a seller cannot flip its own verdict to payable, and a
		// man in the middle cannot flip it either.
		const env = JSON.parse(JSON.stringify(sign()));
		env.report.networks[SOLANA].payable = true;
		expect(verifyPreflight(env).valid).toBe(false);
	});

	it('rejects a re-signed digest that no longer matches the body', () => {
		const env = JSON.parse(JSON.stringify(sign()));
		env.report.networks[SOLANA].payable = true;
		delete env.digest; // force the check onto the signature itself
		expect(verifyPreflight(env).reason).toBe('bad_signature');
	});

	it('rejects an expired attestation, which is the replay this format prevents', () => {
		const env = sign();
		const past = Date.parse(env.report.expires_at) + 120_000;
		const v = verifyPreflight(env, { now: past });
		expect(v.valid).toBe(false);
		expect(v.reason).toBe('expired');
		expect(v.expired).toBe(true);
	});

	it('tolerates honest clock drift without opening a replay window', () => {
		const env = sign();
		const barelyPast = Date.parse(env.report.expires_at) + 10_000;
		expect(verifyPreflight(env, { now: barelyPast }).valid).toBe(true);
		expect(verifyPreflight(env, { now: barelyPast + 60_000 }).valid).toBe(false);
	});

	it('rejects an attestation presented as covering a different origin', () => {
		const v = verifyPreflight(sign(), { subject: 'https://not-three.example' });
		expect(v.reason).toBe('subject_mismatch');
	});

	it('rejects a signature from an issuer the caller did not pin', () => {
		expect(verifyPreflight(sign(), { issuer: Keypair.generate().publicKey.toBase58() }).reason).toBe('issuer_mismatch');
	});

	it('rejects an attestation stamped in the future', () => {
		const env = sign(outageNetworks(), { issuedAt: new Date(Date.now() + 600_000).toISOString() });
		expect(verifyPreflight(env).reason).toBe('issued_in_future');
	});

	it('returns a verdict for garbage instead of throwing', () => {
		// A hostile seller must not be able to crash a paying agent's loop.
		for (const bad of [null, undefined, 42, 'nope', {}, { report: {} }, { spec: 'x', report: {} }]) {
			expect(() => verifyPreflight(bad)).not.toThrow();
			expect(verifyPreflight(bad).valid).toBe(false);
		}
	});

	it('rejects an unsupported envelope or report version outright', () => {
		const a = { ...sign(), spec: 'threews.x402.preflight.v99' };
		expect(verifyPreflight(a).reason).toBe('unsupported_envelope_version');
		const b = JSON.parse(JSON.stringify(sign()));
		b.report.spec = 'x402-preflight/99';
		expect(verifyPreflight(b).reason).toBe('unsupported_report_spec');
	});
});

describe('the SDK verifies exactly what the server signed', () => {
	// Load-bearing. The server hashes with node crypto, the SDK with
	// @noble/hashes, and they canonicalize JSON independently. If those two ever
	// disagreed, every signature would fail in browsers and nowhere else.
	it('agrees with the server implementation, digest for digest', () => {
		const env = sign();
		const mine = verifyPreflight(env, { subject: ORIGIN });
		const theirs = sdkVerify(env, { subject: ORIGIN });
		expect(theirs.valid).toBe(true);
		expect(theirs.digest).toBe(mine.digest);
	});

	it('agrees on every rejection too', () => {
		const env = JSON.parse(JSON.stringify(sign()));
		env.report.networks[SOLANA].payable = true;
		expect(sdkVerify(env).valid).toBe(false);
		expect(sdkVerify(env).reason).toBe(verifyPreflight(env).reason);
	});

	it('reads the same verdicts and payable set', () => {
		const env = sign();
		expect(sdkVerdict(env, SOLANA).reason).toBe('sponsor_below_floor');
		expect(payableNetworks(env)).toEqual([BASE]);
	});

	it('constants match across the two halves', () => {
		expect(PREFLIGHT_SPEC).toBe('x402-preflight/1');
		expect(PREFLIGHT_ENVELOPE_VERSION).toBe('threews.x402.preflight.v1');
	});
});

describe('normalizeOrigin', () => {
	it('ignores a trailing slash, a path and a case change', () => {
		expect(normalizeOrigin('https://Three.WS/')).toBe('https://three.ws');
		expect(normalizeOrigin('https://three.ws/api/x402/echo')).toBe('https://three.ws');
	});
});

// A fetch that serves one prepared envelope, so the client half is exercised
// end to end without a network or a live server.
function fetchServing(envelope, { status = 200, headers = {} } = {}) {
	return async () => ({
		ok: status >= 200 && status < 300,
		status,
		headers: { get: (k) => headers[k.toLowerCase()] ?? null },
		json: async () => envelope,
	});
}

describe('the client half, end to end', () => {
	it('fetches, verifies and returns the report', async () => {
		clearPreflightCache();
		const env = sign();
		const { report, verification } = await preflight(ORIGIN, { fetch: fetchServing(env), cache: false });
		expect(verification.valid).toBe(true);
		expect(report.subject).toBe(ORIGIN);
	});

	it('refuses to pay a seller whose rail cannot settle, and names the way out', async () => {
		clearPreflightCache();
		const err = await assertPayable(ORIGIN, SOLANA, { fetch: fetchServing(sign()), cache: false }).catch((e) => e);
		expect(err).toBeInstanceOf(PreflightError);
		expect(err.code).toBe('not_payable');
		expect(err.reason).toBe('sponsor_below_floor');
		expect(err.alternates).toEqual([BASE]);
		expect(err.retryAfter).toBeGreaterThan(0);
	});

	it('passes when the rail is healthy', async () => {
		clearPreflightCache();
		const { verdict } = await assertPayable(ORIGIN, BASE, { fetch: fetchServing(sign()), cache: false });
		expect(verdict.payable).toBe(true);
	});

	it('treats unknown as not payable unless the caller opts in at the call site', async () => {
		clearPreflightCache();
		const env = sign({ [SOLANA]: decideNetworkPayability({ configured: true }) });
		const f = fetchServing(env);
		await expect(assertPayable(ORIGIN, SOLANA, { fetch: f, cache: false })).rejects.toThrow(PreflightError);
		const ok = await assertPayable(ORIGIN, SOLANA, { fetch: f, cache: false, allowUnknown: true });
		expect(ok.verdict.payable).toBe('unknown');
	});

	it('rejects a seller serving an expired attestation', async () => {
		clearPreflightCache();
		const env = sign();
		const err = await preflight(ORIGIN, {
			fetch: fetchServing(env),
			cache: false,
			now: Date.parse(env.report.expires_at) + 120_000,
		}).catch((e) => e);
		expect(err.code).toBe('verification_failed');
		expect(err.reason).toBe('expired');
	});

	it('surfaces a seller that cannot sign as unavailable, not as healthy', async () => {
		clearPreflightCache();
		const err = await preflight(ORIGIN, {
			fetch: fetchServing(null, { status: 503, headers: { 'retry-after': '60' } }),
			cache: false,
		}).catch((e) => e);
		expect(err.code).toBe('unavailable');
		expect(err.retryAfter).toBe(60);
	});

	it('distinguishes a seller that has not adopted preflight from one that is broken', async () => {
		clearPreflightCache();
		const err = await preflight(ORIGIN, { fetch: fetchServing(null, { status: 404 }), cache: false }).catch((e) => e);
		expect(err.code).toBe('not_supported');
	});
});

describe('chooseNetwork', () => {
	it('honours the caller preference when it is payable', () => {
		const env = sign({
			[SOLANA]: decideNetworkPayability({ configured: true, sponsorBelowFloor: false, settleStatus: 'ok', settleRate: 1, attempts: 99, windowHours: 3 }),
			[BASE]: decideNetworkPayability({ configured: true, settleStatus: 'ok', settleRate: 1, attempts: 99, windowHours: 3 }),
		});
		expect(chooseNetwork(env, [SOLANA])).toBe(SOLANA);
	});

	it('falls back to a rail that works when the preferred one is down', () => {
		expect(chooseNetwork(sign(), [SOLANA])).toBe(BASE);
	});

	it('returns null rather than throwing when nothing is payable', () => {
		const env = sign({ [SOLANA]: decideNetworkPayability({ configured: true, sponsorBelowFloor: true }) });
		expect(chooseNetwork(env, [SOLANA])).toBe(null);
	});
});

describe('guardedFetch', () => {
	it('stops the request that would have burned a signature', async () => {
		clearPreflightCache();
		const env = sign({ [SOLANA]: decideNetworkPayability({ configured: true, sponsorBelowFloor: true }) });
		let paidCalls = 0;
		const inner = async (url) => {
			if (String(url).includes('.well-known')) return (await fetchServing(env)())
			paidCalls += 1;
			return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) };
		};
		const skips = [];
		const f = guardedFetch({ fetch: inner, prefer: [SOLANA], onSkip: (i) => skips.push(i) });
		await expect(f('https://three.ws/api/x402/echo')).rejects.toThrow(PreflightError);
		expect(paidCalls).toBe(0);
		expect(skips[0].reason).toBe('sponsor_below_floor');
	});

	it('re-routes to a payable rail and tells the seller which one', async () => {
		clearPreflightCache();
		const env = sign();
		let seen = null;
		const inner = async (url, init) => {
			if (String(url).includes('.well-known')) return (await fetchServing(env)());
			seen = init?.headers?.get?.('x-preflight-network');
			return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) };
		};
		const f = guardedFetch({ fetch: inner, prefer: [SOLANA] });
		await f('https://three.ws/api/x402/echo');
		expect(seen).toBe(BASE);
	});

	it('passes through a seller that has not adopted preflight', async () => {
		clearPreflightCache();
		let through = 0;
		const inner = async (url) => {
			if (String(url).includes('.well-known')) return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}) };
			through += 1;
			return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) };
		};
		await guardedFetch({ fetch: inner })('https://legacy.example/api/paid');
		expect(through).toBe(1);
	});

	it('fails closed for a non-adopting seller when the caller asks it to', async () => {
		clearPreflightCache();
		const inner = async () => ({ ok: false, status: 404, headers: { get: () => null }, json: async () => ({}) });
		await expect(
			guardedFetch({ fetch: inner, requirePreflight: true })('https://legacy.example/api/paid'),
		).rejects.toThrow(PreflightError);
	});
});
