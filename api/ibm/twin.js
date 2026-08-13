// GET  /api/ibm/twin?token=<mint>|pool=<addr>[&timeframe=hour&aggregate=1]
// GET  /api/ibm/twin?list=trending
// POST /api/ibm/twin   { token|pool, network?, timeframe?, aggregate?, scenario }
// --------------------------------------------------------------------------
// The Digital Twin: a living virtual replica of a real Solana market. Unlike the
// one-shot Granite Oracle, the twin (1) mirrors its real-time vitals from live
// on-chain telemetry, (2) carries an IBM Granite TimeSeries model that projects
// its near future, (3) validates itself by back-testing that model against
// reality, and (4) lets you run real what-if simulations — perturbing the twin's
// recent history and re-forecasting so you can see how its trajectory bends.
//
// Candles come keyless from GeckoTerminal and are ALWAYS returned, so the twin's
// vitals + chart render from real history even when watsonx is not configured.
// The Granite projection, fidelity back-test, first-person persona, and Guardian
// governance appear only when watsonx.ai is reachable. There is no mock path: a
// scenario forecast is the real Granite model evaluating a transformed-but-real
// input series, clearly labelled as a counterfactual.
import { cors, json, method, wrap, readJson, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { watsonxConfig, watsonxChatComplete } from '../_lib/watsonx.js';
import { watsonxForecast, forecastModelFor } from '../_lib/watsonx-forecast.js';
import { guardianConfig, assessRisk } from '../_lib/granite-guardian.js';
import { fetchOhlcv, topPoolForToken, trendingPools } from '../_lib/market/ohlcv.js';
import {
	callMarket,
	isMarketUpstreamError,
	marketUpstreamError,
} from '../_lib/market/upstream-error.js';

const isBase58 = (s) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
const isoOf = (unixSec) => new Date(unixSec * 1000).toISOString();
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const HORIZON = 96; // every Granite TTM model forecasts 96 steps ahead

// ── Vitals: the twin's biometrics, computed from real OHLCV (no watsonx) ──────
function avg(arr) {
	return arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0;
}
function stddev(arr) {
	if (arr.length < 2) return 0;
	const m = avg(arr);
	return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1));
}
function logReturns(values) {
	const r = [];
	for (let i = 1; i < values.length; i++) {
		if (values[i - 1] > 0 && values[i] > 0) r.push(Math.log(values[i] / values[i - 1]));
	}
	return r;
}
function pctChange(from, to) {
	return from ? ((to - from) / from) * 100 : 0;
}

// Classify the twin's "state" from its vitals — drives hue + avatar emotion.
function twinState({ momentumPct, volatilityPct, activityRatio }) {
	if (activityRatio < 0.25) return { key: 'dormant', label: 'Dormant', emotion: 'patience' };
	if (volatilityPct >= 5) {
		return momentumPct >= 0
			? { key: 'euphoric', label: 'Euphoric', emotion: 'celebration' }
			: { key: 'stressed', label: 'Stressed', emotion: 'concern' };
	}
	if (momentumPct >= 3) return { key: 'ascending', label: 'Ascending', emotion: 'curiosity' };
	if (momentumPct <= -3) return { key: 'declining', label: 'Declining', emotion: 'empathy' };
	return { key: 'calm', label: 'Calm', emotion: 'patience' };
}

function computeVitals(candles) {
	const closes = candles.map((c) => c.c);
	const vols = candles.map((c) => (Number.isFinite(c.v) ? c.v : 0));
	const n = closes.length;
	const currentPrice = closes[n - 1];

	const momWindow = Math.min(24, n - 1);
	const momentumPct = pctChange(closes[n - 1 - momWindow], currentPrice);
	const dayWindow = Math.min(24, n - 1);
	const change24hPct = pctChange(closes[n - 1 - dayWindow], currentPrice);

	const volWindow = Math.min(48, n - 1);
	const volatilityPct = stddev(logReturns(closes.slice(-volWindow - 1))) * 100;

	const recentVol = avg(vols.slice(-6));
	const baseVol = avg(vols.slice(-Math.min(48, n))) || 1;
	const activityRatio = recentVol / baseVol;
	const heartbeatBpm = Math.round(clamp(60 * activityRatio, 28, 184));

	const priorVol = avg(vols.slice(-Math.min(48, n), -24)) || baseVol;
	const volumeTrendPct = pctChange(priorVol, avg(vols.slice(-24)) || baseVol);

	const state = twinState({ momentumPct, volatilityPct, activityRatio });
	return {
		currentPrice,
		momentumPct,
		change24hPct,
		volatilityPct,
		activityRatio,
		heartbeatBpm,
		liquidityUsd: baseVol,
		volumeTrendPct,
		// Normalised, viz-ready control signals in tidy ranges.
		signals: {
			trend: clamp(Math.tanh(momentumPct / 15), -1, 1),
			momentum: clamp(momentumPct / 30, -1, 1),
			volatility: clamp(volatilityPct / 8, 0, 1),
			activity: clamp(activityRatio / 2, 0, 1),
		},
		state,
	};
}

// ── Forecast helpers ─────────────────────────────────────────────────────────
// TTM requires the input length to equal the model's context window, so pick the
// largest window the history can fill and send exactly that many points.
function contextLenFor(historyLength) {
	if (historyLength >= 1536) return 1536;
	if (historyLength >= 1024) return 1024;
	return 512;
}

function pointsFrom(fc) {
	return fc.timestamps.map((iso, i) => ({
		t: Math.floor(Date.parse(iso) / 1000),
		c: Number(fc.values[i]),
	}));
}

function forecastStats(currentPrice, points, timeframe, aggregate) {
	const end = points[points.length - 1]?.c ?? currentPrice;
	const fv = points.map((p) => p.c).filter(Number.isFinite);
	return {
		currentPrice,
		end,
		low: Math.min(...fv),
		high: Math.max(...fv),
		changePct: pctChange(currentPrice, end),
		direction: end > currentPrice ? 'up' : end < currentPrice ? 'down' : 'flat',
		horizonHours: timeframe === 'hour' ? points.length * aggregate : points.length,
	};
}

// Mean absolute percentage error + a directional hit, comparing a back-test
// forecast against the candles that actually came to pass.
function fidelityOf(realized, predicted, cutoffPrice) {
	const k = Math.min(realized.length, predicted.length);
	let sumApe = 0;
	let cnt = 0;
	for (let i = 0; i < k; i++) {
		const a = realized[i].c;
		const p = predicted[i].c;
		if (a > 0 && Number.isFinite(p)) {
			sumApe += Math.abs((p - a) / a);
			cnt++;
		}
	}
	const mapePct = cnt ? (sumApe / cnt) * 100 : null;
	const realUp = realized[k - 1].c >= cutoffPrice;
	const predUp = predicted[k - 1].c >= cutoffPrice;
	return {
		mapePct,
		accuracyPct: mapePct == null ? null : clamp(100 - mapePct, 0, 100),
		directionalHit: realUp === predUp,
	};
}

// ── What-if scenario: a real, deterministic perturbation of the input tail ────
// Reshapes the last ~12% of the conditioning window, then the genuine Granite
// model projects forward from it. This is the twin's counterfactual, not a mock.
function clampScenario(raw = {}) {
	return {
		priceShockPct: clamp(Number(raw.priceShockPct) || 0, -90, 300),
		volatilityScale: clamp(Number(raw.volatilityScale) || 1, 0.1, 5),
		momentumFlip: Boolean(raw.momentumFlip),
	};
}
function scenarioLabel(s) {
	const parts = [];
	if (s.priceShockPct)
		parts.push(`${s.priceShockPct > 0 ? '+' : ''}${s.priceShockPct}% demand shock`);
	if (s.volatilityScale !== 1) parts.push(`${s.volatilityScale}× volatility`);
	if (s.momentumFlip) parts.push('momentum reversal');
	return parts.length ? parts.join(' · ') : 'baseline (no perturbation)';
}
function applyScenario(values, s) {
	const w = Math.min(values.length, Math.max(8, Math.round(values.length * 0.12)));
	const start = values.length - w;
	const windowMean = avg(values.slice(start));
	const anchor = values[start];
	const out = values.slice();
	for (let i = start; i < values.length; i++) {
		const f = (i - start) / Math.max(1, w - 1); // 0 → 1 ramp toward "now"
		let v = out[i];
		if (s.volatilityScale !== 1) v = windowMean + (v - windowMean) * s.volatilityScale;
		if (s.momentumFlip) v = anchor - (v - anchor); // mirror the recent move
		if (s.priceShockPct) v = v * (1 + (s.priceShockPct / 100) * f);
		out[i] = Math.max(v, 1e-12); // keep strictly positive for the model
	}
	return out;
}

// ── Granite persona: the twin narrates itself, governed by Guardian ──────────
async function narratePersona(cfg, system, user) {
	const { text, model } = await watsonxChatComplete(cfg, {
		messages: [
			{ role: 'system', content: system },
			{ role: 'user', content: user },
		],
		maxTokens: 170,
		temperature: 0.65,
	});
	return { text: (text || '').trim(), model };
}
async function governPersona(text) {
	const gcfg = guardianConfig();
	if (!gcfg.configured || !text) return null;
	try {
		const g = await assessRisk(gcfg, { risk: 'harm', input: text });
		return {
			passed: !g.flagged,
			risk: g.risk,
			label: g.label,
			probability: g.probability ?? null,
		};
	} catch (e) {
		return { passed: null, error: String(e.message || e) };
	}
}

const PERSONA_SYSTEM =
	'You are a Digital Twin: an embodied AI replica of a live crypto market on three.ws that ' +
	'speaks in the first person as the asset itself ("I"). You are given your own real vitals and ' +
	'an IBM Granite TimeSeries projection of your near future. Reply in exactly two short, vivid ' +
	'sentences. State how you feel (your state) and where Granite projects you are heading ' +
	'(direction, magnitude, horizon). No financial advice, no hashtags, no emojis, and never ' +
	'invent numbers beyond those you are given.';

// ── Shared series loader ──────────────────────────────────────────────────────
async function loadSeries(params) {
	const network = (params.network || 'solana').trim();
	let pool = (params.pool || '').trim();
	const token = (params.token || '').trim();
	if (!pool && token) {
		if (!isBase58(token))
			throw Object.assign(new Error('token must be a base58 mint'), {
				status: 400,
				code: 'bad_token',
			});
		pool = await callMarket(() => topPoolForToken(token, network));
	}
	if (!pool || !isBase58(pool)) {
		throw Object.assign(new Error('provide ?pool=<addr> or ?token=<mint>, or ?list=trending'), {
			status: 400,
			code: 'bad_request',
		});
	}
	const timeframe = ['minute', 'hour', 'day'].includes(params.timeframe)
		? params.timeframe
		: 'hour';
	const aggregate = clamp(parseInt(params.aggregate || '1', 10) || 1, 1, 60);
	const { candles, base, quote, freq } = await callMarket(() =>
		fetchOhlcv({ pool, network, timeframe, aggregate, limit: 1000 }),
	);
	if (candles.length < 64) {
		throw Object.assign(new Error('not enough candle history to model this pool'), {
			status: 422,
			code: 'insufficient_history',
		});
	}
	const token_ = {
		name: base?.name || 'Token',
		symbol: base?.symbol || '',
		quoteSymbol: quote?.symbol || 'USD',
		pool,
		network,
	};
	return { candles, token: token_, freq, timeframe, aggregate };
}

// ── GET: the live twin snapshot ───────────────────────────────────────────────
async function handleGet(req, res) {
	const params = Object.fromEntries(new URL(req.url, 'http://x').searchParams);

	if (params.list === 'trending') {
		const pools = await callMarket(() => trendingPools('solana', 8));
		return json(res, 200, { pools }, { 'cache-control': 'public, max-age=30, s-maxage=60' });
	}

	const { candles, token, freq, timeframe, aggregate } = await loadSeries(params);
	const vitals = computeVitals(candles);

	const out = {
		token,
		timeframe,
		aggregate,
		freq,
		history: candles.map((c) => ({ t: c.t, c: c.c })),
		vitals,
		projection: null,
		fidelity: null,
		persona: null,
		governance: null,
		ibm: { configured: false },
		generatedAt: new Date().toISOString(),
	};

	const cfg = watsonxConfig();
	if (!cfg.configured) {
		out.ibm = { configured: false, reason: 'WATSONX_API_KEY + project not set' };
		return json(res, 200, out, { 'cache-control': 'public, max-age=20, s-maxage=30' });
	}
	if (candles.length < 512) {
		out.ibm = {
			configured: true,
			error: `need ≥512 candles for Granite TimeSeries, have ${candles.length}`,
		};
		return json(res, 200, out, { 'cache-control': 'public, max-age=20' });
	}

	const ctxLen = contextLenFor(candles.length);
	const proj = candles.slice(-ctxLen);
	const projModel = forecastModelFor(ctxLen);

	// Back-test: forecast on the window ending HORIZON candles ago, then compare
	// against the candles that actually followed. Needs ctx + HORIZON of history.
	const canBacktest = candles.length >= ctxLen + HORIZON;
	const btSlice = canBacktest ? candles.slice(0, candles.length - HORIZON).slice(-ctxLen) : null;
	const realized = canBacktest ? candles.slice(candles.length - HORIZON) : null;

	try {
		const [projFc, btFc] = await Promise.all([
			watsonxForecast(cfg, {
				model: projModel,
				timestamps: proj.map((c) => isoOf(c.t)),
				values: proj.map((c) => c.c),
				freq,
				targetColumn: 'price',
			}),
			btSlice
				? watsonxForecast(cfg, {
						model: forecastModelFor(btSlice.length),
						timestamps: btSlice.map((c) => isoOf(c.t)),
						values: btSlice.map((c) => c.c),
						freq,
						targetColumn: 'price',
					}).catch(() => null)
				: Promise.resolve(null),
		]);

		const points = pointsFrom(projFc);
		const stats = forecastStats(vitals.currentPrice, points, timeframe, aggregate);
		out.projection = { points, stats, model: projFc.model };
		out.ibm = {
			configured: true,
			forecastModel: projFc.model,
			inputWindow: projFc.inputWindow,
		};

		if (btFc && realized) {
			const predicted = pointsFrom(btFc);
			const cutoffPrice = btSlice[btSlice.length - 1].c;
			const f = fidelityOf(realized, predicted, cutoffPrice);
			out.fidelity = {
				horizonHours: timeframe === 'hour' ? HORIZON * aggregate : HORIZON,
				mapePct: f.mapePct,
				accuracyPct: f.accuracyPct,
				directionalHit: f.directionalHit,
				cutoffPrice,
				realized: realized.map((c) => ({ t: c.t, c: c.c })),
				predicted,
				model: btFc.model,
			};
		}

		// First-person persona + Guardian governance (best-effort).
		try {
			const user =
				`I am the digital twin of ${token.name}${token.symbol ? ` (${token.symbol})` : ''}. ` +
				`My current price is $${vitals.currentPrice.toPrecision(6)}. My state is ${vitals.state.label} ` +
				`(momentum ${vitals.momentumPct.toFixed(1)}% over the last ${Math.min(24, candles.length)} bars, ` +
				`volatility ${vitals.volatilityPct.toFixed(2)}% per bar, activity ${vitals.activityRatio.toFixed(2)}× normal). ` +
				`IBM Granite TimeSeries projects my price moving ${stats.direction} by ${stats.changePct.toFixed(1)}% ` +
				`over the next ${stats.horizonHours} hours (low $${stats.low.toPrecision(6)}, high $${stats.high.toPrecision(6)}). ` +
				`Speak as me.`;
			const persona = await narratePersona(cfg, PERSONA_SYSTEM, user);
			out.persona = persona;
			out.governance = await governPersona(persona.text);
		} catch (pErr) {
			out.persona = { text: '', error: String(pErr.message || pErr) };
		}
	} catch (fErr) {
		out.ibm = { configured: true, error: String(fErr.message || fErr) };
	}

	return json(res, 200, out, { 'cache-control': 'public, max-age=20, s-maxage=30' });
}

// ── POST: a what-if simulation ────────────────────────────────────────────────
async function handlePost(req, res) {
	const body = await readJson(req);
	const { candles, token, freq, timeframe, aggregate } = await loadSeries(body);
	const scenario = clampScenario(body.scenario);
	const label = scenarioLabel(scenario);

	const out = {
		token,
		timeframe,
		aggregate,
		freq,
		scenario: { ...scenario, label },
		baseline: null,
		simulated: null,
		divergence: null,
		persona: null,
		governance: null,
		ibm: { configured: false },
		generatedAt: new Date().toISOString(),
	};

	const cfg = watsonxConfig();
	if (!cfg.configured) {
		out.ibm = { configured: false, reason: 'WATSONX_API_KEY + project not set' };
		return json(res, 200, out);
	}
	if (candles.length < 512) {
		out.ibm = {
			configured: true,
			error: `need ≥512 candles for Granite TimeSeries, have ${candles.length}`,
		};
		return json(res, 200, out);
	}

	const ctxLen = contextLenFor(candles.length);
	const slice = candles.slice(-ctxLen);
	const timestamps = slice.map((c) => isoOf(c.t));
	const baseValues = slice.map((c) => c.c);
	const simValues = applyScenario(baseValues, scenario);
	const model = forecastModelFor(ctxLen);

	try {
		const [baseFc, simFc] = await Promise.all([
			watsonxForecast(cfg, {
				model,
				timestamps,
				values: baseValues,
				freq,
				targetColumn: 'price',
			}),
			watsonxForecast(cfg, {
				model,
				timestamps,
				values: simValues,
				freq,
				targetColumn: 'price',
			}),
		]);

		const basePoints = pointsFrom(baseFc);
		const simPoints = pointsFrom(simFc);
		const baseStats = forecastStats(
			baseValues[baseValues.length - 1],
			basePoints,
			timeframe,
			aggregate,
		);
		const simStats = forecastStats(
			simValues[simValues.length - 1],
			simPoints,
			timeframe,
			aggregate,
		);

		out.baseline = { points: basePoints, stats: baseStats };
		out.simulated = { points: simPoints, stats: simStats };
		out.divergence = {
			changePctDelta: simStats.changePct - baseStats.changePct,
			endDeltaPct: pctChange(baseStats.end, simStats.end),
		};
		out.ibm = {
			configured: true,
			forecastModel: baseFc.model,
			inputWindow: baseFc.inputWindow,
		};

		try {
			const user =
				`I am the digital twin of ${token.name}${token.symbol ? ` (${token.symbol})` : ''}. ` +
				`A what-if scenario was applied to me: ${label}. In my baseline, IBM Granite TimeSeries projects ` +
				`me moving ${baseStats.direction} by ${baseStats.changePct.toFixed(1)}% over the next ${baseStats.horizonHours} hours. ` +
				`Under this scenario, Granite now projects me moving ${simStats.direction} by ${simStats.changePct.toFixed(1)}%. ` +
				`In exactly two sentences, speak as me about how this scenario reshapes my trajectory.`;
			const persona = await narratePersona(cfg, PERSONA_SYSTEM, user);
			out.persona = persona;
			out.governance = await governPersona(persona.text);
		} catch (pErr) {
			out.persona = { text: '', error: String(pErr.message || pErr) };
		}
	} catch (fErr) {
		out.ibm = { configured: true, error: String(fErr.message || fErr) };
	}

	return json(res, 200, out);
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	// Global hourly ceiling on the shared watsonx server key (same bucket as
	// api/watsonx/embed) — a hard aggregate cost cap independent of any one IP.
	// Only consumed when watsonx is configured; the keyless candles-only path
	// stays unaffected.
	if (watsonxConfig().configured) {
		const global = await limits.watsonxEmbedGlobal();
		if (!global.success)
			return rateLimited(res, global, 'watsonx capacity reached — try again shortly');
	}

	// A market-data outage is a third party's problem, not a bug here: answer it
	// with its real contract instead of letting a 502 reach wrap(), which would
	// log an unhandled 5xx, capture it to Sentry, and page ops once per request.
	// The handler's own validation errors and any genuine bug still bubble.
	try {
		if (req.method === 'POST') return await handlePost(req, res);
		return await handleGet(req, res);
	} catch (err) {
		if (isMarketUpstreamError(err)) return marketUpstreamError(res, err);
		throw err;
	}
});
