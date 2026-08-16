// `get_creation` — fetch one Loom creation by id. Read-only.
//
// Wraps GET /api/loom?c=<id> → { creation }.

import { z } from 'zod';

import { apiRequest } from '../lib/api.js';
import { decorateCreation } from '../lib/viewer.js';

export const def = {
	name: 'get_creation',
	title: 'Fetch one Loom creation by id',
	annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
	description:
		'Fetch a single Loom creation by its id. Returns the full record — prompt, glbUrl, previewImageUrl, ' +
		'author, tier, backend, createdAt — together with a `viewer_url` (the /forge/embed orbit+AR viewer for ' +
		'the GLB), an `og_image_url`, and a paste-ready `iframe_snippet` so the model can be previewed inline. ' +
		'Returns a not_found error if no creation has that id. Read-only, no key required.',
	inputSchema: {
		id: z
			.string()
			.min(1)
			.describe('The creation id (a UUID) from the feed or from a prior submit_creation.'),
	},
	async handler(args) {
		const id = String(args?.id ?? '').trim();
		if (!id) throw Object.assign(new Error('id is required.'), { code: 'invalid_input', status: 400 });
		let data;
		try {
			data = await apiRequest('/api/loom', { query: { c: id } });
		} catch (err) {
			// The gallery answers an unknown id with a 404, which the HTTP layer
			// normalizes to the generic `upstream_error`. Re-type it as the
			// `not_found` this tool documents, so a client can branch on "no such
			// creation" without string-matching a message.
			if (err?.status === 404) {
				throw Object.assign(new Error(`No Loom creation found with id "${id}".`), {
					code: 'not_found',
					status: 404,
				});
			}
			throw err;
		}
		const creation = decorateCreation(data?.creation);
		if (!creation) {
			throw Object.assign(new Error(`No Loom creation found with id "${id}".`), { code: 'not_found', status: 404 });
		}
		return { ok: true, creation };
	},
};
