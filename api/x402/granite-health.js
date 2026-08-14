// GET /api/x402/granite-health — IBM Granite watsonx backend SLA dashboard feed.
//
// Free operational read (parity with /api/x402/mcp-perf): surfaces the live
// health of the hosted IBM Granite MCP inference backend as measured by the
// `granite-inference-health` autonomous-loop entry (api/_lib/x402/autonomous-registry.js).
// That loop pays a real x402 batch call to /api/ibm-mcp every 6 hours, invoking
// all five paid Granite tools, and writes a verdict row (per-tool schema
// conformance + token throughput) to granite_inference_health. This endpoint is
// the downstream consumer: it reports the latest snapshot plus a rolling
// throughput / uptime rollup.
//
// Query: ?window=<hours> (default 24, max 168) — the rolling window to report.

import { cors, json, method, wrap } from '../_lib/http.js';
import { readGraniteHealth } from '../_lib/x402/granite-health.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	let windowHours = 24;
	try {
		const u = new URL(req.url, 'http://localhost');
		const w = Number(u.searchParams.get('window'));
		if (Number.isFinite(w) && w > 0) windowHours = Math.min(Math.max(w, 1), 168);
	} catch { /* default window */ }

	try {
		const health = await readGraniteHealth({ windowHours });
		// 200 always — the dashboard renders the degraded state itself; a non-2xx
		// here would be indistinguishable from this endpoint being down.
		return json(res, 200, { ...health, generated_at: new Date().toISOString() });
	} catch (err) {
		// Table absent (loop never ran) means the backend simply has no verdict yet:
		// report empty-but-healthy so the dashboard shows "no data yet" instead of
		// an error void, matching readGraniteHealth's own no-row default. A real DB
		// failure is different and must not claim healthy:true, or a dashboard reads
		// green through an outage it cannot see.
		const noData = /does not exist/i.test(err?.message || '');
		return json(res, noData ? 200 : 503, {
			ok: noData,
			server: 'ibm-x402-mcp',
			healthy: noData,
			latest: null,
			window: { checks: 0, total_tokens: 0 },
			generated_at: new Date().toISOString(),
			...(noData ? {} : { error: 'granite_health_read_failed' }),
		});
	}
});
