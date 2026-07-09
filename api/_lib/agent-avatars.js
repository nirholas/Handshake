// Agent → avatar backfill.
//
// Roughly 44% of agent_identities rows shipped with `avatar_id = NULL`: the
// minimal auto-provision path (api/agents.js), external registrations
// (api/agents/register), swarm treasuries, and x402 ring agents all create
// agents without a body. Those agents can never show a preview on the /agents
// directory, the marketplace, or their profile — the card falls back to a
// letter glyph forever.
//
// The fix reuses the circulation pool's pattern (api/_lib/circulation.js):
// clone a random public, thumbnailed humanoid from the platform's own gallery
// into the agent owner's account (zero new R2 bytes — the clone shares the
// source's storage_key and thumbnail_key) and point agent_identities.avatar_id
// at it. Dangling links (avatar_id → deleted avatar) are healed the same way.
//
// Consumers: api/cron/agent-avatar-backfill.js (steady-state, keeps coverage
// at 100% as new bodiless agents appear) and any operator-driven bulk drain
// (same function, bigger limit). Safe to run concurrently: the final UPDATE is
// guarded on the avatar_id still being what we claimed, and a lost race
// deletes its own orphan clone.

import { sql } from './db.js';
import { cloneAvatarFor } from './circulation.js';

export async function agentAvatarCoverage() {
	const [row] = await sql`
		select count(*)::int as total,
		       count(*) filter (where i.avatar_id is not null and a.id is not null)::int as covered
		from agent_identities i
		left join avatars a on a.id = i.avatar_id and a.deleted_at is null
		where i.deleted_at is null
	`;
	return { total: row.total, covered: row.covered, missing: row.total - row.covered };
}

// Assign a cloned public avatar to up to `limit` agents that have none (or a
// dangling one). Returns { claimed, assigned, failed }.
export async function backfillAgentAvatars({ limit = 100 } = {}) {
	const candidates = await sql`
		select i.id, i.user_id, i.name, i.avatar_id as prev_avatar_id
		from agent_identities i
		left join avatars a on a.id = i.avatar_id and a.deleted_at is null
		where i.deleted_at is null
		  and (i.avatar_id is null or a.id is null)
		order by i.is_published desc nulls last, i.created_at desc
		limit ${limit}
	`;
	if (!candidates.length) return { claimed: 0, assigned: 0, failed: 0 };

	let assigned = 0;
	let failed = 0;
	for (const agent of candidates) {
		try {
			const avatarId = await cloneAvatarFor(agent.user_id, agent.name || 'Agent');
			if (!avatarId) {
				// Public pool empty — nothing will succeed this pass.
				failed += candidates.length - assigned - failed;
				break;
			}
			const updated = await sql`
				update agent_identities
				set avatar_id = ${avatarId}, updated_at = now()
				where id = ${agent.id}
				  and deleted_at is null
				  and avatar_id is not distinct from ${agent.prev_avatar_id}
				returning id
			`;
			if (updated.length) {
				assigned++;
			} else {
				// Someone else (user action, concurrent runner) linked an avatar
				// between claim and update — drop our now-orphaned clone.
				await sql`delete from avatars where id = ${avatarId} and owner_id = ${agent.user_id}`.catch(() => {});
			}
		} catch {
			failed++;
		}
	}
	return { claimed: candidates.length, assigned, failed };
}
