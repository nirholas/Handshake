// Guardrail: every paid /api/x402/* endpoint must appear in the
// /.well-known/x402-discovery catalog, or agents (and the CDP Bazaar /
// agentic.market crawlers) can never find it — an unlisted paid endpoint earns
// zero, no matter how good it is. The discovery doc in api/wk.js is
// hand-maintained, so it silently drifts every time a new paid route ships
// without a matching catalog entry. This test makes that drift a red build.
//
// "Paid" is detected structurally: a route file is paid if it wraps the shared
// paidEndpoint() helper OR emits a 402 challenge directly via send402(). Pure
// utility/infra routes (did, my-receipts, pay-by-name — a tx-builder, not a
// 402-gated resource) match neither and are correctly out of scope.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const x402Dir = join(here, '..', '..', 'api', 'x402');

// Routes intentionally absent from the catalog, with the reason each is exempt.
// Keep this list short and justified — it is the only sanctioned escape hatch.
const EXCLUSIONS = new Map([
	[
		'/api/x402/permit2-paid-demo',
		'CDP-only: its sole accept is a Permit2 sibling that permit2VariantOf() ' +
			'returns null without CDP creds, so the live 402 (and thus the catalog) ' +
			'omits the route entirely in non-CDP environments.',
	],
	[
		'/api/x402/service',
		'Dynamic dispatcher, not a single fixed-price route: it serves the paywall ' +
			'for every agent-published listing at /api/x402/service/<slug>. Each ' +
			'concrete listing is cataloged dynamically from agent_paid_services by ' +
			"handleX402Discovery's buildAgentServiceItems(), not as a static entry.",
	],
	[
		'/api/x402/ring-settle',
		'Internal closed-loop settlement primitive (discoverable:false in the ' +
			'endpoint itself): platform-controlled ring wallets pay it to cycle the ' +
			'agent economy. Deliberately NOT on the public bazaar/agentic.market ' +
			'catalog — ring volume is dogfooding, not organic third-party demand, and ' +
			'must not masquerade as such.',
	],
	[
		'/api/x402/three-buy',
		'Internal buy-pressure machinery (discoverable:false in the endpoint ' +
			'itself, same stance as ring-settle): the micro-buy loop pays it to ' +
			'fire small $THREE buys. Not an organic third-party service, so it is ' +
			'deliberately absent from the public discovery catalog.',
	],
	// De-listed in the 2026-07 x402 overhaul (prompt 20): these routes stay live
	// for their in-product consumers but are internal-use only — not agent
	// products — so they no longer appear on x402scan/agentic.market. Each route
	// file carries a matching "INTERNAL-USE ONLY" header.
	[
		'/api/x402/dance-tip',
		'Internal: the /club stage and the /play town Saloon Kid NPC buy dancer ' +
			'performances through it. Novelty tip-jar, not an agent product.',
	],
	[
		'/api/x402/three-intel',
		'Internal: the paid intel kiosk in the /play town buys from it. The ' +
			'agent-facing market read is the free /api/crypto bundle.',
	],
	[
		'/api/x402/tutor',
		'Internal: the /tutor page and the /play Schoolmarm NPC buy through it. ' +
			'Me-too LLM wrapper as an agent product; kept only for the in-product flows.',
	],
	[
		'/api/x402/crypto-intel',
		'Internal: the agent-exchange demo and the /play trading-desk NPC buy ' +
			'through it. Agent-facing market intel is the free /api/crypto bundle.',
	],
	[
		'/api/x402/pump-agent-audit',
		'De-listed per the 2026-07-08 storefront cleanup (prompt 18): the paid ' +
			'"oracle" framing over-claims what a payments-history audit is. The free ' +
			'/api/crypto/whales surface replaces it as the agent product; the /play ' +
			'town NPC still buys through this route.',
	],
]);
// fact-check, mint-to-mesh, and mint-to-mesh-batch were re-listed per the
// 2026-07-08 storefront cleanup (prompt 18) — they now carry real
// service-catalog descriptors (api/_lib/service-catalog/services/) and are
// expected to appear in the discovery doc like any other paid product.

function paidRoutesFromFiles() {
	const routes = [];
	for (const name of readdirSync(x402Dir)) {
		if (!name.endsWith('.js')) continue;
		const src = readFileSync(join(x402Dir, name), 'utf8');
		const isPaid = src.includes('paidEndpoint(') || src.includes('send402(');
		if (!isPaid) continue;
		routes.push(`/api/x402/${name.replace(/\.js$/, '')}`);
	}
	return routes.sort();
}

async function renderDiscovery() {
	// Set the env the discovery builder reads BEFORE importing it, so both Base
	// and Solana accepts are advertised and APP_ORIGIN resolves. No CDP creds →
	// Permit2 siblings are omitted, matching production's non-CDP behavior.
	Object.assign(process.env, {
		APP_ORIGIN: 'https://three.ws',
		X402_PAY_TO_BASE: '0x0000000000000000000000000000000000000001',
		X402_PAY_TO_SOLANA: 'So11111111111111111111111111111111111111112',
		X402_ASSET_ADDRESS_BASE: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
		X402_ASSET_MINT_SOLANA: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
		X402_ASSET_ADDRESS_ARBITRUM: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
		X402_MAX_AMOUNT_REQUIRED: '1000',
		X402_FEE_PAYER_SOLANA: 'So11111111111111111111111111111111111111112',
	});
	const mod = await import('../../api/wk.js');
	const res = {
		statusCode: 0,
		headers: {},
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		end(body) {
			this.body = body;
		},
	};
	const req = {
		method: 'GET',
		url: '/.well-known/x402-discovery?name=x402-discovery',
		query: { name: 'x402-discovery' },
		headers: {},
	};
	await mod.default(req, res);
	return JSON.parse(res.body);
}

describe('x402 discovery catalog parity', () => {
	it('lists every paid /api/x402/* endpoint (no silent drift)', async () => {
		const doc = await renderDiscovery();
		const cataloged = new Set(doc.resources.map((r) => r.path));
		const required = paidRoutesFromFiles().filter((r) => !EXCLUSIONS.has(r));

		const missing = required.filter((r) => !cataloged.has(r));
		expect(
			missing,
			`Paid x402 endpoints missing from /.well-known/x402-discovery: ${missing.join(
				', ',
			)}. Add a matching resources[] entry in api/wk.js handleX402Discovery, ` +
				`or document an exemption in EXCLUSIONS with a reason.`,
		).toEqual([]);
	});

	it('only exempts routes that still exist as paid endpoints', async () => {
		// Stops EXCLUSIONS from rotting: an exemption for a deleted/renamed route
		// would otherwise hide a real gap forever.
		const paid = new Set(paidRoutesFromFiles());
		const stale = [...EXCLUSIONS.keys()].filter((r) => !paid.has(r));
		expect(
			stale,
			`Stale EXCLUSIONS entries (route no longer paid): ${stale.join(', ')}`,
		).toEqual([]);
	});

	it('catalogs both hosted MCP servers with their own identities', async () => {
		// The 3D Studio (text→3D) lived for months as a deployed-but-uncataloged
		// endpoint — x402 facilitators could never index it. Keep both MCP
		// transports in the discovery doc, each under its own service identity.
		const doc = await renderDiscovery();
		const mcp = doc.resources.find((r) => r.path === '/api/mcp');
		const studio = doc.resources.find((r) => r.path === '/api/mcp-3d');
		expect(mcp, '/api/mcp missing from discovery').toBeTruthy();
		expect(studio, '/api/mcp-3d missing from discovery').toBeTruthy();
		expect(studio.serviceName).toBe('three.ws 3D Studio MCP');
		expect(studio.description).toContain('text_to_3d');
		expect(studio.extensions.bazaar.info.input.body.params.name).toBe('text_to_3d');
		expect(studio.accepts.length).toBeGreaterThan(0);
	});

	it('every cataloged x402 resource carries a price and at least one accept', async () => {
		const doc = await renderDiscovery();
		const x402Resources = doc.resources.filter((r) => r.path?.startsWith('/api/x402/'));
		expect(x402Resources.length).toBeGreaterThan(0);
		for (const r of x402Resources) {
			expect(
				Array.isArray(r.accepts) && r.accepts.length > 0,
				`${r.path} has no accepts`,
			).toBe(true);
			for (const a of r.accepts) {
				expect(
					typeof a.amount === 'string' && a.amount.length > 0,
					`${r.path} accept amount`,
				).toBe(true);
				expect(Boolean(a.payTo), `${r.path} accept payTo`).toBe(true);
			}
		}
	});
	it('server profile leads with the real positioning (prompt 22)', async () => {
		// The x402scan storefront window: the top-level profile must pitch the
		// actual product mix, carry filterable categories, and never regress to
		// the old "3D model viewer" blurb that undersold the platform.
		const doc = await renderDiscovery();
		const svc = doc.service;
		expect(svc.tagline).toContain('3D generation + crypto data');
		expect(svc.description).toContain('Free Crypto Data API');
		expect(svc.description).toContain('Forge Pro');
		expect(svc.categories).toEqual(['3D', 'AI', 'Crypto', 'Data', 'Utility']);
		expect(svc.tags).toContain('text-to-3d');
		expect(svc.tags).toContain('crypto-data');
	});

	it('no resource ships an empty or placeholder description', async () => {
		// A blank card on x402scan reads as abandonware. Every cataloged resource
		// must carry a substantive description (the profile overhaul bar: leads
		// with the use-case and states the price).
		const doc = await renderDiscovery();
		for (const r of doc.resources) {
			const d = String(r.description || '');
			expect(d.length, `${r.path} description too short: "${d}"`).toBeGreaterThanOrEqual(60);
			expect(d).not.toMatch(/TODO|placeholder|tbd/i);
		}
	});

	it('every cataloged resource is tagged for category filtering', async () => {
		const doc = await renderDiscovery();
		for (const r of doc.resources) {
			expect(
				Array.isArray(r.tags) && r.tags.length >= 2,
				`${r.path} needs at least two tags for storefront filters`,
			).toBe(true);
		}
	});
});
