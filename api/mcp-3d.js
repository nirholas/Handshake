// three.ws 3D Studio: MCP server (Streamable HTTP transport, MCP 2025-06-18).
// POST /api/mcp-3d: tool calls   GET /api/mcp-3d: SSE   DELETE: terminate.
//
// A second, focused MCP server alongside /api/mcp: it does one thing, turn
// text or images into interactive 3D models, and shares the main server's
// OAuth/x402 auth, rate limiting, and transport plumbing. Registered with the
// MCP Registry as io.github.nirholas/three-ws-3d-studio (see server-3d.json).
import { cors, readJson, wrap } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { settlePayment, encodePaymentResponseHeader } from './_lib/x402-spec.js';
import { priceBatch, isDiscoveryOnlyBatch } from './_lib/mcp-batch-price.js';
import { PROTOCOL_VERSION, dispatch, isPublicTool } from './_mcp3d/dispatch.js';
import { STUDIO_CHALLENGE } from './_mcp3d/discovery.js';
import { studioX402Amount } from './_mcp3d/pricing.js';
import {
	send401,
	sendJsonRpcError,
	authenticateRequest,
	handleSse,
	handleTerminate,
	isMcpProtocolClient,
} from './_mcp/auth.js';
import { sendX402Error, reservePaymentProof } from './_mcp/payments.js';

const RESOURCE_PATH = '/api/mcp-3d';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,HEAD,POST,DELETE,OPTIONS', origins: '*' })) return;

	if (req.method === 'GET' || req.method === 'HEAD')
		return handleSse(req, res, { resourcePath: RESOURCE_PATH, challenge: STUDIO_CHALLENGE });
	if (req.method === 'DELETE') return handleTerminate(req, res);
	if (req.method !== 'POST') return send401(res, 'method not supported');

	// Read + parse the body before auth so free traffic can be served without
	// an OAuth token or x402 payment: the public getting_started tool, and
	// discovery-only batches (initialize / tools/list / ping) from plain x402
	// agents and crawlers. MCP protocol clients still receive the 401 on
	// discovery so the OAuth flow starts where it should.
	const body = await readJson(req, 1_000_000);

	// x402 price for the WHOLE request, the sum of every priced studio
	// tools/call in the (possibly batched) body, tier-aware for the generation
	// tools. The advertised 402 amount, the verified payment, and the settled
	// charge are all keyed off this total, mirroring /api/x402/forge pricing.
	const { totalAmount: x402Amount, allFree } = priceBatch(body, {
		priceForTool: studioX402Amount,
		isFreeName: isPublicTool,
	});

	const result = await authenticateRequest(req, res, {
		x402Amount,
		resourcePath: RESOURCE_PATH,
		challenge: STUDIO_CHALLENGE,
		allowFree: allFree || (isDiscoveryOnlyBatch(body) && !isMcpProtocolClient(req)),
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

	// Replay guard (parity with paidEndpoint): hold a single-use lock on the
	// signed payment proof across dispatch+settle so a captured/retried X-PAYMENT
	// can't re-run the priced (and here often generation-grade) tools before the
	// first settle lands. Released in the finally; the consumed on-chain nonce
	// blocks any replay thereafter. Fails open, see reservePaymentProof.
	let releaseProof = async () => {};
	if (x402Ctx) {
		const guard = await reservePaymentProof(
			'/api/mcp-3d',
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
			const r = await dispatch(msg, auth, req);
			if (r !== null) responses.push(r);
		}

		// OAuth users run tools operator-funded (bounded by rate limits). x402
		// callers pay per tool: the verified payment covers the batch's summed
		// per-tool price (tier-aware for generation, see _mcp3d/pricing.js), and
		// settling it here means the charge lands only after the work succeeded.
		// Only settle if a call succeeded, a wholesale failure is free.
		if (x402Ctx) {
			const anySuccess = responses.some(
				(r) => r && !r.error && !(r.result && r.result.isError),
			);
			if (anySuccess) {
				try {
					const settled = await settlePayment({ verified: x402Ctx.verified });
					// Both receipt header names: PAYMENT-RESPONSE is the x402 v2
					// standard (what OKX Agent Payments Protocol buyers decode),
					// x-payment-response the v1 name legacy clients still read.
					const receipt = encodePaymentResponseHeader(settled);
					res.setHeader('PAYMENT-RESPONSE', receipt);
					res.setHeader('x-payment-response', receipt);
				} catch (err) {
					return sendX402Error(
						res,
						{ resourceUrl: x402Ctx.resourceUrl, accepts: x402Ctx.requirements },
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
});
