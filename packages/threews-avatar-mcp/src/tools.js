// Tool surface for the three.ws avatar MCP server.
//
// Three free, read-only tools over real three.ws endpoints:
//   - render_avatar     → live 3D avatar in chat (image + interactive HTML + embed)
//   - avatar_embed_code → ready-to-paste iframe to embed the avatar anywhere
//   - get_avatar        → avatar metadata (name, model url, owner, visibility)
//
// Handlers trust their inputs (the JSON-Schema is the boundary) and let
// ThreewsError propagate — the server turns those into MCP tool errors with the
// real upstream cause.

import {
	resolveAvatar,
	renderImage,
	embedUrl,
	viewerUrl,
	iframeSnippet,
	modelViewerHtml,
} from './threews.js';

// One of these three selectors identifies an avatar across every tool.
const selectorProps = {
	id: { type: 'string', description: 'Avatar UUID (from a three.ws avatar URL or get_avatar).' },
	handle: { type: 'string', description: 'three.ws username/handle, e.g. "nirholas" or "@nirholas".' },
	model: { type: 'string', description: 'Direct GLB/GLTF model URL (skips lookup; used as-is).' },
};

function textBlock(text) {
	return { type: 'text', text };
}

export function buildTools() {
	return [
		{
			definition: {
				name: 'render_avatar',
				description:
					'Render a three.ws 3D avatar inline: returns a preview image, an interactive ' +
					'(rotatable) model-viewer artifact, and a ready-to-embed live URL. Identify the ' +
					'avatar by id, @handle, or a raw GLB url.',
				inputSchema: {
					type: 'object',
					properties: {
						...selectorProps,
						background: {
							type: 'string',
							enum: ['transparent', 'dark', 'light'],
							default: 'transparent',
							description: 'Backdrop for the preview/embed.',
						},
						scene: {
							type: 'string',
							enum: ['portrait', 'headshot', 'upper-body', 'full-body'],
							default: 'portrait',
							description: 'Framing for the rendered preview image.',
						},
						auto_rotate: { type: 'boolean', default: true, description: 'Spin the model in the interactive view.' },
						height: { type: 'integer', minimum: 160, maximum: 1080, default: 480 },
					},
					anyOf: [{ required: ['id'] }, { required: ['handle'] }, { required: ['model'] }],
				},
			},
			handler: async (args) => {
				const avatar = await resolveAvatar(args);
				const background = args.background || 'transparent';
				const height = args.height || 480;
				const autoRotate = args.auto_rotate !== false;

				const embed = embedUrl(
					{ id: avatar.id, handle: args.handle, model: args.model, background },
				);
				const viewer = viewerUrl({ model_url: avatar.model_url, background, autoRotate });
				const iframe = iframeSnippet(embed, { height });
				const html = modelViewerHtml({
					model_url: avatar.model_url,
					name: avatar.name,
					background,
					height,
					autoRotate,
				});

				const content = [];

				// Best-effort PNG preview (renders inline in every client). Only the
				// server-side renderer (needs an avatar id) can produce this; a raw
				// model url or a render failure simply omits the image.
				if (avatar.id) {
					try {
						const img = await renderImage({ id: avatar.id, scene: args.scene || 'portrait', background });
						content.push({ type: 'image', data: img.base64, mimeType: img.mimeType });
					} catch {
						/* preview is optional — fall through to the interactive + embed views */
					}
				}

				// Interactive, rotatable 3D for clients that render HTML resources.
				content.push({
					type: 'resource',
					resource: {
						uri: `avatar://${avatar.id || 'external'}`,
						mimeType: 'text/html',
						text: html,
					},
				});

				content.push(
					textBlock(
						`${avatar.name} — live 3D avatar from three.ws.\n\n` +
							`Interactive view: ${viewer}\n` +
							`Embed (live, like a YouTube video):\n${iframe}\n\n` +
							`Embed URL: ${embed}`,
					),
				);

				return {
					content,
					structuredContent: {
						id: avatar.id,
						name: avatar.name,
						model_url: avatar.model_url,
						embed_url: embed,
						viewer_url: viewer,
						iframe,
					},
				};
			},
		},

		{
			definition: {
				name: 'avatar_embed_code',
				description:
					'Get a ready-to-paste iframe that embeds a live, interactive three.ws 3D avatar ' +
					'into any website or app — as easy as embedding a YouTube video.',
				inputSchema: {
					type: 'object',
					properties: {
						...selectorProps,
						background: { type: 'string', enum: ['transparent', 'dark', 'light'], default: 'transparent' },
						width: { type: 'string', default: '100%', description: 'CSS width, e.g. "100%" or "480px".' },
						height: { type: 'integer', minimum: 160, maximum: 1080, default: 480 },
						idle: { type: 'boolean', default: true, description: 'Play the idle animation loop.' },
						overlay: { type: 'boolean', default: false, description: 'Chrome-free mode (good for OBS/overlays).' },
					},
					anyOf: [{ required: ['id'] }, { required: ['handle'] }, { required: ['model'] }],
				},
			},
			handler: async (args) => {
				// Validate the avatar exists (and surface a clear error if not) before
				// handing back embed code that would otherwise 404 for the user.
				const avatar = await resolveAvatar(args);
				const embed = embedUrl({
					id: avatar.id,
					handle: args.handle,
					model: args.model,
					background: args.background || 'transparent',
					idle: args.idle !== false,
					overlay: Boolean(args.overlay),
				});
				const iframe = iframeSnippet(embed, { width: args.width || '100%', height: args.height || 480 });
				return {
					content: [textBlock(`Embed code for ${avatar.name}:\n\n${iframe}\n\nEmbed URL: ${embed}`)],
					structuredContent: { embed_url: embed, iframe, name: avatar.name, id: avatar.id },
				};
			},
		},

		{
			definition: {
				name: 'get_avatar',
				description:
					'Fetch metadata for a three.ws avatar (name, GLB model url, owner, visibility) by id or @handle.',
				inputSchema: {
					type: 'object',
					properties: { id: selectorProps.id, handle: selectorProps.handle },
					anyOf: [{ required: ['id'] }, { required: ['handle'] }],
				},
			},
			handler: async (args) => {
				const avatar = await resolveAvatar(args);
				return {
					content: [textBlock(JSON.stringify(avatar, null, 2))],
					structuredContent: avatar,
				};
			},
		},
	];
}
