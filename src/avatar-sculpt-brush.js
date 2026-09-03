/**
 * Free sculpt: the "change literally anything" guarantee.
 *
 * The morph library and the proportion table cover the shapes MakeHuman
 * authored and the shapes a skeleton can express. Neither can give someone a
 * dent in one temple, a crooked nose bridge, or a brow ridge that exists in no
 * catalogue. This module does: a radius-and-falloff brush that pushes vertices
 * along their own surface normal, recorded as ONE extra morph target on each
 * mesh it touches.
 *
 * Recording it as a morph target rather than editing POSITION is the whole
 * design. It means a free-sculpt edit:
 *   - composes additively with every library slider instead of fighting it,
 *   - survives GLTFExporter untouched (Avatar Studio saves the live scene),
 *   - can be re-applied to the pristine base from a serialized document, which
 *     is what api/_lib/bake-sculpt.js does for the /avatars/:id/edit path,
 *   - is reversible: clearing the target restores the catalogue body exactly.
 *
 * Space matters and is easy to get wrong. Morph deltas live in BIND space, but
 * the user is pointing at a skinned, morphed, proportion-edited body on screen.
 * Every stroke therefore builds the exact per-vertex bind-to-world map
 * (bindMatrixInverse x blended bone matrices x bindMatrix, then the mesh's
 * world matrix), moves the point in world space, and maps the displacement back
 * through the inverse of that map. That map is sampled once per drag, at
 * pointer-down: sculpting is correct for the pose you sculpted on, so the host
 * settles the rig before enabling the brush rather than painting onto a moving
 * target.
 *
 * Symmetry is a mirror of the BRUSH, not of the vertices: the stroke is applied
 * a second time at the point reflected across the avatar's own X = 0 plane. On
 * an asymmetric body that still does the right thing, and turning it off is
 * what makes asymmetry reachable at all.
 */

import { Matrix4, Raycaster, Vector2, Vector3, Float32BufferAttribute } from 'three';
import {
	SCULPT_TARGET_NAME,
	SCULPT_VERSION,
	SCULPT_MAX_VERTS,
	clampDisplacement,
	bytesToBase64,
	decodeSculptMesh,
} from './avatar-sculpt-doc.js';

// Re-exported so a caller that already holds the brush does not need to know
// the document module exists.
export {
	SCULPT_TARGET_NAME,
	SCULPT_VERSION,
	SCULPT_MAX_VERTS,
	SCULPT_MAX_DISPLACEMENT,
	decodeSculptMesh,
	sanitizeSculptDoc,
	sculptVertexCount,
	sculptEqual,
} from './avatar-sculpt-doc.js';

/** Brush defaults, in metres and metres-per-stroke-step. */
export const BRUSH_DEFAULTS = Object.freeze({
	radius: 0.05,
	strength: 0.006,
	direction: 1, // +1 pulls the surface out, -1 pushes it in
	symmetry: true,
});

/** Slider ranges for the brush controls, in the same units. */
export const BRUSH_LIMITS = Object.freeze({
	radius: { min: 0.01, max: 0.3, step: 0.005 },
	strength: { min: 0.001, max: 0.03, step: 0.001 },
});

/* ────────────────────────────────────────────────────────────────────────── *
 * Morph-target plumbing
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * The custom morph attribute for `mesh`, created (zeroed, influence 1) if the
 * mesh does not carry one yet.
 *
 * A mesh with no morphs at all also gets `morphTargetsRelative = true`, because
 * a delta target read as absolute positions collapses the mesh to a point.
 *
 * @param {import('three').Mesh} mesh
 * @returns {import('three').BufferAttribute}
 */
export function ensureSculptTarget(mesh) {
	const geo = mesh.geometry;
	if (!geo?.attributes?.position) return null;

	geo.morphAttributes = geo.morphAttributes || {};
	const list = (geo.morphAttributes.position = geo.morphAttributes.position || []);
	mesh.morphTargetDictionary = mesh.morphTargetDictionary || {};
	mesh.morphTargetInfluences = mesh.morphTargetInfluences || [];

	const existing = mesh.morphTargetDictionary[SCULPT_TARGET_NAME];
	if (existing !== undefined && list[existing]) {
		mesh.morphTargetInfluences[existing] = 1;
		return list[existing];
	}

	if (list.length === 0) geo.morphTargetsRelative = true;
	const attr = new Float32BufferAttribute(new Float32Array(geo.attributes.position.count * 3), 3);
	attr.name = SCULPT_TARGET_NAME;
	const index = list.length;
	list.push(attr);
	mesh.morphTargetDictionary[SCULPT_TARGET_NAME] = index;
	mesh.morphTargetInfluences[index] = 1;
	// The target count is part of the shader's cache key; three rebuilds the
	// morph texture on its own but the program has to be told.
	if (mesh.material) {
		for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
			m.needsUpdate = true;
		}
	}
	return attr;
}

/** The custom morph attribute for `mesh`, or null when it has never been sculpted. */
export function getSculptTarget(mesh) {
	const index = mesh?.morphTargetDictionary?.[SCULPT_TARGET_NAME];
	if (index === undefined) return null;
	return mesh.geometry?.morphAttributes?.position?.[index] || null;
}

/** Every sculptable mesh under `root`, in traversal order. */
export function sculptableMeshes(root) {
	const out = [];
	root?.traverse?.((node) => {
		if (node.isMesh && node.geometry?.attributes?.position) out.push(node);
	});
	return out;
}

/** Zero every custom target under `root`. Returns the number of meshes reset. */
export function clearSculpt(root) {
	let n = 0;
	for (const mesh of sculptableMeshes(root)) {
		const attr = getSculptTarget(mesh);
		if (!attr) continue;
		attr.array.fill(0);
		attr.needsUpdate = true;
		n++;
	}
	return n;
}

/** True when no mesh under `root` carries a non-zero free-sculpt delta. */
export function sculptIsEmpty(root) {
	for (const mesh of sculptableMeshes(root)) {
		const attr = getSculptTarget(mesh);
		if (!attr) continue;
		for (let i = 0; i < attr.array.length; i++) if (attr.array[i] !== 0) return false;
	}
	return true;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Serialization: sparse, quantised, self-describing
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Serialize every non-zero free-sculpt delta under `root` into the document
 * that `appearance.sculpt` carries (specs/PARAMETRIC_AVATAR.md).
 *
 * Sparse because a stroke touches hundreds of vertices out of ~15k, and
 * quantised to int16 because a 0.12 m range at 16 bits resolves to under
 * 4 micrometres, which is four orders of magnitude finer than anything a
 * viewer can see. Together those turn a megabyte of floats into tens of KB of
 * JSON-safe text.
 *
 * @param {object} root three.js Object3D
 * @returns {{version:number, meshes:Record<string, object>}|null} null when nothing is sculpted
 */
export function serializeSculpt(root) {
	const meshes = {};
	for (const mesh of sculptableMeshes(root)) {
		const attr = getSculptTarget(mesh);
		if (!attr) continue;
		const arr = attr.array;

		const indices = [];
		let peak = 0;
		for (let i = 0, n = arr.length / 3; i < n; i++) {
			const x = arr[i * 3];
			const y = arr[i * 3 + 1];
			const z = arr[i * 3 + 2];
			if (x === 0 && y === 0 && z === 0) continue;
			indices.push(i);
			peak = Math.max(peak, Math.abs(x), Math.abs(y), Math.abs(z));
			if (indices.length >= SCULPT_MAX_VERTS) break;
		}
		if (!indices.length || peak === 0) continue;

		const scale = peak / 32767;
		const idx = new Uint32Array(indices);
		const deltas = new Int16Array(indices.length * 3);
		for (let k = 0; k < indices.length; k++) {
			const i = indices[k];
			deltas[k * 3] = Math.round(arr[i * 3] / scale);
			deltas[k * 3 + 1] = Math.round(arr[i * 3 + 1] / scale);
			deltas[k * 3 + 2] = Math.round(arr[i * 3 + 2] / scale);
		}
		meshes[mesh.name || 'Mesh'] = {
			count: indices.length,
			vertexCount: arr.length / 3,
			scale,
			indices: bytesToBase64(new Uint8Array(idx.buffer)),
			deltas: bytesToBase64(new Uint8Array(deltas.buffer)),
		};
	}
	return Object.keys(meshes).length ? { version: SCULPT_VERSION, meshes } : null;
}

/**
 * Re-apply a serialized document to a freshly loaded model. Meshes named in the
 * document that this model does not have (a different base) are skipped, and a
 * vertex index past the end of a mesh is dropped: a sculpt is tied to a
 * topology, and refusing to load the rest of a valid document over one stale
 * entry would be worse than ignoring it.
 *
 * @returns {{applied: string[], skipped: string[]}}
 */
export function applySculptToRoot(root, doc) {
	const applied = [];
	const skipped = [];
	if (!doc || doc.version !== SCULPT_VERSION || !doc.meshes) return { applied, skipped };

	const byName = new Map(sculptableMeshes(root).map((m) => [m.name, m]));
	for (const [name, entry] of Object.entries(doc.meshes)) {
		const mesh = byName.get(name);
		const decoded = decodeSculptMesh(entry);
		if (!mesh || !decoded) {
			skipped.push(name);
			continue;
		}
		const attr = ensureSculptTarget(mesh);
		if (!attr) {
			skipped.push(name);
			continue;
		}
		attr.array.fill(0);
		const limit = attr.array.length / 3;
		for (let k = 0; k < decoded.indices.length; k++) {
			const i = decoded.indices[k];
			if (i >= limit) continue;
			attr.array[i * 3] = decoded.deltas[k * 3];
			attr.array[i * 3 + 1] = decoded.deltas[k * 3 + 1];
			attr.array[i * 3 + 2] = decoded.deltas[k * 3 + 2];
		}
		attr.needsUpdate = true;
		applied.push(name);
	}
	return { applied, skipped };
}

/* ────────────────────────────────────────────────────────────────────────── *
 * The brush
 * ────────────────────────────────────────────────────────────────────────── */

const _ndc = new Vector2();
const _v = new Vector3();
const _n = new Vector3();
const _delta = new Vector3();
const _a = new Vector3();
const _b = new Vector3();
const _skin = new Matrix4();
const _bone = new Matrix4();
const _inv = new Matrix4();
const _rootInv = new Matrix4();

/** Blender-style smooth falloff: 1 at the centre, 0 at the rim, flat at both. */
function falloff(t) {
	const s = 1 - t * t;
	return s * s * s;
}

/**
 * The bind-space-to-world matrix for one vertex of `mesh`, i.e. everything
 * between the morph-target space the deltas live in and the pixels the user is
 * pointing at. For a plain Mesh that is just the world matrix.
 */
function vertexBindToWorld(mesh, index, target) {
	if (!mesh.isSkinnedMesh || !mesh.skeleton) return target.copy(mesh.matrixWorld);

	const skinIndex = mesh.geometry.attributes.skinIndex;
	const skinWeight = mesh.geometry.attributes.skinWeight;
	if (!skinIndex || !skinWeight) return target.copy(mesh.matrixWorld);

	_skin.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
	let total = 0;
	for (let i = 0; i < 4; i++) {
		const w = skinWeight.getComponent(index, i);
		if (w === 0) continue;
		const b = skinIndex.getComponent(index, i);
		const bone = mesh.skeleton.bones[b];
		const inverse = mesh.skeleton.boneInverses[b];
		if (!bone || !inverse) continue;
		_bone.multiplyMatrices(bone.matrixWorld, inverse);
		for (let e = 0; e < 16; e++) _skin.elements[e] += _bone.elements[e] * w;
		total += w;
	}
	if (total === 0) return target.copy(mesh.matrixWorld);

	// bindMatrixInverse x blendedBones x bindMatrix, then out to world.
	target.copy(mesh.bindMatrixInverse).multiply(_skin).multiply(mesh.bindMatrix);
	return target.premultiply(mesh.matrixWorld);
}

/**
 * A free-sculpt brush bound to one canvas, one camera and one model root.
 *
 * Lifecycle: `new SculptBrush(opts)` then `enable()` / `disable()`. While
 * enabled, a pointer press that hits the model sculpts and suppresses the
 * orbit controls for that drag; a press that misses the model orbits as usual,
 * so the camera never becomes unreachable.
 */
export class SculptBrush {
	/**
	 * @param {object} opts
	 * @param {object} opts.root      model root (three.js Object3D)
	 * @param {object} opts.camera
	 * @param {HTMLElement} opts.domElement  the renderer canvas
	 * @param {object} [opts.controls] OrbitControls, suppressed during a stroke
	 * @param {(info: {vertices:number}) => void} [opts.onStroke] after each stroke step
	 * @param {() => void} [opts.onStrokeEnd] after the pointer lifts
	 */
	constructor({ root, camera, domElement, controls = null, onStroke, onStrokeEnd }) {
		this.root = root;
		this.camera = camera;
		this.domElement = domElement;
		this.controls = controls;
		this.onStroke = onStroke;
		this.onStrokeEnd = onStrokeEnd;

		this.params = { ...BRUSH_DEFAULTS };
		this.enabled = false;

		this._raycaster = new Raycaster();
		this._meshes = [];
		this._pointerId = null;
		this._controlsWere = null;
		this._cursor = null;
		this._worldCache = new WeakMap(); // mesh -> Float32Array of world positions
		this._touched = 0;

		this._onDown = this._onDown.bind(this);
		this._onMove = this._onMove.bind(this);
		this._onUp = this._onUp.bind(this);
		this._onLeave = this._onLeave.bind(this);
	}

	setParams(patch) {
		Object.assign(this.params, patch);
		this._syncCursorSize();
	}

	enable() {
		if (this.enabled || !this.domElement) return;
		this.enabled = true;
		this._meshes = sculptableMeshes(this.root);
		this.domElement.addEventListener('pointerdown', this._onDown);
		this.domElement.addEventListener('pointermove', this._onMove);
		this.domElement.addEventListener('pointerleave', this._onLeave);
		window.addEventListener('pointerup', this._onUp);
		this.domElement.style.cursor = 'crosshair';
		this._ensureCursor();
	}

	disable() {
		if (!this.enabled) return;
		this.enabled = false;
		this._endStroke();
		this.domElement.removeEventListener('pointerdown', this._onDown);
		this.domElement.removeEventListener('pointermove', this._onMove);
		this.domElement.removeEventListener('pointerleave', this._onLeave);
		window.removeEventListener('pointerup', this._onUp);
		this.domElement.style.cursor = '';
		this._cursor?.remove();
		this._cursor = null;
	}

	dispose() {
		this.disable();
		this.root = null;
		this._meshes = [];
	}

	/* ── pointer plumbing ──────────────────────────────────────────────── */

	_ndcFrom(event) {
		const rect = this.domElement.getBoundingClientRect();
		_ndc.set(
			((event.clientX - rect.left) / rect.width) * 2 - 1,
			-((event.clientY - rect.top) / rect.height) * 2 + 1,
		);
		return _ndc;
	}

	_hit(event) {
		if (!this._meshes.length) this._meshes = sculptableMeshes(this.root);
		this._raycaster.setFromCamera(this._ndcFrom(event), this.camera);
		const hits = this._raycaster.intersectObjects(this._meshes, false);
		return hits.length ? hits[0] : null;
	}

	_onDown(event) {
		if (!this.enabled || event.button !== 0) return;
		const hit = this._hit(event);
		if (!hit) return; // background press: let the orbit controls have it
		event.preventDefault();
		this._pointerId = event.pointerId;
		this._touched = 0;
		if (this.controls) {
			this._controlsWere = this.controls.enabled;
			this.controls.enabled = false;
		}
		this._worldCache = new WeakMap();
		this.domElement.setPointerCapture?.(event.pointerId);
		this._stroke(hit);
	}

	_onMove(event) {
		if (!this.enabled) return;
		this._moveCursor(event);
		if (this._pointerId === null || event.pointerId !== this._pointerId) return;
		const hit = this._hit(event);
		if (hit) this._stroke(hit);
	}

	_onUp(event) {
		if (this._pointerId === null || event.pointerId !== this._pointerId) return;
		this._endStroke();
	}

	_onLeave() {
		if (this._cursor) this._cursor.style.opacity = '0';
	}

	_endStroke() {
		if (this._pointerId !== null) {
			this.domElement?.releasePointerCapture?.(this._pointerId);
			this._pointerId = null;
			if (this.controls && this._controlsWere !== null) {
				this.controls.enabled = this._controlsWere;
				this._controlsWere = null;
			}
			if (this._touched > 0) this.onStrokeEnd?.();
		}
	}

	/* ── the stroke itself ─────────────────────────────────────────────── */

	/**
	 * Cached skinned+morphed world positions for one mesh. Recomputed at the
	 * start of every drag: the whole point of caching is that the rig does not
	 * move during a stroke, and a stale cache after an animation frame would
	 * sculpt the wrong vertices.
	 */
	_worldPositions(mesh) {
		let cached = this._worldCache.get(mesh);
		if (cached) return cached;
		const count = mesh.geometry.attributes.position.count;
		cached = new Float32Array(count * 3);
		for (let i = 0; i < count; i++) {
			mesh.getVertexPosition(i, _v);
			_v.applyMatrix4(mesh.matrixWorld);
			cached[i * 3] = _v.x;
			cached[i * 3 + 1] = _v.y;
			cached[i * 3 + 2] = _v.z;
		}
		this._worldCache.set(mesh, cached);
		return cached;
	}

	_stroke(hit) {
		const mesh = hit.object;
		if (!mesh?.geometry?.attributes?.position) return;

		let touched = this._applyAt(mesh, hit.point, hit.face);
		if (this.params.symmetry) {
			const mirrored = this._mirrorPoint(hit.point);
			if (mirrored) touched += this._applyAt(mesh, mirrored, hit.face, true);
		}
		if (touched) {
			this._touched += touched;
			this.onStroke?.({ vertices: touched });
		}
	}

	/** Reflect a world point across the model's own X = 0 plane. */
	_mirrorPoint(point) {
		if (!this.root) return null;
		this.root.updateMatrixWorld();
		const local = this.root.worldToLocal(_a.copy(point));
		local.x *= -1;
		return this.root.localToWorld(local).clone();
	}

	/**
	 * Apply one stroke step centred on `center` (world space). Returns the
	 * number of vertices moved.
	 */
	_applyAt(mesh, center, face, mirrored = false) {
		const attr = ensureSculptTarget(mesh);
		if (!attr) return 0;

		const world = this._worldPositions(mesh);
		const positions = mesh.geometry.attributes.position;
		const normals = mesh.geometry.attributes.normal;
		const { radius, strength, direction } = this.params;
		const r2 = radius * radius;

		// Stroke direction: the surface normal at the hit, in world space. The
		// mirrored pass reflects it so both sides bulge outward rather than one
		// pushing in while the other pulls out.
		if (face && normals) {
			_n.fromBufferAttribute(normals, face.a);
			_n.transformDirection(mesh.matrixWorld);
		} else {
			_n.set(0, 0, 1);
		}
		if (mirrored && this.root) {
			// Reflect the direction in the model's own frame: into root space,
			// negate X, back out. transformDirection ignores translation and
			// renormalises, which is exactly what a unit normal wants.
			_rootInv.copy(this.root.matrixWorld).invert();
			_n.transformDirection(_rootInv);
			_n.x *= -1;
			_n.transformDirection(this.root.matrixWorld);
		}

		let moved = 0;
		const count = positions.count;
		for (let i = 0; i < count; i++) {
			const dx = world[i * 3] - center.x;
			const dy = world[i * 3 + 1] - center.y;
			const dz = world[i * 3 + 2] - center.z;
			const d2 = dx * dx + dy * dy + dz * dz;
			if (d2 > r2) continue;

			const w = falloff(Math.sqrt(d2) / radius) * strength * direction;
			if (w === 0) continue;

			// World displacement -> bind-space displacement through the exact
			// inverse of this vertex's own skinning map.
			vertexBindToWorld(mesh, i, _inv);
			_inv.invert();
			_a.set(world[i * 3], world[i * 3 + 1], world[i * 3 + 2]);
			_b.copy(_a).addScaledVector(_n, w);
			_a.applyMatrix4(_inv);
			_b.applyMatrix4(_inv);
			_delta.subVectors(_b, _a);

			const o = i * 3;
			attr.array[o] = clampDisplacement(attr.array[o] + _delta.x);
			attr.array[o + 1] = clampDisplacement(attr.array[o + 1] + _delta.y);
			attr.array[o + 2] = clampDisplacement(attr.array[o + 2] + _delta.z);
			moved++;
		}
		if (moved) attr.needsUpdate = true;
		return moved;
	}

	/* ── on-canvas brush ring ──────────────────────────────────────────── */

	_ensureCursor() {
		if (this._cursor || typeof document === 'undefined') return;
		const ring = document.createElement('div');
		ring.className = 'ae-brush-ring';
		ring.setAttribute('aria-hidden', 'true');
		ring.style.cssText = [
			'position:fixed',
			'pointer-events:none',
			'z-index:40',
			'border:1.5px solid rgba(255,255,255,0.9)',
			'box-shadow:0 0 0 1px rgba(0,0,0,0.45)',
			'border-radius:50%',
			'transform:translate(-50%,-50%)',
			'opacity:0',
			'transition:opacity 0.12s',
		].join(';');
		document.body.appendChild(ring);
		this._cursor = ring;
	}

	_moveCursor(event) {
		if (!this._cursor) return;
		this._cursor.style.left = `${event.clientX}px`;
		this._cursor.style.top = `${event.clientY}px`;
		this._cursor.style.opacity = '1';
		this._syncCursorSize();
	}

	/**
	 * Size the ring to the brush's real footprint by projecting a point one
	 * radius to the camera's right of the orbit target. A fixed-pixel ring
	 * would lie about the brush every time the user zoomed.
	 */
	_syncCursorSize() {
		if (!this._cursor || !this.camera || !this.domElement) return;
		const target = this.controls?.target || _a.set(0, 1.4, 0);
		const dist = this.camera.position.distanceTo(target) || 1;
		const fov = ((this.camera.fov || 35) * Math.PI) / 180;
		const worldHeight = 2 * Math.tan(fov / 2) * dist;
		const px = (this.params.radius * 2 * this.domElement.clientHeight) / worldHeight;
		const size = Math.max(8, Math.min(400, px));
		this._cursor.style.width = `${size}px`;
		this._cursor.style.height = `${size}px`;
	}
}
