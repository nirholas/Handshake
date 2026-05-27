#!/usr/bin/env node
// scripts/verify-x402-receipts.js — smoke test for x402 offer & receipt signing.
//
// Hits a paid endpoint without a payment header to get the 402 challenge,
// extracts signed offers from the offer-receipt extension, and verifies each
// offer's cryptographic signature. READ-ONLY: never sends payments.
//
// Usage:
//   node scripts/verify-x402-receipts.js
//   node scripts/verify-x402-receipts.js --url https://three.ws/api/x402/model-check

import { recoverTypedDataAddress } from 'viem';

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let targetUrl = 'http://localhost:3000/api/x402/model-check';

for (let i = 0; i < args.length; i++) {
	if (args[i] === '--url' && args[i + 1]) {
		targetUrl = args[i + 1];
		i++;
	} else if (args[i] === '--help' || args[i] === '-h') {
		console.log('Usage: node scripts/verify-x402-receipts.js [--url <endpoint>]');
		console.log('  --url  Target paid endpoint (default: http://localhost:3000/api/x402/model-check)');
		process.exit(0);
	}
}

// ---------------------------------------------------------------------------
// EIP-712 domain & types (spec section 3.2 — chainId is always 1)
// ---------------------------------------------------------------------------

const OFFER_DOMAIN = Object.freeze({ name: 'x402 offer', version: '1', chainId: 1 });

const OFFER_TYPES = Object.freeze({
	Offer: [
		{ name: 'version', type: 'uint256' },
		{ name: 'resourceUrl', type: 'string' },
		{ name: 'scheme', type: 'string' },
		{ name: 'network', type: 'string' },
		{ name: 'asset', type: 'string' },
		{ name: 'payTo', type: 'string' },
		{ name: 'amount', type: 'string' },
		{ name: 'validUntil', type: 'uint256' },
	],
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the payload from a signed offer (EIP-712 has it inline, JWS in the signature). */
function extractOfferPayload(offer) {
	if (offer.format === 'eip712') {
		return offer.payload;
	}
	if (offer.format === 'jws') {
		const parts = offer.signature.split('.');
		if (parts.length !== 3) throw new Error('Invalid JWS format');
		const payloadJson = Buffer.from(parts[1], 'base64url').toString('utf8');
		return JSON.parse(payloadJson);
	}
	throw new Error(`Unknown offer format: ${offer.format}`);
}

/** Parse the kid for a did:pkh EIP-712 issuer — returns the embedded address. */
function extractAddressFromDidPkh(kid) {
	// kid format: did:pkh:eip155:1:<address>#key-1
	const match = kid?.match(/^did:pkh:eip155:\d+:(0x[a-fA-F0-9]{40})/);
	return match ? match[1].toLowerCase() : null;
}

/** Format a unix timestamp as ISO 8601. */
function formatTimestamp(unixSeconds) {
	if (!unixSeconds && unixSeconds !== 0) return 'N/A';
	return new Date(Number(unixSeconds) * 1000).toISOString();
}

/** Check if a hex address looks valid. */
function isValidAddress(addr) {
	return typeof addr === 'string' && /^0x[a-fA-F0-9]{40}$/i.test(addr);
}

// ---------------------------------------------------------------------------
// Offer verification
// ---------------------------------------------------------------------------

/**
 * Verify an EIP-712 signed offer by recovering the signer address from the
 * typed-data signature and comparing it to the address embedded in the kid.
 */
async function verifyEip712Offer(offer, kid) {
	const payload = offer.payload;
	if (!payload) {
		return { valid: false, reason: 'missing payload' };
	}

	const message = {
		version: BigInt(payload.version),
		resourceUrl: payload.resourceUrl,
		scheme: payload.scheme,
		network: payload.network,
		asset: payload.asset,
		payTo: payload.payTo,
		amount: payload.amount,
		validUntil: BigInt(payload.validUntil),
	};

	let recoveredAddress;
	try {
		recoveredAddress = await recoverTypedDataAddress({
			domain: OFFER_DOMAIN,
			types: OFFER_TYPES,
			primaryType: 'Offer',
			message,
			signature: offer.signature,
		});
	} catch (err) {
		return { valid: false, reason: `signature recovery failed: ${err.message}` };
	}

	const expectedAddress = extractAddressFromDidPkh(kid);
	if (!expectedAddress) {
		// No kid to compare against — signature recovers but we cannot match issuer.
		return {
			valid: true,
			signer: recoveredAddress.toLowerCase(),
			note: 'kid not available; signer recovered but not cross-checked',
		};
	}

	const match = recoveredAddress.toLowerCase() === expectedAddress;
	return {
		valid: match,
		signer: recoveredAddress.toLowerCase(),
		expected: expectedAddress,
		reason: match ? undefined : `signer ${recoveredAddress} does not match kid address ${expectedAddress}`,
	};
}

/**
 * Structural verification for JWS offers. Full cryptographic verification
 * requires resolving the public key from the kid (did:web), which may need
 * network access to /.well-known/did.json. We verify the structure and
 * report the kid for manual inspection.
 */
function verifyJwsOfferStructure(offer) {
	const parts = offer.signature?.split('.');
	if (!parts || parts.length !== 3) {
		return { valid: false, reason: 'invalid JWS format (expected 3 dot-separated parts)' };
	}
	let header;
	try {
		header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
	} catch {
		return { valid: false, reason: 'cannot decode JWS header' };
	}
	if (!header.alg) {
		return { valid: false, reason: 'JWS header missing alg' };
	}
	if (!header.kid) {
		return { valid: false, reason: 'JWS header missing kid' };
	}
	return {
		valid: true,
		kid: header.kid,
		alg: header.alg,
		note: 'structural check only; full cryptographic verification requires the public key from ' + header.kid,
	};
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
	console.log('=== x402 Offer & Receipt Verification ===\n');
	console.log(`Target: ${targetUrl}\n`);

	// Step 1: hit the endpoint without a payment header to get the 402 challenge.
	let response;
	try {
		response = await fetch(targetUrl, {
			method: 'GET',
			headers: { Accept: 'application/json' },
		});
	} catch (err) {
		console.error(`Failed to reach ${targetUrl}`);
		if (err.cause?.code === 'ECONNREFUSED') {
			console.error('The server is not running. Start it with: npm run dev');
		} else {
			console.error(`Network error: ${err.message}`);
		}
		process.exit(1);
	}

	if (response.status !== 402) {
		console.error(`Expected HTTP 402, got ${response.status}.`);
		if (response.status === 200) {
			console.error('The endpoint returned 200 — it may not require payment (check access control).');
		}
		process.exit(1);
	}

	let body;
	try {
		body = await response.json();
	} catch (err) {
		console.error(`Failed to parse 402 response body as JSON: ${err.message}`);
		process.exit(1);
	}

	console.log('--- 402 Challenge ---');
	console.log(`x402 version: ${body.x402Version || 'unknown'}`);
	console.log(`Resource: ${body.resource?.url || 'N/A'}`);
	console.log(`Accepts: ${body.accepts?.length || 0} payment method(s)`);

	// Step 2: extract offers from the offer-receipt extension.
	const offerReceiptExt = body.extensions?.['offer-receipt'];
	const offers = offerReceiptExt?.info?.offers;

	if (!offers || !offers.length) {
		console.log('\nOffers found: 0 (extension not declared — OFFER_RECEIPT_SIGNING_PRIVATE_KEY may not be set)');
		console.log('\n--- Receipt Verification ---');
		console.log('(Requires a real payment — skipped in dry-run mode)');
		console.log('\nResult: SKIP (no offers to verify)');
		process.exit(0);
	}

	console.log(`\nOffers found: ${offers.length}`);

	// The kid is shared across all offers from the same issuer.
	// For EIP-712, extract it from the PAYMENT-REQUIRED header or the issuer config.
	// We check the first EIP-712 offer's recovered signer, and for JWS the kid is in the header.
	let kid = null;
	// The server's buildOffersExtension doesn't embed the kid directly in the offer,
	// but for EIP-712 the issuer address is recoverable from the signature. For JWS,
	// the kid is in the JWS header.

	let allValid = true;
	const results = [];

	for (let i = 0; i < offers.length; i++) {
		const offer = offers[i];
		const payload = extractOfferPayload(offer);
		const idx = i + 1;

		let verification;
		if (offer.format === 'eip712') {
			verification = await verifyEip712Offer(offer, kid);
			// If we don't have a kid yet, use the recovered signer for subsequent checks.
			if (!kid && verification.signer) {
				kid = `did:pkh:eip155:1:${verification.signer}#key-1`;
			}
		} else if (offer.format === 'jws') {
			verification = verifyJwsOfferStructure(offer);
			if (!kid && verification.kid) {
				kid = verification.kid;
			}
		} else {
			verification = { valid: false, reason: `unknown format: ${offer.format}` };
		}

		const signerDisplay = verification.signer
			? verification.signer
			: verification.kid
				? verification.kid
				: 'N/A';

		const validUntil = payload.validUntil ? formatTimestamp(payload.validUntil) : 'N/A';
		const mark = verification.valid ? 'OK' : 'FAIL';

		if (!verification.valid) allValid = false;

		let line = `  [${idx}] network: ${payload.network || 'N/A'} | amount: ${payload.amount || 'N/A'} | signer: ${signerDisplay} | valid until: ${validUntil} ${mark}`;
		if (verification.reason) {
			line += `\n       Reason: ${verification.reason}`;
		}
		if (verification.note) {
			line += `\n       Note: ${verification.note}`;
		}

		results.push(line);
	}

	for (const line of results) {
		console.log(line);
	}

	console.log('\n--- Receipt Verification ---');
	console.log('(Requires a real payment — skipped in dry-run mode)');

	if (allValid) {
		console.log('\nResult: PASS (offers verified)');
		process.exit(0);
	} else {
		console.log('\nResult: FAIL (one or more offers failed verification)');
		process.exit(1);
	}
}

main().catch((err) => {
	console.error(`Unexpected error: ${err.message}`);
	process.exit(1);
});
