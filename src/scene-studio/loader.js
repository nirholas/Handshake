// Scene Studio — shared GLB→scene loader.
//
// Sibling module (not vendor/**): the single place that wires the
// Draco/KTX2/Meshopt-capable GLTFLoader and adds the parsed result to the
// editor through the normal undo-able AddObjectCommand path. Used by:
//   • main.js's deep-link importer (?model=<url>) and /pose hand-off.
//   • actions.js's "Import from Forge" affordance (a pasted GLB URL).
//
// Decoder paths match the vendored Loader.js exactly (same static assets
// under /scene-studio/), so an object added through either path decodes
// identically.

import { AddObjectCommand } from './vendor/js/commands/AddObjectCommand.js';

let _loaderPromise = null;

/**
 * Lazily build a GLTFLoader wired with Draco/KTX2/Meshopt decoders. Memoized
 * per page load — decoders are stateless enough to reuse across parses.
 * @param {import('./vendor/js/Editor.js').Editor} editor
 */
function getGltfLoader(editor) {
	if (_loaderPromise) return _loaderPromise;
	_loaderPromise = Promise.all([
		import('three/addons/loaders/GLTFLoader.js'),
		import('three/addons/loaders/DRACOLoader.js'),
		import('three/addons/loaders/KTX2Loader.js'),
		import('three/addons/libs/meshopt_decoder.module.js'),
	]).then(([{ GLTFLoader }, { DRACOLoader }, { KTX2Loader }, { MeshoptDecoder }]) => {
		const dracoLoader = new DRACOLoader();
		dracoLoader.setDecoderPath('/three/draco/gltf/');
		const ktx2Loader = new KTX2Loader();
		ktx2Loader.setTranscoderPath('/scene-studio/basis/');
		editor.signals.rendererDetectKTX2Support.dispatch(ktx2Loader);
		const loader = new GLTFLoader();
		loader.setDRACOLoader(dracoLoader);
		loader.setKTX2Loader(ktx2Loader);
		loader.setMeshoptDecoder(MeshoptDecoder);
		return loader;
	});
	return _loaderPromise;
}

/**
 * Parse a GLB ArrayBuffer and add it to the scene via AddObjectCommand
 * (undo-able, autosave-triggering, outliner-visible — identical to a manual
 * drag-and-drop import).
 *
 * @param {import('./vendor/js/Editor.js').Editor} editor
 * @param {ArrayBuffer} contents
 * @param {string} [label] — object name in the outliner.
 * @returns {Promise<THREE.Object3D>}
 */
export async function addGltfBufferToScene(editor, contents, label) {
	const loader = await getGltfLoader(editor);
	const result = await loader.parseAsync(contents, '');
	const object = result.scene;
	if (label) object.name = label;
	object.animations.push(...result.animations);
	editor.execute(new AddObjectCommand(editor, object));
	editor.selectByUuid(object.uuid);
	return object;
}
