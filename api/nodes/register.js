// POST /api/nodes/register: register an inference node (phase 4 open network).
//
// The operator client (packages/node-operator) calls this once at boot. The
// node's Solana ed25519 public key IS its identity: registration is an
// idempotent upsert on that key, authenticated by an ed25519 signature over
// the domain-separated string `threews-node-register:{publicKey}:{registeredAt}`.
// Nobody else can register or re-register a key they cannot sign for.
//
// Body: { publicKey, label?, capabilities: [{capability, model}], registeredAt, signature }
// 200:  { ok: true, node: { id, publicKey, capabilities } }
// 400:  malformed body  ·  401: bad signature  ·  429: rate limited

import { cors, error, json, method, readJson, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { registerNode, verifyNodeSignature } from '../_lib/inference-nodes.js';

const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export default wrap(async (req, res) => {
	cors(req, res);
	if (!method(req, res, ['POST'])) return;
	const rl = await limits.nodeRegisterIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	let body;
	try {
		body = await readJson(req, 32_000);
	} catch {
		return error(res, 400, 'invalid_json', 'request body must be JSON');
	}

	const { publicKey, label, capabilities, registeredAt, signature } = body || {};
	if (typeof publicKey !== 'string' || publicKey.length < 32 || publicKey.length > 44) {
		return error(res, 400, 'invalid_public_key', 'publicKey must be a base58 ed25519 key');
	}
	if (!Array.isArray(capabilities) || capabilities.length === 0) {
		return error(res, 400, 'invalid_capabilities', 'capabilities must be a non-empty array');
	}
	if (typeof registeredAt !== 'number' || Math.abs(Date.now() - registeredAt) > MAX_CLOCK_SKEW_MS) {
		return error(res, 400, 'stale_registration', 'registeredAt is missing or too far from server time');
	}
	if (typeof signature !== 'string' || !verifyNodeSignature(publicKey, `threews-node-register:${publicKey}:${registeredAt}`, signature)) {
		return error(res, 401, 'bad_signature', 'registration signature does not verify against publicKey');
	}

	const node = await registerNode({ publicKey, label, capabilities });
	return json(res, 200, {
		ok: true,
		node: {
			id: node.public_key,
			publicKey: node.public_key,
			label: node.label,
			capabilities: node.capabilities,
		},
	});
});
