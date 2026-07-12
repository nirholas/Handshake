// x402 payment wiring: the PaymentRequired envelope a paid tool returns when
// called without a payment payload, the paid() config guards, toolError, and
// the shared zod→JSON-Schema converter.
//
// This file runs with MCP_SVM_PAYMENT_ADDRESS set (payments.js reads env at
// call time) and global fetch stubbed: the facilitator /supported probe is
// answered with a canned in-process payload and every other request is
// rejected, so the PaymentRequired envelope is proven to be computed locally
// and no live network is ever reached.
//
// Run: node --test packages/ibm-x402-mcp/test/payments.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

const PAY_TO = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
process.env.MCP_SVM_PAYMENT_ADDRESS = PAY_TO;

const SOLANA_MAINNET_CAIP = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

// Stub ALL network access for this whole file. The resource server's
// initialize() fetches the facilitator's /supported catalog — answer it with
// the exact-scheme-on-Solana kind it would advertise. Anything else fails loud.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
	if (String(url).endsWith('/supported')) {
		return new Response(
			JSON.stringify({
				kinds: [
					{ x402Version: 1, scheme: 'exact', network: SOLANA_MAINNET_CAIP },
					{ x402Version: 2, scheme: 'exact', network: SOLANA_MAINNET_CAIP },
				],
				extensions: [],
				signers: {},
			}),
			{ status: 200, headers: { 'content-type': 'application/json' } },
		);
	}
	throw new Error(`network blocked in tests (attempted: ${url})`);
};
process.on('exit', () => {
	globalThis.fetch = realFetch;
});

const { paid, toolError, assertPaymentEnv, getLastFacilitatorInitError } = await import(
	'../src/payments.js'
);
const { jsonSchemaFromZod } = await import('../src/tools/_shared.js');
const { buildGraniteChatTool } = await import('../src/tools/granite-chat.js');
const { z } = await import('zod');

const SOLANA_MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const SOLANA_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

test('assertPaymentEnv passes with MCP_SVM_PAYMENT_ADDRESS set', () => {
	assert.doesNotThrow(() => assertPaymentEnv());
});

test('toolError builds the uniform failure shape, with and without extras', () => {
	assert.deepEqual(toolError('watsonx_error', 'boom'), {
		ok: false,
		error: 'watsonx_error',
		message: 'boom',
	});
	assert.deepEqual(toolError('watsonx_error', 'boom', { status: 503 }), {
		ok: false,
		error: 'watsonx_error',
		message: 'boom',
		status: 503,
	});
});

test('paid() rejects a config missing toolName or priceUsd before wiring anything', () => {
	assert.throws(() => paid({ priceUsd: '$0.01' }, async () => {}), /toolName is required/);
	assert.throws(() => paid({ toolName: 'x' }, async () => {}), /priceUsd is required/);
});

test('calling a paid tool without payment returns the x402 PaymentRequired envelope', async () => {
	const tool = await buildGraniteChatTool(null);
	const result = await tool.handler(
		{ messages: [{ role: 'user', content: 'hello' }] },
		{ _meta: undefined },
	);

	assert.equal(result.isError, true, 'a 402 is an error result per the MCP transport spec');
	const pr = result.structuredContent;
	assert.ok(pr, 'PaymentRequired must ride in structuredContent');
	assert.equal(pr.x402Version, 2);
	assert.match(pr.error, /Payment required/i);
	assert.equal(pr.resource.url, 'mcp://tool/ibm_granite_chat');
	assert.equal(pr.resource.mimeType, 'application/json');
	assert.ok(pr.resource.description.includes('$0.02'), 'resource restates the price');

	assert.ok(Array.isArray(pr.accepts) && pr.accepts.length === 1);
	const req = pr.accepts[0];
	assert.equal(req.scheme, 'exact');
	assert.equal(req.network, SOLANA_MAINNET);
	assert.equal(req.payTo, PAY_TO, 'quotes the operator wallet from env');
	assert.equal(req.maxTimeoutSeconds, 60);
	// $0.02 in USDC (6 decimals) = 20000 atomic units.
	assert.equal(req.amount, '20000');
	assert.equal(req.asset, SOLANA_USDC, 'defaults to mainnet USDC mint');
	assert.equal(req.extra.name, 'USDC');
	assert.equal(req.extra.decimals, 6);

	// The Bazaar discovery extension advertises the tool and its input schema.
	const bazaar = pr.extensions?.bazaar?.info?.input;
	assert.ok(bazaar, 'bazaar discovery extension present');
	assert.equal(bazaar.type, 'mcp');
	assert.equal(bazaar.toolName, 'ibm_granite_chat');
	assert.equal(bazaar.transport, 'stdio');
	assert.equal(bazaar.inputSchema.type, 'object');
	assert.ok(bazaar.inputSchema.properties.messages, 'input schema rides in discovery');

	// The same envelope is mirrored as JSON text for clients that only read
	// content. Compare through a JSON round-trip: keys explicitly set to
	// undefined in structuredContent are (correctly) absent from the text form.
	assert.deepEqual(JSON.parse(result.content[0].text), JSON.parse(JSON.stringify(pr)));

	// The stubbed facilitator probe succeeded — no init error was recorded.
	assert.equal(getLastFacilitatorInitError(), null);
});

test('the PaymentRequired envelope is stable across repeat unpaid calls', async () => {
	const tool = await buildGraniteChatTool(null);
	const a = await tool.handler({ messages: [{ role: 'user', content: 'x' }] }, {});
	const b = await tool.handler({ messages: [{ role: 'user', content: 'y' }] }, {});
	assert.deepEqual(
		{ ...a.structuredContent, accepts: a.structuredContent.accepts },
		{ ...b.structuredContent, accepts: b.structuredContent.accepts },
	);
});

test('jsonSchemaFromZod emits a strict draft-7 object schema without a $schema key', () => {
	const schema = jsonSchemaFromZod({
		name: z.string().min(1).describe('A name.'),
		count: z.number().int().min(1).max(10).optional(),
	});
	assert.equal(schema.type, 'object');
	assert.equal(schema.additionalProperties, false, 'strict(): unknown keys rejected');
	assert.ok(!('$schema' in schema));
	assert.deepEqual(schema.required, ['name']);
	assert.equal(schema.properties.name.description, 'A name.');
	assert.equal(schema.properties.count.maximum, 10);
});
