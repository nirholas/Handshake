/**
 * Work order 03 — the decomposed 3D studio on OKX.AI
 * (/api/okx/3d/<service>, catalog rows in api/_lib/okx-catalog.js, engines in
 * api/_okx3d/rest-services.js).
 *
 * Covers, for EVERY paid REST service (no sampling): the catalog contract and
 * price points, the per-service 402 (OKX dialect, X Layer accept first, the
 * service's own amount), the free GET descriptor, the paid dispatch to the
 * real engine seam, settle-only-after-success, and the failure paths that
 * must never charge (invalid input, humanoid gate, engine 5xx, rejected
 * payment).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

process.env.PUBLIC_APP_ORIGIN = 'https://three.ws';
process.env.X402_PAY_TO_XLAYER ||= '0x75d00a2713565171f33216e5aa2a375e076ecf69';
process.env.X402_XLAYER_RELAYER_KEY ||=
	'0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
process.env.X402_PAY_TO_BASE ||= '0x0000000000000000000000000000000000000001';
process.env.JWT_SECRET ||= 'okx-3d-test-secret';

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		publicIp: vi.fn(async () => ({ success: true, reset: Date.now() + 1000 })),
		mcpIp: vi.fn(async () => ({ success: true, reset: Date.now() + 1000 })),
		mcpUser: vi.fn(async () => ({ success: true, reset: Date.now() + 1000 })),
		mcpOptimize: vi.fn(async () => ({ success: true, reset: Date.now() + 1000 })),
	},
	clientIp: vi.fn(() => '203.0.113.9'),
}));

vi.mock('../../api/_lib/usage.js', () => ({
	recordEvent: vi.fn(),
	logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
}));

// Idempotency plumbing is DB-backed in prod; stub it to always-miss so the
// paid path runs the engine (replay caching has its own suite).
vi.mock('../../api/_lib/x402/payment-identifier-server.js', () => ({
	PAYMENT_IDENTIFIER: 'payment-identifier',
	extractIdFromHeader: vi.fn(() => null),
	hashPaymentProof: vi.fn(() => null),
	hashRequestPayload: vi.fn(() => 'payload-hash'),
	paymentIdentifierExtension: vi.fn(() => ({})),
	checkCache: vi.fn(async () => ({ kind: 'miss' })),
	storeResponse: vi.fn(async () => {}),
	writeCachedResponse: vi.fn(),
	writeConflict: vi.fn(),
	reservePaymentProof: vi.fn(async () => ({ ok: true, release: async () => {} })),
}));

// Payment verification/settlement are exercised against the live rail in the
// WO-04 gauntlet; here they are seams — the suite asserts WHEN they run
// (verify before engine, settle only after success), not chain mechanics.
const verifyPaymentMock = vi.fn();
const settlePaymentMock = vi.fn();
vi.mock('../../api/_lib/x402-spec.js', async (importOriginal) => {
	const real = await importOriginal();
	return {
		...real,
		verifyPayment: (...args) => verifyPaymentMock(...args),
		settlePayment: (...args) => settlePaymentMock(...args),
	};
});

vi.mock('../../api/_lib/r2.js', () => ({
	putObject: vi.fn(async () => {}),
	getObjectBuffer: vi.fn(async () => Buffer.alloc(0)),
	headObject: vi.fn(async () => ({ ContentLength: 1 })),
	publicUrl: (key) => `https://cdn.test/${key}`,
}));

// Programmable fetch router over the engine's HTTP surfaces (/api/forge).
const fetchRoutes = {};
function jsonResponse(status, body) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}
const realFetch = globalThis.fetch;
beforeEach(() => {
	verifyPaymentMock.mockReset();
	settlePaymentMock.mockReset();
	verifyPaymentMock.mockImplementation(async ({ requirements }) => ({
		paymentPayload: { x402Version: 2 },
		requirement: Array.isArray(requirements) ? requirements[0] : requirements,
		payer: '0x75d00a2713565171f33216e5aa2a375e076ecf69',
	}));
	settlePaymentMock.mockResolvedValue({
		success: true,
		transaction: '0xsettled',
		network: 'eip155:196',
		payer: '0x75d00a2713565171f33216e5aa2a375e076ecf69',
	});
	fetchRoutes.forgeSubmit = () => jsonResponse(200, { job_id: 'forge-gen-1', status: 'queued' });
	fetchRoutes.rig = () => jsonResponse(200, { job_id: 'forge-rig-1', status: 'queued' });
	fetchRoutes.forgePoll = () => jsonResponse(200, { status: 'running' });
	fetchRoutes.chat = () => new Response(null, { status: 503 }); // director down → fail-soft
	fetchRoutes.other = () => new Response('not found', { status: 404 });
	globalThis.fetch = vi.fn(async (url, init = {}) => {
		const u = String(url);
		if (u.includes('/api/chat')) return fetchRoutes.chat(u, init);
		if (u.includes('/api/forge?action=rig')) return fetchRoutes.rig(u, init);
		if (u.includes('/api/forge?job=')) return fetchRoutes.forgePoll(u, init);
		if (u.includes('/api/forge')) return fetchRoutes.forgeSubmit(u, init);
		return fetchRoutes.other(u, init);
	});
	return () => {
		globalThis.fetch = realFetch;
	};
});

const {
	OKX_CATALOG,
	catalogEntry,
	catalogIndex,
	listedCatalog,
	listingDescription,
	validateCatalog,
} = await import('../../api/_lib/okx-catalog.js');
const studioCatalog = await import('../../api/_mcp3d/catalog.js');
const { default: handler } = await import('../../api/okx/3d/[service].js');

const PAID_REST_IDS = [
	'text-to-3d',
	'text-to-3d-pro',
	'image-to-3d',
	'rig',
	'avatar',
	'retarget',
	'pose-seed',
	'fbx-export',
];

// Valid POST bodies per service, used by both the 402 and the paid tests.
const VALID_INPUT = {
	'text-to-3d': { prompt: 'a brass steampunk owl' },
	'text-to-3d-pro': { prompt: 'a brass steampunk owl', tier: 'high' },
	'image-to-3d': { image_urls: ['https://example.com/owl-front.jpg'] },
	rig: { glb_url: 'https://cdn.test/owl.glb' },
	avatar: { prompt: 'a heroic knight character, full body' },
	retarget: { model_url: 'https://cdn.test/knight-rigged.glb', animation: 'idle' },
	'pose-seed': { prompt: 'confident standing pose, arms crossed' },
	'fbx-export': { model_url: 'https://cdn.test/knight-rigged.glb' },
};

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
	req.headers = {
		'content-type': 'application/json',
		host: 'three.ws',
		'x-forwarded-proto': 'https',
		...headers,
	};
	return req;
}

const decode402Header = (res) =>
	JSON.parse(Buffer.from(res.headers['payment-required'], 'base64').toString('utf8'));

describe('okx catalog — work order 03 rows', () => {
	it('all eight decomposed services exist at the work-order price points', () => {
		expect(validateCatalog()).toBe(true);
		const prices = Object.fromEntries(
			OKX_CATALOG.map((e) => [e.id, [e.priceUsd, e.amountAtomics]]),
		);
		expect(prices['text-to-3d']).toEqual(['0.01', '10000']);
		expect(prices['text-to-3d-pro']).toEqual(['0.30', '300000']);
		expect(prices['image-to-3d']).toEqual(['0.30', '300000']);
		expect(prices.rig).toEqual(['0.25', '250000']);
		expect(prices.avatar).toEqual(['0.50', '500000']);
		expect(prices.retarget).toEqual(['0.10', '100000']);
		expect(prices['pose-seed']).toEqual(['0.02', '20000']);
		expect(prices['fbx-export']).toEqual(['0.10', '100000']);
	});

	it('every paid row routes /api/okx/3d/<id>, is POST-documented, and its listing description joins the two parts', () => {
		for (const id of PAID_REST_IDS) {
			const e = catalogEntry(id);
			expect(e.endpoint).toBe(`https://three.ws/api/okx/3d/${id}`);
			expect(e.inputSchema).toBeTruthy();
			expect(listingDescription(e)).toBe(`${e.describes.capability}\n${e.describes.input}`);
		}
	});

	// OKX rejected the listing on 2026-07-26 for "missing a complete description,
	// parameter details, and usage examples". Every row states its capability and
	// what the caller must provide, and this guard keeps that from regressing.
	it('every row states its capability and its parameters', () => {
		for (const e of OKX_CATALOG) {
			expect(e.describes.capability.length, `${e.id} capability`).toBeGreaterThan(40);
			// Parameter details: the "Provide..." sentence OKX's format asks for.
			expect(e.describes.input, `${e.id} input`).toMatch(/^Provide/);
		}
	});

	// The listing invariants (.agents/skills/okx-agent-identity/references/
	// invariants.md) forbid example prompts, links and tech-stack names inside a
	// service description. The back-burner rows predate that reading and are not
	// submitted; every LISTED row must be clean, since those are the strings a
	// reviewer actually reads.
	it('listed rows carry no example prompt, link, or tech-stack name', () => {
		for (const e of listedCatalog()) {
			for (const part of [e.describes.capability, e.describes.input]) {
				expect(part, `${e.id}`).not.toMatch(/Example:/i);
				expect(part, `${e.id}`).not.toMatch(/https?:\/\//);
				expect(part, `${e.id}`).not.toMatch(/\b(TRELLIS|Hunyuan|NVIDIA|GPU|MCP|x402|JSON-RPC)\b/);
			}
		}
	});

	// The back burner is a listing decision, not a deletion: those endpoints stay
	// deployed and payable, so the free index still publishes them under
	// `unlisted` rather than pretending they are gone.
	it('the free catalog index splits listed from back-burner rows, losing none', () => {
		const index = catalogIndex();
		const listedIds = index.services.map((s) => s.id);
		const unlistedIds = index.unlisted.map((s) => s.id);
		for (const id of PAID_REST_IDS) expect(unlistedIds).toContain(id);
		expect([...listedIds, ...unlistedIds].sort()).toEqual(OKX_CATALOG.map((e) => e.id).sort());
		expect(listedIds).toEqual(listedCatalog().map((e) => e.id));
	});

	it('the paid MCP tools each service maps to exist on the studio engine', () => {
		for (const tool of ['apply_animation', 'pose_model', 'remesh_model']) {
			expect(studioCatalog.TOOLS[tool]?.handler).toBeTypeOf('function');
		}
	});
});

describe('per-service 402 (unpaid POST)', () => {
	for (const id of PAID_REST_IDS) {
		it(`${id}: OKX-dialect 402, X Layer accept first, its own amount`, async () => {
			const res = makeRes();
			await handler(makeReq({ service: id, body: VALID_INPUT[id] }), res);
			expect(res.statusCode).toBe(402);
			const entry = catalogEntry(id);
			const header = decode402Header(res);
			const body = JSON.parse(res.body);
			expect(body).toEqual(header); // header and body carry the same envelope
			expect(body.x402Version).toBe(2);
			expect(body.resource.url).toBe(`https://three.ws/api/okx/3d/${id}`);
			expect(body.resource.mimeType).toBe('application/json');
			const first = body.accepts[0];
			expect(first.scheme).toBe('exact');
			expect(first.network).toBe('eip155:196');
			expect(first.amount).toBe(entry.amountAtomics);
			expect(first.payTo.toLowerCase()).toBe('0x75d00a2713565171f33216e5aa2a375e076ecf69');
			expect(first.asset.toLowerCase()).toBe('0x779ded0c9e1022225f8e0630b35a9b54be713736');
			expect(first.maxTimeoutSeconds).toBe(86400);
			expect(first.extra).toMatchObject({
				symbol: 'USDT',
				name: 'USD₮0',
				version: '1',
				transferMethod: 'eip3009',
			});
			// One service, one price: every advertised rail quotes the same amount.
			for (const a of body.accepts) expect(a.amount).toBe(entry.amountAtomics);
			expect(settlePaymentMock).not.toHaveBeenCalled();
		});
	}

	it('GET is the free per-service descriptor (price + schema, no payment)', async () => {
		const res = makeRes();
		await handler(makeReq({ method: 'GET', service: 'rig' }), res);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.price_usd).toBe('0.25');
		expect(body.input_schema.required).toEqual(['glb_url']);
		expect(body.method).toBe('POST');
	});
});

describe('paid dispatch — verify → engine → settle', () => {
	function paidReq(service, body) {
		return makeReq({ service, body, headers: { 'payment-signature': 'c2ln' } });
	}

	it('text-to-3d runs the free draft-tier lane (no backend pin) and returns a pollable job', async () => {
		const res = makeRes();
		await handler(paidReq('text-to-3d', VALID_INPUT['text-to-3d']), res);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body);
		expect(body).toMatchObject({ service: 'text-to-3d', price_usd: '0.01', status: 'queued', job_id: 'forge-gen-1' });
		expect(body.poll_url).toContain('/api/forge?job=');
		const submit = globalThis.fetch.mock.calls.find(([u]) => String(u).endsWith('/api/forge'));
		// No backend pin: the draft default now resolves to the photoreal
		// image-intermediate pipeline (see forge-tiers.js FREE_DEFAULT_FOR_TIERS)
		// instead of forcing NVIDIA's native text-only preview.
		expect(JSON.parse(submit[1].body)).toMatchObject({ path: 'image' });
		expect(JSON.parse(submit[1].body).backend).toBeUndefined();
		expect(settlePaymentMock).toHaveBeenCalledTimes(1);
		expect(res.headers['payment-response']).toBeTruthy();
		expect(res.headers['x-payment-response']).toBe(res.headers['payment-response']);
	});

	// The paid 200 is the ONLY response that carries a settlement receipt, and a
	// browser-side x402 client can read a response header only if it is in the
	// expose list. The success path used to overwrite cors()'s list with just
	// the two v2 names, so it set x-payment-response and then hid it from every
	// cross-origin reader.
	it('the paid 200 exposes both receipt header names to cross-origin readers', async () => {
		const res = makeRes();
		await handler(paidReq('text-to-3d', VALID_INPUT['text-to-3d']), res);
		expect(res.statusCode).toBe(200);
		const exposed = String(res.headers['access-control-expose-headers'])
			.split(',')
			.map((h) => h.trim().toLowerCase());
		expect(exposed).toContain('payment-response');
		expect(exposed).toContain('x-payment-response');
	});

	it('text-to-3d-pro survives a downed art director (fail-soft) and submits the original prompt', async () => {
		const res = makeRes();
		await handler(paidReq('text-to-3d-pro', VALID_INPUT['text-to-3d-pro']), res);
		expect(res.statusCode).toBe(200);
		const submit = globalThis.fetch.mock.calls.find(([u]) => String(u).endsWith('/api/forge'));
		expect(JSON.parse(submit[1].body).prompt).toBe('a brass steampunk owl');
		expect(settlePaymentMock).toHaveBeenCalledTimes(1);
	});

	it('image-to-3d forwards the reference views to the reconstruct lane', async () => {
		const res = makeRes();
		await handler(paidReq('image-to-3d', VALID_INPUT['image-to-3d']), res);
		expect(res.statusCode).toBe(200);
		const submit = globalThis.fetch.mock.calls.find(([u]) => String(u).endsWith('/api/forge'));
		expect(JSON.parse(submit[1].body).image_urls).toEqual(VALID_INPUT['image-to-3d'].image_urls);
		expect(settlePaymentMock).toHaveBeenCalledTimes(1);
	});

	it('rig submits the auto-rig job and returns it pollable', async () => {
		const res = makeRes();
		await handler(paidReq('rig', VALID_INPUT.rig), res);
		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.body)).toMatchObject({ status: 'queued', job_id: 'forge-rig-1', mode: 'rig' });
		expect(settlePaymentMock).toHaveBeenCalledTimes(1);
	});

	it('avatar chains generate → rig and returns the mesh even while the rig job polls', async () => {
		fetchRoutes.forgeSubmit = () =>
			jsonResponse(200, { status: 'done', glb_url: 'https://cdn.test/knight.glb' });
		const res = makeRes();
		await handler(paidReq('avatar', VALID_INPUT.avatar), res);
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body);
		expect(body).toMatchObject({
			service: 'avatar',
			status: 'queued',
			job_id: 'forge-rig-1',
			mode: 'avatar',
			mesh_glb_url: 'https://cdn.test/knight.glb',
		});
		expect(settlePaymentMock).toHaveBeenCalledTimes(1);
	});

	it('pose-seed resolves deterministically in-process — same prompt, same seed, real engine', async () => {
		const res1 = makeRes();
		await handler(paidReq('pose-seed', VALID_INPUT['pose-seed']), res1);
		expect(res1.statusCode).toBe(200);
		const first = JSON.parse(res1.body);
		expect(first.status).toBe('done');
		expect(first.seed ?? first.pose ?? first.rotations ?? first.preset).toBeDefined();
		const res2 = makeRes();
		await handler(paidReq('pose-seed', VALID_INPUT['pose-seed']), res2);
		expect(JSON.parse(res2.body)).toEqual(first);
		expect(settlePaymentMock).toHaveBeenCalledTimes(2);
	});

	it('retarget routes to the apply_animation engine and settles only on success', async () => {
		const original = studioCatalog.TOOLS.apply_animation.handler;
		studioCatalog.TOOLS.apply_animation.handler = vi.fn(async (args) => ({
			content: [{ type: 'text', text: 'ok' }],
			structuredContent: { animation: args.animation, coverage: 0.97, clip: { tracks: 12 } },
		}));
		try {
			const res = makeRes();
			await handler(paidReq('retarget', VALID_INPUT.retarget), res);
			expect(res.statusCode).toBe(200);
			expect(JSON.parse(res.body)).toMatchObject({ status: 'done', animation: 'idle', coverage: 0.97 });
			expect(studioCatalog.TOOLS.apply_animation.handler).toHaveBeenCalledTimes(1);
			expect(settlePaymentMock).toHaveBeenCalledTimes(1);
		} finally {
			studioCatalog.TOOLS.apply_animation.handler = original;
		}
	});

	it('fbx-export routes to remesh_model convert with rig-preserving fbx default', async () => {
		const original = studioCatalog.TOOLS.remesh_model.handler;
		studioCatalog.TOOLS.remesh_model.handler = vi.fn(async (args) => {
			// remesh_model speaks mesh_url/output_format, NOT the catalog row's
			// model_url/format. Passing the OKX names made every paid fbx-export
			// call 400 on "mesh_url must be a public https URL" and silently drop
			// the requested format.
			expect(args).toMatchObject({
				mesh_url: VALID_INPUT['fbx-export'].model_url,
				operation: 'convert',
				output_format: 'fbx',
			});
			return { content: [{ type: 'text', text: 'ok' }], structuredContent: { job_id: 'remesh-1' } };
		});
		try {
			const res = makeRes();
			await handler(paidReq('fbx-export', VALID_INPUT['fbx-export']), res);
			expect(res.statusCode).toBe(200);
			expect(JSON.parse(res.body)).toMatchObject({ status: 'queued', job_id: 'remesh-1', format: 'fbx' });
			expect(settlePaymentMock).toHaveBeenCalledTimes(1);
		} finally {
			studioCatalog.TOOLS.remesh_model.handler = original;
		}
	});
});

// The three tool-backed rows call an MCP tool handler DIRECTLY, bypassing the
// studio dispatcher that would normally validate arguments, so a renamed key
// fails at runtime, on a paid call, with nothing catching it in between. This
// holds each adapter to the engine tool's own published schema.
describe('engine argument contract', () => {
	const ENGINE_FOR = {
		retarget: 'apply_animation',
		'pose-seed': 'pose_model',
		'fbx-export': 'remesh_model',
	};
	const schemaAjv = new Ajv({ allErrors: true, strict: false });
	addFormats(schemaAjv);

	for (const [service, tool] of Object.entries(ENGINE_FOR)) {
		it(`${service} passes arguments ${tool} actually accepts`, async () => {
			const schema = studioCatalog.TOOL_CATALOG.find((t) => t.name === tool)?.inputSchema;
			expect(schema, `${tool} publishes an inputSchema`).toBeTruthy();
			const validate = schemaAjv.compile(schema);
			const original = studioCatalog.TOOLS[tool].handler;
			let seen = null;
			studioCatalog.TOOLS[tool].handler = vi.fn(async (args) => {
				seen = args;
				return { content: [{ type: 'text', text: 'ok' }], structuredContent: {} };
			});
			try {
				const res = makeRes();
				await handler(
					makeReq({ service, body: VALID_INPUT[service], headers: { 'payment-signature': 'c2ln' } }),
					res,
				);
				expect(res.statusCode).toBe(200);
			} finally {
				studioCatalog.TOOLS[tool].handler = original;
			}
			expect(seen, `${service} never reached ${tool}`).toBeTruthy();
			expect(validate(seen) ? [] : validate.errors).toEqual([]);
		});
	}
});

describe('failure paths never charge', () => {
	function paidReq(service, body) {
		return makeReq({ service, body, headers: { 'payment-signature': 'c2ln' } });
	}

	it('invalid input → 400 before any engine call, no settle', async () => {
		const res = makeRes();
		await handler(paidReq('text-to-3d', { prompt: 'x' }), res); // below minLength 3
		expect(res.statusCode).toBe(400);
		expect(settlePaymentMock).not.toHaveBeenCalled();
		expect(globalThis.fetch.mock.calls.find(([u]) => String(u).includes('/api/forge'))).toBeUndefined();
	});

	it('avatar humanoid gate steers objects away without charging', async () => {
		const res = makeRes();
		await handler(paidReq('avatar', { prompt: 'a wooden chair' }), res);
		expect(res.statusCode).toBe(400);
		expect(JSON.parse(res.body).error_description || JSON.parse(res.body).message).toMatch(/humanoid/i);
		expect(settlePaymentMock).not.toHaveBeenCalled();
	});

	it('engine 5xx → 502, explicit "payment was not taken", no settle', async () => {
		fetchRoutes.forgeSubmit = () => jsonResponse(500, { message: 'kaboom' });
		const res = makeRes();
		await handler(paidReq('text-to-3d', VALID_INPUT['text-to-3d']), res);
		expect(res.statusCode).toBeGreaterThanOrEqual(500);
		expect(res.body).toMatch(/payment was not taken/);
		expect(settlePaymentMock).not.toHaveBeenCalled();
	});

	it('rejected payment → fresh OKX 402 with the error surfaced, engine never runs', async () => {
		const { X402Error } = await import('../../api/_lib/x402-errors.js');
		verifyPaymentMock.mockRejectedValueOnce(new X402Error('invalid_payment', 'insufficient_balance', 402));
		const res = makeRes();
		await handler(paidReq('rig', VALID_INPUT.rig), res);
		expect(res.statusCode).toBe(402);
		const body = JSON.parse(res.body);
		expect(body.error).toBe('insufficient_balance');
		expect(body.accepts[0].network).toBe('eip155:196');
		expect(globalThis.fetch.mock.calls.find(([u]) => String(u).includes('action=rig'))).toBeUndefined();
		expect(settlePaymentMock).not.toHaveBeenCalled();
	});

	it('settle failure after delivered work surfaces the x402 error path', async () => {
		const { X402Error } = await import('../../api/_lib/x402-errors.js');
		settlePaymentMock.mockRejectedValueOnce(new X402Error('settle_failed', 'facilitator down', 502));
		const res = makeRes();
		await handler(paidReq('text-to-3d', VALID_INPUT['text-to-3d']), res);
		expect(res.statusCode).toBe(502);
		expect(res.body).toMatch(/settle|facilitator/i);
	});
});
