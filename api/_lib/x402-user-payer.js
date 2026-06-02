// Per-user x402 payer — lets an authenticated three.ws user's agent pay an
// arbitrary external x402 endpoint in USDC from THEIR OWN Solana agent wallet,
// bounded by spending caps. This is the money core behind the `pay_and_call`
// MCP tool ("add a wallet to Claude").
//
// It reuses the SDK's audited exact-scheme signing (@x402/svm) rather than
// hand-rolling transaction construction: we build an x402Client, register the
// Solana exact scheme with a signer derived from the user's recovered keypair,
// install the platform spending cap (enforceCap → commit / rollback), and let
// @x402/axios run the full 402 → sign → settle dance.
//
// SAFETY: spending is OFF unless THREEWS_AGENT_PAY_ENABLED=1. This is real money
// moving from a real user wallet; the flag exists so the capability ships dark
// and is only enabled after a funded-wallet integration test. When disabled,
// resolveSpendEnabled() returns false and callers degrade to a payment-details
// handoff instead of moving funds.

import { sql } from './db.js';
import { env } from './env.js';
import { recoverSolanaAgentKeypair } from './agent-wallet.js';
import { installSpendingCap } from './x402-spending-cap.js';

// Atomic-USDC caps. Defaults are intentionally tiny; operators raise them via
// env once they trust the flow. A per-call override from the tool can only
// LOWER the per-call cap, never raise it past the env ceiling.
const DEFAULT_MAX_PER_CALL = 100_000n; // $0.10
const DEFAULT_MAX_PER_HOUR = 1_000_000n; // $1.00
const DEFAULT_MAX_PER_DAY = 10_000_000n; // $10.00

function envAtomic(name, fallback) {
	const raw = env[name] ?? (typeof process !== 'undefined' ? process.env?.[name] : undefined);
	if (!raw) return fallback;
	try {
		const v = BigInt(raw);
		return v >= 0n ? v : fallback;
	} catch {
		return fallback;
	}
}

export function resolveSpendEnabled() {
	const raw =
		env.THREEWS_AGENT_PAY_ENABLED ??
		(typeof process !== 'undefined' ? process.env?.THREEWS_AGENT_PAY_ENABLED : undefined);
	return raw === '1' || raw === 'true';
}

// The user's primary agent wallet — first agent by creation, matching the
// existing x402-pay convention (getAgentsForUser orders by created_at ASC).
export async function resolveUserAgentWallet(userId) {
	if (!userId) return null;
	const [row] = await sql`
		SELECT id, name, meta FROM agent_identities
		WHERE user_id = ${userId} AND deleted_at IS NULL
		ORDER BY created_at ASC
		LIMIT 1
	`;
	if (!row) return null;
	const address = row.meta?.solana_address || null;
	return {
		agentId: row.id,
		name: row.name || null,
		address,
		hasSecret: !!row.meta?.encrypted_solana_secret,
		encryptedSecret: row.meta?.encrypted_solana_secret || null,
	};
}

// Build a paying axios instance bound to the user's Solana keypair, with the
// platform spending cap installed. Returns { api, client, uninstall, address }.
async function buildUserPayingClient({ wallet, userId, maxPerCallOverride }) {
	const [{ default: axios }, { x402Client, x402HTTPClient }, { wrapAxiosWithPayment }, { ExactSvmScheme }, { createKeyPairSignerFromBytes }] =
		await Promise.all([
			import('axios'),
			import('@x402/core/client'),
			import('@x402/axios'),
			import('@x402/svm/exact/client'),
			import('@solana/kit'),
		]);

	const keypair = await recoverSolanaAgentKeypair(wallet.encryptedSecret, {
		agentId: wallet.agentId,
		userId,
		reason: 'pay_and_call',
	});
	const svmSigner = await createKeyPairSignerFromBytes(keypair.secretKey);

	const client = new x402Client();
	client.register('solana:*', new ExactSvmScheme(svmSigner));

	const envPerCall = envAtomic('X402_MAX_PER_CALL_ATOMIC', DEFAULT_MAX_PER_CALL);
	const perCall =
		maxPerCallOverride != null && maxPerCallOverride < envPerCall ? maxPerCallOverride : envPerCall;
	const uninstall = installSpendingCap(client, {
		address: wallet.address,
		maxPerCall: perCall.toString(),
		maxPerHour: envAtomic('X402_MAX_PER_HOUR_ATOMIC', DEFAULT_MAX_PER_HOUR).toString(),
		maxPerDay: envAtomic('X402_MAX_PER_DAY_ATOMIC', DEFAULT_MAX_PER_DAY).toString(),
	});

	const httpClient = new x402HTTPClient(client);
	const api = wrapAxiosWithPayment(
		axios.create({ timeout: 60_000, validateStatus: (s) => s >= 200 && s < 300 }),
		client,
	);
	return { api, client, httpClient, uninstall, address: wallet.address };
}

function extractReceipt(httpClient, response) {
	if (!response?.headers) return null;
	try {
		return httpClient.getPaymentSettleResponse((n) => response.headers[n] ?? response.headers[n.toLowerCase()]) || null;
	} catch {
		return null;
	}
}

const USDC_MAINNET_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Read-only wallet status for the user's primary agent: address, SOL + USDC
// balance, the active spending caps, and whether autonomous spend is enabled.
// Safe to expose — no keys touched, no funds moved.
export async function getUserWalletStatus(userId) {
	const wallet = await resolveUserAgentWallet(userId);
	const caps = {
		max_per_call_usdc: Number(envAtomic('X402_MAX_PER_CALL_ATOMIC', DEFAULT_MAX_PER_CALL)) / 1e6,
		max_per_hour_usdc: Number(envAtomic('X402_MAX_PER_HOUR_ATOMIC', DEFAULT_MAX_PER_HOUR)) / 1e6,
		max_per_day_usdc: Number(envAtomic('X402_MAX_PER_DAY_ATOMIC', DEFAULT_MAX_PER_DAY)) / 1e6,
	};
	const spend_enabled = resolveSpendEnabled();
	if (!wallet || !wallet.address) {
		return { provisioned: false, address: null, spend_enabled, caps };
	}

	let sol = null;
	let usdc = null;
	try {
		const { Connection, PublicKey } = await import('@solana/web3.js');
		const { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } =
			await import('@solana/spl-token');
		const rpc =
			env.SOLANA_RPC_URL ??
			(typeof process !== 'undefined' ? process.env?.SOLANA_RPC_URL : null) ??
			'https://api.mainnet-beta.solana.com';
		const conn = new Connection(rpc, 'confirmed');
		const owner = new PublicKey(wallet.address);
		const lamports = await conn.getBalance(owner);
		sol = lamports / 1e9;
		try {
			const ata = getAssociatedTokenAddressSync(
				new PublicKey(USDC_MAINNET_MINT),
				owner,
				false,
				TOKEN_PROGRAM_ID,
				ASSOCIATED_TOKEN_PROGRAM_ID,
			);
			const bal = await conn.getTokenAccountBalance(ata);
			usdc = bal?.value?.uiAmount ?? 0;
		} catch {
			usdc = 0; // no ATA yet → zero USDC
		}
	} catch {
		// RPC failure — report the wallet without live balances rather than throw.
	}

	return {
		provisioned: true,
		agent_id: wallet.agentId,
		agent_name: wallet.name,
		address: wallet.address,
		network: 'solana',
		balances: { sol, usdc },
		spend_enabled,
		caps,
	};
}

// Pay an external x402 endpoint from the user's wallet. Throws an Error with a
// `.code` for the boundary (the MCP handler) to translate into a clean result.
export async function payExternalX402({ userId, url, method = 'GET', body, maxUsd }) {
	if (!resolveSpendEnabled()) {
		throw Object.assign(new Error('autonomous spending is disabled on this server'), {
			code: 'spend_disabled',
		});
	}
	if (!userId) {
		throw Object.assign(new Error('sign in required to pay from your wallet'), {
			code: 'auth_required',
		});
	}
	const wallet = await resolveUserAgentWallet(userId);
	if (!wallet) {
		throw Object.assign(new Error('no agent wallet found for this account'), { code: 'no_wallet' });
	}
	if (!wallet.address || !wallet.hasSecret) {
		throw Object.assign(new Error('your agent has no Solana wallet provisioned'), {
			code: 'no_solana_wallet',
		});
	}

	const maxPerCallOverride =
		typeof maxUsd === 'number' && maxUsd > 0 ? BigInt(Math.round(maxUsd * 1_000_000)) : null;

	const { api, httpClient, uninstall, address } = await buildUserPayingClient({
		wallet,
		userId,
		maxPerCallOverride,
	});

	try {
		const response = await api.request({
			url,
			method,
			...(body != null ? { data: body } : {}),
		});
		return {
			ok: true,
			payer: address,
			result: response.data,
			receipt: extractReceipt(httpClient, response),
		};
	} finally {
		if (typeof uninstall === 'function') uninstall();
	}
}
