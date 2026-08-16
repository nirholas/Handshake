import { X402Error, send402 } from '../_lib/x402-spec.js';
import { reportServerError } from '../_lib/http.js';

// Always-on replay guard for the raw-verify MCP paid path. Defined in the
// canonical idempotency module so every hand-rolled x402 endpoint shares one
// implementation; re-exported here because the MCP servers already import from
// this module. See payment-identifier-server.js for the full rationale.
export { reservePaymentProof } from '../_lib/x402/payment-identifier-server.js';

// `challenge` (optional) is the endpoint's own service metadata, the same object
// it hands authenticateRequest/handleSse. It MUST be threaded through here too:
// a payment that fails verification or settlement re-issues the 402, and without
// it that retry envelope described the main /api/mcp server to a payer who
// called a dedicated endpoint (the Bazaar, the 3D studio, Granite). Confirmed
// live on 2026-08-16: /api/mcp-bazaar answered a bad payment with the main
// server's description and no serviceName/tags/iconUrl.
export async function sendX402Error(res, { resourceUrl, accepts, challenge }, err) {
	if (err instanceof X402Error) {
		if (err.status === 402)
			return await send402(res, { resourceUrl, accepts, ...(challenge || {}), error: err.message });
		res.statusCode = err.status;
		res.setHeader('content-type', 'application/json; charset=utf-8');
		res.end(JSON.stringify({ error: err.code, error_description: err.message }));
		return;
	}
	// Unexpected (non-X402) fault: route it through the shared boundary so the
	// MCP payment path gets the same ref + Sentry capture + deduped ops alert as
	// an HTTP 5xx, then echo the ref so an agent can quote it to support.
	const ref = reportServerError(err, { code: 'mcp_x402_failed', context: { resourceUrl } });
	res.statusCode = 500;
	res.setHeader('content-type', 'application/json; charset=utf-8');
	res.end(
		JSON.stringify({
			error: 'internal',
			error_description: `x402 processing failed, quote ref ${ref} to support`,
			ref,
		}),
	);
}
