// Unit tests for the per-user Memetic Launcher endpoint's pure logic.
// The handler's I/O (auth, SQL) is exercised separately; here we lock down the
// safety-critical invariants: the dry-run lock, range validation, and clamping.

import { describe, it, expect } from 'vitest';
import {
	validateAndBuildPatch,
	shapeConfig,
	MODES,
	KNOWN_SOURCES,
	USER_MAX_DEV_BUY_SOL,
	USER_MAX_DAILY_SOL_CAP,
} from '../api/launcher/me.js';

const baseCur = {
	enabled: false,
	dry_run: true,
	mode: 'hybrid',
	sources: ['coin_intel', 'trending'],
	categories: [],
	target_cadence_seconds: 60,
	max_per_hour: 30,
	network: 'mainnet',
};

// Live mode shipped: dry_run is user-controllable, but the SAFE side must stay
// the default — a launcher only ever goes live on an EXPLICIT dry_run:false.
describe('user launcher — dry-run defaults (safety)', () => {
	it('enabling the launcher without mentioning dry_run keeps it in preview', () => {
		const r = validateAndBuildPatch({ enabled: true }, baseCur);
		expect(r.ok).toBe(true);
		expect(r.next.dry_run).toBe(true);
	});

	it('goes live only on an explicit dry_run:false', () => {
		const r = validateAndBuildPatch({ dry_run: false, enabled: true }, baseCur);
		expect(r.ok).toBe(true);
		expect(r.next.dry_run).toBe(false);
	});

	it('a missing dry_run column reads as preview, never live', () => {
		const shaped = shapeConfig({ ...baseCur, dry_run: undefined });
		expect(shaped.dry_run).toBe(true);
		expect(shaped.armed).toBe(false);
	});

	it('shapeConfig arms only an enabled, live, unpaused config', () => {
		expect(shapeConfig({ ...baseCur, enabled: true, dry_run: false }).armed).toBe(true);
		expect(shapeConfig({ ...baseCur, enabled: false, dry_run: false }).armed).toBe(false);
		expect(shapeConfig({ ...baseCur, enabled: true, dry_run: true }).armed).toBe(false);
		expect(shapeConfig({ ...baseCur, enabled: true, dry_run: false, paused: true }).armed).toBe(false);
	});

	it('shapeConfig returns null for a missing row', () => {
		expect(shapeConfig(null)).toBe(null);
	});
});

describe('user launcher — validation', () => {
	it('rejects an unknown mode', () => {
		const r = validateAndBuildPatch({ mode: 'nuke' }, baseCur);
		expect(r.ok).toBe(false);
		expect(r.code).toBe('invalid_mode');
	});

	it('accepts every supported mode', () => {
		for (const mode of MODES) expect(validateAndBuildPatch({ mode }, baseCur).ok).toBe(true);
	});

	it('rejects an unknown network', () => {
		expect(validateAndBuildPatch({ network: 'testnet' }, baseCur).code).toBe('invalid_network');
	});

	it('rejects a source outside the known set', () => {
		const r = validateAndBuildPatch({ sources: ['coin_intel', 'tiktok'] }, baseCur);
		expect(r.ok).toBe(false);
		expect(r.code).toBe('invalid_sources');
	});

	it('accepts the full known source set', () => {
		expect(validateAndBuildPatch({ sources: [...KNOWN_SOURCES] }, baseCur).ok).toBe(true);
	});

	it('rejects non-array categories', () => {
		expect(validateAndBuildPatch({ categories: 'memes' }, baseCur).code).toBe('invalid_categories');
	});

	it('rejects a cadence below the 60s floor', () => {
		expect(validateAndBuildPatch({ target_cadence_seconds: 5 }, baseCur).code).toBe('invalid_cadence');
	});

	it('rejects a max_per_hour above the 60 ceiling', () => {
		expect(validateAndBuildPatch({ max_per_hour: 999 }, baseCur).code).toBe('invalid_max_per_hour');
	});

	it('rejects a dev buy outside the user live-spend bound', () => {
		expect(validateAndBuildPatch({ dev_buy_sol: USER_MAX_DEV_BUY_SOL + 0.01 }, baseCur).code).toBe('invalid_dev_buy_sol');
		expect(validateAndBuildPatch({ dev_buy_sol: -0.1 }, baseCur).code).toBe('invalid_dev_buy_sol');
	});

	it('rejects a daily SOL cap outside the user live-spend bound', () => {
		expect(validateAndBuildPatch({ daily_sol_cap: USER_MAX_DAILY_SOL_CAP + 1 }, baseCur).code).toBe('invalid_daily_sol_cap');
		expect(validateAndBuildPatch({ daily_sol_cap: -1 }, baseCur).code).toBe('invalid_daily_sol_cap');
	});

	it('accepts in-range live-spend settings and carries them into the patch', () => {
		const r = validateAndBuildPatch({ dev_buy_sol: 0.05, daily_sol_cap: 2.5 }, baseCur);
		expect(r.ok).toBe(true);
		expect(r.next.dev_buy_sol).toBe(0.05);
		expect(r.next.daily_sol_cap).toBe(2.5);
	});

	it('keeps current live-spend settings on a partial patch', () => {
		const r = validateAndBuildPatch({ enabled: true }, { ...baseCur, dev_buy_sol: 0.2, daily_sol_cap: 3 });
		expect(r.next.dev_buy_sol).toBe(0.2);
		expect(r.next.daily_sol_cap).toBe(3);
	});
});

describe('user launcher — clamping + partial patch', () => {
	it('clamps cadence into [60, 86400] and rounds', () => {
		const r = validateAndBuildPatch({ target_cadence_seconds: 90.7 }, baseCur);
		expect(r.ok).toBe(true);
		expect(r.next.target_cadence_seconds).toBe(91);
	});

	it('clamps max_per_hour into [0, 60]', () => {
		// 60 is the ceiling and is accepted; the clamp guards rounding edge cases.
		const r = validateAndBuildPatch({ max_per_hour: 60 }, baseCur);
		expect(r.ok).toBe(true);
		expect(r.next.max_per_hour).toBe(60);
	});

	it('leaves unspecified fields untouched (partial update)', () => {
		const r = validateAndBuildPatch({ enabled: true }, baseCur);
		expect(r.next.mode).toBe('hybrid');
		expect(r.next.network).toBe('mainnet');
		expect(r.next.sources).toEqual(['coin_intel', 'trending']);
		expect(r.next.enabled).toBe(true);
	});

	it('coerces a jsonb-string current value into an array', () => {
		const r = validateAndBuildPatch({ enabled: true }, { ...baseCur, sources: '["x","oracle"]' });
		expect(r.next.sources).toEqual(['x', 'oracle']);
	});
});
