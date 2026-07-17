#!/usr/bin/env node
// scripts/x402-ring-pool-setup.mjs
//
// Provision (and inspect) the x402 ring PAYER POOL — the reused set of custodial
// payer wallets the ring tick rotates through so the closed-loop economy shows
// many distinct, attributed payers at no extra per-settle cost.
//
// What it does:
//   • Generates the shortfall up to the target size (default X402_RING_POOL_SIZE),
//     encrypts each secret at rest (secret-box, WALLET_ENCRYPTION_KEY), stores it in
//     x402_ring_pool, and registers each pubkey in x402_ring_wallets(role='pool') so
//     it joins the controlled set (allowlist + leak-scanner internal) automatically.
//   • NEVER funds anything and NEVER re-keys an existing wallet. Funding the pool
//     with SOL + USDC is the ring-pool-fund pipeline's job once the pool is enabled;
//     the initial float is a deliberate manual top-up (see --funding-plan).
//
// Requires DATABASE_URL + WALLET_ENCRYPTION_KEY in the environment.
//
// Usage:
//   node scripts/x402-ring-pool-setup.mjs --status                 # counts only, no writes
//   node scripts/x402-ring-pool-setup.mjs --grow                   # mint up to X402_RING_POOL_SIZE
//   node scripts/x402-ring-pool-setup.mjs --grow --size=750        # mint up to 750
//   node scripts/x402-ring-pool-setup.mjs --funding-plan --size=750 # print exact SOL/USDC to send
//
// After --grow, set X402_RING_POOL_ENABLED=true (and X402_RING_POOL_SIZE) on the
// Cloud Run service to switch rotation on; the ring-pool-fund pipeline then keeps
// every wallet topped up from the treasury/sponsor.

import process from 'node:process';

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d) => { const p = args.find((a) => a.startsWith(`--${n}=`)); return p ? p.slice(n.length + 3) : d; };

const size = Number(opt('size', process.env.X402_RING_POOL_SIZE || 0)) || 0;

async function main() {
	const { poolCount, growPoolToTarget, ringPoolTargetSize } = await import('../api/_lib/x402/pool.js');
	const {
		poolSolTargetLamports, poolUsdcTargetAtomic,
	} = await import('../api/_lib/x402/pipelines/ring-pool-fund.js');

	const target = size > 0 ? size : ringPoolTargetSize();

	if (flag('funding-plan')) {
		const n = target || (await poolCount());
		if (!n) { console.error('No pool size given. Pass --size=<n> or set X402_RING_POOL_SIZE.'); process.exit(1); }
		const solEach = poolSolTargetLamports() / 1e9;
		const usdcEach = poolUsdcTargetAtomic() / 1e6;
		// Not every wallet is hot at once; a conservative plan funds ~60% of the pool
		// to target with SOL and USDC, the rest fills on demand as they rotate in.
		const hot = Math.ceil(n * 0.6);
		const solTotal = hot * solEach;
		const usdcTotal = hot * usdcEach;
		const rentSol = n * 0.00203928; // one-time USDC-ATA rent per wallet
		console.log(`\nFunding plan for a ${n}-wallet pool (targets: ${solEach} SOL, $${usdcEach} USDC each):`);
		console.log(`  • USDC float  → send ~$${usdcTotal.toFixed(2)} USDC to the TREASURY (X402_PAY_TO_SOLANA); it distributes on demand.`);
		console.log(`  • SOL fees    → send ~${(solTotal + rentSol).toFixed(3)} SOL to the SPONSOR/master fee wallet (X402_FEE_PAYER_SOLANA)`);
		console.log(`                  (${solTotal.toFixed(3)} SOL fee float for ~${hot} hot wallets + ${rentSol.toFixed(3)} SOL one-time ATA rent for all ${n}).`);
		console.log(`  Both are RECOVERABLE float — the USDC recirculates and the ATA rent is reclaimable.\n`);
		return;
	}

	const before = await poolCount();
	if (flag('status')) {
		console.log(`ring pool: ${before} enabled wallet(s). target=${target || '(unset)'}.`);
		return;
	}

	if (flag('grow')) {
		if (!target) { console.error('No target size. Pass --size=<n> or set X402_RING_POOL_SIZE.'); process.exit(1); }
		if (!process.env.WALLET_ENCRYPTION_KEY) { console.error('WALLET_ENCRYPTION_KEY is required to encrypt pool secrets.'); process.exit(1); }
		console.log(`Growing pool ${before} → ${target} …`);
		const { created, total } = await growPoolToTarget({ target });
		console.log(`Done. Minted ${created.length} new wallet(s); pool now ${total}.`);
		if (created.length) {
			console.log('Sample new pubkeys:', created.slice(0, 3).join(', '), created.length > 3 ? `(+${created.length - 3} more)` : '');
			console.log('\nNext: set X402_RING_POOL_ENABLED=true + X402_RING_POOL_SIZE=' + target + ' on the service,');
			console.log('then run: node scripts/x402-ring-pool-setup.mjs --funding-plan --size=' + target);
		}
		return;
	}

	console.log('Nothing to do. Pass --status, --grow, or --funding-plan. See the header for usage.');
}

main().catch((e) => { console.error('pool setup failed:', e?.message || e); process.exit(1); });
