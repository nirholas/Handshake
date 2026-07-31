// POST /api/user/wallet/send
// Send SOL or USDC from the user's master wallet to any Solana address.
// Body: { destination: string, amount: number | "max", asset: "SOL" | "<usdc-mint>" }

import { getSessionUser } from '../../_lib/auth.js';
import { sql } from '../../_lib/db.js';
import { cors, json, error, wrap, method, readJson } from '../../_lib/http.js';
import { requireCsrf } from '../../_lib/csrf.js';
import { limits, clientIp } from '../../_lib/rate-limit.js';
import { recoverSolanaAgentKeypair } from '../../_lib/agent-wallet.js';
import { solanaConnection } from '../../_lib/agent-pumpfun.js';
import { validateSolanaAddress, lamportsToUsd } from '../../_lib/agent-trade-guards.js';
import { recordEvent } from '../../_lib/usage.js';
import {
	Keypair, PublicKey, LAMPORTS_PER_SOL, SystemProgram,
	TransactionMessage, VersionedTransaction,
} from '@solana/web3.js';
import {
	getAssociatedTokenAddressSync, createTransferCheckedInstruction,
	createAssociatedTokenAccountIdempotentInstruction, getMint,
	TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL_FEE_RESERVE_LAMPORTS = 15_000n;
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

	const network = 'mainnet';
	const asset = typeof body.asset === 'string' && body.asset.trim() ? body.asset.trim() : 'SOL';
	const simulate = body.simulate === true;

	// The body is parsed before the limiters on purpose: a simulate moves no
	// funds, so it must not draw on the 5-per-DAY withdrawal budget. Charging
	// previews against it meant a user who priced a transfer four times could
	// not send at all until the next day. Previews get their own per-minute
	// ceiling; only a real broadcast spends the daily one.
	const rlUser = simulate
		? await limits.walletSimulate(session.id)
		: await limits.withdrawalPerUser(session.id);
	if (!rlUser.success) return json(res, 429, { error: 'rate_limited' });
	const rlIp = await limits.authIp(clientIp(req));
	if (!rlIp.success) return json(res, 429, { error: 'rate_limited' });

	const [row] = await sql`
		SELECT solana_address, encrypted_solana_secret
		FROM master_wallets WHERE user_id = ${session.id}
	`;
	if (!row?.solana_address) {
		return error(res, 404, 'not_found', 'master wallet not set up yet');
	}

	const dest = validateSolanaAddress(body.destination);
	if (!dest.valid) return error(res, 400, 'invalid_destination', `not a valid Solana address (${dest.reason})`);
	if (!dest.onCurve) return error(res, 400, 'invalid_destination', 'program/off-curve address — funds may be unrecoverable');
	if (dest.base58 === row.solana_address) return error(res, 400, 'invalid_destination', 'destination is your own wallet');

	const isMax = body.amount === 'max' || body.amount === 'MAX';
	const amountNum = isMax ? null : Number(body.amount);
	if (!isMax && (!Number.isFinite(amountNum) || amountNum <= 0)) {
		return error(res, 400, 'invalid_amount', 'amount must be a positive number or "max"');
	}

	const conn = solanaConnection(network);
	const fromPk = new PublicKey(row.solana_address);
	const destPk = dest.pubkey;

	let balanceLamports;
	try { balanceLamports = BigInt(await conn.getBalance(fromPk, 'confirmed')); }
	catch { return error(res, 502, 'rpc_error', 'could not read wallet balance'); }

	let ixs = [];
	let lamports = null;
	let amountRaw = null;
	let decimals = 9;
	let humanAmount = null;
	let usdValue = null;
	let mintPk = null;
	let tokenProgramId = null;
	let sourceAta = null;
	let destAta = null;

	if (asset === 'SOL') {
		let rentReserve;
		try { rentReserve = BigInt(await conn.getMinimumBalanceForRentExemption(0)); }
		catch { rentReserve = RENT_EXEMPT_FALLBACK_LAMPORTS; }

		if (isMax) {
			const spendable = balanceLamports - rentReserve - SOL_FEE_RESERVE_LAMPORTS;
			if (spendable <= 0n) return error(res, 400, 'insufficient_balance', 'not enough SOL after fees and rent');
			lamports = spendable;
		} else {
			lamports = BigInt(Math.round(amountNum * 1e9));
			if (lamports <= 0n) return error(res, 400, 'invalid_amount', 'amount rounds to zero lamports');
			if (balanceLamports - lamports < rentReserve + SOL_FEE_RESERVE_LAMPORTS) {
				return error(res, 400, 'insufficient_balance', 'amount would leave too little SOL for fees');
			}
		}
		humanAmount = Number(lamports) / 1e9;
		try { usdValue = await lamportsToUsd(lamports); } catch { usdValue = null; }
		ixs.push(SystemProgram.transfer({ fromPubkey: fromPk, toPubkey: destPk, lamports }));
	} else {
		const mintCheck = validateSolanaAddress(asset);
		if (!mintCheck.valid) return error(res, 400, 'invalid_asset', 'asset must be "SOL" or a valid SPL mint');
		mintPk = mintCheck.pubkey;

		let mintAcc;
		try { mintAcc = await conn.getAccountInfo(mintPk); }
		catch { mintAcc = null; }
		if (!mintAcc) return error(res, 400, 'invalid_asset', 'token mint not found');
		tokenProgramId = mintAcc.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

		let mintInfo;
		try { mintInfo = await getMint(conn, mintPk, 'confirmed', tokenProgramId); }
		catch { return error(res, 400, 'invalid_asset', 'could not read token mint'); }
		decimals = mintInfo.decimals;

		sourceAta = getAssociatedTokenAddressSync(mintPk, fromPk, false, tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID);
		let tokenBal;
		try { const b = await conn.getTokenAccountBalance(sourceAta); tokenBal = BigInt(b.value.amount); }
		catch { return error(res, 400, 'insufficient_balance', 'your wallet holds none of this token'); }
		if (tokenBal <= 0n) return error(res, 400, 'insufficient_balance', 'your wallet holds none of this token');

		amountRaw = isMax ? tokenBal : BigInt(Math.round(amountNum * 10 ** decimals));
		if (amountRaw <= 0n) return error(res, 400, 'invalid_amount', 'amount rounds to zero token units');
		if (amountRaw > tokenBal) return error(res, 400, 'insufficient_balance', 'amount exceeds your token balance');
		humanAmount = Number(amountRaw) / 10 ** decimals;

		destAta = getAssociatedTokenAddressSync(mintPk, destPk, false, tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID);
		let destInfo;
		try { destInfo = await conn.getAccountInfo(destAta); } catch { destInfo = null; }
		const destAtaExists = !!destInfo;

		let ataRent = 0n;
		if (!destAtaExists) {
			try { ataRent = BigInt(await conn.getMinimumBalanceForRentExemption(165)); }
			catch { ataRent = TOKEN_ACCOUNT_RENT_FALLBACK_LAMPORTS; }
			ixs.push(createAssociatedTokenAccountIdempotentInstruction(
				fromPk, destAta, destPk, mintPk, tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID,
			));
		}
		if (balanceLamports < SOL_FEE_RESERVE_LAMPORTS + ataRent) {
			return error(res, 400, 'insufficient_sol_for_fees', 'need more SOL to cover network fee' + (destAtaExists ? '' : ' and open recipient token account'));
		}
		ixs.push(createTransferCheckedInstruction(sourceAta, mintPk, destAta, fromPk, amountRaw, decimals, [], tokenProgramId));

		if (mintPk.toBase58() === USDC_MINT) usdValue = humanAmount;
	}

	if (simulate) {
		return json(res, 200, {
			simulation: {
				asset, destination: dest.base58, human_amount: humanAmount,
				usd_value: usdValue, network,
			},
		});
	}

	// Build and sign the transaction
	const keypair = await recoverSolanaAgentKeypair(row.encrypted_solana_secret, {
		agentId: `master:${session.id}`,
		userId: session.id,
		reason: 'master_wallet_send',
	});

	let blockhash;
	try {
		const bh = await conn.getLatestBlockhash('confirmed');
		blockhash = bh.blockhash;
	} catch {
		return error(res, 502, 'rpc_error', 'could not get blockhash');
	}

	const msg = new TransactionMessage({
		payerKey: fromPk,
		recentBlockhash: blockhash,
		instructions: ixs,
	}).compileToV0Message();
	const tx = new VersionedTransaction(msg);
	tx.sign([keypair]);

	let signature;
	try {
		signature = await conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 2 });
	} catch (e) {
		return error(res, 502, 'send_failed', e?.message || 'transaction rejected by network');
	}

	recordEvent({
		userId: session.id,
		event: 'master_wallet_send',
		meta: { asset, destination: dest.base58, human_amount: humanAmount, usd_value: usdValue, signature },
	}).catch(() => {});

	return json(res, 200, {
		signature,
		explorer: `https://solscan.io/tx/${signature}`,
		asset,
		destination: dest.base58,
		human_amount: humanAmount,
		usd_value: usdValue,
		network,
	});
});
