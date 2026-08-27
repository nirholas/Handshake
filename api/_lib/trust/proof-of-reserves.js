// Proof-of-Reserves — verifiable, on-chain-derived solvency for an agent wallet.
//
// "Trustless, not trust-us." Every figure here is either a LIVE read of real
// Solana chain state (the wallet's actual SOL + SPL holdings, independently
// checkable on Solscan) or a real, already-settled row in the custody ledger
// (each linking to its on-chain signature). Nothing is asserted; everything is
// verifiable. This is the data layer behind the transparency panel and feeds the
// `solvency` factor of the financial reputation score.
//
// Three real reads compose the picture:
//   • reserves    — live SOL + SPL balances, USD-valued, with a one-tap
//                   verify-on-chain link and an honest verified_at timestamp.
//                   When RPC is throttled we return the LAST verified snapshot
//                   marked `degraded` with its real timestamp — never a stale
//                   "verified now".
//   • lifetime    — total received (tips + streams) vs total out (withdraws +
//                   spends/trades/snipes/x402) from agent_custody_events.
//   • obligations — what it still owes: pending spends + live money-streams.

import { PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { sql } from '../db.js';
import { solanaConnection } from '../agent-pumpfun.js';
import { readBalanceOrNull, rpcUnavailableError } from '../solana/read-guards.js';
import { solanaMintUsdPrice } from '../balances.js';
import { solUsdPrice, explorerTxUrl, explorerAccountUrl } from '../avatar-wallet.js';
import { cacheGet, cacheSet } from '../cache.js';

const USDC_MINT_BY_CLUSTER = {
	mainnet: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
	devnet: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
};
const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

const FRESH_TTL_S = 60; // matches the wallet balance cache window
const SNAPSHOT_TTL_S = 3600; // keep last-good snapshot for the degraded fallback
const STREAM_LIVE_WINDOW_S = 150; // a stream that settled inside this window is "live"
const MAX_PRICED_TOKENS = 24; // price at most this many distinct SPL holdings

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Live, USD-valued reserves for an agent's Solana wallet, cached and RPC-resilient.
 * Returns `degraded:true` with the previous verified snapshot when the RPC read
 * fails — the timestamp is always the true moment the data was last verified.
 *
 * @param {string} address  base58 wallet address
 * @param {'mainnet'|'devnet'} network
 * @returns {Promise<object>} reserves snapshot
 */
export async function getReservesSnapshot(address, network = 'mainnet') {
	const cacheKey = `reserves:snap:v1:${address}:${network}`;
	const cached = await cacheGet(cacheKey).catch(() => null);
	if (cached?.verified_at && Date.now() - new Date(cached.verified_at).getTime() < FRESH_TTL_S * 1000) {
		return { ...cached, degraded: false };
	}

	try {
		const snap = await readReservesLive(address, network);
		await cacheSet(cacheKey, snap, SNAPSHOT_TTL_S).catch(() => {});
		return { ...snap, degraded: false };
	} catch (err) {
		// RPC throttled / unreachable — fall back to the last verified snapshot,
		// honestly labelled. Never fabricate a "verified now".
		if (cached) return { ...cached, degraded: true, last_verified_at: cached.verified_at };
		const e = new Error('could not read reserves from the network — try again');
		e.code = 'rpc_error';
		e.status = 502;
		throw e;
	}
}

async function readReservesLive(address, network) {
	const conn = solanaConnection(network);
	const owner = new PublicKey(address);

	// A reserve line the chain cannot answer for is UNVERIFIED, which is a
	// different claim from "zero" and from "the endpoint is broken". Throwing a
	// raw transport error blanked the whole proof over one unreachable RPC; a
	// typed rpc_unavailable lets the caller mark the line and retry.
	const lamports = await readBalanceOrNull(conn, owner, 'confirmed');
	if (lamports == null) {
		throw rpcUnavailableError(null, `reserves for ${address} are unverifiable right now: the chain could not be read`);
	}
	const sol = lamports / 1e9;

	const usdcMint = USDC_MINT_BY_CLUSTER[network];
	const raw = [];
	for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
		let resp;
		try {
			resp = await conn.getParsedTokenAccountsByOwner(owner, { programId });
		} catch {
			continue; // one token program failing shouldn't blank the whole list
		}
		for (const { account } of resp.value) {
			const info = account.data?.parsed?.info;
			const amt = info?.tokenAmount;
			if (!info || !amt || !(Number(amt.uiAmount) > 0)) continue;
			raw.push({
				mint: info.mint,
				ui_amount: Number(amt.uiAmount),
				amount_raw: amt.amount,
				decimals: amt.decimals,
				is_usdc: info.mint === usdcMint,
				is_three: info.mint === THREE_MINT,
			});
		}
	}
	raw.sort((a, b) => b.ui_amount - a.ui_amount);

	// Price SOL once; price the largest holdings (USDC is $1; others via Jupiter/
	// pump.fun). Cap the number priced so a whale wallet never fans out hundreds of
	// price calls — the cache amortises repeats.
	const solUsd = (await solUsdPrice().catch(() => 0)) || 0;
	const tokens = [];
	for (const t of raw.slice(0, MAX_PRICED_TOKENS)) {
		let price = 0;
		if (t.is_usdc) price = 1;
		else price = (await solanaMintUsdPrice(t.mint).catch(() => 0)) || 0;
		tokens.push({
			mint: t.mint,
			ui_amount: t.ui_amount,
			decimals: t.decimals,
			is_usdc: t.is_usdc,
			is_three: t.is_three,
			usd: price > 0 ? round2(price * t.ui_amount) : null,
		});
	}
	// Any holdings beyond the priced cap are still disclosed (count + as unpriced).
	for (const t of raw.slice(MAX_PRICED_TOKENS)) {
		tokens.push({ mint: t.mint, ui_amount: t.ui_amount, decimals: t.decimals, is_usdc: false, is_three: t.is_three, usd: null });
	}

	const solUsdValue = round2(sol * solUsd);
	const tokenUsd = tokens.reduce((s, t) => s + (t.usd || 0), 0);
	return {
		address,
		network,
		sol,
		sol_usd: solUsdValue,
		tokens,
		token_usd: round2(tokenUsd),
		total_usd: round2(solUsdValue + tokenUsd),
		verify_url: explorerAccountUrl(address, network),
		verified_at: new Date().toISOString(),
	};
}

/**
 * Lifetime flows + outstanding obligations from the custody ledger. Cheap SQL,
 * no RPC. `received` = inbound tips + money-streams; `out` = withdraws + spends
 * (trades/snipes/x402). Obligations = pending spends still in flight + the count
 * of live money-streams crediting/charging right now.
 */
export async function getLedgerSummary(agentId) {
	const [tot] = await sql`
		SELECT
			coalesce(sum(usd) FILTER (WHERE event_type IN ('tip','stream') AND status IN ('ok','confirmed')), 0)::float8 AS received_usd,
			count(*)         FILTER (WHERE event_type IN ('tip','stream') AND status IN ('ok','confirmed'))::int       AS received_count,
			coalesce(sum(usd) FILTER (WHERE event_type = 'tip'    AND status IN ('ok','confirmed')), 0)::float8 AS tip_usd,
			coalesce(sum(usd) FILTER (WHERE event_type = 'stream' AND status IN ('ok','confirmed')), 0)::float8 AS stream_usd,
			coalesce(sum(usd) FILTER (WHERE event_type IN ('withdraw','spend') AND status IN ('ok','confirmed')), 0)::float8 AS out_usd,
			count(*)         FILTER (WHERE event_type IN ('withdraw','spend') AND status IN ('ok','confirmed'))::int       AS out_count,
			coalesce(sum(usd) FILTER (WHERE event_type = 'withdraw' AND status IN ('ok','confirmed')), 0)::float8 AS withdraw_usd,
			coalesce(sum(usd) FILTER (WHERE category = 'trade' AND status IN ('ok','confirmed')), 0)::float8 AS trade_usd,
			coalesce(sum(usd) FILTER (WHERE category = 'snipe' AND status IN ('ok','confirmed')), 0)::float8 AS snipe_usd,
			coalesce(sum(usd) FILTER (WHERE category = 'x402'  AND status IN ('ok','confirmed')), 0)::float8 AS x402_usd,
			coalesce(sum(usd) FILTER (WHERE event_type IN ('withdraw','spend') AND status = 'pending'), 0)::float8 AS pending_out_usd
		FROM agent_custody_events
		WHERE agent_id = ${agentId}
	`.catch(() => [null]);

	const [liveStreams] = await sql`
		SELECT count(DISTINCT meta->>'stream_id')::int AS n
		FROM agent_custody_events
		WHERE agent_id = ${agentId} AND category = 'stream'
		  AND status IN ('ok','confirmed','pending')
		  AND created_at > now() - (interval '1 second' * ${STREAM_LIVE_WINDOW_S})
	`.catch(() => [{ n: 0 }]);

	const r = tot || {};
	const pendingOut = round2(r.pending_out_usd);
	return {
		received: {
			usd: round2(r.received_usd),
			count: r.received_count || 0,
			by_kind: { tip: round2(r.tip_usd), stream: round2(r.stream_usd) },
		},
		out: {
			usd: round2(r.out_usd),
			count: r.out_count || 0,
			by_kind: {
				withdraw: round2(r.withdraw_usd),
				trade: round2(r.trade_usd),
				snipe: round2(r.snipe_usd),
				x402: round2(r.x402_usd),
			},
		},
		obligations: {
			active_streams: liveStreams?.n || 0,
			pending_spends_usd: pendingOut,
			total_usd: pendingOut,
		},
	};
}

/**
 * A paginated window of real custody flows, each row linking to its on-chain
 * signature. Public-safe: amounts + counterparties are public on-chain facts.
 */
export async function getFlows(agentId, { limit = 25, beforeId = null } = {}) {
	const lim = Math.min(100, Math.max(1, Number(limit) || 25));
	const rows = beforeId
		? await sql`
				SELECT id, event_type, category, network, asset, amount_lamports, amount_raw, usd, destination, signature, meta, created_at
				FROM agent_custody_events
				WHERE agent_id = ${agentId} AND status IN ('ok','confirmed') AND id < ${beforeId}
				ORDER BY id DESC LIMIT ${lim}
		  `.catch(() => [])
		: await sql`
				SELECT id, event_type, category, network, asset, amount_lamports, amount_raw, usd, destination, signature, meta, created_at
				FROM agent_custody_events
				WHERE agent_id = ${agentId} AND status IN ('ok','confirmed')
				ORDER BY id DESC LIMIT ${lim}
		  `.catch(() => []);

	const items = rows.map((e) => {
		const inbound = e.event_type === 'tip' || e.event_type === 'stream';
		const counterparty = inbound ? e.meta?.from || null : e.destination || null;
		return {
			id: String(e.id),
			kind: e.category || e.event_type,
			direction: inbound ? 'in' : 'out',
			network: e.network,
			asset: e.asset,
			amount_lamports: e.amount_lamports != null ? String(e.amount_lamports) : null,
			amount_raw: e.amount_raw != null ? String(e.amount_raw) : null,
			usd: e.usd != null ? Number(e.usd) : null,
			counterparty,
			signature: e.signature || null,
			explorer: e.signature ? explorerTxUrl(e.signature, e.network) : null,
			at: e.created_at ? new Date(e.created_at).toISOString() : null,
		};
	});
	return { items, next_cursor: items.length === lim ? items[items.length - 1].id : null };
}

/**
 * Compact reserves + obligations for the reputation `solvency` factor. Reads live
 * reserves (cached) and the cheap ledger obligations. Returns reservesKnown:false
 * (never a fabricated number) if the wallet has no address or the read degrades.
 */
export async function getSolvencyInputs(agentId, { address, network = 'mainnet' } = {}) {
	if (!address) return { reserveUsd: 0, obligationsUsd: 0, reservesKnown: false };
	try {
		const [snap, ledger] = await Promise.all([getReservesSnapshot(address, network), getLedgerSummary(agentId)]);
		if (snap.degraded) return { reserveUsd: 0, obligationsUsd: 0, reservesKnown: false };
		return {
			reserveUsd: Number(snap.total_usd) || 0,
			obligationsUsd: Number(ledger.obligations.total_usd) || 0,
			reservesKnown: true,
		};
	} catch {
		return { reserveUsd: 0, obligationsUsd: 0, reservesKnown: false };
	}
}

/**
 * The full Proof-of-Reserves payload for the transparency panel / API.
 */
export async function getProofOfReserves(agentId, { network = 'mainnet', isOwner = false, flowsLimit = 25, beforeId = null } = {}) {
	const [agent] = await sql`
		SELECT id, name, user_id, meta->>'solana_address' AS solana_address
		FROM agent_identities WHERE id = ${agentId} AND deleted_at IS NULL LIMIT 1
	`;
	if (!agent) {
		const e = new Error('agent not found');
		e.code = 'not_found';
		e.status = 404;
		throw e;
	}

	const address = agent.solana_address || null;
	const [reservesRes, ledger, flows] = await Promise.all([
		address ? getReservesSnapshot(address, network).catch((err) => ({ error: err.code || 'rpc_error' })) : Promise.resolve(null),
		getLedgerSummary(agentId),
		getFlows(agentId, { limit: flowsLimit, beforeId }),
	]);

	const reserves = reservesRes && !reservesRes.error ? reservesRes : null;
	const reserveUsd = reserves ? Number(reserves.total_usd) || 0 : 0;
	const obligationsUsd = Number(ledger.obligations.total_usd) || 0;
	const ratio = obligationsUsd > 0 ? round2(reserveUsd / obligationsUsd) : null;
	const solvencyStatus = !reserves
		? 'unknown'
		: obligationsUsd <= 0
		? 'no_obligations'
		: reserveUsd >= obligationsUsd
		? 'solvent'
		: 'under_reserved';

	return {
		agent_id: agent.id,
		name: agent.name,
		network,
		address,
		is_owner: isOwner,
		reserves: reserves
			? {
					sol: reserves.sol,
					sol_usd: reserves.sol_usd,
					tokens: reserves.tokens,
					token_usd: reserves.token_usd,
					total_usd: reserves.total_usd,
					verify_url: reserves.verify_url,
					verified_at: reserves.verified_at,
					degraded: Boolean(reserves.degraded),
					last_verified_at: reserves.last_verified_at || null,
			  }
			: address
			? { error: reservesRes?.error || 'rpc_error', verify_url: explorerAccountUrl(address, network) }
			: null,
		lifetime: { received: ledger.received, out: ledger.out },
		obligations: ledger.obligations,
		solvency: { reserve_usd: reserveUsd, obligations_usd: obligationsUsd, ratio, status: solvencyStatus },
		flows: flows.items,
		next_cursor: flows.next_cursor,
		computed_at: new Date().toISOString(),
	};
}
