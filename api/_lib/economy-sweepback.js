// @ts-check
// api/_lib/economy-sweepback.js
//
// The reverse of economy-master.js. Where the master tops engines UP, sweepback
// brings balances BACK: it walks every configured engine signer in the
// SOLANA_SIGNERS registry and returns SOL — and, where safe, SPL token
// balances — to the ONE economy master wallet. Together the two close the loop:
// master funds engines → engines do the work → surplus consolidates to master.
//
// Destination-locked by construction: the only recipient this module can pay is
// ECONOMY_MASTER_ADDRESS (a module constant, never a parameter). A caller —
// buggy, compromised, or confused — cannot point a sweep anywhere else, so
// consolidation can never become a leak.
//
// Two modes:
//   • 'excess' (default, safe to schedule) — skim only SOL above each signer's
//     operating float (the same refillTo the treasury-topup cron refills to, so
//     the two never oscillate: topup lifts a signer TO its float, sweepback only
//     takes what is ABOVE it). Token balances are swept only from signers that
//     do not operationally hold tokens (`holdsTokens` in the registry protects
//     e.g. the buyback wallet's USDC revenue).
//   • 'drain' (explicit, on-demand) — full consolidation: every token balance
//     transferred, every emptied token account closed (rent refunds straight to
//     the master), then all SOL minus a small fee headroom. Leaves the engines
//     unfunded until the next treasury-topup, so it is for decommission or
//     emergency recovery, never a schedule.

import { SOLANA_SIGNERS, loadSignerKeypair } from './solana-signers.js';
import { ECONOMY_MASTER_ADDRESS } from './economy-master.js';
import { sendSol, LAMPORTS_PER_SOL } from './avatar-wallet.js';
import { submitProtected } from './execution-engine.js';
import { MIN_OPERATIONAL_WALLET_SOL } from './agent-trade-guards.js';
import { antiOscillationFloorSol } from './agent-funding-policy.js';
import {
	PLATFORM_AGENT_OWNER_EMAIL,
	PLATFORM_AGENT_EMAIL_SUFFIX,
	isPlatformOwnedAgent,
} from './custodial-key-health.js';

// Same float the treasury-topup cron refills to — sweep only above it.
const DEFAULT_REFILL_MULTIPLE = 3;

function num(envName, dflt) {
	const v = Number(process.env[envName]);
	return Number.isFinite(v) && v >= 0 ? v : dflt;
}

/** Skip a SOL sweep smaller than this — moving dust costs more than it returns. */
export const MIN_SWEEP_SOL = num('ECONOMY_SWEEPBACK_MIN_SOL', 0.01);
/**
 * Lamports a drained signer keeps: fees for its own sweep transactions PLUS the
 * ~890,880-lamport rent-exempt minimum. The runtime rejects any transfer that
 * leaves a system account above zero but below rent exemption
 * (InsufficientFundsForRent), so a drain must leave at least this — 0.001 SOL —
 * or the drain transaction itself would fail.
 */
export const DRAIN_HEADROOM_LAMPORTS = 1_000_000;
/** Most token accounts settled in one transaction (tx size + CU bound). */
const TOKEN_ACCOUNTS_PER_TX = 4;

/**
 * Compute the guarded per-signer SOL sweep amounts. Pure — no RPC — so the plan
 * is unit-testable and the cron can log it before touching a key.
 *
 * @param {Array<{name:string,pubkey:string,currentSol:number,floorSol:number}>} targets
 * @param {{mode?:'excess'|'drain', minSweepSol?:number}} [opts]
 * @returns {{ plan: Array<{name:string,pubkey:string,sol:number}>, skipped: Array<{name:string,reason:string}>, totalSol: number }}
 */
export function planSweepback(targets, opts = {}) {
	const mode = opts.mode === 'drain' ? 'drain' : 'excess';
	const minSweep = Number.isFinite(opts.minSweepSol) ? opts.minSweepSol : MIN_SWEEP_SOL;
	const plan = [];
	const skipped = [];
	let total = 0;
	for (const t of targets) {
		const available =
			mode === 'drain'
				? round(t.currentSol - DRAIN_HEADROOM_LAMPORTS / LAMPORTS_PER_SOL)
				: round(t.currentSol - t.floorSol);
		if (available < minSweep) {
			skipped.push({ name: t.name, reason: mode === 'drain' ? 'below_dust_threshold' : 'at_or_below_float' });
			continue;
		}
		plan.push({ name: t.name, pubkey: t.pubkey, sol: available });
		total = round(total + available);
	}
	return { plan, skipped, totalSol: total };
}

/**
 * Sweep every non-zero SPL token balance a signer owns to the master's ATA,
 * closing each emptied source account so its rent refund lands on the master
 * too. Covers both the classic token program and Token-2022. Transactions are
 * chunked and submitted through the fee-optimized engine (no Jito tip).
 *
 * @param {object} args
 * @param {import('@solana/web3.js').Connection} args.connection
 * @param {import('@solana/web3.js').Keypair} args.owner
 * @param {'mainnet'|'devnet'} args.network
 * @returns {Promise<{ swept: Array<{mint:string,amount:string,decimals:number,signature:string}>, failed: Array<{mint:string,reason:string}> }>}
 */
async function sweepTokenBalances({ connection, owner, network, dryRun = false }) {
	const { PublicKey } = await import('@solana/web3.js');
	const {
		TOKEN_PROGRAM_ID,
		TOKEN_2022_PROGRAM_ID,
		getAssociatedTokenAddressSync,
		createAssociatedTokenAccountIdempotentInstruction,
		createTransferCheckedInstruction,
		createCloseAccountInstruction,
	} = await import('@solana/spl-token');

	const master = new PublicKey(ECONOMY_MASTER_ADDRESS);
	const swept = [];
	const failed = [];

	for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
		let accounts;
		try {
			({ value: accounts } = await connection.getParsedTokenAccountsByOwner(owner.publicKey, { programId }));
		} catch (e) {
			const msg = e?.message || '';
			// web3.js validates jsonParsed responses with superstruct; some Token-2022
			// accounts (extensions the installed lib can't model) make the WHOLE call
			// throw "Expected the value to satisfy a union of `type | type`". That is a
			// client-side parse limitation, not a sweep failure — our engines hold
			// USDC + SOL, not Token-2022 — so degrade quietly rather than alerting on
			// every run. A genuine RPC/network error still surfaces.
			if (/satisfy a union|Expected the value|superstruct/i.test(msg)) {
				console.warn('[sweepback] parsed token query unsupported for program', programId.toBase58(), '- skipping', msg);
				continue;
			}
			failed.push({ mint: `program:${programId.toBase58()}`, reason: `rpc_error: ${msg}` });
			continue;
		}
		const holdings = accounts
			.map((a) => ({
				address: a.pubkey,
				mint: a.account.data.parsed?.info?.mint,
				amount: BigInt(a.account.data.parsed?.info?.tokenAmount?.amount || '0'),
				decimals: Number(a.account.data.parsed?.info?.tokenAmount?.decimals || 0),
			}))
			.filter((h) => h.mint && h.amount > 0n);

		for (let i = 0; i < holdings.length; i += TOKEN_ACCOUNTS_PER_TX) {
			const chunk = holdings.slice(i, i + TOKEN_ACCOUNTS_PER_TX);
			if (dryRun) {
				for (const h of chunk) {
					swept.push({ mint: h.mint, amount: h.amount.toString(), decimals: h.decimals, signature: null, dryRun: true });
				}
				continue;
			}
			const instructions = [];
			for (const h of chunk) {
				const mint = new PublicKey(h.mint);
				const masterAta = getAssociatedTokenAddressSync(mint, master, false, programId);
				instructions.push(
					createAssociatedTokenAccountIdempotentInstruction(owner.publicKey, masterAta, master, mint, programId),
					createTransferCheckedInstruction(h.address, mint, masterAta, owner.publicKey, h.amount, h.decimals, [], programId),
					// Rent refund straight to the master — the destination lock applies
					// to every lamport this module moves, including reclaimed rent.
					createCloseAccountInstruction(h.address, master, owner.publicKey, [], programId),
				);
			}
			try {
				const { signature } = await submitProtected({ network, connection, payer: owner, instructions });
				for (const h of chunk) {
					swept.push({ mint: h.mint, amount: h.amount.toString(), decimals: h.decimals, signature });
				}
			} catch (e) {
				for (const h of chunk) failed.push({ mint: h.mint, reason: e?.message || 'send_failed' });
			}
		}
	}
	return { swept, failed };
}

/**
 * Execute the consolidation sweep across every configured registry signer.
 * Tokens first (their fees and rent refunds settle before the SOL read), then
 * SOL per the mode's plan. Registry entries wired to the same physical wallet
 * are swept once, with their guards merged conservatively (any-holds-tokens,
 * highest float). Never throws for a business-rule stop.
 *
 * @param {object} args
 * @param {import('@solana/web3.js').Connection} args.connection
 * @param {'excess'|'drain'} [args.mode]
 * @param {boolean} [args.includeTokens]
 * @param {'mainnet'|'devnet'} [args.network]
 * @param {boolean} [args.dryRun] plan only: same reads, same guards, no sends
 * @returns {Promise<object>}
 */
export async function sweepBack({ connection, mode = 'excess', includeTokens = true, network = 'mainnet', dryRun = false }) {
	const { PublicKey } = await import('@solana/web3.js');
	const master = ECONOMY_MASTER_ADDRESS;

	let masterSolBefore = null;
	try {
		masterSolBefore = round((await connection.getBalance(new PublicKey(master), 'confirmed')) / LAMPORTS_PER_SOL);
	} catch {
		/* balance context is best-effort; the sweep itself does not need it */
	}

	const sweptSol = [];
	const sweptTokens = [];
	const failed = [];
	const skipped = [];
	const readErrors = [];

	// Several registry entries can be WIRED to the same physical wallet (fallback
	// env vars, or the operator assigning multiple slots to one key). Sweeping is
	// per-wallet, so resolve everything first and merge aliases conservatively:
	// the wallet holds tokens if ANY of its slots does, and its float is the
	// HIGHEST float any slot requires.
	const wallets = new Map();
	for (const spec of SOLANA_SIGNERS) {
		if (spec.isMaster || spec.network === 'devnet') continue;
		const { keypair, configured, decodeError } = await loadSignerKeypair(spec);
		if (!configured) continue;
		if (decodeError || !keypair) {
			readErrors.push({ name: spec.name, reason: 'secret_decode_failed' });
			continue;
		}
		const pubkey = keypair.publicKey.toBase58();
		if (pubkey === master) {
			skipped.push({ name: spec.name, reason: 'is_master' });
			continue;
		}
		const floorSol = spec.refillTo ?? spec.minSol * DEFAULT_REFILL_MULTIPLE;
		const existing = wallets.get(pubkey);
		if (existing) {
			existing.names.push(spec.name);
			existing.holdsTokens = existing.holdsTokens || Boolean(spec.holdsTokens);
			existing.floorSol = Math.max(existing.floorSol, floorSol);
		} else {
			wallets.set(pubkey, {
				pubkey,
				keypair,
				names: [spec.name],
				holdsTokens: Boolean(spec.holdsTokens),
				floorSol,
			});
		}
	}

	for (const wallet of wallets.values()) {
		const name = wallet.names.join('+');

		// Tokens first. In excess mode a wallet that operationally holds tokens
		// (buyback USDC, withdrawal SPL float, NFT collection) keeps them; a
		// drain takes all.
		if (includeTokens && (mode === 'drain' || !wallet.holdsTokens)) {
			const tokens = await sweepTokenBalances({ connection, owner: wallet.keypair, network, dryRun });
			for (const t of tokens.swept) sweptTokens.push({ name, pubkey: wallet.pubkey, ...t });
			for (const f of tokens.failed) failed.push({ name, pubkey: wallet.pubkey, sol: null, reason: `token ${f.mint}: ${f.reason}` });
		}

		let currentSol;
		try {
			currentSol = round((await connection.getBalance(wallet.keypair.publicKey, 'confirmed')) / LAMPORTS_PER_SOL);
		} catch (e) {
			readErrors.push({ name, pubkey: wallet.pubkey, reason: `rpc_error: ${e?.message}` });
			continue;
		}
		const { plan, skipped: planSkipped } = planSweepback(
			[{ name, pubkey: wallet.pubkey, currentSol, floorSol: wallet.floorSol }],
			{ mode },
		);
		skipped.push(...planSkipped);
		for (const step of plan) {
			if (dryRun) {
				sweptSol.push({ name: step.name, pubkey: step.pubkey, sol: step.sol, signature: null, dryRun: true });
				continue;
			}
			try {
				const signature = await sendSol({
					connection,
					fromKeypair: wallet.keypair,
					to: master,
					lamports: Math.round(step.sol * LAMPORTS_PER_SOL),
					memo: `three.ws sweepback ${name} → economy-master`,
					network,
				});
				sweptSol.push({ name: step.name, pubkey: step.pubkey, sol: step.sol, signature });
			} catch (e) {
				failed.push({ name: step.name, pubkey: step.pubkey, sol: step.sol, reason: e?.message || 'send_failed' });
			}
		}
	}

	let masterSolAfter = null;
	try {
		masterSolAfter = round((await connection.getBalance(new PublicKey(master), 'confirmed')) / LAMPORTS_PER_SOL);
	} catch {
		/* best-effort */
	}

	return {
		mode,
		dryRun,
		master,
		masterSolBefore,
		masterSolAfter,
		sweptSol,
		sweptTokens,
		failed,
		skipped,
		readErrors,
		receivedSol: round(sweptSol.reduce((s, f) => s + f.sol, 0)),
	};
}

// Names that are the FEED SINK, not a reclaim source: pulling SOL out of the
// circulation treasury just to have the topup put it straight back is pure fee
// churn, so reclaim leaves it alone (topup funds it; reclaim feeds topup).
const RECLAIM_EXEMPT_NAMES = new Set(['circulation-treasury']);

/**
 * Pure reclaim sizing (no RPC) so the anti-oscillation invariant is testable.
 * Returns how much SOL to pull from an engine holding `currentSol` whose operating
 * floor is `minSol`, leaving it at minSol PLUS a buffer so fee jitter can't drop it
 * below minSol (which would make the topup re-fund it and reopen the ping-pong the
 * design closes). Returns 0 when there is nothing worth moving.
 *
 * Invariant: currentSol - reclaimableSol(currentSol, minSol) >= minSol, always.
 *
 * @param {number} currentSol
 * @param {number} minSol
 * @param {number} [minSweep]
 * @returns {number}
 */
export function reclaimableSol(currentSol, minSol, minSweep = MIN_SWEEP_SOL) {
	const floor = Math.max(0, minSol);
	const keepSol = floor + Math.max(0.005, floor * 0.1);
	const reclaimable = round(currentSol - keepSol);
	return reclaimable >= minSweep ? reclaimable : 0;
}

/**
 * Emergency consolidation: pull IDLE SOL sitting above each engine's true
 * operating floor (`minSol`, not the topup `refillTo`) back to the master, SOL
 * only; token floats are never touched. This is the automated form of the manual
 * "drain the fleet to refund the feed" recovery: when the funding root is starved,
 * SOL trapped in over-provisioned engines (a launcher floored at 3 SOL that isn't
 * launching, say) flows to where the Money Pulse needs it, on its own.
 *
 * Non-oscillating by construction: it leaves each engine at minSol PLUS a buffer,
 * and the topup only ever funds engines strictly BELOW minSol, so a reclaimed
 * engine is never immediately re-funded, and the two crons cannot ping-pong. The
 * feed sink (circulation-treasury) is exempt. Destination is the same hard-locked
 * ECONOMY_MASTER_ADDRESS constant as sweepBack; no parameter can redirect it.
 *
 * @param {object} args
 * @param {import('@solana/web3.js').Connection} args.connection
 * @param {'mainnet'|'devnet'} [args.network]
 * @param {boolean} [args.dryRun]
 * @returns {Promise<{master:string, reclaimedSol:number, moves:Array, skipped:Array, failed:Array, readErrors:Array}>}
 */
export async function reclaimIdleSol({ connection, network = 'mainnet', dryRun = false }) {
	const master = ECONOMY_MASTER_ADDRESS;
	const moves = [];
	const failed = [];
	const skipped = [];
	const readErrors = [];

	// Merge registry entries that resolve to the same physical wallet. Keep the
	// HIGHEST minSol among a wallet's roles so we never leave it under any role's
	// operating floor, and treat the wallet as exempt if ANY of its roles is.
	const wallets = new Map();
	for (const spec of SOLANA_SIGNERS) {
		if (spec.isMaster || spec.network === 'devnet') continue;
		const { keypair, configured, decodeError } = await loadSignerKeypair(spec);
		if (!configured) continue;
		if (decodeError || !keypair) {
			readErrors.push({ name: spec.name, reason: 'secret_decode_failed' });
			continue;
		}
		const pubkey = keypair.publicKey.toBase58();
		if (pubkey === master) continue;
		const exempt = RECLAIM_EXEMPT_NAMES.has(spec.name);
		const existing = wallets.get(pubkey);
		if (existing) {
			existing.names.push(spec.name);
			existing.minSol = Math.max(existing.minSol, spec.minSol || 0);
			existing.exempt = existing.exempt || exempt;
		} else {
			wallets.set(pubkey, { pubkey, keypair, names: [spec.name], minSol: spec.minSol || 0, exempt });
		}
	}

	for (const w of wallets.values()) {
		const name = w.names.join('+');
		if (w.exempt) {
			skipped.push({ name, reason: 'feed_sink_exempt' });
			continue;
		}
		let currentSol;
		try {
			currentSol = round((await connection.getBalance(w.keypair.publicKey, 'confirmed')) / LAMPORTS_PER_SOL);
		} catch (e) {
			readErrors.push({ name, pubkey: w.pubkey, reason: `rpc_error: ${e?.message}` });
			continue;
		}
		// Leave the engine its floor plus a comfortable buffer (see reclaimableSol)
		// so the topup never re-funds a reclaimed engine and the two cannot ping-pong.
		const reclaimable = reclaimableSol(currentSol, w.minSol);
		if (reclaimable <= 0) {
			skipped.push({ name, reason: 'at_or_below_floor' });
			continue;
		}
		if (dryRun) {
			moves.push({ name, pubkey: w.pubkey, sol: reclaimable, dryRun: true });
			continue;
		}
		try {
			const signature = await sendSol({
				connection,
				fromKeypair: w.keypair,
				to: master,
				lamports: Math.round(reclaimable * LAMPORTS_PER_SOL),
				memo: `three.ws reclaim ${name} → economy-master`,
				network,
			});
			moves.push({ name, pubkey: w.pubkey, sol: reclaimable, signature });
		} catch (e) {
			failed.push({ name, pubkey: w.pubkey, sol: reclaimable, reason: e?.message || 'send_failed' });
		}
	}

	return {
		master,
		reclaimedSol: round(moves.reduce((s, m) => s + m.sol, 0)),
		moves,
		skipped,
		failed,
		readErrors,
	};
}

// ── platform AGENT wallet reclaim ────────────────────────────────────────────
//
// reclaimIdleSol above walks the SOLANA_SIGNERS registry — the eight engine
// wallets. Agent custody wallets are a different universe and were structurally
// invisible to every return path: `fundAgentForLaunch` moves SOL master → agent
// one way, and nothing ever moved it back. Snipes recycle ~97% of their capital
// but the proceeds land in the AGENT wallet, so each cycle ratcheted SOL further
// from the engines until the master could not pay a 5,036-lamport settle fee.
// Audited 2026-07-28: 7.2 of the fleet's 7.53 SOL sat in agent wallets while the
// engines held 0.31 and the whole x402 rail 503'd. This closes that loop.
//
// The ownership boundary is the load-bearing part. Only wallets belonging to
// PLATFORM-OWNED agents may be swept — the `three-ws` house account and the
// `*@agents.three.ws` circulation bots, which api/_lib/launcher-engine.js
// documents as "platform-created bot accounts … never real end users". A
// customer's agent is never touched, and the SQL gate plus a redundant in-JS
// re-check make that true even if the query is later edited.

// One definition, shared with the custodial key-health audit: two copies of this
// boundary drifted apart once already (the audit carried a different house-account
// address and filed 12 platform wallets as customer ones).
export { PLATFORM_AGENT_OWNER_EMAIL, PLATFORM_AGENT_EMAIL_SUFFIX, isPlatformOwnedAgent };

/** Floor left on an idle platform agent — enough to sign its own transactions. */
const AGENT_IDLE_FLOOR_SOL = num('AGENT_RECLAIM_IDLE_FLOOR_SOL', 0.005);
/** A trading agent keeps this many trades' worth of working capital. */
const AGENT_ACTIVE_TRADE_MULTIPLE = num('AGENT_RECLAIM_TRADE_MULTIPLE', 2);
/** Wallets touched per run — keeps the cron bounded and its fee cost predictable. */
const AGENT_RECLAIM_MAX_WALLETS = num('AGENT_RECLAIM_MAX_WALLETS', 40);

/**
 * Operating floor for one platform agent. An agent running an ENABLED sniper
 * strategy keeps enough for `AGENT_RECLAIM_TRADE_MULTIPLE` trades at its own
 * configured size, so reclaim can never starve a working trader; an agent with
 * no enabled strategy keeps only transaction-fee headroom. Pure.
 *
 * @param {{enabled?:boolean, perTradeSol?:number}} strategy
 * @returns {number} floor in SOL
 */
export function agentReclaimFloorSol(strategy = {}) {
	// Anti-oscillation, and it outranks everything else here: a wallet the sniper
	// auto-funder refills to a target must never be swept below that target, or the
	// two crons chase the same SOL forever. Measured before this guard existed: 0.24
	// SOL round-tripped six times between the funding master and two arms inside 15
	// minutes, paying fees each leg, until the funding master ran dry. Applies even
	// to a DISABLED strategy — the funder's opt-in flag, not `enabled`, is what
	// decides whether a refill is coming.
	const antiOscillation = antiOscillationFloorSol({ autoFundEnabled: strategy.autoFundEnabled });
	if (!strategy.enabled) return round(Math.max(AGENT_IDLE_FLOOR_SOL, antiOscillation));
	const perTrade = Number(strategy.perTradeSol);
	// An ENABLED arm always keeps at least what one complete trade costs. Sizing the
	// floor on `per_trade × 2` alone ignored everything a buy needs BESIDES the buy
	// — the token ATA's rent, the fee and tip headroom, and the round-trip probe the
	// firewall simulates from this same wallet — so a small-size arm could be
	// reclaimed down to 0.004 SOL and then abort every entry at a safety simulation
	// it could no longer afford to run. Fully funded and operationally dead is the
	// worst state to leave a trader in: it looks healthy on every dashboard.
	const working = Number.isFinite(perTrade) && perTrade > 0
		? perTrade * AGENT_ACTIVE_TRADE_MULTIPLE + MIN_OPERATIONAL_WALLET_SOL
		: MIN_OPERATIONAL_WALLET_SOL;
	return round(Math.max(AGENT_IDLE_FLOOR_SOL, working, antiOscillation));
}

/**
 * Size the per-agent reclaim. Pure, so the safety invariants are unit-testable
 * without a database or an RPC.
 *
 * Invariants:
 *   · a non-platform owner is NEVER planned, whatever the balance
 *   · an agent with committed capital (an open position) is never planned
 *   · a planned agent always retains at least its floor (via reclaimableSol)
 *
 * @param {Array<{agentId:string,name:string,address:string,owner:string,sol:number,openPositions?:number,strategy?:{enabled?:boolean,perTradeSol?:number}}>} candidates
 * @param {{minSweepSol?:number, maxWallets?:number}} [opts]
 * @returns {{plan:Array<{agentId:string,name:string,address:string,sol:number,floorSol:number}>, skipped:Array<{name:string,reason:string}>, totalSol:number}}
 */
export function planAgentReclaim(candidates, opts = {}) {
	const minSweep = Number.isFinite(opts.minSweepSol) ? opts.minSweepSol : MIN_SWEEP_SOL;
	const maxWallets = Number.isFinite(opts.maxWallets) ? opts.maxWallets : AGENT_RECLAIM_MAX_WALLETS;
	const plan = [];
	const skipped = [];
	let total = 0;
	for (const c of candidates) {
		if (!isPlatformOwnedAgent(c.owner)) {
			skipped.push({ name: c.name, reason: 'not_platform_owned' });
			continue;
		}
		if (Number(c.openPositions) > 0) {
			skipped.push({ name: c.name, reason: 'capital_committed' });
			continue;
		}
		if (c.address === ECONOMY_MASTER_ADDRESS) {
			skipped.push({ name: c.name, reason: 'is_master' });
			continue;
		}
		const floorSol = agentReclaimFloorSol(c.strategy);
		const reclaimable = reclaimableSol(c.sol, floorSol, minSweep);
		if (reclaimable <= 0) {
			skipped.push({ name: c.name, reason: 'at_or_below_floor' });
			continue;
		}
		if (plan.length >= maxWallets) {
			skipped.push({ name: c.name, reason: 'run_cap_reached' });
			continue;
		}
		plan.push({ agentId: c.agentId, name: c.name, address: c.address, sol: reclaimable, floorSol });
		total = round(total + reclaimable);
	}
	return { plan, skipped, totalSol: total };
}

/**
 * Shape one `reclaimIdleAgentSol` SQL row into the candidate `planAgentReclaim`
 * consumes. Pure, and exported for the same reason the planner is: every safety
 * guard downstream reads a field that is set HERE, so a field this mapping fails
 * to carry silently disables the guard that depends on it.
 *
 * That is not hypothetical. `strategy.autoFundEnabled` was missing here while
 * `agentReclaimFloorSol()` already derived the anti-oscillation floor from it, so
 * the floor read `undefined`, collapsed to 0, and the funder/reclaim ping-pong
 * the guard exists to prevent ran in production against a green unit suite. The
 * pure-function tests could not catch it because they built candidates by hand.
 * Keep every guard-bearing field asserted in tests/economy-sweepback.test.js.
 *
 * @param {{agent_id:string, name?:string|null, address:string, owner:string, secret:string,
 *          open_positions?:number, strategy_enabled?:boolean|null,
 *          auto_fund_enabled?:boolean|null, per_trade_lamports?:number|string|null}} row
 * @param {number} sol on-chain balance already read for this row
 * @returns {{agentId:string,name:string,address:string,owner:string,secret:string,sol:number,
 *           openPositions:number,strategy:{enabled:boolean,autoFundEnabled:boolean,perTradeSol:number}}}
 */
export function agentCandidateFromRow(row, sol) {
	return {
		agentId: row.agent_id,
		name: row.name || 'Agent',
		address: row.address,
		owner: row.owner,
		secret: row.secret,
		sol,
		openPositions: Number(row.open_positions) || 0,
		strategy: {
			enabled: Boolean(row.strategy_enabled),
			// The funder's opt-in flag, NOT `enabled` — a disabled strategy still gets
			// refilled, so it still oscillates if swept below the funding target.
			autoFundEnabled: row.auto_fund_enabled === true,
			perTradeSol:
				row.per_trade_lamports != null ? Number(row.per_trade_lamports) / LAMPORTS_PER_SOL : 0,
		},
	};
}

/**
 * Pull idle SOL out of PLATFORM-OWNED agent custody wallets back to the economy
 * master, so the fee wallet refills itself from capital the platform already owns
 * instead of waiting on an external top-up. Destination is the same hard-locked
 * ECONOMY_MASTER_ADDRESS constant every other sweep uses; no parameter redirects it.
 *
 * @param {object} args
 * @param {import('@solana/web3.js').Connection} args.connection
 * @param {'mainnet'|'devnet'} [args.network]
 * @param {boolean} [args.dryRun]
 * @param {number} [args.maxWallets]
 * @returns {Promise<{master:string, reclaimedSol:number, moves:Array, skipped:Array, failed:Array, readErrors:Array}>}
 */
export async function reclaimIdleAgentSol({ connection, network = 'mainnet', dryRun = false, maxWallets } = {}) {
	const { PublicKey } = await import('@solana/web3.js');
	const { sql } = await import('./db.js');
	const master = ECONOMY_MASTER_ADDRESS;
	const moves = [];
	const failed = [];
	const readErrors = [];

	// Ownership is enforced in SQL first so a customer's agent never even leaves
	// the database, and again in planAgentReclaim() so an edit here cannot widen
	// the blast radius on its own.
	const rows = await sql`
		SELECT a.id                                        AS agent_id,
		       a.name                                      AS name,
		       a.meta->>'solana_address'                   AS address,
		       a.meta->>'encrypted_solana_secret'          AS secret,
		       LOWER(u.email)                              AS owner,
		       s.enabled                                   AS strategy_enabled,
		       s.per_trade_lamports                        AS per_trade_lamports,
		       -- The funder's opt-in flag, not the enabled flag: it decides whether a
		       -- refill is coming, so it decides whether sweeping here would oscillate.
		       s.auto_fund_enabled                         AS auto_fund_enabled,
		       (SELECT COUNT(*) FROM agent_sniper_positions p
		         WHERE p.agent_id = a.id AND p.status IN ('open', 'closing'))::int AS open_positions
		FROM agent_identities a
		JOIN users u ON u.id = a.user_id
		LEFT JOIN agent_sniper_strategies s ON s.agent_id = a.id AND s.network = ${network}
		WHERE a.deleted_at IS NULL
		  AND a.meta->>'solana_address' IS NOT NULL
		  AND a.meta->>'encrypted_solana_secret' IS NOT NULL
		  AND (LOWER(u.email) = ${PLATFORM_AGENT_OWNER_EMAIL}
		       OR LOWER(u.email) LIKE ${'%' + PLATFORM_AGENT_EMAIL_SUFFIX})
	`;

	const candidates = [];
	for (const r of rows) {
		let sol;
		try {
			sol = round((await connection.getBalance(new PublicKey(r.address), 'confirmed')) / LAMPORTS_PER_SOL);
		} catch (e) {
			readErrors.push({ name: r.name, address: r.address, reason: `rpc_error: ${e?.message}` });
			continue;
		}
		candidates.push(agentCandidateFromRow(r, sol));
	}
	// Biggest balances first: the run cap should spend its budget where the SOL is.
	candidates.sort((a, b) => b.sol - a.sol);

	const { plan, skipped } = planAgentReclaim(candidates, { maxWallets });

	const secrets = new Map(candidates.map((c) => [c.agentId, c.secret]));
	const { recoverSolanaAgentKeypair } = await import('./agent-wallet.js');

	// Recovery and broadcast are reported SEPARATELY on purpose. Sharing one
	// catch made an undecryptable wallet secret surface as a failed send, and
	// the alert then read "N failed send(s): The operation failed for an
	// operation-specific reason": a WebCrypto AES-GCM OperationError wearing
	// a Solana costume. That sent operators after RPC health and funding for a
	// key problem no amount of either could fix.
	//
	// The DRY run runs this same gate, which is the whole point of it being a
	// function. It used to return the raw plan without ever touching a key, so a
	// wallet whose secret is sealed under a retired WALLET_ENCRYPTION_KEY was
	// advertised as reclaimable forever: `?dry=1` promised 0.12 SOL the real leg
	// could never move, and two separate sessions read that plan and concluded
	// the treasury cron would self-heal. A plan nothing can execute is worse than
	// no plan, because it reads as capital on hand.
	const openReclaimWallet = async (p, { audit }) => {
		let keypair;
		try {
			// A plan-only read passes NO audit context: the real leg's decrypt is a
			// custody event worth a row, a dry run every scheduler minute is not.
			keypair = await recoverSolanaAgentKeypair(
				secrets.get(p.agentId),
				audit ? { agentId: p.agentId, reason: 'economy_reclaim', meta: { to: master, sol: p.sol } } : null,
			);
		} catch (e) {
			failed.push({
				name: p.name, address: p.address, sol: p.sol, stage: 'recover',
				reason: `secret_undecryptable: ${e?.message || 'unknown'}`,
			});
			return null;
		}
		if (keypair.publicKey.toBase58() !== p.address) {
			failed.push({ name: p.name, address: p.address, sol: p.sol, stage: 'recover', reason: 'keypair_address_mismatch' });
			return null;
		}
		return keypair;
	};

	if (dryRun) {
		for (const p of plan) {
			if (await openReclaimWallet(p, { audit: false })) moves.push({ ...p, dryRun: true });
		}
		return { master, reclaimedSol: round(moves.reduce((s, m) => s + m.sol, 0)), moves, skipped, failed, readErrors };
	}

	for (const p of plan) {
		const keypair = await openReclaimWallet(p, { audit: true });
		if (!keypair) continue;
		try {
			const signature = await sendSol({
				connection,
				fromKeypair: keypair,
				to: master,
				lamports: Math.round(p.sol * LAMPORTS_PER_SOL),
				memo: `three.ws reclaim ${p.name} → economy-master`,
				network,
			});
			moves.push({ ...p, signature });
		} catch (e) {
			failed.push({ name: p.name, address: p.address, sol: p.sol, stage: 'send', reason: e?.message || 'send_failed' });
		}
	}

	return {
		master,
		reclaimedSol: round(moves.reduce((s, m) => s + m.sol, 0)),
		moves,
		skipped,
		failed,
		readErrors,
	};
}

function round(n) {
	return Math.round(n * 1e9) / 1e9;
}
