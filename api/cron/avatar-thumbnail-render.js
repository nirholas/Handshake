// GET /api/cron/avatar-thumbnail-render
//
// Downstream consumer of the Avatar Thumbnail Regeneration pipeline (USE-015).
//
// The autonomous x402 spend loop (api/cron/x402-autonomous-loop.js, entry
// `avatar-thumbnail-regen`) pays /api/x402/asset-download for the stalest
// marketplace listing and enqueues a job in avatar_thumbnail_regen_jobs. This
// cron drains that queue: for each claimed job it re-presigns the source GLB,
// renders it to a fresh PNG with the same headless-chromium pipeline used for
// OG cards, uploads the PNG to R2, and writes the new key back onto
// paid_assets.thumbnail_r2_key (+ thumbnail_generated_at) and the linked
// avatars row's thumbnail_key — so marketplace listings always show the model's
// current appearance.
//
// Kept separate from the spend loop on purpose: chromium boot is heavy and the
// loop's presigned downloadUrl is short-lived (60s), so the render must run on
// its own schedule against the durable r2_key, not the loop's expiring URL.
//
// Env:
//   CRON_SECRET                  required Vercel cron auth (Bearer)
//   THUMBNAIL_RENDER_BATCH       max jobs per tick (default 3)
//   THUMBNAIL_RENDER_BG          background color or 'transparent' (default #0a0a0a)

import { json, wrapCron } from '../_lib/http.js';
import { env } from '../_lib/env.js';
import { constantTimeEquals } from '../_lib/crypto.js';
import { logger } from '../_lib/usage.js';
import { presignGet, putObject, publicUrl } from '../_lib/r2.js';
import { renderGlbToPng } from '../_lib/render-glb.js';
import { thumbBackdropFor } from '../_lib/avatar-thumbs.js';
import {
	ensureRegenSchema,
	claimRegenJobs,
	completeRegenJob,
	failRegenJob,
	thumbnailKeyFor,
} from '../_lib/x402/thumbnail-regen.js';

export const maxDuration = 120;

const log = logger('avatar-thumbnail-render');

const BATCH = Math.max(1, Number(process.env.THUMBNAIL_RENDER_BATCH || 3));
const BACKGROUND = (process.env.THUMBNAIL_RENDER_BG || '#0a0a0a').trim();
// Source GLB presign lifetime — long enough for chromium to fetch the bytes.
const SOURCE_TTL_SECONDS = 120;

function requireCron(req, res) {
	const secret = process.env.CRON_SECRET || env.CRON_SECRET;
	if (!secret) { json(res, 503, { error: 'CRON_SECRET unset' }); return false; }
	const auth = req.headers['authorization'] || '';
	const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
	if (!constantTimeEquals(token, secret)) { json(res, 401, { error: 'unauthorized' }); return false; }
	return true;
}

async function renderOne(job) {
	const t0 = Date.now();
	// 1. Re-presign the durable source key (the loop's downloadUrl has expired).
	const glbUrl = await presignGet({ key: job.r2_key, expiresIn: SOURCE_TTL_SECONDS });

	// 2. Render the current model to a PNG. The per-asset tinted backdrop keeps
	// regen renders interchangeable with backfill renders (avatar-thumbs.js);
	// an explicit THUMBNAIL_RENDER_BG override still wins.
	const png = await renderGlbToPng({
		glbUrl,
		width: job.width || 768,
		height: job.height || 768,
		background: BACKGROUND,
		backdrop: process.env.THUMBNAIL_RENDER_BG ? null : thumbBackdropFor(job.asset_slug),
	});

	// 3. Upload the fresh thumbnail to R2.
	const thumbKey = thumbnailKeyFor(job.asset_slug, job.run_id);
	await putObject({ key: thumbKey, body: png, contentType: 'image/png' });

	// 4. Write it back onto the listing + linked avatar and close the job.
	await completeRegenJob(job, thumbKey);

	return { thumbKey, bytes: png.length, ms: Date.now() - t0 };
}

export default wrapCron(async (req, res) => {
	if (req.method !== 'GET') return json(res, 405, { error: 'method_not_allowed' });
	if (!requireCron(req, res)) return;

	// Schema must exist before we can claim — the loop also ensures it, but the
	// drainer can win the race on a fresh deploy.
	try {
		await ensureRegenSchema();
	} catch (err) {
		return json(res, 200, { ok: false, reason: `schema_unavailable: ${err?.message}` });
	}

	let jobs;
	try {
		jobs = await claimRegenJobs(BATCH);
	} catch (err) {
		return json(res, 200, { ok: false, reason: `claim_failed: ${err?.message}` });
	}

	if (!jobs.length) {
		return json(res, 200, { ok: true, claimed: 0, rendered: 0, failed: 0 });
	}

	const results = [];
	for (const job of jobs) {
		try {
			const r = await renderOne(job);
			results.push({ id: Number(job.id), slug: job.asset_slug, status: 'done', thumb: publicUrl(r.thumbKey), bytes: r.bytes, ms: r.ms });
			log.info('thumbnail_rendered', { job_id: Number(job.id), slug: job.asset_slug, bytes: r.bytes, ms: r.ms });
		} catch (err) {
			const msg = err?.message || 'render_failed';
			try { await failRegenJob(job, msg); } catch { /* logged below */ }
			results.push({ id: Number(job.id), slug: job.asset_slug, status: 'failed', error: msg, attempts: job.attempts });
			log.warn('thumbnail_render_failed', { job_id: Number(job.id), slug: job.asset_slug, attempts: job.attempts, message: msg });
		}
	}

	const rendered = results.filter((r) => r.status === 'done').length;
	const failed = results.filter((r) => r.status === 'failed').length;

	return json(res, 200, {
		ok: true,
		claimed: jobs.length,
		rendered,
		failed,
		results,
	});
});
