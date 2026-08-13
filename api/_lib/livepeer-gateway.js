// Livepeer AI gateway resolution, shared by every Livepeer lane on the
// platform (the LLM comparison endpoint api/inference/livepeer.js and the
// text-to-image federation provider api/_providers/livepeer.js).
//
// It lives here, and not in either lane, because the gateway URLs are a fact
// about the network rather than about a pipeline: when a gateway moves or
// dies, exactly one file changes. Nothing heavier than env.js is imported so
// a lightweight handler can resolve a gateway without pulling a storage SDK
// into its module graph.
//
// Resolution order:
//   LIVEPEER_GATEWAY_URL  -> 'override' (self-hosted gateway, staging, or a
//                            regional edge; wins outright, keyed or not)
//   LIVEPEER_API_KEY      -> 'studio'   (Livepeer Studio AI gateway, bearer
//                            auth, metered free tier)
//   neither               -> 'public'   (the no-key dream gateway, which is
//                            NOT usable today; see livepeerGatewayUsable)

import { env } from './env.js';

export const PUBLIC_GATEWAY = 'https://dream-gateway.livepeer.cloud';
export const STUDIO_GATEWAY = 'https://livepeer.studio/api/generate';

// Why the public gateway is refused rather than merely "often failing":
// measured 2026-08-12 (docs/ops/livepeer-federation.md), dream-gateway.
// livepeer.cloud resolves to a host serving a certificate for an unrelated
// domain, with no Livepeer service behind it. A lane that keeps POSTing there
// is not retrying a flaky gateway, it is shipping user prompt text at a third
// party we cannot identify. Operators who see the domain restored can point a
// lane back at it explicitly with LIVEPEER_GATEWAY_URL.
export const PUBLIC_GATEWAY_NOTE =
	'The no-key Livepeer dream gateway is unreachable (its hostname resolves to an unrelated host). Set LIVEPEER_API_KEY for the Studio gateway, or LIVEPEER_GATEWAY_URL for a self-hosted one.';

// Resolve the active gateway. Returns { base, gateway, key } where gateway is
// 'override' | 'studio' | 'public'. Reads process.env ahead of the env.js
// getter so bench harnesses and tests that set process.env directly between
// cases see their own value.
export function livepeerGatewayConfig() {
	const override = process.env.LIVEPEER_GATEWAY_URL || env.LIVEPEER_GATEWAY_URL;
	if (override) {
		return {
			base: String(override).replace(/\/$/, ''),
			gateway: 'override',
			key: env.LIVEPEER_API_KEY || null,
		};
	}
	const key = env.LIVEPEER_API_KEY;
	if (key) return { base: STUDIO_GATEWAY, gateway: 'studio', key };
	return { base: PUBLIC_GATEWAY, gateway: 'public', key: null };
}

// Whether a resolved gateway may be sent user content. Only the public one is
// refused, and only for the reason recorded in PUBLIC_GATEWAY_NOTE.
export function livepeerGatewayUsable(gateway) {
	return gateway !== 'public';
}
