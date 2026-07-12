// Behavior of the free ibm_granite_getting_started tool: the full overview
// payload, every focused section, and consistency between the in-file catalog
// and the published package. Runs fully in-process — no payment, no network.
//
// Run: node --test packages/ibm-x402-mcp/test/getting-started.test.mjs

import { createRequire } from 'node:module';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

import { buildGettingStartedTool } from '../src/tools/getting-started.js';

const require = createRequire(import.meta.url);
const PKG_VERSION = require('../package.json').version;

// Published per-call USDC prices — the same table tools.test.mjs pins.
const PAID_PRICES = {
	ibm_granite_chat: '$0.02',
	ibm_granite_code: '$0.025',
	ibm_granite_embed: '$0.005',
	ibm_granite_analyze: '$0.04',
	ibm_granite_forecast: '$0.05',
};

let tool;

before(async () => {
	tool = await buildGettingStartedTool();
});

test('the default overview returns the full catalog with the real package version', async () => {
	const res = await tool.handler({});
	const p = res.structuredContent;
	assert.equal(p.ok, true);
	assert.equal(p.server, 'ibm-x402-mcp');
	assert.equal(p.version, PKG_VERSION, 'payload version must match package.json');
	assert.equal(p.tools.length, 5);
	assert.equal(p.payment_flow.length, 4);
	assert.ok(p.setup.operators.required.MCP_SVM_PAYMENT_ADDRESS, 'operator env docs present');
	assert.ok(p.next_step.length > 0);
	// The rendered text is a readable markdown doc, not raw JSON.
	const text = res.content[0].text;
	assert.match(text, /^# IBM Granite x402 MCP — Getting Started/);
	assert.match(text, /## How payment works \(x402\)/);
	for (const name of Object.keys(PAID_PRICES)) assert.ok(text.includes(name), `${name} in text`);
});

test('the catalog names and prices match the published paid-tool table exactly', async () => {
	const { structuredContent: p } = await tool.handler({});
	const catalog = Object.fromEntries(p.tools.map((t) => [t.name, t.price]));
	assert.deepEqual(catalog, PAID_PRICES);
	// The pricing strings restate the same numbers.
	for (const [name, price] of Object.entries(PAID_PRICES)) {
		assert.ok(p.pricing.includes(`${name}: ${price}/call`), `pricing line for ${name}`);
	}
	// Every catalog entry documents params and a runnable example.
	for (const t of p.tools) {
		assert.ok(t.summary.length > 0, `${t.name} summary`);
		assert.ok(t.params.length > 0, `${t.name} params`);
		assert.ok(t.example && typeof t.example === 'object', `${t.name} example`);
	}
});

test('section=pricing narrows to prices only', async () => {
	const { structuredContent: p } = await tool.handler({ section: 'pricing' });
	assert.equal(p.ok, true);
	assert.equal(p.pricing.length, 5);
	assert.deepEqual(Object.keys(p.tools[0]).sort(), ['name', 'price', 'summary']);
	assert.ok(!('payment_flow' in p));
	assert.ok(!('overview' in p));
});

test('section=payment returns the flow and setup; section=setup returns setup and links', async () => {
	const pay = (await tool.handler({ section: 'payment' })).structuredContent;
	assert.equal(pay.payment_flow.length, 4);
	assert.match(pay.payment_flow[0], /PaymentRequired envelope/);
	assert.ok(pay.setup.endUsers.length > 0);
	assert.ok(!('tools' in pay));

	const setup = (await tool.handler({ section: 'setup' })).structuredContent;
	assert.ok(setup.setup.operators.required.WATSONX_API_KEY);
	assert.equal(setup.links.npm, 'https://www.npmjs.com/package/@three-ws/ibm-x402-mcp');
	assert.ok(!('payment_flow' in setup));
});

test('section=tools returns just the tool catalog, rendered as compact JSON', async () => {
	const res = await tool.handler({ section: 'tools' });
	const p = res.structuredContent;
	assert.deepEqual(Object.keys(p).sort(), ['ok', 'tools']);
	assert.equal(p.tools.length, 5);
	// Focused sections render as JSON text the model can read directly.
	assert.deepEqual(JSON.parse(res.content[0].text), p);
});

test('an unknown/absent section falls back to the full overview', async () => {
	const byDefault = (await tool.handler(undefined)).structuredContent;
	assert.ok(byDefault.overview, 'no args → overview');
	const explicit = (await tool.handler({ section: 'overview' })).structuredContent;
	assert.deepEqual(explicit, byDefault);
});
