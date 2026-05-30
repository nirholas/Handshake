/**
 * Universal on-chain agent resolver.
 *
 * One import point for every surface that needs to turn "an on-chain agent"
 * into something renderable: the web component, oEmbed, OG image, explore
 * page, Claude.ai artifact, LobeHub plugin, SDK.
 *
 * Inputs it understands:
 *
 *   parseAgentRef('eip155:8453:0xabc...:42')         — full CAIP-10 + tokenId
 *   parseAgentRef('onchain:8453:42')                 — shorthand (canonical registry)
 *   parseAgentRef('agent://8453/42')                 — agent URI
 *   parseAgentRef({ chainId: 8453, agentId: 42 })    — already parsed
 *   parseAgentRef('/a/8453/42')                      — URL path
 *
 * Output of resolveOnchainAgent: a normalized record with on-chain facts
 * (owner, URI) + off-chain metadata + a resolved GLB URL.
 */

import { getAgentOnchain, fetchAgentMetadata, findAvatar3D } from './queries.js';
import { REGISTRY_DEPLOYMENTS, agentRegistryId } from './abi.js';
import { CHAIN_META } from './chain-meta.js';

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse any supported agent reference into `{ chainId, agentId, registry? }`.
 * Returns `null` if the input doesn't look like an on-chain reference.
 *
 * @param {string|object} input
 * @returns {{ chainId: number, agentId: string, registry?: string }|null}
 */
export function parseAgentRef(input) {
	if (!input) return null;

	if (typeof input === 'object') {
		if (input.chainId && input.agentId !== undefined) {
			return {
				chainId: Number(input.chainId),
				agentId: String(input.agentId),
				registry: input.registry || undefined,
			};
		}
		return null;
	}

	const s = String(input).trim();
	if (!s) return null;

	// Full CAIP-10 + token: "eip155:<chainId>:<registry>:<agentId>"
	let m = s.match(/^eip155:(\d+):(0x[0-9a-fA-F]{40}):(\d+)$/);
	if (m) return { chainId: Number(m[1]), registry: m[2], agentId: m[3] };

	// CAIP-10 assetType form: "eip155:<chainId>/erc721:<registry>/<agentId>"
	m = s.match(/^eip155:(\d+)\/erc721:(0x[0-9a-fA-F]{40})\/(\d+)$/);
	if (m) return { chainId: Number(m[1]), registry: m[2], agentId: m[3] };

	// Shorthand: "onchain:<chainId>:<agentId>"
	m = s.match(/^onchain:(\d+):(\d+)$/);
	if (m) return { chainId: Number(m[1]), agentId: m[2] };

	// agent:// scheme
	m = s.match(/^agent:\/\/(\d+)\/(\d+)$/);
	if (m) return { chainId: Number(m[1]), agentId: m[2] };

	// URL path: "/a/<chainId>/<agentId>" or with explicit registry
	m = s.match(/^\/?a\/(\d+)\/(\d+)(?:\/(embed))?\/?$/);
	if (m) return { chainId: Number(m[1]), agentId: m[2] };
	m = s.match(/^\/?a\/(\d+)\/(0x[0-9a-fA-F]{40})\/(\d+)\/?$/);
	if (m) return { chainId: Number(m[1]), registry: m[2], agentId: m[3] };

	return null;
}

/**
 * Return the canonical CAIP-10 identifier string for an agent.
 * @param {{ chainId: number, agentId: string|number, registry?: string }} ref
 */
export function toCAIP10(ref) {
	const registry = ref.registry || REGISTRY_DEPLOYMENTS[ref.chainId]?.identityRegistry;
	if (!registry) return `onchain:${ref.chainId}:${ref.agentId}`;
	return `eip155:${ref.chainId}:${registry}:${ref.agentId}`;
}

/**
 * Return the public `/a/<chainId>/<agentId>` URL for an agent.
 * @param {{ chainId: number, agentId: string|number }} ref
 * @param {object} [opts]
 * @param {boolean} [opts.embed]   Append `/embed` for chromeless iframe mode
 * @param {string}  [opts.origin]  Override origin (defaults to location.origin)
 */
export function toPublicUrl(ref, { embed = false, origin } = {}) {
	const o = origin || (typeof location !== 'undefined' ? location.origin : '');
	return `${o}/a/${ref.chainId}/${ref.agentId}${embed ? '/embed' : ''}`;
}

// ---------------------------------------------------------------------------
// URL fallback — tries direct, then rotates IPFS gateways, then Arweave
// ---------------------------------------------------------------------------

const IPFS_GATEWAYS = [
	'https://ipfs.io/ipfs/',
	'https://dweb.link/ipfs/',
	'https://flk-ipfs.xyz/ipfs/',
	'https://gateway.pinata.cloud/ipfs/',
];
const AR_GATEWAY = 'https://arweave.net/';

/**
 * Convert any of `https://…`, `ipfs://<cid>[/path]`, `ar://<tx>` into a plain
 * HTTPS URL. For ipfs, returns the first gateway — use `resolveUrlCandidates`
 * when you need fallbacks.
 *
 * @param {string} uri
 * @returns {string}
 */
export function resolveUrl(uri) {
	if (!uri) return '';
	if (uri.startsWith('ipfs://')) return IPFS_GATEWAYS[0] + uri.slice(7);
	if (uri.startsWith('ar://')) return AR_GATEWAY + uri.slice(5);
	return uri;
}

/**
 * All HTTPS forms of an off-chain URI, in preference order. Use when you
 * want to try each in sequence — e.g. the `<img>` fallback chain or a
 * `fetch` retry loop.
 *
 * @param {string} uri
 * @returns {string[]}
 */
export function resolveUrlCandidates(uri) {
	if (!uri) return [];
	if (uri.startsWith('ipfs://')) {
		const rest = uri.slice(7);
		return IPFS_GATEWAYS.map((gw) => gw + rest);
	}
	if (uri.startsWith('ar://')) return [AR_GATEWAY + uri.slice(5)];
	return [uri];
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

// Lightweight in-memory cache keyed by canonical ref string. The resolver is
// a hot path on /discover and in consumer embeds; don't hit the chain twice
// for the same agent within a page session.
const _cache = new Map();
function cacheKey(ref) {
	return `${ref.chainId}:${ref.agentId}`;
}

/**
 * Full resolution of an on-chain ERC-8004 agent.
 *
 * @param {string|object} input   Anything `parseAgentRef` accepts
 * @param {object} [opts]
 * @param {any}     [opts.ethProvider]  EIP-1193 provider for chain reads
 * @param {boolean} [opts.fresh]        Bypass the session cache
 * @returns {Promise<{
 *   ref: { chainId: number, agentId: string, registry: string },
 *   caip: string,
 *   publicUrl: string,
 *   chain: { name: string, testnet: boolean, explorer: string }|null,
 *   onchain: { owner: string|null, uri: string|null },
 *   metadata: any|null,
 *   metadataUrl: string|null,
 *   image: string|null,
 *   glbUrl: string|null,
 *   name: string,
 *   description: string,
 *   services: any[],
 *   error?: string,
 * }>}
 */
export async function resolveOnchainAgent(input, { ethProvider, fresh = false } = {}) {
	const parsed = parseAgentRef(input);
	if (!parsed) throw new Error(`Unrecognised agent reference: ${input}`);

	const ref = {
		chainId: parsed.chainId,
		agentId: String(parsed.agentId),
		registry: parsed.registry || REGISTRY_DEPLOYMENTS[parsed.chainId]?.identityRegistry || null,
	};
	if (!ref.registry) throw new Error(`No registry deployed on chain ${ref.chainId}`);

	const key = cacheKey(ref);
	if (!fresh && _cache.has(key)) return _cache.get(key);

	const chainMeta = CHAIN_META[ref.chainId] || null;
	const base = {
		ref,
		caip: toCAIP10(ref),
		publicUrl:
			typeof location !== 'undefined' ? toPublicUrl(ref) : `/a/${ref.chainId}/${ref.agentId}`,
		chain: chainMeta
			? { name: chainMeta.name, testnet: !!chainMeta.testnet, explorer: chainMeta.explorer }
			: null,
		onchain: { owner: null, uri: null },
		metadata: null,
		metadataUrl: null,
		image: null,
		glbUrl: null,
		name: `Agent #${ref.agentId}`,
		description: '',
		services: [],
	};

	try {
		const { owner, uri } = await getAgentOnchain({
			chainId: ref.chainId,
			agentId: ref.agentId,
			ethProvider,
		});
		base.onchain = { owner, uri };

		if (!uri) {
			base.error = 'agentURI not set';
			_cache.set(key, base);
			return base;
		}

		const metaRes = await fetchAgentMetadata(uri);
		if (!metaRes.ok) {
			base.error = metaRes.error;
			base.metadataUrl = metaRes.resolvedUrl || null;
			_cache.set(key, base);
			return base;
		}
		const md = metaRes.data;
		base.metadata = md;
		base.metadataUrl = metaRes.resolvedUrl || null;
		base.name = (md?.name && String(md.name)) || base.name;
		base.description = (md?.description && String(md.description)) || '';
		base.image = md?.image ? String(md.image) : null;
		base.services = Array.isArray(md?.services) ? md.services : [];
		base.glbUrl = findAvatar3D(md);
	} catch (err) {
		base.error = err.message || String(err);
	}

	_cache.set(key, base);
	return base;
}

/**
 * Build a full agent-manifest/0.1 object from a resolved on-chain agent.
 * Mirrors the shape `resolveAgentById` returns so the rest of the boot path
 * (memory, skills, runtime) works unchanged.
 *
 * @param {Awaited<ReturnType<typeof resolveOnchainAgent>>} resolved
 * @returns {object}
 */
export function toManifest(resolved) {
	const services = Array.isArray(resolved.services) ? resolved.services : [];
	const brainSvc = services.find((s) => /brain|llm|chat/i.test(s?.name || s?.type || ''));
	const skillSvcs = services.filter((s) => /skill/i.test(s?.name || s?.type || ''));

	const glb = resolved.glbUrl ? resolveUrl(resolved.glbUrl) : '';
	const img = resolved.image ? resolveUrl(resolved.image) : '';

	return {
		spec: 'agent-manifest/0.1',
		_baseURI: resolved.metadataUrl ? trimToDir(resolved.metadataUrl) : '',
		_source: 'erc8004-resolver',
		id: {
			agentId: resolved.ref.agentId,
			chainId: resolved.ref.chainId,
			registry: resolved.ref.registry,
			owner: resolved.onchain.owner || undefined,
			walletAddress: resolved.onchain.owner || undefined,
			caip: resolved.caip,
			agentRegistry: agentRegistryId(resolved.ref.chainId, resolved.ref.registry),
		},
		name: resolved.name,
		description: resolved.description,
		image: img,
		body: { uri: glb || img, format: 'gltf-binary' },
		brain: brainSvc
			? { provider: 'remote', endpoint: brainSvc.endpoint }
			: { provider: 'none' },
		voice: { tts: { provider: 'browser' }, stt: { provider: 'browser' } },
		skills: skillSvcs.map((s) => ({ name: s.name, uri: s.endpoint })),
		memory: { mode: 'local', namespace: resolved.caip },
		tools: ['wave', 'lookAt', 'play_clip', 'setExpression'],
		version: '0.1.0',
		services,
		x402Support: !!(resolved.metadata?.x402Support || resolved.metadata?.x402),
		embedPolicy: resolved.metadata?.embedPolicy || null,
	};
}

function trimToDir(url) {
	const i = url.lastIndexOf('/');
	return i >= 0 ? url.slice(0, i + 1) : url;
}

/**
 * Should a given parent origin be allowed to embed this agent?
 * Respects an `embedPolicy` field in the registration JSON:
 *
 *   { mode: 'allowlist'|'denylist', hosts: ['example.com', '*.foo.com'] }
 *
 * No policy = public. Rules match hostname suffix; `*.` wildcards supported.
 *
 * @param {object|null} policy
 * @param {string} host
 * @returns {boolean}
 */
export function isEmbedAllowed(policy, host) {
	if (!policy || !policy.mode || !Array.isArray(policy.hosts)) return true;
	const match = policy.hosts.some((rule) => {
		if (!rule) return false;
		const r = String(rule).toLowerCase();
		const h = String(host || '').toLowerCase();
		if (r.startsWith('*.')) return h === r.slice(2) || h.endsWith('.' + r.slice(2));
		return h === r;
	});
	return policy.mode === 'allowlist' ? match : !match;
}
