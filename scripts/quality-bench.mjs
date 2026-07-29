#!/usr/bin/env node
// Realism eval harness: fires the fixed prompt set in data/quality-bench/prompts.json
// through the REAL /api/forge path on a live deployment, renders 3 canonical views of
// the resulting GLB with the same headless three.js renderer that powers the avatar
// clip/OG-card renders (api/_lib/render-clip.js), and scores every view with Vertex
// Gemini vision (gemini-2.5-pro), twice per view, averaged. Core generate/render/judge
// logic lives in api/_lib/quality-bench.js, shared with the weekly cron sweep
// (api/cron/quality-bench.js) so the two callers can never disagree on what a
// "scored view" means.
//
// Usage:
//   node scripts/quality-bench.mjs [--lane=<id|id,id|all>] [--tier=<draft|standard|high|all>]
//     [--prompts=qb01,qb02,...] [--base-url=https://three.ws] [--resume=<run-file>]
//     [--concurrency=<n>] [--dry-run]
//   node scripts/quality-bench.mjs --compare=latest,previous
//
// Requires GOOGLE_CLOUD_PROJECT + GCP credentials (GCP_SERVICE_ACCOUNT_JSON, or the
// ambient Cloud Run/GCE metadata server) to score with Vertex Gemini — the same
// anchor api/_lib/vertex-gemini.js uses everywhere else. Forge generation itself
// needs no local credentials: the script calls the live /api/forge HTTP path on
// --base-url, which runs against that deployment's own configured lanes.
//
// Idempotent/resumable: every completed (promptId, lane, tier) result is written to
// the run file immediately, so a crash or Ctrl-C loses at most the one in-flight
// generation. Re-running with --resume=<same file> skips everything already recorded
// and never re-submits or re-spends on a completed combo.

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { JUDGE_MODEL, JUDGE_PROMPT_VERSION, loadCatalog, runOne } from '../api/_lib/quality-bench.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BENCH_DIR = path.join(ROOT, 'data', 'quality-bench');
const RUNS_DIR = path.join(BENCH_DIR, 'runs');
const PROMPTS_FILE = path.join(BENCH_DIR, 'prompts.json');

function parseArgs(argv) {
	const args = { lane: 'all', tier: 'standard,high', prompts: 'all', baseUrl: 'https://three.ws', concurrency: 1, dryRun: false };
	for (const raw of argv) {
		const [k, ...rest] = raw.replace(/^--/, '').split('=');
		const v = rest.join('=');
		if (k === 'lane') args.lane = v;
		else if (k === 'tier') args.tier = v;
		else if (k === 'prompts') args.prompts = v;
		else if (k === 'base-url') args.baseUrl = v;
		else if (k === 'resume') args.resume = v;
		else if (k === 'compare') args.compare = v;
		else if (k === 'concurrency') args.concurrency = Math.max(1, Number(v) || 1);
		else if (k === 'dry-run') args.dryRun = true;
	}
	return args;
}

async function loadPrompts() {
	const raw = JSON.parse(await readFile(PROMPTS_FILE, 'utf8'));
	return raw.prompts;
}

function liveImageBackends(catalog, requestedLane) {
	const imageBackends = catalog.backends.filter((b) => b.paths.includes('image'));
	if (requestedLane && requestedLane !== 'all') {
		const ids = requestedLane.split(',').map((s) => s.trim());
		return imageBackends.filter((b) => ids.includes(b.id));
	}
	return imageBackends.filter((b) => b.configured);
}

function resultKey(r) {
	return `${r.promptId}::${r.lane}::${r.tier}`;
}

function runFilePath(name) {
	return path.join(RUNS_DIR, name.endsWith('.json') ? name : `${name}.json`);
}

async function listRunFiles() {
	if (!existsSync(RUNS_DIR)) return [];
	const files = await readdir(RUNS_DIR);
	return files.filter((f) => f.endsWith('.json')).sort();
}

async function newRunFileName() {
	const files = await listRunFiles();
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	let n = 1;
	let name = `run-${stamp}.json`;
	while (files.includes(name)) {
		n += 1;
		name = `run-${stamp}-${n}.json`;
	}
	return name;
}

async function saveRun(runPath, run) {
	await mkdir(RUNS_DIR, { recursive: true });
	await writeFile(runPath, JSON.stringify(run, null, '\t') + '\n', 'utf8');
}

// Serialised writes: with --concurrency>1 several combos finish at once and each
// wants to persist the whole run file. Chaining keeps them from interleaving two
// full-file writes on the same fd path (a half-written run file would break the
// resume that the durability guarantee depends on).
let saveChain = Promise.resolve();
function queueSave(runPath, run) {
	saveChain = saveChain.then(
		() => saveRun(runPath, run),
		() => saveRun(runPath, run),
	);
	return saveChain;
}

// Fixed-size worker pool over a pre-built task list. Tasks are consumed in order,
// so the lane-interleaved ordering below spreads simultaneous work across lanes
// instead of hammering one GPU worker.
async function runPool(tasks, concurrency, worker) {
	let next = 0;
	const size = Math.max(1, Math.min(concurrency, tasks.length));
	await Promise.all(
		Array.from({ length: size }, async () => {
			for (;;) {
				const i = next;
				next += 1;
				if (i >= tasks.length) return;
				await worker(tasks[i], i);
			}
		}),
	);
}

async function runBench(args) {
	const prompts = await loadPrompts();
	const wantedPromptIds = args.prompts === 'all' ? null : new Set(args.prompts.split(',').map((s) => s.trim()));
	const selectedPrompts = wantedPromptIds ? prompts.filter((p) => wantedPromptIds.has(p.id)) : prompts;
	const tiers = args.tier === 'all' ? ['draft', 'standard', 'high'] : args.tier.split(',').map((s) => s.trim());

	const catalog = await loadCatalog(args.baseUrl);
	const lanes = liveImageBackends(catalog, args.lane);
	if (!lanes.length) {
		throw new Error('no live image-capable forge lanes matched --lane on this deployment (check /api/forge?catalog)');
	}

	console.log(`quality-bench: ${selectedPrompts.length} prompts x ${lanes.length} lanes (${lanes.map((l) => l.id).join(', ')}) x ${tiers.length} tiers (${tiers.join(', ')}) against ${args.baseUrl}, concurrency ${args.concurrency}`);

	let runPath;
	let run;
	if (args.resume) {
		runPath = runFilePath(args.resume);
		run = JSON.parse(await readFile(runPath, 'utf8'));
	} else {
		runPath = path.join(RUNS_DIR, await newRunFileName());
		run = {
			runId: path.basename(runPath, '.json'),
			startedAt: new Date().toISOString(),
			finishedAt: null,
			baseUrl: args.baseUrl,
			judgeModel: JUDGE_MODEL,
			judgePromptVersion: JUDGE_PROMPT_VERSION,
			lanes: lanes.map((l) => l.id),
			tiers,
			results: [],
		};
	}
	const done = new Set(run.results.map(resultKey));

	// Ordered prompt → tier → lane so that consecutive tasks land on different
	// lanes: a pool of N workers then spreads across N GPU backends rather than
	// queueing N jobs behind one.
	const tasks = [];
	for (const p of selectedPrompts) {
		for (const tier of tiers) {
			for (const lane of lanes) {
				if (!done.has(`${p.id}::${lane.id}::${tier}`)) tasks.push({ prompt: p, lane, tier });
			}
		}
	}

	if (args.dryRun) {
		console.log(`dry-run: ${tasks.length} (prompt, lane, tier) combos would run; ${done.size} already recorded in ${runPath}`);
		return;
	}

	let completed = 0;
	await runPool(tasks, args.concurrency, async ({ prompt: p, lane, tier }) => {
		console.log(`-> ${p.id} [${p.subjectClass}] lane=${lane.id} tier=${tier}`);
		const result = await runOne(args.baseUrl, p, lane.id, tier);
		run.results.push(result);
		completed += 1;
		await queueSave(runPath, run);
		console.log(
			`<- ${p.id} lane=${lane.id} tier=${tier} status=${result.status} mean=${result.meanScore == null ? 'null' : result.meanScore.toFixed(2)} (${completed}/${tasks.length})`,
		);
	});

	run.finishedAt = new Date().toISOString();
	await queueSave(runPath, run);
	console.log(`quality-bench: run complete -> ${runPath}`);
	printSummary(run);
}

function printSummary(run) {
	const byLaneTier = new Map();
	for (const r of run.results) {
		const key = `${r.lane}/${r.tier}`;
		if (!byLaneTier.has(key)) byLaneTier.set(key, []);
		if (typeof r.meanScore === 'number') byLaneTier.get(key).push(r.meanScore);
	}
	console.log('\nlane/tier          mean   n');
	for (const [key, scores] of [...byLaneTier.entries()].sort()) {
		const mean = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : NaN;
		console.log(`${key.padEnd(18)} ${mean.toFixed(2).padStart(5)}   ${scores.length}`);
	}
}

async function resolveCompareFile(token) {
	const files = await listRunFiles();
	if (!files.length) throw new Error('no run files found in data/quality-bench/runs/');
	if (token === 'latest') return runFilePath(files[files.length - 1]);
	if (token === 'previous') {
		if (files.length < 2) throw new Error('need at least 2 runs to resolve "previous"');
		return runFilePath(files[files.length - 2]);
	}
	return runFilePath(token);
}

function overallMean(run) {
	const scores = run.results.map((r) => r.meanScore).filter((n) => typeof n === 'number');
	if (!scores.length) return null;
	return scores.reduce((a, b) => a + b, 0) / scores.length;
}

async function compareRuns(spec) {
	const [aTok, bTok] = spec.split(',').map((s) => s.trim());
	if (!aTok || !bTok) throw new Error('--compare requires two run identifiers, e.g. --compare=latest,previous');
	const [aPath, bPath] = await Promise.all([resolveCompareFile(aTok), resolveCompareFile(bTok)]);
	const [a, b] = await Promise.all([
		JSON.parse(await readFile(aPath, 'utf8')),
		JSON.parse(await readFile(bPath, 'utf8')),
	]);
	const meanA = overallMean(a);
	const meanB = overallMean(b);
	console.log(`${aTok} (${path.basename(aPath)}): mean ${meanA?.toFixed(3)}`);
	console.log(`${bTok} (${path.basename(bPath)}): mean ${meanB?.toFixed(3)}`);
	if (meanA == null || meanB == null) {
		console.error('one of the runs has no scored results; cannot compare');
		process.exitCode = 1;
		return;
	}
	const drop = meanB - meanA; // positive = "a" regressed vs "b"
	console.log(`delta (${aTok} - ${bTok}): ${drop.toFixed(3)}`);
	if (drop < -1.0) {
		console.error(`REGRESSION: ${aTok} mean dropped ${Math.abs(drop).toFixed(3)} points vs ${bTok} (threshold 1.0)`);
		process.exitCode = 1;
	} else {
		console.log('no regression beyond threshold (1.0)');
	}
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.compare) {
		await compareRuns(args.compare);
		return;
	}
	await runBench(args);
}

main().catch((err) => {
	console.error('quality-bench failed:', err.stack || err.message);
	process.exitCode = 1;
});
