/**
 * Independent verification of one Trader Passport credential.
 *
 *   GET /api/trader-passport/verify?signature=<sig>&network=mainnet
 *       [&wallet=<expected subject>] [&attester=<expected issuer>]
 *
 * Reads the attestation transaction straight from a Solana RPC node, re-parses the
 * SPL-Memo payload, and re-checks the signer, the subject, and the schema. It
 * touches no three.ws database, so the answer holds even if you distrust the rest
 * of this API: and the same check is reproducible against any RPC you choose.
 *
 * `valid: false` always comes with `reasons[]` naming every failed check.
 *
 * Public, IP rate-limited, CORS-open, long CDN cache: a confirmed transaction is
 * immutable, so a verdict for a given signature never changes.
 */

import { cors, json, method, wrap, error, rateLimited } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import {
	PASSPORT_NETWORKS, SIGNATURE_RE, WALLET_RE, TRADESCORE_KIND, MEMO_PROGRAM_ID_BASE58,
	verifyOnChain, PassportError,
} from './_lib/trader-passport.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const p = new URL(req.url, `http://${req.headers.host || 'x'}`).searchParams;
	const signature = (p.get('signature') || p.get('sig') || '').trim();
	const network = PASSPORT_NETWORKS.has(p.get('network')) ? p.get('network') : 'mainnet';
	const expectSubject = (p.get('wallet') || '').trim() || null;
	const expectAttester = (p.get('attester') || '').trim() || null;

	if (!SIGNATURE_RE.test(signature)) {
		return error(res, 400, 'invalid_signature', 'Pass signature=<base-58 Solana transaction signature>.');
	}
	if (expectSubject && !WALLET_RE.test(expectSubject)) {
		return error(res, 400, 'invalid_wallet', 'wallet must be a Solana base-58 address.');
	}
	if (expectAttester && !WALLET_RE.test(expectAttester)) {
		return error(res, 400, 'invalid_attester', 'attester must be a Solana base-58 address.');
	}

	let result;
	try {
		result = await verifyOnChain({ signature, network, expectSubject, expectAttester });
	} catch (err) {
		if (err instanceof PassportError) return error(res, err.status, err.code, err.message);
		throw err;
	}

	// A not-found transaction is a real answer about a real signature, but it is the
	// one verdict that can change later (a node may still be catching up), so it is
	// never cached at the edge.
	const cache = result.found
		? { 'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400' }
		: { 'Cache-Control': 'no-store' };

	return json(res, 200, {
		...result,
		kind: TRADESCORE_KIND,
		memo_program: MEMO_PROGRAM_ID_BASE58,
		checked_at: new Date().toISOString(),
	}, cache);
});
