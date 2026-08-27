// Seeker phone verification, dispatched by req.query.action.
//   GET  /api/seeker/status  -> handleStatus  (what the product already knows)
//   POST /api/seeker/verify  -> handleVerify  (re-scan linked Solana wallets)
//
// A user proves Seeker ownership by holding the soulbound Seeker Genesis Token
// in a wallet linked to their account. Verified wallets persist in
// seeker_genesis_verifications so the badge renders without an RPC call.

import { z } from 'zod';
import { sql } from '../_lib/db.js';
import { getSessionUser } from '../_lib/auth.js';
import { cors, json, method, readJson, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { parse } from '../_lib/validate.js';
import { dasRpcUrl } from '../_lib/nft-gate.js';
import { findSeekerGenesisToken } from '../_lib/seeker-genesis.js';

const verifyBody = z.object({
	wallet: z.string().min(32).max(64).optional(),
});

export default wrap(async (req, res) => {
	const action = req.query?.action ?? new URL(req.url, 'http://x').pathname.split('/').filter(Boolean).pop();
	if (action === 'status') return handleStatus(req, res);
	if (action === 'verify') return handleVerify(req, res);
	return error(res, 404, 'not_found', 'unknown seeker action');
});

async function linkedSolanaWallets(userId) {
	const rows = await sql`
		select address from user_wallets
		where user_id = ${userId} and chain_type = 'solana'
		order by is_primary desc, created_at asc
	`;
	return rows.map((r) => r.address);
}

async function statusPayload(userId) {
	const [rows, linked] = await Promise.all([
		sql`
			select wallet_address, token_mint, verified_at
			from seeker_genesis_verifications
			where user_id = ${userId}
			order by verified_at asc
		`,
		linkedSolanaWallets(userId),
	]);
	return {
		verified: rows.length > 0,
		wallets: rows.map((r) => ({
			address: r.wallet_address,
			tokenMint: r.token_mint,
			verifiedAt: r.verified_at instanceof Date ? r.verified_at.toISOString() : r.verified_at,
		})),
		linkedSolanaWallets: linked,
	};
}

async function handleStatus(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;
	const user = await getSessionUser(req, res);
	if (!user?.id) return error(res, 401, 'unauthorized', 'sign in to check Seeker status');
	return json(res, 200, await statusPayload(user.id));
}

async function handleVerify(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;
	const user = await getSessionUser(req, res);
	if (!user?.id) return error(res, 401, 'unauthorized', 'sign in to verify a Seeker');

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl, 'too many verification attempts');

	if (!dasRpcUrl()) {
		return error(res, 503, 'not_configured', 'Seeker verification needs a Helius RPC endpoint on this deployment');
	}

	const body = parse(verifyBody, (await readJson(req)) || {});
	const linked = await linkedSolanaWallets(user.id);
	let targets = linked;
	if (body.wallet) {
		if (!linked.includes(body.wallet)) {
			return error(res, 400, 'wallet_not_linked', 'that wallet is not linked to your account as a Solana wallet');
		}
		targets = [body.wallet];
	}

	const found = [];
	const missing = [];
	for (const address of targets) {
		let hit;
		try {
			hit = await findSeekerGenesisToken(address);
		} catch (err) {
			return error(res, 502, 'rpc_failed', `could not query Solana for ${address}: ${err.message}`);
		}
		if (hit) found.push({ address, mint: hit.mint });
		else missing.push(address);
	}

	for (const { address, mint } of found) {
		await sql`
			insert into seeker_genesis_verifications (user_id, wallet_address, token_mint)
			values (${user.id}, ${address}, ${mint})
			on conflict (user_id, wallet_address) do update
				set token_mint = excluded.token_mint, last_checked_at = now()
		`;
	}
	if (missing.length) {
		await sql`
			delete from seeker_genesis_verifications
			where user_id = ${user.id} and wallet_address = any(${missing})
		`;
	}

	return json(res, 200, { ...(await statusPayload(user.id)), checked: targets.length });
}
