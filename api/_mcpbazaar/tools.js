// x402 Bazaar MCP — discovery tools over the live x402 facilitator network.
//
// Every tool hits real facilitators (no cache of fake data): search and browse
// the merged catalog of paid agent services, and pull the full payment + input
// schema for any one service. The result is everything a client needs to decide
// to pay and exactly how — price, network, recipient, and a ready pay link.
import { limits } from '../_lib/rate-limit.js';
import { env } from '../_lib/env.js';
import {
	Bazaar,
	filterByNetwork,
	filterByMaxPrice,
} from '../_lib/x402/bazaar-client.js';

function rpcError(code, message, data) {
	const e = new Error(message);
	e.code = code;
	e.data = data;
	return e;
}

async function enforce(auth) {
	const rl = await limits.mcpBazaar(auth.userId || auth.rateKey || 'anon');
	if (!rl.success) {
		throw rpcError(-32000, 'rate_limited', {
			retry_after: Math.ceil((rl.reset - Date.now()) / 1000),
		});
	}
}

// USDC and most x402 stablecoins use 6 decimals — convert a human dollar cap to
// the atomic units filterByMaxPrice compares against.
function usdcToAtomic(usd) {
	return String(Math.round(Number(usd) * 1_000_000));
}

// Project a normalized bazaar item down to the fields a client actually needs,
// dropping the bulky `raw` facilitator payload.
function slim(it) {
	return {
		type: it.type,
		resource: it.resource,
		tool_name: it.toolName || undefined,
		name: it.serviceName || undefined,
		description: it.description || undefined,
		price: it.minPriceLabel || undefined,
		price_atomic: it.minPriceAtomic ?? undefined,
		networks: it.networks,
		tags: it.tags?.length ? it.tags : undefined,
		method: it.method || undefined,
		facilitator: it.facilitator,
	};
}

function applyFilters(resources, { network, max_price_usdc }) {
	let out = resources;
	if (network) out = filterByNetwork(out, network);
	if (max_price_usdc != null) out = filterByMaxPrice(out, usdcToAtomic(max_price_usdc));
	return out;
}

function payUrl(resource, toolName) {
	const u = new URL(`${env.APP_ORIGIN}/pay`);
	u.searchParams.set('resource', resource);
	if (toolName) u.searchParams.set('tool', toolName);
	return u.toString();
}

function formatList(items, { query } = {}) {
	if (!items.length) {
		return query
			? `No x402 services matched "${query}".`
			: 'No x402 services found on the configured facilitators.';
	}
	return items
		.map((s, i) => {
			const head = `${i + 1}. ${s.name || s.resource}${s.price ? ` — ${s.price}` : ''}`;
			const desc = s.description ? `\n   ${s.description}` : '';
			const net = s.networks?.length ? `\n   networks: ${s.networks.join(', ')}` : '';
			const res = `\n   ${s.tool_name ? `${s.resource} #${s.tool_name}` : s.resource}`;
			return head + desc + net + res;
		})
		.join('\n');
}

export const toolDefs = [
	{
		name: 'search_services',
		title: 'Search the x402 bazaar',
		description:
			'Ranked search across the live x402 facilitator network for paid agent services (APIs and MCP tools you can pay for in stablecoin). Returns matching services with price, networks, and resource URL. Use get_service for full payment + input details.',
		inputSchema: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'What you need, e.g. "weather", "image upscale", "onchain data".' },
				type: { type: 'string', enum: ['http', 'mcp'], default: 'http', description: 'http API or mcp tool.' },
				network: { type: 'string', description: 'Filter by CAIP-2 network, e.g. "eip155:8453" (Base) or "solana:*".' },
				max_price_usdc: { type: 'number', minimum: 0, description: 'Only services at or below this price (USDC).' },
				limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
			},
			required: ['query'],
			additionalProperties: false,
		},
		async handler(args, auth) {
			await enforce(auth);
			const type = args.type || 'http';
			const baz = new Bazaar({});
			const { resources, sources, errors } = await baz.search({ query: args.query, type });
			const filtered = applyFilters(resources, args).slice(0, args.limit || 20).map(slim);
			return {
				content: [{ type: 'text', text: formatList(filtered, { query: args.query }) }],
				structuredContent: {
					query: args.query,
					type,
					count: filtered.length,
					services: filtered,
					sources,
					errors,
				},
			};
		},
	},
	{
		name: 'browse_services',
		title: 'Browse the x402 bazaar',
		description:
			'List paid agent services from the live x402 facilitator network without a search query — useful for "what can I pay for?". Returns services with price, networks, and resource URL, cheapest filters applied.',
		inputSchema: {
			type: 'object',
			properties: {
				type: { type: 'string', enum: ['http', 'mcp'], default: 'http' },
				network: { type: 'string', description: 'Filter by CAIP-2 network, e.g. "eip155:8453".' },
				max_price_usdc: { type: 'number', minimum: 0 },
				limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
			},
			additionalProperties: false,
		},
		async handler(args, auth) {
			await enforce(auth);
			const type = args.type || 'http';
			const baz = new Bazaar({});
			const { items, sources, errors } = await baz.list({ type });
			const filtered = applyFilters(items, args).slice(0, args.limit || 30).map(slim);
			return {
				content: [{ type: 'text', text: formatList(filtered) }],
				structuredContent: { type, count: filtered.length, services: filtered, sources, errors },
			};
		},
	},
	{
		name: 'get_service',
		title: 'Get full details for one x402 service',
		description:
			'Resolve a single x402 service by its resource URL (and tool_name for MCP services). Returns the exact payment requirements (price, asset, network, recipient), the input/output schema, and a ready-to-use pay link on three.ws. This is what you read before paying.',
		inputSchema: {
			type: 'object',
			properties: {
				resource_url: { type: 'string', format: 'uri', description: 'The service resource URL.' },
				tool_name: { type: 'string', description: 'For MCP services, the tool name on that resource.' },
			},
			required: ['resource_url'],
			additionalProperties: false,
		},
		async handler(args, auth) {
			await enforce(auth);
			const baz = new Bazaar({});
			const item = await baz.get(args.resource_url, { toolName: args.tool_name });
			if (!item) {
				return {
					content: [
						{ type: 'text', text: `No x402 service found for ${args.resource_url}${args.tool_name ? ` #${args.tool_name}` : ''}.` },
					],
					isError: true,
				};
			}
			const accepts = item.accepts.map((a) => ({
				network: a.network,
				price: a.priceLabel,
				amount_atomic: a.amountAtomic,
				asset: a.asset,
				pay_to: a.payTo,
				scheme: a.scheme,
			}));
			const pay_link = payUrl(item.resource, item.toolName);
			const lines = [
				`${item.serviceName || item.resource}`,
				item.description ? item.description : '',
				`Price: ${item.minPriceLabel || 'see options'}`,
				`Payment options:`,
				...accepts.map((a) => `  • ${a.price} on ${a.network} → ${a.pay_to || '(recipient in challenge)'}`),
				``,
				`Pay & call via three.ws: ${pay_link}`,
			].filter((l) => l !== '');
			return {
				content: [{ type: 'text', text: lines.join('\n') }],
				structuredContent: {
					type: item.type,
					resource: item.resource,
					tool_name: item.toolName || undefined,
					name: item.serviceName || undefined,
					description: item.description || undefined,
					accepts,
					input_schema: item.input || undefined,
					output_schema: item.output || undefined,
					tags: item.tags?.length ? item.tags : undefined,
					pay_link,
				},
			};
		},
	},
];
