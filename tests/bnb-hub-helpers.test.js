// Pure helpers behind the /bnb hub page: block-time formatting and the
// track-availability gating that decides "live" vs "coming soon" per card.
// See the bnb-chain campaign, work order 19 (BNB hub page; retired, see git history): "Pure helpers (stat formatting,
// track-availability gating) in tests/".

import { describe, expect, it } from 'vitest';
import {
	formatBlockTime,
	formatBlockNumber,
	deltaFromTarget,
	trackLiveness,
	combineTrackStates,
} from '../src/bnb-hub-helpers.js';

describe('formatBlockTime', () => {
	it('returns an em dash for missing/invalid input', () => {
		expect(formatBlockTime(null)).toBe('—');
		expect(formatBlockTime(undefined)).toBe('—');
		expect(formatBlockTime(NaN)).toBe('—');
		expect(formatBlockTime(-5)).toBe('—');
	});
	it('formats sub-second readings with two decimals', () => {
		expect(formatBlockTime(450)).toBe('0.45s');
		expect(formatBlockTime(470)).toBe('0.47s');
		expect(formatBlockTime(0)).toBe('0.00s');
	});
	it('formats one-second-plus readings with one decimal', () => {
		expect(formatBlockTime(2000)).toBe('2.0s');
		expect(formatBlockTime(12340)).toBe('12.3s');
	});
});

describe('formatBlockNumber', () => {
	it('returns an em dash for missing/invalid input', () => {
		expect(formatBlockNumber(null)).toBe('—');
		expect(formatBlockNumber(NaN)).toBe('—');
	});
	it('locale-groups integers', () => {
		expect(formatBlockNumber(108693266)).toBe('108,693,266');
		expect(formatBlockNumber(0)).toBe('0');
	});
});

describe('deltaFromTarget', () => {
	it('returns null when either input is missing (e.g. testnet has no target)', () => {
		expect(deltaFromTarget(460, null)).toBeNull();
		expect(deltaFromTarget(null, 450)).toBeNull();
		expect(deltaFromTarget(460, 0)).toBeNull();
	});
	it('signs a slower-than-target measurement positive', () => {
		expect(deltaFromTarget(459, 450)).toBe('+2.0%');
	});
	it('signs a faster-than-target measurement negative', () => {
		expect(deltaFromTarget(432, 450)).toBe('-4.0%');
	});
	it('reads exactly-on-target as +0.0%', () => {
		expect(deltaFromTarget(450, 450)).toBe('+0.0%');
	});
});

describe('trackLiveness', () => {
	it('treats a network failure (null status) as coming-soon — fails closed', () => {
		expect(trackLiveness(null)).toBe('coming-soon');
	});
	it('treats 404 as coming-soon — the route genuinely is not deployed', () => {
		expect(trackLiveness(404)).toBe('coming-soon');
	});
	it('treats any 5xx as coming-soon — an erroring dependency never reads as shipped', () => {
		expect(trackLiveness(500)).toBe('coming-soon');
		expect(trackLiveness(503)).toBe('coming-soon');
	});
	it('treats 200 as live', () => {
		expect(trackLiveness(200)).toBe('live');
	});
	it('treats 405 as live — a POST-only endpoint probed with GET/HEAD still exists', () => {
		expect(trackLiveness(405)).toBe('live');
	});
	it('treats other 4xx (e.g. 400/401/403) as live — the route resolves', () => {
		expect(trackLiveness(400)).toBe('live');
		expect(trackLiveness(401)).toBe('live');
		expect(trackLiveness(403)).toBe('live');
	});
});

describe('combineTrackStates', () => {
	it('is coming-soon for an empty list', () => {
		expect(combineTrackStates([])).toBe('coming-soon');
		expect(combineTrackStates(undefined)).toBe('coming-soon');
	});
	it('is live only when every check is live', () => {
		expect(combineTrackStates(['live'])).toBe('live');
		expect(combineTrackStates(['live', 'live'])).toBe('live');
		expect(combineTrackStates(['live', 'coming-soon'])).toBe('coming-soon');
		expect(combineTrackStates(['coming-soon', 'coming-soon'])).toBe('coming-soon');
	});
});
