/**
 * Free public simulation-readiness grade: GET /api/sim-readiness
 * ---------------------------------------------------------------
 * GET /api/sim-readiness?src=<glbUrl>   (or ?hash=<sha256> for a pure lookup)
 *
 * Answers the question a renderer never asks: can a rigid-body solver consume
 * this mesh as-is? Returns the verdict (simulation_ready | needs_scale |
 * needs_repair | unusable) with every measurement behind it: watertightness,
 * winding, real-world extents, exact volume/centroid/inertia at unit density,
 * and convex-hull fit.
 *
 *   { cached, gradedAt, glbSha256, grader, verdict, blockers, warnings,
 *     geometry, topology, scale, mass, collision, bounds }
 *
 * No account, no payment, no coin surface. The same object the free
 * grade_sim_readiness MCP tool returns, over plain HTTP, so the viewer badge and
 * any client can check an asset for free. A thin wrapper over that tool's
 * handler on purpose: the two can never disagree about a verdict.
 *
 * Spec: specs/SIM_READINESS.md.
 */

import { cors, method, wrap } from './_lib/http.js';
import { gradeForCaller } from './_mcp3d/tools/sim-readiness.js';

// A grade is immutable for fixed bytes under a fixed grader, so the only thing
// that can change this answer is a grader version bump. The short edge TTL is
// therefore about absorbing repeat hits, not about freshness.
const CACHE_HEADER = 'public, max-age=60, s-maxage=300';

// The coded errors gradeForCaller throws, mapped to the status each one means.
// Anything unmapped is a 500 and reaches the wrap() error path.
const STATUS_BY_CODE = { invalid_input: 400, not_graded: 404, too_large: 413, fetch_failed: 502 };

function fail(res, status, body) {
	res.statusCode = status;
	res.setHeader('content-type', 'application/json; charset=utf-8');
	res.setHeader('cache-control', 'no-store');
	res.end(JSON.stringify(body));
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	// Grading is a read. The preflight advertises GET only; enforce it so a POST
	// cannot drive a body-less fetch of an arbitrary URL.
	if (!method(req, res, ['GET'])) return;

	const url = new URL(req.url, 'http://x');
	const src = url.searchParams.get('src') || url.searchParams.get('glb_url') || '';
	const hash = url.searchParams.get('hash') || '';

	let envelope;
	try {
		envelope = await gradeForCaller({ glb_url: src || undefined, hash: hash || undefined });
	} catch (err) {
		const status = STATUS_BY_CODE[err?.code];
		// An unmapped code is a genuine server fault, not a caller mistake: rethrow
		// so wrap() logs and alerts on it instead of quietly answering 400.
		if (!status) throw err;
		fail(res, status, {
			error: err.message || 'the asset could not be graded',
			...(err.upstreamStatus ? { status: err.upstreamStatus } : {}),
		});
		return;
	}

	res.statusCode = 200;
	res.setHeader('content-type', 'application/json; charset=utf-8');
	res.setHeader('cache-control', CACHE_HEADER);
	res.end(JSON.stringify(envelope));
});
