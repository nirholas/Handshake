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

import { cors, method, rateLimited, wrap } from './_lib/http.js';
import { clientIp, limits } from './_lib/rate-limit.js';
import { gradeForCaller } from './_mcp3d/tools/sim-readiness.js';

// A grade is immutable for fixed bytes under a fixed grader, so the only thing
// that can change this answer is a grader version bump. The short edge TTL is
// therefore about absorbing repeat hits, not about freshness.
const CACHE_HEADER = 'public, max-age=60, s-maxage=300';

// The coded errors gradeForCaller throws, mapped to the status each one means.
// Anything unmapped is a 500 and reaches the wrap() error path.
const STATUS_BY_CODE = { invalid_input: 400, not_graded: 404, too_large: 413, fetch_failed: 502 };

// Only `?src=` is metered, and it is metered on the generic per-IP bucket sized
// for this traffic shape rather than a bucket of its own. The two lanes cost
// wildly different things: `?hash=` is one indexed row read, while `?src=`
// makes this server fetch up to 64 MB from an arbitrary host and build a convex
// hull over it. Capping the expensive lane at 30 per 5 minutes per IP leaves a
// person grading a folder of assets, or an agent screening a shortlist, far
// more headroom than either needs, while stopping the endpoint from being used
// as a free fetch-and-compute treadmill. The cheap lane stays uncapped on
// purpose: a client that pages through known hashes is exactly the usage this
// design is trying to encourage.
const GRADE_LIMIT = { limit: 30, window: '5 m' };

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

	if (src) {
		const rl = await limits.apiIp(clientIp(req), GRADE_LIMIT);
		if (!rl.success) {
			return rateLimited(res, rl, 'too many grades from this address; grade by content hash, or retry shortly');
		}
	}

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
