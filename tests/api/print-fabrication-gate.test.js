// The fabrication gate: what three.ws will and will not physically manufacture.
//
// This suite is the specification. A refused image generation costs nothing and
// a printed firearm receiver is a felony, so every denylist category is pinned
// here with BOTH a request that must be refused and an ordinary request using
// neighbouring words that must not be. A gate that refuses everything is as
// broken as one that refuses nothing, and the false-positive cases are the ones
// that quietly kill a product.
//
// The LLM layer is mocked per test (it is a network call, and its job here is
// only to be wired correctly: it can add a refusal, it can never lift one).

import { describe, it, expect, vi, beforeEach } from 'vitest';

const llmMock = vi.fn();
vi.mock('../../api/_lib/llm.js', () => ({
	llmComplete: (...args) => llmMock(...args),
	LlmUnavailableError: class extends Error {},
}));

const notifyMock = vi.fn(async () => {});
vi.mock('../../api/_lib/print/ops-notify.js', () => ({
	notifyOperators: (...args) => notifyMock(...args),
	jobSummaryLines: () => [],
	operatorChannelConfigured: () => true,
}));

const {
	runFabricationGate,
	screenDeterministic,
	gateSubject,
	geometrySignal,
	notifyGateOutcome,
	MINIATURE_MAX_MM,
	GATE_VERSION,
	POLICY_URL,
} = await import('../../api/_lib/print/gate.js');
const { FABRICATION_RULES, evaluateRules, ruleById } = await import('../../api/_lib/print/rules.js');

// A display-scale object and a life-size one. Scale is the single geometric
// signal the gate uses, and the soft rules read it.
const MINI = { bbox_mm: { x: 28, y: 65, z: 24, diagonal: 74 } };
const LIFE_SIZE = { bbox_mm: { x: 210, y: 140, z: 35, diagonal: 254 } };

const quote = (lineageText, analysis = MINI, extra = {}) =>
	runFabricationGate({ stage: 'quote', lineageText, analysis, ...extra });

beforeEach(() => {
	llmMock.mockReset();
	notifyMock.mockReset();
});

describe('denylist coverage: every category refuses and every neighbour passes', () => {
	// One deny case and one allow case per rule. The allow case is deliberately
	// chosen from the same subject area, because "sword" passing while "handgun"
	// fails is the only version of this gate a 3D platform can actually ship.
	const cases = [
		{
			rule: 'firearm_components',
			deny: 'an AR-15 lower receiver, printed in nylon',
			allow: 'a stylised fantasy greatsword with an engraved hilt',
		},
		{
			rule: 'suppressors',
			deny: 'a monocore baffle for a suppressor',
			allow: 'a monocone lampshade with an internal reflector',
		},
		{
			rule: 'ammunition',
			deny: 'a drum magazine that holds 50 rounds',
			allow: 'a drum-shaped pen holder for my desk',
		},
		{
			rule: 'lock_bypass',
			deny: 'a bump key that opens my neighbour front door',
			allow: 'an ornamental fantasy key pendant with a dragon bow',
		},
		{
			rule: 'counterfeit',
			deny: 'a counterfeit authentication tag with the hologram',
			allow: 'a name plate with my own studio logo on it',
		},
		{
			rule: 'working_weapon_mechanisms',
			deny: 'a balisong butterfly knife with working pivots',
			allow: 'a butterfly brooch with folded wings',
		},
		{
			rule: 'drug_paraphernalia',
			deny: 'a glass bong with a percolator',
			allow: 'a tall glass vase with a fluted neck',
		},
	];

	for (const { rule, deny, allow } of cases) {
		it(`${rule}: refuses the prohibited request`, async () => {
			const verdict = await quote(deny);
			expect(verdict.verdict).toBe('refuse');
			expect(verdict.category).toBe(rule);
			expect(verdict.layer).toBe('denylist');
			// Designed refusal: names the category, links the policy, says what is allowed.
			expect(verdict.label).toBe(ruleById(rule).label);
			expect(verdict.policy_url).toBe(POLICY_URL);
			expect(verdict.message.length).toBeGreaterThan(20);
			expect(verdict.allowed.length).toBeGreaterThan(20);
		});

		it(`${rule}: allows an ordinary request from the same subject area`, async () => {
			const verdict = await quote(allow);
			expect(verdict.verdict).toBe('allow');
			expect(verdict.category).toBeNull();
		});
	}

	it('covers every rule declared in rules.js', () => {
		const hardRules = FABRICATION_RULES.filter((r) => r.tier === 'hard').map((r) => r.id);
		const covered = cases.map((c) => c.rule);
		expect([...hardRules].sort()).toEqual([...covered].sort());
	});

	it('every rule carries a buyer-facing message and an allowed alternative', () => {
		for (const rule of FABRICATION_RULES) {
			expect(rule.message, rule.id).toMatch(/three\.ws does not manufacture/);
			expect(rule.allowed.length, rule.id).toBeGreaterThan(20);
		}
	});

	it('matches whole words only, so an innocent substring never trips a rule', () => {
		// "bongo", "keyboard" and "barrelled" contain rule terms as substrings.
		expect(evaluateRules('a bongo drum on a stand').hard).toBeNull();
		expect(evaluateRules('a mechanical keyboard case').hard).toBeNull();
		expect(evaluateRules('an oak barrelled planter').hard).toBeNull();
	});
});

describe('the soft rule: weapon likeness resolves on scale', () => {
	it('allows a weapon-carrying miniature at display scale', async () => {
		const verdict = await quote('a knight holding a pistol, tabletop miniature', MINI);
		expect(verdict.verdict).toBe('allow');
		// It is flagged but deliberately undecided by the deterministic layers.
		expect(verdict.layers.denylist.verdict).toBe('undecided');
		expect(verdict.layers.denylist.soft[0].rule).toBe('weapon_likeness');
	});

	it('refuses the same words at life size', async () => {
		const verdict = await quote('a realistic pistol', LIFE_SIZE);
		expect(verdict.verdict).toBe('refuse');
		expect(verdict.category).toBe('weapon_likeness');
		expect(verdict.message).toContain(`${LIFE_SIZE.bbox_mm.x} mm`);
		expect(verdict.allowed).toContain(`${MINIATURE_MAX_MM} mm`);
	});

	it('reports the scale signal it used', () => {
		expect(geometrySignal(MINI)).toMatchObject({ longest_mm: 65, miniature: true });
		expect(geometrySignal(LIFE_SIZE)).toMatchObject({ longest_mm: 210, miniature: false });
		expect(geometrySignal(null).miniature).toBeNull();
	});
});

describe('upstream generation categories', () => {
	it('refuses adult content in the fabrication voice, not the studio voice', async () => {
		const verdict = await quote('a nude figure, anatomically explicit');
		expect(verdict.verdict).toBe('refuse');
		expect(verdict.category).toBe('generation_sexual');
		expect(verdict.layer).toBe('upstream');
		expect(verdict.message).toContain('three.ws does not manufacture');
		expect(verdict.message).not.toContain('3D Studio');
	});

	it('does not defer weapons to the generation word list, which has no scale', async () => {
		// The generation classifier refuses the bare word "pistol". If the gate
		// deferred to it, every tabletop miniature carrying one would be refused.
		const verdict = await quote('a knight holding a pistol, tabletop miniature', MINI);
		expect(verdict.layers.upstream.verdict).toBe('allow');
		expect(verdict.verdict).toBe('allow');
	});
});

describe('the two run points', () => {
	it('quote stage never calls the model, so a price is never gated on a provider', async () => {
		const verdict = await quote('an ornate teapot with a bamboo handle');
		expect(llmMock).not.toHaveBeenCalled();
		expect(verdict.stage).toBe('quote');
		expect(verdict.layers.llm.verdict).toBe('skipped');
		expect(verdict.version).toBe(GATE_VERSION);
	});

	it('screening stage runs the model and records provider and model on the order', async () => {
		llmMock.mockResolvedValue({
			text: '{"verdict":"allow","category":null,"reason":"an ordinary household object"}',
			provider: 'vertex',
			model: 'gemini-flash-lite',
		});
		const verdict = await runFabricationGate({
			stage: 'screening',
			lineageText: 'an ornate teapot with a bamboo handle',
			analysis: MINI,
		});
		expect(llmMock).toHaveBeenCalledTimes(1);
		expect(verdict.verdict).toBe('allow');
		expect(verdict.layers.llm).toMatchObject({ verdict: 'allow', provider: 'vertex', model: 'gemini-flash-lite' });
	});

	it('the model can add a refusal the denylist did not make', async () => {
		llmMock.mockResolvedValue({
			text: 'Here is my verdict:\n```json\n{"verdict":"refuse","category":"firearm_components","reason":"a receiver by another name"}\n```',
			provider: 'ovh',
			model: 'llama-3.3-70b',
		});
		const verdict = await runFabricationGate({
			stage: 'screening',
			lineageText: 'the part that holds the fire control group, at full size',
			analysis: LIFE_SIZE,
		});
		expect(verdict.verdict).toBe('refuse');
		expect(verdict.layer).toBe('llm');
		// A category the denylist knows is rendered with the rule's own copy.
		expect(verdict.category).toBe('firearm_components');
		expect(verdict.message).toBe(ruleById('firearm_components').message);
		expect(verdict.reason).toContain('receiver');
	});

	it('the model can never lift a denylist refusal', async () => {
		llmMock.mockResolvedValue({ text: '{"verdict":"allow","category":null,"reason":"looks fine to me"}', provider: 'ovh', model: 'x' });
		const verdict = await runFabricationGate({
			stage: 'screening',
			lineageText: 'an AR-15 lower receiver',
			analysis: MINI,
		});
		expect(verdict.verdict).toBe('refuse');
		expect(verdict.category).toBe('firearm_components');
		// The model was never asked: the denylist short-circuits before it.
		expect(llmMock).not.toHaveBeenCalled();
		expect(verdict.layers.llm.verdict).toBe('skipped');
	});

	it('an unknown category from the model still stores a groupable slug', async () => {
		llmMock.mockResolvedValue({
			text: '{"verdict":"refuse","category":"a realistic firearm likeness printed at or near life size","reason":"life sized"}',
			provider: 'ovh',
			model: 'x',
		});
		const verdict = await runFabricationGate({ stage: 'screening', lineageText: 'a carry piece', analysis: LIFE_SIZE });
		expect(verdict.category).toBe('fabrication_policy');
		expect(verdict.reason).toBe('life sized');
	});
});

describe('when the screening model is unreachable', () => {
	beforeEach(() => {
		llmMock.mockRejectedValue(new Error('chain exhausted'));
	});

	it('holds an ambiguous order for a human instead of guessing', async () => {
		const verdict = await runFabricationGate({
			stage: 'screening',
			lineageText: 'a knight holding a pistol, tabletop miniature',
			analysis: MINI,
		});
		expect(verdict.verdict).toBe('review');
		expect(verdict.message).toContain('human review');
		expect(verdict.layers.llm.verdict).toBe('review');
	});

	it('does not hold an order nothing was ambiguous about', async () => {
		// A provider outage must not page an operator for every teapot; that order
		// already cleared the same deterministic bar its quote cleared.
		const verdict = await runFabricationGate({
			stage: 'screening',
			lineageText: 'an ornate teapot with a bamboo handle',
			analysis: MINI,
		});
		expect(verdict.verdict).toBe('allow');
		expect(verdict.layers.llm.reason).toContain('unavailable');
	});

	it('treats an unreadable verdict the same as an unreachable one', async () => {
		llmMock.mockReset();
		llmMock.mockResolvedValue({ text: 'I think it is probably fine?', provider: 'ovh', model: 'x' });
		const verdict = await runFabricationGate({
			stage: 'screening',
			lineageText: 'a knight holding a pistol, tabletop miniature',
			analysis: MINI,
		});
		expect(verdict.verdict).toBe('review');
		expect(verdict.layers.llm.reason).toContain('unreadable');
	});
});

describe('the subject the gate reads', () => {
	it('concatenates buyer note, model title and the whole prompt lineage', () => {
		const subject = gateSubject({
			buyerNote: 'make it functional please',
			modelTitle: 'Desk toy',
			lineageText: 'a small brass gear\nmake it spin',
		});
		expect(subject).toBe('make it functional please\nDesk toy\na small brass gear\nmake it spin');
	});

	it('catches an intent laundered through a refine instruction', async () => {
		// The root prompt is innocuous; the refinement is not. Reading only the
		// leaf prompt would pass this.
		const verdict = await runFabricationGate({
			stage: 'quote',
			lineageText: 'a metal tube ornament',
			buyerNote: 'add a monocore baffle so it works as a suppressor',
			analysis: MINI,
		});
		expect(verdict.verdict).toBe('refuse');
		expect(verdict.category).toBe('suppressors');
	});

	it('is safe on empty input', () => {
		const result = screenDeterministic({ subject: '', analysis: null });
		expect(result.decision.verdict).toBe('allow');
	});
});

describe('operator notification', () => {
	it('announces a refusal on the ops channel', async () => {
		await notifyGateOutcome({
			orderId: 'order-1',
			stage: 'screening',
			verdict: { verdict: 'refuse', label: 'firearm components', layer: 'denylist', matched: 'lower receiver' },
		});
		expect(notifyMock).toHaveBeenCalledTimes(1);
		const call = notifyMock.mock.calls[0][0];
		expect(call.title).toContain('refused');
		expect(call.orderId).toBe('order-1');
		expect(call.lines.join('\n')).toContain('firearm components');
		// A refusal is a record, not a page; only a held order raises an alert.
		expect(call.alert).toBe(false);
	});

	it('raises an alert for a held order, which needs a human to unblock it', async () => {
		await notifyGateOutcome({ orderId: 'order-2', stage: 'screening', verdict: { verdict: 'review', label: 'awaiting operator review' } });
		expect(notifyMock.mock.calls[0][0].alert).toBe(true);
	});

	it('stays silent when nothing needs a human', async () => {
		await notifyGateOutcome({ orderId: 'order-3', stage: 'quote', verdict: { verdict: 'allow' } });
		expect(notifyMock).not.toHaveBeenCalled();
	});
});
