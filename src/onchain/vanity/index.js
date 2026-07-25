/**
 * Vanity wallet provisioning for agents.
 *
 * Wraps the existing client-side grinder (src/solana/vanity/grinder.js) and
 * the provisioning endpoint (POST /api/agents/:id/solana with secret_key +
 * vanity_prefix). Lets a caller grind a Solana keypair whose pubkey starts
 * with a chosen base58 prefix, then hand it to the server, which encrypts it
 * with AES-GCM (HKDF-derived from JWT_SECRET) and stores it on the agent.
 *
 * The agent thereafter has a custodial Solana wallet — the same model used
 * by the legacy /api/agents/:id/pumpfun/* endpoints. The plaintext secret
 * key only exists for the moment between grinding and the POST.
 *
 * Why client-side: keeps secret material out of server logs/RPC traces, and
 * avoids burning Vercel function time on CPU-bound grinding. Long prefixes
 * (5+) can take minutes — caller is responsible for surfacing a Cancel UX
 * via AbortSignal.
 */

import { grindVanity } from '../../solana/vanity/grinder.js';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { apiFetch } from '../../api.js';

/**
 * @param {object} opts
 * @param {string} opts.agentId
 * @param {string} [opts.prefix]
 * @param {string} [opts.suffix]
 * @param {boolean} [opts.ignoreCase]
 * @param {AbortSignal} [opts.signal]
 * @param {(p: { attempts: number, rate: number, eta: string }) => void} [opts.onProgress]
 * @returns {Promise<{ address: string, attempts: number, durationMs: number }>}
 */
export async function provisionVanityForAgent(opts) {
	if (!opts?.agentId) throw new Error('agentId required');
	if (!opts.prefix && !opts.suffix) throw new Error('prefix or suffix required');

	// 1. Grind locally — secret material stays in this tab.
	const ground = await grindVanity({
		prefix: opts.prefix,
		suffix: opts.suffix,
		ignoreCase: !!opts.ignoreCase,
		signal: opts.signal,
		onProgress: opts.onProgress,
	});

	// 2. Sanity-check: derive the pubkey from the secret and confirm it matches.
	// The server does this check too; doing it here surfaces local memory
	// corruption (rare) before paying for a network round-trip.
	const kp = Keypair.fromSecretKey(ground.secretKey);
	if (kp.publicKey.toBase58() !== ground.publicKey) {
		throw new Error('Locally-derived pubkey does not match grinder output.');
	}

	// 3. POST to the provisioning endpoint. The legacy endpoint accepts a
	// base58-encoded secret_key and (optional) vanity_prefix — see
	// api/agents/solana-wallet.js for the contract.
	const secretBase58 = bs58.encode(ground.secretKey);
	const resp = await apiFetch(`/api/agents/${encodeURIComponent(opts.agentId)}/solana`, {
		method: 'POST',
		credentials: 'include',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			secret_key: secretBase58,
			vanity_prefix: opts.prefix || undefined,
			vanity_suffix: opts.suffix || undefined,
		}),
	});
	if (!resp.ok) {
		const data = await resp.json().catch(() => ({}));
		const err = new Error(data.error_description || `provision returned ${resp.status}`);
		err.status = resp.status;
		err.code = data.error;
		throw err;
	}
	const result = await resp.json();
	return {
		address: result.solana_address || ground.publicKey,
		attempts: ground.attempts,
		durationMs: ground.durationMs,
	};
}

export { grindVanity };
export { validatePattern, estimateAttempts, formatTimeEstimate } from '../../solana/vanity/validation.js';
