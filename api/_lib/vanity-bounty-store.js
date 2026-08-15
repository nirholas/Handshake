/**
 * Persistence + escrow ledger for the grind-bounty market.
 *
 * Stores the bounty board, the escrow record (USDC the requester paid up front
 * via x402, held until a winning claim or expiry), and the single, atomic
 * open→settled transition that picks exactly one winner. Mirrors the rest of the
 * codebase: Upstash Redis when configured, an in-process Map fallback otherwise
 * (so local/CI works and a Redis outage degrades rather than throwing).
 *
 * ── Secret-blind by construction ─────────────────────────────────────────────
 * A stored bounty NEVER holds a private key or seed, only the requester's PUBLIC
 * X25519 recipient key. A winning claim holds only the SEALED envelope (opaque
 * ciphertext addressed to the requester) plus the public address. The operator
 * therefore cannot open any wallet it brokers; `toPublicBounty()` additionally
 * strips the sealed envelope from the public board view so only the requester
 * (via the authenticated reveal path) ever receives it.
 *
 * ── Escrow lands before the bounty does ──────────────────────────────────────
 * A bounty is born `escrow_pending`: recorded, but in NO index, so it is invisible
 * to the board and to `listClaimable`, and every compare-and-set below refuses it.
 * Only `activateBounty` (called after the x402 escrow actually settled on-chain)
 * flips it to `open` and indexes it. A settle that fails is voided instead. That
 * ordering is what stops the platform paying a winner, or refunding a requester -
 * out of a bounty whose escrow was never collected.
 *
 * ── Atomic single-winner settlement ──────────────────────────────────────────
 * `claimBounty` runs a Lua compare-and-set: it flips status open→settled, records
 * the winner + claim digest, and returns "won" ONLY to the first caller. Every
 * later caller: even with a different valid key: sees `settled` and gets
 * "lost" (idempotent: re-submitting the SAME claim digest returns "won" again so
 * a retried settle isn't a double-pay). Expiry refunds are gated by the same
 * compare-and-set on open→refunded, so a bounty can never both pay AND refund.
 *
 * Layout (Redis):
 *   HASH  vanity:bounty:rec               field=id → JSON(bounty record)
 *   ZSET  vanity:bounty:open              member=id  score=expiresAt(ms)   (live board)
 *   ZSET  vanity:bounty:by-recency        member=id  score=createdAt(ms)
 *   ZSET  vanity:bounty:leaderboard       member=workerId  score=earnedAtomics (top grinders)
 */

import { getRedis } from './redis.js';

const NS = 'vanity:bounty';
const K = {
	rec: `${NS}:rec`,
	open: `${NS}:open`,
	byRecency: `${NS}:by-recency`,
	leaderboard: `${NS}:leaderboard`,
};

const MAX_SCAN = 500;

// Statuses a bounty holds before (or instead of) going live. Neither is a real
// bounty: they never reach the board, the claim queue, or the stats totals.
const TRANSIENT_STATUSES = Object.freeze(['escrow_pending', 'void']);

/** True for a record that has not (or will never) go live on the board. */
function isTransient(rec) {
	return !!rec && TRANSIENT_STATUSES.includes(rec.status);
}

// Public board projection: the sealed envelope + escrow proof stay private.
// SECURITY: this is the privacy boundary for the board. The sealed envelope is
// only ever returned to the requester through the dedicated reveal path, never here.
const PUBLIC_FIELDS = Object.freeze([
	'id', 'protocol', 'pattern', 'recipient', 'amountAtomics', 'asset', 'network',
	'status', 'difficulty', 'createdAt', 'expiresAt', 'settledAt', 'refundedAt',
	'winnerAddress', 'winnerWorkerId', 'payoutTx', 'refundTx', 'label',
]);

const mem = new Map(); // id → record (fallback store)

/** Project a record to its public board shape (no sealed envelope, no escrow proof). */
export function toPublicBounty(rec) {
	if (!rec || typeof rec !== 'object') return null;
	const out = {};
	for (const k of PUBLIC_FIELDS) if (rec[k] !== undefined) out[k] = rec[k];
	if (!out.id) return null;
	// Never leak the sealed envelope or any escrow secret on the public view.
	return out;
}

/**
 * Record a bounty. The escrow proof (x402 settlement tx + payer) is stored on the
 * record but never exposed publicly: it is the audit trail proving the requester
 * actually funded it.
 *
 * Pass `status: 'escrow_pending'` (what api/vanity/bounties.js does) to record the
 * bounty WITHOUT indexing it: it stays off the board and out of the claim queue
 * until `activateBounty` confirms the escrow settled. A record created straight
 * into `open` is indexed immediately, which is only correct when the caller has
 * already collected the escrow.
 *
 * @param {object} rec - fully-formed bounty record (see api/vanity/bounties.js).
 * @returns {Promise<object>} the stored record.
 */
export async function createBounty(rec) {
	const record = { ...rec, status: rec.status || 'open' };
	const indexed = record.status === 'open';
	const redis = getRedis();
	if (redis) {
		// Claim the id atomically FIRST (hsetnx) so a (astronomically unlikely)
		// collision can't repoint the index ZSETs at an existing record. Only on a
		// fresh insert do we add the board/recency index entries.
		const created = await redis.hsetnx(K.rec, record.id, JSON.stringify(record));
		if (created === 0 || created === false) {
			throw Object.assign(new Error('bounty id collision'), { status: 409, code: 'duplicate_bounty' });
		}
		if (indexed) {
			const pipe = redis.multi();
			pipe.zadd(K.open, { score: record.expiresAt, member: record.id });
			pipe.zadd(K.byRecency, { score: record.createdAt, member: record.id });
			await pipe.exec();
		}
	} else {
		if (mem.has(record.id)) {
			throw Object.assign(new Error('bounty id collision'), { status: 409, code: 'duplicate_bounty' });
		}
		mem.set(record.id, record);
	}
	return record;
}

// Atomic escrow_pending→open compare-and-set, run only once the x402 escrow has
// really settled on-chain. Indexes the bounty in the same call, so it becomes
// board-visible and claimable at the instant it becomes funded, never before.
// Idempotent: re-activating an already-open bounty returns 1.
// Returns 1=live, 0=wrong-status, -2=missing.
const ACTIVATE_LUA = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then return -2 end
local rec = cjson.decode(raw)
if rec.status == 'open' then return 1 end
if rec.status ~= 'escrow_pending' then return 0 end
rec.status = 'open'
rec.escrowSettledAt = tonumber(ARGV[2])
rec.escrowTx = ARGV[3]
rec.escrowNetwork = ARGV[4]
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(rec))
redis.call('ZADD', KEYS[2], tonumber(rec.expiresAt), ARGV[1])
redis.call('ZADD', KEYS[3], tonumber(rec.createdAt), ARGV[1])
return 1
`;

/**
 * Flip a pending bounty live now that its escrow settled on-chain, recording the
 * settlement tx as the audit trail. Idempotent.
 *
 * @param {object} p
 * @param {string} p.id
 * @param {string} [p.escrowTx] - the x402 settlement transaction.
 * @param {string} [p.escrowNetwork] - the network the escrow settled on.
 * @returns {Promise<'live'|'ineligible'|'missing'>}
 */
export async function activateBounty({ id, escrowTx, escrowNetwork }) {
	const now = Date.now();
	const redis = getRedis();
	if (redis) {
		const r = Number(await redis.eval(
			ACTIVATE_LUA,
			[K.rec, K.open, K.byRecency],
			[String(id), String(now), String(escrowTx || ''), String(escrowNetwork || '')],
		));
		if (r === 1) return 'live';
		if (r === -2) return 'missing';
		return 'ineligible';
	}
	const rec = mem.get(String(id));
	if (!rec) return 'missing';
	if (rec.status === 'open') return 'live';
	if (rec.status !== 'escrow_pending') return 'ineligible';
	rec.status = 'open';
	rec.escrowSettledAt = now;
	rec.escrowTx = escrowTx || '';
	rec.escrowNetwork = escrowNetwork || '';
	mem.set(String(id), rec);
	return 'live';
}

// Atomic escrow_pending→void compare-and-set for a bounty whose escrow never
// settled. A void bounty was never indexed, so voiding is purely a status +
// reason write: it can never be claimed, refunded, or listed. Idempotent.
const VOID_LUA = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then return -2 end
local rec = cjson.decode(raw)
if rec.status == 'void' then return 1 end
if rec.status ~= 'escrow_pending' then return 0 end
rec.status = 'void'
rec.voidedAt = tonumber(ARGV[2])
rec.voidReason = ARGV[3]
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(rec))
return 1
`;

/**
 * Void a pending bounty whose escrow failed to settle, so the unfunded record can
 * never be claimed or refunded. Idempotent.
 *
 * @param {object} p
 * @param {string} p.id
 * @param {string} [p.reason] - why the escrow never landed (audit trail).
 * @returns {Promise<'void'|'ineligible'|'missing'>}
 */
export async function voidBounty({ id, reason }) {
	const now = Date.now();
	const redis = getRedis();
	if (redis) {
		const r = Number(await redis.eval(VOID_LUA, [K.rec], [String(id), String(now), String(reason || '')]));
		if (r === 1) return 'void';
		if (r === -2) return 'missing';
		return 'ineligible';
	}
	const rec = mem.get(String(id));
	if (!rec) return 'missing';
	if (rec.status === 'void') return 'void';
	if (rec.status !== 'escrow_pending') return 'ineligible';
	rec.status = 'void';
	rec.voidedAt = now;
	rec.voidReason = reason || '';
	mem.set(String(id), rec);
	return 'void';
}

/** Fetch the full internal record by id (includes sealed envelope when settled). */
export async function getBountyRecord(id) {
	const key = String(id || '');
	if (!key) return null;
	const redis = getRedis();
	if (redis) return parse(await redis.hget(K.rec, key));
	return mem.get(key) || null;
}

/** Fetch the public board view by id. */
export async function getBounty(id) {
	return toPublicBounty(await getBountyRecord(id));
}

// Atomic open→settled compare-and-set. Idempotent on claimDigest: a retry of the
// SAME winning claim returns won=1 again (so a settle retry after a transient
// payout error doesn't pay a second worker), while a DIFFERENT claim on an
// already-settled bounty returns won=0 (lost the race). Also rejects expired and
// already-refunded bounties. Returns: 1=won, 0=lost, -1=not-open/expired, -2=missing.
const CLAIM_LUA = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then return -2 end
local rec = cjson.decode(raw)
if rec.status == 'settled' then
  if rec.claimDigest == ARGV[2] then return 1 else return 0 end
end
if rec.status ~= 'open' then return -1 end
local now = tonumber(ARGV[5])
if rec.expiresAt and now > tonumber(rec.expiresAt) then return -1 end
rec.status = 'settled'
rec.claimDigest = ARGV[2]
rec.winnerAddress = ARGV[3]
rec.winnerWorkerId = ARGV[4]
rec.settledAt = now
rec.sealedSecret = cjson.decode(ARGV[6])
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(rec))
redis.call('ZREM', KEYS[2], ARGV[1])
return 1
`;

/**
 * Atomically claim a bounty for a worker. The FIRST valid claim wins; every later
 * one loses (idempotent on the same claimDigest). Records the winner + sealed
 * envelope on the record but leaves payout to the caller (so payout failure can
 * be retried without re-racing). Returns a status enum the caller maps to a
 * response.
 *
 * @param {object} p
 * @param {string} p.id
 * @param {string} p.claimDigest - deterministic digest from bounty-protocol.
 * @param {string} p.winnerAddress - the ground Base58 address.
 * @param {string} p.workerId - the claiming worker's id (anonymous ok).
 * @param {object} p.sealedSecret - the ECIES envelope addressed to the requester.
 * @returns {Promise<'won'|'lost'|'closed'|'missing'>}
 */
export async function claimBounty({ id, claimDigest, winnerAddress, workerId, sealedSecret }) {
	const now = Date.now();
	const redis = getRedis();
	if (redis) {
		const r = await redis.eval(
			CLAIM_LUA,
			[K.rec, K.open],
			[String(id), String(claimDigest), String(winnerAddress), String(workerId || 'anon'), String(now), JSON.stringify(sealedSecret)],
		);
		return claimCode(Number(r));
	}
	// Memory fallback: emulate the same compare-and-set semantics single-threaded.
	const rec = mem.get(String(id));
	if (!rec) return 'missing';
	if (rec.status === 'settled') return rec.claimDigest === claimDigest ? 'won' : 'lost';
	if (rec.status !== 'open') return 'closed';
	if (rec.expiresAt && now > rec.expiresAt) return 'closed';
	rec.status = 'settled';
	rec.claimDigest = claimDigest;
	rec.winnerAddress = winnerAddress;
	rec.winnerWorkerId = workerId || 'anon';
	rec.settledAt = now;
	rec.sealedSecret = sealedSecret;
	mem.set(String(id), rec);
	return 'won';
}

function claimCode(n) {
	if (n === 1) return 'won';
	if (n === 0) return 'lost';
	if (n === -2) return 'missing';
	return 'closed';
}

/** Record the on-chain payout tx after a successful settle (idempotent set). */
export async function recordPayout({ id, payoutTx, workerId, amountAtomics }) {
	const rec = await getBountyRecord(id);
	if (!rec) return null;
	rec.payoutTx = payoutTx;
	rec.payoutAt = Date.now();
	const redis = getRedis();
	if (redis) {
		const pipe = redis.multi();
		pipe.hset(K.rec, { [id]: JSON.stringify(rec) });
		if (workerId && amountAtomics) pipe.zincrby(K.leaderboard, Number(amountAtomics), String(workerId));
		await pipe.exec();
	} else {
		mem.set(id, rec);
	}
	return rec;
}

// Atomic open→refunded compare-and-set, only for EXPIRED bounties. Mutually
// exclusive with settlement: a settled bounty can never be refunded and vice
// versa. Idempotent: re-running on an already-refunded bounty returns 1 so a
// retried refund doesn't error. Returns 1=refundable(now refunded), 0=not-eligible.
const REFUND_LUA = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then return -2 end
local rec = cjson.decode(raw)
if rec.status == 'refunded' then return 1 end
if rec.status ~= 'open' then return 0 end
local now = tonumber(ARGV[2])
if not rec.expiresAt or now <= tonumber(rec.expiresAt) then return 0 end
rec.status = 'refunded'
rec.refundedAt = now
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(rec))
redis.call('ZREM', KEYS[2], ARGV[1])
return 1
`;

/**
 * Atomically mark an EXPIRED open bounty as refunded so its escrow can be paid
 * back to the requester exactly once. Returns 'refundable' (caller should now
 * send the on-chain refund), 'ineligible' (still live, or already settled), or
 * 'missing'. Mutually exclusive with claimBounty by construction.
 * @param {string} id
 */
export async function markRefundable(id) {
	const now = Date.now();
	const redis = getRedis();
	if (redis) {
		const r = await redis.eval(REFUND_LUA, [K.rec, K.open], [String(id), String(now)]);
		const n = Number(r);
		if (n === 1) return 'refundable';
		if (n === -2) return 'missing';
		return 'ineligible';
	}
	const rec = mem.get(String(id));
	if (!rec) return 'missing';
	if (rec.status === 'refunded') return 'refundable';
	if (rec.status !== 'open') return 'ineligible';
	if (!rec.expiresAt || now <= rec.expiresAt) return 'ineligible';
	rec.status = 'refunded';
	rec.refundedAt = now;
	mem.set(String(id), rec);
	return 'refundable';
}

/** Record the on-chain refund tx after a successful refund. */
export async function recordRefund({ id, refundTx }) {
	const rec = await getBountyRecord(id);
	if (!rec) return null;
	rec.refundTx = refundTx;
	rec.refundAt = Date.now();
	const redis = getRedis();
	if (redis) await redis.hset(K.rec, { [id]: JSON.stringify(rec) });
	else mem.set(id, rec);
	return rec;
}

/**
 * Query the board.
 * @param {object} [q]
 * @param {'open'|'all'|'settled'} [q.status='open']
 * @param {'recency'|'expiry'|'reward'} [q.sort='recency']
 * @param {number} [q.limit=24]
 * @param {number} [q.offset=0]
 * @returns {Promise<{ bounties:object[], total:number, hasMore:boolean }>}
 */
export async function queryBounties(q = {}) {
	const status = q.status || 'open';
	const sort = q.sort || 'recency';
	const limit = Math.max(1, Math.min(60, Number(q.limit) || 24));
	const offset = Math.max(0, Number(q.offset) || 0);
	const now = Date.now();

	const redis = getRedis();
	let recs;
	if (redis) {
		// `open` reads the live ZSET (and lazily filters out anything past expiry
		// that hasn't been swept yet); everything else reads by-recency then filters.
		const indexKey = status === 'open' ? K.open : K.byRecency;
		const members = await redis.zrange(indexKey, 0, MAX_SCAN - 1, { rev: status !== 'open' });
		if (!members.length) return { bounties: [], total: 0, hasMore: false };
		const raw = await redis.hmget(K.rec, ...members);
		recs = members.map((_, i) => parse(raw?.[i])).filter(Boolean);
	} else {
		recs = [...mem.values()];
	}

	// A pending/void record has no escrow behind it, so it never appears on the
	// board: not even under status=all, which reads the whole recency index.
	let filtered = recs.filter((r) => !isTransient(r));
	if (status === 'open') filtered = filtered.filter((r) => r.status === 'open' && r.expiresAt > now);
	else if (status === 'settled') filtered = filtered.filter((r) => r.status === 'settled');

	filtered.sort((a, b) => {
		if (sort === 'reward') return (b.amountAtomics || 0) - (a.amountAtomics || 0);
		if (sort === 'expiry') return (a.expiresAt || 0) - (b.expiresAt || 0);
		return (b.createdAt || 0) - (a.createdAt || 0);
	});

	const total = filtered.length;
	const page = filtered.slice(offset, offset + limit).map(toPublicBounty);
	return { bounties: page, total, hasMore: offset + limit < total };
}

/** Open bounties only, oldest-expiry-first: the worker fleet's claim queue. */
export async function listClaimable(limit = 30) {
	const now = Date.now();
	const redis = getRedis();
	if (redis) {
		// Score is expiresAt; range from now upward returns only still-live bounties
		// in expiry order (soonest-to-expire first: fill them before they refund).
		const members = await redis.zrange(K.open, now, '+inf', { byScore: true });
		const slice = members.slice(0, Math.max(1, Math.min(60, limit)));
		if (!slice.length) return [];
		const raw = await redis.hmget(K.rec, ...slice);
		return slice.map((_, i) => parse(raw?.[i])).filter((r) => r && r.status === 'open').map(toPublicBounty);
	}
	return [...mem.values()]
		.filter((r) => r.status === 'open' && r.expiresAt > now)
		.sort((a, b) => a.expiresAt - b.expiresAt)
		.slice(0, limit)
		.map(toPublicBounty);
}

/** Aggregate board stats: open count, total escrowed, settled count, total paid. */
export async function bountyStats() {
	const redis = getRedis();
	let recs;
	if (redis) {
		const all = await redis.hgetall(K.rec);
		recs = all ? Object.values(all).map(parse).filter(Boolean) : [];
	} else {
		recs = [...mem.values()];
	}
	const now = Date.now();
	// Pending/void records never became bounties, so they count toward nothing -
	// including `total`, which is the number of bounties the market actually took.
	const real = recs.filter((r) => !isTransient(r));
	let open = 0, openEscrow = 0, settled = 0, paidOut = 0;
	for (const r of real) {
		if (r.status === 'open' && r.expiresAt > now) { open++; openEscrow += r.amountAtomics || 0; }
		if (r.status === 'settled') { settled++; paidOut += r.amountAtomics || 0; }
	}
	return { open, openEscrowAtomics: openEscrow, settled, paidOutAtomics: paidOut, total: real.length };
}

/** Top grinders by total USDC earned (the leaderboard). */
export async function topGrinders(limit = 10) {
	const n = Math.max(1, Math.min(50, Number(limit) || 10));
	const redis = getRedis();
	if (redis) {
		const rows = await redis.zrange(K.leaderboard, 0, n - 1, { rev: true, withScores: true });
		// withScores returns a flat [member, score, member, score, …] array.
		const out = [];
		for (let i = 0; i < rows.length; i += 2) {
			out.push({ workerId: String(rows[i]), earnedAtomics: Number(rows[i + 1]) || 0 });
		}
		return out;
	}
	// Memory fallback: aggregate from settled records.
	const tally = new Map();
	for (const r of mem.values()) {
		if (r.status === 'settled' && r.payoutTx && r.winnerWorkerId) {
			tally.set(r.winnerWorkerId, (tally.get(r.winnerWorkerId) || 0) + (r.amountAtomics || 0));
		}
	}
	return [...tally.entries()]
		.map(([workerId, earnedAtomics]) => ({ workerId, earnedAtomics }))
		.sort((a, b) => b.earnedAtomics - a.earnedAtomics)
		.slice(0, n);
}

function parse(raw) {
	if (!raw) return null;
	if (typeof raw === 'object') return raw; // Upstash auto-deserializes JSON
	try { return JSON.parse(raw); } catch { return null; }
}

// Test-only: reset the in-memory fallback between specs.
export function __resetMemoryStore() {
	mem.clear();
}

export { PUBLIC_FIELDS };
