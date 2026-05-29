// Pump.fun live feed via PumpPortal public WebSocket.
// No Redis, no Solana RPC, no auth required.
// wss://pumpportal.fun/api/data — same source pumpkit tools use.
// Each mint event is enriched with SOL price + token metadata before emit.

import WebSocket from 'ws';

const PUMPPORTAL_WS = 'wss://pumpportal.fun/api/data';
const RECONNECT_DELAY_MS = 2_000;
const MAX_RECONNECTS = 5;

// Cross-emit dedupe by tx signature. PumpPortal can occasionally redeliver an
// event after a transient WS hiccup; this prevents duplicate cards.
const SEEN_SIG_LIMIT = 2_000;
const _seenSigs = new Map(); // sig → ts
function markSeen(sig) {
	if (!sig) return false;
	if (_seenSigs.has(sig)) return false;
	_seenSigs.set(sig, Date.now());
	if (_seenSigs.size > SEEN_SIG_LIMIT) {
		// Drop the oldest 25% — Map preserves insertion order.
		const drop = Math.floor(SEEN_SIG_LIMIT / 4);
		const it = _seenSigs.keys();
		for (let i = 0; i < drop; i++) _seenSigs.delete(it.next().value);
	}
	return true;
}
const META_TIMEOUT_MS = 2_500;
const SOL_PRICE_TTL_MS = 60_000;

// SOL price cache — one CoinGecko call per minute, shared across connections
let _solPrice = 0;
let _solPriceAt = 0;

async function getSolPrice() {
	if (Date.now() - _solPriceAt < SOL_PRICE_TTL_MS && _solPrice > 0) return _solPrice;
	try {
		const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
		const d = await r.json();
		const p = d?.solana?.usd;
		if (p > 0) { _solPrice = p; _solPriceAt = Date.now(); }
	} catch {}
	return _solPrice || 150;
}

// Token metadata cache — avoids re-fetching the same URI on reconnects
const _metaCache = new Map();

async function fetchMeta(uri) {
	if (!uri) return null;
	if (_metaCache.has(uri)) return _metaCache.get(uri);
	try {
		const ctrl = new AbortController();
		const tid = setTimeout(() => ctrl.abort(), META_TIMEOUT_MS);
		const r = await fetch(uri, { signal: ctrl.signal });
		clearTimeout(tid);
		if (!r.ok) return null;
		const d = await r.json();
		const meta = {
			description: d.description || null,
			twitter: d.twitter || null,
			telegram: d.telegram || null,
			website: d.website || null,
		};
		if (_metaCache.size > 500) _metaCache.clear();
		_metaCache.set(uri, meta);
		return meta;
	} catch { return null; }
}

/**
 * Connect to the PumpPortal WebSocket and stream pump.fun events.
 *
 * @param {object} opts
 * @param {(ev: { kind: 'mint'|'graduation'|'trade', data: object }) => void} opts.onEvent
 * @param {AbortSignal} [opts.signal] — abort to tear down the connection.
 * @param {'all'|'mint'|'graduation'|'trades'} [opts.kind='all'] — which event
 *   classes to subscribe to. `trades` requires `mints` (PumpPortal's
 *   subscribeTokenTrade is per-mint; there is no firehose for all trades).
 * @param {string[]} [opts.mints=[]] — token mints to stream buy/sell trades for.
 * @returns {Function} stop
 */
export function connectPumpFunFeed({ onEvent, signal, kind = 'all', mints = [] }) {
	let active = true;
	let ws = null;
	let reconnects = 0;
	let reconnectTimer = null;
	const tradeMints = Array.isArray(mints) ? mints.filter(Boolean) : [];
	const wantsTrades = (kind === 'all' || kind === 'trades') && tradeMints.length > 0;

	function stop() {
		active = false;
		clearTimeout(reconnectTimer);
		if (ws) try { ws.close(); } catch {}
	}

	signal?.addEventListener('abort', stop);

	function connect() {
		if (!active) return;
		ws = new WebSocket(PUMPPORTAL_WS);

		ws.on('open', () => {
			reconnects = 0;
			if (kind === 'all' || kind === 'mint') {
				ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
			}
			if (kind === 'all' || kind === 'graduation') {
				ws.send(JSON.stringify({ method: 'subscribeMigration' }));
			}
			if (wantsTrades) {
				ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: tradeMints }));
			}
		});

		ws.on('message', (raw) => {
			if (!active) return;
			let msg;
			try { msg = JSON.parse(raw.toString()); } catch { return; }
			if (msg.message) return; // ack

			if (msg.txType === 'create' && (kind === 'all' || kind === 'mint')) {
				if (!markSeen(msg.signature)) return;
				enrichMint(msg).then((data) => {
					pushBuffer('mint', data);
					if (active) onEvent({ kind: 'mint', data });
				}).catch((err) => {
					console.warn('[pumpportal-ws] mint enrich failed:', err?.message);
					const data = normalizeMint(msg, null, 0);
					pushBuffer('mint', data);
					if (active) onEvent({ kind: 'mint', data });
				});
			} else if ((msg.txType === 'migrate' || msg.txType === 'migration') && (kind === 'all' || kind === 'graduation')) {
				if (!markSeen(msg.signature)) return;
				enrichGrad(msg).then((data) => {
					pushBuffer('graduation', data);
					persistGraduation(data);
					if (active) onEvent({ kind: 'graduation', data });
				}).catch((err) => {
					console.warn('[pumpportal-ws] grad enrich failed:', err?.message);
					const data = normalizeGrad(msg);
					pushBuffer('graduation', data);
					persistGraduation(data);
					if (active) onEvent({ kind: 'graduation', data });
				});
			} else if ((msg.txType === 'buy' || msg.txType === 'sell') && wantsTrades) {
				if (!markSeen(msg.signature)) return;
				// Trades are high-frequency; enrich only with the cached SOL price
				// (no per-trade metadata fetch) so we never block the message loop.
				getSolPrice()
					.then((solPrice) => { if (active) onEvent({ kind: 'trade', data: normalizeTrade(msg, solPrice) }); })
					.catch(() => { if (active) onEvent({ kind: 'trade', data: normalizeTrade(msg, 0) }); });
			}
		});

		ws.on('error', (err) => console.warn('[pumpportal-ws] error:', err?.message));

		ws.on('close', () => {
			if (!active || reconnects >= MAX_RECONNECTS) return;
			reconnects++;
			reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
		});
	}

	connect();
	return stop;
}

async function enrichMint(d) {
	const [solPrice, meta] = await Promise.all([
		getSolPrice(),
		fetchMeta(d.uri),
	]);
	const base = normalizeMint(d, meta, solPrice);
	// Add creator history so mint cards can flag "10 launches, 0 graduated"
	// rugger profiles at a glance. Best-effort — if the creator endpoint
	// times out we keep the base card.
	try {
		const userCoins = d.traderPublicKey ? await fetchCreatorCoins(d.traderPublicKey) : null;
		if (Array.isArray(userCoins)) {
			base.creator_launches = userCoins.length;
			base.creator_graduated = userCoins.reduce((n, c) => n + (isGraduated(c) ? 1 : 0), 0);
			base.creator_tokens = userCoins
				.map((c) => ({
					mint: c.mint,
					symbol: c.symbol,
					name: c.name,
					mc: pickMc(c, solPrice),
					graduated: isGraduated(c),
				}))
				.filter((c) => c.symbol);
		}
	} catch (err) {
		console.warn('[pumpportal-ws] mint creator-history failed:', err?.message);
	}
	return base;
}

// USDC mint on Solana mainnet — used to flag USDC-paired pump.fun v2 coins
// when the upstream feed reports a non-WSOL quote_mint. We don't bother with a
// devnet branch here: PumpPortal only streams mainnet events.
const WSOL_MINT_STR = 'So11111111111111111111111111111111111111112';
const USDC_MINT_STR = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Classify the quote mint reported by PumpPortal. PumpPortal exposes the
// quote_mint field on v2 coins (post-May-21-2026 USDC launch); for legacy
// SOL-paired coins the field is absent or echoes WSOL. Returning a stable
// symbol lets the UI label trades/cards without each consumer reimplementing
// the same comparison.
function classifyQuote(quoteMintStr) {
	if (!quoteMintStr || quoteMintStr === WSOL_MINT_STR) {
		return { quote_mint: WSOL_MINT_STR, quote_symbol: 'SOL', is_usdc_pair: false };
	}
	if (quoteMintStr === USDC_MINT_STR) {
		return { quote_mint: USDC_MINT_STR, quote_symbol: 'USDC', is_usdc_pair: true };
	}
	return { quote_mint: quoteMintStr, quote_symbol: 'OTHER', is_usdc_pair: false };
}

function normalizeMint(d, meta, solPrice) {
	const mcSol = d.marketCapSol ?? 0;
	const quote = classifyQuote(d.quoteMint || d.quote_mint);
	return {
		mint: d.mint,
		name: d.name,
		symbol: d.symbol,
		creator: d.traderPublicKey,
		signature: d.signature,
		market_cap_sol: mcSol,
		market_cap_usd: solPrice > 0 ? mcSol * solPrice : null,
		initial_buy_sol: d.solAmount ?? null,
		initial_buy_usd: solPrice > 0 && d.solAmount ? d.solAmount * solPrice : null,
		// USDC-paired v2 coins report initial_buy in USDC base units (6-dec) on
		// the upstream `quoteAmount` / `usdcAmount` field. We surface both raw
		// quote in/out and a USD figure so downstream renderers can show "Y
		// USDC initial buy" without re-parsing the event.
		initial_buy_quote: d.quoteAmount ?? d.usdcAmount ?? null,
		initial_buy_usd_quote: quote.is_usdc_pair && (d.quoteAmount || d.usdcAmount)
			? Number(d.quoteAmount ?? d.usdcAmount)
			: null,
		sol_price: solPrice,
		bonding_curve: d.bondingCurveKey,
		image_uri: d.uri,
		description: meta?.description || null,
		twitter: meta?.twitter || null,
		telegram: meta?.telegram || null,
		website: meta?.website || null,
		created_at: Math.floor(Date.now() / 1000),
		...quote,
	};
}

function normalizeGrad(d) {
	const quote = classifyQuote(d.quoteMint || d.quote_mint);
	return {
		tx_signature: d.signature,
		signature: d.signature,
		mint: d.mint,
		name: d.name,
		symbol: d.symbol,
		pool: d.pool,
		timestamp: Math.floor(Date.now() / 1000),
		...quote,
	};
}

function normalizeTrade(d, solPrice = 0) {
	const quote = classifyQuote(d.quoteMint || d.quote_mint);
	const solAmount = typeof d.solAmount === 'number' ? d.solAmount : null;
	const mcSol = typeof d.marketCapSol === 'number' ? d.marketCapSol : null;
	const isBuy = d.txType === 'buy';
	return {
		signature: d.signature,
		tx_signature: d.signature,
		mint: d.mint,
		trader: d.traderPublicKey || null,
		// Preserve raw txType so consumers can branch on 'buy'/'sell' directly.
		txType: d.txType,
		tx_type: d.txType,
		is_buy: isBuy,
		token_amount: typeof d.tokenAmount === 'number' ? d.tokenAmount : null,
		// Both camelCase passthrough and snake_case so the avatar reaction buffer
		// (which reads solAmount ?? sol_amount ?? amount) and the dashboard agree.
		solAmount,
		sol_amount: solAmount,
		sol_value_usd: solAmount != null && solPrice > 0 ? solAmount * solPrice : null,
		market_cap_sol: mcSol,
		market_cap_usd: mcSol != null && solPrice > 0 ? mcSol * solPrice : null,
		sol_price: solPrice > 0 ? solPrice : null,
		pool: d.pool || null,
		bonding_curve: d.bondingCurveKey || null,
		timestamp: Math.floor(Date.now() / 1000),
		...quote,
	};
}

// ── graduation enrichment ────────────────────────────────────────────────────
//
// PumpPortal's migration message only carries {signature, mint, name, symbol,
// pool}. To render a rich card matching the desired feed format we resolve:
//   - coin metadata: usd_market_cap, market_cap_at_launch, created_timestamp,
//     description, creator from pump.fun's frontend coin endpoint
//   - creator history: total launches + best-token by market cap by listing
//     the creator's coins
// A short pump.fun coin TTL cache prevents hammering the endpoint when a
// migration shows up multiple times across reconnects, and per-fetch timeouts
// keep stalls bounded so a slow upstream can't pin the SSE worker.

const PUMPFUN_COIN_API = 'https://frontend-api-v3.pump.fun/coins';
const PUMPFUN_USER_COINS_API = 'https://frontend-api-v3.pump.fun/coins/user-created-coins';
const ENRICH_TIMEOUT_MS = 2_500;
const COIN_CACHE_TTL_MS = 30_000;
const _coinCache = new Map();
const _creatorCache = new Map();

async function fetchJsonWithTimeout(url, ms = ENRICH_TIMEOUT_MS) {
	const ctrl = new AbortController();
	const tid = setTimeout(() => ctrl.abort(), ms);
	try {
		const r = await fetch(url, {
			signal: ctrl.signal,
			headers: { 'accept': 'application/json', 'user-agent': 'three.ws-pumpfun-feed/1' },
		});
		if (!r.ok) return null;
		return await r.json();
	} catch { return null; } finally { clearTimeout(tid); }
}

async function fetchCoin(mint) {
	const hit = _coinCache.get(mint);
	if (hit && Date.now() - hit.t < COIN_CACHE_TTL_MS) return hit.v;
	const v = await fetchJsonWithTimeout(`${PUMPFUN_COIN_API}/${encodeURIComponent(mint)}`);
	if (_coinCache.size > 500) _coinCache.clear();
	_coinCache.set(mint, { t: Date.now(), v });
	return v;
}

async function fetchCreatorCoins(creator) {
	if (!creator) return null;
	const hit = _creatorCache.get(creator);
	if (hit && Date.now() - hit.t < COIN_CACHE_TTL_MS) return hit.v;
	const v = await fetchJsonWithTimeout(
		`${PUMPFUN_USER_COINS_API}/${encodeURIComponent(creator)}?offset=0&limit=50&includeNsfw=true`,
	);
	if (_creatorCache.size > 500) _creatorCache.clear();
	_creatorCache.set(creator, { t: Date.now(), v });
	return v;
}

function formatAge(createdAtMs) {
	if (!createdAtMs) return '';
	const s = Math.max(0, Math.floor((Date.now() - createdAtMs) / 1000));
	if (s < 60) return s + 's';
	const m = Math.floor(s / 60);
	if (m < 60) return m + 'm';
	const h = Math.floor(m / 60);
	if (h < 24) return h + 'h';
	return Math.floor(h / 24) + 'd';
}

function pickMc(c, solPrice) {
	if (typeof c?.usd_market_cap === 'number') return c.usd_market_cap;
	if (typeof c?.market_cap === 'number' && solPrice > 0) return c.market_cap * solPrice;
	return null;
}

function isGraduated(c) {
	return c?.complete === true || !!c?.raydium_pool || !!c?.pump_swap_pool;
}

async function enrichGrad(d) {
	const base = normalizeGrad(d);
	const mint = d.mint;
	if (!mint) return base;

	const [solPrice, coin] = await Promise.all([
		getSolPrice(),
		fetchCoin(mint),
	]);

	if (!coin) return base;

	const creator = coin.creator || d.traderPublicKey || null;
	const userCoins = creator ? await fetchCreatorCoins(creator) : null;

	const usdMc = pickMc(coin, solPrice);
	const launchSol = typeof coin.market_cap_at_launch === 'number' ? coin.market_cap_at_launch : null;
	const launchUsd = launchSol != null && solPrice > 0 ? launchSol * solPrice : null;

	// ATH: pump.fun frontend exposes ath_market_cap (USD) on some mints; fall
	// back to current MC as a floor so the renderer always has a value.
	const athUsd = typeof coin.ath_market_cap === 'number' ? coin.ath_market_cap
		: typeof coin.ath_market_cap_usd === 'number' ? coin.ath_market_cap_usd
		: usdMc;

	const createdMs = coin.created_timestamp ? Number(coin.created_timestamp) : null;
	const age = formatAge(createdMs);

	let creatorTokens = [];
	let launches = null;
	let creatorGraduated = null;
	if (Array.isArray(userCoins)) {
		launches = userCoins.length;
		creatorGraduated = userCoins.reduce((n, c) => n + (isGraduated(c) ? 1 : 0), 0);
		creatorTokens = userCoins
			.map((c) => ({
				mint: c.mint,
				symbol: c.symbol,
				name: c.name,
				mc: pickMc(c, solPrice),
				graduated: isGraduated(c),
			}))
			.filter((c) => c.symbol);
	}

	// Migration `solAmount` is the most accurate "graduation deposit" number.
	// If absent (PumpPortal sometimes omits), fall back to the real_sol_reserves
	// at graduation (≈ 85 SOL bonding-curve floor).
	const amountSol = typeof d.solAmount === 'number' ? d.solAmount
		: typeof coin.real_sol_reserves === 'number' && coin.real_sol_reserves > 0
			? coin.real_sol_reserves / 1e9
			: null;
	const amountUsd = amountSol != null && solPrice > 0 ? amountSol * solPrice : null;

	const graduated = isGraduated(coin);
	const raydiumPool = coin.raydium_pool || null;
	const pumpSwapPool = coin.pump_swap_pool || null;

	// Pump.fun's v3 frontend API surfaces `quote_mint` on coins launched after
	// the v2 / USDC rollout. When present it's the authoritative on-chain
	// quote — override what we guessed from the WS event so AMM-paired
	// USDC coins render correctly even if PumpPortal omits the field on the
	// migrate event.
	const coinQuote = classifyQuote(coin.quote_mint || coin.quoteMint || base.quote_mint);

	return {
		...base,
		...coinQuote,
		name: coin.name || base.name,
		symbol: coin.symbol || base.symbol,
		description: coin.description || null,
		creator,
		creator_username: coin.username || null,
		creator_profile_image: coin.profile_image || null,
		image_uri: coin.image_uri || null,
		video_uri: coin.video_uri || null,
		twitter: coin.twitter || null,
		telegram: coin.telegram || null,
		website: coin.website || null,
		usd_market_cap: usdMc,
		market_cap: usdMc,
		market_cap_usd_initial: launchUsd,
		market_cap_at_launch: launchSol,
		ath_market_cap: athUsd,
		sol_price: solPrice || null,
		created_at: createdMs ? Math.floor(createdMs / 1000) : null,
		age,
		amount_sol: amountSol,
		amount_usd: amountUsd,
		bonding_curve_pct: 100,
		complete: graduated,
		raydium_pool: raydiumPool,
		pump_swap_pool: pumpSwapPool,
		reply_count: typeof coin.reply_count === 'number' ? coin.reply_count : null,
		creator_launches: launches,
		creator_graduated: creatorGraduated,
		creator_tokens: creatorTokens,
	};
}

// ── Process-local replay buffer ──────────────────────────────────────────────
//
// The PumpPortal WS connection is shared per Vercel instance. We keep a small
// rolling buffer of the most-recent enriched mint and graduation events so each
// new SSE client (which would otherwise see a blank feed until the next event)
// can immediately render a contextual backlog. Buffered events are emitted with
// a `replay: true` marker so the UI can dim them.

const BUFFER_LIMIT = { mint: 25, graduation: 25 };
const _buffer = { mint: [], graduation: [] };

function pushBuffer(kind, data) {
	const arr = _buffer[kind];
	if (!arr) return;
	const sig = data?.signature || data?.tx_signature;
	if (sig && arr.some((e) => (e.signature || e.tx_signature) === sig)) return;
	arr.unshift(data);
	while (arr.length > BUFFER_LIMIT[kind]) arr.pop();
}

/**
 * Snapshot of recently buffered events, newest-first. Caller filters by kind.
 * @param {{ kind?: 'all'|'mint'|'graduation'|'claims', limit?: number }} opts
 */
export function recentBuffered({ kind = 'all', limit = 10 } = {}) {
	const out = [];
	if (kind === 'all' || kind === 'mint') {
		for (const data of _buffer.mint.slice(0, limit)) out.push({ kind: 'mint', data });
	}
	if (kind === 'all' || kind === 'graduation' || kind === 'claims') {
		for (const data of _buffer.graduation.slice(0, limit)) out.push({ kind: 'graduation', data });
	}
	// Sort by timestamp/created_at descending so a multi-kind replay is interleaved.
	out.sort((a, b) => {
		const ta = a.data.timestamp || a.data.created_at || 0;
		const tb = b.data.timestamp || b.data.created_at || 0;
		return tb - ta;
	});
	return out.slice(0, limit);
}

// ── Persistence ──────────────────────────────────────────────────────────────
//
// Writing graduations to Postgres lets a fresh container backfill from real
// history rather than the in-memory buffer (which dies on every cold start).
// The DB write is fire-and-forget — we never block the SSE stream on it. If
// DATABASE_URL isn't configured (dev), the import is lazy so we don't fail.

let _sqlPromise = null;
async function getSql() {
	if (_sqlPromise) return _sqlPromise;
	_sqlPromise = import('./db.js').then((m) => m.sql).catch((err) => {
		console.warn('[pumpportal-ws] db import failed:', err?.message);
		return null;
	});
	return _sqlPromise;
}

async function persistGraduation(data) {
	if (!data?.tx_signature && !data?.signature) return;
	const sql = await getSql();
	if (!sql) return;
	try {
		const sig = data.tx_signature || data.signature;
		const finite = (n) => (typeof n === 'number' && Number.isFinite(n) ? n : null);
		await sql`
			insert into pumpfun_graduations (
				tx_signature, mint, name, symbol, creator, pool, raydium_pool, pump_swap_pool,
				market_cap_usd, market_cap_usd_initial, ath_market_cap,
				amount_sol, amount_usd, sol_price, image_uri, description,
				twitter, telegram, website, creator_launches, creator_graduated, payload
			) values (
				${sig}, ${data.mint || null}, ${data.name || null}, ${data.symbol || null},
				${data.creator || null}, ${data.pool || null}, ${data.raydium_pool || null},
				${data.pump_swap_pool || null},
				${finite(data.usd_market_cap ?? data.market_cap)},
				${finite(data.market_cap_usd_initial)},
				${finite(data.ath_market_cap)},
				${finite(data.amount_sol)},
				${finite(data.amount_usd)},
				${finite(data.sol_price)},
				${data.image_uri || null}, ${data.description || null},
				${data.twitter || null}, ${data.telegram || null}, ${data.website || null},
				${Number.isFinite(data.creator_launches) ? data.creator_launches : null},
				${Number.isFinite(data.creator_graduated) ? data.creator_graduated : null},
				${JSON.stringify(data)}::jsonb
			)
			on conflict (tx_signature) do nothing
		`;
	} catch (err) {
		// Don't take down the feed if a single write fails (e.g. transient
		// Neon timeout). Log once and move on.
		console.warn('[pumpportal-ws] persist failed:', err?.message);
	}
}

/**
 * Read recent graduations from Postgres. Falls back to the in-memory ring
 * buffer when the DB is unreachable so dev/test environments still work.
 * Used by the HTTP backfill endpoint and as a warmup source on cold start.
 *
 * @param {{ limit?: number }} opts
 * @returns {Promise<Array<object>>} newest-first array of graduation payloads.
 */
export async function recentGraduations({ limit = 20 } = {}) {
	const cap = Math.max(1, Math.min(100, limit | 0 || 20));
	try {
		const sql = await getSql();
		if (sql) {
			const rows = await sql`
				select payload, seen_at
				from pumpfun_graduations
				order by seen_at desc
				limit ${cap}
			`;
			if (Array.isArray(rows) && rows.length) {
				return rows.map((r) => ({ ...r.payload, _seen_at: r.seen_at }));
			}
		}
	} catch (err) {
		console.warn('[pumpportal-ws] recentGraduations db read failed:', err?.message);
	}
	// Buffer fallback (dev / DB outage).
	return _buffer.graduation.slice(0, cap);
}
