#!/usr/bin/env node
/**
 * Reprice the vanity inventory under the corrected Base58 difficulty model.
 *
 * WHY
 * ---
 * Every rarity_bits / rarity_tier / rarity_score / price_usd in
 * `vanity_inventory` was computed with a model that assumed each Base58
 * character is uniform at 1/58. That is true for a suffix and false for the
 * leading character: Base58 encodes a 256-bit integer positionally, and
 * 2^256/58^43 ~= 17.05 means a 44-digit encoding can only ever lead with one of
 * the first 17 symbols. The alphabet splits into bands spanning 58x in
 * difficulty (see src/solana/vanity/base58-distribution.js).
 *
 * The consequence on the live book: the median available SKU was ~17x harder to
 * grind than its stored difficulty claimed (prefixes leading 'K'-'z', which is
 * most dictionary words), while prefixes leading '2'-'H' were up to 1.75x
 * easier. Since price is an exponential function of rarity bits, the book was
 * mispriced in both directions.
 *
 * WHAT IT TOUCHES
 * ---------------
 * Only rows with status='available', unsold stock. A sold or destroyed row
 * keeps the numbers it was transacted at; the price a buyer actually paid is a
 * fact about the past, not a value to recompute. Every touched row is stamped
 * difficulty_model='base58-exact/v2' so a partially-migrated book is visible.
 *
 * USAGE
 * -----
 *   node scripts/reprice-vanity-inventory.mjs             # dry run (default)
 *   node scripts/reprice-vanity-inventory.mjs --apply     # write
 *   node scripts/reprice-vanity-inventory.mjs --apply --backup out.json
 *
 * Requires DATABASE_URL.
 */

import { writeFileSync } from 'node:fs';
import { neon } from '@neondatabase/serverless';
import { computeRarity } from '../src/solana/vanity/rarity.js';
import { priceFromRarity } from '../api/_lib/vanity-inventory-pricing.js';
import { DIFFICULTY_MODEL } from '../src/solana/vanity/validation.js';

const apply = process.argv.includes('--apply');
const backupIdx = process.argv.indexOf('--backup');
const backupPath = backupIdx >= 0 ? process.argv[backupIdx + 1] : null;

const url = process.env.DATABASE_URL;
if (!url) {
	console.error('DATABASE_URL is required');
	process.exit(1);
}
const sql = neon(url);

const rows = await sql`
	SELECT id, address, prefix, suffix, ignore_case, status,
	       difficulty_attempts, rarity_bits, rarity_tier, rarity_score, price_usd
	  FROM vanity_inventory
	 WHERE status = 'available'
	 ORDER BY created_at
`;

const changes = [];
for (const row of rows) {
	const rarity = computeRarity({
		prefix: row.prefix || '',
		suffix: row.suffix || '',
		ignoreCase: row.ignore_case,
	});
	// An unreachable pattern would price to Infinity; such a row is data
	// corruption rather than a repricing target, so leave it for a human.
	if (!Number.isFinite(rarity.expectedAttempts)) {
		console.warn(`skipping ${row.address}: pattern is unreachable (${row.prefix}/${row.suffix})`);
		continue;
	}
	const { priceUsd } = priceFromRarity(rarity);
	const before = {
		attempts: Number(row.difficulty_attempts),
		bits: Number(row.rarity_bits),
		tier: row.rarity_tier,
		score: row.rarity_score,
		price: Number(row.price_usd),
	};
	const after = {
		attempts: rarity.expectedAttempts,
		bits: rarity.rarityBits,
		tier: rarity.tier,
		score: rarity.rarityScore,
		price: priceUsd,
	};
	if (
		before.attempts === after.attempts &&
		before.tier === after.tier &&
		before.price === after.price
	) {
		continue;
	}
	changes.push({ id: row.id, address: row.address, pattern: row.prefix || row.suffix, before, after });
}

const priceDelta = changes.reduce((sum, c) => sum + (c.after.price - c.before.price), 0);
const tierMoves = changes.filter((c) => c.before.tier !== c.after.tier).length;

console.log(`available rows      : ${rows.length}`);
console.log(`rows to reprice     : ${changes.length}`);
console.log(`tier changes        : ${tierMoves}`);
console.log(`book value delta    : ${priceDelta >= 0 ? '+' : ''}$${priceDelta.toFixed(2)}`);

const sorted = [...changes].sort((a, b) => b.after.price - b.before.price - (a.after.price - a.before.price));
console.log('\nlargest increases (understated difficulty):');
for (const c of sorted.slice(0, 6)) {
	console.log(
		`  ${String(c.pattern).padEnd(6)} $${c.before.price} -> $${c.after.price}  ` +
			`${c.before.tier} -> ${c.after.tier}  (${c.before.attempts} -> ${c.after.attempts} attempts)`,
	);
}
console.log('\nlargest decreases (overstated difficulty):');
for (const c of sorted.slice(-6).reverse()) {
	console.log(
		`  ${String(c.pattern).padEnd(6)} $${c.before.price} -> $${c.after.price}  ` +
			`${c.before.tier} -> ${c.after.tier}  (${c.before.attempts} -> ${c.after.attempts} attempts)`,
	);
}

if (backupPath) {
	writeFileSync(backupPath, JSON.stringify(changes, null, 2));
	console.log(`\nbackup of prior values written to ${backupPath}`);
}

if (!apply) {
	console.log('\nDRY RUN, re-run with --apply to write.');
	process.exit(0);
}

let written = 0;
for (const c of changes) {
	await sql`
		UPDATE vanity_inventory
		   SET difficulty_attempts = ${c.after.attempts},
		       rarity_bits         = ${c.after.bits},
		       rarity_tier         = ${c.after.tier},
		       rarity_score        = ${c.after.score},
		       price_usd           = ${c.after.price},
		       difficulty_model    = ${DIFFICULTY_MODEL},
		       updated_at          = now()
		 WHERE id = ${c.id}
		   AND status = 'available'
	`;
	written++;
}
console.log(`\napplied to ${written} rows, stamped ${DIFFICULTY_MODEL}`);
