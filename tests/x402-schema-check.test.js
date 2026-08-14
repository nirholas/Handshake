// /api/x402/schema-check: the paid JSON-API conformance checker.
//
// Regression cover for a live defect: the handler took its request positionally
// (`async handler(req)`), but paidEndpoint calls it with a CONTEXT object
// ({ req, res, requirement, payer }). The body was therefore read off the
// context, never found, and every paid call settled and answered
// `unsupported api "undefined"`. These tests drive the real spec.handler with
// the shape paidEndpoint actually passes.
//
// paidEndpoint is stubbed to the identity so the default export IS the spec and
// the handler can be called directly without a payment rail (same pattern as
// tests/x402-pump-launch-listing.test.js).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../api/_lib/x402-paid-endpoint.js', () => ({ paidEndpoint: (cfg) => cfg }));
vi.mock('../api/_lib/x402-spec.js', () => ({ buildBazaarSchema: () => ({}) }));
vi.mock('../api/_lib/x402/bazaar-helpers.js', () => ({ withService: (x) => x }));

const spec = (await import('../api/x402/schema-check.js')).default;

const FEED = {
	generated_at: '2026-08-14T00:00:00.000Z',
	site: { name: 'three.ws', url: 'https://three.ws' },
	entries: [
		{ date: '2026-08-14', title: 'A change', summary: 'What shipped.', tags: ['feature'] },
	],
};

function ctx(body) {
	return { req: { method: 'POST', headers: {}, body }, res: {}, requirement: null, payer: null };
}

let fetchSpy;
afterEach(() => {
	fetchSpy?.mockRestore();
	fetchSpy = undefined;
});

describe('schema-check handler: happy path', () => {
	beforeEach(() => {
		fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => FEED,
		});
	});

	it('reads the body from the paidEndpoint context and validates the feed', async () => {
		const out = await spec.handler(ctx({ api: 'changelog_json' }));
		expect(out).toMatchObject({
			ok: true,
			api: 'changelog_json',
			valid: true,
			version: '2026-08-14',
			entry_count: 1,
			schema_errors: [],
		});
		expect(typeof out.fetched_at).toBe('string');
		expect(fetchSpy).toHaveBeenCalledOnce();
		expect(String(fetchSpy.mock.calls[0][0])).toMatch(/\/changelog\.json$/);
	});

	it('reports the exact schema violations when the feed breaks', async () => {
		fetchSpy.mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ ...FEED, site: { name: 'three.ws' }, entries: [] }),
		});
		const out = await spec.handler(ctx({ api: 'changelog_json' }));
		expect(out.ok).toBe(true);
		expect(out.valid).toBe(false);
		expect(out.schema_errors).toContain('missing or invalid site.url');
		expect(out.schema_errors).toContain('entries array is empty');
	});

	it('turns a dead feed into a finding rather than a throw', async () => {
		fetchSpy.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
		const out = await spec.handler(ctx({ api: 'changelog_json' }));
		expect(out).toMatchObject({ ok: false, valid: false, entry_count: 0, schema_errors: ['http_503'] });
	});
});

describe('schema-check handler: rejected before settlement', () => {
	beforeEach(() => {
		fetchSpy = vi.spyOn(globalThis, 'fetch');
	});

	it('throws a 400 for an unsupported api instead of billing for an error body', async () => {
		await expect(spec.handler(ctx({ api: 'not_a_feed' }))).rejects.toMatchObject({
			status: 400,
			code: 'unsupported_api',
		});
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('throws a 400 when the body carries no api at all', async () => {
		await expect(spec.handler(ctx({}))).rejects.toMatchObject({ status: 400, code: 'unsupported_api' });
	});

	it('does not treat an inherited Object property as a checker', async () => {
		await expect(spec.handler(ctx({ api: 'constructor' }))).rejects.toMatchObject({
			status: 400,
			code: 'unsupported_api',
		});
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});
