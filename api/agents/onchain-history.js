// GET /api/agents/onchain-history
//
// One agent's on-chain lifecycle, read from the platform's own cross-chain index
// (agent_onchain_events). Public, read-only, cacheable.
//
// Solana:  ?asset=<agent account pubkey>
// EVM:     ?chain=<chainId>&id=<agentId>
// Either:  ?ref=<agent_ref>          ('<chainId>:<agentId>' or a Solana pubkey)
//
// Optional: &class=registration|metadata|transfer|token_launch|reputation|validation|delegation
//           &limit=1..500 (default 100)
//
// Every entry carries the ABSOLUTE on-chain timestamp the event happened at
// (occurredAt) alongside when the indexer saw it (indexedAt), plus an explorer
// link, so a caller can verify any row against the chain itself. `indexLag`
// reports how far behind that agent's crawl cursor is, so a caller can tell
// "nothing happened" apart from "we have not looked recently".

import { cors, json, error, method, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { sql } from '../_lib/db.js';
import { EVENT_CLASSES, readAgentEvents } from '../_lib/onchain-events.js';
import { CHAIN_BY_ID } from '../_lib/erc8004-chains.js';

const CLASS_SET = new Set(EVENT_CLASSES);
// Base58 with no 0/O/I/l, 32..44 chars: a Solana account key and nothing else.
const SOLANA_REF = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_REF = /^\d+:\d+$/;

/**
 * Resolve the query into the index's agent_ref, or an error string.
 * Pure so the ref grammar is testable without a request.
 * @param {URLSearchParams} q
 * @returns {{ ref: string, chain: 'solana'|'evm', chainId: number } | { err: string }}
 */
export function resolveRef(q) {
	const explicit = (q.get('ref') || '').trim();
	if (explicit) {
		if (EVM_REF.test(explicit)) {
			const [chainId] = explicit.split(':');
			return { ref: explicit, chain: 'evm', chainId: Number(chainId) };
		}
		if (SOLANA_REF.test(explicit)) return { ref: explicit, chain: 'solana', chainId: 0 };
		return { err: 'ref must be "<chainId>:<agentId>" or a Solana account pubkey' };
	}

	const asset = (q.get('asset') || '').trim();
	if (asset) {
		if (!SOLANA_REF.test(asset)) return { err: 'asset must be a base58 Solana account pubkey' };
		return { ref: asset, chain: 'solana', chainId: 0 };
	}

	const chainId = Number.parseInt(q.get('chain') || '', 10);
	const agentId = (q.get('id') || '').trim();
	if (Number.isInteger(chainId) && /^\d+$/.test(agentId)) {
		return { ref: `${chainId}:${agentId}`, chain: 'evm', chainId };
	}

	return { err: 'provide ?asset=<solana pubkey>, ?chain=<chainId>&id=<agentId>, or ?ref=' };
}

/**
 * Explorer link for one indexed event.
 * @param {{ chain: string, chain_id: number, network: string, tx: string }} row
 * @returns {string|null}
 */
export function explorerTxUrl(row) {
	if (row.chain === 'solana') {
		const cluster = row.network === 'devnet' ? '?cluster=devnet' : '';
		return `https://solscan.io/tx/${row.tx}${cluster}`;
	}
	const base = CHAIN_BY_ID[row.chain_id]?.explorer;
	return base ? `${base}/tx/${row.tx}` : null;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { origins: '*', methods: 'GET,OPTIONS', credentials: false })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const q = new URL(req.url, `http://${req.headers.host || 'three.ws'}`).searchParams;

	const resolved = resolveRef(q);
	if ('err' in resolved) return error(res, 400, 'validation_error', resolved.err);

	const classArg = (q.get('class') || '').trim();
	if (classArg && !CLASS_SET.has(classArg)) {
		return error(
			res,
			400,
			'validation_error',
			`class must be one of: ${EVENT_CLASSES.join(', ')}`,
		);
	}

	const limitRaw = Number.parseInt(q.get('limit') || '100', 10);
	const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 500) : 100;

	const [rows, cursor] = await Promise.all([
		readAgentEvents({ agentRef: resolved.ref, eventClass: classArg || null, limit }),
		resolved.chain === 'solana'
			? sql`
					SELECT last_indexed_at, last_event_at, error
					FROM agent_event_cursor
					WHERE chain = 'solana' AND chain_id = 0 AND agent_ref = ${resolved.ref}
					LIMIT 1
				`
			: sql`
					SELECT updated_at AS last_indexed_at, NULL::timestamptz AS last_event_at,
					       NULL::text AS error
					FROM erc8004_crawl_cursor
					WHERE chain_id = ${resolved.chainId}
					LIMIT 1
				`,
	]);

	const cur = cursor[0] || null;
	const lagMinutes = cur?.last_indexed_at
		? Math.max(0, Math.round((Date.now() - new Date(cur.last_indexed_at).getTime()) / 60_000))
		: null;

	const counts = {};
	for (const r of rows) counts[r.event_class] = (counts[r.event_class] || 0) + 1;

	return json(
		res,
		200,
		{
			ref: resolved.ref,
			chain: resolved.chain,
			chainId: resolved.chainId || null,
			count: rows.length,
			counts,
			// Honest freshness: null means this agent has never been crawled, which
			// is a different statement from "this agent has no history".
			indexLag: {
				lastIndexedAt: cur?.last_indexed_at ? new Date(cur.last_indexed_at).toISOString() : null,
				lagMinutes,
				crawled: !!cur,
				error: cur?.error || null,
			},
			events: rows.map((r) => ({
				chain: r.chain,
				chainId: r.chain_id || null,
				network: r.network,
				eventClass: r.event_class,
				eventName: r.event_name,
				tx: r.tx,
				logIndex: r.log_index,
				blockNumber: r.block_number == null ? null : Number(r.block_number),
				occurredAt: new Date(r.occurred_at).toISOString(),
				indexedAt: new Date(r.indexed_at).toISOString(),
				actor: r.actor,
				counterparty: r.counterparty,
				payload: r.payload || {},
				explorerUrl: explorerTxUrl(r),
			})),
		},
		// The crawls tick every 10 to 15 minutes; a minute of shared cache absorbs
		// page-load bursts without ever showing meaningfully older history.
		{ 'cache-control': 'public, max-age=60' },
	);
});
