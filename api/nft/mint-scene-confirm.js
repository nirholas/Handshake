import { env } from '../_lib/env.js';
import { wrap, cors, error, json, readJson, method, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { solanaConnection } from '../_lib/solana/connection.js';
import { confirmOrThrow } from '../_lib/solana/confirm.js';

// Base64 with no stray characters. Buffer.from(x, 'base64') never throws: it
// drops anything outside the alphabet, so the only way to reject a malformed
// payload up front is to check it before decoding.
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export default wrap(async (req, res) => {
	// Mirrors /api/nft/mint-scene: the chat client posts here with
	// credentials:'include', so the preflight has to allow credentials or a
	// cross-origin embed loses the session cookie on the second leg of the flow.
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	// This broadcasts through the platform's own paid Solana RPC. /api/nft/mint-scene
	// already gates the first leg on a session or bearer token, so requiring the
	// same here costs a legitimate minter nothing and stops the endpoint doubling
	// as an open relay for arbitrary signed transactions.
	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	if (!session && !bearer) {
		return error(res, 401, 'unauthorized', 'sign in or provide a valid bearer token');
	}

	const body = await readJson(req);
	const { signedTxBase64 } = body || {};

	if (!signedTxBase64 || typeof signedTxBase64 !== 'string')
		return error(res, 400, 'validation_error', 'signedTxBase64 required');

	const compact = signedTxBase64.replace(/\s+/g, '');
	if (!compact || compact.length % 4 !== 0 || !BASE64_RE.test(compact))
		return error(res, 400, 'validation_error', 'signedTxBase64 is not valid base64');
	const txBytes = Buffer.from(compact, 'base64');

	const rpcUrl = env.SOLANA_RPC_URL;
	const connection = solanaConnection({ url: rpcUrl, commitment: 'confirmed' });

	let signature;
	try {
		signature = await connection.sendRawTransaction(txBytes, {
			skipPreflight: false,
			maxRetries: 3,
		});
	} catch (e) {
		return error(res, 422, 'tx_rejected', `Transaction rejected: ${e.message}`);
	}

	try {
		const latestBlockhash = await connection.getLatestBlockhash('confirmed');
		await confirmOrThrow(
			connection,
			{ signature, ...latestBlockhash },
			'confirmed',
		);
	} catch (e) {
		// A confirmed-but-reverted tx is a hard failure, not an uncertain one, never
		// hand back a soft 200 that reads as success.
		if (e?.code === 'tx_reverted') {
			return error(res, 422, 'tx_failed', `Mint transaction reverted on-chain: ${JSON.stringify(e.onChainErr)}`);
		}
		// Return the signature even if confirmation polling times out, the tx may still land.
		return json(res, 200, { signature, warning: `Confirmation uncertain: ${e.message}` });
	}

	return json(res, 200, { signature });
});
