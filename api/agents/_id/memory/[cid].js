import { sql } from '../../../_lib/db.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../../../_lib/auth.js';
import { cors, method, wrap, error } from '../../../_lib/http.js';
import { limits, clientIp } from '../../../_lib/rate-limit.js';

const IPFS_GATEWAYS = [
	'https://dweb.link/ipfs/',
	'https://flk-ipfs.xyz/ipfs/',
	'https://ipfs.io/ipfs/',
];

const CID_RE = /^[a-zA-Z0-9]+$/;

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

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const ipfsResp = await fetchFromIPFS(cid);
	const buf = Buffer.from(await ipfsResp.arrayBuffer());

	res.statusCode = 200;
	res.setHeader('Content-Type', 'application/octet-stream');
	res.setHeader('Content-Length', buf.byteLength);
	res.setHeader('Cache-Control', 'private, max-age=86400');
	res.end(buf);
});
