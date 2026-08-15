// POST /api/user/wallet/fund-agent
// Transfer USDC or SOL from the user's master wallet into one of their agent wallets.
// Body: { agent_id: string, amount: number | "max", asset: "SOL" | "USDC", simulate?: boolean }
//
// `simulate: true` runs the identical ownership, balance, rent and fee path and
// returns the resolved numbers WITHOUT recovering the key or signing anything.
// It is what the /wallet confirmation step is built from, so the amount a user
// reads back is the amount the chain produced (notably for `"max"`, which the
// browser cannot compute, and for the extra rent when the agent has no token
// account yet). Mirrors the simulate contract in send.js.

import { getSessionUser } from '../../_lib/auth.js';
import { sql } from '../../_lib/db.js';
import { cors, json, error, wrap, method, readJson } from '../../_lib/http.js';
import { requireCsrf } from '../../_lib/csrf.js';
import { limits, clientIp } from '../../_lib/rate-limit.js';
import { recoverSolanaAgentKeypair } from '../../_lib/agent-wallet.js';
import { solanaConnection } from '../../_lib/agent-pumpfun.js';
import { validateSolanaAddress } from '../../_lib/agent-trade-guards.js';
import { recordEvent } from '../../_lib/usage.js';
import {
	PublicKey, SystemProgram, TransactionMessage, VersionedTransaction,
} from '@solana/web3.js';
import {
	getAssociatedTokenAddressSync, createTransferCheckedInstruction,
	createAssociatedTokenAccountIdempotentInstruction,
	TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_DECIMALS = 6;
const SOL_FEE_RESERVE_LAMPORTS = 20_000n;
const RENT_EXEMPT_FALLBACK_LAMPORTS = 890_880n;
const TOKEN_ACCOUNT_RENT_FALLBACK_LAMPORTS = 2_039_280n;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const session = await getSessionUser(req);
	if (!session) return error(res, 401, 'unauthorized', 'sign in required');

	if (!(await requireCsrf(req, res, session.id))) return;

	let body;
	try { body = await readJson(req); }
	catch (e) { return error(res, 400, 'bad_request', e?.message || 'invalid body'); }

	// Parsed before the limiter so a preview does not spend the 5-per-DAY
	// withdrawal budget. See the matching note in send.js.
	const simulate = body.simulate === true;
	const rl = simulate
		? await limits.walletSimulate(session.id)
		: await limits.withdrawalPerUser(session.id);
	if (!rl.success) return json(res, 429, { error: 'rate_limited' });
	// Parity with send.js: the per-user budget bounds one account, the per-IP one
	// bounds a caller cycling accounts. `clientIp` was imported here and never
	// used, which left this the only funds-moving wallet route without it.
	const rlIp = await limits.authIp(clientIp(req));
	if (!rlIp.success) return json(res, 429, { error: 'rate_limited' });

	// Load master wallet
	const [mw] = await sql`
		SELECT solana_address, encrypted_solana_secret
		FROM master_wallets WHERE user_id = ${session.id}
	`;
	if (!mw?.solana_address) return error(res, 404, 'not_found', 'master wallet not set up');

	const agentId = body.agent_id;
	if (!agentId || typeof agentId !== 'string') return error(res, 400, 'bad_request', 'agent_id required');

	// Verify the agent belongs to this user
	const [agent] = await sql`
		SELECT id, meta FROM agent_identities
		WHERE id = ${agentId} AND user_id = ${session.id} AND deleted_at IS NULL
	`;
	if (!agent) return error(res, 403, 'forbidden', 'agent not found or not yours');

	const agentSolAddr = agent.meta?.solana_address;
	if (!agentSolAddr) return error(res, 400, 'no_agent_wallet', 'agent has no Solana wallet, provision one first');

	// agent_identities.meta is JSON written by several provisioning paths, so the
	// address stored there is not guaranteed to be a decodable pubkey. Handing an
	// unchecked string to `new PublicKey()` threw past every boundary and surfaced
	// as an opaque 500; validating it names the fault and keeps the destination
	// check identical to the one send.js applies to a user-supplied address.
	const agentDest = validateSolanaAddress(agentSolAddr);
	if (!agentDest.valid || !agentDest.onCurve) {
		return error(res, 422, 'agent_wallet_invalid', 'this agent\'s stored wallet address is not a valid Solana account; re-provision its wallet');
	}

	const asset = body.asset === 'SOL' ? 'SOL' : 'USDC';
	const isMax = body.amount === 'max' || body.amount === 'MAX';
	const amountNum = isMax ? null : Number(body.amount);
	if (!isMax && (!Number.isFinite(amountNum) || amountNum <= 0)) {
		return error(res, 400, 'invalid_amount', 'amount must be a positive number or "max"');
	}

	const conn = solanaConnection('mainnet');
	const fromPk = new PublicKey(mw.solana_address);
	const destPk = agentDest.pubkey;
	const mintPk = new PublicKey(USDC_MINT);

	let balanceLamports;
	try { balanceLamports = BigInt(await conn.getBalance(fromPk, 'confirmed')); }
	catch { return error(res, 502, 'rpc_error', 'could not read balance'); }

	let ixs = [];
	let humanAmount, usdValue;
	// Set when the agent has no USDC token account yet: the transfer then also
	// pays that account's rent, which the confirmation step surfaces rather than
	// letting the user discover it as a surprise SOL debit.
	let tokenAccountRentLamports = 0n;

	if (asset === 'SOL') {
		let rentReserve;
		try { rentReserve = BigInt(await conn.getMinimumBalanceForRentExemption(0)); }
		catch { rentReserve = RENT_EXEMPT_FALLBACK_LAMPORTS; }

		let lamports;
		if (isMax) {
			const spendable = balanceLamports - rentReserve - SOL_FEE_RESERVE_LAMPORTS;
			if (spendable <= 0n) return error(res, 400, 'insufficient_balance', 'not enough SOL to send');
			lamports = spendable;
		} else {
			lamports = BigInt(Math.round(amountNum * 1e9));
			if (lamports <= 0n) return error(res, 400, 'invalid_amount', 'amount rounds to zero');
			if (balanceLamports - lamports < rentReserve + SOL_FEE_RESERVE_LAMPORTS) {
				return error(res, 400, 'insufficient_balance', 'insufficient SOL balance');
			}
		}
		humanAmount = Number(lamports) / 1e9;
		usdValue = null;
		ixs.push(SystemProgram.transfer({ fromPubkey: fromPk, toPubkey: destPk, lamports }));
	} else {
		// USDC transfer
		const sourceAta = getAssociatedTokenAddressSync(mintPk, fromPk, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
		const destAta = getAssociatedTokenAddressSync(mintPk, destPk, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

		let tokenBal;
		try { const b = await conn.getTokenAccountBalance(sourceAta); tokenBal = BigInt(b.value.amount); }
		catch { return error(res, 400, 'insufficient_balance', 'your master wallet holds no USDC'); }
		if (tokenBal <= 0n) return error(res, 400, 'insufficient_balance', 'your master wallet holds no USDC');

		const amountRaw = isMax ? tokenBal : BigInt(Math.round(amountNum * 10 ** USDC_DECIMALS));
		if (amountRaw <= 0n) return error(res, 400, 'invalid_amount', 'amount rounds to zero');
		if (amountRaw > tokenBal) return error(res, 400, 'insufficient_balance', 'amount exceeds your USDC balance');
		humanAmount = Number(amountRaw) / 10 ** USDC_DECIMALS;
		usdValue = humanAmount;

		let destInfo;
		try { destInfo = await conn.getAccountInfo(destAta); } catch { destInfo = null; }
		if (!destInfo) {
			let ataRent;
			try { ataRent = BigInt(await conn.getMinimumBalanceForRentExemption(165)); }
			catch { ataRent = TOKEN_ACCOUNT_RENT_FALLBACK_LAMPORTS; }
			if (balanceLamports < SOL_FEE_RESERVE_LAMPORTS + ataRent) {
				return error(res, 400, 'insufficient_sol_for_fees', 'need more SOL in master wallet for fees');
			}
			tokenAccountRentLamports = ataRent;
			ixs.push(createAssociatedTokenAccountIdempotentInstruction(
				fromPk, destAta, destPk, mintPk, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
			));
		}
		ixs.push(createTransferCheckedInstruction(sourceAta, mintPk, destAta, fromPk, amountRaw, USDC_DECIMALS, [], TOKEN_PROGRAM_ID));
	}

	// Everything above is validation and chain reads. Returning here means the
	// encrypted secret is never decrypted and no transaction is ever built.
	if (simulate) {
		return json(res, 200, {
			simulation: {
				asset,
				agent_id: agentId,
				agent_wallet: agentSolAddr,
				human_amount: humanAmount,
				usd_value: usdValue,
				creates_token_account: tokenAccountRentLamports > 0n,
				token_account_rent_sol:
					tokenAccountRentLamports > 0n ? Number(tokenAccountRentLamports) / 1e9 : 0,
				network: 'mainnet',
			},
		});
	}

	const keypair = await recoverSolanaAgentKeypair(mw.encrypted_solana_secret, {
		agentId: `master:${session.id}`,
		userId: session.id,
		reason: 'master_wallet_fund_agent',
	});

	let blockhash;
	try { const bh = await conn.getLatestBlockhash('confirmed'); blockhash = bh.blockhash; }
	catch { return error(res, 502, 'rpc_error', 'could not get blockhash'); }

	const msg = new TransactionMessage({
		payerKey: fromPk,
		recentBlockhash: blockhash,
		instructions: ixs,
	}).compileToV0Message();
	const tx = new VersionedTransaction(msg);
	tx.sign([keypair]);

	let signature;
	try { signature = await conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 2 }); }
	catch (e) { return error(res, 502, 'send_failed', e?.message || 'transaction failed'); }

	// Fire-and-forget: recordEvent returns nothing and swallows its own failures.
	// The .catch() that used to hang off it threw a TypeError on this line, AFTER
	// the top-up was already on chain, so a successful funding answered 500 and the
	// page told the owner their agent had not been paid.
	recordEvent({
		userId: session.id,
		event: 'master_wallet_fund_agent',
		meta: { agent_id: agentId, asset, human_amount: humanAmount, signature },
	});

	return json(res, 200, {
		signature,
		explorer: `https://solscan.io/tx/${signature}`,
		asset,
		agent_id: agentId,
		agent_wallet: agentSolAddr,
		human_amount: humanAmount,
		usd_value: usdValue,
	});
});
