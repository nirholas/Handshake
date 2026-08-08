// Coin Wars store, the read/write half of the war league.
//
// Three surfaces live here, all serving /api/wars:
//
//   1. The BATTLE LEDGER (Postgres, `clash_battles`). The game server posts one
//      row per finished battle; the standings are RECOMPUTED from those rows with
//      the pure Elo math in multiplayer/src/war-standings.js. That module is
//      imported, never re-implemented, so the ratings the portal board shows are
//      the same numbers the arena computed.
//   2. The MATCHMAKING QUEUE (Redis). Two communities queueing from their own
//      worlds are paired by war-matchmaking.js and handed one matchKey.
//   3. The LIVE REGISTRY (Redis). ClashRoom publishes a snapshot of every running
//      battle (multiplayer/src/war-live.js writes the same keys this reads), so
//      the portal can spectate a war with a cheap poll instead of joining the
//      arena room.
//
// The DB is required for the ledger; Redis is required for the queue and live
// spectating. Each degrades independently and honestly: no Redis means "wars
// can't be queued right now" rather than a 500, and no DB means empty standings.

import { sql } from './db.js';
import { getRedis } from './redis.js';
import { computeStandings } from '../../multiplayer/src/war-standings.js';
import { joinQueue, leaveQueue, waitingCommunities, QUEUE_TTL_MS } from '../../multiplayer/src/war-matchmaking.js';

// How many battles the standings fold reads. Elo is path-dependent, so a rebuild
// is only exact over the full ledger; in practice the ladder is young and this
// bound is far above the row count. When it is ever exceeded the oldest battles
// fall out of the window, which is a deliberate, documented rolling season rather
// than a silent truncation (the response carries `battlesRead` so a caller can
// see the window was hit).
const STANDINGS_WINDOW = 2000;
const RECENT_DEFAULT = 12;
const RECENT_MAX = 50;

// Redis keys. Shared verbatim with multiplayer/src/war-live.js, the game server
// writes these, this module reads them, exactly like feed.js / presence-store.js.
const LIVE_KEY = (matchKey) => `wars:live:${matchKey}`;
const LIVE_INDEX = 'wars:live:index';
const QUEUE_KEY = (network) => `wars:queue:${network}`;
const QUEUE_LOCK = (network) => `wars:queue:lock:${network}`;

// A live snapshot older than this is a room that died without cleaning up.
const LIVE_STALE_MS = 120_000;

// ── the battle ledger ────────────────────────────────────────────────────────

/**
 * Persist one finished battle. Called by the game server over an HMAC-signed
 * POST. Idempotent on matchKey: a retry of the same report updates the row
 * instead of double-counting a battle into the league.
 * @param {object} battle ClashMatch.result() enriched with { matchKey, network }
 * @returns {Promise<{ok:true, matchKey:string}>}
 */
export async function recordBattle(battle) {
	const row = normalizeBattle(battle);
	if (!row) throw new BattleShapeError('battle must name two distinct communities and a matchKey');

	await sql`
		insert into clash_battles (
			match_key, network, winner_mint, reason, duration_ms,
			a_mint, a_name, a_symbol, a_score, a_kills, a_deaths,
			b_mint, b_name, b_symbol, b_score, b_kills, b_deaths,
			mvp, ended_at
		) values (
			${row.matchKey}, ${row.network}, ${row.winnerMint}, ${row.reason}, ${row.durationMs},
			${row.a.mint}, ${row.a.name}, ${row.a.symbol}, ${row.a.score}, ${row.a.kills}, ${row.a.deaths},
			${row.b.mint}, ${row.b.name}, ${row.b.symbol}, ${row.b.score}, ${row.b.kills}, ${row.b.deaths},
			${row.mvp ? JSON.stringify(row.mvp) : null}, to_timestamp(${row.endedAt} / 1000.0)
		)
		on conflict (match_key) do update set
			winner_mint = excluded.winner_mint,
			reason      = excluded.reason,
			duration_ms = excluded.duration_ms,
			a_name = excluded.a_name, a_symbol = excluded.a_symbol,
			a_score = excluded.a_score, a_kills = excluded.a_kills, a_deaths = excluded.a_deaths,
			b_name = excluded.b_name, b_symbol = excluded.b_symbol,
			b_score = excluded.b_score, b_kills = excluded.b_kills, b_deaths = excluded.b_deaths,
			mvp = excluded.mvp,
			ended_at = excluded.ended_at
	`;
	return { ok: true, matchKey: row.matchKey };
}

export class BattleShapeError extends Error {}

/**
 * Read the ledger for a network, newest first. `mint` narrows to one community's
 * battle log (either side of the fixture).
 * @returns {Promise<Array<object>>} battle rows in the client-facing shape
 */
export async function listBattles({ network = 'mainnet', mint = '', limit = RECENT_DEFAULT } = {}) {
	const n = Math.max(1, Math.min(RECENT_MAX, Number(limit) || RECENT_DEFAULT));
	const rows = mint
		? await sql`
			select * from clash_battles
			where network = ${network} and (a_mint = ${mint} or b_mint = ${mint})
			order by ended_at desc limit ${n}`
		: await sql`
			select * from clash_battles
			where network = ${network}
			order by ended_at desc limit ${n}`;
	return rows.map(toBattleCard);
}

/**
 * The league table. Folds the ledger through the SAME Elo math the arena's own
 * league module owns, so a rating shown in the world is never a second opinion.
 * @returns {Promise<{standings:Array<object>, battlesRead:number, windowFull:boolean}>}
 */
export async function readStandings({ network = 'mainnet' } = {}) {
	// Chronological order matters for Elo, so read the newest window and let the
	// fold sort it; computeStandings() re-sorts by endedAt itself.
	const rows = await sql`
		select winner_mint, a_mint, a_name, a_symbol, a_kills, a_deaths,
		       b_mint, b_name, b_symbol, b_kills, b_deaths,
		       extract(epoch from ended_at) * 1000 as ended_ms
		from clash_battles
		where network = ${network}
		order by ended_at desc
		limit ${STANDINGS_WINDOW}
	`;
	const battles = rows.map((r) => ({
		winner: r.winner_mint || 'draw',
		endedAt: Number(r.ended_ms) || 0,
		factions: [
			{ mint: r.a_mint, name: r.a_name, symbol: r.a_symbol, kills: r.a_kills | 0, deaths: r.a_deaths | 0 },
			{ mint: r.b_mint, name: r.b_name, symbol: r.b_symbol, kills: r.b_kills | 0, deaths: r.b_deaths | 0 },
		],
	}));
	return {
		standings: computeStandings(battles),
		battlesRead: battles.length,
		windowFull: battles.length >= STANDINGS_WINDOW,
	};
}

// ── the live registry ────────────────────────────────────────────────────────

/**
 * Every battle currently running, newest heartbeat first. `mint` narrows to wars
 * one community is fighting in, which is what the portal board asks for.
 * Returns [] (never throws) when Redis is unavailable, a missing spectator feed
 * must not take down the standings board it sits beside.
 */
export async function readLiveMatches({ network = 'mainnet', mint = '' } = {}) {
	const redis = getRedis();
	if (!redis) return [];
	try {
		const cutoff = Date.now() - LIVE_STALE_MS;
		const keys = await redis.zrange(LIVE_INDEX, cutoff, '+inf', { byScore: true });
		if (!keys?.length) return [];
		const raw = await Promise.all(keys.slice(0, 40).map((k) => redis.get(LIVE_KEY(k))));
		const out = [];
		for (const item of raw) {
			const snap = parseSnapshot(item);
			if (!snap) continue;
			if (snap.network !== network) continue;
			if (mint && snap.a?.mint !== mint && snap.b?.mint !== mint) continue;
			out.push(snap);
		}
		out.sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0));
		return out;
	} catch {
		return [];
	}
}

// ── the matchmaking queue ────────────────────────────────────────────────────

// Raised when the queue cannot be served at all (no Redis). The endpoint turns
// this into a designed "matchmaking is offline" state rather than a 500.
export class QueueUnavailableError extends Error {}

/**
 * Put a community in line for a war, pairing it with a waiting one if there is
 * one. Held under a short lock so two players pressing "enter the war" in
 * different worlds at the same instant cannot mint two different keys for what
 * should be one battle.
 * @returns {Promise<{status:string, matchKey:string|null, opponent:object|null, side:string|null, waiting:number}>}
 */
export async function queueForWar({ coin, network = 'mainnet' }) {
	const redis = requireRedis();
	const release = await acquireQueueLock(redis, network);
	try {
		const stored = await readQueue(redis, network);
		const now = Date.now();
		const res = joinQueue({ queue: stored, coin, network, now });
		if (res.status !== 'invalid') await writeQueue(redis, network, res.queue);
		return {
			status: res.status,
			matchKey: res.matchKey,
			opponent: res.opponent,
			side: res.side,
			waiting: res.waiting,
		};
	} finally {
		await release();
	}
}

/** Take a community out of the queue (the player closed the portal). */
export async function leaveWarQueue({ mint, network = 'mainnet' }) {
	const redis = getRedis();
	if (!redis) return { ok: true, waiting: 0 };
	const release = await acquireQueueLock(redis, network);
	try {
		const stored = await readQueue(redis, network);
		const next = leaveQueue({ queue: stored, mint, now: Date.now() });
		await writeQueue(redis, network, next);
		return { ok: true, waiting: next.filter((e) => !e.matchKey).length };
	} finally {
		await release();
	}
}

/** Communities standing in line right now, for the portal's "waiting" state. */
export async function readQueueBoard({ network = 'mainnet' } = {}) {
	const redis = getRedis();
	if (!redis) return { available: false, waiting: [] };
	try {
		const stored = await readQueue(redis, network);
		return { available: true, waiting: waitingCommunities({ queue: stored, network, now: Date.now() }) };
	} catch {
		return { available: false, waiting: [] };
	}
}

// ── internals ────────────────────────────────────────────────────────────────

function requireRedis() {
	const redis = getRedis();
	if (!redis) throw new QueueUnavailableError('war matchmaking needs Redis and it is not configured');
	return redis;
}

// A best-effort mutex. Upstash SET NX PX is atomic, so at most one writer holds
// the queue at a time; if the lock cannot be taken within the retry budget we
// proceed anyway rather than refusing the player, the worst case is the same
// unpaired-this-poll outcome they would get from an empty queue, and the next
// poll pairs them.
async function acquireQueueLock(redis, network) {
	const key = QUEUE_LOCK(network);
	const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	for (let i = 0; i < 6; i++) {
		try {
			const got = await redis.set(key, token, { nx: true, px: 3000 });
			if (got) {
				return async () => {
					try {
						// Only clear our own lock: a lock that already expired may now
						// belong to another writer.
						if ((await redis.get(key)) === token) await redis.del(key);
					} catch { /* the PX expiry is the backstop */ }
				};
			}
		} catch {
			break;
		}
		await sleep(60);
	}
	return async () => {};
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

async function readQueue(redis, network) {
	const raw = await redis.hgetall(QUEUE_KEY(network));
	if (!raw) return [];
	const out = [];
	for (const value of Object.values(raw)) {
		const entry = typeof value === 'string' ? safeParse(value) : value;
		if (entry && typeof entry === 'object' && typeof entry.mint === 'string') out.push(entry);
	}
	return out;
}

async function writeQueue(redis, network, entries) {
	const key = QUEUE_KEY(network);
	const next = new Map(entries.map((e) => [e.mint, e]));
	const existing = await redis.hkeys(key).catch(() => []);
	const gone = (existing || []).filter((mint) => !next.has(mint));
	if (gone.length) await redis.hdel(key, ...gone);
	if (next.size) {
		const payload = {};
		for (const [mint, entry] of next) payload[mint] = JSON.stringify(entry);
		await redis.hset(key, payload);
	}
	// The whole queue is short-lived state; expire the hash a little past the
	// longest entry lifetime so an abandoned network's key cannot linger forever.
	await redis.expire(key, Math.ceil((QUEUE_TTL_MS * 10) / 1000));
}

function parseSnapshot(value) {
	const snap = typeof value === 'string' ? safeParse(value) : value;
	if (!snap || typeof snap !== 'object' || !snap.matchKey) return null;
	if (Date.now() - (Number(snap.updatedAt) || 0) > LIVE_STALE_MS) return null;
	return snap;
}

function safeParse(s) {
	try { return JSON.parse(s); } catch { return null; }
}

// The client-facing shape of one finished battle. Flat and already-formatted
// enough that both the portal board and the arena page render it without a
// second pass.
function toBattleCard(r) {
	const endedAt = r.ended_at instanceof Date ? r.ended_at.getTime() : new Date(r.ended_at).getTime();
	return {
		matchKey: r.match_key,
		network: r.network,
		winner: r.winner_mint || 'draw',
		reason: r.reason,
		durationMs: r.duration_ms | 0,
		endedAt: Number.isFinite(endedAt) ? endedAt : 0,
		a: { mint: r.a_mint, name: r.a_name, symbol: r.a_symbol, score: r.a_score | 0, kills: r.a_kills | 0, deaths: r.a_deaths | 0 },
		b: { mint: r.b_mint, name: r.b_name, symbol: r.b_symbol, score: r.b_score | 0, kills: r.b_kills | 0, deaths: r.b_deaths | 0 },
		mvp: r.mvp || null,
	};
}

// Validate + flatten a reported result into ledger columns. The report arrives
// HMAC-signed from the game server, so this guards shape (a schema drift or a
// half-built match), not trust.
function normalizeBattle(battle) {
	if (!battle || typeof battle !== 'object') return null;
	const factions = Array.isArray(battle.factions) ? battle.factions : [];
	if (factions.length !== 2) return null;
	const [fa, fb] = factions;
	const aMint = str(fa?.mint, 64);
	const bMint = str(fb?.mint, 64);
	const matchKey = str(battle.matchKey, 160);
	if (!aMint || !bMint || aMint === bMint || !matchKey) return null;

	const winner = str(battle.winner, 64);
	return {
		matchKey,
		network: str(battle.network, 12) || 'mainnet',
		winnerMint: winner && winner !== 'draw' ? winner : null,
		reason: str(battle.reason, 24) || 'score_cap',
		durationMs: int(battle.durationMs),
		endedAt: Number.isFinite(Number(battle.endedAt)) && Number(battle.endedAt) > 0 ? Number(battle.endedAt) : Date.now(),
		a: side(fa),
		b: side(fb),
		mvp: battle.mvp && typeof battle.mvp === 'object' ? battle.mvp : null,
	};
}

function side(f) {
	return {
		mint: str(f?.mint, 64),
		name: str(f?.name, 48),
		symbol: str(f?.symbol, 16),
		score: int(f?.score),
		kills: int(f?.kills),
		deaths: int(f?.deaths),
	};
}

function str(v, max) {
	return typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, '').trim().slice(0, max) : '';
}

function int(v) {
	const n = Number(v);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
