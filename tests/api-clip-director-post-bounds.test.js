// POST /api/clip-director is public and unauthenticated, and everything it
// accepts flows into an LLM prompt (api/_lib/clip-director.js directClip, which
// calls llmComplete). The batch-05 API audit found none of those caller strings
// were length-bounded and the body cap was readJson's 1 MB default, so one
// anonymous request could push a megabyte of attacker text through every
// provider rung.
//
// These tests pin the boundary: the body cap, the per-field clamps, and the
// numeric coercion that used to let NaN reach the prompt.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const directClipMock = vi.fn(async () => ({ headline: 'clip', body: 'text' }));
vi.mock('../api/_lib/clip-director.js', () => ({
	directClip: (...a) => directClipMock(...a),
	tradeFromPosition: (row) => ({ fromPosition: true, ...row }),
	SURFACES: new Set(['x', 'telegram', 'feed']),
}));

vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: { publicIp: async () => ({ success: true }) },
	clientIp: () => '203.0.113.44',
}));
vi.mock('../api/_lib/auth.js', () => ({ getSessionUser: async () => null }));
vi.mock('../api/_lib/db.js', () => ({ sql: () => Promise.resolve([]) }));

const { default: handler } = await import('../api/clip-director.js');

function mkReq(rawBody) {
	const buf = Buffer.from(typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody));
	return {
		method: 'POST',
		url: '/api/clip-director',
		headers: { 'content-type': 'application/json', host: 'three.ws' },
		socket: { remoteAddress: '203.0.113.44' },
		on(event, cb) {
			if (event === 'data') {
				queueMicrotask(() => {
					cb(buf);
					this._endCb?.();
				});
			} else if (event === 'end') {
				this._endCb = cb;
			}
		},
	};
}

function mkRes() {
	return {
		statusCode: 200,
		headers: {},
		chunks: [],
		writableEnded: false,
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		writeHead(code) {
			this.statusCode = code;
		},
		write(s) {
			this.chunks.push(String(s));
			return true;
		},
		end(b) {
			if (b) this.chunks.push(String(b));
			this.writableEnded = true;
		},
		get json() {
			return JSON.parse(this.chunks.join(''));
		},
	};
}

async function post(body) {
	const res = mkRes();
	await handler(mkReq(body), res);
	return res;
}

beforeEach(() => {
	vi.clearAllMocks();
	directClipMock.mockResolvedValue({ headline: 'clip', body: 'text' });
});

describe('POST /api/clip-director input bounds', () => {
	it('rejects a body over the 8 KB cap instead of forwarding it to a provider', async () => {
		const res = await post({ trade: { symbol: 'X' }, agent_name: 'a'.repeat(20_000) });
		expect(res.statusCode).toBe(413);
		expect(res.json.error).toBe('body_too_large');
		expect(directClipMock).not.toHaveBeenCalled();
	});

	it('clamps the caller-supplied agent name and avatar style', async () => {
		const res = await post({
			trade: { symbol: 'SOL', realized_pnl_sol: 1.5 },
			agent_name: 'N'.repeat(500),
			avatar_style: 'S'.repeat(500),
		});
		expect(res.statusCode).toBe(200);
		const arg = directClipMock.mock.calls[0][0];
		expect(arg.agentName).toHaveLength(80);
		expect(arg.avatarStyle).toHaveLength(40);
	});

	it('clamps every free-text field inside the trade object', async () => {
		const res = await post({
			trade: {
				mint: 'm'.repeat(500),
				symbol: 's'.repeat(500),
				name: 'n'.repeat(500),
				exit_reason: 'r'.repeat(500),
				sell_sig: 'g'.repeat(500),
				realized_pnl_sol: -2,
			},
		});
		expect(res.statusCode).toBe(200);
		const { trade } = directClipMock.mock.calls[0][0];
		expect(trade.mint).toHaveLength(64);
		expect(trade.symbol).toHaveLength(32);
		expect(trade.name).toHaveLength(80);
		expect(trade.exit_reason).toHaveLength(40);
		expect(trade.sell_sig).toHaveLength(100);
		// An honest loss still shapes a clip, it is not filtered out.
		expect(trade.is_win).toBe(false);
	});

	it('drops non-finite numbers rather than passing NaN into the prompt', async () => {
		const res = await post({
			trade: { symbol: 'SOL', multiple: 'not-a-number', pnl_pct: 'abc', entry_sol: '1e400' },
		});
		expect(res.statusCode).toBe(200);
		const { trade } = directClipMock.mock.calls[0][0];
		expect(trade.multiple).toBeNull();
		expect(trade.pnl_pct).toBeNull();
		expect(trade.entry_sol).toBeNull();
	});

	it('normalizes a hostile copied_by_count to a sane non-negative integer', async () => {
		for (const [input, expected] of [
			[-50, 0],
			[1e30, 1e9],
			['12.9', 12],
			['abc', 0],
		]) {
			directClipMock.mockClear();
			const res = await post({ trade: { symbol: 'SOL' }, copied_by_count: input });
			expect(res.statusCode).toBe(200);
			expect(directClipMock.mock.calls[0][0].copiedByCount).toBe(expected);
		}
	});

	it('rejects an array where a trade object belongs', async () => {
		const res = await post({ trade: [1, 2, 3] });
		expect(res.statusCode).toBe(400);
		expect(res.json.error).toBe('invalid_trade');
		expect(directClipMock).not.toHaveBeenCalled();
	});

	it('rejects malformed JSON with a 400, not a stack trace', async () => {
		const res = await post('{not json');
		expect(res.statusCode).toBe(400);
		expect(res.json.error).toBe('invalid_json');
		expect(directClipMock).not.toHaveBeenCalled();
	});
});
