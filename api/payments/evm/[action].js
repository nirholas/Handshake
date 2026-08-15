// Consolidated EVM payment endpoints (checkout + confirm).

import { z } from 'zod';
import { sql } from '../../_lib/db.js';
import { getSessionUser } from '../../_lib/auth.js';
import { cors, json, method, readJson, wrap, error, rateLimited } from '../../_lib/http.js';
import { limits, clientIp } from '../../_lib/rate-limit.js';
import { parse } from '../../_lib/validate.js';
import { randomToken } from '../../_lib/crypto.js';
import { sendSubscriptionConfirmEmail } from '../../_lib/email.js';
import { PLANS, EVM_USDC, getEvmRecipient, INTENT_TTL_MINUTES } from '../_config.js';

// ── checkout ──────────────────────────────────────────────────────────────────

const checkoutSchema = z.object({
	plan:     z.enum(['pro', 'team', 'enterprise']),
	chain_id: z.number().int().positive(),
});

async function handleCheckout(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;
	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');
	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);
	const body = parse(checkoutSchema, await readJson(req));
	const { plan, chain_id } = body;
	if (!EVM_USDC[chain_id]) return error(res, 400, 'unsupported_chain', `chain ${chain_id} is not supported for payments`);
	const recipient = getEvmRecipient(chain_id);
	if (!recipient) return error(res, 503, 'not_configured', 'payment recipient not configured for this chain');
	const planConfig = PLANS[plan];
	const amountUsdc = planConfig.price_usd;
	const nonce = await randomToken(16);
	const expiresAt = new Date(Date.now() + INTENT_TTL_MINUTES * 60 * 1000);
	const [intent] = await sql`insert into plan_payment_intents (user_id, plan, chain_type, chain_id, amount_usdc, recipient, nonce, expires_at) values (${user.id}, ${plan}, 'evm', ${chain_id}, ${amountUsdc}, ${recipient.toLowerCase()}, ${nonce}, ${expiresAt}) returning id, nonce, amount_usdc, recipient, expires_at`;
	return json(res, 201, { intent_id: intent.id, plan, chain_id, usdc_address: EVM_USDC[chain_id], recipient, amount_usdc: amountUsdc, amount_atomics: String(BigInt(Math.round(amountUsdc * 1_000_000))), nonce, expires_at: intent.expires_at, instructions: `Transfer exactly ${amountUsdc} USDC to ${recipient} on chain ${chain_id}. Include nonce "${nonce}" in memo/calldata if possible, then call /api/payments/evm/confirm.` });
}

// ── confirm ───────────────────────────────────────────────────────────────────

import { createPublicClient, parseAbi } from 'viem';
import { evmTransport } from '../../_lib/evm/rpc.js';
import { mainnet, base, optimism, arbitrum, polygon, sepolia, baseSepolia } from 'viem/chains';

const CHAINS = { 1: mainnet, 8453: base, 10: optimism, 42161: arbitrum, 137: polygon, 11155111: sepolia, 84532: baseSepolia };
const ERC20_ABI = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']);

const confirmSchema = z.object({
	intent_id: z.string().uuid(),
	tx_hash:   z.string().regex(/^0x[a-fA-F0-9]{64}$/),
});

async function handleConfirm(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;
	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');
	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);
	const body = parse(confirmSchema, await readJson(req));
	const { intent_id, tx_hash } = body;
	// Scoped to this lane: the Solana lane writes into the same table, and an
	// unscoped lookup let an EVM confirm read (and expire) a Solana intent, which
	// then failed downstream as a confusing "chain null not supported".
	const [intent] = await sql`select * from plan_payment_intents where id = ${intent_id} and user_id = ${user.id} and chain_type = 'evm' limit 1`;
	if (!intent) return error(res, 404, 'not_found', 'intent not found');
	if (intent.status === 'confirmed') return error(res, 409, 'already_confirmed', 'payment already confirmed');
	if (intent.status === 'failed') return error(res, 410, 'intent_expired', 'payment session is no longer usable');
	// Confirming requires MIN_CONFIRMATIONS blocks of depth below, so a transfer
	// broadcast near the end of the session cannot possibly be confirmable before
	// the session lapses. Honor a confirm inside a bounded grace window rather
	// than stranding funds that are already on-chain: the USDC amount was pinned
	// at checkout and USDC is 1:1 with the USD price, so the window carries no
	// price-drift exposure. Mirrors the Solana lane's grace window.
	const CONFIRM_GRACE_MS = 60 * 60 * 1000;
	if (new Date(intent.expires_at).getTime() + CONFIRM_GRACE_MS < Date.now()) {
		await sql`update plan_payment_intents set status='expired' where id=${intent_id} and status='pending'`;
		return error(res, 410, 'intent_expired', 'payment session expired, start a new checkout');
	}
	const chainId = intent.chain_id;
	const chain = CHAINS[chainId];
	if (!chain) return error(res, 400, 'unsupported_chain', `chain ${chainId} not supported`);
	const client = createPublicClient({ chain, transport: evmTransport(chainId) });
	let receipt;
	try { receipt = await client.getTransactionReceipt({ hash: tx_hash }); }
	catch { return error(res, 422, 'tx_not_found', 'transaction not found on chain — may need more confirmations'); }
	if (receipt.status !== 'success') return error(res, 422, 'tx_failed', 'transaction reverted');
	// Require a confirmation depth before granting the (irreversible, 30-day)
	// plan — a single-receipt check accepts a tx that a short reorg could revert.
	const MIN_CONFIRMATIONS = 12n;
	try {
		const head = await client.getBlockNumber();
		if (head - receipt.blockNumber < MIN_CONFIRMATIONS) {
			return error(res, 422, 'insufficient_confirmations', 'transaction needs more confirmations — retry shortly');
		}
	} catch {
		return error(res, 422, 'tx_not_found', 'unable to read chain head for confirmation depth');
	}
	const usdcAddress = EVM_USDC[chainId]?.toLowerCase();
	const logs = await client.getLogs({ address: usdcAddress, event: ERC20_ABI[0], fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber });
	const expectedRecipient = intent.recipient.toLowerCase();
	const expectedAtomics = BigInt(Math.round(Number(intent.amount_usdc) * 1_000_000));
	const matchingLog = logs.find((log) => log.transactionHash?.toLowerCase() === tx_hash.toLowerCase() && log.args.to?.toLowerCase() === expectedRecipient && BigInt(log.args.value ?? 0) >= expectedAtomics);
	if (!matchingLog) return error(res, 422, 'transfer_not_found', `No USDC transfer of ${intent.amount_usdc} USDC to ${expectedRecipient} found in tx`);

	// Bind the on-chain payment to this account. The treasury recipient is shared
	// across all users, so "a transfer of the right amount to the treasury exists"
	// is not proof THIS user paid — without binding, anyone could confirm any
	// public transfer against their own intent. EVM USDC transfers carry no memo
	// (unlike the Solana path's nonce memo), so we bind on the payer address: the
	// funds must originate from a wallet linked to this account.
	const payer = matchingLog.args.from?.toLowerCase();
	if (!payer) return error(res, 422, 'transfer_not_found', 'could not determine payer address from transaction');
	const [linked] = await sql`select 1 from user_wallets where user_id = ${user.id} and lower(address) = ${payer} limit 1`;
	if (!linked) {
		return error(res, 422, 'payer_not_linked', 'payment must be sent from a wallet linked to your account — link the paying wallet, then retry', { payer });
	}

	// Reject a tx_hash already consumed by another confirmed intent (replay).
	// The partial unique index payment_intents_tx_hash_unique is the hard backstop;
	// this pre-check turns the race-loser into a clean 409 instead of a 500.
	const [dupe] = await sql`select id from plan_payment_intents where chain_type = 'evm' and tx_hash = ${tx_hash} and status = 'confirmed' limit 1`;
	if (dupe) return error(res, 409, 'tx_already_used', 'this transaction has already been used to confirm a payment');

	// All three writes are in a single transaction so a crash between intent-claim
	// and the subscription/user grant can't leave the user paid but unsubscribed.
	// The intent UPDATE names the two claimable statuses explicitly (never
	// != 'confirmed') so a concurrent confirm can claim the row exactly once and
	// a 'failed' intent can never be revived; 'expired' is claimable because the
	// grace window above already decided this confirm is still in time. On a
	// unique-index violation (concurrent confirm with same tx_hash) the entire
	// transaction rolls back and we return 409.
	const planConfig = PLANS[intent.plan];
	const activeUntil = new Date(Date.now() + planConfig.duration_days * 86400 * 1000);
	let claimed;
	try {
		[claimed] = await sql.transaction([
			sql`update plan_payment_intents set status='confirmed', tx_hash=${tx_hash}, confirmed_at=now() where id=${intent_id} and status in ('pending', 'expired') returning id`,
			sql`insert into subscriptions (user_id, plan, chain_type, chain_id, token_address, tx_hash, amount_usd, status, active_until) values (${user.id}, ${intent.plan}, 'evm', ${chainId}, ${usdcAddress}, ${tx_hash}, ${intent.amount_usdc}, 'active', ${activeUntil}) on conflict (user_id) where status='active' do update set plan=excluded.plan, chain_type=excluded.chain_type, chain_id=excluded.chain_id, token_address=excluded.token_address, tx_hash=excluded.tx_hash, amount_usd=excluded.amount_usd, active_until=excluded.active_until, updated_at=now()`,
			sql`update users set plan=${intent.plan} where id=${user.id}`,
		]);
	} catch (e) {
		if (e?.code === '23505') return error(res, 409, 'tx_already_used', 'this transaction has already been used to confirm a payment');
		throw e;
	}
	if (!claimed?.[0]) return error(res, 409, 'already_confirmed', 'payment already confirmed');
	queueMicrotask(() => sendSubscriptionConfirmEmail({ to: user.email, plan: intent.plan, chain: `EVM chain ${chainId}`, txId: tx_hash }).catch(() => {}));
	return json(res, 200, { ok: true, plan: intent.plan, active_until: activeUntil.toISOString(), tx_hash });
}

// ── dispatcher ────────────────────────────────────────────────────────────────

const DISPATCH = { checkout: handleCheckout, confirm: handleConfirm };

export default wrap(async (req, res) => {
	const action = req.query?.action ?? new URL(req.url, 'http://x').pathname.split('/').pop();
	const fn = DISPATCH[action];
	if (!fn) return error(res, 404, 'not_found', `unknown evm payment action: ${action}`);
	return fn(req, res);
});
