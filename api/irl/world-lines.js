/**
 * IRL World Lines — agent-placed proof-of-presence AR quests.
 *
 * A World Line is a persistent, location-anchored AR quest left by an agent. To
 * complete it, a person must physically travel to the spot, prove co-location, and
 * finish the agent-driven interaction in AR. On success the agent's OWN wallet
 * cryptographically signs a proof-of-presence — independently verifiable, ownable as
 * a collectible — without any precise coordinate ever entering the proof, a log, or
 * an alert.
 *
 *   POST /api/irl/world-lines            create a World Line (auth + owned agent + owned pin)
 *   GET  /api/irl/world-lines/nearby     fix-gated, co-located discovery (lat/lng + x-irl-fix)
 *   GET  /api/irl/world-lines/browse     public region listing (coarse, no coordinates)
 *   GET  /api/irl/world-lines/mine       creator dashboard (completions + coarse heatmap)
 *   GET  /api/irl/world-lines/collectibles  the caller's earned proofs (profile/wallet)
 *   GET  /api/irl/world-lines/:id        single World Line (fix-gated for the AR detail)
 *   POST /api/irl/world-lines/challenge  issue a single-use completion nonce (co-located)
 *   POST /api/irl/world-lines/complete   the proof ceremony → agent-signed collectible
 *   GET  /api/irl/world-lines/verify/:proofId   re-check the agent signature (public)
 *
 * PRIVACY CONTRACT (mirrors api/irl/pins.js): the only surface that ever reveals a
 * precise spot is the existing fix-gated pin proximity read. A World Line stores only
 * its anchor pin_id + a coarse (~1.1 km, precision-6) cell. Co-location is ALWAYS
 * server-derived — the caller's claimed point is anti-spoofed by the fix token and
 * checked against the pin's server-side coordinates; the body is never trusted. No
 * proof, nonce, notification, or log line carries a coordinate or a raw device token.
 */

import { cors, json, wrap, rateLimited, readJson } from '../_lib/http.js';
import { sql } from '../_lib/db.js';
import { getSessionUser } from '../_lib/auth.js';
import { requireCsrf } from '../_lib/csrf.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { readDeviceToken } from '../_lib/irl-auth.js';
import { verifyFixToken, fixEnforced } from '../_lib/irl-presence.js';
import { insertNotification } from '../_lib/notify.js';
import { isUuid } from '../_lib/validate.js';
import { encodeGeohash } from '../_lib/geohash.js';
import { WORD_BLACKLIST } from '../../src/profanity.js';
import {
	coarseCell, isCoarseCell, normalizeChallengeSpec, normalizeRewardKind, normalizeDifficulty,
	canonicalProofMessage, completerHash, signPresenceProof, verifyPresenceProof,
	mintPresenceNonce, verifyPresenceNonce, TITLE_MAX, PROMPT_MAX,
} from '../_lib/world-lines.js';

// Region cell (~5 km, precision-5) — the public-browse aggregation unit, deliberately
// coarser than the proof's ~1.1 km cell so the discovery map only ever says "N quests
// around this area," never anything that could localise one quest precisely.
const REGION_CELL_PRECISION = 5;

// Co-location radius: a completion's claimed point (anti-spoofed by the fix token)
// must be within this of the anchor pin's server-side coordinates. A touch wider than
// the 60 m pin proximity read to tolerate the GPS jitter at the exact moment someone
// taps "complete," far too tight to satisfy from across town.
const COLOCATION_RADIUS_M = 80;

// Discovery radius: how far away a walking explorer can SEE a quest to head toward it.
// Wider than the 60 m pin proximity (which alone resolves the precise AR anchor), so
// the game says "a quest is ~200 m north" while the exact spot still only materialises
// once you're on top of it via the pin feed. Coarse distance only.
const NEARBY_DEFAULT_RADIUS_M = 250;
const NEARBY_MAX_RADIUS_M = 600;

const MAX_WORLD_LINES_PER_OWNER = 30;   // active quests one creator can run at once
const MAX_PER_REGION = 200;             // safety ceiling per ~5 km region
const DEFAULT_LIFETIME_DAYS = 30;
const MAX_LIFETIME_DAYS = 90;
const MAX_COMPLETIONS_CAP = 100_000;    // an explicit sane bound on the cap field

// $THREE is the only coin three.ws references. The off-brand guard is generic by
// construction (it never names a competing ticker) — same logic the pin feed uses.
const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
function hardBlocked(text) {
	const t = String(text || '').toLowerCase();
	return WORD_BLACKLIST.some((w) => t.includes(w));
}
function namesOffBrandCoin(text) {
	const t = String(text || '');
	const cashtags = t.match(/\$[A-Za-z][A-Za-z0-9]{1,9}\b/g) || [];
	if (cashtags.some((c) => c.slice(1).toUpperCase() !== 'THREE')) return true;
	const tokens = t.match(/\b[1-9A-HJ-NP-Za-km-z]{32,48}\b/g) || [];
	if (tokens.some((m) => /pump$/.test(m) && m !== THREE_MINT)) return true;
	return false;
}
// A pin id is a server-minted UUID; accept that plus a conservative opaque-id shape.
const PIN_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PIN_ID_SAFE_RE = /^[A-Za-z0-9_-]{1,64}$/;
function isValidPinId(id) {
	return typeof id === 'string' && !!id && (PIN_UUID_RE.test(id) || PIN_ID_SAFE_RE.test(id));
}

function haversineM(lat1, lng1, lat2, lng2) {
	const R = 6371000;
	const toRad = (d) => (d * Math.PI) / 180;
	const dLat = toRad(lat2 - lat1);
	const dLng = toRad(lng2 - lng1);
	const a = Math.sin(dLat / 2) ** 2
		+ Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
	return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

let _tableReady = false;
async function ensureTables() {
	if (_tableReady) return;
	await sql`
		CREATE TABLE IF NOT EXISTS irl_world_lines (
			id               UUID DEFAULT gen_random_uuid() PRIMARY KEY,
			creator_user_id  UUID,
			creator_device   TEXT,
			agent_id         UUID NOT NULL,
			signer_pubkey    TEXT NOT NULL,
			pin_id           UUID NOT NULL,
			coarse_cell      TEXT NOT NULL,
			region_cell      TEXT NOT NULL,
			title            TEXT NOT NULL,
			prompt           TEXT,
			challenge_spec   JSONB NOT NULL,
			reward_kind      TEXT NOT NULL DEFAULT 'collectible',
			reward_ref       TEXT,
			reward_meta      JSONB,
			difficulty       TEXT NOT NULL DEFAULT 'easy',
			max_completions  INTEGER,
			completion_count INTEGER NOT NULL DEFAULT 0,
			hidden_at        TIMESTAMPTZ,
			created_at       TIMESTAMPTZ DEFAULT NOW(),
			expires_at       TIMESTAMPTZ
		)
	`;
	await sql`CREATE INDEX IF NOT EXISTS irl_world_lines_cell ON irl_world_lines (coarse_cell) WHERE hidden_at IS NULL`;
	await sql`CREATE INDEX IF NOT EXISTS irl_world_lines_region ON irl_world_lines (region_cell) WHERE hidden_at IS NULL`;
	await sql`CREATE INDEX IF NOT EXISTS irl_world_lines_pin ON irl_world_lines (pin_id)`;
	await sql`CREATE INDEX IF NOT EXISTS irl_world_lines_expires ON irl_world_lines (expires_at)`;
	await sql`CREATE INDEX IF NOT EXISTS irl_world_lines_creator ON irl_world_lines (creator_user_id)`;

	await sql`
		CREATE TABLE IF NOT EXISTS irl_presence_proofs (
			id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
			world_line_id     UUID NOT NULL,
			agent_id          UUID,
			signer_pubkey     TEXT NOT NULL,
			coarse_cell       TEXT NOT NULL,
			nonce_id          TEXT NOT NULL,
			completer_hash    TEXT NOT NULL,
			completer_user_id UUID,
			completer_device  TEXT,
			signature         TEXT NOT NULL,
			signed_message    TEXT NOT NULL,
			challenge_kind    TEXT,
			collectible_mint  TEXT,
			collectible_name  TEXT,
			reward_kind       TEXT,
			created_at        TIMESTAMPTZ DEFAULT NOW()
		)
	`;
	// nonce_id UNIQUE → one settled proof per server-issued nonce (idempotency + replay
	// guard). (world_line_id, completer_hash) UNIQUE → one proof per visitor per quest.
	await sql`CREATE UNIQUE INDEX IF NOT EXISTS irl_presence_proofs_nonce ON irl_presence_proofs (nonce_id)`;
	await sql`CREATE UNIQUE INDEX IF NOT EXISTS irl_presence_proofs_once ON irl_presence_proofs (world_line_id, completer_hash)`;
	await sql`CREATE INDEX IF NOT EXISTS irl_presence_proofs_wl ON irl_presence_proofs (world_line_id, created_at DESC)`;
	await sql`CREATE INDEX IF NOT EXISTS irl_presence_proofs_user ON irl_presence_proofs (completer_user_id, created_at DESC)`;
	await sql`CREATE INDEX IF NOT EXISTS irl_presence_proofs_device ON irl_presence_proofs (completer_device, created_at DESC)`;
	_tableReady = true;
}

// ── Routing ──────────────────────────────────────────────────────────────────
// Parse the action segment after /api/irl/world-lines. vercel.json rewrites the
// sub-paths to this one function (mirrors how /api/irl/pins/mine routes to pins.js).
function routeOf(req) {
	const path = String(req.url || '').split('?')[0].replace(/\/+$/, '');
	const m = path.match(/\/api\/irl\/world-lines\/?(.*)$/);
	const rest = m ? m[1] : '';
	if (!rest) return { action: 'root' };
	const [first, second] = rest.split('/');
	if (first === 'verify') return { action: 'verify', id: second || null };
	const KNOWN = new Set(['nearby', 'browse', 'mine', 'collectibles', 'challenge', 'complete']);
	if (KNOWN.has(first)) return { action: first };
	return { action: 'detail', id: first };
}

const isLive = `hidden_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())`;

export default wrap(async (req, res) => {
	cors(req, res, { methods: ['GET', 'POST', 'OPTIONS'], credentials: true });
	if (req.method === 'OPTIONS') return res.end();

	await ensureTables();
	const { action, id } = routeOf(req);

	if (req.method === 'GET') {
		// Public reads share the generic per-IP read ceiling; the fix-gated reads add
		// the proof-of-presence binding on top so a quest's spot can't be browsed remotely.
		const rl = await limits.publicIp(clientIp(req));
		if (!rl.success) return rateLimited(res, rl);
		if (action === 'nearby') return handleNearby(req, res);
		if (action === 'browse') return handleBrowse(req, res);
		if (action === 'mine') return handleMine(req, res);
		if (action === 'collectibles') return handleCollectibles(req, res);
		if (action === 'verify') return handleVerify(req, res, id);
		if (action === 'detail') return handleDetail(req, res, id);
		return json(res, 404, { error: 'unknown world-lines route' });
	}

	if (req.method === 'POST') {
		if (action === 'challenge') return handleChallenge(req, res);
		if (action === 'complete') return handleComplete(req, res);
		if (action === 'root') return handleCreate(req, res);
		return json(res, 404, { error: 'unknown world-lines route' });
	}

	return json(res, 405, { error: 'method not allowed' });
});

// ── Co-location ──────────────────────────────────────────────────────────────
// Resolve, server-side, whether the caller is genuinely at a World Line's anchor.
// Returns { ok:true, cell } or { ok:false, status, body }. The claimed lat/lng is
// validated by the fix token (proves a real recent GPS fix near the claim) AND then
// checked against the anchor pin's server-side coordinates — the body is never
// trusted for the distance check. The coarse cell returned is derived from the pin,
// not the caller, so it matches the World Line exactly.
async function resolveColocation(req, body, wl) {
	const lat = parseFloat(body.lat);
	const lng = parseFloat(body.lng);
	if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
		return { ok: false, status: 400, body: { error: 'lat and lng are required' } };
	}
	// Proof-of-presence: bind to a genuine fix when enforced (prod). Dev/preview without
	// IRL_FIX_SECRET skips the token (same posture as the pins read) but STILL runs the
	// server-side distance check below, so co-location is never simply trusted.
	if (fixEnforced()) {
		const fixHeader = req.headers['x-irl-fix'];
		const fixToken = Array.isArray(fixHeader) ? fixHeader[0] : fixHeader;
		const v = await verifyFixToken(fixToken, lat, lng);
		if (!v.ok) {
			return {
				ok: false, status: 401,
				body: { error: 'fix_required', reason: v.reason, error_description: 'a fresh location fix is required' },
			};
		}
	}
	// The anchor pin holds the precise coordinate (gated, never returned here). Read it
	// server-side only to compute the co-location boolean.
	const [pin] = await sql`
		SELECT lat, lng FROM irl_pins
		WHERE id = ${wl.pin_id} AND hidden_at IS NULL
		  AND (expires_at IS NULL OR expires_at > NOW())
		LIMIT 1
	`;
	if (!pin) {
		return { ok: false, status: 410, body: { error: 'anchor_gone', error_description: 'this quest’s anchor is no longer placed' } };
	}
	const dist = haversineM(lat, lng, pin.lat, pin.lng);
	if (dist > COLOCATION_RADIUS_M) {
		return {
			ok: false, status: 403,
			body: { error: 'not_colocated', error_description: 'travel to the quest to complete it', within_m: COLOCATION_RADIUS_M },
		};
	}
	return { ok: true, cell: wl.coarse_cell };
}

// ── Create ───────────────────────────────────────────────────────────────────
async function handleCreate(req, res) {
	const rl = await limits.worldLineCreateIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const session = await getSessionUser(req).catch(() => null);
	// Creation is accountable: the agent's custodial wallet signs every proof this quest
	// mints, so the creator must be a signed-in owner of that agent. Anonymous device
	// placements (which have no agent wallet) can't author a signing quest.
	if (!session) return json(res, 401, { error: 'sign in to place a World Line' });
	if (!(await requireCsrf(req, res, session.id))) return; // CSRF on the authed write

	let body;
	try {
		body = await readJson(req);
	} catch (err) {
		return json(res, err.status || 400, { error: err.message || 'invalid body' });
	}

	const pinId = body.pinId;
	if (!isValidPinId(pinId)) return json(res, 400, { error: 'a valid pinId is required' });

	// The caller must own the anchor pin (it carries the precise spot). Read its coords
	// server-side to derive the coarse + region cells — never trusted from the body.
	const [pin] = await sql`
		SELECT id, user_id, agent_id, lat, lng, published FROM irl_pins
		WHERE id = ${pinId} AND hidden_at IS NULL
		  AND (expires_at IS NULL OR expires_at > NOW())
		LIMIT 1
	`;
	if (!pin) return json(res, 404, { error: 'pin not found' });
	if (!pin.user_id || pin.user_id !== session.id) {
		return json(res, 403, { error: 'you can only anchor a World Line to your own pin' });
	}
	// A World Line is a public invitation to walk to a spot. Anchoring one to a
	// PRIVATE pin would publish the very coordinate the owner marked private, so
	// refuse at creation rather than silently filtering it out of discovery later.
	// The owner makes the pin public first — an explicit, deliberate act.
	if (pin.published === false) {
		return json(res, 409, {
			error: 'this pin is private',
			error_description: 'A World Line invites strangers to its location. Make the pin public before anchoring a quest to it.',
		});
	}

	// The signing agent: the pin's agent, or a caller-supplied agent they own.
	const agentId = isUuid(body.agentId) ? body.agentId : (pin.agent_id || null);
	if (!agentId) return json(res, 400, { error: 'this pin has no agent; pass an agentId you own' });
	const [agent] = await sql`
		SELECT id, user_id FROM agent_identities
		WHERE id = ${agentId} AND deleted_at IS NULL LIMIT 1
	`;
	if (!agent) return json(res, 404, { error: 'agent not found' });
	if (agent.user_id !== session.id) {
		return json(res, 403, { error: 'you can only sign quests with an agent you own' });
	}

	// Title + prompt: the public, agent-spoken content. Same content floor as a pin
	// caption — slur gate + $THREE-only coin guard — so a quest can't shill or abuse.
	const title = String(body.title ?? '').replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX);
	if (!title) return json(res, 400, { error: 'a title is required' });
	if (hardBlocked(title) || namesOffBrandCoin(title)) {
		return json(res, 422, { error: 'content', field: 'title', message: 'That title isn’t allowed. A quest can only reference $THREE.' });
	}
	const prompt = body.prompt != null ? String(body.prompt).replace(/\s+/g, ' ').trim().slice(0, PROMPT_MAX) : '';
	if (prompt && (hardBlocked(prompt) || namesOffBrandCoin(prompt))) {
		return json(res, 422, { error: 'content', field: 'prompt', message: 'That prompt isn’t allowed. A quest can only reference $THREE.' });
	}

	const challenge = normalizeChallengeSpec(body.challenge ?? body.challenge_spec);
	if (!challenge.ok) return json(res, 400, { error: 'challenge', message: challenge.error });
	// Quest prompt/phrase/question text gets the same content gate.
	for (const field of ['prompt', 'question']) {
		const v = challenge.spec[field];
		if (v && (hardBlocked(v) || namesOffBrandCoin(v))) {
			return json(res, 422, { error: 'content', field, message: 'That text isn’t allowed. A quest can only reference $THREE.' });
		}
	}

	const rewardKind = normalizeRewardKind(body.reward_kind ?? body.rewardKind);
	const rewardRef = body.reward_ref != null ? String(body.reward_ref).slice(0, 80) : null;
	const difficulty = normalizeDifficulty(body.difficulty);

	let maxCompletions = null;
	const rawMax = Number(body.max_completions ?? body.maxCompletions);
	if (Number.isInteger(rawMax) && rawMax > 0) maxCompletions = Math.min(MAX_COMPLETIONS_CAP, rawMax);

	const lifetimeDays = Math.min(MAX_LIFETIME_DAYS, Math.max(1,
		Number.isFinite(Number(body.lifetime_days)) ? Number(body.lifetime_days) : DEFAULT_LIFETIME_DAYS));
	const expiresAt = new Date(Date.now() + lifetimeDays * 86400_000).toISOString();

	const cell = coarseCell(pin.lat, pin.lng);
	const region = encodeGeohash(pin.lat, pin.lng, REGION_CELL_PRECISION);
	if (!isCoarseCell(cell)) return json(res, 400, { error: 'pin location is not placeable' });

	// Per-owner active-quest cap + a per-region safety ceiling.
	const [{ owned }] = await sql`
		SELECT count(*)::int AS owned FROM irl_world_lines
		WHERE creator_user_id = ${session.id} AND hidden_at IS NULL
		  AND (expires_at IS NULL OR expires_at > NOW())
	`;
	if (owned >= MAX_WORLD_LINES_PER_OWNER) {
		return json(res, 429, { error: 'quest_limit', limit: MAX_WORLD_LINES_PER_OWNER, message: 'You’ve reached your active World Line limit. Retire one to place another.' });
	}
	const [{ inRegion }] = await sql`
		SELECT count(*)::int AS "inRegion" FROM irl_world_lines
		WHERE region_cell = ${region} AND hidden_at IS NULL
		  AND (expires_at IS NULL OR expires_at > NOW())
	`;
	if (inRegion >= MAX_PER_REGION) {
		return json(res, 429, { error: 'region_full', message: 'This region already has the maximum number of quests.' });
	}

	// Capture the agent's signing public key now, so verification is anchored to the key
	// in force at creation. ensureAgentWallet is idempotent (provisions on first need).
	let signerPubkey;
	try {
		const { ensureAgentWallet } = await import('../_lib/agent-wallet.js');
		const w = await ensureAgentWallet(agentId, session.id, { reason: 'world-line:create' });
		signerPubkey = w.address;
	} catch (err) {
		console.error('[irl/world-lines] could not provision agent signer', { agentId, message: err?.message });
		return json(res, 502, { error: 'could not provision the agent’s signing wallet' });
	}

	const [row] = await sql`
		INSERT INTO irl_world_lines
			(creator_user_id, agent_id, signer_pubkey, pin_id, coarse_cell, region_cell,
			 title, prompt, challenge_spec, reward_kind, reward_ref, difficulty,
			 max_completions, expires_at)
		VALUES (
			${session.id}, ${agentId}, ${signerPubkey}, ${pinId}, ${cell}, ${region},
			${title}, ${prompt || null}, ${JSON.stringify(challenge.spec)}::jsonb,
			${rewardKind}, ${rewardRef}, ${difficulty}, ${maxCompletions}, ${expiresAt}
		)
		RETURNING id, agent_id, signer_pubkey, pin_id, coarse_cell, region_cell, title,
		          prompt, challenge_spec, reward_kind, reward_ref, difficulty,
		          max_completions, completion_count, created_at, expires_at
	`;
	return json(res, 201, { world_line: publicWorldLine(row, { owner: true }) });
}

// ── Nearby (fix-gated, co-located discovery) ─────────────────────────────────
async function handleNearby(req, res) {
	const lat = parseFloat(req.query.lat);
	const lng = parseFloat(req.query.lng);
	if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
		return json(res, 400, { error: 'lat and lng are required' });
	}
	const rawRadius = req.query.radius;
	const parsed = rawRadius == null || rawRadius === '' ? NEARBY_DEFAULT_RADIUS_M : parseFloat(rawRadius);
	if (!Number.isFinite(parsed)) return json(res, 400, { error: 'invalid radius' });
	const radius = Math.min(NEARBY_MAX_RADIUS_M, Math.max(30, parsed));

	// Same fix-gate as the pin proximity read: a quest's location is only revealed to a
	// caller proven to be standing near it.
	if (fixEnforced()) {
		const fixHeader = req.headers['x-irl-fix'];
		const fixToken = Array.isArray(fixHeader) ? fixHeader[0] : fixHeader;
		const v = await verifyFixToken(fixToken, lat, lng);
		if (!v.ok) return json(res, 401, { error: 'fix_required', reason: v.reason });
	}

	const latDelta = radius / 110540;
	const lngDelta = radius / (111320 * Math.cos(lat * Math.PI / 180) || 1);

	const session = await getSessionUser(req).catch(() => null);
	const myId = session?.id ?? null;
	const myDev = readDeviceToken(req);

	// Join to the anchor pin for the proximity filter (precise coords used only to
	// compute a coarse distance, never returned). The completer's own completion state
	// is surfaced so the client can render "already done" without leaking who else did.
	const myHash = await completerHash(myId ?? myDev ?? '');
	const rows = await sql`
		SELECT w.id, w.agent_id, w.signer_pubkey, w.pin_id, w.coarse_cell, w.title, w.prompt,
		       w.challenge_spec, w.reward_kind, w.reward_ref, w.difficulty,
		       w.max_completions, w.completion_count, w.created_at, w.expires_at,
		       p.lat AS pin_lat, p.lng AS pin_lng,
		       EXISTS (SELECT 1 FROM irl_presence_proofs pr
		               WHERE pr.world_line_id = w.id AND pr.completer_hash = ${myHash}) AS mine_done
		FROM irl_world_lines w
		JOIN irl_pins p ON p.id = w.pin_id
		WHERE w.hidden_at IS NULL
		  AND (w.expires_at IS NULL OR w.expires_at > NOW())
		  AND p.hidden_at IS NULL AND (p.expires_at IS NULL OR p.expires_at > NOW())
		  -- A quest anchored to a PRIVATE pin never reaches a stranger. This feed has
		  -- the widest coordinate radius on the platform (600 m vs 60 m for pins), so
		  -- it must honour the anchor pin's visibility or it silently becomes the
		  -- cheapest private-pin bypass we ship.
		  AND p.published IS NOT FALSE
		  AND p.lat BETWEEN ${lat - latDelta} AND ${lat + latDelta}
		  AND p.lng BETWEEN ${lng - lngDelta} AND ${lng + lngDelta}
		ORDER BY w.created_at DESC
		LIMIT 50
	`;

	const quests = rows
		.map((r) => {
			const distance = Math.round(haversineM(lat, lng, r.pin_lat, r.pin_lng));
			return { r, distance };
		})
		.filter(({ distance }) => distance <= radius)
		.sort((a, b) => a.distance - b.distance)
		.map(({ r, distance }) => ({
			...publicWorldLine(r, { owner: false }),
			// Distance coarsened to 10 m — enough to render an arrow + "≈200 m" without
			// triangulating the exact spot from successive reads.
			distance_m: Math.max(0, Math.round(distance / 10) * 10),
			completed_by_me: r.mine_done === true,
			capacity_reached: r.max_completions != null && r.completion_count >= r.max_completions,
		}));

	return json(res, 200, { world_lines: quests });
}

// ── Browse (public, coarse region listing — no coordinates) ──────────────────
async function handleBrowse(req, res) {
	const difficulty = req.query.difficulty;
	const diffFilter = difficulty && ['easy', 'medium', 'hard'].includes(String(difficulty)) ? String(difficulty) : null;
	const region = typeof req.query.region === 'string' && /^[0-9bcdefghjkmnpqrstuvwxyz]{5}$/.test(req.query.region)
		? req.query.region : null;

	if (region) {
		// One region's active quests — title/reward/difficulty + live completion stats.
		// Still NO coordinate: the AR spot only ever resolves through the fix-gated feeds.
		const rows = diffFilter
			? await sql`
				SELECT id, title, reward_kind, difficulty, completion_count, max_completions, created_at
				FROM irl_world_lines
				WHERE region_cell = ${region} AND difficulty = ${diffFilter} AND hidden_at IS NULL
				  AND (expires_at IS NULL OR expires_at > NOW())
				ORDER BY created_at DESC LIMIT 60`
			: await sql`
				SELECT id, title, reward_kind, difficulty, completion_count, max_completions, created_at
				FROM irl_world_lines
				WHERE region_cell = ${region} AND hidden_at IS NULL
				  AND (expires_at IS NULL OR expires_at > NOW())
				ORDER BY created_at DESC LIMIT 60`;
		return json(res, 200, {
			region,
			quests: rows.map((r) => ({
				id: r.id, title: r.title, reward_kind: r.reward_kind, difficulty: r.difficulty,
				completion_count: r.completion_count,
				capacity_reached: r.max_completions != null && r.completion_count >= r.max_completions,
			})),
		});
	}

	// Region roll-up: how many active quests per ~5 km region. Pure aggregate, the
	// privacy-safe "where in the world are quests" map.
	const rows = await sql`
		SELECT region_cell, count(*)::int AS quests,
		       count(*) FILTER (WHERE difficulty = 'hard')::int AS hard,
		       sum(completion_count)::int AS completions
		FROM irl_world_lines
		WHERE hidden_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())
		GROUP BY region_cell
		ORDER BY quests DESC
		LIMIT 200
	`;
	res.setHeader('cache-control', 'public, s-maxage=60, stale-while-revalidate=300');
	return json(res, 200, { regions: rows });
}

// ── Single World Line (fix-gated, for the AR detail view) ────────────────────
async function handleDetail(req, res, id) {
	if (!isUuid(id)) return json(res, 400, { error: 'invalid world line id' });
	const [w] = await sql`
		SELECT w.id, w.agent_id, w.signer_pubkey, w.pin_id, w.coarse_cell, w.title, w.prompt,
		       w.challenge_spec, w.reward_kind, w.reward_ref, w.difficulty,
		       w.max_completions, w.completion_count, w.created_at, w.expires_at,
		       p.lat AS pin_lat, p.lng AS pin_lng, p.hidden_at AS pin_hidden, p.expires_at AS pin_expires
		FROM irl_world_lines w
		JOIN irl_pins p ON p.id = w.pin_id
		WHERE w.id = ${id} AND w.hidden_at IS NULL AND (w.expires_at IS NULL OR w.expires_at > NOW())
		LIMIT 1
	`;
	if (!w) return json(res, 404, { error: 'world line not found' });

	// The challenge_spec includes the quiz/phrase ANSWER, which must not be handed to a
	// caller who hasn't proven they're at the spot (it would let them pre-solve remotely).
	// Resolve co-location; on success return the full spec, otherwise a redacted spec +
	// the coarse cell so the "travel here" state can still render.
	const lat = parseFloat(req.query.lat);
	const lng = parseFloat(req.query.lng);
	let colocated = false;
	if (Number.isFinite(lat) && Number.isFinite(lng)) {
		const co = await resolveColocation(req, { lat, lng }, w);
		colocated = co.ok;
	}
	return json(res, 200, { world_line: publicWorldLine(w, { revealAnswer: colocated }), colocated });
}

// ── Challenge (issue a single-use completion nonce) ──────────────────────────
async function handleChallenge(req, res) {
	const rl = await limits.worldLineChallengeIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	let body;
	try {
		body = await readJson(req);
	} catch (err) {
		return json(res, err.status || 400, { error: err.message || 'invalid body' });
	}
	const wlId = body.world_line_id ?? body.worldLineId ?? body.id;
	if (!isUuid(wlId)) return json(res, 400, { error: 'a valid world_line_id is required' });

	const wl = await loadWorldLine(wlId);
	if (!wl) return json(res, 404, { error: 'world line not found' });
	if (wl.max_completions != null && wl.completion_count >= wl.max_completions) {
		return json(res, 409, { error: 'capacity_reached', message: 'This quest has reached its completion limit.' });
	}

	const co = await resolveColocation(req, body, wl);
	if (!co.ok) return json(res, co.status, co.body);

	// Already completed by this visitor? Surface the existing proof so the client renders
	// the "already done" state instead of a fresh nonce.
	const session = await getSessionUser(req).catch(() => null);
	const who = await completerHash(session?.id ?? readDeviceToken(req) ?? '');
	const [existing] = await sql`
		SELECT id, collectible_mint FROM irl_presence_proofs
		WHERE world_line_id = ${wlId} AND completer_hash = ${who} LIMIT 1
	`;
	if (existing) {
		return json(res, 200, { already_completed: true, proof_id: existing.id, collectible_mint: existing.collectible_mint });
	}

	const minted = await mintPresenceNonce(wlId, wl.coarse_cell);
	if (!minted) return json(res, 500, { error: 'could not issue a challenge' });
	return json(res, 200, {
		nonce: minted.nonce,
		expires_in: minted.expires_in,
		challenge: revealedSpec(wl.challenge_spec, true),
		agent_id: wl.agent_id,
		world_line: { id: wl.id, title: wl.title, prompt: wl.prompt, reward_kind: wl.reward_kind, reward_ref: wl.reward_ref },
	});
}

// ── Complete (the proof ceremony) ────────────────────────────────────────────
async function handleComplete(req, res) {
	const rl = await limits.worldLineCompleteIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	let body;
	try {
		body = await readJson(req);
	} catch (err) {
		return json(res, err.status || 400, { error: err.message || 'invalid body' });
	}
	const wlId = body.world_line_id ?? body.worldLineId ?? body.id;
	if (!isUuid(wlId)) return json(res, 400, { error: 'a valid world_line_id is required' });
	const nonce = body.nonce;
	if (typeof nonce !== 'string' || !nonce) return json(res, 400, { error: 'a completion nonce is required' });

	const wl = await loadWorldLine(wlId);
	if (!wl) return json(res, 404, { error: 'world line not found' });

	// 1) Server-derived co-location (re-checked at completion, never trusted from body).
	const co = await resolveColocation(req, body, wl);
	if (!co.ok) return json(res, co.status, co.body);

	// 2) The nonce must be unforged, unexpired, and bound to THIS quest + coarse cell.
	const nv = await verifyPresenceNonce(nonce, wlId, wl.coarse_cell);
	if (!nv.ok) {
		const status = nv.reason === 'expired' ? 410 : 403;
		return json(res, status, { error: 'invalid_nonce', reason: nv.reason, message: 'Your challenge expired or was invalid — tap to try again.' });
	}

	// 3) The interaction itself, where the server CAN check it (quiz/phrase). For 'tap'
	//    the challenge is presence, already proven above.
	const spec = wl.challenge_spec || {};
	const interactionError = checkInteraction(spec, body);
	if (interactionError) return json(res, 422, { error: 'challenge_failed', message: interactionError });

	const session = await getSessionUser(req).catch(() => null);
	const completerUserId = session?.id ?? null;
	const completerDevice = readDeviceToken(req);
	const who = await completerHash(completerUserId ?? completerDevice ?? '');

	// 4) Idempotency / one-per-visitor: if this visitor already has a proof for this
	//    quest, return it unchanged rather than minting a second collectible.
	const [already] = await sql`
		SELECT * FROM irl_presence_proofs WHERE world_line_id = ${wlId} AND completer_hash = ${who} LIMIT 1
	`;
	if (already) return json(res, 200, { already_completed: true, proof: publicProof(already), collectible: collectibleOf(already) });

	// 5) Capacity (re-checked just before the signing mint).
	if (wl.max_completions != null && wl.completion_count >= wl.max_completions) {
		return json(res, 409, { error: 'capacity_reached', message: 'This quest has reached its completion limit.' });
	}

	// 6) The agent wallet signs the canonical proof-of-presence message.
	const message = canonicalProofMessage({
		worldLineId: wlId, coarseCell: wl.coarse_cell, nonceId: nv.nonceId, completerHash: who,
	});
	let signed;
	try {
		signed = await signWithAgent(wl.agent_id, completerUserId, message);
	} catch (err) {
		console.error('[irl/world-lines] agent signing failed', { agentId: wl.agent_id, message: err?.message });
		return json(res, 502, { error: 'the agent could not sign your proof — try again' });
	}
	// The signing key must match the key captured at creation, and the signature must
	// verify against it — we verify server-side BEFORE persisting, so a stored proof is
	// always genuine. (This is exactly what GET /verify re-runs for anyone.)
	if (signed.signerPubkey !== wl.signer_pubkey ||
		!verifyPresenceProof({ signerPubkey: signed.signerPubkey, message, signature: signed.signature })) {
		console.error('[irl/world-lines] self-verify failed', { wlId, agentId: wl.agent_id });
		return json(res, 502, { error: 'proof verification failed — try again' });
	}

	const collectibleName = wl.reward_ref || `${wl.title} — proof of presence`;

	// 7) Persist + count, guarded so capacity and one-per-visitor hold under concurrency.
	//    The unique indexes (nonce_id; world_line_id+completer_hash) make a racing double
	//    completion a clean conflict rather than a double mint. collectible_mint is the
	//    deterministic, ownable id of the collectible; the verifiable signature is its body.
	let proof;
	try {
		[proof] = await sql`
			INSERT INTO irl_presence_proofs
				(world_line_id, agent_id, signer_pubkey, coarse_cell, nonce_id, completer_hash,
				 completer_user_id, completer_device, signature, signed_message, challenge_kind,
				 collectible_name, reward_kind)
			VALUES (
				${wlId}, ${wl.agent_id}, ${signed.signerPubkey}, ${wl.coarse_cell}, ${nv.nonceId}, ${who},
				${completerUserId}, ${completerDevice}, ${signed.signature}, ${message}, ${spec.kind || 'tap'},
				${collectibleName}, ${wl.reward_kind}
			)
			ON CONFLICT (nonce_id) DO NOTHING
			RETURNING *
		`;
	} catch (err) {
		// A (world_line_id, completer_hash) unique violation = this visitor already
		// completed via a different nonce in a race. Return their existing proof.
		const [dupe] = await sql`
			SELECT * FROM irl_presence_proofs WHERE world_line_id = ${wlId} AND completer_hash = ${who} LIMIT 1
		`;
		if (dupe) return json(res, 200, { already_completed: true, proof: publicProof(dupe), collectible: collectibleOf(dupe) });
		throw err;
	}
	if (!proof) {
		// nonce_id conflict (the same nonce was already spent) — idempotent replay.
		const [dupe] = await sql`SELECT * FROM irl_presence_proofs WHERE nonce_id = ${nv.nonceId} LIMIT 1`;
		if (dupe) return json(res, 200, { already_completed: true, proof: publicProof(dupe), collectible: collectibleOf(dupe) });
		return json(res, 409, { error: 'already_completed', message: 'This challenge was already used.' });
	}

	// The collectible id is derived from the proof row id (stable, ownable, verifiable).
	const collectibleMint = `presence:${proof.id}`;
	await sql`UPDATE irl_presence_proofs SET collectible_mint = ${collectibleMint} WHERE id = ${proof.id}`;
	proof.collectible_mint = collectibleMint;

	// Bump the completion count under the capacity guard (no over-fill past max).
	await sql`
		UPDATE irl_world_lines SET completion_count = completion_count + 1
		WHERE id = ${wlId} AND (max_completions IS NULL OR completion_count < max_completions)
	`;

	// 8) Tell the creator someone completed their World Line — coarse cell + count only,
	//    never a coordinate or the completer's identity.
	if (wl.creator_user_id) {
		insertNotification(wl.creator_user_id, 'world_line_completed', {
			world_line_id: wlId,
			title: wl.title,
			coarse_cell: wl.coarse_cell,
			completion_count: (wl.completion_count || 0) + 1,
			link: '/world-lines/mine',
		});
	}

	return json(res, 201, { ok: true, proof: publicProof(proof), collectible: collectibleOf(proof) });
}

// Server-checkable part of a challenge. Presence ('tap') is already proven; quiz +
// phrase are graded against the stored spec so a completion can't be faked by skipping
// the interaction. Returns an error string or null.
function checkInteraction(spec, body) {
	if (!spec || spec.kind === 'tap') return null;
	if (spec.kind === 'quiz') {
		const ans = Number(body.answer);
		if (!Number.isInteger(ans) || ans !== spec.answer) return 'That’s not the right answer — try the quiz again.';
		return null;
	}
	if (spec.kind === 'phrase') {
		const said = String(body.phrase ?? body.answer ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
		if (!said || said !== spec.phrase) return 'That passphrase didn’t match — ask the agent again.';
		return null;
	}
	return null;
}

// ── Verify (public, independent signature re-check) ──────────────────────────
async function handleVerify(req, res, proofId) {
	if (!isUuid(proofId)) return json(res, 400, { error: 'invalid proof id' });
	const [p] = await sql`
		SELECT pr.*, w.title FROM irl_presence_proofs pr
		LEFT JOIN irl_world_lines w ON w.id = pr.world_line_id
		WHERE pr.id = ${proofId} LIMIT 1
	`;
	if (!p) return json(res, 404, { error: 'proof not found' });

	// Re-run the exact check anyone could: does the agent signature validate over the
	// stored canonical message? Self-contained — needs only fields on the proof row.
	const verified = verifyPresenceProof({
		signerPubkey: p.signer_pubkey, message: p.signed_message, signature: p.signature,
	});
	return json(res, 200, {
		verified,
		proof: {
			id: p.id,
			world_line_id: p.world_line_id,
			world_line_title: p.title ?? null,
			agent_id: p.agent_id,
			signer_pubkey: p.signer_pubkey,
			coarse_cell: p.coarse_cell,        // ~1.1 km — the only location the proof carries
			signed_message: p.signed_message,
			signature: p.signature,
			signature_scheme: 'ed25519',
			collectible_mint: p.collectible_mint,
			collectible_name: p.collectible_name,
			completed_at: p.created_at,
		},
	});
}

// ── Creator dashboard ────────────────────────────────────────────────────────
async function handleMine(req, res) {
	const session = await getSessionUser(req).catch(() => null);
	if (!session) return json(res, 401, { error: 'sign in to view your World Lines' });
	const rows = await sql`
		SELECT id, agent_id, signer_pubkey, pin_id, coarse_cell, region_cell, title, prompt,
		       challenge_spec, reward_kind, reward_ref, difficulty, max_completions,
		       completion_count, created_at, expires_at, hidden_at
		FROM irl_world_lines
		WHERE creator_user_id = ${session.id}
		ORDER BY created_at DESC LIMIT 100
	`;
	// Coarse heatmap: completions grouped by the proof's coarse cell — counts only, never
	// a precise point. (A quest has one anchor cell, so this is "completions per quest's
	// cell," the privacy-safe shape the dashboard renders.)
	const ids = rows.map((r) => r.id);
	let heat = [];
	if (ids.length) {
		heat = await sql`
			SELECT world_line_id, coarse_cell, count(*)::int AS completions
			FROM irl_presence_proofs
			WHERE world_line_id = ANY(${ids}::uuid[])
			GROUP BY world_line_id, coarse_cell
		`;
	}
	return json(res, 200, {
		world_lines: rows.map((r) => ({
			...publicWorldLine(r, { owner: true }),
			expired: r.expires_at != null && new Date(r.expires_at).getTime() <= Date.now(),
			hidden: r.hidden_at != null,
		})),
		heatmap: heat,
	});
}

// ── Collectibles (the caller's earned proofs, for profile/wallet) ────────────
async function handleCollectibles(req, res) {
	const session = await getSessionUser(req).catch(() => null);
	const myDev = readDeviceToken(req);
	const myId = session?.id ?? null;
	if (!myId && !myDev) return json(res, 400, { error: 'sign in or present a device token' });

	// Strictly scoped to the caller's own id or device token — each arm null-guarded so a
	// missing identifier can never surface another visitor's collectibles.
	const rows = await sql`
		SELECT pr.id, pr.world_line_id, pr.agent_id, pr.signer_pubkey, pr.coarse_cell,
		       pr.signature, pr.signed_message, pr.collectible_mint, pr.collectible_name,
		       pr.reward_kind, pr.created_at, w.title, w.difficulty
		FROM irl_presence_proofs pr
		LEFT JOIN irl_world_lines w ON w.id = pr.world_line_id
		WHERE ((${myId}::uuid IS NOT NULL AND pr.completer_user_id = ${myId}::uuid)
		    OR (${myDev}::text IS NOT NULL AND pr.completer_device = ${myDev}))
		ORDER BY pr.created_at DESC LIMIT 200
	`;
	return json(res, 200, {
		collectibles: rows.map((r) => ({
			...collectibleOf(r),
			world_line_id: r.world_line_id,
			world_line_title: r.title ?? null,
			difficulty: r.difficulty ?? null,
			coarse_cell: r.coarse_cell,
			earned_at: r.created_at,
			verify_url: `/api/irl/world-lines/verify/${r.id}`,
		})),
	});
}

// ── Shared helpers ───────────────────────────────────────────────────────────
async function loadWorldLine(id) {
	const [w] = await sql`
		SELECT id, creator_user_id, agent_id, signer_pubkey, pin_id, coarse_cell, title, prompt,
		       challenge_spec, reward_kind, reward_ref, difficulty, max_completions, completion_count
		FROM irl_world_lines
		WHERE id = ${id} AND hidden_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())
		LIMIT 1
	`;
	return w || null;
}

// Recover the agent's custodial Solana key and sign the message. Isolated so it's the
// single seam tests mock — the rest of completion is pure DB + crypto already covered.
async function signWithAgent(agentId, userId, message) {
	const { ensureAgentWallet, recoverSolanaAgentKeypair } = await import('../_lib/agent-wallet.js');
	await ensureAgentWallet(agentId, userId, { reason: 'world-line:sign' });
	const [agent] = await sql`SELECT meta FROM agent_identities WHERE id = ${agentId} AND deleted_at IS NULL LIMIT 1`;
	const encrypted = agent?.meta?.encrypted_solana_secret;
	if (!encrypted) throw new Error('agent has no recoverable signing key');
	const kp = await recoverSolanaAgentKeypair(encrypted, { agentId, userId, reason: 'world-line:sign' });
	return signPresenceProof({ secretKey: kp.secretKey, message });
}

// Strip the secret answer from a challenge spec unless the caller is co-located.
function revealedSpec(spec, reveal) {
	if (!spec || typeof spec !== 'object') return { kind: 'tap', prompt: null };
	if (reveal) return spec;
	const { kind, prompt, question, choices } = spec;
	// For a quiz, the question + choices are needed to render; only the answer index is
	// hidden. For a phrase, the agent asks for it verbally — never echo the passphrase.
	const out = { kind, prompt: prompt ?? null };
	if (kind === 'quiz') { out.question = question; out.choices = choices; }
	return out;
}

function publicWorldLine(r, { owner = false, revealAnswer = false } = {}) {
	return {
		id: r.id,
		agent_id: r.agent_id,
		signer_pubkey: r.signer_pubkey,
		pin_id: r.pin_id,
		coarse_cell: r.coarse_cell,
		region_cell: r.region_cell,
		title: r.title,
		prompt: r.prompt,
		challenge: owner ? r.challenge_spec : revealedSpec(r.challenge_spec, revealAnswer),
		reward_kind: r.reward_kind,
		reward_ref: r.reward_ref,
		difficulty: r.difficulty,
		max_completions: r.max_completions,
		completion_count: r.completion_count,
		created_at: r.created_at,
		expires_at: r.expires_at,
	};
}

function publicProof(p) {
	return {
		id: p.id,
		world_line_id: p.world_line_id,
		agent_id: p.agent_id,
		signer_pubkey: p.signer_pubkey,
		coarse_cell: p.coarse_cell,
		signature: p.signature,
		signed_message: p.signed_message,
		signature_scheme: 'ed25519',
		completed_at: p.created_at,
		verify_url: `/api/irl/world-lines/verify/${p.id}`,
	};
}

function collectibleOf(p) {
	return {
		mint: p.collectible_mint || `presence:${p.id}`,
		name: p.collectible_name || 'Proof of presence',
		kind: 'proof-of-presence',
		reward_kind: p.reward_kind || 'collectible',
		signer_pubkey: p.signer_pubkey,
		signature: p.signature,
		proof_id: p.id,
	};
}
