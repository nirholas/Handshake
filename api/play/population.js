// GET /api/play/population: how many people are standing in the /play worlds
// right now.
//
//   ?coin=<mint>   narrow to one community's worlds (the /event landing page
//                  passes the $THREE mint so its LIVE panel counts the people
//                  actually at the event, not the whole platform)
//
// The multiplayer server is the only thing that knows: /play presence lives in
// Colyseus rooms, not in Postgres or Redis, so there is nothing here to query.
// This handler proxies the standalone server's public /population aggregate
// (multiplayer/src/index.js), which reads the matchmaker's driver-backed room
// listing and therefore counts every instance under horizontal scaling.
//
// The proxy exists so the browser gets a same-origin, CDN-cacheable endpoint and
// the multiplayer host stays an internal detail. It returns a count and nothing
// else: no session ids, no names, no wallets, no positions cross this boundary.
//
// When the multiplayer server is unreachable or has not shipped /population yet,
// this answers 200 with `{ ok: false, reason: 'unavailable' }` rather than an
// error. Callers render the live state without a number in that case; a landing
// page must never invent a population, and must never break because a count is
// missing.

import { cors, json, method, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { env } from '../_lib/env.js';

export const maxDuration = 10;

const UPSTREAM_TIMEOUT_MS = 3000;

// Mints and contract addresses only: the value is forwarded to another service,
// so it is constrained here rather than trusted. Base58 (Solana) and 0x-hex
// (EVM coin worlds) both pass; anything else is treated as "no filter".
function safeCoin(raw) {
	const s = typeof raw === 'string' ? raw.trim() : '';
	if (!s) return '';
	if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return s;
	if (/^0x[0-9a-fA-F]{40}$/.test(s)) return s;
	return '';
}

async function readUpstream(base, coin) {
	const url = new URL('/population', base);
	if (coin) url.searchParams.set('coin', coin);
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT_MS);
	try {
		const res = await fetch(url, { signal: ac.signal, headers: { accept: 'application/json' } });
		if (!res.ok) return null;
		const body = await res.json();
		if (!body || body.ok !== true) return null;
		return {
			players: Math.max(0, Math.floor(Number(body.players) || 0)),
			rooms: Math.max(0, Math.floor(Number(body.rooms) || 0)),
		};
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const coin = safeCoin(new URL(req.url, 'http://localhost').searchParams.get('coin'));
	const base = env.MULTIPLAYER_INTERNAL_URL;

	if (!base) {
		return json(res, 200, { ok: false, reason: 'unavailable', coin: coin || null });
	}

	const upstream = await readUpstream(base, coin);
	if (!upstream) {
		return json(res, 200, { ok: false, reason: 'unavailable', coin: coin || null });
	}

	// 5s at the edge matches the multiplayer server's own cache window, so the
	// number is never staler than the source it came from.
	res.setHeader('cache-control', 'public, max-age=5, s-maxage=5');
	return json(res, 200, {
		ok: true,
		coin: coin || null,
		players: upstream.players,
		rooms: upstream.rooms,
	});
});
