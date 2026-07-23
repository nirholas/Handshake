// IBM Granite x402 MCP server — Streamable HTTP transport (MCP 2025-06-18,
// JSON-RPC 2.0). POST /api/ibm-mcp — tool calls   GET — SSE   DELETE — terminate.
//
// The hosted (remote) transport for the @three-ws/ibm-x402-mcp tool suite: five
// IBM Granite tools (chat, code, embed, analyze, forecast) gated by per-call
// x402 payments, plus a free ibm_granite_getting_started tool served without any
// payment or token so any client can discover the server first. End users pay
// USDC on Base or Solana per paid call — no IBM Cloud account required; the
// operator funds watsonx.ai via WATSONX_* env vars.
// Authenticated three.ws principals (Bearer / OAuth) call without per-call
// payment — the operator-funded path for watsonx Orchestrate connections.
// Registered with the MCP Registry as io.github.nirholas/ibm-x402-mcp-remote
// (see server-ibm.json).
import { cors, readJson, wrap } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { settlePayment, encodePaymentResponseHeader } from './_lib/x402-spec.js';
import { priceBatch, isDiscoveryOnlyBatch } from './_lib/mcp-batch-price.js';
import { PROTOCOL_VERSION, dispatch } from './_mcpibm/dispatch.js';
import { graniteX402Amount } from './_mcpibm/pricing.js';
import { isFreeTool } from './_mcpibm/catalog.js';
import { GRANITE_CHALLENGE } from './_mcpibm/discovery.js';
import {
	send401,
	sendJsonRpcError,
	authenticateRequest,
	handleSse,
	handleTerminate,
	isMcpProtocolClient,
} from './_mcp/auth.js';
import { sendX402Error, reservePaymentProof } from './_mcp/payments.js';

const RESOURCE_PATH = '/api/ibm-mcp';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,HEAD,POST,DELETE,OPTIONS', origins: '*' })) return;

	if (req.method === 'GET' || req.method === 'HEAD')
		return handleSse(req, res, { resourcePath: RESOURCE_PATH, challenge: GRANITE_CHALLENGE });
	if (req.method === 'DELETE') return handleTerminate(req, res);
	if (req.method !== 'POST') return send401(res, 'method not supported');

	// Read + parse the body BEFORE the x402 challenge so the 402 is priced by the
	// tool actually being called. Malformed JSON throws (status 400) → wrap().
	const body = await readJson(req, 2_000_000);

	// x402 price for the WHOLE request — the sum of every priced Granite
	// tools/call in the (possibly batched) body. Charging the per-request total
	// (not just a lone call) stops a multi-call batch from running several billed
	// inferences for one tool's price. A discovery-only batch yields null.
	const { totalAmount: x402Amount, allFree } = priceBatch(body, {
		priceForTool: graniteX402Amount,
		isFreeName: isFreeTool,
	});

	// A batch composed solely of the free public ibm_granite_getting_started tool
	// is served without an x402 payment or OAuth token so any client — including
	// non-x402 hosts like watsonx Orchestrate — can discover the server first.
	// Discovery-only batches (initialize / tools/list / ping) from plain x402
	// agents and crawlers are also free; MCP protocol clients still get the
	// 401 that starts their OAuth flow.
	const result = await authenticateRequest(req, res, {
		x402Amount,
		resourcePath: RESOURCE_PATH,
		challenge: GRANITE_CHALLENGE,
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
	// Per-request batch cap — each message can trigger an IBM inference call, so
	// an unbounded batch multiplies billable work against the user's budget.
	if (batch.length > 16) return sendJsonRpcError(res, null, -32600, 'batch too large (max 16)');

	// Replay guard (parity with paidEndpoint): hold a single-use lock on the
	// signed payment proof across dispatch+settle so a captured/retried X-PAYMENT
	// can't re-run the priced (billable IBM inference) tools before the first
	// settle lands. Released in the finally; the consumed on-chain nonce blocks any
	// replay thereafter. Fails open — see reservePaymentProof.
	let releaseProof = async () => {};
	if (x402Ctx) {
		const guard = await reservePaymentProof(
			RESOURCE_PATH,
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
		// and they get an error instead of having paid for nothing. Only settle when
		// at least one call produced a result; a wholesale failure (every call errored
		// or returned isError) charges nothing. A partial failure still settles in
		// full so a single failing call can't reclaim the calls that succeeded.
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
