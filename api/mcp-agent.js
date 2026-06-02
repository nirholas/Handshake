// three.ws Agent — MCP server (Streamable HTTP transport, MCP 2025-06-18).
// "Add a wallet to Claude": discover, pay for, and call x402 services in USDC
// from the signed-in user's own three.ws agent wallet, bounded by spend caps.
// POST /api/mcp-agent — tool calls   GET — SSE   DELETE — terminate.
// Registered with the MCP Registry as io.github.nirholas/threews-agent.
import { cors, readJson, wrap } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { PROTOCOL_VERSION, dispatch } from './_mcpagent/dispatch.js';
import { send401, sendJsonRpcError, authenticateRequest, handleSse, handleTerminate } from './_mcp/auth.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,HEAD,POST,DELETE,OPTIONS', origins: '*' })) return;

	if (req.method === 'GET' || req.method === 'HEAD') return handleSse(req, res);
	if (req.method === 'DELETE') return handleTerminate(req, res);
	if (req.method !== 'POST') return send401(res, 'method not supported');

	const result = await authenticateRequest(req, res);
	if (!result) return;
	const { auth } = result;

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

	const body = await readJson(req, 1_000_000);
	const batch = Array.isArray(body) ? body : [body];
	if (batch.length > 16) return sendJsonRpcError(res, null, -32600, 'batch too large (max 16)');

	const responses = [];
	for (const msg of batch) {
		const r = await dispatch(msg, auth, req);
		if (r !== null) responses.push(r);
	}

	res.statusCode = 200;
	res.setHeader('content-type', 'application/json; charset=utf-8');
	res.setHeader('mcp-protocol-version', PROTOCOL_VERSION);
	res.end(JSON.stringify(Array.isArray(body) ? responses : (responses[0] ?? null)));
});
