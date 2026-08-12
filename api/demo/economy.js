// GET  /api/demo/economy?status=1   → wallet info for both agents (no auth)
// GET  /api/demo/economy?trade=1    → SSE stream: execute a real agent-to-agent trade
//
// Agent A (Oracle)  — AVATAR_WALLET_SECRET    — sells market data for SOL
// Agent B (Trader)  — AGENT_B_WALLET_SECRET   — buys market data from Oracle
//
// A "trade" cycle:
//   1. Agent B pays Agent A a small SOL amount (real on-chain transfer)
//   2. Oracle fetches live Solana market data (top trending pools, GeckoTerminal)
//   3. SSE events stream the lifecycle back to the browser in real time
//   4. Browser renders the purchased data on the world TV and triggers avatar speech
//
// When AGENT_B_WALLET_SECRET is not set, status returns configured:false and
// the SSE stream returns a demo_mode event (no real payment, real data only).

import {
	loadAvatarKeypair,
	avatarWalletConfig,
	getConnection,
	getSolBalance,
	solUsdPrice,
	sendSol,
	explorerTxUrl,
	explorerAccountUrl,
	LAMPORTS_PER_SOL,
} from '../_lib/avatar-wallet.js';
import { trendingPools } from '../_lib/market/ohlcv.js';
import { cors, wrap, error, json, rateLimited } from '../_lib/http.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { limits, clientIp } from '../_lib/rate-limit.js';

const TRADE_SOL = 0.001; // price Oracle charges per data call
const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

// ── Wallet helpers ─────────────────────────────────────────────────────────

function agentAConfig() {
	return avatarWalletConfig(); // AVATAR_WALLET_SECRET
}

function agentBConfig() {
	const secret = process.env.AGENT_B_WALLET_SECRET?.trim();
	if (!secret) return { configured: false };
	try {
		const kp = loadAvatarKeypair(secret);
		return {
			configured: true,
			address: kp.publicKey.toBase58(),
			keypair: kp,
			network: 'solana',
			explorer: explorerAccountUrl(kp.publicKey.toBase58(), 'solana'),
		};
	} catch {
		return { configured: false };
	}
}

async function walletSnapshot(cfg) {
	if (!cfg.configured) return { configured: false };
	try {
		const conn = getConnection(RPC_URL);
		const [{ sol }, price] = await Promise.all([
			getSolBalance(conn, cfg.address),
			solUsdPrice().catch(() => 0),
		]);
		return {
			configured: true,
			address: cfg.address,
			sol,
			usd: price ? sol * price : null,
			solPriceUsd: price,
			explorer: cfg.explorer,
		};
	} catch {
		return { configured: true, address: cfg.address, sol: null, usd: null };
	}
}

// ── SSE helpers ────────────────────────────────────────────────────────────

function sseHeaders(res) {
	res.writeHead(200, {
		'content-type': 'text/event-stream',
		'cache-control': 'no-cache',
		connection: 'keep-alive',
		'access-control-allow-origin': '*',
	});
}

function emit(res, event, data) {
	res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ── Fetch real market data ─────────────────────────────────────────────────

async function fetchMarketData() {
	const pools = await trendingPools('solana', 6);
	return pools.map((p) => ({
		name: p.name,
		priceUsd: p.priceUsd,
		change24h: p.change24h,
		pool: p.pool,
	}));
}

// ── Route handler ──────────────────────────────────────────────────────────

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;

	const url = new URL(req.url, 'http://x');
	const wantsStatus = url.searchParams.get('status') === '1';
	const wantsTrade = url.searchParams.get('trade') === '1';
	if (!wantsStatus && !wantsTrade) {
		return error(res, 400, 'validation_error', 'use ?status=1 or ?trade=1');
	}

	// Meter BOTH branches before either runs. Status is not free: it fans out to two
	// Solana RPC balance reads plus a SOL price lookup on every call, so leaving it
	// unmetered let any anonymous caller amplify traffic onto our RPC quota. Same
	// 60/min/IP budget as /api/demo/coin/*.
	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const cfgA = agentAConfig();
	const cfgB = agentBConfig();

	// ── STATUS: wallet snapshots ──────────────────────────────────────────
	if (wantsStatus) {
		const [a, b] = await Promise.all([walletSnapshot(cfgA), walletSnapshot(cfgB)]);
		return json(res, 200, { agentA: a, agentB: b, tradeSol: TRADE_SOL });
	}

	// ── TRADE: SSE stream ─────────────────────────────────────────────────
	// The trade branch signs + sends a REAL on-chain SOL transfer from the
	// platform-held trader wallet — never expose that to anonymous callers.
	// Read-only callers use ?status=1; the trade stream requires a session
	// cookie or bearer token on top of the per-IP limit above.
	const sessionUser = await getSessionUser(req);
	const bearerUser = sessionUser ? null : await authenticateBearer(extractBearer(req));
	if (!sessionUser && !bearerUser) {
		return error(res, 401, 'unauthorized', 'sign in to run the agent-economy trade demo');
	}

	sseHeaders(res);

	// Phase 1: Agent B initiates request
	emit(res, 'thinking', {
		agent: 'B',
		text: `Trader agent requesting Solana market intelligence from Oracle. Preparing payment of ${TRADE_SOL} SOL.`,
	});

	// Phase 2: payment
	let paid = false;
	let demoMode = false;
	if (!cfgB.configured || !cfgA.configured) {
		demoMode = true;
		emit(res, 'demo_mode', {
			text: 'Demo mode — live data only, no real on-chain payment (agent wallets not configured).',
		});
	} else {
		emit(res, 'paying', {
			agent: 'B',
			to: cfgA.address,
			sol: TRADE_SOL,
			text: `Sending ${TRADE_SOL} SOL to Oracle wallet ${cfgA.address.slice(0, 8)}…`,
		});

		try {
			const conn = getConnection(RPC_URL);
			const bal = await getSolBalance(conn, cfgB.address);
			const needed = TRADE_SOL * LAMPORTS_PER_SOL + 15_000;
			if (bal.lamports < needed) {
				emit(res, 'error', {
					code: 'underfunded',
					fundAddress: cfgB.address,
					explorerUrl: explorerAccountUrl(cfgB.address, 'solana'),
					text: `Trader wallet underfunded (${bal.sol.toFixed(5)} SOL). Fund ${cfgB.address} and retry.`,
				});
				res.end();
				return;
			}

			const sig = await sendSol({
				connection: conn,
				fromKeypair: cfgB.keypair,
				to: cfgA.address,
				lamports: Math.floor(TRADE_SOL * LAMPORTS_PER_SOL),
				memo: 'three.ws agent-economy: data purchase',
			});

			paid = true;
			emit(res, 'paid', {
				agent: 'B',
				signature: sig,
				sol: TRADE_SOL,
				explorerUrl: explorerTxUrl(sig, 'solana'),
				text: `Payment confirmed on Solana. Signature: ${sig.slice(0, 12)}…`,
			});
		} catch (e) {
			emit(res, 'error', { text: `Payment failed: ${e.message}` });
			res.end();
			return;
		}
	}

	// Phase 3: Oracle fetches + delivers data
	emit(res, 'fetching', {
		agent: 'A',
		text: 'Oracle received payment. Fetching live Solana market intelligence…',
	});

	let markets = [];
	try {
		markets = await fetchMarketData();
	} catch (e) {
		emit(res, 'error', { text: `Market data fetch failed: ${e.message}` });
		res.end();
		return;
	}

	emit(res, 'delivering', {
		agent: 'A',
		markets,
		text: `Oracle delivering ${markets.length} live market signals to Trader.`,
	});

	emit(res, 'done', {
		markets,
		tradeSol: TRADE_SOL,
		paid,
		demo: demoMode,
		text: paid
			? 'Trade complete. Data delivered, payment settled on-chain.'
			: 'Demo complete. Live data delivered — no real payment occurred.',
	});

	res.end();
});
