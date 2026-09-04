// POST /api/x402/pipeline   { stages: [...], prompt?, glb_url?, options?: {...} }
//
// One x402 call, full 3D asset pipeline — text or GLB in, rigged/optimized
// game-ready GLB out. The only asset pipeline in the x402 ecosystem: an agent
// describes what it wants and gets back a game-ready asset from a single paid
// call, priced per stage and quoted EXACTLY in the 402 challenge.
//
// `stages` is an ordered subsequence of
//   ['generate','rig','remesh','gameready','stylize']
// (generate must be first and needs `prompt`; without generate, `glb_url` is the
// input). Only stages whose backing lane is configured on this deployment are
// offered — the grammar is computed from env per request, and the 402 quote is
// the SUM of the requested stages' prices.
//
// Execution mirrors api/x402/forge.js: the first stage is submitted AFTER verify
// but BEFORE settle, so a dead first lane never charges. The chain then advances
// as a poll-driven state machine — the buyer polls FREE at
//   GET /api/forge?job=<job_token>
// and each poll runs the next stage when the current one finishes, recording
// per-stage progress (id, status, started_at, finished_at, output_url, error).
// A stage failing mid-chain marks the job `failed` at that stage with the
// completed stages' outputs still delivered (honest partial value).
//
// Network: USDC on Solana mainnet (Base is a dev/preview failsafe when
// X402_PAY_TO_SOLANA is unset). GET (no payment) returns the live stage grammar
// and per-stage pricing so agents can discover cost + capability before paying.

import { wrap, cors, error, json, rateLimited, readBody } from '../_lib/http.js';
import {
	NETWORK_BASE_MAINNET,
	NETWORK_SOLANA_MAINNET,
	send402,
	verifyPayment,
	settlePayment,
	encodePaymentResponseHeader,
	permit2VariantOf,
	resolveResourceUrl,
	buildBazaarSchema,
} from '../_lib/x402-spec.js';
import { env } from '../_lib/env.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import {
	PAYMENT_IDENTIFIER,
	checkCache,
	claimSlotOrRespond,
	extractIdFromHeader,
	hashPaymentProof,
	hashRequestPayload,
	paymentIdentifierExtension,
	releaseSlot,
	storeResponse,
	writeCachedResponse,
	writeConflict,
} from '../_lib/x402/payment-identifier-server.js';
import { installAccessControl } from '../_lib/x402/access-control.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';
import { assertSafePublicUrl } from '../_lib/ssrf-guard.js';
import { encodeJobToken } from '../_lib/forge-job-token.js';
import {
	CANONICAL_ORDER,
	validateChain,
	priceForChain,
	stageGrammar,
	submitStage,
	availableStages,
} from '../_lib/pipeline.js';
import { createPipelineJob, savePipelineJob, publicView } from '../_lib/pipeline-store.js';

const ROUTE = '/api/x402/pipeline';
const REQUIRED_SCOPE = 'x402:bypass';
const accessControl = installAccessControl({ requiredScope: REQUIRED_SCOPE });
const routeConfig = { path: ROUTE, method: 'POST', requiredScope: REQUIRED_SCOPE };

const HTTP_URL_RE = /^https:\/\/[^\s]+$/i;

const ROUTE_DESCRIPTION =
	'One call, full 3D asset pipeline — text or GLB in, rigged/optimized ' +
	'game-ready GLB out; the only asset pipeline in the x402 ecosystem. Submit an ' +
	'ordered chain of stages (generate → rig → remesh → gameready → stylize) and ' +
	'get back a job token you poll for FREE at GET /api/forge?job=<id>, watching ' +
	'per-stage progress until the final GLB is delivered. Priced per stage and ' +
	'quoted EXACTLY in the 402 challenge (the sum of the requested stages). Pay ' +
	'autonomously in USDC on Solana mainnet — no API key, no account.';

const INPUT_EXAMPLE = {
	stages: ['generate', 'rig'],
	prompt: 'a brass steampunk owl, full body',
	options: { tier: 'draft', rig: { rig_type: 'biped' } },
};

const INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['stages'],
	properties: {
		stages: {
			type: 'array',
			minItems: 1,
			maxItems: CANONICAL_ORDER.length,
			items: { type: 'string', enum: [...CANONICAL_ORDER] },
			description:
				'Ordered subsequence of ' + JSON.stringify(CANONICAL_ORDER) +
				'. generate must be first and requires prompt; without generate, glb_url is required.',
		},
		prompt: {
			type: 'string',
			minLength: 3,
			maxLength: 1000,
			description: 'Subject for the generate stage. Required when stages starts with generate.',
		},
		glb_url: {
			type: 'string',
			format: 'uri',
			description: 'Public https GLB to feed the first stage when the chain does not start with generate.',
		},
		options: {
			type: 'object',
			description: 'Per-stage options: { tier, aspect_ratio, rig:{rig_type}, remesh:{...}, gameready:{topology,poly_budget,texture_size}, stylize:{style,resolution} }.',
		},
	},
};

const OUTPUT_EXAMPLE = {
	job_id: 'f1.eyJwIjoicGlwZWxpbmUifQ.sig',
	status: 'running',
	poll_url: '/api/forge?job=f1.eyJwIjoicGlwZWxpbmUifQ.sig',
	price_usdc: '0.15',
	stages: [
		{ id: 'generate', status: 'done', output_url: 'https://three.ws/cdn/forge/…/model.glb' },
		{ id: 'rig', status: 'running', output_url: null },
	],
};

const OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['job_id', 'status', 'stages'],
	properties: {
		job_id: { type: 'string', description: 'Poll this FREE on GET /api/forge?job=<id>.' },
		status: { type: 'string', description: '"queued" | "running" | "done" | "failed".' },
		poll_url: { type: 'string' },
		price_usdc: { type: 'string' },
		result_glb_url: { type: ['string', 'null'], description: 'Latest completed stage output; the final GLB when status is done.' },
		stages: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					id: { type: 'string' },
					status: { type: 'string' },
					started_at: { type: ['string', 'null'] },
					finished_at: { type: ['string', 'null'] },
					output_url: { type: ['string', 'null'] },
					error: { type: ['string', 'null'] },
				},
			},
		},
	},
};

function buildRequirements(resourceUrl, priceAtomics) {
	const amount = String(priceAtomics);
	// Solana mainnet USDC only in production. Base is a dev/preview failsafe when
	// X402_PAY_TO_SOLANA is unset so the route never dead-ends with an empty 402.
	if (env.X402_PAY_TO_SOLANA) {
		return [
			{
				scheme: 'exact',
				network: NETWORK_SOLANA_MAINNET,
				amount,
				payTo: env.X402_PAY_TO_SOLANA,
				asset: env.X402_ASSET_MINT_SOLANA,
				maxTimeoutSeconds: 60,
				resource: resourceUrl,
				extra: { name: 'USDC', decimals: 6, feePayer: env.X402_FEE_PAYER_SOLANA },
			},
		];
	}
	const eip3009 = {
		scheme: 'exact',
		network: NETWORK_BASE_MAINNET,
		amount,
		payTo: env.X402_PAY_TO_BASE,
		asset: env.X402_ASSET_ADDRESS_BASE,
		maxTimeoutSeconds: 60,
		resource: resourceUrl,
		extra: { name: 'USD Coin', version: '2', decimals: 6 },
	};
	const out = [eip3009];
	const permit2 = permit2VariantOf(eip3009);
	if (permit2) out.push(permit2);
	return out;
}

function bazaarFor() {
	return {
		discoverable: true,
		info: {
			input: { type: 'http', method: 'POST', bodyType: 'json', body: INPUT_EXAMPLE },
			output: { type: 'json', example: OUTPUT_EXAMPLE },
		},
		schema: buildBazaarSchema({
			method: 'POST',
			bodyType: 'json',
			bodySchema: INPUT_SCHEMA,
			outputSchema: OUTPUT_SCHEMA,
		}),
	};
}

// Parse + validate the request body into a resolved plan. Throws a tagged error
// (status/code/message) on any grammar/input fault so the handler rejects it
// BEFORE payment. Pure validation + a live env-driven grammar check.
function parsePlan(body) {
	body = body && typeof body === 'object' ? body : {};
	const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
	const glbUrl = typeof body.glb_url === 'string' ? body.glb_url.trim() : '';
	const hasPrompt = prompt.length >= 3 && prompt.length <= 1000;
	const hasGlb = HTTP_URL_RE.test(glbUrl) && glbUrl.length <= 2048;

	if (glbUrl && !hasGlb) {
		throw tagged(400, 'invalid_glb_url', 'glb_url must be a public https URL under 2048 characters.');
	}

	const check = validateChain(body.stages, { hasPrompt, hasGlb });
	if (!check.ok) throw tagged(check.status || 400, check.code, check.message);

	const options = body.options && typeof body.options === 'object' ? body.options : {};
	return {
		stages: check.stages,
		prompt: hasPrompt ? prompt : null,
		glbUrl: hasGlb ? glbUrl : null,
		options,
	};

	function tagged(status, code, message) {
		return Object.assign(new Error(message), { status, code });
	}
}

// GET — free discovery: the live stage grammar + per-stage pricing so agents can
// see capability and cost before paying. No payment, no work.
function handleGet(req, res) {
	const url = new URL(req.url, 'http://localhost');
	if (url.searchParams.get('job')) {
		return json(res, 400, {
			error: 'wrong_endpoint',
			message: 'Poll pipeline jobs on GET /api/forge?job=<id> (free), not here.',
		});
	}
	const grammar = stageGrammar();
	return json(res, 200, {
		route: ROUTE,
		description: ROUTE_DESCRIPTION,
		method: 'POST',
		input_schema: INPUT_SCHEMA,
		poll: 'GET /api/forge?job=<id>',
		...grammar,
		pricing_note: 'The 402 quote is the sum of the requested stages’ prices.',
	});
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', origins: '*' })) return;

	if (req.method === 'GET') return handleGet(req, res);
	if (req.method !== 'POST') {
		res.setHeader('allow', 'GET, POST');
		return error(res, 405, 'method_not_allowed', 'use POST to run a pipeline, GET for the stage grammar + pricing');
	}

	// Light pre-payment rate limit so the 402 challenge + validation can't be hammered.
	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	// Read the raw body once (validate + hash for idempotency).
	const chunks = [await readBody(req, 1_000_000)];
	const rawBody = Buffer.concat(chunks).toString('utf8');

	// A body that never becomes a plan must NOT short-circuit the paywall. Every
	// directory that indexes a paid route registers it by probing with a bare
	// POST and no body, and reads anything other than 402 as a row that sells
	// nothing. Answering that probe with a 400 is why this route stayed
	// unlistable while quoting a spec-valid 402 to real buyers. The probe now
	// gets the challenge, priced at the catalog's example chain (the same amount
	// /.well-known/x402.json and /openapi.json advertise for this route), and the
	// validation error is re-raised below for any caller that crosses the paywall.
	let plan = null;
	let planError = null;
	try {
		const bodyObj = rawBody ? JSON.parse(rawBody) : {};
		plan = parsePlan(bodyObj);
	} catch (err) {
		planError = err.status
			? { status: err.status, code: err.code, message: err.message }
			: { status: 400, code: 'invalid_json', message: 'Request body must be valid JSON.' };
	}

	// The 402 quote is the EXACT sum of the requested stages' prices; an
	// unpriceable probe body quotes the catalog's example chain instead.
	const price = priceForChain(plan ? plan.stages : INPUT_EXAMPLE.stages);
	const resourceUrl = resolveResourceUrl(req, ROUTE);
	const requirements = buildRequirements(resourceUrl, price.atomics);
	const service = withService({
		serviceName: 'three.ws 3D Asset Pipeline',
		tags: ['3d', 'pipeline', 'rig', 'gameready', 'glb'],
	});
	const challenge = {
		resourceUrl,
		accepts: requirements,
		description: ROUTE_DESCRIPTION,
		bazaar: bazaarFor(),
		extensions: { [PAYMENT_IDENTIFIER]: paymentIdentifierExtension(false) },
		serviceName: service.serviceName,
		tags: service.tags,
		iconUrl: service.iconUrl,
	};

	// Internal / subscription / OAuth callers bypass payment.
	const acResult = await accessControl(req, routeConfig);
	if (acResult?.abort) {
		if (acResult.headers) for (const [k, v] of Object.entries(acResult.headers)) res.setHeader(k, v);
		return error(res, acResult.status || 403, acResult.code || 'access_denied', acResult.reason || 'access denied');
	}
	const bypass = Boolean(acResult?.grantAccess);

	const paymentHeader = req.headers['x-payment'] || req.headers['payment-signature'];
	if (!bypass && !paymentHeader) return send402(res, challenge);

	// Past the paywall with a body we could not turn into a plan: answer the
	// validation error it earned. Nothing settles, because nothing ran.
	if (planError) return error(res, planError.status, planError.code, planError.message);

	// Guard the input GLB against SSRF before any lane fetches it.
	if (plan.glbUrl) {
		try {
			await assertSafePublicUrl(plan.glbUrl);
		} catch {
			return error(res, 400, 'invalid_glb_url', 'glb_url must resolve to a public host.');
		}
	}

	// Idempotency: a retried payment (same id, same body) returns the SAME job
	// token instead of launching a second pipeline and double-charging.
	let paymentId = null;
	let payloadHash = null;
	let paymentHash = null;
	let ownsReservation = false;
	if (!bypass) {
		const clientPaymentId = extractIdFromHeader(paymentHeader);
		payloadHash = hashRequestPayload({ method: 'POST', url: ROUTE, body: rawBody });
		paymentHash = hashPaymentProof(paymentHeader);
		paymentId = clientPaymentId || (paymentHash ? `proof:${paymentHash}` : null);
		if (paymentId) {
			const lookup = await checkCache({ route: ROUTE, paymentId, payloadHash, paymentHash });
			if (lookup.kind === 'hit') return writeCachedResponse(res, lookup.entry);
			if (lookup.kind === 'conflict') {
				return writeConflict(res, {
					route: ROUTE,
					attemptedHash: lookup.attemptedHash,
					existingHash: lookup.existingHash,
					reason: lookup.reason,
				});
			}
			// Close the check-then-act window: N concurrent requests carrying the
			// same payment could all miss the cache, all launch a pipeline, and
			// all settle before the first response was stored. The NX claim
			// admits exactly one; the rest are answered inside claimSlotOrRespond.
			ownsReservation = await claimSlotOrRespond({ res, route: ROUTE, paymentId, payloadHash, paymentHash });
			if (!ownsReservation) return;
		}
	}

	let verified;
	if (!bypass) {
		try {
			verified = await verifyPayment({ paymentHeader, requirements });
		} catch (err) {
			if (ownsReservation) await releaseSlot({ route: ROUTE, paymentId });
			if (err.status === 402) return send402(res, { ...challenge, error: err.message });
			return error(res, err.status || 502, err.code || 'verify_failed', err.message);
		}
	}

	// Submit the FIRST stage AFTER verify but BEFORE settle so a dead first lane
	// never charges. A throw here means no settlement ran → the buyer isn't billed.
	const firstStageInput = plan.stages[0] === 'generate' ? null : plan.glbUrl;
	let firstHandle;
	try {
		firstHandle = await submitStage(plan.stages[0], {
			prompt: plan.prompt,
			glbUrl: firstStageInput,
			options: plan.options,
		});
	} catch (err) {
		if (ownsReservation) await releaseSlot({ route: ROUTE, paymentId });
		return respondStageError(res, err);
	}

	if (!bypass) {
		let settled;
		try {
			settled = await settlePayment({ verified });
		} catch (err) {
			if (ownsReservation) await releaseSlot({ route: ROUTE, paymentId });
			return error(res, err.status || 502, err.code || 'settle_failed', err.message);
		}
		res.setHeader('x-payment-response', encodePaymentResponseHeader(settled));
	} else {
		res.setHeader('x-payment-bypass', acResult.reason || 'granted');
	}

	// Persist the job record with the first stage's result already applied, so the
	// very first free poll shows real progress.
	const job = await createPipelineJob({
		stages: plan.stages,
		prompt: plan.prompt,
		glbUrl: plan.glbUrl,
		options: plan.options,
		priceUsdc: price.usdc,
		priceAtomics: price.atomics,
		network: env.X402_PAY_TO_SOLANA ? NETWORK_SOLANA_MAINNET : NETWORK_BASE_MAINNET,
	});
	if (!job) {
		if (ownsReservation) await releaseSlot({ route: ROUTE, paymentId });
		return error(
			res,
			503,
			'store_unavailable',
			'The pipeline job store is unavailable on this deployment. Set UPSTASH_REDIS_REST_URL to enable multi-stage jobs.',
		);
	}
	applyFirstHandle(job, firstHandle);
	await savePipelineJob(job);

	const token = encodeJobToken({ provider: 'pipeline', kind: null, taskId: job.id });
	const view = publicView(job);
	const body = JSON.stringify({
		...view,
		job_token: token,
		poll_url: `/api/forge?job=${encodeURIComponent(token)}`,
		price_usdc: price.usdc,
		result_glb_url: job.result_glb_url,
	});

	res.setHeader('cache-control', 'no-store');
	res.setHeader('content-type', 'application/json; charset=utf-8');
	res.end(body);

	if (!bypass && paymentId) {
		await storeResponse({
			route: ROUTE,
			paymentId,
			payloadHash,
			paymentHash,
			status: 200,
			body,
			contentType: 'application/json; charset=utf-8',
			paymentResponseHeader: res.getHeader('x-payment-response') || null,
		});
	}
});

// Apply the pre-settlement first-stage submit result onto the fresh job record.
function applyFirstHandle(job, handle) {
	const stage = job.stages[0];
	stage.started_at = new Date().toISOString();
	if (handle.done && handle.glbUrl) {
		stage.status = 'done';
		stage.finished_at = new Date().toISOString();
		stage.output_url = handle.glbUrl;
		job.result_glb_url = handle.glbUrl;
		job.status = job.stages.length === 1 ? 'done' : 'running';
	} else {
		stage.status = 'running';
		stage.handle = handle;
		job.status = 'running';
	}
}

// Map a first-stage submit failure onto an HTTP response. Because submit runs
// before settle, the payment was never taken — say so plainly. Provider detail
// (vendor billing/credit strings, task ids) is masked to neutral copy.
function respondStageError(res, err) {
	if (err?.status === 429 || err?.code === 'rate_limited') {
		const retryAfter = Number.isFinite(err?.retryAfter) && err.retryAfter > 0 ? Math.ceil(err.retryAfter) : 5;
		res.setHeader('retry-after', String(retryAfter));
		return error(res, 429, 'rate_limited', 'The first stage is briefly busy and your payment was not taken — retry in a few seconds.', { retry_after: retryAfter });
	}
	if (err?.status === 501 || err?.code === 'stage_unconfigured') {
		return error(res, 503, 'stage_unavailable', `That stage is not available right now and your payment was not taken. Available stages: ${availableStages().join(', ') || '(none)'}.`);
	}
	const status = err?.status || 502;
	if (status >= 500) {
		console.warn(`[x402/pipeline] first stage failed (${status}): ${err?.message || err}`);
		return error(res, status, err?.code || 'stage_failed', 'The pipeline could not start and your payment was not taken — please retry shortly.');
	}
	return error(res, status, err?.code || 'stage_failed', err?.message);
}
