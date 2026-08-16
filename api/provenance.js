/**
 * Free public 3D provenance verification — GET /api/provenance
 * ------------------------------------------------------------
 * GET /api/provenance?src=<glbUrl>   (or ?hash=<sha256>)
 *
 * Recomputes the model's content hash, looks up its signed credential, checks the
 * signature and any on-chain anchor, and returns:
 *
 *   { status: "verified" | "tampered" | "unknown", reason, badge, glbSha256,
 *     credential?, issuer?, anchor? }
 *
 * No account, no payment, no coin surface — the same verdict the verify_provenance
 * MCP tool returns, over plain HTTP, so the viewer badge and any client can check
 * authenticity for free. Anchoring (the paid write) lives in the MCP tool only.
 */

import { cors, method, wrap } from './_lib/http.js';
import { toolDefs } from './_mcp3d/tools/provenance.js';

const verifyTool = toolDefs.find((d) => d.name === 'verify_provenance');

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	// Verification is a read. The CORS preflight already advertises GET only;
	// enforce it so a POST cannot drive a hash fetch off a body-less request.
	if (!method(req, res, ['GET'])) return;

	const url = new URL(req.url, 'http://x');
	const src = url.searchParams.get('src') || url.searchParams.get('glb_url') || '';
	const hash = url.searchParams.get('hash') || '';

	const result = await verifyTool.handler({ glb_url: src || undefined, hash: hash || undefined });
	const sc = result.structuredContent || {};

	if (sc.error) {
		res.statusCode = 400;
		res.setHeader('content-type', 'application/json; charset=utf-8');
		res.setHeader('cache-control', 'no-store');
		res.end(JSON.stringify({ error: sc.message || 'invalid request' }));
		return;
	}

	res.statusCode = 200;
	res.setHeader('content-type', 'application/json; charset=utf-8');
	// A verdict is cheap to recompute and can change when a credential is anchored,
	// so cache briefly at the edge only.
	res.setHeader('cache-control', 'public, max-age=30, s-maxage=120');
	res.end(JSON.stringify(sc));
});
