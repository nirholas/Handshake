// GET /api/brownout: the platform's degradation posture, as data.
//
// Two things, and the second is the one that matters:
//
//   contracts  what this platform promises to do when a given upstream fails
//   proofs     the last time each of those promises was executed for real,
//              with the upstream actually broken, and what came back
//
// Anyone can claim a fallback. The proof block is a receipt from a run where
// the named provider was made to fail inside the real request path, so a reader
// can check the claim rather than take it. `not_exercised` is reported as
// plainly as a failure, because a proof that did not run is not a pass.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cors, json, method, wrap, error, rateLimited } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';

const ROOT = process.cwd();
let _cached = null;

// Both files are baked into the image at build time, so this is a disk read
// once per process, not per request.
function load() {
	if (_cached) return _cached;
	const registry = JSON.parse(readFileSync(join(ROOT, 'data/brownout.json'), 'utf8'));
	let proofs = null;
	try {
		proofs = JSON.parse(readFileSync(join(ROOT, 'public/brownout.json'), 'utf8'));
	} catch {
		// A build that has never run the prover is a real state, and saying so is
		// better than implying the contracts are unverified when they are simply
		// unrun in this image.
		proofs = null;
	}
	const byId = new Map((proofs?.results || []).map((r) => [r.id, r]));
	_cached = {
		updated: registry.updated,
		summary: registry.summary,
		proven: proofs?.proven ?? 0,
		total: registry.contracts.length,
		last_proof_at: proofs?.generated_at ?? null,
		contracts: registry.contracts.map((c) => {
			const proof = byId.get(c.id) || null;
			return {
				id: c.id,
				title: c.title,
				surface: c.surface ?? null,
				endpoint: c.endpoint,
				breaks: c.break,
				expect: c.expect,
				why: c.why ?? null,
				proof: proof
					? {
							verdict: proof.verdict,
							status: proof.observed?.status ?? null,
							tier: proof.observed?.tier ?? null,
							degraded: proof.observed?.degraded ?? null,
							failed_sources: proof.observed?.failedSources ?? 0,
							trace: proof.observed?.trace ?? [],
							ms: proof.ms ?? null,
							problems: proof.problems ?? [],
						}
					: null,
			};
		}),
	};
	return _cached;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	let payload;
	try {
		payload = load();
	} catch (err) {
		return error(res, 503, 'registry_unavailable', `the brownout registry could not be read: ${err?.message || err}`);
	}

	return json(res, 200, payload, {
		// The registry changes with a deploy and the proofs with a prover run, so
		// a short shared cache is right and a long one would hide a fresh proof.
		'cache-control': 'public, max-age=60, s-maxage=300, stale-while-revalidate=600',
	});
});
