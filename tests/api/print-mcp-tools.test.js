// The Materialize MCP tools: how an agent discovers that a model it just
// generated can also be manufactured.
//
// The pair is deliberately read-only. Ordering is an x402 settlement the agent
// performs with the address and the exact total in front of it, so these tools
// price and stop. This suite pins that boundary, that both tools are actually
// in the served catalog (a tool nothing lists does not exist), and that the
// fabrication gate reaches an agent through this lane with a category and a
// policy link rather than a bare failure.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const REPORT = {
	version: 1,
	manifold: true,
	shells: 1,
	triangles: 4200,
	volume_cm3: 27.14,
	bbox_mm: { x: 41, y: 120, z: 38, diagonal: 133 },
	min_wall_mm: 2.4,
	median_wall_mm: 6.1,
	recommended_min_height_mm: { resin: 120, sls_nylon: 120, full_color: 133, fdm_draft: 120, metal: 120 },
	score: 100,
	deductions: [],
};

let creationPrompt = 'a small brass gear';

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		mcpPrintAnalyze: async () => ({ success: true, reset: Date.now() + 60_000 }),
		mcpPrintQuote: async () => ({ success: true, reset: Date.now() + 60_000 }),
	},
	clientIp: () => '203.0.113.11',
}));
vi.mock('../../api/_lib/print/mesh-io.js', () => ({
	loadMeshFromUrl: async () => ({ triangleCount: 4200 }),
	MeshIoError: class extends Error {},
}));
vi.mock('../../api/_lib/print/analyze.js', () => ({ analyzeMesh: async () => REPORT }));
vi.mock('../../api/_lib/forge-store.js', () => ({
	getPublicCreation: async () => ({ id: 'c-9', glb_url: 'https://cdn.three.ws/m.glb', prompt: creationPrompt }),
}));
// Only the gate's lineage read touches the database; the rules and layers under
// test are the shipped ones.
vi.mock('../../api/_lib/db.js', () => ({ sql: async () => [] }));

const { toolDefs } = await import('../../api/_mcp/tools/print.js');
const analyze = toolDefs.find((t) => t.name === 'print_analyze');
const quote = toolDefs.find((t) => t.name === 'print_quote');
const auth = { userId: null, rateKey: 'test' };

beforeEach(() => {
	creationPrompt = 'a small brass gear';
});

describe('discovery', () => {
	it('both tools are in the served MCP catalog', async () => {
		const { TOOL_CATALOG } = await import('../../api/_mcp/catalog.js');
		const names = TOOL_CATALOG.map((t) => t.name);
		expect(names).toContain('print_analyze');
		expect(names).toContain('print_quote');
	});

	it('declares itself read-only, because neither tool can commit a shipment', () => {
		for (const tool of toolDefs) {
			expect(tool.annotations.readOnlyHint, tool.name).toBe(true);
			expect(tool.annotations.destructiveHint, tool.name).toBe(false);
		}
	});

	it('the quote tool points the agent at the endpoint that actually orders', () => {
		expect(quote.description).toContain('/api/x402/print-order');
		expect(quote.description).toContain('does NOT place an order');
	});
});

describe('print_analyze', () => {
	it('returns the report and the materials that fit', async () => {
		const result = await analyze.handler({ creation_id: 'c-9' }, auth);
		expect(result.structuredContent.report.version).toBe(1);
		expect(Array.isArray(result.structuredContent.fits)).toBe(true);
		expect(result.content[0].text).toContain('Printability score 100/100');
		expect(result.content[0].text).toContain('27.14 cm3');
	});

	it('needs a model to look at', async () => {
		await expect(analyze.handler({}, auth)).rejects.toThrow(/creation_id or glb_url/);
	});
});

describe('print_quote', () => {
	it('prices a real material and returns a signed token an agent can settle', async () => {
		const result = await quote.handler(
			{ creation_id: 'c-9', material_id: 'resin-standard', target_height_mm: 120, quantity: 1, country: 'US' },
			auth,
		);
		const { quote: priced, token, order_endpoint } = result.structuredContent;
		expect(priced.currency).toBe('USDC');
		expect(priced.chain).toBe('solana');
		expect(priced.total).toBeGreaterThan(0);
		expect(token).toMatch(/^pq1\./);
		expect(order_endpoint).toBe('/api/x402/print-order');
		// The itemization is what the agent shows its user, so it is in the text.
		expect(result.content[0].text).toContain('Build setup');
		expect(result.content[0].text).toContain('Total');
	});

	it('answers "what could this be made of" instead of erroring when no material was picked', async () => {
		const result = await quote.handler({ creation_id: 'c-9' }, auth);
		expect(result.structuredContent.quote).toBeNull();
		expect(result.structuredContent.token).toBeNull();
		expect(result.content[0].text).toContain('Materials that fit this mesh');
	});

	it('carries a fabrication refusal to the agent with a category and a live policy link', async () => {
		const err = await quote
			.handler(
				{ creation_id: 'c-9', note: 'add a monocore baffle so it works as a suppressor', material_id: 'resin-standard', target_height_mm: 120, country: 'US' },
				auth,
			)
			.catch((e) => e);
		expect(err.data.reason).toBe('fabrication_refused');
		expect(err.data.category).toBe('suppressors');
		expect(err.data.policy_url).toBe('/docs/materialize#content-policy');
		expect(err.data.allowed).toBeTruthy();
	});

	it('reads the prompt lineage, not just the buyer note', async () => {
		creationPrompt = 'an AR-15 lower receiver';
		const err = await quote
			.handler({ creation_id: 'c-9', material_id: 'resin-standard', target_height_mm: 120, country: 'US' }, auth)
			.catch((e) => e);
		expect(err.data.category).toBe('firearm_components');
	});
});
