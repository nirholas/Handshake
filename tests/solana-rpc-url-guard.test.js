import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
	isHttpUrl,
	normalizeRpcUrl,
	normalizeWsUrl,
	resolveWsEndpoint,
	solanaRpcEndpoints,
} from '../api/_lib/solana/connection.js';
import { RpcFallback, rpcFallbackFromEnv } from '../api/_lib/solana/rpc-fallback.js';

// Regression guard for the production 500 storm on /api/pump/curve and
// /api/pump/safety:
//   TypeError: Endpoint URL must start with `http:` or `https:`.
//       at assertEndpointUrl ... at new Connection ...
//       at RpcFallback.getConnection ... / at solanaConnection ...
// A malformed SOLANA_RPC_URL (scheme-less host, ws:// URL, quoted value) was pinned
// first in the endpoint list and handed straight to `new Connection`, which rejects
// anything that isn't http(s). Every URL must now be repaired or filtered out before
// it can reach the constructor.

describe('isHttpUrl', () => {
	it('accepts http(s) URLs only', () => {
		expect(isHttpUrl('https://mainnet.helius-rpc.com/?api-key=x')).toBe(true);
		expect(isHttpUrl('http://localhost:8899')).toBe(true);
	});
	it('rejects ws/wss, scheme-less, empty and non-string values', () => {
		expect(isHttpUrl('wss://mainnet.helius-rpc.com')).toBe(false);
		expect(isHttpUrl('mainnet.helius-rpc.com')).toBe(false);
		expect(isHttpUrl('')).toBe(false);
		expect(isHttpUrl(null)).toBe(false);
		expect(isHttpUrl(undefined)).toBe(false);
		expect(isHttpUrl(12345)).toBe(false);
	});
});

describe('normalizeRpcUrl — repairs the malformed env shapes that 500ed new Connection', () => {
	it('prepends https:// to a scheme-less host', () => {
		expect(normalizeRpcUrl('mainnet.helius-rpc.com/?api-key=abc')).toBe(
			'https://mainnet.helius-rpc.com/?api-key=abc',
		);
	});
	it('maps a websocket URL to its http(s) form', () => {
		expect(normalizeRpcUrl('wss://solana-rpc.publicnode.com')).toBe('https://solana-rpc.publicnode.com');
		expect(normalizeRpcUrl('ws://localhost:8900')).toBe('http://localhost:8900');
	});
	it('strips a single pair of surrounding quotes', () => {
		expect(normalizeRpcUrl('"https://api.mainnet-beta.solana.com"')).toBe('https://api.mainnet-beta.solana.com');
		expect(normalizeRpcUrl("'https://api.mainnet-beta.solana.com'")).toBe('https://api.mainnet-beta.solana.com');
	});
	it('repairs the Helius REST host into the JSON-RPC host', () => {
		expect(normalizeRpcUrl('https://api-mainnet.helius-rpc.com/?api-key=k')).toMatch(
			/^https:\/\/mainnet\.helius-rpc\.com\//,
		);
	});
	it('returns an already-clean URL unchanged (no trailing-slash churn)', () => {
		expect(normalizeRpcUrl('https://api.mainnet-beta.solana.com')).toBe('https://api.mainnet-beta.solana.com');
	});
	it('returns "" for empty or unsalvageable values', () => {
		expect(normalizeRpcUrl('')).toBe('');
		expect(normalizeRpcUrl('   ')).toBe('');
		expect(normalizeRpcUrl(null)).toBe('');
		expect(normalizeRpcUrl('https://has a space.com')).toBe('');
		expect(normalizeRpcUrl('ftp://example.com')).toBe('');
	});
});

describe('solanaRpcEndpoints — every entry is Connection-safe', () => {
	const saved = {};
	const keys = ['SOLANA_RPC_URL', 'SOLANA_RPC_URL_DEVNET', 'SOLANA_RPC_FALLBACK_URLS', 'HELIUS_API_KEY', 'ALCHEMY_API_KEY'];
	beforeEach(() => {
		for (const k of keys) saved[k] = process.env[k];
		for (const k of keys) delete process.env[k];
	});
	afterEach(() => {
		for (const k of keys) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
	});

	it('repairs a scheme-less primary and pins it first', () => {
		process.env.SOLANA_RPC_URL = 'mainnet.helius-rpc.com/?api-key=test';
		const eps = solanaRpcEndpoints('mainnet');
		expect(eps[0]).toBe('https://mainnet.helius-rpc.com/?api-key=test');
		expect(eps.every(isHttpUrl)).toBe(true);
	});

	it('drops an unsalvageable primary and falls back to a public node', () => {
		process.env.SOLANA_RPC_URL = 'this is not a url at all';
		const eps = solanaRpcEndpoints('mainnet');
		expect(eps.length).toBeGreaterThan(0);
		expect(eps.every(isHttpUrl)).toBe(true);
		expect(eps).toContain('https://api.mainnet-beta.solana.com');
	});

	it('filters malformed operator fallbacks out of the list', () => {
		process.env.SOLANA_RPC_FALLBACK_URLS = 'wss://good.example.com, , garbage value, https://fine.example.com';
		const eps = solanaRpcEndpoints('mainnet');
		expect(eps.every(isHttpUrl)).toBe(true);
		expect(eps).toContain('https://good.example.com'); // wss repaired
		expect(eps).toContain('https://fine.example.com');
		expect(eps).not.toContain('garbage value');
	});

	it('never returns an empty list even with no env configured', () => {
		const eps = solanaRpcEndpoints('mainnet');
		expect(eps.length).toBeGreaterThan(0);
		expect(eps.every(isHttpUrl)).toBe(true);
	});
});

describe('RpcFallback — never hands new Connection a non-http(s) URL', () => {
	const saved = {};
	const keys = ['SOLANA_RPC_URL', 'HELIUS_API_KEY', 'ALCHEMY_API_KEY', 'SOLANA_RPC_FALLBACK_URLS'];
	beforeEach(() => {
		for (const k of keys) saved[k] = process.env[k];
		for (const k of keys) delete process.env[k];
	});
	afterEach(() => {
		for (const k of keys) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
	});

	it('repairs a bad primary and getConnection() succeeds', () => {
		const rpc = new RpcFallback({ url: 'wss://solana-rpc.publicnode.com', fallbackUrls: [] });
		expect(rpc.currentUrl).toBe('https://solana-rpc.publicnode.com');
		// The real prod crash was here — must not throw.
		expect(() => rpc.getConnection()).not.toThrow();
	});

	it('keeps only http(s) endpoints and dedupes while preserving order', () => {
		const rpc = new RpcFallback({
			url: 'garbage',
			fallbackUrls: ['https://a.example.com', 'wss://a.example.com', 'https://b.example.com'],
		});
		// 'garbage' dropped; 'wss://a' repairs to https://a == already present, deduped.
		expect(rpc.urls).toEqual(['https://a.example.com', 'https://b.example.com']);
	});

	it('throws a clear error when no endpoint is salvageable', () => {
		expect(() => new RpcFallback({ url: 'garbage', fallbackUrls: ['also bad', 'ftp://x'] })).toThrow(
			/no valid http\(s\) RPC endpoint/,
		);
	});

	it('rpcFallbackFromEnv tolerates a malformed SOLANA_RPC_URL (prod regression)', () => {
		process.env.SOLANA_RPC_URL = 'mainnet.helius-rpc.com/?api-key=test';
		const rpc = rpcFallbackFromEnv({ network: 'mainnet' });
		expect(rpc.currentUrl).toBe('https://mainnet.helius-rpc.com/?api-key=test');
		expect(() => rpc.getConnection()).not.toThrow();
	});
});

describe('normalizeWsUrl: coerces an env WS endpoint into a ws(s):// URL', () => {
	it('passes through a clean wss URL unchanged', () => {
		expect(normalizeWsUrl('wss://example.quiknode.pro/token')).toBe('wss://example.quiknode.pro/token');
		expect(normalizeWsUrl('ws://localhost:8900')).toBe('ws://localhost:8900');
	});
	it('maps http(s) to its ws(s) form', () => {
		expect(normalizeWsUrl('https://example.quiknode.pro/token')).toBe('wss://example.quiknode.pro/token');
		expect(normalizeWsUrl('http://localhost:8899')).toBe('ws://localhost:8899');
	});
	it('prepends wss:// to a scheme-less host', () => {
		expect(normalizeWsUrl('example.quiknode.pro/token')).toBe('wss://example.quiknode.pro/token');
	});
	it('strips a single pair of surrounding quotes', () => {
		expect(normalizeWsUrl('"wss://example.quiknode.pro/token"')).toBe('wss://example.quiknode.pro/token');
	});
	it('returns "" for empty or unsalvageable values', () => {
		expect(normalizeWsUrl('')).toBe('');
		expect(normalizeWsUrl('   ')).toBe('');
		expect(normalizeWsUrl(null)).toBe('');
		expect(normalizeWsUrl('bareword')).toBe('');
		expect(normalizeWsUrl('ftp://example.com')).toBe('');
	});
});

describe('resolveWsEndpoint: SOLANA_RPC_WS_URL override, derive-from-primary default', () => {
	let saved;
	beforeEach(() => {
		saved = process.env.SOLANA_RPC_WS_URL;
		delete process.env.SOLANA_RPC_WS_URL;
	});
	afterEach(() => {
		if (saved === undefined) delete process.env.SOLANA_RPC_WS_URL;
		else process.env.SOLANA_RPC_WS_URL = saved;
	});

	it('derives the socket from the primary HTTP endpoint when unset', () => {
		expect(resolveWsEndpoint('https://mainnet.helius-rpc.com/?api-key=k', 'mainnet')).toBe(
			'wss://mainnet.helius-rpc.com/?api-key=k',
		);
	});
	it('uses a mainnet SOLANA_RPC_WS_URL override, normalized to wss', () => {
		process.env.SOLANA_RPC_WS_URL = 'https://ded.quiknode.pro/token';
		expect(resolveWsEndpoint('https://mainnet.helius-rpc.com/?api-key=k', 'mainnet')).toBe(
			'wss://ded.quiknode.pro/token',
		);
	});
	it('ignores the override on devnet so a mainnet socket never crosses clusters', () => {
		process.env.SOLANA_RPC_WS_URL = 'wss://ded.quiknode.pro/token';
		expect(resolveWsEndpoint('https://devnet.helius-rpc.com/?api-key=k', 'devnet')).toBe(
			'wss://devnet.helius-rpc.com/?api-key=k',
		);
	});
	it('falls back to deriving when the override is unsalvageable', () => {
		process.env.SOLANA_RPC_WS_URL = 'not a url';
		expect(resolveWsEndpoint('https://mainnet.helius-rpc.com/?api-key=k', 'mainnet')).toBe(
			'wss://mainnet.helius-rpc.com/?api-key=k',
		);
	});
});
