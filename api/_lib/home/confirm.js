// The confirmation record: a physical action, frozen server-side, waiting for a
// human to say yes.
//
// This is the module that carries the safety gate's verdict across the model
// boundary. Everything about it is shaped by one requirement: a fully hijacked
// language model must not be able to open a door. That gives three rules, and
// every function here exists to hold one of them.
//
//   1. The model never satisfies a confirmation. It cannot even express one:
//      the tool schemas in api/_lib/home/tools.js carry no `confirmed` property,
//      so there is no field for a model to set. Redemption happens through
//      api/home/[id]/confirm.js, which is session-and-CSRF only and which no
//      model or bearer principal can reach.
//
//   2. What the human is shown is what executes. The resolved domain, service,
//      service data and entity ids are frozen into the row at mint time and read
//      back from the row at redemption. `claimConfirmation` takes an id and
//      nothing else, so there is no argument a caller could re-send to steer a
//      confirmation minted for the office door onto the front door.
//
//   3. One confirmation, one action, ninety seconds. Single use is enforced by
//      an atomic claim (UPDATE ... WHERE redeemed_at IS NULL RETURNING), not by
//      a read followed by a write, because two requests racing a replay must not
//      both win.
//
// The TTL is deliberately short. This is a person standing in front of a door
// deciding whether to open it; ninety seconds is how long that takes. A flow
// that genuinely needs longer (a confirmation pushed to a phone in another
// room) is a different record with its own lifetime, never a laxer default here.

import { sql } from '../db.js';
import { withDbRetry } from '../db-retry.js';
import { logHomeAction } from './store.js';

/** How long a human has to answer. See the note above before changing it. */
export const CONFIRMATION_TTL_MS = 90_000;

/** Surfaces allowed to mint one, matching the schema's check constraint. */
const SOURCES = new Set(['chat', 'mcp', 'voice', 'api']);

/** Everything a caller may read back. There is nothing secret here by design. */
const CONFIRMATION_COLUMNS = sql`
	id, home_id, user_id, domain, service, service_data, entity_ids,
	risk, summary, source, expires_at, redeemed_at, redeemed_by,
	expired_at, outcome, created_at
`;

/**
 * Freeze a guarded action and return the ticket a human can redeem.
 *
 * The summary is the sentence the person actually reads before they decide, so
 * it is composed here from the resolved entities and their friendly names. It is
 * never model output: the whole point of the gate is that the human is told what
 * will really happen, not what a model said would happen.
 *
 * @param {object} input
 * @param {string} input.homeId
 * @param {string} input.userId the principal that asked; only they may redeem
 * @param {string} input.domain resolved Home Assistant domain, e.g. "lock"
 * @param {string} input.service resolved service, e.g. "unlock"
 * @param {object} [input.serviceData] the exact payload that will be sent
 * @param {string[]} [input.entityIds] the targets the gate resolved
 * @param {'security'|'physical'|null} [input.risk]
 * @param {string} input.summary plain language, server-composed
 * @param {'chat'|'mcp'|'voice'|'api'} [input.source]
 * @param {'user'|'agent'|'voice'|'mcp'|'automation'} [input.actor] for the log row
 * @returns {Promise<object>} the pending confirmation, safe to hand to a client
 */
export async function mintConfirmation({
	homeId,
	userId,
	domain,
	service,
	serviceData = {},
	entityIds = [],
	risk = null,
	summary,
	source = 'api',
	actor = 'agent',
}) {
	if (!homeId) throw new Error('mintConfirmation: homeId is required');
	if (!userId) throw new Error('mintConfirmation: userId is required');
	if (!domain || !service) throw new Error('mintConfirmation: a resolved domain and service are required');
	if (!summary) throw new Error('mintConfirmation: a plain-language summary is required');
	const src = SOURCES.has(source) ? source : 'api';

	const rows = await withDbRetry(
		() => sql`
			insert into home_confirmations
				(home_id, user_id, domain, service, service_data, entity_ids, risk, summary, source, expires_at)
			values
				(${homeId}, ${userId}, ${domain}, ${service},
				 ${JSON.stringify(serviceData || {})}::jsonb, ${entityIds.map(String)},
				 ${risk}, ${summary}, ${src}, now() + ${`${Math.round(CONFIRMATION_TTL_MS / 1000)} seconds`}::interval)
			returning ${CONFIRMATION_COLUMNS}
		`,
	);

	const row = rows[0];

	// The refusal is itself an event worth keeping: an operator reviewing an
	// incident needs to see that something asked to open a door, not only the
	// times somebody said yes.
	logHomeAction({
		homeId,
		userId,
		actor,
		channel: 'websocket',
		action: `${domain}.${service}`,
		entityIds,
		guarded: true,
		risk,
		outcome: 'refused',
		detail: { reason: 'awaiting_confirmation', confirmation_id: row.id, source: src },
	});

	return shape(row);
}

/**
 * Claim a confirmation for execution. Atomic, single use, and the only way a
 * frozen action ever comes back out.
 *
 * The claim marks the row spent BEFORE the action runs, not after. If Home
 * Assistant then refuses the call, the confirmation is still spent and the user
 * asks again: a ticket that survived a failed attempt would be a ticket a
 * network blip could replay.
 *
 * Failure is a discriminated result rather than a throw, because the four ways
 * this fails need four different sentences and only one of them is an error:
 *
 *   not_found  no such pending confirmation for this user and this home. Covers
 *              a wrong user and a wrong home id deliberately, so neither can be
 *              used to learn that a confirmation id is real.
 *   expired    it existed and the ninety seconds ran out.
 *   spent      it existed and was already redeemed. This is the replay case.
 *
 * @param {{ id: string, homeId: string, userId: string }} input
 * @returns {Promise<{ ok: boolean, reason?: string, message?: string, confirmation?: object }>}
 */
export async function claimConfirmation({ id, homeId, userId }) {
	if (!id || !homeId || !userId) {
		return { ok: false, reason: 'not_found', message: 'That confirmation is not waiting for you.' };
	}

	const rows = await withDbRetry(
		() => sql`
			update home_confirmations
			set redeemed_at = now(), redeemed_by = ${userId}
			where id = ${id}
			  and home_id = ${homeId}
			  and user_id = ${userId}
			  and redeemed_at is null
			  and expired_at is null
			  and expires_at > now()
			returning ${CONFIRMATION_COLUMNS}
		`,
	).catch(() => []);

	if (rows[0]) return { ok: true, confirmation: shape(rows[0]) };

	// Nothing was claimed. Read back under the SAME ownership filter to tell the
	// three refusals apart without ever answering a question about somebody
	// else's confirmation.
	const [existing] = await sql`
		select ${CONFIRMATION_COLUMNS}
		from home_confirmations
		where id = ${id} and home_id = ${homeId} and user_id = ${userId}
	`.catch(() => []);

	if (!existing) {
		return { ok: false, reason: 'not_found', message: 'That confirmation is not waiting for you.' };
	}
	if (existing.redeemed_at) {
		const spent = shape(existing);
		logHomeAction({
			homeId,
			userId,
			actor: 'user',
			channel: 'websocket',
			action: `${existing.domain}.${existing.service}`,
			entityIds: existing.entity_ids || [],
			guarded: true,
			risk: existing.risk,
			outcome: 'refused',
			detail: { reason: 'confirmation_replayed', confirmation_id: existing.id },
		});
		return {
			ok: false,
			reason: 'spent',
			message: 'That confirmation was already used. Ask again to get a new one.',
			confirmation: spent,
		};
	}

	// Expired, or swept. Either way the row is retired here so the expiry is
	// recorded exactly once even if the sweep has not reached it yet.
	await retireExpired(existing);
	return {
		ok: false,
		reason: 'expired',
		message: `That confirmation expired after ${Math.round(CONFIRMATION_TTL_MS / 1000)} seconds. Ask again.`,
		confirmation: shape(existing),
	};
}

/**
 * Record what happened after a claimed confirmation ran. A confirmed unlock that
 * Home Assistant then refused is a materially different event from one that
 * opened a door, and the log has to be able to tell them apart.
 *
 * @param {string} id
 * @param {'ok'|'failed'} outcome
 */
export async function finalizeConfirmation(id, outcome) {
	if (!id || (outcome !== 'ok' && outcome !== 'failed')) return null;
	const rows = await sql`
		update home_confirmations set outcome = ${outcome}
		where id = ${id} and redeemed_at is not null
		returning ${CONFIRMATION_COLUMNS}
	`.catch(() => []);
	return rows[0] ? shape(rows[0]) : null;
}

/**
 * Retire every confirmation nobody answered, and write the log row each one
 * earns. An expiry is not silence: "the agent asked to unlock the front door and
 * nobody answered" is exactly the kind of event a household wants to see, and it
 * is the signature of an injection attempt that got as far as the gate.
 *
 * Called opportunistically from the mint and redeem paths rather than from a
 * cron, so the sweep runs wherever the feature is actually being used and needs
 * no schedule of its own.
 *
 * @param {{ homeId?: string|null, limit?: number }} [options]
 * @returns {Promise<number>} how many were retired
 */
export async function expireStaleConfirmations({ homeId = null, limit = 200 } = {}) {
	const cap = Math.min(Math.max(Number(limit) || 200, 1), 1000);
	const rows = await withDbRetry(
		() =>
			homeId
				? sql`
					update home_confirmations set expired_at = now()
					where id in (
						select id from home_confirmations
						where home_id = ${homeId} and redeemed_at is null and expired_at is null and expires_at <= now()
						order by expires_at asc limit ${cap}
					)
					returning ${CONFIRMATION_COLUMNS}
				`
				: sql`
					update home_confirmations set expired_at = now()
					where id in (
						select id from home_confirmations
						where redeemed_at is null and expired_at is null and expires_at <= now()
						order by expires_at asc limit ${cap}
					)
					returning ${CONFIRMATION_COLUMNS}
				`,
	).catch(() => []);

	for (const row of rows) logExpiry(row);
	return rows.length;
}

/** Confirmations still waiting for this user in this home, newest first. */
export async function listPendingConfirmations({ homeId, userId, limit = 20 }) {
	if (!homeId || !userId) return [];
	const cap = Math.min(Math.max(Number(limit) || 20, 1), 100);
	const rows = await sql`
		select ${CONFIRMATION_COLUMNS}
		from home_confirmations
		where home_id = ${homeId} and user_id = ${userId}
		  and redeemed_at is null and expired_at is null and expires_at > now()
		order by created_at desc
		limit ${cap}
	`.catch(() => []);
	return rows.map(shape);
}

async function retireExpired(row) {
	const rows = await sql`
		update home_confirmations set expired_at = now()
		where id = ${row.id} and redeemed_at is null and expired_at is null
		returning id
	`.catch(() => []);
	if (rows.length) logExpiry(row);
}

function logExpiry(row) {
	logHomeAction({
		homeId: row.home_id,
		userId: row.user_id,
		actor: 'user',
		channel: 'websocket',
		action: `${row.domain}.${row.service}`,
		entityIds: row.entity_ids || [],
		guarded: true,
		risk: row.risk,
		outcome: 'refused',
		detail: { reason: 'confirmation_expired', confirmation_id: row.id, source: row.source },
	});
}

/**
 * The client-facing shape. `expires_in_seconds` is computed rather than stored
 * so a countdown in a chat card or a voice prompt never has to trust a clock it
 * does not own.
 */
function shape(row) {
	if (!row) return null;
	const expiresAt = row.expires_at ? new Date(row.expires_at) : null;
	return {
		id: row.id,
		home_id: row.home_id,
		domain: row.domain,
		service: row.service,
		service_data: row.service_data || {},
		entity_ids: row.entity_ids || [],
		risk: row.risk,
		summary: row.summary,
		source: row.source,
		expires_at: expiresAt ? expiresAt.toISOString() : null,
		expires_in_seconds: expiresAt ? Math.max(0, Math.round((expiresAt.getTime() - Date.now()) / 1000)) : 0,
		redeemed_at: row.redeemed_at ? new Date(row.redeemed_at).toISOString() : null,
		outcome: row.outcome || null,
		created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
	};
}
