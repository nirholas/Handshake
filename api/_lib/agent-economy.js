// Agent-to-Agent Economy (prompts/agent-wallets/15) — the data layer.
//
// One agent hiring another for a paid skill is recorded in `agent_hires`. This
// module is the single place that writes and reads that ledger, so the
// marketplace's completion counts / ratings / earnings are ALWAYS real
// aggregates over real hires — never fabricated. It also exposes the offer
// catalog (the existing agent_paid_services registry) joined to those live
// stats, and each agent's income/outlay accounting.
//
// Money never moves here. The hire endpoint (api/agents/a2a-hire.js) reserves the
// spend against the owner's spend policy and settles USDC over the real x402
// rails; this module only records the business-level hire and its lifecycle so
// it can be queried, rated, and audited.

import { sql } from './db.js';
import { publicUrl as r2PublicUrl } from './r2.js';

export function atomicsToUsdc(atomics) {
	return Number(atomics || 0) / 1_000_000;
}

// Avatar thumbnail is only surfaced when the avatar is publicly visible — mirrors
// the gate the public pulse feed uses so the marketplace never leaks a private
// avatar render.
function avatarThumb(thumbKey, visibility) {
	const visible = visibility === 'public' || visibility === 'unlisted';
	return thumbKey && visible ? r2PublicUrl(thumbKey) : null;
}

function shapeProvider(row) {
	if (!row?.provider_agent_id) return null;
	return {
		id: row.provider_agent_id,
		name: row.provider_name || 'Agent',
		url: `/agents/${row.provider_agent_id}`,
		avatar_thumbnail_url: avatarThumb(row.provider_thumb_key, row.provider_avatar_vis),
		solana_address: row.provider_addr || null,
		is_public: row.provider_is_public !== false,
	};
}

// ── Writes ────────────────────────────────────────────────────────────────

/**
 * Insert a pending hire, idempotently. A retry carrying the same
 * (hirerAgentId, idempotencyKey) returns the existing row instead of inserting a
 * second one — this is the double-charge guard: the caller checks `existing`
 * before moving any money.
 *
 * @returns {Promise<{ row: object, existing: boolean }>}
 */
export async function recordHire(input) {
	const {
		hirerAgentId,
		hirerUserId,
		providerAgentId = null,
		providerUserId = null,
		serviceId = null,
		serviceSlug = null,
		skillName,
		amountAtomics,
		usd = null,
		currency = 'USDC',
		network = 'solana',
		payerAddress = null,
		payoutAddress = null,
		spendReservationId = null,
		idempotencyKey = null,
		meta = {},
	} = input;

	if (idempotencyKey) {
		const existing = await getHireByIdempotency(hirerAgentId, idempotencyKey);
		if (existing) return { row: existing, existing: true };
	}

	try {
		const [row] = await sql`
			INSERT INTO agent_hires
				(hirer_agent_id, hirer_user_id, provider_agent_id, provider_user_id,
				 service_id, service_slug, skill_name, amount_atomics, usd, currency,
				 network, status, payer_address, payout_address, spend_reservation_id,
				 idempotency_key, meta)
			VALUES (
				${hirerAgentId}, ${hirerUserId}, ${providerAgentId}, ${providerUserId},
				${serviceId}, ${serviceSlug}, ${skillName}, ${String(amountAtomics)},
				${usd}, ${currency}, ${network}, 'pending', ${payerAddress},
				${payoutAddress}, ${spendReservationId}, ${idempotencyKey},
				${JSON.stringify(meta ?? {})}::jsonb
			)
			RETURNING *
		`;
		return { row, existing: false };
	} catch (err) {
		// 23505 = unique_violation on the idempotency index: a concurrent retry won
		// the race. Return its row so neither caller double-pays.
		if ((err?.code === '23505' || /duplicate key|unique/i.test(err?.message || '')) && idempotencyKey) {
			const existing = await getHireByIdempotency(hirerAgentId, idempotencyKey);
			if (existing) return { row: existing, existing: true };
		}
		throw err;
	}
}

/** Flip a hire to its terminal state, attaching the real on-chain artifacts. */
export async function updateHire(id, patch = {}) {
	const completedAt = patch.status === 'completed' ? new Date().toISOString() : null;
	const [row] = await sql`
		UPDATE agent_hires
		SET status            = COALESCE(${patch.status ?? null}, status),
		    payment_signature = COALESCE(${patch.paymentSignature ?? null}, payment_signature),
		    invocation_signature = COALESCE(${patch.invocationSignature ?? null}, invocation_signature),
		    invocation_error  = COALESCE(${patch.invocationError ?? null}, invocation_error),
		    payer_address     = COALESCE(${patch.payerAddress ?? null}, payer_address),
		    result_summary    = COALESCE(${patch.resultSummary ?? null}, result_summary),
		    error             = COALESCE(${patch.error ?? null}, error),
		    completed_at      = COALESCE(${completedAt}::timestamptz, completed_at),
		    meta              = CASE WHEN ${patch.meta ? JSON.stringify(patch.meta) : null}::jsonb IS NULL
		                             THEN meta ELSE meta || ${patch.meta ? JSON.stringify(patch.meta) : '{}'}::jsonb END,
		    updated_at        = now()
		WHERE id = ${id}
		RETURNING *
	`;
	return row || null;
}

/** Set the hirer's 1–5 rating on a completed hire (one rating, owner-gated). */
export async function rateHire(id, hirerUserId, rating) {
	const r = Math.round(Number(rating));
	if (!Number.isFinite(r) || r < 1 || r > 5) {
		const e = new Error('rating must be an integer 1–5');
		e.code = 'invalid_rating';
		e.status = 400;
		throw e;
	}
	const [row] = await sql`
		UPDATE agent_hires
		SET rating = ${r}, rated_at = now(), updated_at = now()
		WHERE id = ${id} AND hirer_user_id = ${hirerUserId} AND status = 'completed'
		RETURNING *
	`;
	return row || null;
}

// ── Reads ─────────────────────────────────────────────────────────────────

export async function getHireById(id) {
	const [row] = await sql`SELECT * FROM agent_hires WHERE id = ${id} LIMIT 1`;
	return row || null;
}

export async function getHireByIdempotency(hirerAgentId, idempotencyKey) {
	if (!idempotencyKey) return null;
	const [row] = await sql`
		SELECT * FROM agent_hires
		WHERE hirer_agent_id = ${hirerAgentId} AND idempotency_key = ${idempotencyKey}
		LIMIT 1
	`;
	return row || null;
}

/**
 * Live reputation + earnings for one provider agent, aggregated over its real
 * completed hires. Every number is a true aggregate — there is no place to inject
 * a fabricated stat.
 */
export async function providerStats(agentId) {
	const [row] = await sql`
		SELECT
			COUNT(*) FILTER (WHERE status = 'completed')                      AS completed,
			COUNT(*) FILTER (WHERE status = 'refunded')                      AS refunded,
			COUNT(*) FILTER (WHERE status IN ('completed','refunded','disputed','failed')) AS total,
			COALESCE(SUM(usd) FILTER (WHERE status = 'completed'), 0)        AS earned_usd,
			AVG(rating) FILTER (WHERE rating IS NOT NULL)                    AS avg_rating,
			COUNT(rating) FILTER (WHERE rating IS NOT NULL)                  AS rating_count,
			MAX(completed_at)                                               AS last_hire_at,
			COUNT(*) FILTER (WHERE status = 'completed' AND completed_at > now() - interval '24 hours') AS completed_24h
		FROM agent_hires
		WHERE provider_agent_id = ${agentId}
	`;
	return shapeStats(row);
}

function shapeStats(row) {
	const completed = Number(row?.completed || 0);
	const total = Number(row?.total || 0);
	return {
		completion_count: completed,
		refunded_count: Number(row?.refunded || 0),
		total_hires: total,
		success_rate: total > 0 ? completed / total : null,
		earned_usdc: Number(row?.earned_usd || 0),
		avg_rating: row?.avg_rating != null ? Number(row.avg_rating) : null,
		rating_count: Number(row?.rating_count || 0),
		throughput_24h: Number(row?.completed_24h || 0),
		last_hire_at: row?.last_hire_at || null,
	};
}

/**
 * The marketplace catalog: every active, bazaar-listed offer joined to its
 * provider agent and its live hire stats. Offers from deleted / private agents
 * are excluded. Sorted by real completion count then recency so proven providers
 * surface first.
 */
export async function listOffersWithStats({ limit = 60, providerAgentId = null } = {}) {
	const capped = Math.min(Math.max(1, Number(limit) || 60), 200);
	const providerFilter = providerAgentId ? sql`AND s.agent_id = ${providerAgentId}` : sql``;
	const rows = await sql`
		SELECT
			s.id            AS service_id,
			s.slug          AS slug,
			s.name          AS name,
			s.description   AS description,
			s.price_atomics AS price_atomics,
			s.network       AS network,
			s.target_method AS method,
			s.input_schema  AS input_schema,
			s.created_at    AS created_at,
			ai.id           AS provider_agent_id,
			ai.name         AS provider_name,
			ai.is_public    AS provider_is_public,
			ai.meta->>'solana_address' AS provider_addr,
			av.thumbnail_key AS provider_thumb_key,
			av.visibility    AS provider_avatar_vis,
			st.completed    AS completed,
			st.refunded     AS refunded,
			st.total        AS total,
			st.earned_usd   AS earned_usd,
			st.avg_rating   AS avg_rating,
			st.rating_count AS rating_count,
			st.last_hire_at AS last_hire_at,
			st.completed_24h AS completed_24h
		FROM agent_paid_services s
		JOIN agent_identities ai ON ai.id = s.agent_id AND ai.deleted_at IS NULL AND ai.is_public = true
		LEFT JOIN avatars av ON av.id = ai.avatar_id AND av.deleted_at IS NULL
		LEFT JOIN LATERAL (
			SELECT
				COUNT(*) FILTER (WHERE status = 'completed')   AS completed,
				COUNT(*) FILTER (WHERE status = 'refunded')   AS refunded,
				COUNT(*) FILTER (WHERE status IN ('completed','refunded','disputed','failed')) AS total,
				COALESCE(SUM(usd) FILTER (WHERE status = 'completed'), 0) AS earned_usd,
				AVG(rating) FILTER (WHERE rating IS NOT NULL) AS avg_rating,
				COUNT(rating) FILTER (WHERE rating IS NOT NULL) AS rating_count,
				MAX(completed_at) AS last_hire_at,
				COUNT(*) FILTER (WHERE status = 'completed' AND completed_at > now() - interval '24 hours') AS completed_24h
			FROM agent_hires h WHERE h.service_id = s.id
		) st ON true
		WHERE s.archived_at IS NULL AND s.bazaar_listed = true
		${providerFilter}
		ORDER BY st.completed DESC NULLS LAST, s.created_at DESC
		LIMIT ${capped}
	`;
	return rows.map(shapeOffer);
}

export async function getOfferBySlug(slug) {
	const rows = await listOffersBySlug(slug);
	return rows[0] || null;
}

async function listOffersBySlug(slug) {
	const rows = await sql`
		SELECT
			s.id AS service_id, s.slug AS slug, s.name AS name, s.description AS description,
			s.price_atomics AS price_atomics, s.network AS network, s.target_method AS method,
			s.input_schema AS input_schema, s.created_at AS created_at,
			ai.id AS provider_agent_id, ai.name AS provider_name, ai.is_public AS provider_is_public,
			ai.meta->>'solana_address' AS provider_addr,
			av.thumbnail_key AS provider_thumb_key, av.visibility AS provider_avatar_vis,
			NULL::bigint AS completed, NULL::bigint AS refunded, NULL::bigint AS total,
			NULL::float8 AS earned_usd, NULL::float8 AS avg_rating, NULL::bigint AS rating_count,
			NULL::timestamptz AS last_hire_at, NULL::bigint AS completed_24h
		FROM agent_paid_services s
		JOIN agent_identities ai ON ai.id = s.agent_id AND ai.deleted_at IS NULL
		LEFT JOIN avatars av ON av.id = ai.avatar_id AND av.deleted_at IS NULL
		WHERE s.slug = ${slug} AND s.archived_at IS NULL
		LIMIT 1
	`;
	return rows.map(shapeOffer);
}

function shapeOffer(row) {
	return {
		service_id: row.service_id,
		slug: row.slug,
		name: row.name,
		description: row.description,
		price_atomics: String(row.price_atomics),
		price_usdc: atomicsToUsdc(row.price_atomics),
		network: row.network,
		method: row.method,
		input_schema: row.input_schema || null,
		created_at: row.created_at,
		provider: shapeProvider(row),
		stats: shapeStats(row),
	};
}

/**
 * One agent's hire history for the accounting view. role='hirer' returns outlay,
 * role='provider' returns income, role='all' returns both. Keyset paginated.
 */
export async function listHiresForAgent(agentId, { role = 'all', limit = 40, beforeId = null } = {}) {
	const lim = Math.min(200, Math.max(1, Number(limit) || 40));
	let roleFilter;
	if (role === 'hirer') roleFilter = sql`h.hirer_agent_id = ${agentId}`;
	else if (role === 'provider') roleFilter = sql`h.provider_agent_id = ${agentId}`;
	else roleFilter = sql`(h.hirer_agent_id = ${agentId} OR h.provider_agent_id = ${agentId})`;

	const cursor = beforeId
		? sql`AND h.created_at < (SELECT created_at FROM agent_hires WHERE id = ${beforeId})`
		: sql``;

	const rows = await sql`
		SELECT
			h.id, h.skill_name, h.service_slug, h.amount_atomics, h.usd, h.currency,
			h.network, h.status, h.payment_signature, h.invocation_signature,
			h.payer_address, h.payout_address, h.rating, h.created_at, h.completed_at,
			h.hirer_agent_id, h.provider_agent_id,
			hr.name AS hirer_name, pr.name AS provider_name
		FROM agent_hires h
		LEFT JOIN agent_identities hr ON hr.id = h.hirer_agent_id
		LEFT JOIN agent_identities pr ON pr.id = h.provider_agent_id
		WHERE ${roleFilter} ${cursor}
		ORDER BY h.created_at DESC
		LIMIT ${lim}
	`;
	return rows.map((r) => shapeHire(r, agentId));
}

function shapeHire(r, viewerAgentId) {
	const isHirer = r.hirer_agent_id === viewerAgentId;
	return {
		id: r.id,
		skill_name: r.skill_name,
		service_slug: r.service_slug,
		amount_atomics: String(r.amount_atomics),
		usd: r.usd != null ? Number(r.usd) : atomicsToUsdc(r.amount_atomics),
		currency: r.currency,
		network: r.network,
		status: r.status,
		direction: isHirer ? 'outlay' : 'income',
		counterparty: {
			agent_id: isHirer ? r.provider_agent_id : r.hirer_agent_id,
			name: (isHirer ? r.provider_name : r.hirer_name) || 'Agent',
		},
		payment_signature: r.payment_signature || null,
		invocation_signature: r.invocation_signature || null,
		payer_address: r.payer_address || null,
		payout_address: r.payout_address || null,
		rating: r.rating != null ? Number(r.rating) : null,
		created_at: r.created_at,
		completed_at: r.completed_at || null,
	};
}

/** Roll-up totals for an agent's economy header: lifetime income + outlay. */
export async function agentEconomySummary(agentId) {
	const [row] = await sql`
		SELECT
			COALESCE(SUM(usd) FILTER (WHERE provider_agent_id = ${agentId} AND status = 'completed'), 0) AS income_usd,
			COUNT(*) FILTER (WHERE provider_agent_id = ${agentId} AND status = 'completed')              AS income_count,
			COALESCE(SUM(usd) FILTER (WHERE hirer_agent_id = ${agentId} AND status = 'completed'), 0)    AS outlay_usd,
			COUNT(*) FILTER (WHERE hirer_agent_id = ${agentId} AND status = 'completed')                 AS outlay_count
		FROM agent_hires
		WHERE provider_agent_id = ${agentId} OR hirer_agent_id = ${agentId}
	`;
	return {
		income_usdc: Number(row?.income_usd || 0),
		income_count: Number(row?.income_count || 0),
		outlay_usdc: Number(row?.outlay_usd || 0),
		outlay_count: Number(row?.outlay_count || 0),
		net_usdc: Number(row?.income_usd || 0) - Number(row?.outlay_usd || 0),
	};
}

// ── Platform-wide roll-ups ──────────────────────────────────────────────────

// A fresh environment may not have run the agent_hires migration yet. Treat the
// missing table as a real, honest zero instead of a 500 — the dashboard then
// renders its empty state rather than an error.
function isMissingTable(err) {
	return err?.code === '42P01';
}

// Empty shape returned when the ledger is unmigrated/empty, so every caller gets
// a stable contract regardless of DB state.
function emptyPlatformStats(windowDays) {
	return {
		totals: {
			volume_usd: 0,
			hires: 0,
			unique_hirers: 0,
			unique_providers: 0,
			avg_hire_usd: 0,
			volume_24h_usd: 0,
			hires_24h: 0,
			volume_7d_usd: 0,
			hires_7d: 0,
			pending_hires: 0,
			last_hire_at: null,
		},
		daily: [],
		top_providers: [],
		top_hirers: [],
		recent: [],
		window_days: windowDays,
	};
}

/**
 * Platform-wide agent-to-agent economy roll-up — the single read behind the
 * public A2A volume dashboard. Every number is a live aggregate over the real
 * `agent_hires` ledger (completed hires = settled USDC moved from one agent to
 * another over the x402 rails). No mock path: an unmigrated ledger folds to a
 * real zero, never a fabricated value.
 *
 * @param {object} [opts]
 * @param {number} [opts.windowDays]  — trailing window for the daily series + leaderboards (default 30, max 365)
 * @param {number} [opts.topLimit]    — ranked agents per leaderboard (default 10, max 50)
 * @param {number} [opts.recentLimit] — recent settled hires in the feed (default 12, max 50)
 */
export async function platformEconomyStats({
	windowDays = 30,
	topLimit = 10,
	recentLimit = 12,
} = {}) {
	const win = Math.min(365, Math.max(1, Math.floor(Number(windowDays) || 30)));
	const top = Math.min(50, Math.max(1, Math.floor(Number(topLimit) || 10)));
	const recent = Math.min(50, Math.max(1, Math.floor(Number(recentLimit) || 12)));

	try {
		const [totalsRow] = await sql`
			SELECT
				COALESCE(SUM(usd) FILTER (WHERE status = 'completed'), 0)                       AS volume_usd,
				COUNT(*) FILTER (WHERE status = 'completed')                                    AS hires,
				COUNT(DISTINCT hirer_agent_id) FILTER (WHERE status = 'completed')              AS unique_hirers,
				COUNT(DISTINCT provider_agent_id) FILTER (WHERE status = 'completed' AND provider_agent_id IS NOT NULL) AS unique_providers,
				AVG(usd) FILTER (WHERE status = 'completed')                                    AS avg_hire_usd,
				COALESCE(SUM(usd) FILTER (WHERE status = 'completed' AND completed_at > now() - interval '24 hours'), 0) AS volume_24h_usd,
				COUNT(*) FILTER (WHERE status = 'completed' AND completed_at > now() - interval '24 hours')             AS hires_24h,
				COALESCE(SUM(usd) FILTER (WHERE status = 'completed' AND completed_at > now() - interval '7 days'), 0)  AS volume_7d_usd,
				COUNT(*) FILTER (WHERE status = 'completed' AND completed_at > now() - interval '7 days')               AS hires_7d,
				COUNT(*) FILTER (WHERE status = 'pending')                                      AS pending_hires,
				MAX(completed_at) FILTER (WHERE status = 'completed')                           AS last_hire_at
			FROM agent_hires
		`;

		const dailyRows = await sql`
			SELECT
				to_char(date_trunc('day', completed_at), 'YYYY-MM-DD') AS day,
				COALESCE(SUM(usd), 0)                                  AS volume_usd,
				COUNT(*)                                              AS hires
			FROM agent_hires
			WHERE status = 'completed'
			  AND completed_at > now() - (${win} || ' days')::interval
			GROUP BY 1
			ORDER BY 1 ASC
		`;

		// Both leaderboards compute `linkable` in SQL for the same reason the
		// settled-hire feed below does: a deleted agent leaves no `agent_identities`
		// row at all, so its `is_public` reads NULL, and treating NULL as "public"
		// handed every deleted earner a leaderboard link to a hollow /agents/<id>.
		const providerRows = await sql`
			SELECT
				h.provider_agent_id                                        AS agent_id,
				COALESCE(ai.name, 'Agent')                                 AS name,
				(ai.id IS NOT NULL AND ai.is_public IS NOT FALSE)          AS linkable,
				av.thumbnail_key                                           AS thumb_key,
				av.visibility                                              AS avatar_vis,
				COALESCE(SUM(h.usd), 0)                                    AS earned_usd,
				COUNT(*)                                                  AS hires,
				AVG(h.rating) FILTER (WHERE h.rating IS NOT NULL)          AS avg_rating
			FROM agent_hires h
			LEFT JOIN agent_identities ai ON ai.id = h.provider_agent_id AND ai.deleted_at IS NULL
			LEFT JOIN avatars av ON av.id = ai.avatar_id AND av.deleted_at IS NULL
			WHERE h.status = 'completed'
			  AND h.provider_agent_id IS NOT NULL
			  AND h.completed_at > now() - (${win} || ' days')::interval
			GROUP BY h.provider_agent_id, ai.id, ai.name, ai.is_public, av.thumbnail_key, av.visibility
			ORDER BY earned_usd DESC
			LIMIT ${top}
		`;

		const hirerRows = await sql`
			SELECT
				h.hirer_agent_id                                           AS agent_id,
				COALESCE(ai.name, 'Agent')                                 AS name,
				(ai.id IS NOT NULL AND ai.is_public IS NOT FALSE)          AS linkable,
				av.thumbnail_key                                           AS thumb_key,
				av.visibility                                              AS avatar_vis,
				COALESCE(SUM(h.usd), 0)                                    AS spent_usd,
				COUNT(*)                                                  AS hires
			FROM agent_hires h
			LEFT JOIN agent_identities ai ON ai.id = h.hirer_agent_id AND ai.deleted_at IS NULL
			LEFT JOIN avatars av ON av.id = ai.avatar_id AND av.deleted_at IS NULL
			WHERE h.status = 'completed'
			  AND h.completed_at > now() - (${win} || ' days')::interval
			GROUP BY h.hirer_agent_id, ai.id, ai.name, ai.is_public, av.thumbnail_key, av.visibility
			ORDER BY spent_usd DESC
			LIMIT ${top}
		`;

		// `*_linkable` is computed in SQL rather than inferred from a null name: an
		// agent that was deleted (or is private) must not get a profile link the
		// feed would send a reader to a 404 for.
		const recentRows = await sql`
			SELECT
				h.id, h.skill_name, h.service_slug, h.usd, h.amount_atomics,
				h.currency, h.network, h.payment_signature, h.completed_at,
				h.hirer_agent_id, h.provider_agent_id,
				hr.name AS hirer_name, pr.name AS provider_name,
				(hr.id IS NOT NULL AND hr.is_public IS NOT FALSE) AS hirer_linkable,
				(pr.id IS NOT NULL AND pr.is_public IS NOT FALSE) AS provider_linkable
			FROM agent_hires h
			LEFT JOIN agent_identities hr ON hr.id = h.hirer_agent_id AND hr.deleted_at IS NULL
			LEFT JOIN agent_identities pr ON pr.id = h.provider_agent_id AND pr.deleted_at IS NULL
			WHERE h.status = 'completed'
			ORDER BY h.completed_at DESC NULLS LAST
			LIMIT ${recent}
		`;

		return {
			totals: {
				volume_usd: Number(totalsRow?.volume_usd || 0),
				hires: Number(totalsRow?.hires || 0),
				unique_hirers: Number(totalsRow?.unique_hirers || 0),
				unique_providers: Number(totalsRow?.unique_providers || 0),
				avg_hire_usd: totalsRow?.avg_hire_usd != null ? Number(totalsRow.avg_hire_usd) : 0,
				volume_24h_usd: Number(totalsRow?.volume_24h_usd || 0),
				hires_24h: Number(totalsRow?.hires_24h || 0),
				volume_7d_usd: Number(totalsRow?.volume_7d_usd || 0),
				hires_7d: Number(totalsRow?.hires_7d || 0),
				pending_hires: Number(totalsRow?.pending_hires || 0),
				last_hire_at: totalsRow?.last_hire_at || null,
			},
			daily: dailyRows.map((r) => ({
				day: r.day,
				volume_usd: Number(r.volume_usd || 0),
				hires: Number(r.hires || 0),
			})),
			top_providers: providerRows.map((r) => ({
				agent_id: r.agent_id,
				name: r.name || 'Agent',
				url: r.linkable && r.agent_id ? `/agents/${r.agent_id}` : null,
				avatar_thumbnail_url: avatarThumb(r.thumb_key, r.avatar_vis),
				earned_usd: Number(r.earned_usd || 0),
				hires: Number(r.hires || 0),
				avg_rating: r.avg_rating != null ? Number(r.avg_rating) : null,
			})),
			top_hirers: hirerRows.map((r) => ({
				agent_id: r.agent_id,
				name: r.name || 'Agent',
				url: r.linkable && r.agent_id ? `/agents/${r.agent_id}` : null,
				avatar_thumbnail_url: avatarThumb(r.thumb_key, r.avatar_vis),
				spent_usd: Number(r.spent_usd || 0),
				hires: Number(r.hires || 0),
			})),
			recent: recentRows.map((r) => ({
				id: r.id,
				skill_name: r.skill_name,
				service_slug: r.service_slug,
				usd: r.usd != null ? Number(r.usd) : atomicsToUsdc(r.amount_atomics),
				currency: r.currency,
				network: r.network,
				payment_signature: r.payment_signature || null,
				completed_at: r.completed_at,
				hirer: {
					agent_id: r.hirer_agent_id,
					name: r.hirer_name || 'Agent',
					url: r.hirer_linkable && r.hirer_agent_id ? `/agents/${r.hirer_agent_id}` : null,
				},
				provider: {
					agent_id: r.provider_agent_id,
					name: r.provider_name || 'Agent',
					url: r.provider_linkable && r.provider_agent_id ? `/agents/${r.provider_agent_id}` : null,
				},
			})),
			window_days: win,
		};
	} catch (err) {
		if (isMissingTable(err)) return emptyPlatformStats(win);
		throw err;
	}
}
