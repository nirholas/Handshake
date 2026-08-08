// Event leaderboard, durable storage for the live event quest line's standing.
//
// The authoritative game server (multiplayer WalkRoom) reports every finished event
// quest here through api/internal/event-score.js; api/play/event-leaderboard.js and
// the in-world panel read the ranked table back. The ranking itself lives in
// multiplayer/src/event-leaderboard.js so both sides sort identically, this module
// is purely the store.
//
// Shape: one Redis HASH per event (`event:lb:<eventId>`), field = the player's
// account key, value = the JSON record. A HASH (rather than the ZSET clash-store
// uses) because a row carries more than a score, display name, cash earned, the
// per-mission breakdown, the timestamp that breaks ties, and the population is one
// event's worth of players, small enough that HGETALL plus an in-process sort is a
// single cheap round-trip. Distinct accounts write distinct fields, and one account
// can only be in one live session (playerStore enforces that upstream), so a per-
// field read-modify-write never races with itself.
//
// The key carries a TTL a few days past the event so the store self-prunes: the
// standing outlives the event long enough for the owner to settle prizes, then goes
// away on its own with no sweeper.
//
// Redis being unconfigured (local dev, tests) or failing at call time degrades to an
// in-process table with the same semantics, exactly like clash-store: a briefly
// non-durable leaderboard beats a 5xx that takes the panel dark mid-event.

import { getRedis } from './redis.js';
import { applyEventRun, emptyEventRecord, normalizeEventRecord } from '../../multiplayer/src/event-leaderboard.js';

const redis = getRedis();

// Keep a finished event's standing around for a week, long enough for the owner to
// read the winners off it and settle prizes by hand.
export const BOARD_TTL_S = 7 * 24 * 60 * 60;

const EVENT_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const ACCOUNT_RE = /^[A-Za-z0-9_:.-]{1,96}$/;

function boardKey(eventId) {
	return `event:lb:${eventId}`;
}

export function isValidEventId(id) {
	return typeof id === 'string' && EVENT_ID_RE.test(id);
}

export function isValidAccount(id) {
	return typeof id === 'string' && ACCOUNT_RE.test(id);
}

// --- in-memory fallback ------------------------------------------------------
const mem = new Map(); // key → Map(account → record)

function memBoard(key) {
	let m = mem.get(key);
	if (!m) { m = new Map(); mem.set(key, m); }
	return m;
}

let _degradedAt = 0;
function redisDegraded(err) {
	const now = Date.now();
	if (now - _degradedAt > 60_000) {
		_degradedAt = now;
		console.warn('[event-leaderboard] redis degraded, serving from in-memory fallback:', err?.message || err);
	}
}

function parseRecord(raw, account) {
	if (!raw) return null;
	try {
		const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
		return obj && typeof obj === 'object' ? normalizeEventRecord(obj, account) : null;
	} catch {
		return null;
	}
}

// --- writes ------------------------------------------------------------------

/**
 * Fold one finished event quest into a player's row and return the updated record.
 * Idempotent per call, not per mission: each completion is a real, separate run, so
 * a player who finishes the same repeatable job three times scores three.
 *
 * @param {{ eventId: string, account: string, name?: string, missionId?: string, gold?: number, at?: number }} run
 * @returns {Promise<{ record: object, durable: boolean }>}
 */
export async function recordEventRun({ eventId, account, name = '', missionId = '', gold = 0, at = Date.now() }) {
	const key = boardKey(eventId);

	if (redis) {
		try {
			const existing = parseRecord(await redis.hget(key, account), account);
			const rec = applyEventRun(existing || emptyEventRecord(account, name), { missionId, gold, at, name });
			await redis.hset(key, { [account]: JSON.stringify(rec) });
			await redis.expire(key, BOARD_TTL_S);
			return { record: rec, durable: true };
		} catch (err) {
			redisDegraded(err);
		}
	}

	const board = memBoard(key);
	const rec = applyEventRun(board.get(account) || emptyEventRecord(account, name), { missionId, gold, at, name });
	board.set(account, rec);
	return { record: rec, durable: false };
}

// --- reads -------------------------------------------------------------------

/**
 * Every recorded row for an event, unranked (callers fold them through
 * rankEventBoard / eventBoardView). Returns an empty array for an event nobody has
 * scored in yet, which is the leaderboard's designed empty state, never an error.
 *
 * @returns {Promise<{ records: object[], durable: boolean }>}
 */
export async function readEventRecords(eventId) {
	const key = boardKey(eventId);

	if (redis) {
		try {
			const all = await redis.hgetall(key);
			const records = Object.entries(all || {})
				.map(([account, raw]) => parseRecord(raw, account))
				.filter(Boolean);
			return { records, durable: true };
		} catch (err) {
			redisDegraded(err);
		}
	}

	return { records: [...memBoard(key).values()], durable: false };
}

// Test seam: clear the in-process fallback between cases.
export function __resetEventBoards() {
	mem.clear();
}
