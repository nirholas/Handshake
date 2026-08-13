import {
	listAvatars,
	getAvatar,
	getAvatarBySlug,
	searchPublicAvatars,
	resolveAvatarUrl,
	deleteAvatar,
} from '../../_lib/avatars.js';
import {
	renderModelViewerHtml,
	formatAvatarList,
	safeCssValue,
	safeCssLength,
	safeHttpsUrl,
} from '../render.js';
import { readMcpPolicyByAvatar } from '../embed-policy.js';
import { resolveRenderParams, renderAvatarImage } from '../../_lib/avatar-render.js';
import { logAudit } from '../../_lib/audit.js';

function rpcError(code, message, data) {
	const e = new Error(message);
	e.code = code;
	e.data = data;
	return e;
}

// MCP tool annotations (2025-06-18 spec). destructiveHint defaults to TRUE when
// omitted, so every tool sets all four hints explicitly. Reads of account/gallery
// state are not idempotent (the underlying data and signed URLs change between
// calls) but never write anything.
const READ_ANNOTATIONS = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: false,
	openWorldHint: true,
};

export const toolDefs = [
	{
		name: 'list_my_avatars',
		title: 'List my avatars',
		annotations: READ_ANNOTATIONS,
		description:
			"List the authenticated user's avatars. Returns id, name, slug, size, visibility, and direct model_url (when visibility permits).",
		inputSchema: {
			type: 'object',
			properties: {
				limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
				cursor: {
					type: 'string',
					description: 'Opaque pagination cursor from previous response.',
				},
				visibility: { type: 'string', enum: ['private', 'unlisted', 'public'] },
			},
			additionalProperties: false,
		},
		scope: 'avatars:read',
		async handler(args, auth) {
			const result = await listAvatars({
				userId: auth.userId,
				limit: args.limit || 25,
				cursor: args.cursor,
				visibility: args.visibility,
			});
			return {
				content: [{ type: 'text', text: formatAvatarList(result.avatars) }],
				structuredContent: result,
			};
		},
	},
	{
		name: 'get_avatar',
		title: 'Get avatar',
		annotations: READ_ANNOTATIONS,
		description:
			'Fetch a single avatar by id or by owner+slug. Returns metadata and a model_url (public/unlisted) or short-lived signed URL (private).',
		inputSchema: {
			type: 'object',
			properties: {
				id: { type: 'string', format: 'uuid' },
				slug: { type: 'string' },
			},
			additionalProperties: false,
		},
		scope: 'avatars:read',
		async handler(args, auth) {
			const avatar = args.id
				? await getAvatar({ id: args.id, requesterId: auth.userId })
				: args.slug
					? await getAvatarBySlug({
							ownerId: auth.userId,
							slug: args.slug,
							requesterId: auth.userId,
						})
					: null;
			if (!avatar) throw new Error('avatar not found');
			const urlInfo = await resolveAvatarUrl(avatar);
			const merged = { ...avatar, ...urlInfo };
			return {
				content: [{ type: 'text', text: JSON.stringify(merged, null, 2) }],
				structuredContent: merged,
			};
		},
	},
	{
		name: 'search_public_avatars',
		title: 'Search public avatars',
		annotations: READ_ANNOTATIONS,
		description:
			'Search the public avatar gallery. Useful for finding characters to render without prior knowledge of an id.',
		inputSchema: {
			type: 'object',
			properties: {
				q: { type: 'string', description: 'Free-text search over name and description.' },
				tag: { type: 'string', description: 'Filter to one tag.' },
				limit: { type: 'integer', minimum: 1, maximum: 50, default: 12 },
			},
			additionalProperties: false,
		},
		async handler(args, auth) {
			// Unauthenticated callers (x402/anonymous) are capped at 10 to prevent bulk enumeration.
			const maxLimit = auth.userId ? 50 : 10;
			const result = await searchPublicAvatars({
				q: args.q,
				tag: args.tag,
				limit: Math.min(args.limit || 12, maxLimit),
			});
			return {
				content: [
					{ type: 'text', text: formatAvatarList(result.avatars, { public: true }) },
				],
				structuredContent: result,
			};
		},
	},
	{
		name: 'render_avatar',
		title: 'Render avatar',
		// Builds viewer HTML in-memory; persists nothing — a read, not a write.
		annotations: READ_ANNOTATIONS,
		description:
			'Produce an HTML <model-viewer> snippet that renders the given avatar. ' +
			'Return this text as an inline HTML artifact to display an interactive 3D avatar.',
		inputSchema: {
			type: 'object',
			properties: {
				id: { type: 'string', format: 'uuid' },
				slug: { type: 'string' },
				auto_rotate: { type: 'boolean', default: true },
				background: {
					type: 'string',
					description: 'CSS background color or gradient.',
					default: 'transparent',
				},
				height: { type: 'string', default: '480px' },
				width: { type: 'string', default: '100%' },
				camera_orbit: {
					type: 'string',
					description: 'model-viewer camera-orbit value, e.g. "0deg 80deg 2m".',
				},
				poster: {
					type: 'string',
					description: 'Optional poster image URL shown while loading.',
				},
				ar: {
					type: 'boolean',
					default: true,
					description: 'Include AR button for mobile.',
				},
			},
			additionalProperties: false,
		},
		scope: 'avatars:read',
		async handler(args, auth) {
			const avatar = args.id
				? await getAvatar({ id: args.id, requesterId: auth.userId })
				: args.slug
					? await getAvatarBySlug({
							ownerId: auth.userId,
							slug: args.slug,
							requesterId: auth.userId,
						})
					: null;
			if (!avatar) throw new Error('avatar not found');
			// surfaces.mcp gate — check if a registered agent owns this avatar
			const _mcpPolicy = await readMcpPolicyByAvatar(avatar.id);
			if (_mcpPolicy && _mcpPolicy.surfaces?.mcp === false) {
				// Slug in `message`, detail in the `data` object: the shape every
				// other rpcError call site in the MCP tools uses. Passing the
				// sentence as `data` instead left clients with a bare
				// "embed_denied_surface" and no explanation to show a user.
				throw rpcError(-32000, 'embed_denied_surface', {
					reason: 'This agent disallows the MCP surface.',
					avatar_id: avatar.id,
				});
			}
			const urlInfo = await resolveAvatarUrl(avatar, { expiresIn: 3600 });
			const html = renderModelViewerHtml({
				src: urlInfo.url,
				name: avatar.name,
				poster: safeHttpsUrl(args.poster),
				background: safeCssValue(args.background, 'transparent'),
				height: safeCssLength(args.height, '480px'),
				width: safeCssLength(args.width, '100%'),
				autoRotate: args.auto_rotate !== false,
				ar: args.ar !== false,
				cameraOrbit: safeCssValue(args.camera_orbit, ''),
			});
			// Keep chat text short so claude.ai doesn't dump the full HTML into the
			// transcript. The HTML goes in the resource entry, which clients render
			// as an inline artifact when mimeType is text/html.
			const summary = `Rendered avatar "${avatar.name}". Display the attached text/html resource as an inline HTML artifact.`;
			return {
				content: [
					{ type: 'text', text: summary },
					{
						type: 'resource',
						resource: {
							uri: `avatar://${avatar.id}`,
							mimeType: 'text/html',
							text: html,
						},
					},
				],
				structuredContent: { html, avatar: { ...avatar, ...urlInfo } },
			};
		},
	},
	{
		name: 'render_avatar_image',
		title: 'Render an avatar to an image',
		// Persists the render to storage, but the cache keys on the exact
		// parameters: repeating a call returns the cached image with no
		// additional effect — idempotent, non-destructive write.
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		description:
			'Render a stored avatar to a real PNG/JPEG/WebP image (headless three.js) and ' +
			'return its URL — ready for an <img> tag, social card, or game loader. Choose a ' +
			'camera framing (scene), an optional pose preset and ARKit-52 expression. Renders ' +
			'are cached, so repeat calls with the same parameters return instantly. Works on ' +
			'your own avatars (any visibility) and on public avatars.',
		inputSchema: {
			type: 'object',
			properties: {
				avatar_id: { type: 'string', format: 'uuid', description: 'The avatar to render.' },
				scene: {
					type: 'string',
					enum: ['full-body', 'upper-body', 'portrait', 'headshot'],
					default: 'upper-body',
					description: 'Camera framing preset.',
				},
				pose: {
					type: 'string',
					description: 'Optional pose preset id (see pose_model / the render catalog).',
				},
				expression: {
					type: 'object',
					description: 'Optional ARKit-52 morph map, e.g. {"mouthSmile":0.6}.',
					additionalProperties: { type: 'number' },
				},
				size: {
					type: 'integer',
					minimum: 64,
					maximum: 2048,
					default: 512,
					description: 'Square pixel dimension.',
				},
				bg: {
					type: 'string',
					default: 'transparent',
					description: 'Background: a CSS color or "transparent".',
				},
				format: {
					type: 'string',
					enum: ['png', 'jpeg', 'webp'],
					default: 'png',
				},
			},
			required: ['avatar_id'],
			additionalProperties: false,
		},
		scope: 'avatars:read',
		async handler(args, auth) {
			// Same visibility gate as get_avatar: an owner sees any visibility; a
			// non-owner sees only public/unlisted; private-not-yours reads as missing.
			const avatar = await getAvatar({ id: args.avatar_id, requesterId: auth.userId });
			if (!avatar) throw new Error('avatar not found');

			const urlInfo = await resolveAvatarUrl(avatar);
			if (!urlInfo?.url) {
				return {
					content: [
						{ type: 'text', text: 'Error: this avatar has no model to render yet.' },
					],
					isError: true,
				};
			}

			const resolved = resolveRenderParams({
				scene: args.scene,
				size: args.size,
				bg: args.bg,
				format: args.format,
				pose: args.pose,
				expression: args.expression,
			});
			if (resolved.error) {
				return {
					content: [{ type: 'text', text: `Error: ${resolved.error.message}` }],
					isError: true,
				};
			}

			let out;
			try {
				out = await renderAvatarImage({
					avatar,
					glbUrl: urlInfo.url,
					params: resolved.params,
					awaitUpload: true,
				});
			} catch (err) {
				return {
					content: [
						{
							type: 'text',
							text: `Render failed: ${err?.message || 'the avatar could not be rendered'}.`,
						},
					],
					isError: true,
				};
			}

			// A requested expression the model cannot express used to vanish
			// silently (a morph-less avatar rendered fine with none of it applied).
			// Tell the caller which morphs did not land.
			const missingMorphs = out.expressionReport?.missing?.length ? out.expressionReport.missing : null;
			const morphNote = missingMorphs
				? `\nNote: this model has no morph target(s) named ${missingMorphs.join(', ')}; that part of the expression was not applied.`
				: '';
			return {
				content: [
					{
						type: 'text',
						text: `Rendered "${avatar.name}" (${resolved.params.scene}).\n${out.imageUrl}${morphNote}`,
					},
				],
				structuredContent: {
					image_url: out.imageUrl,
					scene: resolved.params.scene,
					cached: out.cached,
					...(missingMorphs ? { expression_missing: missingMorphs } : {}),
				},
			};
		},
	},
	{
		name: 'delete_avatar',
		title: 'Delete avatar',
		// Deletes a user's avatar — the destructive hint is real here.
		annotations: {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: true,
		},
		description: 'Soft-delete an avatar you own. Requires avatars:delete scope.',
		inputSchema: {
			type: 'object',
			properties: {
				id: { type: 'string', format: 'uuid' },
				confirm: {
					type: 'boolean',
					description: 'Must be true to confirm permanent deletion.',
				},
			},
			required: ['id'],
			additionalProperties: false,
		},
		scope: 'avatars:delete',
		async handler(args, auth) {
			if (!args.confirm) {
				return {
					content: [
						{
							type: 'text',
							text: 'Set confirm: true to permanently delete this avatar.',
						},
					],
					isError: true,
				};
			}
			const result = await deleteAvatar({ id: args.id, userId: auth.userId });
			if (!result) throw new Error('avatar not found or not yours');
			logAudit({
				userId: auth.userId,
				action: 'delete_avatar',
				resourceId: args.id,
				meta: { via: 'mcp' },
			});
			return { content: [{ type: 'text', text: `Deleted avatar ${args.id}.` }] };
		},
	},
];
