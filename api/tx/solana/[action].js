import { z } from 'zod';
import { solanaConnection } from '../../_lib/solana/connection.js';
import {
	PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL,
	TransactionInstruction,
} from '@solana/web3.js';
import {
	createTransferCheckedInstruction, getMint, getAssociatedTokenAddressSync,
	createAssociatedTokenAccountInstruction,
	TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { cors, json, method, readJson, wrap, error, rateLimited } from '../../_lib/http.js';
import { getSessionUser } from '../../_lib/auth.js';
import { limits, clientIp } from '../../_lib/rate-limit.js';
import { parse, isValidSolanaAddress } from '../../_lib/validate.js';
import { jupiterQuote, jupiterSwapTx } from '../../_lib/token/jupiter.js';

const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
// The memo program accepts up to 566 bytes of instruction data. Cap below that so
// an oversized memo is a 400 here instead of a serialize failure (a 500) after the
// transaction has already been assembled.
const MEMO_MAX_BYTES = 512;

// A base58 Solana address, rejected at the schema so a typo answers 400 with the
// offending field named. Without this, `new PublicKey(...)` throws deep inside the
// handler and wrap() can only report an opaque 500 for what is plainly client input.
const solanaAddress = z
	.string()
	.trim()
	.refine(isValidSolanaAddress, 'must be a base58 Solana address');

// Amounts arrive as JSON numbers (doubles). Multiplying by 10**decimals loses
// precision well before the u64 ceiling, so the conversion below goes through
// fixed-point string math instead, and this bound keeps the value in the range
// where toFixed() is exact rather than exponential.
const MAX_UI_AMOUNT = 1e12;
const uiAmount = z.number().positive().finite().max(MAX_UI_AMOUNT);

// A tagged client error: wrap() turns any thrown error carrying a 4xx `status`
// into `{ error: code, error_description: message }` with that status, which is
// how a helper several calls deep reports a caller fault without threading `res`.
function clientError(code, message) {
	return Object.assign(new Error(message), { status: 400, code });
}

function upstreamError(message) {
	return Object.assign(new Error(message), { status: 502, code: 'upstream_error', expose: true });
}

// Convert a UI amount to raw base units without a float multiply: render at the
// mint's precision, then shift the decimal point in string space. `0.1` at 9
// decimals is 100000000 here, not 99999999.99999999.
function toRawUnits(amount, decimals) {
	const [whole, frac = ''] = amount.toFixed(decimals).split('.');
	return BigInt(whole + frac.padEnd(decimals, '0'));
}

// Resolve which token program owns a mint, plus its decimals. $THREE and every
// other pump.fun-era mint is Token-2022, so assuming the original TOKEN_PROGRAM_ID
// (the spl-token default) made the SPL path unable to transfer the platform's own
// coin: getMint rejected with TokenInvalidAccountOwnerError and the caller got a 500.
async function resolveMint(connection, mintPk) {
	let account;
	try {
		account = await connection.getAccountInfo(mintPk);
	} catch (err) {
		throw upstreamError(`mint lookup failed upstream: ${err?.message || 'rpc error'}`);
	}
	if (!account) throw clientError('invalid_mint', 'token mint not found on this network');

	const programId = account.owner.equals(TOKEN_2022_PROGRAM_ID)
		? TOKEN_2022_PROGRAM_ID
		: account.owner.equals(TOKEN_PROGRAM_ID)
			? TOKEN_PROGRAM_ID
			: null;
	if (!programId) throw clientError('invalid_mint', 'address is not an SPL token mint');

	let info;
	try {
		info = await getMint(connection, mintPk, 'confirmed', programId);
	} catch {
		throw clientError('invalid_mint', 'could not read token mint');
	}
	return { programId, decimals: info.decimals };
}

// Derive an associated token account, answering 400 rather than 500 when the
// owner is off the ed25519 curve. A program-derived address (an AMM vault, an
// escrow) has no standard ATA and no keypair to sign with, so a caller who pastes
// one has made an input mistake: name the side that is wrong instead of letting
// TokenOwnerOffCurveError surface as an opaque internal error.
function associatedTokenAddress(mint, owner, programId, side) {
	try {
		return getAssociatedTokenAddressSync(mint, owner, false, programId, ASSOCIATED_TOKEN_PROGRAM_ID);
	} catch {
		throw clientError('invalid_owner', `${side} is a program-derived address and has no associated token account`);
	}
}

// ── build-transfer ────────────────────────────────────────────────────────────

const transferSchema = z.object({
	sender:    solanaAddress,
	recipient: solanaAddress,
	amount:    uiAmount,
	// 'SOL' for the native transfer, otherwise the SPL mint to move.
	token:     z.union([z.literal('SOL'), solanaAddress]).default('SOL'),
	memo:      z
		.string()
		.refine((v) => Buffer.byteLength(v, 'utf8') <= MEMO_MAX_BYTES, `memo must be at most ${MEMO_MAX_BYTES} bytes`)
		.optional(),
	network:   z.enum(['mainnet', 'devnet']).default('mainnet'),
});

async function handleBuildTransfer(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;
	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');
	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const { sender, recipient, amount, token, memo, network } = parse(transferSchema, await readJson(req));

	// Resolve the endpoint through the shared multi-provider chain rather than
	// pinning the public mainnet node: it is the most aggressively rate-limited
	// lane and passing it as an explicit url put it at the HEAD of the failover
	// order, ahead of every keyed provider.
	const connection = solanaConnection({ network, commitment: 'confirmed' });
	const senderPubkey    = new PublicKey(sender);
	const recipientPubkey = new PublicKey(recipient);

	const tx = new Transaction();

	if (token === 'SOL') {
		const lamports = toRawUnits(amount, 9);
		if (lamports <= 0n) return error(res, 400, 'invalid_amount', 'amount rounds to zero lamports');
		if (lamports > BigInt(Number.MAX_SAFE_INTEGER)) {
			return error(res, 400, 'invalid_amount', `amount exceeds ${Number.MAX_SAFE_INTEGER / LAMPORTS_PER_SOL} SOL`);
		}
		tx.add(SystemProgram.transfer({
			fromPubkey: senderPubkey,
			toPubkey:   recipientPubkey,
			lamports,
		}));
	} else {
		const mint = new PublicKey(token);
		const { programId, decimals } = await resolveMint(connection, mint);

		const amountInSmallestUnit = toRawUnits(amount, decimals);
		if (amountInSmallestUnit <= 0n) {
			return error(res, 400, 'invalid_amount', `amount rounds to zero at ${decimals} decimals`);
		}

		const senderATA    = associatedTokenAddress(mint, senderPubkey, programId, 'sender');
		const recipientATA = associatedTokenAddress(mint, recipientPubkey, programId, 'recipient');

		// Tell the sender their balance is short BEFORE they approve a transaction
		// that can only fail on-chain and still cost them the fee.
		let senderBalance = 0n;
		try {
			const bal = await connection.getTokenAccountBalance(senderATA);
			senderBalance = BigInt(bal.value.amount);
		} catch {
			senderBalance = 0n;
		}
		if (senderBalance < amountInSmallestUnit) {
			return error(res, 400, 'insufficient_balance', 'sender holds less of this token than the requested amount');
		}

		let recipientAccount;
		try {
			recipientAccount = await connection.getAccountInfo(recipientATA);
		} catch (err) {
			throw upstreamError(`recipient account lookup failed upstream: ${err?.message || 'rpc error'}`);
		}
		if (!recipientAccount) {
			tx.add(createAssociatedTokenAccountInstruction(
				senderPubkey, recipientATA, recipientPubkey, mint, programId, ASSOCIATED_TOKEN_PROGRAM_ID,
			));
		}

		// TransferChecked, not Transfer: Token-2022 mints carrying a transfer-fee
		// extension reject the unchecked variant, and the mint/decimals it pins
		// make a wrong-decimals build fail at simulation instead of silently
		// moving the wrong amount.
		tx.add(createTransferCheckedInstruction(
			senderATA, mint, recipientATA, senderPubkey, amountInSmallestUnit, decimals, [], programId,
		));
	}

	if (memo) {
		tx.add(new TransactionInstruction({
			keys:      [],
			programId: MEMO_PROGRAM_ID,
			data:      Buffer.from(memo, 'utf-8'),
		}));
	}

	let latestBlockhash;
	try {
		latestBlockhash = await connection.getLatestBlockhash();
	} catch (err) {
		throw upstreamError(`blockhash fetch failed upstream: ${err?.message || 'rpc error'}`);
	}
	tx.feePayer        = senderPubkey;
	tx.recentBlockhash = latestBlockhash.blockhash;

	const serialized = tx.serialize({ requireAllSignatures: false });
	return json(res, 200, {
		transaction:          serialized.toString('base64'),
		network,
		blockhash:            latestBlockhash.blockhash,
		lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
	});
}

// ── build-swap ────────────────────────────────────────────────────────────────

const swapSchema = z.object({
	sender:      solanaAddress,
	inputMint:   solanaAddress,
	outputMint:  solanaAddress,
	amount:      uiAmount,
	slippageBps: z.number().int().min(1).max(5000).default(50),
	network:     z.enum(['mainnet']).default('mainnet'),
});

async function handleBuildSwap(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;
	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');
	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const { sender, inputMint, outputMint, amount, slippageBps } = parse(swapSchema, await readJson(req));
	if (inputMint === outputMint) {
		return error(res, 400, 'invalid_route', 'inputMint and outputMint must differ');
	}

	const connection = solanaConnection({ network: 'mainnet', commitment: 'confirmed' });
	const { decimals: inputDecimals } = await resolveMint(connection, new PublicKey(inputMint));
	const { decimals: outputDecimals } = await resolveMint(connection, new PublicKey(outputMint));

	const amountInSmallestUnit = toRawUnits(amount, inputDecimals);
	if (amountInSmallestUnit <= 0n) {
		return error(res, 400, 'invalid_amount', `amount rounds to zero at ${inputDecimals} decimals`);
	}

	// Route through the shared Jupiter client (api/_lib/token/jupiter.js) so this
	// endpoint can never drift from the rest of the platform's swap lanes on
	// endpoint or error handling. It previously called quote-api.jup.ag/v6
	// directly, a host that no longer resolves at all, so every swap build failed,
	// and the bare `fetch failed` was misread downstream as a database outage.
	let quote;
	try {
		quote = await jupiterQuote({
			inputMint,
			outputMint,
			amount: amountInSmallestUnit.toString(),
			slippageBps,
		});
	} catch (err) {
		if (err?.status >= 400 && err.status < 500) {
			return error(res, 422, 'no_route', 'No swap route found for this pair and amount');
		}
		throw upstreamError(`swap quote failed upstream: ${err?.message || 'network error'}`);
	}
	if (!quote?.outAmount) return error(res, 422, 'no_route', 'No swap route found for this pair and amount');

	let swapTransaction;
	try {
		swapTransaction = await jupiterSwapTx({
			quote,
			userPublicKey: sender,
			// This lane swaps arbitrary pairs including native SOL, so Jupiter has
			// to open and close the wrapped-SOL account itself.
			wrapAndUnwrapSol: true,
		});
	} catch (err) {
		if (err?.status >= 400 && err.status < 500) {
			return error(res, 422, 'swap_failed', 'Jupiter could not build a transaction for this route');
		}
		throw upstreamError(`swap build failed upstream: ${err?.message || 'network error'}`);
	}

	return json(res, 200, {
		transaction:    swapTransaction,
		network:        'mainnet',
		inputAmount:    amount,
		outputAmount:   Number(quote.outAmount) / 10 ** outputDecimals,
		outputMint,
		priceImpactPct: quote.priceImpactPct,
	});
}

// ── router ────────────────────────────────────────────────────────────────────

const DISPATCH = { 'build-transfer': handleBuildTransfer, 'build-swap': handleBuildSwap };

export default wrap(async (req, res) => {
	const action = req.query?.action ?? new URL(req.url, 'http://x').pathname.split('/').pop();
	const fn = DISPATCH[action];
	if (!fn) return error(res, 404, 'not_found', `unknown action: ${action}`);
	return fn(req, res);
});
