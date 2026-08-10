// POST /api/agent/send-sol — the avatar widget's autonomous payout.
//
// The avatar holds a custodial Solana wallet (AVATAR_WALLET_SECRET). When the
// chat brain decides to pay (the `sendSol` tool) or a user clicks "send", the
// widget calls this endpoint. It converts a USD amount to SOL at the live
// price, signs with the avatar's key server-side, submits on-chain, and returns
// the confirmed signature.
//
// Body: { usd?: number, sol?: number, to?: string, memo?: string }
//   - Exactly one of `usd` / `sol` is required (USD preferred).
//   - `to` omitted → AVATAR_DEFAULT_RECIPIENT ("send me").
// Guardrails: per-call USD cap (AVATAR_MAX_SEND_USD), pubkey validation,
// IP rate-limit, optional shared-secret header (AVATAR_DEMO_TOKEN).

import { z } from 'zod';
import { cors, json, method, readJson, wrap, error, rateLimited } from '../_lib/http.js';
import { parse } from '../_lib/validate.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { logAudit } from '../_lib/audit.js';
import { recordPaymentMetric } from '../_lib/axiom.js';
import {
	avatarWalletConfig,
	loadAvatarKeypair,
	getConnection,
	getSolBalance,
	solUsdPrice,
	sendSol,
	isValidPubkey,
	explorerTxUrl,
	explorerAccountUrl,
	LAMPORTS_PER_SOL,
} from '../_lib/avatar-wallet.js';

// A confirmed transfer leaves headroom for the signature fee (5000 lamports)
// plus a small priority cushion so the avatar never drains itself below fees.
const FEE_BUFFER_LAMPORTS = 15_000;

const bodySchema = z
	.object({
		usd: z.number().positive().max(1000).optional(),
		sol: z.number().positive().max(100).optional(),
		to: z.string().trim().min(32).max(64).optional(),
		memo: z.string().trim().max(160).optional(),
	})
	.refine((b) => b.usd != null || b.sol != null, {
		message: 'provide `usd` or `sol`',
	});

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const cfg = avatarWalletConfig();
	if (!cfg.configured) {
		return error(
			res,
			503,
			'wallet_unconfigured',
			'avatar wallet is not configured. Set AVATAR_WALLET_SECRET (run scripts/gen-avatar-wallet.mjs).',
		);
	}

	// Optional shared-secret gate. When set, the widget must echo it.
	if (cfg.demoToken) {
		const provided = req.headers['x-avatar-token'];
		if (provided !== cfg.demoToken) {
			return error(res, 401, 'unauthorized', 'missing or invalid x-avatar-token');
		}
	}

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl, 'too many payout requests, try again shortly');

	const body = parse(bodySchema, await readJson(req));

	// When the recipient is locked, the wallet can only ever pay the configured
	// default — any client-supplied `to` is ignored.
	let recipient;
	if (cfg.lockRecipient) {
		if (!cfg.defaultRecipient) {
			return error(res, 503, 'recipient_locked', 'AVATAR_LOCK_RECIPIENT is set but AVATAR_DEFAULT_RECIPIENT is missing');
		}
		recipient = cfg.defaultRecipient;
	} else {
		// Sending to a client-supplied address that isn't the configured default is
		// the drain vector: without a gate, anyone (rotating IPs past the per-IP
		// limit) can repeatedly pay themselves up to the per-send cap until the
		// wallet is empty. Require the demo-token gate to be configured before
		// honoring an arbitrary `to`; otherwise the wallet can only pay its default.
		if (body.to && body.to !== cfg.defaultRecipient && !cfg.demoToken) {
			return error(
				res,
				403,
				'recipient_not_allowed',
				'sends to arbitrary recipients require AVATAR_DEMO_TOKEN; otherwise set AVATAR_LOCK_RECIPIENT to pin payouts to AVATAR_DEFAULT_RECIPIENT',
			);
		}
		recipient = body.to || cfg.defaultRecipient;
	}
	if (!recipient) {
		return error(res, 400, 'no_recipient', 'no recipient: pass `to` or set AVATAR_DEFAULT_RECIPIENT');
	}
	if (!isValidPubkey(recipient)) {
		return error(res, 400, 'bad_recipient', 'recipient is not a valid Solana address');
	}

	let solPriceUsd;
	try {
		solPriceUsd = await solUsdPrice();
	} catch {
		return error(res, 502, 'price_unavailable', 'could not fetch the live SOL price, try again shortly');
	}

	// Resolve the amount in both USD and lamports, then enforce the USD cap.
	const usd = body.usd != null ? body.usd : body.sol * solPriceUsd;
	if (usd > cfg.maxSendUsd) {
		return error(
			res,
			400,
			'amount_too_large',
			`amount $${usd.toFixed(2)} exceeds the per-send cap of $${cfg.maxSendUsd.toFixed(2)}`,
		);
	}
	const solAmount = body.sol != null ? body.sol : usd / solPriceUsd;
	const lamports = Math.round(solAmount * LAMPORTS_PER_SOL);
	if (lamports <= 0) {
		return error(res, 400, 'amount_too_small', 'amount rounds to zero lamports');
	}

	// Wallet-wide daily payout ceiling (defense in depth on top of the per-send
	// cap + per-IP limit): bounds total outflow if the demo token leaks or a
	// caller rotates IPs. Keyed on the wallet pubkey so it's a single shared
	// budget. Checked here — after all validation — so failed requests don't burn it.
	const daily = await limits.avatarPayoutDaily(cfg.address);
	if (!daily.success) {
		return rateLimited(res, daily, 'avatar wallet has hit its daily payout limit, try again later');
	}

	const connection = getConnection(cfg.rpcUrl);
	const keypair = loadAvatarKeypair(process.env.AVATAR_WALLET_SECRET);

	// Balance guard — fail clearly before signing if the wallet can't cover it.
	const { lamports: balance } = await getSolBalance(connection, keypair.publicKey);
	if (balance < lamports + FEE_BUFFER_LAMPORTS) {
		return error(
			res,
			409,
			'insufficient_funds',
			`avatar wallet has ${(balance / LAMPORTS_PER_SOL).toFixed(5)} SOL, needs about ${((lamports + FEE_BUFFER_LAMPORTS) / LAMPORTS_PER_SOL).toFixed(5)} SOL. Fund ${cfg.address}.`,
			{ address: cfg.address, fundUrl: explorerAccountUrl(cfg.address, cfg.network) },
		);
	}

	let signature;
	const sendStartedAt = Date.now();
	try {
		signature = await sendSol({
			connection,
			fromKeypair: keypair,
			to: recipient,
			lamports,
			memo: body.memo || `three.ws avatar · $${usd.toFixed(2)} SOL`,
		});
	} catch (err) {
		recordPaymentMetric({
			kind: 'avatar_payout',
			status: 'failed',
			network: cfg.network,
			amountUsd: usd,
			latencyMs: Date.now() - sendStartedAt,
			reason: err?.message || 'unknown',
		});
		return error(res, 502, 'send_failed', `on-chain transfer failed: ${err?.message || 'unknown error'}`);
	}
	recordPaymentMetric({
		kind: 'avatar_payout',
		status: 'ok',
		network: cfg.network,
		amountUsd: usd,
		latencyMs: Date.now() - sendStartedAt,
		signature,
	});

	// Immutable trail for the one custodial money-out path: who triggered a
	// payout (by IP/UA — this endpoint is session-less, gated by demo-token /
	// recipient-lock), how much, and the on-chain signature. Reconciliation and
	// incident response depend on this row. Fire-and-forget; never blocks the response.
	logAudit({
		userId: null,
		action: 'avatar_payout',
		resourceId: signature,
		meta: {
			from: cfg.address,
			to: recipient,
			lamports,
			sol: solAmount,
			usd,
			sol_price_usd: solPriceUsd,
			network: cfg.network,
		},
		req,
	});

	return json(res, 200, {
		ok: true,
		signature,
		network: cfg.network,
		from: cfg.address,
		to: recipient,
		lamports,
		sol: solAmount,
		usd,
		solPriceUsd,
		explorer: explorerTxUrl(signature, cfg.network),
	});
});
