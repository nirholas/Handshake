// Live activity feed store — the cross-surface "something is always happening
// here" ticker that makes three.ws feel alive on every page.
//
// Events are produced from many places — a coin buy confirmed in api/pump, an
// agent deployed in api/agents, a level-up or a world-join in the standalone
// multiplayer server — and read by the site-wide widget (public/feed.js) via
// GET /api/feed. Storage is a single capped Redis list `feed:events` ordered
// newest-first.
//
// Like presence-store, the multiplayer server writes to the SAME key directly
// (multiplayer/src/feed.js) rather than calling back through HTTP: Redis is the
// shared bus between the serverless API and the long-running game server. Both
// producers MUST emit the identical event shape documented below.
//
// ── Event shape ──────────────────────────────────────────────────────────────
//   { id, type, ts, actor, ...typeSpecific }
//     id    — opaque unique key; the widget de-dupes and uses it as a render key
//     type  — one of ALLOWED_TYPES
//     ts    — epoch ms
//     actor — short, already-sanitized display label (truncated wallet, player
//             name, agent name). NEVER a raw secret or full address we wouldn't
//             show publicly — this list is world-readable.
//   coin-buy      → { mint, sol, network }
//   agent-deploy  → { agentId, name }  — new agent joined the registry (off-chain)
//   agent-onchain → { agentId, name, chain }  — agent verified on-chain
//   level-up      → { skill, level, coin }
//   world-join   → { coin, coinName }
//   jackpot      → { reward, coin }
//   mission-complete → { mission, gold, coop, coin }  — /play job or heist finished
//   agora-registered    → { citizenId, agentPda, profession, narrative }  — a citizen joined Agora (AgenC registerAgent)
//   agora-task-posted   → { actor, taskPda, profession, rewardLabel, minReputation, cluster }  — a bounty was escrowed on the board (createTask)
//   agora-hired         → { actor, taskPda, profession, rewardLabel, cluster }  — a citizen hired a sub-agent (agent-to-agent)
//   agora-task-claimed  → { citizenId, agentPda, profession, taskPda, txSig, explorerUrl, narrative }  — claimed an on-chain task
//   agora-task-completed→ { citizenId, agentPda, profession, taskPda, proofHash, txSig, explorerUrl, narrative }  — proof accepted
//   agora-earned        → { citizenId, agentPda, profession, rewardLabel, txSig, explorerUrl, narrative }  — escrow released to the worker
//   agora-vouched       → { citizenId, agentPda, profession, taskPda, txSig, explorerUrl, narrative }  — a Verifier re-derived a proof and it held
//   agora-flagged       → { citizenId, agentPda, profession, taskPda, txSig, explorerUrl, narrative }  — a Verifier re-derived a proof and it did NOT match
//
// All writes are best-effort. The feed is a delight layer, never on a critical
// path: a Redis outage degrades to an empty feed, never a thrown error.

import { env } from './env.js';
import { getRedis } from './redis.js';
import { insertNotification } from './notify.js';

const FEED_KEY = 'feed:events';
const MAX_EVENTS = 200; // capped list — the widget shows ~30; we keep headroom

export const ALLOWED_TYPES = new Set([
	'coin-buy',
	'agent-deploy',
	'agent-onchain',
	'level-up',
	'world-join',
	'jackpot',
	'payment',  // skill/service payment confirmed; { usdcAtomic, recipientLabel, txSig, explorerUrl }
	'mission-complete',  // /play job or co-op heist finished; { mission, gold, coop, coin }
	'member-join',  // a person signed in to three.ws; { handle } (actor = display name)
	'agent-guard',  // an autonomous buy was REFUSED by a safety rule; { agentId, mint, reason, label } — trust made visible
	// Agora — the living agent economy (workers/agora-citizens). Each is a real
	// on-chain AgenC action projected onto the ticker; see docs/agora.md.
	'agora-registered',       // a citizen registered on AgenC
	'agora-task-posted',      // a bounty was escrowed on the board (createTask)
	'agora-hired',            // a citizen hired a sub-agent (agent-to-agent)
	'agora-task-claimed',     // a citizen claimed an on-chain task
	'agora-task-completed',   // a citizen submitted an accepted proof
	'agora-earned',           // escrow released $THREE/SOL to the worker
	'agora-vouched',          // a Verifier re-derived a deliverable's proof — it holds
	'agora-flagged',          // a Verifier re-derived a proof and it did NOT match
]);

// Per-user notification types: stored in user_notifications (DB), never in the
// public feed:events list. Extend here so one place owns the full vocabulary.
export const USER_EVENT_TYPES = new Set([
	'payment-earned',    // agent owner received an x402 payment
	'sale',              // marketplace asset sale
	'embed',             // someone embedded the creator's agent
	'remix',             // someone remixed a creation
	'reply',             // new reply to an agent interaction
	'follow',            // someone followed you; { actor, follower_username, link }
	'agent_review',      // someone reviewed your agent; { actor, agent_id, agent_name, rating, link }
	'dm_received',       // a friend sent you a DM while you were away; { actor, link }
	'pump_launch_filled',// a launch you own graduated its bonding curve; { name, mint, link }
	// types already produced by purchase-confirm / buy-asset confirm flows
	'skill_purchased',
	'skill_purchase_confirmed',
	'asset_purchased',
	'asset_purchase_confirmed',
	'asset_payment_mismatch',
	'skill_payment_mismatch',
	'referral_earned',
]);

function redis() { return getRedis(); }

let _seq = 0;
// A sortable, collision-resistant id: a base36 timestamp prefix plus a per-
// process counter so two events in the same millisecond still differ.
function eventId(ts) {
	_seq = (_seq + 1) % 1_000_000;
	return `${ts.toString(36)}-${_seq.toString(36)}`;
}

// Publish a per-user notification event. Writes to user_notifications (DB),
// never to the public feed:events list. Preserves the shared event shape
// { id, type, ts, actor, ...typeSpecific } plus `read` flag and a `link` for
// click-through. Fire-and-forget: never throws.
//
// @param {string} userId  — recipient's user id
// @param {object} event   — { type (USER_EVENT_TYPES), actor, link, ...rest }
export function publishUserEvent(userId, event) {
	if (!userId || !event || !USER_EVENT_TYPES.has(event.type)) return;
	const ts = Number.isFinite(event.ts) ? event.ts : Date.now();
	const payload = {
		...event,
		ts,
		id: event.id || eventId(ts),
		link: event.link || null,
	};
	insertNotification(userId, event.type, payload);
}

// Append an event to the feed. Returns the stored record (with id + ts filled
// in) or null on a no-op (unknown type, Redis down, malformed input). Never
// throws — every caller is fire-and-forget on a non-critical path.
export async function publishFeedEvent(event) {
	const r = redis();
	if (!r || !event || !ALLOWED_TYPES.has(event.type)) return null;
	const ts = Number.isFinite(event.ts) ? event.ts : Date.now();
	const record = { ...event, ts, id: event.id || eventId(ts) };
	try {
		await r.lpush(FEED_KEY, JSON.stringify(record));
		await r.ltrim(FEED_KEY, 0, MAX_EVENTS - 1);
		return record;
	} catch (err) {
		console.warn('[feed] publish failed:', err?.message);
		return null;
	}
}

/**
 * Convenience wrapper: publish a 'payment' feed event from a confirmed skill/service payment.
 * All params best-effort; the event is fire-and-forget on a non-critical path.
 *
 * @param {object} opts
 * @param {string}  opts.actor          short display label (truncated wallet / agent name)
 * @param {number}  [opts.usdcAtomic]   payment amount in micro-USDC (1e6 scale)
 * @param {string}  [opts.recipientLabel]  "Luna's creator", "Oracle", etc.
 * @param {string}  [opts.txSig]        Solana tx signature
 * @param {string}  [opts.explorerUrl]  full Solscan/explorer URL
 */
/**
 * Convenience wrapper: publish an 'agent-guard' event when a safety rule refuses
 * an autonomous buy (a mayhem-mode coin, a rug/honeypot firewall block). Surfacing
 * these makes the platform's safety work visible in the live tape instead of
 * silent. Fire-and-forget; unknown/empty input is a safe no-op.
 *
 * @param {object} opts
 * @param {string} opts.actor    the agent's display name
 * @param {string} [opts.agentId]
 * @param {string} [opts.mint]   the coin that was refused
 * @param {string} opts.reason   machine code ('mayhem' | 'firewall_blocked')
 * @param {string} opts.label    human-readable one-liner for the tape
 */
export function pushGuardEvent({ actor, agentId, mint, reason, label } = {}) {
	if (!reason) return null;
	return publishFeedEvent({
		type: 'agent-guard',
		actor: String(actor || 'Agent').slice(0, 32),
		agentId: agentId ? String(agentId).slice(0, 64) : undefined,
		mint: mint ? String(mint).slice(0, 64) : undefined,
		reason: String(reason).slice(0, 32),
		label: label ? String(label).slice(0, 80) : undefined,
	});
}

export function pushPaymentEvent({ actor, usdcAtomic, recipientLabel, txSig, explorerUrl } = {}) {
	return publishFeedEvent({
		type: 'payment',
		actor: String(actor || 'user').slice(0, 32),
		usdcAtomic: usdcAtomic != null ? Number(usdcAtomic) : undefined,
		recipientLabel: recipientLabel ? String(recipientLabel).slice(0, 40) : undefined,
		txSig: txSig ? String(txSig).slice(0, 88) : undefined,
		explorerUrl: explorerUrl ? String(explorerUrl).slice(0, 200) : undefined,
	});
}

// Per-user throttle window for member-join events. A returning user signs in
// often; we only want one "joined" line per person per window so the feed shows
// real arrivals without spamming on every login or popup re-auth.
const MEMBER_JOIN_TTL_S = 6 * 60 * 60; // 6h

/**
 * Publish a 'member-join' feed event when someone signs in, throttled to once
 * per `userKey` per MEMBER_JOIN_TTL_S so re-logins don't spam the ticker.
 * Best-effort and fire-and-forget — never throws, returns the stored record or
 * null (throttled / Redis down / no display name).
 *
 * @param {object} opts
 * @param {string} opts.userKey  stable per-user key for throttling (id or handle)
 * @param {string} opts.actor    short public display name ("alice")
 * @param {string} [opts.handle] X/social handle without '@', for click-through
 */
export async function publishMemberJoin({ userKey, actor, handle } = {}) {
	const r = redis();
	const name = String(actor || '').trim().slice(0, 32);
	if (!r || !name) return null;
	const key = String(userKey || handle || name).slice(0, 80);
	try {
		// SET NX EX: claims the window atomically; null reply means already seen.
		const claimed = await r.set(`feed:joined:${key}`, '1', { nx: true, ex: MEMBER_JOIN_TTL_S });
		if (!claimed) return null;
	} catch (err) {
		console.warn('[feed] member-join throttle check failed:', err?.message);
		return null;
	}
	return publishFeedEvent({
		type: 'member-join',
		actor: name,
		handle: handle ? String(handle).replace(/^@/, '').slice(0, 40) : undefined,
	});
}

// Short-lived in-process read cache. The widget is mounted on every page and
// polls this endpoint continuously, so without dedup each poll becomes a Redis
// command — at platform scale that alone can exhaust the Upstash request quota.
// A warm serverless instance serving a burst of polls reuses one underlying
// read for READ_CACHE_MS; we always fetch the top CACHE_N (cheap — one command
// regardless of count) and slice per caller, so every limit ≤ CACHE_N is served
// from the same cached array. This bounds Redis reads to ~one per instance per
// window instead of one per client poll. The feed is a delight layer, so a few
// seconds of staleness is invisible.
const READ_CACHE_MS = 8_000;
const CACHE_N = 60; // ≥ any limit the widget requests (30) with headroom
let _readCache = { at: 0, events: [] };

// Read the most recent events, newest-first. `limit` is clamped to
// [1, MAX_EVENTS]. Returns [] on a Redis outage so the widget renders its empty
// state rather than surfacing an error to the user.
export async function readFeedEvents(limit = 30) {
	const r = redis();
	if (!r) return [];
	const n = Math.max(1, Math.min(MAX_EVENTS, Math.floor(Number(limit)) || 30));

	// Serve from the in-process cache when fresh and large enough.
	if (n <= CACHE_N && Date.now() - _readCache.at < READ_CACHE_MS) {
		return _readCache.events.slice(0, n);
	}

	const want = Math.max(n, CACHE_N);
	try {
		const rows = await r.lrange(FEED_KEY, 0, want - 1);
		const out = [];
		for (const row of rows || []) {
			// Upstash auto-deserializes JSON-looking values; tolerate both shapes.
			const obj = typeof row === 'string' ? safeParse(row) : row;
			if (obj && typeof obj === 'object' && obj.type) out.push(obj);
		}
		if (want >= CACHE_N) _readCache = { at: Date.now(), events: out.slice(0, CACHE_N) };
		return out.slice(0, n);
	} catch (err) {
		console.warn('[feed] read failed:', err?.message);
		return [];
	}
}

function safeParse(s) {
	try {
		return JSON.parse(s);
	} catch {
		return null;
	}
}
