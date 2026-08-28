// The sniper fleet's vitals chart: the wiring that decides WHY an armed arm is
// not trading. Every case here is a real verdict this chart got wrong at some
// point during the 2026-08-28 investigation, kept so it cannot get them wrong
// again. Pure: readings are injected, so nothing here touches a network or a DB.
import { describe, it, expect } from 'vitest';
import {
	sniperChart,
	entryActivity,
	contradiction,
	STALE_ENTRY_MS,
	STALE_FEED_MS,
	STALE_IMAGE_MS,
	OBSERVED_ACTING_MS,
} from '../api/_lib/agent-vitals/sniper-chart.js';

const NOW = Date.parse('2026-08-28T03:00:00.000Z');
const ago = (ms) => new Date(NOW - ms).toISOString();

/** A fully healthy set of readings for a rules arm. Individual tests break one thing. */
const healthy = (overrides = {}) => ({
	wallet: 'Wa11etAddre55',
	balanceSol: 0.5,
	feedFreshAt: ago(60_000),
	imageBuiltAt: ago(2 * 86_400_000),
	rpc: { ok: true, detail: 'slot 1' },
	cognition: { ok: true, detail: 'model answered' },
	...overrides,
	// Merged last and explicitly: spreading `overrides` over a pre-built
	// `strategy` replaces the whole row, so a test overriding one field would
	// silently drop `enabled` and assert against a disarmed arm.
	strategy: {
		agent_id: 'arm-1',
		label: 'rules-arm',
		enabled: true,
		kill_switch: false,
		decision_mode: 'rules',
		per_trade_lamports: 2_000_000, // 0.002 SOL
		...overrides.strategy,
	},
});

const attest = (input) => sniperChart(input, { now: NOW }).attest();

describe('sniperChart', () => {
	it('attests a fully healthy rules arm as able to enter', async () => {
		const verdict = await attest(healthy());
		expect(verdict.can.enter).toBe(true);
		expect(verdict.can.exit).toBe(true);
		expect(verdict.rootCauses).toEqual([]);
	});

	it('names a starved wallet and the exact SOL that fixes it', async () => {
		const verdict = await attest(healthy({ balanceSol: 0.000001 }));

		expect(verdict.can.enter).toBe(false);
		expect(verdict.rootCauses.map((r) => r.id)).toEqual(['solvency']);
		// The remedy has to carry the real number and the real address, or an
		// operator has to go and derive both before they can act on it.
		expect(verdict.remedies[0]).toMatch(/^send \d+\.\d{4} SOL to Wa11etAddre55/);
	});

	it('treats a shrunk wallet as able to trade, because the executor does', async () => {
		// resolveEntrySize shrinks rather than skips: an arm trading below its
		// configured size is working, and calling that a failure marks a live arm dead.
		// 0.02 SOL against a 0.05 SOL configured size: too little for the full
		// entry, enough for a smaller one once fee and ATA-rent headroom is kept.
		const verdict = await attest(healthy({ balanceSol: 0.02, strategy: { per_trade_lamports: 50_000_000 } }));
		expect(verdict.vital('solvency').status).toBe('up');
		expect(verdict.vital('solvency').detail).toMatch(/shrunk/);
	});

	it('reports an unread balance as unknown, never as a starved wallet', async () => {
		const verdict = await attest(healthy({ balanceSol: null }));
		expect(verdict.vital('solvency').status).toBe('unknown');
		// "cannot say" must not become "cannot act": one RPC blip would otherwise
		// page an operator to a fleet that is entirely fine.
		expect(verdict.can.enter).toBeNull();
	});

	it('reports a disarmed arm as a choice, not an infrastructure fault', async () => {
		const verdict = await attest(healthy({ strategy: { enabled: false } }));
		expect(verdict.rootCauses.map((r) => r.id)).toEqual(['armed']);
		expect(verdict.vital('armed').detail).toMatch(/disabled/);
	});

	it('reports an engaged kill switch distinctly from a disabled arm', async () => {
		const verdict = await attest(healthy({ strategy: { enabled: true, kill_switch: true } }));
		expect(verdict.vital('armed').detail).toMatch(/kill switch/);
	});

	it('does not make a rules arm depend on the deployment or the model chain', async () => {
		// The bug this pins: an early revision made every arm depend on deploy
		// freshness and reported an arm that had entered a position two minutes
		// earlier, on that very image, as definitively unable.
		const verdict = await attest(healthy({ imageBuiltAt: ago(60 * 86_400_000), cognition: { ok: false } }));
		expect(verdict.can.enter).toBe(true);
		expect(verdict.vital('cognition').status).toBe('up');
		expect(verdict.vital('cognition').detail).toMatch(/no model required/);
	});

	it('blocks an llm arm on a stale image and blames the image, not the model', async () => {
		const verdict = await attest(healthy({
			strategy: { decision_mode: 'llm' },
			imageBuiltAt: ago(STALE_IMAGE_MS + 86_400_000),
			cognition: { ok: false, detail: 'every rung failed' },
		}));

		expect(verdict.can.enter).toBe(false);
		// The model chain is a symptom of the stale image, so the image is the answer.
		expect(verdict.rootCauses.map((r) => r.id)).toEqual(['deploy-fresh']);
		expect(verdict.vital('cognition').status).toBe('blocked');
		expect(verdict.remedies[0]).toMatch(/gcloud builds submit/);
	});

	it('blames the model chain directly when the image is current', async () => {
		const verdict = await attest(healthy({
			strategy: { decision_mode: 'llm' },
			cognition: { ok: false, detail: 'every rung failed' },
		}));

		expect(verdict.rootCauses.map((r) => r.id)).toEqual(['cognition']);
		expect(verdict.remedies[0]).toMatch(/provider credits|billing hold/);
	});

	it('reports a stale launch feed as its own cause', async () => {
		const verdict = await attest(healthy({ feedFreshAt: ago(STALE_FEED_MS + 60_000) }));
		expect(verdict.rootCauses.map((r) => r.id)).toEqual(['feed']);
		expect(verdict.can.enter).toBe(false);
	});

	it('keeps exit available when only entry-side preconditions fail', async () => {
		// A fleet that can still close its open risk is not dead, and collapsing
		// that distinction tells an operator their positions are stranded when
		// they are not.
		const verdict = await attest(healthy({ balanceSol: 0, feedFreshAt: ago(10 * 86_400_000) }));
		expect(verdict.can.enter).toBe(false);
		expect(verdict.can.exit).toBe(true);
	});

	it('makes exit unavailable when the RPC is the thing that is down', async () => {
		const verdict = await attest(healthy({ rpc: { ok: false, detail: 'no slot' } }));
		expect(verdict.can.exit).toBe(false);
		expect(verdict.can.enter).toBe(false);
	});

	it('reports several independent causes at once without inventing an order', async () => {
		const verdict = await attest(healthy({ balanceSol: 0, feedFreshAt: ago(10 * 86_400_000) }));
		expect(verdict.rootCauses.map((r) => r.id).sort()).toEqual(['feed', 'solvency']);
	});

	it('explains itself as a causal sentence an operator can paste into a channel', async () => {
		const verdict = await attest(healthy({
			strategy: { decision_mode: 'llm', label: 'llm-kimi' },
			imageBuiltAt: ago(STALE_IMAGE_MS + 86_400_000),
		}));
		expect(verdict.explain()).toMatch(/llm-kimi: cannot enter because cognition is blocked, because deploy-fresh is down/);
	});
});

describe('entryActivity', () => {
	it('marks an arm that has never attempted an entry as stalled', () => {
		expect(entryActivity(null, { now: NOW })).toMatchObject({ stalled: true, ageMs: null });
	});

	it('marks a long-silent arm as stalled', () => {
		const activity = entryActivity(ago(STALE_ENTRY_MS + 86_400_000), { now: NOW });
		expect(activity.stalled).toBe(true);
		expect(activity.detail).toMatch(/last entry attempt \d+ days ago/);
	});

	it('does not mark a recently active arm as stalled', () => {
		expect(entryActivity(ago(60_000), { now: NOW }).stalled).toBe(false);
	});
});

describe('contradiction', () => {
	it('flags a verdict the ledger disproves', () => {
		// The whole point: a health model that cannot notice it is wrong will be
		// trusted right up until it matters.
		const text = contradiction(false, ago(2 * 60_000), { now: NOW });
		expect(text).toMatch(/attested UNABLE but this arm attempted an entry 2 min ago/);
	});

	it('stays silent when the model and the ledger agree', () => {
		expect(contradiction(true, ago(2 * 60_000), { now: NOW })).toBeNull();
		expect(contradiction(false, ago(OBSERVED_ACTING_MS + 60_000), { now: NOW })).toBeNull();
		expect(contradiction(false, null, { now: NOW })).toBeNull();
	});

	it('does not flag an unknown verdict, which claims nothing to contradict', () => {
		expect(contradiction(null, ago(60_000), { now: NOW })).toBeNull();
	});

	it('accepts a capability status string as well as can.enter', () => {
		expect(contradiction('unable', ago(60_000), { now: NOW })).toMatch(/attested UNABLE/);
		expect(contradiction('ready', ago(60_000), { now: NOW })).toBeNull();
	});
});
