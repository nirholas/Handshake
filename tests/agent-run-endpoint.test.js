import { describe, it, expect, vi, beforeEach } from 'vitest';

// The loop's impure edges are all mocked at module boundaries: the LLM chain
// (scripted rounds), the tool registry (a spy handler), the rate limiter, and
// env. What runs for real is the AgentRuntime loop, the GuardChain preflight,
// and the OpenAI wire formatting.
const agentRunIp = vi.fn();
vi.mock('../api/_lib/rate-limit.js', () => ({
	limits: { agentRunIp: (...a) => agentRunIp(...a) },
	clientIp: () => '1.2.3.4',
}));
vi.mock('../api/_lib/env.js', () => ({
	env: { APP_ORIGIN: 'http://localhost:3000', ISSUER: 'http://t', MCP_RESOURCE: 'http://t' },
}));

const providerChain = vi.fn();
const streamRound = vi.fn();
vi.mock('../api/_lib/llm-tool-chain.js', () => ({
	providerChain: (...a) => providerChain(...a),
	streamRound: (...a) => streamRound(...a),
}));

const priceHandler = vi.fn();
vi.mock('../api/_lib/agent-tools.js', () => ({
	agentToolSchemas: () => [
		{
			type: 'function',
			function: {
				name: 'token_price',
				description: 'test tool',
				parameters: { type: 'object', properties: { query: { type: 'string' } } },
			},
		},
	],
	agentToolHandlers: () => ({ token_price: (...a) => priceHandler(...a) }),
}));

const { default: runHandler } = await import('../api/agent/run.js');

function mkReq({ method = 'POST', body = null } = {}) {
	return {
		method,
		url: '/api/agent/run',
		headers: body != null ? { 'content-type': 'application/json' } : {},
		socket: { remoteAddress: '127.0.0.1' },
		on(event, cb) {
			if (event === 'data' && body != null) {
				queueMicrotask(() => {
					cb(Buffer.from(JSON.stringify(body)));
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
		chunks: [],
		writableEnded: false,
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		write(c) {
			this.chunks.push(String(c));
		},
		end(c) {
			if (c != null) this.chunks.push(String(c));
			this.writableEnded = true;
		},
	};
}
const sseText = (res) => res.chunks.join('');

beforeEach(() => {
	agentRunIp.mockReset().mockResolvedValue({ success: true, limit: 30, remaining: 29, reset: Date.now() + 1000 });
	providerChain.mockReset().mockReturnValue([{ name: 'scripted', url: 'http://test', key: 'k', model: 'm' }]);
	streamRound.mockReset();
	priceHandler.mockReset();
});

describe('POST /api/agent/run', () => {
	it('runs a tool round then streams the final answer as OpenAI chunks', async () => {
		streamRound
			.mockImplementationOnce(async () => ({
				content: '',
				toolCalls: [{ id: 'c1', name: 'token_price', args: '{"query":"solana"}' }],
			}))
			.mockImplementationOnce(async (_provider, { onContent }) => {
				onContent('SOL is ');
				onContent('$200.');
				return { content: 'SOL is $200.', toolCalls: [] };
			});
		priceHandler.mockResolvedValue({ found: true, symbol: 'sol', priceUsd: 200 });

		const res = mkRes();
		await runHandler(mkReq({ body: { messages: [{ role: 'user', content: 'price of sol?' }], stream: true } }), res);

		const text = sseText(res);
		expect(res.headers['content-type']).toContain('text/event-stream');
		expect(text).toContain('"role":"assistant"');
		expect(text).toContain(': tool token_price');
		expect(text).toContain('"content":"SOL is "');
		expect(text).toContain('"finish_reason":"stop"');
		expect(text).toContain('data: [DONE]');

		// The tool actually executed with the model's arguments…
		expect(priceHandler).toHaveBeenCalledWith({ query: 'solana' });
		// …and the second round saw the assistant tool_calls message plus the
		// tool result fed back in OpenAI format.
		const secondMessages = streamRound.mock.calls[1][1].messages;
		const assistant = secondMessages.find((m) => m.role === 'assistant' && m.tool_calls);
		expect(assistant.tool_calls[0].function.name).toBe('token_price');
		const toolMsg = secondMessages.find((m) => m.role === 'tool' && m.tool_call_id === 'c1');
		expect(JSON.parse(toolMsg.content)).toMatchObject({ priceUsd: 200 });
	});

	it('answers non-stream requests with a chat.completion JSON', async () => {
		streamRound.mockImplementationOnce(async () => ({ content: 'Just an answer.', toolCalls: [] }));

		const res = mkRes();
		await runHandler(mkReq({ body: { messages: [{ role: 'user', content: 'hi' }], stream: false } }), res);

		expect(res.statusCode).toBe(200);
		const out = JSON.parse(sseText(res));
		expect(out.object).toBe('chat.completion');
		expect(out.choices[0].message.content).toBe('Just an answer.');
		expect(streamRound).toHaveBeenCalledTimes(1);
	});

	it('feeds an unknown tool back to the model as an error instead of crashing', async () => {
		streamRound
			.mockImplementationOnce(async () => ({
				content: '',
				toolCalls: [{ id: 'c9', name: 'not_a_tool', args: '{}' }],
			}))
			.mockImplementationOnce(async () => ({ content: 'That tool does not exist.', toolCalls: [] }));

		const res = mkRes();
		await runHandler(mkReq({ body: { messages: [{ role: 'user', content: 'x' }] } }), res);

		const secondMessages = streamRound.mock.calls[1][1].messages;
		const toolMsg = secondMessages.find((m) => m.role === 'tool' && m.tool_call_id === 'c9');
		expect(JSON.parse(toolMsg.content).error).toContain('Unknown tool');
		expect(priceHandler).not.toHaveBeenCalled();
	});

	it('injects the server system note without displacing a client persona', async () => {
		streamRound.mockImplementationOnce(async () => ({ content: 'ok', toolCalls: [] }));

		const res = mkRes();
		await runHandler(
			mkReq({
				body: {
					messages: [
						{ role: 'system', content: 'You are Blorbo.' },
						{ role: 'user', content: 'hi' },
					],
				},
			}),
			res,
		);

		const messages = streamRound.mock.calls[0][1].messages;
		expect(messages[0].content).toBe('You are Blorbo.');
		expect(messages[1].role).toBe('system');
		expect(messages[1].content).toContain('server-side tools');
	});

	it('fails over to the next provider before any byte is streamed', async () => {
		providerChain.mockReturnValue([
			{ name: 'dead', url: 'http://dead', key: 'k', model: 'm' },
			{ name: 'live', url: 'http://live', key: 'k', model: 'm' },
		]);
		streamRound
			.mockImplementationOnce(async () => {
				throw new Error('dead lane');
			})
			.mockImplementationOnce(async () => ({ content: 'from the live lane', toolCalls: [] }));

		const res = mkRes();
		await runHandler(mkReq({ body: { messages: [{ role: 'user', content: 'hi' }], stream: false } }), res);

		const out = JSON.parse(sseText(res));
		expect(out.choices[0].message.content).toBe('from the live lane');
	});

	it('400s on missing messages and 429s when rate-limited', async () => {
		let res = mkRes();
		await runHandler(mkReq({ body: {} }), res);
		expect(res.statusCode).toBe(400);

		agentRunIp.mockResolvedValue({ success: false, limit: 30, remaining: 0, reset: Date.now() + 1000 });
		res = mkRes();
		await runHandler(mkReq({ body: { messages: [{ role: 'user', content: 'hi' }] } }), res);
		expect(res.statusCode).toBe(429);
	});

	it('503s when no LLM provider is configured', async () => {
		providerChain.mockReturnValue([]);
		const res = mkRes();
		await runHandler(mkReq({ body: { messages: [{ role: 'user', content: 'hi' }] } }), res);
		expect(res.statusCode).toBe(503);
	});
});
