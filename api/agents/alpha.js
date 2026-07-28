// /api/agents/:id/alpha — the In-Character Alpha Co-pilot.
//
// The intelligence + voice layer ON TOP of the wallet program's trade rails.
// The agent's LLM persona reads a REAL live pump.fun launch, decides what it
// would do, and explains it in character for its 3D avatar to speak aloud. The
// owner can then act on the read — but only ever through the same guarded path
// the conversational copilot uses (executeAgentTrade → POST /solana/trade),
// which enforces the spend policy, the rug/honeypot firewall, and the custody
// audit. This endpoint NEVER signs and NEVER moves funds.
//
//   GET  /api/agents/:id/alpha/candidates?network=  → real live launches to read
//   POST /api/agents/:id/alpha/read  { mint, network } → grounded in-character read
//
// Anti-hallucination: the model only ever sees real numbers we fetched, and its
// output is clamped + scrubbed against those inputs (api/_lib/alpha-read.js)
// before it is shown or spoken — a fabricated figure is rejected, never voiced.
//
// $THREE (FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump) is the only coin three.ws
// promotes. This reads whatever runtime mint the live feed surfaces — coin-
// agnostic analytics — and never names or recommends any other token.

import { PublicKey } from '@solana/web3.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { sql } from '../_lib/db.js';
import { cors, json, method, error, readJson, rateLimited, wrap } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { solanaPublicConnection } from '../_lib/agent-pumpfun.js';
import { getSmartMoneyForMint } from '../_lib/smart-money.js';
import { getTradeLimits, getSpendLimits, getDailySpendLamports } from '../_lib/agent-trade-guards.js';
import { getBondingCurveState, getBuyQuote, getGraduationProgress } from '../_lib/solana/sdk-bridge.js';
import { connectPumpFunFeed, recentBuffered, recentGraduations } from '../_lib/pumpfun-ws-feed.js';
import { llmComplete, LlmUnavailableError } from '../_lib/llm.js';
import { buildReadPrompt, parseReadJson, validateRead } from '../_lib/alpha-read.js';

const NETWORKS = new Set(['mainnet', 'devnet']);
const netOf = (v) => (NETWORKS.has(v) ? v : 'mainnet');
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const LAMPORTS_PER_SOL = 1_000_000_000;
const PUMPFUN_COIN_API = 'https://frontend-api-v3.pump.fun/coins';
const REFERENCE_BUY_SOL = 0.1; // probe size for a real, non-binding price-impact read

const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));

// ── auth (optional — public commentary works logged-out) ───────────────────────
async function resolveAuth(req) {
	const session = await getSessionUser(req).catch(() => null);
	if (session) return { userId: session.id };
	const bearer = await authenticateBearer(extractBearer(req)).catch(() => null);
	if (bearer) return { userId: bearer.userId };
	return null;
}

// Load the agent for an alpha read. Public commentary is allowed for published
// agents; the owner additionally unlocks wallet-aware sizing + the action gate.
async function loadAgent(id, userId) {
	const [row] = await sql`
		SELECT id, user_id, name, persona_prompt, voice_provider, voice_id, avatar_id,
		       is_published, meta
		FROM agent_identities WHERE id = ${id} AND deleted_at IS NULL`;
	if (!row) return { error: { status: 404, code: 'not_found', msg: 'agent not found' } };
	const owner = !!userId && row.user_id === userId;
	if (!owner && !row.is_published) return { error: { status: 404, code: 'not_found', msg: 'agent not found' } };
	return { row, owner };
}

// ── live launch candidates ──────────────────────────────────────────────────────

async function fetchPumpCoin(mint) {
	const ctrl = new AbortController();
	const tid = setTimeout(() => ctrl.abort(), 2500);
	try {
		const r = await fetch(`${PUMPFUN_COIN_API}/${encodeURIComponent(mint)}`, {
			signal: ctrl.signal,
			headers: { accept: 'application/json', 'user-agent': 'three.ws-alpha-copilot/1' },
		});
		if (!r.ok) return null;
		return await r.json();
	} catch { return null; } finally { clearTimeout(tid); }
}

// Briefly tap the live PumpPortal mint feed to gather fresh launches. Bounded so
// a serverless request never hangs; resolves with whatever real mints arrived.
function collectLiveMints({ ms = 3200, want = 12 } = {}) {
	return new Promise((resolve) => {
		const out = [];
		const seen = new Set();
		const abort = new AbortController();
		let done = false;
		const finish = () => { if (done) return; done = true; try { abort.abort(); } catch {} resolve(out); };
		try {
			connectPumpFunFeed({
				kind: 'mint',
				signal: abort.signal,
				onEvent: ({ kind, data }) => {
					if (done || kind !== 'mint' || !data?.mint || seen.has(data.mint)) return;
					seen.add(data.mint);
					out.push(data);
					if (out.length >= want) finish();
				},
			});
		} catch { finish(); }
		setTimeout(finish, ms);
	});
}

async function enrichCandidate(c, network) {
	const [sm, intel] = await Promise.all([
		getSmartMoneyForMint(c.mint, network).catch(() => null),
		loadIntel(c.mint, network).catch(() => null),
	]);
	const createdSec = num(c.created_at) || num(c.timestamp);
	const ageSeconds = createdSec ? Math.max(0, Math.floor(Date.now() / 1000 - createdSec)) : null;
	return {
		mint: c.mint,
		symbol: c.symbol || intel?.symbol || null,
		name: c.name || intel?.name || null,
		image_uri: c.image_uri || null,
		age_seconds: ageSeconds,
		market_cap_usd: num(c.market_cap_usd) ?? num(c.usd_market_cap),
		initial_buy_sol: num(c.initial_buy_sol),
		creator: c.creator || null,
		creator_launches: num(c.creator_launches),
		creator_graduated: num(c.creator_graduated),
		twitter: c.twitter || null,
		telegram: c.telegram || null,
		website: c.website || null,
		smart_money_score: sm?.smart_money_score ?? null,
		smart_money_count: sm?.count ?? null,
		sybil_flag: sm?.sybil_flag ?? false,
		quality_score: intel?.quality_score ?? null,
		risk_flags: intel?.risk_flags ?? [],
	};
}

async function handleCandidates(req, res, id) {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const auth = await resolveAuth(req);
	const rl = await limits.publicIp(clientIp(req)).catch(() => ({ success: true }));
	if (rl && rl.success === false) return rateLimited(res, rl);

	const loaded = await loadAgent(id, auth?.userId);
	if (loaded.error) return error(res, loaded.error.status, loaded.error.code, loaded.error.msg);

	const url = new URL(req.url, 'http://x');
	const network = netOf(url.searchParams.get('network'));

	// Merge three real sources, newest-first, deduped by mint: the warm in-process
	// buffer (instant), a brief live tap of the feed (fresh mints), and persisted
	// graduations from Postgres (always available, even on a cold instance).
	const byMint = new Map();
	const add = (d) => { if (d?.mint && !byMint.has(d.mint)) byMint.set(d.mint, d); };

	if (network === 'mainnet') {
		recentBuffered({ kind: 'mint', limit: 12 }).forEach((e) => add(e.data));
		if (byMint.size < 8) {
			const live = await collectLiveMints({ want: 12 - byMint.size }).catch(() => []);
			live.forEach(add);
		}
		recentBuffered({ kind: 'graduation', limit: 6 }).forEach((e) => add(e.data));
		if (byMint.size < 4) {
			const grads = await recentGraduations({ limit: 8 }).catch(() => []);
			grads.forEach(add);
		}
	}

	const raw = [...byMint.values()].slice(0, 10);
	const items = await Promise.all(raw.map((c) => enrichCandidate(c, network).catch(() => null)));
	return json(res, 200, { network, items: items.filter(Boolean) }, { 'cache-control': 'no-store' });
}

// ── intel read (same shape the copilot uses) ────────────────────────────────────
async function loadIntel(mint, network) {
	const [row] = await sql`
		SELECT i.mint, i.symbol, i.name, i.quality_score, i.bundle_score, i.organic_score,
		       i.snipe_ratio, i.concentration_top10, i.fresh_wallet_ratio, i.risk_flags,
		       i.category, i.narrative, i.dev_sold, i.unique_buyers,
		       o.outcome, o.ath_multiple
		FROM pump_coin_intel i
		LEFT JOIN pump_coin_outcomes o ON o.mint = i.mint AND o.network = i.network
		WHERE i.mint = ${mint} AND i.network = ${network}
		LIMIT 1`.catch(() => []);
	if (!row) return null;
	return {
		symbol: row.symbol, name: row.name,
		quality_score: num(row.quality_score),
		bundle_score: num(row.bundle_score), organic_score: num(row.organic_score),
		snipe_ratio: num(row.snipe_ratio), concentration_top10: num(row.concentration_top10),
		fresh_wallet_ratio: num(row.fresh_wallet_ratio), risk_flags: row.risk_flags || [],
		category: row.category, narrative: row.narrative, dev_sold: row.dev_sold,
		unique_buyers: num(row.unique_buyers),
		outcome: row.outcome || null, ath_multiple: num(row.ath_multiple),
	};
}

// Gather every REAL signal for one mint. Each source degrades to null on its own
// — a thin coin yields a thin (but honest) signal bundle, never a fabricated one.
async function gatherSignals(mint, network, { agentId, meta, owner }) {
	const conn = solanaPublicConnection(network);
	const mintPk = new PublicKey(mint);
	const refLamports = Math.floor(REFERENCE_BUY_SOL * LAMPORTS_PER_SOL);
	const walletPk = owner && meta.solana_address ? new PublicKey(meta.solana_address) : null;

	const [coin, intel, sm, curve, grad, buyQuote, walletLamports, dailySpentLamports] = await Promise.all([
		network === 'mainnet' ? fetchPumpCoin(mint).catch(() => null) : Promise.resolve(null),
		loadIntel(mint, network).catch(() => null),
		getSmartMoneyForMint(mint, network).catch(() => null),
		getBondingCurveState(conn, mintPk).catch(() => null),
		getGraduationProgress(conn, mintPk).catch(() => null),
		getBuyQuote(conn, mintPk, refLamports).catch(() => null),
		walletPk ? conn.getBalance(walletPk).catch(() => null) : Promise.resolve(null),
		owner ? getDailySpendLamports(agentId, network).catch(() => 0n) : Promise.resolve(0n),
	]);

	const solPrice = num(coin?.usd_market_cap) && num(coin?.market_cap) ? coin.usd_market_cap / coin.market_cap : null;
	const createdSec = num(coin?.created_timestamp) ? Math.floor(coin.created_timestamp / 1000) : null;
	const liquiditySol = curve ? round3(Number(BigInt(curve.realSolReserves)) / 1e9) : null;
	const gradPct = num(grad?.progress) != null ? Math.round(num(grad.progress) * 100) : (curve?.complete ? 100 : null);

	const tradeLimits = getTradeLimits(meta);
	const spendLimits = getSpendLimits(meta);
	const balanceSol = walletLamports != null ? round3(Number(walletLamports) / 1e9) : null;
	const dailySpentSol = round3(Number(dailySpentLamports || 0n) / 1e9);

	const signals = {
		symbol: coin?.symbol || intel?.symbol || null,
		name: coin?.name || intel?.name || null,
		network,
		age_minutes: createdSec ? Math.max(0, Math.round((Date.now() / 1000 - createdSec) / 60)) : null,
		market_cap_usd: num(coin?.usd_market_cap),
		liquidity_sol: liquiditySol,
		bonding_curve_progress_pct: gradPct,
		graduated: curve ? !!curve.complete : (coin?.complete ?? null),
		reference_buy_sol: buyQuote ? REFERENCE_BUY_SOL : null,
		reference_buy_price_impact_pct: buyQuote ? round2(buyQuote.priceImpact) : null,
		// Intelligence engine fingerprint (null when the engine hasn't observed it).
		quality_score: intel?.quality_score ?? null,
		organic_score: intel?.organic_score ?? null,
		bundle_score: intel?.bundle_score ?? null,
		concentration_top10_pct: intel?.concentration_top10 ?? null,
		fresh_wallet_ratio: intel?.fresh_wallet_ratio ?? null,
		unique_buyers: intel?.unique_buyers ?? null,
		dev_sold: intel?.dev_sold ?? null,
		narrative: intel?.narrative || null,
		risk_flags: intel?.risk_flags ?? [],
		outcome: intel?.outcome ?? null,
		// Smart money (reputation graph).
		smart_money_score: sm?.smart_money_score ?? null,
		smart_money_wallets: sm?.count ?? null,
		sybil_dominated: sm?.sybil_flag ?? null,
	};

	// Owner-only wallet context (also feeds the size clamp + action gate).
	const context = owner
		? {
				balanceSol,
				perTradeSol: tradeLimits.per_trade_sol,
				dailyBudgetSol: tradeLimits.daily_budget_sol,
				dailySpentSol,
				killSwitch: tradeLimits.kill_switch,
				frozen: spendLimits.frozen,
			}
		: {};
	if (owner) {
		signals.wallet_balance_sol = balanceSol;
		signals.per_trade_limit_sol = tradeLimits.per_trade_sol;
		signals.daily_budget_sol = tradeLimits.daily_budget_sol;
		signals.daily_spent_sol = dailySpentSol;
		signals.trading_paused = tradeLimits.kill_switch || spendLimits.frozen;
	}

	// True when literally nothing real is known — used to skip the LLM and answer
	// honestly rather than ask the model to opine on a void.
	const hasData = [signals.market_cap_usd, signals.liquidity_sol, signals.quality_score,
		signals.smart_money_score, signals.symbol, signals.reference_buy_price_impact_pct]
		.some((v) => v != null);

	return { signals, context, hasData };
}

const round3 = (n) => Math.round(n * 1e3) / 1e3;
const round2 = (n) => Math.round(n * 1e2) / 1e2;

async function handleRead(req, res, id) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const auth = await resolveAuth(req);
	const rl = auth?.userId
		? await limits.tradePerUser(auth.userId).catch(() => ({ success: true }))
		: await limits.publicIp(clientIp(req)).catch(() => ({ success: true }));
	if (rl && rl.success === false) return rateLimited(res, rl);

	const loaded = await loadAgent(id, auth?.userId);
	if (loaded.error) return error(res, loaded.error.status, loaded.error.code, loaded.error.msg);
	const { row, owner } = loaded;
	const meta = row.meta || {};

	const body = await readJson(req).catch(() => null);
	const network = netOf(body?.network);
	const mint = typeof body?.mint === 'string' ? body.mint.trim() : '';
	if (!BASE58_RE.test(mint)) return error(res, 422, 'invalid_mint', 'a valid token mint is required');
	if (owner && !meta.solana_address) return error(res, 409, 'no_wallet', 'this agent has no wallet yet');

	const agentName = row.name || 'Agent';
	const agentMeta = {
		id: row.id,
		name: agentName,
		voice_provider: row.voice_provider || 'browser',
		voice_id: row.voice_id || null,
		avatar_id: row.avatar_id || null,
	};

	let signals, context, hasData;
	try {
		({ signals, context, hasData } = await gatherSignals(mint, network, { agentId: id, meta, owner }));
	} catch (e) {
		return error(res, 502, 'signal_error', 'could not read live signals for this launch — try again');
	}

	// Nothing real to go on: answer honestly, no LLM, no invented confidence.
	if (!hasData) {
		const read = {
			verdict: 'pass',
			conviction: 0,
			suggested_size_sol: null,
			risks: ['No live data is available for this mint yet.'],
			cited_signals: [],
			spoken_line: `I can't read ${signals.symbol ? '$' + signals.symbol : 'this one'} yet — there's no live data in front of me, so I'm not going to pretend I have a call.`,
			hallucination_guard: { ok: true, suspicious_numbers: [], line_replaced: false },
		};
		return json(res, 200, {
			mint, network, agent: agentMeta, owner, signals, read,
			gate: { can_act: false, reason: owner ? 'no_data' : 'not_owner', message: 'No data to act on.' },
			grounded: true, source: 'no_data',
		}, { 'cache-control': 'no-store' });
	}

	const { system, user } = buildReadPrompt({ agentName, persona: row.persona_prompt, network, signals, owner });

	let completion;
	try {
		completion = await llmComplete({
			// Sonnet 5 thinks by default and max_tokens caps thinking + answer
			// together, so the budget carries headroom beyond the ~700-token read.
			system, user, maxTokens: 2000, anthropicModel: 'claude-sonnet-5', timeoutMs: 30_000,
			track: { userId: auth?.userId ?? null, agentId: id, tool: 'alpha_read' },
		});
	} catch (e) {
		if (e instanceof LlmUnavailableError || e?.code === 'llm_unavailable') {
			return error(res, 503, 'narrator_offline', 'The co-pilot narrator is offline right now. Your wallet and trading still work — try the read again shortly.');
		}
		if (e?.code === 'daily_spend_cap_exceeded') return error(res, 429, e.code, e.message);
		return error(res, 502, 'read_failed', 'The co-pilot could not complete this read. Try again.');
	}

	const raw = parseReadJson(completion.text);
	const { read, gate } = validateRead({ raw, signals, agentName, owner, context });

	return json(res, 200, {
		mint, network, agent: agentMeta, owner, signals, read, gate,
		grounded: read.hallucination_guard.ok,
		model: completion.model, provider: completion.provider,
		source: 'llm',
	}, { 'cache-control': 'no-store' });
}

// ── dispatch ────────────────────────────────────────────────────────────────────
export default wrap(async function handler(req, res, id, action) {
	if (action === 'candidates') return handleCandidates(req, res, id);
	if (action === 'read') return handleRead(req, res, id);
	if (cors(req, res, { methods: 'GET,POST,OPTIONS' })) return;
	return error(res, 404, 'not_found', 'unknown alpha sub-resource');
});
