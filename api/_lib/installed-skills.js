// Installed marketplace skills → chat context.
//
// Users install skills from /marketplace (skill_installs rows). This module
// turns a user's installed knowledge skills (marketplace_skills.content) into
// a system-prompt block for /api/chat, so an install actually changes how
// their agent behaves. Tool-schema skills (schema_json) are not injected here:
// the chat action-tool set is a fixed server-side contract, and a schema
// without a handler cannot execute.
//
// Budget: newest installs win. At most MAX_SKILLS skills, each clipped to
// MAX_SKILL_CHARS, the whole block clipped to MAX_TOTAL_CHARS, so a pile of
// long skills can never crowd the persona or the user's message out of
// context.

import { sql } from './db.js';

const MAX_SKILLS = 8;
const MAX_SKILL_CHARS = 6000;
const MAX_TOTAL_CHARS = 24000;

/**
 * Load the user's installed knowledge skills, newest install first.
 * Returns [{ slug, name, content }]. Empty array for anonymous callers.
 */
export async function loadInstalledSkills(userId) {
	if (!userId) return [];
	const rows = await sql`
		SELECT ms.slug, ms.name, ms.content
		FROM skill_installs si
		JOIN marketplace_skills ms ON ms.id = si.skill_id
		WHERE si.user_id = ${userId}
			AND ms.is_public = true
			AND ms.content IS NOT NULL AND ms.content <> ''
		-- slug is the tie-break, and it is load-bearing: this block is part of
		-- the cached system-prompt prefix (api/chat.js), and prompt caching is a
		-- byte-exact prefix match. Two skills installed in the same transaction
		-- share an installed_at, and an unordered tie would reshuffle the block
		-- between turns — silently missing the cache on every request with no
		-- error to show for it.
		ORDER BY si.installed_at DESC, ms.slug ASC
		LIMIT ${MAX_SKILLS}
	`;
	return rows.map((r) => ({ slug: r.slug, name: r.name, content: r.content }));
}

/**
 * Render loaded skills as a system-prompt block. Returns '' when there is
 * nothing to inject.
 */
export function skillsPromptBlock(skills) {
	if (!Array.isArray(skills) || skills.length === 0) return '';
	const parts = [
		'Installed skills: the user installed these playbooks from the three.ws marketplace. When a message falls in a skill\'s domain, follow that skill\'s framework and format (its guidance overrides the 2-3 sentence default). Skills that do not apply to the message are ignored.',
	];
	let used = 0;
	for (const s of skills) {
		let body = s.content.length > MAX_SKILL_CHARS
			? s.content.slice(0, MAX_SKILL_CHARS) + '\n[…skill truncated]'
			: s.content;
		if (used + body.length > MAX_TOTAL_CHARS) {
			const remaining = MAX_TOTAL_CHARS - used;
			if (remaining < 500) break;
			body = body.slice(0, remaining) + '\n[…skill truncated]';
		}
		used += body.length;
		parts.push(`--- skill: ${s.slug} ---\n${body}`);
	}
	if (parts.length === 1) return '';
	return parts.join('\n\n');
}
