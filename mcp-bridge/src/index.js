#!/usr/bin/env node
// MCP stdio bridge: exposes the x402 ecosystem as Claude-callable tools.
//
// Tools registered on startup:
//   1. call_paid_endpoint(url, method?, body?, params?, headers?) — universal
//      fallback. Hits ANY x402-paid URL with auto-payment.
//   2. list_bazaar_tools() — returns the cached set of Bazaar-discovered tools.
//   3. refresh_bazaar() — re-runs Bazaar discovery and re-registers tools.
//   4. One dynamic tool per Bazaar resource (up to MCP_BRIDGE_DISCOVER_LIMIT).
//      Each dynamic tool's input shape is permissive (body/queryParams/pathParams)
//      so we can pass through whatever the LLM constructs. The bazaar's
//      published JSON Schema is included in the tool DESCRIPTION so the LLM
//      can see required fields without us converting the schema to Zod.
//
// Transport: stdio. Claude Desktop launches the bridge with this server file
// as `command` and reads/writes JSON-RPC frames over stdin/stdout.

import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { buildBuyerAxios, extractReceipt } from './x402-axios-client.js';
import { discoverBazaarTools } from './bazaar-discover.js';
import { assertPayableUrl } from './url-guard.js';
import { asTextContent, asErrorContent } from './content.js';

const BRIDGE_NAME = 'three-ws-x402-bridge';
// Version is read from package.json so serverInfo can never drift from the
// published package version (tests/bridge-boot.test.mjs asserts they match).
const BRIDGE_VERSION = createRequire(import.meta.url)('../package.json').version;

const log = (...args) => {
	// MCP stdio: stdout is reserved for protocol frames. Diagnostics MUST go
	// to stderr so the transport stays parseable.
	process.stderr.write(`[${BRIDGE_NAME}] ${args.map(String).join(' ')}\n`);
};

// Annotation profiles (MCP ToolAnnotations). Payment tools spend real funds:
// not read-only, not idempotent (every call settles a new payment), and
// open-world (they reach arbitrary external endpoints) — but not destructive
// (they never delete or overwrite caller state).
const PAYMENT_TOOL_ANNOTATIONS = {
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: false,
	openWorldHint: true,
};

function decodePaymentResponseFromHeaders(headers) {
	if (!headers) return undefined;
	const raw = headers['x-payment-response'] ?? headers['X-PAYMENT-RESPONSE'];
	if (!raw || typeof raw !== 'string') return undefined;
	try {
		return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
	} catch {
		return undefined;
	}
}

async function callPaidEndpoint({ api, httpClient }, args) {
	const { url, method = 'GET', body, params, headers } = args;
	// SSRF chokepoint: validate scheme + resolve host before any payment-wrapped
	// request leaves the process. Throws on private/blocked targets.
	const safeUrl = await assertPayableUrl(url);
	const normalizedMethod = String(method).toUpperCase();
	const hasBody = body !== undefined && body !== null;
	const res = await api.request({
		url: safeUrl,
		method: normalizedMethod,
		data: hasBody ? body : undefined,
		params,
		headers: headers ?? undefined,
	});
	const receipt =
		extractReceipt(httpClient, res) ?? decodePaymentResponseFromHeaders(res.headers);
	return {
		status: res.status,
		data: res.data,
		paymentReceipt: receipt ?? null,
	};
}

function registerCallPaidEndpoint(server, deps) {
	server.registerTool(
		'call_paid_endpoint',
		{
			title: 'Call any x402-paid endpoint',
			description:
				'Calls any HTTP URL that returns 402 with x402 payment requirements, automatically signing and paying. ' +
				'SPENDS REAL MONEY: each call settles a USDC payment from the bridge wallet (capped by ' +
				'MCP_BRIDGE_MAX_PRICE_PER_CALL_ATOMIC), and retrying is a new charge. ' +
				'Supports EVM exact, EVM batch-settlement, and Solana exact schemes. ' +
				'Returns the resource response plus the parsed settlement receipt.',
			annotations: PAYMENT_TOOL_ANNOTATIONS,
			inputSchema: {
				url: z.string().url().describe('Full URL of the x402-paid resource'),
				method: z
					.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'])
					.optional()
					.describe('HTTP method. Defaults to GET.'),
				body: z
					.any()
					.optional()
					.describe('Request body for POST/PUT/PATCH. Will be JSON-encoded.'),
				params: z
					.record(z.any())
					.optional()
					.describe('Query string parameters as an object.'),
				headers: z
					.record(z.string())
					.optional()
					.describe('Additional request headers (do NOT set X-PAYMENT manually).'),
			},
		},
		async (args) => {
			try {
				const result = await callPaidEndpoint(deps, args);
				return asTextContent(result);
			} catch (err) {
				return asErrorContent(`call_paid_endpoint failed: ${err?.message || err}`);
			}
		},
	);
}

function registerListBazaarTools(server, getCached) {
	server.registerTool(
		'list_bazaar_tools',
		{
			title: 'List Bazaar-discovered tools',
			description:
				'Returns the cached list of x402 Bazaar resources registered as MCP tools on this bridge. Free: reads the in-process cache only, no network and no payment.',
			// Pure cache read: no side effects, no external interaction.
			annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
			inputSchema: {},
		},
		async () => {
			const cached = getCached();
			return asTextContent(
				cached.map(({ name, resource, method, acceptSummary, description }) => ({
					name,
					resource,
					method,
					accepts: acceptSummary,
					description: description.split('\n')[0],
				})),
			);
		},
	);
}

function registerRefreshBazaar(server, refresh) {
	server.registerTool(
		'refresh_bazaar',
		{
			title: 'Refresh Bazaar discovery',
			description:
				'Re-queries the x402 Bazaar discovery endpoint and re-registers dynamic tools. Use when new paid services have been added since the bridge started. Free (no payment), but mutates the bridge tool list and results vary with the live Bazaar.',
			// Mutates the registered tool set from a live external feed: not
			// read-only, not idempotent, open-world — but never destructive.
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: true,
			},
			inputSchema: {},
		},
		async () => {
			const { added, removed, total } = await refresh();
			return asTextContent({ added, removed, total });
		},
	);
}

function buildDynamicHandler(deps, spec) {
	return async (args) => {
		try {
			const { body, params, pathParams, headers } = args || {};
			let url = spec.resource;
			if (pathParams && typeof pathParams === 'object') {
				// Replace `{name}` placeholders with the supplied path params.
				for (const [key, value] of Object.entries(pathParams)) {
					url = url.replace(`{${key}}`, encodeURIComponent(String(value)));
				}
			}
			const result = await callPaidEndpoint(deps, {
				url,
				method: spec.method,
				body,
				params,
				headers,
			});
			return asTextContent(result);
		} catch (err) {
			return asErrorContent(`${spec.name} failed: ${err?.message || err}`);
		}
	};
}

function buildDynamicInputSchema() {
	return {
		body: z
			.any()
			.optional()
			.describe(
				'Request body (object). Required when the bazaar input schema declares body fields. JSON-encoded automatically.',
			),
		params: z.record(z.any()).optional().describe('Query string parameters as an object.'),
		pathParams: z
			.record(z.union([z.string(), z.number()]))
			.optional()
			.describe('Values for `{name}` placeholders in the resource URL.'),
		headers: z.record(z.string()).optional().describe('Additional request headers.'),
	};
}

function registerDynamic(server, deps, spec) {
	const inputSchema = buildDynamicInputSchema();
	const registered = server.registerTool(
		spec.name,
		{
			title: spec.name,
			description: spec.description,
			// Dynamic Bazaar tools route through call_paid_endpoint: every call
			// spends USDC against an external service.
			annotations: PAYMENT_TOOL_ANNOTATIONS,
			inputSchema,
		},
		buildDynamicHandler(deps, spec),
	);
	return registered;
}

async function main() {
	const deps = await buildBuyerAxios();
	log('signers ready, building MCP server');

	const server = new McpServer({ name: BRIDGE_NAME, version: BRIDGE_VERSION });

	let cachedSpecs = [];
	const dynamicRegs = new Map();

	const refresh = async () => {
		const next = await discoverBazaarTools();
		const nextByName = new Map(next.map((s) => [s.name, s]));
		const prevByName = new Map(cachedSpecs.map((s) => [s.name, s]));

		let removed = 0;
		for (const [name, reg] of dynamicRegs.entries()) {
			if (!nextByName.has(name)) {
				if (typeof reg.remove === 'function') {
					reg.remove();
				} else if (typeof reg.disable === 'function') {
					reg.disable();
				}
				dynamicRegs.delete(name);
				removed++;
			}
		}

		let added = 0;
		for (const spec of next) {
			if (prevByName.has(spec.name)) continue;
			try {
				const reg = registerDynamic(server, deps, spec);
				dynamicRegs.set(spec.name, reg);
				added++;
			} catch (err) {
				log(`failed to register dynamic tool ${spec.name}:`, err?.message || err);
			}
		}

		cachedSpecs = next;
		log(`bazaar discovery: ${next.length} tools (added=${added}, removed=${removed})`);
		return { added, removed, total: next.length };
	};

	registerCallPaidEndpoint(server, deps);
	registerListBazaarTools(server, () => cachedSpecs);
	registerRefreshBazaar(server, refresh);

	try {
		await refresh();
	} catch (err) {
		log(
			'bazaar discovery failed at startup (continuing without dynamic tools):',
			err?.message || err,
		);
	}

	const transport = new StdioServerTransport();
	await server.connect(transport);
	log('connected via stdio');
}

main().catch((err) => {
	log('fatal:', err?.stack || err?.message || err);
	process.exit(1);
});
