#!/usr/bin/env node
/**
 * Does the official x402 MCP auto-pay client accept an `mcp://tool/<name>`
 * resource URL?
 *
 * The store-submission tracker carried a long-standing claim that it does not,
 * and that claim blocked the agent-commerce listing (prompt 08) on a supposed
 * upstream interop defect. This script settles the question by running the real
 * loop instead of reading the source: an in-memory MCP server whose paid tool is
 * wrapped by `@x402/mcp`'s own `createPaymentWrapper` with the resource URL that
 * `@x402/mcp`'s own `createToolResourceUrl()` mints, and an `x402MCPClient` with
 * auto-payment on and a real Solana `exact` scheme signer.
 *
 * Run it from the repo root:
 *
 *     node scripts/x402-mcp-url-interop-check.mjs
 *
 * The buyer keypair is generated fresh and is deliberately unfunded, so the
 * settlement leg is expected to end in `transaction_simulation_failed`. That is
 * the pass condition, not a failure: reaching simulation proves the client
 * accepted the `mcp://` URL, selected the requirements, signed a payment and put
 * it on the wire. A URL rejection would instead throw before any signing, and
 * `paymentMade` would be false.
 *
 * Exit code 0 means the `mcp://` path is interoperable. Exit code 1 means the
 * defect has reappeared and the details are printed above it.
 *
 * Requires network access to the facilitator. No wallet, key or funds needed.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { HTTPFacilitatorClient, x402ResourceServer } from '@x402/core/server';
import { x402Client } from '@x402/core/client';
import { createPaymentWrapper, createToolResourceUrl, wrapMCPClientWithPayment } from '@x402/mcp';
import { registerExactSvmScheme as registerServerSvm } from '@x402/svm/exact/server';
import { registerExactSvmScheme as registerClientSvm } from '@x402/svm/exact/client';
import { generateKeyPairSigner } from '@solana/kit';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

const NETWORK_SOLANA_MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const SOLANA_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const DEFAULT_FEE_PAYER = 'PayeRNCipcerPHCsYMTrX9pAYDm1LnPGzgb66NUDG5a';
const DEFAULT_FACILITATOR = 'https://facilitator.payai.network';
// Sales settle to the platform Solana address; this check never moves funds.
const PAY_TO = process.env.X402_PAY_TO_SOLANA || 'wwwwwDxFWRn7grgr3Esrsg5C6NvDoDHSA4gaCffccrU';

// These packages do not export `./package.json`, so read the installed manifest
// off disk rather than resolving it through the module graph.
function versionOf(pkg) {
	try {
		return JSON.parse(readFileSync(new URL(`../node_modules/${pkg}/package.json`, import.meta.url), 'utf8')).version;
	} catch {
		return 'unknown';
	}
}

async function main() {
	for (const pkg of ['@x402/mcp', '@x402/core', '@x402/svm']) {
		console.log(`[versions] ${pkg} ${versionOf(pkg)}`);
	}

	const facilitator = new HTTPFacilitatorClient({
		url: process.env.X402_FACILITATOR_URL || DEFAULT_FACILITATOR,
	});
	const resourceServer = new x402ResourceServer([facilitator]);
	registerServerSvm(resourceServer, {});
	await resourceServer.initialize();
	console.log('[server] facilitator initialize: ok');

	const resourceUrl = createToolResourceUrl('demo_paid');
	console.log(`[server] createToolResourceUrl() minted: ${resourceUrl}`);
	if (!resourceUrl.startsWith('mcp://')) {
		console.error('[fail] upstream no longer mints an mcp:// URL; this check needs updating.');
		return 1;
	}

	const accepts = await resourceServer.buildPaymentRequirementsFromOptions(
		[
			{
				scheme: 'exact',
				network: NETWORK_SOLANA_MAINNET,
				payTo: PAY_TO,
				price: '$0.001',
				maxTimeoutSeconds: 60,
				extra: {
					name: 'USDC',
					decimals: 6,
					asset: SOLANA_USDC,
					feePayer: DEFAULT_FEE_PAYER,
				},
			},
		],
		{ resourceUrl },
	);

	const paid = createPaymentWrapper(resourceServer, {
		accepts,
		resource: { url: resourceUrl, description: 'interop check', mimeType: 'application/json' },
	});

	const server = new McpServer({ name: 'x402-mcp-url-interop-check', version: '1.0.0' });
	server.registerTool(
		'demo_paid',
		{ description: 'Paid tool used only by this interop check.', inputSchema: { q: z.string().optional() } },
		paid(async () => ({ content: [{ type: 'text', text: 'paid content' }] })),
	);

	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);

	const signer = await generateKeyPairSigner();
	console.log(`[client] unfunded buyer: ${signer.address}`);
	const paymentClient = new x402Client();
	registerClientSvm(paymentClient, { signer });

	const client = wrapMCPClientWithPayment(new Client({ name: 'interop-check', version: '1.0.0' }), paymentClient, {
		autoPayment: true,
	});
	await client.connect(clientTransport);

	let result;
	try {
		result = await client.callTool('demo_paid', { q: 'interop' }, { timeout: 90_000 });
	} catch (err) {
		console.error(`[fail] auto-pay threw before settlement: ${err.message}`);
		console.error('       An mcp:// URL rejection looks exactly like this. Capture it and file upstream.');
		return 1;
	}

	if (!result.paymentMade) {
		console.error('[fail] the client never produced a payment for the mcp:// resource URL.');
		return 1;
	}

	const body = JSON.stringify(result.content);
	console.log(`[client] paymentMade=${result.paymentMade} isError=${result.isError}`);
	console.log(`[client] server replied: ${body.slice(0, 200)}`);
	if (body.includes('mcp://tool/demo_paid')) {
		console.log('[ok] the mcp:// resource URL survived the whole round trip.');
	}
	console.log('[pass] the mcp:// tool URL is interoperable: the client signed and submitted a payment.');
	console.log('       A settlement failure from the unfunded buyer is expected and is not an interop defect.');
	return 0;
}

process.exitCode = await main();
