// Shared writer + reader for agent_onchain_events, the platform's own
// cross-chain index of agent lifecycle events.
//
// Every indexer leg (EVM registry logs, Solana account signatures) normalizes
// its raw event into the shape below and hands it here, so one table answers
// "what has happened to this agent" regardless of chain. Solana leads: its
// events carry chain 'solana' and chain_id 0; EVM events carry chain 'evm' and
// the real chain id.
//
// occurred_at is always the ABSOLUTE on-chain timestamp (EVM block timestamp,
// Solana blockTime). An event with no readable on-chain time is rejected rather
// than stamped with now(), because a fabricated timestamp silently corrupts
// every history render and every lag number computed from this table.

import { sql } from './db.js';

/**
 * The event classes the index recognizes. A crawler emitting anything else is
 * a bug, not a new feature: add the class here first so the API filters, the
 * history UI and the lag monitor all learn about it at once.
 */
export const EVENT_CLASSES = Object.freeze([
	'registration', // agent minted / registered in a registry
	'metadata', // agentURI or a metadata key changed
	'transfer', // ownership moved between accounts
	'token_launch', // an SPL/ERC-20 token was bound to the agent
	'reputation', // feedback / stake / review attestation
	'validation', // validation request or response
	'delegation', // execution rights delegated to another account
]);

const CLASS_SET = new Set(EVENT_CLASSES);

const MAX_TEXT = 256;

// Deepest payload nesting the sanitizer walks. On-chain payloads are shallow
// objects the crawlers build themselves, so this is a cycle guard, not a limit
// any real event approaches.
const MAX_PAYLOAD_DEPTH = 8;

/**
 * Strip the two code points Postgres refuses to store, from a string that came
 * off a chain and is therefore arbitrary bytes decoded as UTF-8.
 *
 * A NUL (U+0000) inside a jsonb value fails the whole INSERT with
 * `unsupported Unicode escape sequence`, and a lone surrogate fails it with an
 * invalid-escape error of its own. Because recordEvents is awaited BEFORE the
 * crawl cursor advances, one such byte in one log wedges that chain forever:
 * every tick re-reads the same block range, hits the same log, throws, and
 * leaves the cursor where it was. Measured on 2026-08-28: Base mainnet had been
 * frozen 310 hours, Ethereum 97 and Gnosis 371, all three with
 * `unsupported Unicode escape sequence` sitting in erc8004_crawl_cursor.last_error.
 *
 * The event is worth more than the unstorable byte, so drop the byte and keep
 * the row rather than rejecting history the chain really contains.
 * @param {string} s
 * @returns {string}
 */
export function sanitizeText(s) {
	return String(s)
		.replace(/\u0000/g, '')
		.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
}

/**
 * Apply sanitizeText to every string in a payload, keys included: a metadata
 * key is as much on-chain bytes as its value is.
 * @param {unknown} v
 * @param {number} [depth]
 * @returns {unknown}
 */
export function sanitizePayload(v, depth = 0) {
	if (typeof v === 'string') return sanitizeText(v);
	if (!v || typeof v !== 'object') return v;
	// Past the guard the subtree is dropped rather than passed through: handing
	// back an unwalked object would put unsanitized on-chain strings straight
	// into jsonb, which is the exact failure this function exists to prevent.
	if (depth >= MAX_PAYLOAD_DEPTH) return null;
	if (Array.isArray(v)) return v.map((item) => sanitizePayload(item, depth + 1));
	const out = {};
	for (const [k, val] of Object.entries(v)) out[sanitizeText(k)] = sanitizePayload(val, depth + 1);
	return out;
}

const clip = (v) => {
	if (v == null) return null;
	const s = sanitizeText(v).trim();
	if (!s) return null;
	return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) : s;
};

/**
 * Compose the stable agent reference used as the index key.
 * EVM agents are '<chainId>:<agentId>'; Solana agents are the account pubkey.
 * @param {{ chain: string, chainId?: number, agentId?: string|number, ref?: string }} a
 * @returns {string}
 */
export function agentRef({ chain, chainId, agentId, ref }) {
	if (chain === 'evm') return `${chainId}:${agentId}`;
	return String(ref ?? agentId);
}

/**
 * Normalize one crawler event into the row shape, or return null when the
 * event cannot be trusted (unknown class, missing tx, no on-chain timestamp).
 * Pure: no DB, no clock. This is the seam the tests drive.
 * @param {object} e
 * @returns {object|null}
 */
export function normalizeEvent(e) {
	if (!e || typeof e !== 'object') return null;
	const chain = e.chain === 'evm' ? 'evm' : e.chain === 'solana' ? 'solana' : null;
	if (!chain) return null;
	if (!CLASS_SET.has(e.eventClass)) return null;

	const tx = clip(e.tx);
	const ref = clip(e.agentRef);
	const name = clip(e.eventName);
	if (!tx || !ref || !name) return null;

	const occurredAt = toDate(e.occurredAt);
	if (!occurredAt) return null;

	const chainId = chain === 'evm' ? Number(e.chainId) : 0;
	if (!Number.isInteger(chainId) || chainId < 0) return null;

	const logIndex = Number.isInteger(e.logIndex) ? e.logIndex : 0;
	const blockNumber =
		e.blockNumber == null || !Number.isFinite(Number(e.blockNumber))
			? null
			: Math.trunc(Number(e.blockNumber));

	return {
		chain,
		chainId,
		network: clip(e.network) || 'mainnet',
		agentRef: ref,
		eventClass: e.eventClass,
		eventName: name,
		tx,
		logIndex,
		blockNumber,
		occurredAt,
		actor: clip(e.actor),
		counterparty: clip(e.counterparty),
		payload: e.payload && typeof e.payload === 'object' ? sanitizePayload(e.payload) : {},
	};
}

/**
 * Coerce an on-chain timestamp into a Date. Accepts a Date, an ISO string, a
 * unix-seconds number (what both eth_getBlockByNumber and Solana blockTime
 * hand back) and unix milliseconds. Returns null for anything unreadable or
 * outside a sane range, so a bad value never lands as a real-looking row.
 * @param {unknown} v
 * @returns {Date|null}
 */
export function toDate(v) {
	if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
	if (typeof v === 'string') {
		const d = new Date(v);
		return Number.isNaN(d.getTime()) ? null : d;
	}
	if (typeof v === 'number' && Number.isFinite(v)) {
		// Below 1e12 the value is seconds (any ms timestamp since 2001 is larger).
		const ms = v < 1e12 ? v * 1000 : v;
		const d = new Date(ms);
		if (Number.isNaN(d.getTime())) return null;
		// Reject pre-2015 and far-future values: no agent registry predates them,
		// so such a value is a decode bug, not history.
		const year = d.getUTCFullYear();
		if (year < 2015 || year > 2100) return null;
		return d;
	}
	return null;
}

/**
 * Persist a batch of events. Idempotent on (chain, chain_id, tx, log_index):
 * a re-crawl of the same range inserts nothing. Invalid events are counted as
 * `rejected` and reported rather than silently dropped.
 * @param {object[]} events
 * @returns {Promise<{ inserted: number, rejected: number }>}
 */
export async function recordEvents(events) {
	let inserted = 0;
	let rejected = 0;
	for (const raw of events || []) {
		const e = normalizeEvent(raw);
		if (!e) {
			rejected += 1;
			continue;
		}
		const rows = await sql`
			INSERT INTO agent_onchain_events
				(chain, chain_id, network, agent_ref, event_class, event_name, tx,
				 log_index, block_number, occurred_at, actor, counterparty, payload)
			VALUES
				(${e.chain}, ${e.chainId}, ${e.network}, ${e.agentRef}, ${e.eventClass},
				 ${e.eventName}, ${e.tx}, ${e.logIndex}, ${e.blockNumber},
				 ${e.occurredAt.toISOString()}, ${e.actor}, ${e.counterparty},
				 ${JSON.stringify(e.payload)}::jsonb)
			ON CONFLICT (chain, chain_id, tx, log_index) DO NOTHING
			RETURNING id
		`;
		if (rows.length > 0) inserted += 1;
	}
	return { inserted, rejected };
}

/**
 * Read one agent's event history, newest first.
 * @param {{ agentRef: string, eventClass?: string|null, limit?: number }} q
 * @returns {Promise<object[]>}
 */
export async function readAgentEvents({ agentRef: ref, eventClass = null, limit = 100 }) {
	const cap = Math.min(Math.max(Number(limit) || 100, 1), 500);
	const cls = eventClass && CLASS_SET.has(eventClass) ? eventClass : null;
	return sql`
		SELECT chain, chain_id, network, agent_ref, event_class, event_name, tx,
		       log_index, block_number, occurred_at, actor, counterparty, payload,
		       indexed_at
		FROM agent_onchain_events
		WHERE agent_ref = ${ref}
		  AND (${cls}::text IS NULL OR event_class = ${cls})
		ORDER BY occurred_at DESC, log_index DESC
		LIMIT ${cap}
	`;
}
