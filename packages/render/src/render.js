/**
 * The render loop: framing, lighting, passes, resolve.
 * ---------------------------------------------------
 * Frames are supersampled, drawn opaque-first with a depth-tested
 * back-to-front transparent pass, given a planar projected contact shadow, and
 * resolved through an ACES tonemap into straight-alpha RGBA. The default
 * framing matches the three.ws OG card (26 degrees of yaw, 1.22 margin) so a
 * CPU render and a browser render of the same avatar are the same picture.
 */

import './env-shim.js';
import * as THREE from 'three';
import { Framebuffer, drawTriangle, V_STRIDE, linearToSrgb, tonemap } from './raster.js';

const DEG = Math.PI / 180;

export const PRESETS = {
	studio: {
		ambient: [0.16, 0.17, 0.2],
		lights: [
			{ dir: [-0.45, 0.72, 0.85], color: [1.05, 1.02, 0.98], specular: 0.35, wrap: 0 },
			{ dir: [0.8, 0.25, 0.35], color: [0.3, 0.33, 0.42], specular: 0.08, wrap: 0.5 },
			{ dir: [0.1, -0.4, -0.9], color: [0.14, 0.15, 0.2], specular: 0, wrap: 0.8 },
		],
		rimStrength: 0.32,
		rimColor: [0.55, 0.72, 1],
		background: ['#11131c', '#05060a'],
		shadow: 0.55,
	},
	terminal: {
		ambient: [0.2, 0.21, 0.26],
		lights: [
			{ dir: [-0.4, 0.7, 0.9], color: [1.15, 1.12, 1.05], specular: 0.3, wrap: 0 },
			{ dir: [0.85, 0.2, 0.2], color: [0.28, 0.34, 0.5], specular: 0.05, wrap: 0.6 },
		],
		rimStrength: 0.55,
		rimColor: [0.35, 0.85, 1],
		background: 'transparent',
		shadow: 0.4,
	},
	daylight: {
		ambient: [0.3, 0.32, 0.36],
		lights: [
			{ dir: [-0.3, 0.85, 0.6], color: [1.1, 1.06, 0.96], specular: 0.4, wrap: 0 },
			{ dir: [0.7, 0.1, -0.5], color: [0.3, 0.36, 0.45], specular: 0.05, wrap: 0.5 },
		],
		rimStrength: 0.18,
		rimColor: [1, 0.96, 0.9],
		background: ['#eef2f8', '#cfd8e6'],
		shadow: 0.5,
	},
};

export const FOCUS = {
	full: { fit: 'all', offset: 0, margin: 1.22 },
	bust: { fit: 'upper', offset: 0, margin: 1.12 },
	head: { fit: 'head', offset: 0, margin: 1.05 },
};

function normalize(v) {
	const len = Math.hypot(v[0], v[1], v[2]) || 1;
	return [v[0] / len, v[1] / len, v[2] / len];
}

function parseColor(value) {
	if (typeof value !== 'string') return [0, 0, 0];
	const hex = value.replace('#', '').trim();
	const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
	const n = Number.parseInt(full.slice(0, 6), 16);
	if (!Number.isFinite(n)) return [0, 0, 0];
	const srgb = [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
	return srgb.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
}

/** Frame a camera on the model according to the focus mode. */
export function frameCamera(bounds, { focus = 'full', yaw = 26, pitch = 6, fov = 30, aspect = 1, margin } = {}) {
	const mode = FOCUS[focus] || FOCUS.full;
	const [minX, minY, minZ] = bounds.min;
	const [maxX, maxY, maxZ] = bounds.max;
	const height = maxY - minY;

	let targetY = (minY + maxY) / 2;
	let fitHeight = height;
	let fitWidth = Math.max(maxX - minX, maxZ - minZ);
	if (mode.fit === 'head') {
		// The top ~13% of a humanoid is the head; framing off the bounding box
		// beats guessing a bone, and it works on non-humanoid bodies too.
		fitHeight = height * 0.18;
		targetY = maxY - fitHeight * 0.52;
		fitWidth = fitHeight * 0.9;
	} else if (mode.fit === 'upper') {
		fitHeight = height * 0.42;
		targetY = maxY - fitHeight * 0.5;
		fitWidth = Math.min(fitWidth, fitHeight * 1.1);
	}

	const useMargin = margin ?? mode.margin;
	const vFov = fov * DEG;
	const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
	const distV = fitHeight / 2 / Math.tan(vFov / 2);
	const distH = fitWidth / 2 / Math.tan(hFov / 2);
	const distance = Math.max(distV, distH) * useMargin;

	const yr = yaw * DEG;
	const pr = pitch * DEG;
	const eye = [
		Math.sin(yr) * Math.cos(pr) * distance,
		targetY + Math.sin(pr) * distance,
		Math.cos(yr) * Math.cos(pr) * distance,
	];
	const target = [0, targetY, 0];
	const centerX = (minX + maxX) / 2;
	const centerZ = (minZ + maxZ) / 2;
	eye[0] += centerX;
	eye[2] += centerZ;
	target[0] = centerX;
	target[2] = centerZ;

	const camera = new THREE.PerspectiveCamera(fov, aspect, Math.max(0.01, distance - fitHeight * 4), distance + fitHeight * 8);
	camera.position.set(eye[0], eye[1], eye[2]);
	camera.up.set(0, 1, 0);
	camera.lookAt(target[0], target[1], target[2]);
	camera.updateMatrixWorld(true);
	camera.updateProjectionMatrix();

	const viewProjection = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
	return { camera, viewProjection, eye, target, distance };
}

function fillShadowTriangle(shadow, width, height, x0, y0, x1, y1, x2, y2) {
	const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
	if (!Number.isFinite(area) || Math.abs(area) < 1e-6) return;
	const invArea = 1 / area;
	const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
	const maxX = Math.min(width - 1, Math.ceil(Math.max(x0, x1, x2)));
	const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
	const maxY = Math.min(height - 1, Math.ceil(Math.max(y0, y1, y2)));
	for (let py = minY; py <= maxY; py++) {
		const pyc = py + 0.5;
		for (let px = minX; px <= maxX; px++) {
			const pxc = px + 0.5;
			const w0 = ((x1 - pxc) * (y2 - pyc) - (x2 - pxc) * (y1 - pyc)) * invArea;
			if (w0 < 0) continue;
			const w1 = ((x2 - pxc) * (y0 - pyc) - (x0 - pxc) * (y2 - pyc)) * invArea;
			if (w1 < 0) continue;
			if (1 - w0 - w1 < 0) continue;
			shadow[py * width + px] = 1;
		}
	}
}

function blur(buffer, width, height, radius) {
	if (radius < 1) return buffer;
	const temp = new Float32Array(buffer.length);
	const window = radius * 2 + 1;
	for (let y = 0; y < height; y++) {
		let sum = 0;
		for (let x = -radius; x <= radius; x++) sum += buffer[y * width + Math.max(0, Math.min(width - 1, x))];
		for (let x = 0; x < width; x++) {
			temp[y * width + x] = sum / window;
			const outIdx = Math.max(0, Math.min(width - 1, x - radius));
			const inIdx = Math.max(0, Math.min(width - 1, x + radius + 1));
			sum += buffer[y * width + inIdx] - buffer[y * width + outIdx];
		}
	}
	for (let x = 0; x < width; x++) {
		let sum = 0;
		for (let y = -radius; y <= radius; y++) sum += temp[Math.max(0, Math.min(height - 1, y)) * width + x];
		for (let y = 0; y < height; y++) {
			buffer[y * width + x] = sum / window;
			const outIdx = Math.max(0, Math.min(height - 1, y - radius));
			const inIdx = Math.max(0, Math.min(height - 1, y + radius + 1));
			sum += temp[inIdx * width + x] - temp[outIdx * width + x];
		}
	}
	return buffer;
}

function packVertex(out, world, normals, uv, colors, index, matrix) {
	const i3 = index * 3;
	const x = world[i3];
	const y = world[i3 + 1];
	const z = world[i3 + 2];
	out[0] = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
	out[1] = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
	out[2] = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
	out[3] = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
	out[4] = x;
	out[5] = y;
	out[6] = z;
	out[7] = normals[i3];
	out[8] = normals[i3 + 1];
	out[9] = normals[i3 + 2];
	if (uv) {
		out[10] = uv.getX(index);
		out[11] = uv.getY(index);
	} else {
		out[10] = 0;
		out[11] = 0;
	}
	if (colors) {
		out[12] = colors.getX(index);
		out[13] = colors.getY(index);
		out[14] = colors.getZ(index);
	} else {
		out[12] = 1;
		out[13] = 1;
		out[14] = 1;
	}
	return out;
}

/**
 * Render the model's current pose to straight-alpha RGBA.
 * @returns {{width:number,height:number,data:Uint8ClampedArray}}
 */
export function renderFrame(model, options = {}) {
	const {
		width = 512,
		height = 512,
		supersample = 2,
		preset = 'studio',
		yaw = 26,
		pitch = 6,
		fov = 30,
		focus = 'full',
		margin,
		background,
		shadow: shadowOpt,
	} = options;

	const style = { ...(PRESETS[preset] || PRESETS.studio) };
	const bg = background === undefined ? style.background : background;
	const shadowStrength = shadowOpt === undefined ? style.shadow : shadowOpt;

	const ss = Math.max(1, Math.min(4, Math.round(supersample)));
	const w = width * ss;
	const h = height * ss;
	const fb = new Framebuffer(w, h);

	const meshes = model.skin();
	const bounds = model.bounds;
	const { viewProjection, eye } = frameCamera(bounds, { focus, yaw, pitch, fov, aspect: width / height, margin });
	const vp = viewProjection.elements;

	const lights = style.lights.map((l) => ({ ...l, dir: normalize(l.dir) }));
	const ctx = {
		lights,
		ambient: style.ambient,
		cameraPos: eye,
		rimStrength: style.rimStrength,
		rimColor: style.rimColor,
		texel: new Float32Array(4),
		depthWrite: true,
		blend: false,
	};

	// Contact shadow: the same triangles flattened onto the floor plane and
	// pushed through the same camera, then blurred. No shadow map, no GPU.
	if (shadowStrength > 0) {
		const groundY = bounds.min[1];
		const lightDir = lights[0].dir;
		const sx = new Float64Array(3);
		const sy = new Float64Array(3);
		for (const entry of meshes) {
			const index = entry.geometry.index;
			const world = entry.world;
			for (const group of entry.groups) {
				if (group.material.alphaMode === 'BLEND') continue;
				const start = group.start || 0;
				const count = Math.min(group.count, (index ? index.count : world.length / 3) - start);
				for (let t = 0; t < count; t += 3) {
					let ok = true;
					for (let k = 0; k < 3; k++) {
						const vi = index ? index.getX(start + t + k) : start + t + k;
						const px = world[vi * 3];
						const py = world[vi * 3 + 1];
						const pz = world[vi * 3 + 2];
						const drop = lightDir[1] > 0.05 ? (py - groundY) / lightDir[1] : 0;
						const gx = px - lightDir[0] * drop;
						const gz = pz - lightDir[2] * drop;
						const cw = vp[3] * gx + vp[7] * groundY + vp[11] * gz + vp[15];
						if (cw <= 1e-4) {
							ok = false;
							break;
						}
						const cx = vp[0] * gx + vp[4] * groundY + vp[8] * gz + vp[12];
						const cy = vp[1] * gx + vp[5] * groundY + vp[9] * gz + vp[13];
						sx[k] = (cx / cw * 0.5 + 0.5) * w;
						sy[k] = (0.5 - cy / cw * 0.5) * h;
					}
					if (ok) fillShadowTriangle(fb.shadow, w, h, sx[0], sy[0], sx[1], sy[1], sx[2], sy[2]);
				}
			}
		}
		blur(fb.shadow, w, h, Math.max(1, Math.round(Math.min(w, h) * 0.012)));
	}

	// Background, with the shadow multiplied in underneath the model.
	const transparent = paintBackground(fb, bg, shadowStrength);

	const opaque = [];
	const blended = [];
	for (const entry of meshes) {
		for (const group of entry.groups) {
			(group.material.alphaMode === 'BLEND' ? blended : opaque).push({ entry, group });
		}
	}

	const vertexA = new Float32Array(V_STRIDE);
	const vertexB = new Float32Array(V_STRIDE);
	const vertexC = new Float32Array(V_STRIDE);
	const tri = [vertexA, vertexB, vertexC];

	const drawGroups = (list) => {
		for (const { entry, group } of list) {
			const geometry = entry.geometry;
			const index = geometry.index;
			const uv = group.material.mips ? geometry.attributes.uv || geometry.attributes.uv1 : null;
			const colors = geometry.attributes.color || null;
			const material = { ...group.material, hasVertexColor: Boolean(colors) };
			const total = index ? index.count : geometry.attributes.position.count;
			const start = group.start || 0;
			const count = Math.min(group.count, total - start);
			for (let t = 0; t + 2 < count; t += 3) {
				const i0 = index ? index.getX(start + t) : start + t;
				const i1 = index ? index.getX(start + t + 1) : start + t + 1;
				const i2 = index ? index.getX(start + t + 2) : start + t + 2;
				packVertex(vertexA, entry.world, entry.normals, uv, colors, i0, vp);
				packVertex(vertexB, entry.world, entry.normals, uv, colors, i1, vp);
				packVertex(vertexC, entry.world, entry.normals, uv, colors, i2, vp);
				drawTriangle(fb, tri, material, ctx);
			}
		}
	};

	drawGroups(opaque);

	if (blended.length) {
		// Depth-tested, no depth write, far to near by group centroid.
		ctx.depthWrite = false;
		ctx.blend = true;
		blended.sort((a, b) => centroidDepth(b, vp) - centroidDepth(a, vp));
		drawGroups(blended);
		ctx.depthWrite = true;
		ctx.blend = false;
	}

	return resolve(fb, width, height, ss, transparent);
}

/**
 * Paint the backdrop and multiply the contact shadow into it.
 * Accepts `'transparent'`, a hex string, a `[top, bottom]` vertical gradient,
 * or `{ inner, outer }` for the radial stage the thumbnail pipeline uses.
 * @returns {boolean} whether the frame keeps its alpha channel.
 */
function paintBackground(fb, bg, shadowStrength) {
	const { width: w, height: h } = fb;
	const transparent = bg === 'transparent' || bg === null || bg === undefined;
	const radial = !transparent && !Array.isArray(bg) && typeof bg === 'object' && bg !== null;
	let topColor = [0, 0, 0];
	let bottomColor = [0, 0, 0];
	if (!transparent) {
		if (radial) {
			topColor = parseColor(bg.inner);
			bottomColor = parseColor(bg.outer ?? bg.inner);
		} else if (Array.isArray(bg)) {
			topColor = parseColor(bg[0]);
			bottomColor = parseColor(bg[1] ?? bg[0]);
		} else {
			topColor = parseColor(bg);
			bottomColor = topColor;
		}
	}
	const cx = (w - 1) / 2;
	const cy = (h - 1) / 2;
	const maxRadius = Math.hypot(cx, cy) || 1;
	for (let y = 0; y < h; y++) {
		const linearT = h > 1 ? y / (h - 1) : 0;
		for (let x = 0; x < w; x++) {
			const idx = y * w + x;
			const t = radial ? Math.min(1, Math.hypot(x - cx, y - cy) / maxRadius) : linearT;
			const r = topColor[0] + (bottomColor[0] - topColor[0]) * t;
			const g = topColor[1] + (bottomColor[1] - topColor[1]) * t;
			const b = topColor[2] + (bottomColor[2] - topColor[2]) * t;
			const occlusion = 1 - Math.min(1, fb.shadow[idx] * shadowStrength);
			const ci = idx * 3;
			fb.color[ci] = r * occlusion;
			fb.color[ci + 1] = g * occlusion;
			fb.color[ci + 2] = b * occlusion;
			fb.alpha[idx] = transparent ? Math.min(1, fb.shadow[idx] * shadowStrength) : 1;
		}
	}
	return transparent;
}

function centroidDepth({ entry }, vp) {
	const world = entry.world;
	if (!world.length) return 0;
	let x = 0;
	let y = 0;
	let z = 0;
	const step = Math.max(3, Math.floor(world.length / 96 / 3) * 3);
	let n = 0;
	for (let i = 0; i < world.length; i += step) {
		x += world[i];
		y += world[i + 1];
		z += world[i + 2];
		n++;
	}
	if (!n) return 0;
	x /= n;
	y /= n;
	z /= n;
	const cw = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];
	const cz = vp[2] * x + vp[6] * y + vp[10] * z + vp[14];
	return cw > 1e-6 ? cz / cw : Infinity;
}

function resolve(fb, width, height, ss, transparent) {
	const data = new Uint8ClampedArray(width * height * 4);
	const samples = ss * ss;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			let r = 0;
			let g = 0;
			let b = 0;
			let a = 0;
			for (let sy = 0; sy < ss; sy++) {
				const row = (y * ss + sy) * fb.width;
				for (let sx = 0; sx < ss; sx++) {
					const idx = row + x * ss + sx;
					const alpha = fb.alpha[idx];
					const ci = idx * 3;
					r += fb.color[ci] * alpha;
					g += fb.color[ci + 1] * alpha;
					b += fb.color[ci + 2] * alpha;
					a += alpha;
				}
			}
			const o = (y * width + x) * 4;
			if (a <= 1e-6) {
				data[o] = 0;
				data[o + 1] = 0;
				data[o + 2] = 0;
				data[o + 3] = 0;
				continue;
			}
			// Straight alpha: un-premultiply after the box filter so edge pixels
			// keep their colour instead of fading toward black.
			const inv = 1 / a;
			data[o] = linearToSrgb(tonemap(r * inv));
			data[o + 1] = linearToSrgb(tonemap(g * inv));
			data[o + 2] = linearToSrgb(tonemap(b * inv));
			data[o + 3] = transparent ? Math.round(Math.min(1, a / samples) * 255) : 255;
		}
	}
	return { width, height, data };
}

/** Render an animated turntable or clip playback as a list of RGBA frames. */
export async function renderFrames(model, options = {}) {
	const { frames = 1, fps = 24, spin = 0, clip = null, startTime = 0, onFrame, yaw = 26 } = options;
	if (clip !== null) model.play(clip);
	const duration = model.duration;
	const out = [];
	for (let i = 0; i < frames; i++) {
		const t = startTime + i / fps;
		model.setTime(duration > 0 ? t % duration : t);
		const frameYaw = yaw + (spin ? (i / frames) * spin : 0);
		const frame = renderFrame(model, { ...options, yaw: frameYaw });
		out.push(frame);
		if (onFrame) await onFrame(frame, i, frames);
	}
	return out;
}
