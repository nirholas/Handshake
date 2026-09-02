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

import { PublicKey } from '@solana/web3.js';
import { sql } from './db.js';
import { solanaConnection } from './solana/connection.js';
import { signaturesSinceCursor } from './solana/cursor-recovery.js';
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
 * Wrapped SOL. It is the QUOTE side of every agent-token launch that funds a
 * pool, never the agent's own token, and it is the first mint the naive
 * "any mint this tx touched" reading finds. See agentTokenMintOf().
 */
export const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';

// spl-token instruction types that can only name a mint being created or
// finalized, in the order of how strongly each identifies THE launched token.
// setAuthority qualifies only for the two mint-scoped authority types: renouncing
// mint/freeze authority is the last step of a launch, and a launchpad emits it
// for the new token and for nothing else.
const MINT_AUTHORITY_TYPES = new Set(['mintTokens', 'freezeAccount']);

/**
 * The mint a SetAgentTokenV1 transaction bound to the agent.
 *
 * Reading `meta.*TokenBalances` alone is wrong, and measurably so: on mainnet
 * transaction 5WtcSn4jJubQnEu71nnjKZJZawtgGNeVayiDgG4QsDsCZreJN2W3MQiJpPWszCFcanFRDMVfojNwrPC7SBumRqw8
 * the only token balance is wrapped SOL, while the token actually launched and
 * bound to agent ANeykUs3hCNb9B9hVx4sQg7D8hD6MzAyRPJ2M1ays18 is
 * X8k6vcAvvmkavecwAGk7U4JVoKdntDSNfBZsq6KPLEX, visible only in the inner
 * spl-token instructions. Every token_launch event the index recorded that way
 * named the quote asset instead of the agent's coin.
 *
 * So prefer STRUCTURAL evidence, which a launch cannot fake: a mint this
 * transaction initialized, then renounced authority over, then minted supply
 * from. Token balances remain the last resort for a binding that touched an
 * already-existing mint, with wrapped SOL and the agent account itself excluded.
 *
 * Requires a PARSED transaction (getParsedTransactions); a raw one exposes no
 * instruction types and falls through to the balance heuristic.
 *
 * @param {object} tx parsed confirmed transaction
 * @param {string} agentRef the agent account, never its own token
 * @returns {string|null}
 */
export function agentTokenMintOf(tx, agentRef) {
	const byPriority = [new Set(), new Set(), new Set()];

	for (const ix of parsedInstructionsOf(tx)) {
		const info = ix?.parsed?.info;
		const mint = typeof info?.mint === 'string' ? info.mint : null;
		if (!mint || mint === WRAPPED_SOL_MINT || mint === agentRef) continue;
		switch (ix.parsed.type) {
			case 'initializeMint':
			case 'initializeMint2':
				byPriority[0].add(mint);
				break;
			case 'setAuthority':
				if (MINT_AUTHORITY_TYPES.has(info.authorityType)) byPriority[1].add(mint);
				break;
			case 'mintTo':
			case 'mintToChecked':
				byPriority[2].add(mint);
				break;
			default:
				break;
		}
	}

	for (const tier of byPriority) {
		// A single unambiguous mint at this tier is the answer. Two different
		// mints initialized in one transaction (a launch plus an LP token, say)
		// is not something to guess at, so fall through to the next signal.
		if (tier.size === 1) return [...tier][0];
	}

	for (const b of [...(tx?.meta?.postTokenBalances || []), ...(tx?.meta?.preTokenBalances || [])]) {
		if (b?.mint && b.mint !== agentRef && b.mint !== WRAPPED_SOL_MINT) return b.mint;
	}
	return null;
}

/**
 * Every parsed instruction in a transaction, top level and inner (a launchpad
 * CPIs the token program, so the mint lives in the inner set).
 * @param {object} tx
 * @returns {object[]}
 */
export function parsedInstructionsOf(tx) {
	const top = tx?.transaction?.message?.instructions || [];
	const inner = (tx?.meta?.innerInstructions || []).flatMap((g) => g?.instructions || []);
	return [...top, ...inner].filter((ix) => ix && typeof ix.parsed?.type === 'string');
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
 * Agents swept per solana-attestations-crawl tick, and the cron's period.
 *
 * These two numbers and the size of the directory decide the index's floor lag:
 * a queue drained oldest-first has a full-sweep cycle of
 * `agents / SOLANA_SWEEP_BATCH * SOLANA_SWEEP_PERIOD_MIN` minutes and a median
 * agent lag of half that. At 40 agents per tick the 1,576-agent directory
 * measured on 2026-08-13 cycled in 6.6 hours for a 200-minute median, which is
 * exactly the median the status surface reported: the sweep was not slow, it was
 * too small. The lag monitor now derives the cycle from these constants, so the
 * next time the directory outgrows the batch it is visible as a number rather
 * than as an unexplained median.
 *
 * Raising this costs one getSignaturesForAddress per agent per tick; the cron's
 * wall-clock budget, not this constant, is the real ceiling. Measured against
 * the live lane router on 2026-09-02, one agent costs ~370ms end to end, so the
 * sweep's 120-second budget drains roughly 320 agents serially and far more than
 * that at the concurrency below. 120 per tick was therefore never the budget
 * talking: it was leaving three quarters of the tick idle while the directory
 * grew to 1,604 agents and the cycle stretched to 140 minutes, well past the
 * sensor's 90-minute fresh threshold. 240 puts a 1,600-agent directory on a
 * 70-minute cycle for a 35-minute median, with room to keep growing.
 */
export const SOLANA_SWEEP_BATCH = 240;
export const SOLANA_SWEEP_PERIOD_MIN = 10;

/**
 * Agents crawled in parallel within one tick.
 *
 * Each agent is one independent getSignaturesForAddress plus its transaction
 * reads, so the sweep spends almost all of its wall clock waiting on the RPC.
 * A small pool turns that dead time into throughput and gives the batch above
 * its headroom. Kept deliberately low: the lane router already rotates
 * providers and parks a cooling one, and a wide fan-out would earn 429s faster
 * than it earns signatures.
 */
export const SOLANA_SWEEP_CONCURRENCY = 4;

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

	// getSignaturesForAddress takes a PublicKey and calls .toBase58() on it, so
	// handing it the base58 STRING we carry everywhere else throws
	// `TypeError: address.toBase58 is not a function` before a single RPC round
	// trip. That is not a hypothetical: it is why the Solana leg of the index
	// held 0 events on 2026-08-13 while its 1,576 per-agent cursors all showed
	// as freshly crawled, since the error path stamps the cursor too.
	let address;
	try {
		address = new PublicKey(agentRef);
	} catch {
		// A directory row whose ref is not an account key can never be crawled.
		// Record it against the cursor instead of throwing every tick forever.
		await markAgentEventError({ agentRef, network: net, error: 'agent_ref is not a Solana account key' });
		return { scanned: 0, inserted: 0, rejected: 0 };
	}

	const [cursor] = await sql`
		SELECT last_tx FROM agent_event_cursor
		WHERE chain = ${CHAIN} AND chain_id = 0 AND agent_ref = ${agentRef}
		LIMIT 1
	`;

	// Never call getSignaturesForAddress({ until }) directly here. The lane
	// router answers from whichever RPC provider is not cooling, and providers
	// disagree about which signatures they still hold, so a cursor written by
	// one lane is regularly unresolvable by the next. That fails the WHOLE call
	// and, because the cursor is only ever written on the success path, wedges
	// the agent forever. Measured on 2026-09-02: 1,101 of 1,604 Solana cursors
	// were stuck on exactly that error, every one of them re-reporting it every
	// tick, which is what held the agent_index sensor at `down`.
	const { sigs, cursorReset } = await signaturesSinceCursor(
		conn,
		address,
		limit,
		cursor?.last_tx || undefined,
	);

	if (sigs.length === 0) {
		// An abandoned cursor must NOT be written back: re-storing the dead
		// signature would re-arm the exact stall this recovery just cleared.
		// This is the common case for a wedged agent, since the account whose
		// cursor the lane cannot resolve usually has no reachable history on
		// that lane either.
		await touchCursor({
			agentRef,
			network: net,
			lastTx: cursorReset ? null : cursor?.last_tx || null,
			resetCursor: cursorReset,
		});
		return { scanned: 0, inserted: 0, rejected: 0 };
	}

	const ok = sigs.filter((s) => !s.err);
	// Parsed, not raw: agentTokenMintOf() reads the inner spl-token instructions
	// to tell an agent's launched token from the wrapped SOL that funded it, and
	// only the parsed encoding carries instruction types. accountKeysOf() and
	// memoPayloadOf() already accept both shapes.
	const txs = ok.length
		? await conn.getParsedTransactions(
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

/**
 * Stamp a successful pass over one agent's cursor.
 *
 * `resetCursor` exists because the COALESCE below is a trap on the recovery
 * path: it is there so a quiet tick keeps the last good signature, but it also
 * means passing null to CLEAR an unresolvable cursor silently preserves it, and
 * the agent stays wedged on the next tick. When the recovery abandoned the
 * cursor, write the null through instead of folding it away.
 */
async function touchCursor({ agentRef, network, lastTx, lastSlot = null, lastEventAt = null, scanned = 0, resetCursor = false }) {
	await sql`
		INSERT INTO agent_event_cursor
			(chain, chain_id, agent_ref, network, last_tx, last_slot, last_event_at, last_indexed_at, scanned)
		VALUES
			(${CHAIN}, 0, ${agentRef}, ${network}, ${lastTx}, ${lastSlot}, ${lastEventAt}, now(), ${scanned})
		ON CONFLICT (chain, chain_id, agent_ref) DO UPDATE SET
			network         = excluded.network,
			last_tx         = CASE WHEN ${resetCursor}::boolean THEN excluded.last_tx
			                       ELSE COALESCE(excluded.last_tx, agent_event_cursor.last_tx) END,
			last_slot       = CASE WHEN ${resetCursor}::boolean THEN excluded.last_slot
			                       ELSE COALESCE(excluded.last_slot, agent_event_cursor.last_slot) END,
			last_event_at   = CASE WHEN ${resetCursor}::boolean THEN excluded.last_event_at
			                       ELSE COALESCE(excluded.last_event_at, agent_event_cursor.last_event_at) END,
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

/**
 * Wall-clock the sweep gives itself inside one cron tick.
 *
 * The attestation half of solana-attestations-crawl shares the same function
 * invocation, so this leaves it the rest of the 300-second ceiling. It is a
 * ceiling, not a target: at the shipped batch and concurrency a full tick costs
 * a fraction of it, and the budget only matters on a tick where a provider is
 * slow enough that finishing late would be worse than finishing short.
 */
export const SOLANA_SWEEP_BUDGET_MS = 120_000;

/**
 * Crawl one tick's worth of the Solana agent directory.
 *
 * Drains the oldest-cursor-first batch through a small worker pool, stops on
 * the budget rather than on the batch, and stamps a failure onto every agent it
 * could not read so one unreadable account cannot hold the queue head forever.
 *
 * `truncated` means the budget ran out with agents still queued: the cycle time
 * the freshness sensor derives from SOLANA_SWEEP_BATCH assumes a batch that
 * drains, so a truncated tick is the signal that the batch has outgrown the
 * budget and the sensor's cycle number is now optimistic.
 *
 * @param {{ budgetMs?: number, limit?: number, concurrency?: number, now?: () => number }} [opts]
 * @returns {Promise<{ agents: number, scanned: number, inserted: number, rejected: number,
 *   failed: number, truncated: boolean, batch: number, concurrency: number,
 *   elapsedMs: number, error?: string }>}
 */
/**
 * Run `handle` over `items` through a small worker pool, stopping on a
 * wall-clock budget rather than on the list.
 *
 * Split out from the sweep because the pool is the part with the edge cases and
 * the sweep is the part that needs a database and twenty RPC providers: this
 * way the ordering, the budget and the truncation flag are exercised directly,
 * with a real list and a real clock function, instead of being reasoned about.
 *
 * `truncated` means the budget expired with items still queued. It is read
 * BEFORE the clock on purpose, so a run that consumed its last item on the
 * final millisecond reports completion rather than phantom unfinished work.
 *
 * @template T
 * @param {T[]} items
 * @param {(item: T, index: number) => Promise<void>} handle
 * @param {{ concurrency?: number, budgetMs?: number, now?: () => number }} [opts]
 * @returns {Promise<{ processed: number, truncated: boolean, workers: number, elapsedMs: number }>}
 */
export async function drainWithBudget(items, handle, { concurrency = 1, budgetMs = Infinity, now = Date.now } = {}) {
	const startedAt = now();
	const workers = Math.max(1, Math.min(Math.trunc(concurrency) || 1, items.length || 1));
	let next = 0;
	let truncated = false;

	const drain = async () => {
		for (;;) {
			if (next >= items.length) return;
			if (now() - startedAt > budgetMs) {
				truncated = true;
				return;
			}
			const index = next++;
			await handle(items[index], index);
		}
	};

	await Promise.all(Array.from({ length: workers }, drain));
	return { processed: next, truncated, workers, elapsedMs: now() - startedAt };
}

/**
 * Crawl one tick's worth of the Solana agent directory.
 *
 * Drains the oldest-cursor-first batch through the pool above, stops on the
 * budget rather than on the batch, and stamps a failure onto every agent it
 * could not read so one unreadable account cannot hold the queue head forever.
 *
 * A `truncated` tick is the signal that the batch has outgrown the budget: the
 * cycle time the freshness sensor derives from SOLANA_SWEEP_BATCH assumes a
 * batch that drains, so from that point on the sensor's cycle is optimistic.
 *
 * @param {{ budgetMs?: number, limit?: number, concurrency?: number, now?: () => number }} [opts]
 * @returns {Promise<{ agents: number, scanned: number, inserted: number, rejected: number,
 *   failed: number, truncated: boolean, batch: number, concurrency: number,
 *   elapsedMs: number, error?: string }>}
 */
export async function sweepAgentEvents({
	budgetMs = SOLANA_SWEEP_BUDGET_MS,
	limit = SOLANA_SWEEP_BATCH,
	concurrency = SOLANA_SWEEP_CONCURRENCY,
	now = Date.now,
} = {}) {
	const startedAt = now();
	const summary = {
		agents: 0,
		scanned: 0,
		inserted: 0,
		rejected: 0,
		failed: 0,
		truncated: false,
		batch: 0,
		concurrency: 0,
		elapsedMs: 0,
	};

	let batch;
	try {
		batch = await nextAgentBatch({ limit });
	} catch (err) {
		return { ...summary, elapsedMs: now() - startedAt, error: err?.message || String(err) };
	}
	summary.batch = batch.length;

	const run = await drainWithBudget(
		batch,
		async (row) => {
			try {
				const r = await crawlAgentEvents({ agentRef: row.agent_ref, network: row.network });
				summary.agents += 1;
				summary.scanned += r.scanned;
				summary.inserted += r.inserted;
				summary.rejected += r.rejected;
			} catch (err) {
				summary.failed += 1;
				await markAgentEventError({
					agentRef: row.agent_ref,
					network: row.network,
					error: err?.message || String(err),
				}).catch(() => {});
			}
		},
		{ concurrency, budgetMs, now },
	);

	summary.truncated = run.truncated;
	summary.concurrency = run.workers;
	summary.elapsedMs = run.elapsedMs;
	return summary;
}
