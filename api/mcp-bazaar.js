// three.ws x402 Bazaar — MCP server (Streamable HTTP transport, MCP 2025-06-18).
// POST /api/mcp-bazaar — tool calls   GET — SSE   DELETE — terminate.
//
// Discovery surface over the live x402 facilitator network: search, browse, and
// price paid agent services from any MCP client. Shares the main server's
// OAuth/x402 auth, rate limiting, and transport. Registered with the MCP
// Registry as io.github.nirholas/threews-x402-bazaar (see server-bazaar.json).
import { cors, readJson, wrap } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { settlePayment, encodePaymentResponseHeader } from './_lib/x402-spec.js';
import { peekCalledTool } from './_lib/mcp-dispatch.js';
import { isDiscoveryOnlyBatch } from './_lib/mcp-batch-price.js';
import { PROTOCOL_VERSION, dispatch, isPublicTool } from './_mcpbazaar/dispatch.js';
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

	// Read + parse the body before auth so a call to the free public
	// getting_started tool can be served without an OAuth token or x402 payment.
	// Discovery-only batches (initialize / tools/list / ping) from plain x402
	// agents and crawlers are likewise free — but NOT from MCP protocol clients,
	// which need the 401 to start their OAuth flow (same gate as /api/mcp).
	const body = await readJson(req, 1_000_000);
	const { toolName } = peekCalledTool(body);

	const result = await authenticateRequest(req, res, {
		allowFree:
			Boolean(toolName && isPublicTool(toolName)) ||
			(isDiscoveryOnlyBatch(body) && !isMcpProtocolClient(req)),
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
	// can't re-run the priced tools before the first settle lands. Released in the
	// finally; the consumed on-chain nonce blocks any replay thereafter. Fails
	// open — see reservePaymentProof.
	let releaseProof = async () => {};
	if (x402Ctx) {
		const guard = await reservePaymentProof(
			'/api/mcp-bazaar',
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

		// When the caller presented an x402 payment, settle it AFTER the work
		// succeeded — same atomic verify → work → settle sequence as /api/mcp. The
		// advertised 402 price is only ever charged once useful work was delivered;
		// a wholesale failure leaves the payer's signed payload un-broadcast.
		if (x402Ctx) {
			const anySuccess = responses.some(
				(r) => r && !r.error && !(r.result && r.result.isError),
			);
			if (anySuccess) {
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
		}

		res.statusCode = 200;
		res.setHeader('content-type', 'application/json; charset=utf-8');
		res.setHeader('mcp-protocol-version', PROTOCOL_VERSION);
		res.end(JSON.stringify(Array.isArray(body) ? responses : (responses[0] ?? null)));
	} finally {
		await releaseProof();
	}
});
