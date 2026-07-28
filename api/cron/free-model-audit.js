// @ts-check
// GET/POST /api/cron/free-model-audit: liveness audit of every hardcoded
// OpenRouter `:free` model id against OpenRouter's live model list.
//
// OpenRouter retires `:free` endpoints with no notice, and a retired id 404s
// its whole LLM chain rung (see the free-tier block in api/_lib/chat-models.js:
// on 2026-07-27 every id that block listed vanished at once). The anonymous
// /chat lane now resolves models from the live list at request time
// (api/_lib/openrouter-free.js), but the catalog, DEFAULT_FREE_MODEL, and
// OPENROUTER_SIBLINGS still carry hardcoded ids that other rungs depend on.
// This cron diffs those ids against the live list every 6 hours and pages the
// ops channel (api/_lib/alerts.js, dashboard-always + Telegram-when-configured)
// as soon as one dies, so a rotting rung is fixed before users hit it.
//
// An EMPTY live list means OpenRouter itself was unreachable, not that the ids
// died: mirror isLiveFreeModel()'s semantics, report status 'unknown', and flag
// nothing dead. Never call a model dead on our own outage.

import { json, error, method, wrapCron } from '../_lib/http.js';
import { env } from '../_lib/env.js';
import { constantTimeEquals } from '../_lib/crypto.js';
import { MODEL_CATALOG, DEFAULT_FREE_MODEL, OPENROUTER_SIBLINGS } from '../_lib/chat-models.js';
import { listFreeModels } from '../_lib/openrouter-free.js';
import { sendOpsAlert } from '../_lib/alerts.js';

function requireCron(req, res) {
	const secret = process.env.CRON_SECRET || env.CRON_SECRET;
	if (!secret) {
		error(res, 503, 'not_configured', 'CRON_SECRET unset');
		return false;
	}
	const auth = req.headers['authorization'] || '';
	const presented = auth.startsWith('Bearer ') ? auth.slice(7) : '';
	if (!constantTimeEquals(presented, secret)) {
		error(res, 401, 'unauthorized', 'invalid cron secret');
		return false;
	}
	return true;
}

/**
 * Every OpenRouter `:free` id hardcoded in the codebase, with the constants
 * (and files) that reference it. Sources: MODEL_CATALOG's openrouter entries,
 * DEFAULT_FREE_MODEL (also the providerChain rung in api/_lib/llm.js via
 * OPENROUTER_FREE_MODEL), and OPENROUTER_SIBLINGS (the per-model failover list
 * consumed by api/chat.js).
 * @returns {{ id: string, refs: string[] }[]}
 */
export function collectHardcodedFreeIds() {
	/** @type {Map<string, string[]>} */
	const refs = new Map();
	const add = (id, ref) => {
		if (typeof id !== 'string' || !id.endsWith(':free')) return;
		const list = refs.get(id) || [];
		if (!list.includes(ref)) list.push(ref);
		refs.set(id, list);
	};

	for (const [id, entry] of Object.entries(MODEL_CATALOG)) {
		if (entry?.provider === 'openrouter') add(id, 'MODEL_CATALOG (api/_lib/chat-models.js)');
	}
	add(DEFAULT_FREE_MODEL, 'DEFAULT_FREE_MODEL (api/_lib/chat-models.js; providerChain rung in api/_lib/llm.js)');
	for (const id of OPENROUTER_SIBLINGS) {
		add(id, 'OPENROUTER_SIBLINGS (api/_lib/chat-models.js; failover list in api/chat.js)');
	}

	return [...refs.entries()].map(([id, r]) => ({ id, refs: r }));
}

/**
 * Pure diff of hardcoded ids against the live free-model id list. An empty
 * live list means OpenRouter was unreachable (listFreeModels' stale window
 * expired too), so the verdict is 'unknown' and nothing is flagged dead.
 * @param {string[]} hardcodedIds
 * @param {string[]} liveIds
 * @returns {{ checked: number, live: number, dead: string[], status: 'ok'|'dead_rungs'|'unknown' }}
 */
export function diffFreeModels(hardcodedIds, liveIds) {
	const checked = hardcodedIds.length;
	if (!liveIds.length) return { checked, live: 0, dead: [], status: 'unknown' };
	const liveSet = new Set(liveIds);
	const dead = hardcodedIds.filter((id) => !liveSet.has(id));
	return { checked, live: checked - dead.length, dead, status: dead.length ? 'dead_rungs' : 'ok' };
}

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET', 'POST'])) return;
	if (!requireCron(req, res)) return;

	const hardcoded = collectHardcodedFreeIds();
	const liveModels = await listFreeModels();
	const result = diffFreeModels(
		hardcoded.map((h) => h.id),
		liveModels.map((m) => m.id),
	);
	const dead = result.dead.map((id) => hardcoded.find((h) => h.id === id)).filter(Boolean);

	if (result.status === 'dead_rungs') {
		const lines = dead.map((d) => `${d.id}\n  referenced by: ${d.refs.join('; ')}`);
		// Cloud Run log line first: the alert push is best-effort, the log is not.
		console.warn(`[free-model-audit] ${dead.length} retired OpenRouter :free id(s):\n${lines.join('\n')}`);
		// sendOpsAlert always records to the ops dashboard; the Telegram push only
		// fires when TELEGRAM_BOT_TOKEN + TELEGRAM_ALERTS_CHAT_ID are configured,
		// so a missing credential degrades to log + dashboard, never a throw.
		await sendOpsAlert(
			`⚠️ OpenRouter retired ${dead.length} hardcoded :free model id(s)`,
			`${lines.join('\n')}\nUpdate the listed constants: each dead id 404s its LLM chain rung until replaced.`,
			{ signature: 'llm:free-model-audit' },
		);
	} else if (result.status === 'unknown') {
		console.warn('[free-model-audit] OpenRouter model list unreachable; skipping liveness verdict this run');
	}

	return json(res, 200, {
		checked: result.checked,
		live: result.live,
		dead,
		status: result.status,
	});
});
