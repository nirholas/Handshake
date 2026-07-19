import { describe, it, expect } from 'vitest';

import { getSelfRegistry } from '../api/_lib/x402/autonomous-registry.js';
import {
	run,
	tokenDeltasByOwner,
	verifySettleAmount,
	verifySweepMovement,
	feeDivergence,
	MAX_PARSED_TX_PER_RUN,
	ORPHAN_GRACE_MINUTES,
	TRIPWIRE_WINDOW_MINUTES,
	FEE_DIVERGENCE_THRESHOLD,
} from '../api/_lib/x402/ring-reconciliation.js';

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TREASURY = 'TREASURYxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const PAYER = 'PAYERxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

// Captured-SQL mock. Routes each query by matching the table it reads, records
// every statement (text + values), and resolves [] for DDL / INSERT / UPSERT.
// `settle`, `sweep`, `buyer` are the three book loads; `feeLogged` and `feeAudit`
// answer the fee-coherence pair.
function mockSql({ settle = [], sweep = [], buyer = [], feeLogged = 0, feeAudit = undefined } = {}) {
	const calls = [];
	const fn = (strings, ...values) => {
		const text = strings.join('?').replace(/\s+/g, ' ').trim();
		calls.push({ text, values });
		if (/FROM x402_self_facilitator_log[\s\S]*action = 'settle'[\s\S]*ORDER BY ts/i.test(text)) return Promise.resolve(settle);
		if (/FROM x402_ring_ledger[\s\S]*GROUP BY tx_sig/i.test(text)) {
			// The per-tx totals aggregate: derive from the same sweep fixtures.
			const totals = new Map();
			for (const r of sweep) {
				if (!r.tx_sig) continue;
				totals.set(r.tx_sig, (totals.get(r.tx_sig) || 0) + Number(r.amount_atomic || 0));
			}
			return Promise.resolve([...totals].map(([tx_sig, total]) => ({ tx_sig, total })));
		}
		if (/FROM x402_ring_ledger/i.test(text)) return Promise.resolve(sweep);
		if (/FROM x402_autonomous_log[\s\S]*success = true/i.test(text)) return Promise.resolve(buyer);
		if (/COALESCE\(sum\(fee_lamports\)/i.test(text)) return Promise.resolve([{ total: feeLogged }]);
		if (/FROM x402_fee_audit/i.test(text)) {
			if (feeAudit === undefined) return Promise.reject(new Error('relation "x402_fee_audit" does not exist'));
			return Promise.resolve(feeAudit === null ? [] : [{ total_fee_lamports: feeAudit }]);
		}
		return Promise.resolve([]);
	};
	fn.calls = calls;
	return fn;
}

// Fake Solana connection. `statuses` maps sig → { found, err }; absent sigs
// resolve to null (RPC gap). `parsed` maps sig → parsed-tx object.
function mockConn({ statuses = {}, parsed = {} } = {}) {
	const parsedCalls = [];
	return {
		parsedCalls,
		getSignatureStatuses: async (sigs) => ({
			value: sigs.map((s) => (s in statuses ? statuses[s] : null)),
		}),
		getParsedTransaction: async (sig) => {
			parsedCalls.push(sig);
			return parsed[sig] ?? null;
		},
	};
}

// Build a parsed-tx whose token balance deltas move `amount` of MINT to `receiver`
// from `sender`. Balances are absolute pre/post; the module diffs them.
function parsedTransfer({ sender, receiver, amount, mint = MINT }) {
	return {
		meta: {
			preTokenBalances: [
				{ owner: sender, mint, uiTokenAmount: { amount: String(amount) } },
				{ owner: receiver, mint, uiTokenAmount: { amount: '0' } },
			],
			postTokenBalances: [
				{ owner: sender, mint, uiTokenAmount: { amount: '0' } },
				{ owner: receiver, mint, uiTokenAmount: { amount: String(amount) } },
			],
		},
	};
}

function captureAlerts() {
	const alerts = [];
	return { alerts, sendAlert: async (title, detail, opts) => { alerts.push({ title, detail, opts }); } };
}

function memCache() {
	const store = new Map();
	return { store, get: async (k) => store.get(k), set: async (k, v) => { store.set(k, v); } };
}

const NOW = 1_760_000_000_000; // fixed epoch ms so window math is deterministic
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

function baseCtx(overrides = {}) {
	return { now: NOW, ringEnabled: false, cache: memCache(), ...captureAlerts(), ...overrides };
}

// Route the module's env-derived treasury through the pure verifier tests instead
// of process.env — verifySweepMovement takes the treasury as an argument.

describe('ring-reconciliation — pure helpers', () => {
	it('tokenDeltasByOwner nets pre/post balances per owner', () => {
		const tx = parsedTransfer({ sender: TREASURY, receiver: PAYER, amount: 1_000_000 });
		const d = tokenDeltasByOwner(tx, MINT);
		expect(d.get(TREASURY)).toBe(-1_000_000n);
		expect(d.get(PAYER)).toBe(1_000_000n);
	});

	it('tokenDeltasByOwner returns null when balances are absent', () => {
		expect(tokenDeltasByOwner({ meta: {} }, MINT)).toBeNull();
		expect(tokenDeltasByOwner(null, MINT)).toBeNull();
	});

	it('verifySettleAmount passes on exact receiver credit', () => {
		const tx = parsedTransfer({ sender: PAYER, receiver: TREASURY, amount: 500_000 });
		expect(verifySettleAmount({ pay_to: TREASURY, mint: MINT, amount_atomic: 500_000 }, tx).ok).toBe(true);
	});

	it('verifySettleAmount fails on receiver amount mismatch', () => {
		const tx = parsedTransfer({ sender: PAYER, receiver: TREASURY, amount: 400_000 });
		const r = verifySettleAmount({ pay_to: TREASURY, mint: MINT, amount_atomic: 500_000 }, tx);
		expect(r.ok).toBe(false);
		expect(r.reason).toMatch(/receiver_got_400000_logged_500000/);
	});

	it('verifySettleAmount flags unparseable as soft (no false CRITICAL)', () => {
		const r = verifySettleAmount({ pay_to: TREASURY, mint: MINT, amount_atomic: 1 }, { meta: {} });
		expect(r.ok).toBe(false);
		expect(r.soft).toBe(true);
	});

	it('verifySweepMovement passes treasury→payer exact', () => {
		const tx = parsedTransfer({ sender: TREASURY, receiver: PAYER, amount: 2_000_000 });
		const r = verifySweepMovement({ from_wallet: TREASURY, to_wallet: PAYER, mint: MINT, amount_atomic: 2_000_000 }, tx, TREASURY);
		expect(r.ok).toBe(true);
	});

	it('verifySweepMovement rejects a non-treasury source', () => {
		const tx = parsedTransfer({ sender: PAYER, receiver: TREASURY, amount: 1 });
		const r = verifySweepMovement({ from_wallet: PAYER, to_wallet: TREASURY, mint: MINT, amount_atomic: 1 }, tx, TREASURY);
		expect(r.ok).toBe(false);
		expect(r.reason).toMatch(/sweep_source_not_treasury/);
	});

	it('verifySweepMovement rejects wrong amount', () => {
		const tx = parsedTransfer({ sender: TREASURY, receiver: PAYER, amount: 999 });
		const r = verifySweepMovement({ from_wallet: TREASURY, to_wallet: PAYER, mint: MINT, amount_atomic: 1_000 }, tx, TREASURY);
		expect(r.ok).toBe(false);
	});

	it('verifySweepMovement verifies each leg of a split sweep (payer + master revshare) via txTotal', () => {
		const MASTER = 'MasterWallet1111111111111111111111111111111';
		// One tx: treasury sends 1.0 USDC total (0.8 to payer, 0.2 to master).
		const tx = {
			meta: {
				preTokenBalances: [
					{ owner: TREASURY, mint: MINT, uiTokenAmount: { amount: '1000000' } },
					{ owner: PAYER, mint: MINT, uiTokenAmount: { amount: '0' } },
					{ owner: MASTER, mint: MINT, uiTokenAmount: { amount: '0' } },
				],
				postTokenBalances: [
					{ owner: TREASURY, mint: MINT, uiTokenAmount: { amount: '0' } },
					{ owner: PAYER, mint: MINT, uiTokenAmount: { amount: '800000' } },
					{ owner: MASTER, mint: MINT, uiTokenAmount: { amount: '200000' } },
				],
			},
		};
		const payerLeg = verifySweepMovement(
			{ from_wallet: TREASURY, to_wallet: PAYER, mint: MINT, amount_atomic: 800_000 }, tx, TREASURY, 1_000_000,
		);
		const masterLeg = verifySweepMovement(
			{ from_wallet: TREASURY, to_wallet: MASTER, mint: MINT, amount_atomic: 200_000 }, tx, TREASURY, 1_000_000,
		);
		expect(payerLeg.ok).toBe(true);
		expect(masterLeg.ok).toBe(true);
		// A leg claiming more than its on-chain credit still fails.
		const inflated = verifySweepMovement(
			{ from_wallet: TREASURY, to_wallet: MASTER, mint: MINT, amount_atomic: 300_000 }, tx, TREASURY, 1_000_000,
		);
		expect(inflated.ok).toBe(false);
	});

	it('feeDivergence: null when no audit figure, 0 when both zero, ratio otherwise', () => {
		expect(feeDivergence(100, null)).toBeNull();
		expect(feeDivergence(0, 0)).toBe(0);
		expect(feeDivergence(100, 100)).toBe(0);
		expect(feeDivergence(120, 100)).toBeCloseTo(0.1667, 3);
		expect(feeDivergence(100, 130)).toBeCloseTo(0.2308, 3);
	});
});

describe('ring-reconciliation — registry entry', () => {
	const entry = getSelfRegistry().find((e) => e.id === 'ring-reconciliation');

	it('exists, enabled, reconciliation pipeline, free, 30-min cooldown', () => {
		expect(entry).toBeTruthy();
		expect(entry.enabled).toBe(true);
		expect(entry.pipeline).toBe('reconciliation');
		expect(entry.price_atomic).toBe(0);
		expect(entry.cooldown_s).toBe(1800);
		expect(entry.cooldown_seconds).toBe(1800);
		expect(typeof entry.run).toBe('function');
	});
});

describe('ring-reconciliation run() — settle integrity (check 1)', () => {
	it('confirmed settle → reconciled verdict, no alert', async () => {
		const settle = [{ id: 1, ts: iso(60_000), payer: PAYER, pay_to: TREASURY, mint: MINT, amount_atomic: 1_000_000, tx_sig: 'sigOK' }];
		const sql = mockSql({ settle });
		const conn = mockConn({ statuses: { sigOK: { found: true, err: null } }, parsed: { sigOK: parsedTransfer({ sender: PAYER, receiver: TREASURY, amount: 1_000_000 }) } });
		const ctx = baseCtx({ sql, conn });
		const out = await run(ctx);

		expect(out.success).toBe(true);
		expect(out.responseData.settles_confirmed).toBe(1);
		expect(out.responseData.discrepancies).toBe(0);
		expect(ctx.alerts.length).toBe(0);
		const v = sql.calls.find((c) => /INSERT INTO payment_reconciliation/i.test(c.text));
		expect(v.values).toContain('ring_facilitator_settle');
	});

	it('settle whose tx is absent on-chain (null status) → CRITICAL x402_ring_settle_missing', async () => {
		const settle = [{ id: 2, ts: iso(60_000), payer: PAYER, pay_to: TREASURY, mint: MINT, amount_atomic: 1_000_000, tx_sig: 'sigGONE' }];
		const sql = mockSql({ settle });
		// A null value from getSignatureStatuses = the RPC searched and did NOT find
		// the signature → found:false → missing_onchain discrepancy.
		const conn = mockConn();
		conn.getSignatureStatuses = async (sigs) => ({ value: sigs.map(() => null) });
		const ctx = baseCtx({ sql, conn });
		const out = await run(ctx);

		expect(out.responseData.settles_missing).toBe(1);
		expect(out.responseData.discrepancies).toBe(1);
		const v = sql.calls.find((c) => /INSERT INTO payment_reconciliation/i.test(c.text) && c.values.includes('x402_ring_settle_missing'));
		expect(v).toBeTruthy();
	});

	it('RPC batch failure → unknown, NOT a discrepancy (self-heals next run)', async () => {
		const settle = [{ id: 3, ts: iso(60_000), payer: PAYER, pay_to: TREASURY, mint: MINT, amount_atomic: 1_000_000, tx_sig: 'sigRPCDOWN' }];
		const sql = mockSql({ settle });
		const conn = mockConn();
		conn.getSignatureStatuses = async () => { throw new Error('rpc_unreachable'); };
		const ctx = baseCtx({ sql, conn });
		const out = await run(ctx);

		expect(out.responseData.settles_unknown).toBe(1);
		expect(out.responseData.settles_missing).toBe(0);
		expect(out.responseData.discrepancies).toBe(0);
		expect(ctx.alerts.length).toBe(0);
	});

	it('settle reverted on-chain → CRITICAL x402_ring_settle_failed + page', async () => {
		const settle = [{ id: 4, ts: iso(60_000), payer: PAYER, pay_to: TREASURY, mint: MINT, amount_atomic: 1_000_000, tx_sig: 'sigFAIL' }];
		const sql = mockSql({ settle });
		const conn = mockConn({ statuses: { sigFAIL: { found: true, err: { InstructionError: [0, 'Custom'] } } } });
		const ctx = baseCtx({ sql, conn });
		const out = await run(ctx);

		expect(out.responseData.settles_failed).toBe(1);
		expect(out.responseData.discrepancies).toBe(1);
		const crit = ctx.alerts.find((a) => a.title.includes('ring reconciliation'));
		expect(crit).toBeTruthy();
		expect(crit.detail).toMatch(/x402_ring_settle_failed=1/);
		const v = sql.calls.find((c) => /INSERT INTO payment_reconciliation/i.test(c.text) && c.values.includes('x402_ring_settle_failed'));
		expect(v).toBeTruthy();
	});

	it('settle with no signature → CRITICAL missing_signature', async () => {
		const settle = [{ id: 5, ts: iso(60_000), payer: PAYER, pay_to: TREASURY, mint: MINT, amount_atomic: 1_000_000, tx_sig: null }];
		const sql = mockSql({ settle });
		const conn = mockConn();
		const ctx = baseCtx({ sql, conn });
		const out = await run(ctx);
		expect(out.responseData.settles_no_signature).toBe(1);
		expect(out.responseData.discrepancies).toBe(1);
	});
});

describe('ring-reconciliation run() — amount fidelity (check 2)', () => {
	it('receiver credited less than logged → CRITICAL x402_ring_amount_mismatch', async () => {
		const settle = [{ id: 10, ts: iso(60_000), payer: PAYER, pay_to: TREASURY, mint: MINT, amount_atomic: 1_000_000, tx_sig: 'sigSHORT' }];
		const sql = mockSql({ settle });
		const conn = mockConn({
			statuses: { sigSHORT: { found: true, err: null } },
			parsed: { sigSHORT: parsedTransfer({ sender: PAYER, receiver: TREASURY, amount: 400_000 }) },
		});
		const ctx = baseCtx({ sql, conn });
		const out = await run(ctx);
		expect(out.responseData.amount_mismatches).toBe(1);
		expect(out.responseData.discrepancies).toBe(1);
		const crit = ctx.alerts.find((a) => a.title.includes('ring reconciliation'));
		expect(crit.detail).toMatch(/x402_ring_amount_mismatch=1/);
	});
});

describe('ring-reconciliation run() — sweep integrity (check 3)', () => {
	it('valid treasury→payer sweep → reconciled', async () => {
		process.env.X402_PAY_TO_SOLANA = TREASURY;
		const sweep = [{ id: 20, ts: iso(60_000), from_wallet: TREASURY, to_wallet: PAYER, mint: MINT, amount_atomic: 3_000_000, tx_sig: 'sweepOK' }];
		const sql = mockSql({ sweep });
		const conn = mockConn({
			statuses: { sweepOK: { found: true, err: null } },
			parsed: { sweepOK: parsedTransfer({ sender: TREASURY, receiver: PAYER, amount: 3_000_000 }) },
		});
		const ctx = baseCtx({ sql, conn });
		const out = await run(ctx);
		expect(out.responseData.sweeps_confirmed).toBe(1);
		expect(out.responseData.sweep_mismatches).toBe(0);
		delete process.env.X402_PAY_TO_SOLANA;
	});

	it('sweep from a non-treasury source → CRITICAL x402_ring_sweep_mismatch', async () => {
		process.env.X402_PAY_TO_SOLANA = TREASURY;
		const sweep = [{ id: 21, ts: iso(60_000), from_wallet: PAYER, to_wallet: TREASURY, mint: MINT, amount_atomic: 3_000_000, tx_sig: 'sweepBAD' }];
		const sql = mockSql({ sweep });
		const conn = mockConn({
			statuses: { sweepBAD: { found: true, err: null } },
			parsed: { sweepBAD: parsedTransfer({ sender: PAYER, receiver: TREASURY, amount: 3_000_000 }) },
		});
		const ctx = baseCtx({ sql, conn });
		const out = await run(ctx);
		expect(out.responseData.sweep_mismatches).toBe(1);
		const v = sql.calls.find((c) => /INSERT INTO payment_reconciliation/i.test(c.text) && c.values.includes('x402_ring_sweep_mismatch'));
		expect(v).toBeTruthy();
		delete process.env.X402_PAY_TO_SOLANA;
	});
});

describe('ring-reconciliation run() — cross-log coherence (check 4)', () => {
	it('settlement with no buyer record (outside grace) → WARN orphan', async () => {
		const oldTs = iso((ORPHAN_GRACE_MINUTES + 5) * 60_000);
		const settle = [{ id: 30, ts: oldTs, payer: PAYER, pay_to: TREASURY, mint: MINT, amount_atomic: 1_000_000, tx_sig: 'sigORPHAN' }];
		const sql = mockSql({ settle, buyer: [] });
		const conn = mockConn({
			statuses: { sigORPHAN: { found: true, err: null } },
			parsed: { sigORPHAN: parsedTransfer({ sender: PAYER, receiver: TREASURY, amount: 1_000_000 }) },
		});
		const ctx = baseCtx({ sql, conn });
		const out = await run(ctx);
		expect(out.responseData.orphans_settle_side).toBe(1);
		const warn = ctx.alerts.find((a) => a.title.includes('cross-log orphans'));
		expect(warn).toBeTruthy();
	});

	it('settlement inside the grace window is NOT an orphan', async () => {
		const freshTs = iso((ORPHAN_GRACE_MINUTES - 5) * 60_000);
		const settle = [{ id: 31, ts: freshTs, payer: PAYER, pay_to: TREASURY, mint: MINT, amount_atomic: 1_000_000, tx_sig: 'sigFRESH' }];
		const sql = mockSql({ settle, buyer: [] });
		const conn = mockConn({
			statuses: { sigFRESH: { found: true, err: null } },
			parsed: { sigFRESH: parsedTransfer({ sender: PAYER, receiver: TREASURY, amount: 1_000_000 }) },
		});
		const ctx = baseCtx({ sql, conn });
		const out = await run(ctx);
		expect(out.responseData.orphans_settle_side).toBe(0);
	});

	it('matched settle+buyer on the same signature → no orphan', async () => {
		const ts = iso((ORPHAN_GRACE_MINUTES + 5) * 60_000);
		const settle = [{ id: 32, ts, payer: PAYER, pay_to: TREASURY, mint: MINT, amount_atomic: 1_000_000, tx_sig: 'sigMATCH' }];
		const buyer = [{ id: 900, ts, tx_signature: 'sigMATCH', endpoint_url: '/api/x402/ring-settle' }];
		const sql = mockSql({ settle, buyer });
		const conn = mockConn({
			statuses: { sigMATCH: { found: true, err: null } },
			parsed: { sigMATCH: parsedTransfer({ sender: PAYER, receiver: TREASURY, amount: 1_000_000 }) },
		});
		const ctx = baseCtx({ sql, conn });
		const out = await run(ctx);
		expect(out.responseData.orphans_settle_side).toBe(0);
		expect(out.responseData.orphans_buyer_side).toBe(0);
	});

	it('ring-settle buyer row with no facilitator record → buyer-side orphan', async () => {
		const ts = iso((ORPHAN_GRACE_MINUTES + 5) * 60_000);
		const buyer = [{ id: 901, ts, tx_signature: 'sigBUYERONLY', endpoint_url: '/api/x402/ring-settle' }];
		const sql = mockSql({ settle: [], buyer });
		const conn = mockConn();
		const ctx = baseCtx({ sql, conn });
		const out = await run(ctx);
		expect(out.responseData.orphans_buyer_side).toBe(1);
	});
});

describe('ring-reconciliation run() — fee coherence (check 5)', () => {
	it('logged vs audit within 20% → reconciled, no warn', async () => {
		const sql = mockSql({ feeLogged: 100_000, feeAudit: 110_000 });
		const conn = mockConn();
		const ctx = baseCtx({ sql, conn });
		const out = await run(ctx);
		expect(out.responseData.fee_divergence).toBeLessThanOrEqual(FEE_DIVERGENCE_THRESHOLD);
		expect(ctx.alerts.find((a) => a.title.includes('fee books diverge'))).toBeFalsy();
	});

	it('logged vs audit beyond 20% → WARN + verdict', async () => {
		const sql = mockSql({ feeLogged: 100_000, feeAudit: 200_000 });
		const conn = mockConn();
		const ctx = baseCtx({ sql, conn });
		const out = await run(ctx);
		expect(out.responseData.fee_divergence).toBeGreaterThan(FEE_DIVERGENCE_THRESHOLD);
		expect(ctx.alerts.find((a) => a.title.includes('fee books diverge'))).toBeTruthy();
		const v = sql.calls.find((c) => /INSERT INTO payment_reconciliation/i.test(c.text) && c.values.includes('x402_ring_fee_divergence'));
		expect(v).toBeTruthy();
	});

	it('no fee-audit table (fresh env) → divergence null, no crash', async () => {
		const sql = mockSql({ feeLogged: 100_000, feeAudit: undefined });
		const conn = mockConn();
		const ctx = baseCtx({ sql, conn });
		const out = await run(ctx);
		expect(out.responseData.fee_divergence).toBeNull();
		expect(out.success).toBe(true);
	});
});

describe('ring-reconciliation run() — zero-volume tripwire', () => {
	it('ring enabled + empty log → fires "enabled but silent"', async () => {
		const sql = mockSql({ settle: [] });
		const conn = mockConn();
		const ctx = baseCtx({ sql, conn, ringEnabled: true });
		const out = await run(ctx);
		expect(out.responseData.tripwire_fired).toBe(true);
		const tw = ctx.alerts.find((a) => a.title.includes('enabled but silent'));
		expect(tw).toBeTruthy();
		const v = sql.calls.find((c) => /INSERT INTO payment_reconciliation/i.test(c.text) && c.values.includes('x402_ring_enabled_but_silent'));
		expect(v).toBeTruthy();
	});

	it('ring enabled + recent settle → tripwire does not fire, self-heals', async () => {
		const settle = [{ id: 40, ts: iso(5 * 60_000), payer: PAYER, pay_to: TREASURY, mint: MINT, amount_atomic: 1_000_000, tx_sig: 'sigRECENT' }];
		const sql = mockSql({ settle });
		const conn = mockConn({
			statuses: { sigRECENT: { found: true, err: null } },
			parsed: { sigRECENT: parsedTransfer({ sender: PAYER, receiver: TREASURY, amount: 1_000_000 }) },
		});
		const ctx = baseCtx({ sql, conn, ringEnabled: true });
		const out = await run(ctx);
		expect(out.responseData.tripwire_fired).toBe(false);
		const heal = sql.calls.find((c) => /INSERT INTO payment_reconciliation/i.test(c.text) && c.values.includes('ring_tripwire') && c.values.includes(true));
		expect(heal).toBeTruthy();
	});

	it('settle older than the tripwire window still counts as silent', async () => {
		const settle = [{ id: 41, ts: iso((TRIPWIRE_WINDOW_MINUTES + 10) * 60_000), payer: PAYER, pay_to: TREASURY, mint: MINT, amount_atomic: 1_000_000, tx_sig: 'sigSTALE' }];
		const sql = mockSql({ settle });
		const conn = mockConn({
			statuses: { sigSTALE: { found: true, err: null } },
			parsed: { sigSTALE: parsedTransfer({ sender: PAYER, receiver: TREASURY, amount: 1_000_000 }) },
		});
		const ctx = baseCtx({ sql, conn, ringEnabled: true });
		const out = await run(ctx);
		expect(out.responseData.tripwire_fired).toBe(true);
	});

	it('ring disabled + empty log → tripwire silent', async () => {
		const sql = mockSql({ settle: [] });
		const conn = mockConn();
		const ctx = baseCtx({ sql, conn, ringEnabled: false });
		const out = await run(ctx);
		expect(out.responseData.tripwire_fired).toBe(false);
		expect(ctx.alerts.find((a) => a.title.includes('enabled but silent'))).toBeFalsy();
	});
});

describe('ring-reconciliation run() — bounds & throttling', () => {
	it('never exceeds the parsed-tx budget; sweeps get first draw', async () => {
		// One sweep + many confirmed settles, all needing a parse. Budget is 50;
		// the sweep must be parsed and settle sampling capped at 49.
		process.env.X402_PAY_TO_SOLANA = TREASURY;
		const sweep = [{ id: 50, ts: iso(60_000), from_wallet: TREASURY, to_wallet: PAYER, mint: MINT, amount_atomic: 1_000_000, tx_sig: 'sw0' }];
		const settle = [];
		const statuses = { sw0: { found: true, err: null } };
		const parsed = { sw0: parsedTransfer({ sender: TREASURY, receiver: PAYER, amount: 1_000_000 }) };
		for (let i = 0; i < 100; i++) {
			const sig = `st${i}`;
			settle.push({ id: 100 + i, ts: iso(60_000 + i), payer: PAYER, pay_to: TREASURY, mint: MINT, amount_atomic: 1_000_000, tx_sig: sig });
			statuses[sig] = { found: true, err: null };
			parsed[sig] = parsedTransfer({ sender: PAYER, receiver: TREASURY, amount: 1_000_000 });
		}
		const sql = mockSql({ sweep, settle });
		const conn = mockConn({ statuses, parsed });
		const ctx = baseCtx({ sql, conn });
		const out = await run(ctx);
		expect(out.responseData.parsed_tx_used).toBeLessThanOrEqual(MAX_PARSED_TX_PER_RUN);
		expect(conn.parsedCalls).toContain('sw0'); // sweep parsed despite the settle flood
		expect(out.responseData.settles_confirmed).toBe(100); // all signature-verified
		expect(out.responseData.settles_amount_sampled).toBeLessThanOrEqual(MAX_PARSED_TX_PER_RUN - 1);
		delete process.env.X402_PAY_TO_SOLANA;
	});

	it('WARN alerts are throttled to one per class per window', async () => {
		const cache = memCache();
		const mk = () => {
			const sql = mockSql({ feeLogged: 100_000, feeAudit: 300_000 });
			const conn = mockConn();
			const cap = captureAlerts();
			return { sql, conn, ctx: { now: NOW, ringEnabled: false, cache, ...cap } };
		};
		const first = mk();
		await run({ sql: first.sql, conn: first.conn, ...first.ctx });
		expect(first.ctx.alerts.find((a) => a.title.includes('fee books diverge'))).toBeTruthy();
		const second = mk();
		await run({ sql: second.sql, conn: second.conn, ...second.ctx });
		// same shared cache → second run suppressed
		expect(second.ctx.alerts.find((a) => a.title.includes('fee books diverge'))).toBeFalsy();
	});

	it('empty everything → clean success, own log row, no alerts', async () => {
		const sql = mockSql();
		const conn = mockConn();
		const ctx = baseCtx({ sql, conn });
		const out = await run(ctx);
		expect(out.success).toBe(true);
		expect(out.amountAtomic).toBe(0);
		expect(out.responseData.discrepancies).toBe(0);
		expect(ctx.alerts.length).toBe(0);
		const logRow = sql.calls.find((c) => /INSERT INTO x402_autonomous_log/i.test(c.text));
		expect(logRow).toBeTruthy();
		expect(logRow.values).toContain('reconciliation');
	});
});
