// GET /api/rider/check?address=<solana wallet>
//
// Answers "does this wallet hold a rider pass?" from BOTH sources that can grant
// one. Either source alone gives the wrong answer: reading only the on-chain
// balance denies every wallet that bought a pass by sending its $THREE to the
// vault (api/rider/webhook.js records those in rider_passes), and reading only
// rider_passes denies every holder who never had to pay.

import { PublicKey } from '@solana/web3.js';
import { solanaConnection } from '../_lib/solana/connection.js';
import { sql } from '../_lib/db.js';
import { env } from '../_lib/env.js';
import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { REQUIRED_AMOUNT } from '../_lib/rider.js';
import { TOKEN_MINT as THREE_MINT } from '../_lib/token/config.js';
import { cacheGet, cacheSet } from '../_lib/cache.js';
import { staleEnvelope, RPC_RETRY_AFTER_S } from '../_lib/rpc-degrade.js';

// Last verdict per wallet. A pass check gates a ride, so the window is short:
// long enough to ride out an RPC blip mid-session, short enough that a wallet
// that just sold its $THREE is re-read within minutes.
const VERDICT_LKG_TTL_S = 10 * 60;
const verdictKey = (address) => `rider:check:lkg:${address}`;

async function heldBalance(owner) {
	const connection = solanaConnection({ url: env.SOLANA_RPC_URL, commitment: 'confirmed' });
	// Filter by MINT, not by token program: $THREE is a Token-2022 mint, so a
	// classic-program-only query never sees it (every holder read as balance 0).
	// The mint filter matches the holder's account under whichever program owns
	// the mint, and returns only that account instead of the whole wallet.
	const accounts = await connection.getParsedTokenAccountsByOwner(owner, {
		mint: new PublicKey(THREE_MINT),
	});
	return accounts.value.reduce(
		(sum, a) => sum + Number(a.account.data.parsed.info.tokenAmount.uiAmount ?? 0),
		0,
	);
}

async function recordedPayment(address) {
	const rows = await sql`
		select amount_paid, tx_signature, created_at
		from rider_passes
		where wallet_address = ${address}
		limit 1
	`;
	return rows[0] ?? null;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.authedReadIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	// A repeated query param (?address=a&address=b) arrives as an array, which
	// has no .trim(), so reading it directly turned a malformed request into a 500.
	const raw = req.query?.address;
	const address = (Array.isArray(raw) ? raw[0] : raw ?? '').toString().trim();
	if (!address) return error(res, 400, 'validation_error', 'address required');

	let owner;
	try {
		owner = new PublicKey(address);
	} catch {
		return error(res, 400, 'validation_error', 'invalid Solana address');
	}

	// Both lookups run together, and a positive result from either one is already
	// authoritative: a failed lookup only blocks the answer when it was the one
	// that had to prove the wallet has NO pass.
	const [balanceRead, paymentRead] = await Promise.allSettled([
		heldBalance(owner),
		recordedPayment(address),
	]);

	const balance = balanceRead.status === 'fulfilled' ? balanceRead.value : null;
	const payment = paymentRead.status === 'fulfilled' ? paymentRead.value : null;
	const holderPass = balance != null && balance > 0;
	const paidPass = payment != null;

	if (!holderPass && balanceRead.status === 'rejected') {
		if (!paidPass) {
			// Never echo the rejection message: a web3.js network error embeds the
			// keyed RPC URL, which would leak HELIUS_API_KEY to the caller.
			console.error('[rider/check] $THREE balance read failed', balanceRead.reason);
			// The last verdict this wallet got, marked stale, beats refusing the
			// gate outright; a wallet never checked before gets the typed 503.
			const lkg = await cacheGet(verdictKey(address));
			if (lkg && lkg.body && typeof lkg.at === 'number') {
				res.setHeader('x-rider-stale', '1');
				return json(res, 200, staleEnvelope(lkg.body, lkg.at));
			}
			res.setHeader('Retry-After', String(RPC_RETRY_AFTER_S));
			return error(res, 503, 'rpc_unavailable', 'could not read the $THREE balance for this wallet, retry shortly', {
				retry_after: RPC_RETRY_AFTER_S,
			});
		}
	}
	if (!paidPass && paymentRead.status === 'rejected') {
		// Hand a DB outage to wrap(), which already classifies it as a throttled 503
		// instead of a per-request 5xx alert storm.
		if (!holderPass) throw paymentRead.reason;
	}

	const body = {
		has_pass: holderPass || paidPass,
		holder_pass: holderPass,
		paid_pass: paidPass,
		balance,
		amount_paid: payment ? Number(payment.amount_paid) : null,
		tx_signature: payment?.tx_signature ?? null,
		required_amount: REQUIRED_AMOUNT,
		mint: THREE_MINT,
	};
	// Only a verdict both sources actually answered is worth remembering.
	if (balanceRead.status === 'fulfilled' && paymentRead.status === 'fulfilled') {
		cacheSet(verdictKey(address), { body, at: Date.now() }, VERDICT_LKG_TTL_S).catch(() => {});
	}
	return json(res, 200, body);
});
