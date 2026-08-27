/**
 * Canonical wallet → net-worth state, and the pure real-data → visual mapping
 * that drives the Net-Worth-Reactive Avatar (the agent that wears its wallet).
 *
 * This is the single source of truth for "how much is this agent's wallet worth,
 * what is it made of, and therefore how should its 3D body look." Every surface
 * (the avatar viewer, agent detail, marketplace, the galaxy, cards) reads the
 * SAME numbers from here and applies the SAME mapping, so a given wallet state
 * renders an identical avatar treatment everywhere.
 *
 * Everything is real chain data:
 *   - SOL balance + SPL holdings come from the agent's own public endpoints
 *     (GET /api/agents/:id/solana and /solana/holdings), the same contract the
 *     wallet hub uses — we never refetch differently per surface.
 *   - USD values are priced from the live Jupiter feed (SOL + every held mint in
 *     one call). Unpriced tokens contribute $0 — we never invent a price.
 *
 * The visual mapping (`computeWalletVisual`) is a PURE function of that real
 * state: change the wallet, the look changes; there is no random and no decay
 * timer. An empty wallet maps to a clean dormant baseline, never a broken or
 * ugly state. A whale balance is capped so the effect stays tasteful.
 *
 * $THREE is the only coin this platform names or features. Other holdings only
 * influence the look generically, by their real USD proportion — never by name.
 */

import { getSolPriceUsd, getTokenPriceUsd } from './usd-price.js';

// $THREE — the only coin three.ws features. Holding it earns the brand accent.
export const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

// Wrapped SOL mint — used only to price native SOL through the same feed call.
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

// USDC mints per cluster (dollar-pegged; valued 1:1 without a quote).
const USDC_MINT_BY_CLUSTER = {
	mainnet: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
	devnet: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
};

const JUP_PRICE_URL = 'https://lite-api.jup.ag/price/v3';
// A wallet card must not wait on a stalled price feed; unpriced reads as $0.
const PRICE_TIMEOUT_MS = 5_000;
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// ── Tiers ───────────────────────────────────────────────────────────────────
// Honest, fixed USD thresholds. The avatar's "presence" steps up through these
// as real value crosses each line. `level` (0–5) is the single intensity knob.
// Names evoke a body that glows brighter as it earns — dormant → luminous.
export const NETWORTH_TIERS = [
	{ key: 'dormant',  label: 'Dormant',  level: 0, min: 0 },
	{ key: 'spark',    label: 'Spark',    level: 1, min: 1 },
	{ key: 'ember',    label: 'Ember',    level: 2, min: 25 },
	{ key: 'glow',     label: 'Glow',     level: 3, min: 250 },
	{ key: 'radiant',  label: 'Radiant',  level: 4, min: 2_500 },
	{ key: 'luminous', label: 'Luminous', level: 5, min: 25_000 },
];

/** Map a real USD net worth to its tier descriptor. `dormant` for 0 / empty. */
export function tierForUsd(usd) {
	const v = Number(usd);
	if (!Number.isFinite(v) || v <= 0) return NETWORTH_TIERS[0];
	let out = NETWORTH_TIERS[0];
	for (const t of NETWORTH_TIERS) if (v >= t.min) out = t;
	return out;
}

// ── Data fetch + normalize ──────────────────────────────────────────────────

/** Resolve an agent id from any record shape the surfaces hold. */
export function agentIdOf(agent) {
	if (!agent) return null;
	return agent.agent_id || agent.agentId || agent.id || null;
}

/** Read the agent's Solana address from any supported record shape. */
export function addressOf(agent) {
	if (!agent || typeof agent !== 'object') return null;
	const meta = agent.meta || {};
	const a =
		agent.solana_address || meta.solana_address || agent.agent_solana_address ||
		(typeof agent.wallet === 'string' && BASE58_RE.test(agent.wallet) ? agent.wallet : null) ||
		null;
	return a && BASE58_RE.test(String(a)) ? String(a) : null;
}

/**
 * Price a set of mints in one Jupiter call. USDC resolves to exactly $1 without
 * a network round-trip. Returns a Map<mint, usdPricePerToken>. Missing/failed
 * prices are simply absent (caller treats them as $0 — never invented).
 */
async function priceMints(mints, network) {
	const usdc = USDC_MINT_BY_CLUSTER[network] || USDC_MINT_BY_CLUSTER.mainnet;
	const out = new Map();
	const need = [];
	for (const m of mints) {
		if (m === usdc) out.set(m, 1);
		else need.push(m);
	}
	if (!need.length) return out;
	// One batched Jupiter call is the cheap path (a whole wallet in one request).
	// Anything it does not price falls back to the shared per-mint chain
	// (DexScreener, GeckoTerminal, DefiLlama), so a Jupiter outage or a token it
	// has never indexed no longer silently reports a funded wallet as $0.
	let priced = new Set();
	try {
		const r = await fetch(`${JUP_PRICE_URL}?ids=${encodeURIComponent(need.join(','))}`, {
			signal: AbortSignal.timeout(PRICE_TIMEOUT_MS),
		});
		if (r.ok) {
			const data = await r.json();
			for (const m of need) {
				const p = data?.[m]?.usdPrice ?? data?.[m]?.price ?? null;
				if (Number(p) > 0) {
					out.set(m, Number(p));
					priced.add(m);
				}
			}
		}
	} catch {
		/* batch feed down: every mint falls through to the per-mint chain below */
	}
	const missing = need.filter((m) => !priced.has(m));
	if (missing.length) {
		const resolved = await Promise.all(missing.map((m) => getTokenPriceUsd(m).catch(() => null)));
		missing.forEach((m, i) => {
			if (Number(resolved[i]) > 0) out.set(m, Number(resolved[i]));
		});
	}
	return out;
}

/**
 * Fetch and normalize an agent's full wallet state into the canonical contract
 * every surface consumes. Real data only; no throw on a soft failure — returns a
 * coherent dormant/partial state the UI can render cleanly.
 *
 * @returns {Promise<WalletState>}
 *   { agentId, address, network, lamports, sol, usdTotal, priced, assets[],
 *     mix:{sol,usdc,three,other}, hasThree, balanceError }
 */
export async function fetchWalletState(agent, opts = {}) {
	const network = opts.network === 'devnet' ? 'devnet' : 'mainnet';
	const agentId = typeof agent === 'string' ? agent : agentIdOf(agent);
	const known = typeof agent === 'string' ? null : addressOf(agent);
	const empty = {
		agentId, address: known, network,
		lamports: null, sol: 0, usdTotal: 0, priced: false,
		assets: [], mix: { sol: 0, usdc: 0, three: 0, other: 0 },
		hasThree: false, balanceError: null,
	};
	if (!agentId) return empty;

	let holdings;
	try {
		const r = await fetch(
			`/api/agents/${encodeURIComponent(agentId)}/solana/holdings?network=${network}`,
			{ credentials: 'include' },
		);
		const body = await r.json().catch(() => ({}));
		if (!r.ok) {
			// 404 = wallet not provisioned yet → clean dormant baseline (not an error).
			if (r.status === 404) return empty;
			return { ...empty, balanceError: body?.error?.code || 'holdings_error' };
		}
		holdings = body.data;
	} catch {
		return { ...empty, balanceError: 'network_error' };
	}

	const address = holdings.address || known;
	const sol = Number(holdings.sol) || 0;
	const tokens = Array.isArray(holdings.tokens) ? holdings.tokens : [];

	// Price SOL + every held mint together. SOL value always resolves (feed +
	// CoinGecko fallback inside getSolPriceUsd); SPL tokens that the feed can't
	// price contribute $0 rather than a fabricated value.
	let solPrice = 0;
	try { solPrice = await getSolPriceUsd(); } catch { solPrice = 0; }
	const prices = await priceMints(tokens.map((t) => t.mint), network);

	const assets = [];
	let usdTotal = 0;
	const solUsd = sol * (solPrice || 0);
	if (sol > 0 || solPrice > 0) {
		assets.push({ kind: 'sol', mint: WSOL_MINT, uiAmount: sol, usd: solUsd });
		usdTotal += solUsd;
	}
	const usdcMint = USDC_MINT_BY_CLUSTER[network];
	let hasThree = false;
	for (const t of tokens) {
		const price = prices.get(t.mint) ?? 0;
		const usd = Number(t.ui_amount) * price;
		const kind =
			t.mint === THREE_MINT ? 'three' :
			t.mint === usdcMint || t.is_usdc ? 'usdc' : 'other';
		if (kind === 'three') hasThree = true;
		assets.push({ kind, mint: t.mint, uiAmount: Number(t.ui_amount), usd, priced: price > 0 });
		usdTotal += usd;
	}
	assets.sort((a, b) => b.usd - a.usd);

	// Asset mix by real USD proportion (sums to 1 when usdTotal > 0).
	const mix = { sol: 0, usdc: 0, three: 0, other: 0 };
	if (usdTotal > 0) {
		for (const a of assets) mix[a.kind] = (mix[a.kind] || 0) + a.usd / usdTotal;
	}

	return {
		agentId, address, network,
		lamports: holdings.lamports != null ? Number(holdings.lamports) : Math.round(sol * 1e9),
		sol, usdTotal,
		priced: solPrice > 0 || prices.size > 0,
		assets, mix, hasThree,
		balanceError: solPrice > 0 ? null : 'price_unavailable',
	};
}

// ── Pure visual mapping ───────────────────────────────────────────────────────
// Everything below is a deterministic function of the real WalletState. No
// randomness, no time input — the same state always yields the same look.

// Asset-mix hue rotations (degrees) layered over the violet wallet accent. These
// are generic, coin-agnostic tints derived purely from real USD proportion; the
// only coin named anywhere is $THREE, which earns the warm brand-gold shift.
// Targets are blended into the violet base by a small factor (shortest path on
// the wheel), so in practice each asset only nudges the accent within a coherent
// blue-violet→magenta band: SOL/USDC tilt toward blue-violet, $THREE toward
// magenta-violet, generic SPL stays neutral. No asset ever escapes the family.
const MIX_HUES = {
	sol: 170,   // teal target → resolves to blue-violet
	usdc: 150,  // mint target → resolves to blue-violet
	three: 45,  // warm target → resolves to magenta-violet ($THREE, the one coin)
	other: 250, // violet-neutral — generic SPL
};

const BASE_HUE = 258; // wallet-violet (matches --wallet-accent #c4b5fd family)

/** Dominant asset kind by USD weight, or null for an empty wallet. */
export function dominantAsset(state) {
	if (!state || state.usdTotal <= 0) return null;
	let best = null, bestW = 0;
	for (const k of ['sol', 'usdc', 'three', 'other']) {
		const w = state.mix?.[k] || 0;
		if (w > bestW) { bestW = w; best = k; }
	}
	return best;
}

/**
 * The pure real-data → visual descriptor. Consumed identically by the DOM aura
 * (avatar viewer, cards) and the galaxy shader.
 *
 * @returns {{
 *   tier, level, intensity, particleDensity, accent, accentSoft, glow,
 *   rimHue, mixHue, hasThree, dominant, capped, dormant
 * }}
 */
export function computeWalletVisual(state) {
	const usd = Number(state?.usdTotal) || 0;
	const tier = tierForUsd(usd);
	const level = tier.level;
	const dormant = level === 0;

	// Intensity rises with tier and is then nudged smoothly within the tier by a
	// log of value, so a wallet that is deep into a tier glows a touch stronger
	// than one that just crossed the line — without ever exceeding the cap.
	const base = level / 5; // 0 … 1
	const within = level >= 5
		? 0
		: Math.min(1, Math.log10(Math.max(1, usd / Math.max(1, tier.min))) / 1.2);
	const span = level >= 5 ? 0 : (1 / 5) * 0.6;
	const intensity = Math.min(1, base + within * span);

	// Whale cap: hard-clamp so an enormous balance never eye-searingly overshoots.
	const capped = level >= 5;

	const dom = dominantAsset(state);
	const mixHue = dom ? MIX_HUES[dom] : BASE_HUE;
	// Keep the primary accent firmly in the violet wallet family; let the asset
	// mix rotate it only slightly (max ~14°) so the system stays coherent.
	const rimHue = lerpHue(BASE_HUE, mixHue, dormant ? 0 : 0.22);

	const sat = dormant ? 22 : Math.round(46 + intensity * 30);
	const light = dormant ? 70 : Math.round(74 + intensity * 8);
	const accent = `hsl(${rimHue} ${sat}% ${light}%)`;
	const accentSoft = `hsla(${rimHue} ${sat}% ${light}% / ${(0.10 + intensity * 0.22).toFixed(3)})`;
	const glow = `hsla(${rimHue} ${Math.min(90, sat + 14)}% ${Math.min(80, light)}% / ${(0.18 + intensity * 0.5).toFixed(3)})`;

	// Particle budget for the rich (full) LOD, capped and tasteful.
	const particleDensity = dormant ? 0 : Math.round([0, 8, 16, 26, 40, 56][level]);

	return {
		tier: tier.key,
		tierLabel: tier.label,
		level,
		intensity,
		particleDensity,
		accent,
		accentSoft,
		glow,
		rimHue,
		mixHue,
		hasThree: !!state?.hasThree,
		dominant: dom,
		capped,
		dormant,
		usdTotal: usd,
	};
}

/**
 * Compact wealth signal for the galaxy: a single 0–1 wealth scalar + tint, from
 * the same tiering. The galaxy values stars by real SOL balance (one batched
 * RPC read), a real lower bound on net worth that scales legibly across the map.
 */
export function walletGlowForUsd(usd) {
	const tier = tierForUsd(usd);
	const wealth = tier.level / 5;
	const vis = computeWalletVisual({ usdTotal: usd, mix: { sol: 1 }, hasThree: false });
	return { wealth, level: tier.level, tier: tier.key, rimHue: vis.rimHue };
}

// Shortest-path hue interpolation on the colour wheel.
function lerpHue(a, b, t) {
	let d = ((b - a + 540) % 360) - 180;
	return (a + d * t + 360) % 360;
}

/** Human net-worth label, e.g. "$1,240" / "$0" / "—" (price feed down). */
export function formatNetWorth(state) {
	if (!state) return '—';
	if (state.balanceError === 'price_unavailable' && state.usdTotal === 0) return '—';
	const v = Number(state.usdTotal) || 0;
	if (v === 0) return '$0';
	if (v < 0.01) return '<$0.01';
	if (v < 1000) return `$${v.toFixed(2)}`;
	if (v < 1_000_000) return `$${Math.round(v).toLocaleString()}`;
	return `$${(v / 1_000_000).toFixed(2)}M`;
}

if (typeof window !== 'undefined') {
	window.twsWalletNetworth = {
		fetchWalletState, computeWalletVisual, tierForUsd, walletGlowForUsd,
		formatNetWorth, dominantAsset, NETWORTH_TIERS, THREE_MINT,
	};
}
