// @vitest-environment jsdom
/**
 * Launch Copilot panel: the engine-down banner.
 *
 * A policy only acts when a market-maker worker (workers/agent-mm) is sweeping
 * it. The dashboard used to look identical whether or not one was running, so an
 * armed maker that could never fire read as a maker at work. These tests mount
 * the real panel against the real API payload shape and assert the banner shows
 * exactly when it should, and never when the maker is genuinely being swept.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockApiFetch = vi.fn();
vi.mock('../src/api.js', () => ({
	apiFetch: (...a) => mockApiFetch(...a),
	default: { fetch: (...a) => mockApiFetch(...a) },
}));

const { mountLaunchCopilot } = await import('../src/launch-copilot.js');

const MINT = 'THREEsynthetic1111111111111111111111111111111';

function policyPayload(over = {}) {
	return {
		policy: {
			id: 'p1', mint: MINT, network: 'mainnet', status: 'active', mode: 'live', enabled: true,
			preset: 'balanced', kill_switch: false,
			floor_price_sol: 0.0001, floor_band_pct: 5, take_profit_band_pct: 25, recycle_pct: 20,
			min_action_interval_seconds: 60, max_volume_pct: 15, graduation_action: 'provide_lp',
			budgets: { dip_buy_sol: 0.5, daily_sol: 2, seed_sol: 0 },
			realized: { pnl_sol: 0, inventory_value_sol: 0, sol_deployed: 0, last_price_sol: 0.0001, inventory_tokens: 0 },
			disclosure: 'Non-manipulative by construction.',
			...over.policy,
		},
		owned: true,
		presets: [],
		guards: {},
		budget: { daily_spent_sol: 0, dip_spent_sol: 0, daily_remaining_sol: 2, dip_remaining_sol: 0.5 },
		actions: [],
		...over,
	};
}

/** Mount the panel and wait for its initial load to paint. */
async function mount(payload) {
	// apiFetch resolves a Response; the panel reads res.ok then res.json().
	mockApiFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: payload }) });
	const host = document.createElement('div');
	document.body.appendChild(host);
	mountLaunchCopilot(host, { mint: MINT, network: 'mainnet' });
	for (let i = 0; i < 20 && !host.querySelector('.lc-dash'); i++) await new Promise((r) => setTimeout(r, 10));
	return host;
}

// jsdom has no EventSource, and the panel opens the live action stream as soon as
// a policy loads. Stub the constructor so mounting exercises the real render path
// instead of dying on the stream (the stream itself is not what is under test).
class StubEventSource {
	constructor() { this.readyState = 0; }
	addEventListener() {}
	close() {}
}

beforeEach(() => {
	vi.clearAllMocks();
	globalThis.EventSource = StubEventSource;
});
afterEach(() => {
	document.body.innerHTML = '';
	delete globalThis.EventSource;
});

describe('Launch Copilot: engine-down banner', () => {
	it('warns, and says funds are untouched, when no engine has ever checked in', async () => {
		const host = await mount(policyPayload({
			engine: { live: false, mode: null, last_beat_at: null, seconds_since_beat: null, stale_after_seconds: 180 },
		}));
		const notice = host.querySelector('.lc-notice');
		expect(notice).toBeTruthy();
		expect(notice.textContent).toMatch(/engine is not running/i);
		expect(notice.textContent).toMatch(/saved and untouched/i);
		expect(notice.getAttribute('role')).toBe('status');
	});

	it('names how long ago a stale engine last checked in', async () => {
		const host = await mount(policyPayload({
			engine: {
				live: false, mode: 'simulate',
				last_beat_at: new Date(Date.now() - 3_600_000).toISOString(),
				seconds_since_beat: 3600, stale_after_seconds: 180,
			},
		}));
		expect(host.querySelector('.lc-notice').textContent).toMatch(/1h ago/);
	});

	it('stays silent when an engine is sweeping', async () => {
		const host = await mount(policyPayload({
			engine: { live: true, mode: 'live', last_beat_at: new Date().toISOString(), seconds_since_beat: 12, stale_after_seconds: 180 },
		}));
		expect(host.querySelector('.lc-dash')).toBeTruthy();
		expect(host.querySelector('.lc-notice')).toBeNull();
	});

	it('stays silent on a killed or graduated policy, where no engine is expected', async () => {
		for (const status of ['killed', 'graduated']) {
			const host = await mount(policyPayload({
				policy: { status, enabled: false },
				engine: { live: false, mode: null, last_beat_at: null, seconds_since_beat: null, stale_after_seconds: 180 },
			}));
			expect(host.querySelector('.lc-notice')).toBeNull();
			document.body.innerHTML = '';
		}
	});

	it('stays silent when the payload carries no engine field at all', async () => {
		const host = await mount(policyPayload());
		expect(host.querySelector('.lc-dash')).toBeTruthy();
		expect(host.querySelector('.lc-notice')).toBeNull();
	});
});
