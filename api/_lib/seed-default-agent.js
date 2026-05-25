// Seeds a default DRAFT agent for a brand-new user so they have something
// reachable in their "Mine" list and ready to attach an avatar to as soon as
// they sign in. Kept unpublished so the public marketplace doesn't fill up
// with stub "My First Agent" rows — users opt into publishing when they've
// actually customised the agent.
//
// Idempotent: if the user already has any agent (published or draft), the
// function is a no-op. Safe to call from any signup path (email, SIWE, SIWS).

import { sql } from './db.js';

const DEFAULT_NAME = 'My First Agent';
const DEFAULT_DESCRIPTION =
	'A friendly starter agent. Edit the personality and attach a 3D avatar — it goes live immediately.';
const DEFAULT_PROMPT =
	'You are a helpful, concise assistant. Greet the user warmly, ask what they need help with, ' +
	'and respond clearly. Avoid filler. When you do not know something, say so.';
const DEFAULT_GREETING = "Hi! I'm your first agent. What should we work on today?";

export async function seedDefaultAgent(userId) {
	if (!userId) return null;

	try {
		const existing = await sql`
			SELECT 1 AS x FROM agent_identities
			WHERE user_id = ${userId} AND deleted_at IS NULL
			LIMIT 1
		`;
		if (existing.length) return null;

		const [agent] = await sql`
			INSERT INTO agent_identities (
				user_id, name, description, system_prompt, greeting,
				category, tags, capabilities, is_published, published_at
			) VALUES (
				${userId},
				${DEFAULT_NAME},
				${DEFAULT_DESCRIPTION},
				${DEFAULT_PROMPT},
				${DEFAULT_GREETING},
				'general',
				ARRAY['starter']::text[],
				'{"bullets": ["Answers questions","Helps with writing","Suggests next steps"], "skills": [], "library": []}'::jsonb,
				false,
				null
			)
			RETURNING id
		`;
		return agent?.id || null;
	} catch (err) {
		// One retry after 1 s — transient Neon cold-start failures recover quickly.
		// Never block signup regardless; both paths log and return null on failure.
		console.warn('[seed-default-agent] first attempt failed, retrying', { userId, error: err?.message });
		await new Promise((r) => setTimeout(r, 1000));
		try {
			const [agent] = await sql`
				INSERT INTO agent_identities (
					user_id, name, description, system_prompt, greeting,
					category, tags, capabilities, is_published, published_at
				)
				SELECT ${userId}, ${DEFAULT_NAME}, ${DEFAULT_DESCRIPTION}, ${DEFAULT_PROMPT}, ${DEFAULT_GREETING},
				       'general', ARRAY['starter']::text[],
				       '{"bullets": ["Answers questions","Helps with writing","Suggests next steps"], "skills": [], "library": []}'::jsonb,
				       false, null
				WHERE NOT EXISTS (
					SELECT 1 FROM agent_identities WHERE user_id = ${userId} AND deleted_at IS NULL LIMIT 1
				)
				RETURNING id
			`;
			return agent?.id || null;
		} catch (err2) {
			console.error('[seed-default-agent] failed', { userId, error: err2?.message });
			return null;
		}
	}
}
