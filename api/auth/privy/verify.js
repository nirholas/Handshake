// Verify a Privy auth token and issue a three.ws session.
// POST /api/auth/privy/verify  { token: string }
//
// The token is a Privy identity JWT signed by Privy's private key. We verify it
// against Privy's published JWKS (shared verifyPrivyToken — handles key rotation
// and clock skew). On success we resolve-or-create a user keyed by the durable
// `privy_did` column, pull their linked wallets from the Privy server API, and
// issue the standard session cookie.

import { z } from 'zod';
import { sql } from '../../_lib/db.js';
import {
	verifyPrivyToken,
	createSession,
	sessionCookie,
	destroySession,
	isSameSiteOrigin,
} from '../../_lib/auth.js';
import { fetchPrivyWallets, extractIdentity } from '../../_lib/privy.js';
import { env } from '../../_lib/env.js';
import { cors, json, method, readJson, wrap, error, rateLimited } from '../../_lib/http.js';
import { limits, clientIp } from '../../_lib/rate-limit.js';
import { parse } from '../../_lib/validate.js';
import { seedDefaultAgent } from '../../_lib/seed-default-agent.js';
import { logAudit } from '../../_lib/audit.js';
import { tosAcceptanceFromBody, recordTosAcceptance } from '../../_lib/legal.js';

const bodySchema = z.object({
	token: z.string().min(10),
});

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	// Login-CSRF guard: this endpoint SETS a session cookie. Without an origin
	// check, attacker content on any credentialed-allowlisted origin could POST
	// their own Privy token through the victim's browser and plant a session
	// for the attacker's account, so the victim's later actions land there.
	if (!isSameSiteOrigin(req)) {
		return error(res, 403, 'forbidden', 'cross-site request blocked');
	}

	const ip = clientIp(req);
	const rl = await limits.authIp(ip);
	if (!rl.success) return rateLimited(res, rl, 'too many attempts');

	if (!env.PRIVY_APP_ID) return error(res, 503, 'not_configured', 'Privy is not configured on this server');

	const raw = await readJson(req);
	const { token } = parse(bodySchema, raw);

	let payload;
	try {
		payload = await verifyPrivyToken(token);
	} catch {
		return error(res, 401, 'invalid_token', 'Privy token verification failed');
	}

	const privyDid = payload.sub; // 'did:privy:xxxxxxxx'
	if (!privyDid) return error(res, 401, 'invalid_token', 'missing subject claim');

	// Identity from the token payload (email, if Privy bundled it), then wallets
	// from the server API — the access token does not reliably carry linked wallets.
	const { email: realEmail } = extractIdentity(payload);
	const displayName = realEmail ? realEmail.split('@')[0] : privyDid.slice(-8);

	// Resolve the local user. Prefer the durable privy_did match; then fall back
	// to an existing real-email account (so an email/password user links their
	// Privy login without spawning a duplicate). Stamp privy_did on link.
	let userId;
	let isNew = false;

	const [byDid] = await sql`
		select id from users where privy_did = ${privyDid} and deleted_at is null limit 1
	`;

	if (byDid) {
		userId = byDid.id;
	} else if (realEmail) {
		const [byEmail] = await sql`
			select id from users where email = ${realEmail} and deleted_at is null limit 1
		`;
		if (byEmail) {
			userId = byEmail.id;
			await sql`update users set privy_did = ${privyDid} where id = ${userId}`;
		}
	}

	if (!userId) {
		// New passwordless user. Use the real email when present, else a stable
		// synthetic scoped to the DID (matches the SIWE/SIWS @*.local convention).
		const effectiveEmail =
			realEmail || `privy-${privyDid.replace('did:privy:', '')}@privy.local`;
		const [created] = await sql`
			insert into users (email, display_name, privy_did)
			values (${effectiveEmail}, ${displayName}, ${privyDid})
			on conflict (email) do update
				set deleted_at = null,
					privy_did = excluded.privy_did,
					display_name = excluded.display_name
			returning id, (xmax = 0) as inserted
		`;
		userId = created.id;
		isNew = created.inserted;
	}

	if (isNew) {
		queueMicrotask(() => seedDefaultAgent(userId));
	}

	// Pull linked wallets from Privy (app-secret API; token payload as fallback)
	// and persist each. Failures here never block login.
	try {
		const wallets = await fetchPrivyWallets(privyDid, payload);
		for (const w of wallets) {
			await sql`
				insert into user_wallets (user_id, address, chain_type, is_primary)
				values (${userId}, ${w.address}, ${w.chainType}, false)
				on conflict (address) do update set last_used_at = now()
			`.catch(() => {});
		}
	} catch {
		// best-effort wallet sync — login proceeds regardless
	}

	await destroySession(req);
	const sessionToken = await createSession({
		userId,
		userAgent: req.headers['user-agent'],
		ip,
	});
	res.setHeader('set-cookie', sessionCookie(sessionToken));
	logAudit({ userId, action: 'login:privy', req });
	// Terms acceptance: the login/register pages show the agreement notice next
	// to the Privy buttons and send tosAccepted with the verify call.
	const tos = tosAcceptanceFromBody(raw);
	if (tos) recordTosAcceptance({ userId, version: tos.version, context: 'privy', req });

	const [userRow] = await sql`
		select id, email, display_name, plan, avatar_url, created_at
		from users where id = ${userId} limit 1
	`;

	return json(res, 200, { user: userRow });
});
