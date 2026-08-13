// Registry for agent-published paid x402 services (the `monetize_endpoint` tool).
//
// An agent points `monetize_endpoint` at an upstream it already serves and a
// price; we persist a row here and three.ws hosts the paywall at
// /api/x402/service/<slug>. The hosted endpoint (api/x402/service.js) reads the
// row per request to build the 402 challenge, settle the buyer's USDC to the
// agent's own payout wallet, and proxy the call to `target_url`. The same rows
// feed the /.well-known/x402.json discovery doc so facilitators — and therefore
// find_services / the bazaar — index the listing.

import { randomUUID } from 'node:crypto';
import { sql } from './db.js';
import { env } from './env.js';
import { assertPublicHttpsUrl, SsrfError } from './ssrf.js';

export class MonetizeError extends Error {
	constructor(message, code = 'monetize_error', status = 400) {
		super(message);
		this.name = 'MonetizeError';
		this.code = code;
		this.status = status;
	}
}

// USDC has 6 decimals. Convert a human dollar price to atomic units (string).
export function usdcToAtomics(priceUsdc) {
	const n = Number(priceUsdc);
	if (!Number.isFinite(n) || n <= 0) {
		throw new MonetizeError('price_usdc must be a number greater than 0', 'invalid_price');
	}
	const atomics = Math.round(n * 1_000_000);
	if (atomics < 1) {
		throw new MonetizeError('price_usdc is below the $0.000001 minimum', 'invalid_price');
	}
	return String(atomics);
}

export function atomicsToUsdc(atomics) {
	return Number(atomics || 0) / 1_000_000;
}

// The hosted resource URL a buyer (and pay_and_call) hits for this service.
export function serviceResourceUrl(slug) {
	return `${env.APP_ORIGIN}/api/x402/service/${slug}`;
}

// Build a slug from the service name plus a short unique suffix so two agents
// can both publish a "Weather API" without colliding. Always satisfies the
// table's CHECK: starts/ends alphanumeric, kebab middle, length 3–64.
function buildSlug(name) {
	const base = String(name || '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 40)
		.replace(/-+$/g, '');
	const suffix = randomUUID().replace(/-/g, '').slice(0, 8);
	const stem = base.length >= 1 ? base : 'service';
	return `${stem}-${suffix}`;
}

// SSRF-validate the upstream URL. Public https only (the resolver rejects
// private / loopback / cloud-metadata targets). Throws MonetizeError so the MCP
// boundary can render a clean message.
export async function validateTargetUrl(rawUrl) {
	try {
		return await assertPublicHttpsUrl(rawUrl);
	} catch (err) {
		if (err instanceof SsrfError) {
			throw new MonetizeError(
				`target_url rejected: ${err.message}`,
				'invalid_target_url',
				400,
			);
		}
		throw err;
	}
}

// Resolve the agent's own payout wallet for the requested settlement network.
// solana → meta.solana_address (provisioned by provision_wallet); base → the
// agent's EVM wallet_address. Returns null when the prerequisite wallet is
// missing so the caller can tell the agent to provision_wallet first.
export function resolvePayoutAddress({ network, agentRow }) {
	if (network === 'solana') return agentRow?.meta?.solana_address || null;
	return agentRow?.wallet_address || null;
}

/**
 * Create (and list) a priced x402 wrapper for one of the caller's agents.
 *
 * @param {{
 *   ownerUserId: string, agentId: string, name: string, description: string,
 *   priceUsdc: number, targetUrl: string, method?: 'GET'|'POST',
 *   inputSchema?: object|null, network?: 'base'|'solana', payoutAddress: string,
 * }} input
 * @returns {Promise<object>} the persisted service row (camel fields preserved as-is)
 */
export async function createPaidService(input) {
	const {
		ownerUserId,
		agentId,
		name,
		description,
		priceUsdc,
		targetUrl,
		method = 'POST',
		inputSchema = null,
		network = 'base',
		payoutAddress,
	} = input;

	const priceAtomics = usdcToAtomics(priceUsdc);
	const upperMethod = String(method).toUpperCase() === 'GET' ? 'GET' : 'POST';
	const net = network === 'solana' ? 'solana' : 'base';
	const schemaJson = inputSchema ? JSON.stringify(inputSchema) : null;

	// Retry on the (extremely unlikely) slug collision rather than failing the
	// agent's publish on a random 8-char suffix clash.
	let lastErr = null;
	for (let attempt = 0; attempt < 4; attempt++) {
		const slug = buildSlug(name);
		try {
			const [row] = await sql`
				INSERT INTO agent_paid_services
					(owner_user_id, agent_id, slug, name, description, price_atomics,
					 target_url, target_method, input_schema, network, payout_address)
				VALUES (
					${ownerUserId}, ${agentId}, ${slug}, ${name}, ${description}, ${priceAtomics},
					${targetUrl}, ${upperMethod}, ${schemaJson}::jsonb, ${net}, ${payoutAddress}
				)
				RETURNING id, slug, name, description, price_atomics, target_url, target_method,
				          input_schema, network, payout_address, bazaar_listed, created_at
			`;
			return row;
		} catch (err) {
			// 23505 = unique_violation on slug; regenerate and retry.
			if (err?.code === '23505' || /duplicate key|unique/i.test(err?.message || '')) {
				lastErr = err;
				continue;
			}
			throw err;
		}
	}
	// Every retry collided. Report it as the designed slug_alloc_failed rather
	// than rethrowing the driver's unique-violation: the sole caller (the
	// monetize_endpoint MCP tool) answers a MonetizeError with a structured
	// { ok:false, reason } an agent can act on, while a raw pg error reaches it
	// as an opaque sanitized string. The driver detail rides along as `cause`
	// for the logs without leaking into the message.
	const exhausted = new MonetizeError(
		'could not allocate a unique service slug, try a different name',
		'slug_alloc_failed',
		500,
	);
	exhausted.cause = lastErr;
	throw exhausted;
}

// Fetch one active service by slug for the hosted paywall to serve.
export async function getActiveServiceBySlug(slug) {
	if (!slug || typeof slug !== 'string') return null;
	const [row] = await sql`
		SELECT id, owner_user_id, agent_id, slug, name, description, price_atomics,
		       target_url, target_method, input_schema, network, payout_address,
		       bazaar_listed, created_at
		FROM agent_paid_services
		WHERE slug = ${slug} AND archived_at IS NULL
		LIMIT 1
	`;
	return row || null;
}

// Active, bazaar-listed services for the discovery doc. Capped so a flood of
// listings can't bloat the heavily-crawled /.well-known/x402.json payload.
export async function listBazaarServices({ limit = 200 } = {}) {
	const capped = Math.min(Math.max(1, limit | 0 || 200), 500);
	const rows = await sql`
		SELECT slug, name, description, price_atomics, target_method,
		       input_schema, network, payout_address
		FROM agent_paid_services
		WHERE archived_at IS NULL AND bazaar_listed = true
		ORDER BY created_at DESC
		LIMIT ${capped}
	`;
	return rows;
}
