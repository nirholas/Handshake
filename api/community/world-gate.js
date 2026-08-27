// GET  /api/community/world-gate?token=<mint>  — read a coin's world gate
// POST /api/community/world-gate?token=<mint>  — set it (coin creator only)
//
// R24 token-gated worlds. A coin's creator may require holding ≥ X of the coin to
// enter its Holders world, overriding the platform USD floor. The threshold is a
// token amount; setting 0 (or omitting it) clears the gate back to the default.
//
// GET is public so the lobby and gate screen can state the requirement; it adds
// `canEdit: true` only when the signed-in user's linked Solana wallet is the
// coin's on-chain creator. POST re-verifies that ownership server-side before
// writing — the browser never asserts who the creator is.
//
// Responses:
//   GET  { mint, gated, minTokens, canEdit }
//   POST { mint, gated, minTokens }                       — on success
//   401 auth_required     — POST without a CoinCommunities session
//   403 not_creator       — signed in, but not this coin's creator
//   403 wallet_required   — signed in, but no linked Solana wallet to match
//   400 solana_only:      POST for a non-Solana world (see below)
import { cors, error, json, method, readJson, wrap, rateLimited } from '../_lib/http.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import {
	cc,
	hasUserSession,
	withAuthRefresh,
	isValidToken,
	isSolanaToken,
	UnconfiguredError,
} from '../_lib/coin-communities.js';
import { readWorldGate, writeWorldGate, normalizeMinTokens } from '../_lib/world-gate.js';
import { pumpFetchJson, PUMP_FRONTEND_BASE } from '../_lib/pump-feed-fetch.js';
import { cacheWrapLastGood } from '../_lib/cache.js';

// A coin's creator never changes, so a resolved answer can be reused for a
// while and, when pump.fun is down, served from the last good copy for an hour
// rather than blocking every gate read and write behind the outage.
export const CREATOR_CACHE_KEY = (mint) => `world-gate:creator:${mint}`;
const CREATOR_TTL_S = 10 * 60;
const CREATOR_LKG_TTL_S = 60 * 60;

// Resolve a coin's on-chain creator from pump.fun. Returns '' when unknown (a
// non-pump mint, or pump didn't answer) so the caller fails closed (not creator).
async function resolveCoinCreator(mint) {
	try {
		return await cacheWrapLastGood(CREATOR_CACHE_KEY(mint), CREATOR_TTL_S, () => fetchCoinCreator(mint), {
			staleTtlSeconds: CREATOR_LKG_TTL_S,
		});
	} catch {
		return '';
	}
}

// Live pump.fun read with the feed's deadline + one bounded retry. A coin pump
// does not know (404) is a definite answer and is thrown as such so the
// last-good layer never papers over it with an older lookup.
async function fetchCoinCreator(mint) {
	const url = new URL(`/coins/${mint}`, PUMP_FRONTEND_BASE).toString();
	const { ok, status, body } = await pumpFetchJson(url, { timeoutMs: 8000, retries: 1 });
	if (!ok && status === 404) return '';
	if (!ok) throw new Error(`pump.fun ${status || 'unreachable'}`);
	const creator = typeof body?.creator === 'string' ? body.creator.trim() : '';
	if (!creator) throw new Error('pump.fun answered without a creator');
	return creator;
}

// The signed-in user's linked Solana wallets, as { data: { wallets }, error }
// shaped like the SDK's so it composes directly with withAuthRefresh. Every
// linked wallet is returned: matching the creator is one in-memory comparison
// over an already-fetched list, so capping it bought nothing and would tell a
// real creator who happened to link that wallet late that they are not one.
async function linkedSvmWallets(api, headers) {
	const w = await api.getWallets({ headers });
	if (w.error) return { error: w.error };
	const wallets = (w.data?.wallets ?? [])
		.filter((x) => x.chainType === 'svm')
		.map((x) => x.address)
		.filter(Boolean);
	return { data: { wallets } };
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST'])) return;
	res.setHeader('cache-control', 'no-store');

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const mint = new URL(req.url, 'http://x').searchParams.get('token');
	if (!isValidToken(mint)) {
		return error(res, 400, 'validation_error', 'valid token query param required');
	}

	if (req.method === 'GET') {
		const gate = await readWorldGate(mint);
		const minTokens = gate?.minTokens || 0;
		// Whether the requester may edit: signed in, with a linked wallet that is the
		// coin's creator. Best-effort — any failure just yields canEdit:false (the
		// read still succeeds), so the requirement is always visible.
		let canEdit = false;
		if (hasUserSession(req)) {
			try {
				const api = cc();
				const [{ data: walletsData }, creator] = await Promise.all([
					withAuthRefresh(req, res, (h) => linkedSvmWallets(api, h)),
					resolveCoinCreator(mint),
				]);
				const wallets = walletsData?.wallets ?? [];
				canEdit = !!creator && wallets.includes(creator);
			} catch { /* canEdit stays false */ }
		}
		return json(res, 200, { data: { mint, gated: minTokens > 0, minTokens, canEdit } });
	}

	// POST — set the threshold. Creator-only.
	//
	// Creator ownership is proved against pump.fun and enforced against a linked
	// Solana wallet, and the gate it writes is spent by the Solana holder pass
	// (api/community/holder-pass.js). None of that can answer for an EVM-chain
	// world, whose Town chat is valid but whose creator we cannot verify. Say that
	// plainly here instead of letting it surface as a "try again" upstream error
	// the caller would retry forever.
	if (!isSolanaToken(mint)) {
		return error(
			res,
			400,
			'solana_only',
			'world gates are available for Solana coins only',
		);
	}

	let api;
	try {
		api = cc();
	} catch (err) {
		if (err instanceof UnconfiguredError) {
			return error(res, 503, 'cc_unconfigured', 'CoinCommunities is not configured');
		}
		throw err;
	}

	// Parse the body before any upstream calls so a bad request fails fast.
	let minTokens = 0;
	try {
		const raw = await readJson(req);
		minTokens = normalizeMinTokens(raw?.minTokens);
	} catch {
		return error(res, 400, 'validation_error', 'body must be JSON { minTokens }');
	}

	const { data: walletData, error: walletErr, headers } = await withAuthRefresh(req, res, (h) =>
		linkedSvmWallets(api, h),
	);
	if (!headers) {
		return error(res, 401, 'auth_required', 'sign in with X to manage this world');
	}
	if (walletErr) {
		return error(res, 502, 'upstream_error', walletErr.message || 'failed to read wallets');
	}
	const wallets = walletData?.wallets ?? [];
	if (!wallets.length) {
		return error(res, 403, 'wallet_required', 'link the creator wallet to manage this world');
	}

	const creator = await resolveCoinCreator(mint);
	if (!creator) {
		return error(res, 502, 'creator_unresolved', 'could not resolve this coin’s creator, try again');
	}
	if (!wallets.includes(creator)) {
		return error(res, 403, 'not_creator', 'only the coin’s creator can gate this world');
	}

	const cfg = await writeWorldGate(mint, { minTokens }, creator);
	return json(res, 200, { data: { mint, gated: !!cfg, minTokens: cfg?.minTokens || 0 } });
});
