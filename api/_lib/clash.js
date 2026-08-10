// Coin Clash — community battle engine.
//
// Every CoinCommunities community on three.ws is a faction. Holders of a coin
// enlist in that coin's army by proving — wallet signature + live on-chain
// holding of the coin — that they're a real holder, then rally for it in timed
// battles. Two factions are matched per epoch; whichever army accumulates more
// rally power before the clock runs out wins, and the result is written to each
// faction's all-time war record.
//
// This file is the pure engine: deterministic epoch math + matchmaking (so every
// stateless serverless instance agrees on who fights whom without coordination),
// the HMAC war pass the rally endpoint trusts instead of re-running Solana RPC on
// every tap, and the bounded momentum factor that folds a faction's live
// pump.fun + community vigor into its rally power. Persistence lives in
// clash-store.js; the HTTP surface in api/clash/[action].js.

import crypto from 'node:crypto';

// ─── Tunables ────────────────────────────────────────────────────────────────

// Battle round length. A round is long enough for an army to rally and short
// enough that standings resolve while people are watching. One hour by default.
export const EPOCH_MS = Math.max(5 * 60_000, Number(process.env.CLASH_EPOCH_MS) || 60 * 60_000);

// How many top communities enter the bracket each round. Even count → clean
// pairs; an odd active set leaves the lowest-seeded faction with a bye.
export const MAX_FACTIONS = Math.min(32, Math.max(2, Number(process.env.CLASH_MAX_FACTIONS) || 16));

// One tap of the rally is one base power point. Power is the only thing that
// decides a battle — an army's effort, not its market cap.
export const POWER_PER_TAP = 1;

// A single rally POST reports at most this many taps. The client batches taps
// between flushes; anything above this is clamped server-side, so a forged
// payload buys nothing a fast thumb couldn't.
export const MAX_TAPS_PER_RALLY = 50;

// Hard ceiling on one wallet's total power per faction per round. The real
// anti-inflation gate: combined with the per-wallet rally rate limit it bounds
// any single holder's influence so a battle reflects an army, not one scripted
// tab.
export const MAX_POWER_PER_WALLET_EPOCH = Math.max(
	500,
	Number(process.env.CLASH_MAX_POWER_PER_WALLET) || 5000,
);

// War-pass lifetime. Long enough to rally through a round, short enough that a
// holder who dumps the coin can't keep fighting for it indefinitely on an old
// pass.
const PASS_TTL_S = 30 * 60;

// Enlist challenge lifetime — the wallet must sign and return it within this
// window. Stateless: the challenge carries its own HMAC, so no nonce store.
const CHALLENGE_TTL_S = 5 * 60;

// ─── Secret + HMAC (mirrors holder-pass.js) ─────────────────────────────────

const DEV_SECRET = 'three-ws-clash-dev-secret';
let _warned = false;
function secret() {
	const s = process.env.CLASH_PASS_SECRET || process.env.HOLDER_PASS_SECRET;
	if (s) return s;
	if (process.env.NODE_ENV === 'production') {
		throw new Error(
			'[clash] CLASH_PASS_SECRET (or HOLDER_PASS_SECRET) is required in production — refusing to sign war passes with the dev secret.',
		);
	}
	if (!_warned) {
		_warned = true;
		console.warn(
			'[clash] CLASH_PASS_SECRET is not set — using the insecure dev secret. ' +
				'Set CLASH_PASS_SECRET in production or war passes can be forged.',
		);
	}
	return DEV_SECRET;
}

function b64url(buf) {
	return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function fromB64url(s) {
	return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}
function hmac(body) {
	return b64url(crypto.createHmac('sha256', secret()).update(body).digest());
}
// Constant-time compare so a forged tag can't be teased out by timing.
function safeEq(a, b) {
	const ba = Buffer.from(String(a));
	const bb = Buffer.from(String(b));
	if (ba.length !== bb.length) return false;
	return crypto.timingSafeEqual(ba, bb);
}

// ─── Epoch math + deterministic matchmaking ─────────────────────────────────

/** The round index for an instant. Integer, monotonic, identical on every box. */
export function epochAt(now) {
	return Math.floor(now / EPOCH_MS);
}
/** [start, end) of a round in epoch-ms, and ms left until it ends. */
export function epochWindow(epoch, now) {
	const start = epoch * EPOCH_MS;
	const end = start + EPOCH_MS;
	return { start, end, msLeft: Math.max(0, end - now) };
}

// A cheap deterministic hash of a string → 32-bit unsigned int. Used to derive a
// per-epoch rotation so the same top factions don't draw the same opponent every
// round, without any stored bracket.
function hash32(str) {
	let h = 2166136261;
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

/**
 * Pair an ordered faction list into battles for a given epoch. Deterministic:
 * the seeding order (caller passes factions already ranked, e.g. by members) is
 * rotated by an epoch-seeded offset so matchups vary round to round, then folded
 * into adjacent pairs. An odd faction count yields one bye.
 *
 * @param {string[]} mints  faction mints, pre-ranked (strongest first)
 * @param {number} epoch
 * @returns {{ battles: Array<{ id: string, a: string, b: string|null }>, bye: string|null }}
 */
export function matchmake(mints, epoch) {
	const pool = mints.slice(0, MAX_FACTIONS).filter(Boolean);
	if (pool.length < 2) return { battles: [], bye: pool[0] || null };

	// Rotate the seed order by an epoch-derived offset so #1 doesn't always meet
	// #2. The rotation is deterministic from the epoch and the pool itself.
	const offset = hash32(`${epoch}:${pool.join(',')}`) % pool.length;
	const rotated = pool.slice(offset).concat(pool.slice(0, offset));

	const battles = [];
	let bye = null;
	for (let i = 0; i + 1 < rotated.length; i += 2) {
		const a = rotated[i];
		const b = rotated[i + 1];
		// Stable battle id independent of a/b order so both sides resolve the same
		// key (sorted pair + epoch).
		const id = battleId(epoch, a, b);
		battles.push({ id, a, b });
	}
	if (rotated.length % 2 === 1) bye = rotated[rotated.length - 1];
	return { battles, bye };
}

/** Order-independent battle id for a pair in a round. */
export function battleId(epoch, a, b) {
	const [x, y] = [a, b].sort();
	return `${epoch}:${b64url(hash32(`${x}|${y}`).toString(36)).slice(0, 10)}`;
}

// ─── Momentum factor ─────────────────────────────────────────────────────────

// Live vigor → a bounded rally bonus, so an active community with real on-chain
// and social momentum hits a little harder per tap. Bounded so it flavours a
// battle without letting market cap simply buy the win — effort still dominates.
export const MOMENTUM_MIN = 1.0;
export const MOMENTUM_MAX = 1.5;

/**
 * Derive a faction's momentum multiplier from real signals:
 *   · social recency — how recently the community last posted
 *   · social mass    — member count (log-scaled, so whales don't dominate)
 *   · market move     — pump.fun 24h-ish price change when available
 * Each contributes a slice of the [MIN,MAX] band. Missing signals contribute 0,
 * never block — a coin with no data just fights at the 1.0 floor.
 *
 * @param {{ members?: number, latestPostAt?: number|string|null, priceChange?: number|null }} s
 */
export function momentumFactor(s = {}) {
	const span = MOMENTUM_MAX - MOMENTUM_MIN;

	// Recency: full credit if posted within the hour, decaying to 0 over a week.
	let recency = 0;
	const last = s.latestPostAt ? new Date(s.latestPostAt).getTime() : 0;
	if (last > 0) {
		const ageH = Math.max(0, (Date.now() - last) / 3_600_000);
		recency = Math.max(0, 1 - ageH / (24 * 7));
	}

	// Mass: log-scaled member count, saturating around 10k members.
	const members = Math.max(0, Number(s.members) || 0);
	const mass = Math.min(1, Math.log10(members + 1) / 4);

	// Market: positive 24h move adds, capped at +50% → full credit.
	let market = 0;
	const ch = Number(s.priceChange);
	if (Number.isFinite(ch) && ch > 0) market = Math.min(1, ch / 50);

	// Weighted blend — social signals lead, market is a smaller flavour.
	const blend = recency * 0.5 + mass * 0.3 + market * 0.2;
	const factor = MOMENTUM_MIN + span * Math.max(0, Math.min(1, blend));
	return Math.round(factor * 1000) / 1000;
}

// ─── Price snapshot (spot cache + 24h baseline) ──────────────────────────────

// The state endpoint is polled every few seconds by every open Clash tab, and
// each poll would otherwise price every faction upstream. So a faction's spot
// price is cached and only re-fetched once it goes stale.
export const PRICE_SPOT_TTL_MS = 60_000;

// The baseline a faction's move is measured against. Rolled forward once a day,
// so `priceChangePct` reports a genuine ~24h move built from our own samples
// rather than a number no upstream gives us per-mint.
export const PRICE_BASELINE_MS = 24 * 3_600_000;

/** True when a stored snapshot is missing or its spot price has aged out. */
export function priceIsStale(snap, now) {
	const at = Number(snap?.at) || 0;
	return !(at > 0) || now - at >= PRICE_SPOT_TTL_MS;
}

/**
 * Fold a freshly fetched spot price into a faction's stored snapshot. The
 * baseline is seeded on the first priced sample and rolled forward once it is
 * older than PRICE_BASELINE_MS, so the pair always spans at most a day.
 *
 * @param {{ spot?: number, at?: number, base?: number, baseAt?: number }|null} prev
 * @param {number} spot  upstream price, 0 when nothing could price the mint
 * @param {number} now
 */
export function rollPrice(prev, spot, now) {
	const price = Math.max(0, Number(spot) || 0);
	const base = Math.max(0, Number(prev?.base) || 0);
	const baseAt = Number(prev?.baseAt) || 0;
	const rebase = price > 0 && (base <= 0 || baseAt <= 0 || now - baseAt >= PRICE_BASELINE_MS);
	return {
		spot: price,
		at: now,
		base: rebase ? price : base,
		baseAt: rebase ? now : baseAt,
	};
}

/** Percent move of a snapshot's spot against its baseline, or null if unknown. */
export function priceChangePct(snap) {
	const spot = Number(snap?.spot) || 0;
	const base = Number(snap?.base) || 0;
	if (spot <= 0 || base <= 0) return null;
	return ((spot - base) / base) * 100;
}

// ─── Enlist challenge (stateless) ────────────────────────────────────────────

/**
 * Build the human-readable message a holder signs to enlist. It binds the exact
 * wallet + faction + issue time and carries an HMAC tag so the verify step can
 * confirm it's our own un-tampered, unexpired challenge with no nonce store.
 */
export function buildChallenge({ wallet, mint, now }) {
	const iat = Math.floor(now / 1000);
	const core = `three.ws Coin Clash — enlist\nfaction: ${mint}\nsoldier: ${wallet}\nissued: ${iat}`;
	const tag = hmac(`enlist|${mint}|${wallet}|${iat}`);
	const message = `${core}\nnonce: ${tag}`;
	return { message, iat, tag, expiresAt: (iat + CHALLENGE_TTL_S) * 1000 };
}

/** Re-derive and verify a returned challenge belongs to us, matches, is fresh. */
export function verifyChallenge({ message, wallet, mint, now }) {
	if (typeof message !== 'string') return false;
	const m = message.match(/issued:\s*(\d+)\nnonce:\s*([A-Za-z0-9_-]+)\s*$/);
	if (!m) return false;
	const iat = parseInt(m[1], 10);
	const tag = m[2];
	if (!Number.isFinite(iat)) return false;
	if (Math.floor(now / 1000) - iat > CHALLENGE_TTL_S) return false; // expired
	if (iat - Math.floor(now / 1000) > 60) return false; // future-dated
	const expected = hmac(`enlist|${mint}|${wallet}|${iat}`);
	if (!safeEq(tag, expected)) return false;
	// The rebuilt message must equal exactly what we'd have issued — defeats any
	// body tampering that left the tag intact.
	const rebuilt = `three.ws Coin Clash — enlist\nfaction: ${mint}\nsoldier: ${wallet}\nissued: ${iat}\nnonce: ${expected}`;
	return safeEq(message, rebuilt);
}

// ─── War pass ────────────────────────────────────────────────────────────────

/** Seal a verified enlistment into a compact signed pass the rally trusts. */
export function signWarPass({ wallet, mint, amount = 0, usd = 0 }) {
	const now = Math.floor(Date.now() / 1000);
	const payload = {
		wallet,
		mint,
		amount: Math.max(0, Number(amount) || 0),
		usd: Math.round((Number(usd) || 0) * 100) / 100,
		tier: 'clash',
		iat: now,
		exp: now + PASS_TTL_S,
	};
	const body = b64url(JSON.stringify(payload));
	return `${body}.${hmac(body)}`;
}

/** Verify + decode a war pass. Returns the payload, or null if forged/expired. */
export function verifyWarPass(pass) {
	if (typeof pass !== 'string' || pass.indexOf('.') < 0) return null;
	const [body, tag] = pass.split('.');
	if (!body || !tag) return null;
	if (!safeEq(tag, hmac(body))) return null;
	let payload;
	try {
		payload = JSON.parse(fromB64url(body).toString('utf8'));
	} catch {
		return null;
	}
	if (payload?.tier !== 'clash') return null;
	if (!payload.wallet || !payload.mint) return null;
	if (Math.floor(Date.now() / 1000) > Number(payload.exp || 0)) return null;
	return payload;
}
