import { sql } from '../../../_lib/db.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../../../_lib/auth.js';
import { cors, method, wrap, error, rateLimited } from '../../../_lib/http.js';
import { limits, clientIp } from '../../../_lib/rate-limit.js';

const IPFS_GATEWAYS = [
	'https://dweb.link/ipfs/',
	'https://flk-ipfs.xyz/ipfs/',
	'https://ipfs.io/ipfs/',
];

const CID_RE = /^[a-zA-Z0-9]+$/;

// Mirror pin.js's per-file ceiling. A pinned memory file is capped at 512 KB on
// write, so a gateway response larger than that is not one of our files — bound
// it to avoid streaming an arbitrary-size body back through the proxy.
const MAX_BYTES = 512 * 1024;

async function fetchFromIPFS(cid) {
	let lastErr;
	for (const gw of IPFS_GATEWAYS) {
		try {
			const resp = await fetch(gw + cid);
			if (resp.ok) return resp;
		} catch (err) {
			lastErr = err;
		}
	}
	throw lastErr || new Error('All IPFS gateways failed for ' + cid);
}

// GET /api/agents/:id/memory/:cid
// Returns the raw encrypted bytes for a pinned memory file.
// Requires agent ownership to prevent CID enumeration.
export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const url = new URL(req.url, 'http://x');
	const parts = url.pathname.split('/').filter(Boolean);
	const agentId = parts[2];
	const cid = parts[4];

	if (!cid || !CID_RE.test(cid)) {
		return error(res, 400, 'validation_error', 'invalid or missing CID');
	}

	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	const userId = session?.id ?? bearer?.userId;
	if (!userId) return error(res, 401, 'unauthorized', 'sign in required');

	const [agent] =
		await sql`SELECT id FROM agent_identities WHERE id = ${agentId} AND user_id = ${userId} AND deleted_at IS NULL`;
	if (!agent) return error(res, 404, 'not_found', 'agent not found');

	const rl = await limits.authedReadIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	// Bind the CID to this agent's own pinned set. Owning the agent is not enough
	// — without this the route is a generic authenticated IPFS fetch proxy for any
	// CID, defeating the "prevent enumeration" intent in the comment above.
	const [pin] =
		await sql`SELECT cid FROM agent_memory_pins WHERE agent_id = ${agentId} AND cid = ${cid} LIMIT 1`;
	if (!pin) return error(res, 404, 'not_found', 'memory file not found for this agent');

	const ipfsResp = await fetchFromIPFS(cid);

	// Bound the proxied body. Trust the gateway's Content-Length when present, then
	// re-check the materialized buffer (a lying header can't exceed the real cap).
	const declared = Number(ipfsResp.headers.get('content-length') || 0);
	if (declared > MAX_BYTES) {
		return error(res, 413, 'payload_too_large', 'memory file exceeds size limit');
	}
	const buf = Buffer.from(await ipfsResp.arrayBuffer());
	if (buf.byteLength > MAX_BYTES) {
		return error(res, 413, 'payload_too_large', 'memory file exceeds size limit');
	}

	res.statusCode = 200;
	res.setHeader('Content-Type', 'application/octet-stream');
	res.setHeader('Content-Length', buf.byteLength);
	res.setHeader('Cache-Control', 'private, max-age=86400');
	res.end(buf);
});
