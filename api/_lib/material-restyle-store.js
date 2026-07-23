// Material restyle history — durable, best-effort record of Material Studio
// outputs so a signed-in creator's restyles show up on their public portfolio
// (the "Creations" tab at /u/:username), matching forge_creations and
// dioramas. See api/_lib/migrations/20260723140000_material_restyles.sql for
// the schema and the "why" (restyleMaterialFromInstruction / generateSeededVariants
// in api/_lib/material-studio-store.js are otherwise stateless — no account
// required, nothing recorded).
//
// Every function here is best-effort and fail-soft: a database hiccup or a
// deployment that hasn't run the migration yet must never break the actual
// restyle/variants response. Persistence is a bonus, never a gate.

import { randomUUID } from 'node:crypto';
import { sql, isDbUnavailableError } from './db.js';
import { databaseConfigured } from './env.js';
import { recordDailyActivity, maybeAwardFirstCreation } from './streaks.js';

function enabled() {
	return databaseConfigured();
}

/**
 * Record one Material Studio output. Called once per restyle result, and
 * once per variant in a variants fan-out. `userId` is only ever set when the
 * caller carried a session cookie (see getSessionUser in api/_lib/auth.js);
 * anonymous calls pass userId: null and the row is written for analytics but
 * never surfaced on a profile.
 */
export async function recordMaterialRestyle({
	userId = null,
	clientKey = null,
	action,
	label = null,
	sourceUrl,
	resultUrl,
	instruction = null,
	preset = null,
	seed = null,
	materialIndex = null,
} = {}) {
	if (!enabled() || !sourceUrl || !resultUrl) return null;
	try {
		const id = randomUUID();
		await sql`
			insert into material_restyles
				(id, user_id, client_key, action, label, source_url, result_url,
				 instruction, preset, seed, material_index)
			values
				(${id}, ${userId}, ${clientKey}, ${action}, ${label}, ${sourceUrl}, ${resultUrl},
				 ${instruction}, ${preset}, ${seed}, ${materialIndex ?? null})
		`;
		if (userId) {
			recordDailyActivity(userId).catch(() => {});
			maybeAwardFirstCreation(userId).catch(() => {});
		}
		return id;
	} catch (err) {
		if (isDbUnavailableError(err)) {
			console.warn('[material-restyle-store] recordMaterialRestyle skipped (db unavailable):', err?.message);
		} else {
			// Most likely the migration hasn't landed on this deployment yet
			// (undefined_table). Never let a tracking failure break the actual
			// restyle response.
			console.error('[material-restyle-store] recordMaterialRestyle failed:', err?.message);
		}
		return null;
	}
}

/** A signed-in creator's restyled models, newest first, cursor-paginated. */
export async function listRestylesByUser({ userId, limit = 24, before } = {}) {
	if (!enabled() || !userId) return [];
	const lim = Math.min(60, Math.max(1, Number(limit) || 24));
	try {
		const rows = before
			? await sql`
					select id, action, label, source_url, result_url, instruction, preset, created_at
					from material_restyles
					where user_id = ${userId} and created_at < ${before}
					order by created_at desc limit ${lim}`
			: await sql`
					select id, action, label, source_url, result_url, instruction, preset, created_at
					from material_restyles
					where user_id = ${userId}
					order by created_at desc limit ${lim}`;
		return rows.map((r) => ({
			id: r.id,
			type: 'restyle',
			action: r.action,
			label: r.label,
			glbUrl: r.result_url,
			sourceUrl: r.source_url,
			prompt: r.instruction || r.preset || null,
			category: r.action === 'variants' ? 'colorway variant' : 'AI restyle',
			createdAt: r.created_at,
		}));
	} catch (err) {
		if (isDbUnavailableError(err)) {
			console.warn('[material-restyle-store] listRestylesByUser skipped (db unavailable):', err?.message);
		} else {
			console.error('[material-restyle-store] listRestylesByUser failed:', err?.message);
		}
		return [];
	}
}

/** Count of a signed-in creator's restyled models — profile stat strip. */
export async function countRestylesByUser({ userId } = {}) {
	if (!enabled() || !userId) return 0;
	try {
		const [row] = await sql`select count(*)::int as n from material_restyles where user_id = ${userId}`;
		return row?.n ?? 0;
	} catch (err) {
		if (isDbUnavailableError(err)) {
			console.warn('[material-restyle-store] countRestylesByUser skipped (db unavailable):', err?.message);
		} else {
			console.error('[material-restyle-store] countRestylesByUser failed:', err?.message);
		}
		return 0;
	}
}
