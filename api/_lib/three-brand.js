/**
 * three.ws on-chain brand + metadata builders
 * -------------------------------------------
 * Single source of truth for everything we stamp onto Solana when an agent is
 * deployed (Metaplex Core asset) or tokenized (pump.fun). Two goals:
 *
 *   1. Make every on-chain artifact unmistakably a three.ws artifact — the
 *      platform name, our links, and the $THREE coin travel with the asset so a
 *      wallet, explorer, or marketplace surfaces the connection without us.
 *   2. Maximize *correct* metadata. The off-chain JSON is a strict superset of
 *      the Metaplex token-metadata standard (so Phantom / Solscan / Magic Eden
 *      render it) AND our agent-manifest/0.1 schema. The on-chain Attributes
 *      plugin writes a curated subset *directly into the asset account* — real
 *      bytes on the blockchain, not just a pointer.
 *
 * Links here are the canonical ones used across the site (footer.html,
 * features.json). Never invent a URL — if it isn't already real, it doesn't
 * belong in on-chain metadata.
 */

import { env } from './env.js';
import { gmgnTokenUrl, axiomTokenUrl, padreTokenUrl, fomoTokenUrl } from '../../src/shared/trading-terminals.js';

// ── Canonical brand ──────────────────────────────────────────────────────────

export const THREE_WS = {
	name: 'three.ws',
	tagline: 'Give your AI a body.',
	description:
		'three.ws is the AI-agent layer for the open web: build, embed, monetize, ' +
		'and trade autonomous agents with real 3D avatars, on-chain identity, ' +
		'pay-per-call (x402), and pump.fun token launches.',
	website: 'https://three.ws',
	x: 'https://x.com/trythreews',
	xHandle: '@trythreews',
	telegram: 'https://t.me/three_ws',
	github: 'https://github.com/nirholas/three.ws',
	docs: 'https://three.ws/docs',
	ogImage: 'https://three.ws/og-image.png',
};

// ── $THREE — the platform coin every artifact links back to ──────────────────

/** @returns {string} the $THREE mint (env-overridable for devnet/test). */
export function threeTokenMint() {
	return env.THREE_TOKEN_MINT;
}

/** Canonical $THREE link set, derived from the active mint. */
export function threeTokenLinks(mint = threeTokenMint()) {
	return {
		symbol: 'THREE',
		mint,
		pumpfun: `https://pump.fun/coin/${mint}`,
		jupiter: `https://jup.ag/tokens/${mint}`,
		solscan: `https://solscan.io/token/${mint}`,
		phantom: `https://phantom.com/tokens/solana/${mint}`,
		dexscreener: `https://dexscreener.com/solana/${mint}`,
		coingecko: 'https://www.coingecko.com/en/coins/three-ws',
		// Trading terminals. GMGN's carries our referral inline; the other three
		// have no documented deep-link referral form, so they stay clean deep
		// links. See src/shared/trading-terminals.js.
		gmgn: gmgnTokenUrl(mint),
		axiom: axiomTokenUrl(mint),
		padre: padreTokenUrl(mint),
		fomo: fomoTokenUrl(mint),
	};
}

/** Public profile page for a deployed agent. */
export function agentHomeUrl(agentId) {
	return `${env.APP_ORIGIN}/agents/${agentId}`;
}

// ── helpers ──────────────────────────────────────────────────────────────────

const _enc = new TextEncoder();

/**
 * Clamp to a UTF-8 *byte* budget without splitting a codepoint. On-chain
 * attributes are borsh strings measured in bytes, so a CJK/emoji name must be
 * bounded by bytes — not characters — or it can overflow the 1232-byte tx.
 */
function clamp(str, maxBytes) {
	const s = String(str ?? '').trim();
	if (_enc.encode(s).length <= maxBytes) return s;
	let out = '';
	let bytes = 0;
	for (const ch of s) {
		const b = _enc.encode(ch).length;
		if (bytes + b > maxBytes - 3) break; // reserve 3 bytes for the ellipsis
		out += ch;
		bytes += b;
	}
	return `${out.trimEnd()}…`;
}

/** A Metaplex `creators` array crediting the owner + the platform. */
function creators(ownerAddress) {
	const list = [];
	if (ownerAddress) list.push({ address: ownerAddress, share: 100 });
	return list;
}

/** Default enforced secondary-sale royalty for agent assets: 5%, to the owner. */
export const AGENT_ROYALTY_BPS = 500;

/**
 * Plain-data config for the Metaplex Core Royalties plugin. Kept SDK-free so
 * this module stays dependency-light — the caller turns this into the plugin
 * with `ruleSet('None')`. Returns `null` when there's no owner to credit
 * (the plugin requires creator percentages to sum to 100).
 *
 * @param {string} ownerAddress base58 owner/creator wallet
 * @param {number} [basisPoints]
 */
export function agentRoyaltyConfig(ownerAddress, basisPoints = AGENT_ROYALTY_BPS) {
	if (!ownerAddress) return null;
	return { basisPoints, creators: [{ address: ownerAddress, percentage: 100 }] };
}

/**
 * Deterministic short symbol for an agent's skill NFT collection, derived from
 * its name. Used identically on the off-chain collection JSON and by the create
 * script so a wallet/explorer shows a stable ticker. Strips to uppercase
 * alphanumerics, caps at 10 chars, falls back to 'SKILL'.
 *
 * @param {string} [agentName]
 * @returns {string}
 */
export function skillCollectionSymbol(agentName) {
	const cleaned = String(agentName || '')
		.toUpperCase()
		.replace(/[^A-Z0-9]/g, '')
		.slice(0, 10);
	return cleaned || 'SKILL';
}

// ── Agent identity (Metaplex Core asset) ─────────────────────────────────────

/**
 * Off-chain JSON pinned for a Metaplex Core agent asset. Superset of the
 * Metaplex token-metadata standard + agent-manifest/0.1, so generic NFT readers
 * and our own resolvers both work from one document.
 *
 * @param {object} a
 * @param {string} a.name
 * @param {string} [a.description]
 * @param {string} [a.image]            resolvable avatar thumbnail (https/ipfs)
 * @param {string} [a.animationUrl]     avatar GLB (https/ipfs)
 * @param {string} [a.externalUrl]      agent profile page
 * @param {string|null} [a.avatarId]
 * @param {string[]} [a.skills]
 * @param {string} [a.ownerAddress]     for the creators array
 * @param {string} [a.createdAt]        ISO timestamp
 */
export function buildAgentManifest(a) {
	const tok = threeTokenLinks();
	const image = a.image || THREE_WS.ogImage;
	const description =
		a.description?.trim() || `${a.name} — an autonomous agent on ${THREE_WS.name}.`;

	const attributes = [
		{ trait_type: 'Platform', value: THREE_WS.name },
		{ trait_type: 'Standard', value: 'Metaplex Core' },
		{ trait_type: 'Schema', value: 'agent-manifest/0.1' },
		...(a.skills?.length ? [{ trait_type: 'Skills', value: a.skills.join(', ') }] : []),
		{ trait_type: '$THREE', value: tok.mint },
		...(a.createdAt ? [{ trait_type: 'Created', value: a.createdAt }] : []),
	];

	const files = [{ uri: image, type: 'image/png' }];
	if (a.animationUrl) files.push({ uri: a.animationUrl, type: 'model/gltf-binary' });

	return {
		// Metaplex token-metadata standard
		name: a.name,
		symbol: 'AGENT',
		description,
		image,
		...(a.animationUrl ? { animation_url: a.animationUrl } : {}),
		external_url: a.externalUrl || THREE_WS.website,
		attributes,
		properties: {
			category: a.animationUrl ? 'vr' : 'image',
			files,
			creators: creators(a.ownerAddress),
		},
		// three.ws brand block — links travel with the asset
		platform: {
			name: THREE_WS.name,
			url: THREE_WS.website,
			tagline: THREE_WS.tagline,
			x: THREE_WS.x,
			github: THREE_WS.github,
		},
		token: { symbol: tok.symbol, mint: tok.mint, url: tok.pumpfun },
		// agent-manifest/0.1 (our resolvers)
		$schema: 'https://3d-agent.io/schemas/manifest/0.1.json',
		spec: 'agent-manifest/0.1',
		tags: ['three.ws', 'ai-agent', ...(a.skills || [])],
		body: { uri: a.animationUrl || '', format: 'gltf-binary' },
		_baseURI: 'ipfs://',
		...(a.avatarId ? { avatarId: a.avatarId } : {}),
		...(a.skills?.length ? { skills: a.skills } : {}),
	};
}

/**
 * Attributes written *directly on-chain* via the Metaplex Core Attributes
 * plugin. This is the literal "more metadata on the blockchain" — each pair is
 * stored in the asset account (and costs rent), so the set is curated: brand,
 * provenance links, the off-chain JSON pointer, and the $THREE linkage.
 *
 * Keys are short; values are clamped so a long agent name or skill list can't
 * blow up rent. Returns `[{ key, value }]` ready for the plugin's attributeList.
 */
export function buildAgentOnchainAttributes(a) {
	const tok = threeTokenLinks();
	// Caps (in UTF-8 bytes) keep the plugin comfortably under Solana's 1232-byte
	// tx limit even with a long agent name and a full skill list. The off-chain
	// JSON URI already lives on-chain in the asset's `uri` field, so it is not
	// duplicated here.
	const pairs = [
		['platform', THREE_WS.name],
		['url', THREE_WS.website],
		['agent', clamp(a.name, 48)],
		...(a.agentUrl ? [['agent_url', clamp(a.agentUrl, 72)]] : []),
		['x', THREE_WS.x],
		['github', THREE_WS.github],
		['$THREE', tok.mint],
		['$THREE_url', tok.pumpfun],
		['standard', 'metaplex-core'],
		['schema', 'agent-manifest/0.1'],
		...(a.skills?.length ? [['skills', clamp(a.skills.join(','), 80)]] : []),
		...(a.createdAt ? [['created', a.createdAt]] : []),
	];
	return pairs.map(([key, value]) => ({ key, value: String(value) }));
}

/**
 * Off-chain registration document for the Metaplex Agent Registry
 * (`@metaplex-foundation/mpl-agent-registry`). This is a DIFFERENT artifact from
 * the Core asset manifest: minting a Core asset only creates the NFT — to make an
 * agent discoverable in Metaplex's on-chain Agent Registry the asset needs an
 * Agent Identity PDA whose `agentRegistrationUri` points at this JSON.
 *
 * Superset of the SDK's `AgentMetadata` interface — the six required fields
 * (type/name/description/services/registrations/supportedTrust) are all present,
 * so SDK-strict consumers read it without coercion. We additionally emit the
 * EIP-8004 registration-v1 signals that Metaplex's Agent Registry indexes
 * (`active`, `x402Support`, `x402Endpoints`, `agentMetadataUri`); without them the
 * registry defaults the agent to "x402 Not Supported" / inactive even though every
 * three.ws agent settles calls over x402. Mirrors the canonical served doc at
 * /.well-known/agent-registration.json so on- and off-chain metadata agree.
 *
 * @param {object} a
 * @param {string|number} a.agentId    three.ws agent id (for the cross-registry link)
 * @param {string} a.name
 * @param {string} [a.description]
 * @param {string} [a.agentUrl]        public agent profile page
 * @param {string} [a.image]           resolvable avatar thumbnail (https/ipfs)
 * @param {string} [a.modelUri]        the agent's 3D avatar GLB (https/ipfs)
 * @param {string} [a.modelFormat]     defaults to 'gltf-binary'
 * @param {string} [a.origin]          public origin override (defaults to env.APP_ORIGIN)
 * @param {boolean} [a.active]         defaults true; pass false to mark inactive
 * @param {{chainId:string|number,agentId:string|number,registry?:string}} [a.erc8004]
 * @param {string[]} [a.skills]
 */
export function buildAgentRegistrationMetadata(a) {
	const origin = (a.origin || env.APP_ORIGIN).replace(/\/$/, '');
	const home = a.agentUrl || agentHomeUrl(a.agentId);
	const description =
		a.description?.trim() || `${a.name} — an autonomous agent on ${THREE_WS.name}.`;
	const image = a.image || THREE_WS.ogImage;
	const cardUrl = `${origin}/.well-known/agent-card.json`;

	// Real, reachable endpoints. `endpoint` is the SDK's field; the extra `version`
	// keys are ignored by strict consumers and used by richer registry indexers.
	const services = [
		{ name: 'web', endpoint: home },
		{ name: 'A2A', endpoint: cardUrl, version: '0.3.0' },
		{ name: 'MCP', endpoint: `${origin}/.well-known/openapi.yaml`, version: '2025-06-18' },
	];

	return {
		// Metaplex's Agent Registry indexer requires `type` to be a STRING matching
		// the EIP-8004 registration-v1 URL. An array here makes the indexer reject
		// the registration-v1 shape and fall back to a name/description/image-only
		// record — silently dropping active/x402Support/services/supportedTrust from
		// the agent page. Keep `type` a string; carry the three.ws spec separately.
		type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
		additionalTypes: ['https://three.ws/specs/3d-agent-card-v1'],
		name: a.name,
		description,
		image,
		active: a.active === false ? false : true,
		// The 3D avatar is the three.ws differentiator — surface it so the registry
		// can render the agent's body, not just a flat thumbnail.
		...(a.modelUri ? { model: { uri: a.modelUri, format: a.modelFormat || 'gltf-binary' } } : {}),
		services,
		x402Support: true,
		x402Endpoints: [
			{
				url: `${origin}/api/mcp`,
				method: 'POST',
				description:
					'MCP tool call — 3D avatar viewer, glTF model validation/inspection/optimization, and Solana agent data',
				networks: ['solana', 'base'],
				scheme: 'exact',
				priceUsdc: '0.001',
			},
		],
		// Cross-link to other registries this agent lives in so identities resolve to
		// each other — Metaplex's `AgentRegistration` shape: { agentId, agentRegistry }.
		// Always the three.ws handle; plus an ERC-8004 entry when the agent has one.
		registrations: [
			{ agentId: String(a.agentId), agentRegistry: THREE_WS.website },
			...(a.erc8004?.chainId && a.erc8004?.agentId
				? [{
						agentRegistry: `eip155:${a.erc8004.chainId}:${a.erc8004.registry || ''}`.replace(/:$/, ''),
						agentId: String(a.erc8004.agentId),
					}]
				: []),
		],
		supportedTrust: ['reputation'],
		agentMetadataUri: cardUrl,
	};
}

/**
 * ERC-8004 registration-file fields that the Agent Registry subgraph indexes
 * (see api/agents/8004/agent.js `registrationFile { active x402Support mcpEndpoint
 * a2aEndpoint webEndpoint supportedTrusts ... }`). The EVM registration flow
 * (api/agents/register) pins an agent-manifest JSON whose base shape lacks these
 * flat fields, so the indexer defaults `x402Support` to false and shows three.ws
 * agents as inactive / "x402 Not Supported". Spread these in to advertise the
 * truth: every three.ws agent settles calls over x402. Mirrors the Solana
 * registry doc above so on- and cross-chain registries agree.
 *
 * @param {string} [origin] public app origin (defaults to env.APP_ORIGIN)
 */
export function erc8004RegistryFields(origin = env.APP_ORIGIN) {
	const o = String(origin || env.APP_ORIGIN).replace(/\/$/, '');
	return {
		active: true,
		x402Support: true,
		webEndpoint: o,
		a2aEndpoint: `${o}/.well-known/agent-card.json`,
		a2aVersion: '0.3.0',
		mcpEndpoint: `${o}/api/mcp`,
		mcpVersion: '2025-06-18',
		supportedTrusts: ['reputation'],
	};
}

// ── Agent token (pump.fun) ───────────────────────────────────────────────────

/**
 * Off-chain JSON for a pump.fun token. pump.fun's UI reads name/symbol/
 * description/image/showName/createdOn/twitter/telegram/website — we fill those
 * so the coin page links back to three.ws and our X. Extra standard fields
 * (external_url, attributes, properties) are ignored by pump.fun but render in
 * wallets and explorers.
 *
 * @param {object} t
 * @param {string} t.name
 * @param {string} t.symbol
 * @param {string} [t.description]
 * @param {string} [t.image]
 * @param {string} [t.website]      defaults to the agent page (falls back to three.ws)
 * @param {string} [t.twitter]      defaults to the three.ws X account
 * @param {string} [t.telegram]     defaults to the three.ws Telegram channel
 * @param {string} [t.agentUrl]     agent profile page
 * @param {string} [t.creatorAddress]
 * @param {string} [t.createdAt]    ISO timestamp
 */
// Attribution suffix stamped onto every user-provided pump.fun token description.
// Keeps the attribution short so it doesn't crowd out the user's copy.
const THREE_WS_ATTRIBUTION = '\n\nLaunched on three.ws · 3D AI agents on-chain.';

export function buildTokenMetadata(t) {
	const tok = threeTokenLinks();
	const website = t.website || t.agentUrl || THREE_WS.website;
	const twitter = t.twitter || THREE_WS.x;
	const telegram = t.telegram || THREE_WS.telegram;
	const userDesc = t.description?.trim() || '';
	const ATTR_LEN = THREE_WS_ATTRIBUTION.length;
	const description = userDesc
		? `${userDesc.slice(0, 500 - ATTR_LEN)}${THREE_WS_ATTRIBUTION}`
		: `${t.name} — an autonomous agent token launched on ${THREE_WS.name}. ${THREE_WS_ATTRIBUTION.trim()}`;

	const attributes = [
		{ trait_type: 'Platform', value: THREE_WS.name },
		{ trait_type: 'Launchpad', value: 'pump.fun' },
		{ trait_type: '$THREE', value: tok.mint },
	];

	const json = {
		name: t.name,
		symbol: t.symbol,
		description,
		image: t.image || '',
		showName: true,
		createdOn: THREE_WS.website,
		website,
		twitter,
		telegram,
		// Standard + brand extras (explorers/wallets read these; pump ignores them)
		external_url: website,
		attributes,
		properties: {
			category: 'image',
			...(t.image ? { files: [{ uri: t.image, type: 'image/png' }] } : {}),
			creators: creators(t.creatorAddress),
		},
		platform: {
			name: THREE_WS.name,
			url: THREE_WS.website,
			x: THREE_WS.x,
			telegram: THREE_WS.telegram,
			github: THREE_WS.github,
		},
		token: { symbol: tok.symbol, mint: tok.mint, url: tok.pumpfun },
		...(t.createdAt ? { createdAt: t.createdAt } : {}),
	};
	return json;
}
