// Consolidated KOL endpoints dispatcher: /api/kol/{wallets,import-gmgn,
// leaderboard,tracker}. The trade feed is the one KOL endpoint that lives in its
// own file (api/kol/trades.js) because an exact file outranks this [action].js
// in filesystem routing; see the DISPATCH note at the bottom.

import { cors, json, method, readJson, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { requireAdmin } from '../_lib/admin.js';
import { createCache } from '../_lib/mem-cache.js';
import { loadWallets, saveImportedWallets } from '../../src/kol/wallet-store.js';

// ── wallets (Birdeye P&L proxy) ───────────────────────────────────────────────

const BIRDEYE_BASE = 'https://public-api.birdeye.so';
const CACHE_TTL_MS = 60_000;
// Birdeye failures are negative-cached for a much shorter window: long enough to
// stop an outage hammering the upstream every request, short enough that a
// transient blip doesn't hide a wallet (or, worse, render it as a fake zero-P&L
// row) for a full minute.
const NEG_CACHE_TTL_MS = 15_000;
const MAX_ADDRESSES = 20;
// Keys are caller-supplied addresses, so an LRU bound (not a plain Map) is what
// keeps a long-lived container from growing one entry per address ever queried:
// the hand-rolled Map this replaced only ever dropped an entry that was asked
// for again after it expired, so junk keys accumulated forever. Per-entry TTLs
// still differ by outcome, which lru-cache takes on set().
// Value: { data } (hit) | { error: true } (miss).
const _cache = createCache({ max: 2_000 });

function _getCached(addr) {
	return _cache.get(addr) ?? null;
}

function _setCache(addr, data) {
	_cache.set(addr, { data }, { ttl: CACHE_TTL_MS });
}

// Negative-cache a fetch failure instead of storing a normalized-from-null
// portfolio: that shape is all zeros and is indistinguishable from a real
// flat wallet, so callers would render an upstream outage as legitimate KOL
// data. A miss entry is filtered out of the response and refreshed sooner.
function _setCacheError(addr) {
	_cache.set(addr, { error: true }, { ttl: NEG_CACHE_TTL_MS });
}

async function _fetchBirdeye(addr, apiKey) {
	const url = `${BIRDEYE_BASE}/v1/wallet/portfolio?wallet=${encodeURIComponent(addr)}&chain=solana`;
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), 8000);
	try {
		const res = await fetch(url, { headers: { 'X-API-KEY': apiKey }, signal: ctrl.signal });
		if (!res.ok) throw new Error(`birdeye ${res.status}`);
		const j = await res.json();
		if (!j.success) throw new Error('birdeye responded with success=false');
		return j.data;
	} finally {
		clearTimeout(t);
	}
}

// Birdeye's /v1/wallet/portfolio is a HOLDINGS endpoint: it returns the wallet's
// current token positions and their USD value. It carries no realized P&L, no win
// rate and no trade count, so this proxy reports holdings under holdings names.
// The row it used to emit dressed them up as a P&L card instead: `realizedPnl`,
// `winRate` and `totalTrades` were hardcoded zeros Birdeye never sends,
// `unrealizedPnl` was really the portfolio's total USD value, and `topToken.pnl`
// was the top holding's value. Downstream (`get_wallet_portfolio` in
// packages/kol-mcp) rendered all four to agents as measured P&L. Real per-wallet
// P&L is FIFO-computed from the wallet's own on-chain trades by
// src/kol/wallet-pnl.js and merged in by _walletPnl below.
function _normalizeHoldings(addr, portfolio) {
	const items = Array.isArray(portfolio?.items) ? portfolio.items : [];
	let topToken = null;
	let maxVal = 0;
	let summedUsd = 0;
	for (const item of items) {
		const valueUsd = Number(item?.valueUsd) || 0;
		summedUsd += valueUsd;
		if (valueUsd > maxVal) {
			maxVal = valueUsd;
			topToken = { symbol: item?.symbol ?? '?', valueUsd };
		}
	}
	const totalUsd = Number(portfolio?.totalUsd);
	return {
		address: addr,
		totalUsd: Number.isFinite(totalUsd) ? totalUsd : summedUsd,
		holdings: items.length,
		topToken,
	};
}

// P&L window this proxy reports. The tracker board is window-selectable; this is
// a single-wallet card, so it answers one question ("how has this wallet traded
// lately") with the widest window the FIFO engine keeps cheap.
const PNL_WINDOW = '30d';
const NO_PNL = {
	realizedPnl: null,
	winRate: null,
	totalTrades: null,
	volumeUsd: null,
	pnlSource: null,
	pnlWindow: PNL_WINDOW,
};

// Real FIFO P&L over the wallet's own on-chain trades. No trade history for the
// wallet (no configured trade source, or none inside the window) is NOT a flat
// record: every P&L field stays null so a caller can tell "unknown" from "broke
// even". Same rule for win rate with no closed trades: a wallet that has only
// bought has no win rate yet, which is not a 0% one.
async function _walletPnl(addr) {
	const { getWalletPnl } = await import('../../src/kol/wallet-pnl.js');
	const pnl = await getWalletPnl({ wallet: addr, window: PNL_WINDOW }).catch(() => null);
	if (!pnl || pnl.trades === 0) return NO_PNL;
	return {
		realizedPnl: pnl.realizedUsd,
		winRate: pnl.closedTrades > 0 ? pnl.winRate : null,
		totalTrades: pnl.trades,
		volumeUsd: pnl.volumeUsd,
		pnlSource: 'onchain-fifo',
		pnlWindow: PNL_WINDOW,
	};
}

async function handleWallets(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const apiKey = process.env.BIRDEYE_API_KEY;
	if (!apiKey) return error(res, 503, 'birdeye_not_configured', 'Birdeye API key not configured');

	const rl = await limits.mcpIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, `http://${req.headers.host}`);
	const addresses = (url.searchParams.get('addresses') ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean)
		.slice(0, MAX_ADDRESSES);
	if (addresses.length === 0)
		return error(res, 400, 'validation_error', 'addresses query param is required');

	const uncached = addresses.filter((a) => _getCached(a) === null);
	const cacheHit = uncached.length === 0;

	if (uncached.length > 0) {
		await Promise.allSettled(
			uncached.map(async (addr) => {
				try {
					// _walletPnl never rejects, so only a Birdeye failure reaches the
					// catch: the holdings half is what this endpoint exists to proxy.
					const [portfolio, pnl] = await Promise.all([
						_fetchBirdeye(addr, apiKey),
						_walletPnl(addr),
					]);
					_setCache(addr, { ..._normalizeHoldings(addr, portfolio), ...pnl });
				} catch (err) {
					// The negative cache bounds this log to once per address per
					// NEG_CACHE_TTL window, so an outage can't flood the function logs.
					console.warn(`[kol] birdeye portfolio failed for ${addr.slice(0, 4)}…: ${err?.message || err}`);
					_setCacheError(addr);
				}
			}),
		);
	}

	const data = addresses
		.map((a) => _getCached(a))
		.filter((e) => e && !e.error)
		.map((e) => e.data);
	res.setHeader('x-cache', cacheHit ? 'HIT' : 'MISS');
	return json(res, 200, { data });
}

// ── import-gmgn ───────────────────────────────────────────────────────────────

async function handleImportGmgn(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['POST'])) return;
	const rl = await limits.mcpIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);
	// Writes the tracked-wallet list that downstream KOL surfaces read — admin only.
	const admin = await requireAdmin(req, res);
	if (!admin) return;
	const body = await readJson(req);
	if (!body || body.rawJson == null)
		return error(res, 400, 'validation_error', 'body.rawJson is required');
	const { parseGmgnSmartWallets } = await import('../../src/kol/gmgn-parser.js');
	let parsed;
	try {
		parsed = parseGmgnSmartWallets(body.rawJson);
	} catch (err) {
		return error(res, 400, 'validation_error', err.message);
	}
	// Optional admin-supplied wallet→X-handle map — the only way an xHandle ever
	// enters the tracked list. Never inferred or scraped: an admin who has verified
	// a real KOL controls a wallet (e.g. a signed message, a public self-disclosure)
	// attaches it here explicitly.
	const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
	const xHandles = body.xHandles && typeof body.xHandles === 'object' ? body.xHandles : {};
	for (const [wallet, handle] of Object.entries(xHandles)) {
		if (typeof handle !== 'string' || !HANDLE_RE.test(handle.replace(/^@/, ''))) continue;
		const entry = parsed.find((e) => e.wallet === wallet);
		if (entry) entry.xHandle = handle.replace(/^@/, '');
	}
	const existing = await loadWallets();
	const byWallet = new Map(existing.map((w) => [w.wallet, w]));
	for (const entry of parsed) {
		const prev = byWallet.get(entry.wallet);
		// Preserve a previously-attached xHandle across a re-import that doesn't repeat it.
		if (prev?.xHandle && !entry.xHandle) entry.xHandle = prev.xHandle;
		byWallet.set(entry.wallet, entry);
	}
	const merged = [...byWallet.values()];
	try {
		await saveImportedWallets(merged);
	} catch (err) {
		console.error('[kol/import-gmgn] R2 write failed:', err?.message || err);
		return error(res, 503, 'storage_unavailable', 'failed to persist imported wallets');
	}
	return json(res, 200, { imported: parsed.length, wallets: merged });
}

// ── leaderboard ───────────────────────────────────────────────────────────────

async function handleLeaderboard(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;
	const rl = await limits.mcpIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);
	const url = new URL(req.url, `http://${req.headers.host}`);
	const window = url.searchParams.get('window') || '7d';
	const limitRaw = url.searchParams.get('limit');
	const limit = Math.min(Math.max(Number(limitRaw) || 25, 1), 100);
	const { getLeaderboard } = await import('../../src/kol/leaderboard.js');
	let items;
	try {
		items = await getLeaderboard({ window, limit });
	} catch (err) {
		if (err.status === 400) return error(res, 400, err.code || 'validation_error', err.message);
		throw err;
	}
	return json(res, 200, { items });
}

// ── tracker ───────────────────────────────────────────────────────────────────

async function handleTracker(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;
	const rl = await limits.mcpIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);
	const url = new URL(req.url, `http://${req.headers.host}`);
	const window = url.searchParams.get('window') || '7d';
	if (!['24h', '7d', '30d'].includes(window))
		return error(res, 400, 'validation_error', 'window must be 24h, 7d, or 30d');
	const limitRaw = url.searchParams.get('limit');
	const limit = Math.min(Math.max(Number(limitRaw) || 100, 1), 100);
	const { getKolTracker } = await import('../../src/kol/tracker.js');
	const rows = await getKolTracker({ window, limit });
	return json(res, 200, { window, rows });
}

// ── dispatcher ────────────────────────────────────────────────────────────────

// /api/kol/trades is deliberately absent: api/kol/trades.js is an exact file, so
// filesystem precedence resolves that path to it and any branch here would be
// unreachable code drifting away from the one that actually serves the feed.
// tests/api/kol-route-resolution.test.js pins that split.
const DISPATCH = {
	'import-gmgn': handleImportGmgn,
	leaderboard: handleLeaderboard,
	tracker: handleTracker,
	wallets: handleWallets,
};

export default wrap(async (req, res) => {
	const action = req.query?.action ?? new URL(req.url, 'http://x').pathname.split('/').pop();
	const fn = DISPATCH[action];
	if (!fn) return error(res, 404, 'not_found', `unknown kol action: ${action}`);
	return fn(req, res);
});
