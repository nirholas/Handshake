// /api/cosmetics/split — per-coin cosmetic revenue-split config (R25).
//
//   GET  ?mint=<mint>   → the coin's effective split config (creator wallet +
//                         share). Public: the share that applies to a sale is not
//                         a secret, and the shop shows it on the buy button.
//   POST { mint, bps, ts, signature, signer }
//                       → set the coin's creator share. Authorized by an ed25519
//                         signature from the coin's creator wallet over
//                         splitConfigMessage() (verified server-side). Clamped to
//                         the platform ceiling. Returns the new effective config.
//
// The creator never sets where the money goes — the creator wallet is resolved
// from launch records / on-chain — only HOW MUCH of each sale they take, up to the
// cap. So a config write can't redirect another coin's revenue.

import { cors, json, method, wrap, error, readJson, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { getSplitConfig, setSplitConfig, splitConfigMessage, isMint, MAX_CREATOR_BPS } from '../_lib/cosmetics-economy.js';

export default wrap(async (req, res) => {
	// Public origins: a config read is public, and a write is authorized by an
	// ed25519 signature in the body, never by a cookie — so no credentialed CORS.
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', origins: '*' })) return;

	if (req.method === 'GET') {
		if (!method(req, res, ['GET'])) return;
		const rl = await limits.publicIp(clientIp(req));
		if (!rl.success) return rateLimited(res, rl);

		const url = new URL(req.url, 'http://x');
		const mint = String(url.searchParams.get('mint') || '').trim();
		if (!isMint(mint)) return error(res, 400, 'bad_mint', 'query parameter "mint" must be a coin mint');
		let config;
		try {
			config = await getSplitConfig(mint);
		} catch (err) {
			console.warn('[cosmetics/split] config read failed:', err?.message);
			// Fail open to the platform default so the shop can still price the sale.
			config = { mint, creatorWallet: null, splitBps: 0, source: 'none', isDefault: true, updatedAt: null, maxBps: MAX_CREATOR_BPS };
		}
		// The message the creator must sign to change it — handed to the client so it
		// can build the exact signing payload without guessing the format.
		const ts = Math.floor(Date.now() / 1000);
		return json(res, 200, {
			...config,
			signTemplate: { ts, message: splitConfigMessage({ mint, bps: config.splitBps, ts }) },
		}, { 'cache-control': 'no-store' });
	}

	if (!method(req, res, ['POST'])) return;
	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl, 'too many requests — slow down');

	let body;
	try {
		body = await readJson(req);
	} catch (err) {
		// readJson rejects a non-JSON content-type with 415 and unparseable bytes
		// with 400. Collapsing both to "invalid request body" told a client that
		// sent perfectly good JSON under the wrong header to go fix its payload.
		const status = err?.status === 415 ? 415 : 400;
		const code = status === 415 ? 'unsupported_media_type' : 'bad_json';
		return error(res, status, code, err?.message || 'invalid request body');
	}

	try {
		const config = await setSplitConfig({
			mint: String(body?.mint || ''),
			bps: body?.bps,
			ts: body?.ts,
			signature: String(body?.signature || ''),
			signer: String(body?.signer || ''),
		});
		return json(res, 200, config, { 'cache-control': 'no-store' });
	} catch (err) {
		if (err && err.expose && err.status) return error(res, err.status, err.code || 'error', err.message);
		console.error('[cosmetics/split] set failed:', err);
		return error(res, 500, 'internal', 'something went wrong');
	}
});
