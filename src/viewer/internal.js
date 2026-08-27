import { LoadingManager, REVISION } from 'three';

export const DEFAULT_CAMERA = '[default]';
export const Preset = { ASSET_GENERATOR: 'assetgenerator' };

export const MANAGER = new LoadingManager();
const THREE_PATH = `https://unpkg.com/three@0.${REVISION}.x`;

// Decoder binaries. scripts/copy-three-decoders.mjs vendors them into
// public/three/ on every install and audit-deploy-artifacts.mjs fails a deploy
// that ships without them, so the same-origin copy is the reliable source and
// unpkg is only the backstop. Resolving against import.meta.url rather than a
// site-absolute path is what makes this correct inside a third-party
// <agent-3d> embed: the URL points at the origin serving this module (three.ws),
// not at the embedding page's origin, where /three/* would 404.
const LOCAL_THREE_PATH = (() => {
	try {
		return new URL('../../three/', import.meta.url).href.replace(/\/$/, '');
	} catch {
		return '/three';
	}
})();

// One probe, memoised: does the vendored copy actually answer here? A stale
// deploy or a bundler that dropped public/three falls back to unpkg rather than
// failing every compressed model with an opaque decoder error.
let _decoderBase = null;
async function decoderBase() {
	if (_decoderBase) return _decoderBase;
	try {
		const res = await fetch(`${LOCAL_THREE_PATH}/draco/gltf/draco_decoder.wasm`, {
			method: 'HEAD',
			signal: AbortSignal.timeout(4000),
		});
		_decoderBase = res.ok
			? { draco: `${LOCAL_THREE_PATH}/draco/gltf/`, basis: `${LOCAL_THREE_PATH}/basis/` }
			: { draco: `${THREE_PATH}/examples/jsm/libs/draco/gltf/`, basis: `${THREE_PATH}/examples/jsm/libs/basis/` };
	} catch {
		_decoderBase = { draco: `${THREE_PATH}/examples/jsm/libs/draco/gltf/`, basis: `${THREE_PATH}/examples/jsm/libs/basis/` };
	}
	return _decoderBase;
}

/**
 * Lazy, memoized setup of the Draco/KTX2/Meshopt decoders. Dynamically imports
 * each module the first time a model is loaded, so the first-paint bundle does
 * not pay for decoders that most callers never use.
 *
 * @returns {Promise<{ dracoLoader: DRACOLoader, ktx2Loader: KTX2Loader, meshoptDecoder: any }>}
 */
let _decodersPromise = null;
export function getDecoders() {
	if (_decodersPromise) return _decodersPromise;
	_decodersPromise = Promise.all([
		import('three/addons/loaders/DRACOLoader.js'),
		import('three/addons/loaders/KTX2Loader.js'),
		import('three/addons/libs/meshopt_decoder.module.js'),
		decoderBase(),
	]).then(([dracoMod, ktx2Mod, meshoptMod, base]) => {
		const dracoLoader = new dracoMod.DRACOLoader(MANAGER).setDecoderPath(base.draco);
		const ktx2Loader = new ktx2Mod.KTX2Loader(MANAGER).setTranscoderPath(base.basis);
		return { dracoLoader, ktx2Loader, meshoptDecoder: meshoptMod.MeshoptDecoder };
	});
	return _decodersPromise;
}

// Focused helper for viewers that only load avatars baked through the
// server-side pipeline. The bake emits EXT_meshopt_compression but never
// KHR_draco_mesh_compression or KTX2 textures (textureCompress targets WebP),
// so loading the heavier draco / ktx2 decoders would be wasted bytes.
let _meshoptDecoderPromise = null;
export function getMeshoptDecoder() {
	if (_meshoptDecoderPromise) return _meshoptDecoderPromise;
	_meshoptDecoderPromise = import('three/addons/libs/meshopt_decoder.module.js').then(
		(m) => m.MeshoptDecoder,
	);
	return _meshoptDecoderPromise;
}

export function traverseMaterials(object, callback) {
	const seen = new Set();
	object.traverse((node) => {
		if (!node.geometry) return;
		const materials = Array.isArray(node.material) ? node.material : [node.material];
		materials.forEach((mat) => {
			if (mat && !seen.has(mat.uuid)) {
				seen.add(mat.uuid);
				callback(mat);
			}
		});
	});
}
