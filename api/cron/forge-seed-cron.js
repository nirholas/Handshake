// @ts-check
// GET /api/cron/forge-seed-cron — per-minute cron that grows the forge gallery
// with real AI-generated 3D avatars and accessories, each attributed to a fresh
// user account with an OG single-word username.
//
// Every invocation does two things in parallel and returns immediately — it
// never waits for a generation to finish, keeping execution well under 60 s:
//
//   1. Advance: move every open seed job one step along the pipeline. No step
//      ever blocks on the next, so a tick stays short no matter how slow a lane
//      is. The states, in order:
//
//        pending   → poll /api/forge; a finished mesh becomes `generated`
//        generated → run the catalog quality gate (api/_lib/seed-quality.js).
//                    A reject is quarantined under forge/rejected/ and never
//                    published; a keeper either goes to `rigging` or straight
//                    to publish.
//        rigging    → poll the auto-rig job; publish the rigged mesh when it
//                    lands, and publish the static keeper if the rig failed
//                    (a gated keeper is never thrown away over a rig fault).
//        done / rejected / failed / gate_error are terminal.
//
//   2. Start: pick the next unused prompt(s) from the library, claim an OG
//      username for a new user, submit a draft-tier forge job under that user's
//      client id, record the job so the next tick can poll it.
//
// Lane: the submit names no backend, so /api/forge's own free-first resolver
// picks it: which, with FORGE_SELFHOST_PRIMARY=1, is our own Cloud Run GPU
// fleet ahead of the hosted NVIDIA NIM allocation. Whichever lane runs, the
// backend is recorded on the job row and asserted free: a seed job must never
// silently spend on a paid third-party lane (see assertFreeBackend).
// maxPending() caps in-flight jobs so a slow lane never builds debt.
//
// ── Env knobs (every one defaults to the historical behaviour) ───────────────
//   SEED_CRON_BATCH        jobs to start per tick (default 1). Paced two at a
//                          time: submitting a whole batch at once is how the
//                          garment-forge runs used to silently drop jobs.
//   SEED_CRON_MAX_PENDING  in-flight ceiling (default 3 × batch).
//   SEED_CRON_VISION       '1' enables the render + Vertex judge stage of the
//                          quality gate inside the cron. Off by default: the
//                          function has a hard 70 s wall (vercel.json) and a
//                          history of 504s when a phase overruns, while a render
//                          plus two judge calls costs 10-20 s. The mesh stage of
//                          the gate always runs — it is deterministic, local, and
//                          costs only the GLB fetch. The bulk runner
//                          (scripts/gcp/seed-avatars.mjs) runs both.
//   SEED_CRON_VISION_MS    budget for the vision stage (default 20 000 ms).
//   SEED_CRON_GATE         jobs to gate per tick (default 2). Each costs one GLB
//                          fetch plus a mesh parse, so the ceiling keeps the
//                          tick inside its wall when a burst finishes at once.
//   SEED_CRON_RIG          '1' routes accepted avatars through the auto-rigger
//                          before publishing, so catalog entries arrive
//                          animation-ready instead of frozen in bind pose.

import { json, method, wrapCron } from '../_lib/http.js';
import { env } from '../_lib/env.js';
import { sql } from '../_lib/db.js';
import { SEED_PROMPTS, OG_USERNAMES, composeSeedPrompt } from '../_lib/seed-prompts.js';
import { evaluateSeedAsset, inProcessTransport, quarantineReject } from '../_lib/seed-quality.js';
import { getObjectBuffer, publicUrl } from '../_lib/r2.js';
import { isFreeBackend } from '../_lib/forge-tiers.js';
import { circuitState, circuitRecordFailure, circuitRecordSuccess } from '../_lib/forge-scale.js';
import { randomUUID } from 'node:crypto';
import { requireCron } from '../_lib/cron-auth.js';

const ORIGIN = () => env.APP_ORIGIN || 'https://three.ws';
// Must be comfortably shorter than the function's maxDuration (70 s in vercel.json)
// so fetchJson's AbortSignal.timeout fires and is caught BEFORE Vercel's hard kill
// fires its own DOMException[TimeoutError]. When the timeout fires, fetchJson returns
// { timedOut: true } — startNextJob treats that as a soft failure and rolls back
// the pending user so the next tick can retry cleanly.
//
// poll + submit run in parallel and each can hold a fetch for this long, with the
// per-job DB work (avatar insert, job upserts, user rollback) stacked on top inside
// the same 70 s window. At 48 s a worst-case fetch left too little headroom for that
// tail and the cron occasionally tipped past 70 s → a hard 504. The free NVIDIA
// draft lane returns inline in ~13–22 s, so 35 s still covers a healthy generation
// with wide margin while keeping the whole tick comfortably under the ceiling; a
// genuinely degraded lane simply rolls back and retries next minute.
const FETCH_TIMEOUT_MS = 35_000;
const MIN_JOB_AGE_SECONDS = 20;

// Env knobs. Read per call (never at module load) so a Cloud Run env update
// takes effect on the next tick without a redeploy, and so tests can set them.
function intEnv(name, fallback, { min = 1, max = 50 } = {}) {
	const raw = process.env[name];
	const n = raw == null || raw === '' ? NaN : Number(raw);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(min, Math.min(max, Math.floor(n)));
}
function boolEnv(name) {
	const raw = String(process.env[name] ?? '').trim().toLowerCase();
	return raw === '1' || raw === 'true' || raw === 'yes';
}

// Jobs started per tick. 1 is the historical behaviour, so an unset env is a
// no-op. Capped at 12: beyond that a single tick's DB tail stops fitting in the
// 70 s wall even with the submits paced.
export const seedBatchSize = () => intEnv('SEED_CRON_BATCH', 1, { min: 1, max: 12 });
// In-flight ceiling. Scales with the batch so a bigger batch isn't instantly
// throttled by a ceiling tuned for a batch of one.
export const maxPending = () => intEnv('SEED_CRON_MAX_PENDING', seedBatchSize() * 3, { min: 1, max: 200 });
// Two at a time: a whole batch fired at once is how bulk generation runs lose
// jobs (garment-forge incident) — the lane accepts the submits and drops work.
const SUBMIT_CONCURRENCY = 2;

const visionGateEnabled = () => boolEnv('SEED_CRON_VISION');
const visionGateBudgetMs = () => intEnv('SEED_CRON_VISION_MS', 20_000, { min: 5_000, max: 45_000 });
const rigStageEnabled = () => boolEnv('SEED_CRON_RIG');
// Gates per tick. Each one fetches the finished GLB and parses its glTF chunk;
// two keeps the phase in the low seconds even when a burst lands together.
const gateBatchSize = () => intEnv('SEED_CRON_GATE', 2, { min: 1, max: 10 });

// Circuit breaker — state is shared across instances via Redis (forge-scale.js) so
// every cron lambda sees the same open/closed decision; without that, each instance
// would rediscover a provider outage on its own and keep submitting into a dead
// lane. When CIRCUIT_THRESHOLD consecutive forge submits fail the circuit opens for
// (failures × CIRCUIT_BASE_MS) so the cron goes quiet during provider outages.
const CIRCUIT_NAME = 'forge-seed';
const CIRCUIT_THRESHOLD = 3;
const CIRCUIT_BASE_MS = 10 * 60_000; // 10 min × consecutive failures
const noteCircuitFailure = () =>
	circuitRecordFailure(CIRCUIT_NAME, { threshold: CIRCUIT_THRESHOLD, baseMs: CIRCUIT_BASE_MS });

async function fetchJson(url, options = {}) {
	let res;
	try {
		res = await fetch(url, {
			...options,
			headers: { 'user-agent': 'threews-forge-seed/1.0', ...options.headers },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
	} catch (err) {
		// AbortSignal.timeout fires a DOMException[TimeoutError]; treat it as a soft
		// failure so the cron can clean up and return 200 instead of propagating a
		// 500. Other network errors (DNS, ECONNREFUSED) are real failures — rethrow.
		if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
			return { status: 0, body: null, timedOut: true };
		}
		throw err;
	}
	let body = null;
	try { body = await res.json(); } catch { /* non-JSON — status is enough */ }
	return { status: res.status, body };
}

// Insert a public avatar row for a finished seed creation, attributed to the
// synthetic user. Reads the stored GLB straight from forge_creations and is
// idempotent (`on conflict do nothing`) so a re-poll never double-inserts.
// Bypasses plan quota — this is platform-seeded content, not a user upload.
//
// `creationId` is the row the mesh comes from — after the optional rig stage
// that is the rig creation, whose preview_key is null, so `previewCreationId`
// keeps pointing at the original generation's rendered preview.
//
// Returns the new avatars.id, or null when the creation row was not publishable
// (no glb_key / not done) and nothing was inserted.
async function insertSeedAvatar({
	userId,
	prompt,
	modelCategory,
	creationId,
	previewCreationId = null,
	gate = null,
	rigged = false,
}) {
	if (!creationId) return null;
	const previewId = previewCreationId || creationId;
	const meta = {
		forge_creation_id: creationId,
		prompt,
		seed: true,
		rigged,
		...(gate ? { quality_gate: gate } : {}),
	};
	const inserted = await sql`
		insert into avatars
			(owner_id, slug, name, description, storage_key, size_bytes,
			 content_type, source, source_meta, thumbnail_key, visibility, tags,
			 model_category, created_at, updated_at)
		select
			${userId},
			${toSlug(prompt)},
			${toTitle(prompt)},
			${'AI-generated ' + modelCategory + ' — forged on three.ws'},
			fc.glb_key,
			coalesce(fc.size_bytes, 0),
			'model/gltf-binary',
			'forge',
			${JSON.stringify(meta)}::jsonb,
			-- The creation's preview image is already in the bucket with a correct
			-- Content-Type (it is what /forge's own gallery renders). Adopt it as the
			-- avatar's thumbnail for free, rather than leaving thumbnail_key NULL and
			-- making the backfill cron pay chromium to re-render the same model.
			-- Relative keys only: an absolute URL in thumbnail_key resolves against an
			-- origin where no object lives (see api/_lib/avatar-thumbs.js).
			(select case when p.preview_key !~ '^https?://' then p.preview_key end
			   from forge_creations p where p.id = ${previewId}),
			'public',
			array[${modelCategory}]::text[],
			${modelCategory},
			now(), now()
		from forge_creations fc
		where fc.id = ${creationId}
		  and fc.glb_key is not null
		  and fc.status = 'done'
		on conflict do nothing
		returning id
	`;
	return inserted[0]?.id || null;
}

// ── Quality gate ──────────────────────────────────────────────────────────────

// Pull the finished mesh bytes. Prefer the bucket key (no egress, no redirect
// chain); fall back to the public URL for lanes that hand back an absolute URL.
async function loadGlbBytes({ creationId, glbUrl }) {
	if (creationId) {
		const [row] = await sql`select glb_key from forge_creations where id = ${creationId} limit 1`;
		const key = row?.glb_key;
		if (key && !/^https?:\/\//i.test(key)) {
			return { buf: await getObjectBuffer(key), key };
		}
		if (key) return { buf: Buffer.from(await (await fetch(key)).arrayBuffer()), key: null };
	}
	if (!glbUrl) throw new Error('no glb key or url to gate');
	const res = await fetch(glbUrl, { signal: AbortSignal.timeout(30_000) });
	if (!res.ok) throw new Error(`glb fetch ${res.status}`);
	return { buf: Buffer.from(await res.arrayBuffer()), key: null };
}

// Run the catalog gate on a finished generation. Returns the verdict plus the
// storage key, so a reject can be quarantined without re-reading the row.
async function gateCreation({ creationId, glbUrl, prompt, category, allowVision }) {
	const { buf, key } = await loadGlbBytes({ creationId, glbUrl });
	const transport = allowVision && visionGateEnabled() ? withDeadline(inProcessTransport(), visionGateBudgetMs()) : null;
	const verdict = await evaluateSeedAsset({
		glbBuffer: buf,
		glbUrl: glbUrl || null,
		prompt,
		category,
		transport,
	});
	return { verdict, glbKey: key };
}

// Wrap a transport so the whole vision stage shares one wall-clock budget. The
// cron's 70 s ceiling is hard; overrunning it costs a 504 and a lost tick, which
// is strictly worse than publishing on the mesh verdict alone.
function withDeadline(transport, budgetMs) {
	const deadline = Date.now() + budgetMs;
	const guard = async (fn, args) => {
		const left = deadline - Date.now();
		if (left <= 0) throw new Error('vision gate budget exhausted');
		return Promise.race([
			fn(args),
			new Promise((_, reject) => setTimeout(() => reject(new Error('vision gate budget exhausted')), left).unref?.()),
		]);
	};
	return {
		name: `${transport.name}+deadline`,
		render: (a) => guard(transport.render, a),
		judgeRealism: (a) => guard(transport.judgeRealism, a),
		judgeRigReadiness: (a) => guard(transport.judgeRigReadiness, a),
	};
}

// Seed generations must never leave the free lanes: this cron runs unattended
// every minute, so one silent fallthrough to a paid third-party engine bills the
// platform continuously with nobody watching. A paid lane is recorded on the row
// and reported, and the asset is still published (the spend already happened, 
// throwing the mesh away would waste it twice), but the reason string makes the
// fallthrough visible in the tick's response and in the accept-rate report.
function assertFreeBackend(backend) {
	if (!backend) return null;
	return isFreeBackend(backend) ? null : `paid_lane:${backend}`;
}

// ── Phase 1a: poll in-flight generations ─────────────────────────────────────
//
// A finished generation becomes 'generated', not 'done': the mesh exists but has
// not faced the catalog gate yet. Publishing happens only after advanceGates().
async function pollPending(origin) {
	const rows = await sql`
		select id, user_id, raw_client_id, job_id, prompt, model_category
		from forge_seed_jobs
		where status = 'pending'
		  and started_at < now() - (${MIN_JOB_AGE_SECONDS} || ' seconds')::interval
		order by started_at asc
		limit 10
	`;
	if (!rows.length) return [];

	const results = [];
	await Promise.all(rows.map(async (job) => {
		try {
			const cronSecret = process.env.CRON_SECRET || env.CRON_SECRET || '';
			const poll = await fetchJson(
				`${origin}/api/forge?job=${encodeURIComponent(job.job_id)}`,
				{ headers: { 'x-forge-client': job.raw_client_id, 'x-forge-seed': cronSecret } },
			);

			if (poll.body?.status === 'done' && poll.body.glb_url) {
				const creationId = poll.body.creation_id ?? null;
				const backend = poll.body.backend || null;
				await sql`
					update forge_seed_jobs
					set status = 'generated',
					    creation_id = ${creationId},
					    glb_url = ${poll.body.glb_url},
					    backend = ${backend}
					where id = ${job.id}
				`;
				results.push({
					job_id: job.job_id,
					status: 'generated',
					backend,
					prompt: job.prompt,
					...(assertFreeBackend(backend) ? { warning: assertFreeBackend(backend) } : {}),
				});

			} else if (poll.body?.status === 'failed') {
				await sql`
					update forge_seed_jobs
					set status = 'failed',
					    error = ${(poll.body.error || 'generation failed').slice(0, 500)},
					    finished_at = now()
					where id = ${job.id}
				`;
				results.push({ job_id: job.job_id, status: 'failed', prompt: job.prompt });
			} else {
				results.push({ job_id: job.job_id, status: poll.body?.status || 'running' });
			}
		} catch (err) {
			results.push({ job_id: job.job_id, status: 'poll_error', error: err?.message });
		}
	}));

	return results;
}

// ── Phase 1b: gate finished generations, then publish or quarantine ──────────

async function advanceGates(origin) {
	const rows = await sql`
		select id, user_id, raw_client_id, prompt, model_category, creation_id, glb_url, backend
		from forge_seed_jobs
		where status = 'generated'
		order by started_at asc
		limit ${gateBatchSize()}
	`;
	if (!rows.length) return [];

	const results = [];
	for (const job of rows) {
		try {
			const { verdict, glbKey } = await gateCreation({
				creationId: job.creation_id,
				glbUrl: job.glb_url,
				prompt: job.prompt,
				category: job.model_category,
				allowVision: true,
			});

			if (!verdict.accepted) {
				const quarantine = await quarantineReject({
					id: job.creation_id || job.id,
					glbKey,
					glbUrl: job.glb_url,
					prompt: job.prompt,
					category: job.model_category,
					verdict,
					extra: { source: 'forge-seed-cron', backend: job.backend },
				});
				await sql`
					update forge_seed_jobs
					set status = 'rejected',
					    gate = ${JSON.stringify(verdict)}::jsonb,
					    gate_reasons = ${verdict.reasons}::text[],
					    error = ${verdict.reasons.join(',').slice(0, 500)},
					    finished_at = now()
					where id = ${job.id}
				`;
				results.push({
					job_id: job.id,
					status: 'rejected',
					reasons: verdict.reasons,
					quarantined: quarantine.modelCopied,
					prompt: job.prompt,
				});
				continue;
			}

			// A keeper. Rig first when the stage is on and the mesh is not already
			// skinned; otherwise publish straight away.
			if (rigStageEnabled() && !verdict.mesh.rigged && job.model_category !== 'accessory') {
				const rig = await startRigStage({ origin, job });
				if (rig.jobId) {
					await sql`
						update forge_seed_jobs
						set status = 'rigging',
						    gate = ${JSON.stringify(verdict)}::jsonb,
						    rig_job_id = ${rig.jobId},
						    rig_creation_id = ${rig.creationId}
						where id = ${job.id}
					`;
					results.push({ job_id: job.id, status: 'rigging', prompt: job.prompt });
					continue;
				}
				// Rigger unavailable: publish the static keeper rather than stall it.
			}

			const avatarId = await publishSeedAvatar({ job, verdict, rigged: false });
			results.push({ job_id: job.id, status: 'published', avatar_id: avatarId, prompt: job.prompt });

		} catch (err) {
			// The gate itself broke (storage read, renderer, judge transport). That is
			// infrastructure, not a quality verdict, so the row is parked in its own
			// terminal state and never counted against the accept rate.
			await sql`
				update forge_seed_jobs
				set status = 'gate_error',
				    error = ${String(err?.message || err).slice(0, 500)},
				    finished_at = now()
				where id = ${job.id}
			`;
			results.push({ job_id: job.id, status: 'gate_error', error: String(err?.message || err).slice(0, 200) });
		}
	}
	return results;
}

// Publish a gated keeper and close the job out. Shared by the direct path and
// the post-rig path so the avatar row is written in exactly one place.
async function publishSeedAvatar({ job, verdict, rigged, rigCreationId = null }) {
	const avatarId = await insertSeedAvatar({
		userId: job.user_id,
		prompt: job.prompt,
		modelCategory: job.model_category,
		creationId: rigged && rigCreationId ? rigCreationId : job.creation_id,
		previewCreationId: job.creation_id,
		gate: gateSummary(verdict),
		rigged,
	});
	await sql`
		update forge_seed_jobs
		set status = 'done',
		    avatar_id = ${avatarId},
		    finished_at = now()
		where id = ${job.id}
	`;
	return avatarId;
}

// The slice of the verdict worth carrying on the avatar row forever. The full
// object (every judge score, every render note) stays on forge_seed_jobs.gate.
// source_meta is read on every avatar detail render, so it gets the summary.
function gateSummary(verdict) {
	if (!verdict) return null;
	return {
		version: verdict.gateVersion,
		accepted: verdict.accepted,
		mesh_flag: verdict.mesh?.flag ?? null,
		mesh_score: verdict.mesh?.score ?? null,
		vision: verdict.vision?.status ?? 'skipped',
		...(verdict.vision?.mean != null ? { vision_mean: verdict.vision.mean } : {}),
	};
}

// ── Phase 1c: rig stage ──────────────────────────────────────────────────────

// Submit the accepted mesh to the auto-rigger. Returns { jobId, creationId } on
// a successful submit, or { jobId: null } when no rig lane is live, the caller
// publishes the static keeper in that case rather than stalling it.
async function startRigStage({ origin, job }) {
	const cronSecret = process.env.CRON_SECRET || env.CRON_SECRET || '';
	const glbUrl = await publishableGlbUrl(job);
	if (!glbUrl) return { jobId: null, reason: 'no public glb url' };

	const submit = await fetchJson(`${origin}/api/forge?action=rig`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-forge-client': job.raw_client_id,
			'x-forge-seed': cronSecret,
		},
		body: JSON.stringify({ glb_url: glbUrl }),
	});
	if (submit.status !== 200 || !submit.body?.job_id) {
		console.warn(`[forge-seed] rig submit ${submit.status}: ${submit.body?.error || 'no job id'}`);
		return { jobId: null, reason: `rig submit ${submit.status}` };
	}
	return { jobId: submit.body.job_id, creationId: submit.body.creation_id ?? null };
}

// The rigger fetches the mesh over HTTPS, so a bucket-relative glb_key has to be
// resolved to its CDN URL first. Lanes that already hand back an absolute URL
// pass straight through.
async function publishableGlbUrl(job) {
	if (job.glb_url && /^https?:\/\//i.test(job.glb_url)) return job.glb_url;
	if (!job.creation_id) return null;
	const [row] = await sql`select glb_key from forge_creations where id = ${job.creation_id} limit 1`;
	const key = row?.glb_key;
	if (!key) return null;
	return /^https?:\/\//i.test(key) ? key : publicUrl(key);
}

async function advanceRigs(origin) {
	const rows = await sql`
		select id, user_id, raw_client_id, prompt, model_category, creation_id, glb_url,
		       rig_job_id, rig_creation_id, gate
		from forge_seed_jobs
		where status = 'rigging'
		order by started_at asc
		limit 10
	`;
	if (!rows.length) return [];

	const cronSecret = process.env.CRON_SECRET || env.CRON_SECRET || '';
	const results = [];
	await Promise.all(rows.map(async (job) => {
		try {
			const poll = await fetchJson(
				`${origin}/api/forge?job=${encodeURIComponent(job.rig_job_id)}`,
				{ headers: { 'x-forge-client': job.raw_client_id, 'x-forge-seed': cronSecret } },
			);

			if (poll.body?.status === 'done' && poll.body.glb_url) {
				const rigCreationId = poll.body.creation_id ?? job.rig_creation_id;
				const avatarId = await publishSeedAvatar({
					job,
					verdict: job.gate,
					rigged: true,
					rigCreationId,
				});
				results.push({ job_id: job.id, status: 'published', rigged: true, avatar_id: avatarId });

			} else if (poll.body?.status === 'failed' || poll.status >= 400) {
				// The mesh already passed the gate. A rig fault must not cost the
				// catalog the asset: publish it static and say so on the row.
				const avatarId = await publishSeedAvatar({ job, verdict: job.gate, rigged: false });
				await sql`
					update forge_seed_jobs
					set error = ${('rig failed: ' + (poll.body?.error || poll.status)).slice(0, 500)}
					where id = ${job.id}
				`;
				results.push({ job_id: job.id, status: 'published', rigged: false, avatar_id: avatarId });
			} else {
				results.push({ job_id: job.id, status: 'rigging' });
			}
		} catch (err) {
			results.push({ job_id: job.id, status: 'rig_poll_error', error: String(err?.message || err).slice(0, 200) });
		}
	}));
	return results;
}

// ── Phase 2: start new generations ───────────────────────────────────────────

// Start up to seedBatchSize() generations this tick, paced SUBMIT_CONCURRENCY at
// a time. A whole batch fired at once is how bulk generation runs lose work (the
// garment-forge incident): the lane accepts every submit and quietly drops the
// overflow. `claimed` carries the prompts already taken this tick so two lanes in
// the same batch never race onto the same prompt.
async function startBatch(origin) {
	const size = seedBatchSize();
	const claimed = new Set();
	const results = [];
	let stop = false;

	const worker = async () => {
		while (!stop && results.length < size) {
			const outcome = await startNextJob(origin, claimed);
			results.push(outcome);
			// A ceiling or an open circuit applies to the whole tick, not just this
			// submit: keep going and every sibling submit hits the same wall.
			if (outcome?.skipped) stop = true;
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(SUBMIT_CONCURRENCY, size) }, worker),
	);
	return results.slice(0, size);
}

async function startNextJob(origin, claimed = new Set()) {
	const [{ count }] = await sql`
		select count(*)::int as count from forge_seed_jobs where status = 'pending'
	`;
	if (count >= maxPending()) {
		return { skipped: true, reason: `${count} jobs already pending` };
	}

	const circuit = await circuitState(CIRCUIT_NAME);
	if (circuit.open) {
		const minsLeft = Math.ceil((circuit.openUntil - Date.now()) / 60_000);
		return {
			skipped: true,
			reason: `circuit open for ${minsLeft}m more (${circuit.failures} consecutive failures)`,
		};
	}

	// Pick next prompt — avoid recently used ones so the full library cycles
	// before any prompt repeats.
	const recent = await sql`
		select prompt from forge_seed_jobs order by started_at desc limit ${SEED_PROMPTS.length}
	`;
	const usedSet = new Set(recent.map(r => r.prompt));
	const available = SEED_PROMPTS.filter(p => !usedSet.has(p.prompt) && !claimed.has(p.prompt));
	const fallback = SEED_PROMPTS.filter(p => !claimed.has(p.prompt));
	const pool = available.length > 0 ? available : (fallback.length > 0 ? fallback : SEED_PROMPTS);
	const chosen = pool[Math.floor(Math.random() * pool.length)];
	claimed.add(chosen.prompt);

	// Claim an OG username. Try the bare word first; if taken, try word + 2,
	// word + 3 … up to word + 99 before falling back to word + short uuid hex.
	const baseWord = OG_USERNAMES[Math.floor(Math.random() * OG_USERNAMES.length)];
	const username = await claimUsername(baseWord);
	if (!username) {
		return { skipped: true, reason: 'could not claim OG username — will retry next tick' };
	}

	const rawClientId = randomUUID();
	// Display name is the word, capitalised — looks like a real account. Drop
	// claimUsername's collision suffixes (`_xxxx` uuid fallback, numbered slot)
	// first; stripping digits alone turned "fog_1a2b" into "Fog_".
	const displayName = username
		.replace(/_[0-9a-f]{4}$/, '')
		.replace(/\d+$/, '')
		.replace(/\b\w/g, c => c.toUpperCase());
	const email = `${username}@forge.three.ws`;

	const [user] = await sql`
		insert into users (email, display_name, username, plan, email_verified, service_account, created_at, updated_at)
		values (${email}, ${displayName}, ${username}, 'free', false, true, now(), now())
		on conflict do nothing
		returning id
	`;
	if (!user?.id) {
		return { skipped: true, reason: 'user insert conflict — will retry next tick' };
	}

	const cronSecret = process.env.CRON_SECRET || env.CRON_SECRET || '';
	const submit = await fetchJson(`${origin}/api/forge`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-forge-client': rawClientId,
			'x-forge-seed': cronSecret,
		},
		// composeSeedPrompt appends the rig-readiness framing (full body, arms clear
		// of the torso, neutral stance, plain background) the auto-rigger needs. The
		// library string is what gets STORED, so the "recently used" de-duplication
		// and the batch runner's checkpoint keys stay keyed on the bare prompt.
		//
		// A fresh seed per submit is load-bearing, not a nicety: /api/forge caches a
		// finished result under (path, tier, backend, prompt, seed), so once the
		// library wraps around, a repeated prompt with no seed would serve the cached
		// mesh and mint a SECOND catalog avatar pointing at the very same GLB. The
		// seed makes every wrap-around generation a genuinely new asset.
		body: JSON.stringify({
			prompt: composeSeedPrompt(chosen),
			tier: 'draft',
			path: 'image',
			seed: freshSeed(),
		}),
	});

	if (submit.timedOut) {
		await noteCircuitFailure();
		await sql`delete from users where id = ${user.id}`.catch(() => {});
		return { ok: false, reason: 'forge submit timed out — will retry next tick' };
	}

	if (submit.status !== 200) {
		await noteCircuitFailure();
		await sql`delete from users where id = ${user.id}`.catch(() => {});
		return {
			ok: false,
			reason: `forge submit ${submit.status}: ${submit.body?.error_description || submit.body?.error || 'no body'}`,
		};
	}

	const creationId = submit.body?.creation_id ?? null;

	const backend = submit.body?.backend || null;

	// Some lanes finish inline (the self-host TRELLIS worker when warm, the free
	// NVIDIA draft lane) and return the finished model in the submit response with
	// job_id:null, so there is nothing to poll. The mesh still has to face the
	// catalog gate before it is published, so the row lands as 'generated' and
	// next tick's gate phase decides: it is never published straight off a submit.
	if (submit.body?.status === 'done' && submit.body?.glb_url) {
		await circuitRecordSuccess(CIRCUIT_NAME);
		await sql`
			insert into forge_seed_jobs
				(user_id, raw_client_id, job_id, prompt, model_category,
				 status, creation_id, glb_url, backend)
			values (${user.id}, ${rawClientId}, ${submit.body.job_id || 'sync-' + (creationId || randomUUID())},
			        ${chosen.prompt}, ${chosen.category}, 'generated', ${creationId}, ${submit.body.glb_url}, ${backend})
		`;
		return {
			ok: true,
			sync: true,
			creation_id: creationId,
			glb_url: submit.body.glb_url,
			prompt: chosen.prompt,
			category: chosen.category,
			backend,
			username,
			user_id: user.id,
			...(assertFreeBackend(backend) ? { warning: assertFreeBackend(backend) } : {}),
		};
	}

	// Otherwise the lane is asynchronous — record the job so the next tick polls it.
	if (submit.body?.job_id) {
		await circuitRecordSuccess(CIRCUIT_NAME);
		await sql`
			insert into forge_seed_jobs (user_id, raw_client_id, job_id, prompt, model_category, backend)
			values (${user.id}, ${rawClientId}, ${submit.body.job_id}, ${chosen.prompt}, ${chosen.category}, ${backend})
		`;
		return {
			ok: true,
			job_id: submit.body.job_id,
			prompt: chosen.prompt,
			category: chosen.category,
			backend,
			username,
			user_id: user.id,
			...(assertFreeBackend(backend) ? { warning: assertFreeBackend(backend) } : {}),
		};
	}

	// Neither a finished model nor a poll token — a genuine failure.
	await noteCircuitFailure();
	await sql`delete from users where id = ${user.id}`.catch(() => {});
	return {
		ok: false,
		reason: `forge submit returned no job_id and status=${submit.body?.status || 'unknown'}`,
	};
}

// Try to claim `word` as a username. Returns the claimed username string or null.
async function claimUsername(word) {
	// Check which variants already exist so we skip to the next free slot.
	const existing = await sql`
		select username from users
		where username = ${word}
		   or username like ${word + '%'}
		limit 100
	`;
	const taken = new Set(existing.map(r => r.username));

	if (!taken.has(word)) return word;
	for (let n = 2; n <= 99; n++) {
		const candidate = `${word}${n}`;
		if (!taken.has(candidate)) return candidate;
	}
	// All numbered variants taken — fall back to word + short hex (rare).
	return `${word}_${randomUUID().slice(0, 4)}`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toSlug(prompt) {
	const base = prompt
		.toLowerCase()
		.replace(/^(a|an|the)\s+/i, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 48);
	return `${base}-${randomUUID().slice(0, 6)}`;
}

// A uniformly random uint32, the range every provider RNG accepts
// (api/_lib/forge-options.js SEED_MAX).
function freshSeed() {
	return Math.floor(Math.random() * 4_294_967_296);
}

function toTitle(prompt) {
	const trimmed = prompt.replace(/^(a|an|the)\s+/i, '');
	const firstComma = trimmed.indexOf(',');
	const base = firstComma > 0 ? trimmed.slice(0, firstComma) : trimmed;
	return base.replace(/\b\w/g, c => c.toUpperCase()).slice(0, 80);
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET'])) return;
	if (!requireCron(req, res)) return;

	const origin = ORIGIN();
	// Every phase advances a different set of rows, so they are safe to run
	// together and the tick costs one phase's wall-clock, not four in series.
	const [polled, gated, rigged, started] = await Promise.all([
		pollPending(origin),
		advanceGates(origin),
		advanceRigs(origin),
		startBatch(origin),
	]);

	const advanced = [...gated, ...rigged];
	const published = advanced.filter(j => j.status === 'published').length;
	const rejected = advanced.filter(j => j.status === 'rejected').length;
	const failed = polled.filter(j => j.status === 'failed').length;

	return json(res, 200, {
		ok: true,
		polled: polled.length,
		published,
		rejected,
		failed,
		accept_rate: await recentAcceptRate(),
		poll_results: polled,
		gate_results: gated,
		rig_results: rigged,
		new_jobs: started,
	});
});

// Rolling accept rate over the last 24 h of gated seed jobs. Published vs
// rejected only: a generation that never reached the gate (failed upstream) and
// a gate that could not run (gate_error) are infrastructure, not curation, and
// counting them would understate how good the prompts actually are.
async function recentAcceptRate() {
	try {
		const [row] = await sql`
			select
				count(*) filter (where status = 'done')::int      as accepted,
				count(*) filter (where status = 'rejected')::int  as rejected
			from forge_seed_jobs
			where started_at > now() - interval '24 hours'
			  and status in ('done', 'rejected')
		`;
		const total = (row?.accepted || 0) + (row?.rejected || 0);
		return {
			window: '24h',
			accepted: row?.accepted || 0,
			rejected: row?.rejected || 0,
			rate: total > 0 ? Number(((row.accepted / total) * 100).toFixed(1)) : null,
		};
	} catch {
		return null;
	}
}
