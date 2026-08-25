// GET /api/credits — the authenticated caller's prepaid credit balance, recent
// ledger, where to deposit (SOL or $THREE), and what credits buy. Powers the
// /credits page and the in-app balance pill. Resolves a browser session cookie
// OR a Bearer access token (so first-party clients and agents both read it).
//
// Query: ?limit=1..100 (default 25), ?cursor=<next_cursor from a prior page>.
// The ledger is keyset-paginated: pass the previous response's next_cursor to
// walk back through older entries; next_cursor is null on the last page.

import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { sql } from '../_lib/db.js';
import { cors, error, json, method, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { getCreditAccount, listLedger } from '../_lib/credits.js';
import { depositWallet } from '../_lib/credit-deposit.js';
import { TOKEN_MINT, TOKEN_SYMBOL, TOKEN_DECIMALS } from '../_lib/token/config.js';
import { publicCatalog } from '../_lib/pricing/catalog.js';
import { resolveUserTier, nextTier } from '../_lib/three-tier.js';
import { isUuid } from '../_lib/validate.js';

async function resolveUser(req, res) {
	const session = await getSessionUser(req, res);
	if (session) return session;
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) {
		const [u] = await sql`
			select id, wallet_address from users where id = ${bearer.userId} and deleted_at is null limit 1
		`;
		return u || null;
	}
	return null;
}

async function resolveHolder(user) {
	try {
		const { tier, usd, next } = await resolveUserTier(user);
		const nt = next ?? nextTier(tier);
		return {
			tier: {
				level: tier.level,
				id: tier.id,
				label: tier.label,
				discount_bps: tier.discountBps,
			},
			usd_held: Math.round((Number(usd) || 0) * 100) / 100,
			discount_bps: tier.discountBps,
			next_tier: nt ? { id: nt.id, label: nt.label, min_usd: nt.minUsd } : null,
			usd_to_next: nt
				? Math.max(0, Math.round((nt.minUsd - (Number(usd) || 0)) * 100) / 100)
				: 0,
		};
	} catch {
		return null;
	}
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.authedReadIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const user = await resolveUser(req, res);
	if (!user) return error(res, 401, 'unauthorized', 'sign in to view your credits');

	const url = new URL(req.url, 'http://x');
	const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 25, 1), 100);
	const cursor = url.searchParams.get('cursor') || null;
	// The cursor is a ledger row id and reaches a ::uuid comparison, so a
	// malformed one must be rejected here rather than becoming a driver error.
	if (cursor && !isUuid(cursor))
		return error(res, 400, 'bad_request', 'cursor must be a ledger entry id');

	// The $THREE holder discount is the headline promise of this surface ("hold
	// $THREE for up to 30% off every spend"), and every debit already applies it
	// (api/_lib/credits.js). Report it here so the page can show the tier the
	// caller is actually being charged at, in the same `holder` shape /api/pricing
	// uses. It reads a Solana balance, so it resolves alongside the DB work and
	// degrades to null rather than failing the balance read.
	const [acct, ledger, holder] = await Promise.all([
		getCreditAccount(user.id),
		listLedger({ userId: user.id, limit, before: cursor }),
		resolveHolder(user),
	]);

	// What credits buy: the fixed-price compute actions (variable / marketplace
	// prices are set per call, so they're excluded from this headline list).
	const buys = publicCatalog().filter((e) => e.usd != null && e.usd > 0);

	return json(res, 200, {
		balance_usd: acct.balanceUsd,
		holder,
		lifetime_deposited_usd: acct.lifetimeDepositedUsd,
		lifetime_spent_usd: acct.lifetimeSpentUsd,
		deposit: {
			wallet: depositWallet(),
			network: 'mainnet',
			accepts: ['SOL', 'THREE'],
			three_mint: TOKEN_MINT,
			three_symbol: TOKEN_SYMBOL,
			three_decimals: TOKEN_DECIMALS,
		},
		buys,
		ledger: ledger.items,
		next_cursor: ledger.next_cursor,
	});
});
