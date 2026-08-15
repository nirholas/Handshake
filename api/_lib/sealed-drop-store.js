/**
 * Persistence + atomic claim ledger for sealed wallet drops.
 *
 * A drop is a pre-funded Solana wallet sealed (ECIES) to a recipient and handed
 * out by link / QR / 3D agent. This store holds the drop record and runs the
 * single, atomic state machine that makes a drop claimable EXACTLY ONCE, by the
 * holder of the claim secret, or reclaimable by the sender after expiry, never
 * both. Mirrors vanity-bounty-store.js: Upstash Redis when configured, an
 * in-process Map fallback otherwise (local/CI works; a Redis outage degrades).
 *
 * ── Operator-blind by construction ───────────────────────────────────────────
 * A stored drop NEVER holds a plaintext private key or seed. It holds only:
 *   • the public funded `address`,
 *   • the SEALED envelope (opaque ECIES ciphertext addressed to the recipient),
 *   • the recipient's PUBLIC X25519 key (direct mode) or the claim PUBLIC key
 *     + the one-way `claimTokenHash` (claim-time mode).
 * The operator therefore cannot open any wallet it stores or brokers. The public
 * projection (`toPublicDrop`) additionally strips the sealed envelope so it is
 * only ever released through the gated claim/reveal path.
 *
 * ── The create fee lands before the drop does ────────────────────────────────
 * A drop is born `escrow_pending`: recorded, but in NO index, and refused by the
 * claim, reveal and reclaim paths. Only `activateDrop` (called once the x402
 * create fee has really settled) flips it to `funded` and indexes it. A fee that
 * fails to settle voids the drop (`voidDrop`) after its on-chain funding is swept
 * back, so nobody can walk away with a wallet the platform funded for free.
 *
 * ── Atomic single-claim state machine ────────────────────────────────────────
 *   escrow_pending ─fee settled─▶ funded  (activateDrop; void otherwise)
 *   funded ──claim(token)──▶ claimed     (compare-and-set, idempotent on token)
 *          └─expiry+reclaim─▶ reclaimed   (compare-and-set, sender-only, mutex)
 * A Lua compare-and-set flips status and records the claimer/reclaimer, and
 * returns "won" ONLY to the first caller. A claimed drop can never be reclaimed
 * and vice versa. Idempotency: re-presenting the SAME claim token after a claim
 * returns "won" again (so a retried release isn't a re-race); reclaim after a
 * reclaim returns "reclaimable" again.
 *
 * Layout (Redis):
 *   HASH  vanity:drop:rec            field=id → JSON(drop record)
 *   ZSET  vanity:drop:by-recency     member=id  score=createdAt(ms)
 *   ZSET  vanity:drop:funded         member=id  score=expiresAt(ms)   (live, reclaim sweep)
 *   ZSET  vanity:drop:by-sender      member=id  score=createdAt(ms)   (sender index, per senderTag)
 */

import { getRedis } from './redis.js';

const NS = 'vanity:drop';
const K = {
	rec: `${NS}:rec`,
	byRecency: `${NS}:by-recency`,
	funded: `${NS}:funded`,
	sender: (tag) => `${NS}:by-sender:${tag}`,
};

const MAX_SCAN = 500;

// Statuses a drop holds before (or instead of) becoming a real, claimable gift.
const TRANSIENT_STATUSES = Object.freeze(['escrow_pending', 'void']);

/** True for a drop that has not (or will never) go live. */
export function isTransientDrop(rec) {
	return !!rec && TRANSIENT_STATUSES.includes(rec.status);
}

// Public projection: the sealed envelope + claim-token hash + funding tx detail
// stay private. The privacy boundary: the envelope is released only by the gated
// claim/reveal path, never on a list or status read.
const PUBLIC_FIELDS = Object.freeze([
	'id', 'protocol', 'address', 'asset', 'amount', 'amountAtomics', 'network',
	'sealMode', 'status', 'message', 'theme', 'senderLabel', 'vanity',
	'createdAt', 'expiresAt', 'claimedAt', 'reclaimedAt', 'fundingConfirmed',
	'recipient', 'irlPinId', 'roomId',
]);

const mem = new Map(); // id → record (fallback store)

/** Project a record to its public shape (no sealed envelope, no token hash, no tx). */
export function toPublicDrop(rec) {
	if (!rec || typeof rec !== 'object') return null;
	const out = {};
	for (const k of PUBLIC_FIELDS) if (rec[k] !== undefined) out[k] = rec[k];
	if (!out.id) return null;
	return out;
}

function parse(raw) {
	if (!raw) return null;
	if (typeof raw === 'object') return raw; // Upstash auto-deserializes JSON
	try { return JSON.parse(raw); } catch { return null; }
}

/**
 * Record a drop, claiming the id atomically (hsetnx) so a collision can't repoint
 * the indexes at an existing record.
 *
 * Pass `status: 'escrow_pending'` (what api/vanity/drops.js does) to record it
 * WITHOUT indexing: the drop is invisible to the sender list and the reclaim
 * sweep, and the claim/reveal/reclaim paths refuse it, until `activateDrop`
 * confirms the create fee settled. `funded` indexes immediately, which is only
 * correct once the fee is collected.
 *
 * @param {object} rec - fully-formed drop record (see api/vanity/drops.js).
 * @returns {Promise<object>} the stored record.
 */
export async function createDrop(rec) {
	const record = { ...rec, status: rec.status || 'funded' };
	const redis = getRedis();
	if (redis) {
		const created = await redis.hsetnx(K.rec, record.id, JSON.stringify(record));
		if (created === 0 || created === false) {
			throw Object.assign(new Error('drop id collision'), { status: 409, code: 'duplicate_drop' });
		}
		if (record.status === 'funded') await indexDrop(redis, record);
	} else {
		if (mem.has(record.id)) {
			throw Object.assign(new Error('drop id collision'), { status: 409, code: 'duplicate_drop' });
		}
		mem.set(record.id, record);
	}
	return record;
}

/** Add a live drop to the recency / reclaim-sweep / sender indexes. */
async function indexDrop(redis, record) {
	const pipe = redis.multi();
	pipe.zadd(K.byRecency, { score: record.createdAt, member: record.id });
	pipe.zadd(K.funded, { score: record.expiresAt, member: record.id });
	if (record.senderTag) pipe.zadd(K.sender(record.senderTag), { score: record.createdAt, member: record.id });
	await pipe.exec();
}

/**
 * Flip a pending drop live now that its x402 create fee settled, recording the
 * settlement tx as the audit trail and indexing it in the same step. Idempotent:
 * re-activating an already-funded drop is a no-op that still reports 'live'.
 *
 * Read-modify-write is safe here (no compare-and-set Lua needed): a pending drop's
 * id exists only inside the one create request that minted it, so this transition
 * has exactly one writer. Every LATER transition (claim, reclaim) is contended and
 * does use an atomic compare-and-set.
 *
 * @param {object} p
 * @param {string} p.id
 * @param {string} [p.escrowTx] - the x402 settlement transaction.
 * @returns {Promise<'live'|'ineligible'|'missing'>}
 */
export async function activateDrop({ id, escrowTx }) {
	const rec = await getDropRecord(id);
	if (!rec) return 'missing';
	if (rec.status === 'funded') return 'live';
	if (rec.status !== 'escrow_pending') return 'ineligible';
	const next = { ...rec, status: 'funded', escrowTx: escrowTx || '', escrowSettledAt: Date.now() };
	const redis = getRedis();
	if (redis) {
		// Status first, then the indexes: a reader that races us either misses the
		// drop entirely or finds one already marked funded, never a pending record
		// sitting in the claim/sweep indexes.
		await redis.hset(K.rec, { [next.id]: JSON.stringify(next) });
		await indexDrop(redis, next);
	} else {
		mem.set(String(id), next);
	}
	return 'live';
}

/**
 * Void a pending drop whose create fee never settled, so it can never be claimed,
 * revealed, or swept as a live drop. Idempotent.
 *
 * @param {object} p
 * @param {string} p.id
 * @param {string} [p.reason] - why the fee never landed (audit trail).
 * @returns {Promise<'void'|'ineligible'|'missing'>}
 */
export async function voidDrop({ id, reason }) {
	const rec = await getDropRecord(id);
	if (!rec) return 'missing';
	if (rec.status === 'void') return 'void';
	if (rec.status !== 'escrow_pending') return 'ineligible';
	const next = { ...rec, status: 'void', voidedAt: Date.now(), voidReason: reason || '' };
	const redis = getRedis();
	if (redis) await redis.hset(K.rec, { [next.id]: JSON.stringify(next) });
	else mem.set(String(id), next);
	return 'void';
}

/** Full internal record by id (includes sealed envelope + token hash). */
export async function getDropRecord(id) {
	const key = String(id || '');
	if (!key) return null;
	const redis = getRedis();
	if (redis) return parse(await redis.hget(K.rec, key));
	return mem.get(key) || null;
}

/** Public view by id. */
export async function getDrop(id) {
	return toPublicDrop(await getDropRecord(id));
}

// Atomic funded→claimed compare-and-set. Idempotent on claimerTag (the digest of
// the presented claim token): re-presenting the SAME token after a claim returns
// 1 again (so a retried envelope release doesn't re-race). A claim on an already-
// reclaimed/expired drop returns -1. Returns 1=won, 0=lost(claimed by other),
// -1=not-claimable(reclaimed/expired), -2=missing.
const CLAIM_LUA = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then return -2 end
local rec = cjson.decode(raw)
if rec.status == 'claimed' then
  if rec.claimerTag == ARGV[2] then return 1 else return 0 end
end
if rec.status ~= 'funded' then return -1 end
local now = tonumber(ARGV[4])
if rec.expiresAt and now > tonumber(rec.expiresAt) then return -1 end
rec.status = 'claimed'
rec.claimerTag = ARGV[2]
rec.claimedAt = now
rec.claimRecipient = ARGV[3]
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(rec))
redis.call('ZREM', KEYS[2], ARGV[1])
return 1
`;

/**
 * Atomically claim a drop. The FIRST valid claim (proven possession of the claim
 * token) wins; later ones lose. Idempotent on claimerTag. Does NOT release the
 * envelope itself: the caller reads the record after a `won` and returns the
 * sealed envelope, so a release error can be retried without re-racing.
 *
 * @param {object} p
 * @param {string} p.id
 * @param {string} p.claimerTag - one-way digest tying this claim to its token.
 * @param {string} [p.claimRecipient] - optional recipient pubkey the holder re-sealed to (audit).
 * @returns {Promise<'won'|'lost'|'closed'|'missing'>}
 */
export async function claimDrop({ id, claimerTag, claimRecipient }) {
	const now = Date.now();
	const redis = getRedis();
	if (redis) {
		const r = await redis.eval(
			CLAIM_LUA,
			[K.rec, K.funded],
			[String(id), String(claimerTag), String(claimRecipient || ''), String(now)],
		);
		return claimCode(Number(r));
	}
	const rec = mem.get(String(id));
	if (!rec) return 'missing';
	if (rec.status === 'claimed') return rec.claimerTag === claimerTag ? 'won' : 'lost';
	if (rec.status !== 'funded') return 'closed';
	if (rec.expiresAt && now > rec.expiresAt) return 'closed';
	rec.status = 'claimed';
	rec.claimerTag = claimerTag;
	rec.claimedAt = now;
	rec.claimRecipient = claimRecipient || '';
	mem.set(String(id), rec);
	return 'won';
}

function claimCode(n) {
	if (n === 1) return 'won';
	if (n === 0) return 'lost';
	if (n === -2) return 'missing';
	return 'closed';
}

// Atomic funded→reclaimed compare-and-set, only for EXPIRED drops. Mutually
// exclusive with claim: a claimed drop can never be reclaimed and vice versa.
// Idempotent: re-running on an already-reclaimed drop returns 1. Returns
// 1=reclaimable(now reclaimed), 0=not-eligible, -2=missing.
const RECLAIM_LUA = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then return -2 end
local rec = cjson.decode(raw)
if rec.status == 'reclaimed' then return 1 end
if rec.status ~= 'funded' then return 0 end
local now = tonumber(ARGV[2])
if not rec.expiresAt or now <= tonumber(rec.expiresAt) then return 0 end
rec.status = 'reclaimed'
rec.reclaimedAt = now
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(rec))
redis.call('ZREM', KEYS[2], ARGV[1])
return 1
`;

/**
 * Atomically mark an EXPIRED, unclaimed drop as reclaimed so its funds can be
 * swept back to the sender exactly once. Mutually exclusive with claimDrop.
 * @param {string} id
 * @returns {Promise<'reclaimable'|'ineligible'|'missing'>}
 */
export async function markReclaimable(id) {
	const now = Date.now();
	const redis = getRedis();
	if (redis) {
		const r = Number(await redis.eval(RECLAIM_LUA, [K.rec, K.funded], [String(id), String(now)]));
		if (r === 1) return 'reclaimable';
		if (r === -2) return 'missing';
		return 'ineligible';
	}
	const rec = mem.get(String(id));
	if (!rec) return 'missing';
	if (rec.status === 'reclaimed') return 'reclaimable';
	if (rec.status !== 'funded') return 'ineligible';
	if (!rec.expiresAt || now <= rec.expiresAt) return 'ineligible';
	rec.status = 'reclaimed';
	rec.reclaimedAt = now;
	mem.set(String(id), rec);
	return 'reclaimable';
}

/** Record the on-chain reclaim sweep tx after a successful reclaim (idempotent set). */
export async function recordReclaim({ id, reclaimTx }) {
	const rec = await getDropRecord(id);
	if (!rec) return null;
	rec.reclaimTx = reclaimTx;
	rec.reclaimAt = Date.now();
	const redis = getRedis();
	if (redis) await redis.hset(K.rec, { [id]: JSON.stringify(rec) });
	else mem.set(id, rec);
	return rec;
}

/** Record the claimer's re-seal recipient + a delivery note after the envelope is released (audit). */
export async function recordClaimDelivery({ id, claimRecipient }) {
	const rec = await getDropRecord(id);
	if (!rec) return null;
	if (claimRecipient) rec.claimRecipient = claimRecipient;
	rec.deliveredAt = Date.now();
	const redis = getRedis();
	if (redis) await redis.hset(K.rec, { [id]: JSON.stringify(rec) });
	else mem.set(id, rec);
	return rec;
}

/**
 * List a sender's drops (newest first), public projection. `senderTag` is an
 * opaque, non-PII tag the creator chooses (e.g. a hash of their session) so they
 * can find their drops to reclaim: it is never required and never exposed.
 * @param {string} senderTag
 * @param {number} [limit=50]
 */
export async function listBySender(senderTag, limit = 50) {
	const tag = String(senderTag || '').trim();
	if (!tag) return [];
	const n = Math.max(1, Math.min(100, Number(limit) || 50));
	const redis = getRedis();
	if (redis) {
		const members = await redis.zrange(K.sender(tag), 0, n - 1, { rev: true });
		if (!members.length) return [];
		const raw = await redis.hmget(K.rec, ...members);
		return members.map((_, i) => parse(raw?.[i])).filter(Boolean).map(toPublicDrop);
	}
	return [...mem.values()]
		.filter((r) => r.senderTag === tag && !isTransientDrop(r))
		.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
		.slice(0, n)
		.map(toPublicDrop);
}

/** Expired, still-funded drops (oldest expiry first), the reclaim sweep queue. */
export async function listReclaimable(limit = 50) {
	const now = Date.now();
	const n = Math.max(1, Math.min(100, Number(limit) || 50));
	const redis = getRedis();
	if (redis) {
		// Score is expiresAt; everything below `now` is expired and still funded.
		const members = await redis.zrange(K.funded, 0, now, { byScore: true });
		const slice = members.slice(0, n);
		if (!slice.length) return [];
		const raw = await redis.hmget(K.rec, ...slice);
		return slice.map((_, i) => parse(raw?.[i])).filter((r) => r && r.status === 'funded' && r.expiresAt <= now);
	}
	return [...mem.values()]
		.filter((r) => r.status === 'funded' && r.expiresAt && r.expiresAt <= now)
		.sort((a, b) => a.expiresAt - b.expiresAt)
		.slice(0, n);
}

/** Aggregate stats for the landing/explore surface. */
export async function dropStats() {
	const redis = getRedis();
	let recs;
	if (redis) {
		const all = await redis.hgetall(K.rec);
		recs = all ? Object.values(all).map(parse).filter(Boolean) : [];
	} else {
		recs = [...mem.values()];
	}
	const now = Date.now();
	// Pending/void drops never became gifts, so they count toward nothing, `total`
	// included, which is the number of drops the platform actually issued.
	const real = recs.filter((r) => !isTransientDrop(r));
	let funded = 0, claimed = 0, reclaimed = 0;
	for (const r of real) {
		if (r.status === 'claimed') claimed++;
		else if (r.status === 'reclaimed') reclaimed++;
		else if (r.status === 'funded' && (!r.expiresAt || r.expiresAt > now)) funded++;
	}
	return { funded, claimed, reclaimed, total: real.length };
}

// Test-only: reset the in-memory fallback between specs.
export function __resetMemoryStore() {
	mem.clear();
}

export { PUBLIC_FIELDS };
