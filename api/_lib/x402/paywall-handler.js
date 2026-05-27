// Content-negotiation middleware for x402 paid endpoints.
//
// When a human browser (Accept: text/html) hits a paid endpoint that returns
// a 402, redirect them to /paywall.html instead of showing a raw JSON body.
// This is a utility module — paidEndpoint() callers can check shouldServePaywall()
// before sending the 402 and instead redirect.
//
// Usage in a paidEndpoint handler (or any Vercel function):
//
//   import { shouldServePaywall, buildPaywallRedirect } from '../_lib/x402/paywall-handler.js';
//
//   // Inside a request handler, before calling send402:
//   if (shouldServePaywall(req)) {
//     const url = buildPaywallRedirect(requirements, req);
//     res.writeHead(302, { location: url });
//     res.end();
//     return;
//   }
//
// The paywall page decodes the requirements from the `?req=` query param and
// renders a branded payment UI with wallet options.

/**
 * Determine whether the current request should receive the HTML paywall
 * instead of a raw 402 JSON body.
 *
 * Returns true when ALL of the following hold:
 *   1. The Accept header includes text/html (browser request).
 *   2. No X-PAYMENT or payment-signature header is present (not a paying agent).
 *   3. No SIGN-IN-WITH-X or Authorization header is present (not an auth bypass).
 *
 * @param {import('http').IncomingMessage} req
 * @returns {boolean}
 */
export function shouldServePaywall(req) {
	const accept = String(req.headers['accept'] || '');
	const hasPayment =
		req.headers['x-payment'] || req.headers['payment-signature'];
	const hasAuth =
		req.headers['sign-in-with-x'] || req.headers['authorization'];
	// Only redirect browsers that haven't already supplied payment credentials
	return accept.includes('text/html') && !hasPayment && !hasAuth;
}

/**
 * Build the redirect URL for the paywall page.
 *
 * Encodes the x402 PaymentRequirements array as base64url in the `?req=`
 * query param so the paywall page can render service name, price, network
 * options, etc. without an additional round-trip.
 *
 * @param {Array<object>} requirements   accepts[] from the 402 challenge
 * @param {import('http').IncomingMessage} req
 * @returns {string}  Absolute-path URL, e.g. /paywall.html?req=…&return=%2Fapi%2F…
 */
export function buildPaywallRedirect(requirements, req) {
	const encoded = Buffer.from(JSON.stringify(requirements)).toString('base64url');
	const returnUrl = encodeURIComponent(req.url || '/');
	return `/paywall.html?req=${encoded}&return=${returnUrl}`;
}

/**
 * Apply the paywall redirect as a Vercel/Node HTTP response.
 *
 * Convenience wrapper — calls shouldServePaywall(), and if true, writes a 302
 * and returns true so the caller can early-return.
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse}  res
 * @param {Array<object>} requirements
 * @returns {boolean}  true if the redirect was written, false otherwise
 */
export function redirectToPaywallIfBrowser(req, res, requirements) {
	if (!shouldServePaywall(req)) return false;
	const location = buildPaywallRedirect(requirements, req);
	res.writeHead(302, { location, 'cache-control': 'no-store' });
	res.end();
	return true;
}
