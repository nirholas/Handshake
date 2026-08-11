// Regenerate the static discovery cards in public/ from the live service
// catalog (api/_lib/service-catalog/), so the cards agents and crawlers read
// can never drift from what the platform actually sells.
//
// Why: these files went stale for weeks — agent-registration.json advertised
// ONE paid x402 endpoint while /.well-known/x402.json (rendered live from the
// catalog) advertised 40+, and every description still said "3D model viewer"
// from the pre-agent-economy era. Static files need a generator or they rot.
//
// What it patches (surgically — hand-authored fields are preserved):
//   • public/.well-known/agent-registration.json — description + the FULL
//     x402Endpoints list projected from the catalog (url, method, useCase,
//     networks, scheme, priceUsdc). `registrations` (on-chain write-back,
//     owned by scripts/erc8004-register-self.mjs) is left untouched.
//   • public/.well-known/agent-card.json — description + one generated
//     `x402-service-catalog` skill summarizing the paid catalog by category
//     with live counts and the discovery-doc URL. Hand-written skills stay.
//   • public/.well-known/ai-plugin.json: descriptions, brand logo, and legal
//     URL from scripts/lib/discovery-copy.mjs (free 3D lane first, optional
//     paid catalog second, with the live paid count).
//   • public/crypto-agent-manifest.json — repoints the dead cdn.three.ws host (no DNS; the first-party CDN is /cdn/<r2-key>)
//     sample body at the live default avatar and pins a current model id.
//
// Run: npm run build:discovery   (wired into prebuild so every deploy is fresh)

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { pluginDescriptions, PLUGIN_LOGO_URL, PLUGIN_LEGAL_URL } from './lib/discovery-copy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { getCatalog } = await import(path.join(root, 'api/_lib/service-catalog/index.js'));

const DESCRIPTION =
	'three.ws — the 3D agent economy. Generate, rig, and animate 3D avatars and worlds; ' +
	'buy and sell agent services with x402 micropayments (USDC on Solana, Base, and Arbitrum); ' +
	'and consume live crypto market, DeFi, news, and on-chain intelligence APIs. ' +
	'Machine-readable paid-service catalog at https://three.ws/.well-known/x402.json.';

function readJson(rel) {
	return JSON.parse(readFileSync(path.join(root, rel), 'utf8'));
}

function writeJson(rel, value, { indent = '\t' } = {}) {
	writeFileSync(path.join(root, rel), `${JSON.stringify(value, null, indent)}\n`);
	console.log(`[discovery-cards] wrote ${rel}`);
}

const catalog = await getCatalog();
const paid = catalog.filter((e) => e.source === 'x402' && e.status === 'live');
if (paid.length < 40) {
	// The catalog rendering broke once before (empty-catalog bug, prompt 10) —
	// refuse to "regenerate" the cards down to a stub instead of shipping rot.
	throw new Error(`suspiciously small paid catalog (${paid.length} entries) — refusing to regenerate`);
}

// ── agent-registration.json (ERC-8004 registration-v1) ──────────────────────
{
	const reg = readJson('public/.well-known/agent-registration.json');
	reg.description = DESCRIPTION;
	reg.x402Endpoints = paid.map((e) => ({
		url: e.endpoint,
		method: e.method,
		description: e.useCase,
		networks: e.price.networks,
		scheme: 'exact',
		priceUsdc: e.price.usd,
	}));
	writeJson('public/.well-known/agent-registration.json', reg);
}

// ── agent-card.json (A2A card with the a2a-x402 extension) ───────────────────
{
	const card = readJson('public/.well-known/agent-card.json');
	card.description = DESCRIPTION;
	const byCategory = new Map();
	for (const e of paid) byCategory.set(e.category, (byCategory.get(e.category) || 0) + 1);
	const categorySummary = [...byCategory.entries()]
		.sort((a, b) => b[1] - a[1])
		.map(([cat, n]) => `${cat} (${n})`)
		.join(', ');
	const generated = {
		id: 'x402-service-catalog',
		name: 'Paid x402 Service Catalog',
		description:
			`${paid.length} pay-per-call services settled via x402 (USDC on Solana and Base): ` +
			`${categorySummary}. Every service is listed with price, input schema, and output example ` +
			'in the machine-readable discovery document — fetch it, pick a service, and pay the 402 challenge.',
		tags: ['x402', 'paid', 'catalog', 'discovery'],
		examples: [
			'Fetch https://three.ws/.well-known/x402.json and list the market-data services',
			'Pay the 402 challenge on /api/x402/token-intel to get a token signal',
		],
		url: 'https://three.ws/.well-known/x402.json',
	};
	const idx = card.skills.findIndex((s) => s.id === generated.id);
	if (idx === -1) card.skills.push(generated);
	else card.skills[idx] = generated;
	writeJson('public/.well-known/agent-card.json', card);
}

// ── ai-plugin.json ───────────────────────────────────────────────────────────
// Copy (and the brand/legal URLs) live in scripts/lib/discovery-copy.mjs so the
// committed manifest and this generator can be pinned to each other by
// tests/wellknown-manifests.test.js. The descriptions state the free, keyless
// 3D lane first and the optional paid catalog second: readers used to come away
// believing every three.ws capability, generation included, was pay-per-call.
{
	const plugin = readJson('public/.well-known/ai-plugin.json');
	Object.assign(plugin, pluginDescriptions(paid.length));
	plugin.logo_url = PLUGIN_LOGO_URL;
	plugin.legal_info_url = PLUGIN_LEGAL_URL;
	writeJson('public/.well-known/ai-plugin.json', plugin);
}

// ── crypto-agent-manifest.json (sample agent-manifest/0.2) ───────────────────
{
	const manifest = readJson('public/crypto-agent-manifest.json', { indent: '  ' });
	// cdn.three.ws has no DNS and never did; the first-party CDN is the
	// `/cdn/<r2-key>` route (api/cdn-object.js). Point the sample body at the
	// live default avatar so the manifest demo actually loads.
	manifest.body.uri = 'https://three.ws/avatars/default.glb';
	manifest.brain.model = 'claude-sonnet-5';
	writeJson('public/crypto-agent-manifest.json', manifest, { indent: '  ' });
}

console.log(`[discovery-cards] done — ${paid.length} paid services projected`);
