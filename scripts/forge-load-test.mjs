// Load-test the /forge generation pipeline THROUGH THE ROUTER, not the workers.
//
// Direct worker curl proves nothing about what a user experiences: it skips lane
// selection, the health-aware router, the failover chain, the rate limiter, and
// the in-flight coalescer. This fires N concurrent real generations at
// POST /api/forge, polls each to a finished GLB, and verifies that GLB actually
// parses with geometry. A job that stops answering without a terminal status is
// recorded as a silent drop, which is the defect class this exists to catch.
//
// Every prompt is unique on purpose: identical (path, tier, backend, prompt)
// submits inside the 6-minute window collapse into ONE job by design
// (api/_lib/forge-scale.js#forgeRequestHash), which would make a load test of 10
// look like a load test of 1.
//
// Usage:
//   node scripts/forge-load-test.mjs                       # 10 jobs at https://three.ws
//   node scripts/forge-load-test.mjs --n 6 --origin http://localhost:3000
//   node scripts/forge-load-test.mjs --tiers draft,standard

import { inspectGlb, isValidGlbHeader } from '../api/_lib/glb-inspect.js';

function arg(name, fallback) {
	const i = process.argv.indexOf(`--${name}`);
	return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const ORIGIN = String(arg('origin', 'https://three.ws')).replace(/\/+$/, '');
const N = Math.max(1, Number(arg('n', 10)) || 10);
const TIERS = String(arg('tiers', 'draft,standard'))
	.split(',')
	.map((t) => t.trim())
	.filter(Boolean);
const POLL_MS = 3000;
const MAX_WAIT_MS = 12 * 60 * 1000; // matches every in-repo forge poll ceiling

// Distinct, concrete single-object subjects. Concrete prompts are what the free
// lanes reconstruct best, so the test measures the pipeline rather than prompt
// quality. The run stamp keeps prompts unique across repeat runs too, so a
// second run is never served from the content-addressed result cache.
const STAMP = process.env.FORGE_LOAD_STAMP || String(process.hrtime.bigint()).slice(-6);
const SUBJECTS = [
	'a weathered brass compass',
	'a carved wooden owl statue',
	'a chipped ceramic teapot',
	'a coiled climbing rope',
	'a vintage film camera',
	'a stack of leather books',
	'a copper watering can',
	'a folded paper crane',
	'a rusted iron lantern',
	'a woven wicker basket',
	'a polished granite mortar',
	'a bronze desk bell',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (sorted, p) => {
	if (!sorted.length) return null;
	const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
	return sorted[i];
};

async function runOne(index) {
	const tier = TIERS[index % TIERS.length];
	const prompt = `${SUBJECTS[index % SUBJECTS.length]}, ${STAMP}${index}`;
	const clientId = `loadtest-${STAMP}-${index}`;
	const started = Date.now();
	const rec = {
		index,
		tier,
		prompt,
		backend: null,
		failoverFrom: null,
		coldStart: false,
		submitStatus: null,
		queuedPolls: 0,
		outcome: 'pending',
		elapsedMs: null,
		glbUrl: null,
		meshes: null,
		note: '',
	};

	let submit;
	try {
		const res = await fetch(`${ORIGIN}/api/forge`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-forge-client': clientId },
			body: JSON.stringify({ prompt, tier }),
		});
		rec.submitStatus = res.status;
		submit = await res.json().catch(() => ({}));
		if (!res.ok) {
			rec.outcome = res.status === 429 ? 'rate_limited' : 'submit_failed';
			rec.note = String(submit.message || submit.error || `HTTP ${res.status}`).slice(0, 120);
			rec.elapsedMs = Date.now() - started;
			return rec;
		}
	} catch (err) {
		rec.outcome = 'submit_error';
		rec.note = String(err?.message || err).slice(0, 120);
		rec.elapsedMs = Date.now() - started;
		return rec;
	}

	rec.backend = submit.backend || null;
	rec.coldStart = Boolean(submit.cold_start);
	if (submit.coalesced) rec.note = 'coalesced onto an in-flight job';

	let done = null;
	if (submit.status === 'done' && submit.glb_url) {
		done = submit;
	} else if (!submit.job_id) {
		rec.outcome = 'no_job_id';
		rec.elapsedMs = Date.now() - started;
		return rec;
	} else {
		const deadline = Date.now() + MAX_WAIT_MS;
		let lastAnswerAt = Date.now();
		while (Date.now() < deadline) {
			await sleep(POLL_MS);
			let data;
			try {
				const res = await fetch(`${ORIGIN}/api/forge?job=${encodeURIComponent(submit.job_id)}`, {
					headers: { 'x-forge-client': clientId },
				});
				if (res.status >= 500) continue; // transient gateway blip, keep polling
				data = await res.json().catch(() => ({}));
			} catch {
				continue;
			}
			lastAnswerAt = Date.now();
			if (data.backend && data.backend !== rec.backend) {
				rec.failoverFrom = data.failover_from || rec.backend;
				rec.backend = data.backend;
			}
			if (data.status === 'queued') rec.queuedPolls += 1;
			if (data.status === 'done' && data.glb_url) {
				done = data;
				break;
			}
			if (data.status === 'failed') {
				rec.outcome = 'failed';
				rec.note = String(data.error || 'generation failed').slice(0, 120);
				rec.elapsedMs = Date.now() - started;
				return rec;
			}
		}
		if (!done) {
			// No terminal status inside the ceiling: exactly the silent drop this
			// test exists to surface.
			rec.outcome = 'silent_drop';
			rec.note = `no terminal status; last answer ${Math.round((Date.now() - lastAnswerAt) / 1000)}s before giving up`;
			rec.elapsedMs = Date.now() - started;
			return rec;
		}
	}

	rec.elapsedMs = Date.now() - started;
	rec.glbUrl = done.glb_url;

	// A lane counts as live only when the GLB it returned really parses with
	// geometry, so a 200 that hands back an empty or truncated file still fails.
	try {
		const res = await fetch(done.glb_url);
		const buf = Buffer.from(await res.arrayBuffer());
		if (!isValidGlbHeader(buf)) {
			rec.outcome = 'bad_glb';
			rec.note = `not a GLB (${buf.length} bytes)`;
			return rec;
		}
		const info = inspectGlb(buf);
		rec.meshes = info?.meshCount ?? null;
		rec.outcome = info && info.meshCount > 0 ? 'ok' : 'glb_no_geometry';
	} catch (err) {
		rec.outcome = 'glb_unreachable';
		rec.note = String(err?.message || err).slice(0, 120);
	}
	return rec;
}

const t0 = Date.now();
console.log(`[forge-load] ${N} concurrent generations at ${ORIGIN}, tiers=${TIERS.join(',')}`);
const results = await Promise.all(Array.from({ length: N }, (_, i) => runOne(i)));

const okDurations = results.filter((r) => r.outcome === 'ok').map((r) => r.elapsedMs).sort((a, b) => a - b);
const s = (ms) => (ms == null ? 'n/a' : `${(ms / 1000).toFixed(1)}s`);

console.log('\nidx tier      lane              outcome          elapsed  meshes queuedPolls cold failover note');
for (const r of results) {
	console.log(
		[
			String(r.index).padEnd(3),
			String(r.tier).padEnd(9),
			String(r.backend || '-').padEnd(17),
			String(r.outcome).padEnd(16),
			s(r.elapsedMs).padStart(7),
			String(r.meshes ?? '-').padStart(6),
			String(r.queuedPolls).padStart(11),
			String(r.coldStart).padStart(5),
			String(r.failoverFrom || '-').padStart(9),
			r.note ? ` ${r.note}` : '',
		].join(' '),
	);
}

const byOutcome = results.reduce((acc, r) => ((acc[r.outcome] = (acc[r.outcome] || 0) + 1), acc), {});
const byLane = results.reduce((acc, r) => {
	const k = r.backend || 'none';
	(acc[k] ||= []).push(r);
	return acc;
}, {});

console.log('\nlane summary (lane, n, ok, p50, p95, failovers, cold starts):');
for (const [lane, rows] of Object.entries(byLane)) {
	const d = rows.filter((r) => r.outcome === 'ok').map((r) => r.elapsedMs).sort((a, b) => a - b);
	console.log(
		`  ${lane.padEnd(18)} n=${String(rows.length).padStart(2)} ok=${String(d.length).padStart(2)} ` +
			`p50=${s(pct(d, 50)).padStart(7)} p95=${s(pct(d, 95)).padStart(7)} ` +
			`failovers=${rows.filter((r) => r.failoverFrom).length} cold=${rows.filter((r) => r.coldStart).length}`,
	);
}

console.log(`\noutcomes: ${JSON.stringify(byOutcome)}`);
console.log(`overall p50=${s(pct(okDurations, 50))} p95=${s(pct(okDurations, 95))} over ${okDurations.length}/${N} finished`);
console.log(`silent drops: ${results.filter((r) => r.outcome === 'silent_drop').length}`);
console.log(`wall clock: ${s(Date.now() - t0)}`);

// Non-zero exit when a job died without a terminal status, so this is usable as
// a gate and not just a report.
process.exit(results.some((r) => r.outcome === 'silent_drop') ? 1 : 0);
