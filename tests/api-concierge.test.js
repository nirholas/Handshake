// POST /api/concierge, the embeddable widget's answer engine. Covers: CORS is
// any-origin (the whole point of the route), method/body validation, its own
// rate buckets, fail-open moderation with an in-band refusal, provider
// fallover with cooldown marking on billing/auth failures, and the SSE
// chunk→done stream a healthy rung produces.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const conciergeIpMock = vi.fn(async () => ({ success: true }));
const conciergeGlobalMock = vi.fn(async () => ({ success: true }));
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: {
		conciergeIp: (...a) => conciergeIpMock(...a),
		conciergeGlobal: (...a) => conciergeGlobalMock(...a),
	},
	clientIp: () => '203.0.113.9',
}));

const moderateMock = vi.fn(async () => ({ checked: true, flagged: false }));
vi.mock('../api/_lib/moderation.js', () => ({
	moderateAnonInput: (...a) => moderateMock(...a),
	refusalReply: () => 'I can’t help with that, but I’m happy to answer questions about this site.',
}));

const providerChainMock = vi.fn(() => []);
vi.mock('../api/_lib/llm.js', () => ({
	providerChain: (...a) => providerChainMock(...a),
	LlmUnavailableError: class extends Error {
		constructor() {
			super('no provider');
			this.status = 503;
		}
	},
}));

const cooldownMock = vi.fn(async () => {});
vi.mock('../api/_lib/provider-health.js', () => ({
	markProviderCooldown: (...a) => cooldownMock(...a),
	providersInCooldown: async () => new Map(),
	AUTH_COOLDOWN_SECONDS: 3600,
}));

const recordEventMock = vi.fn();
vi.mock('../api/_lib/usage.js', () => ({ recordEvent: (...a) => recordEventMock(...a) }));
vi.mock('../api/_lib/sentry.js', () => ({ captureException: vi.fn() }));
vi.mock('../api/_lib/env.js', () => ({ env: { APP_ORIGIN: 'http://localhost:3000' } }));

const { default: handler } = await import('../api/concierge.js');

function mkReq({ method = 'POST', body = null, origin = 'https://customer-site.example' } = {}) {
	const headers = { origin };
	if (body != null) headers['content-type'] = 'application/json';
	return {
		method,
		url: '/api/concierge',
		headers,
		on(event, cb) {
			if (event === 'data' && body != null) {
				const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
				queueMicrotask(() => {
					cb(buf);
					this._endCb?.();
				});
			} else if (event === 'end') {
				this._endCb = cb;
				if (body == null) queueMicrotask(() => cb());
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
		writeHead(code, headers = {}) {
			this.statusCode = code;
			for (const [k, v] of Object.entries(headers)) this.setHeader(k, v);
		},
		write(s) {
			this.chunks.push(String(s));
			return true;
		},
		end(b) {
			if (b) this.chunks.push(String(b));
			this.writableEnded = true;
		},
		get body() {
			return this.chunks.join('');
		},
	};
}

function sseEvents(res) {
	return res.body
		.split('\n\n')
		.filter((f) => f.startsWith('data:'))
		.map((f) => JSON.parse(f.slice(5)));
}

function fakeStreamBody(deltas) {
	const frames = deltas.map((d) =>
		Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: d } }] })}\n`),
	);
	frames.push(Buffer.from('data: [DONE]\n'));
	return (async function* () {
		yield* frames;
	})();
}

const VALID_BODY = {
	message: 'What does the Pro plan cost?',
	history: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'Hello!' }],
	site: {
		url: 'https://customer-site.example/pricing',
		name: 'Acme',
		title: 'Pricing, Acme',
		description: 'Plans for every team.',
		headings: ['Pricing', 'FAQ'],
		nav: ['Home', 'Pricing', 'Docs'],
		knowledge: 'Pro plan costs $20/month.',
		content: 'Pro $20/month. Free plan available.',
	},
};

beforeEach(() => {
	vi.clearAllMocks();
	conciergeIpMock.mockResolvedValue({ success: true });
	conciergeGlobalMock.mockResolvedValue({ success: true });
	moderateMock.mockResolvedValue({ checked: true, flagged: false });
});

describe('/api/concierge', () => {
	it('answers OPTIONS preflight with any-origin CORS', async () => {
		const res = mkRes();
		await handler(mkReq({ method: 'OPTIONS' }), res);
		expect(res.statusCode).toBe(204);
		expect(res.headers['access-control-allow-origin']).toBe('*');
	});

	it('rejects GET', async () => {
		const res = mkRes();
		await handler(mkReq({ method: 'GET' }), res);
		expect(res.statusCode).toBe(405);
	});

	it('400s a malformed body', async () => {
		const res = mkRes();
		await handler(mkReq({ body: { message: '' } }), res);
		expect(res.statusCode).toBe(400);
	});

	it('429s when the per-IP bucket is exhausted', async () => {
		conciergeIpMock.mockResolvedValue({ success: false, limit: 20, remaining: 0, reset: Date.now() + 1000 });
		const res = mkRes();
		await handler(mkReq({ body: VALID_BODY }), res);
		expect(res.statusCode).toBe(429);
	});

	it('flagged input gets an in-band SSE refusal, never an HTTP error', async () => {
		moderateMock.mockResolvedValue({ checked: true, flagged: true });
		const res = mkRes();
		await handler(mkReq({ body: VALID_BODY }), res);
		expect(res.statusCode).toBe(200);
		const events = sseEvents(res);
		expect(events[0].type).toBe('chunk');
		expect(events[0].text).toMatch(/can’t help/);
		expect(events.at(-1)).toMatchObject({ type: 'done', moderated: true });
		expect(providerChainMock).not.toHaveBeenCalled();
	});

	it('streams chunk→done from a healthy provider, grounded system prompt included', async () => {
		let capturedBody = null;
		providerChainMock.mockReturnValue([
			{
				name: 'groq',
				model: 'llama-3.3-70b',
				url: 'https://groq.test/v1/chat/completions',
				headers: { 'content-type': 'application/json' },
			},
		]);
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url, opts) => {
				capturedBody = JSON.parse(opts.body);
				return { ok: true, body: fakeStreamBody(['The Pro plan ', 'costs $20/month.']) };
			}),
		);

		const res = mkRes();
		await handler(mkReq({ body: VALID_BODY }), res);
		vi.unstubAllGlobals();

		expect(res.headers['content-type']).toMatch(/text\/event-stream/);
		const events = sseEvents(res);
		expect(events.filter((e) => e.type === 'chunk').map((e) => e.text).join('')).toBe(
			'The Pro plan costs $20/month.',
		);
		expect(events.at(-1)).toMatchObject({ type: 'done', provider: 'groq', model: 'llama-3.3-70b' });

		// The upstream request carried streaming + the grounded system prompt +
		// the running history + the visitor's question.
		expect(capturedBody.stream).toBe(true);
		expect(capturedBody.messages[0].role).toBe('system');
		expect(capturedBody.messages[0].content).toContain('Pro plan costs $20/month');
		expect(capturedBody.messages[0].content).toContain('Acme');
		expect(capturedBody.messages.at(-1)).toEqual({ role: 'user', content: VALID_BODY.message });
		expect(capturedBody.messages).toHaveLength(4);

		expect(recordEventMock).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: 'chat',
				tool: 'concierge',
				meta: expect.objectContaining({ provider: 'groq', site: 'customer-site.example' }),
			}),
		);
	});

	it('shopping payload switches the system prompt to a store assistant grounded in products', async () => {
		let capturedBody = null;
		providerChainMock.mockReturnValue([
			{ name: 'groq', model: 'llama-3.3-70b', url: 'https://groq.test/v1/chat/completions', headers: {} },
		]);
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url, opts) => {
				capturedBody = JSON.parse(opts.body);
				return { ok: true, body: fakeStreamBody(['The Merino scarf is a great pick.']) };
			}),
		);

		const res = mkRes();
		await handler(
			mkReq({
				body: {
					message: 'do you have a warm wool scarf?',
					site: { url: 'https://larkspur.example', name: 'Larkspur' },
					shopping: {
						store: 'larkspur-supply.myshopify.com',
						currency: 'USD',
						summary: '42 products · categories: Scarves, Hats · prices from $28.00 to $180.00',
						collections: ['Winter', 'New Arrivals'],
						policies: 'Shipping policy: We ship worldwide within 3 business days.',
						products: '- Merino Wool Scarf ($48.00) · type: Scarves · A soft blue scarf · link: https://larkspur-supply.myshopify.com/products/merino-wool-scarf',
					},
				},
			}),
			res,
		);
		vi.unstubAllGlobals();

		const sys = capturedBody.messages[0].content;
		expect(capturedBody.messages[0].role).toBe('system');
		expect(sys).toContain('shopping assistant');
		expect(sys).toContain('larkspur-supply.myshopify.com'); // store name
		expect(sys).toContain('Merino Wool Scarf'); // retrieved product grounds the answer
		expect(sys).toContain('shown as cards'); // told the shopper sees cards
		expect(sys).toContain('ship worldwide within 3 business days'); // policy grounded
		expect(sys).toContain('Winter'); // collections offered as a fallback

		expect(recordEventMock).toHaveBeenCalledWith(
			expect.objectContaining({ meta: expect.objectContaining({ shopping: true }) }),
		);
	});

	it('fails over past a billing-dead rung (with auth cooldown) to the next provider', async () => {
		providerChainMock.mockReturnValue([
			{ name: 'openrouter', model: 'oss-120b', url: 'https://or.test/v1', headers: {} },
			{ name: 'groq', model: 'llama-3.3-70b', url: 'https://groq.test/v1', headers: {} },
		]);
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url) => {
				if (String(url).startsWith('https://or.test')) {
					return { ok: false, status: 402, text: async () => 'insufficient credits' };
				}
				return { ok: true, body: fakeStreamBody(['fallback answer']) };
			}),
		);

		const res = mkRes();
		await handler(mkReq({ body: VALID_BODY }), res);
		vi.unstubAllGlobals();

		const events = sseEvents(res);
		expect(events.at(-1)).toMatchObject({ type: 'done', provider: 'groq' });
		expect(cooldownMock).toHaveBeenCalledWith('openrouter', 3600, 'auth');
	});

	it('503s with Retry-After when every rung fails before a byte streams', async () => {
		providerChainMock.mockReturnValue([
			{ name: 'groq', model: 'm', url: 'https://groq.test/v1', headers: {} },
		]);
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({ ok: false, status: 429, text: async () => 'rate limited' })),
		);

		const res = mkRes();
		await handler(mkReq({ body: VALID_BODY }), res);
		vi.unstubAllGlobals();

		expect(res.statusCode).toBe(503);
		expect(res.headers['retry-after']).toBe('15');
		expect(cooldownMock).toHaveBeenCalledWith('groq');
	});
});
