// MCP server — Streamable HTTP transport (MCP 2025-06-18, JSON-RPC 2.0)
// POST /api/mcp: tool calls. DELETE /api/mcp: terminate session (stateless, 204).
// GET /api/mcp serves the OAuth + x402 challenge to an unauthenticated caller so
// clients can discover how to pay or sign in; there is no server-to-client
// subscription yet, so an authenticated GET answers 405 with `allow: POST, DELETE`.
import { cors, readJson, wrap } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { settlePayment, encodePaymentResponseHeader } from './_lib/x402-spec.js';
import { x402AmountForTool } from './_lib/pump-pricing.js';
import { priceBatch, isDiscoveryOnlyBatch } from './_lib/mcp-batch-price.js';
import { PROTOCOL_VERSION, dispatch, isPublicTool } from './_mcp/dispatch.js';
import {
	send401,
	sendJsonRpcError,
	authenticateRequest,
	handleSse,
	handleTerminate,
	isMcpProtocolClient,
} from './_mcp/auth.js';
import { sendX402Error, reservePaymentProof } from './_mcp/payments.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,HEAD,POST,DELETE,OPTIONS', origins: '*' })) return;

	if (req.method === 'GET' || req.method === 'HEAD') return handleSse(req, res);
	if (req.method === 'DELETE') return handleTerminate(req, res);
	if (req.method !== 'POST') return send401(res, 'method not supported');

	// Read + parse the body BEFORE the x402 challenge so we can price the 402 by
	// the tool actually being called. Malformed JSON throws with status 400,
	// handled by wrap() — identical to the previous post-auth read.
	const body = await readJson(req, 2_000_000);

	// Derive the x402 price for the WHOLE request by summing the per-tool price
	// of every tools/call in the (possibly batched) body. The advertised 402
	// amount, the verified payment, and the settled charge are all keyed off this
	// total, so a multi-call batch can never run several priced tools for one
	// tool's price. A fully-free batch yields null → no charge.
	const { totalAmount: x402Amount, allFree } = priceBatch(body, {
		priceForTool: x402AmountForTool,
		isFreeName: isPublicTool,
	});

	// A batch composed solely of free public tools (e.g. getting_started) is
	// served without an OAuth token or x402 payment so any client can discover
	// the server first. Likewise discovery-only batches (initialize /
	// tools/list / ping) from plain x402 agents and crawlers — but NOT from
	// MCP protocol clients, which need the 401 to start their OAuth flow.
	const result = await authenticateRequest(req, res, {
		x402Amount,
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
	// Per-request batch cap — each message can trigger DB queries, so an
	// unbounded batch multiplies rate-limited work by N against the user's budget.
	if (batch.length > 32) return sendJsonRpcError(res, null, -32600, 'batch too large (max 32)');

	// Replay guard (parity with paidEndpoint): hold a single-use lock on the
	// signed payment proof across dispatch+settle so a captured/retried X-PAYMENT
	// can't re-run the priced tools before the first settle lands. Released in the
	// finally once the request finishes; the consumed on-chain nonce blocks any
	// replay thereafter. Fails open — see reservePaymentProof.
	let releaseProof = async () => {};
	if (x402Ctx) {
		const guard = await reservePaymentProof(
			'/api/mcp',
			// authenticateRequest accepts BOTH payment headers (v1 X-PAYMENT and
			// the v2 payment-signature dialect); the guard must key on whichever
			// one carried the proof or a v2 replay slips past it unclaimed.
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

		// Settle the x402 payment AFTER the work succeeded — atomic from the caller's
		// perspective: if settle fails, the payer's signed payload is not broadcast
		// and they get a 502 instead of having paid for nothing.
		//
		// Only settle when at least one call actually produced a result. If every
		// call failed (JSON-RPC error or a tool result flagged isError), no useful
		// work was delivered, so we do not broadcast the payment. We deliberately do
		// NOT void settlement on a *partial* failure: a single failing call in a
		// batch must not let the caller reclaim the expensive calls that succeeded.
		const anySuccess = responses.some((r) => r && !r.error && !(r.result && r.result.isError));
		if (x402Ctx && anySuccess) {
			try {
				const settled = await settlePayment({ verified: x402Ctx.verified });
				res.setHeader('x-payment-response', encodePaymentResponseHeader(settled));
			} catch (err) {
				return sendX402Error(
					res,
					{ resourceUrl: x402Ctx.resourceUrl, accepts: x402Ctx.requirements },
					err,
				);
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
