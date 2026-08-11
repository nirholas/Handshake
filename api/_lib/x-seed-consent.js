/**
 * Revocation for X memory seeding.
 * --------------------------------
 * Three surfaces can end an X seeding grant, and all three have to mean the
 * same thing: the grant stops, and every memory it produced is gone.
 *
 *   - the owner revokes on one agent  (DELETE /api/agents/:id/memory/seed/x)
 *   - the owner disconnects X         (DELETE /api/x/status)
 *   - the owner reconnects a DIFFERENT X account (the OAuth callback)
 *
 * The delete matches on the `x_seed` tag rather than on the consent id, so
 * memories written before consents were recorded are purged too. Nothing
 * distilled from an X account outlives the permission to use it.
 */

import { sql } from './db.js';
import { X_SEED_TAG } from './x-memory-seed.js';

/**
 * Delete every seeded memory on one agent.
 * @returns {Promise<number>} rows deleted
 */
export async function deleteSeededMemories(agentId) {
	const rows = await sql`
		DELETE FROM agent_memories
		WHERE agent_id = ${agentId} AND tags && ARRAY[${X_SEED_TAG}]::text[]
		RETURNING id
	`;
	await sql`
		UPDATE agent_identities
		SET x_username = NULL, x_seeded_at = NULL
		WHERE id = ${agentId}
	`;
	return rows.length;
}

/**
 * Revoke one agent's live grant (if any) and delete what it produced.
 * Idempotent: an agent with no grant still gets its seeded rows purged.
 *
 * @returns {Promise<{deleted: number, consents: number}>}
 */
export async function revokeAgentSeedConsent(agentId, reason) {
	const consents = await sql`
		UPDATE x_memory_consents
		SET revoked_at = now(), revoked_reason = ${reason}
		WHERE agent_id = ${agentId} AND revoked_at IS NULL
		RETURNING id
	`;
	return { consents: consents.length, deleted: await deleteSeededMemories(agentId) };
}

/**
 * Revoke every live grant a user holds and delete the seeded memories across
 * all of their agents. Used when the X connection itself goes away, so a
 * disconnect can never leave distilled posts behind on an agent the owner
 * forgot about.
 *
 * @returns {Promise<{deleted: number, consents: number, agents: number}>}
 */
export async function revokeAllSeedConsentsForUser(userId, reason) {
	const consents = await sql`
		UPDATE x_memory_consents
		SET revoked_at = now(), revoked_reason = ${reason}
		WHERE user_id = ${userId} AND revoked_at IS NULL
		RETURNING agent_id
	`;

	const deleted = await sql`
		DELETE FROM agent_memories
		WHERE tags && ARRAY[${X_SEED_TAG}]::text[]
		  AND agent_id IN (SELECT id FROM agent_identities WHERE user_id = ${userId})
		RETURNING agent_id
	`;

	await sql`
		UPDATE agent_identities
		SET x_username = NULL, x_seeded_at = NULL
		WHERE user_id = ${userId} AND (x_username IS NOT NULL OR x_seeded_at IS NOT NULL)
	`;

	return {
		consents: consents.length,
		deleted: deleted.length,
		agents: new Set(deleted.map((r) => r.agent_id)).size,
	};
}
