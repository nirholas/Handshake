// GET /api/v1: discovery document for the unified three.ws API.
//
// The single front door: one machine-readable index of every versioned
// endpoint, its auth requirement, scope, and parameters, so an agent or
// developer can discover the whole surface from one call. Rendered from the
// shared catalog (api/v1/_catalog.js) so it can never drift from the live routes.

import { defineEndpoint } from '../_lib/gateway.js';
import { API_META, CATALOG } from './_catalog.js';
import { providerCatalog } from './_providers.js';

export default defineEndpoint({
	name: 'v1.index',
	method: 'GET',
	auth: 'public',
	handler: () => ({
		...API_META,
		endpoints: CATALOG,
		// Aggregated third-party APIs: many endpoints behind one key/bill, each
		// callable via BYOK, a three.ws plan, or x402 pay-per-call. See /api/v1/x.
		aggregator: {
			base_url: '/api/v1/x',
			billing: ['byok', 'plan', 'x402'],
			providers: providerCatalog(),
		},
		docs: '/dashboard/developers',
		openapi: '/openapi.json',
	}),
});
