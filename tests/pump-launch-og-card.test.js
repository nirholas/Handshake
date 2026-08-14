import { describe, it, expect } from 'vitest';
import { renderCard } from '../api/pump/launch-og.js';

// Guards the /launches/<mint> social card against three defects that shipped
// silently because an SVG that renders is indistinguishable from an SVG that
// renders the right numbers:
//   1. the live market cap was read from a `market_cap_in_usd` key pump.fun
//      does not emit, so MKT CAP never appeared for a coin still on the curve;
//   2. organic_score / bundle_score are 0..1 fractions in pump_coin_intel but
//      the gauge treated them as 0..100, drawing a 1 px bar labelled "0%";
//   3. a fatal DB read had to degrade to a branded card, never a 5xx.

const MINT = 'THREEsynthetic1111111111111111111111111111';

function baseCard(overrides = {}) {
	return {
		name: 'Synthetic Launch',
		symbol: 'SYN',
		logoBase64: null,
		qualityScore: 72,
		category: 'meme',
		isThreeWsLaunch: true,
		intel: null,
		outcome: null,
		liveMcap: null,
		...overrides,
	};
}

describe('launch-og renderCard', () => {
	it('renders a well-formed 1200x630 SVG for the minimum viable card', () => {
		const svg = renderCard(MINT, baseCard());
		expect(svg.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
		expect(svg).toContain('width="1200" height="630"');
		expect(svg).toContain('Synthetic Launch');
		expect(svg).toContain('$SYN');
		// No enrichment supplied, so the optional blocks stay out of the card.
		expect(svg).not.toContain('MKT CAP');
		expect(svg).not.toContain('ORGANIC BUY');
	});

	it('draws the live market cap a coin on the curve reports', () => {
		const svg = renderCard(MINT, baseCard({ liveMcap: 2_337_959 }));
		expect(svg).toContain('MKT CAP');
		expect(svg).toContain('$2.3M');
	});

	it('falls back to the recorded outcome market cap once a coin has an outcome', () => {
		const svg = renderCard(MINT, baseCard({
			liveMcap: null,
			outcome: { graduated: true, ath_market_cap_usd: 84_000 },
		}));
		expect(svg).toContain('GRADUATED');
		expect(svg).toContain('$84K');
	});

	it('scales the 0..1 organic and bundle fractions onto the percent gauge', () => {
		const svg = renderCard(MINT, baseCard({
			intel: { organic_score: 0.4279, bundle_score: 0.12, unique_buyers: 29 },
		}));
		// 42.79% of a 230 px bar, and the label reads the percentage, not the fraction.
		expect(svg).toContain('>43%<');
		expect(svg).toContain('width="98" height="8"');
		expect(svg).toContain('>12%<');
		expect(svg).toContain('UNIQUE BUYERS');
		expect(svg).toContain('>29<');
		// A clean launch keeps the amber bundle bar, not the red one.
		expect(svg).toContain('#f59e0b');
	});

	it('flags a coordinated launch in red once bundle passes the 0.3 threshold', () => {
		const svg = renderCard(MINT, baseCard({
			intel: { organic_score: 0.05, bundle_score: 0.61 },
		}));
		expect(svg).toContain('>61%<');
		expect(svg).toContain('#ef4444');
	});

	it('clamps a gauge score that exceeds its range instead of overflowing the bar', () => {
		const svg = renderCard(MINT, baseCard({ intel: { organic_score: 4, bundle_score: 0 } }));
		expect(svg).toContain('>100%<');
		expect(svg).toContain('width="230" height="8"');
	});

	it('escapes coin metadata so a hostile name cannot inject SVG markup', () => {
		const svg = renderCard(MINT, baseCard({ name: '<script>alert(1)</script>', symbol: 'a"b' }));
		expect(svg).not.toContain('<script>');
		expect(svg).toContain('&lt;script&gt;');
		expect(svg).toContain('&quot;');
	});

	it('still renders a branded card when every enrichment read failed', () => {
		const svg = renderCard(MINT, {
			name: '', symbol: '', logoBase64: null, qualityScore: null, category: '',
			isThreeWsLaunch: false, intel: null, outcome: null, liveMcap: null,
		});
		expect(svg).toContain('Unknown coin');
		expect(svg).toContain('THREE.WS');
		// Unknown quality reads as a placeholder, never as a fabricated score.
		expect(svg).toContain('>-<');
		expect(svg).not.toContain('undefined');
		expect(svg).not.toContain('NaN');
	});
});
