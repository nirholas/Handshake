import { describe, it, expect, vi, beforeEach } from 'vitest';

// The endpoint is pure policy evaluation over the request body; the only
// impure edges are the rate limiter and the env-backed http helpers.
const agentGuardIp = vi.fn();
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: { agentGuardIp: (...a) => agentGuardIp(...a) },
}));
vi.mock('../api/_lib/env.js', () => ({
	env: { APP_ORIGIN: 'http://localhost:3000', ISSUER: 'http://t', MCP_RESOURCE: 'http://t' },
}));
const solUsdPrice = vi.fn();
vi.mock('../api/_lib/avatar-wallet.js', () => ({
	solUsdPrice: (...a) => solUsdPrice(...a),
}));

const { default: guardHandler } = await import('../api/agent/guard.js');

function mkReq({ method = 'POST', url = '/api/agent/guard', headers = {}, body = null } = {}) {
	return {
		method,
		url,
		headers: { ...(body != null ? { 'content-type': 'application/json' } : {}), ...headers },
		socket: { remoteAddress: '127.0.0.1' },
		on(event, cb) {
			if (event === 'data' && body != null) {
				const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
				queueMicrotask(() => {
					cb(buf);
					this._endCb?.();
				});
			} else if (event === 'end') {
				if (body == null) queueMicrotask(() => cb());
				else this._endCb = cb;
			}
		},
		destroy() {},
	};
}
function mkRes() {
	return {
		statusCode: 200,
		headers: {},
		body: undefined,
		writableEnded: false,
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		end(b) {
			this.body = b;
			this.writableEnded = true;
		},
	};
}
const parse = (res) => (res.body ? JSON.parse(res.body) : undefined);

beforeEach(() => {
	agentGuardIp.mockReset().mockResolvedValue({ success: true, limit: 300, remaining: 299, reset: Date.now() + 1000 });
	solUsdPrice.mockReset().mockResolvedValue(200);
});

describe('POST /api/agent/guard', () => {
	it('rejects non-POST', async () => {
		const res = mkRes();
		await guardHandler(mkReq({ method: 'GET' }), res);
		expect(res.statusCode).toBe(405);
	});

	it('400 when no calls are supplied', async () => {
		const res = mkRes();
		await guardHandler(mkReq({ body: {} }), res);
		expect(res.statusCode).toBe(400);
		expect(parse(res).error).toBe('no_calls');
	});

	it('blocks a free-tier transfer above the tier cap at the trade-guard layer', async () => {
		const res = mkRes();
		await guardHandler(
			mkReq({
				body: {
					calls: [{ identifier: 'solana_transfer', apiName: 'solana_transfer', valueUsd: 50_000 }],
				},
			}),
			res,
		);
		expect(res.statusCode).toBe(200);
		const { verdicts } = parse(res);
		expect(verdicts).toHaveLength(1);
		expect(verdicts[0].verdict.decision).toBe('block');
		expect(verdicts[0].verdict.blockedBy).toBe('defi_guard');
	});

	it('reports an unscoped outflow as a critical blind spot when no spend envelope is sent', async () => {
		const res = mkRes();
		await guardHandler(
			mkReq({
				body: { calls: [{ identifier: 'solana_transfer', valueUsd: 500 }] },
			}),
			res,
		);
		const { verdicts } = parse(res);
		const spots = verdicts[0].verdict.blindSpots.map((s) => s.code);
		expect(spots).toContain('SPEND_UNSCOPED');
	});

	it('enforces a caller-supplied spend envelope', async () => {
		const res = mkRes();
		await guardHandler(
			mkReq({
				body: {
					agentId: 'agent-1',
					calls: [{ identifier: 'solana_transfer', valueUsd: 500 }],
					spend: { perTxMaxUsd: 100 },
				},
			}),
			res,
		);
		const { verdicts } = parse(res);
		expect(verdicts[0].verdict.decision).toBe('block');
		expect(verdicts[0].verdict.blockedBy).toBe('spend_guard');
		expect(verdicts[0].verdict.code).toBe('CAP_PER_TX');
	});

	it('clamps oversized slippage on a large swap and requires approval above the ceiling', async () => {
		const res = mkRes();
		await guardHandler(
			mkReq({
				body: {
					userTier: 'pro',
					calls: [
						{
							identifier: 'solana_swap',
							arguments: { inputMint: 'So11111111111111111111111111111111111111112', slippageBps: 300 },
							valueUsd: 20_000,
						},
					],
				},
			}),
			res,
		);
		const { verdicts } = parse(res);
		expect(verdicts[0].verdict.decision).toBe('require_approval');
		expect(verdicts[0].verdict.modifiedArguments).toMatchObject({ slippageBps: 100 });
	});

	it('resolves a SOL notional server-side and blocks a transfer above the tier cap', async () => {
		const res = mkRes();
		await guardHandler(
			mkReq({
				// 250 SOL x $200 = $50,000 > the free-tier $10,000 cap.
				body: {
					calls: [{ identifier: 'solana_transfer', arguments: { recipient: 'abc', amount: 250 } }],
				},
			}),
			res,
		);
		const { verdicts } = parse(res);
		expect(solUsdPrice).toHaveBeenCalled();
		expect(verdicts[0].verdict.decision).toBe('block');
		expect(verdicts[0].verdict.blockedBy).toBe('defi_guard');
	});

	it('leaves the notional unresolved when the price source is down', async () => {
		solUsdPrice.mockRejectedValue(new Error('price unavailable'));
		const res = mkRes();
		await guardHandler(
			mkReq({
				body: {
					calls: [{ identifier: 'solana_transfer', arguments: { recipient: 'abc', amount: 250 } }],
				},
			}),
			res,
		);
		const { verdicts } = parse(res);
		expect(verdicts[0].verdict.decision).not.toBe('block');
		expect(verdicts[0].verdict.blindSpots.some((s) => s.code === 'VALUE_UNRESOLVED')).toBe(true);
	});

	it('flags batched dispatch as bypassing the decorator guards', async () => {
		const res = mkRes();
		await guardHandler(
			mkReq({
				body: { calls: [{ identifier: 'solana_swap', valueUsd: 100, executionPath: 'batch' }] },
			}),
			res,
		);
		const { verdicts } = parse(res);
		expect(verdicts[0].verdict.blindSpots.some((s) => s.code === 'BATCH_BYPASS')).toBe(true);
	});

	it('429s when the limiter says no', async () => {
		agentGuardIp.mockResolvedValue({ success: false, limit: 300, remaining: 0, reset: Date.now() + 1000 });
		const res = mkRes();
		await guardHandler(mkReq({ body: { calls: [{ identifier: 'solana_swap' }] } }), res);
		expect(res.statusCode).toBe(429);
	});
});
