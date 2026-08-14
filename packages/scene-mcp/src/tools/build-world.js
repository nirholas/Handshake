// `build_world`: one sentence → a fully forged, exported 3D world. No browser.
//
// Wraps POST /api/diorama {action:'build'}. Runs the ENTIRE diorama pipeline
// server-side in one call: compose the plan (free-first LLM chain), forge
// every object on the free text→3D lane, then merge everything into one GLB
// (same composer as export_scene). This is what the three.ws /diorama page
// does progressively in a browser tab, collapsed into a single tool call for
// agents/MCP clients that have no browser to drive that flow.
//
// Real generation work (an LLM completion plus N free-lane 3D forges), so this
// can legitimately take minutes for a full object set, so the tool requests a
// long timeout accordingly. A forge failure on some objects never fails the
// whole call: the returned diorama reflects exactly what forged, and `skipped`
// names the rest, so you always get the best real world the platform could
// build from your sentence.

import { z } from 'zod';

import { apiRequest } from '../lib/api.js';

const SCENE_STUDIO_BASE = 'https://three.ws/scene';
const DIORAMA_BASE = 'https://three.ws/diorama';

export const def = {
	name: 'build_world',
	title: 'Build a complete 3D world from one sentence (no browser needed)',
	annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
	description:
		'One sentence → a fully forged, exported 3D world, entirely server-side: composes the scene plan, forges every object on the free text→3D lane, and merges the result into one GLB with named, selectable nodes plus ground and lighting. Returns the populated diorama, the merged GLB URL, and a ready-to-open Scene Studio link. This is the whole progressive /diorama browser flow collapsed into one call; it can take a couple of minutes for a full object set. Partial forges are not failures: whatever forged is exported, and `skipped` names anything that did not.',
	inputSchema: {
		prompt: z
			.string()
			.min(3, 'Describe your world in at least a few words.')
			.max(1024)
			.describe('One short sentence describing the world to build, e.g. "a neon alley with a food cart and two streetlights".'),
	},
	async handler(args) {
		const prompt = String(args?.prompt ?? '').trim();
		const data = await apiRequest('/api/diorama', {
			method: 'POST',
			body: { action: 'build', prompt },
			timeoutMs: 300_000, // compose + up to MAX_OBJECTS free-lane forges + export
		});
		const diorama = data?.diorama;
		return {
			ok: true,
			diorama,
			object_count: data.objectCount,
			ready_count: data.readyCount,
			glb_url: data.glbUrl || null,
			scene_studio_url: data.glbUrl
				? data.sceneStudioUrl || `${SCENE_STUDIO_BASE}?model=${encodeURIComponent(data.glbUrl)}`
				: null,
			exported_count: data.exportedCount ?? null,
			skipped: data.skipped || [],
			export_note: data.exportNote || null,
			diorama_viewer_url: DIORAMA_BASE,
		};
	},
};
