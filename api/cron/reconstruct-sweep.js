// @ts-check
// GET /api/cron/reconstruct-sweep — completion backstop for selfie/prompt →
// avatar jobs.
//
// A reconstruct job is advanced by the browser: /create/selfie polls
// /api/avatars/regenerate-status, and each poll pulls provider status and runs
// the finalize stages. Close the tab and that engine stops — the worker
// finishes the GLB and writes it to GCS, but no one ever collects it, so the
// job row sits at 'queued'/'running' forever and the user's library never
// receives the avatar they made. Production had rows stranded this way going
// back a month (12 at the time this shipped), each one a real person whose
// avatar silently vanished.
//
// This sweep is the server-side driver the flow was missing: every few minutes
// it finds reconstruct jobs that have gone quiet, asks the provider for their
// real status, and runs the SAME finalize stages the browser poll would have —
// so an abandoned job still lands in the user's library, exactly as if they had
// kept the tab open. It mirrors auto-rig-sweep.js, which plays this role for
// the rerig lane; the shared stages in reconstruct-finalize.js are what keep
// the two completion paths from drifting.
//
// Scope is deliberately platform-providers-only (gcp / replicate / huggingface).
// BYOK jobs (meshy, tripo) authenticate with the *user's* key, which the status
// poll resolves from the request context; a cron has no user context, so those
// jobs stay browser-driven and the age reaper below is their only backstop.
// They are a rounding error in practice (1 of the last ~100 reconstruct jobs).

import { error, json, method, wrapCron } from '../_lib/http.js';
import { sql } from '../_lib/db.js';
import { getRegenProviderForMode } from '../_lib/regen-provider.js';
import { finalizeReconstructStage, pollRiggingStage } from '../_lib/reconstruct-finalize.js';
import { isAllowedProviderResultUrl } from '../_lib/provider-result-url.js';
import { requireCron } from '../_lib/cron-auth.js';

// The browser polls every few seconds while the tab is open, so a row that has
// been untouched for 3 minutes is either abandoned or wedged — never a job
// that is about to complete normally on its own.
const QUIET_WINDOW = '3 minutes';

// How far back the sweep still tries to RESCUE a job rather than fail it. Far
// longer than auto-rig's window on purpose: the gcp worker parks finished GLBs
// in GCS and its job state in Firestore, both durable, so a month-old
// abandoned job is still perfectly recoverable — and recovering it puts a real
// avatar in a real user's library. Beyond this, rows are reaped to 'failed' so
// the open set cannot grow without bound (db-retention only prunes terminal
// rows, so an open zombie would otherwise live forever).
const RESCUE_WINDOW = '30 days';

// A job whose provider is not the currently-resolved platform provider can
// never be polled again (e.g. replicate rows from before the credential was
// removed). Give the mismatch a day of grace in case the platform config is
// mid-rotation, then fail it out with an honest reason.
const MISMATCH_MAX_AGE = '24 hours';

// 50/tick × 12 ticks/hour clears any plausible backlog within an hour; the
// steady-state inflow is a handful of abandoned tabs per day. Oldest-quiet
// first so the backlog drains FIFO and nothing is perpetually overtaken.
const BATCH = 50;

function hostOf(raw) {
	try { return new URL(raw).hostname; } catch { return 'unparseable'; }
}

async function failJob(jobId, userId, reason) {
	await sql`
		update avatar_regen_jobs
		set status = 'failed', error = ${reason}, updated_at = now()
		where job_id = ${jobId} and user_id = ${userId}
	`;
}

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET', 'POST'])) return;
	if (!requireCron(req, res)) return;

	// Open reconstruct jobs that have gone quiet and never materialized. Four
	// states qualify:
	//   • 'queued'/'running' — abandoned mid-generation; needs a provider poll.
	//   • 'rigging'          — the mesh landed bare and a rig child-job was
	//                          chained; pollRiggingStage owns the follow-up.
	//   • 'done' + no avatar + no error — the provider finished and the URL was
	//     stored, but the finalize itself was interrupted. Finalized straight
	//     from the stored URL, no provider round-trip. (`error is null` keeps
	//     deliberate done-with-note closes, e.g. quota exhaustion, terminal.)
	const rows = await sql`
		select job_id, user_id, source_avatar_id, mode, params, status, provider,
		       ext_job_id, result_glb_url, error, created_at
		from avatar_regen_jobs
		where mode = 'reconstruct'
		  and result_avatar_id is null
		  and (
		    status in ('queued', 'running', 'rigging')
		    or (status = 'done' and error is null)
		  )
		  and updated_at < now() - ${QUIET_WINDOW}::interval
		  and created_at > now() - ${RESCUE_WINDOW}::interval
		order by updated_at asc
		limit ${BATCH}
	`;

	const summary = { scanned: rows.length, finalized: 0, rigging: 0, failed: 0, pending: 0, errored: 0, reaped: 0 };

	// Reap the unrecoverable tail on every tick, disjoint from the rescue window
	// above so the two never touch the same row (the auto-rig sweep learned this
	// the hard way: reaping only on empty batches let zombies accrete behind a
	// sustained backlog).
	const reaped = await sql`
		update avatar_regen_jobs
		set status = 'failed',
			error = 'reconstruct job exceeded the rescue window without completing',
			updated_at = now()
		where mode = 'reconstruct'
		  and status in ('queued', 'running', 'rigging')
		  and result_avatar_id is null
		  and created_at <= now() - ${RESCUE_WINDOW}::interval
		returning job_id
	`;
	summary.reaped = reaped.length;

	if (!rows.length) return json(res, 200, { ok: true, ...summary });

	// Resolve the platform reconstruct provider once per tick. Rows whose
	// provider doesn't match (stale credentials rotated away, or BYOK) can't be
	// polled from cron context and are aged out individually below.
	let provider = null;
	try {
		provider = await getRegenProviderForMode('reconstruct');
	} catch (err) {
		console.warn('[reconstruct-sweep] provider resolve failed', { error: err?.message });
	}
	const providerName = provider?.name ?? null;

	for (const job of rows) {
		try {
			// Rig chain in flight — the shared stage polls the child job, swaps in
			// the rigged GLB when it lands, or falls back to the bare mesh.
			if (job.status === 'rigging') {
				const result = await pollRiggingStage({ userId: job.user_id, jobId: job.job_id, job });
				if (result.status === 'done' && result.resultAvatarId) summary.finalized++;
				else if (result.status === 'failed') summary.failed++;
				else summary.rigging++;
				continue;
			}

			// Fast path: provider verdict already stored — finalize from it without
			// a status round-trip. The SSRF host pin runs here because this column
			// may predate the allowlist-at-write guard.
			if (job.status === 'done' && job.result_glb_url) {
				if (!isAllowedProviderResultUrl(job.result_glb_url)) {
					console.warn('[reconstruct-sweep] blocked result url', { jobId: job.job_id, host: hostOf(job.result_glb_url) });
					await failJob(job.job_id, job.user_id, 'provider returned a disallowed result url');
					summary.failed++;
					continue;
				}
				const result = await finalizeReconstructStage({
					userId: job.user_id, jobId: job.job_id, job, glbUrl: job.result_glb_url,
				});
				if (result.status === 'rigging') summary.rigging++;
				else summary.finalized++;
				continue;
			}

			if (!job.ext_job_id) {
				await failJob(job.job_id, job.user_id, 'reconstruct job has no provider id to poll');
				summary.failed++;
				continue;
			}

			if (!providerName || job.provider !== providerName) {
				// Unpollable from here. Age it out after a day rather than instantly,
				// in case platform credentials are mid-rotation.
				const ageOk = await sql`
					select 1 from avatar_regen_jobs
					where job_id = ${job.job_id}
					  and created_at <= now() - ${MISMATCH_MAX_AGE}::interval
				`;
				if (ageOk.length) {
					await failJob(
						job.job_id, job.user_id,
						`job provider "${job.provider}" is not pollable by the platform sweep`,
					);
					summary.failed++;
				} else {
					summary.pending++;
				}
				continue;
			}

			const update = await provider.instance.status(job.ext_job_id);

			if (update.status === 'done' && update.resultGlbUrl) {
				if (!isAllowedProviderResultUrl(update.resultGlbUrl)) {
					console.warn('[reconstruct-sweep] blocked result url', { jobId: job.job_id, host: hostOf(update.resultGlbUrl) });
					await failJob(job.job_id, job.user_id, 'provider returned a disallowed result url');
					summary.failed++;
					continue;
				}
				const result = await finalizeReconstructStage({
					userId: job.user_id, jobId: job.job_id, job, glbUrl: update.resultGlbUrl,
				});
				if (result.status === 'rigging') summary.rigging++;
				else summary.finalized++;
			} else if (update.status === 'failed') {
				await failJob(job.job_id, job.user_id, update.error || 'provider reported reconstruction failure');
				summary.failed++;
			} else {
				// Genuinely still running — bump updated_at so the next tick doesn't
				// re-poll it inside the quiet window.
				await sql`
					update avatar_regen_jobs
					set status = ${update.status || 'running'}, updated_at = now()
					where job_id = ${job.job_id} and user_id = ${job.user_id}
				`;
				summary.pending++;
			}
		} catch (err) {
			console.warn('[reconstruct-sweep] job error', { jobId: job.job_id, error: err?.message });
			summary.errored++;
		}
	}

	return json(res, 200, { ok: true, ...summary });
});
