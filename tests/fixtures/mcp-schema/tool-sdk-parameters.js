// The @three-ws/tool-sdk style: the field is called `parameters`, holds a whole
// `z.object(...)`, and the wire name is a const rather than a literal. Four
// concierge and naming tools are declared exactly this way and were invisible
// to a reader that only looked for a literal `name` beside an `inputSchema`.

import { z } from 'zod';

const NAME = 'concierge_like';

export const tool = {
	name: NAME,
	title: 'Concierge-like',
	description: 'Answers a question about a page.',
	annotations: { readOnlyHint: true },
	parameters: z.object({
		question: z.string().min(1).max(2000).describe('The question to ask.'),
		url: z.string().url().optional().describe('A page to ground the answer in.'),
	}),
};
