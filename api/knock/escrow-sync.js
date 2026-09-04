// POST /api/knock/escrow-sync
//
// Copy one escrowed knock's on-chain state into the row that caches it.
//
// The escrow_* columns on knock_messages are a cache and nothing more: the
// chain decides whether a knock was answered, refused or refunded, and it does
// so through transactions signed by wallets we do not hold. So there is no
// moment where this server "knows" a settlement happened. It has to look.
//
// This is that look, and it is deliberately open to anybody. It cannot be used
// to claim anything: it reads the account the row already names, and writes
// back only what the program itself recorded. A caller who lies about a
// settlement gets the truth written instead. That is also why it is safe for
// the sender's own page to call it, which is what keeps a refunded knock from
// sitting in the recipient's inbox looking like money still on the table.

import { z } from 'zod';
import { cors, json, method, wrap, error, readJson, rateLimited } from '../_lib/http.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { parse } from '../_lib/validate.js';
import { rpcFallbackFromEnv } from '../_lib/solana/rpc-fallback.js';
import { KNOCK_ESCROW_PROGRAM_ID, KNOCK_STATE_NAME, decodeKnock } from '../_lib/knock/escrow.js';
import { findByEscrowKnock, updateEscrowState } from '../_lib/knock/store.js';
import { PublicKey } from '@solana/web3.js';

const body = z.object({
	knock: z.string().trim().min(32).max(44),
});

export default wrap(async (req, res) => {
	if (cors(req, res, { origins: '*', methods: 'POST,OPTIONS' })) return;
	if (!method(req, res, ['POST'])) return;

	const rl = await limits.knockSendIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl, 'too many escrow checks from one address');

	const input = parse(body, await readJson(req));

	// Only a knock this platform actually delivered can be synced. Anything else
	// is somebody else's escrow and none of our cache's business.
	const row = await findByEscrowKnock(input.knock);
	if (!row) return error(res, 404, 'unknown_escrow', 'no delivered knock is recorded against that escrow');

	let record;
	try {
		const rpc = rpcFallbackFromEnv({ network: 'mainnet' });
		record = await rpc.withFallback(async (connection) => {
			const info = await connection.getAccountInfo(new PublicKey(input.knock));
			if (!info) return null;
			if (info.owner?.toBase58?.() !== KNOCK_ESCROW_PROGRAM_ID) return null;
			return decodeKnock(info.data);
		});
	} catch {
		// An RPC that will not answer is not evidence about a settlement, so the
		// cache is left exactly as it was rather than guessed at.
		return error(res, 503, 'chain_unreachable', 'could not read the chain just now; the cached state is unchanged');
	}

	if (!record) {
		return json(res, 200, {
			ok: true,
			knock: input.knock,
			state: row.escrow_state || 'pending',
			changed: false,
			note: 'that escrow account is not readable, so nothing was changed',
		});
	}

	const state = KNOCK_STATE_NAME[record.state] || 'pending';
	const changed = state !== row.escrow_state;
	if (changed) await updateEscrowState(input.knock, state);

	return json(res, 200, {
		ok: true,
		knock: input.knock,
		state,
		changed,
		amount_atomics: String(record.amount),
		expires_at: record.expiresAt,
		expired: Math.floor(Date.now() / 1000) > record.expiresAt,
	});
});
