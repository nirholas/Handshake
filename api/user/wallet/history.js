// GET /api/user/wallet/history
// On-chain transaction history for the master wallet's Solana address.
// Query params: ?limit=20&network=mainnet

import { getSessionUser } from '../../_lib/auth.js';
import { sql } from '../../_lib/db.js';
import { cors, json, error, wrap, method } from '../../_lib/http.js';
import { limits } from '../../_lib/rate-limit.js';
import { solanaConnection, solanaPublicConnection } from '../../_lib/agent-pumpfun.js';
import { cacheGet, cacheSet } from '../../_lib/cache.js';
import { PublicKey } from '@solana/web3.js';

const CACHE_TTL_S = 60;

async function withFallback(primaryConn, fallbackConn, fn) {
	try { return { ok: true, value: await fn(primaryConn) }; } catch {}
	await new Promise((r) => setTimeout(r, 500));
	try { return { ok: true, value: await fn(primaryConn) }; } catch {}
	await new Promise((r) => setTimeout(r, 1000));
	if (fallbackConn) {
		try { return { ok: true, value: await fn(fallbackConn) }; } catch (e) { return { ok: false, error: e }; }
	}
	return { ok: false, error: new Error('all RPC attempts failed') };
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const session = await getSessionUser(req);
	if (!session) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.walletRead(session.id);
	if (!rl.success) return json(res, 429, { error: 'rate_limited' });

	const [row] = await sql`
		SELECT solana_address FROM master_wallets WHERE user_id = ${session.id}
	`;
	if (!row?.solana_address) return json(res, 200, { history: [] });

	const url = new URL(req.url, 'http://x');
	const network = url.searchParams.get('network') === 'devnet' ? 'devnet' : 'mainnet';
	// Clamp on BOTH ends. Only the upper bound was enforced, so `?limit=-5`
	// passed straight through to getSignaturesForAddress, which rejects it and
	// turned plainly malformed input into a 502 blamed on the RPC.
	const limit = Math.max(1, Math.min(parseInt(url.searchParams.get('limit') || '20', 10) || 20, 50));

	const address = row.solana_address;
	const cacheKey = `mw:sigs:${address}:${network}:${limit}`;
	let sigs = await cacheGet(cacheKey);

	if (sigs === null) {
		const primary = solanaConnection(network);
		const fallback = solanaPublicConnection(network);
		const pk = new PublicKey(address);

		const result = await withFallback(primary, fallback, (c) =>
			c.getSignaturesForAddress(pk, { limit }),
		);
		if (!result.ok) return error(res, 502, 'rpc_error', 'could not fetch transaction history');
		sigs = result.value;
		await cacheSet(cacheKey, sigs, CACHE_TTL_S);
	}

	// Enrich with parsed tx data when available
	let parsed = null;
	if (sigs.length) {
		const primary = solanaConnection(network);
		const fallback = solanaPublicConnection(network);
		const result = await withFallback(primary, fallback, (c) =>
			c.getParsedTransactions(sigs.map((s) => s.signature), {
				maxSupportedTransactionVersion: 0,
				commitment: 'confirmed',
			}),
		);
		if (result.ok) parsed = result.value;
	}

	const history = sigs.map((s, i) => {
		const tx = parsed?.[i] ?? null;
		let lamport_delta = null;
		let summary = null;
		if (tx?.meta && tx?.transaction) {
			const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey?.toString());
			const idx = keys.indexOf(address);
			if (idx >= 0 && tx.meta.preBalances && tx.meta.postBalances) {
				lamport_delta = tx.meta.postBalances[idx] - tx.meta.preBalances[idx];
			}
			const ix = tx.transaction.message.instructions?.[0];
			if (ix?.parsed?.type) summary = ix.parsed.type;
			else if (ix?.programId) summary = `program ${ix.programId.toString().slice(0, 8)}…`;
		}
		return {
			signature: s.signature,
			slot: s.slot,
			block_time: s.blockTime ?? null,
			success: !s.err && !tx?.meta?.err,
			error: s.err || tx?.meta?.err || null,
			lamport_delta,
			summary,
			explorer: `https://solscan.io/tx/${s.signature}`,
		};
	});

	return json(res, 200, { history, address, network });
});
