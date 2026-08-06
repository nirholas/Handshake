// x402 Bazaar discovery client.
//
// Talks directly to facilitator `/discovery/resources` endpoints (HTTP GET).
// No SDK dependency — the wire format is stable enough to consume with fetch.
// We normalize items returned by both spec versions:
//   - v1 facilitators (PayAI): flat shape, network strings like "base"/"solana"
//   - v2 facilitators (CDP):   `extensions.bazaar.info`, CAIP-2 networks
//
// Search is implemented client-side as a text query over normalized items
// because none of the public facilitators expose a server-side search route.
// Multi-facilitator merging dedupes HTTP by `resource` and MCP by
// `(resource, toolName)` per spec.

const DEFAULT_FACILITATORS = (() => {
	const list = [];
	const base = process.env.X402_FACILITATOR_URL_BASE || 'https://facilitator.payai.network';
	const cdp = process.env.X402_CDP_FACILITATOR_URL || 'https://api.cdp.coinbase.com/platform/v2/x402';
	const sol = process.env.X402_FACILITATOR_URL_SOLANA;
	list.push(base);
	if (cdp && cdp !== base) list.push(cdp);
	if (sol && !list.includes(sol)) list.push(sol);
	return list;
})();

const COMMON_ASSETS = {
	// Base USDC
	'0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { symbol: 'USDC', decimals: 6 },
	// Solana USDC
	epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwytdt1v: { symbol: 'USDC', decimals: 6 },
	// Optimism USDC
	'0x0b2c639c533813f4aa9d7837caf62653d097ff85': { symbol: 'USDC', decimals: 6 },
	// Arbitrum USDC
	'0xaf88d065e77c8cc2239327c5edb3a432268e5831': { symbol: 'USDC', decimals: 6 },
	// Polygon USDC
	'0x3c499c542cef5e3811e1192ce70d8cc03d5c3359': { symbol: 'USDC', decimals: 6 },
};

function normalizeNetwork(net) {
	if (!net) return '';
	const n = String(net).toLowerCase();
	if (n === 'base') return 'eip155:8453';
	if (n === 'base-sepolia') return 'eip155:84532';
	if (n === 'arbitrum') return 'eip155:42161';
	if (n === 'optimism') return 'eip155:10';
	if (n === 'polygon') return 'eip155:137';
	if (n === 'solana') return 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
	if (n === 'solana-devnet') return 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
	return n;
}

function networkFamily(net) {
	const n = normalizeNetwork(net);
	if (n.startsWith('eip155:')) return 'evm';
	if (n.startsWith('solana')) return 'solana';
	return 'unknown';
}

function assetInfo(asset) {
	if (!asset) return { symbol: '', decimals: 6 };
	const meta = COMMON_ASSETS[String(asset).toLowerCase()];
	return meta || { symbol: '', decimals: 6 };
}

function pickAmount(accept) {
	// v2 spec uses `amount`; v1 PayAI uses `maxAmountRequired`.
	return accept?.amount ?? accept?.maxAmountRequired ?? '0';
}

// Convert atomic units to a human string. We don't trust the decimals when
// unknown — fall back to USDC 6dp which is the common case in practice.
function formatPrice(atomic, asset) {
	const { symbol, decimals } = assetInfo(asset);
	const n = Number(atomic) / 10 ** decimals;
	let str;
	if (n === 0) str = '0';
	else if (n < 0.01) str = n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
	else if (n < 1) str = n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
	else str = n.toFixed(2);
	return symbol ? `${str} ${symbol}` : str;
}

// Normalize one raw item into a stable shape. We keep the original under
// `raw` so callers needing facilitator-specific fields still have them.
export function normalizeItem(item, facilitator) {
	if (!item || typeof item !== 'object') return null;
	const accepts = Array.isArray(item.accepts) ? item.accepts : [];
	const primary = accepts[0] || {};

	const bazaarExt = item?.extensions?.bazaar || null;
	const bazaarInfo = bazaarExt?.info || item?.inputSchema || null;
	const input = bazaarInfo?.input || bazaarInfo || null;
	const isMcp = input?.type === 'mcp';
	const toolName = isMcp ? input?.toolName || '' : '';

	const resourceUrl =
		typeof item.resource === 'string'
			? item.resource
			: item.resource?.url || primary?.resource || '';

	const resourceMeta = typeof item.resource === 'object' ? item.resource : {};
	const serviceMeta = bazaarInfo?.service || {};
	const description =
		item.description || resourceMeta.description || serviceMeta.description || bazaarExt?.description || primary?.description || '';
	const serviceName =
		resourceMeta.serviceName ||
		resourceMeta.name ||
		serviceMeta.name ||
		bazaarExt?.name ||
		'';
	const iconUrl =
		resourceMeta.iconUrl ||
		resourceMeta.icon ||
		serviceMeta.icon ||
		serviceMeta.iconUrl ||
		bazaarExt?.icon ||
		bazaarExt?.iconUrl ||
		'';
	const rawTags =
		(Array.isArray(resourceMeta.tags) && resourceMeta.tags) ||
		(Array.isArray(item.tags) && item.tags) ||
		(Array.isArray(serviceMeta.tags) && serviceMeta.tags) ||
		(Array.isArray(bazaarExt?.tags) && bazaarExt.tags) ||
		[];
	const category = bazaarExt?.category || serviceMeta.category || resourceMeta.category;
	const tags = category && !rawTags.includes(category) ? [category, ...rawTags] : rawTags;

	const normalizedAccepts = accepts.map((a) => {
		const net = normalizeNetwork(a.network);
		const amount = pickAmount(a);
		return {
			...a,
			network: net,
			networkRaw: a.network,
			amount,
			amountAtomic: amount,
			family: networkFamily(a.network),
			assetInfo: assetInfo(a.asset),
			priceLabel: formatPrice(amount, a.asset),
		};
	});

	const minAtomic = normalizedAccepts.reduce((min, a) => {
		const n = Number(a.amountAtomic);
		return Number.isFinite(n) && (min == null || n < min) ? n : min;
	}, null);
	const minAccept = normalizedAccepts.find((a) => Number(a.amountAtomic) === minAtomic) || normalizedAccepts[0];

	const extensionsList = item.extensions ? Object.keys(item.extensions) : [];
	const method =
		item.method ||
		input?.method ||
		primary?.method ||
		(isMcp ? 'MCP' : '');

	return {
		type: item.type || (isMcp ? 'mcp' : 'http'),
		resource: resourceUrl,
		toolName,
		uniqueKey: isMcp ? `${resourceUrl}#${toolName}` : resourceUrl,
		serviceName,
		description,
		iconUrl,
		tags,
		method,
		accepts: normalizedAccepts,
		minPriceAtomic: minAtomic,
		minPriceLabel: minAccept ? minAccept.priceLabel : '',
		families: [...new Set(normalizedAccepts.map((a) => a.family))],
		networks: [...new Set(normalizedAccepts.map((a) => a.network))],
		extensions: extensionsList,
		input,
		output: bazaarInfo?.output || null,
		lastUpdated: item.lastUpdated || null,
		facilitator,
		raw: item,
	};
}

async function fetchJson(url, { timeoutMs = 15000 } = {}) {
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const r = await fetch(url, {
			method: 'GET',
			headers: { accept: 'application/json' },
			signal: ctrl.signal,
		});
		if (!r.ok) {
			const body = await r.text().catch(() => '');
			throw Object.assign(new Error(`facilitator ${r.status} ${r.statusText}: ${body.slice(0, 200)}`), {
				status: r.status,
				facilitator: url,
			});
		}
		return await r.json();
	} finally {
		clearTimeout(t);
	}
}

// Page through a facilitator's /discovery/resources. We stop at `maxItems`
// (default 500) to keep responses bounded — operators that need everything can
// raise the cap explicitly.
async function listOneFacilitator(facilitatorUrl, { type, limit, maxItems }) {
	const items = [];
	const pageSize = Math.min(200, Math.max(1, limit || 200));
	let offset = 0;
	let total = null;
	while (items.length < maxItems) {
		const u = new URL(facilitatorUrl.replace(/\/$/, '') + '/discovery/resources');
		if (type) u.searchParams.set('type', type);
		u.searchParams.set('limit', String(pageSize));
		u.searchParams.set('offset', String(offset));
		const body = await fetchJson(u.toString());
		const got = Array.isArray(body?.items) ? body.items : Array.isArray(body) ? body : [];
		if (got.length === 0) break;
		for (const it of got) items.push(it);
		if (body?.pagination?.total != null) total = body.pagination.total;
		offset += got.length;
		// Stop if facilitator returned fewer than requested (last page).
		if (got.length < pageSize) break;
		// Or if we've reached the reported total.
		if (total != null && offset >= total) break;
	}
	return items;
}

// Bazaar client. Stateless aside from the configured facilitator list.
export class Bazaar {
	constructor({ facilitators } = {}) {
		const urls = Array.isArray(facilitators) && facilitators.length ? facilitators : DEFAULT_FACILITATORS;
		this.facilitators = urls.filter(Boolean);
	}

	async list({ type = 'http', limit = 200, maxItems = 500 } = {}) {
		const settled = await Promise.allSettled(
			this.facilitators.map(async (f) => {
				const items = await listOneFacilitator(f, { type, limit, maxItems });
				const normalized = items.map((it) => normalizeItem(it, f)).filter(Boolean);
				// Some facilitators (PayAI) ignore the `type` query param and return
				// HTTP items regardless. Apply the filter ourselves so callers get a
				// consistent catalog.
				return normalized.filter((it) => it.type === type);
			}),
		);
		const items = [];
		const sources = [];
		const errors = [];
		const seen = new Map(); // uniqueKey → index in items
		for (let i = 0; i < settled.length; i++) {
			const f = this.facilitators[i];
			const r = settled[i];
			if (r.status !== 'fulfilled') {
				errors.push({ facilitator: f, error: String(r.reason?.message || r.reason || 'error') });
				sources.push({ facilitator: f, count: 0, ok: false });
				continue;
			}
			let added = 0;
			for (const it of r.value) {
				if (!it.uniqueKey) continue;
				const existing = seen.get(it.uniqueKey);
				if (existing == null) {
					seen.set(it.uniqueKey, items.length);
					items.push(it);
					added++;
				} else {
					// Prefer the entry with richer bazaar metadata when deduping.
					const prev = items[existing];
					if (!prev.description && it.description) items[existing] = it;
				}
			}
			sources.push({ facilitator: f, count: added, ok: true });
		}
		return { items, sources, errors };
	}

	async search({ query, type = 'http', maxItems = 500 } = {}) {
		const q = String(query || '').trim().toLowerCase();
		const { items, sources, errors } = await this.list({ type, maxItems });
		if (!q) return { resources: items, sources, errors };
		const terms = q.split(/\s+/g).filter(Boolean);
		const scored = items
			.map((it) => ({ it, score: scoreItem(it, terms) }))
			.filter((x) => x.score > 0)
			.sort((a, b) => b.score - a.score)
			.map((x) => x.it);
		return { resources: scored, sources, errors };
	}

	// Look up a single resource by URL (and optional MCP tool name).
	async get(resourceUrl, { toolName } = {}) {
		const key = toolName ? `${resourceUrl}#${toolName}` : resourceUrl;
		const type = toolName ? 'mcp' : 'http';
		const { items } = await this.list({ type, maxItems: 1000 });
		return items.find((it) => it.uniqueKey === key) || null;
	}
}

function scoreItem(it, terms) {
	const hay = [it.serviceName, it.description, it.resource, it.toolName, ...(it.tags || [])]
		.filter(Boolean)
		.join(' ')
		.toLowerCase();
	let score = 0;
	for (const t of terms) {
		if (!hay.includes(t)) return 0;
		// Title/tag hits are worth more than generic hits.
		if (it.serviceName && it.serviceName.toLowerCase().includes(t)) score += 4;
		if (it.tags?.some((tag) => tag.toLowerCase().includes(t))) score += 3;
		if (it.toolName && it.toolName.toLowerCase().includes(t)) score += 3;
		if (it.description && it.description.toLowerCase().includes(t)) score += 2;
		score += 1;
	}
	return score;
}

// ---- Filtering helpers ----

// Parse an atomic-unit price cap (a non-negative integer in the asset's smallest
// unit, e.g. 10000 = 0.01 USDC). Returns null when the value is not one, so an
// HTTP boundary can answer 400 instead of letting BigInt's raw SyntaxError blow
// up the request: a user-supplied `maxPrice=0.01` used to 500 /api/bazaar/list,
// /api/bazaar/search and /api/agenc/x402-services, and to silently empty the
// whole services lane of /api/agora/board.
export function parseAtomicAmount(value) {
	const s = String(value ?? '').trim();
	if (!/^\d+$/.test(s)) return null;
	return BigInt(s);
}

export function filterByMaxPrice(items, atomicMax, asset = null) {
	const max = parseAtomicAmount(atomicMax);
	if (max === null) {
		throw new TypeError(`maxPrice must be an atomic (integer) amount, got "${atomicMax}"`);
	}
	// `a.asset` is the raw on-chain identifier (a contract address on EVM, a mint
	// on Solana). Every caller's docs tell users to pass a SYMBOL ("USDC"), which
	// would have matched nothing, so accept either form.
	const wantAsset = asset ? String(asset).toLowerCase() : null;
	return items.filter((it) =>
		it.accepts.some((a) => {
			if (wantAsset) {
				const raw = String(a.asset || '').toLowerCase();
				const symbol = assetInfo(a.asset).symbol.toLowerCase();
				if (raw !== wantAsset && symbol !== wantAsset) return false;
			}
			try {
				return BigInt(a.amountAtomic || 0) <= max;
			} catch {
				return false;
			}
		}),
	);
}

export function filterByNetwork(items, pattern) {
	if (!pattern) return items;
	const re = patternToRegex(pattern);
	return items.filter((it) => it.networks.some((n) => re.test(n)));
}

function patternToRegex(pattern) {
	if (pattern instanceof RegExp) return pattern;
	// support wildcards like "eip155:*" or "solana:*"
	const escaped = String(pattern)
		.replace(/[.+^${}()|[\]\\]/g, '\\$&')
		.replace(/\*/g, '.*');
	return new RegExp(`^${escaped}$`, 'i');
}

export function filterByExtension(items, extensionName) {
	if (!extensionName) return items;
	return items.filter((it) => it.extensions.includes(extensionName));
}

export function filterByTag(items, tag) {
	if (!tag) return items;
	const t = String(tag).toLowerCase();
	return items.filter((it) => (it.tags || []).some((x) => String(x).toLowerCase() === t));
}

export function groupBy(items, key) {
	const out = new Map();
	for (const it of items) {
		const k = typeof key === 'function' ? key(it) : it[key] ?? '';
		if (!out.has(k)) out.set(k, []);
		out.get(k).push(it);
	}
	return out;
}

export function sortByPriceAsc(items) {
	return [...items].sort((a, b) => {
		const av = a.minPriceAtomic ?? Number.MAX_SAFE_INTEGER;
		const bv = b.minPriceAtomic ?? Number.MAX_SAFE_INTEGER;
		return av - bv;
	});
}

export function defaultFacilitators() {
	return [...DEFAULT_FACILITATORS];
}
