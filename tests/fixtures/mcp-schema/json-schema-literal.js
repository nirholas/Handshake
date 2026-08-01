// The common style: `inputSchema` is a JSON Schema object literal. Exercises
// the bits that are not plain literals: a bound imported from a sibling
// module, a description built by concatenation, and a nested object.

import { ROYALTY_CAP_BPS } from './constants.js';

export const def = {
	name: 'mint_thing',
	title: 'Mint a thing',
	description: 'Mints a thing.',
	annotations: { readOnlyHint: false, destructiveHint: true },
	inputSchema: {
		type: 'object',
		properties: {
			asset_id: { type: 'string', format: 'uuid', description: 'Which asset to mint.' },
			royalty_bps: {
				type: 'integer',
				minimum: 0,
				maximum: ROYALTY_CAP_BPS,
				description: 'Royalty in basis points, capped at ' + ROYALTY_CAP_BPS + '.',
			},
			network: { type: 'string', enum: ['mainnet', 'devnet'], default: 'mainnet' },
			metadata: {
				type: 'object',
				properties: { name: { type: 'string' } },
				additionalProperties: false,
			},
		},
		required: ['asset_id'],
		additionalProperties: false,
	},
	async handler() {
		return { ok: true };
	},
};
