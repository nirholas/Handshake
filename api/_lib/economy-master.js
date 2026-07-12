// @ts-check
// api/_lib/economy-master.js
//
// The economy funding root: ONE master wallet that auto-tops-up every other
// engine signer in the SOLANA_SIGNERS registry when it drops below its floor.
//
// Funder-only by construction — it NEVER trades, launches, or settles. Its only
// on-chain action is a System transfer of SOL to a pubkey that is already in the
// registry (that registry IS the allowlist: sweepTopUps only ever pays targets
// the caller derived from SOLANA_SIGNERS). This is the "masters fund engines,
// engines do the work" model applied platform-wide.
//
// Address (mainnet vanity): WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW
//
// Inert until ECONOMY_MASTER_SECRET_BASE58 is set: loadEconomyMaster() returns
// null when unconfigured, so shipping this changes nothing until the operator
// funds the address and installs the key. When unset, the treasury-topup cron
// falls back to alert-only (the existing relayer-balance-check behaviour).
//
// Guards — enforced on every sweep; the first two are on-chain reads, so they
// hold even with no database:
//   • RESERVE FLOOR  — never spend the master below ECONOMY_MASTER_RESERVE_SOL.
//   • PER-ENGINE CAP — bring an engine up to its refillTo only, and never move
//                      more than ECONOMY_MASTER_PER_TOPUP_MAX_SOL to one engine
//                      in a single sweep.
//   • PER-RUN CAP    — one sweep spends at most ECONOMY_MASTER_RUN_CAP_SOL total
//                      across all engines.

import { decodeSecretKey, SOLANA_SIGNERS, resolveSignerPubkey } from './solana-signers.js';
import { getSolBalance, sendSol, LAMPORTS_PER_SOL } from './avatar-wallet.js';

// The intended master. A pasted key whose pubkey does not match this is rejected
// (a mis-paste must never silently drain a different wallet). Override with
// ECONOMY_MASTER_ADDRESS if the master is ever rotated.
export const ECONOMY_MASTER_ADDRESS =
	process.env.ECONOMY_MASTER_ADDRESS || 'WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW';

// Dust threshold: skip a top-up smaller than this to avoid fee churn on engines
// that are only a hair under their target.
const MIN_TOPUP_SOL = 0.005;

function num(envName, dflt) {
	const v = Number(process.env[envName]);
	return Number.isFinite(v) && v >= 0 ? v : dflt;
}

// The floor exists to cover the master's OWN rent-exemption (~0.00089 SOL for a
// System account) and transaction fees (~0.000005 SOL each) — not to gate the
// master behind an arbitrary balance. 0.02 SOL covers rent-exemption plus
// thousands of fee-only transactions, so the guard stays real even when the
// master is funded thin: a 0.3 SOL master should be able to spend ~0.28 of it,
// not sit fully locked behind a 1 SOL floor sized for a much larger treasury.
/** Never spend the master below this — its own working reserve + rent + fees. */
export const RESERVE_SOL = num('ECONOMY_MASTER_RESERVE_SOL', 0.02);
/** Most SOL the master will move to any single engine in one sweep. */
export const PER_TOPUP_MAX_SOL = num('ECONOMY_MASTER_PER_TOPUP_MAX_SOL', 0.5);
/** Most SOL the master will move across all engines in one sweep. */
export const RUN_CAP_SOL = num('ECONOMY_MASTER_RUN_CAP_SOL', 2);

/**
 * Load the funding-root keypair, or null when ECONOMY_MASTER_SECRET_BASE58 is
 * unset. Throws (with a coded error) only on a configured-but-broken secret — a
 * bad key is an outage the operator must see, not a silent skip.
 * @returns {Promise<import('@solana/web3.js').Keypair|null>}
 */
export async function loadEconomyMaster() {
	const secret = process.env.ECONOMY_MASTER_SECRET_BASE58;
	if (!secret) return null;
	const bytes = await decodeSecretKey(secret);
	if (!bytes) {
		throw Object.assign(new Error('ECONOMY_MASTER_SECRET_BASE58 did not decode'), {
			code: 'bad_master',
		});
	}
	const { Keypair } = await import('@solana/web3.js');
	const kp = Keypair.fromSecretKey(bytes);
	if (kp.publicKey.toBase58() !== ECONOMY_MASTER_ADDRESS) {
		throw Object.assign(
			new Error(
				`economy-master key pubkey ${kp.publicKey.toBase58()} != expected ${ECONOMY_MASTER_ADDRESS}`,
			),
			{ code: 'master_mismatch' },
		);
	}
	return kp;
}

/**
 * Compute the guarded per-engine top-ups for a set of underfunded targets,
 * applying the reserve floor, per-engine cap, and per-run cap. Pure — no
 * on-chain writes — so the plan is unit-testable and the cron can log it.
 *
 * @param {number} masterSol            master's current SOL balance
 * @param {Array<{name:string,pubkey:string,currentSol:number,refillToSol:number}>} targets
 * @returns {{ plan: Array<{name:string,pubkey:string,sol:number}>, skipped: Array<{name:string,reason:string}>, totalSol:number, spendableSol:number }}
 */
export function planTopUps(masterSol, targets) {
	const spendableSol = Math.max(0, round(masterSol - RESERVE_SOL));
	const runCap = Math.min(RUN_CAP_SOL, spendableSol);
	// Neediest first, so a tight run cap protects the most-drained engines.
	const ordered = [...targets].sort(
		(a, b) => b.refillToSol - b.currentSol - (a.refillToSol - a.currentSol),
	);
	const plan = [];
	const skipped = [];
	let total = 0;
	for (const t of ordered) {
		const deficit = round(t.refillToSol - t.currentSol);
		if (deficit < MIN_TOPUP_SOL) {
			skipped.push({ name: t.name, reason: 'below_dust_threshold' });
			continue;
		}
		const remaining = round(runCap - total);
		if (remaining < MIN_TOPUP_SOL) {
			skipped.push({ name: t.name, reason: 'run_cap_reached' });
			continue;
		}
		// Clamp to whatever's left in the run cap rather than skipping the engine
		// outright when its full want exceeds it — a thin budget should still fund
		// the neediest engines as far as it goes, not sit unspent because the first
		// engine's ask was bigger than the whole cap.
		const want = round(Math.min(deficit, PER_TOPUP_MAX_SOL, remaining));
		plan.push({ name: t.name, pubkey: t.pubkey, sol: want });
		total = round(total + want);
	}
	return { plan, skipped, totalSol: total, spendableSol };
}

/**
 * Defence-in-depth allowlist. Keep only targets whose pubkey is a resolved
 * SOLANA_SIGNERS member and is NOT the master itself. The treasury-topup cron
 * already builds its target list from the registry, so on the legitimate path
 * this changes nothing — but it makes "SOL only ever moves to an owner-held
 * registry wallet" a hard code invariant instead of a caller convention. A
 * future caller (bug, bad merge, a compromised target list) that hands sweep an
 * off-registry pubkey can never move SOL out of the owner-controlled set. Pure,
 * so it is unit-tested without RPC.
 *
 * @param {Array<{name:string,pubkey:string,currentSol:number,refillToSol:number}>} targets
 * @param {Set<string>|Iterable<string>} allowedPubkeys resolved registry pubkeys
 * @param {string} masterPubkey the funding root — never a top-up TARGET of itself
 * @returns {{ safe: typeof targets, rejected: Array<{name:string,pubkey:string,reason:string}> }}
 */
export function filterToRegistry(targets, allowedPubkeys, masterPubkey) {
	const allowed = allowedPubkeys instanceof Set ? allowedPubkeys : new Set(allowedPubkeys);
	const safe = [];
	const rejected = [];
	for (const t of targets) {
		if (t.pubkey === masterPubkey) {
			rejected.push({ name: t.name, pubkey: t.pubkey, reason: 'is_master' });
			continue;
		}
		if (!allowed.has(t.pubkey)) {
			rejected.push({ name: t.name, pubkey: t.pubkey, reason: 'not_in_registry' });
			continue;
		}
		safe.push(t);
	}
	return { safe, rejected };
}

/**
 * Resolve the base58 pubkey of every configured SOLANA_SIGNERS entry into a set.
 * Secret-only (no RPC): each pubkey is derived from the signer's own key, so an
 * unconfigured or undecodable signer simply isn't in the set (and thus can't be
 * funded). This IS the allowlist the sweep enforces.
 * @returns {Promise<Set<string>>}
 */
export async function resolveRegistryPubkeys() {
	const set = new Set();
	for (const spec of SOLANA_SIGNERS) {
		try {
			const { pubkey } = await resolveSignerPubkey(spec);
			if (pubkey) set.add(pubkey);
		} catch {
			/* an unresolvable signer is simply not on the allowlist */
		}
	}
	return set;
}

/**
 * Execute the guarded auto-refill sweep. Reads the master balance on-chain,
 * plans the top-ups, then transfers each. Returns a structured result for the
 * cron to log. Never throws for a business-rule stop (unconfigured / underfunded
 * master) — those come back as `configured:false` / `reason`.
 *
 * @param {object} args
 * @param {import('@solana/web3.js').Connection} args.connection
 * @param {Array<{name:string,pubkey:string,currentSol:number,refillToSol:number}>} args.targets
 * @param {'mainnet'|'devnet'} [args.network]
 * @returns {Promise<object>}
 */
export async function sweepTopUps({ connection, targets, network = 'mainnet', dryRun = false }) {
	const master = await loadEconomyMaster();
	if (!master) {
		return { configured: false, funded: [], failed: [], skipped: [], rejected: [], spentSol: 0 };
	}
	// Hard allowlist: SOL only ever leaves the master toward a resolved registry
	// signer, never the master itself, and never an off-registry address.
	const allowed = await resolveRegistryPubkeys();
	const { safe, rejected } = filterToRegistry(targets, allowed, master.publicKey.toBase58());
	const { sol: masterSol } = await getSolBalance(connection, master.publicKey);
	const { plan, skipped, spendableSol } = planTopUps(masterSol, safe);

	if (dryRun) {
		return {
			configured: true,
			dryRun: true,
			master: master.publicKey.toBase58(),
			masterSol: round(masterSol),
			reserveSol: RESERVE_SOL,
			spendableSol,
			plan,
			funded: [],
			failed: [],
			skipped,
			rejected,
			spentSol: 0,
		};
	}

	const funded = [];
	const failed = [];
	for (const step of plan) {
		const lamports = Math.round(step.sol * LAMPORTS_PER_SOL);
		try {
			const signature = await sendSol({
				connection,
				fromKeypair: master,
				to: step.pubkey,
				lamports,
				memo: `three.ws economy-master → ${step.name}`,
				network,
			});
			funded.push({ name: step.name, pubkey: step.pubkey, sol: step.sol, signature });
		} catch (e) {
			failed.push({ name: step.name, pubkey: step.pubkey, sol: step.sol, reason: e?.message || 'send_failed' });
		}
	}
	return {
		configured: true,
		master: master.publicKey.toBase58(),
		masterSol: round(masterSol),
		reserveSol: RESERVE_SOL,
		spendableSol,
		funded,
		failed,
		skipped,
		rejected,
		spentSol: round(funded.reduce((s, f) => s + f.sol, 0)),
	};
}

function round(n) {
	return Math.round(n * 1e9) / 1e9;
}
