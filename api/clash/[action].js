// Coin Clash — community battle API.
//
// Every CoinCommunities community is a faction; its holders are its army. The
// game loop:
//
//   GET  state            → live bracket for the current round: who fights whom,
//                           each army's power + momentum, time left, war records.
//   POST enlist           → issue a wallet-bound challenge for a faction.
//   POST enlist-verify    → verify the wallet's signature, confirm a live on-chain
//                           holding of the faction coin (pump.fun-priced), and seal
//                           a war pass.
//   POST rally            → spend taps from a war pass as battle power for the
//                           soldier's faction this round.
//   GET  leaderboard      → all-time faction war records + (optional) a faction's
//                           top soldiers this round.
//
// Real data throughout: factions + their social stats come from CoinCommunities,
// holdings + momentum from pump.fun/Helius via the shared balances lib, power is
// persisted and ranked in Redis. Nothing here is mocked.

import { cors, json, method, readJson, error, wrap, rateLimited } from '../_lib/http.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { cc, toWorldCard, isValidToken, UnconfiguredError } from '../_lib/coin-communities.js';
import { getBalances, solanaMintUsdPrice } from '../_lib/balances.js';
import { verifySiwsSignature } from '../_lib/siws.js';
import {
	epochAt,
	epochWindow,
	matchmake,
	momentumFactor,
	buildChallenge,
	verifyChallenge,
	signWarPass,
	verifyWarPass,
	priceIsStale,
	rollPrice,
	priceChangePct,
	PRICE_BASELINE_MS,
	EPOCH_MS,
	MAX_FACTIONS,
	MAX_TAPS_PER_RALLY,
	POWER_PER_TAP,
	MAX_POWER_PER_WALLET_EPOCH,
} from '../_lib/clash.js';
import {
	addPower,
	factionPower,
	factionPowers,
	topSoldiers,
	getRecords,
	getMomentum,
	setMomentum,
	getPrice,
	setPrice,
	settleRound,
} from '../_lib/clash-store.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;
	const action = req.query?.action;
	switch (action) {
		case 'state':
			return handleState(req, res);
		case 'enlist':
			return handleEnlist(req, res);
		case 'enlist-verify':
			return handleEnlistVerify(req, res);
		case 'rally':
			return handleRally(req, res);
		case 'leaderboard':
			return handleLeaderboard(req, res);
		default:
			return error(res, 404, 'unknown_action', `unknown clash action: ${action || '(none)'}`);
	}
});

// Load the active faction roster from CoinCommunities, ranked strongest-first by
// member count so the bracket seeds deterministically. Returns the normalized
// world-cards (token, symbol, image, members, social stats).
async function loadFactions() {
	const api = cc(); // throws UnconfiguredError → caller maps to 503
	const { data, error: apiErr } = await api.getTopCommunities();
	if (apiErr) {
		throw Object.assign(new Error(apiErr.message || 'failed to load communities'), { status: 502, code: 'upstream_error' });
	}
	return (data?.communities ?? [])
		.map(toWorldCard)
		.filter((c) => isValidToken(c.token))
		.sort((a, b) => (b.members || 0) - (a.members || 0))
		.slice(0, MAX_FACTIONS);
}

/**
 * Bring one faction's live vigor up to date on the shared cache and stamp it
 * onto the world-card for this response.
 *
 * Every open Clash tab polls state every few seconds, so pricing every faction
 * upstream on every request would mean thousands of Jupiter/pump.fun calls a
 * minute for a number that barely moves. A faction is therefore priced once per
 * spot TTL for the whole fleet; between refreshes the cached snapshot serves.
 * The same snapshot carries a rolling daily baseline, which is what turns a
 * spot price into the real market move momentum wants.
 */
async function refreshVigor(f, now) {
	const [snap, cachedMomentum] = await Promise.all([
		getPrice(f.token).catch(() => null),
		getMomentum(f.token).catch(() => null),
	]);
	const vigor = (priceChange) =>
		momentumFactor({ members: f.members, latestPostAt: f.latestPostAt, priceChange });

	if (!priceIsStale(snap, now)) {
		f._priceUsd = snap.spot;
		f._momentum = cachedMomentum || vigor(priceChangePct(snap));
		return;
	}

	// Price is flavour, never fatal: an upstream that can't price the mint yields
	// 0 and the faction simply fights on its social signals.
	const spot = await solanaMintUsdPrice(f.token).catch(() => 0);
	const next = rollPrice(snap, spot, now);
	const factor = vigor(priceChangePct(next));
	f._priceUsd = next.spot;
	f._momentum = factor;
	await Promise.all([
		setPrice(f.token, next, Math.ceil(PRICE_BASELINE_MS / 1000)).catch(() => {}),
		setMomentum(f.token, factor, Math.ceil(EPOCH_MS / 1000)).catch(() => {}),
	]);
}

// ─── state ───────────────────────────────────────────────────────────────────

async function handleState(req, res) {
	if (!method(req, res, ['GET'])) return;
	const rl = await limits.clashStateIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	let factions;
	try {
		factions = await loadFactions();
	} catch (err) {
		if (err instanceof UnconfiguredError) {
			return error(res, 503, 'cc_unconfigured', 'CoinCommunities is not configured');
		}
		if (err.status === 502) return error(res, 502, err.code, err.message);
		throw err;
	}

	const now = Date.now();
	const epoch = epochAt(now);
	const { msLeft, end } = epochWindow(epoch, now);

	// Settle the previous round once (lazy, idempotent) so records stay current
	// without a cron. Best-effort — a settle hiccup never blocks the live read.
	settleRound(epoch - 1, matchmake).catch(() => {});

	const byMint = new Map(factions.map((f) => [f.token, f]));
	const mints = factions.map((f) => f.token);
	const { battles, bye } = matchmake(mints, epoch);

	const [powers, records] = await Promise.all([factionPowers(epoch), getRecords(mints)]);

	// Refresh each faction's live vigor (price + momentum) and cache it so the hot
	// rally path can read it cheaply. Derived from real social + market data.
	await Promise.all(factions.map((f) => refreshVigor(f, now)));

	const sideOf = (mint) => {
		const f = byMint.get(mint);
		const power = Math.round(powers[mint] || 0);
		return {
			token: mint,
			symbol: f?.symbol || null,
			image: f?.image || null,
			members: f?.members || 0,
			posts: f?.posts || 0,
			priceUsd: f?._priceUsd || 0,
			momentum: f?._momentum || 1,
			power,
			record: records[mint] || { w: 0, l: 0, d: 0, battles: 0, power: 0 },
		};
	};

	const arena = battles.map((bt) => {
		const a = sideOf(bt.a);
		const b = bt.b ? sideOf(bt.b) : null;
		const total = a.power + (b?.power || 0);
		return {
			id: bt.id,
			a,
			b,
			// Live share of the round's combined power, for the tug-of-war bar.
			aShare: total > 0 ? a.power / total : 0.5,
			leader: !b ? a.token : a.power === b.power ? null : a.power > b.power ? a.token : b.token,
		};
	});

	res.setHeader('cache-control', 'no-store');
	return json(res, 200, {
		data: {
			epoch,
			endsAt: end,
			msLeft,
			epochMs: EPOCH_MS,
			arena,
			bye: bye ? sideOf(bye) : null,
			factionCount: factions.length,
		},
	});
}

// ─── enlist (issue challenge) ────────────────────────────────────────────────

async function handleEnlist(req, res) {
	if (!method(req, res, ['POST'])) return;
	res.setHeader('cache-control', 'no-store');
	const rl = await limits.clashEnlistIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const body = await readJson(req).catch(() => ({}));
	const token = String(body.token || '');
	const wallet = String(body.wallet || '');
	if (!isValidToken(token)) return error(res, 400, 'validation_error', 'valid faction token required');
	if (!isValidToken(wallet)) return error(res, 400, 'validation_error', 'valid wallet address required');

	const ch = buildChallenge({ wallet, mint: token, now: Date.now() });
	return json(res, 200, { data: { message: ch.message, expiresAt: ch.expiresAt } });
}

// ─── enlist-verify (verify sig + holding → war pass) ─────────────────────────

async function handleEnlistVerify(req, res) {
	if (!method(req, res, ['POST'])) return;
	res.setHeader('cache-control', 'no-store');
	const rl = await limits.clashEnlistIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const body = await readJson(req).catch(() => ({}));
	const token = String(body.token || '');
	const wallet = String(body.wallet || '');
	const message = String(body.message || '');
	const signature = String(body.signature || '');
	if (!isValidToken(token)) return error(res, 400, 'validation_error', 'valid faction token required');
	if (!isValidToken(wallet)) return error(res, 400, 'validation_error', 'valid wallet address required');
	if (!message || !signature) return error(res, 400, 'validation_error', 'message and signature required');

	// 1) The challenge must be our own, un-tampered, fresh, and bound to this
	//    exact wallet + faction.
	if (!verifyChallenge({ message, wallet, mint: token, now: Date.now() })) {
		return error(res, 400, 'bad_challenge', 'enlist challenge is invalid or expired — request a new one');
	}

	// 2) The signature must verify against the claimed wallet, proving the caller
	//    controls it (so power can't be enlisted on someone else's behalf).
	let sigOk = false;
	try {
		sigOk = verifySiwsSignature(message, signature, wallet);
	} catch {
		sigOk = false;
	}
	if (!sigOk) return error(res, 401, 'bad_signature', 'signature does not match wallet');

	// 3) Confirm a live on-chain holding of the faction coin. This is the token
	//    gate: you fight for a coin only if you actually hold it right now.
	let balances;
	try {
		balances = await getBalances({ chain: 'solana', address: wallet });
	} catch (err) {
		const status = err?.status === 503 ? 503 : 502;
		return error(res, status, 'balance_unavailable', 'could not read on-chain balance — try again');
	}
	const holding =
		token === SOL_MINT ? balances?.native : (balances?.tokens ?? []).find((t) => t.mint === token);
	const amount = holding?.amount || 0;
	if (amount <= 0) {
		return json(res, 200, {
			data: { eligible: false, wallet, amount: 0, usd: 0, reason: 'not_a_holder' },
		});
	}

	// Price it for display (fresh bonding-curve coins price at $0 via Jupiter; fall
	// back to the pump.fun curve so a real holder always sees a real number).
	let price = holding?.price || 0;
	if (price <= 0 && token !== SOL_MINT) price = await solanaMintUsdPrice(token).catch(() => 0);
	const usd = Math.round(amount * price * 100) / 100;

	const warPass = signWarPass({ wallet, mint: token, amount, usd });
	return json(res, 200, { data: { eligible: true, wallet, amount, usd, warPass } });
}

// ─── rally (spend taps as battle power) ──────────────────────────────────────

async function handleRally(req, res) {
	if (!method(req, res, ['POST'])) return;
	res.setHeader('cache-control', 'no-store');

	const body = await readJson(req).catch(() => ({}));
	const pass = verifyWarPass(String(body.pass || ''));
	if (!pass) return error(res, 401, 'pass_invalid', 'war pass is missing, forged, or expired — re-enlist');

	const wallet = pass.wallet;
	const mint = pass.mint;

	const rl = await limits.clashRallyWallet(wallet);
	if (!rl.success) return rateLimited(res, rl, 'rallying too fast — pace your taps');

	// Clamp reported taps to the per-call ceiling: a forged count buys nothing a
	// fast thumb couldn't legitimately produce between flushes.
	const taps = Math.max(0, Math.min(MAX_TAPS_PER_RALLY, Math.floor(Number(body.taps) || 0)));
	if (taps <= 0) return error(res, 400, 'validation_error', 'taps must be a positive integer');

	const now = Date.now();
	const epoch = epochAt(now);

	// Fold the faction's cached momentum into power so an active community hits
	// slightly harder per tap. Absent cache → 1.0 (never blocks the rally).
	const momentum = (await getMomentum(mint).catch(() => null)) || 1;
	const power = Math.max(1, Math.round(taps * POWER_PER_TAP * momentum));

	const result = await addPower({
		epoch,
		mint,
		wallet,
		amount: power,
		walletCap: MAX_POWER_PER_WALLET_EPOCH,
	});

	const { msLeft } = epochWindow(epoch, now);
	return json(res, 200, {
		data: {
			epoch,
			mint,
			added: result.added,
			momentum,
			walletPower: result.walletTotal,
			walletCap: MAX_POWER_PER_WALLET_EPOCH,
			capped: result.capped,
			factionPower: Math.round(await factionPower(epoch, mint)),
			msLeft,
		},
	});
}

// ─── leaderboard ─────────────────────────────────────────────────────────────

async function handleLeaderboard(req, res) {
	if (!method(req, res, ['GET'])) return;
	const rl = await limits.clashStateIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	let factions;
	try {
		factions = await loadFactions();
	} catch (err) {
		if (err instanceof UnconfiguredError) {
			return error(res, 503, 'cc_unconfigured', 'CoinCommunities is not configured');
		}
		if (err.status === 502) return error(res, 502, err.code, err.message);
		throw err;
	}
	const byMint = new Map(factions.map((f) => [f.token, f]));
	const mints = factions.map((f) => f.token);
	const records = await getRecords(mints);

	const board = mints
		.map((mint) => {
			const f = byMint.get(mint);
			const r = records[mint] || { w: 0, l: 0, d: 0, battles: 0, power: 0 };
			const decided = r.w + r.l;
			return {
				token: mint,
				symbol: f?.symbol || null,
				image: f?.image || null,
				members: f?.members || 0,
				...r,
				winRate: decided > 0 ? Math.round((r.w / decided) * 100) : null,
			};
		})
		.sort((a, b) => b.w - a.w || b.power - a.power);

	// Optional: a single faction's top soldiers this round.
	const mintParam = new URL(req.url, 'http://x').searchParams.get('faction');
	let soldiers = null;
	if (mintParam && isValidToken(mintParam)) {
		soldiers = await topSoldiers({ epoch: epochAt(Date.now()), mint: mintParam, limit: 10 });
	}

	res.setHeader('cache-control', 'public, max-age=15, s-maxage=15, stale-while-revalidate=60');
	return json(res, 200, { data: { board, soldiers } });
}
