// Consolidated auth endpoint. Dispatches on URL action segment.
// Routes: /api/auth/login, /api/auth/logout, /api/auth/register,
//         /api/auth/me, /api/auth/profile, /api/auth/forgot-password,
//         /api/auth/reset-password, /api/auth/verify-email,
//         /api/auth/resend-verification, /api/auth/logout-everywhere

import { sql } from '../_lib/db.js';
import {
	verifyPassword, hashPassword, createSession, destroySession, sessionCookie,
	getSessionUser, hasSessionCookie, revokeRefreshToken,
} from '../_lib/auth.js';
import { randomToken, randomDigits, sha256 } from '../_lib/crypto.js';
import { cors, json, method, readJson, wrap, error, rateLimited } from '../_lib/http.js';
import { requireCsrf } from '../_lib/csrf.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import captcha, { verifyBypassToken } from './captcha.js';
import { parse, loginBody, registerBody, usernameRegisterBody, username as usernameValidator, displayName, email, password, bio as bioValidator, profileLocation, httpUrl } from '../_lib/validate.js';
import { sendPasswordResetEmail, sendVerificationEmail } from '../_lib/email.js';
import { referralCodeCandidates, normalizeReferralCode } from '../_lib/referrals.js';
import { seedDefaultAgent } from '../_lib/seed-default-agent.js';
import { recordEvent } from '../_lib/usage.js';
import { logAudit } from '../_lib/audit.js';
import { tosAcceptanceFromBody, recordTosAcceptance } from '../_lib/legal.js';
import { z } from 'zod';

const APP_ORIGIN = process.env.APP_ORIGIN || 'https://three.ws';

// Fixed bcrypt hash (cost 11) of a throwaway string — NOT a real credential.
// Compared against when a login targets a non-existent account so the bcrypt
// cost is paid either way and login timing can't be used to enumerate users.
const DUMMY_PASSWORD_HASH = '$2a$11$lbeuSxk2uZlrn87LKkZBq.2zXLxDFb6PSJ525DddtFq7wVLzVCK0W';

// ── login ─────────────────────────────────────────────────────────────────────

async function handleLogin(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;
	const ip = clientIp(req);
	// A solved CAPTCHA (api/auth/captcha) issues a short-lived HMAC-signed bypass
	// token. When present and valid, route through the captcha-specific bucket so
	// real humans who solved the puzzle aren't stuck behind the same counter as
	// the bots that triggered the limit in the first place.
	const captchaToken = req.headers['x-captcha-token'];
	if (captchaToken && verifyBypassToken(ip, captchaToken)) {
		const rl = await limits.authIpCaptcha(ip);
		if (!rl.success) return rateLimited(res, rl, 'too many attempts; try again later', { captcha_available: true });
	} else {
		const rl = await limits.authIp(ip);
		if (!rl.success) return rateLimited(res, rl, 'too many attempts; try again later', { captcha_available: true });
	}
	const raw = await readJson(req);
	const body = parse(loginBody, raw);
	const isEmail = body.email.includes('@');
	const rows = isEmail
		? await sql`select id, email, password_hash, display_name, plan, avatar_url, referral_code from users where email = ${body.email} and deleted_at is null limit 1`
		: await sql`select id, email, password_hash, display_name, plan, avatar_url, referral_code from users where lower(display_name) = lower(${body.email}) and deleted_at is null limit 1`;
	const user = rows[0];
	// Always run a bcrypt compare, even when the account doesn't exist, so the
	// response time doesn't reveal whether the email/username is registered.
	// The dummy hash is a fixed cost-11 hash of a throwaway string (never a
	// real credential); comparing against it for unknown users equalizes timing.
	const hashToCheck = user?.password_hash || DUMMY_PASSWORD_HASH;
	const passwordOk = await verifyPassword(body.password, hashToCheck);
	const ok = Boolean(user) && passwordOk;
	if (!ok) return error(res, 401, 'invalid_credentials', 'invalid username/email or password');
	await destroySession(req);
	const token = await createSession({ userId: user.id, userAgent: req.headers['user-agent'], ip });
	res.setHeader('set-cookie', sessionCookie(token));
	logAudit({ userId: user.id, action: 'login', req });
	// The login form carries a "By signing in you agree…" notice, so each
	// sign-in re-affirms the current Terms: this is how pre-clickwrap
	// accounts converge onto a recorded acceptance.
	const tos = tosAcceptanceFromBody(raw);
	if (tos) recordTosAcceptance({ userId: user.id, version: tos.version, context: 'login', req });
	const { password_hash: _p, ...safe } = user;
	return json(res, 200, { user: safe });
}

// ── logout ────────────────────────────────────────────────────────────────────

async function handleLogout(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;
	const sessionUser = await getSessionUser(req).catch(() => null);
	await destroySession(req);
	res.setHeader('set-cookie', sessionCookie('', { clear: true }));
	if (sessionUser) logAudit({ userId: sessionUser.id, action: 'logout', req });
	return json(res, 200, { ok: true });
}

// ── logout-everywhere ─────────────────────────────────────────────────────────

async function handleLogoutEverywhere(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;
	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthenticated', 'not signed in');
	if (!(await requireCsrf(req, res, user.id))) return;
	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);
	const sessionResult = await sql`update sessions set revoked_at = now() where user_id = ${user.id} and revoked_at is null`;
	await sql`update oauth_refresh_tokens set revoked_at = now() where user_id = ${user.id} and revoked_at is null`;
	const clearCookies = sessionCookie('', { clear: true });
	const existing = res.getHeader('set-cookie') || [];
	res.setHeader('set-cookie', [...(Array.isArray(existing) ? existing : [existing]), ...clearCookies]);
	return json(res, 200, { ok: true, revoked: sessionResult.count });
}

// ── register ──────────────────────────────────────────────────────────────────

// Bounded retry to ride out the rare collision against the unique index on
// users.referral_code. The index is the authoritative guard; this loop is the
// UX shield so simultaneous signups don't surface a 500. The first candidate is
// the member's name (so their default referral code reads like them), then a
// name+suffix, then CSPRNG fallbacks — so consecutive collisions are
// astronomically unlikely. If we ever exhaust, something upstream is wrong and
// we want to surface it.
async function insertUserWithUniqueReferralCode({ email, passwordHash, displayName, referredById }) {
	for (const code of referralCodeCandidates(displayName)) {
		try {
			const [row] = await sql`
				insert into users (email, password_hash, display_name, referred_by_id, referral_code)
				values (${email}, ${passwordHash}, ${displayName}, ${referredById}, ${code})
				returning id, display_name, plan, created_at, referral_code
			`;
			return row;
		} catch (err) {
			if (err?.code === '23505') {
				// Referral code collision → try next candidate.
				if (/referral_code/.test(err.message || '')) continue;
				// Email / display_name collision from a concurrent registration that
				// slipped past the pre-check — surface as a proper 409 instead of 500.
				throw Object.assign(new Error('email or username already in use'), { status: 409, code: 'conflict' });
			}
			throw err;
		}
	}
	throw new Error('referral_code_generation_exhausted');
}

async function handleRegister(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;
	const ip = clientIp(req);
	const rl = await limits.registerIp(ip);
	if (!rl.success) return rateLimited(res, rl, 'too many signups from this IP');
	const raw = await readJson(req);
	// Clickwrap gate: account creation requires explicit Terms acceptance.
	// The register form gates its submit button on the agreement checkbox and
	// sends tosAccepted; a request without it never creates an account.
	const tos = tosAcceptanceFromBody(raw);
	if (!tos) {
		return error(res, 400, 'tos_required', 'you must accept the Terms of Service and Privacy Policy to create an account');
	}
	let email_val, displayName_val, passwordVal, referralCode;
	if (raw.username && !raw.email) {
		const body = parse(usernameRegisterBody, raw);
		const safe = body.username.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
		email_val = `${safe}@users.three.ws.local`;
		displayName_val = body.username;
		passwordVal = body.password;
		referralCode = body.referralCode;
		const existing = await sql`select id from users where lower(display_name) = lower(${body.username}) and deleted_at is null limit 1`;
		if (existing[0]) return error(res, 409, 'conflict', 'email or username already in use');
	} else {
		const body = parse(registerBody, raw);
		email_val = body.email; displayName_val = body.display_name ?? null; passwordVal = body.password;
		referralCode = body.referralCode;
		const existing = await sql`select id from users where email = ${email_val} and deleted_at is null limit 1`;
		if (existing[0]) return error(res, 409, 'conflict', 'email or username already in use');
	}

	let referred_by_id = null;
	const normalizedRef = normalizeReferralCode(referralCode);
	if (normalizedRef) {
		const [referrer] = await sql`select id from users where upper(referral_code) = ${normalizedRef} and deleted_at is null limit 1`;
		if (referrer) {
			referred_by_id = referrer.id;
		}
	}

	const hash = await hashPassword(passwordVal);
	let user;
	try {
		user = await insertUserWithUniqueReferralCode({
			email: email_val,
			passwordHash: hash,
			displayName: displayName_val,
			referredById: referred_by_id,
		});
	} catch (err) {
		if (err?.status === 409) return error(res, 409, err.code || 'conflict', err.message);
		throw err;
	}
	// Funnel: record the referred signup so visit→signup is measurable. The
	// wallet auth paths (Privy/SIWS/SIWE) attribute later via referral-claim.js,
	// which emits the mirror event.
	if (referred_by_id) {
		recordEvent({
			userId: referred_by_id,
			kind: 'referral_signup',
			meta: { referred_user_id: String(user.id), source: 'signup' },
		});
	}
	recordTosAcceptance({ userId: user.id, version: tos.version, context: 'register', req });
	// Fire-and-forget: every new account gets a starter draft agent so the
	// marketplace's "My Agents" tab and onboarding flow have something to show.
	queueMicrotask(() => seedDefaultAgent(user.id));
	await destroySession(req);
	const token = await createSession({ userId: user.id, userAgent: req.headers['user-agent'], ip });
	res.setHeader('set-cookie', sessionCookie(token));
	return json(res, 201, { user });
}

// ── me ────────────────────────────────────────────────────────────────────────

// Probe endpoint: anonymous callers (no cookie) get 200 { user: null } so the
// browser doesn't log a network error on every page load. A 401 here means a
// cookie was presented but didn't resolve to a live session — the client
// should clear local state and treat it as a forced logout.
async function handleMe(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;
	if (!hasSessionCookie(req)) return json(res, 200, { user: null });
	const user = await getSessionUser(req);
	if (!user) {
		res.setHeader('Set-Cookie', sessionCookie('', { clear: true }));
		return error(res, 401, 'invalid_session', 'session expired or revoked');
	}
	return json(res, 200, { user });
}

// ── profile ───────────────────────────────────────────────────────────────────

const profileSchema = z.object({
	username: usernameValidator.optional(),
	display_name: displayName.optional(),
	bio: bioValidator.optional(),
	website: httpUrl.optional(),
	location: profileLocation.optional(),
	avatar_url: httpUrl.optional(),
	banner_url: httpUrl.optional(),
}).refine(
	(b) => Object.keys(b).length > 0,
	{ message: 'at least one field required' },
);

// Trim, and treat an empty string as an explicit "clear this field" → null.
// `undefined` (key omitted) leaves the stored value untouched.
function profileField(value, current) {
	if (value === undefined) return current;
	const trimmed = String(value).trim();
	return trimmed === '' ? null : trimmed;
}

async function handleProfile(req, res) {
	if (cors(req, res, { methods: 'PATCH,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['PATCH'])) return;
	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthenticated', 'not signed in');
	if (!(await requireCsrf(req, res, user.id))) return;
	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);
	const body = parse(profileSchema, await readJson(req));

	const [current] = await sql`
		select username, display_name, bio, website, location, avatar_url, banner_url
		from users where id = ${user.id} and deleted_at is null limit 1
	`;
	if (!current) return error(res, 401, 'unauthenticated', 'not signed in');

	if (body.username && body.username.toLowerCase() !== (current.username || '').toLowerCase()) {
		const taken = await sql`select id from users where lower(username) = ${body.username.toLowerCase()} and id != ${user.id} and deleted_at is null limit 1`;
		if (taken[0]) return error(res, 409, 'conflict', 'username already taken');
	}

	const next = {
		// username can only be set/changed, never cleared (it's the profile URL).
		username: body.username !== undefined ? body.username : current.username,
		display_name: body.display_name !== undefined ? body.display_name : current.display_name,
		bio: profileField(body.bio, current.bio),
		website: profileField(body.website, current.website),
		location: profileField(body.location, current.location),
		avatar_url: profileField(body.avatar_url, current.avatar_url),
		banner_url: profileField(body.banner_url, current.banner_url),
	};

	const [updated] = await sql`
		update users set
			username = ${next.username},
			display_name = ${next.display_name},
			bio = ${next.bio},
			website = ${next.website},
			location = ${next.location},
			avatar_url = ${next.avatar_url},
			banner_url = ${next.banner_url},
			updated_at = now()
		where id = ${user.id} and deleted_at is null
		returning id, username, display_name, bio, website, location, avatar_url, banner_url
	`;
	logAudit({
		userId: user.id,
		action: 'update_profile',
		meta: { fields: Object.keys(body) },
		req,
	});
	return json(res, 200, { user: updated });
}

// ── forgot-password ───────────────────────────────────────────────────────────

const forgotSchema = z.object({ email });

async function handleForgotPassword(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;
	const body = parse(forgotSchema, await readJson(req));
	const rl = await limits.forgotPasswordEmail(body.email);
	if (!rl.success) return json(res, 200, { success: true });
	const rows = await sql`select id from users where email = ${body.email} and deleted_at is null limit 1`;
	if (rows[0]) {
		const token = randomToken(32);
		const tokenHash = await sha256(token);
		const expiresAt = new Date(Date.now() + 60 * 60_000);
		await sql`insert into password_resets (user_id, token_hash, expires_at) values (${rows[0].id}, ${tokenHash}, ${expiresAt.toISOString()})`;
		sendPasswordResetEmail({ to: body.email, resetUrl: `${APP_ORIGIN}/reset-password?token=${encodeURIComponent(token)}`, expiresInMinutes: 60 }).catch(() => {});
	}
	return json(res, 200, { success: true });
}

// ── reset-password ────────────────────────────────────────────────────────────

const resetSchema = z.object({ token: z.string().min(16).max(256), password });

async function handleResetPassword(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;
	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl, 'too many attempts; try again later');
	const body = parse(resetSchema, await readJson(req));
	const tokenHash = await sha256(body.token);
	const rows = await sql`select r.id, r.user_id from password_resets r join users u on u.id = r.user_id where r.token_hash = ${tokenHash} and r.consumed_at is null and r.expires_at > now() and u.deleted_at is null limit 1`;
	if (!rows[0]) return error(res, 400, 'invalid_token', 'reset link is invalid or has expired');
	const hash = await hashPassword(body.password);
	await sql`update users set password_hash = ${hash}, updated_at = now() where id = ${rows[0].user_id}`;
	await sql`update password_resets set consumed_at = now() where id = ${rows[0].id}`;
	await sql`update sessions set revoked_at = now() where user_id = ${rows[0].user_id} and revoked_at is null`;
	return json(res, 200, { success: true });
}

// ── verify-email ──────────────────────────────────────────────────────────────

const verifyEmailSchema = z.object({ code: z.string().trim().regex(/^\d{6}$/, '6-digit code required') });

async function handleVerifyEmail(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;
	const rl = await limits.verifyEmailIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl, 'too many attempts; try again later');
	const body = parse(verifyEmailSchema, await readJson(req));
	const codeHash = await sha256(body.code);
	const rows = await sql`select v.id, v.user_id from email_verifications v join users u on u.id = v.user_id where v.code_hash = ${codeHash} and v.consumed_at is null and v.expires_at > now() and u.deleted_at is null limit 1`;
	if (!rows[0]) return error(res, 400, 'invalid_code', 'invalid or expired verification code');
	await sql`update email_verifications set consumed_at = now() where id = ${rows[0].id}`;
	await sql`update users set email_verified = true, updated_at = now() where id = ${rows[0].user_id}`;
	return json(res, 200, { success: true });
}

// ── resend-verification ───────────────────────────────────────────────────────

async function handleResendVerification(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;
	const session = await getSessionUser(req);
	if (!session) return error(res, 401, 'unauthorized', 'sign in required');
	const rl = await limits.resendVerifyUser(session.id);
	if (!rl.success) return rateLimited(res, rl, 'please wait before requesting again');
	const rows = await sql`select email, email_verified from users where id = ${session.id} and deleted_at is null limit 1`;
	if (!rows[0]) return error(res, 401, 'unauthorized', 'sign in required');
	if (rows[0].email_verified) return json(res, 200, { success: true, already_verified: true });
	await sql`update email_verifications set consumed_at = now() where user_id = ${session.id} and consumed_at is null`;
	const code = randomDigits(6);
	const codeHash = await sha256(code);
	const expiresAt = new Date(Date.now() + 30 * 60_000);
	await sql`insert into email_verifications (user_id, code_hash, expires_at) values (${session.id}, ${codeHash}, ${expiresAt.toISOString()})`;
	sendVerificationEmail({ to: rows[0].email, code, expiresInMinutes: 30 }).catch(() => {});
	return json(res, 200, { success: true });
}

// ── dispatcher ────────────────────────────────────────────────────────────────

const DISPATCH = {
	login:                 handleLogin,
	logout:                handleLogout,
	'logout-everywhere':   handleLogoutEverywhere,
	register:              handleRegister,
	me:                    handleMe,
	profile:               handleProfile,
	'forgot-password':     handleForgotPassword,
	'reset-password':      handleResetPassword,
	'verify-email':        handleVerifyEmail,
	'resend-verification': handleResendVerification,
	// The /api/auth/([^/]+) route matches before filesystem routing, so the
	// standalone captcha handler must be dispatched here or it is unreachable
	// and rate-limited users can never solve the login captcha.
	captcha,
};

export default wrap(async (req, res) => {
	const action = req.query?.action ?? new URL(req.url, 'http://x').pathname.split('/').pop();
	const fn = DISPATCH[action];
	if (!fn) return error(res, 404, 'not_found', `unknown action: ${action}`);
	return fn(req, res);
});
