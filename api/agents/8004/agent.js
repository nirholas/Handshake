// GET /api/agents/8004/agent?chain=8453&id=<tokenId>
//
// Returns the full details for a single ERC-8004 agent by numeric token id.
// Used by /demos/erc8004 — no auth, read-only.

import { DEFAULT_SUBGRAPH_URLS, DEFAULT_REGISTRIES } from 'agent0-sdk';
import { cors, method, error, wrap, json } from '../../_lib/http.js';

export const maxDuration = 30;

const SUPPORTED_CHAINS = Object.keys(DEFAULT_REGISTRIES).map(Number);
const SUBGRAPH_TIMEOUT_MS = 12_000;

const AGENT_QUERY = `
  query GetAgent($agentId: String!) {
    agent(id: $agentId) {
      id
      chainId
      agentId
      owner
      operators
      agentURI
      agentURIType
      agentWallet
      createdAt
      updatedAt
      totalFeedback
      lastActivity
      registrationFile {
        name
        description
        image
        active
        x402Support
        supportedTrusts
        mcpEndpoint
        mcpVersion
        a2aEndpoint
        a2aVersion
        webEndpoint
        emailEndpoint
        hasOASF
        oasfSkills
        oasfDomains
        ens
        did
        mcpTools
        mcpPrompts
        mcpResources
        a2aSkills
      }
    }
  }
`;

async function fetchAgent(subgraphUrl, agentId) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), SUBGRAPH_TIMEOUT_MS);
	try {
		const res = await fetch(subgraphUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ query: AGENT_QUERY, variables: { agentId } }),
			signal: controller.signal,
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const body = await res.json();
		if (body.errors?.length) throw new Error(body.errors[0].message);
		return body.data?.agent || null;
	} finally {
		clearTimeout(timer);
	}
}

export default wrap(async function handler(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (method(req, res, ['GET'])) return;

	const url = new URL(req.url, 'http://x');
	const chainId = Number(url.searchParams.get('chain') || 8453);
	const idRaw = (url.searchParams.get('id') || '').trim();

	if (!SUPPORTED_CHAINS.includes(chainId)) {
		return error(res, 400, 'unsupported_chain',
			`chain ${chainId} not supported`, { supported: SUPPORTED_CHAINS });
	}
	if (!idRaw || !/^\d+$/.test(idRaw)) {
		return error(res, 400, 'bad_id', 'id must be a positive integer (numeric agentId)');
	}

	const subgraphUrl = DEFAULT_SUBGRAPH_URLS[chainId];
	if (!subgraphUrl) {
		return error(res, 502, 'no_subgraph', `no subgraph configured for chain ${chainId}`);
	}

	// The Graph indexes agents with the composite id "chainId:tokenId"
	const compositeId = `${chainId}:${idRaw}`;

	let raw;
	try {
		raw = await fetchAgent(subgraphUrl, compositeId);
	} catch (e) {
		if (e?.name === 'AbortError') {
			return error(res, 504, 'subgraph_timeout', 'subgraph query timed out');
		}
		return error(res, 502, 'lookup_failed', e?.message || 'subgraph query failed');
	}

	if (!raw) return error(res, 404, 'not_found', `agent #${idRaw} not found on chain ${chainId}`);

	const rf = raw.registrationFile;
	const agent = {
		agentId: raw.id || compositeId,
		chainId: raw.chainId ? Number(raw.chainId) : chainId,
		address: raw.agentWallet || null,
		owner: raw.owner || null,
		operators: raw.operators || [],
		name: rf?.name || raw.id || null,
		description: rf?.description || null,
		image: rf?.image || null,
		registrationUri: raw.agentURI || null,
		registeredAtSeconds: raw.createdAt ? Number(raw.createdAt) : null,
		updatedAtSeconds: raw.updatedAt ? Number(raw.updatedAt) : null,
		lastActivitySeconds: raw.lastActivity ? Number(raw.lastActivity) : null,
		feedbackCount: raw.totalFeedback != null ? Number(raw.totalFeedback) : null,
		active: rf?.active ?? null,
		x402support: rf?.x402Support ?? false,
		mcpEndpoint: rf?.mcpEndpoint || null,
		mcpVersion: rf?.mcpVersion || null,
		a2aEndpoint: rf?.a2aEndpoint || null,
		a2aVersion: rf?.a2aVersion || null,
		webEndpoint: rf?.webEndpoint || null,
		emailEndpoint: rf?.emailEndpoint || null,
		hasOASF: rf?.hasOASF ?? null,
		oasfSkills: rf?.oasfSkills || [],
		oasfDomains: rf?.oasfDomains || [],
		ens: rf?.ens || null,
		did: rf?.did || null,
		supportedTrusts: rf?.supportedTrusts || [],
		a2aSkills: rf?.a2aSkills || [],
		mcpTools: rf?.mcpTools || [],
		mcpPrompts: rf?.mcpPrompts || [],
		mcpResources: rf?.mcpResources || [],
	};

	json(res, 200, { chainId, agentId: idRaw, agent },
		{ 'cache-control': 'public, max-age=30, stale-while-revalidate=120' });
});
