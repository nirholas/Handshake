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
import { cors, error, json, method, readJson, wrap, rateLimited } from '../_lib/http.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { cc, userAuthHeaders, withAuthRefresh, isValidToken, UnconfiguredError } from '../_lib/coin-communities.js';
import { readWorldGate, writeWorldGate, normalizeMinTokens } from '../_lib/world-gate.js';

const PUMP_FRONTEND_BASE = process.env.PUMP_FRONTEND_BASE || 'https://frontend-api-v3.pump.fun';
const MAX_WALLETS_CHECKED = 5;

// Resolve a coin's on-chain creator from pump.fun. Returns '' when unknown (a
// non-pump mint, or pump didn't answer) so the caller fails closed (not creator).
async function resolveCoinCreator(mint) {
	try {
		const resp = await fetch(new URL(`/coins/${mint}`, PUMP_FRONTEND_BASE), {
			headers: { accept: 'application/json' },
			signal: AbortSignal.timeout(8000),
		});
		if (!resp.ok) return '';
		const body = await resp.json();
		const creator = typeof body?.creator === 'string' ? body.creator.trim() : '';
		return creator;
	} catch {
		return '';
	}
}

// The signed-in user's linked Solana wallets, as { data: { wallets }, error }
// shaped like the SDK's so it composes directly with withAuthRefresh.
async function linkedSvmWallets(api, headers) {
	const w = await api.getWallets({ headers });
	if (w.error) return { error: w.error };
	const wallets = (w.data?.wallets ?? [])
		.filter((x) => x.chainType === 'svm')
		.map((x) => x.address)
		.filter(Boolean)
		.slice(0, MAX_WALLETS_CHECKED);
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
		if (userAuthHeaders(req)) {
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
		return error(res, 502, 'creator_unresolved', 'could not resolve this coin’s creator — try again');
	}
	if (!wallets.includes(creator)) {
		return error(res, 403, 'not_creator', 'only the coin’s creator can gate this world');
	}

	const cfg = await writeWorldGate(mint, { minTokens }, creator);
	return json(res, 200, { data: { mint, gated: !!cfg, minTokens: cfg?.minTokens || 0 } });
});
