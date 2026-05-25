// GET /api/x402/onchain-identity-verify?agent_id=<uuid>&chain=<caip2>&contract_or_mint=<addr>
//
// Paid endpoint cataloged by the CDP x402 Bazaar. For $0.005 USDC the server
// returns a verdict on the claim "agent X owns mint/contract Y on chain Z" by
// looking it up in three.ws's unified meta.onchain index. Returns the on-chain
// evidence (tx hash, deploy time, wallet) when the claim verifies.
//
// Why this is defensible: three.ws maintains a single unified jsonb index
// (agent_identities.meta.onchain) across Solana SPL mints, ERC-8004 EVM
// registries, and any future chain family — backed by deploy-time webhooks
// from three.ws's own /api/agents/onchain/confirm pipeline. AI agents pay
// to verify counterparty identity claims as a trust primitive: "does this
// agent really own the contract it claims?"

import { paidEndpoint } from '../_lib/x402-paid-endpoint.js';
import { buildBazaarSchema } from '../_lib/x402-spec.js';
import { installAccessControl } from '../_lib/x402/access-control.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';
import { sql } from '../_lib/db.js';
import { priceFor } from '../_lib/x402-prices.js';

const ROUTE = '/api/x402/onchain-identity-verify';

const DESCRIPTION =
	'three.ws On-Chain Identity Verifier — given a three.ws agent_id, a CAIP-2 ' +
	'chain ID, and a contract or mint address, verify whether the agent actually ' +
	'owns/deployed that address using the canonical meta.onchain unified index. ' +
	'Returns evidence (tx hash, wallet, deploy time, metadata URI) when verified. ' +
	'Use as a trust primitive before paying or trading with a counterparty agent.';

const INPUT_EXAMPLE = {
	agent_id: '7b9a4f30-2d11-4e2d-9d12-1cdb1f6a3a55',
	chain: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
	contract_or_mint: 'C3vQABCDEFGHJKLMNopqrstuvwxyZ12345abcdefghi',
};

const INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['agent_id', 'chain', 'contract_or_mint'],
	properties: {
		agent_id: { type: 'string', format: 'uuid' },
		chain: {
			type: 'string',
			description:
				'CAIP-2 chain ID. Examples: solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp, eip155:8453.',
		},
		contract_or_mint: {
			type: 'string',
			description: 'SPL mint pubkey (base58) or EVM contract address (0x…).',
		},
	},
};

const OUTPUT_EXAMPLE = {
	agent_id: '7b9a4f30-2d11-4e2d-9d12-1cdb1f6a3a55',
	chain: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
	contract_or_mint: 'C3vQABCDEFGHJKLMNopqrstuvwxyZ12345abcdefghi',
	verified: true,
	evidence: {
		family: 'solana',
		tx_hash: '4kHTPp9...',
		wallet: 'BUrwd1nK6tFeeJMyzRHDo6AuVbnSfUULfvwq21X93nSN',
		metadata_uri: 'https://arweave.net/...',
		confirmed_at: '2026-04-30T14:08:22Z',
	},
	indexed_at: '2026-05-14T17:00:00Z',
};

const OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['agent_id', 'chain', 'contract_or_mint', 'verified'],
	properties: {
		agent_id: { type: 'string', format: 'uuid' },
		chain: { type: 'string' },
		contract_or_mint: { type: 'string' },
		verified: { type: 'boolean' },
		evidence: {
			type: ['object', 'null'],
			properties: {
				family: { type: 'string', enum: ['solana', 'evm'] },
				tx_hash: { type: ['string', 'null'] },
				wallet: { type: ['string', 'null'] },
				metadata_uri: { type: ['string', 'null'] },
				confirmed_at: { type: ['string', 'null'] },
			},
		},
		indexed_at: { type: 'string', format: 'date-time' },
	},
};

const BAZAAR = {
	discoverable: true,
	info: {
		input: {
			type: 'http',
			method: 'GET',
			queryParams: INPUT_EXAMPLE,
		},
		output: { type: 'json', example: OUTPUT_EXAMPLE },
	},
	schema: buildBazaarSchema({
		method: 'GET',
		queryParamsSchema: INPUT_SCHEMA,
		outputSchema: OUTPUT_SCHEMA,
	}),
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CAIP2_RE = /^[a-z0-9-]{3,}:[a-zA-Z0-9]{1,64}$/;

function normalizeAddress(addr, chain) {
	if (chain.startsWith('eip155:')) return addr.toLowerCase();
	return addr;
}

async function verifyIdentity({ agentId, chain, address }) {
	const normalized = normalizeAddress(address, chain);
	const [row] = await sql`
		select
			(meta->'onchain'->>'family')           as family,
			(meta->'onchain'->>'chain')            as chain,
			(meta->'onchain'->>'contract_or_mint') as contract_or_mint,
			(meta->'onchain'->>'tx_hash')          as tx_hash,
			(meta->'onchain'->>'wallet')           as wallet,
			(meta->'onchain'->>'metadata_uri')     as metadata_uri,
			(meta->'onchain'->>'confirmed_at')     as confirmed_at
		  from agent_identities
		 where id = ${agentId}
		   and deleted_at is null
		   and meta ? 'onchain'
		   and (meta->'onchain'->>'chain') = ${chain}
		 limit 1
	`;

	if (!row) {
		return {
			agent_id: agentId,
			chain,
			contract_or_mint: address,
			verified: false,
			evidence: null,
			indexed_at: new Date().toISOString(),
		};
	}

	const indexedAddr = normalizeAddress(row.contract_or_mint || '', chain);
	const verified = indexedAddr === normalized;

	return {
		agent_id: agentId,
		chain,
		contract_or_mint: address,
		verified,
		evidence: verified
			? {
				family: row.family,
				tx_hash: row.tx_hash || null,
				wallet: row.wallet || null,
				metadata_uri: row.metadata_uri || null,
				confirmed_at: row.confirmed_at || null,
			}
			: null,
		indexed_at: new Date().toISOString(),
	};
}

export default paidEndpoint({
	route: ROUTE,
	method: 'GET',
	priceAtomics: priceFor('onchain-identity-verify', '5000'),
	networks: ['base', 'solana'],
	description: DESCRIPTION,
	bazaar: BAZAAR,
	service: withService({
		serviceName: 'three.ws Identity Verify',
		tags: ['identity', 'verification', 'agent', 'trust', 'onchain'],
	}),
	requiredScope: 'x402:bypass',
	accessControl: installAccessControl({ requiredScope: 'x402:bypass' }),
	async handler({ req }) {
		const agentId = String(req.query?.agent_id || '').trim().toLowerCase();
		const chain = String(req.query?.chain || '').trim();
		const address = String(req.query?.contract_or_mint || '').trim();
		if (!agentId || !chain || !address) {
			const err = new Error('query params agent_id, chain, contract_or_mint are required');
			err.status = 400;
			err.code = 'missing_params';
			throw err;
		}
		if (!UUID_RE.test(agentId)) {
			const err = new Error('agent_id must be a UUID');
			err.status = 400;
			err.code = 'invalid_agent_id';
			throw err;
		}
		if (!CAIP2_RE.test(chain)) {
			const err = new Error('chain must be a CAIP-2 ID (e.g. eip155:8453 or solana:5eykt4Us...)');
			err.status = 400;
			err.code = 'invalid_chain';
			throw err;
		}
		return verifyIdentity({ agentId, chain, address });
	},
});
