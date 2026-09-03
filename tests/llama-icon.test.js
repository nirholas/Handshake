// DeFiLlama's dimension feeds return chain rows whose logo URL drops the /icons
// path segment, so every chain icon on /fees 404'd and the console filled with
// them. normalizeLlamaLogo repairs exactly that case and leaves everything else
// byte-identical, so it stays correct once upstream fixes its own feed.

import { describe, it, expect } from 'vitest';
import { normalizeLlamaLogo } from '../api/_lib/llama-icon.js';

describe('normalizeLlamaLogo', () => {
	it('inserts the /icons segment a chain logo is missing', () => {
		expect(normalizeLlamaLogo('https://icons.llamao.fi/chains/rsz_base.jpg')).toBe(
			'https://icons.llamao.fi/icons/chains/rsz_base.jpg',
		);
	});

	it('keeps a percent-encoded chain name intact', () => {
		expect(normalizeLlamaLogo('https://icons.llamao.fi/chains/rsz_robinhood%20chain.jpg')).toBe(
			'https://icons.llamao.fi/icons/chains/rsz_robinhood%20chain.jpg',
		);
	});

	// Protocol rows in the very same payload are already correct, so the helper
	// has to be a no-op on them rather than doubling the segment.
	it('leaves an already-correct icons URL exactly as it is', () => {
		const good = 'https://icons.llamao.fi/icons/protocols/uniswap-v4';
		expect(normalizeLlamaLogo(good)).toBe(good);
	});

	it('is idempotent, so a repaired URL survives a second pass', () => {
		const once = normalizeLlamaLogo('https://icons.llamao.fi/chains/rsz_solana.jpg');
		expect(normalizeLlamaLogo(once)).toBe(once);
	});

	it('passes a non-llamao host straight through', () => {
		const other = 'https://example.com/chains/rsz_base.jpg';
		expect(normalizeLlamaLogo(other)).toBe(other);
	});

	it('answers null for a missing or non-string logo', () => {
		expect(normalizeLlamaLogo(null)).toBe(null);
		expect(normalizeLlamaLogo(undefined)).toBe(null);
		expect(normalizeLlamaLogo('')).toBe(null);
		expect(normalizeLlamaLogo(42)).toBe(null);
	});
});
