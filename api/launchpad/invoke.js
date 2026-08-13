// POST /api/launchpad/invoke?slug=<slug>[&action=unlock]
//
// The paid action behind a published Launchpad Studio page. Two templates use
// it; the third (token-launchpad) does not, it redirects to /launch instead.
//
//   • paid-concierge  → an x402-gated Q&A. The visitor pays the page's per-call
//     price (USDC) to the CREATOR's wallet, then receives an answer generated
//     on the platform's free-first LLM chain, grounded in the page's brand copy.
//   • gated-showroom  → an x402-gated unlock. Paying the one-time pass returns
//     the private scene URL, which the public read withholds.
//
// This is a real x402 v2 endpoint with DYNAMIC pricing and payout: the price
// and the recipient (`payTo`) are read per-slug from the published page's
// `monetize` config and `identity.wallet`, not from a static route config. We
// compose the spec-level primitives (send402 / verifyPayment / settlePayment)
// directly rather than paidEndpoint(), because paidEndpoint binds price + payTo
// at module load and cannot settle to an arbitrary creator wallet per request.
//
// Flow (x402 dance):
//   1. No X-PAYMENT header  → 402 with a real challenge (amount, payTo, asset,
//      network) the caller's x402 wallet/agent fulfills.
//   2. X-PAYMENT header     → verify against the same requirement → fulfill →
//      settle on-chain → 200 with the result + X-PAYMENT-RESPONSE header.

import { sql } from '../_lib/db.js';
import { cors, error, json, method, rateLimited, readJson, wrap } from '../_lib/http.js';
import { env } from '../_lib/env.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { llmComplete } from '../_lib/llm.js';
import {
	NETWORK_BASE_MAINNET,
	NETWORK_SOLANA_MAINNET,
	encodePaymentResponseHeader,
	resolveResourceUrl,
	send402,
	settlePayment,
	verifyPayment,
} from '../_lib/x402-spec.js';
import { reservePaymentProof } from '../_lib/x402/payment-identifier-server.js';
import { declareHttpDiscovery } from '../_lib/x402/bazaar-helpers.js';

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_RE = /^0x[a-fA-F0-9]{40}$/;
const USDC_DECIMALS = 6;

// Map the page's configured chain to an x402 network id + an address validator.
// Only chains the facilitator can settle are accepted; an unsupported chain is
// surfaced as a clear 422 rather than a broken 402.
const CHAINS = {
	base: { network: NETWORK_BASE_MAINNET, valid: (w) => EVM_RE.test(w), label: 'Base' },
	solana: { network: NETWORK_SOLANA_MAINNET, valid: (w) => SOL_RE.test(w), label: 'Solana' },
};

function priceToAtomics(price) {
	const n = Number(price);
	if (!isFinite(n) || n <= 0) return null;
	// USDC is 6dp. Round to the nearest atomic unit and reject sub-atomic dust.
	const atomics = Math.round(n * 10 ** USDC_DECIMALS);
	return atomics > 0 ? String(atomics) : null;
}

function buildAccept({ chain, priceAtomics, payTo, resourceUrl }) {
	const common = {
		scheme: 'exact',
		amount: priceAtomics,
		maxTimeoutSeconds: 60,
		resource: resourceUrl,
	};
	if (chain.network === NETWORK_BASE_MAINNET) {
		return {
			...common,
			network: NETWORK_BASE_MAINNET,
			payTo,
			asset: env.X402_ASSET_ADDRESS_BASE,
			// Base USDC's EIP-712 domain name is "USD Coin", must match on-chain.
			extra: { name: 'USD Coin', version: '2', decimals: USDC_DECIMALS },
		};
	}
	return {
		...common,
		network: NETWORK_SOLANA_MAINNET,
		payTo,
		asset: env.X402_ASSET_MINT_SOLANA,
		extra: { name: 'USDC', decimals: USDC_DECIMALS, feePayer: env.X402_FEE_PAYER_SOLANA },
	};
}

// Discovery metadata for the 402 challenge. build402Body() otherwise falls back
// to the MCP server's default entry, which told every crawler that a launchpad
// page takes a `tools/call` body for `validate_model`, an agent that indexed a
// concierge page from that would never send the one field it actually needs.
const CONCIERGE_BAZAAR = declareHttpDiscovery({
	method: 'POST',
	bodyType: 'json',
	input: { question: 'What does this project do?' },
	inputSchema: {
		$schema: 'https://json-schema.org/draft/2020-12/schema',
		type: 'object',
		required: ['question'],
		properties: {
			question: {
				type: 'string',
				minLength: 3,
				maxLength: 2000,
				description: "The visitor question, answered in the page owner's voice.",
			},
		},
	},
	output: {
		example: {
			slug: 'my-page',
			action: 'ask',
			answer: 'It is a 3D agent storefront you can talk to.',
			model: 'gemini-2.5-flash',
		},
		schema: {
			$schema: 'https://json-schema.org/draft/2020-12/schema',
			type: 'object',
			required: ['slug', 'action', 'answer'],
			properties: {
				slug: { type: 'string' },
				action: { type: 'string', const: 'ask' },
				answer: { type: 'string' },
				model: { type: ['string', 'null'] },
				payer: { type: ['string', 'null'] },
				transaction: { type: ['string', 'null'] },
				network: { type: 'string' },
			},
		},
	},
});

const UNLOCK_BAZAAR = declareHttpDiscovery({
	method: 'POST',
	bodyType: 'json',
	input: {},
	inputSchema: {
		$schema: 'https://json-schema.org/draft/2020-12/schema',
		type: 'object',
		properties: {},
		description: 'No body fields, the slug in the query string selects the showroom.',
	},
	output: {
		example: {
			slug: 'my-showroom',
			action: 'unlock',
			unlockUrl: 'https://three.ws/cdn/scenes/private.glb',
		},
		schema: {
			$schema: 'https://json-schema.org/draft/2020-12/schema',
			type: 'object',
			required: ['slug', 'action', 'unlockUrl'],
			properties: {
				slug: { type: 'string' },
				action: { type: 'string', const: 'unlock' },
				unlockUrl: { type: 'string', description: 'The private scene URL, revealed on payment.' },
				payer: { type: ['string', 'null'] },
				transaction: { type: ['string', 'null'] },
				network: { type: 'string' },
			},
		},
	},
});

async function loadPage(slug) {
	const [row] = await sql`
		SELECT slug, template, owner_wallet, config
		FROM launchpad_pages
		WHERE slug = ${slug} AND is_public = true
	`;
	return row || null;
}

async function fulfillConcierge({ page, body }) {
	const question = String(body?.question || '').trim();
	if (question.length < 3) {
		const err = new Error('Type a question (at least 3 characters).');
		err.status = 400;
		err.code = 'invalid_question';
		throw err;
	}
	const c = page.config || {};
	const headline = c.copy?.headline || c.identity?.brand || page.slug;
	const tagline = c.copy?.tagline || '';
	const system =
		`You are the concierge for "${headline}". ${tagline} ` +
		'Answer the visitor concisely and helpfully in plain language. ' +
		'If the question is unrelated or something you cannot know, say so briefly rather than inventing an answer.';
	const result = await llmComplete({
		system,
		user: question.slice(0, 2000),
		maxTokens: 600,
		track: { surface: 'launchpad-concierge', slug: page.slug },
	});
	return {
		answer: (result?.text || '').trim() || 'No answer was generated, please try again.',
		model: result?.model || null,
	};
}

function fulfillUnlock({ page }) {
	// The scene URL is withheld from the public /api/launchpad/get response for
	// gated-showroom pages (see get.js), paying here is the only way to obtain
	// it, so returning it after settlement IS the unlock.
	const sceneSrc = page.config?.scene?.src || '';
	if (!sceneSrc) {
		const err = new Error('This showroom has no scene configured yet.');
		err.status = 422;
		err.code = 'scene_missing';
		throw err;
	}
	return { unlockUrl: sceneSrc };
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['POST'])) return;

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl, 'too many requests, slow down');

	const url = new URL(req.url, 'http://x');
	const slug = (url.searchParams.get('slug') || '').toLowerCase();
	if (!SLUG_RE.test(slug)) return error(res, 400, 'validation_error', 'invalid slug');

	const page = await loadPage(slug);
	if (!page) return error(res, 404, 'not_found', 'no launchpad at that slug');

	// Resolve the action from the template. token-launchpad has no paid action.
	const isUnlock = page.template === 'gated-showroom';
	const isConcierge = page.template === 'paid-concierge';
	if (!isUnlock && !isConcierge) {
		return error(
			res,
			400,
			'no_paid_action',
			'this launchpad has no paid action, token launches happen at /launch',
		);
	}

	const monetize = page.config?.monetize || {};
	const currency = String(monetize.currency || '').toUpperCase();
	if (currency && currency !== 'USDC') {
		return error(res, 422, 'unsupported_currency', 'paid launchpad actions settle in USDC');
	}
	const chain = CHAINS[String(monetize.chain || 'base').toLowerCase()];
	if (!chain) {
		return error(
			res,
			422,
			'unsupported_chain',
			'this page is configured for an unsupported chain',
		);
	}

	const priceAtomics = priceToAtomics(monetize.price);
	if (!priceAtomics) {
		return error(res, 422, 'invalid_price', 'this page has no valid price configured');
	}

	const payTo = page.config?.identity?.wallet || page.owner_wallet || '';
	if (!chain.valid(payTo)) {
		return error(
			res,
			422,
			'payout_unconfigured',
			`this page's payout wallet is not a valid ${chain.label} address`,
		);
	}

	const action = isUnlock ? 'unlock' : 'ask';
	const resourceUrl = resolveResourceUrl(
		req,
		`/api/launchpad/invoke?slug=${slug}&action=${action}`,
	);
	const accept = buildAccept({ chain, priceAtomics, payTo, resourceUrl });

	const paymentHeader = (req.headers['x-payment'] || '').toString().trim();

	// Read the request body up front (question / unused for unlock). Safe to read
	// even on the 402 path, verifyPayment only consumes the X-PAYMENT header.
	const body = await readJson(req).catch(() => ({}));

	// ── Unpaid: issue the real 402 challenge ───────────────────────────────────
	if (!paymentHeader) {
		await send402(res, {
			resourceUrl,
			accepts: [accept],
			error: 'X-PAYMENT header is required',
			description: isUnlock
				? `Unlock the "${page.config?.copy?.headline || slug}" showroom, one-time USDC pass.`
				: `Ask the "${page.config?.copy?.headline || slug}" concierge, pay-per-question in USDC.`,
			serviceName: `launchpad:${slug}`,
			tags: [isUnlock ? 'unlock' : 'concierge', 'launchpad', '3d'],
			bazaar: isUnlock ? UNLOCK_BAZAAR : CONCIERGE_BAZAAR,
		});
		return;
	}

	// ── Paid: verify → fulfill → settle → respond ──────────────────────────────
	// Replay guard (parity with paidEndpoint): hold a single-use lock on the
	// signed payment proof across fulfill+settle so a captured/retried X-PAYMENT
	// can't re-run the concierge LLM call before the first settle lands. Released
	// in the finally; the consumed on-chain nonce blocks any replay thereafter.
	const proofGuard = await reservePaymentProof(
		`/api/launchpad/invoke:${slug}:${action}`,
		paymentHeader,
	);
	if (!proofGuard.ok) {
		return error(
			res,
			409,
			'payment_in_flight',
			'a request with this payment is already being processed; retry shortly',
		);
	}

	try {
		let verified;
		try {
			verified = await verifyPayment({ paymentHeader, requirements: [accept] });
		} catch (err) {
			return error(
				res,
				err.status || 402,
				err.code || 'payment_invalid',
				err.message || 'payment verification failed',
			);
		}

		let result;
		try {
			result = isUnlock ? fulfillUnlock({ page }) : await fulfillConcierge({ page, body });
		} catch (err) {
			return error(
				res,
				err.status || 500,
				err.code || 'fulfillment_failed',
				err.message || 'could not fulfill request',
			);
		}

		let settled;
		try {
			settled = await settlePayment({ verified });
		} catch (err) {
			return error(
				res,
				err.status || 502,
				err.code || 'settle_failed',
				err.message || 'payment settlement failed',
			);
		}

		res.setHeader('X-PAYMENT-RESPONSE', encodePaymentResponseHeader(settled));
		return json(res, 200, {
			slug,
			action,
			payer: settled.payer || verified?.payer || null,
			transaction: settled.transaction || null,
			network: settled.network || accept.network,
			...result,
		});
	} finally {
		await proofGuard.release();
	}
});
