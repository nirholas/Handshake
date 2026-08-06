// Agora — per-user spend policy for human citizens (Task 08).
//
// Humans act through the UI, but every action that moves value runs the SAME
// real on-chain AgenC operation an agent would, signed server-side from the
// citizen's custodial wallet. That makes a spend policy non-negotiable: a
// signed-in person must never be able to drain their custodial balance through
// repeated UI clicks, and mainnet $THREE must stay gated behind explicit opt-in.
//
// This is the human analog of api/_lib/agent-spend-policy.js + the pure
// @three-ws/agent-guards caps: agents meter against custody_events keyed by
// agent_identities; humans have no agent row, so we meter against the
// agora_activity projection (the same ledger that already records every posted
// bounty / hire). Caps are env-configurable with conservative defaults; the
// daily window is rolling 24h.
//
//   Devnet (SOL plumbing — the default economy):
//     AGORA_DEVNET_MAX_SOL_PER_TASK   default 0.05  SOL  (per post/hire)
//     AGORA_DEVNET_DAILY_SOL_CAP      default 0.50  SOL  (rolling 24h)
//   Mainnet ($THREE — real money, gated):
//     AGORA_MAINNET_ENABLED           must be '1'/'true' to allow mainnet at all
//     AGORA_MAX_THREE_PER_TASK        default 50000  $THREE (per post/hire)
//     AGORA_DAILY_THREE_CAP           default 250000 $THREE (rolling 24h)
//
// Atomic units: devnet rewards are lamports (1 SOL = 1e9); mainnet $THREE uses
// THREE_TOKEN_DECIMALS (api/_lib/token/config.js).

import { sql } from './db.js';
import { TOKEN_DECIMALS } from './token/config.js';

const LAMPORTS_PER_SOL = 1_000_000_000n;
const THREE_ATOMICS_PER_TOKEN = 10n ** BigInt(TOKEN_DECIMALS);

function envFloat(name, def) {
	const v = (process.env[name] || '').trim();
	if (!v) return def;
	const n = Number(v);
	return Number.isFinite(n) && n >= 0 ? n : def;
}

function envFlag(name) {
	const v = (process.env[name] || '').trim().toLowerCase();
	return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

// Convert a human token amount (SOL or $THREE) to atomic BigInt for a cluster.
function toAtomic(amount, cluster) {
	const whole = BigInt(Math.floor(amount));
	const frac = amount - Math.floor(amount);
	if (cluster === 'mainnet') {
		const fracAtomic = BigInt(Math.round(frac * Number(THREE_ATOMICS_PER_TOKEN)));
		return whole * THREE_ATOMICS_PER_TOKEN + fracAtomic;
	}
	const fracAtomic = BigInt(Math.round(frac * Number(LAMPORTS_PER_SOL)));
	return whole * LAMPORTS_PER_SOL + fracAtomic;
}

/**
 * Resolve the cluster for a request. Devnet is the default and always allowed.
 * Mainnet is allowed ONLY when both the caller asks for it AND the server has
 * AGORA_MAINNET_ENABLED set — otherwise we fall back to devnet (never silently
 * spend real $THREE).
 */
export function resolveCluster(requested) {
	const want = String(requested || '').trim().toLowerCase();
	if (want === 'mainnet' && envFlag('AGORA_MAINNET_ENABLED')) return 'mainnet';
	return 'devnet';
}

/** True if mainnet $THREE escrow is enabled on this server. */
export function mainnetEnabled() {
	return envFlag('AGORA_MAINNET_ENABLED');
}

/** The resolved caps for a cluster, in both human + atomic units. */
export function spendCaps(cluster) {
	if (cluster === 'mainnet') {
		const perTask = envFloat('AGORA_MAX_THREE_PER_TASK', 50_000);
		const daily = envFloat('AGORA_DAILY_THREE_CAP', 250_000);
		return {
			cluster,
			asset: '$THREE',
			rewardMint: '$THREE',
			perTask,
			daily,
			perTaskAtomic: toAtomic(perTask, 'mainnet'),
			dailyAtomic: toAtomic(daily, 'mainnet'),
		};
	}
	const perTask = envFloat('AGORA_DEVNET_MAX_SOL_PER_TASK', 0.05);
	const daily = envFloat('AGORA_DEVNET_DAILY_SOL_CAP', 0.5);
	return {
		cluster,
		asset: 'SOL',
		rewardMint: null, // native SOL reward on devnet
		perTask,
		daily,
		perTaskAtomic: toAtomic(perTask, 'devnet'),
		dailyAtomic: toAtomic(daily, 'devnet'),
	};
}

/**
 * Sum a citizen's outbound spend (posted bounties + hires) over the rolling
 * window, for the cluster's reward asset. Reads the agora_activity projection —
 * the same ledger the board + ticker read — so the cap reflects exactly what
 * the world shows.
 */
async function dailySpentAtomic(citizenId, rewardMint, windowHours = 24) {
	// reward_mint is '$THREE' on mainnet and NULL (native SOL) on devnet; match
	// the right lane so a devnet hold never counts against a mainnet cap.
	const rows = rewardMint
		? await sql`
			select coalesce(sum(amount_atomic), 0) as spent
			from agora_activity
			where citizen_id = ${citizenId}
			  and kind in ('posted_task', 'hired')
			  and reward_mint = ${rewardMint}
			  and created_at > now() - (${windowHours} * interval '1 hour')`
		: await sql`
			select coalesce(sum(amount_atomic), 0) as spent
			from agora_activity
			where citizen_id = ${citizenId}
			  and kind in ('posted_task', 'hired')
			  and reward_mint is null
			  and created_at > now() - (${windowHours} * interval '1 hour')`;
	try {
		return BigInt(rows[0]?.spent ?? 0);
	} catch {
		// numeric may come back as a decimal string; floor it.
		return BigInt(Math.floor(Number(rows[0]?.spent ?? 0)));
	}
}

// How long a pre-chain hold counts against the cap. Long enough to cover the
// slowest escrow round trip (register + fund + createTask on a congested
// cluster), short enough that a process killed mid-post frees the citizen's
// headroom on its own. Nothing sweeps these: the cap sum simply ignores older
// held rows, so expiry needs no cron to be correct.
const HOLD_TTL_MINUTES = 10;

/**
 * Check whether a citizen may escrow `amountAtomic` for a new bounty/hire under
 * their per-user policy on `cluster`. Returns { ok: true, caps, spentAtomic } or
 * { ok: false, status, code, message, detail }: the caller maps the failure
 * straight to an HTTP error. Never throws for a policy decision; only a DB error
 * propagates.
 *
 * This is the READ-ONLY check, used for previews and for the fast rejection path.
 * A post that is about to touch the chain must use reservePostSpend() instead,
 * which takes a hold in the same statement that sums the window.
 */
export async function checkPostSpend({ citizenId, cluster, amountAtomic, requestedCluster }) {
	// Mainnet must be explicitly enabled. If the caller asked for mainnet but the
	// server hasn't opted in, that's an actionable 403 — not a silent devnet
	// downgrade that would escrow on the wrong cluster.
	if (String(requestedCluster || '').toLowerCase() === 'mainnet' && !mainnetEnabled()) {
		return {
			ok: false,
			status: 403,
			code: 'mainnet_disabled',
			message:
				'Mainnet $THREE escrow is not enabled on this server. Set AGORA_MAINNET_ENABLED to post real-money bounties; devnet bounties work now.',
			detail: { cluster: 'mainnet' },
		};
	}

	const caps = spendCaps(cluster);
	const amount = BigInt(amountAtomic);

	if (amount <= 0n) {
		return { ok: false, status: 400, code: 'validation_error', message: 'reward must be greater than zero' };
	}

	if (amount > caps.perTaskAtomic) {
		return {
			ok: false,
			status: 403,
			code: 'per_task_cap',
			message: `That reward exceeds the per-bounty cap of ${caps.perTask} ${caps.asset}.`,
			detail: { perTask: caps.perTask, asset: caps.asset, cluster },
		};
	}

	const spent = await dailySpentAtomic(citizenId, caps.rewardMint);
	if (spent + amount > caps.dailyAtomic) {
		return {
			ok: false,
			status: 403,
			code: 'daily_cap',
			message: `This would exceed your rolling 24h Agora spend cap of ${caps.daily} ${caps.asset}.`,
			detail: { daily: caps.daily, asset: caps.asset, cluster },
		};
	}

	return { ok: true, caps, spentAtomic: spent.toString() };
}

/**
 * Reserve daily-cap headroom for a post/hire BEFORE the on-chain escrow, and
 * return the hold. Same policy decisions as checkPostSpend (mainnet gate,
 * per-task cap, rolling daily cap), but the daily check and the hold are ONE
 * statement under a per-citizen advisory lock, which is what closes the race
 * checkPostSpend alone left open (security review L6): the projection it meters
 * against is written after the chain call, so two concurrent posts could both
 * read a pre-spend total neither of them was any longer entitled to.
 *
 * The caller MUST resolve the hold: settlePostSpend() once the activity row is
 * projected (the projection then counts it), or releasePostSpend() if the escrow
 * never happened. An unresolved hold expires on its own after HOLD_TTL_MINUTES.
 *
 * @returns {Promise<{ ok: true, caps, spentAtomic: string, reservationId: string }
 *                  | { ok: false, status, code, message, detail? }>}
 */
export async function reservePostSpend({ citizenId, cluster, amountAtomic, requestedCluster }) {
	const pre = await checkPostSpend({ citizenId, cluster, amountAtomic, requestedCluster });
	if (!pre.ok) return pre;

	const caps = pre.caps;
	const amount = BigInt(amountAtomic).toString();
	const daily = caps.dailyAtomic.toString();
	const mint = caps.rewardMint;
	const rows = await sql`
		with locked as (
			select pg_advisory_xact_lock(hashtextextended(${String(citizenId)}, 0))
		),
		spent as (
			select coalesce(sum(amount_atomic), 0) as s
			from agora_activity
			where citizen_id = ${citizenId}
			  and kind in ('posted_task', 'hired')
			  and reward_mint is not distinct from ${mint}
			  and created_at > now() - interval '24 hours'
		),
		held as (
			select coalesce(sum(amount_atomic), 0) as s
			from agora_spend_reservations
			where citizen_id = ${citizenId}
			  and reward_mint is not distinct from ${mint}
			  and state = 'held'
			  and created_at > now() - (${HOLD_TTL_MINUTES} * interval '1 minute')
		)
		insert into agora_spend_reservations (citizen_id, amount_atomic, reward_mint)
		select ${citizenId}, ${amount}::numeric, ${mint}
		from spent, held, locked
		where spent.s + held.s + ${amount}::numeric <= ${daily}::numeric
		returning id, ((select s from spent) + (select s from held))::text as committed_before
	`;

	if (!rows.length) {
		return {
			ok: false,
			status: 403,
			code: 'daily_cap',
			message: `This would exceed your rolling 24h Agora spend cap of ${caps.daily} ${caps.asset}.`,
			detail: { daily: caps.daily, asset: caps.asset, cluster },
		};
	}
	return {
		ok: true,
		caps,
		spentAtomic: rows[0].committed_before ?? '0',
		reservationId: rows[0].id,
	};
}

/**
 * Mark a hold as settled once its activity row exists. Call it AFTER
 * projectActivity, never before: while both rows exist the spend is counted
 * twice, which is the conservative direction, whereas settling first opens a gap
 * where a concurrent post sees neither.
 */
export async function settlePostSpend(reservationId, { taskPda = null, txSignature = null } = {}) {
	if (!reservationId) return;
	await sql`
		update agora_spend_reservations
		set state = 'settled', resolved_at = now(),
		    task_pda = coalesce(${taskPda}, task_pda),
		    tx_signature = coalesce(${txSignature}, tx_signature)
		where id = ${reservationId} and state = 'held'
	`.catch((err) => {
		// The hold expires on its own, so a failed settle costs the citizen a few
		// minutes of headroom, never correctness. Log it rather than failing a post
		// whose escrow already landed on-chain.
		console.warn('[agora-policy] settle hold failed', { reservationId, reason: err?.message || String(err) });
	});
}

/** Release a hold whose escrow never happened, freeing the headroom immediately. */
export async function releasePostSpend(reservationId) {
	if (!reservationId) return;
	await sql`
		update agora_spend_reservations
		set state = 'released', resolved_at = now()
		where id = ${reservationId} and state = 'held'
	`.catch((err) => {
		console.warn('[agora-policy] release hold failed', { reservationId, reason: err?.message || String(err) });
	});
}
