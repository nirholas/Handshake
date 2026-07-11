// Service-catalog descriptors for the paid Market Data API family
// (/api/x402/market-*). Unlike the sibling one-file-per-service descriptors,
// this family is REGISTRY-DERIVED: api/_lib/market-data/registry.js is the
// single written-once source for every category's slug, price, description,
// and schemas — the live endpoints (api/_lib/market-data/endpoint.js) build
// from the same entries, so the catalog cannot drift from the 402s.
// Contract: specs/SERVICE_CATALOG.md. Edit the registry, not this projection.

import {
	MARKET_CATEGORIES,
	MARKET_SERVICE_NAME,
} from '../../market-data/registry.js';

export const MARKET_DATA_SERVICES = MARKET_CATEGORIES.map((c) => ({
	slug: c.slug,
	title: c.title,
	category: 'market-data',
	useCase: c.useCase,
	path: `/api/x402/${c.slug}`,
	method: 'GET',
	free: false,
	status: 'live',
	priceAtomics: c.priceAtomics,
	acceptsBuilder: 'standard',
	serviceName: MARKET_SERVICE_NAME,
	tags: c.tags,
	description: c.description,
	input: c.inputExample,
	inputSchema: c.inputSchema,
	outputExample: c.outputExample,
	storefronts: ['x402scan'],
}));
