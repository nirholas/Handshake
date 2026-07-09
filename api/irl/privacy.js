/**
 * IRL privacy center — visibility, export, delete / forget device (H5).
 *
 * The control surface behind /irl's "Privacy & my data". Every caller — signed-in
 * or anonymous — gets full sight of and full control over the location data /irl
 * holds about them: see what's stored, temporarily UNPUBLISH a pin, DELETE one,
 * remove EVERYTHING, EXPORT it, and FORGET THIS DEVICE (purge every row tied to
 * the anonymous device token, including taps/messages it left on others' pins).
 * This is right-to-be-forgotten as a product, not a support ticket.
 *
 * GET    /api/irl/privacy                 → plain-language data summary (caller's own)
 * GET    /api/irl/privacy?export=1        → full JSON of the caller's own pins + interactions
 * PATCH  /api/irl/privacy  { pinId, action:'unpublish'|'republish' }
 * DELETE /api/irl/privacy  { scope:'pin'|'all'|'device', pinId? }  → { deletedPins, deletedInteractions }
 *
 * ── Identity & ownership ──────────────────────────────────────────────────────
 * Auth (session user_id) OR the anonymous device token, which — per H2 — arrives
 * in the `x-irl-device` HEADER (body for mutations), NEVER a URL query string.
 * `readDeviceToken` null-guards an empty/whitespace token to null so it can never
 * become a SQL clause that matches another owner's NULL/empty-token rows. Every
 * owner clause is independently null-guarded exactly like the existing DELETE in
 * pins.js: a missing identifier matches nothing.
 *
 * ── Cascade (H6 on demand) ────────────────────────────────────────────────────
 * Deleting a pin orphans its `irl_interactions` (each row snapshots the pin's
 * lat/lng + a viewer_device — a "device X was at coordinate Y at time T" trail).
 * Every delete path here removes those dependent rows in the same request so the
 * trail never outlives the placement. `scope:'device'` goes further: it also
 * purges interactions this device AUTHORED on OTHER people's pins (viewer_device),
 * so the device id is genuinely forgotten — a subsequent summary returns empty.
 *
 * No new columns: unpublish writes the existing `published` flag, which withholds
 * the pin from every OTHER reader's nearby / room / World Line feed while leaving
 * it visible to its owner in AR. `hidden_at` remains moderation + expiry only (it
 * blanks a pin for everyone, owner included). This endpoint NEVER returns another
 * user's coordinates — only the caller's own data.
 */

import { cors, json, wrap, rateLimited } from '../_lib/http.js';
import { sql } from '../_lib/db.js';
import { getSessionUser } from '../_lib/auth.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { readDeviceToken } from '../_lib/irl-auth.js';
import { isValidPinId } from './pins.js';

const SCOPES = new Set(['pin', 'all', 'device']);
const ACTIONS = new Set(['unpublish', 'republish']);

// Resolve the caller as { userId, deviceToken } with both arms null-guarded. A
// caller must present at least one identifier; a bare anonymous request (no
// session, no device token) owns nothing and is rejected before any query runs.
async function resolveOwner(req) {
	const session = await getSessionUser(req).catch(() => null);
	const userId = session?.id ?? null;
	const deviceToken = readDeviceToken(req); // null for empty/whitespace
	return { userId, deviceToken };
}

// The literal, plain-language inventory of what a pin/interaction row stores —
// shown verbatim in the UI so the summary copy and the actual data never diverge.
function storedItems({ hasPins, hasInteractions, precise }) {
	const items = [];
	if (hasPins) {
		items.push(
			precise
				? 'The exact coordinates of each spot where you placed an agent.'
				: 'The approximate coordinates of each spot where you placed an agent.',
		);
		items.push('The avatar, name and caption you gave each placed agent.');
	}
	items.push('An anonymous device id that ties your placements on this device together.');
	if (hasInteractions) {
		items.push('Taps, views, payments and any messages left on your placed agents — including where each encounter happened.');
	}
	return items;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: ['GET', 'PATCH', 'DELETE', 'OPTIONS'] })) return;

	// Reuse the placement limiter: this surface creates/edits/deletes placements,
	// so it belongs in the heavier irl:pin bucket, not the public read bucket. Fail
	// closed on the destructive verbs is unnecessary (a denied delete is just a
	// retry), so a limiter wobble degrades to a retryable 429 rather than blocking.
	const rl = await limits.irlPinIp(clientIp(req)).catch(() => ({ success: true }));
	if (!rl.success) return rateLimited(res, rl);

	const { userId, deviceToken } = await resolveOwner(req);
	if (!userId && !deviceToken) {
		return json(res, 400, { error: 'sign in or send the x-irl-device header' });
	}

	if (req.method === 'GET') {
		// Export = the same data the summary describes, in full. Honest and complete.
		if (req.query?.export === '1' || req.query?.export === 'true') {
			return handleExport(res, { userId, deviceToken });
		}
		return handleSummary(res, { userId, deviceToken, anonymous: !userId });
	}

	if (req.method === 'PATCH') {
		return handleVisibility(res, { userId, deviceToken, body: req.body ?? {} });
	}

	if (req.method === 'DELETE') {
		return handleDelete(res, { userId, deviceToken, body: req.body ?? {} });
	}

	return json(res, 405, { error: 'method not allowed' });
});

// ── GET — plain-language data summary (the caller's own data only) ────────────
async function handleSummary(res, { userId, deviceToken, anonymous }) {
	// One scan over the caller's OWN pins. Every arm is null-guarded so a missing
	// identifier can never widen the match to another owner's rows. Unpublished
	// (hidden_at) pins ARE counted here — they're the caller's data, just invisible
	// to others — so the summary reflects everything stored, not just what's live.
	const [pinAgg] = await sql`
		SELECT
			COUNT(*)::int                                              AS total,
			COUNT(*) FILTER (WHERE published IS FALSE)::int            AS unpublished,
			COUNT(*) FILTER (WHERE expires_at IS NULL)::int            AS permanent,
			MIN(placed_at)                                            AS oldest,
			MAX(placed_at)                                            AS newest,
			MIN(expires_at) FILTER (WHERE expires_at IS NOT NULL)     AS next_expiry
		FROM irl_pins
		WHERE ((${userId}::uuid IS NOT NULL AND user_id = ${userId}::uuid)
		    OR (${deviceToken}::text IS NOT NULL AND device_token = ${deviceToken}))
	`;

	// Interactions LEFT ON the caller's own pins (their inbox).
	const [onMineAgg] = await sql`
		SELECT COUNT(*)::int AS total
		FROM irl_interactions ix
		JOIN irl_pins p ON p.id = ix.pin_id
		WHERE ((${userId}::uuid IS NOT NULL AND p.user_id = ${userId}::uuid)
		    OR (${deviceToken}::text IS NOT NULL AND p.device_token = ${deviceToken}))
	`;

	// Interactions THIS DEVICE authored on anyone's pins (the trail it left). Keyed
	// on viewer_device, so it only applies to the anonymous device-token caller.
	const [authoredAgg] = deviceToken
		? await sql`
			SELECT COUNT(*)::int AS total
			FROM irl_interactions
			WHERE viewer_device IS NOT NULL AND viewer_device = ${deviceToken}
		`
		: [{ total: 0 }];

	const pinTotal = pinAgg?.total ?? 0;
	const onMine = onMineAgg?.total ?? 0;
	const authored = authoredAgg?.total ?? 0;
	const permanent = pinAgg?.permanent ?? 0;

	return json(res, 200, {
		summary: {
			pins: {
				total: pinTotal,
				published: pinTotal - (pinAgg?.unpublished ?? 0),
				unpublished: pinAgg?.unpublished ?? 0,
				permanent,                              // never auto-expire (signed-in)
				expiring: pinTotal - permanent,         // auto-expire (anonymous)
				oldest: pinAgg?.oldest ?? null,
				newest: pinAgg?.newest ?? null,
			},
			interactions: {
				onYourPins: onMine,                     // your inbox
				youLeftElsewhere: authored,             // your trail on others' pins
			},
			// Anonymous device pins auto-expire (7 days); the next one to go is the
			// soonest expires_at. Signed-in pins are permanent until removed.
			retention: {
				anonymousPinsExpireInDays: 7,
				interactionsExpireInDays: 180,
				nextPinExpiry: pinAgg?.next_expiry ?? null,
			},
			account: anonymous ? 'anonymous-device' : 'signed-in',
			stored: storedItems({ hasPins: pinTotal > 0, hasInteractions: onMine > 0 || authored > 0, precise: true }),
		},
	});
}

// ── GET ?export=1 — full JSON download of the caller's own data ───────────────
async function handleExport(res, { userId, deviceToken }) {
	const pins = await sql`
		SELECT id, agent_id, lat, lng, heading, avatar_name, avatar_url, caption,
		       x402_endpoint, placed_at, expires_at, hidden_at, view_count,
		       gps_accuracy_m, altitude_m, anchor_source
		FROM irl_pins
		WHERE ((${userId}::uuid IS NOT NULL AND user_id = ${userId}::uuid)
		    OR (${deviceToken}::text IS NOT NULL AND device_token = ${deviceToken}))
		ORDER BY placed_at DESC
		LIMIT 1000
	`;

	// Interactions on the caller's pins (their inbox).
	const received = await sql`
		SELECT ix.id, ix.pin_id, ix.agent_id, ix.type, ix.message,
		       ix.lat, ix.lng, ix.amount, ix.currency_mint, ix.created_at, ix.seen_at
		FROM irl_interactions ix
		JOIN irl_pins p ON p.id = ix.pin_id
		WHERE ((${userId}::uuid IS NOT NULL AND p.user_id = ${userId}::uuid)
		    OR (${deviceToken}::text IS NOT NULL AND p.device_token = ${deviceToken}))
		ORDER BY ix.created_at DESC
		LIMIT 1000
	`;

	// Interactions THIS device left on anyone's pins (its outbound trail).
	const authored = deviceToken
		? await sql`
			SELECT id, pin_id, agent_id, type, message, lat, lng, created_at
			FROM irl_interactions
			WHERE viewer_device IS NOT NULL AND viewer_device = ${deviceToken}
			ORDER BY created_at DESC
			LIMIT 1000
		`
		: [];

	const payload = {
		exportedAt: new Date().toISOString(),
		account: userId ? 'signed-in' : 'anonymous-device',
		pins,
		interactionsOnYourPins: received,
		interactionsYouLeft: authored,
	};
	return json(res, 200, payload, {
		'content-disposition': 'attachment; filename="irl-my-data.json"',
	});
}

// ── PATCH — owner-initiated unpublish / republish (writes `published`) ────────
//
// Unpublish makes a pin PRIVATE: withheld from every other reader's nearby, room
// and World Line feed, while the OWNER still sees it in AR. That last clause is
// the whole point — the previous implementation set `hidden_at`, the moderation
// hide, which blanks the pin for the owner too and so is unusable for anyone who
// wants to keep testing a placement they've taken out of public view. `hidden_at`
// stays what it says it is: moderation (api/irl/report.js) and expiry.
async function handleVisibility(res, { userId, deviceToken, body }) {
	const pinId = body.pinId;
	const action = body.action;
	if (!isValidPinId(pinId)) return json(res, 400, { error: 'valid pinId required' });
	if (!ACTIONS.has(action)) return json(res, 400, { error: "action must be 'unpublish' or 'republish'" });

	// Owner-scoped, null-guarded WHERE — an attacker with the wrong token/session
	// matches no row and so toggles nothing (RETURNING empty → 404). Both arms guard
	// the SUPPLIED token, not the column: a caller with no device token yields
	// NULL::text IS NOT NULL → false, so it can never match a row whose device_token
	// happens to be empty. Neon's tagged template doesn't compose fragments, so the
	// two directions are two explicit queries rather than a spliced value.
	const makePrivate = action === 'unpublish';
	const [row] = makePrivate
		? await sql`
			UPDATE irl_pins
			SET published = FALSE
			WHERE id = ${pinId}
			  AND (expires_at IS NULL OR expires_at > NOW())
			  AND ((${userId}::uuid IS NOT NULL AND user_id = ${userId}::uuid)
			    OR (${deviceToken}::text IS NOT NULL AND device_token = ${deviceToken}::text))
			RETURNING id, published`
		: await sql`
			UPDATE irl_pins
			SET published = TRUE
			WHERE id = ${pinId}
			  AND (expires_at IS NULL OR expires_at > NOW())
			  AND ((${userId}::uuid IS NOT NULL AND user_id = ${userId}::uuid)
			    OR (${deviceToken}::text IS NOT NULL AND device_token = ${deviceToken}::text))
			RETURNING id, published`;
	if (!row) return json(res, 404, { error: 'pin not found or not yours' });
	return json(res, 200, {
		ok: true,
		pinId: row.id,
		hidden: row.published === false,
		visibility: row.published === false ? 'private' : 'public',
	});
}

// ── DELETE — pin | all | device, cascading to irl_interactions ────────────────
async function handleDelete(res, { userId, deviceToken, body }) {
	const scope = body.scope;
	if (!SCOPES.has(scope)) {
		return json(res, 400, { error: "scope must be 'pin', 'all' or 'device'" });
	}

	if (scope === 'pin') {
		const pinId = body.pinId;
		if (!isValidPinId(pinId)) return json(res, 400, { error: 'valid pinId required' });

		// Cascade first: remove the interactions snapshotting THIS pin's location, but
		// only when the caller owns the pin — the subquery is owner-scoped and
		// null-guarded so a stranger's request deletes nothing. Then delete the pin
		// itself under the same gate.
		const deletedInteractions = await sql`
			DELETE FROM irl_interactions
			WHERE pin_id = ${pinId}
			  AND pin_id IN (
				SELECT id FROM irl_pins
				WHERE id = ${pinId}
				  AND ((${userId}::uuid IS NOT NULL AND user_id = ${userId}::uuid)
				    OR (${deviceToken}::text IS NOT NULL AND device_token = ${deviceToken}::text))
			)
			RETURNING id
		`;
		const deletedPins = await sql`
			DELETE FROM irl_pins
			WHERE id = ${pinId}
			  AND ((${userId}::uuid IS NOT NULL AND user_id = ${userId}::uuid)
			    OR (${deviceToken}::text IS NOT NULL AND device_token = ${deviceToken}::text))
			RETURNING id
		`;
		if (!deletedPins.length) return json(res, 404, { error: 'pin not found or not yours' });
		return json(res, 200, {
			ok: true,
			deletedPins: deletedPins.length,
			deletedInteractions: deletedInteractions.length,
		});
	}

	// scope: 'all' and 'device' both wipe every pin this caller owns + the inbox on
	// them. 'device' additionally purges the trail this device left elsewhere.
	const deletedInbox = await sql`
		DELETE FROM irl_interactions
		WHERE pin_id IN (
			SELECT id FROM irl_pins
			WHERE ((${userId}::uuid IS NOT NULL AND user_id = ${userId}::uuid)
			    OR (${deviceToken}::text IS NOT NULL AND device_token = ${deviceToken}::text))
		)
		RETURNING id
	`;
	const deletedPins = await sql`
		DELETE FROM irl_pins
		WHERE ((${userId}::uuid IS NOT NULL AND user_id = ${userId}::uuid)
		    OR (${deviceToken}::text IS NOT NULL AND device_token = ${deviceToken}::text))
		RETURNING id
	`;

	let deletedAuthored = 0;
	if (scope === 'device') {
		// "Forget this device" — also drop every interaction this device authored on
		// OTHER people's pins, so no row references the device id anywhere. Strictly
		// keyed on a non-empty viewer_device: an empty/NULL token matches nothing.
		if (deviceToken) {
			const rows = await sql`
				DELETE FROM irl_interactions
				WHERE viewer_device IS NOT NULL AND viewer_device = ${deviceToken}
				RETURNING id
			`;
			deletedAuthored = rows.length;
		}
	}

	return json(res, 200, {
		ok: true,
		scope,
		deletedPins: deletedPins.length,
		deletedInteractions: deletedInbox.length + deletedAuthored,
	});
}
