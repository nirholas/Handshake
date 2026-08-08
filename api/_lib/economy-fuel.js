// @ts-check
// api/_lib/economy-fuel.js
//
// Keeps the economy's SOL fuel tank full from the master's own idle USDC.
//
// WHY THIS EXISTS. The circulation engine is a closed SOL loop: agents fund each
// other and trade among themselves, and every tick LEAKS SOL to Solana network
// fees + DEX fees. A closed loop that only leaks cannot self-sustain, given
// enough ticks it drains to zero no matter how the treasury-topup / sweepback
// crons shuffle the remaining SOL around. When it hits zero the Money Pulse
// (/pulse) goes quiet, and until now the only cure was a human manually moving
// SOL in. Meanwhile the master accumulates USDC revenue (x402, marketplace) that
// just sits there. This module closes the gap: when the funding root cannot cover
// the engines' real SOL deficit, it converts a small, bounded, daily-capped slice
// of that USDC into native SOL so the economy keeps running on its own.
//
// Safe by construction:
//   • Self-directed: the master swaps ITS OWN USDC for ITS OWN SOL via a real
//     Jupiter route (vault-jupiter.js). There is no external recipient, no
//     parameter can send funds anywhere. It is the least-privileged possible
//     money move: the owner-controlled root converting one asset it holds into
//     another it holds.
//   • Only fires on a genuine shortage: no-op unless the master's spendable SOL
//     falls short of the current top-up run's deficit by at least FUEL_MIN_GAP_SOL.
//   • Triple-bounded: a per-swap cap, a per-UTC-day cap, and a USDC keep-floor the
//     swap never spends below. A bad Jupiter route (impact > FUEL_MAX_IMPACT_PCT)
//     is rejected rather than executed.
//   • Every swap is booked to economy_fuel_swaps (drives the daily cap and gives
//     the reconcile/health surfaces a record). A dropped write never executes a
//     second swap.
//
// Inert switch: ECONOMY_FUEL_ENABLED=0 turns it off entirely (falls back to the
// pre-existing "master empty" ops alert). Default on, self-healing is the point.

import { sql } from './db.js';
import { loadEconomyMaster, RESERVE_SOL, RUN_CAP_SOL } from './economy-master.js';
import { jupQuote, buildSwapTx, USDC_MINT_BY_NETWORK, USDC_DECIMALS } from './vault-jupiter.js';
import { getSolBalance } from './avatar-wallet.js';
import { solPriceUsd } from './sol-price.js';
import { confirmOrThrow } from './solana/confirm.js';

const NATIVE_SOL_MINT = 'So11111111111111111111111111111111111111112';
const LAMPORTS_PER_SOL = 1_000_000_000;

function num(name, dflt) {
	const v = Number(process.env[name]);
	return Number.isFinite(v) && v >= 0 ? v : dflt;
}

/** Master ⇄ USDC self-swap is on unless explicitly disabled. */
export const FUEL_ENABLED = process.env.ECONOMY_FUEL_ENABLED !== '0';
/** Never spend the master's USDC below this (protect a revenue reserve). */
export const FUEL_USDC_KEEP = num('ECONOMY_FUEL_USDC_KEEP', 0);
/** Most USDC a single refuel swap may spend. */
export const FUEL_PER_RUN_USDC = num('ECONOMY_FUEL_PER_RUN_USDC', 25);
/** Most USDC all refuel swaps may spend in one UTC day. */
export const FUEL_DAILY_USDC = num('ECONOMY_FUEL_DAILY_USDC', 100);
/** Reject a Jupiter route whose price impact exceeds this (%). */
export const FUEL_MAX_IMPACT_PCT = num('ECONOMY_FUEL_MAX_IMPACT_PCT', 3);
/** Swap slippage tolerance (bps). */
export const FUEL_SLIPPAGE_BPS = num('ECONOMY_FUEL_SLIPPAGE_BPS', 100);
/** Only refuel when the master is short of this run's deficit by at least this. */
export const FUEL_MIN_GAP_SOL = num('ECONOMY_FUEL_MIN_GAP_SOL', 0.1);
/** When we do refuel, lift the master's spendable SOL up toward this so we are
 *  not swapping dust every single minute the fleet is thirsty. */
export const FUEL_TARGET_SOL = num('ECONOMY_FUEL_TARGET_SOL', 1.0);
/** Below this USDC a swap is not worth the fees. The floor is economic, not
 *  cosmetic: at roughly $150/SOL, $0.10 of USDC buys ~0.00065 SOL, over 100x
 *  the 5000-lamport base transaction fee the swap itself costs, so the master
 *  nets gas on every swap at or above it. A higher floor reads as prudence but
 *  starves the lane exactly when it matters: on 2026-08-07 the sponsor sat 171k
 *  lamports under its SOL floor (Solana accepts withdrawn, paid routes 503ing)
 *  while holding $0.54 USDC, and the old hardcoded $1 minimum refused the one
 *  swap that would have refilled it. */
export const FUEL_MIN_SWAP_USDC = num('ECONOMY_FUEL_MIN_SWAP_USDC', 0.1);
/** Minimum seconds between two fuel swaps. The topup runs every minute and could
 *  overlap itself under load; this is a cheap belt against a double-swap racing
 *  the daily-cap read (the DB counter closes the gap after the first swap lands,
 *  the cooldown closes it before). */
export const FUEL_COOLDOWN_S = num('ECONOMY_FUEL_COOLDOWN_S', 90);

/**
 * Pure refuel decision + sizing, no RPC, no DB, so the bounds are unit-testable
 * (mirrors planTopUps / planSweepback in economy-master.js). Given the master's
 * SOL, the run's SOL deficit, and the USDC picture, decide whether to swap and how
 * much USDC to spend.
 *
 * @param {object} a
 * @param {number} a.masterSol       master SOL balance
 * @param {number} a.reserveSol      SOL the master never spends
 * @param {number} a.runCapSol       max SOL a top-up run distributes
 * @param {number} a.deficitSol      SOL the pending run wants to distribute
 * @param {number} a.usdcAvailable   master USDC balance (whole tokens)
 * @param {number} a.spentTodayUsd   USDC already refueled today (UTC)
 * @param {number} a.solUsd          live SOL price in USD
 * @param {object} a.caps            { perRunUsd, dailyUsd, usdcKeep, minGapSol, targetSol, minSwapUsd }
 * @returns {{act:boolean, reason?:string, spendableSol:number, gapSol:number,
 *   dailyRemainingUsd:number, spendUsd:number}}
 */
export function planRefuel({ masterSol, reserveSol, runCapSol, deficitSol, usdcAvailable, spentTodayUsd, solUsd, caps }) {
	const { perRunUsd, dailyUsd, usdcKeep, minGapSol, targetSol, minSwapUsd } = caps;
	const spendableSol = Math.max(0, masterSol - reserveSol);
	const need = Math.min(Math.max(0, deficitSol), runCapSol);
	const gapSol = round(need - spendableSol);
	const dailyRemainingUsd = Math.max(0, dailyUsd - spentTodayUsd);
	const base = { spendableSol: round(spendableSol), gapSol, dailyRemainingUsd: round(dailyRemainingUsd), spendUsd: 0 };

	if (gapSol < minGapSol) return { ...base, act: false, reason: 'sufficient_sol' };

	const spendableUsdc = Math.max(0, usdcAvailable - usdcKeep);
	const usdcBudget = Math.min(perRunUsd, dailyRemainingUsd, spendableUsdc);
	if (usdcBudget < minSwapUsd) {
		const reason =
			dailyRemainingUsd < minSwapUsd ? 'daily_cap_reached'
			: spendableUsdc < minSwapUsd ? 'no_spare_usdc'
			: 'below_min_swap';
		return { ...base, act: false, reason };
	}
	if (!(solUsd > 0)) return { ...base, act: false, reason: 'no_sol_price' };

	// Cover the gap, and lift toward the target so we are not swapping dust every
	// minute the fleet is thirsty. Clamp to the budget, with 3% price headroom.
	const buySol = Math.max(gapSol, targetSol - spendableSol);
	const wantUsd = Math.min(usdcBudget, buySol * solUsd * 1.03);
	if (wantUsd < minSwapUsd) return { ...base, act: false, reason: 'below_min_swap' };

	return { ...base, act: true, spendUsd: round(wantUsd) };
}

let schemaReady = false;
async function ensureSchema() {
	if (schemaReady) return;
	await sql`
		CREATE TABLE IF NOT EXISTS economy_fuel_swaps (
			id            bigserial PRIMARY KEY,
			day           date        NOT NULL,
			usdc_atomics  bigint      NOT NULL,
			sol_lamports  bigint      NOT NULL,
			price_impact  numeric,
			signature     text,
			network       text        NOT NULL DEFAULT 'mainnet',
			created_at    timestamptz NOT NULL DEFAULT now()
		)`;
	await sql`CREATE INDEX IF NOT EXISTS economy_fuel_swaps_day_idx ON economy_fuel_swaps (day)`;
	schemaReady = true;
}

/** USDC already converted to SOL today (UTC), in whole USDC. */
async function usdcSpentTodayUsd() {
	const rows = await sql`
		SELECT COALESCE(SUM(usdc_atomics), 0)::text AS atomics
		FROM economy_fuel_swaps
		WHERE day = (now() AT TIME ZONE 'utc')::date`;
	return Number(rows?.[0]?.atomics || 0) / 10 ** USDC_DECIMALS;
}

/** Seconds since the last recorded fuel swap, or Infinity if there is none. */
async function secondsSinceLastSwap() {
	const rows = await sql`
		SELECT EXTRACT(EPOCH FROM (now() - MAX(created_at)))::float8 AS secs
		FROM economy_fuel_swaps`;
	const secs = rows?.[0]?.secs;
	return secs == null ? Infinity : Number(secs);
}

/**
 * Read an owner's USDC balance (whole tokens + atomics).
 *
 * A failed read and a genuinely empty wallet are NOT the same thing, and this
 * used to collapse both into zero. That is a fallback that cannot catch the case
 * it exists for: reported as 0, the planner answers `no_spare_usdc`, which reads
 * as "the revenue is already spent, the owner must send funds" when the truth was
 * "the RPC lane was in cooldown" and nothing needed funding at all. Observed
 * 2026-07-30: the master held 46 USDC while the refuel lane declined to act, so
 * the economy stayed flat with its own cure sitting in its own wallet.
 *
 * The owner-wide scan runs first (it also sees non-canonical token accounts), the
 * derived ATA is the fallback for lanes that do not serve the indexed method, and
 * `readFailed` is set unless the chain actually answered.
 */
async function readUsdc(connection, owner, network) {
	const mint = network === 'devnet' ? USDC_MINT_BY_NETWORK.devnet : USDC_MINT_BY_NETWORK.mainnet;
	const { PublicKey } = await import('@solana/web3.js');
	const mintKey = new PublicKey(mint);
	const shape = (atomics) => ({
		atomics,
		usd: Number(atomics) / 10 ** USDC_DECIMALS,
		readFailed: false,
	});

	try {
		const r = await connection.getParsedTokenAccountsByOwner(owner, { mint: mintKey });
		let atomics = 0n;
		for (const a of r.value) atomics += BigInt(a.account.data.parsed?.info?.tokenAmount?.amount || '0');
		return shape(atomics);
	} catch {
		/* indexed scan unsupported or lane cooling: fall through to the ATA read */
	}

	try {
		const { getAssociatedTokenAddressSync } = await import('@solana/spl-token');
		const info = await connection.getAccountInfo(getAssociatedTokenAddressSync(mintKey, owner), 'confirmed');
		// The ATA address is derived, not looked up, so a null account is the chain
		// stating it does not exist: a real zero, not a read we failed to make.
		if (!info) return shape(0n);
		const data = Buffer.isBuffer(info.data) ? info.data : Buffer.from(info.data || []);
		// SPL token account layout: mint(32) + owner(32) + amount(u64 LE).
		if (data.length < 72) return shape(0n);
		return shape(data.readBigUInt64LE(64));
	} catch (e) {
		return {
			atomics: 0n,
			usd: 0,
			readFailed: true,
			error: String(e?.message || 'usdc_read_failed').slice(0, 160),
		};
	}
}

/**
 * Sign, broadcast, and confirm a Jupiter VersionedTransaction with `keypair`.
 * Confirms via the platform's HTTP-polling confirmer (no WebSocket) bounded by the
 * transaction's own blockhash expiry, and throws `tx_reverted` on a landed-but-
 * reverted swap so a revert is never booked as a successful refuel.
 */
async function signSendConfirm(connection, tx, keypair) {
	tx.sign([keypair]);
	const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
	// Confirm against the tx's OWN blockhash so expiry detection is correct (a
	// fresh getLatestBlockhash would confirm against a later, unrelated window).
	const blockhash = tx.message.recentBlockhash;
	const lastValidBlockHeight = (await connection.getBlockHeight('confirmed')) + 150;
	await confirmOrThrow(connection, { signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
	return sig;
}

/**
 * Refuel the master's SOL from its own USDC when it cannot cover `deficitSol`.
 *
 * @param {object} args
 * @param {import('@solana/web3.js').Connection} args.connection
 * @param {number} args.deficitSol   total SOL the pending top-up run wants to distribute
 * @param {'mainnet'|'devnet'} [args.network]
 * @param {boolean} [args.dryRun]
 * @returns {Promise<{acted:boolean, reason?:string, enabled:boolean, dryRun?:boolean,
 *   masterSol?:number, spendableSol?:number, gapSol?:number, usdcAvailable?:number,
 *   dailyRemainingUsd?:number, plannedUsd?:number, signature?:string, boughtSol?:number,
 *   spentUsd?:number, priceImpactPct?:number}>}
 */
export async function refuelMasterFromUsdc({ connection, deficitSol, network = 'mainnet', dryRun = false }) {
	if (!FUEL_ENABLED) return { acted: false, enabled: false, reason: 'disabled' };

	const master = await loadEconomyMaster();
	if (!master) return { acted: false, enabled: true, reason: 'master_unconfigured' };

	const { sol: masterSol } = await getSolBalance(connection, master.publicKey);

	// Cheap pre-check: if the master's spendable SOL already covers the run, skip
	// the USDC read and the schema touch entirely.
	const spendablePre = Math.max(0, masterSol - RESERVE_SOL);
	const gapPre = Math.min(Math.max(0, deficitSol), RUN_CAP_SOL) - spendablePre;
	if (gapPre < FUEL_MIN_GAP_SOL) {
		return { acted: false, enabled: true, reason: 'sufficient_sol', masterSol: round(masterSol), spendableSol: round(spendablePre), gapSol: round(gapPre) };
	}

	await ensureSchema();
	const usdc = await readUsdc(connection, master.publicKey, network);
	// Never let an unread balance be planned as an empty one: "we could not look"
	// and "there is nothing there" need opposite responses from the operator, and
	// only the second one costs money to fix.
	if (usdc.readFailed) {
		return {
			acted: false,
			enabled: true,
			reason: 'usdc_read_failed',
			readError: usdc.error,
			masterSol: round(masterSol),
			spendableSol: round(spendablePre),
			gapSol: round(gapPre),
		};
	}
	const usdcUsd = usdc.usd;
	const spentToday = await usdcSpentTodayUsd();
	const solUsd = await solPriceUsd().catch(() => 0);

	const caps = {
		perRunUsd: FUEL_PER_RUN_USDC,
		dailyUsd: FUEL_DAILY_USDC,
		usdcKeep: FUEL_USDC_KEEP,
		minGapSol: FUEL_MIN_GAP_SOL,
		targetSol: FUEL_TARGET_SOL,
		minSwapUsd: FUEL_MIN_SWAP_USDC,
	};
	const decision = planRefuel({
		masterSol, reserveSol: RESERVE_SOL, runCapSol: RUN_CAP_SOL,
		deficitSol, usdcAvailable: usdcUsd, spentTodayUsd: spentToday, solUsd, caps,
	});

	const base = {
		enabled: true,
		masterSol: round(masterSol),
		spendableSol: decision.spendableSol,
		gapSol: decision.gapSol,
		usdcAvailable: round(usdcUsd),
		dailyRemainingUsd: decision.dailyRemainingUsd,
	};

	if (!decision.act) return { ...base, acted: false, reason: decision.reason };

	// Anti-double-swap: a fresh swap within the cooldown means a previous tick
	// already refueled and the SOL just has not propagated to the balance read yet.
	// Skip rather than stack a second swap on top of it.
	if (!dryRun) {
		const sinceLast = await secondsSinceLastSwap();
		if (sinceLast < FUEL_COOLDOWN_S) {
			return { ...base, acted: false, reason: 'cooldown', secondsSinceLastSwap: Math.round(sinceLast) };
		}
	}

	const amountAtomics = BigInt(Math.floor(decision.spendUsd * 10 ** USDC_DECIMALS));
	base.plannedUsd = round(Number(amountAtomics) / 10 ** USDC_DECIMALS);

	const inputMint = network === 'devnet' ? USDC_MINT_BY_NETWORK.devnet : USDC_MINT_BY_NETWORK.mainnet;
	const quote = await jupQuote({
		inputMint,
		outputMint: NATIVE_SOL_MINT,
		amountRaw: amountAtomics,
		slippageBps: FUEL_SLIPPAGE_BPS,
	});
	const priceImpactPct = Number(quote.priceImpactPct ?? 0);
	const outLamports = Number(quote.outAmount || 0);
	base.priceImpactPct = round(priceImpactPct);

	if (priceImpactPct > FUEL_MAX_IMPACT_PCT) {
		return { ...base, acted: false, reason: `price_impact_${priceImpactPct.toFixed(2)}pct` };
	}

	if (dryRun) {
		return { ...base, acted: false, dryRun: true, reason: 'dry_run', boughtSol: round(outLamports / LAMPORTS_PER_SOL) };
	}

	const tx = await buildSwapTx({ quote, userPublicKey: master.publicKey });
	const signature = await signSendConfirm(connection, tx, master);

	// Record the swap: this row IS the daily-cap counter, so a dropped write could
	// let the next tick overspend. Never fail the (already-settled) swap for it, but
	// surface a miss loudly instead of swallowing it; the cooldown still bounds a
	// same-minute repeat even if this row is missing.
	let recorded = true;
	try {
		await sql`
			INSERT INTO economy_fuel_swaps (day, usdc_atomics, sol_lamports, price_impact, signature, network)
			VALUES ((now() AT TIME ZONE 'utc')::date, ${amountAtomics.toString()}, ${outLamports}, ${priceImpactPct}, ${signature}, ${network})`;
	} catch (e) {
		recorded = false;
		console.warn(`[economy-fuel] swap ${signature} settled but its ledger row was NOT written: ${e?.message}`);
	}

	return {
		...base,
		acted: true,
		recorded,
		signature,
		boughtSol: round(outLamports / LAMPORTS_PER_SOL),
		spentUsd: base.plannedUsd,
		priceImpactPct: round(priceImpactPct),
	};
}

/**
 * Read-only fuel status for the ops/health surface: config, today's spend against
 * the cap, and the most recent swaps. No RPC, no keys; safe for a health scrape.
 * @param {{limit?:number}} [opts]
 */
export async function fuelStatus({ limit = 5 } = {}) {
	const out = {
		enabled: FUEL_ENABLED,
		caps: {
			per_run_usd: FUEL_PER_RUN_USDC,
			daily_usd: FUEL_DAILY_USDC,
			usdc_keep: FUEL_USDC_KEEP,
			min_gap_sol: FUEL_MIN_GAP_SOL,
			target_sol: FUEL_TARGET_SOL,
			max_impact_pct: FUEL_MAX_IMPACT_PCT,
			cooldown_s: FUEL_COOLDOWN_S,
		},
		today_usd: 0,
		daily_remaining_usd: FUEL_DAILY_USDC,
		recent: [],
	};
	try {
		await ensureSchema();
		out.today_usd = round(await usdcSpentTodayUsd());
		out.daily_remaining_usd = round(Math.max(0, FUEL_DAILY_USDC - out.today_usd));
		const rows = await sql`
			SELECT created_at, usdc_atomics::text AS usdc_atomics, sol_lamports::text AS sol_lamports,
			       price_impact, signature
			FROM economy_fuel_swaps
			ORDER BY created_at DESC
			LIMIT ${Math.max(1, Math.min(50, limit))}`;
		out.recent = rows.map((r) => ({
			at: r.created_at,
			usd: round(Number(r.usdc_atomics) / 10 ** USDC_DECIMALS),
			sol: round(Number(r.sol_lamports) / LAMPORTS_PER_SOL),
			price_impact_pct: r.price_impact == null ? null : Number(r.price_impact),
			signature: r.signature,
		}));
	} catch {
		/* not-yet-migrated table ⇒ empty status, same as the health endpoint's other guards */
	}
	return out;
}

function round(n) {
	return Math.round(n * 1e9) / 1e9;
}
