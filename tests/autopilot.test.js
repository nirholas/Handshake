import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the data + heavy infra layers so the pure logic is testable in isolation.
const sqlMock = vi.fn();
vi.mock('../api/_lib/db.js', () => ({ sql: sqlMock, isDbUnavailableError: () => false, isDbCapacityError: () => false }));

const llmConfiguredMock = vi.fn(() => false);
const llmCompleteMock = vi.fn();
class LlmUnavailableError extends Error {}
vi.mock('../api/_lib/llm.js', () => ({
	llmComplete: (...a) => llmCompleteMock(...a),
	llmConfigured: (...a) => llmConfiguredMock(...a),
	LlmUnavailableError,
}));

const THREE_CA = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
vi.mock('../api/_lib/three-gate.js', () => ({
	THREE_CA,
	checkThreeBalance: vi.fn(async () => ({ balance: 0, eligible: true })),
}));
vi.mock('../api/_lib/agent-trade-guards.js', () => ({
	recordCustodyEvent: vi.fn(async () => 1),
	updateCustodyEvent: vi.fn(async () => {}),
}));

const {
	normalizeAutopilotConfig,
	validateProposal,
	proposalDedupeKey,
	heuristicProposals,
	actionMessage,
	computeTrust,
	decorateProposal,
	AUTOPILOT_DEFAULTS,
	AUTOPILOT_PROPOSAL_ACTIONS,
	pageLimit,
	parseCursor,
} = await import('../api/_lib/autopilot.js');

const MEM_A = '11111111-1111-1111-1111-111111111111';
const SYNTH_ADDR = 'THREEsynthetic1111111111111111111111111111';

describe('normalizeAutopilotConfig', () => {
	it('returns safe defaults for empty input', () => {
		const c = normalizeAutopilotConfig(undefined);
		expect(c.enabled).toBe(false);
		expect(c.scopes).toEqual({ create_alert: false, briefing: false, wallet_transfer: false });
		expect(c.daily_spend_sol).toBe(0);
		expect(c.require_confirm).toBe(true);
	});

	it('coerces scope/auto flags to booleans and clamps spend', () => {
		const c = normalizeAutopilotConfig({
			enabled: true,
			scopes: { create_alert: 'yes', briefing: true },
			auto_execute: { create_alert: 1 },
			daily_spend_sol: -5,
			require_confirm: false,
		});
		expect(c.enabled).toBe(true);
		expect(c.scopes.create_alert).toBe(false); // 'yes' is not strictly true
		expect(c.scopes.briefing).toBe(true);
		expect(c.auto_execute.create_alert).toBe(false); // 1 is not strictly true
		expect(c.daily_spend_sol).toBe(0); // negative clamped
		expect(c.require_confirm).toBe(false);
	});

	it('never lets require_confirm be implicitly false', () => {
		expect(normalizeAutopilotConfig({}).require_confirm).toBe(true);
		expect(AUTOPILOT_DEFAULTS.require_confirm).toBe(true);
	});
});

describe('validateProposal — create_alert', () => {
	it('builds a $THREE price_above rule from asset:"three"', () => {
		const v = validateProposal('create_alert', { asset: 'three', condition: 'price_above', threshold_usd: 50000 });
		expect(v.ok).toBe(true);
		expect(v.rule.target_mint).toBe(THREE_CA);
		expect(v.rule.kind).toBe('price_above');
		expect(v.rule.threshold).toBe(50000);
	});

	it('rejects a price rule with no positive threshold', () => {
		const v = validateProposal('create_alert', { asset: 'three', condition: 'price_above' });
		expect(v.ok).toBe(false);
	});

	it('requires a SOL threshold for whale_buy', () => {
		expect(validateProposal('create_alert', { asset: 'three', condition: 'whale_buy' }).ok).toBe(false);
		expect(validateProposal('create_alert', { asset: 'three', condition: 'whale_buy', threshold_sol: 10 }).ok).toBe(true);
	});

	it('accepts an explicit mint and rejects garbage assets', () => {
		expect(validateProposal('create_alert', { asset: THREE_CA, condition: 'graduation' }).ok).toBe(true);
		expect(validateProposal('create_alert', { asset: 'not an address', condition: 'graduation' }).ok).toBe(false);
	});

	it('rejects an unknown condition', () => {
		expect(validateProposal('create_alert', { asset: 'three', condition: 'moon' }).ok).toBe(false);
	});
});

describe('validateProposal — briefing & wallet_transfer', () => {
	it('validates briefing summary + cadence', () => {
		const v = validateProposal('briefing', { summary: 'Morning $THREE digest', cadence: 'daily' });
		expect(v.ok).toBe(true);
		expect(v.params.cadence).toBe('daily');
		expect(validateProposal('briefing', { summary: '' }).ok).toBe(false);
		// unknown cadence falls back to 'once'
		expect(validateProposal('briefing', { summary: 'x', cadence: 'hourly' }).params.cadence).toBe('once');
	});

	it('validates a wallet_transfer recipient + amount', () => {
		const v = validateProposal('wallet_transfer', { recipient: SYNTH_ADDR, amount_sol: 5, reason: 'tip' });
		expect(v.ok).toBe(true);
		expect(v.params.amount_sol).toBe(5);
		expect(validateProposal('wallet_transfer', { recipient: 'bad', amount_sol: 5 }).ok).toBe(false);
		expect(validateProposal('wallet_transfer', { recipient: SYNTH_ADDR, amount_sol: 0 }).ok).toBe(false);
		// Buy-only $THREE: a transfer routed through a token mint is refused.
		expect(validateProposal('wallet_transfer', { recipient: SYNTH_ADDR, amount_sol: 1, mint: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump' }).ok).toBe(false);
	});

	it('rejects unknown kinds', () => {
		expect(validateProposal('nuke_world', {}).ok).toBe(false);
	});
});

describe('proposalDedupeKey', () => {
	it('distinguishes different alerts and matches identical ones', () => {
		const a = validateProposal('create_alert', { asset: 'three', condition: 'price_above', threshold_usd: 1000 });
		const b = validateProposal('create_alert', { asset: 'three', condition: 'price_above', threshold_usd: 2000 });
		expect(proposalDedupeKey('create_alert', a.params)).not.toBe(proposalDedupeKey('create_alert', b.params));
		const a2 = validateProposal('create_alert', { asset: 'three', condition: 'price_above', threshold_usd: 1000 });
		expect(proposalDedupeKey('create_alert', a.params)).toBe(proposalDedupeKey('create_alert', a2.params));
	});
});

describe('heuristicProposals (LLM-free fallback)', () => {
	it('proposes a $THREE alert from a price memory, citing the memory', () => {
		const props = heuristicProposals([
			{ id: MEM_A, content: 'I want an alert when $THREE market cap hits $50k', tags: [] },
		]);
		const alert = props.find((p) => p.kind === 'create_alert');
		expect(alert).toBeTruthy();
		expect(alert.source_memory_ids).toEqual([MEM_A]);
		expect(alert.params.condition).toBe('price_above');
		expect(alert.params.threshold_usd).toBe(50000);
	});

	it('proposes a daily briefing from a routine memory', () => {
		const props = heuristicProposals([
			{ id: MEM_A, content: 'Catch me up on $THREE every morning please', tags: [] },
		]);
		const brief = props.find((p) => p.kind === 'briefing');
		expect(brief).toBeTruthy();
		expect(brief.params.cadence).toBe('daily');
		expect(brief.source_memory_ids).toEqual([MEM_A]);
	});

	it('proposes nothing for an unrelated memory', () => {
		expect(heuristicProposals([{ id: MEM_A, content: 'the sky is blue', tags: [] }])).toHaveLength(0);
	});
});

describe('actionMessage signing payload', () => {
	it('is stable regardless of payload key order', () => {
		const m1 = actionMessage({ agentId: 'a', type: 't', ts: '2026-01-01T00:00:00Z', payload: { b: 2, a: 1 } });
		const m2 = actionMessage({ agentId: 'a', type: 't', ts: '2026-01-01T00:00:00Z', payload: { a: 1, b: 2 } });
		expect(m1).toBe(m2);
		expect(m1).toContain('three.ws/autopilot');
		expect(m1).toContain('agent:a');
	});
});

describe('computeTrust', () => {
	beforeEach(() => sqlMock.mockReset());

	it('derives Sandbox at zero history', async () => {
		sqlMock.mockResolvedValueOnce([{ executed: 0, undone: 0, dismissed: 0, pending: 0 }]);
		const t = await computeTrust({ agentId: 'a' });
		expect(t.level).toBe('sandbox');
		expect(t.score).toBe(0);
		expect(t.next.label).toBe('Trusted');
	});

	it('rewards a clean track record and penalizes undos', async () => {
		sqlMock.mockResolvedValueOnce([{ executed: 10, undone: 0, dismissed: 0, pending: 0 }]);
		const clean = await computeTrust({ agentId: 'a' });
		sqlMock.mockResolvedValueOnce([{ executed: 10, undone: 8, dismissed: 0, pending: 0 }]);
		const messy = await computeTrust({ agentId: 'a' });
		expect(clean.score).toBeGreaterThan(messy.score);
		expect(clean.level).toBe('trusted');
	});
});

describe('decorateProposal', () => {
	it('maps a DB row to camelCase with iso dates', () => {
		const d = decorateProposal({
			id: 'p1', agent_id: 'a', user_id: 'u', kind: 'briefing', title: 'T', rationale: 'R',
			params: { summary: 'x' }, source_memory_ids: [MEM_A], source_reflection_id: null,
			confidence: 0.7, requires_confirmation: false, status: 'pending', executed_action_id: 42,
			result: {}, created_at: new Date('2026-06-23T00:00:00Z'), decided_at: null, executed_at: null,
		});
		expect(d.kind).toBe('briefing');
		expect(d.sourceMemoryIds).toEqual([MEM_A]);
		expect(d.executedActionId).toBe('42');
		expect(d.createdAt).toBe('2026-06-23T00:00:00.000Z');
	});
});

// The paging inputs reach Postgres directly on /api/autopilot/activity and
// /api/autopilot/proposals: a negative LIMIT and an out-of-range bigint cursor
// are both server errors there, so they have to be caught at the boundary.
describe('pageLimit', () => {
	it('falls back on missing, non-numeric, zero and negative input', () => {
		for (const raw of [null, undefined, '', 'abc', '0', '-5', '-1e9']) expect(pageLimit(raw)).toBe(50);
	});

	it('honors a valid size, truncates fractions and caps at the max', () => {
		expect(pageLimit('10')).toBe(10);
		expect(pageLimit('10.9')).toBe(10);
		expect(pageLimit('500')).toBe(200);
		expect(pageLimit('5', { fallback: 25, max: 3 })).toBe(3);
	});
});

describe('parseCursor', () => {
	it('treats missing and empty as the first page', () => {
		expect(parseCursor(null)).toEqual({ ok: true, cursor: null });
		expect(parseCursor('')).toEqual({ ok: true, cursor: null });
	});

	it('accepts a decimal id and preserves it verbatim', () => {
		expect(parseCursor('4077')).toEqual({ ok: true, cursor: '4077' });
		expect(parseCursor('9223372036854775807').ok).toBe(true);
	});

	it('rejects non-numeric, signed and over-long input', () => {
		expect(parseCursor('abc')).toEqual({ ok: false, reason: 'cursor must be numeric' });
		expect(parseCursor('-1').ok).toBe(false);
		expect(parseCursor('99999999999999999999999999')).toEqual({ ok: false, reason: 'cursor must be numeric' });
	});

	it('rejects a 19-digit value past the bigint ceiling', () => {
		expect(parseCursor('9223372036854775808')).toEqual({ ok: false, reason: 'cursor out of range' });
	});
});

describe('AUTOPILOT_PROPOSAL_ACTIONS', () => {
	it('is the frozen allowlist the proposals handler validates against', () => {
		expect(AUTOPILOT_PROPOSAL_ACTIONS).toEqual(['generate', 'dryrun', 'execute', 'dismiss', 'undo', 'adjust']);
		expect(Object.isFrozen(AUTOPILOT_PROPOSAL_ACTIONS)).toBe(true);
		expect(AUTOPILOT_PROPOSAL_ACTIONS.includes('nope')).toBe(false);
	});
});
