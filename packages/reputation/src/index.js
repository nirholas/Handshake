// @three-ws/reputation — read ERC-8004 agent trust scores and attest
// agent-to-agent feedback on-chain, in one import. Zero runtime deps: every
// on-chain read/write is done server-side by the three.ws platform endpoints
// this client wraps (the same registries the `agent_reputation` MCP tool reads),
// so callers never stand up an ethers/web3 provider themselves. See README.md.

import { createHttp, ThreeWsError } from './http.js';

export { ThreeWsError, PaymentRequiredError, DEFAULT_BASE_URL } from './http.js';

/**
 * Chains where the ERC-8004 Identity Registry is deployed, mirrored verbatim
 * from api/_lib/erc8004-chains.js (CREATE2-deterministic: one mainnet address,
 * one testnet address). The frozen source of truth for chain → id resolution.
 */
export const SUPPORTED_CHAINS = Object.freeze([
	{ id: 8453, name: 'Base', testnet: false, explorer: 'https://basescan.org' },
	{ id: 42161, name: 'Arbitrum One', testnet: false, explorer: 'https://arbiscan.io' },
	{ id: 56, name: 'BNB Chain', testnet: false, explorer: 'https://bscscan.com' },
	{ id: 1, name: 'Ethereum', testnet: false, explorer: 'https://etherscan.io' },
	{ id: 10, name: 'Optimism', testnet: false, explorer: 'https://optimistic.etherscan.io' },
	{ id: 137, name: 'Polygon', testnet: false, explorer: 'https://polygonscan.com' },
	{ id: 43114, name: 'Avalanche', testnet: false, explorer: 'https://snowtrace.io' },
	{ id: 100, name: 'Gnosis', testnet: false, explorer: 'https://gnosisscan.io' },
	{ id: 250, name: 'Fantom', testnet: false, explorer: 'https://ftmscan.com' },
	{ id: 42220, name: 'Celo', testnet: false, explorer: 'https://celoscan.io' },
	{ id: 59144, name: 'Linea', testnet: false, explorer: 'https://lineascan.build' },
	{ id: 534352, name: 'Scroll', testnet: false, explorer: 'https://scrollscan.com' },
	{ id: 5000, name: 'Mantle', testnet: false, explorer: 'https://explorer.mantle.xyz' },
	{ id: 324, name: 'zkSync Era', testnet: false, explorer: 'https://explorer.zksync.io' },
	{ id: 1284, name: 'Moonbeam', testnet: false, explorer: 'https://moonbeam.moonscan.io' },
	{ id: 97, name: 'BSC Testnet', testnet: true, explorer: 'https://testnet.bscscan.com' },
	{ id: 84532, name: 'Base Sepolia', testnet: true, explorer: 'https://sepolia.basescan.org' },
	{ id: 421614, name: 'Arbitrum Sepolia', testnet: true, explorer: 'https://sepolia.arbiscan.io' },
	{ id: 11155111, name: 'Ethereum Sepolia', testnet: true, explorer: 'https://sepolia.etherscan.io' },
	{ id: 11155420, name: 'Optimism Sepolia', testnet: true, explorer: 'https://sepolia-optimism.etherscan.io' },
	{ id: 80002, name: 'Polygon Amoy', testnet: true, explorer: 'https://amoy.polygonscan.com' },
	{ id: 43113, name: 'Avalanche Fuji', testnet: true, explorer: 'https://testnet.snowtrace.io' },
]);

// chainId + lowercased name → chain record, for resolving the `chain` option.
const CHAIN_INDEX = (() => {
	const m = new Map();
	const byId = (id) => SUPPORTED_CHAINS.find((c) => c.id === id) || null;
	for (const c of SUPPORTED_CHAINS) {
		m.set(c.id, c);
		m.set(String(c.id), c);
		m.set(c.name.toLowerCase(), c);
		// First word of the name as a short alias (e.g. "base", "arbitrum").
		// Mainnet is listed first, so don't let a later testnet ("Base Sepolia")
		// steal the bare alias from its mainnet ("Base").
		const short = c.name.toLowerCase().split(' ')[0];
		if (!m.has(short)) m.set(short, c);
	}
	// Extra aliases callers reach for.
	m.set('eth', byId(1));
	m.set('bnb', byId(56));
	m.set('bsc', byId(56));
	return m;
})();

/** Resolve a chain name / id to its canonical record, or throw `unsupported_chain`. */
function resolveChain(chain) {
	if (chain === undefined || chain === null || chain === '') return CHAIN_INDEX.get(8453);
	const key = typeof chain === 'number' ? chain : String(chain).trim().toLowerCase();
	const found = CHAIN_INDEX.get(key);
	if (!found) {
		throw new ThreeWsError(`Unsupported chain "${chain}". See SUPPORTED_CHAINS.`, { code: 'unsupported_chain' });
	}
	return found;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const AGENT_ID_RE = /^\d{1,78}$/;
const ATTEST_KINDS = ['feedback', 'validation', 'task'];

/**
 * Create a Reputation client bound to a base URL, fetch, and optional auth.
 * Reads are auth-free and walletless; `attest()` needs a session cookie or an
 * `avatars:write`-scoped bearer (pass it as `apiKey`). For most callers the
 * default exports (`reputation()`, `leaderboard()`, `attest()`) are enough; use
 * this to reuse configuration (a custom origin, a payment-aware fetch) across
 * many calls.
 */
export function createReputation(options = {}) {
	const request = createHttp(options);

	/**
	 * Read an agent's on-chain reputation.
	 *
	 * `agent` accepts a three.ws agent UUID (the platform wallet-trust score from
	 * GET /api/agents/{id}/reputation) or a Solana asset/mint base58 address (the
	 * on-chain attestation aggregate from GET /api/agents/solana-reputation). The
	 * shape is normalised across both so a caller can render one trust block.
	 */
	async function reputation(agent, opts = {}) {
		const id = typeof agent === 'string' ? agent.trim() : String(agent ?? '').trim();
		if (!id) throw new ThreeWsError('reputation() needs an agent id (UUID) or Solana asset address.', { code: 'invalid_input' });

		if (UUID_RE.test(id)) {
			const res = await request(`/api/agents/${encodeURIComponent(id.toLowerCase())}/reputation`, { signal: opts.signal });
			return shapeWalletReputation(res);
		}
		if (BASE58_RE.test(id)) {
			const network = normalizeNetwork(opts.network);
			const res = await request('/api/agents/solana-reputation', { query: { asset: id, network }, signal: opts.signal });
			return shapeSolanaReputation(res);
		}
		throw new ThreeWsError('reputation() agent must be a three.ws agent UUID or a Solana asset (base58) address.', { code: 'invalid_input' });
	}

	/**
	 * Fetch the platform's live ranking of trusted agents
	 * (GET /api/reputation/leaderboard). Every rank is the same non-gameable
	 * wallet-trust score the badge shows.
	 */
	async function leaderboard(opts = {}) {
		const limit = opts.limit === undefined ? undefined : clampLimit(opts.limit);
		const res = await request('/api/reputation/leaderboard', { query: { limit }, signal: opts.signal });
		return {
			generatedAt: res?.generated_at ?? null,
			count: res?.count ?? 0,
			scored: res?.scored ?? 0,
			agents: Array.isArray(res?.agents) ? res.agents.map(shapeLeaderboardAgent) : [],
			raw: res,
		};
	}

	/**
	 * Read the latest on-chain ERC-8004 validation attestation for an agent
	 * (GET /api/erc8004/validation) — the walletless identity-bearing read that
	 * powers the "Validated" badge. `chain` selects the network.
	 */
	async function validation(chainId, agentId, opts = {}) {
		const chain = resolveChain(opts.chain ?? chainId);
		const id = String(agentId ?? '').trim();
		if (!AGENT_ID_RE.test(id)) {
			throw new ThreeWsError('validation() needs a non-negative integer agentId.', { code: 'invalid_input' });
		}
		const res = await request('/api/erc8004/validation', { query: { chainId: chain.id, agentId: id }, signal: opts.signal });
		return shapeValidationRead(res?.validation, chain);
	}

	/**
	 * Record an agent-to-agent attestation on-chain through the platform's signed
	 * attestation lane. Two real lanes back this, picked by the target:
	 *   • EVM (chainId + uint agentId)  → POST /api/erc8004/validate
	 *   • Solana (base58 asset address) → POST /api/agents/solana-validate
	 * Both run the agent's GLB through the platform validator and record a signed
	 * attestation; a retry re-records, idempotent on the lane's own dedupe key.
	 * Requires a session or an `avatars:write`-scoped token (pass it as apiKey).
	 */
	async function attest(input = {}) {
		const kind = input.kind ?? 'validation';
		if (!ATTEST_KINDS.includes(kind)) {
			throw new ThreeWsError(`Invalid kind "${kind}". Expected one of: ${ATTEST_KINDS.join(', ')}.`, { code: 'invalid_input' });
		}
		const agent = typeof input.agent === 'string' ? input.agent.trim() : '';
		if (!agent) throw new ThreeWsError('attest() needs a target `agent` (Solana asset or EVM agentId).', { code: 'invalid_input' });

		// Solana asset target → Solana validation lane.
		if (BASE58_RE.test(agent)) {
			const body = prune({
				asset_pubkey: agent,
				network: normalizeNetwork(input.network),
				glb_url: input.glbUrl,
			});
			const res = await request('/api/agents/solana-validate', { method: 'POST', body, signal: input.signal });
			return shapeAttestReceipt(res, 'solana');
		}

		// EVM target → ERC-8004 validation lane. Requires a chain.
		if (AGENT_ID_RE.test(agent)) {
			const chain = resolveChain(input.chain);
			const body = prune({
				chainId: chain.id,
				agentId: agent,
				glbUrl: input.glbUrl,
			});
			const res = await request('/api/erc8004/validate', { method: 'POST', body, signal: input.signal });
			return shapeAttestReceipt(res, 'evm');
		}

		throw new ThreeWsError('attest() `agent` must be a Solana asset (base58) or a uint ERC-8004 agentId.', { code: 'invalid_input' });
	}

	return { reputation, leaderboard, validation, attest };
}

// A module-level default client for the zero-config path: `import { reputation }`.
let shared = null;
function defaultClient() {
	return (shared ||= createReputation());
}

/** Read an agent's on-chain reputation by UUID or Solana asset address. */
export function reputation(agent, opts) {
	return defaultClient().reputation(agent, opts);
}
/** Fetch the platform's live leaderboard of trusted agents. */
export function leaderboard(opts) {
	return defaultClient().leaderboard(opts);
}
/** Read the latest on-chain ERC-8004 validation attestation for an agent. */
export function validation(chainId, agentId, opts) {
	return defaultClient().validation(chainId, agentId, opts);
}
/** Record a signed agent-to-agent attestation on-chain. */
export function attest(input) {
	return defaultClient().attest(input);
}

// ── shapers: snake_case platform JSON → camelCase, with a `.raw` escape hatch ──

function shapeWalletReputation(res) {
	if (!res || typeof res !== 'object') {
		throw new ThreeWsError('Unexpected empty response from the reputation endpoint.', { code: 'bad_response' });
	}
	return {
		kind: 'wallet',
		agentId: res.agent_id ?? null,
		name: res.name ?? null,
		score: res.score ?? null,
		max: res.max ?? null,
		tier: res.tier ?? null,
		tierLabel: res.tierLabel ?? null,
		accent: res.accent ?? null,
		isNew: Boolean(res.isNew),
		totals: res.totals ?? null,
		evidence: res.evidence ?? null,
		isOwner: Boolean(res.is_owner),
		computedAt: res.computed_at ?? null,
		partial: Boolean(res.partial),
		raw: res,
	};
}

function shapeSolanaReputation(res) {
	if (!res || typeof res !== 'object') {
		throw new ThreeWsError('Unexpected empty response from the reputation endpoint.', { code: 'bad_response' });
	}
	const fb = res.feedback || {};
	return {
		kind: 'solana',
		agent: res.agent ?? null,
		network: res.network ?? null,
		feedback: {
			total: fb.total ?? 0,
			verified: fb.verified ?? 0,
			credentialed: fb.credentialed ?? 0,
			eventAttested: fb.event_attested ?? 0,
			disputed: fb.disputed ?? 0,
			uniqueAttesters: fb.unique_attesters ?? 0,
			uniqueVerifiedAttesters: fb.unique_verified_attesters ?? 0,
			scoreAvg: fb.score_avg ?? null,
			scoreAvgVerified: fb.score_avg_verified ?? null,
			scoreAvgWeighted: fb.score_avg_weighted ?? null,
		},
		validation: res.validation ?? null,
		tasks: res.tasks ?? null,
		stake: shapeStake(res.stake),
		disputesFiled: res.disputes_filed ?? 0,
		revokedCount: res.revoked_count ?? 0,
		tokenActivity: res.token_activity ?? null,
		pumpPayments: res.pump_payments ?? null,
		lastIndexedAt: res.last_indexed_at ?? null,
		raw: res,
	};
}

function shapeStake(stake) {
	if (!stake || typeof stake !== 'object') return { totalLamports: '0', count: 0, uniqueStakers: 0, topStakers: [] };
	return {
		totalLamports: stake.total_lamports ?? '0',
		count: stake.count ?? 0,
		uniqueStakers: stake.unique_stakers ?? 0,
		topStakers: Array.isArray(stake.top_stakers)
			? stake.top_stakers.map((s) => ({ attester: s.attester ?? null, lamports: s.lamports ?? '0', score: s.score ?? null }))
			: [],
	};
}

function shapeLeaderboardAgent(a) {
	return {
		rank: a.rank ?? null,
		id: a.id ?? null,
		name: a.name ?? null,
		avatarThumbnailUrl: a.avatar_thumbnail_url ?? null,
		solanaAddress: a.solana_address ?? null,
		score: a.score ?? null,
		tier: a.tier ?? null,
		tierLabel: a.tier_label ?? null,
		totals: a.totals ?? null,
		agentUrl: a.agent_url ?? null,
		breakdownUrl: a.breakdown_url ?? null,
		raw: a,
	};
}

function shapeValidationRead(v, chain) {
	if (!v || typeof v !== 'object') {
		return { chain: chain.name, chainId: chain.id, exists: false, available: false, raw: v ?? null };
	}
	return {
		chain: chain.name,
		chainId: v.chainId ?? chain.id,
		agentId: v.agentId ?? null,
		kind: v.kind ?? null,
		registry: v.registry ?? null,
		available: Boolean(v.available),
		exists: Boolean(v.exists),
		passed: v.exists ? Boolean(v.passed) : null,
		proofHash: v.proofHash ?? null,
		proofURI: v.proofURI ?? null,
		proofUrlResolved: v.proofUrlResolved ?? null,
		validator: v.validator ?? null,
		validatorExplorer: v.validatorExplorer ?? null,
		validatedAt: v.validatedAt ?? null,
		reason: v.reason ?? null,
		raw: v,
	};
}

function shapeAttestReceipt(res, lane) {
	if (!res || typeof res !== 'object') {
		throw new ThreeWsError('Unexpected empty response from the attestation endpoint.', { code: 'bad_response' });
	}
	if (lane === 'evm') {
		const val = res.validation || {};
		return {
			lane: 'evm',
			status: 'minted',
			ok: Boolean(res.ok),
			passed: val.passed ?? null,
			kind: val.kind ?? null,
			signature: val.txHash ?? null,
			txExplorer: val.txExplorer ?? null,
			proofHash: val.proofHash ?? null,
			proofURI: val.proofURI ?? null,
			validator: val.validator ?? null,
			chainId: val.chainId ?? null,
			agentId: val.agentId ?? null,
			validatedAt: val.validatedAt ?? null,
			raw: res,
		};
	}
	// Solana lane.
	return {
		lane: 'solana',
		status: res.deduped ? 'deduped' : 'minted',
		ok: Boolean(res.ok),
		passed: res.passed ?? null,
		kind: res.kind ?? null,
		signature: res.signature ?? null,
		txExplorer: res.explorer ?? null,
		proofHash: res.proof_hash ?? null,
		proofURI: res.proof_uri ?? null,
		validator: res.validator ?? null,
		network: res.network ?? null,
		asset: res.asset_pubkey ?? null,
		deduped: Boolean(res.deduped),
		raw: res,
	};
}

function normalizeNetwork(network) {
	return network === 'mainnet' ? 'mainnet' : network === 'devnet' ? 'devnet' : 'mainnet';
}

function clampLimit(limit) {
	const n = Number(limit);
	if (!Number.isFinite(n)) {
		throw new ThreeWsError('leaderboard() limit must be a number between 1 and 50.', { code: 'invalid_input' });
	}
	return Math.min(50, Math.max(1, Math.trunc(n)));
}

function prune(obj) {
	const out = {};
	for (const [k, v] of Object.entries(obj)) {
		if (v === undefined || v === null) continue;
		out[k] = v;
	}
	return out;
}
