// Local model report.
//
// Reuses the platform's own inspector (src/gltf-inspect.js, the same code behind
// the /validation page and the model-check API) so the numbers in the editor are
// the numbers three.ws reports everywhere else. It runs entirely in the
// extension host: the file is never uploaded anywhere.
//
// esbuild inlines the inspector and its glTF-Transform dependencies into
// dist/extension.cjs at build time, so the shipped extension has no path
// dependency back into the repo.

import { inspectModel, suggestOptimizations } from '../../../src/gltf-inspect.js';
import { formatBytes } from './naming.js';

/**
 * @param {Uint8Array} bytes raw .glb or .gltf contents
 * @returns {Promise<{ info: any, suggestions: any[], rows: Array<[string, string]> }>}
 */
export async function reportFor(bytes) {
	const info = await inspectModel(bytes);
	const suggestions = suggestOptimizations(info);
	return { info, suggestions, rows: rowsFor(info) };
}

/** The report as ordered label/value pairs, ready to render. */
export function rowsFor(info) {
	const c = info.counts;
	const textureBytes = info.textures.reduce((a, t) => a + (t.byteSize || 0), 0);
	const largest = info.textures.reduce(
		(max, t) => Math.max(max, Math.max(t.width || 0, t.height || 0)),
		0,
	);
	const rows = [
		['File size', formatBytes(info.fileSize)],
		['Triangles', num(c.totalTriangles)],
		['Vertices', num(c.totalVertices)],
		['Meshes', num(c.meshes)],
		['Materials', num(c.materials)],
		['Textures', c.textures ? `${num(c.textures)} · ${formatBytes(textureBytes)}${largest ? ` · up to ${largest}px` : ''}` : '0'],
		['Animations', num(c.animations)],
		['Rig', c.skins ? `${num(c.skins)} skin${c.skins === 1 ? '' : 's'} · ${num(c.totalJoints)} bones` : 'none'],
		['Nodes', num(c.nodes)],
	];
	if (info.extensionsUsed.length) rows.push(['Extensions', info.extensionsUsed.join(', ')]);
	if (info.generator) rows.push(['Generator', info.generator]);
	return rows;
}

function num(n) {
	return Number(n || 0).toLocaleString('en-US');
}
