// POST /api/x402/mcp-tool-catalog
//
// MCP Tool Discovery — $0.001 USDC per call on Solana or Base.
//
// Pays to discover newly-registered MCP tools on the three.ws MCP server since
// the last probe. The server's live tool catalog (api/_mcp/catalog.js →
// TOOL_CATALOG, the exact list /api/mcp returns from tools/list) is fingerprinted
// and diffed against a durable registry (mcp_tool_registry). The call returns the
// tools that are NEW since the caller last probed, the tools whose
// shape/price/description CHANGED, and the tools that DISAPPEARED — so an agent
// can feature-flag a new capability the moment it ships without polling
// tools/list and diffing it by hand.
//
// Body: { mode?: "discover" | "sync" | "list" }   (default "discover")
//   discover / sync — diff the live catalog against the durable registry, persist
//              the new state, return { new_tools, changed_tools, removed_tools, ... }.
//              "sync" is an alias for "discover" used by the autonomous loop.
//   list     — return the live catalog snapshot only (no diff, no persistence).
//
// Response: { ok, mode, total_tools, new_tools[], changed_tools[],
//             removed_tools[], priced_tools, free_tools, ts }
//
// Real catalog, real DB diff — no mock path. The autonomous loop pays this every
// 2 hours; new tools land in mcp_tool_registry for agent feature flagging.

import { createHash } from 'node:crypto';
import { readBody } from '../_lib/http.js';

import { paidEndpoint } from '../_lib/x402-paid-endpoint.js';
import { buildBazaarSchema } from '../_lib/x402-spec.js';
import { installAccessControl } from '../_lib/x402/access-control.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';
import { priceFor as x402PriceFor } from '../_lib/x402-prices.js';
import { sql } from '../_lib/db.js';
import { TOOL_CATALOG } from '../_mcp/catalog.js';
import { priceFor as toolPriceFor } from '../_lib/pump-pricing.js';

const ROUTE = '/api/x402/mcp-tool-catalog';

const DESCRIPTION =
	'three.ws MCP Tool Discovery — pay $0.001 USDC to discover MCP tools that ' +
	'were registered (or whose price/shape changed, or that were removed) on the ' +
	'three.ws MCP server since you last probed. Returns the diff against a durable ' +
	'tool registry so agents can feature-flag new capabilities the moment they ship ' +
	'instead of re-fetching and diffing tools/list themselves.';

const INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	properties: {
		mode: {
			type: 'string',
			enum: ['discover', 'sync', 'list'],
			description:
				'"discover" / "sync" (default "discover") diffs the live catalog against the ' +
				'durable registry and persists the new state. "list" returns the live catalog ' +
				'snapshot only (no diff, no persistence). "sync" is an alias for "discover".',
			default: 'discover',
		},
	},
	additionalProperties: false,
};

const TOOL_SUMMARY_SCHEMA = {
	type: 'object',
	properties: {
		name: { type: 'string' },
		description: { type: 'string' },
		priced: { type: 'boolean' },
		price_usdc: { type: ['number', 'null'] },
		input_fields: { type: 'integer' },
	},
};

const OUTPUT_EXAMPLE = {
	ok: true,
	mode: 'discover',
	total_tools: 24,
	priced_tools: 11,
	free_tools: 13,
	new_tools: [
		{ name: 'segment_model', description: 'Split a mesh into named parts', priced: true, price_usdc: 0.02, input_fields: 2 },
	],
	changed_tools: [
		{ name: 'render_avatar', change: 'price', price_usdc: 0.005, prev_price_usdc: 0.003 },
	],
	removed_tools: [],
	ts: '2026-06-27T10:00:00.000Z',
};

const OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['ok', 'mode', 'total_tools', 'new_tools', 'ts'],
	properties: {
		ok: { type: 'boolean' },
		mode: { type: 'string', enum: ['discover', 'list'] },
		total_tools: { type: 'integer' },
		priced_tools: { type: 'integer' },
		free_tools: { type: 'integer' },
		new_tools: { type: 'array', items: TOOL_SUMMARY_SCHEMA },
		changed_tools: { type: 'array', items: { type: 'object' } },
		removed_tools: { type: 'array', items: { type: 'string' } },
		tools: { type: 'array', items: TOOL_SUMMARY_SCHEMA },
		ts: { type: 'string', format: 'date-time' },
	},
};

const BAZAAR = {
	description: DESCRIPTION,
	useCases: ['mcp tool discovery', 'agent feature flagging', 'capability registry'],
	input: { type: 'json', example: { mode: 'discover' }, schema: INPUT_SCHEMA },
	output: { type: 'json', example: OUTPUT_EXAMPLE },
	schema: buildBazaarSchema({
		method: 'POST',
		bodySchema: INPUT_SCHEMA,
		outputSchema: OUTPUT_SCHEMA,
	}),
};

let _schemaReady = false;
async function ensureSchema() {
	if (_schemaReady) return;
	await sql`
		CREATE TABLE IF NOT EXISTS mcp_tool_registry (
			tool_name     text PRIMARY KEY,
			description   text,
			priced        boolean NOT NULL DEFAULT false,
			price_usdc    numeric(12,6),
			input_fields  int NOT NULL DEFAULT 0,
			fingerprint   text NOT NULL,
			active        boolean NOT NULL DEFAULT true,
			first_seen_at timestamptz NOT NULL DEFAULT now(),
			last_seen_at  timestamptz NOT NULL DEFAULT now(),
			run_id        uuid
		)
	`;
	_schemaReady = true;
}

// Count the declared input properties of a tool's JSON Schema (0 if none).
function inputFieldCount(inputSchema) {
	const props = inputSchema && typeof inputSchema === 'object' ? inputSchema.properties : null;
	return props && typeof props === 'object' ? Object.keys(props).length : 0;
}

// Project the live catalog into the comparable shape we persist + diff on. The
// price comes from the same TOOL_PRICING table the MCP server uses to annotate
// tools/list, so a price change here is the price change a paying client sees.
function projectCatalog() {
	return TOOL_CATALOG.map((t) => {
		const price = toolPriceFor(t.name);
		const priced = !!price;
		const priceUsdc = priced && typeof price.amount_usdc === 'number' ? price.amount_usdc : null;
		const description = typeof t.description === 'string' ? t.description : '';
		const inputFields = inputFieldCount(t.inputSchema);
		// Stable fingerprint: any change to the contract a caller depends on
		// (description, paid/free, price, input shape) flips it. Sorted input
		// keys keep it order-independent across server restarts.
		const inputKeys = t.inputSchema && t.inputSchema.properties
			? Object.keys(t.inputSchema.properties).sort().join(',')
			: '';
		const fingerprint = createHash('sha256')
			.update(`${t.name}\n${description}\n${priced ? '1' : '0'}\n${priceUsdc ?? ''}\n${inputKeys}`)
			.digest('hex')
			.slice(0, 32);
		return { name: t.name, description, priced, price_usdc: priceUsdc, input_fields: inputFields, fingerprint };
	});
}

function summary(t) {
	return {
		name: t.name,
		description: t.description.length > 200 ? t.description.slice(0, 200) + '…' : t.description,
		priced: t.priced,
		price_usdc: t.price_usdc,
		input_fields: t.input_fields,
	};
}

export default paidEndpoint({
	route: ROUTE,
	method: 'POST',
	priceAtomics: x402PriceFor('mcp-tool-catalog', '1000'), // $0.001 USDC
	networks: ['solana', 'base'],
	description: DESCRIPTION,
	bazaar: BAZAAR,
	service: withService({
		serviceName: 'three.ws MCP Tool Discovery',
		tags: ['mcp', 'discovery', 'tools', 'catalog', 'feature-flag', 'agent'],
	}),
	// Same internal / subscription / OAuth bypass every other paid x402 route
	// carries, so first-party callers read the catalog without a payment leg.
	accessControl: installAccessControl({ requiredScope: 'x402:bypass' }),

	async handler({ req }) {
		let mode = 'discover';
		try {
			const chunks = [await readBody(req, 1_000_000)];
			const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
			if (body.mode === 'list') mode = 'list';
			// 'sync' is the autonomous loop alias for 'discover' (catalog diff + persist)
			// else: any unrecognised value also defaults to 'discover'
		} catch { /* default mode */ }

		const current = projectCatalog();
		const priced = current.filter((t) => t.priced).length;
		const ts = new Date().toISOString();

		if (mode === 'list') {
			return {
				ok: true,
				mode,
				total_tools: current.length,
				priced_tools: priced,
				free_tools: current.length - priced,
				new_tools: [],
				changed_tools: [],
				removed_tools: [],
				tools: current.map(summary),
				ts,
			};
		}

		await ensureSchema();

		// Snapshot the durable registry BEFORE writing so the diff reflects what
		// changed since the previous probe.
		const prevRows = await sql`SELECT tool_name, fingerprint, price_usdc, active FROM mcp_tool_registry`;
		const prev = new Map(prevRows.map((r) => [r.tool_name, r]));
		const currentNames = new Set(current.map((t) => t.name));

		const newTools = [];
		const changedTools = [];
		for (const t of current) {
			const before = prev.get(t.name);
			if (!before) {
				newTools.push(summary(t));
			} else if (before.fingerprint !== t.fingerprint) {
				const prevPrice = before.price_usdc != null ? Number(before.price_usdc) : null;
				const change = !before.active
					? 'reactivated'
					: prevPrice !== t.price_usdc
						? 'price'
						: 'shape';
				changedTools.push({
					name: t.name,
					change,
					price_usdc: t.price_usdc,
					prev_price_usdc: prevPrice,
					priced: t.priced,
				});
			}
		}

		// Tools present in the registry but gone from the live catalog: mark them
		// inactive (a removed capability is a feature-flag signal too).
		const removedTools = prevRows
			.filter((r) => r.active && !currentNames.has(r.tool_name))
			.map((r) => r.tool_name);

		// Persist the new catalog state. Upsert every live tool (refresh metadata +
		// last_seen, preserve first_seen), then deactivate the removed ones.
		for (const t of current) {
			await sql`
				INSERT INTO mcp_tool_registry
					(tool_name, description, priced, price_usdc, input_fields,
					 fingerprint, active, first_seen_at, last_seen_at)
				VALUES
					(${t.name}, ${t.description}, ${t.priced}, ${t.price_usdc},
					 ${t.input_fields}, ${t.fingerprint}, true, ${ts}, ${ts})
				ON CONFLICT (tool_name) DO UPDATE SET
					description  = EXCLUDED.description,
					priced       = EXCLUDED.priced,
					price_usdc   = EXCLUDED.price_usdc,
					input_fields = EXCLUDED.input_fields,
					fingerprint  = EXCLUDED.fingerprint,
					active       = true,
					last_seen_at = EXCLUDED.last_seen_at
			`;
		}
		if (removedTools.length > 0) {
			await sql`
				UPDATE mcp_tool_registry
				SET active = false, last_seen_at = ${ts}
				WHERE tool_name = ANY(${removedTools})
			`;
		}

		return {
			ok: true,
			mode,
			total_tools: current.length,
			priced_tools: priced,
			free_tools: current.length - priced,
			new_tools: newTools,
			changed_tools: changedTools,
			removed_tools: removedTools,
			ts,
		};
	},
});
