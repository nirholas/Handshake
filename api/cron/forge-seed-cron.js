// @ts-check
// GET /api/cron/forge-seed-cron — per-minute cron that grows the forge gallery
// with real AI-generated 3D avatars and accessories, each attributed to a fresh
// user account with an OG single-word username.
//
// Every invocation does two things in parallel and returns immediately — it
// never waits for a generation to finish, keeping execution well under 60 s:
//
//   1. Poll — check any pending seed jobs from prior minute(s). For each that
//      finished: copy the GLB into the avatars table (visibility=public) so the
//      creator has a real profile asset, then mark the job done.
//
//   2. Start — pick the next unused prompt from the 200+ library, claim an OG
//      username for a new user, submit a draft-tier forge job under that user's
//      client id, record the job so the next tick can poll it.
//
// Free NVIDIA NIM lane (draft, ~22 s) is always used — zero vendor spend.
// MAX_CONCURRENT_PENDING caps in-flight jobs so a slow lane never builds debt.

import { json, method, wrapCron } from '../_lib/http.js';
import { env } from '../_lib/env.js';
import { sql } from '../_lib/db.js';
import { constantTimeEquals } from '../_lib/crypto.js';
import { SEED_PROMPTS, OG_USERNAMES } from '../_lib/seed-prompts.js';
import { circuitState, circuitRecordFailure, circuitRecordSuccess } from '../_lib/forge-scale.js';
import { randomUUID } from 'node:crypto';

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
const MAX_CONCURRENT_PENDING = 3;
const MIN_JOB_AGE_SECONDS = 20;

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
async function insertSeedAvatar({ userId, prompt, modelCategory, creationId }) {
	if (!creationId) return;
	await sql`
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
			${JSON.stringify({ forge_creation_id: creationId, prompt, seed: true })}::jsonb,
			-- The creation's preview image is already in the bucket with a correct
			-- Content-Type (it is what /forge's own gallery renders). Adopt it as the
			-- avatar's thumbnail for free, rather than leaving thumbnail_key NULL and
			-- making the backfill cron pay chromium to re-render the same model.
			-- Relative keys only: an absolute URL in thumbnail_key resolves against an
			-- origin where no object lives (see api/_lib/avatar-thumbs.js).
			case when fc.preview_key !~ '^https?://' then fc.preview_key end,
			'public',
			array[${modelCategory}]::text[],
			${modelCategory},
			now(), now()
		from forge_creations fc
		where fc.id = ${creationId}
		  and fc.glb_key is not null
		  and fc.status = 'done'
		on conflict do nothing
	`;
}

// ── Phase 1: poll pending jobs ────────────────────────────────────────────────

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
				await insertSeedAvatar({
					userId: job.user_id,
					prompt: job.prompt,
					modelCategory: job.model_category,
					creationId,
				});

				await sql`
					update forge_seed_jobs
					set status = 'done',
					    creation_id = ${creationId},
					    glb_url = ${poll.body.glb_url},
					    finished_at = now()
					where id = ${job.id}
				`;
				results.push({ job_id: job.job_id, status: 'done', prompt: job.prompt });

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

// ── Phase 2: start next job ───────────────────────────────────────────────────

async function startNextJob(origin) {
	const [{ count }] = await sql`
		select count(*)::int as count from forge_seed_jobs where status = 'pending'
	`;
	if (count >= MAX_CONCURRENT_PENDING) {
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
	const available = SEED_PROMPTS.filter(p => !usedSet.has(p.prompt));
	const pool = available.length > 0 ? available : SEED_PROMPTS;
	const chosen = pool[Math.floor(Math.random() * pool.length)];

	// Claim an OG username. Try the bare word first; if taken, try word + 2,
	// word + 3 … up to word + 99 before falling back to word + short uuid hex.
	const baseWord = OG_USERNAMES[Math.floor(Math.random() * OG_USERNAMES.length)];
	const username = await claimUsername(baseWord);
	if (!username) {
		return { skipped: true, reason: 'could not claim OG username — will retry next tick' };
	}

	const rawClientId = randomUUID();
	// Display name is the word, capitalised — looks like a real account.
	const displayName = username.replace(/\d+$/, '').replace(/\b\w/g, c => c.toUpperCase());
	const email = `${username}@forge.three.ws`;

	const [user] = await sql`
		insert into users (email, display_name, username, plan, email_verified, created_at, updated_at)
		values (${email}, ${displayName}, ${username}, 'free', false, now(), now())
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
		body: JSON.stringify({ prompt: chosen.prompt, tier: 'draft', path: 'image' }),
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

	// The free NVIDIA draft lane finishes inline (~13–22 s) and returns the
	// finished model in the submit response with job_id:null — there is nothing
	// to poll. Attribute it to the synthetic user right now.
	if (submit.body?.status === 'done' && submit.body?.glb_url) {
		try {
			await insertSeedAvatar({
				userId: user.id,
				prompt: chosen.prompt,
				modelCategory: chosen.category,
				creationId,
			});
		} catch (err) {
			await sql`delete from users where id = ${user.id}`.catch(() => {});
			return { ok: false, reason: `avatar insert failed: ${err?.message}` };
		}
		await circuitRecordSuccess(CIRCUIT_NAME);
		await sql`
			insert into forge_seed_jobs
				(user_id, raw_client_id, job_id, prompt, model_category,
				 status, creation_id, glb_url, finished_at)
			values (${user.id}, ${rawClientId}, ${submit.body.job_id || 'sync-' + (creationId || randomUUID())},
			        ${chosen.prompt}, ${chosen.category}, 'done', ${creationId}, ${submit.body.glb_url}, now())
		`;
		return {
			ok: true,
			sync: true,
			creation_id: creationId,
			glb_url: submit.body.glb_url,
			prompt: chosen.prompt,
			category: chosen.category,
			username,
			user_id: user.id,
		};
	}

	// Otherwise the lane is asynchronous — record the job so the next tick polls it.
	if (submit.body?.job_id) {
		await circuitRecordSuccess(CIRCUIT_NAME);
		await sql`
			insert into forge_seed_jobs (user_id, raw_client_id, job_id, prompt, model_category)
			values (${user.id}, ${rawClientId}, ${submit.body.job_id}, ${chosen.prompt}, ${chosen.category})
		`;
		return {
			ok: true,
			job_id: submit.body.job_id,
			prompt: chosen.prompt,
			category: chosen.category,
			username,
			user_id: user.id,
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
	const [polled, started] = await Promise.all([
		pollPending(origin),
		startNextJob(origin),
	]);

	const finalized = polled.filter(j => j.status === 'done').length;
	const failed = polled.filter(j => j.status === 'failed').length;

	return json(res, 200, {
		ok: true,
		polled: polled.length,
		finalized,
		failed,
		poll_results: polled,
		new_job: started,
	});
});
