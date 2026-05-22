// `thumbnail_glb` — render any public GLB URL to a PNG via three.ws's
// hosted headless-chromium pipeline (the same three-light rig and
// bounding-box framing that powers three.ws OG cards).
//
// Returns a base64 PNG data URL the client can display inline, plus
// width/height and the upstream endpoint that produced it.
//
// This is the single most-requested capability for any 3D MCP — without
// it the agent is "blind" to how a model actually looks.

import { z } from 'zod';

import { renderGlbThumbnail } from '../lib/render.js';

export const def = {
	name: 'thumbnail_glb',
	title: 'Render a GLB to a PNG thumbnail',
	description:
		'Render any public GLB URL to a PNG via three.ws\'s hosted three-light rig + auto-framing camera. Returns the PNG inline as a base64 data URL (≤ ~4 MB) plus dimensions. Background defaults to #0a0a0a — pass "transparent" for compositing.',
	inputSchema: {
		glbUrl: z.string().url().describe('Public http(s) URL of a .glb file.'),
		width: z.number().int().min(64).max(2048).optional().describe('Output width in pixels (default 1024).'),
		height: z.number().int().min(64).max(2048).optional().describe('Output height in pixels (default 1024).'),
		background: z.string().optional().describe('CSS color (e.g. "#0a0a0a") or "transparent". Default "#0a0a0a".'),
	},
	async handler(args) {
		const { glbUrl, width, height, background } = args || {};
		if (!glbUrl) return { ok: false, error: 'invalid_input', message: 'glbUrl is required' };
		const out = await renderGlbThumbnail({ glbUrl, width, height, background });
		return {
			...out,
			glbUrl,
		};
	},
};
