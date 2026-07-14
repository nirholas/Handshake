// @ts-check
// GET /api/cron/sketchfab-showcase: curated Sketchfab distribution for SEO.
//
// Runs Mon/Wed/Fri and pushes up to SKETCHFAB_UPLOADS_PER_RUN (default 2, so
// up to 6/week) of the best community-validated forge models to the official
// three.ws Sketchfab account. Selection order:
//
//   1. Weekly Forge-Off winners (forge_board_winners) not yet uploaded: the
//      strongest human-curation signal on the platform.
//   2. Top-voted board models (forge_creations.vote_count >= 1): at least one
//      real community vote, never raw unreviewed output.
//
// Every upload is tagged `ai-generated`, carries the source prompt, and
// backlinks to the creation's share page + /forge with UTM parameters
// (utm_source=sketchfab) so referral conversion is measurable. This is a
// showcase, not a firehose: the per-run cap and the vote floor keep the
// account curated.
//
// Each run also refreshes the async processing status of recent uploads
// (uploaded -> live | failed).
//
// Skips cleanly when SKETCHFAB_API_TOKEN is unset. `?dry_run=1` returns the
// current selection without uploading anything.

import { json, method, wrapCron } from '../_lib/http.js';
import { env } from '../_lib/env.js';
import { sql } from '../_lib/db.js';
import { constantTimeEquals } from '../_lib/crypto.js';
import {
	GLB_MAX_BYTES,
	buildDescription,
	buildModelName,
	buildTags,
	getProcessingStatus,
	sketchfabConfigured,
	uploadModel,
} from '../_lib/sketchfab.js';

const MAX_ATTEMPTS = 3;

function requireCron(req, res) {
	const secret = process.env.CRON_SECRET || env.CRON_SECRET;
	if (!secret) {
		res.status(503).json({ error: 'not_configured', message: 'CRON_SECRET unset' });
		return false;
	}
	const auth = req.headers['authorization'] || '';
	const presented = auth.startsWith('Bearer ') ? auth.slice(7) : '';
	if (!constantTimeEquals(presented, secret)) {
		res.status(401).json({ error: 'unauthorized' });
		return false;
	}
	return true;
}

function uploadsPerRun() {
	const n = Number(env.SKETCHFAB_UPLOADS_PER_RUN || 2);
	if (!Number.isFinite(n)) return 2;
	return Math.min(5, Math.max(1, Math.floor(n)));
}

// A creation is eligible when it is publicly showable (same bar as the forge
// gallery), fits the Sketchfab basic-plan size cap, and has no ledger row
// blocking it (uploaded/live/pending, or failed with the retry budget spent).
async function selectCandidates(limit) {
	const winners = await sql`
		select fc.id, fc.prompt, fc.glb_url, fc.model_category, 'board_winner' as source
		from forge_board_winners w
		join forge_creations fc on fc.id = w.creation_id
		where fc.status = 'done'
		  and fc.glb_url is not null
		  and (fc.outcome is null or fc.outcome != 'rejected')
		  and coalesce(fc.size_bytes, 0) <= ${GLB_MAX_BYTES}
		  and not exists (
		    select 1 from sketchfab_uploads su
		    where su.creation_id = fc.id
		      and (su.status != 'failed' or su.attempts >= ${MAX_ATTEMPTS})
		  )
		order by w.week_start desc
		limit ${limit}
	`;
	if (winners.length >= limit) return winners;

	const winnerIds = winners.map((w) => w.id);
	const topVoted = await sql`
		select fc.id, fc.prompt, fc.glb_url, fc.model_category, 'top_voted' as source
		from forge_creations fc
		where fc.status = 'done'
		  and fc.glb_url is not null
		  and (fc.outcome is null or fc.outcome != 'rejected')
		  and fc.vote_count >= 1
		  and coalesce(fc.size_bytes, 0) <= ${GLB_MAX_BYTES}
		  and fc.id != all(${winnerIds}::uuid[])
		  and not exists (
		    select 1 from sketchfab_uploads su
		    where su.creation_id = fc.id
		      and (su.status != 'failed' or su.attempts >= ${MAX_ATTEMPTS})
		  )
		order by fc.vote_count desc, fc.created_at desc
		limit ${limit - winners.length}
	`;
	return [...winners, ...topVoted];
}

// Claim the creation in the ledger before touching the network so concurrent
// runs (or a Scheduler retry) can never double-upload. Fresh creations insert;
// a prior failure re-claims only while attempts remain.
async function claimCreation(candidate) {
	const [row] = await sql`
		insert into sketchfab_uploads (creation_id, source, status, attempts, prompt, glb_url)
		values (${candidate.id}, ${candidate.source}, 'pending', 1, ${candidate.prompt}, ${candidate.glb_url})
		on conflict (creation_id) do update
			set attempts = sketchfab_uploads.attempts + 1,
			    status = 'pending',
			    updated_at = now()
			where sketchfab_uploads.status = 'failed'
			  and sketchfab_uploads.attempts < ${MAX_ATTEMPTS}
		returning id
	`;
	return row?.id || null;
}

async function pushCandidate(candidate) {
	const ledgerId = await claimCreation(candidate);
	if (!ledgerId) return { id: candidate.id, status: 'skipped', reason: 'already_claimed' };

	try {
		const name = buildModelName(candidate.prompt);
		const { uid, url } = await uploadModel({
			glbUrl: candidate.glb_url,
			name,
			description: buildDescription({
				prompt: candidate.prompt,
				creationId: candidate.id,
				source: candidate.source,
			}),
			tags: buildTags(candidate.model_category),
		});
		await sql`
			update sketchfab_uploads
			set status = 'uploaded', sketchfab_uid = ${uid}, sketchfab_url = ${url},
			    error = null, updated_at = now()
			where id = ${ledgerId}
		`;
		return { id: candidate.id, status: 'uploaded', source: candidate.source, name, uid, url };
	} catch (err) {
		const message = String(err?.message || err).slice(0, 500);
		await sql`
			update sketchfab_uploads
			set status = 'failed', error = ${message}, updated_at = now()
			where id = ${ledgerId}
		`.catch(() => {});
		return { id: candidate.id, status: 'failed', source: candidate.source, error: message };
	}
}

// Move recent uploads through Sketchfab's async pipeline: uploaded -> live on
// SUCCEEDED, -> failed on FAILED (with attempts exhausted, since reprocessing
// the same GLB fails the same way).
async function refreshProcessing() {
	const rows = await sql`
		select id, sketchfab_uid from sketchfab_uploads
		where status = 'uploaded' and sketchfab_uid is not null
		order by updated_at asc
		limit 10
	`;
	const refreshed = [];
	for (const row of rows) {
		try {
			const state = await getProcessingStatus(row.sketchfab_uid);
			if (state === 'SUCCEEDED') {
				await sql`
					update sketchfab_uploads set status = 'live', updated_at = now() where id = ${row.id}
				`;
				refreshed.push({ uid: row.sketchfab_uid, status: 'live' });
			} else if (state === 'FAILED') {
				await sql`
					update sketchfab_uploads
					set status = 'failed', attempts = ${MAX_ATTEMPTS},
					    error = 'sketchfab processing failed', updated_at = now()
					where id = ${row.id}
				`;
				refreshed.push({ uid: row.sketchfab_uid, status: 'failed' });
			}
		} catch {
			// Transient status-read failure: the next run retries.
		}
	}
	return refreshed;
}

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET'])) return;
	if (!requireCron(req, res)) return;

	const url = new URL(req.url || '/', 'https://three.ws');
	const dryRun = url.searchParams.get('dry_run') === '1';

	// Dry-run only reads the DB, so it works before the Sketchfab token is
	// wired: it previews exactly what the next real run would pick.
	if (!dryRun && !sketchfabConfigured()) {
		return json(res, 200, {
			ok: false,
			reason: 'not_configured',
			message: 'SKETCHFAB_API_TOKEN unset; showcase cron is dormant',
		});
	}

	const limit = uploadsPerRun();
	const candidates = await selectCandidates(limit);

	if (dryRun) {
		return json(res, 200, {
			ok: true,
			dry_run: true,
			configured: sketchfabConfigured(),
			limit,
			candidates: candidates.map((c) => ({
				id: c.id,
				source: c.source,
				name: buildModelName(c.prompt),
				prompt: c.prompt,
				glb_url: c.glb_url,
			})),
		});
	}

	const refreshed = await refreshProcessing();
	const results = [];
	for (const candidate of candidates) {
		results.push(await pushCandidate(candidate));
	}

	return json(res, 200, {
		ok: true,
		uploaded: results.filter((r) => r.status === 'uploaded').length,
		failed: results.filter((r) => r.status === 'failed').length,
		refreshed,
		results,
	});
});
