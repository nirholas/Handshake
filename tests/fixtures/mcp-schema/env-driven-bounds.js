// A schema whose bounds come from the environment at boot. Nothing offline can
// know them, so the reader must say so rather than invent one: the argument
// survives, the unknowable constraint does not, and the tool is flagged partial.

const CAPS = { maxPerCallUsdc: envNumber('MAX_PER_CALL_USDC', 1) };

function envNumber(key, fallback) {
	const raw = process.env[key];
	return raw == null ? fallback : Number(raw);
}

export const def = {
	name: 'spend_thing',
	title: 'Spend',
	description: 'Spends.',
	annotations: { readOnlyHint: false, destructiveHint: true },
	inputSchema: {
		type: 'object',
		properties: {
			usdc: {
				type: 'number',
				exclusiveMinimum: 0,
				maximum: CAPS.maxPerCallUsdc,
				description: 'Amount in USDC. Hard per-call cap: $' + CAPS.maxPerCallUsdc + '.',
			},
		},
		required: ['usdc'],
		additionalProperties: false,
	},
	async handler() {
		return { ok: true };
	},
};
