// GET /api/x402/agent-reputation?agent_id=<uuid>
//
// Paid endpoint cataloged by the CDP x402 Bazaar. For $0.01 USDC the server
// returns a reputation snapshot for a three.ws agent: total USDC paid in
// to its pump-agent tokens, distinct payer wallets, deployed mint count,
// distribution success rate, and Solana attestation counts.
//
// Why this is defensible: three.ws indexes every pump.fun agent-payments
// acceptPayment call (pump_agent_payments), every distributePayments cron
// run (pump_distribute_runs), and every signed Solana memo attestation
// (solana_attestations) for agents that registered through us. No other
// service has this combined index, so reputation queries here are the
// canonical source for any AI agent vetting a three.ws-registered agent.

import { paidEndpoint } from '../_lib/x402-paid-endpoint.js';
import { buildBazaarSchema } from '../_lib/x402-spec.js';
import { installAccessControl } from '../_lib/x402/access-control.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';
import { sql } from '../_lib/db.js';
import { priceFor } from '../_lib/x402-prices.js';

const ROUTE = '/api/x402/agent-reputation';

const DESCRIPTION =
	'three.ws Agent Reputation — given a three.ws agent_id, return a reputation ' +
	'snapshot synthesized from on-chain pump.fun agent-payments activity, ' +
	'distribute/buyback success history, and signed Solana memo attestations. ' +
	'Use to vet a counterparty before paying, trading, or composing skills. ' +
	'Reputation is built from real on-chain data three.ws indexes — not a ' +
	'subjective score. Pay-per-call in USDC on Base or Solana mainnet.';

const INPUT_EXAMPLE = { agent_id: '7b9a4f30-2d11-4e2d-9d12-1cdb1f6a3a55' };

const INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['agent_id'],
	properties: {
		agent_id: {
			type: 'string',
			format: 'uuid',
			description: 'three.ws agent_id (UUID). Returned by /api/agents and /api/agent-page.',
		},
	},
};

const OUTPUT_EXAMPLE = {
	agent_id: '7b9a4f30-2d11-4e2d-9d12-1cdb1f6a3a55',
	name: 'Helios',
	wallet_address: 'BUrwd1nK6tFeeJMyzRHDo6AuVbnSfUULfvwq21X93nSN',
	deployed_mints: 2,
	mints: [
		{ mint: 'C3vQ...', network: 'mainnet', symbol: 'HELIO' },
		{ mint: 'F7kX...', network: 'mainnet', symbol: 'SUNUP' },
	],
	payments: {
		confirmed_count: 142,
		confirmed_amount_atomics: '142000000',
		distinct_payers: 87,
		failed_count: 3,
		failure_rate: 0.021,
	},
	distributions: {
		confirmed: 12,
		failed: 1,
		success_rate: 0.923,
	},
	buybacks: {
		confirmed: 5,
		failed: 0,
		total_burn_atomics: '500000000',
	},
	attestations: {
		feedback_count: 14,
		validation_count: 8,
		latest_attested_at: '2026-05-12T08:21:00Z',
	},
	indexed_at: '2026-05-14T17:00:00Z',
};

const OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['agent_id', 'deployed_mints', 'payments', 'distributions', 'buybacks', 'attestations'],
	properties: {
		agent_id: { type: 'string', format: 'uuid' },
		name: { type: ['string', 'null'] },
		wallet_address: { type: ['string', 'null'] },
		deployed_mints: { type: 'integer', minimum: 0 },
		mints: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					mint: { type: 'string' },
					network: { type: 'string' },
					symbol: { type: ['string', 'null'] },
				},
			},
		},
		payments: {
			type: 'object',
			properties: {
				confirmed_count: { type: 'integer' },
				confirmed_amount_atomics: { type: 'string' },
				distinct_payers: { type: 'integer' },
				failed_count: { type: 'integer' },
				failure_rate: { type: 'number' },
			},
		},
		distributions: {
			type: 'object',
			properties: {
				confirmed: { type: 'integer' },
				failed: { type: 'integer' },
				success_rate: { type: 'number' },
			},
		},
		buybacks: {
			type: 'object',
			properties: {
				confirmed: { type: 'integer' },
				failed: { type: 'integer' },
				total_burn_atomics: { type: 'string' },
			},
		},
		attestations: {
			type: 'object',
			properties: {
				feedback_count: { type: 'integer' },
				validation_count: { type: 'integer' },
				latest_attested_at: { type: ['string', 'null'] },
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

async function loadReputation(agentId) {
	// Resolve the agent's Metaplex Core asset pubkey (the column attestations
	// are indexed by). Canonical write path is meta.onchain.sol_asset; legacy
	// rows wrote meta.sol_mint_address. Without this, the attestation counts
	// would silently return 0 for any agent whose asset pubkey isn't equal to
	// their wallet — which is the typical case.
	const [agentRow] = await sql`
		select
			id,
			name,
			wallet_address,
			coalesce(meta->'onchain'->>'sol_asset', meta->>'sol_mint_address') as agent_asset
		  from agent_identities
		 where id = ${agentId} and deleted_at is null
		 limit 1
	`;
	if (!agentRow) {
		const err = new Error('agent_id not found');
		err.status = 404;
		err.code = 'agent_not_found';
		throw err;
	}

	const mints = await sql`
		select id, mint, network, symbol
		  from pump_agent_mints
		 where agent_id = ${agentId}
		 order by created_at asc
	`;
	const mintIds = mints.map((m) => m.id);

	if (mintIds.length === 0) {
		return {
			agent_id: agentId,
			name: agentRow.name,
			wallet_address: agentRow.wallet_address || null,
			deployed_mints: 0,
			mints: [],
			payments: {
				confirmed_count: 0,
				confirmed_amount_atomics: '0',
				distinct_payers: 0,
				failed_count: 0,
				failure_rate: 0,
			},
			distributions: { confirmed: 0, failed: 0, success_rate: 0 },
			buybacks: { confirmed: 0, failed: 0, total_burn_atomics: '0' },
			attestations: { feedback_count: 0, validation_count: 0, latest_attested_at: null },
			indexed_at: new Date().toISOString(),
		};
	}

	const [payRow] = await sql`
		select
			coalesce(sum(case when status = 'confirmed' then amount_atomics else 0 end), 0)::text
				as confirmed_amount,
			count(*) filter (where status = 'confirmed')::int as confirmed_count,
			count(*) filter (where status = 'failed')::int    as failed_count,
			count(distinct case when status = 'confirmed' then payer_wallet end)::int
				as distinct_payers
		  from pump_agent_payments
		 where mint_id = any(${mintIds})
	`;

	const [distRow] = await sql`
		select
			count(*) filter (where status = 'confirmed')::int as confirmed,
			count(*) filter (where status = 'failed')::int    as failed
		  from pump_distribute_runs
		 where mint_id = any(${mintIds})
	`;

	const [buyRow] = await sql`
		select
			count(*) filter (where status = 'confirmed')::int as confirmed,
			count(*) filter (where status = 'failed')::int    as failed,
			coalesce(sum(case when status = 'confirmed' then burn_amount else 0 end), 0)::text
				as total_burn
		  from pump_buyback_runs
		 where mint_id = any(${mintIds})
	`;

	const [attRow] = agentRow.agent_asset
		? await sql`
			select
				count(*) filter (where kind like 'threews.feedback%')::int   as feedback_count,
				count(*) filter (where kind like 'threews.validation%')::int as validation_count,
				max(block_time)                                              as latest_attested_at
			  from solana_attestations
			 where agent_asset = ${agentRow.agent_asset}
			   and revoked = false
		`
		: [{ feedback_count: 0, validation_count: 0, latest_attested_at: null }];

	const totalPayments = payRow.confirmed_count + payRow.failed_count;
	const totalDistribs = distRow.confirmed + distRow.failed;

	return {
		agent_id: agentId,
		name: agentRow.name,
		wallet_address: agentRow.wallet_address || null,
		deployed_mints: mints.length,
		mints: mints.map((m) => ({ mint: m.mint, network: m.network, symbol: m.symbol })),
		payments: {
			confirmed_count: payRow.confirmed_count,
			confirmed_amount_atomics: payRow.confirmed_amount,
			distinct_payers: payRow.distinct_payers,
			failed_count: payRow.failed_count,
			failure_rate: totalPayments ? payRow.failed_count / totalPayments : 0,
		},
		distributions: {
			confirmed: distRow.confirmed,
			failed: distRow.failed,
			success_rate: totalDistribs ? distRow.confirmed / totalDistribs : 0,
		},
		buybacks: {
			confirmed: buyRow.confirmed,
			failed: buyRow.failed,
			total_burn_atomics: buyRow.total_burn,
		},
		attestations: {
			feedback_count: attRow.feedback_count,
			validation_count: attRow.validation_count,
			latest_attested_at: attRow.latest_attested_at
				? new Date(attRow.latest_attested_at).toISOString()
				: null,
		},
		indexed_at: new Date().toISOString(),
	};
}

export default paidEndpoint({
	route: ROUTE,
	method: 'GET',
	priceAtomics: priceFor('agent-reputation', '10000'),
	networks: ['base', 'solana'],
	description: DESCRIPTION,
	bazaar: BAZAAR,
	service: withService({
		serviceName: 'three.ws Agent Reputation',
		tags: ['reputation', 'agent', 'solana', 'attestation', 'trust'],
	}),
	requiredScope: 'x402:bypass',
	accessControl: installAccessControl({ requiredScope: 'x402:bypass' }),
	// USE-21: declare auth-hints. Buyers with an OAuth2 access token granted
	// scope `read:agent-reputation` skip payment, as do wallets that present
	// a fresh CAIP-122 SIGN-IN-WITH-X proof for this resource. Without either,
	// the regular USDC accepts entries apply.
	authHints: {
		oauth2: { requiredScope: 'read:agent-reputation', tokenType: 'Bearer' },
		siwx: true,
	},
	async handler({ req }) {
		const agentId = String(req.query?.agent_id || '').trim().toLowerCase();
		if (!agentId) {
			const err = new Error('query param "agent_id" is required');
			err.status = 400;
			err.code = 'missing_agent_id';
			throw err;
		}
		if (!UUID_RE.test(agentId)) {
			const err = new Error('agent_id must be a UUID');
			err.status = 400;
			err.code = 'invalid_agent_id';
			throw err;
		}
		return loadReputation(agentId);
	},
});
