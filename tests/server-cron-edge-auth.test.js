/**
 * The edge gate on /api/cron/* (server/cron-edge-auth.mjs).
 *
 * The handlers' own requireCron is swept separately by
 * tests/api/cron-auth-sweep.test.js. What is asserted here is the second lock:
 * that an unauthenticated caller is refused BEFORE a handler runs, that a
 * Cloud Scheduler OIDC token is accepted only when it is genuinely signed, for
 * the configured audience, by the configured service account, and that the gate
 * never invents a fail-open of its own.
 *
 * The OIDC half runs on real RS256 crypto: a keypair is generated, tokens are
 * signed with it, and the gate verifies them against a real local JWKS built
 * from the public half. Nothing about the signature check is stubbed, so a
 * regression that stopped verifying signatures would fail here rather than pass
 * against a mock that always says yes.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import {
	cronEdgeAuth,
	cronEdgeVerdict,
	isCronPath,
	looksLikeJwt,
	readCronOidcConfig,
} from '../server/cron-edge-auth.mjs';

const SECRET = 'edge-gate-test-secret';
const AUDIENCE = 'https://three.ws';
const SCHEDULER_SA = 'three-ws@aerial-vehicle-466722-p5.iam.gserviceaccount.com';

let keys;
let signingKey;
let otherKey;
const savedEnv = { ...process.env };

beforeAll(async () => {
	const scheduler = await generateKeyPair('RS256');
	const impostor = await generateKeyPair('RS256');
	signingKey = scheduler.privateKey;
	otherKey = impostor.privateKey;
	const jwk = await exportJWK(scheduler.publicKey);
	jwk.kid = 'scheduler-key';
	jwk.alg = 'RS256';
	// Only the scheduler's key is published: a token signed by `otherKey` has no
	// resolvable key, which is exactly Google's position on a forged token.
	keys = createLocalJWKSet({ keys: [jwk] });
});

beforeEach(() => {
	process.env.CRON_SECRET = SECRET;
	process.env.CRON_OIDC_AUDIENCE = AUDIENCE;
	process.env.CRON_OIDC_SERVICE_ACCOUNT = SCHEDULER_SA;
});

afterAll(() => {
	process.env = { ...savedEnv };
});

async function token({
	key = signingKey,
	iss = 'https://accounts.google.com',
	aud = AUDIENCE,
	email = SCHEDULER_SA,
	emailVerified = true,
	expiresIn = '5m',
} = {}) {
	const jwt = new SignJWT({ email, email_verified: emailVerified })
		.setProtectedHeader({ alg: 'RS256', kid: 'scheduler-key' })
		.setIssuer(iss)
		.setAudience(aud)
		.setIssuedAt();
	if (expiresIn !== null) jwt.setExpirationTime(expiresIn);
	return jwt.sign(key);
}

function req(headers = {}, url = '/api/cron/economy-tick') {
	return { method: 'GET', url, headers };
}

const verdict = (r, env = process.env) => cronEdgeVerdict(r, { env, keys });

describe('cron edge gate: path scoping', () => {
	it('covers every api/cron route and nothing else', () => {
		expect(isCronPath('/api/cron/economy-tick')).toBe(true);
		expect(isCronPath('/api/cron/[name].js')).toBe(true);
		// The bare directory is not a route, and no other surface is gated here:
		// widening this prefix would 401 the whole API.
		expect(isCronPath('/api/cron/')).toBe(false);
		expect(isCronPath('/api/ops/health')).toBe(false);
		expect(isCronPath('/api/crontab')).toBe(false);
		expect(isCronPath('/')).toBe(false);
	});
});

describe('cron edge gate: the secret path', () => {
	it('accepts the same Bearer secret the handlers validate', async () => {
		const out = await verdict(req({ authorization: `Bearer ${SECRET}` }));
		expect(out).toMatchObject({ allow: true, via: 'cron-secret' });
	});

	it('accepts X-Cron-Secret, which is where the header moves when OIDC is attached', async () => {
		// Cloud Scheduler puts its OIDC token in Authorization, so a job that gains
		// OIDC loses the Bearer secret. cron-auth.js already accepts this spelling;
		// if the edge did not, attaching OIDC would 401 the fleet at the edge even
		// though the handlers were fine.
		const out = await verdict(req({ 'x-cron-secret': SECRET }));
		expect(out).toMatchObject({ allow: true, via: 'cron-secret' });
	});

	it('refuses a wrong secret and an absent one', async () => {
		expect(await verdict(req({ authorization: 'Bearer nope' }))).toMatchObject({ allow: false, status: 401 });
		expect(await verdict(req())).toMatchObject({ allow: false, status: 401 });
	});
});

describe('cron edge gate: the OIDC path', () => {
	it('accepts a genuine scheduler token', async () => {
		const out = await verdict(req({ authorization: `Bearer ${await token()}` }));
		expect(out.allow).toBe(true);
		expect(out.via).toBe(`oidc:${SCHEDULER_SA}`);
	});

	it('accepts it even with CRON_SECRET absent, so the secret can eventually retire', async () => {
		delete process.env.CRON_SECRET;
		const out = await verdict(req({ authorization: `Bearer ${await token()}` }));
		expect(out.allow).toBe(true);
	});

	it('refuses a token signed by anything but Google', async () => {
		// The whole point of the layer: a caller who knows the audience and the
		// service-account email still cannot mint an acceptable token.
		const out = await verdict(req({ authorization: `Bearer ${await token({ key: otherKey })}` }));
		expect(out).toMatchObject({ allow: false, status: 401 });
	});

	it('refuses another service account', async () => {
		const out = await verdict(req({ authorization: `Bearer ${await token({ email: 'someone-else@example.iam.gserviceaccount.com' })}` }));
		expect(out).toMatchObject({ allow: false, status: 401 });
	});

	it('refuses a token minted for a different audience', async () => {
		const out = await verdict(req({ authorization: `Bearer ${await token({ aud: 'https://example.com' })}` }));
		expect(out).toMatchObject({ allow: false, status: 401 });
	});

	it('refuses a token from a different issuer', async () => {
		const out = await verdict(req({ authorization: `Bearer ${await token({ iss: 'https://evil.example' })}` }));
		expect(out).toMatchObject({ allow: false, status: 401 });
	});

	it('refuses an expired token', async () => {
		const out = await verdict(req({ authorization: `Bearer ${await token({ expiresIn: '-10m' })}` }));
		expect(out).toMatchObject({ allow: false, status: 401 });
	});

	it('refuses a token whose email is not verified', async () => {
		const out = await verdict(req({ authorization: `Bearer ${await token({ emailVerified: false })}` }));
		expect(out).toMatchObject({ allow: false, status: 401 });
	});

	it('is off unless BOTH the audience and the service account are configured', async () => {
		// An audience with no allowlist would accept a token any Google customer
		// can mint for an arbitrary audience, which authenticates nobody.
		delete process.env.CRON_OIDC_SERVICE_ACCOUNT;
		expect(readCronOidcConfig(process.env).enabled).toBe(false);
		const out = await verdict(req({ authorization: `Bearer ${await token()}` }));
		expect(out).toMatchObject({ allow: false, status: 401 });
	});

	it('only spends a signature check on something shaped like a JWT', () => {
		// CRON_SECRET arrives as a Bearer too; resolving keys for every wrong
		// secret would turn an unauthenticated flood into outbound requests.
		expect(looksLikeJwt('a.b.c')).toBe(true);
		expect(looksLikeJwt(SECRET)).toBe(false);
		expect(looksLikeJwt('a.b.')).toBe(false);
		expect(looksLikeJwt('')).toBe(false);
	});
});

describe('cron edge gate: it never invents a fail-open', () => {
	it('stands aside only when no credential is configured at all', async () => {
		// A developer's machine: the handler owns the 503 so "not configured" has
		// one spelling. Production always has CRON_SECRET, so it is never here.
		delete process.env.CRON_SECRET;
		delete process.env.CRON_OIDC_AUDIENCE;
		delete process.env.CRON_OIDC_SERVICE_ACCOUNT;
		const out = await verdict(req());
		expect(out).toMatchObject({ allow: true, via: 'unconfigured' });
	});

	it('closes as soon as a secret exists, even with OIDC unconfigured', async () => {
		delete process.env.CRON_OIDC_AUDIENCE;
		delete process.env.CRON_OIDC_SERVICE_ACCOUNT;
		expect(await verdict(req())).toMatchObject({ allow: false, status: 401 });
	});

	it('closes when the key resolver itself fails', async () => {
		const exploding = async () => { throw new Error('jwks unreachable'); };
		const out = await cronEdgeVerdict(req({ authorization: `Bearer ${await token()}` }), {
			env: process.env,
			keys: exploding,
		});
		expect(out).toMatchObject({ allow: false, status: 401 });
	});
});

describe('cron edge gate: the middleware', () => {
	function res() {
		const r = { statusCode: null, headers: {}, body: null, ended: false };
		r.status = (c) => { r.statusCode = c; return r; };
		r.set = (k, v) => { r.headers[String(k).toLowerCase()] = v; return r; };
		r.json = (b) => { r.body = b; r.ended = true; return r; };
		return r;
	}

	async function run(request) {
		const r = res();
		let passed = false;
		await cronEdgeAuth({ env: process.env, keys })(request, r, () => { passed = true; });
		return { passed, res: r };
	}

	it('lets a non-cron request through untouched', async () => {
		const { passed, res: r } = await run(req({}, '/api/ops/health'));
		expect(passed).toBe(true);
		expect(r.statusCode).toBeNull();
	});

	it('lets an authenticated cron request reach its handler', async () => {
		const { passed } = await run(req({ authorization: `Bearer ${SECRET}` }));
		expect(passed).toBe(true);
	});

	it('answers an anonymous cron request 401 without calling next', async () => {
		const { passed, res: r } = await run(req());
		expect(passed).toBe(false);
		expect(r.statusCode).toBe(401);
		expect(r.body).toEqual({ error: 'unauthorized', error_description: 'cron credential required' });
		// A 401 that a CDN could cache would be served back to the scheduler.
		expect(r.headers['cache-control']).toBe('no-store');
	});

	it('gates a cron request that arrives with a query string', async () => {
		const { passed, res: r } = await run(req({}, '/api/cron/treasury-topup?dry=1'));
		expect(passed).toBe(false);
		expect(r.statusCode).toBe(401);
	});
});
