// Patronage — the Support surface, owner CRM, and server-enforced unlocks
// ========================================================================
// Routed from api/agents/solana-wallet.js as action 'patronage':
//
//   GET  /api/agents/:id/solana/patronage   — public read: level ladder, perk
//        ?viewer=<wallet>&network=&offset=     ladder, the patron wall, season
//                                              standings, and (when ?viewer is a
//                                              wallet) that wallet's own standing.
//                                              NEVER returns gated perk payloads.
//   PUT  /api/agents/:id/solana/patronage   — owner-only (auth + CSRF): replace the
//                                              perk ladder.
//   POST /api/agents/:id/solana/patronage   — body.op:
//        op:'unlock'  — prove wallet ownership (ed25519 over a fresh challenge),
//                       recompute on-chain support, return ONLY the perks that
//                       support level has really earned, with their payloads.
//        op:'optout'  — patron hides/shows themselves on the wall (same proof).
//
// Patron levels, perk entitlement, seasons, and the wall all DERIVE from the real
// custody ledger via api/_lib/patronage.js. Nothing here trusts a client claim of
// support: gated payloads are released only after the wallet signature is verified
// AND the live on-chain support clears the threshold.

import { sql } from '../_lib/db.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { cors, json, method, error, readJson, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { requireCsrf } from '../_lib/csrf.js';
import { verifySiwsSignature } from '../_lib/siws.js';
import { logAudit } from '../_lib/audit.js';
import {
	PATRON_LEVELS,
	PERK_TYPES,
	levelForUsd,
	currentSeason,
	aggregatePatrons,
	patronTotals,
	patronStanding,
	listPerks,
	entitledPerks,
	resolvePatronName,
	hiddenWallets,
} from '../_lib/patronage.js';

const WALL_PAGE = 24;        // patrons per wall page
const NAME_RESOLVE_CAP = 12; // SNS reverse-resolutions per request (bounds Bonfida calls)
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const CHALLENGE_TTL_MS = 10 * 60 * 1000;

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId };
	return null;
}

function levelPayload(level) {
	return level ? { key: level.key, label: level.label, glyph: level.glyph, accent: level.accent } : null;
}

// Verify a wallet-ownership challenge: the signature is a real ed25519 signature by
// `wallet` over `message`, and the message is bound to this agent + wallet + a
// recent timestamp (so it can't be replayed across agents or indefinitely).
function verifyChallenge({ message, signature, wallet, agentId }) {
	if (typeof message !== 'string' || typeof signature !== 'string') return { ok: false, reason: 'missing signature' };
	if (!message.includes(wallet) || !message.includes(agentId)) return { ok: false, reason: 'challenge not bound to this agent/wallet' };
	const m = /Issued At:\s*(.+)/.exec(message);
	const issued = m ? Date.parse(m[1].trim()) : NaN;
	if (!Number.isFinite(issued) || Math.abs(Date.now() - issued) > CHALLENGE_TTL_MS) {
		return { ok: false, reason: 'challenge expired — refresh and sign again' };
	}
	let valid = false;
	try { valid = verifySiwsSignature(message, signature, wallet); } catch { valid = false; }
	return valid ? { ok: true } : { ok: false, reason: 'signature did not verify for this wallet' };
}

export default async function handler(req, res, id) {
	if (req.method === 'PUT' || req.method === 'POST') return handleWrite(req, res, id);
	return handleRead(req, res, id);
}

// ── GET: public Support state ───────────────────────────────────────────────────
async function handleRead(req, res, id) {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.agentProfileIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://x');
	const network = url.searchParams.get('network') === 'devnet' ? 'devnet' : 'mainnet';
	const viewer = (url.searchParams.get('viewer') || '').trim();
	const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);

	const [agent] = await sql`
		SELECT id, user_id, name, meta FROM agent_identities WHERE id = ${id} AND deleted_at IS NULL
	`;
	if (!agent) return error(res, 404, 'not_found', 'agent not found');

	const auth = await resolveAuth(req).catch(() => null);
	const isOwner = !!auth && auth.userId === agent.user_id;

	const season = currentSeason();
	const [perks, lifetime, seasonTotals, hidden] = await Promise.all([
		listPerks(id, { activeOnly: !isOwner }),
		patronTotals(id, { network }),
		patronTotals(id, { network, since: season.startsAt }),
		hiddenWallets(id),
	]);

	// Wall page: top supporters, opt-outs removed, top names resolved (bounded).
	const page = await aggregatePatrons(id, { network, limit: WALL_PAGE + 1, offset });
	const hasMore = page.length > WALL_PAGE;
	const visible = page.slice(0, WALL_PAGE).filter((p) => !hidden.has(p.wallet));
	let resolved = 0;
	const wall = [];
	for (const p of visible) {
		let name = null;
		if (resolved < NAME_RESOLVE_CAP) { name = await resolvePatronName(id, p.wallet).catch(() => null); resolved++; }
		wall.push({
			wallet: p.wallet,
			name,
			usd: p.usd,
			supportCount: p.supportCount,
			firstAt: p.firstAt,
			lastAt: p.lastAt,
			level: levelPayload(levelForUsd(p.usd)),
		});
	}

	// Season leaderboard: top 3 by support within the current epoch.
	const seasonTop = (await aggregatePatrons(id, { network, since: season.startsAt, limit: 3 }))
		.filter((p) => !hidden.has(p.wallet))
		.map((p) => ({ wallet: p.wallet, usd: p.usd, level: levelPayload(levelForUsd(p.usd)) }));

	// Viewer's own standing + which perks they've earned (titles/types only — the
	// gated payloads are released solely through the signature-verified unlock op).
	let viewerBlock = null;
	if (viewer && BASE58_RE.test(viewer)) {
		const standing = await patronStanding(id, viewer, { network });
		const earned = entitledPerks(perks, standing.usd);
		const hiddenForViewer = hidden.has(viewer);
		viewerBlock = {
			wallet: viewer,
			usd: standing.usd,
			supportCount: standing.supportCount,
			firstAt: standing.firstAt,
			lastAt: standing.lastAt,
			level: levelPayload(standing.level),
			progress: {
				pct: standing.progress.pct,
				next: levelPayload(standing.progress.next),
				remainingUsd: standing.progress.remainingUsd,
			},
			earnedPerkIds: earned.map((p) => p.id),
			hidden: hiddenForViewer,
		};
	}

	return json(res, 200, {
		data: {
			agent_id: id,
			agent_name: agent.name,
			network,
			is_owner: isOwner,
			levels: PATRON_LEVELS.map((l) => ({ key: l.key, label: l.label, glyph: l.glyph, accent: l.accent, min_usd: l.minUsd })),
			perks: perks.map((p) => ({
				id: p.id,
				perk_type: p.perkType,
				threshold_usd: p.thresholdUsd,
				title: p.title,
				description: p.description,
				is_active: p.isActive,
				// Owners may see their own payloads to edit them; visitors never do.
				payload: isOwner ? p.payload : undefined,
			})),
			totals: { lifetime, season: seasonTotals },
			season,
			season_top: seasonTop,
			wall,
			wall_has_more: hasMore,
			wall_offset: offset,
			viewer: viewerBlock,
		},
	});
}

// ── PUT / POST: owner config + patron actions ────────────────────────────────────
async function handleWrite(req, res, id) {
	if (cors(req, res, { methods: 'PUT,POST,OPTIONS', credentials: true })) return;

	const [agent] = await sql`
		SELECT id, user_id, name FROM agent_identities WHERE id = ${id} AND deleted_at IS NULL
	`;
	if (!agent) return error(res, 404, 'not_found', 'agent not found');

	if (req.method === 'PUT') return handleSetPerks(req, res, id, agent);

	// POST — patron-side actions (unlock / optout). Open to anyone with a wallet.
	let body;
	try { body = await readJson(req); } catch (e) {
		return error(res, e?.status === 415 ? 415 : 400, 'bad_request', e?.message || 'invalid request body');
	}
	const op = String(body.op || '').trim();
	if (op === 'unlock') return handleUnlock(req, res, id, body);
	if (op === 'optout') return handleOptOut(req, res, id, body);
	return error(res, 400, 'bad_request', 'unknown op (expected "unlock" or "optout")');
}

// Owner replaces the whole ladder in one call. Enforcement is by threshold, so we
// can rebuild from scratch each save without breaking any prior "unlock".
async function handleSetPerks(req, res, id, agent) {
	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');
	if (auth.userId !== agent.user_id) return error(res, 403, 'forbidden', 'not your agent');

	const rl = await limits.walletRead(auth.userId);
	if (!rl.success) return rateLimited(res, rl);
	if (!(await requireCsrf(req, res, auth.userId))) return;

	let body;
	try { body = await readJson(req); } catch (e) {
		return error(res, e?.status === 415 ? 415 : 400, 'bad_request', e?.message || 'invalid request body');
	}
	const input = Array.isArray(body.perks) ? body.perks : null;
	if (!input) return error(res, 400, 'validation_error', 'perks must be an array');
	if (input.length > 12) return error(res, 400, 'validation_error', 'at most 12 perks per agent');

	const clean = [];
	for (const raw of input) {
		const perkType = String(raw.perk_type || '').trim();
		if (!PERK_TYPES.includes(perkType)) return error(res, 400, 'validation_error', `invalid perk_type: ${perkType}`);
		const threshold = Number(raw.threshold_usd);
		if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1_000_000) {
			return error(res, 400, 'validation_error', 'threshold_usd must be between 0 and 1,000,000');
		}
		const title = String(raw.title || '').trim().slice(0, 120);
		if (!title) return error(res, 400, 'validation_error', 'each perk needs a title');
		const description = String(raw.description || '').trim().slice(0, 600) || null;

		const payloadIn = raw.payload && typeof raw.payload === 'object' ? raw.payload : {};
		const payload = {};
		if (perkType === 'skill') {
			const skill = String(payloadIn.skill || '').trim().slice(0, 100);
			if (!skill) return error(res, 400, 'validation_error', 'a skill perk needs payload.skill');
			payload.skill = skill;
		} else if (perkType === 'greeting' || perkType === 'lore') {
			const text = String(payloadIn.body || '').trim().slice(0, 4000);
			if (!text) return error(res, 400, 'validation_error', `a ${perkType} perk needs payload.body`);
			payload.body = text;
		} else if (perkType === 'badge') {
			payload.label = String(payloadIn.label || title).trim().slice(0, 40);
		}
		const isActive = raw.is_active !== false;
		clean.push({ perkType, threshold, title, description, payload, isActive });
	}

	await sql`DELETE FROM agent_patron_perks WHERE agent_id = ${id}`;
	for (const p of clean) {
		await sql`
			INSERT INTO agent_patron_perks (agent_id, perk_type, threshold_usd, title, description, payload, is_active)
			VALUES (${id}, ${p.perkType}, ${p.threshold}, ${p.title}, ${p.description}, ${JSON.stringify(p.payload)}::jsonb, ${p.isActive})
		`;
	}
	logAudit({ userId: auth.userId, action: 'patronage.set_perks', resourceId: id, meta: { count: clean.length }, req });

	const perks = await listPerks(id, { activeOnly: false });
	return json(res, 200, {
		data: {
			perks: perks.map((p) => ({
				id: p.id, perk_type: p.perkType, threshold_usd: p.thresholdUsd,
				title: p.title, description: p.description, is_active: p.isActive, payload: p.payload,
			})),
		},
	});
}

// Patron proves wallet ownership; we release exactly the perks their REAL,
// live-recomputed on-chain support has earned — payloads included.
async function handleUnlock(req, res, id, body) {
	const rl = await limits.agentProfileIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const wallet = String(body.wallet || '').trim();
	if (!BASE58_RE.test(wallet)) return error(res, 400, 'validation_error', 'a valid wallet is required');
	const network = body.network === 'devnet' ? 'devnet' : 'mainnet';

	const check = verifyChallenge({ message: body.message, signature: body.signature, wallet, agentId: id });
	if (!check.ok) return error(res, 401, 'unauthorized', check.reason);

	const [standing, perks] = await Promise.all([
		patronStanding(id, wallet, { network }),
		listPerks(id, { activeOnly: true }),
	]);
	const earned = entitledPerks(perks, standing.usd);
	const name = await resolvePatronName(id, wallet).catch(() => null);

	return json(res, 200, {
		data: {
			wallet,
			name,
			usd: standing.usd,
			level: levelPayload(standing.level),
			unlocked: earned.map((p) => ({
				id: p.id, perk_type: p.perkType, threshold_usd: p.thresholdUsd,
				title: p.title, description: p.description, payload: p.payload,
			})),
			locked: perks.filter((p) => standing.usd < p.thresholdUsd).map((p) => ({
				id: p.id, perk_type: p.perkType, threshold_usd: p.thresholdUsd, title: p.title,
				remaining_usd: Math.max(0, p.thresholdUsd - standing.usd),
			})),
		},
	});
}

// Patron toggles their own visibility on the public wall. Signature-gated so only
// the wallet owner can hide/show themselves. Support still counts toward totals.
async function handleOptOut(req, res, id, body) {
	const rl = await limits.agentProfileIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const wallet = String(body.wallet || '').trim();
	if (!BASE58_RE.test(wallet)) return error(res, 400, 'validation_error', 'a valid wallet is required');
	const hidden = body.hidden === true;

	const check = verifyChallenge({ message: body.message, signature: body.signature, wallet, agentId: id });
	if (!check.ok) return error(res, 401, 'unauthorized', check.reason);

	await sql`
		INSERT INTO agent_patron_prefs (agent_id, patron_wallet, hidden, updated_at)
		VALUES (${id}, ${wallet}, ${hidden}, now())
		ON CONFLICT (agent_id, patron_wallet)
		DO UPDATE SET hidden = EXCLUDED.hidden, updated_at = now()
	`;
	return json(res, 200, { data: { wallet, hidden } });
}
