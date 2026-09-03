#!/usr/bin/env node
// Minimal reproduction of an upstream x402 defect, kept runnable so the report
// filed against x402-foundation/x402 can be re-checked against any new release.
//
// The defect, in one sentence: @x402/mcp mints `mcp://tool/<name>` resource URLs
// for MCP tools, and @x402/extensions' bazaar discovery cannot canonicalize
// them, so every MCP tool row a bazaar indexer ingests is keyed on the literal
// string "null".
//
// Why: `extractDiscoveryInfo` builds its canonical URL as `${url.origin}${url.pathname}`.
// `mcp:` is not a WHATWG "special" scheme, so `new URL('mcp://tool/x').origin`
// is the string "null" and the host lands in the pathname. The two packages ship
// from the same monorepo, so the producer and the consumer disagree about a URL
// neither side treats as invalid.
//
// three.ws is unaffected in settlement: the official auto-pay client pays these
// tools correctly (verified against our stdio server). Only bazaar discovery
// rows are corrupted, which is why this is filed rather than worked around.
//
// Run: node scripts/x402-bazaar-mcp-url-repro.mjs   (exit 1 while the bug is live)

import { createToolResourceUrl } from '@x402/mcp';
import { declareDiscoveryExtension, extractDiscoveryInfo } from '@x402/extensions/bazaar';
import { readFileSync } from 'node:fs';

// Both packages restrict their `exports` map, so read the versions off disk
// rather than importing package.json through the resolver.
const pkgVersion = (name) =>
	JSON.parse(readFileSync(new URL(`../node_modules/${name}/package.json`, import.meta.url), 'utf8')).version;
const versions = {
	'@x402/mcp': pkgVersion('@x402/mcp'),
	'@x402/extensions': pkgVersion('@x402/extensions'),
	node: process.version,
};
console.log('versions:', JSON.stringify(versions));

const toolName = 'example_paid_tool';
const resourceUrl = createToolResourceUrl(toolName);
console.log(`createToolResourceUrl(${JSON.stringify(toolName)}) -> ${resourceUrl}`);
console.log(`new URL(resourceUrl).origin -> ${JSON.stringify(new URL(resourceUrl).origin)}`);

const paymentRequired = {
	x402Version: 2,
	error: 'Payment required to access this tool',
	resource: { url: resourceUrl, description: 'An example paid MCP tool.', mimeType: 'application/json' },
	accepts: [],
	extensions: declareDiscoveryExtension({
		toolName,
		description: 'An example paid MCP tool.',
		inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
	}),
};

const info = extractDiscoveryInfo(paymentRequired, undefined);
const canonical = info?.resourceUrl;
console.log(`extractDiscoveryInfo(...).resourceUrl -> ${JSON.stringify(canonical)}`);

const expected = `mcp://tool/${toolName}`;
if (canonical === expected) {
	console.log('\nFIXED: the canonical discovery URL now round-trips the mcp:// resource.');
	process.exit(0);
}
console.error(
	`\nBUG: expected the canonical URL to round-trip ${JSON.stringify(expected)}, got ` +
		`${JSON.stringify(canonical)}. Every MCP row an indexer keys on this URL collides on "null".`,
);
process.exit(1);
