/**
 * three.ws Forge on OKX.AI, the rebuilt marketplace listing
 * (/api/okx/3d/forge-*, tools in api/_okx3d/forge.js, catalog rows in
 * api/_lib/okx-catalog.js).
 *
 * What this pins:
 *  - the LISTED line-up is the forge and nothing else, and the submission
 *    payload built from it is exactly those rows;
 *  - every paid row answers an unpaid tools/call with a 402 that LEADS with
 *    eip155:196 at that row's own price (the integration the 2026-07-04 review
 *    rejected us for missing);
 *  - the free tools (getting_started, forge_status) are served with no payment
 *    on every endpoint, so a buyer polls where it paid;
 *  - a buying agent gets the same payload the ChatGPT custom GPT gets: the GLB,
 *    the concept image, a viewer link and an AR link;
 *  - the age-13+ content gate refuses before any generation is started, so a
 *    refused prompt can never settle.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';

process.env.PUBLIC_APP_ORIGIN = 'https://three.ws';
process.env.X402_PAY_TO_BASE ||= '0x0000000000000000000000000000000000000001';
process.env.X402_ASSET_ADDRESS_BASE ||= '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
// The OKX X Layer rail. With these set, xlayerSettleable() is true and every
// paid forge 402 must lead with eip155:196.
process.env.X402_PAY_TO_XLAYER ||= '0x75d00a2713565171f33216e5aa2a375e076ecf69';
process.env.X402_XLAYER_RELAYER_KEY ||=
	'0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
process.env.JWT_SECRET ||= 'okx-forge-test-secret';

vi.mock('../../api/_lib/auth.js', () => ({
	extractBearer: () => null,
	authenticateBearer: vi.fn(async () => null),
	hasScope: () => true,
}));

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		mcpIp: vi.fn(async () => ({ success: true, reset: Date.now() + 1000 })),
		mcpUser: vi.fn(async () => ({ success: true, reset: Date.now() + 1000 })),
	},
	clientIp: vi.fn(() => '203.0.113.9'),
}));

vi.mock('../../api/_lib/usage.js', () => ({
	recordEvent: vi.fn(),
	logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
}));

// The forge lane is a pure HTTP client over /api/gpt-forge. Mock global fetch
// with a router so nothing here touches a GPU or the network.
const lane = { submit: null, poll: null };
const submitted = [];
function jsonResponse(status, body) {
	return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
globalThis.fetch = vi.fn(async (input, init) => {
	const url = typeof input === 'string' ? input : input.url;
	if (url.includes('/api/gpt-forge')) {
		if (init?.method === 'POST') {
			submitted.push(JSON.parse(init.body));
			return lane.submit ? lane.submit() : jsonResponse(200, { job_id: 'f1.job.abc', eta_seconds: 45 });
		}
		return lane.poll ? lane.poll(url) : jsonResponse(200, { status: 'running' });
	}
	throw new Error(`unexpected fetch: ${url}`);
});

const {
	OKX_CATALOG,
	catalogEntry,
	listedCatalog,
	validateCatalog,
	FORGE_TOOL,
	FORGE_STATUS_TOOL,
} = await import('../../api/_lib/okx-catalog.js');
const { forgeSurface, FORGE_SERVICE_IDS } = await import('../../api/_okx3d/forge.js');
const { default: handler } = await import('../../api/okx/3d/[service].js');

function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: null,
		setHeader(name, value) {
			this.headers[String(name).toLowerCase()] = value;
		},
		end(body) {
			this.body = body ?? null;
		},
	};
}

function makeReq({ method = 'POST', service, headers = {}, body = null } = {}) {
	const payload = body == null ? '' : JSON.stringify(body);
	const req = Readable.from(payload ? [Buffer.from(payload, 'utf8')] : []);
	req.method = method;
	req.url = `/api/okx/3d/${service}`;
	req.query = { service };
	req.headers = { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9', ...headers };
	return req;
}

function rpc(name, args, id = 1) {
	return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } };
}

async function post(service, body) {
	const res = makeRes();
	await handler(makeReq({ service, body }), res);
	return res;
}

const anonAuth = { userId: null, rateKey: null, scope: '', source: 'free' };
// dispatch() answers a full JSON-RPC envelope; the tool result is `.result`.
async function callTool(service, name, args) {
	const envelope = await forgeSurface(service).dispatch(rpc(name, args), anonAuth, { headers: {} });
	expect(envelope.error, JSON.stringify(envelope.error)).toBeUndefined();
	return envelope.result;
}

beforeEach(() => {
	lane.submit = null;
	lane.poll = null;
	submitted.length = 0;
});

// Every listed A2MCP row, the exact set a reviewer's MCP client connects to.
// The two free REST rows (catalog, health) are plain GET and are covered
// separately.
const LISTED_IDS = listedCatalog()
	.filter((e) => e.kind === 'a2mcp')
	.map((e) => e.id);

const PAID_FORGE = [
	['forge-draft', '10000', '0.01'],
	['forge-standard', '50000', '0.05'],
	['forge-hd', '250000', '0.25'],
	['forge-image', '250000', '0.25'],
];

describe('the listed line-up is the forge', () => {
	it('validates, and every listed row is a forge row or a free discovery row', () => {
		expect(validateCatalog()).toBe(true);
		const listed = listedCatalog().map((e) => e.id);
		expect(listed).toEqual([...FORGE_SERVICE_IDS, 'catalog', 'health']);
	});

	it('keeps every back-burner row deployed but out of the listing', () => {
		const unlisted = OKX_CATALOG.filter((e) => !e.listed).map((e) => e.id);
		expect(unlisted).toContain('identity-studio');
		expect(unlisted).toContain('text-to-3d');
		// Back burner is a listing decision, not a deletion: the rows still exist.
		for (const id of unlisted) expect(catalogEntry(id).endpoint).toMatch(/^https:\/\/three\.ws\//);
	});

	it('prices each paid row from its own catalog entry, and prices the free row at nothing', () => {
		for (const [id, atomics, usd] of PAID_FORGE) {
			expect(catalogEntry(id).priceUsd).toBe(usd);
			expect(forgeSurface(id).x402Amount(FORGE_TOOL)).toBe(atomics);
			expect(forgeSurface(id).x402Amount(FORGE_STATUS_TOOL)).toBe(null);
			expect(forgeSurface(id).x402Amount('getting_started')).toBe(null);
		}
		expect(forgeSurface('forge-status').x402Amount(FORGE_TOOL)).toBe(null);
	});

	// A buyer that pays for a model receives a URL it cannot open. look_at_model
	// renders it into MCP image blocks, free, on every endpoint: the buyer sees
	// what it bought. No other seller on this marketplace can do that.
	it('gives every endpoint the free look_at_model tool, priced at nothing', () => {
		for (const id of FORGE_SERVICE_IDS) {
			const surface = forgeSurface(id);
			expect(surface.TOOL_CATALOG.map((t) => t.name)).toContain('look_at_model');
			expect(surface.isPublicTool('look_at_model')).toBe(true);
			expect(surface.x402Amount('look_at_model')).toBe(null);
		}
	});

	it('exposes one client shape: the same tool names on every endpoint', () => {
		for (const [id] of PAID_FORGE) {
			const names = forgeSurface(id).TOOL_CATALOG.map((t) => t.name);
			expect(names).toContain(FORGE_TOOL);
			expect(names).toContain(FORGE_STATUS_TOOL);
			expect(names).toContain('getting_started');
		}
		// The free row sells nothing, so it must not advertise a paid tool.
		expect(forgeSurface('forge-status').TOOL_CATALOG.map((t) => t.name)).not.toContain(FORGE_TOOL);
	});
});

describe('402 challenge: the OKX Agent Payments Protocol integration', () => {
	for (const [id, atomics] of PAID_FORGE) {
		it(`${id}: an unpaid ${FORGE_TOOL} call 402s at its own price, leading with eip155:196`, async () => {
			const args = id === 'forge-image' ? { image_urls: ['https://three.ws/og/three-ws.png'] } : { prompt: 'a low-poly fox' };
			const res = await post(id, rpc(FORGE_TOOL, args));
			expect(res.statusCode).toBe(402);
			const challenge = JSON.parse(res.body);
			// OKX buyer CLIs auto-select accepts[0]; if it is not X Layer they cannot pay.
			expect(challenge.accepts[0].network).toBe('eip155:196');
			expect(challenge.accepts[0].scheme).toBe('exact');
			expect(challenge.accepts[0].amount).toBe(atomics);
			expect(challenge.accepts[0].asset.toLowerCase()).toBe('0x779ded0c9e1022225f8e0630b35a9b54be713736');
			// Non-OKX agents can still pay on the legacy rails.
			expect(challenge.accepts.slice(1).some((a) => a.network !== 'eip155:196')).toBe(true);
			// Nothing was generated for an unpaid call.
			expect(submitted).toHaveLength(0);
		});
	}

	it('the 402 envelope teaches a buyer to call THIS server, not another one', async () => {
		const res = await post('forge-draft', rpc(FORGE_TOOL, { prompt: 'a low-poly fox' }));
		const challenge = JSON.parse(res.body);
		const wire = JSON.stringify(challenge);
		expect(wire).toContain(FORGE_TOOL);
		expect(wire).toContain(FORGE_STATUS_TOOL);
		expect(challenge.extensions?.bazaar?.info?.input?.body?.params?.name).toBe(FORGE_TOOL);
	});

	// paymentRequirements() already emits the X Layer rail when it is configured,
	// and the endpoint prepends it again so it LEADS. Prepending alone shipped the
	// same rail twice in accepts[], which is the first thing a marketplace
	// reviewer reads. accepts[] must now name each rail once.
	it('advertises each rail exactly once', async () => {
		const res = await post('forge-draft', rpc(FORGE_TOOL, { prompt: 'a low-poly fox' }));
		const { accepts } = JSON.parse(res.body);
		const keys = accepts.map((a) => `${a.scheme}|${a.network}|${a.asset}|${a.amount}|${a.payTo}`);
		expect(new Set(keys).size).toBe(keys.length);
		expect(accepts[0].network).toBe('eip155:196');
	});

	// The A2MCP guide's own compliance self-check is `curl -i -X POST <endpoint>`:
	// no request body, no content-type, and its stated pass condition for a paid
	// row is "HTTP 402 + PAYMENT-REQUIRED". readJson() rejected exactly that
	// probe with 415 before any payment logic ran, so OKX's listing validator
	// read four live paid rows as having no x402 quotation at all and never
	// reached the payment stage (review 2026-09-04).
	for (const [id, atomics] of PAID_FORGE) {
		it(`${id}: the documented self-check POST (no body, no content-type) answers 402, not 415`, async () => {
			const req = makeReq({ service: id });
			delete req.headers['content-type'];
			const res = makeRes();
			await handler(req, res);
			expect(res.statusCode).toBe(402);
			expect(res.headers['payment-required']).toBeTruthy();
			const challenge = JSON.parse(res.body);
			expect(challenge.x402Version).toBe(2);
			expect(challenge.accepts[0].network).toBe('eip155:196');
			expect(challenge.accepts[0].amount).toBe(atomics);
			expect(submitted).toHaveLength(0);
		});
	}

	// Any POST that names no priced tool (an empty body, a plain business
	// payload, a typo'd tool name) priced as null, and paymentRequirements()
	// then fell back to the platform-wide default. The challenge went out
	// quoting eip155:196 TWICE at two different amounts, the catalog price and
	// $0.001, an ambiguous quotation the OKX validator reads as non-compliant.
	for (const body of [{}, { prompt: 'a low-poly fox' }, rpc('not_a_tool', {})]) {
		it(`an unpriced POST (${JSON.stringify(body).slice(0, 32)}) quotes one price per rail, the list price`, async () => {
			const res = await post('forge-hd', body);
			expect(res.statusCode).toBe(402);
			const { accepts } = JSON.parse(res.body);
			expect(accepts[0].network).toBe('eip155:196');
			// One quotation per rail, and every rail quotes THIS row's price.
			// ($THREE prices the same call in its own token, so it is judged on
			// naming its rail once rather than on the USD-atomic amount.)
			const rails = accepts.map((a) => `${a.scheme}|${a.network}|${a.asset}`);
			expect(new Set(rails).size).toBe(rails.length);
			for (const a of accepts.filter((x) => !/pump$/.test(x.asset))) {
				expect(a.amount ?? a.maxAmountRequired).toBe('250000');
			}
			expect(submitted).toHaveLength(0);
		});
	}

	// Unparseable bytes must not become a silent empty batch. On a paid row the
	// paywall answers first; on the free row the caller gets the JSON-RPC parse
	// error it earned, and nothing is dispatched.
	it('answers unparseable bytes with the paywall on a paid row and a parse error on the free row', async () => {
		const paid = makeRes();
		const paidReq = Readable.from([Buffer.from('not json at all', 'utf8')]);
		Object.assign(paidReq, {
			method: 'POST',
			url: '/api/okx/3d/forge-draft',
			query: { service: 'forge-draft' },
			headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
		});
		await handler(paidReq, paid);
		expect(paid.statusCode).toBe(402);

		const free = makeRes();
		const freeReq = Readable.from([Buffer.from('not json at all', 'utf8')]);
		Object.assign(freeReq, {
			method: 'POST',
			url: '/api/okx/3d/forge-status',
			query: { service: 'forge-status' },
			headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
		});
		await handler(freeReq, free);
		expect(free.statusCode).toBe(200);
		expect(JSON.parse(free.body).error.code).toBe(-32700);
		expect(submitted).toHaveLength(0);
	});

	// A payment header we cannot decode is still a caller trying to pay, and the
	// only thing it can do next is read the quotation again. OKX's own seller
	// SDK answers an undecodable PAYMENT-SIGNATURE with a fresh 402; ours
	// answered a bare 400 whose body carried no accepts[] at all, the one
	// response on the paid path with nothing to parse.
	for (const header of ['not-base64-at-all!!', Buffer.from('notjson', 'utf8').toString('base64')]) {
		it(`an undecodable PAYMENT-SIGNATURE (${header.slice(0, 12)}) re-issues the quotation, never a bare 400`, async () => {
			const res = makeRes();
			await handler(
				makeReq({
					service: 'forge-draft',
					body: rpc(FORGE_TOOL, { prompt: 'a low-poly fox' }),
					headers: { 'payment-signature': header },
				}),
				res,
			);
			expect(res.statusCode).toBe(402);
			expect(res.headers['payment-required']).toBeTruthy();
			const challenge = JSON.parse(res.body);
			expect(challenge.x402Version).toBe(2);
			expect(challenge.accepts[0].network).toBe('eip155:196');
			expect(challenge.accepts[0].amount).toBe('10000');
			expect(challenge.error).toMatch(/PAYMENT|JSON|decode/i);
			expect(submitted).toHaveLength(0);
		});
	}

	// GET is the discovery challenge a reviewer opens first. paymentRequirements()
	// was quoting the shared default there while the prepended rail quoted the
	// real price, so the same rail appeared twice at two different amounts and a
	// buyer could not tell what the endpoint charges.
	it('the GET discovery challenge quotes the endpoint price once per rail', async () => {
		const res = makeRes();
		await handler(makeReq({ method: 'GET', service: 'forge-hd' }), res);
		expect(res.statusCode).toBe(402);
		const { accepts } = JSON.parse(res.body);
		expect(accepts[0].network).toBe('eip155:196');
		for (const a of accepts) expect(a.amount ?? a.maxAmountRequired).toBe('250000');
		const rails = accepts.map((a) => `${a.scheme}|${a.network}|${a.asset}`);
		expect(new Set(rails).size).toBe(rails.length);
	});

	// The OKX buyer flow: "if it is not 402, return the body directly". A
	// spec-compliant MCP client sends Accept: application/json, text/event-stream
	// and mcp-protocol-version, which the shared servers answer with an OAuth 401.
	// That is a 401 no OKX buyer can pay and no reviewer reads as integrated.
	it('a real MCP client gets 402 with the OKX header, never an OAuth 401', async () => {
		for (const headers of [
			{ accept: 'application/json, text/event-stream' },
			{ 'mcp-protocol-version': '2025-06-18' },
		]) {
			const res = makeRes();
			await handler(makeReq({ service: 'forge-standard', headers, body: rpc(FORGE_TOOL, { prompt: 'a fox' }) }), res);
			expect(res.statusCode).toBe(402);
			expect(res.headers['www-authenticate']).toBeUndefined();
			expect(res.headers['payment-required']).toBeTruthy();
			expect(JSON.parse(res.body).accepts[0].network).toBe('eip155:196');
		}
		const sse = makeRes();
		await handler(makeReq({ method: 'GET', service: 'forge-standard', headers: { accept: 'text/event-stream' } }), sse);
		expect(sse.statusCode).toBe(402);
	});

	// The 2026-09-02 review rejected the listing as "missing a complete
	// description, parameter details, and usage examples". It was not the copy:
	// discovery itself was paywalled. Free discovery was scoped to non-protocol
	// clients (an OAuth-capable client must meet the 401 on initialize on the
	// platform's other MCP surfaces), but this surface forces 402 and has no
	// OAuth, so a spec-compliant MCP client, the only kind a reviewer probes an
	// A2MCP listing with, was answered 402 on initialize and tools/list and
	// could never read a single tool description or parameter schema. curl
	// sends neither header and was served 200, which is why every earlier
	// verification pass missed it.
	it('a real MCP client can discover every endpoint without paying', async () => {
		const mcpHeaders = [
			{ accept: 'application/json, text/event-stream' },
			{ 'mcp-protocol-version': '2025-06-18' },
			{ 'mcp-session-id': 'sess-1' },
		];
		for (const id of LISTED_IDS) {
			for (const headers of mcpHeaders) {
				for (const method of ['initialize', 'tools/list', 'ping']) {
					const res = makeRes();
					await handler(makeReq({ service: id, headers, body: { jsonrpc: '2.0', id: 1, method } }), res);
					expect(res.statusCode, `${id} ${method} ${JSON.stringify(headers)}`).toBe(200);
					expect(res.headers['payment-required']).toBeUndefined();
				}
			}
		}
	});

	// Discovery being free is only useful if what it returns is what the review
	// asked for: every tool named, described, and carrying a typed schema for
	// each argument.
	it('tools/list hands a reviewer the parameter details for every tool', async () => {
		for (const id of LISTED_IDS) {
			const res = makeRes();
			await handler(
				makeReq({
					service: id,
					headers: { 'mcp-protocol-version': '2025-06-18' },
					body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
				}),
				res,
			);
			const tools = JSON.parse(res.body).result.tools;
			expect(tools.length, id).toBeGreaterThan(0);
			for (const tool of tools) {
				expect(tool.name, id).toBeTruthy();
				expect(String(tool.description || '').length, `${id}/${tool.name}`).toBeGreaterThan(20);
				const props = tool.inputSchema?.properties || {};
				for (const [arg, schema] of Object.entries(props)) {
					expect(schema.type, `${id}/${tool.name}/${arg}`).toBeTruthy();
				}
			}
		}
	});

	// Paid work is not discovery, and must stay behind the 402 for the same
	// clients that now discover freely.
	it('still charges a protocol client for the paid tool', async () => {
		for (const [id] of PAID_FORGE) {
			const res = makeRes();
			await handler(
				makeReq({
					service: id,
					headers: { accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
					body: rpc(FORGE_TOOL, { prompt: 'a low-poly orange fox' }),
				}),
				res,
			);
			expect(res.statusCode, id).toBe(402);
			expect(JSON.parse(res.body).accepts[0].network).toBe('eip155:196');
		}
	});

	it('free tools need no payment on a paid endpoint', async () => {
		const res = await post('forge-draft', rpc('getting_started', {}));
		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.body).result.isError).toBeFalsy();
	});

	it('the free status endpoint never 402s', async () => {
		lane.poll = () => jsonResponse(200, { status: 'running' });
		const res = await post('forge-status', rpc(FORGE_STATUS_TOOL, { job_id: 'f1.job.abc' }));
		expect(res.statusCode).toBe(200);
		// ...including on GET, which a reviewer probes first: a free row answering
		// its discovery GET with a priced 402 reads as a paid service.
		const get = makeRes();
		await handler(makeReq({ method: 'GET', service: 'forge-status' }), get);
		expect(get.statusCode).toBe(405);
		expect(get.headers.allow).toBe('POST, DELETE');
	});

	// The reviewer sweep runs ONE body across every listed endpoint, so the free
	// row is asked for the paid tool it does not serve. That priced as null and
	// matched no explicit free name, so it fell through to a 402 whose X Layer
	// accept quoted an amount of the literal string "null": a free service
	// demanding an unpayable payment, on the row a reviewer reaches last.
	it('the free status endpoint answers the paid tool it does not serve with an error, not a 402', async () => {
		const res = await post('forge-status', rpc(FORGE_TOOL, { prompt: 'a low-poly orange fox' }));
		expect(res.statusCode).not.toBe(402);
		expect(res.headers['payment-required']).toBeUndefined();
		const out = JSON.parse(res.body);
		expect(out.error?.message || out.result?.content?.[0]?.text || '').toMatch(/unknown|not found|unsupported/i);
	});

	it('no accept ever advertises an amount of "null"', async () => {
		for (const id of [...PAID_FORGE.map(([rowId]) => rowId), 'forge-status']) {
			const res = await post(id, rpc(FORGE_TOOL, { prompt: 'a low-poly orange fox' }));
			if (res.statusCode !== 402) continue;
			for (const accept of JSON.parse(res.body).accepts) {
				expect(accept.amount).toMatch(/^[0-9]+$/);
			}
		}
	});
});

describe('what a buying agent actually receives', () => {
	it('a queued job comes back with a pollable handle and the free tool that reads it', async () => {
		const out = await callTool('forge-draft', FORGE_TOOL, { prompt: 'a low-poly orange fox' });
		expect(out.isError).toBeFalsy();
		expect(out.structuredContent.status).toBe('pending');
		expect(out.structuredContent.job).toBe('f1.job.abc');
		expect(out.structuredContent.poll_tool).toBe(FORGE_STATUS_TOOL);
		expect(out.structuredContent.poll_endpoint).toBe('https://three.ws/api/okx/3d/forge-status');
		expect(out.structuredContent.etaSeconds).toBe(45);
	});

	it('a finished job carries the GLB, the browser viewer, the AR link and the model page', async () => {
		lane.poll = () =>
			jsonResponse(200, {
				status: 'done',
				creation_id: '0b6d2a9e-6f0f-4b1e-9a2c-3d4e5f607182',
				glb_url: 'https://cdn.test/fox.glb',
				preview_image_url: 'https://cdn.test/fox.png',
				tier: 'draft',
			});
		const out = await callTool('forge-status', FORGE_STATUS_TOOL, { job_id: 'f1.job.abc', title: 'a fox' });
		const body = out.structuredContent;
		expect(body.status).toBe('done');
		expect(body.glbUrl).toBe('https://cdn.test/fox.glb');
		expect(body.viewerUrl).toContain('/viewer?src=');
		expect(body.arUrl).toContain('/api/ar?src=');
		expect(body.pageUrl).toBe('https://three.ws/m/0b6d2a9e-6f0f-4b1e-9a2c-3d4e5f607182');
		expect(body.previewImageUrl).toBe('https://cdn.test/fox.png');
		expect(body.format).toBe('glb');
		// The text content is what most agents relay verbatim: every link is in it.
		const text = out.content[0].text;
		for (const link of [body.glbUrl, body.viewerUrl, body.arUrl, body.pageUrl]) expect(text).toContain(link);
	});

	it('titles the viewer and AR pages from the job itself when the buyer passes no title', async () => {
		lane.poll = () =>
			jsonResponse(200, { status: 'done', glb_url: 'https://cdn.test/fox.glb', prompt: 'a low-poly fox' });
		const out = await callTool('forge-status', FORGE_STATUS_TOOL, { job_id: 'f1.job.abc' });
		expect(out.structuredContent.arUrl).toContain('title=a%20low-poly%20fox');
	});

	it('a pending job tells the buyer exactly what to call next', async () => {
		const out = await callTool('forge-standard', FORGE_TOOL, { prompt: 'a low-poly fox' });
		expect(out.structuredContent.poll_arguments).toEqual({ job_id: 'f1.job.abc', title: 'a low-poly fox' });
		expect(out.content[0].text).toContain(FORGE_STATUS_TOOL);
		expect(out.content[0].text).toContain('f1.job.abc');
	});

	it('a failed job is an error the buyer can act on, not a silent pending', async () => {
		lane.poll = () =>
			jsonResponse(200, {
				status: 'failed',
				error: 'upstream lane died',
				retry_backends: ['trellis_selfhost', 'hunyuan3d'],
			});
		const out = await callTool('forge-status', FORGE_STATUS_TOOL, { job_id: 'f1.job.abc' });
		expect(out.isError).toBe(true);
		expect(out.structuredContent.status).toBe('error');
		expect(out.structuredContent.error).toContain('upstream lane died');
		// The alternate engines the generator named reach the buyer, so "an error
		// the buyer can act on" means something the buyer can actually act on.
		expect(out.structuredContent.retryBackends).toEqual(['trellis_selfhost', 'hunyuan3d']);
	});

	// These rows settle when the lane accepts a job, so a generation failure
	// after that point HAS been charged. The shared shaper's free-lane wording
	// ("it costs nothing to try again") is true on /api/3d/studio and false
	// here, and it was being served to paying buyers until 2026-09-02.
	it('a failed job never tells a paying buyer the retry is free', async () => {
		lane.poll = () => jsonResponse(200, { status: 'failed', error: 'upstream lane died' });
		const out = await callTool('forge-status', FORGE_STATUS_TOOL, { job_id: 'f1.job.abc' });
		expect(out.structuredContent.error).not.toContain('costs nothing');
		expect(out.structuredContent.error).toContain('new paid call');
		expect(out.content[0].text).toContain('new paid call');
	});

	it('an unknown job id is reported as unknown_job rather than a generic failure', async () => {
		lane.poll = () => jsonResponse(404, { message: 'no such job' });
		const out = await callTool('forge-status', FORGE_STATUS_TOOL, { job_id: 'f1.nope.xyz' });
		expect(out.isError).toBe(true);
		expect(out.structuredContent.error).toBe('unknown_job');
	});
});

describe('each row drives its own lane', () => {
	it('sends the row tier to the generator, and pins the image lane to reference images', async () => {
		await callTool('forge-draft', FORGE_TOOL, { prompt: 'a fox' });
		expect(submitted.at(-1).tier).toBe('draft');
		await callTool('forge-standard', FORGE_TOOL, { prompt: 'a fox' });
		expect(submitted.at(-1).tier).toBe('standard');
		await callTool('forge-hd', FORGE_TOOL, { prompt: 'a fox' });
		expect(submitted.at(-1).tier).toBe('high');
		await callTool('forge-image', FORGE_TOOL, { image_urls: ['https://cdn.test/a.png'] });
		expect(submitted.at(-1).image_urls).toEqual(['https://cdn.test/a.png']);
		expect(submitted.at(-1).tier).toBeUndefined();
	});

	// The generator hold-gates its high tier. A buyer of the HD row has already
	// paid, so the job runs operator-funded, exactly like the custom GPT runs it.
	it('runs the HD row operator-funded on the generator', async () => {
		process.env.CRON_SECRET = 'seed-for-test';
		let seen;
		globalThis.fetch.mockImplementationOnce(async (input, init) => {
			seen = init.headers;
			submitted.push(JSON.parse(init.body));
			return jsonResponse(200, { job_id: 'f1.job.hd', tier: 'high', eta_seconds: 240 });
		});
		const out = await callTool('forge-hd', FORGE_TOOL, { prompt: 'a fox' });
		expect(seen['x-forge-seed']).toBe('seed-for-test');
		expect(out.structuredContent.status).toBe('pending');
		expect(out.structuredContent.tier).toBe('high');
	});

	// Without this the lane client degraded a refused high job to standard on
	// its own, and the buyer paid the HD price for a standard mesh. The refusal
	// answers before settlement, so nothing is charged.
	it('refuses the HD row BEFORE settlement when the high lane will not take the job', async () => {
		lane.submit = () => jsonResponse(402, { error: 'three_hold_required' });
		const out = await callTool('forge-hd', FORGE_TOOL, { prompt: 'a fox' });
		expect(out.isError).toBe(true);
		expect(out.structuredContent.error).toBe('tier_unavailable');
		expect(out.structuredContent.charged).toBe(false);
		// Exactly one submit, no silent second attempt at a lower tier.
		expect(submitted).toHaveLength(1);
		expect(submitted[0].tier).toBe('high');
	});

	it('refuses the HD row if the lane answers with a lower tier than it was asked for', async () => {
		lane.submit = () => jsonResponse(200, { job_id: 'f1.job.x', tier: 'standard' });
		const out = await callTool('forge-hd', FORGE_TOOL, { prompt: 'a fox' });
		expect(out.isError).toBe(true);
		expect(out.structuredContent.error).toBe('tier_unavailable');
	});

	it('rejects an unsafe prompt BEFORE any generation runs, so it can never settle', async () => {
		const out = await callTool('forge-draft', FORGE_TOOL, { prompt: 'a nude child' });
		expect(out.isError).toBe(true);
		expect(out.structuredContent.error).toBe('prompt_rejected');
		expect(submitted).toHaveLength(0);
	});

	it('turns a saturated generator into an actionable busy error, never a 500', async () => {
		lane.submit = () => jsonResponse(429, { message: 'busy', retry_after: 12 });
		const out = await callTool('forge-draft', FORGE_TOOL, { prompt: 'a fox' });
		expect(out.isError).toBe(true);
		expect(out.structuredContent.error).toBe('busy');
		expect(out.structuredContent.retry_after).toBe(12);
	});
});
