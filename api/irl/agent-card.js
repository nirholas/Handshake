/**
 * IRL Agent Card (v2) — the rich profile shown when a viewer taps a 3D agent
 * placed in the real world.
 *
 *   GET /api/irl/agent-card?agent_id=<uuid>   resolve by agent identity id
 *   GET /api/irl/agent-card?id=<uuid>         alias of agent_id
 *   GET /api/irl/agent-card?pin=<pinId>       resolve via the pin's agent_id
 *
 * One server-side fan-out — agent record + on-chain Solana reputation + the
 * agent's paid x402 services — merged into a single payload so the camera popup
 * makes ONE call (instead of three round-trips from a phone on cellular) and the
 * card renders instantly. Public, IP rate-limited, Redis + CDN cached.
 *
 * Reputation is derived from the real Solana attestation system
 * (solana_attestations / threews.feedback|validation|accept.v1) — the same raw
 * aggregates /api/agents/solana-reputation exposes — but here we DERIVE a tier
 * and a 0–100 score server-side so the client renders a badge without
 * re-implementing the formula. A reputation-query failure must never fail the
 * card: it degrades to { available:false } and the service menu still renders.
 *
 * Services note: "services with x402 prices" are the agent's hosted paid
 * endpoints in `agent_paid_services` (each has a real USDC price, a network, and
 * a three.ws-hosted x402 paywall at /api/x402/service/<slug>). This is the only
 * service table with a per-service x402 endpoint — `agent_skill_prices` is a
 * separate Solana-Pay skill-purchase rail with no hosted endpoint, so it is not
 * what a "tap → pay this service" card should surface.
 *
 *   { agent:      { id, name, bio, thumbnail_url, profile_url },
 *     reputation: { asset, network, score, tier, attestation_count,
 *                   unique_attesters, tasks_accepted, available },
 *     services:   [{ skill, name, description, price_usd, currency, chain,
 *                    x402_endpoint }],
 *     x402_endpoint }
 */

import { cors, json, error, method, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { sql } from '../_lib/db.js';
import { thumbnailUrl } from '../_lib/r2.js';
import { getRedis } from '../_lib/redis.js';
import { atomicsToUsdc, serviceResourceUrl } from '../_lib/agent-paid-services.js';

const CACHE_TTL_S = 30;
const MAX_SERVICES = 6;
const BIO_MAX = 280;

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/**
 * Derive a 0–100 reputation score and a tier from the raw on-chain aggregates.
 *
 * Weights (documented, explicit):
 *   60%  feedback quality — average star rating (1–5) normalised to 0–1
 *   20%  attester breadth — unique attesters, log-scaled, saturating near ~50
 *   20%  validation pass rate — passed / (passed + failed) glTF/schema checks
 *
 * Tiers:  >=85 elite · >=60 trusted · >=30 emerging · else new
 */
export function deriveReputation({ fbTotal, scoreAvg, uniqueAttesters, valPassed, valFailed, tasksAccepted }) {
	// 1–5 stars → 0–1 (a 1-star floor contributes nothing; a 5-star avg is full).
	const scoreNorm = fbTotal > 0 ? clamp((scoreAvg - 1) / 4, 0, 1) : 0;
	// log10(1+n)/log10(51): 0 attesters → 0, ~50 attesters → ~1.
	const attesterNorm = clamp(Math.log10(1 + uniqueAttesters) / Math.log10(51), 0, 1);
	const valTotal = valPassed + valFailed;
	const valPassRate = valTotal > 0 ? valPassed / valTotal : 0;

	const score = clamp(Math.round(60 * scoreNorm + 20 * attesterNorm + 20 * valPassRate), 0, 100);
	const tier = score >= 85 ? 'elite' : score >= 60 ? 'trusted' : score >= 30 ? 'emerging' : 'new';

	return {
		score,
		tier,
		// "attestations" the viewer can point to: feedback left + validations passed.
		attestation_count: fbTotal + valPassed,
		unique_attesters: uniqueAttesters,
		tasks_accepted: tasksAccepted,
	};
}

/**
 * Fetch the on-chain reputation aggregates for an agent's Solana asset in a
 * single round-trip, then derive a tier/score.
 *
 * Failure contract (the card must never 500): a *query* failure — most commonly
 * a fresh / mid-migration DB where `solana_attestations` does not exist yet, but
 * also RPC/connection errors — REJECTS so the caller can mark the card
 * `{ available:false, degraded:true }` (we genuinely couldn't read reputation).
 * A *successful* read that yields no row (driver edge / partial result) is NOT a
 * failure: it means "no attestations", so we derive from zeros and the card
 * shows an available, freshly-scored agent rather than throwing on
 * `undefined.fb_total`.
 */
async function fetchReputation(asset, network) {
	const [row] = await sql`
		WITH fb AS (
			SELECT (payload->>'score')::int AS score, attester
			FROM solana_attestations
			WHERE agent_asset = ${asset} AND network = ${network}
			  AND kind = 'threews.feedback.v1' AND revoked = false
		),
		val AS (
			SELECT
				count(*) FILTER (WHERE (payload->>'passed')::bool)     AS passed,
				count(*) FILTER (WHERE NOT (payload->>'passed')::bool) AS failed
			FROM solana_attestations
			WHERE agent_asset = ${asset} AND network = ${network}
			  AND kind = 'threews.validation.v1' AND revoked = false
		)
		SELECT
			(SELECT count(*)::int FROM fb)                          AS fb_total,
			(SELECT coalesce(avg(score), 0)::float FROM fb)         AS score_avg,
			(SELECT count(DISTINCT attester)::int FROM fb)          AS unique_attesters,
			(SELECT coalesce(passed, 0)::int FROM val)              AS val_passed,
			(SELECT coalesce(failed, 0)::int FROM val)              AS val_failed,
			(SELECT count(*) FILTER (WHERE kind = 'threews.accept.v1' AND verified)::int
			   FROM solana_attestations
			  WHERE agent_asset = ${asset} AND network = ${network}) AS tasks_accepted
	`;
	// The coalesce'd subselects guarantee exactly one row from real Postgres; an
	// undefined row only arises from a driver/partial edge. Treat it as "no
	// attestations" (zeros) so a successful-but-empty read never throws a
	// TypeError that the caller would mislabel as a degraded query failure.
	const r = row || {};
	const toInt = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
	return deriveReputation({
		fbTotal: toInt(r.fb_total),
		scoreAvg: toInt(r.score_avg),
		uniqueAttesters: toInt(r.unique_attesters),
		valPassed: toInt(r.val_passed),
		valFailed: toInt(r.val_failed),
		tasksAccepted: toInt(r.tasks_accepted),
	});
}

async function buildCard(agentId, fallback = {}) {
	const [agent] = await sql`
		SELECT i.id, i.name, i.description, i.home_url, i.meta,
		       a.thumbnail_key AS avatar_thumbnail_key,
		       a.visibility    AS avatar_visibility
		FROM agent_identities i
		LEFT JOIN avatars a ON a.id = i.avatar_id AND a.deleted_at IS NULL
		WHERE i.id = ${agentId} AND i.deleted_at IS NULL AND i.is_public = true
		LIMIT 1
	`.catch(() => []);

	if (!agent) return null;

	const meta = agent.meta || {};
	// Solana asset + the network it was registered on (register flow stamps both).
	const asset =
		meta.sol_mint_address || meta.onchain?.sol_asset || meta.solana_asset || null;
	const network =
		meta.network || meta.onchain?.network || 'mainnet';

	// Reputation — degrade gracefully. No asset → "no on-chain reputation yet".
	let reputation;
	if (!asset) {
		reputation = { asset: null, available: false };
	} else {
		try {
			const rep = await fetchReputation(asset, network);
			reputation = { asset, network, available: true, ...rep };
		} catch (err) {
			console.warn('[irl/agent-card] reputation query failed, degrading:', err?.message);
			reputation = { asset, network, available: false, degraded: true };
		}
	}

	// price_atomics is text holding a bigint; ::numeric so ORDER BY sorts by value
	// (cheapest "try me" service first), not lexicographically.
	const services = await sql`
		SELECT slug, name, description, price_atomics, network
		FROM agent_paid_services
		WHERE agent_id = ${agentId} AND archived_at IS NULL
		ORDER BY price_atomics::numeric ASC
		LIMIT ${MAX_SERVICES}
	`.catch(() => []);

	const thumbPub  = agent.avatar_visibility === 'public' || agent.avatar_visibility === 'unlisted';
	const bio = agent.description ? String(agent.description).trim().slice(0, BIO_MAX) : null;

	return {
		agent: {
			id:            agent.id,
			name:          agent.name || fallback.name || 'Agent',
			bio:           bio || fallback.description || null,
			thumbnail_url: agent.avatar_thumbnail_key && thumbPub ? thumbnailUrl(agent.avatar_thumbnail_key) : null,
			profile_url:   agent.home_url || `/agents/${agent.id}`,
			// Public custodial wallet (same value GET /api/agents/:id/solana serves
			// anonymously) so the IRL inspect card can render the wallet chip + Tip.
			solana_address:        meta.solana_address || null,
			solana_vanity_prefix:  meta.solana_vanity_prefix || null,
			solana_vanity_suffix:  meta.solana_vanity_suffix || null,
		},
		reputation,
		services: services.map((s) => ({
			skill:         s.slug,
			name:          s.name,
			description:   s.description || null,
			price_usd:     atomicsToUsdc(s.price_atomics),
			currency:      'USDC',                         // paid services settle in USDC
			chain:         s.network || 'base',
			x402_endpoint: serviceResourceUrl(s.slug),
		})),
		x402_endpoint: fallback.x402_endpoint || null,
	};
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const p        = new URL(req.url, `http://${req.headers.host || 'x'}`).searchParams;
	const idParam  = (p.get('agent_id') || p.get('id') || '').trim();
	const pinParam = (p.get('pin') || '').trim();

	if (!idParam && !pinParam) {
		return error(res, 400, 'validation_error', 'agent_id or pin is required');
	}

	let agentId  = idParam || null;
	let fallback = {};
	const fromPin = !idParam && !!pinParam;

	// A minimal card for an anonymous pin (no linked agent) or a pin whose linked
	// agent is private/deleted — the pin is real and visible, so still render
	// something usable rather than 404-ing the tap.
	const anonCard = () => ({
		card: {
			agent: {
				id: null,
				name: fallback.name || 'Agent',
				bio: fallback.description || null,
				thumbnail_url: null,
				profile_url: null,
			},
			reputation: { asset: null, available: false },
			services: [],
			x402_endpoint: fallback.x402_endpoint || null,
			anonymous: true,
		},
	});

	// Resolve the linked agent (and an anonymous-pin fallback) from a pin id.
	if (!agentId && pinParam) {
		const [pin] = await sql`
			SELECT agent_id, avatar_name, caption, x402_endpoint
			FROM irl_pins
			WHERE id = ${pinParam} AND (expires_at IS NULL OR expires_at > NOW())
			LIMIT 1
		`.catch(() => []);
		if (!pin) return error(res, 404, 'not_found', 'pin not found');
		agentId  = pin.agent_id || null;
		fallback = {
			name:          pin.avatar_name || null,
			description:   pin.caption || null,
			x402_endpoint: pin.x402_endpoint || null,
		};
	}

	const cacheKey = agentId ? `irlcard:v2:${agentId}` : null;
	const redis    = cacheKey ? await getRedis() : null;

	if (redis && cacheKey) {
		try {
			const cached = await redis.get(cacheKey);
			if (cached) {
				res.setHeader('X-Cache', 'HIT');
				// The pin-derived x402 endpoint isn't part of the cached identity card.
				if (fallback.x402_endpoint && !cached.x402_endpoint) cached.x402_endpoint = fallback.x402_endpoint;
				return json(res, 200, { card: cached }, { 'Cache-Control': 'public, max-age=30, stale-while-revalidate=120' });
			}
		} catch { /* cache miss */ }
	}

	// No linked agent — return the anonymous pin's own minimal card.
	if (!agentId) {
		return json(res, 200, anonCard(), { 'Cache-Control': 'public, max-age=30' });
	}

	const card = await buildCard(agentId, fallback);
	if (!card) {
		// Pin → private/deleted agent: degrade to the pin's own card. Explicit
		// agent_id → genuine 404.
		if (fromPin) return json(res, 200, anonCard(), { 'Cache-Control': 'public, max-age=30' });
		return error(res, 404, 'not_found', 'agent not found');
	}

	if (redis && cacheKey) {
		// Cache the identity+reputation+services portion; the per-pin x402 endpoint
		// is pin-specific and merged per request.
		const { x402_endpoint, ...cacheable } = card;
		redis.set(cacheKey, cacheable, { ex: CACHE_TTL_S }).catch(() => {});
	}

	return json(res, 200, { card }, { 'Cache-Control': 'public, max-age=30, stale-while-revalidate=120' });
});
