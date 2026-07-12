import { describe, it, expect, vi } from 'vitest';

// env throws if required vars are missing — stub before the module imports it.
vi.mock('../api/_lib/env.js', () => ({
	env: {
		APP_ORIGIN: 'https://three.ws',
		MCP_RESOURCE: 'https://three.ws/api/mcp',
		X402_PAY_TO_BASE: '0x4022de2d36c334e73c7a108805cea11c0564f402',
	},
}));

const { sendAuthChallenge } = await import('../api/_mcp/auth.js');

function mkRes() {
	const headers = {};
	return {
		statusCode: 200,
		body: null,
		setHeader(k, v) {
			headers[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return headers[k.toLowerCase()];
		},
		end(body) {
			this.body = body;
		},
		headers,
	};
}

const REQUIREMENTS = [
	{
		scheme: 'exact',
		amount: '1000',
		network: 'eip155:8453',
		payTo: '0x4022de2d36c334e73c7a108805cea11c0564f402',
		asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
		resource: 'https://three.ws/api/mcp',
	},
];

// sendAuthChallenge is async (it awaits build402Body, which signs per-accept
// offer receipts), so the helper awaits it and every test awaits the helper.
async function challengeFor(headers) {
	const res = mkRes();
	await sendAuthChallenge(res, {
		req: { headers },
		resourceUrl: 'https://three.ws/api/mcp',
		requirements: REQUIREMENTS,
	});
	return res;
}

describe('sendAuthChallenge status negotiation', () => {
	it('returns 402 Payment Required to plain x402 clients (no MCP signals)', async () => {
		const res = await challengeFor({ accept: 'application/json' });
		expect(res.statusCode).toBe(402);
	});

	it('returns 402 when there is no accept header at all (crawlers)', async () => {
		const res = await challengeFor({});
		expect(res.statusCode).toBe(402);
	});

	it('returns 401 to MCP Streamable HTTP clients (Accept includes SSE)', async () => {
		const res = await challengeFor({ accept: 'application/json, text/event-stream' });
		expect(res.statusCode).toBe(401);
	});

	it('returns 401 when MCP-Protocol-Version header is present', async () => {
		const res = await challengeFor({
			accept: 'application/json',
			'mcp-protocol-version': '2025-06-18',
		});
		expect(res.statusCode).toBe(401);
	});

	it('returns 401 when Mcp-Session-Id header is present', async () => {
		const res = await challengeFor({ 'mcp-session-id': 'abc123' });
		expect(res.statusCode).toBe(401);
	});

	it('always ships the x402 envelope on both statuses', async () => {
		for (const headers of [{}, { accept: 'text/event-stream' }]) {
			const res = await challengeFor(headers);
			const envelope = JSON.parse(
				Buffer.from(res.getHeader('payment-required'), 'base64').toString('utf8'),
			);
			expect(envelope.x402Version).toBeDefined();
			expect(envelope.accepts).toHaveLength(REQUIREMENTS.length);
			const body = JSON.parse(res.body);
			expect(body.accepts).toHaveLength(REQUIREMENTS.length);
		}
	});

	it('sends WWW-Authenticate only on the 401 (OAuth/MCP-client) branch', async () => {
		// On a 402, WWW-Authenticate would carry no `Payment` challenge (we speak
		// x402, not MPP/Tempo) and x402scan's audit flags any WWW-Authenticate on
		// a 402 as a malformed MPP header. OAuth clients are detected by request
		// headers and always land on the 401 branch, which keeps the header.
		const oauthRes = await challengeFor({ accept: 'text/event-stream' });
		expect(oauthRes.statusCode).toBe(401);
		expect(oauthRes.getHeader('www-authenticate')).toContain('resource_metadata=');

		const crawlerRes = await challengeFor({});
		expect(crawlerRes.statusCode).toBe(402);
		expect(crawlerRes.getHeader('www-authenticate')).toBeUndefined();
	});
});
