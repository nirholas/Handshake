// POST /api/referral/visit: record a referral-link visit (top of the viral funnel).
//
// A share link carries `?ref=CODE`. public/referral-capture.js parks the code for
// later signup attribution AND fires a beacon here so we can measure the FULL
// loop: visit → signup → activation, and from it the k-factor (signups per
// sharing user). Without this, only signups are visible and k is unknowable.
//
// Public + unauthenticated by design (the visitor has no account yet). Privacy-
// preserving: we store sha256(ip + ua + code), never the raw IP/UA, and dedup to
// one row per (code, visitor, UTC day) so refreshes don't inflate the funnel. An
// unknown code still records a visit (referrer_user_id NULL) so dead-link traffic
// is visible too.
//
// body: { code: string }
// → { ok: true } | { ok: false, error }

import { sql } from '../_lib/db.js';
import { cors, json, error, method, wrap, rateLimited, readJson } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { recordEvent } from '../_lib/usage.js';
import { normalizeReferralCode } from '../_lib/referrals.js';
import { referralVisitorHash } from '../_lib/referral-rewards.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS' })) return;
	if (!method(req, res, ['POST'])) return;

	const ip = clientIp(req);
	const rl = await limits.referralVisitIp(ip);
	if (!rl.success) return rateLimited(res, rl);

	// A body we could not read at all is a different failure from a code we read
	// and rejected. Collapsing both into `invalid_code` sends an integrator hunting
	// through their referral code when the real fault is their content-type header
	// (readJson requires application/json) or an oversized payload.
	let body;
	try {
		body = await readJson(req);
	} catch (err) {
		const status = err?.status === 415 || err?.status === 413 ? err.status : 400;
		const code = { 415: 'unsupported_media_type', 413: 'payload_too_large' }[status] || 'bad_request';
		return error(res, status, code, err?.message || 'unreadable request body');
	}

	const code = normalizeReferralCode(body?.code);
	if (!code) return error(res, 400, 'invalid_code', 'malformed referral code');

	const ua = String(req.headers['user-agent'] || '').slice(0, 512);
	const visitorHash = referralVisitorHash({ ip, ua, code });
	// UTC day so the dedup window is stable regardless of server timezone.
	const day = new Date().toISOString().slice(0, 10);

	// Resolve the referrer at write time when the code is live, which lets the funnel
	// roll up by referrer without re-joining on every read.
	const [referrer] = await sql`
		select id from users
		where upper(referral_code) = ${code} and deleted_at is null
		limit 1
	`;
	const referrerId = referrer?.id ?? null;

	// One visit per (code, visitor, day). A replay is a silent success.
	const [inserted] = await sql`
		insert into referral_visits (code, referrer_user_id, visitor_hash, day)
		values (${code}, ${referrerId}, ${visitorHash}, ${day}::date)
		on conflict (code, visitor_hash, day) do nothing
		returning id
	`;

	if (inserted) {
		recordEvent({
			userId: referrerId,
			kind: 'referral_visit',
			meta: { code, has_referrer: Boolean(referrerId) },
		});
	}

	return json(res, 200, { ok: true });
});
