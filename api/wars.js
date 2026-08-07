// /api/wars — the public face of Coin Wars.
//
// One endpoint serves everything the war portal in /play and the arena page at
// /play/war need, plus the write the game server makes when a battle ends:
//
//   GET  /api/wars?network=&coin=&limit=      the board: standings, recent
//                                             battles, live wars, this coin's
//                                             league row, who is queued
//   GET  /api/wars?action=live&coin=          just the live wars (spectator poll)
//   POST /api/wars?action=queue               queue a community for a war; pairs
//                                             with a waiting one and returns the
//                                             matchKey + signed war ticket
//   POST /api/wars?action=leave               take a community out of the queue
//   POST /api/wars?action=report              the game server's HMAC-signed
//                                             battle result (ClashRoom →
//                                             multiplayer/src/war-report.js)
//
// The league math is NOT implemented here. Standings are folded from the battle
// ledger by multiplayer/src/war-standings.js, the same module the arena's own
// league uses, so the rating on a portal board is never a second opinion.
//
// Trust model. The report write is HMAC-signed with the shared war secret, so
// only the game process can post an outcome. The queue write is unauthenticated
// on purpose (queueing costs nothing and reveals nothing), but the PAIRING it
// produces is sealed into a signed war ticket: ClashRoom takes the two competing
// communities from that ticket, never from a joining client, so a fighter cannot
// open an arena against a community that never agreed to fight.

import crypto from 'node:crypto';
import { cors, error, json, method, wrap, rateLimited, readBody } from './_lib/http.js';
import { clientIp, limits } from './_lib/rate-limit.js';
import {
	recordBattle, listBattles, readStandings, readLiveMatches,
	queueForWar, leaveWarQueue, readQueueBoard,
	BattleShapeError, QueueUnavailableError,
} from './_lib/wars-store.js';
import { signWarTicket } from './_lib/war-ticket.js';

const MINT_RE = /^[A-Za-z0-9]{32,64}$/;
const NETWORK_RE = /^[a-z]{1,12}$/;
const DEV_REPORT_SECRET = 'three-ws-war-report-dev-secret';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS' })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const url = new URL(req.url, 'http://x');
	const action = url.searchParams.get('action') || '';

	if (req.method === 'POST') {
		if (action === 'report') return handleReport(req, res);
		if (action === 'queue') return handleQueue(req, res, url);
		if (action === 'leave') return handleLeave(req, res, url);
		return error(res, 400, 'validation_error', 'unknown action — expected report, queue or leave');
	}

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	if (action === 'live') return handleLive(res, url);
	return handleBoard(res, url);
});

// ── GET: the board ───────────────────────────────────────────────────────────

async function handleBoard(res, url) {
	const network = readNetwork(url);
	const coin = readMint(url.searchParams.get('coin'));
	const limit = Number(url.searchParams.get('limit')) || 12;

	// Each surface degrades on its own. A cold database must not blank the live
	// war a player is standing in front of, and a Redis outage must not hide the
	// league table — so failures resolve to an explicit availability flag rather
	// than to a 500 or, worse, to a silently empty board that reads as "no wars".
	const [standings, recent, live, queue] = await Promise.all([
		readStandings({ network }).catch((err) => ({ error: err, standings: [], battlesRead: 0, windowFull: false })),
		listBattles({ network, mint: coin, limit }).catch(() => null),
		readLiveMatches({ network, mint: coin }),
		readQueueBoard({ network }),
	]);

	const table = standings.standings || [];
	const row = coin ? table.find((s) => s.mint === coin) || null : null;

	res.setHeader('cache-control', 'no-store');
	return json(res, 200, {
		data: {
			network,
			coin: coin || null,
			// The requesting community's league row, or null when it has never
			// fought — the portal renders a designed "unranked" state from that.
			standing: row,
			standings: table,
			ledgerAvailable: !standings.error,
			battlesRead: standings.battlesRead,
			seasonWindowFull: standings.windowFull,
			recent: recent || [],
			recentAvailable: recent !== null,
			live,
			queue,
		},
	});
}

// A cheap spectator poll: only the live wars, nothing that touches Postgres.
async function handleLive(res, url) {
	const network = readNetwork(url);
	const coin = readMint(url.searchParams.get('coin'));
	const live = await readLiveMatches({ network, mint: coin });
	res.setHeader('cache-control', 'no-store');
	return json(res, 200, { data: { network, coin: coin || null, live } });
}

// ── POST: matchmaking ────────────────────────────────────────────────────────

async function handleQueue(req, res, url) {
	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	let body;
	try {
		body = JSON.parse((await readBody(req, 8_000)).toString('utf8') || '{}');
	} catch {
		return error(res, 400, 'validation_error', 'body must be JSON');
	}
	const mint = readMint(body?.coin);
	if (!mint) return error(res, 400, 'validation_error', 'coin must be a valid mint address');
	const network = cleanNetwork(body?.network || url.searchParams.get('network'));

	let result;
	try {
		result = await queueForWar({
			coin: { mint, name: body?.name, symbol: body?.symbol, image: body?.image },
			network,
		});
	} catch (err) {
		if (err instanceof QueueUnavailableError) {
			return error(res, 503, 'matchmaking_unavailable', 'war matchmaking is offline right now');
		}
		throw err;
	}

	res.setHeader('cache-control', 'no-store');
	if (result.status === 'invalid') {
		return error(res, 400, 'validation_error', 'coin must be a valid mint address');
	}
	if (!result.matchKey || !result.opponent) {
		return json(res, 200, { data: { status: 'waiting', waiting: result.waiting, coin: mint, network } });
	}

	// Paired. Seal the two communities into a ticket the arena will trust, and
	// hand back the side this caller fights on so their HUD colours are right
	// before a single packet crosses the wire.
	const ticket = signWarTicket({
		matchKey: result.matchKey,
		network,
		coinA: { mint, name: body?.name, symbol: body?.symbol, image: body?.image },
		coinB: result.opponent,
	});
	if (!ticket) {
		return error(res, 500, 'ticket_error', 'could not seal the war pairing');
	}
	return json(res, 200, {
		data: {
			status: 'matched',
			matchKey: result.matchKey,
			ticket,
			side: result.side,
			opponent: result.opponent,
			coin: mint,
			network,
		},
	});
}

async function handleLeave(req, res, url) {
	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	let body;
	try {
		body = JSON.parse((await readBody(req, 4_000)).toString('utf8') || '{}');
	} catch {
		return error(res, 400, 'validation_error', 'body must be JSON');
	}
	const mint = readMint(body?.coin);
	if (!mint) return error(res, 400, 'validation_error', 'coin must be a valid mint address');
	const network = cleanNetwork(body?.network || url.searchParams.get('network'));
	const out = await leaveWarQueue({ mint, network });
	res.setHeader('cache-control', 'no-store');
	return json(res, 200, { data: out });
}

// ── POST: the game server's battle report ────────────────────────────────────

async function handleReport(req, res) {
	const raw = (await readBody(req, 64_000)).toString('utf8');
	const sig = req.headers['x-war-signature'];
	if (!verifyReportSignature(raw, sig)) {
		return error(res, 401, 'bad_signature', 'battle reports must be signed by the game server');
	}

	let payload;
	try {
		payload = JSON.parse(raw);
	} catch {
		return error(res, 400, 'validation_error', 'body must be JSON');
	}

	try {
		const out = await recordBattle(payload?.battle);
		res.setHeader('cache-control', 'no-store');
		return json(res, 200, { data: out });
	} catch (err) {
		if (err instanceof BattleShapeError) {
			return error(res, 400, 'validation_error', err.message);
		}
		throw err;
	}
}

// Byte-for-byte compatible with signBattle() in multiplayer/src/war-report.js.
function verifyReportSignature(rawBody, provided) {
	if (typeof provided !== 'string' || provided.length !== 64) return false;
	const secret = process.env.WAR_RESULT_SECRET || process.env.HOLDER_PASS_SECRET
		|| (process.env.NODE_ENV === 'production' ? '' : DEV_REPORT_SECRET);
	// Fail closed: with no secret configured in production there is no way to tell
	// a real game server from anyone who found the endpoint.
	if (!secret) return false;
	const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
	const a = Buffer.from(expected, 'utf8');
	const b = Buffer.from(provided, 'utf8');
	return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── input helpers ────────────────────────────────────────────────────────────

function readNetwork(url) {
	return cleanNetwork(url.searchParams.get('network'));
}

function cleanNetwork(v) {
	const s = String(v || 'mainnet').toLowerCase();
	return NETWORK_RE.test(s) ? s : 'mainnet';
}

function readMint(v) {
	const s = String(v || '').trim();
	return MINT_RE.test(s) ? s : '';
}
