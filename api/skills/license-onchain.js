/**
 * GET /api/skills/license-onchain
 * --------------------------------------------------------------------------
 * Trustless, database-free verification of skill ownership: does a wallet hold
 * an active on-chain `SkillLicense` for a given skill on a given agent? Reads
 * the license PDA directly from the `skill_license` Solana program (see
 * contracts/skill-license/) and reports ownership. This is the *alternative*
 * access check described in the on-chain-licenses design. Anyone can call it,
 * no auth required, because it only reads public chain state.
 *
 * Query (one of agent_mint | agent_id required, plus skill + wallet):
 *   wallet      base58 Solana pubkey of the holder            (required)
 *   skill       skill name/slug                               (required)
 *   agent_mint  the agent's on-chain grouping mint (base58)
 *   agent_id    three.ws agent uuid; resolves to that agent's skill collection mint
 *   network     'mainnet' (default) | 'devnet'
 *
 * Response: { data: { owned, exists, revoked, deployed, license, nft_mint,
 *                     owner_token_account, program_id, network, explorer, record } }
 */

import { PublicKey } from '@solana/web3.js';

import { sql } from '../_lib/db.js';
import { cors, error, json, method, wrap, rateLimited, serverError } from '../_lib/http.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { isUuid } from '../_lib/validate.js';
import {
	SKILL_LICENSE_PROGRAM_ID,
	verifyOnchainSkillLicense,
} from '../_lib/skill-license-onchain.js';

/**
 * A base58 charset test is not enough here: a 42-character string passes it but
 * decodes to 31 bytes, which `new PublicKey()` rejects deep inside the PDA
 * derivation. That surfaced as a 502 `rpc_error` ("internal error") for what is
 * plainly a caller mistake, so check the real thing at the boundary and answer
 * 400 instead.
 */
function isPubkey(value) {
	try {
		new PublicKey(value);
		return true;
	} catch {
		return false;
	}
}

function explorerForLicense(license, network) {
	const cluster = network === 'devnet' ? '?cluster=devnet' : '';
	return `https://explorer.solana.com/address/${license}${cluster}`;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.widgetRead(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://x');
	const wallet = (url.searchParams.get('wallet') || '').trim();
	const skill = (url.searchParams.get('skill') || '').trim();
	const agentMintParam = (url.searchParams.get('agent_mint') || '').trim();
	const agentId = (url.searchParams.get('agent_id') || '').trim();
	const network = url.searchParams.get('network') === 'devnet' ? 'devnet' : 'mainnet';

	if (!isPubkey(wallet)) {
		return error(res, 400, 'validation_error', 'wallet must be a Solana address');
	}
	if (!skill || skill.length > 100) {
		return error(res, 400, 'validation_error', 'skill is required (≤100 chars)');
	}

	// Resolve the agent grouping mint: explicit agent_mint, or the agent's
	// per-agent skill collection mint looked up from its uuid.
	let agentMint = agentMintParam;
	if (!agentMint && agentId) {
		if (!isUuid(agentId)) {
			return error(res, 400, 'validation_error', 'agent_id must be a uuid');
		}
		const [agent] = await sql`
			SELECT skill_collection_mint
			FROM agent_identities
			WHERE id = ${agentId} AND deleted_at IS NULL
		`;
		if (!agent) return error(res, 404, 'not_found', 'agent not found');
		if (!agent.skill_collection_mint) {
			return error(
				res,
				409,
				'no_collection',
				'agent has no on-chain skill collection yet; nothing can be licensed on-chain',
			);
		}
		agentMint = agent.skill_collection_mint;
	}
	if (!isPubkey(agentMint)) {
		return error(
			res,
			400,
			'validation_error',
			'agent_mint (a Solana address) or agent_id is required',
		);
	}

	let result;
	try {
		result = await verifyOnchainSkillLicense({ ownerWallet: wallet, agentMint, skill, network });
	} catch (e) {
		console.error('[skills/license-onchain] read failed', e?.message);
		return serverError(res, 502, 'rpc_error', e);
	}

	return json(
		res,
		200,
		{
			data: {
				owned: result.owned,
				exists: result.exists,
				revoked: result.revoked,
				deployed: result.deployed,
				license: result.license,
				nft_mint: result.nftMint,
				owner_token_account: result.ownerTokenAccount,
				program_id: SKILL_LICENSE_PROGRAM_ID,
				agent_mint: agentMint,
				skill,
				wallet,
				network,
				explorer: explorerForLicense(result.license, network),
				record: result.record,
			},
		},
		{ 'cache-control': 'public, max-age=10' },
	);
});
