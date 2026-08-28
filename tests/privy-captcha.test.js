// Privy answers passwordless/init and siwe/init with HTTP 401
// `invalid_credentials` when the app requires a CAPTCHA and the request carries
// no token. That message reads as "your email or wallet is wrong", so people
// went and reset a password that was never the problem.
//
// The cause was a probe that could not tell two answers apart: reading the app
// config returned `null` both for "this app needs no CAPTCHA" and for "we could
// not read the config", so a flaky network silently became a wrong-credentials
// error at the end of the flow. These tests pin that the three outcomes stay
// three, that a failed read retries once at the moment of use, and that the
// messages a person actually reads say what happened.
import { describe, it, expect, vi } from 'vitest';
import {
	fetchCaptchaConfig,
	makeCaptchaResolver,
	captchaRequirement,
	signInMessage,
	CAPTCHA_UNAVAILABLE,
	CAPTCHA_UNKNOWN_MESSAGE,
} from '../src/auth/privy-captcha.js';

const APP = 'app-abc123';
const ok = (body) => ({ ok: true, json: async () => body });

describe('fetchCaptchaConfig', () => {
	it('returns the Turnstile config when the app requires one', async () => {
		const fetchImpl = vi.fn(async () => ok({
			captcha_enabled: true,
			captcha_site_key: 't:0xSITEKEY',
			enabled_captcha_provider: 'turnstile',
		}));
		const cfg = await fetchCaptchaConfig(APP, { fetchImpl });
		// Privy prefixes Turnstile site keys with "t:"; Turnstile itself rejects it.
		expect(cfg).toEqual({ siteKey: '0xSITEKEY', apiUrl: 'https://auth.privy.io' });
	});

	it('honours a custom auth domain, which serves every auth endpoint', async () => {
		const fetchImpl = vi.fn(async () => ok({
			captcha_enabled: true,
			captcha_site_key: 't:k',
			custom_api_url: 'https://auth.example.com',
		}));
		expect((await fetchCaptchaConfig(APP, { fetchImpl })).apiUrl).toBe('https://auth.example.com');
	});

	it('returns null when the app genuinely has no CAPTCHA', async () => {
		const fetchImpl = vi.fn(async () => ok({ captcha_enabled: false }));
		expect(await fetchCaptchaConfig(APP, { fetchImpl })).toBeNull();
	});

	it('returns null for a provider this flow has no token for', async () => {
		const fetchImpl = vi.fn(async () => ok({
			captcha_enabled: true,
			captcha_site_key: 't:k',
			enabled_captcha_provider: 'hcaptcha',
		}));
		expect(await fetchCaptchaConfig(APP, { fetchImpl })).toBeNull();
	});

	it('reports a failed read as UNAVAILABLE, never as "no CAPTCHA"', async () => {
		// This is the whole bug: collapsing these two into null is what turned a
		// network blip into "invalid_credentials" at the end of sign-in.
		const httpError = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }));
		expect(await fetchCaptchaConfig(APP, { fetchImpl: httpError })).toBe(CAPTCHA_UNAVAILABLE);

		const threw = vi.fn(async () => { throw new Error('network down'); });
		expect(await fetchCaptchaConfig(APP, { fetchImpl: threw })).toBe(CAPTCHA_UNAVAILABLE);
	});

	it('bounds the read, so a hung config host cannot stall the login form', async () => {
		let seen = null;
		await fetchCaptchaConfig(APP, {
			timeoutMs: 1234,
			fetchImpl: async (_url, init) => { seen = init; return ok({ captcha_enabled: false }); },
		});
		expect(seen.signal).toBeInstanceOf(AbortSignal);
		expect(seen.headers['privy-app-id']).toBe(APP);
	});
});

describe('makeCaptchaResolver', () => {
	it('caches a good answer instead of re-asking on every click', async () => {
		const fetchImpl = vi.fn(async () => ok({ captcha_enabled: false }));
		const resolve = makeCaptchaResolver(APP, { fetchImpl });
		expect(await resolve()).toBeNull();
		expect(await resolve()).toBeNull();
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it('retries once at the moment of use after a failed page-load probe', async () => {
		// Without this, one blip during page load broke sign-in for the entire
		// page view, and the visitor's only fix was a reload nobody suggested.
		let calls = 0;
		const fetchImpl = vi.fn(async () => {
			calls += 1;
			if (calls === 1) throw new Error('network down');
			return ok({ captcha_enabled: true, captcha_site_key: 't:k' });
		});
		const resolve = makeCaptchaResolver(APP, { fetchImpl });
		expect(await resolve()).toEqual({ siteKey: 'k', apiUrl: 'https://auth.privy.io' });
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it('still reports UNAVAILABLE when the retry fails too', async () => {
		const fetchImpl = vi.fn(async () => { throw new Error('still down'); });
		const resolve = makeCaptchaResolver(APP, { fetchImpl });
		expect(await resolve()).toBe(CAPTCHA_UNAVAILABLE);
	});
});

describe('captchaRequirement', () => {
	it('maps each outcome to the action the sign-in flow should take', () => {
		expect(captchaRequirement({ siteKey: 'k' })).toBe('required');
		expect(captchaRequirement(null)).toBe('none');
		expect(captchaRequirement(CAPTCHA_UNAVAILABLE)).toBe('unknown');
	});
});

describe('signInMessage', () => {
	it('never leaves the visitor with a raw invalid_credentials', () => {
		const msg = signInMessage(new Error('Request failed: invalid_credentials'), 'fallback');
		expect(msg).not.toMatch(/invalid_credentials/);
		expect(msg).toMatch(/human-verification|try again/i);
	});

	it('names a timeout as a timeout', () => {
		const err = new Error('signal timed out');
		err.name = 'TimeoutError';
		expect(signInMessage(err, 'fallback')).toMatch(/did not respond in time/);
	});

	it('passes a real, readable error through untouched', () => {
		expect(signInMessage(new Error('Enter the code from your email.'), 'fallback'))
			.toBe('Enter the code from your email.');
	});

	it('falls back when the error says nothing at all', () => {
		expect(signInMessage(new Error(''), 'Wallet sign-in failed.')).toBe('Wallet sign-in failed.');
		expect(signInMessage(undefined, 'Wallet sign-in failed.')).toBe('Wallet sign-in failed.');
	});

	it('offers a sentence for the unknown-requirement case, not a symbol', () => {
		expect(CAPTCHA_UNKNOWN_MESSAGE).toMatch(/CAPTCHA/);
		expect(CAPTCHA_UNKNOWN_MESSAGE).toMatch(/try again/i);
	});
});
