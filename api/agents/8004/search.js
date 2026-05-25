// GET /api/agents/8004/search
//   ?chain=8453|84532|11155111|1|137 (default 8453)
//   &q=<search-string>                (optional — filters by metadata text)
//   &limit=<1..50>                    (default 20)
//   &skip=<0..>                       (default 0, for pagination)
//
// Lists ERC-8004 agents from the public Agent0 subgraph for the given chain.
// Used by /demos/erc8004 — no auth, read-only.
//
// The agent0-sdk's searchAgents() ignores `limit` at the subgraph level and
// paginates the entire registry in batches of 1000 before slicing client-side.
// On a live chain this easily exceeds Vercel's 30s function budget. We bypass
// the SDK's indexer entirely and query the subgraph directly so we can push
// `first` and `skip` down to the GraphQL layer, and attach a hard timeout.

import { DEFAULT_SUBGRAPH_URLS, DEFAULT_REGISTRIES } from 'agent0-sdk';
import { cors, method, error, wrap, json } from '../../_lib/http.js';

export const maxDuration = 30;

const SUPPORTED_CHAINS = Object.keys(DEFAULT_REGISTRIES).map(Number);
const SUBGRAPH_TIMEOUT_MS = 12_000;

const AGENTS_QUERY = `
  query SearchAgents(
    $where: Agent_filter
    $first: Int!
    $skip: Int!
    $orderBy: Agent_orderBy!
    $orderDirection: OrderDirection!
  ) {
    agents(where: $where, first: $first, skip: $skip, orderBy: $orderBy, orderDirection: $orderDirection) {
      id
      chainId
      agentId
      owner
      agentURI
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
        mcpEndpoint
        a2aEndpoint
        webEndpoint
        emailEndpoint
        ens
        did
        supportedTrusts
        a2aSkills
        mcpTools
      }
    }
  }
`;

async function querySubgraph(subgraphUrl, variables) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), SUBGRAPH_TIMEOUT_MS);
	try {
		const res = await fetch(subgraphUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ query: AGENTS_QUERY, variables }),
			signal: controller.signal,
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const body = await res.json();
		if (body.errors?.length) throw new Error(body.errors[0].message);
		return body.data?.agents || [];
	} finally {
		clearTimeout(timer);
	}
}

export default wrap(async function handler(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (method(req, res, ['GET'])) return;

	const url = new URL(req.url, 'http://x');
	const chainId = Number(url.searchParams.get('chain') || 8453);
	if (!SUPPORTED_CHAINS.includes(chainId)) {
		return error(res, 400, 'unsupported_chain',
			`chain ${chainId} not supported`, { supported: SUPPORTED_CHAINS });
	}
	const hasQuery = (url.searchParams.get('q') || '').trim().length > 0;
	const limit = hasQuery
		? Math.min(Math.max(Number(url.searchParams.get('limit')) || 10, 1), 20)
		: Math.min(Math.max(Number(url.searchParams.get('limit')) || 20, 1), 50);
	const skip = Math.max(Number(url.searchParams.get('skip')) || 0, 0);
	const q = (url.searchParams.get('q') || '').trim().slice(0, 200);

	const subgraphUrl = DEFAULT_SUBGRAPH_URLS[chainId];
	if (!subgraphUrl) {
		return error(res, 502, 'no_subgraph', `no subgraph configured for chain ${chainId}`);
	}

	// Build a simple where filter: only agents with a registration file.
	// Text search (q) is handled by name/description contains filters pushed to the subgraph.
	const where = { registrationFile_not: null };
	if (q) {
		// The Graph does not support OR across different fields in a single where clause
		// without the `or` operator (available in newer subgraph deployments). We push a
		// name contains filter as the primary signal; clients may supplement with
		// description-based filtering client-side for the small result set returned.
		where.registrationFile_ = { name_contains_nocase: q };
	}

	let rawAgents;
	let timedOut = false;
	try {
		rawAgents = await querySubgraph(subgraphUrl, {
			where,
			first: limit,
			skip,
			orderBy: 'updatedAt',
			orderDirection: 'desc',
		});
	} catch (e) {
		if (e?.name === 'AbortError') {
			timedOut = true;
			rawAgents = [];
		} else {
			return error(res, 502, 'subgraph_error', e?.message || 'subgraph query failed');
		}
	}

	const agents = (rawAgents || []).map((a) => {
		const rf = a.registrationFile;
		return {
			agentId: a.id || `${chainId}:${a.agentId}`,
			chainId: a.chainId ? Number(a.chainId) : chainId,
			address: a.agentWallet || null,
			owner: a.owner || null,
			name: rf?.name || a.id || null,
			description: rf?.description || null,
			image: rf?.image || null,
			registrationUri: a.agentURI || null,
			registeredAtSeconds: a.createdAt ? Number(a.createdAt) : null,
			updatedAtSeconds: a.updatedAt ? Number(a.updatedAt) : null,
			lastActivitySeconds: a.lastActivity ? Number(a.lastActivity) : null,
			feedbackCount: a.totalFeedback != null ? Number(a.totalFeedback) : null,
			active: rf?.active ?? null,
			x402support: rf?.x402Support ?? false,
			mcpEndpoint: rf?.mcpEndpoint || null,
			a2aEndpoint: rf?.a2aEndpoint || null,
			webEndpoint: rf?.webEndpoint || null,
			emailEndpoint: rf?.emailEndpoint || null,
			ens: rf?.ens || null,
			did: rf?.did || null,
			supportedTrusts: rf?.supportedTrusts || [],
			a2aSkills: rf?.a2aSkills || [],
			mcpTools: rf?.mcpTools || [],
		};
	});

	json(res, 200, {
		chainId,
		query: q || null,
		skip,
		count: agents.length,
		agents,
		...(timedOut ? { timed_out: true } : {}),
	}, { 'cache-control': timedOut ? 'no-store' : 'public, max-age=30, stale-while-revalidate=120' });
});
