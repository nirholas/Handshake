import { sql } from '../../_lib/db.js';
import { crawlAgentAttestations, KIND_MAP } from '../../_lib/solana-attestations.js';
import { env } from '../../_lib/env.js';

async function ensureWarm({ asset, network }) {
	const [c] = await sql`select 1 from solana_attestations_cursor where agent_asset = ${asset} limit 1`;
	if (c) return;
	const [agent] = await sql`
		select wallet_address as owner from agent_identities
		where meta->>'sol_mint_address' = ${asset} and deleted_at is null limit 1
	`;
	try { await crawlAgentAttestations({ agentAsset: asset, network, ownerWallet: agent?.owner || null }); }
	catch { /* return cached (empty) */ }
}

// Exported so other paid surfaces (e.g. the persona identity/wallet tools) can
// reuse the SAME ERC-8004-style reputation computation instead of re-deriving
// it against a second copy of the attestation query.
export async function solanaReputation(asset, network) {
	await ensureWarm({ asset, network });
	const [fb] = await sql`
		with feedback as (
			select
				f.disputed, (f.payload->>'score')::int as score,
				exists (
					select 1 from solana_attestations a
					where a.agent_asset = f.agent_asset and a.kind='threews.accept.v1'
					  and a.payload->>'task_id' = f.payload->>'task_id'
					  and a.verified = true and f.payload->>'task_id' is not null
				) as task_accepted
			from solana_attestations f
			where f.agent_asset=${asset} and f.network=${network}
			  and f.kind='threews.feedback.v1' and f.revoked=false
		)
		select count(*)::int total,
			count(*) filter (where task_accepted)::int verified,
			count(*) filter (where disputed)::int disputed,
			coalesce(avg(score),0)::float score_avg,
			coalesce(avg(score) filter (where task_accepted),0)::float score_avg_verified
		from feedback
	`;
	const [val] = await sql`
		select count(*) filter (where (payload->>'passed')::bool)::int passed,
			count(*) filter (where not (payload->>'passed')::bool)::int failed
		from solana_attestations
		where agent_asset=${asset} and network=${network}
		  and kind='threews.validation.v1' and revoked=false
	`;
	return {
		agent: asset, network,
		feedback: { ...fb,
			score_avg: Number(fb.score_avg.toFixed(3)),
			score_avg_verified: Number(fb.score_avg_verified.toFixed(3)) },
		validation: val,
	};
}

async function solanaAttestations({ asset, kind, network, limit }) {
	await ensureWarm({ asset, network });
	const wantKind = kind === 'all' ? null : KIND_MAP[kind];
	const rows = wantKind
		? await sql`
			select signature, slot, block_time, attester, kind, payload, verified, revoked, disputed
			from solana_attestations
			where agent_asset=${asset} and network=${network} and kind=${wantKind} and revoked=false
			order by slot desc limit ${limit}
		`
		: await sql`
			select signature, slot, block_time, attester, kind, payload, verified, revoked, disputed
			from solana_attestations
			where agent_asset=${asset} and network=${network} and revoked=false
			order by slot desc limit ${limit}
		`;
	return { agent: asset, network, kind, count: rows.length, data: rows };
}

async function solanaPassport(asset, network) {
	const [agent] = await sql`
		select id, name, description, wallet_address as owner, meta
		from agent_identities
		where meta->>'sol_mint_address' = ${asset} and deleted_at is null limit 1
	`;
	const reputation = await solanaReputation(asset, network);
	const recent = await solanaAttestations({ asset, kind: 'all', network, limit: 10 });
	return {
		agent: asset,
		identity: agent ? {
			id: agent.id, name: agent.name, description: agent.description,
			owner: agent.owner, asset_pubkey: asset,
			network: agent.meta?.network || network,
		} : { agent_off_index: true, asset_pubkey: asset, network },
		reputation: reputation.feedback,
		validation: reputation.validation,
		recent_attestations: recent.data,
		schemas_url: `${env.APP_ORIGIN}/.well-known/agent-attestation-schemas`,
	};
}

// MCP tool annotations (2025-06-18 spec): public, read-only views over the
// live on-chain attestation index. New attestations land between calls, so
// not idempotent. destructiveHint defaults to TRUE when omitted, so it is set
// explicitly.
const ATTESTATION_READ_ANNOTATIONS = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: false,
	openWorldHint: true,
};

export const toolDefs = [
	{
		name: 'solana_agent_reputation',
		title: 'Get Solana agent reputation',
		annotations: ATTESTATION_READ_ANNOTATIONS,
		description:
			'Computed reputation summary for a Solana-registered three.ws agent. Returns total/verified feedback counts, score averages (raw + verified-only), validation pass/fail, task acceptance, and dispute counts. Verified score only includes feedback whose task was acknowledged on-chain by the agent owner. Priced at $0.001 USDC/call via x402 (pay-per-call; an OAuth bearer token bypasses payment).',
		inputSchema: {
			type: 'object',
			properties: {
				asset: { type: 'string', description: 'Metaplex Core asset pubkey (the agent ID)' },
				network: { type: 'string', enum: ['mainnet', 'devnet'], default: 'devnet' },
			},
			required: ['asset'],
			additionalProperties: false,
		},
		async handler(args) {
			const data = await solanaReputation(args.asset, args.network || 'devnet');
			return {
				content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
				structuredContent: data,
			};
		},
	},
	{
		name: 'solana_agent_attestations',
		title: 'List Solana agent attestations',
		annotations: ATTESTATION_READ_ANNOTATIONS,
		description:
			'List recent on-chain attestations about a Solana-registered agent (feedback, validation, task offers, acceptances, disputes). Backed by the three.ws indexer for sub-100ms reads. Each row includes verified/disputed/revoked flags. Public; no auth required.',
		inputSchema: {
			type: 'object',
			properties: {
				asset: { type: 'string' },
				kind: {
					type: 'string',
					enum: ['feedback', 'validation', 'task', 'accept', 'revoke', 'dispute', 'all'],
					default: 'all',
				},
				network: { type: 'string', enum: ['mainnet', 'devnet'], default: 'devnet' },
				limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
			},
			required: ['asset'],
			additionalProperties: false,
		},
		async handler(args) {
			const data = await solanaAttestations({
				asset:   args.asset,
				kind:    args.kind || 'all',
				network: args.network || 'devnet',
				limit:   args.limit || 50,
			});
			return {
				content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
				structuredContent: data,
			};
		},
	},
	{
		name: 'solana_agent_passport',
		title: 'Get Solana agent passport',
		annotations: ATTESTATION_READ_ANNOTATIONS,
		description:
			'Full discovery card for a Solana agent: identity (Metaplex Core asset), owner wallet, reputation summary, latest validation result, and attestation schema endpoint. Equivalent to an ERC-8004 passport. Use this when one tool call should answer "who is this agent and can I trust them?".',
		inputSchema: {
			type: 'object',
			properties: {
				asset: { type: 'string' },
				network: { type: 'string', enum: ['mainnet', 'devnet'], default: 'devnet' },
			},
			required: ['asset'],
			additionalProperties: false,
		},
		async handler(args) {
			const data = await solanaPassport(args.asset, args.network || 'devnet');
			return {
				content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
				structuredContent: data,
			};
		},
	},
];
