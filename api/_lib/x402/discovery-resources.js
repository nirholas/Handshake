// Facilitator-standard discovery catalog — the v1 wire format behind
// GET /api/x402-facilitator/discovery/resources.
//
// x402scan (and every crawler built on the x402 npm package) lists a
// facilitator's resources via useFacilitator(config).list(), which fetches
// `${facilitatorUrl}/discovery/resources?limit=&offset=` and expects the
// LEGACY v1 ListDiscoveryResourcesResponse:
//
//   {
//     x402Version: 1,
//     items: [{ resource, type: 'http', x402Version: 1,
//               accepts: [v1 PaymentRequirements], lastUpdated, metadata? }],
//     pagination: { limit, offset, total }
//   }
//
// v1 PaymentRequirements differ from the v2 accepts we serve everywhere else:
// the amount field is `maxAmountRequired` (not `amount`), and `network` is a
// friendly name from the legacy enum ('solana', 'base', …), not a CAIP-2 id.
// Reference: coinbase/x402 typescript/packages/legacy/x402/src/types/verify/
// x402Specs.ts (DiscoveredResourceSchema, PaymentRequirementsSchema) and
// shared/network.ts (NetworkSchema).
//
// The catalog itself comes from buildX402DiscoveryDoc() in api/wk.js — the
// same builder that renders /.well-known/x402.json — so the facilitator's
// discovery list can never drift from the platform's canonical catalog.

import { buildX402DiscoveryDoc } from '../../wk.js';
import {
	NETWORK_SOLANA_MAINNET,
	NETWORK_SOLANA_DEVNET,
	NETWORK_BASE_MAINNET,
	NETWORK_BASE_SEPOLIA,
} from '../x402-spec.js';

// CAIP-2 → legacy v1 network name. Only networks present in the legacy
// NetworkSchema enum may appear in a v1 accept; anything else (Arbitrum, BSC,
// X Layer) is dropped from this projection — those rails stay fully
// advertised in the v2 catalog and the live 402 challenge.
const V1_NETWORK_BY_CAIP2 = {
	[NETWORK_SOLANA_MAINNET]: 'solana',
	[NETWORK_SOLANA_DEVNET]: 'solana-devnet',
	[NETWORK_BASE_MAINNET]: 'base',
	[NETWORK_BASE_SEPOLIA]: 'base-sepolia',
	'eip155:137': 'polygon',
	'eip155:43114': 'avalanche',
};

export const DISCOVERY_DEFAULT_LIMIT = 100;
export const DISCOVERY_MAX_LIMIT = 500;

// One v2 catalog accept → one v1 PaymentRequirements, or null when the accept
// cannot be expressed in the legacy schema (non-exact scheme, unmapped
// network, missing money fields).
export function toV1Accept(accept, item) {
	if (!accept || accept.scheme !== 'exact') return null;
	const network = V1_NETWORK_BY_CAIP2[accept.network];
	if (!network) return null;
	const amount = accept.amount ?? accept.maxAmountRequired;
	if (amount == null || !/^\d+$/.test(String(amount))) return null;
	if (!accept.payTo || !accept.asset) return null;
	const out = {
		scheme: 'exact',
		network,
		maxAmountRequired: String(amount),
		resource: accept.resource || item.url,
		description: item.description || '',
		mimeType: item.mimeType || 'application/json',
		payTo: accept.payTo,
		maxTimeoutSeconds: Number.isInteger(accept.maxTimeoutSeconds)
			? accept.maxTimeoutSeconds
			: 60,
		asset: accept.asset,
	};
	if (accept.extra && typeof accept.extra === 'object') out.extra = accept.extra;
	if (item.outputSchema && typeof item.outputSchema === 'object') {
		out.outputSchema = item.outputSchema;
	}
	return out;
}

// One catalog resource entry → one v1 DiscoveredResource, or null when no
// accept survives the projection (e.g. an EVM-only entry on a rail the legacy
// schema doesn't name).
export function toV1Item(item, lastUpdated) {
	if (!item || !item.url) return null;
	const accepts = (Array.isArray(item.accepts) ? item.accepts : [])
		.map((a) => toV1Accept(a, item))
		.filter(Boolean);
	if (accepts.length === 0) return null;
	const metadata = {};
	for (const key of ['serviceName', 'tags', 'iconUrl', 'method', 'path', 'toolName']) {
		if (item[key] != null) metadata[key] = item[key];
	}
	return {
		resource: item.url,
		type: 'http',
		x402Version: 1,
		accepts,
		lastUpdated,
		...(Object.keys(metadata).length > 0 ? { metadata } : {}),
	};
}

// A total order over the catalog. Callers page by offset with no cursor and no
// snapshot token, so two pages of the same sweep are only coherent if the list
// is ordered the same way every time it is built. Catalog order is otherwise
// the build's insertion order, which follows whichever upstream feeds answered
// first. Ties on `resource` are real: the MCP transports publish one entry per
// tool at a single URL, so the tool name (then the path) settles the order.
// The key joins on NUL because no URL, tool name, or path can contain one: a
// printable separator would let a resource that is a prefix of another sort
// ahead of or behind it depending on what follows.
export function compareDiscoveryItems(a, b) {
	const key = (item) =>
		`${item.resource}\0${item.metadata?.toolName || ''}\0${item.metadata?.path || ''}`;
	const ka = key(a);
	const kb = key(b);
	return ka < kb ? -1 : ka > kb ? 1 : 0;
}

// Full catalog → one v1 response page. `lastUpdated` defaults to now; the
// cached path passes the catalog build time so a pagination sweep sees one
// consistent timestamp.
export function projectDiscoveryResources(doc, { type, limit, offset, lastUpdated } = {}) {
	if (!lastUpdated) lastUpdated = new Date().toISOString();
	const wantLimit = Math.min(
		Math.max(1, Number.parseInt(limit, 10) || DISCOVERY_DEFAULT_LIMIT),
		DISCOVERY_MAX_LIMIT,
	);
	const wantOffset = Math.max(0, Number.parseInt(offset, 10) || 0);
	// Every resource we publish is HTTP; a filter for anything else is an
	// honest empty page, not an error.
	const items =
		type && type !== 'http'
			? []
			: (Array.isArray(doc?.resources) ? doc.resources : [])
					.map((r) => toV1Item(r, lastUpdated))
					.filter(Boolean)
					.sort(compareDiscoveryItems);
	return {
		x402Version: 1,
		items: items.slice(wantOffset, wantOffset + wantLimit),
		pagination: { limit: wantLimit, offset: wantOffset, total: items.length },
	};
}

// The full catalog build walks the DB and several cached feeds, and a crawler
// pages through it ~50 requests at a time — memoize the built doc briefly
// (same 300 s freshness as the /.well-known/x402.json CDN TTL) so a
// pagination sweep costs one build. A failed rebuild serves the last good doc
// rather than 500ing the crawler mid-sweep.
const DOC_TTL_MS = 300_000;

// A sweep that straddles a rebuild loses rows. The crawler pages by offset with
// no cursor and no snapshot token, so every row is served exactly once only if
// one sweep reads one build: a rebuild landing between two pages shifts every
// row after the churn point, which re-serves some and skips as many. Measured
// on the live catalog 2026-09-02, a 46-page sweep that began ~50 s before the
// TTL expired returned 4,519 rows holding 4,499 distinct resources.
// So pages after the first keep the build the sweep started on past the TTL,
// until this grace window closes; offset 0 always takes the fresh build. The
// window bounds the staleness a slow crawler can pin (a 4,500-row catalog is
// ~46 requests, far inside it), and a concurrent sweep starting at offset 0
// still forces the rebuild both then see, because offset is the only sweep
// identity the wire format carries.
const DOC_SWEEP_GRACE_MS = 600_000;

// True when the cached build of age `ageMs` may answer this request.
// `continuation` marks a page past the first, i.e. a sweep already in flight.
export function canServeCachedDoc({ ageMs, continuation }) {
	if (!Number.isFinite(ageMs) || ageMs < 0) return false;
	if (ageMs < DOC_TTL_MS) return true;
	return Boolean(continuation) && ageMs < DOC_TTL_MS + DOC_SWEEP_GRACE_MS;
}

let docCache = { at: 0, doc: null, inflight: null };

async function getDiscoveryDoc({ continuation = false } = {}) {
	const now = Date.now();
	if (docCache.doc && canServeCachedDoc({ ageMs: now - docCache.at, continuation })) {
		return docCache.doc;
	}
	if (!docCache.inflight) {
		docCache.inflight = buildX402DiscoveryDoc()
			.then((doc) => {
				docCache = { at: Date.now(), doc, inflight: null };
				return doc;
			})
			.catch((err) => {
				docCache.inflight = null;
				if (docCache.doc) {
					console.error(
						'[x402-discovery] catalog rebuild failed, serving stale doc',
						err?.message || err,
					);
					return docCache.doc;
				}
				throw err;
			});
	}
	return docCache.inflight;
}

export async function listDiscoveryResources(query = {}) {
	const doc = await getDiscoveryDoc({
		continuation: (Number.parseInt(query.offset, 10) || 0) > 0,
	});
	return projectDiscoveryResources(doc, {
		...query,
		lastUpdated: docCache.at ? new Date(docCache.at).toISOString() : undefined,
	});
}
