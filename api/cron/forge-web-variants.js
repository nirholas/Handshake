// GET /api/cron/forge-web-variants
//
// Steady-state backfill of the phone-sized delivery variant for meshes that
// were forged before it existed.
//
// Every finished generation from 2026-09-04 onward gets its variant written
// right after materialization (buildWebVariant in api/_lib/forge-store.js). The
// meshes already in the bucket do not, and there are enough of them that a bulk
// rewrite of storage is the wrong tool: it would be one long unattended job
// re-uploading objects nobody has asked for. This drains the gap a bounded batch
// at a time, newest first, because the newest models are the ones actually being
// opened on a phone.
//
// Per row: read the stored original out of the bucket, run the delivery pass
// (meshopt geometry + WebP textures capped at 2048 px), write the result to a
// SECOND key, and record it. The original object is never touched, so a row that
// fails here is exactly as serveable as it was before, and the download action
// and every third-party API consumer keep the full-resolution mesh.
//
// A row whose variant would not actually be smaller is marked as attempted by
// pointing web_glb_key at the original key, which both keeps it out of the
// pending index and makes readers serve the original: `web_glb_url` stays null
// in that case and every reader already treats null as "serve glb_url".
//
// Env:
//   CRON_SECRET                  required (Bearer)
//   FORGE_WEB_VARIANT_BATCH      meshes per tick (default 6)
//
// Sizing: the pass measured 0.6-5.6 s per mesh on real production output, plus
// the bucket read and write, so 6 lands well inside maxDuration=120 even on a
// bad batch.

import { json, wrapCron } from '../_lib/http.js';
import { logger } from '../_lib/usage.js';
import { requireCron } from '../_lib/cron-auth.js';
import { sql } from '../_lib/db.js';
import { getObjectBuffer, objectStorageConfigured } from '../_lib/r2.js';
import { forgeStoreEnabled, buildWebVariant } from '../_lib/forge-store.js';

export const maxDuration = 120;

const log = logger('forge-web-variants');

const BATCH = Math.max(1, Math.min(24, Number(process.env.FORGE_WEB_VARIANT_BATCH || 6)));

export default wrapCron(async (req, res) => {
	if (req.method !== 'GET') return json(res, 405, { error: 'method_not_allowed' });
	if (!requireCron(req, res)) return;
	if (!forgeStoreEnabled()) return json(res, 200, { ok: false, reason: 'forge_store_disabled' });
	if (!objectStorageConfigured()) return json(res, 200, { ok: false, reason: 'object_storage_unconfigured' });

	let rows;
	try {
		rows = await sql`
			select id, glb_key, size_bytes
			from forge_creations
			where status = 'done' and glb_url is not null and glb_key is not null and web_glb_key is null
			order by updated_at desc
			limit ${BATCH}
		`;
	} catch (err) {
		log.warn('claim_failed', { message: err?.message });
		return json(res, 200, { ok: false, reason: `claim_failed: ${err?.message}` });
	}

	if (!rows.length) return json(res, 200, { ok: true, processed: 0, remaining: 0, done: true });

	let built = 0;
	let skipped = 0;
	let failed = 0;
	for (const row of rows) {
		const keyPrefix = String(row.glb_key).replace(/\.glb$/i, '');
		try {
			const buffer = await getObjectBuffer(row.glb_key);
			const result = await buildWebVariant({ buffer, creationId: row.id, keyPrefix });
			if (result) {
				built++;
				log.info('variant_built', { creation_id: row.id, before: buffer.length, after: result.bytes });
			} else {
				// No gain (or too small to bother). Retire the row from the pending
				// index by pointing its key at the original; web_glb_url stays null,
				// so readers keep serving glb_url exactly as they do today.
				await sql`
					update forge_creations
					set web_glb_key = ${row.glb_key}, updated_at = now()
					where id = ${row.id}
				`;
				skipped++;
			}
		} catch (err) {
			// Leave the row pending: a bucket read that failed once (a deleted
			// object aside) is worth another tick, and the original is untouched.
			failed++;
			log.warn('variant_failed', { creation_id: row.id, message: err?.message });
		}
	}

	let remaining = null;
	try {
		const [{ n }] = await sql`
			select count(*)::int as n from forge_creations
			where status = 'done' and glb_url is not null and glb_key is not null and web_glb_key is null
		`;
		remaining = n;
	} catch {
		remaining = null;
	}

	return json(res, 200, { ok: true, processed: rows.length, built, skipped, failed, remaining });
});
