/**
 * Pump.fun agent-skill HTTP 402 manifest helpers.
 *
 * NOTE: this module is NOT the Coinbase x402 v2 wire spec — that lives in
 * `api/_lib/x402-spec.js`. This file implements an internal Pump.fun
 * agent-skill payment flow that *also* uses HTTP 402 as the negotiation
 * status, but with its own manifest format (`version: "x402/0.1"`,
 * `kind: "agent-skill"`), retry header (`x-payment-intent`), and
 * server-side payment pipeline (`/api/agents/payments/pay-prep` +
 * `/pay-confirm`). The two flows are deliberately separate.
 *
 * Used by /api/agents/x402/[action].js (invoke + manifest) for per-skill
 * billing on agent-hosted skills.
 *

 * Server-side flow:
 *   1. Caller hits a paid endpoint.
 *   2. We look for a payment proof header (x-payment-intent or
 *      x-payment-tx-sig). If missing or unpaid, emit 402 with a manifest:
 *
 *        HTTP/1.1 402 Payment Required
 *        Content-Type: application/json
 *
 *        {
 *          "version":      "x402/0.1",
 *          "kind":         "agent-skill",
 *          "agent_id":     "...",
 *          "skill":        "summarize",
 *          "amount":       "1000000",       // raw token units (string-bigint)
 *          "currency":     "<mint base58>", // e.g. USDC
 *          "recipient":    "<owner wallet>",
 *          "memo":         "<u64 invoice nonce>",
 *          "valid_until":  "<unix>",
 *          "intent_url":   "/api/agents/payments/pay-prep",
 *          "verify_url":   "/api/agents/payments/pay-confirm"
 *        }
 *
 *   3. Caller follows the manifest, pays via /pay-prep + wallet sign +
 *      /pay-confirm, gets back an `intent_id`. They retry the original call
 *      with `x-payment-intent: <intent_id>`.
 *   4. We verify the intent is `status='paid'` for this agent + skill +
 *      caller, then proceed.
 *
 * The 402 response is cached by the spec to be idempotent — a caller may
 * request the manifest, sit on it, and pay later. We honor that by NOT
 * minting an intent until the caller calls `/pay-prep`.
 */

import { sql } from './db.js';
import { json, error } from './http.js';
import { resolveSnsName } from '../../src/solana/sns.js';

export const X402_VERSION = 'x402/0.1';

const SNS_NAME_RE = /^[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63})*\.sol$/i;

// Resolve the manifest's `recipient` to a concrete base58 wallet, and surface
// the human-readable .sol name in `recipient_name` whenever one is available.
//
// Inputs in priority order:
//   1. `payments.receiver` — already a base58 wallet (most agents today).
//   2. `payments.receiver` set to a .sol or subdomain — resolve via SNS.
//   3. `agent.meta.sns_domain` — preferred display name even when receiver
//      is a base58 wallet, so x402 clients can show "paying nich.threews.sol"
//      instead of a raw key.
async function resolveRecipient({ agent, payments }) {
	const receiver = payments?.receiver;
	const metaName = agent?.meta?.sns_domain || null;
	const metaNameFull = metaName
		? (metaName.endsWith('.sol') ? metaName : `${metaName}.sol`)
		: null;

	if (typeof receiver === 'string' && SNS_NAME_RE.test(receiver)) {
		const resolved = await resolveSnsName(receiver);
		return { recipient: resolved || null, recipient_name: receiver.toLowerCase() };
	}
	return { recipient: receiver || null, recipient_name: metaNameFull };
}

/**
 * Emit a 402 Payment Required response with a canonical manifest body.
 *
 * @param {import('http').ServerResponse} res
 * @param {object} opts
 * @param {object} opts.agent       Agent record (must have meta.payments configured).
 * @param {string} opts.skill       Skill identifier (free-form, used by the manifest).
 * @param {string} opts.amount      Raw token units as a numeric string.
 * @param {string} opts.currency    Mint pubkey (base58) for the currency token.
 * @param {number} [opts.validForSec=900]  Manifest validity in seconds (default 15m).
 */
export async function emit402(res, { agent, skill, amount, currency, validForSec = 900 }) {
	const payments = agent?.meta?.payments || agent?.payments;
	if (!payments?.configured) {
		// Misconfigured: we shouldn't gate a skill behind 402 if payments aren't on.
		return error(res, 500, 'misconfigured', 'agent has no payments config');
	}
	const { recipient, recipient_name } = await resolveRecipient({ agent, payments });
	if (!recipient) {
		return error(res, 412, 'recipient_unresolved', 'agent payments.receiver could not be resolved to a wallet');
	}
	const validUntil = Math.floor(Date.now() / 1000) + validForSec;
	const manifest = {
		version: X402_VERSION,
		kind: 'agent-skill',
		agent_id: agent.id,
		skill,
		amount: String(amount),
		currency,
		recipient,
		recipient_name,
		memo: String(Math.floor(Date.now() / 1000)),
		valid_until: validUntil,
		intent_url: '/api/agents/payments/pay-prep',
		verify_url: '/api/agents/payments/pay-confirm',
		retry_with_header: 'x-payment-intent',
	};
	res.statusCode = 402;
	res.setHeader('content-type', 'application/json');
	res.setHeader('cache-control', 'no-store');
	// Hint the canonical manifest URL so x402 clients can prefetch.
	res.setHeader(
		'link',
		`</.well-known/x402>; rel="payment-config", </api/agents/${agent.id}/x402/${encodeURIComponent(skill)}/manifest>; rel="payment-manifest"`,
	);
	res.end(JSON.stringify(manifest));
	return true;
}

/**
 * Read x-payment-intent (or x-payment-tx-sig) headers and verify the request
 * is paid for `agentId` + `skill`. Returns the verified intent row, or null
 * if not paid (caller should `emit402`).
 *
 * @param {import('http').IncomingMessage} req
 * @param {{ agentId: string, skill: string, expectedAmount?: string, expectedCurrency?: string }} ctx
 * @returns {Promise<null | { intentId: string, amount: string, currency: string, paidAt: Date }>}
 */
export async function verifyPaid(req, { agentId, skill, expectedAmount, expectedCurrency }) {
	const intentId = (req.headers['x-payment-intent'] || '').toString().trim();
	if (!intentId) return null;

	const [row] = await sql`
		select id, agent_id, currency_mint, amount, status, paid_at, payload, end_time
		from agent_payment_intents
		where id = ${intentId} and agent_id = ${agentId}
		limit 1
	`;
	if (!row) return null;
	if (row.status !== 'paid') return null;
	if (row.end_time && new Date(row.end_time).getTime() < Date.now()) return null;

	if (expectedAmount && String(row.amount) !== String(expectedAmount)) return null;
	if (expectedCurrency && row.currency_mint !== expectedCurrency) return null;

	// Bind the intent to the requested skill if the caller stored it. Skill
	// metadata lives in payload — older intents may not have it, in which
	// case we treat the absence as "any skill".
	const intentSkill = row.payload?.skill;
	if (intentSkill && intentSkill !== skill) return null;

	return {
		intentId: row.id,
		amount: row.amount,
		currency: row.currency_mint,
		paidAt: row.paid_at,
		payerAddress: row.payload?.wallet_address ?? null,
	};
}

/**
 * Convenience: complete a paid call. Marks the intent as `consumed` so it
 * can't be reused — paid intents are single-shot per spec.
 */
export async function consumeIntent(intentId) {
	await sql`
		update agent_payment_intents
		set status = 'consumed'
		where id = ${intentId} and status = 'paid'
	`;
}

/**
 * Helper: respond with the manifest only (no 402), for prefetch/discovery
 * via `GET /api/agents/:id/x402/:skill/manifest`.
 */
export async function manifestOnly(res, opts) {
	const validUntil = Math.floor(Date.now() / 1000) + (opts.validForSec || 900);
	const payments = opts.agent.meta?.payments || opts.agent.payments;
	const { recipient, recipient_name } = await resolveRecipient({ agent: opts.agent, payments });
	return json(res, 200, {
		version: X402_VERSION,
		kind: 'agent-skill',
		agent_id: opts.agent.id,
		skill: opts.skill,
		amount: String(opts.amount),
		currency: opts.currency,
		recipient,
		recipient_name,
		valid_until: validUntil,
		intent_url: '/api/agents/payments/pay-prep',
		verify_url: '/api/agents/payments/pay-confirm',
		retry_with_header: 'x-payment-intent',
	});
}
