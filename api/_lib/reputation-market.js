/**
 * Reputation Staking Market v1 (rsm.v1) — the server-authoritative I/O layer.
 *
 * The pure earnings engine lives in src/shared/reputation-staking.js so the
 * browser can re-derive every lamport this module quotes. THIS module does the
 * real reads and the real writes: it verifies a stake transaction against
 * Solana, indexes the position, reads the agent's attested action history out of
 * `solana_attestations`, and signs the settlement that returns principal plus
 * earnings out of the market escrow.
 *
 * The contract it implements is specs/REPUTATION_STAKING_MARKET.md. Two rules
 * from that spec are enforced here and are the reason the money path is safe:
 *
 *   1. The market NEVER signs a stake. A stake is a transaction the staker
 *      signs; this module only reads it back. The only transaction the escrow
 *      key ever signs is a settlement paying a staker their own principal.
 *   2. Mainnet is owner-gated. Every write refuses unless
 *      REPUTATION_MARKET_ALLOW_MAINNET is set on the service. Devnet is the free
 *      proof path and needs no gate.
 */

import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';

import { sql } from './db.js';
import { solanaConnection } from './solana/connection.js';
import { sendAndConfirm } from './solana/confirm.js';
import { decodeAttesterSecret } from './attest-event.js';
import { RPC, extractMemoPayload, validatePayload } from './solana-attestations.js';
import {
	MARKET_TAG,
	MIN_STAKE_LAMPORTS,
	EPOCH_SECONDS,
	epochOf,
	epochBounds,
	positionEpochs,
	agentEpochWeight,
	accruePosition,
	distributeEpoch,
	realizedApr,
	clampSettlement,
	toBigInt,
} from '../../src/shared/reputation-staking.js';

export { MARKET_TAG, MIN_STAKE_LAMPORTS };

/** SPL Memo, the program the market's memo instruction targets. */
export const MEMO_PROGRAM_ID_BASE58 = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const MEMO_PROGRAM_ID = new PublicKey(MEMO_PROGRAM_ID_BASE58);

/** Attestation kind an unstake writes. Mirrors KIND_MAP.unstake. */
export const UNSTAKE_KIND = 'threews.unstake.v1';
/** Attestation kind a stake writes. Mirrors KIND_MAP.stake. */
export const STAKE_KIND = 'threews.stake.v1';

const TX_TIMEOUT_MS = 30_000;

export class MarketError extends Error {
	constructor(code, message, status = 400) {
		super(message);
		this.name = 'MarketError';
		this.code = code;
		this.status = status;
	}
}

// ── configuration ───────────────────────────────────────────────────────────

function normalizeNetwork(network) {
	return network === 'mainnet' ? 'mainnet' : 'devnet';
}

/**
 * Resolve the escrow account for a network. The pubkey may be configured on its
 * own (read-only deployments that index but never settle) or derived from the
 * secret key when one is present.
 *
 * @returns {{ network: string, escrow: PublicKey|null, canSign: boolean, poolLamports: bigint, mainnetAllowed: boolean }}
 */
export function marketConfig(network, env = process.env) {
	const net = normalizeNetwork(network);
	const secret = env.REPUTATION_MARKET_ESCROW_SECRET_KEY;
	let escrow = null;
	let canSign = false;

	if (secret) {
		const bytes = decodeAttesterSecret(secret);
		if (bytes) {
			escrow = Keypair.fromSecretKey(bytes).publicKey;
			canSign = true;
		}
	}
	if (!escrow && env.REPUTATION_MARKET_ESCROW_PUBKEY) {
		try {
			escrow = new PublicKey(env.REPUTATION_MARKET_ESCROW_PUBKEY.trim());
		} catch {
			escrow = null;
		}
	}
	// A configured pubkey that disagrees with the configured secret key is a
	// misconfiguration that would silently credit stakes to an account we cannot
	// pay out of. Fail loudly at read time rather than at withdrawal time.
	if (canSign && env.REPUTATION_MARKET_ESCROW_PUBKEY) {
		const declared = env.REPUTATION_MARKET_ESCROW_PUBKEY.trim();
		if (declared && declared !== escrow.toBase58()) {
			throw new MarketError(
				'market_not_configured',
				'REPUTATION_MARKET_ESCROW_PUBKEY does not match the account REPUTATION_MARKET_ESCROW_SECRET_KEY derives.',
				503,
			);
		}
	}

	const poolRaw = env.REPUTATION_MARKET_EPOCH_POOL_LAMPORTS;
	const poolLamports = poolRaw ? toBigInt(String(poolRaw).trim()) : 0n;

	return {
		network: net,
		escrow,
		canSign,
		poolLamports: poolLamports > 0n ? poolLamports : 0n,
		mainnetAllowed: env.REPUTATION_MARKET_ALLOW_MAINNET === '1' || env.REPUTATION_MARKET_ALLOW_MAINNET === 'true',
	};
}

/** Throw unless the market may be written on this network. Spec §1. */
export function assertWritable(cfg) {
	if (!cfg.escrow) {
		throw new MarketError('market_not_configured', 'No reputation-market escrow configured for this deployment.', 503);
	}
	if (cfg.network === 'mainnet' && !cfg.mainnetAllowed) {
		throw new MarketError(
			'mainnet_gated',
			'Mainnet reputation-market writes are owner-gated. Set REPUTATION_MARKET_ALLOW_MAINNET=1 to open them.',
			403,
		);
	}
}

function connectionFor(network) {
	return solanaConnection({ url: RPC[normalizeNetwork(network)], commitment: 'confirmed' });
}

/** The escrow secret key, or throw `escrow_unsigned`. */
function escrowKeypair(env = process.env) {
	const bytes = decodeAttesterSecret(env.REPUTATION_MARKET_ESCROW_SECRET_KEY);
	if (!bytes) {
		throw new MarketError('escrow_unsigned', 'REPUTATION_MARKET_ESCROW_SECRET_KEY is not configured or not decodable.', 503);
	}
	return Keypair.fromSecretKey(bytes);
}

// ── chain reads ─────────────────────────────────────────────────────────────

/** Lamports an account gained in a transaction, net of nothing else. 0n if it lost or is absent. */
export function lamportsReceivedBy(tx, pubkeyBase58) {
	if (!tx?.meta || !pubkeyBase58) return 0n;
	const keys = (tx.transaction?.message?.staticAccountKeys || tx.transaction?.message?.accountKeys || []).map((k) =>
		typeof k?.toBase58 === 'function' ? k.toBase58() : String(k),
	);
	const idx = keys.indexOf(pubkeyBase58);
	if (idx < 0) return 0n;
	const pre = BigInt(tx.meta.preBalances?.[idx] ?? 0);
	const post = BigInt(tx.meta.postBalances?.[idx] ?? 0);
	const delta = post - pre;
	return delta > 0n ? delta : 0n;
}

/** The fee payer (first signer) of a confirmed transaction, base58. */
export function feePayerOf(tx) {
	const keys = tx?.transaction?.message?.staticAccountKeys || tx?.transaction?.message?.accountKeys || [];
	const first = keys[0];
	if (!first) return null;
	return typeof first?.toBase58 === 'function' ? first.toBase58() : String(first);
}

/**
 * Verify a broadcast transaction is a valid market stake and return the position
 * it opens. Pure chain read: no database, no signing. Spec §3.1.
 *
 * @returns {Promise<{signature: string, network: string, agentAsset: string, staker: string, principalLamports: bigint, score: number|null, openedAt: number}>}
 */
export async function verifyStakeTx({ signature, network, env = process.env }) {
	const net = normalizeNetwork(network);
	const cfg = marketConfig(net, env);
	if (!cfg.escrow) {
		throw new MarketError('market_not_configured', 'No reputation-market escrow configured for this deployment.', 503);
	}

	const conn = connectionFor(net);
	const tx = await conn.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
	if (!tx) throw new MarketError('tx_not_found', `Transaction ${signature} is not confirmed on ${net}.`, 404);
	if (tx.meta?.err) throw new MarketError('not_a_market_stake', 'That transaction failed on-chain.', 400);

	const payload = extractMemoPayload(tx);
	if (!payload || payload.kind !== STAKE_KIND || !validatePayload(payload)) {
		throw new MarketError('not_a_market_stake', 'No valid threews.stake.v1 memo in that transaction.', 400);
	}
	if (payload.market !== MARKET_TAG) {
		throw new MarketError('not_a_market_stake', `Memo is not tagged market="${MARKET_TAG}".`, 400);
	}
	const escrowBase58 = cfg.escrow.toBase58();
	if (payload.escrow !== escrowBase58) {
		throw new MarketError('not_a_market_stake', 'Memo names a different escrow than this market.', 400);
	}

	const staker = feePayerOf(tx);
	if (!staker) throw new MarketError('not_a_market_stake', 'Could not resolve the transaction fee payer.', 400);
	if (staker === escrowBase58) {
		throw new MarketError('not_a_market_stake', 'The escrow cannot stake on its own market.', 400);
	}

	const principalLamports = lamportsReceivedBy(tx, escrowBase58);
	if (principalLamports < MIN_STAKE_LAMPORTS) {
		throw new MarketError(
			'stake_below_minimum',
			`The escrow received ${principalLamports} lamports; the minimum stake is ${MIN_STAKE_LAMPORTS}.`,
			400,
		);
	}

	return {
		signature,
		network: net,
		agentAsset: payload.agent,
		staker,
		principalLamports,
		score: Number.isInteger(payload.score) ? payload.score : null,
		openedAt: Number(tx.blockTime) || Math.floor(Date.now() / 1000),
	};
}

/**
 * Read an agent's attested action history straight off the chain, normalised for
 * the pure engine. This is the source `solana_attestations` indexes, so a caller
 * with no database (the devnet proof path) gets identical inputs.
 *
 * @returns {Promise<Array<{kind: string, verified: boolean, passed: boolean|null, score: number|null, taskAccepted: boolean, blockTime: number}>>}
 */
export async function readActionHistoryFromChain({ agentAsset, network, limit = 200 }) {
	const net = normalizeNetwork(network);
	const conn = connectionFor(net);
	const sigs = await conn.getSignaturesForAddress(new PublicKey(agentAsset), { limit });

	const acceptedTasks = new Set();
	const parsed = [];
	for (const s of sigs) {
		if (s.err) continue;
		const tx = await conn.getTransaction(s.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
		if (!tx) continue;
		const payload = extractMemoPayload(tx);
		if (!payload || payload.agent !== agentAsset || !validatePayload(payload)) continue;
		if (payload.kind === 'threews.accept.v1') acceptedTasks.add(payload.task_id);
		parsed.push({ payload, blockTime: Number(tx.blockTime) || 0 });
	}

	return parsed.map(({ payload, blockTime }) => ({
		kind: payload.kind,
		verified: true,
		passed: typeof payload.passed === 'boolean' ? payload.passed : null,
		score: Number.isInteger(payload.score) ? payload.score : null,
		taskAccepted: Boolean(payload.task_id && acceptedTasks.has(payload.task_id)),
		blockTime,
	}));
}

/**
 * Read an agent's attested action history out of the index. Same normalised
 * shape as readActionHistoryFromChain, restricted to a time window.
 */
export async function readActionHistoryFromIndex({ agentAssets, network, sinceUnix }) {
	const assets = [...new Set(agentAssets || [])].filter(Boolean);
	if (assets.length === 0) return new Map();
	const net = normalizeNetwork(network);
	const since = new Date(Number(sinceUnix) * 1000).toISOString();

	const rows = await sql`
		select
			a.agent_asset,
			a.kind,
			a.verified,
			(a.payload->>'passed')::boolean as passed,
			(a.payload->>'score')::int      as score,
			extract(epoch from a.block_time)::bigint as block_time,
			exists (
				select 1 from solana_attestations t
				where t.agent_asset = a.agent_asset
				  and t.network = a.network
				  and t.kind = 'threews.accept.v1'
				  and t.verified = true
				  and t.revoked = false
				  and t.payload->>'task_id' = a.payload->>'task_id'
			) and a.payload ? 'task_id' as task_accepted
		from solana_attestations a
		where a.agent_asset = any(${assets})
		  and a.network = ${net}
		  and a.revoked = false
		  and a.block_time is not null
		  and a.block_time >= ${since}
	`;

	const out = new Map();
	for (const asset of assets) out.set(asset, []);
	for (const r of rows) {
		out.get(r.agent_asset)?.push({
			kind: r.kind,
			verified: r.verified !== false,
			passed: r.passed,
			score: r.score,
			taskAccepted: r.task_accepted === true,
			blockTime: Number(r.block_time) || 0,
		});
	}
	return out;
}

// ── accrual ─────────────────────────────────────────────────────────────────

/** Bucket a flat attestation list into `epoch → rows`. */
export function bucketByEpoch(attestations) {
	const out = new Map();
	for (const a of attestations || []) {
		const e = epochOf(a.blockTime);
		if (!out.has(e)) out.set(e, []);
		out.get(e).push(a);
	}
	return out;
}

/**
 * Quote what a set of positions has earned, epoch by epoch, from real attested
 * action history. This is the one function both the HTTP surface and the devnet
 * proof path call, so what a staker is shown and what the escrow pays are the
 * same computation.
 *
 * @param {object} input
 * @param {Array<{id: string, agentAsset: string, principalLamports: bigint|string, openedAt: number, closedAt: number|null}>} input.positions
 * @param {Map<string, Array<object>>} input.historyByAgent agent → normalised attestations
 * @param {bigint} input.poolLamports per-epoch reward budget
 * @param {number} input.now unix seconds
 * @returns {{ byPosition: Map<string, {lamports: bigint, byEpoch: Array<object>}>, agentWeightsByEpoch: Map<number, Map<string, number>> }}
 */
export function quoteEarnings({ positions, historyByAgent, poolLamports, now }) {
	const pool = toBigInt(poolLamports);
	const nowSec = Number(now);

	// agent → epoch → weight, derived once from the attested history.
	const weightCache = new Map();
	for (const [asset, history] of historyByAgent instanceof Map ? historyByAgent : new Map()) {
		const buckets = bucketByEpoch(history);
		const perEpoch = new Map();
		for (const [epoch, rows] of buckets) perEpoch.set(epoch, agentEpochWeight(rows).weight);
		weightCache.set(asset, perEpoch);
	}

	// Every epoch any position was open in — a position competes with every other
	// position live in that epoch, so the pool split needs the whole cohort.
	const epochs = new Set();
	for (const p of positions) for (const e of positionEpochs(p, nowSec)) epochs.add(e);

	const agentWeightsByEpoch = new Map();
	const epochInputs = new Map();
	for (const epoch of [...epochs].sort((a, b) => a - b)) {
		const agentWeights = new Map();
		for (const p of positions) {
			if (agentWeights.has(p.agentAsset)) continue;
			agentWeights.set(p.agentAsset, weightCache.get(p.agentAsset)?.get(epoch) ?? 0);
		}
		agentWeightsByEpoch.set(epoch, agentWeights);
		epochInputs.set(epoch, { poolLamports: pool, positions, agentWeights });
	}

	const byPosition = new Map();
	for (const p of positions) {
		byPosition.set(p.id, accruePosition({ position: p, epochInputs, now: nowSec }));
	}
	return { byPosition, agentWeightsByEpoch };
}

// ── index writes ────────────────────────────────────────────────────────────

/**
 * Verify a stake transaction and index the position it opens. Idempotent: the
 * stake signature is the primary key, so recording the same stake twice returns
 * the row already there.
 */
export async function recordStake({ signature, network, env = process.env }) {
	const cfg = marketConfig(network, env);
	assertWritable(cfg);

	const existing = await getPosition({ signature, network: cfg.network });
	if (existing) return { position: existing, created: false };

	const verified = await verifyStakeTx({ signature, network: cfg.network, env });
	const openedAtIso = new Date(verified.openedAt * 1000).toISOString();

	await sql`
		insert into reputation_stake_positions
			(signature, network, agent_asset, staker, principal_lamports, score, opened_at, status)
		values (
			${verified.signature}, ${verified.network}, ${verified.agentAsset}, ${verified.staker},
			${verified.principalLamports.toString()}, ${verified.score}, ${openedAtIso}, 'open'
		)
		on conflict (signature) do nothing
	`;

	const position = await getPosition({ signature: verified.signature, network: verified.network });
	return { position, created: true };
}

/** One indexed position, or null. */
export async function getPosition({ signature, network }) {
	const [row] = await sql`
		select * from reputation_stake_positions
		where signature = ${signature} and network = ${normalizeNetwork(network)}
		limit 1
	`;
	return row ? shapePositionRow(row) : null;
}

function shapePositionRow(row) {
	return {
		id: row.signature,
		signature: row.signature,
		network: row.network,
		agentAsset: row.agent_asset,
		staker: row.staker,
		principalLamports: toBigInt(String(row.principal_lamports)),
		score: row.score === null || row.score === undefined ? null : Number(row.score),
		openedAt: Math.floor(new Date(row.opened_at).getTime() / 1000),
		status: row.status,
		closedAt: row.closed_at ? Math.floor(new Date(row.closed_at).getTime() / 1000) : null,
		settleSignature: row.settle_signature || null,
		earningsLamports: toBigInt(String(row.earnings_lamports ?? '0')),
	};
}

/** Every position open during (or closed inside) a window, for cohort accrual. */
export async function loadCohort({ network, sinceUnix }) {
	const net = normalizeNetwork(network);
	const since = new Date(Number(sinceUnix) * 1000).toISOString();
	const rows = await sql`
		select * from reputation_stake_positions
		where network = ${net}
		  and (closed_at is null or closed_at >= ${since})
	`;
	return rows.map(shapePositionRow);
}

/** Every position a wallet holds on a network, newest first. */
export async function loadStakerPositions({ staker, network }) {
	const rows = await sql`
		select * from reputation_stake_positions
		where staker = ${staker} and network = ${normalizeNetwork(network)}
		order by opened_at desc
		limit 200
	`;
	return rows.map(shapePositionRow);
}

// ── settlement ──────────────────────────────────────────────────────────────

/** The escrow's reward surplus: balance, minus open principal, minus the rent floor. */
export async function escrowSurplus({ network, env = process.env }) {
	const cfg = marketConfig(network, env);
	if (!cfg.escrow) return { balance: 0n, principal: 0n, rentFloor: 0n, surplus: 0n };
	const conn = connectionFor(cfg.network);
	const [balance, rentFloor] = await Promise.all([
		conn.getBalance(cfg.escrow, 'confirmed').then((n) => BigInt(n)),
		conn.getMinimumBalanceForRentExemption(0).then((n) => BigInt(n)),
	]);
	const [row] = await sql`
		select coalesce(sum(principal_lamports), 0)::text as total
		from reputation_stake_positions
		where network = ${cfg.network} and status <> 'closed'
	`;
	const principal = toBigInt(row?.total ?? '0');
	const surplus = balance - principal - rentFloor;
	return { balance, principal, rentFloor, surplus: surplus > 0n ? surplus : 0n };
}

/**
 * Settle a position: pay principal plus accrued earnings back to the staker
 * recorded on-chain, write a `threews.unstake.v1` memo in the same transaction,
 * and close the index row.
 *
 * Idempotent. A `closed` position returns its original settlement instead of
 * paying twice; a `settling` position is claimed by whichever caller flipped it,
 * so a crashed withdrawal is retried rather than double-paid.
 */
export async function withdrawPosition({ signature, network, env = process.env }) {
	const cfg = marketConfig(network, env);
	assertWritable(cfg);

	const position = await getPosition({ signature, network: cfg.network });
	if (!position) throw new MarketError('unknown_position', `No indexed position for ${signature}.`, 404);

	if (position.status === 'closed') {
		const settlement = await getSettlement(position.signature);
		return { status: 'already_closed', position, settlement };
	}

	const keypair = escrowKeypair(env);
	if (keypair.publicKey.toBase58() !== cfg.escrow.toBase58()) {
		throw new MarketError('escrow_unsigned', 'The configured escrow key does not control the market escrow account.', 503);
	}

	const now = Math.floor(Date.now() / 1000);
	const quote = await quotePosition({ position, network: cfg.network, now, env });
	const { surplus } = await escrowSurplus({ network: cfg.network, env });
	const settled = clampSettlement({
		principalLamports: position.principalLamports,
		earningsLamports: quote.lamports,
		surplusLamports: surplus,
	});
	const payout = settled.principal + settled.earnings;

	// Claim the position BEFORE signing. A crash after the transfer lands leaves
	// the row in `settling`, which a retry finishes; a crash before it leaves the
	// row in `settling` with no payout, which the same retry also finishes. What
	// cannot happen is two transfers for one position.
	const claimed = await sql`
		update reputation_stake_positions
		set status = 'settling'
		where signature = ${position.signature} and status = 'open'
		returning signature
	`;
	if (claimed.length === 0 && position.status !== 'settling') {
		throw new MarketError('unknown_position', 'The position changed state while settling; retry.', 409);
	}

	const memo = JSON.stringify({
		v: 1,
		kind: UNSTAKE_KIND,
		market: MARKET_TAG,
		agent: position.agentAsset,
		stake: position.signature,
		principal: settled.principal.toString(),
		earnings: settled.earnings.toString(),
	});

	const tx = new Transaction().add(
		SystemProgram.transfer({
			fromPubkey: keypair.publicKey,
			toPubkey: new PublicKey(position.staker),
			lamports: payout,
		}),
		new TransactionInstruction({ keys: [], programId: MEMO_PROGRAM_ID, data: Buffer.from(memo, 'utf8') }),
	);

	const conn = connectionFor(cfg.network);
	const settleSignature = await sendAndConfirm(conn, tx, [keypair], {
		commitment: 'confirmed',
		timeoutMs: TX_TIMEOUT_MS,
	});

	const closedAtIso = new Date(now * 1000).toISOString();
	await sql`
		insert into reputation_stake_settlements
			(stake_signature, network, staker, principal_lamports, earnings_lamports, clamped, breakdown, settle_signature)
		values (
			${position.signature}, ${cfg.network}, ${position.staker},
			${settled.principal.toString()}, ${settled.earnings.toString()}, ${settled.clamped},
			${JSON.stringify(quote.byEpoch)}::jsonb, ${settleSignature}
		)
		on conflict (stake_signature) do nothing
	`;
	await sql`
		update reputation_stake_positions
		set status = 'closed', closed_at = ${closedAtIso},
			settle_signature = ${settleSignature}, earnings_lamports = ${settled.earnings.toString()}
		where signature = ${position.signature}
	`;

	return {
		status: 'closed',
		position: { ...position, status: 'closed', closedAt: now, settleSignature, earningsLamports: settled.earnings },
		settlement: {
			stakeSignature: position.signature,
			settleSignature,
			principalLamports: settled.principal.toString(),
			earningsLamports: settled.earnings.toString(),
			payoutLamports: payout.toString(),
			clamped: settled.clamped,
			breakdown: quote.byEpoch,
		},
	};
}

/** A recorded settlement, or null. */
export async function getSettlement(stakeSignature) {
	const [row] = await sql`
		select * from reputation_stake_settlements where stake_signature = ${stakeSignature} limit 1
	`;
	if (!row) return null;
	return {
		stakeSignature: row.stake_signature,
		settleSignature: row.settle_signature,
		principalLamports: String(row.principal_lamports),
		earningsLamports: String(row.earnings_lamports),
		payoutLamports: (toBigInt(String(row.principal_lamports)) + toBigInt(String(row.earnings_lamports))).toString(),
		clamped: row.clamped === true,
		breakdown: row.breakdown || [],
		settledAt: row.settled_at,
	};
}

/**
 * Earnings for ONE position, against the full cohort competing for the same
 * epochs. Reads the index for both the cohort and the action history.
 */
export async function quotePosition({ position, network, now, env = process.env }) {
	const cfg = marketConfig(network, env);
	const cohort = await loadCohort({ network: cfg.network, sinceUnix: position.openedAt });
	const positions = cohort.some((p) => p.id === position.id) ? cohort : [...cohort, position];
	const historyByAgent = await readActionHistoryFromIndex({
		agentAssets: positions.map((p) => p.agentAsset),
		network: cfg.network,
		sinceUnix: epochBounds(epochOf(position.openedAt)).start,
	});
	const { byPosition } = quoteEarnings({ positions, historyByAgent, poolLamports: cfg.poolLamports, now });
	return byPosition.get(position.id) || { lamports: 0n, byEpoch: [] };
}

// ── net conviction (spec §3.3) ──────────────────────────────────────────────

/**
 * Net staked conviction for one agent: verified `threews.stake.v1` lamports minus
 * the principal every settlement retired. Spec §3.3, "withdrawn conviction is not
 * conviction".
 *
 * Only the escrow's own unstake memos retire anything. A settlement is
 * escrow-signed by construction (spec §3.2), so honouring any structurally valid
 * unstake would let a stranger deflate an agent's conviction with a memo naming
 * somebody else's stake signature. A deployment with no escrow configured retires
 * nothing, which reports the gross figure rather than a wrong net one.
 *
 * @returns {Promise<{total_lamports: string, count: number, unique_stakers: number,
 *   gross_lamports: string, retired_lamports: string, retired_count: number,
 *   top_stakers: Array<{attester: string, lamports: string, score: number|null}>}>}
 */
export async function netStakeForAgent({ asset, network, limit = 5, env = process.env }) {
	const net = normalizeNetwork(network);
	let escrow = null;
	try {
		escrow = marketConfig(net, env).escrow?.toBase58() || null;
	} catch {
		// A misconfigured escrow must not take the whole reputation card down; it
		// only means nothing is credited as retired.
		escrow = null;
	}

	const stakes = await sql`
		select signature, attester,
			coalesce(payload->>'lamports', '0') as lamports,
			(payload->>'score')::int as score
		from solana_attestations
		where agent_asset = ${asset} and network = ${net}
		  and kind = 'threews.stake.v1' and verified = true and revoked = false
	`;

	// No escrow configured means no settlement this deployment can vouch for, so
	// nothing is retired and the answer is the gross figure.
	const retirements = escrow
		? await sql`
			select payload->>'stake' as stake_signature, payload->>'principal' as principal
			from solana_attestations
			where agent_asset = ${asset} and network = ${net}
			  and kind = ${UNSTAKE_KIND} and verified = true and revoked = false
			  and attester = ${escrow}
		`
		: [];

	return netConviction({ stakes, retirements, limit });
}

/**
 * Fold indexed stakes and the settlements that retired them into the net
 * conviction figure. Pure, so the rule in spec §3.3 is testable without a
 * database and reproduces identically wherever it runs.
 *
 * Retirement is per stake signature and clamped to that stake's own principal, so
 * an over-stated `principal` in one settlement can never eat a different staker's
 * conviction, and net conviction can never go negative.
 *
 * @param {object} input
 * @param {Array<{signature: string, attester: string, lamports: string, score: number|null}>} input.stakes
 * @param {Array<{stake_signature: string, principal: string}>} input.retirements
 * @param {number} [input.limit] how many top stakers to return
 */
export function netConviction({ stakes = [], retirements = [], limit = 5 } = {}) {
	// A stake settles once; if the index somehow holds two settlements naming it,
	// the largest is the one that retires it, never their sum.
	const retiredBySignature = new Map();
	for (const r of retirements) {
		const sig = r?.stake_signature;
		if (!sig) continue;
		const principal = toBigInt(String(r.principal ?? '0'));
		const prev = retiredBySignature.get(sig) ?? 0n;
		if (principal > prev) retiredBySignature.set(sig, principal);
	}

	let gross = 0n;
	let retired = 0n;
	let total = 0n;
	let retiredCount = 0;
	let openCount = 0;
	const byAttester = new Map();

	for (const s of stakes) {
		const principal = toBigInt(String(s?.lamports ?? '0'));
		const claimed = retiredBySignature.get(s?.signature) ?? 0n;
		const back = claimed > principal ? principal : claimed;
		const remaining = principal - back;

		gross += principal;
		retired += back;
		total += remaining;
		if (back > 0n) retiredCount++;
		if (remaining <= 0n) continue;

		openCount++;
		const prev = byAttester.get(s.attester) || { lamports: 0n, score: null };
		prev.lamports += remaining;
		const score = Number.isInteger(s?.score) ? s.score : null;
		if (score !== null) prev.score = prev.score === null ? score : Math.max(prev.score, score);
		byAttester.set(s.attester, prev);
	}

	const top = [...byAttester.entries()]
		.sort((a, b) => (a[1].lamports === b[1].lamports ? 0 : b[1].lamports > a[1].lamports ? 1 : -1))
		.slice(0, limit)
		.map(([attester, v]) => ({ attester, lamports: v.lamports.toString(), score: v.score }));

	return {
		total_lamports: total.toString(),
		count: openCount,
		unique_stakers: byAttester.size,
		gross_lamports: gross.toString(),
		retired_lamports: retired.toString(),
		retired_count: retiredCount,
		top_stakers: top,
	};
}

// ── market listing ──────────────────────────────────────────────────────────

const LISTING_WINDOW_EPOCHS = 7;

/**
 * Agents ranked by net staked conviction, with the current epoch's yield weight
 * and the realized rate their stakers have actually earned. Everything here is
 * derived from indexed positions and attested actions; nothing is projected.
 */
export async function listMarket({ network, limit = 25, env = process.env }) {
	const cfg = marketConfig(network, env);
	const now = Math.floor(Date.now() / 1000);
	const currentEpoch = epochOf(now);
	const windowStart = epochBounds(currentEpoch - LISTING_WINDOW_EPOCHS + 1).start;

	const cohort = await loadCohort({ network: cfg.network, sinceUnix: windowStart });
	const historyByAgent = await readActionHistoryFromIndex({
		agentAssets: cohort.map((p) => p.agentAsset),
		network: cfg.network,
		sinceUnix: windowStart,
	});
	const { byPosition, agentWeightsByEpoch } = quoteEarnings({
		positions: cohort,
		historyByAgent,
		poolLamports: cfg.poolLamports,
		now,
	});

	const byAgent = new Map();
	for (const p of cohort) {
		if (!byAgent.has(p.agentAsset)) {
			byAgent.set(p.agentAsset, {
				agentAsset: p.agentAsset,
				stakedLamports: 0n,
				earningsLamports: 0n,
				openPositions: 0,
				stakers: new Set(),
				scoreSum: 0,
				scoreCount: 0,
				oldestOpenAt: p.openedAt,
			});
		}
		const row = byAgent.get(p.agentAsset);
		const earned = byPosition.get(p.id)?.lamports ?? 0n;
		row.earningsLamports += earned;
		if (p.status !== 'closed') {
			row.stakedLamports += p.principalLamports;
			row.openPositions++;
			row.stakers.add(p.staker);
			row.oldestOpenAt = Math.min(row.oldestOpenAt, p.openedAt);
		}
		if (p.score !== null) {
			row.scoreSum += p.score;
			row.scoreCount++;
		}
	}

	const names = await agentNamesFor([...byAgent.keys()]);
	const currentWeights = agentWeightsByEpoch.get(currentEpoch) || new Map();

	const agents = [...byAgent.values()]
		.map((row) => ({
			agent_asset: row.agentAsset,
			name: names.get(row.agentAsset)?.name || null,
			agent_id: names.get(row.agentAsset)?.id || null,
			staked_lamports: row.stakedLamports.toString(),
			earnings_lamports: row.earningsLamports.toString(),
			open_positions: row.openPositions,
			unique_stakers: row.stakers.size,
			mean_conviction: row.scoreCount > 0 ? Math.round((row.scoreSum / row.scoreCount) * 100) / 100 : null,
			epoch_weight: currentWeights.get(row.agentAsset) ?? 0,
			realized_apr: realizedApr({
				principalLamports: row.stakedLamports,
				earningsLamports: row.earningsLamports,
				openedAt: row.oldestOpenAt,
				closedAt: null,
				now,
			}),
		}))
		.sort((a, b) => {
			const d = toBigInt(b.staked_lamports) - toBigInt(a.staked_lamports);
			if (d !== 0n) return d > 0n ? 1 : -1;
			return b.epoch_weight - a.epoch_weight;
		})
		.slice(0, limit);

	return {
		network: cfg.network,
		escrow: cfg.escrow ? cfg.escrow.toBase58() : null,
		epoch: currentEpoch,
		epoch_seconds: EPOCH_SECONDS,
		epoch_pool_lamports: cfg.poolLamports.toString(),
		min_stake_lamports: MIN_STAKE_LAMPORTS.toString(),
		mainnet_open: cfg.mainnetAllowed,
		count: agents.length,
		agents,
		generated_at: new Date(now * 1000).toISOString(),
	};
}

/** Resolve agent asset pubkeys to platform identities, where one exists. */
async function agentNamesFor(assets) {
	const out = new Map();
	if (assets.length === 0) return out;
	const rows = await sql`
		select id, name, meta->>'sol_mint_address' as sol_mint, meta->>'solana_address' as sol_addr
		from agent_identities
		where deleted_at is null
		  and (meta->>'sol_mint_address' = any(${assets}) or meta->>'solana_address' = any(${assets}))
	`.catch(() => []);
	for (const r of rows) {
		for (const key of [r.sol_mint, r.sol_addr]) {
			if (key && assets.includes(key) && !out.has(key)) out.set(key, { id: r.id, name: r.name });
		}
	}
	return out;
}

/** Positions a wallet holds, with pending earnings quoted against the live cohort. */
export async function stakerView({ staker, network, env = process.env }) {
	const cfg = marketConfig(network, env);
	const now = Math.floor(Date.now() / 1000);
	const mine = await loadStakerPositions({ staker, network: cfg.network });
	if (mine.length === 0) {
		return { network: cfg.network, staker, count: 0, positions: [], generated_at: new Date(now * 1000).toISOString() };
	}

	const earliest = Math.min(...mine.map((p) => p.openedAt));
	const cohort = await loadCohort({ network: cfg.network, sinceUnix: earliest });
	const merged = [...cohort];
	for (const p of mine) if (!merged.some((c) => c.id === p.id)) merged.push(p);
	const historyByAgent = await readActionHistoryFromIndex({
		agentAssets: merged.map((p) => p.agentAsset),
		network: cfg.network,
		sinceUnix: epochBounds(epochOf(earliest)).start,
	});
	const { byPosition } = quoteEarnings({ positions: merged, historyByAgent, poolLamports: cfg.poolLamports, now });
	const names = await agentNamesFor([...new Set(mine.map((p) => p.agentAsset))]);

	return {
		network: cfg.network,
		staker,
		count: mine.length,
		positions: mine.map((p) => {
			const quote = byPosition.get(p.id) || { lamports: 0n, byEpoch: [] };
			const earnings = p.status === 'closed' ? p.earningsLamports : quote.lamports;
			return {
				signature: p.signature,
				agent_asset: p.agentAsset,
				name: names.get(p.agentAsset)?.name || null,
				agent_id: names.get(p.agentAsset)?.id || null,
				principal_lamports: p.principalLamports.toString(),
				score: p.score,
				status: p.status,
				opened_at: new Date(p.openedAt * 1000).toISOString(),
				closed_at: p.closedAt ? new Date(p.closedAt * 1000).toISOString() : null,
				settle_signature: p.settleSignature,
				earnings_lamports: earnings.toString(),
				pending: p.status !== 'closed',
				realized_apr: realizedApr({
					principalLamports: p.principalLamports,
					earningsLamports: earnings,
					openedAt: p.openedAt,
					closedAt: p.closedAt,
					now,
				}),
				breakdown: quote.byEpoch,
			};
		}),
		generated_at: new Date(now * 1000).toISOString(),
	};
}

export { distributeEpoch, agentEpochWeight, epochOf, epochBounds };
