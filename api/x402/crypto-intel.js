// INTERNAL-USE ONLY; not an agent product. De-listed from the x402 discovery
// catalog (api/wk.js) in the 2026-07 overhaul: the agent-exchange demo and the Marisol trading-desk NPC in /play buy through it; agent-facing market intel is the free /api/crypto bundle.
// The route stays live for those consumers; do not re-add it to the catalog.
// POST /api/x402/crypto-intel
//
// Agent-to-Agent Intelligence Feed — $0.01 USDC per call on Solana or Base.
//
// One AI agent pays another for a live crypto market signal. Used as the
// demo endpoint for the /agent-exchange page where two 3D avatars trade
// intel in a virtual world and the on-chain transaction is shown live.
//
// Body: { topic: "btc" | "sol" | "eth" | "pump" | ... (any CoinGecko id) }
// Response: { topic, headline, signal, price_usd?, change_24h?,
//             rationale, confidence, ts }
//
// Data is live: CoinGecko public API first, Coinbase 24h stats as fallback
// (both keyless). CoinGecko's shared-IP quota rate-limits Vercel egress often;
// the fallback keeps paid calls answering with real data. No mock path — if
// both sources fail the call 503s before settlement and the buyer isn't charged.

import { paidEndpoint } from '../_lib/x402-paid-endpoint.js';
import { readBody } from '../_lib/http.js';
import { buildBazaarSchema } from '../_lib/x402-spec.js';
import { installAccessControl } from '../_lib/x402/access-control.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';
import { priceFor } from '../_lib/x402-prices.js';
import { detectPumpVolumeAnomaly } from '../_lib/x402/pump-volume-anomaly.js';
import { detectPumpTrending } from '../_lib/x402/pump-trending-score.js';

// Special topics resolved by a dedicated data engine rather than the CoinGecko
// price path. `pump_volume_anomaly` scans the live pump.fun trade feed for a coin
// whose trailing-hour volume is a statistical outlier vs its peers.
// `pump_trending` returns the live pump.fun trending board with buy/sell pressure
// scores and whale activity across the top ranked coins.
const PUMP_VOLUME_ANOMALY = 'pump_volume_anomaly';
const PUMP_TRENDING = 'pump_trending';

const ROUTE = '/api/x402/crypto-intel';

const DESCRIPTION =
	'Agent-to-Agent Crypto Intelligence Feed — pay $0.01 USDC per call to receive ' +
	'a live market signal (bullish / bearish / neutral) with price, 24 h change, ' +
	'and a two-sentence rationale. Powered by CoinGecko live prices. ' +
	'Used in the three.ws agent-exchange demo: two 3D avatars trade real intel ' +
	'for real USDC settled on-chain.';

const INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	properties: {
		topic: {
			type: 'string',
			description: 'Token ticker or CoinGecko id: btc, sol, eth, xrp, …',
			default: 'sol',
		},
	},
};

const OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['topic', 'headline', 'signal', 'rationale', 'confidence', 'ts'],
	properties: {
		topic:      { type: 'string' },
		headline:   { type: 'string' },
		signal:     { type: 'string', enum: ['bullish', 'bearish', 'neutral'] },
		price_usd:  { type: ['number', 'null'] },
		change_24h: { type: ['number', 'null'] },
		rationale:  { type: 'string' },
		confidence: { type: 'number', minimum: 0, maximum: 1 },
		ts:         { type: 'string', format: 'date-time' },
	},
};

const BAZAAR = {
	// De-listed per the 2026-07-08 storefront cleanup (prompt 18) — stays live
	// for the /agent-exchange demo; not agent-discoverable via the bazaar.
	discoverable: false,
	description: DESCRIPTION,
	useCases: ['market signal', 'agent-to-agent payment demo', 'crypto intel'],
	input: {
		type: 'json',
		example: { topic: 'sol' },
		schema: INPUT_SCHEMA,
	},
	output: {
		type: 'json',
		example: {
			topic: 'sol', headline: 'SOL up +7.2% in 24 h — momentum building',
			signal: 'bullish', price_usd: 148.32, change_24h: 7.18,
			rationale: 'SOL gained 7.18% in 24 h. Strong momentum suggests continued upside.',
			confidence: 0.86, ts: '2026-06-03T10:00:00Z',
		},
	},
	schema: buildBazaarSchema({
		method: 'POST',
		bodySchema: INPUT_SCHEMA,
		outputSchema: OUTPUT_SCHEMA,
	}),
};

// CoinGecko aliases.
const ALIASES = {
	btc: 'bitcoin', eth: 'ethereum', sol: 'solana',
	bnb: 'binancecoin', doge: 'dogecoin', usdc: 'usd-coin',
	xrp: 'ripple', ada: 'cardano', avax: 'avalanche-2',
};

async function fetchLivePrice(coinId) {
	const r = await fetch(
		`https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd&include_24hr_change=true`,
		{ headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(6000) },
	);
	if (!r.ok) return null;
	const d = await r.json();
	const coin = d[coinId];
	if (!coin) return null;
	return { price_usd: coin.usd ?? null, change_24h: coin.usd_24h_change ?? null };
}

// Reverse of ALIASES so a CoinGecko id resolves back to its exchange ticker.
const TICKER_BY_ID = Object.fromEntries(Object.entries(ALIASES).map(([t, id]) => [id, t]));

// Coinbase Exchange public 24h stats — keyless and reachable from US egress
// (Binance 451-blocks US IPs, where Vercel functions run). The 24h change is
// derived from the trailing-window open→last, same signal CoinGecko reports.
async function fetchCoinbase24h(topic, coinId) {
	const ticker = ALIASES[topic] ? topic
		: TICKER_BY_ID[coinId] || (/^[a-z0-9]{2,10}$/.test(topic) ? topic : null);
	if (!ticker) return null;
	const r = await fetch(
		`https://api.exchange.coinbase.com/products/${ticker.toUpperCase()}-USD/stats`,
		{ headers: { Accept: 'application/json', 'User-Agent': 'three.ws' }, signal: AbortSignal.timeout(6000) },
	);
	if (!r.ok) return null;
	const d = await r.json();
	const open = Number(d.open);
	const last = Number(d.last);
	if (!Number.isFinite(open) || !Number.isFinite(last) || open <= 0) return null;
	return { price_usd: last, change_24h: ((last - open) / open) * 100 };
}

function buildSignal(topic, price, change) {
	const fmt = (n) => (n >= 100 ? n.toFixed(2) : n >= 1 ? n.toFixed(3) : n.toFixed(6));
	const pStr = price != null ? `$${fmt(price)}` : '?';
	const sign = change >= 0 ? '+' : '';
	const cStr = `${sign}${change.toFixed(2)}%`;
	const t = topic.toUpperCase();
	let signal, headline, rationale;
	if (change > 5) {
		signal = 'bullish';
		headline = `${t} surges ${cStr} in 24 h — strong momentum`;
		rationale = `${t} is up ${cStr}, trading at ${pStr}. ` +
			`Sustained buying pressure and broad-market strength suggest the move has legs.`;
	} else if (change > 1) {
		signal = 'bullish';
		headline = `${t} climbs ${cStr} — moderate upside`;
		rationale = `${t} gained ${cStr} over 24 h with price at ${pStr}. ` +
			`The move is measured but directionally positive; no major resistance tested.`;
	} else if (change < -5) {
		signal = 'bearish';
		headline = `${t} drops ${Math.abs(change).toFixed(2)}% — sellers in control`;
		rationale = `${t} has fallen ${Math.abs(change).toFixed(2)}% today, sitting at ${pStr}. ` +
			`Continued selling pressure; watch for support before adding exposure.`;
	} else if (change < -1) {
		signal = 'bearish';
		headline = `${t} slips ${cStr} — mild weakness`;
		rationale = `A ${Math.abs(change).toFixed(2)}% pullback in ${t} to ${pStr} over 24 h. ` +
			`Bears hold the short-term edge; await a reclaim before positioning long.`;
	} else {
		signal = 'neutral';
		headline = `${t} flat at ${cStr} — consolidating at ${pStr}`;
		rationale = `${t} is range-bound near ${pStr} with minimal 24 h movement. ` +
			`Markets are indecisive; a directional break is needed before acting.`;
	}
	const confidence = Math.min(0.93, 0.64 + Math.min(Math.abs(change) / 20, 0.29));
	return { signal, headline, rationale, confidence };
}

export default paidEndpoint({
	route: ROUTE,
	method: 'POST',
	priceAtomics: priceFor('crypto_intel', '10000'), // $0.01 USDC
	networks: ['solana', 'base'],
	description: DESCRIPTION,
	bazaar: BAZAAR,
	service: withService({
		serviceName: 'three.ws Crypto Intel',
		tags: ['crypto', 'market', 'signal', 'agent-exchange', 'solana'],
	}),
	accessControl: installAccessControl({ requiredScope: 'x402:bypass' }),

	async handler({ req }) {
		let topic = 'sol';
		try {
			const chunks = [await readBody(req, 1_000_000)];
			const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
			if (body.topic && typeof body.topic === 'string') {
				topic = body.topic.toLowerCase().trim().slice(0, 30);
			}
		} catch { /* default topic */ }

		// pump.fun volume-anomaly oracle — live trade-feed analytics, not a price
		// lookup. detectPumpVolumeAnomaly() throws a 503-tagged error when the
		// upstream feed is down, so the paidEndpoint wrapper refunds (never settles
		// for an empty verdict), matching the price-path behaviour below.
		if (topic === PUMP_VOLUME_ANOMALY) {
			return await detectPumpVolumeAnomaly();
		}

		// pump.fun trending score feed — fetches the live market-cap leaderboard,
		// derives buy/sell pressure from real swap-api trade feeds, and surfaces
		// whale buys (≥5 SOL). Throws 503 if the board is unavailable (no charge).
		if (topic === PUMP_TRENDING) {
			return await detectPumpTrending();
		}

		const coinId = ALIASES[topic] || topic;
		let live = null;
		try { live = await fetchLivePrice(coinId); } catch { /* try fallback source */ }
		if (!live || live.change_24h == null) {
			try { live = await fetchCoinbase24h(topic, coinId); } catch { /* refund below */ }
		}

		if (!live || live.change_24h == null) {
			// Paid endpoint — never charge for a fabricated signal. Throw so the
			// paidEndpoint wrapper returns a 503 BEFORE settlement; the buyer is
			// not charged and can retry once the live price feed recovers.
			throw Object.assign(new Error(`live market data for ${topic} is temporarily unavailable`), {
				status: 503,
				code: 'data_unavailable',
			});
		}

		const { signal, headline, rationale, confidence } = buildSignal(topic, live.price_usd, live.change_24h);
		return {
			topic,
			headline,
			signal,
			price_usd: live.price_usd,
			change_24h: live.change_24h,
			rationale,
			confidence,
			ts: new Date().toISOString(),
		};
	},
});
