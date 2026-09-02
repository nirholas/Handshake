/**
 * Agent Identity Studio — the OKX.AI flagship A2MCP service
 * (/api/okx/3d/identity-studio, engine in api/_okx3d/identity.js, catalog row
 * in api/_lib/okx-catalog.js).
 *
 * Covers the catalog contract, the per-tool 402 pricing, the free lanes
 * (catalog/health/identity_status), the pipeline state machine over mocked
 * three.ws HTTP surfaces, and the honest edge cases the work order names:
 * Chinese brief, over-long brief (flagged truncation), and an unreachable
 * reference image failing BEFORE any payment settles.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import { encodeAbiParameters, parseAbiParameters } from 'viem';

process.env.PUBLIC_APP_ORIGIN = 'https://three.ws';
process.env.X402_PAY_TO_BASE ||= '0x0000000000000000000000000000000000000001';
process.env.X402_ASSET_ADDRESS_BASE ||= '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
// The OKX X Layer rail — the reason this service exists on OKX.AI. With these
// set, xlayerSettleable() is true and the flagship 402 must lead with eip155:196.
process.env.X402_PAY_TO_XLAYER ||= '0x75d00a2713565171f33216e5aa2a375e076ecf69';
process.env.X402_XLAYER_RELAYER_KEY ||=
	'0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
process.env.JWT_SECRET ||= 'okx-identity-test-secret';
// /health memoizes its subsystem sweep in production; disable the memo by
// default here so each case sees its own probes, and opt back in where the
// cache itself is under test.
process.env.OKX_HEALTH_TTL_MS = '0';

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

// The submit-latency probe reads usage_events; default to an empty window
// (nothing to judge), and let a case install rows of its own.
const usageRows = vi.hoisted(() => ({ rows: [] }));
vi.mock('../../api/_lib/db.js', () => ({
	sql: async () => usageRows.rows,
	isDbUnavailableError: () => false,
}));

vi.mock('../../api/_lib/usage.js', () => ({
	recordEvent: vi.fn(),
	logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
}));

// In-memory R2 so job state round-trips without creds.
const r2Store = new Map();
vi.mock('../../api/_lib/r2.js', () => ({
	putObject: vi.fn(async ({ key, body }) => {
		r2Store.set(key, Buffer.isBuffer(body) ? body : Buffer.from(body));
	}),
	getObjectBuffer: vi.fn(async (key) => {
		if (!r2Store.has(key)) throw new Error('NoSuchKey');
		return r2Store.get(key);
	}),
	headObject: vi.fn(async (key) => {
		if (!r2Store.has(key)) throw new Error('NotFound');
		return { ContentLength: r2Store.get(key).length };
	}),
	publicUrl: (key) => `https://cdn.test/${key}`,
}));

// Reference-image validation calls the real SSRF guard's public-URL check —
// stub it to a pass-through so tests control reachability via fetch alone.
// fetchSafePublicUrlPinned is routed through the fetch router for the same
// reason (the pinned variant opens raw sockets, which the sandbox has no
// egress for).
vi.mock('../../api/_lib/ssrf-guard.js', () => ({
	assertSafePublicUrl: vi.fn(async () => {}),
	fetchSafePublicUrlPinned: vi.fn(async (url, init) => globalThis.fetch(url, init)),
	SsrfBlockedError: class SsrfBlockedError extends Error {},
}));

// The prompt director runs in-process over the shared llm.js free-provider
// chain. Mock it: default is "director unavailable" (throws → fallback template,
// the state a keyless deployment lands in), and a test can install a spy to
// assert what the director was handed or make it return a shaped prompt.
const llmSpy = vi.hoisted(() => ({ fn: null }));
vi.mock('../../api/_lib/llm.js', () => ({
	llmComplete: (...args) =>
		llmSpy.fn ? llmSpy.fn(...args) : Promise.reject(new Error('llm unavailable')),
}));

// The pipeline is a pure HTTP client over three.ws surfaces — mock global
// fetch with a tiny programmable router.
const fetchRoutes = {
	chat: null,
	forgeSubmit: null,
	forgePoll: null,
	rig: null,
	render: null,
	manifest: null,
	rpc: null,
	ref: null,
};
function jsonResponse(status, body) {
	return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
// What GET /api/forge?catalog really answers with: the tier + backend matrix
// the health probe requires before it calls the generation lane up.
const FORGE_CATALOG = {
	paths: ['image', 'geometry'],
	tiers: [{ id: 'draft' }, { id: 'standard' }],
	backends: [{ id: 'trellis' }, { id: 'hunyuan3d' }],
};

// The payment-rail probe drives a real viem public client over chain 196, so
// the only honest seam is the JSON-RPC wire itself. Answer the three calls
// xlayerRailHealth() makes (block height, the fee token's symbol(), the
// relayer's balance) with correctly encoded results.
function jsonRpcBody(init) {
	if (!init?.body || typeof init.body !== 'string') return null;
	try {
		const parsed = JSON.parse(init.body);
		const one = Array.isArray(parsed) ? parsed[0] : parsed;
		return one?.jsonrpc === '2.0' && typeof one.method === 'string' ? one : null;
	} catch {
		return null;
	}
}

const XLAYER_RPC_RESULTS = {
	eth_chainId: '0xc4',
	eth_blockNumber: '0x40c8c01',
	eth_getBalance: '0x2386f26fc10000',
	eth_call: encodeAbiParameters(parseAbiParameters('string'), ['USD₮0']),
	eth_gasPrice: '0x3b9aca00',
};

function healthyXlayerRpc(_url, init) {
	const rpc = jsonRpcBody(init);
	const result = XLAYER_RPC_RESULTS[rpc?.method] ?? '0x';
	return jsonResponse(200, { jsonrpc: '2.0', id: rpc?.id ?? 1, result });
}

// The five subsystems GET /health actually probes: the forge tier/backend
// matrix, the renderer's pose catalog, R2 (the in-memory mock above), the
// animation clip manifest, and the X Layer rail. Mount a healthy shape for
// each so the green path is proven through the real probe plumbing.
function mountHealthyProbes() {
	fetchRoutes.forgeSubmit = () => jsonResponse(200, FORGE_CATALOG);
	fetchRoutes.render = () => jsonResponse(200, { poses: ['idle', 'walk', 'tpose'] });
	fetchRoutes.manifest = () => jsonResponse(200, { animations: [{ id: 'idle' }, { id: 'walk' }] });
	fetchRoutes.rpc = healthyXlayerRpc;
}

const realFetch = globalThis.fetch;
beforeEach(() => {
	r2Store.clear();
	fetchRoutes.chat = () => new Response(null, { status: 503 }); // legacy: nothing calls /api/chat now
	llmSpy.fn = null; // default: director unavailable → deterministic fallback template
	fetchRoutes.forgeSubmit = () => jsonResponse(200, { job_id: 'forge-gen-1', status: 'queued', eta: 30 });
	fetchRoutes.forgePoll = () => jsonResponse(200, { status: 'running' });
	fetchRoutes.rig = () => jsonResponse(200, { job_id: 'forge-rig-1', status: 'queued' });
	fetchRoutes.render = () => new Response(new Uint8Array(MODEL_PNG), { status: 200 });
	fetchRoutes.manifest = () => jsonResponse(200, { animations: [{ id: 'idle' }] });
	// Default: no rail. A case that wants a green payment-rail probe calls
	// mountHealthyProbes().
	fetchRoutes.rpc = () => new Response('rpc unavailable', { status: 503 });
	fetchRoutes.ref = () => new Response(new Uint8Array([0xff]), { status: 206, headers: { 'content-type': 'image/png' } });
	globalThis.fetch = vi.fn(async (url, init = {}) => {
		const u = String(url);
		if (u.includes('/api/chat')) return fetchRoutes.chat(u, init);
		if (u.includes('/api/forge?action=rig')) return fetchRoutes.rig(u, init);
		if (u.includes('/api/forge?job=')) return fetchRoutes.forgePoll(u, init);
		if (u.includes('/api/forge')) return fetchRoutes.forgeSubmit(u, init);
		if (u.includes('/api/render/avatar-clip')) return fetchRoutes.render(u, init);
		if (u.includes('/animations/manifest.json')) return fetchRoutes.manifest(u, init);
		if (jsonRpcBody(init)) return fetchRoutes.rpc(u, init);
		return fetchRoutes.ref(u, init);
	});
	return () => {
		globalThis.fetch = realFetch;
	};
});

// Synthetic "transparent render": a standing-rectangle model on a transparent
// 128×128 canvas, so the trim → head-crop → composite path runs for real.
const { default: _sharp } = await import('sharp');
const MODEL_PNG = await _sharp(
	Buffer.from(
		'<svg width="128" height="128" xmlns="http://www.w3.org/2000/svg">' +
			'<rect x="48" y="12" width="32" height="104" fill="#c04040"/></svg>',
		'utf8',
	),
)
	.png()
	.toBuffer();

const { OKX_CATALOG, validateCatalog, catalogIndex, listedCatalog, displayWidth, DESCRIPTION_MAX_WIDTH } =
	await import('../../api/_lib/okx-catalog.js');
const tools = await import('../../api/_okx3d/tools.js');
const identity = await import('../../api/_okx3d/identity.js');
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

function makeReq({ method = 'POST', service = 'identity-studio', headers = {}, body = null } = {}) {
	const payload = body == null ? '' : JSON.stringify(body);
	const req = Readable.from(payload ? [Buffer.from(payload, 'utf8')] : []);
	req.method = method;
	req.url = `/api/okx/3d/${service}`;
	req.query = { service };
	req.headers = {
		'content-type': 'application/json',
		'x-forwarded-for': '203.0.113.9',
		...headers,
	};
	return req;
}

const anonAuth = { userId: null, rateKey: null, scope: '', source: 'free' };
async function call(name, args) {
	return tools.dispatch(
		{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
		anonAuth,
		{ headers: {} },
	);
}

describe('okx catalog module', () => {
	it('validates: every entry well-formed, prices consistent, descriptions within OKX display width', () => {
		expect(validateCatalog()).toBe(true);
		for (const e of OKX_CATALOG) {
			expect(displayWidth(e.describes.capability)).toBeLessThanOrEqual(DESCRIPTION_MAX_WIDTH);
			expect(displayWidth(e.describes.input)).toBeLessThanOrEqual(DESCRIPTION_MAX_WIDTH);
		}
	});

	it('counts East-Asian wide glyphs as 2 (the OKX listing rule)', () => {
		expect(displayWidth('abc')).toBe(3);
		expect(displayWidth('中文字')).toBe(6);
		expect(displayWidth('a中b')).toBe(4);
	});

	it('prices identity-studio at $1.50 = 1500000 atomics and keeps it on the back burner', () => {
		const row = OKX_CATALOG.find((e) => e.id === 'identity-studio');
		expect(row.amountAtomics).toBe('1500000');
		expect(tools.identityX402Amount('create_identity')).toBe('1500000');
		expect(tools.identityX402Amount('identity_status')).toBe(null);
		expect(tools.identityX402Amount('getting_started')).toBe(null);
		// Unlisted since the 2026-08-22 rebuild: still deployed and payable, just
		// not part of the OKX.AI submission.
		expect(row.listed).toBe(false);
		const index = catalogIndex();
		expect(index.services.map((s) => s.id)).toEqual(listedCatalog().map((e) => e.id));
		expect(index.unlisted.find((s) => s.id === 'identity-studio').price_usd).toBe('1.50');
	});
});

describe('free lanes over HTTP', () => {
	it('GET /catalog returns the index with no payment', async () => {
		const res = makeRes();
		await handler(makeReq({ method: 'GET', service: 'catalog' }), res);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.okxAgentId).toBe(2632);
		expect(body.services.length).toBe(listedCatalog().length);
		expect(body.services.length + body.unlisted.length).toBe(OKX_CATALOG.length);
	});

	it('GET /health runs real probes and reports per-subsystem status', async () => {
		mountHealthyProbes();
		const res = makeRes();
		await handler(makeReq({ method: 'GET', service: 'health' }), res);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.ok).toBe(true);
		expect(body.subsystems.map((s) => s.name).sort()).toEqual([
			'generation',
			'payment-rail',
			'render',
			'retarget',
			'storage',
			'submit-latency',
		]);
		const rail = body.subsystems.find((s) => s.name === 'payment-rail');
		expect(rail.token).toBe('USD₮0');
	});

	it('GET /health goes 503 when a subsystem is down — never a hardcoded ok', async () => {
		fetchRoutes.render = () => new Response(null, { status: 500 });
		fetchRoutes.forgeSubmit = () => jsonResponse(200, FORGE_CATALOG);
		const res = makeRes();
		await handler(makeReq({ method: 'GET', service: 'health' }), res);
		expect(res.statusCode).toBe(503);
		expect(JSON.parse(res.body).ok).toBe(false);
	});

	// The static generation probe read all-green on 2026-08-25 while every text
	// submit hung for 95 s+. The submit-latency probe judges the last hour of
	// REAL forge_3d calls instead, so a stalled lane shows up here.
	it('GET /health goes 503 when recent real submits are slow, even with every static probe green', async () => {
		mountHealthyProbes();
		usageRows.rows = [{ samples: 5, errors: 0, p50_ms: 96_000, p90_ms: 150_000 }];
		try {
			const res = makeRes();
			await handler(makeReq({ method: 'GET', service: 'health' }), res);
			expect(res.statusCode).toBe(503);
			const probe = JSON.parse(res.body).subsystems.find((s) => s.name === 'submit-latency');
			expect(probe.ok).toBe(false);
			expect(probe.p50_ms).toBe(96_000);
			expect(probe.error).toContain('median submit');
		} finally {
			usageRows.rows = [];
		}
	});

	it('GET /health reports an empty submit window as nothing to judge, not as a failure', async () => {
		mountHealthyProbes();
		const res = makeRes();
		await handler(makeReq({ method: 'GET', service: 'health' }), res);
		const probe = JSON.parse(res.body).subsystems.find((s) => s.name === 'submit-latency');
		expect(probe.ok).toBe(true);
		expect(probe.samples).toBe(0);
	});

	// The generation probe used to GET /api/forge bare, which answers 400
	// missing_job whether the lane is healthy or not — it only failed on a 5xx.
	// It now reads ?catalog and requires a real tier + backend matrix.
	it('GET /health fails generation on an empty forge catalog, not just on a 5xx', async () => {
		fetchRoutes.forgeSubmit = (u) => {
			expect(String(u)).toContain('/api/forge?catalog');
			return jsonResponse(200, { tiers: [], backends: [] });
		};
		const res = makeRes();
		await handler(makeReq({ method: 'GET', service: 'health' }), res);
		expect(res.statusCode).toBe(503);
		const generation = JSON.parse(res.body).subsystems.find((s) => s.name === 'generation');
		expect(generation.ok).toBe(false);
		expect(generation.error).toContain('empty');
	});

	// /health is free, unauthenticated, and fans out to five subsystems, so the
	// report is memoized for OKX_HEALTH_TTL_MS: a poll loop costs one sweep per
	// window, not one per request.
	it('GET /health memoizes the sweep within the TTL window', async () => {
		mountHealthyProbes();
		// First call with the memo off, so this case sweeps for real and seeds a
		// reading of its own instead of inheriting an earlier test's.
		const first = makeRes();
		await handler(makeReq({ method: 'GET', service: 'health' }), first);
		const probesAfterFirst = globalThis.fetch.mock.calls.length;
		expect(probesAfterFirst).toBeGreaterThan(0);

		process.env.OKX_HEALTH_TTL_MS = '60000';
		try {
			const second = makeRes();
			await handler(makeReq({ method: 'GET', service: 'health' }), second);
			expect(globalThis.fetch.mock.calls.length).toBe(probesAfterFirst);
			expect(JSON.parse(second.body).checkedAt).toBe(JSON.parse(first.body).checkedAt);
			expect(second.headers['cache-control']).toBe('public, max-age=15, s-maxage=30');
		} finally {
			process.env.OKX_HEALTH_TTL_MS = '0';
		}
	});

	it('unknown service 404s with the service index', async () => {
		const res = makeRes();
		await handler(makeReq({ method: 'GET', service: 'nope' }), res);
		expect(res.statusCode).toBe(404);
		expect(JSON.parse(res.body).services.length).toBeGreaterThan(0);
	});
});

describe('402 challenge and pricing', () => {
	it('unpaid create_identity gets a 402 advertising exactly $1.50', async () => {
		const res = makeRes();
		await handler(
			makeReq({
				body: {
					jsonrpc: '2.0',
					id: 1,
					method: 'tools/call',
					params: { name: 'create_identity', arguments: { agent_name: 'X', brief: 'a data agent' } },
				},
			}),
			res,
		);
		expect(res.statusCode).toBe(402);
		const challenge = JSON.parse(res.body);
		expect(challenge.accepts.length).toBeGreaterThan(0);
		for (const a of challenge.accepts) {
			expect(a.maxAmountRequired ?? a.amount ?? a.maxAmount).toBe('1500000');
		}
		expect(JSON.stringify(challenge)).toContain('identity-studio');
	});

	it('the 402 LEADS with the OKX X Layer (eip155:196) accept — the flagship must be OKX-payable', async () => {
		const res = makeRes();
		await handler(
			makeReq({
				body: {
					jsonrpc: '2.0',
					id: 1,
					method: 'tools/call',
					params: { name: 'create_identity', arguments: { agent_name: 'X', brief: 'a data agent' } },
				},
			}),
			res,
		);
		expect(res.statusCode).toBe(402);
		const challenge = JSON.parse(res.body);
		// First accept is the X Layer rail (OKX buyer CLIs auto-select accepts[0]).
		expect(challenge.accepts[0].network).toBe('eip155:196');
		expect(challenge.accepts[0].scheme).toBe('exact');
		expect(challenge.accepts[0].amount).toBe('1500000');
		expect(challenge.accepts[0].asset.toLowerCase()).toBe('0x779ded0c9e1022225f8e0630b35a9b54be713736');
		// The legacy rails still follow, so non-OKX agents can pay too (Base here).
		expect(challenge.accepts.length).toBeGreaterThan(1);
		expect(challenge.accepts.slice(1).some((a) => a.network !== 'eip155:196')).toBe(true);
	});

	// The 402 envelope is how a buying agent learns to call this server. It used
	// to inherit build402Body's default bazaar entry, which describes the main
	// /api/mcp server and told buyers to call validate_model — a tool this
	// dispatcher does not have, so an agent that followed it paid $1.50 and then
	// sent a call that could only be rejected.
	it('the 402 bazaar extension describes THIS server: create_identity, never validate_model', async () => {
		const res = makeRes();
		await handler(
			makeReq({
				body: {
					jsonrpc: '2.0',
					id: 1,
					method: 'tools/call',
					params: { name: 'create_identity', arguments: { agent_name: 'X', brief: 'a data agent' } },
				},
			}),
			res,
		);
		expect(res.statusCode).toBe(402);
		const challenge = JSON.parse(res.body);
		const bazaar = challenge.extensions.bazaar;
		expect(bazaar.discoverable).toBe(true);
		expect(bazaar.info.input.method).toBe('POST');
		expect(bazaar.info.input.body.params.name).toBe('create_identity');
		// The advertised example arguments must satisfy the tool's real schema.
		const validateArgs = tools.TOOLS.create_identity.validate;
		expect(validateArgs(bazaar.info.input.body.params.arguments)).toBe(true);
		expect(bazaar.info.output.example.result.structuredContent.poll_tool).toBe('identity_status');
		const advertised = JSON.stringify(bazaar);
		expect(advertised).not.toContain('validate_model');
		for (const name of ['create_identity', 'identity_status', 'getting_started']) {
			expect(advertised).toContain(name);
		}
	});

	it('the 402 resource metadata keeps the okx tag inside the 5-tag Bazaar cap', async () => {
		const res = makeRes();
		await handler(
			makeReq({
				body: {
					jsonrpc: '2.0',
					id: 1,
					method: 'tools/call',
					params: { name: 'create_identity', arguments: { agent_name: 'X', brief: 'a data agent' } },
				},
			}),
			res,
		);
		const { resource } = JSON.parse(res.body);
		expect(resource.serviceName).toBe('three.ws Agent Identity Studio');
		expect(resource.tags.length).toBeLessThanOrEqual(5);
		expect(resource.tags).toContain('okx');
	});

	// priceBatch sums every priced tools/call so one X-PAYMENT must cover the
	// whole batch. The X Layer accept leads accepts[] and verifyPayment selects
	// by network, so pinning that entry to the single-identity list price let an
	// OKX buyer run a 16-call batch for one identity's price. It must quote the
	// same total the platform rails quote.
	it('a batched create_identity prices the X Layer accept at the batch total, not one identity', async () => {
		const res = makeRes();
		const callFor = (id) => ({
			jsonrpc: '2.0',
			id,
			method: 'tools/call',
			params: { name: 'create_identity', arguments: { agent_name: `A${id}`, brief: 'a data agent' } },
		});
		await handler(makeReq({ body: [callFor(1), callFor(2), callFor(3)] }), res);
		expect(res.statusCode).toBe(402);
		const challenge = JSON.parse(res.body);
		expect(challenge.accepts[0].network).toBe('eip155:196');
		// 3 × $1.50 = $4.50, and every rail quotes the same number.
		for (const a of challenge.accepts) {
			expect(a.maxAmountRequired ?? a.amount ?? a.maxAmount).toBe('4500000');
		}
	});

	// A batch with nothing priced has no total to quote, so the challenge falls
	// back to the list price it advertises in the catalog and on the SSE lane.
	// Probed with a tools/call rather than a tools/list: discovery (initialize,
	// tools/list, ping) is now free for every caller on this surface, protocol
	// clients included, so a tools/list no longer challenges at all. An unknown
	// tool name is the honest unpriced-but-billable case this fallback exists
	// for, and it must never be served free on a row that sells.
	it('an unpriced batch still challenges at the single-identity list price', async () => {
		const res = makeRes();
		await handler(
			makeReq({
				headers: { 'mcp-protocol-version': '2025-06-18' },
				body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } },
			}),
			res,
		);
		// An MCP protocol client still gets 402 here, never the OAuth 401 the
		// shared servers issue: the OKX buyer flow keys strictly on 402, and a
		// spec-compliant MCP client (Accept: text/event-stream) is exactly the
		// caller a marketplace reviewer uses.
		expect(res.statusCode).toBe(402);
		expect(res.headers['www-authenticate']).toBeUndefined();
		expect(res.headers['payment-required']).toBeTruthy();
		const challenge = JSON.parse(res.body);
		expect(challenge.accepts[0].network).toBe('eip155:196');
		expect(challenge.accepts[0].amount).toBe('1500000');
	});

	it('identity_status is free — served anonymously, no 402', async () => {
		const res = makeRes();
		await handler(
			makeReq({
				body: {
					jsonrpc: '2.0',
					id: 2,
					method: 'tools/call',
					params: { name: 'identity_status', arguments: { job_id: 'garbage' } },
				},
			}),
			res,
		);
		expect(res.statusCode).toBe(200);
		const rpc = JSON.parse(res.body);
		expect(rpc.result.isError).toBe(true); // invalid token — but no payment demanded
		expect(rpc.result.structuredContent.error).toBe('invalid_job_id');
	});

	it('getting_started lists both tools with the paid price', async () => {
		const rpc = await call('getting_started', {});
		const text = JSON.stringify(rpc.result.structuredContent);
		expect(text).toContain('create_identity');
		expect(text).toContain('identity_status');
		expect(text).toContain('1.5');
	});
});

describe('pipeline state machine', () => {
	it('create → generate → rig → renders → done, with real deliverable shapes', async () => {
		const created = await call('create_identity', {
			agent_name: 'LedgerLynx',
			brief: 'a meticulous on-chain accounting agent, calm and precise',
		});
		expect(created.result.isError).toBeUndefined();
		const jobId = created.result.structuredContent.job_id;
		expect(jobId).toMatch(/^f1\./);

		// generation still running
		let s = await call('identity_status', { job_id: jobId });
		expect(s.result.structuredContent.status).toBe('running');
		expect(s.result.structuredContent.stage).toBe('generate');

		// generation done → same poll submits the rig
		fetchRoutes.forgePoll = () => jsonResponse(200, { status: 'done', glb_url: 'https://cdn.test/mesh.glb' });
		s = await call('identity_status', { job_id: jobId });
		expect(s.result.structuredContent.stage).toBe('rig');

		// rig done → render stage, one render per poll
		fetchRoutes.forgePoll = () => jsonResponse(200, { status: 'done', glb_url: 'https://cdn.test/rigged.glb' });
		s = await call('identity_status', { job_id: jobId });
		expect(s.result.structuredContent.stage).toBe('render');

		let last;
		for (let i = 0; i < 8 && (!last || last.status !== 'done'); i++) {
			const r = await call('identity_status', { job_id: jobId });
			last = r.result.structuredContent;
		}
		expect(last.status).toBe('done');
		const d = last.deliverables;
		expect(d.pfp.url).toContain('okx-identity/renders/');
		expect(d.pfp.preview_128_url).toContain('pfp-128');
		expect(d.full_body.length).toBe(3);
		expect(new Set(d.full_body.map((f) => f.pose)).size).toBe(3);
		expect(d.rigged_glb_url).toBe('https://cdn.test/rigged.glb');
		expect(d.viewer_url).toContain('/viewer?src=');
	}, 30_000);

	it('generation failure retries free, then fails honestly when attempts exhaust', async () => {
		const created = await call('create_identity', { agent_name: 'X', brief: 'test agent brief' });
		const jobId = created.result.structuredContent.job_id;
		let submits = 1; // the create call already submitted once
		const origSubmit = fetchRoutes.forgeSubmit;
		fetchRoutes.forgeSubmit = (...a) => {
			submits += 1;
			return origSubmit(...a);
		};
		fetchRoutes.forgePoll = () => jsonResponse(200, { status: 'failed', error: 'lane exploded' });
		// fail → free resubmit → fail → free resubmit → fail → terminal (3 submissions total)
		let s;
		for (let i = 0; i < 10 && s?.result?.structuredContent?.status !== 'failed'; i++) {
			s = await call('identity_status', { job_id: jobId });
		}
		expect(s.result.structuredContent.status).toBe('failed');
		expect(s.result.isError).toBe(true);
		expect(s.result.structuredContent.last_error.message).toContain('lane exploded');
		expect(submits).toBe(3);
	});

	it('a Chinese brief is accepted and reaches the prompt director verbatim', async () => {
		let directorSaw = null;
		// Director available but returns nothing usable → capture the input, then
		// fall back. Proves the raw brief + the English-output instruction reach it.
		llmSpy.fn = async ({ system, user }) => {
			directorSaw = { system, user };
			return { text: '' };
		};
		const brief = '一个冷静精准的链上会计智能体，喜欢深蓝色';
		const created = await call('create_identity', { agent_name: '账本猞猁', brief });
		expect(created.result.isError).toBeUndefined();
		expect(directorSaw.user).toContain(brief);
		expect(directorSaw.system).toContain('ALWAYS write the prompt in English');
		// Fallback template still embeds the brief when the director yields nothing.
		expect(created.result.structuredContent.brief_truncated).toBe(false);
	});

	it('a directed prompt is used verbatim when the LLM director succeeds', async () => {
		const shaped = 'stoic navy-armored auditor android, silver circuit filigree, standing neutral, plain backdrop';
		// The director is instructed to output ONLY the prompt as a single line;
		// models routinely wrap it in quotes, which the shaper strips.
		llmSpy.fn = async () => ({ text: `"${shaped}"` });
		const created = await call('create_identity', {
			agent_name: 'LedgerLynx',
			brief: 'a calm on-chain accounting agent',
			style_hints: 'deep navy and silver',
		});
		expect(created.result.isError).toBeUndefined();
		// prompt + directed surface on the status poll (describeIdentityJob).
		const status = await call('identity_status', { job_id: created.result.structuredContent.job_id });
		const sc = status.result.structuredContent;
		expect(sc.directed).toBe(true);
		// First line only, surrounding quotes stripped — no fallback scaffolding.
		expect(sc.prompt).toBe(shaped);
		expect(sc.prompt).not.toContain('full-body humanoid character:');
	});

	it('an absurdly long brief is truncated and flagged, not silently mangled', async () => {
		const created = await call('create_identity', {
			agent_name: 'X',
			brief: 'A'.repeat(3999),
		});
		expect(created.result.isError).toBeUndefined();
		expect(created.result.structuredContent.brief_truncated).toBe(true);
		expect(created.result.structuredContent.note).toContain('truncated');
	});

	it('unreachable reference image fails with an actionable error BEFORE any work or charge', async () => {
		fetchRoutes.ref = () => new Response(null, { status: 404 });
		let forgeCalled = false;
		const origSubmit = fetchRoutes.forgeSubmit;
		fetchRoutes.forgeSubmit = (...a) => {
			forgeCalled = true;
			return origSubmit(...a);
		};
		const created = await call('create_identity', {
			agent_name: 'X',
			brief: 'test agent brief',
			reference_image_url: 'https://img.test/missing.png',
		});
		expect(created.result.isError).toBe(true);
		expect(created.result.structuredContent.error).toBe('reference_image_unreachable');
		expect(created.result.structuredContent.message).toContain('Nothing was charged');
		expect(forgeCalled).toBe(false);
	});

	it('non-image reference URL is rejected with a distinct actionable error', async () => {
		fetchRoutes.ref = () =>
			new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } });
		const created = await call('create_identity', {
			agent_name: 'X',
			brief: 'test agent brief',
			reference_image_url: 'https://img.test/page.html',
		});
		expect(created.result.isError).toBe(true);
		expect(created.result.structuredContent.error).toBe('reference_image_invalid');
	});

	it('render plan is deterministic per job, PFP pose pinned, full-body poses distinct', () => {
		const a = identity.buildRenderPlan('job-a');
		const b = identity.buildRenderPlan('job-a');
		expect(a).toEqual(b);
		expect(a[0]).toMatchObject({ kind: 'pfp', pose: 'contrapposto' });
		expect(a.filter((s) => s.kind === 'fullbody').length).toBe(3);
		expect(new Set(a.map((s) => s.pose)).size).toBe(a.length);
	});

	it('job tokens from other providers are rejected', async () => {
		const { encodeJobToken } = await import('../../api/_lib/forge-job-token.js');
		const foreign = encodeJobToken({ provider: 'gcp', kind: 'reconstruct', taskId: 'abc' });
		const s = await call('identity_status', { job_id: foreign });
		expect(s.result.structuredContent.error).toBe('invalid_job_id');
	});
});

// The fallback template is what a keyless deployment (or a downed LLM chain)
// actually sends to the generator, so its budget math is load-bearing rather
// than a nicety: an over-budget prompt is silently mangled by the text encoder.
describe('prompt shaping', () => {
	it('leads with the first sentence of the brief plus the style hints, inside the generator budget', () => {
		const p = identity.fallbackIdentityPrompt({
			brief: 'A calm on-chain accounting agent. It also files quarterly taxes and audits vaults.',
			styleHints: 'deep navy and silver',
		});
		expect(p).toContain(
			'full-body humanoid character embodying: A calm on-chain accounting agent, deep navy and silver',
		);
		// Later sentences are backstory, not a visual subject.
		expect(p).not.toContain('quarterly taxes');
		expect(p).toContain('standing neutral pose');
		expect(p.length).toBeLessThanOrEqual(identity.MAX_GENERATION_PROMPT_CHARS);
	});

	it('a CJK brief keeps its first sentence and never crowds out the hints', () => {
		const p = identity.fallbackIdentityPrompt({
			brief: '一个冷静精准的链上会计智能体。它还负责季度报税与金库审计工作。',
			styleHints: 'deep navy and silver',
		});
		// A CJK terminator carries no trailing space, so the sentence split has to
		// cut on a zero-width boundary or the whole brief counts as one sentence.
		expect(p).toContain('一个冷静精准的链上会计智能体');
		expect(p).not.toContain('季度报税');
		expect(p).toContain('deep navy and silver');
	});

	it('an over-long single-sentence brief is cut clean, hints survive, no dangling punctuation', () => {
		const p = identity.fallbackIdentityPrompt({
			brief: `${'a very long rambling description of the agent '.repeat(20)}and more`,
			styleHints: `${'ultra detailed cinematic lighting '.repeat(10)}chrome`,
		});
		expect(p.length).toBeLessThanOrEqual(identity.MAX_GENERATION_PROMPT_CHARS);
		expect(p).toContain('ultra detailed cinematic lighting');
		expect(p).not.toMatch(/[,;:.]\s*,/);
		expect(p).toMatch(/plain background$/);
	});

	it('shapeIdentityPrompt falls back when the director is down and reports it', async () => {
		const shaped = await identity.shapeIdentityPrompt({
			agentName: 'LedgerLynx',
			brief: 'a calm on-chain accounting agent',
			styleHints: null,
		});
		expect(shaped.directed).toBe(null);
		expect(shaped.effective).toContain('full-body humanoid character embodying');
	});

	it('shapeIdentityPrompt rejects a director answer that is prose rather than a prompt', async () => {
		llmSpy.fn = async () => ({ text: 'x'.repeat(1200) });
		const shaped = await identity.shapeIdentityPrompt({
			agentName: 'LedgerLynx',
			brief: 'a calm on-chain accounting agent',
			styleHints: null,
		});
		expect(shaped.directed).toBe(null);
		expect(shaped.effective).toContain('full-body humanoid character embodying');
		expect(shaped.effective.length).toBeLessThanOrEqual(identity.MAX_GENERATION_PROMPT_CHARS);
	});
});

// The fallback template is what a keyless deployment (or a downed LLM chain)
// actually sends to the generator, so its budget math is load-bearing rather
// than a nicety: an over-budget prompt is silently truncated by the text
// encoder, mid-clause, and the identity comes back wrong.
describe('prompt shaping', () => {
	it('leads with the first sentence of the brief plus the style hints, inside the generator budget', () => {
		const p = identity.fallbackIdentityPrompt({
			brief: 'A calm on-chain accounting agent. It also files quarterly taxes and audits vaults.',
			styleHints: 'deep navy and silver',
		});
		expect(p).toContain(
			'full-body humanoid character embodying: A calm on-chain accounting agent, deep navy and silver',
		);
		// Later sentences are backstory, not a visual subject.
		expect(p).not.toContain('quarterly taxes');
		expect(p).toContain('standing neutral pose');
		expect(p.length).toBeLessThanOrEqual(identity.MAX_GENERATION_PROMPT_CHARS);
	});

	it('a CJK brief keeps its first sentence and never crowds out the hints', () => {
		const p = identity.fallbackIdentityPrompt({
			brief: '一个冷静精准的链上会计智能体。它还负责季度报税与金库审计工作。',
			styleHints: 'deep navy and silver',
		});
		expect(p).toContain('一个冷静精准的链上会计智能体');
		expect(p).not.toContain('季度报税');
		expect(p).toContain('deep navy and silver');
	});

	it('an over-long single-sentence brief is cut at a clean boundary and the hints survive', () => {
		const p = identity.fallbackIdentityPrompt({
			brief: `${'a very long rambling description of the agent '.repeat(20)}and more`,
			styleHints: `${'ultra detailed cinematic lighting '.repeat(10)}chrome`,
		});
		expect(p.length).toBeLessThanOrEqual(identity.MAX_GENERATION_PROMPT_CHARS);
		expect(p).toContain('ultra detailed cinematic lighting');
		// No clause arriving at the comma join with its own trailing punctuation.
		expect(p).not.toMatch(/[.,;:]\s*,/);
		expect(p).toMatch(/plain background$/);
	});

	it('shapes to the fallback template when the director is unreachable', async () => {
		const shaped = await identity.shapeIdentityPrompt({
			agentName: 'LedgerLynx',
			brief: 'a calm on-chain accounting agent',
			styleHints: null,
		});
		expect(shaped.directed).toBe(null);
		expect(shaped.effective).toContain('full-body humanoid character embodying');
	});

	it('rejects a director answer that is prose rather than a prompt', async () => {
		llmSpy.fn = async () => ({ text: 'x'.repeat(1200) });
		const shaped = await identity.shapeIdentityPrompt({
			agentName: 'LedgerLynx',
			brief: 'a calm on-chain accounting agent',
			styleHints: null,
		});
		expect(shaped.directed).toBe(null);
		expect(shaped.effective).toContain('full-body humanoid character embodying');
		expect(shaped.effective.length).toBeLessThanOrEqual(identity.MAX_GENERATION_PROMPT_CHARS);
	});
});
