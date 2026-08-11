import { describe, it, expect } from 'vitest';
import { deriveCognition, shapeDecision, DOCTRINE } from '../api/agi/state.js';

const NOW = 1_800_000_000_000;

const perf = (over = {}) => ({
	closed_count: 8,
	open_count: 0,
	realized_pnl_sol: 0,
	unrealized_pnl_sol: 0,
	...over,
});

const decision = (over = {}) => ({
	id: 'dec-1',
	seq: 12,
	kind: 'buy',
	subject_ref: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
	rationale: 'fresh launch, clean wallet graph',
	confidence: '0.72',
	prediction: { direction: 'up' },
	decided_at: new Date(NOW - 30_000).toISOString(),
	observed: null,
	was_correct: null,
	pnl_sol: null,
	impact: null,
	outcome_status: null,
	...over,
});

describe('shapeDecision', () => {
	it('marks an unreconciled decision pending and coerces numerics', () => {
		const out = shapeDecision(decision(), 'mainnet');
		expect(out.seq).toBe(12);
		expect(out.confidence).toBe(0.72);
		expect(out.mint).toBe('FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump');
		expect(out.domain).toBe('trade');
		expect(out.outcome).toEqual({ status: 'pending' });
	});

	it('refuses to publish a non-address subject as a mint', () => {
		// The self-tuner keys its decisions by an internal arm uuid. Publishing that
		// as `mint` sent the page to solscan.io/token/<uuid>, a link to nothing.
		const out = shapeDecision(
			decision({ kind: 'optimize', subject_ref: 'bcb3de15-7b9e-4a22-a653-8076f624c908' }),
			'mainnet',
		);
		expect(out.mint).toBeNull();
		expect(out.subject_ref).toBe('bcb3de15-7b9e-4a22-a653-8076f624c908');
		expect(out.domain).toBe('operations');
	});

	it('classifies a trading verb as a trade even when its subject is not a mint', () => {
		const out = shapeDecision(decision({ kind: 'exit', subject_ref: 'position-4711' }), 'mainnet');
		expect(out.mint).toBeNull();
		expect(out.domain).toBe('trade');
	});

	it('carries a null subject through without inventing one', () => {
		const out = shapeDecision(decision({ kind: 'optimize', subject_ref: null }), 'mainnet');
		expect(out.mint).toBeNull();
		expect(out.subject_ref).toBeNull();
		expect(out.domain).toBe('operations');
	});

	it('attaches the on-chain proof url once an outcome is reconciled', () => {
		const out = shapeDecision(
			decision({
				outcome_status: 'reconciled',
				was_correct: true,
				pnl_sol: '1.25',
				impact: '0.4',
				observed: { sell_sig: 'SIG123' },
			}),
			'mainnet',
		);
		expect(out.outcome.status).toBe('reconciled');
		expect(out.outcome.was_correct).toBe(true);
		expect(out.outcome.pnl_sol).toBe(1.25);
		expect(out.outcome.proof_url).toBe('https://solscan.io/tx/SIG123');
	});

	it('points the proof url at the devnet cluster on devnet', () => {
		const out = shapeDecision(
			decision({ outcome_status: 'reconciled', was_correct: false, observed: { sell_sig: 'SIG9' } }),
			'devnet',
		);
		expect(out.outcome.proof_url).toBe('https://solscan.io/tx/SIG9?cluster=devnet');
	});

	it('leaves the proof url null when no sell signature was observed', () => {
		const out = shapeDecision(
			decision({ outcome_status: 'reconciled', was_correct: true, observed: {} }),
			'mainnet',
		);
		expect(out.outcome.proof_url).toBeNull();
	});
});

describe('deriveCognition', () => {
	it('awakens when there is no track record and no decisions', () => {
		const cog = deriveCognition({ reputation: null, perf: null, decisions: [], now: NOW });
		expect(cog.state).toBe('awakening');
		expect(cog.conviction).toBeNull();
		expect(cog.emotion).toBeNull();
		expect(cog.valence).toBeGreaterThanOrEqual(-1);
		expect(cog.arousal).toBeLessThanOrEqual(1);
	});

	it('reads conviction off the most recent decision and fires curiosity', () => {
		const decisions = [shapeDecision(decision({ decided_at: new Date(NOW - 20_000).toISOString() }), 'mainnet')];
		const cog = deriveCognition({ reputation: null, perf: perf(), decisions, now: NOW });
		expect(cog.state).toBe('conviction');
		expect(cog.conviction).toBe(0.72);
		expect(cog.emotion.trigger).toBe('curiosity');
	});

	it('celebrates a call that just paid off', () => {
		const decisions = [
			shapeDecision(
				decision({
					decided_at: new Date(NOW - 10 * 60_000).toISOString(),
					outcome_status: 'reconciled',
					was_correct: true,
					pnl_sol: '2.0',
					observed: { sell_sig: 'SIGWIN' },
				}),
				'mainnet',
			),
		];
		const cog = deriveCognition({ reputation: { score: 80 }, perf: perf(), decisions, now: NOW });
		expect(cog.state).toBe('vindicated');
		expect(cog.emotion.trigger).toBe('celebration');
		expect(cog.valence).toBeGreaterThan(0);
	});

	it('is humbled by a recent call that went against it', () => {
		const decisions = [
			shapeDecision(
				decision({
					decided_at: new Date(NOW - 10 * 60_000).toISOString(),
					outcome_status: 'reconciled',
					was_correct: false,
					pnl_sol: '-1.5',
					observed: { sell_sig: 'SIGLOSS' },
				}),
				'mainnet',
			),
		];
		const cog = deriveCognition({ reputation: { score: 20 }, perf: perf(), decisions, now: NOW });
		expect(cog.state).toBe('humbled');
		expect(cog.emotion.trigger).toBe('concern');
		expect(cog.valence).toBeLessThan(0);
	});

	it('goes dormant when the last call is stale and nothing is open', () => {
		const decisions = [shapeDecision(decision({ decided_at: new Date(NOW - 3 * 3_600_000).toISOString() }), 'mainnet')];
		const cog = deriveCognition({ reputation: null, perf: perf({ realized_pnl_sol: -0.014 }), decisions, now: NOW });
		expect(cog.state).toBe('dormant');
		expect(cog.summary).toContain('-0.014 SOL realized');
	});

	it('reports how many positions it is managing when holding', () => {
		const decisions = [shapeDecision(decision({ decided_at: new Date(NOW - 20 * 60_000).toISOString() }), 'mainnet')];
		const cog = deriveCognition({
			reputation: null,
			perf: perf({ open_count: 3, unrealized_pnl_sol: 0.5 }),
			decisions,
			now: NOW,
		});
		expect(cog.state).toBe('holding');
		expect(cog.label).toBe('Managing 3 open positions');
		expect(cog.arousal).toBeGreaterThan(0.3);
	});

	it('keeps every scalar inside its declared range on extreme inputs', () => {
		const decisions = [shapeDecision(decision({ confidence: '9.9' }), 'mainnet')];
		const cog = deriveCognition({
			reputation: { score: 100 },
			perf: perf({ unrealized_pnl_sol: 10_000, open_count: 99 }),
			decisions,
			now: NOW,
		});
		expect(cog.valence).toBeLessThanOrEqual(1);
		expect(cog.arousal).toBeLessThanOrEqual(1);
		expect(cog.conviction).toBe(1);
	});

	it('survives a decision with no timestamp instead of emitting NaN', () => {
		const decisions = [shapeDecision(decision({ decided_at: null }), 'mainnet')];
		const cog = deriveCognition({ reputation: null, perf: perf(), decisions, now: NOW });
		expect(Number.isFinite(cog.valence)).toBe(true);
		expect(Number.isFinite(cog.arousal)).toBe(true);
		expect(cog.state).toBe('hunting');
	});
});

describe('DOCTRINE', () => {
	it('states a narrow domain and is frozen', () => {
		expect(DOCTRINE.is_narrow).toBe(true);
		expect(DOCTRINE.refusals.length).toBeGreaterThan(0);
		expect(Object.isFrozen(DOCTRINE)).toBe(true);
	});
});
