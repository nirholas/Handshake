// Fork Royalty Streams — provenance income for avatar creators.
//
// WHY ONLY three.ws CAN DO THIS: the platform already welds a verifiable fork
// lineage (avatars.parent_avatar_id + source_meta.forked_from) to a real,
// funded, self-custodial wallet on every agent. So when you make a great avatar
// and others fork it, and THEIR forks earn, a creator-set slice of that real
// income can stream back up the lineage to your wallet — automatically, on-chain,
// transparently.
//
// THE OWNERSHIP INVARIANT (never violated): a fork solely owns its wallet and its
// funds. A royalty is an OPT-IN split on the fork's DEFINED NEW INCOME at the
// moment it is earned — never a claim on the fork's existing balance, never key
// access for the ancestor. The forker consents to the exact terms at fork time
// and always keeps the clear majority. The payout is a normal outbound transfer
// the fork's own custodial signer authorizes (the same signer the owner already
// trusts for withdraws/trades), gated to a hard-capped, decaying slice.
//
// SAFETY: opt-in · per-creator + total caps · depth decay · majority-to-forker ·
// idempotent (one obligation per income event per ancestor) · audited on both
// sides · $THREE-rule clean (payout rail is native SOL; no other mint named).
//
// This module is split into PURE math (testable without a DB or chain) and the
// DB/chain-touching engine. The cron-free trigger is fire-and-forget from the
// real income paths (tip + money-stream settlement) in api/agents/solana-wallet.js.

import { sql } from './db.js';
import { insertNotification } from './notify.js';

// ── Platform policy constants (the fairness guardrails) ──────────────────────

// The most a single creator may set as their fork royalty (10%). A creator
// configuring a higher number is clamped to this — the UI shows the cap.
export const ROYALTY_PER_CREATOR_CAP_BPS = 1000;

// The hard ceiling on TOTAL upstream take across the whole lineage (20%). After
// decay, if the summed schedule still exceeds this, every share is scaled down
// proportionally so the forker keeps at least 10000 - this.
export const ROYALTY_TOTAL_CAP_BPS = 2000;

// The forker can never keep less than this share of their own eligible income
// (80%). Equals 10000 - ROYALTY_TOTAL_CAP_BPS; asserted by resolveSchedule.
export const MIN_FORKER_KEEP_BPS = 10000 - ROYALTY_TOTAL_CAP_BPS;

// Geometric depth decay: the immediate parent earns its set rate; each further
// generation earns half of the previous, so deep ancestors fade rather than
// stack. depth 1 → 1×, depth 2 → 0.5×, depth 3 → 0.25× …
export const ROYALTY_DEPTH_DECAY = 0.5;

// Royalties pay on native SOL income only — the rail we can split and settle
// atomically. SPL/USDC income is honestly out of scope (no fake "pending"
// obligation we never pay). Surfaced in the config copy.
export const ROYALTY_ELIGIBLE_ASSET = 'SOL';

// Skip dust: a per-ancestor share below this (0.00002 SOL) is recorded 'skipped'
// rather than paid — a sub-dust transfer would cost more in fees than it moves.
export const ROYALTY_MIN_PAYOUT_LAMPORTS = 20_000n;

// Lamports kept back when sizing a payout against the fork's live balance, so a
// royalty transfer can never push the wallet below fee budget.
const ROYALTY_FEE_RESERVE_LAMPORTS = 15_000n;

// ── Config (the rate a creator sets, stored on the agent record) ─────────────

const DEFAULT_ELIGIBLE = { tips: true, stream: true };

/**
 * Read & normalize an agent's fork-royalty config from its meta. Defaults to
 * "no royalty" (forks are fully free — the platform default). Always returns a
 * sane shape so callers never branch on undefined.
 * @returns {{ bps:number, eligible:{tips:boolean,stream:boolean}, set_at:string|null }}
 */
export function getRoyaltyConfig(meta) {
	const raw = meta?.fork_royalty;
	if (!raw || typeof raw !== 'object') {
		return { bps: 0, eligible: { ...DEFAULT_ELIGIBLE }, set_at: null };
	}
	const bps = clampCreatorBps(raw.bps);
	const eligible = {
		tips: raw.eligible?.tips !== false,
		stream: raw.eligible?.stream !== false,
	};
	return { bps, eligible, set_at: raw.set_at || null };
}

/** Clamp a creator-supplied royalty to [0, ROYALTY_PER_CREATOR_CAP_BPS]. */
export function clampCreatorBps(bps) {
	const n = Math.round(Number(bps) || 0);
	if (!Number.isFinite(n) || n <= 0) return 0;
	return Math.min(n, ROYALTY_PER_CREATOR_CAP_BPS);
}

// ── PURE: schedule resolution (decay + cap) ──────────────────────────────────

/**
 * Resolve the effective upstream royalty schedule for a fork from its ordered
 * ancestor chain. Pure — no DB, no chain — so the fairness math is unit-tested
 * in isolation.
 *
 * @param {Array<{ depth:number, ancestor_agent_id:string, ancestor_avatar_id?:string,
 *                 ancestor_owner_id?:string, ancestor_owner_name?:string,
 *                 ancestor_wallet?:string|null, set_bps:number,
 *                 eligible?:{tips:boolean,stream:boolean} }>} ancestors
 *        depth 1 = immediate parent. set_bps = that ancestor's configured rate.
 * @returns {{ total_bps:number, keep_bps:number, entries:Array }}
 */
export function resolveSchedule(ancestors) {
	const decayed = [];
	for (const a of ancestors || []) {
		const setBps = clampCreatorBps(a.set_bps);
		if (setBps <= 0) continue; // ancestor opted out — contributes nothing
		const depth = Math.max(1, Math.round(a.depth || 1));
		const factor = Math.pow(ROYALTY_DEPTH_DECAY, depth - 1);
		const bps = Math.round(setBps * factor);
		if (bps <= 0) continue; // decayed below a whole bp — drop
		decayed.push({
			depth,
			ancestor_agent_id: a.ancestor_agent_id,
			ancestor_avatar_id: a.ancestor_avatar_id ?? null,
			ancestor_owner_id: a.ancestor_owner_id ?? null,
			ancestor_owner_name: a.ancestor_owner_name ?? null,
			ancestor_wallet: a.ancestor_wallet ?? null,
			set_bps: setBps,
			bps,
			eligible: {
				tips: a.eligible?.tips !== false,
				stream: a.eligible?.stream !== false,
			},
		});
	}

	let total = decayed.reduce((s, e) => s + e.bps, 0);

	// Enforce the absolute total cap by scaling every share down proportionally.
	// Largest-remainder rounding keeps the scaled sum exactly at the cap.
	if (total > ROYALTY_TOTAL_CAP_BPS && total > 0) {
		const scale = ROYALTY_TOTAL_CAP_BPS / total;
		let running = 0;
		const withRemainder = decayed.map((e) => {
			const exact = e.bps * scale;
			const floor = Math.floor(exact);
			running += floor;
			return { e, floor, frac: exact - floor };
		});
		let leftover = ROYALTY_TOTAL_CAP_BPS - running;
		withRemainder.sort((a, b) => b.frac - a.frac);
		for (const item of withRemainder) {
			item.e.bps = item.floor + (leftover > 0 ? 1 : 0);
			if (leftover > 0) leftover--;
		}
		total = decayed.reduce((s, e) => s + e.bps, 0);
	}

	// Drop any entry that scaled to zero, re-sort by depth for a stable receipt.
	const entries = decayed.filter((e) => e.bps > 0).sort((a, b) => a.depth - b.depth);
	total = entries.reduce((s, e) => s + e.bps, 0);

	// Invariant the whole feature rests on: the forker keeps the clear majority.
	const keep = 10000 - total;
	if (keep < MIN_FORKER_KEEP_BPS) {
		// Unreachable given the cap, but assert rather than silently over-tax.
		throw new Error(`royalty schedule would leave forker ${keep}bps (< ${MIN_FORKER_KEEP_BPS})`);
	}

	return { total_bps: total, keep_bps: keep, entries };
}

/**
 * Split a lamport income amount across a resolved schedule for one income type.
 * Pure. Entries whose eligibility excludes `kind` get nothing. Shares below the
 * dust floor are marked skipped (not paid). Returns the per-ancestor breakdown
 * plus what the forker keeps — the exact numbers both sides see.
 *
 * @param {bigint} amountLamports
 * @param {{ entries:Array }} schedule  (from resolveSchedule / a stored snapshot)
 * @param {'tips'|'stream'} kind
 */
export function splitIncome(amountLamports, schedule, kind) {
	const amount = typeof amountLamports === 'bigint' ? amountLamports : BigInt(amountLamports || 0);
	const out = [];
	let upstream = 0n;
	for (const e of schedule?.entries || []) {
		const eligible = e.eligible ? e.eligible[kind] !== false : true;
		const share = eligible ? (amount * BigInt(e.bps)) / 10000n : 0n;
		const skipped = !eligible || share < ROYALTY_MIN_PAYOUT_LAMPORTS;
		out.push({
			ancestor_agent_id: e.ancestor_agent_id,
			ancestor_owner_id: e.ancestor_owner_id ?? null,
			ancestor_owner_name: e.ancestor_owner_name ?? null,
			ancestor_wallet: e.ancestor_wallet ?? null,
			depth: e.depth,
			bps: e.bps,
			amount_lamports: skipped ? 0n : share,
			skipped,
			reason: !eligible ? 'ineligible_income_type' : share < ROYALTY_MIN_PAYOUT_LAMPORTS ? 'below_dust' : null,
		});
		if (!skipped) upstream += share;
	}
	return { upstream_lamports: upstream, keep_lamports: amount - upstream, splits: out };
}

// ── DB: lineage resolution + snapshot ────────────────────────────────────────

const MAX_LINEAGE_DEPTH = 12; // cap the walk; deeper ancestors are decayed to ~0 anyway

/**
 * Walk a forked avatar's lineage (avatars.parent_avatar_id) up to the root,
 * resolving each ancestor's live agent + its CURRENT royalty config + wallet.
 * Returns the ordered ancestor list (depth 1 = immediate parent) ready for
 * resolveSchedule. A missing agent/wallet still yields an entry (set_bps from
 * config) so the snapshot is complete; payout-time re-resolution handles the
 * deleted-ancestor case.
 *
 * @param {string} forkAvatarId  the NEW (forked) avatar's id — its parent is depth 1
 */
export async function resolveAncestorChain(forkAvatarId) {
	const ancestors = [];
	const seen = new Set([forkAvatarId]);
	let cursorAvatarId = forkAvatarId;
	let depth = 1;

	while (depth <= MAX_LINEAGE_DEPTH) {
		const [parent] = await sql`
			select a.id, a.owner_id, a.parent_avatar_id, u.display_name as owner_name
			from avatars a
			join avatars child on child.parent_avatar_id = a.id
			left join users u on u.id = a.owner_id
			where child.id = ${cursorAvatarId} and a.deleted_at is null
			limit 1
		`;
		if (!parent || seen.has(parent.id)) break; // root reached or cycle guard
		seen.add(parent.id);

		// The ancestor's live agent: its current royalty config + payout wallet.
		const [agent] = await sql`
			select id, user_id, meta, deleted_at
			from agent_identities
			where avatar_id = ${parent.id}
			order by created_at asc
			limit 1
		`;
		const cfg = getRoyaltyConfig(agent?.meta);
		ancestors.push({
			depth,
			ancestor_agent_id: agent?.id ?? null,
			ancestor_avatar_id: parent.id,
			ancestor_owner_id: parent.owner_id ?? null,
			ancestor_owner_name: parent.owner_name ?? null,
			ancestor_wallet: agent?.meta?.solana_address ?? null,
			set_bps: agent ? cfg.bps : 0,
			eligible: cfg.eligible,
		});

		cursorAvatarId = parent.id;
		depth++;
	}

	// Only ancestors with a resolvable agent can actually receive a royalty.
	return ancestors.filter((a) => a.ancestor_agent_id);
}

/**
 * Resolve the upstream royalty schedule a fork of `sourceAvatarId` WOULD carry.
 * The source avatar becomes the fork's parent (depth 1), so the source's own
 * royalty config is the first entry, followed by its ancestors. Used by both the
 * fork consent preview and the fork-time snapshot.
 *
 * @param {string} sourceAvatarId  the avatar being forked
 */
export async function resolveScheduleForSource(sourceAvatarId) {
	const [source] = await sql`
		select a.id, a.owner_id, u.display_name as owner_name
		from avatars a left join users u on u.id = a.owner_id
		where a.id = ${sourceAvatarId} and a.deleted_at is null
		limit 1
	`;
	if (!source) return resolveSchedule([]);

	const [sourceAgent] = await sql`
		select id, meta from agent_identities
		where avatar_id = ${source.id}
		order by created_at asc limit 1
	`;
	const sourceCfg = getRoyaltyConfig(sourceAgent?.meta);

	const ancestors = [];
	if (sourceAgent?.id) {
		ancestors.push({
			depth: 1,
			ancestor_agent_id: sourceAgent.id,
			ancestor_avatar_id: source.id,
			ancestor_owner_id: source.owner_id ?? null,
			ancestor_owner_name: source.owner_name ?? null,
			ancestor_wallet: sourceAgent.meta?.solana_address ?? null,
			set_bps: sourceCfg.bps,
			eligible: sourceCfg.eligible,
		});
	}
	// The source's own ancestors shift down one generation for the new fork.
	const upstream = await resolveAncestorChain(source.id);
	for (const a of upstream) ancestors.push({ ...a, depth: a.depth + 1 });

	return resolveSchedule(ancestors);
}

/**
 * Persist the immutable consent snapshot for a freshly created fork. Idempotent
 * on fork_agent_id (a re-run updates nothing). Skips writing when the schedule
 * is empty — a free fork carries no terms row.
 */
export async function snapshotForkRoyaltyTerms({ forkAgentId, forkAvatarId, acceptedBy, schedule }) {
	if (!forkAgentId || !schedule || schedule.total_bps <= 0 || !schedule.entries?.length) {
		return { written: false };
	}
	await sql`
		insert into fork_royalty_terms (fork_agent_id, fork_avatar_id, total_bps, schedule, accepted_by)
		values (
			${forkAgentId}, ${forkAvatarId ?? null}, ${schedule.total_bps},
			${JSON.stringify(schedule.entries)}::jsonb, ${acceptedBy ?? null}
		)
		on conflict (fork_agent_id) do nothing
	`;
	return { written: true, total_bps: schedule.total_bps };
}

/** Load a fork's stored consent snapshot (or null when it carries no terms). */
export async function loadForkRoyaltyTerms(forkAgentId) {
	const [row] = await sql`
		select id, fork_agent_id, fork_avatar_id, total_bps, schedule, created_at
		from fork_royalty_terms where fork_agent_id = ${forkAgentId} limit 1
	`;
	if (!row) return null;
	return {
		id: row.id,
		fork_agent_id: row.fork_agent_id,
		fork_avatar_id: row.fork_avatar_id,
		total_bps: Number(row.total_bps),
		entries: Array.isArray(row.schedule) ? row.schedule : [],
		created_at: row.created_at,
	};
}

// ── DB + chain: the real payout engine ───────────────────────────────────────

/**
 * Apply fork royalties for ONE eligible income event on a fork.
 *
 * Flow (idempotent + audited):
 *   1. Load the fork's frozen consent snapshot. No terms → honest no-op.
 *   2. Split the income per the snapshot for this income type (decay+cap already
 *      baked into the snapshot bps). Nothing owed → no-op.
 *   3. Claim one ledger row per ancestor via INSERT … RETURNING with the
 *      (source_event_id, ancestor_agent_id) unique key. Only rows THIS call
 *      created are paid — concurrent triggers and retries claim nothing and so
 *      never double-pay.
 *   4. Re-resolve each ancestor's LIVE wallet (a deleted ancestor / missing
 *      wallet reroutes to the platform treasury per the disclosed rule).
 *   5. Send the real on-chain transfers FROM the fork's custodial signer, mark
 *      rows confirmed/failed, and mirror an audit event onto both sides.
 *
 * Fire-and-forget from the income path — never throws into the caller.
 *
 * @param {string} forkAgentId
 * @param {{ eventId:number|string, kind:'tip'|'stream', amountLamports:bigint|number|string,
 *           asset?:string, network?:string, fromWallet?:string }} income
 */
export async function applyForkRoyalties(forkAgentId, income) {
	try {
		const asset = (income.asset || 'SOL').toUpperCase();
		if (asset !== ROYALTY_ELIGIBLE_ASSET) return { applied: false, reason: 'ineligible_asset' };
		const kind = income.kind === 'stream' ? 'stream' : 'tips';
		const network = income.network === 'devnet' ? 'devnet' : 'mainnet';
		const sourceEventId = income.eventId != null ? String(income.eventId) : null;
		if (!sourceEventId) return { applied: false, reason: 'no_event_id' };

		const terms = await loadForkRoyaltyTerms(forkAgentId);
		if (!terms || terms.total_bps <= 0) return { applied: false, reason: 'no_terms' };

		const amount = typeof income.amountLamports === 'bigint'
			? income.amountLamports
			: BigInt(income.amountLamports || 0);
		if (amount <= 0n) return { applied: false, reason: 'zero_income' };

		const { splits, upstream_lamports } = splitIncome(amount, terms, kind);
		const payable = splits.filter((s) => !s.skipped && s.amount_lamports > 0n);
		if (!payable.length) {
			// Record skipped obligations so the ledger is honest (e.g. dust), then stop.
			await recordSkips(forkAgentId, sourceEventId, kind, network, splits);
			return { applied: false, reason: 'nothing_payable', upstream_lamports: upstream_lamports.toString() };
		}

		// 3. Claim ledger rows. Only freshly-inserted rows are ours to pay.
		const claimed = [];
		for (const s of payable) {
			const [row] = await sql`
				insert into fork_royalty_payouts (
					fork_agent_id, ancestor_agent_id, recipient_wallet, depth, bps,
					source_event_id, source_kind, network, asset, amount_lamports, status, meta
				) values (
					${forkAgentId}, ${s.ancestor_agent_id}, ${s.ancestor_wallet ?? null}, ${s.depth}, ${s.bps},
					${sourceEventId}, ${kind === 'stream' ? 'stream' : 'tip'}, ${network}, 'SOL',
					${s.amount_lamports.toString()}::bigint, 'pending',
					${JSON.stringify({ owner_name: s.ancestor_owner_name, from: income.fromWallet || null })}::jsonb
				)
				on conflict (source_event_id, ancestor_agent_id) do nothing
				returning id, ancestor_agent_id, amount_lamports, depth, bps
			`;
			if (row) claimed.push({ ...s, payoutId: row.id });
		}
		if (!claimed.length) return { applied: false, reason: 'already_processed' };

		// 4 + 5. Resolve live wallets, send, settle.
		await settlePayouts({ forkAgentId, network, claimed, sourceEventId, kind });
		return { applied: true, paid: claimed.length, upstream_lamports: upstream_lamports.toString() };
	} catch (err) {
		console.error('[fork-royalties] applyForkRoyalties failed', forkAgentId, err?.message);
		return { applied: false, reason: 'error', error: err?.message };
	}
}

// Record dust/ineligible obligations as 'skipped' ledger rows so the split view
// is fully honest about what was and wasn't owed. Idempotent.
async function recordSkips(forkAgentId, sourceEventId, kind, network, splits) {
	for (const s of splits) {
		if (!s.skipped) continue;
		await sql`
			insert into fork_royalty_payouts (
				fork_agent_id, ancestor_agent_id, recipient_wallet, depth, bps,
				source_event_id, source_kind, network, asset, amount_lamports, status, reason, meta
			) values (
				${forkAgentId}, ${s.ancestor_agent_id}, ${s.ancestor_wallet ?? null}, ${s.depth}, ${s.bps},
				${sourceEventId}, ${kind === 'stream' ? 'stream' : 'tip'}, ${network}, 'SOL',
				0, 'skipped', ${s.reason || 'below_dust'},
				${JSON.stringify({ owner_name: s.ancestor_owner_name })}::jsonb
			)
			on conflict (source_event_id, ancestor_agent_id) do nothing
		`.catch(() => {});
	}
}

/**
 * Resolve live recipient wallets (reroute deleted ancestors), execute the real
 * SOL transfers from the fork's custodial signer, and settle each ledger row.
 */
async function settlePayouts({ forkAgentId, network, claimed, sourceEventId, kind }) {
	// Load the fork's signer + verify it can cover the splits.
	const [forkAgent] = await sql`
		select id, user_id, name, meta from agent_identities where id = ${forkAgentId} and deleted_at is null limit 1
	`;
	if (!forkAgent?.meta?.encrypted_solana_secret) {
		await failRows(claimed, 'fork_wallet_unavailable');
		return;
	}

	// Resolve each ancestor's LIVE wallet; reroute the deleted/wallet-less per rule.
	const { loadCoinTreasury } = await import('./coin/treasury.js');
	let treasuryAddr = null;
	const transfers = [];
	for (const c of claimed) {
		const [anc] = await sql`
			select id, meta, deleted_at from agent_identities where id = ${c.ancestor_agent_id} limit 1
		`;
		let wallet = anc && !anc.deleted_at ? anc.meta?.solana_address || null : null;
		let rerouted = false;
		let reason = null;
		if (!wallet) {
			// Disclosed rule: a deleted / wallet-less ancestor's share routes to the
			// platform treasury rather than vanishing or blocking the others.
			if (!treasuryAddr) {
				try { treasuryAddr = loadCoinTreasury().publicKey.toBase58(); } catch { treasuryAddr = null; }
			}
			wallet = treasuryAddr;
			rerouted = true;
			reason = anc?.deleted_at ? 'ancestor_deleted' : 'ancestor_no_wallet';
		}
		if (!wallet) { // no treasury configured either — cannot pay; fail (retryable)
			await failRows([c], 'no_recipient');
			continue;
		}
		transfers.push({ ...c, to: wallet, lamports: BigInt(c.amount_lamports), rerouted, reason });
	}
	if (!transfers.length) return;

	// Affordability: the income just landed in the fork wallet, but a vanity swap
	// or concurrent spend could shrink it. Never overdraw — fail (retryable) if so.
	const total = transfers.reduce((s, t) => s + t.lamports, 0n);
	try {
		const { solanaConnection } = await import('./agent-pumpfun.js');
		const { PublicKey } = await import('@solana/web3.js');
		const conn = solanaConnection(network);
		const bal = BigInt(await conn.getBalance(new PublicKey(forkAgent.meta.solana_address)));
		if (bal < total + ROYALTY_FEE_RESERVE_LAMPORTS) {
			await failRows(transfers, 'insufficient_balance');
			return;
		}
	} catch {
		// Balance read failed — proceed; the on-chain send still guards against
		// overdraw (a transfer exceeding balance reverts and is marked failed).
	}

	// Recover the fork's signer (audited) and send the real transfers.
	const { recoverSolanaAgentKeypair } = await import('./agent-wallet.js');
	const { sendSolBatched } = await import('./coin/treasury.js');
	let signer;
	try {
		signer = await recoverSolanaAgentKeypair(forkAgent.meta.encrypted_solana_secret, {
			agentId: forkAgentId,
			userId: forkAgent.user_id,
			reason: 'fork_royalty',
			meta: { source_event_id: sourceEventId, kind, recipients: transfers.length },
		});
	} catch (e) {
		await failRows(transfers, 'key_recover_failed');
		return;
	}

	const results = await sendSolBatched({
		from: signer,
		transfers: transfers.map((t) => ({ to: t.to, lamports: t.lamports, ref: t })),
		network,
	});

	for (const r of results) {
		for (const recipient of r.recipients) {
			const t = recipient.ref;
			if (r.error || !r.signature) {
				await sql`
					update fork_royalty_payouts set status='failed', reason=${r.error || 'send_failed'},
						recipient_wallet=${t.to}, rerouted=${t.rerouted}
					where id=${t.payoutId}
				`.catch(() => {});
				continue;
			}
			await sql`
				update fork_royalty_payouts set status='confirmed', signature=${r.signature},
					recipient_wallet=${t.to}, rerouted=${t.rerouted}, reason=${t.reason},
					confirmed_at=now()
				where id=${t.payoutId}
			`.catch(() => {});
			await mirrorCustody({ forkAgentId, ancestorAgentId: t.ancestor_agent_id, recipient: t.to,
				lamports: t.lamports, signature: r.signature, network, kind, rerouted: t.rerouted });
			if (t.ancestor_owner_id) {
				let usd = null;
				try { const { lamportsToUsd } = await import('./agent-trade-guards.js'); usd = await lamportsToUsd(t.lamports); } catch { /* unpriced */ }
				insertNotification(t.ancestor_owner_id, 'royalty_paid', {
					actor: forkAgent.name || 'A fork of your avatar',
					sol: Number(t.lamports) / 1e9,
					usd,
					depth: t.depth,
					signature: r.signature,
					tx_signature: r.signature,
					link: `/agent/${encodeURIComponent(t.ancestor_agent_id)}`,
				});
			}
		}
	}
}

async function failRows(rows, reason) {
	for (const r of rows) {
		await sql`update fork_royalty_payouts set status='failed', reason=${reason} where id=${r.payoutId}`.catch(() => {});
	}
}

/**
 * Mirror a confirmed royalty into the custody/audit trail on BOTH sides:
 *   - the fork (descendant) sees an outbound 'royalty_paid' spend row;
 *   - the ancestor sees an inbound 'royalty' income row (distinct from tips so it
 *     never inflates patron totals), which surfaces in its earnings + Money Pulse.
 * Best-effort — the ledger row is already the source of truth.
 */
async function mirrorCustody({ forkAgentId, ancestorAgentId, recipient, lamports, signature, network, kind, rerouted }) {
	const { recordCustodyEvent } = await import('./agent-trade-guards.js');
	let usd = null;
	try { const { lamportsToUsd } = await import('./agent-trade-guards.js'); usd = await lamportsToUsd(lamports); } catch { /* unpriced */ }
	const idem = `royalty:${signature}:${ancestorAgentId}`;
	await recordCustodyEvent({
		agentId: forkAgentId, eventType: 'royalty_paid', category: 'royalty', network, asset: 'SOL',
		amountLamports: lamports, usd, destination: recipient, signature, status: 'confirmed',
		idempotencyKey: idem, reason: `fork_royalty_${kind}`,
		meta: { ancestor_agent_id: ancestorAgentId, rerouted: !!rerouted },
	}).catch(() => {});
	if (!rerouted && ancestorAgentId) {
		await recordCustodyEvent({
			agentId: ancestorAgentId, eventType: 'royalty', category: 'royalty', network, asset: 'SOL',
			amountLamports: lamports, usd, destination: recipient, signature, status: 'confirmed',
			idempotencyKey: idem, reason: `fork_royalty_${kind}`,
			meta: { from_fork_agent_id: forkAgentId },
		}).catch(() => {});
	}
}

// ── Read models for the transparent split ledger (both sides) ────────────────

/**
 * The descendant view: what this agent (as a fork) shares upstream, plus every
 * royalty it has actually paid. Returns honest zeros when it carries no terms.
 */
export async function getDescendantLedger(agentId, { limit = 50 } = {}) {
	const terms = await loadForkRoyaltyTerms(agentId);
	const payouts = await sql`
		select id, ancestor_agent_id, recipient_wallet, depth, bps, amount_lamports, usd,
		       status, signature, rerouted, reason, source_kind, network, created_at, confirmed_at, meta
		from fork_royalty_payouts
		where fork_agent_id = ${agentId} and status in ('confirmed','pending','failed')
		order by created_at desc limit ${Math.min(Math.max(limit, 1), 200)}
	`;
	const [agg] = await sql`
		select coalesce(sum(amount_lamports) filter (where status='confirmed'),0)::bigint as paid_lamports,
		       coalesce(sum(usd) filter (where status='confirmed'),0) as paid_usd,
		       count(*) filter (where status='confirmed') as paid_count
		from fork_royalty_payouts where fork_agent_id = ${agentId}
	`;
	return {
		shares_upstream: !!terms,
		total_bps: terms?.total_bps || 0,
		keep_bps: terms ? 10000 - terms.total_bps : 10000,
		schedule: terms?.entries || [],
		paid_lamports: String(agg?.paid_lamports || 0n),
		paid_usd: Number(agg?.paid_usd || 0),
		paid_count: Number(agg?.paid_count || 0),
		payouts: payouts.map(serializePayout),
	};
}

/**
 * The ancestor view: royalty income this agent has earned from descendants'
 * forks, grouped by descendant, plus the live config (rate + eligible sources)
 * and how many forks have opted into its terms.
 */
export async function getAncestorLedger(agentId, { limit = 50 } = {}) {
	const incoming = await sql`
		select id, fork_agent_id, recipient_wallet, depth, bps, amount_lamports, usd,
		       status, signature, source_kind, network, created_at, confirmed_at, meta
		from fork_royalty_payouts
		where ancestor_agent_id = ${agentId} and status in ('confirmed','pending')
		order by created_at desc limit ${Math.min(Math.max(limit, 1), 200)}
	`;
	const [agg] = await sql`
		select coalesce(sum(amount_lamports) filter (where status='confirmed'),0)::bigint as earned_lamports,
		       coalesce(sum(usd) filter (where status='confirmed'),0) as earned_usd,
		       count(distinct fork_agent_id) filter (where status='confirmed') as paying_forks
		from fork_royalty_payouts where ancestor_agent_id = ${agentId}
	`;
	// How many forks have this agent in their consent snapshot at all.
	const [forks] = await sql`
		select count(*)::int as n from fork_royalty_terms
		where schedule @> ${JSON.stringify([{ ancestor_agent_id: agentId }])}::jsonb
	`;
	return {
		earns_royalties: Number(forks?.n || 0) > 0,
		fork_count: Number(forks?.n || 0),
		earned_lamports: String(agg?.earned_lamports || 0n),
		earned_usd: Number(agg?.earned_usd || 0),
		paying_forks: Number(agg?.paying_forks || 0),
		income: incoming.map(serializePayout),
	};
}

function serializePayout(r) {
	return {
		id: r.id,
		fork_agent_id: r.fork_agent_id ?? null,
		ancestor_agent_id: r.ancestor_agent_id ?? null,
		recipient_wallet: r.recipient_wallet ?? null,
		depth: Number(r.depth),
		bps: Number(r.bps),
		amount_lamports: r.amount_lamports != null ? String(r.amount_lamports) : '0',
		amount_sol: r.amount_lamports != null ? Number(r.amount_lamports) / 1e9 : 0,
		usd: r.usd != null ? Number(r.usd) : null,
		status: r.status,
		signature: r.signature ?? null,
		rerouted: !!r.rerouted,
		reason: r.reason ?? null,
		source_kind: r.source_kind,
		network: r.network,
		created_at: r.created_at ? new Date(r.created_at).toISOString() : null,
		confirmed_at: r.confirmed_at ? new Date(r.confirmed_at).toISOString() : null,
		meta: r.meta || {},
	};
}
