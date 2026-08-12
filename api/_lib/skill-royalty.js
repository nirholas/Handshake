// Skill-call royalties: the author share of a paid skill invocation.
//
// Two payment lanes reach a priced marketplace skill, and both must accrue to
// the same author ledger:
//
//   1. The platform's own x402 rail (/api/x402/skill-call). The caller pays the
//      per-call price in USDC (Solana first, Base second); the endpoint routes
//      the full payment to the author's primary wallet via a payTo override,
//      minus the platform royalty bps declared here, and this module records
//      the author accrual against royalty_ledger after settlement.
//   2. In-process skill invocations (api/_lib/skill-runtime.js), which bill via
//      billSkillRoyalty in api/_lib/royalty.js and settle later through the
//      EIP-7710 delegation redeem leg (EVM, flag-gated).
//
// This module is the split math (pure, unit-tested) plus the accrual writer.
// The pure part has no DB and no chain access so the split invariants are
// provable in isolation; the writer is fire-and-forget from the paid-endpoint
// settle hook so an accrual failure can never break a settled payment.

import { sql } from './db.js';

// The platform's cut of a per-call skill payment, in basis points (default
// 2.5%, matching the marketplace fee in api/_lib/fee.js). The author keeps the
// rest. Overridable per-deploy via X402_SKILL_ROYALTY_PLATFORM_BPS; clamped to
// [0, 5000] so a misconfig can never take more than half a call's revenue.
export const SKILL_ROYALTY_DEFAULT_PLATFORM_BPS = 250;
export const SKILL_ROYALTY_MAX_PLATFORM_BPS = 5000;

export function skillRoyaltyPlatformBps(env = process.env) {
	const raw = Number.parseInt(String(env.X402_SKILL_ROYALTY_PLATFORM_BPS ?? ''), 10);
	if (!Number.isFinite(raw) || raw < 0) return SKILL_ROYALTY_DEFAULT_PLATFORM_BPS;
	return Math.min(raw, SKILL_ROYALTY_MAX_PLATFORM_BPS);
}

// USDC is 6-decimal everywhere the x402 rail settles.
const USDC_DECIMALS = 6;

function toAtomics(value) {
	if (typeof value === 'bigint') return value < 0n ? 0n : value;
	if (typeof value === 'number') {
		if (!Number.isFinite(value) || value <= 0) return 0n;
		return BigInt(Math.floor(value));
	}
	const s = String(value ?? '').trim();
	if (!/^\d+$/.test(s)) return 0n;
	return BigInt(s);
}

/**
 * Split a settled per-call payment between the skill author and the platform.
 * Pure and exact: author = price - floor(price × platformBps / 10000), so
 * authorAtomics + platformAtomics === priceAtomics for every input and no
 * value is created or lost. The author rounds up on odd atomics (the platform
 * absorbs the rounding dust), which is the deliberate bias toward the creator.
 *
 * @param {{ priceAtomics: bigint|number|string, platformBps?: number }} args
 * @returns {{
 *   priceAtomics: bigint,
 *   platformBps: number,
 *   authorAtomics: bigint,
 *   platformAtomics: bigint,
 *   authorUsd: number,
 *   platformUsd: number,
 * }}
 */
export function computeSkillRoyaltySplit({ priceAtomics, platformBps }) {
	const price = toAtomics(priceAtomics);
	const bps = Math.max(
		0,
		Math.min(
			SKILL_ROYALTY_MAX_PLATFORM_BPS,
			Math.round(Number(platformBps ?? SKILL_ROYALTY_DEFAULT_PLATFORM_BPS) || 0),
		),
	);
	const platform = price > 0n && bps > 0 ? (price * BigInt(bps)) / 10000n : 0n;
	const author = price - platform;
	return {
		priceAtomics: price,
		platformBps: bps,
		authorAtomics: author,
		platformAtomics: platform,
		authorUsd: Number(author) / 10 ** USDC_DECIMALS,
		platformUsd: Number(platform) / 10 ** USDC_DECIMALS,
	};
}

/**
 * Record a royalty accrual for one settled x402 skill call. Called from the
 * paid-endpoint onSettled hook (fire-and-forget): NEVER throws, so a Neon
 * hiccup can never fail a payment that already settled on-chain. The author
 * accrual is what they earned; on the x402 rail the funds already routed to
 * their wallet at settle time, so the row lands 'settled' with the rail's
 * transaction as provenance (source 'x402'). Rows billed by the in-process
 * runtime (source 'skill-runtime') stay 'pending' for the delegation redeem
 * leg instead — settleRoyalties in api/_lib/royalty.js owns those.
 *
 * @param {{ skillId: string, authorId: string, payer?: string|null,
 *   network?: string|null, txHash?: string|null, priceAtomics: bigint|number|string,
 *   platformBps?: number }} opts
 * @returns {Promise<{ ok: boolean, accrual?: object, reason?: string }>}
 */
export async function accrueSkillCallRoyalty(opts) {
	try {
		const { skillId, authorId } = opts;
		if (!skillId || !authorId) return { ok: false, reason: 'missing_skill_or_author' };
		const split = computeSkillRoyaltySplit({
			priceAtomics: opts.priceAtomics,
			platformBps: opts.platformBps ?? skillRoyaltyPlatformBps(),
		});
		if (split.authorAtomics <= 0n) return { ok: false, reason: 'zero_price', accrual: split };

		const [row] = await sql`
			INSERT INTO royalty_ledger
				(skill_id, agent_id, author_user_id, price_usd, status,
				 settled_at, tx_hash, network, payer, source, platform_fee_usd)
			VALUES
				(${skillId}, null, ${authorId}, ${split.authorUsd}, 'settled',
				 now(), ${opts.txHash ?? null}, ${opts.network ?? null},
				 ${opts.payer ?? null}, 'x402', ${split.platformUsd})
			RETURNING id
		`;
		return { ok: true, accrual: { ...split, ledgerId: row?.id ?? null } };
	} catch (e) {
		console.error('[skill-royalty] accrual failed', e?.message);
		return { ok: false, reason: e?.message ?? 'accrual_failed' };
	}
}
