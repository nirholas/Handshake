// Premium vanity inventory — the Postgres store.
//
// The security-critical surface. Everything that reads or mutates the
// `vanity_inventory` table lives here so the single-use delivery contract is
// enforced in ONE place, as atomic status-guarded UPDATEs the database
// serializes — never as read-then-write logic a race could double-spend.
//
// State machine (see the migration for the CHECK):
//   available ──reserve──▶ reserved ──reveal──▶ revealed ──destroy──▶ destroyed
// A reveal is a single atomic UPDATE that flips reserved→revealed and RETURNS the
// ciphertext in the same statement. A second reveal matches zero rows (status is
// no longer 'reserved'/'sold'), so the secret is delivered exactly once. Delete-
// after-reveal (retention_days = 0, the default) nulls the ciphertext in that
// same reveal, so it is gone the instant it is served.
//
// PUBLIC vs SECRET: every public read (listing, item detail) selects an explicit
// column list that OMITS secret_ciphertext. Only reserveAndReveal() ever touches
// the ciphertext, and it returns it to the caller (the delivery endpoint) exactly
// once, then this module never surfaces it again.

import { sql, isDbUnavailableError } from './db.js';

// Columns that are safe to expose publicly (never includes secret_ciphertext).
const PUBLIC_COLS = sql`
	id, address, prefix, suffix, ignore_case, pattern_label, format,
	difficulty_attempts, rarity_bits, rarity_tier, rarity_score,
	status, price_usd, created_at
`;

function shapePublic(row) {
	if (!row) return null;
	return {
		id: row.id,
		address: row.address,
		prefix: row.prefix,
		suffix: row.suffix,
		ignoreCase: row.ignore_case,
		patternLabel: row.pattern_label,
		format: row.format,
		difficultyAttempts: Number(row.difficulty_attempts),
		rarityBits: Number(row.rarity_bits),
		rarityTier: row.rarity_tier,
		rarityScore: Number(row.rarity_score),
		status: row.status,
		priceUsd: Number(row.price_usd),
		createdAt: row.created_at,
	};
}

/**
 * Upsert a freshly-ground inventory item. Idempotent on `address` — a re-run of a
 * batch that re-finds an address is a safe no-op (never overwrites a sold row or
 * re-exposes a destroyed one). The caller (workers/vanity-grinder) has ALREADY
 * sealed the secret via api/_lib/vanity-vault.js; this function only ever sees
 * ciphertext.
 *
 * @param {object} item
 * @returns {Promise<{ inserted:boolean, address:string }>}
 */
export async function upsertInventoryItem(item) {
	const {
		address,
		prefix = null,
		suffix = null,
		ignoreCase = false,
		patternLabel,
		format = 'keypair',
		difficultyAttempts = 0,
		rarityBits = 0,
		rarityTier = 'common',
		rarityScore = 0,
		secretCiphertext,
		secretScheme = 'aes-256-gcm',
		priceUsd = 1,
		retentionDays = 0,
		batchId = null,
	} = item;

	if (!address) throw new Error('upsertInventoryItem: address required');
	if (!secretCiphertext) throw new Error('upsertInventoryItem: sealed secret required');
	if (secretCiphertext.includes('"secretKey"') || /^\[?\s*\d+\s*,\s*\d+/.test(secretCiphertext)) {
		// Guard against a caller accidentally passing a plaintext key. The vault
		// ciphertext is always a scheme-prefixed opaque blob, never raw JSON/array.
		throw new Error('upsertInventoryItem: refusing to store what looks like a plaintext secret');
	}

	const [row] = await sql`
		INSERT INTO vanity_inventory
			(address, prefix, suffix, ignore_case, pattern_label, format,
			 difficulty_attempts, rarity_bits, rarity_tier, rarity_score,
			 secret_ciphertext, secret_scheme, price_usd, retention_days, batch_id)
		VALUES
			(${address}, ${prefix}, ${suffix}, ${ignoreCase}, ${patternLabel}, ${format},
			 ${String(difficultyAttempts)}, ${rarityBits}, ${rarityTier}, ${rarityScore},
			 ${secretCiphertext}, ${secretScheme}, ${priceUsd}, ${retentionDays}, ${batchId})
		ON CONFLICT (address) DO NOTHING
		RETURNING id
	`;
	return { inserted: Boolean(row), address };
}

/**
 * Browse available inventory (public metadata only). Optional pattern filter and
 * ordering. Never returns ciphertext.
 *
 * @param {object} [opts]
 * @param {string} [opts.prefix]  case-insensitive prefix filter
 * @param {string} [opts.tier]    rarity tier filter
 * @param {'rarity'|'price'|'new'} [opts.sort]
 * @param {number} [opts.limit]
 * @param {number} [opts.offset]
 * @returns {Promise<object[]>}
 */
export async function listAvailable(opts = {}) {
	const { prefix, tier, sort = 'rarity', limit = 60, offset = 0 } = opts;
	const lim = Math.min(Math.max(1, Number(limit) || 60), 200);
	const off = Math.max(0, Number(offset) || 0);

	let where = sql`status = 'available'`;
	if (prefix) where = sql`${where} AND lower(prefix) LIKE ${String(prefix).toLowerCase() + '%'}`;
	if (tier) where = sql`${where} AND rarity_tier = ${String(tier)}`;

	let order;
	if (sort === 'price') order = sql`price_usd ASC, rarity_score DESC`;
	else if (sort === 'new') order = sql`created_at DESC`;
	else order = sql`rarity_score DESC, price_usd DESC`;

	const rows = await sql`
		SELECT ${PUBLIC_COLS} FROM vanity_inventory
		WHERE ${where}
		ORDER BY ${order}
		LIMIT ${lim} OFFSET ${off}
	`;
	return rows.map(shapePublic);
}

/** Public detail for one address (metadata only, any status). */
export async function getPublicItem(address) {
	const [row] = await sql`
		SELECT ${PUBLIC_COLS} FROM vanity_inventory WHERE address = ${address} LIMIT 1
	`;
	return shapePublic(row);
}

/** Aggregate counts + price range for the listing header / stats strip. */
export async function inventoryStats() {
	const [row] = await sql`
		SELECT
			count(*) FILTER (WHERE status = 'available')                    AS available,
			count(*) FILTER (WHERE status IN ('revealed','sold','destroyed')) AS sold,
			count(*)                                                        AS total,
			coalesce(min(price_usd) FILTER (WHERE status = 'available'), 0) AS min_price,
			coalesce(max(price_usd) FILTER (WHERE status = 'available'), 0) AS max_price,
			count(DISTINCT rarity_tier) FILTER (WHERE status = 'available') AS tiers
		FROM vanity_inventory
	`;
	return {
		available: Number(row?.available || 0),
		sold: Number(row?.sold || 0),
		total: Number(row?.total || 0),
		minPrice: Number(row?.min_price || 0),
		maxPrice: Number(row?.max_price || 0),
		tiers: Number(row?.tiers || 0),
	};
}

/**
 * Every distinct target pattern that still has stock ON THE SHELF.
 *
 * The batch grinder (workers/vanity-grinder) runs on ephemeral spot tasks whose
 * local checkpoint file dies with the container, so a restart used to re-grind
 * patterns that were already sitting in this table. This is the durable resume
 * signal: the grinder seeds its completed-set from here and skips those targets.
 *
 * Deliberately filtered to `available` rather than "ever ground": a pattern that
 * sold out is exactly what the replenish cron wants ground again.
 *
 * @returns {Promise<Array<{prefix:string|null, suffix:string|null, ignoreCase:boolean, count:number}>>}
 */
export async function availableTargetPatterns() {
	const rows = await sql`
		SELECT prefix, suffix, ignore_case, count(*) AS n
		FROM vanity_inventory
		WHERE status = 'available'
		GROUP BY prefix, suffix, ignore_case
	`;
	return rows.map((row) => ({
		prefix: row.prefix,
		suffix: row.suffix,
		ignoreCase: Boolean(row.ignore_case),
		count: Number(row.n || 0),
	}));
}

/**
 * Atomically reserve an available item for a paying buyer. This is the FIRST half
 * of purchase: it flips available→reserved only if the row is still available, so
 * two concurrent buyers of the same address can never both win. Idempotent per
 * payment_id: if the SAME payment already reserved this address, it re-selects
 * that reservation instead of failing (a retried/settled payment is not a
 * conflict).
 *
 * @returns {Promise<{ ok:true, item:object } | { ok:false, reason:string }>}
 */
export async function reserveForPurchase(address, { paymentId, purchaser }) {
	if (!address) return { ok: false, reason: 'address required' };
	const [row] = await sql`
		UPDATE vanity_inventory
		SET status = 'reserved',
		    payment_id = ${paymentId || null},
		    purchaser = ${purchaser || null},
		    reserved_at = now(),
		    updated_at = now()
		WHERE address = ${address} AND status = 'available'
		RETURNING ${PUBLIC_COLS}
	`;
	if (row) return { ok: true, item: shapePublic(row) };

	// Not available — either already reserved by THIS payment (idempotent retry),
	// already revealed/sold, or gone. Distinguish so the caller returns the right
	// state instead of a blanket conflict.
	const [existing] = await sql`
		SELECT ${PUBLIC_COLS}, payment_id FROM vanity_inventory WHERE address = ${address} LIMIT 1
	`;
	if (!existing) return { ok: false, reason: 'not_found' };
	if (paymentId && existing.payment_id === paymentId && ['reserved', 'sold'].includes(existing.status)) {
		return { ok: true, item: shapePublic(existing) };
	}
	return { ok: false, reason: existing.status === 'available' ? 'race' : 'unavailable', status: existing.status };
}

/**
 * The one-shot reveal — the function the delivery endpoint calls.
 *
 * Postgres cannot both null a column AND return its pre-null value in one plain
 * UPDATE … RETURNING, so this is an atomic CTE: `moved` captures the row (FOR
 * UPDATE), `revealed` flips its status and nulls the ciphertext per retention,
 * and the final SELECT returns the ciphertext captured in `moved` BEFORE the
 * null-out. The `secret_ciphertext IS NOT NULL` + status guard in `moved` makes
 * the whole thing single-use: a second call captures zero rows and returns
 * `already_revealed`. On retention_days = 0 (delete-after-reveal, the default)
 * the ciphertext is destroyed in the same statement that serves it.
 *
 * Guarded by payment_id: only the payment that reserved the row can reveal it.
 *
 * @returns {Promise<{ ok:true, ciphertext:string, scheme:string, item:object, destroyed:boolean }
 *                   | { ok:false, reason:string, status?:string }>}
 */
export async function reserveAndReveal(address, { paymentId }) {
	if (!address) return { ok: false, reason: 'address required' };
	if (!paymentId) return { ok: false, reason: 'payment_id required' };

	const rows = await sql`
		WITH moved AS (
			SELECT id, secret_ciphertext, secret_scheme, retention_days
			FROM vanity_inventory
			WHERE address = ${address}
			  AND payment_id = ${paymentId}
			  AND status IN ('reserved', 'sold')
			  AND secret_ciphertext IS NOT NULL
			FOR UPDATE
		),
		revealed AS (
			UPDATE vanity_inventory v
			SET status = CASE WHEN v.retention_days = 0 THEN 'destroyed' ELSE 'revealed' END,
			    revealed_at = now(),
			    sold_at = coalesce(v.sold_at, now()),
			    secret_ciphertext = CASE WHEN v.retention_days = 0 THEN NULL ELSE v.secret_ciphertext END,
			    destroyed_at = CASE WHEN v.retention_days = 0 THEN now() ELSE v.destroyed_at END,
			    updated_at = now()
			FROM moved
			WHERE v.id = moved.id
			RETURNING v.address, v.prefix, v.suffix, v.ignore_case, v.pattern_label, v.format,
			          v.difficulty_attempts, v.rarity_bits, v.rarity_tier, v.rarity_score,
			          v.status, v.price_usd, v.created_at, v.id
		)
		SELECT
			moved.secret_ciphertext AS ciphertext,
			moved.secret_scheme     AS scheme,
			moved.retention_days    AS retention_days,
			revealed.*
		FROM moved JOIN revealed ON revealed.id = moved.id
	`;
	const row = rows[0];
	if (!row) {
		const [cur] = await sql`SELECT status, payment_id FROM vanity_inventory WHERE address = ${address} LIMIT 1`;
		if (!cur) return { ok: false, reason: 'not_found' };
		if (['revealed', 'destroyed'].includes(cur.status)) return { ok: false, reason: 'already_revealed' };
		if (paymentId && cur.payment_id && cur.payment_id !== paymentId) return { ok: false, reason: 'wrong_payment' };
		return { ok: false, reason: 'not_reserved', status: cur.status };
	}
	return {
		ok: true,
		ciphertext: row.ciphertext,
		scheme: row.scheme,
		destroyed: Number(row.retention_days) === 0,
		item: shapePublic(row),
	};
}

/**
 * Instant-inventory fast path: atomically find AND claim one available item
 * whose actual `address` satisfies a requested prefix/suffix pattern, so the
 * live-grind endpoints (api/x402/vanity.js, api/x402/pump-launch.js) can
 * serve a pre-ground key instead of grinding one. Matching runs against the
 * real address text (case-folded per `ignoreCase`), not the item's own
 * stored prefix/suffix label — a longer pre-ground item ("Solana…") also
 * satisfies a shorter request ("So"), which is the whole point of turning
 * spare inventory into instant delivery for the cheap live-grind tier.
 *
 * `maxPriceUsd` is the economics guardrail: the live grinder charges a flat
 * per-length fee (a few cents), while inventory items can be worth up to $50.
 * Without this cap, a $0.05 request could accidentally match — and give
 * away — a rare item that should only ever sell through the priced premium
 * tier (api/x402/vanity-premium.js). Passing `maxPriceUsd` restricts the
 * candidate set to items worth no more than what the buyer is already
 * paying, so instant delivery is strictly a latency win, never a discount.
 * Omit it (pump-launch's flat-fee upsell) to allow any matching item.
 *
 * `FOR UPDATE SKIP LOCKED` inside the id subquery is the same idiom used by
 * claimRegenJobs() (api/_lib/x402/thumbnail-regen.js): it makes the claim
 * safe under concurrent callers racing for the same last matching row — one
 * wins the row, the other's subquery skips the locked row and (if no other
 * candidate exists) claims nothing, so the same address is never reserved
 * twice.
 *
 * @param {object} opts
 * @param {string} [opts.prefix]
 * @param {string} [opts.suffix]
 * @param {boolean} [opts.ignoreCase]
 * @param {string} [opts.format='keypair']
 * @param {number} [opts.maxPriceUsd] optional price ceiling in USD
 * @param {string} opts.paymentId
 * @param {string} [opts.purchaser]
 * @returns {Promise<{ ok:true, item:object } | { ok:false, reason:string }>}
 */
export async function claimMatchingPattern({
	prefix = '',
	suffix = '',
	ignoreCase = false,
	format = 'keypair',
	maxPriceUsd,
	paymentId,
	purchaser,
}) {
	if (!paymentId) return { ok: false, reason: 'payment_id_required' };
	const pfx = String(prefix || '');
	const sfx = String(suffix || '');
	if (!pfx && !sfx) return { ok: false, reason: 'no_pattern' };

	let where = sql`status = 'available' AND format = ${format}`;
	if (pfx) {
		where = ignoreCase
			? sql`${where} AND lower(left(address, ${pfx.length})) = ${pfx.toLowerCase()}`
			: sql`${where} AND left(address, ${pfx.length}) = ${pfx}`;
	}
	if (sfx) {
		where = ignoreCase
			? sql`${where} AND lower(right(address, ${sfx.length})) = ${sfx.toLowerCase()}`
			: sql`${where} AND right(address, ${sfx.length}) = ${sfx}`;
	}
	if (maxPriceUsd != null) where = sql`${where} AND price_usd <= ${maxPriceUsd}`;

	const rows = await sql`
		UPDATE vanity_inventory
		   SET status = 'reserved', payment_id = ${paymentId}, purchaser = ${purchaser || null},
		       reserved_at = now(), updated_at = now()
		 WHERE id IN (
		         SELECT id FROM vanity_inventory
		          WHERE ${where}
		          ORDER BY created_at ASC
		          LIMIT 1
		          FOR UPDATE SKIP LOCKED
		       )
		RETURNING ${PUBLIC_COLS}
	`;
	const row = rows[0];
	if (!row) return { ok: false, reason: 'no_match' };
	return { ok: true, item: shapePublic(row) };
}

/**
 * Read-only stock check: does an AVAILABLE item exist whose real address
 * satisfies this prefix/suffix pattern? Never reserves — used to quote the
 * premium long-pattern tier in api/x402/vanity.js honestly BEFORE issuing a
 * 402 (so a buyer is never asked to pay for a pattern that isn't in stock).
 * The actual claim (with claimMatchingPattern's FOR UPDATE SKIP LOCKED race
 * safety) only happens after payment verifies.
 *
 * @param {object} opts
 * @param {string} [opts.prefix]
 * @param {string} [opts.suffix]
 * @param {boolean} [opts.ignoreCase]
 * @param {string} [opts.format='keypair']
 * @returns {Promise<boolean>}
 */
export async function hasAvailableMatch({ prefix = '', suffix = '', ignoreCase = false, format = 'keypair' }) {
	const pfx = String(prefix || '');
	const sfx = String(suffix || '');
	if (!pfx && !sfx) return false;

	let where = sql`status = 'available' AND format = ${format}`;
	if (pfx) {
		where = ignoreCase
			? sql`${where} AND lower(left(address, ${pfx.length})) = ${pfx.toLowerCase()}`
			: sql`${where} AND left(address, ${pfx.length}) = ${pfx}`;
	}
	if (sfx) {
		where = ignoreCase
			? sql`${where} AND lower(right(address, ${sfx.length})) = ${sfx.toLowerCase()}`
			: sql`${where} AND right(address, ${sfx.length}) = ${sfx}`;
	}
	const [row] = await sql`SELECT 1 FROM vanity_inventory WHERE ${where} LIMIT 1`;
	return Boolean(row);
}

/**
 * Non-destructive read of the sealed ciphertext for a row reserved by THIS
 * payment. The delivery endpoint calls this AFTER reserve but BEFORE settle to
 * prove it can actually decrypt (e.g. KMS reachable) before charging the buyer —
 * so a decrypt outage fails the purchase cleanly instead of settling and then
 * being unable to deliver. Only ever returns ciphertext for a row this payment
 * already reserved (so it's already unavailable to anyone else); does not change
 * state, so single-use delivery is still enforced solely by reserveAndReveal().
 *
 * @returns {Promise<{ ok:true, ciphertext:string, scheme:string }
 *                   | { ok:false, reason:string }>}
 */
export async function peekReservedSecret(address, { paymentId }) {
	if (!address || !paymentId) return { ok: false, reason: 'address + payment_id required' };
	const [row] = await sql`
		SELECT secret_ciphertext, secret_scheme FROM vanity_inventory
		WHERE address = ${address} AND payment_id = ${paymentId}
		  AND status IN ('reserved', 'sold') AND secret_ciphertext IS NOT NULL
		LIMIT 1
	`;
	if (!row) return { ok: false, reason: 'not_reserved_or_gone' };
	return { ok: true, ciphertext: row.secret_ciphertext, scheme: row.secret_scheme };
}

/**
 * Sweep: destroy ciphertext for revealed items whose retention window has passed.
 * Run from scripts/vanity-inventory-load.mjs --sweep (or a cron). Idempotent.
 * @returns {Promise<{ destroyed:number }>}
 */
export async function sweepExpiredSecrets() {
	const rows = await sql`
		UPDATE vanity_inventory
		SET secret_ciphertext = NULL,
		    status = 'destroyed',
		    destroyed_at = now(),
		    updated_at = now()
		WHERE status = 'revealed'
		  AND retention_days > 0
		  AND secret_ciphertext IS NOT NULL
		  AND revealed_at < now() - (retention_days * interval '1 day')
		RETURNING id
	`;
	return { destroyed: rows.length };
}

/**
 * Release a reservation back to available. Called if payment settlement fails
 * AFTER a reserve but BEFORE reveal, so a stuck reservation doesn't strand
 * sellable stock. Guarded by payment_id so only the reserving payment can release.
 */
export async function releaseReservation(address, { paymentId }) {
	const [row] = await sql`
		UPDATE vanity_inventory
		SET status = 'available', payment_id = NULL, purchaser = NULL,
		    reserved_at = NULL, updated_at = now()
		WHERE address = ${address} AND status = 'reserved' AND payment_id = ${paymentId}
		RETURNING id
	`;
	return { released: Boolean(row) };
}

export { isDbUnavailableError };
