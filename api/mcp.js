// MCP server — Streamable HTTP transport (MCP 2025-06-18, JSON-RPC 2.0)
// POST /api/mcp  — tool calls   GET /api/mcp  — SSE   DELETE /api/mcp  — terminate session
import { cors, readJson, wrap } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { settlePayment, encodePaymentResponseHeader } from './_lib/x402-spec.js';
import { PROTOCOL_VERSION, dispatch } from './_mcp/dispatch.js';
import { send401, sendJsonRpcError, authenticateRequest, handleSse, handleTerminate } from './_mcp/auth.js';
import { sendX402Error } from './_mcp/payments.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,HEAD,POST,DELETE,OPTIONS', origins: '*' })) return;

	if (req.method === 'GET' || req.method === 'HEAD') return handleSse(req, res);
	if (req.method === 'DELETE') return handleTerminate(req, res);
	if (req.method !== 'POST') return send401(res, 'method not supported');

	const result = await authenticateRequest(req, res);
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

	const body = await readJson(req, 2_000_000);
	const batch = Array.isArray(body) ? body : [body];
	// Per-request batch cap — each message can trigger DB queries, so an
	// unbounded batch multiplies rate-limited work by N against the user's budget.
	if (batch.length > 32)
		return sendJsonRpcError(res, null, -32600, 'batch too large (max 32)');

	const responses = [];
	for (const msg of batch) {
		const r = await dispatch(msg, auth, req);
		if (r !== null) responses.push(r);
	}

	// Settle the x402 payment AFTER the work succeeded — atomic from the caller's
	// perspective: if settle fails, the payer's signed payload is not broadcast
	// and they get a 502 instead of having paid for nothing.
	if (x402Ctx) {
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
});
