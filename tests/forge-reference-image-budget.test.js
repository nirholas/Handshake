/**
 * The reference-image step (api/_lib/forge-reference-image.js) runs BEFORE the
 * text-to-image ladder on every text prompt and, until now, had no budget: one
 * Vertex call could chain a 60 s request, a 60 s retry-without-size, a 60 s
 * no-image re-roll, a QA score, then the same again as a corrective retry,
 * then the ladder. Measured live on 2026-08-25: text submits hung 95 s+ with
 * the ladder fix already deployed, because this step sits in front of it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.GOOGLE_CLOUD_PROJECT = 'test-project';
delete process.env.VERTEX_IMAGEN_ENABLED;
delete process.env.TEXT_TO_IMAGE_BUDGET_MS;

vi.mock('../api/_lib/gcp-auth.js', () => ({ getGcpAccessToken: async () => 'tok' }));
vi.mock('../api/_lib/redis.js', () => ({ getRedis: () => null }));
vi.mock('../api/_lib/image-persist.js', () => ({ persistImageBase64: async () => 'https://cdn.test/ref.png' }));
vi.mock('../api/_lib/vision.js', () => ({ parseJsonLoose: (t) => JSON.parse(t) }));
vi.mock('../api/forge-enhance.js', () => ({ subjectNegativePrompt: () => 'blurry' }));
vi.mock('../api/_lib/ai-image-lanes.js', () => ({ isProviderRefusal: () => false }));

const ladder = vi.hoisted(() => ({ calls: [] }));
vi.mock('../api/_mcp3d/text-to-image.js', async (importOriginal) => {
	const real = await importOriginal();
	return {
		...real,
		textToImage: async (prompt, opts) => {
			ladder.calls.push(opts);
			return { imageUrl: 'https://cdn.test/ladder.png', model: 'nim/flux' };
		},
	};
});

const { generateReferenceImage } = await import('../api/_lib/forge-reference-image.js');

// Vertex: a fetch that stalls until its abort signal fires (a stalled
// upstream), recording the timeout each request was given.
const vertex = { requests: [] };
globalThis.fetch = vi.fn(
	(url, init) =>
		new Promise((_, reject) => {
			vertex.requests.push(Date.now());
			init?.signal?.addEventListener('abort', () =>
				reject(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })),
			);
		}),
);

beforeEach(() => {
	ladder.calls.length = 0;
	vertex.requests.length = 0;
});

describe('the reference step shares the paint budget', () => {
	it('cuts a stalled Vertex reference request at the leader share and hands the rest to the ladder', async () => {
		const started = Date.now();
		const out = await generateReferenceImage('a low-poly fox', { budgetMs: 5_000 });
		const elapsed = Date.now() - started;
		// Served by the fallthrough, inside the budget, not after minutes.
		expect(out.imageUrl).toBe('https://cdn.test/ladder.png');
		expect(elapsed).toBeLessThan(5_000);
		// Exactly one Vertex request: no retry-without-size, no re-roll, no QA
		// retry once the leader share (60% of 5 s = 3 s) was gone.
		expect(vertex.requests).toHaveLength(1);
		expect(elapsed).toBeGreaterThanOrEqual(2_900);
		// The ladder was handed what was left, never a fresh full budget. The
		// ladder floors its own budget at 5 s, so that is the most it can get
		// here; with a real 60 s budget this is the ~24 s remainder.
		expect(ladder.calls).toHaveLength(1);
		expect(ladder.calls[0].budgetMs).toBeLessThanOrEqual(5_000);
		expect(ladder.calls[0].budgetMs).toBeGreaterThanOrEqual(1_000);
	}, 15_000);

	it('defaults to the shared 60 s ladder budget when the caller passes none', async () => {
		process.env.TEXT_TO_IMAGE_BUDGET_MS = '4000';
		try {
			const started = Date.now();
			await generateReferenceImage('a low-poly fox');
			expect(Date.now() - started).toBeLessThan(4_000);
			expect(vertex.requests).toHaveLength(1);
		} finally {
			delete process.env.TEXT_TO_IMAGE_BUDGET_MS;
		}
	}, 15_000);
});
