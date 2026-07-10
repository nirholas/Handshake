// POST /api/play/refresh  { playPass }
//
// Silent mid-session renewal of a wallet's /play credential. The wallet proved
// ownership once at POST /api/play/verify (ed25519 signature over a server
// nonce); possession of the resulting unexpired, HMAC-signed pass is itself proof
// that the same wallet was verified minutes ago, so renewing it needs no new
// signature — only a fresh on-chain balance read to confirm the wallet still
// clears the floor. This is what keeps a player in a long building session from
// being re-prompted to sign in every ~8 minutes.
//
// Responses (200 unless the request itself is malformed):
//   { ok: true,  wallet, balance, mint, symbol, decimals, playPass, expiresAt }
//   { ok: false, reason: 'balance_too_low', wallet, balance, mint, symbol,
//     minBalance, acquireUrl }
// Hard errors the client routes on:
//   400 gate_disabled   — no game token pinned (client shouldn't have called us)
//   401 pass_invalid    — missing/expired/forged pass → fall back to a full sign-in
//   502 balance_unavailable — RPC/price feed down
import { z } from 'zod';
import { cors, error, json, method, readJson, wrap, rateLimited } from '../_lib/http.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { getBalances } from '../_lib/balances.js';
import { verifyPlayPass, signPlayPass, PLAY_GATE_MINT, PLAY_GATE_MIN } from '../_lib/play-pass.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

const schema = z.object({
	playPass: z.string().trim().min(16).max(4096),
});

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;
	res.setHeader('cache-control', 'no-store');

	const rl = await limits.authedReadIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	if (!PLAY_GATE_MINT) {
		return error(res, 400, 'gate_disabled', 'the token gate is not active');
	}

	const parsed = schema.safeParse(await readJson(req).catch(() => null));
	if (!parsed.success) return error(res, 400, 'validation_error', 'playPass is required');

	// 1) The pass must still be a valid, unexpired credential we issued for this
	//    gate's token. An expired or forged pass can't be renewed silently — the
	//    client falls back to a fresh signed sign-in.
	const pass = verifyPlayPass(parsed.data.playPass);
	if (!pass || pass.mint !== PLAY_GATE_MINT) {
		return error(res, 401, 'pass_invalid', 'sign-in expired — please sign in again');
	}
	const address = pass.wallet;

	// 2) Re-read the proven wallet's on-chain balance so a wallet that offloaded
	//    its tokens is refused here rather than riding a renewed pass.
	let balances;
	try {
		balances = await getBalances({ chain: 'solana', address });
	} catch (err) {
		const status = err?.status === 503 ? 503 : 502;
		return error(res, status, 'balance_unavailable', err?.message || 'could not read on-chain balance');
	}

	const holding =
		PLAY_GATE_MINT === SOL_MINT
			? balances?.native
			: (balances?.tokens ?? []).find((t) => t.mint === PLAY_GATE_MINT);
	const balance = Math.round((holding?.amount || 0) * 1e6) / 1e6;
	const symbol = holding?.symbol || (PLAY_GATE_MINT === SOL_MINT ? 'SOL' : '$THREE');
	const decimals = holding?.decimals ?? null;
	const minBalance = PLAY_GATE_MIN;

	// 3) Gate on the floor, exactly as /verify does — a wallet still over it gets a
	//    fresh pass; one that dropped below gets an honest, actionable refusal.
	if (balance >= minBalance) {
		const playPass = signPlayPass({ wallet: address, mint: PLAY_GATE_MINT, balance });
		return json(res, 200, {
			data: { ok: true, wallet: address, balance, mint: PLAY_GATE_MINT, symbol, decimals, playPass, expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString() },
		});
	}

	const acquireUrl = PLAY_GATE_MINT === SOL_MINT
		? 'https://jup.ag/onramp'
		: `https://jup.ag/swap/SOL-${PLAY_GATE_MINT}`;

	return json(res, 200, {
		data: { ok: false, reason: 'balance_too_low', wallet: address, balance, mint: PLAY_GATE_MINT, symbol, minBalance, acquireUrl },
	});
});
