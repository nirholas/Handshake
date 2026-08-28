// Tests for @three-ws/glb-diff.
//
// Two layers, deliberately. Most cases build glTF Documents in memory so the
// input is exact: a test that says "moving one vertex is a major change" moves
// exactly one vertex. The last block runs the whole pipeline over real rigged
// avatars shipped in this repo, because an engine that only ever sees synthetic
// four-triangle meshes is an engine nobody has actually tested.

import { describe, expect, it } from 'vitest';
import { Document } from '@gltf-transform/core';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { describeDocument, describeModel } from '../src/describe.js';
import { diffDescriptions } from '../src/diff.js';
import { diffModels } from '../src/index.js';
import { formatMarkdown, formatText } from '../src/format.js';
import { atLeast, maxSeverity, SEVERITIES } from '../src/severity.js';
import { jaccard, matchEntries, ratio } from '../src/match.js';
import { canonicalize, hashNumbers, hashString } from '../src/hash.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const asset = (name) => path.join(REPO_ROOT, 'animation-sources', name);

// A minimal but complete rigged model: one triangle skinned to two joints,
// driven by one clip. Small enough to reason about, complete enough that every
// section of the diff has something to compare.
function buildModel(overrides = {}) {
	const {
		meshName = 'Body',
		nodeName = 'Root',
		positions = [0, 0, 0, 1, 0, 0, 0, 1, 0],
		materialName = 'Skin',
		baseColor = [1, 1, 1, 1],
		joints = ['Hips', 'Spine'],
		clipName = 'idle',
		clipTimes = [0, 1],
		reparent = false,
	} = overrides;

	const doc = new Document();
	const buffer = doc.createBuffer();

	const position = doc
		.createAccessor()
		.setType('VEC3')
		.setArray(new Float32Array(positions))
		.setBuffer(buffer);

	const material = doc.createMaterial(materialName).setBaseColorFactor(baseColor);
	const prim = doc.createPrimitive().setAttribute('POSITION', position).setMaterial(material);
	const mesh = doc.createMesh(meshName).addPrimitive(prim);

	const root = doc.createNode(nodeName).setMesh(mesh);
	const jointNodes = joints.map((name) => doc.createNode(name));
	const skin = doc.createSkin('Armature');
	for (const joint of jointNodes) skin.addJoint(joint);
	if (jointNodes[0]) skin.setSkeleton(jointNodes[0]);
	root.setSkin(skin);

	const input = doc
		.createAccessor()
		.setType('SCALAR')
		.setArray(new Float32Array(clipTimes))
		.setBuffer(buffer);
	const output = doc
		.createAccessor()
		.setType('VEC3')
		.setArray(new Float32Array(clipTimes.flatMap(() => [0, 0, 0])))
		.setBuffer(buffer);
	const sampler = doc.createAnimationSampler().setInput(input).setOutput(output).setInterpolation('LINEAR');
	const channel = doc
		.createAnimationChannel()
		.setTargetNode(jointNodes[0] || root)
		.setTargetPath('translation')
		.setSampler(sampler);
	doc.createAnimation(clipName).addSampler(sampler).addChannel(channel);

	const scene = doc.createScene('Scene');
	if (reparent) {
		// Same nodes, different hierarchy: the joints hang off the mesh node
		// instead of sitting beside it at the scene root.
		for (const joint of jointNodes) root.addChild(joint);
		scene.addChild(root);
	} else {
		scene.addChild(root);
		for (const joint of jointNodes) scene.addChild(joint);
	}
	return doc;
}

const describeBuilt = (overrides, name) => describeDocument(buildModel(overrides), { name, sizeBytes: 1024, container: 'glb' });

describe('hash', () => {
	it('is stable and order independent for objects', () => {
		expect(canonicalize({ b: 2, a: 1 })).toBe(canonicalize({ a: 1, b: 2 }));
		expect(hashString('abc')).toBe(hashString('abc'));
		expect(hashString('abc')).not.toBe(hashString('abd'));
	});

	it('absorbs float noise from a re-export but not a real edit', () => {
		expect(hashNumbers([1, 2, 3.000001])).toBe(hashNumbers([1, 2, 3]));
		expect(hashNumbers([1, 2, 3.01])).not.toBe(hashNumbers([1, 2, 3]));
	});

	it('does not treat a gained value as a reordered one', () => {
		expect(hashNumbers([1, 2, 3])).not.toBe(hashNumbers([3, 2, 1]));
		expect(hashNumbers([1, 2, 3])).not.toBe(hashNumbers([1, 2, 3, 4]));
	});
});

describe('severity ladder', () => {
	it('orders from none to breaking', () => {
		expect(SEVERITIES).toEqual(['none', 'cosmetic', 'minor', 'major', 'breaking']);
		expect(maxSeverity(['minor', 'breaking', 'cosmetic'])).toBe('breaking');
		expect(maxSeverity([])).toBe('none');
		expect(atLeast('major', 'minor')).toBe(true);
		expect(atLeast('minor', 'major')).toBe(false);
	});
});

describe('matcher', () => {
	it('pairs on key first, then fingerprint, then similarity', () => {
		const a = [
			{ key: 'same', fingerprint: 'f1', size: 10 },
			{ key: 'oldname', fingerprint: 'f2', size: 20 },
			{ key: 'edited', fingerprint: 'f3', size: 30 },
		];
		const b = [
			{ key: 'same', fingerprint: 'f9', size: 10 },
			{ key: 'newname', fingerprint: 'f2', size: 20 },
			{ key: 'edited-and-renamed', fingerprint: 'f8', size: 31 },
		];
		const result = matchEntries(a, b, { similarity: (x, y) => ratio(x.size, y.size) });
		const via = Object.fromEntries(result.pairs.map((p) => [p.a.key, p.via]));
		expect(via.same).toBe('key');
		expect(via.oldname).toBe('fingerprint');
		expect(via.edited).toBe('similarity');
		expect(result.added).toHaveLength(0);
		expect(result.removed).toHaveLength(0);
	});

	it('reports genuinely new and gone entries', () => {
		const result = matchEntries([{ key: 'gone', fingerprint: 'x' }], [{ key: 'fresh', fingerprint: 'y' }], {
			similarity: () => 0,
		});
		expect(result.removed.map((r) => r.key)).toEqual(['gone']);
		expect(result.added.map((r) => r.key)).toEqual(['fresh']);
	});

	it('scores overlap and closeness', () => {
		expect(jaccard(['a', 'b'], ['a', 'b'])).toBe(1);
		expect(jaccard([], [])).toBe(1);
		expect(jaccard(['a'], ['b'])).toBe(0);
		expect(ratio(10, 10)).toBe(1);
		expect(ratio(0, 0)).toBe(1);
		expect(ratio(5, 10)).toBe(0.5);
	});
});

describe('diff', () => {
	it('calls an unchanged model identical', () => {
		const changes = diffDescriptions(describeBuilt({}, 'a'), describeBuilt({}, 'b'));
		expect(changes.identical).toBe(true);
		expect(changes.severity).toBe('none');
		expect(changes.summary.changed).toBe(0);
	});

	it('detects a rename instead of an add plus a remove', () => {
		const changes = diffDescriptions(describeBuilt({}, 'a'), describeBuilt({ meshName: 'Torso' }, 'b'));
		expect(changes.sections.meshes.renamed).toEqual([{ from: 'Body', to: 'Torso', name: 'Torso' }]);
		expect(changes.sections.meshes.added).toHaveLength(0);
		expect(changes.sections.meshes.removed).toHaveLength(0);
	});

	it('calls a moved vertex a major change and names the mesh', () => {
		const changes = diffDescriptions(
			describeBuilt({}, 'a'),
			describeBuilt({ positions: [0, 0, 0, 1, 0, 0, 0, 2, 0] }, 'b'),
		);
		expect(changes.severity).toBe('major');
		const mesh = changes.sections.meshes.modified.find((m) => m.name === 'Body');
		expect(mesh.changes.some((c) => c.field === 'geometry')).toBe(true);
		expect(changes.highlights.some((h) => h.text.includes('"Body"'))).toBe(true);
	});

	it('calls a removed joint breaking and names it', () => {
		const changes = diffDescriptions(describeBuilt({}, 'a'), describeBuilt({ joints: ['Hips'] }, 'b'));
		expect(changes.severity).toBe('breaking');
		const skin = changes.sections.skins.modified.find((s) => s.name === 'Armature');
		const joints = skin.changes.find((c) => c.field === 'joints' && c.a.length);
		expect(joints.a).toEqual(['Spine']);
		expect(changes.highlights[0].severity).toBe('breaking');
		expect(changes.highlights[0].text).toContain('Spine');
	});

	it('calls a recoloured material a minor change', () => {
		const changes = diffDescriptions(describeBuilt({}, 'a'), describeBuilt({ baseColor: [1, 0, 0, 1] }, 'b'));
		expect(changes.severity).toBe('minor');
		const material = changes.sections.materials.modified.find((m) => m.name === 'Skin');
		expect(material.changes.map((c) => c.field)).toContain('baseColorFactor');
	});

	it('reports a reparented node as moved, not as added and removed', () => {
		const changes = diffDescriptions(describeBuilt({}, 'a'), describeBuilt({ reparent: true }, 'b'));
		expect(changes.sections.nodes.moved.map((m) => m.name).sort()).toEqual(['Hips', 'Spine']);
		expect(changes.sections.nodes.added).toHaveLength(0);
		expect(changes.sections.nodes.removed).toHaveLength(0);
	});

	it('reports a retimed clip', () => {
		const changes = diffDescriptions(describeBuilt({}, 'a'), describeBuilt({ clipTimes: [0, 2] }, 'b'));
		const clip = changes.sections.animations.modified.find((c) => c.name === 'idle');
		expect(clip.changes.find((c) => c.field === 'duration')).toMatchObject({ a: 1, b: 2 });
	});

	it('carries totals with deltas and percentages', () => {
		const changes = diffDescriptions(
			describeBuilt({}, 'a'),
			describeBuilt({ joints: ['Hips', 'Spine', 'Chest'] }, 'b'),
		);
		expect(changes.totals.joints).toMatchObject({ a: 2, b: 3, delta: 1, pct: 50 });
	});

	it('is deterministic', () => {
		const once = JSON.stringify(diffDescriptions(describeBuilt({}, 'a'), describeBuilt({ meshName: 'Torso' }, 'b')));
		const twice = JSON.stringify(diffDescriptions(describeBuilt({}, 'a'), describeBuilt({ meshName: 'Torso' }, 'b')));
		expect(once).toBe(twice);
	});
});

describe('formatting', () => {
	const changes = diffDescriptions(describeBuilt({}, 'before.glb'), describeBuilt({ joints: ['Hips'] }, 'after.glb'));

	it('writes a plain-text report with no escape codes when colour is off', () => {
		const text = formatText(changes, { color: false });
		expect(text).toContain('BREAKING');
		expect(text).toContain('Skeletons');
		expect(text).not.toContain(String.fromCharCode(27));
	});

	it('writes Markdown a pull request can render', () => {
		const md = formatMarkdown(changes);
		expect(md.startsWith('### 3D diff:')).toBe(true);
		expect(md).toContain('<details><summary>Skeletons');
	});

	it('says so plainly when nothing changed', () => {
		const same = diffDescriptions(describeBuilt({}, 'a'), describeBuilt({}, 'b'));
		expect(formatText(same, { color: false })).toContain('identical');
		expect(formatMarkdown(same)).toContain('structurally identical');
	});
});

describe('real avatars', () => {
	it('describes a rigged Mixamo avatar', async () => {
		const bytes = new Uint8Array(await readFile(asset('xbot-idle.glb')));
		const model = await describeModel(bytes, { name: 'xbot-idle.glb' });
		expect(model.totals.skins).toBe(1);
		expect(model.totals.joints).toBeGreaterThan(50);
		expect(model.totals.triangles).toBeGreaterThan(1000);
		expect(model.nodes.some((n) => n.path.includes('mixamorig:Hips'))).toBe(true);
	});

	it('finds only the clip change between two exports of the same rig', async () => {
		const [a, b] = await Promise.all([
			readFile(asset('xbot-idle.glb')),
			readFile(asset('xbot-walk.glb')),
		]);
		const changes = await diffModels(new Uint8Array(a), new Uint8Array(b), {
			nameA: 'xbot-idle.glb',
			nameB: 'xbot-walk.glb',
		});
		expect(changes.sections.meshes.changed).toBe(0);
		expect(changes.sections.skins.changed).toBe(0);
		expect(changes.sections.nodes.changed).toBe(0);
		expect(changes.sections.animations.renamed).toEqual([{ from: 'idle', to: 'walk', name: 'walk' }]);
	});

	it('calls two different characters breaking', async () => {
		const [a, b] = await Promise.all([
			readFile(asset('robot-walking.glb')),
			readFile(asset('xbot-walk.glb')),
		]);
		const changes = await diffModels(new Uint8Array(a), new Uint8Array(b), {
			nameA: 'robot-walking.glb',
			nameB: 'xbot-walk.glb',
		});
		expect(changes.severity).toBe('breaking');
		expect(changes.sections.skins.removed.length).toBeGreaterThan(0);
		expect(changes.totals.triangles.delta).toBeGreaterThan(0);
	});
});
