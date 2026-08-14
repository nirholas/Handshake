// `list_scenes`: browse recent or featured dioramas. Read-only.
//
// Wraps GET /api/diorama?list=recent|featured&limit=<n>.

import { z } from 'zod';

import { apiRequest } from '../lib/api.js';

export const def = {
	name: 'list_scenes',
	title: 'List recent or featured dioramas',
	annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
	description:
		'Browse the public diorama gallery: the most recent saved worlds, or the featured set. Returns a list of cards (id, title, mood, thumbnail/preview, view count) plus each world\'s viewer URL. Read-only.',
	inputSchema: {
		list: z
			.enum(['recent', 'featured'])
			.default('recent')
			.describe('Which gallery to read: newest saved worlds ("recent") or the curated set ("featured").'),
		limit: z
			.number()
			.int()
			.min(1)
			.max(50)
			.optional()
			.describe('How many to return (1-50, default 24).'),
	},
	async handler(args) {
		const scope = args?.list === 'featured' ? 'featured' : 'recent';
		const limit = args?.limit;
		const data = await apiRequest('/api/diorama', { query: { list: scope, limit } });
		const dioramas = Array.isArray(data?.dioramas) ? data.dioramas : [];
		return {
			ok: true,
			scope,
			count: dioramas.length,
			storage_enabled: data?.storage ?? null,
			dioramas: dioramas.map((d) => ({
				...d,
				viewer_url: d?.id ? `https://three.ws/diorama?id=${encodeURIComponent(d.id)}` : null,
			})),
		};
	},
};
