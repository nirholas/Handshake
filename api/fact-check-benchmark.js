// GET /api/fact-check-benchmark: public read of the fact-check accuracy benchmark.
//
// Serves the most recently published run (score, per-class table, per-difficulty
// table, confusion matrix, run date), plus the static claim-count summary from
// tests/fixtures/fact-check-benchmark.json so the /fact-check page always has
// something honest to render.
//
// Two sources, in order:
//   1. The DB row written by `scripts/fact-check-benchmark.mjs --publish` and by
//      the scheduled re-run (api/cron/fact-check-benchmark.js). This wins so a
//      new run reaches the page immediately instead of waiting for a deploy,
//      which is what let the published number go stale before.
//   2. data/_generated/fact-check-benchmark.json, the run committed into the
//      image. It is the fallback when nothing is published or the DB is
//      unreachable, so a database blip degrades to the last shipped run rather
//      than to an empty page.
// `source` names which one answered.
//
// Never fabricates a score: when neither source has a run, `ran` is false and
// `report` is null, and the page renders its designed "not yet run" empty state
// instead of a fake number.

import { readFile } from 'node:fs/promises';
import { cors, json, method, wrap } from './_lib/http.js';
import {
	FIXTURE_PATH,
	REPORT_PATH,
	VERDICT_CLASSES,
	readPublishedRun,
} from './_lib/fact-check-benchmark.js';

async function readJsonIfExists(path) {
	try {
		return JSON.parse(await readFile(path, 'utf8'));
	} catch (err) {
		if (err?.code === 'ENOENT') return null;
		throw err;
	}
}

function summarizeFixture(fixture) {
	if (!fixture || !Array.isArray(fixture.claims)) return null;
	const counts = Object.fromEntries(VERDICT_CLASSES.map((c) => [c, 0]));
	for (const claim of fixture.claims) {
		if (counts[claim.expected_verdict] != null) counts[claim.expected_verdict]++;
	}
	return { total: fixture.claims.length, by_class: counts, version: fixture.version || null };
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const [fixture, published, shipped] = await Promise.all([
		readJsonIfExists(FIXTURE_PATH),
		readPublishedRun(),
		readJsonIfExists(REPORT_PATH),
	]);

	const report = published || shipped || null;
	const source = published ? 'database' : shipped ? 'image' : null;

	return json(
		res,
		200,
		{
			data: {
				fixture: summarizeFixture(fixture),
				ran: Boolean(report),
				source,
				report,
				claims_source:
					'https://github.com/nirholas/three.ws/blob/main/tests/fixtures/fact-check-benchmark.json',
				runner_source:
					'https://github.com/nirholas/three.ws/blob/main/scripts/fact-check-benchmark.mjs',
			},
		},
		// Short cache: a fresh publish (manual or scheduled) should surface within
		// minutes, and the payload is small enough that 5 minutes at the edge is
		// all the protection this read needs.
		{ 'cache-control': 'public, max-age=300' },
	);
});
