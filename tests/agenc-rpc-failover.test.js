/**
 * /api/agenc/*: RPC lane failover.
 *
 * The AgenC SDK's `createAgenCClient` builds its own Connection from a single
 * URL, so a client made in the handler is bound to exactly one endpoint and has
 * no failover of its own. The handler used to hand it `SOLANA_RPC_URL` and
 * nothing else, which is why every chain-backed AgenC route (list-tasks,
 * get-task, get-agent, link) returned an opaque 500 the moment the configured
 * primary started answering our egress with a hard 403, while eight other
 * healthy lanes in the platform's canonical chain sat unused.
 *
 * `rotateRpc` is the fix, and these tests pin its three rules:
 *   - a lane that fails in a way the NEXT provider may not share (401/403/429/
 *     5xx, timeouts, network blips) is parked and the read is retried onward;
 *   - a real request error, one the chain answers identically everywhere, is
 *     re-thrown on the first lane instead of being replayed down the chain;
 *   - every lane refusing the same read throws RpcChainExhausted, which the
 *     wrapper turns into a 503 + Retry-After rather than a "we are broken" 500.
 *
 * The rotation is exercised directly rather than through the wrapped handler:
 * `withAgenC` lazily imports @three-ws/solana-agent, which vitest.config.js
 * marks external precisely so this module loads without the SDK's dist/ built,
 * and an external module cannot be mocked. `rotateRpc` takes its client factory
 * as an argument, so the whole rotate policy runs here with no RPC, no SDK
 * build, and no network.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api/_lib/db.js', () => ({
	sql: () => Promise.resolve([]),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

vi.mock('../api/_lib/rate-limit.js', () => ({
	clientIp: () => '1.2.3.4',
	limits: { publicIp: async () => ({ success: true, limit: 60, remaining: 59, reset: Date.now() + 1000 }) },
}));

vi.mock('@tetsuo-ai/sdk', () => ({
	getTask: async () => null,
	getTaskLifecycleSummary: async () => null,
	getTasksByCreator: async () => [],
	getAgent: async () => null,
	deriveTaskPda: () => null,
	deriveAgentPda: () => null,
}));

const { rotateRpc, RpcChainExhausted } = await import('../api/agenc/[action].js');

// Endpoints are unique per call so parking one in the process-wide cooldown map
// can never affect a real lane, or a sibling test.
let seq = 0;
function lanes(n) {
	seq += 1;
	return Array.from({ length: n }, (_, i) => `https://lane-${seq}-${i}.agenc-failover.invalid`);
}

/** The shape rotateRpc hands `run`: whatever createClient returned. */
function clientFactory(rpcUrl) {
	return { rpcUrl, cluster: 'mainnet' };
}

beforeEach(() => {
	vi.spyOn(console, 'info').mockImplementation(() => {});
});

describe('rotateRpc', () => {
	it('serves from the first lane without touching the rest', async () => {
		const endpoints = lanes(3);
		const seen = [];
		const out = await rotateRpc({
			cluster: 'mainnet',
			endpoints,
			createClient: clientFactory,
			run: async (c) => {
				seen.push(c.rpcUrl);
				return { ok: true, via: c.rpcUrl };
			},
		});
		expect(out).toEqual({ ok: true, via: endpoints[0] });
		expect(seen).toEqual([endpoints[0]]);
	});

	it('rotates past a 403 lane and serves from the next one', async () => {
		const endpoints = lanes(3);
		const seen = [];
		const out = await rotateRpc({
			cluster: 'mainnet',
			endpoints,
			createClient: clientFactory,
			run: async (c) => {
				seen.push(c.rpcUrl);
				if (c.rpcUrl === endpoints[0]) {
					throw new Error('403 Forbidden: {"jsonrpc":"2.0","error":{"code": 403, "message":"Your IP or provider is blocked from this endpoint"}}');
				}
				return { ok: true, via: c.rpcUrl };
			},
		});
		expect(out).toEqual({ ok: true, via: endpoints[1] });
		expect(seen).toEqual([endpoints[0], endpoints[1]]);
	});

	it('rotates past a quota-exhausted 429 lane', async () => {
		const endpoints = lanes(2);
		const out = await rotateRpc({
			cluster: 'mainnet',
			endpoints,
			createClient: clientFactory,
			run: async (c) => {
				if (c.rpcUrl === endpoints[0]) throw new Error('429 Too Many Requests: max usage reached');
				return 'served';
			},
		});
		expect(out).toBe('served');
	});

	it('skips a lane whose client cannot even be constructed', async () => {
		const endpoints = lanes(2);
		const out = await rotateRpc({
			cluster: 'mainnet',
			endpoints,
			createClient: (rpcUrl) => {
				if (rpcUrl === endpoints[0]) throw new Error('Endpoint URL must start with `http:` or `https:`.');
				return clientFactory(rpcUrl);
			},
			run: async (c) => c.rpcUrl,
		});
		expect(out).toBe(endpoints[1]);
	});

	it('re-throws a real request error on the first lane instead of replaying it', async () => {
		const endpoints = lanes(4);
		const seen = [];
		await expect(
			rotateRpc({
				cluster: 'mainnet',
				endpoints,
				createClient: clientFactory,
				run: async (c) => {
					seen.push(c.rpcUrl);
					throw new Error('Invalid account discriminator');
				},
			}),
		).rejects.toThrow('Invalid account discriminator');
		expect(seen).toEqual([endpoints[0]]);
	});

	it('throws RpcChainExhausted with the cluster and lane count when every lane refuses', async () => {
		const endpoints = lanes(3);
		const seen = [];
		let thrown = null;
		try {
			await rotateRpc({
				cluster: 'devnet',
				endpoints,
				createClient: clientFactory,
				run: async (c) => {
					seen.push(c.rpcUrl);
					throw new Error('503 Service Unavailable');
				},
			});
		} catch (err) {
			thrown = err;
		}
		expect(thrown).toBeInstanceOf(RpcChainExhausted);
		expect(thrown.cluster).toBe('devnet');
		expect(thrown.tried).toBe(3);
		expect(thrown.message).toContain('503 Service Unavailable');
		expect(seen).toEqual(endpoints);
	});

	// The failure mode the other cases could not see: a lane that accepts the
	// connection and then answers nothing. `createAgenCClient` builds a plain
	// `new Connection(rpcUrl)`, which never gets the rotating fetch's own
	// per-attempt bound, so undici's defaults let a stalled provider hold the
	// request for minutes with nothing thrown to rotate on. list-tasks surfaced it
	// first because getTasksByCreator is a getProgramAccounts memcmp scan.
	it('rotates past a lane that hangs instead of answering', async () => {
		vi.useFakeTimers();
		try {
			const endpoints = lanes(2);
			const seen = [];
			const pending = rotateRpc({
				cluster: 'mainnet',
				endpoints,
				createClient: clientFactory,
				run: async (c) => {
					seen.push(c.rpcUrl);
					// The first lane never settles, exactly like a provider that swallows
					// a heavy getProgramAccounts scan.
					if (c.rpcUrl === endpoints[0]) return new Promise(() => {});
					return { ok: true, via: c.rpcUrl };
				},
			});
			await vi.advanceTimersByTimeAsync(10_000);
			await expect(pending).resolves.toEqual({ ok: true, via: endpoints[1] });
			expect(seen).toEqual([endpoints[0], endpoints[1]]);
		} finally {
			vi.useRealTimers();
		}
	});

	it('does not leave the attempt timer pending when a lane answers in time', async () => {
		vi.useFakeTimers();
		try {
			const endpoints = lanes(2);
			const out = await rotateRpc({
				cluster: 'mainnet',
				endpoints,
				createClient: clientFactory,
				run: async (c) => ({ ok: true, via: c.rpcUrl }),
			});
			expect(out).toEqual({ ok: true, via: endpoints[0] });
			// A won race must clear its timer, or every served request leaves one
			// armed behind the response.
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it('exhausts the chain when every lane hangs', async () => {
		vi.useFakeTimers();
		try {
			const endpoints = lanes(3);
			const pending = rotateRpc({
				cluster: 'mainnet',
				endpoints,
				createClient: clientFactory,
				run: async () => new Promise(() => {}),
			}).catch((err) => err);
			await vi.advanceTimersByTimeAsync(10_000 * 3);
			const thrown = await pending;
			expect(thrown).toBeInstanceOf(RpcChainExhausted);
			expect(thrown.tried).toBe(3);
			expect(thrown.message).toContain('timed out');
		} finally {
			vi.useRealTimers();
		}
	});
});
