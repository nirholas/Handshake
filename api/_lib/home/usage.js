/**
 * What an account has used this month, counted once.
 *
 * There is exactly one authoritative number per dimension and it lives in
 * `usage_events`, the platform's existing counter (api/_lib/usage.js). This
 * module does NOT introduce a second one. Two counters means two numbers that
 * disagree, and the one on the invoice is the one that will be wrong.
 *
 * What it does add is a read path fast enough to gate a request with, because
 * `recordEvent` is deliberately eventually consistent: it buffers into Redis and
 * a job drains the buffer into Postgres. Gating on a `select count(*)` alone
 * would let a burst through before the first row landed, and gating on a
 * separate tally would be the second counter we just refused. So:
 *
 *   * `usage_events` is the source of truth. The invoice reads it. `readUsage`
 *     reads it.
 *   * A Redis key per (account, dimension, month) CACHES that number and is
 *     incremented in lockstep with each `recordEvent`, so the very next gate
 *     check sees the event that was just recorded.
 *   * When the cache is cold it is SEEDED from `usage_events`, so it converges
 *     on the authoritative number rather than starting a private tally.
 *
 * The one place the two can disagree is a cache eviction while events are still
 * in the buffer: the re-seed misses them and the account is under-counted for
 * the rest of the month. That bias is deliberate and it is the same bias the
 * per-IP image quota already takes: a quota that errs must err toward serving
 * the user. Over-counting would refuse a person access to their own house over
 * a Redis hiccup, which is not a trade this lane is willing to make.
 *
 * Without Redis (local dev, tests) every read goes straight to `usage_events`.
 * Correct, just slower, and there is no cross-instance state to protect.
 */

import { sql } from '../db.js';
import { withDbRetry } from '../db-retry.js';
import { getRedis } from '../redis.js';
import { recordEvent } from '../usage.js';

import { quotaPeriod } from './entitlements.js';

/**
 * Which `usage_events` rows each metered dimension is made of.
 *
 * `agentTurns` deliberately has NO kind of its own. A conversation with the
 * agent already writes exactly one `kind: 'chat'` row carrying the provider, the
 * model, the token counts and the priced cost (api/chat.js), and that row is
 * what an invoice would charge for. Minting a `home.turn` row beside it would be
 * the second counter this module exists to refuse: two numbers, disagreeing, and
 * the one on the invoice wrong. So the home turn is the same row, distinguished
 * by the `home_id` api/chat.js stamps into its meta when a home tool ran.
 *
 * `voiceMinutes` does get its own kind, because nothing counts voice today: the
 * TTS and ASR lanes write no usage events at all. That is a new fact, not a
 * duplicated one.
 */
export const USAGE_SOURCES = Object.freeze({
	agentTurns: Object.freeze({
		kind: 'chat',
		// Only the turns that actually touched a house. A conversation about
		// nothing in particular is not a home turn and must not be billed as one.
		requiresMetaKey: 'home_id',
	}),
	voiceMinutes: Object.freeze({ kind: 'home.voice', requiresMetaKey: null }),
});

/** The dimension whose events this module mints itself. */
const OWN_KINDS = Object.freeze({ voiceMinutes: 'home.voice' });

/** Dimensions this module counts. The rest are live gauges, not accumulations. */
export const METERED_DIMENSIONS = Object.freeze(Object.keys(USAGE_SOURCES));

const CACHE_PREFIX = 'home:usage';

function cacheKey(userId, dimension, periodKey) {
	return `${CACHE_PREFIX}:${userId}:${dimension}:${periodKey}`;
}

/** Seconds from now to the end of the quota period, plus a day of clock slack. */
function ttlSeconds(period, now = new Date()) {
	return Math.max(60, Math.ceil((period.end.getTime() - now.getTime()) / 1000) + 86_400);
}

/**
 * Count one unit of usage, in both places, in that order.
 *
 * The durable write goes first (it is fire-and-forget and cannot fail the
 * caller) and the cache bump second, so a cache that is unreachable costs
 * accuracy on the next gate check and never costs a billing row.
 *
 * @param {object} input
 * @param {string} input.userId
 * @param {'agentTurns'|'voiceMinutes'} input.dimension
 * @param {number} [input.amount] units consumed; voice is counted in minutes,
 *   fractional, and rounded up only at the gate so a 20 second utterance is not
 *   billed as a minute.
 * @param {string|null} [input.homeId]
 * @param {object} [input.meta] anything worth answering a support question with.
 *   Never a credential, never a full state dump.
 */
export async function recordHomeUsage({ userId, dimension, amount = 1, homeId = null, meta = {} }) {
	if (!userId) return;
	const kind = OWN_KINDS[dimension];
	if (!kind) {
		throw new Error(
			`recordHomeUsage: "${dimension}" is not a dimension this module mints. ` +
			'Agent turns are counted from the chat row api/chat.js already writes; do not mint a second one.',
		);
	}

	recordEvent({
		userId,
		kind,
		tool: homeId ? `home:${homeId}` : null,
		meta: { ...meta, amount, dimension },
		provider: meta.provider ?? null,
		model: meta.model ?? null,
		inputTokens: meta.inputTokens ?? null,
		outputTokens: meta.outputTokens ?? null,
		costMicroUsd: meta.costMicroUsd ?? null,
	});

	const redis = getRedis();
	if (!redis) return;
	const period = quotaPeriod();
	const key = cacheKey(userId, dimension, period.key);
	try {
		// Seed before the increment, or the increment starts a private tally from
		// zero and the cache never converges on the authoritative number.
		await ensureSeeded(redis, key, userId, dimension, period);
		await redis.incrbyfloat(key, amount);
	} catch {
		// The durable row is already written. A cache miss costs precision on the
		// next gate check, which the module's header accepts by design.
	}
}

/**
 * The authoritative count for one dimension this period, straight from
 * `usage_events`. This is the number the invoice would use.
 *
 * @param {string} userId
 * @param {string} dimension
 * @param {{ start: Date, end: Date }} period
 * @returns {Promise<number>}
 */
export async function readUsageFromEvents(userId, dimension, period = quotaPeriod()) {
	const source = USAGE_SOURCES[dimension];
	if (!source) return 0;
	// `amount` is how a fractional unit (a 20 second utterance is a third of a
	// voice minute) survives into the sum; a row without one is one unit, which is
	// what every chat row is.
	const rows = await withDbRetry(() => sql`
		select coalesce(sum(coalesce((meta->>'amount')::numeric, 1)), 0)::float8 as total
		from usage_events
		where user_id = ${userId}
		  and kind = ${source.kind}
		  and (${source.requiresMetaKey}::text is null or meta ? ${source.requiresMetaKey}::text)
		  and created_at >= ${period.start.toISOString()}
		  and created_at <  ${period.end.toISOString()}
	`);
	return Number(rows[0]?.total) || 0;
}

async function ensureSeeded(redis, key, userId, dimension, period) {
	const existing = await redis.get(key);
	if (existing != null) return Number(existing) || 0;
	const seed = await readUsageFromEvents(userId, dimension, period);
	// SET NX so two instances seeding the same cold key at once cannot double it.
	await redis.set(key, seed, { nx: true, ex: ttlSeconds(period) });
	const settled = await redis.get(key);
	return Number(settled ?? seed) || 0;
}

/**
 * One dimension's usage for the gate: the cache when it is warm, the
 * authoritative table when it is not.
 *
 * @param {string} userId
 * @param {string} dimension
 * @param {{ start: Date, end: Date, key: string }} [period]
 * @returns {Promise<number>}
 */
export async function readUsage(userId, dimension, period = quotaPeriod()) {
	if (!userId) return 0;
	const redis = getRedis();
	if (!redis) return readUsageFromEvents(userId, dimension, period);
	try {
		return await ensureSeeded(redis, cacheKey(userId, dimension, period.key), userId, dimension, period);
	} catch {
		return readUsageFromEvents(userId, dimension, period);
	}
}

/**
 * Every dimension at once, for the manage surface and for the gate.
 *
 * The live gauges (`homes`, `streams`, `members`, `relayConnections`) are counted
 * from their own tables rather than from an event stream, because a gauge that is
 * reconstructed from a log of opens and closes is a gauge that drifts the first
 * time a process dies holding a socket.
 *
 * @param {string} userId
 * @param {object} [opts]
 * @param {number|null} [opts.streams] live SSE subscribers for this account, from
 *   the runtime, when the caller has it. Omitted rather than guessed.
 * @returns {Promise<Record<string, number>>}
 */
export async function readHomeUsage(userId, { streams = null } = {}) {
	const period = quotaPeriod();
	const [agentTurns, voiceMinutes, gauges] = await Promise.all([
		readUsage(userId, 'agentTurns', period),
		readUsage(userId, 'voiceMinutes', period),
		readGauges(userId),
	]);
	return {
		agentTurns,
		voiceMinutes: Math.round(voiceMinutes * 100) / 100,
		...gauges,
		streams: streams == null ? 0 : streams,
	};
}

/**
 * The concurrent counts, read from the tables that own them.
 * @param {string} userId
 */
async function readGauges(userId) {
	const rows = await withDbRetry(() => sql`
		select
			count(*) filter (where c.revoked_at is null and c.deactivated_at is null)::int as homes,
			count(*) filter (where c.revoked_at is null and c.deactivated_at is null and c.transport = 'relay')::int as relay_connections,
			coalesce(max(m.members), 0)::int as members,
			-- The longest retention any of this account's homes is set to. That is
			-- the number the plan's ceiling is a ceiling on, and the one that would
			-- be refused if the user raised it further.
			coalesce(max(c.action_log_retention_days) filter (where c.revoked_at is null), 0)::int as log_retention_days
		from home_connections c
		left join lateral (
			select count(*)::int as members from home_members hm where hm.home_id = c.id
		) m on true
		where c.user_id = ${userId}
	`);
	const row = rows[0] || {};
	return {
		homes: row.homes ?? 0,
		relayConnections: row.relay_connections ?? 0,
		// The members limit is per home, so the account-level figure the manage
		// surface shows is the fullest household: that is the one that would be
		// refused an invite, and therefore the one worth showing.
		members: row.members ?? 0,
		logRetentionDays: row.log_retention_days ?? 0,
	};
}

/**
 * Reset a cached counter so the next read re-seeds from `usage_events`.
 * Used by the tests and by an admin correcting a miscount; never on a hot path.
 * @param {string} userId
 * @param {string} dimension
 */
export async function invalidateUsageCache(userId, dimension) {
	const redis = getRedis();
	if (!redis) return;
	const period = quotaPeriod();
	await redis.del(cacheKey(userId, dimension, period.key)).catch(() => {});
}
