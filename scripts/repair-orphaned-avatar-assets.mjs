#!/usr/bin/env node
/**
 * Find live avatars whose R2 objects are gone, and re-queue the recoverable ones.
 *
 * Why these exist: a copy, remix or forge variant points at the source avatar's
 * storage_key / thumbnail_key instead of duplicating the bytes, and deleteAvatar
 * used to delete those objects by key whenever ANY row holding them was removed.
 * That blanked live avatars sharing the key: a 404 GLB in the viewer, a broken
 * thumbnail in the gallery, /pulse and every agent card. api/_lib/avatars.js now
 * reference-counts before deleting, so no new orphans appear; this script cleans
 * up the ones already on disk.
 *
 * What it does:
 *   • Probes each candidate row's objects with a credentialed HEAD against the
 *     bucket (authoritative, not a public-URL guess).
 *   • --apply clears a dangling thumbnail_key. That is a repair, not a loss: a
 *     null thumbnail_key is exactly what api/_lib/avatar-thumbs.js claims, so
 *     the thumbnail cron re-renders the poster from the GLB on its next pass.
 *   • A dangling storage_key (the model itself) is REPORTED, never written. The
 *     bytes are unrecoverable from here and what to do with the row is the
 *     owner's call, not this script's.
 *
 * Usage (needs DATABASE_URL + S3_*, both in .env):
 *
 *   node --env-file=.env scripts/repair-orphaned-avatar-assets.mjs
 *   node --env-file=.env scripts/repair-orphaned-avatar-assets.mjs --apply
 *   node --env-file=.env scripts/repair-orphaned-avatar-assets.mjs --all --limit=2000
 *
 * Flags:
 *   --apply           clear dangling thumbnail_key values (default: dry run)
 *   --all             probe every live avatar, not just rows sharing a key with
 *                     a soft-deleted row (the population the delete bug hit)
 *   --limit=N         cap rows probed (default: no cap targeted, 2000 with --all)
 *   --concurrency=N   parallel HEAD probes (default 8)
 */

import { sql } from '../api/_lib/db.js';
import { headObject } from '../api/_lib/r2.js';

const argv = process.argv.slice(2);
const has = (name) => argv.includes(`--${name}`);
const num = (name, fallback) => {
	const hit = argv.find((a) => a.startsWith(`--${name}=`));
	const n = hit ? Number(hit.split('=')[1]) : NaN;
	return Number.isFinite(n) && n > 0 ? n : fallback;
};

const APPLY = has('apply');
const ALL = has('all');
const LIMIT = num('limit', ALL ? 2000 : 0);
const CONCURRENCY = Math.max(1, num('concurrency', 8));

// Keys that are already absolute URLs live outside the bucket (first-party
// /avatars/*.glb, externally hosted models). headObject returns null for them,
// which would read as "missing". Skip them instead of inventing a repair.
const isBucketKey = (k) => typeof k === 'string' && k.length > 0 && !/^https?:\/\//i.test(k);

async function candidates() {
	const rows = ALL
		? await sql`
				select id, name, visibility, storage_key, thumbnail_key
				  from avatars
				 where deleted_at is null
				 order by created_at desc
				 limit ${LIMIT}
			`
		: await sql`
				select id, name, visibility, storage_key, thumbnail_key
				  from avatars a
				 where a.deleted_at is null
				   and (
				     exists (select 1 from avatars b
				              where b.deleted_at is not null and b.storage_key = a.storage_key)
				     or exists (select 1 from avatars c
				                 where c.deleted_at is not null and c.thumbnail_key = a.thumbnail_key)
				   )
				 order by a.created_at desc
			`;
	return LIMIT && rows.length > LIMIT ? rows.slice(0, LIMIT) : rows;
}

// One HEAD per distinct key, memoised: sibling rows share keys by definition here.
const probed = new Map();
async function exists(key) {
	if (!isBucketKey(key)) return true;
	if (!probed.has(key)) probed.set(key, headObject(key).then((o) => o != null));
	return probed.get(key);
}

async function mapWithConcurrency(items, fn) {
	const out = new Array(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
			while (next < items.length) {
				const i = next++;
				out[i] = await fn(items[i]);
			}
		}),
	);
	return out;
}

async function main() {
	const rows = await candidates();
	console.log(
		`Probing ${rows.length} live avatar row(s) [${ALL ? 'all' : 'shared-key at-risk set'}], ` +
			`concurrency ${CONCURRENCY}, ${APPLY ? 'APPLY' : 'dry run'}`,
	);
	if (!rows.length) {
		console.log('Nothing to probe.');
		return;
	}

	const checked = await mapWithConcurrency(rows, async (r) => ({
		...r,
		modelMissing: !(await exists(r.storage_key)),
		thumbMissing: isBucketKey(r.thumbnail_key) ? !(await exists(r.thumbnail_key)) : false,
	}));

	const deadThumbs = checked.filter((r) => r.thumbMissing);
	const deadModels = checked.filter((r) => r.modelMissing);

	if (deadModels.length) {
		console.log(`\n${deadModels.length} avatar(s) whose MODEL object is gone (reported only):`);
		for (const r of deadModels) {
			console.log(`  ${r.id}  ${r.visibility.padEnd(8)}  ${r.storage_key}  (${r.name || 'unnamed'})`);
		}
	}

	if (!deadThumbs.length) {
		console.log('\nNo dangling thumbnail_key values found.');
	} else {
		console.log(`\n${deadThumbs.length} avatar(s) with a dangling thumbnail_key:`);
		for (const r of deadThumbs) {
			console.log(`  ${r.id}  ${r.visibility.padEnd(8)}  ${r.thumbnail_key}  (${r.name || 'unnamed'})`);
		}
		if (!APPLY) {
			console.log('\nDry run: re-run with --apply to clear them so the thumbnail cron re-renders.');
		} else {
			const ids = deadThumbs.map((r) => r.id);
			const updated = await sql`
				update avatars set thumbnail_key = null, updated_at = now()
				 where id = any(${ids}::uuid[]) and deleted_at is null
				 returning id
			`;
			console.log(`\nCleared thumbnail_key on ${updated.length} row(s); the thumbnail backfill will re-render them.`);
		}
	}

	console.log(
		`\nSummary: ${rows.length} probed · ${probed.size} distinct object(s) checked · ` +
			`${deadModels.length} missing model(s) · ${deadThumbs.length} missing thumbnail(s)`,
	);
}

main().catch((err) => {
	console.error(err?.stack || err?.message || err);
	process.exit(1);
});
