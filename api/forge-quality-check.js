// POST /api/forge-quality-check — score a generated 3D model's realism / quality.
//
// A thin HTTP surface over the reusable gate in api/_lib/forge-quality-gate.js.
// All provider policy (Vertex Gemini first, free NVIDIA NIM vision backup),
// rendering, the subject-aware rubric, fail-open behavior, and the retry-directive
// logic live in the lib — this file only reads the request, meters it, and shapes
// the response. The generation router (api/forge.js) imports the lib directly; this
// endpoint exists so a client, an external agent, or an ops probe can score any
// GLB (or an existing render) on demand.
//
// Request (JSON body):
//   { glbUrl?, renderUrl?, image?, imageType?, prompt?, subject?, passScore?,
//     tier?, path?, attempt? }
//   Supply ONE of glbUrl (rendered here), renderUrl (public image URL), or image
//   (base64 / data URI of a render). prompt steers the rubric + the retry hint.
//   tier/path/attempt (optional) let the response include a ready-to-run retry
//   directive when the model fails the gate.
// Response:
//   { verdict, retry } where verdict is the structured gate result and retry is a
//   buildRetryDirective() object (or null). A GET returns a capability probe.
//
// Fail-open: a scoring/render/provider outage returns 200 with
// verdict.qa_available:false and verdict.pass:true — the gate never blocks a
// generation, and neither does this endpoint.

import { cors, method, readJson, error, json, wrap, rateLimited } from './_lib/http.js';
import { getSessionUser, authenticateBearer, extractBearer } from './_lib/auth.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import {
	runQualityGate,
	buildRetryDirective,
	qualityGateConfigured,
	vertexQualityConfigured,
	QUALITY_GATE_DEFAULTS,
} from './_lib/forge-quality-gate.js';

export const maxDuration = 60;

// base64 render inflates ~33%; a 640px PNG is well under this even before that.
const MAX_BODY_BYTES = 20 * 1024 * 1024;

export default wrap(async function handler(req, res) {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS' })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	// Capability probe — lets a UI decide whether to surface a "check quality"
	// affordance, and reports which lane will serve.
	if (req.method === 'GET' || req.method === 'HEAD') {
		return json(
			res,
			200,
			{
				configured: qualityGateConfigured(),
				provider: vertexQualityConfigured() ? 'vertex' : (qualityGateConfigured() ? 'platform-vision' : null),
				model: vertexQualityConfigured() ? QUALITY_GATE_DEFAULTS.model : null,
				passScore: QUALITY_GATE_DEFAULTS.passScore,
				maxRetries: QUALITY_GATE_DEFAULTS.maxRetries,
			},
			{ 'cache-control': 'public, max-age=60' },
		);
	}

	// Metered like the other free vision lanes (this can burn a Vertex call).
	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	const userId = session?.id ?? bearer?.userId ?? null;
	if (userId) {
		const rl = await limits.visionUser(userId);
		if (!rl.success) return rateLimited(res, rl, 'Quality-check rate limit exceeded, try again later');
	} else {
		const rl = await limits.visionIp(clientIp(req));
		if (!rl.success) return rateLimited(res, rl, 'Quality-check rate limit exceeded, sign in for a higher limit');
	}

	let body;
	try {
		body = await readJson(req, MAX_BODY_BYTES);
	} catch (e) {
		if (e?.status === 413) return error(res, 413, 'payload_too_large', 'request body exceeds the 20 MB limit');
		return error(res, 400, 'bad_request', e?.message || 'could not read JSON body');
	}

	const glbUrl = typeof body?.glbUrl === 'string' && body.glbUrl.trim() ? body.glbUrl.trim() : null;
	const renderUrl = typeof body?.renderUrl === 'string' && body.renderUrl.trim() ? body.renderUrl.trim() : null;
	const renderBase64 = typeof body?.image === 'string' && body.image ? body.image : null;
	if (!glbUrl && !renderUrl && !renderBase64) {
		return error(res, 400, 'bad_request', 'supply one of glbUrl, renderUrl, or image (base64 / data URI)');
	}

	const prompt = typeof body?.prompt === 'string' ? body.prompt.slice(0, 2000) : null;
	const subject = typeof body?.subject === 'string' ? body.subject : null;
	const passScore = Number.isFinite(Number(body?.passScore)) ? Number(body.passScore) : QUALITY_GATE_DEFAULTS.passScore;
	const mimeType = typeof body?.imageType === 'string' ? body.imageType : 'image/png';

	const verdict = await runQualityGate({
		glbUrl,
		renderUrl,
		renderBase64,
		mimeType,
		prompt,
		subject,
		passScore,
		track: { userId, tool: 'api/forge-quality-check' },
	});

	// When the model failed the gate (and QA is available), hand back a concrete
	// retry directive the caller can feed straight into a regeneration. tier/path/
	// attempt come from the request so the caller can drive a real retry loop.
	const retry = !verdict.pass && verdict.qa_available
		? buildRetryDirective(verdict, {
			prompt: prompt || '',
			tier: typeof body?.tier === 'string' ? body.tier : 'standard',
			path: typeof body?.path === 'string' ? body.path : 'image',
			attempt: Number.isFinite(Number(body?.attempt)) ? Number(body.attempt) : 0,
			maxRetries: QUALITY_GATE_DEFAULTS.maxRetries,
		})
		: null;

	return json(res, 200, { verdict, retry }, { 'cache-control': 'no-store' });
});
