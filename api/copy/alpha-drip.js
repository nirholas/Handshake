/**
 * Alpha-drip configuration — a leader prices the latency of their own signal.
 *
 *   GET  /api/copy/alpha-drip?leader_agent_id=<uuid>
 *        Public read. Returns the leader's release ladder, the standing
 *        disclosure, and — for a signed-in caller — the seat THEY would get, so
 *        a copier sees their real wait before they subscribe rather than after.
 *
 *   POST /api/copy/alpha-drip { leader_agent_id, enabled, schedule,
 *                               public_delay_sec, disclosure, capacity_note }
 *        The agent's owner sets the ladder. Owner-only, CSRF-guarded.
 *
 *   POST /api/copy/alpha-drip { action: 'recommend', leader_agent_id,
 *                               edge_halflife_sec }
 *        Asks the LLM chain for a ladder tuned to how fast this leader's edge
 *        actually decays. It only ever RETURNS a draft — the leader still has to
 *        save it — and the draft is validated through the same normalizer as a
 *        hand-written one, so the model can never talk the ladder past a rule.
 *
 * The drip delays the reveal, never the record: the intent row is written in
 * full at fanout time and the leader's public track record is untouched.
 */

import { cors, json, error, method, wrap, readJson, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { requireCsrf } from '../_lib/csrf.js';
import { sql } from '../_lib/db.js';
import { isUuid } from '../_lib/validate.js';
import { resolveUserTier, TIERS } from '../_lib/three-tier.js';
import {
	normalizeDripConfig, planRelease, dripDisclosure, describeSchedule,
	assessFairness, maxDelaySec, emptyDripConfig, formatDelay, MAX_DELAY_SEC, TIER_IDS,
} from '../_lib/alpha-drip.js';
import { llmComplete, LlmUnavailableError } from '../_lib/llm.js';
import { leaderEdgeHalflifeSec } from '../_lib/alpha-drip-stats.js';

const RECOMMEND_SYSTEM = `You decide how a LEADER's OWN trade signal is released across the leader's OWN subscriber tiers. You are gating the leader's self-produced signal as a subscription product. You are NOT accessing, delaying, or front-running anyone else's orders — only the leader's own.

Reply with STRICT JSON and nothing else:
{
  "schedule": [ { "tier": "<tier id>", "delay_sec": <int>, "max_copy_size_sol": <number|null> } ],
  "public_delay_sec": <int>,
  "disclosure": "<plain-English line the leader can show subscribers>",
  "capacity_note": "<how size was split so early tiers do not exhaust the leader's edge or capacity>"
}

Rules:
- Tier ids, lowest to highest, are exactly: ${TIER_IDS.join(', ')}. Use only these.
- A higher tier can NEVER wait longer than a lower one, and public_delay_sec is the longest wait of all.
- No delay may exceed ${MAX_DELAY_SEC} seconds.
- The full trade ALWAYS becomes part of the public on-chain record. You are timing the copy signal, never whether the trade is disclosed. Never suggest hiding a trade.
- If the edge half-life is very short, tiering is unfair to slower tiers: recommend equal release (every delay 0) and say so in the disclosure.
- Never imply access to third-party orderflow.`;

async function requireUser(req, res) {
	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	if (!session && !bearer) { error(res, 401, 'unauthorized', 'sign in required'); return null; }
	return { userId: session?.id ?? bearer.userId, user: session, viaSession: !!session };
}

/** Read a leader's stored config, normalized. Never throws on a malformed row. */
async function loadConfig(leaderAgentId) {
	const [row] = await sql`
		select enabled, schedule, public_delay_sec, disclosure, capacity_note, updated_at
		from copy_alpha_drip where leader_agent_id = ${leaderAgentId} limit 1
	`;
	if (!row) return { config: emptyDripConfig(), updatedAt: null };
	const norm = normalizeDripConfig(row);
	return { config: norm.ok ? norm.value : emptyDripConfig(), updatedAt: row.updated_at };
}

/** The public shape every drip surface renders from. */
function present(config) {
	return {
		enabled: config.enabled,
		schedule: config.schedule,
		public_delay_sec: config.public_delay_sec,
		disclosure: dripDisclosure(config),
		leader_note: config.disclosure,
		capacity_note: config.capacity_note,
		summary: describeSchedule(config),
		longest_delay_sec: maxDelaySec(config),
		tiers: TIERS.map((t) => ({ id: t.id, label: t.label, min_usd: t.minUsd })),
	};
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST'])) return;
	if (await rateLimited(req, res, limits.api, clientIp(req))) return;

	const leaderFromQuery = String(req.query?.leader_agent_id || '').trim();

	if (req.method === 'GET') {
		if (!isUuid(leaderFromQuery)) return error(res, 400, 'invalid_leader', 'leader_agent_id must be an agent UUID');
		const [leader] = await sql`
			select id, user_id, name, is_public from agent_identities
			where id = ${leaderFromQuery} and deleted_at is null limit 1
		`;
		if (!leader || leader.is_public === false) return error(res, 404, 'leader_not_found', 'No such public trader.');

		const { config, updatedAt } = await loadConfig(leaderFromQuery);
		const body = { leader_agent_id: leader.id, leader_name: leader.name, updated_at: updatedAt, drip: present(config) };

		// A signed-in caller sees the seat they personally get. Signed-out callers
		// get the ladder only — we have no wallet to price them against.
		const session = await getSessionUser(req);
		if (session) {
			const { tier, usd } = await resolveUserTier(session);
			const release = planRelease(config, tier.id);
			body.you = {
				tier: tier.id,
				tier_label: tier.label,
				three_usd: Math.round(usd * 100) / 100,
				delay_sec: release.delay_sec,
				delay_label: formatDelay(release.delay_sec),
				matched_tier: release.matched_tier,
				max_copy_size_sol: release.max_copy_size_sol,
				is_owner: leader.user_id === session.id,
			};
		}
		return json(res, 200, body);
	}

	const auth = await requireUser(req, res);
	if (!auth) return;
	if (auth.viaSession && !requireCsrf(req, res)) return;

	const input = await readJson(req);
	if (!input) return error(res, 400, 'invalid_body', 'expected a JSON body');

	const leaderId = String(input.leader_agent_id || '').trim();
	if (!isUuid(leaderId)) return error(res, 400, 'invalid_leader', 'leader_agent_id must be an agent UUID');

	const [leader] = await sql`
		select id, user_id, name from agent_identities
		where id = ${leaderId} and deleted_at is null limit 1
	`;
	if (!leader) return error(res, 404, 'leader_not_found', 'No such trader.');
	if (leader.user_id !== auth.userId) {
		return error(res, 403, 'not_owner', 'Only the agent\'s owner can price its signal.');
	}

	// Half-life is measured from the leader's real closed trades, so a
	// recommendation and a fairness warning are both grounded in this leader's
	// history rather than a guess. Null when they have too few closes to measure.
	const halflife = input.edge_halflife_sec != null && input.edge_halflife_sec !== ''
		? Number(input.edge_halflife_sec)
		: await leaderEdgeHalflifeSec(leaderId);

	if (input.action === 'recommend') {
		const { config: current } = await loadConfig(leaderId);
		const userPrompt = JSON.stringify({
			leader: leader.name || 'this trader',
			estimated_edge_halflife_sec: Number.isFinite(halflife) ? Math.round(halflife) : null,
			tiers: TIERS.map((t) => ({ tier: t.id, label: t.label, min_usd_held: t.minUsd })),
			current_schedule: current.schedule,
			current_public_delay_sec: current.public_delay_sec,
		});

		let raw;
		try {
			raw = await llmComplete({ system: RECOMMEND_SYSTEM, user: userPrompt, maxTokens: 700, timeoutMs: 25_000, track: { userId: auth.userId } });
		} catch (err) {
			if (err instanceof LlmUnavailableError) {
				return error(res, 503, 'llm_unavailable', 'No language model is reachable right now. Set the ladder by hand and try the suggestion later.');
			}
			return error(res, err.status || 502, err.code || 'recommend_failed', err.message || 'Could not draft a ladder.');
		}

		const parsed = parseJsonBlock(raw?.text ?? raw);
		if (!parsed) return error(res, 502, 'recommend_unparsable', 'The model did not return a usable ladder. Set it by hand.');

		const norm = normalizeDripConfig({ ...parsed, enabled: true });
		if (!norm.ok) {
			return error(res, 502, 'recommend_invalid', `The suggested ladder broke a release rule (${norm.error}). Set it by hand.`);
		}
		return json(res, 200, {
			leader_agent_id: leaderId,
			suggestion: present(norm.value),
			fairness: assessFairness(norm.value, halflife),
			edge_halflife_sec: Number.isFinite(halflife) ? Math.round(halflife) : null,
			applied: false,
			note: 'This is a draft. Save it to make it live.',
		});
	}

	const norm = normalizeDripConfig(input);
	if (!norm.ok) return error(res, 400, 'invalid_config', norm.error);
	const v = norm.value;

	await sql`
		insert into copy_alpha_drip (
			leader_agent_id, owner_user_id, enabled, schedule, public_delay_sec, disclosure, capacity_note
		) values (
			${leaderId}, ${auth.userId}, ${v.enabled}, ${JSON.stringify(v.schedule)}::jsonb,
			${v.public_delay_sec}, ${v.disclosure}, ${v.capacity_note}
		)
		on conflict (leader_agent_id) do update set
			owner_user_id    = excluded.owner_user_id,
			enabled          = excluded.enabled,
			schedule         = excluded.schedule,
			public_delay_sec = excluded.public_delay_sec,
			disclosure       = excluded.disclosure,
			capacity_note    = excluded.capacity_note,
			updated_at       = now()
	`;

	return json(res, 200, {
		leader_agent_id: leaderId,
		drip: present(v),
		fairness: assessFairness(v, halflife),
		edge_halflife_sec: Number.isFinite(halflife) ? Math.round(halflife) : null,
	});
});

/** Pull the first JSON object out of a model reply, fenced or bare. Never throws. */
function parseJsonBlock(text) {
	if (typeof text !== 'string') return null;
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
	const candidate = fenced ? fenced[1] : text;
	const start = candidate.indexOf('{');
	const end = candidate.lastIndexOf('}');
	if (start < 0 || end <= start) return null;
	try { return JSON.parse(candidate.slice(start, end + 1)); } catch { return null; }
}
