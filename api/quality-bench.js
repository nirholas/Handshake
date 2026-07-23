// GET /api/quality-bench — serves the committed realism-eval run history so the
// /quality-bench dashboard (and any external tooling) can read it without a DB
// round-trip. Every run is a JSON file committed under data/quality-bench/runs/;
// this endpoint just lists and returns them, plus the fixed prompt set.
//
// GET /api/quality-bench            -> { prompts, runs: [{ file, runId, startedAt, finishedAt, meanScore }] }
// GET /api/quality-bench?run=<file> -> the full run JSON

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { cors, json, method, wrap, error } from './_lib/http.js';

const BENCH_DIR = path.join(process.cwd(), 'data', 'quality-bench');
const RUNS_DIR = path.join(BENCH_DIR, 'runs');

function overallMean(run) {
	const scores = (run.results || []).map((r) => r.meanScore).filter((n) => typeof n === 'number');
	if (!scores.length) return null;
	return scores.reduce((a, b) => a + b, 0) / scores.length;
}

async function listRunSummaries() {
	let files = [];
	try {
		files = (await readdir(RUNS_DIR)).filter((f) => f.endsWith('.json')).sort();
	} catch {
		return [];
	}
	const summaries = [];
	for (const file of files) {
		try {
			const run = JSON.parse(await readFile(path.join(RUNS_DIR, file), 'utf8'));
			summaries.push({
				file,
				runId: run.runId,
				startedAt: run.startedAt,
				finishedAt: run.finishedAt,
				baseUrl: run.baseUrl,
				lanes: run.lanes,
				tiers: run.tiers,
				judgeModel: run.judgeModel,
				resultCount: (run.results || []).length,
				meanScore: overallMean(run),
			});
		} catch {
			// skip an unreadable/corrupt run file rather than failing the whole listing
		}
	}
	return summaries;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const url = new URL(req.url, 'http://x');
	const runFile = url.searchParams.get('run');

	if (runFile) {
		const safeName = path.basename(runFile);
		if (!/^[a-zA-Z0-9._-]+\.json$/.test(safeName)) {
			return error(res, 400, 'bad_request', 'invalid run file name');
		}
		try {
			const run = JSON.parse(await readFile(path.join(RUNS_DIR, safeName), 'utf8'));
			return json(res, 200, run, { 'cache-control': 'public, max-age=300' });
		} catch {
			return error(res, 404, 'not_found', `run file "${safeName}" not found`);
		}
	}

	let prompts = [];
	try {
		const raw = JSON.parse(await readFile(path.join(BENCH_DIR, 'prompts.json'), 'utf8'));
		prompts = raw.prompts || [];
	} catch {
		// prompts.json missing is a build problem, not a caller error — return empty
	}

	const runs = await listRunSummaries();
	return json(res, 200, { prompts, runs }, { 'cache-control': 'public, max-age=120' });
});
