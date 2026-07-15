// export_ar — turn any generated GLB into a one-tap "View in your space" AR link.
//
// Given a GLB URL, it returns a device-aware AR launch link (/api/ar, which
// branches on User-Agent: iOS Quick Look, Android Scene Viewer, desktop WebGL),
// the interactive viewer link, and the raw Scene Viewer intent — shaped as a
// conformant Spatial MCP artifact (specs/SPATIAL_MCP.md) with the AR handoff
// populated. Free, read-only, and coin-clean: no payment, wallet, token, session,
// or trace fields, so the response ships unchanged on the OpenAI free track. The
// actual GLB→USDZ conversion for iOS happens in the launch page via model-viewer
// (three.js USDZExporter) — a real conversion, no server-side USD tooling.

import { buildSpatialArtifact } from '../../_lib/spatial-mcp.js';
import {
	assertArAssetUrl,
	buildArLaunchUrl,
	buildViewerUrl,
	buildSceneViewerUrl,
	buildIrlUrl,
} from '../../_lib/ar-launch.js';

const DEFAULT_ORIGIN = 'https://three.ws';

function originFrom(req) {
	const host = req?.headers?.['x-forwarded-host'] || req?.headers?.host;
	if (!host) return DEFAULT_ORIGIN;
	const proto = req.headers['x-forwarded-proto'] || (/^localhost|127\.0\.0\.1/.test(host) ? 'http' : 'https');
	return `${proto}://${host}`;
}

export const toolDefs = [
	{
		name: 'export_ar',
		title: 'Export a model for AR ("View in your space")',
		annotations: {
			readOnlyHint: true, // resolves links for an existing GLB — creates nothing
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false, // URLs are constructed locally; no external call
		},
		description:
			'Turn a generated 3D model (GLB URL) into a one-tap "View in your space" AR experience. Returns a ' +
			'device-aware AR launch link (iOS Quick Look, Android Scene Viewer, desktop WebGL — branched on the ' +
			"viewer's device), the interactive viewer link, and a conformant Spatial MCP artifact with the AR handoff " +
			'populated. Use it after generating a model so the user can place it on their desk through their phone. ' +
			'For a rigged avatar (an agent\'s body) pass kind:"avatar": the response then also carries irlUrl, a ' +
			'living-agent link that walks, animates, and talks with the user through their camera in their real room.',
		inputSchema: {
			type: 'object',
			additionalProperties: false,
			required: ['glb_url'],
			properties: {
				glb_url: { type: 'string', format: 'uri', description: 'Public https URL of a .glb (or .gltf) model to export for AR.' },
				title: { type: 'string', maxLength: 120, description: 'Optional name shown in the AR/viewer experience.' },
				kind: {
					type: 'string',
					enum: ['model', 'avatar'],
					description: 'What the GLB is. "avatar" (a rigged agent body) adds the IRL living-agent link (irlUrl) and makes the AR launch page lead with it. Default "model".',
				},
			},
		},
		async handler(args, _auth, req) {
			let asset;
			try {
				asset = assertArAssetUrl(args.glb_url);
			} catch (err) {
				return {
					content: [{ type: 'text', text: err.arUserMessage ? err.message : 'Provide a public https URL to a .glb model.' }],
					structuredContent: { error: true, message: err.message },
					isError: true,
				};
			}
			const origin = originFrom(req);
			const title = typeof args.title === 'string' ? args.title.slice(0, 120) : '';
			const live = args.kind === 'avatar';
			const arLaunchUrl = buildArLaunchUrl(origin, asset, title, { live });
			const viewerUrl = buildViewerUrl(origin, asset, title);
			const sceneViewerUrl = buildSceneViewerUrl(asset, { title, fallbackUrl: viewerUrl });
			const irlUrl = live ? buildIrlUrl(origin, asset) : '';

			const spatial = buildSpatialArtifact({
				glbUrl: asset,
				kind: live ? 'avatar' : 'model',
				viewerUrl,
				title: title || undefined,
				ar: { glbUrl: asset, launchUrl: arLaunchUrl },
			});

			return {
				content: [
					{
						type: 'text',
						text: live
							? `Ready for AR. Bring it to life in the real room (it moves and talks through the camera, open on a phone): ${irlUrl}\n` +
								`Place a static copy in your space: ${arLaunchUrl}\nInteractive viewer: ${viewerUrl}`
							: `Ready for AR. Open on a phone to place it in your space: ${arLaunchUrl}\nInteractive viewer: ${viewerUrl}`,
					},
				],
				structuredContent: {
					glbUrl: asset,
					arLaunchUrl,
					viewerUrl,
					sceneViewerUrl,
					...(irlUrl ? { irlUrl } : {}),
					format: 'glb',
					spatial,
				},
			};
		},
	},
];
