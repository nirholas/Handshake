// Mood — the agent's persistent emotional state (Living Agents · Task 07).
//
// GET    /api/agents/:id/mood              — owner: current mood snapshot,
//                                            sensitivity, and recent history.
// POST   /api/agents/:id/mood              — owner: persist a mood point produced
//                                            by a REAL signal. Updates the live
//                                            snapshot (meta.mood) AND appends a
//                                            history row citing the signal.
// POST   /api/agents/:id/mood/sensitivity  — owner: set emotional sensitivity
//                                            (0 = stoic, 1 = expressive) without a
//                                            signal — a setting, not an emotion.
//
// The live snapshot lives on agent_identities.meta.mood so it restores with the
// agent record; agent_mood_history is the append-only timeline behind the
// inspector's signal feed and the "mood over time" sparkline.

import { sql } from '../../_lib/db.js';
import { getSessionUser, authenticateBearer, extractBearer, isSameSiteOrigin } from '../../_lib/auth.js';
import { cors, json, method, readJson, wrap, error } from '../../_lib/http.js';
import { parse } from '../../_lib/validate.js';
import { z } from 'zod';
import { BASELINE, clampSensitivity, moodLabel, SIGNALS } from '../../../src/agents/mood-model.js';

const HISTORY_LIMIT = 80;

const pointBody = z.object({
	valence: z.number().min(-1).max(1),
	arousal: z.number().min(0).max(1),
	label: z.string().trim().min(1).max(40).optional(),
	sensitivity: z.number().min(0).max(1).optional(),
	source: z.string().trim().min(1).max(64),
	source_label: z.string().trim().max(120).optional(),
	source_memory_id: z.string().uuid().optional(),
	metadata: z.record(z.string(), z.any()).optional(),
});

const sensitivityBody = z.object({ sensitivity: z.number().min(0).max(1) });

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) {
		// CSRF defense-in-depth for the cookie path: mood writes persist state
		// onto the agent, so a cross-site POST riding the session cookie must
		// never reach them. Reads stay open; bearer callers are exempt.
		const isRead = ['GET', 'HEAD', 'OPTIONS'].includes(String(req.method || '').toUpperCase());
		if (!isRead && !isSameSiteOrigin(req)) {
			throw Object.assign(new Error('cross-site request blocked'), { status: 403, code: 'forbidden' });
		}
		return { userId: session.id };
	}
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId };
	return null;
}

function readSnapshot(meta) {
	const m = meta && typeof meta === 'object' && meta.mood && typeof meta.mood === 'object' ? meta.mood : null;
	const valence = m && Number.isFinite(m.valence) ? Math.max(-1, Math.min(1, m.valence)) : BASELINE.valence;
	const arousal = m && Number.isFinite(m.arousal) ? Math.max(0, Math.min(1, m.arousal)) : BASELINE.arousal;
	const sensitivity = clampSensitivity(m ? m.sensitivity : undefined);
	const label = (m && typeof m.label === 'string' && m.label) || moodLabel(valence, arousal).key;
	return { valence, arousal, sensitivity, label, updated_at: (m && m.updated_at) || null };
}

// Merge a new mood snapshot into meta without disturbing any other meta keys.
async function persistSnapshot(id, snapshot) {
	await sql`
		UPDATE agent_identities
		   SET meta = jsonb_set(
		           coalesce(meta, '{}'::jsonb),
		           '{mood}',
		           ${JSON.stringify(snapshot)}::jsonb,
		           true
		       ),
		       updated_at = now()
		 WHERE id = ${id}
	`;
}

export const handleMood = wrap(async (req, res, id, action) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');

	const [agent] = await sql`
		SELECT id, user_id, meta FROM agent_identities WHERE id = ${id} AND deleted_at IS NULL
	`;
	if (!agent) return error(res, 404, 'not_found', 'agent not found');
	if (agent.user_id !== auth.userId) return error(res, 403, 'forbidden', 'not your agent');

	const snapshot = readSnapshot(agent.meta);

	// ── GET — current mood + recent history ──────────────────────────────────
	if (req.method === 'GET' && !action) {
		const history = await sql`
			SELECT id, valence, arousal, label, source, source_label, source_memory_id, created_at
			  FROM agent_mood_history
			 WHERE agent_id = ${id}
			 ORDER BY created_at DESC
			 LIMIT ${HISTORY_LIMIT}
		`;
		return json(res, 200, { mood: snapshot, history });
	}

	// ── POST /sensitivity — the stoic↔expressive setting (no signal) ─────────
	if (req.method === 'POST' && action === 'sensitivity') {
		const body = parse(sensitivityBody, await readJson(req));
		const next = {
			valence: snapshot.valence,
			arousal: snapshot.arousal,
			label: snapshot.label,
			sensitivity: clampSensitivity(body.sensitivity),
			updated_at: new Date().toISOString(),
		};
		await persistSnapshot(id, next);
		return json(res, 200, { mood: next });
	}

	// ── POST — persist a mood point produced by a real signal ────────────────
	if (req.method === 'POST' && !action) {
		const p = parse(pointBody, await readJson(req));

		// A mood change must cite a real signal. Reject anything that isn't a
		// known catalogue signal or a namespaced custom one (producer:detail).
		if (!SIGNALS[p.source] && !/^[a-z]+:[a-z0-9_-]+$/i.test(p.source)) {
			return error(res, 400, 'invalid_signal', 'mood changes require a real signal source');
		}

		const label = p.label || moodLabel(p.valence, p.arousal).key;
		const sensitivity = p.sensitivity !== undefined ? clampSensitivity(p.sensitivity) : snapshot.sensitivity;
		const next = {
			valence: p.valence,
			arousal: p.arousal,
			label,
			sensitivity,
			updated_at: new Date().toISOString(),
		};

		const results = await sql.transaction([
			sql`
				UPDATE agent_identities
				   SET meta = jsonb_set(coalesce(meta, '{}'::jsonb), '{mood}', ${JSON.stringify(next)}::jsonb, true),
				       updated_at = now()
				 WHERE id = ${id}
			`,
			sql`
				INSERT INTO agent_mood_history
					(agent_id, valence, arousal, label, source, source_label, source_memory_id, metadata)
				VALUES (
					${id}, ${p.valence}, ${p.arousal}, ${label}, ${p.source},
					${p.source_label || SIGNALS[p.source]?.label || null},
					${p.source_memory_id || null},
					${JSON.stringify(p.metadata || {})}::jsonb
				)
				RETURNING id, valence, arousal, label, source, source_label, source_memory_id, created_at
			`,
		]);

		const inserted = results[results.length - 1];
		const entry = Array.isArray(inserted) ? inserted[0] : inserted;
		return json(res, 200, { mood: next, entry });
	}

	return error(res, 404, 'not_found', 'unknown mood action');
});

export default handleMood;
