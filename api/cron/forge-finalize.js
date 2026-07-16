// GET /api/cron/forge-finalize: server-side completion for forge generations.
//
// Historically a forge_creations row only flipped from 'generating' to
// 'done'/'failed' when the creator's browser polled GET /api/forge?job=… to
// completion (materializeCreation runs inside that poll). Close the tab and the
// generation is orphaned at 'generating' forever, even though the GPU worker
// finished and the GLB is sitting in GCS. This cron makes completion
// server-authoritative so users can leave the page mid-generation:
//
//   1. Sweep 'generating' rows older than GRACE (the browser poll path gets
//      first shot: most generations still finish attended).
//   2. Rows whose replicate_job_id is a GCP worker envelope (the async
//      self-host lanes: trellis_selfhost, hunyuan3d, sketch/triposg: exactly
//      the minutes-long lanes that get orphaned) are polled directly on the
//      worker. done → materializeCreation (same durable-copy writer the
//      browser poll uses, so gallery/showcase/streaks all light up
//      identically). failed → markFailed.
//   3. Anything still not terminal after HARD_TTL is marked failed as timed
//      out, so no row is ever stuck at 'generating' forever. Envelope rows are
//      still polled once first: recovering a finished model always beats
//      declaring it dead.
//   4. A creation finalized here completed UNATTENDED: the user wasn't
//      watching: so this is the one place completion notifications fire
//      (bell + push + email via api/_lib/forge-notify). The attended path
//      never notifies: the result is already on screen.
//
// Idempotent + swarm-safe: materializeCreation short-circuits on already-done
// rows, markFailed is guarded by status != 'done', and the batch is bounded so
// overlapping ticks just split the work.
//
// Auth: CRON_SECRET header, same pattern as every other cron in /api/cron/.

import { sql } from '../_lib/db.js';
import { cors, json, wrapCron } from '../_lib/http.js';
import { constantTimeEquals } from '../_lib/crypto.js';
import { materializeCreation, markFailed, forgeStoreEnabled } from '../_lib/forge-store.js';
import { notifyForgeComplete, notifyForgeFailed } from '../_lib/forge-notify.js';
import { createRegenProvider as createGcpProvider } from '../_providers/gcp.js';

export const maxDuration = 60;

const BATCH_LIMIT = Number(process.env.FORGE_FINALIZE_BATCH) || 25;
// Leave fresh rows to the attended browser poll path.
const GRACE_MINUTES = 2;
// Past this age a non-terminal generation is declared dead. The slowest real
// lane (self-host TRELLIS high tier behind a full queue) finishes well inside
// 30 minutes; beyond it the worker task has been evicted or lost.
const HARD_TTL_MINUTES = 45;

function requireCron(req, res) {
	const secret = process.env.CRON_SECRET;
	if (!secret) return false; // allow in dev if no secret set
	const provided = req.headers['x-cron-secret'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
	if (!provided || !constantTimeEquals(provided, secret)) {
		res.writeHead(401, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ error: 'unauthorized' }));
		return true; // handled
	}
	return false;
}

// The async GCP worker lanes wrap their upstream task in a base64url JSON
// envelope ({ mode, taskId, baseUrl, resultKey }): see api/_providers/gcp.js.
// That shape is the reliable discriminator between "a worker we can poll" and
// an opaque third-party id (Replicate prediction, HF job) we cannot.
export function decodeWorkerEnvelope(replicateJobId) {
	try {
		const obj = JSON.parse(Buffer.from(String(replicateJobId), 'base64url').toString('utf8'));
		return obj?.taskId && obj?.baseUrl ? obj : null;
	} catch {
		return null;
	}
}

export default wrapCron(async (req, res) => {
	cors(req, res, { methods: 'GET,POST,OPTIONS' });
	if (req.method?.toUpperCase() === 'OPTIONS') return;
	if (requireCron(req, res)) return;
	if (!forgeStoreEnabled()) {
		return json(res, 200, { enabled: false, swept: 0 });
	}

	const t0 = Date.now();

	const rows = await sql`
		select id, replicate_job_id, client_key, user_id, prompt, preview_image_url,
			backend, tier, created_at
		from forge_creations
		where status = 'generating'
			and replicate_job_id is not null
			and created_at < now() - (${GRACE_MINUTES} * interval '1 minute')
		order by created_at asc
		limit ${BATCH_LIMIT}
	`;

	let gcp = null;
	try {
		gcp = createGcpProvider();
	} catch {
		// No GCP_RECONSTRUCTION_KEY on this deployment: envelope rows can't be
		// polled here; the hard TTL below still reaps them.
	}

	const out = { done: 0, failed: 0, timed_out: 0, still_running: 0, unpollable: 0 };

	for (const row of rows) {
		const ageMinutes = (Date.now() - Date.parse(row.created_at)) / 60_000;
		const envelope = decodeWorkerEnvelope(row.replicate_job_id);

		if (envelope && gcp) {
			const status = await gcp.status(row.replicate_job_id).catch(() => null);

			if (status?.status === 'done' && status.resultGlbUrl) {
				const durable = await materializeCreation({
					replicateJobId: row.replicate_job_id,
					clientKey: row.client_key,
					glbUrl: status.resultGlbUrl,
				});
				if (durable) {
					out.done++;
					if (row.user_id) {
						notifyForgeComplete({
							userId: row.user_id,
							creationId: durable.id,
							prompt: row.prompt,
							previewImageUrl: durable.previewImageUrl ?? row.preview_image_url ?? null,
						});
					}
					continue;
				}
				// Copy-to-durable failed (transient storage/network): leave the row
				// for the next tick rather than failing a finished model.
				out.still_running++;
				continue;
			}

			if (status?.status === 'failed') {
				await markFailed({
					replicateJobId: row.replicate_job_id,
					clientKey: row.client_key,
					error: status.error || 'generation failed',
				});
				out.failed++;
				if (row.user_id) {
					notifyForgeFailed({ userId: row.user_id, prompt: row.prompt, error: status.error });
				}
				continue;
			}

			// queued / running / poll blip: fall through to the TTL check.
		} else if (!envelope) {
			out.unpollable++;
		}

		if (ageMinutes > HARD_TTL_MINUTES) {
			await markFailed({
				replicateJobId: row.replicate_job_id,
				clientKey: row.client_key,
				error: `generation timed out after ${Math.round(ageMinutes)} minutes`,
			});
			out.timed_out++;
			if (row.user_id) {
				notifyForgeFailed({ userId: row.user_id, prompt: row.prompt, error: 'generation timed out' });
			}
		} else if (envelope) {
			out.still_running++;
		}
	}

	return json(res, 200, {
		enabled: true,
		swept: rows.length,
		...out,
		elapsed_ms: Date.now() - t0,
	});
});
