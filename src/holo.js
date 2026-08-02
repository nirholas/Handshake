// Holo Sticker: a real-time holographic foil sticker rendered with physical
// materials, born from the die-cut sticker aesthetic (black void, iridescent
// foil, one corner peeling up).
//
// Everything on screen is procedural. The mark is rasterized to an offscreen
// 2D canvas, the die-cut base is that raster dilated by a disc (which is what
// a real sticker cutter does), and both outlines are vectorized back into
// THREE.Shape contours with a marching-squares tracer, so any mark, including
// arbitrary text typed into the panel, becomes a correctly cut sticker with
// rounded corners, notches between islands, and holes inside letters.
//
// The peel is a vertex-shader cylinder roll injected into MeshPhysicalMaterial
// via onBeforeCompile: geometry past a fold line wraps around a virtual
// cylinder, normals rotate with it, so the lighting on the curled lip is real.

import * as THREE from 'three';

const $ = (id) => document.getElementById(id);

/* ── mark rasterization ─────────────────────────────────────────────── */

const RASTER = 640; // offscreen raster resolution, px

function makeCanvas(size) {
	const c = document.createElement('canvas');
	c.width = c.height = size;
	return c;
}

// The chevron mark: three skewed bars stacked like the Solana logomark. All
// slants are 45 degrees so the die-cut notches between bars come out crisp.
function drawChevronMark(ctx, size) {
	const h = size * 0.148; // bar height
	const g = size * 0.082; // gap between bars
	const s = h; // 45 degree skew
	const w = size * 0.62; // long-edge length
	const totalW = w + s;
	const totalH = 3 * h + 2 * g;
	const x0 = (size - totalW) / 2;
	const y0 = (size - totalH) / 2;
	const corner = size * 0.018;

	// Top and bottom bars skew one way, the middle bar mirrors them.
	const bar = (yTop, flip) => {
		const yBot = yTop + h;
		return flip
			? [[x0, yTop], [x0 + w, yTop], [x0 + w + s, yBot], [x0 + s, yBot]]
			: [[x0 + s, yTop], [x0 + s + w, yTop], [x0 + w, yBot], [x0, yBot]];
	};
	const bars = [bar(y0, false), bar(y0 + h + g, true), bar(y0 + 2 * (h + g), false)];

	ctx.fillStyle = '#fff';
	ctx.strokeStyle = '#fff';
	ctx.lineJoin = 'round';
	ctx.lineWidth = corner * 2; // round-join stroke rounds the corners
	for (const pts of bars) {
		ctx.beginPath();
		pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
		ctx.closePath();
		ctx.fill();
		ctx.stroke();
	}
}

function drawTextMark(ctx, size, text) {
	const pad = size * 0.1;
	let fontSize = size * 0.36;
	const font = (px) => `900 ${px}px Inter, 'Helvetica Neue', Arial, system-ui, sans-serif`;
	ctx.font = font(fontSize);
	const w = ctx.measureText(text).width;
	if (w > size - pad * 2) fontSize *= (size - pad * 2) / w;
	fontSize = Math.max(fontSize, size * 0.06);
	ctx.font = font(fontSize);
	ctx.textAlign = 'center';
	ctx.textBaseline = 'middle';
	ctx.fillStyle = '#fff';
	ctx.fillText(text, size / 2, size / 2 + fontSize * 0.04);
}

// Dilate the mark by a disc: stamp the mark image around a circle. This is the
// die-cut margin, and it merges nearby islands exactly like a real cut line.
function dilate(markCanvas, radius) {
	const c = makeCanvas(markCanvas.width);
	const ctx = c.getContext('2d');
	const steps = 48;
	for (let i = 0; i < steps; i++) {
		const a = (i / steps) * Math.PI * 2;
		ctx.drawImage(markCanvas, Math.cos(a) * radius, Math.sin(a) * radius);
	}
	ctx.drawImage(markCanvas, 0, 0);
	return c;
}

/* ── contour tracing (marching squares) ─────────────────────────────── */

// Trace all closed contours of the alpha channel. Returns arrays of [x, y]
// points in canvas pixel coordinates. Saddle cells use a fixed pairing so
// every edge midpoint has degree exactly 2 and loop stitching cannot fork.
function traceContours(canvas) {
	const size = canvas.width;
	const data = canvas.getContext('2d').getImageData(0, 0, size, size).data;
	const pad = 2;
	const W = size + pad * 2;
	const grid = new Uint8Array(W * W);
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			if (data[(y * size + x) * 4 + 3] > 127) grid[(y + pad) * W + (x + pad)] = 1;
		}
	}
	const at = (x, y) => grid[y * W + x];

	// Midpoint keys in doubled integer coordinates, per cell (x, y):
	// T = (2x+1, 2y)  R = (2x+2, 2y+1)  B = (2x+1, 2y+2)  L = (2x, 2y+1)
	const T = 0, R = 1, B = 2, L = 3;
	const midKey = (x, y, e) => {
		const mx = e === L ? 2 * x : e === R ? 2 * x + 2 : 2 * x + 1;
		const my = e === T ? 2 * y : e === B ? 2 * y + 2 : 2 * y + 1;
		return my * (2 * W + 2) + mx;
	};
	const SEGS = [
		null, [[L, B]], [[B, R]], [[L, R]],
		[[T, R]], [[T, R], [L, B]], [[T, B]], [[T, L]],
		[[T, L]], [[T, B]], [[T, L], [B, R]], [[T, R]],
		[[L, R]], [[B, R]], [[L, B]], null,
	];

	const segments = [];
	const byPoint = new Map();
	const link = (key, seg) => {
		const list = byPoint.get(key);
		if (list) list.push(seg);
		else byPoint.set(key, [seg]);
	};
	for (let y = 0; y < W - 1; y++) {
		for (let x = 0; x < W - 1; x++) {
			const idx = at(x, y) * 8 + at(x + 1, y) * 4 + at(x + 1, y + 1) * 2 + at(x, y + 1);
			const spec = SEGS[idx];
			if (!spec) continue;
			for (const [e1, e2] of spec) {
				const seg = { a: midKey(x, y, e1), b: midKey(x, y, e2), used: false };
				segments.push(seg);
				link(seg.a, seg);
				link(seg.b, seg);
			}
		}
	}

	const stride = 2 * W + 2;
	const toPoint = (key) => [(key % stride) / 2 - pad, Math.floor(key / stride) / 2 - pad];
	const contours = [];
	for (const start of segments) {
		if (start.used) continue;
		start.used = true;
		const loop = [start.a, start.b];
		let cur = start.b;
		while (cur !== start.a) {
			const next = (byPoint.get(cur) || []).find((s) => !s.used);
			if (!next) break;
			next.used = true;
			cur = next.a === cur ? next.b : next.a;
			loop.push(cur);
		}
		if (loop.length > 8 && cur === start.a) {
			loop.pop();
			contours.push(loop.map(toPoint));
		}
	}
	return contours;
}

// Chaikin corner cutting on a closed loop, then drop near-duplicate points.
function smoothLoop(points, iterations) {
	let pts = points;
	for (let it = 0; it < iterations; it++) {
		const out = [];
		for (let i = 0; i < pts.length; i++) {
			const [ax, ay] = pts[i];
			const [bx, by] = pts[(i + 1) % pts.length];
			out.push([ax * 0.75 + bx * 0.25, ay * 0.75 + by * 0.25]);
			out.push([ax * 0.25 + bx * 0.75, ay * 0.25 + by * 0.75]);
		}
		pts = out;
	}
	const minDist = 1.4;
	const kept = [];
	let last = null;
	for (const p of pts) {
		if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) >= minDist) {
			kept.push(p);
			last = p;
		}
	}
	return kept.length >= 3 ? kept : pts;
}

const signedArea = (pts) => {
	let a = 0;
	for (let i = 0; i < pts.length; i++) {
		const [x1, y1] = pts[i];
		const [x2, y2] = pts[(i + 1) % pts.length];
		a += x1 * y2 - x2 * y1;
	}
	return a / 2;
};

const pointInPoly = ([px, py], pts) => {
	let inside = false;
	for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
		const [xi, yi] = pts[i];
		const [xj, yj] = pts[j];
		if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
	}
	return inside;
};

// Turn traced contours into THREE.Shape objects with holes, in world units.
// transform maps canvas px to world XY (shared by base and mark so they align).
function contoursToShapes(contours, transform) {
	const entries = contours
		.map((pts) => ({ pts, area: Math.abs(signedArea(pts)) }))
		.filter((e) => e.area > 30)
		.sort((a, b) => b.area - a.area);
	for (const e of entries) {
		e.depth = entries.filter((o) => o !== e && o.area > e.area && pointInPoly(e.pts[0], o.pts)).length;
	}
	const toVec = (pts) => pts.map(([x, y]) => new THREE.Vector2(...transform(x, y)));
	const shapes = [];
	for (const e of entries) {
		if (e.depth % 2 !== 0) continue;
		const shape = new THREE.Shape(toVec(e.pts));
		const holes = entries.filter(
			(h) => h.depth === e.depth + 1 && pointInPoly(h.pts[0], e.pts)
		);
		for (const h of holes) shape.holes.push(new THREE.Path(toVec(h.pts)));
		shapes.push(shape);
	}
	return shapes;
}

/* ── sticker build ──────────────────────────────────────────────────── */

const WORLD_W = 3.1; // sticker width in world units
const BASE_DEPTH = 0.028;
const MARK_DEPTH = 0.05;

function buildStickerGeometry(markDraw) {
	const markCanvas = makeCanvas(RASTER);
	markDraw(markCanvas.getContext('2d'), RASTER);
	const baseCanvas = dilate(markCanvas, RASTER * 0.044);

	const baseContours = traceContours(baseCanvas).map((c) => smoothLoop(c, 3));
	const markContours = traceContours(markCanvas).map((c) => smoothLoop(c, 3));
	if (!baseContours.length || !markContours.length) return null;

	let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
	for (const c of baseContours) {
		for (const [x, y] of c) {
			if (x < minX) minX = x;
			if (x > maxX) maxX = x;
			if (y < minY) minY = y;
			if (y > maxY) maxY = y;
		}
	}
	const scale = WORLD_W / (maxX - minX);
	const cx = (minX + maxX) / 2;
	const cy = (minY + maxY) / 2;
	const transform = (x, y) => [(x - cx) * scale, (cy - y) * scale];

	const baseShapes = contoursToShapes(baseContours, transform);
	const markShapes = contoursToShapes(markContours, transform);
	if (!baseShapes.length) return null;

	const base = new THREE.ExtrudeGeometry(baseShapes, {
		depth: BASE_DEPTH,
		bevelEnabled: true,
		bevelThickness: 0.016,
		bevelSize: 0.016,
		bevelSegments: 3,
	});
	const mark = markShapes.length
		? new THREE.ExtrudeGeometry(markShapes, {
			depth: MARK_DEPTH,
			bevelEnabled: true,
			bevelThickness: 0.02,
			bevelSize: 0.02,
			bevelSegments: 4,
		})
		: null;
	if (mark) mark.translate(0, 0, BASE_DEPTH + 0.002);

	const halfH = ((maxY - minY) / 2) * scale;
	return { base, mark, halfW: WORLD_W / 2, halfH };
}

/* ── environment: the light the foil reflects ───────────────────────── */

const FOILS = {
	holo: {
		label: 'Rainbow holo',
		blobs: ['#ff4fd8', '#8a5cff', '#39d98a', '#31c4ff', '#ffd166', '#ff5c7a'],
		color: 0x9aa1a8,
		roughness: 0.16,
		iridescence: 1,
	},
	chrome: {
		label: 'Chrome',
		blobs: ['#cfd6de', '#9fb0c0', '#eef3f8', '#7d8b9a'],
		color: 0xd7dde3,
		roughness: 0.07,
		iridescence: 0.18,
	},
	gold: {
		label: 'Gold foil',
		blobs: ['#ffd166', '#ff9f43', '#fff3c4', '#b98a2f'],
		color: 0xd8ae4e,
		roughness: 0.2,
		iridescence: 0.35,
	},
	neon: {
		label: 'Neon',
		blobs: ['#ff2fd6', '#00e5ff', '#7c4dff', '#00ffa3'],
		color: 0x8f96b3,
		roughness: 0.14,
		iridescence: 1,
	},
};

// Blob placement is fixed, not random, so a reload gives the same sticker.
const BLOB_SEATS = [
	[0.12, 0.3, 0.34], [0.44, 0.62, 0.3], [0.71, 0.24, 0.36], [0.9, 0.66, 0.3],
	[0.28, 0.78, 0.26], [0.6, 0.4, 0.24], [0.05, 0.62, 0.22], [0.82, 0.4, 0.2],
];

function makeEnvTexture(blobColors) {
	const c = document.createElement('canvas');
	c.width = 1024;
	c.height = 512;
	const ctx = c.getContext('2d');
	ctx.fillStyle = '#05060a';
	ctx.fillRect(0, 0, c.width, c.height);
	BLOB_SEATS.forEach(([u, v, r], i) => {
		const color = blobColors[i % blobColors.length];
		const x = u * c.width;
		const y = v * c.height;
		const rad = r * c.height;
		const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
		g.addColorStop(0, color);
		g.addColorStop(1, 'rgba(0,0,0,0)');
		ctx.globalAlpha = 0.85;
		ctx.fillStyle = g;
		ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
	});
	// Two soft white streaks: the "softbox" bands that give foil its sheen.
	ctx.globalAlpha = 1;
	for (const [y0, hgt, alpha] of [[0.16, 0.05, 0.9], [0.58, 0.03, 0.65]]) {
		const g = ctx.createLinearGradient(0, (y0 - hgt) * c.height, 0, (y0 + hgt) * c.height);
		g.addColorStop(0, 'rgba(255,255,255,0)');
		g.addColorStop(0.5, `rgba(255,255,255,${alpha})`);
		g.addColorStop(1, 'rgba(255,255,255,0)');
		ctx.fillStyle = g;
		ctx.fillRect(0, (y0 - hgt) * c.height, c.width, hgt * 2 * c.height);
	}
	const tex = new THREE.CanvasTexture(c);
	tex.mapping = THREE.EquirectangularReflectionMapping;
	tex.colorSpace = THREE.SRGBColorSpace;
	return tex;
}

// Fine grain so the foil reads as material, not as a perfect mirror.
function makeGrainTexture() {
	const size = 256;
	const c = makeCanvas(size);
	const ctx = c.getContext('2d');
	const img = ctx.createImageData(size, size);
	for (let i = 0; i < img.data.length; i += 4) {
		const v = 200 + Math.floor(Math.random() * 55);
		img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
		img.data[i + 3] = 255;
	}
	ctx.putImageData(img, 0, 0);
	const tex = new THREE.CanvasTexture(c);
	tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
	tex.repeat.set(1.6, 1.6);
	return tex;
}

/* ── peel: cylinder-roll vertex deformation ─────────────────────────── */

const peelUniforms = {
	uFoldN: { value: new THREE.Vector2(Math.SQRT1_2, Math.SQRT1_2) },
	uFoldT: { value: 1000 },
	uRadius: { value: 0.2 },
	uMaxPhi: { value: Math.PI * 1.22 },
};

function injectPeel(material) {
	material.onBeforeCompile = (shader) => {
		Object.assign(shader.uniforms, peelUniforms);
		shader.vertexShader = shader.vertexShader
			.replace(
				'#include <common>',
				`#include <common>
				uniform vec2 uFoldN;
				uniform float uFoldT;
				uniform float uRadius;
				uniform float uMaxPhi;`
			)
			.replace(
				'#include <beginnormal_vertex>',
				`#include <beginnormal_vertex>
				{
					float tP = dot(position.xy, uFoldN) - uFoldT;
					if (tP > 0.0) {
						float phi = min(tP / uRadius, uMaxPhi);
						float s = sin(phi), c = cos(phi);
						float nn = dot(objectNormal.xy, uFoldN);
						vec2 tang = objectNormal.xy - uFoldN * nn;
						objectNormal.xy = tang + uFoldN * (nn * c - objectNormal.z * s);
						objectNormal.z = nn * s + objectNormal.z * c;
					}
				}`
			)
			.replace(
				'#include <begin_vertex>',
				`#include <begin_vertex>
				{
					float tP = dot(transformed.xy, uFoldN) - uFoldT;
					if (tP > 0.0) {
						float phi = min(tP / uRadius, uMaxPhi);
						float rest = max(tP - uRadius * uMaxPhi, 0.0);
						float s = sin(phi), c = cos(phi);
						float rz = uRadius - transformed.z;
						vec2 atFold = transformed.xy - uFoldN * tP;
						transformed.xy = atFold + uFoldN * (rz * s + rest * c);
						transformed.z = uRadius - rz * c + rest * s;
					}
				}`
			);
	};
	material.customProgramCacheKey = () => 'holo-peel';
	return material;
}

/* ── page wiring ────────────────────────────────────────────────────── */

const MARKS = {
	chevrons: { label: 'Chevrons', draw: drawChevronMark },
	three: { label: '$THREE', draw: (ctx, size) => drawTextMark(ctx, size, '$THREE') },
	threews: { label: 'three.ws', draw: (ctx, size) => drawTextMark(ctx, size, 'three.ws') },
};

const state = {
	mark: 'chevrons',
	customText: '',
	foil: 'holo',
	peel: 0.24,
};

const stage = $('stage');
const canvas = $('holoCanvas');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let renderer;
try {
	renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
	if (!renderer.getContext()) throw new Error('no context');
} catch {
	stage.dataset.state = 'error';
	renderer = null;
}

if (renderer) init(renderer);

function init(renderer) {
	renderer.toneMapping = THREE.ACESFilmicToneMapping;
	renderer.toneMappingExposure = 1.12;
	renderer.setClearColor(0x000000, 1);

	const scene = new THREE.Scene();
	const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 40);
	camera.position.set(0, 0, 7.4);

	const key = new THREE.DirectionalLight(0xffffff, 1.15);
	key.position.set(2.4, 3.2, 4.5);
	scene.add(key);
	const rim = new THREE.DirectionalLight(0x8fb8ff, 0.35);
	rim.position.set(-3, -2, 2.5);
	scene.add(rim);

	const grain = makeGrainTexture();
	const baseMaterial = injectPeel(new THREE.MeshPhysicalMaterial({
		metalness: 1,
		clearcoat: 1,
		clearcoatRoughness: 0.12,
		iridescenceIOR: 1.32,
		iridescenceThicknessRange: [120, 480],
		roughnessMap: grain,
		side: THREE.DoubleSide,
		envMapIntensity: 1.25,
	}));
	const markMaterial = injectPeel(new THREE.MeshPhysicalMaterial({
		metalness: 1,
		clearcoat: 1,
		clearcoatRoughness: 0.18,
		iridescenceIOR: 1.28,
		iridescenceThicknessRange: [160, 620],
		roughnessMap: grain,
		bumpMap: grain,
		bumpScale: 0.35,
		side: THREE.DoubleSide,
		envMapIntensity: 1.4,
	}));

	const group = new THREE.Group();
	scene.add(group);
	let sticker = { halfW: WORLD_W / 2, halfH: WORLD_W / 2 };

	const pmrem = new THREE.PMREMGenerator(renderer);
	const envCache = new Map();
	function applyFoil(name) {
		const foil = FOILS[name];
		if (!envCache.has(name)) {
			const equirect = makeEnvTexture(foil.blobs);
			envCache.set(name, pmrem.fromEquirectangular(equirect).texture);
			equirect.dispose();
		}
		scene.environment = envCache.get(name);
		baseMaterial.color.set(foil.color).multiplyScalar(0.55);
		baseMaterial.roughness = Math.min(foil.roughness + 0.06, 1);
		baseMaterial.iridescence = foil.iridescence;
		markMaterial.color.set(foil.color);
		markMaterial.roughness = foil.roughness;
		markMaterial.iridescence = foil.iridescence;
	}

	function rebuild() {
		const draw = state.mark === 'custom'
			? (ctx, size) => drawTextMark(ctx, size, state.customText)
			: MARKS[state.mark].draw;
		const built = buildStickerGeometry(draw);
		if (!built) return false;
		for (const child of [...group.children]) {
			group.remove(child);
			child.geometry.dispose();
		}
		group.add(new THREE.Mesh(built.base, baseMaterial));
		if (built.mark) group.add(new THREE.Mesh(built.mark, markMaterial));
		sticker = built;
		return true;
	}

	function updatePeel(amount) {
		const cornerT = (sticker.halfW + sticker.halfH) * Math.SQRT1_2;
		peelUniforms.uFoldT.value = amount <= 0.001
			? cornerT + 1
			: cornerT - amount * 1.35;
		peelUniforms.uRadius.value = 0.13 + amount * 0.1;
	}

	/* interaction: pointer tilt with spring, drag for full control */
	const target = { x: 0, y: 0 };
	const current = { x: 0, y: 0 };
	let dragging = false;
	let dragBase = null;
	let interacted = false;

	const markInteracted = () => {
		if (!interacted) {
			interacted = true;
			stage.dataset.hint = 'off';
		}
	};

	stage.addEventListener('pointermove', (e) => {
		const rect = stage.getBoundingClientRect();
		const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
		const ny = ((e.clientY - rect.top) / rect.height) * 2 - 1;
		if (dragging && dragBase) {
			target.y = dragBase.ry + (nx - dragBase.nx) * 2.4;
			target.x = dragBase.rx + (ny - dragBase.ny) * 2.4;
		} else {
			target.y = nx * 0.42;
			target.x = ny * 0.34;
		}
	});
	stage.addEventListener('pointerdown', (e) => {
		markInteracted();
		dragging = true;
		const rect = stage.getBoundingClientRect();
		dragBase = {
			nx: ((e.clientX - rect.left) / rect.width) * 2 - 1,
			ny: ((e.clientY - rect.top) / rect.height) * 2 - 1,
			rx: target.x,
			ry: target.y,
		};
		stage.setPointerCapture(e.pointerId);
	});
	const endDrag = () => {
		dragging = false;
		dragBase = null;
	};
	stage.addEventListener('pointerup', endDrag);
	stage.addEventListener('pointercancel', endDrag);
	stage.addEventListener('pointerleave', () => {
		if (!dragging) target.x = target.y = 0;
	});
	stage.addEventListener('keydown', (e) => {
		const step = 0.12;
		const moves = {
			ArrowLeft: () => (target.y -= step),
			ArrowRight: () => (target.y += step),
			ArrowUp: () => (target.x -= step),
			ArrowDown: () => (target.x += step),
		};
		if (moves[e.key]) {
			e.preventDefault();
			markInteracted();
			moves[e.key]();
			target.x = THREE.MathUtils.clamp(target.x, -1.1, 1.1);
			target.y = THREE.MathUtils.clamp(target.y, -1.1, 1.1);
		}
	});

	function resize() {
		const rect = stage.getBoundingClientRect();
		const w = Math.max(1, Math.round(rect.width));
		const h = Math.max(1, Math.round(rect.height));
		renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
		renderer.setSize(w, h, false);
		camera.aspect = w / h;
		camera.updateProjectionMatrix();
	}
	new ResizeObserver(resize).observe(stage);

	const clock = new THREE.Clock();
	function frame() {
		const t = clock.getElapsedTime();
		const wobble = reducedMotion ? 0 : 1;
		current.x += (target.x - current.x) * 0.09;
		current.y += (target.y - current.y) * 0.09;
		group.rotation.x = current.x + Math.sin(t * 0.5) * 0.03 * wobble;
		group.rotation.y = current.y + Math.sin(t * 0.35) * 0.05 * wobble;
		group.rotation.z = -0.05;
		group.position.y = Math.sin(t * 0.6) * 0.04 * wobble;
		const breathe = reducedMotion ? 0 : Math.sin(t * 0.8) * 0.028;
		updatePeel(THREE.MathUtils.clamp(state.peel + breathe, 0, 1));
		renderer.render(scene, camera);
		requestAnimationFrame(frame);
	}

	/* controls */
	const markChips = $('markChips');
	const customRow = $('customRow');
	const customInput = $('customInput');

	function renderMarkChips() {
		markChips.querySelectorAll('.hs-chip').forEach((b) => {
			b.classList.toggle('is-on', b.dataset.mark === state.mark);
			b.setAttribute('aria-checked', String(b.dataset.mark === state.mark));
		});
		customRow.hidden = state.mark !== 'custom';
	}
	markChips.addEventListener('click', (e) => {
		const btn = e.target.closest('[data-mark]');
		if (!btn) return;
		const mark = btn.dataset.mark;
		if (mark === 'custom') {
			state.mark = 'custom';
			renderMarkChips();
			customInput.focus();
			if (state.customText) rebuild();
			return;
		}
		state.mark = mark;
		renderMarkChips();
		rebuild();
	});
	const applyCustom = () => {
		const text = customInput.value.trim().slice(0, 16);
		if (!text) {
			customInput.setAttribute('aria-invalid', 'true');
			return;
		}
		customInput.removeAttribute('aria-invalid');
		state.mark = 'custom';
		state.customText = text;
		renderMarkChips();
		rebuild();
	};
	$('btnCustom').addEventListener('click', applyCustom);
	customInput.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') applyCustom();
		else customInput.removeAttribute('aria-invalid');
	});

	const foilChips = $('foilChips');
	for (const [id, foil] of Object.entries(FOILS)) {
		const b = document.createElement('button');
		b.type = 'button';
		b.className = 'hs-chip';
		b.dataset.foil = id;
		b.setAttribute('role', 'radio');
		b.textContent = foil.label;
		foilChips.appendChild(b);
	}
	function renderFoilChips() {
		foilChips.querySelectorAll('.hs-chip').forEach((b) => {
			b.classList.toggle('is-on', b.dataset.foil === state.foil);
			b.setAttribute('aria-checked', String(b.dataset.foil === state.foil));
		});
	}
	foilChips.addEventListener('click', (e) => {
		const btn = e.target.closest('[data-foil]');
		if (!btn) return;
		state.foil = btn.dataset.foil;
		renderFoilChips();
		applyFoil(state.foil);
	});

	const peelRange = $('peelRange');
	peelRange.value = String(Math.round(state.peel * 100));
	peelRange.addEventListener('input', () => {
		state.peel = Number(peelRange.value) / 100;
		$('peelVal').textContent = `${peelRange.value}%`;
	});
	$('peelVal').textContent = `${peelRange.value}%`;

	$('btnPng').addEventListener('click', () => {
		renderer.render(scene, camera);
		canvas.toBlob((blob) => {
			if (!blob) return;
			const a = document.createElement('a');
			a.href = URL.createObjectURL(blob);
			a.download = 'holo-sticker.png';
			a.click();
			URL.revokeObjectURL(a.href);
		}, 'image/png');
	});
	$('btnResetView').addEventListener('click', () => {
		target.x = target.y = 0;
		state.peel = 0.24;
		peelRange.value = '24';
		$('peelVal').textContent = '24%';
	});

	/* boot */
	resize();
	applyFoil(state.foil);
	renderMarkChips();
	renderFoilChips();
	if (rebuild()) {
		stage.dataset.state = 'ready';
		frame();
	} else {
		stage.dataset.state = 'error';
	}
}
