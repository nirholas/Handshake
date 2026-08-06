// Signal marketplace engine — the truth layer for reputation-gated, x402-metered
// copy-trading. Two halves, mirroring api/_lib/trader-stats.js's design so the
// numbers can never disagree with the leaderboard:
//
//   PURE (no DB, no network): outcome classification, conviction + sizing math,
//   and the confidence-regressed feed-edge score the marketplace ranks on. These
//   are what the tests pin to fixtures.
//
//   DB layer: generate emissions from the publisher's REAL agent_sniper_positions
//   (entry on open, exit on close, realized outcome backfilled), deliver each
//   paid emission to a subscriber (x402 USDC payment + guarded auto-mirror), and
//   roll up per-feed accountability stats for the directory.
//
// Honesty rules baked in (same spirit as trader-stats):
//   - Every emission binds to a real on-chain fill (buy_sig / sell_sig). Sellers
//     cannot hand-author signals; the source is the same position ledger the
//     verification badge is computed from.
//   - A feed's rank is its PROVEN realized edge, regressed toward neutral (and the
//     publisher's own track-record score) until enough signals have closed — a
//     thin feed with one lucky call can never top a deep, consistent one.
//   - Realized outcomes count losers; nothing is hidden.

import { sql } from './db.js';
import { PublicKey } from '@solana/web3.js';
import { fetchTraderPositions, computeTraderMetrics } from './trader-stats.js';
import { runFollowerTrade, loadFollower } from './agent-mirror.js';
import { transferUsdcGuarded } from './agent-usdc-transfer.js';
import { solanaConnection } from './agent-pumpfun.js';
import { WSOL_MINT } from './pump-trade-args.js';

// The PURE half lives in signal-engine-core.js (no DB / network / SDK imports) so
// it can be tested in isolation. Re-export it here so every production caller and
// the DB layer below keep importing from one place.
import {
	lamToSol, clamp, median,
	classifyOutcome, computeSizeMultiple, computeConviction, subscriberOrderSol,
	feedEdgeScore, rankFeeds, FEED_SORTS,
} from './signal-engine-core.js';

export {
	classifyOutcome, computeSizeMultiple, computeConviction, subscriberOrderSol,
	feedEdgeScore, rankFeeds, FEED_SORTS,
};

const DEFAULT_MIRROR_SLIPPAGE_BPS = 300;

// ── DB: publisher reference + verification ─────────────────────────────────────

/** The publisher's typical entry size (median, SOL) — the conviction reference. */
async function referenceEntrySol(publisherAgentId, network) {
	const rows = await sql`
		select entry_quote_lamports from agent_sniper_positions
		where agent_id = ${publisherAgentId} and network = ${network}
		  and entry_quote_lamports is not null
		order by coalesce(closed_at, opened_at) desc limit 200
	`.catch(() => []);
	const entries = rows.map((r) => lamToSol(r.entry_quote_lamports)).filter((v) => v > 0);
	return median(entries);
}

/**
 * The publisher's live trader metrics (verified badge + composite score), from the
 * SAME pure computeTraderMetrics the leaderboard + profile use. USD is irrelevant
 * to verification/score, so we price at null (SOL stays exact, no feed dependency).
 */
export async function publisherMetrics(publisherAgentId, network) {
	const positions = await fetchTraderPositions({ agentId: publisherAgentId, network, window: 'all' }).catch(() => []);
	return computeTraderMetrics(positions, { solUsd: null });
}

// ── DB: emission generation from real position lifecycle ───────────────────────

/**
 * Generate this feed's emissions from the publisher's REAL positions since the
 * feed's cursors: an `entry` when a position opens, an `exit` (+ outcome backfill
 * onto the entry) when it closes. Idempotent via the (feed, position, side) unique
 * index — a re-run never double-emits. Returns a small summary. Never throws.
 */
export async function syncFeedEmissions(feed) {
	const network = feed.network === 'devnet' ? 'devnet' : 'mainnet';
	const out = { entries: 0, exits: 0, closed: 0 };

	const refEntrySol = await referenceEntrySol(feed.publisher_agent_id, network);

	// --- ENTRIES: positions opened since the entry cursor. ---
	if (feed.emit_entries) {
		const opened = await sql`
			select id, mint, symbol, name, entry_quote_lamports, entry_price_lamports_per_token, buy_sig, opened_at
			from agent_sniper_positions
			where agent_id = ${feed.publisher_agent_id} and network = ${network}
			  and opened_at > ${feed.entry_cursor}
			  and entry_quote_lamports is not null
			order by opened_at asc limit 100
		`.catch(() => []);
		let maxOpened = null;
		for (const p of opened) {
			const entrySol = lamToSol(p.entry_quote_lamports);
			const sizeMultiple = computeSizeMultiple(entrySol, refEntrySol);
			const conviction = computeConviction(sizeMultiple);
			maxOpened = p.opened_at;
			if (conviction < Number(feed.min_conviction || 0)) continue; // below the feed's floor
			const ins = await sql`
				insert into signal_emissions
					(feed_id, publisher_agent_id, network, source_position_id, mint, symbol, name,
					 side, size_multiple, conviction, entry_sol, ref_price_lpt, status, source_buy_sig, emitted_at)
				values (${feed.id}, ${feed.publisher_agent_id}, ${network}, ${p.id}, ${p.mint}, ${p.symbol}, ${p.name},
					'entry', ${feed.reveal_sizing ? sizeMultiple : null}, ${conviction},
					${feed.reveal_sizing ? Number(entrySol.toFixed(6)) : null}, ${p.entry_price_lamports_per_token ?? null},
					'open', ${p.buy_sig ?? null}, ${p.opened_at})
				on conflict (feed_id, source_position_id, side) do nothing
				returning id
			`.catch(() => []);
			if (ins.length) out.entries += 1;
		}
		if (maxOpened) {
			await sql`update signal_feeds set entry_cursor = ${maxOpened}, updated_at = now() where id = ${feed.id}`.catch(() => {});
		}
	}

	// --- EXITS + outcome backfill: positions closed since the exit cursor. ---
	const closed = await sql`
		select id, mint, symbol, name, realized_pnl_lamports, realized_pnl_pct, sell_sig, closed_at
		from agent_sniper_positions
		where agent_id = ${feed.publisher_agent_id} and network = ${network}
		  and status = 'closed' and closed_at is not null and closed_at > ${feed.exit_cursor}
		order by closed_at asc limit 100
	`.catch(() => []);
	let maxClosed = null;
	for (const p of closed) {
		maxClosed = p.closed_at;
		const realizedPct = p.realized_pnl_pct != null ? Number(p.realized_pnl_pct) : null;
		const realizedSol = lamToSol(p.realized_pnl_lamports);
		const outcome = classifyOutcome(realizedPct);

		// Backfill the entry signal's realized outcome (proof of edge).
		const updated = await sql`
			update signal_emissions set
				status = 'closed', realized_pnl_pct = ${realizedPct}, realized_pnl_sol = ${Number(realizedSol.toFixed(6))},
				outcome = ${outcome}, source_sell_sig = ${p.sell_sig ?? null}, closed_at = ${p.closed_at}
			where feed_id = ${feed.id} and source_position_id = ${p.id} and side = 'entry' and status = 'open'
			returning id
		`.catch(() => []);
		if (updated.length) {
			out.closed += 1;
			// Propagate the proven outcome to every delivery of that entry (follower-ROI rollup).
			await sql`update signal_deliveries set signal_realized_pct = ${realizedPct}, updated_at = now() where emission_id = ${updated[0].id}`.catch(() => {});
		}

		// Emit a distinct exit signal only when the feed publishes exits AND we
		// actually emitted the matching entry (never an exit for an unentered coin).
		if (feed.emit_exits && updated.length) {
			const ins = await sql`
				insert into signal_emissions
					(feed_id, publisher_agent_id, network, source_position_id, mint, symbol, name,
					 side, conviction, status, realized_pnl_pct, realized_pnl_sol, outcome, source_sell_sig, emitted_at, closed_at)
				values (${feed.id}, ${feed.publisher_agent_id}, ${network}, ${p.id}, ${p.mint}, ${p.symbol}, ${p.name},
					'exit', 1, 'closed', ${realizedPct}, ${Number(realizedSol.toFixed(6))}, ${outcome},
					${p.sell_sig ?? null}, ${p.closed_at}, ${p.closed_at})
				on conflict (feed_id, source_position_id, side) do nothing
				returning id
			`.catch(() => []);
			if (ins.length) out.exits += 1;
		}
	}
	if (maxClosed) {
		await sql`update signal_feeds set exit_cursor = ${maxClosed}, updated_at = now() where id = ${feed.id}`.catch(() => {});
	}
	return out;
}

// ── DB: paid delivery + auto-mirror to a subscriber ────────────────────────────

/** The subscriber's full token balance for a mint (sizes the mirrored exit). */
async function readTokenBalanceRaw(conn, ownerPk, mintPk) {
	try {
		const res = await conn.getParsedTokenAccountsByOwner(ownerPk, { mint: mintPk });
		let raw = 0n;
		for (const acc of res?.value || []) {
			const amt = acc.account?.data?.parsed?.info?.tokenAmount?.amount;
			if (amt) raw += BigInt(amt);
		}
		return raw;
	} catch { return 0n; }
}

/** Resolve the USDC price the subscriber owes for one emission under its billing. */
function priceForDelivery({ feed, subscription, emission, now }) {
	if (subscription.mode === 'simulate') return { usdc: 0, charge: false };
	if (subscription.billing === 'per_epoch') {
		const paidUntil = subscription.epoch_paid_until ? new Date(subscription.epoch_paid_until).getTime() : 0;
		if (now <= paidUntil) return { usdc: 0, charge: false };           // inside a paid epoch
		const usdc = Number(feed.price_per_epoch_usdc) || 0;
		return usdc > 0 ? { usdc, charge: true, epoch: true } : { usdc: 0, charge: false };
	}
	// per_signal — only entries are billable; exits ride free once the entry is paid.
	if (emission.side !== 'entry') return { usdc: 0, charge: false };
	const usdc = Number(feed.price_per_signal_usdc) || 0;
	return usdc > 0 ? { usdc, charge: true } : { usdc: 0, charge: false };
}

/**
 * Deliver one emission to one subscription: claim the idempotent delivery row,
 * settle the x402 payment (live only), then auto-mirror through the shared guarded
 * trade path. Returns the delivery summary. Never throws past the boundary.
 */
export async function deliverOne({ subscription, feed, emission, follower, now = Date.now() }) {
	const network = subscription.network === 'devnet' ? 'devnet' : 'mainnet';

	// Idempotency: one delivery per (subscription, emission). A retry no-ops.
	const [claimed] = await sql`
		insert into signal_deliveries
			(subscription_id, emission_id, feed_id, subscriber_agent_id, publisher_agent_id, network, mode, side, mirror_status)
		values (${subscription.id}, ${emission.id}, ${feed.id}, ${subscription.subscriber_agent_id},
			${feed.publisher_agent_id}, ${network}, ${subscription.mode}, ${emission.side}, 'pending')
		on conflict (subscription_id, emission_id) do nothing
		returning id
	`.catch(() => []);
	if (!claimed) return { status: 'duplicate' };
	const deliveryId = Number(claimed.id);

	const finalize = async (patch) => {
		await sql`
			update signal_deliveries set
				payment_status = ${patch.payment_status ?? 'none'},
				payment_custody_event_id = ${patch.payment_custody_event_id ?? null},
				payment_signature = ${patch.payment_signature ?? null},
				payment_usdc = ${patch.payment_usdc ?? null},
				mirror_status = ${patch.mirror_status ?? 'skipped'},
				mirror_skip_reason = ${patch.mirror_skip_reason ?? null},
				mirror_custody_event_id = ${patch.mirror_custody_event_id ?? null},
				mirror_signature = ${patch.mirror_signature ?? null},
				order_sol = ${patch.order_sol ?? null},
				price_impact_pct = ${patch.price_impact_pct ?? null},
				emit_to_fill_ms = ${patch.emit_to_fill_ms ?? null},
				signal_realized_pct = ${emission.realized_pnl_pct ?? null},
				updated_at = now()
			where id = ${deliveryId}
		`.catch(() => {});
		return { deliveryId, ...patch };
	};

	const emittedAt = new Date(emission.emitted_at).getTime();
	const latencyMs = Math.max(0, now - emittedAt);

	// Exits the subscriber opted out of — record and move on.
	if (emission.side === 'exit' && !subscription.copy_exits) {
		return finalize({ mirror_status: 'skipped', mirror_skip_reason: 'exits_disabled', emit_to_fill_ms: latencyMs });
	}

	// 1. Payment leg (x402 USDC, live only).
	const price = priceForDelivery({ feed, subscription, emission, now });
	let payment = { payment_status: 'none', payment_usdc: null, payment_custody_event_id: null, payment_signature: null };
	if (price.charge) {
		const idem = `signal:${subscription.id}:${price.epoch ? `epoch:${Math.floor(now / 1000)}` : `emit:${emission.id}`}`;
		const pay = await transferUsdcGuarded({
			fromAgentId: subscription.subscriber_agent_id, fromUserId: subscription.owner_user_id,
			fromMeta: follower.meta, toAddress: feed.payout_address, usdc: price.usdc,
			network, category: 'signal', idempotencyKey: idem,
			rowMeta: { feed_id: feed.id, emission_id: emission.id, billing: subscription.billing, publisher_agent_id: feed.publisher_agent_id },
		});
		if (pay.status === 'paid' || pay.status === 'replayed') {
			payment = { payment_status: 'paid', payment_usdc: price.usdc, payment_custody_event_id: pay.custodyEventId ?? null, payment_signature: pay.signature ?? null };
			if (price.epoch) {
				const until = new Date(now + Number(feed.epoch_seconds || 86400) * 1000).toISOString();
				await sql`update signal_subscriptions set epoch_paid_until = ${until}, updated_at = now() where id = ${subscription.id}`.catch(() => {});
			}
		} else {
			// Payment blocked (cap/frozen) or failed — never trade unpaid alpha.
			return finalize({
				payment_status: 'failed', payment_usdc: price.usdc, mirror_status: 'skipped',
				mirror_skip_reason: `unpaid_${pay.code || pay.status}`, emit_to_fill_ms: latencyMs,
			});
		}
	}

	// 2. Mirror leg.
	// Simulate mode: size the order, label it, spend nothing.
	if (subscription.mode === 'simulate') {
		let orderSol = null;
		if (emission.side === 'entry') {
			orderSol = subscriberOrderSol({
				baseSol: subscription.base_sol, sizeMultiple: emission.size_multiple ?? 1,
				sizeScaling: subscription.size_scaling, maxPerTradeSol: subscription.max_per_trade_sol,
			});
		}
		return finalize({ ...payment, mirror_status: 'simulated', order_sol: orderSol, emit_to_fill_ms: latencyMs });
	}

	if (emission.mint === WSOL_MINT) {
		return finalize({ ...payment, mirror_status: 'skipped', mirror_skip_reason: 'wsol', emit_to_fill_ms: latencyMs });
	}

	const slippageBps = clamp(Number(subscription.slippage_bps) || DEFAULT_MIRROR_SLIPPAGE_BPS, 0, 5000);
	const leaderRef = {
		leader_agent_id: feed.publisher_agent_id, leader_name: feed.publisher_name || null,
		feed_id: feed.id, emission_id: emission.id, source: 'signal',
	};

	if (emission.side === 'entry') {
		const orderSol = subscriberOrderSol({
			baseSol: subscription.base_sol, sizeMultiple: emission.size_multiple ?? 1,
			sizeScaling: subscription.size_scaling, maxPerTradeSol: subscription.max_per_trade_sol,
		});
		if (!orderSol) return finalize({ ...payment, mirror_status: 'skipped', mirror_skip_reason: 'dust_order', order_sol: 0, emit_to_fill_ms: latencyMs });
		const result = await runFollowerTrade({
			follower, side: 'buy', mint: emission.mint, network,
			solAmount: orderSol, tokenAmountRaw: null, slippageBps,
			idempotencyKey: `signal:${subscription.id}:${emission.id}:buy`, leaderRef,
			firewallLevel: subscription.firewall_level === 'warn' ? 'warn' : 'block',
		});
		return finalize({
			...payment,
			mirror_status: mirrorStatusOf(result),
			mirror_skip_reason: result.status === 'executed' ? null : (result.code || null),
			mirror_custody_event_id: result.custodyEventId ?? null,
			mirror_signature: result.signature ?? null,
			order_sol: orderSol, price_impact_pct: result.priceImpact ?? null, emit_to_fill_ms: latencyMs,
		});
	}

	// EXIT — sell the subscriber's full holding of the mint.
	let ownerPk;
	try { ownerPk = new PublicKey(follower.address); } catch { return finalize({ ...payment, mirror_status: 'skipped', mirror_skip_reason: 'wallet_preparing', emit_to_fill_ms: latencyMs }); }
	const conn = solanaConnection(network);
	const raw = await readTokenBalanceRaw(conn, ownerPk, new PublicKey(emission.mint));
	if (raw <= 0n) return finalize({ ...payment, mirror_status: 'skipped', mirror_skip_reason: 'no_holding', emit_to_fill_ms: latencyMs });
	const result = await runFollowerTrade({
		follower, side: 'sell', mint: emission.mint, network,
		solAmount: null, tokenAmountRaw: raw.toString(), slippageBps,
		idempotencyKey: `signal:${subscription.id}:${emission.id}:sell`, leaderRef,
	});
	return finalize({
		...payment,
		mirror_status: mirrorStatusOf(result),
		mirror_skip_reason: result.status === 'executed' ? null : (result.code || null),
		mirror_custody_event_id: result.custodyEventId ?? null,
		mirror_signature: result.signature ?? null,
		price_impact_pct: result.priceImpact ?? null, emit_to_fill_ms: latencyMs,
	});
}

function mirrorStatusOf(result) {
	if (result.status === 'executed') return 'executed';
	if (result.status === 'unconfirmed') return 'unconfirmed';
	if (result.status === 'skipped') return 'skipped';
	return 'failed';
}

/**
 * Deliver every undelivered emission for one active subscription, advancing the
 * subscription cursor. Used by the cron fanout and the owner's "Sync now". Halts
 * instantly on kill / non-active status. Never throws.
 */
export async function deliverSubscription(subscription, { maxEvents = 20 } = {}) {
	if (subscription.killed || subscription.status !== 'active') return { delivered: 0, results: [] };

	const [feed] = await sql`
		select f.*, a.name as publisher_name
		from signal_feeds f join agent_identities a on a.id = f.publisher_agent_id
		where f.id = ${subscription.feed_id} limit 1
	`.catch(() => []);
	if (!feed || feed.status !== 'active') return { delivered: 0, results: [] };

	const network = subscription.network === 'devnet' ? 'devnet' : 'mainnet';
	const emissions = await sql`
		select id, side, mint, symbol, name, size_multiple, conviction, realized_pnl_pct, emitted_at
		from signal_emissions
		where feed_id = ${feed.id} and network = ${network} and id > ${subscription.last_emission_id}
		order by id asc limit ${maxEvents}
	`.catch(() => []);
	if (!emissions.length) return { delivered: 0, results: [] };

	const follower = await loadFollower(subscription.subscriber_agent_id);
	if (!follower) return { delivered: 0, results: [] };

	const results = [];
	let cursor = Number(subscription.last_emission_id || 0);
	// Re-read the subscription's epoch state between deliveries (a payment may extend it).
	let sub = { ...subscription };
	for (const em of emissions) {
		try {
			const r = await deliverOne({ subscription: sub, feed, emission: em, follower });
			results.push({ emissionId: em.id, side: em.side, ...r });
		} catch (e) {
			results.push({ emissionId: em.id, side: em.side, status: 'failed', error: (e?.message || 'error').slice(0, 120) });
		}
		cursor = Math.max(cursor, Number(em.id));
		// Refresh epoch_paid_until so subsequent same-epoch deliveries don't re-charge.
		if (sub.billing === 'per_epoch') {
			const [row] = await sql`select epoch_paid_until from signal_subscriptions where id = ${sub.id}`.catch(() => []);
			if (row) sub = { ...sub, epoch_paid_until: row.epoch_paid_until };
		}
	}
	if (cursor > Number(subscription.last_emission_id || 0)) {
		await sql`update signal_subscriptions set last_emission_id = ${cursor}, updated_at = now() where id = ${subscription.id}`.catch(() => {});
	}
	return { delivered: results.length, results };
}

// ── DB: marketplace directory + feed detail (read) ─────────────────────────────

/** Per-feed accountability rollup keyed by feed id. */
async function feedRollups(feedIds) {
	if (!feedIds.length) return new Map();
	const rows = await sql`
		select e.feed_id,
			count(*) filter (where e.side = 'entry') as total_entries,
			count(*) filter (where e.side = 'entry' and e.status = 'closed') as closed_signals,
			count(*) filter (where e.side = 'entry' and e.outcome = 'win') as winning_signals,
			avg(e.realized_pnl_pct) filter (where e.side = 'entry' and e.status = 'closed') as avg_realized_pct,
			max(e.emitted_at) as last_emitted_at
		from signal_emissions e
		where e.feed_id = any(${feedIds})
		group by e.feed_id
	`.catch(() => []);
	const m = new Map();
	for (const r of rows) m.set(Number(r.feed_id), r);
	return m;
}

/** Active-subscriber count keyed by feed id. */
async function feedSubscriberCounts(feedIds) {
	if (!feedIds.length) return new Map();
	const rows = await sql`
		select feed_id, count(*)::int as subscribers from signal_subscriptions
		where feed_id = any(${feedIds}) and status = 'active' and killed = false
		group by feed_id
	`.catch(() => []);
	return new Map(rows.map((r) => [Number(r.feed_id), Number(r.subscribers) || 0]));
}

/** Latency + follower-ROI rollup from real deliveries, keyed by feed id. */
async function feedDeliveryRollups(feedIds) {
	if (!feedIds.length) return new Map();
	const rows = await sql`
		select feed_id,
			count(*) filter (where mirror_status = 'executed') as executed_fills,
			avg(emit_to_fill_ms) filter (where emit_to_fill_ms is not null) as avg_latency_ms,
			avg(signal_realized_pct) filter (where signal_realized_pct is not null and side = 'entry') as avg_follower_roi
		from signal_deliveries where feed_id = any(${feedIds})
		group by feed_id
	`.catch(() => []);
	const m = new Map();
	for (const r of rows) m.set(Number(r.feed_id), r);
	return m;
}

/** Shape + score one feed row against its rollups + the publisher's track record. */
function shapeFeed(feed, rollup, subscribers, deliveryRollup, metrics) {
	const closedSignals = Number(rollup?.closed_signals) || 0;
	const winningSignals = Number(rollup?.winning_signals) || 0;
	const avgRealizedPct = rollup?.avg_realized_pct != null ? Number(Number(rollup.avg_realized_pct).toFixed(2)) : null;
	const hitRate = closedSignals > 0 ? Number((winningSignals / closedSignals).toFixed(4)) : null;
	const publisherScore = metrics?.score ?? 50;
	return {
		id: Number(feed.id),
		slug: feed.slug,
		title: feed.title,
		description: feed.description || null,
		network: feed.network,
		visibility: feed.visibility,
		status: feed.status,
		publisher: {
			agent_id: feed.publisher_agent_id,
			name: feed.publisher_name || feed.publisher_agent_id,
			image: feed.publisher_image || feed.publisher_avatar || null,
			verified: !!metrics?.verified,
			score: publisherScore,
			closed_trades: metrics?.closed_count ?? null,
			realized_pnl_sol: metrics?.realized_pnl_sol ?? null,
			win_rate: metrics?.win_rate ?? null,
		},
		pricing: {
			per_signal_usdc: Number(feed.price_per_signal_usdc) || 0,
			per_epoch_usdc: Number(feed.price_per_epoch_usdc) || 0,
			epoch_seconds: Number(feed.epoch_seconds) || 86400,
		},
		emit: { entries: feed.emit_entries, exits: feed.emit_exits, sizing: feed.reveal_sizing, min_conviction: Number(feed.min_conviction) || 0 },
		stats: {
			total_entries: Number(rollup?.total_entries) || 0,
			closed_signals: closedSignals,
			winning_signals: winningSignals,
			hit_rate: hitRate,
			avg_realized_pct: avgRealizedPct,
			subscribers,
			executed_fills: Number(deliveryRollup?.executed_fills) || 0,
			avg_latency_ms: deliveryRollup?.avg_latency_ms != null ? Math.round(Number(deliveryRollup.avg_latency_ms)) : null,
			avg_follower_roi_pct: deliveryRollup?.avg_follower_roi != null ? Number(Number(deliveryRollup.avg_follower_roi).toFixed(2)) : null,
			last_emitted_at: rollup?.last_emitted_at || null,
		},
		edge_score: feedEdgeScore({ closedSignals, winningSignals, avgRealizedPct: avgRealizedPct || 0, publisherScore }),
		closed_signals: closedSignals,
		avg_realized_pct: avgRealizedPct,
		hit_rate: hitRate,
		subscribers,
		created_at: feed.created_at,
	};
}

/**
 * The public marketplace directory: every active, public feed scored by proven
 * realized edge (confidence-regressed) and ranked. Thin feeds can't top the board.
 */
export async function getMarketplace({ network = 'mainnet', limit = 60, sort = 'edge' } = {}) {
	const net = network === 'devnet' ? 'devnet' : 'mainnet';
	const feeds = await sql`
		select f.*, a.name as publisher_name, a.avatar_url as publisher_avatar, a.profile_image_url as publisher_image
		from signal_feeds f join agent_identities a on a.id = f.publisher_agent_id
		where f.network = ${net} and f.status = 'active' and f.visibility = 'public' and a.is_public is not false
		order by f.created_at desc limit 200
	`.catch(() => []);
	if (!feeds.length) return { network: net, sort, feeds: [], t: Date.now() };

	const feedIds = feeds.map((f) => Number(f.id));
	const [rollups, subCounts, deliveryRollups] = await Promise.all([
		feedRollups(feedIds), feedSubscriberCounts(feedIds), feedDeliveryRollups(feedIds),
	]);
	// Publisher metrics in parallel (curated, small set).
	const metricsList = await Promise.all(feeds.map((f) => publisherMetrics(f.publisher_agent_id, net).catch(() => null)));

	const shaped = feeds.map((f, i) => shapeFeed(
		f, rollups.get(Number(f.id)), subCounts.get(Number(f.id)) || 0, deliveryRollups.get(Number(f.id)), metricsList[i],
	));
	const ranked = rankFeeds(shaped, FEED_SORTS.has(sort) ? sort : 'edge').slice(0, limit);
	return { network: net, sort: FEED_SORTS.has(sort) ? sort : 'edge', feeds: ranked, t: Date.now() };
}

// Is this viewer entitled to a paid feed's live alpha? The publisher-owner and
// any active, non-killed subscriber are; everyone else sees the track record with
// the still-actionable parts withheld. Same rule the SSE stream enforces, so the
// two surfaces can never disagree about who has paid.
async function viewerEntitled(feed, viewerUserId) {
	if (!viewerUserId) return false;
	if (feed.owner_user_id === viewerUserId) return true;
	const [sub] = await sql`
		select 1 from signal_subscriptions
		where feed_id = ${feed.id} and owner_user_id = ${viewerUserId}
		  and status = 'active' and killed = false
		limit 1
	`.catch(() => []);
	return !!sub;
}

// An open position is the product a subscriber pays for: naming its mint (and
// linking the entry tx, which names it too) IS the signal. A closed one is track
// record whose alpha is spent, so it stays fully visible and on-chain verifiable:
// that is the sales surface, and hiding it would make the feed's own claims
// unauditable. Free feeds redact nothing.
function redactOpenEmission(e) {
	return {
		...e,
		mint: null,
		symbol: null,
		name: null,
		entry_sol: null,
		buy_url: null,
		sell_url: null,
		locked: true,
	};
}

/**
 * A single feed's detail: full stats + recent emissions (with realized outcomes).
 *
 * `viewerUserId` decides how much of a PAID feed's OPEN positions come back
 * (security review L7). Omit it and the caller is treated as anonymous, which is
 * the safe default for a public page.
 */
export async function getFeedDetail({ slug, network = 'mainnet', emissionLimit = 40, viewerUserId = null }) {
	const net = network === 'devnet' ? 'devnet' : 'mainnet';
	const [feed] = await sql`
		select f.*, a.name as publisher_name, a.avatar_url as publisher_avatar, a.profile_image_url as publisher_image, a.is_public
		from signal_feeds f join agent_identities a on a.id = f.publisher_agent_id
		where f.slug = ${slug} limit 1
	`.catch(() => []);
	if (!feed || feed.is_public === false) return null;

	const feedIds = [Number(feed.id)];
	const [rollups, subCounts, deliveryRollups, metrics, emissions] = await Promise.all([
		feedRollups(feedIds), feedSubscriberCounts(feedIds), feedDeliveryRollups(feedIds),
		publisherMetrics(feed.publisher_agent_id, net).catch(() => null),
		sql`
			select id, side, mint, symbol, name, size_multiple, conviction, entry_sol, status,
			       realized_pnl_pct, realized_pnl_sol, outcome, source_buy_sig, source_sell_sig, emitted_at, closed_at
			from signal_emissions where feed_id = ${feed.id}
			order by id desc limit ${emissionLimit}
		`.catch(() => []),
	]);

	const shaped = shapeFeed(feed, rollups.get(Number(feed.id)), subCounts.get(Number(feed.id)) || 0, deliveryRollups.get(Number(feed.id)), metrics);
	const solscan = (sig) => (sig && sig !== 'SIMULATED' ? (net === 'devnet' ? `https://solscan.io/tx/${sig}?cluster=devnet` : `https://solscan.io/tx/${sig}`) : null);
	// A paid feed's open positions are withheld from anyone who has not paid.
	const paid = shaped.pricing.per_signal_usdc > 0 || shaped.pricing.per_epoch_usdc > 0;
	const entitled = paid ? await viewerEntitled(feed, viewerUserId) : true;
	const gate = (row, raw) => (entitled || raw.status !== 'open' ? row : redactOpenEmission(row));
	return {
		...shaped,
		viewer: { entitled, paywalled: paid && !entitled },
		emissions: emissions.map((e) => gate({
			id: Number(e.id),
			side: e.side,
			mint: e.mint,
			symbol: e.symbol,
			name: e.name,
			size_multiple: e.size_multiple != null ? Number(e.size_multiple) : null,
			conviction: e.conviction != null ? Number(e.conviction) : null,
			entry_sol: e.entry_sol != null ? Number(e.entry_sol) : null,
			status: e.status,
			realized_pnl_pct: e.realized_pnl_pct != null ? Number(e.realized_pnl_pct) : null,
			realized_pnl_sol: e.realized_pnl_sol != null ? Number(e.realized_pnl_sol) : null,
			outcome: e.outcome,
			buy_url: solscan(e.source_buy_sig),
			sell_url: solscan(e.source_sell_sig),
			emitted_at: e.emitted_at,
			closed_at: e.closed_at,
			locked: false,
		}, e)),
	};
}
