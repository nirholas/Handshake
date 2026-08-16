// POST /api/scene/gate-check
//
// Two-phase wallet-ownership proof for a token-gated scene share created by
// api/scene/gate-create.js. The chat client (chat/src/App.svelte) calls it twice:
//
// Phase 1 - { gateId, walletAddress } -> { message, chain }
//   Issues a one-time nonce inside a human-readable message the visitor's wallet
//   signs. Nothing is granted yet.
//
// Phase 2 - { gateId, walletAddress, signature, message } -> { allowed, reason? }
//   Verifies the signature (ed25519 for Solana, personal_sign for EVM), burns the
//   nonce, then reads the wallet's REAL on-chain holding for the gate's asset.
//
// Fail-closed, and honest about WHY it failed: a denial ({ allowed: false }) means
// the chain answered and the wallet is short. An RPC outage or a missing provider
// key is an infrastructure fault, so it returns 5xx with a generic message rather
// than a denial carrying the upstream error text (which both lies to the visitor
// and leaks internals to an unauthenticated caller).
//
// The nonce is burned BEFORE the chain read, so a failed read costs the visitor a
// fresh phase 1. That is deliberate: a replayable nonce is worse than a retry.
import { z } from 'zod';
import { verifyMessage, Contract, formatUnits, isAddress } from 'ethers';
import { sql } from '../_lib/db.js';
import { cors, json, method, readJson, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { randomToken } from '../_lib/crypto.js';
import { verifySiwsSignature } from '../_lib/siws.js';
import { parse } from '../_lib/validate.js';
// getSplTokenBalance rotates the shared Solana lane pool (api/_lib/solana/connection.js)
// instead of pinning one endpoint; dasSearchAssets targets Helius, the only provider
// in our stack that implements the DAS methods collection gating needs.
import { getSplTokenBalance } from '../_lib/embed-gate.js';
import { dasRpcUrl, dasSearchAssets, isValidSolanaAddress } from '../_lib/nft-gate.js';
import { evmFallbackProvider } from '../_lib/evm/rpc.js';

const NONCE_TTL_SEC = 10 * 60;

// EVM gates carry a bare contract address with no chain id (see the scene_gates
// schema), so they resolve on Ethereum mainnet. evmRpcEndpoints(1) puts the
// public endpoints behind any configured/Alchemy URL, so gating still works on a
// deployment with no provider key rather than hard-failing on ALCHEMY_API_KEY.
const EVM_CHAIN_ID = 1;

// DAS pages at 1000 assets. A gate only needs to know whether the wallet reaches
// min_balance, so paging stops as soon as the threshold is met; the cap bounds the
// work an unauthenticated caller can trigger with a huge wallet.
const DAS_PAGE_SIZE = 1000;
const DAS_MAX_PAGES = 5;

const ERC_BALANCE_ABI = [
	'function balanceOf(address owner) view returns (uint256)',
	'function decimals() view returns (uint8)',
];

const phase1Schema = z.object({
	gateId: z.string().trim().min(1).max(32),
	walletAddress: z.string().trim().min(1).max(128),
});

const phase2Schema = z.object({
	gateId: z.string().trim().min(1).max(32),
	walletAddress: z.string().trim().min(1).max(128),
	signature: z.string().min(1).max(512),
	message: z.string().min(1).max(1024),
});

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;
	res.setHeader('cache-control', 'no-store');

	const rl = await limits.sceneGateCheckIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const raw = await readJson(req);

	if (raw && raw.signature != null) return handlePhase2(res, raw);
	return handlePhase1(res, raw);
});

/** A wallet the gate's chain can actually verify. Catches a Solana address pasted
 *  into an EVM gate before it reaches an RPC that would answer with noise. */
function walletMatchesChain(chain, walletAddress) {
	return chain === 'solana' ? isValidSolanaAddress(walletAddress) : isAddress(walletAddress);
}

async function handlePhase1(res, raw) {
	const body = parse(phase1Schema, raw);

	const [gate] = await sql`
		select id, chain from scene_gates where id = ${body.gateId} limit 1
	`;
	if (!gate) return error(res, 404, 'not_found', 'gate not found');
	if (!walletMatchesChain(gate.chain, body.walletAddress)) {
		return error(res, 400, 'validation_error', `walletAddress is not a valid ${gate.chain} address`);
	}

	let nonce = '';
	while (nonce.length < 16) {
		nonce += randomToken(20).replace(/[^A-Za-z0-9]/g, '');
	}
	nonce = nonce.slice(0, 16);

	await sql`
		insert into gate_nonces (nonce, gate_id, address, expires_at)
		values (${nonce}, ${body.gateId}, ${body.walletAddress}, now() + ${`${NONCE_TTL_SEC} seconds`}::interval)
	`;

	const message = [
		'three.ws scene gate verification.',
		'',
		`Gate ID: ${body.gateId}`,
		`Wallet: ${body.walletAddress}`,
		`Nonce: ${nonce}`,
		`Issued At: ${new Date().toISOString()}`,
	].join('\n');

	return json(res, 200, { message, chain: gate.chain });
}

async function handlePhase2(res, raw) {
	const body = parse(phase2Schema, raw);

	const [gate] = await sql`
		select id, chain, kind, address, min_balance
		from scene_gates where id = ${body.gateId} limit 1
	`;
	if (!gate) return error(res, 404, 'not_found', 'gate not found');
	if (!walletMatchesChain(gate.chain, body.walletAddress)) {
		return error(res, 400, 'validation_error', `walletAddress is not a valid ${gate.chain} address`);
	}

	// A per-wallet ceiling on top of the per-IP flood guard: IPs are cheap to
	// rotate, a wallet's signing key is not, so this is the bucket that actually
	// bounds a determined attacker replaying signature attempts against one gate.
	const wl = await limits.sceneGateCheckWallet(body.walletAddress);
	if (!wl.success) return rateLimited(res, wl);

	// Verify signature
	if (gate.chain === 'solana') {
		let valid;
		try {
			valid = verifySiwsSignature(body.message, body.signature, body.walletAddress);
		} catch {
			return error(res, 401, 'invalid_signature', 'Solana signature verification failed');
		}
		if (!valid) return error(res, 401, 'invalid_signature', 'Solana signature does not match wallet');
	} else {
		let recovered;
		try {
			recovered = verifyMessage(body.message, body.signature);
		} catch {
			return error(res, 401, 'invalid_signature', 'EVM signature verification failed');
		}
		if (recovered.toLowerCase() !== body.walletAddress.toLowerCase()) {
			return error(res, 401, 'invalid_signature', 'EVM signature does not match wallet');
		}
	}

	// Extract and burn nonce
	const nonceMatch = body.message.match(/^Nonce: (.+)$/m);
	if (!nonceMatch) return error(res, 400, 'invalid_message', 'nonce not found in message');
	const nonce = nonceMatch[1].trim();

	const [nonceRow] = await sql`
		select nonce, gate_id, address, expires_at, consumed_at
		from gate_nonces where nonce = ${nonce} limit 1
	`;
	if (!nonceRow) return error(res, 400, 'invalid_nonce', 'unknown nonce');
	if (nonceRow.consumed_at) return error(res, 400, 'nonce_reused', 'nonce already used');
	if (new Date(nonceRow.expires_at) < new Date()) return error(res, 400, 'nonce_expired', 'nonce expired');
	if (nonceRow.gate_id !== body.gateId) return error(res, 400, 'invalid_nonce', 'nonce gate mismatch');
	if (nonceRow.address !== body.walletAddress) return error(res, 400, 'invalid_nonce', 'nonce wallet mismatch');

	const burned = await sql`
		update gate_nonces set consumed_at = now()
		where nonce = ${nonce} and consumed_at is null
		returning nonce
	`;
	if (!burned[0]) return error(res, 400, 'nonce_reused', 'nonce already used');

	const minBalance = Number(gate.min_balance);

	// Query chain holdings
	let balance;
	try {
		balance = await queryBalance(gate, body.walletAddress, minBalance);
	} catch (e) {
		console.warn(`[scene-gate] balance check failed for gate ${gate.id} (${gate.chain}/${gate.kind}):`, e?.message || e);
		if (e?.status === 503) {
			return error(
				res,
				503,
				'not_configured',
				'This gate cannot be verified right now: its chain provider is not configured.',
			);
		}
		return error(
			res,
			502,
			'gate_check_unavailable',
			'Could not read your on-chain balance right now. Try verifying again in a moment.',
		);
	}

	if (balance >= minBalance) {
		return json(res, 200, { allowed: true });
	}
	return json(res, 200, {
		allowed: false,
		reason: `Insufficient balance: need ${minBalance}, have ${balance}`,
	});
}

async function queryBalance(gate, walletAddress, minBalance) {
	if (gate.chain === 'solana') return querySolanaBalance(gate, walletAddress, minBalance);
	return queryEvmBalance(gate, walletAddress);
}

async function querySolanaBalance(gate, walletAddress, minBalance) {
	if (gate.kind === 'spl') return getSplTokenBalance(walletAddress, gate.address);
	return countCollectionAssets(walletAddress, gate.address, minBalance);
}

/** How many NFTs of `collectionMint` the wallet holds, counted only as far as
 *  `minBalance` (the answer past the threshold does not change the decision). */
async function countCollectionAssets(walletAddress, collectionMint, minBalance) {
	if (!dasRpcUrl()) {
		throw Object.assign(new Error('HELIUS_API_KEY not configured'), { status: 503 });
	}
	const needed = Math.max(1, Math.ceil(minBalance));
	let held = 0;
	for (let page = 1; page <= DAS_MAX_PAGES; page++) {
		const result = await dasSearchAssets({
			ownerAddress: walletAddress,
			grouping: ['collection', collectionMint],
			// Burnt assets are not held, and a burn must not keep a gate open.
			burnt: false,
			page,
			limit: DAS_PAGE_SIZE,
		});
		const items = Array.isArray(result.items) ? result.items : [];
		held += items.length;
		if (held >= needed || items.length < DAS_PAGE_SIZE) break;
	}
	return held;
}

async function queryEvmBalance(gate, walletAddress) {
	const provider = await evmFallbackProvider(EVM_CHAIN_ID);
	const token = new Contract(gate.address, ERC_BALANCE_ABI, provider);
	const rawBalance = await token.balanceOf(walletAddress);

	// ERC-721 balances are whole tokens; ERC-20 needs the contract's own scale, and
	// a token that omits decimals() is 18 by convention.
	if (gate.kind === 'erc721') return Number(rawBalance);

	let decimals = 18;
	try {
		decimals = Number(await token.decimals());
	} catch {
		decimals = 18;
	}
	return Number(formatUnits(rawBalance, decimals));
}
