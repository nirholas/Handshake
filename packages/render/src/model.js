/**
 * The CPU side of a skinned avatar.
 * ---------------------------------
 * three.js does skinning on the GPU, so none of it happens for us. This module
 * evaluates animation clips with a real AnimationMixer, then blends the bone
 * matrices per vertex on the CPU and hands the rasterizer world-space
 * triangles. Normals ride the same blended matrix, so a walking avatar shades
 * correctly instead of shimmering the way recomputed face normals do.
 */

import './env-shim.js';
import * as THREE from 'three';
import { loadModel } from './load.js';
import { retargetClip } from './retarget.js';

const _matrix = new THREE.Matrix4();
const _bindInverse = new THREE.Matrix4();

function materialIndexOf(material) {
	const id = material?.userData?.__twsMaterial;
	return typeof id === 'number' ? id : -1;
}

function toLinear(c) {
	return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export class AvatarModel {
	constructor({ scene, animations, bindings, textures }) {
		this.scene = scene;
		this.clips = animations || [];
		this.bindings = bindings;
		this.textures = textures;
		this.mixer = new THREE.AnimationMixer(scene);
		this.action = null;
		this.time = 0;
		this._meshes = [];
		this._collect();
		this.scene.updateMatrixWorld(true);
		this.bounds = this._computeBounds();
	}

	static async load(source, options = {}) {
		const parts = await loadModel(source, options);
		return new AvatarModel(parts);
	}

	get clipNames() {
		return this.clips.map((c) => c.name);
	}

	/** Bone names, normalized the way the retargeter sees them. */
	get boneNames() {
		const names = [];
		for (const mesh of this._meshes) {
			if (!mesh.skeleton) continue;
			for (const bone of mesh.skeleton.bones) if (!names.includes(bone.name)) names.push(bone.name);
		}
		return names;
	}

	/**
	 * Bind external clips (from an animation-only GLB, or a serialized clip)
	 * onto this skeleton by bone name, so a Mixamo walk drives a Ready Player
	 * Me body.
	 *
	 * @param {THREE.AnimationClip[]} clips
	 * @param {{retarget?: boolean}} [options] Pass `retarget: false` for clips
	 *   already bound to this rig's own bone names, which is how a caller
	 *   plugs in a stronger retargeting engine of its own.
	 * @returns {number} how many clips were bound
	 */
	addClips(clips, { retarget = true } = {}) {
		const skeleton = this._meshes.find((m) => m.skeleton)?.skeleton;
		if (!skeleton) return 0;
		let added = 0;
		for (const clip of clips) {
			const bound = retarget ? retargetClip(clip, skeleton, this.scene) : clip;
			if (bound) {
				this.clips.push(bound);
				added++;
			}
		}
		return added;
	}

	/** Select a clip by name (case-insensitive substring) or index. */
	play(clip) {
		if (this.action) {
			this.action.stop();
			this.action = null;
		}
		if (clip === null || clip === undefined || this.clips.length === 0) return null;
		let found = null;
		if (typeof clip === 'number') found = this.clips[clip] || null;
		else {
			const needle = String(clip).toLowerCase();
			found =
				this.clips.find((c) => c.name.toLowerCase() === needle) ||
				this.clips.find((c) => c.name.toLowerCase().includes(needle)) ||
				null;
		}
		if (!found) return null;
		this.action = this.mixer.clipAction(found);
		this.action.reset();
		this.action.play();
		this.setTime(this.time);
		return found;
	}

	/** Absolute seek. The mixer only advances forward, so rewinds re-seek. */
	setTime(seconds) {
		if (!this.action) {
			this.time = seconds;
			this.scene.updateMatrixWorld(true);
			return;
		}
		const delta = seconds - this.time;
		this.time = seconds;
		if (delta >= 0) this.mixer.update(delta);
		else {
			this.mixer.setTime(0);
			this.mixer.update(Math.max(0, seconds));
		}
		this.scene.updateMatrixWorld(true);
	}

	get duration() {
		return this.action?.getClip()?.duration || 0;
	}

	_collect() {
		this.scene.updateMatrixWorld(true);
		this.scene.traverse((object) => {
			if (!object.isMesh || object.visible === false) return;
			const geometry = object.geometry;
			if (!geometry?.attributes?.position) return;
			const materials = Array.isArray(object.material) ? object.material : [object.material];
			const groups = geometry.groups?.length
				? geometry.groups
				: [{ start: 0, count: geometry.index ? geometry.index.count : geometry.attributes.position.count, materialIndex: 0 }];
			this._meshes.push({
				object,
				geometry,
				skeleton: object.isSkinnedMesh ? object.skeleton : null,
				groups: groups.map((g) => ({ ...g, material: this._material(materials[g.materialIndex || 0]) })),
				world: new Float32Array(geometry.attributes.position.count * 3),
				normals: new Float32Array(geometry.attributes.position.count * 3),
				boneMatrices: null,
			});
		});
	}

	_material(material) {
		const index = materialIndexOf(material);
		const binding = this.bindings?.get(index);
		const factor = binding?.baseColorFactor || [1, 1, 1, 1];
		const emissiveFactor = binding?.emissiveFactor || [0, 0, 0];
		const strength = binding?.emissiveStrength ?? 1;
		const mips = binding?.baseColor ? this.textures.get(binding.baseColor.image) : null;
		return {
			name: binding?.name || material?.name || 'material',
			baseColorFactor: [toLinear(factor[0]), toLinear(factor[1]), toLinear(factor[2]), factor[3] ?? 1],
			emissive: [
				toLinear(emissiveFactor[0]) * strength,
				toLinear(emissiveFactor[1]) * strength,
				toLinear(emissiveFactor[2]) * strength,
			],
			roughness: binding?.roughnessFactor ?? 0.8,
			metallic: binding?.metallicFactor ?? 0,
			alphaMode: binding?.alphaMode || 'OPAQUE',
			alphaCutoff: binding?.alphaCutoff ?? 0.5,
			doubleSided: binding?.doubleSided ?? false,
			mips: mips || null,
			wrapS: binding?.baseColor?.wrapS || 'repeat',
			wrapT: binding?.baseColor?.wrapT || 'repeat',
			hasVertexColor: false,
		};
	}

	/** Skin every mesh for the current pose into world-space buffers. */
	skin() {
		for (const entry of this._meshes) {
			const { object, geometry, skeleton } = entry;
			const position = geometry.attributes.position;
			const normal = geometry.attributes.normal;
			const count = position.count;
			const world = entry.world;
			const normals = entry.normals;

			if (!skeleton) {
				const m = object.matrixWorld.elements;
				for (let i = 0; i < count; i++) {
					const x = position.getX(i);
					const y = position.getY(i);
					const z = position.getZ(i);
					world[i * 3] = m[0] * x + m[4] * y + m[8] * z + m[12];
					world[i * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
					world[i * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
					if (normal) {
						const nx = normal.getX(i);
						const ny = normal.getY(i);
						const nz = normal.getZ(i);
						normals[i * 3] = m[0] * nx + m[4] * ny + m[8] * nz;
						normals[i * 3 + 1] = m[1] * nx + m[5] * ny + m[9] * nz;
						normals[i * 3 + 2] = m[2] * nx + m[6] * ny + m[10] * nz;
					}
				}
				continue;
			}

			const bones = skeleton.bones;
			const boneInverses = skeleton.boneInverses;
			if (!entry.boneMatrices || entry.boneMatrices.length !== bones.length * 16) {
				entry.boneMatrices = new Float32Array(bones.length * 16);
			}
			const bm = entry.boneMatrices;
			_bindInverse.copy(object.bindMatrixInverse);
			for (let b = 0; b < bones.length; b++) {
				// meshWorld * bindMatrixInverse * (boneWorld * boneInverse) * bindMatrix,
				// folded once per bone so the per-vertex loop is four weighted adds.
				_matrix.multiplyMatrices(bones[b].matrixWorld, boneInverses[b]);
				_matrix.premultiply(_bindInverse);
				_matrix.premultiply(object.matrixWorld);
				_matrix.multiply(object.bindMatrix);
				bm.set(_matrix.elements, b * 16);
			}

			const skinIndex = geometry.attributes.skinIndex;
			const skinWeight = geometry.attributes.skinWeight;
			for (let i = 0; i < count; i++) {
				const x = position.getX(i);
				const y = position.getY(i);
				const z = position.getZ(i);
				const nx = normal ? normal.getX(i) : 0;
				const ny = normal ? normal.getY(i) : 1;
				const nz = normal ? normal.getZ(i) : 0;

				let px = 0;
				let py = 0;
				let pz = 0;
				let vnx = 0;
				let vny = 0;
				let vnz = 0;
				let total = 0;
				for (let k = 0; k < 4; k++) {
					const weight = skinWeight.getComponent(i, k);
					if (weight === 0) continue;
					total += weight;
					const o = skinIndex.getComponent(i, k) * 16;
					px += weight * (bm[o] * x + bm[o + 4] * y + bm[o + 8] * z + bm[o + 12]);
					py += weight * (bm[o + 1] * x + bm[o + 5] * y + bm[o + 9] * z + bm[o + 13]);
					pz += weight * (bm[o + 2] * x + bm[o + 6] * y + bm[o + 10] * z + bm[o + 14]);
					vnx += weight * (bm[o] * nx + bm[o + 4] * ny + bm[o + 8] * nz);
					vny += weight * (bm[o + 1] * nx + bm[o + 5] * ny + bm[o + 9] * nz);
					vnz += weight * (bm[o + 2] * nx + bm[o + 6] * ny + bm[o + 10] * nz);
				}
				if (total > 0 && Math.abs(total - 1) > 1e-3) {
					const inv = 1 / total;
					px *= inv;
					py *= inv;
					pz *= inv;
					vnx *= inv;
					vny *= inv;
					vnz *= inv;
				}
				world[i * 3] = px;
				world[i * 3 + 1] = py;
				world[i * 3 + 2] = pz;
				normals[i * 3] = vnx;
				normals[i * 3 + 1] = vny;
				normals[i * 3 + 2] = vnz;
			}
		}
		return this._meshes;
	}

	get meshes() {
		return this._meshes;
	}

	_computeBounds() {
		this.skin();
		let minX = Infinity;
		let minY = Infinity;
		let minZ = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		let maxZ = -Infinity;
		for (const entry of this._meshes) {
			const world = entry.world;
			for (let i = 0; i < world.length; i += 3) {
				if (world[i] < minX) minX = world[i];
				if (world[i] > maxX) maxX = world[i];
				if (world[i + 1] < minY) minY = world[i + 1];
				if (world[i + 1] > maxY) maxY = world[i + 1];
				if (world[i + 2] < minZ) minZ = world[i + 2];
				if (world[i + 2] > maxZ) maxZ = world[i + 2];
			}
		}
		if (!Number.isFinite(minX)) return { min: [0, 0, 0], max: [1, 1, 1], center: [0, 0.5, 0], size: [1, 1, 1] };
		return {
			min: [minX, minY, minZ],
			max: [maxX, maxY, maxZ],
			center: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2],
			size: [maxX - minX, maxY - minY, maxZ - minZ],
		};
	}
}
