// three.ws 3D Studio MCP — generation tools.
//
// text_to_3d / image_to_3d submit a real reconstruction job to Replicate
// (Microsoft TRELLIS by default) and return a job handle. generation_status
// polls that job and, when finished, hands back the GLB URL plus an inline
// <model-viewer> artifact so the model appears directly in the chat. preview_3d
// renders any public GLB the same way.

import { limits } from '../../_lib/rate-limit.js';
import { createRegenProvider } from '../../_providers/replicate.js';
import { textToImage } from '../text-to-image.js';
import {
	renderModelViewerHtml,
	safeCssValue,
	safeCssLength,
	safeHttpsUrl,
} from '../../_mcp/render.js';

function rpcError(code, message, data) {
	const e = new Error(message);
	e.code = code;
	e.data = data;
	return e;
}

function rateKey(auth) {
	return auth.userId || auth.rateKey || 'anon';
}

async function enforce(limiter, auth) {
	const rl = await limiter(rateKey(auth));
	if (!rl.success) {
		throw rpcError(-32000, 'rate_limited', {
			retry_after: Math.ceil((rl.reset - Date.now()) / 1000),
		});
	}
}

// Lazily construct the Replicate-backed provider so a missing token surfaces as
// a clean tool error rather than crashing module load for the whole server.
function regenProvider() {
	try {
		return createRegenProvider();
	} catch (err) {
		throw rpcError(-32000, '3D generation is not configured', { reason: err.message });
	}
}

function isPublicHttpsUrl(s) {
	try {
		const u = new URL(String(s));
		if (u.protocol !== 'https:') return false;
		const h = u.hostname;
		if (h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0') return false;
		if (h.startsWith('169.254.') || h.startsWith('10.') || h.startsWith('192.168.')) return false;
		if (h.endsWith('.internal') || h.endsWith('.local')) return false;
		return true;
	} catch {
		return false;
	}
}

const POLL_HINT =
	'Call generation_status with this job_id to check progress. ' +
	'Reconstruction typically finishes in 30–90 seconds.';

function viewerArtifact({ glbUrl, name, options = {} }) {
	const html = renderModelViewerHtml({
		src: glbUrl,
		name: name || '3D model',
		poster: safeHttpsUrl(options.poster),
		background: safeCssValue(options.background, 'transparent'),
		height: safeCssLength(options.height, '480px'),
		width: safeCssLength(options.width, '100%'),
		autoRotate: options.auto_rotate !== false,
		ar: options.ar !== false,
		cameraOrbit: safeCssValue(options.camera_orbit, ''),
	});
	return {
		type: 'resource',
		resource: { uri: glbUrl, mimeType: 'text/html', text: html },
	};
}

export const toolDefs = [
	{
		name: 'text_to_3d',
		title: 'Generate a 3D model from a text prompt',
		description:
			'Turn a text description into a textured 3D model (GLB). Runs a fast text-to-image pass, then reconstructs a mesh from that image with Microsoft TRELLIS. Returns a job_id (poll with generation_status) plus the intermediate preview image. Best results: a single, clearly described object — "a worn leather armchair", "a low-poly red fox", "a sci-fi helmet".',
		inputSchema: {
			type: 'object',
			properties: {
				prompt: {
					type: 'string',
					minLength: 3,
					maxLength: 1000,
					description: 'What to generate. Describe one subject clearly.',
				},
				aspect_ratio: {
					type: 'string',
					enum: ['1:1', '4:3', '3:4', '16:9', '9:16'],
					default: '1:1',
					description: 'Aspect ratio of the intermediate reference image.',
				},
			},
			required: ['prompt'],
			additionalProperties: false,
		},
		async handler(args, auth) {
			await enforce(limits.mcp3dGenerate, auth);
			const provider = regenProvider();
			const { imageUrl, model } = await textToImage(args.prompt, {
				aspectRatio: args.aspect_ratio || '1:1',
			});
			const job = await provider.submit({
				mode: 'reconstruct',
				params: { image: imageUrl, prompt: args.prompt },
			});
			return {
				content: [
					{
						type: 'text',
						text:
							`Started generating a 3D model for "${args.prompt}".\n` +
							`Reference image: ${imageUrl}\n` +
							`Job ID: ${job.extJobId}\n${POLL_HINT}`,
					},
				],
				structuredContent: {
					job_id: job.extJobId,
					status: 'queued',
					prompt: args.prompt,
					preview_image_url: imageUrl,
					text_to_image_model: model,
					eta_seconds: job.eta,
				},
			};
		},
	},
	{
		name: 'image_to_3d',
		title: 'Reconstruct a 3D model from an image',
		description:
			'Reconstruct a textured 3D model (GLB) from a single reference image URL using Microsoft TRELLIS. Returns a job_id to poll with generation_status. The cleaner the input — one subject, plain background, even lighting — the better the mesh.',
		inputSchema: {
			type: 'object',
			properties: {
				image_url: {
					type: 'string',
					format: 'uri',
					description: 'Public https URL of the reference image (PNG/JPG/WebP).',
				},
				prompt: {
					type: 'string',
					maxLength: 1000,
					description: 'Optional text hint passed to the reconstruction model.',
				},
			},
			required: ['image_url'],
			additionalProperties: false,
		},
		async handler(args, auth) {
			await enforce(limits.mcp3dGenerate, auth);
			if (!isPublicHttpsUrl(args.image_url)) {
				return {
					content: [{ type: 'text', text: 'Error: image_url must be a public https URL.' }],
					isError: true,
				};
			}
			const provider = regenProvider();
			const job = await provider.submit({
				mode: 'reconstruct',
				params: { image: args.image_url, prompt: args.prompt },
			});
			return {
				content: [
					{
						type: 'text',
						text: `Started reconstructing a 3D model from the image.\nJob ID: ${job.extJobId}\n${POLL_HINT}`,
					},
				],
				structuredContent: {
					job_id: job.extJobId,
					status: 'queued',
					source_image_url: args.image_url,
					eta_seconds: job.eta,
				},
			};
		},
	},
	{
		name: 'generation_status',
		title: 'Check a 3D generation job',
		description:
			'Poll a text_to_3d or image_to_3d job by its job_id. While running it reports the status; when finished it returns the GLB download URL and an inline <model-viewer> artifact — display that text/html resource as an interactive 3D artifact.',
		inputSchema: {
			type: 'object',
			properties: {
				job_id: {
					type: 'string',
					minLength: 1,
					maxLength: 200,
					description: 'The job_id returned by text_to_3d or image_to_3d.',
				},
			},
			required: ['job_id'],
			additionalProperties: false,
		},
		async handler(args, auth) {
			await enforce(limits.mcp3dStatus, auth);
			const provider = regenProvider();
			const result = await provider.status(args.job_id);

			if (result.status === 'done' && result.resultGlbUrl) {
				const glbUrl = result.resultGlbUrl;
				return {
					content: [
						{
							type: 'text',
							text:
								`Your 3D model is ready.\nGLB: ${glbUrl}\n` +
								'Display the attached text/html resource as an inline 3D artifact.',
						},
						viewerArtifact({ glbUrl, name: '3D model' }),
					],
					structuredContent: { job_id: args.job_id, status: 'done', glb_url: glbUrl },
				};
			}

			if (result.status === 'failed') {
				return {
					content: [
						{ type: 'text', text: `Generation failed: ${result.error || 'unknown error'}` },
					],
					structuredContent: { job_id: args.job_id, status: 'failed', error: result.error || null },
					isError: true,
				};
			}

			return {
				content: [
					{
						type: 'text',
						text: `Still ${result.status}. ${POLL_HINT}`,
					},
				],
				structuredContent: { job_id: args.job_id, status: result.status },
			};
		},
	},
	{
		name: 'preview_3d',
		title: 'Preview any GLB as an interactive 3D artifact',
		description:
			'Render any public GLB URL as an inline <model-viewer> HTML artifact — orbit controls, AR on mobile, auto-rotate. Display the returned text/html resource as an inline 3D artifact. Use it to view a generated model, or any GLB on the web.',
		inputSchema: {
			type: 'object',
			properties: {
				glb_url: { type: 'string', format: 'uri', description: 'Public https URL of a .glb file.' },
				auto_rotate: { type: 'boolean', default: true },
				ar: { type: 'boolean', default: true },
				background: {
					type: 'string',
					default: 'transparent',
					description: 'CSS background color or gradient.',
				},
				height: { type: 'string', default: '480px' },
				width: { type: 'string', default: '100%' },
				camera_orbit: {
					type: 'string',
					description: 'model-viewer camera-orbit value, e.g. "0deg 80deg 2m".',
				},
			},
			required: ['glb_url'],
			additionalProperties: false,
		},
		async handler(args) {
			if (!isPublicHttpsUrl(args.glb_url)) {
				return {
					content: [{ type: 'text', text: 'Error: glb_url must be a public https URL.' }],
					isError: true,
				};
			}
			return {
				content: [
					{
						type: 'text',
						text: 'Display the attached text/html resource as an inline 3D artifact.',
					},
					viewerArtifact({ glbUrl: args.glb_url, name: '3D model', options: args }),
				],
				structuredContent: { glb_url: args.glb_url },
			};
		},
	},
];
