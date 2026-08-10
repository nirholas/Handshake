// api/auth/captcha.js: the Altcha proof-of-work challenge and the bypass token
// it issues. The token is what moves a rate-limited human from the punitive
// authIp bucket onto the roomier authIpCaptcha one in api/auth/[action].js, so
// a forged or replayed token is a rate-limit bypass, not a cosmetic bug.
//
// This runs the real Altcha solver against the real handler: no mocked crypto,
// no hand-rolled HMAC that could drift from the implementation.

import { describe, it, expect, beforeEach } from 'vitest';
import { createChallenge, solveChallenge } from 'altcha-lib/v1';

process.env.JWT_SECRET ||= 'vitest-ephemeral-jwt-secret-00000000000000';
process.env.ALTCHA_HMAC_KEY = 'vitest-altcha-hmac-key-0000000000000000';

const { default: handler, verifyBypassToken } = await import('../../api/auth/captcha.js');

const CLIENT_IP = '203.0.113.7';

function makeReq(method, body) {
	return {
		method,
		url: '/api/auth/captcha',
		query: { action: 'captcha' },
		headers: { 'content-type': 'application/json', 'x-forwarded-for': CLIENT_IP },
		socket: { remoteAddress: CLIENT_IP },
		body: body === undefined ? undefined : JSON.stringify(body),
	};
}

function makeRes() {
	const r = { statusCode: 200, _h: {}, _b: null };
	r.setHeader = (k, v) => { r._h[k.toLowerCase()] = v; };
	r.getHeader = (k) => r._h[k.toLowerCase()];
	r.end = (b) => { r._b = b; };
	Object.defineProperty(r, 'json', { value: () => JSON.parse(r._b) });
	return r;
}

// Solving the proof of work is the expensive part of this file, so the whole
// suite shares one genuine solve rather than re-running it per test.
let issued;
function issueToken() {
	issued ??= solveOnce();
	return issued;
}

async function solveOnce() {
	// Minted with the server's own HMAC key, so the handler verifies it exactly
	// as it would a live challenge. Only the difficulty is dialled down: the
	// production maxNumber of 50k costs a real user under two seconds in a
	// browser but tens of seconds in the single-threaded test solver, and the
	// number of hashes tried is not what these tests are pinning.
	const challenge = await createChallenge({
		hmacKey: process.env.ALTCHA_HMAC_KEY,
		maxNumber: 200,
	});
	const { promise } = solveChallenge(challenge.challenge, challenge.salt, challenge.algorithm, challenge.maxnumber);
	const solution = await promise;
	const payload = Buffer.from(JSON.stringify({
		algorithm: challenge.algorithm,
		challenge: challenge.challenge,
		number: solution.number,
		salt: challenge.salt,
		signature: challenge.signature,
	})).toString('base64');

	const verifyRes = makeRes();
	await handler(makeReq('POST', { payload }), verifyRes);
	return verifyRes;
}

describe('GET /api/auth/captcha', () => {
	it('issues a solvable challenge', async () => {
		const res = makeRes();
		await handler(makeReq('GET'), res);
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.algorithm).toBe('SHA-256');
		expect(typeof body.challenge).toBe('string');
		expect(typeof body.salt).toBe('string');
		expect(typeof body.signature).toBe('string');
		expect(body.maxnumber).toBe(50_000);
	});
});

describe('POST /api/auth/captcha', () => {
	it('accepts a genuinely solved challenge and issues a bypass token', async () => {
		const res = await issueToken();
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.ok).toBe(true);
		expect(body.token).toMatch(/^v1:\d+:[0-9a-f]{64}$/);
	});

	it('rejects a request with no payload', async () => {
		const res = makeRes();
		await handler(makeReq('POST', {}), res);
		expect(res.statusCode).toBe(400);
		expect(res.json().error).toBe('bad_request');
	});

	it('rejects an unsolved or forged payload', async () => {
		const payload = Buffer.from(JSON.stringify({
			algorithm: 'SHA-256',
			challenge: 'f'.repeat(64),
			number: 1,
			salt: 'deadbeef',
			signature: 'f'.repeat(64),
		})).toString('base64');

		const res = makeRes();
		await handler(makeReq('POST', { payload }), res);
		expect(res.statusCode).toBe(400);
		expect(res.json().error).toBe('captcha_failed');
	});

	it('rejects a non-POST, non-GET method', async () => {
		const res = makeRes();
		await handler(makeReq('DELETE', {}), res);
		expect(res.statusCode).toBe(405);
	});
});

describe('verifyBypassToken', () => {
	let token;

	beforeEach(async () => {
		token ??= (await issueToken()).json().token;
	});

	it('accepts the token it just issued, for the IP it was issued to', () => {
		expect(verifyBypassToken(CLIENT_IP, token)).toBe(true);
	});

	it('rejects the token for a different IP', () => {
		// The token is bound to the solver's IP, so a solved puzzle cannot be
		// resold to a farm of other addresses.
		expect(verifyBypassToken('198.51.100.9', token)).toBe(false);
	});

	it('rejects a tampered signature', () => {
		const [v, window, sig] = token.split(':');
		const flipped = sig[0] === '0' ? `1${sig.slice(1)}` : `0${sig.slice(1)}`;
		expect(verifyBypassToken(CLIENT_IP, `${v}:${window}:${flipped}`)).toBe(false);
	});

	it('rejects a token from an expired time window', () => {
		const [v, window, sig] = token.split(':');
		expect(verifyBypassToken(CLIENT_IP, `${v}:${Number(window) - 2}:${sig}`)).toBe(false);
	});

	it('rejects malformed and empty tokens', () => {
		expect(verifyBypassToken(CLIENT_IP, '')).toBe(false);
		expect(verifyBypassToken(CLIENT_IP, null)).toBe(false);
		expect(verifyBypassToken(CLIENT_IP, 'v1:notanumber:abc')).toBe(false);
		expect(verifyBypassToken(CLIENT_IP, 'v2:1:abc')).toBe(false);
		expect(verifyBypassToken(CLIENT_IP, 'only:two')).toBe(false);
	});
});
