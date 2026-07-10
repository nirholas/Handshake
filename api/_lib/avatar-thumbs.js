// api/_lib/avatar-thumbs.js
//
// Avatar thumbnail coverage — the single owner of "how does an avatar get a
// thumbnail, and how do we know it really has one".
//
// Background: `avatars.thumbnail_key` was NULL for ~79% of public avatars, so
// every gallery fell back to an initial-letter chip. Worse, callers used to
// *guess* a `thumb/<avatarId>.png` URL to paper over the null — the object had
// never been written, R2 answered 404 with a `text/plain` body, and Chrome
// blocked the response for an <img> request (net::ERR_BLOCKED_BY_ORB).
//
// The invariant this module enforces, and the reason it is the only place that
// writes `thumbnail_key`:
//
//   ** A thumbnail_key is only ever persisted after the object behind it has
//      been confirmed to exist in R2. **
//
// Two ways an avatar gets one, cheapest first:
//
//   1. adoptForgePreviews() — an avatar forged from a `forge_creations` row can
//      point straight at that creation's already-uploaded preview image
//      (`forge_creations.preview_key`, a relative R2 key with a correct
//      Content-Type). Zero new bytes, zero render. This is what /forge's own
//      gallery has always displayed.
//
//   2. renderThumbnail() — everything else (studio avatars, uploads, forge rows
//      whose creation predates preview capture) boots headless chromium, renders
//      the GLB to a square PNG, and uploads it to `thumb/<avatarId>.png`.
//      ~6s per avatar, so it runs in bounded batches off a claim ledger.
//
// Consumers: api/cron/avatar-thumbnail-backfill.js (steady-state drain) and
// scripts/backfill-avatar-thumbnails.mjs (operator-driven bulk run). Both share
// the claim ledger, so they are safe to run at the same time.

import { sql } from './db.js';
import { presignGet, putObject, headObject, publicUrl, isLegacyOgThumbnailKey } from './r2.js';

// Square posters — matches api/cron/avatar-thumbnail-render.js so a marketplace
// re-render and a backfill render produce interchangeable images.
export const THUMB_SIZE = 768;
export const THUMB_BACKGROUND = '#0a0a0a';

// A GLB that fails to render this many times is almost certainly structurally
// broken (corrupt, >25MB, non-glTF bytes). Stop paying chromium for it.
export const MAX_ATTEMPTS = 3;

// A claimed-but-unresolved row (container OOM'd mid-render) frees up after this.
export const LEASE_MINUTES = 15;

// Source GLB presign lifetime — chromium must fetch the bytes within it.
const SOURCE_TTL_SECONDS = 120;

export function thumbKeyFor(avatarId) {
	return `thumb/${avatarId}.png`;
}

let schemaReady = false;

// Idempotent schema provisioning, mirroring
// api/_lib/migrations/20260709120000_avatar_thumbnail_backfill.sql, so a deploy
// that lands ahead of the migration still works. Cached per warm container.
export async function ensureBackfillSchema() {
	if (schemaReady) return;
	await sql`
		CREATE TABLE IF NOT EXISTS avatar_thumbnail_backfill (
			avatar_id  uuid        PRIMARY KEY REFERENCES avatars(id) ON DELETE CASCADE,
			attempts   int         NOT NULL DEFAULT 0,
			last_error text,
			claimed_at timestamptz,
			updated_at timestamptz NOT NULL DEFAULT now(),
			created_at timestamptz NOT NULL DEFAULT now()
		)
	`;
	await sql`
		CREATE INDEX IF NOT EXISTS avatar_thumbnail_backfill_claim_idx
			ON avatar_thumbnail_backfill (attempts, claimed_at)
	`;
	schemaReady = true;
}

// ── Coverage reporting ───────────────────────────────────────────────────────

export async function coverage() {
	const [row] = await sql`
		SELECT
			count(*) FILTER (WHERE storage_key IS NOT NULL)::int                     AS total,
			count(*) FILTER (WHERE storage_key IS NOT NULL
			                   AND thumbnail_key IS NOT NULL
			                   AND thumbnail_key !~ '^https?://')::int               AS covered,
			count(*) FILTER (WHERE storage_key IS NOT NULL
			                   AND (thumbnail_key IS NULL
			                        OR thumbnail_key ~ '^https?://'))::int           AS missing
		FROM avatars
		WHERE deleted_at IS NULL AND visibility = 'public'
	`;
	const exhausted = await sql`
		SELECT count(*)::int AS n FROM avatar_thumbnail_backfill WHERE attempts >= ${MAX_ATTEMPTS}
	`.catch(() => [{ n: 0 }]);
	return { ...row, exhausted: exhausted[0]?.n ?? 0 };
}

// ── 1. Zero-copy adoption from forge_creations.preview_key ───────────────────
//
// The preview image already sits in our bucket with the right Content-Type — the
// /forge gallery renders it directly. Pointing the avatar's thumbnail_key at the
// same key costs nothing and needs no render.
//
// Each candidate is HEAD-checked before we persist it. A preview_key whose object
// was pruned would otherwise reintroduce the exact 404→ORB bug this module exists
// to prevent.
export async function adoptForgePreviews({ limit = 200 } = {}) {
	const candidates = await sql`
		SELECT a.id, f.preview_key
		  FROM avatars a
		  JOIN forge_creations f
		    ON f.id = (a.source_meta->>'forge_creation_id')::uuid
		 WHERE a.deleted_at IS NULL
		   AND a.storage_key IS NOT NULL
		   AND (a.thumbnail_key IS NULL OR a.thumbnail_key ~ '^https?://')
		   AND a.source_meta->>'forge_creation_id' ~ '^[0-9a-fA-F-]{36}$'
		   AND f.preview_key IS NOT NULL
		   AND f.preview_key !~ '^https?://'
		 ORDER BY a.featured DESC, a.view_count DESC NULLS LAST, a.created_at DESC
		 LIMIT ${limit}
	`;
	if (!candidates.length) return { adopted: 0, missing: 0 };

	let adopted = 0;
	let missing = 0;
	for (const c of candidates) {
		// Confirm the bytes are really there before we advertise them.
		const head = await headObject(c.preview_key).catch(() => null);
		if (!head) {
			missing++;
			continue;
		}
		await sql`
			UPDATE avatars
			   SET thumbnail_key = ${c.preview_key}, updated_at = now()
			 WHERE id = ${c.id}
			   AND (thumbnail_key IS NULL OR thumbnail_key ~ '^https?://')
		`;
		await releaseClaim(c.id);
		adopted++;
	}
	return { adopted, missing };
}

// ── 2. Claim + render ────────────────────────────────────────────────────────

// Atomically select and claim the most-visible avatars still missing a thumbnail.
// Candidate selection and the claim upsert run as ONE statement so two concurrent
// runners (the cron and an operator's bulk script) never claim the same avatar:
// `FOR UPDATE ... SKIP LOCKED` holds the row locks for the statement's duration.
export async function claimAvatars(limit = 5) {
	await ensureBackfillSchema();
	const rows = await sql`
		WITH candidates AS (
			SELECT a.id, a.storage_key, a.name
			  FROM avatars a
			  LEFT JOIN avatar_thumbnail_backfill b ON b.avatar_id = a.id
			 WHERE a.deleted_at IS NULL
			   AND a.storage_key IS NOT NULL
			   AND (a.thumbnail_key IS NULL OR a.thumbnail_key ~ '^https?://')
			   AND (
			         b.avatar_id IS NULL
			         OR (b.attempts < ${MAX_ATTEMPTS}
			             AND (b.claimed_at IS NULL
			                  OR b.claimed_at < now() - (${LEASE_MINUTES} * interval '1 minute')))
			       )
			 ORDER BY a.featured DESC,
			          (a.visibility = 'public') DESC,
			          a.view_count DESC NULLS LAST,
			          a.created_at DESC
			 LIMIT ${limit}
			 FOR UPDATE OF a SKIP LOCKED
		), claimed AS (
			INSERT INTO avatar_thumbnail_backfill (avatar_id, attempts, claimed_at, updated_at)
			SELECT id, 1, now(), now() FROM candidates
			ON CONFLICT (avatar_id) DO UPDATE
				SET attempts   = avatar_thumbnail_backfill.attempts + 1,
				    claimed_at = now(),
				    updated_at = now()
			RETURNING avatar_id
		)
		SELECT c.id, c.storage_key, c.name
		  FROM candidates c
		  JOIN claimed k ON k.avatar_id = c.id
	`;
	return rows;
}

async function releaseClaim(avatarId) {
	await sql`DELETE FROM avatar_thumbnail_backfill WHERE avatar_id = ${avatarId}`.catch(() => {});
}

// A real, model-attributable failure: keep the bumped attempt count so the model
// is retired after MAX_ATTEMPTS, and drop the lease so it can be retried sooner.
async function failClaim(avatarId, message) {
	await sql`
		UPDATE avatar_thumbnail_backfill
		   SET last_error = ${String(message).slice(0, 500)}, claimed_at = NULL, updated_at = now()
		 WHERE avatar_id = ${avatarId}
	`.catch(() => {});
}

// The browser died, or we never got to the model at all. The avatar is blameless:
// give back the attempt that claimAvatars() charged, or it would be retired after
// three unlucky container OOMs and never get a thumbnail.
async function rollbackClaim(avatarId) {
	await sql`
		UPDATE avatar_thumbnail_backfill
		   SET attempts = greatest(0, attempts - 1), claimed_at = NULL, updated_at = now()
		 WHERE avatar_id = ${avatarId}
	`.catch(() => {});
}

// Render one claimed avatar's GLB to a PNG, upload it, and commit the key.
//
// The render import is lazy: chromium + puppeteer are a heavy dependency tree and
// callers that only adopt forge previews should never pay for loading it.
export async function renderThumbnail({ id, storage_key: storageKey }) {
	const t0 = Date.now();
	const { renderGlbToPng } = await import('./render-glb.js');

	// storage_key is normally a bucket key; first-party avatars store an absolute
	// URL. presignGet() passes those through untouched.
	const glbUrl = await presignGet({ key: storageKey, expiresIn: SOURCE_TTL_SECONDS });

	const png = await renderGlbToPng({
		glbUrl,
		width: THUMB_SIZE,
		height: THUMB_SIZE,
		background: THUMB_BACKGROUND,
	});
	if (!png?.length) throw new Error('renderer returned no bytes');

	const key = thumbKeyFor(id);
	await putObject({ key, body: png, contentType: 'image/png', metadata: { 'avatar-id': String(id) } });

	// Only now — object confirmed written — does the key become public.
	await sql`UPDATE avatars SET thumbnail_key = ${key}, updated_at = now() WHERE id = ${id}`;
	await releaseClaim(id);

	return { key, url: publicUrl(key), bytes: png.length, ms: Date.now() - t0 };
}

// Drain `limit` claimed avatars, `concurrency` at a time. Renders share one
// chromium instance (a page per call), so concurrency is cheap up to the point
// the container runs out of RAM — 2–3 is the sweet spot; higher risks the OOM
// killer taking chromium down mid-batch.
//
// If the browser dies, the batch ABORTS rather than grinding through the rest of
// the queue. Every render after a chromium death fails in milliseconds with
// "Connection closed.", so a naive loop would charge a retry to hundreds of
// perfectly good models and retire them permanently. Aborted and unstarted claims
// are rolled back; the runner sees `aborted: true` and stops.
export async function renderBatch({ limit = 5, concurrency = 1, onResult } = {}) {
	const jobs = await claimAvatars(limit);
	if (!jobs.length) return { claimed: 0, rendered: 0, failed: 0, aborted: false, results: [] };

	const { isBrowserInfrastructureError } = await import('./render-glb.js');

	const results = [];
	const queue = jobs.slice();
	let aborted = null;

	const workers = Array.from({ length: Math.max(1, Math.min(concurrency, jobs.length)) }, async () => {
		for (let job = queue.shift(); job && !aborted; job = queue.shift()) {
			try {
				const r = await renderThumbnail(job);
				const ok = { id: job.id, name: job.name, status: 'done', ...r };
				results.push(ok);
				onResult?.(ok);
			} catch (err) {
				const msg = err?.message || 'render_failed';
				if (isBrowserInfrastructureError(err)) {
					// Not this model's fault — hand the attempt back and stop the batch.
					aborted = msg;
					await rollbackClaim(job.id);
					const infra = { id: job.id, name: job.name, status: 'aborted', error: msg };
					results.push(infra);
					onResult?.(infra);
					return;
				}
				await failClaim(job.id, msg);
				const bad = { id: job.id, name: job.name, status: 'failed', error: msg };
				results.push(bad);
				onResult?.(bad);
			}
		}
	});
	await Promise.all(workers);

	// Whatever the aborted batch never touched must not keep its charged attempt.
	for (const job of queue) await rollbackClaim(job.id);

	return {
		claimed: jobs.length,
		rendered: results.filter((r) => r.status === 'done').length,
		failed: results.filter((r) => r.status === 'failed').length,
		aborted: aborted || false,
		results,
	};
}

// Repair: forget every ledger row whose failure was the browser dying rather than
// the model being bad. A row's absence means "never attempted", so the avatar
// re-enters the candidate set with a clean slate.
//
// renderBatch() no longer charges an attempt for an infrastructure failure, but a
// runner that crashed before that fix — or a future failure mode not yet in
// isBrowserInfrastructureError() — can still poison the ledger and permanently
// retire thousands of perfectly renderable avatars. This is the undo.
export async function resetInfrastructureFailures() {
	const rows = await sql`
		DELETE FROM avatar_thumbnail_backfill
		 WHERE last_error IS NULL
		    OR last_error ~* '(connection closed|target closed|browser has disconnected|browser was not found|protocol error|session closed|websocket|econnreset|socket hang up|failed to launch)'
		RETURNING avatar_id
	`;
	return { reset: rows.length };
}

// Exported for tests: the predicate the whole module agrees on.
export function isMissingThumbnail(thumbnailKey) {
	if (!thumbnailKey) return true;
	if (isLegacyOgThumbnailKey(thumbnailKey)) return true;
	return /^https?:\/\//i.test(thumbnailKey);
}
