/**
 * Living Stages, stage + show lifecycle (Moonshot 04).
 *
 * A "stage" is a venue where an embodied AI agent hosts live, monetized shows.
 * A "show" is one live session against that stage; "show_tips" is the per-show
 * ledger of real on-chain $THREE tips. This endpoint owns the read surface (the
 * stage directory + a single stage's live/between-show state) and the owner-only
 * writes (create/update a stage, go live, end a show).
 *
 *   GET  /api/stage                  → directory: live shows first, then upcoming
 *   GET  /api/stage?id=<id>          → one stage: host, current show, leaderboard,
 *                                      host wallet (tip target), between-show state
 *   GET  /api/stage?coin=<mint>      → the stage standing in that /play coin
 *                                      world's plaza (F17), or { stage: null }
 *   POST /api/stage  { action:'create', agentId, title, format, voice, venue,
 *                      tipSplitBps, nextShowAt }     → owner provisions a stage
 *   POST /api/stage  { action:'plaza', agentId, coinMint, … }
 *                                                    → claim a coin world's plaza
 *   POST /api/stage  { action:'golive', stageId }    → open a show + notify holders
 *   POST /api/stage  { action:'endshow', stageId }   → close the current show
 *
 * Every write enforces ownership server-side (the agent's user_id must equal the
 * session user) + CSRF. Money is integer atomic units; $THREE is the only coin.
 */

import { cors, json, wrap, readJson } from '../_lib/http.js';
import { sql } from '../_lib/db.js';
import { getSessionUser } from '../_lib/auth.js';
import { requireCsrf } from '../_lib/csrf.js';
import { isUuid } from '../_lib/validate.js';
import { ensureAgentWallet } from '../_lib/agent-wallet.js';
import { insertNotification } from '../_lib/notify.js';
import { sendOpsAlert } from '../_lib/alerts.js';
import { normalizeSplitBps } from '../_lib/stage-split.js';
import { plazaStageId } from '../../multiplayer/src/plaza-stage.js';

const VENUES = new Set(['club', 'theater', 'plaza', 'arena']);
const MAX_MINT = 64;
const MAX_TITLE = 120;
const MAX_FORMAT = 60;

let _tablesReady = false;
async function ensureTables() {
	if (_tablesReady) return;
	await sql`
		CREATE TABLE IF NOT EXISTS stages (
			id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
			agent_id        UUID NOT NULL,
			owner_user_id   UUID NOT NULL,
			venue           TEXT NOT NULL DEFAULT 'club',
			title           TEXT,
			format          TEXT,
			voice           TEXT NOT NULL DEFAULT 'nova',
			tip_split_bps   INT  NOT NULL DEFAULT 1000,
			status          TEXT NOT NULL DEFAULT 'scheduled',
			next_show_at    TIMESTAMPTZ,
			created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)
	`;
	await sql`CREATE INDEX IF NOT EXISTS stages_status ON stages (status, next_show_at)`;
	await sql`CREATE INDEX IF NOT EXISTS stages_agent  ON stages (agent_id)`;
	await sql`CREATE UNIQUE INDEX IF NOT EXISTS stages_agent_uniq ON stages (agent_id)`;
	// Plaza binding (F17). Migration 20260807120000_stage_coin_mint.sql owns this on
	// a migrated database; the ALTER covers one that has never run migrations.
	await sql`ALTER TABLE stages ADD COLUMN IF NOT EXISTS coin_mint TEXT`;
	await sql`CREATE INDEX IF NOT EXISTS stages_coin_mint ON stages (coin_mint) WHERE coin_mint IS NOT NULL`;
	await sql`
		CREATE TABLE IF NOT EXISTS shows (
			id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
			stage_id          UUID NOT NULL,
			started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			ended_at          TIMESTAMPTZ,
			peak_audience     INT NOT NULL DEFAULT 0,
			total_tips_atomic NUMERIC NOT NULL DEFAULT 0,
			tip_count         INT NOT NULL DEFAULT 0,
			created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)
	`;
	await sql`CREATE INDEX IF NOT EXISTS shows_stage ON shows (stage_id, started_at DESC)`;
	// Exactly one open show per stage, a partial unique index makes "go live twice"
	// a no-op rather than a second open row the tips would split across.
	await sql`CREATE UNIQUE INDEX IF NOT EXISTS shows_one_open ON shows (stage_id) WHERE ended_at IS NULL`;
	await sql`
		CREATE TABLE IF NOT EXISTS show_tips (
			id                 UUID DEFAULT gen_random_uuid() PRIMARY KEY,
			show_id            UUID,
			stage_id           UUID NOT NULL,
			tipper_user_id     UUID,
			tipper_label       TEXT,
			amount_atomic      NUMERIC NOT NULL,
			currency_mint      TEXT NOT NULL,
			host_credit_atomic NUMERIC NOT NULL,
			venue_cut_atomic   NUMERIC NOT NULL,
			settlement_sig     TEXT NOT NULL,
			network            TEXT,
			message            TEXT,
			verified_at        TIMESTAMPTZ,
			verify_error       TEXT,
			created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)
	`;
	// Live databases predate the verification columns (migration
	// 20260806130000_settlement_verification.sql adds them there, with the
	// grandfathering backfill). These ALTERs only cover a database that has never
	// run migrations; they must never backfill, or a genuinely pending tip would be
	// promoted without proof.
	await sql`ALTER TABLE show_tips ADD COLUMN IF NOT EXISTS verified_at  TIMESTAMPTZ`;
	await sql`ALTER TABLE show_tips ADD COLUMN IF NOT EXISTS verify_error TEXT`;
	// One settlement → one tip row. The unique index is the idempotency guarantee
	// the tip endpoint leans on (ON CONFLICT DO NOTHING).
	await sql`CREATE UNIQUE INDEX IF NOT EXISTS show_tips_sig ON show_tips (settlement_sig)`;
	await sql`CREATE INDEX IF NOT EXISTS show_tips_show ON show_tips (show_id, amount_atomic DESC)`;
	_tablesReady = true;
}

// Resolve the host agent's Solana wallet (the tip target) without provisioning on
// a public read, only return an address that already exists. Provisioning
// happens at stage creation, when the owner is authenticated.
async function readHostWallet(agentId) {
	const [row] = await sql`SELECT meta FROM agent_identities WHERE id = ${agentId} AND deleted_at IS NULL LIMIT 1`;
	const addr = row?.meta?.solana_address;
	return typeof addr === 'string' && addr ? addr : null;
}

// Aggregate the per-tipper leaderboard for a show, highest total first.
async function showLeaderboard(showId, limit = 10) {
	if (!showId) return [];
	// Verified tips only: a tip whose settlement has not been proved on-chain is
	// quarantined and must never reach a public leaderboard.
	const rows = await sql`
		SELECT
			COALESCE(tipper_label, 'someone') AS label,
			SUM(amount_atomic)::numeric AS total,
			COUNT(*)::int AS count,
			MIN(created_at) AS first_at
		FROM show_tips
		WHERE show_id = ${showId} AND verified_at IS NOT NULL
		GROUP BY COALESCE(tipper_label, 'someone')
		ORDER BY total DESC, first_at ASC
		LIMIT ${limit}
	`;
	return rows.map((r) => ({ label: r.label, total: Number(r.total), count: r.count }));
}

// One stage's full public read: host + venue config, whether a show is open, the
// leaderboard for the show that matters (the open one, else the last one), and the
// host wallet a tip is sent to. Null when the stage does not exist. Shared by the
// ?id= and ?coin= reads so the /stage page and the in-world plaza can never see
// two different shapes of the same show.
async function stageDetail(stageId) {
	if (!isUuid(stageId)) return null;
	const [stage] = await sql`
		SELECT s.*, a.name AS agent_name, a.avatar_url, a.profile_image_url, a.is_public
		FROM stages s
		JOIN agent_identities a ON a.id = s.agent_id AND a.deleted_at IS NULL
		WHERE s.id = ${stageId}
		LIMIT 1
	`;
	if (!stage) return null;

	const [openShow] = await sql`
		SELECT id, started_at, peak_audience, total_tips_atomic, tip_count
		FROM shows WHERE stage_id = ${stageId} AND ended_at IS NULL
		ORDER BY started_at DESC LIMIT 1
	`;
	const [lastShow] = openShow
		? [null]
		: await sql`
			SELECT id, started_at, ended_at, peak_audience, total_tips_atomic, tip_count
			FROM shows WHERE stage_id = ${stageId} AND ended_at IS NOT NULL
			ORDER BY ended_at DESC LIMIT 1
		`;
	const leaderboardShow = openShow || lastShow;
	const leaderboard = await showLeaderboard(leaderboardShow?.id);
	const hostWallet = await readHostWallet(stage.agent_id);

	return {
		stage: shapeStage(stage),
		live: !!openShow,
		currentShow: openShow ? shapeShow(openShow) : null,
		lastShow: lastShow ? shapeShow(lastShow) : null,
		leaderboard,
		hostWallet,
	};
}

export default wrap(async (req, res) => {
	cors(req, res, { methods: ['GET', 'POST', 'OPTIONS'] });
	if (req.method === 'OPTIONS') return res.end();

	await ensureTables();

	if (req.method === 'GET') return handleGet(req, res);
	if (req.method === 'POST') return handlePost(req, res);
	return json(res, 405, { error: 'method_not_allowed' });
});

async function handleGet(req, res) {
	const id = req.query.id;

	// ── lookup by agent (cross-link from an agent profile) ─────────────────────
	if (req.query.agentId) {
		if (!isUuid(req.query.agentId)) return json(res, 400, { error: 'invalid agent id' });
		const [stage] = await sql`
			SELECT s.*, a.name AS agent_name, a.avatar_url, a.profile_image_url,
				EXISTS (SELECT 1 FROM shows sh WHERE sh.stage_id = s.id AND sh.ended_at IS NULL) AS is_live
			FROM stages s
			JOIN agent_identities a ON a.id = s.agent_id AND a.deleted_at IS NULL
			WHERE s.agent_id = ${req.query.agentId}
			LIMIT 1
		`;
		if (!stage) return json(res, 200, { stage: null }, { 'cache-control': 'no-store' });
		return json(res, 200, { stage: { ...shapeStage(stage), live: !!stage.is_live } }, { 'cache-control': 'no-store' });
	}

	// ── the stage standing in a coin world's plaza (F17) ──────────────────────
	// The /play client derives this id itself (multiplayer/src/plaza-stage.js) and
	// only needs the show state, so an UNCLAIMED plaza is a 200 with stage:null,
	// the quiet-landmark case is normal, not an error.
	if (req.query.coin) {
		const mint = cleanStr(req.query.coin, MAX_MINT);
		if (!mint) return json(res, 400, { error: 'invalid coin mint' });
		const stageId = plazaStageId(mint);
		const detail = await stageDetail(stageId);
		if (!detail) return json(res, 200, { stage: null, stageId, coinMint: mint }, { 'cache-control': 'no-store' });
		return json(res, 200, { ...detail, stageId, coinMint: mint }, { 'cache-control': 'no-store' });
	}

	// ── single stage ──────────────────────────────────────────────────────────
	if (id) {
		if (!isUuid(id)) return json(res, 400, { error: 'invalid stage id' });
		const detail = await stageDetail(id);
		if (!detail) return json(res, 404, { error: 'stage not found' });
		return json(res, 200, detail, { 'cache-control': 'no-store' });
	}

	// ── directory: live first, then upcoming, then recently-ended ──────────────
	const stages = await sql`
		SELECT s.*, a.name AS agent_name, a.avatar_url, a.profile_image_url,
			EXISTS (SELECT 1 FROM shows sh WHERE sh.stage_id = s.id AND sh.ended_at IS NULL) AS is_live,
			(SELECT total_tips_atomic FROM shows sh WHERE sh.stage_id = s.id ORDER BY started_at DESC LIMIT 1) AS recent_tips
		FROM stages s
		JOIN agent_identities a ON a.id = s.agent_id AND a.deleted_at IS NULL AND a.is_public IS TRUE
		WHERE s.status <> 'draft'
		ORDER BY is_live DESC, s.next_show_at ASC NULLS LAST, s.updated_at DESC
		LIMIT 60
	`;
	return json(res, 200, {
		stages: stages.map((s) => ({
			...shapeStage(s),
			live: !!s.is_live,
			recentTipsAtomic: Number(s.recent_tips || 0),
		})),
	}, { 'cache-control': 'no-store' });
}

async function handlePost(req, res) {
	const session = await getSessionUser(req).catch(() => null);
	if (!session) return json(res, 401, { error: 'authentication_required' });
	if (!(await requireCsrf(req, res, session.id))) return;

	let body;
	try {
		body = await readJson(req, 20_000);
	} catch (e) {
		return json(res, e.status || 400, { error: e.message || 'bad_request' });
	}
	const action = String(body.action || '').toLowerCase();

	if (action === 'create') return createStage(req, res, session, body);
	if (action === 'plaza') return claimPlaza(req, res, session, body);
	if (action === 'golive') return goLive(req, res, session, body);
	if (action === 'endshow') return endShow(req, res, session, body);
	return json(res, 400, { error: 'unknown action' });
}

// Confirm the session user owns the agent (server-side ownership gate).
async function ownedAgent(agentId, userId) {
	if (!isUuid(agentId)) return null;
	const [a] = await sql`
		SELECT id, name, avatar_url FROM agent_identities
		WHERE id = ${agentId} AND user_id = ${userId} AND deleted_at IS NULL LIMIT 1
	`;
	return a || null;
}

async function createStage(req, res, session, body) {
	const agent = await ownedAgent(body.agentId, session.id);
	if (!agent) return json(res, 403, { error: 'you do not own this agent' });

	const venue = VENUES.has(body.venue) ? body.venue : 'club';
	const title = cleanStr(body.title, MAX_TITLE) || `${agent.name} Live`;
	const format = cleanStr(body.format, MAX_FORMAT) || 'open mic';
	const voice = cleanStr(body.voice, 40) || 'nova';
	const splitBps = normalizeSplitBps(body.tipSplitBps);
	const nextShowAt = parseFutureDate(body.nextShowAt);

	// Provision the host agent's wallet now (authenticated owner) so the tip target
	// exists before anyone can tip. Idempotent.
	let hostWallet = null;
	try {
		const w = await ensureAgentWallet(agent.id, session.id, { reason: 'stage_create' });
		hostWallet = w?.address || null;
	} catch (err) {
		return json(res, 502, { error: 'could not provision host wallet', detail: err?.message });
	}

	const [row] = await sql`
		INSERT INTO stages (agent_id, owner_user_id, venue, title, format, voice, tip_split_bps, status, next_show_at)
		VALUES (${agent.id}, ${session.id}, ${venue}, ${title}, ${format}, ${voice}, ${splitBps}, 'scheduled', ${nextShowAt})
		ON CONFLICT (agent_id) DO UPDATE SET
			-- A stage bound to a coin world's plaza stays a plaza: editing its copy
			-- through the generic create path must not silently move the venue out
			-- from under the world that renders it.
			venue = CASE WHEN stages.coin_mint IS NOT NULL THEN 'plaza' ELSE EXCLUDED.venue END,
			title = EXCLUDED.title, format = EXCLUDED.format,
			voice = EXCLUDED.voice, tip_split_bps = EXCLUDED.tip_split_bps,
			next_show_at = EXCLUDED.next_show_at, status = 'scheduled', updated_at = NOW()
		RETURNING *
	`;
	return json(res, 201, { ok: true, stage: shapeStage(row), hostWallet });
}

// Claim a /play coin world's plaza for an agent you own (F17). The row is written
// AT the derived plaza id, which is what makes the world able to find the show
// without a lookup: the client computes the same uuidv5 from the mint it is
// standing in and joins that stage_world room. Idempotent for the same agent, so
// re-claiming just updates the venue copy.
async function claimPlaza(req, res, session, body) {
	const agent = await ownedAgent(body.agentId, session.id);
	if (!agent) return json(res, 403, { error: 'you do not own this agent' });

	const mint = cleanStr(body.coinMint, MAX_MINT);
	if (!mint) return json(res, 400, { error: 'coinMint is required' });
	const stageId = plazaStageId(mint);

	// The plaza is one venue: whoever holds it holds it until they release it.
	const [held] = await sql`SELECT id, agent_id FROM stages WHERE id = ${stageId} LIMIT 1`;
	if (held && held.agent_id !== agent.id) {
		return json(res, 409, {
			error: 'plaza_taken',
			message: 'another agent already hosts this world\'s plaza stage',
			stageId,
		});
	}
	// One stage per agent (stages_agent_uniq). An agent that already has a stage
	// elsewhere cannot also take a plaza, say so with the id they already own
	// rather than failing on a constraint the caller can't see.
	const [existing] = await sql`SELECT id FROM stages WHERE agent_id = ${agent.id} LIMIT 1`;
	if (existing && existing.id !== stageId) {
		return json(res, 409, {
			error: 'agent_has_stage',
			message: 'this agent already hosts another stage, use a different agent for the plaza',
			stageId: existing.id,
		});
	}

	const title = cleanStr(body.title, MAX_TITLE) || `${agent.name} Live`;
	const format = cleanStr(body.format, MAX_FORMAT) || 'open mic';
	const voice = cleanStr(body.voice, 40) || 'nova';
	const splitBps = normalizeSplitBps(body.tipSplitBps);
	const nextShowAt = parseFutureDate(body.nextShowAt);

	let hostWallet = null;
	try {
		const w = await ensureAgentWallet(agent.id, session.id, { reason: 'stage_plaza' });
		hostWallet = w?.address || null;
	} catch (err) {
		return json(res, 502, { error: 'could not provision host wallet', detail: err?.message });
	}

	const [row] = await sql`
		INSERT INTO stages (id, agent_id, owner_user_id, venue, title, format, voice, tip_split_bps, status, next_show_at, coin_mint)
		VALUES (${stageId}, ${agent.id}, ${session.id}, 'plaza', ${title}, ${format}, ${voice}, ${splitBps}, 'scheduled', ${nextShowAt}, ${mint})
		ON CONFLICT (id) DO UPDATE SET
			title = EXCLUDED.title, format = EXCLUDED.format, voice = EXCLUDED.voice,
			tip_split_bps = EXCLUDED.tip_split_bps, next_show_at = EXCLUDED.next_show_at,
			coin_mint = EXCLUDED.coin_mint, status = 'scheduled', updated_at = NOW()
		RETURNING *
	`;
	return json(res, 201, {
		ok: true,
		stage: shapeStage(row),
		hostWallet,
		link: `/play?coin=${encodeURIComponent(mint)}`,
	});
}

async function goLive(req, res, session, body) {
	const stage = await ownedStage(body.stageId, session.id);
	if (!stage) return json(res, 403, { error: 'you do not own this stage' });

	// Open a show (idempotent via the partial unique index, a second go-live
	// returns the already-open show rather than a duplicate).
	const [show] = await sql`
		INSERT INTO shows (stage_id) VALUES (${stage.id})
		ON CONFLICT (stage_id) WHERE ended_at IS NULL DO UPDATE SET stage_id = EXCLUDED.stage_id
		RETURNING *
	`;
	await sql`UPDATE stages SET status = 'live', updated_at = NOW() WHERE id = ${stage.id}`;

	// Tell holders the show is starting, in-app bell + a best-effort Telegram ping.
	insertNotification(session.id, 'stage_live', {
		stage_id: stage.id,
		agent_id: stage.agent_id,
		title: stage.title,
		link: `/stage?id=${stage.id}`,
	});
	sendOpsAlert(
		'Live stage started',
		`"${stage.title}" is live now. /stage?id=${stage.id}`,
		{ signature: `stage-live:${show.id}` },
	);

	return json(res, 200, { ok: true, show: shapeShow(show), link: `/stage?id=${stage.id}` });
}

async function endShow(req, res, session, body) {
	const stage = await ownedStage(body.stageId, session.id);
	if (!stage) return json(res, 403, { error: 'you do not own this stage' });
	const [show] = await sql`
		UPDATE shows SET ended_at = NOW()
		WHERE stage_id = ${stage.id} AND ended_at IS NULL
		RETURNING *
	`;
	await sql`UPDATE stages SET status = 'offline', updated_at = NOW() WHERE id = ${stage.id}`;
	if (!show) return json(res, 200, { ok: true, ended: false, reason: 'no open show' });
	return json(res, 200, { ok: true, show: shapeShow(show) });
}

async function ownedStage(stageId, userId) {
	if (!isUuid(stageId)) return null;
	const [s] = await sql`
		SELECT * FROM stages WHERE id = ${stageId} AND owner_user_id = ${userId} LIMIT 1
	`;
	return s || null;
}

// ── shaping ──────────────────────────────────────────────────────────────────
function shapeStage(s) {
	return {
		id: s.id,
		agent_id: s.agent_id,
		venue: s.venue,
		title: s.title,
		format: s.format,
		voice: s.voice,
		tip_split_bps: s.tip_split_bps,
		status: s.status,
		next_show_at: s.next_show_at ? Date.parse(s.next_show_at) : null,
		host_name: s.agent_name,
		host_avatar: s.avatar_url || s.profile_image_url || null,
		// The /play world this stage stands in, when it is a plaza stage, lets the
		// directory card offer "attend in-world" alongside the /stage venue link.
		coin_mint: s.coin_mint || null,
	};
}

function shapeShow(s) {
	return {
		id: s.id,
		started_at: s.started_at ? Date.parse(s.started_at) : null,
		ended_at: s.ended_at ? Date.parse(s.ended_at) : null,
		peak_audience: s.peak_audience ?? 0,
		total_tips_atomic: Number(s.total_tips_atomic || 0),
		tip_count: s.tip_count ?? 0,
	};
}

function cleanStr(v, max) {
	if (typeof v !== 'string') return '';
	return v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// Parse an epoch-ms or ISO date that must be in the future; otherwise null.
function parseFutureDate(v) {
	if (v == null) return null;
	const ms = typeof v === 'number' ? v : Date.parse(v);
	if (!Number.isFinite(ms) || ms < Date.now()) return null;
	return new Date(ms).toISOString();
}
