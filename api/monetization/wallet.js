// GET /api/monetization/wallet?agent_id=X  — get payout wallet config
// PUT /api/monetization/wallet              — set/update payout addresses
//
// Body (PUT): { agent_id, evm_address?, solana_address?, preferred_network? }

import { z } from 'zod';
import { sql } from '../_lib/db.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { cors, json, method, wrap, error, readJson } from '../_lib/http.js';
import { parse, isValidSolanaAddress, isValidEvmAddress } from '../_lib/validate.js';
import { limits, clientIp } from '../_lib/rate-limit.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const putBody = z.object({
	agent_id: z.string().uuid(),
	evm_address: z.string().trim().max(100).nullable().optional(),
	solana_address: z.string().trim().max(100).nullable().optional(),
	preferred_network: z.enum(['solana', 'base', 'evm']).default('solana'),
});

async function resolveUserId(req) {
	const session = await getSessionUser(req);
	if (session) return session.id;
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return bearer.userId;
	return null;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,PUT,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'PUT'])) return;

	const userId = await resolveUserId(req);
	if (!userId) return error(res, 401, 'unauthorized', 'Sign in required');

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	if (req.method === 'GET') {
		const params = new URL(req.url, 'http://x').searchParams;
		const agentId = params.get('agent_id');

		if (agentId && !UUID_RE.test(agentId)) {
			return error(res, 400, 'validation_error', 'agent_id must be a UUID');
		}

		// Verify ownership if agent_id specified
		if (agentId) {
			const [agent] = await sql`
				SELECT id, user_id FROM agent_identities
				WHERE id = ${agentId} AND deleted_at IS NULL
			`;
			if (!agent) return error(res, 404, 'not_found', 'Agent not found');
			if (agent.user_id !== userId) return error(res, 403, 'forbidden', 'You don\'t own this agent');
		}

		// Fetch all wallets for the user, optionally filtered by agent_id
		const wallets = agentId
			? await sql`
				SELECT id, agent_id, address, chain, is_default, preferred_network, created_at
				FROM agent_payout_wallets
				WHERE user_id = ${userId} AND (agent_id = ${agentId} OR agent_id IS NULL)
				ORDER BY agent_id NULLS LAST, is_default DESC, created_at DESC
			`
			: await sql`
				SELECT id, agent_id, address, chain, is_default, preferred_network, created_at
				FROM agent_payout_wallets
				WHERE user_id = ${userId}
				ORDER BY agent_id NULLS LAST, is_default DESC, created_at DESC
			`;

		// Also build a summary view: resolve which addresses would be used for each chain
		const evmWallet = wallets.find(
			(w) => (w.chain === 'base' || w.chain === 'evm') && (agentId ? w.agent_id === agentId : true),
		);
		const solanaWallet = wallets.find(
			(w) => w.chain === 'solana' && (agentId ? w.agent_id === agentId : true),
		);

		return json(res, 200, {
			wallets,
			resolved: {
				evm_address: evmWallet?.address ?? null,
				solana_address: solanaWallet?.address ?? null,
				preferred_network: wallets[0]?.preferred_network ?? 'solana',
			},
		});
	}

	// PUT — set/update payout addresses
	const body = parse(putBody, await readJson(req));
	const { agent_id, evm_address, solana_address, preferred_network } = body;

	// Verify agent ownership
	const [agent] = await sql`
		SELECT id, user_id FROM agent_identities
		WHERE id = ${agent_id} AND deleted_at IS NULL
	`;
	if (!agent) return error(res, 404, 'not_found', 'Agent not found');
	if (agent.user_id !== userId) return error(res, 403, 'forbidden', 'You don\'t own this agent');

	// Validate addresses if provided
	if (evm_address && !isValidEvmAddress(evm_address)) {
		return error(res, 400, 'validation_error', 'Invalid EVM address (must start with 0x, 42 characters)');
	}
	if (solana_address && !isValidSolanaAddress(solana_address)) {
		return error(res, 400, 'validation_error', 'Invalid Solana address (must be base58, 32-44 characters)');
	}

	if (!evm_address && !solana_address) {
		return error(res, 400, 'validation_error', 'At least one address (evm_address or solana_address) is required');
	}

	const results = [];

	// Upsert Solana wallet
	if (solana_address) {
		// Clear existing default for this (user, agent, solana)
		await sql`
			UPDATE agent_payout_wallets
			SET is_default = false
			WHERE user_id = ${userId} AND chain = 'solana'
			  AND (agent_id = ${agent_id} OR (agent_id IS NULL AND ${agent_id}::uuid IS NULL))
		`;

		const [wallet] = await sql`
			INSERT INTO agent_payout_wallets
				(user_id, agent_id, address, chain, is_default, preferred_network)
			VALUES
				(${userId}, ${agent_id}, ${solana_address}, 'solana', true, ${preferred_network})
			ON CONFLICT (user_id, agent_id, chain) DO UPDATE SET
				address = EXCLUDED.address,
				is_default = true,
				preferred_network = EXCLUDED.preferred_network
			RETURNING id, agent_id, address, chain, is_default, preferred_network, created_at
		`;
		results.push(wallet);
	}

	// Upsert EVM wallet
	if (evm_address) {
		await sql`
			UPDATE agent_payout_wallets
			SET is_default = false
			WHERE user_id = ${userId} AND chain = 'base'
			  AND (agent_id = ${agent_id} OR (agent_id IS NULL AND ${agent_id}::uuid IS NULL))
		`;

		const [wallet] = await sql`
			INSERT INTO agent_payout_wallets
				(user_id, agent_id, address, chain, is_default, preferred_network)
			VALUES
				(${userId}, ${agent_id}, ${evm_address}, 'base', true, ${preferred_network})
			ON CONFLICT (user_id, agent_id, chain) DO UPDATE SET
				address = EXCLUDED.address,
				is_default = true,
				preferred_network = EXCLUDED.preferred_network
			RETURNING id, agent_id, address, chain, is_default, preferred_network, created_at
		`;
		results.push(wallet);
	}

	return json(res, 200, {
		wallets: results,
		resolved: {
			evm_address: evm_address ?? null,
			solana_address: solana_address ?? null,
			preferred_network,
		},
	});
});
