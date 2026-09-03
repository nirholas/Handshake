// Simulation readiness: the free physics grade for a 3D asset (MCP tool).
//
//   • grade_sim_readiness(glb_url | hash), FREE, read-only, public. Answers the
//     one question a renderer never asks: can a rigid-body solver consume this
//     mesh as-is? Reports whether the surface is closed and consistently wound,
//     whether its extents are real meters or a generator's unit box, its exact
//     volume/centroid/inertia at unit density, and how well one convex hull
//     approximates it. Zero payment/wallet/coin surface, exactly like
//     verify_provenance, so it ships on every track.
//
// The grade is a property of BYTES: the asset is hashed, the hash is the cache
// key, and a cached grade at the current grader version is returned without
// re-grading. `hash` alone is therefore a pure lookup that never fetches
// anything, which is what makes it safe to call in a loop.
//
// Spec: specs/SIM_READINESS.md. Pure core: api/_lib/sim-readiness.js.
// Storage: api/_lib/sim-readiness-store.js.

import { fetchSafePublicUrlPinned, MaxBytesExceededError, SsrfBlockedError } from '../../_lib/ssrf-guard.js';
import { sha256Hex } from '../../_lib/provenance-3d.js';
import { gradeSimReadiness, SIM_READINESS_VERSION } from '../../_lib/sim-readiness.js';
import { getGrade, putGrade } from '../../_lib/sim-readiness-store.js';

// The same ceiling anchor_provenance applies. Hull construction is the dominant
// cost and scales with the point count, so the byte cap is also the latency cap.
const MAX_GLB_BYTES = 64 * 1024 * 1024;
// A hung origin must not hold the invocation open for its whole budget. The
// slowest asset in the 20-model probe run fetched and graded in under 5 s, so
// 15 s is a generous ceiling on the fetch alone.
const FETCH_TIMEOUT_MS = 15_000;

const HASH_RE = /^[0-9a-f]{64}$/;

function toolError(message, code, extra = {}) {
	return {
		content: [{ type: 'text', text: message }],
		structuredContent: { error: true, code: code || 'error', message, ...extra },
		isError: true,
	};
}

// One human sentence per verdict. An agent reads structuredContent; a person
// reading the transcript needs to know what to DO, which is the whole point of
// separating needs_scale (multiply and go) from needs_repair (close it first).
function summarize(report) {
	const v = report.verdict;
	if (v === 'simulation_ready') {
		const kg = Number(report.mass?.massAtWaterDensityKg);
		const m = Number(report.scale?.longestAxisMeters);
		const size = Number.isFinite(m) ? `${m.toFixed(3)} m along its longest axis` : 'a known real-world size';
		const mass = Number.isFinite(kg) ? `, ${kg.toFixed(2)} kg at water density` : '';
		return `Simulation ready: closed, consistently wound, ${size}${mass}. Usable as a rigid body as-is.`;
	}
	if (v === 'needs_scale') {
		const m = Number(report.scale?.longestAxisMeters);
		const axis = Number.isFinite(m) ? m.toFixed(3) : '1';
		return `Needs scale: the geometry is sound but the generator fitted it to a unit box (${axis} m longest axis), so the units are not the object's. Multiply to the intended size and the mass properties scale with it.`;
	}
	if (v === 'needs_repair') {
		const t = report.topology || {};
		const faults = [];
		if (t.boundaryEdges > 0) faults.push(`${t.boundaryEdges} open edges`);
		if (t.nonManifoldEdges > 0) faults.push(`${t.nonManifoldEdges} non-manifold edges`);
		if (t.inconsistentWindingEdges > 0) faults.push(`${t.inconsistentWindingEdges} inconsistently wound edges`);
		const detail = faults.length ? ` (${faults.join(', ')})` : '';
		return `Needs repair: the surface is not closed${detail}. The reported volume and inertia are shown for reference and must not be trusted until the surface is closed.`;
	}
	if (v === 'unreadable') return 'Unreadable: these bytes are not binary glTF 2.0, or a compression extension could not be decoded.';
	return 'Unusable: there is no enclosed volume to simulate.';
}

async function fetchGlb(glbUrl) {
	let resp;
	try {
		resp = await fetchSafePublicUrlPinned(
			glbUrl,
			{ signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
			{ allowHttp: false, maxBytes: MAX_GLB_BYTES },
		);
	} catch (err) {
		if (err instanceof MaxBytesExceededError) {
			const e = new Error(`asset exceeds ${Math.round(MAX_GLB_BYTES / (1024 * 1024))} MB`);
			e.code = 'too_large';
			throw e;
		}
		if (err instanceof SsrfBlockedError) {
			const e = new Error('src must be a public https URL');
			e.code = 'invalid_input';
			throw e;
		}
		const reason = err?.name === 'TimeoutError' ? 'timed out' : err?.message || 'unreachable';
		const e = new Error(`could not fetch the asset (${reason})`);
		e.code = 'fetch_failed';
		throw e;
	}
	if (!resp.ok) {
		const e = new Error('could not fetch the asset');
		e.code = 'fetch_failed';
		e.upstreamStatus = resp.status;
		throw e;
	}
	const buf = Buffer.from(await resp.arrayBuffer());
	if (!buf.length) {
		const e = new Error('the asset URL returned no data');
		e.code = 'fetch_failed';
		throw e;
	}
	if (buf.length > MAX_GLB_BYTES) {
		const e = new Error(`asset exceeds ${Math.round(MAX_GLB_BYTES / (1024 * 1024))} MB`);
		e.code = 'too_large';
		throw e;
	}
	return buf;
}

/**
 * Grade an asset, serving the stored grade when these exact bytes already have
 * one. Shared by the MCP tool and GET /api/sim-readiness so the two can never
 * disagree about a verdict.
 *
 * @param {{ glb_url?: string, hash?: string }} args
 * @returns {Promise<{ cached:boolean, gradedAt:string, glbSha256:string } & object>}
 *   the report envelope, or throws an Error carrying `code`.
 */
export async function gradeForCaller(args = {}) {
	const glbUrl = typeof args.glb_url === 'string' ? args.glb_url.trim() : '';
	const hashArg = typeof args.hash === 'string' ? args.hash.trim().toLowerCase() : '';

	// hash-only: a pure lookup. It never fetches bytes, so it cannot report on an
	// asset nobody has graded. That is a 404, not an invitation to go get it.
	if (!glbUrl) {
		if (!HASH_RE.test(hashArg)) {
			const e = new Error('Provide glb_url (a public https .glb) or a 64-char hex sha256 hash.');
			e.code = 'invalid_input';
			throw e;
		}
		const hit = await getGrade(hashArg);
		if (!hit) {
			const e = new Error('not graded');
			e.code = 'not_graded';
			throw e;
		}
		return { cached: true, gradedAt: hit.gradedAt, glbSha256: hashArg, ...hit.report };
	}

	if (!/^https:\/\//i.test(glbUrl)) {
		const e = new Error('src must be a public https URL');
		e.code = 'invalid_input';
		throw e;
	}

	const buf = await fetchGlb(glbUrl);
	const glbSha256 = sha256Hex(buf);

	const hit = await getGrade(glbSha256);
	if (hit) return { cached: true, gradedAt: hit.gradedAt, glbSha256, ...hit.report };

	const started = Date.now();
	const report = await gradeSimReadiness(buf);
	const gradeMs = Date.now() - started;

	// Caching is a courtesy, never a precondition: the caller already holds the
	// answer, so a write that cannot land degrades the cache and nothing else.
	const storedAt = await putGrade({
		glbSha256,
		report,
		sourceUrl: glbUrl,
		sizeBytes: buf.length,
		gradeMs,
	});
	return { cached: false, gradedAt: storedAt || new Date().toISOString(), glbSha256, ...report };
}

async function handleGrade(args) {
	let envelope;
	try {
		envelope = await gradeForCaller(args);
	} catch (err) {
		if (err?.code === 'not_graded') {
			return toolError(
				'No grade is on record for that content hash. Pass glb_url instead and it will be graded now.',
				'not_graded',
			);
		}
		return toolError(err?.message || 'the asset could not be graded', err?.code || 'error');
	}
	return {
		content: [{ type: 'text', text: summarize(envelope) }],
		structuredContent: envelope,
	};
}

export const toolDefs = [
	{
		name: 'grade_sim_readiness',
		title: 'Grade a 3D model for physics simulation',
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		description:
			'Check whether a 3D model (GLB) can be dropped into a physics simulator (MuJoCo, Isaac, Bullet, a game ' +
			'engine) and behave correctly, before you spend anything on it. Returns simulation_ready, needs_scale, ' +
			'needs_repair, or unusable, plus the measurements behind the verdict: watertightness and winding, ' +
			'real-world extents in meters, exact volume, centroid and inertia tensor at unit density, and how well a ' +
			'single convex hull approximates the shape. Everything is derived from the mesh itself, never guessed. ' +
			`Free and public: no account, no payment. Grader ${SIM_READINESS_VERSION}; spec at https://three.ws/docs/sim-readiness. ` +
			'Pass glb_url (a public https .glb) or a known 64-char content hash.',
		inputSchema: {
			type: 'object',
			additionalProperties: false,
			properties: {
				glb_url: { type: 'string', format: 'uri', description: 'Public https URL of the .glb to grade.' },
				hash: { type: 'string', description: 'A known 64-char hex sha256 of the GLB. A cache lookup that never fetches the asset.' },
			},
		},
		handler: (args) => handleGrade(args),
	},
];

export default { toolDefs, gradeForCaller };
