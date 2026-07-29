// One on-chain signature settles AT MOST one payment.
//
// Regression for the duplicate-settle defect measured on mainnet 2026-07-28:
// 12,674 of 59,271 ok settle rows (21.4%) shared a tx_sig with another ok row.
// Sampled transactions carry exactly ONE token transfer, yet up to 9 settle rows
// with 9 distinct idempotency keys were credited against each — deterministic
// Ed25519 signatures on byte-identical ring payments let settleRingPayment's
// already-processed recovery credit later payments off the first one's broadcast.
//
// Covers the credit gate (settle-credit.js) and the payer-side entropy that stops
// identical transactions being built in the first place (pay.js ringFeeConfig).
import { describe, it, expect, beforeEach } from 'vitest';

const { claimSettleCredit } = await import('../api/_lib/x402/settle-credit.js');

// Minimal in-memory stand-in for the Neon tagged-template client, modelling the
// one behaviour the gate depends on: the partial unique index over
// (tx_sig) WHERE action='settle' AND ok. INSERT … ON CONFLICT DO NOTHING returns
// zero rows when a credited row for that signature already exists.
function makeSql({ failOn = null } = {}) {
	const rows = [];
	const calls = { inserts: 0, selects: 0 };

	const sql = (strings, ...values) => {
		const text = strings.join('?');
		if (failOn && failOn(text)) return Promise.reject(new Error('db down'));

		if (/^\s*SELECT/i.test(text)) {
			calls.selects += 1;
			const txSig = values[0];
			const hit = rows.find((r) => r.action === 'settle' && r.ok === true && r.tx_sig === txSig);
			return Promise.resolve(hit ? [{ id: hit.id, idempotency_key: hit.idempotency_key }] : []);
		}

		// INSERT. Positional order matches the statements in settle-credit.js.
		calls.inserts += 1;
		const [network, payer, payTo, mint, amountAtomic, txSig, feeLamports, okOrReason, keyOrNull, feePayer] = values;
		const isCredit = /ok[\s\S]*true|,\s*true\s*,/i.test(text) || okOrReason === null;
		// The credit INSERT hardcodes `true` for ok and binds reject_reason as null;
		// the outcome INSERT hardcodes `false` and binds a reason string.
		const credited = /\btrue\b/.test(text);
		const row = {
			id: rows.length + 1,
			action: 'settle',
			ok: credited,
			tx_sig: txSig,
			idempotency_key: credited ? keyOrNull : values[values.length - 2],
			reject_reason: credited ? null : okOrReason,
			network, payer, pay_to: payTo, mint, amount_atomic: amountAtomic,
			fee_lamports: feeLamports, fee_payer: feePayer,
		};
		if (credited) {
			const conflict = rows.some((r) => r.action === 'settle' && r.ok === true && r.tx_sig === txSig);
			if (conflict) return Promise.resolve([]); // ON CONFLICT DO NOTHING
		}
		rows.push(row);
		return Promise.resolve(credited ? [{ id: row.id }] : []);
	};

	sql.rows = rows;
	sql.calls = calls;
	return sql;
}

const SIG = '5h7Ts4Heg2VcTp91yT14bzXn3AsbVkqfYcabFZfNCUm9JHK6f4NRYhMqggb1TjQcHtAincGtNAyQFgyvqwLb76pw';

const baseRow = (over = {}) => ({
	network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
	payer: 'X4o2UuVNMxnrgkzVy97kPF5gmS6CLRCVJGB48VastML',
	payTo: 'wwwwwDxFWRn7grgr3Esrsg5C6NvDoDHSA4gaCffccrU',
	mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
	amountAtomic: 1000,
	txSig: SIG,
	feeLamports: 5000,
	idempotencyKey: 'key-a',
	feePayer: 'X4o2UuVNMxnrgkzVy97kPF5gmS6CLRCVJGB48VastML',
	...over,
});

describe('claimSettleCredit — one signature, one payment', () => {
	let sql;
	beforeEach(() => { sql = makeSql(); });

	it('credits the first payment to claim a signature', async () => {
		const v = await claimSettleCredit({ sql, row: baseRow() });
		expect(v.granted).toBe(true);
		const credited = sql.rows.filter((r) => r.ok === true);
		expect(credited).toHaveLength(1);
		expect(credited[0].tx_sig).toBe(SIG);
	});

	it('REFUSES a different payment reusing the same signature', async () => {
		await claimSettleCredit({ sql, row: baseRow({ idempotencyKey: 'key-a' }) });
		const v = await claimSettleCredit({ sql, row: baseRow({ idempotencyKey: 'key-b' }) });

		expect(v.granted).toBe(false);
		expect(v.idempotentReplay).toBe(false);
		expect(v.reason).toBe('signature_already_settled');
		// Exactly one credited row survives — this is the defect being regressed.
		expect(sql.rows.filter((r) => r.ok === true)).toHaveLength(1);
		// The refusal is still audited, so the trail explains the gap.
		expect(sql.rows.some((r) => r.ok === false && r.reject_reason === 'signature_already_settled')).toBe(true);
	});

	it('treats a retry carrying the SAME idempotency key as an idempotent replay', async () => {
		await claimSettleCredit({ sql, row: baseRow({ idempotencyKey: 'key-a' }) });
		const v = await claimSettleCredit({ sql, row: baseRow({ idempotencyKey: 'key-a' }) });

		expect(v.granted).toBe(false);
		expect(v.idempotentReplay).toBe(true);
		expect(sql.rows.filter((r) => r.ok === true)).toHaveLength(1);
	});

	it('holds the line for the 9-payments-one-transfer case observed on mainnet', async () => {
		const verdicts = [];
		for (let i = 0; i < 9; i++) {
			verdicts.push(await claimSettleCredit({ sql, row: baseRow({ idempotencyKey: `key-${i}` }) }));
		}
		expect(verdicts.filter((v) => v.granted)).toHaveLength(1);
		expect(verdicts.filter((v) => !v.granted && !v.idempotentReplay)).toHaveLength(8);
		expect(sql.rows.filter((r) => r.ok === true)).toHaveLength(1);
	});

	it('fails CLOSED when the database is unavailable', async () => {
		const down = makeSql({ failOn: () => true });
		const v = await claimSettleCredit({ sql: down, row: baseRow() });
		expect(v.granted).toBe(false);
		expect(v.idempotentReplay).toBe(false);
		expect(v.reason).toBe('settle_credit_unavailable');
	});

	it('resolves a concurrent race to exactly one winner', async () => {
		// Both claims run before either has written, so both pre-checks miss and the
		// ON CONFLICT arbiter decides. This is the path the unique index protects.
		const [a, b] = await Promise.all([
			claimSettleCredit({ sql, row: baseRow({ idempotencyKey: 'race-a' }) }),
			claimSettleCredit({ sql, row: baseRow({ idempotencyKey: 'race-b' }) }),
		]);
		expect([a.granted, b.granted].filter(Boolean)).toHaveLength(1);
		expect(sql.rows.filter((r) => r.ok === true)).toHaveLength(1);
	});
});

describe('ringFeeConfig — payer-side signature entropy', () => {
	it('gives self-pay millions of distinct fee configs', async () => {
		const { ringFeeConfig, RING_NONCE_SPACE } = await import('../api/_lib/x402/pay.js');
		expect(RING_NONCE_SPACE).toBeGreaterThan(4_000_000);

		const seen = new Set();
		for (let n = 0; n < 20_000; n++) {
			const { microLamports, cuLimit } = ringFeeConfig(n, { selfPay: true });
			seen.add(`${microLamports}:${cuLimit}`);
		}
		// Every one of the first 20k nonces maps to its own config — no early wrap.
		expect(seen.size).toBe(20_000);
	});

	it('keeps sponsor mode at zero priority lamports so it never crosses the ceiling', async () => {
		const { ringFeeConfig, expectedFeeLamports, ringMaxFeePerTxLamports } =
			await import('../api/_lib/x402/pay.js');
		const ceiling = ringMaxFeePerTxLamports();

		for (let n = 0; n < 5000; n++) {
			const { microLamports, cuLimit } = ringFeeConfig(n, { selfPay: false });
			const fee = expectedFeeLamports({ selfPay: false, priorityMicrolamports: microLamports, cuLimit });
			expect(fee).toBeLessThanOrEqual(ceiling);
			expect(fee).toBe(10_000); // exactly the 2-signature base, zero priority
		}
	});

	it('keeps self-pay under the ceiling across the whole nonce space', async () => {
		const { ringFeeConfig, expectedFeeLamports, ringMaxFeePerTxLamports } =
			await import('../api/_lib/x402/pay.js');
		const ceiling = ringMaxFeePerTxLamports();

		for (const n of [0, 1, 996, 997, 4095, 100_000, 4_083_711]) {
			const { microLamports, cuLimit } = ringFeeConfig(n, { selfPay: true });
			const fee = expectedFeeLamports({ selfPay: true, priorityMicrolamports: microLamports, cuLimit });
			expect(fee).toBeLessThanOrEqual(ceiling);
			expect(fee).toBeLessThanOrEqual(5100);
		}
	});

	it('draws auto nonces from the full space rather than a per-process cycle', async () => {
		const { nextAutoNonce, RING_NONCE_SPACE } = await import('../api/_lib/x402/pay.js');
		const seen = new Set();
		for (let i = 0; i < 500; i++) {
			const n = nextAutoNonce();
			expect(n).toBeGreaterThanOrEqual(0);
			expect(n).toBeLessThan(RING_NONCE_SPACE);
			seen.add(n);
		}
		// Sequential counters would yield 500 consecutive values; random draws over
		// millions of slots essentially never repeat inside one window.
		expect(seen.size).toBeGreaterThan(495);
	});
});
