// PointCloudViewer — render a coloured 3D point cloud (.ply) in the browser.
//
// The output format of the Scene Capture pipeline (workers/model-video2scene,
// LingBot-Map): a binary PLY of world-space points with per-vertex RGB. This is a
// plain point cloud, NOT a Gaussian splat — so it renders with THREE.Points, not
// the splat engine. Render-on-demand (no idle rAF) keeps it efficient: the loop
// only paints while interacting, auto-rotating, or settling.

import {
	Scene,
	PerspectiveCamera,
	WebGLRenderer,
	Points,
	BufferGeometry,
	BufferAttribute,
	PointsMaterial,
	Color,
	Box3,
	Sphere,
	Vector3,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { applyCinematicDefaults, detectQualityTier } from './shared/cinematic-render.js';

export const COLOR_MODES = ['rgb', 'mono', 'height', 'depth'];

export class PointCloudViewer {
	constructor(host, { background = '#0a0a0a' } = {}) {
		this.host = host;
		this._disposed = false;
		this._needsRender = true;
		this._settleUntil = 0;
		this._autoRotate = false;
		this._colorMode = 'rgb';
		this._fps = 0;
		this._frames = 0;
		this._fpsT0 = performance.now();
		this._onFps = null;

		this.scene = new Scene();
		this.scene.background = new Color(background);

		this.camera = new PerspectiveCamera(55, 1, 0.01, 5000);
		this.camera.position.set(0, 0, 4);

		// preserveDrawingBuffer so screenshot()/toDataURL reliably capture the frame.
		this.renderer = new WebGLRenderer({ antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: true });
		// Shared cinematic bar for ACES tone mapping + sRGB output + tiered
		// pixel ratio cap - this still improves the color reproduction of
		// vertex-coloured points. No HDRI/IBL and no ground-contact shadow:
		// a point cloud has no surface materials for an environment map to
		// reflect off of and no shadow-catching mesh to receive on.
		applyCinematicDefaults(this.renderer, { tier: detectQualityTier() });
		host.appendChild(this.renderer.domElement);

		this.controls = new OrbitControls(this.camera, this.renderer.domElement);
		this.controls.enableDamping = true;
		this.controls.dampingFactor = 0.08;
		this.controls.rotateSpeed = 0.7;
		this.controls.addEventListener('change', () => { this._needsRender = true; });

		this.points = null;
		this.material = new PointsMaterial({ size: 0.012, sizeAttenuation: true, vertexColors: true });
		this._rgb = null; // original colours (Float32, 0..1), kept for colour-mode swaps
		this._home = { position: new Vector3(0, 0, 4), target: new Vector3(0, 0, 0) };
		this._radius = 1;
		this._baseSize = 0.012;

		this._onResize = this._resize.bind(this);
		window.addEventListener('resize', this._onResize);
		this._resize();
		this._loop = this._tick.bind(this);
		requestAnimationFrame(this._loop);
	}

	_resize() {
		const w = this.host.clientWidth || 1;
		const h = this.host.clientHeight || 1;
		this.renderer.setSize(w, h, false);
		this.camera.aspect = w / h;
		this.camera.updateProjectionMatrix();
		this._needsRender = true;
	}

	_tick() {
		if (this._disposed) return;
		requestAnimationFrame(this._loop);
		if (document.visibilityState === 'hidden') return; // pause rendering on a backgrounded tab
		const now = performance.now();
		const damping = this.controls.enableDamping && now < this._settleUntil;
		if (this._autoRotate && this.points) {
			this.points.rotation.y += 0.0032;
			this._needsRender = true;
		}
		if (this._needsRender || damping) {
			this.controls.update();
			this.renderer.render(this.scene, this.camera);
			this._needsRender = false;
			// FPS sampling — only counts painted frames, reported ~2×/sec.
			this._frames++;
			if (now - this._fpsT0 >= 500) {
				this._fps = Math.round((this._frames * 1000) / (now - this._fpsT0));
				this._frames = 0; this._fpsT0 = now;
				this._onFps?.(this._fps);
			}
		}
	}

	// Parse a PLY ArrayBuffer into a Points cloud and frame it. Returns { count }.
	loadBuffer(buffer) {
		const geom = new PLYLoader().parse(buffer);
		return this._setGeometry(geom);
	}

	setGeometryFromArrays(positions, colors) {
		const geom = new BufferGeometry();
		geom.setAttribute('position', new BufferAttribute(positions, 3));
		if (colors) geom.setAttribute('color', new BufferAttribute(colors, 3, true));
		return this._setGeometry(geom);
	}

	_setGeometry(geom) {
		if (this.points) {
			this.scene.remove(this.points);
			this.points.geometry.dispose();
		}
		if (!geom.getAttribute('color')) {
			const n = geom.getAttribute('position').count;
			const grey = new Float32Array(n * 3).fill(0.78);
			geom.setAttribute('color', new BufferAttribute(grey, 3));
		}
		geom.computeBoundingBox();
		const box = geom.boundingBox || new Box3();
		const sphere = box.getBoundingSphere(new Sphere());
		const center = sphere.center.clone();
		geom.translate(-center.x, -center.y, -center.z);
		this._radius = Math.max(sphere.radius, 0.001);
		this.material.size = this._radius * 0.006;
		this._baseSize = this.material.size;

		// Snapshot original colours as 0..1 floats so colour modes can restore/derive.
		const col = geom.getAttribute('color');
		this._rgb = new Float32Array(col.count * 3);
		const norm = col.normalized ? 1 / 255 : 1;
		for (let i = 0; i < this._rgb.length; i++) this._rgb[i] = col.array[i] * norm;

		this.points = new Points(geom, this.material);
		this.scene.add(this.points);
		this._applyColorMode();
		this._frame();
		return { count: geom.getAttribute('position').count };
	}

	_frame() {
		const r = this._radius;
		const dist = r * 2.6;
		this._home.position.set(dist * 0.5, dist * 0.35, dist);
		this._home.target.set(0, 0, 0);
		if (this.points) this.points.rotation.set(0, 0, 0);
		this.camera.position.copy(this._home.position);
		this.controls.target.copy(this._home.target);
		this.camera.near = Math.max(r / 1000, 0.001);
		this.camera.far = r * 100;
		this.camera.updateProjectionMatrix();
		this.controls.update();
		this._settle();
	}

	recenter() {
		if (!this.points) return;
		this.points.rotation.set(0, 0, 0);
		this.camera.position.copy(this._home.position);
		this.controls.target.copy(this._home.target);
		this._settle();
	}

	setPointScale(mult) {
		if (!this._baseSize) return;
		this.material.size = this._baseSize * mult;
		this._needsRender = true;
	}

	setAutoRotate(on) {
		this._autoRotate = Boolean(on);
		this._needsRender = true;
	}
	toggleAutoRotate() { this.setAutoRotate(!this._autoRotate); return this._autoRotate; }
	get autoRotate() { return this._autoRotate; }

	get colorMode() { return this._colorMode; }
	setColorMode(mode) {
		if (!COLOR_MODES.includes(mode)) return;
		this._colorMode = mode;
		this._applyColorMode();
	}
	cycleColorMode() {
		const i = COLOR_MODES.indexOf(this._colorMode);
		this.setColorMode(COLOR_MODES[(i + 1) % COLOR_MODES.length]);
		return this._colorMode;
	}

	// Derive the active colour buffer from the original RGB + point positions.
	_applyColorMode() {
		if (!this.points || !this._rgb) return;
		const col = this.points.geometry.getAttribute('color');
		const pos = this.points.geometry.getAttribute('position');
		const out = col.array;
		const n = pos.count;
		if (this._colorMode === 'rgb') {
			out.set(this._rgb);
		} else if (this._colorMode === 'mono') {
			for (let i = 0; i < n; i++) {
				const l = 0.299 * this._rgb[i * 3] + 0.587 * this._rgb[i * 3 + 1] + 0.114 * this._rgb[i * 3 + 2];
				out[i * 3] = out[i * 3 + 1] = out[i * 3 + 2] = l;
			}
		} else {
			// height (Y) or depth (distance from origin), mapped through a mono ramp.
			let lo = Infinity, hi = -Infinity;
			const val = new Float32Array(n);
			for (let i = 0; i < n; i++) {
				const x = pos.array[i * 3], y = pos.array[i * 3 + 1], z = pos.array[i * 3 + 2];
				const v = this._colorMode === 'height' ? y : Math.hypot(x, y, z);
				val[i] = v; if (v < lo) lo = v; if (v > hi) hi = v;
			}
			const span = hi - lo || 1;
			for (let i = 0; i < n; i++) {
				const t = 0.12 + 0.83 * ((val[i] - lo) / span);
				out[i * 3] = out[i * 3 + 1] = out[i * 3 + 2] = t;
			}
		}
		col.normalized = false;
		col.needsUpdate = true;
		this._needsRender = true;
	}

	// Capture the current frame as a PNG data URL (preserveDrawingBuffer makes this
	// reliable). Forces a fresh render first so the latest state is captured.
	screenshot() {
		if (!this.points) return null;
		this.controls.update();
		this.renderer.render(this.scene, this.camera);
		return this.renderer.domElement.toDataURL('image/png');
	}

	stats() {
		return {
			points: this.points ? this.points.geometry.getAttribute('position').count : 0,
			fps: this._fps,
			colorMode: this._colorMode,
			autoRotate: this._autoRotate,
		};
	}
	onFps(cb) { this._onFps = cb; }

	_settle() {
		this._settleUntil = performance.now() + 600;
		this._needsRender = true;
	}

	dispose() {
		this._disposed = true;
		window.removeEventListener('resize', this._onResize);
		this.controls.dispose();
		if (this.points) this.points.geometry.dispose();
		this.material.dispose();
		this.renderer.dispose();
		if (this.renderer.domElement?.parentNode) {
			this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
		}
	}
}

// ── Synthetic sample cloud ────────────────────────────────────────────────────
// Procedurally exercises the renderer with a recognisable interior — a floor,
// two walls, and a centre object — in monochrome greys. Clearly synthetic, not a
// real capture; mirrors the labelled-sample convention used by the splat viewer.
export function sampleRoomCloud(count = 90_000) {
	const positions = new Float32Array(count * 3);
	const colors = new Float32Array(count * 3);
	const c = new Color();
	let i = 0;
	const put = (x, y, z, shade) => {
		positions[i * 3] = x; positions[i * 3 + 1] = y; positions[i * 3 + 2] = z;
		c.setHSL(0, 0, shade);
		colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
		i++;
	};
	const rnd = (seed) => {
		const s = Math.sin(seed * 12.9898) * 43758.5453;
		return s - Math.floor(s);
	};
	for (let k = 0; k < count; k++) {
		const r = rnd(k + 1);
		const region = rnd(k * 1.7 + 3);
		const jitter = (rnd(k * 2.3 + 7) - 0.5) * 0.04;
		if (region < 0.34) {
			put((rnd(k * 3.1 + 1) - 0.5) * 4, -1 + jitter, (rnd(k * 4.7 + 2) - 0.5) * 4, 0.22 + r * 0.12);
		} else if (region < 0.56) {
			put((rnd(k * 5.3 + 4) - 0.5) * 4, (rnd(k * 6.1 + 5)) * 2.4 - 1, -2 + jitter, 0.38 + r * 0.14);
		} else if (region < 0.78) {
			put(-2 + jitter, (rnd(k * 7.9 + 6)) * 2.4 - 1, (rnd(k * 8.3 + 7) - 0.5) * 4, 0.32 + r * 0.14);
		} else {
			const t = rnd(k * 9.1 + 8);
			const theta = rnd(k * 10.7 + 9) * Math.PI * 2;
			const rad = 0.5 + 0.12 * Math.sin(t * 9);
			put(Math.cos(theta) * rad, t * 1.8 - 1, Math.sin(theta) * rad - 0.2, 0.55 + r * 0.2);
		}
	}
	return { positions, colors, count: i };
}
