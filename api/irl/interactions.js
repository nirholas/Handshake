/**
 * IRL Interactions — record and surface real-world taps on placed agents.
 *
 * When a visitor walks up to an agent pinned in real space (/irl) and taps it,
 * we log an interaction against the pin. The pin's owner reads these back from
 * their dashboard as a live feed of "someone met your agent IRL" prompts —
 * including any message the visitor left and where the encounter happened.
 *
 * POST /api/irl/interactions
 *   { pinId, type: 'view'|'tap'|'message'|'pay'|'talk', message?, deviceToken?,
 *     amount?, currencyMint?, network?, payload?, replyTo? }
 *   agent_id + owner are taken from the pin, never the caller. Anonymous-friendly:
 *   viewer attribution falls back to the device token. Repeat 'view's from the
 *   same device on the same pin within VIEW_DEDUPE_MS collapse into the first one.
 *   A 'pay' must carry a valid settlement signature + a $THREE/USDC mint and is
 *   de-duped per signature. A visitor 'pay'/'message' fans out an owner notification.
 *   When the AUTHENTICATED OWNER posts a 'message', it's recorded as a reply
 *   (payload.from='owner', auto-seen) and — if replyTo points at a signed-in
 *   visitor's row — notifies that visitor instead of the owner. Response carries
 *   { notified } so the dashboard can confirm the reply reached someone.
 *
 * GET /api/irl/interactions?mine=1[&unread=1]   — interactions on MY pins
 *   Owner is matched by session user OR by ?deviceToken= (anonymous placements).
 *   Returns newest-first, joined with the pin's avatar name + caption.
 *
 * GET /api/irl/interactions?pinId=<id>          — public count for one pin
 *
 * ── Retention / data-minimization (H6) ───────────────────────────────────────
 * Each row snapshots the pin's lat/lng + a viewer_device, so it's a location trail
 * ("device X was at coordinate Y at time T") that must not accumulate. The hourly
 * reaper (api/cron/irl-reap.js) cascade-deletes a row the moment its pin is gone and
 * ages out any row older than 180 days regardless of pin state, so even a permanent
 * pin's encounter trail is bounded. The created_at index below keeps that age-out
 * sweep index-backed. The lat/lng columns duplicate the pin's own location, but they
 * earn their keep: the owner inbox + the SSE stream render the row WITHOUT joining
 * back to a possibly-deleted pin, and the row is bounded by the reaper above — so we
 * keep the geo snapshot on the (short-lived) row rather than re-deriving it on read.
 */

import { cors, json, wrap, rateLimited } from '../_lib/http.js';
import { sql } from '../_lib/db.js';
import { getSessionUser } from '../_lib/auth.js';
import { insertNotification } from '../_lib/notify.js';
import { sendOpsAlert } from '../_lib/alerts.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { readDeviceToken } from '../_lib/irl-auth.js';
import { isUuid } from '../_lib/validate.js';
import { verifySettlement } from '../_lib/settlement-verify.js';
import { agentPayoutWallets } from '../_lib/agent-payout-wallets.js';

// view | tap — passive/active sighting of the agent. message — a note left for
// the owner. pay — an x402 settlement against the agent (see PAY note below).
// `talk` marks the opening line of a live conversation with the agent (the /irl
// Talk panel). Only the event is recorded, never the transcript.
const TYPES = new Set(['view', 'tap', 'message', 'pay', 'talk']);
// The surface the encounter happened on, so an owner can tell an IRL phone tap from a
// smart-glasses (Frame / G1) encounter. Whitelisted — an unknown value collapses to
// 'phone' rather than storing arbitrary caller text.
const DEVICE_TYPES = new Set(['phone', 'glasses']);
function normDeviceType(v) {
	return typeof v === 'string' && DEVICE_TYPES.has(v) ? v : 'phone';
}
const VIEW_DEDUPE_MS = 5 * 60 * 1000; // collapse repeat views from one device
const MAX_MESSAGE_LEN = 280;

// A `pay` is the one caller-asserted type that names money, so it is NOT trusted
// blindly. A pay is recorded only when it carries a settlement we can PROVE:
//   1. a well-formed on-chain signature (0x… EVM tx hash, or base58 Solana sig),
//   2. a currency mint that is $THREE or USDC, the only coins this platform
//      references; anything else is rejected outright,
//   3. global de-dupe by signature so one settlement is logged exactly once, and
//   4. on-chain verification (security review M4): the transaction must exist,
//      have succeeded, and have moved at least the amount claimed. When the pin's
//      agent has payout wallets on record (its paid-service payout addresses, its
//      custodial wallets) the transfer must have credited one of them. When it has
//      none, the destination genuinely is not knowable server-side, since an x402
//      service can pay out anywhere, so the check degrades to "this transaction is
//      real and moved this much of this asset" rather than to no check at all.
// A pay whose settlement is not yet visible to our RPC is recorded with
// verified_at null: it counts for nothing and notifies nobody until the sweep in
// api/cron/settlement-verify.js proves or discards it.
const EVM_TX_RE   = /^0x[0-9a-fA-F]{64}$/;
const SOL_SIG_RE  = /^[1-9A-HJ-NP-Za-km-z]{43,88}$/;
const THREE_MINT  = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const USDC_SOLANA  = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_BASE    = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
// Lowercased lookup so an EVM address compares case-insensitively; the two
// case-sensitive base58 mints are matched verbatim.
const ALLOWED_PAY_MINTS = new Set([THREE_MINT, USDC_SOLANA, USDC_BASE]);
function isAllowedMint(mint) {
	if (typeof mint !== 'string' || !mint) return false;
	return ALLOWED_PAY_MINTS.has(mint) || ALLOWED_PAY_MINTS.has(mint.toLowerCase());
}
function isValidPaySignature(sig) {
	return typeof sig === 'string' && (EVM_TX_RE.test(sig) || SOL_SIG_RE.test(sig));
}
// Block-explorer deep link for a settlement, picking the chain from the
// signature shape (EVM tx hash → Basescan) or an explicit network hint,
// defaulting to Solscan. Returned in the notification so the owner can open the
// receipt straight from the bell.
function explorerTxUrl(sig, network) {
	if (!sig) return null;
	const net = String(network || '').toLowerCase();
	if (EVM_TX_RE.test(sig) || net.includes('base') || net.includes('eip155')) {
		return `https://basescan.org/tx/${sig}`;
	}
	return `https://solscan.io/tx/${sig}`;
}
// Bound an untrusted payload object so a caller can't store an arbitrarily large
// blob in the JSONB column. Non-objects and oversized payloads collapse to {}.
// A circular / unserializable blob throws inside JSON.stringify and collapses to
// {} too — the first line of defense against a 500 on the INSERT below.
function clampPayload(obj) {
	if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
	try {
		return JSON.stringify(obj).length <= 2000 ? obj : {};
	} catch {
		return {};
	}
}

// Serialize the payload destined for the JSONB column, treating any failure as a
// caller fault (400) rather than letting it bubble into an uncaught 500. The base
// object has already survived clampPayload's serialize check, but it is mutated
// afterward (from/replyTo/signature/network) and `pay` spreads in caller-derived
// values — so a BigInt amount, a circular self-reference, or a toJSON() that
// throws would otherwise reach this point and crash the request. Returning the
// JSON text (or null on failure) keeps the failure at the boundary, with context.
function serializePayload(payload) {
	try {
		return JSON.stringify(payload);
	} catch (err) {
		console.warn('[irl/interactions] payload not serializable, rejecting', {
			endpoint: 'POST /api/irl/interactions',
			reason: err?.message || String(err),
		});
		return null;
	}
}

let _tableReady = false;
async function ensureTable() {
	if (_tableReady) return;
	// Critical bootstrap — the base table + its read/reaper indexes. Idempotent and,
	// on a live database, a cheap catalog check with no exclusive lock. A failure
	// here is a real DB fault (no connection, no CREATE grant) and is left to surface.
	await sql`
		CREATE TABLE IF NOT EXISTS irl_interactions (
			id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
			pin_id        UUID NOT NULL,
			agent_id      UUID,
			type          TEXT NOT NULL DEFAULT 'view',
			message       TEXT,
			viewer_user_id   UUID,
			viewer_device    TEXT,
			lat           DOUBLE PRECISION,
			lng           DOUBLE PRECISION,
			seen_at       TIMESTAMPTZ,
			created_at    TIMESTAMPTZ DEFAULT NOW()
		)
	`;
	await sql`CREATE INDEX IF NOT EXISTS irl_interactions_pin ON irl_interactions (pin_id, created_at DESC)`;
	await sql`CREATE INDEX IF NOT EXISTS irl_interactions_viewer ON irl_interactions (viewer_device, pin_id, type)`;
	// Index-backs the reaper's age-out sweep (DELETE … WHERE created_at < NOW() - 180d).
	await sql`CREATE INDEX IF NOT EXISTS irl_interactions_created ON irl_interactions (created_at)`;
	// Incremental migrations — idempotent so a fresh DB self-provisions, but already
	// applied on a live one. Re-running them per request is redundant and risky: each
	// ALTER/CREATE INDEX takes an ACCESS EXCLUSIVE lock that can time out under racing
	// cold starts, and a least-privilege role may lack DDL grants. Best-effort only;
	// never let it gate logging an interaction.
	try {
		await runMigrations();
	} catch (err) {
		console.error('[irl/interactions] schema migrations skipped (already applied or no DDL grant)', {
			reason: err?.message || String(err),
		});
	}
	_tableReady = true;
}

async function runMigrations() {
	// Earnings columns (C4) — populated for type='pay'. amount is in the asset's
	// atomic units; currency_mint is $THREE or USDC; payload carries the on-chain
	// signature, network, and any structured context (geo, settlement detail).
	await sql`ALTER TABLE irl_interactions ADD COLUMN IF NOT EXISTS amount        NUMERIC`;
	await sql`ALTER TABLE irl_interactions ADD COLUMN IF NOT EXISTS currency_mint TEXT`;
	await sql`ALTER TABLE irl_interactions ADD COLUMN IF NOT EXISTS payload       JSONB DEFAULT '{}'::jsonb`;
	// The encounter surface (phone | glasses). Defaults to 'phone' so legacy rows and
	// any caller that omits it read as the common case.
	await sql`ALTER TABLE irl_interactions ADD COLUMN IF NOT EXISTS device_type   TEXT DEFAULT 'phone'`;
	// One settlement → one pay row. Indexed for the de-dupe lookup on insert.
	await sql`CREATE INDEX IF NOT EXISTS irl_interactions_paysig ON irl_interactions ((payload->>'signature')) WHERE type = 'pay'`;
	// On-chain proof for a pay (M4). Null on a pay means "not proved yet": the row
	// is inert until the settlement sweep promotes it. Never backfilled here; the
	// migration owns grandfathering the rows that predate verification.
	await sql`ALTER TABLE irl_interactions ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ`;
}

export default wrap(async (req, res) => {
	cors(req, res, { methods: ['GET', 'POST', 'PATCH', 'OPTIONS'] });
	if (req.method === 'OPTIONS') return res.end();

	await ensureTable();

	// ── POST — log an interaction ─────────────────────────────────────────────
	if (req.method === 'POST') {
		const rl = await limits.irlInteractIp(clientIp(req));
		if (!rl.success) return rateLimited(res, rl);

		const body = req.body ?? {};
		const pinId = body.pinId;
		if (!pinId) return json(res, 400, { error: 'pinId required' });
		// `irl_pins.id` / `irl_interactions.pin_id` are UUID columns, so a non-UUID id
		// is a malformed request, not a row that happens not to exist. Validate at the
		// boundary: without this the pin lookup below hands the text straight to
		// Postgres, which raises `invalid input syntax for type uuid` and 500s the
		// request. Same strict guard the sibling moderation + privacy paths use.
		if (!isUuid(pinId)) return json(res, 400, { error: 'invalid pinId' });

		const type = TYPES.has(body.type) ? body.type : 'view';
		const message = typeof body.message === 'string'
			? body.message.trim().slice(0, MAX_MESSAGE_LEN) || null
			: null;

		const session = await getSessionUser(req).catch(() => null);
		const viewerUserId = session?.id ?? null;
		const viewerDevice = readDeviceToken(req);
		const deviceType = normDeviceType(body.device_type);

		// Confirm the pin exists (and is live) and snapshot its location + agent.
		const [pin] = await sql`
			SELECT id, agent_id, lat, lng, user_id, device_token
			FROM irl_pins
			WHERE id = ${pinId}
			  AND hidden_at IS NULL
			  AND published IS NOT FALSE
			  AND (expires_at IS NULL OR expires_at > NOW())
			LIMIT 1
		`;
		if (!pin) return json(res, 404, { error: 'pin not found' });

		// Don't log an owner inspecting their own pin — that's not an encounter.
		const isAuthOwner = !!(viewerUserId && pin.user_id && viewerUserId === pin.user_id);
		const isOwner =
			isAuthOwner ||
			(viewerDevice && pin.device_token && viewerDevice === pin.device_token);
		if (isOwner && type === 'view') {
			return json(res, 200, { ok: true, self: true });
		}
		// An authenticated owner posting a `message` is a REPLY to a visitor — a
		// first-class thread turn, not a self-encounter. It's recorded (stamped
		// from:'owner', auto-seen so it never inflates the owner's own unread) and,
		// when the visitor was signed in, fans a notification back to THEM.
		const isOwnerReply = type === 'message' && isAuthOwner;

		// Collapse repeat 'view's from the same device on the same pin.
		if (type === 'view' && viewerDevice) {
			const [recent] = await sql`
				SELECT id FROM irl_interactions
				WHERE pin_id = ${pinId} AND viewer_device = ${viewerDevice} AND type = 'view'
				  AND created_at > NOW() - ${`${VIEW_DEDUPE_MS} milliseconds`}::interval
				LIMIT 1
			`;
			if (recent) return json(res, 200, { ok: true, deduped: true, id: recent.id });
		}

		// Earnings fields — only ever set for a verified `pay` (see PAY note up top).
		let amount = null;
		let currencyMint = null;
		let payload = clampPayload(body.payload);
		// `from` / `replyTo` are never client-trusted — a visitor must not be able to
		// forge a row that looks like an owner reply. Capture the (validated) reply
		// target first, then strip both; the server re-stamps them only for a genuine
		// owner reply below.
		const replyToRaw =
			(typeof body.replyTo === 'string' && isUuid(body.replyTo)) ? body.replyTo
			: (typeof payload.replyTo === 'string' && isUuid(payload.replyTo)) ? payload.replyTo
			: null;
		delete payload.from;
		delete payload.replyTo;
		if (isOwnerReply) {
			payload.from = 'owner';
			if (replyToRaw) payload.replyTo = replyToRaw;
		}
		let payVerifiedAt = null;
		if (type === 'pay') {
			const sig  = payload.signature ?? body.signature ?? null;
			const mint = body.currencyMint ?? payload.currencyMint ?? null;
			if (!isValidPaySignature(sig)) {
				return json(res, 400, { error: 'pay requires a valid on-chain settlement signature' });
			}
			if (!isAllowedMint(mint)) {
				return json(res, 400, { error: 'currency_mint must be $THREE or USDC' });
			}
			const amt = Number(body.amount);
			amount = Number.isFinite(amt) && amt > 0 ? amt : null;
			if (amount == null) {
				return json(res, 400, { error: 'pay requires the amount actually settled, in atomic units' });
			}
			currencyMint = mint;
			payload = { ...payload, signature: sig };
			if (body.network) payload.network = String(body.network).slice(0, 32);
			// One settlement → one pay row, even if the client retries the log.
			const [dupe] = await sql`
				SELECT id FROM irl_interactions
				WHERE type = 'pay' AND payload->>'signature' = ${sig}
				LIMIT 1
			`;
			if (dupe) return json(res, 200, { ok: true, deduped: true, id: dupe.id });

			// Prove the settlement before it becomes an earnings row.
			const recipients = await agentPayoutWallets(pin.agent_id);
			const proof = await verifySettlement({
				signature: sig,
				mint,
				amountAtomic: Math.round(amount),
				recipients,
				network: payload.network,
				allowAnyRecipient: recipients.length === 0,
			});
			if (proof.status === 'mismatch') {
				return json(res, 402, {
					error: 'settlement_unverified',
					message: proof.reason || 'that settlement could not be verified on-chain',
				});
			}
			if (proof.status === 'match') payVerifiedAt = new Date().toISOString();
		}

		// An owner reply is authored by the owner, so it lands already-seen — it must
		// never light up the owner's own unread badge. Every other row is unread.
		const seenAt = isOwnerReply ? new Date().toISOString() : null;
		// Serialize at the boundary so an unserializable payload is a clean 400, never
		// an uncaught 500 inside the INSERT's `::jsonb` cast.
		const payloadJson = serializePayload(payload);
		if (payloadJson === null) {
			return json(res, 400, { error: 'payload is not serializable' });
		}
		const [row] = await sql`
			INSERT INTO irl_interactions
				(pin_id, agent_id, type, message, viewer_user_id, viewer_device, lat, lng,
				 amount, currency_mint, payload, seen_at, device_type, verified_at)
			VALUES (
				${pinId},
				${pin.agent_id ?? null},
				${type},
				${message},
				${viewerUserId},
				${viewerDevice},
				${pin.lat},
				${pin.lng},
				${amount},
				${currencyMint},
				${payloadJson}::jsonb,
				${seenAt},
				${deviceType},
				${payVerifiedAt}
			)
			RETURNING id, type, created_at
		`;
		// view_count is the "Visitors" metric — only an actual view counts. A message
		// (or any non-view) must not inflate it (the owner already sees those as feed
		// rows). Owner-self views and same-device repeats already returned above.
		if (type === 'view') {
			// Best-effort: the row is already written, so a failed counter bump must not
			// fail the request — but it must not vanish either. Log it with context so a
			// systematically-stuck "Visitors" metric is diagnosable from the ops logs.
			sql`UPDATE irl_pins SET view_count = view_count + 1 WHERE id = ${pinId}`.catch((err) => {
				console.warn('[irl/interactions] view_count increment failed', {
					endpoint: 'POST /api/irl/interactions',
					pinId,
					reason: err?.message || String(err),
				});
			});
		}
		// Fan-out. Both arms are fire-and-forget and no-op when there's no one to
		// reach (anonymous actor) or creds are absent.
		let notified = false;
		if (isOwnerReply) {
			// The reply reaches the visitor only if they were signed in when they left
			// the message — an anonymous device has no inbox to deliver to. The owner is
			// never self-notified for their own reply.
			if (replyToRaw) {
				const [orig] = await sql`
					SELECT viewer_user_id FROM irl_interactions
					WHERE id = ${replyToRaw} AND pin_id = ${pinId} LIMIT 1
				`;
				if (orig?.viewer_user_id && orig.viewer_user_id !== pin.user_id) {
					insertNotification(orig.viewer_user_id, 'irl_reply', {
						pin_id: pinId,
						agent_id: pin.agent_id ?? null,
						message,
						link: pin.agent_id ? `/agents/${pin.agent_id}` : undefined,
					});
					notified = true;
				}
			}
		} else if (type === 'pay' && !payVerifiedAt) {
			// Real money may be in flight; our RPC just has not seen it. The row is
			// kept and stays inert (no notification, no ops alert) until the sweep
			// proves it, so a lagging read never turns into a false "you got paid".
			return json(res, 202, {
				ok: true,
				pending: true,
				interaction: row,
				message: 'settlement not visible on-chain yet, this pay counts as soon as it is',
			});
		} else if ((type === 'pay' || type === 'message') && pin.user_id) {
			// High-signal visitor events notify the owner: in-app always (the dashboard
			// inbox + the global nav bell), plus an optional Telegram ping for a pay.
			insertNotification(pin.user_id, 'irl_interaction', {
				pin_id: pinId,
				agent_id: pin.agent_id ?? null,
				kind: type,
				amount,
				currency_mint: currencyMint,
				message,
				tx_signature: type === 'pay' ? payload.signature : undefined,
				link: type === 'pay' ? explorerTxUrl(payload.signature, payload.network) : undefined,
			});
			if (type === 'pay') {
				sendOpsAlert(
					'IRL agent paid',
					`A placed agent was paid IRL${amount ? ` (${amount} ${currencyMint})` : ''}. Pin ${pinId}.`,
					{ signature: `irl-pay:${payload.signature}` },
				);
			}
		}
		return json(res, 201, { ok: true, interaction: row, notified });
	}

	// ── GET — public count for a single pin ───────────────────────────────────
	if (req.method === 'GET' && req.query.pinId) {
		// Same boundary guard as the POST path: `pin_id` is a UUID column, so a
		// garbage id must be a 400, never a Postgres cast error surfacing as a 500.
		if (!isUuid(req.query.pinId)) return json(res, 400, { error: 'invalid pinId' });
		const [agg] = await sql`
			SELECT
				COUNT(*)::int AS total,
				COUNT(*) FILTER (WHERE type = 'message')::int AS messages
			FROM irl_interactions
			WHERE pin_id = ${req.query.pinId}
		`;
		return json(res, 200, { count: agg?.total ?? 0, messages: agg?.messages ?? 0 });
	}

	// ── GET — interactions on MY pins (owner feed) ────────────────────────────
	if (req.method === 'GET' && req.query.mine === '1') {
		const session = await getSessionUser(req).catch(() => null);
		// Header-first (H2): the device credential never rides in the URL.
		const ownerDev = readDeviceToken(req);
		if (!session && !ownerDev) {
			return json(res, 400, { error: 'sign in or pass deviceToken' });
		}
		const unreadOnly = req.query.unread === '1';
		// Null-guard the owner id so a missing identifier can NEVER match a row (a
		// NULL user_id or '' device_token would otherwise surface another owner's —
		// or every legacy NULL-token — interaction). ownerDev is already null-guarded.
		const ownerId  = session?.id ?? null;

		// Neon's tagged template doesn't compose nested `sql` fragments, so the
		// unread filter is two explicit queries rather than a spliced clause.
		const rows = unreadOnly
			? await sql`
				SELECT
					ix.id, ix.pin_id, ix.agent_id, ix.type, ix.message,
					ix.lat, ix.lng, ix.seen_at, ix.created_at,
					ix.amount, ix.currency_mint, ix.payload, ix.device_type, ix.verified_at,
					p.avatar_name, p.caption
				FROM irl_interactions ix
				JOIN irl_pins p ON p.id = ix.pin_id
				WHERE ((${ownerId}::uuid IS NOT NULL AND p.user_id = ${ownerId}::uuid)
				    OR (${ownerDev}::text IS NOT NULL AND p.device_token = ${ownerDev}))
				  AND ix.seen_at IS NULL
				ORDER BY ix.created_at DESC
				LIMIT 100`
			: await sql`
				SELECT
					ix.id, ix.pin_id, ix.agent_id, ix.type, ix.message,
					ix.lat, ix.lng, ix.seen_at, ix.created_at,
					ix.amount, ix.currency_mint, ix.payload, ix.device_type, ix.verified_at,
					p.avatar_name, p.caption
				FROM irl_interactions ix
				JOIN irl_pins p ON p.id = ix.pin_id
				WHERE ((${ownerId}::uuid IS NOT NULL AND p.user_id = ${ownerId}::uuid)
				    OR (${ownerDev}::text IS NOT NULL AND p.device_token = ${ownerDev}))
				ORDER BY ix.created_at DESC
				LIMIT 100`;
		const [agg] = await sql`
			SELECT COUNT(*) FILTER (WHERE ix.seen_at IS NULL)::int AS unread
			FROM irl_interactions ix
			JOIN irl_pins p ON p.id = ix.pin_id
			WHERE ((${ownerId}::uuid IS NOT NULL AND p.user_id = ${ownerId}::uuid)
			    OR (${ownerDev}::text IS NOT NULL AND p.device_token = ${ownerDev}))
		`;
		return json(res, 200, { interactions: rows, unread: agg?.unread ?? 0 });
	}

	// ── PATCH — mark my interactions as seen ──────────────────────────────────
	if (req.method === 'PATCH') {
		const session = await getSessionUser(req).catch(() => null);
		const ownerDev = readDeviceToken(req);
		const ownerId  = session?.id ?? null;
		if (!ownerId && !ownerDev) {
			return json(res, 400, { error: 'sign in or pass deviceToken' });
		}
		await sql`
			UPDATE irl_interactions ix
			SET seen_at = NOW()
			FROM irl_pins p
			WHERE ix.pin_id = p.id
			  AND ix.seen_at IS NULL
			  AND ((${ownerId}::uuid IS NOT NULL AND p.user_id = ${ownerId}::uuid)
			    OR (${ownerDev}::text IS NOT NULL AND p.device_token = ${ownerDev}))
		`;
		return json(res, 200, { ok: true });
	}

	json(res, 405, { error: 'method not allowed' });
});
