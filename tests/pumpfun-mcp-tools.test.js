import { describe, it, expect, vi, beforeEach } from 'vitest';

// pumpfun_* MCP tools (api/_mcp/tools/pumpfun.js), registered in
// api/_mcp/catalog.js. These are the pump.fun intel tools external MCP clients
// (Claude Desktop, Cursor) call against the platform server.
//
// Verifies: every tool is registered in the catalog with a read-only, live-feed
// annotation set; the handlers clamp the caller's limit and forward it to the
// upstream client; a successful array response is wrapped as { items }; an
// upstream failure and a missing mint/wallet both surface as clean tool errors
// rather than a bubbled fault; and an unconfigured feed says so instead of
// pretending the market is empty. Only the upstream client wrapper is mocked
// (its bot credentials are server-side); the tool defs themselves run real.

const recentClaimsMock = vi.fn();
const tokenIntelMock = vi.fn();
const creatorIntelMock = vi.fn();
const graduationsMock = vi.fn();
let botEnabled = true;

vi.mock('../api/_lib/pumpfun-mcp.js', () => ({
	pumpfunMcp: {
		recentClaims: (...a) => recentClaimsMock(...a),
		tokenIntel: (...a) => tokenIntelMock(...a),
		creatorIntel: (...a) => creatorIntelMock(...a),
		graduations: (...a) => graduationsMock(...a),
	},
	pumpfunBotEnabled: () => botEnabled,
}));

const { toolDefs } = await import('../api/_mcp/tools/pumpfun.js');

const byName = (name) => toolDefs.find((t) => t.name === name);
const AUTH = { userId: null, rateKey: 'pumpfun-test', scope: '', source: 'free' };
const call = (name, args) => byName(name).handler(args, AUTH, {});

beforeEach(() => {
	recentClaimsMock.mockReset();
	tokenIntelMock.mockReset();
	creatorIntelMock.mockReset();
	graduationsMock.mockReset();
	botEnabled = true;
});

describe('pumpfun MCP tools: registration', () => {
	it('exposes the four intel tools with live-feed annotations', () => {
		expect(toolDefs.map((t) => t.name)).toEqual([
			'pumpfun_recent_claims',
			'pumpfun_token_intel',
			'pumpfun_creator_intel',
			'pumpfun_recent_graduations',
		]);
		for (const t of toolDefs) {
			// destructiveHint defaults to true when omitted, so every read tool
			// must set it explicitly or clients treat intel reads as dangerous.
			expect(t.annotations).toEqual({
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: true,
			});
			expect(t.inputSchema.additionalProperties).toBe(false);
		}
	});
});

describe('pumpfun MCP tools: success path', () => {
	it('wraps an array upstream response as { items } in structuredContent', async () => {
		recentClaimsMock.mockResolvedValue({ ok: true, data: [{ tx_signature: 'sig-1' }] });
		const r = await call('pumpfun_recent_claims', { limit: 3 });
		expect(r.isError).toBeUndefined();
		expect(recentClaimsMock).toHaveBeenCalledWith({ limit: 3 });
		expect(r.structuredContent).toEqual({ items: [{ tx_signature: 'sig-1' }] });
		expect(JSON.parse(r.content[0].text)).toEqual({ items: [{ tx_signature: 'sig-1' }] });
	});

	it('passes an object upstream response through unwrapped', async () => {
		tokenIntelMock.mockResolvedValue({ ok: true, data: { mint: 'M1', graduated: false } });
		const r = await call('pumpfun_token_intel', { mint: 'M1' });
		expect(tokenIntelMock).toHaveBeenCalledWith({ mint: 'M1' });
		expect(r.structuredContent).toEqual({ mint: 'M1', graduated: false });
	});

	it('clamps limit into the advertised 1..50 range and defaults a junk value', async () => {
		graduationsMock.mockResolvedValue({ ok: true, data: [] });
		await call('pumpfun_recent_graduations', { limit: 5000 });
		expect(graduationsMock).toHaveBeenCalledWith({ limit: 50 });

		graduationsMock.mockClear();
		await call('pumpfun_recent_graduations', { limit: 'not-a-number' });
		expect(graduationsMock).toHaveBeenCalledWith({ limit: 10 });

		graduationsMock.mockClear();
		await call('pumpfun_recent_graduations', {});
		expect(graduationsMock).toHaveBeenCalledWith({ limit: 10 });
	});
});

describe('pumpfun MCP tools: failure paths', () => {
	it('surfaces an upstream failure as a tool error, not a thrown fault', async () => {
		creatorIntelMock.mockResolvedValue({ ok: false, error: 'upstream 503' });
		const r = await call('pumpfun_creator_intel', { wallet: 'W1' });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain('upstream 503');
		expect(r.structuredContent).toBeUndefined();
	});

	it('rejects a missing mint / wallet with a 400-tagged error', async () => {
		await expect(call('pumpfun_token_intel', {})).rejects.toMatchObject({
			status: 400,
			message: 'mint required',
		});
		await expect(call('pumpfun_creator_intel', {})).rejects.toMatchObject({
			status: 400,
			message: 'wallet required',
		});
		expect(tokenIntelMock).not.toHaveBeenCalled();
		expect(creatorIntelMock).not.toHaveBeenCalled();
	});

	it('says the feed is unconfigured instead of reporting an empty market', async () => {
		botEnabled = false;
		recentClaimsMock.mockResolvedValue({ ok: true, data: [] });
		const r = await call('pumpfun_recent_claims', {});
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/not configured/i);
	});
});
