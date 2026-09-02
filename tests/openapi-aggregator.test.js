// Tests for GET /openapi.json's aggregator coverage: every endpoint registered
// in api/v1/_providers.js (providerCatalog()) must show up as a real OpenAPI
// path/operation, generated live (never hand-enumerated) — see
// api/openapi-json.js `aggregatorPaths()`. Also guards the pre-existing
// hand-authored /api/mcp, /api/x402/* etc. paths stay intact.

import { describe, it, expect, beforeAll } from 'vitest';
import openapiHandler from '../api/openapi-json.js';
import { providerCatalog } from '../api/v1/_providers.js';
import { PAID_SERVICES } from '../api/_lib/service-catalog/services/index.js';

function mockRes() {
	return {
		statusCode: 200,
		_headers: {},
		_body: '',
		setHeader(k, v) {
			this._headers[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return this._headers[k.toLowerCase()];
		},
		end(b) {
			this._body = b || '';
		},
		get headersSent() {
			return false;
		},
		get writableEnded() {
			return false;
		},
	};
}

function mockReq() {
	return {
		method: 'GET',
		url: '/openapi.json',
		headers: { accept: 'application/json', origin: 'https://three.ws' },
		socket: { remoteAddress: '127.0.0.1' },
	};
}

// Path-item keys that are operations; everything else ($ref, parameters,
// summary, description) is path-item metadata, not an operation to audit.
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

describe('GET /openapi.json — aggregator coverage', () => {
	let doc;

	beforeAll(async () => {
		const res = mockRes();
		await openapiHandler(mockReq(), res);
		expect(res.statusCode).toBe(200);
		// Body must be valid JSON — a parse failure here means the document is
		// broken, not just incomplete.
		doc = JSON.parse(res._body);
	});

	it('is a well-formed OpenAPI 3.1 document', () => {
		expect(doc.openapi).toBe('3.1.0');
		expect(doc.info?.title).toBeTruthy();
		expect(typeof doc.paths).toBe('object');
		expect(Array.isArray(doc.servers)).toBe(true);
	});

	it('declares the aggregator tag', () => {
		const tagNames = (doc.tags || []).map((t) => t.name);
		expect(tagNames).toContain('Crypto API (aggregator)');
	});

	it('covers every registered aggregator endpoint with a real path + operation', () => {
		const catalog = providerCatalog();
		let total = 0;
		for (const provider of catalog) {
			for (const ep of provider.endpoints) {
				total += 1;
				const pathItem = doc.paths[ep.path];
				expect(pathItem, `missing OpenAPI path for ${ep.path}`).toBeTruthy();

				const operation = pathItem[ep.method.toLowerCase()];
				expect(operation, `missing ${ep.method} operation for ${ep.path}`).toBeTruthy();
				expect(operation.tags).toContain('Crypto API (aggregator)');
				expect(operation.summary).toContain(provider.name);
				expect(operation.responses?.['402']).toBeTruthy();

				if (ep.free) {
					// Free-tier endpoints are explicitly public: `security: []`, no
					// x-payment-info. Discovery auditors classify x-payment-info as
					// "paid" and then demand a 402 on a bare probe — which the free
					// lane answers 200 — so x402scan skipped all 29 as invalid. The
					// x402 overage lane stays documented in the description prose.
					expect(operation.security, `${ep.path} security`).toEqual([]);
					expect(operation['x-payment-info']).toBeUndefined();
					expect(operation.description).toMatch(/free tier/);
				} else {
					// Pay-first endpoints keep the structured price, which must match
					// the registry's priceAtomics, not a hand-copied number.
					const expectedUsd = (Number(ep.price_usdc_atomics) / 1e6).toString();
					const declaredUsd = operation['x-payment-info']?.price?.amount;
					expect(Number(declaredUsd)).toBeCloseTo(Number(expectedUsd), 6);
				}

				if (ep.method === 'GET') {
					expect(Array.isArray(operation.parameters)).toBe(true);
					// Every documented "(required)" param must be flagged required.
					for (const [name, desc] of Object.entries(ep.params || {})) {
						const param = operation.parameters.find((p) => p.name === name);
						expect(param, `missing OpenAPI param "${name}" for ${ep.path}`).toBeTruthy();
						expect(param.required).toBe(/\(required\)/.test(desc));
					}
				} else {
					expect(operation.requestBody).toBeTruthy();
				}
			}
		}
		// Sanity: the registry isn't empty (would make this test vacuous).
		expect(total).toBeGreaterThan(10);
	});

	it('still carries the hand-authored, non-aggregator paths', () => {
		expect(doc.paths['/api/mcp']).toBeTruthy();
		expect(doc.paths['/api/x402/skill-marketplace']).toBeTruthy();
	});

	it('never nests a path inside another path item', () => {
		// Regression guard: six /api/x402/* paths once shipped nested inside the
		// /api/x402/skill-call path item, making them invisible to discovery
		// (x402scan / AgentCash read paths at the top level only).
		for (const [path, pathItem] of Object.entries(doc.paths)) {
			for (const key of Object.keys(pathItem)) {
				expect(
					key.startsWith('/'),
					`path item ${path} contains nested path-like key ${key}`,
				).toBe(false);
			}
		}
	});

	it('omits the Permit2 demo when CDP credentials are absent', () => {
		// Permit2 settlement requires CDP creds; without them the route's 402
		// carries an empty accepts[] (unpayable), so discovery must not
		// advertise it. Test env has no CDP_API_KEY_ID/SECRET.
		if (process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET) return;
		expect(doc.paths['/api/x402/permit2-paid-demo']).toBeUndefined();
	});

	it('exposes the once-hidden x402 endpoints at the top level', () => {
		for (const path of [
			'/api/x402/agent-bouncer',
			'/api/x402/vanity-verifiable',
			'/api/x402/crypto-intel',
			'/api/x402/cosmetic-purchase',
			'/api/x402/animation-download',
			'/api/x402/club-cover',
		]) {
			const op = doc.paths[path]?.get ?? doc.paths[path]?.post;
			expect(op, `missing top-level path ${path}`).toBeTruthy();
			expect(op['x-payment-info']?.protocols).toBeTruthy();
			expect(op['x-payment-info']?.price).toBeTruthy();
		}
	});

	it('free-tier endpoints note their quota in the description and declare security: []', () => {
		const priced = doc.paths['/api/v1/x/coingecko/price']?.get;
		expect(priced.description).toMatch(/30\/min/);
		expect(priced.description).toMatch(/2000\/day/);
		expect(priced.security).toEqual([]);
		expect(priced['x-payment-info']).toBeUndefined();
	});

	// The three guards below encode what `redocly lint` (recommended ruleset)
	// checks, so the failure lands in `npm test` instead of on whoever next runs
	// an external validator against the published document.
	it('declares security on every operation', () => {
		// This document sets no root-level `security`, so an operation that omits
		// its own inherits nothing: validators report undefined auth and agent
		// tooling that infers an auth mode from the security list reports
		// "unknown" instead of "public, pay-per-call". All 24 /api/x402/* paths
		// once omitted it. Payment-gated operations declare [] (no credential
		// required); credential-gated ones name their scheme.
		for (const [path, pathItem] of Object.entries(doc.paths)) {
			for (const [verb, op] of Object.entries(pathItem)) {
				if (!HTTP_METHODS.includes(verb)) continue;
				expect(op.security, `${verb.toUpperCase()} ${path} declares no security`).toBeDefined();
				expect(Array.isArray(op.security), `${verb.toUpperCase()} ${path} security is not an array`).toBe(true);
			}
		}
	});

	it('documents at least one 4xx response on every operation', () => {
		for (const [path, pathItem] of Object.entries(doc.paths)) {
			for (const [verb, op] of Object.entries(pathItem)) {
				if (!HTTP_METHODS.includes(verb)) continue;
				const codes = Object.keys(op.responses || {});
				expect(
					codes.some((code) => /^4/.test(code)),
					`${verb.toUpperCase()} ${path} documents no 4xx response (has ${codes.join(', ') || 'none'})`,
				).toBe(true);
			}
		}
	});

	it('states the API license', () => {
		// Without it, spec renderers and SDK codegen present the API as
		// unlicensed, which reads as public domain to anyone bundling our
		// document into a client. The repo LICENSE is proprietary.
		expect(doc.info.license?.name).toBeTruthy();
		expect(doc.info.license?.url || doc.info.license?.identifier).toBeTruthy();
	});
});

describe('GET /openapi.json: paid service-catalog coverage', () => {
	let doc;

	beforeAll(async () => {
		const res = mockRes();
		await openapiHandler(mockReq(), res);
		doc = JSON.parse(res._body);
	});

	// The drift this closes: /openapi.json is what x402scan reads when it
	// registers an origin, and what AgentCash's validator reads to find payable
	// operations. Its /api/x402/* operations were hand-authored, so 24 of the
	// catalog's 75 live paid services had an entry and the rest were invisible
	// to both directories while answering a perfectly valid 402 in production.
	// Projecting them from the catalog fixed it; this keeps it fixed.
	it('covers every live paid service in the catalog', () => {
		const cdp = Boolean(process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET);
		let covered = 0;
		for (const service of PAID_SERVICES) {
			if (service.free || service.status !== 'live') continue;
			// Unpayable without CDP credentials, so deliberately unadvertised.
			if (service.acceptsBuilder === 'permit2-only' && !cdp) {
				expect(doc.paths[service.path]).toBeUndefined();
				continue;
			}
			const pathItem = doc.paths[service.path];
			expect(pathItem, `missing OpenAPI path for ${service.path}`).toBeTruthy();

			const operation = pathItem[service.method.toLowerCase()];
			expect(
				operation,
				`missing ${service.method} operation for ${service.path}`,
			).toBeTruthy();
			expect(operation.responses?.['402'], `${service.path} documents no 402`).toBeTruthy();
			// Both halves are required together: AgentCash's
			// StructuredPaymentInfoSchema silently drops a price with no sibling
			// protocols and reports the operation as unpriced.
			expect(operation['x-payment-info']?.price, `${service.path} price`).toBeTruthy();
			expect(operation['x-payment-info']?.protocols, `${service.path} protocols`).toBeTruthy();
			covered += 1;
		}
		// Sanity: the catalog is not empty, which would make this vacuous.
		expect(covered).toBeGreaterThan(50);
	});

	it('prices every projected operation from the catalog, never a hand-copied number', () => {
		// Only fixed-price entries are compared to the catalog. Six hand-authored
		// operations quote a difficulty- or size-tiered price instead
		// (`mode: 'dynamic'` with min/max, e.g. vanity at $0.01 for one character
		// and $0.25 for three); the live 402 quotes the exact figure per request,
		// and the catalog's single priceAtomics is the floor, not the price. The
		// projection never overwrites a hand-authored operation, so those keep
		// their range and are asserted as a range.
		for (const service of PAID_SERVICES) {
			if (service.free || service.status !== 'live') continue;
			const operation = doc.paths[service.path]?.[service.method.toLowerCase()];
			if (!operation) continue;
			const price = operation['x-payment-info']?.price;
			expect(price, `${service.path} declares no price`).toBeTruthy();
			if (price.mode === 'dynamic') {
				expect(Number(price.min), `${service.path} dynamic min`).toBeGreaterThan(0);
				expect(Number(price.max), `${service.path} dynamic max`).toBeGreaterThanOrEqual(
					Number(price.min),
				);
				continue;
			}
			expect(
				Number(price.amount),
				`${service.path} price drift (declared ${price.amount})`,
			).toBeCloseTo(Number(service.priceAtomics) / 1e6, 6);
		}
	});

	it('keeps every hand-authored operation exactly as written', () => {
		// The projection is spread before the hand-authored paths, so a route
		// with a richer hand-written entry keeps it. agent-reputation is one:
		// its typed uuid query parameter would be a plain string if the
		// projection had won.
		const handAuthored = doc.paths['/api/x402/agent-reputation']?.get;
		expect(handAuthored.operationId).toBe('x402_agent_reputation');
		const agentId = handAuthored.parameters.find((p) => p.name === 'agent_id');
		expect(agentId.schema.format).toBe('uuid');
	});

	it('projects GET inputs as query parameters and POST inputs as a request body', () => {
		const getOp = doc.paths['/api/x402/market-coin']?.get;
		expect(Array.isArray(getOp.parameters)).toBe(true);
		expect(getOp.parameters.some((p) => p.name === 'id')).toBe(true);
		expect(getOp.requestBody).toBeUndefined();

		const postOp = doc.paths['/api/x402/pipeline-rig']?.post;
		expect(postOp.requestBody?.content?.['application/json']?.schema?.properties?.glb_url).toBeTruthy();
		expect(postOp.requestBody.required).toBe(true);
		expect(postOp.parameters).toBeUndefined();
	});

	it('carries the JSON Schema required list onto the query parameters', () => {
		// token-intel's inputSchema requires `mint`; a projection that dropped the
		// required list would document every parameter as optional and agents
		// would call it without one.
		const parameters = doc.paths['/api/x402/token-intel'].get.parameters;
		expect(parameters.find((p) => p.name === 'mint').required).toBe(true);
		// market-coin requires nothing (id or contract, either one), so its
		// parameters must not be forced.
		const optional = doc.paths['/api/x402/market-coin'].get.parameters;
		expect(optional.every((p) => p.required === false)).toBe(true);
	});
});
