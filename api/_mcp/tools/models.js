import { limits } from '../../_lib/rate-limit.js';
import { fetchModel, FetchModelError } from '../../_lib/fetch-model.js';
import { inspectModel, suggestOptimizations } from '../../_lib/model-inspect.js';
import { describeModel, diffDescriptions, formatText } from '@three-ws/glb-diff';
import { validateBytes } from 'gltf-validator';

function rpcError(code, message, data) {
	const e = new Error(message);
	e.code = code;
	e.data = data;
	return e;
}

async function safeFetchModel(url) {
	try {
		return await fetchModel(url);
	} catch (e) {
		if (e instanceof FetchModelError) throw new Error(`fetch failed: ${e.message} (${e.code})`);
		throw e;
	}
}

// MCP tool annotations (2025-06-18 spec): all three tools are deterministic,
// pure inspections of a caller-supplied URL: same file, same report.
// destructiveHint defaults to TRUE when omitted, so it is set explicitly.
const INSPECTION_ANNOTATIONS = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: true,
};

function formatValidationSummary(s, messages) {
	const head =
		`glTF-Validator report for ${s.filename} (${(s.fileSize / 1024).toFixed(1)} KB)\n` +
		`Errors: ${s.numErrors}, Warnings: ${s.numWarnings}, Infos: ${s.numInfos}, Hints: ${s.numHints}` +
		(s.truncated ? ' (truncated)' : '');
	if (!messages.length) return head;
	const lines = messages.slice(0, 40).map((m) => {
		const sev = ['ERR', 'WRN', 'INF', 'HNT'][m.severity] || '?';
		const ptr = m.pointer ? ` @ ${m.pointer}` : '';
		return `  [${sev}] ${m.code}: ${m.message}${ptr}`;
	});
	const more = messages.length > 40 ? `\n  … ${messages.length - 40} more` : '';
	return `${head}\n${lines.join('\n')}${more}`;
}

function formatInspection(info) {
	const c = info.counts;
	const tex = info.textures.length
		? info.textures
				.map(
					(t) =>
						`  • ${t.name || '(unnamed)'}: ${t.mimeType} ${t.width}×${t.height}, ${(t.byteSize / 1024).toFixed(1)} KB`,
				)
				.join('\n')
		: '  (none)';
	return [
		`Model: ${info.filename} (${(info.fileSize / 1024 / 1024).toFixed(2)} MB, ${info.container})`,
		`Generator: ${info.generator || 'unknown'} · glTF ${info.version || '?'}`,
		`Scenes: ${c.scenes}, Nodes: ${c.nodes}, Meshes: ${c.meshes}, Materials: ${c.materials}, Textures: ${c.textures}`,
		`Animations: ${c.animations}, Skins: ${c.skins}`,
		`Vertices: ${c.totalVertices.toLocaleString()}, Triangles: ${c.totalTriangles.toLocaleString()}`,
		`Indexed primitives: ${c.indexedPrimitives}, Non-indexed: ${c.nonIndexedPrimitives}`,
		`Extensions used: ${info.extensionsUsed.join(', ') || '(none)'}`,
		`Textures:\n${tex}`,
	].join('\n');
}

function formatSuggestions(suggestions) {
	if (!suggestions.length) return 'No suggestions.';
	return suggestions
		.map((s) => {
			const tag =
				{ info: 'INFO', warn: 'WARN', critical: 'CRIT' }[s.severity] ||
				s.severity.toUpperCase();
			const est = s.estimate ? ` (${s.estimate})` : '';
			return `[${tag}] ${s.id}: ${s.message}${est}`;
		})
		.join('\n');
}

export const toolDefs = [
	{
		name: 'validate_model',
		title: 'Validate glTF/GLB model',
		annotations: INSPECTION_ANNOTATIONS,
		description:
			'Run the Khronos glTF-Validator against a remote GLB or glTF URL. Returns a structured report of errors, warnings, infos, and hints: the authoritative answer to "is this file spec-compliant?". SSRF-hardened: only public https URLs are fetched.',
		inputSchema: {
			type: 'object',
			properties: {
				url: {
					type: 'string',
					format: 'uri',
					description: 'Public https URL of a .glb or .gltf file.',
				},
				max_issues: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
			},
			required: ['url'],
			additionalProperties: false,
		},
		async handler(args, auth) {
			const rl = await limits.mcpValidate(auth.userId || auth.rateKey);
			if (!rl.success)
				throw rpcError(-32000, 'rate_limited', {
					retry_after: Math.ceil((rl.reset - Date.now()) / 1000),
				});
			const { bytes, url, filename } = await safeFetchModel(args.url);
			const max = Math.min(Math.max(args.max_issues || 100, 1), 500);
			const report = await validateBytes(bytes, { maxIssues: max, uri: filename });
			const issues = report?.issues || {};
			const summary = {
				url,
				filename,
				fileSize: bytes.byteLength,
				validatorVersion: report?.validatorVersion,
				mimeType: report?.mimeType,
				numErrors: issues.numErrors ?? 0,
				numWarnings: issues.numWarnings ?? 0,
				numInfos: issues.numInfos ?? 0,
				numHints: issues.numHints ?? 0,
				truncated: !!issues.truncated,
			};
			return {
				content: [
					{ type: 'text', text: formatValidationSummary(summary, issues.messages || []) },
				],
				structuredContent: {
					...summary,
					messages: issues.messages || [],
					info: report?.info || null,
				},
			};
		},
	},
	{
		name: 'inspect_model',
		title: 'Inspect glTF/GLB model',
		annotations: INSPECTION_ANNOTATIONS,
		description:
			'Parse a remote GLB or glTF and return structural stats: scene/node/mesh counts, vertex and triangle totals, material and texture summaries, extensions used. Pure inspection, no optimization advice.',
		inputSchema: {
			type: 'object',
			properties: {
				url: {
					type: 'string',
					format: 'uri',
					description: 'Public https URL of a .glb or .gltf file.',
				},
			},
			required: ['url'],
			additionalProperties: false,
		},
		async handler(args, auth) {
			const rl = await limits.mcpInspect(auth.userId || auth.rateKey);
			if (!rl.success)
				throw rpcError(-32000, 'rate_limited', {
					retry_after: Math.ceil((rl.reset - Date.now()) / 1000),
				});
			const { bytes, url, filename } = await safeFetchModel(args.url);
			const info = await inspectModel(bytes, { fileSize: bytes.byteLength });
			return {
				content: [{ type: 'text', text: formatInspection({ url, filename, ...info }) }],
				structuredContent: { url, filename, ...info },
			};
		},
	},
	{
		name: 'optimize_model',
		title: 'Suggest optimizations for a glTF/GLB model',
		annotations: INSPECTION_ANNOTATIONS,
		description:
			'Inspect the model and return actionable suggestions for reducing size and draw-call overhead: triangle budget, Draco/Meshopt compression, oversized textures, KTX2 transcoding, non-indexed primitives, redundant materials, and more.',
		inputSchema: {
			type: 'object',
			properties: {
				url: {
					type: 'string',
					format: 'uri',
					description: 'Public https URL of a .glb or .gltf file.',
				},
			},
			required: ['url'],
			additionalProperties: false,
		},
		async handler(args, auth) {
			const rl = await limits.mcpOptimize(auth.userId || auth.rateKey);
			if (!rl.success)
				throw rpcError(-32000, 'rate_limited', {
					retry_after: Math.ceil((rl.reset - Date.now()) / 1000),
				});
			const { bytes, url, filename } = await safeFetchModel(args.url);
			const info = await inspectModel(bytes, { fileSize: bytes.byteLength });
			const suggestions = suggestOptimizations(info);
			return {
				content: [{ type: 'text', text: formatSuggestions(suggestions) }],
				structuredContent: { url, filename, suggestions, info },
			};
		},
	},
	{
		name: 'diff_models',
		title: 'Diff two glTF/GLB models',
		annotations: INSPECTION_ANNOTATIONS,
		description:
			'Compare two remote GLB or glTF models and return what changed: geometry, hierarchy, materials, textures, skeletons, and animation clips, each classified as added, removed, renamed, moved, or modified, with renames detected by content hash rather than by name. Every change carries a severity (none, cosmetic, minor, major, breaking) so an agent can decide whether an optimized, rigged, or re-exported model is still safe to ship. Breaking means something a consumer references by name is gone: a clip, a joint, a mesh.',
		inputSchema: {
			type: 'object',
			properties: {
				before: {
					type: 'string',
					format: 'uri',
					description: 'Public https URL of the baseline .glb or .gltf file.',
				},
				after: {
					type: 'string',
					format: 'uri',
					description: 'Public https URL of the candidate .glb or .gltf file.',
				},
			},
			required: ['before', 'after'],
			additionalProperties: false,
		},
		async handler(args, auth) {
			const rl = await limits.mcpDiff(auth.userId || auth.rateKey);
			if (!rl.success)
				throw rpcError(-32000, 'rate_limited', {
					retry_after: Math.ceil((rl.reset - Date.now()) / 1000),
				});
			// Sequential, so a caller who passed one bad URL learns which one
			// without the server having spent a second full download first.
			const a = await safeFetchModel(args.before);
			const b = await safeFetchModel(args.after);
			const [beforeDesc, afterDesc] = await Promise.all([
				describeModel(a.bytes, { name: a.filename }),
				describeModel(b.bytes, { name: b.filename }),
			]);
			const changeset = diffDescriptions(beforeDesc, afterDesc);
			return {
				content: [{ type: 'text', text: formatText(changeset, { color: false }) }],
				structuredContent: { before: a.url, after: b.url, ...changeset },
			};
		},
	},
];
