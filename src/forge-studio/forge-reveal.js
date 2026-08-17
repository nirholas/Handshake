// Forge reveal — the cinematic materialize entrance for a forged model.
//
// Plays in its own WebGL overlay above the result <model-viewer>: the mesh
// resolves through a rising noise dissolve whose frontier glows in the page
// accent while a wireframe ghost fades out, the camera dollies in, and a
// contact shadow blooms underneath. Once the dissolve lands (and the standing
// viewer below reports loaded) the overlay crossfades away — same GLB, already
// in the HTTP cache, so the swap is seamless.
//
// Presentation only, never a dependency: any failure (no WebGL, loader error,
// timeout) resolves immediately and the standing viewer is untouched. Honors
// prefers-reduced-motion by not playing at all.

import { resolveDevR2Url } from '../shared/dev-r2-proxy.js';

const REVEAL_DELAY_MS = 200; // beat before the dissolve starts
const DISSOLVE_MS = 2100; // wireframe ghost → textured surface
const MIN_HOLD_MS = 450; // settle time after the dissolve completes
const MAX_WAIT_MS = 6000; // cap on waiting for the viewer underneath
const LOAD_TIMEOUT_MS = 12000; // give up on the GLB fetch beyond this
const FADE_OUT_MS = 420; // overlay crossfade duration (mirrored in CSS)
const TURNTABLE_DEG_PER_S = 14; // continuous yaw across the whole sequence

// One reveal at a time — opening another creation mid-sequence cancels the
// running one before its overlay can fight the new one for the same shell.
let activeCancel = null;

function accentColor() {
	const v = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
	return v || '#4fc3ff';
}

const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const easeOut = (t) => 1 - (1 - t) ** 3;

// GLSL injected into every material of the loaded model via onBeforeCompile:
// a world-space value noise drives a discard threshold (the dissolve) and an
// additive emissive band right at the frontier (the glow).
const NOISE_GLSL = /* glsl */ `
	uniform float uDissolve;
	uniform vec3 uEdgeColor;
	uniform float uEdgeWidth;
	varying vec3 vForgeWorld;
	float forgeHash( vec3 p ) {
		p = fract( p * 0.3183099 + vec3( 0.71, 0.113, 0.419 ) );
		p *= 17.0;
		return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) );
	}
	float forgeNoise( vec3 x ) {
		vec3 i = floor( x );
		vec3 f = fract( x );
		f = f * f * ( 3.0 - 2.0 * f );
		return mix(
			mix( mix( forgeHash( i ), forgeHash( i + vec3( 1, 0, 0 ) ), f.x ),
				mix( forgeHash( i + vec3( 0, 1, 0 ) ), forgeHash( i + vec3( 1, 1, 0 ) ), f.x ), f.y ),
			mix( mix( forgeHash( i + vec3( 0, 0, 1 ) ), forgeHash( i + vec3( 1, 0, 1 ) ), f.x ),
				mix( forgeHash( i + vec3( 0, 1, 1 ) ), forgeHash( i + vec3( 1, 1, 1 ) ), f.x ), f.y ),
			f.z );
	}
`;

function patchMaterial(material, uniforms) {
	material.onBeforeCompile = (shader) => {
		shader.uniforms.uDissolve = uniforms.uDissolve;
		shader.uniforms.uEdgeColor = uniforms.uEdgeColor;
		shader.uniforms.uEdgeWidth = uniforms.uEdgeWidth;
		shader.vertexShader = shader.vertexShader
			.replace('void main() {', 'varying vec3 vForgeWorld;\nvoid main() {')
			.replace(
				'#include <project_vertex>',
				'#include <project_vertex>\n\tvForgeWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;',
			);
		shader.fragmentShader = shader.fragmentShader
			.replace('void main() {', `${NOISE_GLSL}\nvoid main() {`)
			.replace(
				'#include <clipping_planes_fragment>',
				[
					'#include <clipping_planes_fragment>',
					'\tfloat forgeN = forgeNoise( vForgeWorld * 3.2 );',
					'\tfloat forgeReveal = uDissolve * ( 1.0 + uEdgeWidth * 2.0 ) - uEdgeWidth;',
					'\tif ( forgeN > forgeReveal + uEdgeWidth ) discard;',
				].join('\n'),
			)
			.replace(
				'#include <dithering_fragment>',
				[
					'\tfloat forgeBand = smoothstep( forgeReveal - uEdgeWidth, forgeReveal + uEdgeWidth, forgeN );',
					'\tgl_FragColor.rgb += uEdgeColor * forgeBand * 2.2;',
					'#include <dithering_fragment>',
				].join('\n'),
			);
	};
	// Distinct cache key so three doesn't reuse the unpatched program.
	material.customProgramCacheKey = () => 'forge-dissolve';
	material.needsUpdate = true;
}

// Soft radial contact shadow — a canvas gradient on a ground plane, no
// shadow-map pass needed for a single hero object.
function makeContactShadow(THREE) {
	const c = document.createElement('canvas');
	c.width = c.height = 256;
	const ctx = c.getContext('2d');
	const g = ctx.createRadialGradient(128, 128, 8, 128, 128, 124);
	g.addColorStop(0, 'rgba(0,0,0,0.62)');
	g.addColorStop(0.6, 'rgba(0,0,0,0.22)');
	g.addColorStop(1, 'rgba(0,0,0,0)');
	ctx.fillStyle = g;
	ctx.fillRect(0, 0, 256, 256);
	const tex = new THREE.CanvasTexture(c);
	const mat = new THREE.MeshBasicMaterial({
		map: tex,
		transparent: true,
		opacity: 0,
		depthWrite: false,
	});
	const mesh = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 4.2), mat);
	mesh.rotation.x = -Math.PI / 2;
	mesh.position.y = 0.001;
	mesh.renderOrder = -1;
	return mesh;
}

/**
 * Play the materialize sequence over `container` (made position:relative if
 * static). `waitFor` is an optional promise the overlay holds its turntable
 * for before fading — pass the underlying model-viewer's load so the swap
 * never reveals an empty viewer. Resolves with the final camera orbit
 * ({ azimuthDeg, polarDeg }) for handoff, or null when skipped/cancelled.
 */
export async function playForgeReveal({ container, glbUrl, waitFor }) {
	if (!container || !glbUrl) return null;
	if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) {
		return null;
	}
	if (activeCancel) activeCancel();

	let cancelled = false;
	let cleanupFns = [];
	const cancel = () => {
		cancelled = true;
		for (const fn of cleanupFns.splice(0)) {
			try {
				fn();
			} catch {
				/* disposal best-effort */
			}
		}
	};
	activeCancel = cancel;

	try {
		const [THREE, { GLTFLoader }, { RoomEnvironment }, { getMeshoptDecoder }] = await Promise.all([
			import('three'),
			import('three/addons/loaders/GLTFLoader.js'),
			import('three/addons/environments/RoomEnvironment.js'),
			import('../viewer/internal.js'),
		]);
		if (cancelled) return null;

		// Fetch + parse the GLB first — the overlay only ever appears with a
		// model in hand, so a slow or failed load degrades to the plain viewer.
		const loader = new GLTFLoader();
		loader.setMeshoptDecoder(await getMeshoptDecoder());
		const gltf = await Promise.race([
			loader.loadAsync(resolveDevR2Url(glbUrl)),
			new Promise((resolve) => setTimeout(() => resolve(null), LOAD_TIMEOUT_MS)),
		]);
		if (!gltf || cancelled) return null;

		// Overlay scaffold ----------------------------------------------------
		if (getComputedStyle(container).position === 'static') {
			container.style.position = 'relative';
		}
		const overlay = document.createElement('div');
		overlay.className = 'forge-reveal-overlay';
		overlay.setAttribute('aria-hidden', 'true');
		container.appendChild(overlay);
		cleanupFns.push(() => overlay.remove());

		const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
		renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
		renderer.toneMapping = THREE.ACESFilmicToneMapping;
		renderer.toneMappingExposure = 1.6;
		overlay.appendChild(renderer.domElement);
		cleanupFns.push(() => renderer.dispose());

		const scene = new THREE.Scene();
		const pmrem = new THREE.PMREMGenerator(renderer);
		const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
		pmrem.dispose();
		scene.environment = envTex;
		cleanupFns.push(() => envTex.dispose());

		// TRELLIS models can bake in dark textures; supplement IBL with explicit
		// lights so the mesh reads clearly regardless of how dark the bake is.
		const hemi = new THREE.HemisphereLight(0xffffff, 0x8899bb, 1.8);
		scene.add(hemi);
		const key = new THREE.DirectionalLight(0xffffff, 2.5);
		key.position.set(1, 1.5, 1.2);
		scene.add(key);
		const fill = new THREE.DirectionalLight(0xddeeff, 0.8);
		fill.position.set(-1, 0.5, -0.5);
		scene.add(fill);

		const camera = new THREE.PerspectiveCamera(32, 1, 0.05, 60);
		const target = new THREE.Vector3(0, 0.62, 0);

		const sizeToContainer = () => {
			const w = Math.max(1, container.clientWidth);
			const h = Math.max(1, container.clientHeight);
			renderer.setSize(w, h, false);
			camera.aspect = w / h;
			camera.updateProjectionMatrix();
		};
		sizeToContainer();
		const ro = new ResizeObserver(sizeToContainer);
		ro.observe(container);
		cleanupFns.push(() => ro.disconnect());

		// Model: center on origin, ground at y=0, fit to a ~2-unit frame.
		const model = gltf.scene;
		const box = new THREE.Box3().setFromObject(model);
		const size = box.getSize(new THREE.Vector3());
		const center = box.getCenter(new THREE.Vector3());
		const scale = 2 / Math.max(size.x, size.y, size.z, 0.0001);
		model.scale.setScalar(scale);
		model.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);

		const uniforms = {
			uDissolve: { value: 0 },
			uEdgeColor: { value: new THREE.Color(accentColor()) },
			uEdgeWidth: { value: 0.045 },
		};
		model.traverse((node) => {
			if (!node.isMesh) return;
			const mats = Array.isArray(node.material) ? node.material : [node.material];
			for (const m of mats) if (m) patchMaterial(m, uniforms);
		});

		// Wireframe ghost — the model's silhouette before it has a surface.
		const ghostMat = new THREE.MeshBasicMaterial({
			color: new THREE.Color(accentColor()),
			wireframe: true,
			transparent: true,
			opacity: 0,
			depthWrite: false,
		});
		const ghost = model.clone(true);
		ghost.traverse((node) => {
			if (node.isMesh) node.material = ghostMat;
		});
		ghost.scale.multiplyScalar(1.002);

		const shadow = makeContactShadow(THREE);
		scene.add(model, ghost, shadow);
		cleanupFns.push(() => {
			scene.traverse((node) => {
				if (node.isMesh) {
					node.geometry?.dispose?.();
					const mats = Array.isArray(node.material) ? node.material : [node.material];
					for (const m of mats) m?.dispose?.();
				}
			});
		});

		// Timeline --------------------------------------------------------------
		const startAzimuth = -0.7; // radians; drifts continuously from here
		let azimuth = startAzimuth;
		let polar = Math.PI / 2.6;

		const animateUntil = (predicate, onFrame) =>
			new Promise((resolve) => {
				const t0 = performance.now();
				const frame = (now) => {
					if (cancelled) return resolve();
					const t = now - t0;
					onFrame(t, now);
					if (predicate(t)) return resolve();
					requestAnimationFrame(frame);
				};
				requestAnimationFrame(frame);
			});

		const renderFrame = (t) => {
			const total = (t + REVEAL_DELAY_MS) / 1000;
			azimuth = startAzimuth + THREE.MathUtils.degToRad(TURNTABLE_DEG_PER_S) * total;
			const dolly = easeOut(Math.min(1, t / (DISSOLVE_MS + MIN_HOLD_MS)));
			const radius = 4.4 - 1.15 * dolly;
			polar = Math.PI / 2.6 + 0.12 * dolly;
			camera.position.set(
				target.x + radius * Math.sin(polar) * Math.sin(azimuth),
				target.y + radius * Math.cos(polar),
				target.z + radius * Math.sin(polar) * Math.cos(azimuth),
			);
			camera.lookAt(target);
			renderer.render(scene, camera);
		};

		// Beat 1: the ghost rises out of nothing.
		await animateUntil(
			(t) => t >= REVEAL_DELAY_MS,
			(t) => {
				ghostMat.opacity = 0.3 * easeOut(Math.min(1, t / REVEAL_DELAY_MS));
				renderFrame(t - REVEAL_DELAY_MS);
			},
		);
		if (cancelled) return null;

		// Beat 2: the dissolve sweeps the surface in; the ghost yields to it.
		await animateUntil(
			(t) => t >= DISSOLVE_MS,
			(t) => {
				const d = easeInOut(Math.min(1, t / DISSOLVE_MS));
				uniforms.uDissolve.value = d;
				ghostMat.opacity = 0.3 * (1 - d);
				shadow.material.opacity = 0.62 * d;
				renderFrame(t);
			},
		);
		if (cancelled) return null;
		uniforms.uDissolve.value = 1;
		ghostMat.opacity = 0;

		// Beat 3: hold the turntable until the viewer underneath is ready.
		const ready = Promise.race([
			Promise.resolve(waitFor).catch(() => {}),
			new Promise((resolve) => setTimeout(resolve, MAX_WAIT_MS)),
		]);
		let viewerReady = false;
		ready.then(() => {
			viewerReady = true;
		});
		await animateUntil(
			(t) => t >= MIN_HOLD_MS && viewerReady,
			(t) => renderFrame(DISSOLVE_MS + t),
		);
		if (cancelled) return null;

		// Beat 4: crossfade out — keep rendering through the fade so the
		// turntable never freezes mid-swap.
		overlay.classList.add('is-fading');
		await animateUntil(
			(t) => t >= FADE_OUT_MS,
			(t) => renderFrame(DISSOLVE_MS + MIN_HOLD_MS + t),
		);

		const azimuthDeg = THREE.MathUtils.radToDeg(azimuth) % 360;
		const polarDeg = THREE.MathUtils.radToDeg(polar);
		cancel();
		return { azimuthDeg, polarDeg };
	} catch {
		cancel();
		return null;
	} finally {
		if (activeCancel === cancel) activeCancel = null;
	}
}
