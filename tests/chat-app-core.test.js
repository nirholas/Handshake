// Core-path coverage for the chat/ app (three.ws/chat).
//
// chat/ is a Svelte SPA, so most of it is only exercised in a browser. These
// are the pure, load-bearing modules underneath it: the model-selection layer
// the composer opens on, the tool-call argument codec every provider reply goes
// through, the fund-moving-tool gate that decides whether a wallet call is
// preflighted through GuardChain, the credential auth the sign-in form posts,
// and the retired-marketing-route resolver that keeps old /chat links alive.
//
// Nothing here is stubbed except the browser globals the modules read at import
// time (localStorage) and the one network call each auth helper makes.
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';

// chat/src/stores.js persists settings through localStorage at module scope, so
// the shim has to exist before providers.js is imported.
beforeAll(() => {
	if (typeof globalThis.localStorage === 'undefined') {
		const mem = new Map();
		globalThis.localStorage = {
			getItem: (k) => (mem.has(k) ? mem.get(k) : null),
			setItem: (k, v) => void mem.set(k, String(v)),
			removeItem: (k) => void mem.delete(k),
			clear: () => mem.clear(),
		};
	}
});

describe('chat/src/three-ui/site-routes.js', () => {
	let siteRouteFor;
	beforeAll(async () => {
		({ siteRouteFor } = await import('../chat/src/three-ui/site-routes.js'));
	});

	it('leaves the routes the chat SPA still owns alone', () => {
		for (const route of ['chat', 'signin', 'signup', 'dashboard/revenue', '']) {
			expect(siteRouteFor(route)).toBeNull();
		}
	});

	it('sends every retired marketing route to a real site page', () => {
		expect(siteRouteFor('pricing')).toBe('/pricing');
		expect(siteRouteFor('resources/blog')).toBe('/blog');
		expect(siteRouteFor('resources/updates')).toBe('/changelog');
		expect(siteRouteFor('resources/use-cases')).toBe('/features');
		expect(siteRouteFor('resources/trust-center')).toBe('/docs/security');
		expect(siteRouteFor('business/security')).toBe('/docs/security');
		expect(siteRouteFor('business/contact-sales')).toBe('/support');
		expect(siteRouteFor('business/enterprise')).toBe('/features');
		expect(siteRouteFor('solutions/sales')).toBe('/features');
		expect(siteRouteFor('features/web-app')).toBe('/features');
		expect(siteRouteFor('events/webinars')).toBe('/community');
	});

	it('carries a docs slug through to the real docs page', () => {
		expect(siteRouteFor('resources/docs')).toBe('/docs');
		expect(siteRouteFor('resources/docs/quick-start')).toBe('/docs/quick-start');
		expect(siteRouteFor('resources/docs/x402')).toBe('/docs/x402');
	});

	it('refuses to build a path out of a hostile slug', () => {
		// A slug that is not a plain doc name must not become part of the URL.
		expect(siteRouteFor('resources/docs/../../etc/passwd')).toBe('/docs');
		expect(siteRouteFor('resources/docs/Evil%20Thing')).toBe('/docs');
		expect(siteRouteFor('resources/docs/a b')).toBe('/docs');
	});

	it('normalizes stray slashes and non-strings', () => {
		expect(siteRouteFor('/pricing')).toBe('/pricing');
		expect(siteRouteFor('pricing/')).toBe('/pricing');
		expect(siteRouteFor(null)).toBeNull();
		expect(siteRouteFor(undefined)).toBeNull();
		expect(siteRouteFor(42)).toBeNull();
	});

	it('never points at a page the site does not publish', async () => {
		const { readFile } = await import('node:fs/promises');
		const features = JSON.parse(
			await readFile(new URL('../public/features.json', import.meta.url), 'utf8')
		);
		const published = new Set(features.sections.flatMap((s) => s.pages.map((p) => p.path)));
		const targets = [
			siteRouteFor('pricing'),
			siteRouteFor('resources/blog'),
			siteRouteFor('resources/updates'),
			siteRouteFor('resources/docs'),
			siteRouteFor('resources/use-cases'),
			siteRouteFor('resources/trust-center'),
			siteRouteFor('business/contact-sales'),
			siteRouteFor('features/web-app'),
			siteRouteFor('events/webinars'),
		];
		for (const target of targets) {
			expect(published.has(target), `${target} is not declared in data/pages.json`).toBe(true);
		}
	});
});

describe('chat/src/util.js tool-call argument codec', () => {
	let parseToolCallArguments, serializeToolCallArguments;
	beforeAll(async () => {
		({ parseToolCallArguments, serializeToolCallArguments } = await import('../chat/src/util.js'));
	});

	it('passes an already-parsed arguments object straight through', () => {
		const args = { prompt: 'a brass owl' };
		expect(parseToolCallArguments(args)).toBe(args);
	});

	it('treats an absent payload as no arguments', () => {
		expect(parseToolCallArguments(null)).toEqual({});
		expect(parseToolCallArguments(undefined)).toEqual({});
		expect(parseToolCallArguments('')).toEqual({});
		expect(parseToolCallArguments('   ')).toEqual({});
	});

	it('decodes a JSON string, including one a model wrapped in a code fence', () => {
		expect(parseToolCallArguments('{"limit":5}')).toEqual({ limit: 5 });
		expect(parseToolCallArguments('```json\n{"limit":5}\n```')).toEqual({ limit: 5 });
	});

	it('rejects a bare scalar and keeps the payload for diagnostics', () => {
		expect(() => parseToolCallArguments('"just a string"')).toThrow();
		try {
			parseToolCallArguments('{not json');
			throw new Error('should have thrown');
		} catch (err) {
			expect(err.payload).toBe('{not json');
		}
	});

	it('round-trips without double-encoding a value that is already a string', () => {
		expect(serializeToolCallArguments({ a: 1 })).toBe('{"a":1}');
		expect(serializeToolCallArguments('{"a":1}')).toBe('{"a":1}');
		expect(serializeToolCallArguments(undefined)).toBe('{}');
		expect(parseToolCallArguments(serializeToolCallArguments({ a: 1 }))).toEqual({ a: 1 });
	});
});

describe('chat/src/guard.js fund-moving tool gate', () => {
	let isFundMovingTool;
	beforeAll(async () => {
		({ isFundMovingTool } = await import('../chat/src/guard.js'));
	});

	it('flags every tool that moves value out of the connected wallet', () => {
		for (const name of [
			'solana_transfer',
			'solana_swap',
			'evm_transfer',
			'evm_swap',
			'pumpfunBuy',
			'pumpfunSell',
			'pumpfunSellAll',
			'LaunchPumpToken',
			'MintScene',
			'agentPaymentsDistribute',
			'agentPaymentsWithdraw',
		]) {
			expect(isFundMovingTool(name), `${name} must be preflighted`).toBe(true);
		}
	});

	it('leaves read-only tools out of the preflight path', () => {
		for (const name of ['ForgeTextTo3D', 'ForgeAvatar', 'pumpfunKingOfTheHill', undefined, '']) {
			expect(isFundMovingTool(name)).toBe(false);
		}
	});
});

describe('chat/src/providers.js model selection', () => {
	let resolveDefaultModel, headersForFetch, hasCompanyLogo, BUILTIN_MODELS;
	beforeAll(async () => {
		({ resolveDefaultModel, headersForFetch, hasCompanyLogo, BUILTIN_MODELS } = await import(
			'../chat/src/providers.js'
		));
	});

	it('opens on the configured default when the server still serves it', () => {
		const live = [{ id: 'a/one' }, { id: 'b/two' }];
		expect(resolveDefaultModel(live, 'b/two')).toEqual({ id: 'b/two' });
	});

	it('falls back to a live model when the configured default was retired', () => {
		// This is the rung that keeps chat working through an OpenRouter free
		// endpoint retirement without a redeploy.
		const live = [{ id: 'a/one' }, { id: 'b/two' }];
		expect(resolveDefaultModel(live, 'gone/model')).toEqual({ id: 'a/one' });
	});

	it('falls back to the local seed only when the server returned nothing', () => {
		expect(resolveDefaultModel([], 'gone/model')).toBe(BUILTIN_MODELS[0]);
		expect(resolveDefaultModel(null, null)).toBe(BUILTIN_MODELS[0]);
	});

	it('sends each provider the auth header it actually expects', () => {
		const key = () => 'test-key';
		const openrouter = headersForFetch({ name: 'OpenRouter', apiKeyFn: key });
		expect(openrouter.Authorization).toBe('Bearer test-key');
		expect(openrouter['HTTP-Referer']).toBe('https://three.ws');

		const anthropic = headersForFetch({ name: 'Anthropic', apiKeyFn: key }, { kind: 'reasoner' });
		expect(anthropic['x-api-key']).toBe('test-key');
		expect(anthropic.Authorization).toBeUndefined();
		expect(anthropic['anthropic-version']).toBe('2023-06-01');
		expect(anthropic['anthropic-beta']).toBe('output-128k-2025-02-19');

		// A non-reasoner Anthropic call must not ask for the extended output beta.
		expect(
			headersForFetch({ name: 'Anthropic', apiKeyFn: key }, { kind: 'chat' })['anthropic-beta']
		).toBeUndefined();

		// Ollama is local and keyless: no Authorization header at all.
		expect(headersForFetch({ name: 'Ollama', apiKeyFn: key }).Authorization).toBeUndefined();
	});

	it('only claims a company logo for models it can actually draw one for', () => {
		expect(hasCompanyLogo({ provider: 'OpenRouter', id: 'anthropic/claude-3.5-sonnet' })).toBe(true);
		expect(hasCompanyLogo({ provider: 'Anthropic', id: 'claude-opus-4-6' })).toBe(true);
		expect(hasCompanyLogo({ provider: 'Built-in', id: 'someone/unknown-model' })).toBe(false);
		expect(hasCompanyLogo(null)).toBeFalsy();
	});
});

describe('chat/src/passwordAuth.js', () => {
	let authErrorMessage, signInWithPassword, registerWithPassword;
	beforeAll(async () => {
		({ authErrorMessage, signInWithPassword, registerWithPassword } = await import(
			'../chat/src/passwordAuth.js'
		));
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('turns each auth-API error code into a sentence a person can act on', () => {
		expect(authErrorMessage(401, { error: 'invalid_credentials' })).toMatch(/not right/);
		expect(authErrorMessage(409, { error: 'conflict' })).toMatch(/already exists/);
		expect(authErrorMessage(400, { error: 'tos_required' })).toMatch(/Terms of Service/);
		expect(authErrorMessage(429, {})).toMatch(/Too many attempts/);
		expect(authErrorMessage(503, {})).toMatch(/unavailable/);
		// A validation failure surfaces the server's own description, never a code.
		expect(
			authErrorMessage(400, { error: 'validation_error', error_description: 'password too short' })
		).toBe('password too short');
	});

	it('posts login credentials same-origin with the session cookie', async () => {
		const calls = [];
		vi.stubGlobal('fetch', async (url, init) => {
			calls.push({ url, init });
			return { ok: true, json: async () => ({ user: { id: 'u1' } }) };
		});
		const user = await signInWithPassword({ email: '  someone@example.com ', password: 'hunter22' });
		expect(user).toEqual({ id: 'u1' });
		expect(calls[0].url).toBe('/api/auth/login');
		expect(calls[0].init.credentials).toBe('include');
		expect(JSON.parse(calls[0].init.body)).toEqual({
			email: 'someone@example.com',
			password: 'hunter22',
		});
	});

	it('always sends the Terms clickwrap the register endpoint requires', async () => {
		const bodies = [];
		vi.stubGlobal('fetch', async (_url, init) => {
			bodies.push(JSON.parse(init.body));
			return { ok: true, json: async () => ({ user: { id: 'u2' } }) };
		});
		await registerWithPassword({
			email: 'new@example.com',
			password: 'hunter22',
			displayName: '  Ada  ',
			tosAccepted: true,
		});
		expect(bodies[0]).toEqual({
			email: 'new@example.com',
			password: 'hunter22',
			tosAccepted: true,
			display_name: 'Ada',
		});

		// An unchecked box is sent as an explicit false, never omitted, so the
		// server refusal is the one the user sees.
		await registerWithPassword({ email: 'a@b.co', password: 'hunter22', tosAccepted: undefined });
		expect(bodies[1].tosAccepted).toBe(false);
		expect(bodies[1].display_name).toBeUndefined();
	});

	it('raises the mapped message when the API refuses', async () => {
		vi.stubGlobal('fetch', async () => ({
			ok: false,
			status: 401,
			json: async () => ({ error: 'invalid_credentials' }),
		}));
		await expect(signInWithPassword({ email: 'a@b.co', password: 'nope' })).rejects.toThrow(
			/not right/
		);
	});
});
