// Reusable "fomo-family" hero backdrop — deep space, concentric glowing rings,
// a starfield, soft bloom, slow ambient drift, and pointer parallax.
//
// It renders ONLY the atmosphere. The focal subject (a `<agent-3d>` avatar,
// product shot, anything) is layered on top in the DOM with a transparent
// background, exactly the way fomo.family composes a lit character over a
// glowing space stage. Keeping the bloom-heavy backdrop in its own WebGL
// context means we can light it aggressively without washing out the subject,
// and we reuse the battle-tested avatar runtime untouched.
//
// Usage:
//   import { HeroStage } from '/src/hero-stage.js';
//   const stage = new HeroStage(canvas, { accent: '#7c6cff', accent2: '#36e0ff' });
//   stage.start();
//   // ...later
//   stage.dispose();

import {
	Scene,
	PerspectiveCamera,
	WebGLRenderer,
	Color,
	Vector2,
	Group,
	TorusGeometry,
	MeshBasicMaterial,
	Mesh,
	BufferGeometry,
	BufferAttribute,
	Points,
	PointsMaterial,
	AdditiveBlending,
	SRGBColorSpace,
	ACESFilmicToneMapping,
} from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { loadEnvironment } from './shared/cinematic-render.js';

const REDUCED_MOTION = () =>
	typeof window !== 'undefined' &&
	window.matchMedia &&
	window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export class HeroStage {
	/**
	 * @param {HTMLCanvasElement} canvas
	 * @param {{ accent?: string, accent2?: string, rings?: number, stars?: number }} [opts]
	 */
	constructor(canvas, opts = {}) {
		this.canvas = canvas;
		this.accent = new Color(opts.accent || '#7c6cff');
		this.accent2 = new Color(opts.accent2 || '#36e0ff');
		this.ringCount = opts.rings ?? 5;
		this.starCount = opts.stars ?? 1400;

		this._raf = 0;
		this._t = 0;
		this._reduced = REDUCED_MOTION();
		this._pointer = new Vector2(0, 0); // target, -1..1
		this._parallax = new Vector2(0, 0); // eased
		this._resizeObs = null;
		this._mqlReduce = null;

		this._onPointerMove = this._onPointerMove.bind(this);
		this._onPointerLeave = this._onPointerLeave.bind(this);
		this._renderLoop = this._renderLoop.bind(this);
		this._onReduceChange = this._onReduceChange.bind(this);

		this._init();
	}

	_init() {
		const w = this._cssWidth();
		const h = this._cssHeight();

		this.scene = new Scene();

		this.camera = new PerspectiveCamera(42, w / h, 0.1, 100);
		this.camera.position.set(0, 0, 14);
		this.camera.lookAt(0, 0, 0);

		this.renderer = new WebGLRenderer({
			canvas: this.canvas,
			antialias: true,
			alpha: true,
			powerPreference: 'high-performance',
		});
		this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
		this.renderer.setSize(w, h, false);
		this.renderer.outputColorSpace = SRGBColorSpace;
		this.renderer.toneMapping = ACESFilmicToneMapping;
		this.renderer.toneMappingExposure = 1.05;

		// Real HDRI image-based lighting so the rings/stars pick up subtle
		// reflected colour instead of relying on emissive materials alone.
		// Falls back to a procedural room environment internally on fetch failure.
		loadEnvironment(this.renderer, this.scene, 'studio');

		this._buildRings();
		this._buildStars();

		// Post-processing: bloom is ~70% of the look. Keep it generous on the
		// emissive rings/stars but the threshold is high enough that only the
		// genuinely bright geometry blooms.
		// The composer inherits the renderer's pixel ratio on construction and
		// rescales every pass by it on setSize — no separate ratio call needed.
		this.composer = new EffectComposer(this.renderer);
		this.composer.setSize(w, h);
		this.composer.addPass(new RenderPass(this.scene, this.camera));
		this.bloom = new UnrealBloomPass(new Vector2(w, h), 0.9, 0.7, 0.2);
		this.composer.addPass(this.bloom);
		this.composer.addPass(new OutputPass());

		this._resizeObs = new ResizeObserver(() => this._resize());
		this._resizeObs.observe(this.canvas.parentElement || this.canvas);

		this._mqlReduce = window.matchMedia('(prefers-reduced-motion: reduce)');
		this._mqlReduce.addEventListener?.('change', this._onReduceChange);
	}

	_buildRings() {
		this.ringGroup = new Group();
		this.scene.add(this.ringGroup);
		this.rings = [];

		for (let i = 0; i < this.ringCount; i++) {
			const f = i / Math.max(1, this.ringCount - 1); // 0..1 outward
			const radius = 2.4 + i * 1.45;
			const tube = 0.012 + f * 0.02;
			const geo = new TorusGeometry(radius, tube, 16, 220);
			const color = this.accent.clone().lerp(this.accent2, f);
			const mat = new MeshBasicMaterial({
				color,
				transparent: true,
				opacity: 0.85 - f * 0.45,
				blending: AdditiveBlending,
				depthWrite: false,
			});
			const ring = new Mesh(geo, mat);
			// Tilt the stack slightly so the rings read as a 3D disc, not a flat target.
			ring.rotation.x = -0.62;
			ring.rotation.z = f * 0.18;
			this.ringGroup.add(ring);
			this.rings.push({
				mesh: ring,
				baseOpacity: mat.opacity,
				spin: (i % 2 === 0 ? 1 : -1) * (0.015 + f * 0.02),
				pulse: 0.5 + f * 0.7,
			});
		}
		this.ringGroup.rotation.x = 0.18;
	}

	_buildStars() {
		const n = this.starCount;
		const positions = new Float32Array(n * 3);
		const colors = new Float32Array(n * 3);
		const c = new Color();
		for (let i = 0; i < n; i++) {
			// Distribute in a deep shell behind the rings.
			const r = 18 + Math.pow((i % 97) / 97, 0.5) * 42;
			const theta = (i * 2.39996) % (Math.PI * 2); // golden-angle spread
			const phi = Math.acos(1 - 2 * ((i + 0.5) / n));
			positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
			positions[i * 3 + 1] = r * Math.cos(phi) * 0.55;
			positions[i * 3 + 2] = -8 - r * Math.sin(phi) * Math.sin(theta) * 0.4;
			// Mostly cool white, a few tinted with the accent for depth.
			const tint = (i % 11) === 0 ? this.accent2 : (i % 7) === 0 ? this.accent : null;
			c.set('#ffffff');
			if (tint) c.lerp(tint, 0.7);
			c.toArray(colors, i * 3);
		}
		const geo = new BufferGeometry();
		geo.setAttribute('position', new BufferAttribute(positions, 3));
		geo.setAttribute('color', new BufferAttribute(colors, 3));
		this.stars = new Points(
			geo,
			new PointsMaterial({
				size: 0.09,
				sizeAttenuation: true,
				vertexColors: true,
				transparent: true,
				opacity: 0.9,
				blending: AdditiveBlending,
				depthWrite: false,
			})
		);
		this.scene.add(this.stars);
	}

	start() {
		if (this._raf) return;
		window.addEventListener('pointermove', this._onPointerMove, { passive: true });
		window.addEventListener('pointerleave', this._onPointerLeave, { passive: true });
		if (this._reduced) {
			// One settled frame, no animation loop.
			this._composeStatic();
			return;
		}
		this._last = performance.now();
		this._raf = requestAnimationFrame(this._renderLoop);
	}

	_composeStatic() {
		this._parallax.set(0, 0);
		this.composer.render();
	}

	_renderLoop(now) {
		this._raf = requestAnimationFrame(this._renderLoop);
		const dt = Math.min(0.05, (now - this._last) / 1000);
		this._last = now;
		this._t += dt;

		// Ease the camera toward the pointer for a slow parallax drift.
		this._parallax.x += (this._pointer.x - this._parallax.x) * 0.04;
		this._parallax.y += (this._pointer.y - this._parallax.y) * 0.04;
		this.camera.position.x = this._parallax.x * 1.6;
		this.camera.position.y = this._parallax.y * 1.1;
		this.camera.lookAt(0, 0, 0);

		// Rings: gentle independent spin + a breathing opacity pulse.
		for (const r of this.rings) {
			r.mesh.rotation.z += r.spin * dt * 4;
			const pulse = 0.5 + 0.5 * Math.sin(this._t * r.pulse);
			r.mesh.material.opacity = r.baseOpacity * (0.7 + 0.3 * pulse);
		}
		this.ringGroup.rotation.y = Math.sin(this._t * 0.12) * 0.12;

		// Stars drift very slowly for life without distraction.
		this.stars.rotation.y += dt * 0.01;

		this.composer.render();
	}

	_onPointerMove(e) {
		const w = window.innerWidth || 1;
		const h = window.innerHeight || 1;
		this._pointer.set((e.clientX / w) * 2 - 1, -((e.clientY / h) * 2 - 1));
	}

	_onPointerLeave() {
		this._pointer.set(0, 0);
	}

	_onReduceChange(e) {
		this._reduced = e.matches;
		if (this._reduced) {
			if (this._raf) {
				cancelAnimationFrame(this._raf);
				this._raf = 0;
			}
			this._composeStatic();
		} else if (!this._raf) {
			this._last = performance.now();
			this._raf = requestAnimationFrame(this._renderLoop);
		}
	}

	_cssWidth() {
		const el = this.canvas.parentElement || this.canvas;
		return el.clientWidth || window.innerWidth || 1;
	}

	_cssHeight() {
		const el = this.canvas.parentElement || this.canvas;
		return el.clientHeight || window.innerHeight || 1;
	}

	_resize() {
		const w = this._cssWidth();
		const h = this._cssHeight();
		if (!w || !h) return;
		this.renderer.setSize(w, h, false);
		// composer.setSize already resizes every pass (incl. bloom) by the
		// pixel ratio — calling bloom.setSize again here would override it with
		// the un-scaled CSS size and soften the glow on hi-DPI screens.
		this.composer.setSize(w, h);
		this.camera.aspect = w / h;
		this.camera.updateProjectionMatrix();
		if (this._reduced) this._composeStatic();
	}

	dispose() {
		if (this._raf) cancelAnimationFrame(this._raf);
		this._raf = 0;
		window.removeEventListener('pointermove', this._onPointerMove);
		window.removeEventListener('pointerleave', this._onPointerLeave);
		this._mqlReduce?.removeEventListener?.('change', this._onReduceChange);
		this._resizeObs?.disconnect();

		this.rings?.forEach((r) => {
			r.mesh.geometry.dispose();
			r.mesh.material.dispose();
		});
		this.stars?.geometry.dispose();
		this.stars?.material.dispose();
		this.composer?.dispose?.();
		this.renderer?.dispose();
		this.renderer?.forceContextLoss?.();
		this.scene = null;
		this.camera = null;
		this.renderer = null;
	}
}

export default HeroStage;
