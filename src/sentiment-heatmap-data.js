// sentiment-heatmap-data.js — the data layer behind the 3D sentiment heatmap.
//
// Two halves:
//   1. Pure transforms (normalizeToken / momentumColor / diffSpikes / …) — no
//      DOM, no network, fully unit-tested. They turn a raw token from
//      /api/intel/heatmap into the { id, label, momentum, magnitude } the
//      renderer consumes, map momentum→colour, and diff successive polls to
//      surface movers.
//   2. createHeatmapPoller — a small polling loop over /api/intel/heatmap that
//      calls those transforms and reports { tokens, spikes, stale, error } to a
//      callback. Real fetches only.
//
// $THREE is always pinned first and flagged featured by the API; this layer
// preserves that ordering and never reorders the anchor away from the centre.

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// 24h price change (percent) that maps to full momentum saturation. A token up
// 25% or more reads as maximally hot; down 25% or more as maximally cold. Chosen
// so typical pump.fun daily swings spread across the ramp instead of clipping.
export const MOMENTUM_FULL_SCALE_PCT = 25;

// Map a raw API token to the render model. momentum ∈ [-1, 1] from 24h change;
// magnitude ∈ [0, 1] from 24h volume on a log scale (volume spans many orders of
// magnitude, so linear scaling would crush everything but the top token).
export function normalizeToken(raw, { maxLogVolume } = {}) {
	const change = Number.isFinite(raw?.change24h) ? raw.change24h : 0;
	const momentum = clamp(change / MOMENTUM_FULL_SCALE_PCT, -1, 1);

	const vol = Number.isFinite(raw?.volume24h) && raw.volume24h > 0 ? raw.volume24h : 0;
	const logVol = vol > 0 ? Math.log10(vol) : 0;
	// Normalise against the field's loudest token (passed in) so the busiest tile
	// is full-size and the rest scale relative to it. Falls back to a fixed
	// reference (10^7 ≈ $10M/day) when no field max is supplied.
	const ref = Number.isFinite(maxLogVolume) && maxLogVolume > 0 ? maxLogVolume : 7;
	const magnitude = clamp(logVol / ref, 0, 1);

	return {
		id: String(raw?.id || ''),
		label: String(raw?.symbol || raw?.name || (raw?.id ? `${raw.id.slice(0, 4)}…` : '?')),
		name: raw?.name || null,
		image: raw?.image || null,
		momentum,
		magnitude,
		change24h: change,
		priceUsd: Number.isFinite(raw?.priceUsd) ? raw.priceUsd : null,
		volume24h: vol,
		marketCap: Number.isFinite(raw?.marketCap) ? raw.marketCap : null,
		featured: !!raw?.featured,
		flow: raw?.flow || null,
	};
}

// Normalise a whole field at once: the volume reference is the field's own
// loudest tile, so the busiest token always renders at full magnitude.
export function normalizeField(rawTokens) {
	const list = Array.isArray(rawTokens) ? rawTokens : [];
	const maxLogVolume = list.reduce((m, t) => {
		const v = Number(t?.volume24h) || 0;
		return v > 0 ? Math.max(m, Math.log10(v)) : m;
	}, 0);
	return list.map((t) => normalizeToken(t, { maxLogVolume: maxLogVolume || 7 }));
}

// Perceptually-even cold→neutral→hot ramp, returned as { r, g, b } in [0, 1].
// momentum -1 → deep blue (cold), 0 → slate (neutral), +1 → green-hot. The mid
// anchor is a desaturated slate so a flat market reads as calm, not green.
const COLD = { r: 0.21, g: 0.42, b: 0.95 }; // -1
const NEUTRAL = { r: 0.32, g: 0.35, b: 0.42 }; // 0
const HOT = { r: 0.13, g: 0.92, b: 0.46 }; // +1
function lerpColor(a, b, t) {
	return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t };
}
export function momentumColor(momentum) {
	const m = clamp(Number(momentum) || 0, -1, 1);
	if (m < 0) return lerpColor(NEUTRAL, COLD, -m);
	return lerpColor(NEUTRAL, HOT, m);
}

// Emissive glow intensity for a tile: hotter/colder + louder = brighter. Neutral
// low-volume tiles barely glow; strong movers with real volume blaze.
export function glowIntensity(momentum, magnitude) {
	const m = Math.abs(clamp(Number(momentum) || 0, -1, 1));
	const v = clamp(Number(magnitude) || 0, 0, 1);
	return clamp(0.12 + m * 0.7 + v * 0.35, 0, 1.4);
}

// Diff a fresh field against the previous one. A spike = a token whose |momentum|
// jumped by at least `threshold` since the last poll (a real acceleration, not a
// steady trend). Returns movers sorted by absolute delta, biggest first, each
// tagged heating/cooling. New tokens entering the field with strong momentum also
// count. Pure — caller owns the "previous" snapshot.
export function diffSpikes(prev, next, threshold = 0.18) {
	const prevById = new Map((prev || []).map((t) => [t.id, t]));
	const spikes = [];
	for (const t of next || []) {
		const before = prevById.get(t.id);
		if (!before) {
			// Newly surfaced token — only a spike if it arrives already hot/cold.
			if (Math.abs(t.momentum) >= Math.max(threshold, 0.4)) {
				spikes.push({ ...t, delta: t.momentum, direction: t.momentum >= 0 ? 'heating' : 'cooling', fresh: true });
			}
			continue;
		}
		const delta = t.momentum - before.momentum;
		if (Math.abs(delta) >= threshold) {
			spikes.push({ ...t, delta, direction: delta >= 0 ? 'heating' : 'cooling', fresh: false });
		}
	}
	spikes.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
	return spikes;
}

// Rank movers for narration context: top gainers and losers by current momentum,
// plus the anchor ($THREE) always called out. Returns a compact object the
// narrator turns into a spoken line.
export function rankMovers(tokens, { count = 3 } = {}) {
	const list = (tokens || []).filter((t) => Number.isFinite(t.change24h));
	const byChange = [...list].sort((a, b) => b.change24h - a.change24h);
	const gainers = byChange.filter((t) => t.change24h > 0).slice(0, count);
	const losers = byChange.filter((t) => t.change24h < 0).reverse().slice(0, count);
	const anchor = (tokens || []).find((t) => t.featured) || null;
	const avg = list.length ? list.reduce((s, t) => s + t.momentum, 0) / list.length : 0;
	return { gainers, losers, anchor, avgMomentum: avg, total: (tokens || []).length };
}

const fmtPct = (n) => `${n >= 0 ? '+' : ''}${Number(n).toFixed(1)}%`;

// Build the compact, plain-language context handed to the brain for narration.
// Coin-agnostic for the field; $THREE is named because it is the anchor three.ws
// tracks. Never recommends or shills — describes observed market data only.
export function buildNarrationContext({ spikes, movers }) {
	const lines = [];
	if (movers?.anchor) {
		const a = movers.anchor;
		const parts = [`$THREE ${fmtPct(a.change24h)} 24h`];
		if (a.flow && Number.isFinite(a.flow.score)) {
			const mood = a.flow.score > 0.15 ? 'buyers leading' : a.flow.score < -0.15 ? 'sellers leading' : 'two-sided';
			const trades = (a.flow.buys24h || 0) + (a.flow.sells24h || 0);
			parts.push(`order flow ${mood} (${a.flow.buyPct}% buys of ${trades} trades 24h)`);
		}
		lines.push(parts.join(', '));
	}
	const climate =
		movers?.avgMomentum > 0.12 ? 'Heating across the board'
			: movers?.avgMomentum < -0.12 ? 'Cooling across the board'
				: 'Mixed tape';
	lines.push(`${climate} (${movers?.total ?? 0} tokens tracked).`);
	if (movers?.gainers?.length) {
		lines.push(`Top movers up: ${movers.gainers.map((t) => `${t.label} ${fmtPct(t.change24h)}`).join(', ')}.`);
	}
	if (movers?.losers?.length) {
		lines.push(`Down: ${movers.losers.map((t) => `${t.label} ${fmtPct(t.change24h)}`).join(', ')}.`);
	}
	if (spikes?.length) {
		const s = spikes[0];
		lines.push(`Just ${s.direction}: ${s.label} ${fmtPct(s.change24h)}.`);
	}
	return lines.join('\n');
}

// ── poller ───────────────────────────────────────────────────────────────────
// Polls /api/intel/heatmap on an interval, normalises, diffs for spikes, and
// reports to onUpdate. Holds the last good field so a transient fetch failure is
// surfaced as { stale, error } without dropping the rendered field.

export function createHeatmapPoller({
	endpoint = '/api/intel/heatmap',
	limit = 28,
	intervalMs = 20_000,
	spikeThreshold = 0.18,
	onUpdate,
	onError,
} = {}) {
	let prev = [];
	let timer = null;
	let stopped = false;
	let inFlight = false;

	async function poll() {
		if (inFlight || stopped) return;
		inFlight = true;
		try {
			const res = await fetch(`${endpoint}?limit=${encodeURIComponent(limit)}`, {
				headers: { accept: 'application/json' },
			});
			if (!res.ok) throw new Error(`heatmap ${res.status}`);
			const data = await res.json();
			if (stopped) return;
			const tokens = normalizeField(data?.tokens || []);
			const spikes = diffSpikes(prev, tokens, spikeThreshold);
			const movers = rankMovers(tokens);
			prev = tokens;
			onUpdate?.({ tokens, spikes, movers, stale: !!data?.stale, fetchedAt: data?.fetchedAt, error: null });
		} catch (err) {
			if (!stopped) onError?.(err);
		} finally {
			inFlight = false;
		}
	}

	function start() {
		stopped = false;
		poll();
		timer = setInterval(poll, intervalMs);
	}
	function stop() {
		stopped = true;
		if (timer) { clearInterval(timer); timer = null; }
	}
	function refresh() { return poll(); }

	return { start, stop, refresh };
}
