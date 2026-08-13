import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Env (lazy env.* access in shared helpers) ───────────────────────────────
process.env.PUBLIC_APP_ORIGIN ||= 'https://app.test';
process.env.WATSONX_API_KEY ||= 'test-key';
process.env.WATSONX_PROJECT_ID ||= 'proj-123';

// ── watsonx.ai clients (no network, no real credentials) ────────────────────
const wx = {
	chat: vi.fn(async () => ({
		text: 'Granite says hello.',
		finishReason: 'stop',
		usage: { prompt_tokens: 9, completion_tokens: 4 },
		model: 'ibm/granite-3-8b-instruct',
	})),
	embed: vi.fn(async () => ({
		model: 'ibm/granite-embedding-278m-multilingual',
		vectors: [[0.1, 0.2, 0.3]],
		dimensions: 3,
		inputCount: 1,
	})),
};
vi.mock('../../api/_lib/watsonx.js', () => ({
	watsonxConfig: vi.fn(() => ({ configured: true })),
	watsonxChatComplete: (...a) => wx.chat(...a),
	watsonxEmbed: (...a) => wx.embed(...a),
}));

const fc = {
	forecast: vi.fn(async () => ({
		model: 'ibm/granite-ttm-512-96-r2',
		timestamps: ['2025-01-03T00:00:00Z', '2025-01-04T00:00:00Z'],
		values: [123, 130],
		inputWindow: 64,
	})),
};
vi.mock('../../api/_lib/watsonx-forecast.js', () => ({
	watsonxForecast: (...a) => fc.forecast(...a),
}));

// ── Bazaar discovery — stub the @x402-SDK-backed helper ─────────────────────
vi.mock('../../api/_lib/x402/bazaar-helpers.js', () => ({
	declareMcpDiscovery: vi.fn(({ toolName }) => ({ discoverable: true, toolName })),
	withService: vi.fn(() => ({
		serviceName: 'three.ws',
		tags: [],
		iconUrl: 'https://three.ws/favicon.ico',
	})),
}));

// ── Usage (no DB in unit tests) ─────────────────────────────────────────────
vi.mock('../../api/_lib/usage.js', () => ({
	recordEvent: vi.fn(),
	logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
}));

const { dispatch, PROTOCOL_VERSION } = await import('../../api/_mcpibm/dispatch.js');
const { graniteX402Amount, priceFor, formatUsdPrice, TOOL_PRICING } = await import(
	'../../api/_mcpibm/pricing.js'
);
const { isFreeTool, TOOL_CATALOG } = await import('../../api/_mcpibm/catalog.js');

const AUTH = { userId: null, rateKey: 'test', scope: '', source: 'x402', x402Paid: true };
const call = (name, args) =>
	dispatch(
		{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
		AUTH,
	);

function makeSeries(n) {
	const timestamps = [];
	const values = [];
	const base = Date.UTC(2025, 0, 1) / 1000;
	for (let i = 0; i < n; i++) {
		timestamps.push(new Date((base + i * 86400) * 1000).toISOString());
		values.push(1000 + i);
	}
	return { timestamps, values };
}

beforeEach(() => {
	wx.chat.mockClear();
	wx.embed.mockClear();
	fc.forecast.mockClear();
});

describe('IBM Granite MCP — dispatch', () => {
	it('lists the free getting-started tool plus the five paid Granite tools', async () => {
		const r = await dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, AUTH);
		const names = r.result.tools.map((t) => t.name);
		expect(names).toEqual([
			'ibm_granite_getting_started',
			'ibm_granite_chat',
			'ibm_granite_code',
			'ibm_granite_embed',
			'ibm_granite_analyze',
			'ibm_granite_forecast',
		]);
		const chat = r.result.tools.find((t) => t.name === 'ibm_granite_chat');
		expect(chat.pricing).toMatchObject({ amount_usdc: 0.02, currency: 'USDC', scheme: 'x402' });
		expect(chat.extensions.bazaar.discoverable).toBe(true);
		expect(chat.inputSchema.required).toContain('messages');
	});

	it('getting_started is free: no pricing and no bazaar discovery extension', async () => {
		const r = await dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, AUTH);
		const gs = r.result.tools.find((t) => t.name === 'ibm_granite_getting_started');
		expect(gs).toBeTruthy();
		expect(gs.pricing).toBeUndefined();
		expect(gs.extensions).toBeUndefined();
	});

	it('isFreeTool flags only the getting-started tool', () => {
		expect(isFreeTool('ibm_granite_getting_started')).toBe(true);
		expect(isFreeTool('ibm_granite_chat')).toBe(false);
		expect(isFreeTool('nonexistent_tool')).toBe(false);
		expect(graniteX402Amount('ibm_granite_getting_started')).toBeNull();
	});

	it('getting_started returns the overview with tools, prices, and payment flow — no payment', async () => {
		const r = await call('ibm_granite_getting_started', {});
		const out = r.result.structuredContent;
		expect(out.ok).toBe(true);
		expect(out.server).toBe('ibm-x402-mcp');
		expect(out.pricing).toContain('ibm_granite_chat: $0.02/call');
		expect(out.payment_flow.length).toBeGreaterThan(0);
		expect(r.result.content[0].text).toContain('Getting Started');
		// No watsonx call — this tool never touches IBM inference.
		expect(wx.chat).not.toHaveBeenCalled();
	});

	it('getting_started focuses on a requested section', async () => {
		const r = await call('ibm_granite_getting_started', { section: 'pricing' });
		const out = r.result.structuredContent;
		expect(out.pricing).toBeTruthy();
		expect(out.overview).toBeUndefined();
	});

	it('initialize advertises the ibm-x402-mcp server', async () => {
		const r = await dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize' }, AUTH);
		expect(r.result.serverInfo.name).toBe('ibm-x402-mcp');
		expect(r.result.protocolVersion).toBe(PROTOCOL_VERSION);
	});

	it('ibm_granite_chat returns the assistant reply + usage', async () => {
		const r = await call('ibm_granite_chat', { messages: [{ role: 'user', content: 'hi' }] });
		expect(wx.chat).toHaveBeenCalledWith(
			{ configured: true },
			{
				messages: [{ role: 'user', content: 'hi' }],
				model: undefined,
				maxTokens: 1024,
				temperature: 0.7,
			},
		);
		expect(r.result.structuredContent).toMatchObject({
			ok: true,
			text: 'Granite says hello.',
			model: 'ibm/granite-3-8b-instruct',
		});
		expect(r.result.content[0].text).toBe('Granite says hello.');
	});

	it('ibm_granite_code maps the task to a system prompt + decoding params', async () => {
		const r = await call('ibm_granite_code', { task: 'review', prompt: 'def f(): return 1/0' });
		const [, opts] = wx.chat.mock.calls[0];
		expect(opts.messages[0].role).toBe('system');
		expect(opts.messages[0].content).toContain('FINDINGS');
		expect(opts.temperature).toBe(0.1); // non-generate → 0.1
		expect(opts.maxTokens).toBe(2048);
		expect(r.result.structuredContent).toMatchObject({ ok: true, task: 'review' });
	});

	it('ibm_granite_embed returns one vector per input', async () => {
		const r = await call('ibm_granite_embed', { inputs: ['hello world'] });
		expect(wx.embed).toHaveBeenCalledWith(
			{ configured: true },
			{ inputs: ['hello world'], model: undefined },
		);
		expect(r.result.structuredContent).toMatchObject({
			ok: true,
			dimensions: 3,
			inputCount: 1,
		});
		expect(r.result.structuredContent.vectors).toHaveLength(1);
	});

	it('ibm_granite_analyze parses Granite JSON into structuredContent', async () => {
		wx.chat.mockResolvedValueOnce({
			text: '{"summary":"ok","entities":[],"sentiment":{"overall":"neutral","score":0},"key_findings":[],"risk_flags":[],"next_steps":[],"analysis_type":"contract"}',
			usage: { prompt_tokens: 50, completion_tokens: 60 },
			model: 'ibm/granite-3-8b-instruct',
		});
		const r = await call('ibm_granite_analyze', {
			document: 'A contract.',
			analysis_type: 'contract',
		});
		expect(r.result.structuredContent).toMatchObject({
			ok: true,
			analysis_type: 'contract',
			summary: 'ok',
			sentiment: { overall: 'neutral', score: 0 },
		});
	});

	it('ibm_granite_analyze falls back to raw_response on non-JSON output', async () => {
		wx.chat.mockResolvedValueOnce({
			text: 'not json at all',
			usage: {},
			model: 'ibm/granite-3-8b-instruct',
		});
		const r = await call('ibm_granite_analyze', { document: 'x' });
		expect(r.result.structuredContent).toMatchObject({
			ok: true,
			analysis_type: 'general', // schema default applied by Ajv
			raw_response: 'not json at all',
		});
		expect(r.result.structuredContent.parse_error).toBeTruthy();
	});

	it('ibm_granite_analyze rejects JSON that is not an analysis object', async () => {
		// A bare quoted string is valid JSON. Spreading it into the result would
		// splatter one numbered key per character, so it takes the raw fallback.
		wx.chat.mockResolvedValueOnce({
			text: '"Not enough context to analyze."',
			usage: {},
			model: 'ibm/granite-3-8b-instruct',
		});
		const r = await call('ibm_granite_analyze', { document: 'x' });
		const out = r.result.structuredContent;
		expect(out).toMatchObject({
			ok: true,
			analysis_type: 'general',
			raw_response: '"Not enough context to analyze."',
		});
		expect(out.parse_error).toBeTruthy();
		expect(Object.keys(out)).not.toContain('0');
	});

	it('ibm_granite_analyze rejects a JSON array the same way', async () => {
		wx.chat.mockResolvedValueOnce({
			text: '[{"summary":"ok"}]',
			usage: {},
			model: 'ibm/granite-3-8b-instruct',
		});
		const r = await call('ibm_granite_analyze', { document: 'x' });
		const out = r.result.structuredContent;
		expect(out.parse_error).toBeTruthy();
		expect(out.raw_response).toBe('[{"summary":"ok"}]');
		expect(Object.keys(out)).not.toContain('0');
	});

	it('ibm_granite_forecast returns timestamped forecast points', async () => {
		const { timestamps, values } = makeSeries(64);
		const r = await call('ibm_granite_forecast', {
			timestamps,
			values,
			freq: '1D',
			label: 'rev',
		});
		expect(fc.forecast).toHaveBeenCalledWith(
			{ configured: true },
			{ timestamps, values, freq: '1D', predictionLength: undefined },
		);
		expect(r.result.structuredContent).toMatchObject({
			ok: true,
			label: 'rev',
			model: 'ibm/granite-ttm-512-96-r2',
			forecastSteps: 2,
		});
		expect(r.result.structuredContent.forecast[0]).toEqual({
			timestamp: '2025-01-03T00:00:00Z',
			value: 123,
		});
	});

	it('rejects a chat call with no messages as invalid params', async () => {
		const r = await call('ibm_granite_chat', { messages: [] });
		expect(r.error.code).toBe(-32602);
		expect(wx.chat).not.toHaveBeenCalled();
	});

	it('rejects an unknown tool', async () => {
		const r = await call('ibm_granite_unknown', {});
		expect(r.error.code).toBe(-32602);
	});

	it('surfaces a watsonx upstream failure as a tool error (not an rpc error)', async () => {
		wx.chat.mockRejectedValueOnce(new Error('watsonx 401: invalid api key'));
		const r = await call('ibm_granite_chat', { messages: [{ role: 'user', content: 'hi' }] });
		expect(r.result.isError).toBe(true);
		expect(r.result.content[0].text).toContain('Error:');
	});
});

describe('IBM Granite MCP — pricing', () => {
	it('derives the x402 atomic amount from the per-tool USDC price', () => {
		expect(graniteX402Amount('ibm_granite_chat')).toBe('20000'); // $0.02 → 20000 micro-USDC
		expect(graniteX402Amount('ibm_granite_embed')).toBe('5000'); // $0.005 → 5000
		expect(graniteX402Amount('ibm_granite_forecast')).toBe('50000'); // $0.05 → 50000
	});

	it('returns null for an unpriced / unknown tool', () => {
		expect(graniteX402Amount('nope')).toBeNull();
		expect(priceFor('nope')).toBeNull();
		expect(formatUsdPrice('nope')).toBeNull();
	});

	it('does not resolve an inherited Object member as a priced tool', () => {
		for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
			expect(priceFor(name)).toBeNull();
			expect(graniteX402Amount(name)).toBeNull();
			expect(formatUsdPrice(name)).toBeNull();
		}
	});

	it('formats the display price without truncating a fractional cent', () => {
		expect(formatUsdPrice('ibm_granite_chat')).toBe('$0.02');
		expect(formatUsdPrice('ibm_granite_code')).toBe('$0.025');
		expect(formatUsdPrice('ibm_granite_embed')).toBe('$0.005');
	});
});

// Every human-readable price this server advertises has to agree with
// TOOL_PRICING, the map the 402 challenge and the settle path both read. A
// number quoted anywhere else is a number a caller can be shown before paying a
// different one.
describe('IBM Granite MCP — advertised prices match the charged price', () => {
	const PRICED = Object.keys(TOOL_PRICING);

	it('every priced tool title quotes its own price', () => {
		for (const name of PRICED) {
			const tool = TOOL_CATALOG.find((t) => t.name === name);
			expect(tool, name).toBeTruthy();
			expect(tool.title, `${name}: title`).toContain(formatUsdPrice(name));
		}
	});

	it('every priced tool description quotes its own price', () => {
		for (const name of PRICED) {
			const tool = TOOL_CATALOG.find((t) => t.name === name);
			expect(tool.description, `${name}: description`).toContain(formatUsdPrice(name));
		}
	});

	it('the catalog pricing block carries the USDC amount from TOOL_PRICING', () => {
		for (const name of PRICED) {
			const tool = TOOL_CATALOG.find((t) => t.name === name);
			expect(tool.pricing.amount_usdc, name).toBe(TOOL_PRICING[name].amount_usdc);
			expect(tool.pricing.currency).toBe('USDC');
		}
	});

	it('the free getting-started payload quotes the same prices', async () => {
		const r = await call('ibm_granite_getting_started', {});
		const out = r.result.structuredContent;
		for (const name of PRICED) {
			const entry = out.tools.find((t) => t.name === name);
			expect(entry, name).toBeTruthy();
			expect(entry.price, `${name}: getting_started price`).toBe(formatUsdPrice(name));
			expect(out.pricing).toContain(`${name}: ${formatUsdPrice(name)}/call`);
		}
		// The list is exhaustive: no paid tool is missing from the orientation.
		expect(out.tools.map((t) => t.name).sort()).toEqual([...PRICED].sort());
	});

	it('the server instructions quote the same prices', async () => {
		const r = await dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize' }, AUTH);
		const instructions = r.result.instructions;
		for (const name of PRICED) {
			expect(instructions, `${name}: instructions`).toContain(
				`${name}(`,
			);
			expect(instructions).toContain(`(${formatUsdPrice(name)})`);
		}
	});
});
