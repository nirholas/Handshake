// Queries the Coinbase x402 Bazaar (and any other configured catalog) for
// discoverable resources and returns a normalized list of MCP tool specs.
//
// The Bazaar `/discovery/resources` endpoint returns items shaped roughly:
//   {
//     resource: "https://...",
//     type: "http" | "mcp",
//     description: "...",
//     accepts: [{ scheme, network, amount, asset, payTo, extra, maxTimeoutSeconds }, ...],
//     extensions: { bazaar: { info: { input: {...}, output: {...} }, schema: {...} } },
//     quality: { l30DaysTotalCalls, ... },
//   }
//
// We use `extensions.bazaar.info.input` to know HOW to call the resource
// (HTTP method, body/queryParams shape) and `extensions.bazaar.schema` to
// surface a concrete JSON Schema for the tool's input parameters in the
// tool description.
//
// Tools whose accepts entries are ALL above the configured spending cap are
// filtered out at discovery time so the LLM doesn't see tools it can't afford.

import axios from 'axios';

import { assertPayableUrl, maxPriceAtomic } from './url-guard.js';

const DEFAULT_LIMIT = 20;
const DEFAULT_BAZAAR_URL = 'https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources';

function bazaarUrl() {
	const override = process.env.MCP_BRIDGE_BAZAAR_URL;
	return override && override.trim() ? override.trim() : DEFAULT_BAZAAR_URL;
}

function discoverLimit() {
	const raw = process.env.MCP_BRIDGE_DISCOVER_LIMIT;
	if (!raw) return DEFAULT_LIMIT;
	const v = Number(raw);
	if (!Number.isFinite(v) || v < 0) {
		throw new Error('MCP_BRIDGE_DISCOVER_LIMIT must be a non-negative number');
	}
	return Math.floor(v);
}

// Derive a stable MCP tool name from a Bazaar item.
//
// MCP tool names must be unique and conventionally are snake_case identifiers.
// Strategy: prefer the URL's last path segment (operation name), then fall
// through to the description with the publisher prefix stripped, then to a
// generic 'tool'. Sanitize to [a-z0-9_], cap length. Caller disambiguates
// collisions with a numeric suffix.
const NAME_PREFIX = 'paid_';

function sanitize(s) {
	return String(s || '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '')
		.slice(0, 48);
}

export function deriveToolName(item) {
	let candidate = '';
	try {
		const path = new URL(item.resource).pathname;
		const segs = path.split('/').filter(Boolean);
		// Skip generic segments like "api", "tools", "v1", "v2", numeric IDs.
		for (let i = segs.length - 1; i >= 0; i--) {
			const seg = segs[i];
			if (/^(api|tools|v\d+|public|x402|paid)$/i.test(seg)) continue;
			candidate = seg;
			break;
		}
	} catch {
		// resource wasn't a valid URL — fall through to description
	}

	if (!candidate) {
		const desc = String(item.description || '').trim();
		// Take the segment AFTER a publisher prefix like "Provider · operation".
		const parts = desc.split(/[—·:|]/).map((s) => s.trim()).filter(Boolean);
		candidate = parts[1] || parts[0] || '';
	}

	const base = sanitize(candidate) || 'tool';
	return `${NAME_PREFIX}${base}`;
}

function pickInputJsonSchema(item) {
	const schema = item?.extensions?.bazaar?.schema;
	if (schema && typeof schema === 'object' && schema.properties?.input) {
		return schema.properties.input;
	}
	// Some entries publish inputSchema at the top level (legacy v1 shape).
	const legacy = item?.extensions?.bazaar?.inputSchema || item?.inputSchema;
	return legacy && typeof legacy === 'object' ? legacy : undefined;
}

function summarizeAccepts(accepts) {
	return accepts
		.map((a) => `${a.scheme}@${a.network} ${a.amount} ${a.asset}`)
		.join(' | ');
}

function affordable(accepts) {
	// Same effective cap the spending-cap hook enforces (including its default):
	// a tool the hook would always refuse must never be registered.
	const cap = maxPriceAtomic();
	return accepts.some((a) => {
		try {
			return BigInt(a.amount) <= cap;
		} catch {
			return false;
		}
	});
}

export async function fetchBazaarResources({ url = bazaarUrl(), limit = discoverLimit() } = {}) {
	if (limit === 0) return [];
	// The bazaar response drives payable-tool registration, so a malicious
	// MCP_BRIDGE_BAZAAR_URL override is an SSRF + supply-chain vector. Validate
	// scheme + host before fetching, same as any payable URL.
	const safeUrl = await assertPayableUrl(url);
	const res = await axios.get(safeUrl, {
		params: { limit },
		timeout: 15_000,
		validateStatus: (s) => s >= 200 && s < 300,
		maxRedirects: 0,
	});
	const items = Array.isArray(res.data?.items) ? res.data.items : [];
	return items;
}

export function buildToolSpec(item) {
	const accepts = Array.isArray(item.accepts) ? item.accepts : [];
	if (accepts.length === 0) return null;
	if (!affordable(accepts)) return null;

	const info = item?.extensions?.bazaar?.info;
	const input = info?.input || {};
	const method = (input.method || 'GET').toUpperCase();
	const type = info?.type || item.type || 'http';
	const inputJsonSchema = pickInputJsonSchema(item);

	const acceptSummary = summarizeAccepts(accepts);
	const descriptionLines = [
		item.description?.trim() || `Paid endpoint at ${item.resource}`,
		'',
		`Auto-paid via x402 (${acceptSummary}).`,
		`Method: ${method}. Resource: ${item.resource}`,
	];
	if (inputJsonSchema) {
		descriptionLines.push('', 'Input JSON Schema:', JSON.stringify(inputJsonSchema));
	}
	if (info?.output?.example) {
		descriptionLines.push('', 'Output example:', JSON.stringify(info.output.example).slice(0, 1500));
	}

	return {
		name: deriveToolName(item),
		description: descriptionLines.join('\n'),
		resource: item.resource,
		method,
		type,
		bodyType: input.bodyType || 'json',
		inputJsonSchema,
		acceptSummary,
	};
}

// Pure: bazaar items → deduped tool specs. Name collisions get a numeric
// suffix (paid_x, paid_x_1, …) so every registered tool name stays unique.
export function specsFromItems(items) {
	const specs = [];
	const seen = new Set();
	for (const item of items) {
		try {
			const spec = buildToolSpec(item);
			if (!spec) continue;
			let name = spec.name;
			let i = 1;
			while (seen.has(name)) {
				name = `${spec.name}_${i++}`;
			}
			seen.add(name);
			specs.push({ ...spec, name });
		} catch {
			// Malformed entry — skip so one bad item doesn't take the whole bridge down.
		}
	}
	return specs;
}

export async function discoverBazaarTools(opts = {}) {
	return specsFromItems(await fetchBazaarResources(opts));
}
