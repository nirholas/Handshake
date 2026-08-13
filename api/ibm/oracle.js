// GET /api/ibm/oracle?token=<mint>|pool=<addr>[&timeframe=hour&aggregate=1]
// GET /api/ibm/oracle?list=trending
// --------------------------------------------------------------------------
// The Granite Oracle: forecasts a live Solana token's price with IBM Granite
// TimeSeries (watsonx.ai /ml/v1/time_series/forecast), narrates the result with
// Granite chat, and vets that narration with Granite Guardian — all real APIs.
//
// Candles come keyless from GeckoTerminal and are ALWAYS returned, so the 3D
// chart renders real history even when watsonx is not configured; the forecast,
// narration, and governance fields appear only when Granite is reachable.
import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { watsonxConfig, watsonxChatComplete } from '../_lib/watsonx.js';
import { watsonxForecast, forecastModelFor } from '../_lib/watsonx-forecast.js';
import { guardianConfig, assessRisk } from '../_lib/granite-guardian.js';
import { fetchOhlcv, topPoolForToken, trendingPools } from '../_lib/market/ohlcv.js';
import { marketUpstreamError } from '../_lib/market/upstream-error.js';

const isBase58 = (s) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
const isoOf = (unixSec) => new Date(unixSec * 1000).toISOString();

// Map a forecast %-change to an avatar emotion + sentiment in [-1, 1].
function moodFor(changePct) {
	const sentiment = Math.max(-1, Math.min(1, changePct / 15));
	let emotion = 'patience';
	if (changePct >= 8) emotion = 'celebration';
	else if (changePct >= 2) emotion = 'curiosity';
	else if (changePct <= -8) emotion = 'concern';
	else if (changePct <= -2) emotion = 'empathy';
	return { sentiment: Number(sentiment.toFixed(3)), emotion };
}

async function narrate(cfg, { name, symbol, currentPrice, stats }) {
	const dir = stats.changePct >= 0 ? 'higher' : 'lower';
	const system =
		'You are the embodied voice of an IBM Granite-powered market oracle inside a 3D scene. ' +
		'Given a token and a Granite TimeSeries price forecast, narrate it in exactly two short, ' +
		'vivid sentences a trader would respect. State the direction and magnitude. Do not give ' +
		'financial advice, do not use hashtags or emojis, and never invent numbers beyond those given.';
	const user =
		`Token: ${name} (${symbol}). Current price: $${currentPrice}. ` +
		`Granite TimeSeries forecasts the price moving ${dir} by ${stats.changePct.toFixed(1)}% ` +
		`over the next ${stats.horizonHours} hours (forecast low $${stats.forecastLow}, high $${stats.forecastHigh}). ` +
		`Narrate this forecast.`;
	const { text, model, usage } = await watsonxChatComplete(cfg, {
		messages: [
			{ role: 'system', content: system },
			{ role: 'user', content: user },
		],
		maxTokens: 160,
		temperature: 0.6,
	});
	return { text: (text || '').trim(), model, usage };
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	// Global hourly ceiling on the shared watsonx server key (same bucket as
	// api/watsonx/embed) — a hard aggregate cost cap independent of any one IP.
	// Only consumed when watsonx is configured, i.e. when a request can
	// actually bill Granite inference.
	if (watsonxConfig().configured) {
		const global = await limits.watsonxEmbedGlobal();
		if (!global.success)
			return rateLimited(res, global, 'watsonx capacity reached — try again shortly');
	}

	const params = new URL(req.url, 'http://x').searchParams;

	// ── Picker: trending Solana pools ────────────────────────────────────────
	if (params.get('list') === 'trending') {
		try {
			const pools = await trendingPools('solana', 8);
			return json(
				res,
				200,
				{ pools },
				{ 'cache-control': 'public, max-age=30, s-maxage=60' },
			);
		} catch (err) {
			return marketUpstreamError(res, err);
		}
	}

	// ── Resolve the pool to forecast ─────────────────────────────────────────
	const network = (params.get('network') || 'solana').trim();
	let pool = (params.get('pool') || '').trim();
	const token = (params.get('token') || '').trim();
	if (!pool && token) {
		if (!isBase58(token)) return error(res, 400, 'bad_token', 'token must be a base58 mint');
		try {
			pool = await topPoolForToken(token, network);
		} catch (err) {
			return marketUpstreamError(res, err);
		}
	}
	if (!pool || !isBase58(pool)) {
		return error(
			res,
			400,
			'bad_request',
			'provide ?pool=<addr> or ?token=<mint>, or ?list=trending',
		);
	}

	const timeframe = ['minute', 'hour', 'day'].includes(params.get('timeframe'))
		? params.get('timeframe')
		: 'hour';
	const aggregate = Math.max(1, Math.min(60, parseInt(params.get('aggregate') || '1', 10) || 1));

	// ── Real candles (keyless, always returned) ──────────────────────────────
	let candles, base, quote, freq;
	try {
		({ candles, base, quote, freq } = await fetchOhlcv({
			pool,
			network,
			timeframe,
			aggregate,
			limit: 1000,
		}));
	} catch (err) {
		return marketUpstreamError(res, err);
	}
	if (candles.length < 64) {
		return error(
			res,
			422,
			'insufficient_history',
			'not enough candle history to chart this pool',
		);
	}

	const tokenMeta = {
		name: base?.name || 'Token',
		symbol: base?.symbol || '',
		quoteSymbol: quote?.symbol || 'USD',
		pool,
		network,
	};
	const out = {
		token: tokenMeta,
		timeframe,
		aggregate,
		freq,
		history: candles.map((c) => ({ t: c.t, c: c.c })),
		forecast: null,
		stats: null,
		narration: null,
		governance: null,
		mood: null,
		ibm: { configured: false },
		generatedAt: new Date().toISOString(),
	};

	const cfg = watsonxConfig();
	if (!cfg.configured) {
		out.ibm = { configured: false, reason: 'WATSONX_API_KEY + project not set' };
		return json(res, 200, out, { 'cache-control': 'public, max-age=20, s-maxage=30' });
	}

	// ── Granite TimeSeries forecast ──────────────────────────────────────────
	// Fill the largest context window the history supports, then send exactly
	// that many points (TTM requires the input length to equal the model's context).
	const ctxLen = candles.length >= 1536 ? 1536 : candles.length >= 1024 ? 1024 : 512;
	if (candles.length < 512) {
		out.ibm = {
			configured: true,
			error: `need ≥512 candles for Granite TimeSeries, have ${candles.length}`,
		};
		return json(res, 200, out, { 'cache-control': 'public, max-age=20' });
	}
	const slice = candles.slice(-ctxLen);
	const timestamps = slice.map((c) => isoOf(c.t));
	const values = slice.map((c) => c.c);
	const forecastModel = forecastModelFor(ctxLen);

	try {
		const fc = await watsonxForecast(cfg, {
			model: forecastModel,
			timestamps,
			values,
			freq,
			targetColumn: 'price',
		});
		const forecast = fc.timestamps.map((iso, i) => ({
			t: Math.floor(Date.parse(iso) / 1000),
			c: Number(fc.values[i]),
		}));
		const currentPrice = values[values.length - 1];
		const forecastEnd = forecast[forecast.length - 1]?.c ?? currentPrice;
		const fVals = forecast.map((p) => p.c).filter(Number.isFinite);
		const stats = {
			currentPrice,
			forecastEnd,
			forecastLow: Math.min(...fVals),
			forecastHigh: Math.max(...fVals),
			changePct: ((forecastEnd - currentPrice) / currentPrice) * 100,
			direction:
				forecastEnd > currentPrice ? 'up' : forecastEnd < currentPrice ? 'down' : 'flat',
			horizonHours: timeframe === 'hour' ? forecast.length * aggregate : forecast.length,
		};
		out.forecast = forecast;
		out.stats = stats;
		out.mood = moodFor(stats.changePct);
		out.ibm = { configured: true, forecastModel: fc.model, inputWindow: fc.inputWindow };

		// ── Granite narration + Guardian governance (best-effort) ────────────
		try {
			const n = await narrate(cfg, {
				name: tokenMeta.name,
				symbol: tokenMeta.symbol,
				currentPrice: currentPrice.toPrecision(6),
				stats: {
					changePct: stats.changePct,
					horizonHours: stats.horizonHours,
					forecastLow: stats.forecastLow.toPrecision(6),
					forecastHigh: stats.forecastHigh.toPrecision(6),
				},
			});
			out.narration = { text: n.text, model: n.model };
			try {
				// Screen the narration with the canonical Granite Guardian client —
				// proper safety-agent framing + a real probability from logprobs.
				const g = await assessRisk(guardianConfig(), { risk: 'harm', input: n.text });
				out.governance = {
					passed: !g.flagged,
					risk: g.risk,
					label: g.label,
					probability: g.probability,
					confidence: g.confidence ?? null,
					model: g.model,
				};
			} catch (gErr) {
				out.governance = { passed: null, error: String(gErr.message || gErr) };
			}
		} catch (nErr) {
			out.narration = { text: '', error: String(nErr.message || nErr) };
		}
	} catch (fErr) {
		// Forecast failed (model gating, region, quota) — history still returns.
		out.ibm = { configured: true, error: String(fErr.message || fErr) };
	}

	return json(res, 200, out, { 'cache-control': 'public, max-age=20, s-maxage=30' });
});
