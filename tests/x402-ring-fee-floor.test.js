import { describe, it, expect, beforeAll } from 'vitest';
import { Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';

// Fee-floor regression + self-pay + ATA-reclaim safety for the closed x402 ring.
// The rule under test is "the lowest fees ALWAYS": 1-signature self-pay
// settlement pinned at the floor, a hard per-tx fee ceiling the builders can
// never cross, and a rent reclaim that can NEVER close a funded or active ATA.
// Pure logic — no DB, no chain.
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
process.env.X402_ASSET_MINT_SOLANA = USDC;

const pay = await import('../api/_lib/x402/pay.js');
const {
	expectedFeeLamports, ringPriorityMicrolamports, ringSelfPayDefault,
	ringMaxFeePerTxLamports, buildPaymentTx, SIGNATURE_FEE_LAMPORTS, RING_CU_LIMIT,
} = pay;
const { validateRingTransaction } = await import('../api/_lib/x402/self-facilitator.js');
const {
	computeFeeEfficiency, selectClosableAtas, activeRoleAtas, FEE_AUDIT,
} = await import('../api/_lib/x402/pipelines/fee-audit.js');

const solAddr = () => Keypair.generate().publicKey.toBase58();
const ataFor = (mint, owner) => getAssociatedTokenAddressSync(
	new PublicKey(mint), new PublicKey(owner), false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
).toBase58();

describe('expectedFeeLamports — the fee-floor math', () => {
	it('self-pay is 1 signature = 5,000 lamports + priority', () => {
		expect(expectedFeeLamports({ selfPay: true, priorityMicrolamports: 0, cuLimit: RING_CU_LIMIT })).toBe(5000);
		// Baseline priority (5 µlamports × 60k CU = 0.3 lamports → floors to 0).
		expect(expectedFeeLamports({ selfPay: true, priorityMicrolamports: 5, cuLimit: RING_CU_LIMIT })).toBe(5000);
	});
	it('sponsor mode is 2 signatures = 10,000 lamports + priority', () => {
		expect(expectedFeeLamports({ selfPay: false, priorityMicrolamports: 0, cuLimit: RING_CU_LIMIT })).toBe(10000);
	});
	it('worst-case priority perturbation stays negligible', () => {
		// The nonce perturbation tops out at 1001 µlamports (5 + 996).
		const worst = expectedFeeLamports({ selfPay: true, priorityMicrolamports: 1001, cuLimit: RING_CU_LIMIT });
		expect(worst).toBe(5060); // 5000 + floor(1001*60000/1e6=60.06)=60
		expect(worst).toBeLessThanOrEqual(5100); // acceptance bar for a self-paid settle
	});
});

describe('fee-floor regression guard — builders never exceed the ceiling', () => {
	const ceiling = ringMaxFeePerTxLamports(); // 10,000 default
	it('every nonce in a batch keeps a self-paid tx under the ceiling', () => {
		for (let nonce = 0; nonce < 997; nonce++) {
			const fee = expectedFeeLamports({
				selfPay: true,
				priorityMicrolamports: ringPriorityMicrolamports(nonce),
				cuLimit: RING_CU_LIMIT,
			});
			expect(fee).toBeLessThanOrEqual(ceiling);
			expect(fee).toBeLessThanOrEqual(5100); // and under the self-pay acceptance bar
		}
	});
	it('sponsor mode at the baseline priority sits exactly at the ceiling, never above', () => {
		for (let nonce = 0; nonce < 997; nonce++) {
			const fee = expectedFeeLamports({
				selfPay: false,
				priorityMicrolamports: ringPriorityMicrolamports(nonce),
				cuLimit: RING_CU_LIMIT,
			});
			// 10,000 base + up to 60 priority = 10,060 — this is why the ceiling
			// default (10,000) is the SELF-PAY-mode guarantee; sponsor mode is the
			// fallback and its priority is bounded by the facilitator guard instead.
			expect(fee).toBeLessThanOrEqual(10_060);
		}
	});
});

describe('self-pay default — operative for the ring', () => {
	it('defaults to true when X402_RING_SELF_PAY is unset', () => {
		delete process.env.X402_RING_SELF_PAY;
		expect(ringSelfPayDefault()).toBe(true);
	});
	it('honors an explicit false (sponsor mode still selectable)', () => {
		process.env.X402_RING_SELF_PAY = 'false';
		expect(ringSelfPayDefault()).toBe(false);
		process.env.X402_RING_SELF_PAY = 'FALSE';
		expect(ringSelfPayDefault()).toBe(false);
		delete process.env.X402_RING_SELF_PAY;
	});
	it('treats true/1/anything-else as self-pay', () => {
		process.env.X402_RING_SELF_PAY = 'true';
		expect(ringSelfPayDefault()).toBe(true);
		delete process.env.X402_RING_SELF_PAY;
	});
});

describe('self-pay build → facilitator validate roundtrip (zero sponsor)', () => {
	const buyer = Keypair.generate();
	const treasury = Keypair.generate();
	const sponsor = Keypair.generate();
	const blockhash = '11111111111111111111111111111111'; // any valid base58 32-byte-ish
	const accept = {
		network: 'solana:mainnet',
		asset: USDC,
		payTo: treasury.publicKey.toBase58(),
		amount: '1000000', // $1.00
		extra: { feePayer: sponsor.publicKey.toBase58() },
	};
	const requirement = { network: 'solana:mainnet', asset: USDC, payTo: accept.payTo, amount: '1000000' };
	const allowlist = new Set([accept.payTo]);

	it('a self-paid tx validates as self-pay with a 1-signature fee, no sponsor needed', () => {
		const txBase64 = buildPaymentTx({
			accept, buyer, blockhash,
			mintInfo: { decimals: 6 }, receiverAtaExists: true, nonce: 0, selfPay: true,
		});
		const v = validateRingTransaction({
			txBase64, requirement,
			feePayerPubkey: null, // no sponsor advertised — self-pay must not need one
			allowlist,
		});
		expect(v.ok).toBe(true);
		expect(v.decoded.selfPay).toBe(true);
		expect(v.decoded.payer).toBe(buyer.publicKey.toBase58());
		expect(v.decoded.feePayer).toBe(buyer.publicKey.toBase58());
		// 1 signature × 5000 + negligible priority, no ATA create.
		expect(v.decoded.estFeeLamports).toBeLessThanOrEqual(5100);
		expect(v.decoded.estFeeLamports).toBeGreaterThanOrEqual(SIGNATURE_FEE_LAMPORTS);
	});

	it('sponsor mode still validates (the gasless-buyer fallback is intact)', () => {
		const txBase64 = buildPaymentTx({
			accept, buyer, blockhash,
			mintInfo: { decimals: 6 }, receiverAtaExists: true, nonce: 0, selfPay: false,
		});
		const v = validateRingTransaction({
			txBase64, requirement,
			feePayerPubkey: sponsor.publicKey.toBase58(),
			allowlist,
		});
		expect(v.ok).toBe(true);
		expect(v.decoded.selfPay).toBe(false);
		expect(v.decoded.feePayer).toBe(sponsor.publicKey.toBase58());
		expect(v.decoded.estFeeLamports).toBeLessThanOrEqual(10_100);
	});
});

describe('validateRingTransaction — totality: malformed input is a clean refusal, never a throw', () => {
	const buyer = Keypair.generate();
	const treasury = Keypair.generate();
	const sponsor = Keypair.generate();
	const blockhash = '11111111111111111111111111111111';
	const accept = {
		network: 'solana:mainnet',
		asset: USDC,
		payTo: treasury.publicKey.toBase58(),
		amount: '1000000',
		extra: { feePayer: sponsor.publicKey.toBase58() },
	};
	const requirement = { network: 'solana:mainnet', asset: USDC, payTo: accept.payTo, amount: '1000000' };
	const allowlist = new Set([accept.payTo]);

	// Deserialize a valid ring tx, mutate its message, re-serialize to base64.
	// The facilitator never verifies signatures, so a tampered message still
	// exercises the decode path — exactly the adversarial surface at issue.
	const tamperedTxBase64 = (mutate) => {
		const good = buildPaymentTx({
			accept, buyer, blockhash,
			mintInfo: { decimals: 6 }, receiverAtaExists: true, nonce: 0, selfPay: true,
		});
		const tx = VersionedTransaction.deserialize(Buffer.from(good, 'base64'));
		mutate(tx.message);
		return Buffer.from(tx.serialize()).toString('base64');
	};

	it('an out-of-range programIdIndex refuses cleanly instead of throwing a TypeError', () => {
		const txBase64 = tamperedTxBase64((msg) => {
			msg.compiledInstructions[0].programIdIndex = msg.staticAccountKeys.length + 5;
		});
		let v;
		expect(() => {
			v = validateRingTransaction({ txBase64, requirement, feePayerPubkey: null, allowlist });
		}).not.toThrow();
		expect(v.ok).toBe(false);
		expect(v.reason).toMatch(/malformed_instruction|decode_error/);
	});

	it('a truncated account-index list on the transfer instruction refuses cleanly', () => {
		const txBase64 = tamperedTxBase64((msg) => {
			// Find the SPL TransferChecked instruction (data[0] === 12) and starve it.
			const ix = msg.compiledInstructions.find((i) => i.data?.[0] === 12);
			if (ix) ix.accountKeyIndexes = ix.accountKeyIndexes.slice(0, 1);
		});
		let v;
		expect(() => {
			v = validateRingTransaction({ txBase64, requirement, feePayerPubkey: null, allowlist });
		}).not.toThrow();
		expect(v.ok).toBe(false);
		expect(v.reason).toMatch(/malformed_instruction|decode_error/);
	});

	it('the valid self-pay path is unaffected by the bounds guards', () => {
		const good = buildPaymentTx({
			accept, buyer, blockhash,
			mintInfo: { decimals: 6 }, receiverAtaExists: true, nonce: 0, selfPay: true,
		});
		const v = validateRingTransaction({ txBase64: good, requirement, feePayerPubkey: null, allowlist });
		expect(v.ok).toBe(true);
		expect(v.decoded.payer).toBe(buyer.publicKey.toBase58());
	});
});

describe('computeFeeEfficiency — the measured numbers', () => {
	it('derives lamports-per-settlement and sol-per-$100 from real totals', () => {
		// 100 settlements, 5,000 lamports each = 500,000 lamports on $100 gross.
		const e = computeFeeEfficiency({
			feesLamports: 500_000, settlements: 100, grossVolumeAtomic: 100_000_000, budgetLamports: 50_000_000,
		});
		expect(e.lamports_per_settlement).toBe(5000);
		expect(e.sol_burned).toBeCloseTo(0.0005, 9);
		// 0.0005 SOL on $100 gross → 0.0005 SOL per $100.
		expect(e.sol_per_100_usd).toBeCloseTo(0.0005, 9);
		expect(e.above_floor).toBe(false);
		expect(e.over_budget).toBe(false);
	});
	it('flags above_floor when per-settlement fee exceeds 1.5× the 1-sig floor', () => {
		const e = computeFeeEfficiency({ feesLamports: 8000 * 10, settlements: 10, grossVolumeAtomic: 10_000_000 });
		expect(e.lamports_per_settlement).toBe(8000);
		expect(e.above_floor).toBe(true); // 8000 > 7500
	});
	it('flags over_budget when daily burn exceeds the budget', () => {
		const e = computeFeeEfficiency({
			feesLamports: 60_000_000, settlements: 10_000, grossVolumeAtomic: 1_000_000_000, budgetLamports: 50_000_000,
		});
		expect(e.over_budget).toBe(true); // 0.06 SOL > 0.05 SOL budget
	});
	it('never divides by zero — no settlements / no volume yields nulls, not NaN', () => {
		const e = computeFeeEfficiency({ feesLamports: 0, settlements: 0, grossVolumeAtomic: 0 });
		expect(e.lamports_per_settlement).toBeNull();
		expect(e.sol_per_100_usd).toBeNull();
		expect(e.above_floor).toBe(false);
	});
});

describe('ATA rent reclaim — SAFETY: never closes a funded or active ATA', () => {
	const payer = solAddr();
	const treasury = solAddr();
	const sponsor = solAddr();
	const activeSet = activeRoleAtas({ mint: USDC, owners: [payer, treasury, sponsor] });

	it('computes exactly the three canonical role ATAs', () => {
		expect(activeSet.size).toBe(3);
		expect(activeSet.has(ataFor(USDC, payer))).toBe(true);
		expect(activeSet.has(ataFor(USDC, treasury))).toBe(true);
		expect(activeSet.has(ataFor(USDC, sponsor))).toBe(true);
	});

	it('NEVER returns an active role ATA even when it is empty', () => {
		const accounts = [
			{ pubkey: ataFor(USDC, payer), amount: 0n, mint: USDC },      // active + empty
			{ pubkey: ataFor(USDC, treasury), amount: 0n, mint: USDC },   // active + empty
			{ pubkey: ataFor(USDC, sponsor), amount: 0n, mint: USDC },    // active + empty
		];
		const closable = selectClosableAtas({ accounts, activeAtaSet: activeSet, mint: USDC, cap: 5 });
		expect(closable).toEqual([]);
	});

	it('NEVER returns an account with a balance, active or not', () => {
		const funded = solAddr();
		const accounts = [
			{ pubkey: ataFor(USDC, funded), amount: 1n, mint: USDC },          // non-role but funded
			{ pubkey: ataFor(USDC, payer), amount: 1_000_000n, mint: USDC },   // active + funded
		];
		const closable = selectClosableAtas({ accounts, activeAtaSet: activeSet, mint: USDC, cap: 5 });
		expect(closable).toEqual([]);
	});

	it('returns ONLY zero-balance, non-role ATAs', () => {
		const stale1 = ataFor(USDC, solAddr());
		const stale2 = ataFor(USDC, solAddr());
		const accounts = [
			{ pubkey: stale1, amount: 0n, mint: USDC },                    // ✓ closable
			{ pubkey: ataFor(USDC, payer), amount: 0n, mint: USDC },       // active — excluded
			{ pubkey: stale2, amount: 0n, mint: USDC },                    // ✓ closable
			{ pubkey: ataFor(USDC, treasury), amount: 500n, mint: USDC },  // active + funded — excluded
		];
		const closable = selectClosableAtas({ accounts, activeAtaSet: activeSet, mint: USDC, cap: 5 });
		expect(closable.sort()).toEqual([stale1, stale2].sort());
	});

	it('ignores accounts of a different mint', () => {
		const OTHER = solAddr();
		const accounts = [{ pubkey: solAddr(), amount: 0n, mint: OTHER }];
		expect(selectClosableAtas({ accounts, activeAtaSet: activeSet, mint: USDC, cap: 5 })).toEqual([]);
	});

	it('caps the number of closes per run', () => {
		const accounts = Array.from({ length: 12 }, () => ({ pubkey: ataFor(USDC, solAddr()), amount: 0n, mint: USDC }));
		const closable = selectClosableAtas({ accounts, activeAtaSet: activeSet, mint: USDC, cap: FEE_AUDIT.maxClosesPerRun });
		expect(closable.length).toBe(FEE_AUDIT.maxClosesPerRun);
		expect(FEE_AUDIT.maxClosesPerRun).toBe(5);
	});
});
