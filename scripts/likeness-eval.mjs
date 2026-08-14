#!/usr/bin/env node
// Likeness eval runner: the by-hand half of the Phase 1 likeness harness.
//
// /api/cron/likeness-eval is the bounded weekly sweep that keeps the score
// table current. This is the tool for the jobs a 300-second cron cannot do:
// backfilling a whole scorer version, and proving the instrument end to end on
// real reconstructions produced on demand.
//
// Two modes.
//
//   --backfill[=N]   Score reconstructions the current scorer version has not
//                    measured yet, straight from the database, and file the
//                    results. Needs DATABASE_URL. This is the same work the
//                    cron does, without the budget ceiling.
//
//   --live=N         Run N reconstructions through the REAL production
//                    pipeline (sign in, POST /api/avatars/reconstruct with a
//                    portrait, poll to done) and score each finished avatar
//                    against the exact portrait it was built from. Needs
//                    AUDIT_EMAIL / AUDIT_PASSWORD. This is the mode that
//                    answers "does the number mean anything" on a deployment
//                    where the operator has no database access, because every
//                    artifact in it is real and produced during the run.
//
// Live mode uses SYNTHESISED subjects, never real people's photos. Each
// subject's portrait is a headshot render of a distinct avatar from the
// platform's own public library: a real image with a real, detectable face
// that belongs to nobody. That keeps real biometrics out of a benchmark which
// gets re-run and copied between machines, the same reasoning
// workers/avatar-reconstruction/eval/make_refs.py applies to its reference set,
// and it makes the run reproducible without depending on a text-to-image lane
// that can be rate-limited or down when the benchmark needs to run.
//
// A cross-subject control runs in both modes: every avatar is also scored
// against every OTHER subject's captures. A likeness number is only meaningful
// if the same instrument scores the wrong person materially lower, and the
// separation between the two distributions is printed with the results.
//
// Usage:
//   node --env-file=.env scripts/likeness-eval.mjs --live=10
//   node --env-file=.env scripts/likeness-eval.mjs --backfill=25
//   node --env-file=.env scripts/likeness-eval.mjs --live=4 --out=reports/run.json

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { cosineSimilarity, embedFace } from '../api/_lib/face-embed.js';
import {
	LIKENESS_VIEWS,
	SCORER_VERSION,
	SFACE_SAME_IDENTITY_COSINE,
	cosineToScore5,
	scoreLikeness,
} from '../api/_lib/likeness-score.js';
import {
	BENCHMARK_STATUS,
	creationIdForJob,
	likenessStoreEnabled,
	recordLikenessScore,
	unscoredReconstructions,
} from '../api/_lib/likeness-store.js';

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
const value = (name, fallback = null) => {
	const found = flag(name);
	if (!found) return fallback;
	const eq = found.indexOf('=');
	return eq < 0 ? true : found.slice(eq + 1);
};

const BASE_URL = String(value('base-url', process.env.BASE_URL || 'https://three.ws')).replace(/\/$/, '');
const OUT = value('out', null);

// Portrait framing for the synthesised subjects. A light background rather than
// the scoring renders' dark one, because the reconstruction pipeline's own
// background removal and face detection are tuned for ordinary photographs, and
// a portrait is an INPUT here, not something being measured.
const PORTRAIT_BACKGROUND = '#f2f2f2';
const PORTRAIT_SIZE = 768;

function log(...parts) {
	console.log(...parts);
}

// ── live mode: drive the real reconstruction pipeline ────────────────────────

async function login() {
	const email = process.env.AUDIT_EMAIL;
	const password = process.env.AUDIT_PASSWORD;
	if (!email || !password) {
		throw new Error('--live needs AUDIT_EMAIL and AUDIT_PASSWORD (they live in .env)');
	}
	const res = await fetch(`${BASE_URL}/api/auth/login`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ email, password }),
	});
	if (!res.ok) throw new Error(`login failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
	const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
	const jar = cookies.map((c) => c.split(';')[0]).join('; ');
	if (!jar) throw new Error('login returned no session cookie');
	return jar;
}

// One synthesised subject: a headshot render of a distinct avatar from the
// platform's public library, uploaded as the portrait a reconstruction is built
// from. Returns both the durable URL the pipeline was given and the same bytes,
// so the scorer compares against exactly what was submitted.
async function portraitFor(sourceAvatar) {
	const { renderAvatarScene, SCENE_PRESETS } = await import('../api/_lib/avatar-render.js');
	const { png } = await renderAvatarScene({
		glbUrl: `${BASE_URL}/api/avatars/${sourceAvatar.id}/model.glb`,
		width: PORTRAIT_SIZE,
		height: PORTRAIT_SIZE,
		background: PORTRAIT_BACKGROUND,
		cameraOrbit: { theta: 0, phi: 86 },
		scenePreset: SCENE_PRESETS.headshot,
	});
	return { png, dataUri: `data:image/png;base64,${png.toString('base64')}` };
}

async function sourceAvatars(count) {
	// Over-fetch: an avatar whose headshot has no detectable face cannot be a
	// subject, and dropping it is better than reconstructing from a portrait the
	// scorer will not be able to read either.
	const res = await fetch(`${BASE_URL}/api/avatars/public?limit=${Math.min(50, count * 3)}`);
	if (!res.ok) throw new Error(`public avatar list failed: HTTP ${res.status}`);
	const { avatars } = await res.json();
	if (!Array.isArray(avatars) || !avatars.length) throw new Error('no public avatars to build subjects from');
	return avatars;
}

async function submitReconstruction(jar, portrait, index) {
	const res = await fetch(`${BASE_URL}/api/avatars/reconstruct`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', cookie: jar },
		body: JSON.stringify({
			name: `Likeness eval subject ${index + 1}`,
			photos: [portrait.dataUri],
			visibility: 'private',
		}),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) {
		throw new Error(`reconstruct submit ${res.status}: ${(data.message || data.error || '').slice(0, 200)}`);
	}
	return data;
}

// The status endpoint deliberately returns only ids and the provider's
// temporary result URL, so the durable GLB comes from the avatar row it
// materialized.
async function durableGlbUrl(jar, avatarId) {
	const res = await fetch(`${BASE_URL}/api/avatars/${encodeURIComponent(avatarId)}`, {
		headers: { cookie: jar },
	});
	if (!res.ok) throw new Error(`avatar read ${res.status}`);
	const body = await res.json();
	const avatar = body.avatar || body;
	return avatar.glb_url || avatar.url || avatar.download_url || null;
}

async function pollReconstruction(jar, jobId, { timeoutMs = 10 * 60 * 1000, intervalMs = 6000 } = {}) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const res = await fetch(`${BASE_URL}/api/avatars/regenerate-status?jobId=${encodeURIComponent(jobId)}`, {
			headers: { cookie: jar },
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(`poll ${res.status}: ${(data.message || data.error || '').slice(0, 200)}`);
		if (data.status === 'done') return data;
		if (data.status === 'failed') throw new Error(`reconstruction failed: ${data.error || 'unknown'}`);
		await new Promise((r) => setTimeout(r, Math.min(intervalMs, Math.max(0, deadline - Date.now()))));
	}
	throw new Error(`reconstruction timed out after ${timeoutMs}ms`);
}

async function runLive(count) {
	const jar = await login();
	const pool = await sourceAvatars(count);
	log(`▶ live mode: ${count} reconstruction(s) through ${BASE_URL}\n`);

	const built = [];
	let poolIndex = 0;
	for (let i = 0; i < count && poolIndex < pool.length; i += 1) {
		const source = pool[poolIndex];
		poolIndex += 1;
		try {
			const portrait = await portraitFor(source);
			const submitted = await submitReconstruction(jar, portrait, i);
			log(`  [${i + 1}/${count}] ${source.slug}: submitted ${submitted.jobId} (${submitted.provider})`);
			const status = await pollReconstruction(jar, submitted.jobId);
			if (!status.resultAvatarId) throw new Error('finished job materialized no avatar');
			const glbUrl = await durableGlbUrl(jar, status.resultAvatarId);
			if (!glbUrl) throw new Error('finished avatar carried no GLB url');
			built.push({
				index: i,
				subject: source.slug,
				jobId: submitted.jobId,
				avatarId: status.resultAvatarId,
				glbUrl,
				// The portrait bytes themselves, not a URL: this is exactly what the
				// pipeline was handed, and it never has to be fetched back.
				captures: [portrait.png],
			});
			log(`  [${i + 1}/${count}] ${source.slug}: done`);
		} catch (err) {
			log(`  [${i + 1}/${count}] ${source.slug}: FAILED ${err.message}`);
			built.push({ index: i, subject: source.slug, error: String(err.message) });
		}
	}
	return built.filter((b) => b.glbUrl);
}

// ── backfill mode: score what the database says is unmeasured ────────────────

async function runBackfill(limit) {
	if (!likenessStoreEnabled()) throw new Error('--backfill needs DATABASE_URL');
	const subjects = await unscoredReconstructions({ limit });
	log(`▶ backfill mode: ${subjects.length} unscored reconstruction(s) for ${SCORER_VERSION}\n`);
	return subjects.map((s, i) => ({ ...s, index: i, subject: `creation ${s.creationId}` }));
}

// ── scoring + the cross-subject control ──────────────────────────────────────

// Every avatar scored against every OTHER subject's captures. Without this the
// headline numbers are unfalsifiable: a scorer that returned 0.8 for any two
// faces would look identical to a working one on the matched pairs alone.
async function crossControl(scored) {
	const usable = scored.filter((s) => s.headOnEmbedding && s.captureEmbeddings?.length);
	const sims = [];
	for (const a of usable) {
		for (const b of usable) {
			if (a.index === b.index) continue;
			const best = Math.max(...b.captureEmbeddings.map((e) => cosineSimilarity(a.headOnEmbedding, e)));
			sims.push(best);
		}
	}
	return sims;
}

async function fetchCaptureBytes(capture) {
	const str = String(capture);
	if (str.startsWith('data:')) {
		const comma = str.indexOf(',');
		return comma < 0 ? null : Buffer.from(str.slice(comma + 1), 'base64');
	}
	const res = await fetch(str);
	if (!res.ok) return null;
	return Buffer.from(await res.arrayBuffer());
}

// Re-derive the head-on embedding and the capture embeddings for the control.
// scoreLikeness deliberately does not return embeddings (they are biometric and
// must never reach a stored report), so the control computes its own inside
// this process and lets them fall out of scope with it.
async function embeddingsFor(subject) {
	const { renderAvatarScene, SCENE_PRESETS } = await import('../api/_lib/avatar-render.js');
	const headOn = LIKENESS_VIEWS.find((v) => v.label === 'head-on');
	try {
		const { png } = await renderAvatarScene({
			glbUrl: subject.glbUrl,
			width: 768,
			height: 768,
			background: '#14151a',
			cameraOrbit: { theta: headOn.theta, phi: 86 },
			scenePreset: SCENE_PRESETS.headshot,
		});
		const rendered = await embedFace(png);
		const captures = [];
		for (const capture of subject.captures) {
			// Backfill hands over URLs (what the job row stored); live mode hands over
			// the portrait bytes it just submitted. Both are valid captures.
			const bytes = Buffer.isBuffer(capture) ? capture : await fetchCaptureBytes(capture);
			if (!bytes) continue;
			const embedded = await embedFace(bytes);
			if (embedded) captures.push(embedded.embedding);
		}
		return { headOnEmbedding: rendered?.embedding ?? null, captureEmbeddings: captures };
	} catch {
		return { headOnEmbedding: null, captureEmbeddings: [] };
	}
}

function stats(values) {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const mean = values.reduce((a, b) => a + b, 0) / values.length;
	return {
		n: values.length,
		min: sorted[0],
		median: sorted[Math.floor(sorted.length / 2)],
		mean,
		max: sorted[sorted.length - 1],
	};
}

function fmt(n, digits = 3) {
	return Number.isFinite(n) ? n.toFixed(digits) : '  n/a';
}

async function main() {
	const liveArg = value('live', null);
	const backfillArg = value('backfill', null);
	if (!liveArg && !backfillArg) {
		console.error('Usage: node --env-file=.env scripts/likeness-eval.mjs --live=10 | --backfill[=25]');
		process.exitCode = 2;
		return;
	}

	const subjects = liveArg
		? await runLive(Math.max(1, Math.min(25, Number(liveArg) || 10)))
		: await runBackfill(Math.max(1, Math.min(100, Number(backfillArg) || 25)));

	if (!subjects.length) {
		log('nothing to score');
		return;
	}

	log(`\n▶ scoring ${subjects.length} subject(s) with ${SCORER_VERSION}\n`);
	const scored = [];
	for (const subject of subjects) {
		const result = await scoreLikeness({ glbUrl: subject.glbUrl, captures: subject.captures });
		const control = await embeddingsFor(subject);
		// A live subject IS a real generation record, because live mode submits a
		// real reconstruction. Leaving it unfiled does not keep it out of the
		// numbers, it just defers it: the next sweep finds an unscored creation
		// and counts it toward the gate rate like any user's avatar. So it is
		// filed deliberately, under BENCHMARK_STATUS, which the distribution's
		// `status = 'ok'` filter excludes from the gate maths while the outcome
		// breakdown still shows it. Backfill subjects keep their real status.
		let stored = false;
		let filedAs = null;
		if (likenessStoreEnabled()) {
			const target = subject.creationId
				? { creationId: subject.creationId, avatarId: subject.avatarId }
				: await creationIdForJob(subject.jobId);
			if (target?.creationId) {
				filedAs = liveArg ? BENCHMARK_STATUS : result.status;
				stored = await recordLikenessScore({
					creationId: target.creationId,
					avatarId: target.avatarId ?? subject.avatarId,
					jobId: subject.jobId,
					result: liveArg ? { ...result, status: BENCHMARK_STATUS } : result,
				});
			}
		}
		scored.push({ ...subject, result, ...control, stored });
		const views = result.views
			.map((v) => `${v.view}=${v.status === 'ok' ? fmt(v.cosine) : v.status}`)
			.join('  ');
		log(
			`  [${subject.index + 1}] ${result.status.padEnd(18)} ` +
				`score=${fmt(result.likenessScore, 2)}  cos=${fmt(result.identityCosine)}  ` +
				`falloff=${fmt(result.turnFalloff)}  ${stored ? `filed:${filedAs}` : 'not-filed'}\n` +
				`      ${views}`,
		);
	}

	const ok = scored.filter((s) => s.result.status === 'ok');
	const matched = ok.map((s) => s.result.identityCosine);
	const control = await crossControl(scored);

	const matchedStats = stats(matched);
	const controlStats = stats(control);
	const scores = ok.map((s) => s.result.likenessScore);
	const atGate = scores.filter((s) => s >= 4).length;

	log('\n── results ──────────────────────────────────────────────');
	log(`subjects scored        ${ok.length} / ${subjects.length}`);
	if (matchedStats) {
		log(`matched cosine         min=${fmt(matchedStats.min)} median=${fmt(matchedStats.median)} mean=${fmt(matchedStats.mean)} max=${fmt(matchedStats.max)}`);
	}
	if (controlStats) {
		log(`cross-subject control  min=${fmt(controlStats.min)} median=${fmt(controlStats.median)} mean=${fmt(controlStats.mean)} max=${fmt(controlStats.max)}`);
	}
	if (matchedStats && controlStats) {
		log(`separation (mean)      ${fmt(matchedStats.mean - controlStats.mean)}`);
	}
	log(`same-identity threshold ${fmt(SFACE_SAME_IDENTITY_COSINE)}  (score 3.0)`);
	log(`gate 4.0 corresponds to cosine ${fmt(cosineFor(4))}`);
	if (scores.length) {
		log(`likeness score         min=${fmt(Math.min(...scores), 2)} mean=${fmt(scores.reduce((a, b) => a + b, 0) / scores.length, 2)} max=${fmt(Math.max(...scores), 2)}`);
		log(`at or above 4/5 gate   ${atGate} / ${scores.length}`);
	}

	if (OUT) {
		const file = path.resolve(String(OUT));
		await mkdir(path.dirname(file), { recursive: true });
		await writeFile(
			file,
			`${JSON.stringify(
				{
					scorerVersion: SCORER_VERSION,
					baseUrl: BASE_URL,
					mode: liveArg ? 'live' : 'backfill',
					subjects: scored.map((s) => ({ index: s.index, subject: s.subject, stored: s.stored, result: s.result })),
					matched: matchedStats,
					control: controlStats,
				},
				null,
				2,
			)}\n`,
		);
		log(`\nreport written to ${file}`);
	}
}

// Inverse of cosineToScore5 at a given score, so the report can state the
// cosine the gate actually demands instead of leaving a reader to derive it.
function cosineFor(score5) {
	if (score5 <= 3) return ((score5 - 1) / 2) * SFACE_SAME_IDENTITY_COSINE;
	return SFACE_SAME_IDENTITY_COSINE + ((score5 - 3) / 2) * (1 - SFACE_SAME_IDENTITY_COSINE);
}

// Exit explicitly rather than letting the event loop drain. onnxruntime-web's
// WASM runtime keeps a handle open for the life of the process, so a run that
// has printed its whole report and finished writing --out still sits there
// forever: measured at 34 minutes of idle wall-clock after the last line, with
// the CPU clock frozen. Every await above has resolved by here, the report file
// included, so there is nothing left to flush.
main()
	.then(() => process.exit(process.exitCode ?? 0))
	.catch((err) => {
		console.error(`✗ ${err?.message || err}`);
		process.exit(1);
	});

export { cosineFor, cosineToScore5 };
