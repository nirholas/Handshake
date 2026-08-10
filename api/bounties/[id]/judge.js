// POST /api/bounties/:id/judge — AI judge for the /go bounty board.
//
// Owner-only. Scores every (non-rejected) submission against the bounty's
// requirements with the platform LLM and returns a ranked, reasoned shortlist
// plus a recommended winner. Posters drowning in dozens of submissions get an
// instant, defensible read on the field instead of eyeballing them one by one.
//
// Cost control: result is cached in Redis keyed by (bounty, submission count,
// newest submission time) for an hour, so re-opening the resolve modal is free
// and only a genuinely changed field re-bills. A per-poster hourly rate limit
// caps worst-case spend.

import { sql } from '../../_lib/db.js';
import { cors, json, error, wrap, method, rateLimited } from '../../_lib/http.js';
import { getSessionUser } from '../../_lib/auth.js';
import { requireCsrf } from '../../_lib/csrf.js';
import { isUuid } from '../../_lib/validate.js';
import { llmComplete, LlmUnavailableError } from '../../_lib/llm.js';
import { cacheGet, cacheSet } from '../../_lib/cache.js';
import { limits } from '../../_lib/rate-limit.js';
import { enrichLikes } from '../../_lib/bounty-likes.js';
import { buildJudgePrompt, normalizeJudgement } from '../../_lib/bounty-judge.js';

const MAX_SUBS = 40; // submissions fed to the model in one pass
const PREVIEW_CAP = 140;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS' })) return;
	if (!method(req, res, ['POST'])) return;

	const id = req.query?.id;
	if (!id || !isUuid(id)) return error(res, 400, 'bad_request', 'valid bounty id required');

	const user = await getSessionUser(req).catch(() => null);
	if (!user) return error(res, 401, 'unauthorized', 'sign in to use the AI judge');
	if (!(await requireCsrf(req, res, user.id))) return;

	const rl = await limits.bountyJudge(user.id);
	if (!rl.success)
		return rateLimited(res, rl, 'AI judge limit reached — try again later');

	const [bounty] = await sql`
		SELECT id, user_id, title, description, status
		FROM bounties
		WHERE id = ${id} AND deleted_at IS NULL
	`;
	if (!bounty) return error(res, 404, 'not_found', 'bounty not found');
	if (bounty.user_id !== user.id) {
		return error(res, 403, 'forbidden', 'only the bounty poster can run the AI judge');
	}

	const subs = await sql`
		SELECT id, username, content, media_url, media_type, created_at
		FROM bounty_submissions
		WHERE bounty_id = ${id} AND status != 'rejected'
		ORDER BY created_at ASC
		LIMIT ${MAX_SUBS}
	`;
	if (!subs.length) return error(res, 400, 'no_submissions', 'no submissions to judge yet');

	await enrichLikes(subs, { idField: 'id', userId: user.id });

	const validIds = new Set(subs.map((s) => s.id));
	const newest = subs.reduce((m, s) => Math.max(m, new Date(s.created_at).getTime() || 0), 0);
	const cacheKey = `bounty:judge:${id}:${subs.length}:${newest}`;

	const cached = await cacheGet(cacheKey).catch(() => null);
	if (cached) return json(res, 200, { ...cached, cached: true });

	let result;
	try {
		const { system, user: userPrompt } = buildJudgePrompt(bounty, subs);
		const out = await llmComplete({
			system,
			user: userPrompt,
			maxTokens: 1400,
			timeoutMs: 30_000,
			track: { userId: user.id, tool: 'bounties/judge' },
		});
		result = normalizeJudgement(out.text, validIds);
		result.model = out.model;
		result.provider = out.provider;
	} catch (e) {
		if (e instanceof LlmUnavailableError) {
			return error(res, 503, 'llm_unavailable', 'AI judge is unavailable right now');
		}
		// Upstream provider errors carry vendor detail (billing state, keys, model
		// names) that must never reach a bounty poster's screen. Log it, answer
		// with a stable message the resolve modal can render as-is.
		console.warn('[bounties/judge] scoring failed for %s: %s', id, e?.message);
		if (e?.status === 429) {
			return error(res, 429, 'judge_limit', 'AI judge budget spent for today, try again tomorrow');
		}
		return error(res, 502, 'judge_failed', 'the judge could not score this field');
	}

	// Decorate each ranking with display context the client needs (author,
	// likes, a short preview) so the resolve modal can render without a second
	// lookup against its own submission list.
	const byId = new Map(subs.map((s) => [s.id, s]));
	result.rankings = result.rankings.map((r) => {
		const s = byId.get(r.submission_id);
		return {
			...r,
			username: s?.username || 'anon',
			like_count: s?.like_count || 0,
			content_preview: String(s?.content || s?.media_url || '').slice(0, PREVIEW_CAP),
		};
	});
	result.judged_count = subs.length;

	await cacheSet(cacheKey, result, 3600).catch(() => {});

	return json(res, 200, { ...result, cached: false });
});
