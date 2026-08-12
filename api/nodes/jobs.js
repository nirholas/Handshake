// GET /api/nodes/jobs: an inference node claims its next job (phase 4).
//
// The operator client's poll loop hits this endpoint. Auth is a signed
// timestamp (`sig` = ed25519 over `threews-node-poll:{node}:{ts}`), so only
// the holder of a registered node's secret key can drain its queue, and the
// signature expires after five minutes to kill replay.
//
// Query: node=<base58 pubkey>&capability=<cap>&ts=<ms>&sig=<base64>
// 200:   { job: null }                                    queue empty
// 200:   { job: { id, capability, model, input, deadlineAt } }
// 401:   bad signature  ·  404: node not registered  ·  429: rate limited

import { cors, error, json, method, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { claimJob, getNode, verifyNodeSignature } from '../_lib/inference-nodes.js';

const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export default wrap(async (req, res) => {
	cors(req, res);
	if (!method(req, res, ['GET'])) return;
	if (await rateLimited(res, limits.lenient(clientIp(req)))) return;

	const url = new URL(req.url, 'http://localhost');
	const node = url.searchParams.get('node');
	const capability = url.searchParams.get('capability');
	const ts = Number(url.searchParams.get('ts'));
	const sig = url.searchParams.get('sig');

	if (!node || !capability || !ts || !sig) {
		return error(res, 400, 'missing_params', 'node, capability, ts and sig are required');
	}
	if (Math.abs(Date.now() - ts) > MAX_CLOCK_SKEW_MS) {
		return error(res, 401, 'stale_signature', 'ts is too far from server time');
	}
	if (!verifyNodeSignature(node, `threews-node-poll:${node}:${ts}`, sig)) {
		return error(res, 401, 'bad_signature', 'poll signature does not verify against node');
	}
	const registered = await getNode(node);
	if (!registered) {
		return error(res, 404, 'node_not_registered', 'register via POST /api/nodes/register first');
	}

	const job = await claimJob({ capability, publicKey: node });
	return json(res, 200, { job: job || null });
});
