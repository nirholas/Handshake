// The IBM Granite style: the schema is built at import time from a zod shape,
// so the property the tool carries is an identifier and the shape has to be
// followed back to be read at all.

import { z } from 'zod';

import { jsonSchemaFromZod } from './helpers.js';

const TOOL_NAME = 'granite_like';

const inputZodShape = {
	inputs: z
		.array(z.string().min(1).max(8000))
		.min(1)
		.max(64)
		.describe('Texts to embed.'),
	model: z.string().optional().describe('Override the model id.'),
};

const inputJsonSchema = jsonSchemaFromZod(inputZodShape);

export const def = {
	name: TOOL_NAME,
	title: 'Granite-like',
	description: 'Embeds text.',
	annotations: { readOnlyHint: true },
	inputSchema: inputJsonSchema,
	async handler() {
		return { ok: true };
	},
};
