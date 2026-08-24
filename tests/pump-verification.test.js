import { describe, it, expect, vi, afterEach } from 'vitest';
import { mapVerification, pumpCoinUrl, fetchPumpVerification } from '../api/_lib/pump-verification.js';
import { verifiedBadgeHTML } from '../src/pump/verified-badge.js';

// $THREE's own CA: the platform's coin, not a third-party mint.
const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

// A minimal record that passes isPumpLaunch() so fetchPumpCoin() accepts it.
const coin = (over = {}) => ({
	mint: THREE_MINT,
	bonding_curve: '6JPusJUySKktd56HCeQ54kZ4WUNb7fD4GqAQvyDDqMqy',
	complete: true,
	...over,
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('mapVerification', () => {
	it('reports the badge when pump.fun publishes it', () => {
		const v = mapVerification(coin({ verified: true }));
		expect(v.verified).toBe(true);
		expect(v.url).toBe(`https://pump.fun/coin/${THREE_MINT}`);
		expect(v.source).toBe('pumpfun');
	});

	it('reports false when pump.fun publishes no badge', () => {
		expect(mapVerification(coin({ verified: false })).verified).toBe(false);
	});

	it('reports null (unknown), not false, when the field is absent', () => {
		// An older cached record or a route that omits the field must never be
		// turned into a negative verdict.
		expect(mapVerification(coin()).verified).toBeNull();
	});

	it('reports null for a missing coin but still attributes the mint', () => {
		const v = mapVerification(null, THREE_MINT);
		expect(v.verified).toBeNull();
		expect(v.mint).toBe(THREE_MINT);
		expect(v.url).toBe(pumpCoinUrl(THREE_MINT));
	});

	it('ignores a non-boolean verified value', () => {
		expect(mapVerification(coin({ verified: 'yes' })).verified).toBeNull();
		expect(mapVerification(coin({ verified: 1 })).verified).toBeNull();
	});
});

describe('fetchPumpVerification', () => {
	it('resolves to unknown (never throws) when the upstream is down', async () => {
		vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('ECONNRESET'))));
		// A mint not used by the other cases, so the 5-minute cache can't answer it.
		const v = await fetchPumpVerification('THREEsynthetic1111111111111111111111111111');
		expect(v.verified).toBeNull();
		expect(typeof v.checked_at).toBe('number');
	});

	it('returns unknown for an empty mint without touching the network', async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);
		expect((await fetchPumpVerification('')).verified).toBeNull();
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});

describe('verifiedBadgeHTML render rule', () => {
	it('renders the badge only on an explicit true', () => {
		const html = verifiedBadgeHTML({ verified: true, pump_url: `https://pump.fun/coin/${THREE_MINT}` });
		expect(html).toContain('Verified on pump.fun');
		expect(html).toContain(`https://pump.fun/coin/${THREE_MINT}`);
		expect(html).toContain('rel="noopener"');
	});

	it('renders nothing when unverified, unknown, or absent', () => {
		expect(verifiedBadgeHTML({ verified: false })).toBe('');
		expect(verifiedBadgeHTML({ verified: null })).toBe('');
		expect(verifiedBadgeHTML({})).toBe('');
		expect(verifiedBadgeHTML(null)).toBe('');
	});

	it('falls back to the mint URL when the payload carries no pump_url', () => {
		expect(verifiedBadgeHTML({ verified: true, mint: THREE_MINT })).toContain(`https://pump.fun/coin/${THREE_MINT}`);
	});

	it('escapes the href so a hostile payload cannot break out of the attribute', () => {
		const html = verifiedBadgeHTML({ verified: true, pump_url: '"><script>x()</script>' });
		expect(html).not.toContain('<script>');
	});
});
