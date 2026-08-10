// Catalog entry for GET /api/crypto/portfolio: the free portfolio-overview
// endpoint.
//
// The /api/crypto index merges this descriptor into the bundle's discovery doc
// + OpenAPI (via the STATIC_ENTRIES barrel in index.js). Plain, serializable,
// no imports, no side effects.

export default {
	slug: 'portfolio',
	method: 'GET',
	path: '/api/crypto/portfolio',
	title: 'Portfolio Overview',
	summary:
		'A wallet read shaped for a portfolio view rather than a raw balance dump: stable/major/other classification, top-asset allocation with palette slots, per-row portfolio share, per-token 24h change, and an aggregate 24h move that states its own coverage. Keyless on Solana; Ethereum needs a provider key.',
	inputSchema: {
		type: 'object',
		required: ['address'],
		properties: {
			address: {
				type: 'string',
				description: 'Wallet address to inspect (Solana base58 or EVM 0x).',
			},
			chain: {
				type: 'string',
				enum: ['solana', 'ethereum'],
				default: 'solana',
				description: 'Chain to read. Solana is keyless; Ethereum needs a provider key.',
			},
		},
	},
	outputSchema: {
		type: 'object',
		properties: {
			address: { type: 'string' },
			chain: { type: 'string' },
			totalUsd: { type: 'number' },
			unpricedCount: { type: 'integer' },
			change24h: {
				type: ['object', 'null'],
				properties: {
					usd: { type: 'number' },
					pct: { type: 'number' },
					coveragePct: {
						type: 'number',
						description: 'Share of portfolio value the 24h move actually covers. Nothing is extrapolated over the gap.',
					},
				},
			},
			summary: {
				type: 'object',
				description: 'Value split across stable / major / other, each with usd, pct and count.',
			},
			topAssets: {
				type: 'array',
				items: {
					type: 'object',
					properties: {
						id: { type: 'string' },
						symbol: { type: ['string', 'null'] },
						name: { type: ['string', 'null'] },
						usd: { type: 'number' },
						pct: { type: 'number' },
						slot: { type: 'integer', description: 'Palette slot, so a chart colors consistently across reloads.' },
						logo: { type: ['string', 'null'] },
					},
				},
			},
			rows: {
				type: 'array',
				items: {
					type: 'object',
					properties: {
						id: { type: 'string' },
						symbol: { type: ['string', 'null'] },
						name: { type: ['string', 'null'] },
						kind: { type: 'string', enum: ['native', 'token'] },
						class: { type: 'string', enum: ['stable', 'major', 'other'] },
						amount: { type: 'number' },
						price: { type: ['number', 'null'] },
						usd: { type: ['number', 'null'] },
						pct: { type: ['number', 'null'] },
						change24h: { type: ['number', 'null'] },
						logo: { type: ['string', 'null'] },
					},
				},
			},
			tokenCount: { type: 'integer' },
			truncated: { type: 'boolean' },
			stale: { type: 'boolean' },
			ts: { type: 'string', format: 'date-time' },
			sources: { type: 'array', items: { type: 'string' } },
		},
	},
	example: '/api/crypto/portfolio?address=FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump&chain=solana',
};
