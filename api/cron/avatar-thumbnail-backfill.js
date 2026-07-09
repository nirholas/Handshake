// GET /api/cron/avatar-thumbnail-backfill
//
// Steady-state drain of the avatar thumbnail coverage gap.
//
// ~79% of public avatars shipped with `thumbnail_key = NULL` because nothing
// generated a thumbnail when an avatar was forged or built in the studio. The
// only existing renderer (api/cron/avatar-thumbnail-render.js) is fed by the
// x402 spend loop and only ever touches *marketplace listings*, so the other
// ~10k avatars were never going to heal on their own.
//
// Each tick:
//   1. Adopts forge previews — an avatar forged from a forge_creations row points
//      its thumbnail_key straight at that creation's already-uploaded preview
//      image. Zero new bytes, no chromium. Hundreds per tick.
//   2. Renders the rest — claims the most-visible avatars still missing a
//      thumbnail, renders each GLB to a 768² PNG, uploads it, commits the key.
//      Bounded by RENDER_BATCH because chromium costs ~6s per model.
//
// Both steps only ever persist a thumbnail_key after confirming the object exists
// in R2 (see api/_lib/avatar-thumbs.js) — a key pointing at a missing object is
// what produced net::ERR_BLOCKED_BY_ORB on the homepage in the first place.
//
// Sibling cron (avatar-thumbnail-render) re-renders *stale* marketplace
// thumbnails; this one fills in *absent* ones. They share the render helper and
// the thumb/<avatarId>.png key space, and each is a no-op on the other's rows.
//
// Env:
//   CRON_SECRET                        required (Bearer)
//   THUMBNAIL_BACKFILL_RENDER_BATCH    models rendered per tick (default 8)
//   THUMBNAIL_BACKFILL_ADOPT_BATCH     forge previews adopted per tick (default 200)
//   THUMBNAIL_BACKFILL_CONCURRENCY     parallel renders (default 2)
//
// Sizing: a render is ~3-6s, so 8 models at concurrency 2 lands around 25-40s —
// comfortably inside maxDuration=120 with room for a slow model. At */5 that is
// ~96 avatars/hour. A large backlog should be cleared with the bulk script
// (scripts/backfill-avatar-thumbnails.mjs --loop), which shares this claim ledger;
// the cron exists to keep coverage at 100% once it is there.

import { json, wrapCron } from '../_lib/http.js';
import { env } from '../_lib/env.js';
import { constantTimeEquals } from '../_lib/crypto.js';
import { logger } from '../_lib/usage.js';
import {
	ensureBackfillSchema,
	adoptForgePreviews,
	renderBatch,
	coverage,
} from '../_lib/avatar-thumbs.js';

export const maxDuration = 120;

const log = logger('avatar-thumbnail-backfill');

const RENDER_BATCH = Math.max(0, Number(process.env.THUMBNAIL_BACKFILL_RENDER_BATCH || 8));
const ADOPT_BATCH = Math.max(0, Number(process.env.THUMBNAIL_BACKFILL_ADOPT_BATCH || 200));
const CONCURRENCY = Math.max(1, Number(process.env.THUMBNAIL_BACKFILL_CONCURRENCY || 2));

function requireCron(req, res) {
	const secret = process.env.CRON_SECRET || env.CRON_SECRET;
	if (!secret) {
		json(res, 503, { error: 'CRON_SECRET unset' });
		return false;
	}
	const auth = req.headers['authorization'] || '';
	const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
	if (!constantTimeEquals(token, secret)) {
		json(res, 401, { error: 'unauthorized' });
		return false;
	}
	return true;
}

export default wrapCron(async (req, res) => {
	if (req.method !== 'GET') return json(res, 405, { error: 'method_not_allowed' });
	if (!requireCron(req, res)) return;

	try {
		await ensureBackfillSchema();
	} catch (err) {
		return json(res, 200, { ok: false, reason: `schema_unavailable: ${err?.message}` });
	}

	// Step 1 — free coverage. Cheap enough to always run first and to run to
	// completion before we spend a single chromium second.
	let adopt = { adopted: 0, missing: 0 };
	if (ADOPT_BATCH > 0) {
		try {
			adopt = await adoptForgePreviews({ limit: ADOPT_BATCH });
			if (adopt.adopted) log.info('forge_previews_adopted', adopt);
		} catch (err) {
			log.warn('adopt_failed', { message: err?.message });
		}
	}

	// Step 2 — render what's left, most-visible first.
	let render = { claimed: 0, rendered: 0, failed: 0, results: [] };
	if (RENDER_BATCH > 0) {
		try {
			render = await renderBatch({ limit: RENDER_BATCH, concurrency: CONCURRENCY });
		} catch (err) {
			log.warn('render_batch_failed', { message: err?.message });
			return json(res, 200, { ok: false, reason: `render_failed: ${err?.message}`, adopted: adopt.adopted });
		}
	}

	for (const r of render.results) {
		if (r.status === 'done') log.info('thumbnail_rendered', { avatar_id: r.id, bytes: r.bytes, ms: r.ms });
		else log.warn('thumbnail_render_failed', { avatar_id: r.id, message: r.error });
	}

	const cov = await coverage().catch(() => null);

	return json(res, 200, {
		ok: true,
		adopted: adopt.adopted,
		adopt_missing_objects: adopt.missing,
		claimed: render.claimed,
		rendered: render.rendered,
		failed: render.failed,
		coverage: cov,
		results: render.results.map((r) => ({
			id: r.id,
			status: r.status,
			...(r.status === 'done' ? { url: r.url, bytes: r.bytes, ms: r.ms } : { error: r.error }),
		})),
	});
});
