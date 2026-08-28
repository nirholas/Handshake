// x402 Preflight — MCP tool.
//
//   • x402_preflight(origin, network?) — FREE, read-only, public. Fetches any
//     x402 seller's signed payability attestation, verifies the ed25519
//     signature, the expiry and the subject, and answers the only question that
//     matters before an agent spends: can this seller actually settle?
//
// This is the conversational surface of the same format the SDK and the CLI
// consume. An agent about to pay for a service can ask first, in one free call,
// and get a verdict it can act on: pay, pay on a different rail, or come back
// later. No wallet, no payment, no account, so it ships on the free track.
//
// The verification runs HERE, on the fetched bytes, using the same verifier the
// browser SDK uses. The tool never relays a seller's claim unchecked: an
// attestation that does not verify is reported as unverified, not as an outage
// and not as health.
//
// Spec: specs/x402-preflight.md. Client: packages/x402-preflight.

import { fetchSafePublicUrl } from '../../_lib/ssrf-guard.js';
import { verifyPreflight, networkVerdict, normalizeOrigin } from '../../_lib/x402/preflight.js';

const PREFLIGHT_PATH = '/.well-known/x402-preflight';
// An attestation is a small JSON document. Anything larger is not one, and
// reading it would just be an amplification vector.
const MAX_BYTES = 256 * 1024;
const TIMEOUT_MS = 6000;

function toolError(message, code) {
	return {
		content: [{ type: 'text', text: message }],
		structuredContent: { error: true, code: code || 'error', message },
		isError: true,
	};
}

// Plain sentences for a model to relay to a person. The enum is for code; this
// is what an agent should actually say out loud.
const REASON_COPY = {
	ok: 'settling normally',
	sponsor_below_floor:
		"the seller's own fee wallet cannot cover network fees, so nothing you sign can settle. Only the seller can fix this",
	settlement_degraded: 'recent settlements are failing, so a payment may not complete',
	facilitator_unreachable: 'the seller cannot reach its settlement facilitator, so it will not vouch for this rail',
	network_not_configured: 'the seller does not accept payment on this network',
	rail_unavailable: 'the payment rail itself is unavailable',
	unknown: 'the seller could not measure this rail, so it will not claim it works',
};

function describeSettle(s) {
	if (!s || s.rate == null) return 'no settled payments measured in the window';
	return `${(s.rate * 100).toFixed(1)}% of ${s.attempts} attempt(s) over ${s.window_hours}h (confidence ${s.confidence})`;
}

async function handlePreflight(args) {
	const origin = normalizeOrigin(args?.origin || '');
	if (!origin.startsWith('http')) {
		return toolError('Pass an origin such as https://three.ws', 'bad_origin');
	}
	const network = args?.network ? String(args.network) : null;

	let res;
	try {
		// SSRF-guarded: `origin` is caller-supplied and would otherwise be a
		// straightforward way to make the server fetch its own metadata service.
		res = await fetchSafePublicUrl(`${origin}${PREFLIGHT_PATH}`, {
			headers: { accept: 'application/json' },
			// A hung seller must not hold an agent's turn open.
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch (err) {
		return toolError(
			`Could not reach ${origin} to check whether it can settle: ${err?.message || err}. ` +
				'Treat this seller as unverified rather than healthy.',
			'unreachable',
		);
	}

	if (!res.ok) {
		const notSupported = res.status === 404;
		return {
			content: [
				{
					type: 'text',
					text: notSupported
						? `${origin} does not publish an x402 preflight attestation. That is not a fault (preflight is ` +
							'opt-in and most x402 sellers have not adopted it), but it does mean there is no way to know ' +
							'whether it can settle before paying it.'
						: `${origin} answered HTTP ${res.status} for its preflight attestation. A seller that cannot sign ` +
							'one is a seller you should not assume is healthy.',
				},
			],
			structuredContent: {
				origin,
				supported: !notSupported,
				verified: false,
				status: res.status,
				code: notSupported ? 'not_supported' : 'unavailable',
			},
		};
	}

	let envelope;
	try {
		const buf = Buffer.from(await res.arrayBuffer());
		// An attestation is a small JSON document. Anything larger is not one, and
		// parsing it would only be an amplification vector.
		if (buf.length > MAX_BYTES) {
			return toolError(`${origin} returned ${buf.length} bytes, which is not a preflight attestation.`, 'too_large');
		}
		envelope = JSON.parse(buf.toString('utf8'));
	} catch {
		return toolError(`${origin} returned something that is not a preflight attestation.`, 'malformed');
	}

	const verification = verifyPreflight(envelope, { subject: origin });
	if (!verification.valid) {
		const expired = verification.reason === 'expired';
		return {
			content: [
				{
					type: 'text',
					text:
						`${origin} served an attestation that did not verify (${verification.reason}). ` +
						(expired
							? 'It has already expired. Expiry is what stops a healthy report being replayed through an ' +
								'outage, so an expired one carries no assurance at all.'
							: 'The document is signed but the signature does not match its contents. Treat this seller as ' +
								'unverified.'),
				},
			],
			structuredContent: { origin, supported: true, verified: false, reason: verification.reason },
		};
	}

	const report = envelope.report;
	const entries = Object.entries(report.networks || {});

	if (network) {
		const v = networkVerdict(envelope, network);
		const payable = v.payable === true;
		const lines = [
			`${origin} on ${network}: ${payable ? 'PAYABLE' : v.payable === false ? 'NOT PAYABLE' : 'UNKNOWN'}.`,
			`Why: ${REASON_COPY[v.reason] || v.reason}.`,
		];
		if (!payable && v.alternates.length) lines.push(`It can settle on ${v.alternates.join(', ')} instead.`);
		if (!payable && v.retry_after) lines.push(`The seller suggests retrying in ${v.retry_after}s.`);
		return {
			content: [{ type: 'text', text: lines.join(' ') }],
			structuredContent: {
				origin,
				supported: true,
				verified: true,
				issuer: envelope.issuer,
				expires_at: report.expires_at,
				network,
				...v,
			},
		};
	}

	const lines = [`${origin} published a verified attestation, signed by ${envelope.issuer}.`];
	for (const [id, n] of entries) {
		const state = n.payable === true ? 'PAYABLE' : n.payable === false ? 'NOT PAYABLE' : 'UNKNOWN';
		lines.push(`  ${id}: ${state} — ${REASON_COPY[n.reason] || n.reason}; ${describeSettle(n.settle)}.`);
	}
	if (!report.payable_any) {
		lines.push('No network on this origin can settle right now. Do not sign a payment for it.');
	}

	return {
		content: [{ type: 'text', text: lines.join('\n') }],
		structuredContent: {
			origin,
			supported: true,
			verified: true,
			issuer: envelope.issuer,
			issued_at: report.issued_at,
			expires_at: report.expires_at,
			payable_any: report.payable_any,
			networks: report.networks,
		},
	};
}

export const toolDefs = [
	{
		name: 'x402_preflight',
		title: 'Check whether an x402 seller can actually settle before paying it',
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		description:
			'Before paying any x402 endpoint, check whether that seller can currently SETTLE what it charges. ' +
			'x402 tells you the price; it does not tell you whether the seller’s own fee wallet, facilitator and ' +
			'payment rail can complete the transaction, and when they cannot you lose a signature and get a 502. ' +
			'This fetches the seller’s signed payability attestation from /.well-known/x402-preflight, verifies the ' +
			'ed25519 signature and its expiry, and returns payable / not payable / unknown per network, with the ' +
			'reason, a suggested retry delay, and any other rail on the same seller that DOES work. Free, read-only, ' +
			'no wallet or account. Works against any origin implementing the open x402-preflight/1 format.',
		inputSchema: {
			type: 'object',
			additionalProperties: false,
			required: ['origin'],
			properties: {
				origin: {
					type: 'string',
					format: 'uri',
					description: 'The seller origin to check, e.g. https://three.ws',
				},
				network: {
					type: 'string',
					description:
						'Optional CAIP-2 network id to check specifically, e.g. solana:mainnet or eip155:8453. ' +
						'Omit to get every network the seller offers.',
				},
			},
		},
		handler: (args) => handlePreflight(args),
	},
];
