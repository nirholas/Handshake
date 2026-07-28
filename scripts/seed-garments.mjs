#!/usr/bin/env node
// Seed the additive-wardrobe catalog through the public garment-forge proxy.
//
// Usage:
//   node scripts/seed-garments.mjs path/to/batch.json [--concurrency 2] [--base https://three.ws]
//
// batch.json is an array of { "slot": "footwear", "prompt": "black leather chelsea boots" }.
// Slots: top | bottom | footwear | outerwear | hair | headwear | glasses | accessory.
//
// Pacing is load-bearing, not politeness: the worker claims work at execution
// time against a durable GCS record, and large simultaneous batches have
// historically lost jobs to instance reclaim (22 submitted -> 10 published on
// 2026-07-27; the same pieces at 2-concurrent published 9/9). Keep
// --concurrency at 2 unless the worker's queueing has been re-measured.
//
// Each job runs ~7 minutes (reference image -> GPU mesh -> rig -> validate ->
// publish). A finished job is already live in the public catalog when this
// script reports it done. Failures are per-job and final: the worker refuses
// malformed shapes (SLOT_BOXES envelope) and under-bound skins (<60% weight
// coverage) rather than publishing a bad asset, so a failed prompt should be
// reworded, not retried verbatim.

import { readFileSync } from 'node:fs';

const SLOTS = new Set([
	'top', 'bottom', 'footwear', 'outerwear', 'hair', 'headwear', 'glasses', 'accessory',
]);
const POLL_MS = 15_000;
const JOB_TIMEOUT_MS = 20 * 60_000;

function arg(name, fallback) {
	const i = process.argv.indexOf(`--${name}`);
	return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const batchPath = process.argv[2];
if (!batchPath || batchPath.startsWith('--')) {
	console.error('usage: node scripts/seed-garments.mjs batch.json [--concurrency 2] [--base https://three.ws]');
	process.exit(2);
}
const base = arg('base', 'https://three.ws').replace(/\/$/, '');
const concurrency = Math.max(1, Number(arg('concurrency', '2')) || 2);

const batch = JSON.parse(readFileSync(batchPath, 'utf8'));
if (!Array.isArray(batch) || batch.length === 0) {
	console.error('batch.json must be a non-empty array of { slot, prompt }');
	process.exit(2);
}
for (const [i, item] of batch.entries()) {
	if (!SLOTS.has(item?.slot)) {
		console.error(`item ${i}: unknown slot "${item?.slot}"`);
		process.exit(2);
	}
	if (typeof item?.prompt !== 'string' || item.prompt.trim().length < 3) {
		console.error(`item ${i}: missing prompt`);
		process.exit(2);
	}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function submit(item) {
	const res = await fetch(`${base}/api/garment-forge`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ prompt: item.prompt, slot: item.slot }),
	});
	const body = await res.json().catch(() => ({}));
	if (res.status === 429) {
		const wait = Number(res.headers.get('retry-after')) || 60;
		console.log(`  rate limited, waiting ${wait}s before resubmitting "${item.prompt}"`);
		await sleep(wait * 1000);
		return submit(item);
	}
	if (res.status !== 202 || !body.job_id) {
		throw new Error(`submit failed (${res.status}): ${body.message || body.error || 'unknown'}`);
	}
	return body.job_id;
}

async function waitForJob(jobId) {
	const deadline = Date.now() + JOB_TIMEOUT_MS;
	let last = '';
	while (Date.now() < deadline) {
		await sleep(POLL_MS);
		const res = await fetch(`${base}/api/garment-forge?job=${jobId}`);
		if (res.status === 429) continue;
		const job = await res.json().catch(() => null);
		if (!job) continue;
		const stage = `${job.status}${job.stage ? `/${job.stage}` : ''}`;
		if (stage !== last) {
			console.log(`  [${jobId.slice(0, 8)}] ${stage}`);
			last = stage;
		}
		if (job.status === 'done' || job.status === 'failed') return job;
	}
	return { status: 'timeout', job_id: jobId };
}

async function runOne(item, index) {
	const label = `${index + 1}/${batch.length} ${item.slot}: "${item.prompt}"`;
	try {
		console.log(`▶ ${label}`);
		const jobId = await submit(item);
		console.log(`  job ${jobId}`);
		const job = await waitForJob(jobId);
		if (job.status === 'done') {
			console.log(`✔ ${label} → ${job.garment_id} (coverage ${job.coverage ?? '?'})`);
			return { ...item, ok: true, garment_id: job.garment_id };
		}
		console.log(`✘ ${label} → ${job.status}: ${job.error || 'no detail'}`);
		return { ...item, ok: false, error: job.error || job.status };
	} catch (err) {
		console.log(`✘ ${label} → ${err.message}`);
		return { ...item, ok: false, error: err.message };
	}
}

const queue = batch.map((item, i) => () => runOne(item, i));
const results = [];
async function worker() {
	while (queue.length) results.push(await queue.shift()());
}
await Promise.all(Array.from({ length: concurrency }, worker));

const ok = results.filter((r) => r.ok);
const failed = results.filter((r) => !r.ok);
console.log(`\npublished ${ok.length}/${results.length}`);
if (failed.length) {
	console.log('failed:');
	for (const f of failed) console.log(`  ${f.slot}: "${f.prompt}" — ${f.error}`);
	process.exit(1);
}
