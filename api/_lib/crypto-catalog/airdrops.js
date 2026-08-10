// Catalog entry for GET /api/crypto/airdrops: the free airdrop-eligibility
// endpoint.
//
// The /api/crypto index merges this descriptor into the bundle's discovery doc
// + OpenAPI (via the STATIC_ENTRIES barrel in index.js). Plain, serializable,
// no imports, no side effects.

export default {
	slug: 'airdrops',
	method: 'GET',
	path: '/api/crypto/airdrops',
	title: 'Airdrop Eligibility',
	summary:
		"Score a wallet's real on-chain activity against the live airdrop registry: per-airdrop met/missing/manual criteria, an eligibility verdict, and the measured activity behind it. Omit the address to get the registry alone. Solana is keyless; EVM scanning needs an explorer key.",
	inputSchema: {
		type: 'object',
		properties: {
			address: {
				type: 'string',
				description: 'Wallet to score (Solana base58 or EVM 0x). Omit to return the registry alone.',
			},
		},
	},
	outputSchema: {
		type: 'object',
		properties: {
			address: { type: 'string' },
			family: { type: 'string', enum: ['solana', 'evm'] },
			activity: {
				type: 'object',
				description: 'Measured on-chain activity: tx_count, days_active, account_age_days, unique_tokens, and the chains behind them.',
			},
			opportunities: {
				type: 'array',
				items: {
					type: 'object',
					properties: {
						id: { type: 'string' },
						name: { type: 'string' },
						chain: { type: 'string' },
						status: { type: 'string' },
						score: { type: 'number' },
						eligibility: {
							type: 'string',
							enum: ['qualified', 'in_progress', 'not_eligible'],
						},
						met: { type: 'array', items: { type: 'object' } },
						missing: { type: 'array', items: { type: 'object' } },
						manual: { type: 'array', items: { type: 'object' } },
						estimatedValue: { type: ['string', 'null'] },
						deadline: { type: ['string', 'null'] },
						source: { type: ['string', 'null'] },
					},
				},
			},
			otherFamily: {
				type: 'array',
				description: 'Registry entries on the other chain family, returned unevaluated rather than scored as a fake zero.',
				items: { type: 'object' },
			},
			summary: { type: 'object' },
			registry: {
				type: 'array',
				description: 'Returned instead of a scored result when no address is supplied.',
				items: { type: 'object' },
			},
			thresholds: {
				type: 'object',
				properties: {
					qualified: { type: 'number' },
					inProgress: { type: 'number' },
				},
			},
			ts: { type: 'string', format: 'date-time' },
		},
	},
	example: '/api/crypto/airdrops?address=FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
};
