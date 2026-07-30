#!/usr/bin/env node
// Generate public/mcp-catalog.json: the machine-readable catalog of every MCP
// tool three.ws publishes.
//
// Why generate it. The tool list, its prices, and its safety annotations were
// documented by hand in docs/mcp-tools.md, which meant three copies of the truth
// (the code, the doc, the price map) drifting apart quietly. This reads all
// three from source, so the catalog cannot be wrong about a tool that exists,
// and `npm run audit:mcp-catalog` fails the build when the committed file no
// longer matches what the code says.
//
// The output serves two readers at once: the /mcp-tools page renders it, and an
// agent can fetch https://three.ws/mcp-catalog.json to discover the whole
// surface (name, description, input schema, price, safety) in one request.
//
// Everything is parsed statically with acorn. Project doctrine forbids importing
// the hosted catalogs here: they pull in DB and RPC clients that block without
// live credentials, which would make a docs build depend on production.
//
// Run: node scripts/build-mcp-catalog.mjs            (write the catalog)
//      node scripts/build-mcp-catalog.mjs --check     (exit 1 if out of date)

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'acorn';

import { ROOT, mcpToolSources } from './lib/mcp-tool-sources.mjs';
import { extractTools } from './lib/mcp-safety-check.mjs';

const OUT = join(ROOT, 'public', 'mcp-catalog.json');

// ---------------------------------------------------------------------------
// Which server publishes a given tool-definition file
// ---------------------------------------------------------------------------
// `transport: 'remote'` servers answer at a URL; `stdio` servers install from
// npm. `id` matches the registry manifest so a reader can cross-reference.

const HOSTED_SERVERS = [
	{
		match: (f) => f.startsWith('api/_mcp/tools/'),
		id: 'three.ws',
		title: 'three.ws',
		endpoint: '/api/mcp',
		transport: 'remote',
		auth: 'oauth-or-x402',
	},
	{
		match: (f) => f.startsWith('api/_mcp3d/tools/'),
		id: 'threews-3d-studio',
		title: '3D Studio',
		endpoint: '/api/mcp-3d',
		transport: 'remote',
		auth: 'oauth-or-x402',
	},
	{
		match: (f) => f.startsWith('api/_mcp-studio/'),
		id: 'threews-3d-studio-free',
		title: '3D Studio (free)',
		endpoint: '/api/mcp-studio',
		transport: 'remote',
		auth: 'none',
	},
	{
		match: (f) => f.startsWith('api/_mcpagent/'),
		id: 'threews-agent',
		title: 'Agent Wallet',
		endpoint: '/api/mcp-agent',
		transport: 'remote',
		auth: 'oauth-or-x402',
	},
	{
		match: (f) => f.startsWith('api/_mcpbazaar/'),
		id: 'threews-x402-bazaar',
		title: 'x402 Bazaar',
		endpoint: '/api/mcp-bazaar',
		transport: 'remote',
		auth: 'none',
	},
	{
		match: (f) => f.startsWith('api/_mcpibm/'),
		id: 'ibm-x402-mcp-remote',
		title: 'IBM Granite',
		endpoint: '/api/ibm-mcp',
		transport: 'remote',
		auth: 'x402',
	},
	{
		match: (f) => f.startsWith('api/_okx3d/'),
		id: 'threews-okx-3d',
		title: 'OKX 3D (A2MCP)',
		endpoint: '/api/okx/3d',
		transport: 'remote',
		auth: 'x402',
	},
	{
		match: (f) => f === 'src/pump/mcp-tools.js',
		id: 'threews-pumpfun',
		title: 'pump.fun',
		endpoint: '/api/pump-fun-mcp',
		transport: 'remote',
		auth: 'none',
	},
	{
		match: (f) => f.startsWith('mcp-server/src/tools/'),
		id: 'mcp-server',
		title: '@three-ws/mcp-server',
		endpoint: 'npx -y @three-ws/mcp-server',
		transport: 'stdio',
		auth: 'api-key',
	},
];

/** Resolve a tool-definition file to the server that publishes it. */
function serverFor(relPath) {
	const hosted = HOSTED_SERVERS.find((s) => s.match(relPath));
	if (hosted) {
		const { match: _match, ...server } = hosted;
		return server;
	}
	const pkg = relPath.match(/^packages\/([\w-]+)-mcp\/src\/tools\//);
	if (pkg) {
		return {
			id: `${pkg[1]}-mcp`,
			title: `@three-ws/${pkg[1]}-mcp`,
			endpoint: `npx -y @three-ws/${pkg[1]}-mcp`,
			transport: 'stdio',
			auth: 'api-key',
		};
	}
	return { id: 'unknown', title: relPath, endpoint: null, transport: 'unknown', auth: 'unknown' };
}

// ---------------------------------------------------------------------------
// Prices, read statically from the per-server price maps
// ---------------------------------------------------------------------------

// Each server keeps its per-tool price map in a const named TOOL_PRICING.
const PRICE_SOURCES = [
	'api/_lib/pump-pricing.js',
	'api/_mcp3d/pricing.js',
	'api/_mcpibm/pricing.js',
];

const TIER_SOURCE = 'api/_lib/forge-tiers.js';
const ATOMIC_PER_USD = 1_000_000;

/** Parse a module once. */
function parseFile(relPath) {
	const abs = join(ROOT, relPath);
	if (!existsSync(abs)) return null;
	return parse(readFileSync(abs, 'utf8'), { ecmaVersion: 'latest', sourceType: 'module' });
}

/** Find the object literal assigned to a named const. */
function findConstObject(ast, constName) {
	let found = null;
	walk(ast, (node) => {
		if (found) return;
		if (node.type === 'VariableDeclarator' && node.id?.name === constName) {
			found = unwrapFreeze(node.init);
		}
	});
	return found;
}

/**
 * The forge generation tiers, in price order. Two studio tools are priced per
 * tier rather than by a flat literal, so the catalog reads the real tier table
 * instead of reporting them free.
 * @returns {{id: string, usd: number}[]}
 */
function collectTiers() {
	const ast = parseFile(TIER_SOURCE);
	const tiers = ast && findConstObject(ast, 'TIERS');
	if (!tiers) return [];
	const out = [];
	for (const prop of tiers.properties) {
		if (prop.type !== 'Property' || prop.computed) continue;
		const entry = unwrapFreeze(prop.value);
		if (!entry) continue;
		for (const field of entry.properties) {
			if (field.type !== 'Property' || field.computed) continue;
			if ((field.key?.name ?? field.key?.value) !== 'priceUsdcAtomics') continue;
			if (field.value.type !== 'Literal') continue;
			out.push({
				id: prop.key?.name ?? prop.key?.value,
				usd: Number(field.value.value) / ATOMIC_PER_USD,
			});
		}
	}
	return out.sort((a, b) => a.usd - b.usd);
}

/**
 * Every priced tool, from the repo's price maps. A tool absent from all of them
 * is free, the convention the pricing modules themselves document. An entry
 * whose `amount_usdc` is computed rather than literal is tier-priced: it gets
 * the tier table and its default price, never a silent zero.
 * @returns {Map<string, {usd: number, tiers?: {id: string, usd: number}[]}>}
 */
function collectPrices() {
	const tiers = collectTiers();
	const defaultTier = tiers.find((t) => t.id === 'standard') ?? tiers[0] ?? null;
	const prices = new Map();

	for (const file of PRICE_SOURCES) {
		const ast = parseFile(file);
		const mapNode = ast && findConstObject(ast, 'TOOL_PRICING');
		if (!mapNode) continue;

		for (const prop of mapNode.properties) {
			if (prop.type !== 'Property' || prop.computed) continue;
			const toolName = prop.key?.name ?? prop.key?.value;
			const entry = unwrapFreeze(prop.value);
			if (!entry || typeof toolName !== 'string') continue;

			const amount = entry.properties.find(
				(f) => f.type === 'Property' && !f.computed && (f.key?.name ?? f.key?.value) === 'amount_usdc',
			);
			if (!amount) continue;

			if (amount.value.type === 'Literal') {
				prices.set(toolName, { usd: Number(amount.value.value) });
			} else if (defaultTier) {
				prices.set(toolName, { usd: defaultTier.usd, tiers });
			} else {
				throw new Error(
					`${file}: ${toolName} has a computed amount_usdc and no tier table to resolve it against.`,
				);
			}
		}
	}
	return prices;
}

function unwrapFreeze(node) {
	if (!node) return null;
	if (node.type === 'ObjectExpression') return node;
	if (
		node.type === 'CallExpression' &&
		node.callee.type === 'MemberExpression' &&
		node.callee.property?.name === 'freeze' &&
		node.arguments.length === 1
	) {
		return unwrapFreeze(node.arguments[0]);
	}
	return null;
}

function walk(node, visit) {
	if (!node || typeof node.type !== 'string') return;
	visit(node);
	for (const key of Object.keys(node)) {
		if (key === 'type' || key === 'start' || key === 'end') continue;
		const value = node[key];
		if (Array.isArray(value)) for (const child of value) walk(child, visit);
		else if (value && typeof value.type === 'string') walk(value, visit);
	}
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/**
 * How a caller should treat a tool, derived from its annotations. This is the
 * single label the UI sorts and filters on.
 * @returns {'read'|'write'|'irreversible'}
 */
function safetyClass({ readOnlyHint, destructiveHint }) {
	if (readOnlyHint === true) return 'read';
	return destructiveHint === true ? 'irreversible' : 'write';
}

function build() {
	const prices = collectPrices();
	const tools = [];

	for (const relPath of mcpToolSources()) {
		const { parseError, tools: found } = extractTools(relPath);
		if (parseError) throw new Error(`${relPath}: ${parseError}`);
		const server = serverFor(relPath);

		for (const tool of found) {
			const hints = tool.annotations.values ?? {};
			const price = prices.get(tool.name) ?? null;
			tools.push({
				name: tool.name,
				title: tool.title ?? null,
				description: tool.description ?? null,
				server,
				safety: safetyClass(hints),
				annotations: {
					readOnlyHint: hints.readOnlyHint ?? null,
					destructiveHint: hints.destructiveHint ?? null,
					idempotentHint: hints.idempotentHint ?? null,
					openWorldHint: hints.openWorldHint ?? null,
				},
				price: {
					usd: price?.usd ?? 0,
					free: !price,
					...(price?.tiers ? { tiers: price.tiers } : {}),
				},
				source: relPath,
			});
		}
	}

	tools.sort((a, b) => a.server.id.localeCompare(b.server.id) || a.name.localeCompare(b.name));

	const byServer = new Map();
	for (const tool of tools) {
		if (!byServer.has(tool.server.id)) byServer.set(tool.server.id, { ...tool.server, tools: 0 });
		byServer.get(tool.server.id).tools += 1;
	}

	return {
		$comment:
			'Generated by scripts/build-mcp-catalog.mjs from the tool definitions and price maps in this repo. Do not edit by hand: npm run build:mcp-catalog regenerates it and npm run audit:mcp-catalog fails the build when it is stale.',
		docs: 'https://three.ws/docs/mcp-safety',
		counts: {
			tools: tools.length,
			servers: byServer.size,
			free: tools.filter((t) => t.price.free).length,
			paid: tools.filter((t) => !t.price.free).length,
			read: tools.filter((t) => t.safety === 'read').length,
			write: tools.filter((t) => t.safety === 'write').length,
			irreversible: tools.filter((t) => t.safety === 'irreversible').length,
		},
		servers: [...byServer.values()].sort((a, b) => a.id.localeCompare(b.id)),
		tools,
	};
}

const catalog = build();
const serialized = `${JSON.stringify(catalog, null, '\t')}\n`;

if (process.argv.includes('--check')) {
	const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
	if (current !== serialized) {
		console.error('[audit:mcp-catalog] public/mcp-catalog.json is stale.');
		console.error('  A tool, price, or annotation changed without regenerating the catalog.');
		console.error('  Fix: npm run build:mcp-catalog');
		process.exit(1);
	}
	const { tools, servers } = catalog.counts;
	console.log(`[audit:mcp-catalog] catalog matches source: ${tools} tools across ${servers} servers`);
} else {
	writeFileSync(OUT, serialized);
	const { tools, servers, free, paid } = catalog.counts;
	console.log(
		`[build:mcp-catalog] wrote public/mcp-catalog.json: ${tools} tools, ${servers} servers (${free} free, ${paid} paid)`,
	);
}
