/**
 * GET /api/v1/agents/:caip
 *
 * Public, gateway-cached resolver for an ERC-8004 / three.ws Card v1 agent.
 * Consumers (badge web component, indexers, third-party sites) call this so
 * they don't have to do RPC + IPFS + sha256 verification themselves.
 *
 * The :caip parameter is a CAIP-style ref:
 *   eip155:<chainId>:<registryAddress>/<tokenId>
 *
 * Pass the ref with its `/` as a REAL path separator, which is why this is a
 * catch-all route:
 *
 *   GET /api/v1/agents/eip155:8453:0x8004A169.../1
 *
 * Percent-encoding the colons is fine (`eip155%3A8453%3A0x8004A169.../1`) -
 * the router decodes each segment. Percent-encoding the SLASH is not: the API
 * dispatcher rejects any segment that decodes to contain "/" or "\", because
 * that is exactly how "%2f..%2f..%2fvite.config" would smuggle a traversal past
 * the segment split (server/route-resolve.mjs `apiSegments`). A `%2F` ref
 * therefore 404s before reaching this file, by design.
 *
 * Response (200):
 *   {
 *     ref:         "eip155:8453:0x...",
 *     chainId, agentId, registry, owner, tokenURI,
 *     card:        {...},        // the resolved agent card JSON
 *     verified: {
 *       modelSha256: true|false|null,   // null when card has no model.sha256
 *       cardSchema:  "registration-v1" | "3d-agent-card-v1" | "unknown"
 *     },
 *     fetchedAt:   "2026-04-27T12:00:00Z"
 *   }
 *
 * Errors: 400 invalid_caip, 404 not_found, 502 upstream, 429 rate_limited.
 */

import { wrap, cors, method, json, error, rateLimited } from '../../_lib/http.js';
import { limits, clientIp } from '../../_lib/rate-limit.js';
import { resolveOnChainAgent, resolveURI } from '../../_lib/onchain.js';
import { fetchSafePublicUrl } from '../../_lib/ssrf-guard.js';

const CAIP_RE = /^eip155:(\d+):(0x[a-fA-F0-9]{40})\/(\d+)$/;

// Rebuild the ref from the catch-all param. Runtimes differ on the shape they
// hand back (this server joins the decoded segments into a string; Vercel-style
// catch-alls hand back the array), so accept both, and fall back to the path
// for any runtime that populates neither.
function caipFromReq(req) {
	const fromQuery = req.query?.caip;
	if (Array.isArray(fromQuery)) return fromQuery.filter(Boolean).join('/');
	if (typeof fromQuery === 'string' && fromQuery) return fromQuery;
	const { pathname } = new URL(req.url, 'http://internal');
	const m = pathname.match(/\/api\/v1\/agents\/(.+)$/);
	if (!m) return '';
	try {
		return m[1].split('/').map(decodeURIComponent).join('/');
	} catch {
		return '';
	}
}
const CACHE_HEADERS = {
	// 5 min fresh, 1 h stale-while-revalidate at the edge.
	'cache-control': 'public, s-maxage=300, stale-while-revalidate=3600',
};

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.mcpIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	// The dispatcher already percent-decoded each path segment; decoding again
	// here would corrupt any ref carrying a literal "%".
	const raw = caipFromReq(req);
	const m = CAIP_RE.exec(raw);
	if (!m) {
		return error(res, 400, 'invalid_caip', 'expected eip155:<chainId>:<registry>/<tokenId>');
	}
	const chainId = Number(m[1]);
	const registry = m[2];
	const agentId = m[3];

	const result = await resolveOnChainAgent({ chainId, agentId, fetchManifest: true });

	if (result.error === 'unsupported_chain') {
		return error(res, 400, 'unsupported_chain', `chain ${chainId} not in registry table`);
	}
	if (result.error?.startsWith('chain_read')) {
		return error(res, 404, 'not_found', `agent ${agentId} not found on chain ${chainId}`);
	}
	if (result.registry?.toLowerCase() !== registry.toLowerCase()) {
		return error(
			res,
			400,
			'registry_mismatch',
			'CAIP registry differs from canonical deployment',
		);
	}

	const card = result.manifest || null;
	const verified = await verifyCard(card);

	return json(
		res,
		200,
		{
			ref: `eip155:${chainId}:${result.registry}/${agentId}`,
			chainId,
			agentId,
			registry: result.registry,
			owner: result.owner,
			tokenURI: result.tokenURI,
			card,
			verified,
			fetchedAt: new Date().toISOString(),
		},
		CACHE_HEADERS,
	);
});

async function verifyCard(card) {
	const out = { modelSha256: null, cardSchema: 'unknown' };
	if (!card || typeof card !== 'object') return out;

	const types = Array.isArray(card.type) ? card.type : card.type ? [card.type] : [];
	if (types.includes('https://three.ws/specs/3d-agent-card-v1')) {
		out.cardSchema = '3d-agent-card-v1';
	} else if (types.includes('https://eips.ethereum.org/EIPS/eip-8004#registration-v1')) {
		out.cardSchema = 'registration-v1';
	}

	const expected = card?.model?.sha256;
	const uri = card?.model?.uri;
	if (expected && uri) {
		try {
			const httpUrl = resolveURI(uri);
			// model.uri comes from the attacker-authored card manifest; guard it so a
			// crafted internal URL can't be probed via the sha256-match boolean.
			const r = await fetchSafePublicUrl(httpUrl, { signal: AbortSignal.timeout(5000) }, { allowHttp: true });
			if (r.ok) {
				const buf = new Uint8Array(await r.arrayBuffer());
				const hash = await sha256Hex(buf);
				out.modelSha256 = hash.toLowerCase() === String(expected).toLowerCase();
			} else {
				out.modelSha256 = false;
			}
		} catch {
			out.modelSha256 = false;
		}
	}
	return out;
}

async function sha256Hex(bytes) {
	const buf = await crypto.subtle.digest('SHA-256', bytes);
	return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
