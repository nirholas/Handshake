// OKX.AI marketplace services, one Vercel function, many fronts.
// Routes /api/okx/3d/<service> per the catalog in api/_lib/okx-catalog.js:
//
//   /api/okx/3d/catalog          GET, free, machine-readable service index
//   /api/okx/3d/health           GET, free, live subsystem health (real probes)
//   /api/okx/3d/forge-draft      A2MCP, the LISTED line-up (api/_okx3d/forge.js).
//   /api/okx/3d/forge-standard   Each row is a real MCP Streamable HTTP server:
//   /api/okx/3d/forge-hd         POST tool calls, GET SSE, DELETE terminate.
//   /api/okx/3d/forge-image      forge_3d is x402-priced on the X Layer rail;
//   /api/okx/3d/forge-status     forge_status + getting_started are free.
//   /api/okx/3d/identity-studio  A2MCP, back burner (unlisted, still routable).
//   /api/okx/3d/<paid service>   REST, back burner (unlisted, still routable):
//                                plain JSON POST, one capability + one price per
//                                endpoint. Unpaid POST → OKX-dialect 402
//                                (PAYMENT-REQUIRED header + body); paid replay →
//                                verify → engine → settle → PAYMENT-RESPONSE.
//                                GET is the free per-service descriptor. Engines
//                                in api/_okx3d/rest-services.js.
//
// Both A2MCP families share ONE transport (handleA2mcp): same challenge, verify,
// batch pricing, single-use payment proof and settle-on-success. Only the tool
// catalog, the price function and the discovery metadata differ per service.
import { cors, error, json, readBody, readJson, wrap } from '../../_lib/http.js';
import { limits, clientIp } from '../../_lib/rate-limit.js';
import {
	buildExactRequirements,
	encodePaymentResponseHeader,
	resolveResourceUrl,
	settlePayment,
	verifyPayment,
	X402Error,
} from '../../_lib/x402-spec.js';
import {
	okxXLayerAccept,
	sendOkx402,
	xlayerRailHealth,
	xlayerSettleable,
} from '../../_lib/x402-xlayer-okx.js';
import { priceBatch, isDiscoveryOnlyBatch } from '../../_lib/mcp-batch-price.js';
import { OKX_CATALOG, catalogIndex, catalogEntry, listingDescription } from '../../_lib/okx-catalog.js';
import { headObject, putObject } from '../../_lib/r2.js';
import { sql } from '../../_lib/db.js';
import { FORGE_TOOL } from '../../_lib/okx-catalog.js';
import {
	PAYMENT_IDENTIFIER,
	checkCache,
	extractIdFromHeader,
	hashPaymentProof,
	hashRequestPayload,
	storeResponse,
	writeCachedResponse,
	writeConflict,
} from '../../_lib/x402/payment-identifier-server.js';
import {
	send401,
	sendJsonRpcError,
	authenticateRequest,
	handleSse,
	handleTerminate,
} from '../../_mcp/auth.js';
import { sendX402Error, reservePaymentProof } from '../../_mcp/payments.js';
import {
	dispatch as identityDispatch,
	PROTOCOL_VERSION,
	identityX402Amount,
	isPublicIdentityTool,
} from '../../_okx3d/tools.js';
import { forgeSurface, isForgeService } from '../../_okx3d/forge.js';
import { IDENTITY_CHALLENGE } from '../../_okx3d/discovery.js';
import { invokeRestService, isRestPaidService } from '../../_okx3d/rest-services.js';

const BASE = 'https://three.ws';
const HEALTH_PROBE_KEY = 'okx-identity/health-probe.txt';

function serviceFrom(req) {
	if (typeof req.query?.service === 'string') return req.query.service;
	const m = String(req.url || '').match(/\/api\/okx\/3d\/([a-z0-9-]+)/);
	return m ? m[1] : '';
}

async function probe(name, fn) {
	const started = Date.now();
	try {
		const detail = await fn();
		return { name, ok: true, latency_ms: Date.now() - started, ...(detail || {}) };
	} catch (err) {
		const { message, stack, ...detail } = err && typeof err === 'object' ? err : {};
		return { name, ok: false, latency_ms: Date.now() - started, error: String(err?.message || err), ...detail };
	}
}

// Live health: every subsystem a paid job passes through, actually probed.
async function healthReport() {
	const subsystems = await Promise.all([
		probe('generation', async () => {
			// ?catalog is the tier + backend matrix /api/forge serves without
			// starting a job. A bare GET /api/forge answers 400 missing_job, which
			// a broken generation lane returns just as happily, so probe the
			// payload that actually proves the front door is up: reachable, and
			// carrying at least one tier and one backend.
			const res = await fetch(`${BASE}/api/forge?catalog`, {
				headers: { accept: 'application/json' },
				signal: AbortSignal.timeout(10_000),
			});
			if (!res.ok) throw new Error(`forge catalog returned ${res.status}`);
			const catalog = await res.json();
			const tiers = Array.isArray(catalog?.tiers) ? catalog.tiers.length : 0;
			const backends = Array.isArray(catalog?.backends) ? catalog.backends.length : 0;
			if (!tiers || !backends) throw new Error('forge catalog empty');
			return { tiers, backends };
		}),
		// What a buyer actually experiences. The `generation` probe proves the
		// front door is up; it read all-green on 2026-08-25 while every text
		// submit hung for 95 s+, because a stalled lane looks fine from a static
		// catalog. Every forge_3d call lands in usage_events with its latency and
		// status (makeDispatcher records both), so the last hour of real submits
		// is the honest reading: how long acceptance took, and how many failed.
		probe('submit-latency', async () => {
			const rows = await sql`
				select
					count(*)::int as samples,
					count(*) filter (where status <> 'ok')::int as errors,
					percentile_cont(0.5) within group (order by latency_ms)::int as p50_ms,
					percentile_cont(0.9) within group (order by latency_ms)::int as p90_ms
				from usage_events
				where kind = 'tool_call' and tool = ${FORGE_TOOL}
					and created_at > now() - interval '60 minutes'
			`;
			const r = rows[0] || {};
			const samples = Number(r.samples) || 0;
			const errors = Number(r.errors) || 0;
			const p50 = r.p50_ms == null ? null : Number(r.p50_ms);
			const p90 = r.p90_ms == null ? null : Number(r.p90_ms);
			const detail = { window_minutes: 60, samples, errors, p50_ms: p50, p90_ms: p90 };
			// Three or more real submits in the hour is enough to judge. A median
			// past 45 s means a ChatGPT-class client never sees the accept; more
			// failures than successes means the lane is not taking jobs.
			if (samples >= 3 && p50 != null && p50 > 45_000) throw Object.assign(new Error(`median submit ${p50} ms over the last hour`), detail);
			if (samples >= 3 && errors * 2 > samples) throw Object.assign(new Error(`${errors} of ${samples} submits failed in the last hour`), detail);
			return detail;
		}),
		probe('render', async () => {
			const res = await fetch(`${BASE}/api/render/avatar-clip`, {
				headers: { accept: 'application/json' },
				signal: AbortSignal.timeout(10_000),
			});
			if (!res.ok) throw new Error(`renderer returned ${res.status}`);
			const data = await res.json();
			if (!Array.isArray(data?.poses) || data.poses.length === 0) throw new Error('pose catalog empty');
			return { poses: data.poses.length };
		}),
		probe('storage', async () => {
			try {
				await headObject(HEALTH_PROBE_KEY);
			} catch {
				await putObject({
					key: HEALTH_PROBE_KEY,
					body: Buffer.from('agent-identity-studio storage probe', 'utf8'),
					contentType: 'text/plain',
				});
				await headObject(HEALTH_PROBE_KEY);
			}
		}),
		probe('retarget', async () => {
			// The animation library the retarget service reads clips from, a
			// reachable, non-empty manifest proves the clip lane is servable.
			const res = await fetch(`${BASE}/animations/manifest.json`, {
				headers: { accept: 'application/json' },
				signal: AbortSignal.timeout(10_000),
			});
			if (!res.ok) throw new Error(`animation manifest returned ${res.status}`);
			const manifest = await res.json();
			const clips = Array.isArray(manifest) ? manifest.length : Array.isArray(manifest?.animations) ? manifest.animations.length : 0;
			if (!clips) throw new Error('animation manifest empty');
			return { clips };
		}),
		probe('payment-rail', async () => {
			// Real X Layer probe: RPC block height, fee-token symbol read, and
			// settlement-route configuration (OKX facilitator creds / relayer).
			const rail = await xlayerRailHealth();
			if (rail.rpc && !rail.rpc.ok) throw new Error(rail.rpc.error || 'X Layer RPC unreachable');
			return {
				settleable: rail.settleable,
				block: rail.rpc?.block,
				token: rail.token?.symbol,
				facilitator_configured: rail.facilitator?.configured ?? false,
			};
		}),
	]);
	return { ok: subsystems.every((s) => s.ok), subsystems, checkedAt: new Date().toISOString() };
}

// /health is free and unauthenticated, and one call fans out to five
// subsystems (three HTTP probes, an R2 head, an X Layer RPC read). Memoize the
// report briefly and let concurrent callers share the in-flight probe, so a
// poll loop costs the subsystems one sweep per window instead of one per
// request. Same shape /api/forge?health uses. `checkedAt` in the body tells the
// caller how old the reading is, and OKX_HEALTH_TTL_MS tunes the window (0
// disables the memo and probes on every request).
const HEALTH_TTL_DEFAULT_MS = 30_000;
let healthMemo = { at: 0, report: null };
let healthInFlight = null;

function healthTtlMs() {
	const raw = Number(process.env.OKX_HEALTH_TTL_MS);
	return Number.isFinite(raw) && raw >= 0 ? raw : HEALTH_TTL_DEFAULT_MS;
}

async function cachedHealthReport() {
	if (healthMemo.report && Date.now() - healthMemo.at < healthTtlMs()) return healthMemo.report;
	if (!healthInFlight) {
		healthInFlight = healthReport()
			.then((report) => {
				healthMemo = { at: Date.now(), report };
				return report;
			})
			.finally(() => {
				healthInFlight = null;
			});
	}
	return healthInFlight;
}

// Per-service accepts: the OKX X Layer entry leads (that is the rail this
// surface exists for, the buyer CLI auto-selects the first `exact` entry),
// followed by the platform's existing rails so non-OKX agents can pay too.
// One service, one price: every entry carries the same catalog amount.
function restRequirements(resourceUrl, entry) {
	const out = [];
	if (xlayerSettleable()) out.push(okxXLayerAccept(resourceUrl, entry.amountAtomics));
	out.push(...buildExactRequirements(resourceUrl, entry.amountAtomics));
	return out;
}

// Free GET descriptor, per-service discovery, mirroring GET /api/x402/forge:
// what it does, what it costs, how to call it. No payment, no account.
function restDescriptor(res, entry) {
	return json(
		res,
		200,
		{
			service: entry.id,
			name: entry.name,
			endpoint: entry.endpoint,
			method: 'POST',
			price_usd: entry.priceUsd,
			description: listingDescription(entry),
			input_schema: entry.inputSchema,
			poll: 'GET /api/forge?job=<job_id>, free',
			catalog: `${BASE}/api/okx/3d/catalog`,
		},
		{ 'cache-control': 'public, max-age=300' },
	);
}

// Plain-JSON paid service (work order 03). Wire flow per
// specs/okx-agent-payments.md and the api/x402/forge.js seller pattern:
// unpaid POST → OKX-dialect 402; paid replay → idempotency check → verify →
// engine (submit/complete) → settle → 200 + PAYMENT-RESPONSE. Engine errors
// are answered BEFORE settlement, so a failed job never charges the buyer.
async function handleRestService(req, res, entry) {
	if (req.method === 'GET' || req.method === 'HEAD') return restDescriptor(res, entry);
	if (req.method !== 'POST') {
		res.setHeader('allow', 'GET, POST');
		return error(res, 405, 'method_not_allowed', 'POST to run the service, GET for its descriptor');
	}

	// Pre-payment surface (402 challenges, validation) is rate-limited; the
	// work itself is paywalled.
	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success)
		return json(res, 429, { error: 'rate_limited', retry_after: Math.ceil((rl.reset - Date.now()) / 1000) });

	// readBody, not a direct stream read: the Cloud Run server's body parsers
	// drain the stream before handlers run (bytes preserved on req.rawBody).
	const rawBody = (await readBody(req, 1_000_000)).toString('utf8');
	let body;
	try {
		body = rawBody ? JSON.parse(rawBody) : {};
	} catch {
		return error(res, 400, 'invalid_json', 'Request body must be valid JSON.');
	}

	const resourcePath = `/api/okx/3d/${entry.id}`;
	const resourceUrl = resolveResourceUrl(req, resourcePath);
	const requirements = restRequirements(resourceUrl, entry);
	if (!requirements.length) {
		return error(
			res,
			503,
			'rail_unconfigured',
			'No payment rail is configured on this deployment, set the X Layer envs per specs/okx-agent-payments.md.',
		);
	}

	const paymentHeader = req.headers['payment-signature'] || req.headers['x-payment'];
	if (!paymentHeader) {
		return sendOkx402(res, { resourceUrl, accepts: requirements });
	}

	// Idempotency + replay: a retried payment (same proof, same body) replays
	// the SAME response instead of submitting a second job; a concurrent replay
	// of an in-flight proof is refused. Identical plumbing to api/x402/forge.js.
	const clientPaymentId = extractIdFromHeader(paymentHeader);
	const payloadHash = hashRequestPayload({ method: 'POST', url: resourcePath, body: rawBody });
	const paymentHash = hashPaymentProof(paymentHeader);
	const paymentId = clientPaymentId || (paymentHash ? `proof:${paymentHash}` : null);
	if (paymentId) {
		const lookup = await checkCache({ route: resourcePath, paymentId, payloadHash, paymentHash });
		if (lookup.kind === 'hit') return writeCachedResponse(res, lookup.entry);
		if (lookup.kind === 'conflict') {
			return writeConflict(res, {
				route: resourcePath,
				attemptedHash: lookup.attemptedHash,
				existingHash: lookup.existingHash,
				reason: lookup.reason,
			});
		}
	}
	let releaseProof = async () => {};
	const guard = await reservePaymentProof(resourcePath, paymentHeader);
	if (!guard.ok) {
		return json(res, 409, { error: 'payment_in_flight', retry_after: 1 });
	}
	releaseProof = guard.release;

	try {
		let verified;
		try {
			verified = await verifyPayment({ paymentHeader, requirements });
		} catch (err) {
			if (err instanceof X402Error && err.status === 402) {
				return sendOkx402(res, { resourceUrl, accepts: requirements, error: err.message });
			}
			return error(res, err.status || 502, err.code || 'verify_failed', err.message);
		}

		// Engine runs AFTER verify, BEFORE settle, a thrown engine error means
		// the buyer was not charged, and we say so.
		let result;
		try {
			result = await invokeRestService(entry.id, body, { req, payer: verified.payer });
		} catch (err) {
			const status = err.status || 502;
			const message =
				status >= 500
					? 'The service could not complete and your payment was not taken, please retry shortly.'
					: err.message;
			if (status >= 500) console.warn(`[okx/3d/${entry.id}] engine failed (${status}): ${err?.message || err}`);
			return error(res, status, err.code || 'service_failed', message);
		}

		let settled;
		try {
			settled = await settlePayment({ verified });
		} catch (err) {
			return sendX402Error(res, { resourceUrl, accepts: requirements }, err);
		}

		const paymentResponse = encodePaymentResponseHeader(settled);
		const contentType = 'application/json; charset=utf-8';
		const responseBody = JSON.stringify({ service: entry.id, price_usd: entry.priceUsd, ...result });
		res.statusCode = 200;
		// v2 header name (OKX buyers decode PAYMENT-RESPONSE) + the legacy name
		// for x402 SDK clients paying over the platform rails. Both are already
		// in the expose list cors() set at the top of this handler; do not
		// re-set access-control-expose-headers here, an earlier narrowing to
		// just the two v2 names hid x-payment-response from cross-origin
		// readers on the one response that actually carries it.
		res.setHeader('PAYMENT-RESPONSE', paymentResponse);
		res.setHeader('x-payment-response', paymentResponse);
		res.setHeader('cache-control', 'no-store');
		res.setHeader('content-type', contentType);
		res.end(responseBody);

		if (paymentId) {
			await storeResponse({
				route: resourcePath,
				paymentId,
				payloadHash,
				paymentHash,
				status: 200,
				body: responseBody,
				contentType,
				paymentResponseHeader: paymentResponse,
			});
		}
	} finally {
		await releaseProof();
	}
}

// One A2MCP transport, every listed MCP service. Identity Studio and each
// forge row differ only in their tool catalog, their price function and their
// 402 discovery metadata, so those arrive as `cfg` and the wire behaviour
// (challenge, verify, batch pricing, single-use proof, settle-on-success)
// stays byte-identical across endpoints. A buyer that can pay one can pay all.
async function handleA2mcp(req, res, cfg) {
	const { serviceId, challenge, dispatch: dispatchTool, priceForTool, isFreeName, listPrice } = cfg;
	const resourcePath = `/api/okx/3d/${serviceId}`;
	const resourceUrl = resolveResourceUrl(req, resourcePath);
	// These services sell on OKX.AI, so the 402 must LEAD with the X Layer
	// (eip155:196) accept or an OKX buyer cannot pay it. Gated on the X Layer
	// envs being present. Prepended into the MCP challenge + verify path.
	// An amount of null stringifies to the literal "null" inside the accept, an
	// unpayable challenge that reads to a reviewer as a broken payment rail. No
	// amount means nothing to charge for, so there is no accept to advertise.
	const xlayerAcceptsFor = (amount) =>
		amount && xlayerSettleable() ? [okxXLayerAccept(resourceUrl, amount)] : [];

	if (req.method === 'GET' || req.method === 'HEAD') {
		// A free service has nothing to challenge for. Answering its GET with a
		// 402 (the shared default price, no less) told a reviewer the "free" row
		// costs money. This server holds no server-to-client stream, so the
		// honest answer is the same 405 the authenticated branch gives, and the
		// same shape the approved sellers on this marketplace answer GET with.
		if (!listPrice) {
			res.statusCode = 405;
			res.setHeader('allow', 'POST, DELETE');
			res.setHeader('cache-control', 'no-store');
			return res.end();
		}
		return handleSse(req, res, {
			resourcePath,
			challenge,
			extraAccepts: xlayerAcceptsFor(listPrice),
			x402Amount: listPrice,
			paymentStatus: 402,
		});
	}
	if (req.method === 'DELETE') return handleTerminate(req, res);
	if (req.method !== 'POST') return send401(res, 'method not supported');

	const body = await readJson(req, 1_000_000);

	const { totalAmount: x402Amount, allFree } = priceBatch(body, {
		priceForTool,
		isFreeName,
	});

	// A row with no list price sells nothing: every tool it serves is free. A
	// tools/call naming a tool it does NOT serve (forge_3d against the free
	// forge-status row, which is exactly the sweep a reviewer runs across every
	// listed endpoint) priced as null and matched no explicit free name, so it
	// fell through to a 402 quoting an amount of null. A free service must never
	// demand payment; the honest answer is the dispatcher's own unknown-tool
	// error. Same reasoning as the GET 405 above.
	const sellsNothing = !listPrice;

	// The X Layer accept must quote the SAME batch total the platform rails
	// quote. Pinned to the single-identity list price, a 16-call batch verified
	// (and settled) against ONE identity's price on the OKX rail: the exact
	// underpayment priceBatch was written to close, reopened by the rail that
	// leads accepts[]. A batch with no priced call has nothing to sum, so the
	// challenge falls back to the list price it advertises everywhere else.
	const extraAccepts = xlayerAcceptsFor(x402Amount || listPrice);

	const result = await authenticateRequest(req, res, {
		x402Amount,
		resourcePath,
		challenge,
		// Discovery (initialize / tools/list / ping) is free for EVERY caller
		// here, protocol clients included. The platform's other MCP surfaces
		// scope free discovery to non-protocol clients on purpose, because an
		// OAuth-capable client has to meet the 401 on initialize or it never
		// starts the OAuth flow. This surface has no OAuth (paymentStatus below
		// forces 402), so that exclusion protected nothing and instead
		// paywalled discovery: a spec-compliant MCP client sends
		// `Accept: text/event-stream` + `MCP-Protocol-Version`, so its
		// `initialize` and `tools/list` were answered 402 and it could never
		// connect, read a tool description, or read a parameter schema. That is
		// what the 2026-09-02 OKX review saw when it rejected the listing for
		// "missing a complete description, parameter details, and usage
		// examples"; curl, which sends neither header, was served 200 and hid
		// it. Paid work is unaffected: tools/call is never a discovery method.
		allowFree: allFree || sellsNothing || isDiscoveryOnlyBatch(body),
		extraAccepts,
		// OKX buyers pay a 402 and nothing else; there is no OAuth story on this
		// surface, so an MCP client must never be diverted to a 401.
		paymentStatus: 402,
	});
	if (!result) return;
	const { auth, x402Ctx } = result;

	const ipRl = await limits.mcpIp(clientIp(req));
	if (!ipRl.success)
		return sendJsonRpcError(res, null, -32000, 'rate_limited', {
			retry_after: Math.ceil((ipRl.reset - Date.now()) / 1000),
		});
	const userRl = await limits.mcpUser(auth.userId || auth.rateKey || clientIp(req));
	if (!userRl.success)
		return sendJsonRpcError(res, null, -32000, 'rate_limited', {
			retry_after: Math.ceil((userRl.reset - Date.now()) / 1000),
		});

	const batch = Array.isArray(body) ? body : [body];
	if (batch.length > 16) return sendJsonRpcError(res, null, -32600, 'batch too large (max 16)');

	// The JSON-RPC ids of the PAID calls in this batch. Settlement is judged on
	// these responses alone: in a mixed batch (initialize + create_identity), a
	// blanket "did anything succeed" charged the buyer the full identity price
	// when create_identity failed validation but the free message beside it
	// answered fine. Priced notifications carry no id, so an empty set falls
	// back to judging the whole batch.
	const pricedIds = new Set(
		batch
			.filter((m) => m?.method === 'tools/call' && priceForTool(m?.params?.name))
			.map((m) => m?.id)
			.filter((id) => id !== undefined && id !== null),
	);

	// Single-use lock on the payment proof across dispatch+settle, mirroring
	// /api/mcp-3d, a replayed X-PAYMENT can't run a second job before the
	// first settle lands.
	let releaseProof = async () => {};
	if (x402Ctx) {
		const guard = await reservePaymentProof(
			resourcePath,
			req.headers['x-payment'] || req.headers['payment-signature'],
		);
		if (!guard.ok) {
			return sendJsonRpcError(res, null, -32000, 'payment_in_flight', { retry_after: 1 });
		}
		releaseProof = guard.release;
	}

	try {
		const responses = [];
		for (const msg of batch) {
			const r = await dispatchTool(msg, auth, req);
			if (r !== null) responses.push(r);
		}

		// Settle only after the work was accepted: a create_identity that failed
		// validation (bad brief, unreachable reference image) returns isError and
		// the payment is never settled, the pay-only-on-acceptance promise the
		// catalog description makes.
		if (x402Ctx) {
			const judged = pricedIds.size ? responses.filter((r) => r && pricedIds.has(r.id)) : responses;
			const anySuccess = judged.some((r) => r && !r.error && !(r.result && r.result.isError));
			if (anySuccess) {
				try {
					const settled = await settlePayment({ verified: x402Ctx.verified });
					const receipt = encodePaymentResponseHeader(settled);
					res.setHeader('PAYMENT-RESPONSE', receipt);
					res.setHeader('x-payment-response', receipt);
				} catch (err) {
					return sendX402Error(
						res,
						{
							resourceUrl: x402Ctx.resourceUrl,
							accepts: x402Ctx.requirements,
							challenge,
						},
						err,
					);
				}
			}
		}

		res.statusCode = 200;
		res.setHeader('content-type', 'application/json; charset=utf-8');
		res.setHeader('mcp-protocol-version', PROTOCOL_VERSION);
		res.end(JSON.stringify(Array.isArray(body) ? responses : (responses[0] ?? null)));
	} finally {
		await releaseProof();
	}
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,HEAD,POST,DELETE,OPTIONS', origins: '*' })) return;

	const service = serviceFrom(req);

	// Every error on this surface answers in one envelope ({error,
	// error_description}, no-store): a buyer parsing a 405 from /catalog and a
	// 405 from /text-to-3d must not need two error readers.
	if (service === 'catalog') {
		if (req.method !== 'GET' && req.method !== 'HEAD') {
			res.setHeader('allow', 'GET, HEAD');
			return error(res, 405, 'method_not_allowed', 'catalog is GET-only');
		}
		return json(res, 200, catalogIndex(), { 'cache-control': 'public, max-age=300' });
	}

	if (service === 'health') {
		if (req.method !== 'GET' && req.method !== 'HEAD') {
			res.setHeader('allow', 'GET, HEAD');
			return error(res, 405, 'method_not_allowed', 'health is GET-only');
		}
		const report = await cachedHealthReport();
		// A green reading is edge-cacheable for the memo window; a red one is
		// not, so recovery shows up on the next request instead of waiting out a
		// CDN entry.
		return json(res, report.ok ? 200 : 503, report, {
			'cache-control': report.ok ? 'public, max-age=15, s-maxage=30' : 'no-store',
		});
	}

	if (service === 'identity-studio') {
		return handleA2mcp(req, res, {
			serviceId: 'identity-studio',
			challenge: IDENTITY_CHALLENGE,
			dispatch: identityDispatch,
			priceForTool: identityX402Amount,
			isFreeName: isPublicIdentityTool,
			listPrice: catalogEntry('identity-studio').amountAtomics,
		});
	}

	// The listed OKX.AI line-up: three.ws Forge. Every row is a real MCP server
	// over the same transport, priced from its own catalog entry.
	if (isForgeService(service)) {
		const surface = forgeSurface(service);
		return handleA2mcp(req, res, {
			serviceId: service,
			challenge: surface.challenge,
			dispatch: surface.dispatch,
			priceForTool: surface.x402Amount,
			isFreeName: surface.isPublicTool,
			listPrice: surface.entry.amountAtomics,
		});
	}

	if (isRestPaidService(service)) return handleRestService(req, res, catalogEntry(service));

	const known = catalogEntry(service);
	return error(
		res,
		404,
		'unknown_service',
		known
			? `service "${service}" is catalogued but not yet routable, see the catalog for status`
			: `no such service "${service}"`,
		{ services: OKX_CATALOG.map((e) => e.endpoint) },
	);
});
