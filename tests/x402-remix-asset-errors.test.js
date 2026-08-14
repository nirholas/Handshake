// /api/x402/remix-asset: the paid remix endpoint's rejection path.
//
// Regression cover for a live defect: the handler caught its own RemixError and
// wrote the 4xx to `res` itself. paidEndpoint treats a handler that flushed the
// response as a delivered-but-unsettled good: it logged a payment_unsettled_flush
// leak event, recorded a FAILED payment metric, and threw. So every ordinary
// validation refusal (empty instruction, unknown source, source not remixable)
// showed up in x402 telemetry as a money leak.
//
// The contract paidEndpoint actually wants is a thrown Error carrying .status +
// .code, which it maps to a clean error response with settlement skipped. These
// tests pin that: the handler throws and never touches `res`.

import { describe, it, expect, vi } from 'vitest';

const getRemixSource = vi.fn();
const generate = vi.fn();

vi.mock('../api/_lib/x402-paid-endpoint.js', () => ({ paidEndpoint: (cfg) => cfg }));
vi.mock('../api/_lib/x402-spec.js', () => ({ buildBazaarSchema: () => ({}) }));
vi.mock('../api/_lib/x402/bazaar-helpers.js', () => ({ withService: (x) => x }));
vi.mock('../api/_lib/forge-store.js', () => ({ getRemixSource, linkRefinement: vi.fn() }));
vi.mock('../api/_lib/remix-settlement.js', () => ({ settleRemixRoyalty: vi.fn() }));
vi.mock('../api/_lib/streaks.js', () => ({ unlockBadge: vi.fn(), BADGES: { FIRST_REMIX_RECEIVED: 'first_remix' } }));
vi.mock('../api/_lib/feed.js', () => ({ publishUserEvent: vi.fn() }));
vi.mock('../api/_mcp-studio/forge-client.js', () => ({
	generate,
	originFromReq: () => 'https://three.ws',
	viewerUrl: (base, url) => `${base}/view?src=${url}`,
}));

const spec = (await import('../api/x402/remix-asset.js')).default;

// A res that fails the test loudly if the handler ever writes to it: writing is
// exactly the behaviour this file exists to prevent.
function forbiddenRes() {
	const boom = () => {
		throw new Error('handler wrote to res; it must throw so paidEndpoint can skip settlement');
	};
	return { setHeader: boom, end: boom, writeHead: boom, status: boom, json: boom };
}

function call(body) {
	return spec.handler({
		req: { method: 'POST', headers: { host: 'three.ws', 'content-type': 'application/json' }, body },
		res: forbiddenRes(),
		requirement: { amount: '250000', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' },
		payer: null,
	});
}

describe('remix-asset rejections throw instead of flushing the response', () => {
	it('rejects a missing source_creation_id with 400', async () => {
		await expect(call({ instruction: 'make it metallic' })).rejects.toMatchObject({
			status: 400,
			code: 'missing_source',
		});
	});

	it('rejects a missing instruction with 400', async () => {
		await expect(call({ source_creation_id: 'abc' })).rejects.toMatchObject({
			status: 400,
			code: 'missing_instruction',
		});
	});

	it('rejects an over-long instruction with 400', async () => {
		await expect(
			call({ source_creation_id: 'abc', instruction: 'x'.repeat(501) }),
		).rejects.toMatchObject({ status: 400, code: 'instruction_too_long' });
	});

	it('rejects an unknown source with 404 and never starts a generation', async () => {
		getRemixSource.mockResolvedValueOnce(null);
		await expect(call({ source_creation_id: 'nope', instruction: 'shinier' })).rejects.toMatchObject({
			status: 404,
			code: 'source_not_found',
		});
		expect(generate).not.toHaveBeenCalled();
	});

	it('rejects a source that is not published as remixable with 403', async () => {
		getRemixSource.mockResolvedValueOnce({ id: 'abc', remixable: false, royaltyBps: 1000 });
		await expect(call({ source_creation_id: 'abc', instruction: 'shinier' })).rejects.toMatchObject({
			status: 403,
			code: 'not_remixable',
		});
		expect(generate).not.toHaveBeenCalled();
	});
});
