// x402 endpoint pricing — env-overridable defaults for every paid endpoint.
//
// Each endpoint declares its slug + default price (in USDC atomics, 6 decimals).
// Ops can override any price at deploy time by setting:
//
//   X402_PRICE_<SLUG>=<atomics>
//
// where <SLUG> is the upper-snake-case form of the endpoint slug:
//
//   agent-reputation         → X402_PRICE_AGENT_REPUTATION
//   pump-agent-audit         → X402_PRICE_PUMP_AGENT_AUDIT
//   skill-marketplace        → X402_PRICE_SKILL_MARKETPLACE
//
// Default values are intentionally low (cents to a few dollars max) so the
// out-of-the-box experience stays as a demo/dev curve. Production deployments
// should review every default and tune to actual unit economics.

/**
 * Resolve the price in USDC atomics for an endpoint slug.
 *
 * @param {string} slug         e.g. 'agent-reputation' (kebab-case)
 * @param {string} defaultAtomics  fallback atomics string
 * @returns {string} atomics string (BigInt-safe)
 */
export function priceFor(slug, defaultAtomics) {
	const key = `X402_PRICE_${String(slug).replace(/-/g, '_').toUpperCase()}`;
	const raw = process.env[key];
	if (raw == null) return String(defaultAtomics);
	const trimmed = String(raw).trim();
	if (!/^\d+$/.test(trimmed)) {
		console.warn(
			`[x402-prices] env ${key}="${raw}" is not a non-negative integer; falling back to default ${defaultAtomics}`,
		);
		return String(defaultAtomics);
	}
	return trimmed;
}
