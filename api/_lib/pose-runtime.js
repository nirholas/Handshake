// The client posing stack, shipped into a headless-chromium render page.
//
// src/pose-rig.js + src/glb-canonicalize.js + src/pose-mannequin.js are pure
// three.js ESM, so a render page can run the EXACT code the browser runs:
// canonical bone-name mapping for every rig convention we support, and
// world-delta preset retargeting (poseFromMannequinPreset then
// GltfRig.applyPose) that lands a preset on top of any bind stance.
//
// The sources go to the page as data: URL modules in its import map, with
// pose-rig's relative imports rewritten to the bare specifiers the map
// defines. Never reintroduce a hand-rolled alias table in a renderer: one
// silently missed every Mixamo rig (GLTFLoader strips ':' from node names) and
// stomped absolute local Eulers over bind rotations on the rest, so
// /api/render/avatar-clip answered 200 with an unposed model.

import { readFileSync } from 'node:fs';

const SRC_DIR = new URL('../../src/', import.meta.url);

function poseModuleDataUrl(file, rewrites = []) {
	let code = readFileSync(new URL(file, SRC_DIR), 'utf8');
	for (const [from, to] of rewrites) code = code.replaceAll(from, to);
	if (/from\s+['"]\.{1,2}\//.test(code)) {
		throw new Error(`pose-runtime: ${file} still has relative imports after rewrite, update poseRuntimeModules()`);
	}
	return 'data:text/javascript;base64,' + Buffer.from(code, 'utf8').toString('base64');
}

let _poseRuntimeModules = null;

/**
 * Import-map entries for the posing stack, built once per container.
 *
 * @returns {{['glb-canonicalize']:string,['pose-mannequin']:string,['pose-rig']:string}}
 */
export function poseRuntimeModules() {
	if (_poseRuntimeModules) return _poseRuntimeModules;
	_poseRuntimeModules = {
		'glb-canonicalize': poseModuleDataUrl('glb-canonicalize.js'),
		'pose-mannequin': poseModuleDataUrl('pose-mannequin.js'),
		'pose-rig': poseModuleDataUrl('pose-rig.js', [
			["from './glb-canonicalize.js'", "from 'glb-canonicalize'"],
			["from './pose-mannequin.js'", "from 'pose-mannequin'"],
		]),
	};
	return _poseRuntimeModules;
}
