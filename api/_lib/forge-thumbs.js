// Forge thumbnail backfill — give every finished model a real picture.
//
// The Forge persists every generation to forge_creations, but the dominant free
// NVIDIA/TRELLIS lane is geometry-first: it paints no reference image, so those
// rows land with `preview_image_url = NULL`. In production ~79% of finished
// models have no preview, which means every card that renders them — the "Fresh
// from the Forge" showcase, the gallery, creator portfolios, /community, search
// — falls back to a flat gradient placeholder. The browse-and-get-inspired loop
// that brings people back looks broken because most of it is empty squares.
//
// The client-side poster capture in src/forge.js only fires while the *maker* is
// still looking at their result, and only fills a NULL preview — so anything
// generated headlessly (MCP, API, agents) or closed quickly never heals.
//
// This module is the server-side healer: it claims finished, previewless models
// and renders each GLB to a 768² PNG with the shared headless-chromium renderer
// (the exact pipeline avatar thumbnails already use in production), uploads it,
// and fills the row's preview slot — object confirmed in R2 *before* the key is
// committed, so a card never points at a missing image.
//
// Mirrors api/_lib/avatar-thumbs.js: a self-provisioning claim ledger
// (forge_thumbnail_backfill), bounded attempts so a structurally-broken GLB is
// retired after MAX_ATTEMPTS, a lease so an OOM-killed render frees its claim,
// and a batch runner that aborts (refunding untouched claims) if chromium dies.

import { sql } from './db.js';
import { putObject, publicUrl } from './r2.js';
import { thumbBackdropFor } from './avatar-thumbs.js';

// 768² matches the avatar thumbnail size — crisp on retina cards, one PNG the
// whole grid reuses instead of every visitor loading a multi-MB GLB to capture
// a frame client-side.
export const THUMB_SIZE = 768;
export const THUMB_BACKGROUND = '#0a0a0a';

// A GLB that fails to render this many times is almost certainly structurally
// broken (corrupt, oversized, non-glTF). Stop paying chromium for it.
export const MAX_ATTEMPTS = 3;
// A claimed-but-unresolved row (container OOM'd mid-render) frees after this.
export const LEASE_MINUTES = 15;

export function forgeThumbKeyFor(creationId) {
	return `forge/thumb/${creationId}.png`;
}

let schemaReady = false;

// Idempotent schema provisioning, same house pattern as avatar-thumbs — the
// ledger table is created at runtime so the cron works without a separate
// migration step. Cached per warm container.
export async function ensureBackfillSchema() {
	if (schemaReady) return;
	await sql`
		CREATE TABLE IF NOT EXISTS forge_thumbnail_backfill (
			creation_id uuid        PRIMARY KEY REFERENCES forge_creations(id) ON DELETE CASCADE,
			attempts    int         NOT NULL DEFAULT 0,
			last_error  text,
			claimed_at  timestamptz,
			updated_at  timestamptz NOT NULL DEFAULT now(),
			created_at  timestamptz NOT NULL DEFAULT now()
		)
	`;
	await sql`
		CREATE INDEX IF NOT EXISTS forge_thumbnail_backfill_claim_idx
			ON forge_thumbnail_backfill (attempts, claimed_at)
	`;
	schemaReady = true;
}

// Coverage snapshot for reporting / dry runs: finished models that render on a
// browse surface (done, has a GLB, not maker-rejected), split by whether they
// already have a preview image, plus how many are retired as unrenderable.
export async function coverage() {
	const [row] = await sql`
		SELECT
			count(*)::int                                          AS total,
			count(*) FILTER (WHERE preview_image_url IS NOT NULL)::int AS covered,
			count(*) FILTER (WHERE preview_image_url IS NULL)::int     AS missing
		FROM forge_creations
		WHERE status = 'done' AND glb_url IS NOT NULL
		  AND (outcome IS NULL OR outcome != 'rejected')
	`;
	const exhausted = await sql`
		SELECT count(*)::int AS n FROM forge_thumbnail_backfill WHERE attempts >= ${MAX_ATTEMPTS}
	`.catch(() => [{ n: 0 }]);
	return { ...row, exhausted: exhausted[0]?.n ?? 0 };
}

// Atomically select + claim the most-recent finished models still missing a
// preview. Selection and claim are one statement with FOR UPDATE ... SKIP LOCKED
// so the cron and an operator's bulk loop never claim the same row. Newest first:
// the models most likely to be seen on the live showcase heal soonest.
export async function claimCreations(limit = 8) {
	await ensureBackfillSchema();
	const rows = await sql`
		WITH candidates AS (
			SELECT c.id, c.glb_url
			  FROM forge_creations c
			  LEFT JOIN forge_thumbnail_backfill b ON b.creation_id = c.id
			 WHERE c.status = 'done'
			   AND c.glb_url IS NOT NULL
			   AND c.preview_image_url IS NULL
			   AND (c.outcome IS NULL OR c.outcome != 'rejected')
			   AND (
			         b.creation_id IS NULL
			         OR (b.attempts < ${MAX_ATTEMPTS}
			             AND (b.claimed_at IS NULL
			                  OR b.claimed_at < now() - (${LEASE_MINUTES} * interval '1 minute')))
			       )
			 ORDER BY c.created_at DESC
			 LIMIT ${limit}
			 FOR UPDATE OF c SKIP LOCKED
		), claimed AS (
			INSERT INTO forge_thumbnail_backfill (creation_id, attempts, claimed_at, updated_at)
			SELECT id, 1, now(), now() FROM candidates
			ON CONFLICT (creation_id) DO UPDATE
				SET attempts   = forge_thumbnail_backfill.attempts + 1,
				    claimed_at = now(),
				    updated_at = now()
			RETURNING creation_id
		)
		SELECT c.id, c.glb_url
		  FROM candidates c
		  JOIN claimed k ON k.creation_id = c.id
	`;
	return rows;
}

async function releaseClaim(creationId) {
	await sql`DELETE FROM forge_thumbnail_backfill WHERE creation_id = ${creationId}`.catch(() => {});
}

// Model-attributable failure: keep the bumped attempt so it retires after
// MAX_ATTEMPTS, drop the lease so a retry can come sooner.
async function failClaim(creationId, message) {
	await sql`
		UPDATE forge_thumbnail_backfill
		   SET last_error = ${String(message).slice(0, 500)}, claimed_at = NULL, updated_at = now()
		 WHERE creation_id = ${creationId}
	`.catch(() => {});
}

// Browser died / never reached this job: the model is blameless, hand back the
// attempt claimCreations() charged so a container OOM never retires it.
async function rollbackClaim(creationId) {
	await sql`
		UPDATE forge_thumbnail_backfill
		   SET attempts = greatest(0, attempts - 1), claimed_at = NULL, updated_at = now()
		 WHERE creation_id = ${creationId}
	`.catch(() => {});
}

// Render one claimed model's GLB to a PNG, upload it, and fill the preview slot.
// The render import is lazy — chromium + puppeteer are a heavy tree that callers
// which only report coverage should never load.
export async function renderThumbnail({ id, glb_url: glbUrl }) {
	const t0 = Date.now();
	const { renderGlbToPng } = await import('./render-glb.js');

	// glb_url is a durable public CDN url; renderGlbToPng pulls it through the
	// SSRF-pinned fetcher, so chromium never touches the URL directly.
	const png = await renderGlbToPng({
		glbUrl,
		width: THUMB_SIZE,
		height: THUMB_SIZE,
		background: THUMB_BACKGROUND,
		backdrop: thumbBackdropFor(id),
	});
	if (!png?.length) throw new Error('renderer returned no bytes');

	const key = forgeThumbKeyFor(id);
	await putObject({ key, body: png, contentType: 'image/png', metadata: { 'forge-creation': String(id) } });

	// Fill-only: only claim the preview slot if it is still empty, so a poster the
	// maker captured in the meantime always wins over a headless render.
	const url = publicUrl(key);
	const updated = await sql`
		UPDATE forge_creations
		   SET preview_image_url = ${url}, preview_key = ${key}, updated_at = now()
		 WHERE id = ${id} AND preview_image_url IS NULL
		 RETURNING id
	`;
	await releaseClaim(id);
	return { id, key, url, bytes: png.length, ms: Date.now() - t0, filled: updated.length > 0 };
}

// Drain `limit` claimed models, `concurrency` at a time, sharing one chromium
// instance. If the browser dies the batch ABORTS (rather than charging a retry
// to every remaining good model) and refunds untouched claims — identical
// failure semantics to the avatar backfill.
export async function renderBatch({ limit = 8, concurrency = 2, onResult } = {}) {
	const jobs = await claimCreations(limit);
	if (!jobs.length) return { claimed: 0, rendered: 0, failed: 0, aborted: false, results: [] };

	const { isBrowserInfrastructureError } = await import('./render-glb.js');

	const results = [];
	const queue = jobs.slice();
	let aborted = null;

	const workers = Array.from({ length: Math.max(1, Math.min(concurrency, jobs.length)) }, async () => {
		for (let job = queue.shift(); job && !aborted; job = queue.shift()) {
			try {
				const r = await renderThumbnail(job);
				const ok = { id: job.id, status: 'done', ...r };
				results.push(ok);
				onResult?.(ok);
			} catch (err) {
				const msg = err?.message || 'render_failed';
				if (isBrowserInfrastructureError(err)) {
					aborted = msg;
					await rollbackClaim(job.id);
					const infra = { id: job.id, status: 'aborted', error: msg };
					results.push(infra);
					onResult?.(infra);
					return;
				}
				await failClaim(job.id, msg);
				const bad = { id: job.id, status: 'failed', error: msg };
				results.push(bad);
				onResult?.(bad);
			}
		}
	});
	await Promise.all(workers);

	// Untouched claims from an aborted batch must not keep their charged attempt.
	for (const job of queue) await rollbackClaim(job.id);

	return {
		claimed: jobs.length,
		rendered: results.filter((r) => r.status === 'done').length,
		failed: results.filter((r) => r.status === 'failed').length,
		aborted: aborted || false,
		results,
	};
}
