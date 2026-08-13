/**
 * IRL pin reports — community moderation for placed agents (D4).
 *
 * POST /api/irl/report  { pinId, reason, deviceToken? }
 *   Files a report against a public pin. Reports are de-duped per distinct
 *   reporter (a session user, else the device token, else the caller IP) so one
 *   actor can't inflate the count by re-submitting. When a pin crosses
 *   REPORT_HIDE_THRESHOLD *distinct* reporters it is hidden (hidden_at = NOW()):
 *   it vanishes from every nearby/mine query and stops accepting interactions.
 *   Hidden, never deleted — the row survives for owner appeal + later review.
 *
 *   Owner-protected: a single reporter can never hide a pin, and the owner's own
 *   reports against their own pin are ignored. This is a queue-at-threshold gate,
 *   not an instant delete — report-bombing is bounded by the distinct-reporter
 *   dedup, real abuse is taken down once enough independent people flag it.
 *
 *   Abuse-hardened (task 13): a per-IP limiter bounds one source, the distinct-
 *   reporter dedup bounds one actor, and a per-pin 24h ceiling bounds a distributed
 *   flood. The free-text `detail` is control-char-stripped + length-bounded before
 *   storage so the moderation console renders it safely, and a non-UUID `pinId` is
 *   rejected at the boundary rather than 500ing on a Postgres cast.
 *
 * References no coin and no third-party token; $THREE is the only coin three.ws
 * references. Hiding is durable-only: there is NO realtime remove broadcast. A
 * pin's location is never fanned out to a room, so neither is its removal — the
 * hidden_at filter on every nearby/mine read drops it on each viewer's next ~10 s
 * proximity poll. That keeps the privacy invariant intact (no roster ever leaves
 * over the socket) at the cost of a few seconds' latency on a hide.
 */

import { cors, json, wrap, rateLimited } from '../_lib/http.js';
import { sql } from '../_lib/db.js';
import { getSessionUser } from '../_lib/auth.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { sendOpsAlert } from '../_lib/alerts.js';
import { readDeviceToken } from '../_lib/irl-auth.js';

// Distinct reporters required before a pin is queued out of public view.
const REPORT_HIDE_THRESHOLD = 3;
const MAX_REASON_LEN = 240;
// Per-pin abuse ceiling: the most report rows a single pin may accrue in a rolling
// 24h window before new reports are refused (task 13). The distinct-reporter dedup
// (one row per (pin, reporter)) already stops ONE actor inflating the count; this
// bounds a DISTRIBUTED flood so a coordinated burst can't pile unbounded reports
// onto — and fast-track the hiding of — a legitimate pin. It sits well above
// REPORT_HIDE_THRESHOLD so genuine flagging still hides a pin at 3 distinct
// reporters; once a pin is at the ceiling it is already under review, so nothing
// new is accepted. Because of the dedup, this is effectively a distinct-reporter-
// per-day cap.
const REPORT_PIN_CAP_24H = 25;
// Canonical reasons the UI offers; anything else collapses to 'other'. Kept as a
// closed set so the (future) review console can triage by category.
const REASONS = new Set(['spam', 'harassment', 'impersonation', 'scam', 'sexual', 'other']);

// pin_id is a server-minted UUID column. Validate the shape at the boundary so a
// garbage / oversized pinId is a clean 400 instead of a Postgres "invalid input
// syntax for type uuid" cast error (which would 500 and leak a DB internal). The
// SQL is parameterized — this is input hygiene + defense in depth (task 13).
const PIN_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Sanitize the free-text detail before it is STORED and later rendered in the
// moderation console (task 13). The raw value is attacker-controlled from an
// anonymous device, so: drop NUL + C0/C1 control characters (they corrupt log
// lines and can smuggle terminal/console escape sequences past a naïve renderer),
// collapse runs of whitespace, then hard-bound the length. Returns null when
// nothing printable survives so an all-control-char payload stores as no detail.
function sanitizeDetail(raw) {
	if (typeof raw !== 'string') return null;
	const cleaned = raw
		.replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')  // NUL + C0/C1 control chars -> space
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, MAX_REASON_LEN);
	return cleaned || null;
}

let _tableReady = false;
async function ensureTable() {
	if (_tableReady) return;
	await sql`
		CREATE TABLE IF NOT EXISTS irl_pin_reports (
			id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
			pin_id         UUID NOT NULL,
			reporter_token TEXT NOT NULL,
			reason         TEXT,
			created_at     TIMESTAMPTZ DEFAULT NOW()
		)
	`;
	// One report per (pin, reporter) — the dedup that makes report-bombing inert.
	await sql`CREATE UNIQUE INDEX IF NOT EXISTS irl_pin_reports_uniq ON irl_pin_reports (pin_id, reporter_token)`;
	await sql`CREATE INDEX IF NOT EXISTS irl_pin_reports_pin ON irl_pin_reports (pin_id)`;
	_tableReady = true;
}

export default wrap(async (req, res) => {
	cors(req, res, { methods: ['POST', 'OPTIONS'] });
	if (req.method === 'OPTIONS') return res.end();

	if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });

	const ip = clientIp(req);
	const rl = await limits.irlReportIp(ip);
	if (!rl.success) return rateLimited(res, rl);

	await ensureTable();

	const body  = req.body ?? {};
	const pinId = body.pinId;
	if (!pinId) return json(res, 400, { error: 'pinId required' });
	if (typeof pinId !== 'string' || !PIN_UUID_RE.test(pinId)) {
		return json(res, 400, { error: 'invalid pinId' });
	}

	const reason = REASONS.has(body.reason) ? body.reason : 'other';
	const detail = sanitizeDetail(body.detail);
	const reasonStored = detail ? `${reason}: ${detail}` : reason;

	const session     = await getSessionUser(req).catch(() => null);
	// H2 transport: the device credential arrives in the `x-irl-device` HEADER, with
	// the body as the documented fallback. Reading only `body.deviceToken` (as this
	// path used to) silently broke both protections that depend on knowing WHICH
	// device is reporting for a header-only client: the owner could self-report their
	// own pin as an "independent" reporter, and the per-device dedup collapsed to the
	// much coarser per-IP fallback. readDeviceToken null-guards empty/whitespace.
	const deviceToken = readDeviceToken(req);

	// The pin must exist and still be live. A 404 here is honest — you can't report
	// a pin that isn't there (already expired, deleted, or never existed).
	const [pin] = await sql`
		SELECT id, user_id, device_token, hidden_at, lat, lng
		FROM irl_pins
		WHERE id = ${pinId}
		  AND (expires_at IS NULL OR expires_at > NOW())
		LIMIT 1
	`;
	if (!pin) return json(res, 404, { error: 'pin not found' });

	// Distinct-reporter identity, most-accountable first: the signed-in user, else
	// the placing device, else the caller IP. IP fallback means many anonymous
	// reporters behind one NAT count as one — the safe direction (it makes hiding
	// HARDER to abuse, never easier).
	const reporterToken = session?.id
		? `user:${session.id}`
		: deviceToken || `ip:${ip}`;

	// Owner reporting their own pin is a no-op — not an independent flag. (A signed-in
	// owner or the placing device both count as the owner.)
	const isOwner =
		(!!session?.id && !!pin.user_id && session.id === pin.user_id) ||
		(!!deviceToken && !!pin.device_token && deviceToken === pin.device_token);
	if (isOwner) {
		return json(res, 200, { ok: true, self: true });
	}

	// Per-pin abuse ceiling (task 13). Before recording a NEW report, refuse if this
	// pin has already accrued REPORT_PIN_CAP_24H reports in the last 24h. The per-IP
	// limiter above bounds one source; the distinct-reporter dedup bounds one actor;
	// this bounds a DISTRIBUTED flood so a coordinated burst can't pile unbounded
	// reports onto a legitimate pin. Skipped once the pin is already hidden (terminal
	// — we report that state idempotently below and still keep the review trail).
	if (!pin.hidden_at) {
		const [{ n: recent }] = await sql`
			SELECT count(*)::int AS n
			FROM irl_pin_reports
			WHERE pin_id = ${pinId}
			  AND created_at > NOW() - INTERVAL '24 hours'
		`;
		if (recent >= REPORT_PIN_CAP_24H) {
			res.setHeader?.('Retry-After', '3600');
			return json(res, 429, {
				error: 'too_many_reports',
				message: 'This pin has already been reported many times and is under review.',
			});
		}
	}

	// Already hidden — accept the report idempotently (still record it for the
	// review trail) but report the terminal state to the client.
	// Insert is dedup'd by the unique (pin_id, reporter_token) index.
	await sql`
		INSERT INTO irl_pin_reports (pin_id, reporter_token, reason)
		VALUES (${pinId}, ${reporterToken}, ${reasonStored})
		ON CONFLICT (pin_id, reporter_token) DO NOTHING
	`;

	if (pin.hidden_at) {
		return json(res, 200, { ok: true, hidden: true });
	}

	// Count DISTINCT reporters and hide once the threshold is crossed. The hide is
	// guarded on hidden_at IS NULL so concurrent reports can't double-fire it.
	const [{ n }] = await sql`
		SELECT count(DISTINCT reporter_token)::int AS n
		FROM irl_pin_reports
		WHERE pin_id = ${pinId}
	`;

	let hidden = false;
	if (n >= REPORT_HIDE_THRESHOLD) {
		const rows = await sql`
			UPDATE irl_pins
			SET hidden_at = NOW()
			WHERE id = ${pinId} AND hidden_at IS NULL
			RETURNING id
		`;
		hidden = rows.length > 0;
		// Once hidden, the pin stops appearing in every read path (all are filtered
		// on hidden_at IS NULL), so a co-located viewer drops it on their next
		// proximity poll. There is no realtime remove broadcast — a pin's location
		// is never fanned out to a room, so neither is its removal.

		// Moderation audit + ops alert (task 14). An auto-hide is a moderation action
		// the review team must see — until now it left no trail. Log a structured
		// event and fire ONE deduped ops alert carrying the pin id, distinct-reporter
		// count, and timestamp. Privacy: NO coordinates and NO reporter identities —
		// the pin row carries lat/lng but they never enter the log or the alert.
		if (hidden) {
			const at = new Date().toISOString();
			console.warn('[irl/report] pin auto-hidden at report threshold', {
				endpoint: 'POST /api/irl/report',
				pinId,
				reports: n,
				threshold: REPORT_HIDE_THRESHOLD,
				ts: at,
			});
			sendOpsAlert(
				'IRL pin auto-hidden',
				`Pin ${pinId} was hidden after crossing the report threshold (${n} distinct reporters ≥ ${REPORT_HIDE_THRESHOLD}) at ${at}. Queued for review; owner may appeal. No coordinates logged.`,
				{ signature: `irl-hide:${pinId}` },
			);
		}
	}

	return json(res, 200, { ok: true, reports: n, hidden });
});
