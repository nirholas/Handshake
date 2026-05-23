// /api/x402/pay-by-name
//
// Unified payment routing: pay a recipient identified by *name* instead of by
// raw address. Resolves the name across three namespaces in this order:
//
//   1. `@<username>` (or bare username, 3–30 chars [a-z0-9_-]) — looks up
//      `users.username`, then picks that user's default agent's Solana
//      address. Falls through if no match.
//   2. `<anything>.sol` (including subdomains like `nich.threews.sol`) —
//      resolved on-chain via Bonfida `resolve()`.
//   3. raw base58 address — passes through.
//
// GET  /api/x402/pay-by-name?name=<name>
//   Resolve only. Returns { name, address, source, full?, claim? }.
//
// POST /api/x402/pay-by-name { name, amount_usdc, message?, mode }
//   mode='prep': build an unsigned USDC SPL transfer tx with the caller's
//     `payer_wallet` (passed in body) as fee payer + source. Returns the
//     base64-encoded VersionedTransaction for browser wallet signing.
//   mode='send' (requires auth + agent_id): server signs as the caller's
//     specified agent (must be theirs), broadcasts the transfer, returns
//     the signature.

import {
	Connection,
	PublicKey,
	TransactionMessage,
	VersionedTransaction,
} from '@solana/web3.js';
import {
	TOKEN_PROGRAM_ID,
	ASSOCIATED_TOKEN_PROGRAM_ID,
	getAssociatedTokenAddressSync,
	createTransferCheckedInstruction,
	createAssociatedTokenAccountIdempotentInstruction,
} from '@solana/spl-token';

import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { sql } from '../_lib/db.js';
import { cors, error, json, method, readJson, wrap } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { solanaConnection, loadAgentForSigning } from '../_lib/agent-pumpfun.js';
import { PARENT_LABEL } from '../_lib/threews-sns.js';

const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const USDC_DECIMALS = 6;
const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const HANDLE_RE = /^@?[a-z0-9_-]{3,30}$/i;
const SOL_DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.sol$/i;

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId };
	return null;
}

/**
 * Resolve a name (handle, .sol domain, or raw address) to a recipient.
 * Returns { address, source, resolved, claim? } or null.
 */
async function resolveName(rawName) {
	const name = String(rawName || '').trim();
	if (!name) return null;

	// 1. raw base58 address — return as-is.
	if (ADDR_RE.test(name)) {
		return { address: name, source: 'address', resolved: name };
	}

	// 2. .sol domains, including subdomains (foo.threews.sol).
	if (SOL_DOMAIN_RE.test(name)) {
		const bare = name.replace(/\.sol$/i, '');
		// If it's a `<label>.threews` form, also surface our DB claim so
		// callers can show the showcase link.
		let claim = null;
		const threewsSuffix = `.${PARENT_LABEL}`;
		if (bare.toLowerCase().endsWith(threewsSuffix)) {
			const label = bare.slice(0, -threewsSuffix.length).toLowerCase();
			const [row] = await sql`
				SELECT s.label, s.parent, u.id AS user_id, u.username, u.display_name
				FROM user_subdomains s
				JOIN users u ON u.id = s.user_id
				WHERE s.label = ${label} AND s.parent = ${PARENT_LABEL}
				LIMIT 1
			`;
			if (row) {
				claim = {
					user_id: row.user_id,
					username: row.username,
					display_name: row.display_name,
				};
			}
		}
		try {
			const sns = await import('@bonfida/spl-name-service');
			const conn = solanaConnection('mainnet');
			const pk = await sns.resolve(conn, bare);
			return {
				address: pk.toBase58(),
				source: 'sns',
				resolved: name.toLowerCase(),
				...(claim ? { claim } : {}),
			};
		} catch {
			return null;
		}
	}

	// 3. @username or bare username.
	if (HANDLE_RE.test(name)) {
		const handle = name.replace(/^@/, '').toLowerCase();
		const [user] = await sql`
			SELECT id, username, display_name FROM users
			WHERE lower(username) = ${handle} AND deleted_at IS NULL
			LIMIT 1
		`;
		if (!user) return null;
		const [agent] = await sql`
			SELECT meta->>'solana_address' AS sol
			FROM agent_identities
			WHERE user_id = ${user.id} AND deleted_at IS NULL
			ORDER BY created_at ASC
			LIMIT 1
		`;
		if (!agent?.sol) return null;
		return {
			address: agent.sol,
			source: 'username',
			resolved: `@${user.username}`,
			claim: { user_id: user.id, username: user.username, display_name: user.display_name },
		};
	}

	return null;
}

function parseAmountUsdc(input) {
	const n = Number(input);
	if (!Number.isFinite(n) || n <= 0) return null;
	// 6 decimals → cap at 10_000 USDC per call to bound damage if misused.
	if (n > 10_000) return null;
	return BigInt(Math.round(n * 10 ** USDC_DECIMALS));
}

async function buildTransferIxs({ payer, recipient, amountAtoms }) {
	const payerAta = getAssociatedTokenAddressSync(
		USDC_MINT,
		payer,
		false,
		TOKEN_PROGRAM_ID,
		ASSOCIATED_TOKEN_PROGRAM_ID,
	);
	const recipientAta = getAssociatedTokenAddressSync(
		USDC_MINT,
		recipient,
		false,
		TOKEN_PROGRAM_ID,
		ASSOCIATED_TOKEN_PROGRAM_ID,
	);
	const ataIx = createAssociatedTokenAccountIdempotentInstruction(
		payer,
		recipientAta,
		recipient,
		USDC_MINT,
		TOKEN_PROGRAM_ID,
		ASSOCIATED_TOKEN_PROGRAM_ID,
	);
	const transferIx = createTransferCheckedInstruction(
		payerAta,
		USDC_MINT,
		recipientAta,
		payer,
		amountAtoms,
		USDC_DECIMALS,
		[],
		TOKEN_PROGRAM_ID,
	);
	return [ataIx, transferIx];
}

async function handleResolve(req, res) {
	const url = new URL(req.url, 'http://x');
	const name = url.searchParams.get('name');
	if (!name) return error(res, 400, 'validation_error', 'name required');
	const resolved = await resolveName(name);
	if (!resolved) return error(res, 404, 'not_found', `could not resolve "${name}"`);
	return json(res, 200, { data: resolved }, { 'cache-control': 'public, max-age=60' });
}

async function handlePrep(req, res, body) {
	const payerWallet = String(body?.payer_wallet || '').trim();
	if (!ADDR_RE.test(payerWallet)) {
		return error(res, 400, 'validation_error', 'payer_wallet must be a base58 Solana public key');
	}
	const resolved = await resolveName(body?.name);
	if (!resolved) return error(res, 404, 'not_found', `could not resolve "${body?.name}"`);
	const amountAtoms = parseAmountUsdc(body?.amount_usdc);
	if (!amountAtoms) return error(res, 400, 'validation_error', 'amount_usdc must be > 0 and ≤ 10000');

	const payer = new PublicKey(payerWallet);
	const recipient = new PublicKey(resolved.address);
	if (payer.equals(recipient)) {
		return error(res, 400, 'self_pay', 'payer and recipient resolve to the same wallet');
	}
	const conn = solanaConnection('mainnet');
	const ixs = await buildTransferIxs({ payer, recipient, amountAtoms });
	const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
	const msg = new TransactionMessage({
		payerKey: payer,
		recentBlockhash: blockhash,
		instructions: ixs,
	}).compileToV0Message();
	const tx = new VersionedTransaction(msg);

	return json(res, 200, {
		data: {
			recipient: resolved,
			amount_usdc: Number(amountAtoms) / 10 ** USDC_DECIMALS,
			tx_base64: Buffer.from(tx.serialize()).toString('base64'),
			blockhash,
			last_valid_block_height: lastValidBlockHeight,
			mint: USDC_MINT.toBase58(),
		},
	});
}

async function handleSend(req, res, auth, body) {
	const agentId = String(body?.agent_id || '').trim();
	if (!agentId) return error(res, 400, 'validation_error', 'agent_id required when mode=send');

	const resolved = await resolveName(body?.name);
	if (!resolved) return error(res, 404, 'not_found', `could not resolve "${body?.name}"`);
	const amountAtoms = parseAmountUsdc(body?.amount_usdc);
	if (!amountAtoms) return error(res, 400, 'validation_error', 'amount_usdc must be > 0 and ≤ 10000');

	const loaded = await loadAgentForSigning(agentId, auth.userId, {
		reason: 'x402_pay_by_name',
		meta: { name: body?.name, amount_usdc: Number(amountAtoms) / 10 ** USDC_DECIMALS },
	});
	if (loaded.error) return error(res, loaded.error.status, loaded.error.code, loaded.error.msg);
	const { keypair } = loaded;
	const recipient = new PublicKey(resolved.address);
	if (keypair.publicKey.equals(recipient)) {
		return error(res, 400, 'self_pay', 'agent and recipient resolve to the same wallet');
	}

	const conn = solanaConnection('mainnet');
	const ixs = await buildTransferIxs({
		payer: keypair.publicKey,
		recipient,
		amountAtoms,
	});
	const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
	const msg = new TransactionMessage({
		payerKey: keypair.publicKey,
		recentBlockhash: blockhash,
		instructions: ixs,
	}).compileToV0Message();
	const tx = new VersionedTransaction(msg);
	tx.sign([keypair]);

	let signature;
	try {
		signature = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
		await conn.confirmTransaction(
			{ signature, blockhash, lastValidBlockHeight },
			'confirmed',
		);
	} catch (err) {
		console.error('[pay-by-name] send_failed', err);
		return error(res, 502, 'upstream_error', err?.message || 'transfer failed');
	}

	return json(res, 200, {
		data: {
			recipient: resolved,
			payer: keypair.publicKey.toBase58(),
			amount_usdc: Number(amountAtoms) / 10 ** USDC_DECIMALS,
			signature,
			mode: 'send',
		},
	});
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	if (req.method === 'GET') return handleResolve(req, res);

	const body = await readJson(req).catch(() => ({}));
	const mode = body?.mode === 'send' ? 'send' : 'prep';

	if (mode === 'prep') return handlePrep(req, res, body);

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required for mode=send');
	return handleSend(req, res, auth, body);
});
