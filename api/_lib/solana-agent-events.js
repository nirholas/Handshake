// Solana leg of the agent event index: turn an agent account's transaction
// history into typed lifecycle events in agent_onchain_events.
//
// Why this exists. Before it, the Solana side of the index stored exactly two
// things: a static directory row per agent (solana_agents_index, written by the
// registry crawl) and three.ws memo attestations (solana_attestations). A live
// sample of eight indexed Metaplex Agent Registry agents on 2026-08-11 found
// 1 to 6 on-chain signatures each and ZERO indexed events for all eight,
// because the only Solana crawler recognized `threews.*` memo payloads and ran
// solely over agent_identities rows (18 mainnet agents) rather than the 1,558
// external agents in the directory.
//
// The transactions that were being dropped are exactly the classes the roadmap
// asks for. Decoded from mainnet:
//   RegisterIdentityV1  (1DREG…)  agent registration
//   SetAgentTokenV1     (1DREG…)  the agent's token launch — an SPL mint bound
//                                 to the agent, the Solana analog of a coin launch
//   DelegateExecutionV1 (TLREG…)  execution rights delegated to another account
//   TransferV1          (CoREEN…) Metaplex Core ownership transfer
//   UpdateV1            (CoREEN…) Core metadata update
//   SPL Memo threews.*            reputation / validation attestations
//
// classifyAgentTx() is pure and is where every one of those mappings lives, so
// the classification is unit-testable against captured mainnet transactions
// without an RPC round trip.

import { sql } from './db.js';
import { solanaConnection } from './solana/connection.js';
import { RPC } from './solana-attestations.js';
import { recordEvents } from './onchain-events.js';

/** Metaplex Agent Registry identity program. */
export const MPL_AGENT_IDENTITY_PROGRAM = '1DREGFgysWYxLnRnKQnwrxnJQeSMk2HmGaC6whw2B2p';
/** Metaplex Agent Registry execution-delegation program. */
export const MPL_AGENT_DELEGATION_PROGRAM = 'TLREGni9ZEyGC3vnPZtqUh95xQ8oPqJSvNjvB7FGK8S';
/** Metaplex Core, which owns the agent asset itself. */
export const MPL_CORE_PROGRAM = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';
/** SPL Token programs an agent-token launch touches. */
export const SPL_TOKEN_PROGRAMS = Object.freeze([
	'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
	'TokExjvjJmhKaRBShsBAsbSvEWMA1AgUNK7ps4SAc2p',
	'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
]);

// Anchor instruction names, as they appear in `Program log: Instruction: <Name>`,
// mapped to the index's event class. Names not listed here produce no event:
// the index records agent lifecycle, not every compute-budget hop.
const INSTRUCTION_EVENTS = Object.freeze({
	RegisterIdentityV1: { eventClass: 'registration', program: MPL_AGENT_IDENTITY_PROGRAM },
	UnregisterIdentityV1: { eventClass: 'registration', program: MPL_AGENT_IDENTITY_PROGRAM },
	SetAgentTokenV1: { eventClass: 'token_launch', program: MPL_AGENT_IDENTITY_PROGRAM },
	SetAgentUriV1: { eventClass: 'metadata', program: MPL_AGENT_IDENTITY_PROGRAM },
	DelegateExecutionV1: { eventClass: 'delegation', program: MPL_AGENT_DELEGATION_PROGRAM },
	RevokeExecutionV1: { eventClass: 'delegation', program: MPL_AGENT_DELEGATION_PROGRAM },
	TransferV1: { eventClass: 'transfer', program: MPL_CORE_PROGRAM },
	UpdateV1: { eventClass: 'metadata', program: MPL_CORE_PROGRAM },
	BurnV1: { eventClass: 'transfer', program: MPL_CORE_PROGRAM },
});

const MEMO_KIND_CLASS = Object.freeze({
	'threews.feedback.v1': 'reputation',
	'threews.stake.v1': 'reputation',
	'threews.review.v1': 'reputation',
	'threews.task.v1': 'reputation',
	'threews.accept.v1': 'reputation',
	'threews.revoke.v1': 'reputation',
	'threews.dispute.v1': 'reputation',
	'threews.validation.v1': 'validation',
});

const INSTRUCTION_LOG = /^Program log: Instruction: (\w+)$/;

/**
 * Account keys of a confirmed transaction as base58 strings, whichever shape
 * the RPC returned (jsonParsed puts objects in `accountKeys`, the default
 * encoding puts PublicKeys in `staticAccountKeys`).
 * @param {object} tx
 * @returns {string[]}
 */
export function accountKeysOf(tx) {
	const msg = tx?.transaction?.message;
	const keys = msg?.staticAccountKeys || msg?.accountKeys || [];
	return keys.map((k) => {
		if (typeof k === 'string') return k;
		if (typeof k?.toBase58 === 'function') return k.toBase58();
		if (typeof k?.pubkey === 'string') return k.pubkey;
		if (typeof k?.pubkey?.toBase58 === 'function') return k.pubkey.toBase58();
		return String(k);
	});
}

/**
 * Extract the SPL Memo JSON payload from a transaction's logs, or null.
 * @param {object} tx
 * @returns {object|null}
 */
export function memoPayloadOf(tx) {
	const line = (tx?.meta?.logMessages || []).find((l) => l.includes('Program log: Memo'));
	if (!line) return null;
	const start = line.indexOf('"');
	const end = line.lastIndexOf('"');
	if (start < 0 || end <= start) return null;
	try {
		return JSON.parse(line.slice(start + 1, end).replace(/\\"/g, '"'));
	} catch {
		return null;
	}
}

/**
 * Classify one confirmed transaction touching an agent account into zero or
 * more index events. Pure: no RPC, no DB, no clock.
 *
 * @param {object} args
 * @param {string} args.agentRef the agent account this transaction was fetched for
 * @param {string} args.signature transaction signature
 * @param {number} args.slot
 * @param {number|null} args.blockTime unix seconds from the RPC
 * @param {string} args.network 'mainnet' | 'devnet'
 * @param {object} args.tx confirmed transaction as returned by getTransactions
 * @returns {object[]} events ready for recordEvents()
 */
export function classifyAgentTx({ agentRef, signature, slot, blockTime, network, tx }) {
	if (!tx || tx?.meta?.err) return [];
	const keys = accountKeysOf(tx);
	const programs = new Set(keys);
	const logs = tx?.meta?.logMessages || [];
	const signer = keys[0] || null;
	const events = [];
	const seen = new Set();

	let ordinal = 0;
	for (const line of logs) {
		const m = INSTRUCTION_LOG.exec(line);
		if (!m) continue;
		const name = m[1];
		const spec = INSTRUCTION_EVENTS[name];
		// Only trust an instruction name when the program that owns it is
		// actually in the transaction: `UpdateV1` and `TransferV1` are common
		// names and would otherwise match an unrelated program's log line.
		if (!spec || !programs.has(spec.program)) continue;
		if (seen.has(name)) continue;
		seen.add(name);

		const payload = { program: spec.program, instruction: name };
		if (spec.eventClass === 'token_launch') {
			const mint = agentTokenMintOf(tx, agentRef);
			if (mint) payload.mint = mint;
		}

		events.push({
			chain: 'solana',
			network,
			agentRef,
			eventClass: spec.eventClass,
			eventName: name,
			tx: signature,
			logIndex: ordinal++,
			blockNumber: slot,
			occurredAt: blockTime,
			actor: signer,
			counterparty: spec.eventClass === 'transfer' ? transferRecipientOf(tx, keys) : null,
			payload,
		});
	}

	const memo = memoPayloadOf(tx);
	const memoClass = memo && typeof memo.kind === 'string' ? MEMO_KIND_CLASS[memo.kind] : null;
	if (memoClass) {
		events.push({
			chain: 'solana',
			network,
			agentRef,
			eventClass: memoClass,
			eventName: memo.kind,
			tx: signature,
			logIndex: ordinal++,
			blockNumber: slot,
			occurredAt: blockTime,
			actor: signer,
			counterparty: null,
			payload: memo,
		});
	}

	return events;
}

/**
 * Best-effort mint for a SetAgentTokenV1 transaction: the token balances the
 * transaction touched name the mint directly, which beats guessing from the
 * account list. Returns null when the tx moved no token balance.
 * @param {object} tx
 * @param {string} agentRef
 * @returns {string|null}
 */
export function agentTokenMintOf(tx, agentRef) {
	const balances = [...(tx?.meta?.postTokenBalances || []), ...(tx?.meta?.preTokenBalances || [])];
	for (const b of balances) {
		if (b?.mint && b.mint !== agentRef) return b.mint;
	}
	return null;
}

/**
 * The account a Core transfer moved the asset to: the largest SOL-balance
 * gainer that is not the fee payer. Null when the balances do not say.
 * @param {object} tx
 * @param {string[]} keys
 * @returns {string|null}
 */
export function transferRecipientOf(tx, keys) {
	const pre = tx?.meta?.preBalances;
	const post = tx?.meta?.postBalances;
	if (!Array.isArray(pre) || !Array.isArray(post)) return null;
	let best = null;
	let bestDelta = 0n;
	for (let i = 1; i < Math.min(pre.length, post.length, keys.length); i++) {
		const delta = BigInt(post[i] ?? 0) - BigInt(pre[i] ?? 0);
		if (delta > bestDelta) {
			bestDelta = delta;
			best = keys[i];
		}
	}
	return best;
}

const CHAIN = 'solana';

/**
 * Crawl one Solana agent account's recent signatures into the event index.
 * Resumes from agent_event_cursor, so a steady-state run fetches only what
 * landed since the last pass.
 *
 * @param {{ agentRef: string, network?: string, limit?: number }} args
 * @returns {Promise<{ scanned: number, inserted: number, rejected: number }>}
 */
export async function crawlAgentEvents({ agentRef, network = 'mainnet', limit = 100 }) {
	const net = network === 'devnet' ? 'devnet' : 'mainnet';
	const conn = solanaConnection({ url: RPC[net], commitment: 'confirmed' });

	const [cursor] = await sql`
		SELECT last_tx FROM agent_event_cursor
		WHERE chain = ${CHAIN} AND chain_id = 0 AND agent_ref = ${agentRef}
		LIMIT 1
	`;

	const sigs = await conn.getSignaturesForAddress(agentRef, {
		limit,
		until: cursor?.last_tx || undefined,
	});

	if (sigs.length === 0) {
		await touchCursor({ agentRef, network: net, lastTx: cursor?.last_tx || null });
		return { scanned: 0, inserted: 0, rejected: 0 };
	}

	const ok = sigs.filter((s) => !s.err);
	const txs = ok.length
		? await conn.getTransactions(
				ok.map((s) => s.signature),
				{ maxSupportedTransactionVersion: 0 },
			)
		: [];

	const events = [];
	for (let i = 0; i < ok.length; i++) {
		events.push(
			...classifyAgentTx({
				agentRef,
				signature: ok[i].signature,
				slot: ok[i].slot,
				blockTime: ok[i].blockTime ?? null,
				network: net,
				tx: txs[i],
			}),
		);
	}

	const { inserted, rejected } = await recordEvents(events);

	await touchCursor({
		agentRef,
		network: net,
		lastTx: sigs[0].signature,
		lastSlot: sigs[0].slot,
		lastEventAt: sigs[0].blockTime ? new Date(sigs[0].blockTime * 1000).toISOString() : null,
		scanned: sigs.length,
	});

	return { scanned: sigs.length, inserted, rejected };
}

async function touchCursor({ agentRef, network, lastTx, lastSlot = null, lastEventAt = null, scanned = 0 }) {
	await sql`
		INSERT INTO agent_event_cursor
			(chain, chain_id, agent_ref, network, last_tx, last_slot, last_event_at, last_indexed_at, scanned)
		VALUES
			(${CHAIN}, 0, ${agentRef}, ${network}, ${lastTx}, ${lastSlot}, ${lastEventAt}, now(), ${scanned})
		ON CONFLICT (chain, chain_id, agent_ref) DO UPDATE SET
			network         = excluded.network,
			last_tx         = COALESCE(excluded.last_tx, agent_event_cursor.last_tx),
			last_slot       = COALESCE(excluded.last_slot, agent_event_cursor.last_slot),
			last_event_at   = COALESCE(excluded.last_event_at, agent_event_cursor.last_event_at),
			last_indexed_at = now(),
			scanned         = agent_event_cursor.scanned + excluded.scanned,
			error           = null
	`;
}

/**
 * Record a crawl failure against the cursor so a permanently failing agent is
 * visible instead of silently starving the oldest-first queue forever.
 * @param {{ agentRef: string, network?: string, error: string }} args
 */
export async function markAgentEventError({ agentRef, network = 'mainnet', error }) {
	await sql`
		INSERT INTO agent_event_cursor
			(chain, chain_id, agent_ref, network, last_indexed_at, error)
		VALUES (${CHAIN}, 0, ${agentRef}, ${network}, now(), ${String(error).slice(0, 500)})
		ON CONFLICT (chain, chain_id, agent_ref) DO UPDATE SET
			last_indexed_at = now(),
			error = excluded.error
	`;
}

/**
 * The next batch of Solana agents to crawl, oldest cursor first, drawn from
 * BOTH the platform's own agents and the external registry directory. The
 * directory half is the coverage that was missing entirely.
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<Array<{ agent_ref: string, network: string, source: string }>>}
 */
export async function nextAgentBatch({ limit = 40 } = {}) {
	return sql`
		WITH candidates AS (
			SELECT
				a.meta->>'sol_mint_address'          AS agent_ref,
				coalesce(a.meta->>'network', 'mainnet') AS network,
				'three.ws'                            AS source
			FROM agent_identities a
			WHERE a.deleted_at IS NULL
			  AND a.meta ? 'sol_mint_address'
			UNION
			SELECT
				coalesce(s.asset, s.ref) AS agent_ref,
				s.network                AS network,
				s.source                 AS source
			FROM solana_agents_index s
			WHERE s.active = true
		)
		SELECT c.agent_ref, c.network, c.source
		FROM candidates c
		LEFT JOIN agent_event_cursor cur
			ON cur.chain = ${CHAIN} AND cur.chain_id = 0 AND cur.agent_ref = c.agent_ref
		WHERE c.agent_ref IS NOT NULL
		ORDER BY cur.last_indexed_at NULLS FIRST
		LIMIT ${limit}
	`;
}
