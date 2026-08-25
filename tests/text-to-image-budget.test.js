/**
 * The paint ladder (api/_mcp3d/text-to-image.js) shares ONE time budget.
 *
 * Before this, every lane was bounded on its own (Vertex 90s, NIM 60s,
 * Replicate 45s) and the ladder as a whole was not, so a stalled leading lane
 * burned its full window, the next lane burned its own, and the caller's
 * socket was gone before a forge job even existed. Measured live on
 * 2026-08-25: text submits hung 95s+ or took 156s to answer 429, while image
 * submits (no paint step) answered in 3.7s.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.GOOGLE_CLOUD_PROJECT = 'test-project';
process.env.NVIDIA_API_KEY = 'nim-test-key';
delete process.env.REPLICATE_API_TOKEN;
delete process.env.LIVEPEER_FEDERATION_ENABLED;
delete process.env.VERTEX_IMAGEN_FIRST;
delete process.env.TEXT_TO_IMAGE_BUDGET_MS;

// The Vertex lane: configured, and it stalls for exactly the timeout it is
// handed, which is how a stalled upstream presents (the fetch aborts).
const vertex = vi.hoisted(() => ({ calls: [] }));
vi.mock('../api/_mcp3d/vertex-imagen.js', () => ({
	isConfigured: () => true,
	generateImage: (prompt, opts) => {
		vertex.calls.push(opts);
		return new Promise((_, reject) =>
			setTimeout(
				() => reject(Object.assign(new Error(`Vertex AI unreachable: no response in ${opts.timeoutMs}ms`), { code: 'provider_unreachable' })),
				opts.timeoutMs,
			),
		);
	},
}));
vi.mock('../api/_lib/provider-health.js', () => ({
	providersInCooldown: async () => new Set(),
	markProviderCooldown: async () => {},
}));
vi.mock('../api/_lib/forge-scale.js', () => ({
	reserveProviderRateSlot: async () => ({ ok: true, waitMs: 0 }),
	SCALE_LIMITS: { replicateRatePerMin: 6, replicateRateBurst: 1, replicateQueueMaxMs: 1000 },
}));
vi.mock('../api/_lib/image-persist.js', () => ({ persistImageBase64: async () => 'https://cdn.test/img.png' }));
vi.mock('../api/_providers/livepeer.js', () => ({
	livepeerFederationEnabled: () => false,
	livepeerTextToImage: async () => {
		throw new Error('unused');
	},
}));

const { textToImage, laneTimeoutMs, ladderBudgetMs } = await import('../api/_mcp3d/text-to-image.js');

// NIM: a fetch that honours the abort signal (so a lane cap really stops it),
// or fails fast, per test.
let nimMode = 'fail-fast';
globalThis.fetch = vi.fn(
	(url, init) =>
		new Promise((resolve, reject) => {
			if (nimMode === 'fail-fast') return reject(new TypeError('fetch failed'));
			init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
		}),
);

beforeEach(() => {
	vertex.calls.length = 0;
	nimMode = 'fail-fast';
});

describe('lane budget math', () => {
	it('caps a lane that still has a fallback behind it so a stalled leader hands off with time to spare', () => {
		// 60s budget, nothing spent yet: the leader may use 60% of it, not all.
		expect(laneTimeoutMs(90_000, { budgetMs: 60_000, remainingMs: 60_000, laneRemains: true })).toBe(36_000);
		// The last lane standing gets everything that is left.
		expect(laneTimeoutMs(90_000, { budgetMs: 60_000, remainingMs: 60_000, laneRemains: false })).toBe(60_000);
		// Never more than the lane's own ceiling.
		expect(laneTimeoutMs(45_000, { budgetMs: 60_000, remainingMs: 60_000, laneRemains: false })).toBe(45_000);
		// Never more than what is left, even when the floor would say otherwise.
		expect(laneTimeoutMs(90_000, { budgetMs: 60_000, remainingMs: 10_000, laneRemains: true })).toBe(10_000);
		expect(laneTimeoutMs(90_000, { budgetMs: 60_000, remainingMs: 0, laneRemains: true })).toBe(0);
	});

	it('defaults the ladder to 60s and honours the env override and a caller budget', () => {
		expect(ladderBudgetMs()).toBe(60_000);
		process.env.TEXT_TO_IMAGE_BUDGET_MS = '20000';
		expect(ladderBudgetMs()).toBe(20_000);
		expect(ladderBudgetMs(9_000)).toBe(9_000);
		delete process.env.TEXT_TO_IMAGE_BUDGET_MS;
		// A silly budget is floored so no lane is handed a sub-second window.
		expect(ladderBudgetMs(10)).toBe(5_000);
	});
});

describe('the ladder as a whole is bounded', () => {
	it('a stalled Vertex lane is cut at its cap and NIM still gets its turn, all inside the budget', async () => {
		const started = Date.now();
		await expect(textToImage('a fox', { budgetMs: 5_000 })).rejects.toThrow(/fetch failed/);
		const elapsed = Date.now() - started;
		// Vertex was handed 60% of the budget, not its 90s ceiling.
		expect(vertex.calls).toHaveLength(1);
		// (a millisecond or two elapses between the deadline being set and the
		// lane being handed its share, so this is a tight band, not an equality)
		expect(vertex.calls[0].timeoutMs).toBeGreaterThanOrEqual(2_950);
		expect(vertex.calls[0].timeoutMs).toBeLessThanOrEqual(3_000);
		// NIM ran after it (one retry after 1.2s), and the whole thing stayed
		// well inside the budget instead of the old 150s.
		expect(globalThis.fetch).toHaveBeenCalled();
		expect(elapsed).toBeLessThan(5_000 + 1_500);
	}, 15_000);

	it('a stalled NIM lane is cut at what is left of the budget, never its own 60s ceiling', async () => {
		nimMode = 'hang';
		const started = Date.now();
		await expect(textToImage('a fox', { budgetMs: 5_000 })).rejects.toThrow();
		const elapsed = Date.now() - started;
		// Vertex 3s, then NIM gets the ~2s remainder and is aborted there.
		expect(elapsed).toBeGreaterThanOrEqual(4_500);
		expect(elapsed).toBeLessThan(5_000 + 1_500);
	}, 15_000);
});
