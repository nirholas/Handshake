// `list_animations` — fetch the three.ws pose preset catalog (24 presets
// across Standing, Action, Sitting & Floor, Expressive). Lives at
// GET /api/render/avatar-clip on three.ws so the catalog stays
// authoritative even when this MCP version is older than the live one.

import { THREE_WS_BASE } from '../config.js';
import { fetchPoseCatalogRemote } from '../lib/render.js';

export const def = {
	name: 'list_animations',
	title: 'List three.ws pose presets + animation slots',
	description:
		'Return the three.ws pose preset catalog (T-pose, A-pose, wave, thinker, jump, dance, warrior2, …) grouped by category. Use the ids returned here as posePresetId in render_avatar. Fetched live from three.ws so the catalog reflects the deployed version.',
	inputSchema: {},
	async handler() {
		try {
			const catalog = await fetchPoseCatalogRemote();
			const grouped = {};
			for (const p of catalog.poses || []) {
				const key = p.group || 'Other';
				if (!grouped[key]) grouped[key] = [];
				grouped[key].push({ id: p.id, label: p.label });
			}
			return {
				ok: true,
				source: `${THREE_WS_BASE}/api/render/avatar-clip`,
				poseCount: (catalog.poses || []).length,
				groups: Object.keys(grouped).map((g) => ({ group: g, poses: grouped[g] })),
				cameraOrbit: catalog.cameraOrbit,
				background: catalog.background,
				fetchedAt: new Date().toISOString(),
			};
		} catch (err) {
			return { ok: false, error: 'fetch_failed', message: err.message };
		}
	},
};
