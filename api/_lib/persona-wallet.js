/**
 * Persona↔wallet binding — every embodied persona (api/_lib/persona-store.js)
 * carries a real, deterministic Solana wallet and an on-chain identity: balance,
 * ERC-8004-style reputation, token holdings, and a resolved SNS nameplate. The
 * SAME persona_id always re-derives the SAME wallet, on any instance, forever —
 * with NO private key ever stored anywhere and NO private key ever appearing in
 * a tool response, a log line, or an error message.
 *
 * ── Deterministic derivation (the binding scheme) ────────────────────────────
 * seed = HMAC-SHA256(PERSONA_WALLET_SECRET, "three.ws:persona-wallet:v1:" + personaId)
 * keypair = Ed25519 Keypair.fromSeed(seed)   // Solana's Keypair.fromSeed takes
 *                                             // exactly a 32-byte seed — SHA-256's
 *                                             // digest length, no truncation needed.
 *
 * This is a stateless HD-wallet-style derivation, not a stored secret: recovery
 * needs only the persona_id (public) and the server's PERSONA_WALLET_SECRET
 * (never leaves the server). Nothing is written to disk or a database to make a
 * persona wallet "exist" — `personaWalletAddress` is a pure function of its
 * input. The keypair object itself is constructed on demand, used for exactly
 * one signature, and immediately falls out of scope — this module never returns
 * it, logs it, or stores it on any object that escapes the function that made it.
 *
 * ── Domain separation ────────────────────────────────────────────────────────
 * The HMAC "info" string embeds a fixed namespace + version, so this derivation
 * can never collide with any other HMAC/derivation elsewhere in the codebase
 * even if PERSONA_WALLET_SECRET happens to equal another module's secret (e.g.
 * the WALLET_ENCRYPTION_KEY fallback in dev).
 */

import { createHmac } from 'node:crypto';
import { Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import {
	getAssociatedTokenAddressSync, createTransferCheckedInstruction,
	createAssociatedTokenAccountIdempotentInstruction, TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

import { env } from './env.js';
import { solanaConnection } from './agent-pumpfun.js';
import { submitProtected } from './execution-engine.js';
import { USDC_MINT_BY_NETWORK, USDC_DECIMALS } from './vault-jupiter.js';
import { valuateHoldings } from './portfolio.js';
import { solUsdPrice, explorerAccountUrl, explorerTxUrl } from './avatar-wallet.js';
import { solanaReputation } from '../_mcp/tools/solana.js';
import { checkPersonaSpend, recordPersonaSpend, defaultSessionId, PERSONA_SPEND_CAPS } from './persona-spend-ledger.js';
import { fetchUpstreamJson } from './upstream-fetch.js';

const HMAC_DOMAIN = 'three.ws:persona-wallet:v1:';
const SNS_API = 'https://sns-api.bonfida.com';

function netOf(network) {
	return network === 'devnet' ? 'devnet' : 'mainnet';
}

/**
 * Derive the persona's 32-byte Ed25519 seed. Never exported — the seed is as
 * sensitive as the private key it produces (Keypair.fromSeed is deterministic),
 * so it stays fully inside this module's private call graph.
 */
function derivePersonaSeed(personaId) {
	const secret = env.PERSONA_WALLET_SECRET;
	if (!secret) {
		throw Object.assign(new Error('persona wallets are not configured (PERSONA_WALLET_SECRET/WALLET_ENCRYPTION_KEY/JWT_SECRET unset)'), {
			code: 'no_persona_wallet_secret',
		});
	}
	return createHmac('sha256', secret).update(HMAC_DOMAIN + personaId).digest();
}

/**
 * Construct the persona's keypair, hand it to `fn`, then let it be
 * garbage-collected. `fn` MUST NOT return the Keypair, its secretKey, or any
 * derivative of the secret bytes — only `fn`'s own return value escapes this
 * function. This is the ONLY place a persona's signing key is ever constructed.
 */
async function withPersonaKeypair(personaId, fn) {
	const seed = derivePersonaSeed(personaId);
	const keypair = Keypair.fromSeed(seed);
	return fn(keypair);
}

/** The persona's Solana address — deterministic, public, safe to log/return. */
export function personaWalletAddress(personaId) {
	const seed = derivePersonaSeed(personaId);
	// Ed25519 public key derivation from a seed touches no secret material beyond
	// what Keypair.fromSeed already computes; .publicKey is safe to expose.
	return Keypair.fromSeed(seed).publicKey.toBase58();
}

// ── on-chain reads ────────────────────────────────────────────────────────────

/** Native SOL + USDC balance for a persona's address. Never throws. */
export async function getPersonaBalances(address, network = 'mainnet') {
	const net = netOf(network);
	const conn = solanaConnection(net);
	const pk = new PublicKey(address);
	let sol = 0;
	try {
		sol = (await conn.getBalance(pk, 'confirmed')) / LAMPORTS_PER_SOL;
	} catch { /* RPC hiccup — report 0, never fabricate */ }

	let usdc = 0;
	try {
		const mint = new PublicKey(USDC_MINT_BY_NETWORK[net]);
		const ata = getAssociatedTokenAddressSync(mint, pk, false, TOKEN_PROGRAM_ID);
		const info = await conn.getTokenAccountBalance(ata, 'confirmed').catch(() => null);
		usdc = info?.value?.uiAmount || 0;
	} catch { /* no ATA yet, or RPC hiccup — 0 is honest */ }

	let solUsd = null;
	try { solUsd = await solUsdPrice(); } catch { solUsd = null; }

	return {
		sol, usdc,
		sol_usd: solUsd != null ? Number((sol * solUsd).toFixed(4)) : null,
		total_usd: solUsd != null ? Number((sol * solUsd + usdc).toFixed(4)) : null,
	};
}

/**
 * ERC-8004-style reputation, reusing the SAME computed-summary path the paid
 * `solana_agent_reputation` tool exposes (api/_mcp/tools/solana.js), keyed by
 * the persona's own wallet address as its attestation identity. A freshly
 * derived persona wallet legitimately has zero attestations until someone
 * memos one to it — that is real data, not an error.
 */
export async function getPersonaReputation(address, network = 'mainnet') {
	try {
		return await solanaReputation(address, netOf(network));
	} catch {
		// No database configured (local/dev) or an RPC hiccup — degrade to the
		// same honest zero-state shape the live path would report for a fresh
		// wallet, rather than surfacing an internal error to a chat turn.
		return {
			agent: address, network: netOf(network),
			feedback: { total: 0, verified: 0, disputed: 0, score_avg: 0, score_avg_verified: 0 },
			validation: { passed: 0, failed: 0 },
			degraded: true,
		};
	}
}

/** Live holdings (SOL + every priced SPL token) for a persona's address. */
export async function getPersonaHoldings(address, network = 'mainnet') {
	try {
		const { holdings, solUsd } = await valuateHoldings({ network: netOf(network), address });
		const priced = holdings.filter((h) => h.usd != null);
		const totalUsd = priced.reduce((sum, h) => sum + h.usd, 0);
		return {
			count: holdings.length,
			total_usd: Number(totalUsd.toFixed(4)),
			sol_usd_price: solUsd,
			top: [...holdings].sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1)).slice(0, 5).map((h) => ({
				symbol: h.symbol || null, mint: h.mint || null, amount: h.amount, usd: h.usd ?? null,
			})),
			degraded: false,
		};
	} catch {
		return { count: 0, total_usd: 0, sol_usd_price: null, top: [], degraded: true };
	}
}

/**
 * A verified SNS (Solana Name Service) nameplate for the persona's address,
 * reusing the same Bonfida source `ens_sns_resolve` reads from — in reverse:
 * given the address, does it hold a favourite .sol domain? ENS reverse lookup
 * does not apply here (persona wallets are Solana addresses, not 0x EVM
 * addresses); when a persona's wallet is bridged to an EVM identity in the
 * future, the same ens_sns_resolve forward path already covers .eth names.
 * Best-effort — a Bonfida outage degrades to `{ name: null, verified: false }`,
 * never an error.
 */
export async function getPersonaNameplate(address) {
	try {
		const body = await fetchUpstreamJson(`${SNS_API}/v2/user/fav-domains/${address}`, {}, { name: 'bonfida-sns', timeoutMs: 5_000, attempts: 2 });
		const fav = body?.[address] || body?.data?.[address] || null;
		const name = typeof fav === 'string' ? fav : fav?.domain || fav?.name || null;
		if (name) return { name: name.endsWith('.sol') ? name : `${name}.sol`, verified: true, source: 'sns' };
	} catch { /* best effort */ }
	return { name: null, verified: false, source: 'sns' };
}

// ── pure visual-tier mappings (network-free, unit-testable) ──────────────────

/** Reputation → a discrete trust tier the viewer maps to an aura. */
export function reputationTierFor(reputation) {
	const fb = reputation?.feedback || {};
	const verified = Number(fb.verified || 0);
	const avg = Number(fb.score_avg_verified || 0);
	const disputed = Number(fb.disputed || 0);
	if (disputed > 0 && disputed >= verified) return 'disputed';
	if (verified >= 15 && avg >= 4.5) return 'eminent';
	if (verified >= 3 && avg >= 4) return 'trusted';
	if (Number(fb.total || 0) > 0) return 'emerging';
	return 'unranked';
}

/** Live USD holdings total → a discrete cosmetic tier. */
export function holdingsTierFor(totalUsd) {
	const usd = Number(totalUsd || 0);
	if (usd >= 1000) return 'platinum';
	if (usd >= 100) return 'gold';
	if (usd >= 10) return 'silver';
	if (usd > 0) return 'bronze';
	return 'none';
}

/** Balance floor under which the body renders in a designed "muted" state. */
export const MUTED_BALANCE_USD_FLOOR = Number(process.env.PERSONA_MUTED_USD_FLOOR || 0.05);
export function isMutedBalance(balances) {
	const total = balances?.total_usd;
	if (total == null) return balances?.sol === 0 && balances?.usdc === 0;
	return total < MUTED_BALANCE_USD_FLOOR;
}

// ── the composed identity read ────────────────────────────────────────────────

/**
 * `persona_identity` — the full read: address, live balances, reputation,
 * holdings, nameplate, plus the derived visual tiers the viewer consumes
 * directly. Every sub-read degrades independently (never throws), so a single
 * flaky upstream (Bonfida, an RPC, the attestation index) never blanks the
 * whole card — each field reports its own honest fallback.
 */
export async function getPersonaIdentity(personaId, { network = 'mainnet' } = {}) {
	const address = personaWalletAddress(personaId);
	const net = netOf(network);
	const [balances, reputation, holdings, nameplate] = await Promise.all([
		getPersonaBalances(address, net),
		getPersonaReputation(address, net),
		getPersonaHoldings(address, net),
		getPersonaNameplate(address),
	]);

	return {
		persona_id: personaId,
		address,
		network: net,
		explorer: explorerAccountUrl(address, net),
		balances,
		reputation,
		holdings,
		nameplate,
		visual: {
			reputation_tier: reputationTierFor(reputation),
			holdings_tier: holdingsTierFor(holdings.total_usd),
			muted: isMutedBalance(balances),
			verified_name: nameplate.verified ? nameplate.name : null,
		},
		caps: PERSONA_SPEND_CAPS,
		fetched_at: new Date().toISOString(),
	};
}

// ── guarded value ops (persona_tip / persona_send) ────────────────────────────

/**
 * Send USDC from a persona's own wallet to a destination address — the shared
 * implementation behind `persona_tip` and `persona_send`. Fully guarded:
 *   1. checkPersonaSpend() enforces the per-call AND per-session USDC caps
 *      BEFORE any key is touched — a breach never gets near a signature.
 *   2. Real settlement rides the SAME MEV-aware execution engine
 *      (submitProtected) every other outbound transfer on the platform uses.
 *   3. recordPersonaSpend() durably logs the settled amount so the session cap
 *      is enforceable across process restarts / instances.
 * Returns a structured result; only ever throws on a caller error (bad address)
 * BEFORE any spend is reserved.
 */
export async function sendPersonaUsdc({ personaId, sessionId, to, usdc, tool = 'persona_send', network = 'mainnet', memo }) {
	const net = netOf(network);
	const amount = Number(usdc);
	const session = sessionId || defaultSessionId(personaId);

	let toPk;
	try { toPk = new PublicKey(to); } catch {
		return { status: 'failed', code: 'bad_address', message: 'That does not look like a valid Solana address.' };
	}
	const fromAddress = personaWalletAddress(personaId);
	if (toPk.toBase58() === fromAddress) {
		return { status: 'failed', code: 'self_payment', message: 'A persona cannot tip itself.' };
	}

	const gate = await checkPersonaSpend({ personaId, sessionId: session, usdc: amount });
	if (!gate.ok) return { status: 'blocked', ...gate };

	const conn = solanaConnection(net);
	const mintPk = new PublicKey(USDC_MINT_BY_NETWORK[net]);
	const raw = BigInt(Math.max(0, Math.round(amount * 10 ** USDC_DECIMALS)));

	let signature;
	try {
		signature = await withPersonaKeypair(personaId, async (keypair) => {
			const fromAta = getAssociatedTokenAddressSync(mintPk, keypair.publicKey, false, TOKEN_PROGRAM_ID);
			const toAta = getAssociatedTokenAddressSync(mintPk, toPk, false, TOKEN_PROGRAM_ID);
			const instructions = [
				createAssociatedTokenAccountIdempotentInstruction(keypair.publicKey, toAta, toPk, mintPk, TOKEN_PROGRAM_ID),
				createTransferCheckedInstruction(fromAta, mintPk, toAta, keypair.publicKey, raw, USDC_DECIMALS, [], TOKEN_PROGRAM_ID),
			];
			const result = await submitProtected({
				network: net, connection: conn, payer: keypair, instructions,
				opts: { tipMode: 'off', confirmTimeoutMs: 45_000 },
			});
			return result.signature;
		});
	} catch (e) {
		return { status: 'failed', code: e?.code || 'send_failed', message: (e?.message || 'the transfer did not settle').slice(0, 200) };
	}

	await recordPersonaSpend({ personaId, sessionId: session, usdc: amount, tool, toAddress: toPk.toBase58(), signature }).catch(() => {});

	return {
		status: 'ok',
		signature,
		explorer: explorerTxUrl(signature, net),
		from: fromAddress,
		to: toPk.toBase58(),
		usdc: amount,
		network: net,
		session_id: session,
		session_spent_usdc: Number((gate.spent_usdc + amount).toFixed(6)),
		session_cap_usdc: PERSONA_SPEND_CAPS.maxPerSessionUsdc,
		memo: memo || null,
	};
}
