// POST /api/play/verify  { address, signature, nonce }
//
// The server half of wallet-first sign-in for /play. Proves the caller controls
// `address` (ed25519 signature over the exact message embedding our server
// nonce), then reads that wallet's on-chain balance of the game token from real
// Solana RPC and gates entry on PLAY_GATE_MIN. On success it mints a short-lived
// play pass the standalone Colyseus server trusts (multiplayer/src/play-pass.js),
// binding the verified wallet as the account id for persistence + the social
// graph. The wallet is proven here, never taken on trust from a join option, so
// a forged session can't reach the game room.
//
// Responses (200 unless the request itself is malformed):
//   { ok: true,  wallet, balance, mint, symbol, decimals, playPass, expiresAt }
//   { ok: false, reason: 'balance_too_low', wallet, balance, mint, symbol,
//     minBalance, acquireUrl }
// Hard errors the gate UI routes on:
//   400 nonce_invalid   — missing/expired/forged nonce (re-fetch and retry)
//   401 bad_signature   — signature didn't match the address
//   400 gate_disabled   — no game token pinned (client shouldn't have called us)
//   502 balance_unavailable — RPC/price feed down
import { ed25519 } from '@noble/curves/ed25519.js';
import bs58mod from 'bs58';
import { z } from 'zod';
import { cors, error, json, method, readJson, wrap } from '../_lib/http.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { getBalances } from '../_lib/balances.js';
import { cacheGet, cacheSet } from '../_lib/cache.js';
import { verifyNonce, signPlayPass, PLAY_GATE_MINT, PLAY_GATE_MIN } from '../_lib/play-pass.js';

const bs58 = bs58mod.default || bs58mod;
const SOL_MINT = 'So11111111111111111111111111111111111111112';

const schema = z.object({
	address: z.string().trim().min(32).max(64),
	signature: z.string().trim().min(64).max(200),
	nonce: z.string().trim().min(16).max(4096),
});

// The message the wallet signs. MUST stay byte-identical to buildPlayMessage in
// src/game/play-auth.js — the server reconstructs it from the address + nonce and
// verifies the signature over these exact bytes, so any drift breaks every login.
function buildPlayMessage(address, nonce) {
	return [
		'three.ws wants you to sign in with your Solana account:',
		address,
		'',
		'Sign in to play three.ws. This proves you own this wallet and will not move any funds or tokens.',
		'',
		`Nonce: ${nonce}`,
	].join('\n');
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;
	res.setHeader('cache-control', 'no-store');

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	if (!PLAY_GATE_MINT) {
		return error(res, 400, 'gate_disabled', 'the token gate is not active');
	}

	const parsed = schema.safeParse(await readJson(req).catch(() => null));
	if (!parsed.success) return error(res, 400, 'validation_error', 'address, signature and nonce are required');
	const { address, signature, nonce } = parsed.data;

	// 1) The nonce must be one we issued and still live — defeats replaying a
	//    signature captured from an old session.
	const nv = verifyNonce(nonce);
	if (!nv) {
		return error(res, 400, 'nonce_invalid', 'sign-in expired — please try again');
	}
	// Single-use: burn the nonce so the same signed message can't be redeemed
	// twice within its TTL window. Backed by Upstash when configured (shared across
	// instances), in-memory otherwise — the HMAC + short TTL remain the floor.
	const burnKey = `playnonce:${nv.r}`;
	if (await cacheGet(burnKey)) {
		return error(res, 400, 'nonce_invalid', 'this sign-in was already used — please try again');
	}
	const ttl = Math.max(1, Math.ceil(nv.exp - Date.now() / 1000));
	await cacheSet(burnKey, 1, ttl);

	// 2) The signature must verify against the address over our exact message.
	let pubkey, sigBytes;
	try {
		pubkey = bs58.decode(address);
		sigBytes = bs58.decode(signature);
	} catch {
		return error(res, 400, 'validation_error', 'malformed address or signature');
	}
	if (pubkey.length !== 32 || sigBytes.length !== 64) {
		return error(res, 400, 'validation_error', 'malformed address or signature');
	}
	const msgBytes = new TextEncoder().encode(buildPlayMessage(address, nonce));
	let ok = false;
	try {
		ok = ed25519.verify(sigBytes, msgBytes, pubkey);
	} catch {
		ok = false;
	}
	if (!ok) {
		return error(res, 401, 'bad_signature', 'signature did not match the wallet');
	}

	// 3) Read the proven wallet's on-chain balance of the game token from real RPC.
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

	// 4) Gate on the floor. Short of it → an honest, actionable refusal with where
	//    to acquire the token; clear of it → a signed pass the game server trusts.
	if (balance >= minBalance) {
		const playPass = signPlayPass({ wallet: address, mint: PLAY_GATE_MINT, balance });
		return json(res, 200, {
			data: { ok: true, wallet: address, balance, mint: PLAY_GATE_MINT, symbol, decimals, playPass, expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString() },
		});
	}
	return json(res, 200, {
		data: {
			ok: false,
			reason: 'balance_too_low',
			wallet: address,
			balance,
			mint: PLAY_GATE_MINT,
			symbol,
			minBalance,
			acquireUrl: `https://jup.ag/swap/SOL-${PLAY_GATE_MINT}`,
		},
	});
});
