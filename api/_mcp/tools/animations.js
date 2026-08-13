// MCP tools for the animation preset library.
//
//   • list_animations  (free)  — the curated catalogue of retargetable clips.
//   • apply_animation   (paid) — retarget a preset onto a caller-supplied rigged
//                                GLB and return an animated GLB (or the
//                                retargeted clip JSON), plus a retarget report.
//
// apply_animation runs three.js headless, exactly like scripts/build-animations.mjs:
// parse the rig with GLTFLoader, rewrite the canonical clip's track names onto
// the rig's actual bones, bake with GLTFExporter. The DOM shims below cover the
// handful of browser globals three's loader/exporter touch; they're scoped to
// this serverless function (no DOM exists here) and applied before any three
// addon is dynamically imported inside the handler.

import { limits } from '../../_lib/rate-limit.js';
import { resolveOrigin } from '../origin.js';
import { fetchModel, FetchModelError } from '../../_lib/fetch-model.js';
import { createRegenProvider } from '../../_providers/gcp.js';
import {
	canonicalNodeMapFromObject,
	retargetClip,
	scaleClipSpeed,
	parseClipJSON,
	MIN_COVERAGE,
} from '../../../src/animation-retarget.js';
import { categoryOf } from '../../../src/animation-presets.js';
import {
	describe as describeSignature,
	energyBand,
	similarTo,
	slotFit,
} from '../../../src/runtime/motion-signature.js';
import { SLOTS, DEFAULT_ANIMATION_MAP } from '../../../src/runtime/animation-slots.js';

// Largest base64-encoded GLB we'll inline in a JSON-RPC response before falling
// back to the (small) clip JSON. Keeps responses sane for very heavy avatars.
const MAX_INLINE_GLB_BYTES = 8 * 1024 * 1024;

function rpcError(code, message, data) {
	const e = new Error(message);
	e.code = code;
	e.data = data;
	return e;
}

// ── Catalogue helpers ────────────────────────────────────────────────────────
async function loadManifest(origin) {
	const res = await fetch(`${origin}/animations/manifest.json`, { cache: 'no-store' });
	if (!res.ok) throw new Error(`manifest fetch failed (HTTP ${res.status})`);
	const manifest = await res.json();
	if (!Array.isArray(manifest) || !manifest.length)
		throw new Error('animation manifest is empty');
	return manifest;
}

async function loadSignatures(origin) {
	const res = await fetch(`${origin}/animations/signatures.json`, { cache: 'no-store' });
	if (!res.ok) throw new Error(`signatures fetch failed (HTTP ${res.status})`);
	const index = await res.json();
	if (!index?.clips || !Object.keys(index.clips).length) throw new Error('signature index is empty');
	return index;
}

// Own-property lookup only. The index comes back from JSON.parse, so it carries
// Object.prototype: a caller-supplied clip name of "constructor" or "toString"
// would otherwise resolve an inherited member, sail past the not-found guard,
// and be measured as if it were a motion signature. Same defense dispatch.js
// applies to the tool table.
function signatureFor(index, clip) {
	return Object.hasOwn(index.clips, clip) ? index.clips[clip] : null;
}

async function loadClipJSON(origin, def) {
	// def.url is a site-relative path like /animations/clips/idle.json
	const res = await fetch(`${origin}${def.url}`, { cache: 'no-store' });
	if (!res.ok) throw new Error(`clip fetch failed (HTTP ${res.status})`);
	return res.json();
}

async function safeFetchModel(url) {
	try {
		return await fetchModel(url);
	} catch (e) {
		if (e instanceof FetchModelError) throw new Error(`fetch failed: ${e.message} (${e.code})`);
		throw e;
	}
}

// ── Headless three setup (shims + loaders) ──────────────────────────────────
let _shimmed = false;
function installDomShims() {
	if (_shimmed) return;
	if (typeof globalThis.self === 'undefined') globalThis.self = globalThis;
	if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
	if (typeof globalThis.document === 'undefined') {
		globalThis.document = { createElementNS: () => ({}) };
	}
	if (typeof globalThis.FileReader === 'undefined') {
		// GLTFExporter reads Blob-wrapped binary/texture chunks via FileReader.
		globalThis.FileReader = class extends EventTarget {
			readAsDataURL(blob) {
				blob.arrayBuffer().then((buf) => {
					const b64 = Buffer.from(buf).toString('base64');
					this.result = `data:${blob.type || 'application/octet-stream'};base64,${b64}`;
					this.onload?.({ target: this });
					this.dispatchEvent(new Event('load'));
				});
			}
			readAsArrayBuffer(blob) {
				blob.arrayBuffer().then((buf) => {
					this.result = buf;
					this.onload?.({ target: this });
					this.dispatchEvent(new Event('load'));
				});
			}
		};
	}
	_shimmed = true;
}

async function parseGLB(bytes) {
	const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
	const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
	const loader = new GLTFLoader();
	return new Promise((resolve, reject) => loader.parse(ab, '', resolve, reject));
}

// Bake an animated GLB, bounded by a timeout. GLTFExporter reads texture pixels
// through a canvas; headless Node has none, so a textured rig can stall the
// exporter indefinitely. We race it against a timeout and let the caller fall
// back to the (always-reliable) retargeted clip JSON rather than hang the
// function. The first-class, guaranteed GLB path is the browser /pose gallery.
const GLB_EXPORT_TIMEOUT_MS = 15_000;
async function exportGLB(scene, clip) {
	const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
	const exporter = new GLTFExporter();
	const bake = exporter.parseAsync(scene, {
		binary: true,
		animations: [clip],
		embedImages: true,
	});
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(
			() => reject(new Error('headless GLB bake timed out (textured rig)')),
			GLB_EXPORT_TIMEOUT_MS,
		);
	});
	try {
		return await Promise.race([bake, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

// Hip-translation scale: target rig's rest hip height ÷ the clip's authored hip
// height, so root motion lands on the new rig instead of the authoring rig.
async function computeHipScale(scene, clip) {
	const { Vector3 } = await import('three');
	let hipsNode = null;
	scene.traverse((n) => {
		if (
			!hipsNode &&
			n.name &&
			/(^|[:_])hips$/i.test(n.name.replace(/^mixamorig\d*[:_]?/i, ''))
		) {
			hipsNode = n;
		}
	});
	if (!hipsNode) return 1;
	scene.updateMatrixWorld(true);
	const targetY = hipsNode.getWorldPosition(new Vector3()).y;
	const track = clip.tracks.find((t) =>
		/hips\.position$/i.test(t.name.replace(/^mixamorig\d*[:_]?/i, '')),
	);
	const sourceY = track && track.values.length >= 2 ? track.values[1] : 0;
	if (targetY > 0.05 && sourceY > 0.05) return Math.min(5, Math.max(0.2, targetY / sourceY));
	return 1;
}

// ── Tool defs ───────────────────────────────────────────────────────────────
export const toolDefs = [
	{
		name: 'list_animations',
		title: 'List animation presets',
		// Reads the platform's own static, curated manifest — deterministic
		// and closed-world.
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		description:
			'List the curated, retargetable animation presets in the three.ws library — name, label, category, and whether the clip loops. Use this to discover valid `animation` values for apply_animation.',
		inputSchema: {
			type: 'object',
			properties: {
				category: {
					type: 'string',
					description:
						'Optional category filter (e.g. "dance", "locomotion", "gesture").',
				},
			},
			additionalProperties: false,
		},
		async handler(args, auth, req) {
			const origin = resolveOrigin(req);
			const manifest = await loadManifest(origin);
			let defs = manifest.map((d) => ({
				name: d.name,
				label: d.label || d.name,
				category: categoryOf(d.name),
				loop: d.loop !== false,
			}));
			if (args.category) {
				const c = String(args.category).toLowerCase();
				defs = defs.filter((d) => d.category === c);
			}
			const lines = defs
				.map(
					(d) =>
						`  ${d.name.padEnd(22)} ${d.loop ? 'loop' : 'once'}  [${d.category}]  ${d.label}`,
				)
				.join('\n');
			return {
				content: [{ type: 'text', text: `${defs.length} animation presets:\n${lines}` }],
				structuredContent: { count: defs.length, animations: defs },
			};
		},
	},
	{
		name: 'animation_signature',
		title: 'Measure what an animation clip actually does',
		// Reads the platform's own measured index (public/animations/signatures.json,
		// generated by scripts/build-motion-signatures.mjs): deterministic, closed-world.
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		description:
			'The measured motion signature of a baked clip: energy, tempo, which body region leads, loop-seam cleanliness, root travel, and whether it survives as an upper-body overlay. Pass `slot` to also get a fit verdict ("ok" or "warn" with the reason) for playing this clip in that runtime slot (idle, wave, fidget and the rest). Use it to pick clips by what they do rather than by name.',
		inputSchema: {
			type: 'object',
			required: ['clip'],
			properties: {
				clip: {
					type: 'string',
					description: 'Clip name from list_animations (e.g. "idle", "wave", "av-conductor").',
				},
				slot: {
					type: 'string',
					description: 'Optional runtime slot to check the clip against (e.g. "idle", "fidget", "wave").',
				},
			},
			additionalProperties: false,
		},
		async handler(args, auth, req) {
			const origin = resolveOrigin(req);
			const index = await loadSignatures(origin);
			const sig = signatureFor(index, String(args.clip));
			if (!sig) {
				throw rpcError(-32602, `No signature for "${args.clip}". Use list_animations for valid names.`);
			}
			let fit = null;
			if (args.slot !== undefined) {
				const slot = String(args.slot);
				if (!SLOTS.includes(slot)) {
					throw rpcError(-32602, `"${slot}" is not a runtime slot. Slots: ${SLOTS.join(', ')}.`);
				}
				fit = { slot, defaultClip: DEFAULT_ANIMATION_MAP[slot] ?? slot, ...slotFit(slot, sig) };
			}
			const text = [
				`${sig.clip}: ${describeSignature(sig)}`,
				...(fit ? [`Fit for "${fit.slot}": ${fit.level}. ${fit.message}`] : []),
			].join('\n');
			return {
				content: [{ type: 'text', text }],
				structuredContent: { signature: { ...sig, band: energyBand(sig) }, ...(fit ? { fit } : {}) },
			};
		},
	},
	{
		name: 'find_similar_animations',
		title: 'Find clips with similar measured motion',
		// Pure arithmetic over the same measured index as animation_signature.
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		description:
			'Rank the library\'s clips by measured-motion distance from a reference clip (regional shares, energy, tempo, travel). Use it for "more like this": alternatives when a clip does not fit a slot, or variety without changing the mood.',
		inputSchema: {
			type: 'object',
			required: ['clip'],
			properties: {
				clip: {
					type: 'string',
					description: 'Reference clip name from list_animations.',
				},
				limit: {
					type: 'integer',
					minimum: 1,
					maximum: 20,
					description: 'How many neighbors to return (default 5).',
				},
			},
			additionalProperties: false,
		},
		async handler(args, auth, req) {
			const origin = resolveOrigin(req);
			const index = await loadSignatures(origin);
			if (!signatureFor(index, String(args.clip))) {
				throw rpcError(-32602, `No signature for "${args.clip}". Use list_animations for valid names.`);
			}
			const limit = Math.max(1, Math.min(20, Number.parseInt(args.limit ?? 5, 10) || 5));
			const matches = similarTo(String(args.clip), index.clips, limit).map((m) => ({
				clip: m.clip,
				distance: Math.round(m.distance * 1000) / 1000,
				band: energyBand(m.signature),
				description: describeSignature(m.signature),
			}));
			const lines = matches.map((m) => `  ${m.clip.padEnd(24)} d=${m.distance}  [${m.band}]  ${m.description}`);
			return {
				content: [{ type: 'text', text: `${matches.length} clips nearest to ${args.clip}:\n${lines.join('\n')}` }],
				structuredContent: { clip: String(args.clip), similar: matches },
			};
		},
	},
	{
		name: 'apply_animation',
		title: 'Apply an animation preset to a rigged model',
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
		description:
			'Retarget a curated animation preset onto a caller-supplied rigged humanoid GLB. Returns the retargeted three.js AnimationClip JSON (keyed to the rig\'s actual bone names, hip translation rescaled to its proportions) plus a retarget report — load it alongside the model and play. Set format="glb" to also bake an animated GLB server-side (best-effort: textured rigs may exceed the headless bake budget and fall back to clip JSON — the /pose gallery is the guaranteed GLB export). SSRF-hardened: only public https model URLs are fetched.',
		inputSchema: {
			type: 'object',
			properties: {
				model_url: {
					type: 'string',
					format: 'uri',
					description: 'Public https URL of a rigged humanoid .glb to animate.',
				},
				animation: {
					type: 'string',
					description: 'Preset name from list_animations (e.g. "idle", "walk", "dance").',
				},
				format: {
					type: 'string',
					enum: ['glb', 'clip'],
					default: 'clip',
					description:
						'clip = retargeted AnimationClip JSON (reliable); glb = also attempt a baked animated GLB (base64, best-effort).',
				},
				speed: {
					type: 'number',
					minimum: 0.25,
					maximum: 2.5,
					default: 1,
					description:
						'Playback-speed multiplier baked into the result (1.8 turns a walk into a run).',
				},
			},
			required: ['model_url', 'animation'],
			additionalProperties: false,
		},
		async handler(args, auth, req) {
			const rl = await limits.mcpOptimize?.(auth.userId || auth.rateKey);
			if (rl && !rl.success)
				throw rpcError(-32000, 'rate_limited', {
					retry_after: Math.ceil((rl.reset - Date.now()) / 1000),
				});

			const origin = resolveOrigin(req);
			const manifest = await loadManifest(origin);
			const def = manifest.find((d) => d.name === args.animation);
			if (!def) {
				throw rpcError(-32602, `unknown animation "${args.animation}"`, {
					hint: 'call list_animations for valid names',
				});
			}

			installDomShims();
			const clipJSON = await loadClipJSON(origin, def);
			const baseClip = parseClipJSON(clipJSON, def.name);

			const { bytes, url, filename } = await safeFetchModel(args.model_url);
			let gltf;
			try {
				gltf = await parseGLB(bytes);
			} catch (e) {
				throw new Error(`could not parse the rigged GLB: ${e.message || e}`);
			}
			const scene = gltf.scene || gltf.scenes?.[0];
			if (!scene) throw new Error('the model has no scene to animate');

			const map = canonicalNodeMapFromObject(scene);
			if (map.size === 0) {
				throw new Error(
					'no recognizable humanoid skeleton found in the model — apply_animation needs a rigged GLB',
				);
			}
			const hipScale = await computeHipScale(scene, baseClip);
			const result = retargetClip(baseClip, map, { hipScale });

			const report = {
				animation: def.name,
				label: def.label || def.name,
				source_model: url,
				filename,
				bones_matched: result.matched,
				bones_total: result.total,
				coverage: Number(result.coverage.toFixed(3)),
				bones_unmapped: [...new Set(result.dropped)],
				hip_scale: Number(result.hipScale.toFixed(3)),
				speed: args.speed || 1,
				loop: def.loop !== false,
			};

			if (!result.clip) {
				return {
					content: [
						{
							type: 'text',
							text: `Could not retarget "${def.name}" onto this rig: only ${result.matched}/${result.total} tracks mapped (need ${Math.round(MIN_COVERAGE * 100)}%). The skeleton is too different from the canonical humanoid rig.`,
						},
					],
					structuredContent: { ok: false, ...report },
				};
			}

			const finalClip = scaleClipSpeed(result.clip, args.speed || 1);
			finalClip.name = def.name;

			const { AnimationClip } = await import('three');
			const clipResult = (note) => ({
				content: [
					{
						type: 'text',
						text: `Retargeted "${def.label || def.name}" → ${report.bones_matched}/${report.bones_total} bones (${Math.round(report.coverage * 100)}%), hip scale ${report.hip_scale}×.${note ? ' ' + note : ''} Returning AnimationClip JSON — load it alongside the model and play.`,
					},
				],
				structuredContent: {
					ok: true,
					...report,
					format: note ? 'clip-fallback' : 'clip',
					clip: AnimationClip.toJSON(finalClip),
				},
			});

			if (args.format !== 'glb') return clipResult();

			// Best-effort GLB bake. A textured rig can exceed the headless bake
			// budget (no canvas to read texture pixels) — fall back to clip JSON
			// rather than fail or hang.
			let glbBytes;
			try {
				glbBytes = Buffer.from(await exportGLB(scene, finalClip));
			} catch (e) {
				return clipResult(
					`Server-side GLB bake unavailable (${e.message || e}); use the /pose gallery to export a GLB in-browser.`,
				);
			}
			if (glbBytes.length > MAX_INLINE_GLB_BYTES) {
				return clipResult(
					`Animated GLB is ${(glbBytes.length / 1024 / 1024).toFixed(1)} MB — too large to inline.`,
				);
			}

			return {
				content: [
					{
						type: 'text',
						text: `Applied "${def.label || def.name}" to ${filename}: ${report.bones_matched}/${report.bones_total} bones (${Math.round(report.coverage * 100)}%), hip scale ${report.hip_scale}×, ${(glbBytes.length / 1024).toFixed(0)} KB animated GLB.`,
					},
				],
				structuredContent: {
					ok: true,
					...report,
					format: 'glb',
					glb_bytes: glbBytes.length,
					glb_base64: glbBytes.toString('base64'),
					mime_type: 'model/gltf-binary',
				},
			};
		},
	},
	{
		name: 'text_to_animation',
		title: 'Generate an animation from a text prompt and retarget it onto a model',
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
		description:
			'Generate a brand-new motion from a natural-language prompt (e.g. "waving confidently", "a slow tai-chi sweep") with a motion-diffusion model, then retarget it onto a caller-supplied rigged humanoid GLB — the same retarget engine apply_animation uses. Returns the retargeted three.js AnimationClip JSON (or a baked animated GLB) plus a report. Unlike preset libraries, the motion does not pre-exist: it is synthesized for the prompt. Requires the text2motion worker configured on the deployment.',
		inputSchema: {
			type: 'object',
			properties: {
				prompt: {
					type: 'string',
					minLength: 3,
					maxLength: 1000,
					description: 'Describe the motion to generate (e.g. "a celebratory jump", "waving hello").',
				},
				model_url: {
					type: 'string',
					format: 'uri',
					description: 'Public https URL of a rigged humanoid .glb to animate.',
				},
				duration_seconds: {
					type: 'number',
					minimum: 1,
					maximum: 10,
					default: 4,
					description: 'Length of the generated motion in seconds.',
				},
				format: {
					type: 'string',
					enum: ['glb', 'clip'],
					default: 'clip',
					description: 'clip = retargeted AnimationClip JSON (reliable); glb = also attempt a baked animated GLB.',
				},
				speed: {
					type: 'number',
					minimum: 0.25,
					maximum: 2.5,
					default: 1,
					description: 'Playback-speed multiplier baked into the result.',
				},
			},
			required: ['prompt', 'model_url'],
			additionalProperties: false,
		},
		async handler(args, auth, req) {
			const rl = await limits.mcpOptimize?.(auth.userId || auth.rateKey);
			if (rl && !rl.success)
				throw rpcError(-32000, 'rate_limited', {
					retry_after: Math.ceil((rl.reset - Date.now()) / 1000),
				});

			// The motion model runs on the GPU worker (workers/model-text2motion),
			// reached through the gcp provider's text2motion mode. Without it
			// configured, fail clean rather than fabricate motion.
			let provider;
			try {
				provider = createRegenProvider();
			} catch {
				throw rpcError(-32001, 'text-to-animation is not configured on this deployment');
			}
			if (!provider.supportsMode('text2motion')) {
				throw rpcError(-32001, 'text-to-animation is not configured (GCP_TEXT2MOTION_URL unset)');
			}

			const duration = Math.max(1, Math.min(10, Number(args.duration_seconds) || 4));
			const clipJSON = await generateMotionClip(provider, {
				prompt: args.prompt,
				duration_seconds: duration,
			});

			installDomShims();
			const baseClip = parseClipJSON(clipJSON, clipJSON.name || 'generated');

			const { bytes, url, filename } = await safeFetchModel(args.model_url);
			let gltf;
			try {
				gltf = await parseGLB(bytes);
			} catch (e) {
				throw new Error(`could not parse the rigged GLB: ${e.message || e}`);
			}
			const scene = gltf.scene || gltf.scenes?.[0];
			if (!scene) throw new Error('the model has no scene to animate');

			const map = canonicalNodeMapFromObject(scene);
			if (map.size === 0) {
				throw new Error('no recognizable humanoid skeleton found — text_to_animation needs a rigged GLB');
			}
			const hipScale = await computeHipScale(scene, baseClip);
			const result = retargetClip(baseClip, map, { hipScale });

			const report = {
				prompt: args.prompt,
				source_model: url,
				filename,
				bones_matched: result.matched,
				bones_total: result.total,
				coverage: Number(result.coverage.toFixed(3)),
				bones_unmapped: [...new Set(result.dropped)],
				hip_scale: Number(result.hipScale.toFixed(3)),
				speed: args.speed || 1,
			};

			if (!result.clip) {
				return {
					content: [
						{
							type: 'text',
							text: `Generated the motion but could not retarget it: only ${result.matched}/${result.total} tracks mapped (need ${Math.round(MIN_COVERAGE * 100)}%). The skeleton is too different from the canonical humanoid rig.`,
						},
					],
					structuredContent: { ok: false, ...report },
				};
			}

			const finalClip = scaleClipSpeed(result.clip, args.speed || 1);
			finalClip.name = baseClip.name;
			const { AnimationClip } = await import('three');

			const clipResult = (note) => ({
				content: [
					{
						type: 'text',
						text: `Generated "${args.prompt}" → retargeted onto ${filename}: ${report.bones_matched}/${report.bones_total} bones (${Math.round(report.coverage * 100)}%), hip scale ${report.hip_scale}×.${note ? ' ' + note : ''} Returning AnimationClip JSON — load it alongside the model and play.`,
					},
				],
				structuredContent: {
					ok: true,
					...report,
					format: note ? 'clip-fallback' : 'clip',
					clip: AnimationClip.toJSON(finalClip),
				},
			});

			if (args.format !== 'glb') return clipResult();

			let glbBytes;
			try {
				glbBytes = Buffer.from(await exportGLB(scene, finalClip));
			} catch (e) {
				return clipResult(`Server-side GLB bake unavailable (${e.message || e}); use the /pose gallery to export in-browser.`);
			}
			if (glbBytes.length > MAX_INLINE_GLB_BYTES) {
				return clipResult(`Animated GLB is ${(glbBytes.length / 1024 / 1024).toFixed(1)} MB — too large to inline.`);
			}
			return {
				content: [
					{
						type: 'text',
						text: `Generated "${args.prompt}" and baked it onto ${filename}: ${report.bones_matched}/${report.bones_total} bones, ${(glbBytes.length / 1024).toFixed(0)} KB animated GLB.`,
					},
				],
				structuredContent: {
					ok: true,
					...report,
					format: 'glb',
					glb_bytes: glbBytes.length,
					glb_base64: glbBytes.toString('base64'),
					mime_type: 'model/gltf-binary',
				},
			};
		},
	},
];

// Submit a text→motion job to the worker and poll to completion, returning the
// generated AnimationClip JSON. Bounded so a stuck worker can't hang the tool.
const MOTION_POLL_INTERVAL_MS = 2500;
const MOTION_POLL_TIMEOUT_MS = 60_000;

async function generateMotionClip(provider, { prompt, duration_seconds }) {
	const job = await provider.submit({
		mode: 'text2motion',
		sourceUrl: null,
		params: { prompt, duration_seconds, fps: 30 },
	});
	const deadline = Date.now() + MOTION_POLL_TIMEOUT_MS;
	let clipUrl = null;
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, MOTION_POLL_INTERVAL_MS));
		const st = await provider.status(job.extJobId);
		if (st.status === 'done') {
			clipUrl = st.resultClipUrl;
			break;
		}
		if (st.status === 'failed') {
			throw rpcError(-32000, `motion generation failed: ${st.error || 'unknown error'}`);
		}
	}
	if (!clipUrl) throw rpcError(-32000, 'motion generation timed out');

	const res = await fetch(clipUrl);
	if (!res.ok) throw rpcError(-32000, `could not fetch generated clip (HTTP ${res.status})`);
	return res.json();
}
