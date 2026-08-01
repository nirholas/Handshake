// The MCP input-schema reader (scripts/lib/mcp-schema.mjs).
//
// public/mcp-catalog.json is what an external agent reads to decide which
// three.ws tool to call and what to send it. It shipped every tool's name,
// price and safety class and none of their arguments, so the catalog described
// 272 tools that could not be called from it. This reader recovers the
// arguments from source.
//
// Two properties matter more than coverage and both are tested here:
//
//   • it reads every declaration style in the repo: a JSON Schema literal, a
//     raw zod shape, a schema built from a zod shape at import time, and the
//     tool-SDK's `parameters` field;
//   • it never guesses. A bound that only exists at runtime is dropped and the
//     tool is marked partial, because a catalog that is confidently wrong about
//     an argument costs an integrator more than one that admits a gap.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

import { extractInputSchemas, schemaArguments } from '../scripts/lib/mcp-schema.mjs';

const FIXTURES = 'tests/fixtures/mcp-schema';

/** One fixture's single tool, failing loudly if the fixture shape changed. */
function readOne(fixture, name) {
	const map = extractInputSchemas(`${FIXTURES}/${fixture}`);
	const entry = map.get(name);
	expect(entry, `${fixture} declares no tool named ${name}`).toBeDefined();
	return entry;
}

describe('reading a JSON Schema literal', () => {
	const { schema, dynamic, reason } = readOne('json-schema-literal.js', 'mint_thing');

	it('reads the whole schema, including required and formats', () => {
		expect(reason).toBeNull();
		expect(dynamic).toEqual([]);
		expect(schema.required).toEqual(['asset_id']);
		expect(schema.additionalProperties).toBe(false);
		expect(schema.properties.asset_id).toEqual({
			type: 'string',
			format: 'uuid',
			description: 'Which asset to mint.',
		});
	});

	it('follows a bound imported from a sibling module', () => {
		// `maximum: ROYALTY_CAP_BPS` lives in ./constants.js. A reader that stopped
		// at the file boundary dropped exactly these constraints.
		expect(schema.properties.royalty_bps.maximum).toBe(1000);
		expect(schema.properties.royalty_bps.description).toBe(
			'Royalty in basis points, capped at 1000.',
		);
	});

	it('keeps nested object schemas intact', () => {
		expect(schema.properties.metadata.properties.name).toEqual({ type: 'string' });
	});
});

describe('reading a raw zod shape', () => {
	const { schema, reason } = readOne('raw-zod-shape.js', 'find_things');

	it('is not mistaken for JSON Schema by a field named "type"', () => {
		// The regression this guards: classifying by key meant `{ type: z.enum(…) }`
		// read as a JSON Schema whose `type` was an object, and the tool shipped
		// with an empty properties map.
		expect(reason).toBeNull();
		expect(schema.properties.type).toEqual({
			type: 'string',
			enum: ['http', 'mcp'],
			default: 'http',
			description: 'Service kind to search.',
		});
	});

	it('maps zod bounds onto the right JSON Schema keywords', () => {
		expect(schema.properties.query).toMatchObject({ minLength: 1, maxLength: 200 });
		expect(schema.properties.limit).toMatchObject({ type: 'integer', minimum: 1, maximum: 100 });
		expect(schema.properties.threshold).toMatchObject({ type: 'number', exclusiveMinimum: 0 });
	});

	it('treats .optional() and .default() as not-required', () => {
		// `query` has neither; `subscription` is a plain object bound to a named
		// const, which must stay required even through the indirection.
		expect(schema.required).toEqual(['query', 'subscription']);
	});

	it('resolves a regex and an enum that live in another module', () => {
		expect(schema.properties.mint.pattern).toContain('1-9A-HJ-NP-Za-km-z');
		expect(schema.properties.format.enum).toEqual(['mp3', 'wav']);
	});

	it('follows a field hoisted into a const', () => {
		expect(schema.properties.subscription.type).toBe('object');
		expect(schema.properties.subscription.properties.endpoint.format).toBe('uri');
		expect(schema.properties.subscription.description).toBe('A Web Push subscription.');
	});
});

describe('reading a schema built from a zod shape at import time', () => {
	it('follows jsonSchemaFromZod back to the shape it was given', () => {
		const { schema, reason } = readOne('zod-built-schema.js', 'granite_like');
		expect(reason).toBeNull();
		expect(schema.properties.inputs).toEqual({
			type: 'array',
			items: { type: 'string', minLength: 1, maxLength: 8000 },
			minItems: 1,
			maxItems: 64,
			description: 'Texts to embed.',
		});
		expect(schema.required).toEqual(['inputs']);
	});
});

describe('reading the tool-SDK `parameters` field', () => {
	it('finds a tool whose wire name is a const, not a literal', () => {
		const { schema, reason } = readOne('tool-sdk-parameters.js', 'concierge_like');
		expect(reason).toBeNull();
		expect(Object.keys(schema.properties)).toEqual(['question', 'url']);
		expect(schema.required).toEqual(['question']);
	});
});

describe('refusing to guess', () => {
	const { schema, dynamic } = readOne('env-driven-bounds.js', 'spend_thing');

	it('drops a bound that only exists at runtime instead of inventing one', () => {
		expect(schema.properties.usdc.maximum).toBeUndefined();
		expect(schema.properties.usdc.exclusiveMinimum).toBe(0);
	});

	it('reports the gap so the catalog can mark the tool partial', () => {
		expect(dynamic).toContain('inputSchema.properties.usdc.maximum');
	});

	it('keeps the surrounding prose, marking only the hole', () => {
		// Losing a whole sentence of documentation over one interpolated number is
		// a worse trade than showing the sentence with the hole marked.
		expect(schema.properties.usdc.description).toBe('Amount in USDC. Hard per-call cap: $${…}.');
	});

	it('still keeps the argument itself, and its required flag', () => {
		expect(schema.required).toEqual(['usdc']);
	});
});

describe('schemaArguments', () => {
	it('flattens a schema into rows a form or a reference table can render', () => {
		const { schema } = readOne('json-schema-literal.js', 'mint_thing');
		const rows = schemaArguments(schema);
		expect(rows.map((r) => r.name)).toEqual(['asset_id', 'royalty_bps', 'network', 'metadata']);

		const assetId = rows[0];
		expect(assetId).toMatchObject({ type: 'string', required: true, format: 'uuid' });

		const network = rows.find((r) => r.name === 'network');
		expect(network).toMatchObject({ required: false, default: 'mainnet' });
		expect(network.enum).toEqual(['mainnet', 'devnet']);
	});

	it('returns nothing for a tool that takes no arguments', () => {
		expect(schemaArguments({ type: 'object', properties: {} })).toEqual([]);
		expect(schemaArguments(null)).toEqual([]);
	});
});

describe('the published catalog', () => {
	const catalog = JSON.parse(readFileSync('public/mcp-catalog.json', 'utf8'));

	it('carries an input schema for every tool it lists', () => {
		// The whole point of the reader. If this drops, an agent reading the
		// catalog is back to knowing a tool exists and not how to call it.
		const missing = catalog.tools.filter((t) => !t.inputSchema).map((t) => t.name);
		expect(missing).toEqual([]);
		expect(catalog.counts.withSchema).toBe(catalog.counts.tools);
	});

	it('gives every schema the same object shape, so one form builder covers all of them', () => {
		for (const tool of catalog.tools) {
			expect(tool.inputSchema.type, tool.name).toBe('object');
			expect(tool.inputSchema.properties, tool.name).toBeTypeOf('object');
		}
	});

	it('marks the tools whose schema is only partly knowable offline', () => {
		const partial = catalog.tools.filter((t) => t.inputSchemaIsPartial);
		// Real tools with env-driven caps. The count is not the point; the flag
		// being present rather than the constraint being faked is.
		expect(partial.length).toBeGreaterThan(0);
		for (const tool of partial) expect(tool.inputSchema).toBeTruthy();
	});

	it('agrees with the argument counts the console page renders', () => {
		const withArgs = catalog.tools.filter(
			(t) => Object.keys(t.inputSchema.properties).length > 0,
		).length;
		expect(catalog.counts.withArguments).toBe(withArgs);
	});
});
