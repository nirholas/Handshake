// The diff itself: two descriptions in, one change set out.
//
// Everything here is a pure function over the plain data describe.js produces,
// which is what makes the output reproducible: the same two files always yield
// the same change set, byte for byte, on any machine. That matters because the
// change set is meant to be committed, posted to a pull request, and compared
// against yesterday's.

import { canonicalize } from './hash.js';
import { jaccard, matchEntries, ratio } from './match.js';
import { maxSeverity } from './severity.js';

export const CHANGESET_VERSION = 1;

function equalish(a, b) {
	if (a === b) return true;
	if (a === null || b === null || a === undefined || b === undefined) return false;
	if (typeof a === 'object' || typeof b === 'object') return canonicalize(a) === canonicalize(b);
	return false;
}

/** Record a field-level change, or nothing when the field held still. */
function field(changes, name, a, b, severity, note) {
	if (equalish(a, b)) return;
	changes.push({ field: name, a: a ?? null, b: b ?? null, severity, ...(note ? { note } : {}) });
}

function listDelta(a = [], b = []) {
	const setA = new Set(a);
	const setB = new Set(b);
	return {
		added: b.filter((v) => !setA.has(v)),
		removed: a.filter((v) => !setB.has(v)),
	};
}

function emptySection() {
	return { added: [], removed: [], renamed: [], modified: [], unchanged: 0, similarityLimited: false };
}

function summarize(section) {
	const severities = [
		...section.added.map((x) => x.severity),
		...section.removed.map((x) => x.severity),
		...section.modified.map((x) => x.severity),
		...(section.moved || []).map(() => 'major'),
		...section.renamed.map(() => 'cosmetic'),
	];
	section.severity = maxSeverity(severities);
	section.changed =
		section.added.length +
		section.removed.length +
		section.modified.length +
		section.renamed.length +
		(section.moved ? section.moved.length : 0);
	return section;
}

// ── Sections ─────────────────────────────────────────────────────────────────

function diffNodes(a, b) {
	const section = { ...emptySection(), moved: [] };
	const match = matchEntries(a.nodes, b.nodes, {
		threshold: 0.62,
		similarity: (x, y) =>
			0.4 * (x.name === y.name ? 1 : 0) +
			0.2 * (x.parent === y.parent ? 1 : 0) +
			0.2 * ratio(x.childCount, y.childCount) +
			0.1 * (x.mesh === y.mesh ? 1 : 0) +
			0.1 * (x.depth === y.depth ? 1 : 0),
	});
	section.similarityLimited = match.similarityLimited;

	for (const node of match.removed) {
		section.removed.push({
			name: node.path,
			// A node carrying geometry or a skin is load-bearing: a scene that
			// attached to it by name has nothing left to attach to.
			severity: node.mesh || node.skin ? 'breaking' : 'major',
			detail: node.mesh ? `carried mesh "${node.mesh}"` : node.skin ? `carried skin "${node.skin}"` : 'empty node',
		});
	}
	for (const node of match.added) {
		section.added.push({
			name: node.path,
			severity: 'major',
			detail: node.mesh ? `carries mesh "${node.mesh}"` : 'empty node',
		});
	}

	for (const { a: x, b: y } of match.pairs) {
		const changes = [];
		field(changes, 'translation', x.translation, y.translation, 'minor');
		field(changes, 'rotation', x.rotation, y.rotation, 'minor');
		field(changes, 'scale', x.scale, y.scale, 'minor');
		field(changes, 'mesh', x.mesh, y.mesh, 'major');
		field(changes, 'skin', x.skin, y.skin, 'major');
		field(changes, 'children', x.childCount, y.childCount, 'major');

		if (x.name !== y.name) section.renamed.push({ from: x.path, to: y.path, name: y.name });
		else if (x.parent !== y.parent) section.moved.push({ from: x.path, to: y.path, name: y.name });

		if (changes.length) {
			section.modified.push({ name: y.path, from: x.path, changes, severity: maxSeverity(changes.map((c) => c.severity)) });
		} else if (x.name === y.name && x.parent === y.parent) {
			section.unchanged++;
		}
	}
	return summarize(section);
}

function diffMeshes(a, b) {
	const section = emptySection();
	const match = matchEntries(a.meshes, b.meshes, {
		threshold: 0.6,
		similarity: (x, y) =>
			0.45 * ratio(x.vertices, y.vertices) +
			0.2 * ratio(x.triangles, y.triangles) +
			0.15 * ratio(x.primitives.length, y.primitives.length) +
			0.2 *
				jaccard(
					x.primitives.flatMap((p) => p.attributes),
					y.primitives.flatMap((p) => p.attributes),
				),
	});
	section.similarityLimited = match.similarityLimited;

	for (const mesh of match.removed) {
		section.removed.push({
			name: mesh.name,
			severity: 'breaking',
			detail: `${mesh.triangles.toLocaleString()} triangles gone`,
		});
	}
	for (const mesh of match.added) {
		section.added.push({ name: mesh.name, severity: 'major', detail: `${mesh.triangles.toLocaleString()} triangles` });
	}

	for (const { a: x, b: y } of match.pairs) {
		const changes = [];
		if (x.geometryHash !== y.geometryHash) {
			changes.push({
				field: 'geometry',
				a: x.geometryHash,
				b: y.geometryHash,
				severity: 'major',
				note:
					x.vertices === y.vertices && x.triangles === y.triangles
						? 'same vertex and triangle count, different vertex data'
						: 'vertex data rewritten',
			});
		}
		field(changes, 'vertices', x.vertices, y.vertices, 'major');
		field(changes, 'triangles', x.triangles, y.triangles, 'major');
		field(changes, 'primitives', x.primitives.length, y.primitives.length, 'major');
		field(changes, 'bounds', x.bounds, y.bounds, 'minor');
		field(
			changes,
			'materials',
			x.primitives.map((p) => p.material),
			y.primitives.map((p) => p.material),
			'minor',
		);
		field(
			changes,
			'attributes',
			[...new Set(x.primitives.flatMap((p) => p.attributes))].sort(),
			[...new Set(y.primitives.flatMap((p) => p.attributes))].sort(),
			'major',
		);
		field(
			changes,
			'morphTargets',
			x.primitives.reduce((s, p) => s + p.morphTargets, 0),
			y.primitives.reduce((s, p) => s + p.morphTargets, 0),
			'major',
		);

		if (x.name !== y.name) section.renamed.push({ from: x.name, to: y.name, name: y.name });
		if (changes.length) {
			section.modified.push({ name: y.name, from: x.name, changes, severity: maxSeverity(changes.map((c) => c.severity)) });
		} else if (x.name === y.name) {
			section.unchanged++;
		}
	}
	return summarize(section);
}

function diffMaterials(a, b) {
	const section = emptySection();
	const match = matchEntries(a.materials, b.materials, {
		threshold: 0.62,
		similarity: (x, y) =>
			0.3 * (x.alphaMode === y.alphaMode ? 1 : 0) +
			0.3 *
				jaccard(
					Object.entries(x.textures).filter(([, v]) => v).map(([k]) => k),
					Object.entries(y.textures).filter(([, v]) => v).map(([k]) => k),
				) +
			0.2 * ratio(1 + x.metallic, 1 + y.metallic) +
			0.2 * ratio(1 + x.roughness, 1 + y.roughness),
	});
	section.similarityLimited = match.similarityLimited;

	for (const m of match.removed) section.removed.push({ name: m.name, severity: 'major', detail: 'material removed' });
	for (const m of match.added) section.added.push({ name: m.name, severity: 'minor', detail: 'material added' });

	for (const { a: x, b: y } of match.pairs) {
		const changes = [];
		field(changes, 'baseColorFactor', x.baseColorFactor, y.baseColorFactor, 'minor');
		field(changes, 'metallic', x.metallic, y.metallic, 'minor');
		field(changes, 'roughness', x.roughness, y.roughness, 'minor');
		field(changes, 'emissiveFactor', x.emissiveFactor, y.emissiveFactor, 'minor');
		field(changes, 'normalScale', x.normalScale, y.normalScale, 'minor');
		field(changes, 'occlusionStrength', x.occlusionStrength, y.occlusionStrength, 'minor');
		field(changes, 'alphaMode', x.alphaMode, y.alphaMode, 'minor');
		field(changes, 'alphaCutoff', x.alphaCutoff, y.alphaCutoff, 'minor');
		field(changes, 'doubleSided', x.doubleSided, y.doubleSided, 'minor');
		field(changes, 'extensions', x.extensions, y.extensions, 'minor');
		for (const slot of Object.keys(x.textures)) {
			field(changes, `texture.${slot}`, x.textures[slot], y.textures[slot], 'minor');
		}

		if (x.name !== y.name) section.renamed.push({ from: x.name, to: y.name, name: y.name });
		if (changes.length) {
			section.modified.push({ name: y.name, from: x.name, changes, severity: maxSeverity(changes.map((c) => c.severity)) });
		} else if (x.name === y.name) {
			section.unchanged++;
		}
	}
	return summarize(section);
}

function diffTextures(a, b) {
	const section = emptySection();
	const match = matchEntries(a.textures, b.textures, {
		threshold: 0.6,
		similarity: (x, y) =>
			0.4 * (x.width === y.width && x.height === y.height ? 1 : 0) +
			0.3 * (x.mimeType === y.mimeType ? 1 : 0) +
			0.3 * ratio(x.bytes, y.bytes),
	});
	section.similarityLimited = match.similarityLimited;

	for (const t of match.removed) {
		section.removed.push({ name: t.name, severity: 'minor', detail: `${t.width}x${t.height}, ${t.bytes} bytes` });
	}
	for (const t of match.added) {
		section.added.push({ name: t.name, severity: 'minor', detail: `${t.width}x${t.height}, ${t.bytes} bytes` });
	}

	for (const { a: x, b: y } of match.pairs) {
		const changes = [];
		field(changes, 'width', x.width, y.width, 'minor');
		field(changes, 'height', x.height, y.height, 'minor');
		field(changes, 'mimeType', x.mimeType, y.mimeType, 'minor');
		field(changes, 'bytes', x.bytes, y.bytes, 'cosmetic');
		if (x.pixelHash !== y.pixelHash) {
			changes.push({ field: 'pixels', a: x.pixelHash, b: y.pixelHash, severity: 'minor', note: 'image data changed' });
		}

		if (x.name !== y.name) section.renamed.push({ from: x.name, to: y.name, name: y.name });
		if (changes.length) {
			section.modified.push({ name: y.name, from: x.name, changes, severity: maxSeverity(changes.map((c) => c.severity)) });
		} else if (x.name === y.name) {
			section.unchanged++;
		}
	}
	return summarize(section);
}

function diffAnimations(a, b) {
	const section = emptySection();
	const match = matchEntries(a.animations, b.animations, {
		threshold: 0.6,
		similarity: (x, y) => 0.65 * jaccard(x.targets, y.targets) + 0.35 * ratio(x.duration, y.duration),
	});
	section.similarityLimited = match.similarityLimited;

	for (const clip of match.removed) {
		section.removed.push({ name: clip.name, severity: 'breaking', detail: `${clip.duration}s clip gone` });
	}
	for (const clip of match.added) {
		section.added.push({ name: clip.name, severity: 'minor', detail: `${clip.duration}s clip` });
	}

	for (const { a: x, b: y } of match.pairs) {
		const changes = [];
		field(changes, 'duration', x.duration, y.duration, 'major');
		field(changes, 'channels', x.channels, y.channels, 'major');
		field(changes, 'keyframes', x.keyframes, y.keyframes, 'minor');
		field(changes, 'interpolations', x.interpolations, y.interpolations, 'minor');
		const targets = listDelta(x.targets, y.targets);
		if (targets.removed.length) {
			changes.push({
				field: 'targets',
				a: targets.removed,
				b: [],
				severity: 'breaking',
				note: `${targets.removed.length} channel target(s) no longer driven`,
			});
		}
		if (targets.added.length) {
			changes.push({ field: 'targets', a: [], b: targets.added, severity: 'major', note: `${targets.added.length} new channel target(s)` });
		}

		if (x.name !== y.name) section.renamed.push({ from: x.name, to: y.name, name: y.name });
		if (changes.length) {
			section.modified.push({ name: y.name, from: x.name, changes, severity: maxSeverity(changes.map((c) => c.severity)) });
		} else if (x.name === y.name) {
			section.unchanged++;
		}
	}
	return summarize(section);
}

function diffSkins(a, b) {
	const section = emptySection();
	const match = matchEntries(a.skins, b.skins, {
		threshold: 0.5,
		similarity: (x, y) => jaccard(x.joints, y.joints),
	});
	section.similarityLimited = match.similarityLimited;

	for (const skin of match.removed) {
		section.removed.push({ name: skin.name, severity: 'breaking', detail: `${skin.jointCount} joints gone` });
	}
	for (const skin of match.added) {
		section.added.push({ name: skin.name, severity: 'major', detail: `${skin.jointCount} joints` });
	}

	for (const { a: x, b: y } of match.pairs) {
		const changes = [];
		const joints = listDelta(x.joints, y.joints);
		if (joints.removed.length) {
			changes.push({
				field: 'joints',
				a: joints.removed,
				b: [],
				severity: 'breaking',
				// Named-bone lookup is how every retargeter and every baked clip
				// finds a joint, so a removed or renamed bone is a silent no-op at
				// runtime rather than an error anyone sees.
				note: `${joints.removed.length} joint name(s) removed; clips addressing them will not play`,
			});
		}
		if (joints.added.length) {
			changes.push({ field: 'joints', a: [], b: joints.added, severity: 'major', note: `${joints.added.length} joint name(s) added` });
		}
		field(changes, 'jointCount', x.jointCount, y.jointCount, 'major');
		field(changes, 'skeleton', x.skeleton, y.skeleton, 'major');
		if (x.bindHash !== y.bindHash) {
			changes.push({
				field: 'inverseBindMatrices',
				a: x.bindHash,
				b: y.bindHash,
				severity: 'major',
				note: 'bind pose changed; existing clips will deform differently',
			});
		}

		if (x.name !== y.name) section.renamed.push({ from: x.name, to: y.name, name: y.name });
		if (changes.length) {
			section.modified.push({ name: y.name, from: x.name, changes, severity: maxSeverity(changes.map((c) => c.severity)) });
		} else if (x.name === y.name) {
			section.unchanged++;
		}
	}
	return summarize(section);
}

// ── Assembly ─────────────────────────────────────────────────────────────────

function deltaBlock(a, b) {
	const out = {};
	for (const key of Object.keys(a)) {
		const from = a[key] ?? 0;
		const to = b[key] ?? 0;
		out[key] = {
			a: from,
			b: to,
			delta: to - from,
			pct: from === 0 ? (to === 0 ? 0 : null) : Math.round(((to - from) / from) * 1000) / 10,
		};
	}
	return out;
}

// The plain-language layer. A change set is precise but long; these are the
// three or four sentences someone actually reads before deciding whether to
// look closer, ordered worst first.
function buildHighlights(sections, totals, extensions, asset) {
	const out = [];
	const push = (severity, text) => out.push({ severity, text });

	for (const skin of sections.skins.modified) {
		const lost = skin.changes.find((c) => c.field === 'joints' && c.a.length);
		if (lost) push('breaking', `Skeleton "${skin.name}" lost ${lost.a.length} joint(s): ${lost.a.slice(0, 4).join(', ')}${lost.a.length > 4 ? ', ...' : ''}. Clips that target them will not play.`);
	}
	// Removals are grouped once past a couple of entries. A highlight list that
	// prints one line per removed mesh stops being a summary and becomes the raw
	// section it was supposed to summarize.
	const group = (items, one, many) => {
		if (!items.length) return;
		if (items.length <= 2) for (const item of items) push('breaking', one(item));
		else push('breaking', many(items));
	};
	group(
		sections.skins.removed,
		(skin) => `Skeleton "${skin.name}" was removed. The model is no longer rigged.`,
		(items) => `${items.length} skeletons were removed. The model is no longer rigged.`,
	);
	group(
		sections.animations.removed,
		(clip) => `Animation "${clip.name}" was removed. Anything that plays it by name will fail.`,
		(items) => `${items.length} animations were removed (${namesOf(items)}). Anything that plays them by name will fail.`,
	);
	group(
		sections.meshes.removed,
		(mesh) => `Mesh "${mesh.name}" was removed (${mesh.detail}).`,
		(items) => `${items.length} meshes were removed (${namesOf(items)}).`,
	);

	const geometryEdits = sections.meshes.modified.filter((m) => m.changes.some((c) => c.field === 'geometry'));
	if (geometryEdits.length) {
		push('major', `${geometryEdits.length} mesh(es) have different vertex data: ${geometryEdits.slice(0, 3).map((m) => `"${m.name}"`).join(', ')}${geometryEdits.length > 3 ? ', ...' : ''}.`);
	}
	if (totals.triangles.delta !== 0) {
		const dir = totals.triangles.delta > 0 ? 'up' : 'down';
		push('major', `Triangle count is ${dir} ${Math.abs(totals.triangles.delta).toLocaleString()} (${totals.triangles.pct === null ? 'from zero' : `${totals.triangles.pct > 0 ? '+' : ''}${totals.triangles.pct}%`}).`);
	}
	const clipEdits = sections.animations.modified;
	if (clipEdits.length) {
		const worst = clipEdits.find((c) => c.severity === 'breaking');
		push(
			worst ? 'breaking' : 'major',
			`${clipEdits.length} animation(s) changed: ${clipEdits.slice(0, 3).map((c) => `"${c.name}"`).join(', ')}${clipEdits.length > 3 ? ', ...' : ''}.`,
		);
	}
	if (sections.nodes.moved.length) {
		push('major', `${sections.nodes.moved.length} node(s) moved to a different parent, which changes where anything attached to them ends up.`);
	}
	if (extensions.required.added.length) {
		push('major', `New required extension(s): ${extensions.required.added.join(', ')}. A viewer without support will refuse the file.`);
	}

	const textureEdits = sections.textures.modified.filter((t) => t.changes.some((c) => c.field === 'pixels'));
	if (textureEdits.length) push('minor', `${textureEdits.length} texture(s) were re-encoded or repainted.`);
	if (sections.materials.changed) push('minor', `${sections.materials.changed} material change(s).`);
	if (totals.sizeBytes.delta !== 0 && totals.sizeBytes.a > 0) {
		const dir = totals.sizeBytes.delta > 0 ? 'larger' : 'smaller';
		// A sub-0.1% delta rounds to "0%", which reads as a contradiction next to a
		// real byte count, so the percentage is dropped rather than printed as zero.
		const pct = totals.sizeBytes.pct === 0 ? '' : ` (${totals.sizeBytes.pct > 0 ? '+' : ''}${totals.sizeBytes.pct}%)`;
		push('minor', `File is ${formatBytes(Math.abs(totals.sizeBytes.delta))} ${dir}${pct}.`);
	}

	const renames = sections.nodes.renamed.length + sections.meshes.renamed.length + sections.materials.renamed.length + sections.animations.renamed.length + sections.skins.renamed.length + sections.textures.renamed.length;
	if (renames) push('cosmetic', `${renames} object(s) kept their content and changed name.`);
	if (asset.length) push('cosmetic', `Asset metadata changed: ${asset.map((c) => c.field).join(', ')}.`);

	return out;
}

// First few names plus a count, so a grouped highlight still says which objects
// it is talking about.
function namesOf(items, limit = 3) {
	const shown = items.slice(0, limit).map((i) => `"${i.name}"`).join(', ');
	return items.length > limit ? `${shown} and ${items.length - limit} more` : shown;
}

export function formatBytes(n) {
	if (!Number.isFinite(n)) return '0 B';
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Diff two model descriptions.
 * @param {ReturnType<import('./describe.js').describeDocument>} a the baseline
 * @param {ReturnType<import('./describe.js').describeDocument>} b the candidate
 */
export function diffDescriptions(a, b) {
	const sections = {
		nodes: diffNodes(a, b),
		meshes: diffMeshes(a, b),
		materials: diffMaterials(a, b),
		textures: diffTextures(a, b),
		animations: diffAnimations(a, b),
		skins: diffSkins(a, b),
	};

	const assetChanges = [];
	field(assetChanges, 'generator', a.asset.generator, b.asset.generator, 'cosmetic');
	field(assetChanges, 'version', a.asset.version, b.asset.version, 'cosmetic');
	field(assetChanges, 'copyright', a.asset.copyright, b.asset.copyright, 'cosmetic');

	const extensions = {
		used: listDelta(a.extensionsUsed, b.extensionsUsed),
		required: listDelta(a.extensionsRequired, b.extensionsRequired),
	};

	const totals = deltaBlock(a.totals, b.totals);
	const severity = maxSeverity([
		...Object.values(sections).map((s) => s.severity),
		...assetChanges.map((c) => c.severity),
		extensions.required.added.length ? 'major' : 'none',
		extensions.required.removed.length ? 'minor' : 'none',
		extensions.used.added.length || extensions.used.removed.length ? 'minor' : 'none',
	]);

	const changed = Object.values(sections).reduce((sum, s) => sum + s.changed, 0) + assetChanges.length + extensions.used.added.length + extensions.used.removed.length + extensions.required.added.length + extensions.required.removed.length;

	return {
		version: CHANGESET_VERSION,
		identical: changed === 0,
		severity,
		a: { name: a.name, sizeBytes: a.totals.sizeBytes, container: a.container, generator: a.asset.generator },
		b: { name: b.name, sizeBytes: b.totals.sizeBytes, container: b.container, generator: b.asset.generator },
		summary: {
			changed,
			added: Object.values(sections).reduce((s, x) => s + x.added.length, 0),
			removed: Object.values(sections).reduce((s, x) => s + x.removed.length, 0),
			modified: Object.values(sections).reduce((s, x) => s + x.modified.length, 0),
			renamed: Object.values(sections).reduce((s, x) => s + x.renamed.length, 0),
			moved: sections.nodes.moved.length,
		},
		totals,
		sections,
		extensions,
		asset: assetChanges,
		highlights: buildHighlights(sections, totals, extensions, assetChanges),
	};
}
