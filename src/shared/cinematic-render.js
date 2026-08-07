// Cinematic rendering defaults shared by every 3D viewer on the platform.
//
// Extracted from the pattern proven in /irl (src/irl.js) and the avatar
// result viewers (TalkScene, src/voice/talk-scene.js): ACES filmic tone
// mapping, correct sRGB output color space, image-based lighting from a
// real HDRI (falling back to a procedural room environment when the
// network asset hasn't loaded yet or a surface opts out for size), and a
// ground contact shadow that catches without requiring a visible floor.
//
// Any surface constructing its own WebGLRenderer should call
// `applyCinematicDefaults(renderer)` right after construction and
// `loadEnvironment(renderer, scene, preset)` once the scene exists, instead
// of re-deriving these values per file.

import {
	ACESFilmicToneMapping,
	SRGBColorSpace,
	VSMShadowMap,
	PMREMGenerator,
	Box3,
	PlaneGeometry,
	ShadowMaterial,
	Mesh,
} from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

/** Curated HDRI set, served from our own static assets (CC0, Poly Haven origin). */
export const HDRI_PRESETS = {
	studio: '/hdri/studio.hdr',
	outdoor: '/hdri/outdoor.hdr',
	sunset: '/hdri/sunset.hdr',
};

/** Render quality tiers a viewer can request. 'mobile' matches the low-end /club profile. */
export const QUALITY_TIERS = {
	high: { pixelRatioCap: 2, shadows: true, hdri: true },
	medium: { pixelRatioCap: 1.5, shadows: true, hdri: true },
	mobile: { pixelRatioCap: 1, shadows: false, hdri: false },
};

/**
 * Pick a quality tier from real capability signals, matching src/club-perf.js.
 * @param {object} [env]
 * @returns {'high'|'medium'|'mobile'}
 */
export function detectQualityTier(env = {}) {
	const nav = env.navigator ?? (typeof navigator !== 'undefined' ? navigator : {});
	const win = env.window ?? (typeof window !== 'undefined' ? window : {});
	const ua = String(nav.userAgent || '');
	const isMobile = /(iPhone|iPad|Android|Mobi)/i.test(ua);
	const lowMem = (nav.deviceMemory ?? 8) < 4;
	const lowCores = (nav.hardwareConcurrency ?? 8) < 4;
	const coarse = !!(win.matchMedia && win.matchMedia('(any-pointer: coarse)').matches);
	if (isMobile && (lowMem || lowCores)) return 'mobile';
	if (coarse || lowMem || lowCores) return 'medium';
	return 'high';
}

/**
 * Apply ACES tone mapping + correct color management + soft shadow type to
 * a renderer. Call once, right after construction.
 * @param {import('three').WebGLRenderer} renderer
 * @param {object} [opts]
 * @param {number} [opts.exposure] - toneMappingExposure, default 1.15 (matches /irl)
 * @param {'high'|'medium'|'mobile'} [opts.tier]
 */
export function applyCinematicDefaults(renderer, opts = {}) {
	const tier = QUALITY_TIERS[opts.tier] ? opts.tier : 'high';
	const budget = QUALITY_TIERS[tier];
	renderer.outputColorSpace = SRGBColorSpace;
	renderer.toneMapping = ACESFilmicToneMapping;
	renderer.toneMappingExposure = opts.exposure ?? 1.15;
	renderer.setPixelRatio(Math.min(typeof window !== 'undefined' ? window.devicePixelRatio : 1, budget.pixelRatioCap));
	if (budget.shadows) {
		renderer.shadowMap.enabled = true;
		renderer.shadowMap.type = VSMShadowMap;
	} else {
		renderer.shadowMap.enabled = false;
	}
	return budget;
}

const _envCache = new Map();

/**
 * Load a curated HDRI as the scene's IBL environment, PMREM-prefiltered.
 * Falls back to the procedural RoomEnvironment (still correct, just not a
 * real photograph) on fetch failure or when `preset` is null/'mobile' tier.
 * @param {import('three').WebGLRenderer} renderer
 * @param {import('three').Scene} scene
 * @param {'studio'|'outdoor'|'sunset'|null} preset
 */
export async function loadEnvironment(renderer, scene, preset = 'studio') {
	const pmrem = new PMREMGenerator(renderer);
	pmrem.compileEquirectangularShader();
	if (!preset || !HDRI_PRESETS[preset]) {
		scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
		return scene.environment;
	}
	try {
		let hdrTexture = _envCache.get(preset);
		if (!hdrTexture) {
			// HDRLoader is the same decoder RGBELoader wraps; RGBELoader is a
			// deprecated alias since three r180 and logs a warning on every use.
			const { HDRLoader } = await import('three/addons/loaders/HDRLoader.js');
			hdrTexture = await new HDRLoader().loadAsync(HDRI_PRESETS[preset]);
			_envCache.set(preset, hdrTexture);
		}
		const envMap = pmrem.fromEquirectangular(hdrTexture).texture;
		scene.environment = envMap;
		scene.environmentIntensity ??= 1;
		return envMap;
	} catch (err) {
		scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
		return scene.environment;
	}
}

/**
 * A ShadowMaterial plane that renders invisible except where a shadow
 * falls on it, giving a soft ground-contact shadow without a visible
 * floor. Sized/positioned from the target object's bounding box, so it
 * works for any model scale. Call again after the model changes size.
 * @param {import('three').Scene} scene
 * @param {import('three').Object3D} target
 * @param {import('three').Mesh} [existing] - reuse a prior catcher plane
 * @param {number} [opacity]
 */
export function updateGroundContactShadow(scene, target, existing, opacity = 0.35) {
	const b = new Box3().setFromObject(target);
	if (!Number.isFinite(b.min.y)) return existing ?? null;
	const footprint = Math.max(b.max.x - b.min.x, b.max.z - b.min.z, 1);
	const size = footprint * 6;
	let plane = existing;
	if (!plane) {
		plane = new Mesh(new PlaneGeometry(1, 1), new ShadowMaterial({ opacity }));
		plane.rotation.x = -Math.PI / 2;
		plane.receiveShadow = true;
		scene.add(plane);
	}
	plane.scale.set(size, size, 1);
	plane.position.set((b.min.x + b.max.x) / 2, b.min.y, (b.min.z + b.max.z) / 2);
	return plane;
}
