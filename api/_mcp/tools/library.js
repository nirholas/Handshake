// MCP tools for the three.ws asset catalog: the ready-made props, characters,
// and motion clips the platform already publishes.
//
//   search_catalog   (free): one search across all three libraries.
//   get_catalog_item (free): one item in full, with its links and related items.
//   get_item_source  (free): paste-ready code that renders the item on any site.
//
// All three are free, unauthenticated public reads: they serve published CC0 and
// free-to-use manifests, touch no account data, and hold no user state. That is
// deliberate. An agent should be able to discover what three.ws already has and
// leave with working code before it ever signs in or pays for anything.
//
// The join and ranking live in api/_lib/asset-catalog.js; the code generation
// lives in api/_lib/asset-snippets.js. This file is the MCP surface over both.

import { KINDS, searchCatalog, getCatalogItem, relatedItems } from '../../_lib/asset-catalog.js';
import { sourceFor, snippetFor, frameworksFor } from '../../_lib/asset-snippets.js';
import { resolveOrigin } from '../origin.js';

const READ_ANNOTATIONS = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
};

function rpcError(code, message, data) {
	const e = new Error(message);
	e.code = code;
	e.data = data;
	return e;
}

function kindLabel(kind) {
	if (kind === 'object') return 'prop';
	if (kind === 'character') return 'rigged character';
	return 'motion clip';
}

function itemLine(item) {
	const bits = [`\`${item.id}\``, item.title];
	if (item.license) bits.push(item.license);
	if (item.kind === 'animation' && item.duration_seconds) {
		bits.push(`${item.duration_seconds.toFixed(1)}s${item.loop ? ' loop' : ''}`);
	}
	const tags = item.tags.slice(0, 4).join(', ');
	return `- ${bits.join(' | ')}${tags ? ` | ${tags}` : ''}`;
}

function renderResults(result, query) {
	if (!result.items.length) {
		return [
			`No catalog items match ${query ? `"${query}"` : 'that filter'}.`,
			`The catalog holds ${result.total} items. Try a broader term, or drop the kind/category filter.`,
		].join('\n');
	}
	const lines = [
		result.relaxed
			? `Nothing matches every word of "${query}". Showing the ${result.matched} items that match part of it, best first (${result.items.length} from offset ${result.offset}):`
			: `${result.matched} match${result.matched === 1 ? '' : 'es'}${query ? ` for "${query}"` : ''} (showing ${result.items.length} from offset ${result.offset}):`,
		'',
		...result.items.map(itemLine),
	];
	const kinds = Object.entries(result.facets.kinds)
		.map(([k, n]) => `${k} ${n}`)
		.join(', ');
	if (kinds) lines.push('', `Kinds: ${kinds}`);
	const cats = result.facets.categories.slice(0, 8).map((c) => `${c.value} (${c.count})`).join(', ');
	if (cats) lines.push(`Categories: ${cats}`);
	if (result.next_offset != null) lines.push(`More: call again with offset ${result.next_offset}.`);
	lines.push('', 'Next: get_item_source with an id above returns code you can paste.');
	return lines.join('\n');
}

function renderItem(item, related, links) {
	const lines = [
		`# ${item.title}`,
		'',
		`\`${item.id}\`: a ${kindLabel(item.kind)}${item.license ? `, ${item.license}` : ''}.`,
	];
	if (item.categories.length) lines.push(`Categories: ${item.categories.join(', ')}`);
	if (item.tags.length) lines.push(`Tags: ${item.tags.join(', ')}`);
	if (item.kind === 'animation') {
		lines.push(
			`Clip: ${item.duration_seconds ? `${item.duration_seconds.toFixed(2)}s` : 'unknown length'}, ${item.loop ? 'loops' : 'one-shot'}, THREE.AnimationClip JSON.`,
		);
	} else {
		lines.push(
			`Asset: GLB${item.bytes ? `, ${(item.bytes / 1024 / 1024).toFixed(1)} MB` : ''}${item.rigged ? ', rigged and animation-ready' : ''}.`,
		);
	}
	lines.push('', 'Links:', ...Object.entries(links).map(([k, v]) => `- ${k}: ${v}`));
	if (related.length) {
		lines.push('', 'Related:', ...related.map((r) => `- \`${r.id}\` ${r.title}`));
	}
	lines.push('', `Frameworks for get_item_source: ${frameworksFor(item).join(', ')}.`);
	return lines.join('\n');
}

export const toolDefs = [
	{
		name: 'search_catalog',
		title: 'Search the three.ws asset catalog',
		annotations: READ_ANNOTATIONS,
		description:
			'FREE, no account or payment. Search every ready-made asset three.ws publishes in one call: CC0 3D props and objects, rigged humanoid characters, and retargetable motion clips. ' +
			'Returns ids, titles, tags, licenses, and CDN urls, plus category facets to narrow the next query. ' +
			'Use this before generating anything: if the catalog already has the prop or character, dropping it in is instant and free where generating one is not. ' +
			'Feed a returned id to get_item_source for code that renders it on any site.',
		inputSchema: {
			type: 'object',
			additionalProperties: false,
			properties: {
				q: {
					type: 'string',
					maxLength: 200,
					description:
						'Free text over titles, names, tags, and categories, e.g. "wooden chair", "office", "wave". Every word must match somewhere, so start broad.',
				},
				kind: {
					type: 'string',
					enum: KINDS,
					description:
						'Narrow to one library: object (CC0 props), character (rigged humanoids), animation (motion clips).',
				},
				category: { type: 'string', maxLength: 80, description: 'Exact category from a previous result\'s facets.' },
				tag: { type: 'string', maxLength: 80, description: 'Exact tag from a previous result\'s facets.' },
				limit: { type: 'integer', minimum: 1, maximum: 50, default: 12 },
				offset: { type: 'integer', minimum: 0, default: 0, description: 'Page offset. Use next_offset from the previous response.' },
			},
		},
		async handler(args = {}) {
			const result = await searchCatalog({
				q: args.q,
				kind: args.kind,
				category: args.category,
				tag: args.tag,
				limit: args.limit || 12,
				offset: args.offset || 0,
			});
			return {
				content: [{ type: 'text', text: renderResults(result, args.q) }],
				structuredContent: { ok: true, ...result },
			};
		},
	},
	{
		name: 'get_catalog_item',
		title: 'Read one catalog item',
		annotations: READ_ANNOTATIONS,
		description:
			'FREE, no account or payment. Read one three.ws catalog item in full by its id from search_catalog (for example "object:adjustable_wrench"): metadata, license, CDN urls, the site links that preview or edit it, related items of the same kind, and which source frameworks get_item_source can emit for it.',
		inputSchema: {
			type: 'object',
			additionalProperties: false,
			required: ['id'],
			properties: {
				id: {
					type: 'string',
					maxLength: 200,
					description: 'Catalog id as `<kind>:<name>` from search_catalog. A bare name is also accepted.',
				},
			},
		},
		async handler(args = {}, _auth, req) {
			const item = await getCatalogItem(args.id);
			if (!item) {
				throw rpcError(-32602, `no catalog item with id "${args.id}"`, {
					hint: 'Call search_catalog first; ids look like "object:adjustable_wrench".',
				});
			}
			const origin = resolveOrigin(req);
			const { links } = sourceFor(item, origin);
			const related = await relatedItems(item, 6);
			return {
				content: [{ type: 'text', text: renderItem(item, related, links) }],
				structuredContent: {
					ok: true,
					item,
					links,
					related,
					frameworks: frameworksFor(item),
				},
			};
		},
	},
	{
		name: 'get_item_source',
		title: 'Get paste-ready source for a catalog item',
		annotations: READ_ANNOTATIONS,
		description:
			'FREE, no account or payment. Returns working code that renders one three.ws catalog item on any site: the <agent-3d> web component (pinned to the exact published version with its SRI hash), the <model-viewer> tag our own browse grids use, plain three.js with GLTFLoader, or a React component. ' +
			'Motion clips return three.js code that parses the clip JSON and plays it. Omit `framework` to get the one that fits the item best; pass `all` to get every variant at once.',
		inputSchema: {
			type: 'object',
			additionalProperties: false,
			required: ['id'],
			properties: {
				id: { type: 'string', maxLength: 200, description: 'Catalog id from search_catalog.' },
				framework: {
					type: 'string',
					enum: ['agent-3d', 'model-viewer', 'three', 'react', 'all'],
					description:
						'Which form to emit. Defaults to the recommended one for the item kind. "all" returns every applicable variant.',
				},
			},
		},
		async handler(args = {}, _auth, req) {
			const item = await getCatalogItem(args.id);
			if (!item) {
				throw rpcError(-32602, `no catalog item with id "${args.id}"`, {
					hint: 'Call search_catalog first; ids look like "object:adjustable_wrench".',
				});
			}
			const origin = resolveOrigin(req);

			if (args.framework === 'all') {
				const { snippets, links, frameworks } = sourceFor(item, origin);
				const text = frameworks
					.map((f) => `## ${f}\n\n\`\`\`${snippets[f].language}\n${snippets[f].code}\n\`\`\``)
					.join('\n\n');
				return {
					content: [{ type: 'text', text: `# ${item.title}\n\n${text}` }],
					structuredContent: { ok: true, item, frameworks, snippets, links },
				};
			}

			const snippet = snippetFor(item, args.framework, origin);
			if (!snippet) {
				throw rpcError(
					-32602,
					`framework "${args.framework}" does not apply to a ${kindLabel(item.kind)}`,
					{ available_frameworks: frameworksFor(item) },
				);
			}
			const text = [
				`# ${item.title} (${snippet.framework})`,
				'',
				`\`\`\`${snippet.language}`,
				snippet.code,
				'```',
				'',
				...snippet.notes.map((n) => `- ${n}`),
				'',
				`Preview: ${snippet.links.preview || snippet.links.browse}`,
				item.license ? `License: ${item.license}` : 'License: free to use on three.ws.',
				`Other frameworks: ${snippet.available_frameworks.filter((f) => f !== snippet.framework).join(', ')}.`,
			].join('\n');
			return {
				content: [{ type: 'text', text }],
				structuredContent: { ok: true, item, ...snippet },
			};
		},
	},
];
