// Discovery metadata for the hosted IBM Granite MCP endpoint (/api/ibm-mcp).
//
// api/_mcpibm/discovery.js is what x402 facilitators (CDP Bazaar,
// agentic.market, x402scan) read out of the 402 challenge to index the
// endpoint. A malformed entry does not fail the request path, it silently
// de-lists the server, so the shape is asserted here instead of being trusted.
//
// Unlike tests/api/ibm-mcp.test.js this file does NOT mock the bazaar helpers:
// the point is to check the metadata the real @x402/extensions declarators emit.
import { describe, it, expect } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';

process.env.PUBLIC_APP_ORIGIN ||= 'https://app.test';

const { GRANITE_CHALLENGE, RESOURCE_DESCRIPTION } = await import('../../api/_mcpibm/discovery.js');

const ajv = new Ajv2020({ allErrors: true, strict: false });

const PAID_TOOLS = [
	'ibm_granite_chat',
	'ibm_granite_code',
	'ibm_granite_embed',
	'ibm_granite_analyze',
	'ibm_granite_forecast',
];

describe('IBM Granite MCP: 402 challenge metadata', () => {
	it('describes the endpoint and every paid tool it exposes', () => {
		expect(GRANITE_CHALLENGE.description).toBe(RESOURCE_DESCRIPTION);
		for (const tool of PAID_TOOLS) expect(RESOURCE_DESCRIPTION).toContain(tool);
		expect(RESOURCE_DESCRIPTION).toContain('three.ws');
	});

	// Facilitator soft-drop rules: an over-long field is discarded silently and
	// the endpoint gets indexed with partial metadata. Keep every field in range.
	it('service metadata stays inside the facilitator field limits', () => {
		expect(GRANITE_CHALLENGE.serviceName).toBe('three.ws Granite x402');
		expect(GRANITE_CHALLENGE.serviceName.length).toBeLessThanOrEqual(32);
		expect(GRANITE_CHALLENGE.tags.length).toBeLessThanOrEqual(5);
		for (const tag of GRANITE_CHALLENGE.tags) {
			expect(tag.length).toBeLessThanOrEqual(32);
			expect(tag).toMatch(/^[\x20-\x7e]+$/);
		}
		expect(GRANITE_CHALLENGE.tags).toContain('granite');
		expect(GRANITE_CHALLENGE.iconUrl).toMatch(/^https:\/\//);
	});

	it('advertises a discoverable v2 bazaar extension for a JSON-RPC POST', () => {
		const bazaar = GRANITE_CHALLENGE.bazaar;
		expect(bazaar.discoverable).toBe(true);
		expect(bazaar.info.input).toMatchObject({ type: 'http', method: 'POST', bodyType: 'json' });
		expect(bazaar.info.input.body.method).toBe('tools/call');
		expect(bazaar.info.output.type).toBe('json');
		expect(bazaar.info.output.example.result.content[0].type).toBe('text');
	});

	it('the declared info validates against the extension meta-schema', () => {
		const validate = ajv.compile(GRANITE_CHALLENGE.bazaar.schema);
		expect(validate(GRANITE_CHALLENGE.bazaar.info)).toBe(true);
	});

	// Failure path: a meta-schema that accepts anything would pass the check above
	// while telling a facilitator nothing. Prove it actually constrains.
	it('the meta-schema rejects an info block that misdescribes the call', () => {
		const validate = ajv.compile(GRANITE_CHALLENGE.bazaar.schema);
		const noBodyType = structuredClone(GRANITE_CHALLENGE.bazaar.info);
		delete noBodyType.input.bodyType;
		expect(validate(noBodyType)).toBe(false);

		const wrongMethod = structuredClone(GRANITE_CHALLENGE.bazaar.info);
		wrongMethod.input.method = 'GET';
		expect(validate(wrongMethod)).toBe(false);

		const strayField = structuredClone(GRANITE_CHALLENGE.bazaar.info);
		strayField.input.queryParams = { foo: 'bar' };
		expect(validate(strayField)).toBe(false);
	});

	it('the advertised example body satisfies the request-body schema it ships', () => {
		const bodySchema = GRANITE_CHALLENGE.bazaar.schema.properties.input.properties.body;
		const validateBody = ajv.compile(bodySchema);
		expect(validateBody(GRANITE_CHALLENGE.bazaar.info.input.body)).toBe(true);
		// Failure path: an unsupported JSON-RPC method is rejected, so a client
		// generating calls from this schema cannot invent one.
		expect(validateBody({ jsonrpc: '2.0', id: 1, method: 'tools/destroy' })).toBe(false);
	});
});
