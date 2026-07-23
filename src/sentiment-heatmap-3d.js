// sentiment-heatmap-3d.js — the live 3D market-sentiment field.
//
// A three.js scene of glowing pillars on a dark grid. Each pillar is one token:
//   • colour   = 24h momentum (cold blue → slate → green-hot), via momentumColor
//   • height   = 24h volume magnitude (log-normalised)
//   • glow     = |momentum| + magnitude (emissive intensity), bloomed
// $THREE is pinned at the centre, taller and wider, with a floating label. The
// camera drifts slowly around the field; values lerp toward their targets every
// frame so updates breathe in rather than pop. Bloom post-processing gives the
// movers their flare; if the post-processing addons are unavailable the scene
// falls back to a plain (still-emissive) render, never a black canvas.
//
// The renderer is pure presentation: it takes already-normalised tokens
// ({ id, label, momentum, magnitude, … }) from sentiment-heatmap-data.js and
// owns no network or business logic. Hover/focus are surfaced via callbacks so
// the host (agent-screen) positions the HTML tooltip.

import {
	Scene,
	PerspectiveCamera,
	WebGLRenderer,
	Color,
	Group,
	Mesh,
	BoxGeometry,
	PlaneGeometry,
	MeshStandardMaterial,
	AmbientLight,
	DirectionalLight,
	PointLight,
	Vector2,
	Vector3,
	Raycaster,
	GridHelper,
	Sprite,
	SpriteMaterial,
	CanvasTexture,
} from 'three';
import { momentumColor, glowIntensity } from './sentiment-heatmap-data.js';
import { applyCinematicDefaults, detectQualityTier, loadEnvironment } from './shared/cinematic-render.js';

const SPACING = 1.55; // grid cell spacing
const BASE_H = 0.18; // minimum pillar height (so a flat token still has presence)
const MAX_H = 2.6; // tallest non-anchor pillar
const TILE_W = 1.05; // pillar footprint
const LERP = 0.12; // per-frame approach toward target values

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const lerp = (a, b, t) => a + (b - a) * t;

// Square-ish grid cells ordered by distance from centre, so the loudest tokens
// (assigned first) cluster around the anchor.
function gridCells(n) {
	const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
	const rows = Math.max(1, Math.ceil(n / cols));
	const cells = [];
	for (let r = 0; r < rows; r++) {
		for (let c = 0; c < cols; c++) {
			const x = (c - (cols - 1) / 2) * SPACING;
			const z = (r - (rows - 1) / 2) * SPACING;
			cells.push({ x, z, dist: Math.hypot(x, z) });
		}
	}
	cells.sort((a, b) => a.dist - b.dist);
	return cells;
}

function labelSprite(text) {
	const pad = 24;
	const canvas = document.createElement('canvas');
	const ctx = canvas.getContext('2d');
	ctx.font = '600 64px system-ui, -apple-system, sans-serif';
	const w = Math.ceil(ctx.measureText(text).width) + pad * 2;
	canvas.width = w;
	canvas.height = 96;
	const c2 = canvas.getContext('2d');
	c2.font = '600 64px system-ui, -apple-system, sans-serif';
	c2.textBaseline = 'middle';
	c2.textAlign = 'center';
	c2.fillStyle = 'rgba(0,0,0,0.55)';
	c2.fillRect(0, 0, w, 96);
	c2.fillStyle = '#ffffff';
	c2.fillText(text, w / 2, 52);
	const tex = new CanvasTexture(canvas);
	tex.anisotropy = 4;
	const mat = new SpriteMaterial({ map: tex, transparent: true, depthTest: false });
	const sprite = new Sprite(mat);
	sprite.scale.set((w / 96) * 0.62, 0.62, 1);
	return sprite;
}

export class SentimentHeatmap3D {
	constructor(canvas, { onHover } = {}) {
		this.canvas = canvas;
		this.onHover = onHover || null;
		this.tiles = new Map(); // id → tile state
		this.raf = null;
		this.angle = 0.6;
		this.drift = true;
		this.focusT = 0; // 0..1 focus-on-$THREE zoom amount
		this.focusTarget = 0;
		this.disposed = false;
		this.pointer = new Vector2(-2, -2);
		this.hoverId = null;
		this.anchorPos = new Vector3(0, 0, 0);

		const renderer = new WebGLRenderer({
			canvas,
			antialias: true,
			alpha: true,
			preserveDrawingBuffer: true, // required for toDataURL frame capture
		});
		// Shared cinematic bar: ACES tone mapping + sRGB output + tiered pixel
		// ratio cap. Pillars use MeshStandardMaterial (roughness/metalness),
		// so a real HDRI below gives them genuine specular reflections, not
		// just flat emissive glow.
		const tier = detectQualityTier();
		applyCinematicDefaults(renderer, { tier });
		renderer.setClearColor(0x05060a, 1);
		this.renderer = renderer;

		const scene = new Scene();
		this.scene = scene;
		loadEnvironment(renderer, scene, tier === 'mobile' ? null : 'sunset');

		const camera = new PerspectiveCamera(46, 1, 0.1, 100);
		camera.position.set(0, 7, 11);
		camera.lookAt(0, 0.6, 0);
		this.camera = camera;

		scene.add(new AmbientLight(0x404a66, 0.8));
		const key = new DirectionalLight(0xaab4ff, 0.7);
		key.position.set(4, 9, 6);
		scene.add(key);
		const fill = new PointLight(0x3a4cff, 0.5, 40);
		fill.position.set(-6, 5, -4);
		scene.add(fill);

		// Dark reflective ground + faint grid for depth.
		const ground = new Mesh(
			new PlaneGeometry(60, 60),
			new MeshStandardMaterial({ color: 0x070810, roughness: 0.55, metalness: 0.4 }),
		);
		ground.rotation.x = -Math.PI / 2;
		ground.position.y = -0.01;
		scene.add(ground);
		const grid = new GridHelper(48, 48, 0x1a2240, 0x0e1430);
		grid.position.y = 0;
		grid.material.transparent = true;
		grid.material.opacity = 0.5;
		scene.add(grid);

		this.field = new Group();
		scene.add(this.field);

		this.raycaster = new Raycaster();

		// Optional bloom — the flare that makes movers pop. Loaded lazily so a
		// missing addon degrades to a plain render instead of breaking the panel.
		this.composer = null;
		this._initBloom();

		this._onPointerMove = (e) => {
			const r = canvas.getBoundingClientRect();
			this.pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
			this.pointer.y = -((e.clientY - r.top) / r.height) * 2 + 1;
			this._lastClientX = e.clientX;
			this._lastClientY = e.clientY;
		};
		this._onPointerLeave = () => {
			this.pointer.set(-2, -2);
			if (this.hoverId) { this.hoverId = null; this.onHover?.(null); }
		};
		canvas.addEventListener('pointermove', this._onPointerMove);
		canvas.addEventListener('pointerleave', this._onPointerLeave);

		this._loop = this._loop.bind(this);
		this.raf = requestAnimationFrame(this._loop);
	}

	async _initBloom() {
		try {
			const [{ EffectComposer }, { RenderPass }, { UnrealBloomPass }, { OutputPass }] = await Promise.all([
				import('three/addons/postprocessing/EffectComposer.js'),
				import('three/addons/postprocessing/RenderPass.js'),
				import('three/addons/postprocessing/UnrealBloomPass.js'),
				import('three/addons/postprocessing/OutputPass.js'),
			]);
			if (this.disposed) return;
			const composer = new EffectComposer(this.renderer);
			composer.addPass(new RenderPass(this.scene, this.camera));
			const bloom = new UnrealBloomPass(new Vector2(1, 1), 0.9, 0.6, 0.2);
			composer.addPass(bloom);
			composer.addPass(new OutputPass());
			this.bloom = bloom;
			this.composer = composer;
			this._applySize();
		} catch {
			// Plain render path stays in effect — still emissive, just no bloom halo.
			this.composer = null;
		}
	}

	// Loading state: a dim lattice of neutral pillars that shimmer, shown before
	// real data arrives so the panel is never an empty void.
	showLoadingLattice() {
		if (this.tiles.size) return;
		const placeholder = [];
		const cells = gridCells(16);
		for (let i = 0; i < 16; i++) {
			placeholder.push({ id: `__ph_${i}`, label: '', momentum: 0, magnitude: 0.18 + (i % 4) * 0.05, placeholder: true });
		}
		this._render(placeholder, cells);
		this._loading = true;
	}

	setData(tokens) {
		this._loading = false;
		const list = Array.isArray(tokens) ? tokens.slice(0, 48) : [];
		// Anchor first (centre), then by descending magnitude so the busiest
		// tokens take the cells nearest the centre.
		const anchor = list.find((t) => t.featured);
		const rest = list.filter((t) => !t.featured).sort((a, b) => b.magnitude - a.magnitude);
		const ordered = anchor ? [anchor, ...rest] : rest;
		const cells = gridCells(Math.max(1, ordered.length));
		this._render(ordered, cells);
	}

	_render(ordered, cells) {
		const seen = new Set();
		ordered.forEach((tok, i) => {
			const cell = cells[i] || { x: 0, z: 0 };
			seen.add(tok.id);
			const featured = !!tok.featured;
			const targetH = featured
				? BASE_H + MAX_H * 1.25
				: BASE_H + tok.magnitude * MAX_H;
			const col = momentumColor(tok.momentum);
			const targetColor = new Color(col.r, col.g, col.b);
			const targetGlow = tok.placeholder ? 0.15 : glowIntensity(tok.momentum, tok.magnitude) * (featured ? 1.35 : 1);
			const w = featured ? TILE_W * 1.5 : TILE_W;

			let tile = this.tiles.get(tok.id);
			if (!tile) {
				const geo = new BoxGeometry(w, 1, w);
				geo.translate(0, 0.5, 0); // grow upward from the ground
				const mat = new MeshStandardMaterial({
					color: targetColor.clone(),
					emissive: targetColor.clone(),
					emissiveIntensity: 0.2,
					roughness: 0.35,
					metalness: 0.15,
				});
				const mesh = new Mesh(geo, mat);
				mesh.position.set(cell.x, 0, cell.z);
				mesh.scale.y = BASE_H;
				mesh.userData.tokenId = tok.id;
				this.field.add(mesh);
				tile = {
					mesh,
					curH: BASE_H,
					targetH,
					targetColor,
					curColor: targetColor.clone(),
					targetGlow,
					curGlow: 0.2,
					targetX: cell.x,
					targetZ: cell.z,
					token: tok,
					featured,
				};
				if (featured) {
					const sprite = labelSprite(tok.label || '$THREE');
					sprite.position.set(0, 0, 0);
					mesh.add(sprite);
					tile.sprite = sprite;
					this.anchorPos.set(cell.x, 0, cell.z);
				}
				this.tiles.set(tok.id, tile);
			} else {
				tile.targetH = targetH;
				tile.targetColor = targetColor;
				tile.targetGlow = targetGlow;
				tile.targetX = cell.x;
				tile.targetZ = cell.z;
				tile.token = tok;
				if (featured) this.anchorPos.set(cell.x, 0, cell.z);
			}
		});
		// Remove tiles that left the field.
		for (const [id, tile] of this.tiles) {
			if (!seen.has(id)) {
				this.field.remove(tile.mesh);
				tile.mesh.geometry.dispose();
				tile.mesh.material.dispose();
				if (tile.sprite) { tile.sprite.material.map?.dispose(); tile.sprite.material.dispose(); }
				this.tiles.delete(id);
			}
		}
	}

	focusThree() {
		this.focusTarget = this.focusTarget > 0.5 ? 0 : 1;
	}
	setDrift(on) { this.drift = on; }

	_updateHover() {
		if (!this.onHover) return;
		this.raycaster.setFromCamera(this.pointer, this.camera);
		const hits = this.raycaster.intersectObjects(this.field.children, false);
		const hit = hits.find((h) => h.object.userData.tokenId && !String(h.object.userData.tokenId).startsWith('__ph_'));
		const id = hit ? hit.object.userData.tokenId : null;
		if (id !== this.hoverId) {
			this.hoverId = id;
			if (id) {
				const tile = this.tiles.get(id);
				this.onHover?.(tile?.token || null, this._lastClientX, this._lastClientY);
			} else {
				this.onHover?.(null);
			}
		} else if (id) {
			// keep tooltip following the cursor
			const tile = this.tiles.get(id);
			this.onHover?.(tile?.token || null, this._lastClientX, this._lastClientY);
		}
	}

	_loop() {
		if (this.disposed) return;
		this.raf = requestAnimationFrame(this._loop);

		// Camera drift / focus tween.
		this.focusT = lerp(this.focusT, this.focusTarget, 0.08);
		if (this.drift) this.angle += 0.0016;
		const radius = lerp(13, 6.5, this.focusT);
		const height = lerp(7.5, 4.2, this.focusT);
		const cx = lerp(0, this.anchorPos.x, this.focusT);
		const cz = lerp(0, this.anchorPos.z, this.focusT);
		this.camera.position.set(cx + Math.sin(this.angle) * radius, height, cz + Math.cos(this.angle) * radius);
		this.camera.lookAt(cx, lerp(0.6, 1.2, this.focusT), cz);

		const t = performance.now() * 0.001;
		for (const tile of this.tiles.values()) {
			tile.curH = lerp(tile.curH, tile.targetH, LERP);
			tile.mesh.scale.y = tile.curH;
			tile.mesh.position.x = lerp(tile.mesh.position.x, tile.targetX, LERP);
			tile.mesh.position.z = lerp(tile.mesh.position.z, tile.targetZ, LERP);
			tile.curColor.lerp(tile.targetColor, LERP);
			tile.mesh.material.color.copy(tile.curColor);
			tile.mesh.material.emissive.copy(tile.curColor);
			// Loading shimmer + gentle live breathing on the glow.
			const breathe = this._loading
				? 0.5 + 0.5 * Math.sin(t * 2 + tile.mesh.position.x)
				: 1 + 0.06 * Math.sin(t * 1.4 + tile.mesh.position.z);
			tile.curGlow = lerp(tile.curGlow, tile.targetGlow, LERP);
			const hovered = tile.mesh.userData.tokenId === this.hoverId;
			tile.mesh.material.emissiveIntensity = clamp(tile.curGlow * breathe + (hovered ? 0.5 : 0), 0, 2.2);
			if (tile.sprite) tile.sprite.position.y = tile.curH + 0.6;
		}

		this._updateHover();

		if (this.composer) this.composer.render();
		else this.renderer.render(this.scene, this.camera);
	}

	_applySize() {
		const w = this.canvas.clientWidth || 320;
		const h = this.canvas.clientHeight || 240;
		this.renderer.setSize(w, h, false);
		this.camera.aspect = w / Math.max(1, h);
		this.camera.updateProjectionMatrix();
		if (this.composer) this.composer.setSize(w, h);
		if (this.bloom) this.bloom.setSize(w, h);
	}
	resize() { this._applySize(); }

	// Capture the current frame as a compact JPEG data URL for the wall push.
	// Forces a fresh render (preserveDrawingBuffer hands back the live field),
	// then downscales into a 2D canvas so the payload stays well under the
	// push endpoint's size cap regardless of device pixel ratio.
	captureFrame(maxW = 720) {
		if (this.composer) this.composer.render();
		else this.renderer.render(this.scene, this.camera);
		try {
			const sw = this.canvas.width || 1;
			const sh = this.canvas.height || 1;
			const scale = Math.min(1, maxW / sw);
			const w = Math.max(1, Math.round(sw * scale));
			const h = Math.max(1, Math.round(sh * scale));
			const tmp = document.createElement('canvas');
			tmp.width = w;
			tmp.height = h;
			const ctx = tmp.getContext('2d');
			ctx.fillStyle = '#05060a';
			ctx.fillRect(0, 0, w, h);
			ctx.drawImage(this.canvas, 0, 0, w, h);
			return tmp.toDataURL('image/jpeg', 0.82);
		} catch {
			return null;
		}
	}

	dispose() {
		this.disposed = true;
		if (this.raf) cancelAnimationFrame(this.raf);
		this.canvas.removeEventListener('pointermove', this._onPointerMove);
		this.canvas.removeEventListener('pointerleave', this._onPointerLeave);
		for (const tile of this.tiles.values()) {
			tile.mesh.geometry.dispose();
			tile.mesh.material.dispose();
			if (tile.sprite) { tile.sprite.material.map?.dispose(); tile.sprite.material.dispose(); }
		}
		this.tiles.clear();
		this.composer?.dispose?.();
		this.renderer.dispose();
	}
}
